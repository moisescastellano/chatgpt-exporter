// ── Project markdown converter ───────────────────────────────────────

export function projectToMarkdown(proj) {
  const name         = proj.display?.name        || proj.name        || proj.title || "Untitled Project";
  const description  = proj.display?.description || proj.description || "";
  const instructions = proj.instructions || proj.system_prompt || "";
  const createdRaw   = proj.created_at;
  let created = "";
  if (createdRaw) {
    try {
      const d = typeof createdRaw === "number"
        ? new Date(createdRaw > 1e10 ? createdRaw : createdRaw * 1000)
        : new Date(createdRaw);
      created = isNaN(d) ? "" : d.toISOString().slice(0, 10);
    } catch { /* ignore */ }
  }
  let md = `# ${name}\n\n`;
  if (description)  md += `**Description:** ${description}\n\n`;
  if (created)      md += `**Created:** ${created}\n\n`;
  if (instructions) md += `## Instructions\n\n${instructions}\n\n`;
  return md;
}

// ── GPT markdown converter ────────────────────────────────────────────

export function gptToMarkdown(gizmo) {
  const display  = gizmo.display || {};
  const name     = display.name        || gizmo.name || "Untitled GPT";
  const desc     = display.description || "";
  const starters = display.prompt_starters || [];
  const tools    = gizmo.tools || [];
  const createdRaw = gizmo.created_at;
  let created = "";
  if (createdRaw) {
    try {
      const d = typeof createdRaw === "number"
        ? new Date(createdRaw > 1e10 ? createdRaw : createdRaw * 1000)
        : new Date(createdRaw);
      created = isNaN(d) ? "" : d.toISOString().slice(0, 10);
    } catch { /* ignore */ }
  }
  const visibility = gizmo.visibility || display.visibility || "";

  let md = `# ${name}\n\n`;
  if (desc)       md += `**Description:** ${desc}\n\n`;
  if (created)    md += `**Created:** ${created}\n\n`;
  if (visibility) md += `**Visibility:** ${visibility}\n\n`;

  if (gizmo.instructions) {
    md += `## Instructions\n\n${gizmo.instructions}\n\n`;
  }

  if (starters.length) {
    md += `## Conversation Starters\n\n`;
    for (const s of starters) md += `- ${s}\n`;
    md += "\n";
  }

  if (tools.length) {
    md += `## Tools\n\n`;
    for (const t of tools) md += `- ${t.type || t.name || JSON.stringify(t)}\n`;
    md += "\n";
  }

  return md;
}

