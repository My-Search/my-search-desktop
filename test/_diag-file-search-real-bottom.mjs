/**
 * 真机诊断：「文件搜索」结果列表滚到底，最后一行是否被裁。
 *
 * 之前的合成夹具（Emulation.setDeviceMetricsOverride）里量不出问题，因为那只改
 * 视口、不动真实 OS 窗口。这里用**真 app（debug exe）+ vite）**：
 *   1. 真目录树（几百个文件）走真实附件/列举链路；
 *   2. 用 CDP Browser.setWindowBounds 把**真实窗口**改矮改宽；
 *   3. 分别量常态与拉伸态下：谁是滚动容器、滚到底后最后一行底边相对容器/视口的
 *      位置（>0 = 被裁掉看不到）。
 *
 * 用法：先 npm run dev，另开一个终端 cargo build，
 *      node test/_diag-file-search-real-bottom.mjs
 */
import { spawn, execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exe = path.join(root, "src-tauri", "target", "debug", "my-search-desktop.exe");
const ISO_DIR = path.join(root, "test", ".e2e-fs-bottom-profile");
const PORT = 9371;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killApp = () => { try { execSync("taskkill /F /IM my-search-desktop.exe /T", { stdio: "ignore" }); } catch {} };

if (!fs.existsSync(exe)) { console.error("缺少 debug 构建"); process.exit(2); }
// 真目录树：足够多的文件让列表必须内部滚动
const tree = fs.mkdtempSync(path.join(os.tmpdir(), "ms-fs-bottom-"));
for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(tree, `video-${String(i).padStart(3, "0")}.mp4`), "x");
console.log("树:", tree);
const cleanup = () => { try { fs.rmSync(tree, { recursive: true, force: true }); } catch {} killApp(); };

if (fs.existsSync(ISO_DIR)) fs.rmSync(ISO_DIR, { recursive: true, force: true });
killApp();
await sleep(800);
const app = spawn(exe, [], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, WEBVIEW2_USER_DATA_FOLDER: ISO_DIR } });
app.stderr.on("data", (d) => process.stdout.write("[app-err] " + d));

let targets = [];
for (let i = 0; i < 80; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (targets.some((t) => /^https?:/.test(t.url || ""))) break; } catch {}
  await sleep(400);
}
const page = targets.find((t) => t.type === "page" && /^https?:/.test(t.url || ""));
if (!page) { console.error("无页面"); cleanup(); process.exit(2); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const S = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await S("Runtime.enable");
const evalJs = async (expr) => {
  const r = await S("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "eval error");
  return r.result?.result?.value;
};
for (let i = 0; i < 60; i++) { if (await evalJs(`!!window.__TAURI_INTERNALS__.invoke`).catch(() => false)) break; await sleep(500); }

// 1) 通过插件真实运行时打开视图（走搜索框流程）
const PLUGIN = "com.mysearch.file-search";
const openPlugin = async () => {
  await evalJs(`(() => {
    const el = document.getElementById('my_search_input');
    if (!el) return 'no-input';
    el.focus(); el.value = '文件搜索';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(800);
  await evalJs(`(() => { const el = document.getElementById('my_search_input'); el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })(); 1`);
  await sleep(1500);
  // 关掉（exit）后贴附件，再打开
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); 1`);
  await sleep(600);
  await evalJs(`(() => {
    const input = document.getElementById('my_search_input');
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'p', { type: 'application/octet-stream' }));
    input.focus();
    input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
    return 1;
  })()`);
  await sleep(600);
  // 真实附件来自剪贴板——模拟环境没有；直接用命令登记 + 让插件重扫
  await evalJs(`window.__TAURI_INTERNALS__.invoke('plugin_gateway_sync', { spec: { pluginId: ${JSON.stringify(PLUGIN)}, enabled: true, autoStart: 'on-demand', grants: ['ui.inlay','file.read'] } })`);
  await evalJs(`window.__TAURI_INTERNALS__.invoke('attachments_sync', { roots: [{ path: ${JSON.stringify(tree.replace(/\\/g, "/"))}, isDir: true }] })`);
  await evalJs(`(() => { const el = document.getElementById('my_search_input'); el.focus(); el.value = '文件搜索 : '; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return 1; })()`);
  await sleep(2500);
};
await openPlugin();

const probe0 = () => evalJs(`JSON.stringify((() => {
  const q = (s) => document.querySelector(s);
  const rows = Array.from(document.querySelectorAll('.fs-row'));
  const box = q('#my_search_box');
  return {
    hasInput: !!q('#my_search_input'),
    hasPluginView: !!q('#text_show .plugin-view'),
    hasSession: !!q('#text_show .plugin-view > .ms-plugin-session'),
    hasList: !!q('#text_show .plugin-view .fs-list'),
    rows: rows.length,
    sized: box ? box.classList.contains('plugin-sized') : null,
    winH: window.innerHeight, winW: window.innerWidth,
    tsDisplay: q('#text_show') ? getComputedStyle(q('#text_show')).display : null,
    status: (q('#fs-status') || {}).textContent || '',
    meta: (q('#fs-meta') || {}).textContent || '',
  };
})())`);

// 先量一次（未改窗口）：确认插件视图真的开着、有结果行
console.log("\n=== 改窗口前（基线）===");
console.log(JSON.stringify(JSON.parse(await probe0()), null, 2));

// 2) 把真实窗口改矮改宽（用户截图那种「宽而矮」）
async function setWin(w, h) {
  const { result: win } = await S("Browser.getWindowForTarget");
  if (win && win.windowId) await S("Browser.setWindowBounds", { windowId: win.windowId, bounds: { width: w, height: h, windowState: "normal" } });
  await sleep(900);
}

const probe = () => evalJs(`JSON.stringify((() => {
  const q = (s) => document.querySelector(s);
  const list = q('#text_show .plugin-view .fs-list');
  const ts = q('#text_show');
  const box = q('#my_search_box');
  const rows = Array.from(document.querySelectorAll('.fs-row'));
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { top: +b.top.toFixed(1), bottom: +b.bottom.toFixed(1), h: +b.height.toFixed(1) }; };
  // 滚到底
  [ts, list].forEach((el) => { if (el && el.scrollHeight > el.clientHeight) el.scrollTop = el.scrollHeight; });
  const last = rows[rows.length - 1];
  const lb = r(last), listB = r(list), tsB = r(ts);
  const vh = window.innerHeight;
  return {
    sized: box ? box.classList.contains('plugin-sized') : null,
    rows: rows.length, winH: vh,
    listBox: listB, tsBox: tsB, lastRow: lb,
    lastBelowListBottom: lb && listB ? +(lb.bottom - listB.bottom).toFixed(1) : null,
    lastBelowViewport: lb ? +(lb.bottom - vh).toFixed(1) : null,
    listScroll: list ? { sh: list.scrollHeight, ch: list.clientHeight, top: list.scrollTop, max: list.scrollHeight - list.clientHeight } : null,
    tsScroll: ts ? { sh: ts.scrollHeight, ch: ts.clientHeight, top: ts.scrollTop, ovY: getComputedStyle(ts).overflowY } : null,
    appH: (q('#text_show .plugin-view .fs-app') || {}).getBoundingClientRect ? +q('#text_show .plugin-view .fs-app').getBoundingClientRect().height.toFixed(1) : null,
    varH: box ? getComputedStyle(box).getPropertyValue('--plugin-view-height') : null,
  };
})())`);

for (const [w, h] of [[1200, 200], [1300, 170], [900, 300]]) {
  await setWin(w, h);
  console.log(`\n=== 窗口 ${w}x${h} ===`);
  console.log(JSON.stringify(JSON.parse(await probe()), null, 2));
}

ws.close();
cleanup();
process.exit(0);
