/**
 * 回归测试：「设置 → 订阅总览」面板高度应占满右侧内容区。
 *
 * 关键验证点：
 * 1. 卡片上下边贴住 .cfg-body 的内边距（不再是一块固定高度的卡片）
 * 2. 订阅原文文本域吃下卡片内剩余的全部高度（不再是固定 260px）
 * 3. 窗口变高 → 文本域跟着变高；窗口很矮 → 收敛到 min-height 140px 下限
 * 4. 任何尺寸下都不出现溢出滚动（内容被裁掉）
 *
 * 用法: npm run build && node test/pane-height.test.mjs
 * 需要本机装有 Chrome / Edge；找不到浏览器时跳过（退出码 0）。
 */
import { createServer } from "http";
import { readFile, mkdir, rm } from "fs/promises";
import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
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

const chrome = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));
if (!chrome) {
  console.log("跳过：未找到 Chrome / Edge，无法做真实布局测量。");
  process.exit(0);
}
// 每次运行用独立的 profile 目录：复用同一个目录时，上一次 Chrome 还没退干净
// 会留下 LOCK，导致下一次启动直接报错（连续跑两次必现）。
const profile = path.join(root, "test", `_chrome-profile-${process.pid}`);
await mkdir(profile, { recursive: true });

const proc = spawn(
  chrome,
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
    pageErrors.push("EXC: " + (m.params.exceptionDetails.exception?.description || ""));
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

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// 新版订阅面板默认「条块」视图，#all_subscribe 文本域仅在「源码」模式显示；
// 量测前先切到源码模式（src-mode 类控制 display）
const enterSrcMode = () =>
  evalJs(`(() => {
    const btn = document.querySelector('#ms-config-view .page.subscribes .sub-view-toggle button[data-view="src"]');
    if (!btn) return 'no-toggle';
    btn.click();
    return 'ok';
  })()`);

const measure = () =>
  evalJs(`(() => {
    const body = document.querySelector('#ms-config-view .cfg-body');
    const card = document.querySelector('#ms-config-view .page.subscribes .cfg-card');
    const ta   = document.getElementById('all_subscribe');
    const head = document.querySelector('#ms-config-view .page.subscribes .cfg-card-head');
    const last = document.querySelector('#ms-config-view .cfg-footer');
    const b = body.getBoundingClientRect(), c = card.getBoundingClientRect(), t = ta.getBoundingClientRect();
    const br = getComputedStyle(body), cr = getComputedStyle(card);
    return JSON.stringify({
      bodyH: Math.round(b.height),
      padTop: parseFloat(br.paddingTop), padBottom: parseFloat(br.paddingBottom),
      cardTop: Math.round(c.top - b.top), cardBottom: Math.round(b.bottom - c.bottom),
      cardH: Math.round(c.height),
      cardPadV: parseFloat(cr.paddingTop) + parseFloat(cr.paddingBottom),
      cardBorderV: parseFloat(cr.borderTopWidth) + parseFloat(cr.borderBottomWidth),
      headH: Math.round(head.getBoundingClientRect().height),
      headGap: Math.round(t.top - head.getBoundingClientRect().bottom),
      taBottom: Math.round(c.bottom - t.bottom),
      cardPadBottom: parseFloat(cr.paddingBottom),
      taH: Math.round(t.height),
      taBottomGap: Math.round(c.bottom - t.bottom),
      footerTop: Math.round(last.getBoundingClientRect().top),
      bodyBottom: Math.round(b.bottom),
      resize: getComputedStyle(ta).resize,
      scrollH: body.scrollHeight, clientH: body.clientHeight
    });
  })()`).then(JSON.parse);

for (const [w, h] of [[880, 600], [1100, 820], [640, 460], [880, 1000]]) {
  await S("Emulation.setDeviceMetricsOverride", {
    width: w, height: h, deviceScaleFactor: 1, mobile: false,
  });
  await S("Page.navigate", { url: base + "/config.html" });
  await new Promise((r) => setTimeout(r, 900));
  await enterSrcMode();
  await new Promise((r) => setTimeout(r, 150));
  // 填一段较长的订阅原文，确保内容不是「空文本域」这种特殊情况
  await evalJs(`(() => {
    const ta = document.getElementById('all_subscribe');
    ta.value = Array.from({length: 40}, (_, i) =>
      '<tis::https://example.com/sub' + i + '.ms title="订阅' + i + '" describe="描述' + i + '" />').join('\\n');
    ta.dispatchEvent(new Event('input'));
    return 1;
  })()`);
  const m = await measure();
  const expectCardBottom = m.padBottom;      // 卡片底边应贴在 .cfg-body 内边距下沿
  const expectCardTop = m.padTop;            // 卡片顶边应贴在内边距上沿
  // 文本域应吃下卡片内部剩余的全部高度（扣掉边框、上下 padding、卡片头及其下间距）
  const taShouldFill = m.cardH - m.cardBorderV - m.cardPadV - m.headH - m.headGap;
  check(
    `${w}x${h} 卡片占满内容区高度`,
    Math.abs(m.cardBottom - expectCardBottom) <= 1 && Math.abs(m.cardTop - expectCardTop) <= 1,
    `bodyH=${m.bodyH} cardTop=${m.cardTop}(期望${expectCardTop}) cardBottom=${m.cardBottom}(期望${expectCardBottom}) cardH=${m.cardH}`
  );
  check(
    `${w}x${h} 文本域随卡片拉伸（非固定值）`,
    m.taH >= taShouldFill - 1,
    `taH=${m.taH} 应填满≈${taShouldFill} cardH=${m.cardH} head=${m.headH} gap=${m.headGap} resize=${m.resize}`
  );
  check(`${w}x${h} 无溢出滚动`, m.scrollH <= m.clientH + 1, `scroll=${m.scrollH} client=${m.clientH}`);
}

// 关键回归：不同窗口高度 -> 不同文本域高度
await S("Emulation.setDeviceMetricsOverride", { width: 880, height: 600, deviceScaleFactor: 1, mobile: false });
await S("Page.navigate", { url: base + "/config.html" });
await new Promise((r) => setTimeout(r, 800));
await enterSrcMode();
await new Promise((r) => setTimeout(r, 150));
const h600 = (await measure()).taH;
await S("Emulation.setDeviceMetricsOverride", { width: 880, height: 800, deviceScaleFactor: 1, mobile: false });
await new Promise((r) => setTimeout(r, 400));
const h800 = (await measure()).taH;
check("窗口变高时文本域随之变高（不再是固定 260px）", h800 > h600, `${h600} -> ${h800}`);
check("文本域高度不再固定为 260px", h600 !== 260, `taH=${h600}`);

// 小窗口：文本域不能无限压缩，收敛到 min-height 140px 下限
// （窗口高度 620x300 时卡片内部剩余空间不足 140px，会顶到下限并让 .cfg-body 出现滚动）
await S("Emulation.setDeviceMetricsOverride", { width: 620, height: 300, deviceScaleFactor: 1, mobile: false });
await S("Page.navigate", { url: base + "/config.html" });
await new Promise((r) => setTimeout(r, 800));
await enterSrcMode();
await new Promise((r) => setTimeout(r, 150));
const small = await measure();
check("小窗口下文本域收敛到 min-height 140px 下限", small.taH === 140, `taH=${small.taH}`);
check(
  "小窗口下内容溢出时由 .cfg-body 滚动，不被裁掉",
  small.scrollH > small.clientH,
  `scroll=${small.scrollH} client=${small.clientH}`
);

// ---- 订阅市场结果列表：应占满并内部滚动 ----
const seedSubs = (n) =>
  Array.from(
    { length: n },
    (_, i) =>
      '<tis::https://example.com/market' + i + '.ms title="市场订阅' + i + '" describe="描述' + i + '" />'
  ).join("\n");

const openHub = async () => {
  await evalJs(`document.querySelector('.cfg-nav .nav-item[data-pane="repo"]').click()`);
  await new Promise((r) => setTimeout(r, 250));
  await evalJs(`document.getElementById('openTisHub').click()`);
  await new Promise((r) => setTimeout(r, 700));
};

/** 量结果列表与页面的几何关系 */
const measureHub = () =>
  evalJs(`(() => {
    const body = document.querySelector('#ms-config-view .cfg-body');
    const card = document.querySelector('#ms-config-view .page.tis-hub > .cfg-card');
    const list = document.querySelector('#ms-config-view .tis-hub .result-list');
    const view = document.querySelector('#ms-config-view .page.tis-hub');
    const b = body.getBoundingClientRect(), c = card.getBoundingClientRect(), l = list.getBoundingClientRect();
    const cs = getComputedStyle(body);
    return JSON.stringify({
      rows: document.querySelectorAll('#ms-config-view .tis-hub .hub-tis').length,
      bodyH: Math.round(b.height),
      padBottom: parseFloat(cs.paddingBottom),
      listTop: Math.round(l.top - b.top),
      cardBottom: Math.round(l.top - c.bottom),
      bottomGap: Math.round(b.bottom - l.bottom) - parseFloat(cs.paddingBottom),
      listH: Math.round(l.height),
      listScrollH: list.scrollHeight, listClientH: list.clientHeight,
      pageH: Math.round(view.getBoundingClientRect().height),
      bodyScrollH: body.scrollHeight, bodyClientH: body.clientHeight
    });
  })()`).then(JSON.parse);

// 条目很多（30 条）：列表占满 + 内部滚动，页面本身不滚
await S("Emulation.setDeviceMetricsOverride", { width: 880, height: 620, deviceScaleFactor: 1, mobile: false });
await S("Page.navigate", { url: base + "/config.html" });
await new Promise((r) => setTimeout(r, 900));
await evalJs(`(() => { localStorage.setItem('my-search-desktop:subscribes', ${JSON.stringify(
  JSON.stringify(seedSubs(30))
)}); return 1; })()`);
await S("Page.navigate", { url: base + "/config.html" });
await new Promise((r) => setTimeout(r, 1100));
await openHub();
const many = await measureHub();
check("订阅市场有 30 条结果待展示", many.rows === 30, `rows=${many.rows}`);
check(
  "结果列表底部贴住内容区（无空白）",
  Math.abs(many.bottomGap) <= 1,
  `bottomGap=${many.bottomGap} bodyH=${many.bodyH} listH=${many.listH}`
);
check(
  "条目多时在结果列表内部滚动",
  many.listScrollH > many.listClientH && many.bodyScrollH <= many.bodyClientH + 1,
  `list scroll=${many.listScrollH}/${many.listClientH} body scroll=${many.bodyScrollH}/${many.bodyClientH}`
);

// 条目很少（2 条）：列表仍占满，不因内容少而塌缩
await S("Page.navigate", { url: base + "/config.html" });
await new Promise((r) => setTimeout(r, 800));
await evalJs(`(() => { localStorage.setItem('my-search-desktop:subscribes', ${JSON.stringify(
  JSON.stringify(seedSubs(2))
)}); return 1; })()`);
await S("Page.navigate", { url: base + "/config.html" });
await new Promise((r) => setTimeout(r, 1100));
await openHub();
const few = await measureHub();
check("订阅市场有 2 条结果", few.rows === 2, `rows=${few.rows}`);
check(
  "条目少时结果列表仍占满剩余高度",
  Math.abs(few.bottomGap) <= 1 && few.listH >= 300,
  `bottomGap=${few.bottomGap} listH=${few.listH}`
);
check("条目少时不出现滚动条", few.listScrollH <= few.listClientH + 1, `scroll=${few.listScrollH}/${few.listClientH}`);

// 窗口变高 → 列表跟着变高
await S("Emulation.setDeviceMetricsOverride", { width: 880, height: 820, deviceScaleFactor: 1, mobile: false });
await new Promise((r) => setTimeout(r, 500));
const taller = await measureHub();
check("窗口变高时结果列表随之变高", taller.listH > many.listH, `${many.listH} -> ${taller.listH}`);
check(
  "窗口变高后仍无底部空白",
  Math.abs(taller.bottomGap) <= 1,
  `bottomGap=${taller.bottomGap} listH=${taller.listH}`
);

// 多个结果 → 矮窗口：列表收敛到 300px 下限，页面接管滚动
await S("Emulation.setDeviceMetricsOverride", { width: 880, height: 420, deviceScaleFactor: 1, mobile: false });
await new Promise((r) => setTimeout(r, 500));
const tiny = await measureHub();
check("矮窗口下结果列表收敛到 300px 下限", tiny.listH === 300, `listH=${tiny.listH}`);
check(
  "矮窗口下超出内容由 .cfg-body 滚动（不被裁掉）",
  tiny.bodyScrollH > tiny.bodyClientH,
  `body scroll=${tiny.bodyScrollH}/${tiny.bodyClientH}`
);

console.log("\n=== PAGE ERRORS ===");
console.log(pageErrors.length ? pageErrors.join("\n") : "(none)");
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);

ws.close();
proc.kill();
server.close();
// 等 Chrome 真正退出再删 profile，否则文件被占用删不干净
await new Promise((r) => (proc.once("exit", r), setTimeout(r, 3000)));
await rm(profile, { recursive: true, force: true }).catch(() => {});process.exit(failed.length ? 1 : 0);
