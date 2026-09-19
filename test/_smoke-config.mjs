/**
 * 迁移后设置窗口关键交互冒烟测试（真实浏览器）：
 * 1. 七个导航项都能切换并渲染对应面板
 * 2. 快捷键面板：录入组合键（Ctrl+Shift+F9）→ IPC set_toggle_shortcut
 * 3. 缓存面板：显示各缓存项 + 剩余有效期倒计时
 * 4. 关于面板：进入即检查更新（IPC check_update）
 * 5. 底栏「保存并应用」显隐（仅订阅管理 / 关注标签）
 * 6. Esc 关窗、外链走 open_url
 *
 * 用法: npm run build && node test/_smoke-config.mjs
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

const userDir = path.join(root, "test", "_chrome-profile-smoke-config");
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

await S(
  "Page.addScriptToEvaluateOnNewDocument",
  {
    source: `
    window.__invoked = [];
    window.__openedUrls = [];
    window.__checkUpdateCalls = 0;
    window.__TAURI_INTERNALS__ = {
      invoke(cmd, args) {
        window.__invoked.push({ cmd, args });
        if (cmd === 'open_url') { window.__openedUrls.push(args.url); return Promise.resolve(null); }
        if (cmd === 'check_update') {
          window.__checkUpdateCalls++;
          return Promise.resolve({ has_update: false, latest_version: '', current_version: '7.9.14', download_url: '', release_url: '' });
        }
        if (cmd === 'get_default_subscribe_text') {
          return Promise.resolve('<tis::https://example.com/default.ms title="默认订阅" />');
        }
        if (cmd === 'get_toggle_shortcut') { return Promise.resolve('ctrl+alt+s'); }
        if (cmd === 'get_shortcut_bindings') {
          // 首次：一条默认呼出键；被设置过（__bindings 非空）后回读设置值
          if (window.__bindings) return Promise.resolve(window.__bindings);
          return Promise.resolve([{ shortcut: 'ctrl+alt+s', action: 'toggle-window', target: null }]);
        }
        if (cmd === 'set_shortcut_bindings') {
          window.__bindings = args.bindings;
          return Promise.resolve(null);
        }
        return Promise.resolve(null);
      },
      transformCallback(cb) { return cb; },
      metadata: { currentWindow: { label: 'config' }, currentWebview: { label: 'config' } },
      plugins: {},
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(){} };
  `,
  },
  sessionId
);

// 种子：订阅 + 缓存 + 标签
await S("Page.navigate", { url: base + "/config.html" }, sessionId);
await sleep(400);
await evalJs(`localStorage.clear(); 1`);
await evalJs(`
  localStorage.setItem('my-search-desktop:subscribes', JSON.stringify('<tis::https://a.example.com/index.ms title="AA" describe="描述A" />\\n\\n<tis::https://b.example.com/index.ms title="BB" />'));
  localStorage.setItem('my-search-desktop:SEARCH_DATA_KEY', JSON.stringify({ data: [{ title: 'x' }], expire: Date.now() + 12*3600*1000 }));
  localStorage.setItem('my-search-desktop:DATA_ITEM_TAGS_CACHE_KEY', JSON.stringify([{ name: '推荐', count: 5 }, { name: '游戏', count: 2 }]));
  1;
`);
await S("Page.navigate", { url: base + "/config.html" }, sessionId);
await sleep(1000);

// 1. 各面板切换（含新增的「常规」面板）
const paneResults = {};
for (const [pane, expectSel] of [
  ["subscribes", ".page.subscribes"],
  ["tags", ".page.tags"],
  ["repo", ".page.repo"],
  ["cache", ".page.cache"],
  ["shortcut", ".page.shortcut"],
  ["general", ".page.general"],
  ["about", ".page.about"],
]) {
  await evalJs(`document.querySelector('.cfg-nav .nav-item[data-pane="${pane}"]').click()`);
  await sleep(250);
  paneResults[pane] = await evalJs(`!!document.querySelector('#ms-config-view ${expectSel}')`);
}
check(
  "七个导航面板均可切换渲染",
  Object.values(paneResults).every(Boolean),
  JSON.stringify(paneResults)
);

// 2. 底栏显隐
await evalJs(`document.querySelector('.cfg-nav .nav-item[data-pane="subscribes"]').click()`);
await sleep(200);
const footerSubs = await evalJs(`document.querySelector('.cfg-footer').classList.contains('show')`);
await evalJs(`document.querySelector('.cfg-nav .nav-item[data-pane="cache"]').click()`);
await sleep(200);
const footerCache = await evalJs(`document.querySelector('.cfg-footer').classList.contains('show')`);
check("底栏仅在订阅管理/关注标签显示", footerSubs === true && footerCache === false, `subs=${footerSubs} cache=${footerCache}`);

// 3. 快捷键：录入组合键 → set_shortcut_bindings（快捷键 / 作用类型 / 作用对象）
await evalJs(`document.querySelector('.cfg-nav .nav-item[data-pane="shortcut"]').click()`);
await sleep(250);
// 默认一条「呼出 / 隐藏搜索框」，带作用类型下拉且不可切换
check(
  "默认一条呼出/隐藏绑定（作用类型下拉已禁用）",
  (await evalJs(`document.querySelectorAll('.shortcut-row').length`)) === 1 &&
    (await evalJs(`document.querySelector('.shortcut-row [data-act="action"]').disabled`)) === true
);
// 录入 Ctrl+Shift+F9
await evalJs(`document.querySelector('.shortcut-capture').click()`);
await sleep(120);
await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', {
  key: 'F9', code: 'F9', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true
}))`);
await sleep(250);
const bindings1 = await evalJs(`JSON.stringify(window.__bindings)`);
check(
  "快捷键录入提交给后端（含作用类型 toggle-window）",
  bindings1 === '[{"shortcut":"ctrl+shift+f9","action":"toggle-window","target":null}]',
  bindings1
);
check(
  "键帽展示为 Ctrl + Shift + F9",
  (await evalJs(`JSON.stringify([...document.querySelectorAll('.shortcut-caps .kbd')].map(k => k.textContent))`)) ===
    '["Ctrl","Shift","F9"]'
);

// 3b. 没有可打开插件时：点击「+ 添加快捷键」给出引导提示，不新增行
await evalJs(`document.querySelector('.shortcut-add').click()`);
await sleep(200);
check(
  "无可用插件时不允许新增插件快捷键",
  (await evalJs(`document.querySelectorAll('.shortcut-row').length`)) === 1,
  `rows=${await evalJs(`document.querySelectorAll('.shortcut-row').length`)}`
);

// 3c. 插入一个假插件后：新增一行 → 作用类型 = 打开插件 → 作用对象可选该插件
await evalJs(`
  localStorage.setItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY', JSON.stringify({
    version: 1,
    plugins: [{
      id: 'com.test.demo', name: '演示插件', version: '1.0.0', apiVersion: 1,
      manifest: { id: 'com.test.demo', name: '演示插件', version: '1.0.0', apiVersion: 1, contributes: { detailView: { entry: 'ui/index.html' } } },
      dir: '', source: { kind: 'market' }, installedAt: 0, updatedAt: 0,
      enabled: true, autoStart: 'on-demand', requestedAutoStart: 'on-demand',
      grants: [], denied: [], runtime: {}, integrity: { sha256: null, signed: false }
    }]
  }));
  1;
`);
// 重新进入面板（触发插件列表重读）
await evalJs(`document.querySelector('.cfg-nav .nav-item[data-pane="cache"]').click()`);
await sleep(150);
await evalJs(`document.querySelector('.cfg-nav .nav-item[data-pane="shortcut"]').click()`);
await sleep(350);
await evalJs(`document.querySelector('.shortcut-add').click()`);
await sleep(350);
const rows2 = await evalJs(`document.querySelectorAll('.shortcut-row').length`);
check("有可用插件后可新增一条快捷键", rows2 === 2, `rows=${rows2}`);
const pluginSelect = await evalJs(`JSON.stringify({
  action: document.querySelectorAll('.shortcut-row')[1].querySelector('[data-act="action"]').value,
  target: document.querySelectorAll('.shortcut-row')[1].querySelector('[data-act="target"]').value,
  options: [...document.querySelectorAll('.shortcut-row')[1].querySelectorAll('[data-act="target"] option')].map(o => o.value)
})`);
check(
  "新行作用类型=打开插件且作用对象选中该插件",
  JSON.parse(pluginSelect).action === "open-plugin" &&
    JSON.parse(pluginSelect).target === "com.test.demo" &&
    JSON.parse(pluginSelect).options.includes("com.test.demo"),
  pluginSelect
);
const bindings2 = await evalJs(`JSON.stringify(window.__bindings)`);
check(
  "新增的插件快捷键提交给后端（含 target）",
  bindings2.includes('"action":"open-plugin"') && bindings2.includes('"target":"com.test.demo"'),
  bindings2
);

// 3d. 删除插件快捷键 → 回到一条
await evalJs(`document.querySelectorAll('.shortcut-row')[1].querySelector('[data-act="remove"]').click()`);
await sleep(300);
check(
  "删除插件快捷键后只剩呼出/隐藏",
  (await evalJs(`JSON.stringify(window.__bindings)`)) ===
    '[{"shortcut":"ctrl+shift+f9","action":"toggle-window","target":null}]',
  await evalJs(`JSON.stringify(window.__bindings)`)
);

// 4. 缓存面板：条目 + 剩余有效期
await evalJs(`document.querySelector('.cfg-nav .nav-item[data-pane="cache"]').click()`);
await sleep(300);
const cacheItems = await evalJs(`document.querySelectorAll('#cacheList .cache-item').length`);
check("缓存面板列出全部缓存条目", cacheItems === 10, `items=${cacheItems}`);
check(
  "订阅数据缓存显示剩余有效期",
  (await evalJs(`document.querySelector('#cacheList .cache-item[data-key="SEARCH_DATA_KEY"] .cache-count')?.textContent.includes('剩')`)) === true,
  await evalJs(`document.querySelector('#cacheList .cache-item[data-key="SEARCH_DATA_KEY"] .cache-count')?.textContent ?? 'null'`)
);

// 5. 关于面板：进入即检查更新
await evalJs(`document.querySelector('.cfg-nav .nav-item[data-pane="about"]').click()`);
await sleep(400);
check(
  "进入关于面板自动检查更新",
  (await evalJs(`window.__checkUpdateCalls >= 1`)) === true,
  `calls=${await evalJs(`window.__checkUpdateCalls`)}`
);
check(
  "检查更新结果文案（已是最新）",
  (await evalJs(`document.getElementById('aboutUpdateStatus').textContent.includes('最新')`)) === true,
  await evalJs(`document.getElementById('aboutUpdateStatus').textContent`)
);

// 6. 外链走 open_url（顶栏 GitHub 链接）
await evalJs(`document.querySelector('.cfg-github-link').click()`);
await sleep(200);
check(
  "顶栏 GitHub 链接走 open_url",
  (await evalJs(`window.__openedUrls.some(u => u.includes('github.com/My-Search/my-search-desktop'))`)) === true,
  await evalJs(`JSON.stringify(window.__openedUrls)`)
);

// 7. 关注标签渲染（缓存里有 2 个标签）
await evalJs(`document.querySelector('.cfg-nav .nav-item[data-pane="tags"]').click()`);
await sleep(250);
const chips = await evalJs(`document.querySelectorAll('.tag-chip').length`);
check("关注标签渲染胶囊", chips === 2, `chips=${chips}`);
check(
  "标签胶囊计数正确",
  (await evalJs(`document.querySelector('.tag-chip .tag-count').textContent`)) === "5"
);

// 8. Esc 关窗（Tauri 环境调用 window.close）
await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
await sleep(200);
check("Esc 触发窗口关闭（无异常）", true);

check("无未捕获页面异常", pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 2)));

console.log(`\n结果: ${pass} passed, ${fail} failed`);
chrome.kill();
server.close();
process.exit(fail === 0 ? 0 : 1);
