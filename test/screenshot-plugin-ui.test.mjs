/**
 * 截图插件前台的「最近 7 天 + 分页」逻辑测试。
 *
 * 走本仓库既有 UI 测试的路子：起一个静态服务器 + 用真实浏览器（Chrome/Edge，
 * 走 CDP）加载一个「假宿主页」，把插件脚本按宿主的方式注入执行。
 * 没有装浏览器时自动跳过（与 baidu-plugin-e2e / *_ui.test.mjs 一致）。
 *
 * 钉死的契约（都是需求里最容易写错的地方）：
 *   1. 只显示最近 7 天的截图（第 8 天的必须被过滤掉）
 *   2. 分页：每页 24 张；整页边界不多出空页；最后一页显示余数
 *   3. 「最近 7 天 N 张」= 过滤后；「共 M 张」= 全部（含 7 天外）
 *   4. 有数据不显示空态、显示分页；无数据显示空态、隐藏分页
 *   5. 缩略图**只读当前页**（不做全量读取——每张都是完整 PNG 的 base64）
 *   6. 快捷键展示 ctrl+alt+x → Ctrl+Alt+X；空值 → 「未设置」
 *   7. 交互：开始截图调 openOverlay；解绑提交空键值；点卡片打开大图
 *
 * 用法: node test/screenshot-plugin-ui.test.mjs
 */
import { createServer } from "http";
import { readFile } from "fs/promises";
import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = path.join(root, "plugins", "screenshot");

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

let pass = 0;
let fail = 0;
function ok(cond, name, extra = "") {
  if (cond) {
    pass++;
    console.log("PASS ", name, extra ? ` — ${extra}` : "");
  } else {
    fail++;
    console.log("FAIL ", name, extra ? ` — ${extra}` : "");
  }
}

/* ===================== 静态服务器：提供插件界面 + 假宿主页 ===================== */

const html = await readFile(path.join(pluginDir, "ui", "detail.html"), "utf8");
const code = await readFile(path.join(pluginDir, "ui", "index.js"), "utf8");
const css = await readFile(path.join(pluginDir, "ui", "detail.css"), "utf8");

/**
 * 假宿主页：把插件的 detail.html 塞进容器（与宿主 inlay 做法一致），
 * 再用 new Function 注入 ms API 执行插件脚本。
 *
 * 注意 `safe()`：被嵌入的 HTML/JS 里含 `</script>`（插件 HTML 里就有），
 * 直接 JSON.stringify 会让浏览器**提前结束脚本标签**——必须把 `</` 转义成 `<\/`。
 */
const safe = (s) => JSON.stringify(s).replace(/<\//g, "<\\/");

function harnessPage() {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>${css.replace(/<\//g, "<\\/")}</style></head>
<body>
<div id="mount"></div>
<script>
const PLUGIN_HTML = ${safe(html)};
const PLUGIN_CODE = ${safe(code)};

window.__ssRun = async function (opts) {
  const shots = opts.shots || [];
  const shortcut = opts.shortcut === undefined ? "ctrl+alt+x" : opts.shortcut;
  const calls = { readShot: [], remove: [], copy: [], setShortcut: [], openOverlay: 0 };

  document.getElementById("mount").innerHTML = PLUGIN_HTML;
  // 把 calls 挂到 window 上：按钮点击发生在 __ssRun resolve 之后，
  // 靠返回值快照读不到，必须在页面里读这个活对象。
  window.__ssCalls = calls;

  const ms = {
    plugin: { id: "com.zhuangjie.screenshot", info: { theme: "inherit" } },
    log: () => {},
    ui: { confirm: async () => true, toast: () => {} },
    store: { _d: {}, get(k, f) { return k in this._d ? this._d[k] : f; }, set(k, v) { this._d[k] = v; } },
    screenshot: {
      list: async () => shots,
      readShot: async (rel) => { calls.readShot.push(rel); return "data:image/png;base64,iVBORw0KGgo="; },
      remove: async (rel) => { calls.remove.push(rel); return true; },
      copy: async (url) => { calls.copy.push(url); return true; },
      getShortcut: async () => shortcut,
      setShortcut: async (k) => { calls.setShortcut.push(k); return k; },
      openOverlay: async () => { calls.openOverlay++; return 1; },
      onSaved: () => () => {},
    },
  };

  const fn = new Function(
    "ms","env","plugin","host","keyword","inputValue",
    "onSubKeyword","md2html","openExternal",
    '"use strict";\\n' + PLUGIN_CODE
  );
  fn(ms, {}, { id: "com.zhuangjie.screenshot" }, document.getElementById("app"),
     "截图", "", () => {}, (s) => s, () => {});

  // 等 promise 链（list → render → 缩略图队列）跑完
  await new Promise((r) => setTimeout(r, 200));
  return calls;
};

window.__ss = {
  calls: () => window.__ssCalls,
  cards: () => document.querySelectorAll(".ss-card").length,
  text: (sel) => {
    const el = document.querySelector(sel);
    return el ? el.textContent.trim() : null;
  },
  hidden: (sel) => {
    const el = document.querySelector(sel);
    return el ? el.hidden : null;
  },
  disabled: (sel) => {
    const el = document.querySelector(sel);
    return el ? el.disabled : null;
  },
  click: (sel) => document.querySelector(sel).dispatchEvent(new MouseEvent("click", { bubbles: true })),
  clickCard: (i) => document.querySelectorAll(".ss-card")[i].dispatchEvent(new MouseEvent("click", { bubbles: true })),
};
</script>
</body></html>`;
}

const server = createServer(async (req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  if (u === "/" || u === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(harnessPage());
    return;
  }
  try {
    const file = path.join(pluginDir, u.replace(/^\//, ""));
    if (!file.startsWith(pluginDir)) return res.writeHead(403).end("forbidden");
    const body = await readFile(file);
    const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" }[path.extname(file)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
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
  console.log("未找到浏览器（Chrome/Edge），跳过截图插件 UI 测试");
  server.close();
  process.exit(0);
}

/* ===================== 起浏览器 + CDP ===================== */

const userDir = path.join(root, "test", "_chrome-profile-screenshot-ui");
const port = 9250 + Math.floor(Math.random() * 200);
const chrome = spawn(bin, [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userDir}`,
  "--headless=new",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--disable-sync",
  "--disable-features=msEdgeSyncConfirmationDialog,EdgeSidebar",
  "--window-size=1280,900",
  base,
], { stdio: "ignore" });

/** 等 CDP 端点可用，并**只挑我们自己那个页面**（Edge 会额外开
 *  edge://sync-confirmation-dialog/ 之类的页面，按 type 取第一个会挑错）。 */
async function cdpTarget() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await r.json();
      const page = list.find(
        (t) => t.type === "page" && t.webSocketDebuggerUrl && String(t.url).startsWith(base)
      );
      if (page) return page;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("浏览器 CDP 未就绪（未找到目标页面）");
}

let ws;
let msgId = 0;
const pending = new Map();

async function connect() {
  const target = await cdpTarget();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = (e) => reject(new Error("WebSocket 连接失败"));
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id != null && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(JSON.stringify(m.error)));
      else resolve(m.result);
    }
  };
}

function send(method, params) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}

/** 在页面里求值（awaitPromise 支持 async 函数） */
async function evaluate(expr) {
  const r = await send("Runtime.evaluate", {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error("页面求值异常: " + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails));
  }
  return r.result.value;
}

/** 造 n 张截图，时间从 NOW 往前每张差 stepMs */
function makeShots(n, stepMs) {
  return Array.from({ length: n }, (_, i) => {
    const t = NOW - i * stepMs;
    return { relPath: `shots/shot-${i}.png`, name: `shot-${i}.png`, size: 1000 + i, mtimeMs: t, createdAt: new Date(t).toISOString() };
  });
}

/** 造一张 mtimeMs 精确落在「距今 daysAgo 天」的截图（边界测试用） */
function shotAgo(daysAgo, i = 0) {
  const t = NOW - daysAgo * DAY;
  return { relPath: `shots/edge-${daysAgo}-${i}.png`, name: `edge-${daysAgo}-${i}.png`, size: 1, mtimeMs: t, createdAt: new Date(t).toISOString() };
}

const run = (opts) => evaluate(`window.__ssRun(${JSON.stringify(opts)})`);

try {
  await connect();
  await new Promise((r) => setTimeout(r, 400));

  /* ---------------- 1. 7 天过滤 ---------------- */
  {
    // 30 张、每张间隔 **1 天 + 1 小时**：第 0..6 张明确在窗口内、第 8 张起明确在窗口外。
    // 刻意避开「第 7 张恰好压线」——那取决于毫秒级时序，测边界另有专门用例。
    const step = DAY + 3600_000;
    const calls = await run({ shots: makeShots(30, step) });
    const n = await evaluate("window.__ss.cards()");
    ok(n === 7, "只显示最近 7 天的截图（30 张里取 7 张）", `实际 ${n} 张`);

    const meta = await evaluate("window.__ss.text('#ss-meta')");
    ok(meta.includes("最近 7 天 7 张"), "统计显示过滤后张数", meta);
    ok(meta.includes("共 30 张"), "统计显示全部张数（含 7 天外）", meta);
    ok(calls.readShot.length === 7, "只读这 7 张的缩略图", `读了 ${calls.readShot.length} 张`);
  }

  {
    // 边界：6.9 天前在窗口内、7.1 天前在窗口外
    await run({ shots: [shotAgo(6.9), shotAgo(7.1)] });
    const n = await evaluate("window.__ss.cards()");
    ok(n === 1, "7 天边界：6.9 天前保留、7.1 天前剔除", `实际 ${n} 张`);
  }

  {
    const calls = await run({ shots: makeShots(5, 3600_000) });
    ok((await evaluate("window.__ss.cards()")) === 5, "7 天内的全部保留");
    ok((await evaluate("window.__ss.hidden('#ss-empty')")) === true, "有数据时不显示空态（hidden=true）");
    ok((await evaluate("window.__ss.hidden('#ss-pager')")) === false, "有数据时显示分页（即使只有一页）");
    ok((await evaluate("window.__ss.text('#ss-pageinfo')")) === "第 1 / 1 页", "单页页码文案");
    ok(calls.readShot.length === 5, "缩略图读取数 = 卡片数");
  }

  {
    // 全部明确超过 7 天（8/9/10/11 天前）→ 应显示空态
    await run({ shots: [shotAgo(8, 1), shotAgo(9, 2), shotAgo(10, 3), shotAgo(11, 4)] });
    ok((await evaluate("window.__ss.cards()")) === 0, "全部超过 7 天 → 无卡片");
    ok((await evaluate("window.__ss.hidden('#ss-empty')")) === false, "无数据时显示空态（hidden=false）");
    ok((await evaluate("window.__ss.hidden('#ss-pager')")) === true, "无数据时隐藏分页（hidden=true）");
    ok((await evaluate("window.__ss.text('#ss-meta')")).includes("最近 7 天 0 张"), "0 命中时统计照常刷新");
  }

  /* ---------------- 2. 分页 ---------------- */
  {
    const calls = await run({ shots: makeShots(60, 60_000) });
    ok((await evaluate("window.__ss.cards()")) === 24, "第 1 页显示 24 张");
    ok((await evaluate("window.__ss.text('#ss-pageinfo')")) === "第 1 / 3 页", "60 张 → 3 页");
    ok((await evaluate("window.__ss.disabled('#ss-prev')")) === true, "第 1 页「上一页」禁用");
    ok((await evaluate("window.__ss.disabled('#ss-next')")) === false, "第 1 页「下一页」可用");
    ok(calls.readShot.length === 24, "只读当前页 24 张（不做全量读取）", `读了 ${calls.readShot.length} 张`);

    await evaluate("window.__ss.click('#ss-next')");
    await new Promise((r) => setTimeout(r, 150));
    ok((await evaluate("window.__ss.cards()")) === 24, "第 2 页仍是 24 张");
    ok((await evaluate("window.__ss.text('#ss-pageinfo')")) === "第 2 / 3 页", "翻页后页码更新");
    ok((await evaluate("window.__ss.disabled('#ss-prev')")) === false, "第 2 页「上一页」可用");

    await evaluate("window.__ss.click('#ss-next')");
    await new Promise((r) => setTimeout(r, 150));
    ok((await evaluate("window.__ss.cards()")) === 12, "最后一页显示余数 12 张");
    ok((await evaluate("window.__ss.text('#ss-pageinfo')")) === "第 3 / 3 页", "到最后一页");
    ok((await evaluate("window.__ss.disabled('#ss-next')")) === true, "最后一页「下一页」禁用");
  }
  {
    await run({ shots: makeShots(24, 60_000) });
    ok((await evaluate("window.__ss.text('#ss-pageinfo')")) === "第 1 / 1 页", "整页边界不多出空页");
  }
  {
    await run({ shots: makeShots(25, 60_000) });
    ok((await evaluate("window.__ss.text('#ss-pageinfo')")) === "第 1 / 2 页", "25 张 → 2 页");
  }

  /* ---------------- 3. 快捷键展示 ---------------- */
  {
    await run({ shots: makeShots(1, 60_000), shortcut: "ctrl+alt+x" });
    await new Promise((r) => setTimeout(r, 60));
    ok((await evaluate("window.__ss.text('#ss-hotkey-btn')")) === "Ctrl+Alt+X", "快捷键展示为 Ctrl+Alt+X");
  }
  {
    await run({ shots: makeShots(1, 60_000), shortcut: "" });
    await new Promise((r) => setTimeout(r, 60));
    ok((await evaluate("window.__ss.text('#ss-hotkey-btn')")) === "未设置", "无绑定时显示「未设置」");
    ok((await evaluate("window.__ss.hidden('#ss-hotkey-clear')")) === true, "无绑定时「解绑」按钮隐藏");
  }

  /* ---------------- 4. 交互 ---------------- */
  {
    await run({ shots: makeShots(3, 60_000) });

    await evaluate("window.__ss.click('#ss-shot')");
    await new Promise((r) => setTimeout(r, 80));
    ok((await evaluate("window.__ss.calls().openOverlay")) === 1, "点「开始截图」调起宿主遮罩");

    await evaluate("window.__ss.click('#ss-hotkey-clear')");
    await new Promise((r) => setTimeout(r, 80));
    const sc = await evaluate("window.__ss.calls().setShortcut");
    ok(Array.isArray(sc) && sc[0] === "", "点「解绑」提交空键值", JSON.stringify(sc));

    await evaluate("window.__ss.clickCard(0)");
    await new Promise((r) => setTimeout(r, 150));
    ok((await evaluate("window.__ss.hidden('#ss-viewer')")) === false, "点卡片打开大图预览（hidden=false）");
  }
  {
    await run({ shots: makeShots(3, 60_000) });
    await evaluate("window.__ss.click('.ss-card-del')");
    await new Promise((r) => setTimeout(r, 200));
    const rm = await evaluate("window.__ss.calls().remove");
    ok(Array.isArray(rm) && rm.length === 1, "点卡片上的 ✕ 触发删除", JSON.stringify(rm));
    ok(rm[0] && rm[0].startsWith("shots/"), "删除用的是相对路径", JSON.stringify(rm));
  }
} finally {
  try { ws?.close(); } catch {}
  try { chrome.kill(); } catch {}
  server.close();
}

console.log("");
if (fail > 0) {
  console.error(`结果: ${fail} 项失败（${pass} 通过）`);
  process.exit(1);
}
console.log(`结果: 全部通过（${pass} 项）`);
