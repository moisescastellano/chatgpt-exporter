function stripCitations(str) {
  return str.replace(/\u3010[^\u3011]*\u3011/g, "");
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

function formatTimestamp(value) {
  const date = toDate(value);
  if (!date) return "";

  const pad = (n) => String(n).padStart(2, "0");

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
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

export function conversationToMarkdown(convo, fileMap = {}, options = {}) {
  const {
    conversationMetadata = false,
    messageTimestamps = false,
    modelName = false,
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
    const created  = formatTimestamp(convo.create_time);
    const updated  = formatTimestamp(convo.update_time);
    const exported = formatTimestamp(new Date());
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
  const rootId  = Object.keys(mapping).find((k) => mapping[k].parent == null);

  if (rootId) {
    const queue = [rootId];

    while (queue.length) {
      const nid  = queue.shift();
      const node = mapping[nid] || {};
      const msg  = node.message;

      if (msg?.content?.parts) {
        const role        = msg.author?.role || "unknown";
        const contentType = msg.content?.content_type || "text";

        if (role === "system" || role === "tool") {
          queue.push(...(node.children || []));
          continue;
        }

        if (role === "assistant" && contentType !== "text") {
          queue.push(...(node.children || []));
          continue;
        }

        const textParts = [];

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

            textParts.push(
              match && fileMap[match[1]]
                ? `![image](${fileMap[match[1]]})`
                : "[image]"
            );
          } else {
            textParts.push(JSON.stringify(part));
          }
        }

        if (msg.metadata?.attachments) {
          for (const att of msg.metadata.attachments) {
            if (att.id && fileMap[att.id]) {
              textParts.push(
                `\n📎 [${att.name || "attachment"}](${fileMap[att.id]})`
              );
            }
          }
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
            metadata.push(formatTimestamp(msg.create_time));
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

      queue.push(...(node.children || []));
    }
  }

  return lines.join("\n");
}
