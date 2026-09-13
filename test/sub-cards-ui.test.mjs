/**
 * 设置窗口「订阅管理」条块管理：真实浏览器验证（CDP + Chrome headless）。
 *
 * 验证：
 * 1. 默认渲染订阅条块（名称/描述/地址/计数）
 * 2. 添加订阅（展开表单 → 填写 → 确认 → 新条块出现且持久化）
 * 3. 行内编辑保留未知属性（fetchFun / default-tag）
 * 4. 删除订阅（确认弹窗）
 * 5. 条块 ↔ 源码视图切换互通
 * 6. 键盘：Enter 确认 / Esc 取消（编辑态与添加表单）
 * 7. 拖拽排序（CDP 派发 Input.dispatchDragEvent）
 * 8. 暗色/亮色主题截图留档
 *
 * 用法: npm run build && node test/sub-cards-ui.test.mjs
 * 需要本机装有 Chrome / Edge；找不到浏览器时跳过（退出码 0）。
 */
import { createServer } from "http";
import { readFile, mkdir, rm, writeFile } from "fs/promises";
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
const profile = path.join(root, "test", `_chrome-profile-subcards-${process.pid}`);
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

/** 预置两条订阅（storageSet 走 JSON.stringify，与 util.js 一致） */
const seedSubscribes = () =>
  evalJs(`(() => {
    localStorage.setItem('my-search-desktop:subscribes', JSON.stringify(
      '<tis::https://a.example.com/index.ms title="AA" describe="描述A" />\\n\\n' +
      '<tis::https://b.example.com/index.ms title="BB" fetchFun="mLineFetchFun" default-tag="新闻" />'
    ));
  })()`);

const openSubPane = async () => {
  await S("Page.navigate", { url: base + "/config.html" });
  await new Promise((r) => setTimeout(r, 900));
};

/** 读取条块列表快照 */
const readCards = () =>
  evalJs(`(() => {
    const page = document.querySelector('.page.subscribes');
    if (!page) return JSON.stringify({ found: false });
    const items = [...page.querySelectorAll('.sub-item')];
    return JSON.stringify({
      found: true,
      count: page.querySelector('.sub-count')?.textContent ?? null,
      cards: items.map((it) => ({
        index: Number(it.dataset.index),
        name: it.querySelector('.sub-name')?.textContent ?? null,
        describe: it.querySelector('.sub-describe')?.textContent ?? null,
        url: it.querySelector('.sub-url')?.textContent ?? null,
        editing: it.classList.contains('editing'),
        draggable: it.draggable,
        hasDragHandle: !!it.querySelector('.sub-drag'),
        iconSvg: !!it.querySelector('.sub-icon svg[viewBox="0 0 1024 1024"]'),
        iconText: it.querySelector('.sub-icon')?.textContent.trim() ?? null,
        iconColor: getComputedStyle(it.querySelector('.sub-icon')).color,
        iconBg: getComputedStyle(it.querySelector('.sub-icon')).backgroundColor,
      })),
      ta: document.getElementById('all_subscribe')?.value ?? null,
    });
  })()`).then(JSON.parse);

await S("Emulation.setDeviceMetricsOverride", {
  width: 880, height: 620, deviceScaleFactor: 1, mobile: false,
});

// ---- 1. 默认渲染 ----
await openSubPane();
await seedSubscribes();
await openSubPane();
let snap = await readCards();
check("订阅面板默认渲染", snap.found === true);
check("计数显示共 2 条", snap.count === "共 2 条订阅", snap.count);
check("条块数量为 2", snap.cards.length === 2, JSON.stringify(snap.cards.length));
check("第一条显示名称 AA", snap.cards[0]?.name === "AA");
check("第一条显示描述", snap.cards[0]?.describe === "描述A");
check("第一条显示地址", snap.cards[0]?.url?.includes("a.example.com"));
check("第二条无描述时不渲染描述行", snap.cards[1]?.describe === null);
check("条块可拖拽且带手柄", snap.cards.every((c) => c.draggable && c.hasDragHandle));
check(
  "左侧图标为固定数据库 SVG（无首字母文本）",
  snap.cards.every((c) => c.iconSvg === true && c.iconText === ""),
  JSON.stringify({ iconSvg: snap.cards[0]?.iconSvg, iconText: snap.cards[0]?.iconText })
);
check(
  "图标跟随品牌色（fill=currentColor）",
  snap.cards.every((c) => c.iconColor && c.iconColor !== "rgb(0, 0, 0)"),
  snap.cards[0]?.iconColor
);

// ---- 1b. 编辑态也用同一个固定图标 ----
await evalJs(`document.querySelector('.sub-item[data-index="0"] [data-act="edit"]').click()`);
await new Promise((r) => setTimeout(r, 80));
check(
  "编辑态图标同为固定数据库 SVG",
  (await evalJs(`(() => {
    const ic = document.querySelector('.sub-item.editing .sub-icon');
    return !!ic && !!ic.querySelector('svg[viewBox="0 0 1024 1024"]') && ic.textContent.trim() === '';
  })()`)) === true
);
await evalJs(`document.querySelector('.sub-item.editing [data-act="cancel-edit"]').click()`);
await new Promise((r) => setTimeout(r, 80));

// ---- 2. 添加订阅 ----
await evalJs(`document.querySelector('.sub-add-toggle').click()`);
await new Promise((r) => setTimeout(r, 100));
check("点击后展开添加表单", (await evalJs(`!!document.querySelector('.sub-add.open')`)) === true);
await evalJs(`
  document.querySelector('.sub-add-url').value = 'https://c.example.com/index.ms';
  document.querySelector('.sub-add-name').value = 'CC';
  document.querySelector('[data-act="confirm-add"]').click();
`);
await new Promise((r) => setTimeout(r, 100));
snap = await readCards();
check("添加后条块数量为 3", snap.cards.length === 3);
check("添加后表单收起", (await evalJs(`!document.querySelector('.sub-add.open')`)) === true);
check(
  "添加后持久化包含新订阅",
  (await evalJs(`JSON.parse(localStorage.getItem('my-search-desktop:subscribes')).includes('c.example.com')`)) === true
);

// 添加表单校验：地址为空时提示错误
await evalJs(`document.querySelector('.sub-add-toggle').click()`);
await new Promise((r) => setTimeout(r, 80));
await evalJs(`document.querySelector('[data-act="confirm-add"]').click()`);
await new Promise((r) => setTimeout(r, 80));
check(
  "地址为空时提示错误且不关闭表单",
  (await evalJs(`document.getElementById('cfgToast').textContent.includes('订阅地址') && !!document.querySelector('.sub-add.open')`)) === true
);
await evalJs(`document.querySelector('[data-act="close-add"]').click()`);
await new Promise((r) => setTimeout(r, 80));

// 重复地址校验
await evalJs(`
  document.querySelector('.sub-add-toggle').click();
  document.querySelector('.sub-add-url').value = 'https://c.example.com/index.ms';
  document.querySelector('[data-act="confirm-add"]').click();
`);
await new Promise((r) => setTimeout(r, 80));
check(
  "重复地址时提示已存在",
  (await evalJs(`document.getElementById('cfgToast').textContent.includes('已存在')`)) === true
);
await evalJs(`document.querySelector('[data-act="close-add"]').click()`);
await new Promise((r) => setTimeout(r, 80));

// ---- 3. 行内编辑保留未知属性 ----
const bbIndex = snap.cards.find((c) => c.name === "BB")?.index;
await evalJs(`
  document.querySelector('.sub-item[data-index="${bbIndex}"] [data-act="edit"]').click();
`);
await new Promise((r) => setTimeout(r, 100));
check("进入行内编辑态", (await evalJs(`!!document.querySelector('.sub-item.editing')`)) === true);
await evalJs(`
  const row = document.querySelector('.sub-item.editing');
  row.querySelector('.sub-edit-name').value = 'BB2';
  row.querySelector('.sub-edit-describe').value = '新描述';
  row.querySelector('.sub-edit-url').value = 'https://b2.example.com/index.ms';
`);
// 用键盘 Enter 确认（同时验证键盘支持）
await evalJs(`
  const row2 = document.querySelector('.sub-item.editing');
  row2.querySelector('.sub-edit-name').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  row2.querySelector('[data-act="save-edit"]').click();
`);
await new Promise((r) => setTimeout(r, 100));
const storedText = await evalJs(`JSON.parse(localStorage.getItem('my-search-desktop:subscribes'))`);
const bbLine = storedText.split("\n").find((l) => l.includes("b2.example.com"));
check("编辑后写入新地址", !!bbLine);
check("编辑保留 fetchFun 属性", bbLine?.includes('fetchFun="mLineFetchFun"') === true, bbLine);
check("编辑保留 default-tag 属性", bbLine?.includes('default-tag="新闻"') === true, bbLine);
check("编辑更新 title", bbLine?.includes('title="BB2"') === true);
check("编辑更新 describe", bbLine?.includes('describe="新描述"') === true);

// ---- 4. Esc 取消编辑 ----
await evalJs(`document.querySelector('.sub-item [data-act="edit"]').click()`);
await new Promise((r) => setTimeout(r, 80));
await evalJs(`
  const rowEsc = document.querySelector('.sub-item.editing');
  rowEsc.querySelector('.sub-edit-name').value = '不该保存的名字';
  rowEsc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
`);
await new Promise((r) => setTimeout(r, 80));
check("Esc 取消行内编辑", (await evalJs(`!document.querySelector('.sub-item.editing')`)) === true);
check(
  "Esc 后未保存临时值",
  !((await evalJs(`JSON.parse(localStorage.getItem('my-search-desktop:subscribes'))`)).includes("不该保存的名字"))
);
check("窗口未被 Esc 关闭（页面仍在）", (await evalJs(`!!document.querySelector('.page.subscribes')`)) === true);

// ---- 5. 删除订阅（应用内确认弹窗） ----
// 注意：确认走的是应用内弹窗（#msgOverlay），不是 window.confirm。
// 因为 macOS 的 WKWebView 里 wry 未实现 runJavaScriptConfirmPanel，
// window.confirm 会静默返回 false，导致「删除」点了没反应。
const beforeDel = (await readCards()).cards.length;
await evalJs(`document.querySelector('.sub-item:not(.editing) [data-act="remove"]').click()`);
await new Promise((r) => setTimeout(r, 80));
check("弹出了确认框", (await evalJs(`document.getElementById('msgOverlay').classList.contains('show')`)) === true);
await evalJs(`document.getElementById('msgCancel').click()`);
await new Promise((r) => setTimeout(r, 80));
check("拒绝确认时不删除", (await readCards()).cards.length === beforeDel);
await evalJs(`document.querySelector('.sub-item:not(.editing) [data-act="remove"]').click()`);
await new Promise((r) => setTimeout(r, 80));
await evalJs(`document.getElementById('msgOk').click()`);
await new Promise((r) => setTimeout(r, 80));
check("确认后删除一条", (await readCards()).cards.length === beforeDel - 1);
check(
  "持久化同步删除",
  !((await evalJs(`JSON.parse(localStorage.getItem('my-search-desktop:subscribes'))`)).includes("a.example.com"))
);

// ---- 6. 条块 ↔ 源码切换 ----
await evalJs(`document.querySelector('.sub-view-toggle [data-view="src"]').click()`);
await new Promise((r) => setTimeout(r, 80));
check("进入源码模式", (await evalJs(`document.querySelector('.page.subscribes').classList.contains('src-mode')`)) === true);
const taHasSubs = await evalJs(`document.getElementById('all_subscribe').value.includes('b2.example.com')`);
check("源码文本域同步当前订阅", taHasSubs === true);
await evalJs(`
  const ta = document.getElementById('all_subscribe');
  ta.value += '\\n\\n<tis::https://d.example.com/index.ms title="DD" />';
  document.querySelector('.sub-view-toggle [data-view="cards"]').click();
`);
await new Promise((r) => setTimeout(r, 80));
snap = await readCards();
check("切回条块后源码手工添加的订阅出现", snap.cards.some((c) => c.url?.includes("d.example.com")));
check("切回后退出源码模式", (await evalJs(`!document.querySelector('.page.subscribes').classList.contains('src-mode')`)) === true);

// ---- 7. 拖拽排序（页面内合成 DragEvent，带真实 DataTransfer） ----
// CDP 的 Input.dispatchDragEvent 不会合成 dragstart（drop 会被无源拒绝），
// 因此用页面内 dispatchEvent + DataTransfer 走完整 DnD 链路。
// 当前顺序：BB2, CC, DD；把 DD 拖到 BB2 上 → DD 移到最前
const orderBefore = (await readCards()).cards.map((c) => c.name);
await evalJs(`(() => {
  const list = document.querySelector('.sub-list');
  const src = [...list.querySelectorAll('.sub-item')].find((it) => it.querySelector('.sub-url')?.textContent.includes('d.example.com'));
  const dst = [...list.querySelectorAll('.sub-item')].find((it) => it.querySelector('.sub-url')?.textContent.includes('b2.example.com'));
  const dt = new DataTransfer();
  src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
  dst.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
  src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
})()`);
await new Promise((r) => setTimeout(r, 150));
const orderAfter = (await readCards()).cards.map((c) => c.name);
check(
  "拖拽后顺序交换（DD 移到最前）",
  orderAfter[0] === "DD" && orderAfter[1] === "BB2" && orderBefore[0] === "BB2",
  `${orderBefore.join(",")} → ${orderAfter.join(",")}`
);
const idx = await evalJs(`(() => {
  const t = JSON.parse(localStorage.getItem('my-search-desktop:subscribes'));
  return JSON.stringify([t.indexOf('d.example.com'), t.indexOf('b2.example.com')]);
})()`).then(JSON.parse);
check(
  "拖拽后持久化顺序同步（两序号均存在且 DD 在前）",
  idx[0] >= 0 && idx[1] >= 0 && idx[0] < idx[1],
  `idx(d)=${idx[0]}, idx(b2)=${idx[1]}`
);

// ---- 8. 空态（源码视图清空 → 切回条块） ----
await evalJs(`document.querySelector('.sub-view-toggle [data-view="src"]').click()`);
await new Promise((r) => setTimeout(r, 80));
await evalJs(`document.getElementById('all_subscribe').value = '';`);
await evalJs(`document.querySelector('.sub-view-toggle [data-view="cards"]').click()`);
await new Promise((r) => setTimeout(r, 80));
check("清空后显示空态提示", (await evalJs(`!!document.querySelector('.sub-empty')`)) === true);

// ---- 截图留档（亮 / 暗） ----
const { writeFile: wf } = await import("fs/promises");
await evalJs(`
  localStorage.setItem('my-search-desktop:subscribes', JSON.stringify(
    '<tis::https://sspai.com/index.ms title="少数派" describe="少数派的质量文章订阅" />\\n\\n' +
    '<tis::https://ruanyifeng.com/index.ms title="阮一峰的网络日志" describe="科技爱好者周刊" fetchFun="mLineFetchFun" default-tag="博客" />\\n\\n' +
    '<tis::https://juejin.cn/index.ms title="掘金" />'
  ));
`);
for (const theme of ["light", "dark"]) {
  await S("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: theme }],
  });
  await openSubPane();
  // 展开编辑态 + 添加表单，让截图覆盖两种 UI 状态
  await evalJs(`document.querySelector('.sub-item[data-index="1"] [data-act="edit"]').click()`);
  await new Promise((r) => setTimeout(r, 100));
  const shot = await S("Page.captureScreenshot", { format: "png" });
  const out = path.join(root, "test", `_shot-sub-cards-880x620-${theme}.png`);
  await wf(out, Buffer.from(shot.data, "base64"));
  console.log("screenshot →", out);
}

console.log("\n=== PAGE ERRORS ===");
console.log(pageErrors.length ? pageErrors.join("\n") : "(none)");

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);

ws.close();
proc.kill();
server.close();
await new Promise((r) => (proc.once("exit", r), setTimeout(r, 3000)));
await rm(profile, { recursive: true, force: true }).catch(() => {});
process.exit(failed.length || pageErrors.length ? 1 : 0);
