import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";

let debugLogger = () => {};
export function setApiDebugLogger(logger) { debugLogger = typeof logger === "function" ? logger : () => {}; }
export function apiDebug(msg, data) { debugLogger(msg, data); }

export const API_BASE = "https://chatgpt.com/backend-api";
export const API_BASE_PUB = "https://chatgpt.com/public-api";
export const PAGE_SIZE = 100;
export const DELAY = 100;
export const DEVICE_ID = randomUUID();

export const HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "application/json",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://chatgpt.com/",
  Origin: "https://chatgpt.com",
  "Oai-Device-Id": DEVICE_ID,
  "Oai-Language": "en-US",
  "Sec-Ch-Ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"macOS"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
};

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const API_MIN_INTERVAL_MS = 1000;
let nextApiRequestAt = 0;
let apiRequestChain = Promise.resolve();
let rateLimitStopped = false;
let rateLimitRetryAfter = null;
let onRateLimitStop = null;

export class RateLimitStopError extends Error {
  constructor(retryAfter = null) {
    const detail = retryAfter ? ` Retry-After: ${retryAfter}.` : "";
    super(`ChatGPT rate limit reached.${detail} Export paused. Try again later; rerunning the export will resume from the conversations already saved.`);
    this.name = "RateLimitStopError";
    this.retryAfter = retryAfter;
  }
}

export function resetRateLimiter() {
  nextApiRequestAt = 0;
  apiRequestChain = Promise.resolve();
  rateLimitStopped = false;
  rateLimitRetryAfter = null;
  onRateLimitStop = null;
}

export function setRateLimitStopHandler(handler) {
  onRateLimitStop = typeof handler === "function" ? handler : null;
}

export function getRateLimitState() {
  return { stopped: rateLimitStopped, retryAfter: rateLimitRetryAfter };
}

export async function debugFetch(url, options = {}) {
  const t0 = Date.now();
  apiDebug(`FETCH → ${url}`);
  try {
    const resp = await fetch(url, options);
    apiDebug(`FETCH ← ${url}`, `HTTP ${resp.status} (${Date.now() - t0}ms)`);
    return resp;
  } catch (e) {
    apiDebug(`FETCH ✗ ${url}`, `ERROR: ${e.message} — cause: ${e.cause?.message ?? e.cause ?? "(none)"}`);
    throw e;
  }
}

export async function pacedChatGptFetch(fn) {
  const run = apiRequestChain.then(async () => {
    if (rateLimitStopped) throw new RateLimitStopError();
    const waitMs = Math.max(0, nextApiRequestAt - Date.now());
    if (waitMs > 0) await sleep(waitMs);
    if (rateLimitStopped) throw new RateLimitStopError();
    nextApiRequestAt = Date.now() + API_MIN_INTERVAL_MS;
    const resp = await fn();
    if (resp.status === 429) {
      rateLimitStopped = true;
      const retryAfter = resp.headers.get("retry-after");
      rateLimitRetryAfter = retryAfter || null;
      const err = new RateLimitStopError(retryAfter);
      apiDebug("429 rate limited — stopping export", { retryAfter });
      if (onRateLimitStop) { try { onRateLimitStop(err.message); } catch {} }
      throw err;
    }
    return resp;
  });
  apiRequestChain = run.catch(() => {});
  return run;
}

export async function apiGet(path, token) {
  const resp = await pacedChatGptFetch(() => debugFetch(`${API_BASE}/${path}`, { headers: { ...HEADERS, Authorization: `Bearer ${token}` } }));
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${body.slice(0, 300)}`);
  }
  return resp.json();
}

export async function apiFetchBinary(url, token) {
  const h = { ...HEADERS, Accept: "*/*" };
  const target = new URL(url, "https://chatgpt.com/");
  const host = target.hostname.toLowerCase();
  const isChatGptHost = target.protocol === "https:" && (host === "chatgpt.com" || host.endsWith(".chatgpt.com"));
  if (token && isChatGptHost) h.Authorization = `Bearer ${token}`;
  const resp = isChatGptHost ? await pacedChatGptFetch(() => debugFetch(url, { headers: h })) : await debugFetch(url, { headers: h });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return { buffer: Buffer.from(await resp.arrayBuffer()), contentType: resp.headers.get("content-type") || "" };
}

export const MIME_TO_EXT = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/svg+xml": ".svg",
  "application/pdf": ".pdf", "text/plain": ".txt", "text/html": ".html", "text/csv": ".csv", "application/json": ".json", "application/zip": ".zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
};

export async function fetchProjectsInventory(token, onFound = null) {
  const projects = [];
  let cursor = null;

  while (true) {
    const qs = `owned_only=true&conversations_per_gizmo=0&limit=20${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`;
    const data = await pacedChatGptFetch(() => debugFetch(`${API_BASE}/gizmos/snorlax/sidebar?${qs}`, {
      headers: { ...HEADERS, Authorization: `Bearer ${token}` },
    })).then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });

    const items = data.list?.items || data.items || [];
    if (!items.length) break;

    for (const item of items) {
      const wrapper = item.resource?.gizmo || item.gizmo || item;
      const gizmo = wrapper.gizmo || wrapper;
      const gizmoId = gizmo.id || "";
      if (!gizmoId.startsWith("g-p-")) continue;
      const name = gizmo.display?.name || gizmo.name || gizmoId;
      const files = wrapper.files || [];
      const project = { gizmoId, name, gizmo, files };
      projects.push(project);
      if (onFound) onFound(project);
    }

    cursor = data.list?.cursor || data.cursor || null;
    if (!cursor) break;
    await sleep(DELAY);
  }

  return projects;
}

