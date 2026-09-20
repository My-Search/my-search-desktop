/**
 * pi-agent 发送按钮「运行态恢复」回归测试（真实浏览器 + 真实插件 UI 文件 + mock 后端）。
 *
 * 覆盖用户反馈场景：A 会话 agent 运行中 → 切到 B 会话 → 再切回 A：
 *   1. 首屏加载时，后端标记为「进行中」的会话，切回后发送按钮应恢复为「停止」；
 *   2. 在 A 发消息后（agent 运行中），切到 B：按钮为「发送」（不误显示 A 的停止态）；
 *   3. 切回 A：按钮恢复为「停止」，打字指示器重新出现；
 *   4. agent 完成（chat:status idle）后：按钮回到「发送」，状态点更新；
 *   5. 在 A 运行中切到 B，B 也能正常发送（互不干扰）。
 *
 * 夹具是自包含生成的（test/_tmp/pi-send-btn-harness.html），不依赖其它测试的产物。
 * 用法: node test/pi-agent-send-btn.test.mjs
 */
import { createServer } from "http";
import { readFile, rm, writeFile, mkdir } from "fs/promises";
import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = path.join(root, "plugins", "pi-agent", "ui");
const tmpDir = path.join(root, "test", "_tmp");
await mkdir(tmpDir, { recursive: true });

/* ---------------- 夹具：近似宿主环境 + mock 后端（chat 挂起，由测试手动触发完成） ---------------- */
const harness = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>pi-agent send button harness</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: #fff; }
  #my_search_box { position: relative; border: 2px solid #cecece; width: 100%; background: #fff; }
  #searchBox { height: 44px; background: #fff; padding: 0 10px; display: flex; align-items: center; }
  #text_show { padding: 10px 16px 16px; max-height: 510px; overflow-y: auto; overflow-x: hidden; box-sizing: border-box; }
  #text_show .plugin-view { margin: -10px -16px -16px; }
</style>
</head>
<body>
<div id="my_search_box">
  <div id="searchBox"><input id="my_search_input" value="AI"></div>
  <div id="my_search_view">
    <div id="text_show">
      <div class="plugin-view" id="plugin-host"></div>
    </div>
  </div>
</div>
<script type="module">
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const files = await (await fetch("/api/plugin-files")).json();

const style = document.createElement("style");
style.textContent = files.css;
document.head.appendChild(style);

const host = document.getElementById("plugin-host");
host.innerHTML = files.html;

/* ---------------- mock 后端 ---------------- */
const notifications = new Map();
const calls = [];
const emit = (method, params) => {
  for (const fn of notifications.get(method) || []) fn(params);
};

/* 两个会话：s1 = 「进行中」（第一次 listSessions 就带 running 标记），s2 = 空闲 */
const sessionStore = {
  s1: { id: "s1", title: "会话A", messageCount: 4, flag: "running", updatedAt: "2026-01-02T10:00:00.000Z", file: "f1" },
  s2: { id: "s2", title: "会话B", messageCount: 2, flag: null, updatedAt: "2026-01-01T10:00:00.000Z", file: "f2" },
};
const transcripts = {
  s1: [
    { role: "user", content: "A 的旧提问" },
    { role: "assistant", content: "A 的旧回答" },
    { role: "user", content: "A 的新提问（跑起来了）" },
    { role: "assistant", content: "A 还在思考…" },
  ],
  s2: [
    { role: "user", content: "B 的旧提问" },
    { role: "assistant", content: "B 的旧回答" },
  ],
};
/** 手动控制 chat 何时 resolve */
let pendingChatResolvers = [];

const backend = {
  async call(method, params) {
    calls.push({ method, params });
    await sleep(15);
    switch (method) {
      case "init": return { ok: true, hasPi: true };
      case "listModels": return { models: [{ provider: "MAG", id: "lite", name: "Lite", available: true }], defaultModel: "MAG:lite" };
      case "getConfig": return { config: {} };
      case "setConfig": return { ok: true };
      case "listProjects": return { projects: [{ id: "p1", name: "项目一", path: "D:/data/proj1", badgeCount: 0, sessionCount: 2, lastOpenedAt: "2026-01-02T10:00:00.000Z" }] };
      case "listSessions": return { sessions: [sessionStore.s1, sessionStore.s2].map((s) => ({ ...s })), badgeCount: 0 };
      case "loadSession": return { transcript: transcripts[params.sessionId] || [] };
      case "markViewed": return { ok: true };
      case "chat": {
        // 挂起：登记 resolver，测试手动触发 chat:status 完成
        return await new Promise((resolve) => {
          pendingChatResolvers.push(() => resolve({ content: "完成后的回答" }));
        });
      }
      case "abort": return { ok: true };
      default: return null;
    }
  },
  onNotification(method, handler) {
    if (!notifications.has(method)) notifications.set(method, new Set());
    notifications.get(method).add(handler);
    return () => notifications.get(method)?.delete(handler);
  },
  offNotification() {},
  _clearNotifications() { notifications.clear(); },
};

window.ms = {
  backend,
  log() {},
  ui: { confirm: async () => true, toast() {} },
  store: { get: async () => null, set: async () => true },
};

const fn = new Function(
  "ms", "env", "plugin", "host", "keyword", "inputValue", "onSubKeyword", "md2html", "openExternal",
  '"use strict";' + String.fromCharCode(10) + files.js + String.fromCharCode(10)
);
fn(window.ms, window.ms, { id: "com.mysearch.pi-agent", name: "Pi Agent", version: "2.1.0" },
  host, "AI", "", () => {}, (raw) => String(raw == null ? "" : raw), () => {});

window.__calls = calls;
window.__emit = emit;
window.__finishChat = () => { const list = pendingChatResolvers; pendingChatResolvers = []; list.forEach((r) => r()); };
window.__ready = true;
</script>
</body>
</html>`;
await writeFile(path.join(tmpDir, "pi-send-btn-harness.html"), harness, "utf8");

/* ---------------- 静态服务器 ---------------- */
const server = createServer(async (req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  try {
    if (u === "/" || u === "/pi-send-btn-harness.html") {
      const body = await readFile(path.join(tmpDir, "pi-send-btn-harness.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(body);
    }
    if (u === "/api/plugin-files") {
      const [html, css, js] = await Promise.all([
        readFile(path.join(pluginDir, "detail.html"), "utf8"),
        readFile(path.join(pluginDir, "detail.css"), "utf8"),
        readFile(path.join(pluginDir, "index.js"), "utf8"),
      ]);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ html, css, js }));
    }
    res.writeHead(404).end("not found");
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

/* ---------------- 浏览器 ---------------- */
const candidates = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];
const bin = candidates.find((p) => existsSync(p));
if (!bin) {
  console.log("未找到浏览器，跳过");
  server.close();
  process.exit(0);
}

const userDir = path.join(root, "test", "_chrome-profile-pi-sendbtn");
await rm(userDir, { recursive: true, force: true });
const chrome = spawn(bin, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--window-size=880,700",
  "--remote-debugging-port=0",
  `--user-data-dir=${userDir}`,
  "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });

const wsUrl = await new Promise((resolve, reject) => {
  let buf = "";
  const t = setTimeout(() => reject(new Error("浏览器启动超时")), 20000);
  chrome.stderr.on("data", (d) => {
    buf += d.toString();
    const m = buf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (m) { clearTimeout(t); resolve(m[1]); }
  });
});

const ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
const pageErrors = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === "Runtime.exceptionThrown") {
    pageErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  }
};
function S(method, params = {}, sessionId) {
  return new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
  });
}
const { result: targets } = await S("Target.getTargets");
const pageTarget = targets.targetInfos.find((t) => t.type === "page");
const { result: { sessionId } } = await S("Target.attachToTarget", { targetId: pageTarget.targetId, flatten: true });
await S("Runtime.enable", {}, sessionId);
await S("Page.enable", {}, sessionId);

const evalJs = async (expr) => {
  const r = await S("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.result?.exceptionDetails) {
    throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails).slice(0, 500));
  }
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(expr, timeout = 10000, step = 25) {
  const t0 = Date.now();
  for (;;) {
    if (await evalJs(expr)) return true;
    if (Date.now() - t0 > timeout) return false;
    await sleep(step);
  }
}

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("PASS ", name, extra ? ` — ${extra}` : ""); }
  else { fail++; console.log("FAIL ", name, extra ? ` — ${extra}` : ""); }
};
/** 读取发送按钮关键状态 */
const btnState = () => evalJs(`JSON.stringify((() => {
  const b = document.getElementById('pi-send-btn');
  return { running: b.classList.contains('running'), title: b.title, disabled: b.disabled };
})())`).then(JSON.parse);
/** 点击会话列表里的某条会话 */
const clickSession = (title) => evalJs(`(() => {
  const item = [...document.querySelectorAll('#pi-session-list .session-item')]
    .find(i => (i.querySelector('.session-title')?.textContent || '').includes(${JSON.stringify(title)}));
  if (item) item.click();
  return !!item;
})(); 1`);

await S("Page.navigate", { url: base + "/pi-send-btn-harness.html" }, sessionId);

/* ============ 1. 首屏：恢复保存的会话不崩溃，默认展示（无 savedState → 第一个会话 s1） ============ */
await waitFor(`document.querySelectorAll('#pi-session-list .session-item').length >= 2`, 10000);
check("会话列表加载出 2 条", (await evalJs(`document.querySelectorAll('#pi-session-list .session-item').length`)) === 2);

// s1 是 running 标记 → 列表里应有「进行中」状态
const listFlags = JSON.parse(await evalJs(`JSON.stringify([...document.querySelectorAll('#pi-session-list .session-item')].map((it) => ({
  title: it.querySelector('.session-title')?.textContent || '',
  dot: it.querySelector('.status-dot')?.className || '',
})))`));
check("会话A 显示「进行中」状态点（后端 flag 生效）",
  listFlags.some((f) => f.title.includes("会话A") && f.dot.includes("running")), JSON.stringify(listFlags));

/* ============ 2. 点开正在运行的会话A → 发送按钮应为「停止」 ============ */
await clickSession("会话A");
await sleep(600);
const onA1 = await btnState();
check("切到运行中的会话A后按钮是「停止」态", onA1.running === true && onA1.title === "停止 Agent", JSON.stringify(onA1));
check("打开运行中会话时打字指示器出现（agent 仍在跑）",
  (await evalJs(`!!document.getElementById('pi-typing-indicator')`)) === true);

/* ============ 3. 切到空闲会话B → 按钮应回到「发送」 ============ */
await clickSession("会话B");
await sleep(600);
const onB = await btnState();
check("切到空闲会话B后按钮是「发送」态（不残留 A 的停止态）", onB.running === false && onB.title === "发送消息", JSON.stringify(onB));

/* ============ 4. 切回 A → 按钮恢复「停止」，打字指示器恢复 ============ */
await clickSession("会话A");
await sleep(600);
const onA2 = await btnState();
check("切回运行中的会话A后按钮恢复「停止」态 ★核心场景", onA2.running === true && onA2.title === "停止 Agent", JSON.stringify(onA2));
check("切回后打字指示器恢复出现",
  (await evalJs(`!!document.getElementById('pi-typing-indicator')`)) === true);

/* ============ 5. A 运行中，切到 B 并发送消息 → B 也能正常进入运行态 ============ */
await clickSession("会话B");
await sleep(400);
await evalJs(`(() => {
  const el = document.getElementById('pi-input');
  el.value = 'B 里发的新消息';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('pi-send-btn').click();
})(); 1`);
await sleep(600);
const onB2 = await btnState();
check("B 发送后按钮进入「停止」态（两个会话可独立运行）", onB2.running === true, JSON.stringify(onB2));
check("B 的消息已上屏",
  (await evalJs(`[...document.querySelectorAll('#pi-chat-body .message.user')].some((m) => (m.textContent || '').includes('B 里发的新消息'))`)) === true);

/* ============ 6. 切回 A 再切回 B：B 仍是停止态（账本按会话记录） ============ */
await clickSession("会话A");
await sleep(500);
const backA = await btnState();
check("回 A 后按钮仍是「停止」", backA.running === true, JSON.stringify(backA));
await clickSession("会话B");
await sleep(500);
const backB = await btnState();
check("再回 B 后按钮仍是「停止」（B 的运行态未丢）", backB.running === true, JSON.stringify(backB));

/* ============ 7. agent 完成（chat:status idle）：按钮回「发送」，B 状态点更新 ============ */
await evalJs(`window.__emit('chat:status', { sessionId: 's2', status: 'idle' }); 1`);
await evalJs(`window.__finishChat(); 1`);
await sleep(700);
const afterIdle = await btnState();
check("B 完成后按钮回「发送」态", afterIdle.running === false && afterIdle.title === "发送消息", JSON.stringify(afterIdle));
check("B 完成后不再显示打字指示器",
  (await evalJs(`!!document.getElementById('pi-typing-indicator')`)) === false);

/* ============ 8. A 完成（idle）后，切回 A 按钮不再是停止 ============ */
await evalJs(`window.__emit('chat:status', { sessionId: 's1', status: 'idle' }); 1`);
await sleep(400);
await clickSession("会话A");
await sleep(500);
const aIdle = await btnState();
check("A 完成后切回 A，按钮为「发送」态（运行态已清除）", aIdle.running === false && aIdle.title === "发送消息", JSON.stringify(aIdle));

/* ============ 9. 无 JS 报错 ============ */
check("页面无未捕获异常", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
try { ws.close(); } catch { /* ignore */ }
chrome.kill();
server.close();
await rm(userDir, { recursive: true, force: true }).catch(() => {});
process.exit(fail === 0 ? 0 : 1);
