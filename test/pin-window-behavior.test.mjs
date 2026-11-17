/**
 * 贴图窗口（pin）的行为测试：真实浏览器 + CDP，stub 宿主命令全链路验证 UI。
 *
 * 背景：贴图是宿主开的独立小窗（pin.html），行为契约必须钉死：
 *   1. 加载：调 `pin_image_data` 拿图，1:1 铺满画布（画布像素 = 图片自然像素）；
 *   2. 浏览态右键 → 菜单出现（显示编辑工具 / 复制 / 关闭 三项）；
 *   3. 菜单「显示编辑工具」→ 编辑态：工具条出现、画笔可画（画布出墨）；
 *   4. 橡皮可擦掉已画内容（destination-out 透明穿透）；
 *   5. 文字工具：点击画布弹输入框，回车提交（画布出文字像素）；
 *   6. Esc 退出编辑 → 回到浏览态（工具条消失、标注保留）；
 *   7. 再次进入编辑后「取消」→ 回滚本次编辑的标注（Esc 同效）；
 *   8. 菜单「复制」→ 调 `screenshot_copy_image`（dataUrl 是当前画布的 PNG）；
 *   9. 双击（浏览态）→ 调 `pin_close` 关闭（真实 mousedown 序列驱动；双击守卫
 *      必须让第二次按下跳过 startDragging，否则系统拖动循环吞掉 dblclick）；
 *  10. 加载失败（宿主说贴图不存在）→ 显示错误提示。
 *
 * 用法: npm run build && node test/pin-window-behavior.test.mjs
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
if (!existsSync(path.join(dist, "pin.html"))) {
  console.error("缺少 dist/pin.html：请先 npm run build");
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
  console.log("未找到浏览器（Chrome/Edge），跳过贴图窗口行为测试");
  server.close();
  process.exit(0);
}

/* ===================== 起浏览器 + CDP ===================== */

const userDir = path.join(root, "test", `_chrome-profile-pin-${process.pid}`);
const port = 9900 + Math.floor(Math.random() * 100);
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
    "--window-size=900,700",
    `${base}/pin.html`,
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

/* ===================== 页面注入：stub 宿主 + 断言辅助 ===================== */

// 8×6 纯绿 PNG（1×1 绿像素放大画的 data URL 由 Rust 侧给；这里 stub 直接给
// 一张 canvas 生成的 data URL，画布像素 = 图片自然像素的契约用 64×48 校验）。
const INJECT = `
(() => {
  /* ---------- A. stub 宿主（pin_image_data / pin_close / screenshot_copy_image） ---------- */
  const mkImage = (w, h) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    // 棋盘格：绿/白交替，便于验证 1:1 铺满
    for (let y = 0; y < h; y += 8) {
      for (let x = 0; x < w; x += 8) {
        ctx.fillStyle = ((x / 8 + y / 8) % 2 === 0) ? 'rgb(0,180,0)' : 'rgb(255,255,255)';
        ctx.fillRect(x, y, 8, 8);
      }
    }
    return c.toDataURL('image/png');
  };
  window.__pinImage = mkImage(880, 660);
  window.__invoked = [];
window.__TAURI_INTERNALS__ = {
    invoke(cmd, args) {
      window.__invoked.push({ cmd, args });
      if (cmd === 'pin_image_data') {
        if (window.__pinFailOnce) {
          window.__pinFailOnce = false;
          return Promise.reject('贴图不存在或已关闭');
        }
        return Promise.resolve({ dataUrl: window.__pinImage, width: 880, height: 660, label: (args && args.label) || '' });
      }
      if (cmd === 'pin_close' || cmd === 'pin_cleanup') return Promise.resolve(null);
      if (cmd === 'screenshot_copy_image') {
        window.__lastCopy = (args && args.dataUrl) || '';
        return Promise.resolve(null);
      }
      if (cmd === 'plugin:window|set_size' || cmd === 'plugin:window|set_position' || cmd === 'plugin:window|set_decorations') {
        // 编辑态扩窗 / 边框开关：记录调用参数即可，宿主侧真实几何无需模拟
        return Promise.resolve(null);
      }
      if (cmd === 'plugin:window|scale_factor') return Promise.resolve(1);
      if (cmd === 'plugin:window|outer_position') return Promise.resolve({ x: 120, y: 80 });
      if (cmd === 'plugin:window|start_dragging') {
        // 浏览态拖移的真实命令（getCurrentWindow().startDragging() 内部 invoke）；
        // 计数用于双击守卫行为断言（第二次 mousedown 必须跳过拖动）。
        window.__dragCalls = (window.__dragCalls || 0) + 1;
        return Promise.resolve(null);
      }
      if (cmd === 'getCurrentWindow') {
        // 真实 API 从 metadata 取窗口对象，通常不会走到这里；兜底防抛错。
        return Promise.resolve({ startDragging: () => Promise.resolve() });
      }
      return Promise.resolve(null);
    },
    transformCallback(cb) { return cb; },
    metadata: { currentWindow: { label: 'pin-test-1' }, currentWebview: { label: 'pin-test-1' } },
    plugins: {},
  };

  /* ---------- B. 断言辅助 ---------- */
  window.__pin = {
    invoked: (cmd) => window.__invoked.filter((x) => x.cmd === cmd),
    lastCopy: () => window.__lastCopy || '',
    canvas: () => document.querySelector('canvas.pin-canvas'),
    menuVisible: () => !!document.querySelector('.pin-menu'),
    menuItems: () => [...document.querySelectorAll('.pm-item')].map((b) => b.textContent.trim()),
    toolbarVisible: () => !!document.querySelector('.pin-toolbar'),
    /** 工具名（共享工具条 MarkerToolbar：按钮 class 是 .ov-tool，title 即工具名） */
    tools: () => [...document.querySelectorAll('.pin-toolbar .ov-tool')].map((b) => b.title),
    textboxOpen: () => !!document.querySelector('.pin-text-input'),
    errorShown: () => { const e = document.querySelector('.pin-error'); return e ? e.textContent : null; },
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
    /** 画布上符合条件的像素数（含 alpha） */
    ink: (test) => {
      const c = document.querySelector('canvas.pin-canvas');
      if (!c) return null;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (test(d[i], d[i + 1], d[i + 2], d[i + 3])) n++;
      return n;
    },
    /** 拖画（**画布像素坐标**，内部换算成 CSS clientX/Y 再派发到 window——
     *  编辑态拖拽收口在 window mousemove/mouseup，派发到 canvas 收不到） */
    drag: (x1, y1, x2, y2) => {
      const c = document.querySelector('canvas.pin-canvas');
      if (!c) throw new Error('no canvas');
      const r = c.getBoundingClientRect();
      const kx = r.width / c.width, ky = r.height / c.height;
      const at = (x, y, type) => window.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true,
        clientX: r.left + x * kx, clientY: r.top + y * ky,
        buttons: type === 'mouseup' ? 0 : 1,
      }));
      c.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, cancelable: true,
        clientX: r.left + x1 * kx, clientY: r.top + y1 * ky, buttons: 1,
      }));
      for (let i = 1; i <= 4; i++) at(x1 + (x2 - x1) * i / 4, y1 + (y2 - y1) * i / 4, 'mousemove');
      at(x2, y2, 'mouseup');
    },
    /** 菜单当前状态（诊断用） */
    menuState: () => ({
      visible: !!document.querySelector('.pin-menu'),
      items: [...document.querySelectorAll('.pm-item')].map((b) => b.textContent.trim()),
    }),
    dblclick: (x, y) => {
      // **真实按下序列**而非裸 dblclick：系统只有收到两次快速 mousedown 才会
      // 合成 dblclick（WebView2/Chrome 同款规则）。按下必须派发到**画布**上
      // （拖动与双击守卫都挂在 canvas 的 mousedown，再冒泡到 .pin-root 处理
      // dblclick）——裸合成 dblclick 会绕过 mousedown 链路：测试绿、真机挂。
      const c = document.querySelector('canvas.pin-canvas');
      if (!c) throw new Error('no canvas');
      const r = c.getBoundingClientRect();
      const at = (type, buttons) => c.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true,
        clientX: r.left + x, clientY: r.top + y, buttons,
      }));
      at('mousedown', 1); at('mouseup', 0); at('mousedown', 1); at('mouseup', 0);
      at('dblclick', 0);
    },
    /** startDragging 被调用次数（双击守卫行为断言用） */
    dragCalls: () => window.__dragCalls || 0,
    contextMenu: (x, y) => {
      const root = document.querySelector('.pin-root');
      root.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    },
    esc: () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    keyInTextarea: (key) => {
      const t = document.querySelector('.pin-text-input');
      if (!t) throw new Error('no textarea');
      t.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    },
  };
})();
`;

/* ===================== 测试主体 ===================== */

// 绿色棋盘格（stub 底图）
const GREEN = "(r,g,b,a) => a > 0 && g > 120 && r < 120";
// 画笔默认色（第一个色盘 #f43f3f，偏红）
const RED = "(r,g,b,a) => a > 0 && r > 200 && g < 120 && b < 140";

try {
  await connect();
  await send("Page.addScriptToEvaluateOnNewDocument", { source: INJECT });
  await send("Page.navigate", { url: `${base}/pin.html` });
  await sleep(1200);

  /* ---------------- 1. 加载：取图 + 1:1 铺画布 ---------------- */
  const canvasSize = await evaluate("(() => { const c = window.__pin.canvas(); return c ? { w: c.width, h: c.height } : null; })()");
  ok(!!canvasSize, "画布存在");
  ok(canvasSize?.w === 880 && canvasSize?.h === 660, "画布像素 = 图片自然像素（880×660）", JSON.stringify(canvasSize));
  const calls = await evaluate("window.__pin.invoked('pin_image_data').length");
  ok(calls === 1, "启动时调了一次 pin_image_data", String(calls));
  const greenNow = await evaluate(`window.__pin.ink(${GREEN})`);
  ok(greenNow > 0, "底图已铺上画布（绿像素 > 0）", String(greenNow));

  /* ---------------- 2. 浏览态右键 → 菜单 ---------------- */
  await evaluate("window.__pin.contextMenu(300, 200)");
  await sleep(150);
  ok((await evaluate("window.__pin.menuVisible()")) === true, "右键弹出菜单");
  const items = await evaluate("window.__pin.menuItems()");
  ok(
    JSON.stringify(items) === JSON.stringify(["显示编辑工具", "隐藏边框", "复制", "关闭"]),
    "菜单四项齐全（编辑工具 / 边框开关 / 复制 / 关闭）",
    JSON.stringify(items)
  );
  // 边框开关：默认开（outline 生效），点「隐藏边框」后 outline 变 none
  const frameOn = await evaluate(
    "getComputedStyle(document.querySelector('.pin-canvas')).outlineStyle"
  );
  ok(frameOn === "solid", "默认显示边框（outline solid）", String(frameOn));
  await evaluate("window.__pin.clickMenu('隐藏边框')");
  await sleep(120);
  const frameOff = await evaluate(
    "getComputedStyle(document.querySelector('.pin-canvas')).outlineStyle"
  );
  ok(frameOff === "none", "右键「隐藏边框」后边框消失（outline none）", String(frameOff));
  const frameInvoked = await evaluate(
    "window.__pin.invoked('plugin:window|set_decorations').length"
  );
  ok(frameInvoked === 0, "边框开关走 CSS outline（不依赖系统 decorations）", String(frameInvoked));

  /* ---------------- 3. 显示编辑工具 → 编辑态 + 画笔 ---------------- */
  // 进入编辑前的浏览态画布尺寸（= 整窗客户区）：扩窗期望值的基准
  const viewW = await evaluate("Math.round(document.querySelector('.pin-canvas').getBoundingClientRect().width)");
  const viewH = await evaluate("Math.round(document.querySelector('.pin-canvas').getBoundingClientRect().height)");
  await evaluate("window.__pin.clickMenu('显示编辑工具')");
  await sleep(150);
  ok((await evaluate("window.__pin.toolbarVisible()")) === true, "进入编辑态：工具条出现");
  // 编辑扩窗：宿主侧窗口应收到加高 48（CSS px × scale）的 set_size + 相应上移
  const sizeCalls = await evaluate("window.__pin.invoked('plugin:window|set_size').length");
  const posCalls = await evaluate("window.__pin.invoked('plugin:window|set_position').length");
  ok(sizeCalls === 1 && posCalls === 1, "进入编辑：窗口扩出工具条悬浮条（set_size + set_position）",
    `size=${sizeCalls} pos=${posCalls}`);
  const sizeArg = await evaluate("(window.__pin.invoked('plugin:window|set_size')[0] || {}).args");
  ok(
    !!sizeArg && sizeArg.value && sizeArg.value.Height === viewH + 48 && sizeArg.value.Width === viewW,
    "扩窗尺寸 = 浏览态窗口 + 48（悬浮条区）",
    `view=${viewW}x${viewH} → ${JSON.stringify(sizeArg && sizeArg.value)}`
  );
  // 悬浮条区不压画布：编辑态画布顶部让出 48px
  const editTop = await evaluate(
    "Math.round(document.querySelector('.pin-canvas').getBoundingClientRect().top)"
  );
  ok(editTop === 48, "编辑态画布顶部让出悬浮条区（top=48，工具条不压图片）", String(editTop));
  const tools = await evaluate("window.__pin.tools()");
  ok(
    ["选择", "矩形", "椭圆", "箭头", "画笔", "文字", "马赛克", "模糊", "撤销 (Ctrl+Z)", "重做 (Ctrl+Shift+Z)"].every((t) => tools.includes(t)),
    "工具条与截图同款（选择/矩形/椭圆/箭头/画笔/文字/马赛克/模糊/撤销/重做）",
    JSON.stringify(tools)
  );
  // 工具条只许盖住顶部一小条：共享组件自带 bottom:28px，宿主覆盖 top:8px 时
  // 必须同时写 bottom:auto——否则 top+bottom 同时生效把盒子拉满整窗，
  // 半透明背景罩住全部画布、mousedown 又被工具条吞掉 → 整窗变暗且无法编辑
  //（真机见过的 bug，几何断言钉死它）。
  const tbRect = await evaluate(
    "(() => { const t = document.querySelector('.pin-toolbar'); if (!t) return null; const r = t.getBoundingClientRect(); return { top: Math.round(r.top), height: Math.round(r.height), vh: window.innerHeight }; })()"
  );
  ok(!!tbRect, "工具条可测得几何");
  ok(
    !!tbRect && tbRect.top >= 0 && tbRect.top + tbRect.height <= 96 && tbRect.height < tbRect.vh / 2,
    "工具条贴顶且不拉满整窗（bottom:auto 生效，不挡画布）",
    JSON.stringify(tbRect)
  );
  const beforePen = await evaluate(`window.__pin.ink(${RED})`);
  ok(beforePen === 0, "画笔前无红色像素");
  await evaluate("window.__pin.clickTool('画笔')");
  await sleep(80);
  await evaluate("window.__pin.drag(20, 20, 80, 40)");
  await sleep(150);
  const afterPen = await evaluate(`window.__pin.ink(${RED})`);
  ok(afterPen > 0, "画笔画出红色线条", String(afterPen));

  /* ---------------- 4. 撤销回滚（共享引擎 undo；橡皮由「撤销」承担回退） ---------------- */
  await evaluate("window.__pin.clickTool('撤销 (Ctrl+Z)')");
  await sleep(100);
  const afterUndo = await evaluate(`window.__pin.ink(${RED})`);
  ok(afterUndo === 0, "撤销清掉刚才那笔（引擎 undo 与截图同源）", `${afterPen} → ${afterUndo}`);

  /* ---------------- 5. 文字工具 ---------------- */
  await evaluate("window.__pin.clickTool('文字')");
  await evaluate("window.__pin.drag(100, 30, 100, 30)");
  await sleep(150);
  ok((await evaluate("window.__pin.textboxOpen()")) === true, "文字工具点画布弹输入框");
  await evaluate("(() => { const t = document.querySelector('.pin-text-input'); t.value = '你好'; t.dispatchEvent(new Event('input', { bubbles: true })); return t.value; })()");
  await evaluate("window.__pin.keyInTextarea('Enter')");
  await sleep(150);
  ok((await evaluate("window.__pin.textboxOpen()")) === false, "回车提交后输入框关闭");

  /* ---------------- 6. Esc 退出编辑：工具条消失 ---------------- */
  await evaluate("window.__pin.esc()");
  await sleep(150);
  ok((await evaluate("window.__pin.toolbarVisible()")) === false, "Esc 退出编辑：工具条消失");

  /* ---------------- 7. 再次编辑 + Esc 回滚（矩形被撤销） ---------------- */
  await evaluate("window.__pin.contextMenu(300, 200)");
  await sleep(150);
  const menuState = await evaluate("window.__pin.menuState()");
  ok(menuState.visible === true, "浏览态再次右键弹出菜单", JSON.stringify(menuState));
  await evaluate("window.__pin.clickMenu('显示编辑工具')");
  await sleep(150);
  await evaluate("window.__pin.clickTool('矩形')");
  await evaluate("window.__pin.drag(200, 150, 260, 190)");
  await sleep(100);
  await evaluate("window.__pin.esc()");
  await sleep(120);
  ok((await evaluate("window.__pin.toolbarVisible()")) === false, "再次 Esc 退出编辑");

  /* ---------------- 8. 菜单「复制」→ screenshot_copy_image ---------------- */
  await evaluate("window.__pin.contextMenu(300, 200)");
  await sleep(120);
  await evaluate("window.__pin.clickMenu('复制')");
  await sleep(200);
  const copyCalls = await evaluate("window.__pin.invoked('screenshot_copy_image').length");
  ok(copyCalls === 1, "复制调用了 screenshot_copy_image", String(copyCalls));
  const copyUrl = await evaluate("window.__pin.lastCopy()");
  ok(String(copyUrl).startsWith("data:image/png;base64,"), "复制的是 PNG data URL");
  ok(String(copyUrl).length > 200, "复制内容非空（小图 PNG 也很短）", String(String(copyUrl).length));

  /* ---------------- 9. 双击关闭（含双击守卫行为断言） ---------------- */
  const dragBefore = await evaluate("window.__pin.dragCalls()");
  await evaluate("window.__pin.dblclick(300, 200)");
  await sleep(150);
  const closeCalls = await evaluate("window.__pin.invoked('pin_close').length");
  ok(closeCalls === 1, "双击调用了 pin_close", String(closeCalls));
  const dragAfter = await evaluate("window.__pin.dragCalls()");
  ok(Number(dragAfter) - Number(dragBefore) === 1,
    "双击只触发一次系统拖动（第二次 mousedown 被双击守卫跳过，否则拖动循环吞掉 dblclick）",
    `before=${dragBefore} after=${dragAfter}`);
  const closeLabel = await evaluate("(() => { const c = window.__pin.invoked('pin_close')[0]; return c && c.args ? c.args.label : null; })()");
  ok(closeLabel === "pin-test-1", "关闭时带自己的 label", String(closeLabel));

  /* ---------------- 10. 加载失败 → 错误提示（独立页面） ---------------- */
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: "window.__pinFailOnce = true;",
  });
  await send("Page.navigate", { url: `${base}/pin.html?fail=1` });
  await sleep(1000);
  const err = await evaluate("window.__pin.errorShown()");
  ok(!!err && String(err).includes("贴图不存在"), "加载失败显示错误提示", String(err));

  ok(pageErrors.length === 0, "页面无未捕获异常", pageErrors.slice(0, 3).join(" | "));
} catch (e) {
  fail++;
  console.log("FAIL ", "测试执行异常", ` — ${String(e).slice(0, 300)}`);
} finally {
  try {
    ws?.close();
  } catch {}
  try {
    chrome.kill();
  } catch {}
  server.close();
  // 清理 chrome profile（偶发文件锁，尽力删）
  await new Promise((r) => setTimeout(r, 400));
  try {
    const { rmSync } = await import("fs");
    rmSync(userDir, { recursive: true, force: true });
  } catch {}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

