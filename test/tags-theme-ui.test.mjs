/**
 * 回归测试：设置窗口「关注标签」面板必须跟随**用户选择的主题**，
 * 而原生复选框必须跟随主题的 color-scheme（不能跟随系统偏好）。
 *
 * 用户反馈：「设置中当主题为浅色时，关注标签主题不兼容」。
 *
 * 根因：`color-scheme` 一直是 `light dark`（config.html 的
 * <meta name="color-scheme"> + `html.ms-config-root { color-scheme: light dark }`），
 * 而原生复选框（「关注标签」是设置窗口里唯一的原生可见复选框）在 WebView2/Chromium
 * 里按键**系统**偏好绘制：
 *  - 系统深色 + 用户强制浅色 → 浅色 chip（#fafbfc）里的未勾选框被画成深灰实心方块
 *    （采样 rgb(59,59,59)），看起来像「已勾选」，与浅色卡片强烈冲突；
 *  - 系统浅色 + 用户强制深色 → 深色 chip（#1e2126）里出现刺眼的白方块。
 *
 * 本测试把「原生控件配色跟随强制主题」锁死：对 系统偏好 × 用户主题 的四种组合，
 * 断言 html 主题类、计算出的 color-scheme、以及**真实渲染像素**（用 pngjs 采样
 * 复选框中心区域）都符合用户选择的主题。
 *
 * 用法：npm run build && node test/tags-theme-ui.test.mjs
 * 产出：test/_shot-tags-theme-<combo>.png（四种组合，供人工核对）
 * 需要本机装有 Chrome / Edge；找不到浏览器时跳过（退出码 0）。
 */
import { createServer } from "http";
import { readFile, mkdir, rm, writeFile } from "fs/promises";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { PNG } from "pngjs";
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

const bin = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].find((p) => existsSync(p));
if (!bin) {
  console.log("跳过：未找到 Chrome / Edge，无法做真实 UI 验证。");
  server.close();
  process.exit(0);
}

const userDir = path.join(root, "test", `_chrome-profile-tags-theme-${process.pid}`);
await rm(userDir, { recursive: true, force: true });
await mkdir(userDir, { recursive: true });
const chrome = spawn(
  bin,
  ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
   "--remote-debugging-port=0", `--user-data-dir=${userDir}`, "--window-size=880,620", "about:blank"],
  { stdio: ["ignore", "ignore", "pipe"] }
);
const wsUrl = await new Promise((resolve, reject) => {
  let buf = "";
  const t = setTimeout(() => reject(new Error("浏览器启动超时")), 30000);
  chrome.stderr.on("data", (d) => {
    buf += d.toString();
    const m = buf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (m) { clearTimeout(t); resolve(m[1]); }
  });
  chrome.on("exit", (c) => reject(new Error("chrome exit " + c)));
});
const ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));
let msgId = 0;
const pending = new Map();
const pageErrors = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === "Runtime.exceptionThrown") {
    pageErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  }
};
const S = (method, params = {}, sessionId) =>
  new Promise((resolve) => { const mid = ++msgId; pending.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params, sessionId })); });

const { result: targets } = await S("Target.getTargets");
const pageTarget = targets.targetInfos.find((t) => t.type === "page");
const { result: { sessionId } } = await S("Target.attachToTarget", { targetId: pageTarget.targetId, flatten: true });
await S("Runtime.enable", {}, sessionId);
await S("Page.enable", {}, sessionId);
const evalJs = async (expr) => {
  const r = await S("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("PASS ", name, extra ? `— ${extra}` : ""); }
  else { fail++; console.log("FAIL ", name, extra ? `— ${extra}` : ""); }
};

// ---- 颜色工具（与 dark-theme-ui.test.mjs 保持一致的口径）----
const srgb = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => srgb(v / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

await S("Page.addScriptToEvaluateOnNewDocument", {
  source: `
    window.__TAURI_INTERNALS__ = {
      invoke(cmd) {
        if (cmd === 'get_shortcut_bindings') return Promise.resolve([{ shortcut: 'ctrl+alt+s', action: 'toggle-window', target: null }]);
        if (cmd === 'get_default_subscribe_text') return Promise.resolve('');
        if (cmd === 'plugin_list') return Promise.resolve({ plugins: [], items: [] });
        return Promise.resolve(null);
      },
      transformCallback(cb) { return cb; },
      metadata: { currentWindow: { label: 'config' }, currentWebview: { label: 'config' } },
      plugins: {},
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(){} };
  `,
}, sessionId);

/** 标签统计（PanelTags 直接读缓存渲染） */
const TAGS = [
  { name: "AI", count: 42 },
  { name: "开发工具", count: 31 },
  { name: "设计灵感", count: 1234 },
  { name: "影视", count: 7 },
];
/** 不关注列表：AI / 影视 未勾选（其余勾选） */
const UNFOLLOW = ["AI", "影视"];

/** 系统偏好 × 用户强制主题：四种组合都要成立 */
const COMBOS = [
  { label: "sys-light__theme-light", system: "light", theme: "light" },
  { label: "sys-dark__theme-light", system: "dark", theme: "light" },
  { label: "sys-light__theme-dark", system: "light", theme: "dark" },
  { label: "sys-dark__theme-dark", system: "dark", theme: "dark" },
];

for (const { label, system, theme } of COMBOS) {
  const expectDark = theme === "dark";
  await S("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: system }],
  }, sessionId);
  await S("Page.navigate", { url: base + "/config.html" }, sessionId);
  await sleep(1000);
  // 主题由 storageSet 以 JSON 写入（"light" 带引号），这里必须同样编码，
  // 否则 getTheme() 的 JSON.parse 失败会回退成 system（曾经因此掩盖了本 bug）
  await evalJs(`(() => {
    localStorage.setItem('my-search-desktop:theme', ${JSON.stringify(JSON.stringify(theme))});
    localStorage.setItem('my-search-desktop:DATA_ITEM_TAGS_CACHE_KEY', ${JSON.stringify(JSON.stringify(TAGS))});
    localStorage.setItem('my-search-desktop:USER_UNFOLLOW_LIST_CACHE_KEY', ${JSON.stringify(JSON.stringify(UNFOLLOW))});
    return true;
  })()`);
  await S("Page.reload", {}, sessionId);
  await sleep(1600);
  await evalJs(`document.querySelector('.cfg-nav .nav-item[data-pane="tags"]').click()`);
  await sleep(800);



  const data = await evalJs(`(() => {
    const htmlCs = getComputedStyle(document.documentElement);
    const card = document.querySelector('.page.tags .cfg-card');
    const rect = (el) => { const b = el.getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
    const chips = [...document.querySelectorAll('.page.tags .tag-chip')].map((el) => {
      const cs = getComputedStyle(el);
      const input = el.querySelector('input');
      const cb = rect(input);
      return {
        name: el.title,
        on: el.classList.contains('on'),
        checked: input.checked,
        bg: cs.backgroundColor,
        color: cs.color,
        countColor: getComputedStyle(el.querySelector('.tag-count')).color,
        // 复选框中心（未勾选=原生底 / 勾选=accent 色块上的对勾）
        cx: Math.round(cb.x + cb.w / 2),
        cy: Math.round(cb.y + cb.h / 2),
      };
    });
    return {
      htmlClass: document.documentElement.className,
      colorScheme: htmlCs.colorScheme,
      cardBg: getComputedStyle(card).backgroundColor,
      chipCount: chips.length,
      chips,
    };
  })()`);

  const shot = await S("Page.captureScreenshot", { format: "png" }, sessionId);
  const buf = Buffer.from(shot.result.data, "base64");
  await writeFile(path.join(root, "test", `_shot-tags-theme-${label}.png`), buf);
  const png = PNG.sync.read(buf);
  /** 取复选框中心 3x3 区域的真实渲染像素（不依赖计算样式） */
  const sample = (chip) => {
    const out = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const i = (png.width * (chip.cy + dy) + (chip.cx + dx)) << 2;
        out.push([png.data[i], png.data[i + 1], png.data[i + 2]]);
      }
    }
    return out;
  };
  const avgLum = (pxs) => pxs.reduce((s, p) => s + luminance(p), 0) / pxs.length;
  const rgbOf = (css) => css.match(/\d+/g).map(Number);
  const offChips = data.chips.filter((c) => !c.checked);
  const onChips = data.chips.filter((c) => c.checked);
  const offLums = offChips.map((c) => avgLum(sample(c)));
  const onMaxLums = onChips.map((c) => Math.max(...sample(c).map(luminance)));

  console.log(`\n---- [${label}] 系统=${system} 用户主题=${theme} ----`);
  // 1. 主题类与 color-scheme 必须跟随用户选择（而不是系统偏好）
  check(`[${label}] html 主题类跟随用户选择`, data.htmlClass.includes(expectDark ? "theme-dark" : "theme-light"), data.htmlClass);
  check(`[${label}] color-scheme 跟随用户选择`, data.colorScheme === theme, `color-scheme=${data.colorScheme}`);
  // 2. 卡片底色跟随主题
  const cardLum = luminance(rgbOf(data.cardBg));
  check(`[${label}] 卡片底色跟随主题`, expectDark ? cardLum < 0.1 : cardLum > 0.8, `card=${data.cardBg}`);
  // 3. 4 个 chip 都渲染出来（否则下面的断言没有意义）
  check(`[${label}] 4 个标签 chip 全部渲染`, data.chipCount === 4 && offChips.length === 2 && onChips.length === 2,
    `chips=${data.chipCount} unchecked=${offChips.length} checked=${onChips.length}`);
  // 4. 核心回归：未勾选的复选框必须按主题的 color-scheme 绘制
  check(
    `[${label}] 未勾选复选框按主题绘制（浅色主题=浅色方块 / 深色主题=深色方块）`,
    expectDark ? offLums.every((l) => l < 0.2) : offLums.every((l) => l > 0.6),
    `luminance=${offLums.map((l) => l.toFixed(3)).join(", ")}`
  );
  // 5. 勾选态的复选框一定有浅色对勾（两个主题下都要看得见）
  check(`[${label}] 勾选态复选框的浅色对勾可见`, onMaxLums.every((l) => l > 0.6),
    `maxLuminance=${onMaxLums.map((l) => l.toFixed(3)).join(", ")}`);
  // 6. chip 文字对比度（已选是深底白字 / 未选是灰字浅底，都要达标）
  const onContrast = onChips.map((c) => contrast(rgbOf(c.color), rgbOf(c.bg)));
  check(`[${label}] 已选 chip 文字/底色对比度 ≥ 4.5`, onContrast.every((c) => c >= 4.5),
    `contrast=${onContrast.map((c) => c.toFixed(2)).join(", ")}`);
  const offContrast = offChips.map((c) => contrast(rgbOf(c.color), rgbOf(c.bg)));
  check(`[${label}] 未选 chip 文字/底色对比度 ≥ 4.5`, offContrast.every((c) => c >= 4.5),
    `contrast=${offContrast.map((c) => c.toFixed(2)).join(", ")}`);
}

check("无未捕获页面异常", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 300));

console.log(`\n结果: ${pass} passed, ${fail} failed`);
ws.close();
server.close();
chrome.kill();
// 等 Chrome 真正退出后再删临时 profile，否则 Crashpad 仍在写文件会 EBUSY
await new Promise((resolve) => {
  if (chrome.exitCode !== null) return resolve();
  chrome.once("exit", resolve);
  setTimeout(resolve, 5000);
});
for (let i = 0; i < 10; i++) {
  try { await rm(userDir, { recursive: true, force: true }); break; }
  catch { await sleep(300); }
}
process.exit(fail === 0 ? 0 : 1);
