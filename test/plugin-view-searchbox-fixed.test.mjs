/**
 * 回归测试：插件拉伸态下「输入框那一行不能被压缩」。
 *
 * 用户反馈：「调整（拖右下角改窗口大小）后会导致输入框那里的高度被压缩很小」。
 *
 * 根因（本测试守卫的契约）：
 *   `.plugin-sized` 下 #my_search_view 是 flex 竖列，#searchBox 是其 flex 项。
 *   它默认 `flex: 0 1 auto` 允许收缩，且带 `overflow: hidden` —— 按 flex 规范
 *   「非 visible 的 overflow」把自动最小尺寸从 min-content 换成 0，于是**可以被
 *   压到 0**。插件内容一旦比窗口高（异步出结果、列表增长），负剩余空间就按各
 *   flex 项基准尺寸比例分摊：输入框行基准 44px、内容区基准可能上千 px，输入框
 *   几乎被分摊掉全部收缩量（实测 44px → 2.8px，贴成一条线）。
 *
 * 断言：
 *   1. 拖拽进入拉伸态后 #searchBox 仍为设计高度 44px；
 *   2. 插件内容长高（比窗口高）后 #searchBox 仍为 44px —— 即收缩全部由内容区承担；
 *   3. 收缩确实发生了：内容区 (#text_show) 高度受限、自身成为滚动容器，
 *      而它的「底部」仍在窗口内（没有把输入框顶出去/被压）；
 *   4. 页面无未捕获异常。
 *
 * 用法: npm run build && node test/plugin-view-searchbox-fixed.test.mjs
 */
import { createServer } from "http";
import { readFile, rm } from "fs/promises";
import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
if (!existsSync(path.join(dist, "index.html"))) {
  console.error("请先 npm run build");
  process.exit(1);
}
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const server = createServer(async (req, res) => {
  try {
    const u = decodeURIComponent(req.url.split("?")[0]);
    const file = path.join(dist, u === "/" ? "/index.html" : u);
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
const userDir = path.join(root, "test", "_chrome-profile-searchbox-fixed");
await rm(userDir, { recursive: true, force: true });
const chrome = spawn(
  bin,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDir}`,
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] }
);
const wsUrl = await new Promise((resolve, reject) => {
  let buf = "";
  const t = setTimeout(() => reject(new Error("浏览器启动超时")), 20000);
  chrome.stderr.on("data", (d) => {
    buf += d.toString();
    const m = buf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (m) {
      clearTimeout(t);
      resolve(m[1]);
    }
  });
});
const ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
const pageErrors = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
  if (msg.method === "Runtime.exceptionThrown") {
    pageErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  }
};
function S(method, params = {}, sessionId) {
  return new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
  });
}
const { result: targets } = await S("Target.getTargets");
const pageTarget = targets.targetInfos.find((t) => t.type === "page");
const {
  result: { sessionId },
} = await S("Target.attachToTarget", { targetId: pageTarget.targetId, flatten: true });
await S("Runtime.enable", {}, sessionId);
await S("Page.enable", {}, sessionId);
const evalJs = async (expr) => {
  const r = await S("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.result?.exceptionDetails) {
    throw new Error(
      JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails).slice(0, 800)
    );
  }
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log("PASS ", name, extra ? ` — ${extra}` : "");
  } else {
    fail++;
    console.log("FAIL ", name, extra ? ` — ${extra}` : "");
  }
};

/* ---------------- 夹具：真实内置「文件搜索」插件 ---------------- */
const PLUGIN_ID = "com.mysearch.file-search";
const PLUGIN_DIR = path.join(root, "plugins", "file-search");
const manifest = JSON.parse(readFileSync(path.join(PLUGIN_DIR, "plugin.json"), "utf8"));
const PLUGIN_FILES = {
  [PLUGIN_ID]: {
    "ui/detail.html": readFileSync(path.join(PLUGIN_DIR, "ui", "detail.html"), "utf8"),
    "ui/detail.css": readFileSync(path.join(PLUGIN_DIR, "ui", "detail.css"), "utf8"),
    "ui/index.js": readFileSync(path.join(PLUGIN_DIR, "ui", "index.js"), "utf8"),
    "icon.svg": readFileSync(path.join(PLUGIN_DIR, "icon.svg"), "utf8"),
  },
};
const now = Date.now();
const RECORD = {
  id: PLUGIN_ID,
  name: manifest.name,
  version: manifest.version,
  apiVersion: manifest.apiVersion,
  description: manifest.description,
  manifest,
  dir: `plugins/${PLUGIN_ID}`,
  source: { kind: "builtin", ref: "builtin" },
  installedAt: now,
  updatedAt: now,
  enabled: true,
  autoStart: "on-demand",
  requestedAutoStart: "on-demand",
  closeBehavior: manifest.contributes.detailView.closeBehavior,
  grants: [
    { permission: "ui.inlay", at: now, source: "install" },
    { permission: "file.read", at: now, source: "install" },
  ],
  denied: [],
  runtime: { status: "stopped", pid: null, memoryBytes: null, startedAt: null, restarts: 0, lastError: null, keepAliveReasons: [] },
  integrity: { sha256: null, signed: false },
};

await S(
  "Page.addScriptToEvaluateOnNewDocument",
  {
    source: `
    window.__files = ${JSON.stringify(PLUGIN_FILES)};
    window.__calls = [];
    window.__TAURI_INTERNALS__ = {
      invoke(cmd, args) {
        try { window.__calls.push({ cmd, args }); } catch (e) {}
        if (cmd === 'set_window_height') return Promise.resolve(null);
        if (cmd === 'plugin:window|set_size' || cmd === 'plugin:window|set_position') {
          window.__winOps = window.__winOps || [];
          window.__winOps.push({ cmd, args });
          return Promise.resolve(null);
        }
        if (cmd === 'plugin:window|scale_factor') return Promise.resolve(1);
        if (cmd === 'plugin:window|current_monitor')
          return Promise.resolve({ name: 'Mock', scaleFactor: 1, position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 }, workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } } });
        if (cmd === 'reset_main_window_position') return new Promise((r) => setTimeout(() => r(null), 60));
        if (cmd === 'plugin_read_text') {
          const f = window.__files[args.pluginId] || {};
          const t = f[args.relPath];
          return t == null ? Promise.reject('文件不存在: ' + args.relPath) : Promise.resolve(t);
        }
        if (cmd === 'plugin_read_binary') return Promise.reject('无图标');
        if (cmd === 'plugin_backend_list') return Promise.resolve([]);
        if (cmd === 'get_default_subscribe_text') return Promise.resolve('');
        if (cmd === 'get_toggle_shortcut') return Promise.resolve('ctrl+alt+s');
        if (cmd === 'get_autostart_enabled') return Promise.resolve(false);
        if (cmd === 'plugin:event|listen' && args && args.event) {
          const list = window.__eventHandlers.get(args.event) || [];
          list.push(args.handler);
          window.__eventHandlers.set(args.event, list);
          return Promise.resolve(window.__eventNextId++);
        }
        return Promise.resolve(null);
      },
      transformCallback(cb) { const cbId = Math.random().toString(36).slice(2); window.__cbIds = window.__cbIds || {}; window.__cbIds[cbId] = cb; return cbId; },
      unregisterCallback(cbId) { delete (window.__cbIds || {})[cbId]; },
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      plugins: {},
    };
    window.__eventHandlers = new Map();
    window.__eventNextId = 1;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(){} };
    window.__emitTauriEvent = (event, payload) => {
      const list = window.__eventHandlers.get(event) || [];
      list.forEach((idOrFn) => {
        const cb = typeof idOrFn === 'function' ? idOrFn : (window.__cbIds || {})[idOrFn];
        if (typeof cb === 'function') { try { cb({ event, id: window.__eventNextId++, payload }); } catch (e) {} }
      });
      return list.length;
    };
  `,
  },
  sessionId
);

await S("Emulation.setDeviceMetricsOverride", { width: 760, height: 600, deviceScaleFactor: 1, mobile: false }, sessionId);
await S("Page.navigate", { url: base + "/index.html" }, sessionId);
await sleep(600);
await evalJs(`
  (() => {
    localStorage.clear();
    localStorage.setItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY', JSON.stringify({ version: 1, plugins: ${JSON.stringify([RECORD])} }));
    localStorage.setItem('my-search-desktop:SEARCH_DATA_KEY', JSON.stringify({ data: [], expire: Date.now() + 3600 * 1000 }));
    return 1;
  })()`);
await S("Page.navigate", { url: base + "/index.html" }, sessionId);
await sleep(1500);

/* ================= 打开插件 ================= */
await evalJs(`
  (() => {
    const el = document.getElementById('my_search_input');
    el.focus(); el.value = '文件搜索';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })(); 1`);
await sleep(800);
await evalJs(`
  (() => {
    const el = document.getElementById('my_search_input');
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  })(); 1`);
await sleep(1500);

const probe = () =>
  evalJs(`JSON.stringify((() => {
    const box = document.getElementById('my_search_box');
    const sb = document.getElementById('searchBox');
    const view = document.getElementById('my_search_view');
    const ts = document.getElementById('text_show');
    const pv = document.querySelector('#text_show .plugin-view');
    const tall = document.getElementById('__tall_probe');
    const h = (el) => el ? +el.getBoundingClientRect().height.toFixed(1) : null;
    return {
      innerH: window.innerHeight,
      viewH: h(view), searchBoxH: h(sb), textShowH: h(ts), pluginViewH: h(pv), boxH: h(box),
      tallH: h(tall),
      viewDisplay: view ? getComputedStyle(view).display : null,
      sbFlex: sb ? getComputedStyle(sb).flex : null,
      tsOverflowY: ts ? getComputedStyle(ts).overflowY : null,
      sized: box ? box.classList.contains('plugin-sized') : null,
      boxVar: box ? box.style.getPropertyValue('--plugin-view-height') : null,
    };
  })())`);

const opened = JSON.parse(await probe());
check("插件视图已打开", opened.pluginViewH != null && opened.pluginViewH > 0, `pluginViewH=${opened.pluginViewH}`);
check("打开时（常态）输入框行 = 44px", opened.searchBoxH === 44, `searchBoxH=${opened.searchBoxH}`);

/* ================= 拖手柄进入拉伸态 ================= */
const drag = JSON.parse(await evalJs(`JSON.stringify((() => {
  const handle = document.querySelector('.plugin-resize-handle');
  const r = handle.getBoundingClientRect();
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  window.__winOps = [];
  handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 }));
  document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: cx + 10, clientY: cy + 20 }));
  return { cx, cy };
})())`));
await sleep(150);
await evalJs(`document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: ${drag.cx + 10}, clientY: ${drag.cy + 20} })); 1`);
await sleep(200);

// 让「窗口尺寸」落地 = 视口更新（真实环境 setSize 后视口才跟上）
const target = JSON.parse(await evalJs(`JSON.stringify((() => {
  const ops = (window.__winOps || []).filter((o) => o.cmd === 'plugin:window|set_size');
  const last = ops.length ? ops[ops.length - 1] : null;
  return { size: last ? last.args.value.Logical : null };
})())`));
if (target.size) {
  await S(
    "Emulation.setDeviceMetricsOverride",
    { width: Math.round(target.size.width), height: Math.round(target.size.height), deviceScaleFactor: 1, mobile: false },
    sessionId
  );
}
await sleep(250);
const sized = JSON.parse(await probe());
check("拖拽后进入拉伸态", sized.sized === true && sized.viewDisplay === "flex", `sized=${sized.sized} viewDisplay=${sized.viewDisplay}`);
check("拉伸态下 #searchBox 不可收缩（flex: 0 0 auto）", sized.sbFlex === "0 0 auto", `sbFlex=${sized.sbFlex}`);
check("拉伸态下输入框行仍 = 44px", sized.searchBoxH === 44, `searchBoxH=${sized.searchBoxH}`);

/* ================= 关键回归：插件内容长高（比窗口高） =================
 * 修复前：#searchBox 作为可收缩 flex 项被分摊走绝大部分收缩量 → 44px 掉到 ~3px。
 * 修复后：#searchBox 钉死 44px，收缩全部由内容区承担。 */
await evalJs(`
  (() => {
    const pv = document.querySelector('#text_show .plugin-view');
    const tall = document.createElement('div');
    tall.id = '__tall_probe';
    tall.style.cssText = 'height:2000px;flex:0 0 auto';
    pv.appendChild(tall);
    return 1;
  })()`);
await sleep(300);
const taller = JSON.parse(await probe());

check(
  "内容比窗口高时输入框行仍 = 44px（未被压缩 —— 本回归的核心）",
  taller.searchBoxH === 44,
  `searchBoxH=${taller.searchBoxH}（修复前为 ~2.8）`
);
check(
  "注入的高内容（2000px）没有把窗口/视图撑高 —— 溢出被内容区裁剪",
  taller.tallH === 2000 && taller.pluginViewH != null && taller.pluginViewH < 200,
  `tallH=${taller.tallH} pluginViewH=${taller.pluginViewH}（视图高度保持窗口内）`
);
check(
  "拉伸态内容区自身不滚动（overflow:hidden，滚动下放给插件）",
  taller.tsOverflowY === "hidden",
  `textShowOverflowY=${taller.tsOverflowY}`
);
check(
  "窗口高度未被内容撑高（仍是拉伸态的下发尺寸）",
  taller.boxH != null && taller.boxVar !== "" && Math.abs(taller.boxH - parseFloat(taller.boxVar)) <= 2,
  `boxH=${taller.boxH} var=${taller.boxVar}`
);
check(
  "输入框行 + 内容区 ≈ 盒子高度（无多余空隙/重叠）",
  Math.abs((taller.searchBoxH || 0) + (taller.textShowH || 0) - (taller.boxH || 0)) <= 6,
  `sb=${taller.searchBoxH} ts=${taller.textShowH} box=${taller.boxH}`
);

check("页面无未捕获异常", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 400));

console.log(`\n结果: ${pass} passed, ${fail} failed`);
server.close();
chrome.kill();
process.exit(fail === 0 ? 0 : 1);
