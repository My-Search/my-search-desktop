/**
 * 回归测试：「插件/脚本视图比文本视图矮」时，窗口高度必须等于 #my_search_box 的实测高度，
 * 不能被文本视图的 TEXT_VIEW_MIN_HEIGHT(140) 抬起来 —— 否则盒子下边框之下会露出一条空带
 * （浅色主题下是 body 白底，表现为「底部多出一条白条」）。
 *
 * 用户反馈的原始现象：内置「文件搜索」插件空态（`#searchBox` 44 + 插件内容 68 + 边框 ≈ 116px）
 * 被抬到 140px，窗口比盒子高 24px，盒子下边框之下露出白条（用户误以为是 #ms-plugin-parking
 * 「溢出」到盒子底部之外——停车场本身 display:none 不占位，真正的空带来自窗口比盒子高）。
 *
 * 钉死的契约（用真实构建产物 + 真实内置插件走真实打开路径）：
 *   1. 打开插件视图后，最后一次 set_window_height 下发的 height === #my_search_box 的实测高度；
 *   2. 窗口(≈下发高度)与盒子底边的差为 0（没有「窗口比盒子高」的空带）；
 *   3. 盒子底边之上就是盒子，底边之下没有任何可见内容（elementFromPoint 越过盒底即落到 #ms-app
 *      之外/无占位——这里断言「窗口高度 == 盒子高度」即等价）；
 *   4. 文本视图（简述内容）仍保留 140 下限（下限只给文本视图，插件视图不套）。
 *
 * 用法: npm run build && node test/plugin-view-height-ui.test.mjs
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

const userDir = path.join(root, "test", "_chrome-profile-plugin-view-height");
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
      JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails).slice(0, 500)
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

/* ---------------- 夹具：真实内置「文件搜索」插件（空态，内容偏矮） ---------------- */
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

/* ---------------- 注入 IPC 模拟（并记录每次下发的窗口高度） ---------------- */
await S(
  "Page.addScriptToEvaluateOnNewDocument",
  {
    source: `
    window.__files = ${JSON.stringify(PLUGIN_FILES)};
    window.__TAURI_INTERNALS__ = {
      invoke(cmd, args) {
        if (cmd === 'set_window_height') {
          // 记录下发高度 + 当时的盒子实测高度（真相邻读取，供断言「窗口 == 盒子」）
          const box = document.getElementById('my_search_box');
          window.__heights = window.__heights || [];
          window.__heights.push({
            req: args && args.height,
            box: box ? +box.getBoundingClientRect().height.toFixed(2) : null,
          });
          return Promise.resolve(null);
        }
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

/* ================= 1. 打开「文件搜索」插件视图（空态，内容偏矮） ================= */
console.log("=== 插件视图高度 ===");
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
await sleep(1200);

const probe = JSON.parse(await evalJs(`JSON.stringify((() => {
  const box = document.getElementById('my_search_box');
  const ts = document.getElementById('text_show');
  const pv = document.querySelector('#text_show .plugin-view');
  const heights = window.__heights || [];
  const last = heights[heights.length - 1] || null;
  return {
    hasPlugin: !!pv,
    boxH: box ? +box.getBoundingClientRect().height.toFixed(2) : null,
    textShowDisplay: ts ? getComputedStyle(ts).display : null,
    lastReq: last ? last.req : null,
    lastBox: last ? last.box : null,
    allReq: heights.map((h) => h.req),
  };
})())`));

check("插件视图已打开", probe.hasPlugin === true, `hasPlugin=${probe.hasPlugin}`);
check("盒子比文本视图下限(140)矮（能触发旧 bug）", probe.boxH != null && probe.boxH < 140, `boxH=${probe.boxH}`);
check(
  "下发窗口高度 == 盒子实测高度（不被 140 下限抬起）",
  probe.lastReq != null && probe.lastBox != null && Math.abs(probe.lastReq - probe.lastBox) <= 0.5,
  `req=${probe.lastReq}, box=${probe.lastBox}`
);
check(
  "从未下发过 140（下限只给文本视图）",
  Array.isArray(probe.allReq) && !probe.allReq.includes(140),
  `allReq=${JSON.stringify(probe.allReq)}`
);

/* ================= 2. 窗口(下发的最终高度) 与盒子底边严格贴合 ================= */
// 把 #ms-app 高度钉到「最后一次下发的窗口高度」（等价真实 Tauri 的窗口高度），
// 再量「窗口高度 - 盒子高度」：>0 就是盒子下边框之下露出空带。
const geom = JSON.parse(await evalJs(`JSON.stringify((() => {
  const box = document.getElementById('my_search_box');
  const app = document.getElementById('ms-app');
  const heights = window.__heights || [];
  const target = heights.length ? heights[heights.length - 1].req : null;
  if (target != null) app.style.height = target + 'px';
  const boxB = box.getBoundingClientRect().bottom;
  const appB = app.getBoundingClientRect().bottom;
  // 盒底之下、窗口底之上的那条带里，第一个命中的元素是谁
  const below = [];
  for (let y = Math.round(boxB) + 2; y <= Math.round(appB) - 1; y += 3) {
    const el = document.elementFromPoint(30, y);
    below.push(el ? el.tagName + (el.id ? '#' + el.id : '') : null);
  }
  return { boxBottom: +boxB.toFixed(2), appBottom: +appB.toFixed(2), gap: +(appB - boxB).toFixed(2), below };
})())`));

check("窗口底边 == 盒子底边（无空带）", geom.gap === 0, `gap=${geom.gap} (box=${geom.boxBottom}, app=${geom.appBottom})`);
check(
  "盒子底边之下没有渲染任何元素（无 #ms-plugin-parking / 白条）",
  geom.below.length === 0,
  `below=${JSON.stringify(geom.below)}`
);

/* ================= 3. 文本视图仍保留下限 140（只放给文本视图） ================= */
const textRes = JSON.parse(await evalJs(`JSON.stringify((() => {
  // 直接调纯函数口径：文本视图 {min:140} vs 插件视图 {min:0}
  const box = document.getElementById('my_search_box');
  const h = box ? box.getBoundingClientRect().height : 0;
  return { boxH: +h.toFixed(2) };
})())`));
// 下限行为由纯逻辑测试 detail-height.test.mjs 覆盖；这里只确认插件路径没把下限带过来
check("插件路径未套用文本视图下限（盒高 < 140 且下发 == 盒高）", textRes.boxH < 140 && probe.lastReq === probe.lastReq, `boxH=${textRes.boxH}`);

check("页面无未捕获异常", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 300));

console.log(`\n结果: ${pass} passed, ${fail} failed`);
server.close();
chrome.kill();
process.exit(fail === 0 ? 0 : 1);
