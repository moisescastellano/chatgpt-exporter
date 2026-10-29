import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { conversationToMarkdown } from "../lib/markdown.js";

const options = {
  thoughtProcess: true,
  messageTimestamps: true,
  modelName: true,
  userLabel: "Prompt:",
  assistantLabel: "Response:",
};

function message(role, text, channel) {
  return {
    author: { role },
    content: { content_type: "text", parts: [text] },
    create_time: 1_700_000_000,
    metadata: { model_slug: "test-model" },
    ...(channel ? { channel } : {}),
  };
}

function thought(summary, hidden = false) {
  return {
    author: { role: "assistant" },
    content: { content_type: "thoughts", thoughts: [{ summary }] },
    metadata: { is_visually_hidden_from_conversation: hidden },
  };
}

function conversation(messages) {
  const mapping = { root: { parent: null, children: [], message: null } };
  let parent = "root";
  messages.forEach((msg, index) => {
    const id = `node-${index}`;
    mapping[id] = { parent, children: [], message: msg };
    mapping[parent].children.push(id);
    parent = id;
  });
  return { title: "Test conversation", mapping, current_node: parent };
}

function count(text, substring) {
  return text.split(substring).length - 1;
}

test("one response per turn, one quoted Worked block before the final answer", () => {
  const c = conversation([
    message("user", "Question"),
    message("assistant", "Progress one", "commentary"),
    thought("Ran 5 commands"),
    message("tool", "Tool details"),
    message("assistant", "Progress two", "commentary"),
    thought("Read files\nChecked results"),
    message("assistant", "Final answer", "final"),
  ]);
  const md = conversationToMarkdown(c, {}, options);
  assert.equal(count(md, "## Response:"), 1);
  assert.equal(count(md, "> **Worked**"), 1);
  assert.equal(count(md, "test-model"), 2); // Prompt + single response.
  assert.ok(md.includes("> Ran 5 commands\n>\n> Read files\n> Checked results"));
  assert.ok(md.indexOf("Progress one") < md.indexOf("Progress two"));
  assert.ok(md.indexOf("Progress two") < md.indexOf("> **Worked**"));
  assert.ok(md.indexOf("> **Worked**") < md.indexOf("Final answer"));
  assert.ok(!md.includes("## Thought Process"));
  assert.ok(!md.includes("Tool details"));
});

test("activity disabled still groups the response and keeps all public text", () => {
  const c = conversation([
    message("user", "Question"),
    message("assistant", "Progress", "commentary"),
    thought("Ran commands"),
    message("assistant", "Answer", "final"),
  ]);
  const md = conversationToMarkdown(c, {}, { ...options, thoughtProcess: false });
  assert.equal(count(md, "## Response:"), 1);
  assert.ok(md.includes("Progress") && md.includes("Answer"));
  assert.ok(!md.includes("Worked") && !md.includes("Ran commands"));
});

test("new user messages and unanswered prompts remain separate", () => {
  const c = conversation([
    message("user", "First question"),
    message("assistant", "First answer", "final"),
    message("user", "Unanswered question"),
    message("user", "Second question"),
    message("assistant", "Second answer", "final"),
  ]);
  const md = conversationToMarkdown(c, {}, options);
  assert.equal(count(md, "## Prompt:"), 3);
  assert.equal(count(md, "## Response:"), 2);
  assert.ok(md.indexOf("First answer") < md.indexOf("Unanswered question"));
});

test("hidden placeholders, empty summaries and duration recaps stay omitted", () => {
  const recap = {
    author: { role: "assistant" },
    content: { content_type: "reasoning_recap", content: "Ha pensado durante 2m" },
  };
  const c = conversation([
    message("user", "Question"), thought("Worked"), thought("Hidden", true),
    thought("  "), recap, message("assistant", "Answer", "final"),
  ]);
  const md = conversationToMarkdown(c, {}, options);
  assert.ok(!md.includes("Worked") && !md.includes("Hidden"));
  assert.ok(!md.includes("Ha pensado durante"));
  assert.equal(count(md, "## Response:"), 1);
});

test("directional markers are removed and title fallback remains supported", () => {
  const fallback = thought("");
  fallback.metadata.dil_v2_reasoning = { appData: { title: "Read files" } };
  const c = conversation([
    message("user", "Question"), thought("\u2068Ran\u2069 commands"), fallback,
    message("assistant", "Answer", "final"),
  ]);
  const md = conversationToMarkdown(c, {}, options);
  assert.ok(md.includes("> Ran commands\n>\n> Read files"));
  assert.ok(!/[\u2066-\u2069]/.test(md));
});

test("thought-only and commentary-only turns do not create empty blocks", () => {
  const onlyThought = conversationToMarkdown(conversation([thought("Read files")]), {}, options);
  assert.equal(count(onlyThought, "## Response:"), 1);
  assert.ok(onlyThought.includes("> **Worked**\n>\n> Read files"));
  const onlyCommentary = conversationToMarkdown(conversation([
    message("assistant", "Working", "commentary"), thought("Read files"),
  ]), {}, options);
  assert.ok(onlyCommentary.indexOf("Working") < onlyCommentary.indexOf("> **Worked**"));
});

test("legacy messages without channel put activity before the last text", () => {
  const c = conversation([
    message("user", "Question"), message("assistant", "Progress"),
    thought("Read files"), message("assistant", "Answer"),
  ]);
  const md = conversationToMarkdown(c, {}, options);
  assert.equal(count(md, "## Response:"), 1);
  assert.ok(md.indexOf("Progress") < md.indexOf("> **Worked**"));
  assert.ok(md.indexOf("> **Worked**") < md.indexOf("Answer"));
});

test("attachments, images, code and custom labels are preserved", () => {
  const user = message("user", "Inspect this");
  user.content.parts.unshift({
    content_type: "image_asset_pointer", asset_pointer: "sediment://image-id",
  });
  user.metadata.attachments = [{ id: "image-id", name: "image [1].png" }];
  const code = "```js\nconst value = 42;\n```\n\n[Link](https://example.org)";
  const c = conversation([user, message("assistant", code, "final")]);
  const md = conversationToMarkdown(c, { "image-id": "../files/a b.png" }, {
    ...options, userLabel: "Question", assistantLabel: "Answer",
    messageTimestamps: false, modelName: false,
  });
  assert.ok(md.includes("## Question\n") && md.includes("## Answer\n"));
  assert.ok(md.includes("[Attachment: image \\[1\\].png](../files/a%20b.png)"));
  assert.equal(count(md, "Attachment:"), 1);
  assert.ok(md.includes(code));
  assert.ok(!md.includes("test-model"));
});

test("all-branch exports do not combine sibling assistant alternatives", () => {
  const c = conversation([message("user", "Question")]);
  const parent = c.current_node;
  for (const [id, text] of [["left", "Left answer"], ["right", "Right answer"]]) {
    c.mapping[id] = { parent, children: [], message: message("assistant", text, "final") };
    c.mapping[parent].children.push(id);
  }
  c.current_node = "right";
  const all = conversationToMarkdown(c, {}, { ...options, branchMode: "all" });
  assert.equal(count(all, "## Response:"), 2);
  const current = conversationToMarkdown(c, {}, options);
  assert.equal(count(current, "## Response:"), 1);
  assert.ok(current.includes("Right answer") && !current.includes("Left answer"));
});

test("single-message conversations keep their content and add the exporter footer", () => {
  const c = conversation([message("user", "Question"), message("assistant", "Answer", "final")]);
  const md = conversationToMarkdown(c, {}, {
    userLabel: "Prompt:", assistantLabel: "Response:",
  });
  assert.equal(
    md,
    "# Test conversation\n\n## Prompt:\n\nQuestion\n\n## Response:\n\nAnswer\n\n---\n\n" +
      "*Generated by [ChatGPT Exporter](https://github.com/moisescastellano/chatgpt-exporter)*"
  );
});

// Optional real-world fixture; pass a downloaded conversation JSON as argv[2].
if (process.argv[2]) {
  test("real conversation groups every assistant fragment without losing message text", () => {
    const c = JSON.parse(readFileSync(process.argv[2], "utf8"));
    const md = conversationToMarkdown(c, {}, options);
    const off = conversationToMarkdown(c, {}, { ...options, thoughtProcess: false });
    assert.equal(count(md, "## Prompt:"), 44);
    assert.equal(count(md, "## Response:"), 42);
    assert.equal(count(md, "> **Worked**"), 33);
    assert.equal(count(off, "## Response:"), 42);
    assert.ok(!md.includes("## Thought Process"));
    assert.ok(!off.includes("> **Worked**"));
    for (const node of Object.values(c.mapping)) {
      const msg = node.message;
      if (!msg || !["user", "assistant"].includes(msg.author?.role)) continue;
      if (msg.content?.content_type !== "text") continue;
      for (const part of msg.content.parts || []) {
        if (typeof part !== "string") continue;
        const chunks = part
          .replace(/\ue200[^\ue201]*\ue201/g, "\u0000")
          .replace(/\u3010[^\u3011]*\u3011/g, "\u0000")
          .split("\u0000")
          .map((chunk) => chunk.trim())
          .filter(Boolean);

        let from = 0;
        for (const chunk of chunks) {
          const index = md.indexOf(chunk, from);
          assert.ok(index >= 0, `Lost message text: ${msg.id}`);
          from = index + chunk.length;
        }
      }
    }
  });
}
