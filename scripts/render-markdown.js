#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { conversationToMarkdown } from "../lib/markdown.js";

const args = process.argv.slice(2);

const inputArg  = args[0];
const outputArg = args[1];

if (!inputArg || !outputArg) {
  console.error(
    "Usage: node scripts/render-markdown.js <conversation.json> <output.md> " +
    "[--conversation-metadata] [--timestamps] [--model-name] " +
    "[--date-format <iso|european>] " +
    "[--user-label <label>] [--assistant-label <label>]"
  );
  process.exit(1);
}

const getOptionValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const dateFormat = getOptionValue("--date-format") || "iso";
if (!['iso', 'european'].includes(dateFormat)) {
  console.error('Invalid --date-format. Use "iso" or "european".');
  process.exit(1);
}

const options = {
  conversationMetadata: args.includes("--conversation-metadata"),
  messageTimestamps: args.includes("--timestamps"),
  modelName: args.includes("--model-name"),
  dateFormat,
  userLabel: getOptionValue("--user-label") || "User",
  assistantLabel: getOptionValue("--assistant-label") || "Assistant",
};

const inputPath  = resolve(inputArg);
const outputPath = resolve(outputArg);

let conversation;

try {
  conversation = JSON.parse(readFileSync(inputPath, "utf8"));
} catch (e) {
  console.error(`Could not read conversation JSON: ${e.message}`);
  process.exit(1);
}

try {
  const markdown = conversationToMarkdown(conversation, {}, options);
  writeFileSync(outputPath, markdown, "utf8");
} catch (e) {
  console.error(`Could not generate Markdown: ${e.message}`);
  process.exit(1);
}

console.log(`Markdown written to: ${outputPath}`);
