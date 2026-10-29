import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const runner = readFileSync(new URL("../lib/export-runner.js", import.meta.url), "utf8");
const exportIndex = readFileSync(new URL("../lib/export-index.js", import.meta.url), "utf8");
const ui = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const localExport = readFileSync(new URL("../lib/local-export.js", import.meta.url), "utf8");

const checks = [
  ["requests active inventory explicitly", /is_archived:\s*String\(isArchived\)/.test(runner) && /fetchConversationInventory\(false\)/.test(runner)],
  ["requests archived inventory explicitly", /fetchConversationInventory\(true\)/.test(runner)],
  ["stores archived conversations under archived/", /\? \["archived"\]/.test(runner)],
  ["moves disappeared local conversations to deleted/", /targetBaseDir = join\(rootDir, "deleted"\)/.test(runner)],
  ["regenerates Markdown under archived and deleted", /addGroup\(join\(rootDir, "archived"\)\)/.test(localExport) && /addGroup\(join\(rootDir, "deleted"\)\)/.test(localExport)],
  ["root viewer exposes Archived and Deleted sections", /nav-section-hdr">Archived</.test(exportIndex) && /nav-section-hdr">Deleted</.test(exportIndex)],
  ["UI reports conversations moved to deleted", /movedToDeleted/.test(ui) && /moved to <code>deleted\/<\/code>/.test(ui)],
];

for (const [name, result] of checks) {
  assert.equal(result, true, name);
  console.log(`✓ ${name}`);
}
console.log(`\n${checks.length}/${checks.length} archive/delete layout tests passed`);
