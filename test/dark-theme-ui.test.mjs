/**
 * 回归测试：深色主题下「呼出的搜索框」不能丢细节（真实浏览器 + 计算样式）。
 *
 * 用户反馈历史：「呼出搜索框那里的深色有点问题，转为深色主题后很多细节就没有了，
 * 如结果列表中 favicon。」
 *
 * 第二轮修复（当前口径）：图标底板**跟随主题**（与插件市场的插件 icon 同口径），
 * 深色下取 `--surface` 往白提亮约 26% 的中性深色 #55575a，浅色下仍是纯白。
 * 底板形状/尺寸/内边距不变，只改配色。
 *
 * 本测试锁死新口径（含量化门槛）：
 *  1. 深色：底板是深色（相对亮度 < 0.30，不再是大片浅色方块）；
 *     且与行底色对比 ≥ 1.8、与内置字形 #231815 对比 ≥ 2.3
 *     （防止又被写成贴近行底色的值——那会让深色字形图标塌陷到不可见）；
 *  2. 深色：输入框文字 / 标题 / 描述 / 废弃项 与底色对比度达标；
 *  3. 浅色：底板仍是纯白（深色规则不得污染浅色）；
 *  4. 无未捕获页面异常。
 *
 * 用法: npm run build && node test/dark-theme-ui.test.mjs
 * 需要本机装有 Chrome / Edge；找不到浏览器时跳过（退出码 0）。
 */
import { createServer } from "http";
import { readFile, mkdir } from "fs/promises";
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
  console.log("跳过：未找到 Chrome / Edge，无法做真实 UI 验证。");
  server.close();
  process.exit(0);
}
const profile = path.join(root, "test", `_chrome-profile-dark-theme-${process.pid}`);
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
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description || "eval failed");
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 注入 Tauri 桥（页面脚本执行前生效）----
await S("Page.addScriptToEvaluateOnNewDocument", {
  source: `
    window.__openedUrls = [];
    window.__TAURI_INTERNALS__ = {
      invoke(cmd, args) {
        if (cmd === 'plugin:event|listen') return Promise.resolve(1);
        if (cmd === 'open_url') { window.__openedUrls.push(args && args.url); return Promise.resolve(null); }
        return Promise.resolve(null);
      },
      transformCallback(cb) { return cb; },
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      plugins: {},
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(){} };
  `,
});

// ---- 种子数据：覆盖列表里四种「要保住细节」的图标来源 ----
// URL 项（真实站点 favicon，多源懒加载）/ 简述项（内置 sketch 图标）/
// 脚本项（内置 script 图标）/ 带快捷链接与关联项（图标 + 右侧链接块）
const SEED = `(() => {
  const items = [
    { title: '纯链接项', desc: '普通 URL 项', resource: 'https://example.com/plain' },
    { title: '文档简述项', desc: '非 URL 简述文本项', type: 'sketch',
      resource: '# 文档标题\\\\n\\\\n这里是文档正文第一段，用于验证详情视图还原。' },
    { title: '脚本应用项', desc: '脚本项', type: 'script', resource: 'demo' },
    { title: '带链接项', desc: '含快捷链接', resource: 'https://example.com/linked',
      links: [{ text: '官网', title: '官网首页', url: 'https://example.com/home' }], vassal: 'v1' },
    { title: '#废弃项', desc: '已过期', resource: 'https://example.com/old/', obsolete: true },
  ];
  items.forEach((it, i) => { it.index = i; });
  const subs = '<tis::https://example.com/test.ms title="测试订阅" />';
  localStorage.setItem('my-search-desktop:SEARCH_DATA_KEY', JSON.stringify({
    data: items, expire: Date.now() + 12 * 3600 * 1000, failedUrls: [],
  }));
  localStorage.setItem('my-search-desktop:SUBSCRIBES', JSON.stringify(subs));
  localStorage.setItem('my-search-desktop:subscribes', JSON.stringify(subs));
  localStorage.setItem(
    'my-search-desktop:SUBSCRIBE_FINGERPRINT_CACHE_KEY',
    JSON.stringify('https://example.com/test.ms|测试订阅||')
  );
  return items.length;
})()`;

// ---- 颜色工具：WCAG 相对亮度 / 对比度（rgba 先按底色合成，和肉眼看到的一致）----
const parseColor = (s) => {
  const str = String(s).trim();
  const hex = str.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const m = str.match(/rgba?\(([^)]+)\)/);
  if (!m) throw new Error("无法解析颜色: " + s);
  const v = m[1].split(",").map((x) => parseFloat(x));
  return { r: v[0], g: v[1], b: v[2], a: v[3] === undefined ? 1 : v[3] };
};
const channel = (c) => {
  const x = c / 255;
  return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
};
const luminance = (color) => {
  const c = parseColor(color);
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
};
const contrast = (a, b) => {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
/** 半透明前景叠到底色上的实际颜色（如输入框文字的 rgba(…, .87)） */
const over = (fg, bg) => {
  const f = parseColor(fg);
  const b = parseColor(bg);
  const mix = (x, y) => Math.round(x * f.a + y * (1 - f.a));
  return `rgb(${mix(f.r, b.r)},${mix(f.g, b.g)},${mix(f.b, b.b)})`;
};

// ---- 采集探针：读回搜索窗口关键节点的计算样式 ----
// 占位图需内联进探针（页面里拿不到模块常量）
const { ICON_LOADING_PLACEHOLDER } = await import("../src/lib/assets.ts");
const PROBE = `(() => {
  const ICON_LOADING_PLACEHOLDER = ${JSON.stringify(ICON_LOADING_PLACEHOLDER)};
  const q = (s) => document.querySelector(s);
  const css = (s) => {
    const el = q(s);
    if (!el) return null;
    const c = getComputedStyle(el);
    return { bg: c.backgroundColor, color: c.color, border: c.borderTopColor, shadow: c.boxShadow, filter: c.filter };
  };
  // 「加载中」占位：把一条结果项的图标强制成占位态，量它的底板与滤镜
  // 「加载中」占位（DOM 侧）：把真实结果项临时切到占位图，量底板与滤镜。
  // 占位图**自身**的深色适配能力在 DOM 外单独校验（见下方 asset 断言）——
  // 页面里改 img.src 会被框架的响应式覆盖，不可靠。
  const loadingProbe = (() => {
    const img = q('#matchResult .searchItem');
    if (!img) return null;
    const c = getComputedStyle(img);
    return { bg: c.backgroundColor, filter: c.filter };
  })();
  return JSON.stringify({
    htmlClass: document.documentElement.className,
    rows: document.querySelectorAll('#matchItems li').length,
    icons: document.querySelectorAll('#matchResult img').length,
    loading: loadingProbe,
    box: css('#my_search_box'),
    input: css('#my_search_input'),
    plate: css('#matchResult img'),
    title: css('#matchResult .item_title'),
    desc: css('#matchResult .item_desc'),
    obsolete: css('#matchResult .obsolete'),
    active: css('#matchResult li.active'),
    row: css('#matchResult li'),
    related: css('.related-links > a'),
    vassal: css('.resultItem .vassal'),
  });
})()`;

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// ---- 两个主题各渲染一次 ----
const seen = {};
for (const theme of ["light", "dark"]) {
  await S("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: theme }],
  });
  await S("Page.navigate", { url: base + "/empty.html" });
  await sleep(300);
  await evalJs(`localStorage.clear(); 1`);
  await evalJs(`localStorage.setItem('my-search-desktop:theme', ${JSON.stringify(theme)}); 1`);
  await evalJs(SEED);
  await S("Page.navigate", { url: base + "/index.html" });
  await sleep(1200);
  await evalJs(`(() => {
    const input = document.getElementById('my_search_input');
    input.value = '项';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(900);
  // 键盘选中第一行：读出「选中行底色」，同时确认高亮用的是同一套配色
  await evalJs(`document.getElementById('my_search_input')
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
  await sleep(250);
  seen[theme] = JSON.parse(await evalJs(PROBE));
  console.log(`\n[${theme}]`, JSON.stringify(seen[theme], null, 1));
}

const light = seen.light;
const dark = seen.dark;
const darkBoxBg = dark.box.bg;

// ---- 1. 两次渲染都真的出了结果，否则下面的样式断言没有意义 ----
check("浅色：5 条结果全部渲染", light.rows === 5, `rows=${light.rows}`);
check("深色：5 条结果全部渲染", dark.rows === 5, `rows=${dark.rows}`);
check("深色：每行都带图标（favicon / 内置图标）", dark.icons === 5, `icons=${dark.icons}`);
check("深色：html 挂上 theme-dark", String(dark.htmlClass).includes("theme-dark"), dark.htmlClass);

// ---- 2. 深色下图标底板：跟随主题（与插件市场 icon 同口径）----
// 历史：曾跟随行底色取 #1e2126 → 与深色字形对比 1.07:1，图标集体消失；
// 后修为固定浅色 #e8eaed；现按产品要求改为跟随主题的中性深色 #55575a。
// 新口径锁三件事：① 是深色（跟主题，不再是浅色方块）；② 与行底可区分；
// ③ 与深色字形对比不塌陷到不可见（守住 ≥ 2.3，防止又被写成贴近行底的值）。
const darkPlate = dark.plate.bg;
const darkPlateLum = luminance(darkPlate);
check(
  "深色：图标底板跟随主题（是深色，相对亮度 < 0.30，不再是浅色方块）",
  darkPlateLum < 0.3,
  `plate=${darkPlate} lum=${darkPlateLum.toFixed(3)}`
);
check(
  "深色：底板 vs 行底色对比度 ≥ 1.8（底板不能和深色行糊在一起）",
  contrast(darkPlate, darkBoxBg) >= 1.8,
  `contrast=${contrast(darkPlate, darkBoxBg).toFixed(2)} (${darkPlate} / ${darkBoxBg})`
);
// 内置 sketch / script 图标字形为 #231815。跟随主题后对比必然下降，
// 但不能掉到「看不见」——曾经贴行底色的 1.07:1 就是这么翻车的。
const darkGlyph = contrast(darkPlate, "#231815");
check(
  "深色：底板 vs 内置深色字形(#231815) 对比度 ≥ 2.3（防再次塌陷到不可见）",
  darkGlyph >= 2.3,
  `contrast=${darkGlyph.toFixed(2)}`
);
check(
  "深色：底板比行底色亮（底板方向没写反）",
  darkPlate !== darkBoxBg && darkPlateLum > luminance(darkBoxBg),
  `plate=${darkPlate} box=${darkBoxBg}`
);

// ---- 3. 浅色主题不得被深色规则污染 ----
check("浅色：图标底板仍是纯白", light.plate.bg === "rgb(255, 255, 255)", `plate=${light.plate.bg}`);

// ---- 2b. 「加载中」占位图：不得是白块，且深浅两主题都清晰 ----
// 旧实现是一张自带白底的 JPEG（jpeg 无透明通道），深色下显示成刺眼的白方块。
// 现改为透明底 SVG，且**由 SVG 内部的 @media (prefers-color-scheme: dark)
// 自动换一套浅色档配色**——不用宿主 CSS 的 filter:invert()，因为 invert 会把
// 「亮头」翻成暗色，深色底板上反而更糊（实测最弱仅 1.14:1）。
//
// 这里锁三点：
//   ① 深色下占位图底板不是亮色（白块回归检查）；
//   ② 占位图**没有**被宿主 CSS 反相（反相方案已废弃，避免后人加回来）；
//   ③ 占位图自身的 SVG 里带 dark 媒体查询（换色能力在，深底上才看得见）。
const darkLoading = dark.loading;
const lightLoading = light.loading;
check(
  "深色：「加载中」占位底板不是白色（白块回归检查）",
  !!darkLoading && luminance(darkLoading.bg) < 0.3,
  `bg=${darkLoading && darkLoading.bg}`
);
check(
  "「加载中」占位图未被宿主 CSS 反相（反相方案已废弃）",
  !!darkLoading && !/invert\(1\)/.test(darkLoading.filter) &&
    !!lightLoading && !/invert\(1\)/.test(lightLoading.filter),
  `dark=${darkLoading && darkLoading.filter} light=${lightLoading && lightLoading.filter}`
);
// 占位图自身的深色适配：直接校验资源内容（不经过 DOM，避免被框架覆盖）
const loadingSvg = (() => {
  try {
    const b64 = ICON_LOADING_PLACEHOLDER.replace(/^data:image\/svg\+xml;base64,/, "");
    return Buffer.from(b64, "base64").toString("utf8");
  } catch { return ""; }
})();
check(
  "「加载中」占位图自带深色适配（SVG 内含 prefers-color-scheme: dark）",
  /prefers-color-scheme\s*:\s*dark\s*[){]/.test(loadingSvg),
  `svg=${loadingSvg.length} bytes`
);
check(
  "「加载中」占位图是 12 条辐条的转圈（几何未跑偏）",
  (loadingSvg.match(/<use /g) || []).length === 12,
  `spokes=${(loadingSvg.match(/<use /g) || []).length}`
);
check(
  "「加载中」占位图是透明底（不含整块白底 fill）",
  !/fill="#fff"{0,1}\s*\/>\s*<\/svg>/.test(loadingSvg) && !loadingSvg.includes('rect width="100"'),
  "无白底矩形"
);
check("浅色：搜索框底色仍是纯白", light.box.bg === "rgb(255, 255, 255)", `box=${light.box.bg}`);

// ---- 4. 深色下其余细节的可见度（文字 / 选中行 / 边框 / 链接 / 关联图标）----
const inputInk = over(dark.input.color, dark.input.bg);
const inputContrast = contrast(inputInk, dark.input.bg);
check("深色：输入文字与输入框底色对比度 ≥ 7", inputContrast >= 7, `contrast=${inputContrast.toFixed(2)}`);

const titleContrast = contrast(dark.title.color, darkBoxBg);
check("深色：结果标题与底色对比度 ≥ 4.5", titleContrast >= 4.5, `contrast=${titleContrast.toFixed(2)} (${dark.title.color})`);

const descContrast = contrast(dark.desc.color, darkBoxBg);
check("深色：结果描述与底色对比度 ≥ 4.5", descContrast >= 4.5, `contrast=${descContrast.toFixed(2)} (${dark.desc.color})`);

check(
  "深色：废弃项(#废弃项)可读（对比度 ≥ 4.5）",
  dark.obsolete != null && contrast(dark.obsolete.color, darkBoxBg) >= 4.5,
  dark.obsolete ? `contrast=${contrast(dark.obsolete.color, darkBoxBg).toFixed(2)} (${dark.obsolete.color})` : "未渲染 .obsolete"
);

check(
  "深色：键盘选中行与结果底色可区分（对比度 ≥ 1.2）",
  dark.active != null && contrast(dark.active.bg, darkBoxBg) >= 1.2,
  dark.active ? `contrast=${contrast(dark.active.bg, darkBoxBg).toFixed(2)} (${dark.active.bg})` : "无选中行"
);

const borderContrast = contrast(dark.box.border, darkBoxBg);
check("深色：搜索框边框仍可见（对比度 ≥ 1.25）", borderContrast >= 1.25, `contrast=${borderContrast.toFixed(2)} (${dark.box.border})`);

check(
  "深色：快捷链接文字与链接底色对比度 ≥ 4.5",
  dark.related != null && contrast(dark.related.color, dark.related.bg) >= 4.5,
  dark.related ? `contrast=${contrast(dark.related.color, dark.related.bg).toFixed(2)}` : "无快捷链接"
);

check(
  "深色：关联(vassal)图标与底色对比度 ≥ 3",
  dark.vassal != null && contrast(dark.vassal.color, darkBoxBg) >= 3,
  dark.vassal ? `contrast=${contrast(dark.vassal.color, darkBoxBg).toFixed(2)}` : "无关联图标"
);

// ---- 5. 无未捕获页面异常 ----
check("无未捕获页面异常", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 300));

const fail = results.filter((r) => !r.pass).length;
console.log(`\n结果: ${results.length - fail} passed, ${fail} failed`);
proc.kill();
server.close();
process.exit(fail === 0 ? 0 : 1);
