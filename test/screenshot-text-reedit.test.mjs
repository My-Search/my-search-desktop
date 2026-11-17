/**
 * 贴文本后的「再编辑」链路（真实浏览器验证）。
 *
 * 背景（用户反馈）：贴上文字后，重新选中那段文字却无法编辑——要么点上去不是
 * 改原文而是又贴了一条新的，要么选中后进不了编辑。
 *
 * 钉死的契约：
 *   1. 文字工具点在**已有文字**上 → 直接进入编辑（输入框预填原文），不再新贴一条；
 *   2. 选择工具点选文字 → 出现「✎T」按钮；点它 → 输入框预填原文；
 *   3. 双击文字 → 直接进入编辑（预填原文）；
 *   4. 改完回车 → **替换**原笔（不是新增一条）：旧文字消失、新文字在原位、
 *      拖走后原位置不残留旧文字。
 *
 * 用法: npm run build && node test/screenshot-text-reedit.test.mjs
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
if (!existsSync(path.join(dist, "overlay.html"))) {
  console.error("缺少 dist/overlay.html：请先 npm run build");
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

/* ===================== 静态服务器（服务 dist 构建产物） ===================== */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};
const server = createServer(async (req, res) => {
  try {
    const u = decodeURIComponent(req.url.split("?")[0]);
    const file = path.join(dist, u === "/" ? "/overlay.html" : u);
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
  console.log("未找到浏览器（Chrome/Edge），跳过贴文本再编辑 UI 测试");
  server.close();
  process.exit(0);
}

/* ===================== 起浏览器 + CDP ===================== */

const userDir = path.join(root, "test", `_chrome-profile-redit-${process.pid}`);
const port = 9700 + Math.floor(Math.random() * 200);
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
    "--window-size=1280,800",
    `${base}/overlay.html?monitor=0`,
  ],
  { stdio: "ignore" }
);

async function cdpTarget() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await r.json();
      const page = list.find(
        (t) => t.type === "page" && t.webSocketDebuggerUrl && String(t.url).startsWith(base)
      );
      if (page) return page;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("浏览器 CDP 未就绪（未找到目标页面）");
}

let ws;
let msgId = 0;
const pending = new Map();
const pageErrors = [];

async function connect() {
  const target = await cdpTarget();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("WebSocket 连接失败"));
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === "Runtime.exceptionThrown") {
      pageErrors.push(String(m.params.exceptionDetails.exception?.description || "").slice(0, 300));
    }
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      pageErrors.push(
        "[console.error] " + m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300)
      );
    }
    if (m.id != null && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(JSON.stringify(m.error)));
      else resolve(m.result);
    }
  };
  await send("Runtime.enable");
  await send("Page.enable");
}

function send(method, params) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}

async function evaluate(expr) {
  const r = await send("Runtime.evaluate", {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error(
      "页面求值异常: " + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails)
    );
  }
  return r.result.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));



const INJECT = `
(() => {
  /* ---------- A. 假 Tauri 桥（与 screenshot-overlay-ui.test.mjs 同构） ---------- */
  const STRIPE = [40, 120, 200];
  const SCREEN = (() => {
    const c = document.createElement('canvas');
    c.width = window.innerWidth;
    c.height = window.innerHeight;
    const ctx = c.getContext('2d');
    for (let x = 0; x < c.width; x++) {
      ctx.fillStyle = 'rgb(0,' + STRIPE[x % 3] + ',0)';
      ctx.fillRect(x, 0, 1, c.height);
    }
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
      if (cmd === 'plugin:window|scale_factor') return Promise.resolve(window.__scaleFactor || 1);
      if (cmd === 'screenshot_overlay_image') {
        const sf = window.__scaleFactor || 1;
        return Promise.resolve({
          dataUrl: SCREEN.toDataURL('image/png'),
          width: SCREEN.width, height: SCREEN.height,
          monitor: { index: 0, x: 0, y: 0, width: window.innerWidth, height: window.innerHeight, scaleFactor: sf, isPrimary: true },
          monitorCount: 1, originX: 0, originY: 0,
        });
      }
      if (cmd === 'screenshot_crop') {
        const sf = window.__scaleFactor || 1;
        const x = Math.round((args && args.x) || 0);
        const y = Math.round((args && args.y) || 0);
        const w = Math.max(1, Math.round((args && args.width) || 10));
        const h = Math.max(1, Math.round((args && args.height) || 10));
        const pw = Math.max(1, Math.round(w * sf));
        const ph = Math.max(1, Math.round(h * sf));
        window.__lastCrop = { x, y, w, h, sf };
        const url = cropFrom(x, y, w, h, sf);
        window.__lastCropUrl = url;
        return Promise.resolve({ dataUrl: url, width: pw, height: ph });
      }
      if (cmd === 'screenshot_selection_image') {
        const s = window.__lastCrop || { x: 0, y: 0, w: 10, h: 10, sf: 1 };
        const url = cropFrom(s.x, s.y, s.w, s.h, s.sf || 1);
        window.__lastCropUrl = url;
        return Promise.resolve({ dataUrl: url, width: Math.round(s.w * (s.sf || 1)), height: Math.round(s.h * (s.sf || 1)) });
      }
      if (cmd === 'screenshot_copy_text') {
        window.__lastCopyText = args && args.text;
        return Promise.resolve(null);
      }
      return Promise.resolve(null);
    },
    transformCallback(cb) { return cb; },
    metadata: { currentWindow: { label: 'overlay-0' }, currentWebview: { label: 'overlay-0' } },
    plugins: {},
  };

  /* ---------- B. 断言辅助 ---------- */
  window.__ov = {
    drag: (target, x1, y1, x2, y2) => {
      const el = typeof target === 'string' ? document.querySelector(target) : target;
      if (!el) throw new Error('no element ' + target);
      const at = (x, y, type) => el.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, clientX: x, clientY: y, buttons: type === 'mouseup' ? 0 : 1,
      }));
      at(x1, y1, 'mousedown');
      for (let i = 1; i <= 4; i++) at(x1 + (x2 - x1) * i / 4, y1 + (y2 - y1) * i / 4, 'mousemove');
      at(x2, y2, 'mouseup');
    },
    dblclick: (target, x, y) => {
      const el = typeof target === 'string' ? document.querySelector(target) : target;
      if (!el) throw new Error('no element ' + target);
      const at = (type) => el.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, clientX: x, clientY: y, buttons: type === 'mouseup' ? 0 : 1, detail: type === 'dblclick' ? 2 : 1,
      }));
      at('mousedown'); at('mouseup'); at('mousedown'); at('mouseup'); at('dblclick');
    },
    clickSel: (sel) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error('no element ' + sel);
      el.click();
    },
    /** 画布上符合条件的像素数 + 包围盒（画布设备像素坐标） */
    ink: (test) => {
      const c = document.querySelector('canvas.ov-canvas');
      if (!c) return null;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          const i = (y * c.width + x) * 4;
          if (test(d[i], d[i + 1], d[i + 2], d[i + 3])) {
            n++;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
        }
      }
      return n === 0 ? { n: 0 } : { n, minX, minY, maxX, maxY };
    },
    /** 指定矩形（画布设备像素坐标）内符合条件的像素数 */
    inkIn: (test, x0, y0, w, h) => {
      const c = document.querySelector('canvas.ov-canvas');
      if (!c) return null;
      const d = c.getContext('2d').getImageData(x0, y0, w, h).data;
      let n = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          if (test(d[i], d[i + 1], d[i + 2], d[i + 3])) n++;
        }
      }
      return n;
    },
    /** 当前文字输入框状态（存在性 / 预填内容 / 是否聚焦） */
    input: () => {
      const box = document.querySelector('.ov-textbox');
      if (!box) return null;
      const input = box.querySelector('input');
      return {
        value: input ? input.value : null,
        focused: input ? document.activeElement === input : false,
      };
    },
    textboxOpen: () => !!document.querySelector('.ov-textbox'),
  };
})();
`;

// 偏红（默认标注色 #ff5555）
const RED = "(r,g,b,a) => a > 0 && r > 180 && g < 140 && b < 140";

try {
  await connect();
  await send("Page.addScriptToEvaluateOnNewDocument", { source: INJECT });
  await send("Page.navigate", { url: `${base}/overlay.html?monitor=0` });
  await sleep(1000);

  /* ---------------- 1. 框选 → 编辑态 ---------------- */
  await evaluate("window.__ov.drag('.ov-root', 200, 150, 600, 450)");
  await sleep(400);

  /* ---------------- 2. 贴文本：文字工具点画布，输入并回车 ---------------- */
  await evaluate("window.__ov.clickSel('.ov-tool[title=\"文字\"]')");
  // 在画布内 rel (80,80) 点一下 → 窗口 (280,230)
  await evaluate("window.__ov.drag('.ov-sel', 280, 230, 280, 230)");
  await sleep(250);
  ok((await evaluate("window.__ov.textboxOpen()")) === true, "贴文本：输入框出现");
  await evaluate(`(() => {
    const input = document.querySelector('.ov-text-input');
    input.value = '甲';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await sleep(300);
  const first = await evaluate(`window.__ov.ink(${RED})`);
  ok(first && first.n > 0, "贴文本：文字画到了画布上", first ? `${first.n} px @ (${first.minX},${first.minY})` : "-");
  ok(
    first && Math.abs(first.minX - 80) <= 4 && Math.abs(first.minY - 80) <= 4,
    "贴文本：文字落在点击处（rel 80,80）",
    first ? `实际 (${first.minX},${first.minY})` : "-"
  );

  /* ---------------- 3. 文字交互：单击文字 = 选中并开始拖动（不编辑） ----------------
   * 新交互约定（用户需求）：文字**单击拖动移位、双击才编辑**。文字工具点在
   * 已有文字上不得再直接开输入框，而是把它选中并进入拖动——验证两条：
   *   a) 单击文字后**没有**输入框（旧交互回归闸）；
   *   b) 按住拖动后文字真的移位（像素包围盒位置变化）。
   * 文字 fs=15（lineWidth 3×5），「甲」宽约 12px → 点 rel (86,88) = 窗口 (286,238)。 */
  await evaluate("window.__ov.drag('.ov-sel', 286, 238, 286, 238)");
  await sleep(250);
  const noEdit = await evaluate("window.__ov.textboxOpen()");
  ok(noEdit === false, "文字工具单击已有文字 → 不开编辑框（新交互：单击=拖动）");
  await evaluate("window.__ov.drag('.ov-sel', 286, 238, 346, 288)");
  await sleep(250);
  const afterDrag = await evaluate(`window.__ov.ink(${RED})`);
  ok(
    afterDrag && afterDrag.n > 0 && Math.abs(afterDrag.minX - 142) <= 8 && Math.abs(afterDrag.minY - 132) <= 8,
    "文字工具按住文字拖动 → 文字移位（rel 140,130 附近）",
    afterDrag ? `实际 (${afterDrag.minX},${afterDrag.minY})` : "-"
  );
  // 再编辑：换成双击文字（窗口 (346,288)）打开输入框、预填原文
  await evaluate("window.__ov.dblclick('.ov-sel', 346, 288)");
  await sleep(250);
  const editA = await evaluate("window.__ov.input()");
  ok(editA !== null, "双击文字 → 输入框打开");
  ok(editA && editA.value === "甲", "输入框预填原文（不是空的新贴）", editA ? JSON.stringify(editA.value) : "-");
  const hiddenA = await evaluate(`window.__ov.ink(${RED})`);
  ok(
    hiddenA && hiddenA.n === 0,
    "编辑中：画布上的原文字已隐藏（输入框里是原文，画布上再画就叠影）",
    hiddenA ? `${hiddenA.n} px` : "-",
  );
  if (editA && editA.value === "甲") {
    await evaluate(`(() => {
      const input = document.querySelector('.ov-text-input');
      input.value = '甲乙丙丁';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await sleep(300);
    const after = await evaluate(`window.__ov.ink(${RED})`);
    ok(after && after.n > first.n, "改完回车 → 画布文字更新（像素变多）", first && after ? `${first.n} → ${after.n} px` : "-");
    ok(
      after && after.maxX > afterDrag.maxX + 20,
      "改完回车 → 文字内容真的变了（包围盒变宽）",
      afterDrag && after ? `maxX ${afterDrag.maxX} → ${after.maxX}` : "-"
    );
    // 拖回原位附近，方便后续用例定位（拖动走选择工具）
    await evaluate("window.__ov.clickSel('.ov-tool[title=\"选择\"]')");
    await evaluate("window.__ov.drag('.ov-sel', 356, 288, 296, 238)");
    await sleep(250);
  } else {
    fail += 4;
    console.log("SKIP 改后四项断言（前置失败）");
  }


  /* ---------------- 3b. 中文右端双击也命中（回归：包围盒低估 20%） ----------------
   * 旧版文字包围盒按「字数 × 0.8 × 字号」估宽，中文实际 ≈ 1.0em —— 点文字
   * **右端**（约最后 20% 区域）落空，被当成空白处又开一条空输入框叠在原字上
   * （用户反馈：点贴的文本像新添加的一样，出现重叠）。宽度用 measureText
   * 实测：双击「甲乙丙丁」最后一个字的墨迹上必须进入编辑（预填原文），且不得
   * 出现第二条文字。 */
  // 文字 fs=15，「甲乙丙丁」实测宽约 60px（4 × 15），右端字符墨迹 ≈ rel (130,88) = 窗口 (330,238)
  await evaluate("window.__ov.dblclick('.ov-sel', 330, 238)");
  await sleep(250);
  const editR = await evaluate("window.__ov.input()");
  ok(
    editR !== null && editR.value === "甲乙丙丁",
    "双击中文文字右端 → 命中并预填原文（旧包围盒此处落空 → 叠新框）",
    editR ? JSON.stringify(editR.value) : "输入框未打开（当作空白处）"
  );
  // Esc 收起，进入后续用例
  await evaluate(`(() => {
    const input = document.querySelector('.ov-text-input');
    if (input) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  })()`);
  await sleep(200);

  /* ---------------- 3c. 文字被矩形框住：双击框内文字仍编辑文字 ----------------
   * 文字常被先画/后画的矩形套住，矩形包围盒是整个框面——按「最上层任意笔」
   * 匹配会把点框内文字当成点在框上。pickTextStroke 文字优先：框内双击文字
   * 必须预填原文，且不得多出第二条文字。 */
  // 先画一个矩形框住文字（文字中心 rel (110,88) → 窗口 (310,238)）
  await evaluate("window.__ov.clickSel('.ov-tool[title=\\\"矩形\\\"]')");
  await sleep(150);
  await evaluate("window.__ov.drag('.ov-sel', 260, 205, 380, 270)");
  await sleep(250);
  // 双击框内文字（避开矩形线宽 3px 的边缘）
  await evaluate("window.__ov.dblclick('.ov-sel', 310, 238)");
  await sleep(250);
  const editBox = await evaluate("window.__ov.input()");
  ok(
    editBox !== null && editBox.value === "甲乙丙丁",
    "框内双击文字 → 编辑文字（预填原文），不被框线抢走",
    editBox ? JSON.stringify(editBox.value) : "输入框未打开"
  );
  // 紧接着点框内**没有文字**的空白处 → 仍应开新的空输入框（正常新贴流程未被破坏）
  await evaluate(`(() => {
    const input = document.querySelector('.ov-text-input');
    if (input) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  })()`);
  await sleep(200);
  await evaluate("window.__ov.drag('.ov-sel', 360, 255, 360, 255)");
  await sleep(250);
  const fresh = await evaluate("window.__ov.input()");
  ok(
    fresh !== null && fresh.value === "",
    "框内空白处点击 → 仍开新空输入框（新贴流程未被文字优先破坏）",
    fresh ? JSON.stringify(fresh.value) : "输入框未打开"
  );
  await evaluate(`(() => {
    const input = document.querySelector('.ov-text-input');
    if (input) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  })()`);
  await sleep(200);
  // 撤销掉 3c 画的矩形（它在文字上方，会抢走后续用例「选择工具点文字」的命中）
  await evaluate(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
  })()`);
  await sleep(250);

  /* ---------------- 4. 再编辑路径 B：选择工具选中 → ✎T 编辑 ---------------- */
  await evaluate("window.__ov.clickSel('.ov-tool[title=\"选择\"]')");
  await evaluate("window.__ov.drag('.ov-sel', 286, 238, 286, 238)");
  await sleep(250);
  ok((await evaluate("!!document.querySelector('.ov-picked')")) === true, "选择工具点文字 → 选中高亮出现");
  ok((await evaluate("!!document.querySelector('.ov-tool[title=\"编辑文字\"]')")) === true, "选中文字 → 出现「✎T」按钮");
  await evaluate("window.__ov.clickSel('.ov-tool[title=\"编辑文字\"]')");
  await sleep(250);
  const editB = await evaluate("window.__ov.input()");
  ok(editB !== null, "点「✎T」→ 输入框打开");
  ok(editB && editB.value === "甲乙丙丁", "✎T 编辑：输入框预填当前文字", editB ? JSON.stringify(editB.value) : "-");
  const hiddenB = await evaluate(`window.__ov.ink(${RED})`);
  ok(
    hiddenB && hiddenB.n === 0,
    "✎T 编辑中：画布上的原文字已隐藏",
    hiddenB ? `${hiddenB.n} px` : "-",
  );
  if (editB && editB.value === "甲乙丙丁") {
    await evaluate(`(() => {
      const input = document.querySelector('.ov-text-input');
      input.value = 'XY';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await sleep(300);
    const afterB = await evaluate(`window.__ov.ink(${RED})`);
    ok(
      afterB && afterB.n > 0 && afterB.maxX - afterB.minX < 90,
      "✎T 改完回车 → 内容替换成功（更短文字，包围盒收窄）",
      afterB ? `宽 ${afterB.maxX - afterB.minX}px` : "-"
    );
  }

  /* ---------------- 5. 再编辑路径 C：双击文字直接编辑 ---------------- */
  // 先把文字换成长句，方便断言预填
  await evaluate("window.__ov.clickSel('.ov-tool[title=\"编辑文字\"]')");
  await sleep(200);
  await evaluate(`(() => {
    const input = document.querySelector('.ov-text-input');
    if (!input) return;
    input.value = '双击编辑我';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await sleep(300);
  await evaluate("window.__ov.dblclick('.ov-sel', 286, 238)");
  await sleep(250);
  const editC = await evaluate("window.__ov.input()");
  ok(editC !== null, "双击文字 → 输入框打开");
  ok(editC && editC.value === "双击编辑我", "双击编辑：输入框预填原文", editC ? JSON.stringify(editC.value) : "-");
  const hiddenC = await evaluate(`window.__ov.ink(${RED})`);
  ok(
    hiddenC && hiddenC.n === 0,
    "双击编辑中：画布上的原文字已隐藏",
    hiddenC ? `${hiddenC.n} px` : "-",
  );
  // Esc 收起，别影响后续
  await evaluate(`(() => {
    const input = document.querySelector('.ov-text-input');
    if (input) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  })()`);
  await sleep(200);
  const restoredC = await evaluate(`window.__ov.ink(${RED})`);
  ok(
    restoredC && restoredC.n > 0,
    "Esc 取消编辑：原文字原样恢复显示（取消 ≠ 删除）",
    restoredC ? `${restoredC.n} px` : "-",
  );

  /* ---------------- 6. 全程无未捕获的页面异常 ---------------- */
  ok(pageErrors.length === 0, "全程无未捕获的页面异常", pageErrors[0] || "");
} catch (err) {
  fail++;
  console.log("FAIL 测试执行异常 —", err && err.message);
}

console.log(`\n贴文本再编辑：${pass} 通过 / ${fail} 失败`);
try { ws && ws.close(); } catch {}
chrome.kill();
server.close();
try { rm(userDir, { recursive: true, force: true }); } catch {}
process.exit(fail > 0 ? 1 : 0);

