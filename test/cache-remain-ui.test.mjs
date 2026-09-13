/**
 * 设置窗口「数据缓存」面板：剩余过期时间的真实浏览器验证。
 *
 * 用 CDP 打开构建产物 config.html，切到「数据缓存」面板，检查：
 * 1. 未过期的缓存 → 显示「剩 X 小时 X 分（约 HH:MM 过期）」
 * 2. 面板停留期间文案会随时间变小（秒级倒计时真的在跑）
 * 3. 缓存过期 → 文案切到「已过期（HH:MM 失效）」且带 .expired 样式
 * 4. 没有 expire 字段的旧缓存 → 只显示条数，不虚构有效期，也不报错
 * 5. 切到其它面板 → 倒计时定时器自动停掉（不在后台空转）
 *
 * 用法: npm run build && node test/cache-remain-ui.test.mjs
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
  console.log("跳过：未找到 Chrome / Edge，无法做真实 UI 验证。");
  process.exit(0);
}
const profile = path.join(root, "test", `_chrome-profile-remain-${process.pid}`);
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
  const r = await S("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description || "eval failed");
  return r.result.value;
};

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

/** 写入 SEARCH_DATA_KEY 缓存（expire 相对当前时间的偏移毫秒） */
const seedCache = (expireOffsetMs, count = 417) =>
  evalJs(`(() => {
    const data = Array.from({ length: ${count} }, (_, i) => ({
      title: '条目' + i, desc: '描述' + i, resource: 'https://example.com/' + i,
    }));
    const pkg = { data };
    ${
      expireOffsetMs === null
        ? "// 旧版缓存：不写 expire 字段"
        : `pkg.expire = Date.now() + ${expireOffsetMs};`
    }
    localStorage.setItem('my-search-desktop:SEARCH_DATA_KEY', JSON.stringify(pkg));
    return pkg.expire ?? null;
  })()`);

/** 打开设置窗口并切到数据缓存面板 */
const openCachePane = async () => {
  await S("Page.navigate", { url: base + "/config.html" });
  await new Promise((r) => setTimeout(r, 900));
  await evalJs(`document.querySelector('.cfg-nav .nav-item[data-pane="cache"]').click()`);
  await new Promise((r) => setTimeout(r, 200));
};

/** 读取「订阅数据缓存」条目的剩余时间文案与样式类 */
const readItem = () =>
  evalJs(`(() => {
    const it = document.querySelector('#cacheList .cache-item[data-key="SEARCH_DATA_KEY"]');
    if (!it) return JSON.stringify({ found: false });
    const size = it.querySelector('.cache-size');
    const count = it.querySelector('.cache-count');
    return JSON.stringify({
      found: true,
      size: size ? size.textContent : null,
      count: count ? count.textContent : null,
      expiredClass: it.classList.contains('expired'),
      countColor: count ? getComputedStyle(count).color : null,
      // 其它条目（如订阅原文）不应被误标过期
      otherExpired: [...document.querySelectorAll('#cacheList .cache-item')]
        .filter(el => el.dataset.key !== 'SEARCH_DATA_KEY' && el.classList.contains('expired')).length,
    });
  })()`).then(JSON.parse);

await S("Emulation.setDeviceMetricsOverride", {
  width: 880, height: 620, deviceScaleFactor: 1, mobile: false,
});

// ---- 1. 未过期缓存（剩 12 小时）----
await openCachePane();
await seedCache(12 * 3600 * 1000);
await openCachePane();
const fresh = await readItem();
check("缓存条目已渲染", fresh.found, JSON.stringify(fresh));
check(
  "未过期缓存显示剩余时间",
  /剩 1[12] 小时 \d+ 分/.test(fresh.count || ""),
  `count=${fresh.count}`
);
check(
  "显示具体过期时刻",
  /（(约 )?\d{2}:\d{2} 过期）|（明天 \d{2}:\d{2} 过期）/.test(fresh.count || ""),
  `count=${fresh.count}`
);
check("未过期不加 .expired 样式", fresh.expiredClass === false, `count=${fresh.count}`);
check("条数与占用仍然显示", /条内容/.test(fresh.count || "") && /KB|MB/.test(fresh.size || ""), `size=${fresh.size}`);

// ---- 2. 秒级倒计时：剩余不足 1 分钟时，停留期间文案变小 ----
// （剩余 12 小时时按设计只显示到分钟，不会每 2 秒变一次）
await seedCache(45 * 1000);
await openCachePane();
const t1 = await readItem();
await new Promise((r) => setTimeout(r, 2200));
const t2 = await readItem();
check("剩余不足 1 分钟时显示到秒", /剩 \d+ 秒/.test(t1.count || ""), `count=${t1.count}`);
check(
  "面板停留时剩余时间会走动（定时器在跑）",
  t1.count !== t2.count,
  `${t1.count} → ${t2.count}`
);
check(
  "剩余时间单调递减",
  Number((t2.count || "").match(/剩 (\d+) 秒/)?.[1]) <
    Number((t1.count || "").match(/剩 (\d+) 秒/)?.[1]),
  `${t1.count} → ${t2.count}`
);

// 剩余 12 小时：分钟精度，倒计时不会每 2 秒跳一次（避免噪声）
await seedCache(12 * 3600 * 1000);
await openCachePane();
const m1 = await readItem();
await new Promise((r) => setTimeout(r, 2200));
const m2 = await readItem();
check("小时档按分钟精度刷新（不逐秒跳）", m1.count === m2.count, `${m1.count} → ${m2.count}`);

// ---- 3. 过期缓存 → 已过期 + 失效时刻 + .expired ----
await seedCache(-60 * 1000);
await openCachePane();
const stale = await readItem();
check("过期缓存显示「已过期」", /已过期/.test(stale.count || ""), `count=${stale.count}`);
check("过期缓存不显示「剩」", !/剩 /.test(stale.count || ""), `count=${stale.count}`);
check("过期缓存显示失效时刻", /（\d{2}:\d{2} 失效）/.test(stale.count || ""), `count=${stale.count}`);
check("过期缓存带 .expired 样式类", stale.expiredClass === true, `count=${stale.count}`);
check("只有订阅数据缓存被标记过期", stale.otherExpired === 0, `otherExpired=${stale.otherExpired}`);

// 过期后文案必须稳定（不再每秒变动），且定时器应已停止
const s1 = await readItem();
await new Promise((r) => setTimeout(r, 1600));
const s2 = await readItem();
check("已过期文案不再变动", s1.count === s2.count, `${s1.count} → ${s2.count}`);

// ---- 4. 旧版缓存（无 expire 字段）：只显示条数，不虚构有效期 ----
await seedCache(null);
await openCachePane();
const legacy = await readItem();
check("旧版缓存只显示条数", /^\d[\d,]* 条内容$/.test(legacy.count || ""), `count=${legacy.count}`);
check("旧版缓存不显示剩余/过期", !/剩|过期|失效/.test(legacy.count || ""), `count=${legacy.count}`);
check("旧版缓存不标记 .expired", legacy.expiredClass === false, `count=${legacy.count}`);

// ---- 5. 切走面板 → 定时器停掉（不后台空转） ----
await seedCache(12 * 3600 * 1000);
await openCachePane();
check("切走前有剩余时间", /剩 /.test((await readItem()).count || ""), "");
await evalJs(`document.querySelector('.cfg-nav .nav-item[data-pane="repo"]').click()`);
await new Promise((r) => setTimeout(r, 1500));
const back = await evalJs(`document.querySelector('#cacheList') === null`);
check("切走后缓存面板 DOM 被移除", back === true, `removed=${back}`);
// 回到缓存面板应重新渲染并恢复倒计时（渲染的是最新剩余时间）
await evalJs(`document.querySelector('.cfg-nav .nav-item[data-pane="cache"]').click()`);
await new Promise((r) => setTimeout(r, 200));
const restored = await readItem();
check("切回后面板恢复显示剩余时间", /剩 /.test(restored.count || ""), `count=${restored.count}`);

// ---- 6. 清理缓存按钮 → 条目变空且不报错 ----
// 注意：确认走的是应用内弹窗（#msgOverlay），不是 window.confirm
// （macOS 的 WKWebView 里 wry 未实现 confirm 面板，window.confirm 会静默返回 false）
await evalJs(`document.getElementById('clearDataCache').click()`);
await new Promise((r) => setTimeout(r, 100));
await evalJs(`document.getElementById('msgOk').click()`);
await new Promise((r) => setTimeout(r, 400));
const cleared = await readItem();
check("清理后订阅数据缓存显示为空", cleared.size === "空", `size=${cleared.size}`);
check("清理后不再显示剩余时间", !/剩 /.test(cleared.count || ""), `count=${cleared.count}`);
// 空条目上不该有悬空定时器（跑一秒确认无异常即可）
await new Promise((r) => setTimeout(r, 1200));

console.log("\n=== PAGE ERRORS ===");
console.log(pageErrors.length ? pageErrors.join("\n") : "(none)");

// 截图留档（便于人工确认排版：剩余时间是否会挤坏右侧布局）
if (process.env.SHOT) {
  const { writeFile } = await import("fs/promises");
  for (const [w, h, theme] of [
    [880, 620, "dark"],
    [620, 480, "light"],
  ]) {
    await S("Emulation.setDeviceMetricsOverride", {
      width: w, height: h, deviceScaleFactor: 1, mobile: false,
    });
    await S("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: theme }],
    });
    await openCachePane();
    // 最长的文案：剩余「11 小时 59 分」+ 跨天过期时刻
    await seedCache(11 * 3600 * 1000 + 59 * 60 * 1000);
    await openCachePane();
    const shot = await S("Page.captureScreenshot", { format: "png" });
    const out = path.join(root, "test", `_shot-cache-remain-${w}x${h}-${theme}.png`);
    await writeFile(out, Buffer.from(shot.data, "base64"));
    console.log("screenshot →", out);
  }
  // 文案是否溢出容器（宽度不够时应该换行/不溢出）
  const overflow = await evalJs(`(() => {
    const meta = document.querySelector('#cacheList .cache-item[data-key="SEARCH_DATA_KEY"] .cache-item-meta');
    const body = document.querySelector('#ms-config-view .cfg-body');
    return JSON.stringify({
      metaW: Math.round(meta.getBoundingClientRect().width),
      metaScrollW: meta.scrollWidth,
      bodyScrollW: body.scrollWidth, bodyClientW: body.clientWidth,
    });
  })()`).then(JSON.parse);
  console.log("overflow check:", JSON.stringify(overflow));
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);

ws.close();
proc.kill();
server.close();
await new Promise((r) => (proc.once("exit", r), setTimeout(r, 3000)));
await rm(profile, { recursive: true, force: true }).catch(() => {});
process.exit(failed.length || pageErrors.length ? 1 : 0);
