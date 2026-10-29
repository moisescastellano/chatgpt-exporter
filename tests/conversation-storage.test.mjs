import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  buildLocalConversationIndex,
  collectLocalConversations,
  moveConversationArtifacts,
} from "../lib/conversation-storage.js";

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

const root = await mkdtemp(join(tmpdir(), "cge-storage-"));
try {
  const writeConversation = (baseDir, fname, id, updateTime, title = fname) => {
    mkdirSync(join(baseDir, "json"), { recursive: true });
    writeFileSync(join(baseDir, "json", `${fname}.json`), JSON.stringify({
      conversation_id: id,
      title,
      update_time: updateTime,
    }), "utf8");
  };

  writeConversation(root, "active", "conv-active", 100);
  writeConversation(join(root, "archived"), "arch", "conv-arch", 200);
  writeConversation(join(root, "deleted"), "gone", "conv-gone", 300);
  writeConversation(join(root, "projects", "Project A"), "project", "conv-project", 400);

  ok("collects active, archived, deleted and Project conversations separately", () => {
    const records = collectLocalConversations(root);
    const states = Object.fromEntries(records.map((r) => [r.conversationId, r.state]));
    assert.equal(states["conv-active"], "active");
    assert.equal(states["conv-arch"], "archived");
    assert.equal(states["conv-gone"], "deleted");
    assert.equal(states["conv-project"], "project");
  });

  ok("records the Project folder for Project conversations", () => {
    const record = collectLocalConversations(root).find((r) => r.conversationId === "conv-project");
    assert.equal(record.projectName, "Project A");
  });

  writeConversation(join(root, "deleted"), "older-copy", "conv-active", 50, "old copy");
  ok("local index prefers the newest copy of a duplicated conversation", () => {
    const record = buildLocalConversationIndex(root).get("conv-active");
    assert.equal(record.state, "active");
    assert.equal(record.convo.title, "active");
  });

  const activeRecord = buildLocalConversationIndex(root).get("conv-active");
  mkdirSync(join(root, "markdown"), { recursive: true });
  mkdirSync(join(root, "html"), { recursive: true });
  mkdirSync(join(root, "files", activeRecord.fname), { recursive: true });
  writeFileSync(join(root, "markdown", `${activeRecord.fname}.md`), "md", "utf8");
  writeFileSync(join(root, "html", `${activeRecord.fname}.html`), "html", "utf8");
  writeFileSync(join(root, "files", activeRecord.fname, "a.txt"), "file", "utf8");

  ok("moves JSON, Markdown, HTML and files together", () => {
    const target = join(root, "archived");
    assert.equal(moveConversationArtifacts(activeRecord, target), true);
    assert.equal(existsSync(join(target, "json", `${activeRecord.fname}.json`)), true);
    assert.equal(existsSync(join(target, "markdown", `${activeRecord.fname}.md`)), true);
    assert.equal(existsSync(join(target, "html", `${activeRecord.fname}.html`)), true);
    assert.equal(readFileSync(join(target, "files", activeRecord.fname, "a.txt"), "utf8"), "file");
    assert.equal(existsSync(join(root, "json", `${activeRecord.fname}.json`)), false);
  });

  ok("can move an archived conversation to deleted without losing its filename", () => {
    const record = buildLocalConversationIndex(root).get("conv-active");
    assert.equal(record.state, "archived");
    moveConversationArtifacts(record, join(root, "deleted"));
    assert.equal(existsSync(join(root, "deleted", "json", `${record.fname}.json`)), true);
  });

  ok("a no-op move leaves an already correctly placed conversation untouched", () => {
    const record = buildLocalConversationIndex(root).get("conv-project");
    assert.equal(moveConversationArtifacts(record, record.baseDir, record.fname), false);
  });

  console.log(`\n${passed}/6 conversation-storage tests passed`);
} finally {
  await rm(root, { recursive: true, force: true });
}
