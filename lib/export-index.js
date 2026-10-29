import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Buffer } from "node:buffer";
import { escapeHtml, sanitizeFilename } from "./export-files.js";

// ── Export index (root index.html) ───────────────────────────────────

export function extractHtmlTitle(htmlPath) {
  try {
    const fd  = openSync(htmlPath, "r");
    const buf = Buffer.alloc(256);
    const n   = readSync(fd, buf, 0, 256, 0);
    closeSync(fd);
    const m = buf.subarray(0, n).toString("utf8").match(/<title>([^<]*)<\/title>/);
    return m ? m[1] : basename(htmlPath, ".html");
  } catch { return basename(htmlPath, ".html"); }
}

export function generateExportIndex(rootDir, allProjects) {
  const listHtmlConversations = (htmlDir) => existsSync(htmlDir)
    ? readdirSync(htmlDir).filter((f) => f.endsWith(".html")).sort().reverse()
        .map((f) => ({ fname: f, title: extractHtmlTitle(join(htmlDir, f)) }))
    : [];

  const rootConvos     = listHtmlConversations(join(rootDir, "html"));
  const archivedConvos = listHtmlConversations(join(rootDir, "archived", "html"));
  const deletedConvos  = listHtmlConversations(join(rootDir, "deleted", "html"));

  const projects = (allProjects || []).map((proj) => {
    const safe        = sanitizeFilename(proj.name);
    const projDir     = join(rootDir, "projects", safe);
    const projHtmlDir = join(projDir, "html");
    const convos      = listHtmlConversations(projHtmlDir);
    const resDir    = join(projDir, "resources");
    const resources = existsSync(resDir)
      ? readdirSync(resDir).filter((f) => !f.startsWith(".")).sort()
      : [];
    const hasInfo   = existsSync(join(projDir, "project-info.md"));
    return { name: proj.name, safe, convos, resources, hasInfo };
  }).filter((proj) => proj.hasInfo || proj.resources.length > 0 || proj.convos.length > 0);

  writeFileSync(
    join(rootDir, "index.html"),
    buildExportIndexHtml(rootConvos, projects, archivedConvos, deletedConvos),
    "utf8"
  );
}

export function buildExportIndexHtml(rootConvos, projects, archivedConvos = [], deletedConvos = []) {
  const LOGO = `<svg viewBox="0 0 41 41" fill="none" xmlns="http://www.w3.org/2000/svg" width="20" height="20"><path d="M37.532 16.87a9.963 9.963 0 0 0-.856-8.184 10.078 10.078 0 0 0-10.855-4.835A9.964 9.964 0 0 0 18.306.5a10.079 10.079 0 0 0-9.614 6.977 9.967 9.967 0 0 0-6.664 4.834 10.08 10.08 0 0 0 1.24 11.817 9.965 9.965 0 0 0 .856 8.185 10.079 10.079 0 0 0 10.855 4.835 9.965 9.965 0 0 0 7.516 3.35 10.078 10.078 0 0 0 9.617-6.981 9.967 9.967 0 0 0 6.663-4.834 10.079 10.079 0 0 0-1.243-11.813ZM22.498 37.886a7.474 7.474 0 0 1-4.799-1.735c.061-.033.168-.091.237-.134l7.964-4.6a1.294 1.294 0 0 0 .655-1.134V19.054l3.366 1.944a.12.12 0 0 1 .066.092v9.299a7.505 7.505 0 0 1-7.49 7.496ZM6.392 31.006a7.471 7.471 0 0 1-.894-5.023c.06.036.162.099.237.141l7.964 4.6a1.297 1.297 0 0 0 1.308 0l9.724-5.614v3.888a.12.12 0 0 1-.048.103l-8.051 4.649a7.504 7.504 0 0 1-10.24-2.744ZM4.297 13.62A7.469 7.469 0 0 1 8.2 10.333c0 .068-.004.19-.004.274v9.201a1.294 1.294 0 0 0 .654 1.132l9.723 5.614-3.366 1.944a.12.12 0 0 1-.114.012L7.044 23.86a7.504 7.504 0 0 1-2.747-10.24Zm27.658 6.437-9.724-5.615 3.367-1.943a.121.121 0 0 1 .114-.012l8.048 4.648a7.498 7.498 0 0 1-1.158 13.528V21.36a1.293 1.293 0 0 0-.647-1.132v-.17Zm3.35-5.043c-.059-.037-.162-.099-.236-.141l-7.965-4.6a1.298 1.298 0 0 0-1.308 0l-9.723 5.614v-3.888a.12.12 0 0 1 .048-.103l8.05-4.645a7.497 7.497 0 0 1 11.135 7.763Zm-21.063 6.929-3.367-1.944a.12.12 0 0 1-.065-.092v-9.299a7.497 7.497 0 0 1 12.293-5.756 6.94 6.94 0 0 0-.236.134l-7.965 4.6a1.294 1.294 0 0 0-.654 1.132l-.006 11.225Zm1.829-3.943 4.33-2.501 4.332 2.5v5l-4.331 2.5-4.331-2.5V18Z" fill="currentColor"/></svg>`;

  const projectsHtml = projects.length ? `
    <div class="nav-section">
      <div class="nav-section-hdr">Projects</div>
      ${projects.map((p) => `
      <div class="nav-project">
        <button class="nav-proj-btn" onclick="toggleProj(this)">
          <svg class="folder-svg" viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/></svg>
          <span>${escapeHtml(p.name)}</span>
          <span class="chevron">▸</span>
        </button>
        <div class="nav-proj-items hidden">
          ${p.hasInfo ? `<a class="nav-item nav-meta" href="projects/${encodeURIComponent(p.safe)}/project-info.md" onclick="loadText(this,event)">📋 Project info</a>` : ""}
          ${p.resources.length ? `<div class="nav-sub-hdr">Resources</div>
          ${p.resources.map((r) => `<a class="nav-item nav-resource" href="projects/${encodeURIComponent(p.safe)}/resources/${encodeURIComponent(r)}" target="_blank">📎 ${escapeHtml(r)}</a>`).join("\n          ")}` : ""}
          ${p.convos.length ? `<div class="nav-sub-hdr">Conversations</div>` : ""}
          ${p.convos.map((c) => `<a class="nav-item" href="projects/${encodeURIComponent(p.safe)}/html/${encodeURIComponent(c.fname)}" onclick="loadFrame(this,event)">${escapeHtml(c.title)}</a>`).join("\n          ")}
        </div>
      </div>`).join("\n")}
    </div>` : "";

  const convosHtml = rootConvos.length ? `
    <div class="nav-section">
      <div class="nav-section-hdr">Recent chats</div>
      ${rootConvos.map((c) => `<a class="nav-item" href="html/${encodeURIComponent(c.fname)}" onclick="loadFrame(this,event)">${escapeHtml(c.title)}</a>`).join("\n      ")}
    </div>` : "";

  const archivedHtml = archivedConvos.length ? `
    <div class="nav-section">
      <div class="nav-section-hdr">Archived</div>
      ${archivedConvos.map((c) => `<a class="nav-item" href="archived/html/${encodeURIComponent(c.fname)}" onclick="loadFrame(this,event)">${escapeHtml(c.title)}</a>`).join("\n      ")}
    </div>` : "";

  const deletedHtml = deletedConvos.length ? `
    <div class="nav-section">
      <div class="nav-section-hdr">Deleted</div>
      ${deletedConvos.map((c) => `<a class="nav-item" href="deleted/html/${encodeURIComponent(c.fname)}" onclick="loadFrame(this,event)">${escapeHtml(c.title)}</a>`).join("\n      ")}
    </div>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ChatGPT Export</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0d0d0d;color:#ececec;display:flex;height:100vh;overflow:hidden}
.sidebar{width:260px;min-width:260px;height:100vh;background:#171717;display:flex;flex-direction:column;flex-shrink:0;border-right:1px solid #2a2a2a}
.sidebar-top{padding:12px 12px 10px;display:flex;align-items:center;gap:10px;border-bottom:1px solid #2a2a2a}
.sidebar-title{font-size:15px;font-weight:600}
.search-box{padding:8px 10px 4px}
.search-box input{width:100%;padding:7px 10px;background:#202020;border:1px solid #3a3a3a;border-radius:8px;color:#ececec;font-size:13px;outline:none}
.search-box input:focus{border-color:#555}
.search-box input::placeholder{color:#6b6b6b}
.sidebar-scroll{flex:1;overflow-y:auto;padding:4px 0 16px}
.sidebar-scroll::-webkit-scrollbar{width:4px}
.sidebar-scroll::-webkit-scrollbar-thumb{background:#3a3a3a;border-radius:2px}
.nav-section{padding:8px 0 4px}
.nav-section-hdr{font-size:12px;color:#8e8e8e;padding:6px 14px 4px;font-weight:500;letter-spacing:.02em}
.nav-project{margin:0}
.nav-proj-btn{display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px 7px 14px;background:none;border:none;color:#adadad;font-size:14px;cursor:pointer;text-align:left;border-radius:8px;margin:1px 4px;width:calc(100% - 8px)}
.nav-proj-btn:hover{background:#2a2a2a;color:#ececec}
.folder-svg{flex-shrink:0;color:#8e8e8e}
.nav-proj-btn span:nth-child(2){flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chevron{font-size:11px;color:#6b6b6b;transition:transform .15s;flex-shrink:0}
.chevron.open{transform:rotate(90deg)}
.nav-proj-items{padding-left:16px}
.nav-sub-hdr{font-size:10px;color:#6b6b6b;padding:6px 14px 2px;text-transform:uppercase;letter-spacing:.04em;font-weight:600}
.nav-resource{font-size:12px;color:#8e8e8e}
.nav-meta{font-size:12px;color:#8e8e8e;font-style:italic}
.nav-item{display:block;padding:5px 10px 5px 14px;font-size:13px;color:#adadad;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-radius:6px;margin:1px 4px}
.nav-item:hover{background:#2a2a2a;color:#ececec}
.nav-item.active{background:#2a2a2a;color:#ececec;font-weight:500}
.hidden{display:none}
.content{flex:1;height:100vh;border:none;background:#fff}
.placeholder{flex:1;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;color:#4a4a4a;font-size:14px}
</style></head>
<body>
<nav class="sidebar">
  <div class="sidebar-top">${LOGO}<span class="sidebar-title">ChatGPT Export</span></div>
  <div class="search-box"><input id="search" type="text" placeholder="Search conversations..." oninput="filterNav(this.value)"></div>
  <div class="sidebar-scroll" id="sidebar-scroll">
    ${convosHtml}
    ${projectsHtml}
    ${archivedHtml}
    ${deletedHtml}
  </div>
</nav>
<div id="placeholder" class="placeholder">
  ${LOGO.replace('width="20" height="20"', 'width="48" height="48" style="color:#3a3a3a"')}
  <span>Select a conversation</span>
</div>
<iframe id="frame" class="content" style="display:none"></iframe>
<script>
function toggleProj(btn){
  const items=btn.nextElementSibling;
  const ch=btn.querySelector('.chevron');
  items.classList.toggle('hidden');
  ch.classList.toggle('open');
}
function filterNav(q){
  const term=q.toLowerCase().trim();
  document.querySelectorAll('.nav-item').forEach(a=>{
    a.style.display=!term||a.textContent.toLowerCase().includes(term)?'':'none';
  });
  document.querySelectorAll('.nav-sub-hdr').forEach(h=>{
    const next=[];let s=h.nextElementSibling;
    while(s&&s.classList.contains('nav-item')){next.push(s);s=s.nextElementSibling;}
    h.style.display=next.some(a=>a.style.display!=='none')?'':'none';
  });
  document.querySelectorAll('.nav-project').forEach(p=>{
    const items=p.querySelector('.nav-proj-items');
    const btn=p.querySelector('.nav-proj-btn');
    const name=btn.querySelector('span:nth-child(2)').textContent.toLowerCase();
    const visKids=[...items.querySelectorAll('.nav-item')].some(a=>a.style.display!=='none');
    const nameMatch=term&&name.includes(term);
    p.style.display=!term||visKids||nameMatch?'':'none';
    if(term&&(visKids||nameMatch)){items.classList.remove('hidden');btn.querySelector('.chevron').classList.add('open');}
    else if(!term){items.classList.add('hidden');btn.querySelector('.chevron').classList.remove('open');}
  });
  document.querySelectorAll('.nav-section').forEach(s=>{
    const vis=[...s.querySelectorAll('.nav-item,.nav-project')].some(e=>e.style.display!=='none');
    s.style.display=vis?'':'none';
  });
}
function loadFrame(el,evt){
  evt&&evt.preventDefault();
  document.querySelectorAll('.nav-item').forEach(a=>a.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('placeholder').style.display='none';
  const f=document.getElementById('frame');
  f.style.display='block';
  f.src=el.getAttribute('href');
  location.hash=encodeURIComponent(el.getAttribute('href'));
}
function loadText(el,evt){
  evt&&evt.preventDefault();
  document.querySelectorAll('.nav-item').forEach(a=>a.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('placeholder').style.display='none';
  const f=document.getElementById('frame');
  f.style.display='block';
  fetch(el.getAttribute('href')).then(r=>r.text()).then(txt=>{
    const html='<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#1a1a1a;color:#e0e0e0;padding:32px 48px;max-width:800px;line-height:1.6}h1,h2,h3{color:#fff;margin:1.2em 0 .4em}h1{font-size:22px;border-bottom:1px solid #333;padding-bottom:8px}h2{font-size:18px}pre{background:#111;padding:12px;border-radius:6px;overflow-x:auto;font-size:13px}code{background:#222;padding:2px 5px;border-radius:3px;font-size:13px}ul,ol{padding-left:24px}li{margin:4px 0}blockquote{border-left:3px solid #444;padding-left:16px;color:#aaa;margin:12px 0}</style></head><body><pre style="white-space:pre-wrap">'+txt.replace(/</g,"&lt;")+'</pre></body></html>';
    f.srcdoc=html;
  });
  location.hash=encodeURIComponent(el.getAttribute('href'));
}
// Auto-expand project containing the active conversation (via hash)
function expandParentProject(link){
  const items=link.closest('.nav-proj-items');
  if(items){items.classList.remove('hidden');const ch=items.previousElementSibling?.querySelector('.chevron');if(ch)ch.classList.add('open');}
}
// Hash navigation
if(location.hash){
  const p=decodeURIComponent(location.hash.slice(1));
  const link=document.querySelector('.nav-item[href="'+p.replace(/"/g,'\\"')+'"]');
  if(link){expandParentProject(link);loadFrame(link);}
}
<\/script>
</body></html>`;
}

