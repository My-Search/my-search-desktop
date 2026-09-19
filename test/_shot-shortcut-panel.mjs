/**
 * 截图：设置 → 快捷键面板（新 UI：快捷键 / 作用类型 / 作用对象）。
 * 用法：npm run build && node test/_shot-shortcut-panel.mjs
 */
import { createServer } from "http";
import { readFile, rm, writeFile } from "fs/promises";
import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
if (!existsSync(path.join(dist, "config.html"))) {
  console.error("请先 npm run build");
  process.exit(1);
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const server = createServer(async (req, res) => {
  try {
    const u = decodeURIComponent(req.url.split("?")[0]);
    const file = path.join(dist, u === "/" ? "/config.html" : u);
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

const userDir = path.join(root, "test", "_chrome-profile-shot-shortcut");
await rm(userDir, { recursive: true, force: true });
const chrome = spawn(
  bin,
  ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
   "--remote-debugging-port=0", `--user-data-dir=${userDir}`, "--window-size=900,880", "about:blank"],
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
  new Promise((resolve) => { const mid = ++id; pending.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params, sessionId })); });

const { result: targets } = await S("Target.getTargets");
const pageTarget = targets.targetInfos.find((t) => t.type === "page");
const { result: { sessionId } } = await S("Target.attachToTarget", { targetId: pageTarget.targetId, flatten: true });
await S("Runtime.enable", {}, sessionId);
await S("Page.enable", {}, sessionId);
const evalJs = async (expr) => {
  const r = await S("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await S("Page.addScriptToEvaluateOnNewDocument", {
  source: `
    window.__TAURI_INTERNALS__ = {
      invoke(cmd, args) {
        if (cmd === 'get_shortcut_bindings') return Promise.resolve([
          { shortcut: 'ctrl+alt+s', action: 'toggle-window', target: null },
          { shortcut: 'ctrl+alt+1', action: 'open-plugin', target: 'com.mysearch.baidu-translate' },
          { shortcut: 'ctrl+alt+2', action: 'open-plugin', target: 'com.example.ai-ask-long-name' },
        ]);
        if (cmd === 'get_default_subscribe_text') return Promise.resolve('');
        return Promise.resolve(null);
      },
      transformCallback(cb) { return cb; },
      metadata: { currentWindow: { label: 'config' }, currentWebview: { label: 'config' } },
      plugins: {},
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(){} };
  `,
}, sessionId);

await S("Page.navigate", { url: base + "/config.html" }, sessionId);
await sleep(600);
await evalJs(`localStorage.clear(); localStorage.setItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY', JSON.stringify({
  version: 1,
  plugins: [
    { id: 'com.mysearch.baidu-translate', name: '百度翻译', version: '1.0.0', apiVersion: 1,
      manifest: { id: 'com.mysearch.baidu-translate', name: '百度翻译', version: '1.0.0', apiVersion: 1,
        contributes: { detailView: { entry: 'ui/detail.html' } } },
      dir: '', source: { kind: 'market' }, installedAt: 0, updatedAt: 0, enabled: true,
      autoStart: 'on-demand', requestedAutoStart: 'on-demand', grants: [], denied: [],
      runtime: { status: 'stopped', pid: null, memoryBytes: null, startedAt: null, restarts: 0, lastError: null, keepAliveReasons: [] },
      integrity: { sha256: null, signed: false } },
    { id: 'com.example.ai-ask-long-name', name: 'AI 问答助手（实验版）', version: '2.1.0', apiVersion: 1,
      manifest: { id: 'com.example.ai-ask-long-name', name: 'AI 问答助手（实验版）', version: '2.1.0', apiVersion: 1,
        contributes: { detailView: { entry: 'ui/index.html' } } },
      dir: '', source: { kind: 'market' }, installedAt: 0, updatedAt: 0, enabled: false,
      autoStart: 'on-demand', requestedAutoStart: 'on-demand', grants: [], denied: [],
      runtime: { status: 'stopped', pid: null, memoryBytes: null, startedAt: null, restarts: 0, lastError: null, keepAliveReasons: [] },
      integrity: { sha256: null, signed: false } }
  ]
})); 1`);
await S("Page.navigate", { url: base + "/config.html" }, sessionId);
await sleep(1400);
await evalJs(`document.querySelector('.cfg-nav .nav-item[data-pane="shortcut"]').click()`);
await sleep(700);

const shot = await S("Page.captureScreenshot", { format: "png" }, sessionId);
await writeFile(path.join(root, "test", "_shot-shortcut-panel.png"), Buffer.from(shot.result.data, "base64"));
console.log("screenshot: test/_shot-shortcut-panel.png");

ws.close();
chrome.kill();
server.close();
process.exit(0);
