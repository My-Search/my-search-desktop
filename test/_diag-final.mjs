/**
 * 骨架屏「用户可见时长」终测（dev / release 通用）。
 *
 * 场景：应用启动（窗口隐藏）→ 用户按 Ctrl+Alt+S 呼出。
 * 采集：
 *   1. 窗口代理（PowerShell）：真实窗口 hidden/visible + 矩形 + PrintWindow 截图
 *   2. CDP 页内探针（addScriptToEvaluateOnNewDocument，文档最早执行）：
 *      HTML 解析起点 / FCP / Vue 挂载 / 骨架屏移除
 *   3. CDP Network：每个模块请求的发出与完成时间（dev 模式的瀑布元凶）
 *   4. 预热按键代理：~10ms 完成一次 Ctrl+Alt+S（不污染时序）
 *
 * 全部使用 epoch 毫秒，可直接相减。
 *
 * 用法: node test/_diag-final.mjs [--dev] [--label=xxx] [--summon-delay=800]
 */
import { spawn, execSync } from "child_process";
import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const useDev = argv.includes("--dev");
const label = (argv.find((a) => a.startsWith("--label=")) || "").split("=")[1] ?? (useDev ? "dev" : "release");
const summonDelay = Number((argv.find((a) => a.startsWith("--summon-delay=")) || "").split("=")[1] ?? 800);

const exe = path.join(root, "src-tauri", "target", useDev ? "debug" : "release", "my-search-desktop.exe");
const ISO_DIR = path.join(root, "test", ".diag-skeleton-profile");
const SHOT_DIR = path.join(root, "test", "_tmp", "final", label);
const AGENT = path.join(root, "test", "_diag-window-agent.ps1");
const PORT = 9372;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
let t0 = 0;
const rel = (w = now()) => w - t0;
const log = (...a) => console.log(`[+${String(rel()).padStart(6)}ms]`, ...a);

const killApp = () => {
  try {
    execSync("taskkill /F /IM my-search-desktop.exe /T", { stdio: "ignore" });
  } catch {}
};

if (!fs.existsSync(exe)) {
  console.error(`缺少构建：${exe}`);
  process.exit(2);
}
if (useDev) {
  try {
    if (!(await fetch("http://127.0.0.1:1420/index.html")).ok) throw new Error();
  } catch {
    console.error("vite dev server 未运行（先 npm run dev）");
    process.exit(2);
  }
}

killApp();
await sleep(500);
if (fs.existsSync(ISO_DIR)) fs.rmSync(ISO_DIR, { recursive: true, force: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });
for (const f of fs.readdirSync(SHOT_DIR)) fs.rmSync(path.join(SHOT_DIR, f), { force: true });
t0 = now();

// ---------- 窗口代理 ----------
const agent = spawn(
  "powershell",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", AGENT, "-ProcName", "my-search-desktop",
   "-TitleB64", Buffer.from("我的搜索", "utf-8").toString("base64"),
   "-OutDir", SHOT_DIR, "-IntervalMs", "100", "-Shots", "120"],
  { stdio: ["ignore", "pipe", "ignore"] }
);
const agentLines = [];
let agentReady = false;
readline.createInterface({ input: agent.stdout }).on("line", (l) => {
  agentLines.push(l);
  if (l.startsWith("READY")) agentReady = true;
});
for (let i = 0; i < 300 && !agentReady; i++) await sleep(50);
log("窗口代理就绪");

const winStates = () =>
  agentLines
    .filter((l) => l.startsWith("STATE"))
    .map((l) => {
      const [, ms, hwnd, st, x, y, w, h] = l.split(" ");
      return { t: Number(ms), hwnd, state: st, rect: `${x},${y} ${w}x${h}` };
    })
    .filter((s) => s.t >= t0 && s.state !== "absent");

// ---------- 预热按键代理 ----------
const KEY_AGENT = `
$ErrorActionPreference='SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line -eq 'QUIT') { break }
  $a = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  [System.Windows.Forms.SendKeys]::SendWait('^%s')
  $b = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  [Console]::Out.WriteLine("PRESSED $a $b")
  [Console]::Out.Flush()
}
`;
const keyAgent = spawn("powershell", ["-NoProfile", "-Command", KEY_AGENT], { stdio: ["pipe", "pipe", "ignore"] });
const pressLog = [];
let keyReady = false;
readline.createInterface({ input: keyAgent.stdout }).on("line", (l) => {
  if (l.startsWith("READY")) keyReady = true;
  if (l.startsWith("PRESSED")) pressLog.push(l.split(" ").slice(1).map(Number));
});
for (let i = 0; i < 300 && !keyReady; i++) await sleep(50);
keyAgent.stdin.write("PRESS" + String.fromCharCode(10)); // 预热
await sleep(600);
log("按键代理就绪");

// ---------- 启动应用 ----------
const app = spawn(exe, [], {
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: ISO_DIR,
  },
});
app.stderr.on("data", (d) => process.stdout.write("[app-err] " + d));
log(`app pid=${app.pid}（${label}）`);

const presses = [];
let windowCreatedAt = null;
const driver = (async () => {
  for (let i = 0; i < 8000; i++) {
    const first = winStates()[0];
    if (first) {
      windowCreatedAt = first.t;
      break;
    }
    await sleep(5);
  }
  if (windowCreatedAt == null) return;
  const start = windowCreatedAt + summonDelay;
  const wait = start - now();
  if (wait > 0) await sleep(wait);
  for (let i = 0; i < 50; i++) {
    if (winStates().some((s) => s.state === "visible")) break;
    presses.push(now());
    keyAgent.stdin.write("PRESS" + String.fromCharCode(10));
    await sleep(250);
  }
  log(`呼出尝试结束（${presses.length} 次按键）`);
})();

// ---------- CDP：页内探针 + 网络 ----------
const consoleEvents = [];
let lastProbe = null;
const netEvents = [];
const cdpDone = (async () => {
  let target = null;
  for (let i = 0; i < 10000; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((x) => x.type === "page");
      if (target) break;
    } catch {}
    await sleep(5);
  }
  if (!target) return;
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pend = new Map();
  const reqs = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    if (m.method === "Network.requestWillBeSent") {
      reqs.set(m.params.requestId, { url: m.params.request.url, start: Date.now(), type: m.params.type });
    } else if (m.method === "Network.responseReceived") {
      const r = reqs.get(m.params.requestId);
      if (r) { r.end = Date.now(); r.status = m.params.response.status; netEvents.push(r); }
    } else if (m.method === "Network.loadingFailed") {
      const r = reqs.get(m.params.requestId);
      if (r) { r.end = Date.now(); r.failed = m.params.errorText; netEvents.push(r); }
    } else if (m.method === "Runtime.consoleAPICalled") {
      consoleEvents.push({ t: rel(), kind: m.params.type, text: (m.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 220) });
    } else if (m.method === "Runtime.exceptionThrown") {
      consoleEvents.push({ t: rel(), kind: "exception", text: (m.params.exceptionDetails.exception?.description || "").slice(0, 300) });
    }
  };
  const send = (method, params = {}) =>
    new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Network.enable");
  const PROBE = `
(() => {
  if (window.__diag) return 'already';
  const D = (window.__diag = { marks: [], removedAt: null, mountAt: null });
  const mark = (n, extra) => D.marks.push(Object.assign({ n, w: Date.now(), p: Math.round(performance.now()) }, extra || {}));
  mark('html-parse-start', { ready: document.readyState, href: location.href });
  const check = () => {
    if (D.mountAt == null) {
      const a = document.getElementById('ms-app');
      if (a && a.children.length > 0) { D.mountAt = Date.now(); mark('vue-mounted'); }
    }
    if (D.removedAt == null && !document.getElementById('ms-skeleton')) { D.removedAt = Date.now(); mark('skeleton-removed'); }
  };
  const go = () => { if (document.documentElement) { new MutationObserver(check).observe(document.documentElement, { childList: true, subtree: true }); return true; } return false; };
  if (!go()) document.addEventListener('readystatechange', function f() { if (go()) document.removeEventListener('readystatechange', f); });
  const iv = setInterval(check, 5); setTimeout(() => clearInterval(iv), 300000);
  document.addEventListener('DOMContentLoaded', () => mark('DOMContentLoaded'), { once: true });
  window.addEventListener('load', () => mark('load'), { once: true });
  try { new PerformanceObserver((l) => { l.getEntries().forEach((e) => mark('paint:' + e.name, { startTime: Math.round(e.startTime) })); }).observe({ entryTypes: ['paint'] }); } catch (e) {}
  mark('probe-ready', { visibility: document.visibilityState });
  return 'installed';
})()
`;
  await send("Page.addScriptToEvaluateOnNewDocument", { source: PROBE });
  await send("Runtime.evaluate", { expression: PROBE, returnByValue: true });
  const deadline = now() + 180000;
  while (now() < deadline) {
    const r = await send("Runtime.evaluate", {
      expression: `window.__diag ? JSON.stringify({ marks: window.__diag.marks, removedAt: window.__diag.removedAt, mountAt: window.__diag.mountAt, sk: !!document.getElementById('ms-skeleton'), kids: document.getElementById('ms-app')?.children.length ?? -1 }) : null`,
      returnByValue: true,
    });
    if (r.result?.result?.value) lastProbe = JSON.parse(r.result.result.value);
    if (lastProbe?.removedAt != null && winStates().some((s) => s.state === "visible")) break;
    await sleep(20);
  }
})();

// ---------- 等待并汇总 ----------
const deadline = now() + 180000;
while (now() < deadline) {
  if (winStates().some((s) => s.state === "visible") && lastProbe?.removedAt != null) break;
  await sleep(20);
}
await sleep(400);

const states = winStates();
const firstVisible = states.find((s) => s.state === "visible") ?? null;
const marks = lastProbe?.marks ?? [];
const removed = lastProbe?.removedAt ?? null;
const parseStart = marks.find((m) => m.n === "html-parse-start")?.w ?? null;
const mounted = lastProbe?.mountAt ?? null;

console.log("\n==================== 结果 " + label + " ====================");
console.log(`  进程启动 → 窗口创建: ${windowCreatedAt ? "+" + rel(windowCreatedAt) + "ms" : "n/a"}`);
console.log(`  按下热键: ${presses.length} 次${presses.length ? "，首次 +" + rel(presses[0]) + "ms" : ""}`);
console.log(`  窗口首次可见: ${firstVisible ? "+" + rel(firstVisible.t) + "ms  rect=" + firstVisible.rect : "未可见"}`);
console.log(`  HTML 解析开始: ${parseStart ? "+" + rel(parseStart) + "ms" : "n/a"}`);
console.log(`  Vue 挂载:      ${mounted ? "+" + rel(mounted) + "ms" : "未挂载"}`);
console.log(`  骨架屏移除:    ${removed ? "+" + rel(removed) + "ms" : "未移除"}`);
if (parseStart && removed) console.log(`\n  >>> 骨架屏总存活（HTML 解析 → 移除）: ${rel(removed) - rel(parseStart)} ms`);
if (firstVisible && removed) {
  const d = rel(removed) - rel(firstVisible.t);
  console.log(`  >>> 其中「窗口已可见、用户正看着骨架屏」: ${d > 0 ? d : 0} ms`);
}
console.log("\n  页内标记:");
for (const m of marks) {
  console.log(`    +${String(rel(m.w)).padStart(6)}ms  ${m.n}${m.startTime != null ? ` (paint@${m.startTime}ms)` : ""}${m.ready ? ` ready=${m.ready}` : ""}${m.href ? ` ${m.href}` : ""}`);
}
console.log("\n  窗口状态:");
for (const s of states) console.log(`    +${String(rel(s.t)).padStart(6)}ms  ${s.state}  ${s.rect}`);

const done = netEvents.filter((r) => r.end);
if (done.length) {
  const firstStart = Math.min(...done.map((r) => r.start));
  const lastEnd = Math.max(...done.map((r) => r.end));
  console.log(`\n  网络请求: ${done.length} 个（首请求 +${rel(firstStart)}ms → 末请求完成 +${rel(lastEnd)}ms）`);
  console.log("  最慢的 12 个:");
  for (const r of done.slice().sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, 12)) {
    console.log(`    start +${String(rel(r.start)).padStart(6)}ms  dur ${String(r.end - r.start).padStart(7)}ms  ${r.status ?? r.failed}  ${r.url.replace(/^https?:\/\/[^/]+/, "").slice(0, 90)}`);
  }
  console.log("  最后完成的 5 个:");
  for (const r of done.slice().sort((a, b) => a.end - b.end).slice(-5)) {
    console.log(`    end   +${String(rel(r.end)).padStart(6)}ms  dur ${String(r.end - r.start).padStart(7)}ms  ${r.url.replace(/^https?:\/\/[^/]+/, "").slice(0, 90)}`);
  }
}
const shots = agentLines.filter((l) => l.startsWith("SHOT")).length;
console.log(`\n  截图: ${shots} 张 → ${path.relative(root, SHOT_DIR)}`);
if (consoleEvents.length) {
  console.log("\n  控制台（前 15 条）:");
  for (const e of consoleEvents.slice(0, 15)) console.log(`    +${String(e.t).padStart(6)}ms [${e.kind}] ${e.text}`);
}

killApp();
agent.kill();
keyAgent.kill();
process.exit(0);
