/**
 * pi-agent UI 回归测试（真实浏览器 + 真实插件 UI 文件 + mock 后端）。
 *
 * 覆盖用户截图上标注的四个问题：
 *   1. 左栏项目图标角标撑出幽灵滚动条        → #pi-project-list 无垂直溢出
 *   2. 角标口径（已完成未查看 + 进行中）      → 与历史总数区分，不再是 99+
 *   3. 「新建会话」没有反馈                   → 列表立即出现新会话且标「当前」，
 *                                             连点两次得到两个不同会话
 *   4. 提问在下、回答跑到上面（刷新才正常）    → DOM 顺序恒为 user → agent
 *
 * 用法: node test/pi-agent-ui.test.mjs
 */
import { createServer } from "http";
import { readFile, rm } from "fs/promises";
import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = path.join(root, "plugins", "pi-agent", "ui");

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
const chrome = spawn(
  bin,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--window-size=880,700`,
    "--remote-debugging-port=0",
    `--user-data-dir=${userDir}`,
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] }
);
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
    // 夹具里共 33 条会话（2 待处理 + 1 普通 + 30 历史）
    totalInFixture: 33,
  };
})())`);
const il = JSON.parse(initList);
check("会话列表默认不铺开全部会话（33 条不能全列出来）", il.titles.length < il.totalInFixture,
  `默认显示 ${il.titles.length} 条 / 共 ${il.totalInFixture} 条`);
check("待处理会话（已完成未查看）始终显示", il.titles.some((t) => t.includes("向我提问问题")),
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

/* ============ 1. 左栏不出现幽灵滚动条 ============ */
const rail = await evalJs(`JSON.stringify((() => {
  const el = document.getElementById('pi-project-list');
  const badge = document.querySelector('#pi-project-list .status-badge');
  const icon = document.querySelector('#pi-project-list .project-icon');
  const cs = getComputedStyle(el);
  return {
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    overflowY: cs.overflowY,
    hasBadge: !!badge,
    badgeText: badge?.textContent || '',
    // 角标是否探出列表的可滚动区域
    badgeRight: badge ? badge.getBoundingClientRect().right : 0,
    listRight: el.getBoundingClientRect().right,
    iconRight: icon ? icon.getBoundingClientRect().right : 0,
  };
})())`);
const r = JSON.parse(rail);
check("左栏项目列表无垂直溢出（角标不再撑出滚动条）", r.scrollHeight <= r.clientHeight + 1,
  `scrollHeight=${r.scrollHeight} clientHeight=${r.clientHeight}`);
check("项目角标仍在（口径改为未查看+进行中）", r.hasBadge === true, r.badgeText);
check("角标数字不是历史会话总数 99+", r.badgeText !== "99+" && r.badgeText !== "120", `badge=${r.badgeText}`);
check("角标完全落在图标可见区内（不被 overflow 裁掉）", r.badgeRight <= r.listRight + 0.5,
  `badgeRight=${r.badgeRight.toFixed(1)} listRight=${r.listRight.toFixed(1)}`);

// 项目多到需要滚动时：滚动条要正常出现，且角标不被横向裁切
await evalJs(`(() => {
  const list = document.getElementById('pi-project-list');
  for (let i = 0; i < 12; i++) {
    const d = document.createElement('div');
    d.className = 'project-icon';
    d.textContent = 'P' + i;
    const b = document.createElement('span');
    b.className = 'status-badge green';
    b.textContent = '2';
    d.appendChild(b);
    list.appendChild(d);
  }
})(); 1`);
await sleep(200);
const many = await evalJs(`JSON.stringify((() => {
  const el = document.getElementById('pi-project-list');
  const last = el.lastElementChild;
  const badge = last.querySelector('.status-badge');
  const cs = getComputedStyle(el);
  return {
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    overflowY: cs.overflowY,
    // 横向是否出现滚动条（角标探出会撑出横向溢出）
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    overflowX: cs.overflowX,
    badgeRight: badge.getBoundingClientRect().right,
    listRight: el.getBoundingClientRect().right,
  };
})())`);
const m = JSON.parse(many);
check("项目多时列表可垂直滚动（滚动能力没被误伤）",
  m.scrollHeight > m.clientHeight && m.overflowY === "auto",
  `scrollHeight=${m.scrollHeight} clientHeight=${m.clientHeight} overflowY=${m.overflowY}`);
check("横向无溢出（角标不撑出横向滚动条）",
  m.scrollWidth <= m.clientWidth + 1 && m.overflowX === "hidden",
  `scrollWidth=${m.scrollWidth} clientWidth=${m.clientWidth} overflowX=${m.overflowX}`);
check("最后一个项目的角标仍在列表可见宽度内",
  m.badgeRight <= m.listRight + 0.5, `badgeRight=${m.badgeRight.toFixed(1)} listRight=${m.listRight.toFixed(1)}`);
// 收尾：把注入的项目删掉，后续断言仍针对真实状态
await evalJs(`(() => {
  const list = document.getElementById('pi-project-list');
  while (list.children.length > 1) list.removeChild(list.lastElementChild);
})(); 1`);
await sleep(150);

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
check("未查看会话文字标注「已完成未查看」", fl.some((f) => f.sub.includes("已完成未查看")),
  JSON.stringify(fl.map((f) => f.sub)));

/* ============ 6. 无 JS 报错 ============ */
check("页面无未捕获异常", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
ws.close();
chrome.kill();
server.close();
process.exit(fail === 0 ? 0 : 1);
