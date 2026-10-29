export function timestampMs(value) {
  if (!value) return 0;
  if (typeof value === "number") return value > 1e10 ? value : value * 1000;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function classifyResumeState(existing, remoteItem, targetJsonPath) {
  if (!existing) {
    return {
      action: "download-new",
      isUpdate: false,
      pathChanged: false,
      reasons: [],
    };
  }

  const remoteUpdatedMs = timestampMs(remoteItem?.update_time);
  const localUpdatedMs = Number(existing.updatedMs) || 0;
  const localTitle = existing.convo?.title || "Untitled";
  const remoteTitle = remoteItem?.title || "Untitled";

  const pathChanged = existing.path !== targetJsonPath;
  const titleChanged = localTitle !== remoteTitle;
  const remoteIsNewer = remoteUpdatedMs > 0 && remoteUpdatedMs > localUpdatedMs;
  const localTimestampMissing = localUpdatedMs === 0;

  const reasons = [];
  if (titleChanged) reasons.push("title-changed");
  if (remoteIsNewer) reasons.push("remote-newer");
  if (localTimestampMissing) reasons.push("local-timestamp-missing");

  const isUpdate = reasons.length > 0;

  return {
    action: isUpdate ? "download-update" : pathChanged ? "move" : "resume",
    isUpdate,
    pathChanged,
    reasons,
  };
}
