/**
 * 冷 Vite 缓存下，dev 模式前端模块瀑布诊断。
 *
 * 场景：node_modules/.vite 被删除后第一次请求（start.bat 首次运行 / 依赖变更后）。
 * 目的：找出「骨架屏存活 40s」期间前端到底在等什么。
 *
 * 用法: node test/_diag-cold-waterfall.mjs
 */
import { spawn, execSync } from "child_process";
import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

const killPort = (p) => {
  try {
    execSync(
      `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${p} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`,
      { stdio: "ignore" }
    );
  } catch {}
};

killPort(1420);
await sleep(600);
const viteCache = path.join(root, "node_modules", ".vite");
if (fs.existsSync(viteCache)) fs.rmSync(viteCache, { recursive: true, force: true });
console.log("[准备] node_modules/.vite 已删除（冷缓存）");

const vite = spawn("npx", ["vite", "--port", "1420", "--strictPort"], { cwd: root, shell: true, stdio: ["ignore", "pipe", "pipe"] });
const viteLog = [];
const t0 = now();
const rel = (w = now()) => w - t0;
vite.stdout.on("data", (d) => viteLog.push(`[+${rel()}ms] ` + d.toString()));
vite.stderr.on("data", (d) => viteLog.push(`[+${rel()}ms] ` + d.toString()));

let up = false;
for (let i = 0; i < 600; i++) {
  try {
    if ((await fetch("http://127.0.0.1:1420/")).ok) { up = true; break; }
  } catch {}
  await sleep(50);
}
if (!up) { console.error("vite 未就绪"); process.exit(1); }
console.log(`[+${rel()}ms] vite HTTP 就绪（注意：此时依赖预构建可能还没开始）`);

// 无头 Chrome 立即请求（触发 optimizeDeps）
const userDir = path.join(root, "test", "_chrome-profile-cold-waterfall");
fs.rmSync(userDir, { recursive: true, force: true });
const bin = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const chrome = spawn(bin, ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${userDir}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const wsUrl = await new Promise((resolve) => {
  let buf = "";
  chrome.stderr.on("data", (d) => {
    buf += d.toString();
    const m = buf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (m) resolve(m[1]);
  });
});
const ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pend = new Map();
const reqs = new Map();
const marks = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === "Network.requestWillBeSent") {
    const u = m.params.request.url;
    if (u.startsWith("http://127.0.0.1:1420")) reqs.set(m.params.requestId, { url: u.replace("http://127.0.0.1:1420", ""), start: now(), type: m.params.type });
  }
  if (m.method === "Network.responseReceived") {
    const r = reqs.get(m.params.requestId);
    if (r) { r.end = now(); r.status = m.params.response.status; }
  }
  if (m.method === "Network.loadingFailed") {
    const r = reqs.get(m.params.requestId);
    if (r) { r.end = now(); r.failed = m.params.errorText; }
  }
  if (m.method === "Runtime.consoleAPICalled") {
    marks.push(`[console.${m.params.type}] ` + (m.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200));
  }
};
const S = (method, params = {}, sessionId) =>
  new Promise((resolve) => { const mid = ++id; pend.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params, sessionId })); });
const { result: targets } = await S("Target.getTargets");
const pageTarget = targets.targetInfos.find((t) => t.type === "page");
const { result: { sessionId } } = await S("Target.attachToTarget", { targetId: pageTarget.targetId, flatten: true });
await S("Runtime.enable", {}, sessionId);
await S("Page.enable", {}, sessionId);
await S("Network.enable", {}, sessionId);
await S("Page.addScriptToEvaluateOnNewDocument", {
  source: `
    window.__TAURI_INTERNALS__ = { invoke(){return Promise.resolve(null)}, transformCallback(cb){return cb}, metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}}, plugins:{} };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(){} };
    window.__diag = { mountAt: null, removedAt: null, marks: [] };
    (function(){
      var D=window.__diag;
      function mark(n){D.marks.push({n:n,w:Date.now(),p:Math.round(performance.now())});}
      mark('document-start');
      function check(){
        if(D.mountAt==null){var a=document.getElementById('ms-app');if(a&&a.children.length>0){D.mountAt=Date.now();mark('vue-mounted');}}
        if(D.removedAt==null&&!document.getElementById('ms-skeleton')){D.removedAt=Date.now();mark('skeleton-removed');}
      }
      function go(){if(document.documentElement){new MutationObserver(check).observe(document.documentElement,{childList:true,subtree:true});return true;}return false;}
      if(!go())document.addEventListener('readystatechange',function f(){if(go())document.removeEventListener('readystatechange',f);});
      var iv=setInterval(check,5);setTimeout(function(){clearInterval(iv);},300000);
      document.addEventListener('DOMContentLoaded',function(){mark('DOMContentLoaded');});
      window.addEventListener('load',function(){mark('load');});
    })();
  `,
}, sessionId);

const navAt = now();
await S("Page.navigate", { url: "http://127.0.0.1:1420/index.html" }, sessionId);
let probe = null;
for (let i = 0; i < 4000; i++) {
  const r = await S("Runtime.evaluate", {
    expression: `window.__diag ? JSON.stringify({ marks: window.__diag.marks, mountAt: window.__diag.mountAt, removedAt: window.__diag.removedAt, sk: !!document.getElementById('ms-skeleton') }) : null`,
    returnByValue: true,
  }, sessionId);
  if (r.result?.result?.value) probe = JSON.parse(r.result.result.value);
  if (probe?.removedAt != null && !probe.sk) break;
  await sleep(50);
}

const done = [...reqs.values()].filter((r) => r.end);
console.log(`\n=========== 结果 ===========`);
console.log(`  导航 → Vue 挂载: ${probe?.mountAt ? probe.mountAt - navAt : "未挂载"} ms`);
console.log(`  导航 → 骨架屏移除: ${probe?.removedAt ? probe.removedAt - navAt : "未移除"} ms`);
console.log(`  请求总数: ${done.length}`);
console.log(`\n  页内标记（相对导航）:`);
for (const m of probe?.marks ?? []) console.log(`    +${String(m.w - navAt).padStart(6)}ms  ${m.n}`);
console.log(`\n  最慢的 20 个请求（相对导航）:`);
for (const r of done.slice().sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, 20)) {
  console.log(`    +${String(r.start - navAt).padStart(6)}ms  dur ${String(r.end - r.start).padStart(7)}ms  ${r.status ?? r.failed}  ${r.url}`);
}
console.log(`\n  按完成时间排序的最后 20 个:`);
for (const r of done.slice().sort((a, b) => a.end - b.end).slice(-20)) {
  console.log(`    +${String(r.end - navAt).padStart(6)}ms  (start +${String(r.start - navAt).padStart(6)}ms dur ${String(r.end - r.start).padStart(6)}ms)  ${r.url}`);
}
console.log(`\n  vite 日志（含 optimizeDeps 提示）:`);
for (const l of viteLog) console.log("    " + l.trim());
if (marks.length) {
  console.log("\n  浏览器控制台:");
  for (const m of marks.slice(0, 20)) console.log("    " + m);
}

await S("Browser.close");
chrome.kill();
killPort(1420);
process.exit(0);
