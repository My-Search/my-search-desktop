/**
 * 回归测试：录屏与水印插件的水印页**只出现一条右侧滚动条**。
 *
 * 用户反馈：打开「加水印」页，右侧同时叠着两条滚动条（内层插件的默认 Windows
 * 滚动条 + 外层宿主的极简滚动条）。
 *
 * 根因（宿主与插件的滚动责任分工被破坏）：
 *   - 宿主的详情区 `#text_show` 常态是 `max-height:510px; overflow-y:auto`
 *     —— **由它滚**；
 *   - 插件根容器 `.rc-app` 之前还写了 `max-height:520px; overflow-y:auto`。
 *     520 比 `#text_show` 的内容区（510 − 上下 padding 26 = 484）**高**，于是
 *     `.rc-app` 先被钉在 520px 自己滚一条，父级 `#text_show` 又滚一条 —— 两条
 *     滚动条并排出现。把窗口拖大（拉伸态）后 `.rc-app` 仍被 520 卡住，下方内容
 *     永远够不着。
 *
 * 契约（本测试钉死）：
 *   1. **非拉伸态（默认尺寸）**：`.rc-app` 不设 max-height、**不是**滚动容器
 *      （`scrollHeight - clientHeight <= 1`）；滚动只由宿主 `#text_show` 承担
 *      （`overflow-y:auto` 且 `scrollHeight > clientHeight`）→ 只有一条滚动条；
 *   2. **拉伸态（用户拖过右下角手柄）**：`#text_show` 翻成 `overflow:hidden`
 *      （禁滚），`.rc-app` 成为**唯一**滚动容器且内容可达底部；
 *   3. 全程没有其它元素再起一条滚动条（`.rc-app` 之外无第二个可滚区）。
 *
 * 为什么用真实浏览器：`overflow` 下「谁最终在滚」、以及 max-height 把盒子钉在
 * 何处，都是计算样式/布局层面的，纯源码断言测不出来——本 bug 正是漏在网上。
 *
 * 用法: node test/recorder-scroll.test.mjs
 * 需要本机装有 Chrome / Edge；找不到浏览器时跳过（退出码 0）。
 */
import { createServer } from "http";
import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const recHtml = readFileSync(path.join(root, "plugins/recorder/ui/detail.html"), "utf8");
const recCss = readFileSync(path.join(root, "plugins/recorder/ui/detail.css"), "utf8");
const hostCss = readFileSync(path.join(root, "src/css/style.css"), "utf8");

/* ============ 复刻宿主的 scopeCss（与 src/lib/util.ts 同口径）============ */
function scopeSelectorList(sel, prefix) {
  return sel
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (/^(\*|html|body|:root)$/i.test(s) ? prefix : `${prefix} ${s}`))
    .join(", ");
}
function readBlock(css, i) {
  let depth = 1;
  let out = "";
  while (i < css.length && depth > 0) {
    const ch = css[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (!depth) break;
    }
    out += ch;
    i++;
  }
  return { text: out, end: i };
}
function scopeCssBlocks(css, prefix) {
  const out = [];
  let plain = "";
  let i = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === "{") {
      const header = plain.trim();
      plain = "";
      const body = readBlock(css, i + 1);
      i = body.end + 1;
      if (!header) continue;
      if (header.startsWith("@")) {
        const at = header.toLowerCase();
        if (at.startsWith("@keyframes") || at.startsWith("-webkit-keyframes")) {
          out.push(`${header} {${body.text}}`);
        } else {
          out.push(`${header} {\n${scopeCssBlocks(body.text, prefix).join("\n")}\n}`);
        }
      } else {
        out.push(`${scopeSelectorList(header, prefix)} {${body.text}}`);
      }
      continue;
    }
    plain += ch;
    i++;
  }
  return out;
}
function scopeCss(css, prefix) {
  const clean = String(css ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
  return scopeCssBlocks(clean, prefix).join("\n");
}

const PREFIX = "#text_show .plugin-view";
const bodyInner = recHtml
  .match(/<body[^>]*>([\s\S]*?)<\/body>/i)[1]
  .replace(/<script[\s\S]*?<\/script>/gi, "");

/**
 * 按宿主真实结构搭出布局链（用真实 `src/css/style.css`，含 `.plugin-sized` 整段），
 * 因此宿主侧的滚动契约是被真正复现的，而不是测试自己编的一套近似规则。
 */
function buildPage(sized) {
  const boxCls = sized ? ' class="plugin-sized"' : "";
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>${hostCss}</style>
</head><body>
<div id="ms-app">
  <div id="my_search_box"${boxCls}>
    <div id="searchBox" style="height:48px">搜索框</div>
    <div id="my_search_view">
      <div id="text_show" style="display:block">
        <div class="plugin-view">
          <div class="ms-plugin-session">
            <style class="ms-plugin-style">${scopeCss(recCss, PREFIX)}</style>
            ${bodyInner}
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
</body></html>`;
}

let currentPage = buildPage(true);
const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(currentPage);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

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

const userDir = path.join(root, "test", "_chrome-profile-recorder-scroll");
const chrome = spawn(
  bin,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    // 窗口足够矮：让内容（水印编辑器）必然高于可视区，滚动才有意义。
    "--window-size=1000,560",
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
    pageErrors.push(
      msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text
    );
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
    throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 700));
  }
  return r.result?.result?.value;
};

/**
 * 造出「加水印」页的真实高度。
 *
 * 该页的水印编辑器由 index.js 从 <template> 克隆注入；测试不跑插件脚本，直接
 * 克隆模板塞进两个挂载点，让页面内容高于窗口（滚动才有意义）。
 */
const FILL = `(() => {
  document.getElementById("rc-pane-rec").hidden = true;
  const wm = document.getElementById("rc-pane-wm");
  wm.hidden = false;
  const tpl = document.getElementById("rc-wm-template");
  document.getElementById("rc-wm-editor").appendChild(tpl.content.cloneNode(true));
  const ed2 = document.getElementById("rc-rec-wm-editor");
  ed2.hidden = false;
  ed2.appendChild(tpl.content.cloneNode(true));
})()`;

/**
 * 测量：找出详情区内所有「自身在滚」的元素（scrollHeight 明显大于 clientHeight）。
 *
 * 只遍历 `#text_show` 子树——那正是用户看到「右侧两条滚动条」的区域。不遍历
 * 外层 `#ms-app`：本测试的假宿主没有像真实宿主那样把**窗口高度**收敛到内容高，
 * 外层脚手架会溢出，那与本插件无关（真实运行时窗口高度按 `#my_search_box` 实测
 * 下发，`#ms-app` 不产生滚动）。
 *
 * 契约要求：
 *   - 非拉伸态：详情区内只有 #text_show 在滚（一条滚动条）；.rc-app 不在其中；
 *   - 拉伸态：详情区内只有 .rc-app 在滚；#text_show 已禁滚。
 */
const MEASURE = `(() => {
  const scrollers = [];
  const walk = (el, depth) => {
    if (depth > 12) return;
    if (el.scrollHeight - el.clientHeight > 1) {
      scrollers.push({
        id: el.id || "",
        cls: (el.className || "").toString().slice(0, 40),
        tag: el.tagName,
        scrollH: el.scrollHeight,
        clientH: el.clientHeight,
        overflowY: getComputedStyle(el).overflowY,
      });
    }
    for (const c of el.children) walk(c, depth + 1);
  };
  const ts = document.getElementById("text_show");
  const app = document.getElementById("app");
  walk(ts, 0);
  return {
    scrollers,
    // 只算「本插件页真正参与滚动」的元素：宿主 #text_show 与插件根 .rc-app
    textShow: {
      scrollH: ts.scrollHeight,
      clientH: ts.clientHeight,
      overflowY: getComputedStyle(ts).overflowY,
      scrolling: ts.scrollHeight - ts.clientHeight > 1,
    },
    rcApp: {
      maxH: getComputedStyle(app).maxHeight,
      scrollH: app.scrollHeight,
      clientH: app.clientHeight,
      overflowY: getComputedStyle(app).overflowY,
      scrollTop: app.scrollTop,
      scrolling: app.scrollHeight - app.clientHeight > 1,
    },
  };
})()`;

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log("PASS ", name, extra ? `— ${extra}` : "");
  } else {
    fail++;
    console.log("FAIL ", name, extra ? `— ${extra}` : "");
  }
};

/* ============ 1. 非拉伸态：只有宿主 #text_show 一条滚动条 ============ */
currentPage = buildPage(false);
await S("Page.navigate", { url }, sessionId);
await new Promise((r) => setTimeout(r, 800));
await evalJs(FILL);
const plain = await evalJs(MEASURE);

check(
  "非拉伸态：宿主 #text_show 是滚动容器（内容高于可视区）",
  plain.textShow.scrolling && plain.textShow.overflowY === "auto",
  `scrollH=${plain.textShow.scrollH} clientH=${plain.textShow.clientH} overflowY=${plain.textShow.overflowY}`
);
check(
  "非拉伸态：插件根 .rc-app 未设 max-height（不再被钉死在 520px）",
  plain.rcApp.maxH === "none",
  `maxHeight=${plain.rcApp.maxH}`
);
check(
  "非拉伸态：插件根 .rc-app 自身不滚动（双滚动条的回归点）",
  !plain.rcApp.scrolling,
  `scrollH=${plain.rcApp.scrollH} clientH=${plain.rcApp.clientH}`
);
check(
  "非拉伸态：详情区内只有宿主 #text_show 一个滚动区（插件内不再叠一条）",
  plain.scrollers.length === 1 && plain.textShow.scrolling,
  `scrollers=${plain.scrollers.map((s) => s.id || s.cls).join(",") || "无"}`
);

/* ============ 2. 拉伸态：滚动下放给插件，且只有 .rc-app 一条 ============ */
currentPage = buildPage(true);
await S("Page.navigate", { url: url + "?sized=1" }, sessionId);
await new Promise((r) => setTimeout(r, 800));
await evalJs(FILL);
const sized = await evalJs(MEASURE);

check(
  "拉伸态：宿主 #text_show 已禁滚（overflow-y = hidden）",
  sized.textShow.overflowY === "hidden" && !sized.textShow.scrolling,
  `overflowY=${sized.textShow.overflowY} scrolling=${sized.textShow.scrolling}`
);
check(
  "拉伸态：插件根 .rc-app 成为滚动容器",
  sized.rcApp.scrolling && sized.rcApp.overflowY === "auto",
  `scrollH=${sized.rcApp.scrollH} clientH=${sized.rcApp.clientH} overflowY=${sized.rcApp.overflowY}`
);
check(
  "拉伸态：详情区内只有 .rc-app 一个滚动区（不再叠第二条滚动条）",
  sized.scrollers.length === 1 && sized.scrollers[0].id === "app",
  `scrollers=${sized.scrollers.map((s) => s.id || s.cls).join(",") || "无"}`
);

/* ============ 3. 拉伸态能真滚到底（内容全部可达）============ */
const scroll = await evalJs(`(() => {
  const app = document.getElementById("app");
  app.scrollTop = app.scrollHeight;
  const max = app.scrollHeight - app.clientHeight;
  return { scrollTop: app.scrollTop, max };
})()`);
check(
  "拉伸态：能滚到内容底部（水印控件全部可达）",
  Math.abs(scroll.scrollTop - scroll.max) < 2,
  `scrollTop=${scroll.scrollTop} / max=${scroll.max}`
);

check("全程无未捕获异常", pageErrors.length === 0, pageErrors.join(" | ") || "无");

console.log(`\n结果: ${pass} passed, ${fail} failed`);

ws.close();
chrome.kill();
server.close();
process.exit(fail === 0 ? 0 : 1);
