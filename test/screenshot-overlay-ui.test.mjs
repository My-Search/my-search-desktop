/**
 * 截图遮罩（overlay 窗口）标注链路的真实浏览器验证。
 *
 * 为什么必须有这个测试：遮罩是真机上的**透明全屏窗口**，headless 跑不出它的
 * 视觉效果，所以「标注画在哪 / 什么时候能看见」这类问题在人工点测里只能靠肉眼
 * 发现——实际踩到的故障正是这两个：
 *   - 「涂了看不到」（笔迹被推到画布外）；
 *   - 「动作完成才看到效果」（拖动中的那一笔没进渲染循环）；
 *   - 「标注与实际不一致」（箭头方向被归一化掉、马赛克取错采样点）。
 * 本测试用真实浏览器加载 dist 里的 overlay 页面，注入假 Tauri 桥喂进「整屏底图 /
 * 裁片」，再用真实鼠标事件走完「框选 → 标注」，最后**直接读画布像素**判断结果。
 *
 * 钉死的契约（都是坐标换算与绘制时机最容易写错的地方）：
 *   1. 框选后进入编辑态；选区画布物理尺寸 = 裁片尺寸，并按选区大小 1:1 显示；
 *   2. **拖动过程中**就能看到效果（不松手也已画在画布上）；
 *   3. **松手前后像素一致**：松手只是把这一笔定稿，不该改变已画出的样子；
 *   4. 画笔涂到哪就出现在哪（落在选区内相对位置，颜色就是所选颜色）；
 *   5. 笔画点**不会**被叠加一次选区原点（历史 bug）；
 *   6. 矩形落点正确，拖动中与松手后一致（含从右下往左上拖）；
 *   7. **箭头方向保持**：从右下往左上拖，箭头必须指向左上（历史 bug：被归一化后反向）；
 *      且箭尖必须是尖的——不许有 lineCap=round 圆头鼓出的圆点；
 *   8. 马赛克取样自**选区内的相对位置**，且拖动中就可见；
 *   9. 撤销 / 重做真的作用在画布上；
 *  10. 按 C 取色：采集态芯片跟随光标，**按下鼠标才复制**并弹「已复制」提示后自动收起；
 *  11. 全程无未捕获的页面异常。
 *
 * 用法: npm run build && node test/screenshot-overlay-ui.test.mjs
 * 需要本机装有 Chrome / Edge；找不到浏览器时跳过（退出码 0）。
 */
import { createServer } from "http";
import { readFile } from "fs/promises";
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

/* ===================== 静态服务器（直接服务 dist 构建产物） ===================== */

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
  console.log("未找到浏览器（Chrome/Edge），跳过截图遮罩 UI 测试");
  server.close();
  process.exit(0);
}

/* ===================== 起浏览器 + CDP ===================== */

const userDir = path.join(root, "test", `_chrome-profile-ov-${process.pid}`);
const port = 9450 + Math.floor(Math.random() * 200);
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
    "--disable-features=msEdgeSyncConfirmationDialog,EdgeSidebar",
    "--window-size=1280,800",
    `${base}/overlay.html?monitor=0`,
  ],
  { stdio: "ignore" }
);

/** 只挑我们自己那个页面（Edge 会额外开同步确认页，按 type 取第一个会挑错） */
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

/**
 * 页面里预置的一切（在 overlay 脚本执行前注入）。
 *
 * 两个部分：
 *   A. 假 Tauri 桥 —— `__TAURI_INTERNALS__.invoke` 是 @tauri-apps/api 的唯一出口，
 *      遮罩页用到的命令都在这里回话。裁片用页面自己的 <canvas> 现造（左半白右半黑），
 *      这样「取样位置」写错时能立刻从像素上看出来。
 *   B. 断言辅助 —— 拖拽、读画布像素、求标注包围盒。
 */
const INJECT = `
(() => {
  /* ---------- A. 造测试图（页面里直接用 canvas） ---------- */
  /**
   * 整屏帧：横向「周期 3 的绿色条纹」（g = 40 / 120 / 200 循环），**相位绑定
   * 绝对坐标**——与真实抓屏帧一样「整屏有内容」。三个用途：
   *   1. 遮罩底图（screenshot_overlay_image）：验证底图铺满 + 改范围实时裁剪
   *      按绝对坐标取像素（漏减选区原点 / 拉伸旧图在相位上一眼可辨）；
   *   2. 所有裁片都从它裁：与宿主「整帧裁块」的路径同构；
   *   3. 马赛克采样基准：1px 周期条纹下，采样点取错会换一个 g 值。
   */
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
  // 从整屏帧裁一块（坐标先钳制在帧内——模拟宿主 crop_rgba 的钳制行为）
  // sf：宿主按物理像素裁 —— CSS 坐标 × sf；输出图也就是物理像素尺寸。
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
        // 宿主截的是**物理像素**裁片：CSS 尺寸 × scaleFactor。真实机上是这样，
        // 这里也照做——否则 sf≠1 时「裁片尺寸 vs 画布坐标」的换算 bug 测不出来。
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
    sel: () => {
      const el = document.querySelector('.ov-sel');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height, active: el.classList.contains('ov-active') };
    },
    canvas: () => {
      const c = document.querySelector('canvas.ov-canvas');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { w: c.width, h: c.height, cw: r.width, ch: r.height };
    },
    /** 按窗口坐标派发真实鼠标事件 */
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
    /**
     * 「拖到一半」：按下并移动，**不松手**。
     * 用于验证「拖动过程中就能看到效果」——松手前后各读一次像素，两者必须一致。
     *
     * 松手函数挂在 window.__ovRelease 上（函数没法穿过 CDP 的 returnByValue），
     * 调用方用 window.__ovRelease() 结束这一笔。
     */
    dragHold: (target, x1, y1, x2, y2) => {
      const el = typeof target === 'string' ? document.querySelector(target) : target;
      if (!el) throw new Error('no element ' + target);
      const at = (x, y, type) => el.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, clientX: x, clientY: y, buttons: 1,
      }));
      at(x1, y1, 'mousedown');
      for (let i = 1; i <= 4; i++) at(x1 + (x2 - x1) * i / 4, y1 + (y2 - y1) * i / 4, 'mousemove');
      window.__ovRelease = () => {
        el.dispatchEvent(new MouseEvent('mouseup', {
          bubbles: true, cancelable: true, clientX: x2, clientY: y2, buttons: 0,
        }));
        window.__ovRelease = null;
        return true;
      };
      return true;
    },
    clickSel: (sel) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error('no element ' + sel);
      el.click();
    },
    /** 画布上符合条件的像素数 + 包围盒（判断「标注画到哪了」） */
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
    /**
     * 同上，但只统计指定矩形（画布设备像素坐标）内的像素。
     * 画布上同时存在多个标注时，用它把断言限定在「目标那一块」，互不干扰。
     */
    inkIn: (test, x0, y0, w, h) => {
      const c = document.querySelector('canvas.ov-canvas');
      if (!c) return null;
      const d = c.getContext('2d').getImageData(x0, y0, w, h).data;
      let n = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          if (test(d[i], d[i + 1], d[i + 2], d[i + 3])) {
            n++;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
        }
      }
      return n === 0 ? { n: 0 } : { n, minX: minX + x0, minY: minY + y0, maxX: maxX + x0, maxY: maxY + y0 };
    },
    /**
     * 读画布某个像素（设备像素坐标），返回 [r,g,b,a]。
     *
     * 马赛克断言的判据不是「有没有像素」而是「色块的**颜色**」：
     * 色块颜色直接反映采样点位置，因此能区分「采样对了」与「采样偏了」。
     */
    pixel: (x, y) => {
      const c = document.querySelector('canvas.ov-canvas');
      if (!c) return null;
      const d = c.getContext('2d').getImageData(Math.round(x), Math.round(y), 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    },
    /**
     * 整张画布的像素指纹（用于「松手前后必须一模一样」的比对）。
     *
     * 返回 [非透明像素数, 32 位 FNV 哈希]：只比「有没有变」而不返回整幅数据，
     * 免得几万字节穿过 CDP。哈希按 RGBA 逐字节算，任何一个像素变了都会不同。
     */
    signature: () => {
      const c = document.querySelector('canvas.ov-canvas');
      if (!c) return null;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let opaque = 0;
      let h = 0x811c9dc5;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] > 0) opaque++;
        h ^= d[i]; h = Math.imul(h, 0x01000193) >>> 0;
        h ^= d[i + 1]; h = Math.imul(h, 0x01000193) >>> 0;
        h ^= d[i + 2]; h = Math.imul(h, 0x01000193) >>> 0;
        h ^= d[i + 3]; h = Math.imul(h, 0x01000193) >>> 0;
      }
      return { opaque, hash: h };
    },
  };
})();
`;

// 偏红（默认标注色 #ff5555）
const RED = "(r,g,b,a) => a > 0 && r > 180 && g < 140 && b < 140";
// 任意不透明像素（用于「删除后画布内容变少」这类计数）
const ANY = "(r,g,b,a) => a > 0";

try {
  await connect();
  await send("Page.addScriptToEvaluateOnNewDocument", { source: INJECT });
  await send("Page.navigate", { url: `${base}/overlay.html?monitor=0` });
  await sleep(1000);

  ok(
    (await evaluate("window.__invoked.includes('screenshot_overlay_image')")) === true,
    "遮罩页请求了本屏底图"
  );
  ok((await evaluate("!!document.querySelector('.ov-root')")) === true, "遮罩 UI 已挂载");

  /* ---------------- 1. 框选 → 编辑态 ---------------- */
  // 选区固定在窗口 (200,150)，尺寸 400x300
  await evaluate("window.__ov.drag('.ov-root', 200, 150, 600, 450)");
  await sleep(400);

  const sel = await evaluate("window.__ov.sel()");
  ok(sel && sel.active === true, "松开鼠标后进入编辑态", sel ? JSON.stringify(sel) : "无 .ov-sel");
  const cv = await evaluate("window.__ov.canvas()");
  ok(cv && cv.w === 400 && cv.h === 300, "选区画布物理尺寸 = 裁片尺寸", cv ? `${cv.w}x${cv.h}` : "无画布");
  ok(
    cv && Math.abs(cv.cw - 400) < 2 && Math.abs(cv.ch - 300) < 2,
    "选区画布按选区大小 1:1 显示（不拉伸）",
    cv ? `显示 ${cv.cw}x${cv.ch}` : "-"
  );
  ok((await evaluate("!!document.querySelector('.ov-toolbar')")) === true, "编辑态出现标注工具条");

  /* ---------------- 2. 画笔：实时可见 + 涂到哪就出现在哪 ---------------- */
  // 选区原点在窗口 (200,150)；在选区内相对 (60,60) → 窗口 (260,210) 涂一笔。
  // 先「拖到一半不松手」读一次像素，再松手读第二次：两次必须一模一样。
  await evaluate("window.__ov.clickSel('.ov-tool[title=\"画笔\"]')");
  await evaluate("window.__ov.dragHold('.ov-sel', 260, 210, 340, 250)");
  await sleep(150);

  const midDrag = await evaluate(`window.__ov.ink(${RED})`);
  ok(
    midDrag && midDrag.n > 0,
    "拖动过程中就能看到画笔效果（不松手也已画在画布上）",
    midDrag ? `${midDrag.n} px` : "读不到画布"
  );
  const sigMid = await evaluate("window.__ov.signature()");

  await evaluate("window.__ovRelease()");
  await sleep(150);
  const sigAfter = await evaluate("window.__ov.signature()");
  ok(
    sigMid && sigAfter && sigMid.hash === sigAfter.hash && sigMid.opaque === sigAfter.opaque,
    "松手前后像素完全一致（松手只是定稿，不改变已画出的样子）",
    sigMid && sigAfter ? `拖动中 ${sigMid.opaque}px/${sigMid.hash} vs 松手后 ${sigAfter.opaque}px/${sigAfter.hash}` : "-"
  );

  const pen = await evaluate(`window.__ov.ink(${RED})`);
  ok(pen && pen.n > 0, "画笔有可见效果（画布出现所选颜色的像素）", pen ? `${pen.n} px` : "读不到画布");
  if (pen && pen.n > 0) {
    ok(
      pen.minX >= 45 && pen.minY >= 45 && pen.maxX <= 155 && pen.maxY <= 115,
      "画笔落点正确（选区内相对 (60,60)-(140,100)）",
      `包围盒 x=${pen.minX}..${pen.maxX} y=${pen.minY}..${pen.maxY}`
    );
    ok(
      !(pen.minX >= 800 || pen.minY >= 600),
      "笔画点没有被重复叠加选区原点（历史 bug：笔迹被推出画布）",
      `minX=${pen.minX} minY=${pen.minY}`
    );
  }

  /* ---------------- 3. 撤销 / 重做 ---------------- */
  await evaluate("window.__ov.clickSel('.ov-tool[title^=\"撤销\"]')");
  await sleep(150);
  const undo = await evaluate(`window.__ov.ink(${RED})`);
  ok(undo && undo.n === 0, "撤销后笔迹从画布消失", undo ? `${undo.n} px` : "-");
  await evaluate("window.__ov.clickSel('.ov-tool[title^=\"重做\"]')");
  await sleep(150);
  const redo = await evaluate(`window.__ov.ink(${RED})`);
  ok(redo && redo.n > 0, "重做后笔迹回到画布", redo ? `${redo.n} px` : "-");
  await evaluate("window.__ov.clickSel('.ov-tool[title^=\"撤销\"]')");
  await sleep(120);

  /* ---------------- 4. 矩形 ---------------- */
  await evaluate("window.__ov.clickSel('.ov-tool[title=\"矩形\"]')");
  await evaluate("window.__ov.drag('.ov-sel', 260, 210, 340, 250)");
  await sleep(150);
  const rect = await evaluate(`window.__ov.ink(${RED})`);
  ok(rect && rect.n > 0, "矩形有可见效果", rect ? `${rect.n} px` : "-");
  if (rect && rect.n > 0) {
    ok(
      rect.minX >= 45 && rect.minY >= 45 && rect.maxX <= 155 && rect.maxY <= 115,
      "矩形落点正确（选区内相对 (60,60)-(140,100)）",
      `包围盒 x=${rect.minX}..${rect.maxX} y=${rect.minY}..${rect.maxY}`
    );
  }
  await evaluate("window.__ov.clickSel('.ov-tool[title^=\"撤销\"]')");
  await sleep(120);

  /* ---------------- 4b. 箭头方向：从右下往左上拖，箭头必须指向左上 ---------------- *
   *
   * 历史 bug：endStroke 把负宽高一律归一成正的，箭头方向恰好由 (w,h) 的符号决定，
   * 于是「从右下往左上拖」的箭头松手后翻成指向右下——拖动中看到的是一个方向、
   * 松手后变成另一个方向，正是「标注与实际不一致」。
   * 判据：箭杆两端的像素密度。箭头头部（三角）附近像素远多于尾端，因此
   * 「起点附近 vs 终点附近」谁更密，就说明箭头指向哪一头。
   */
  await evaluate("window.__ov.clickSel('.ov-tool[title=\"箭头\"]')");
  // 从画布内 rel (180,180) 拖到 rel (60,60) → 窗口 (380,330) → (260,210)
  await evaluate("window.__ov.drag('.ov-sel', 380, 330, 260, 210)");
  await sleep(200);
  const arrow = await evaluate(`(() => {
    const c = document.querySelector('canvas.ov-canvas');
    if (!c) return null;
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const hit = (x, y, r) => {
      let n = 0;
      for (let yy = y - r; yy <= y + r; yy++) for (let xx = x - r; xx <= x + r; xx++) {
        if (xx < 0 || yy < 0 || xx >= c.width || yy >= c.height) continue;
        const i = (yy * c.width + xx) * 4;
        if (d[i + 3] > 0 && d[i] > 180 && d[i + 1] < 140 && d[i + 2] < 140) n++;
      }
      return n;
    };
    // 终点（左上，rel 60,60）与起点（右下，rel 180,180）
    // 箭尖锐利度：沿拖拽方向投影到箭杆轴上，**越过箭尖**的红色像素只可能来自
    // lineCap=round 的圆头鼓出的圆点（底图是纯绿条纹，永远不会命中红色判据）。
    const ang = Math.atan2(-120, -120);
    const ux = Math.cos(ang), uy = Math.sin(ang);
    const tipProj = 60 * ux + 60 * uy;
    let beyond = 0;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4;
      if (!(d[i + 3] > 0 && d[i] > 180 && d[i + 1] < 140 && d[i + 2] < 140)) continue;
      if (x * ux + y * uy > tipProj + 0.5) beyond++;
    }
    return { atEnd: hit(60, 60, 14), atStart: hit(180, 180, 14), beyond };
  })()`);
  ok(arrow && arrow.atEnd > 0, "箭头有可见效果", arrow ? JSON.stringify(arrow) : "-");
  if (arrow) {
    ok(
      arrow.atEnd > arrow.atStart,
      "箭头方向正确：从右下往左上拖 → 箭头指向左上（终点像素多于起点，因为头部三角在终点）",
      `终点附近 ${arrow.atEnd} px vs 起点附近 ${arrow.atStart} px`
    );
    ok(
      arrow.beyond <= 1,
      "箭尖不带圆点：没有红色像素越过箭尖（箭杆圆头收进头部里，只剩三角尖）",
      `越过箭尖 ${arrow.beyond} px`
    );
  }
  await evaluate("window.__ov.clickSel('.ov-tool[title^=\"撤销\"]')");
  await sleep(120);

  /* ---------------- 4c. 箭头端点可再调整（拖包围盒控制点改方向/长度） ---------------- */
  {
    await evaluate(`document.querySelectorAll('.ov-color')[0].click()`);
    // 画一条从左下到右上的箭头：窗口 (280,330) → (420,230)
    await evaluate("window.__ov.clickSel('.ov-tool[title=\"箭头\"]')");
    await evaluate("window.__ov.drag('.ov-sel', 280, 330, 420, 230)");
    await sleep(250);
    // 选中它
    await evaluate("window.__ov.clickSel('.ov-tool[title=\"选择\"]')");
    await sleep(150);
    await evaluate("window.__ov.drag('.ov-sel', 350, 280, 350, 280)");
    await sleep(250);
    const hasStub = await evaluate("!!document.querySelector('.ov-astub-se')");
    ok(hasStub, "选中箭头后出现包围盒控制点");

    // 箭头包围盒（窗口坐标）：终点在左上方向（420,230 是右下？）——
    // 用像素判据：拖 SE 控制点把终点往右下挪，箭头应更长（红色像素增多）。
    const a0 = await evaluate(`window.__ov.ink(${RED})`);
    const seA = await evaluate(`(() => {
      const el = document.querySelector('.ov-astub-se');
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await evaluate(`window.__ov.drag('.ov-astub-se', ${seA.x}, ${seA.y}, ${seA.x + 70}, ${seA.y + 50})`);
    await sleep(250);
    const a1 = await evaluate(`window.__ov.ink(${RED})`);
    ok(
      a0 && a1 && a1.n > a0.n && a1.maxX > a0.maxX,
      "拖箭头控制点 → 端点被拉远，箭头变长",
      a0 && a1 ? `${a0.n} px（右缘 ${a0.maxX}）→ ${a1.n} px（右缘 ${a1.maxX}）` : "-"
    );
    // 可撤销
    await evaluate("window.__ov.clickSel('.ov-tool[title^=\"撤销\"]')");
    await sleep(200);
    const a2 = await evaluate(`window.__ov.ink(${RED})`);
    ok(
      a2 && a0 && Math.abs(a2.maxX - a0.maxX) <= 3,
      "箭头端点调整可撤销",
      a2 && a0 ? `右缘 ${a2.maxX} vs ${a0.maxX}` : "-"
    );
    await evaluate("window.__ov.clickSel('.ov-tool[title^=\"撤销\"]')");
    await sleep(150);
  }

  /* ---------------- 5. 马赛克：拖动中可见 + 取样位置 ---------------- */
  // 底图是 1px 周期的绿色条纹 g ∈ {40,120,200}（见 INJECT 里的 STRIPE）。
  // 马赛克把每个 12px 格子填成**该格子中心那一像素的颜色**。判据不靠手算条纹
  // 相位，而是**直接对比**：把马赛克色块的颜色，与「底图在同一个相对位置上的
  // 像素颜色」比。采样正确 → 两者一致；采样漏减选区原点（历史 bug，采样点整体
  // 右移了选区原点的距离）→ 两者不一致。
  // 拖拽窗口 (500,300)-(580,360)，选区原点 (200,150) → 画布内 rel (300,150)-(380,210)
  await evaluate("window.__ov.clickSel('.ov-tool[title=\"马赛克\"]')");
  // 同样先「拖到一半不松手」：马赛克也必须拖动中就可见
  await evaluate("window.__ov.dragHold('.ov-sel', 500, 300, 580, 360)");
  await sleep(250);
  const mosaicMid = await evaluate("window.__ov.signature()");
  const midOpaque = await evaluate(
    `(() => {
      const c = document.querySelector('canvas.ov-canvas');
      const d = c.getContext('2d').getImageData(300, 150, 80, 60).data;
      let opaque = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) opaque++;
      return opaque;
    })()`
  );
  ok(
    midOpaque === 80 * 60,
    "拖动过程中就能看到马赛克（不松手已铺满拖拽区域）",
    `${midOpaque}/${80 * 60}`
  );
  await evaluate("window.__ovRelease()");
  await sleep(200);
  const mosaicAfter = await evaluate("window.__ov.signature()");
  ok(
    mosaicMid && mosaicAfter && mosaicMid.hash === mosaicAfter.hash,
    "马赛克松手前后像素完全一致",
    mosaicMid && mosaicAfter ? `${mosaicMid.hash} vs ${mosaicAfter.hash}` : "-"
  );

  const mosaic = await evaluate(
    `(async () => {
      const c = document.querySelector('canvas.ov-canvas');
      const d = c.getContext('2d').getImageData(300, 150, 80, 60).data;
      const seen = new Set();
      let opaque = 0, total = 0;
      for (let i = 0; i < d.length; i += 4) {
        total++;
        if (d[i + 3] > 0) opaque++;
        seen.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2]);
      }
      // 底图（同一张裁片）在同一相对位置的像素
      const img = new Image();
      await new Promise((res) => { img.onload = res; img.onerror = res; img.src = window.__lastCropUrl; });
      const bc = document.createElement('canvas');
      bc.width = img.naturalWidth; bc.height = img.naturalHeight;
      bc.getContext('2d').drawImage(img, 0, 0);
      const bd = bc.getContext('2d').getImageData(300, 150, 1, 1).data;
      return { colors: [...seen], opaque, total, base: bd[0] + ',' + bd[1] + ',' + bd[2] };
    })()`
  );
  ok(
    mosaic && mosaic.opaque === mosaic.total,
    "马赛克覆盖整个拖拽区域（实心，不留缝隙）",
    mosaic ? `${mosaic.opaque}/${mosaic.total}` : "-"
  );
  ok(
    mosaic && mosaic.colors.length === 1 && mosaic.colors[0] === mosaic.base,
    "马赛克采样点正确（色块颜色 = 底图在同一相对位置的像素）",
    mosaic ? `色块 ${JSON.stringify(mosaic.colors)} vs 底图同位置 rgb(${mosaic.base})` : "-"
  );

  /* ---------------- 6. 文字：落在点击处，且输入框与正文同字号 ---------------- */
  await evaluate("window.__ov.clickSel('.ov-tool[title=\"文字\"]')");
  // 在画布内 rel (80,80) 点一下 → 窗口 (280,230)
  await evaluate("window.__ov.drag('.ov-sel', 280, 230, 280, 230)");
  await sleep(250);
  const box = await evaluate(`(() => {
    const el = document.querySelector('.ov-textbox');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const input = el.querySelector('input');
    return {
      left: Math.round(r.left), top: Math.round(r.top),
      inputFont: input ? getComputedStyle(input).fontSize : null,
      inputColor: input ? getComputedStyle(input).color : null,
    };
  })()`);
  ok(box !== null, "点文字工具后出现输入框", box ? JSON.stringify(box) : "没出现");
  if (box) {
    // 期望贴合点击处（容差 3px：边框/取整）
    ok(
      Math.abs(box.left - 280) <= 3 && Math.abs(box.top - 230) <= 3,
      "输入框贴在点击的位置（不是选区角上）",
      `实际 (${box.left},${box.top})，期望约 (280,230)`
    );
  }

  // 输入文字并回车
  await evaluate(`(() => {
    const input = document.querySelector('.ov-text-input');
    input.value = '测试文字';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await sleep(300);
  const text = await evaluate(`(() => {
    const c = document.querySelector('canvas.ov-canvas');
    if (!c) return null;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    // 文字的红色像素包围盒（画布内 rel 坐标）
    let n = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4;
      if (d[i + 3] > 0 && d[i] > 180 && d[i + 1] < 140 && d[i + 2] < 140) {
        n++; if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y;
      }
    }
    return { n, minX, minY, maxX, maxY, closed: !document.querySelector('.ov-textbox') };
  })()`);
  ok(text && text.n > 0, "回车后文字画到了画布上", text ? `${text.n} px` : "-");
  ok(text && text.closed === true, "回车后输入框关闭", text ? String(text.closed) : "-");
  if (text && text.n > 0) {
    ok(
      Math.abs(text.minX - 80) <= 4 && Math.abs(text.minY - 80) <= 4,
      "文字起点就在点击处（画布内 rel 约 80,80）",
      `实际左上 (${text.minX},${text.minY})`
    );
  }
  await evaluate("window.__ov.clickSel('.ov-tool[title^=\"撤销\"]')");
  await sleep(120);

  /* ---------------- 7. 导出即所见：复制/保存出去的图 = 画布上看到的 ---------------- *
   *
   * composePng() 直接 `canvas.toDataURL()`，而画布在每次交互后都会重绘
   * （drawStrokes 先铺底图再叠标注）。因此「屏幕上的画布像素」与「导出的 PNG」
   * 必须逐字节一致——这是「标注与实际不一致」在**输出侧**的最后一道防线：
   * 若导出走的是另一条合成路径，用户就会看到「预览一个样、粘出来另一个样」。
   */
  {
    // 画一笔（保证画布上有内容），然后比对「画布像素」与「导出 PNG 解码后的像素」
    await evaluate("window.__ov.clickSel('.ov-tool[title=\"矩形\"]')");
    await evaluate("window.__ov.drag('.ov-sel', 300, 260, 400, 330)");
    await sleep(250);

    const cmp = await evaluate(`(async () => {
      const c = document.querySelector('canvas.ov-canvas');
      if (!c) return null;
      const onScreen = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      // 导出（与 composePng 同一条路径：canvas.toDataURL）
      const url = c.toDataURL('image/png');
      const img = new Image();
      await new Promise((res) => { img.onload = res; img.onerror = res; img.src = url; });
      const ec = document.createElement('canvas');
      ec.width = img.naturalWidth; ec.height = img.naturalHeight;
      ec.getContext('2d').drawImage(img, 0, 0);
      const exported = ec.getContext('2d').getImageData(0, 0, ec.width, ec.height).data;
      if (exported.length !== onScreen.length) return { same: false, reason: 'size', a: onScreen.length, b: exported.length };
      let diff = 0;
      for (let i = 0; i < onScreen.length; i++) if (onScreen[i] !== exported[i]) diff++;
      return { same: diff === 0, diff, size: ec.width + 'x' + ec.height };
    })()`);
    ok(
      cmp && cmp.same === true,
      "导出的 PNG 与画布上看到的逐字节一致（复制/保存出去的 = 预览看到的）",
      cmp ? (cmp.same ? `尺寸 ${cmp.size}` : `差异字节 ${cmp.diff} ${cmp.reason || ""}`) : "-"
    );
    await evaluate("window.__ov.clickSel('.ov-tool[title^=\"撤销\"]')");
    await sleep(120);
  }

  /* ---------------- 8. 调整选区范围（把手） ---------------- */
  {
    // 当前选区是 (200,150,400,300)。把手应有 8 个。
    const nHandles = await evaluate("document.querySelectorAll('.ov-handle').length");
    ok(nHandles === 8, "选区四角四边共 8 个把手", String(nHandles));

    const before = await evaluate("window.__ov.sel()");
    // 拖右边把手往右 100px → 宽度 +100，左/上/高不变
    const eHandle = await evaluate(`(() => {
      const el = document.querySelector('.ov-handle-e');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    ok(eHandle !== null, "找到右边把手", eHandle ? JSON.stringify(eHandle) : "-");
    if (eHandle) {
      await evaluate(`window.__ov.dragHold(document.querySelector('.ov-handle-e'), ${eHandle.x}, ${eHandle.y}, ${eHandle.x + 100}, ${eHandle.y})`);
      await sleep(120);
      // —— 拖动中（还没松手）就必须已经是「真实裁剪」，而不是旧图被 CSS 拉伸 ——
      //   a) 画布物理尺寸立刻跟上新范围（拉伸方案下画布还是旧尺寸）；
      //   b) 新露出的右侧内容 = 整屏帧在**绝对**坐标处的条纹相位
      //      （选区左边界固定 x=200；画布末尾第 10 列 → 绝对 x = 200 + w - 10）。
      const liveCv = await evaluate(`(() => {
        const c = document.querySelector('canvas.ov-canvas');
        if (!c) return null;
        const d = c.getContext('2d').getImageData(Math.max(0, c.width - 10), 8, 1, 1).data;
        return { w: c.width, h: c.height, px: [d[0], d[1], d[2], d[3]] };
      })()`);
      ok(
        liveCv && Math.abs(liveCv.w - (before.w + 100)) <= 3 && Math.abs(liveCv.h - before.h) <= 3,
        "拖动中画布实时按新范围重裁（尺寸立刻跟上，未等松手）",
        liveCv ? `拖动中画布 ${liveCv.w}x${liveCv.h}，期望约 ${before.w + 100}x${before.h}` : "-"
      );
      if (liveCv) {
        const expG = [40, 120, 200][(200 + (liveCv.w - 10)) % 3];
        ok(
          liveCv.px[0] === 0 && liveCv.px[1] === expG,
          "拖动中右侧新露出的像素 = 整屏帧在绝对坐标处的内容（真实裁剪，非拉伸）",
          `实际 rgb(${liveCv.px.slice(0, 3)})，期望 rgb(0,${expG},0)`
        );
      }
      await evaluate("window.__ovRelease()");
      await sleep(900); // 松手后要重取裁片
      const after = await evaluate("window.__ov.sel()");
      ok(
        after && Math.abs(after.w - (before.w + 100)) <= 2 && Math.abs(after.h - before.h) <= 2,
        "拖右边把手：宽度 +100、高度不变",
        after ? `宽 ${before.w} → ${after.w}，高 ${before.h} → ${after.h}` : "-"
      );
      ok(
        after && Math.abs(after.x - before.x) <= 2 && Math.abs(after.y - before.y) <= 2,
        "拖右边把手：左边界与上边界不动",
        after ? `(${before.x},${before.y}) → (${after.x},${after.y})` : "-"
      );
      // 画布应已按新范围重建
      const cv2 = await evaluate("window.__ov.canvas()");
      ok(
        cv2 && Math.abs(cv2.cw - after.w) <= 3,
        "调整范围后画布按新尺寸重建（1:1 显示）",
        cv2 && after ? `画布显示宽 ${cv2.cw}，选区宽 ${after.w}` : "-"
      );
    }
  }

  /* ---------------- 9. 选中 / 移动 / 改色 / 删除已有标注 ---------------- */
  {
    // 之前各节结束时都撤销了，此刻画布上只剩马赛克（在选区右下角）——
    // 先新画一个红色矩形当靶子，否则「点已有标注」根本无笔可命中。
    await evaluate("window.__ov.clickSel('.ov-tool[title=\"矩形\"]')");
    await evaluate("window.__ov.drag('.ov-sel', 260, 210, 340, 250)");
    await sleep(200);

    await evaluate("window.__ov.clickSel('.ov-tool[title=\"选择\"]')");
    await sleep(150);
    const sel = await evaluate("window.__ov.sel()");
    // 矩形窗口坐标 (260,210)-(340,250)：点它的内部（hitStroke 按包围盒 + 容差命中）
    const hitPoint = { x: sel.x + 100, y: sel.y + 80 };
    await evaluate(`window.__ov.drag('.ov-sel', ${hitPoint.x}, ${hitPoint.y}, ${hitPoint.x}, ${hitPoint.y})`);
    await sleep(250);
    const picked = await evaluate("!!document.querySelector('.ov-picked')");
    ok(picked === true, "点已有标注 → 出现选中高亮框");

    // 拖动选中的标注：往右下挪 40,30，红色像素包围盒应整体平移
    const sigBefore = await evaluate(`window.__ov.ink(${RED})`);
    await evaluate(`window.__ov.drag('.ov-sel', ${hitPoint.x}, ${hitPoint.y}, ${hitPoint.x + 40}, ${hitPoint.y + 30})`);
    await sleep(250);
    const sigAfter = await evaluate(`window.__ov.ink(${RED})`);
    ok(
      sigBefore && sigAfter && sigAfter.n > 0 && sigAfter.minX > sigBefore.minX && sigAfter.minY > sigBefore.minY,
      "拖动选中的标注 → 它真的移动了",
      sigBefore && sigAfter && sigAfter.n > 0 ? `包围盒 (${sigBefore.minX},${sigBefore.minY}) → (${sigAfter.minX},${sigAfter.minY})` : "-"
    );

    // 改颜色：选中状态下点**另一个**色板（第 2 个 = 橙 #ffaa00，不是当前的红），
    // 这一笔应立刻变色（红色像素随之消失）。
    await evaluate("document.querySelectorAll('.ov-color')[1].click()");
    await sleep(250);
    const afterColor = await evaluate(`window.__ov.ink(${RED})`);
    ok(
      afterColor && sigAfter && sigAfter.n > 0 && afterColor.n < sigAfter.n,
      "选中状态下改颜色 → 该标注换成新颜色（原色像素减少）",
      sigAfter && afterColor ? `${sigAfter.n} → ${afterColor.n} px` : "-"
    );

    // 删除：Delete 键移除选中的标注。用**橙色**计数（底图是绿色条纹、
    // ANY 会被不透明底图撑满到画布全亮，删除前后永远一样，测不出变化）。
    const ORANGE = "(r,g,b,a) => a > 0 && r > 200 && g > 100 && g < 220 && b < 100";
    const beforeDel = await evaluate(`window.__ov.ink(${ORANGE})`);
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))`);
    await sleep(250);
    const afterDel = await evaluate(`window.__ov.ink(${ORANGE})`);
    ok(
      beforeDel && beforeDel.n > 0 && afterDel && afterDel.n < beforeDel.n,
      "按 Delete 删除选中的标注（该标注颜色的像素减少）",
      beforeDel && afterDel ? `${beforeDel.n} → ${afterDel.n} px` : "-"
    );
    ok(
      (await evaluate("!!document.querySelector('.ov-picked')")) === false,
      "删除后选中框消失"
    );
  }

  /* ---------------- 9b. 文字：输入框透明 + 失去焦点即写入（Esc 不写） ---------------- */
  {
    // 先确保画布上没有别的红色内容干扰包围盒断言，并复位为红色
    await evaluate(`document.querySelectorAll('.ov-color')[0].click()`);
    await evaluate("window.__ov.clickSel('.ov-tool[title=\"文字\"]')");
    // 在画布内 rel (120,120) → 窗口 (320,270)
    await evaluate("window.__ov.drag('.ov-sel', 320, 270, 320, 270)");
    await sleep(250);
    const st1 = await evaluate(`(() => {
      const input = document.querySelector('.ov-text-input');
      if (!input) return null;
      const cs = getComputedStyle(input);
      return { bg: cs.backgroundColor, hasBlur: true };
    })()`);
    ok(st1 !== null, "文字工具的输入框出现", st1 ? JSON.stringify(st1) : "-");
    ok(
      st1 && (st1.bg === 'rgba(0, 0, 0, 0)' || st1.bg === 'transparent'),
      "文字输入框背景透明",
      st1 ? st1.bg : "-"
    );

    // 输入文字后**点画布别处**（不回车）→ 应因失焦而写入
    await evaluate(`(() => {
      const input = document.querySelector('.ov-text-input');
      input.value = '失焦写入';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(80);
    // 切到选择工具点一下别处：点画布 → mousedown → 失焦提交
    await evaluate("window.__ov.clickSel('.ov-tool[title=\"选择\"]')");
    await evaluate("window.__ov.drag('.ov-sel', 500, 400, 500, 400)");
    await sleep(300);
    const afterBlur = await evaluate(`(() => {
      const c = document.querySelector('canvas.ov-canvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0, minX = 1e9, minY = 1e9;
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        if (d[i + 3] > 0 && d[i] > 180 && d[i + 1] < 140 && d[i + 2] < 140) {
          n++; if (x < minX) minX = x; if (y < minY) minY = y;
        }
      }
      return { n, minX, minY, boxGone: !document.querySelector('.ov-textbox') };
    })()`);
    ok(afterBlur && afterBlur.n > 0, "失去焦点后文字写入画布（不用回车）", afterBlur ? `${afterBlur.n} px` : "-");
    ok(afterBlur && afterBlur.boxGone === true, "失去焦点后输入框关闭");
    ok(
      afterBlur && Math.abs(afterBlur.minX - 120) <= 6 && Math.abs(afterBlur.minY - 120) <= 6,
      "失焦写入的文字落在原点击处（画布内 rel 约 120,120）",
      afterBlur ? `实际左上 (${afterBlur.minX},${afterBlur.minY})` : "-"
    );
    await evaluate("window.__ov.clickSel('.ov-tool[title^=\"撤销\"]')");
    await sleep(120);

    // Esc 取消：输入文字后按 Esc，不得写入画布
    await evaluate("window.__ov.clickSel('.ov-tool[title=\"文字\"]')");
    await evaluate("window.__ov.drag('.ov-sel', 320, 270, 320, 270)");
    await sleep(200);
    await evaluate(`(() => {
      const input = document.querySelector('.ov-text-input');
      input.value = '不该出现';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    })()`);
    await sleep(300);
    const afterEsc = await evaluate(`(() => {
      const c = document.querySelector('canvas.ov-canvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] > 0 && d[i] > 180 && d[i + 1] < 140 && d[i + 2] < 140) n++;
      }
      return { n, boxGone: !document.querySelector('.ov-textbox') };
    })()`);
    ok(afterEsc && afterEsc.boxGone === true, "Esc 关闭文字输入框");
    ok(afterEsc && afterEsc.n === 0, "Esc 取消的文字不写入画布", afterEsc ? `${afterEsc.n} px` : "-");
  }

  /* ---------------- 9c. 模糊：自由涂抹的大画笔（不是方块） ---------------- */
  {
    // 底图是纯绿条纹（r=0）。模糊笔涂过之后，该区域的**绿色会向邻域平均**：
    // 判据用「绿色通道的方差下降」——条纹是三档跳变，模糊后档间过渡出现，
    // 方差显著变小；同时**笔迹外**的底图必须逐像素不变。
    // 采样区避开前面各节留下的标注（§5 的马赛克在 rel 300,150 一带）。
    // 注意 §8 调过范围，画布只有 ~501×300，取样必须在界内：
    // 取 rel (40,220) 起的一小块。
    const RX = 40, RY = 220, RW = 60, RH = 40;
    const sample = `(() => {
      const c = document.querySelector('canvas.ov-canvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const box = (x0, y0, w, h) => {
        let n = 0, s = 0, s2 = 0, red = 0;
        for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
          const i = (y * c.width + x) * 4;
          const g = d[i + 1];
          n++; s += g; s2 += g * g;
          if (d[i + 3] > 0 && d[i] > 180 && d[i + 1] < 140 && d[i + 2] < 140) red++;
        }
        const mean = s / n;
        return { mean, var: s2 / n - mean * mean, n, red };
      };
      return { inside: box(${RX}, ${RY}, ${RW}, ${RH}), outside: box(20, 20, 40, 30) };
    })()`;
    const before = await evaluate(sample);
    ok(
      before && before.inside.var > 100,
      "模糊前：采样区是明显的条纹（方差大，说明确有内容可糊）",
      before ? `方差 ${before.inside.var.toFixed(1)}` : "-"
    );
    await evaluate("window.__ov.clickSel('.ov-tool[title=\"模糊\"]')");
    // 在画布内 rel (40,220) 拖到 (100,260) → 窗口 (240,370)-(300,410)
    await evaluate("window.__ov.drag('.ov-sel', 240, 370, 300, 410)");
    await sleep(350);
    const after = await evaluate(sample);
    ok(
      before && after && after.inside.var < before.inside.var * 0.7,
      "模糊笔涂过的地方被糊掉（绿色方差显著下降）",
      before && after ? `方差 ${before.inside.var.toFixed(1)} → ${after.inside.var.toFixed(1)}` : "-"
    );
    ok(after && after.inside.n > 0 && after.inside.mean > 0, "模糊笔有可见效果（区域内有底图内容）",
      after ? `均值 ${after.inside.mean.toFixed(1)}` : "-");
    ok(
      before && after &&
        Math.abs(before.outside.mean - after.outside.mean) < 0.5 &&
        Math.abs(before.outside.var - after.outside.var) < 1,
      "模糊笔迹之外底图逐像素不变（只糊涂过的地方）",
      before && after ? `笔迹外方差 ${before.outside.var.toFixed(1)} → ${after.outside.var.toFixed(1)}` : "-"
    );
    // 模糊笔不应制造红色（它不画颜色，只糊底图）
    ok(after && after.inside.red === 0, "模糊笔不引入任何颜色（红色像素 0）", after ? `${after.inside.red}` : "-");
    await evaluate("window.__ov.clickSel('.ov-tool[title^=\"撤销\"]')");
    await sleep(150);
    const undone = await evaluate(sample);
    ok(
      before && undone && Math.abs(before.inside.var - undone.inside.var) < 1,
      "模糊笔可撤销（撤销后方差回到原值）",
      before && undone ? `${before.inside.var.toFixed(1)} vs ${undone.inside.var.toFixed(1)}` : "-"
    );
  }

  /* ---------------- 9d. 粗细按钮 + 包围盒控制点（写入后可再调整） ---------------- */
  {
    // 前面几节可能把当前颜色改成了别的，这里复位为红色再画靶子
    await evaluate(`document.querySelectorAll('.ov-color')[0].click()`);
    // 画一个矩形当靶子（选区窗口原点 (200,150)，故 rel (100,150) → 窗口 (300,300)）
    await evaluate("window.__ov.clickSel('.ov-tool[title=\"矩形\"]')");
    await evaluate("window.__ov.drag('.ov-sel', 300, 300, 400, 360)");
    await sleep(250);
    // 只统计矩形所在区域（rel 90..320 × 140..300），避免被别的标注干扰
    const inRect = `window.__ov.inkIn(${RED}, 90, 140, 230, 160)`;
    const boxOf = (r) => (r && r.n > 0 ? { n: r.n, w: r.maxX - r.minX + 1, h: r.maxY - r.minY + 1 } : { n: 0, w: 0, h: 0 });
    const rect0 = boxOf(await evaluate(inRect));
    ok(rect0.n > 0, "画了一个矩形（调整靶子）", `${rect0.n} px`);

    // 点到矩形内部选中它 → 出现四角控制点
    await evaluate("window.__ov.clickSel('.ov-tool[title=\"选择\"]')");
    await sleep(150);
    const inner = { x: 350, y: 330 };
    await evaluate(`window.__ov.drag('.ov-sel', ${inner.x}, ${inner.y}, ${inner.x}, ${inner.y})`);
    await sleep(250);
    const stubs = await evaluate("document.querySelectorAll('.ov-astub').length");
    ok(stubs === 4, "选中标注后出现 4 个包围盒控制点", `实际 ${stubs} 个`);

    // 拖右下角控制点把矩形放大 → 红色包围盒变大
    const pad0 = boxOf(await evaluate(inRect));
    const sePos = await evaluate(`(() => {
      const el = document.querySelector('.ov-astub-se');
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await evaluate(`window.__ov.drag('.ov-astub-se', ${sePos.x}, ${sePos.y}, ${sePos.x + 60}, ${sePos.y + 40})`);
    await sleep(250);
    const pad1 = boxOf(await evaluate(inRect));
    ok(
      pad0.n > 0 && pad1.n > 0 && pad1.w > pad0.w + 20 && pad1.h > pad0.h + 20,
      "拖右下角控制点 → 矩形被放大",
      `${pad0.w}×${pad0.h} → ${pad1.w}×${pad1.h}`
    );

    // 可撤销（缩放也记一次撤销点）
    await evaluate("window.__ov.clickSel('.ov-tool[title^=\"撤销\"]')");
    await sleep(200);
    const pad2 = boxOf(await evaluate(inRect));
    ok(
      Math.abs(pad2.w - pad0.w) <= 4 && Math.abs(pad2.h - pad0.h) <= 4,
      "缩放可撤销（回到缩放前的尺寸）",
      `${pad2.w}×${pad2.h} vs ${pad0.w}×${pad0.h}`
    );

    // 粗细按钮：选中矩形时点 ＋ → 该矩形变粗（红色像素增多）
    await evaluate(`window.__ov.drag('.ov-sel', ${inner.x}, ${inner.y}, ${inner.x}, ${inner.y})`);
    await sleep(200);
    const thin = boxOf(await evaluate(inRect));
    await evaluate(`[...document.querySelectorAll('.ov-tool.ov-w')].find(b => b.textContent.includes('＋')).click()`);
    await sleep(250);
    const thick = boxOf(await evaluate(inRect));
    ok(
      thick.n > thin.n,
      "选中的矩形点「＋」→ 变粗（红色像素增多）",
      `${thin.n} → ${thick.n} px`
    );

    // 文字：另起一条，拖控制点改字号。先把矩形彻底撤掉（+restyle / 缩放 / 矩形本身
    // 三步），否则红色的矩形落进文字采样窗、把测量值搅浑。
    for (let i = 0; i < 3; i++) {
      await evaluate("window.__ov.clickSel('.ov-tool[title^=\"撤销\"]')");
      await sleep(120);
    }
    await evaluate("window.__ov.clickSel('.ov-tool[title=\"文字\"]')");
    await evaluate("window.__ov.drag('.ov-sel', 320, 270, 320, 270)");
    await sleep(200);
    await evaluate(`(() => {
      const input = document.querySelector('.ov-text-input');
      input.value = 'WV';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await sleep(300);
    // 选中这条文字（落在 rel 120,120 → 窗口 320,270）
    await evaluate("window.__ov.clickSel('.ov-tool[title=\"选择\"]')");
    await sleep(150);
    await evaluate(`window.__ov.drag('.ov-sel', 322, 280, 322, 280)`);
    await sleep(250);
    const isTextSel = await evaluate("!!document.querySelector('.ov-astub-se')");
    ok(isTextSel, "选中文字标注后也有控制点");
    const inText = `window.__ov.inkIn(${RED}, 100, 100, 260, 200)`;
    const txt0 = boxOf(await evaluate(inText));
    const seT = await evaluate(`(() => {
      const el = document.querySelector('.ov-astub-se');
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await evaluate(`window.__ov.drag('.ov-astub-se', ${seT.x}, ${seT.y}, ${seT.x + 30}, ${seT.y + 40})`);
    await sleep(250);
    const txt1 = boxOf(await evaluate(inText));
    ok(
      txt0.n > 0 && txt1.n > txt0.n * 1.3 && txt1.h >= txt0.h,
      "拖文字标注控制点 → 字号变大（红色像素显著增多、包围盒不低于原高）",
      `像素 ${txt0.n} → ${txt1.n}，高 ${txt0.h} → ${txt1.h}`
    );
    // 收尾：清干净这一节
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))`);
    await sleep(120);
    await evaluate("window.__ov.clickSel('.ov-tool[title^=\"撤销\"]')");
    await sleep(150);
  }

  /* ---------------- 10. 按 C 取色：C 进入采集 → 按下确认复制 → 已复制提示 ---------------- */
  {
    // 底图是 1px 周期的绿色条纹：g = STRIPE[x % 3]，r = b = 0（sf=1，物理=窗口）。
    // 光标停在 x=301 → 301 % 3 = 1 → g = 120 → HEX 应为 #007800。
    const P = { x: 301, y: 200 };
    const readChip = `(() => {
      const el = document.querySelector('.ov-pick');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        hex: (el.querySelector('.ov-pick-hex') || {}).textContent || '',
        rgb: (el.querySelector('.ov-pick-rgb') || {}).textContent || '',
        x: r.left, y: r.top,
      };
    })()`;
    await evaluate(`document.querySelector('.ov-root').dispatchEvent(new MouseEvent('mousemove', { clientX: ${P.x}, clientY: ${P.y}, bubbles: true }))`);
    await sleep(60);
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }))`);
    await sleep(150);
    const chip = await evaluate(readChip);
    ok(chip !== null, "按 C 进入采集：弹出色值芯片");
    if (chip) {
      ok(chip.hex === '#007800', "芯片 HEX = 光标处冻结帧像素", `实际 ${chip.hex}，期望 #007800`);
      ok(chip.rgb === 'rgb(0, 120, 0)', "芯片显示 RGB", `实际 ${chip.rgb}`);
      ok(Math.abs(chip.x - (P.x + 14)) <= 1 && Math.abs(chip.y - (P.y + 14)) <= 1,
        "芯片摆在光标右下", `实际 (${chip.x},${chip.y})，期望 (${P.x + 14},${P.y + 14})`);
    }
    const beforeCopy = await evaluate("window.__lastCopyText");
    ok(beforeCopy == null, "采集阶段不复制：按 C 只出芯片，HEX 未进剪贴板", String(beforeCopy));

    // 采集态移动光标 → 芯片跟随并实时取样（x=320 → 320 % 3 = 2 → g = 200 → #00c800）
    const P2 = { x: 320, y: 210 };
    await evaluate(`document.querySelector('.ov-root').dispatchEvent(new MouseEvent('mousemove', { clientX: ${P2.x}, clientY: ${P2.y}, bubbles: true }))`);
    await sleep(80);
    const chip2 = await evaluate(readChip);
    ok(chip2 && chip2.hex === '#00c800', "采集态芯片跟随光标实时更新色值",
      chip2 ? `实际 ${chip2.hex}，期望 #00c800` : "芯片不见了");
    ok(chip2 && Math.abs(chip2.x - (P2.x + 14)) <= 1 && Math.abs(chip2.y - (P2.y + 14)) <= 1,
      "芯片跟随到新位置", chip2 ? `实际 (${chip2.x},${chip2.y})` : "-");

    // 按下 = 确认：复制最新色值 + 弹「已复制」提示 + 这一下被吞掉（不动选区）
    const selBefore = await evaluate("window.__ov.sel()");
    await evaluate(`document.querySelector('.ov-sel.ov-active').dispatchEvent(new MouseEvent('mousedown', { clientX: ${P2.x}, clientY: ${P2.y}, bubbles: true }))`);
    await sleep(80);
    const copied = await evaluate("window.__lastCopyText");
    ok(copied === '#00c800', "按下鼠标才复制 HEX（复制的是确认那一刻的色值）", String(copied));
    const hint = await evaluate(`(() => {
      const h = document.querySelector('.ov-pick .ov-pick-ok');
      return h ? h.textContent : null;
    })()`);
    ok(!!hint && hint.includes('已复制'), "复制后芯片显示「已复制」提示", String(hint));
    const selAfter = await evaluate("window.__ov.sel()");
    ok(selBefore && selAfter && selBefore.x === selAfter.x && selBefore.w === selAfter.w,
      "确认的那一下被吞掉（没有开始拖动选区）",
      selBefore && selAfter ? `(${selBefore.x},${selBefore.w}) → (${selAfter.x},${selAfter.w})` : "-");
    // 提示短暂展示后自动收起（关闭颜色采集）
    await sleep(1400);
    ok((await evaluate("!!document.querySelector('.ov-pick')")) === false, "「已复制」提示自动收起，采集关闭");
    await evaluate(`document.querySelector('.ov-sel.ov-active').dispatchEvent(new MouseEvent('mouseup', { clientX: ${P2.x}, clientY: ${P2.y}, bubbles: true }))`);

    // Esc 取消采集：收芯片、不复制，也不连带关掉截图
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }))`);
    await sleep(120);
    ok((await evaluate("!!document.querySelector('.ov-pick')")) === true, "可再次进入采集");
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(60);
    ok((await evaluate("!!document.querySelector('.ov-pick')")) === false, "按 Esc 取消采集（收起芯片）");
    ok((await evaluate("window.__ov.sel()"))?.active === true, "Esc 只收芯片，截图遮罩仍在编辑态");
    ok((await evaluate("window.__lastCopyText")) === '#00c800', "Esc 取消不复制（剪贴板未被覆盖）",
      String(await evaluate("window.__lastCopyText")));

    // Ctrl+C 不进入采集（组合键留给复制语义）
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }))`);
    await sleep(60);
    ok((await evaluate("!!document.querySelector('.ov-pick')")) === false, "Ctrl+C 不弹取色芯片");
  }

  /* ---------------- 11. 无未捕获异常 ---------------- */
  ok(pageErrors.length === 0, "全程无未捕获的页面异常", pageErrors.slice(0, 3).join(" | "));

  /* ---------------- 12. 高分屏（scaleFactor=1.5）：模糊涂抹与鼠标轨迹必须对齐 ---------------- *
   *
   * 历史 bug：模糊裁片是按**物理像素**生成的，但贴回主画布时主画布已经被
   * scale(sf) 变换过，直接 drawImage 会被**再乘一次 sf**——裁片又放大又跑位，
   * 表现为「模糊涂抹与真实效果不一致、位置偏移」。sf=1 时恰好无差别，所以
   * 前面的小节全都测不出来，必须专门用 sf=1.5 跑一遍。
   *
   * 判据：涂一条水平线 → 「涂前/涂后」逐像素 diff 的变化带，其**中心 y** 必须
   * 与鼠标轨迹的 y 重合，**带宽**必须≈刷子宽度（不是 ×1.5）。
   *
   * 缩放靠**改写注入脚本**再导航生效：INJECT 是 addScriptToEvaluateOnNewDocument
   * 注入的，页面重载后会重新执行，所以重设一次带 sf=1.5 的版本即可。
   */
  await send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__scaleFactor = 1.5;" });
  await send("Page.navigate", { url: `${base}/overlay.html?monitor=0` });
  await sleep(1200);
  // 重新注入拖拽辅助（页面已重载）
  await evaluate("window.__ov.clickSel && true");
  {
    // 框选一块区域（物理尺寸应为 CSS × 1.5）
    await evaluate("window.__ov.drag('.ov-root', 300, 250, 900, 650)");
    await sleep(700);
    const cm = await evaluate(`(() => {
      const c = document.querySelector('canvas.ov-canvas');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { cw: c.width, ch: c.height, rw: r.width, rh: r.height, left: r.left, top: r.top, sf: c.width / r.width };
    })()`);
    ok(cm && Math.abs(cm.sf - 1.5) < 0.01, "高分屏：画布按 scaleFactor=1.5 放大（物理像素 = CSS × 1.5）",
      cm ? `画布 ${cm.cw}×${cm.ch}，CSS ${cm.rw.toFixed(0)}×${cm.rh.toFixed(0)}，sf=${cm.sf}` : "没进编辑态");

    const snap = `(() => { const c=document.querySelector('canvas.ov-canvas'); const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data; window.__snapA = new Uint8ClampedArray(d); return d.length; })()`;
    const diffBox = `(() => {
      const c = document.querySelector('canvas.ov-canvas');
      const rc = c.getBoundingClientRect();
      const sf = c.width / rc.width;
      const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      const A = window.__snapA;
      let n=0,minX=1e9,minY=1e9,maxX=-1,maxY=-1;
      for (let i=0;i<d.length;i+=4){
        if (Math.abs(d[i]-A[i])+Math.abs(d[i+1]-A[i+1])+Math.abs(d[i+2]-A[i+2]) > 24){
          const p=i/4, x=p%c.width, y=(p/c.width)|0;
          n++; if(x<minX)minX=x; if(y<minY)minY=y; if(x>maxX)maxX=x; if(y>maxY)maxY=y;
        }
      }
      if(!n) return { n:0 };
      return { n, minY: rc.top+minY/sf, maxY: rc.top+maxY/sf, hPx: (maxY-minY+1)/sf,
               minX: rc.left+minX/sf, maxX: rc.left+maxX/sf, wPx: (maxX-minX+1)/sf };
    })()`;

    // 水平涂抹：变化带中心 y 必须 = 轨迹 y
    const yLine = cm.top + 180;
    await evaluate(snap);
    await evaluate("window.__ov.clickSel('.ov-tool[title=\"模糊\"]')");
    await evaluate(`window.__ov.drag('.ov-sel', ${cm.left + 100}, ${yLine}, ${cm.left + cm.rw - 100}, ${yLine})`);
    await sleep(450);
    const bh = await evaluate(diffBox);
    ok(bh && bh.n > 0, "高分屏：模糊确实改变了像素", bh ? `${bh.n} 个` : "-");
    if (bh && bh.n > 0) {
      const midY = (bh.minY + bh.maxY) / 2;
      ok(Math.abs(midY - yLine) <= 14, "高分屏：水平涂抹的模糊带与轨迹 y 对齐（无整体偏移）",
        `中心 y=${midY.toFixed(1)} vs 轨迹 ${yLine}（偏差 ${(midY - yLine).toFixed(1)}px）`);
      ok(Math.abs(bh.hPx - 36) <= 22, "高分屏：模糊带高度≈刷子宽 36 CSS px（没被 sf 二次放大）",
        `实测 ${bh.hPx.toFixed(1)}px`);
    }
    // 撤销后竖直涂抹：变化带中心 x 必须 = 轨迹 x
    await evaluate("window.__ov.clickSel('.ov-tool[title^=\"撤销\"]')");
    await sleep(200);
    const xLine = cm.left + 400;
    await evaluate(snap);
    await evaluate("window.__ov.clickSel('.ov-tool[title=\"模糊\"]')");
    await evaluate(`window.__ov.drag('.ov-sel', ${xLine}, ${cm.top + 100}, ${xLine}, ${cm.top + cm.rh - 100})`);
    await sleep(450);
    const bv = await evaluate(diffBox);
    if (bv && bv.n > 0) {
      const midX = (bv.minX + bv.maxX) / 2;
      ok(Math.abs(midX - xLine) <= 14, "高分屏：竖直涂抹的模糊带与轨迹 x 对齐",
        `中心 x=${midX.toFixed(1)} vs 轨迹 ${xLine}（偏差 ${(midX - xLine).toFixed(1)}px）`);
      ok(Math.abs(bv.wPx - 36) <= 22, "高分屏：模糊带宽度≈刷子宽 36 CSS px", `实测 ${bv.wPx.toFixed(1)}px`);
    } else {
      ok(false, "高分屏：竖直涂抹有可见效果", bv ? `${bv.n} 个` : "-");
    }
  }
} catch (e) {
  fail++;
  console.log("FAIL  测试执行出错 —", e.message);
} finally {
  try {
    ws?.close();
  } catch {}
  chrome.kill();
  server.close();
}

console.log(`\n截图遮罩 UI：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
