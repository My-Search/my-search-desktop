/**
 * 待办清单「统一底色 + 标题前状态圆点」的真实浏览器渲染验证。
 *
 * 本测试在真实浏览器里加载插件 detail.html（桩掉宿主注入的全局），用
 * **真实 UI** 添加三档优先级的待办，然后断言计算样式：
 *
 *   1. 行底色统一：三档行的 backgroundColor 完全一致（= 卡片底），
 *      且行上没有任何 inset 色条；
 *   2. 状态圆点：紧急行红点 / 普通行黄点 / 低行绿点（= --todo-* 变量色）；
 *   3. 行内不再出现优先级 chip（状态只走圆点）；
 *   4. 列表有数据时 #todo-empty 真正隐藏（display:none），筛选无结果时
 *      显示「当前筛选下没有条目」——display:flex 顶掉 hidden 的回归钉；
 *   5. 勾选完成后行灰底、圆点灰化；逾期项保留警示边框；
 *   6. 深色主题（覆盖宿主 token）下底色跟着 --card 变（放在最后，
 *      避免影响前面浅色断言的期望值）。
 *
 * 用法: node test/todo-priority-render.test.mjs
 * 需要本机装有 Chrome / Edge；找不到浏览器时跳过（退出码 0）。
 */
import { spawn, execFileSync } from "child_process";
import { request as httpRequest } from "http";
import { existsSync, readFileSync, appendFileSync, rmSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = path.join(root, "plugins", "com.zhuangjie.todo-list", "ui");
/* 落盘日志：headless 环境下进程被外层工具杀掉时 stdout 缓冲会丢，写文件保住现场 */
const LOG_PATH = path.join(root, "test", "_todo-render-trace.log");
const log = (m) => {
  try { appendFileSync(LOG_PATH, new Date().toISOString().slice(11, 23) + " " + m + "\n"); } catch {}
};
log("module: loaded");

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

const candidates = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];
const bin = candidates.find((p) => existsSync(p));
if (!bin) {
  console.log("未找到浏览器（Chrome/Edge），跳过待办优先级渲染测试");
  process.exit(0);
}

const userDir = path.join(root, "test", `_chrome-profile-todo-${process.pid}`);
const cdpPort = 10300 + Math.floor(Math.random() * 300);
/* file:// 直载插件页面：不需要静态服务器（也少一个 listen 挂点） */
const pageUrl =
  "file:///" + path.join(pluginDir, "detail.html").replace(/\\/g, "/");
log("module: browser " + bin + " cdp " + cdpPort);

const chrome = spawn(
  bin,
  [
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDir}`,
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--window-size=900,800",
    pageUrl,
  ],
  { stdio: ["ignore", "ignore", "pipe"] }
);
chrome.stderr.on("data", (d) => {
  const s = String(d);
  if (/DevTools|Listening|ERROR|error/i.test(s)) log("chrome: " + s.trim().split(/\r?\n/).slice(0, 3).join(" | "));
});

/** 轮询 CDP /json/list 拿页面 target（带 20s 超时）。
 *
 * 这台机器上 node:http 对 Chrome DevTools HTTP 端口的 GET 会「连接成功但
 * 一直等不到响应」（PowerShell / 浏览器都正常，仅 Node 卡）——没有共用代理、
 * 端口监听也确认在 127.0.0.1。原因不明，绕开：用 PowerShell 的
 * Invoke-WebRequest 当 HTTP 客户端（约 60~100ms/次，完全够用）。
 */
async function cdpTarget() {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    let list;
    try {
      const out = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `(Invoke-WebRequest -Uri 'http://127.0.0.1:${cdpPort}/json/list' -UseBasicParsing -TimeoutSec 5).Content`,
        ],
        { encoding: "utf8", timeout: 8000, windowsHide: true }
      );
      list = JSON.parse(out);
    } catch (e) {
      log("cdpTarget: " + String(e && e.message).split(/\r?\n/)[0]);
      await new Promise((r) => setTimeout(r, 400));
      continue;
    }
    const page = list.find(
      (t) => t.type === "page" && t.webSocketDebuggerUrl && String(t.url).startsWith("file://")
    );
    if (page) return page;
    log("cdpTarget: no page target, n=" + list.length);
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("浏览器 CDP 未就绪");
}

let ws;
let msgId = 0;
const pending = new Map();
const pageErrors = [];

async function connect() {
  const target = await cdpTarget();
  log("connect: got target, opening ws");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("ws open timeout")), 8000);
    ws.onopen = () => { clearTimeout(t); resolve(); };
    ws.onerror = () => { clearTimeout(t); reject(new Error("WebSocket 连接失败")); };
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
      log("console.error: " + m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200));
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
  log("connect: enabled Runtime/Page");
}

function send(method, params) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error("cdp timeout: " + method));
      }
    }, 8000);
  });
}

async function evaluate(expr) {
  const r = await send("Runtime.evaluate", {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    throw new Error(
      "页面求值异常: " + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails)
    );
  }
  return r.result.value;
}

async function parse(colorStr) {
  /* 两段式换算（缺一不可）：
   *  1) 探针元素必须挂到 document 上再取 computed style——detached 元素的
   *     getComputedStyle 拿不到已用值，旧写法恒返回 []，near([], 期望) 恒真，
   *     整个颜色断言曾全部失效；
   *  2) 新 Chrome 对 color-mix 的结果序列化为 color(srgb 0..1)（不是 rgb()），
   *     正则抽数字会把 0.97 当成 1。这里经 canvas fillStyle + getImageData
   *     读回 8bit sRGB，任何 CSS Color 4 写法都支持。 */
  const js =
    "(() => {" +
    "const el = document.createElement('i');" +
    "document.body.appendChild(el);" +
    "el.style.backgroundColor = " + JSON.stringify(colorStr) + ";" +
    "const got = getComputedStyle(el).backgroundColor;" +
    "el.remove();" +
    "const cvs = document.createElement('canvas');" +
    "cvs.width = 1; cvs.height = 1;" +
    "const ctx = cvs.getContext('2d');" +
    "ctx.fillStyle = got;" +
    "ctx.fillRect(0, 0, 1, 1);" +
    "const d = ctx.getImageData(0, 0, 1, 1).data;" +
    "return [d[0], d[1], d[2]];" +
    "})()";
  return evaluate(js);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 插件脚本以 (ms, env, plugin, …) 参数执行——宿主注入的全局在页面脚本之前就位。
   detail.html 本身不引 CSS（宿主 scopeCss 注入），这里照原样贴进 <style>。 */
const cssText = JSON.stringify(readFileSync(path.join(pluginDir, "detail.css"), "utf8"));
const INJECT = `
(() => {
  const store = {};
  window.ms = {
    store: {
      get: (k, d) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : d),
      set: (k, v) => { store[k] = v; },
    },
    ui: { toast: function () {} },
    plugin: { has: function () { return true; } },
    log: function () {},
  };
  window.env = {};
  window.plugin = { id: "com.zhuangjie.todo-list", version: "1.1.0" };
  window.host = { onTeardown: function () {}, keepAlive: function () { return true; } };
  window.keyword = "";
  window.inputValue = "";
  window.onSubKeyword = function (cb) {};
  window.md2html = function (s) { return s; };
  window.openExternal = function () {};
  /* detail.html 不自带 CSS（宿主 scopeCss 注入），单测里把样式原样贴进 <style>。
     addScriptToEvaluateOnNewDocument 在文档树成形前执行，这里挂到
     DOMContentLoaded（或已就绪时立刻插），保证 style 进入渲染树。 */
  const mount = () => {
    try {
      const style = document.createElement("style");
      style.textContent = ${cssText};
      (document.head || document.documentElement || document.body).appendChild(style);
    } catch (e) { console.error("mount style failed: " + (e && e.message)); }
  };
  if (document.head) mount();
  else document.addEventListener("DOMContentLoaded", mount);
})();
`;

/** color-mix(in srgb, C p%, B) 的期望通道值（同为不透明色，按加权平均算） */
function mix(p, c, b) {
  return [0, 1, 2].map((i) => Math.round((p * c[i] + (100 - p) * b[i]) / 100));
}
/**
 * 把 getComputedStyle 返回的颜色（rgb / color(srgb…) / oklab(…)）统一换算成
 * [r,g,b]。新版 Chrome 对 color-mix 的结果不再回退成 rgb() 序列化，所以
 * 用浏览器自己换算：把颜色写进临时元素的 backgroundColor，再经 canvas
 * 读回 8bit sRGB——任何 CSS Color 4 写法都支持。
 */
const near = (a, b, tol = 4) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const fmt = (a) => `rgb(${a.join(",")})`;

const HIGH = [215, 38, 61]; // --todo-high #d7263d
const MID = [217, 134, 0]; // --todo-mid #d98600
const LOW = [47, 158, 107]; // --todo-low #2f9e6b
const CARD = [255, 255, 255]; // 浅色主题兜底 #ffffff
const CARD_DARK = [31, 36, 48]; // 模拟深色主题的 --card #1f2430
const TEXT = [23, 43, 77]; // --text #172b4d
const TEXT_SEC = [107, 122, 144]; // --text-secondary 兜底 #6b7a90（已完成行的灰点）
const DANGER = [215, 38, 61];

try {
  log("main: connecting");
  await connect();
  log("main: inject");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: INJECT });
  log("main: reload with inject");
  await send("Page.reload", {});
  await sleep(1200);
  log("main: page settled");

  ok((await evaluate("!!document.querySelector('#app.todo')")) === true, "插件页面已挂载");
  ok(
    (await evaluate("document.querySelectorAll('.todo-item').length")) === 0,
    "初始无待办（干净起点）"
  );

  const addTodo = (text) => `
    (() => {
      const input = document.querySelector('#todo-input');
      input.value = ${JSON.stringify(text)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#todo-add').click();
    })()`;
  await evaluate(addTodo("紧急任务 !紧急"));
  await evaluate(addTodo("普通任务"));
  await evaluate(addTodo("低优先 !低"));
  await evaluate(addTodo("逾期任务 !低 2020-01-01"));
  await sleep(300);
  log("main: 4 todos added");

  ok((await evaluate("document.querySelectorAll('.todo-item').length")) === 4, "4 条待办已添加");

  /* 1. 行底色统一（= 卡片底）+ 无色条；2. 状态圆点着色；3. 无优先级 chip */
  const readStyle = `(sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, shadow: cs.boxShadow, border: cs.borderTopColor };
  }`;
  const styles = await evaluate(`[
    (${readStyle})('.todo-item[data-priority="high"]:not(.todo-item-overdue):not(.todo-item-done)'),
    (${readStyle})('.todo-item[data-priority="mid"]:not(.todo-item-done)'),
    (${readStyle})('.todo-item[data-priority="low"]:not(.todo-item-overdue)')
  ]`);

  ok(styles && styles.every(Boolean), "三档待办都已渲染");
  if (styles && styles.every(Boolean)) {
    const rgbHigh = await parse(styles[0].bg);
    const rgbMid = await parse(styles[1].bg);
    const rgbLow = await parse(styles[2].bg);
    ok(near(rgbHigh, CARD), "紧急：行底色 = 统一卡片底（不再淡红）", `${styles[0].bg} ≈ ${fmt(CARD)}`);
    ok(near(rgbMid, CARD), "普通：行底色 = 统一卡片底（不再淡橙）", `${styles[1].bg} ≈ ${fmt(CARD)}`);
    ok(near(rgbLow, CARD), "低：行底色 = 统一卡片底（不再淡绿）", `${styles[2].bg} ≈ ${fmt(CARD)}`);
    ok(
      near(rgbHigh, rgbMid) && near(rgbMid, rgbLow),
      "三档行底色完全一致（红黄绿块消失）"
    );
    ok(
      styles.every((s) => s.shadow === "none"),
      "行上不再有 inset 色条（box-shadow = none）",
      styles.map((s) => s.shadow).join(" | ")
    );
  }

  /* 状态圆点：紧急=红 / 普通=黄 / 低=绿（= --todo-* 变量色） */
  const dotStyles = await evaluate(`[
    (${readStyle})('.todo-item[data-priority="high"] .todo-dot'),
    (${readStyle})('.todo-item[data-priority="mid"] .todo-dot'),
    (${readStyle})('.todo-item[data-priority="low"] .todo-dot')
  ]`);
  ok(dotStyles && dotStyles.every(Boolean), "三档行的状态圆点都已渲染");
  if (dotStyles && dotStyles.every(Boolean)) {
    ok(near(await parse(dotStyles[0].bg), HIGH), "紧急行圆点 = 红（--todo-high）", dotStyles[0].bg);
    ok(near(await parse(dotStyles[1].bg), MID), "普通行圆点 = 黄（--todo-mid）", dotStyles[1].bg);
    ok(near(await parse(dotStyles[2].bg), LOW), "低行圆点 = 绿（--todo-low）", dotStyles[2].bg);
  }

  ok(
    (await evaluate("!!document.querySelector('.todo-chip-prio-high, .todo-chip-prio-mid, .todo-chip-prio-low')")) === false,
    "行内不再出现优先级 chip（状态只走圆点）"
  );
  log("main: light-theme asserts done");


const LINE = [230, 232, 236]; // --line 兜底 #e6e8ec

  /* 4. 空态提示：有数据时真正隐藏；筛选无结果时显示对应文案。
   *    （回归钉：.todo-empty 自带 display:flex 会顶掉 UA 的
   *      [hidden]{display:none}——插件容器必须有 scoped 兜底规则。） */
  ok(
    (await evaluate("getComputedStyle(document.querySelector('#todo-empty')).display")) === "none",
    "列表有数据时空态提示真正隐藏（display:none）"
  );
  await evaluate("document.querySelector('.todo-tab[data-filter=\"done\"]').click()");
  await sleep(150);
  ok(
    (await evaluate("getComputedStyle(document.querySelector('#todo-empty')).display")) === "flex",
    "筛选「已完成」无结果时空态提示显示"
  );
  ok(
    (await evaluate("document.querySelector('#todo-empty-text').textContent")) === "当前筛选下没有条目",
    "筛选无结果的空态文案正确"
  );
  await evaluate("document.querySelector('.todo-tab[data-filter=\"all\"]').click()");
  await sleep(150);
  ok(
    (await evaluate("getComputedStyle(document.querySelector('#todo-empty')).display")) === "none",
    "切回全部后空态提示再次隐藏"
  );
  log("main: empty-state asserts done");

  /* 5. 勾选完成：行灰底 + 圆点灰化（完成度压过优先级） */
  await evaluate(`(() => {
    const item = document.querySelector('.todo-item[data-priority="mid"]:not(.todo-item-done)');
    item.querySelector('.todo-check').click();
  })()`);
  await sleep(200);
  const doneStyle = await evaluate(
    `((${readStyle})('.todo-item.todo-item-done[data-priority="mid"]'))`
  );
  if (doneStyle) {
    const expDone = mix(3, TEXT, CARD);
    ok(
      near(await parse(doneStyle.bg), expDone),
      "已完成：灰底覆盖",
      `${doneStyle.bg} ≈ ${fmt(expDone)}`
    );
  } else {
    ok(false, "已完成：灰底覆盖", "没找到已完成项");
  }
  const doneDot = await evaluate(`(${readStyle})('.todo-item.todo-item-done[data-priority="mid"] .todo-dot')`);
  if (doneDot) {
    ok(near(await parse(doneDot.bg), TEXT_SEC), "已完成：圆点灰化", doneDot.bg);
  } else {
    ok(false, "已完成：圆点灰化", "没找到已完成项的圆点");
  }
  log("main: done-state assert done");

  /* 6. 逾期项保留警示边框（40% 危险色 × --line） */
  const overdue = await evaluate(`((${readStyle})('.todo-item.todo-item-overdue'))`);
  if (overdue) {
    const expBorder = mix(40, DANGER, LINE);
    ok(
      near(await parse(overdue.border), expBorder),
      "逾期项：警示色边框仍在",
      `${overdue.border} ≈ ${fmt(expBorder)}`
    );
  } else {
    ok(false, "逾期项：警示色边框仍在", "没找到逾期项");
  }

  /* 7. 深色主题：覆盖宿主 token，统一底色跟着 --card 走。
   *    放在最后：--card/--text 一改会污染前面浅色断言的期望值。
   *    行有 120ms 的 background 过渡，先等它走完再读计算值。 */
  await evaluate(`(() => {
    const app = document.getElementById('app');
    app.style.setProperty('--card', '#1f2430');
    app.style.setProperty('--line', '#333a47');
    app.style.setProperty('--text', '#dfe5f0');
  })()`);
  await sleep(300);
  const darkHigh = await evaluate(
    `(${readStyle})('.todo-item[data-priority="high"]:not(.todo-item-done):not(.todo-item-overdue)')`
  );
  if (darkHigh) {
    ok(
      near(await parse(darkHigh.bg), CARD_DARK),
      "深色主题：行底色随 --card 变化（不是死色）",
      `${darkHigh.bg} ≈ ${fmt(CARD_DARK)}`
    );
  } else {
    ok(false, "深色主题：行底色随 --card 变化", "没找到紧急行");
  }
  log("main: dark-theme assert done");

  ok(pageErrors.filter(Boolean).length === 0, "全程无未捕获的页面异常", pageErrors.filter(Boolean).slice(0, 3).join(" | ") || "none");
  log("final: pageErrors=" + JSON.stringify(pageErrors));
} catch (err) {
  fail++;
  console.log("FAIL 测试执行异常 —", err && err.message);
}

console.log(`\n待办优先级渲染：${pass} 通过 / ${fail} 失败`);
log(`main: finished ${pass}/${fail}`);
try { ws && ws.close(); } catch {}
chrome.kill();
try { rmSync(userDir, { recursive: true, force: true }); } catch {}
process.exit(fail > 0 ? 1 : 0);

