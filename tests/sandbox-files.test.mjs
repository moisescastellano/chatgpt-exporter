import assert from "node:assert/strict";
import { conversationToMarkdown } from "../lib/markdown.js";
import {
  extractSandboxReferences,
  rewriteSandboxLinks,
  sandboxFilename,
} from "../lib/sandbox-files.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

const PATH = "sandbox:/mnt/data/generated report.zip";

function conversationWithAssistantText(text, id = "assistant-1") {
  return {
    title: "Sandbox test",
    conversation_id: "conversation-1",
    current_node: id,
    mapping: {
      root: { id: "root", parent: null, children: [id], message: null },
      [id]: {
        id,
        parent: "root",
        children: [],
        message: {
          id,
          author: { role: "assistant" },
          content: { content_type: "text", parts: [text] },
          metadata: {},
        },
      },
    },
  };
}

test("extracts generated sandbox files from assistant Markdown links", () => {
  const convo = conversationWithAssistantText(`[Download report](${PATH})`);
  assert.deepEqual(extractSandboxReferences(convo), [{
    fileId: PATH,
    sandboxPath: PATH,
    filename: "generated report.zip",
    type: "sandbox",
    messageIds: ["assistant-1"],
  }]);
});

test("deduplicates the same sandbox path while retaining message ids", () => {
  const convo = {
    mapping: {
      a: {
        id: "a", parent: null, children: ["b"],
        message: {
          id: "a", author: { role: "assistant" },
          content: { parts: [`[First](${PATH})`] },
        },
      },
      b: {
        id: "b", parent: "a", children: [],
        message: {
          id: "b", author: { role: "assistant" },
          content: { parts: [`Again: [same file](${PATH})`] },
        },
      },
    },
  };
  const refs = extractSandboxReferences(convo);
  assert.equal(refs.length, 1);
  assert.deepEqual(refs[0].messageIds, ["a", "b"]);
});

test("ignores sandbox text written by the user", () => {
  const convo = conversationWithAssistantText("No files here");
  convo.mapping["assistant-1"].message.author.role = "user";
  convo.mapping["assistant-1"].message.content.parts = [`Example ${PATH}`];
  assert.deepEqual(extractSandboxReferences(convo), []);
});

test("uses the final sandbox path segment as filename", () => {
  assert.equal(sandboxFilename("sandbox:/workspace/output/report%20final.pdf"), "report final.pdf");
});

test("rewrites downloaded sandbox Markdown links to local files", () => {
  const rendered = rewriteSandboxLinks(
    `[Download report](${PATH})`,
    { [PATH]: "../files/Test/generated report.zip" }
  );
  assert.equal(rendered, "[Download report](../files/Test/generated%20report.zip)");
});

test("removes dead sandbox targets when the generated file is unavailable", () => {
  assert.equal(rewriteSandboxLinks(`[Download report](${PATH})`, {}), "Download report");
});

test("conversation Markdown uses the downloaded local generated file", () => {
  const convo = conversationWithAssistantText(`Here: [Download report](${PATH})`);
  const md = conversationToMarkdown(convo, {
    [PATH]: "../files/Sandbox test/generated report.zip",
  });
  assert.match(md, /\[Download report\]\(\.\.\/files\/Sandbox%20test\/generated%20report\.zip\)/);
  assert.doesNotMatch(md, /sandbox:\//);
});


test("handles generated filenames containing parentheses", () => {
  const path = "sandbox:/mnt/data/report(1).zip";
  const convo = conversationWithAssistantText(`[Download](${path})`);
  assert.equal(extractSandboxReferences(convo)[0].sandboxPath, path);
  assert.equal(
    rewriteSandboxLinks(`[Download](${path})`, { [path]: "../files/Test/report(1).zip" }),
    "[Download](../files/Test/report(1).zip)"
  );
});

test("removes image syntax as well as the dead sandbox target when unavailable", () => {
  assert.equal(rewriteSandboxLinks(`![Preview](${PATH})`, {}), "Preview");
});

console.log(`\n${passed}/9 sandbox-file tests passed.`);
