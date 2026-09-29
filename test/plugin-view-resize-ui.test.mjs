/**
 * 回归测试：插件视图右下角「拖拽改窗口大小」手柄。
 *
 * 用户需求：插件页可拖右下角改变整个主窗口宽高；尺寸按插件隔离记忆；下次打开同尺寸；
 * 窗口水平居中 + 顶部占剩余空间 22%；仅插件页生效，不影响其它页面。
 *
 * 钉死的契约（用真实构建产物 + 真实内置插件走真实打开路径）：
 *   1. 手柄元素存在、可见、cursor=nwse-resize、挂在 #my_search_box 内、贴合其右下角；
 *   2. 手柄若被放进 #text_show 的 v-if 分支同级，会触发 Vue
 *      `Cannot read properties of null (reading 'nextSibling')` 渲染崩溃、手柄根本不
 *      出现——本测试是那次真实回归的守卫（手柄必须挂在 #my_search_view 之外的窗口外框）；
 *   3. 拖拽（mousedown→mousemove→mouseup）后下发窗口尺寸 = 起始尺寸 + 增量；
 *   4. 下发窗口位置 = 水平居中 + 顶部占剩余 22%（x=(屏宽-w)/2, y=(屏高-h)*0.22）；
 *   5. 松手写入按插件隔离的尺寸记忆（localStorage PLUGIN_DATA:<pluginId>:viewSize）；
 *   6. 全程无未捕获异常。
 *
 * 用法: npm run build && node test/plugin-view-resize-ui.test.mjs
 */
import { createServer } from "http";
import { readFile, rm } from "fs/promises";
import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
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
const userDir = path.join(root, "test", "_chrome-profile-plugin-view-resize");
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
const logs = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
  if (msg.method === "Runtime.exceptionThrown") {
    pageErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  }
  if (msg.method === "Runtime.consoleAPICalled") {
    const args = (msg.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
    logs.push(`[${msg.params.type}] ${args}`);
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
    throw new Error(
      JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails).slice(0, 800)
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

/* ---------------- 夹具：真实内置「文件搜索」插件 ---------------- */
const PLUGIN_ID = "com.mysearch.file-search";
const PLUGIN_DIR = path.join(root, "plugins", "file-search");
const manifest = JSON.parse(readFileSync(path.join(PLUGIN_DIR, "plugin.json"), "utf8"));
const PLUGIN_FILES = {
  [PLUGIN_ID]: {
    "ui/detail.html": readFileSync(path.join(PLUGIN_DIR, "ui", "detail.html"), "utf8"),
    "ui/detail.css": readFileSync(path.join(PLUGIN_DIR, "ui", "detail.css"), "utf8"),
    "ui/index.js": readFileSync(path.join(PLUGIN_DIR, "ui", "index.js"), "utf8"),
    "icon.svg": readFileSync(path.join(PLUGIN_DIR, "icon.svg"), "utf8"),
  },
};
const now = Date.now();
const RECORD = {
  id: PLUGIN_ID,
  name: manifest.name,
  version: manifest.version,
  apiVersion: manifest.apiVersion,
  description: manifest.description,
  manifest,
  dir: `plugins/${PLUGIN_ID}`,
  source: { kind: "builtin", ref: "builtin" },
  installedAt: now,
  updatedAt: now,
  enabled: true,
  autoStart: "on-demand",
  requestedAutoStart: "on-demand",
  closeBehavior: manifest.contributes.detailView.closeBehavior,
  grants: [
    { permission: "ui.inlay", at: now, source: "install" },
    { permission: "file.read", at: now, source: "install" },
  ],
  denied: [],
  runtime: { status: "stopped", pid: null, memoryBytes: null, startedAt: null, restarts: 0, lastError: null, keepAliveReasons: [] },
  integrity: { sha256: null, signed: false },
};

/* ---------------- 注入 IPC 模拟（含窗口尺寸/位置/显示器） ---------------- */
await S(
  "Page.addScriptToEvaluateOnNewDocument",
  {
    source: `
    window.__files = ${JSON.stringify(PLUGIN_FILES)};
    window.__calls = [];
    window.__TAURI_INTERNALS__ = {
      invoke(cmd, args) {
        try { window.__calls.push({ cmd, args }); } catch (e) {}
        if (cmd === 'set_window_height') {
          window.__sizes = window.__sizes || [];
          // 同时记录「下发那一刻盒子的实测高度」与拉伸类状态：用于事后核对
          // 下发的高度是否与当时真实布局一致（不一致 = 量到了半变布局）。
          const box = document.getElementById('my_search_box');
          window.__sizes.push({
            cmd,
            h: args && args.height,
            box: box ? Math.round(box.getBoundingClientRect().height) : null,
            sized: box ? box.classList.contains('plugin-sized') : null,
          });
          return Promise.resolve(null);
        }
        // reset_main_window_position 在真实环境是一次 Rust IPC（有往返延迟）。
        // 这里刻意加一个宏任务延迟来**还原真实时序**：延迟期间恰好够 rAF 的
        // fit() 跑一轮——这正是「双击还原概率性变很矮」竞态触发的前提。
        // 若把它当作立即 resolve，则 setWindowHeight(base.height) 会抢在 fit()
        // 之前落地，竞态被掩盖（测试假通过）。
        if (cmd === 'reset_main_window_position') {
          return new Promise((resolve) => setTimeout(() => resolve(null), 60));
        }
        if (cmd === 'plugin_read_text') {
          const f = window.__files[args.pluginId] || {};
          const t = f[args.relPath];
          return t == null ? Promise.reject('文件不存在: ' + args.relPath) : Promise.resolve(t);
        }
        if (cmd === 'plugin_read_binary') return Promise.reject('无图标');
        if (cmd === 'plugin_backend_list') return Promise.resolve([]);
        if (cmd === 'get_default_subscribe_text') return Promise.resolve('');
        if (cmd === 'get_toggle_shortcut') return Promise.resolve('ctrl+alt+s');
        if (cmd === 'get_autostart_enabled') return Promise.resolve(false);
        if (cmd === 'plugin:window|set_size' || cmd === 'plugin:window|set_position') {
          window.__winOps = window.__winOps || [];
          window.__winOps.push({ cmd, args });
          return Promise.resolve(null);
        }
        if (cmd === 'plugin:window|scale_factor') return Promise.resolve(1);
        if (cmd === 'plugin:window|current_monitor')
          return Promise.resolve({
            name: 'Mock',
            scaleFactor: 1,
            position: { x: 0, y: 0 },
            size: { width: 1920, height: 1080 },
            workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } },
          });
        if (cmd === 'plugin:event|listen' && args && args.event) {
          const list = window.__eventHandlers.get(args.event) || [];
          list.push(args.handler);
          window.__eventHandlers.set(args.event, list);
          return Promise.resolve(window.__eventNextId++);
        }
        return Promise.resolve(null);
      },
      transformCallback(cb) { const cbId = Math.random().toString(36).slice(2); window.__cbIds = window.__cbIds || {}; window.__cbIds[cbId] = cb; return cbId; },
      unregisterCallback(cbId) { delete (window.__cbIds || {})[cbId]; },
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      plugins: {},
    };
    window.__eventHandlers = new Map();
    window.__eventNextId = 1;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(){} };
    window.__emitTauriEvent = (event, payload) => {
      const list = window.__eventHandlers.get(event) || [];
      list.forEach((idOrFn) => {
        const cb = typeof idOrFn === 'function' ? idOrFn : (window.__cbIds || {})[idOrFn];
        if (typeof cb === 'function') { try { cb({ event, id: window.__eventNextId++, payload }); } catch (e) {} }
      });
      return list.length;
    };
  `,
  },
  sessionId
);

await S("Page.navigate", { url: base + "/index.html" }, sessionId);
await sleep(600);
await evalJs(`
  (() => {
    localStorage.clear();
    localStorage.setItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY', JSON.stringify({ version: 1, plugins: ${JSON.stringify([RECORD])} }));
    localStorage.setItem('my-search-desktop:SEARCH_DATA_KEY', JSON.stringify({ data: [], expire: Date.now() + 3600 * 1000 }));
    return 1;
  })()`);
await S("Page.navigate", { url: base + "/index.html" }, sessionId);
await sleep(1500);

/* ================= 打开插件 ================= */
await evalJs(`
  (() => {
    const el = document.getElementById('my_search_input');
    el.focus(); el.value = '文件搜索';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })(); 1`);
await sleep(800);
await evalJs(`
  (() => {
    const el = document.getElementById('my_search_input');
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  })(); 1`);
await sleep(1500);

const probe = JSON.parse(await evalJs(`JSON.stringify((() => {
  const pv = document.querySelector('#text_show .plugin-view');
  const handle = document.querySelector('.plugin-resize-handle');
  const box = document.getElementById('my_search_box');
  const cs = handle ? getComputedStyle(handle) : null;
  return {
    hasPlugin: !!pv,
    hasHandle: !!handle,
    handleRect: handle ? (() => { const r = handle.getBoundingClientRect(); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; })() : null,
    handleDisplay: cs ? cs.display : null,
    handleVisibility: cs ? cs.visibility : null,
    handleCursor: cs ? cs.cursor : null,
    handleZ: cs ? cs.zIndex : null,
    handleParent: handle ? (handle.parentElement ? handle.parentElement.id || handle.parentElement.className : null) : null,
    boxRect: box ? (() => { const r = box.getBoundingClientRect(); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; })() : null,
    allCalls: (window.__calls || []).map((c) => c.cmd),
    sizes: window.__sizes || [],
    winOverrideCalls: (window.__calls || []).filter((c) => /setSize|setPosition|currentMonitor/i.test(c.cmd)),
  };
})())`));

console.log("\n=== 探针 ===");
console.log(JSON.stringify(probe, null, 2));
if (logs.length) console.log("=== console ===\n" + logs.slice(-30).join("\n"));

check("插件视图已打开", probe.hasPlugin === true);
check("手柄元素存在", probe.hasHandle === true);
check("手柄可见（display 非 none）", probe.handleDisplay != null && probe.handleDisplay !== "none", `display=${probe.handleDisplay}`);
check("手柄 cursor = nwse-resize", probe.handleCursor === "nwse-resize", `cursor=${probe.handleCursor}`);
check("手柄挂在 #my_search_box 内", probe.handleParent === "my_search_box", `parent=${probe.handleParent}`);
check(
  "手柄贴合盒子右下角",
  probe.handleRect && probe.boxRect &&
    Math.abs(probe.handleRect.x + probe.handleRect.w - (probe.boxRect.x + probe.boxRect.w)) < 6 &&
    Math.abs(probe.handleRect.y + probe.handleRect.h - (probe.boxRect.y + probe.boxRect.h)) < 6,
  `handle=${JSON.stringify(probe.handleRect)} box=${JSON.stringify(probe.boxRect)}`
);

/* ================= 模拟拖拽（mousedown → mousemove → mouseup） ================= */
const drag = JSON.parse(await evalJs(`JSON.stringify((() => {
  const handle = document.querySelector('.plugin-resize-handle');
  if (!handle) return { ok: false, reason: 'no handle' };
  const r = handle.getBoundingClientRect();
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  window.__winOps = [];
  handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 }));
  document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: cx + 120, clientY: cy + 80 }));
  window.__dragEnd = { x: cx + 120, y: cy + 80 };
  return { ok: true };
})())`));
await sleep(120);

/* 拖拽中（尚未松手）的快照：应只有 set_size，不能有 set_position */
const duringDrag = JSON.parse(await evalJs(`JSON.stringify((() => ({
  ops: (window.__winOps || []).map((o) => o.cmd),
  hasSizedClass: document.getElementById('my_search_box').classList.contains('plugin-sized'),
}))())`));

await evalJs(`document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: window.__dragEnd.x, clientY: window.__dragEnd.y })); 1`);
await sleep(200);

const afterDrag = JSON.parse(await evalJs(`JSON.stringify((() => {
  const handle = document.querySelector('.plugin-resize-handle');
  const sizes = window.__sizes || [];
  return {
    totalCalls: (window.__calls || []).length,
    sizes: sizes,
    winOps: window.__winOps || [],
    handleStillThere: !!handle,
    stored: (() => { try { return Object.keys(localStorage).filter((k) => k.includes('viewSize')); } catch (e) { return []; } })(),
    storedVal: (() => { try { const k = Object.keys(localStorage).find((k) => k.includes('viewSize')); return k ? localStorage.getItem(k) : null; } catch (e) { return null; } })(),
  };
})())`));

console.log("\n=== 拖拽中 ===");
console.log(JSON.stringify(duringDrag, null, 2));
console.log("\n=== 拖拽后 ===");
console.log(JSON.stringify(afterDrag, null, 2));

const setSizeOps = (afterDrag.winOps || []).filter((o) => o.cmd === "plugin:window|set_size");
const setPosOps = (afterDrag.winOps || []).filter((o) => o.cmd === "plugin:window|set_position");

check("拖拽后仍能读到手柄（未崩）", afterDrag.handleStillThere === true);
check("拖拽中下发了窗口尺寸（plugin:window|set_size）", duringDrag.ops.includes("plugin:window|set_size"), `ops=${JSON.stringify(duringDrag.ops)}`);
check(
  "拖拽中【不】下发位置（left/top 固定，避免上下滑动）",
  !duringDrag.ops.includes("plugin:window|set_position"),
  `ops=${JSON.stringify(duringDrag.ops)}`
);
check("拖拽中启用了内容拉伸类 plugin-sized", duringDrag.hasSizedClass === true);
check("松手后下发了一次位置（居中定位）", setPosOps.length > 0, `ops=${JSON.stringify(setPosOps)}`);
check(
  "下发尺寸 = 起始尺寸 + 拖拽增量（约 +120/+80）",
  setSizeOps.length > 0 &&
    setSizeOps[setSizeOps.length - 1].args?.value?.Logical &&
    Math.abs(setSizeOps[setSizeOps.length - 1].args.value.Logical.width - (758 + 120)) < 2 &&
    Math.abs(setSizeOps[setSizeOps.length - 1].args.value.Logical.height - (116 + 80)) < 2,
  `last=${JSON.stringify(setSizeOps[setSizeOps.length - 1]?.args?.value?.Logical)}`
);
check(
  "松手后位置 = 上下左右完全居中",
  setPosOps.length > 0 &&
    setPosOps[setPosOps.length - 1].args?.value?.Logical &&
    Math.abs(setPosOps[setPosOps.length - 1].args.value.Logical.x - Math.round((1920 - 878) / 2)) < 2 &&
    Math.abs(setPosOps[setPosOps.length - 1].args.value.Logical.y - Math.round((1080 - 196) / 2)) < 2,
  `pos=${JSON.stringify(setPosOps[setPosOps.length - 1]?.args?.value?.Logical)}`
);
check("拖拽后写入了尺寸记忆", afterDrag.stored.length > 0, `keys=${JSON.stringify(afterDrag.stored)} val=${afterDrag.storedVal}`);
check("记忆值 == 拖拽后的尺寸", afterDrag.storedVal != null && JSON.parse(afterDrag.storedVal).width > 758, `val=${afterDrag.storedVal}`);

check("页面无未捕获异常", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 500));

/* ================= 回归：改大小后 #text_show 滚动必须复位 =================
 *
 * 用户报「窗口改大小后插件内容滚不到前面」：.plugin-sized 下 #text_show 是
 * overflow:hidden，但浏览器会**保留**它此前的 scrollTop——于是顶部内容被裁且
 * 无滚动条可滚回（wheel 对 hidden 无效）。修复是布局翻转时显式清零。
 *
 * 为在夹具里稳定复现：强制给 #text_show 注入一段超高内容并让其可滚动，
 * 把 scrollTop 顶上去，再走**真实拖拽手柄路径**进入拉伸态，断言被复位为 0。 */
const scrollResetViaHandle = JSON.parse(await evalJs(`JSON.stringify((() => {
  const ts = document.getElementById('text_show');
  const box = document.getElementById('my_search_box');
  // 回到常态，并确保 #text_show 可滚动：注入超高内容 + 显式恢复可滚动样式
  box.classList.remove('plugin-sized');
  let probe = document.getElementById('__scroll_probe');
  if (!probe) {
    probe = document.createElement('div');
    probe.id = '__scroll_probe';
    probe.style.cssText = 'height:1200px;flex:0 0 auto';
    ts.appendChild(probe);
  }
  ts.style.maxHeight = '200px';
  ts.style.overflowY = 'auto';
  const maxTop = ts.scrollHeight - ts.clientHeight;
  ts.scrollTop = 120;
  const beforeFlip = ts.scrollTop;
  // 真实入口：拖拽手柄触发 onPluginResize → setPluginSizedClass(true) → 复位
  const handle = document.querySelector('.plugin-resize-handle');
  const r = handle.getBoundingClientRect();
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 }));
  document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: cx + 30, clientY: cy + 20 }));
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: cx + 30, clientY: cy + 20 }));
  const result = {
    beforeFlip,
    maxTop,
    afterFlip: ts.scrollTop,
    hasSized: box.classList.contains('plugin-sized'),
  };
  // 清理注入，避免影响后续用例
  probe.remove();
  ts.style.maxHeight = '';
  ts.style.overflowY = '';
  return result;
})())`));
console.log("\n=== 滚动复位（走拖拽手柄真实路径） ===");
console.log(JSON.stringify(scrollResetViaHandle, null, 2));
check(
  "夹具已能制造非零滚动偏移（前置条件成立）",
  scrollResetViaHandle.beforeFlip > 0,
  `beforeFlip=${scrollResetViaHandle.beforeFlip} maxTop=${scrollResetViaHandle.maxTop}`
);
check(
  "拖拽进入拉伸态后 #text_show.scrollTop 被复位为 0（滚得到前面）",
  scrollResetViaHandle.hasSized === true && scrollResetViaHandle.afterFlip === 0,
  `beforeFlip=${scrollResetViaHandle.beforeFlip} afterFlip=${scrollResetViaHandle.afterFlip} hasSized=${scrollResetViaHandle.hasSized}`
);
await sleep(120);

/* ================= 填充：放大后插件内容是否随窗口铺满 ================= */
// 把 #ms-app 钉成放大后的窗口高度（等价真实窗口），量各层是否吃满、列表是否变高。
const fill = JSON.parse(await evalJs(`(function () {
  var app = document.getElementById('ms-app');
  var box = document.getElementById('my_search_box');
  var view = document.getElementById('my_search_view');
  var ts = document.getElementById('text_show');
  var pv = document.querySelector('#text_show .plugin-view');
  var sess = document.querySelector('#text_show .plugin-view > .ms-plugin-session');
  var fsapp = document.querySelector('#text_show .plugin-view .fs-app');
  var list = document.querySelector('#text_show .plugin-view .fs-list');
  // 把「窗口」改大到 600：真实环境里 #ms-app 吃满视口、window.innerHeight 同步变大，
  // 宿主在 resize 时把实测视口写进 --plugin-view-height。夹具要把这三件事一起做，
  // 只改 #ms-app 会让 innerHeight 与「窗口高度」脱节（钉高变量停在旧值）。
  Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });
  Object.defineProperty(window, 'innerWidth', { value: window.innerWidth, configurable: true });
  app.style.height = '600px';
  window.dispatchEvent(new Event('resize'));
  function h(el) { return el ? +el.getBoundingClientRect().height.toFixed(1) : null; }
  return JSON.stringify({
    app: h(app), box: h(box), view: h(view), text_show: h(ts),
    textShowMaxH: ts ? getComputedStyle(ts).maxHeight : null,
    pluginView: h(pv), session: h(sess), fsapp: h(fsapp), list: h(list),
    listMaxH: list ? getComputedStyle(list).maxHeight : null,
    boxHasClass: box.classList.contains('plugin-sized')
  });
})()`));
console.log("\n=== 填充（app 钉为 600） ===");
console.log(JSON.stringify(fill, null, 2));

// 内容区应当铺满：盒子 ≈ 600，且各层依次吃掉剩余空间（远大于原来的 68/68/68）
check("盒子高度吃满窗口（≈600）", Math.abs(fill.box - 600) <= 2, `box=${fill.box}`);
check("解除 #text_show 的 510px 上限", fill.textShowMaxH !== "510px", `maxH=${fill.textShowMaxH}`);
check(
  "详情区随窗口变高（远超原 68px）",
  fill.text_show > 400 && fill.pluginView > 400,
  `text_show=${fill.text_show} pluginView=${fill.pluginView}`
);
check(
  "插件根节点随窗口变高（内容不再留白）",
  fill.fsapp > 400,
  `fsapp=${fill.fsapp}`
);
check(
  "结果列表已解除 320px 固定上限（改为 flex 吃满剩余空间）",
  fill.listMaxH === "none",
  `listMaxH=${fill.listMaxH}`
);
check(
  "结果列表吃满剩余空间（可见时）",
  fill.list === 0 || fill.list > 200,
  `list=${fill.list}（0 = 未附件时的空态，hidden 属正常）`
);

/* ================= 双击手柄：恢复默认大小 + 回到常态位置 =================
 * 回归 1：双击还原时原来只还原尺寸、没还原位置 → 现在必须复位位置。
 * 回归 2（概率性）：还原时若在布局翻转中途解锁，ResizeObserver 的 fit() 会量到
 *   半变布局的小高度、与「默认高度」抢同一个防抖 pendingHeight → 概率性变很矮。
 *   合同：还原后**最后一次**下发的高度必须是正确的内容自适应高度（≈116），
 *   且此后一段时间内高度**不再变动**（没有迟到的小值），连点也稳定。
 */
const beforeReset = JSON.parse(await evalJs(`JSON.stringify((() => {
  window.__winOps = [];
  return {
    resetCalls: (window.__calls || []).filter((c) => c.cmd === 'reset_main_window_position').length,
    storedBefore: Object.keys(localStorage).filter((k) => k.includes('viewSize')).length,
  };
})())`));
// 竞态注入：双击的**同一时刻**让插件内容异步长高（模拟插件结果列表晚到）。
// 这会令 .plugin-view 的 ResizeObserver 在还原过渡期间排队一次 fit()——
// 正是「双击还原概率性变很矮」的触发条件。修好后的实现应把这段锁住，
// 最终仍落在正确的内容自适应高度。
await evalJs(`
  (() => {
    const root = document.querySelector('#text_show .plugin-view .fs-app') || document.querySelector('#text_show .plugin-view');
    if (root) {
      const tall = document.createElement('div');
      tall.className = '__race_probe';
      tall.style.cssText = 'height:40px;flex:0 0 auto';
      root.appendChild(tall);
    }
    const handle = document.querySelector('.plugin-resize-handle');
    handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  })(); 1`);
await sleep(300);
const afterReset = JSON.parse(await evalJs(`JSON.stringify((() => {
  const box = document.getElementById('my_search_box');
  // 双击还原走 Rust 通道：reset_main_window_position（宽度→屏幕分档）+ set_window_height（高度）
  const heights = (window.__calls || []).filter((c) => c.cmd === 'set_window_height').map((c) => c.args && c.args.height);
  return {
    resetCalls: (window.__calls || []).filter((c) => c.cmd === 'reset_main_window_position').length,
    storedAfter: Object.keys(localStorage).filter((k) => k.includes('viewSize')).length,
    boxHasClass: box.classList.contains('plugin-sized'),
    handleStillThere: !!document.querySelector('.plugin-resize-handle'),
    rawSizes: window.__sizes,
    heights,
    lastHeight: heights.length ? heights[heights.length - 1] : null,
  };
})())`));

// 静置一段时间再读一次：确认没有「迟到的小值」把高度打矮（竞态的直接体现）
await sleep(500);
const afterResetSettled = JSON.parse(await evalJs(`JSON.stringify((() => {
  const heights = (window.__calls || []).filter((c) => c.cmd === 'set_window_height').map((c) => c.args && c.args.height);
  return { heights, lastHeight: heights.length ? heights[heights.length - 1] : null, count: heights.length };
})())`));

console.log("\n=== 双击还原后 ===");
console.log(JSON.stringify({ beforeReset, afterReset, afterResetSettled }, null, 2));

check("双击前记忆存在", beforeReset.storedBefore >= 1, `stored=${beforeReset.storedBefore}`);
check("双击还原调用了 reset_main_window_position（位置回到常态）", afterReset.resetCalls > beforeReset.resetCalls, `before=${beforeReset.resetCalls} after=${afterReset.resetCalls}`);
check("双击还原清除了尺寸记忆", afterReset.storedAfter === 0, `stored=${afterReset.storedAfter}`);
check("双击还原后解除拉伸类（回到自适应布局）", afterReset.boxHasClass === false);
check("双击还原后手柄仍在（还能再次拖拽）", afterReset.handleStillThere === true);
check(
  "双击还原【最后】下发高度 == 当时盒子实测高度（量到的是稳定布局，非半变小值）",
  afterReset.lastHeight != null &&
    afterReset.rawSizes &&
    afterReset.rawSizes.length > 0 &&
    Math.abs(afterReset.rawSizes[afterReset.rawSizes.length - 1].h - afterReset.rawSizes[afterReset.rawSizes.length - 1].box) <= 2 &&
    afterReset.lastHeight >= 100,
  `lastHeight=${afterReset.lastHeight} raw=${JSON.stringify(afterReset.rawSizes.slice(-3))}`
);
check(
  "双击还原后静置 500ms 高度不再变动（无迟到的小值 → 竞态已修）",
  afterResetSettled.lastHeight != null && afterResetSettled.lastHeight >= 100 && afterResetSettled.lastHeight === afterReset.lastHeight,
  `settled=${afterResetSettled.lastHeight} vs after=${afterReset.lastHeight}`
);

/* ---- 连点两次双击：最终高度仍稳定正确（覆盖竞态） ---- */
await evalJs(`
  (() => {
    const handle = document.querySelector('.plugin-resize-handle');
    const r = handle.getBoundingClientRect();
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    // 先拖大，重新进入调整态
    handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 }));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: cx + 100, clientY: cy + 60 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: cx + 100, clientY: cy + 60 }));
  })(); 1`);
await sleep(200);
await evalJs(`
  (() => {
    const handle = document.querySelector('.plugin-resize-handle');
    handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  })(); 1`);
await sleep(600);
const rapid = JSON.parse(await evalJs(`JSON.stringify((() => {
  const heights = (window.__calls || []).filter((c) => c.cmd === 'set_window_height').map((c) => c.args && c.args.height);
  const box = document.getElementById('my_search_box');
  return {
    lastHeight: heights.length ? heights[heights.length - 1] : null,
    all: heights.slice(-6),
    boxH: box ? Math.round(box.getBoundingClientRect().height) : null,
  };
})())`));
console.log("\n=== 连点两次双击后 ===");
console.log(JSON.stringify(rapid, null, 2));
check(
  "连点两次双击：最终高度 == 内容自适应高度（稳定，无小值）",
  rapid.lastHeight != null && rapid.boxH != null && Math.abs(rapid.lastHeight - rapid.boxH) <= 2 && rapid.lastHeight >= 100,
  `lastHeight=${rapid.lastHeight} box=${rapid.boxH} tail=${JSON.stringify(rapid.all)}`
);

/* ================= 回归：还原后第一次拖拽不应「跳一下」 =================
 *
 * 用户报「窗口大小还原后第一次拖拽改变大小，感觉不太自然」。
 * 根因：onPluginResizeReset 先把拖拽手柄起点 pluginWindowSize 设为 base（打开插件
 * 那一刻缓存的默认尺寸），但还原后窗口实际落定在「这次重新量出的内容自适应高度」。
 * 插件内容若在打开后已变化（本用例额外塞高一段），base.height ≠ 实际高度；而手柄的
 * 拖拽起点取 pluginWindowSize（=base），第一次 mousemove 下发 base+delta，窗口从
 * 「实际尺寸」瞬间跳到「base+delta」→ 观感不自然。
 *
 * 修复：还原落定后把 pluginWindowSize 同步到实际尺寸。
 *
 * 用例：拖大 → 双击还原 → 塞高内容（改变实际落定高度）→ 第一次拖拽，
 * 断言下发的尺寸 = 实际落定尺寸 + 拖拽增量（连续），而非旧 base + 增量（跳变）。 */
const dragAfterReset = JSON.parse(await evalJs(`JSON.stringify((() => {
  // 1) 拖大进入调整态
  const handle = document.querySelector('.plugin-resize-handle');
  const r = handle.getBoundingClientRect();
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 }));
  document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: cx + 80, clientY: cy + 50 }));
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: cx + 80, clientY: cy + 50 }));
  // 2) 塞高插件内容（改变打开后的实际内容高度，制造 base 与实际的分歧）
  const root = document.querySelector('#text_show .plugin-view');
  const extra = document.createElement('div');
  extra.id = '__drag_after_reset_probe';
  extra.style.cssText = 'height:60px;flex:0 0 auto';
  if (root) root.appendChild(extra);
  return { ok: true };
})())`));
await sleep(200);
// 3) 双击还原
await evalJs(`(document.querySelector('.plugin-resize-handle')).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })); 1`);
await sleep(600);
// 4) 记录实际落定高度（取最近的一次 set_window_height / 盒子实测），再做第一次拖拽
const dragAfterResetProbe = JSON.parse(await evalJs(`JSON.stringify((() => {
  const box = document.getElementById('my_search_box');
  const settledH = box ? Math.round(box.getBoundingClientRect().height) : null;
  // 清空 winOps，单独看「第一次拖拽」下发的尺寸
  window.__winOps = [];
  const handle = document.querySelector('.plugin-resize-handle');
  const r = handle.getBoundingClientRect();
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  const dy = 30;
  handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 }));
  document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: cx, clientY: cy + dy }));
  return { settledH, dy, probeHeight: 60 };
})())`));
await sleep(150);
const dragAfterResetOp = JSON.parse(await evalJs(`JSON.stringify((() => {
  const ops = (window.__winOps || []).filter((o) => o.cmd === 'plugin:window|set_size');
  const last = ops.length ? ops[ops.length - 1] : null;
  return { count: ops.length, lastWhole: last };
})())`));
const dragAfterResetLastH = dragAfterResetOp?.lastWhole?.args?.value?.Logical?.height ?? null;
console.log("\n=== 还原后第一次拖拽 ===");
console.log(JSON.stringify({ dragAfterResetProbe, dragAfterResetOp }, null, 2));
// 落点应 ≈ 实际落定高度 + dy（连续），而不是「比实际矮很多/突然回跳」的旧 base + dy。
// 允许 6px 容差（rAF 与量测取整误差）。
check(
  "还原后第一次拖拽：下发高度从「实际落定尺寸」连续增长（无跳变）",
  dragAfterResetProbe.settledH != null &&
    dragAfterResetLastH != null &&
    Math.abs(dragAfterResetLastH - (dragAfterResetProbe.settledH + dragAfterResetProbe.dy)) <= 6,
  `settled=${dragAfterResetProbe.settledH} dy=${dragAfterResetProbe.dy} lastH=${dragAfterResetLastH}`
);

/* ================= 退出插件：窗口位置必须复位到常态 =================
 * 回归：插件页会把窗口移到自定义位置（set_position），退出时若只改尺寸不改位置，
 * 窗口会停在插件页那次定位的位置。合同：退出（Esc → hideTextView）后必须再发一次
 * reset_main_window_position（Rust 侧复用 position_window_top_center 复位位置）。
 * 这里在无头环境无法跑真 Rust，改为断言「调用了 reset_main_window_position」。
 *
 * 注意：上面双击还原已把状态退回常态，因此这里先再拖一次重新进入「插件调整态」，
 * 退出才应触发复位（守卫「仅离开插件调整态才复位」的语义）。
 */
const exitFixture = JSON.parse(await evalJs(`JSON.stringify((() => {
  const handle = document.querySelector('.plugin-resize-handle');
  const r = handle.getBoundingClientRect();
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 }));
  document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: cx + 60, clientY: cy + 40 }));
  window.__dragEnd2 = { x: cx + 60, y: cy + 40 };
  return { ok: true };
})())`));
// 等 rAF 跑完（class 是在 mousemove 的 rAF 回调里加的），再读状态
await sleep(120);
const exitSized = await evalJs(`document.getElementById('my_search_box').classList.contains('plugin-sized')`);
await evalJs(`document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: window.__dragEnd2.x, clientY: window.__dragEnd2.y })); 1`);
await sleep(120);

const beforeExitCalls = await evalJs(`(window.__calls || []).filter((c) => c.cmd === 'reset_main_window_position').length`);
await evalJs(`
  (() => {
    const el = document.getElementById('my_search_input');
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  })(); 1`);
await sleep(300);
const exitProbe = JSON.parse(await evalJs(`JSON.stringify((() => {
  const box = document.getElementById('my_search_box');
  return {
    resetCalls: (window.__calls || []).filter((c) => c.cmd === 'reset_main_window_position').length,
    boxHasClass: box.classList.contains('plugin-sized'),
    hasPluginView: !!document.querySelector('#text_show .plugin-view'),
  };
})())`));
console.log("\n=== 退出插件后 ===");
console.log(JSON.stringify({ exitSized, beforeExitCalls, ...exitProbe }, null, 2));

check("重新拖拽后回到插件调整态", exitSized === true);
check("退出插件时调用了 reset_main_window_position（复位窗口位置）", exitProbe.resetCalls > beforeExitCalls, `before=${beforeExitCalls} after=${exitProbe.resetCalls}`);
check("退出后去掉了 plugin-sized 拉伸类（普通布局恢复）", exitProbe.boxHasClass === false);

console.log(`\n结果: ${pass} passed, ${fail} failed`);
server.close();
chrome.kill();
process.exit(fail === 0 ? 0 : 1);
