import { Buffer } from "node:buffer";
import { rewriteSandboxLinks } from "./sandbox-files.js";
import { escapeHtml, stripCitations } from "./export-files.js";

// ── HTML converter ───────────────────────────────────────────────────

export function conversationToHtml(convo, fileMap = {}, allConversations = [], currentFname = "") {
  const title   = escapeHtml(convo.title || "Untitled");
  const ct      = convo.create_time;
  const dateStr = ct
    ? new Date(ct * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC"
    : "";

  const messages = [];
  const mapping  = convo.mapping || {};
  const rootId   = Object.keys(mapping).find((k) => mapping[k].parent == null);

  if (rootId) {
    const queue = [rootId];
    while (queue.length) {
      const nid  = queue.shift();
      const node = mapping[nid] || {};
      const msg  = node.message;
      if (msg?.content?.parts) {
        const role        = msg.author?.role || "unknown";
        const contentType = msg.content?.content_type || "text";
        if (role === "system") { queue.push(...(node.children || [])); continue; }

        const isInternal = role === "tool" ||
          (role === "assistant" && contentType !== "text") ||
          (role === "user" && contentType === "user_editable_context");

        const textParts  = [];
        const imageParts = [];
        for (const part of msg.content.parts) {
          if (typeof part === "string") {
            textParts.push(part);
          } else if (part?.content_type === "image_asset_pointer" && part.asset_pointer) {
            const match = part.asset_pointer.match(/^(?:file-service|sediment):\/\/(.+)$/);
            if (match && fileMap[match[1]]) imageParts.push(fileMap[match[1]]);
          }
        }
        const attachments = [];
        if (msg.metadata?.attachments) {
          for (const att of msg.metadata.attachments) {
            if (att.id && fileMap[att.id]) {
              attachments.push({ name: att.name || "attachment", path: fileMap[att.id] });
            }
          }
        }
        const text = rewriteSandboxLinks(stripCitations(textParts.join("\n")), fileMap).trim();
        if (text || imageParts.length || attachments.length) {
          messages.push({ role, text, images: imageParts, attachments, isInternal, contentType });
        }
      }
      queue.push(...(node.children || []));
    }
  }

  const LOGO = `<svg viewBox="0 0 41 41" fill="none" xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M37.532 16.87a9.963 9.963 0 0 0-.856-8.184 10.078 10.078 0 0 0-10.855-4.835A9.964 9.964 0 0 0 18.306.5a10.079 10.079 0 0 0-9.614 6.977 9.967 9.967 0 0 0-6.664 4.834 10.08 10.08 0 0 0 1.24 11.817 9.965 9.965 0 0 0 .856 8.185 10.079 10.079 0 0 0 10.855 4.835 9.965 9.965 0 0 0 7.516 3.35 10.078 10.078 0 0 0 9.617-6.981 9.967 9.967 0 0 0 6.663-4.834 10.079 10.079 0 0 0-1.243-11.813ZM22.498 37.886a7.474 7.474 0 0 1-4.799-1.735c.061-.033.168-.091.237-.134l7.964-4.6a1.294 1.294 0 0 0 .655-1.134V19.054l3.366 1.944a.12.12 0 0 1 .066.092v9.299a7.505 7.505 0 0 1-7.49 7.496ZM6.392 31.006a7.471 7.471 0 0 1-.894-5.023c.06.036.162.099.237.141l7.964 4.6a1.297 1.297 0 0 0 1.308 0l9.724-5.614v3.888a.12.12 0 0 1-.048.103l-8.051 4.649a7.504 7.504 0 0 1-10.24-2.744ZM4.297 13.62A7.469 7.469 0 0 1 8.2 10.333c0 .068-.004.19-.004.274v9.201a1.294 1.294 0 0 0 .654 1.132l9.723 5.614-3.366 1.944a.12.12 0 0 1-.114.012L7.044 23.86a7.504 7.504 0 0 1-2.747-10.24Zm27.658 6.437-9.724-5.615 3.367-1.943a.121.121 0 0 1 .114-.012l8.048 4.648a7.498 7.498 0 0 1-1.158 13.528V21.36a1.293 1.293 0 0 0-.647-1.132v-.17Zm3.35-5.043c-.059-.037-.162-.099-.236-.141l-7.965-4.6a1.298 1.298 0 0 0-1.308 0l-9.723 5.614v-3.888a.12.12 0 0 1 .048-.103l8.05-4.645a7.497 7.497 0 0 1 11.135 7.763Zm-21.063 6.929-3.367-1.944a.12.12 0 0 1-.065-.092v-9.299a7.497 7.497 0 0 1 12.293-5.756 6.94 6.94 0 0 0-.236.134l-7.965 4.6a1.294 1.294 0 0 0-.654 1.132l-.006 11.225Zm1.829-3.943 4.33-2.501 4.332 2.5v5l-4.331 2.5-4.331-2.5V18Z" fill="currentColor"/></svg>`;

  const INTERNAL_LABELS = {
    multimodal_text: "File context", code: "Code", execution_output: "Output",
    computer_output: "Output", tether_browsing_display: "Web browsing",
    system_error: "Error", text: "Tool output",
  };

  const messagesHtml = messages.map((m) => {
    if (m.isInternal) {
      const label = INTERNAL_LABELS[m.contentType] || "Internal context";
      const b64   = Buffer.from(m.text, "utf8").toString("base64");
      return `<details class="thinking"><summary>${label}</summary><div class="thinking-content md-content" dir="auto" data-md="${b64}"></div></details>`;
    }
    const roleClass = m.role === "user" ? "user" : "assistant";
    let content = "";
    if (m.role === "user") {
      content = `<div class="bubble" dir="auto">${escapeHtml(m.text).replace(/\n/g, "<br>")}</div>`;
    } else {
      const b64 = Buffer.from(m.text, "utf8").toString("base64");
      content = `<div class="avatar">${LOGO}</div><div class="content"><div class="md-content" dir="auto" data-md="${b64}"></div></div>`;
    }
    if (m.images.length) {
      content += `<div class="images">${m.images.map((s) =>
        `<a href="${escapeHtml(s)}" target="_blank"><img src="${escapeHtml(s)}" alt="image" loading="lazy"></a>`
      ).join("")}</div>`;
    }
    if (m.attachments.length) {
      content += `<div class="attachments">${m.attachments.map((a) =>
        `<a class="attachment" href="${escapeHtml(a.path)}" target="_blank"><span class="att-icon">📎</span><span class="att-name">${escapeHtml(a.name)}</span></a>`
      ).join("")}</div>`;
    }
    return `<div class="message ${roleClass}">${content}</div>`;
  }).join("\n");

  const sidebarItems = allConversations.map((c) => {
    const cls  = c.fname === currentFname ? "sidebar-item active" : "sidebar-item";
    const href = encodeURIComponent(c.fname) + ".html";
    return `<a class="${cls}" href="${href}" title="${escapeHtml(c.title)}">${escapeHtml(c.title)}</a>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release/build/styles/github-dark.min.css">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #fff; color: #0d0d0d; line-height: 1.65; font-size: 16px; display: flex; height: 100vh; }
  .sidebar { width: 260px; min-width: 260px; height: 100vh; background: #f9f9f9; border-right: 1px solid #e5e5e5; overflow-y: auto; padding: 16px 0; flex-shrink: 0; position: sticky; top: 0; }
  .sidebar-header { padding: 8px 16px 16px; font-size: 14px; font-weight: 600; color: #6b6b6b; border-bottom: 1px solid #e5e5e5; margin-bottom: 8px; }
  .sidebar-item { display: block; padding: 8px 16px; font-size: 13px; color: #0d0d0d; text-decoration: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-radius: 8px; margin: 2px 8px; }
  .sidebar-item:hover { background: #ececec; }
  .sidebar-item.active { background: #e5e5e5; font-weight: 600; }
  .main { flex: 1; overflow-y: auto; }
  .header { max-width: 768px; margin: 0 auto; padding: 32px 24px 16px; border-bottom: 1px solid #e5e5e5; }
  .header h1 { font-size: 22px; font-weight: 600; }
  .header .date { font-size: 13px; color: #6b6b6b; margin-top: 4px; }
  .chat { max-width: 768px; margin: 0 auto; padding: 24px; }
  .message { margin-bottom: 24px; }
  .message.user { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
  .message.user .bubble { background: #f4f4f4; border-radius: 18px; padding: 10px 16px; max-width: 85%; white-space: pre-wrap; word-break: break-word; }
  .message.assistant { display: flex; gap: 12px; align-items: flex-start; }
  .message.assistant .avatar { width: 28px; height: 28px; border-radius: 50%; background: #00a67e; color: #fff; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 2px; }
  .message.assistant .content { flex: 1; min-width: 0; }
  .message.assistant .content h1, .message.assistant .content h2, .message.assistant .content h3 { margin: 16px 0 8px; font-weight: 600; }
  .message.assistant .content h1 { font-size: 20px; } .message.assistant .content h2 { font-size: 18px; } .message.assistant .content h3 { font-size: 16px; }
  .message.assistant .content p { margin: 8px 0; }
  .message.assistant .content ul, .message.assistant .content ol { margin: 8px 0; padding-left: 24px; }
  .message.assistant .content li { margin: 4px 0; }
  .message.assistant .content a { color: #1a7f64; }
  .message.assistant .content code { background: #f0f0f0; border-radius: 4px; padding: 2px 5px; font-family: monospace; font-size: 14px; }
  .message.assistant .content pre { margin: 12px 0; border-radius: 8px; overflow: hidden; }
  .message.assistant .content pre code { display: block; background: #0d0d0d; color: #f8f8f2; padding: 16px; overflow-x: auto; font-size: 13px; line-height: 1.5; }
  .code-block { position: relative; }
  .code-block .copy-btn { position: absolute; top: 8px; right: 8px; background: #333; border: none; color: #999; cursor: pointer; font-size: 12px; padding: 4px 10px; border-radius: 4px; opacity: 0; transition: opacity 0.2s; }
  .code-block:hover .copy-btn { opacity: 1; }
  .images img { max-width: 100%; border-radius: 8px; margin: 4px 0; display: block; }
  .message.user .images img { max-width: 300px; }
  .attachments { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 8px; }
  .attachment { display: inline-flex; align-items: center; gap: 8px; background: #f4f4f4; border: 1px solid #e5e5e5; border-radius: 8px; padding: 8px 12px; text-decoration: none; color: #0d0d0d; font-size: 14px; }
  .att-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px; }
  .thinking { margin-bottom: 24px; border-left: 3px solid #d4d4d4; padding-left: 16px; font-size: 14px; }
  .thinking summary { color: #8e8e8e; font-style: italic; cursor: pointer; padding: 4px 0; }
  .thinking-content { color: #6b6b6b; padding: 8px 0; font-style: italic; }
</style>
</head>
<body>
<nav class="sidebar"><div class="sidebar-header">Conversations</div>${sidebarItems}</nav>
<div class="main">
  <div class="header"><h1>${title}</h1>${dateStr ? `<div class="date">${dateStr}</div>` : ""}</div>
  <div class="chat">${messagesHtml}</div>
</div>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release/build/highlight.min.js"><\/script>
<script>
if (window !== window.top) { document.querySelector('.sidebar')?.remove(); }
document.addEventListener('DOMContentLoaded', () => {
  const renderer = new marked.Renderer();
  renderer.code = function({ text, lang }) {
    const hl = lang && hljs.getLanguage(lang) ? hljs.highlight(text, { language: lang }).value : hljs.highlightAuto(text).value;
    return '<div class="code-block"><button class="copy-btn" onclick="navigator.clipboard.writeText(this.nextElementSibling.querySelector(\\'code\\').textContent);this.textContent=\\'Copied!\\';setTimeout(()=>this.textContent=\\'Copy\\',1500)">Copy</button><pre><code class="hljs">' + hl + '</code></pre></div>';
  };
  marked.use({ renderer, breaks: true });
  document.querySelectorAll('.md-content').forEach(el => {
    try { el.innerHTML = marked.parse(decodeURIComponent(escape(atob(el.dataset.md)))); } catch(e) {}
  });
  const active = document.querySelector('.sidebar-item.active');
  if (active) active.scrollIntoView({ block: 'center', behavior: 'instant' });
});
<\/script>
</body>
</html>`;
}

