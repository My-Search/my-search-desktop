/**
 * 诊断：「文件搜索」结果列表滚到底却看不到最后一行（底部被裁）。
 *
 * 用真实 dist + 真实插件源码，注入大量结果，分别在
 *   常态（#text_show 自身滚动）与 拉伸态（.plugin-sized，.fs-list 内部滚动）
 * 下量：谁是滚动容器、scrollTop 能否到底、最后一行底边是否被容器裁掉。
 *
 * 用法: npm run build && node test/_diag-file-search-bottom.mjs
 */
import { createServer } from "http";
import { readFile } from "fs/promises";
import { spawn } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
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

const bin = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find((p) => existsSync(p));
if (!bin) { console.log("未找到浏览器"); server.close(); process.exit(0); }
const chrome = spawn(bin, ["--headless=new", "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--disable-gpu", `--user-data-dir=${path.join(root, "test", "_chrome-profile-diag-fs-bottom")}`, "about:blank"]);
const wsUrl = await new Promise((resolve, reject) => {
  let buf = "";
  chrome.stderr.on("data", (d) => { buf += d.toString(); const m = buf.match(/ws:\/\/[^\s]+/); if (m) resolve(m[0]); });
  setTimeout(() => reject(new Error("devtools timeout")), 20000);
});
const ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));
let msgId = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const S = (method, params = {}, sessionId) => new Promise((resolve) => { const id = ++msgId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params, sessionId })); });
const { result: targets } = await S("Target.getTargets");
const page = targets.targetInfos.find((t) => t.type === "page");
const { result: attach } = await S("Target.attachToTarget", { targetId: page.targetId, flatten: true });
const sessionId = attach.sessionId;
await S("Page.enable", {}, sessionId);
await S("Runtime.enable", {}, sessionId);
// 真实窗口尺寸：搜索窗默认 800 宽；插件视图内容区上限 560（含搜索框）
const VW = Number(process.env.VW || 800);
const VH = Number(process.env.VH || 560);
await S("Emulation.setDeviceMetricsOverride", { width: VW, height: VH, deviceScaleFactor: 1, mobile: false }, sessionId);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evalJs = async (expr) => {
  const r = await S("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "eval error");
  return r.result?.result?.value;
};

const PLUGIN_ID = "com.mysearch.file-search";
const PLUGIN_DIR = path.join(root, "plugins", "file-search");
const manifest = JSON.parse(readFileSync(path.join(PLUGIN_DIR, "plugin.json"), "utf8"));
const PLUGIN_FILES = { [PLUGIN_ID]: {
  "ui/detail.html": readFileSync(path.join(PLUGIN_DIR, "ui", "detail.html"), "utf8"),
  "ui/detail.css": readFileSync(path.join(PLUGIN_DIR, "ui", "detail.css"), "utf8"),
  "ui/index.js": readFileSync(path.join(PLUGIN_DIR, "ui", "index.js"), "utf8"),
  "icon.svg": readFileSync(path.join(PLUGIN_DIR, "icon.svg"), "utf8"),
} };
const now = Date.now();
const RECORD = { id: PLUGIN_ID, name: manifest.name, version: manifest.version, apiVersion: manifest.apiVersion, description: manifest.description, manifest, dir: `plugins/${PLUGIN_ID}`, source: { kind: "builtin", ref: "builtin" }, installedAt: now, updatedAt: now, enabled: true, autoStart: "on-demand", requestedAutoStart: "on-demand", closeBehavior: manifest.contributes.detailView.closeBehavior, grants: [{ permission: "ui.inlay", at: now, source: "install" }, { permission: "file.read", at: now, source: "install" }], denied: [], runtime: { status: "stopped", pid: null, memoryBytes: null, startedAt: null, restarts: 0, lastError: null, keepAliveReasons: [] }, integrity: { sha256: null, signed: false } };
const ROOT = "C:/demo/大目录";
const N = 40;
// 刻意用**超长文件名 / 深路径**（复刻用户截图那种宽内容），验证是否触发水平溢出
const LONG_REL = "86ce177e/videos/001_weixin010微信阅读小程序-微信端-超长名称用于测试水平溢出.mp4";
const FULL = Array.from({ length: N }, (_, i) => ({ path: `${ROOT}/${LONG_REL}#${i}`, name: `001_weixin010微信阅读小程序-微信端-超长名称-${i}.mp4`, relPath: LONG_REL, isDir: false, size: 1000 * (i + 1), mtimeMs: 1727000000000 + i }));

await S("Page.addScriptToEvaluateOnNewDocument", { source: `
  window.__files = ${JSON.stringify(PLUGIN_FILES)};
  window.__roots = [{ path: ${JSON.stringify(ROOT)}, isDir: true }];
  window.__full = ${JSON.stringify(FULL)};
  window.__TAURI_INTERNALS__ = {
    invoke(cmd, args) {
      if (cmd === 'set_window_height') return Promise.resolve(null);
      if (cmd === 'plugin_read_text') { const f = window.__files[args.pluginId] || {}; const t = f[args.relPath]; return t == null ? Promise.reject('x') : Promise.resolve(t); }
      if (cmd === 'plugin_read_binary') return Promise.reject('无');
      if (cmd === 'plugin_backend_list') return Promise.resolve([]);
      if (cmd === 'get_default_subscribe_text') return Promise.resolve('');
      if (cmd === 'get_toggle_shortcut') return Promise.resolve('ctrl+alt+s');
      if (cmd === 'get_autostart_enabled') return Promise.resolve(false);
      if (cmd === 'attachments_sync') { window.__roots = args.entries || []; return Promise.resolve(null); }
      if (cmd === 'attachment_list') return Promise.resolve(window.__full.map((e) => ({ ...e })));
      if (cmd === 'attachment_list_cancel') return Promise.resolve(null);
      if (cmd === 'attachment_file_icons') return Promise.resolve([]);
      if (cmd === 'attachment_reveal' || cmd === 'attachment_open') return Promise.resolve(null);
      if (cmd === 'clipboard_file_paths') return Promise.resolve(window.__roots.map((r) => r.path));
      if (cmd === 'fs_describe_paths') { const ps = args.paths || []; return Promise.resolve(ps.map((p) => ({ path: p, name: String(p).split(/[\\\\/]/).pop() || p, isDir: true }))); }
      if (cmd === 'plugin:event|listen' && args && args.event) { const list = window.__eventHandlers.get(args.event) || []; list.push(args.handler); window.__eventHandlers.set(args.event, list); return Promise.resolve(window.__eventNextId++); }
      return Promise.resolve(null);
    },
    transformCallback(cb) { const id = Math.random().toString(36).slice(2); window.__cbIds = window.__cbIds || {}; window.__cbIds[id] = cb; return id; },
    unregisterCallback(id) { delete (window.__cbIds || {})[id]; },
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } }, plugins: {},
  };
  window.__eventHandlers = new Map(); window.__eventNextId = 1;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(){} };
  window.__emitTauriEvent = () => 0;
`, }, sessionId);

await S("Page.navigate", { url: base + "/index.html" }, sessionId);
await sleep(600);
await evalJs(`(() => { localStorage.clear(); localStorage.setItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY', JSON.stringify({ version: 1, plugins: ${JSON.stringify([RECORD])} })); localStorage.setItem('my-search-desktop:SEARCH_DATA_KEY', JSON.stringify({ data: [], expire: Date.now() + 3600e3 })); return 1; })()`);
await S("Page.navigate", { url: base + "/index.html" }, sessionId);
await sleep(1600);

await evalJs(`(() => { const el = document.getElementById('my_search_input'); el.focus(); el.value = '文件搜索'; el.dispatchEvent(new Event('input', { bubbles: true })); })(); 1`);
await sleep(700);
await evalJs(`(() => { const el = document.getElementById('my_search_input'); el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })(); 1`);
await sleep(1200);
await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); 1`);
await sleep(600);
await evalJs(`(() => { const input = document.getElementById('my_search_input'); const dt = new DataTransfer(); dt.items.add(new File(['x'], 'p', { type: 'application/octet-stream' })); input.focus(); input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt })); })(); 1`);
await sleep(1200);
await evalJs(`(() => { const el = document.getElementById('my_search_input'); el.focus(); el.value = '文件搜索 : '; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })(); 1`);
await sleep(2000);

// 可选：进入「插件拉伸态」（用户拖大/改小过插件窗口时的布局）
if (process.env.SIZED === "1") {
  // VARH = 宿主写入 --plugin-view-height 的值（默认同视口）；可单独调大以模拟
  // 「变量比真实视口高」的失配情形
  const varH = Number(process.env.VARH || VH);
  await evalJs(`(() => {
    const box = document.getElementById('my_search_box');
    box.classList.add('plugin-sized');
    box.style.setProperty('--plugin-view-height', '${varH}px');
    window.dispatchEvent(new Event('resize'));
    return 1;
  })()`);
  await sleep(500);
}

const probe = await evalJs(`JSON.stringify((() => {
  const q = (s) => document.querySelector(s);
  // 可选：注入候选修复 CSS，验证效果。
  // 必须挂到 <body>：插件样式在 body 里（.ms-plugin-session 内），同优先级下
  // 「文档顺序靠后」者胜——挂 head 会被插件自己的样式压掉。
  if (${JSON.stringify(process.env.INJECT_CSS || "")}) {
    let st = document.getElementById('__fix_probe');
    if (!st) { st = document.createElement('style'); st.id = '__fix_probe'; document.body.appendChild(st); }
    st.textContent = ${JSON.stringify(process.env.INJECT_CSS || "")};
  }
  const box = q('#my_search_box'), ts = q('#text_show'), pv = q('#text_show .plugin-view'),
        sess = q('#text_show .plugin-view > .ms-plugin-session'), app = q('#text_show .plugin-view .fs-app'),
        list = q('#text_show .plugin-view .fs-list');
  const rows = Array.from(document.querySelectorAll('.fs-row'));
  const boxOf = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1), h: +r.height.toFixed(1) }; };
  // 谁真的在滚？读 scrollHeight vs clientHeight
  const scrollInfo = (el, name) => { if (!el) return { name, missing: true }; const cs = getComputedStyle(el); return { name, overflowY: cs.overflowY, overflowX: cs.overflowX, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrollTop: el.scrollTop, scrollLeft: el.scrollLeft, canScrollY: el.scrollHeight > el.clientHeight, hOverflow: el.scrollWidth > el.clientWidth, maxTop: el.scrollHeight - el.clientHeight }; };
  // 只滚**用户真正能滚**的容器（overflowY = auto/scroll）。overflow:visible 的
  // 元素即便 scrollHeight > clientHeight，滚轮/滚动条也够不着（只有脚本能设
  // scrollTop）——把它算进来会掩盖真实缺陷。
  const userScrollable = (el) => { if (!el) return false; const oy = getComputedStyle(el).overflowY; return (oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight; };
  [ts, pv, sess, app, list].forEach((el) => { if (userScrollable(el)) el.scrollTop = el.scrollHeight; });
  // .fs-app 的直接子项高度（诊断「固定头部挤掉列表」）
  const appKids = app ? Array.from(app.children).map((c) => ({ cls: c.className, h: +c.getBoundingClientRect().height.toFixed(1), flex: getComputedStyle(c).flex, minH: getComputedStyle(c).minHeight })) : [];
  const lastRow = rows[rows.length - 1];
  const lastBox = boxOf(lastRow);
  const listBox = boxOf(list);
  const tsBox = boxOf(ts);
  return {
    sized: box ? box.classList.contains('plugin-sized') : null,
    rowCount: rows.length,
    appKids,
    appKidSum: +appKids.reduce((s, k) => s + k.h, 0).toFixed(1),
    lastRowVisibleBottomVsListBottom: lastBox && listBox ? +(lastBox.bottom - listBox.bottom).toFixed(1) : null,
    lastRowVisibleBottomVsTextShowBottom: lastBox && tsBox ? +(lastBox.bottom - tsBox.bottom).toFixed(1) : null,
    // 真问题指标：滚遍所有滚动容器后，最后一行是否落在 #text_show 的可见框内
    lastRowReachable: !!(lastBox && tsBox && lastBox.bottom <= tsBox.bottom + 0.5 && lastBox.top >= tsBox.top - 0.5),
    boxes: { box: boxOf(box), ts: tsBox, pv: boxOf(pv), sess: boxOf(sess), app: boxOf(app), list: listBox, lastRow: lastBox },
    scroll: [scrollInfo(ts, "#text_show"), scrollInfo(list, ".fs-list"), scrollInfo(pv, ".plugin-view"), scrollInfo(app, ".fs-app")],
    win: { innerHeight: window.innerHeight, innerWidth: window.innerWidth },
    tsMaxH: ts ? getComputedStyle(ts).maxHeight : null,
    appCss: app ? { h: getComputedStyle(app).height, padBottom: getComputedStyle(app).paddingBottom, boxSizing: getComputedStyle(app).boxSizing } : null,
    // 宽度侧：插件内容是否比可见区宽（负 margin 造成横向溢出 / 遮住右侧定位按钮）
    widths: (() => {
      const w = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: +r.left.toFixed(1), right: +r.right.toFixed(1), w: +r.width.toFixed(1) }; };
      const latch = document.querySelector('.fs-row .fs-locate');
      return { ts: w(ts), pv: w(pv), app: w(app), list: w(list), locate: w(latch), winW: window.innerWidth };
    })(),
  };
})())`);
console.log(JSON.stringify(JSON.parse(probe), null, 2));
// 截图：直接看渲染结果（比读数字更可靠）
try {
  const shot = await S("Page.captureScreenshot", { format: "png" }, sessionId);
  const bin64 = shot.result?.data;
  if (bin64) {
    const out = path.join(root, "test", `_shot-fs-bottom-${VW}x${VH}${process.env.SIZED === "1" ? "-sized" : ""}.png`);
    writeFileSync(out, Buffer.from(bin64, "base64"));
    console.log("截图:", out);
  }
} catch (e) { console.log("截图失败:", String(e.message || e)); }
ws.close(); server.close(); chrome.kill(); process.exit(0);
