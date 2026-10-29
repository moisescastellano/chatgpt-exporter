#!/usr/bin/env node
/**
 * ChatGPT Conversation Exporter — Node.js with local web UI.
 *
 * server.js is intentionally kept as the application entrypoint. Export, API,
 * rendering and local-regeneration logic live in focused modules under lib/.
 */

import { createServer } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runExport } from "./lib/export-runner.js";
import { regenerateMarkdown } from "./lib/markdown-regeneration.js";
import { RateLimitStopError, fetchProjectsInventory, resetRateLimiter, setApiDebugLogger } from "./lib/chatgpt-api.js";

const __dirname = (() => {
  try { return dirname(fileURLToPath(import.meta.url)); }
  catch { return dirname(process.argv[1] || "."); }
})();

const DEBUG = process.argv.includes("--debug");
const DEBUG_LOG = join(__dirname, "debug.log");

function dbg(msg, data) {
  if (!DEBUG) return;
  const ts = new Date().toISOString();
  const line = data !== undefined
    ? `[${ts}] ${msg} ${typeof data === "string" ? data : JSON.stringify(data, null, 2)}`
    : `[${ts}] ${msg}`;
  appendFileSync(DEBUG_LOG, line + "\n", "utf8");
  console.log("[DEBUG]", msg, data !== undefined ? data : "");
}

if (DEBUG) {
  const { version, platform, arch } = process;
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || "(none)";
  writeFileSync(DEBUG_LOG, [
    "=".repeat(60),
    `ChatGPT Exporter — Debug log started ${new Date().toISOString()}`,
    `Node.js : ${version}`,
    `Platform: ${platform} (${arch})`,
    `Proxy   : ${proxy}`,
    `CWD     : ${__dirname}`,
    "=".repeat(60),
    "",
  ].join("\n"), "utf8");
  console.log(`[DEBUG] Debug mode ON — logging to ${DEBUG_LOG}`);
}

setApiDebugLogger(dbg);

const HOST = "127.0.0.1";
const PORT = 8523;

const exportJobs = new Map(); // exportId → { events: [], done: false }

const server = createServer((req, res) => {
  // Serve UI
  if (req.method === "GET" && (req.url === "/" || req.url === "")) {
    const candidates = [
      join(__dirname, "public", "index.html"),
      join(dirname(process.execPath), "public", "index.html"),
      join(process.cwd(), "public", "index.html"),
    ];
    let html = null;
    for (const p of candidates) {
      try { html = readFileSync(p, "utf8"); break; } catch {}
    }
    if (html) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } else {
      res.writeHead(500);
      res.end("Could not find public/index.html — place the 'public' folder next to the exe.");
    }

  // List Projects for the optional Project selector. This fetches only the
  // lightweight Project inventory; it does not download conversations or files.
  } else if (req.method === "POST" && req.url === "/list-projects") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let token;
      try {
        token = JSON.parse(body || "{}").token;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
        return;
      }

      if (!token) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No token provided" }));
        return;
      }

      resetRateLimiter();
      try {
        const projects = await fetchProjectsInventory(token);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          projects: projects.map((project) => ({ id: project.gizmoId, name: project.name })),
        }));
      } catch (e) {
        if (e instanceof RateLimitStopError) {
          res.writeHead(429, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            error: e.message,
            rateLimited: true,
            retryAfter: e.retryAfter || null,
          }));
        } else {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Could not load Projects: ${e.message}` }));
        }
      } finally {
        resetRateLimiter();
      }
    });

  // Start export
  } else if (req.method === "POST" && req.url === "/start-export") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let token, outputDir, concurrency, createZip, keepAwake, exportOptions;
      try {
        const parsed = JSON.parse(body);
        token         = parsed.token;
        outputDir     = parsed.outputDir   || join(homedir(), "Desktop", "chatgpt-export");
        concurrency   = parsed.concurrency || 5;
        createZip     = parsed.createZip   ?? false;
        keepAwake     = parsed.keepAwake   ?? true;
        exportOptions = parsed.exportOptions || {};
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
        return;
      }
      if (!token) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "No token provided" }));
        return;
      }

      const exportId = randomUUID().slice(0, 8);
      exportJobs.set(exportId, { events: [], done: false });

      const sendEvent = (type, data) => {
        const job = exportJobs.get(exportId);
        if (job) job.events.push({ type, data: String(data).replace(/\n/g, "\\n") });
        // Terminal output
        if (type === "progress") {
          const d = JSON.parse(data);
          const pct = String(Math.round((d.current / d.total) * 100)).padStart(3);
          process.stdout.write(`\r[${pct}%] ${d.current}/${d.total}  ${(d.title || "").slice(0, 50).padEnd(50)}`);
        } else if (type === "status") {
          process.stdout.write(`\r\x1b[2K${data}\n`);
        } else if (type === "done") {
          const d = JSON.parse(data);
          process.stdout.write(`\r\x1b[2K`);
          if (d.rateLimited) {
            console.warn(
              `\n⚠ Export paused by ChatGPT rate limit — ` +
              `${d.processed}/${d.total} conversations processed · ${d.remaining} remaining`
            );
          } else {
            console.log(
              `\n✓ Done — ${d.succeeded} new · ${d.updated || 0} updated · ` +
              `${d.skipped} resumed · ${d.failed} failed`
            );
          }
          console.log(`  Saved to: ${d.output}\n`);
        } else if (type === "rate_limited") {
          const d = JSON.parse(data);
          console.warn(`\n⚠ ${d.message}\n`);
        } else if (type === "error_msg") {
          console.error(`\n✗ ${data}\n`);
        }
      };

      runExport(token, outputDir, concurrency, createZip, keepAwake, exportOptions, sendEvent).finally(() => {
        const job = exportJobs.get(exportId);
        if (job) job.done = true;
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ exportId }));
    });

  // Regenerate Markdown from existing local JSON files (no ChatGPT requests)
  } else if (req.method === "POST" && req.url === "/regenerate-markdown") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let outputDir, markdownOptions;

      try {
        const parsed = JSON.parse(body || "{}");
        outputDir = parsed.outputDir || join(homedir(), "Desktop", "chatgpt-export");
        markdownOptions = parsed.markdownOptions || {};
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
        return;
      }

      const exportId = randomUUID().slice(0, 8);
      exportJobs.set(exportId, { events: [], done: false });

      const sendEvent = (type, data) => {
        const job = exportJobs.get(exportId);
        if (job) job.events.push({ type, data: String(data).replace(/\n/g, "\\n") });

        if (type === "progress") {
          const d = JSON.parse(data);
          const pct = String(Math.round((d.current / d.total) * 100)).padStart(3);
          process.stdout.write(`\r[${pct}%] ${d.current}/${d.total}  ${(d.title || "").slice(0, 50).padEnd(50)}`);
        } else if (type === "status") {
          process.stdout.write(`\r\x1b[2K${data}\n`);
        } else if (type === "done") {
          const d = JSON.parse(data);
          process.stdout.write(`\r\x1b[2K`);
          console.log(`\n✓ Markdown regenerated — ${d.succeeded}/${d.total} succeeded · ${d.failed} failed`);
          console.log(`  Saved to: ${d.output}\n`);
        } else if (type === "error_msg") {
          console.error(`\n✗ ${data}\n`);
        }
      };

      regenerateMarkdown(outputDir, markdownOptions, sendEvent).finally(() => {
        const job = exportJobs.get(exportId);
        if (job) job.done = true;
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ exportId }));
    });

  // SSE progress stream
  } else if (req.method === "GET" && req.url.startsWith("/progress/")) {
    const exportId = req.url.split("/progress/")[1];
    const job      = exportJobs.get(exportId);
    if (!job) { res.writeHead(404); res.end(); return; }

    res.writeHead(200, {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection":    "keep-alive",
    });

    let sent = 0;
    const interval = setInterval(() => {
      while (sent < job.events.length) {
        const evt = job.events[sent++];
        res.write(`event: ${evt.type}\ndata: ${evt.data}\n\n`);
      }
      if (job.done && sent >= job.events.length) {
        clearInterval(interval);
        exportJobs.delete(exportId);
        res.end();
      }
    }, 200);

    req.on("close", () => { clearInterval(interval); if (!res.writableEnded) res.end(); });

  // Platform config (default dir + platform name)
  } else if (req.method === "GET" && req.url === "/config") {
    const defaultDir = join(homedir(), "Desktop", "chatgpt-export");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ defaultDir, platform: process.platform }));

  // Debug log viewer
  } else if (req.method === "GET" && req.url === "/debug-log") {
    if (!DEBUG) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ enabled: false, message: "Start server with --debug to enable debug logging." }));
      return;
    }
    try {
      const content = existsSync(DEBUG_LOG) ? readFileSync(DEBUG_LOG, "utf8") : "(empty)";
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(content);
    } catch {
      res.writeHead(500);
      res.end("Could not read debug log.");
    }

  // Directory listing for in-browser folder picker
  } else if (req.method === "GET" && req.url.startsWith("/list-dir")) {
    try {
      const qs     = new URL(req.url, `http://${HOST}`).searchParams;
      const reqPath = qs.get("path") || homedir();
      const sep    = process.platform === "win32" ? "\\" : "/";
      const parent = reqPath.split(sep).slice(0, -1).join(sep) || sep;
      const entries = readdirSync(reqPath, { withFileTypes: true });
      const dirs = entries
        .filter(e => e.isDirectory() && !e.name.startsWith("."))
        .map(e => ({ name: e.name, path: join(reqPath, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      // On Windows, list drives if at root
      let drives = [];
      if (process.platform === "win32" && (reqPath === "" || reqPath.match(/^[A-Z]:\\?$/i))) {
        for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
          const d = `${letter}:\\`;
          try { readdirSync(d); drives.push({ name: d, path: d }); } catch {}
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ path: reqPath, parent, dirs, drives }));
    } catch (e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ path: homedir(), parent: homedir(), dirs: [], drives: [], error: e.message }));
    }

  // Create directory
  } else if (req.method === "POST" && req.url === "/create-dir") {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => {
      try {
        const { path } = JSON.parse(body);
        if (!path) throw new Error("No path provided");
        mkdirSync(path, { recursive: true });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, path }));
      } catch (e) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });

  } else {
    res.writeHead(404);
    res.end();
  }
});

// ── Start ────────────────────────────────────────────────────────────

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`\nPort ${PORT} is already in use — server is probably already running.`);
    console.error(`Open http://${HOST}:${PORT} in your browser.\n`);
    process.exit(0);
  }
});

export function startServer() {
  const url = `http://${HOST}:${PORT}`;
  server.listen(PORT, HOST, () => {
    console.log(`\nChatGPT Exporter v2 running at ${url}`);
    console.log("Press Ctrl+C to stop.\n");
    try {
      if (process.platform === "win32") {
        // explorer.exe is more reliable than `start` in RDP/service contexts.
        // Note: explorer always exits with code 1 even on success — that's normal.
        spawn("explorer.exe", [url], { detached: true, stdio: "ignore" }).unref();
      } else if (process.platform === "darwin") {
        spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
      } else {
        spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
      }
    } catch {}
  });

  // Ensure caffeinate is killed on server exit
  process.on("SIGINT",  () => { if (global._caffeinate) try { global._caffeinate.kill(); } catch {} process.exit(0); });
  process.on("SIGTERM", () => { if (global._caffeinate) try { global._caffeinate.kill(); } catch {} process.exit(0); });
}

// Auto-start when run directly (node server.js or npm start)
startServer();
