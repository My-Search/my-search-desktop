/**
 * 诊断 2：插件市场（长内容滚动页）首次打开（无尺寸记忆）后轻微拖拽 → 高度是否被压缩。
 * 用法: npm run build && node test/_diag-market-first-drag.mjs
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
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };
const server = createServer(async (req, res) => {
  try {
    const u = decodeURIComponent(req.url.split("?")[0]);
    const file = path.join(dist, u === "/" ? "/index.html" : u);
    if (!file.startsWith(dist)) return res.writeHead(403).end("forbidden");
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404).end("not found"); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const candidates = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"];
const bin = candidates.find((p) => existsSync(p));
if (!bin) { console.log("未找到浏览器，跳过"); server.close(); process.exit(0); }
const userDir = path.join(root, "test", "_chrome-profile-diag-market");
await rm(userDir, { recursive: true, force: true });
const chrome = spawn(bin, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${userDir}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const wsUrl = await new Promise((resolve, reject) => {
  let buf = ""; const t = setTimeout(() => reject(new Error("浏览器启动超时")), 20000);
  chrome.stderr.on("data", (d) => { buf += d.toString(); const m = buf.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) { clearTimeout(t); resolve(m[1]); } });
});
const ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map(); const pageErrors = []; const logs = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === "Runtime.exceptionThrown") pageErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  if (msg.method === "Runtime.consoleAPICalled") logs.push(`[${msg.params.type}] ` + (msg.params.args || []).map((a) => a.value ?? a.description ?? "").join(" "));
};
function S(method, params = {}, sessionId) { return new Promise((resolve) => { const mid = ++id; pending.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params, sessionId })); }); }
const { result: targets } = await S("Target.getTargets");
const pageTarget = targets.targetInfos.find((t) => t.type === "page");
const { result: { sessionId } } = await S("Target.attachToTarget", { targetId: pageTarget.targetId, flatten: true });
await S("Runtime.enable", {}, sessionId);
await S("Page.enable", {}, sessionId);
await S("Emulation.setDeviceMetricsOverride", { width: 760, height: 48, deviceScaleFactor: 1, mobile: false }, sessionId);
const evalJs = async (expr) => {
  const r = await S("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails).slice(0, 800));
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 模拟「真实窗口跟随宿主下发尺寸」：把最近一次 set_window_height / set_size 落地为视口尺寸 */
let curW = 760, curH = 48;
async function settleViewport(label = "") {
  const raw = await evalJs(`JSON.stringify(window.__winOps || [])`);
  let ops = [];
  try { ops = JSON.parse(raw); } catch (e) {}
  const last = ops.length ? ops[ops.length - 1] : null;
  let w = curW, h = curH;
  if (last && last.cmd === "set_window_height" && last.args && last.args.height) h = Math.round(last.args.height);
  else if (last && last.cmd === "plugin:window|set_size" && last.args && last.args.value && last.args.value.Logical) { w = Math.round(last.args.value.Logical.width); h = Math.round(last.args.value.Logical.height); }
  if (w > 0 && h > 0 && (w !== curW || h !== curH)) {
    curW = w; curH = h;
    await S("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false }, sessionId);
    await sleep(80);
    if (label) console.log(`  [viewport → ${w}x${h}] ${label}`);
  }
}

const PLUGIN_ID = "com.mysearch.market";
const PLUGIN_DIR = path.join(root, "plugins", "market");
const manifest = JSON.parse(readFileSync(path.join(PLUGIN_DIR, "plugin.json"), "utf8"));
const PLUGIN_FILES = {
  [PLUGIN_ID]: {
    "ui/detail.html": readFileSync(path.join(PLUGIN_DIR, "ui", "detail.html"), "utf8"),
    "ui/detail.css": readFileSync(path.join(PLUGIN_DIR, "ui", "detail.css"), "utf8"),
    "ui/index.js": readFileSync(path.join(PLUGIN_DIR, "ui", "index.js"), "utf8"),
  },
};
console.log("manifest:", JSON.stringify(manifest).slice(0, 300));
const now = Date.now();
const RECORD = {
  id: PLUGIN_ID, name: manifest.name, version: manifest.version, apiVersion: manifest.apiVersion, description: manifest.description, manifest,
  dir: `plugins/${PLUGIN_ID}`, source: { kind: "builtin", ref: "builtin" }, installedAt: now, updatedAt: now, enabled: true,
  autoStart: "on-demand", requestedAutoStart: "on-demand", closeBehavior: manifest.contributes.detailView.closeBehavior,
  grants: [{ permission: "ui.inlay", at: now, source: "install" }, { permission: "net.fetch", at: now, source: "install" }, { permission: "system.openExternal", at: now, source: "install" }],
  denied: [], runtime: { status: "stopped", pid: null, memoryBytes: null, startedAt: null, restarts: 0, lastError: null, keepAliveReasons: [] }, integrity: { sha256: null, signed: false },
};

await S("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.__files = ${JSON.stringify(PLUGIN_FILES)};
    window.__calls = [];
    window.__winOps = [];
    window.__TAURI_INTERNALS__ = {
      invoke(cmd, args) {
        try { window.__calls.push({ cmd, args }); } catch (e) {}
        if (cmd === 'set_window_height') {
          // 忠实模拟 Rust：改窗口高度 → 视口随后更新。这里记录，由外层脚本用
          // Emulation.setDeviceMetricsOverride 落地（保持宽度不变）。
          window.__winOps.push({ cmd, args });
          return Promise.resolve(null);
        }
        if (cmd === 'plugin:window|set_size') { window.__winOps.push({ cmd, args }); return Promise.resolve(null); }
        if (cmd === 'plugin:window|set_position' || cmd === 'plugin:window|scale_factor') return Promise.resolve(cmd === 'plugin:window|scale_factor' ? 1 : null);
        if (cmd === 'plugin:window|current_monitor') return Promise.resolve({ name: 'Mock', scaleFactor: 1, position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 }, workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } } });
        if (cmd === 'reset_main_window_position') return new Promise((r) => setTimeout(() => r(null), 60));
        if (cmd === 'plugin_read_text') { const f = window.__files[args.pluginId] || {}; const t = f[args.relPath]; return t == null ? Promise.reject('文件不存在: ' + args.relPath) : Promise.resolve(t); }
        if (cmd === 'plugin_read_binary') return Promise.reject('无图标');
        if (cmd === 'plugin_backend_list') return Promise.resolve([]);
        if (cmd === 'get_default_subscribe_text') return Promise.resolve('');
        if (cmd === 'get_toggle_shortcut') return Promise.resolve('ctrl+alt+s');
        if (cmd === 'get_autostart_enabled') return Promise.resolve(false);
        if (cmd === 'plugin:event|listen' && args && args.event) { const list = window.__eventHandlers.get(args.event) || []; list.push(args.handler); window.__eventHandlers.set(args.event, list); return Promise.resolve(window.__eventNextId++); }
        return Promise.resolve(null);
      },
      transformCallback(cb) { const cbId = Math.random().toString(36).slice(2); window.__cbIds = window.__cbIds || {}; window.__cbIds[cbId] = cb; return cbId; },
      unregisterCallback(cbId) { delete (window.__cbIds || {})[cbId]; },
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } }, plugins: {},
    };
    window.__eventHandlers = new Map(); window.__eventNextId = 1;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(){} };
    window.__emitTauriEvent = (event, payload) => { const list = window.__eventHandlers.get(event) || []; list.forEach((idOrFn) => { const cb = typeof idOrFn === 'function' ? idOrFn : (window.__cbIds || {})[idOrFn]; if (typeof cb === 'function') { try { cb({ event, id: window.__eventNextId++, payload }); } catch (e) {} } }); return list.length; };
  ` }, sessionId);

await S("Page.navigate", { url: base + "/index.html" }, sessionId);
await sleep(600);
await evalJs(`(() => { localStorage.clear(); localStorage.setItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY', JSON.stringify({ version: 1, plugins: ${JSON.stringify([RECORD])} })); localStorage.setItem('my-search-desktop:SEARCH_DATA_KEY', JSON.stringify({ data: [], expire: Date.now() + 3600 * 1000 })); return 1; })()`);
await S("Page.navigate", { url: base + "/index.html" }, sessionId);
await sleep(1500);

await evalJs(`(() => { const el = document.getElementById('my_search_input'); el.focus(); el.value = '插件'; el.dispatchEvent(new Event('input', { bubbles: true })); })(); 1`);
await sleep(900);
await settleViewport("搜索框展开");
await evalJs(`(() => { const el = document.getElementById('my_search_input'); el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })(); 1`);
await sleep(1500);
await settleViewport("插件打开");

const snap = (label) => evalJs(`JSON.stringify((() => {
  const box = document.getElementById('my_search_box');
  const ts = document.getElementById('text_show');
  const pv = document.querySelector('#text_show .plugin-view');
  const sess = document.querySelector('#text_show .plugin-view > .ms-plugin-session');
  const page = document.querySelector('#text_show .plugin-view .page') || document.querySelector('#text_show .plugin-view > .ms-plugin-session > *');
  const app = document.getElementById('ms-app');
  const h = (el) => el ? +el.getBoundingClientRect().height.toFixed(1) : null;
  const cs = page ? getComputedStyle(page) : null;
  return { label: ${JSON.stringify(label)}, innerH: window.innerHeight, appH: h(app), boxH: h(box), textShowH: h(ts), pluginViewH: h(pv), sessionH: h(sess), pageH: h(page),
    pageOverflowY: cs ? cs.overflowY : null, pageScrollH: page ? page.scrollHeight : null,
    sized: box ? box.classList.contains('plugin-sized') : null, boxVar: box ? box.style.getPropertyValue('--plugin-view-height') : null,
    stored: Object.keys(localStorage).filter((k) => k.includes('viewSize')).length };
})())`);

console.log("\\n=== 打开市场插件后（无记忆） ===");
console.log(await snap("after-open"));

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
await sleep(150);
await settleViewport("拖拽中");
console.log("\\n=== 拖拽中 ===");
console.log(await snap("during-drag"));
const raw = await evalJs(`JSON.stringify(window.__winOps || [])`);
console.log("winOps:", raw);
await evalJs(`document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: ${dragInfo.cx + 6}, clientY: ${dragInfo.cy + 3} })); 1`);
await sleep(350);
await settleViewport("松手");
console.log("\\n=== 松手后 ===");
console.log(await snap("after-mouseup"));
console.log("\\n=== market console ===");
console.log(logs.filter((l) => /market|插件市场/i.test(l)).slice(-20).join("\\n"));
if (pageErrors.length) console.log("=== errors ===\\n" + pageErrors.join("\\n"));
server.close(); chrome.kill(); process.exit(0);
