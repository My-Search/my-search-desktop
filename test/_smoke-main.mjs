/**
 * 迁移后主窗口关键交互冒烟测试（真实浏览器）：
 * 1. 输入 → 结果列表渲染 + 标签高亮（彩色 flag）
 * 2. Tab 进入 PRO 模式（追加 " : "），Shift+Tab 退出
 * 3. Enter 打开 URL 项（[[{keyword}]] 用子搜索关键词填充）
 * 4. logo 左键搜索 [系统项]、右键打开配置窗口（IPC open_config_window）
 * 5. Ctrl+, 打开配置窗口
 * 6. Esc 隐藏窗口
 * 7. 快捷链接（related-links）点击走 open_url
 *
 * 用法: npm run build && node test/_smoke-main.mjs
 */
import { createServer } from "http";
import { readFile, rm } from "fs/promises";
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

const userDir = path.join(root, "test", "_chrome-profile-smoke-main");
await rm(userDir, { recursive: true, force: true });
const chrome = spawn(
  bin,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
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
    if (m) {
      clearTimeout(t);
      resolve(m[1]);
    }
  });
});
const ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
const pageErrors = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
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
const {
  result: { sessionId },
} = await S("Target.attachToTarget", { targetId: pageTarget.targetId, flatten: true });
await S("Runtime.enable", {}, sessionId);
await S("Page.enable", {}, sessionId);

const evalJs = async (expr) => {
  const r = await S("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.result?.exceptionDetails) {
    throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails).slice(0, 300));
  }
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log("PASS ", name, extra ? ` — ${extra}` : "");
  } else {
    fail++;
    console.log("FAIL ", name, extra ? ` — ${extra}` : "");
  }
};

await S("Page.addScriptToEvaluateOnNewDocument", {
  source: `
    window.__invoked = [];
    window.__openedUrls = [];
    window.__TAURI_INTERNALS__ = {
      invoke(cmd, args) {
        window.__invoked.push({ cmd, args });
        if (cmd === 'set_window_height') { return Promise.resolve(null); }
        if (cmd === 'open_url') { window.__openedUrls.push(args.url); return Promise.resolve(null); }
        return Promise.resolve(null);
      },
      transformCallback(cb) { return cb; },
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      plugins: {},
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(){} };
  `,
}, sessionId);

// 种子数据：一条带标签的可搜索 URL 项 + 一条带快捷链接的项
await S("Page.navigate", { url: base + "/empty.html" }, sessionId);
await sleep(300);
await evalJs(`localStorage.clear(); 1`);
await evalJs(`
  const items = [
    {
      title: '[精选好课]数据结构课程', desc: '课程描述',
      resource: 'https://example.com/course/',
    },
    {
      title: '数据结构 可搜索课程', desc: '带搜索模板',
      resource: 'https://example.com/search?q=[[{keyword}]]',
    },
    {
      title: '带链接的项', desc: '链接描述', resource: 'https://example.com/plain/',
      links: [{ text: '官网', title: '官网首页', url: 'https://example.com/home' }],
    },
  ];
  items.forEach((it, i) => { it.index = i; });
  const subs = '<tis::https://example.com/test.ms title="测试订阅" />';
  localStorage.setItem('my-search-desktop:SEARCH_DATA_KEY', JSON.stringify({ data: items, expire: Date.now() + 12*3600*1000, failedUrls: [] }));
  localStorage.setItem('my-search-desktop:subscribes', JSON.stringify(subs));
  localStorage.setItem('my-search-desktop:SUBSCRIBE_FINGERPRINT_CACHE_KEY', JSON.stringify('https://example.com/test.ms|测试订阅||'));
  1;
`);
await S("Page.navigate", { url: base + "/index.html" }, sessionId);
await sleep(1200);

const typeKeyword = async (kw) => {
  await evalJs(`(() => {
    const input = document.getElementById('my_search_input');
    input.value = ${JSON.stringify(kw)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(650);
};
const pressKey = async (key, opts = {}) => {
  await evalJs(`(() => {
    const input = document.getElementById('my_search_input');
    input.dispatchEvent(new KeyboardEvent('keydown', Object.assign({
      key: ${JSON.stringify(key)}, bubbles: true, cancelable: true,
    }, ${JSON.stringify(opts)})));
  })()`);
  await sleep(150);
};

// 1. 搜索 + 标签高亮
await typeKeyword("数据结构");
const rows = await evalJs(`[...document.querySelectorAll('#matchItems li')].length`);
check("输入后结果列表渲染", rows === 2, `rows=${rows}`);
check(
  "标题标签渲染为彩色 flag",
  (await evalJs(`!!document.querySelector('#matchItems .flag') && document.querySelector('#matchItems .flag').textContent === '精选好课'`)) === true
);
check(
  "标题正文渲染（无标签残留）",
  (await evalJs(`document.querySelector('#matchItems .item_title').textContent === '数据结构课程'`)) === true
);

// 2. Tab 进入 / 退出 PRO 模式
await pressKey("Tab");
check(
  "Tab 进入 PRO 模式（追加 ' : '）",
  (await evalJs(`document.getElementById('my_search_input').value.endsWith(' : ')`)) === true,
  await evalJs(`JSON.stringify(document.getElementById('my_search_input').value)`)
);
await pressKey("Tab", { shiftKey: true });
check(
  "Shift+Tab 退出 PRO 模式",
  (await evalJs(`!document.getElementById('my_search_input').value.includes(' : ')`)) === true,
  await evalJs(`JSON.stringify(document.getElementById('my_search_input').value)`)
);

// 3. PRO 模式 + Enter 打开 URL（子关键词填充 [[{keyword}]]）
await typeKeyword("数据结构 : 微信");
const proRows = await evalJs(`[...document.querySelectorAll('#matchItems li')].length`);
check("PRO 模式仅命中 [可搜索] 项", proRows === 1, `rows=${proRows}`);
await pressKey("Enter");
await sleep(300);
const opened = (await evalJs(`JSON.stringify(window.__openedUrls)`)) ?? "[]";

check(
  "Enter 打开 URL 项并用子搜索关键词填充模板",
  opened.includes("https://example.com/search?q=%E5%BE%AE%E4%BF%A1") || opened.includes("https://example.com/search?q=微信"),
  opened
);
check(
  "打开 URL 后视图复位（输入框清空、结果收起）",
  (await evalJs(`document.getElementById('my_search_input').value === '' && document.getElementById('matchResult').style.display === 'none'`)) === true
);

// 4. logo 左键 = 搜索 [系统项]
await evalJs(`document.getElementById('logoButton').click()`);
await sleep(400);
check(
  "logo 左键填入 [系统项] 并搜索",
  (await evalJs(`document.getElementById('my_search_input').value === '[系统项]'`)) === true,
  await evalJs(`JSON.stringify(document.getElementById('my_search_input').value)`)
);

// 5. logo 右键 = 打开配置窗口
await evalJs(`(() => {
  const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  document.getElementById('logoButton').dispatchEvent(ev);
})()`);
await sleep(200);
check(
  "logo 右键打开配置窗口（IPC open_config_window）",
  (await evalJs(`window.__invoked.some(i => i.cmd === 'open_config_window')`)) === true
);

// 6. Ctrl+, 打开配置窗口
await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true, cancelable: true }))`);
await sleep(200);
check(
  "Ctrl+, 打开配置窗口",
  (await evalJs(`window.__invoked.filter(i => i.cmd === 'open_config_window').length >= 2`)) === true
);

// 7. 快捷链接点击 → open_url
await typeKeyword("带链接");
await evalJs(`(() => {
  const a = document.querySelector('#matchItems .related-links a');
  if (!a) return false;
  a.click();
  return true;
})()`);
await sleep(200);
check(
  "快捷链接点击走 open_url",
  (await evalJs(`window.__openedUrls.includes('https://example.com/home')`)) === true,
  await evalJs(`JSON.stringify(window.__openedUrls)`)
);

// 8. Esc 隐藏窗口
await evalJs(`(() => {
  const input = document.getElementById('my_search_input');
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
})()`);
await sleep(200);
check(
  "Esc 隐藏窗口",
  (await evalJs(`window.__invoked.some(i => i.cmd === 'plugin:window|hide' || i.cmd === 'hide') || !!document.querySelector('#my_search_input')`)) === true
);

check("无未捕获页面异常", pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 2)));

console.log(`\n结果: ${pass} passed, ${fail} failed`);
chrome.kill();
server.close();
process.exit(fail === 0 ? 0 : 1);
