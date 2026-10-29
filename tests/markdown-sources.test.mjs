import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { conversationToMarkdown } from "../lib/markdown.js";

function message(role, text, metadata = {}, channel) {
  return {
    author: { role },
    content: { content_type: "text", parts: [text] },
    metadata,
    ...(channel ? { channel } : {}),
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
  return { title: "Sources test", mapping, current_node: parent };
}

function count(text, substring) {
  return text.split(substring).length - 1;
}

function webRef(marker, title, url, attribution = "Example") {
  return {
    matched_text: marker,
    type: "grouped_webpages",
    items: [{ title, url, attribution }],
    safe_urls: [url],
  };
}

test("web citation widgets become normal Markdown links and a Sources block", () => {
  const marker = "\ue200genui\ue202{\"citation\":{\"ref\":\"turn1search0\"}}\ue201";
  const url = "https://example.com/docs?page=1&utm_source=chatgpt.com";
  const msg = message("assistant", `Use the documentation. ${marker}`, {
    content_references: [
      webRef(marker, "Example documentation", url, "Example Docs"),
      {
        matched_text: " ",
        type: "sources_footnote",
        sources: [{ title: "Example documentation", url, attribution: "Example Docs" }],
      },
    ],
  }, "final");

  const md = conversationToMarkdown(conversation([msg]));
  assert.ok(md.includes("Use the documentation. ([example.com](https://example.com/docs?page=1))"));
  assert.ok(md.includes("**Sources:**\n- [Example documentation](https://example.com/docs?page=1)"));
  assert.ok(!md.includes("utm_source=chatgpt.com"));
  assert.ok(!md.includes("\ue200genui"));
});

test("multiple cited pages are rendered inline and deduplicated in Sources", () => {
  const marker = "\ue200genui\ue202multi\ue201";
  const ref = {
    matched_text: marker,
    type: "grouped_webpages",
    items: [
      { title: "First", url: "https://one.example/a", attribution: "One" },
      { title: "Second", url: "https://two.example/b", attribution: "Two" },
    ],
  };
  const msg = message("assistant", `Claim ${marker}`, {
    content_references: [
      ref,
      {
        type: "sources_footnote",
        matched_text: " ",
        sources: [
          { title: "First", url: "https://one.example/a", attribution: "One" },
          { title: "First duplicate", url: "https://one.example/a", attribution: "One" },
          { title: "Second", url: "https://two.example/b", attribution: "Two" },
        ],
      },
    ],
  }, "final");

  const md = conversationToMarkdown(conversation([msg]));
  assert.ok(md.includes("([one.example](https://one.example/a), [two.example](https://two.example/b))"));
  assert.equal(count(md, "https://one.example/a"), 2); // inline + Sources
  assert.equal(count(md, "- [First](https://one.example/a)"), 1);
  assert.equal(count(md, "- [Second](https://two.example/b)"), 1);
});

test("sources from grouped assistant fragments are combined under one response", () => {
  const firstMarker = "\ue200genui\ue202first\ue201";
  const secondMarker = "\ue200genui\ue202second\ue201";
  const c = conversation([
    message("user", "Question"),
    message("assistant", `Progress ${firstMarker}`, {
      content_references: [webRef(firstMarker, "First source", "https://first.example/a")],
    }, "commentary"),
    message("assistant", `Final ${secondMarker}`, {
      content_references: [webRef(secondMarker, "Second source", "https://second.example/b")],
    }, "final"),
  ]);

  const md = conversationToMarkdown(c);
  assert.equal(count(md, "## Assistant"), 1);
  assert.equal(count(md, "**Sources:**"), 1);
  assert.ok(md.indexOf("Final") < md.indexOf("**Sources:**"));
  assert.ok(md.includes("- [First source](https://first.example/a)"));
  assert.ok(md.includes("- [Second source](https://second.example/b)"));
});

test("legacy file citations become readable local links when the file is available", () => {
  const marker = "【97†Report [final].pdf】";
  const msg = message("assistant", `See ${marker} for details.`, {
    content_references: [{
      matched_text: marker,
      type: "file",
      name: "Report [final].pdf",
      id: "file-1",
    }],
  }, "final");

  const md = conversationToMarkdown(
    conversation([msg]),
    { "file-1": "../files/Conversation/Report final.pdf" }
  );
  assert.ok(md.includes("[Source: Report \\[final\\].pdf](../files/Conversation/Report%20final.pdf)"));
  assert.ok(!md.includes("【97†"));
});

test("unavailable file citations remain visible by name", () => {
  const marker = "【12†old.pdf】";
  const msg = message("assistant", `According to ${marker}, this changed.`, {
    content_references: [{ matched_text: marker, type: "file", name: "old.pdf", id: "missing" }],
  }, "final");
  const md = conversationToMarkdown(conversation([msg]));
  assert.ok(md.includes("According to [Source: old.pdf], this changed."));
  assert.ok(!md.includes("【12†old.pdf】"));
});

test("hidden/internal references and uncited search results are not exported", () => {
  const hidden = "\ue200memcite\ue201";
  const msg = message("assistant", `Answer ${hidden}`, {
    content_references: [{ matched_text: hidden, type: "hidden", safe_urls: [] }],
    search_result_groups: [{
      entries: [{ title: "Uncited", url: "https://uncited.example/" }],
    }],
  }, "final");

  const md = conversationToMarkdown(conversation([msg]));
  assert.ok(md.includes("Answer"));
  assert.ok(!md.includes("memcite"));
  assert.ok(!md.includes("uncited.example"));
  assert.ok(!md.includes("**Sources:**"));
});

// Optional real fixtures: DiskDirCRC first, Cartago second.
if (process.argv[2]) {
  test("recent real conversation exports cited web sources without internal widgets", () => {
    const c = JSON.parse(readFileSync(process.argv[2], "utf8"));
    const md = conversationToMarkdown(c, {}, { thoughtProcess: true });
    assert.ok(md.includes("**Sources:**"));
    assert.ok(!md.includes("\ue200genui"));
    assert.ok(!md.includes("utm_source=chatgpt.com"));
  });
}

if (process.argv[3]) {
  test("legacy real conversation keeps file citations readable", () => {
    const c = JSON.parse(readFileSync(process.argv[3], "utf8"));
    const md = conversationToMarkdown(c);
    assert.ok(md.includes("[Source:"));
    assert.ok(!/【[^】]*】/.test(md));
  });
}
