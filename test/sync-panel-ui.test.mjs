/**
 * 设置窗口「备份与同步」面板：真实浏览器布局验证（CDP + Chrome headless）。
 *
 * 用法：npm run build && node test/sync-panel-ui.test.mjs
 * 产出：test/_shot-sync-panel-<theme>.png（亮暗两套，供人工核对）
 *
 * 覆盖的用户反馈：
 * 1. 「保存到…」按钮前的上传图标多余 → 按钮内不应再有 <svg>
 * 2. 三个导出按钮竖排换行 → 必须并排同一行（top 相同），窄窗口（600px）也不换行
 * 3. WebDAV 输入框是浏览器原生控件（系统灰底/方形）→ 必须走主题样式：
 *    圆角、主题描边、与卡片内容等宽对齐；select 去掉原生箭头
 * 4. 面板里引用了未定义/写错的类名与 CSS 变量（btn-primary / --bg-secondary /
 *    --error）→ 会在下面通过计算样式断言回归
 *
 * 需要本机装有 Chrome / Edge；找不到浏览器时跳过（退出码 0）。
 */
import { createServer } from "http";
import { readFile, rm, writeFile } from "fs/promises";
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

const userDir = path.join(root, "test", "_chrome-profile-shot-sync");
await rm(userDir, { recursive: true, force: true });
const chrome = spawn(
  bin,
  ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
   "--remote-debugging-port=0", `--user-data-dir=${userDir}`, "--window-size=880,600", "about:blank"],
  { stdio: ["ignore", "ignore", "pipe"] }
);
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
const S = (method, params = {}, sessionId) =>
  new Promise((resolve) => { const mid = ++id; pending.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params, sessionId })); });

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

await S("Page.addScriptToEvaluateOnNewDocument", {
  source: `
    window.__TAURI_INTERNALS__ = {
      invoke(cmd, args) {
        if (cmd === 'sync_get_config') return Promise.resolve({
          enabled: true, webdavUrl: 'https://dav.jianguoyun.com/dav/', webdavUser: '',
          remoteFile: 'my-search-backup.msbackup', conflict: 'newer',
          autoOnChange: true, intervalMinutes: 30, hasPassword: false,
        });
        if (cmd === 'sync_set_config') return Promise.resolve({
          enabled: true, webdavUrl: 'https://dav.jianguoyun.com/dav/', webdavUser: '',
          remoteFile: 'my-search-backup.msbackup', conflict: 'newer',
          autoOnChange: true, intervalMinutes: 30, hasPassword: false,
        });
        if (cmd === 'get_shortcut_bindings') return Promise.resolve([{ shortcut: 'ctrl+alt+s', action: 'toggle-window', target: null }]);
        if (cmd === 'get_default_subscribe_text') return Promise.resolve('');
        return Promise.resolve(null);
      },
      transformCallback(cb) { return cb; },
      metadata: { currentWindow: { label: 'config' }, currentWebview: { label: 'config' } },
      plugins: {},
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(){} };
  `,
}, sessionId);

for (const theme of ["dark", "light"]) {
  await S("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: theme }],
  }, sessionId);
  await S("Page.navigate", { url: base + "/config.html" }, sessionId);
  await sleep(1500);
  await evalJs(`document.querySelector('.cfg-nav .nav-item[data-pane="sync"]').click()`);
  await sleep(900);

  const geo = await evalJs(`(() => {
    const pane = document.querySelector('.page.sync .sync-tab-pane');
    const btns = [...pane.querySelectorAll('.sync-actions-row .cfg-btn')];
    const rows = [...document.querySelectorAll('.page.sync .cfg-row')];
    const inputs = rows.map(r => {
      const el = r.querySelector('.cfg-input, .cfg-select');
      if (!el) return null;
      const b = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { tag: el.tagName, w: Math.round(b.width), h: Math.round(b.height),
               x: Math.round(b.x), radius: cs.borderRadius, bg: cs.backgroundColor,
               border: cs.borderTopColor, appearance: cs.appearance,
               fontFamily: cs.fontFamily, fontSize: cs.fontSize };
    });
    const primary = pane.querySelector('.sync-actions-row .cfg-btn.primary');
    const card = document.querySelector('.page.sync .cfg-card:not(.sync-tab-pane)');
    const cr = card.getBoundingClientRect();
    const cs = getComputedStyle(card);
    const body = document.querySelector('.cfg-body');
    return {
      btnTops: btns.map(b => Math.round(b.getBoundingClientRect().top)),
      btnRects: btns.map(b => { const r = b.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width) }; }),
      firstBtnHasSvg: !!btns[0]?.querySelector('svg'),
      primaryBg: primary ? getComputedStyle(primary).backgroundColor : null,
      inputs,
      // 卡片内容右边缘 = 卡片右边 - 边框 - 内边距，输入框右边缘应与它重合
      cardContentRight: Math.round(cr.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight)),
      hOverflow: body.scrollWidth > body.clientWidth,
      docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  })()`);

  const sameRow = new Set(geo.btnTops).size === 1;
  check(`[${theme}] 三个导出按钮同一行`, sameRow, `tops=${JSON.stringify(geo.btnTops)}`);
  check(`[${theme}] 三个导出按钮都渲染`, geo.btnTops.length === 3, `n=${geo.btnTops.length}`);
  check(`[${theme}] 「保存到…」前无图标`, geo.firstBtnHasSvg === false);
  check(`[${theme}] 「保存到…」仍是主按钮（品牌色底）`, geo.primaryBg !== null && geo.primaryBg !== 'rgba(0, 0, 0, 0)', `bg=${geo.primaryBg}`);
  const filled = geo.inputs.filter(Boolean);
  check(`[${theme}] 6 个输入控件都渲染（4 input + 2 select）`, filled.length === 6, JSON.stringify(geo.inputs.map(i => i && i.tag)));
  check(`[${theme}] 输入框左边缘对齐`, new Set(filled.map(i => i.x)).size === 1, `x=${filled.map(i => i.x)}`);
  // 前 5 个（4 个文本框 + 冲突策略）占满整行；最后一个「兜底间隔」按设计收窄
  const wide = filled.slice(0, 5), narrow = filled[5];
  check(`[${theme}] 文本框与冲突策略宽度一致且占满整行`, new Set(wide.map(i => i.w)).size === 1, `w=${wide.map(i => i.w)}`);
  check(`[${theme}] 输入框右边缘与卡片内容右边缘对齐`, new Set(wide.map(i => i.x + i.w)).size === 1 && wide[0].x + wide[0].w === geo.cardContentRight, `right=${wide.map(i => i.x + i.w)} cardContentRight=${geo.cardContentRight}`);
  check(`[${theme}] 「兜底间隔」按设计收窄`, narrow.w === 130, `w=${narrow.w}`);
  check(`[${theme}] 输入框有圆角（非原生方形）`, filled.every(i => parseFloat(i.radius) >= 6), filled.map(i => i.radius).join());
  check(`[${theme}] select 去掉原生箭头`, filled.filter(i => i.tag === 'SELECT').every(i => i.appearance === 'none'), filled.map(i => i.appearance).join());
  check(`[${theme}] 输入框背景走主题（非系统默认灰）`, filled.every(i => i.bg !== 'rgb(59, 59, 59)' && i.bg !== 'rgb(255, 255, 255)'), filled.map(i => i.bg).join());
  check(`[${theme}] 输入框继承面板字体字号`, filled.every(i => i.fontSize === '13px' && i.fontFamily.includes('"PingFang SC"')), filled.map(i => i.fontFamily).join(' | ').slice(0, 120));
  check(`[${theme}] 无横向溢出（按钮行不撑破卡片）`, !geo.hOverflow && !geo.docOverflow, `body=${geo.hOverflow} doc=${geo.docOverflow}`);

  const shot = await S("Page.captureScreenshot", { format: "png" }, sessionId);
  const out = path.join(root, "test", `_shot-sync-panel-${theme}.png`);
  await writeFile(out, Buffer.from(shot.result.data, "base64"));
  console.log(`screenshot → test/_shot-sync-panel-${theme}.png`);
}

// 切换导出/导入 tab 后，导入面板的按钮也应保持一行
await evalJs(`document.querySelectorAll('.page.sync .sync-tab')[1].click()`);
await sleep(500);
const importGeo = await evalJs(`(() => {
  const pane = document.querySelector('.page.sync .sync-tab-pane');
  const btns = [...pane.querySelectorAll('.sync-actions-row .cfg-btn')];
  return { tops: btns.map(b => Math.round(b.getBoundingClientRect().top)), n: btns.length };
})()`);
check("导入面板按钮同一行", importGeo.n >= 1 && new Set(importGeo.tops).size === 1, `tops=${JSON.stringify(importGeo.tops)}`);

// ---- 最小窗口宽度（600px，与 Rust 侧 min_inner_size 一致）----
// 三个导出按钮必须仍然是一行，且输入框不能溢出行宽。
await S("Emulation.setDeviceMetricsOverride", {
  width: 600, height: 420, deviceScaleFactor: 1, mobile: false,
}, sessionId);
await sleep(400);
const narrowGeo = await evalJs(`(() => {
  document.querySelectorAll('.page.sync .sync-tab')[0].click();
  const pane = document.querySelector('.page.sync .sync-tab-pane');
  const btns = [...pane.querySelectorAll('.sync-actions-row .cfg-btn')];
  const rows = [...document.querySelectorAll('.page.sync .cfg-card:not(.sync-tab-pane) .cfg-row')];
  const inputs = rows.map(r => {
    const el = r.querySelector('.cfg-input, .cfg-select');
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.x), w: Math.round(b.width), right: Math.round(b.right) };
  }).filter(Boolean);
  const card = document.querySelector('.page.sync .cfg-card:not(.sync-tab-pane)');
  const cr = card.getBoundingClientRect();
  const cs = getComputedStyle(card);
  const body = document.querySelector('.cfg-body');
  return {
    btnTops: btns.map(b => Math.round(b.getBoundingClientRect().top)),
    btnRight: Math.max(...btns.map(b => b.getBoundingClientRect().right)),
    cardContentRight: cr.right - parseFloat(cs.paddingRight),
    inputs,
    hOverflow: body.scrollWidth > body.clientWidth,
    docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  };
})()`);
check("[600px] 三个导出按钮仍是一行", new Set(narrowGeo.btnTops).size === 1, `tops=${JSON.stringify(narrowGeo.btnTops)}`);
check("[600px] 按钮行未超出卡片内容区", narrowGeo.btnRight <= narrowGeo.cardContentRight + 1, `btnRight=${narrowGeo.btnRight.toFixed(1)} cardContent=${narrowGeo.cardContentRight.toFixed(1)}`);
check("[600px] 输入框未溢出行宽", new Set(narrowGeo.inputs.map(i => i.x)).size === 1 && narrowGeo.inputs.every(i => i.right <= narrowGeo.cardContentRight + 1), JSON.stringify(narrowGeo.inputs));
check("[600px] 无横向滚动条", !narrowGeo.hOverflow && !narrowGeo.docOverflow, `body=${narrowGeo.hOverflow} doc=${narrowGeo.docOverflow}`);
await S("Emulation.clearDeviceMetricsOverride", {}, sessionId);

check("无页面异常", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 300));

console.log(`\n${pass} passed, ${fail} failed`);
ws.close();
chrome.kill();
server.close();
process.exit(fail ? 1 : 0);
