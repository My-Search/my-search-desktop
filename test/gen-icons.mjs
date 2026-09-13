/**
 * 生成「我的搜索」桌面版的圆角图标资源（分平台，各自符合本平台审美）
 *
 * 用法：node test/gen-icons.mjs
 *
 * 关键点：**macOS 与 Windows 的图标网格完全不同**
 * - macOS（Big Sur 起）：图标主体只占画布的 824/1024（约 80%），四周留白，
 *   因为 Dock 里图标是放在"搁板"上的，Apple 的网格刻意留呼吸空间。
 * - Windows：没有这个安全区约定，原生图标几乎铺满画布（实测 calc / explorer /
 *   notepad / powershell 的外轮廓都在 97%~100%）。
 *   若把 macOS 网格直接拿去 Windows 用，图标就会比旁边的程序明显小一圈。
 *
 * 因此这里生成两套母版：
 * - test/_icons/icon-master.png     macOS / Linux 网格（主体 824）
 * - test/_icons/icon-master-win.png Windows 网格（主体 1000，铺满画布）
 *
 * 托盘图标（无白底方块）：
 * - tray.png      彩色叶子 + 透明背景（Windows / Linux）
 * - tray-mono.png 单色模板图标（macOS，系统按浅色/深色菜单栏自动反色）
 */
import { Resvg } from '@resvg/resvg-js';
import { PNG } from 'pngjs';
import { getSvgPath } from 'figma-squircle';
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'test', '_icons');
const ICON_DIR = path.join(ROOT, 'src-tauri', 'icons');

const CANVAS = 1024;

// ---------- macOS：Big Sur 起的官方图标网格 ----------
const MAC = {
  plate: 824,          // 主体 824（四周留白 100）
  radiusRatio: 0.225,  // 圆角半径 185.4 = 824 * 0.225
  smoothing: 0.6,      // 连续曲率（squircle）平滑度
  leafRatio: 0.62,     // 叶子宽度 / 主体宽度
  shadow: { dy: 10, blur: 10, opacity: 0.30 }, // Apple 官方模板投影
};

// ---------- Windows：铺满画布 ----------
const WIN = {
  plate: 1000,         // 铺满（留 12px 防裁切）
  radiusRatio: 0.225,  // 圆角比例保持一致
  smoothing: 0.6,
  leafRatio: 0.66,     // 主体变大后，叶子占比同步提高
  shadow: { dy: 4, blur: 6, opacity: 0.22 },
};

// ---------- 托盘 ----------
// 叶子是「宽扁」图形（宽:高 ≈ 1.3:1）。
// 托盘位图只有 16~24px，字形太小会糊成一团，因此按**宽度**顶到接近满幅，
// 视觉重量才与 Windows 原生托盘图标（实测外轮廓 0.96~1.0）一致。
const TRAY_GLYPH_W = 0.98;   // 彩色托盘：叶子宽度 / 画布宽度
const MONO_GLYPH_W = 0.92;   // macOS 模板图标：留一点边距更符合菜单栏惯例
const TRAY_SIZE = 32;
const MONO_SIZE = 88;

// ---------- 提取原始叶子 SVG ----------
function loadLeafPaths() {
  const assets = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'assets.js'), 'utf8');
  const m = assets.match(/LOGO_ICON\s*=\s*"data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)"/);
  if (!m) throw new Error('未能从 src/lib/assets.js 提取 LOGO_ICON');
  const svg = Buffer.from(m[1], 'base64').toString('utf8');
  const paths = [...svg.matchAll(/<path\b[^>]*>/g)].map((x) => {
    const d = (x[0].match(/\bd="([^"]+)"/) || [])[1];
    const fill = (x[0].match(/\bfill="([^"]+)"/) || [])[1] || '#000000';
    if (!d) throw new Error(`无法解析 path: ${x[0]}`);
    return { d, fill };
  });
  if (!paths.length) throw new Error('原始 LOGO SVG 中未找到 <path>');
  return paths;
}

const render = (svg, size) =>
  new Resvg(svg, { fitTo: { mode: 'width', value: size }, background: 'rgba(0,0,0,0)' })
    .render()
    .asPng();

/** 从渲染结果的 alpha 通道取不透明像素的精确包围盒 */
function alphaBBox(pngBuffer) {
  const png = PNG.sync.read(pngBuffer);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      if (png.data[(y * png.width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (minX === Infinity) throw new Error('图像为空，无法测量包围盒');
  return { minX, minY, maxX, maxY };
}

const paths = loadLeafPaths();

const svgWrap = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}" ` +
  `width="${CANVAS}" height="${CANVAS}">${body}</svg>`;

/** 叶子等比缩放到 width 宽，视觉中心对齐到 (cx, cy) */
function leafGroup({ box, cx, cy, width, fill }) {
  const w = box.maxX - box.minX;
  const h = box.maxY - box.minY;
  const scale = width / w;
  const tx = cx - (w * scale) / 2;
  const ty = cy - (h * scale) / 2;
  const body = paths
    .map((p) => `<path d="${p.d}" fill="${fill || p.fill}"/>`)
    .join('');
  const t = `translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${scale.toFixed(6)}) ` +
    `translate(${(-box.minX).toFixed(3)} ${(-box.minY).toFixed(3)})`;
  return `<g transform="${t}">${body}</g>`;
}

// 精确测量叶子的视觉包围盒（相对 1024 viewBox）
const leafBox = alphaBBox(render(svgWrap(leafGroup({
  box: { minX: 0, minY: 0, maxX: CANVAS, maxY: CANVAS },
  cx: CANVAS / 2,
  cy: CANVAS / 2,
  width: CANVAS,
})), CANVAS));

/** 圆角主体（白底 + 柔和投影，否则白底在浅色背景上会"消失"） */
function plateGroup({ plate, radiusRatio, smoothing, shadow }) {
  const off = (CANVAS - plate) / 2;
  const d = getSvgPath({
    width: plate,
    height: plate,
    cornerRadius: plate * radiusRatio,
    cornerSmoothing: smoothing,
  });
  const defs = shadow
    ? '<defs><filter id="plate-shadow" x="-25%" y="-25%" width="150%" height="150%">' +
      `<feDropShadow dx="0" dy="${shadow.dy}" stdDeviation="${shadow.blur}" ` +
      `flood-color="#000000" flood-opacity="${shadow.opacity}"/></filter></defs>`
    : '';
  return defs +
    `<g transform="translate(${off} ${off})"><path d="${d}" fill="#ffffff"` +
    `${shadow ? ' filter="url(#plate-shadow)"' : ''}/></g>`;
}

/** 组装一个 App 图标（主体 + 居中叶子） */
function appIcon(cfg) {
  return svgWrap(
    plateGroup(cfg) +
    leafGroup({
      box: leafBox,
      cx: CANVAS / 2,
      cy: CANVAS / 2,
      width: cfg.plate * cfg.leafRatio,
    }),
  );
}

function write(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  console.log(`  ${path.relative(ROOT, file).replace(/\\/g, '/')}  (${buf.length} bytes)`);
}

// ===================== 主流程 =====================
const lw = leafBox.maxX - leafBox.minX;
const lh = leafBox.maxY - leafBox.minY;
console.log(`叶子视觉包围盒(1024): ${lw}×${lh}\n`);

const macSvg = appIcon(MAC);
const winSvg = appIcon(WIN);
// 托盘：透明背景（无白底方块）
const traySvg = svgWrap(leafGroup({
  box: leafBox, cx: CANVAS / 2, cy: CANVAS / 2, width: CANVAS * TRAY_GLYPH_W,
}));
const monoSvg = svgWrap(leafGroup({
  box: leafBox, cx: CANVAS / 2, cy: CANVAS / 2, width: CANVAS * MONO_GLYPH_W, fill: '#000000',
}));

console.log('生成资源：');
write(path.join(OUT_DIR, 'icon-master.svg'), Buffer.from(macSvg, 'utf8'));
write(path.join(OUT_DIR, 'icon-master-win.svg'), Buffer.from(winSvg, 'utf8'));
write(path.join(OUT_DIR, 'tray.svg'), Buffer.from(traySvg, 'utf8'));
write(path.join(OUT_DIR, 'tray-mono.svg'), Buffer.from(monoSvg, 'utf8'));
write(path.join(OUT_DIR, 'icon-master.png'), render(macSvg, CANVAS));
write(path.join(OUT_DIR, 'icon-master-win.png'), render(winSvg, CANVAS));
write(path.join(ICON_DIR, 'tray.png'), render(traySvg, TRAY_SIZE));
write(path.join(ICON_DIR, 'tray-mono.png'), render(monoSvg, MONO_SIZE));

console.log(
  '\n下一步：\n' +
  '  npx tauri icon test/_icons/icon-master.png     -o src-tauri/icons\n' +
  '  npx tauri icon test/_icons/icon-master-win.png -o src-tauri/icons/windows',
);
