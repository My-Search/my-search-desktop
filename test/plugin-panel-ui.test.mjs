/**
 * 插件面板列表的浏览器验收（无 Tauri，用 IPC 模拟）。
 *
 * 用户诉求：
 *   1. **列表里只显示插件**，不显示订阅数据里的 `[脚本]` 项；
 *   2. 每个插件左侧显示**插件自己的 logo**（清单 icon）。
 *
 * 覆盖：
 *   - 预置一条历史遗留的 legacy 记录（旧版面板塞进注册表的那种）→ 打开面板即被清掉
 *   - 订阅缓存里塞了 `[脚本]` 数据项 → 面板列表**不出现**它
 *   - 相对路径图标（`icon.svg`）经 IPC 读取后渲染成 data URL 的 `<img>`
 *   - 网络图标（`https://…`）原样直出，无需读文件
 *   - 图标读取失败时不出现碎图（退回默认图标）
 *   - 状态栏「已安装 N」只数真插件
 *
 * 用法: npm run build && node test/plugin-panel-ui.test.mjs
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

const userDir = path.join(root, "test", "_chrome-profile-plugin-panel");
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

/** 三个待装插件：相对路径图标 / 网络图标 / 无图标 */
const MANIFESTS = [
  {
    id: "com.example.local-icon",
    name: "本地图标插件",
    version: "1.0.0",
    apiVersion: 1,
    description: "图标是插件目录内的相对路径",
    icon: "assets/logo.svg",
  },
  {
    id: "com.example.remote-icon",
    name: "网络图标插件",
    version: "2.0.0",
    apiVersion: 1,
    description: "图标是网络地址",
    icon: "https://api.example.com/icon.png",
  },
  {
    id: "com.example.no-icon",
    name: "无图标插件",
    version: "3.0.0",
    apiVersion: 1,
    description: "清单里没有 icon",
  },
  /**
   * 带后台进程 + 显式声明两个行为默认值的插件：
   *   - 插件建议「关闭界面时退出」（记录里用户还没改，初始值即建议值）；
   *   - 插件建议「按需启动」，记录里被用户改成了「从不自启」→ 应出现「恢复」。
   */
  {
    id: "com.example.backend-exit",
    name: "建议退出插件",
    version: "1.0.0",
    apiVersion: 1,
    description: "带后台进程，插件建议关闭界面时退出",
    permissions: ["backend.spawn"],
    backend: { entry: "backend/app.exe", autostart: "on-demand", closeBehavior: "exit" },
  },
  /**
   * 开机自启 + 建议最小化：用户设了「开机自启」时，「关闭界面时」应被锁定
   * （置灰 + 说明），因为进程常驻与「关闭即退出」互相矛盾。
   */
  {
    id: "com.example.backend-always",
    name: "开机自启插件",
    version: "1.0.0",
    apiVersion: 1,
    description: "带后台进程且已设为开机自启",
    permissions: ["backend.spawn"],
    backend: { entry: "backend/app.exe", autostart: "prompt", closeBehavior: "minimize" },
  },
];

const PLUGIN_NAMES = MANIFESTS.map((m) => m.name);
const BACKEND_NAME = "建议退出插件";
const ALWAYS_NAME = "开机自启插件";

/** 本地图标的真实内容（相对路径 → 宿主读文件 → data URL） */
const LOCAL_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><rect width="24" height="24" fill="#4e6ef2"/></svg>';
const LOCAL_ICON_B64 = Buffer.from(LOCAL_ICON_SVG, "utf8").toString("base64");

/** 用户订阅数据里的 `[脚本]` 项（面板不该显示它） */
const SCRIPT_ITEM = {
  title: "[脚本]脚本应用测试项",
  desc: "订阅数据里的脚本项，不是插件",
  resource: "not a real script resource",
  type: "script",
  subscribe: "订阅A",
};

const RECORDS = MANIFESTS.map((mf) => ({
  id: mf.id,
  name: mf.name,
  version: mf.version,
  apiVersion: mf.apiVersion,
  description: mf.description,
  icon: mf.icon,
  manifest: mf,
  dir: `plugins/${mf.id}`,
  source: { kind: "file", ref: "C:\\fake\\x.msplugin" },
  installedAt: now,
  updatedAt: now,
  enabled: true,
  autoStart: "on-demand",
  requestedAutoStart: mf.backend?.autostart ?? "on-demand",
  // 关闭行为的有效值：默认取「插件建议」（清单里的 closeBehavior）
  closeBehavior: mf.backend?.closeBehavior === "exit" ? "exit" : "minimize",
  grants: [],
  denied: [],
  runtime: { status: "stopped", pid: null, memoryBytes: null, startedAt: null, restarts: 0, lastError: null, keepAliveReasons: [] },
  integrity: { sha256: null, signed: false },
}));

// 用户改动：把「开机自启插件」设成 always（用于验证「关闭界面时」被锁定），
// 把「建议退出插件」的开机自启从建议的 on-demand 改成 never（用于验证「恢复」按钮）
RECORDS.find((r) => r.id === "com.example.backend-always").autoStart = "always";
RECORDS.find((r) => r.id === "com.example.backend-exit").autoStart = "never";

/** 历史遗留记录：旧版面板把 `[脚本]` 项投影成的伪插件（必须在打开面板时被清掉） */
const LEGACY_RECORD = {
  id: "legacy:abc123",
  name: "脚本应用测试项",
  version: "—",
  apiVersion: 0,
  description: "来自订阅「订阅A」的 [脚本] 数据项",
  manifest: { id: "legacy:abc123", name: "脚本应用测试项", version: "—", apiVersion: 0, permissions: [] },
  dir: "",
  source: { kind: "legacy", ref: "订阅A" },
  installedAt: 0,
  updatedAt: 0,
  enabled: true,
  autoStart: "never",
  requestedAutoStart: "never",
  grants: [],
  denied: [],
  runtime: { status: "stopped", pid: null, memoryBytes: null, startedAt: null, restarts: 0, lastError: null, keepAliveReasons: [] },
  integrity: { sha256: null, signed: false },
  legacyRef: { title: "[脚本]脚本应用测试项", subscribe: "订阅A" },
};

/* ---------------- 注入 IPC 模拟 ---------------- */
await S(
  "Page.addScriptToEvaluateOnNewDocument",
  {
    source: `
    window.__readCalls = [];
    window.__invoked = [];
    window.__TAURI_INTERNALS__ = {
      invoke(cmd, args) {
        window.__invoked.push({ cmd, args });
        if (cmd === 'plugin_read_binary') {
          window.__readCalls.push(args.pluginId + '/' + args.relPath);
          // 只有本地图标插件有真实文件；其余请求模拟「文件不存在」，
          // 用来验证「读不到图标 → 退回默认图标，而不是碎图」
          if (args.pluginId === 'com.example.local-icon' && args.relPath === 'assets/logo.svg') {
            return Promise.resolve(${JSON.stringify(LOCAL_ICON_B64)});
          }
          return Promise.reject('文件不存在: ' + args.relPath);
        }
        if (cmd === 'plugin_gateway_sync') return Promise.resolve(null);
        if (cmd === 'plugin_backend_list') return Promise.resolve([]);
        if (cmd === 'plugin_backend_stop') return Promise.resolve(null);
        if (cmd === 'plugin_backend_start') {
          return Promise.resolve({ pluginId: args.pluginId, status: 'running', pid: 4321, memoryBytes: null, startedAt: Date.now(), restarts: 0, lastError: null, keepAliveReasons: [] });
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
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(){} };
  `,
  },
  sessionId
);

/* ================= 1. 预置注册表 + 订阅缓存，打开插件面板 ================= */
await S("Page.navigate", { url: base + "/config.html" }, sessionId);
await sleep(700);

await evalJs(`
  (() => {
    localStorage.clear();
    // 三个真插件 + 一条历史遗留的 legacy 记录
    localStorage.setItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY', JSON.stringify({
      version: 1,
      plugins: ${JSON.stringify([...RECORDS, LEGACY_RECORD])},
    }));
    // 订阅数据缓存里放一条 [脚本] 项
    localStorage.setItem('my-search-desktop:SEARCH_DATA_KEY', JSON.stringify({
      data: [${JSON.stringify(SCRIPT_ITEM)}],
      expire: Date.now() + 3600 * 1000,
    }));
    return 1;
  })()
`);
await S("Page.navigate", { url: base + "/config.html" }, sessionId);
await sleep(900);

await evalJs(`document.querySelector('.cfg-nav .nav-item[data-pane="plugins"]').click()`);
await sleep(900);

check("插件面板渲染", await evalJs(`!!document.querySelector('#ms-config-view .page.plugins')`));

/* ================= 2. 列表里只有插件 ================= */
const names = await evalJs(`JSON.stringify(
  [...document.querySelectorAll('.page.plugins .plugins-list .plugin-item .plugin-name')]
    .map(el => (el.firstChild?.textContent || el.textContent || '').trim())
)`);
const nameList = JSON.parse(names || "[]");
check(
  `列表显示了 ${PLUGIN_NAMES.length} 个插件`,
  nameList.length === PLUGIN_NAMES.length && PLUGIN_NAMES.every((n) => nameList.includes(n)),
  names
);
check("列表里没有 legacy 伪插件条目", !nameList.includes("脚本应用测试项"), names);

const listText = await evalJs(`document.querySelector('.page.plugins .plugins-list')?.textContent || ''`);
check("「脚本应用测试项」整块文字都没出现", !listText.includes("脚本应用测试项"), listText.slice(0, 80));
check("面板里没有「脚本项」筛选按钮", !(await evalJs(`
  [...document.querySelectorAll('.page.plugins .plugins-filter .btn-filter')].some(b => b.textContent.includes('脚本'))
`)));
check("筛选按钮只剩 全部/后台运行中/异常", (await evalJs(`
  [...document.querySelectorAll('.page.plugins .plugins-filter .btn-filter')].map(b => b.textContent.replace(/\\s+/g,'').replace(/\\d+/, '')).join(',')
`)) === "全部,后台运行中,异常");

const statsText = await evalJs(`document.querySelector('.page.plugins .plugins-stats')?.textContent || ''`);
check("「已安装」只数真插件（不含 legacy）", statsText.includes(`已安装 ${PLUGIN_NAMES.length}`), statsText.trim());
check("状态栏不再出现「后台运行」计数（无进程）", statsText.includes("无后台进程"), statsText.trim());

/* ================= 3. 注册表里的 legacy 记录被清理 ================= */
const registryAfter = await evalJs(`localStorage.getItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY') || ''`);
const reg = JSON.parse(registryAfter || "{}");
check("历史遗留的 legacy 记录已从注册表清除", !registryAfter.includes("legacy:abc123"), registryAfter.slice(0, 120));
check("真插件记录原样保留", (reg.plugins || []).length === PLUGIN_NAMES.length, String((reg.plugins || []).length));

/* ================= 4. 插件 logo ================= */
const icons = await evalJs(`JSON.stringify((() => {
  const items = [...document.querySelectorAll('.page.plugins .plugins-list .plugin-item')];
  return items.map(el => {
    const box = el.querySelector('.plugin-icon');
    const img = box?.querySelector('img');
    const name = (el.querySelector('.plugin-name')?.firstChild?.textContent || '').trim();
    const r = box?.getBoundingClientRect();
    const ir = img?.getBoundingClientRect();
    return {
      name,
      hasImg: !!img,
      src: img?.getAttribute('src') || '',
      naturalW: img?.naturalWidth || 0,
      // 图标位是列表行最左边：其左边缘应早于名字
      leftOfName: r && ir ? r.left <= (el.querySelector('.plugin-name').getBoundingClientRect().left + 1) : false,
      boxW: r?.width || 0,
      boxH: r?.height || 0,
      imgW: ir?.width || 0,
      imgH: ir?.height || 0,
      // 带 logo 时不应再有 accent 底色（否则边缘露一圈色边）
      bg: box ? getComputedStyle(box).backgroundColor : '',
      text: (box?.textContent || '').trim(),
    };
  });
})())`);
const iconList = JSON.parse(icons || "[]");
const byName = Object.fromEntries(iconList.map((i) => [i.name, i]));
check("每行插件都渲染了图标位", iconList.length === PLUGIN_NAMES.length, icons?.slice(0, 120));

const local = byName["本地图标插件"];
check("相对路径图标渲染成了 <img>", local?.hasImg === true, JSON.stringify(local));
check(
  "相对路径图标被读成 data URL（image/svg+xml）",
  typeof local?.src === "string" && local.src.startsWith("data:image/svg+xml;base64,"),
  local?.src?.slice(0, 60)
);
check(
  "data URL 内容与插件目录里的图标一致",
  local?.src === `data:image/svg+xml;base64,${LOCAL_ICON_B64}`,
  local?.src?.slice(0, 80)
);
check("相对路径图标位不再显示默认 emoji", local?.text === "", JSON.stringify(local?.text));
check("带 logo 时图标位无底色（避免图标边缘露色边）", local?.bg === "rgba(0, 0, 0, 0)", local?.bg);
check(
  "logo 在列表行左侧（图标左边缘不晚于名字）",
  local?.leftOfName === true,
  JSON.stringify({ leftOfName: local?.leftOfName })
);
check(
  "logo 尺寸为 34×34（与图标位一致，未撑破行高）",
  local?.boxW === 34 && local?.boxH === 34 && local?.imgW === 34 && local?.imgH === 34,
  JSON.stringify({ box: [local?.boxW, local?.boxH], img: [local?.imgW, local?.imgH] })
);

const remote = byName["网络图标插件"];
// 网络地址由 WebView 直接加载（不经过宿主）。离线环境下 <img> 会触发 error、
// 面板按设计退回默认图标（不留碎图），因此这里两种结果都算通过；
// 「不读插件目录」这一条（下面那个断言）与网络无关，必须严格成立。
check(
  "网络图标原样直出（不需要读插件目录）",
  (remote?.hasImg === true && remote?.src === "https://api.example.com/icon.png") ||
    (remote?.hasImg === false && remote?.text === "🧩"),
  `${remote?.src} / hasImg=${remote?.hasImg} / text=${JSON.stringify(remote?.text)}`
);
check(
  "网络图标没有发起 plugin_read_binary（自带地址不读文件）",
  (await evalJs(`JSON.stringify(window.__readCalls)`)) === JSON.stringify(["com.example.local-icon/assets/logo.svg"]),
  await evalJs(`JSON.stringify(window.__readCalls)`)
);

const none = byName["无图标插件"];
check(
  "无图标插件退回默认图标（不出现 <img> 碎图）",
  none?.hasImg === false && none?.text === "🧩",
  JSON.stringify({ hasImg: none?.hasImg, text: none?.text })
);
check("默认图标位保留底色", none?.bg !== "rgba(0, 0, 0, 0)", none?.bg);

/* ================= 4.5 行为设置（关闭界面时 / 开机自启）+ 插件建议 ================= */
/**
 * 读某插件展开后的行为行。
 * @param name 插件名
 */
const readBehavior = async (name) => {
  const raw = await evalJs(`JSON.stringify((() => {
    const el = [...document.querySelectorAll('.page.plugins .plugins-list .plugin-item')]
      .find(e => (e.querySelector('.plugin-name')?.firstChild?.textContent || '').trim() === ${JSON.stringify(name)});
    if (!el) return null;
    // 展开该行
    el.querySelector('.plugin-header')?.click();
    return 1;
  })())`);
  if (!raw) return null;
  await sleep(200);
  return JSON.parse(
    await evalJs(`JSON.stringify((() => {
      const el = [...document.querySelectorAll('.page.plugins .plugins-list .plugin-item')]
        .find(e => (e.querySelector('.plugin-name')?.firstChild?.textContent || '').trim() === ${JSON.stringify(name)});
      const rows = [...el.querySelectorAll('.plugin-info-row')];
      const rowOf = (label) => rows.find(r => (r.querySelector('.plugin-info-label')?.textContent || '').trim() === label);
      const read = (label) => {
        const row = rowOf(label);
        if (!row) return null;
        const cell = row.querySelector('.behavior-cell') || row;
        const btns = [...cell.querySelectorAll('.btn-tiny')];
        return {
          labels: btns.map(b => b.textContent.trim()),
          active: btns.filter(b => b.classList.contains('on')).map(b => b.textContent.trim()),
          disabled: btns.filter(b => b.disabled).map(b => b.textContent.trim()),
          suggest: (cell.querySelector('.plugin-suggest')?.textContent || '').trim(),
          locked: (cell.querySelector('.behavior-locked')?.textContent || '').trim(),
          hasRestore: !!cell.querySelector('.btn-link'),
        };
      };
      const startBtns = [...(rowOf('后台进程')?.querySelectorAll('.btn-sm') || [])].map(b => b.textContent.trim());
      return { close: read('关闭界面时'), auto: read('开机自启'), backendButtons: startBtns };
    })())`)
  );
};

const exitInfo = await readBehavior(BACKEND_NAME);
check("带后台进程的插件显示「关闭界面时」行", exitInfo?.close !== null, JSON.stringify(exitInfo?.close));
check(
  "「关闭界面时」两个选项都渲染（最小化 / 退出）",
  JSON.stringify(exitInfo?.close?.labels) === JSON.stringify(["最小化", "退出"]),
  JSON.stringify(exitInfo?.close?.labels)
);
check(
  "当前值（插件建议 exit）被高亮为「退出」",
  JSON.stringify(exitInfo?.close?.active) === JSON.stringify(["退出"]),
  JSON.stringify(exitInfo?.close?.active)
);
check(
  "显示「插件建议：退出」",
  exitInfo?.close?.suggest === "插件建议：退出",
  exitInfo?.close?.suggest
);
check("当前值即建议值时不显示「恢复」", exitInfo?.close?.hasRestore === false);
check("未锁定（非开机自启）时按钮可用", JSON.stringify(exitInfo?.close?.disabled) === "[]", JSON.stringify(exitInfo?.close?.disabled));
check("「关闭界面时」未锁定时没有警示文案", exitInfo?.close?.locked === "", exitInfo?.close?.locked);

check(
  "「开机自启」三个选项都渲染",
  JSON.stringify(exitInfo?.auto?.labels) === JSON.stringify(["开机自启", "按需启动", "从不自启"]),
  JSON.stringify(exitInfo?.auto?.labels)
);
check(
  "用户改过的值（never）被高亮",
  JSON.stringify(exitInfo?.auto?.active) === JSON.stringify(["从不自启"]),
  JSON.stringify(exitInfo?.auto?.active)
);
check(
  "显示「插件建议：按需启动」",
  exitInfo?.auto?.suggest === "插件建议：按需启动",
  exitInfo?.auto?.suggest
);
check("用户改过 → 显示「恢复」", exitInfo?.auto?.hasRestore === true);
check("「后台进程」行仍有启停按钮（启动 + 重启）", JSON.stringify(exitInfo?.backendButtons) === JSON.stringify(["启动", "重启"]), JSON.stringify(exitInfo?.backendButtons));

// 点击「关闭界面时 → 最小化」→ 仅落盘注册表（不动进程）
await evalJs(`
  (() => {
    const el = [...document.querySelectorAll('.page.plugins .plugins-list .plugin-item')]
      .find(e => (e.querySelector('.plugin-name')?.firstChild?.textContent || '').trim() === ${JSON.stringify(BACKEND_NAME)});
    const row = [...el.querySelectorAll('.plugin-info-row')]
      .find(r => (r.querySelector('.plugin-info-label')?.textContent || '').trim() === '关闭界面时');
    [...row.querySelectorAll('.btn-tiny')].find(b => b.textContent.trim() === '最小化').click();
    return 1;
  })()
`);
await sleep(400);
const afterSet = JSON.parse(
  await evalJs(`JSON.stringify((() => {
    const raw = JSON.parse(localStorage.getItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY'));
    const rec = raw.plugins.find(p => p.id === 'com.example.backend-exit');
    return { closeBehavior: rec.closeBehavior, autoStart: rec.autoStart, stopCalls: (window.__invoked || []).filter(i => i.cmd === 'plugin_backend_stop').length };
  })())`)
);
check("点「最小化」把记录写成 minimize", afterSet.closeBehavior === "minimize", JSON.stringify(afterSet));
check("改「关闭界面时」不触发任何进程启停（纯前端设置）", afterSet.stopCalls === 0, JSON.stringify(afterSet));
check("改「关闭界面时」不影响开机自启值", afterSet.autoStart === "never", String(afterSet.autoStart));

const afterRestore = JSON.parse(
  await evalJs(`JSON.stringify((() => {
    const el = [...document.querySelectorAll('.page.plugins .plugins-list .plugin-item')]
      .find(e => (e.querySelector('.plugin-name')?.firstChild?.textContent || '').trim() === ${JSON.stringify(BACKEND_NAME)});
    const row = [...el.querySelectorAll('.plugin-info-row')]
      .find(r => (r.querySelector('.plugin-info-label')?.textContent || '').trim() === '关闭界面时');
    const btn = row.querySelector('.btn-link');
    if (!btn) return { clicked: false };
    btn.click();
    return { clicked: true };
  })())`)
);
await sleep(400);
const afterRestoreReg = JSON.parse(
  await evalJs(`JSON.stringify((() => {
    const raw = JSON.parse(localStorage.getItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY'));
    const rec = raw.plugins.find(p => p.id === 'com.example.backend-exit');
    return { closeBehavior: rec.closeBehavior, autoStart: rec.autoStart };
  })())`)
);
check("改过之后出现「恢复」按钮", afterRestore.clicked === true, JSON.stringify(afterRestore));
check(
  "「恢复」同时把两项写回插件建议值",
  afterRestoreReg.closeBehavior === "exit" && afterRestoreReg.autoStart === "on-demand",
  JSON.stringify(afterRestoreReg)
);

// 开机自启的插件：「关闭界面时」的**进程侧**被常驻覆盖，但**界面侧**仍然生效——
// 界面要不要保活与进程是否常驻是两件事，因此按钮不再置灰，只给一行说明。
const alwaysInfo = await readBehavior(ALWAYS_NAME);
check("开机自启插件显示「关闭界面时」行", alwaysInfo?.close !== null);
check(
  "开机自启不再置灰「关闭界面时」（界面保活与进程常驻是两件事）",
  JSON.stringify(alwaysInfo?.close?.disabled) === "[]",
  JSON.stringify(alwaysInfo?.close?.disabled)
);
check(
  "开机自启时给出说明（进程常驻不会停；界面仍按此设置保留或卸载）",
  (alwaysInfo?.close?.locked || "").includes("开机自启") &&
    (alwaysInfo?.close?.locked || "").includes("常驻") &&
    (alwaysInfo?.close?.locked || "").includes("界面"),
  alwaysInfo?.close?.locked
);
check("有说明文案时不再显示「恢复」（说明优先于建议值对比）", alwaysInfo?.close?.hasRestore === false);
check(
  "prompt 建议显示为「由你决定」",
  alwaysInfo?.auto?.suggest === "插件建议：由你决定",
  alwaysInfo?.auto?.suggest
);

/* ================= 5. 图标读取失败 → 退回默认图标 ================= */
// 把本地图标插件的记录改成指向一个读不到的文件，重开面板
await evalJs(`
  (() => {
    const raw = JSON.parse(localStorage.getItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY'));
    const rec = raw.plugins.find(p => p.id === 'com.example.local-icon');
    rec.manifest.icon = 'assets/missing.svg';
    localStorage.setItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY', JSON.stringify(raw));
    return 1;
  })()
`);
await S("Page.navigate", { url: base + "/config.html" }, sessionId);
await sleep(900);
await evalJs(`document.querySelector('.cfg-nav .nav-item[data-pane="plugins"]').click()`);
await sleep(900);

const afterFail = await evalJs(`JSON.stringify((() => {
  const el = [...document.querySelectorAll('.page.plugins .plugins-list .plugin-item')]
    .find(e => (e.textContent || '').includes('本地图标插件'));
  const box = el?.querySelector('.plugin-icon');
  return { hasImg: !!box?.querySelector('img'), text: (box?.textContent || '').trim() };
})())`);
const failInfo = JSON.parse(afterFail || "{}");
check(
  "图标文件读不到时退回默认图标（无碎图）",
  failInfo.hasImg === false && failInfo.text === "🧩",
  afterFail
);

check("全程无页面异常", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

console.log(`\n结果: ${pass} passed, ${fail} failed`);
ws.close();
chrome.kill();
server.close();
process.exit(fail === 0 ? 0 : 1);
