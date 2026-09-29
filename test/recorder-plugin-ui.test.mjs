/**
 * 录屏与水印插件前台的浏览器 e2e 测试。
 *
 * 走仓库既有 UI 测试的路子（同 screenshot-plugin-ui.test.mjs）：起静态服务器
 * + 真实浏览器（Chrome/Edge，CDP）加载「假宿主页」，把插件脚本按宿主的方式
 * （new Function 注入 ms/onSubKeyword）执行。没装浏览器时自动跳过。
 *
 * 这里钉的是**真实 DOM 行为**，纯函数单测覆盖不到的部分：
 *   1. 未检测到 ffmpeg 时顶部显示红色状态并给出「去设置」入口；
 *   2. 四个页签切换（含 hidden 的互斥）；
 *   3. 水印编辑器：切「图片」隐藏文字控件、滑块改数值、canvas 预览不报错；
 *   4. 录制：点开始 → 调 startRecord 且带上水印/区域参数；点停止 → 调 stopRecord；
 *   5. 转码：填路径 → detectVideo 展示元数据；点开始 → applyWatermark；
 *   6. 作品库：列出后端返回的文件、区分「录制/水印」标签；
 *   7. 预设：保存后出现在列表、可套用、可删除。
 *
 * 用法: node test/recorder-plugin-ui.test.mjs
 */
import { createServer } from "http";
import { readFile } from "fs/promises";
import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = path.join(root, "plugins", "recorder");

let pass = 0;
let fail = 0;
function ok(cond, name, extra = "") {
  if (cond) {
    pass++;
    console.log("PASS ", name, extra ? ` — ${extra}` : "");
  } else {
    fail++;
    console.log("FAIL ", name, extra ? ` — ${extra}` : "");
  }
}

/* ===================== 假宿主页 ===================== */

const html = await readFile(path.join(pluginDir, "ui", "detail.html"), "utf8");
const code = await readFile(path.join(pluginDir, "ui", "index.js"), "utf8");
const css = await readFile(path.join(pluginDir, "ui", "detail.css"), "utf8");

/** 转义 </script> 里会提前闭合标签的序列（插件 HTML/JS 里都有） */
const safe = (s) => JSON.stringify(s).replace(/<\//g, "<\\/");

function harnessPage() {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>${css.replace(/<\//g, "<\\/")}</style></head>
<body>
<div id="app"><div id="mount"></div></div>
<script>
const PLUGIN_HTML = ${safe(html)};
const PLUGIN_CODE = ${safe(code)};

window.__rcRun = async function (opts) {
  opts = opts || {};
  const calls = {};
  function rec(name, ret) {
    return async function () {
      (calls[name] = calls[name] || []).push(Array.prototype.slice.call(arguments));
      return typeof ret === "function" ? ret.apply(null, arguments) : ret;
    };
  }
  window.__rcCalls = calls;

  // 把模板与页面塞进 mount（模板要先于脚本解析，否则 getElementById 拿不到）
  document.getElementById("mount").innerHTML = PLUGIN_HTML;

  const ff = opts.ffmpeg || { found: false, path: null, version: null, probeFound: false, source: null, tried: ["C:\\\\ffmpeg\\\\bin"] };
  const recordings = opts.recordings || [];

  const ms = {
    plugin: { id: "com.mysearch.recorder", info: { theme: "inherit" } },
    log: function () {},
    ui: { toast: function () {}, confirm: async function () { return opts.confirmAnswer !== false; } },
    store: {
      _d: opts.storeData || {},
      get: function (k, f) { return k in this._d ? this._d[k] : f; },
      set: function (k, v) { this._d[k] = v; return Promise.resolve(true); }
    },
    input: { attachments: async function () { return opts.attachments || []; } },
    backend: {
      call: async function (method, params) {
        (calls[method] = calls[method] || []).push([params]);
        if (method === "capabilities") {
          // ff 里补上 bundled / download 两个子对象（后端 capabilities 的形状），
          // 界面据此决定显示「一键下载」还是「已就绪」
          const ffx = Object.assign(
            { found: false, path: null, version: null, probeFound: false, tried: [], bundled: { present: false }, download: { inProgress: false, sources: [{ id: "btbn-win64-gpl", url: "https://github.com/x/y.zip", kind: "zip" }] } },
            ff || {}
          );
          if (!ffx.bundled) ffx.bundled = { present: false };
          if (!ffx.download) ffx.download = { inProgress: false, sources: [{ id: "btbn-win64-gpl", url: "https://github.com/x/y.zip", kind: "zip" }] };
          return { platform: "win32", dataDir: "D:\\\\data", outDir: "D:\\\\data\\\\recordings", binDir: "D:\\\\data\\\\ffmpeg", ffmpeg: ffx,
                   hints: { format: "gdigrab", regionSupported: true }, recordings: recordings.length, busy: {} };
        }
        if (method === "listFonts") return { fonts: ["C:\\\\Windows\\\\Fonts\\\\msyh.ttc"] };
        if (method === "listRecordings") return recordings;
        if (method === "downloadFfmpeg") {
          if (opts.downloadFails === "disk") {
            const e = new Error("下载 ffmpeg 失败：磁盘空间不足：所在分区只剩 120.0 MB，下载并解包大约需要 527.4 MB。请清理磁盘后重试，或在「设置」里手动指定已安装的 ffmpeg 路径（不占额外空间）。");
            e.code = "DOWNLOAD_FAILED";
            throw e;
          }
          if (opts.downloadFails) { const e = new Error("下载 ffmpeg 失败：网络不可达"); e.code = "DOWNLOAD_FAILED"; throw e; }
          return { ok: true, path: "D:\\\\data\\\\ffmpeg\\\\ffmpeg.exe", version: "7.1.0", bytes: 41943040, bytesText: "40.0 MB", source: "btbn-win64-gpl" };
        }
        if (method === "removeBundledFfmpeg") return { ok: true };
        if (method === "startRecord") return { ok: true, output: "recordings/rec-1.mp4", notes: [], ffmpeg: "ffmpeg.exe" };
        if (method === "stopRecord") return { ok: true, output: "recordings/rec-1.mp4" };
        if (method === "pauseRecord") return { ok: true, paused: !!(params && params.paused) };
        if (method === "screenSnapshot") {
          // 400×200 的纯色「桌面截图」：bounds 与图像 1:1，方便断言换算结果
          const c = document.createElement("canvas");
          c.width = 400; c.height = 200;
          const g = c.getContext("2d");
          g.fillStyle = "#336699";
          g.fillRect(0, 0, 400, 200);
          return { dataUrl: c.toDataURL("image/png"), originX: 0, originY: 0, width: 400, height: 200 };
        }
        if (method === "detectVideo") return { input: params.input, name: "a.mp4", size: 1048576, durationSec: 65, width: 1920, height: 1080, fps: 30, codec: "h264" };
        if (method === "applyWatermark") return { ok: true, output: "recordings/wm-a.mp4", size: 2048, durationSec: 65 };
        if (method === "thumb") return { base64: "iVBORw0KGgo=", mime: "image/png" };
        if (method === "state") return { recording: { active: false }, transcoding: null };
        return {};
      },
      onNotification: function (m, fn) { (window.__rcSubs = window.__rcSubs || {})[m] = fn; return function () {}; },
      offNotification: function () {}
    }
  };

  const fn = new Function(
    "ms","env","plugin","host","keyword","inputValue",
    "onSubKeyword","md2html","openExternal",
    '"use strict";\\n' + PLUGIN_CODE
  );
  // 屏幕直接框选：opts.pickRegion 为对象/null 时提供 ms.screenshot.pickRegion，
  // 为 "error" 时模拟权限未授予；不传则不提供（走面板内截图兜底）
  if (opts.pickRegion !== undefined) {
    ms.screenshot = {
      pickRegion: function () {
        if (opts.pickRegion === "error") return Promise.reject(new Error("缺少权限: screenshot.overlay"));
        return Promise.resolve(opts.pickRegion);
      }
    };
  }
  // 暴露给用例读 store（断言区域偏好是否持久化）
  window.__rcMs = ms;
  fn(ms, {}, { id: "com.mysearch.recorder" }, document.getElementById("app"),
     opts.keyword || "", "", opts.onSubKeyword || function () {}, function (s) { return s; }, function () {});

  // 等 boot 的 async 链（capabilities / 字体 / 状态 / 附件）跑完
  await new Promise(function (r) { setTimeout(r, 350); });
  return calls;
};

window.__rc = {
  calls: function () { return window.__rcCalls; },
  text: function (sel) { var e = document.querySelector(sel); return e ? e.textContent.trim() : null; },
  val: function (sel) { var e = document.querySelector(sel); return e ? e.value : null; },
  hidden: function (sel) { var e = document.querySelector(sel); return e ? e.hidden : null; },
  disabled: function (sel) { var e = document.querySelector(sel); return e ? e.disabled : null; },
  checked: function (sel) { var e = document.querySelector(sel); return e ? !!e.checked : null; },
  /* 计算后的显示值：hidden 属性为 true 但被作者样式盖住时（历史 bug：浮层
     常驻显示），只有 computed display 才能暴露 */
  display: function (sel) {
    var e = document.querySelector(sel);
    return e ? window.getComputedStyle(e).display : null;
  },
  clicked: function (sel) { var e = document.querySelector(sel); if (!e) return false; e.dispatchEvent(new MouseEvent("click", { bubbles: true })); return true; },
  setVal: function (sel, v) { var e = document.querySelector(sel); if (!e) return false; e.value = v; e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); return true; },
  tab: function (name) { return window.__rc.clicked('.rc-tab[data-tab="' + name + '"]'); },
  // 两个编辑器容器的 id 不同名：录屏页是 rc-rec-wm-editor，加水印页是 rc-wm-editor，
  // 所以这里做显式映射（不能用同一个模板拼，否则会拼出不存在的 rc-wm-wm-editor）
  editorSel: function (which) { return which === "rec" ? "#rc-rec-wm-editor" : "#rc-wm-editor"; },
  editorCount: function (which) { return document.querySelectorAll(window.__rc.editorSel(which) + " .rc-wm").length; },
  presetRows: function () { return document.querySelectorAll(".rc-preset-item").length; },
  presetNames: function () { return Array.prototype.map.call(document.querySelectorAll(".rc-preset-item .rc-preset-name"), function (e) { return e.textContent.trim(); }); },
  libCards: function () { return document.querySelectorAll(".rc-lib-card").length; },
  libTags: function () { return Array.prototype.map.call(document.querySelectorAll(".rc-lib-card .rc-tag"), function (e) { return e.textContent.trim(); }); },
  notify: function (method, params) { var f = (window.__rcSubs || {})[method]; if (f) f(params); return !!f; },
  timer: function () { return document.querySelector("#rc-rec-timer").textContent.trim(); },
  canvasDataLen: function (which) { var c = document.querySelector(window.__rc.editorSel(which) + " canvas"); return c ? c.toDataURL().length : 0; },
  /* 框选浮层：截图是否已解码出天然尺寸（naturalWidth>0 才能换算坐标） */
  pickReady: function () { var i = document.querySelector("#rc-pick-img"); return !!(i && i.naturalWidth); },
  /* 在截图上按 (x0,y0)→(x1,y1) 拖一段（相对图片左上角的 CSS 像素） */
  dragPick: function (x0, y0, x1, y1) {
    var stage = document.querySelector("#rc-pick-stage");
    var img = document.querySelector("#rc-pick-img");
    if (!stage || !img) return false;
    var r = img.getBoundingClientRect();
    function fire(target, type, x, y) {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: r.left + x, clientY: r.top + y, button: 0 }));
    }
    fire(stage, "mousedown", x0, y0);
    fire(stage, "mousemove", (x0 + x1) / 2, (y0 + y1) / 2);
    fire(stage, "mousemove", x1, y1);
    fire(document, "mouseup", x1, y1);
    return true;
  },
  pickRect: function () {
    var e = document.querySelector("#rc-pick-rect");
    if (!e || e.hidden) return null;
    return { left: parseFloat(e.style.left), top: parseFloat(e.style.top), width: parseFloat(e.style.width), height: parseFloat(e.style.height) };
  },
};
</script>
</body></html>`;
}

const server = createServer(async (req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  if (u === "/" || u === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(harnessPage());
    return;
  }
  try {
    const file = path.join(pluginDir, u.replace(/^\//, ""));
    if (!file.startsWith(pluginDir)) return res.writeHead(403).end("forbidden");
    const body = await readFile(file);
    const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" }[path.extname(file)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime });
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
  console.log("未找到浏览器（Chrome/Edge），跳过录屏插件 UI 测试");
  server.close();
  process.exit(0);
}

/* ===================== 起浏览器 + CDP ===================== */

const userDir = path.join(root, "test", "_chrome-profile-recorder-ui");
const port = 9550 + Math.floor(Math.random() * 200);
const chrome = spawn(bin, [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userDir}`,
  "--headless=new",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--disable-sync",
  "--disable-features=msEdgeSyncConfirmationDialog,EdgeSidebar",
  "--window-size=1280,900",
  base,
], { stdio: "ignore" });

async function cdpTarget() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl && String(t.url).startsWith(base));
      if (page) return page;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("浏览器 CDP 未就绪（未找到目标页面）");
}

let ws;
let msgId = 0;
const pending = new Map();

async function connect() {
  const target = await cdpTarget();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("WebSocket 连接失败"));
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id != null && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(JSON.stringify(m.error)));
      else resolve(m.result);
    }
  };
}

function send(method, params) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}

async function evaluate(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error("页面求值异常: " + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails));
  }
  return r.result.value;
}

const run = (opts) => evaluate(`window.__rcRun(${JSON.stringify(opts || {})})`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 断言相等（带期望/实际的可读输出） */
function eq(actual, expected, name) {
  ok(actual === expected, name, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/** 轮询直到断言条件成立（异步加载类场景：截图解码、通知到达） */
async function waitFor(fn, timeoutMs = 3000, label = "条件") {
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await fn()) return true;
    } catch (e) {
      lastErr = e;
    }
    await wait(60);
  }
  throw new Error(`等待${label}超时（${timeoutMs}ms）${lastErr ? "：" + lastErr.message : ""}`);
}

/**
 * 读**活的**调用记录。
 *
 * `__rcRun` 返回的是它 resolve 那一刻的快照，而按钮点击发生在之后——
 * 直接断言返回值的 `calls.startRecord` 永远是 undefined（假失败）。
 * 因此所有「点了按钮之后」的断言都必须走这里读 window 上的活对象。
 */
const calls = () => evaluate("window.__rcCalls");
const callsOf = async (name) => (await calls())[name] || [];

/** 造录制文件列表 */
function makeRecordings(n) {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => ({
    relPath: `recordings/${i % 2 ? "wm-" : "rec-"}${i}.mp4`,
    name: `${i % 2 ? "wm-" : "rec-"}${i}.mp4`,
    size: 1024 * (i + 1),
    mtimeMs: now - i * 60000,
    createdAt: new Date(now - i * 60000).toISOString(),
    kind: i % 2 ? "watermark" : "record",
  }));
}

try {
  await connect();
  await wait(400);

  /* ---------------- 1. ffmpeg 缺失时的引导 ----------------
   *
   * 关键场景：插件自带下载是主路径。未就绪时必须给出「一键下载」CTA，
   * 同时保留「手动指定」作为离线/自备 ffmpeg 的退路。 */
  {
    await run({ ffmpeg: { found: false, path: null, tried: ["C:\\ffmpeg\\bin"] } });
    ok((await evaluate("window.__rc.text('#rc-fftext')")).includes("尚未准备好 ffmpeg"), "ffmpeg 缺失时顶部提示改为「尚未准备好」");
    ok((await evaluate("window.__rc.hidden('#rc-fffix')")) === false, "缺失时仍提供「手动指定」入口");
    ok((await evaluate("window.__rc.hidden('#rc-ffdl')")) === false, "缺失时显示「一键下载」CTA");
    ok((await evaluate("document.querySelector('#rc-ffdot').className")).includes("off"), "状态点为红（off）");

    // 点「一键下载」→ 调 downloadFfmpeg，成功后就绪（位置参数形式，UI 是 (pct, text)）
    await evaluate("window.__rc.clicked('#rc-ffdl')");
    await wait(200);
    ok((await callsOf("downloadFfmpeg")).length === 1, "点「一键下载」调 downloadFfmpeg");
    ok((await evaluate("window.__rc.text('#rc-status')")).includes("ffmpeg 下载完成"), "下载成功后给出成功状态");
    ok((await evaluate("window.__rc.hidden('#rc-dl')")) === true, "下载完成后隐藏进度条");

    // 下载失败 → 明确提示且不谎报就绪
    await run({ ffmpeg: { found: false, path: null }, downloadFails: true });
    await evaluate("window.__rc.clicked('#rc-ffdl')");
    await wait(250);
    ok((await evaluate("window.__rc.text('#rc-status')")).includes("下载失败"), "下载失败时状态行给出错误");
    ok((await evaluate("window.__rc.text('#rc-status')")).includes("手动指定"), "失败文案给出退路（手动指定）");

    // 点「手动指定」→ 切到设置页签
    await run({ ffmpeg: { found: false, path: null } });
    await evaluate("window.__rc.clicked('#rc-fffix')");
    await wait(60);
    ok((await evaluate("window.__rc.hidden('#rc-pane-set')")) === false, "点「手动指定」切到设置页");
  }

  /* ---------------- 1b. 下载进度通知 ---------------- */
  {
    await run({ ffmpeg: { found: false, path: null } });
    await evaluate("window.__rc.notify('ffmpeg:progress', { phase: 'download', percent: 37, received: 15518924, total: 41943040, receivedText: '14.8 MB', totalText: '40.0 MB', message: '下载中 14.8 MB' })");
    await wait(60);
    ok((await evaluate("window.__rc.hidden('#rc-dl')")) === false, "收到进度通知后显示进度条");
    ok((await evaluate("document.querySelector('#rc-dl-fill').style.width")).startsWith("37"), "进度条随通知推进");
    const t = await evaluate("window.__rc.text('#rc-dl-text')");
    ok(t.includes("14.8 MB") && t.includes("40.0 MB"), "进度文案显示已下载/总量", t);
  }

  /* ---------------- 2. ffmpeg 就绪 ---------------- */
  {
    await run({
      ffmpeg: {
        found: true, path: "D:\\data\\ffmpeg\\ffmpeg.exe", version: "7.1.0", probeFound: true, source: "bundled",
        bundled: { present: true, path: "D:\\data\\ffmpeg\\ffmpeg.exe", version: "7.1.0", downloadedAt: new Date().toISOString() },
      },
    });
    var ffLine = await evaluate("window.__rc.text('#rc-fftext')");
    ok(ffLine.includes("已就绪"), "就绪时顶部显示「已就绪」", ffLine);
    ok(!ffLine.includes("ffmpeg.exe") && !ffLine.includes("7.1.0"), "状态条不再塞版本号与完整路径", ffLine);
    ok((await evaluate("document.querySelector('#rc-fftext').title")).includes("D:\\data\\ffmpeg\\ffmpeg.exe"),
      "版本与路径挪到悬停 title");
    ok((await evaluate("document.querySelector('#rc-ffdot').className")).includes("on"), "状态点为绿（on）");
    ok((await evaluate("window.__rc.hidden('#rc-fffix')")) === true, "就绪时隐藏「手动指定」");
    ok((await evaluate("window.__rc.hidden('#rc-ffdl')")) === true, "就绪时隐藏「一键下载」");
    ok((await callsOf("capabilities")).length >= 1, "启动时探测后端能力");
    ok((await callsOf("listFonts")).length === 1, "启动时拉取中文字体列表");
    ok((await callsOf("state")).length === 1, "启动时同步后端录制状态");

    // 设置页应显示自带副本状态与下载源
    await evaluate("window.__rc.tab('set')");
    await wait(80);
    ok((await evaluate("window.__rc.text('#rc-set-bundled')")).includes("已就绪"), "设置页显示自带副本已就绪");
    ok((await evaluate("window.__rc.text('#rc-set-sources')")).includes("btbn"), "设置页显示下载源");
    ok((await evaluate("window.__rc.hidden('#rc-set-dlrm')")) === false, "有自带副本时显示「删除自带副本」");
    ok((await evaluate("window.__rc.text('#rc-set-bindir')")).includes("ffmpeg"), "设置页显示自带 ffmpeg 目录");
    // 删除自带副本
    await evaluate("window.__rc.clicked('#rc-set-dlrm')");
    await wait(200);
    ok((await callsOf("removeBundledFfmpeg")).length === 1, "点「删除自带副本」调 removeBundledFfmpeg");
  }

  /* ---------------- 2b. 下载体积 / 磁盘空间提示 ---------------- */
  {
    // 空间充足：顶部提示要写明体积，设置页要写明需求与可用空间
    await run({
      ffmpeg: {
        found: false, path: null,
        download: {
          inProgress: false,
          sources: [{ id: "btbn-win64-gpl", url: "https://github.com/x/y.zip", kind: "zip", approxBytes: 196009854, approxText: "186.9 MB" }],
          needBytes: 553000000, needText: "527.4 MB", freeBytes: 50 * 1024 * 1024 * 1024,
        },
      },
    });
    // 顶部提示报「需要多少空间」（比报归档体积更有用）
    ok((await evaluate("window.__rc.text('#rc-fftext')")).includes("527.4 MB"), "顶部提示写明所需空间");
    await evaluate("window.__rc.tab('set')");
    await wait(80);
    const s = await evaluate("window.__rc.text('#rc-set-sources')");
    ok(s.includes("btbn-win64-gpl"), "设置页显示下载源 id");
    ok(s.includes("186.9 MB"), "设置页显示源体积", s);
    ok(s.includes("527.4 MB"), "设置页显示所需空间", s);
    ok(s.includes("50.00 GB"), "设置页显示当前可用空间", s);

    // 空间不足：要能看出「磁盘不够」而不是笼统的下载失败
    await run({
      ffmpeg: {
        found: false, path: null,
        download: {
          inProgress: false,
          sources: [{ id: "btbn-win64-gpl", url: "https://github.com/x/y.zip", kind: "zip", approxBytes: 196009854, approxText: "186.9 MB" }],
          needBytes: 553000000, needText: "527.4 MB", freeBytes: 120 * 1024 * 1024,
        },
      },
    });
    await evaluate("window.__rc.tab('set')");
    await wait(80);
    ok((await evaluate("window.__rc.text('#rc-set-sources')")).includes("120.0 MB"), "空间紧张时如实显示可用空间");

    // 后端预检失败（磁盘不足）→ 界面必须原样转达磁盘原因
    await run({ ffmpeg: { found: false, path: null }, downloadFails: "disk" });
    await evaluate("window.__rc.clicked('#rc-ffdl')");
    await wait(250);
    const st = await evaluate("window.__rc.text('#rc-status')");
    ok(st.includes("磁盘空间不足"), "磁盘不足的错误被如实转达", st);
    ok(st.includes("手动指定"), "磁盘不足时给出「手动指定」退路");
    ok(st.split("手动指定").length - 1 === 1, "指引只说一遍（不与通用退路重复）", st);
  }

  /* ---------------- 3. 页签互斥 ---------------- */
  {
    await run({ ffmpeg: { found: true, path: "ffmpeg.exe" } });
    ok((await evaluate("window.__rc.hidden('#rc-pane-rec')")) === false, "默认在「录屏」页");
    ok((await evaluate("window.__rc.hidden('#rc-pane-wm')")) === true, "「加水印」页初始隐藏");

    await evaluate("window.__rc.tab('wm')");
    await wait(80);
    ok((await evaluate("window.__rc.hidden('#rc-pane-wm')")) === false, "切到「加水印」页");
    ok((await evaluate("window.__rc.hidden('#rc-pane-rec')")) === true, "「录屏」页被隐藏（互斥）");

    await evaluate("window.__rc.tab('lib')");
    await wait(150);
    ok((await evaluate("window.__rc.hidden('#rc-pane-lib')")) === false, "切到「作品库」页");

    await evaluate("window.__rc.tab('set')");
    await wait(80);
    ok((await evaluate("window.__rc.hidden('#rc-pane-set')")) === false, "切到「设置」页");
    ok((await evaluate("window.__rc.text('#rc-set-outdir')")).includes("recordings"), "设置页显示存储位置");
  }

  /* ---------------- 4. 水印编辑器 ---------------- */
  {
    await run({ ffmpeg: { found: true, path: "ffmpeg.exe" } });
    // 录屏页与加水印页各一个编辑器实例
    ok((await evaluate("window.__rc.editorCount('rec')")) === 1, "录屏页渲染了水印编辑器");
    ok((await evaluate("window.__rc.editorCount('wm')")) === 1, "加水印页渲染了水印编辑器");

    await evaluate("window.__rc.tab('wm')");
    await wait(80);

    // 切「图片」→ 文字控件隐藏、图片控件显示
    await evaluate(`window.__rc.setVal('#rc-wm-editor [data-wm="type"]', 'image')`);
    await wait(60);
    ok((await evaluate("window.__rc.hidden('#rc-wm-editor .rc-wm-text')")) === true, "选图片时隐藏文字控件");
    ok((await evaluate("window.__rc.hidden('#rc-wm-editor .rc-wm-image')")) === false, "选图片时显示图片路径控件");

    // 切回文字
    await evaluate(`window.__rc.setVal('#rc-wm-editor [data-wm="type"]', 'text')`);
    await wait(60);
    ok((await evaluate("window.__rc.hidden('#rc-wm-editor .rc-wm-text')")) === false, "选文字时显示文字控件");

    // 改文字 → 数值展示随之更新
    await evaluate(`window.__rc.setVal('#rc-wm-editor [data-wm="text"]', '测试水印')`);
    await evaluate(`window.__rc.setVal('#rc-wm-editor [data-wm="opacity"]', '0.45')`);
    await wait(60);
    ok((await evaluate("window.__rc.text('#rc-wm-editor [data-wm-out=\\'opacity\\']')")).includes("45%"), "不透明度数值展示更新");

    // 字号滑块
    await evaluate(`window.__rc.setVal('#rc-wm-editor [data-wm="sizePct"]', '8')`);
    await wait(60);
    ok((await evaluate("window.__rc.text('#rc-wm-editor [data-wm-out=\\'sizePct\\']')")).includes("8%"), "字号数值展示更新");

    // canvas 预览真的画了东西（dataURL 非空且不是全透明）
    ok((await evaluate("window.__rc.canvasDataLen('wm')")) > 100, "canvas 预览有内容");

    // 九宫格位置
    await evaluate(`window.__rc.setVal('#rc-wm-editor [data-wm="anchor"]', 'top-left')`);
    await wait(60);
    ok((await evaluate("window.__rc.val('#rc-wm-editor [data-wm=\\'anchor\\']')")) === "top-left", "可切换九宫格位置");
  }

  /* ---------------- 5. 录制流程 ---------------- */
  {
    const calls = await run({ ffmpeg: { found: true, path: "ffmpeg.exe", version: "7.1.0" } });
    await evaluate("window.__rc.tab('rec')");
    await wait(60);

    // 选自定义区域 → 出现坐标输入
    await evaluate(`window.__rc.setVal('#rc-region-mode', 'custom')`);
    await wait(60);
    ok((await evaluate("window.__rc.hidden('#rc-region-box')")) === false, "选自定义区域后显示坐标输入");
    await evaluate(`window.__rc.setVal('#rc-region-w', '1280')`);
    await evaluate(`window.__rc.setVal('#rc-region-h', '720')`);

    // 点开始录制
    await evaluate("window.__rc.clicked('#rc-rec-btn')");
    await wait(200);
    const sr = await callsOf("startRecord");
    ok(sr.length === 1, "点「开始录制」调 startRecord");
    const p = sr[0] && sr[0][0];
    ok(p && p.region && p.region.width === 1280, "录制参数带上自定义区域", JSON.stringify(p && p.region));
    ok(p && p.fps === 30, "录制参数带帧率");
    ok(p && p.encoder === "libx264", "录制参数带编码器");
    ok((await evaluate("window.__rc.text('#rc-rec-btn')")) === "停止录制", "按钮变为「停止录制」");
    ok((await evaluate("window.__rc.disabled('#rc-rec-pause')")) === false, "录制中「暂停」可用");

    // 后端推 tick → 计时器更新
    await evaluate("window.__rc.notify('record:tick', { elapsedMs: 65000, paused: false, size: 204800 })");
    await wait(60);
    ok((await evaluate("window.__rc.timer()")) === "00:01:05", "收到 tick 后计时器对齐后端", await evaluate("window.__rc.timer()"));

    // 暂停
    await evaluate("window.__rc.clicked('#rc-rec-pause')");
    await wait(120);
    const pr = await callsOf("pauseRecord");
    ok(pr.length === 1, "点「暂停」调 pauseRecord");
    ok(pr[0] && pr[0][0].paused === true, "暂停参数为 true");

    // 后端推 ended → 复位
    await evaluate("window.__rc.notify('record:ended', { ok: true, output: 'recordings/rec-1.mp4', size: 1048576, durationMs: 65000 })");
    await wait(120);
    ok((await evaluate("window.__rc.text('#rc-rec-btn')")) === "开始录制", "录制结束后按钮复位");
    ok((await evaluate("window.__rc.disabled('#rc-rec-pause')")) === true, "录制结束后「暂停」禁用");
    ok((await evaluate("window.__rc.text('#rc-rec-info')")).includes("rec-1.mp4"), "结束后显示产物路径");
  }

  /* ---------------- 5b. 区域框选（冻结截图 + 拖拽 + 偏好持久化） ---------------- */
  {
    const calls = await run({ ffmpeg: { found: true, path: "ffmpeg.exe", version: "7.1.0" } });
    await evaluate("window.__rc.tab('rec')");
    await evaluate(`window.__rc.setVal('#rc-region-mode', 'custom')`);
    await wait(60);

    // 回归护栏：面板一打开浮层必须**算出来**是不可见的。
    // （hidden 属性为 true 但被 .rc-pick{display:flex} 盖住时，用户会看到
    //   浮层常驻——只有 computed display 能抓到，属性断言抓不到）
    eq(await evaluate("window.__rc.display('#rc-pick')"), "none", "面板打开时框选浮层不显示");

    // 点「框选区域…」→ 后端要截图，浮层出现且图片就绪
    await evaluate("window.__rc.clicked('#rc-region-pick')");
    await waitFor(async () => (await evaluate("window.__rc.pickReady()")) === true, 3000, "截图就绪");
    eq(await evaluate("window.__rc.display('#rc-pick')"), "flex", "点框选后浮层以 flex 显示");
    const snap = await callsOf("screenSnapshot");
    ok(snap.length === 1, "点「框选区域…」调 screenSnapshot");
    ok((await evaluate("window.__rc.hidden('#rc-pick')")) === false, "框选浮层出现");
    eq(await evaluate("window.__rc.disabled('#rc-pick-ok')"), true, "未拖选时「使用该区域」禁用");

    // 在截图 (10,20)→(110,70) 拖一段（截图与 bounds 1:1 → 应得 100×50）
    await evaluate("window.__rc.dragPick(10, 20, 110, 70)");
    await wait(60);
    const rect = await evaluate("window.__rc.pickRect()");
    ok(rect && Math.abs(rect.width - 100) < 2 && Math.abs(rect.height - 50) < 2,
      "拖拽画出选区", JSON.stringify(rect));
    ok((await evaluate("window.__rc.disabled('#rc-pick-ok')")) === false, "选区够大后「使用该区域」可用");
    ok(String(await evaluate("window.__rc.text('#rc-pick-size')")).includes("100"), "尺寸文案显示换算结果");

    // 应用 → 写回坐标输入 + 记进偏好 + 关浮层
    await evaluate("window.__rc.clicked('#rc-pick-ok')");
    await wait(60);
    ok((await evaluate("window.__rc.hidden('#rc-pick')")) === true, "应用后浮层关闭");
    eq(await evaluate("window.__rc.val('#rc-region-x')"), "10", "框选结果写入 X");
    eq(await evaluate("window.__rc.val('#rc-region-y')"), "20", "框选结果写入 Y");
    eq(await evaluate("window.__rc.val('#rc-region-w')"), "100", "框选结果写入宽");
    eq(await evaluate("window.__rc.val('#rc-region-h')"), "50", "框选结果写入高");
    const prefs = await evaluate("window.__rcMs.store.get('prefs', null)");
    ok(prefs && prefs.region && prefs.region.width === 100, "区域存进偏好", JSON.stringify(prefs && prefs.region));
    ok(prefs && prefs.regionMode === "custom", "区域模式存进偏好");

    // 开始录制要带上框选出的区域
    await evaluate("window.__rc.clicked('#rc-rec-btn')");
    await wait(200);
    const sr = await callsOf("startRecord");
    const rp = sr.length && sr[sr.length - 1][0];
    ok(rp && rp.region && rp.region.x === 10 && rp.region.width === 100,
      "startRecord 使用框选区域", JSON.stringify(rp && rp.region));
    ok(rp && rp.showRegionFrame === true, "startRecord 带边框开关");

    // 取消路径：打开浮层 → 关闭 → 不写坐标
    await evaluate("window.__rc.notify('record:ended', { ok: true, output: 'recordings/rec-1.mp4', size: 1, durationMs: 100 })");
    await wait(80);
    await evaluate(`window.__rc.setVal('#rc-region-x', '777')`);
    await evaluate("window.__rc.clicked('#rc-region-pick')");
    await waitFor(async () => (await evaluate("window.__rc.pickReady()")) === true, 3000, "第二次截图就绪");
    await evaluate("window.__rc.clicked('[data-act=pick-cancel]')");
    await wait(60);
    ok((await evaluate("window.__rc.hidden('#rc-pick')")) === true, "「取消」关闭浮层");
    eq(await evaluate("window.__rc.display('#rc-pick')"), "none", "取消后浮层计算样式不可见");
    eq(await evaluate("window.__rc.val('#rc-region-x')"), "777", "取消不改动坐标");

    // 换一个实例启动：区域与模式应从偏好里恢复
    await run({
      ffmpeg: { found: true, path: "ffmpeg.exe", version: "7.1.0" },
      storeData: { prefs: { regionMode: "custom", region: { x: 10, y: 20, width: 100, height: 50 }, showRegionFrame: false } },
    });
    await wait(80);
    eq(await evaluate("window.__rc.val('#rc-region-mode')"), "custom", "重启后恢复区域模式");
    eq(await evaluate("window.__rc.val('#rc-region-w')"), "100", "重启后恢复区域宽");
    ok((await evaluate("window.__rc.hidden('#rc-region-box')")) === false, "重启后区域输入框可见");
    ok((await evaluate("window.__rc.checked('#rc-region-frame')")) === false, "重启后恢复边框开关");
  }

  /* ---------------- 5c. 屏幕直接框选（ms.screenshot.pickRegion） ---------------- */
  {
    // 有 pickRegion 就直接用宿主全屏遮罩：回填坐标、不再走面板截图
    await run({ ffmpeg: { found: true, path: "ffmpeg.exe", version: "7.1.0" }, pickRegion: { x: 5, y: 6, width: 320, height: 200 } });
    await evaluate("window.__rc.tab('rec')");
    await evaluate("window.__rc.clicked('#rc-region-pick')");
    await waitFor(
      async () => (await evaluate("window.__rc.val('#rc-region-w')")) === "320",
      2000,
      "屏幕框选回填"
    );
    eq(await evaluate("window.__rc.val('#rc-region-x')"), "5", "屏幕框选写入 X");
    eq(await evaluate("window.__rc.val('#rc-region-y')"), "6", "屏幕框选写入 Y");
    eq(await evaluate("window.__rc.val('#rc-region-h')"), "200", "屏幕框选写入高");
    eq(await evaluate("window.__rc.val('#rc-region-mode')"), "custom", "屏幕框选把模式切到自定义");
    eq((await callsOf("screenSnapshot")).length, 0, "有 pickRegion 时不再调面板截图");
    eq(await evaluate("window.__rc.display('#rc-pick')"), "none", "面板截图浮层全程不出现");

    // Esc 取消（返回 null）→ 坐标原样不动
    await run({ ffmpeg: { found: true, path: "ffmpeg.exe", version: "7.1.0" }, pickRegion: null });
    await evaluate("window.__rc.tab('rec')");
    await evaluate(`window.__rc.setVal('#rc-region-w', '555')`);
    await evaluate("window.__rc.clicked('#rc-region-pick')");
    await wait(150);
    eq(await evaluate("window.__rc.val('#rc-region-w')"), "555", "pickRegion 返回 null 时不改坐标");
    eq((await callsOf("screenSnapshot")).length, 0, "取消后也不调面板截图");

    // 权限未授予（reject）→ 不再静默落回面板，而是问一句；答应用户才开兜底
    await run({ ffmpeg: { found: true, path: "ffmpeg.exe", version: "7.1.0" }, pickRegion: "error", confirmAnswer: false });
    await evaluate("window.__rc.tab('rec')");
    await evaluate("window.__rc.clicked('#rc-region-pick')");
    await wait(200);
    eq((await callsOf("screenSnapshot")).length, 0, "屏幕框选失败且用户不同意时，不开面板兜底");
    ok(String(await evaluate("window.__rc.text('#rc-status')")).includes("屏幕框选不可用"), "失败原因显示在状态行");

    await run({ ffmpeg: { found: true, path: "ffmpeg.exe", version: "7.1.0" }, pickRegion: "error", confirmAnswer: true });
    await evaluate("window.__rc.tab('rec')");
    await evaluate("window.__rc.clicked('#rc-region-pick')");
    await waitFor(async () => (await evaluate("window.__rc.pickReady()")) === true, 3000, "兜底截图就绪");
    eq((await callsOf("screenSnapshot")).length, 1, "用户同意后落回面板截图");
    eq(await evaluate("window.__rc.display('#rc-pick')"), "flex", "兜底时面板浮层正常显示");
    await evaluate("window.__rc.clicked('[data-act=pick-cancel]')");
    await wait(60);
  }

  /* ---------------- 6. 加水印流程 ---------------- */
  {
    await run({ ffmpeg: { found: true, path: "ffmpeg.exe", version: "7.1.0" } });
    await evaluate("window.__rc.tab('wm')");
    await wait(60);

    await evaluate(`window.__rc.setVal('#rc-wm-input', 'D:\\\\videos\\\\a.mp4')`);
    await evaluate("window.__rc.clicked('button[data-act=\"detect\"]')");
    await wait(200);
    const dv = await callsOf("detectVideo");
    ok(dv.length === 1, "点「读取信息」调 detectVideo");
    ok(dv[0] && dv[0][0].input === "D:\\videos\\a.mp4", "把路径原样传给后端", dv[0] && dv[0][0].input);
    ok((await evaluate("window.__rc.hidden('#rc-video-meta')")) === false, "读取后显示元数据面板");
    const meta = await evaluate("window.__rc.text('#rc-video-meta')");
    ok(meta.includes("1920 × 1080"), "元数据含分辨率", meta.slice(0, 60));
    ok(meta.includes("00:01:05"), "元数据含时长（65 秒 → 00:01:05）");

    // 点开始加水印
    await evaluate("window.__rc.clicked('#rc-wm-apply')");
    await wait(250);
    const awl = await callsOf("applyWatermark");
    ok(awl.length === 1, "点「开始加水印」调 applyWatermark");
    const aw = awl[0] && awl[0][0];
    ok(aw && aw.input === "D:\\videos\\a.mp4", "转码参数带输入路径");
    ok(aw && aw.watermark && aw.watermark.enabled === true, "转码参数带启用的水印");
    ok(aw && aw.durationSec === 65, "带上时长（供进度条算百分比）");

    // 进度通知 → 进度条宽度
    await evaluate("window.__rc.notify('watermark:progress', { seconds: 32.5, durationSec: 65, percent: 50 })");
    await wait(80);
    ok((await evaluate("document.querySelector('#rc-wm-progress-fill').style.width")).startsWith("50"), "进度条随通知推进");
  }

  /* ---------------- 7. 作品库 ---------------- */
  {
    await run({ ffmpeg: { found: true, path: "ffmpeg.exe" }, recordings: makeRecordings(4) });
    await evaluate("window.__rc.tab('lib')");
    await wait(300);
    ok((await evaluate("window.__rc.libCards()")) === 4, "作品库列出 4 个文件");
    ok((await evaluate("window.__rc.hidden('#rc-lib-empty')")) === true, "有文件时不显示空态");
    ok((await evaluate("window.__rc.text('#rc-lib-count')")).includes("4"), "显示文件总数");

    const tags = await evaluate("window.__rc.libTags()");
    ok(tags.includes("录制") && tags.includes("水印"), "标签区分「录制」与「水印」", JSON.stringify(tags));
  }
  {
    await run({ ffmpeg: { found: true, path: "ffmpeg.exe" }, recordings: [] });
    await evaluate("window.__rc.tab('lib')");
    await wait(200);
    ok((await evaluate("window.__rc.libCards()")) === 0, "无文件时无卡片");
    ok((await evaluate("window.__rc.hidden('#rc-lib-empty')")) === false, "无文件时显示空态");
  }

  /* ---------------- 8. 水印预设 ---------------- */
  {
    await run({ ffmpeg: { found: true, path: "ffmpeg.exe" } });
    await evaluate("window.__rc.tab('set')");
    await wait(80);
    ok((await evaluate("window.__rc.presetRows()")) === 0, "初始无预设");

    await evaluate(`window.__rc.setVal('#rc-preset-name', '右下角署名')`);
    await evaluate("window.__rc.clicked('button[data-act=\"preset-save\"]')");
    await wait(120);
    ok((await evaluate("window.__rc.presetRows()")) === 1, "保存后预设出现在列表");
    ok((await evaluate("window.__rc.presetNames()[0]")).includes("右下角署名"), "预设名称正确");

    // 套用 → 切到加水印页
    await evaluate("window.__rc.clicked('.rc-preset-item button[data-act=\"preset-apply\"]')");
    await wait(120);
    ok((await evaluate("window.__rc.hidden('#rc-pane-wm')")) === false, "套用预设后切到加水印页");

    // 删除
    await evaluate("window.__rc.clicked('.rc-preset-item button[data-act=\"preset-del\"]')");
    await wait(120);
    ok((await evaluate("window.__rc.presetRows()")) === 0, "删除后预设列表为空");
  }

  /* ---------------- 9. 附件自动识别视频 ---------------- */
  {
    await run({
      ffmpeg: { found: true, path: "ffmpeg.exe" },
      attachments: [{ kind: "file", name: "clip.mp4", path: "D:\\clip.mp4" }],
    });
    await wait(150);
    // 启动时应静默识别附件里的视频并切到加水印页
    ok((await evaluate("window.__rc.hidden('#rc-pane-wm')")) === false, "检测到视频附件时自动切到加水印页");
    ok((await evaluate("window.__rc.val('#rc-wm-input')")) === "D:\\clip.mp4", "自动填入附件视频路径");
  }

  /* ---------------- 10. 子关键词通道 ---------------- */
  {
    await run({
      ffmpeg: { found: true, path: "ffmpeg.exe" },
      keyword: "D:\\movie.mkv",
    });
    await wait(150);
    const dv = await callsOf("detectVideo");
    ok(dv.length >= 1, "从搜索框带入视频路径时自动 detectVideo");
    ok(dv[0] && dv[0][0].input === "D:\\movie.mkv", "带入的路径原样传给后端", dv[0] && dv[0][0].input);
  }
} finally {
  try { ws?.close(); } catch {}
  try { chrome.kill(); } catch {}
  server.close();
}

console.log("");
if (fail > 0) {
  console.error(`结果: ${fail} 项失败（${pass} 通过）`);
  process.exit(1);
}
console.log(`结果: 全部通过（${pass} 项）`);
