export function nameSessionFromFirstMessage(rec, message) {
  const session = rec.session;
  if ((session.messages || []).some((entry) => entry?.role === "user")) return;
  const existingName = session.sessionManager.getSessionName();
  if (existingName) return;
  const title = String(message || "").replace(/\s+/gu, " ").trim();
  if (!title) return;
  // 截断标题到合理长度（50字符）
  const truncatedTitle = title.length > 50 ? title.substring(0, 50) + "..." : title;
  session.setSessionName(truncatedTitle);
  rec.title = truncatedTitle;
}
