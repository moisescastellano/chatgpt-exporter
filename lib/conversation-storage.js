import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, join } from "node:path";

function timestampMs(value) {
  if (!value) return 0;
  if (typeof value === "number") return value > 1e10 ? value : value * 1000;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function statePriority(state) {
  if (state === "active" || state === "project") return 3;
  if (state === "archived") return 2;
  if (state === "deleted") return 1;
  return 0;
}

function addJsonDir(records, baseDir, state, projectName = null) {
  const jsonDir = join(baseDir, "json");
  if (!existsSync(jsonDir)) return;

  let entries = [];
  try {
    entries = readdirSync(jsonDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;

    const path = join(jsonDir, entry.name);
    try {
      const convo = JSON.parse(readFileSync(path, "utf8"));
      const conversationId = convo.conversation_id || convo.id;
      if (typeof conversationId !== "string" || !conversationId) continue;

      records.push({
        conversationId,
        path,
        name: entry.name,
        fname: basename(entry.name, ".json"),
        baseDir,
        state,
        projectName,
        convo,
        updatedMs: timestampMs(convo.update_time),
      });
    } catch {
      // Ignore corrupt/unreadable JSON. It is safer not to move a file whose
      // identity cannot be established from its own contents.
    }
  }
}

export function collectLocalConversations(rootDir) {
  const records = [];

  addJsonDir(records, rootDir, "active");
  addJsonDir(records, join(rootDir, "archived"), "archived");
  addJsonDir(records, join(rootDir, "deleted"), "deleted");

  const projectsDir = join(rootDir, "projects");
  if (existsSync(projectsDir)) {
    try {
      for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        addJsonDir(records, join(projectsDir, entry.name), "project", entry.name);
      }
    } catch {
      // Root/archived/deleted records are still useful if Projects is unreadable.
    }
  }

  return records;
}

export function buildLocalConversationIndex(rootDir) {
  const index = new Map();

  for (const record of collectLocalConversations(rootDir)) {
    const current = index.get(record.conversationId);
    if (
      !current ||
      record.updatedMs > current.updatedMs ||
      (record.updatedMs === current.updatedMs && statePriority(record.state) > statePriority(current.state))
    ) {
      index.set(record.conversationId, record);
    }
  }

  return index;
}

export function moveConversationArtifacts(record, targetBaseDir, targetFname = record.fname) {
  if (!record?.baseDir || !record?.fname || !targetBaseDir || !targetFname) {
    throw new Error("Invalid conversation move");
  }

  const sourceBaseDir = record.baseDir;
  const sourceFname = record.fname;

  if (sourceBaseDir === targetBaseDir && sourceFname === targetFname) return false;

  for (const [folder, ext] of [
    ["json", ".json"],
    ["markdown", ".md"],
    ["html", ".html"],
  ]) {
    const source = join(sourceBaseDir, folder, `${sourceFname}${ext}`);
    const targetDir = join(targetBaseDir, folder);
    const target = join(targetDir, `${targetFname}${ext}`);
    if (!existsSync(source)) continue;
    mkdirSync(targetDir, { recursive: true });
    rmSync(target, { force: true });
    renameSync(source, target);
  }

  const sourceFiles = join(sourceBaseDir, "files", sourceFname);
  const targetFilesDir = join(targetBaseDir, "files");
  const targetFiles = join(targetFilesDir, targetFname);
  if (existsSync(sourceFiles)) {
    mkdirSync(targetFilesDir, { recursive: true });
    rmSync(targetFiles, { recursive: true, force: true });
    renameSync(sourceFiles, targetFiles);
  }

  return true;
}
