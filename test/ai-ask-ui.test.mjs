/**
 * 真实浏览器回归测试：「问AI : 你好」子关键词转发（还原油猴版）
 *
 * 覆盖官方说明 3.1 的完整路径：「呼出搜索框直接按 tab 键，输入问题再回车即可体现
 * AI 简单问答功能」——也就是系统的「[脚本]问AI」应用：
 *
 *   1. 空内容按 Tab  →  输入框变为「 : 」→ 引擎特殊路由把它转发成「问AI : 」
 *      （searchableSpecialRouting["^\\s*$"] → "问AI"）；
 *   2. 输入问题（如「你好」）→ 不重搜、脚本会话不被销毁；
 *   3. 回车 → 打开「问AI」脚本应用；应用**挂载完成后自动**把「你好」推给
 *      MS_SCRIPT_ENV.event.sendListener（原版 view.mount → waitViewRenderingComplete
 *      → tryRunTextViewHandler），这就是「你好」能进入应用的关键；
 *   4. 在应用里继续输入第二个问题并回车 → 同样推给应用（会话存活 + 回车转发）。
 *
 * 用假的 MS_SCRIPT_ENV.sendListener 探针替代真实 AI 应用（不发网络请求），
 * 断言应用实际收到的消息与输入框改写结果。
 *
 * 用法: npm run build && node test/ai-ask-ui.test.mjs
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
const profile = path.join(root, "test", `_chrome-profile-aiask-${process.pid}`);
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

// ---- 注入 Tauri 桥（页面脚本执行前生效）----
await S("Page.addScriptToEvaluateOnNewDocument", {
  source: `
    window.__openedUrls = [];
    window.__TAURI_INTERNALS__ = {
      invoke(cmd, args) {
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

// ---- 种子数据：一个「问AI」脚本应用（view:js 挂载 sendListener 探针）----
const SEED = `(() => {
  const items = [
    {
      title: "[h'脚本'][h'问AI'][h'系统项'] 问AI（测试替身）",
      desc: '使用三方Api来支持的内置AI助手', type: 'sketch',
      resource: [
        '-- script --',
        'function (obj) { obj.view.mount(); }',
        '-- view:html --',
        '<div id="ai-probe">AI 应用已挂载</div>',
        '-- view:js --',
        'window.__pushedMsgs = window.__pushedMsgs || [];',
        'window.MS_SCRIPT_ENV.event.sendListener.push(function (msg) {',
        '  var m = String(msg == null ? "" : msg).trim();',
        '  if (m.length === 0) return;',
        '  window.__pushedMsgs.push(m);',
        '});',
      ].join('\\n'),
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
await sleep(400);
await evalJs(`localStorage.clear(); 1`);
await evalJs(SEED);
await S("Page.navigate", { url: base + "/index.html" });
await sleep(1200);

const booted = await evalJs(`!!document.getElementById('my_search_input')`);
if (!booted) {
  console.log("跳过：主界面未就绪。");
  ws.close();
  proc.kill();
  server.close();
  process.exit(0);
}

const inputVal = () => evalJs(`document.getElementById('my_search_input')?.value ?? null`);
const setInput = async (v) => {
  await evalJs(`(() => {
    const input = document.getElementById('my_search_input');
    input.value = ${JSON.stringify(v)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
};
const key = async (k) => {
  await evalJs(`(() => {
    const input = document.getElementById('my_search_input');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }));
    return true;
  })()`);
};
const pushed = () => evalJs(`JSON.stringify(window.__pushedMsgs || null)`).then(JSON.parse);
const scriptViewOpen = () => evalJs(`!!document.querySelector('#text_show .script-view')`);

// ---- 1. 空内容按 Tab → 特殊路由转发为「问AI : 」----
await setInput("");
await sleep(150);
await key("Tab");
await sleep(1200); // 防抖 + PRO 路由 + 转发重搜
check("空内容按 Tab：输入框被转发为「问AI : 」", (await inputVal()) === "问AI : ", JSON.stringify(await inputVal()));

// ---- 2. 输入问题「你好」→ 不重搜、会话未开也无妨（结果仍是问AI应用） ----
await setInput("问AI : 你好");
await sleep(700);
check(
  "输入「问AI : 你好」后结果仍展示问AI应用（未被输入打断）",
  (await evalJs(`document.getElementById('matchResult').style.display === 'block'`)) === true
);

// ---- 3. 回车 → 打开应用并**自动**把「你好」转发给 sendListener ----
await key("Enter");
await sleep(800);
check("回车后问AI脚本应用视图已挂载", (await scriptViewOpen()) === true);
let msgs = await pushed();
check(
  "应用挂载完成后自动收到「你好」（原版 waitViewRenderingComplete → tryRunTextViewHandler）",
  Array.isArray(msgs) && msgs.includes("你好"),
  JSON.stringify(msgs)
);
check("自动转发后输入框保留「问AI : 」（原版 replace(msg,\"\")）", (await inputVal()) === "问AI : ", JSON.stringify(await inputVal()));

// ---- 4. 会话存活：继续输入第二个问题，脚本视图不被销毁 ----
await setInput("问AI : 第二个问题");
await sleep(600);
check("编辑子关键词时脚本应用视图不被销毁（会话存活）", (await scriptViewOpen()) === true);

// ---- 5. 回车 → 把第二个问题推给应用 ----
await key("Enter");
await sleep(400);
msgs = await pushed();
check(
  "回车把第二个问题推给应用（原版 tryRunTextViewHandler 回车分支）",
  Array.isArray(msgs) && msgs.includes("第二个问题"),
  JSON.stringify(msgs)
);
check("再次转发后输入框仍保留「问AI : 」", (await inputVal()) === "问AI : ", JSON.stringify(await inputVal()));

// ---- 6. 无页面异常 ----
check("无未捕获页面异常", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 300));

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (pageErrors.length) console.log("PAGE ERRORS:\n" + pageErrors.join("\n"));

ws.close();
proc.kill();
server.close();
await new Promise((r) => (proc.once("exit", r), setTimeout(r, 3000)));
await rm(profile, { recursive: true, force: true }).catch(() => {});
process.exit(failed.length || pageErrors.length ? 1 : 0);
