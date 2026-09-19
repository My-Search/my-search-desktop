/**
 * 插件「关闭界面时 = 最小化」时前端保活的端到端测试（真实浏览器 + 模拟 IPC，无 Tauri）。
 *
 * 用户诉求：插件窗口可以「关闭即最小化」——关闭插件界面后**不要重新加载前端**，
 * 再次打开时状态（输入草稿、滚动位置、脚本内存态）必须还在。
 *
 * 要钉死的契约：
 *   1. `minimize` 插件：Esc 关闭 → 再次打开 → **入口脚本没有被重新执行**
 *      （挂载计数仍是 1）、输入草稿与滚动位置保留、DOM 是同一棵树（不是重建的）；
 *   2. `exit` 插件：Esc 关闭 → 会话被卸载（DOM 移出文档）→ 再次打开**重新执行**
 *      脚本（挂载计数 +1）；
 *   3. 关闭后的会话停靠在隐藏停车场（`#ms-plugin-parking`）里，不再显示；
 *   4. 打开另一个插件时，前一个 minimize 插件仍保活（不丢状态），
 *      切回来还是恢复；
 *   5. 插件被禁用/卸载（注册表变化 + 窗口重新获得焦点）→ 保活会话被清理，
 *      不会「复活」已卸载的插件界面；
 *   6. 开发热重载：保活中的会话也会被重挂（跑的是新代码，不是旧代码）；
 *   7. 后台进程联动不受影响：minimize 不停、exit 停（与 plugin-close-behavior 测试互补）。
 *
 * 用法: npm run build && node test/plugin-keepalive-ui.test.mjs
 */
import { createServer } from "http";
import { readFile, rm } from "fs/promises";
import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
if (!existsSync(path.join(dist, "index.html"))) {
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

const userDir = path.join(root, "test", "_chrome-profile-plugin-keepalive");
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

/* ---------------- 插件夹具 ---------------- */
const now = Date.now();

/**
 * 插件界面（故意做成「有状态」的）：
 *   - 一个可滚动的长列表（验证滚动位置保留）；
 *   - 一个输入框（验证草稿保留）；
 *   - 入口脚本每次执行都会给 window.__mounts[pluginId] 加一（验证是否重跑）；
 *   - 入口脚本把 DOM 节点引用挂到 window 上（验证恢复的是同一棵树，不是重建的）。
 */
const VIEW_HTML = `<!DOCTYPE html><html><body>
  <div id="ka-root" style="height:200px;overflow:auto">
    <input id="ka-input" placeholder="草稿">
    <div style="height:1200px" id="ka-filler">长内容</div>
  </div>
</body></html>`;
const VIEW_JS = `
  const id = plugin.id;
  window.__mounts = window.__mounts || {};
  window.__mounts[id] = (window.__mounts[id] || 0) + 1;
  window.__nodes = window.__nodes || {};
  window.__nodes[id] = document.getElementById('ka-root');
  window.__scripts = window.__scripts || {};
  window.__scripts[id] = (window.__scripts[id] || 0) + 1;
  window.__heard = window.__heard || {};
  if (typeof onSubKeyword === 'function') {
    onSubKeyword(function (msg) { window.__heard[id] = msg; });
  }
`;

const mkManifest = (id, name, closeBehavior) => ({
  id,
  name,
  version: "1.0.0",
  apiVersion: 1,
  description: `closeBehavior=${closeBehavior}`,
  permissions: ["ui.inlay"],
  contributes: {
    searchItem: { title: name, desc: `关键词 ${name}`, keyword: name, visible: true },
    detailView: { entry: "ui/view.html", script: "ui/view.js", mode: "inlay", closeBehavior },
  },
});

/** 纯前端插件：用 detailView.closeBehavior 声明「退出」（没有 backend 也能声明） */
const NO_BACKEND_EXIT = {
  id: "com.example.front-exit",
  name: "纯前端退出",
  version: "1.0.0",
  apiVersion: 1,
  permissions: ["ui.inlay"],
  contributes: {
    searchItem: { title: "纯前端退出", desc: "无后台进程", keyword: "纯前端退出", visible: true },
    detailView: { entry: "ui/view.html", script: "ui/view.js", mode: "inlay", closeBehavior: "exit" },
  },
};

const PLUGINS = [
  mkManifest("com.example.keep", "保活插件", "minimize"),
  mkManifest("com.example.drop", "卸载插件", "exit"),
  mkManifest("com.example.other", "另一个保活", "minimize"),
  NO_BACKEND_EXIT,
];

const mkRecord = (mf) => ({
  id: mf.id,
  name: mf.name,
  version: mf.version,
  apiVersion: mf.apiVersion,
  description: mf.description,
  manifest: mf,
  dir: `plugins/${mf.id}`,
  source: { kind: "file", ref: "x.msplugin" },
  installedAt: now,
  updatedAt: now,
  enabled: true,
  autoStart: "on-demand",
  requestedAutoStart: "on-demand",
  closeBehavior: mf.contributes.detailView.closeBehavior ?? "minimize",
  grants: [{ permission: "ui.inlay", at: now, source: "install" }],
  denied: [],
  runtime: { status: "stopped", pid: null, memoryBytes: null, startedAt: null, restarts: 0, lastError: null, keepAliveReasons: [] },
  integrity: { sha256: null, signed: false },
});
const RECORDS = PLUGINS.map(mkRecord);

const PLUGIN_FILES = Object.fromEntries(
  PLUGINS.map((p) => [p.id, { "ui/view.html": VIEW_HTML, "ui/view.js": VIEW_JS }])
);

/* ---------------- 注入 IPC 模拟 ---------------- */
await S(
  "Page.addScriptToEvaluateOnNewDocument",
  {
    source: `
    window.__calls = [];
    window.__files = ${JSON.stringify(PLUGIN_FILES)};
    window.__TAURI_INTERNALS__ = {
      invoke(cmd, args) {
        window.__calls.push({ cmd, args });
        if (cmd === 'set_window_height') {
          // 记录每次下发的窗口高度 + 当时的盒子实测高度：
          // 两者不一致（盒子更高）就意味着**下边框会被窗口裁掉**（回归断言用）
          const box = document.getElementById('my_search_box');
          window.__heights = window.__heights || [];
          window.__heights.push({
            req: args && args.height,
            box: box ? +box.getBoundingClientRect().height.toFixed(1) : null,
          });
          return Promise.resolve(null);
        }
        if (cmd === 'plugin_read_text') {
          const files = window.__files[args.pluginId] || {};
          const text = files[args.relPath];
          return text == null ? Promise.reject('文件不存在: ' + args.relPath) : Promise.resolve(text);
        }
        if (cmd === 'plugin_read_binary') return Promise.reject('无图标');
        if (cmd === 'plugin_backend_list') return Promise.resolve([]);
        if (cmd === 'get_default_subscribe_text') return Promise.resolve('');
        if (cmd === 'get_toggle_shortcut') return Promise.resolve('ctrl+alt+s');
        if (cmd === 'get_autostart_enabled') return Promise.resolve(false);
        if (cmd === 'plugin:event|listen' && args && args.event) {
          const list = window.__eventHandlers.get(args.event) || [];
          list.push(args.handler);
          window.__eventHandlers.set(args.event, list);
          return Promise.resolve(window.__eventNextId++);
        }
        return Promise.resolve(null);
      },
      transformCallback(cb, once) {
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
        if (typeof cb === 'function') { try { cb({ event, id: window.__eventNextId++, payload }); } catch (e) {} }
      });
      return list.length;
    };
  `,
  },
  sessionId
);

/* ---------------- 操作封装 ---------------- */

/** 搜索并打开某插件的界面（与用户真实路径一致：输入关键词 → 回车） */
async function openPlugin(keyword) {
  await evalJs(`
    (() => {
      const el = document.getElementById('my_search_input');
      el.focus();
      el.value = ${JSON.stringify(keyword)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })();
    1
  `);
  await sleep(700);
  await evalJs(`
    (() => {
      const el = document.getElementById('my_search_input');
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    })();
    1
  `);
  await sleep(900);
  return await evalJs(`!!document.querySelector('#text_show .plugin-view #ka-root')`);
}

/** Esc 关闭界面 */
async function closeByEsc() {
  await evalJs(`
    (() => {
      const el = document.getElementById('my_search_input');
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    })();
    1
  `);
  await sleep(500);
}

/** 当前视图里插件容器的 DOM 状态（挂载计数 / 是否同一棵树 / 草稿 / 滚动） */
const probe = async (pluginId) =>
  JSON.parse(
    await evalJs(`JSON.stringify((() => {
      const host = document.querySelector('#text_show .plugin-view');
      const live = host ? host.querySelector('.ms-plugin-session') : null;
      const root = live ? live.querySelector('#ka-root') : null;
      const park = document.getElementById('ms-plugin-parking');
      const parked = park ? [...park.querySelectorAll('.ms-plugin-session')].map(el => el.getAttribute('data-ms-plugin-session')) : [];
      const parkedRoot = park ? park.querySelector('.ms-plugin-session[data-ms-plugin-session=' + JSON.stringify(${JSON.stringify(pluginId)}) + '] #ka-root') : null;
      const target = root || parkedRoot;
      return {
        mounts: (window.__mounts || {})[${JSON.stringify(pluginId)}] || 0,
        sameTree: !!(target && window.__nodes && window.__nodes[${JSON.stringify(pluginId)}] === target),
        draft: target ? (target.querySelector('#ka-input') || {}).value : null,
        scrollTop: target ? target.scrollTop : null,
        parked,
        hasLiveView: !!root,
        // 前台上是哪个插件（null = 没有插件在前台）
        liveSession: live ? live.getAttribute('data-ms-plugin-session') : null,
      };
    })())`)
  );

/* ---------------- 准备：写入注册表并进入搜索窗 ---------------- */
await S("Page.navigate", { url: base + "/index.html" }, sessionId);
await sleep(600);
await evalJs(`
  (() => {
    localStorage.clear();
    localStorage.setItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY', JSON.stringify({
      version: 1,
      plugins: ${JSON.stringify(RECORDS)},
    }));
    localStorage.setItem('my-search-desktop:SEARCH_DATA_KEY', JSON.stringify({ data: [], expire: Date.now() + 3600 * 1000 }));
    return 1;
  })()
`);
await S("Page.navigate", { url: base + "/index.html" }, sessionId);
await sleep(1400);
check("搜索窗已加载插件注册表", (await evalJs(`!!window.__TAURI_INTERNALS__`)) === true);

/* ================= 1. minimize：关闭后保活，再次打开是「恢复」 ================= */
{
  const opened = await openPlugin("保活插件");
  check("minimize 插件界面成功打开", opened === true);

  // 造状态：输入草稿 + 滚动
  await evalJs(`
    (() => {
      const root = document.querySelector('#text_show .plugin-view #ka-root');
      root.querySelector('#ka-input').value = '未发送的草稿';
      root.scrollTop = 300;
      return 1;
    })()
  `);
  await sleep(200);
  const before = await probe("com.example.keep");
  check("挂载脚本执行一次", before.mounts === 1, JSON.stringify(before));
  check("草稿与滚动已就位", before.draft === "未发送的草稿" && before.scrollTop === 300, JSON.stringify(before));

  await closeByEsc();
  // Esc 后：视图容器清空（不再显示），会话被搬到停车场
  const parked = await probe("com.example.keep");
  check("关闭后详情视图里不再有插件 DOM", parked.hasLiveView === false, JSON.stringify(parked));
  check(
    "关闭后会话停靠在隐藏停车场（没被销毁）",
    parked.parked.includes("com.example.keep") && parked.sameTree === true,
    JSON.stringify(parked.parked)
  );

  // 再次打开：应恢复
  const reopened = await openPlugin("保活插件");
  check("再次打开成功", reopened === true);
  // 恢复是静默的：不该弹「已恢复上次界面」之类的提示（用户明确要求）
  const toastAfterRestore = JSON.parse(
    await evalJs(`JSON.stringify((() => {
      const el = document.getElementById('cfgToast');
      return { text: el ? (el.textContent || '').trim() : '', shown: !!el && el.classList.contains('show') };
    })())`)
  );
  check(
    "再次打开插件不弹任何提示（恢复是静默的）",
    toastAfterRestore.shown === false || !toastAfterRestore.text.includes("恢复"),
    JSON.stringify(toastAfterRestore)
  );
  const after = await probe("com.example.keep");
  check("恢复路径没有重新执行入口脚本（挂载计数仍为 1）", after.mounts === 1, `mounts=${after.mounts}`);
  check("恢复的是同一棵 DOM 树（不是重建的）", after.sameTree === true, JSON.stringify(after));
  check("输入草稿保留", after.draft === "未发送的草稿", JSON.stringify(after.draft));
  check("滚动位置保留", after.scrollTop === 300, String(after.scrollTop));
}

/* ================= 1b. 恢复时「父 : 子」子关键词照常转发 ================= */
{
  // 用「保活插件 : 你好」打开：恢复路径也要把「你好」交给插件
  await evalJs(`
    (() => {
      const el = document.getElementById('my_search_input');
      el.focus();
      el.value = '保活插件 : 你好';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })();
    1
  `);
  await sleep(600);
  await evalJs(`
    (() => {
      const el = document.getElementById('my_search_input');
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    })();
    1
  `);
  await sleep(800);
  const heard = await evalJs(`JSON.stringify(window.__heard || null)`);
  check("恢复路径把「父 : 子」的子关键词转发给插件", heard === JSON.stringify({ "com.example.keep": "你好" }) || heard?.includes("你好"), String(heard));
  await closeByEsc();
}

/* ================= 2. exit：关闭即卸载，再次打开重新执行 ================= */
{
  const opened = await openPlugin("卸载插件");
  check("exit 插件界面成功打开", opened === true);
  const first = await probe("com.example.drop");
  check("exit 插件脚本执行一次", first.mounts === 1, JSON.stringify(first));

  await closeByEsc();
  const gone = await probe("com.example.drop");
  check(
    "exit 插件关闭后不留会话（DOM 与停车场都没有）",
    gone.hasLiveView === false && gone.sameTree === false && !gone.parked.includes("com.example.drop"),
    JSON.stringify(gone)
  );

  const reopened = await openPlugin("卸载插件");
  check("exit 插件再次打开成功", reopened === true);
  const second = await probe("com.example.drop");
  check("exit 插件再次打开重新执行脚本（挂载计数 +1）", second.mounts === 2, `mounts=${second.mounts}`);
}

/* ================= 3. 多插件：打开另一个时前一个仍保活，切回来还是原状态 ================= */
{
  const opened = await openPlugin("保活插件");
  check("（多插件）先打开保活插件", opened === true);
  await evalJs(`
    (() => {
      const root = document.querySelector('#text_show .plugin-view #ka-root');
      root.querySelector('#ka-input').value = '多插件草稿';
      root.scrollTop = 120;
      return 1;
    })()
  `);
  await sleep(200);

  // 直接切到另一个插件（真实路径：输入另一个关键词 → 回车）
  const openedOther = await openPlugin("另一个保活");
  check("切换到另一个插件成功", openedOther === true);
  const keepParked = await probe("com.example.keep");
  check(
    "被顶掉的 minimize 插件仍保活在停车场",
    keepParked.parked.includes("com.example.keep") && keepParked.mounts === 1,
    JSON.stringify(keepParked.parked)
  );
  const other = await probe("com.example.other");
  check("新插件是独立会话（自己执行了一次脚本）", other.mounts === 1, JSON.stringify(other));

  // 切回来：恢复，草稿与滚动还在
  await openPlugin("保活插件");
  const back = await probe("com.example.keep");
  check("切回来仍是恢复（挂载计数不变）", back.mounts === 1, `mounts=${back.mounts}`);
  check("切回来草稿与滚动都还在", back.draft === "多插件草稿" && back.scrollTop === 120, JSON.stringify(back));
  check(
    "另一个插件仍在保活（两个会话并存）",
    (await probe("com.example.other")).parked.includes("com.example.other")
  );
}

/* ================= 4. 纯前端插件用清单声明 exit 也生效 ================= */
{
  const opened = await openPlugin("纯前端退出");
  check("纯前端 exit 插件界面打开", opened === true);
  const first = await probe("com.example.front-exit");
  check("纯前端插件脚本执行一次", first.mounts === 1, JSON.stringify(first));
  await closeByEsc();
  const gone = await probe("com.example.front-exit");
  check(
    "纯前端 exit 插件关闭后不留会话",
    !gone.parked.includes("com.example.front-exit") && gone.sameTree === false,
    JSON.stringify(gone)
  );
  await openPlugin("纯前端退出");
  check(
    "纯前端 exit 插件再次打开重新执行脚本",
    (await probe("com.example.front-exit")).mounts === 2
  );
}

/* ================= 5. 插件被禁用 → 保活会话被清理，不再「复活」 ================= */
{
  // 先确保「另一个保活」处于保活状态（前面切走后它就在停车场里）
  const before = await probe("com.example.other");
  check("（前置）另一个插件处于保活状态", before.parked.includes("com.example.other"), JSON.stringify(before.parked));

  // 设置窗口禁用该插件（等价于用户在面板里关掉开关：注册表变化）
  await evalJs(`
    (() => {
      const raw = JSON.parse(localStorage.getItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY'));
      raw.plugins.find(p => p.id === 'com.example.other').enabled = false;
      localStorage.setItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY', JSON.stringify(raw));
      return 1;
    })()
  `);
  // 窗口重新获得焦点 → 搜索窗对齐注册表并清理失效会话
  await evalJs(`window.dispatchEvent(new Event('focus')); 1`);
  await sleep(700);
  const after = await probe("com.example.other");
  check(
    "被禁用的插件：保活会话已清理（DOM 不在停车场里）",
    !after.parked.includes("com.example.other") && after.sameTree === false,
    JSON.stringify(after.parked)
  );
  // 尝试用快捷键打开已禁用的插件：应提示而不是恢复界面
  await evalJs(`window.__emitTauriEvent('my-search://shortcut-open-plugin', { pluginId: 'com.example.other' })`);
  await sleep(700);
  const live = await probe("com.example.other");
  check(
    "已禁用插件不会被恢复出界面（前台/停车场都没有它的会话）",
    live.liveSession !== "com.example.other" && !live.parked.includes("com.example.other"),
    JSON.stringify({ liveSession: live.liveSession, parked: live.parked })
  );
}

/* ================= 5b. 前台插件被禁用 → 详情视图收掉，不留空白容器 ================= */
{
  const opened = await openPlugin("保活插件");
  check("（前置）前台打开一个插件", opened === true);
  check(
    "（前置）详情视图正在显示",
    (await evalJs(`document.getElementById('text_show').style.display`)) === "block"
  );
  // 用户去设置窗口把这个插件禁掉
  await evalJs(`
    (() => {
      const raw = JSON.parse(localStorage.getItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY'));
      raw.plugins.find(p => p.id === 'com.example.keep').enabled = false;
      localStorage.setItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY', JSON.stringify(raw));
      return 1;
    })()
  `);
  await evalJs(`window.dispatchEvent(new Event('focus')); 1`);
  await sleep(800);
  check(
    "前台插件被禁用后详情视图收掉（不留空白容器）",
    (await evalJs(`document.getElementById('text_show').style.display`)) === "none",
    await evalJs(`document.getElementById('text_show').style.display`)
  );
  // 恢复启用，供后续小节继续用
  await evalJs(`
    (() => {
      const raw = JSON.parse(localStorage.getItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY'));
      raw.plugins.find(p => p.id === 'com.example.keep').enabled = true;
      localStorage.setItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY', JSON.stringify(raw));
      return 1;
    })()
  `);
  await evalJs(`window.dispatchEvent(new Event('focus')); 1`);
  await sleep(500);
}

/* ================= 6. 开发热重载：保活中的会话也要重挂（跑新代码） ================= */
{
  // 把「保活插件」改成开发挂载（source.dev），并通过 dev-changed 事件改它的入口脚本
  await evalJs(`
    (() => {
      const raw = JSON.parse(localStorage.getItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY'));
      const rec = raw.plugins.find(p => p.id === 'com.example.keep');
      rec.source = { kind: 'folder', ref: 'D:/code/demo/plugins/keep', dev: true };
      localStorage.setItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY', JSON.stringify(raw));
      window.__files['com.example.keep']['plugin.json'] = JSON.stringify(Object.assign({}, rec.manifest, { version: '2.0.0' }));
      window.__files['com.example.keep']['ui/view.js'] = "window.__mounts = window.__mounts || {}; window.__mounts[plugin.id] = (window.__mounts[plugin.id]||0) + 1; window.__second = true;";
      return 1;
    })()
  `);
  // 让搜索窗把新注册表读进来（触发 reload + 保活会话的清理判定）
  await evalJs(`window.dispatchEvent(new Event('focus')); 1`);
  await sleep(700);
  // 打开一次，确保它是前台会话（热重载只重挂「在看的」与「保活的」）
  await openPlugin("保活插件");
  const before = await probe("com.example.keep");
  await evalJs(`
    window.__emitTauriEvent('plugin://dev-changed', {
      pluginId: 'com.example.keep',
      dir: 'D:/code/demo/plugins/keep',
      paths: ['plugin.json', 'ui/view.js'],
      frontendOnly: true,
      at: Date.now(),
    })
  `);
  await sleep(1500);
  const after = await probe("com.example.keep");
  check(
    "开发热重载把已打开的会话重挂（跑的是新代码）",
    (await evalJs(`!!window.__second`)) === true && after.mounts === before.mounts + 1,
    `mounts ${before.mounts} → ${after.mounts}`
  );
}

/* ================= 7. 窗口高度：任何路径下盒子都不得高于下发的窗口高度 ================= */
/**
 * 回归：曾经出现「插件最小化后搜索框下边框消失」——搜索窗的 `#cfgToast`
 * 缺少 fixed 定位（只有设置窗口有对应规则），被当成普通块撑高 #my_search_box
 * 约 23px；而窗口高度按盒子实测值白名单式下发，多出来的部分只能溢出窗口，
 * 于是下边框被裁掉。触发路径是「恢复保活会话时的提示 toast」。
 *
 * 这里钉死两条：
 *   1. 搜索窗口的 toast 必须 fixed（不参与布局）；
 *   2. 每次下发窗口高度时，盒子实测高度不得显著超过它（否则边框被裁）。
 */
{
  const toastPos = JSON.parse(
    await evalJs(`JSON.stringify((() => {
      const el = document.getElementById('cfgToast');
      if (!el) return { exists: false };
      const cs = getComputedStyle(el);
      return { exists: true, position: cs.position, display: cs.display };
    })())`)
  );
  check(
    "搜索窗口的 toast 是 fixed 定位（不参与布局，不会顶高搜索框）",
    toastPos.exists === true && toastPos.position === "fixed",
    JSON.stringify(toastPos)
  );

  // 让 toast 处于显示态，再走一次「打开插件 → 最小化」，看下发高度与盒子是否一致
  await openPlugin("保活插件");
  await evalJs(`
    (() => {
      const el = document.getElementById('cfgToast');
      if (el) { el.textContent = '回归用提示'; el.classList.add('show', 'ok'); }
      window.__heights = [];
      return 1;
    })()
  `);
  await closeByEsc();
  await sleep(900);
  const heights = JSON.parse((await evalJs(`JSON.stringify(window.__heights || [])`)) || "[]");
  const worst = heights.reduce(
    (acc, h) => (h.box != null && h.req != null && h.box - h.req > (acc?.over ?? -Infinity) ? { over: h.box - h.req, ...h } : acc),
    null
  );
  check(
    "toast 显示期间下发高度与盒子一致（下边框不会被裁）",
    heights.length > 0 && worst != null && worst.over <= 1,
    `最差偏差 ${worst ? worst.over.toFixed(1) : "?"}px（req=${worst?.req} box=${worst?.box}，共 ${heights.length} 次下发）`
  );
}

check("全程无页面异常", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

console.log(`\n结果: ${pass} passed, ${fail} failed`);
ws.close();
chrome.kill();
server.close();
process.exit(fail === 0 ? 0 : 1);
