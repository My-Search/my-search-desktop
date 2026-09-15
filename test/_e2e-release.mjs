/**
 * 生产构建端到端验证（release exe，内嵌 dist 资源，无需 vite）：
 * 1. 冷启动 → 主窗口首次呼出（模拟 Ctrl+Alt+S）→ 截图 + DOM 断言
 * 2. 右击叶子路径 → 打开设置窗口 → 等 config.html 导航 + 面板渲染 → 截图 + DOM 断言
 * 3. 设置窗口 Esc 关窗 → 确认窗口关闭
 * 用法：node test/_e2e-release.mjs
 */
import { spawn, execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exe = path.join(root, "src-tauri", "target", "release", "my-search-desktop.exe");
const ISO_DIR = path.join(root, "test", ".e2e-release-profile");
const PORT = 9353;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[rel]", ...a);

const killApp = () => { try { execSync("taskkill /F /IM my-search-desktop.exe /T", { stdio: "ignore" }); } catch {} };
const freePort = (p) => { try { execSync(`powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${p} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`, { stdio: "ignore" }); } catch {} };

if (!fs.existsSync(exe)) { console.error("缺少 release 构建，请先 cargo build --release"); process.exit(2); }
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

// ── 主窗口：等 target 导航到内嵌页面（生产构建是 tauri.localhost） ──
let mainT = null;
for (let i = 0; i < 60; i++) {
  const list = await listTargets();
  mainT = list.find((x) => x.type === "page" && /tauri\.localhost|localhost:1420|index\.html/.test(x.url) && !/config/.test(x.url));
  if (!mainT) mainT = list.find((x) => x.type === "page" && x.url !== "about:blank");
  if (mainT) break;
  await sleep(500);
}
if (!mainT) {
  const list = await listTargets();
  log("no main target; targets:", JSON.stringify(list.map(t => t.url)));
  killApp();
  process.exit(2);
}
log("main target:", mainT.url);
const main = await wsConnect(mainT.webSocketDebuggerUrl);
await main.send("Runtime.enable");
await main.send("Page.enable");

const mainEval = async (expr) => {
  const r = await main.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval error");
  return r.result?.value;
};

let mounted = false;
for (let i = 0; i < 40; i++) {
  try { mounted = (await mainEval(`!!document.getElementById('my_search_box')`)) === true; } catch {}
  if (mounted) break;
  await sleep(500);
}
check("主窗口 Vue 挂载", mounted);

// 等订阅数据加载完（placeholder 不再是"数据准备更新中"或进度）
for (let i = 0; i < 60; i++) {
  const ph = await mainEval(`document.getElementById('my_search_input')?.placeholder ?? ''`);
  if (!/更新|准备/.test(ph)) break;
  await sleep(500);
}
const phAfterLoad = await mainEval(`document.getElementById('my_search_input')?.placeholder ?? ''`);
log("placeholder after load:", phAfterLoad);

// ── 首次呼出（Ctrl+Alt+S） ──
try {
  execSync(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^%s')"`, { stdio: "ignore", timeout: 15000 });
} catch (e) { log("SendKeys failed:", String(e)); }
await sleep(1500);

const shownState = JSON.parse(await mainEval(`(() => {
  const box = document.getElementById('my_search_box');
  const vis = document.visibilityState;
  return JSON.stringify({
    vis,
    boxW: box?.offsetWidth ?? 0,
    boxH: box?.offsetHeight ?? 0,
    hasInput: !!document.getElementById('my_search_input'),
    logo: !!document.querySelector('#logoButton img'),
  });
})()`));
log("after summon:", JSON.stringify(shownState));
check("首次呼出：搜索框可见且有尺寸", shownState.boxW > 200 && shownState.boxH >= 48, `w=${shownState.boxW} h=${shownState.boxH}`);
check("首次呼出：输入框与 logo 已渲染", shownState.hasInput && shownState.logo);

try {
  const r = await main.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(root, "test", "_rel-shot-1-main.png"), Buffer.from(r.data, "base64"));
  log("screenshot: _rel-shot-1-main.png");
} catch (e) { log("screenshot failed:", String(e)); }

// 输入搜索验证（写入值并派发 input 事件，触发 Vue v-model；insertText 不会触发 input 事件）
await mainEval(`(() => {
  const input = document.getElementById('my_search_input');
  input.focus();
  input.value = '系统';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return 'typed';
})()`);
await sleep(1500);
const resultsCount = await mainEval(`document.querySelectorAll('#matchItems .resultItem').length`);
check("输入「系统」后有搜索结果", resultsCount > 0, `results=${resultsCount}`);
try {
  const r = await main.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(root, "test", "_rel-shot-2-results.png"), Buffer.from(r.data, "base64"));
} catch (e) { /* ignore */ }

// ── 打开设置窗口（真实调用 open_config_window，等效右击叶子） ──
await mainEval(`window.__TAURI_INTERNALS__.invoke('open_config_window').catch(() => {}); 'fired'`);
log("open_config_window invoked");

// 等 config target
let cfgTarget = null;
for (let i = 0; i < 40; i++) {
  const list = await listTargets();
  cfgTarget = list.find((x) => x.type === "page" && /config/.test(x.url) && x.id !== mainT.id);
  if (cfgTarget) break;
  await sleep(500);
}
check("设置窗口 target 出现并导航到 config.html", !!cfgTarget, cfgTarget?.url ?? "not found");
if (!cfgTarget) { killApp(); process.exit(1); }

const cfg = await wsConnect(cfgTarget.webSocketDebuggerUrl);
await cfg.send("Runtime.enable");
await cfg.send("Page.enable");
const cfgEval = async (expr) => {
  const r = await cfg.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval error");
  return r.result?.value;
};

// 等 Vue 挂载 + 面板渲染
let cfgState = null;
for (let i = 0; i < 40; i++) {
  try {
    cfgState = JSON.parse(await cfgEval(`(() => {
      const nav = document.querySelectorAll('.nav-item').length;
      const items = document.querySelectorAll('.sub-item').length;
      const pane = !!document.querySelector('.page.subscribes');
      return JSON.stringify({ nav, items, pane, url: location.href, ready: document.readyState });
    })()`));
    if (cfgState.nav >= 6 && cfgState.pane) break;
  } catch { /* reloading */ }
  await sleep(500);
}
log("config state:", JSON.stringify(cfgState));
check("设置窗口 Vue 挂载（6 个导航项）", (cfgState?.nav ?? 0) >= 6, `nav=${cfgState?.nav}`);
check("设置窗口订阅面板渲染", cfgState?.pane === true);

// 等订阅数据初始化（首次运行写默认订阅）
await sleep(1500);
const subCount = await cfgEval(`document.querySelectorAll('.sub-item').length`);
log("subscribe items:", subCount);

// 截图
try {
  const r = await cfg.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(root, "test", "_rel-shot-3-config.png"), Buffer.from(r.data, "base64"));
  log("screenshot: _rel-shot-3-config.png");
} catch (e) { /* ignore */ }

// ── Esc 关窗 ──
await cfg.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
await cfg.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
await sleep(1500);
const stillThere = (await listTargets()).some((x) => x.type === "page" && /config/.test(x.url));
check("Esc 可关闭设置窗口", !stillThere, stillThere ? "窗口仍在" : "已关闭");

check("无未捕获异常", main.events.filter(e => e.method === "Runtime.exceptionThrown").length === 0 && cfg.events.filter(e => e.method === "Runtime.exceptionThrown").length === 0);

console.log(`\n结果: ${pass} passed, ${fail} failed\n`);

try { cfg.ws.close(); } catch {}
try { main.ws.close(); } catch {}
killApp();
await sleep(800);
try { fs.rmSync(ISO_DIR, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);
