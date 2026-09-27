/**
 * 回归测试：插件市场在「插件自定义尺寸」下能向下滚动。
 *
 * 用户反馈：在插件市场里拖右下角改大窗口后，页面滚不动了——「下面还有卡片，
 * 但滚不下去」。
 *
 * 根因（宿主与插件的滚动责任分工被破坏）：
 *   - 宿主的 `.plugin-sized` 模式（style.css）把 `#text_show` 设成
 *     `overflow: hidden`，并给插件根节点 `flex: 1 1 auto; min-height: 0`，
 *     即**把滚动责任整个下放给插件内部**（file-search 的 `.fs-list`、
 *     pi-agent 的会话区都遵守这个契约）；
 *   - 插件市场此前是普通 block、内部没有任何滚动容器。于是内容被
 *     `#text_show` 裁掉，而页面上**没有任何元素可滚动**：`scrollers = []`，
 *     滚动条不出现、滚轮无反应。
 *
 * 契约（本测试钉死）：
 *   1. 拉伸态下 `.market-plugins` 是滚动区：`scrollHeight > clientHeight`、
 *      `overflow-y: auto`，且能滚到 `scrollHeight - clientHeight` 处；
 *   2. 滚动只发生在列表内部——标签页 / 搜索行的位置在滚动前后不变，
 *      分页条始终完整落在 `#text_show` 可视区内（不被裁）；
 *   3. 全程没有任何元素内容被静默裁掉；
 *   4. **非拉伸态（默认尺寸）不回归**：此时 `.page` 无确定高度，列表退回内容
 *      高度、不产生内部滚动，滚动仍由 `#text_show` 承担（`overflow-y: auto`）。
 *
 * 为什么用真实浏览器：`min-height: auto` 这个 flex 默认值、以及
 * `overflow: hidden` 下「元素仍保留 scrollTop 但不响应滚轮」的行为，都是
 * 计算样式/布局层面的，纯源码断言测不出来——本 bug 正是漏在网上。
 *
 * 用法: node test/market-scroll.test.mjs
 * 需要本机装有 Chrome / Edge；找不到浏览器时跳过（退出码 0）。
 */
import { createServer } from "http";
import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const marketHtml = readFileSync(path.join(root, "plugins/market/ui/detail.html"), "utf8");
const marketCss = readFileSync(path.join(root, "plugins/market/ui/detail.css"), "utf8");
const hostCss = readFileSync(path.join(root, "src/css/style.css"), "utf8");

/* ============ 复刻宿主的 scopeCss（与 src/lib/util.ts 同口径）============ */
/* 直接 import util.ts 需要编译 TS；宿主对插件 CSS 的处理规则很窄（裸 html/body
   映射到容器前缀、@media 递归），这里按其行为复刻，并在下方断言里校验前缀生效。 */
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
const bodyInner = marketHtml
  .match(/<body[^>]*>([\s\S]*?)<\/body>/i)[1]
  .replace(/<script[\s\S]*?<\/script>/gi, "");

/**
 * 按宿主真实结构搭出布局链。
 *
 * 用真实 `src/css/style.css`（含 `.plugin-sized` 那整段），因此「宿主侧的滚动
 * 契约」是被真正复现的，而不是测试自己编的一套近似规则。
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
            <style class="ms-plugin-style">${scopeCss(marketCss, PREFIX)}</style>
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

const userDir = path.join(root, "test", "_chrome-profile-market-scroll");
const chrome = spawn(
  bin,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    // 固定窗口宽度 > 760px：否则会命中 detail.css 的窄屏 @media，量到的
    // hero/tabs/search 高度是响应式值（76/38/32），与桌面值（88/42/34）不同，
    // 断言就失去意义。
    "--window-size=1000,700",
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
  const r = await S("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  }, sessionId);
  if (r.result?.exceptionDetails) {
    throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 700));
  }
  return r.result?.result?.value;
};

/** 塞满 20 张卡片（内容必然高于窗口），并造出分页条 */
const FILL = `(() => {
  const list = document.getElementById("market-list");
  const pager = document.getElementById("market-pager");
  document.getElementById("market-loading").style.display = "none";
  list.style.display = ""; pager.style.display = "flex";
  list.innerHTML = Array.from({length: 20}, (_, i) =>
    '<div class="plugin-card"><div class="plugin-icon">A</div>' +
    '<div class="plugin-main"><div class="plugin-name">插件 ' + i + '</div>' +
    '<div class="plugin-desc">描述文本 '.repeat(3) + '</div></div>' +
    '<div class="plugin-action"><button class="btn-market">安装</button></div></div>').join("");
  pager.innerHTML = '<span class="pager-info">共 20 个</span>' +
    Array.from({length:5},(_,i)=>'<button class="pager-btn'+(i===0?' active':'')+'">'+(i+1)+'</button>').join("");
})()`;

/**
 * 测量 + 「被裁」检测。
 *
 * 被裁的判定：元素底边超出 `#text_show` 可视区底边，且该元素不在一个可滚动的
 * 祖先里——在拉伸态下 `#text_show` 是 `overflow:hidden`，超出即永久不可达。
 * 为简化，这里对「固定控件」逐个判 bottom 是否越界（它们本就不该移动）。
 */
const MEASURE = `(() => {
  const ts = document.getElementById("text_show");
  const vpBottom = Math.round(ts.getBoundingClientRect().bottom);
  const list = document.getElementById("market-list");
  const pager = document.getElementById("market-pager");
  const tabs = document.querySelector(".tabs");
  const searchRow = document.querySelector(".search-row");
  const box = (el) => { const r = el.getBoundingClientRect(); return {
    top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }; };
  const clipped = [];
  for (const el of [pager, tabs, searchRow]) {
    const r = el.getBoundingClientRect();
    if (r.bottom > vpBottom + 0.5) {
      clipped.push((el.id || el.className) + " bottom=" + Math.round(r.bottom) + " > " + vpBottom);
    }
  }
  return {
    textShow: { top: Math.round(ts.getBoundingClientRect().top), bottom: vpBottom,
                scrollH: ts.scrollHeight, clientH: ts.clientHeight,
                overflowY: getComputedStyle(ts).overflowY },
    list: { ...box(list), scrollH: list.scrollHeight, clientH: list.clientHeight,
            overflowY: getComputedStyle(list).overflowY,
            scrollable: list.scrollHeight - list.clientHeight > 1 },
    tabs: box(tabs), searchRow: box(searchRow), pager: box(pager),
    hero: box(document.querySelector(".hero")),
    clipped,
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

/* ============ 1. 拉伸态：列表必须是滚动区 ============ */
await S("Page.navigate", { url }, sessionId);
await new Promise((r) => setTimeout(r, 800));
await evalJs(FILL);
const sized = await evalJs(MEASURE);

check(
  "拉伸态：列表成为滚动区（内容高于可视区）",
  sized.list.scrollable,
  `scrollH=${sized.list.scrollH} clientH=${sized.list.clientH}`
);
check("拉伸态：列表 overflow-y = auto", sized.list.overflowY === "auto", sized.list.overflowY);
check(
  "拉伸态：列表确实是本页唯一滚动区（#text_show 已禁滚）",
  sized.textShow.overflowY === "hidden",
  `#text_show overflowY=${sized.textShow.overflowY}`
);

/* ============ 2. 能真的滚到底 ============ */
const scroll = await evalJs(`(() => {
  const list = document.getElementById("market-list");
  list.scrollTop = list.scrollHeight;
  const max = list.scrollHeight - list.clientHeight;
  return { scrollTop: list.scrollTop, max };
})()`);
check(
  "拉伸态：能滚到列表底部（内容全部可达）",
  Math.abs(scroll.scrollTop - scroll.max) < 2,
  `scrollTop=${scroll.scrollTop} / max=${scroll.max}`
);

/* ============ 3. 固定控件不跟着滚、分页条不被裁 ============ */
const afterScroll = await evalJs(MEASURE);
check(
  "拉伸态：滚动后标签页未被顶走（scrollTop 不落在 #text_show 上）",
  afterScroll.tabs.top === sized.tabs.top,
  `tabs.top ${sized.tabs.top} → ${afterScroll.tabs.top}`
);
check(
  "拉伸态：滚动后搜索行位置不变",
  afterScroll.searchRow.top === sized.searchRow.top,
  `searchRow.top ${sized.searchRow.top} → ${afterScroll.searchRow.top}`
);
check("拉伸态：分页条未被裁（完整落在可视区内）", sized.clipped.length === 0,
  sized.clipped.join("; ") || "无裁剪");

/* ============ 3.5 固定区不被压缩（只有列表该动）============ */
/* flex 子项默认 flex-shrink: 1，窗口比内容矮时会把所有子项一起压扁——实测
   标签页会被从 42px 压到 26px。这里钉死「控件保持设计高度」，因为用户期望的
   是「控件原样、列表自己出滚动条」。 */
check("拉伸态：hero 未被压缩（保持 88px）", Math.abs(sized.hero.h - 88) < 1, `h=${sized.hero.h}`);
check("拉伸态：标签页未被压缩（保持 42px）", Math.abs(sized.tabs.h - 42) < 1, `h=${sized.tabs.h}`);
check("拉伸态：搜索行未被压缩（保持 34px）", Math.abs(sized.searchRow.h - 34) < 1, `h=${sized.searchRow.h}`);
check("拉伸态：分页条未被压缩（保持 43px）", Math.abs(sized.pager.h - 43) < 1, `h=${sized.pager.h}`);

/* ============ 4. 非拉伸态不回归（滚动仍归 #text_show）============ */
currentPage = buildPage(false);
await S("Page.navigate", { url: url + "?plain=1" }, sessionId);
await new Promise((r) => setTimeout(r, 800));
await evalJs(FILL);
const plain = await evalJs(MEASURE);
check(
  "非拉伸态：滚动仍由 #text_show 承担（overflow-y = auto）",
  plain.textShow.overflowY !== "hidden",
  `#text_show overflowY=${plain.textShow.overflowY}`
);
check(
  "非拉伸态：列表退回内容高度、不产生内部滚动",
  !plain.list.scrollable,
  `scrollH=${plain.list.scrollH} clientH=${plain.list.clientH}`
);

check("全程无未捕获异常", pageErrors.length === 0, pageErrors.join(" | ") || "无");

console.log(`\n结果: ${pass} passed, ${fail} failed`);

ws.close();
chrome.kill();
server.close();
process.exit(fail === 0 ? 0 : 1);
