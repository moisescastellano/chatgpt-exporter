function decodePathSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function sandboxFilename(sandboxPath) {
  const value = String(sandboxPath || "")
    .replace(/^sandbox:/i, "")
    .split(/[?#]/, 1)[0];
  const segment = value.split("/").filter(Boolean).pop() || "generated_file";
  return decodePathSegment(segment) || "generated_file";
}

function normalizeSandboxPath(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return /^sandbox:\//i.test(trimmed) ? trimmed : "";
}

function addSandboxPath(found, sandboxPath, messageId) {
  const path = normalizeSandboxPath(sandboxPath);
  if (!path || !messageId) return;

  let ref = found.get(path);
  if (!ref) {
    ref = {
      fileId: path,
      sandboxPath: path,
      filename: sandboxFilename(path),
      type: "sandbox",
      messageIds: [],
    };
    found.set(path, ref);
  }

  if (!ref.messageIds.includes(messageId)) {
    ref.messageIds.push(messageId);
  }
}

function sandboxPathsFromText(text) {
  if (typeof text !== "string" || !text.includes("sandbox:/")) return [];

  const found = [];
  const seen = new Set();
  const add = (value) => {
    const path = normalizeSandboxPath(value);
    if (!path || seen.has(path)) return;
    seen.add(path);
    found.push(path);
  };

  // Normal ChatGPT generated-file links: [label](sandbox:/path/to/file.ext)
  // Mask those matches before scanning for plain paths so a path containing
  // spaces is not also detected a second time as a truncated raw path.
  const masked = text.replace(
    /!?\[[^\]]*\]\((sandbox:\/(?:[^()\n]|\([^()\n]*\))+)\)/gi,
    (whole, sandboxPath) => {
      add(sandboxPath);
      return " ".repeat(whole.length);
    }
  );

  // Fallback for responses that expose the sandbox path as plain text.
  for (const match of masked.matchAll(/sandbox:\/[^\s<>'"\])}]+/gi)) {
    add(match[0]);
  }

  return found;
}

export function extractSandboxReferences(convo) {
  const found = new Map();
  const mapping = convo?.mapping || {};

  for (const node of Object.values(mapping)) {
    const msg = node?.message;
    if (!msg || msg.author?.role !== "assistant") continue;
    if (!Array.isArray(msg.content?.parts)) continue;

    const messageId = msg.id || node?.id;
    if (!messageId) continue;

    for (const part of msg.content.parts) {
      if (typeof part !== "string") continue;
      for (const path of sandboxPathsFromText(part)) {
        addSandboxPath(found, path, messageId);
      }
    }
  }

  return [...found.values()];
}

function encodeMarkdownPath(value) {
  return String(value)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function rewriteSandboxLinks(text, fileMap = {}) {
  if (typeof text !== "string" || !text.includes("sandbox:/")) return text;

  let rendered = text.replace(
    /(!?)\[([^\]]+)\]\((sandbox:\/(?:[^()\n]|\([^()\n]*\))+)\)/gi,
    (_whole, imagePrefix, label, sandboxPath) => {
      const localPath = fileMap[sandboxPath];
      return localPath
        ? `${imagePrefix}[${label}](${encodeMarkdownPath(localPath)})`
        : label;
    }
  );

  // Plain sandbox paths are uncommon, but when present they should not remain
  // as dead links in an exported document.
  rendered = rendered.replace(
    /sandbox:\/[^\s<>'"\])}]+/gi,
    (sandboxPath) => {
      const localPath = fileMap[sandboxPath];
      const filename = sandboxFilename(sandboxPath);
      return localPath
        ? `[${filename}](${encodeMarkdownPath(localPath)})`
        : filename;
    }
  );

  return rendered;
}
