/**
 * 目录挂载插件「自动热重载」的真实浏览器端到端测试。
 *
 * 用与 test/plugin-ui.test.mjs 相同的做法：CDP 驱动 headless Chrome，
 * 用注入的 `__TAURI_INTERNALS__` 模拟宿主 IPC（无 Rust 侧），再用
 * `__emitTauriEvent` 手动触发 Rust 侧本会广播的 `plugin://dev-changed`，
 * 验证完整链路：
 *
 *   1. 主窗口：目录挂载的插件能被 `plugin_watch_dir` 登记（前端发起了登记）；
 *   2. 主窗口：打开插件视图 → 改源目录文件 + 发事件 → 注册表版本更新、
 *      视图**自动重挂并读到新文件内容**（不需要用户点任何东西）；
 *   3. 用户态不被覆盖：用户关掉的插件不会因为热重载被打开；
 *   4. 清单半截 JSON（保存中间态）→ 记录保持不变；
 *   5. 后台进程：进程没在跑就不重启；在跑且改了 backend/ 才重启。
 *
 * 用法: npm run build && node test/plugin-dev-reload-ui.test.mjs
 */
import { createServer } from "http";
import { readFile } from "fs/promises";
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
};
const server = createServer(async (req, res) => {
  try {
    const u = decodeURIComponent(req.url.split("?")[0]);
    const file = path.join(dist, u === "/" ? "/index.html" : u);
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

const userDir = path.join(root, "test", "_chrome-profile-dev-reload");
const { rm } = await import("fs/promises");
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
    pageErrors.push(
      msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text
    );
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

/* ---------------- 注入 IPC 模拟（无 Rust 侧） ---------------- */
await S(
  "Page.addScriptToEvaluateOnNewDocument",
  {
    source: `
    window.__invoked = [];
    // 虚拟文件系统（模拟「源目录」）：<pluginId>/<相对路径> → 文本。
    // **落在 localStorage**：页面会多次 reload，只挂在 window 上的 mock 会丢。
    const readFs = () => JSON.parse(localStorage.getItem('__dev_fs') || '{}');
    window.__fs = new Proxy({}, {
      get: (_, k) => readFs()[k],
      set: (_, k, v) => { const fs = readFs(); fs[k] = v; localStorage.setItem('__dev_fs', JSON.stringify(fs)); return true; },
    });
    window.__TAURI_INTERNALS__ = {
      invoke(cmd, args) {
        window.__invoked.push({ cmd, args });
        if (cmd === 'plugin_read_text') {
          const v = readFs()[args.pluginId + '/' + args.relPath];
          if (v == null) return Promise.reject('文件不存在: ' + args.relPath);
          return Promise.resolve(v);
        }
        if (cmd === 'plugin_read_binary') return Promise.resolve('');
        if (cmd === 'plugin_watch_dir') {
          window.__watchCalls = window.__watchCalls || [];
          window.__watchCalls.push({ pluginId: args.pluginId, dir: args.dir, enable: args.enable });
          return Promise.resolve(null);
        }
        if (cmd === 'plugin_gateway_sync') return Promise.resolve(null);
        if (cmd === 'plugin_backend_list') {
          const status = JSON.parse(localStorage.getItem('__backend_status') || '{}');
          return Promise.resolve(
            Object.entries(status).map(([pluginId, st]) => ({
              pluginId, status: st, pid: 1234, memoryBytes: null, startedAt: Date.now(),
              restarts: 0, lastError: null, keepAliveReasons: [],
            }))
          );
        }
        if (cmd === 'plugin_backend_restart') {
          const list = JSON.parse(localStorage.getItem('__restarted') || '[]');
          list.push(args.pluginId);
          localStorage.setItem('__restarted', JSON.stringify(list));
          return Promise.resolve({ pluginId: args.pluginId, status: 'running', pid: 4321, memoryBytes: null, startedAt: Date.now(), restarts: 1, lastError: null, keepAliveReasons: [] });
        }
        if (cmd === 'get_default_subscribe_text') return Promise.resolve('');
        if (cmd === 'get_toggle_shortcut') return Promise.resolve('ctrl+alt+s');
        if (cmd === 'get_shortcut_bindings') {
          return Promise.resolve([{ shortcut: 'ctrl+alt+s', action: 'toggle-window', target: null }]);
        }
        if (cmd === 'get_autostart_enabled') return Promise.resolve(false);
        if (cmd === 'plugin:event|listen' && args && args.event) {
          const list = window.__eventHandlers.get(args.event) || [];
          list.push(args.handler);
          window.__eventHandlers.set(args.event, list);
          return Promise.resolve(window.__eventNextId++);
        }
        return Promise.resolve(null);
      },
      transformCallback(cb) {
        const cbId = Math.random().toString(36).slice(2);
        window.__cbIds = window.__cbIds || {};
        window.__cbIds[cbId] = cb;
        return cbId;
      },
      unregisterCallback(cbId) { delete (window.__cbIds || {})[cbId]; },
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      plugins: {},
    };
    window.__eventHandlers = new Map();
    window.__eventNextId = 1;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(){} };
    window.__emitTauriEvent = (event, payload) => {
      const list = window.__eventHandlers.get(event) || [];
      list.forEach((idOrFn) => {
        const cb = typeof idOrFn === 'function' ? idOrFn : (window.__cbIds || {})[idOrFn];
        if (typeof cb === 'function') cb({ event, id: window.__eventNextId++, payload });
      });
      return list.length;
    };
  `,
  },
  sessionId
);

/* ---------------- 种子：一条「目录挂载」的插件记录 ---------------- */
const seedRecord = (over = {}) => ({
  id: "com.example.hotreload",
  name: "热重载测试插件",
  version: "1.0.0",
  apiVersion: 1,
  manifest: {
    id: "com.example.hotreload",
    name: "热重载测试插件",
    version: "1.0.0",
    apiVersion: 1,
    permissions: ["ui.inlay"],
    contributes: {
      searchItem: { title: "[推荐][脚本]热重载测试", desc: "热重载", keyword: "热重载", visible: true },
      detailView: { entry: "ui/view.html", script: "ui/view.js", mode: "inlay" },
    },
  },
  dir: "D:/code/demo/plugins/hotreload",
  source: { kind: "folder", ref: "D:/code/demo/plugins/hotreload", dev: true },
  installedAt: 1000,
  updatedAt: 1000,
  enabled: true,
  autoStart: "on-demand",
  requestedAutoStart: "on-demand",
  closeBehavior: "minimize",
  grants: [{ permission: "ui.inlay", at: 1000, source: "install" }],
  denied: [],
  runtime: { status: "stopped", pid: null, memoryBytes: null, startedAt: null, restarts: 0, lastError: null, keepAliveReasons: [] },
  integrity: { sha256: null, signed: false },
  ...over,
});

await S("Page.navigate", { url: base + "/index.html" }, sessionId);
await sleep(900);
await evalJs(`
  localStorage.clear();
  localStorage.setItem('__dev_fs', JSON.stringify({
    "com.example.hotreload/plugin.json": ${JSON.stringify(JSON.stringify(seedRecord().manifest))},
    "com.example.hotreload/ui/view.html": "<!DOCTYPE html><html><body><div id='tag'>版本 1</div></body></html>",
    "com.example.hotreload/ui/view.js": "window.__mounts = (window.__mounts || 0) + 1;"
  }));
  localStorage.setItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY', ${JSON.stringify(
    JSON.stringify({ version: 1, plugins: [seedRecord()] })
  )});
  localStorage.setItem('__backend_status', '{}');
  localStorage.setItem('__restarted', '[]');
  1
`);
await S("Page.reload", {}, sessionId);
await sleep(1200);

/* ================= 1. 启动时登记监听 + 插件项可用 ================= */
{
  const watchCalls = await evalJs(`JSON.stringify(window.__watchCalls || [])`);
  const calls = JSON.parse(watchCalls);
  check(
    "启动时对目录挂载插件登记了源目录监听",
    calls.some(
      (c) => c.pluginId === "com.example.hotreload" && c.dir === "D:/code/demo/plugins/hotreload" && c.enable === true
    ),
    watchCalls
  );
  check(
    "主窗口监听了 plugin://dev-changed 事件",
    (await evalJs(`(window.__eventHandlers.get('plugin://dev-changed') || []).length`)) >= 1
  );
}

/* ================= 2. 打开插件视图 ================= */
{
  await evalJs(`
    (() => {
      const el = document.getElementById('my_search_input');
      el.focus();
      el.value = '热重载';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })();
    1
  `);
  await sleep(700);
  // 点主链接（与真实用户点击一致：ResultItem 只在 a[data-open] 上触发展开）
  await evalJs(`
    const link = document.querySelector('#matchItems .resultItem a[data-open]');
    if (link) link.click();
    1
  `);
  await sleep(1000);
  const mounted = await evalJs(
    `document.querySelector('#text_show .plugin-view')?.textContent ?? null`
  );
  check("插件视图已挂载并渲染出源目录里的内容", mounted !== null && mounted.includes("版本 1"), String(mounted));
  check(
    "入口脚本被执行（挂载计数 = 1）",
    (await evalJs(`window.__mounts || 0`)) === 1,
    String(await evalJs(`window.__mounts || 0`))
  );
}

/* ================= 3. 改源文件 + 广播事件 → 全自动重挂 ================= */
{
  // 模拟用户在源目录里改了三处：清单版本、HTML 内容、JS
  await evalJs(`
    window.__fs['com.example.hotreload/plugin.json'] = JSON.stringify(
      Object.assign(JSON.parse(window.__fs['com.example.hotreload/plugin.json']), {
        version: '2.0.0',
        description: '第二版',
      })
    );
    window.__fs['com.example.hotreload/ui/view.html'] = "<!DOCTYPE html><html><body><div id='tag'>版本 2</div></body></html>";
    window.__fs['com.example.hotreload/ui/view.js'] = "window.__mounts = (window.__mounts || 0) + 1; window.__second = true;";
    1
  `);
  const delivered = await evalJs(`
    window.__emitTauriEvent('plugin://dev-changed', {
      pluginId: 'com.example.hotreload',
      dir: 'D:/code/demo/plugins/hotreload',
      paths: ['plugin.json', 'ui/view.html', 'ui/view.js'],
      frontendOnly: false,
      at: Date.now(),
    })
  `);
  check("事件被投递给监听者", delivered >= 1, `listeners=${delivered}`);
  await sleep(1200);

  const after = JSON.parse(
    await evalJs(`localStorage.getItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY')`)
  );
  const rec = after.plugins.find((p) => p.id === "com.example.hotreload");
  check("注册表版本已随源目录清单更新", rec?.version === "2.0.0", String(rec?.version));
  check("描述也跟着更新", rec?.description === "第二版", String(rec?.description));
  check("用户态（启用态）未被覆盖", rec?.enabled === true, String(rec?.enabled));
  check("授权未被清空", (rec?.grants || []).length === 1, JSON.stringify(rec?.grants));

  const mountedText = await evalJs(
    `document.querySelector('#text_show .plugin-view')?.textContent ?? null`
  );
  check("已打开的插件界面自动重挂并显示新内容", mountedText !== null && mountedText.includes("版本 2"), String(mountedText));
  check(
    "入口脚本被重新执行（挂载计数 = 2）",
    (await evalJs(`window.__mounts || 0`)) === 2,
    String(await evalJs(`window.__mounts || 0`))
  );
  check(
    "新脚本的副作用可见（说明确实跑的是新代码）",
    (await evalJs(`!!window.__second`)) === true,
    "window.__second"
  );
}

/* ================= 4. 半截 JSON（保存中间态）不改坏记录 ================= */
{
  await evalJs(`
    window.__fs['com.example.hotreload/plugin.json'] = '{"id":"com.example.hotreload","name":"半截';
    1
  `);
  await evalJs(`
    window.__emitTauriEvent('plugin://dev-changed', {
      pluginId: 'com.example.hotreload',
      dir: 'D:/code/demo/plugins/hotreload',
      paths: ['plugin.json'],
      frontendOnly: false,
      at: Date.now(),
    })
  `);
  await sleep(900);
  const after = JSON.parse(
    await evalJs(`localStorage.getItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY')`)
  );
  const rec = after.plugins.find((p) => p.id === "com.example.hotreload");
  check("半截 JSON 不覆盖记录（版本仍是 2.0.0）", rec?.version === "2.0.0", String(rec?.version));
  const mountedText = await evalJs(
    `document.querySelector('#text_show .plugin-view')?.textContent ?? null`
  );
  check("半截 JSON 不破坏界面（仍是版本 2）", mountedText !== null && mountedText.includes("版本 2"), String(mountedText));
}

/* ================= 5. 后台进程策略：没在跑就不重启 ================= */
{
  await evalJs(`
    const recs = JSON.parse(localStorage.getItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY'));
    const r = recs.plugins.find(p => p.id === 'com.example.hotreload');
    r.manifest.backend = { entry: 'backend/run.cmd', protocol: 'jsonrpc-stdio', autostart: 'on-demand', closeBehavior: 'minimize' };
    // 清单校验要求：声明 backend 就必须同时申请 backend.spawn 权限
    if (!r.manifest.permissions.includes('backend.spawn')) r.manifest.permissions.push('backend.spawn');
    if (!r.grants.some(g => g.permission === 'backend.spawn')) {
      r.grants.push({ permission: 'backend.spawn', at: 1000, source: 'install' });
    }
    // 清单原文也要带上 backend（热重载是「以源目录清单为准」）
    window.__fs['com.example.hotreload/plugin.json'] = JSON.stringify(r.manifest);
    localStorage.setItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY', JSON.stringify(recs));
    localStorage.setItem('__backend_status', JSON.stringify({ 'com.example.hotreload': 'stopped' }));
    localStorage.setItem('__restarted', '[]');
    1
  `);
  await S("Page.reload", {}, sessionId);
  await sleep(1200);
  await evalJs(`
    window.__emitTauriEvent('plugin://dev-changed', {
      pluginId: 'com.example.hotreload',
      dir: 'D:/code/demo/plugins/hotreload',
      paths: ['backend/run.cmd'],
      frontendOnly: false,
      at: Date.now(),
    })
  `);
  await sleep(1000);
  const restarted = await evalJs(`localStorage.getItem('__restarted')`);
  check("进程没在运行时不重启（不凭空拉进程）", restarted === "[]", String(restarted));
}

/* ================= 6. 后台进程策略：在跑 + 改了后端才重启 ================= */
{
  // (a) 在跑 + 纯前端变化 → 不重启
  await evalJs(`
    localStorage.setItem('__backend_status', JSON.stringify({ 'com.example.hotreload': 'running' }));
    localStorage.setItem('__restarted', '[]');
    1
  `);
  await evalJs(`
    window.__emitTauriEvent('plugin://dev-changed', {
      pluginId: 'com.example.hotreload',
      dir: 'D:/code/demo/plugins/hotreload',
      paths: ['ui/view.js', 'ui/view.html'],
      frontendOnly: true,
      at: Date.now(),
    })
  `);
  await sleep(1000);
  check(
    "进程运行中但只改了前端 → 不重启",
    (await evalJs(`localStorage.getItem('__restarted')`)) === "[]",
    String(await evalJs(`localStorage.getItem('__restarted')`))
  );

  // (b) 在跑 + 改了后端 → 重启
  await evalJs(`
    localStorage.setItem('__restarted', '[]');
    window.__emitTauriEvent('plugin://dev-changed', {
      pluginId: 'com.example.hotreload',
      dir: 'D:/code/demo/plugins/hotreload',
      paths: ['backend/run.cmd'],
      frontendOnly: false,
      at: Date.now(),
    })
  `);
  await sleep(1400);
  const restarted = JSON.parse(await evalJs(`localStorage.getItem('__restarted') || '[]'`));
  check("进程运行中且改了后端 → 自动重启", restarted.includes("com.example.hotreload"), JSON.stringify(restarted));
}

/* ================= 7. 禁用插件不受热重载影响 ================= */
{
  await evalJs(`
    const recs = JSON.parse(localStorage.getItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY'));
    const r = recs.plugins.find(p => p.id === 'com.example.hotreload');
    r.enabled = false;
    localStorage.setItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY', JSON.stringify(recs));
    const m = JSON.parse(window.__fs['com.example.hotreload/plugin.json']);
    m.version = '3.0.0';
    window.__fs['com.example.hotreload/plugin.json'] = JSON.stringify(m);
    1
  `);
  await S("Page.reload", {}, sessionId);
  await sleep(1200);
  await evalJs(`
    window.__emitTauriEvent('plugin://dev-changed', {
      pluginId: 'com.example.hotreload',
      dir: 'D:/code/demo/plugins/hotreload',
      paths: ['plugin.json'],
      frontendOnly: false,
      at: Date.now(),
    })
  `);
  await sleep(1000);
  const after = JSON.parse(
    await evalJs(`localStorage.getItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY')`)
  );
  const rec = after.plugins.find((p) => p.id === "com.example.hotreload");
  check("禁用插件仍会更新清单（保持记录最新）", rec?.version === "3.0.0", String(rec?.version));
  check("但不会被热重载悄悄启用", rec?.enabled === false, String(rec?.enabled));
}

/* ================= 8. 没有页面错误 ================= */
{
  const real = pageErrors.filter((e) => !/favicon|ERR_/i.test(String(e)));
  check("页面无未捕获异常", real.length === 0, real.slice(0, 2).join(" | "));
}

console.log(`\n结果: ${pass} passed, ${fail} failed`);
ws.close();
chrome.kill();
server.close();
process.exit(fail === 0 ? 0 : 1);
