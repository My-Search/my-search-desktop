/**
 * 「环境变量」面板 + 宿主授权选择器的浏览器验收（无 Tauri，用 IPC 模拟）。
 *
 * 用户诉求与要钉死的契约：
 *   1. 设置窗口左侧出现「环境变量」面板，可增删改变量；
 *   2. 插件配置里的输入框能**呼出宿主绘制的可搜索选择器**（类微信授权），
 *      支持键盘 ↑↓ / Enter / Esc；
 *   3. 未授权项先就地确认「允许某插件使用某变量」才生效；
 *   4. ★ **选择器 DOM 里绝不出现变量值**（inlay 不是沙箱，明文进 DOM 就等于
 *      把密钥交给插件脚本）——只显示名字、说明与固定掩码；
 *   5. 授权写入注册表后，网关同步会带上**按授权过滤**过的 env。
 *
 * 用法: npm run build && node test/env-picker-ui.test.mjs
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
  ".svg": "image/svg+xml",
  ".png": "image/png",
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

const userDir = path.join(root, "test", "_chrome-profile-env-picker");
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
      JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails).slice(0, 400)
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

/* ---------------- 预置数据 ---------------- */
const now = Date.now();
/** 敏感值：绝不允许出现在选择器 DOM 里 */
const SECRET_A = "sk-TOPSECRET-AAA-1234567890";
const SECRET_B = "sk-TOPSECRET-BBB-0987654321";

const ENV_VARS = [
  { name: "OPENAI_API_KEY", value: SECRET_A, description: "OpenAI 主密钥", secret: true, createdAt: now, updatedAt: now },
  { name: "ANTHROPIC_API_KEY", value: SECRET_B, description: "Claude 密钥", secret: true, createdAt: now, updatedAt: now },
  { name: "PROXY_URL", value: "http://127.0.0.1:7890", description: "本地代理", secret: false, createdAt: now, updatedAt: now },
];

const PLUGIN_RECORD = {
  id: "com.test.envuser",
  name: "测试插件",
  version: "1.0.0",
  apiVersion: 1,
  description: "要用环境变量的插件",
  manifest: {
    id: "com.test.envuser",
    name: "测试插件",
    version: "1.0.0",
    apiVersion: 1,
    permissions: ["ui.inlay"],
    optionalPermissions: [],
    backend: { entry: "backend/app.exe", env: { MY_KEY: "$OPENAI_API_KEY" } },
  },
  dir: "plugins/com.test.envuser",
  source: { kind: "file", ref: "x.mspp" },
  installedAt: now,
  updatedAt: now,
  enabled: true,
  autoStart: "on-demand",
  requestedAutoStart: "on-demand",
  closeBehavior: "minimize",
  grants: [{ permission: "backend.spawn", at: now, source: "install" }],
  denied: [],
  runtime: { status: "stopped", pid: null, memoryBytes: null, startedAt: null, restarts: 0, lastError: null, keepAliveReasons: [] },
  integrity: { sha256: null, signed: false },
};

/* ---------------- 注入 IPC 模拟 ---------------- */
await S(
  "Page.addScriptToEvaluateOnNewDocument",
  {
    source: `
    window.__invoked = [];
    window.__TAURI_INTERNALS__ = {
      invoke(cmd, args) {
        window.__invoked.push({ cmd, args: JSON.parse(JSON.stringify(args || {})) });
        if (cmd === 'plugin_gateway_sync') return Promise.resolve(null);
        if (cmd === 'plugin_backend_list') return Promise.resolve([]);
        if (cmd === 'plugin_backend_stop' || cmd === 'plugin_backend_restart') return Promise.resolve(null);
        if (cmd === 'plugin_read_binary') return Promise.reject('文件不存在');
        // 列表类命令必须回数组：面板会直接把它当列表渲染
        if (cmd === 'builtin_list' || cmd === 'list_plugin_backends') return Promise.resolve([]);
        return Promise.resolve(null);
      },
      transformCallback(cb) {
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

/* ================= 1. 预置数据并打开设置窗口 ================= */
await S("Page.navigate", { url: base + "/config.html" }, sessionId);
await sleep(700);
await evalJs(`
  (() => {
    localStorage.clear();
    localStorage.setItem('my-search-desktop:ENV_VARS_CACHE_KEY', ${JSON.stringify(JSON.stringify(ENV_VARS))});
    localStorage.setItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY', JSON.stringify({
      version: 1, plugins: ${JSON.stringify([PLUGIN_RECORD])},
    }));
    return 1;
  })()
`);
await S("Page.navigate", { url: base + "/config.html" }, sessionId);
await sleep(900);

/* ================= 2. 环境变量面板 ================= */
check("左侧菜单出现「环境变量」入口", await evalJs(`!!document.querySelector('.cfg-nav .nav-item[data-pane="env"]')`));
await evalJs(`document.querySelector('.cfg-nav .nav-item[data-pane="env"]').click()`);
await sleep(700);
check("环境变量面板渲染", await evalJs(`!!document.querySelector('#ms-config-view .page.env')`));

const rows = await evalJs(`JSON.stringify([...document.querySelectorAll('.page.env .env-item')].map(el => ({
  name: el.querySelector('.env-item-name code')?.textContent || '',
  value: el.querySelector('.env-value')?.textContent || '',
  desc: el.querySelector('.env-item-desc')?.textContent || '',
})))`);
const rowList = JSON.parse(rows || "[]");
check("列出了 3 个变量", rowList.length === 3, rows);
check(
  "变量名按序显示",
  rowList.map((r) => r.name).join(",") === "ANTHROPIC_API_KEY,OPENAI_API_KEY,PROXY_URL",
  rowList.map((r) => r.name).join(",")
);

/* ---- 掩码：密钥默认不显示明文，且不泄漏长度 ---- */
const panelText = await evalJs(`document.querySelector('.page.env')?.textContent || ''`);
check("★ 密钥明文不出现在面板里", !panelText.includes(SECRET_A) && !panelText.includes(SECRET_B), panelText.slice(0, 60));
const masked = rowList.find((r) => r.name === "OPENAI_API_KEY")?.value || "";
check("密钥显示为固定掩码", masked.includes("•"), masked);
check("★ 掩码长度与真实值无关（三个密钥行掩码完全一致）", (() => {
  const a = rowList.find((r) => r.name === "OPENAI_API_KEY")?.value;
  const b = rowList.find((r) => r.name === "ANTHROPIC_API_KEY")?.value;
  return a === b;
})(), JSON.stringify([rowList.find((r) => r.name === "OPENAI_API_KEY")?.value, rowList.find((r) => r.name === "ANTHROPIC_API_KEY")?.value]));
check("非密钥变量直接显示明文", rowList.find((r) => r.name === "PROXY_URL")?.value === "http://127.0.0.1:7890");

/* ---- 「显示」按钮揭示明文（仅设置窗口允许） ---- */
await evalJs(`
  (() => {
    const row = [...document.querySelectorAll('.page.env .env-item')].find(el => el.querySelector('.env-item-name code')?.textContent === 'OPENAI_API_KEY');
    row.querySelector('.env-item-value .btn-link').click();
    return 1;
  })()
`);
await sleep(200);
check("点「显示」后设置窗口能看到明文（这是唯一允许看到的地方）", await evalJs(`
  (() => {
    const row = [...document.querySelectorAll('.page.env .env-item')].find(el => el.querySelector('.env-item-name code')?.textContent === 'OPENAI_API_KEY');
    return (row.querySelector('.env-value')?.textContent || '').includes(${JSON.stringify(SECRET_A)});
  })()
`));

/* ---- 新增变量 ---- */
await evalJs(`document.querySelector('.page.env .env-toolbar .cfg-btn.primary').click()`);
await sleep(200);
check("新增表单出现", await evalJs(`!!document.querySelector('.page.env .env-form')`));
await evalJs(`
  (() => {
    const form = document.querySelector('.page.env .env-form');
    const inputs = form.querySelectorAll('.cfg-row .cfg-input');
    const setVal = (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setVal(inputs[0], 'MY_NEW_KEY');
    setVal(inputs[1], 'value-new');
    setVal(inputs[2], '新加的密钥');
    return 1;
  })()
`);
await sleep(150);
await evalJs(`document.querySelector('.page.env .env-form .cfg-btn.primary').click()`);
await sleep(400);
check("新增后列表变成 4 项", (await evalJs(`document.querySelectorAll('.page.env .env-item').length`)) === 4);
check("新增的变量已持久化", await evalJs(`
  (JSON.parse(localStorage.getItem('my-search-desktop:ENV_VARS_CACHE_KEY')) || []).some(v => v.name === 'MY_NEW_KEY')
`));

/* ---- 非法名字校验 ---- */
await evalJs(`document.querySelector('.page.env .env-toolbar .cfg-btn.primary').click()`);
await sleep(150);
await evalJs(`
  (() => {
    const form = document.querySelector('.page.env .env-form');
    const input = form.querySelectorAll('.cfg-row .cfg-input')[0];
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'BAD NAME');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 1;
  })()
`);
await sleep(150);
await evalJs(`document.querySelector('.page.env .env-form .cfg-btn.primary').click()`);
await sleep(250);
const errText = await evalJs(`document.querySelector('.page.env .env-error')?.textContent || ''`);
check("非法变量名给出中文错误且不写入", errText.includes("字母") && !(await evalJs(`
  (JSON.parse(localStorage.getItem('my-search-desktop:ENV_VARS_CACHE_KEY')) || []).some(v => v.name === 'BAD NAME')
`)), errText);
// 收掉表单，避免影响后续
await evalJs(`document.querySelector('.page.env .env-form .cfg-btn.ghost')?.click()`);
await sleep(150);

/* ================= 3. 插件面板：授权区 + 选择器 ================= */
await evalJs(`document.querySelector('.cfg-nav .nav-item[data-pane="plugins"]').click()`);
await sleep(1000);
check("插件面板渲染", await evalJs(`!!document.querySelector('#ms-config-view .page.plugins')`));

// 展开插件详情
await evalJs(`document.querySelector('.page.plugins .plugins-list .plugin-item .plugin-header').click()`);
await sleep(400);
check("插件详情里有「环境变量」行", await evalJs(`
  [...document.querySelectorAll('.page.plugins .plugin-info-row .plugin-info-label')].some(el => el.textContent.trim() === '环境变量')
`));

/* ---- 打开选择器 ---- */
await evalJs(`document.querySelector('.page.plugins .env-grant-cell .btn-sm').click()`);
await sleep(400);
check("授权选择器已打开", await evalJs(`!!document.querySelector('.env-picker-overlay.show')`));
check("选择器标题包含插件名", (await evalJs(`document.querySelector('.env-picker-head h3')?.textContent || ''`)).includes("环境变量"));

/* ---- ★ 最关键的安全性断言：选择器 DOM 里没有任何变量明文 ---- */
const pickerHtml = await evalJs(`document.querySelector('.env-picker-dialog')?.outerHTML || ''`);
const pickerText = await evalJs(`document.querySelector('.env-picker-dialog')?.textContent || ''`);
check("★ 选择器 HTML 不含任何密钥明文", !pickerHtml.includes(SECRET_A) && !pickerHtml.includes(SECRET_B));
check("★ 选择器文本不含任何密钥明文", !pickerText.includes(SECRET_A) && !pickerText.includes(SECRET_B));
check("选择器里也不含非密钥变量的值（值一律不渲染）", !pickerText.includes("127.0.0.1:7890"), pickerText.slice(0, 100));
check("选择器只显示固定掩码", pickerHtml.includes("••"), pickerHtml.length + " chars");
check("选择器列出全部变量（名字可见）", ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "PROXY_URL", "MY_NEW_KEY"].every((n) => pickerText.includes(n)));

/* ---- 搜索过滤 ---- */
await evalJs(`
  (() => {
    const input = document.querySelector('.env-picker-search input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'OPENAI');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 1;
  })()
`);
await sleep(250);
const filteredNames = await evalJs(`JSON.stringify([...document.querySelectorAll('.env-picker-row')].map(r => r.querySelector('.env-picker-name code')?.textContent))`);
check("搜索可过滤变量", JSON.parse(filteredNames || "[]").join(",") === "OPENAI_API_KEY", filteredNames);
check("★ 过滤结果同样不含明文", !(await evalJs(`document.querySelector('.env-picker-dialog')?.textContent || ''`)).includes(SECRET_A));

/* ---- 键盘：Esc 关闭 ---- */
await evalJs(`
  (() => {
    const dlg = document.querySelector('.env-picker-dialog');
    dlg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return 1;
  })()
`);
await sleep(300);
check("Esc 关闭选择器", !(await evalJs(`!!document.querySelector('.env-picker-overlay.show')`)));

/* ---- 键盘：↓ + Enter 选择已授权项（未授权时应进入确认态） ---- */
await evalJs(`document.querySelector('.page.plugins .env-grant-cell .btn-sm').click()`);
await sleep(400);
await evalJs(`
  (() => {
    const dlg = document.querySelector('.env-picker-dialog');
    dlg.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    return 1;
  })()
`);
await sleep(200);
const activeCount = await evalJs(`document.querySelectorAll('.env-picker-row.active').length`);
check("↑↓ 能移动高亮项", activeCount === 1, String(activeCount));

/* ---- 未授权 → 就地确认 → 允许 ---- */
await evalJs(`document.querySelector('.env-picker-row.active').click()`);
await sleep(300);
const confirmText = await evalJs(`document.querySelector('.env-picker-confirm-text')?.textContent || ''`);
check("未授权项先就地确认（不直接授权）", confirmText.includes("允许") && confirmText.includes("测试插件"), confirmText);
check("确认态尚未写入授权", !(await evalJs(`
  (JSON.parse(localStorage.getItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY')).plugins[0].grants || []).some(g => g.permission.startsWith('env.read:'))
`)));
check("★ 确认条也不渲染明文", !(await evalJs(`document.querySelector('.env-picker-dialog')?.textContent || ''`)).includes(SECRET_A));

await evalJs(`document.querySelector('.env-picker-confirm-actions .env-picker-allow').click()`);
await sleep(700);
const grantedName = await evalJs(`document.querySelector('.env-picker-row.active .env-picker-name code')?.textContent || ''`);
check("点「允许」后写入 env.read:<NAME> 授权", await evalJs(`
  (JSON.parse(localStorage.getItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY')).plugins[0].grants || [])
    .some(g => g.permission === 'env.read:' + ${JSON.stringify(grantedName)})
`), grantedName);
check("授权后选择器关闭并回传引用", !(await evalJs(`!!document.querySelector('.env-picker-overlay.show')`)));

/* ---- 授权区出现胶囊 + 网关同步带上过滤后的 env ---- */
check("插件行出现已授权变量胶囊", await evalJs(`!!document.querySelector('.page.plugins .env-grant-chip code')`));

const syncs = await evalJs(`JSON.stringify((window.__invoked || []).filter(c => c.cmd === 'plugin_gateway_sync').map(c => c.args.spec && c.args.spec.env))`);
const envPayloads = JSON.parse(syncs || "[]");
const lastEnv = envPayloads[envPayloads.length - 1] || {};
check("★ 网关同步的 env 只含已授权变量", Object.keys(lastEnv).join(",") === grantedName, syncs);
const otherNames = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "PROXY_URL", "MY_NEW_KEY"].filter((n) => n !== grantedName);
check("★ 未授权变量没有进 env", otherNames.every((n) => !Object.keys(lastEnv).includes(n)), syncs);
check("清单声明的 $OPENAI_API_KEY 未授权时不注入 MY_KEY", !Object.keys(lastEnv).includes("MY_KEY") || grantedName === "OPENAI_API_KEY", syncs);

/* ---- 撤销 ---- */
await evalJs(`
  (() => {
    const chip = document.querySelector('.page.plugins .env-grant-chip');
    chip.querySelector('.btn-link').click();
    return 1;
  })()
`);
await sleep(300);
// 确认弹窗
await evalJs(`document.getElementById('msgOk')?.click()`);
await sleep(600);
check("撤销后授权被移除", !(await evalJs(`
  (JSON.parse(localStorage.getItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY')).plugins[0].grants || [])
    .some(g => g.permission.startsWith('env.read:'))
`)));
check("撤销后插件行回到「未授权」", (await evalJs(`document.querySelector('.page.plugins .no-perms')?.textContent || ''`)).includes("环境变量"));

/* ================= 4. 无未捕获异常 ================= */
check("页面无未捕获异常", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 200));

console.log(`\n${pass} passed, ${fail} failed`);
ws.close();
chrome.kill();
server.close();
// 不在这里删 profile：Chrome 退出后仍可能短暂持有文件（EBUSY），
// 下次运行开头的 rm 会清掉（与 plugin-panel-ui.test.mjs 同一做法）。
process.exit(fail === 0 ? 0 : 1);
