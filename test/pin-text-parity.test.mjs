/**
 * 贴图 vs 截图：文字标注行为一致性对比测试。
 *
 * 背景：贴图编辑与截图标注共用同一套引擎（annotation.ts），但宿主是两个页面。
 * 「文字标注行为一致」必须钉死：同样的文字、同样的默认线宽、同样的点击位置，
 * 两边画出来的文字必须——
 *   1. 起点都在点击处（ink 包围盒左上 ≈ 点击的画布坐标）；
 *   2. 字号一致（ink 包围盒高度一致）；
 *   3. 文字宽度一致（ink 包围盒宽度一致）。
 *
 * 做法：同一台浏览器开两个页面（overlay.html 与 pin.html?w=400&h=300），
 * 各自走一遍「文字工具 → 点击画布 (80,80) → 输入『测试文字』→ 回车」，
 * 读两边红色文字像素的包围盒逐项对比。任何一边行为漂移（字号公式、基线
 * 对齐、落点换算）都会让两侧包围盒对不上。
 *
 * 用法: npm run build && node test/pin-text-parity.test.mjs
 * 需要本机装有 Chrome / Edge；找不到浏览器时跳过（退出码 0）。
 */
import { createServer } from "http";
import { readFile, rm } from "fs/promises";
import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
if (!existsSync(path.join(dist, "pin.html")) || !existsSync(path.join(dist, "overlay.html"))) {
  console.error("缺少 dist/pin.html 或 dist/overlay.html：请先 npm run build");
  process.exit(1);
}

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

/* ===================== 静态服务器 ===================== */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};
const server = createServer(async (req, res) => {
  try {
    const u = decodeURIComponent(req.url.split("?")[0]);
    const file = path.join(dist, u === "/" ? "/pin.html" : u);
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
  console.log("未找到浏览器（Chrome/Edge），跳过贴图文字一致性测试");
  server.close();
  process.exit(0);
}

/* ===================== 轻量 CDP 封装（一个浏览器一个页面） ===================== */

async function openPage(url, inject, windowSize, portSeed, extraArgs = []) {
  const userDir = path.join(root, "test", `_chrome-profile-parity-${portSeed}-${process.pid}`);
  const port = portSeed + Math.floor(Math.random() * 50);
  const chrome = spawn(
    bin,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDir}`,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-sync",
      `--window-size=${windowSize}`,
      ...extraArgs,
      url,
    ],
    { stdio: "ignore" }
  );
  let ws;
  let msgId = 0;
  const pending = new Map();
  const pageErrors = [];

  async function target() {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/list`);
        const list = await r.json();
        const page = list.find(
          (t) => t.type === "page" && t.webSocketDebuggerUrl && String(t.url).includes("127.0.0.1")
        );
        if (page) return page;
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("浏览器 CDP 未就绪");
  }

  const target0 = await target();
  ws = new WebSocket(target0.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("WebSocket 连接失败"));
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === "Runtime.exceptionThrown") {
      pageErrors.push(String(m.params.exceptionDetails.exception?.description || "").slice(0, 300));
    }
    if (m.id != null && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(JSON.stringify(m.error)));
      else resolve(m.result);
    }
  };
  const send = (method, params) => {
    const id = ++msgId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  };
  const evaluate = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error("页面求值异常: " + JSON.stringify(r.exceptionDetails.exception?.description || ""));
    }
    return r.result.value;
  };
  await send("Runtime.enable");
  await send("Page.enable");
  if (inject) await send("Page.addScriptToEvaluateOnNewDocument", { source: inject });
  await send("Page.reload");
  await new Promise((r) => setTimeout(r, 800));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  return {
    send,
    evaluate,
    sleep,
    pageErrors,
    close: async () => {
      try {
        chrome.kill();
      } catch {}
      await sleep(300);
      await rm(userDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/* ===================== overlay 宿主 stub（精简自 screenshot-overlay-ui.test.mjs） ===================== */

const OV_INJECT = `
(() => {
  const STRIPE = [40, 120, 200];
  const SCREEN = (() => {
    const c = document.createElement('canvas');
    c.width = window.innerWidth; c.height = window.innerHeight;
    const ctx = c.getContext('2d');
    for (let x = 0; x < c.width; x++) { ctx.fillStyle = 'rgb(0,' + STRIPE[x % 3] + ',0)'; ctx.fillRect(x, 0, 1, c.height); }
    return c;
  })();
  const cropFrom = (x, y, w, h, sf) => {
    const k = sf || 1;
    const sx = Math.max(0, Math.min(SCREEN.width, Math.round(x * k)));
    const sy = Math.max(0, Math.min(SCREEN.height, Math.round(y * k)));
    const sw = Math.max(1, Math.min(SCREEN.width - sx, Math.round(w * k)));
    const sh = Math.max(1, Math.min(SCREEN.height - sy, Math.round(h * k)));
    const c = document.createElement('canvas');
    c.width = sw; c.height = sh;
    c.getContext('2d').drawImage(SCREEN, sx, sy, sw, sh, 0, 0, sw, sh);
    return c.toDataURL('image/png');
  };
  window.__invoked = [];
  window.__TAURI_INTERNALS__ = {
    invoke(cmd, args) {
      window.__invoked.push(cmd);
      if (cmd === 'plugin:window|scale_factor') return Promise.resolve(1);
      if (cmd === 'screenshot_overlay_image') {
        return Promise.resolve({
          dataUrl: SCREEN.toDataURL('image/png'),
          width: SCREEN.width, height: SCREEN.height,
          monitor: { index: 0, x: 0, y: 0, width: window.innerWidth, height: window.innerHeight, scaleFactor: 1, isPrimary: true },
          monitorCount: 1, originX: 0, originY: 0,
        });
      }
      if (cmd === 'screenshot_crop') {
        const x = Math.round((args && args.x) || 0), y = Math.round((args && args.y) || 0);
        const w = Math.max(1, Math.round((args && args.width) || 10)), h = Math.max(1, Math.round((args && args.height) || 10));
        window.__lastCrop = { x, y, w, h };
        return Promise.resolve({ dataUrl: cropFrom(x, y, w, h, 1), width: w, height: h, screenX: x, screenY: y });
      }
      if (cmd === 'screenshot_selection_image') {
        const s = window.__lastCrop || { x: 0, y: 0, w: 10, h: 10 };
        return Promise.resolve({ dataUrl: cropFrom(s.x, s.y, s.w, s.h, 1), width: s.w, height: s.h });
      }
      return Promise.resolve(null);
    },
    transformCallback(cb) { return cb; },
    metadata: { currentWindow: { label: 'overlay-0' }, currentWebview: { label: 'overlay-0' } },
    plugins: {},
  };
  window.__ov = {
    drag: (target, x1, y1, x2, y2) => {
      const el = typeof target === 'string' ? document.querySelector(target) : target;
      if (!el) throw new Error('no element ' + target);
      const at = (x, y, type) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, buttons: type === 'mouseup' ? 0 : 1 }));
      at(x1, y1, 'mousedown');
      for (let i = 1; i <= 4; i++) at(x1 + (x2 - x1) * i / 4, y1 + (y2 - x1 === 0 ? 0 : (y2 - y1) * i / 4), 'mousemove');
      at(x2, y2, 'mouseup');
    },
    clickSel: (sel) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error('no element ' + sel);
      el.click();
    },
    /** 红色像素包围盒（画布内坐标） */
    redBox: () => {
      const c = document.querySelector('canvas.ov-canvas');
      if (!c) return null;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        if (d[i + 3] > 0 && d[i] > 180 && d[i + 1] < 140 && d[i + 2] < 140) {
          n++; if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y;
        }
      }
      return n > 0 ? { n, minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY } : { n: 0 };
    },
  };
})();
`;

/* ===================== pin 宿主 stub（精简自 pin-window-behavior.test.mjs） ===================== */

const PIN_INJECT = `
(() => {
  const mkImage = (w, h) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    for (let y = 0; y < h; y += 8) for (let x = 0; x < w; x += 8) {
      ctx.fillStyle = ((x / 8 + y / 8) % 2 === 0) ? 'rgb(0,180,0)' : 'rgb(255,255,255)';
      ctx.fillRect(x, y, 8, 8);
    }
    return c.toDataURL('image/png');
  };
  const params = new URLSearchParams(location.search);
  // 默认按「真实贴图窗口」造图：窗口物理尺寸 = 图片自然像素，CSS 视口 = 物理 / DPR。
  // 测试里浏览器视口由 --window-size 决定，把图片取成 innerWidth * DPR 才能让
  // canvas 的 CSS 尺寸（100% 视口）与物理尺寸之比恰好等于 DPR，复现真机链路。
  const DPR = window.devicePixelRatio || 1;
  const W = Number(params.get('w')) || Math.round(window.innerWidth * DPR);
  const H = Number(params.get('h')) || Math.round(window.innerHeight * DPR);
  window.__TAURI_INTERNALS__ = {
    invoke(cmd, args) {
      if (cmd === 'pin_image_data') return Promise.resolve({ dataUrl: mkImage(W, H), width: W, height: H, label: '' });
      if (cmd === 'pin_close' || cmd === 'pin_cleanup') return Promise.resolve(null);
      if (cmd === 'pin_set_bounds') return Promise.resolve(null);
      if (cmd === 'plugin:window|scale_factor') return Promise.resolve(1);
      if (cmd === 'plugin:window|outer_position') return Promise.resolve({ x: 120, y: 80 });
      if (cmd === 'plugin:window|current_monitor') {
        return Promise.resolve({ name: 'test', scaleFactor: 1, position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 }, workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } } });
      }
      if (cmd === 'plugin:window|start_dragging') return Promise.resolve(null);
      return Promise.resolve(null);
    },
    transformCallback(cb) { return cb; },
    metadata: { currentWindow: { label: 'pin-test-1' }, currentWebview: { label: 'pin-test-1' } },
    plugins: {},
  };
  window.__pin = {
    canvas: () => document.querySelector('canvas.pin-canvas'),
    contextMenu: (x, y) => {
      const root = document.querySelector('.pin-root');
      root.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    },
    clickMenu: (text) => {
      const btn = [...document.querySelectorAll('.pm-item')].find((b) => b.textContent.trim() === text);
      if (!btn) throw new Error('no menu item ' + text);
      btn.click();
    },
    clickTool: (title) => {
      const btn = [...document.querySelectorAll('.pin-toolbar .ov-tool')].find((b) => b.title === title);
      if (!btn) throw new Error('no tool ' + title);
      btn.click();
    },
    drag: (x1, y1, x2, y2) => {
      const c = document.querySelector('canvas.pin-canvas');
      if (!c) throw new Error('no canvas');
      const at = (x, y, type) => c.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, buttons: type === 'mouseup' ? 0 : 1 }));
      at(x1, y1, 'mousedown');
      for (let i = 1; i <= 4; i++) at(x1 + (x2 - x1) * i / 4, y1 + (y2 - y1) * i / 4, 'mousemove');
      at(x2, y2, 'mouseup');
    },
    /** 红色像素包围盒（画布内坐标） */
    redBox: () => {
      const c = document.querySelector('canvas.pin-canvas');
      if (!c) return null;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        if (d[i + 3] > 0 && d[i] > 180 && d[i + 1] < 140 && d[i + 2] < 140) {
          n++; if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y;
        }
      }
      return n > 0 ? { n, minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY } : { n: 0 };
    },
  };
})();
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TEXT = "测试文字";
const CLICK = 80; // 两边都在画布内 (80,80) 点击（sf=1：画布坐标 = CSS 坐标）

/* ===================== Phase A：截图侧（overlay） ===================== */

const ov = await openPage(`${base}/overlay.html?monitor=0`, OV_INJECT, "1280,800", 9750);
await sleep(600);
// 拉一个 400×300 选区（窗口 (200,150)→(600,450)），画布内点击点 = (80,80)
await ov.evaluate("window.__ov.drag('.ov-root', 200, 150, 600, 450)");
await sleep(300);
await ov.evaluate("window.__ov.clickSel('.ov-tool[title=\"文字\"]')");
await ov.evaluate("window.__ov.drag('.ov-sel', 280, 230, 280, 230)");
await sleep(250);
const ovBoxOpen = await ov.evaluate("!!document.querySelector('.ov-text-input')");
ok(ovBoxOpen, "截图侧：文字工具点选区弹出输入框");
const ovDiag = await ov.evaluate(`(() => {
  const c = document.querySelector('canvas.ov-canvas');
  const r = c.getBoundingClientRect();
  const t = document.querySelector('.ov-text-input');
  const cs = t ? getComputedStyle(t) : null;
  const tr = t ? t.getBoundingClientRect() : null;
  return {
    canvasPx: [c.width, c.height], canvasCss: [r.width, r.height], rect: [r.left, r.top],
    dpr: window.devicePixelRatio,
    boxFont: cs ? cs.fontSize : null, boxLh: cs ? cs.lineHeight : null,
    boxPos: tr ? [tr.left, tr.top] : null,
    // 首字 = input 内容盒左上角，换算到画布内坐标后应等于点击处 (80,80)
    firstChar: tr ? [
      tr.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft) - r.left,
      tr.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop) - r.top,
    ] : null,
  };
})()`);
console.log("截图诊断:", JSON.stringify(ovDiag));
ok(
  !!ovDiag.firstChar && Math.abs(ovDiag.firstChar[0] - CLICK) <= 2 && Math.abs(ovDiag.firstChar[1] - CLICK) <= 2,
  "截图侧：输入框首字落在点击处 (80,80)",
  ovDiag.firstChar ? `(${ovDiag.firstChar.map((n) => n.toFixed(1)).join(",")})` : "-"
);
await ov.evaluate(`(() => {
  const input = document.querySelector('.ov-text-input');
  input.value = '${TEXT}';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
})()`);
await sleep(300);
const ovBox = await ov.evaluate("window.__ov.redBox()");
ok(ovBox && ovBox.n > 0, "截图侧：文字画到画布上", ovBox ? `${ovBox.n} px` : "-");

// 行为一致性：输入框开着时点画布别处 → 先把草稿落笔，再在新点击处继续输入
// （而不是把这一下吞掉）。截图侧是基准，贴图侧必须同样。
const ovInkBeforeDismiss = await ov.evaluate("window.__ov.redBox()");
await ov.evaluate("window.__ov.drag('.ov-sel', 360, 270, 360, 270)"); // 画布内 (160,120)
await sleep(200);
await ov.evaluate(`(() => {
  const input = document.querySelector('.ov-text-input');
  input.value = '继续';
  input.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await ov.evaluate("window.__ov.drag('.ov-sel', 260, 290, 260, 290)"); // 画布内 (60,140)
await sleep(250);
const ovReopen = await ov.evaluate(`(() => {
  const t = document.querySelector('.ov-text-input');
  const c = document.querySelector('canvas.ov-canvas');
  if (!t || !c) return null;
  const r = c.getBoundingClientRect(), tr = t.getBoundingClientRect(), cs = getComputedStyle(t);
  return [
    tr.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft) - r.left,
    tr.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop) - r.top,
  ];
})()`);
const ovInkAfterDismiss = await ov.evaluate("window.__ov.redBox()");
ok(
  !!ovReopen && Math.abs(ovReopen[0] - 60) <= 2.5 && Math.abs(ovReopen[1] - 140) <= 2.5,
  "截图侧：输入框开着点别处 → 新输入框跟着新点击处 (60,140)",
  ovReopen ? `(${ovReopen.map((n) => n.toFixed(1)).join(",")})` : "-"
);
ok(
  !!(ovInkBeforeDismiss && ovInkAfterDismiss) && ovInkAfterDismiss.n > ovInkBeforeDismiss.n,
  "截图侧：点别处前把草稿落笔（像素增加）",
  ovInkBeforeDismiss && ovInkAfterDismiss ? `${ovInkBeforeDismiss.n} → ${ovInkAfterDismiss.n}` : "-"
);
// Esc 在输入框里只取消这一条文字，不能继续冒泡到窗口把整个截图关掉
await ov.evaluate(`(() => {
  const input = document.querySelector('.ov-text-input');
  if (input) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
})()`);
await sleep(150);
const ovEsc = await ov.evaluate(`({
  open: !!document.querySelector('.ov-text-input'),
  closeCalls: window.__invoked.filter((c) => c === 'screenshot_close_overlay').length,
})`);
ok(
  !ovEsc.open && ovEsc.closeCalls === 0,
  "截图侧：Esc 只取消文字输入，不连带关闭截图",
  JSON.stringify(ovEsc)
);
await ov.close();

/* ===================== Phase B：贴图侧（pin） ===================== */

// 贴图底图按真实贴图窗口造：图片自然像素 = 窗口物理尺寸（见 PIN_INJECT），
// 因此画布 CSS 尺寸 = 视口 CSS 尺寸、画布坐标 = CSS 坐标，点击点同为 (80,80)
const pin = await openPage(`${base}/pin.html`, PIN_INJECT, "900,700", 9850);
await sleep(600);
await pin.evaluate("window.__pin.contextMenu(200, 150)");
await sleep(150);
await pin.evaluate("window.__pin.clickMenu('显示编辑工具')");
await sleep(200);
await pin.evaluate("window.__pin.clickTool('文字')");
await pin.evaluate("window.__pin.drag(80, 80, 80, 80)");
await sleep(250);
const pinBoxOpen = await pin.evaluate("!!document.querySelector('.pin-text-input')");
ok(pinBoxOpen, "贴图侧：文字工具点画布弹出输入框");
// 诊断：画布几何 + 输入框样式（定位「所见非所得」的坐标/字号链路）
const pinDiag = await pin.evaluate(`(() => {
  const c = document.querySelector('canvas.pin-canvas');
  const r = c.getBoundingClientRect();
  const t = document.querySelector('.pin-text-input');
  const cs = t ? getComputedStyle(t) : null;
  const tr = t ? t.getBoundingClientRect() : null;
  return {
    canvasPx: [c.width, c.height], canvasCss: [r.width, r.height], rect: [r.left, r.top],
    dpr: window.devicePixelRatio, win: [window.innerWidth, window.innerHeight],
    boxFont: cs ? cs.fontSize : null, boxLh: cs ? cs.lineHeight : null,
    boxPos: tr ? [tr.left, tr.top] : null,
    firstChar: tr ? [
      tr.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft) - r.left,
      tr.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop) - r.top,
    ] : null,
  };
})()`);
console.log("贴图诊断:", JSON.stringify(pinDiag));
ok(
  !!pinDiag.firstChar && Math.abs(pinDiag.firstChar[0] - CLICK) <= 2 && Math.abs(pinDiag.firstChar[1] - CLICK) <= 2,
  "贴图侧：输入框首字落在点击处 (80,80)",
  pinDiag.firstChar ? `(${pinDiag.firstChar.map((n) => n.toFixed(1)).join(",")})` : "-"
);
await pin.evaluate(`(() => {
  const t = document.querySelector('.pin-text-input');
  t.value = '${TEXT}';
  t.dispatchEvent(new Event('input', { bubbles: true }));
  t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
})()`);
await sleep(300);
const pinBox = await pin.evaluate("window.__pin.redBox()");
ok(pinBox && pinBox.n > 0, "贴图侧：文字画到画布上", pinBox ? `${pinBox.n} px` : "-");

// 行为一致性：输入框开着时点画布别处 → 先落笔、再在新点击处继续输入
const pinInkBeforeDismiss = await pin.evaluate("window.__pin.redBox()");
await pin.evaluate("window.__pin.drag(160, 120, 160, 120)");
await sleep(200);
await pin.evaluate(`(() => {
  const t = document.querySelector('.pin-text-input');
  t.value = '继续';
  t.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await pin.evaluate("window.__pin.drag(60, 140, 60, 140)");
await sleep(250);
const pinReopen = await pin.evaluate(`(() => {
  const t = document.querySelector('.pin-text-input');
  const c = document.querySelector('canvas.pin-canvas');
  if (!t || !c) return null;
  const r = c.getBoundingClientRect(), tr = t.getBoundingClientRect(), cs = getComputedStyle(t);
  return [
    tr.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft) - r.left,
    tr.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop) - r.top,
  ];
})()`);
const pinInkAfterDismiss = await pin.evaluate("window.__pin.redBox()");
ok(
  !!pinReopen && Math.abs(pinReopen[0] - 60) <= 2 && Math.abs(pinReopen[1] - 140) <= 2,
  "贴图侧：输入框开着点别处 → 新输入框跟着新点击处 (60,140)",
  pinReopen ? `(${pinReopen.map((n) => n.toFixed(1)).join(",")})` : "-"
);
ok(
  !!(pinInkBeforeDismiss && pinInkAfterDismiss) && pinInkAfterDismiss.n > pinInkBeforeDismiss.n,
  "贴图侧：点别处前把草稿落笔（像素增加）",
  pinInkBeforeDismiss && pinInkAfterDismiss ? `${pinInkBeforeDismiss.n} → ${pinInkAfterDismiss.n}` : "-"
);
// Esc 在输入框里只取消这一条文字，不能继续冒泡到窗口退出整个编辑态
await pin.evaluate(`(() => {
  const input = document.querySelector('.pin-text-input');
  if (input) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
})()`);
await sleep(150);
const pinEsc = await pin.evaluate(`({
  open: !!document.querySelector('.pin-text-input'),
  editing: !!document.querySelector('.pin-toolbar'),
})`);
ok(
  !pinEsc.open && pinEsc.editing,
  "贴图侧：Esc 只取消文字输入，不退出编辑态",
  JSON.stringify(pinEsc)
);
await pin.close();

/* ===================== Phase C：贴图 HiDPI（125%）宿主对齐 =====================
 * 真机常见 125%/150% 缩放。引擎笔画/字号以 CSS 像素存储，画布按
 * 物理/CSS 的比例放大绘制；输入框与选中框活在 CSS 像素里，**不能再乘
 * 一次「CSS/物理」比例**。这里回归：输入框字号/首字位置、落笔起点、
 * 选中框都必须落在屏幕 CSS 坐标里应有的位置。 */

const hidpi = await openPage(`${base}/pin.html`, PIN_INJECT, "900,700", 9950, [
  "--force-device-scale-factor=1.25",
]);
await sleep(600);
await hidpi.evaluate("window.__pin.contextMenu(200, 150)");
await sleep(150);
await hidpi.evaluate("window.__pin.clickMenu('显示编辑工具')");
await sleep(200);
await hidpi.evaluate("window.__pin.clickTool('文字')");
await hidpi.evaluate("window.__pin.drag(80, 80, 80, 80)");
await sleep(250);
const hidpiDiag = await hidpi.evaluate(`(() => {
  const c = document.querySelector('canvas.pin-canvas');
  const r = c.getBoundingClientRect();
  const t = document.querySelector('.pin-text-input');
  if (!t) return null;
  const tr = t.getBoundingClientRect();
  const cs = getComputedStyle(t);
  return {
    dpr: window.devicePixelRatio,
    canvasPx: [c.width, c.height], canvasCss: [r.width, r.height], canvasRect: [r.left, r.top],
    font: parseFloat(cs.fontSize), lineHeight: cs.lineHeight,
    firstChar: [
      tr.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft),
      tr.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop),
    ],
  };
})()`);
console.log("贴图 HiDPI 诊断:", JSON.stringify(hidpiDiag));
ok(!!hidpiDiag, "HiDPI：文字工具弹出输入框");
ok(!!hidpiDiag && Math.abs(hidpiDiag.dpr - 1.25) < 0.01, "HiDPI：DPR=1.25 环境生效", hidpiDiag ? String(hidpiDiag.dpr) : "-");
ok(
  !!hidpiDiag && Math.abs(hidpiDiag.canvasPx[0] / hidpiDiag.canvasCss[0] - hidpiDiag.dpr) < 0.02,
  "HiDPI：画布物理/CSS 比例 = DPR（引擎按此比例放大绘制）",
  hidpiDiag ? `${(hidpiDiag.canvasPx[0] / hidpiDiag.canvasCss[0]).toFixed(3)} vs ${hidpiDiag.dpr}` : "-"
);
ok(
  !!hidpiDiag && Math.abs(hidpiDiag.font - 15) <= 0.5,
  "HiDPI：输入框字号 = 落笔字号（屏幕 CSS 15px，不随 DPR 缩小）",
  hidpiDiag ? `${hidpiDiag.font}px` : "-"
);
ok(
  !!hidpiDiag && Math.abs(hidpiDiag.firstChar[0] - 80) <= 1.5 && Math.abs(hidpiDiag.firstChar[1] - 80) <= 1.5,
  "HiDPI：输入框首字落在点击处 (80,80)",
  hidpiDiag ? `(${hidpiDiag.firstChar.map((n) => n.toFixed(1)).join(",")})` : "-"
);
await hidpi.evaluate(`(() => {
  const t = document.querySelector('.pin-text-input');
  t.value = '${TEXT}';
  t.dispatchEvent(new Event('input', { bubbles: true }));
  t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
})()`);
await sleep(300);
const hidpiBox = await hidpi.evaluate("window.__pin.redBox()");
ok(hidpiBox && hidpiBox.n > 0, "HiDPI：文字画到画布上", hidpiBox ? `${hidpiBox.n} px` : "-");
if (hidpiBox && hidpiBox.n > 0) {
  ok(
    Math.abs(hidpiBox.minX - 100) <= 5 && Math.abs(hidpiBox.minY - 100) <= 5,
    "HiDPI：落笔起点 = 点击处 × DPR (100,100)",
    `左上 (${hidpiBox.minX},${hidpiBox.minY})`
  );
  ok(
    Math.abs(hidpiBox.h - 15) <= 3,
    "HiDPI：落笔墨迹高 ≈ 屏幕字号 × DPR（15px）",
    `${hidpiBox.h}px`
  );
}
// 选中框回归：点一下已写好的文字（文字工具下单击=选中并准备移位），
// DOM 选中框必须和落笔文字同坐标（屏幕 CSS (80,80)、宽度 ≈ 文字宽）。
await hidpi.evaluate("window.__pin.drag(85, 85, 85, 85)");
await sleep(200);
const hidpiSel = await hidpi.evaluate(`(() => {
  const el = document.querySelector('.pin-selbox');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
})()`);
ok(!!hidpiSel, "HiDPI：选中文字显示高亮框");
ok(
  !!hidpiSel && Math.abs(hidpiSel.left - 80) <= 3 && Math.abs(hidpiSel.top - 80) <= 3,
  "HiDPI：选中框起点与文字落点一致 (80,80)",
  hidpiSel ? `(${hidpiSel.left.toFixed(1)},${hidpiSel.top.toFixed(1)})` : "-"
);
ok(
  !!hidpiSel && hidpiSel.width > 50,
  "HiDPI：选中框宽度按屏幕 CSS 像素计量（不被 1/DPR 缩小）",
  hidpiSel ? `${hidpiSel.width.toFixed(1)}px` : "-"
);
await hidpi.close();

/* ===================== 一致性对比 ===================== */

if (ovBox && ovBox.n > 0) {
  ok(
    Math.abs(ovBox.minX - CLICK) <= 4 && Math.abs(ovBox.minY - CLICK) <= 4,
    "截图侧：文字起点在点击处 (80,80)",
    `左上 (${ovBox.minX},${ovBox.minY})`
  );
}
if (pinBox && pinBox.n > 0) {
  ok(
    Math.abs(pinBox.minX - CLICK) <= 4 && Math.abs(pinBox.minY - CLICK) <= 4,
    "贴图侧：文字起点在点击处 (80,80)",
    `左上 (${pinBox.minX},${pinBox.minY})`
  );
}
if (ovBox && ovBox.n > 0 && pinBox && pinBox.n > 0) {
  ok(
    Math.abs(ovBox.minX - pinBox.minX) <= 4 && Math.abs(ovBox.minY - pinBox.minY) <= 4,
    "起点一致：两边文字都落在点击处",
    `截图 (${ovBox.minX},${ovBox.minY}) vs 贴图 (${pinBox.minX},${pinBox.minY})`
  );
  ok(
    Math.abs(ovBox.h - pinBox.h) <= 2,
    "字号一致：文字包围盒高度一致",
    `截图 ${ovBox.h}px vs 贴图 ${pinBox.h}px`
  );
  ok(
    Math.abs(ovBox.w - pinBox.w) <= 3,
    "文字宽度一致（同字号同文本）",
    `截图 ${ovBox.w}px vs 贴图 ${pinBox.w}px`
  );
  ok(
    Math.abs(ovBox.n - pinBox.n) / Math.max(ovBox.n, 1) <= 0.15,
    "文字像素量一致（同字号同文本，渲染相同）",
    `截图 ${ovBox.n} px vs 贴图 ${pinBox.n} px`
  );
} else {
  fail++;
  console.log("FAIL  一致性对比无法进行（某一边没画出文字）");
}

ok(ov.pageErrors.length === 0, "截图侧无未捕获异常", ov.pageErrors[0] || "");
ok(pin.pageErrors.length === 0, "贴图侧无未捕获异常", pin.pageErrors[0] || "");
ok(hidpi.pageErrors.length === 0, "贴图 HiDPI 页无未捕获异常", hidpi.pageErrors[0] || "");

console.log(`\n贴图文字一致性：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
