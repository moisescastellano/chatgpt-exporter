#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { conversationToMarkdown } from "../lib/markdown.js";

const [, , inputArg, outputArg] = process.argv;

if (!inputArg || !outputArg) {
  console.error(
    "Usage: node scripts/render-markdown.js <conversation.json> <output.md>"
  );
  process.exit(1);
}

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
  const markdown = conversationToMarkdown(conversation);
  writeFileSync(outputPath, markdown, "utf8");
} catch (e) {
  console.error(`Could not generate Markdown: ${e.message}`);
  process.exit(1);
}

console.log(`Markdown written to: ${outputPath}`);