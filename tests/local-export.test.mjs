import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildLocalFileMap,
  collectMarkdownRegenerationTargets,
} from "../lib/local-export.js";

const root = await mkdtemp(join(tmpdir(), "cge-local-export-"));

try {
  test("file-map v2 restores exact attachment and sandbox identities only when files exist", () => {
    const fname = "conversation";
    const dir = join(root, "files", fname);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "attachment.txt"), "a");
    writeFileSync(join(dir, "generated report.zip"), "z");
    writeFileSync(join(dir, ".file-map.json"), JSON.stringify({
      version: 2,
      files: {
        "file-123": "attachment.txt",
        "sandbox:/mnt/data/generated report.zip": "generated report.zip",
        "file-missing": "missing.txt",
        "file-traversal": "../outside.txt",
      },
      failed: {
        "file-failed": { filename: "failed.pdf", error: "HTTP 404" },
      },
    }), "utf8");

    assert.deepEqual(buildLocalFileMap(join(root, "files"), fname), {
      "file-123": "../files/conversation/attachment.txt",
      "sandbox:/mnt/data/generated report.zip": "../files/conversation/generated report.zip",
    });
  });

  test("missing or corrupt manifests safely produce an empty file map", () => {
    assert.deepEqual(buildLocalFileMap(join(root, "files"), "missing"), {});
    const badDir = join(root, "files", "bad");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, ".file-map.json"), "{not-json", "utf8");
    assert.deepEqual(buildLocalFileMap(join(root, "files"), "bad"), {});
  });

  test("Markdown regeneration scans active, archived, deleted and Project JSON groups", () => {
    const writeJson = (base, name) => {
      mkdirSync(join(base, "json"), { recursive: true });
      writeFileSync(join(base, "json", `${name}.json`), "{}", "utf8");
      writeFileSync(join(base, "json", `${name}.txt`), "ignore", "utf8");
    };

    writeJson(root, "active-one");
    writeJson(join(root, "archived"), "archived-one");
    writeJson(join(root, "deleted"), "deleted-one");
    writeJson(join(root, "projects", "Project A"), "project-one");

    const targets = collectMarkdownRegenerationTargets(root);
    const names = targets.map((t) => t.fname).sort();
    assert.deepEqual(names, ["active-one", "archived-one", "deleted-one", "project-one"]);

    for (const target of targets) {
      assert.ok(target.mdPath.endsWith(`${target.fname}.md`));
      assert.ok(target.filesDir.endsWith("files"));
    }
  });
} finally {
  await rm(root, { recursive: true, force: true });
}
