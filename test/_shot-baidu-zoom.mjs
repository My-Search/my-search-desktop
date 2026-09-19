/**
 * 放大截图：只看百度翻译条目的图标 + 左下角角标（便于肉眼复核）。
 * 用法: node test/_shot-baidu-zoom.mjs  (需先 npm run build)
 */
import { createServer } from "http";
import { readFile, rm, writeFile } from "fs/promises";
import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
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

const bin = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].find((p) => existsSync(p));
const userDir = path.join(root, "test", "_chrome-profile-shot-zoom");
await rm(userDir, { recursive: true, force: true });
const chrome = spawn(
  bin,
  ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=0",
   `--user-data-dir=${userDir}`, "--window-size=900,700", "about:blank"],
  { stdio: ["ignore", "ignore", "pipe"] }
);
const wsUrl = await new Promise((resolve, reject) => {
  let buf = "";
  const t = setTimeout(() => reject(new Error("浏览器启动超时")), 20000);
  chrome.stderr.on("data", (d) => {
    buf += d.toString();
    const m = buf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (m) { clearTimeout(t); resolve(m[1]); }
  });
});
const ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
const S = (method, params = {}, sessionId) =>
  new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
  });
const { result: targets } = await S("Target.getTargets");
const pageTarget = targets.targetInfos.find((t) => t.type === "page");
const { result: { sessionId } } = await S("Target.attachToTarget", { targetId: pageTarget.targetId, flatten: true });
await S("Runtime.enable", {}, sessionId);
await S("Page.enable", {}, sessionId);
const evalJs = async (expr) => {
  const r = await S("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pkgBase64 = readFileSync(path.join(root, "plugins", "baidu-translate.zip")).toString("base64");
await S("Page.addScriptToEvaluateOnNewDocument", {
  source: `
    window.__pkg = ${JSON.stringify(pkgBase64)};
    window.__TAURI_INTERNALS__ = {
      invoke(cmd, args) {
        if (cmd === 'plugin:dialog|open') return Promise.resolve('C:\\\\fake\\\\baidu.zip');
        if (cmd === 'plugin_read_local_base64') return Promise.resolve(window.__pkg);
        if (cmd === 'plugin_install') {
          const fs = JSON.parse(localStorage.getItem('__mock_fs') || '{}');
          for (const f of (args.files || [])) fs[args.pluginId + '/' + f.path] = f.data;
          localStorage.setItem('__mock_fs', JSON.stringify(fs));
          return Promise.resolve('plugins/' + args.pluginId);
        }
        if (cmd === 'plugin_read_text') {
          const fs = JSON.parse(localStorage.getItem('__mock_fs') || '{}');
          const b64 = fs[args.pluginId + '/' + args.relPath];
          if (b64 == null) return Promise.reject('文件不存在');
          const bin = atob(b64); const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return Promise.resolve(new TextDecoder('utf-8').decode(bytes));
        }
        if (cmd === 'plugin_list_files') {
          const fs = JSON.parse(localStorage.getItem('__mock_fs') || '{}');
          const pre = args.pluginId + '/';
          return Promise.resolve(Object.keys(fs).filter(k => k.startsWith(pre)).map(k => ({ path: k.slice(pre.length), size: 0 })));
        }
        if (cmd === 'plugin_gateway_sync') return Promise.resolve(null);
        if (cmd === 'plugin_backend_list') return Promise.resolve([]);
        if (cmd === 'get_default_subscribe_text') return Promise.resolve('');
        if (cmd === 'get_toggle_shortcut') return Promise.resolve('ctrl+alt+s');
        if (cmd === 'get_autostart_enabled') return Promise.resolve(false);
        return Promise.resolve(null);
      },
      transformCallback(cb) { const i = Math.random().toString(36).slice(2); (window.__cbIds = window.__cbIds || {})[i] = cb; return i; },
      unregisterCallback(i) { delete (window.__cbIds || {})[i]; },
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      plugins: {},
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(){} };
  `,
}, sessionId);

// 配置窗口装包
await S("Page.navigate", { url: base + "/config.html" }, sessionId);
await sleep(700);
await evalJs(`localStorage.clear(); 1`);
await S("Page.navigate", { url: base + "/config.html" }, sessionId);
await sleep(1500);
await evalJs(`document.querySelector('.cfg-nav .nav-item[data-pane="plugins"]').click()`);
await sleep(600);
await evalJs(`[...document.querySelectorAll('.page.plugins button')].find(b => b.textContent.includes('从文件安装')).click()`);
await sleep(800);
await evalJs(`document.querySelector('#msgOk').click()`);
await sleep(1000);

// 搜索窗口出结果
await S("Page.navigate", { url: base + "/index.html" }, sessionId);
await sleep(1600);
await evalJs(`(() => {
  const el = document.getElementById('my_search_input');
  el.focus(); el.value = '翻译';
  el.dispatchEvent(new Event('input', { bubbles: true }));
})(); 1`);
await sleep(1200);

// 只截图标那一小块，放大 8 倍
const clip = JSON.parse(await evalJs(`JSON.stringify((() => {
  const li = [...document.querySelectorAll('#matchItems .resultItem')]
    .find(el => (el.textContent || '').includes('百度翻译'));
  if (!li) return null;
  const ic = li.querySelector('.item-icon').getBoundingClientRect();
  const pad = 4;
  return { x: ic.x - pad, y: ic.y - pad, width: ic.width + pad * 2, height: ic.height + pad * 2, scale: 8 };
})())`));
if (!clip) { console.log("未找到条目"); process.exit(1); }
const shot = await S("Page.captureScreenshot", { format: "png", clip }, sessionId);
const out = path.join(root, "test", "_shot-baidu-icon-zoom.png");
await writeFile(out, Buffer.from(shot.result.data, "base64"));
console.log("已保存:", out, `${clip.width}×${clip.height} @${clip.scale}x`);

ws.close();
chrome.kill();
server.close();
process.exit(0);
