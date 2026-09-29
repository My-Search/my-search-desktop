/**
 * 「插件市场」图标三态回归（纯源码契约，无需浏览器）。
 *
 * 用户诉求：插件的 icon 加载出来后，兜底占位图 🧩 不应再显示。
 *
 * 背景：卡片图标位同时渲染「兜底 🧩」和 `<img class="icon-img">`，靠三个状态类切换：
 *   - `.icon-loading`：取图期。骨架流光 + 兜底 🧩 压暗（opacity 0.28）暗示「正在取图」；
 *   - `.icon-ready`：图已就绪。**必须把兜底 🧩 隐藏**（opacity 0）——否则透明底
 *     （SVG / 去背 PNG）图标会透出底下的 🧩，用户看到的就是「图标 + 占位」叠在一起；
 *   - `.icon-failed`：取图失败。图片让位（display:none），露回兜底 🧩。
 *
 * 钉死的契约：
 *   1. `.icon-ready .icon-fallback { opacity: 0 }` —— 就绪即隐藏占位（本次 bug）；
 *   2. `.icon-loading .icon-fallback { opacity: .28 }` —— 加载期保留暗淡占位；
 *   3. `.icon-failed .icon-img { display: none }` —— 失败退回 🧩；
 *   4. 兜底有透明度过渡（避免闪烁/突兀）；
 *   5. index.js 的 load/error 事件把 `.icon-loading` 切到 `.icon-ready` / `.icon-failed`。
 *
 * 用法: node test/market-icon-states.test.mjs
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(path.join(root, "plugins/market/ui/detail.css"), "utf8");
const js = readFileSync(path.join(root, "plugins/market/ui/index.js"), "utf8");

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log("PASS ", name);
  } else {
    fail++;
    console.log("FAIL ", name, extra ? ` — ${extra}` : "");
  }
};

/* ---------- 1. 三态的核心 CSS 契约 ---------- */
// 就绪：占位必须隐藏（本次修复点）。允许 0 或 0.0 写法。
check(
  "icon-ready：兜底占位 🧩 被隐藏（opacity: 0）",
  /\.plugin-icon\.icon-ready\s+\.icon-fallback\s*\{[^}]*opacity:\s*0(\.0+)?\s*;/.test(css),
);
check(
  "icon-ready：图标本身可见（opacity: 1）",
  /\.plugin-icon\.icon-ready\s+\.icon-img\s*\{[^}]*opacity:\s*1\s*;/.test(css),
);

// 就绪：容器底板必须去掉（本次报的「图标加载好背部还有图」）。
// 透明底图标加载好后，若 .plugin-icon 的浅蓝底板还在，会从图标背后透出来。
check(
  "icon-ready：容器底板被去掉（background: transparent）",
  /\.plugin-icon\.icon-ready\s*\{[^}]*background:\s*transparent\s*;/.test(css),
);
// 底板仍要服务于「加载中」态（骨架流光需要承载面）
check(
  "icon-loading：容器保留底板（骨架承载面）",
  /\.plugin-icon\.icon-loading\s*\{[^}]*background:\s*var\(/.test(css),
);

// 加载中：保留暗淡占位（不写死为 0，否则加载期图标位塌成空框）
check(
  "icon-loading：兜底占位压暗保留（opacity .28）",
  /\.plugin-icon\.icon-loading\s+\.icon-fallback\s*\{[^}]*opacity:\s*\.?0?\.28\s*;/.test(css),
);

// 失败：图片让位，露回兜底
check(
  "icon-failed：破损图片不显示（display: none）",
  /\.plugin-icon\.icon-failed\s+\.icon-img\s*\{[^}]*display:\s*none\s*;/.test(css),
);

// 兜底带过渡，切换不突兀
check(
  "兜底占位带透明度过渡（transition: opacity）",
  /\.plugin-icon\s+\.icon-fallback\s*\{[^}]*transition:\s*opacity/.test(css),
);

/* ---------- 2. 状态切换逻辑：load → ready / error → failed ---------- */
check(
  "index.js：图片 load 事件把 icon-loading 切到 icon-ready",
  /classList\.replace\(\s*["']icon-loading["']\s*,\s*["']icon-ready["']\s*\)/.test(js),
);
check(
  "index.js：图片 error 事件把 icon-loading 切到 icon-failed",
  /classList\.replace\(\s*["']icon-loading["']\s*,\s*["']icon-failed["']\s*\)/.test(js),
);
// 卡片图标渲染时兜底与图片同时在 DOM（图片盖在上面），基础结构不能丢
check(
  "index.js：图标容器同时渲染 icon-fallback 与 icon-img",
  /class="plugin-icon icon-loading"[\s\S]*?icon-fallback[\s\S]*?class="icon-img"/.test(js),
);

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
