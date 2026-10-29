import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { conversationToMarkdown } from "./markdown.js";
import { buildLocalFileMap, collectMarkdownRegenerationTargets } from "./local-export.js";

export async function regenerateMarkdown(outputDir, markdownOptions, sendEvent) {
  const rootDir = outputDir.startsWith("~")
    ? join(homedir(), outputDir.slice(1))
    : outputDir;

  const options = {
    messageTimestamps: false,
    modelName: false,
    userLabel: "User",
    assistantLabel: "Assistant",
    ...(markdownOptions || {}),
  };

  try {
    sendEvent("status", "Scanning local conversation JSON files...");
    const targets = collectMarkdownRegenerationTargets(rootDir);

    if (targets.length === 0) {
      sendEvent("done", JSON.stringify({
        total: 0,
        succeeded: 0,
        failed: 0,
        failedTitles: [],
        output: rootDir,
      }));
      return;
    }

    let succeeded = 0;
    const failed = [];

    sendEvent("status", `Regenerating ${targets.length} Markdown file(s)...`);

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      let title = target.fname;

      try {
        const convo = JSON.parse(readFileSync(target.jsonPath, "utf8"));
        title = convo.title || target.fname;
        const fileMap = buildLocalFileMap(target.filesDir, target.fname);
        const markdown = conversationToMarkdown(convo, fileMap, options);

        mkdirSync(target.mdDir, { recursive: true });
        writeFileSync(target.mdPath, markdown, "utf8");
        succeeded++;
      } catch (e) {
        failed.push(`${title}: ${e.message}`);
      }

      sendEvent("progress", JSON.stringify({
        current: i + 1,
        total: targets.length,
        title,
      }));

      // Yield so the SSE progress stream can update during large regenerations.
      await new Promise((resolve) => setImmediate(resolve));
    }

    sendEvent("done", JSON.stringify({
      total: targets.length,
      succeeded,
      failed: failed.length,
      failedTitles: failed,
      output: rootDir,
    }));
  } catch (e) {
    sendEvent("error_msg", `Markdown regeneration failed: ${e.message}`);
  }
}
