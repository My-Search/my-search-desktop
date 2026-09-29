/**
 * 从油猴脚本中提取内嵌图标资源，生成 src/lib/assets.ts
 * 用法：node test/gen-assets.mjs
 */
import fs from "fs";

const SCRIPT = "我的搜索-7.9.5.js";
const OUT = "src/lib/assets.ts";

const src = fs.readFileSync(SCRIPT, "utf8");
const sketch = src.match(/"sketch":"(data:image\/png;base64,[A-Za-z0-9+/=]+)"/);
const script = src.match(/"script":"(data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+)"/);
const vassal = src.match(/let vassalSvg = `([\s\S]*?)`;/);
const errIcon = src.match(/let loadErrorTagIcon = "(data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+)";/);
const logo = src.match(/let menu_icon = "(data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+)";/);

const a = {
  logo: logo && logo[1],
  sketchIcon: sketch && sketch[1],
  scriptIcon: script && script[1],
  vassalSvg: vassal && vassal[1],
  loadErrorIcon: errIcon && errIcon[1],
};

for (const [k, v] of Object.entries(a)) {
  if (!v) throw new Error(`提取失败: ${k}`);
}

const q = (s) => JSON.stringify(s);

// ICON_LOADING_PLACEHOLDER 不来自油猴脚本，是手工设计的资源（12 条辐条的转圈）。
// 它不是从原脚本提取的，所以「保留现有值」而不是每次重新生成——
// 否则重新运行本脚本会把已调好的图标覆盖回旧版。
//
// 透明底（原先是自带白底的 JPEG，深色主题下会显示成白方块）。
// 深浅两套配色由 SVG **内部的** @media (prefers-color-scheme: dark) 提供，
// 它在 <img> 里同样生效——比宿主 CSS 的 filter:invert() 更可靠：
// invert 会把「亮头」翻成暗色，深底上反而更糊（实测最弱仅 1.14:1）。
const DEFAULT_LOADING_ICON =
  "data:image/svg+xml;base64," +
  Buffer.from(
    "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\" width=\"100\" height=\"100\">\n  <defs>\n    <rect id=\"bar\" x=\"46\" y=\"10\" width=\"8\" height=\"20\" rx=\"4\" />\n  </defs>\n  <use href=\"#bar\" transform=\"rotate(0 50 50)\" fill=\"#000000\" />\n  <use href=\"#bar\" transform=\"rotate(30 50 50)\" fill=\"#C0C0C0\" />\n  <use href=\"#bar\" transform=\"rotate(60 50 50)\" fill=\"#A0A0A0\" />\n  <use href=\"#bar\" transform=\"rotate(90 50 50)\" fill=\"#808080\" />\n  <use href=\"#bar\" transform=\"rotate(120 50 50)\" fill=\"#808080\" />\n  <use href=\"#bar\" transform=\"rotate(150 50 50)\" fill=\"#606060\" />\n  <use href=\"#bar\" transform=\"rotate(180 50 50)\" fill=\"#606060\" />\n  <use href=\"#bar\" transform=\"rotate(210 50 50)\" fill=\"#404040\" />\n  <use href=\"#bar\" transform=\"rotate(240 50 50)\" fill=\"#404040\" />\n  <use href=\"#bar\" transform=\"rotate(270 50 50)\" fill=\"#303030\" />\n  <use href=\"#bar\" transform=\"rotate(300 50 50)\" fill=\"#303030\" />\n  <use href=\"#bar\" transform=\"rotate(330 50 50)\" fill=\"#101010\" />\n  <style>\n    /* 深色主题：整圈改为浅色档，保证在深色底板上清晰可见。\n       取值以「对比度不低于浅色档」为准（最弱 2.27:1 vs 浅色档 1.82:1）。 */\n    @media (prefers-color-scheme: dark) {\n      use[transform=\"rotate(0 50 50)\"]{fill:#ffffff}\n      use[transform=\"rotate(30 50 50)\"]{fill:#ececec}\n      use[transform=\"rotate(60 50 50)\"]{fill:#dcdcdc}\n      use[transform=\"rotate(90 50 50)\"]{fill:#cacaca}\n      use[transform=\"rotate(120 50 50)\"]{fill:#cacaca}\n      use[transform=\"rotate(150 50 50)\"]{fill:#b8b8b8}\n      use[transform=\"rotate(180 50 50)\"]{fill:#b8b8b8}\n      use[transform=\"rotate(210 50 50)\"]{fill:#a8a8a8}\n      use[transform=\"rotate(240 50 50)\"]{fill:#a8a8a8}\n      use[transform=\"rotate(270 50 50)\"]{fill:#9c9c9c}\n      use[transform=\"rotate(300 50 50)\"]{fill:#9c9c9c}\n      use[transform=\"rotate(330 50 50)\"]{fill:#909090}\n    }\n  </style>\n</svg>"
  ).toString("base64");

let loadingIcon = DEFAULT_LOADING_ICON;
if (fs.existsSync(OUT)) {
  const prev = fs.readFileSync(OUT, "utf8");
  const m = prev.match(/ICON_LOADING_PLACEHOLDER\s*=\s*("(?:[^"\\]|\\.)*")/);
  if (m) loadingIcon = JSON.parse(m[1]);
}

// PLUGIN_BADGE_SVG 同样不是从油猴脚本提取的：它是插件项的「左下角角标」，
// 用来在结果列表里把插件贡献的条目与订阅/脚本项区分开。同样保留现有值。
//
// 内容是用户**逐字给定**的 SVG（含 iconfont 的 t / p-id 属性——只作标识，
// 不影响渲染）。这里不做裁剪/重排：端到端测试拿页面 DOM 的 outerHTML 与这份
// 字符串做全等断言，少一个属性就会红。
const DEFAULT_PLUGIN_BADGE =
  '<svg t="1789530520078" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="8552" width="200" height="200">' +
  '<path d="M1024 601.6v319.926857s0 102.4-102.4 102.4H102.4c-102.4 0-102.4-102.4-102.4-102.4V102.4S0-0.073143 102.4-0.073143h819.2C1024-0.073143 1024 102.4 1024 102.4l0.073143 277.138286L1024 601.6zM950.857143 658.285714V292.498286 146.285714c0-51.273143-73.142857-73.216-73.142857-73.216H146.285714C95.085714 73.069714 73.142857 146.285714 73.142857 146.285714v731.428572s21.942857 73.142857 73.142857 73.142857h731.428572c51.2 0 73.142857-73.142857 73.142857-73.142857V658.285714z m-573.659429 52.150857s-92.379429 106.934857 136.411429 118.418286v38.546286S182.125714 930.742857 204.8 674.596571C212.992 583.094857 448.877714 373.76 448.877714 373.76L249.051429 203.117714h513.024s56.32-11.849143 56.32 53.394286v462.555429L590.262857 509.952 377.197714 710.436571z" fill="#999999" p-id="8553"></path>' +
  "</svg>";

let pluginBadgeSvg = DEFAULT_PLUGIN_BADGE;
if (fs.existsSync(OUT)) {
  const prev = fs.readFileSync(OUT, "utf8");
  const m = prev.match(/PLUGIN_BADGE_SVG\s*=\s*("(?:[^"\\]|\\.)*")/);
  if (m) pluginBadgeSvg = JSON.parse(m[1]);
}

const content = `/**
 * 静态资源（图标/SVG）- 我的搜索桌面版
 * 由油猴脚本"我的搜索"（v7.9.5）内嵌资源提取，保证与原版视觉一致。
 * 本文件由 test/gen-assets.mjs 生成，请勿手工编辑。
 */

/** 搜索框右侧 LOGO（叶子图标） */
export const LOGO_ICON = ${q(a.logo)};

/** sketch（简述文本）类型数据项图标 */
export const SKETCH_ICON = ${q(a.sketchIcon)};

/** script（脚本）类型数据项图标 */
export const SCRIPT_ICON = ${q(a.scriptIcon)};

/** vassal（相关联/同类项）图标 */
export const VASSAL_SVG = ${q(a.vassalSvg)};

/** 图标加载失败时的占位图 */
export const LOAD_ERROR_ICON = ${q(a.loadErrorIcon)};

/** 图标加载中的占位（手工设计，重新生成本文件时保留原值） */
export const ICON_LOADING_PLACEHOLDER = ${q(loadingIcon)};

/**
 * 插件项角标（左下角，用户逐字给定，重新生成本文件时保留原值）。
 * 插件贡献的条目在结果列表里用它区别于订阅数据项 / 旧版 [脚本] 项。
 */
export const PLUGIN_BADGE_SVG = ${q(pluginBadgeSvg)};
`;

fs.writeFileSync(OUT, content);
console.log(`已生成 ${OUT}（${content.length} 字节）`);
