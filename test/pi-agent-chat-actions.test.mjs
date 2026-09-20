/**
 * pi-agent 聊天区「动作可展开」回归测试（真实浏览器 + 真实插件 UI 文件 + mock 后端）。
 *
 * 覆盖需求：聊天区不管是否完成，都应能展开查看此前的动作信息（思考 + 各种工具调用）。
 *   A. 历史会话（已完成轮次）：
 *      - 思考与工具调用收进折叠区，默认收起、标题带动作计数，点击可展开；
 *      - 工具结果按 toolCallId 回填（成功 ✓ / 失败 ✗ / 中断残留标「已停止」）；
 *      - 纯动作无正文的回答不显示空气泡。
 *   B. 运行中轮次（实时事件）：
 *      - 思考实时出现、增量合并；工具调用后思考另起一段；
 *      - 工具卡片「执行中…」→「✓ 完成」并回填结果；
 *      - 同名工具二次调用按 toolCallId 配对，结果不串台；
 *      - 轮次结束后折叠区收起但动作完整保留，可再次展开回看。
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

/* 会话 s1：已完成的历史轮次，含思考 / 工具调用 / 工具结果（含一条中断残留 tc3） */
const transcripts = {
  s1: [
    { role: "user", content: "帮我看看项目" },
    { role: "assistant", content: "", thinking: "先看目录结构", toolCalls: [
      { id: "tc1", name: "read_file", label: "📖 读取文件", detail: "📄 src/index.js" },
    ] },
    { role: "toolResult", toolCallId: "tc1", toolName: "read_file", isError: false, content: "文件内容 123" },
    { role: "assistant", content: "看完了，这是回答", thinking: "总结一下", toolCalls: [
      { id: "tc2", name: "bash", label: "🖥️ 执行命令", detail: "npm test" },
      { id: "tc3", name: "write_file", label: "✏️ 写入文件", detail: "📄 out.txt" },
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

/** 读取某个折叠区的结构快照（思考段 / 工具卡片 / 标题 / 展开态） */
const READ_ACC = (i) => `JSON.stringify((function () {
  var acc = document.querySelectorAll('#pi-chat-body .thought-accordion')[${i}];
  if (!acc) return { missing: true };
  function txt(el, sel) { var n = el.querySelector(sel); return n ? n.textContent : ''; }
  var thoughts = [];
  var thoughtEls = acc.querySelectorAll('.accordion-content > .thought-text');
  for (var k = 0; k < thoughtEls.length; k++) thoughts.push(thoughtEls[k].textContent);
  var tools = [];
  var cards = acc.querySelectorAll('.accordion-content > .tool-call-item');
  for (var j = 0; j < cards.length; j++) {
    var c = cards[j];
    tools.push({
      id: c.dataset.toolId || '',
      status: c.dataset.status || '',
      name: txt(c, '.tool-call-name'),
      badge: txt(c, '.tool-call-status-badge'),
      result: txt(c, '.tool-call-result'),
      running: c.classList.contains('tool-running'),
      error: c.classList.contains('tool-error'),
    });
  }
  return { open: acc.open, summary: txt(acc, 'summary'), thoughts: thoughts, tools: tools };
})())`;
const readAcc = async (i) => JSON.parse(await evalJs(READ_ACC(i)));
/** 点击某个折叠区标题（模拟用户展开/收起） */
const clickAcc = async (i) => evalJs(`document.querySelectorAll('#pi-chat-body .thought-accordion')[${i}].querySelector('summary').click(); 1`);

await S("Page.navigate", { url: base + "/pi-chat-actions-harness.html" }, sessionId);

/* ============ Part A. 历史会话：已完成轮次的动作默认收起、可展开 ============ */
const loaded = await waitFor(`document.querySelectorAll('#pi-chat-body .thought-accordion').length >= 2`, 15000);
check("历史会话渲染出 2 个动作折叠区（两条含动作的回答）", loaded === true,
  `count=${await evalJs(`document.querySelectorAll('#pi-chat-body .thought-accordion').length`)}`);

const a0 = await readAcc(0), a1 = await readAcc(1);
check("历史折叠区默认收起（不遮挡正文）★需求", a0.open === false && a1.open === false,
  JSON.stringify({ open0: a0.open, open1: a1.open }));
check("折叠区标题带动作计数（思考段 + 工具卡片）", a0.summary === "思考过程 / 工具调用 (2)" && a1.summary === "思考过程 / 工具调用 (3)",
  JSON.stringify([a0.summary, a1.summary]));
check("历史思考文本完整保留", JSON.stringify(a0.thoughts) === JSON.stringify(["先看目录结构"]), JSON.stringify(a0.thoughts));
check("历史工具卡片：成功调用回填结果", a0.tools.length === 1 && a0.tools[0].id === "tc1" && a0.tools[0].status === "success"
  && a0.tools[0].badge === "✓ 完成" && a0.tools[0].result === "文件内容 123", JSON.stringify(a0.tools));
check("历史工具卡片：失败调用显示错误徽标与错误文本", a1.tools.length === 2 && a1.tools[0].id === "tc2" && a1.tools[0].status === "error"
  && a1.tools[0].badge === "✗ 失败" && a1.tools[0].result === "command not found", JSON.stringify(a1.tools[0]));
check("历史中无结果的工具调用标记为「已停止」（不一直转圈）", a1.tools[1].id === "tc3" && a1.tools[1].status === "stopped"
  && a1.tools[1].badge === "已停止" && a1.tools[1].running === false, JSON.stringify(a1.tools[1]));

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
check("点击标题可展开查看历史动作（思考 + 工具卡片都在）★需求", a0open.open === true && a0open.thoughts.length === 1 && a0open.tools.length === 1,
  JSON.stringify({ open: a0open.open, thoughts: a0open.thoughts.length, tools: a0open.tools.length }));

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

// 思考实时出现
await evalJs(`window.__emit('chat:thinking', { sessionId: 's1', delta: '让我想想', content: '让我想想' }); 1`);
await sleep(80);
let live = await readAcc(2);
check("运行中思考动作实时出现且默认展开", live.open === true && JSON.stringify(live.thoughts) === JSON.stringify(["让我想想"]),
  JSON.stringify({ open: live.open, thoughts: live.thoughts }));

// 增量合并
await evalJs(`window.__emit('chat:thinking', { sessionId: 's1', delta: '再看看', content: '让我想想再看看' }); 1`);
await sleep(80);
live = await readAcc(2);
check("同一段思考增量合并（不重复整段）", JSON.stringify(live.thoughts) === JSON.stringify(["让我想想再看看"]), JSON.stringify(live.thoughts));

// 工具调用开始
await evalJs(`window.__emit('chat:tool', { sessionId: 's1', toolCallId: 't1', toolName: 'read_file', status: 'running', label: '📖 读取文件', detail: '📄 a.js' }); 1`);
await sleep(80);
live = await readAcc(2);
check("工具调用实时显示为「执行中…」卡片", live.tools.length === 1 && live.tools[0].id === "t1" && live.tools[0].status === "running"
  && live.tools[0].badge === "执行中…" && live.tools[0].running === true, JSON.stringify(live.tools));

// 工具调用后的思考另起一段
await evalJs(`window.__emit('chat:thinking', { sessionId: 's1', delta: '继续想', content: '让我想想再看看继续想' }); 1`);
await sleep(80);
live = await readAcc(2);
check("工具调用后的思考另起一段（按发生顺序记录）", JSON.stringify(live.thoughts) === JSON.stringify(["让我想想再看看", "继续想"]),
  JSON.stringify(live.thoughts));

// 工具完成 → 结果回填
await evalJs(`window.__emit('chat:tool', { sessionId: 's1', toolCallId: 't1', toolName: 'read_file', status: 'success', label: '📖 读取文件', detail: '内容A' }); 1`);
await sleep(80);
live = await readAcc(2);
check("工具完成：卡片回填成功徽标与结果", live.tools.length === 1 && live.tools[0].status === "success"
  && live.tools[0].badge === "✓ 完成" && live.tools[0].result === "内容A", JSON.stringify(live.tools));

// 同名工具二次调用 → 按 toolCallId 配对，结果不串台
await evalJs(`window.__emit('chat:tool', { sessionId: 's1', toolCallId: 't2', toolName: 'read_file', status: 'running', label: '📖 读取文件', detail: '📄 b.js' }); 1`);
await evalJs(`window.__emit('chat:tool', { sessionId: 's1', toolCallId: 't2', toolName: 'read_file', status: 'success', label: '📖 读取文件', detail: '内容B' }); 1`);
await sleep(80);
live = await readAcc(2);
check("同名工具二次调用各自成卡，结果不串台（按 toolCallId 配对）", live.tools.length === 2
  && live.tools[0].id === "t1" && live.tools[0].result === "内容A"
  && live.tools[1].id === "t2" && live.tools[1].result === "内容B", JSON.stringify(live.tools));
check("折叠区计数随动作增长（2 段思考 + 2 次工具 = 4）", live.summary === "思考过程 / 工具调用 (4)", live.summary);

// 正文流式 + 完成
await evalJs(`window.__emit('chat:delta', { sessionId: 's1', delta: '最终回答', content: '最终回答' }); 1`);
await sleep(80);
check("运行中正文流式显示", (await evalJs(`(() => {
  const accs = document.querySelectorAll('#pi-chat-body .thought-accordion');
  return accs[2].closest('.message').querySelector('.message-content').textContent.includes('最终回答');
})()`)) === true);

await evalJs(`window.__emit('chat:status', { sessionId: 's1', status: 'idle' }); 1`);
await evalJs(`window.__finishChat(); 1`);
await sleep(400);
live = await readAcc(2);
check("完成后折叠区收起（不遮挡正文）", live.open === false, JSON.stringify({ open: live.open }));
check("完成后动作完整保留在 DOM（思考 2 段 + 工具 2 张）★需求", JSON.stringify(live.thoughts) === JSON.stringify(["让我想想再看看", "继续想"])
  && live.tools.length === 2 && live.tools[0].result === "内容A" && live.tools[1].result === "内容B",
  JSON.stringify({ thoughts: live.thoughts, tools: live.tools.map((t) => t.id + ":" + t.result) }));
check("发送按钮回到「发送」态", (await evalJs(`document.getElementById('pi-send-btn').classList.contains('running')`)) === false);
check("最终回答写入同一轮气泡", (await evalJs(`(() => {
  const accs = document.querySelectorAll('#pi-chat-body .thought-accordion');
  return accs[2].closest('.message').querySelector('.message-content').textContent.includes('完成后的回答');
})()`)) === true);

// 完成后再次点击 → 仍可展开回看全部动作
await clickAcc(2);
await sleep(150);
live = await readAcc(2);
check("完成后点击标题仍可展开查看全部动作 ★核心需求", live.open === true
  && JSON.stringify(live.thoughts) === JSON.stringify(["让我想想再看看", "继续想"])
  && live.tools.length === 2 && live.tools[0].result === "内容A" && live.tools[1].result === "内容B",
  JSON.stringify({ open: live.open, thoughts: live.thoughts, tools: live.tools.map((t) => t.id) }));

/* ============ 收尾 ============ */
check("页面无未捕获异常", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
try { ws.close(); } catch { /* ignore */ }
chrome.kill();
server.close();
await rm(userDir, { recursive: true, force: true }).catch(() => {});
process.exit(fail === 0 ? 0 : 1);
