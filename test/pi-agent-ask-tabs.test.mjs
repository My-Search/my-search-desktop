/**
 * pi-agent「ask 卡片多问题标签页」回归测试（真实浏览器 + 真实插件 UI 文件 + mock 后端）。
 *
 * 覆盖本次改动：
 *   A. 多问题时生成标签条：每题一个可点标签 + 右侧「N / M」计数；
 *      同一时刻只有一个 .pi-ask-q 可见。
 *   B. 点标签直接跳题，高亮与计数跟随；已作答的题标签带 .done 标记。
 *   C. 提交校验：多问题必须**全部作答**才能提交（单问题维持「任一即可」）。
 *   D. 提交后 askAnswer 载荷包含**全部**问题的答案（顺序/取值正确）。
 *   E. 切走再切回：卡片恢复，且停在切走时的那一题；已选项与输入文本保留。
 *
 * 用法: node test/pi-agent-ask-tabs.test.mjs
 * 需本机装有 Chrome / Edge，否则跳过。
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

/* ---------------- 夹具：近似宿主环境 + mock 后端 ---------------- */
const harness = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>pi-agent ask tabs harness</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: #fff; }
  #my_search_box { position: relative; border: 2px solid #cecece; width: 100%; background: #fff; }
  #searchBox { height: 44px; background: #fff; padding: 0 10px; display: flex; align-items: center; }
  #text_show { padding: 10px 16px 16px; max-height: 560px; overflow-y: auto; overflow-x: hidden; box-sizing: border-box; }
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
const emit = (method, params) => { for (const fn of notifications.get(method) || []) fn(params); };

const sessions = [
  { id: "s1", title: "会话一", messageCount: 2, flag: null, updatedAt: "2026-01-02T10:00:00.000Z", file: "f1" },
  { id: "s2", title: "会话二", messageCount: 0, flag: null, updatedAt: "2026-01-01T10:00:00.000Z", file: "f2" },
];
const transcripts = { s1: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello", durationMs: 10 }], s2: [] };

/** 后端「待回答的 ask」：按会话存最近一次 chat:ask 的载荷 */
const pendingBySession = {};
/** 测试侧可断言的调用记录 */
window.__asks = [];

const backend = {
  async call(method, params) {
    await sleep(10);
    switch (method) {
      case "init": return { ok: true, hasPi: true };
      case "listModels": return { models: [{ provider: "MAG", id: "lite", name: "Lite", available: true }], defaultModel: "MAG:lite" };
      case "getConfig": return { config: {} };
      case "setConfig": return { ok: true };
      case "listProjects": return { projects: [{ id: "p1", name: "项目一", path: "D:/data/proj1", badgeCount: 0, runningCount: 0, unseenCount: 0, sessionCount: 2, lastOpenedAt: "2026-01-02T10:00:00.000Z" }] };
      case "listSessions": return { sessions, badgeCount: 0 };
      case "createSession": return { session: { id: "new", title: "新对话" } };
      case "loadSession": return { transcript: transcripts[params.sessionId] || [] };
      case "markViewed": return { ok: true };
      case "setActiveSession": return { ok: true };
      case "getSessionStatus": return { running: false };
      case "getAskCounts": return { counts: {} };
      case "getPendingAsk": {
        const p = pendingBySession[params.sessionId];
        return { pendingAsk: p ? { toolCallId: p.toolCallId, questions: p.questions, createdAt: Date.now() } : null };
      }
      case "askAnswer": {
        window.__asks.push({ method: "askAnswer", params });
        delete pendingBySession[findSessionByToolCall(params.toolCallId)];
        return { ok: true, handled: true };
      }
      case "askCancel": {
        window.__asks.push({ method: "askCancel", params });
        delete pendingBySession[findSessionByToolCall(params.toolCallId)];
        return { ok: true };
      }
      case "chat": return { content: "ok" };
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
};
function findSessionByToolCall(toolCallId) {
  for (const [sid, p] of Object.entries(pendingBySession)) if (p.toolCallId === toolCallId) return sid;
  return "";
}

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
fn(window.ms, window.ms, { id: "com.mysearch.pi-agent", name: "Pi Agent", version: "2.7.1" },
  host, "AI", "", () => {}, (raw) => String(raw == null ? "" : raw), () => {});

/** 测试侧：注入一次 chat:ask（同时在后端记下 pending，供 getPendingAsk 恢复） */
window.__ask = (sessionId, toolCallId, questions) => {
  const params = { sessionId, projectPath: "D:/data/proj1", toolCallId, toolName: "ask", questions };
  pendingBySession[sessionId] = params;
  emit("chat:ask", params);
};
window.__ready = true;
</script>
</body>
</html>`;
await writeFile(path.join(tmpDir, "pi-ask-tabs-harness.html"), harness, "utf8");

/* ---------------- 静态服务器 ---------------- */
const server = createServer(async (req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  try {
    if (u === "/" || u === "/pi-ask-tabs-harness.html") {
      const body = await readFile(path.join(tmpDir, "pi-ask-tabs-harness.html"));
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

const userDir = path.join(root, "test", "_chrome-profile-pi-ask-tabs");
await rm(userDir, { recursive: true, force: true });
const debugPort = 9222 + Math.floor(Math.random() * 500);
const chrome = spawn(
  bin,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=880,700",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDir}`,
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] }
);

const fetchText = (url) =>
  new Promise((resolve, reject) => {
    import("http").then(({ get }) => {
      get(url, (res) => { let s = ""; res.on("data", (d) => (s += d)); res.on("end", () => resolve(s)); }).on("error", reject);
    });
  });

const wsUrl = await new Promise((resolve, reject) => {
  let buf = "";
  const deadline = Date.now() + 20000;
  const poll = async () => {
    const m = buf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (m) return resolve(m[1]);
    try {
      const v = JSON.parse(await fetchText(`http://127.0.0.1:${debugPort}/json/version`));
      if (v.webSocketDebuggerUrl) return resolve(v.webSocketDebuggerUrl);
    } catch { /* 还没起来，继续轮询 */ }
    if (Date.now() > deadline) return reject(new Error("浏览器启动超时"));
    setTimeout(poll, 300);
  };
  chrome.stderr.on("data", (d) => { buf += d.toString(); });
  poll();
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
async function waitFor(expr, timeout = 8000, step = 25) {
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

await S("Page.navigate", { url: base + "/pi-ask-tabs-harness.html" }, sessionId);
await sleep(1500);
check("夹具加载（插件 UI 已挂载）", await evalJs(`!!document.querySelector('.pi-agent-container')`));
check("默认会话 s1 已打开", await evalJs(`!!document.querySelector('.session-item.active[data-session-id="s1"]')`));

/* ============ A. 注入 3 个问题的 ask：标签条 + 只显示一题 ============ */
const questions = [
  { id: "goal", header: "目标", question: "这次重构的目标是什么？", options: [{ label: "性能" }, { label: "可读性" }, { label: "扩展性", recommended: true }] },
  { id: "scope", header: "范围", question: "改动涉及哪些部分？", multi: true, options: [{ label: "前端" }, { label: "后端" }, { label: "测试" }] },
  { id: "style", header: "备注", question: "还有别的补充要求吗？" },
];
await evalJs(`window.__ask("s1", "tc-ask-1", ${JSON.stringify(questions)}); 1`);
check("ask 卡片已出现", await waitFor(`!!document.querySelector('.pi-ask-card')`));

const snap = () => evalJs(`JSON.stringify((() => {
  const card = document.querySelector('.pi-ask-card');
  if (!card) return null;
  const tabs = [...card.querySelectorAll('.pi-ask-tab')];
  const panels = [...card.querySelectorAll('.pi-ask-q')];
  const sub = card.querySelector('.pi-ask-btn.primary');
  return {
    tabTexts: tabs.map(t => t.textContent),
    tabSelected: tabs.map(t => t.classList.contains('selected')),
    tabDone: tabs.map(t => t.classList.contains('done')),
    count: card.querySelector('.pi-ask-tabs-count')?.textContent || '',
    panelHidden: panels.map(p => p.hidden === true),
    visiblePanels: panels.filter(p => p.hidden !== true).length,
    submitDisabled: !!sub && sub.disabled,
    hasTabsBar: !!card.querySelector('.pi-ask-tabs'),
    navTexts: [...card.querySelectorAll('.pi-ask-nav .pi-ask-btn')].map(b => b.textContent),
    prevDisabled: !!card.querySelector('.pi-ask-nav .pi-ask-btn')?.disabled,
    nextDisabled: (() => { const b = card.querySelectorAll('.pi-ask-nav .pi-ask-btn'); return b.length ? b[b.length - 1].disabled : null; })(),
  };
})())`);

let s = JSON.parse(await snap());
check("生成了标签条", s.hasTabsBar === true);
check("标签数量 = 问题数 3", s.tabTexts.length === 3, JSON.stringify(s.tabTexts));
check("标签用 header 命名", JSON.stringify(s.tabTexts) === JSON.stringify(["目标", "范围", "备注"]), JSON.stringify(s.tabTexts));
check("同一时刻只显示一题", s.visiblePanels === 1 && s.panelHidden.filter(Boolean).length === 2, JSON.stringify(s.panelHidden));
check("默认停在第 1 题", s.tabSelected[0] === true && s.tabSelected[1] === false && s.panelHidden[0] === false);
check("计数显示 1 / 3", s.count.trim() === "1 / 3", JSON.stringify(s.count));
check("多问题初始「提交」禁用", s.submitDisabled === true);

/* ============ B. 点标签跳题 ============ */
await evalJs(`document.querySelectorAll('.pi-ask-tab')[1].click(); 1`);
await sleep(80);
s = JSON.parse(await snap());
check("点第 2 个标签 → 第 2 题显示", s.tabSelected[1] === true && s.panelHidden[1] === false && s.visiblePanels === 1, JSON.stringify(s.panelHidden));
check("计数跳到 2 / 3", s.count.trim() === "2 / 3", JSON.stringify(s.count));

/* ============ B2. 上一项 / 下一项 翻页按钮 ============ */
check("底部有「上一项 / 下一项」按钮", JSON.stringify(s.navTexts) === JSON.stringify(["← 上一项", "下一项 →"]), JSON.stringify(s.navTexts));
check("非首题时「上一项」可用", s.prevDisabled === false);
check("中间题「下一项」可用", s.nextDisabled === false);
await evalJs(`(() => { const b = document.querySelectorAll('.pi-ask-nav .pi-ask-btn'); b[b.length - 1].click(); return 1; })()`);
await sleep(60);
s = JSON.parse(await snap());
check("点「下一项」→ 第 3 题且计数 3 / 3", s.tabSelected[2] === true && s.count.trim() === "3 / 3", JSON.stringify(s.count));
check("末题「下一项」禁用", s.nextDisabled === true);
await evalJs(`document.querySelector('.pi-ask-nav .pi-ask-btn').click(); 1`);
await sleep(60);
s = JSON.parse(await snap());
check("点「上一项」→ 回到第 2 题", s.tabSelected[1] === true && s.count.trim() === "2 / 3", JSON.stringify(s.count));

/* ============ C. 作答 + 自动进下一题 + done 标记 + 提交校验 ============ */
// q1：单选 —— 点选后应自动跳到第 2 题
await evalJs(`document.querySelectorAll('.pi-ask-tab')[0].click(); 1`);
await sleep(60);
await evalJs(`(() => { const p = document.querySelectorAll('.pi-ask-q')[0]; p.querySelectorAll('.pi-ask-option')[1].click(); return 1; })()`);
await sleep(60);
s = JSON.parse(await snap());
check("单选作答后该题标签带 done 标记", s.tabDone[0] === true && s.tabDone[1] === false, JSON.stringify(s.tabDone));
check("★ 单选作答后自动跳到下一题（第 2 题）", s.tabSelected[1] === true && s.panelHidden[1] === false, JSON.stringify(s.tabSelected));
check("只答了 1/3 题，「提交」仍禁用", s.submitDisabled === true);

// q2：多选（前端 + 后端）—— 多选不自动跳，勾完仍停在第 2 题
await evalJs(`(() => { const p = document.querySelectorAll('.pi-ask-q')[1]; const o = p.querySelectorAll('.pi-ask-option'); o[0].click(); o[1].click(); return 1; })()`);
await sleep(60);
s = JSON.parse(await snap());
check("多选作答后标签带 done", s.tabDone[0] === true && s.tabDone[1] === true && s.tabDone[2] === false, JSON.stringify(s.tabDone));
check("多选不自动跳题（仍停在第 2 题）", s.tabSelected[1] === true, JSON.stringify(s.tabSelected));
check("2/3 题作答，「提交」仍禁用", s.submitDisabled === true);

// q3：输入框 —— 回车应同样自动前进（此处已是末题，故停在原地）
await evalJs(`document.querySelectorAll('.pi-ask-tab')[2].click(); 1`);
await sleep(60);
await evalJs(`(() => { const i = document.querySelectorAll('.pi-ask-q')[2].querySelector('input.pi-ask-input'); i.value = '记得补测试'; i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
await sleep(60);
s = JSON.parse(await snap());
check("3/3 题作答后标签全 done", s.tabDone.every(Boolean), JSON.stringify(s.tabDone));
check("全部作答后「提交」可用", s.submitDisabled === false);

/* ============ E. 切走再切回：卡片恢复且停在原题 ============ */
// 当前停在第 3 题（index 2）。切到 s2 再切回 s1。
await evalJs(`document.querySelector('.session-item[data-session-id="s2"]').click(); 1`);
check("切到 s2 后 s1 的 ask 卡片不再显示", await waitFor(`!document.querySelector('.pi-ask-card')`));
await evalJs(`document.querySelector('.session-item[data-session-id="s1"]').click(); 1`);
check("切回 s1 后卡片恢复", await waitFor(`!!document.querySelector('.pi-ask-card')`));
await sleep(200);
s = JSON.parse(await snap());
check("切回停回切走时的那一题（第 3 题）", s.tabSelected[2] === true && s.panelHidden[2] === false && s.visiblePanels === 1, JSON.stringify(s.panelHidden));
check("切回后计数为 3 / 3", s.count.trim() === "3 / 3", JSON.stringify(s.count));
check("切回后各题已答状态保留（标签全 done）", s.tabDone.every(Boolean), JSON.stringify(s.tabDone));
check("切回后输入框文本保留", (await evalJs(`document.querySelectorAll('.pi-ask-q')[2].querySelector('input.pi-ask-input').value`)) === "记得补测试");
check("切回后「提交」可用", s.submitDisabled === false);

/* ============ D. 提交：askAnswer 载荷含全部 3 题答案 ============ */
await evalJs(`document.querySelector('.pi-ask-card .pi-ask-btn.primary').click(); 1`);
check("提交后卡片移除", await waitFor(`!document.querySelector('.pi-ask-card')`));
// 后端 call 是异步的（mock 里 await sleep 后才记录），等它落账再断言，避免竞态
await waitFor(`Array.isArray(window.__asks) && window.__asks.some(a => a.method === 'askAnswer')`);
const asks = JSON.parse(await evalJs(`JSON.stringify(window.__asks)`));
const answered = asks.find((a) => a.method === "askAnswer");
check("确实发起了 askAnswer", !!answered, JSON.stringify(asks.map((a) => a.method)));
const ans = answered?.params?.answers || [];
check("askAnswer 带 3 条答案（不再只取第一条）", ans.length === 3, JSON.stringify(ans));
check("答案内容与顺序正确",
  JSON.stringify(ans.map((a) => `${a.id}=${a.value}`)) === JSON.stringify(["goal=可读性", "scope=前端、后端", "style=记得补测试"]),
  JSON.stringify(ans.map((a) => `${a.id}=${a.value}`)));

/* ============ F. 单问题不生成标签条（与从前一致） ============ */
await evalJs(`window.__ask("s1", "tc-ask-2", [{ id: "one", question: "只有一个问题", options: [{ label: "A" }, { label: "B" }] }]); 1`);
check("单问题卡片出现", await waitFor(`!!document.querySelector('.pi-ask-card')`));
const single = JSON.parse(await snap());
check("单问题不生成标签条", single.hasTabsBar === false);
check("单问题面板不受 hidden 影响", single.visiblePanels === 1 && single.panelHidden[0] === false);
check("单问题未作答时「提交」禁用", single.submitDisabled === true);
await evalJs(`document.querySelectorAll('.pi-ask-q')[0].querySelectorAll('.pi-ask-option')[0].click(); 1`);
await sleep(60);
const single2 = JSON.parse(await snap());
check("单问题答一题即可提交（维持宽松）", single2.submitDisabled === false);

/* ============ 无 JS 报错 ============ */
check("页面无未捕获异常", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
ws.close();
chrome.kill();
server.close();
process.exit(fail === 0 ? 0 : 1);
