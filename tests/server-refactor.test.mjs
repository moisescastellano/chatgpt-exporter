import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const server = read("../server.js");
const runner = read("../lib/export-runner.js");
const api = read("../lib/chatgpt-api.js");
const files = read("../lib/export-files.js");
const html = read("../lib/html-renderer.js");
const index = read("../lib/export-index.js");

assert.ok(server.split(/\r?\n/).length < 450, "server.js should remain a thin entrypoint");
assert.match(server, /import \{ runExport \} from "\.\/lib\/export-runner\.js"/);
assert.match(server, /import \{ regenerateMarkdown \} from "\.\/lib\/markdown-regeneration\.js"/);
assert.doesNotMatch(server, /async function runExport\(/);
assert.match(runner, /export async function runExport\(/);
assert.match(api, /export class RateLimitStopError/);
assert.match(files, /export async function downloadSandboxFile/);
assert.match(html, /export function conversationToHtml/);
assert.match(index, /export function generateExportIndex/);
console.log("server-refactor.test.mjs: 8/8 checks passed");
