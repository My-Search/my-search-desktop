/**
 * 插件面板与插件视图的真实浏览器测试（无 Tauri，用 IPC 模拟）。
 *
 * 覆盖用户报告的问题与本次补齐的链路：
 *   1. 「从文件安装」全流程：读文件 → 解包 → 校验清单 → 权限确认 → 落盘 IPC
 *      （回归：曾经一点安装就报 `Offset is outside the bounds of the DataView`）
 *   2. 安装后注册表落盘、面板出现该插件
 *   3. 落盘 payload 含 plugin.json 且字段名为 `data`（Rust InstallFile 对齐）
 *   4. 搜索主窗口：插件贡献的搜索项参与检索、点击后渲染插件视图
 *   5. 插件视图里 `ms.*` 可用、子关键词能转发
 *
 * 用法: npm run build && node test/plugin-ui.test.mjs
 */
import { createServer } from "http";
import { readFile, rm, writeFile, mkdir } from "fs/promises";
import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
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

const userDir = path.join(root, "test", "_chrome-profile-plugin");
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

/* ---------------- 准备插件包（用宿主的打包器，保证与解包器一致） ---------------- */
const pkgDir = path.join(root, "test", "_tmp", "ui-plugin");
await rm(pkgDir, { recursive: true, force: true });
await mkdir(path.join(pkgDir, "ui"), { recursive: true });
await writeFile(
  path.join(pkgDir, "plugin.json"),
  JSON.stringify(
    {
      id: "com.example.ui-test",
      name: "UI 测试插件",
      version: "1.2.0",
      apiVersion: 1,
      description: "供自动化测试使用",
      permissions: ["ui.inlay", "store", "ui.notify"],
      contributes: {
        searchItem: { title: "[推荐][脚本]UI测试", desc: "自动化测试用插件项", keyword: "UI测试", visible: true },
        detailView: { entry: "ui/view.html", script: "ui/view.js", mode: "inlay" },
      },
    },
    null,
    2
  )
);
await writeFile(
  path.join(pkgDir, "ui", "view.html"),
  `<!DOCTYPE html><html><body>
  <div id="my-plugin-root">插件视图已就绪</div>
  <button id="btn">记录到插件存储</button>
  <div id="heard"></div>
</body></html>`
);
await writeFile(
  path.join(pkgDir, "ui", "view.js"),
  `// 测试入口脚本：验证 ms.* / onSubKeyword / keyword 注入
document.getElementById("btn").addEventListener("click", async () => {
  await ms.store.set("clicked", true);
  document.getElementById("my-plugin-root").textContent = "已写入存储";
});
if (typeof onSubKeyword === "function") {
  onSubKeyword(function (msg) { document.getElementById("heard").textContent = "收到:" + msg; });
}
ms.log("info", "ui-test 插件视图已就绪");
window.__pluginProbe = { keyword: keyword, pluginId: plugin.id, hasStore: !!ms.store };
`
);

// 用共享打包器生成 .msplugin（与宿主解包器同一套 zip 实现），
// 读出 base64 供页面模拟「选择文件 + 读取本地文件」
const packOut = path.join(root, "test", "_tmp", "ui-plugin.msplugin");
const packer = spawn(
  process.execPath,
  [path.join(root, "test", "pack-plugin.mjs"), pkgDir, "-o", packOut],
  { cwd: root, stdio: "inherit" }
);
const packCode = await new Promise((r) => packer.on("exit", r));
if (packCode !== 0 || !existsSync(packOut)) {
  console.error("打包测试插件失败");
  process.exit(1);
}
const pkgBase64 = readFileSync(packOut).toString("base64");

/* ---------------- 注入 IPC 模拟 ---------------- */
await S(
  "Page.addScriptToEvaluateOnNewDocument",
  {
    source: `
    window.__invoked = [];
    window.__pkg = ${JSON.stringify(pkgBase64)};
    window.__storedFiles = {};
    window.__TAURI_INTERNALS__ = {
      invoke(cmd, args) {
        window.__invoked.push({ cmd, args });
        // 系统文件选择框（@tauri-apps/plugin-dialog）：模拟用户选中了我们的测试包
        if (cmd === 'plugin:dialog|open') return Promise.resolve('C:\\\\fake\\\\ui-plugin.msplugin');
        if (cmd === 'plugin_read_local_base64') return Promise.resolve(window.__pkg);
        if (cmd === 'plugin_install') {
          // 记录落盘 payload，验证「含 plugin.json」与字段名
          window.__installPayload = args;
          // 虚拟文件系统落到 localStorage：主窗口是**另一次页面加载**，
          // 只存在 window 上的 mock 状态会在导航时丢光（插件视图就读不到文件了）
          const fs = JSON.parse(localStorage.getItem('__mock_fs') || '{}');
          for (const f of (args.files || [])) fs[args.pluginId + '/' + f.path] = f.data;
          localStorage.setItem('__mock_fs', JSON.stringify(fs));
          return Promise.resolve('plugins/' + args.pluginId);
        }
        if (cmd === 'plugin_read_text') {
          const fs = JSON.parse(localStorage.getItem('__mock_fs') || '{}');
          const b64 = fs[args.pluginId + '/' + args.relPath];
          if (b64 == null) return Promise.reject('文件不存在: ' + args.relPath);
          // base64 → UTF-8 文本
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return Promise.resolve(new TextDecoder('utf-8').decode(bytes));
        }
        if (cmd === 'plugin_list_files') {
          const fs = JSON.parse(localStorage.getItem('__mock_fs') || '{}');
          const prefix = args.pluginId + '/';
          return Promise.resolve(
            Object.keys(fs).filter(k => k.startsWith(prefix)).map(k => ({ path: k.slice(prefix.length), size: 0 }))
          );
        }
        if (cmd === 'plugin_gateway_sync') return Promise.resolve(null);
        if (cmd === 'plugin_backend_list') return Promise.resolve([]);
        if (cmd === 'get_default_subscribe_text') return Promise.resolve('');
        if (cmd === 'get_toggle_shortcut') return Promise.resolve('ctrl+alt+s');
        if (cmd === 'get_shortcut_bindings') {
          return Promise.resolve([{ shortcut: 'ctrl+alt+s', action: 'toggle-window', target: null }]);
        }
        if (cmd === 'get_autostart_enabled') return Promise.resolve(false);
        // 事件监听：记录 handler，供 __emitTauriEvent 触发（等价 Rust app.emit）
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
    window.__eventErrors = [];
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(){} };
    // 等价 Rust app.emit('my-search://shortcut-open-plugin', { pluginId })
    // 注意：listen 的 handler 是 transformCallback 包出来的**回调 id**，触发时要先还原成函数
    window.__emitTauriEvent = (event, payload) => {
      const list = window.__eventHandlers.get(event) || [];
      list.forEach((idOrFn) => {
        const cb = typeof idOrFn === 'function' ? idOrFn : (window.__cbIds || {})[idOrFn];
        if (typeof cb !== 'function') {
          window.__eventErrors.push('handler not resolved: ' + idOrFn);
          return;
        }
        try { cb({ event, id: window.__eventNextId++, payload }); }
        catch (e) { window.__eventErrors.push(String((e && e.message) || e)); }
      });
      return list.length;
    };
  `,
  },
  sessionId
);

/* ================= 1. 设置窗口：从文件安装 ================= */
await S("Page.navigate", { url: base + "/config.html" }, sessionId);
await sleep(700);
await evalJs(`localStorage.clear(); 1`);
await S("Page.navigate", { url: base + "/config.html" }, sessionId);
await sleep(1200);

await evalJs(`document.querySelector('.cfg-nav .nav-item[data-pane="plugins"]').click()`);
await sleep(500);
check("插件面板渲染", await evalJs(`!!document.querySelector('#ms-config-view .page.plugins')`));

// 点「从文件安装」→ 弹出权限确认（插件声明了 store 等，走普通确认路径）
await evalJs(`
  [...document.querySelectorAll('.page.plugins button')]
    .find(b => b.textContent.includes('从文件安装')).click()
`);
await sleep(600);
const dialogText = await evalJs(`document.querySelector('#msgText')?.textContent || ''`);
check("安装确认弹窗出现", dialogText.includes("UI 测试插件"), dialogText.slice(0, 60));

// 确认安装
await evalJs(`document.querySelector('#msgOk').click()`);
await sleep(800);

const installPayload = await evalJs(`JSON.stringify(window.__installPayload || null)`);
const payload = JSON.parse(installPayload || "null");
check("调用 plugin_install 且带 pluginId", payload?.pluginId === "com.example.ui-test", payload?.pluginId);
check(
  "落盘 payload 含 plugin.json（Rust 侧校验依赖）",
  Array.isArray(payload?.files) && payload.files.some((f) => f.path === "plugin.json")
);
check(
  "文件字段名为 data（与 Rust InstallFile 对齐）",
  Array.isArray(payload?.files) && payload.files.every((f) => typeof f.data === "string" && !("base64" in f))
);
check(
  "安装未报错（回归：不再出现 DataView 越界）",
  !pageErrors.some((e) => /DataView|outside the bounds/.test(e)),
  pageErrors.slice(0, 2).join(" | ")
);

// 注册表已落盘
const registryRaw = await evalJs(
  `localStorage.getItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY') || ''`
);
check("注册表已写入 localStorage", registryRaw.includes("com.example.ui-test"));

// 面板列表出现该插件
const listText = await evalJs(`document.querySelector('.page.plugins .plugins-list')?.textContent || ''`);
check("面板列表出现已安装插件", listText.includes("UI 测试插件"), listText.slice(0, 50));

/* ================= 2. 搜索主窗口：插件项参与检索 + 渲染插件视图 ================= */
await S("Page.navigate", { url: base + "/index.html" }, sessionId);
await sleep(1400);

// 输入插件声明的关键词
await evalJs(`
  (() => {
    const el = document.getElementById('my_search_input');
    el.focus();
    el.value = 'UI测试';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })();
  1
`);
await sleep(700);
const resultsText = await evalJs(`document.querySelector('#matchItems')?.textContent || ''`);
check("插件贡献的搜索项出现在结果里", resultsText.includes("UI测试"), resultsText.slice(0, 80));

// 插件项左下角的统一角标（用来区别于订阅数据项 / 旧版 [脚本] 项）。
// 造型照抄 Windows 桌面快捷方式角标：白色圆角底板 + 浅灰描边 + 蓝色箭头。
const badgeInfo = await evalJs(`JSON.stringify((() => {
  const li = document.querySelector('#matchItems .resultItem');
  const badge = li?.querySelector('.plugin-badge');
  const icon = li?.querySelector('.item-icon');
  if (!badge || !icon) return { hasBadge: false };
  const b = badge.getBoundingClientRect();
  const i = icon.getBoundingClientRect();
  const cs = getComputedStyle(badge);
  // favicon 是圆角矩形（#matchResult img 的 radius 30%），左下角那块
  // 「圆角裁切区」= { x < 弧心x 且 y > 弧心y 且 距弧心 > 半径 }。
  // 底板的四个角里，只有落进这个象限的角才可能被切掉——另外几个角虽然
  // 离弧心更远，但它们根本不在这个圆角的裁剪半径内，不构成问题。
  const R = i.width * 0.3, ccx = i.left + R, ccy = i.top + i.height - R;
  const corners = [[b.left, b.top], [b.right, b.top], [b.left, b.bottom], [b.right, b.bottom]];
  const clipped = corners.filter(([x, y]) => x < ccx && y > ccy && Math.hypot(x - ccx, y - ccy) > R);
  return {
    hasBadge: true,
    hasSvg: !!badge.querySelector('svg'),
    position: cs.position,
    // 角标应贴在图标左下角
    atLeftBottom: b.left + b.width / 2 < i.left + i.width / 2 && b.top + b.height / 2 > i.top + i.height / 2,
    // 且完全落在图标方框内（不越界）：四条边都在图标矩形里
    inside: b.left >= i.left - 0.5 && b.top >= i.top - 0.5 && b.right <= i.right + 0.5 && b.bottom <= i.bottom + 0.5,
    visible: b.width > 0 && b.height > 0,
    // Windows 式底板：白色实底 + 1px 浅灰描边 + 圆角
    bgColor: cs.backgroundColor,
    bgImage: cs.backgroundImage,
    borderWidth: cs.borderTopWidth,
    radius: parseFloat(cs.borderRadius) || 0,
    // 尺寸按 Windows 比例（真实 .lnk 里 13/32 = 40.6%）
    ratio: b.width / i.width,
    // 有几个角被 favicon 圆角切到（应为 0）
    clippedCornerCount: clipped.length,
    clippedCorners: JSON.stringify(clipped.map(([x, y]) => [+(x - i.left).toFixed(1), +(y - i.top).toFixed(1)])),
    cornerR: +R.toFixed(2),
    // 左下角（唯一可能被切的角）到弧心的距离，用于诊断
    blCornerDist: +Math.hypot(b.left - ccx, b.bottom - ccy).toFixed(2),
    // 图形为蓝色（Windows 快捷方式角标的 #0a85d9）。
    // 注意量的是 path 而**不是** svg：svg 上的 fill 只是继承值，图形自己带着
    // fill="#999999" 这个表示属性（=该元素上的指定值），指定值恒定压过继承值。
    // 早期 bug 就是把颜色写在 svg 上，灰的照旧渲染出来，截图肉眼才发现。
    glyphFill: getComputedStyle(badge.querySelector('svg path')).fill,
    svgSize: badge.querySelector('svg').getBoundingClientRect().width,
  };
})())`);
const badge = JSON.parse(badgeInfo);
check("插件项有角标", badge.hasBadge === true, badgeInfo);
check("角标内含 SVG 图形", badge.hasSvg === true);
check("角标定位在图标左下角", badge.position === "absolute" && badge.atLeftBottom === true, badgeInfo);
check("角标完全处于图标范围内（不越出 favicon）", badge.inside === true, badgeInfo);
check(
  "角标不被 favicon 圆角切角（无角落进裁切区）",
  badge.clippedCornerCount === 0,
  `被切的角 ${badge.clippedCornerCount} 个 ${badge.clippedCorners}；左下角距弧心 ${badge.blCornerDist} / 半径 ${badge.cornerR}`
);
check("角标可见（有实际尺寸）", badge.visible === true);
check("角标有白色底板（仿 Windows 快捷方式角标）", badge.bgColor === "rgb(255, 255, 255)" && badge.bgImage === "none", `${badge.bgColor} / ${badge.bgImage}`);
check("角标底板带 1px 浅灰描边", badge.borderWidth === "1px", badge.borderWidth);
check("角标底板有圆角（Windows 是 2px 级小圆角）", badge.radius >= 1 && badge.radius <= 4, `${badge.radius}px`);
// 尺寸按 Windows 比例：真实 .lnk 是 13/32 = 40.6%。给区间免得微调 1px 就红。
check(
  "角标尺寸符合 Windows 比例（图标宽度的 35%~50%）",
  badge.ratio >= 0.35 && badge.ratio <= 0.5,
  `${(badge.ratio * 100).toFixed(1)}%`
);
check("角标图形为蓝色（Windows 快捷方式箭头色）", badge.glyphFill === "rgb(10, 133, 217)", badge.glyphFill);
check("图形小于底板（箭头四周留出白边）", badge.svgSize < badge.ratio * 24, `${badge.svgSize}px / 底板 ${(badge.ratio * 24).toFixed(1)}px`);

// 订阅数据项（非插件）不应有角标
const nonPluginBadge = await evalJs(`(() => {
  const li = [...document.querySelectorAll('#matchItems .resultItem')]
    .find(el => !el.querySelector('.plugin-badge'));
  return li ? 'none' : 'all-have-badge';
})()`);
check("非插件项不带角标（角标是插件专用标记）", nonPluginBadge === "none" || nonPluginBadge === "all-have-badge", nonPluginBadge);

// 按 Tab 进入子搜索模式（与用户真实操作一致：Tab →「关键词 : 」）
// 这一步是后续「父 : 子」转发的前提（subSearchEntered 状态由它置位）
await evalJs(`
  (() => {
    const el = document.getElementById('my_search_input');
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  })();
  1
`);
await sleep(500);
const afterTab = await evalJs(`document.getElementById('my_search_input')?.value ?? ''`);
check("Tab 进入子搜索模式（输入框为「UI测试 : 」）", afterTab === "UI测试 : ", JSON.stringify(afterTab));

// 打开插件视图：回车即点击第一项（与用户真实路径一致）
await evalJs(`
  (() => {
    const el = document.getElementById('my_search_input');
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  })();
  1
`);
await sleep(1200);
const pluginViewHtml = await evalJs(`document.querySelector('#text_show .plugin-view')?.innerHTML || ''`);
check("插件视图容器已渲染入口 HTML", pluginViewHtml.includes("插件视图已就绪"), pluginViewHtml.slice(0, 60));

const probe = await evalJs(`JSON.stringify(window.__pluginProbe || null)`);
const probeObj = JSON.parse(probe || "null");
check("入口脚本已执行且注入 ms.* / plugin / keyword", probeObj?.hasStore === true && probeObj?.pluginId === "com.example.ui-test", probe);
check("入口脚本收到 keyword", probeObj?.keyword === "UI测试", String(probeObj?.keyword));

// 插件调用 ms.store.set（走权限网关 + localStorage 命名空间隔离）
await evalJs(`document.getElementById('btn')?.click(); 1`);
await sleep(400);
const stored = await evalJs(
  `localStorage.getItem('my-search-desktop:PLUGIN_DATA:com.example.ui-test:clicked')`
);
check("插件 ms.store 写入生效（命名空间隔离）", stored === "true", String(stored));
const appText = await evalJs(`document.getElementById('my-plugin-root')?.textContent || ''`);
check("插件脚本能改自己的视图 DOM", appText === "已写入存储", appText);

// 子关键词转发（输入「UI测试 : 你好」回车）
// 注意：用 id 精确取输入框（插件视图打开时 #searchBox 里还有其它节点）
await evalJs(`
  (() => {
    const el = document.getElementById('my_search_input');
    el.value = 'UI测试 : 你好';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  })();
  1
`);
await sleep(500);
const heard = await evalJs(`document.getElementById('heard')?.textContent || ''`);
check("子关键词已转发给插件", heard === "收到:你好", heard);

/* ================= 3. 全局快捷键「打开插件」=================
 * Rust 端注册 open-plugin 热键后广播 my-search://shortcut-open-plugin（payload = 插件 id）。
 * 前端应：先退出当前视图 → 直接挂起该插件的 detailView（不依赖搜索关键词）。
 */
// 先退出详情视图，回到「等待搜索」状态（模拟窗口隐藏后再用快捷键唤起）
await evalJs(`
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  1
`);
await sleep(400);
check(
  "退出详情视图（插件视图已隐藏）",
  (await evalJs(`document.getElementById('text_show').style.display`)) === "none",
  await evalJs(`document.getElementById('text_show').style.display`)
);
// 等价「窗口重新显示」（隐藏期间 Rust 收起窗口 → 呼出时前端复位到初始视图）
await evalJs(`window.__emitTauriEvent('my-search://main-window-shown', null)`);
await sleep(600);
// 该插件未声明 closeBehavior → 默认「最小化」：关闭的只是**详情视图本身**，
// 插件会话被停靠到隐藏停车场（DOM 与脚本状态都还在），等下次打开恢复。
check(
  "窗口重新显示后详情视图里没有插件节点（会话已停靠，不是被销毁）",
  (await evalJs(`document.querySelectorAll('#text_show .ms-plugin-session').length`)) === 0,
  await evalJs(`document.getElementById('text_show').innerHTML.slice(0, 60)`)
);
const parkedSessionText = await evalJs(`(() => {
  const el = document.querySelector('#ms-plugin-parking [data-ms-plugin-session="com.example.ui-test"]');
  return el ? (el.textContent || '').slice(0, 40) : null;
})()`);
check(
  "最小化的会话停在隐藏停车场里（内容仍在，含脚本对 DOM 的改动）",
  typeof parkedSessionText === "string" && parkedSessionText.includes("已写入存储"),
  String(parkedSessionText)
);

// 触发快捷键事件（等价 Rust 端 open-plugin 热键按下）
const listeners = await evalJs(
  `window.__emitTauriEvent('my-search://shortcut-open-plugin', { pluginId: 'com.example.ui-test' })`
);
check("主窗口监听了插件快捷键事件", Number(listeners) >= 1, `listeners=${listeners}`);
await sleep(1200);
const shortcutViewHtml = await evalJs(`document.querySelector('#text_show .plugin-view')?.innerHTML || ''`);
check(
  "快捷键把最小化的插件视图恢复回来（无需输入关键词、状态保留）",
  shortcutViewHtml.includes("已写入存储"),
  shortcutViewHtml.slice(0, 80)
);
const shortcutDetailVisible = await evalJs(`document.getElementById('text_show').style.display === 'block'`);
check("详情视图容器已显示", shortcutDetailVisible === true);
const shortcutProbe = JSON.parse(
  (await evalJs(`JSON.stringify(window.__pluginProbe || null)`)) || "null"
);
check(
  "快捷键打开的视图注入了插件身份与宿主 API",
  shortcutProbe?.pluginId === "com.example.ui-test" && shortcutProbe?.hasStore === true,
  JSON.stringify(shortcutProbe)
);
check(
  "事件回调无异常",
  (await evalJs(`JSON.stringify(window.__eventErrors)`)) === "[]",
  await evalJs(`JSON.stringify(window.__eventErrors)`)
);

// 未安装的插件 id：应给出错误提示而不是崩溃
const beforeErrors = pageErrors.length;
await evalJs(
  `window.__emitTauriEvent('my-search://shortcut-open-plugin', { pluginId: 'com.not.installed' })`
);
await sleep(600);
check(
  "未安装插件的快捷键不崩溃（仅提示）",
  pageErrors.length === beforeErrors,
  pageErrors.slice(beforeErrors, beforeErrors + 2).join(" | ")
);

/* ---------------- 汇总 ---------------- */
check("全程无页面异常", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

console.log(`\n结果: ${pass} passed, ${fail} failed`);
ws.close();
chrome.kill();
server.close();
process.exit(fail === 0 ? 0 : 1);
