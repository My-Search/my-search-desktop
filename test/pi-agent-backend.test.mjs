/**
 * pi-agent 后端契约测试（真跑 pi SDK，不用 mock）。
 *
 * 覆盖用户报告的两个后端问题：
 *   1. 「新建会话没反应」：连点两次必须得到**两个不同的会话 id**，
 *      且新会话立刻能出现在 listSessions 里（pi 在有 assistant 消息前
 *      不落盘，后端要把它作为草稿补进列表）。
 *   2. 项目角标口径：不能再是历史会话总数（那会让角标常年 99+），
 *      改为「已完成未查看 + 进行中 + 尚未开始」。
 *
 * 用临时项目目录 + 临时 agentDir 隔离，不碰用户真实会话。
 *
 * 前置：本机装了 pi（npm i -g @earendil-works/pi-coding-agent）。
 * 用法: node test/pi-agent-backend.test.mjs
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
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

/* ---------------- 启动后端 ---------------- */
const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "pi-agent-test-"));
const dataDir = path.join(tmpRoot, "data");
const projectDir = path.join(tmpRoot, "proj");
await mkdir(dataDir, { recursive: true });
await mkdir(projectDir, { recursive: true });

const child = spawn(process.execPath, [entry], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, HOME: tmpRoot, USERPROFILE: tmpRoot },
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
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
child.stderr.on("data", () => {});

let seq = 0;
function call(method, params, timeoutMs = 180000) {
  const id = ++seq;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`超时: ${method}`)); }, timeoutMs);
    pending.set(id, (msg) => { clearTimeout(t); resolve(msg); });
  });
}
function notify(method) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
}

function done() {
  notify("deactivate");
  setTimeout(() => { try { child.kill(); } catch {} }, 300);
}

try {
  const init = await call("init", { pluginId: "com.mysearch.pi-agent", dataDir });
  if (!init.result?.hasPi) {
    console.log("跳过：本机没有可用的 pi ——", init.result?.piError || "未找到");
    done();
    await rm(tmpRoot, { recursive: true, force: true });
    process.exit(0);
  }

  // 加一个临时项目（用规范化的绝对路径，Windows 下盘符大小写要统一）
  const normalized = path.resolve(projectDir).replace(/\\/g, "\\");
  const added = await call("addProject", { path: normalized });
  check("添加项目成功", added.result?.ok === true, JSON.stringify(added.error || added.result));
  const project = added.result?.project?.path || normalized;

  /* ---------------- 新建会话 ---------------- */
  const c1 = await call("createSession", { projectPath: project, title: "新对话" });
  const c2 = await call("createSession", { projectPath: project, title: "新对话" });
  check("第一次新建返回会话", Boolean(c1.result?.session?.id), JSON.stringify(c1.result?.session || c1.error));
  check("第二次新建返回会话", Boolean(c2.result?.session?.id), JSON.stringify(c2.result?.session || c2.error));
  check("两次新建得到**不同**的会话 id（回归：曾经复用同一个）",
    c1.result?.session?.id && c2.result?.session?.id && c1.result.session.id !== c2.result.session.id,
    `${c1.result?.session?.id} vs ${c2.result?.session?.id}`);

  /* ---------------- 新建的会话要立刻可见 ---------------- */
  const listed = await call("listSessions", { projectPath: project });
  const ids = (listed.result?.sessions || []).map((s) => s.id);
  check("刚建的会话立刻出现在 listSessions（pi 未落盘也要能列出）",
    ids.includes(c2.result.session.id), `共 ${ids.length} 条`);
  const listedNew = (listed.result?.sessions || []).find((s) => s.id === c2.result.session.id);
  check("新会话被标记为 pending（尚未开始）", listedNew?.pending === true, JSON.stringify(listedNew));

  /* ---------------- 角标口径 ---------------- */
  check("listSessions 返回 badgeCount（不再用历史总数当角标）",
    typeof listed.result?.badgeCount === "number", `badgeCount=${listed.result?.badgeCount}`);
  check("角标数 ≤ 会话总数（口径是待办而不是总量）",
    listed.result.badgeCount <= listed.result.sessions.length,
    `${listed.result.badgeCount} / ${listed.result.sessions.length}`);

  const projects = await call("listProjects");
  const proj = (projects.result?.projects || []).find((p) => p.path === project);
  check("listProjects 带上 badgeCount", typeof proj?.badgeCount === "number",
    JSON.stringify({ sessionCount: proj?.sessionCount, badgeCount: proj?.badgeCount }));
  check("两个接口的角标口径一致",
    proj?.badgeCount === listed.result.badgeCount,
    `${proj?.badgeCount} vs ${listed.result.badgeCount}`);

  /* ---------------- 标记已查看 ---------------- */
  const mv = await call("markViewed", { projectPath: project, sessionId: c2.result.session.id });
  check("markViewed 调用成功", mv.result?.ok === true, JSON.stringify(mv.error || mv.result));

  /* ---------------- 打开草稿会话 ---------------- */
  const loaded = await call("loadSession", { projectPath: project, sessionId: c2.result.session.id });
  check("草稿会话能读取历史（返回空 transcript 而不是报错）",
    Array.isArray(loaded.result?.transcript) && loaded.result.transcript.length === 0,
    JSON.stringify(loaded.result || loaded.error));

  /* ---------------- 删除项目要能带走草稿 ---------------- */
  const removed = await call("removeProject", { path: project });
  check("移除项目成功", removed.result?.ok === true, JSON.stringify(removed.error || removed.result));
} catch (e) {
  fail++;
  console.log("FAIL  未捕获异常 —", String(e?.message || e));
} finally {
  done();
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
