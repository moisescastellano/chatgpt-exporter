import { existsSync, readFileSync, readdirSync, unlinkSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { timestampMs } from "./resume-state.js";
import { API_BASE, HEADERS, MIME_TO_EXT, RateLimitStopError, apiDebug, apiFetchBinary, apiGet, debugFetch, pacedChatGptFetch } from "./chatgpt-api.js";

// ── Semaphore ────────────────────────────────────────────────────────

export class Semaphore {
  constructor(n) { this.n = n; this.queue = []; }
  acquire() {
    if (this.n > 0) { this.n--; return Promise.resolve(); }
    return new Promise((r) => this.queue.push(r));
  }
  release() {
    if (this.queue.length > 0) { this.queue.shift()(); } else { this.n++; }
  }
}

// ── File utilities ───────────────────────────────────────────────────

export function safeDate(ct) {
  if (!ct) return "";
  try {
    const d = typeof ct === "number" ? new Date(ct > 1e10 ? ct : ct * 1000) : new Date(ct);
    if (isNaN(d)) return "";
    return d.toISOString().slice(0, 10);
  } catch { return ""; }
}

export function sanitizeFilename(name, maxLen = 80) {
  let safe = name
    // Normalize line breaks and tabs as normal whitespace.
    .replace(/[\r\n\t]+/g, " ")
    // Remove the remaining ASCII control characters.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    // Replace characters forbidden in Windows filenames.
    .replace(/[<>:"/\\|?*]/g, "_")
    // Collapse repeated whitespace.
    .replace(/\s+/g, " ")
    // Windows forbids leading/trailing dots and spaces.
    .replace(/^[. ]+|[. ]+$/g, "")
    .slice(0, maxLen)
    // Truncation itself may leave a trailing dot or space.
    .replace(/[. ]+$/g, "");

  // Reserved Windows device names are invalid even with an extension.
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(safe)) {
    safe = `_${safe}`;
  }

  return safe || "untitled";
}

export function findConversationJsonById(dir, conversationId) {
  if (!existsSync(dir)) return null;

  const suffix = `_${conversationId.slice(0, 8)}.json`;

  const matches = readdirSync(dir)
    .filter((name) => name.endsWith(suffix));

  if (!matches.length) return null;

  let best = null;

  for (const name of matches) {
    const path = join(dir, name);

    try {
      const convo = JSON.parse(readFileSync(path, "utf8"));
      const updatedMs = timestampMs(convo.update_time);

      if (!best || updatedMs > best.updatedMs) {
        best = {
          path,
          name,
          convo,
          updatedMs,
        };
      }
    } catch {
      // Ignore unreadable/corrupt candidates and keep looking.
    }
  }

  return best;
}

export function stripCitations(str) {
  return str.replace(/\u3010[^\u3011]*\u3011/g, "");
}

export function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function deduplicateFilename(name, usedNames) {
  if (!usedNames.has(name)) { usedNames.add(name); return name; }
  const dot  = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext  = dot > 0 ? name.slice(dot)    : "";
  let i = 1;
  while (usedNames.has(`${base}_${i}${ext}`)) i++;
  const deduped = `${base}_${i}${ext}`;
  usedNames.add(deduped);
  return deduped;
}

export function removePreviousConversationFiles(existing, newJsonPath) {
  if (!existing || existing.path === newJsonPath) return;

  const oldJsonPath = existing.path;
  const oldJsonDir  = dirname(oldJsonPath);
  const oldBaseDir  = dirname(oldJsonDir);
  const oldFname    = basename(oldJsonPath, ".json");

  try { unlinkSync(oldJsonPath); } catch {}
  try { unlinkSync(join(oldBaseDir, "markdown", `${oldFname}.md`)); } catch {}
  try { unlinkSync(join(oldBaseDir, "html", `${oldFname}.html`)); } catch {}

  try {
    rmSync(join(oldBaseDir, "files", oldFname), {
      recursive: true,
      force: true,
    });
  } catch {}
}

// ── File reference extraction ────────────────────────────────────────

export function extractFileReferences(convo) {
  const refs = [];
  const seen = new Set();
  const mapping = convo.mapping || {};

  for (const node of Object.values(mapping)) {
    const msg = node.message;
    if (!msg) continue;

    // The Markdown renderer only exposes user/assistant conversation content.
    // Do not download files attached only to internal tool/system messages.
    const role = msg.author?.role || "";
    if (role !== "user" && role !== "assistant") continue;

    // Prefer attachment metadata over image_asset_pointer because it normally
    // contains the original filename. Skip hidden connector extraction artifacts.
    if (msg.metadata?.attachments) {
      for (const att of msg.metadata.attachments) {
        if (!att.id || seen.has(att.id)) continue;
        if (att.source === "connector" && att.display_files_from_actions_ext === false) continue;

        seen.add(att.id);
        refs.push({
          fileId: att.id,
          filename: att.name || "attachment",
          type: "attachment",
        });
      }
    }

    if (msg.content?.parts) {
      for (const part of msg.content.parts) {
        if (part?.content_type === "image_asset_pointer" && part.asset_pointer) {
          const match = part.asset_pointer.match(/^(?:file-service|sediment):\/\/(.+)$/);
          if (match && !seen.has(match[1])) {
            seen.add(match[1]);
            refs.push({
              fileId: match[1],
              filename: part.metadata?.dalle?.prompt ? "dalle_image.png" : "image.png",
              type: "image",
            });
          }
        }
      }
    }

    if (msg.metadata?.citations) {
      for (const cit of msg.metadata.citations) {
        const fileId = cit.metadata?.file_id || cit.file_id;
        const title  = cit.metadata?.title    || cit.title   || "citation";
        if (fileId && !seen.has(fileId)) {
          seen.add(fileId);
          refs.push({ fileId, filename: title, type: "citation" });
        }
      }
    }
  }

  return refs;
}

export async function downloadFile(fileId, token, fallbackName, debugLog, gizmoId, conversationId) {
  // For project files: use download endpoint with gizmo_id query parameter
  if (gizmoId) {
    try {
      const meta = await apiGet(`files/${fileId}/download?gizmo_id=${encodeURIComponent(gizmoId)}`, token);
      const dlUrl = meta.download_url || meta.url || meta.file_url || meta.presigned_url || meta.signed_url;
      if (dlUrl) {
        const { buffer, contentType } = await apiFetchBinary(dlUrl, token);
        let filename = meta.file_name || meta.name || fallbackName || fileId;
        if (!filename.includes(".") && contentType) {
          const mime = contentType.split(";")[0].trim();
          const ext = MIME_TO_EXT[mime];
          if (ext) filename += ext;
        }
        return { filename, buffer };
      }
    } catch (e) {
      if (e instanceof RateLimitStopError) throw e;
      if (debugLog) debugLog(`files/${fileId}/download?gizmo_id failed: ${e.message}`);
    }
  }

  // Conversation uploads/images are resolved through the conversation-aware
  // download endpoint. The generic endpoint is kept below as a fallback.
  if (conversationId) {
    const path =
      `files/download/${encodeURIComponent(fileId)}` +
      `?conversation_id=${encodeURIComponent(conversationId)}&inline=false`;

    try {
      const meta = await apiGet(path, token);
      if (debugLog) debugLog(`${path}: ${JSON.stringify(meta)}`);

      const url =
        meta.download_url ||
        meta.url ||
        meta.file_url ||
        meta.presigned_url ||
        meta.signed_url;

      if (url) {
        const { buffer, contentType } = await apiFetchBinary(url, token);
        let filename = meta.file_name || meta.name || fallbackName || fileId;
        if (!filename.includes(".") && contentType) {
          const mime = contentType.split(";")[0].trim();
          const ext = MIME_TO_EXT[mime];
          if (ext) filename += ext;
        }
        return { filename, buffer };
      }
    } catch (e) {
      if (e instanceof RateLimitStopError) throw e;
      if (debugLog) debugLog(`${path} failed: ${e.message}`);
    }
  }

  let meta = await apiGet(`files/download/${encodeURIComponent(fileId)}`, token);
  if (debugLog) debugLog(`files/download/${fileId}: ${JSON.stringify(meta)}`);
  let url = meta.download_url || meta.url || meta.file_url || meta.presigned_url || meta.signed_url;

  if (!url) {
    try {
      const meta2 = await apiGet(`files/${encodeURIComponent(fileId)}`, token);
      if (debugLog) debugLog(`files/${fileId}: ${JSON.stringify(meta2)}`);
      url = meta2.download_url || meta2.url || meta2.file_url || meta2.presigned_url || meta2.signed_url;
      if (url) meta = meta2;
    } catch (e) {
      if (e instanceof RateLimitStopError) throw e;
      /* ignore fallback failure */
    }
  }

  if (!url) throw new Error(`No download_url (keys: ${Object.keys(meta).join(",")})`);
  const { buffer, contentType } = await apiFetchBinary(url, token);
  let filename = meta.file_name || meta.name || fallbackName || fileId;
  if (!filename.includes(".") && contentType) {
    const mime = contentType.split(";")[0].trim();
    const ext  = MIME_TO_EXT[mime];
    if (ext) filename += ext;
  }
  return { filename, buffer };
}

export async function downloadSandboxFile(ref, token, conversationId, projectId = null) {
  if (!conversationId) throw new Error("Missing conversation id for sandbox file");
  if (!ref?.sandboxPath) throw new Error("Missing sandbox path");

  const messageIds = Array.isArray(ref.messageIds)
    ? [...ref.messageIds].reverse()
    : [];

  if (!messageIds.length) throw new Error("Missing message id for sandbox file");

  let lastError = null;

  for (const messageId of messageIds) {
    const params = new URLSearchParams({
      message_id: messageId,
      sandbox_path: ref.sandboxPath.replace(/^sandbox:/i, ""),
      download_intent: "true",
    });

    const url =
      `${API_BASE}/conversation/${encodeURIComponent(conversationId)}` +
      `/interpreter/download?${params.toString()}`;

    const headers = {
      ...HEADERS,
      Authorization: `Bearer ${token}`,
    };

    if (projectId) {
      headers["chatgpt-project-id"] = projectId;
    }

    try {
      const resp = await pacedChatGptFetch(() => debugFetch(url, { headers }));

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status}: ${body.slice(0, 300)}`);
      }

      const meta = await resp.json();
      const downloadUrl =
        meta.download_url ||
        meta.url ||
        meta.file_url ||
        meta.presigned_url ||
        meta.signed_url;

      if (!downloadUrl) {
        throw new Error(
          `No download_url (keys: ${Object.keys(meta).join(",")})`
        );
      }

      const { buffer, contentType } = await apiFetchBinary(downloadUrl, token);
      let filename =
        meta.file_name ||
        meta.name ||
        ref.filename ||
        "generated_file";

      if (!filename.includes(".") && contentType) {
        const mime = contentType.split(";")[0].trim();
        const ext = MIME_TO_EXT[mime];
        if (ext) filename += ext;
      }

      return { filename, buffer };
    } catch (e) {
      if (e instanceof RateLimitStopError) throw e;

      lastError = e;
      apiDebug(`Sandbox download failed for message ${messageId}`, e.message);
    }
  }

  throw lastError || new Error("Sandbox file download failed");
}

