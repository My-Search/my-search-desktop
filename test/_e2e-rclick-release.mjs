/**
 * 生产构建 · 用户复现路径端到端验证：
 *   呼出搜索框 → 右击叶子（真实 contextmenu 事件）→ 设置窗口打开并渲染
 *   → 切换各面板 → Esc 关闭 → 主窗口再次呼出仍正常
 * 用法：node test/_e2e-rclick-release.mjs
 */
import { spawn, execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exe = path.join(root, "src-tauri", "target", "release", "my-search-desktop.exe");
const ISO_DIR = path.join(root, "test", ".e2e-rclick-profile");
const PORT = 9354;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[rclick]", ...a);

const killApp = () => { try { execSync("taskkill /F /IM my-search-desktop.exe /T", { stdio: "ignore" }); } catch {} };
const freePort = (p) => { try { execSync(`powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${p} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`, { stdio: "ignore" }); } catch {} };

if (!fs.existsSync(exe)) { console.error("缺少 release 构建"); process.exit(2); }
if (fs.existsSync(ISO_DIR)) { fs.rmSync(ISO_DIR, { recursive: true, force: true }); }
killApp();
await sleep(700);
freePort(PORT);

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
      const events = [];
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && pend.has(m.id)) { const { resolve, reject } = pend.get(m.id); pend.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); }
        else if (m.method) events.push(m);
      };
      const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); });
      resolve({ ws, send, events });
    };
    ws.onerror = reject;
  });
}

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => { if (cond) { pass++; log("PASS", name, extra); } else { fail++; log("FAIL", name, extra); } };

let mainT = null;
for (let i = 0; i < 60; i++) {
  const list = await listTargets();
  mainT = list.find((x) => x.type === "page" && /tauri\.localhost/.test(x.url));
  if (mainT) break;
  await sleep(500);
}
if (!mainT) { log("no main target"); killApp(); process.exit(2); }
log("main:", mainT.url);
const main = await wsConnect(mainT.webSocketDebuggerUrl);
await main.send("Runtime.enable");
const mainEval = async (expr) => {
  const r = await main.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval error");
  return r.result?.value;
};

for (let i = 0; i < 40; i++) { if (await mainEval(`!!document.getElementById('my_search_box')`)) break; await sleep(500); }

// 1. 呼出搜索框（Ctrl+Alt+S）
try { execSync(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^%s')"`, { stdio: "ignore", timeout: 15000 }); } catch {}
await sleep(1500);
check("呼出搜索框", (await mainEval(`document.visibilityState === 'visible' && document.getElementById('my_search_box')?.offsetHeight >= 48`)) === true);

// 2. 真实右击叶子（contextmenu 事件 → 前端 @contextmenu → openConfigWindow → invoke）
await mainEval(`(() => {
  const btn = document.getElementById('logoButton');
  const r = btn.getBoundingClientRect();
  btn.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: r.x + r.width/2, clientY: r.y + r.height/2, button: 2,
  }));
  return 'contextmenu dispatched';
})()`);
log("contextmenu dispatched on leaf");

// 3. 等设置窗口出现并渲染
let cfgTarget = null;
for (let i = 0; i < 40; i++) {
  const list = await listTargets();
  cfgTarget = list.find((x) => x.type === "page" && /config\.html/.test(x.url));
  if (cfgTarget) break;
  await sleep(500);
}
check("右击叶子打开设置窗口（config.html 已加载）", !!cfgTarget, cfgTarget?.url ?? "not found");
if (!cfgTarget) { killApp(); process.exit(1); }

const cfg = await wsConnect(cfgTarget.webSocketDebuggerUrl);
await cfg.send("Runtime.enable");
const cfgEval = async (expr) => {
  const r = await cfg.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval error");
  return r.result?.value;
};

let ok = false;
for (let i = 0; i < 40; i++) {
  try { ok = (await cfgEval(`document.querySelectorAll('.nav-item').length >= 6 && !!document.querySelector('.page.subscribes')`)) === true; } catch {}
  if (ok) break;
  await sleep(500);
}
check("设置页面渲染（非空白）", ok);

// 4. 切换面板（关注标签 / 数据缓存 / 快捷键 / 关于）验证无卡死
const results = {};
for (const pane of ["tags", "cache", "shortcut", "about", "repo"]) {
  await cfgEval(`document.querySelector('.cfg-nav .nav-item[data-pane="${pane}"]').click(); 'clicked'`);
  await sleep(400);
  results[pane] = await cfgEval(`!!document.querySelector('#ms-config-view .page.${pane === "repo" ? "repo" : pane}')`);
}
check("各面板可切换渲染", Object.values(results).every(Boolean), JSON.stringify(results));

// 5. Esc 关闭设置窗口
await cfg.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
await cfg.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
await sleep(1500);
let closed = false;
for (let i = 0; i < 10; i++) {
  const list = await listTargets();
  closed = !list.some((x) => x.type === "page" && /config\.html/.test(x.url));
  if (closed) break;
  await sleep(400);
}
check("Esc 关闭设置窗口", closed);

// 6. 主窗口再次呼出仍正常（事件循环未死）
try { execSync(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^%s')"`, { stdio: "ignore", timeout: 15000 }); } catch {}
await sleep(1200);
try { execSync(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^%s')"`, { stdio: "ignore", timeout: 15000 }); } catch {}
await sleep(1200);
check("关闭设置后主窗口仍可呼出/交互", (await mainEval(`document.getElementById('my_search_box') !== null && document.querySelectorAll('.nav-item').length === 0`)) === true);

check("无未捕获异常", main.events.filter(e => e.method === "Runtime.exceptionThrown").length === 0);

console.log(`\n结果: ${pass} passed, ${fail} failed\n`);

try { cfg.ws.close(); } catch {}
try { main.ws.close(); } catch {}
killApp();
await sleep(800);
try { fs.rmSync(ISO_DIR, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);
