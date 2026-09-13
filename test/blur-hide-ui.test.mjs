/**
 * 真实浏览器验证：失焦自动隐藏的联动
 * （用户反馈：① 结果列表展示中，点窗口外应该隐藏 —— 本次调整；
 *   ② 查看附加内容 / 打开脚本应用时，点了应用外面的地方不应该隐藏窗口 —— 原行为保留）。
 *
 * 做法：用 CDP 打开构建产物 index.html，注入假的 `window.__TAURI_INTERNALS__`
 * 来录制前端同步给 Rust 的 `set_hide_on_blur` 值（Rust 侧失焦判定读的就是这个值），
 * 再走真实交互路径验证：
 *
 * 1. 结果列表展示中 → hide=true（桌面版调整，原版 `!isWaitSearch` 为 false）
 * 2. 打开「附加内容」（vassal）→ hide=false（原行为保留）
 * 3. 打开脚本应用（脚本项 view:html/css/js）→ hide=false + 视图真的挂上了
 * 4. 输入其它关键词退出详情 → 仍展示结果 → hide=true
 * 5. 无结果 → 什么都不显示（不出提示），仍回到等待搜索 hide=true
 * 6. 输入 `:debug` → hide=false
 * 7. 清空回到等待搜索 → hide=true（恢复失焦自动隐藏）
 * 8. 点击 URL 结果 → 显式收起窗口（原版 viewVisibilityController(false) + window.open）
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
const waitFor = async (expr, timeout = 5000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await evalJs(expr)) return true;
    await sleep(100);
  }
  return false;
};

/** 前端最后一次同步给 Rust 的 hide 值（null = 从未同步） */
const readHide = () =>
  evalJs(`(() => { const l = window.__hideCalls || []; return l.length ? l[l.length - 1] : null; })()`);

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
    window.__hideCalls = [];
    window.__invoked = [];
    window.__openedUrls = [];
    window.__TAURI_INTERNALS__ = {
      invoke(cmd, args) {
        window.__invoked.push(cmd);
        if (cmd === 'set_hide_on_blur') { window.__hideCalls.push(args.hide); return Promise.resolve(null); }
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
      // 脚本项的 resource 由 "-- xxx --" 分段（parseScriptItem 解析成 resourceObj）
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
  // 订阅指纹：与 subscribeFingerprint 的格式一致（url|title|fetchFun|defaultTag）
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

// 打印一次启动诊断（数据条数 / 同步过的 IPC）
console.log("boot:", await evalJs(`JSON.stringify({
  invoked: [...new Set(window.__invoked)],
  hideCalls: window.__hideCalls,
  hasInput: !!document.getElementById('my_search_input'),
})`));

// ---- 0. 初始（等待搜索，无结果）→ 未搜索时不同步 hide（按需同步）----
// （注：前端只在状态变化时发 IPC，初始就是可隐藏状态，Rust 侧初值也是 true）
console.log("初始 hideCalls:", await evalJs(`JSON.stringify(window.__hideCalls)`));

// ---- 1. 结果列表展示中 → hide=true（本次调整：点窗口外即收起） ----
await typeKeyword("测试");
const resultShown = await evalJs(`document.getElementById('matchResult').style.display === 'block'`);
check("搜索结果已渲染", resultShown === true);
check(
  "结果列表展示中：hide=true（失焦隐藏）",
  (await readHide()) === true,
  `hide=${await readHide()}`
);

// ---- 2. 打开「附加内容」（vassal）→ hide=false（原行为保留）----
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
check("查看附加内容：hide=false（点应用外面不会隐藏）", (await readHide()) === false, `hide=${await readHide()}`);
check(
  "附加内容正文已渲染",
  (await evalJs(`document.getElementById('text_show').textContent.includes('附加内容正文')`)) === true
);

// ---- 3. 打开脚本应用 → hide=false ----
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
check("打开脚本应用：hide=false（点应用外面不会隐藏）", (await readHide()) === false, `hide=${await readHide()}`);
check("脚本应用 view:js 已执行", (await evalJs(`window.__scriptViewRan === true`)) === true);

// ---- 4. 退出详情（输入别的关键词，仍有结果）→ hide=true（回到结果列表）----
await typeKeyword("纯链接");
check("退出详情、结果列表展示中：hide=true", (await readHide()) === true, `hide=${await readHide()}`);

// ---- 5. 无结果 → 什么都不显示（不出提示），仍回到等待搜索 hide=true ----
await typeKeyword("@@@@@@"); // 必定搜不到的关键词
const noResultState = await evalJs(`JSON.stringify({
  toast: !!document.querySelector('#matchItems .no-result-toast'),
  listEmpty: document.getElementById('matchItems').innerHTML.trim() === '',
  resultHidden: document.getElementById('matchResult').style.display === 'none',
})`).then(JSON.parse);
check(
  "无结果：不显示任何提示、列表为空",
  noResultState.toast === false && noResultState.listEmpty === true && noResultState.resultHidden === true,
  JSON.stringify(noResultState)
);
check("无结果（等待搜索态）：hide=true", (await readHide()) === true, `hide=${await readHide()}`);

// ---- 6. `:debug` 指令模式 → hide=false ----
await typeKeyword(":debug");
check(":debug 指令模式：hide=false", (await readHide()) === false, `hide=${await readHide()}`);

// ---- 7. 清空 → 等待搜索 → hide=true（恢复自动隐藏）----
await typeKeyword("");
check("清空回到等待搜索：hide=true", (await readHide()) === true, `hide=${await readHide()}`);

// ---- 8. 点击 URL 结果 → 显式收起窗口 ----
await typeKeyword("纯链接");
await clickResultByTitle("纯链接项");
await sleep(500);
const afterOpenUrl = await evalJs(`JSON.stringify({
  inputEmpty: document.getElementById('my_search_input').value === '',
  resultHidden: document.getElementById('matchResult').style.display === 'none',
  opened: window.__openedUrls,
  hideAfter: window.__hideCalls[window.__hideCalls.length - 1],
})`).then(JSON.parse);
check(
  "点 URL 结果：视图被收起、链接已打开、并恢复 hide=true",
  afterOpenUrl.inputEmpty && afterOpenUrl.resultHidden && afterOpenUrl.opened.length > 0 && afterOpenUrl.hideAfter === true,
  JSON.stringify(afterOpenUrl)
);

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
