/**
 * 「常规设置」面板（开机自启动）冒烟测试（真实浏览器 + 模拟 IPC）：
 * 1. 导航出现「常规」项，点击渲染 .page.general 面板
 * 2. 开关初始状态来自后端 get_autostart_enabled（默认开启 → 勾选）
 * 3. 点击开关 → IPC set_autostart_enabled_cmd，参数 enabled 正确（开→关）
 * 4. 写入失败时开关回滚且提示错误（不谎报成功）
 * 5. 底栏「保存并应用」在常规面板不显示（该面板即时生效，无需保存）
 *
 * 用法: npm run build && node test/autostart-ui.test.mjs
 */
import { createServer } from "http";
import { readFile, rm } from "fs/promises";
import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
if (!existsSync(path.join(dist, "config.html"))) {
  console.error("请先 npm run build");
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};
const server = createServer(async (req, res) => {
  try {
    const u = decodeURIComponent(req.url.split("?")[0]);
    const file = path.join(dist, u === "/" ? "/config.html" : u);
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

const userDir = path.join(root, "test", "_chrome-profile-autostart");
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
  const r = await S(
    "Runtime.evaluate",
    { expression: expr, returnByValue: true, awaitPromise: true },
    sessionId
  );
  if (r.result?.exceptionDetails) {
    throw new Error(
      JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails).slice(0, 300)
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

// 模拟 Tauri IPC：默认「开机自启动」在系统里是开启的；写入失败可用开关控制
await S(
  "Page.addScriptToEvaluateOnNewDocument",
  {
    source: `
    window.__invoked = [];
    window.__autostartState = true;
    window.__failSet = false;
    window.__TAURI_INTERNALS__ = {
      invoke(cmd, args) {
        window.__invoked.push({ cmd, args });
        if (cmd === 'get_autostart_enabled') return Promise.resolve(window.__autostartState);
        if (cmd === 'set_autostart_enabled_cmd') {
          if (window.__failSet) return Promise.reject('写入启动项失败：拒绝访问');
          window.__autostartState = args.enabled;
          return Promise.resolve(null);
        }
        if (cmd === 'get_toggle_shortcut') return Promise.resolve('ctrl+alt+s');
        if (cmd === 'get_default_subscribe_text') return Promise.resolve('');
        return Promise.resolve(null);
      },
      transformCallback(cb, once) {
        const cbId = Math.random().toString(36).slice(2);
        window.__cbIds = window.__cbIds || {};
        window.__cbIds[cbId] = cb;
        return cbId;
      },
      unregisterCallback(cbId) { delete (window.__cbIds || {})[cbId]; },
      metadata: { currentWindow: { label: 'config' }, currentWebview: { label: 'config' } },
      plugins: {},
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(){} };
  `,
  },
  sessionId
);

await S("Page.navigate", { url: base + "/config.html" }, sessionId);
await sleep(500);
await evalJs(`localStorage.clear(); 1`);
await S("Page.navigate", { url: base + "/config.html" }, sessionId);
await sleep(1200);

// 1. 导航项存在且可切换
const navExists = await evalJs(
  `!!document.querySelector('.cfg-nav .nav-item[data-pane="general"]')`
);
await evalJs(`document.querySelector('.cfg-nav .nav-item[data-pane="general"]').click()`);
await sleep(400);
const panelRendered = await evalJs(`!!document.querySelector('#ms-config-view .page.general')`);
check("导航新增「常规」项并渲染面板", navExists && panelRendered, `nav=${navExists} panel=${panelRendered}`);

// 2. 默认开启（来自后端）
const initChecked = await evalJs(`document.querySelector('.switch input[data-act="autostart"]').checked`);
check("开关初始状态取自后端（默认开启）", initChecked === true, `checked=${initChecked}`);

// 3. 点击关闭 → IPC 参数 enabled:false
await evalJs(`document.querySelector('.switch input[data-act="autostart"]').click()`);
await sleep(300);
const setCalls = await evalJs(
  `JSON.stringify(window.__invoked.filter(i => i.cmd === 'set_autostart_enabled_cmd').map(i => i.args.enabled))`
);
check("点击开关下发 set_autostart_enabled_cmd(enabled=false)", setCalls === "[false]", setCalls);
const afterClick = await evalJs(`document.querySelector('.switch input[data-act="autostart"]').checked`);
check("关闭后开关显示为未勾选", afterClick === false, `checked=${afterClick}`);

// 4. 再点一次 → enabled:true（可来回切换）
await evalJs(`document.querySelector('.switch input[data-act="autostart"]').click()`);
await sleep(300);
const setCalls2 = await evalJs(
  `JSON.stringify(window.__invoked.filter(i => i.cmd === 'set_autostart_enabled_cmd').map(i => i.args.enabled))`
);
check("再次点击下发 enabled=true", setCalls2 === "[false,true]", setCalls2);

// 5. 写入失败 → 开关回滚 + 错误提示（第 5 步只应产生一次调用）
const callsBeforeFail = await evalJs(
  `window.__invoked.filter(i => i.cmd === 'set_autostart_enabled_cmd').length`
);
await evalJs(`window.__failSet = true; document.querySelector('.switch input[data-act="autostart"]').click()`);
await sleep(400);
const afterFail = await evalJs(`document.querySelector('.switch input[data-act="autostart"]').checked`);
const failCalls = await evalJs(
  `JSON.stringify(window.__invoked.filter(i => i.cmd === 'set_autostart_enabled_cmd').slice(${callsBeforeFail}).map(i => i.args.enabled))`
);
check(
  "写入失败时开关回滚到原状态（不谎报成功）",
  afterFail === true && failCalls === "[false]",
  `checked=${afterFail} 本次调用=${failCalls}`
);
check(
  "写入失败时弹出错误提示",
  (await evalJs(
    `(document.body.textContent || '').includes('拒绝访问') || (document.body.textContent || '').includes('失败')`
  )) === true
);

// 6. 常规面板不显示底栏「保存并应用」（即时生效）
const footerShown = await evalJs(`document.querySelector('.cfg-footer').classList.contains('show')`);
check("常规面板不显示底栏保存按钮", footerShown === false, `show=${footerShown}`);

// 7. 说明文案点明「默认开启」与「可在设置关闭」
const noteText = await evalJs(`document.querySelector('#ms-config-view .page.general .cfg-note').textContent`);
check(
  "面板说明点明默认开启+可关闭",
  noteText.includes("默认") && noteText.includes("关闭"),
  noteText.replace(/\s+/g, " ").trim().slice(0, 60)
);

check("无未捕获页面异常", pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 2)));

console.log(`\n结果: ${pass} passed, ${fail} failed`);
chrome.kill();
server.close();
process.exit(fail === 0 ? 0 : 1);
