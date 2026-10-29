export function normalizeSelectedProjectIds(value) {
  if (!Array.isArray(value)) return null;
  return new Set(value.filter((id) => typeof id === "string" && id.length > 0));
}

export function filterSelectedProjects(projects, selectedIds) {
  const selected = normalizeSelectedProjectIds(selectedIds);
  if (selected === null) return [...projects];
  return projects.filter((project) => selected.has(project.gizmoId));
}

export function conversationMatchesProjectSelection(conversation, selectedIds) {
  const selected = selectedIds instanceof Set
    ? selectedIds
    : normalizeSelectedProjectIds(selectedIds);

  if (selected === null) return true;
  if (!conversation?.projectId) return true;
  return selected.has(conversation.projectId);
}
