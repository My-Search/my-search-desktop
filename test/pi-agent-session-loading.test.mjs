/**
 * pi-agent 会话列表「加载中」占位回归测试（真实浏览器 + 真实插件 UI 文件 + mock 后端）。
 *
 * 覆盖本次需求：会话菜单（中间栏会话列表）加载未完成时显示「加载中…」，
 * 而不是闪一下「暂无历史会话」空态。
 *   1. 首屏初始化（后端 init / listSessions 尚未返回）期间：中间栏显示「加载中…」占位；
 *   2. 会话列表加载完成后：占位消失，会话正常渲染；
 *   3. 切换项目：先显示「加载中…」，再渲染新项目的会话列表。
 *
 * 夹具是自包含生成的（test/_tmp/pi-session-loading-harness.html），不依赖其它测试的产物。
 * 用法: node test/pi-agent-session-loading.test.mjs
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

/* ---------------- 夹具：近似宿主环境 + mock 后端（可配置延迟，便于观察加载态） ---------------- */
const harness = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>pi-agent session loading harness</title>
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

/* ---------------- mock 后端（可通过 __setDelays 调整响应延迟） ---------------- */
const notifications = new Map();
const calls = [];
let delays = { init: 800, listSessions: 700, base: 20 };

const projects = [
  { id: "p1", name: "项目一", path: "D:/data/proj1", badgeCount: 0, sessionCount: 2, lastOpenedAt: "2026-01-02T10:00:00.000Z" },
  { id: "p2", name: "项目二", path: "D:/data/proj2", badgeCount: 0, sessionCount: 1, lastOpenedAt: "2026-01-01T10:00:00.000Z" },
];
const sessionsByProject = {
  "D:/data/proj1": [
    { id: "s1", title: "会话一A", messageCount: 2, flag: null, updatedAt: "2026-01-02T10:00:00.000Z", file: "f1" },
    { id: "s2", title: "会话一B", messageCount: 2, flag: null, updatedAt: "2026-01-01T10:00:00.000Z", file: "f2" },
  ],
  "D:/data/proj2": [
    { id: "s3", title: "会话二A", messageCount: 2, flag: null, updatedAt: "2026-01-03T10:00:00.000Z", file: "f3" },
  ],
};

const backend = {
  async call(method, params) {
    calls.push({ method, params });
    if (method === "init") await sleep(delays.init);
    else if (method === "listSessions") await sleep(delays.listSessions);
    else await sleep(delays.base);
    switch (method) {
      case "init": return { ok: true, hasPi: true };
      case "listModels": return { models: [{ provider: "MAG", id: "lite", name: "Lite", available: true }], defaultModel: "MAG:lite" };
      case "getConfig": return { config: {} };
      case "setConfig": return { ok: true };
      case "listProjects": return { projects };
      case "listSessions": return { sessions: (params && sessionsByProject[params.projectPath]) || [], badgeCount: 0 };
      case "loadSession": return { transcript: [
        { role: "user", content: "你好" }, { role: "assistant", content: "你好，我是 Pi" },
      ] };
      case "markViewed": return { ok: true };
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
window.__setDelays = (d) => { delays = Object.assign(delays, d); };
window.__ready = true;
</script>
</body>
</html>`;
await writeFile(path.join(tmpDir, "pi-session-loading-harness.html"), harness, "utf8");

/* ---------------- 静态服务器 ---------------- */
const server = createServer(async (req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  try {
    if (u === "/" || u === "/pi-session-loading-harness.html") {
      const body = await readFile(path.join(tmpDir, "pi-session-loading-harness.html"));
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

const userDir = path.join(root, "test", "_chrome-profile-pi-loading");
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
/** 轮询等待浏览器端表达式为真 */
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

await S("Page.navigate", { url: base + "/pi-session-loading-harness.html" }, sessionId);

/* ============ 1. 首屏加载期间：显示「加载中…」占位 ============ */
// 占位应在后端响应回来前就出现（init / listSessions 都有数百毫秒延迟）
const sawLoading = await waitFor(`!!document.querySelector('#pi-session-list .pi-sessions-loading')`, 6000);
check("首屏加载期间出现「加载中…」占位", sawLoading === true);

const initial = JSON.parse(await evalJs(`JSON.stringify((() => {
  const el = document.querySelector('#pi-session-list .pi-sessions-loading');
  const dot = document.querySelector('#pi-session-list .pi-loading-dot');
  return {
    present: !!el,
    text: el ? el.textContent : '',
    dot: !!dot,
    dotAnim: dot ? getComputedStyle(dot).animationName : '',
    items: document.querySelectorAll('#pi-session-list .session-item').length,
  };
})())`));
check("占位文案包含「加载中」", initial.present && initial.text.includes("加载中"), JSON.stringify(initial.text));
check("加载期间没有误渲染会话条目 / 空态文案", initial.items === 0 && !initial.text.includes("暂无历史会话"), JSON.stringify(initial));
check("占位带脉冲动画点（样式已生效）", initial.dot === true && /pi-pulse/.test(initial.dotAnim || ""), initial.dotAnim);

/* ============ 2. 加载完成后：占位消失、会话正常渲染 ============ */
const loaded = await waitFor(`document.querySelectorAll('#pi-session-list .session-item').length > 0`, 12000);
check("会话列表加载完成后渲染出条目", loaded === true, `items=${await evalJs(`document.querySelectorAll('#pi-session-list .session-item').length`)}`);

const afterLoad = JSON.parse(await evalJs(`JSON.stringify((() => {
  const loading = !!document.querySelector('#pi-session-list .pi-sessions-loading');
  const items = [...document.querySelectorAll('#pi-session-list .session-item')];
  return {
    loading,
    count: items.length,
    titles: items.map((i) => {
      const t = i.querySelector('.session-title');
      return t ? t.textContent : '';
    }),
  };
})())`));
check("加载完成后「加载中…」占位消失", afterLoad.loading === false);
check("项目一的会话正常渲染（2 条）", afterLoad.count === 2 && afterLoad.titles.some((t) => t.includes("会话一A")), JSON.stringify(afterLoad.titles));

/* ============ 3. 切换项目：先显示「加载中…」，再渲染新列表 ============ */
await evalJs(`window.__setDelays({ listSessions: 800 }); 1`);
await evalJs(`(() => {
  const icons = document.querySelectorAll('#pi-project-list .project-icon');
  if (icons[1]) icons[1].click();
  return true;
})(); 1`);

const duringSwitch = JSON.parse(await evalJs(`JSON.stringify((() => {
  const el = document.querySelector('#pi-session-list .pi-sessions-loading');
  return {
    present: !!el,
    text: el ? el.textContent : '',
    items: document.querySelectorAll('#pi-session-list .session-item').length,
  };
})())`));
check("切换项目时再次显示「加载中…」", duringSwitch.present === true && duringSwitch.text.includes("加载中"), JSON.stringify(duringSwitch));
check("切换期间旧列表已清空（不残留上一个项目的会话）", duringSwitch.items === 0, `items=${duringSwitch.items}`);

const switched = await waitFor(
  `[...document.querySelectorAll('#pi-session-list .session-title')].some((e) => (e.textContent || '').includes('会话二A'))`,
  12000
);
const afterSwitch = JSON.parse(await evalJs(`JSON.stringify((() => {
  const loading = !!document.querySelector('#pi-session-list .pi-sessions-loading');
  const titles = [...document.querySelectorAll('#pi-session-list .session-title')].map((e) => e.textContent || '');
  return { loading, titles };
})())`));
check("切换完成后渲染新项目会话（会话二A）", switched === true && afterSwitch.titles.some((t) => t.includes("会话二A")), JSON.stringify(afterSwitch.titles));
check("切换完成后占位消失、旧项目会话不再显示", afterSwitch.loading === false && !afterSwitch.titles.some((t) => t.includes("会话一A")), JSON.stringify(afterSwitch.titles));

/* ============ 4. 无 JS 报错 ============ */
check("页面无未捕获异常", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
try { ws.close(); } catch { /* ignore */ }
chrome.kill();
server.close();
await rm(userDir, { recursive: true, force: true }).catch(() => {});
process.exit(fail === 0 ? 0 : 1);
