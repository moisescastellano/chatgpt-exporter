import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  filterSelectedProjects,
  normalizeSelectedProjectIds,
  conversationMatchesProjectSelection,
} from "../lib/project-selection.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const server = readFileSync(join(root, "server.js"), "utf8");
const runner = readFileSync(join(root, "lib", "export-runner.js"), "utf8");
const ui = readFileSync(join(root, "public", "index.html"), "utf8");

let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks++;
};

const projects = [
  { gizmoId: "g-p-a", name: "Alpha" },
  { gizmoId: "g-p-b", name: "Beta" },
  { gizmoId: "g-p-c", name: "Gamma" },
];

check(normalizeSelectedProjectIds(undefined) === null, "missing selection means all Projects");
check(normalizeSelectedProjectIds(null) === null, "null selection means all Projects");
check(normalizeSelectedProjectIds([]).size === 0, "empty array means no Projects selected");
check(filterSelectedProjects(projects, null).length === 3, "all Projects are kept by default");
check(filterSelectedProjects(projects, ["g-p-b"]).map((p) => p.gizmoId).join() === "g-p-b", "subset selection filters Projects by ID");
check(filterSelectedProjects(projects, []).length === 0, "clear-all selection exports no Projects");

const selected = new Set(["g-p-b"]);
check(conversationMatchesProjectSelection({ id: "root" }, selected), "non-Project conversations remain in scope");
check(conversationMatchesProjectSelection({ id: "b", projectId: "g-p-b" }, selected), "selected Project conversation remains in scope");
check(!conversationMatchesProjectSelection({ id: "a", projectId: "g-p-a" }, selected), "unselected Project conversation is excluded");
check(conversationMatchesProjectSelection({ id: "a", projectId: "g-p-a" }, null), "null selection keeps every Project conversation");

check(server.includes('req.url === "/list-projects"'), "server exposes lightweight Project inventory endpoint");
check(runner.includes("allProjects = await fetchProjectsInventory"), "export still fetches the full Project inventory");
check(runner.includes("filterSelectedProjects(allProjects, exportOptions?.selectedProjectIds)"), "Project metadata/resources use selected Projects");
check(runner.includes("conversationMatchesProjectSelection(conversation, selectedProjectIds)"), "conversation work queue respects Project selection");
check(runner.includes("projectConvIdMap"), "conversation inventory keeps stable Project IDs for filtering");
check(runner.includes("deletionReconciliationComplete ="), "deleted reconciliation remains present");

check(ui.includes('id="project-choose-btn"'), "UI exposes compact Choose button");
check(ui.includes('id="project-overlay"'), "UI provides Project selection modal");
check(ui.includes("Select all"), "Project picker supports Select all");
check(ui.includes("Clear all"), "Project picker supports Clear all");
check(ui.includes("selectedProjectIds: _selectedProjectIds"), "selected Project IDs are sent with export options");
check(ui.includes("let _selectedProjectIds = null;"), "fresh page defaults to all Projects");
check(!ui.includes("selectedProjectIds,\n      markdown:"), "Project selection is not persisted through Markdown preferences");

console.log(`project-selection.test.mjs: ${checks}/${checks} checks passed`);
