function stripCitations(str) {
  return str.replace(/\u3010[^\u3011]*\u3011/g, "");
}

export function conversationToMarkdown(convo, fileMap = {}) {
  const title   = convo.title || "Untitled";
  const ct      = convo.create_time;
  const dateStr = ct
    ? new Date(ct * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC"
    : "";

  const lines   = [`# ${title}`, ""];
  if (dateStr) lines.push(`*${dateStr}*\n`);

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
          lines.push(
            `## ${role.charAt(0).toUpperCase() + role.slice(1)}\n\n${text}\n`
          );
        }
      }

      queue.push(...(node.children || []));
    }
  }

  return lines.join("\n");
}