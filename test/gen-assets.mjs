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
`;

fs.writeFileSync(OUT, content);
console.log(`已生成 ${OUT}（${content.length} 字节）`);
