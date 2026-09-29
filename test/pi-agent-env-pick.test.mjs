/**
 * pi-agent「API Key 可以从环境变量取」的浏览器验收。
 *
 * 用户诉求：插件配置里的输入框点一下就能呼出宿主的**授权选择器**，
 * 选中后输入框填入 `$NAME`（密钥不落 models.json、也不进插件 JS）。
 *
 * 覆盖：
 *   - 宿主提供 `ms.env.pick` 时，API Key 输入框旁出现「变量」按钮；
 *   - 宿主**不**提供时按钮不出现（独立调试 / 老宿主下界面照旧）；
 *   - 点按钮 → 调 `ms.env.pick`，参数里带上说明用途的 title/purpose；
 *   - 返回 ref → 输入框变成 `$NAME`，并出现「引用环境变量」说明条；
 *   - 返回 literal → 输入框填入字面量，且不留引用说明；
 *   - 列表里 authSource=environment 的提供商显示「环境变量 XXX」徽章。
 *
 * 用法: node test/pi-agent-env-pick.test.mjs
 */
import { createServer } from "http";
import { readFile, rm } from "fs/promises";
import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const filesDir = path.join(root, "plugins", "pi-agent", "ui");

const server = createServer(async (req, res) => {
  try {
    const u = decodeURIComponent(req.url.split("?")[0]);
    if (u === "/api/plugin-files") {
      const [html, css, js] = await Promise.all([
        readFile(path.join(filesDir, "detail.html"), "utf8"),
        readFile(path.join(filesDir, "detail.css"), "utf8"),
        readFile(path.join(filesDir, "index.js"), "utf8"),
      ]);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ html, css, js }));
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HARNESS);
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

/** 宿主桩：只关心 ms.env.pick / ms.ui / ms.backend */
const HARNESS = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>pi env pick harness</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; background: #fff; }
  #my_search_box { position: relative; border: 2px solid #cecece; width: 100%; background: #fff; }
  #text_show { padding: 10px 16px 16px; max-height: 510px; overflow-y: auto; box-sizing: border-box; }
  #text_show .plugin-view { margin: -10px -16px -16px; }
</style></head>
<body>
<div id="my_search_box"><div id="my_search_view"><div id="text_show">
  <div class="plugin-view" id="plugin-host"></div>
</div></div></div>
<script type="module">
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const files = await (await fetch("/api/plugin-files")).json();
const style = document.createElement("style");
style.textContent = files.css;
document.head.appendChild(style);
const host = document.getElementById("plugin-host");
host.innerHTML = files.html;

const calls = [];
window.__calls = calls;
window.__pickResult = null;
window.__pickCalls = [];
window.__providePick = true;

const store = {
  modelsPath: "C:/Users/tester/.pi/agent/models.json",
  custom: [{
    id: "MAG", name: "MAG 中转", baseUrl: "https://mag.example/v1", api: "openai-completions",
    hasApiKey: false, models: [{ id: "lite", name: "Lite", advanced: {}, available: true }],
    advanced: {}, builtin: false, authConfigured: false, authSource: "",
  }, {
    id: "FROMEV", name: "来自环境变量", baseUrl: "https://ev.example/v1", api: "openai-completions",
    hasApiKey: true, models: [{ id: "m", name: "M", advanced: {}, available: true }],
    advanced: {}, builtin: false, authConfigured: true,
    authSource: "environment", authLabel: "OPENAI_API_KEY",
  }],
  builtin: [],
  supportedApis: ["openai-completions"],
};

const backend = {
  async call(method, params) {
    calls.push({ method, params });
    await sleep(5);
    switch (method) {
      case "init": return { ok: true, hasPi: true };
      case "listModels": return { models: [], defaultModel: "" };
      case "listProjects": return { projects: [], badgeCount: 0 };
      case "listSessions": return { sessions: [], badgeCount: 0 };
      case "setConfig": return { ok: true };
      case "listProviders": return {
        custom: JSON.parse(JSON.stringify(store.custom)),
        builtin: JSON.parse(JSON.stringify(store.builtin)),
        agentDir: "C:/Users/tester/.pi/agent",
        modelsPath: store.modelsPath, fileExists: true, supportedApis: store.supportedApis,
      };
      case "saveProvider": { const p = store.custom.find(x => x.id === params.id) || {}; return { ok: true, id: params.id }; }
      default: return { ok: true };
    }
  },
  onNotification() { return () => {}; },
  offNotification() {},
};

const ms = {
  backend,
  log() {},
  ui: { toast() {}, confirm: async () => true },
  store: { get: async () => null, set: async () => true, remove: async () => true, keys: async () => [] },
  search: { query: async () => [] },
  plugin: { id: "com.mysearch.pi-agent", info: { id: "com.mysearch.pi-agent", name: "Pi Agent", version: "2.1.0", enabled: true }, granted: () => [], has: () => false },
  env: undefined,   // 由开关决定是否提供
};

window.__setPick = (provide, result) => {
  window.__providePick = provide;
  window.__pickResult = result;
  if (provide) {
    ms.env = {
      granted: () => ["OPENAI_API_KEY"],
      has: (n) => n === "OPENAI_API_KEY",
      list: async () => [{ name: "OPENAI_API_KEY", description: "主密钥", secret: true }],
      pick: async (opts) => {
        window.__pickCalls.push(opts || null);
        return window.__pickResult;
      },
    };
  } else {
    ms.env = undefined;
  }
};
// ?noenv=1 → 模拟「老宿主 / 插件独立调试」：ms 上完全没有 env
window.__setPick(!location.search.includes("noenv"), null);

const fn = new Function("ms", "env", "plugin", "host", "keyword", "inputValue", "onSubKeyword", "md2html", "openExternal", files.js);
fn(ms, { cache: { get: async () => null, set: async () => {} } },
   { id: "com.mysearch.pi-agent", name: "Pi Agent", version: "2.1.0", dir: "", isDev: false },
   host, "", "", () => {}, (s) => s, () => {});

window.__ready = true;
window.__openProvider = async (id) => {
  // 打开设置 → 点进某个提供商
  document.getElementById("pi-settings-btn")?.click();
  await sleep(350);
  const row = [...document.querySelectorAll(".pi-provider-row")].find(r => r.dataset.providerId === id);
  row?.click();
  await sleep(250);
};
</script>
</body></html>`;

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

const userDir = path.join(root, "test", "_chrome-profile-pi-env-pick");
await rm(userDir, { recursive: true, force: true });
const chrome = spawn(
  bin,
  ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${userDir}`, "about:blank"],
  { stdio: ["ignore", "ignore", "pipe"] }
);
const wsUrl = await new Promise((resolve, reject) => {
  let buf = "";
  const t = setTimeout(() => reject(new Error("浏览器启动超时")), 20000);
  chrome.stderr.on("data", (d) => {
    buf += d.toString();
    const m = buf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (m) { clearTimeout(t); resolve(m[1]); }
  });
});
const ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
const pageErrors = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
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
const { result: { sessionId } } = await S("Target.attachToTarget", { targetId: pageTarget.targetId, flatten: true });
await S("Runtime.enable", {}, sessionId);
await S("Page.enable", {}, sessionId);
const evalJs = async (expr) => {
  const r = await S("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.result?.exceptionDetails) {
    throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails).slice(0, 400));
  }
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("PASS ", name, extra ? ` — ${extra}` : ""); }
  else { fail++; console.log("FAIL ", name, extra ? ` — ${extra}` : ""); }
};

const baseSel = `document.querySelector('#pi-provider-apikey')`;

await S("Page.navigate", { url: base + "/" }, sessionId);
await sleep(1400);
check("夹具加载（插件 UI 已挂载）", await evalJs(`!!window.__ready`));

/* ---- 1. 宿主提供 ms.env → 出现「变量」按钮 ---- */
await evalJs(`window.__openProvider("MAG")`);
await sleep(400);
check("API Key 输入框存在", await evalJs(`!!${baseSel}`));
check("宿主提供 ms.env 时出现「变量」按钮", await evalJs(`!!document.querySelector('.pi-secret-pick')`));
check("「变量」按钮在「显示」按钮左侧", await evalJs(`
  (() => {
    const pick = document.querySelector('.pi-secret-pick')?.getBoundingClientRect();
    const tog = document.querySelector('.pi-secret-toggle')?.getBoundingClientRect();
    return !!pick && !!tog && pick.right <= tog.left + 1;
  })()
`));

/* ---- 2. 点按钮 → 调 ms.env.pick，带 title/purpose；返回 null 时不动输入框 ---- */
await evalJs(`document.querySelector('.pi-secret-pick').click()`);
await sleep(300);
const pickCall = await evalJs(`JSON.stringify(window.__pickCalls)`);
const pickCalls = JSON.parse(pickCall || "[]");
check("点「变量」调用了 ms.env.pick", pickCalls.length === 1, pickCall);
check("pick 带上了用途说明（title/purpose）", !!(pickCalls[0] && pickCalls[0].title && pickCalls[0].purpose), pickCall);
check("用户取消（返回 null）时输入框保持为空", (await evalJs(`${baseSel}.value`)) === "");

/* ---- 3. 返回 ref → 输入框填 $NAME + 出现说明条 ---- */
await evalJs(`window.__setPick(true, { kind: "ref", name: "OPENAI_API_KEY", ref: "$OPENAI_API_KEY" })`);
await evalJs(`window.__openProvider("MAG")`);
await sleep(350);
await evalJs(`document.querySelector('.pi-secret-pick').click()`);
await sleep(300);
check("选中变量后输入框填入 $NAME", (await evalJs(`${baseSel}.value`)) === "$OPENAI_API_KEY", await evalJs(`${baseSel}.value`));
check("输入框切成明文可见（引用不是密钥，可读）", (await evalJs(`${baseSel}.type`)) === "text");
const note = await evalJs(`document.querySelector('.pi-field-note')?.textContent || ''`);
check("出现「引用环境变量」说明条", note.includes("OPENAI_API_KEY") && note.includes("环境变量"), note);
check("说明条明确「不写入 models.json」", note.includes("models.json"), note);

/* ---- 4. 返回 literal → 填字面量、不留引用说明 ---- */
await evalJs(`window.__openProvider("MAG")`);
await sleep(350);
await evalJs(`window.__setPick(true, { kind: "literal", value: "sk-manual-123" })`);
await evalJs(`document.querySelector('.pi-secret-pick').click()`);
await sleep(300);
check("手工输入字面量被填入输入框", (await evalJs(`${baseSel}.value`)) === "sk-manual-123", await evalJs(`${baseSel}.value`));
check("手工字面量不出现「环境变量引用」说明条", !(await evalJs(`!!document.querySelector('.pi-field-note')`)));

/* ---- 5. 列表里从环境变量取密钥的提供商有专用徽章 ---- */
// 先回到提供商列表（当前停在 MAG 的详情表单里）
await evalJs(`document.querySelector('.pi-back-btn')?.click()`);
await sleep(350);
const chips = await evalJs(`JSON.stringify([...document.querySelectorAll('.pi-provider-row')].map(r => ({
  id: r.dataset.providerId,
  chips: [...r.querySelectorAll('.pi-chip')].map(c => ({ t: c.textContent, env: c.classList.contains('env') })),
})))`);
const chipList = JSON.parse(chips || "[]");
check("提供商列表已渲染两行", chipList.length === 2, chips);
const fromEvRow = chipList.find((r) => r.id === "FROMEV");
check("authSource=environment 的提供商显示「环境变量 NAME」徽章", !!fromEvRow && fromEvRow.chips.some((c) => c.env && c.t.includes("OPENAI_API_KEY")), chips);
const magRow = chipList.find((r) => r.id === "MAG");
check("普通提供商仍是「已配密钥」口径", !!magRow && !magRow.chips.some((c) => c.env), chips);

/* ---- 6. 宿主不提供 ms.env → 按钮消失（兼容老宿主 / 独立调试） ---- */
/**
 * 换一个**全新页面**加载（带上 ?noenv=1 → 宿主桩不提供 ms.env）。
 *
 * 为什么不复用当前页面再跑一遍入口脚本：插件是用 `document.getElementById`
 * 取节点的，第二个实例会和第一个抢同一批 id（真实宿主里一个插件只会挂一次）。
 * 新页面才是「老宿主」的正确模拟方式。
 */
await S("Page.navigate", { url: base + "/?noenv=1" }, sessionId);
await sleep(1400);
check("（老宿主）夹具仍能加载", await evalJs(`!!window.__ready`));
await evalJs(`window.__openProvider("MAG")`);
await sleep(400);
check("宿主无 ms.env 时不出现「变量」按钮", !(await evalJs(`!!document.querySelector('.pi-secret-pick')`)));
check("宿主无 ms.env 时 API Key 输入框照旧可用（界面未破坏）", await evalJs(`!!document.querySelector('#pi-provider-apikey')`));

check("页面无未捕获异常", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 200));

console.log(`\n${pass} passed, ${fail} failed`);
ws.close();
chrome.kill();
server.close();
process.exit(fail === 0 ? 0 : 1);
