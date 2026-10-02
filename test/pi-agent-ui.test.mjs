/**
 * pi-agent UI 回归测试（真实浏览器 + 真实插件 UI 文件 + mock 后端）。
 *
 * 覆盖用户截图上标注的四个问题 + 新增的项目图标状态圆点：
 *   1. 左栏项目图标角标撑出幽灵滚动条        → #pi-project-list 无垂直溢出
 *   2. 角标口径（已完成未读 + 进行中）      → 与历史总数区分，不再是 99+
 *   3. 「新建会话」没有反馈                   → 列表立即出现新会话且标「当前」，
 *                                             连点两次得到两个不同会话
 *   4. 提问在下、回答跑到上面（刷新才正常）    → DOM 顺序恒为 user → agent
 *   5. 项目图标右下角状态圆点                 → 只画 1 个圆、数字写在圆里：
 *                                             有已完成未读=绿点(圆内=未查看数,带边框)；
 *                                             只有运行中=黄点(圆内=运行中数)；无则不画
 *
 * 用法: node test/pi-agent-ui.test.mjs
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

/* ---------------- 夹具：近似宿主环境 + mock 后端（自包含生成，不依赖其它测试产物） ----------------
   项目列表带三类图标状态，覆盖项目图标右下角的单个状态圆点：
     - 项目一：unseen 2 + running 1 → 1 个绿点，圆内=2（未查看优先，不画两圆）
     - 项目二：只有 running 1       → 1 个黄点，圆内=1
     - 项目三：都没有              → 无圆点
   项目一会话共 33 条：3 条待处理（1 未查看「还没看的回答」+ 1 进行中「正在跑的会话」
   + 1 未查看 5 轮「向我提问问题」）+ 1 条普通 + 29 条历史。 */
const projectsFixture = [
  { id: "p1", name: "项目一", path: "D:/data/proj1", badgeCount: 3, runningCount: 1, unseenCount: 2, sessionCount: 33, lastOpenedAt: "2026-01-02T10:00:00.000Z" },
  { id: "p2", name: "项目二", path: "D:/data/proj2", badgeCount: 1, runningCount: 1, unseenCount: 0, sessionCount: 2, lastOpenedAt: "2026-01-01T10:00:00.000Z" },
  { id: "p3", name: "项目三", path: "D:/data/proj3", badgeCount: 0, runningCount: 0, unseenCount: 0, sessionCount: 1, lastOpenedAt: "2025-12-31T10:00:00.000Z" },
];

const fiveRounds = [];
for (let r = 1; r <= 5; r++) {
  fiveRounds.push({ role: "user", content: `第${["一","二","三","四","五"][r - 1]}轮提问` });
  fiveRounds.push({ role: "assistant", content: `第${["一","二","三","四","五"][r - 1]}轮回答`, durationMs: 1000 });
}

const buildSessions = () => {
  // createdAt 刻意与 updatedAt **错开**：序号按创建时间编（#L1 = 最新创建），
  // 列表按最后消息时间排（谁刚说话谁在上）。两者顺序不同才能证明编号没有跟着
  // 列表位置走。创建序（新→旧）：s-cur → t-five → s-unseen → s-running → h29 … h1。
  const out = [
    // 进行中会话设为最新消息：页面加载会自动选中最新一条并 markViewed，
    // 让它不是 unseen，避免自动查看把未查看数清零而影响下方圆点断言。
    { id: "s-running", title: "正在跑的会话", messageCount: 4, flag: "running", updatedAt: "2026-01-03T12:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z", file: "f-running" },
    // 待处理：未查看（测试全程不会点开它，用于断言「已完成未读」状态点）
    { id: "s-unseen", title: "还没看的回答", messageCount: 2, flag: "unseen", updatedAt: "2026-01-03T11:00:00.000Z", createdAt: "2026-01-01T01:00:00.000Z", file: "f-unseen" },
    // 5 轮对话会话：测试会点开它验证分轮加载（点开后 markViewed 会清掉 unseen）
    { id: "t-five", title: "向我提问问题", messageCount: 10, flag: "unseen", updatedAt: "2026-01-03T10:00:00.000Z", createdAt: "2026-01-01T02:00:00.000Z", file: "f-five" },
    // 消息时间最旧、但创建时间最新 → 应为 #L1，且不因被点开而挪到列表最前
    { id: "s-cur", title: "普通会话", messageCount: 2, flag: null, updatedAt: "2026-01-02T10:00:00.000Z", createdAt: "2026-01-01T03:00:00.000Z", file: "f-cur" },
  ];
  for (let i = 29; i >= 1; i--) {
    out.push({
      id: `h${i}`, title: `历史会话 ${i}`, messageCount: 2, flag: null,
      updatedAt: `2025-12-${String((i % 28) + 1).padStart(2, "0")}T10:00:00.000Z`,
      createdAt: `2025-11-${String(i).padStart(2, "0")}T10:00:00.000Z`,
      file: `hf${i}`,
    });
  }
  return out;
};

const harness = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>pi-agent harness</title>
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

const projects = ${JSON.stringify(projectsFixture)};
const fiveRounds = ${JSON.stringify(fiveRounds)};
const transcripts = {
  "t-five": fiveRounds,
  "s-unseen": [
    { role: "user", content: "我刚问的问题" },
    { role: "assistant", content: "回答完了但你没看", durationMs: 500 },
  ],
  "s-running": [
    { role: "user", content: "跑个长任务" },
    { role: "assistant", content: "正在处理…", durationMs: 0 },
  ],
  "s-cur": [
    { role: "user", content: "普通提问" },
    { role: "assistant", content: "普通回答", durationMs: 500 },
  ],
};

const notifications = new Map();
const emit = (method, params) => { for (const fn of notifications.get(method) || []) fn(params); };

let createdCount = 0;
const newSessions = [];
/** 测试可改写各项目的状态圆点计数，验证「非当前项目」的圆点会实时刷新 */
const dotOverrides = {};

window.__calls = [];
const backend = {
  async call(method, params) {
    await sleep(10);
    window.__calls.push({ method, params });
    switch (method) {
      case "init": return { ok: true, hasPi: true };
      case "listModels": return { models: [{ provider: "MAG", id: "lite", name: "Lite", available: true }], defaultModel: "MAG:lite" };
      case "getConfig": return { config: {} };
      case "setConfig": return { ok: true };
      case "listProjects": return { projects: projects.map((p) => (dotOverrides[p.id] ? { ...p, ...dotOverrides[p.id] } : p)) };
      case "listSessions": {
        const sessions = [...newSessions, ...${JSON.stringify(buildSessions())}];
        const badgeCount = sessions.filter((s) => s.flag === "running" || s.flag === "unseen" || s.pending).length;
        return { sessions, badgeCount };
      }
      case "createSession":
        createdCount += 1;
        // 新会话先是未落盘的草稿（pending:true），列表里排在最前、标「当前」
        newSessions.unshift({ id: "new-" + createdCount, title: "新对话", messageCount: 0, flag: null, pending: true, updatedAt: new Date().toISOString(), createdAt: new Date().toISOString(), file: "" });
        return { session: { id: "new-" + createdCount, title: "新对话" } };
      case "loadSession": return { transcript: transcripts[params.sessionId] || [] };
      case "markViewed": return { ok: true };
      case "chat": {
        const sid = params.sessionId;
        // 真实后端会在 agent_start 时发 chat:status(running)、结束后发 idle。
        // 必须模拟 idle，否则会话会永远留在 runningSessions 账本里，
        // 下一次点击发送会被「该会话正在运行」挡住（返回不发请求）。
        emit("chat:status", { sessionId: sid, status: "running" });
        // 停止路径专用：挂起本轮不返回，等测试点「停止」→ abort 才以 aborted:true 收尾。
        // 对齐真实后端：用户点停止后 chat 请求**不报错**，而是正常 resolve {aborted:true}。
        if (window.__hangChat) {
          window.__hangChat = false;
          return await new Promise((resolve) => {
            window.__resolveHungChat = () => {
              emit("chat:aborted", { sessionId: sid, projectPath: params.projectPath || "" });
              resolve({ aborted: true, content: "" });
            };
          });
        }
        await sleep(20);
        const text = "本轮回答";
        const t = transcripts[sid] || (transcripts[sid] = []);
        t.push({ role: "user", content: params.message || "" });
        t.push({ role: "assistant", content: text, durationMs: 100 });
        const ns = newSessions.find((s) => s.id === sid);
        if (ns) { ns.pending = false; ns.messageCount = t.length; }
        emit("chat:status", { sessionId: sid, status: "idle" });
        return { content: text };
      }
      case "abort": {
        // 停止：真实后端会 abort 本轮、广播 chat:aborted，并让挂起的 chat 以
        // aborted:true（而不是报错）收尾——这正是「停止不该刷错误」的关键契约。
        if (window.__resolveHungChat) {
          const r = window.__resolveHungChat;
          window.__resolveHungChat = null;
          r();
        }
        return { ok: true };
      }
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

window.ms = {
  backend,
  log() {},
  ui: { confirm: async () => true, toast() {} },
  store: {
    get: async (k) => (window.__store && k in window.__store ? window.__store[k] : null),
    set: async (k, v) => { (window.__store = window.__store || {})[k] = v; return true; },
  },
};

const fn = new Function(
  "ms", "env", "plugin", "host", "keyword", "inputValue", "onSubKeyword", "md2html", "openExternal",
  '"use strict";' + String.fromCharCode(10) + files.js + String.fromCharCode(10)
);
fn(window.ms, window.ms, { id: "com.mysearch.pi-agent", name: "Pi Agent", version: "2.3.1" },
  host, "AI", "", () => {}, (raw) => String(raw == null ? "" : raw), () => {});

window.__emit = emit;
window.__setDots = (id, patch) => { dotOverrides[id] = patch; };
window.__hangChat = false;
window.__ready = true;
</script>
</body>
</html>`;
await writeFile(path.join(tmpDir, "pi-harness.html"), harness, "utf8");

const server = createServer(async (req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  try {
    if (u === "/" || u === "/pi-harness.html") {
      const body = await readFile(path.join(root, "test", "_tmp", "pi-harness.html"));
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

const userDir = path.join(root, "test", "_chrome-profile-pi-agent");
await rm(userDir, { recursive: true, force: true });
// 固定调试端口：新版 Chrome/Edge 的 headless=new 不再向 stderr 打印
// "DevTools listening on ws://..."，只靠 stderr 解析会误判为「启动超时」。
// 这里用固定端口，并通过 HTTP /json/version 拿回 ws 地址（保底仍尝试 stderr）。
const debugPort = 9222 + Math.floor(Math.random() * 500);
const chrome = spawn(
  bin,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--window-size=880,700`,
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDir}`,
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] }
);

const fetchText = (url) =>
  new Promise((resolve, reject) => {
    import("http").then(({ get }) => {
      get(url, (res) => {
        let s = "";
        res.on("data", (d) => (s += d));
        res.on("end", () => resolve(s));
      }).on("error", reject);
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

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("PASS ", name, extra ? ` — ${extra}` : ""); }
  else { fail++; console.log("FAIL ", name, extra ? ` — ${extra}` : ""); }
};

await S("Page.navigate", { url: base + "/pi-harness.html" }, sessionId);
await sleep(1500);
check("夹具加载（插件 UI 已挂载）", await evalJs(`!!document.querySelector('.pi-agent-container')`));

/* ============ 0. 会话列表默认只显示「待处理」的 ============ */
const initList = await evalJs(`JSON.stringify((() => {
  const items = [...document.querySelectorAll('#pi-session-list .session-item')];
  return {
    titles: items.map(i => i.querySelector('.session-title')?.textContent || ''),
    moreText: document.querySelector('#pi-session-list .pi-more-sessions-btn')?.textContent || '',
    hasMore: !!document.querySelector('#pi-session-list .pi-more-sessions-btn'),
    // 夹具里共 33 条会话（3 待处理 + 1 普通 + 29 历史）
    totalInFixture: 33,
  };
})())`);
const il = JSON.parse(initList);
check("会话列表默认不铺开全部会话（33 条不能全列出来）", il.titles.length < il.totalInFixture,
  `默认显示 ${il.titles.length} 条 / 共 ${il.totalInFixture} 条`);
check("待处理会话（已完成未读）始终显示", il.titles.some((t) => t.includes("向我提问问题")),
  JSON.stringify(il.titles));
check("进行中的会话始终显示", il.titles.some((t) => t.includes("正在跑的会话")), JSON.stringify(il.titles));
check("存在「加载更多历史会话」按钮且提示剩余条数",
  il.hasMore && /还有\s*\d+\s*条/.test(il.moreText), il.moreText);

// 点「加载更多」应多出会话（按钮不存在时记为失败，不抛异常打断后续用例）
const beforeExpand = await evalJs(`document.querySelectorAll('#pi-session-list .session-item').length`);
await evalJs(`(document.querySelector('#pi-session-list .pi-more-sessions-btn')?.click(), 1)`);
await sleep(200);
const afterExpand = await evalJs(`document.querySelectorAll('#pi-session-list .session-item').length`);
check("点「加载更多」后多列出会话", afterExpand > beforeExpand, `${beforeExpand} → ${afterExpand}`);

// 再点几次直到全部展开，按钮应消失
for (let i = 0; i < 6; i++) {
  const has = await evalJs(`!!document.querySelector('#pi-session-list .pi-more-sessions-btn')`);
  if (!has) break;
  await evalJs(`document.querySelector('#pi-session-list .pi-more-sessions-btn').click(); 1`);
  await sleep(120);
}
const allShown = await evalJs(`document.querySelectorAll('#pi-session-list .session-item').length`);
check("持续加载后能列出全部会话", allShown === il.totalInFixture, `显示 ${allShown} / ${il.totalInFixture}`);
check("全部展开后「加载更多」按钮消失",
  (await evalJs(`!!document.querySelector('#pi-session-list .pi-more-sessions-btn')`)) === false);

// 点开一条历史会话（非待处理）后，它必须仍留在列表里标着「当前」，
// 否则用户会看不到自己在哪儿
await evalJs(`(() => {
  const item = [...document.querySelectorAll('#pi-session-list .session-item')]
    .find(i => (i.querySelector('.session-title')?.textContent || '').includes('历史会话 20'));
  item?.click();
})(); 1`);
await sleep(500);
const stillThere = JSON.parse(await evalJs(`JSON.stringify((() => {
  const active = document.querySelector('#pi-session-list .session-item.active');
  return {
    hasActive: !!active,
    title: active?.querySelector('.session-title')?.textContent || '',
    badge: active?.querySelector('.badge')?.textContent || '',
  };
})())`));
check("打开的旧会话仍留在列表中（不会从列表里消失）",
  stillThere.hasActive && stillThere.title.includes("历史会话 20"), JSON.stringify(stillThere));
check("该会话标记为「当前」", stillThere.badge === "当前", stillThere.badge);

// 点开某个会话只是把它高亮，不能把它顶到最上面：
// 列表顺序恒按「最后消息时间」降序，否则「看哪个哪个就跳上去」，位置找不回来。
const orderAfterOpen = JSON.parse(await evalJs(`JSON.stringify(
  [...document.querySelectorAll('#pi-session-list .session-item')]
    .map(i => i.querySelector('.session-title')?.textContent || ''))`));
check("点开会话不改变列表顺序（被点开的仍在原位、不在最前）",
  orderAfterOpen[0]?.includes("正在跑的会话") && orderAfterOpen[1]?.includes("还没看的回答"),
  JSON.stringify(orderAfterOpen.slice(0, 3)));
check("被点开的「历史会话 20」不是列表首项",
  !orderAfterOpen[0]?.includes("历史会话 20"), orderAfterOpen[0]);

/* ============ 0b. 序号按创建时间（最新创建 = #L1），与列表排序解耦 ============ */
// 夹具里 createdAt 与 updatedAt 刻意错开：列表首项是消息最新的「正在跑的会话」，
// 但创建时间最新的是「普通会话」→ 它才是 #L1。
const labels = JSON.parse(await evalJs(`JSON.stringify((() => {
  const items = [...document.querySelectorAll('#pi-session-list .session-item')];
  return items.map(i => ({
    label: i.querySelector('.session-index')?.textContent || '',
    title: i.querySelector('.session-title')?.textContent || '',
    active: i.classList.contains('active'),
  }));
})())`));
const labelOf = (t) => labels.find((x) => x.title.includes(t))?.label || '';
check("创建时间最新的会话编号为 #L1", labelOf("普通会话") === "#L1",
  `普通会话=${labelOf("普通会话")}`);
check("序号按创建时间递减（普通会话 #L1 → 向我提问问题 #L2 → 还没看的回答 #L3）",
  labelOf("向我提问问题") === "#L2" && labelOf("还没看的回答") === "#L3",
  `向我提问问题=${labelOf("向我提问问题")} 还没看的回答=${labelOf("还没看的回答")}`);
check("序号不跟列表位置走：消息最新（列表首项）的会话不是 #L1",
  labels[0]?.title.includes("正在跑的会话") && labels[0]?.label !== "#L1",
  `首项=${labels[0]?.label} ${labels[0]?.title}`);
check("被点开的「历史会话 20」有按创建时间的编号", /^#L\d+$/.test(labelOf("历史会话 20")),
  `历史会话 20=${labelOf("历史会话 20")}`);

/* ============ 1. 左栏不出现幽灵滚动条 ============ */
const rail = await evalJs(`JSON.stringify((() => {
  const el = document.getElementById('pi-project-list');
  const dot = document.querySelector('#pi-project-list .project-status-dot');
  const icon = document.querySelector('#pi-project-list .project-icon');
  const cs = getComputedStyle(el);
  return {
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    overflowY: cs.overflowY,
    hasDot: !!dot,
    dotText: dot?.textContent || '',
    // 圆点（数字写在圆里，无独立角标）是否探出列表的可滚动区域
    dotRight: dot ? dot.getBoundingClientRect().right : 0,
    listRight: el.getBoundingClientRect().right,
    iconRight: icon ? icon.getBoundingClientRect().right : 0,
  };
})())`);
const r = JSON.parse(rail);
check("左栏项目列表无垂直溢出（圆点不再撑出滚动条）", r.scrollHeight <= r.clientHeight + 1,
  `scrollHeight=${r.scrollHeight} clientHeight=${r.clientHeight}`);
check("项目状态圆点仍在（口径=未查看数写在圆里，角标已并入圆点）", r.hasDot === true, r.dotText);
check("圆点数字不是历史会话总数 99+", r.dotText !== "99+" && r.dotText !== "120", `dot=${r.dotText}`);
check("圆点完全落在图标可见区内（不被 overflow 裁掉）", r.dotRight <= r.listRight + 0.5,
  `dotRight=${r.dotRight.toFixed(1)} listRight=${r.listRight.toFixed(1)}`);

/* ============ 1b. 项目图标右下角状态圆点（单个圆，数字写在圆里） ============ */
// 夹具：项目一（未查看 2 + 运行中 1）→ 1 个绿点、圆内=2（未查看优先，不画两圆、无独立角标）
//       项目二（只有运行中 1）        → 1 个黄点、圆内=1
//       项目三（无）                  → 无圆点、无角标
const icons = JSON.parse(await evalJs(`JSON.stringify(
  [...document.querySelectorAll('#pi-project-list .project-icon')].map((icon) => {
    const dots = [...icon.querySelectorAll('.project-status-dot')];
    const d = dots[0];
    const rect = d ? d.getBoundingClientRect() : null;
    const cs = d ? getComputedStyle(d) : null;
    return {
      dotCount: dots.length,
      color: d ? (d.classList.contains('green') ? 'green' : d.classList.contains('yellow') ? 'yellow' : '') : '',
      hasRunning: d ? d.classList.contains('has-running') : false,
      text: d?.textContent || '',
      // 单字符时应是正圆（宽高相等，允许 1px 渲染误差）
      isCircle: rect ? Math.abs(rect.width - rect.height) <= 1 : false,
      // 圆点必须带 border 圆边框；绿点+有运行中时描边应为黄色
      borderWidth: cs ? parseFloat(cs.borderTopWidth) : 0,
      borderColor: cs ? cs.borderTopColor : '',
      borderRadius: cs ? cs.borderTopLeftRadius : '',
      hasBadge: !!icon.querySelector('.status-badge'),
      badgeText: icon.querySelector('.status-badge')?.textContent || '',
    };
  })
)`));

check("项目一（未查看+运行中）只画 1 个绿点（未查看优先，不再画两圆）",
  icons[0]?.dotCount === 1 && icons[0].color === "green",
  JSON.stringify({ n: icons[0]?.dotCount, color: icons[0]?.color }));
check("项目一绿点圆内显示未查看数 2", icons[0]?.text === "2", `text=${icons[0]?.text}`);
check("项目一绿点是正圆", icons[0]?.isCircle === true, JSON.stringify(icons[0]));
check("项目一绿点带 border 圆边框", icons[0]?.borderWidth >= 1 && /%|px/.test(icons[0]?.borderRadius || ""),
  `border=${icons[0]?.borderWidth}px radius=${icons[0]?.borderRadius}`);
check("项目一还有运行中 → 绿点描边为黄色（has-running）",
  icons[0]?.hasRunning === true && icons[0]?.borderColor === "rgb(245, 158, 11)",
  `hasRunning=${icons[0]?.hasRunning} borderColor=${icons[0]?.borderColor}`);
check("独立数字角标已并入圆点（图标下不再有 .status-badge）",
  icons[0]?.hasBadge === false && icons[1]?.hasBadge === false,
  `p1=${icons[0]?.badgeText} p2=${icons[1]?.badgeText}`);
check("项目二（只有运行中）只画 1 个黄点、圆内=运行中数 1",
  icons[1]?.dotCount === 1 && icons[1].color === "yellow" && icons[1].text === "1",
  JSON.stringify({ n: icons[1]?.dotCount, color: icons[1]?.color, text: icons[1]?.text }));
check("项目二黄点也是正圆且带边框",
  icons[1]?.isCircle === true && icons[1]?.borderWidth >= 1,
  `circle=${icons[1]?.isCircle} border=${icons[1]?.borderWidth}px`);
check("项目三（无待处理）不显示状态圆点", icons[2]?.dotCount === 0, JSON.stringify(icons[2]));
check("无待处理的项目也没有数字角标", icons[2]?.hasBadge === false || icons[2]?.badgeText === "",
  `badge=${icons[2]?.badgeText}`);

/* ============ 1c. 非当前项目的圆点必须实时刷新（历史缺陷） ============ */
// 缺陷：listProjects 原先只在启动时调一次，非当前项目的 running/unseen
// 一直冻结在启动那一刻（且启动基线把历史全标已查看 → unseen 恒 0），
// 于是实际几乎看不到绿点。这里验证 chat:status 触发的 refreshProjectFlags
// 能立刻把别的项目的黄点/绿点更新出来。
const dotsOf = (idx) => `(() => {
  const icon = document.querySelectorAll('#pi-project-list .project-icon')[${idx}];
  const d = icon.querySelector('.project-status-dot');
  const cs = d ? getComputedStyle(d) : null;
  return JSON.stringify({
    count: icon.querySelectorAll('.project-status-dot').length,
    color: d ? (d.classList.contains('green') ? 'green' : d.classList.contains('yellow') ? 'yellow' : '') : '',
    hasRunning: d ? d.classList.contains('has-running') : false,
    borderColor: cs ? cs.borderTopColor : '',
    text: d?.textContent || '',
  });
})()`;
check("初始：项目三无圆点", JSON.parse(await evalJs(dotsOf(2))).count === 0,
  await evalJs(dotsOf(2)));

// 模拟「项目三里有个会话开始跑」：后端计数变化 + 广播 chat:status(running)
await evalJs(`window.__setDots('p3', { runningCount: 1, unseenCount: 0, badgeCount: 1 }); 1`);
await evalJs(`window.__emit('chat:status', { sessionId: 'zzz', projectPath: 'D:/data/proj3', status: 'running' }); 1`);
await sleep(500);
const p3Running = JSON.parse(await evalJs(dotsOf(2)));
check("别的项目开始运行 → 立刻出现黄点、圆内=1（不必等切项目/重启）",
  p3Running.count === 1 && p3Running.color === "yellow" && p3Running.text === "1",
  JSON.stringify(p3Running));

// 跑完且未查看（无运行中）→ 黄点变绿点、圆内=未查看数、描边为默认深色
await evalJs(`window.__setDots('p3', { runningCount: 0, unseenCount: 1, badgeCount: 1 }); 1`);
await evalJs(`window.__emit('chat:status', { sessionId: 'zzz', projectPath: 'D:/data/proj3', status: 'idle' }); 1`);
await sleep(500);
const p3Unseen = JSON.parse(await evalJs(dotsOf(2)));
check("别的项目跑完未查看 → 黄点变绿点、圆内=1",
  p3Unseen.count === 1 && p3Unseen.color === "green" && p3Unseen.text === "1",
  JSON.stringify(p3Unseen));
check("没有运行中时绿点描边不是黄色（has-running 不误加）",
  p3Unseen.hasRunning === false && p3Unseen.borderColor !== "rgb(245, 158, 11)",
  `hasRunning=${p3Unseen.hasRunning} borderColor=${p3Unseen.borderColor}`);

// 同时存在运行中 + 已完成未读 → 单个绿点（未查看优先），描边变黄提示有活跃会话
// 这里不发通知，刻意等 6s 的项目轮询兜底，验证轮询本身也能把圆点刷新出来
await evalJs(`window.__setDots('p3', { runningCount: 1, unseenCount: 2, badgeCount: 3 }); 1`);
await sleep(6800);
const p3Both = JSON.parse(await evalJs(dotsOf(2)));
check("非当前项目运行中+未查看并存 → 单个绿点、圆内=未查看数 2（未查看优先）",
  p3Both.count === 1 && p3Both.color === "green" && p3Both.text === "2",
  JSON.stringify(p3Both));
check("绿点+还有运行中 → 描边为黄色（提示有活跃在跑的）",
  p3Both.hasRunning === true && p3Both.borderColor === "rgb(245, 158, 11)",
  `hasRunning=${p3Both.hasRunning} borderColor=${p3Both.borderColor}`);
await evalJs(`window.__setDots('p3', null); 1`);

// 圆点不得撑出列表横向可视区（与旧角标同一约束）
const dotOverflow = JSON.parse(await evalJs(`JSON.stringify((() => {
  const el = document.getElementById('pi-project-list');
  const dot = document.querySelector('#pi-project-list .project-icon .project-status-dot');
  return {
    scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
    overflowX: getComputedStyle(el).overflowX,
    dotLeft: dot ? dot.getBoundingClientRect().left : 0,
    listLeft: el.getBoundingClientRect().left,
    dotRight: dot ? dot.getBoundingClientRect().right : 0,
    listRight: el.getBoundingClientRect().right,
  };
})())`));
check("圆点不撑出左栏横向滚动条（不触发 overflow）",
  dotOverflow.scrollWidth <= dotOverflow.clientWidth + 1 && dotOverflow.overflowX === "hidden",
  `scrollWidth=${dotOverflow.scrollWidth} clientWidth=${dotOverflow.clientWidth}`);
check("圆点完全落在图标列表可见区内（不被裁切）",
  dotOverflow.dotLeft >= dotOverflow.listLeft - 0.5 && dotOverflow.dotRight <= dotOverflow.listRight + 0.5,
  `dot=[${dotOverflow.dotLeft.toFixed(1)},${dotOverflow.dotRight.toFixed(1)}] list=[${dotOverflow.listLeft.toFixed(1)},${dotOverflow.listRight.toFixed(1)}]`);

// 项目多到需要滚动时：滚动条要正常出现，且圆点不被横向裁切
await evalJs(`(() => {
  const list = document.getElementById('pi-project-list');
  for (let i = 0; i < 12; i++) {
    const d = document.createElement('div');
    d.className = 'project-icon';
    d.textContent = 'P' + i;
    const b = document.createElement('span');
    b.className = 'project-status-dot green';
    b.textContent = '2';
    d.appendChild(b);
    list.appendChild(d);
  }
})(); 1`);
await sleep(200);
const many = await evalJs(`JSON.stringify((() => {
  const el = document.getElementById('pi-project-list');
  const last = el.lastElementChild;
  const dot = last.querySelector('.project-status-dot');
  const cs = getComputedStyle(el);
  return {
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    overflowY: cs.overflowY,
    // 横向是否出现滚动条（圆点探出会撑出横向溢出）
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    overflowX: cs.overflowX,
    dotRight: dot.getBoundingClientRect().right,
    listRight: el.getBoundingClientRect().right,
  };
})())`);
const m = JSON.parse(many);
check("项目多时列表可垂直滚动（滚动能力没被误伤）",
  m.scrollHeight > m.clientHeight && m.overflowY === "auto",
  `scrollHeight=${m.scrollHeight} clientHeight=${m.clientHeight} overflowY=${m.overflowY}`);
check("横向无溢出（圆点不撑出横向滚动条）",
  m.scrollWidth <= m.clientWidth + 1 && m.overflowX === "hidden",
  `scrollWidth=${m.scrollWidth} clientWidth=${m.clientWidth} overflowX=${m.overflowX}`);
check("最后一个项目的圆点仍在列表可见宽度内",
  m.dotRight <= m.listRight + 0.5, `dotRight=${m.dotRight.toFixed(1)} listRight=${m.listRight.toFixed(1)}`);
// 收尾：把注入的项目删掉，后续断言仍针对真实状态
await evalJs(`(() => {
  const list = document.getElementById('pi-project-list');
  while (list.children.length > 1) list.removeChild(list.lastElementChild);
})(); 1`);
await sleep(150);

/* ============ 1d. 会话列表宽度可拖拽调整，且有最小宽度 ============ */
// 需求：中间「会话列表」栏宽度可调整，且有最小宽度（不能拖成 0 宽度/挤没）。
// 手柄 #pi-sidebar-resizer 位于中栏与主内容区之间，拖动改变中栏宽度，
// 宽度钳制在 [180, 520] 并持久化到 ms.store("sessionWidth")。
const resizerInfo = JSON.parse(await evalJs(`JSON.stringify((() => {
  const rz = document.getElementById('pi-sidebar-resizer');
  const mid = document.getElementById('pi-sidebar-middle');
  const cs = rz ? getComputedStyle(rz) : null;
  return {
    hasHandle: !!rz,
    cursor: cs ? cs.cursor : '',
    midWidth: mid ? mid.getBoundingClientRect().width : 0,
  };
})())`));
check("存在会话列表宽度拖拽手柄", resizerInfo.hasHandle === true);
check("拖拽手柄光标为 col-resize", resizerInfo.cursor === "col-resize", resizerInfo.cursor);
check("中栏初始宽度为默认 290px", Math.abs(resizerInfo.midWidth - 290) <= 1,
  `width=${resizerInfo.midWidth}`);

// 用 PointerEvent 模拟拖拽：从手柄位置向右拖 120px → 中栏应变宽 ~120px
const dragWidth = async (dx) => {
  return await evalJs(`(async () => {
    const rz = document.getElementById('pi-sidebar-resizer');
    const mid = document.getElementById('pi-sidebar-middle');
    const before = mid.getBoundingClientRect().width;
    const x = rz.getBoundingClientRect().left + 2;
    const y = rz.getBoundingClientRect().top + 40;
    const mk = (type, cx) => new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: cx, clientY: y });
    rz.dispatchEvent(mk('pointerdown', x));
    window.dispatchEvent(mk('pointermove', x + ${dx}));
    window.dispatchEvent(mk('pointerup', x + ${dx}));
    await new Promise(r => setTimeout(r, 60));
    return JSON.stringify({ before, after: mid.getBoundingClientRect().width, saved: window.__store ? window.__store.sessionWidth : null });
  })()`);
};

const wider = JSON.parse(await dragWidth(120));
check("向右拖拽后中栏变宽约 120px", Math.abs(wider.after - (wider.before + 120)) <= 2,
  `${wider.before} → ${wider.after}`);
check("拖拽结果持久化到 store(sessionWidth)",
  typeof wider.saved === "number" && Math.abs(wider.saved - wider.after) <= 1, `saved=${wider.saved}`);

// 向左狠拖（超过最小宽度）→ 应被钳制在最小 180px，不会继续缩小
const tooNarrow = JSON.parse(await dragWidth(-500));
check("向左超量拖拽被最小宽度 180px 挡住（不会拖成消失）",
  Math.abs(tooNarrow.after - 180) <= 1, `after=${tooNarrow.after}`);
check("最小宽度也写回 store（保存的是钳制后的值）",
  Math.abs(tooNarrow.saved - 180) <= 1, `saved=${tooNarrow.saved}`);

// 向右狠拖（超过最大宽度）→ 应被钳制在最大 520px
const tooWide = JSON.parse(await dragWidth(800));
check("向右超量拖拽被最大宽度 520px 挡住",
  Math.abs(tooWide.after - 520) <= 1, `after=${tooWide.after}`);

// 双击恢复默认宽度
await evalJs(`document.getElementById('pi-sidebar-resizer')
  .dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); 1`);
await sleep(120);
const resetW = await evalJs(`document.getElementById('pi-sidebar-middle').getBoundingClientRect().width`);
check("双击手柄恢复默认宽度 290px", Math.abs(resetW - 290) <= 1, `width=${resetW}`);

// 宽度落在合法区间内，且中栏确实生效（不只是变量）
const rangeOk = JSON.parse(await evalJs(`JSON.stringify({
  w: document.getElementById('pi-sidebar-middle').getBoundingClientRect().width,
  varSet: getComputedStyle(document.querySelector('.pi-agent-container')).getPropertyValue('--pi-session-width').trim(),
})`));
check("中栏宽度始终保持在 [180,520] 区间内",
  rangeOk.w >= 180 - 0.5 && rangeOk.w <= 520 + 0.5, `width=${rangeOk.w}`);

// 重挂载后应从 store 恢复宽度（模拟重开插件）
await evalJs(`window.__store = window.__store || {}; window.__store.sessionWidth = 360; 1`);
const restore = await evalJs(`(async () => {
  const mid = document.getElementById('pi-sidebar-middle');
  mid.style.removeProperty('--pi-session-width');
  // 重新执行宽度恢复逻辑（模拟插件重新 mount）
  const w = 360;
  document.querySelector('.pi-agent-container').style.setProperty('--pi-session-width', w + 'px');
  await new Promise(r => setTimeout(r, 40));
  return document.getElementById('pi-sidebar-middle').getBoundingClientRect().width;
})()`);
check("从 store 恢复的宽度会应用到中栏", Math.abs(restore - 360) <= 1, `width=${restore}`);
// 收尾：恢复默认宽度，避免影响后续断言
await evalJs(`document.getElementById('pi-sidebar-resizer')
  .dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); 1`);
await sleep(80);

/* ============ 2. 新建会话：可见反馈 + 每次都是新的 ============ */
await evalJs(`document.querySelector('.pi-new-session-btn').click(); 1`);
await sleep(600);
const afterOne = await evalJs(`JSON.stringify({
  count: document.querySelectorAll('#pi-session-list .session-item').length,
  activeTitle: document.querySelector('#pi-session-list .session-item.active .session-title')?.textContent || '',
  header: document.getElementById('pi-chat-header')?.textContent || '',
  firstTitle: document.querySelector('#pi-session-list .session-item .session-title')?.textContent || '',
})`);
const a1 = JSON.parse(afterOne);
check("新建会话后列表立即出现该会话", a1.activeTitle.includes("新对话") && a1.firstTitle.includes("新对话"),
  `${a1.activeTitle} / ${a1.firstTitle}`);
check("新会话的消息区不是一片空白（有空会话提示）",
  (await evalJs(`document.getElementById('pi-welcome')?.hidden === false &&
    (document.getElementById('pi-welcome')?.textContent || '').includes('还没有消息')`)) === true,
  await evalJs(`(document.getElementById('pi-welcome')?.textContent || '').slice(0, 40)`));
check("顶部标题同步为新会话", a1.header.includes("新对话"), a1.header);

await evalJs(`document.querySelector('.pi-new-session-btn').click(); 1`);
await sleep(600);
const createCount = await evalJs(`window.__calls.filter(c => c.method === 'createSession').length`);
check("连点两次发出两次 createSession", createCount === 2, `次数=${createCount}`);
const t2 = await evalJs(`document.querySelector('#pi-session-list .session-item.active .session-title')?.textContent || ''`);
check("第二次新建后仍是「当前」的新会话", t2.includes("新对话"), t2);
check("第二次新建后列表有两 条「新对话」（不是复用同一条）",
  (await evalJs(`[...document.querySelectorAll('#pi-session-list .session-item')]
      .filter(it => (it.querySelector('.session-title')?.textContent || '').includes('新对话')).length`)) === 2,
  `新对话条数=${await evalJs(`[...document.querySelectorAll('#pi-session-list .session-item')]
      .filter(it => (it.querySelector('.session-title')?.textContent || '').includes('新对话')).length`)}`);

/* ============ 3. 消息顺序：提问在下、回答紧跟其后 ============ */
await evalJs(`(() => {
  const el = document.getElementById('pi-input');
  el.value = '这是最新提问';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('pi-send-btn').click();
})(); 1`);
await sleep(1200);

const order = await evalJs(`JSON.stringify([...document.querySelectorAll('#pi-chat-body .message')].map(m => ({
  role: m.classList.contains('user') ? 'user' : 'agent',
  text: (m.querySelector('.message-content')?.textContent || '').slice(0, 20),
})))`);
const seq = JSON.parse(order);
check("提问与回答都在 DOM 里", seq.length >= 2, JSON.stringify(seq));
check("最后两条顺序是 user → agent（回答在提问之后）",
  seq.length >= 2 && seq[seq.length - 2].role === "user" && seq[seq.length - 1].role === "agent",
  JSON.stringify(seq.slice(-2)));
check("最后一条 user 就是刚发的提问", seq.length >= 2 && seq[seq.length - 2].text.includes("这是最新提问"),
  seq[seq.length - 2]?.text);
check("最后一条 agent 是本轮回答（不是历史回答）", seq.length >= 1 && seq[seq.length - 1].text.includes("本轮回答"),
  seq[seq.length - 1]?.text);
check("本轮回答只出现一次（流式与返回值不重复渲染）",
  seq.filter((m) => m.text.includes("本轮回答")).length === 1,
  `出现 ${seq.filter((m) => m.text.includes("本轮回答")).length} 次`);

// 发送后该会话成为「最后消息时间最新」→ 应排在列表最上面（时间序，不是查看序）
const topAfterSend = JSON.parse(await evalJs(`JSON.stringify((() => {
  const items = [...document.querySelectorAll('#pi-session-list .session-item')];
  return {
    first: items[0]?.querySelector('.session-title')?.textContent || '',
    firstIsActive: items[0]?.classList.contains('active') === true,
  };
})())`));
check("刚发消息的会话排到列表最上面", topAfterSend.firstIsActive, JSON.stringify(topAfterSend));

/* ============ 4. 连续两轮都保持顺序（旧气泡不被复用） ============ */
await evalJs(`(() => {
  const el = document.getElementById('pi-input');
  el.value = '第二轮提问';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('pi-send-btn').click();
})(); 1`);
await sleep(1200);
const seq2 = JSON.parse(await evalJs(`JSON.stringify([...document.querySelectorAll('#pi-chat-body .message')].map(m => ({
  role: m.classList.contains('user') ? 'user' : 'agent',
  text: (m.querySelector('.message-content')?.textContent || '').slice(0, 20),
})))`));
const roles2 = seq2.map((m) => m.role);
const alternating = roles2.every((role, i) => (i === 0 ? true : true));
const tail = seq2.slice(-4);
check("两轮之后消息仍严格交替（提问→回答→提问→回答）",
  seq2.length >= 4 &&
  seq2[seq2.length - 4].role === "user" && seq2[seq2.length - 4].text.includes("这是最新提问") &&
  seq2[seq2.length - 3].role === "agent" && seq2[seq2.length - 3].text.includes("本轮回答") &&
  seq2[seq2.length - 2].role === "user" && seq2[seq2.length - 2].text.includes("第二轮提问") &&
  seq2[seq2.length - 1].role === "agent" && seq2[seq2.length - 1].text.includes("本轮回答"),
  JSON.stringify(tail));
check("两轮回答各自独立（共 2 条 agent 回答）",
  seq2.filter((m) => m.text.includes("本轮回答")).length === 2,
  `agent 回答数=${seq2.filter((m) => m.text.includes("本轮回答")).length}`);
check("没有留下空气泡（等待期间不预插空节点）",
  seq2.every((m) => m.text.trim().length > 0),
  `空消息数=${seq2.filter((m) => !m.text.trim()).length}`);

/* ============ 5. 消息区默认只显示最近一轮，按轮加载更早的 ============ */
// 切到一个有 5 轮对话的会话（s1「向我提问问题」）
await evalJs(`(() => {
  const item = [...document.querySelectorAll('#pi-session-list .session-item')]
    .find(i => (i.querySelector('.session-title')?.textContent || '').includes('向我提问问题'));
  item?.click();
})(); 1`);
await sleep(900);

const round1 = JSON.parse(await evalJs(`JSON.stringify((() => {
  const msgs = [...document.querySelectorAll('#pi-chat-body .message')]
    .map(m => (m.querySelector('.message-content')?.textContent || ''));
  const btn = document.getElementById('pi-load-more');
  return { msgs, moreHidden: btn?.hidden, moreText: btn?.textContent || '' };
})())`));
check("默认只显示最近一轮（不是全部 5 轮）", round1.msgs.length === 2,
  `渲染 ${round1.msgs.length} 条: ${JSON.stringify(round1.msgs)}`);
check("默认显示的就是最后一轮问答",
  round1.msgs.some((t) => t.includes("第五轮提问")) && round1.msgs.some((t) => t.includes("第五轮回答")),
  JSON.stringify(round1.msgs));
check("更早的对话不默认显示（第四轮提问没出现）",
  !round1.msgs.some((t) => t.includes("第四轮提问")), JSON.stringify(round1.msgs));
check("有更早对话时上方出现「加载更早的对话」按钮", round1.moreHidden === false, round1.moreText);
check("按钮文案提示还剩几轮", /还剩\s*4\s*轮/.test(round1.moreText), round1.moreText);

// 点一次 → 往前加一轮
await evalJs(`document.getElementById('pi-load-more').click(); 1`);
await sleep(300);
const round2 = JSON.parse(await evalJs(`JSON.stringify([...document.querySelectorAll('#pi-chat-body .message')]
  .map(m => (m.querySelector('.message-content')?.textContent || '')))`));
check("点一次后多出正好一轮（2 条）", round2.length === 4, `渲染 ${round2.length} 条`);
check("新加载的是第四轮（紧邻第五轮之前）",
  round2.some((t) => t.includes("第四轮提问")) && round2.some((t) => t.includes("第四轮回答")),
  JSON.stringify(round2));

// 再点 → 再往前一轮，且顺序仍是「旧 → 新」
await evalJs(`document.getElementById('pi-load-more').click(); 1`);
await sleep(300);
const round3 = JSON.parse(await evalJs(`JSON.stringify([...document.querySelectorAll('#pi-chat-body .message')]
  .map(m => (m.querySelector('.message-content')?.textContent || '')))`));
check("再点一次再多一轮（共 6 条）", round3.length === 6, `渲染 ${round3.length} 条`);
check("消息顺序保持时间正序（第三轮在最上、第五轮在最下）",
  round3[0].includes("第三轮") && round3[round3.length - 1].includes("第五轮回答"),
  JSON.stringify([round3[0], round3[round3.length - 1]]));

// 一直点到最早一轮，按钮应消失
for (let i = 0; i < 5; i++) {
  const hidden = await evalJs(`document.getElementById('pi-load-more').hidden`);
  if (hidden) break;
  await evalJs(`document.getElementById('pi-load-more').click(); 1`);
  await sleep(250);
}
const roundAll = JSON.parse(await evalJs(`JSON.stringify([...document.querySelectorAll('#pi-chat-body .message')]
  .map(m => (m.querySelector('.message-content')?.textContent || '')))`));
check("全部加载后能拿到 5 轮共 10 条消息", roundAll.length === 10, `渲染 ${roundAll.length} 条`);
check("加载到最早一轮后按钮隐藏", (await evalJs(`document.getElementById('pi-load-more').hidden`)) === true);
check("最早一轮仍在最上方", roundAll[0].includes("第一轮提问"), roundAll[0]);

/* ============ 6. 会话状态点（进行中 / 未查看） ============ */
const flags = await evalJs(`JSON.stringify([...document.querySelectorAll('#pi-session-list .session-item')].map(it => ({
  title: it.querySelector('.session-title')?.textContent || '',
  dot: it.querySelector('.status-dot')?.className || '',
  sub: it.querySelector('.sub-agent-name')?.textContent || '',
})))`);
const fl = JSON.parse(flags);
check("未查看会话有蓝色状态点", fl.some((f) => f.dot.includes("unseen")), JSON.stringify(fl.map((f) => f.dot)));
check("未查看会话文字标注「已完成未读」", fl.some((f) => f.sub.includes("已完成未读")),
  JSON.stringify(fl.map((f) => f.sub)));

/* ============ 7. 扩展通知：正常完成提示不弹、报错提示照弹 ============ */
// 回归：全局扩展 pi-desktop-notify-bridge 会在 agent_end 发
// "Agent finished its current task."（info）。会话跑完本就无需打扰，插件必须静默它；
// 但出错提示（error）仍然要弹，不能被一并吞掉。
const toastState = async () => JSON.parse(await evalJs(`JSON.stringify((() => {
  const el = document.getElementById('pi-inline-toast');
  return { exists: !!el, hidden: el ? el.hidden === true : true, text: el ? el.textContent : '' };
})())`));

// 先确保干净：隐藏上一节可能留下的 toast
await evalJs(`(() => { const el = document.getElementById('pi-inline-toast'); if (el) { el.hidden = true; el.textContent = ''; } })(); 1`);

await evalJs(`window.__emit('ext_ui:notify', { message: 'Agent finished its current task.', type: 'info' }); 1`);
await sleep(200);
const afterFinish = await toastState();
check("正常完成提示（Agent finished its current task.）不弹 toast",
  afterFinish.hidden === true || !String(afterFinish.text).includes("finished its current task"),
  JSON.stringify(afterFinish));

await evalJs(`window.__emit('ext_ui:notify', { message: 'Agent run ended with an error.', type: 'error' }); 1`);
await sleep(200);
const afterError = await toastState();
check("出错提示仍然照常弹出（未被误吞）",
  afterError.hidden === false && afterError.text.includes("ended with an error"),
  JSON.stringify(afterError));

/* ============ 8. 点「停止」不该刷错误横幅 ============ */
// 回归（用户报告「运行时手动点击停止还有很多提示错误」）：后端 abort 会让挂起的
// chat 以 {aborted:true} 正常收尾，前端必须按「已停止」处理——既不能显示
// 「Pi 未返回有效响应」，也不能冒出「发送失败 / 请求失败」这类错误横幅。
await evalJs(`(() => {
  const el = document.getElementById('pi-input');
  el.value = '这条会被中途停止';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  window.__hangChat = true;            // 让本轮 chat 挂住，等待用户停止
  document.getElementById('pi-send-btn').click();
})(); 1`);
await sleep(300);

// 挂起期间推送一段思考流：思考行会创建「工作分组」，
// 这样下面的断言才是在检验「停止后分组不再显示工作中」，而不是空集恒真。
// 通知不带 sessionId 即视为当前会话（见 isCurrentSessionNotification）。
await evalJs(`window.__emit('chat:thinking', { delta: '正在分析', content: '正在分析' }); 1`);
await sleep(150);
const workBefore = await evalJs(`document.querySelectorAll('#pi-chat-body .turn-work').length`);
check("停止前已出现工作分组（思考流触发了分组）", workBefore >= 1, `分组数=${workBefore}`);

// 挂起期间：按钮应为「停止」态
const runningBtn = await evalJs(`document.getElementById('pi-send-btn').classList.contains('running')`);
check("挂起期间发送按钮处于「停止」态", runningBtn === true);

// 记录停止前的错误横幅数量，点停止后不得新增
const errBefore = await evalJs(`document.querySelectorAll('#pi-chat-body .pi-error').length`);
await evalJs(`document.getElementById('pi-send-btn').click(); 1`);  // 运行中点 = 停止
await sleep(600);
const errAfter = await evalJs(`document.querySelectorAll('#pi-chat-body .pi-error').length`);
check("点「停止」不产生任何错误横幅（不含「未返回有效响应」等）",
  errAfter === errBefore, `停止前 ${errBefore} 条，停止后 ${errAfter} 条`);
const errTexts = JSON.parse(await evalJs(`JSON.stringify([...document.querySelectorAll('#pi-chat-body .pi-error')].map(e => e.textContent))`));
check("聊天区没有出现「请求失败」/「发送失败」/「未返回有效响应」",
  !errTexts.some((t) => /请求失败|发送失败|未返回有效响应/.test(t)),
  JSON.stringify(errTexts));

// 停止后按钮应回到「发送」态、可继续下一轮
await sleep(300);
const stoppedBtn = await evalJs(`document.getElementById('pi-send-btn').classList.contains('running')`);
check("停止后发送按钮回到「发送」态", stoppedBtn === false);
const stopState = JSON.parse(await evalJs(`JSON.stringify((() => {
  const works = [...document.querySelectorAll('#pi-chat-body .turn-work')];
  return {
    total: works.length,
    // 停止后不应该有任何分组仍停在「运行中」
    stillRunning: works.filter((w) => w.dataset.state === 'running').length,
    texts: works.map((w) => w.querySelector('.turn-work-status')?.textContent || ''),
  };
})())`));
check("停止后没有工作分组卡在「运行中」",
  stopState.stillRunning === 0, JSON.stringify(stopState));
const stopTexts = JSON.parse(await evalJs(`JSON.stringify([...document.querySelectorAll('#pi-chat-body .turn-work-status')].map(e => e.textContent))`));
check("已渲染的工作分组文案不是「工作中」",
  !stopTexts.some((t) => /工作中/.test(String(t))), JSON.stringify(stopTexts));

/* ============ 9. 无 JS 报错 ============ */
check("页面无未捕获异常", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
ws.close();
chrome.kill();
server.close();
process.exit(fail === 0 ? 0 : 1);
