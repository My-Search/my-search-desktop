/**
 * 待办清单「Ctrl+Alt+T 呼出动作」的真实浏览器行为验证（CDP）。
 *
 * 静态契约（清单声明 / 默认键冲突 / 源码注册）见 todo-shortcut.test.mjs；
 * 这里钉死**运行时行为**——宿主按下快捷键后会打开/恢复插件视图，并把动作名
 * `open-todo` 派发给 `ms.shortcuts.onAction` 注册的处理器（与录屏 record-toggle
 * 同一条宿主链路，见 src/windows/search/App.vue runPluginActionByShortcut）。
 *
 *   1. 页面加载后 open-todo 处理器已注册（清单声明了动作时宿主才派发）；
 *   2. 模拟宿主派发 → 输入框聚焦、光标到末尾（直接输入即可新增）；
 *   3. 派发不改变待办数据（呼出 ≠ 新增，「待办 : xxx」子关键词才新增）；
 *   4. 行内编辑态被呼出打断时先退出编辑再聚焦；
 *   5. 重复派发（minimize 保活后再次呼出）仍生效——处理器陪整个会话；
 *   6. 会话销毁（DOM 移出文档）后派发不抛错（alive() 守卫）。
 *
 * 用法: node test/todo-shortcut-ui.test.mjs
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
const LOG_PATH = path.join(root, "test", "_todo-shortcut-trace.log");
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
  console.log("未找到浏览器（Chrome/Edge），跳过待办快捷键行为测试");
  process.exit(0);
}

const userDir = path.join(root, "test", `_chrome-profile-todo-sc-${process.pid}`);
const cdpPort = 10600 + Math.floor(Math.random() * 300);
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
chrome.on("exit", () => log("chrome: exited"));

/** 轮询 CDP /json/list 拿页面 target（带超时）。
 *
 * 这台机器上 node:http 对 Chrome DevTools HTTP 端口的 GET 会「连接成功但
 * 一直等不到响应」（PowerShell / 浏览器都正常，仅 Node 卡）——绕开：用
 * PowerShell 的 Invoke-WebRequest 当 HTTP 客户端。
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 插件脚本以 (ms, env, plugin, …) 参数执行——宿主注入的全局在页面脚本之前就位。
   detail.html 不自带 CSS（宿主 scopeCss 注入），这里照原样贴进 <style>。
   ms.shortcuts.onAction 模拟宿主真实实现（host.ts addShortcutActionHandler）：
   登记处理器并返回取消函数；__dispatchTodoAction 与宿主派发同义。 */
const cssText = JSON.stringify(readFileSync(path.join(pluginDir, "detail.css"), "utf8"));
const INJECT = `
(() => {
  const store = {};
  const actionHandlers = {};
  window.__dispatchTodoAction = function (name) {
    const hs = actionHandlers[name] || [];
    if (!hs.length) return false;
    hs.slice().forEach(function (h) { try { h(); } catch (e) { console.error("handler error: " + (e && e.message)); } });
    return true;
  };
  window.ms = {
    store: {
      get: (k, d) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : d),
      set: (k, v) => { store[k] = v; },
    },
    ui: { toast: function () {} },
    plugin: { has: function () { return true; } },
    shortcuts: {
      onAction: function (name, fn) {
        (actionHandlers[String(name)] = actionHandlers[String(name)] || []).push(fn);
        return function () {
          const arr = actionHandlers[String(name)] || [];
          const i = arr.indexOf(fn);
          if (i >= 0) arr.splice(i, 1);
        };
      },
    },
    log: function () {},
  };
  window.env = {};
  window.plugin = { id: "com.zhuangjie.todo-list", version: "1.2.0" };
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
    (await evaluate("typeof window.__dispatchTodoAction === 'function'")) === true,
    "宿主桩已就位（派发函数可用）"
  );

  /* 1. 处理器已注册 */
  ok(
    (await evaluate("window.__dispatchTodoAction('open-todo')")) === true,
    "open-todo 处理器已注册（清单声明了动作，宿主才会派发）"
  );
  ok(
    (await evaluate("window.__dispatchTodoAction('record-toggle')")) === false,
    "未注册的动作派发返回 false（排除误把别的动作名当处理器）"
  );

  /* 状态快照辅助：焦点 / 光标 / 数据 / 编辑态 */
  const snapshotExpr = `(() => {
    const input = document.querySelector('#todo-input');
    return {
      focused: document.activeElement === input,
      selStart: input.selectionStart,
      selEnd: input.selectionEnd,
      valueLen: input.value.length,
      count: document.querySelectorAll('.todo-item').length,
      editing: !!document.querySelector('[data-edit-input]'),
    };
  })()`;
  const dispatch = `window.__dispatchTodoAction('open-todo')`;

  /* 2. 派发 → 聚焦 + 光标到末尾 */
  await evaluate(`(() => { const i = document.querySelector('#todo-input'); i.focus(); i.value = '预置内容'; i.setSelectionRange(2, 2); i.blur(); document.body.focus(); })()`);
  await sleep(100);
  const s1 = await evaluate(snapshotExpr);
  ok(s1 && s1.focused === false && s1.valueLen === 4, "前置：输入框失焦且有预置内容", JSON.stringify(s1));
  await evaluate(dispatch);
  await sleep(100);
  const s2 = await evaluate(snapshotExpr);
  ok(s2 && s2.focused === true, "呼出后输入框聚焦", JSON.stringify(s2));
  ok(
    s2 && s2.selStart === s2.valueLen && s2.selEnd === s2.valueLen,
    "光标落到末尾（继续输入即可追加）",
    `sel=(${s2.selStart},${s2.selEnd}) len=${s2.valueLen}`
  );

  /* 3. 呼出不改数据（与「待办 : xxx」快速新增区分） */
  ok(s2 && s2.count === 0, "呼出后待办数据不变（呼出≠新增）");



  /* 4. 行内编辑态 → 呼出退出编辑再聚焦 */
  await evaluate(`(() => {
    const input = document.querySelector('#todo-input');
    input.value = '要编辑的待办';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#todo-add').click();
  })()`);
  await sleep(200);
  await evaluate(`(() => {
    const el = document.querySelector('.todo-item [data-action="edit-start"]');
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  })()`);
  await sleep(200);
  const editing = await evaluate("!!document.querySelector('[data-edit-input]')");
  ok(editing === true, "前置：已进入行内编辑态");
  await evaluate(dispatch);
  await sleep(150);
  const s4 = await evaluate(snapshotExpr);
  ok(s4 && s4.editing === false, "行内编辑态被呼出打断：先退出编辑", JSON.stringify(s4));
  ok(s4 && s4.focused === true, "退出编辑后输入框聚焦");
  const stillOne = await evaluate("document.querySelectorAll('.todo-item').length");
  ok(stillOne === 1, "退出编辑不丢数据（待办仍在）");

  /* 5. 重复派发（minimize 保活后再次呼出）仍生效 */
  await evaluate("document.body.focus();");
  await sleep(80);
  await evaluate(dispatch);
  await sleep(100);
  const s5 = await evaluate(snapshotExpr);
  ok(s5 && s5.focused === true && s5.editing === false, "重复派发（保活后再呼出）仍聚焦");

  /* 6. 会话销毁后派发不抛错（alive 守卫：DOM 移出文档） */
  await evaluate(`(() => {
    const app = document.getElementById('app');
    window.__parkedApp = app;
    if (app.parentNode) app.parentNode.removeChild(app);
  })()`);
  await sleep(80);
  let survived = true;
  try {
    await evaluate(dispatch);
  } catch (e) {
    survived = false;
    log("dispatch after teardown threw: " + e.message);
  }
  ok(survived === true, "会话销毁后派发不抛错（alive 守卫）");
  await evaluate("(() => { document.body.appendChild(window.__parkedApp); })()");

  ok(pageErrors.filter(Boolean).length === 0, "全程无未捕获的页面异常", pageErrors.filter(Boolean).slice(0, 3).join(" | ") || "none");
  log("final: pageErrors=" + JSON.stringify(pageErrors));
} catch (err) {
  fail++;
  console.log("FAIL 测试执行异常 —", err && err.message);
}

console.log(`\n待办快捷键行为：${pass} 通过 / ${fail} 失败`);
log(`main: finished ${pass}/${fail}`);
try { ws && ws.close(); } catch {}
chrome.kill();
try { rmSync(userDir, { recursive: true, force: true }); } catch {}
process.exit(fail > 0 ? 1 : 0);

