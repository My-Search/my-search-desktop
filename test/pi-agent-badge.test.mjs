/**
 * 角标口径测试：「已完成未查看 + 进行中」在真实 JSONL 会话上的行为。
 *
 * 造两个会话文件 → 建立基线（不应算未读）→ 让其中一个「有新回答」（mtime 推后）
 * → 应变成 unseen → markViewed 后应清掉。
 *
 * 用法: node test/pi-agent-badge.test.mjs
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "plugins", "pi-agent", "backend", "index.mjs");

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("PASS ", name, extra ? ` — ${extra}` : ""); }
  else { fail++; console.log("FAIL ", name, extra ? ` — ${extra}` : ""); }
};

/** pi 的会话目录编码（与 session-manager 的 getDefaultSessionDirPath 一致） */
const encodeDir = (cwd) => `--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-badge-"));
const dataDir = path.join(tmp, "data");
const proj = path.join(tmp, "proj");
await mkdir(dataDir, { recursive: true });
await mkdir(proj, { recursive: true });

const child = spawn(process.execPath, [entry], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, HOME: tmp, USERPROFILE: tmp },
});
let buf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
child.stderr.on("data", () => {});
let seq = 0;
const call = (method, params) => new Promise((res, rej) => {
  const id = ++seq;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  const t = setTimeout(() => { pending.delete(id); rej(new Error("timeout " + method)); }, 120000);
  pending.set(id, (m) => { clearTimeout(t); res(m); });
});
const finish = async (code) => {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "deactivate" }) + "\n");
  await new Promise((r) => setTimeout(r, 300));
  try { child.kill(); } catch {}
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  process.exit(code);
};

const init = await call("init", { pluginId: "com.mysearch.pi-agent", dataDir });
if (!init.result?.hasPi) {
  console.log("跳过：本机没有可用的 pi ——", init.result?.piError || "未找到");
  await finish(0);
}

const np = path.resolve(proj);
await call("addProject", { path: np });

// 造两个「已完成」的会话文件
const sessDir = path.join(tmp, ".pi", "agent", "sessions", encodeDir(np));
await mkdir(sessDir, { recursive: true });
const mk = (id, ts, text) => {
  const header = { type: "session", version: 3, id, timestamp: ts, cwd: np };
  const entryOf = (role, t) => ({
    type: "message", id: `${id}-${role}`, parentId: null, timestamp: t,
    message: { role, content: [{ type: "text", text: t }], timestamp: t },
  });
  return [header, entryOf("user", ts), entryOf("assistant", ts)].map((l) => JSON.stringify(l)).join("\n") + "\n";
};
const fileA = path.join(sessDir, "2026-09-17T01-00-00-000Z_aaa.jsonl");
const fileB = path.join(sessDir, "2026-09-17T02-00-00-000Z_bbb.jsonl");
await writeFile(fileA, mk("aaa", "2026-09-17T01:00:00.000Z", "旧会话"));
await writeFile(fileB, mk("bbb", "2026-09-17T02:00:00.000Z", "新会话"));

const flagsOf = async () => {
  const r = await call("listSessions", { projectPath: np });
  const map = {};
  for (const s of r.result.sessions) map[s.id] = s.flag;
  return { map, badgeCount: r.result.badgeCount, total: r.result.sessions.length };
};

/* 1. 首次建立基线：历史会话不应算成「未查看」 */
const first = await flagsOf();
check("两个历史会话都被列出", first.total === 2, JSON.stringify(first.map));
check("基线建立后：历史会话不算未查看（否则角标一上来就爆）",
  first.badgeCount === 0, `badgeCount=${first.badgeCount} flags=${JSON.stringify(first.map)}`);

/* 2. 有新回答到达（往 JSONL 追加一条消息）→ 变成 unseen
      注意 pi 的 SessionInfo.modified 取的是**会话内消息的时间戳**
      （lastActivityTime），不是文件 mtime，所以这里必须真的追加一条消息。 */
const later = new Date(Date.now() + 1500).toISOString();
const extra = JSON.stringify({
  type: "message", id: "bbb-late", parentId: null, timestamp: later,
  message: { role: "assistant", content: [{ type: "text", text: "刚跑完的新回答" }], timestamp: later },
});
await appendFile(fileB, extra + "\n");
const second = await flagsOf();
check("新回答到达后该会话标为 unseen", second.map.bbb === "unseen", JSON.stringify(second.map));
check("没有变化的旧会话仍是已查看", second.map.aaa === null, JSON.stringify(second.map));
check("角标数 = 未查看会话数", second.badgeCount === 1, `badgeCount=${second.badgeCount}`);

/* 3. 标记已查看 → 角标清掉（markViewed 记「此刻」，必须晚于上面那条消息） */
await new Promise((r) => setTimeout(r, 1600));
await call("markViewed", { projectPath: np, sessionId: "bbb" });
const third = await flagsOf();
check("markViewed 后该会话不再是 unseen", third.map.bbb === null, JSON.stringify(third.map));
check("markViewed 后角标归零", third.badgeCount === 0, `badgeCount=${third.badgeCount}`);

/* 4. listProjects 口径与 listSessions 一致 */
const projects = await call("listProjects");
const projInfo = (projects.result?.projects || []).find((p) => p.path === np);
check("listProjects 的 badgeCount 与 listSessions 一致",
  projInfo?.badgeCount === third.badgeCount, `${projInfo?.badgeCount} vs ${third.badgeCount}`);
check("listProjects 仍提供 sessionCount（历史总数，供调试）",
  projInfo?.sessionCount === 2, `sessionCount=${projInfo?.sessionCount}`);

await finish(fail === 0 ? 0 : 1);
