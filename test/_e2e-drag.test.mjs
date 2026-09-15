/**
 * 端到端验证：「订阅总览」条块在真实 WebView2 中可拖拽排序
 * 用法：node test/_e2e-drag.test.mjs
 * 退出码：0=PASS  1=FAIL  2=环境错误
 *
 * 数据安全：使用 WEBVIEW2_USER_DATA_FOLDER 环境变量将 WebView2 数据目录隔离到
 * test/.e2e-drag-profile/，完全不碰用户真实数据。测试退出后自动清理隔离目录。
 */
import { spawn, execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exe = path.join(root, "src-tauri", "target", "debug", "my-search-desktop.exe");
const ISO_DIR = path.join(root, "test", ".e2e-drag-profile");
const PORT = 9347;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[e2e]", ...a);

const killApp = () => { try { execSync("taskkill /F /IM my-search-desktop.exe /T", { stdio: "ignore" }); } catch {} };
const freePort = (p) => { try { execSync(`powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${p} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`, { stdio: "ignore" }); } catch {} };

// 清理上次遗留的隔离目录
if (fs.existsSync(ISO_DIR)) { fs.rmSync(ISO_DIR, { recursive: true, force: true }); }

killApp();
await sleep(700);
freePort(1420);
freePort(PORT);

const vite = spawn("npm", ["run", "dev"], { cwd: root, shell: true, stdio: ["ignore", "pipe", "pipe"] });
for (let i = 0; i < 60; i++) { try { if ((await fetch("http://localhost:1420/config.html")).ok) break; } catch {} await sleep(400); }
log("vite ready");

const app = spawn(exe, [], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, WEBVIEW2_USER_DATA_FOLDER: ISO_DIR } });
app.stderr.on("data", (d) => process.stdout.write("[app-err] " + d));

const listTargets = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
for (let i = 0; i < 60; i++) { try { await listTargets(); break; } catch { await sleep(400); } }
log("CDP ready");

function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => {
      let id = 0; const pend = new Map();
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && pend.has(m.id)) { const { resolve, reject } = pend.get(m.id); pend.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); }
      };
      const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); });
      resolve({ ws, send });
    };
    ws.onerror = reject;
  });
}

async function waitForConfigTarget() {
  // 先等 about:blank 出现（配置窗口刚创建），再等它导航到 config.html
  for (let i = 0; i < 40; i++) {
    const list = await listTargets();
    const cfg = list.find((x) => x.type === "page" && /config\.html/.test(x.url));
    if (cfg) {
      const { ws, send } = await wsConnect(cfg.webSocketDebuggerUrl);
      const evalJs = async (expression) => {
        const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval error");
        return r.result?.value;
      };
      // 等 config 页面完全就绪
      for (let j = 0; j < 20; j++) {
        try {
          const ok = await evalJs("document.readyState === 'complete' && typeof window.__TAURI_INTERNALS__ === 'object'");
          if (ok === true) return { ws, send, evalJs, target: cfg };
        } catch {}
        await sleep(400);
      }
      try { ws.close(); } catch {}
    }
    await sleep(500);
  }
  throw new Error("config window target not found");
}

// ── 主窗口 ──
let mainT = null;
for (let i = 0; i < 30; i++) {
  const list = await listTargets();
  mainT = list.find((x) => x.type === "page" && /localhost:1420/.test(x.url));
  if (mainT) break;
  await sleep(500);
}
if (!mainT) { log("no main target"); killApp(); vite.kill(); process.exit(2); }
const { send: mainSend } = await wsConnect(mainT.webSocketDebuggerUrl);
await mainSend("Runtime.enable");

// 等 Tauri IPC 就绪
for (let i = 0; i < 20; i++) {
  const p = await mainSend("Runtime.evaluate", { expression: "typeof window.__TAURI_INTERNALS__ === 'object'", returnByValue: true });
  if (p.result?.value === true) break;
  await sleep(500);
}

// 写入测试订阅数据（写入隔离目录，不影响用户真实数据）
await mainSend("Runtime.evaluate", {
  expression: `localStorage.setItem('my-search-desktop:subscribes', JSON.stringify(
    '<tis::https://aaa.example.com/index.ms title="AAA" />\n\n<tis::https://bbb.example.com/index.ms title="BBB" />\n\n<tis::https://ccc.example.com/index.ms title="CCC" />'
  )); 'ok'`,
  returnByValue: true,
});

// 打开设置窗口
await mainSend("Runtime.evaluate", {
  expression: "window.__TAURI_INTERNALS__.invoke('open_config_window').catch(() => {}); 'fired'",
  awaitPromise: false, returnByValue: false,
});
log("open_config_window triggered");

// ── 等设置窗口就绪 ──
let cfg;
try { cfg = await waitForConfigTarget(); } catch (e) { log(e.message); killApp(); vite.kill(); process.exit(2); }
log("config window ready:", cfg.target.url);

// 设置窗口从 localStorage 读取订阅数据，不需要再写入
// 但为了确保读取最新的数据，重载一次
await cfg.send("Page.reload");
await sleep(800);
await cfg.send("Runtime.enable");

// 轮询等待面板就绪（冷启动时 Vite 需按需转换大量模块，固定等待易误判）
let paneReady = false;
for (let i = 0; i < 40; i++) {
  try {
    paneReady = (await cfg.evalJs(`!!document.querySelector('.page.subscribes .sub-item')`)) === true;
  } catch { /* 页面 reload 期间可能短暂不可用 */ }
  if (paneReady) break;
  await sleep(500);
}
log("pane ready:", paneReady);

// ── 快照 ──
const snap = JSON.parse(await cfg.evalJs(`(() => {
  const items = [...document.querySelectorAll('.sub-item')];
  return JSON.stringify({
    pane: !!document.querySelector('.page.subscribes'),
    count: items.length,
    order: items.map(e => e.querySelector('.sub-name')?.textContent),
    draggable: items[0]?.draggable === true,
    hasHandle: !!items[0]?.querySelector('.sub-drag')
  });
})()`));
log("snap:", JSON.stringify(snap));
if (!snap.pane || snap.count < 3 || !snap.draggable || !snap.hasHandle) {
  log("订阅面板未就绪"); killApp(); vite.kill(); process.exit(2);
}

// ── 事件探针 ──
await cfg.evalJs(`(() => {
  window.__dnd = { events: [] };
  for (const t of ['dragstart','dragenter','dragover','drop','dragend','dragleave'])
    document.addEventListener(t, (e) => {
      const it = e.target.closest?.('.sub-item');
      window.__dnd.events.push(t + ':' + (it ? it.dataset.index : 'other'));
    }, true);
  return 'ok';
})()`);

// ── 真实鼠标拖拽 ──
const box = JSON.parse(await cfg.evalJs(`(() => {
  const h = document.querySelector('.sub-item[data-index="0"] .sub-drag');
  const d = document.querySelector('.sub-item[data-index="2"]');
  const hr = h.getBoundingClientRect(), dr = d.getBoundingClientRect();
  return JSON.stringify({ hx: hr.x + hr.width/2, hy: hr.y + hr.height/2, dx: dr.x + dr.width/2, dy: dr.y + dr.height/2 });
})()`));
log(`drag ${box.hx.toFixed(0)},${box.hy.toFixed(0)} → ${box.dx.toFixed(0)},${box.dy.toFixed(0)}`);

await cfg.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.hx, y: box.hy, button: "left", buttons: 1, clickCount: 1 });
await sleep(80);
for (let i = 1; i <= 15; i++) {
  await cfg.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.hx + (box.dx - box.hx) * i / 15, y: box.hy + (box.dy - box.hy) * i / 15, button: "left", buttons: 1 });
  await sleep(45);
}
await cfg.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.dx, y: box.dy, button: "left", buttons: 1 });
await sleep(250);
await cfg.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.dx, y: box.dy, button: "left", buttons: 0, clickCount: 1 });
await sleep(600);

const after = JSON.parse(await cfg.evalJs(`(() => {
  const items = [...document.querySelectorAll('.sub-item')];
  return JSON.stringify({ events: window.__dnd.events, order: items.map(e => e.querySelector('.sub-name')?.textContent) });
})()`));
log("events:", after.events.join(" | ") || "(none)");
log("order:", after.order.join(","));

const started = after.events.some((e) => e.startsWith("dragstart"));
const dropped = after.events.some((e) => e.startsWith("drop"));
const reordered = after.order.join(",") !== "AAA,BBB,CCC";
const pass = started && reordered;

console.log("\n  dragstart:", started, "| drop:", dropped, "| reorder:", reordered);
console.log("  VERDICT:", pass ? "PASS" : "FAIL");
console.log("");

try { cfg.ws.close(); } catch {}
killApp();
try { vite.kill(); } catch {}
await sleep(800);
// 清理隔离数据目录（WebView2 进程退出后才能删）
try { fs.rmSync(ISO_DIR, { recursive: true, force: true }); } catch {}
process.exit(pass ? 0 : 1);