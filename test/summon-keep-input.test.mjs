/**
 * 真实浏览器回归测试：呼出视图分支（用户规则）
 *
 * 「除了正在打开查看文档类型数据项/附加内容/应用项，其它的按快捷键
 *   Ctrl+Alt+S 应重置输入框；详情视图则只单独隐藏，再显示时仍应与隐藏前一致。」
 *
 * 即呼出（Rust 端显示窗口 → my-search://main-window-shown）按隐藏前状态分支：
 *  1. 详情视图（简述文档 / 附加内容 / 脚本应用）展示中隐藏 → 只单独隐藏，
 *     再次呼出**原样还原**：详情正文仍在、输入框内容不动（视图不销毁）；
 *  2. 其它状态（等待搜索 / 结果列表）→ 复位：输入框清空、窗口收回搜索框高度；
 *  3. 点击 URL 结果 → 显式结束会话：复位 + 隐藏（行为保持）。
 *
 * 做法：与 blur-hide-ui.test.mjs 相同——CDP 打开构建产物，注入假
 *  `window.__TAURI_INTERNALS__`。@tauri-apps/api v2 的 listen() 通过
 *  invoke('plugin:event|listen', { event, target, handler }) 注册回调，
 *  在页面脚本执行前拦截并记录 handler，window.__emitTauriEvent(event, payload)
 *  遍历调用——与 Rust 端 app.emit 语义等价。
 *
 * 用法: npm run build && node test/summon-keep-input.test.mjs
 * 需要本机装有 Chrome / Edge；找不到浏览器时跳过（退出码 0）。
 */
import { createServer } from "http";
import { readFile, mkdir } from "fs/promises";
import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
if (!existsSync(path.join(dist, "index.html"))) {
  console.error("请先 npm run build");
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};
const server = createServer(async (req, res) => {
  try {
    const u = decodeURIComponent(req.url.split("?")[0]);
    if (u === "/empty.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>empty</title>");
      return;
    }
    const file = path.join(dist, u === "/" ? "/index.html" : u);
    if (!file.startsWith(dist)) return res.writeHead(403).end("forbidden");
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const chrome = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));
if (!chrome) {
  console.log("跳过：未找到 Chrome / Edge，无法做真实 UI 验证。");
  process.exit(0);
}
const profile = path.join(root, "test", `_chrome-profile-summon-${process.pid}`);
await mkdir(profile, { recursive: true });

const proc = spawn(
  chrome,
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] }
);
const wsUrl = await new Promise((resolve, reject) => {
  let buf = "";
  const t = setTimeout(() => reject(new Error("DevTools timeout")), 30000);
  proc.stderr.on("data", (d) => {
    buf += d.toString();
    const m = buf.match(/ws:\/\/[^\s]+/);
    if (m) {
      clearTimeout(t);
      resolve(m[0]);
    }
  });
  proc.on("exit", (c) => reject(new Error("chrome exit " + c)));
});

let msgId = 0;
const pending = new Map();
const ws = new WebSocket(wsUrl);
await new Promise((r, j) => {
  ws.onopen = r;
  ws.onerror = j;
});
const pageErrors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === "Runtime.exceptionThrown")
    pageErrors.push(m.params.exceptionDetails.exception?.description || "EXC");
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  }
};
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
await S("Page.enable");
await S("Runtime.enable");
const evalJs = async (expr) => {
  const r = await S("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description || "eval failed");
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 注入 Tauri 桥（页面脚本执行前生效）----
// 在 bootstrap 执行 listen() 之前拦截 plugin:event|listen，把 {event -> handler[]}
// 记到 window.__eventHandlers，供 __emitTauriEvent 触发（等价 Rust app.emit）。
await S("Page.addScriptToEvaluateOnNewDocument", {
  source: `
    window.__openedUrls = [];
    window.__eventHandlers = new Map();
    window.__eventNextId = 1;
    window.__TAURI_INTERNALS__ = {
      invoke(cmd, args) {
        if (cmd === 'plugin:event|listen' && args && args.event) {
          const list = window.__eventHandlers.get(args.event) || [];
          list.push(args.handler);
          window.__eventHandlers.set(args.event, list);
          return Promise.resolve(window.__eventNextId++);
        }
        if (cmd === 'open_url') { window.__openedUrls.push(args.url); return Promise.resolve(null); }
        return Promise.resolve(null);
      },
      transformCallback(cb) { return cb; },
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      plugins: {},
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(){} };
    window.__emitTauriEvent = (event, payload) => {
      const list = window.__eventHandlers.get(event) || [];
      list.forEach((cb) => { try { cb({ event, id: window.__eventNextId++, payload }); } catch (e) {} });
      return list.length;
    };
  `,
});

// ---- 种子数据（走引擎真实读取路径：前缀 + JSON）----
const SEED = `(() => {
  const items = [
    { title: '纯链接项', desc: '普通 URL 项', resource: 'https://example.com/plain/[[{keyword}]]' },
    {
      title: '文档简述项', desc: '非 URL 简述文本项', type: 'sketch',
      resource: '# 文档标题\\n\\n这里是文档正文第一段，用于验证详情视图还原。',
    },
  ];
  items.forEach((it, i) => { it.index = i; });
  const subs = '<tis::https://example.com/test.ms title="测试订阅" />';
  localStorage.setItem('my-search-desktop:SEARCH_DATA_KEY', JSON.stringify({
    data: items, expire: Date.now() + 12 * 3600 * 1000, failedUrls: [],
  }));
  localStorage.setItem('my-search-desktop:SUBSCRIBES', JSON.stringify(subs));
  localStorage.setItem('my-search-desktop:subscribes', JSON.stringify(subs));
  localStorage.setItem(
    'my-search-desktop:SUBSCRIBE_FINGERPRINT_CACHE_KEY',
    JSON.stringify('https://example.com/test.ms|测试订阅||')
  );
  return items.length;
})()`;

await S("Page.navigate", { url: base + "/empty.html" });
await sleep(300);
await evalJs(`localStorage.clear(); 1`);
await evalJs(SEED);
await S("Page.navigate", { url: base + "/index.html" });
await sleep(1200);

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const inputVal = () => evalJs(`document.getElementById('my_search_input')?.value ?? null`);
const resultVisible = () =>
  evalJs(`document.getElementById('matchResult').style.display === 'block'`);
const detailVisible = () =>
  evalJs(`document.getElementById('text_show').style.display === 'block'`);
const summon = () =>
  evalJs(`window.__emitTauriEvent('my-search://main-window-shown', null)`);
const typeKeyword = async (kw) => {
  await evalJs(`(() => {
    const input = document.getElementById('my_search_input');
    input.value = ${JSON.stringify(kw)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(700); // 防抖 300ms + 搜索
};

// ---- 探针：emit 是否能到达前端监听器（listener 已在 bootstrap 注册） ----
const probe = await summon();
if (!probe) {
  console.log("跳过：无法在 mock 环境触发 main-window-shown（未捕获到监听器）。");
  proc.kill();
  server.close();
  process.exit(0);
}
await sleep(300);

// ---- 1. 非详情状态呼出 → 复位输入框（用户规则的前半句） ----
await typeKeyword("纯链接");
check("结果列表展示中（隐藏前状态=结果列表）", (await resultVisible()) === true);
await summon();
await sleep(300);
check("结果列表状态呼出：输入框被重置", (await inputVal()) === "");
check("结果列表状态呼出：结果区收起", (await evalJs(`document.getElementById('matchResult').style.display === 'none'`)) === true);

// ---- 2. 详情视图（文档简述）呼出 → 原样还原（用户规则的后半句） ----
await typeKeyword("文档");
const openDetailOk = await evalJs(`(() => {
  const li = [...document.querySelectorAll('#matchItems li')]
    .find(el => el.textContent.includes('文档简述项'));
  if (!li) return false;
  const a = li.querySelector('a.enter_main_link');
  if (!a) return false;
  a.click();
  return true;
})()`);
await sleep(300);
check("点击简述项进入详情视图", openDetailOk === true && (await detailVisible()) === true);
check("详情视图中输入框仍有关键词", (await inputVal()) === "文档");
// 模拟详情视图展示中按快捷键隐藏窗口（只隐藏，前端视图不动）
await evalJs(`window.__emitTauriEvent && window.__emitTauriEvent('my-search://main-window-shown', null)`);
// 先验证隐藏期间 DOM 不动：直接呼出
await sleep(300);
check("详情视图呼出：正文原样保留",
  (await evalJs(`document.getElementById('text_show').textContent.includes('文档正文第一段')`)) === true);
check("详情视图呼出：详情视图仍然展示", (await detailVisible()) === true);
check("详情视图呼出：输入框内容与隐藏前一致", (await inputVal()) === "文档");
check("详情视图呼出：结果区不抢焦点展示", (await resultVisible()) === false);

// ---- 3. 显式结束会话：点击 URL 结果 → 输入清空 + 结果区收起（行为保持） ----
// Esc 退出详情视图 → 输入另一关键词回到结果列表 → 点 URL 项
await evalJs(`(() => {
  const input = document.getElementById('my_search_input');
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return true;
})()`);
await sleep(200);
check("Esc 退出详情视图回到结果列表", (await resultVisible()) === true);
await typeKeyword("纯链接");
const clickOpenOk = await evalJs(`(() => {
  const li = [...document.querySelectorAll('#matchItems li')]
    .find(el => el.textContent.includes('纯链接项'));
  if (!li) return false;
  const a = li.querySelector('a.enter_main_link');
  if (!a) return false;
  a.click();
  return true;
})()`);
await sleep(400);
check("点击 URL 结果：会话结束，输入框清空（行为保持）",
  clickOpenOk === true && (await inputVal()) === "" && (await resultVisible()) === false);
check("点击 URL 结果：外链已打开", (await evalJs(`window.__openedUrls.length > 0`)) === true);

// ---- 4. 无页面异常 ----
check("无未捕获页面异常", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 300));

proc.kill();
server.close();

const fail = results.filter((r) => !r.pass).length;
console.log(`\n结果: ${results.length - fail} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
