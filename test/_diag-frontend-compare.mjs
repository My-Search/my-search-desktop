/**
 * 前端加载对比：dev（vite 模块图）vs release（打包产物）。
 *
 * 只测前端本身（无头 Chrome），排除 Rust/WebView2 启动差异：
 *   导航 → Vue 挂载 → 骨架屏移除，并统计模块请求数与长尾请求。
 *
 * 用法: node test/_diag-frontend-compare.mjs [--dev] [--runs=2]
 */
import { createServer } from "http";
import { readFile, rm } from "fs/promises";
import { spawn, execSync } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const useDev = argv.includes("--dev");
const runs = Number((argv.find((a) => a.startsWith("--runs=")) || "").split("=")[1] ?? 2);
const dist = path.join(root, "dist");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json" };

let server = null;
let base;
if (!useDev) {
  server = createServer(async (req, res) => {
    try {
      const u = decodeURIComponent(req.url.split("?")[0]);
      const file = path.join(dist, u === "/" ? "/index.html" : u);
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
} else {
  try {
    if (!(await fetch("http://127.0.0.1:1420/index.html")).ok) throw new Error();
  } catch {
    console.error("vite dev server 未运行");
    process.exit(2);
  }
  base = "http://127.0.0.1:1420";
}

const bin = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const userDir = path.join(root, "test", "_chrome-profile-fe-compare");
await rm(userDir, { recursive: true, force: true });
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
let reqs = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m);
    pend.delete(m.id);
    return;
  }
  if (m.method === "Network.requestWillBeSent") {
    const u = m.params.request.url;
    if (u.startsWith(base)) reqs.set(m.params.requestId, { url: u.replace(base, ""), start: Date.now(), type: m.params.type });
  }
  if (m.method === "Network.responseReceived") {
    const r = reqs.get(m.params.requestId);
    if (r) { r.end = Date.now(); r.status = m.params.response.status; }
  }
  if (m.method === "Network.loadingFailed") {
    const r = reqs.get(m.params.requestId);
    if (r) { r.end = Date.now(); r.failed = m.params.errorText; }
  }
};
const S = (method, params = {}, sessionId) =>
  new Promise((resolve) => {
    const mid = ++id;
    pend.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
  });
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
    window.__diag = { marks: [], removedAt: null, mountAt: null };
    (function(){
      var D = window.__diag;
      function mark(n, extra){ var o={n:n,w:Date.now(),p:Math.round(performance.now())}; if(extra)for(var k in extra)o[k]=extra[k]; D.marks.push(o); }
      mark('document-start');
      function check(){
        if (D.mountAt==null){ var a=document.getElementById('ms-app'); if(a&&a.children.length>0){D.mountAt=Date.now(); mark('vue-mounted');} }
        if (D.removedAt==null && !document.getElementById('ms-skeleton')){ D.removedAt=Date.now(); mark('skeleton-removed'); }
      }
      function go(){ if(document.documentElement){ new MutationObserver(check).observe(document.documentElement,{childList:true,subtree:true}); return true;} return false; }
      if(!go()) document.addEventListener('readystatechange', function f(){ if(go()) document.removeEventListener('readystatechange',f); });
      var iv=setInterval(check,5); setTimeout(function(){clearInterval(iv);},300000);
    })();
  `,
}, sessionId);

const results = [];
for (let run = 1; run <= runs; run++) {
  reqs = new Map();
  const t0 = Date.now();
  await S("Page.navigate", { url: base + "/index.html" }, sessionId);
  let probe = null;
  for (let i = 0; i < 2400; i++) {
    const r = await S("Runtime.evaluate", {
      expression: `window.__diag ? JSON.stringify({ marks: window.__diag.marks, removedAt: window.__diag.removedAt, mountAt: window.__diag.mountAt, sk: !!document.getElementById('ms-skeleton') }) : null`,
      returnByValue: true,
    }, sessionId);
    if (r.result?.result?.value) probe = JSON.parse(r.result.result.value);
    if (probe?.removedAt != null && !probe.sk) break;
    await sleep(25);
  }
  const navWall = t0;
  const done = [...reqs.values()].filter((r) => r.end);
  const mounted = probe?.mountAt ? probe.mountAt - navWall : null;
  const removed = probe?.removedAt ? probe.removedAt - navWall : null;
  const docReq = [...reqs.values()].find((r) => r.url === "/index.html" || r.url === "/");
  results.push({
    run,
    modules: done.length,
    mounted,
    removed,
    docMs: docReq ? docReq.end - docReq.start : null,
    slowest: done
      .map((r) => ({ url: r.url, dur: r.end - r.start }))
      .sort((a, b) => b.dur - a.dur)
      .slice(0, 8),
    lastModule: done.reduce((a, b) => (!a || a.end < b.end ? b : a), null),
  });
  await sleep(400);
}

console.log(`\n============ ${useDev ? "dev (vite 模块图)" : "release (打包产物)"} ============`);
for (const r of results) {
  console.log(`\n第 ${r.run} 次加载:`);
  console.log(`  模块请求数: ${r.modules}`);
  console.log(`  index.html 响应耗时: ${r.docMs ?? "?"} ms`);
  console.log(`  导航 → Vue 挂载: ${r.mounted ?? "未挂载"} ms`);
  console.log(`  导航 → 骨架屏移除: ${r.removed ?? "未移除"} ms`);
  if (r.lastModule) console.log(`  最后一个模块完成于: ${r.lastModule.end - (r.lastModule.start - (r.mounted ?? 0))} ... ${r.lastModule.url}`);
  console.log("  最慢的请求:");
  for (const s of r.slowest) console.log(`    ${String(s.dur).padStart(6)}ms  ${s.url}`);
}

await S("Browser.close");
chrome.kill();
if (server) server.close();
process.exit(0);
