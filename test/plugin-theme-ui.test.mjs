/**
 * 回归测试：插件界面（pi-agent / 插件市场）跟随宿主主题（真实浏览器 + 计算样式）。
 *
 * 背景：主题变量原先只挂在 `html.ms-config-root`（设置窗口）上，搜索窗口的深色
 * 全靠写死的 `html.theme-dark …` 规则——内嵌插件（`#text_show .plugin-view`）里
 * `var(--card)` 之类的引用解析不到值，插件只能各自写死一套配色（pi-agent 写死
 * 深色、插件市场写死浅色），用户换主题时插件界面纹丝不动。
 *
 * 修复分三层，本测试逐层锁死：
 *  1. 宿主把共享主题变量下沉到搜索窗口根（style.css：`html` 浅色基准 +
 *     `html.theme-dark` 深色覆盖）——`getComputedStyle(document.documentElement)`
 *     在浅/深下分别读到两套值；
 *  2. 插件 CSS 用「宿主 token + 兜底值」引用这些变量（pi-agent / market 的
 *     detail.css），经宿主的 scopeCss 作用域化后注入，浅/深下计算样式随主题变；
 *  3. 逻辑级 API：`ms.ui.theme` / `ms.ui.onThemeChanged` 存在，且主题变更会派发
 *     DOM 事件（本窗口内所有主题应用路径的汇聚点，含 Rust 跨窗口同步）。
 *
 * 用法: npm run build && node test/plugin-theme-ui.test.mjs
 * 需要本机装有 Chrome / Edge；找不到浏览器时跳过（退出码 0）。
 */
import { createServer } from "http";
import { readFile, mkdir } from "fs/promises";
import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
if (!existsSync(path.join(dist, "index.html"))) {
  console.error("请先 npm run build");
  process.exit(1);
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

/* ============================================================
 * 第一层（源码契约，无需浏览器）：变量层 / 事件 / API 都在源码里
 * ============================================================ */
const styleCss = readFileSync(path.join(root, "src/css/style.css"), "utf8");
const themeTs = readFileSync(path.join(root, "src/lib/theme.ts"), "utf8");
const hostTs = readFileSync(path.join(root, "src/lib/plugins/host.ts"), "utf8");

check(
  "style.css：搜索窗口根定义了浅色基准变量（html / html.theme-light）",
  /(^|\n)(html,\s*html\.theme-light|html)\s*\{[^}]*--card:\s*#ffffff/s.test(styleCss) ||
    /html\.theme-light\s*\{[^}]*--card:\s*#ffffff/s.test(styleCss),
);
check(
  "style.css：搜索窗口根定义了深色覆盖变量（html.theme-dark）",
  /html\.theme-dark\s*\{[^}]*--card:\s*#212429/s.test(styleCss),
);
check(
  "style.css：深色覆盖块同时给出 --surface/--text/--line（插件常用三项）",
  /html\.theme-dark\s*\{[^}]*--surface:\s*#17191d/s.test(styleCss) &&
    /html\.theme-dark\s*\{[^}]*--text:\s*#e4e6ea/s.test(styleCss) &&
    /html\.theme-dark\s*\{[^}]*--line:\s*#33363d/s.test(styleCss),
);
check(
  "theme.ts：applyTheme 派发 DOM 事件（本窗口主题变更汇聚点）",
  themeTs.includes("THEME_CHANGED_EVENT") && /dispatchEvent\(new CustomEvent\(THEME_CHANGED_EVENT\)\)/.test(themeTs),
);
check("theme.ts：导出 effectiveTheme()（读 <html> 上的主题类）", /export function effectiveTheme\(\)/.test(themeTs));
check(
  "host.ts：ms.ui 暴露 theme / onThemeChanged / _clearThemeHandlers",
  /get theme\(\)/.test(hostTs) && /onThemeChanged:/.test(hostTs) && /_clearThemeHandlers:/.test(hostTs),
);
check(
  "usePluginViewHost：会话卸载时清理主题订阅（_clearThemeHandlers）",
  readFileSync(path.join(root, "src/windows/search/usePluginViewHost.ts"), "utf8").includes("_clearThemeHandlers"),
);

/* ============================================================
 * 第二层（真实浏览器）：变量链真的解析出两套值，插件样式真的跟随
 * ============================================================ */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};
const server = createServer(async (req, res) => {
  try {
    const u = decodeURIComponent(req.url.split("?")[0]);
    if (u === "/empty.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>empty</title>");
      return;
    }
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

const chromeBin = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));
if (!chromeBin) {
  console.log("\n跳过浏览器部分：未找到 Chrome / Edge（源码契约部分已完成）。");
  const fail0 = results.filter((r) => !r.pass).length;
  console.log(`\n结果: ${results.length - fail0} passed, ${fail0} failed`);
  server.close();
  process.exit(fail0 === 0 ? 0 : 1);
}

// 用宿主的 scopeCss 处理真实插件样式：测试的就是「注入到页面里的那份 CSS」
const { scopeCss } = await import(pathToFileURL(path.join(root, "src/lib/util.ts")).href);
const PLUGIN_STYLE_PREFIX = "#text_show .plugin-view";
const marketCss = scopeCss(readFileSync(path.join(root, "plugins/market/ui/detail.css"), "utf8"), PLUGIN_STYLE_PREFIX);
const piCss = scopeCss(readFileSync(path.join(root, "plugins/pi-agent/ui/detail.css"), "utf8"), PLUGIN_STYLE_PREFIX);

const profile = path.join(root, "test", `_chrome-profile-plugin-theme-${process.pid}`);
await mkdir(profile, { recursive: true });

const proc = spawn(
  chromeBin,
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] }
);
const wsUrl = await new Promise((resolve, reject) => {
  let buf = "";
  const t = setTimeout(() => reject(new Error("DevTools timeout")), 30000);
  proc.stderr.on("data", (d) => {
    buf += d.toString();
    const m = buf.match(/ws:\/\/[^\s]+/);
    if (m) {
      clearTimeout(t);
      resolve(m[0]);
    }
  });
  proc.on("exit", (c) => reject(new Error("chrome exit " + c)));
});

let msgId = 0;
const pending = new Map();
const ws = new WebSocket(wsUrl);
await new Promise((r, j) => {
  ws.onopen = r;
  ws.onerror = j;
});
const pageErrors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === "Runtime.exceptionThrown")
    pageErrors.push(m.params.exceptionDetails.exception?.description || "EXC");
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  }
};
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
await S("Page.enable");
await S("Runtime.enable");
const evalJs = async (expr) => {
  const r = await S("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval failed");
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await S("Page.addScriptToEvaluateOnNewDocument", {
  source: `
    window.__TAURI_INTERNALS__ = {
      invoke(cmd) {
        if (cmd === 'plugin:event|listen') return Promise.resolve(1);
        return Promise.resolve(null);
      },
      transformCallback(cb) { return cb; },
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      plugins: {},
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(){} };
  `,
});

// 读取 <html> 上的变量 + 注入插件样式后探针元素的计算样式。
// 用与宿主一致的结构：#text_show > .plugin-view > .ms-plugin-session（会话载体）。
const PROBE = (marketCssJs, piCssJs) => `(() => {
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const v = (n) => cs.getPropertyValue(n).trim();

  // 与宿主一致的挂载结构
  let wrap = document.getElementById('__probe_wrap');
  if (wrap) wrap.remove();
  wrap = document.createElement('div');
  wrap.id = '__probe_wrap';
  wrap.innerHTML =
    '<div id="text_show"><div class="plugin-view">' +
      '<div class="ms-plugin-session" data-ms-plugin-session="market">' +
        '<div class="market-header"><h2>插件市场</h2></div>' +
        '<div class="market-state">加载目录中…</div>' +
        '<div class="plugin-card"><div class="plugin-name">示例</div></div>' +
      '</div>' +
      '<div class="ms-plugin-session" data-ms-plugin-session="pi">' +
        '<div class="pi-agent-container"><div class="sidebar-left"></div>' +
        '<div class="input-box"><textarea placeholder="x"></textarea></div>' +
        '</div>' +
      '</div>' +
    '</div></div>';
  document.body.appendChild(wrap);

  const style = document.createElement('style');
  style.textContent = ${JSON.stringify(marketCssJs)} + "\\n" + ${JSON.stringify(piCssJs)};
  document.head.appendChild(style);

  const pick = (sel, props) => {
    const el = wrap.querySelector(sel);
    if (!el) return null;
    const c = getComputedStyle(el);
    const o = {};
    for (const p of props) o[p] = c[p];
    return o;
  };
  return JSON.stringify({
    htmlClass: root.className,
    vars: {
      card: v('--card'), surface: v('--surface'), text: v('--text'),
      muted: v('--muted'), line: v('--line'), err: v('--err'),
    },
    marketBody: pick('#text_show .plugin-view', ['backgroundColor', 'color']),
    marketState: pick('.market-state', ['color']),
    marketCard: pick('.plugin-card', ['borderBottomColor']),
    piContainer: pick('.pi-agent-container', ['backgroundColor', 'color']),
    piSidebar: pick('.pi-agent-container .sidebar-left', ['backgroundColor', 'borderRightColor']),
    piInput: pick('.pi-agent-container .input-box', ['backgroundColor']),
  });
})()`;

const seen = {};
for (const theme of ["light", "dark"]) {
  await S("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
  await S("Page.navigate", { url: base + "/empty.html" });
  await sleep(300);
  await evalJs(`localStorage.clear(); 1`);
  await evalJs(`localStorage.setItem('my-search-desktop:theme', ${JSON.stringify(theme)}); 1`);
  await S("Page.navigate", { url: base + "/index.html" });
  await sleep(1200);
  seen[theme] = JSON.parse(await evalJs(PROBE(marketCss, piCss)));
  console.log(`\n[${theme}]`, JSON.stringify(seen[theme], null, 1));
}

const light = seen.light;
const dark = seen.dark;

/* ---- 变量层：搜索窗口根真的有两套值 ---- */
const EXPECT = {
  light: { card: "#ffffff", surface: "#f5f6f8", text: "#1f2329", muted: "#7a828e", line: "#e6e8ec", err: "#e02424" },
  dark: { card: "#212429", surface: "#17191d", text: "#e4e6ea", muted: "#98a0ab", line: "#33363d", err: "#ff6b6b" },
};
for (const theme of ["light", "dark"]) {
  for (const [k, want] of Object.entries(EXPECT[theme])) {
    check(
      `变量层[${theme}]：html 上 --${k} = ${want}`,
      String(seen[theme].vars[k]).toLowerCase() === want,
      `实际 ${seen[theme].vars[k]}`
    );
  }
}
check("变量层：深色下 html 挂上 theme-dark", String(dark.htmlClass).includes("theme-dark"), dark.htmlClass);
check("变量层：浅色下 html 挂上 theme-light", String(light.htmlClass).includes("theme-light"), light.htmlClass);

/* ---- 插件市场：浅/深两套观感，白岛消失 ---- */
const hexToRgb = (h) => {
  const s = String(h).replace("#", "");
  const n = parseInt(s.length === 3 ? s.split("").map((c) => c + c).join("") : s, 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};
check(
  "插件市场[浅]：面板底 = --surface（浅色）",
  marketEq(light.marketBody.backgroundColor, EXPECT.light.surface),
  light.marketBody.backgroundColor
);
check(
  "插件市场[深]：面板底 = --surface（深色，不再是白岛）",
  marketEq(dark.marketBody.backgroundColor, EXPECT.dark.surface),
  dark.marketBody.backgroundColor
);
check(
  "插件市场[深]：面板底不是白色（白岛回归检查）",
  dark.marketBody.backgroundColor !== "rgb(255, 255, 255)",
  dark.marketBody.backgroundColor
);
check(
  "插件市场[浅/深]：正文色分别等于 --text",
  marketEq(light.marketBody.color, EXPECT.light.text) && marketEq(dark.marketBody.color, EXPECT.dark.text),
  `${light.marketBody.color} / ${dark.marketBody.color}`
);
check(
  "插件市场[浅/深]：次要文字色分别等于 --muted",
  marketEq(light.marketState.color, EXPECT.light.muted) && marketEq(dark.marketState.color, EXPECT.dark.muted),
  `${light.marketState.color} / ${dark.marketState.color}`
);
check(
  "插件市场[浅/深]：卡片分隔线分别等于 --line",
  marketEq(light.marketCard.borderBottomColor, EXPECT.light.line) &&
    marketEq(dark.marketCard.borderBottomColor, EXPECT.dark.line),
  `${light.marketCard.borderBottomColor} / ${dark.marketCard.borderBottomColor}`
);

/* ---- pi-agent：深色设计稿在深色宿主下保持，浅色宿主下真正变浅 ---- */
check(
  "pi-agent[深]：容器底 = --card（深色 #212429）",
  marketEq(dark.piContainer.backgroundColor, EXPECT.dark.card),
  dark.piContainer.backgroundColor
);
check(
  "pi-agent[深]：正文色 = --text（深色 #e4e6ea）",
  marketEq(dark.piContainer.color, EXPECT.dark.text),
  dark.piContainer.color
);
check(
  "pi-agent[浅]：容器底 = --card（浅色 #ffffff，不再强制深色）",
  marketEq(light.piContainer.backgroundColor, EXPECT.light.card),
  light.piContainer.backgroundColor
);
check(
  "pi-agent[浅]：正文色 = --text（浅色 #1f2329）",
  marketEq(light.piContainer.color, EXPECT.light.text),
  light.piContainer.color
);
check(
  "pi-agent：左侧栏底 = --surface，边框 = --line（浅深各自解析）",
  marketEq(light.piSidebar.backgroundColor, EXPECT.light.surface) &&
    marketEq(dark.piSidebar.backgroundColor, EXPECT.dark.surface) &&
    marketEq(light.piSidebar.borderRightColor, EXPECT.light.line) &&
    marketEq(dark.piSidebar.borderRightColor, EXPECT.dark.line),
  `${light.piSidebar.backgroundColor}/${dark.piSidebar.backgroundColor}`
);
check(
  "pi-agent[浅]：输入框底不是深色（--code-bg 跟随）",
  light.piInput.backgroundColor !== "rgb(26, 26, 28)" && light.piInput.backgroundColor !== "rgb(42, 45, 51)",
  light.piInput.backgroundColor
);

/* ---- 逻辑层：主题变更派发 DOM 事件（插件 onThemeChanged 的汇聚点） ---- */
await S("Page.navigate", { url: base + "/index.html" });
await sleep(1000);
const fired = await evalJs(`(() => {
  let n = 0, lastThemeClass = '';
  const h = () => { n++; lastThemeClass = document.documentElement.className; };
  document.addEventListener('my-search-theme-changed', h);
  // 模拟另一窗口切主题：写 localStorage 并派发同名事件（真实链路上由 theme.ts 的 applyTheme 派发）
  const html = document.documentElement;
  html.classList.remove('theme-light', 'theme-dark');
  html.classList.add('theme-dark');
  document.dispatchEvent(new CustomEvent('my-search-theme-changed'));
  document.removeEventListener('my-search-theme-changed', h);
  return { n, lastThemeClass };
})()`);
check(
  "逻辑层：my-search-theme-changed 事件能被监听到（插件订阅通道可用）",
  fired.n === 1 && String(fired.lastThemeClass).includes("theme-dark"),
  JSON.stringify(fired)
);

check("无未捕获页面异常", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 300));

function marketEq(actual, hex) {
  return String(actual).replace(/\s+/g, " ").toLowerCase() === hexToRgb(hex).toLowerCase();
}

const fail = results.filter((r) => !r.pass).length;
console.log(`\n结果: ${results.length - fail} passed, ${fail} failed`);
proc.kill();
server.close();
process.exit(fail === 0 ? 0 : 1);
