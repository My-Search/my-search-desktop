/**
 * pi-agent 设置面板 UI 回归测试（真实浏览器 + 真实插件 UI 文件 + mock 后端）。
 *
 * 覆盖本次需求：
 *   1. 「添加项目」按钮紧贴最后一个项目图标（不再是栏底），设置按钮沉底；
 *   2. 点设置按钮 → 整屏覆盖的设置界面：左侧菜单（仅「模型配置」）+ 右内容；
 *   3. 模型配置按「提供商 → 模型」的方式呈现：
 *      自定义提供商可点进编辑，内置提供商只读展示；
 *   4. 编辑表单字段回填正确，保存时把基础字段 + 高级折叠 JSON 正确合并发给后端；
 *   5. 高级 JSON 非法 → 面板内报错且**不发**保存请求；
 *   6. 删除走二次确认；Esc / ✕ 能关掉设置回到对话界面。
 *
 * 夹具是自包含生成的（test/_tmp/pi-settings-harness.html），不依赖其它测试的产物。
 * 用法: node test/pi-agent-settings-ui.test.mjs
 */
import { createServer } from "http";
import { readFile, rm, writeFile, mkdir } from "fs/promises";
import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = path.join(root, "plugins", "pi-agent", "ui");
const tmpDir = path.join(root, "test", "_tmp");
await mkdir(tmpDir, { recursive: true });

/* ---------------- 夹具：近似宿主环境 + mock 后端 ---------------- */
const harness = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>pi-agent settings harness</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: #fff; }
  #my_search_box { position: relative; border: 2px solid #cecece; width: 100%; background: #fff; }
  #searchBox { height: 44px; background: #fff; padding: 0 10px; display: flex; align-items: center; }
  #text_show { padding: 10px 16px 16px; max-height: 510px; overflow-y: auto; overflow-x: hidden; box-sizing: border-box; }
  #text_show .plugin-view { margin: -10px -16px -16px; }
</style>
</head>
<body>
<div id="my_search_box">
  <div id="searchBox"><input id="my_search_input" value="AI"></div>
  <div id="my_search_view">
    <div id="text_show">
      <div class="plugin-view" id="plugin-host"></div>
    </div>
  </div>
</div>
<script type="module">
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const files = await (await fetch("/api/plugin-files")).json();

const style = document.createElement("style");
style.textContent = files.css;
document.head.appendChild(style);

const host = document.getElementById("plugin-host");
host.innerHTML = files.html;

/* ---------------- mock 后端 ---------------- */
const notifications = new Map();
const calls = [];

// 服务器端持有的「models.json」状态，save/delete 会真的改它，便于断言往返
const store = {
  modelsPath: "C:\\\\Users\\\\tester\\\\.pi\\\\agent\\\\models.json",
  custom: [
    {
      id: "MAG",
      name: "MAG 中转",
      baseUrl: "https://mag.example/v1",
      api: "openai-completions",
      hasApiKey: true,
      models: [
        { id: "lite", name: "Lite", reasoning: true, input: ["text", "image"], contextWindow: 512000, maxTokens: 200000, advanced: { thinkingLevelMap: { xhigh: "max" } }, available: true },
        { id: "worth", reasoning: true, input: [], advanced: {}, available: false },
      ],
      advanced: { compat: { supportsDeveloperRole: false, supportsReasoningEffort: true } },
      builtin: false,
      authConfigured: true,
      authSource: "stored",
    },
  ],
  builtin: [
    { id: "openai", name: "OpenAI", modelCount: 39, availableCount: 0, sampleModels: [], builtin: true, authConfigured: false, authSource: "" },
    { id: "anthropic", name: "Anthropic", modelCount: 14, availableCount: 0, sampleModels: [], builtin: true, authConfigured: false, authSource: "" },
  ],
  supportedApis: ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"],
};

let confirmAnswer = true;

const backend = {
  async call(method, params) {
    calls.push({ method, params });
    await sleep(5);
    switch (method) {
      case "init": return { ok: true, hasPi: true };
      case "listModels": return { models: [
        { provider: "MAG", id: "lite", name: "Lite", available: true },
        { provider: "MAG", id: "worth", name: "worth", available: false },
      ], defaultModel: "MAG:lite" };
      case "listProjects": return { projects: [{ id: "p1", name: "小游戏", path: "D:\\\\data\\\\小游戏", badgeCount: 0, sessionCount: 2 }] };
      case "listSessions": return { sessions: [{ id: "s1", title: "你好", messageCount: 2, flag: null }], badgeCount: 0 };
      case "loadSession": return { transcript: [
        { role: "user", content: "hi" }, { role: "assistant", content: "hello" },
      ] };
      case "markViewed": return { ok: true };
      case "setConfig": return { ok: true };
      case "listProviders": return {
        custom: JSON.parse(JSON.stringify(store.custom)),
        builtin: JSON.parse(JSON.stringify(store.builtin)),
        agentDir: "C:\\\\Users\\\\tester\\\\.pi\\\\agent",
        modelsPath: store.modelsPath,
        fileExists: true,
        supportedApis: store.supportedApis,
      };
      case "saveProvider": {
        const incoming = params.provider;
        if (incoming.__forceError) throw new Error("模拟后端拒绝");
        const next = {
          id: params.id,
          name: incoming.name || "",
          baseUrl: incoming.baseUrl || "",
          api: incoming.api || "",
          hasApiKey: Boolean(incoming.apiKey) || Boolean(params.keepApiKey),
          models: (incoming.models || []).map((m) => ({
            id: m.id, name: m.name || "", reasoning: !!m.reasoning,
            input: m.input || [], contextWindow: m.contextWindow, maxTokens: m.maxTokens,
            advanced: m.advanced || {}, available: false,
          })),
          advanced: incoming.advanced || {},
          builtin: false, authConfigured: true, authSource: "stored",
        };
        const i = store.custom.findIndex((p) => p.id === params.id);
        if (i >= 0) store.custom[i] = next; else store.custom.push(next);
        return { ok: true, id: params.id, backupPath: store.modelsPath + ".bak" };
      }
      case "deleteProvider": {
        store.custom = store.custom.filter((p) => p.id !== params.id);
        return { ok: true, id: params.id, backupPath: store.modelsPath + ".bak" };
      }
      default: return null;
    }
  },
  onNotification(method, handler) {
    if (!notifications.has(method)) notifications.set(method, new Set());
    notifications.get(method).add(handler);
    return () => notifications.get(method)?.delete(handler);
  },
  offNotification() {},
  _clearNotifications() { notifications.clear(); },
};

window.ms = {
  backend,
  log() {},
  ui: { confirm: async () => confirmAnswer, toast() {} },
  store: { get: async () => null, set: async () => true },
};

const fn = new Function(
  "ms", "env", "plugin", "host", "keyword", "inputValue", "onSubKeyword", "md2html", "openExternal",
  '"use strict";\\n' + files.js + '\\n'
);
fn(window.ms, window.ms, { id: "com.mysearch.pi-agent", name: "Pi Agent", version: "2.1.0" },
  host, "AI", "", () => {}, (raw) => String(raw == null ? "" : raw), () => {});

window.__calls = calls;
window.__store = store;
window.__setConfirm = (v) => { confirmAnswer = v; };
window.__ready = true;
</script>
</body>
</html>`;
await writeFile(path.join(tmpDir, "pi-settings-harness.html"), harness, "utf8");

/* ---------------- 静态服务器 ---------------- */
const server = createServer(async (req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  try {
    if (u === "/" || u === "/pi-settings-harness.html") {
      const body = await readFile(path.join(tmpDir, "pi-settings-harness.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(body);
    }
    if (u === "/api/plugin-files") {
      const [html, css, js] = await Promise.all([
        readFile(path.join(pluginDir, "detail.html"), "utf8"),
        readFile(path.join(pluginDir, "detail.css"), "utf8"),
        readFile(path.join(pluginDir, "index.js"), "utf8"),
      ]);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ html, css, js }));
    }
    res.writeHead(404).end("not found");
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

/* ---------------- 浏览器 ---------------- */
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

const userDir = path.join(root, "test", "_chrome-profile-pi-settings");
await rm(userDir, { recursive: true, force: true });
const chrome = spawn(bin, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--window-size=880,700",
  "--remote-debugging-port=0",
  `--user-data-dir=${userDir}`,
  "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });

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
    throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails).slice(0, 500));
  }
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("PASS ", name, extra ? ` — ${extra}` : ""); }
  else { fail++; console.log("FAIL ", name, extra ? ` — ${extra}` : ""); }
};

await S("Page.navigate", { url: base + "/pi-settings-harness.html" }, sessionId);
await sleep(1500);
check("夹具加载（插件 UI 已挂载）", await evalJs(`!!document.querySelector('.pi-agent-container')`));

/* ============ 1. 左栏：添加按钮紧贴最后一个项目，设置按钮沉底 ============ */
const rail = JSON.parse(await evalJs(`JSON.stringify((() => {
  const list = document.getElementById('pi-project-list');
  const lastIcon = list.lastElementChild;
  const add = document.getElementById('pi-add-project').getBoundingClientRect();
  const settings = document.getElementById('pi-settings-btn').getBoundingClientRect();
  const sidebar = document.querySelector('.sidebar-left').getBoundingClientRect();
  const icon = lastIcon.getBoundingClientRect();
  const listRect = list.getBoundingClientRect();
  return {
    iconBottom: icon.bottom, listBottom: listRect.bottom,
    addTop: add.top, addBottom: add.bottom,
    settingsTop: settings.top, settingsBottom: settings.bottom, sidebarBottom: sidebar.bottom,
    listScrollHeight: list.scrollHeight, listClientHeight: list.clientHeight,
    // 添加按钮是否在项目列表正下方（而不是跑到别处）
    addLeft: add.left, listLeft: listRect.left,
  };
})())`));

check("「添加项目」按钮在最后一个项目图标下方",
  rail.addTop >= rail.iconBottom - 0.5 && rail.addTop <= rail.listBottom + 24,
  `iconBottom=${rail.iconBottom.toFixed(1)} addTop=${rail.addTop.toFixed(1)} listBottom=${rail.listBottom.toFixed(1)}`);
check("「添加项目」按钮紧贴项目列表（间距 ≤ 24px，不是被顶到栏底）",
  rail.addTop - rail.listBottom <= 24,
  `间距 ${(rail.addTop - rail.listBottom).toFixed(1)}px`);
check("「添加项目」按钮在设置按钮**上方**",
  rail.addTop < rail.settingsTop, `addTop=${rail.addTop.toFixed(1)} settingsTop=${rail.settingsTop.toFixed(1)}`);
check("设置按钮沉在左栏底部",
  rail.sidebarBottom - rail.settingsBottom <= 20,
  `底距 ${(rail.sidebarBottom - rail.settingsBottom).toFixed(1)}px`);
check("设置按钮带 icon 且可点击",
  await evalJs(`!!document.querySelector('#pi-settings-btn svg')`) === true);
check("项目列表没有因为按钮移动而溢出（无幽灵滚动条）",
  rail.listScrollHeight <= rail.listClientHeight + 1,
  `scrollHeight=${rail.listScrollHeight} clientHeight=${rail.listClientHeight}`);

/* ============ 2. 打开设置：左菜单 + 右内容 ============ */
check("初始状态设置面板是隐藏的", await evalJs(`document.getElementById('pi-settings').hidden`) === true);

await evalJs(`document.getElementById('pi-settings-btn').click(); 1`);
await sleep(500);

const panel = JSON.parse(await evalJs(`JSON.stringify((() => {
  const el = document.getElementById('pi-settings');
  const nav = el.querySelector('.pi-settings-nav');
  const items = [...el.querySelectorAll('.pi-settings-nav-item')];
  const body = document.getElementById('pi-settings-body');
  const container = document.getElementById('pi-agent').getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  return {
    hidden: el.hidden,
    navWidth: nav.getBoundingClientRect().width,
    items: items.map(i => i.textContent.trim()),
    active: el.querySelector('.pi-settings-nav-item.active')?.textContent.trim() || '',
    title: document.getElementById('pi-settings-title').textContent,
    hasBody: !!body,
    bodyOverflowY: getComputedStyle(body).overflowY,
    // 是否整屏覆盖（宽度铺满插件容器）
    coversWidth: Math.abs(rect.width - container.width) < 2,
    coversHeight: Math.abs(rect.height - container.height) < 2,
  };
})())`));

check("点设置按钮后设置面板打开", panel.hidden === false);
check("左侧有菜单栏", panel.navWidth > 100, `宽度 ${panel.navWidth}px`);
check("左菜单只有「模型配置」一项", panel.items.length === 1 && panel.items[0].includes("模型配置"),
  JSON.stringify(panel.items));
check("「模型配置」为当前选中项", panel.active.includes("模型配置"), panel.active);
check("右侧标题为「模型配置」", panel.title === "模型配置", panel.title);
check("设置面板整屏覆盖插件区域", panel.coversWidth && panel.coversHeight,
  JSON.stringify({ w: panel.coversWidth, h: panel.coversHeight }));
check("右侧内容区可独立滚动（内容超出时不会顶破容器）", panel.bodyOverflowY === "auto", panel.bodyOverflowY);

/* ============ 3. 提供商列表 ============ */
const listView = JSON.parse(await evalJs(`JSON.stringify((() => {
  const body = document.getElementById('pi-settings-body');
  const rows = [...body.querySelectorAll('.pi-provider-row')];
  return {
    count: rows.length,
    custom: rows.filter(r => !r.classList.contains('builtin')).map(r => r.dataset.providerId),
    builtin: rows.filter(r => r.classList.contains('builtin')).map(r => r.dataset.providerId),
    hasAddBtn: !!document.getElementById('pi-add-provider'),
    customChips: rows.filter(r => !r.classList.contains('builtin')).map(r => r.querySelector('.pi-chip')?.textContent || ''),
    builtinChips: rows.filter(r => r.classList.contains('builtin')).map(r => r.querySelector('.pi-chip')?.textContent || ''),
    pathShown: document.getElementById('pi-settings-agent-path').textContent,
    // 内置行是否有删除入口
    builtinHasEditAffordance: rows.filter(r => r.classList.contains('builtin')).some(r => r.querySelector('.pi-provider-arrow')),
  };
})())`));

check("列出自定义提供商", listView.custom.includes("MAG"), JSON.stringify(listView.custom));
check("列出内置提供商（只读展示）", listView.builtin.includes("openai") && listView.builtin.includes("anthropic"),
  JSON.stringify(listView.builtin));
check("自定义行标「自定义」", listView.customChips.includes("自定义"), JSON.stringify(listView.customChips));
check("内置行标「内置」", listView.builtinChips.every((c) => c === "内置"), JSON.stringify(listView.builtinChips));
check("内置行没有进入编辑的箭头（只读）", listView.builtinHasEditAffordance === false);
check("有「新增提供商」入口", listView.hasAddBtn === true);
check("左菜单脚注显示 models.json 路径", /models\.json$/.test(listView.pathShown), listView.pathShown);

// 点内置行不应进入编辑视图
await evalJs(`document.querySelector('.pi-provider-row.builtin').click(); 1`);
await sleep(250);
check("点内置提供商不会进入编辑（仍停在列表）",
  await evalJs(`!!document.getElementById('pi-add-provider')`) === true);

/* ============ 4. 进入自定义提供商：字段回填 ============ */
await evalJs(`[...document.querySelectorAll('.pi-provider-row')].find(r => r.dataset.providerId === 'MAG').click(); 1`);
await sleep(400);

const form = JSON.parse(await evalJs(`JSON.stringify((() => {
  const v = (id) => document.getElementById(id)?.value;
  return {
    id: v('pi-provider-id'), idDisabled: document.getElementById('pi-provider-id')?.disabled,
    name: v('pi-provider-name'), baseUrl: v('pi-provider-baseurl'),
    api: v('pi-provider-api'),
    apiOptions: [...document.querySelectorAll('#pi-provider-api option')].map(o => o.value),
    keyType: document.getElementById('pi-provider-apikey')?.type,
    keyPlaceholder: document.getElementById('pi-provider-apikey')?.placeholder || '',
    modelCount: document.querySelectorAll('#pi-provider-models .pi-model-card').length,
    modelIds: [...document.querySelectorAll('#pi-provider-models .pi-model-id')].map(i => i.value),
    modelContext: document.querySelector('#pi-provider-models .pi-model-context')?.value,
    modelReasoning: document.querySelector('#pi-provider-models .pi-model-reasoning')?.checked,
    modelImage: document.querySelector('#pi-provider-models .pi-model-image')?.checked,
    advancedOpen: !!document.querySelector('.pi-advanced[open]'),
    advancedText: document.querySelector('#pi-settings-body .pi-advanced textarea')?.value || '',
    hasBack: !!document.getElementById('pi-settings-back'),
    hasSave: !!document.getElementById('pi-save-provider'),
    hasDelete: !!document.getElementById('pi-delete-provider'),
    hasAddModel: !!document.getElementById('pi-add-model'),
  };
})())`));

check("返回按钮存在", form.hasBack === true);
check("提供商 ID 回填且不可改（改名=删除后新建）", form.id === "MAG" && form.idDisabled === true,
  JSON.stringify({ id: form.id, disabled: form.idDisabled }));
check("Base URL 回填", form.baseUrl === "https://mag.example/v1", form.baseUrl);
check("API 类型回填", form.api === "openai-completions", form.api);
check("API 下拉包含 pi 支持的 4 种类型",
  ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"].every((a) => form.apiOptions.includes(a)),
  JSON.stringify(form.apiOptions));
check("模型列表回填（2 个）", form.modelCount === 2 && form.modelIds.join(",") === "lite,worth",
  JSON.stringify(form.modelIds));
check("模型字段回填（上下文窗口 / reasoning / 图片输入）",
  form.modelContext === "512000" && form.modelReasoning === true && form.modelImage === true,
  JSON.stringify({ ctx: form.modelContext, r: form.modelReasoning, img: form.modelImage }));
check("API Key 不回显明文（留空=不修改）",
  form.keyType === "password" && form.keyPlaceholder.includes("留空"),
  JSON.stringify({ type: form.keyType, ph: form.keyPlaceholder }));
check("高级配置以 JSON 折叠区呈现且带原内容",
  form.advancedOpen && form.advancedText.includes("supportsDeveloperRole"),
  form.advancedText.slice(0, 60).replace(/\n/g, " "));
check("有保存 / 删除 / 添加模型入口",
  form.hasSave && form.hasDelete && form.hasAddModel);
check("高级配置里含模型级字段（thinkingLevelMap）",
  (await evalJs(`[...document.querySelectorAll('#pi-provider-models .pi-advanced textarea')]
      .some(t => t.value.includes('thinkingLevelMap'))`)) === true);

/* ---- 样式回归：面板是深色主题，任何控件露出浏览器默认样式都会很刺眼 ---- */
const styles = JSON.parse(await evalJs(`JSON.stringify((() => {
  const lum = (c) => { const n = String(c).replace(/[^0-9.,]/g,'').split(',').map(Number);
    return n.length >= 3 ? 0.299*n[0] + 0.587*n[1] + 0.114*n[2] : -1; };
  const controls = [...document.querySelectorAll('#pi-settings-body input, #pi-settings-body select, #pi-settings-body textarea')]
    .filter(el => el.type !== 'checkbox');
  return {
    count: controls.length,
    light: controls.filter(el => lum(getComputedStyle(el).backgroundColor) > 150)
      .map(el => ({ cls: String(el.className||''), bg: getComputedStyle(el).backgroundColor })),
    tiny: controls.filter(el => el.getBoundingClientRect().height < 22)
      .map(el => ({ cls: String(el.className||''), h: Math.round(el.getBoundingClientRect().height) })),
    // 折叠框被压扁（flex-shrink 事故）时它自身高度会接近 0
    collapsedBoxes: [...document.querySelectorAll('#pi-settings-body .pi-advanced')]
      .filter(d => d.getBoundingClientRect().height <= 5)
      .map(d => d.querySelector('summary')?.textContent || ''),
    // 高级配置的 JSON 文本框要有可用的编辑高度
    jsonBoxes: [...document.querySelectorAll('#pi-settings-body .pi-advanced textarea')]
      .map(t => Math.round(t.getBoundingClientRect().height)),
  };
})())`));

check("设置面板里没有漏斗成白底的控件（CSS 漏覆盖）",
  styles.light.length === 0 && styles.count > 0,
  JSON.stringify(styles.light));
check("设置面板里没有异常矮小的控件", styles.tiny.length === 0, JSON.stringify(styles.tiny));
check("★ 高级配置折叠框没有被压扁（flex-shrink 回归）",
  styles.collapsedBoxes.length === 0, JSON.stringify(styles.collapsedBoxes));
check("★ 高级配置 JSON 文本框有可用高度",
  styles.jsonBoxes.length > 0 && styles.jsonBoxes.every((h) => h >= 90),
  JSON.stringify(styles.jsonBoxes));

/* ============ 5. 保存：基础字段 + 高级 JSON 正确合并 ============ */
await evalJs(`(() => {
  const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
  set('pi-provider-baseurl', 'https://mag2.example/v1');
  set('pi-provider-name', 'MAG 新名字');
  document.getElementById('pi-provider-apikey').value = 'sk-new-key';
})(); 1`);
await sleep(100);
await evalJs(`document.getElementById('pi-save-provider').click(); 1`);
await sleep(700);

const saveCall = JSON.parse(await evalJs(`JSON.stringify(
  window.__calls.filter(c => c.method === 'saveProvider').slice(-1)[0] || null
)`));
check("保存发出了 saveProvider 请求", Boolean(saveCall), JSON.stringify(saveCall));
check("保存带上改动后的 Base URL / 名称 / 密钥",
  saveCall?.params?.provider?.baseUrl === "https://mag2.example/v1" &&
  saveCall?.params?.provider?.name === "MAG 新名字" &&
  saveCall?.params?.provider?.apiKey === "sk-new-key",
  JSON.stringify({ url: saveCall?.params?.provider?.baseUrl, name: saveCall?.params?.provider?.name, key: saveCall?.params?.provider?.apiKey }));
check("★ 提供商级高级字段（compat）原样带回后端，没被丢掉",
  saveCall?.params?.provider?.advanced?.compat?.supportsDeveloperRole === false,
  JSON.stringify(saveCall?.params?.provider?.advanced));
check("★ 模型级高级字段（thinkingLevelMap）原样带回后端",
  saveCall?.params?.provider?.models?.[0]?.advanced?.thinkingLevelMap?.xhigh === "max",
  JSON.stringify(saveCall?.params?.provider?.models?.[0]?.advanced));
check("模型基础字段一起提交（reasoning / input / 窗口）",
  saveCall?.params?.provider?.models?.[0]?.reasoning === true &&
  saveCall?.params?.provider?.models?.[0]?.contextWindow === 512000,
  JSON.stringify(saveCall?.params?.provider?.models?.[0]).slice(0, 160));

await sleep(400);
check("保存成功后回到提供商列表",
  await evalJs(`!!document.getElementById('pi-add-provider')`) === true);
check("保存后重新拉取模型列表（底部切换器同步）",
  (await evalJs(`window.__calls.filter(c => c.method === 'listModels').length`)) >= 2,
  `listModels 调用 ${await evalJs(`window.__calls.filter(c => c.method === 'listModels').length`)} 次`);
check("列表里能看到改后的名字", 
  (await evalJs(`[...document.querySelectorAll('.pi-provider-row')].some(r => (r.textContent||'').includes('MAG 新名字'))`)) === true);

/* ============ 6. 新增提供商 ============ */
await evalJs(`document.getElementById('pi-add-provider').click(); 1`);
await sleep(350);
const newForm = JSON.parse(await evalJs(`JSON.stringify({
  id: document.getElementById('pi-provider-id')?.value,
  idDisabled: document.getElementById('pi-provider-id')?.disabled,
  baseUrl: document.getElementById('pi-provider-baseurl')?.value,
  models: document.querySelectorAll('#pi-provider-models .pi-model-card').length,
})`));
check("新增视图：ID 可填且为空", newForm.id === "" && newForm.idDisabled === false,
  JSON.stringify(newForm));
check("新增视图：字段是空的", newForm.baseUrl === "" && newForm.models === 0, JSON.stringify(newForm));

await evalJs(`(() => {
  const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
  set('pi-provider-id', 'MyOllama');
  set('pi-provider-baseurl', 'http://localhost:11434/v1');
  document.getElementById('pi-provider-api').value = 'openai-completions';
  document.getElementById('pi-add-model').click();
})(); 1`);
await sleep(300);
await evalJs(`(() => {
  const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
  set(document.querySelector('#pi-provider-models .pi-model-id'), 'qwen2.5-coder:7b');
  set(document.querySelector('#pi-provider-models .pi-model-context'), '32768');
})(); 1`);
await evalJs(`document.getElementById('pi-save-provider').click(); 1`);
await sleep(700);

const addCall = JSON.parse(await evalJs(`JSON.stringify(
  window.__calls.filter(c => c.method === 'saveProvider').slice(-1)[0] || null
)`));
check("新增提供商走同一个 saveProvider",
  addCall?.params?.id === "MyOllama", JSON.stringify(addCall?.params?.id));
check("新增的模型字段正确提交",
  addCall?.params?.provider?.models?.[0]?.id === "qwen2.5-coder:7b" &&
  addCall?.params?.provider?.models?.[0]?.contextWindow === 32768,
  JSON.stringify(addCall?.params?.provider?.models));
check("新增后列表里出现该提供商",
  (await evalJs(`[...document.querySelectorAll('.pi-provider-row')].some(r => r.dataset.providerId === 'MyOllama')`)) === true);

/* ============ 7. 非法输入：前端拦截 + 面板报错，不发请求 ============ */
await evalJs(`[...document.querySelectorAll('.pi-provider-row')].find(r => r.dataset.providerId === 'MyOllama').click(); 1`);
await sleep(350);
const beforeBad = await evalJs(`window.__calls.filter(c => c.method === 'saveProvider').length`);
// 高级配置填非法 JSON
await evalJs(`(() => {
  const t = document.querySelector('#pi-settings-body .pi-advanced textarea');
  t.value = '{ not json';
  t.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('pi-save-provider').click();
})(); 1`);
await sleep(500);
const afterBad = await evalJs(`window.__calls.filter(c => c.method === 'saveProvider').length`);
check("高级配置 JSON 非法时**不**发出保存请求", afterBad === beforeBad, `${beforeBad} → ${afterBad}`);
check("面板内显示错误提示",
  (await evalJs(`!!document.querySelector('#pi-settings-body .pi-settings-error')`)) === true,
  await evalJs(`(document.querySelector('#pi-settings-body .pi-settings-error')?.textContent || '').slice(0, 70)`));
check("错误提示点明是高级配置的问题",
  (await evalJs(`(document.querySelector('#pi-settings-body .pi-settings-error')?.textContent || '')`)).includes("高级配置"));

// 修好后仍可保存（错误不会把表单卡死）
await evalJs(`(() => {
  const t = document.querySelector('#pi-settings-body .pi-advanced textarea');
  t.value = '{}';
  document.getElementById('pi-save-provider').click();
})(); 1`);
await sleep(600);
check("修正 JSON 后能正常保存",
  (await evalJs(`window.__calls.filter(c => c.method === 'saveProvider').length`)) === afterBad + 1);

/* ============ 8. 删除：二次确认 ============ */
await evalJs(`[...document.querySelectorAll('.pi-provider-row')].find(r => r.dataset.providerId === 'MyOllama').click(); 1`);
await sleep(350);
await evalJs(`window.__setConfirm(false); 1`);
await evalJs(`document.getElementById('pi-delete-provider').click(); 1`);
await sleep(400);
check("确认框点「取消」时不会删除",
  (await evalJs(`window.__calls.filter(c => c.method === 'deleteProvider').length`)) === 0);

await evalJs(`window.__setConfirm(true); 1`);
await evalJs(`document.getElementById('pi-delete-provider').click(); 1`);
await sleep(600);
const delCall = JSON.parse(await evalJs(`JSON.stringify(
  window.__calls.filter(c => c.method === 'deleteProvider').slice(-1)[0] || null
)`));
check("确认后发出 deleteProvider", delCall?.params?.id === "MyOllama", JSON.stringify(delCall));
check("删除后回到列表且该提供商消失",
  (await evalJs(`!!document.getElementById('pi-add-provider')`)) === true &&
  (await evalJs(`[...document.querySelectorAll('.pi-provider-row')].some(r => r.dataset.providerId === 'MyOllama')`)) === false);

/* ============ 9. 关闭设置：✕ 与 Esc ============ */
await evalJs(`document.getElementById('pi-settings-close').click(); 1`);
await sleep(300);
check("点 ✕ 关闭设置", await evalJs(`document.getElementById('pi-settings').hidden`) === true);
check("关闭后对话界面还在（输入框可用）",
  await evalJs(`!!document.getElementById('pi-input') && !document.getElementById('pi-input').disabled`) === true);

await evalJs(`document.getElementById('pi-settings-btn').click(); 1`);
await sleep(450);
check("再次打开设置仍能加载", await evalJs(`document.getElementById('pi-settings').hidden`) === false);
await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1`);
await sleep(300);
check("Esc 关闭设置", await evalJs(`document.getElementById('pi-settings').hidden`) === true);

/* ============ 10. 无 JS 报错 ============ */
check("页面无未捕获异常", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
try { ws.close(); } catch { /* ignore */ }
chrome.kill();
server.close();
await rm(userDir, { recursive: true, force: true }).catch(() => {});
process.exit(fail === 0 ? 0 : 1);
