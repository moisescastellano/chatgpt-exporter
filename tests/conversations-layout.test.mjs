import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const runner = readFileSync(new URL("../lib/export-runner.js", import.meta.url), "utf8");
const storage = readFileSync(new URL("../lib/conversation-storage.js", import.meta.url), "utf8");
const localExport = readFileSync(new URL("../lib/local-export.js", import.meta.url), "utf8");
const exportIndex = readFileSync(new URL("../lib/export-index.js", import.meta.url), "utf8");

const checks = [
  ["active export directories live under conversations/", /const conversationsDir = join\(rootDir, "conversations"\)/.test(runner)],
  ["active conversation base path is conversations/", /: \["conversations"\];/.test(runner)],
  ["active reconciliation target is conversations/", /targetBaseDir = join\(rootDir, "conversations"\)/.test(runner)],
  ["local conversation index scans conversations/", /addJsonDir\(records, join\(rootDir, "conversations"\), "active"\)/.test(storage)],
  ["Markdown regeneration scans conversations/", /addGroup\(join\(rootDir, "conversations"\)\)/.test(localExport)],
  ["viewer reads conversations/html", /join\(rootDir, "conversations", "html"\)/.test(exportIndex)],
  ["viewer links standalone chats through conversations/html", /href="conversations\/html\//.test(exportIndex)],
  ["old root-level active json directory is not scanned", !/addJsonDir\(records, rootDir, "active"\)/.test(storage)],
  ["old root-level Markdown group is not scanned", !/\n\s*addGroup\(rootDir\);/.test(localExport)],
];

for (const [name, result] of checks) {
  assert.equal(result, true, name);
  console.log(`✓ ${name}`);
}
console.log(`\n${checks.length}/${checks.length} conversations layout tests passed`);
