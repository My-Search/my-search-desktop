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

// ICON_LOADING_PLACEHOLDER 不来自油猴脚本，是手工设计的资源（四叶风车）。
// 它不是从原脚本提取的，所以「保留现有值」而不是每次重新生成——
// 否则重新运行本脚本会把已调好的图标覆盖回旧版。
const DEFAULT_LOADING_ICON =
  "data:image/svg+xml;base64," +
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><rect x="1" y="1" width="22" height="22" rx="4" fill="#e8eaed"/><circle cx="12" cy="12" r="4" fill="none" stroke="#9aa0a6" stroke-width="2" stroke-dasharray="4 2"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></circle></svg>'
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
