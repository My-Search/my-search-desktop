/**
 * 临时诊断：深色主题下「favicon 底板用哪一档灰白」的视觉/对比度对比。
 *
 * 对同一份结果列表、同一批图标（真实站点 favicon + 内置 sketch/script +
 * 加载中占位 + 加载失败占位）分别套用不同底板颜色，截取图标列并放大 3 倍，
 * 同时算出各档位的 WCAG 对比度，最后拼成一张对比图。
 *
 * 用法: npm run build && node test/_diag-favicon-plate.mjs
 * 产出（均在 .gitignore 覆盖范围内）：test/_shot-plate-*.png
 */
import { createServer } from "http";
import { readFile, mkdir, writeFile } from "fs/promises";
import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PNG } from "pngjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
if (!existsSync(path.join(dist, "index.html"))) {
  console.error("请先 npm run build");
  process.exit(1);
}

// ---- 待比较的档位（名字 → 底板颜色）----
const VARIANTS = [
  { key: "white", label: "纯白 #ffffff", css: "#ffffff" },
  { key: "e8eaed", label: "灰白 #e8eaed（当前）", css: "#e8eaed" },
  { key: "d5d9df", label: "中灰白 #d5d9df", css: "#d5d9df" },
  { key: "c3c8cf", label: "偏灰 #c3c8cf", css: "#c3c8cf" },
];
/** 行底色（深色主题 #my_search_box） */
const ROW_BG = "#17191d";
/** 需要保细节的两类墨色：内置深色字形 / 灰色占位 */
const INKS = [
  { name: "#231815 内置 sketch/script", hex: "#231815" },
  { name: "#1f1f1f 站点深色图标", hex: "#1f1f1f" },
  { name: "#707070 加载中/失败占位", hex: "#707070" },
];

// ---- WCAG 相对亮度 / 对比度 ----
const parseColor = (s) => {
  const str = String(s).trim();
  const hex = str.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  const m = str.match(/rgba?\(([^)]+)\)/);
  const v = m[1].split(",").map((x) => parseFloat(x));
  return { r: v[0], g: v[1], b: v[2] };
};
const channel = (c) => {
  const x = c / 255;
  return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
};
const luminance = (c) => {
  const o = parseColor(c);
  return 0.2126 * channel(o.r) + 0.7152 * channel(o.g) + 0.0722 * channel(o.b);
};
const contrast = (a, b) => {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

console.log("底板档位对比度（WCAG）：");
for (const v of VARIANTS) {
  const parts = INKS.map((i) => `${i.hex}→${contrast(v.css, i.hex).toFixed(2)}`);
  parts.push(`行底→${contrast(v.css, ROW_BG).toFixed(2)}`);
  console.log(`  ${v.label.padEnd(22)} ${parts.join("  ")}`);
}

// ================= 真实渲染 =================
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
  console.log("跳过渲染：未找到 Chrome / Edge。");
  server.close();
  process.exit(0);
}
const profile = path.join(root, "test", `_chrome-profile-plate-${process.pid}`);
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
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
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
      invoke() { return Promise.resolve(null); },
      transformCallback(cb) { return cb; },
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      plugins: {},
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(){} };
  `,
});

/** 典型站点图标：深色字形 + 透明底 */
const DARK_FAVICON =
  "data:image/svg+xml;base64," +
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M16 3 4 9v14l12 6 12-6V9z" fill="#1f1f1f"/><circle cx="16" cy="16" r="4" fill="#ffffff"/></svg>`,
    "utf8"
  ).toString("base64");

/** 内置图标（sketch/script/加载中/加载失败）直接从源码抠出来用 */
const assetsSrc = await readFile(path.join(root, "src", "lib", "assets.ts"), "utf8");
const pickAsset = (name) => {
  const m = assetsSrc.match(new RegExp(`export const ${name} = "(data:[^"]+)"`));
  return m ? m[1] : "";
};
const ICON_LOADING = pickAsset("ICON_LOADING_PLACEHOLDER");
const ICON_ERROR = pickAsset("LOAD_ERROR_ICON");

const SEED = `(() => {
  const items = [
    { title: '纯链接项', desc: '普通 URL 项', resource: 'https://example.com/plain' },
    { title: '文档简述项', desc: '非 URL 简述文本项', type: 'sketch', resource: '# 文档' },
    { title: '脚本应用项', desc: '脚本项', type: 'script', resource: 'demo' },
    { title: '带链接项', desc: '含快捷链接', resource: 'https://example.com/linked',
      links: [{ text: '官网', title: '官网首页', url: 'https://example.com/home' }], vassal: 'v1' },
    { title: '#废弃项', desc: '已过期', resource: 'https://example.com/old/' },
  ];
  items.forEach((it, i) => { it.index = i; });
  const subs = '<tis::https://example.com/test.ms title="测试订阅" />';
  localStorage.setItem('my-search-desktop:SEARCH_DATA_KEY', JSON.stringify({
    data: items, expire: Date.now() + 12 * 3600 * 1000, failedUrls: [],
  }));
  localStorage.setItem('my-search-desktop:subscribes', JSON.stringify(subs));
  localStorage.setItem(
    'my-search-desktop:SUBSCRIBE_FINGERPRINT_CACHE_KEY',
    JSON.stringify('https://example.com/test.ms|测试订阅||')
  );
  return items.length;
})()`;

const strips = [];
for (const v of VARIANTS) {
  await S("Emulation.setDeviceMetricsOverride", {
    width: 720,
    height: 420,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await S("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await S("Page.navigate", { url: base + "/empty.html" });
  await sleep(250);
  await evalJs(`localStorage.clear(); 1`);
  await evalJs(`localStorage.setItem('my-search-desktop:theme', ${JSON.stringify("dark")}); 1`);
  await evalJs(SEED);
  await S("Page.navigate", { url: base + "/index.html" });
  await sleep(1300);
  await evalJs(`(() => {
    const input = document.getElementById('my_search_input');
    input.value = '项';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(900);
  // 前 3 行换成「深色站点图标 / 加载中占位 / 加载失败占位」，其余保留内置 sketch/script 图标
  await evalJs(`(() => {
    const imgs = [...document.querySelectorAll('#matchResult img')];
    const set = [${JSON.stringify(DARK_FAVICON)}, ${JSON.stringify(ICON_LOADING)}, ${JSON.stringify(ICON_ERROR)}];
    imgs.forEach((im, i) => { if (set[i]) im.src = set[i]; });
    return imgs.length;
  })()`);
  // 本档位底板的覆盖样式
  await evalJs(`(() => {
    const s = document.createElement('style');
    s.textContent = 'html.theme-dark #matchResult img{background:${v.css} !important;}';
    document.head.appendChild(s);
    return true;
  })()`);
  await sleep(350);

  // 取图标列的裁剪框（按 DOM 实测，避免写死坐标）
  const clip = await evalJs(`(() => {
    const icons = [...document.querySelectorAll('#matchResult .item-icon')].map((el) => el.getBoundingClientRect());
    const left = Math.min(...icons.map((r) => r.left)) - 10;
    const right = Math.max(...icons.map((r) => r.right)) + 10;
    const top = Math.min(...icons.map((r) => r.top)) - 8;
    const bottom = Math.max(...icons.map((r) => r.bottom)) + 8;
    return { x: left, y: top, width: right - left, height: bottom - top, scale: 3 };
  })()`);
  const shot = await S("Page.captureScreenshot", { format: "png", clip });
  const file = path.join(root, "test", `_shot-plate-${v.key}.png`);
  await writeFile(file, Buffer.from(shot.data, "base64"));
  strips.push({ ...v, file });
  console.log(`渲染 ${v.label} → ${path.basename(file)}`);
}

// ---- 拼成一张对比图（各档位并排，中间留 6px 深色分隔）----
const images = await Promise.all(strips.map(async (s) => PNG.sync.read(await readFile(s.file))));
const gap = 6;
const W = images.reduce((sum, im) => sum + im.width, 0) + gap * (images.length - 1);
const H = Math.max(...images.map((im) => im.height));
const out = new PNG({ width: W, height: H });
for (let i = 0; i < W * H; i++) {
  out.data[i * 4] = 40;
  out.data[i * 4 + 1] = 44;
  out.data[i * 4 + 2] = 50;
  out.data[i * 4 + 3] = 255;
}
let x0 = 0;
for (const im of images) {
  for (let y = 0; y < im.height; y++) {
    for (let x = 0; x < im.width; x++) {
      const src = (y * im.width + x) * 4;
      const dst = (y * W + (x0 + x)) * 4;
      out.data[dst] = im.data[src];
      out.data[dst + 1] = im.data[src + 1];
      out.data[dst + 2] = im.data[src + 2];
      out.data[dst + 3] = im.data[src + 3];
    }
  }
  x0 += im.width + gap;
}
const compareFile = path.join(root, "test", "_shot-plate-compare.png");
await writeFile(compareFile, PNG.sync.write(out));
console.log("对比图:", compareFile, `(${strips.map((s) => s.key).join(" | ")})`);

proc.kill();
server.close();
