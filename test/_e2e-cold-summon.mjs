/**
 * 冷启动「立即呼出」验证（release 构建）：
 *   进程启动后 800ms（WebView 尚未加载完）就发送 Ctrl+Alt+S，
 *   检查呼出后窗口内容是否正常（搜索框可见、输入框存在），
 *   并连续截图观察是否有持续空白。
 * 用法：node test/_e2e-cold-summon.mjs
 */
import { spawn, execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exe = path.join(root, "src-tauri", "target", "release", "my-search-desktop.exe");
const ISO_DIR = path.join(root, "test", ".e2e-cold-profile");
const PORT = 9355;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[cold]", ...a);

const killApp = () => { try { execSync("taskkill /F /IM my-search-desktop.exe /T", { stdio: "ignore" }); } catch {} };
const freePort = (p) => { try { execSync(`powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${p} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`, { stdio: "ignore" }); } catch {} };

if (!fs.existsSync(exe)) { console.error("缺少 release 构建"); process.exit(2); }
if (fs.existsSync(ISO_DIR)) { fs.rmSync(ISO_DIR, { recursive: true, force: true }); }
killApp();
await sleep(700);
freePort(PORT);

const app = spawn(exe, [], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, WEBVIEW2_USER_DATA_FOLDER: ISO_DIR } });
app.stderr.on("data", (d) => process.stdout.write("[app-err] " + d));

// 800ms 后立即呼出（此时 WebView 很可能还在加载）
await sleep(800);
log("sending Ctrl+Alt+S at t+800ms (cold)...");
try { execSync(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^%s')"`, { stdio: "ignore", timeout: 15000 }); } catch (e) { log("SendKeys failed:", String(e)); }

await sleep(700);
log("sending Ctrl+Alt+S again at t+1500ms (toggle test)...");
try { execSync(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^%s')"`, { stdio: "ignore", timeout: 15000 }); } catch (e) { log("SendKeys failed:", String(e)); }

await sleep(700);
log("sending Ctrl+Alt+S again at t+2200ms (summon again)...");
try { execSync(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^%s')"`, { stdio: "ignore", timeout: 15000 }); } catch (e) { log("SendKeys failed:", String(e)); }

// 连接 CDP 检查
const listTargets = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
let mainT = null;
for (let i = 0; i < 40; i++) {
  try {
    const list = await listTargets();
    mainT = list.find((x) => x.type === "page" && /tauri\.localhost/.test(x.url));
    if (mainT) break;
  } catch {}
  await sleep(400);
}
if (!mainT) { log("no main target"); killApp(); process.exit(2); }
log("main:", mainT.url);

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
const main = await wsConnect(mainT.webSocketDebuggerUrl);
await main.send("Runtime.enable");
const evalJs = async (expr) => {
  const r = await main.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval error");
  return r.result?.value;
};

// 等挂载（最多 15s）
let m = null;
for (let i = 0; i < 30; i++) {
  try {
    m = JSON.parse(await evalJs(`(() => {
      const box = document.getElementById('my_search_box');
      const input = document.getElementById('my_search_input');
      return JSON.stringify({
        hasBox: !!box, w: box?.offsetWidth ?? 0, h: box?.offsetHeight ?? 0,
        placeholder: input?.placeholder ?? '', bodyLen: document.body.innerHTML.length,
      });
    })()`));
    if (m.hasBox && m.w > 0) break;
  } catch {}
  await sleep(500);
}
log("final state:", JSON.stringify(m));

// 截图
try {
  const r = await main.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(root, "test", "_cold-shot.png"), Buffer.from(r.data, "base64"));
  log("screenshot: _cold-shot.png");
} catch (e) { log("screenshot failed:", String(e)); }

// 尝试输入搜索，检查结果
await evalJs(`(() => {
  const input = document.getElementById('my_search_input');
  input.focus(); input.value = '系统';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return 'typed';
})()`).catch(() => {});
await sleep(2000);
const results = await evalJs(`document.querySelectorAll('#matchItems .resultItem').length`).catch(() => -1);
log("search results:", results);

try {
  const r = await main.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(root, "test", "_cold-shot-2.png"), Buffer.from(r.data, "base64"));
} catch {}

try { main.ws.close(); } catch {}
killApp();
await sleep(800);
try { fs.rmSync(ISO_DIR, { recursive: true, force: true }); } catch {}
process.exit(0);
