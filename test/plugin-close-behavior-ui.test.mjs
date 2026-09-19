/**
 * 「关闭插件界面时」行为端到端测试（真实浏览器 + 模拟 IPC，无 Tauri）。
 *
 * 用户诉求：插件可以声明「关闭时最小化而不是退出」，且用户可在面板修改。
 * 本测试验证**声明真的会生效**（不只是存了个字段）：
 *
 *   1. `closeBehavior: "exit"` 的插件：打开界面 → Esc 关闭 → 发出
 *      `plugin_backend_stop`（且带正确 pluginId）；
 *   2. `closeBehavior: "minimize"` 的插件：同样的关闭动作**不发出**停止请求
 *      （交给空闲回收）；
 *   3. 设为「开机自启」的插件：即使声明了 exit 也不停（开机自启优先）；
 *   4. 用户把面板值改掉后立刻按新值执行（用户选择覆盖插件声明）；
 *   5. 关闭路径覆盖：Esc 关闭、「开始新搜索」关闭。
 *
 * 用法: npm run build && node test/plugin-close-behavior-ui.test.mjs
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
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const server = createServer(async (req, res) => {
  try {
    const u = decodeURIComponent(req.url.split("?")[0]);
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

const userDir = path.join(root, "test", "_chrome-profile-plugin-close");
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
  const r = await S(
    "Runtime.evaluate",
    { expression: expr, returnByValue: true, awaitPromise: true },
    sessionId
  );
  if (r.result?.exceptionDetails) {
    throw new Error(
      JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails).slice(0, 400)
    );
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

/* ---------------- 三个插件：exit / minimize / exit+开机自启 ---------------- */
const now = Date.now();

/** 插件视图的入口 HTML/JS：挂一个可见标记，便于断言「界面真的打开了」 */
const VIEW_HTML = "<div id=\"plugin-root\">插件界面已就绪</div>";
const VIEW_JS = "window.__pluginOpened = (window.__pluginOpened || 0) + 1;";

const mkManifest = (id, name, closeBehavior, autostart) => ({
  id,
  name,
  version: "1.0.0",
  apiVersion: 1,
  description: `closeBehavior=${closeBehavior}`,
  permissions: ["ui.inlay", "backend.spawn"],
  contributes: {
    searchItem: { title: name, desc: `关键词 ${name}`, keyword: name, visible: true },
    detailView: { entry: "ui/view.html", script: "ui/view.js", mode: "inlay" },
  },
  backend: { entry: "backend/app.exe", autostart, closeBehavior },
});

/** 纯前端插件（无 backend）：closeBehavior 对它是死字段，关界面必须不动作 */
const NO_BACKEND = {
  id: "com.example.no-backend",
  name: "纯前端插件",
  version: "1.0.0",
  apiVersion: 1,
  contributes: {
    searchItem: { title: "纯前端插件", desc: "无后台进程", keyword: "纯前端", visible: true },
    detailView: { entry: "ui/view.html", script: "ui/view.js", mode: "inlay" },
  },
};

const PLUGINS = [
  // 关键词用简短稳定词，避免与订阅数据互扰
  mkManifest("com.example.exit", "关闭就退", "exit", "on-demand"),
  mkManifest("com.example.minimize", "关闭最小化", "minimize", "on-demand"),
  mkManifest("com.example.always", "常驻不关", "exit", "always"),
  NO_BACKEND,
];

const mkRecord = (mf) => ({
  id: mf.id,
  name: mf.name,
  version: mf.version,
  apiVersion: mf.apiVersion,
  description: mf.description,
  manifest: mf,
  dir: `plugins/${mf.id}`,
  source: { kind: "file", ref: "x.msplugin" },
  installedAt: now,
  updatedAt: now,
  enabled: true,
  autoStart: mf.backend?.autostart === "always" ? "always" : "on-demand",
  requestedAutoStart: mf.backend?.autostart ?? "never",
  closeBehavior: mf.backend?.closeBehavior ?? "exit",
  grants: mf.backend
    ? [
        { permission: "ui.inlay", at: now, source: "install" },
        { permission: "backend.spawn", at: now, source: "install" },
      ]
    : [{ permission: "ui.inlay", at: now, source: "install" }],
  denied: [],
  // 预置成「运行中」，这样「关闭时该不该停」才是真问题
  runtime: mf.backend
    ? { status: "running", pid: 1111, memoryBytes: null, startedAt: now, restarts: 0, lastError: null, keepAliveReasons: [] }
    : { status: "stopped", pid: null, memoryBytes: null, startedAt: null, restarts: 0, lastError: null, keepAliveReasons: [] },
  integrity: { sha256: null, signed: false },
});

const RECORDS = PLUGINS.map(mkRecord);

/** 全部插件视图文件（每个插件一套，见注入的 IPC 模拟） */
const PLUGIN_FILES = Object.fromEntries(
  PLUGINS.map((p) => [p.id, { "ui/view.html": VIEW_HTML, "ui/view.js": VIEW_JS }])
);

/** 预置的「运行中」后端状态（与 RECORDS 对齐） */
const RUNNING_BACKENDS = PLUGINS.filter((p) => p.backend).map((p, i) => ({
  pluginId: p.id,
  status: "running",
  pid: 1111 + i,
  memoryBytes: null,
  startedAt: now,
  restarts: 0,
  lastError: null,
  keepAliveReasons: [],
}));

/* ---------------- 注入 IPC 模拟 ---------------- */
await S(
  "Page.addScriptToEvaluateOnNewDocument",
  {
    source: `
    window.__calls = [];          // 全部 invoke（含参数）
    window.__files = ${JSON.stringify(PLUGIN_FILES)};
    window.__running = ${JSON.stringify(RUNNING_BACKENDS)};
    window.__TAURI_INTERNALS__ = {
      invoke(cmd, args) {
        window.__calls.push({ cmd, args });
        if (cmd === 'plugin_read_text') {
          const files = window.__files[args.pluginId] || {};
          const text = files[args.relPath];
          return text == null ? Promise.reject('文件不存在: ' + args.relPath) : Promise.resolve(text);
        }
        if (cmd === 'plugin_read_binary') return Promise.reject('无图标');
        if (cmd === 'plugin_backend_list') return Promise.resolve(window.__running);
        if (cmd === 'plugin_backend_stop') {
          // 停掉后从状态表里移除（模拟真实 supervisor）
          window.__running = window.__running.filter(s => s.pluginId !== args.pluginId);
          return Promise.resolve(null);
        }
        if (cmd === 'get_default_subscribe_text') return Promise.resolve('');
        if (cmd === 'get_toggle_shortcut') return Promise.resolve('ctrl+alt+s');
        if (cmd === 'get_autostart_enabled') return Promise.resolve(false);
        return Promise.resolve(null);
      },
      transformCallback(cb, once) {
        const cbId = Math.random().toString(36).slice(2);
        window.__cbIds = window.__cbIds || {};
        window.__cbIds[cbId] = cb;
        return cbId;
      },
      unregisterCallback(cbId) { delete (window.__cbIds || {})[cbId]; },
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      plugins: {},
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(){} };
  `,
  },
  sessionId
);

/** 停进程的调用记录（只关心 pluginId） */
const stopCalls = async () =>
  JSON.parse(
    await evalJs(`JSON.stringify(window.__calls.filter(c => c.cmd === 'plugin_backend_stop').map(c => c.args.pluginId))`)
  );

const clearCalls = () => evalJs(`window.__calls = []; 1`);

/** 搜索并打开某插件的界面（与用户真实路径一致：输入关键词 → 回车） */
async function openPlugin(keyword) {
  await evalJs(`
    (() => {
      const el = document.getElementById('my_search_input');
      el.focus();
      el.value = ${JSON.stringify(keyword)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })();
    1
  `);
  await sleep(700);
  await evalJs(`
    (() => {
      const el = document.getElementById('my_search_input');
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    })();
    1
  `);
  await sleep(900);
  return await evalJs(`!!document.querySelector('#text_show .plugin-view #plugin-root')`);
}

/** Esc 关闭界面（用户最常用的关闭方式） */
async function closeByEsc() {
  await evalJs(`
    (() => {
      const el = document.getElementById('my_search_input');
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    })();
    1
  `);
  await sleep(500);
}

/* ================= 准备：写入注册表并进入搜索窗 ================= */
await S("Page.navigate", { url: base + "/index.html" }, sessionId);
await sleep(600);
await evalJs(`
  (() => {
    localStorage.clear();
    localStorage.setItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY', JSON.stringify({
      version: 1,
      plugins: ${JSON.stringify(RECORDS)},
    }));
    // 订阅缓存留空：插件项是唯一数据源，检索不受其它内容干扰
    localStorage.setItem('my-search-desktop:SEARCH_DATA_KEY', JSON.stringify({ data: [], expire: Date.now() + 3600 * 1000 }));
    return 1;
  })()
`);
await S("Page.navigate", { url: base + "/index.html" }, sessionId);
await sleep(1400);
check("搜索窗已加载插件注册表", (await evalJs(`!!window.__TAURI_INTERNALS__`)) === true);

/* ================= 1. exit：关闭界面即停进程 ================= */
{
  const opened = await openPlugin("关闭就退");
  check("exit 插件界面成功打开", opened === true);
  await clearCalls();
  await closeByEsc();
  const stopped = await stopCalls();
  check("Esc 关闭 exit 插件 → 发出 plugin_backend_stop", stopped.includes("com.example.exit"), JSON.stringify(stopped));
  check("只停了这一个插件", stopped.length === 1 && stopped[0] === "com.example.exit", JSON.stringify(stopped));
}

/* ================= 2. minimize：关闭界面不停进程 ================= */
{
  const opened = await openPlugin("关闭最小化");
  check("minimize 插件界面成功打开", opened === true);
  await clearCalls();
  await closeByEsc();
  const stopped = await stopCalls();
  check("Esc 关闭 minimize 插件 → 不发停止请求（交给空闲回收）", stopped.length === 0, JSON.stringify(stopped));
}

/* ================= 3. 开机自启优先：声明 exit 也不停 ================= */
{
  const opened = await openPlugin("常驻不关");
  check("开机自启插件界面成功打开", opened === true);
  await clearCalls();
  await closeByEsc();
  const stopped = await stopCalls();
  check("开机自启的插件关闭界面 → 不停（常驻优先于 closeBehavior=exit）", stopped.length === 0, JSON.stringify(stopped));
}

/* ================= 4. 用户改过的值立刻生效（覆盖插件声明） ================= */
{
  // 把「关闭最小化」的插件在注册表里改成 exit —— 等价于用户在面板里点了「退出」
  await evalJs(`
    (() => {
      const raw = JSON.parse(localStorage.getItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY'));
      raw.plugins.find(p => p.id === 'com.example.minimize').closeBehavior = 'exit';
      localStorage.setItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY', JSON.stringify(raw));
      return 1;
    })()
  `);
  await S("Page.navigate", { url: base + "/index.html" }, sessionId);
  await sleep(1400);

  const opened = await openPlugin("关闭最小化");
  check("改过之后界面仍能打开", opened === true);
  await clearCalls();
  await closeByEsc();
  const stopped = await stopCalls();
  check("用户改成 exit 后 → 关闭界面即停（用户选择覆盖插件声明）", stopped.includes("com.example.minimize"), JSON.stringify(stopped));
}

/* ================= 5. 另一条关闭路径：「开始新搜索」也要生效 ================= */
{
  // 把 exit 插件恢复成「运行中」，并确认在输入新内容（离开详情视图）时也会停
  await evalJs(`
    (() => {
      const raw = JSON.parse(localStorage.getItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY'));
      const rec = raw.plugins.find(p => p.id === 'com.example.exit');
      rec.closeBehavior = 'exit';
      rec.autoStart = 'on-demand';
      localStorage.setItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY', JSON.stringify(raw));
      return 1;
    })()
  `);
  await S("Page.navigate", { url: base + "/index.html" }, sessionId);
  await sleep(1400);

  const opened = await openPlugin("关闭就退");
  check("（路径 2）界面成功打开", opened === true);
  await clearCalls();
  // 输入新关键词 = 离开详情视图开始新搜索（hideTextView 路径）
  await evalJs(`
    (() => {
      const el = document.getElementById('my_search_input');
      el.focus();
      el.value = '另一个搜索词';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })();
    1
  `);
  await sleep(600);
  const stopped = await stopCalls();
  check("开始新搜索（离开插件界面）→ 同样按策略停止", stopped.includes("com.example.exit"), JSON.stringify(stopped));
}

/* ================= 6. 无后端插件的界面关闭不误报停止 ================= */
{
  const opened = await openPlugin("纯前端");
  check("无后端插件界面能打开（closeBehavior=exit 也合法）", opened === true);
  await clearCalls();
  await closeByEsc();
  const stopped = await stopCalls();
  check("无后端插件关闭 → 不发出停止请求（没东西可停）", stopped.length === 0, JSON.stringify(stopped));
}

check("全程无页面异常", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

console.log(`\n结果: ${pass} passed, ${fail} failed`);
ws.close();
chrome.kill();
server.close();
process.exit(fail === 0 ? 0 : 1);
