import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

export function buildLocalFileMap(filesDir, fname) {
  const fileMap = {};
  const convFilesDir = join(filesDir, fname);
  const manifestPath = join(convFilesDir, ".file-map.json");

  if (!existsSync(manifestPath)) return fileMap;

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const files = manifest?.files;
    if (!files || typeof files !== "object" || Array.isArray(files)) return fileMap;

    for (const [fileId, actualName] of Object.entries(files)) {
      if (!fileId || typeof actualName !== "string") continue;
      if (basename(actualName) !== actualName) continue;
      if (!existsSync(join(convFilesDir, actualName))) continue;

      fileMap[fileId] = `../files/${fname}/${actualName}`;
    }
  } catch {
    // Missing/corrupt manifests simply mean that attachments are rendered
    // by name without a local link. Never guess file identity by filename.
  }

  return fileMap;
}

export function collectMarkdownRegenerationTargets(rootDir) {
  const targets = [];

  const addGroup = (baseDir) => {
    const jsonDir = join(baseDir, "json");
    if (!existsSync(jsonDir)) return;

    const mdDir = join(baseDir, "markdown");
    const filesDir = join(baseDir, "files");

    let names = [];
    try {
      names = readdirSync(jsonDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
        .map((entry) => entry.name)
        .sort();
    } catch {
      return;
    }

    for (const name of names) {
      const fname = name.slice(0, -5);
      targets.push({
        jsonPath: join(jsonDir, name),
        mdPath: join(mdDir, `${fname}.md`),
        mdDir,
        filesDir,
        fname,
      });
    }
  };

  addGroup(rootDir);
  addGroup(join(rootDir, "archived"));
  addGroup(join(rootDir, "deleted"));

  const projectsDir = join(rootDir, "projects");
  if (existsSync(projectsDir)) {
    try {
      for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
        if (entry.isDirectory()) addGroup(join(projectsDir, entry.name));
      }
    } catch {
      // Ignore an unreadable projects directory; root conversations can still regenerate.
    }
  }

  return targets;
}
