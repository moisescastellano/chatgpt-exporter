import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyResumeState, timestampMs } from "../lib/resume-state.js";

const target = "/export/json/2026-10-29_Title_12345678.json";

function existing({
  path = target,
  title = "Title",
  updatedMs = timestampMs("2026-10-29T10:00:00Z"),
} = {}) {
  return { path, updatedMs, convo: { title } };
}

function remote({ title = "Title", update_time = "2026-10-29T10:00:00Z" } = {}) {
  return { title, update_time };
}

test("no local conversation is a new download", () => {
  assert.deepEqual(classifyResumeState(null, remote(), target), {
    action: "download-new",
    isUpdate: false,
    pathChanged: false,
    reasons: [],
  });
});

test("same title, timestamp and path resumes without downloading", () => {
  assert.equal(classifyResumeState(existing(), remote(), target).action, "resume");
});

test("same content at a different storage path is moved, not downloaded", () => {
  const state = classifyResumeState(
    existing({ path: "/export/archived/json/old.json" }),
    remote(),
    target
  );
  assert.equal(state.action, "move");
  assert.equal(state.isUpdate, false);
  assert.equal(state.pathChanged, true);
});

test("newer remote update_time forces a fresh update download", () => {
  const state = classifyResumeState(existing(), remote({ update_time: "2026-10-29T10:00:01Z" }), target);
  assert.equal(state.action, "download-update");
  assert.deepEqual(state.reasons, ["remote-newer"]);
});

test("title changes force an update even with the same timestamp", () => {
  const state = classifyResumeState(existing(), remote({ title: "Renamed" }), target);
  assert.equal(state.action, "download-update");
  assert.ok(state.reasons.includes("title-changed"));
});

test("missing local update timestamp is treated conservatively as an update", () => {
  const state = classifyResumeState(existing({ updatedMs: 0 }), remote(), target);
  assert.equal(state.action, "download-update");
  assert.ok(state.reasons.includes("local-timestamp-missing"));
});

test("older remote timestamps never overwrite a newer local copy by themselves", () => {
  const state = classifyResumeState(
    existing({ updatedMs: timestampMs("2026-10-29T11:00:00Z") }),
    remote({ update_time: "2026-10-29T10:00:00Z" }),
    target
  );
  assert.equal(state.action, "resume");
});

test("timestamp parser accepts seconds, milliseconds and date strings", () => {
  assert.equal(timestampMs(1_700_000_000), 1_700_000_000_000);
  assert.equal(timestampMs(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(timestampMs("invalid"), 0);
  assert.equal(timestampMs(null), 0);
});
