function stripCitations(str) {
  return str.replace(/\u3010[^\u3011]*\u3011/g, "");
}

function escapeMarkdownLabel(value) {
  return String(value).replace(/([\\[\]])/g, "\\$1");
}

function encodeMarkdownPath(value) {
  return String(value)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function toDate(value) {
  if (!value) return null;

  const date = value instanceof Date
    ? value
    : typeof value === "number"
      ? new Date(value > 1e10 ? value : value * 1000)
      : new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

function formatTimestamp(value, dateFormat = "iso") {
  const date = toDate(value);
  if (!date) return "";

  const pad = (n) => String(n).padStart(2, "0");
  const year  = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day   = pad(date.getDate());
  const time  = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;

  if (dateFormat === "european") {
    return `${day}/${month}/${year} ${time}`;
  }

  return `${year}-${month}-${day} ${time}`;
}

function getConversationLink(convo) {
  if (typeof convo.url === "string" && /^https?:\/\//i.test(convo.url)) {
    return convo.url;
  }

  const conversationId = convo.conversation_id || convo.id;
  return conversationId
    ? `https://chatgpt.com/c/${encodeURIComponent(conversationId)}`
    : "";
}

function getAllBranchNodeIds(mapping) {
  const rootId = Object.keys(mapping).find((key) => mapping[key]?.parent == null);
  if (!rootId) return [];

  const result = [];
  const queue = [rootId];
  const seen = new Set();

  while (queue.length) {
    const nodeId = queue.shift();
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    result.push(nodeId);

    const node = mapping[nodeId];
    queue.push(...(node?.children || []));
  }

  return result;
}

function getCurrentBranchNodeIds(convo, mapping) {
  const currentNode = convo.current_node;
  if (!currentNode || !mapping[currentNode]) {
    return getAllBranchNodeIds(mapping);
  }

  const result = [];
  const seen = new Set();
  let nodeId = currentNode;

  while (nodeId && mapping[nodeId] && !seen.has(nodeId)) {
    seen.add(nodeId);
    result.push(nodeId);
    nodeId = mapping[nodeId].parent;
  }

  return result.reverse();
}

function getConversationNodeIds(convo, branchMode) {
  const mapping = convo.mapping || {};
  return branchMode === "all"
    ? getAllBranchNodeIds(mapping)
    : getCurrentBranchNodeIds(convo, mapping);
}

export function conversationToMarkdown(convo, fileMap = {}, options = {}) {
  const {
    conversationMetadata = false,
    messageTimestamps = false,
    modelName = false,
    dateFormat = "iso",
    branchMode = "current",
    userLabel = "User",
    assistantLabel = "Assistant",
  } = options;

  const title   = convo.title || "Untitled";
  const ct      = convo.create_time;
  const dateStr = ct
    ? new Date(ct * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC"
    : "";

  const lines = [`# ${title}`, ""];

  if (conversationMetadata) {
    const created  = formatTimestamp(convo.create_time, dateFormat);
    const updated  = formatTimestamp(convo.update_time, dateFormat);
    const exported = formatTimestamp(new Date(), dateFormat);
    const link     = getConversationLink(convo);

    if (created)  lines.push(`**Created:** ${created}  `);
    if (updated)  lines.push(`**Updated:** ${updated}  `);
    if (exported) lines.push(`**Exported:** ${exported}  `);
    if (link)     lines.push(`**Link:** [${link}](${link})  `);
    lines.push("");
  } else if (dateStr) {
    lines.push(`*${dateStr}*\n`);
  }

  const mapping = convo.mapping || {};
  const nodeIds = getConversationNodeIds(convo, branchMode);

  for (const nid of nodeIds) {
      const node = mapping[nid] || {};
      const msg  = node.message;

      if (msg?.content?.parts) {
        const role        = msg.author?.role || "unknown";
        const contentType = msg.content?.content_type || "text";

        if (role === "system" || role === "tool") {
          continue;
        }

        if (role === "assistant" && contentType !== "text") {
          continue;
        }

        const textParts = [];
        const attachments = Array.isArray(msg.metadata?.attachments)
          ? msg.metadata.attachments
          : [];
        const attachmentsById = new Map(
          attachments
            .filter((att) => att?.id)
            .map((att) => [att.id, att])
        );
        const renderedAttachmentIds = new Set();

        const renderAttachment = (att) => {
          const name = escapeMarkdownLabel(att?.name || "attachment");
          const path = att?.id ? fileMap[att.id] : "";
          return path
            ? `[Attachment: ${name}](${encodeMarkdownPath(path)})`
            : `[Attachment: ${name}]`;
        };

        const renderRemainingAttachments = () => {
          for (const att of attachments) {
            if (att?.id && renderedAttachmentIds.has(att.id)) continue;
            textParts.push(renderAttachment(att));
            if (att?.id) renderedAttachmentIds.add(att.id);
          }
        };

        const firstMeaningfulPart = msg.content.parts.find(
          (part) => !(typeof part === "string" && part.length === 0)
        );
        const attachmentsLeadMessage =
          firstMeaningfulPart?.content_type === "image_asset_pointer";

        if (attachmentsLeadMessage) {
          renderRemainingAttachments();
        }

        for (const part of msg.content.parts) {
          if (typeof part === "string") {
            textParts.push(part);
          } else if (
            part?.content_type === "image_asset_pointer" &&
            part.asset_pointer
          ) {
            const match = part.asset_pointer.match(
              /^(?:file-service|sediment):\/\/(.+)$/
            );
            const fileId = match?.[1];
            const attachment = fileId ? attachmentsById.get(fileId) : null;

            if (attachment) {
              if (!renderedAttachmentIds.has(fileId)) {
                textParts.push(renderAttachment(attachment));
                renderedAttachmentIds.add(fileId);
              }
            } else {
              textParts.push(
                fileId && fileMap[fileId]
                  ? `![Image](${encodeMarkdownPath(fileMap[fileId])})`
                  : "[Image]"
              );
            }
          } else {
            textParts.push(JSON.stringify(part));
          }
        }

        if (!attachmentsLeadMessage) {
          renderRemainingAttachments();
        }

        const text = stripCitations(textParts.join("\n")).trim();

        if (text) {
          let label;

          if (role === "user") {
            label = userLabel.trim() || "User";
          } else if (role === "assistant") {
            label = assistantLabel.trim() || "Assistant";
          } else {
            label = role.charAt(0).toUpperCase() + role.slice(1);
          }

          lines.push(`## ${label}`);

          const metadata = [];

          if (messageTimestamps && msg.create_time) {
            metadata.push(formatTimestamp(msg.create_time, dateFormat));
          }

          if (modelName && msg.metadata?.model_slug) {
            metadata.push(msg.metadata.model_slug);
          }

          if (metadata.length) {
            lines.push(metadata.join(" · "));
          }

          lines.push(`\n${text}\n`);
        }
      }

  }

  return lines.join("\n");
}
