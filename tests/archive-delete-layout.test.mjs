import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const ui = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const localExport = readFileSync(new URL("../lib/local-export.js", import.meta.url), "utf8");

const checks = [
  ["requests active inventory explicitly", /is_archived:\s*String\(isArchived\)/.test(server) && /fetchConversationInventory\(false\)/.test(server)],
  ["requests archived inventory explicitly", /fetchConversationInventory\(true\)/.test(server)],
  ["stores archived conversations under archived/", /\? \["archived"\]/.test(server)],
  ["moves disappeared local conversations to deleted/", /targetBaseDir = join\(rootDir, "deleted"\)/.test(server)],
  ["regenerates Markdown under archived and deleted", /addGroup\(join\(rootDir, "archived"\)\)/.test(localExport) && /addGroup\(join\(rootDir, "deleted"\)\)/.test(localExport)],
  ["root viewer exposes Archived and Deleted sections", /nav-section-hdr">Archived</.test(server) && /nav-section-hdr">Deleted</.test(server)],
  ["UI reports conversations moved to deleted", /movedToDeleted/.test(ui) && /moved to <code>deleted\/<\/code>/.test(ui)],
];

for (const [name, result] of checks) {
  assert.equal(result, true, name);
  console.log(`✓ ${name}`);
}
console.log(`\n${checks.length}/${checks.length} archive/delete layout tests passed`);
