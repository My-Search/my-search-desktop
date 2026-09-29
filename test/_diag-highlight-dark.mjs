/**
 * 诊断：深色主题下详情区关键词高亮（.highlight-text）必须清晰可读。
 *
 * 背景：scrollToText 曾内联写死 background:#ffe58f，深色主题下 #text_show
 * 文字继承浅色（#e4e6ea），压在浅黄底上对比度仅 ~1.5:1 看不清。修复后
 * 配色收敛到 CSS（#text_show .highlight-text：浅黄底 + 显式深墨字）。
 *
 * 本脚本不启动整个应用：起静态服务挂上 dist 全部 CSS，构造最小 probe 页
 * （html.theme-dark + #text_show 结构），用真实 Chrome 计算样式并量化对比度：
 *  1. 深色：高亮文字与高亮底对比度 ≥ 7；
 *  2. 深色：高亮底不是被主题覆盖成深色（仍是 #ffe58f 系）；
 *  3. 浅色：行为不变（同配色，回归保护）。
 *
 * 用法: npm run build && node test/_diag-highlight-dark.mjs
 */
import { createServer } from "http";
import { readFile, readdir } from "fs/promises";
import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
if (!existsSync(path.join(dist, "index.html"))) {
  console.error("请先 npm run build");
  process.exit(1);
}

const cssFiles = (await readdir(path.join(dist, "assets")))
  .filter((f) => f.endsWith(".css"))
  .map((f) => `/assets/${f}`);
const probe = `<!doctype html><html class="theme-dark"><head>
<meta charset="utf-8">
${cssFiles.map((f) => `<link rel="stylesheet" href="${f}">`).join("\n")}
</head><body>
<div id="text_show" class="ms-markdown-body">
  <div class="markdown-body"><p>应的进程（以<span class="highlight-text">8080</span>端口示例）</p></div>
</div>
</body></html>`;

const server = createServer(async (req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  if (u === "/_probe.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return void res.end(probe);
  }
  const file = path.join(dist, u);
  if (!file.startsWith(dist) || !existsSync(file)) return void res.writeHead(404).end("not found");
  const body = await readFile(file);
  res.writeHead(200, { "Content-Type": u.endsWith(".css") ? "text/css; charset=utf-8" : "application/octet-stream" });
  res.end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const chromeBin = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));
if (!chromeBin) {
  console.log("跳过：未找到 Chrome / Edge。");
  server.close();
  process.exit(0);
}
const profile = path.join(root, "test", `_chrome-profile-highlight-${process.pid}`);
const proc = spawn(
  chromeBin,
  ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "about:blank"],
  { stdio: ["ignore", "ignore", "pipe"] }
);
const wsUrl = await new Promise((resolve, reject) => {
  let buf = "";
  const t = setTimeout(() => reject(new Error("DevTools timeout")), 30000);
  proc.stderr.on("data", (d) => {
    buf += d.toString();
    const m = buf.match(/ws:\/\/[^\s]+/);
    if (m) {
      clearTimeout(t);
      resolve(m[0]);
    }
  });
  proc.on("exit", (c) => reject(new Error("chrome exit " + c)));
});

let msgId = 0;
const pending = new Map();
const ws = new WebSocket(wsUrl);
await new Promise((r, j) => {
  ws.onopen = r;
  ws.onerror = j;
});
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  }
};
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
await S("Page.enable");
await S("Runtime.enable");
const evalJs = async (expr) => {
  const r = await S("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval failed");
  return r.result.value;
};

await S("Page.navigate", { url: `${base}/_probe.html` });
await new Promise((r) => setTimeout(r, 500));

const parseRgb = (s) => (s.match(/\d+/g) || []).slice(0, 3).map(Number);
const lum = ([r, g, b]) => {
  const f = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a, b) => {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
};

const read = () =>
  evalJs(`(() => {
    const cs = getComputedStyle(document.querySelector(".highlight-text"));
    return { color: cs.color, bg: cs.backgroundColor };
  })()`);

let fail = 0;
const check = (label, cond, detail) => {
  console.log(`${cond ? "✓" : "✗"} ${label} ${detail}`);
  if (!cond) fail = 1;
};

for (const theme of ["theme-dark", "theme-light"]) {
  await evalJs(`document.documentElement.className = "${theme}"`);
  const { color, bg } = await read();
  const ratio = contrast(parseRgb(color), parseRgb(bg));
  check(
    `${theme} 高亮对比度 ≥ 7`,
    ratio >= 7,
    `color=${color} bg=${bg} ratio=${ratio.toFixed(1)}:1`
  );
  const isYellow = parseRgb(bg)[0] > 200 && parseRgb(bg)[2] < 160;
  check(`${theme} 高亮底为浅黄`, isYellow, `bg=${bg}`);
}

proc.kill();
server.close();
process.exit(fail);
