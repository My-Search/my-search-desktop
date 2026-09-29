/**
 * 诊断：插件拉伸态下「输入框那一行被压缩很小」。
 *
 * 复现时序（与用户反馈一致）：
 *   打开插件（内容自适应）→ 拖右下角手柄进入拉伸态（下发窗口尺寸 + 钉高变量）
 *   → 插件内容随后长高（异步出结果，比窗口高）→ 量 #searchBox（输入框行）高度。
 *
 * 预期（修复前）：拉伸态 #my_search_view 是 flex 竖列，而 #searchBox 是默认
 * `flex: 0 1 auto` 且 `overflow:hidden`（自动最小尺寸 = 0）→ 可被压缩，
 * 内容越高输入框越矮。
 * 预期（修复后）：#searchBox 恒为 44px，剩余收缩全部由内容区承担。
 *
 * 用法: npm run build && node test/_diag-searchbox-shrink.mjs
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
const userDir = path.join(root, "test", "_chrome-profile-searchbox-shrink");
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
    throw new Error(
      JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails).slice(0, 800)
    );
  }
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

await S(
  "Page.addScriptToEvaluateOnNewDocument",
  {
    source: `
    window.__files = ${JSON.stringify(PLUGIN_FILES)};
    window.__calls = [];
    window.__TAURI_INTERNALS__ = {
      invoke(cmd, args) {
        try { window.__calls.push({ cmd, args }); } catch (e) {}
        if (cmd === 'set_window_height') return Promise.resolve(null);
        if (cmd === 'plugin:window|set_size') {
          window.__winOps = window.__winOps || [];
          window.__winOps.push({ cmd, args });
          return Promise.resolve(null);
        }
        if (cmd === 'plugin:window|set_position') {
          window.__winOps = window.__winOps || [];
          window.__winOps.push({ cmd, args });
          return Promise.resolve(null);
        }
        if (cmd === 'plugin:window|scale_factor') return Promise.resolve(1);
        if (cmd === 'plugin:window|current_monitor')
          return Promise.resolve({ name: 'Mock', scaleFactor: 1, position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 }, workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } } });
        if (cmd === 'reset_main_window_position') return new Promise((r) => setTimeout(() => r(null), 60));
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

// 视口 = 窗口：初始给一个够高的窗口，插件才能正常打开
await S("Emulation.setDeviceMetricsOverride", { width: 760, height: 600, deviceScaleFactor: 1, mobile: false }, sessionId);
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

const snap = (label) =>
  evalJs(`JSON.stringify((() => {
    const box = document.getElementById('my_search_box');
    const sb = document.getElementById('searchBox');
    const view = document.getElementById('my_search_view');
    const ts = document.getElementById('text_show');
    const pv = document.querySelector('#text_show .plugin-view');
    const h = (el) => el ? +el.getBoundingClientRect().height.toFixed(1) : null;
    return {
      label: ${JSON.stringify(label)},
      innerH: window.innerHeight,
      viewH: h(view), searchBoxH: h(sb), textShowH: h(ts), pluginViewH: h(pv), boxH: h(box),
      viewDisplay: view ? getComputedStyle(view).display : null,
      sbFlex: sb ? getComputedStyle(sb).flex : null,
      sized: box ? box.classList.contains('plugin-sized') : null,
      boxVar: box ? box.style.getPropertyValue('--plugin-view-height') : null,
    };
  })())`);

console.log("\n=== 打开插件后 ===");
console.log(await snap("after-open"));

/* ================= 拖手柄进入拉伸态 ================= */
const drag = JSON.parse(await evalJs(`JSON.stringify((() => {
  const handle = document.querySelector('.plugin-resize-handle');
  const r = handle.getBoundingClientRect();
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  window.__winOps = [];
  handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 }));
  document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: cx + 10, clientY: cy + 20 }));
  return { cx, cy };
})())`));
await sleep(150);
console.log("\n=== 拖拽中（拉伸态已启用） ===");
console.log(await snap("during-drag"));

await evalJs(`document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: ${drag.cx + 10}, clientY: ${drag.cy + 20} })); 1`);
await sleep(200);

/* 让「窗口尺寸」落地 = 视口更新（真实环境 setSize 后视口才跟上） */
const target = JSON.parse(await evalJs(`JSON.stringify((() => {
  const ops = (window.__winOps || []).filter((o) => o.cmd === 'plugin:window|set_size');
  const last = ops.length ? ops[ops.length - 1] : null;
  const box = document.getElementById('my_search_box');
  return { size: last ? last.args.value.Logical : null, boxH: box ? Math.round(box.getBoundingClientRect().height) : null, varH: box ? box.style.getPropertyValue('--plugin-view-height') : null };
})())`));
console.log("\n=== 目标窗口尺寸 ===");
console.log(JSON.stringify(target));
if (target.size) {
  await S(
    "Emulation.setDeviceMetricsOverride",
    { width: Math.round(target.size.width), height: Math.round(target.size.height), deviceScaleFactor: 1, mobile: false },
    sessionId
  );
}
await sleep(250);
console.log("\n=== 视口更新后（拉伸态稳定） ===");
console.log(await snap("after-viewport"));

/* ================= 关键：插件内容随后长高（比窗口高） ================= */
await evalJs(`
  (() => {
    const pv = document.querySelector('#text_show .plugin-view');
    const tall = document.createElement('div');
    tall.id = '__tall_probe';
    tall.style.cssText = 'height:2000px;flex:0 0 auto';
    pv.appendChild(tall);
    return 1;
  })()`);
await sleep(300);
console.log("\n=== 插件内容长高后（复现用户场景） ===");
const after = JSON.parse(await snap("content-taller"));
console.log(JSON.stringify(after, null, 2));

const sbH = after.searchBoxH;
console.log(`\n>>> searchBox 高度 = ${sbH}px（设计值 44px）`);
if (sbH != null && sbH < 40) {
  console.log(">>> 复现成功：输入框行被 flex 收缩压缩");
} else {
  console.log(">>> 未复现：输入框行保持固定高度");
}
if (pageErrors.length) console.log("=== errors ===\n" + pageErrors.join("\n"));

server.close();
chrome.kill();
process.exit(0);
