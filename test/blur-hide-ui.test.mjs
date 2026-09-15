/**
 * 真实浏览器验证：失焦隐藏不再按视图状态「豁免」
 * （用户规则：点窗口外面时，不管在干什么都先隐藏；唤醒后再原样显示）。
 *
 * 旧实现里前端会按当前视图调用 `set_hide_on_blur(hide)` 同步给 Rust，
 * 详情视图/搜索中/`:debug` 会同步 `false`（即「失焦不隐藏」）。
 * 新实现把「失焦即隐藏」完全交给 Rust 侧无条件执行（`on_window_event`
 * 收到 `Focused(false)` 即隐藏），前端**不再**发送任何 `set_hide_on_blur`。
 *
 * 因此本测试用假 `window.__TAURI_INTERNALS__` 录制全部 IPC，走真实交互路径验证：
 *  1. 结果列表展示中：不发送 set_hide_on_blur（Rust 无条件隐藏，无需同步）
 *  2. 打开「附加内容」（vassal）→ 视图真的挂上，且**不发送** set_hide_on_blur
 *  3. 打开脚本应用（脚本项 view:html/css/js）→ 视图真的挂上，且不发送
 *  4. 输入 `:debug` → 不发送
 *  5. 全程 IPC 里从未出现 set_hide_on_blur / setHideOnBlur（旧门控已彻底移除）
 *  6. 运行期间无未捕获页面异常
 *
 * 用法: npm run build && node test/blur-hide-ui.test.mjs
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
    if (u.startsWith("/__external__")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>external</title>");
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
const profile = path.join(root, "test", `_chrome-profile-blur-${process.pid}`);
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
const pageConsole = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === "Runtime.exceptionThrown")
    pageErrors.push("EXC: " + (m.params.exceptionDetails.exception?.description || ""));
  if (m.method === "Runtime.consoleAPICalled") {
    const p = m.params;
    if (["error", "warning", "log"].includes(p.type)) {
      pageConsole.push(`[${p.type}] ` + p.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200));
    }
  }
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

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 前端是否发送过旧的状态门控 IPC（新实现应当全程为 0 次） */
const blurSyncCount = () =>
  evalJs(`(window.__invoked || []).filter(c => c === 'set_hide_on_blur' || c === 'setHideOnBlur').length`);

/** 在搜索框里输入并等待结果渲染 */
const typeKeyword = async (kw) => {
  await evalJs(`(() => {
    const input = document.getElementById('my_search_input');
    input.value = ${JSON.stringify(kw)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(700); // 防抖 300ms + 搜索
};

const clickResultByTitle = (title) =>
  evalJs(`(() => {
    const li = [...document.querySelectorAll('#matchItems li')]
      .find(el => el.textContent.includes(${JSON.stringify(title)}));
    if (!li) return false;
    const a = li.querySelector('a.enter_main_link');
    if (!a) return false;
    a.click();
    return true;
  })()`);

// ---- 注入 Tauri 桥（页面脚本执行前生效）----
await S("Page.addScriptToEvaluateOnNewDocument", {
  source: `
    window.__invoked = [];
    window.__openedUrls = [];
    window.__TAURI_INTERNALS__ = {
      invoke(cmd, args) {
        window.__invoked.push(cmd);
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
});

// ---- 种子数据（走引擎真实读取路径：前缀 + JSON）----
const SEED = `(() => {
  const items = [
    {
      title: '附加内容测试项', desc: '带 vassal 的项',
      resource: 'https://example.com/pages/[[{keyword}]]',
      vassal: '# 附加内容标题\\n\\n这里是附加内容正文，关键词是 微信。',
    },
    {
      title: "[h'脚本']脚本应用测试项", desc: '脚本项', type: 'sketch',
      resource: [
        '-- env --',
        '',
        '-- script --',
        'function (obj) { obj.view.mount(); }',
        '-- view:html --',
        '<div id="app-probe">脚本应用已挂载</div>',
        '-- view:js --',
        'window.__scriptViewRan = true;',
      ].join('\\n'),
    },
    { title: '纯链接项', desc: '普通 URL 项', resource: 'https://example.com/plain/[[{keyword}]]' },
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
await sleep(400);
await evalJs(`localStorage.clear(); 1`);
await evalJs(SEED);
await S("Page.navigate", { url: base + "/index.html" });
await sleep(1200);

console.log("boot:", await evalJs(`JSON.stringify({
  invoked: [...new Set(window.__invoked)],
  hasInput: !!document.getElementById('my_search_input'),
})`));

// ---- 1. 结果列表展示中：不发送旧的状态门控 IPC ----
await typeKeyword("测试");
const resultShown = await evalJs(`document.getElementById('matchResult').style.display === 'block'`);
check("搜索结果已渲染", resultShown === true);
check("结果列表展示中：不发送 set_hide_on_blur（失焦隐藏由 Rust 无条件执行）", (await blurSyncCount()) === 0);

// ---- 2. 打开「附加内容」（vassal）→ 视图挂上，且不发送 ----
const vassalClicked = await evalJs(`(() => {
  const a = document.querySelector('#matchItems a.vassal');
  if (!a) return false;
  a.click();
  return true;
})()`);
await sleep(300);
const vassalVisible = await evalJs(`document.getElementById('text_show').style.display === 'block'`);
check(
  "附加内容视图已打开",
  vassalClicked === true && vassalVisible === true,
  `clicked=${vassalClicked} visible=${vassalVisible}`
);
check("查看附加内容：不再发送「不隐藏」标志", (await blurSyncCount()) === 0);
check(
  "附加内容正文已渲染",
  (await evalJs(`document.getElementById('text_show').textContent.includes('附加内容正文')`)) === true
);

// ---- 3. 打开脚本应用 → 视图挂上，且不发送 ----
await typeKeyword("");
await typeKeyword("脚本应用");
const scriptClicked = await clickResultByTitle("脚本应用测试项");
await sleep(600);
const scriptViewVisible = await evalJs(`!!document.querySelector('#text_show .script-view')`);
check(
  "脚本应用视图已挂载",
  scriptClicked === true && scriptViewVisible === true,
  `clicked=${scriptClicked} view=${scriptViewVisible}`
);
check("打开脚本应用：不再发送「不隐藏」标志", (await blurSyncCount()) === 0);
check("脚本应用 view:js 已执行", (await evalJs(`window.__scriptViewRan === true`)) === true);

// ---- 4. 输入 `:debug` → 不再发送「不隐藏」标志 ----
await typeKeyword(":debug");
check("`:debug` 指令模式：不再发送「不隐藏」标志", (await blurSyncCount()) === 0);

// ---- 5. 全程 IPC 里从未出现旧的状态门控命令 ----
const allInvoked = await evalJs(`JSON.stringify([...new Set(window.__invoked)])`).then(JSON.parse);
check(
  "全程 IPC 未出现 set_hide_on_blur（旧门控已彻底移除）",
  !allInvoked.includes("set_hide_on_blur") && !allInvoked.includes("setHideOnBlur"),
  JSON.stringify(allInvoked)
);

// ---- 6. 无页面异常 ----
check("无未捕获页面异常", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 300));

console.log("\n=== PAGE ERRORS ===");
console.log(pageErrors.length ? pageErrors.join("\n") : "(none)");

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);

ws.close();
proc.kill();
server.close();
await new Promise((r) => (proc.once("exit", r), setTimeout(r, 3000)));
await rm(profile, { recursive: true, force: true }).catch(() => {});
process.exit(failed.length || pageErrors.length ? 1 : 0);
