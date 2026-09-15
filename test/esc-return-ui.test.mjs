/**
 * 回归测试：详情视图（简述内容 / 附加内容）打开时，输入框失焦后按 Esc 仍能返回。
 *
 * 背景（用户反馈）：
 *   查看附加内容时点一下内容区，输入框就失焦了；此时按 Esc 没有反应，回不到结果列表。
 *   期望：Esc 返回不应依赖输入框是否聚焦。
 *
 * 规则：
 *   - 详情视图打开时，Esc = 返回（关闭详情，恢复结果列表 / 等待搜索）
 *   - 其它状态，Esc = 隐藏窗口（与输入框聚焦时一致）
 *   - 输入框聚焦时，Esc 不应被重复处理（捕获阶段拦截后不再冒泡到 input 的 keydown）
 *
 * 做法：用 CDP 打开构建产物 index.html，注入假的 __TAURI_INTERNALS__ 录制 hide 调用，
 * 走真实交互路径（输入 → 打开 vassal → 失焦 → 派发 Esc），断言 #text_show 关闭。
 *
 * 用法: npm run build && node test/esc-return-ui.test.mjs
 * 需要本机装有 Chrome / Edge；找不到浏览器时跳过（退出码 0）。
 */
import { createServer } from "http";
import { readFile, mkdir, rm } from "fs/promises";
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
  ".png": "image/png",
  ".svg": "image/svg+xml",
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
  server.close();
  process.exit(0);
}
const profile = path.join(root, "test", `_chrome-profile-esc-${process.pid}`);
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
    pageErrors.push("EXC: " + (m.params.exceptionDetails.exception?.description || ""));
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
  const r = await S("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval failed");
  return r.result.value;
};

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 真实按键（走 CDP Input 通道，等价于用户敲键盘） */
const pressKey = async (key, code, vk) => {
  await S("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await S("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await sleep(250);
};
const pressEsc = () => pressKey("Escape", "Escape", 27);

// ---- 注入 Tauri 桥 ----
await S("Page.addScriptToEvaluateOnNewDocument", {
  source: `
    window.__invoked = [];
    window.__openedUrls = [];
    window.__windowHideCount = 0;
    window.__TAURI_INTERNALS__ = {
      invoke(cmd, args) {
        window.__invoked.push(cmd);
        if (cmd === 'set_window_height') { return Promise.resolve(null); }
        if (cmd === 'open_url') { window.__openedUrls.push(args.url); return Promise.resolve(null); }
        // 窗口当前可见 → hideWindow() 会真正调用 hide
        if (cmd === 'plugin:window|is_visible') { return Promise.resolve(true); }
        if (cmd === 'plugin:window|hide') { window.__windowHideCount++; return Promise.resolve(null); }
        return Promise.resolve(null);
      },
      transformCallback(cb) { return cb; },
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      plugins: {},
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(){} };
  `,
});

const SEED = `(() => {
  const items = [
    {
      title: '附加内容测试项', desc: '带 vassal 的项',
      resource: 'https://example.com/pages/[[{keyword}]]',
      vassal: '# 附加内容标题\\n\\n这里是附加内容正文，关键词是 微信。',
    },
    { title: '普通项', desc: '普通 URL 项', resource: 'https://example.com/plain/[[{keyword}]]' },
  ];
  items.forEach((it, i) => { it.index = i; });
  const subs = '<tis::https://example.com/test.ms title="测试订阅" />';
  localStorage.setItem('my-search-desktop:SEARCH_DATA_KEY', JSON.stringify({
    data: items, expire: Date.now() + 12 * 3600 * 1000, failedUrls: [],
  }));
  localStorage.setItem('my-search-desktop:subscribes', JSON.stringify(subs));
  localStorage.setItem('my-search-desktop:SUBSCRIBE_FINGERPRINT_CACHE_KEY',
    JSON.stringify('https://example.com/test.ms|测试订阅||'));
  return items.length;
})()`;

await S("Page.navigate", { url: base + "/empty.html" });
await sleep(400);
await evalJs(`localStorage.clear(); 1`);
await evalJs(SEED);
await S("Page.navigate", { url: base + "/index.html" });
await sleep(1400);

const typeKeyword = async (kw) => {
  await evalJs(`(() => {
    const input = document.getElementById('my_search_input');
    input.focus();
    input.value = ${JSON.stringify(kw)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(750);
};
const openVassal = async () => {
  await evalJs(`(() => { const a = document.querySelector('#matchItems a.vassal'); if (a) a.click(); })()`);
  await sleep(350);
};
const detailDisplay = () => evalJs(`document.getElementById('text_show').style.display`);
const listDisplay = () => evalJs(`document.getElementById('matchResult').style.display`);

// ---- 1. 打开附加内容（输入框失焦）→ Esc 返回 ----
await typeKeyword("附加内容");
const rowCount = await evalJs(`document.querySelectorAll('#matchItems li').length`);
check("结果列表已渲染", rowCount >= 1, `rows=${rowCount}`);
check("存在 vassal 图标", (await evalJs(`!!document.querySelector('#matchItems a.vassal')`)) === true);

await openVassal();
check("附加内容视图已打开", (await detailDisplay()) === "block");

await evalJs(`document.getElementById('my_search_input').blur()`);
const activeEl = await evalJs(`document.activeElement && (document.activeElement.id || document.activeElement.tagName)`);
check("输入框已失焦", activeEl !== "my_search_input", `activeElement=${activeEl}`);

await pressEsc();
check("输入框失焦时 Esc 返回（关闭附加内容）", (await detailDisplay()) === "none", `display=${await detailDisplay()}`);
check("返回后结果列表恢复显示", (await listDisplay()) === "block");

// ---- 2. 输入框仍聚焦时 Esc 也返回（且不重复触发）----
await openVassal();
await evalJs(`document.getElementById('my_search_input').focus()`);
const hideCountBefore = await evalJs(`window.__windowHideCount`);
await pressEsc();
check("输入框聚焦时 Esc 返回（关闭附加内容）", (await detailDisplay()) === "none", `display=${await detailDisplay()}`);
const hideCountAfter = await evalJs(`window.__windowHideCount`);
check(
  "详情视图打开时 Esc 只返回、不隐藏窗口",
  hideCountAfter === hideCountBefore,
  `windowHide前=${hideCountBefore} 后=${hideCountAfter}`
);

// ---- 3. 无详情视图时 Esc = 隐藏窗口 ----
await evalJs(`document.getElementById('my_search_input').blur()`);
const hideBefore3 = await evalJs(`window.__windowHideCount`);
await pressEsc();
await sleep(300);
const hideAfter3 = await evalJs(`window.__windowHideCount`);
check("无详情视图时 Esc 隐藏窗口", hideAfter3 === hideBefore3 + 1, `hide次数 ${hideBefore3} → ${hideAfter3}`);

check("无未捕获页面异常", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);

ws.close();
proc.kill();
server.close();
await rm(profile, { recursive: true, force: true }).catch(() => {});
process.exit(failed.length || pageErrors.length ? 1 : 0);
