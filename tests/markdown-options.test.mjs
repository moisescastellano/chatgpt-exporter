import assert from "node:assert/strict";
import { test } from "node:test";

import { conversationToMarkdown } from "../lib/markdown.js";

function textMessage(role, text, { time, model, channel } = {}) {
  return {
    author: { role },
    content: { content_type: "text", parts: [text] },
    ...(time !== undefined ? { create_time: time } : {}),
    metadata: model ? { model_slug: model } : {},
    ...(channel ? { channel } : {}),
  };
}

function baseConversation() {
  return {
    id: "conv-options",
    conversation_id: "conv-options",
    title: "Options test",
    create_time: 1767323045,
    update_time: 1770091506,
    mapping: {
      root: { parent: null, children: ["user"], message: null },
      user: {
        parent: "root",
        children: ["left", "right"],
        message: textMessage("user", "Question", { time: "2026-03-04T05:06:07Z" }),
      },
      left: {
        parent: "user",
        children: [],
        message: textMessage("assistant", "Left answer", {
          time: "2026-03-04T05:07:08Z",
          model: "left-model",
          channel: "final",
        }),
      },
      right: {
        parent: "user",
        children: [],
        message: textMessage("assistant", "Right answer", {
          time: "2026-03-04T05:08:09Z",
          model: "right-model",
          channel: "final",
        }),
      },
    },
    current_node: "right",
  };
}

function metadataValue(md, key) {
  const m = md.match(new RegExp(`\\*\\*${key}:\\*\\* ([^\\n]+)`));
  return m?.[1]?.replace(/\s+$/, "") || "";
}

function splitDateTime(value) {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2}:\d{2})$/);
  assert.ok(m, `Expected ISO timestamp, got: ${value}`);
  return { year: m[1], month: m[2], day: m[3], time: m[4] };
}

test("current branch is the default and keeps only current_node ancestry", () => {
  const md = conversationToMarkdown(baseConversation());
  assert.ok(md.includes("Right answer"));
  assert.ok(!md.includes("Left answer"));
});

test("all branches includes sibling alternatives separately", () => {
  const md = conversationToMarkdown(baseConversation(), {}, { branchMode: "all" });
  assert.ok(md.includes("Left answer"));
  assert.ok(md.includes("Right answer"));
  assert.equal(md.split("## Assistant").length - 1, 2);
});

test("missing or invalid current_node safely falls back to all branches", () => {
  const convo = baseConversation();
  convo.current_node = "missing-node";
  const md = conversationToMarkdown(convo);
  assert.ok(md.includes("Left answer") && md.includes("Right answer"));
});

test("conversation metadata is opt-in and emits created, updated, exported and link", () => {
  const off = conversationToMarkdown(baseConversation());
  assert.ok(!off.includes("**Created:**"));
  assert.ok(!off.includes("**Updated:**"));
  assert.ok(!off.includes("**Exported:**"));
  assert.ok(!off.includes("**Link:**"));

  const on = conversationToMarkdown(baseConversation(), {}, { conversationMetadata: true });
  assert.ok(metadataValue(on, "Created"));
  assert.ok(metadataValue(on, "Updated"));
  assert.ok(metadataValue(on, "Exported"));
  assert.ok(on.includes("https://chatgpt.com/c/conv-options"));
});

test("European metadata date format is the ISO local date rearranged", () => {
  const iso = conversationToMarkdown(baseConversation(), {}, {
    conversationMetadata: true,
    dateFormat: "iso",
  });
  const euro = conversationToMarkdown(baseConversation(), {}, {
    conversationMetadata: true,
    dateFormat: "european",
  });

  const createdIso = splitDateTime(metadataValue(iso, "Created"));
  assert.equal(
    metadataValue(euro, "Created"),
    `${createdIso.day}/${createdIso.month}/${createdIso.year} ${createdIso.time}`
  );
});

test("message timestamps and model names are independently opt-in", () => {
  const off = conversationToMarkdown(baseConversation());
  assert.ok(!off.includes("right-model"));

  const modelOnly = conversationToMarkdown(baseConversation(), {}, { modelName: true });
  assert.ok(modelOnly.includes("right-model"));
  assert.ok(!/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} · right-model/.test(modelOnly));

  const both = conversationToMarkdown(baseConversation(), {}, {
    messageTimestamps: true,
    modelName: true,
  });
  assert.match(both, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} · right-model/);
});

test("custom labels and blank-label fallbacks are respected", () => {
  const custom = conversationToMarkdown(baseConversation(), {}, {
    userLabel: "Prompt",
    assistantLabel: "Response",
  });
  assert.ok(custom.includes("## Prompt\n"));
  assert.ok(custom.includes("## Response\n"));

  const fallback = conversationToMarkdown(baseConversation(), {}, {
    userLabel: "   ",
    assistantLabel: "",
  });
  assert.ok(fallback.includes("## User\n"));
  assert.ok(fallback.includes("## Assistant\n"));
});

test("model, timestamps, metadata and activity remain absent with default options", () => {
  const convo = baseConversation();
  convo.mapping.thought = {
    parent: "user",
    children: [],
    message: {
      author: { role: "assistant" },
      content: { content_type: "thoughts", thoughts: [{ summary: "Ran a command" }] },
      metadata: {},
    },
  };
  convo.mapping.user.children.push("thought");

  const md = conversationToMarkdown(convo);
  assert.ok(!md.includes("right-model"));
  assert.ok(!md.includes("**Created:**"));
  assert.ok(!md.includes("Ran a command"));
  assert.ok(!md.includes("> **Worked**"));
});
