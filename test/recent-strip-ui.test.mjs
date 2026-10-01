/**
 * 「最近添加」条带（Alt 条带）的真实浏览器回归：
 *   1. **进入子搜索模式自动展开**——关键词出现 `" : "`（SEARCH_BOUNDARY）时，
 *      搜索框下方的 #recentStrip 自动显示（等价于按一次 Alt）；
 *   2. **左右溢出「隧道」效果**——右侧还有被裁内容时挂 .fade-right；向左滚过时
 *      挂 .fade-left、滚到最右则 .fade-right 消失、回到最左 .fade-left 消失；
 *   3. 离开子搜索模式（Shift+Tab 去掉分隔符）→ 条带对称收起；
 *   4. 全程无未捕获页面异常。
 *
 * 做法：用 CDP 打开构建产物 index.html，注入假的 __TAURI_INTERNALS__，seed
 * localStorage 里的「最近添加」历史（RECENT_ATTACH_KEY），走真实交互路径
 * （聚焦输入 → 输入父关键词 → Tab / Shift+Tab、程序改 scrollLeft）后断言 DOM。
 *
 * 用法: npm run build && node test/recent-strip-ui.test.mjs
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

const profile = path.join(root, "test", `_chrome-profile-recent-strip-${process.pid}`);
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
const pressKey = async (opts) => {
  const { key, code, vk, modifiers = 0 } = opts;
  await S("Input.dispatchKeyEvent", {
    type: "keyDown",
    key,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    modifiers,
  });
  await S("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    modifiers,
  });
  await sleep(300);
};
const pressTab = () => pressKey({ key: "Tab", code: "Tab", vk: 9 });
// Shift=8 是 CDP 的修饰键位掩码（Alt=1 / Ctrl=2 / Meta=4 / Shift=8）
const pressShiftTab = () => pressKey({ key: "Tab", code: "Tab", vk: 9, modifiers: 8 });

// ---- 注入 Tauri 桥 ----
await S("Page.addScriptToEvaluateOnNewDocument", {
  source: `
    window.__invoked = [];
    window.__TAURI_INTERNALS__ = {
      invoke(cmd, args) {
        window.__invoked.push(cmd);
        if (cmd === 'set_window_height') { return Promise.resolve(null); }
        if (cmd === 'plugin:window|is_visible') { return Promise.resolve(true); }
        return Promise.resolve(null);
      },
      transformCallback(cb) { return cb; },
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      plugins: {},
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(){} };
  `,
});

// 20 条带长名的历史：确保在窄视口下一定横向溢出，能稳定触发隧道效果
const SEED = `(() => {
  const items = [
    {
      title: '父关键词命中项', desc: '用于进入子搜索模式后仍有结果',
      resource: 'https://example.com/plain',
    },
  ];
  items.forEach((it, i) => { it.index = i; });
  const subs = '<tis::https://example.com/test.ms title="测试订阅" />';
  localStorage.setItem('my-search-desktop:SEARCH_DATA_KEY', JSON.stringify({
    data: items, expire: Date.now() + 12 * 3600 * 1000, failedUrls: [],
  }));
  localStorage.setItem('my-search-desktop:subscribes', JSON.stringify(subs));
  localStorage.setItem('my-search-desktop:SUBSCRIBE_FINGERPRINT_CACHE_KEY',
    JSON.stringify('https://example.com/test.ms|测试订阅||'));
  const recent = [];
  for (let i = 0; i < 20; i++) {
    recent.push({ kind: 'file', name: '一个名字相当长的历史文件_' + i + '.docx',
      path: 'C:/demo/一个名字相当长的目录_' + i + '/一个名字相当长的历史文件_' + i + '.docx' });
  }
  localStorage.setItem('my-search-desktop:RECENT_ATTACH_KEY', JSON.stringify(recent));
  return recent.length;
})()`;

// 窄视口：保证 20 条长名一定横向溢出（隧道效果可达）
await S("Emulation.setDeviceMetricsOverride", { width: 420, height: 260, deviceScaleFactor: 1, mobile: false });
await S("Page.navigate", { url: base + "/empty.html" });
await sleep(400);
await evalJs(`localStorage.clear(); 1`);
await evalJs(SEED);
await S("Page.navigate", { url: base + "/index.html" });
await sleep(1500);

const stripClass = () => evalJs(`document.getElementById('recentStrip').className`);
const stripShown = async () => (await stripClass()).split(/\s+/).includes("show");
const hasFade = async (side) => (await stripClass()).split(/\s+/).includes("fade-" + side);
const setInput = async (kw) => {
  await evalJs(`(() => {
    const input = document.getElementById('my_search_input');
    input.focus();
    input.value = ${JSON.stringify(kw)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(650);
};
/** 等一帧 + rAF：让 queueUpdateStripEdges 的 rAF 回填 class */
const settle = () => sleep(220);

/* ---------------- 1. 初始：不在子搜索模式，条带不显示 ---------------- */
await setInput("父关键词");
check("普通搜索（无分隔符）→ 条带不显示", (await stripShown()) === false, `class=${await stripClass()}`);

/* ---------------- 2. Tab 进入子搜索模式 → 自动展开 ---------------- */
await evalJs(`document.getElementById('my_search_input').focus(); 1`);
await pressTab();
const valAfterTab = await evalJs(`document.getElementById('my_search_input').value`);
check("Tab 进入子搜索模式（值含 ' : '）", valAfterTab.includes(" : "), `value=${JSON.stringify(valAfterTab)}`);
check("进入子搜索模式 → 条带自动显示", (await stripShown()) === true, `class=${await stripClass()}`);

const items = await evalJs(`document.querySelectorAll('#recentStrip .recent-item').length`);
check("条带渲染出历史条目", items === 20, `items=${items}`);

/* ---------------- 3. 溢出隧道效果：右侧 / 左侧 ---------------- */
const geo = await evalJs(`(() => {
  const el = document.getElementById('recentStrip');
  return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
})()`);
check("条带确实横向溢出（前置条件）", geo.scrollWidth > geo.clientWidth, JSON.stringify(geo));

await evalJs(`document.getElementById('recentStrip').scrollLeft = 0; 1`);
await settle();
check("停在最左 → 有右渐隐（.fade-right）", (await hasFade("right")) === true, `class=${await stripClass()}`);
check("停在最左 → 无左渐隐", (await hasFade("left")) === false, `class=${await stripClass()}`);

// 滚到最右：右渐隐消失、左渐隐出现
await evalJs(`(() => { const el = document.getElementById('recentStrip'); el.scrollLeft = el.scrollWidth; return el.scrollLeft; })()`);
await settle();
check("滚到最右 → 出现左渐隐（.fade-left）", (await hasFade("left")) === true, `class=${await stripClass()}`);
check("滚到最右 → 右渐隐消失", (await hasFade("right")) === false, `class=${await stripClass()}`);

// 滚回最左：左渐隐消失、右渐隐回来
await evalJs(`document.getElementById('recentStrip').scrollLeft = 0; 1`);
await settle();
check("回到最左 → 左渐隐消失", (await hasFade("left")) === false, `class=${await stripClass()}`);
check("回到最左 → 右渐隐回来", (await hasFade("right")) === true, `class=${await stripClass()}`);

/* ---------------- 4. Shift+Tab 离开子搜索模式 → 条带收起 ---------------- */
await evalJs(`document.getElementById('my_search_input').focus(); 1`);
await pressShiftTab();
const valAfterShiftTab = await evalJs(`document.getElementById('my_search_input').value`);
check("Shift+Tab 退出子搜索模式（值不含 ' : '）", !valAfterShiftTab.includes(" : "), `value=${JSON.stringify(valAfterShiftTab)}`);
check("离开子搜索模式 → 条带自动收起", (await stripShown()) === false, `class=${await stripClass()}`);

/* ---------------- 5. 无异常 ---------------- */
check("无未捕获页面异常", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);

ws.close();
proc.kill();
server.close();
await rm(profile, { recursive: true, force: true }).catch(() => {});
process.exit(failed.length || pageErrors.length ? 1 : 0);
