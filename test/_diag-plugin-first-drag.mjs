/**
 * 诊断：插件页「首次打开（无尺寸记忆）后，轻微拖拽右下角 → 下方高度被压缩」复现。
 *
 * 复现真实时序：打开插件（内容自适应高）→ 手柄 mousedown/mousemove（很小增量）
 * → 宿主 applyWindowSize（setSize 异步）+ 视口随后更新 → 量各层高度。
 *
 * 视口用 CDP Emulation.setDeviceMetricsOverride 模拟：先保持旧视口（setSize 异步），
 * 再延迟到下一帧改成新视口（模拟 WebView2 setSize 后视口滞后更新）。
 *
 * 用法: npm run build && node test/_diag-plugin-first-drag.mjs
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
const userDir = path.join(root, "test", "_chrome-profile-diag-first-drag");
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
    "--window-size=760,600",
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
await S("Emulation.setDeviceMetricsOverride", { width: 760, height: 116, deviceScaleFactor: 1, mobile: false }, sessionId);
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
    window.__sizes = [];
    window.__TAURI_INTERNALS__ = {
      invoke(cmd, args) {
        try { window.__calls.push({ cmd, args }); } catch (e) {}
        if (cmd === 'set_window_height') {
          const box = document.getElementById('my_search_box');
          window.__sizes.push({ cmd, h: args && args.height, box: box ? Math.round(box.getBoundingClientRect().height) : null, sized: box ? box.classList.contains('plugin-sized') : null });
          return Promise.resolve(null);
        }
        // 模拟真实 setSize：异步改「窗口」= 改视口。用 ResizeObserver 观察宿主发出的 set_size
        // 之后由外层脚本用 __applyViewport 手动改视口，以复现「视口滞后」时序。
        if (cmd === 'plugin:window|set_size') {
          window.__winOps = window.__winOps || [];
          window.__winOps.push({ cmd, args });
          window.__pendingSize = args && args.value && args.value.Logical;
          return Promise.resolve(null);
        }
        if (cmd === 'plugin:window|set_position' || cmd === 'plugin:window|scale_factor') return Promise.resolve(cmd === 'plugin:window|scale_factor' ? 1 : null);
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

/* ================= 打开插件（无尺寸记忆） ================= */
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
    const ts = document.getElementById('text_show');
    const pv = document.querySelector('#text_show .plugin-view');
    const app = document.getElementById('ms-app');
    return {
      label: ${JSON.stringify(label)},
      innerH: window.innerHeight,
      appH: app ? +app.getBoundingClientRect().height.toFixed(1) : null,
      boxH: box ? +box.getBoundingClientRect().height.toFixed(1) : null,
      textShowH: ts ? +ts.getBoundingClientRect().height.toFixed(1) : null,
      pluginViewH: pv ? +pv.getBoundingClientRect().height.toFixed(1) : null,
      sized: box ? box.classList.contains('plugin-sized') : null,
      boxVar: box ? box.style.getPropertyValue('--plugin-view-height') : null,
      stored: Object.keys(localStorage).filter((k) => k.includes('viewSize')).length,
    };
  })())`);

console.log("\\n=== 打开插件后（应无 sizes，无 plugin-sized） ===");
console.log(await snap("after-open"));

/* ================= 首次轻微拖拽（无记忆场景） =================
 * 手柄 mousedown → mousemove(+3,+2) → mouseup；真实环境 set_size 异步改窗口，
 * 视口随后更新。这里：先发拖拽，量「set_size 已发生但视口尚未更新」的中间态，
 * 再手动把视口改成新尺寸，量最终态。 */
const dragInfo = JSON.parse(await evalJs(`JSON.stringify((() => {
  const handle = document.querySelector('.plugin-resize-handle');
  const box = document.getElementById('my_search_box');
  const r = handle.getBoundingClientRect();
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  window.__winOps = [];
  handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 }));
  document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: cx + 6, clientY: cy + 3 }));
  return { boxHBefore: box ? +box.getBoundingClientRect().height.toFixed(1) : null, innerHBefore: window.innerHeight, cx, cy };
})())`));
console.log("\\n=== 拖拽中（rAF 后） ===");
await sleep(150);
console.log(await snap("during-drag"));
const during = JSON.parse(await evalJs(`JSON.stringify({ pending: (window.__winOps && window.__winOps.length) ? window.__winOps[window.__winOps.length-1].args.value.Logical : null, raw: window.__winOps, ops: (window.__winOps||[]).map(o=>o.cmd) })`));
console.log("pending size:", JSON.stringify(during));

// 让 set_size 真正生效：把视口改成待应用尺寸（模拟窗口尺寸落地 → 视口更新）
const lastOp = Array.isArray(during.raw) && during.raw.length ? during.raw[during.raw.length - 1] : null;
const targetSize = lastOp && lastOp.args && lastOp.args.value ? lastOp.args.value.Logical : null;
if (targetSize) {
  console.log(">>> emulating viewport", JSON.stringify(targetSize));
  await S("Emulation.setDeviceMetricsOverride", { width: Math.round(targetSize.width), height: Math.round(targetSize.height), deviceScaleFactor: 1, mobile: false }, sessionId);
} else {
  console.log(">>> no pending size captured; skip viewport change");
}
await sleep(200);
console.log("\\n=== 视口更新后（窗口已改大小） ===");
console.log(await snap("after-viewport"));

await evalJs(`document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: ${dragInfo.cx + 6}, clientY: ${dragInfo.cy + 3} })); 1`);
await sleep(300);
console.log("\\n=== 松手后 ===");
console.log(await snap("after-mouseup"));

console.log("\\n=== console ===");
console.log(logs.slice(-25).join("\\n"));
if (pageErrors.length) console.log("=== errors ===\\n" + pageErrors.join("\\n"));

server.close();
chrome.kill();
process.exit(0);
