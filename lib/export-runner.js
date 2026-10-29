import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { conversationToMarkdown } from "./markdown.js";
import { buildLocalFileMap } from "./local-export.js";
import { classifyResumeState } from "./resume-state.js";
import { filterSelectedProjects, normalizeSelectedProjectIds, conversationMatchesProjectSelection } from "./project-selection.js";
import { extractSandboxReferences } from "./sandbox-files.js";
import { buildLocalConversationIndex, moveConversationArtifacts } from "./conversation-storage.js";
import { Semaphore, deduplicateFilename, downloadFile, downloadSandboxFile, extractFileReferences, findConversationJsonById, removePreviousConversationFiles, safeDate, sanitizeFilename } from "./export-files.js";
import { conversationToHtml } from "./html-renderer.js";
import { buildZip } from "./zip.js";
import { projectToMarkdown, gptToMarkdown } from "./entity-markdown.js";
import { generateExportIndex } from "./export-index.js";
import { API_BASE_PUB, DELAY, HEADERS, PAGE_SIZE, RateLimitStopError, apiGet, debugFetch, fetchProjectsInventory, getRateLimitState, pacedChatGptFetch, resetRateLimiter, setRateLimitStopHandler, sleep } from "./chatgpt-api.js";

export async function runExport(token, outputDir, concurrency, createZip, keepAwake, exportOptions, sendEvent) {

  resetRateLimiter();

  // Prevent macOS sleep during export
  // Kill any orphaned caffeinate from a previous run before starting a new one
  if (global._caffeinate) { try { global._caffeinate.kill(); } catch {} global._caffeinate = null; }
  let caffeinate = null;
  if (keepAwake) {
    try {
      if (process.platform === "darwin") {
        caffeinate = spawn("caffeinate", ["-dims"], { stdio: "ignore" });
      } else if (process.platform === "win32") {
        // Prevent sleep via SetThreadExecutionState (ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED)
        caffeinate = spawn("powershell", ["-NoProfile", "-Command",
          "$t=Add-Type -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint s);' -Name KA -PassThru; while($true){$t::SetThreadExecutionState(0x80000003);Start-Sleep 59}"],
          { stdio: "ignore", windowsHide: true });
      } else if (process.platform === "linux") {
        caffeinate = spawn("systemd-inhibit", ["--what=sleep:idle", "--who=chatgpt-exporter", "--why=Export running", "sleep", "86400"], { stdio: "ignore" });
      }
      if (caffeinate) global._caffeinate = caffeinate;
    } catch { /* ignore — keep-awake is optional */ }
  }
  try {
    const CONCURRENCY = Math.max(1, Math.min(10, concurrency || 5));
    const fmts        = { json: true, markdown: true, html: true, ...(exportOptions?.formats || {}) };
    const markdownOptions = {
      messageTimestamps: false,
      modelName: false,
      userLabel: "User",
      assistantLabel: "Assistant",
      ...(exportOptions?.markdown || {}),
    };
    const doGpts      = exportOptions?.gpts          !== false;
    const doProjs     = exportOptions?.projects      !== false;
    const doConvs     = exportOptions?.conversations !== false;
    const selectedProjectIds = normalizeSelectedProjectIds(exportOptions?.selectedProjectIds);
    const dateFromMs  = exportOptions?.dateFrom ? Date.parse(exportOptions.dateFrom)                         : 0;
    const dateToMs    = exportOptions?.dateTo   ? Date.parse(exportOptions.dateTo + "T23:59:59.999Z") : Infinity;
    const rootDir     = outputDir.startsWith("~")
      ? join(homedir(), outputDir.slice(1))
      : outputDir;
    const zipPath     = rootDir + ".zip";

    // ── Logging setup ─────────────────────────────────────────────────
    mkdirSync(rootDir, { recursive: true });
    const logsDir = join(rootDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    const logTs   = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const logPath = join(logsDir, `export-${logTs}.log`);
    const log = (msg) => appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`, "utf8");

    log(`Export started — output: ${rootDir} — concurrency: ${CONCURRENCY}`);

    const _send = sendEvent;
    sendEvent = (type, data) => {
      _send(type, data);
      if      (type === "status")   log(`STATUS   ${data}`);
      else if (type === "progress") { const d = JSON.parse(data); log(`PROGRESS ${d.current}/${d.total} — ${d.title}`); }
      else if (type === "done")     { const d = JSON.parse(data); log(`DONE     ${d.succeeded} new · ${d.updated || 0} updated · ` +    `${d.skipped} resumed · ${d.failed} failed · output: ${d.output}`
  );
}
      else if (type === "rate_limited") {
        const d = JSON.parse(data);
        log(`RATE     ${d.message}${d.remaining !== undefined ? ` · ${d.remaining} remaining` : ""}`);
      }
      else if (type === "error_msg") log(`ERROR    ${data}`);
    };

    setRateLimitStopHandler((msg) => {
      log(`RATE     ${msg}`);

      try {
        _send("status", msg);
      } catch {
        // ignore UI notification failure
      }
    });

    const zipFiles = [];

    // ── Export GPTs ──────────────────────────────────────────────────
    let gptCount = 0;
    if (doGpts) {
      try {
        sendEvent("status", "Fetching your GPTs...");
        const gptsDir = join(rootDir, "gpts");
        mkdirSync(gptsDir, { recursive: true });
        let cursor = null;
        while (true) {
          const qs   = `limit=20${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`;
          const data = await pacedChatGptFetch(() => debugFetch(`${API_BASE_PUB}/gizmos/discovery/mine?${qs}`, {
            headers: { ...HEADERS, Authorization: `Bearer ${token}` },
          })).then(async (r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
          });
          const items = data.list?.items || data.items || data.gizmos || (Array.isArray(data) ? data : []);
          if (!items.length) break;
          for (const item of items) {
            const gizmo  = item.resource?.gizmo || item.gizmo || item;
            const id     = gizmo.id || "";
            const name   = gizmo.display?.name || gizmo.name || id;
            const safe   = sanitizeFilename(name);
            const fname  = `${safe}_${id.slice(0, 8)}`;
            const mdPath = join(gptsDir, `${fname}.md`);
            if (!existsSync(mdPath)) {
              const mdStr = gptToMarkdown(gizmo);
              writeFileSync(mdPath, mdStr, "utf8");
              zipFiles.push({ path: `gpts/${fname}.md`, data: mdStr });
            }
            gptCount++;
          }
          cursor = data.list?.cursor || data.cursor || data.next_cursor || null;
          if (!cursor) break;
          await sleep(DELAY);
        }
        sendEvent("status", `Exported ${gptCount} GPT(s).`);
        log(`GPT export done — ${gptCount} GPT(s)`);
      } catch (e) {
        if (e instanceof RateLimitStopError) throw e;
        log(`GPT export skipped: ${e.message}`);
      }
    }

    // ── Fetch projects ────────────────────────────────────────────────
    // Always inventory every Project when Projects are enabled. Selection only
    // limits what gets exported; the full inventory is still required to keep
    // archived/deleted reconciliation safe.
    let allProjects = [];
    let projectsInventoryComplete = !doProjs;
    if (doProjs) {
      projectsInventoryComplete = true;
      try {
        sendEvent("status", "Fetching projects...");
        allProjects = await fetchProjectsInventory(token, (project) => {
          sendEvent("status", `Found project: ${project.name}`);
        });
      } catch (e) {
        if (e instanceof RateLimitStopError) throw e;
        projectsInventoryComplete = false;
        log(`Projects fetch skipped: ${e.message}`);
      }
    }

    const selectedProjects = doProjs
      ? filterSelectedProjects(allProjects, exportOptions?.selectedProjectIds)
      : [];

    if (doProjs && selectedProjectIds !== null) {
      sendEvent("status", `Project selection: ${selectedProjects.length} of ${allProjects.length} selected.`);
      log(`PROJECT  selection: ${selectedProjects.length}/${allProjects.length}`);
    }

    // ── Map project conversation IDs → projectName ───────────────────
    // Done before the main conversation fetch so projectName is assigned
    // in a single pass (O(1) map lookup instead of O(n) find).
    const projectConvMap   = new Map(); // convId → projectName
    const projectConvIdMap = new Map(); // convId → project gizmo ID
    const projectConvExtra = [];        // convs only in project lists, not in main endpoint
    let projectConversationsInventoryComplete = !(doProjs && doConvs);
    if (doProjs && doConvs) projectConversationsInventoryComplete = projectsInventoryComplete;
    if (doProjs && doConvs && allProjects.length) {
      const seen = new Set();
      for (const proj of allProjects) {
        const projName = proj.name;
        sendEvent("status", `Fetching conversations for: ${projName}...`);
        let cur = null;
        while (true) {
          try {
            const qs   = `limit=50${cur ? "&cursor=" + encodeURIComponent(cur) : ""}`;
            const data = await apiGet(`gizmos/${proj.gizmoId}/conversations?${qs}`, token);
            const items = data.items || data.conversations || [];
            if (!items.length) break;
            for (const c of items) {
              projectConvMap.set(c.id, projName);
              projectConvIdMap.set(c.id, proj.gizmoId);
              if (!seen.has(c.id)) {
                seen.add(c.id);
                projectConvExtra.push({ ...c, projectName: projName, projectId: proj.gizmoId });
              }
            }
            cur = data.cursor || data.next_cursor || null;
            if (!cur) break;
            await sleep(DELAY);
          } catch (e) {
            if (e instanceof RateLimitStopError) throw e;
            projectConversationsInventoryComplete = false;
            log(`Project conversation inventory failed for "${projName}": ${e.message}`);
            break;
          }
        }
      }
    }

    // ── Export project metadata + resources ──────────────────────────
    if (doProjs) {
      try {
        for (let pi = 0; pi < selectedProjects.length; pi++) {
          const proj = selectedProjects[pi];
          const projName = proj.name;
          const projSafe = sanitizeFilename(projName);
          const projDir  = join(rootDir, "projects", projSafe);
          mkdirSync(projDir, { recursive: true });

          sendEvent("status", `Exporting project ${pi + 1}/${selectedProjects.length}: ${projName}`);

          const infoMd = projectToMarkdown(proj.gizmo);
          writeFileSync(join(projDir, "project-info.md"), infoMd, "utf8");
          zipFiles.push({ path: `projects/${projSafe}/project-info.md`, data: infoMd });

          try {
            const filesList = proj.files || [];
            if (filesList.length) {
              const resDir = join(projDir, "resources");
              mkdirSync(resDir, { recursive: true });
              for (let fi = 0; fi < filesList.length; fi++) {
                const f = filesList[fi];
                const rawId    = f.file_id || f.id || "";
                const fileId   = rawId.startsWith("file") ? rawId : `file-${rawId}`;
                const fileName = f.name || f.filename || rawId;
                sendEvent("status", `Project ${pi + 1}/${selectedProjects.length} "${projName}" — downloading file ${fi + 1}/${filesList.length}: ${fileName}`);
                try {
                  const { buffer, filename: dlName } = await downloadFile(fileId, token, fileName, null, proj.gizmoId);
                  const safe = sanitizeFilename(dlName || fileName);
                  writeFileSync(join(resDir, safe), buffer);
                  zipFiles.push({ path: `projects/${projSafe}/resources/${safe}`, data: buffer });
                  log(`PROJECT  "${projName}" resource: ${dlName || fileName}`);
                } catch (e) {
                  if (e instanceof RateLimitStopError) throw e;
                  log(`PROJECT  "${projName}" file failed: ${e.message}`);
                }
              }
            }
          } catch (e) {
            if (e instanceof RateLimitStopError) throw e;
            /* resources may not exist */
          }

          log(`PROJECT  "${projName}" exported`);
        }
        if (selectedProjects.length) sendEvent("status", `Exported ${selectedProjects.length} project(s).`);
      } catch (e) {
        if (e instanceof RateLimitStopError) throw e;
        log(`Projects export skipped: ${e.message}`);
      }
    }

    // ── Result accumulators ──────────────────────────────────────────
    let total             = 0;
    let newCount          = 0;
    let updatedCount      = 0;
    let skipped           = 0;
    const failed          = [];
    let totalFiles        = 0;
    let failedFiles       = 0;
    const failedFileDetails = [];
    let archivedCount       = 0;
    let movedToArchived      = 0;
    let restoredFromArchived = 0;
    let restoredFromDeleted  = 0;
    let movedToDeleted       = 0;
    let deletionReconciliationComplete = false;

    if (doConvs) {
      // ── Fetch active + archived conversation inventories ───────────
      const fetchConversationInventory = async (isArchived) => {
        const label = isArchived ? "archived conversations" : "active conversations";
        const conversations = [];
        let offset = 0;

        while (true) {
          const params = new URLSearchParams({
            offset: String(offset),
            limit: String(PAGE_SIZE),
            order: "updated",
            is_archived: String(isArchived),
          });

          const data = await apiGet(`conversations?${params.toString()}`, token);
          const items = data.items || data.conversations || [];
          const fetchTotal = Number.isFinite(Number(data.total)) ? Number(data.total) : null;

          if (!items.length) {
            if (fetchTotal !== null && offset < fetchTotal) {
              throw new Error(`Inventory for ${label} ended early at ${offset}/${fetchTotal}`);
            }
            break;
          }

          conversations.push(...items.map((c) => ({
            ...c,
            isArchived,
            projectName: projectConvMap.get(c.id) || null,
            projectId: projectConvIdMap.get(c.id) || null,
          })));

          sendEvent(
            "status",
            `Fetching ${label}... ${conversations.length}${fetchTotal !== null ? "/" + fetchTotal : ""}`
          );

          offset += items.length;
          if (fetchTotal !== null && offset >= fetchTotal) break;
          if (fetchTotal === null && items.length < PAGE_SIZE) break;
          await sleep(DELAY);
        }

        return conversations;
      };

      sendEvent("status", "Fetching active conversations...");
      const activeConversations = await fetchConversationInventory(false);
      sendEvent("status", "Fetching archived conversations...");
      const archivedConversations = await fetchConversationInventory(true);

      // Keep the two inventories distinct. They are combined only into a work
      // queue after every row has been tagged with its storage state.
      const inventoryById = new Map();
      for (const c of activeConversations) inventoryById.set(c.id, c);
      for (const c of archivedConversations) inventoryById.set(c.id, c);

      // Project-only rows can be absent from the main endpoint. Preserve their
      // project identity and any is_archived flag supplied by that endpoint.
      for (const c of projectConvExtra) {
        if (inventoryById.has(c.id)) continue;
        inventoryById.set(c.id, {
          ...c,
          isArchived: c.is_archived === true,
          projectName: c.projectName || projectConvMap.get(c.id) || null,
          projectId: c.projectId || projectConvIdMap.get(c.id) || null,
        });
      }

      archivedCount = [...inventoryById.values()].filter((c) => c.isArchived === true).length;
      const activeCount = inventoryById.size - archivedCount;
      sendEvent("status", `Inventory complete: ${activeCount} active · ${archivedCount} archived.`);

      // Reconcile local storage state only after both active/archived inventories
      // and all Project inventories completed successfully. No files are deleted:
      // disappeared conversations are moved to deleted/.
      deletionReconciliationComplete =
        doProjs &&
        projectsInventoryComplete &&
        projectConversationsInventoryComplete &&
        !getRateLimitState().stopped;

      if (deletionReconciliationComplete) {
        const localIndexBeforeExport = buildLocalConversationIndex(rootDir);

        for (const record of localIndexBeforeExport.values()) {
          const remote = inventoryById.get(record.conversationId);
          let targetBaseDir;
          let targetState;

          if (!remote) {
            targetBaseDir = join(rootDir, "deleted");
            targetState = "deleted";
          } else if (remote.isArchived === true) {
            targetBaseDir = join(rootDir, "archived");
            targetState = "archived";
          } else if (remote.projectName) {
            targetBaseDir = join(rootDir, "projects", sanitizeFilename(remote.projectName));
            targetState = "project";
          } else {
            targetBaseDir = rootDir;
            targetState = "active";
          }
          if (record.baseDir === targetBaseDir) continue;

          try {
            moveConversationArtifacts(record, targetBaseDir, record.fname);

            if (targetState === "deleted") movedToDeleted++;
            if (targetState === "archived" && record.state !== "archived") movedToArchived++;
            if (record.state === "archived" && targetState !== "archived") restoredFromArchived++;
            if (record.state === "deleted" && targetState !== "deleted") restoredFromDeleted++;

            log(`STATE    "${record.convo.title || record.fname}" ${record.state} → ${targetState}`);
          } catch (e) {
            log(`STATE    "${record.convo.title || record.fname}" move failed: ${e.message}`);
          }
        }

        if (movedToDeleted || movedToArchived || restoredFromArchived || restoredFromDeleted) {
          sendEvent(
            "status",
            `Storage reconciled: ${movedToArchived} archived · ${movedToDeleted} deleted · ` +
            `${restoredFromArchived + restoredFromDeleted} restored.`
          );
        }
      } else {
        log(
          "STATE    reconciliation skipped because the complete Projects inventory was not available"
        );
      }

      let allConversations = [...inventoryById.values()];

      // Optional Project selection limits only the work queue. Root conversations
      // remain in scope, while conversations known to belong to unselected Projects
      // are skipped. The full inventory above remains untouched for reconciliation.
      if (doProjs && selectedProjectIds !== null) {
        const before = allConversations.length;
        allConversations = allConversations.filter((conversation) =>
          conversationMatchesProjectSelection(conversation, selectedProjectIds)
        );
        log(`PROJECT  conversation selection: ${before} → ${allConversations.length}`);
        sendEvent("status", `Project selection: ${allConversations.length} conversations in export scope.`);
      }

      // ── Date filter ────────────────────────────────────────────────
      if (dateFromMs > 0 || dateToMs < Infinity) {
        const before = allConversations.length;
        allConversations = allConversations.filter((c) => {
          const ct = c.create_time;
          const ms = typeof ct === "number" ? (ct > 1e10 ? ct : ct * 1000) : Date.parse(ct || 0);
          return ms >= dateFromMs && ms <= dateToMs;
        });
        log(`Date filter [${exportOptions?.dateFrom || "*"} → ${exportOptions?.dateTo || "*"}]: ${before} → ${allConversations.length}`);
        sendEvent("status", `Date filter: ${allConversations.length} conversations in range.`);
      }

      total = allConversations.length;

      if (total > 0) {
        sendEvent("status", `Found ${total} conversations. Starting download...`);

        const jsonDir  = join(rootDir, "json");
        const mdDir    = join(rootDir, "markdown");
        const htmlDir  = join(rootDir, "html");
        const filesDir = join(rootDir, "files");
        mkdirSync(jsonDir,  { recursive: true });
        if (fmts.markdown) mkdirSync(mdDir,    { recursive: true });
        if (fmts.html)     mkdirSync(htmlDir,  { recursive: true });
        mkdirSync(filesDir, { recursive: true });

        // Pre-compute conversation list per group so HTML sidebar is correct
        // even when generating HTML inline during download.
        const convosByGroup = {};
        for (const item of allConversations) {
          const key = item.isArchived === true
            ? "archived"
            : item.projectName
              ? `projects/${sanitizeFilename(item.projectName)}`
              : "__root__";
          if (!convosByGroup[key]) convosByGroup[key] = [];
          const datePfxItem = safeDate(item.create_time) ? safeDate(item.create_time) + "_" : "";
          const s = sanitizeFilename(item.title || "Untitled");
          convosByGroup[key].push({ fname: `${datePfxItem}${s}_${item.id.slice(0, 8)}`, title: item.title || "Untitled" });
        }

        const localConversationIndex = buildLocalConversationIndex(rootDir);
        const startTime = Date.now();
        const sem = new Semaphore(CONCURRENCY);

        const tasks = allConversations.map((item) => async () => {
          await sem.acquire();
          try {

            if (getRateLimitState().stopped) return;

            const { id: cid, title: rawTitle, projectName } = item;
            const isArchived = item.isArchived === true;
            const title    = rawTitle || "Untitled";
            const safe     = sanitizeFilename(title);
            const d        = safeDate(item.create_time);
            const datePfx  = d ? d + "_" : "";
            const fname    = `${datePfx}${safe}_${cid.slice(0, 8)}`;
            const oldFname = `${safe}_${cid.slice(0, 8)}`; // pre-date format (backward compat)

            const baseDirParts = isArchived
              ? ["archived"]
              : projectName
                ? ["projects", sanitizeFilename(projectName)]
                : [];
            const convJsonDir  = baseDirParts.length ? join(rootDir, ...baseDirParts, "json")     : jsonDir;
            const convMdDir    = baseDirParts.length ? join(rootDir, ...baseDirParts, "markdown") : mdDir;
            const convHtmlDir  = baseDirParts.length ? join(rootDir, ...baseDirParts, "html")     : htmlDir;
            const convFilesDir = baseDirParts.length ? join(rootDir, ...baseDirParts, "files")    : filesDir;
            const zipPrefix    = baseDirParts.length ? baseDirParts.join("/") + "/" : "";

            const jsonPath    = join(convJsonDir, `${fname}.json`);
            const oldJsonPath = join(convJsonDir, `${oldFname}.json`);

            // Helper: regenerate HTML if missing (uses existing JSON, no API call)
            const ensureHtml = (convo, fName) => {
              if (!fmts.html) return;
              const htmlPath = join(convHtmlDir, `${fName}.html`);
              if (!existsSync(htmlPath)) {
                try {
                  const groupKey = baseDirParts.length ? baseDirParts.join("/") : "__root__";
                  const localFileMap = buildLocalFileMap(convFilesDir, fName);
                  mkdirSync(convHtmlDir, { recursive: true });
                  writeFileSync(htmlPath, conversationToHtml(convo, localFileMap, convosByGroup[groupKey] || [], fName), "utf8");
                } catch { /* non-fatal */ }
              }
            };

            // Smart resume: locate an existing local copy across active,
            // Project, archived and deleted storage. This lets state changes move
            // a conversation without re-downloading it when the content is unchanged.
            let existing = localConversationIndex.get(cid) || findConversationJsonById(convJsonDir, cid);

            const resumeState = classifyResumeState(existing, item, jsonPath);
            let isUpdate = resumeState.isUpdate;

            if (resumeState.action === "resume") {
              ensureHtml(existing.convo, fname);

              skipped++;

              const done =
                newCount + updatedCount + skipped + failed.length;

              if (skipped % 25 === 0 || done === total) {
                const elapsed =
                  (Date.now() - startTime) / 1000 / 60;

                const rate =
                  elapsed > 0 ? Math.round(done / elapsed) : 0;

                sendEvent("progress", JSON.stringify({
                  current: done,
                  total,
                  title,
                  stats:
                    `${newCount} new · ${updatedCount} updated · ` +
                    `${skipped} resumed · ${failed.length} failed · ${rate}/min`,
                }));
              }

              return;
            }

            // State/location changed but the conversation contents did not. Move the
            // complete local export atomically between active/Project/archived/deleted
            // layouts instead of re-downloading it.
            if (existing && !isUpdate && existing.path !== jsonPath) {
              try {
                const targetBaseDir = dirname(convJsonDir);
                moveConversationArtifacts(existing, targetBaseDir, fname);

                const localFileMap = buildLocalFileMap(convFilesDir, fname);
                if (fmts.markdown) {
                  mkdirSync(convMdDir, { recursive: true });
                  writeFileSync(
                    join(convMdDir, `${fname}.md`),
                    conversationToMarkdown(existing.convo, localFileMap, markdownOptions),
                    "utf8"
                  );
                }
                if (fmts.html) {
                  const groupKey = baseDirParts.length ? baseDirParts.join("/") : "__root__";
                  mkdirSync(convHtmlDir, { recursive: true });
                  writeFileSync(
                    join(convHtmlDir, `${fname}.html`),
                    conversationToHtml(existing.convo, localFileMap, convosByGroup[groupKey] || [], fname),
                    "utf8"
                  );
                }

                if (isArchived && existing.state !== "archived") movedToArchived++;
                if (!isArchived && existing.state === "archived") restoredFromArchived++;
                if (existing.state === "deleted") restoredFromDeleted++;

                log(`MOVE     "${title}" ${existing.state || "local"} → ${isArchived ? "archived" : projectName ? `project:${projectName}` : "active"}`);
                skipped++;
                const doneMove = newCount + updatedCount + skipped + failed.length;
                sendEvent("progress", JSON.stringify({
                  current: doneMove,
                  total,
                  title,
                  stats:
                    `${newCount} new · ${updatedCount} updated · ` +
                    `${skipped} resumed · ${failed.length} failed`,
                }));
                return;
              } catch (e) {
                log(`MOVE     "${title}" failed: ${e.message}; falling back to fresh download`);
                isUpdate = true;
              }
            }

            // Resume: old-format file exists — migrate to date-prefixed name, delete old files
            if (!isUpdate && existsSync(oldJsonPath)) {
              let migrated = false;
              try {
                const jsonStr = readFileSync(oldJsonPath, "utf8");
                const convo   = JSON.parse(jsonStr);
                mkdirSync(convJsonDir, { recursive: true });
                writeFileSync(jsonPath, jsonStr, "utf8");
                if (fmts.markdown) {
                  mkdirSync(convMdDir, { recursive: true });
                  writeFileSync(
                    join(convMdDir, `${fname}.md`),
                    conversationToMarkdown(convo, {}, markdownOptions),
                    "utf8"
                  );
                }
                ensureHtml(convo, fname);
                // Remove old-format files (json, md, html) to avoid duplicates
                try { unlinkSync(oldJsonPath); } catch {}
                try { unlinkSync(join(convMdDir,    `${oldFname}.md`));   } catch {}
                try { unlinkSync(join(convHtmlDir,  `${oldFname}.html`)); } catch {}
                  migrated = true;
              } catch (e) {
                log(`MIGRATE old-format "${title}" failed: ${e.message}`);
              }
              if (migrated) {
                skipped++;
                const done1 = newCount + updatedCount + skipped + failed.length;
                if (skipped % 25 === 0 || done1 === total) {
                  const el1 = (Date.now() - startTime) / 1000 / 60;
                  const r1  = el1 > 0 ? Math.round(done1 / el1) : 0;
                  sendEvent("progress", JSON.stringify({
                    current: done1, total, title,
                    stats: `${newCount} new · ${updatedCount} updated · ${skipped} resumed · ${failed.length} failed · ${r1}/min`,
                  }));
                }
                return;
              }

            }

            // Resume: conversation was saved in root but now belongs to a project — migrate
            if (!isUpdate && projectName) {
              const srcNew = join(jsonDir, `${fname}.json`);
              const srcOld = join(jsonDir, `${oldFname}.json`);
              const src    = existsSync(srcNew) ? srcNew : existsSync(srcOld) ? srcOld : null;
              if (src) {

                let migrated = false;

                try {
                  const jsonStr  = readFileSync(src, "utf8");
                  const convo    = JSON.parse(jsonStr);
                  const srcFname = src === srcNew ? fname : oldFname;
                  mkdirSync(convJsonDir, { recursive: true });
                  writeFileSync(jsonPath, jsonStr, "utf8");
                  if (fmts.markdown) {
                    mkdirSync(convMdDir, { recursive: true });
                    writeFileSync(
                      join(convMdDir, `${fname}.md`),
                      conversationToMarkdown(convo, {}, markdownOptions),
                      "utf8"
                    );
                  }
                  ensureHtml(convo, fname);
                  // Remove from root folder
                  try { unlinkSync(src); } catch {}
                  try { unlinkSync(join(mdDir,   `${srcFname}.md`));   } catch {}
                  try { unlinkSync(join(htmlDir, `${srcFname}.html`)); } catch {}
                  log(`MIGRATE  "${title}" root → projects/${sanitizeFilename(projectName)}/`);
                  migrated = true;
                } catch (e) {
                  log(`MIGRATE root→project "${title}" failed: ${e.message}`);
                }
                if (migrated) {
                  skipped++;
                  const done2 = newCount + updatedCount + skipped + failed.length;
                  if (skipped % 25 === 0 || done2 === total) {
                    const el2 = (Date.now() - startTime) / 1000 / 60;
                    const r2  = el2 > 0 ? Math.round(done2 / el2) : 0;
                    sendEvent("progress", JSON.stringify({
                      current: done2, total, title,
                      stats: `${newCount} new · ${updatedCount} updated · ${skipped} resumed · ${failed.length} failed · ${r2}/min`,
                    }));
                  }
                  return;
                }
              }
            }

            // If an existing copy was found but no local migration handled its
            // path change, fall back to a fresh download and count it as an update.
            if (existing && !isUpdate) {
              isUpdate = true;
            }
            const convo   = await apiGet(`conversation/${cid}`, token);
            const jsonStr = JSON.stringify(convo, null, 2);

            // Download attached files. Rebuild the conversation file directory
            // from scratch so stale files from older exports cannot survive.
            const fileRefs       = [...extractFileReferences(convo), ...extractSandboxReferences(convo)];
            const fileMap        = {};
            const fileManifest   = {};
            const failedManifest = {};
            const usedNames      = new Set();
            const convFilesDirFull = join(convFilesDir, fname);

            try {
              rmSync(convFilesDirFull, { recursive: true, force: true });
            } catch {}

            if (fileRefs.length) {
              mkdirSync(convFilesDirFull, { recursive: true });

              for (const ref of fileRefs) {
                totalFiles++;
                try {
                  const { filename: dlName, buffer } = ref.type === "sandbox"
                    ? await downloadSandboxFile(
                        ref,
                        token,
                        convo.conversation_id || cid,
                        typeof convo.gizmo_id === "string" && convo.gizmo_id.startsWith("g-p-")
                          ? convo.gizmo_id
                          : null
                      )
                    : await downloadFile(
                        ref.fileId,
                        token,
                        ref.filename,
                        null,
                        null,
                        convo.conversation_id || cid
                      );
                  const actualName = deduplicateFilename(
                    sanitizeFilename(dlName || ref.filename),
                    usedNames
                  );
                  writeFileSync(join(convFilesDirFull, actualName), buffer);
                  zipFiles.push({ path: `${zipPrefix}files/${fname}/${actualName}`, data: buffer });
                  fileMap[ref.fileId] = `../files/${fname}/${actualName}`;
                  fileManifest[ref.fileId] = actualName;
                  await sleep(DELAY);
                } catch (e) {
                  if (e instanceof RateLimitStopError) throw e;
                  failedFiles++;
                  failedManifest[ref.fileId] = {
                    filename: ref.filename,
                    error: e.message,
                  };
                  failedFileDetails.push(`${ref.filename} (${ref.fileId}): ${e.message}`);
                }
              }

              const manifestData = {
                version: 2,
                files: fileManifest,
              };
              if (Object.keys(failedManifest).length) {
                manifestData.failed = failedManifest;
              }
              const manifestStr = JSON.stringify(manifestData, null, 2);
              writeFileSync(join(convFilesDirFull, ".file-map.json"), manifestStr, "utf8");
              zipFiles.push({
                path: `${zipPrefix}files/${fname}/.file-map.json`,
                data: manifestStr,
              });
            }

            // Write JSON (always — resume key + raw data)
            mkdirSync(convJsonDir, { recursive: true });
            writeFileSync(jsonPath, jsonStr, "utf8");
            if (fmts.json) zipFiles.push({ path: `${zipPrefix}json/${fname}.json`, data: jsonStr });

            // Write Markdown
            if (fmts.markdown) {
              const mdStr = conversationToMarkdown(convo, fileMap, markdownOptions);
              mkdirSync(convMdDir, { recursive: true });
              writeFileSync(join(convMdDir, `${fname}.md`), mdStr, "utf8");
              zipFiles.push({ path: `${zipPrefix}markdown/${fname}.md`, data: mdStr });
            }

            // Write HTML
            if (fmts.html) {
              try {
                const groupKey = baseDirParts.length ? baseDirParts.join("/") : "__root__";
                mkdirSync(convHtmlDir, { recursive: true });
                const htmlStr = conversationToHtml(convo, fileMap, convosByGroup[groupKey] || [], fname);
                writeFileSync(join(convHtmlDir, `${fname}.html`), htmlStr, "utf8");
                zipFiles.push({ path: `${zipPrefix}html/${fname}.html`, data: htmlStr });
              } catch { /* non-fatal */ }
            }

            if (isUpdate && existing?.path !== jsonPath) {
              if (isArchived && existing.state !== "archived") movedToArchived++;
              if (!isArchived && existing.state === "archived") restoredFromArchived++;
              if (existing.state === "deleted") restoredFromDeleted++;
              removePreviousConversationFiles(existing, jsonPath);
            }

            if (isUpdate) {
              updatedCount++;
            } else {
              newCount++;
            }

            const done = newCount + updatedCount + skipped + failed.length;

            const elapsed = (Date.now() - startTime) / 1000 / 60;
            const rate    = elapsed > 0 ? Math.round(done / elapsed) : 0;
            sendEvent("progress", JSON.stringify({
              current: done, total, title,
              stats:
                `${newCount} new · ${updatedCount} updated · ` +
                `${skipped} resumed · ${failed.length} failed · ${rate}/min`,
            }));

            await sleep(DELAY); // rate-limit only after an actual API call

          } catch (e) {
            if (e instanceof RateLimitStopError) return;
            failed.push(item.title || "Untitled");
            console.error(`[error] "${item.title}": ${e.message}`);
            log(`FAILED   "${item.title}": ${e.message}`);
          } finally {
            sem.release(); // no sleep here — skipped items must not be delayed
          }
        });

        await Promise.all(tasks.map((t) => t()));
      } // end if (total > 0)
    } // end if (doConvs)

    // ── Build ZIP (optional) ─────────────────────────────────────────
    if (createZip) {
      sendEvent("status", "Creating ZIP archive...");
      const zipBuf = buildZip(zipFiles);
      writeFileSync(zipPath, zipBuf);
    }

    // ── Generate root index.html (always — acts as re-index on resume) ─
    if (fmts.html) {
      try {
        sendEvent("status", "Generating index.html...");
        generateExportIndex(rootDir, allProjects);
        log("INDEX    index.html written");
      } catch (e) { log(`INDEX    failed: ${e.message}`); }
    }

    const projectCount = doProjs ? selectedProjects.length : 0;

    const processed = newCount + updatedCount + skipped + failed.length;

    const remaining = Math.max(0, total - processed);

    sendEvent("done", JSON.stringify({
      total,
      processed,
      remaining,
      rateLimited: getRateLimitState().stopped,
      rateLimitRetryAfter: getRateLimitState().retryAfter,
      succeeded: newCount,
      updated: updatedCount,
      skipped,
      failed: failed.length,
      failedTitles: failed,
      output: rootDir,
      zip: createZip ? zipPath : null,
      totalFiles,
      failedFiles,
      failedFileDetails,
      projects: projectCount,
      gpts: gptCount,
      archived: archivedCount,
      movedToArchived,
      restoredFromArchived,
      restoredFromDeleted,
      movedToDeleted,
      deletionReconciliationComplete,
    }));

  } catch (e) {
    if (e instanceof RateLimitStopError) {
      sendEvent("rate_limited", JSON.stringify({
        message: e.message,
        retryAfter: e.retryAfter || getRateLimitState().retryAfter,
      }));
    } else {
      sendEvent("error_msg", `Export failed: ${e.message}`);
    }
  } finally {
    if (caffeinate) { try { caffeinate.kill(); } catch { /* ignore */ } global._caffeinate = null; }
    resetRateLimiter();
  }
}
