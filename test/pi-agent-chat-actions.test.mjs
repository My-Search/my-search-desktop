/**
 * pi-agent 聊天区「ZCode 行模型」回归测试（真实浏览器 + 真实插件 UI 文件 + mock 后端）。
 *
 * 对齐参考实现 ZCode 前端（packages/ui/src/v4/ConversationRowView.tsx、
 * ToolCallBlocks/ToolSummaryRow.tsx、components/ai-elements/reasoning.tsx）：
 *   A. 一轮的工作分组（.turn-work）：运行中「工作中 N 秒」默认展开；
 *      结束「已工作 N 秒」/「已处理」；中止「已停止」；结束后收起但仍可展开回看。
 *   B. 思考是独立行（.reasoning-row）：标题「正在思考」/「思考 · 持续了 N 秒」，
 *      默认收起；流式期间标题右侧有一行摘要。
 *   C. 工具调用是单行内联摘要（.tool-row）：类别词 + 主文本 + 变更量 + 次文本；
 *      展开才看参数与结果；状态词随状态改写（正在读取 → 已读取 / 读取失败 / 已停止）。
 *   D. 既有修复不回归：toolCallId 配对不串台、纯动作无空气泡、发送按钮回「发送」态。
 *
 * 夹具是自包含生成的（test/_tmp/pi-chat-actions-harness.html），不依赖其它测试的产物。
 * 用法: node test/pi-agent-chat-actions.test.mjs
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
<title>pi-agent chat actions harness</title>
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
const emit = (method, params) => {
  for (const fn of notifications.get(method) || []) fn(params);
};

/* 会话 s1：已完成的历史轮次，含思考 / 工具调用 / 工具结果（含一条中断残留 tc3）。
   字段与后端新协议一致：assistant 带 durationMs，toolCalls 带结构化摘要。 */
const transcripts = {
  s1: [
    { role: "user", content: "帮我看看项目" },
    { role: "assistant", content: "", thinking: "先看目录结构", durationMs: 4200, toolCalls: [
      { id: "tc1", name: "read_file", label: "📖 读取文件", detail: "📄 src/index.js",
        kind: "read", primaryText: "src/index.js", secondaryText: "", changeStat: "", inputJson: '{\\n  "file_path": "src/index.js"\\n}' },
    ] },
    { role: "toolResult", toolCallId: "tc1", toolName: "read_file", isError: false, content: "文件内容 123" },
    { role: "assistant", content: "看完了，这是回答", thinking: "总结一下", durationMs: 9000, toolCalls: [
      { id: "tc2", name: "bash", label: "🖥️ 执行命令", detail: "npm test",
        kind: "execute", primaryText: "npm test", secondaryText: "", changeStat: "", inputJson: '{\\n  "command": "npm test"\\n}' },
      { id: "tc3", name: "write_file", label: "✏️ 写入文件", detail: "📄 out.txt",
        kind: "write", primaryText: "out.txt", secondaryText: "", changeStat: "", inputJson: '{\\n  "file_path": "out.txt"\\n}' },
    ] },
    { role: "toolResult", toolCallId: "tc2", toolName: "bash", isError: true, content: "command not found" },
  ],
};
let pendingChatResolvers = [];

const backend = {
  async call(method, params) {
    await sleep(15);
    switch (method) {
      case "init": return { ok: true, hasPi: true };
      case "listModels": return { models: [{ provider: "MAG", id: "lite", name: "Lite", available: true }], defaultModel: "MAG:lite" };
      case "getConfig": return { config: {} };
      case "setConfig": return { ok: true };
      case "listProjects": return { projects: [{ id: "p1", name: "项目一", path: "D:/data/proj1", badgeCount: 0, sessionCount: 1, lastOpenedAt: "2026-01-02T10:00:00.000Z" }] };
      case "listSessions": return { sessions: [{ id: "s1", title: "会话A", messageCount: 5, flag: null, updatedAt: "2026-01-02T10:00:00.000Z", file: "f1" }], badgeCount: 0 };
      case "loadSession": return { transcript: transcripts[params.sessionId] || [] };
      case "markViewed": return { ok: true };
      case "chat": {
        // 挂起：登记 resolver，测试手动触发完成
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

window.__emit = emit;
window.__finishChat = () => { const list = pendingChatResolvers; pendingChatResolvers = []; list.forEach((r) => r()); };
window.__hasPendingChat = () => pendingChatResolvers.length > 0;
window.__ready = true;
</script>
</body>
</html>`;
await writeFile(path.join(tmpDir, "pi-chat-actions-harness.html"), harness, "utf8");

/* ---------------- 静态服务器 ---------------- */
const server = createServer(async (req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  try {
    if (u === "/" || u === "/pi-chat-actions-harness.html") {
      const body = await readFile(path.join(tmpDir, "pi-chat-actions-harness.html"));
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

const userDir = path.join(root, "test", "_chrome-profile-pi-chat-actions");
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

/**
 * 读取某个「工作分组」的结构快照：
 *   分组标题文案 + 展开态 + 思考行（标题/正文/展开态）+ 工具行（类别词/主文本/变更量/展开区/状态）
 */
const READ_ACC = (i) => `JSON.stringify((function () {
  var work = document.querySelectorAll('#pi-chat-body .turn-work')[${i}];
  if (!work) return { missing: true };
  function txt(el, sel) { var n = el.querySelector(sel); return n ? n.textContent : ''; }
  var reasonings = [];
  var rrows = work.querySelectorAll('.turn-work-body > .reasoning-row');
  for (var k = 0; k < rrows.length; k++) {
    var r = rrows[k];
    var streamEl = r.querySelector('.reasoning-stream');
    reasonings.push({
      label: txt(r, '.reasoning-label'),
      meta: txt(r, '.reasoning-meta'),
      text: txt(r, '.reasoning-text'),
      open: r.open,
      settled: r.dataset.settled === '1',
      stream: (streamEl && !streamEl.hidden) ? streamEl.textContent : '',
    });
  }
  var tools = [];
  var trows = work.querySelectorAll('.turn-work-body > .tool-row');
  for (var j = 0; j < trows.length; j++) {
    var t = trows[j];
    var bodyEl = t.querySelector('.tool-row-body');
    var primEl = t.querySelector('.tool-row-primary');
    var chgEl = t.querySelector('.tool-row-change');
    // 展开区的块按标题归类：参数 / 结果 / 错误
    var blocks = { input: '', result: '', error: '' };
    var bnodes = t.querySelectorAll('.tool-block');
    for (var b = 0; b < bnodes.length; b++) {
      var titleText = txt(bnodes[b], '.tool-block-title');
      var preText = txt(bnodes[b], '.tool-block-pre');
      if (titleText === '参数') blocks.input = preText;
      else if (titleText === '错误') blocks.error = preText;
      else if (titleText === '结果') blocks.result = preText;
    }
    tools.push({
      id: t.dataset.toolId || '',
      kind: t.dataset.kind || '',
      status: t.dataset.status || '',
      kindLabel: txt(t, '.tool-row-kind'),
      primary: (primEl && !primEl.hidden) ? primEl.textContent : '',
      change: (chgEl && !chgEl.hidden) ? chgEl.textContent : '',
      secondary: txt(t, '.tool-row-secondary'),
      open: t.open,
      hasBody: !!bodyEl && !bodyEl.hidden,
      input: blocks.input,
      result: blocks.result,
      error: blocks.error,
      running: t.classList.contains('tool-running'),
      errored: t.classList.contains('tool-error'),
    });
  }
  return {
    open: work.open,
    state: work.dataset.state,
    status: txt(work, '.turn-work-status'),
    reasonings: reasonings,
    tools: tools,
  };
})())`;
const readAcc = async (i) => JSON.parse(await evalJs(READ_ACC(i)));
/** 点击某个工作分组的标题（模拟用户展开/收起） */
const clickAcc = async (i) => evalJs(`document.querySelectorAll('#pi-chat-body .turn-work')[${i}].querySelector('.turn-work-trigger').click(); 1`);
/** 点击某个工作分组里第 j 个工具行的摘要（展开看参数与结果） */
const clickToolRow = async (i, j) => evalJs(`document.querySelectorAll('#pi-chat-body .turn-work')[${i}].querySelectorAll('.turn-work-body > .tool-row')[${j}].querySelector('.tool-row-head').click(); 1`);
/** 点击某个工作分组里第 j 个思考行（展开看正文） */
const clickReasoningRow = async (i, j) => evalJs(`document.querySelectorAll('#pi-chat-body .turn-work')[${i}].querySelectorAll('.turn-work-body > .reasoning-row')[${j}].querySelector('.reasoning-trigger').click(); 1`);

await S("Page.navigate", { url: base + "/pi-chat-actions-harness.html" }, sessionId);

/* ============ Part A. 历史会话：轮次工作分组默认收起、可展开回看 ============ */
const loaded = await waitFor(`document.querySelectorAll('#pi-chat-body .turn-work').length >= 2`, 15000);
check("历史会话渲染出 2 个工作分组（两条含动作的回答）", loaded === true,
  `count=${await evalJs(`document.querySelectorAll('#pi-chat-body .turn-work').length`)}`);

const a0 = await readAcc(0), a1 = await readAcc(1);
check("历史工作分组默认收起（不遮挡正文）★需求", a0.open === false && a1.open === false,
  JSON.stringify({ open0: a0.open, open1: a1.open }));
check("历史分组标题落定为「已工作 N 秒」（由 transcript 的 durationMs 得到）",
  a0.status === "已工作 4 秒" && a1.status === "已工作 9 秒",
  JSON.stringify([a0.status, a1.status]));
check("历史分组的思考是独立行、默认收起、标题为「思考 · 持续了 N 秒」",
  a0.reasonings.length === 1 && a0.reasonings[0].label === "思考" && a0.reasonings[0].open === false
  && a0.reasonings[0].meta === "· 持续了几秒" && a0.reasonings[0].text === "先看目录结构",
  JSON.stringify(a0.reasonings));

check("历史工具行是单行摘要（类别词 + 主文本）", a0.tools.length === 1 && a0.tools[0].id === "tc1"
  && a0.tools[0].kind === "read" && a0.tools[0].kindLabel === "已读取" && a0.tools[0].primary === "src/index.js",
  JSON.stringify(a0.tools[0]));
check("历史工具行默认未展开（参数与结果先收起）", a0.tools[0].open === false,
  JSON.stringify({ open: a0.tools[0].open }));
check("历史工具行：成功结果回填到展开区", a0.tools[0].status === "success" && a0.tools[0].result === "文件内容 123",
  JSON.stringify({ status: a0.tools[0].status, result: a0.tools[0].result }));

check("历史工具行：失败调用类别词为「执行失败」、错误文本落到错误块",
  a1.tools.length === 2 && a1.tools[0].id === "tc2" && a1.tools[0].status === "error"
  && a1.tools[0].kindLabel === "执行失败" && a1.tools[0].error === "command not found",
  JSON.stringify(a1.tools[0]));
check("历史中无结果的工具调用类别词为「已停止」（不一直转圈）", a1.tools[1].id === "tc3" && a1.tools[1].status === "stopped"
  && a1.tools[1].kindLabel === "已停止" && a1.tools[1].running === false, JSON.stringify(a1.tools[1]));

const bubbles = JSON.parse(await evalJs(`JSON.stringify([...document.querySelectorAll('#pi-chat-body .message.agent')].slice(0, 2).map((m) => {
  const b = m.querySelector('.message-content');
  return { hidden: !!b.hidden, text: (b.textContent || '').slice(0, 50) };
}))`));
check("纯动作无正文的历史回答不显示空气泡", bubbles[0].hidden === true, JSON.stringify(bubbles[0]));
check("历史回答正文正常显示", bubbles[1].hidden === false && bubbles[1].text.includes("看完了，这是回答"), JSON.stringify(bubbles[1]));

// 用户点击标题 → 展开回看
await clickAcc(0);
await sleep(150);
const a0open = await readAcc(0);
check("点击标题可展开查看历史动作（思考行 + 工具行都在）★需求",
  a0open.open === true && a0open.reasonings.length === 1 && a0open.tools.length === 1,
  JSON.stringify({ open: a0open.open, reasonings: a0open.reasonings.length, tools: a0open.tools.length }));

// 展开思考行 → 看到思考正文
await clickReasoningRow(0, 0);
await sleep(120);
const a0reason = await readAcc(0);
check("展开思考行可见思考正文", a0reason.reasonings[0].open === true && a0reason.reasonings[0].text === "先看目录结构",
  JSON.stringify(a0reason.reasonings[0]));

// 展开工具行 → 看到参数与结果
await clickToolRow(0, 0);
await sleep(120);
const a0tool = await readAcc(0);
check("展开工具行可见参数与结果", a0tool.tools[0].open === true && a0tool.tools[0].hasBody === true
  && a0tool.tools[0].input.includes("file_path") && a0tool.tools[0].result === "文件内容 123",
  JSON.stringify({ open: a0tool.tools[0].open, input: a0tool.tools[0].input.slice(0, 40), result: a0tool.tools[0].result }));

/* ============ Part B. 运行中轮次：动作实时可见、结束后可回看 ============ */
await evalJs(`(() => {
  const el = document.getElementById('pi-input');
  el.value = '继续处理';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('pi-send-btn').click();
})(); 1`);
const started = await waitFor(`window.__hasPendingChat()`, 5000);
check("发送后进入运行态（chat 挂起等待完成）", started === true);
check("运行中发送按钮为「停止」态", (await evalJs(`document.getElementById('pi-send-btn').classList.contains('running')`)) === true);

// 思考实时出现：独立行、标题「正在思考」、正文行默认收起
await evalJs(`window.__emit('chat:thinking', { sessionId: 's1', delta: '让我想想', content: '让我想想' }); 1`);
await sleep(80);
let live = await readAcc(2);
check("运行中工作分组默认展开，标题是「工作中 N 秒」",
  live.open === true && live.state === "running" && /^工作中 \d+ 秒$/.test(live.status), JSON.stringify({ open: live.open, status: live.status }));
check("运行中思考实时出现为独立行、标题「正在思考」、正文行默认收起",
  live.reasonings.length === 1 && live.reasonings[0].label === "正在思考" && live.reasonings[0].settled === false
  && live.reasonings[0].open === false && live.reasonings[0].text === "让我想想",
  JSON.stringify(live.reasonings));
check("流式期间思考行标题右侧显示一行摘要", live.reasonings[0].stream === "让我想想",
  JSON.stringify({ stream: live.reasonings[0].stream }));

// 增量合并
await evalJs(`window.__emit('chat:thinking', { sessionId: 's1', delta: '再看看', content: '让我想想再看看' }); 1`);
await sleep(80);
live = await readAcc(2);
check("同一段思考增量合并（不重复整段）", live.reasonings.length === 1 && live.reasonings[0].text === "让我想想再看看",
  JSON.stringify(live.reasonings.map((r) => r.text)));

// 工具调用开始（带后端新协议的结构化字段）
await evalJs(`window.__emit('chat:tool', { sessionId: 's1', toolCallId: 't1', toolName: 'read_file', status: 'running', label: '📖 读取文件', detail: '📄 a.js', kind: 'read', kindLabel: '正在读取', primaryText: 'a.js', secondaryText: '', changeStat: '', inputJson: '{\\n  "file_path": "a.js"\\n}' }); 1`);
await sleep(80);
live = await readAcc(2);
check("工具调用实时显示为单行摘要（类别词「正在读取」+ 主文本 a.js）",
  live.tools.length === 1 && live.tools[0].id === "t1" && live.tools[0].status === "running"
  && live.tools[0].kindLabel === "正在读取" && live.tools[0].primary === "a.js" && live.tools[0].running === true,
  JSON.stringify(live.tools[0]));
check("工具行开始即带上参数（展开可看）", live.tools[0].input.includes("file_path"), JSON.stringify(live.tools[0].input));

// 工具调用后的思考另起一行（上一段思考落定）
await evalJs(`window.__emit('chat:thinking', { sessionId: 's1', delta: '继续想', content: '让我想想再看看继续想' }); 1`);
await sleep(80);
live = await readAcc(2);
check("工具调用后的思考另起一行（按发生顺序记录）",
  live.reasonings.length === 2 && live.reasonings[0].text === "让我想想再看看" && live.reasonings[1].text === "继续想",
  JSON.stringify(live.reasonings.map((r) => r.text)));
check("上一段思考已落定：标题切成「思考 · 持续了 N 秒」",
  live.reasonings[0].settled === true && live.reasonings[0].label === "思考" && /^· \d+ 秒$/.test(live.reasonings[0].meta),
  JSON.stringify({ settled: live.reasonings[0].settled, meta: live.reasonings[0].meta }));

// 工具完成 → 类别词改写 + 结果回填
await evalJs(`window.__emit('chat:tool', { sessionId: 's1', toolCallId: 't1', toolName: 'read_file', status: 'success', label: '📖 读取文件', detail: '内容A', kind: 'read', kindLabel: '已读取', primaryText: 'a.js', resultText: '内容A' }); 1`);
await sleep(80);
live = await readAcc(2);
check("工具完成后类别词改为「已读取」并回填结果",
  live.tools.length === 1 && live.tools[0].status === "success" && live.tools[0].kindLabel === "已读取"
  && live.tools[0].result === "内容A", JSON.stringify(live.tools[0]));

// 同名工具二次调用 → 按 toolCallId 配对，结果不串台
await evalJs(`window.__emit('chat:tool', { sessionId: 's1', toolCallId: 't2', toolName: 'read_file', status: 'running', label: '📖 读取文件', detail: '📄 b.js', kind: 'read', kindLabel: '正在读取', primaryText: 'b.js' }); 1`);
await evalJs(`window.__emit('chat:tool', { sessionId: 's1', toolCallId: 't2', toolName: 'read_file', status: 'success', label: '📖 读取文件', detail: '内容B', kind: 'read', kindLabel: '已读取', primaryText: 'b.js', resultText: '内容B' }); 1`);
await sleep(80);
live = await readAcc(2);
check("同名工具二次调用各自成行，结果不串台（按 toolCallId 配对）", live.tools.length === 2
  && live.tools[0].id === "t1" && live.tools[0].primary === "a.js" && live.tools[0].result === "内容A"
  && live.tools[1].id === "t2" && live.tools[1].primary === "b.js" && live.tools[1].result === "内容B",
  JSON.stringify(live.tools.map((t) => t.id + ":" + t.primary + ":" + t.result)));

// 编辑类工具：变更量 +N -N 落在摘要行上
await evalJs(`window.__emit('chat:tool', { sessionId: 's1', toolCallId: 't3', toolName: 'edit_file', status: 'success', label: '🔧 编辑文件', kind: 'edit', kindLabel: '已编辑', primaryText: 'src/a.js', secondaryText: '替换: a → b', changeStat: '+2 -1', inputJson: '{}', resultText: 'ok' }); 1`);
await sleep(80);
live = await readAcc(2);
const editRow = live.tools.find((t) => t.id === "t3");
check("编辑类工具行显示变更量 +N -N 与次文本", editRow && editRow.kindLabel === "已编辑"
  && editRow.change === "+2 -1" && editRow.secondary === "替换: a → b", JSON.stringify(editRow));

// 正文流式 + 完成
await evalJs(`window.__emit('chat:delta', { sessionId: 's1', delta: '最终回答', content: '最终回答' }); 1`);
await sleep(80);
check("运行中正文流式显示", (await evalJs(`(() => {
  const works = document.querySelectorAll('#pi-chat-body .turn-work');
  return works[2].closest('.message').querySelector('.message-content').textContent.includes('最终回答');
})()`)) === true);

// idle 带上后端算出的本轮耗时
await evalJs(`window.__emit('chat:status', { sessionId: 's1', status: 'idle', durationMs: 12500 }); 1`);
await evalJs(`window.__finishChat(); 1`);
await sleep(400);
live = await readAcc(2);
check("完成后分组收起（不遮挡正文）", live.open === false, JSON.stringify({ open: live.open }));
check("完成后标题落定为「已工作 13 秒」（用后端 durationMs）", live.status === "已工作 13 秒" && live.state === "worked",
  JSON.stringify({ status: live.status, state: live.state }));
check("完成后动作完整保留在 DOM（思考 2 段 + 工具 3 行）★需求",
  live.reasonings.length === 2 && live.tools.length === 3
  && live.tools[0].result === "内容A" && live.tools[1].result === "内容B",
  JSON.stringify({ reasonings: live.reasonings.map((r) => r.text), tools: live.tools.map((t) => t.id + ":" + t.result) }));
check("发送按钮回到「发送」态", (await evalJs(`document.getElementById('pi-send-btn').classList.contains('running')`)) === false);
check("最终回答写入同一轮气泡", (await evalJs(`(() => {
  const works = document.querySelectorAll('#pi-chat-body .turn-work');
  return works[2].closest('.message').querySelector('.message-content').textContent.includes('完成后的回答');
})()`)) === true);

// 完成后再次点击 → 仍可展开回看全部动作
await clickAcc(2);
await sleep(150);
live = await readAcc(2);
check("完成后点击标题仍可展开查看全部动作 ★核心需求", live.open === true
  && live.reasonings.length === 2 && live.tools.length === 3
  && live.tools[0].result === "内容A" && live.tools[1].result === "内容B",
  JSON.stringify({ open: live.open, reasonings: live.reasonings.length, tools: live.tools.map((t) => t.id) }));

/* ============ Part C. 中止：运行中的工具行与分组标题都落定为「已停止」 ============ */
await evalJs(`(() => {
  const el = document.getElementById('pi-input');
  el.value = '再跑一轮';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('pi-send-btn').click();
})(); 1`);
await waitFor(`window.__hasPendingChat()`, 5000);
// 让这一轮留下一个仍在「执行中」的工具行
await evalJs(`window.__emit('chat:tool', { sessionId: 's1', toolCallId: 'ta', toolName: 'bash', status: 'running', label: '🖥️ 执行命令', kind: 'execute', kindLabel: '正在执行', primaryText: 'sleep 999', inputJson: '{\\n  "command": "sleep 999"\\n}' }); 1`);
await sleep(80);
const bIdx = (await evalJs(`document.querySelectorAll('#pi-chat-body .turn-work').length`)) - 1;
const beforeAbort = await readAcc(bIdx);
check("中止前：工具行仍在「正在执行」、分组在「工作中」",
  beforeAbort.tools.length === 1 && beforeAbort.tools[0].running === true
  && beforeAbort.tools[0].kindLabel === "正在执行" && beforeAbort.state === "running",
  JSON.stringify({ kindLabel: beforeAbort.tools[0].kindLabel, state: beforeAbort.state }));

await evalJs(`window.__emit('chat:aborted', { sessionId: 's1' }); 1`);
await sleep(150);
const afterAbort = await readAcc(bIdx);
check("中止后：工具行类别词变「已停止」、不再转圈",
  afterAbort.tools[0].status === "stopped" && afterAbort.tools[0].kindLabel === "已停止" && afterAbort.tools[0].running === false,
  JSON.stringify(afterAbort.tools[0]));
check("中止后：分组标题落定为「已停止」并收起",
  afterAbort.status === "已停止" && afterAbort.state === "stopped" && afterAbort.open === false,
  JSON.stringify({ status: afterAbort.status, state: afterAbort.state, open: afterAbort.open }));

/* ============ 收尾 ============ */
check("页面无未捕获异常", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
try { ws.close(); } catch { /* ignore */ }
chrome.kill();
server.close();
await rm(userDir, { recursive: true, force: true }).catch(() => {});
process.exit(fail === 0 ? 0 : 1);
