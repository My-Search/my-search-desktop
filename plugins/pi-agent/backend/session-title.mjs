export function nameSessionFromFirstMessage(rec, message) {
  const session = rec.session;
  if ((session.messages || []).some((entry) => entry?.role === "user")) return;
  const existingName = session.sessionManager.getSessionName();
  if (existingName) return;
  const title = String(message || "").replace(/\s+/gu, " ").trim();
  if (!title) return;
  // 不做长度截断：会话名由 UI 负责省略显示（CSS text-overflow），
  // 后端截断会破坏 Unicode（.length 按 UTF-16 码元计，可能切断代理对/变体选择符），
  // 且用户看到的名字与真实首条消息不一致。
  session.setSessionName(title);
  rec.title = title;
}
