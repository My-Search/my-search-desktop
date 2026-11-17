/**
 * 软件卸载器前台行为的真实浏览器验证（CDP）。
 *
 * 静态契约见 app-uninstaller-ui.test.mjs；后端真实行为见 app-uninstaller-backend.test.mjs。
 * 这里用 stub 后端钉死前端**运行时行为**：
 *   1. 列表渲染：有 iconDataUrl 的显示真实图标（<img>），没有的回落 📦；
 *   2. 每个软件渲染 卸载 / 强制卸载 / 打开位置 / 扫描残留 按钮；
 *   3. 「打开位置」点击 → 后端 openLocation（只带 id）；
 *   4. 「卸载」点击 → 先 ms.ui.confirm 再调 uninstall；确认弹窗取消则不调；
 *   5. 「强制卸载」点击 → 调 uninstallForce（同样先确认）；
 *   6. 收到 uninstall-finished 通知 → 自动调 scan（与手动扫描同路径），
 *      残留面板出现且默认全选；通知里的软件在快照中找不到时不误扫；
 *   7. 「清理选中」→ 先确认再调 clean（scanId + 勾选 id）。
 *
 * 用法: node test/app-uninstaller-ui-behavior.test.mjs
 * 需要本机装有 Chrome / Edge；找不到浏览器时跳过（退出码 0）。
 */
import { spawn, execFileSync } from "child_process";
import { existsSync, readFileSync, appendFileSync, rmSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = path.join(root, "plugins", "com.zhuangjie.app-uninstaller", "ui");
const LOG_PATH = path.join(root, "test", "_app-uninstaller-behavior.log");
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
  console.log("未找到浏览器（Chrome/Edge），跳过卸载器行为测试");
  process.exit(0);
}

const userDir = path.join(root, "test", `_chrome-profile-uninstall-${process.pid}`);
const cdpPort = 11000 + Math.floor(Math.random() * 300);
const pageUrl = "file:///" + path.join(pluginDir, "detail.html").replace(/\\/g, "/");
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

/* 宿主桩：ms.backend.call 按方法分发到 stub 数据；onNotification 登记处理器；
   __dispatchUninstallFinished 模拟宿主把后端通知派发给插件（真实路由见
   host.ts notificationHandlers / addNotificationHandler）。 */
const cssText = JSON.stringify(readFileSync(path.join(pluginDir, "detail.css"), "utf8"));
const ICON_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const INJECT = `
(() => {
  window.__stub = {
    listItems: [
      { id: "app1", name: "Stub App", version: "1.2.3", publisher: "StubPub", installDate: "20260102",
        installLocation: "C:\\\\stub\\\\app", uninstallString: "C:\\\\stub\\\\app\\\\un.exe", quietUninstallString: "",
        displayIcon: "", estimatedSize: 12345678, iconDataUrl: ${JSON.stringify(ICON_PNG)} },
      { id: "app2", name: "NoIcon App", version: "2.0", publisher: "", installDate: "",
        installLocation: "C:\\\\stub\\\\noicon", uninstallString: "", quietUninstallString: "",
        displayIcon: "", estimatedSize: 0, iconDataUrl: "" },
    ],
    scanQueue: [],
    calls: [],
    toasts: [],
    lastConfirm: null,
    confirmAnswer: true,
    notifications: {},
  };
  window.ms = {
    store: { get: function () { return undefined; }, set: function () {} },
    ui: {
      toast: function (text, type) { window.__stub.toasts.push({ text: String(text), type: String(type || "info") }); },
      confirm: function (ask) {
        window.__stub.lastConfirm = String(ask == null ? "" : ask);
        return Promise.resolve(window.__stub.confirmAnswer);
      },
    },
    backend: {
      call: function (method, params) {
        const stub = window.__stub;
        stub.calls.push({ method: String(method), params: params || null });
        let value;
        if (method === "init") value = { ok: true, platform: "win32", supported: true };
        else if (method === "list") value = { ok: true, items: stub.listItems };
        else if (method === "scan") {
          value = stub.scanQueue.length
            ? stub.scanQueue.shift()
            : { ok: true, scanId: "scan-default", name: params && params.item && params.item.name, items: [] };
        } else if (method === "uninstall" || method === "uninstallForce") {
          value = { ok: true, started: true, name: "Stub App", finishedNotice: "notice-1" };
        } else if (method === "openLocation") {
          value = { ok: true, path: "C:\\\\stub\\\\app", name: "Stub App" };
        } else if (method === "clean") {
          value = { ok: true, results: (params && params.ids ? params.ids : []).map(function (id) { return { id: id, ok: true }; }), remaining: 0 };
        } else value = { ok: true };
        return Promise.resolve(value);
      },
      onNotification: function (method, fn) {
        const m = String(method);
        (window.__stub.notifications[m] = window.__stub.notifications[m] || []).push(fn);
        return function () {
          const arr = window.__stub.notifications[m] || [];
          const i = arr.indexOf(fn);
          if (i >= 0) arr.splice(i, 1);
        };
      },
      offNotification: function () {},
    },
    log: function () {},
  };
  window.env = {};
  window.plugin = { id: "com.zhuangjie.app-uninstaller", version: "1.1.0" };
  window.host = { onTeardown: function () {}, keepAlive: function () { return true; } };
  window.keyword = "";
  window.inputValue = "";
  window.onSubKeyword = function (cb) {};
  window.md2html = function (s) { return s; };
  window.openExternal = function () {};
  /* 模拟宿主派发后端通知（与真实链路同义：method 相同、params 透传） */
  window.__dispatchUninstallFinished = function (params) {
    const fns = window.__stub.notifications["uninstall-finished"] || [];
    fns.slice().forEach(function (f) { try { f(params); } catch (e) { console.error("notify handler error: " + (e && e.message)); } });
    return fns.length;
  };
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

/** 取某后端方法的调用记录 */
const callsOf = (method) =>
  `window.__stub.calls.filter(function (c) { return c.method === "${method}"; })`;

try {
  log("main: connecting");
  await connect();
  log("main: inject");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: INJECT });
  log("main: reload with inject");
  await send("Page.reload", {});
  await sleep(1300);
  log("main: page settled");

  ok((await evaluate("!!document.querySelector('#app.un-app')")) === true, "插件页面已挂载");
  ok(
    (await evaluate("document.getElementById('un-stats').textContent")) === "共 2 个软件",
    "列表加载完成（stub 后端 2 条）",
  );

  /* 1. 图标渲染 */
  const img1 = await evaluate(
    `(() => { const img = document.querySelector('#un-list .un-item[data-id="app1"] .un-item-icon img');
      return img ? { srcStart: img.getAttribute('src').slice(0, 22) } : null; })()`
  );
  ok(img1 && img1.srcStart === "data:image/png;base64,", "有 iconDataUrl 的软件显示真实图标（<img> data URL）");
  ok(
    (await evaluate(`document.querySelector('#un-list .un-item[data-id="app2"] .un-item-icon').textContent`)) === "📦",
    "没有图标的软件回落 📦 占位",
  );

  /* 2. 按钮齐全 */
  const acts = await evaluate(
    `Array.prototype.map.call(document.querySelectorAll('#un-list .un-item[data-id="app1"] [data-act]'), function (b) { return b.getAttribute('data-act'); })`
  );
  ok(
    JSON.stringify(acts) === JSON.stringify(["uninstall", "uninstallForce", "open", "scan"]),
    "每个软件渲染 卸载/强制卸载/打开位置/扫描残留 四个操作",
    JSON.stringify(acts),
  );
  ok(
    (await evaluate(`document.querySelector('#un-list .un-item[data-id="app2"] .un-item-actions').textContent`)).includes("无卸载项"),
    "无卸载命令的软件显示「无卸载项」禁用占位",
  );

  /* 3. 打开位置 → openLocation（只带 id） */
  await evaluate(`document.querySelector('#un-list .un-item[data-id="app1"] [data-act="open"]').click()`);
  await sleep(180);
  const openCalls = await evaluate(`JSON.stringify(${callsOf("openLocation")})`);
  ok(
    openCalls === JSON.stringify([{ method: "openLocation", params: { id: "app1" } }]),
    "「打开位置」点击 → openLocation 且只传 id",
    openCalls,
  );

  /* 4. 卸载：先确认，再调 uninstall */
  await evaluate(`document.querySelector('#un-list .un-item[data-id="app1"] [data-act="uninstall"]').click()`);
  await sleep(180);
  ok(
    (await evaluate("window.__stub.lastConfirm")).includes("卸载"),
    "「卸载」先经 ms.ui.confirm 确认",
  );
  const unCalls = await evaluate(`JSON.stringify(${callsOf("uninstall")})`);
  ok(
    unCalls === JSON.stringify([{ method: "uninstall", params: { id: "app1" } }]),
    "确认后调 uninstall（只传 id）",
    unCalls,
  );
  ok(
    (await evaluate("window.__stub.toasts.length")) >= 1,
    "卸载启动后有 toast 反馈",
  );

  /* 5. 取消确认 → 不调后端 */
  await evaluate(`window.__stub.confirmAnswer = false; window.__stub.calls = [];`);
  await evaluate(`document.querySelector('#un-list .un-item[data-id="app1"] [data-act="uninstall"]').click()`);
  await sleep(180);
  ok(
    (await evaluate(callsOf("uninstall") + ".length")) === 0,
    "确认弹窗取消 → 不调 uninstall",
  );

  /* 6. 强制卸载 → uninstallForce（同样经确认） */
  await evaluate(`window.__stub.confirmAnswer = true; window.__stub.calls = [];`);
  await evaluate(`document.querySelector('#un-list .un-item[data-id="app1"] [data-act="uninstallForce"]').click()`);
  await sleep(180);
  ok(
    (await evaluate("window.__stub.lastConfirm")).includes("强制卸载"),
    "「强制卸载」确认文案含警示",
  );
  const fCalls = await evaluate(`JSON.stringify(${callsOf("uninstallForce")})`);
  ok(
    fCalls === JSON.stringify([{ method: "uninstallForce", params: { id: "app1" } }]),
    "确认后调 uninstallForce",
    fCalls,
  );

  /* 7. 卸载结束通知 → 自动扫描残留（与手动扫描同路径） */
  await evaluate(`window.__stub.calls = []; window.__stub.scanQueue = [
    { ok: true, scanId: "scan-x", name: "Stub App", items: [
      { id: "r1", kind: "dir", path: "C:\\\\stub\\\\app", label: "安装目录", size: 12345, fileCount: 3 } ] } ];`);
  const handlerCount = await evaluate(
    `window.__dispatchUninstallFinished({ id: "notice-1", softwareId: "app1", name: "Stub App", forced: false })`
  );
  ok(handlerCount === 1, "uninstall-finished 处理器恰好注册一个", `count=${handlerCount}`);
  await sleep(200);
  const scanCalls = await evaluate(`JSON.stringify(${callsOf("scan")})`);
  ok(
    scanCalls.includes('"id":"app1"') && scanCalls.includes('"name":"Stub App"'),
    "收到卸载结束通知 → 自动 scan（用快照找回软件条目）",
    scanCalls,
  );
  ok(
    (await evaluate("!document.getElementById('un-residue').hidden && !!document.querySelector('#un-residue input[data-res-id=\"r1\"]')")) === true,
    "残留面板自动展开且候选已渲染",
  );
  ok(
    (await evaluate(`document.querySelector('#un-residue input[data-res-id="r1"]').checked`)) === true,
    "残留候选默认全选（用户可取消）",
  );

  /* 8. 快照里找不到的软件通知 → 不误扫 */
  await evaluate(`window.__stub.calls = [];`);
  const miss = await evaluate(
    `window.__dispatchUninstallFinished({ id: "notice-2", softwareId: "ghost", name: "不存在软件 ZZZ" })`
  );
  ok(miss === 1, "未知软件的通知仍派发到处理器");
  await sleep(150);
  ok(
    (await evaluate(callsOf("scan") + ".length")) === 0,
    "快照与列表都找不到的软件 → 不发起扫描（防误扫）",
  );

  /* 9. 清理：先确认再 clean（scanId + 勾选 id） */
  await evaluate(`window.__stub.calls = []; window.__stub.confirmAnswer = false;`);
  await evaluate(`document.getElementById('un-clean').click()`);
  await sleep(150);
  ok(
    (await evaluate(callsOf("clean") + ".length")) === 0,
    "清理确认弹窗取消 → 不调 clean",
  );
  await evaluate(`window.__stub.confirmAnswer = true;`);
  await evaluate(`document.getElementById('un-clean').click()`);
  await sleep(180);
  const cleanCalls = await evaluate(`JSON.stringify(${callsOf("clean")})`);
  ok(
    cleanCalls.includes('"scanId":"scan-x"') && cleanCalls.includes('"ids":["r1"]'),
    "确认后调 clean（scanId + 勾选 id）",
    cleanCalls,
  );
  ok(
    (await evaluate(`document.getElementById('un-residue').hidden || document.querySelectorAll('#un-residue input[data-res-id]').length === 0`)) === true,
    "清理成功后残留面板收起/清空",
  );

  ok(pageErrors.filter(Boolean).length === 0, "全程无未捕获的页面异常", pageErrors.filter(Boolean).slice(0, 3).join(" | ") || "none");
  log("final: pageErrors=" + JSON.stringify(pageErrors));
} catch (err) {
  fail++;
  console.log("FAIL 测试执行异常 —", err && err.message);
}

console.log(`\n卸载器行为：${pass} 通过 / ${fail} 失败`);
log(`main: finished ${pass}/${fail}`);
try { ws && ws.close(); } catch {}
chrome.kill();
try { rmSync(userDir, { recursive: true, force: true }); } catch {}
process.exit(fail > 0 ? 1 : 0);
