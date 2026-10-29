import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const server = readFileSync(join(root, "server.js"), "utf8");
const ui = readFileSync(join(root, "public", "index.html"), "utf8");

let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks++;
};

check(server.includes("let rateLimitRetryAfter = null;"), "server stores Retry-After from the first 429");
check(server.includes("rateLimitRetryAfter = retryAfter || null;"), "server captures Retry-After header");
check(server.includes('sendEvent("rate_limited", JSON.stringify({'), "early 429 is emitted as a dedicated event");
check(server.includes("rateLimitRetryAfter,"), "normal completion payload includes Retry-After information");
check(server.includes("`${d.processed}/${d.total} conversations processed · ${d.remaining} remaining`"), "terminal output reports partial progress on 429");

check(ui.includes(".result.warning"), "UI defines a warning state distinct from success/error");
check(ui.includes("evtSource.addEventListener('rate_limited'"), "UI handles early rate-limit events");
check(ui.includes("if (d.rateLimited)"), "UI handles rate limits that occur during conversation processing");
check(ui.includes("d.processed ??"), "UI reports processed conversation count");
check(ui.includes("d.remaining ??"), "UI reports remaining conversation count");
check(ui.includes("No saved progress was lost."), "UI explains that saved progress is preserved");
check(ui.includes("Smart Resume will continue"), "UI explains how to resume later");
check(ui.includes("showResult(resultType, msg)"), "completion result can render as a warning rather than success");

console.log(`rate-limit-ux.test.mjs: ${checks}/${checks} checks passed`);
