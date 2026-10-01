/**
 * 中文字体探测与兜底（**少量 IO，可注入依赖以便单测**）。
 *
 * ## 为什么单独一个文件
 *
 * 水印「中文变方块」的头号原因是 drawtext 没拿到中文字体：插件自带的
 * BtbN Windows 构建**没有 fontconfig 配置**（实测刷 `Fontconfig error:
 * Cannot load default config file`），此时不写 `fontfile=` 就会回退到一个
 * 无中文字形的默认字体，中文全部渲染成 □□□□。
 *
 * 因此后端必须在**用户没选字体**时，自动挑一个系统中文字体塞进
 * `fontfile=`。这段逻辑要能单测（本机未必装对应字体、CI 更没有），
 * 又不能污染纯函数的 watermark.mjs，故单独成模块、依赖可注入。
 *
 * ## 探测顺序
 *
 * 1. 各平台**已知路径白名单**（msyh/simhei/simsun…），命中即用，最稳；
 * 2. 再扫一遍系统字体目录，按「文件名像 CJK 字体」补充（覆盖非默认安装、
 *    自定义字体名等白名单没列到的情况）。扫描失败不致命。
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Windows 默认字体目录（可用 opts.fontDir 覆盖，便于测试注入） */
export const WIN_FONT_DIR = "C:\\Windows\\Fonts";

/**
 * 各平台已知的中文字体候选（按优先级：越好用/越常见的排前面）。
 * 只列**文件**；不存在的会被 existsSync 过滤掉。
 */
export const KNOWN_FONTS = {
  win32: [
    "C:\\Windows\\Fonts\\msyh.ttc", // 微软雅黑（最常用，优先）
    "C:\\Windows\\Fonts\\msyhbd.ttc",
    "C:\\Windows\\Fonts\\msyhl.ttc",
    "C:\\Windows\\Fonts\\simhei.ttf", // 黑体
    "C:\\Windows\\Fonts\\simsun.ttc", // 宋体
    "C:\\Windows\\Fonts\\simkai.ttf", // 楷体
    "C:\\Windows\\Fonts\\simfang.ttf", // 仿宋
    "C:\\Windows\\Fonts\\deng.ttf", // 等线
    "C:\\Windows\\Fonts\\Deng.ttf",
    "C:\\Windows\\Fonts\\msjh.ttc", // 微软正黑（繁体）
    "C:\\Windows\\Fonts\\mingliu.ttc",
    "C:\\Windows\\Fonts\\kaiu.ttf",
  ],
  darwin: [
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
  ],
  linux: [
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/arphic/uming.ttc",
    "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
  ],
};

/**
 * 「文件名像 CJK 字体」的正则——用于扫描字体目录时补捞白名单之外的字体。
 * 保守起见只匹配明确带中文字形的家族名，避免误把纯拉丁字体当中文字体。
 */
export const CJK_FONT_RE =
  /^(msyh|msjh|simhei|simsun|simkai|simfang|deng|mingliu|kaiu|msyi|yahei|noto ?sans ?cjk|noto ?serif ?cjk|source ?han|pingfang|hiragino ?sans ?gb|wqy|droid ?sans ?fallback|arphic|uming|ukai)/i;

/** 允许的字体扩展名（扫目录时用） */
const FONT_EXT_RE = /\.(ttf|ttc|otf|otc|woff2?)$/i;

/**
 * 列出本机可用的中文字体（绝对路径数组，已去重、保序）。
 *
 * @param {object} [opts]
 * @param {string} [opts.platform]  覆盖平台（测试用）
 * @param {Function} [opts.exists]  覆盖 existsSync（测试用）
 * @param {Function} [opts.readdir] 覆盖 readdirSync（测试用）
 * @param {string} [opts.fontDir]   覆盖 Windows 字体目录（测试用）
 */
export function listFonts(opts = {}) {
  const platform = opts.platform || process.platform;
  const exists = typeof opts.exists === "function" ? opts.exists : existsSync;
  const readdir = typeof opts.readdir === "function" ? opts.readdir : readdirSync;

  const key = platform === "win32" ? "win32" : platform === "darwin" ? "darwin" : "linux";
  const out = [];
  const seen = new Set();
  const push = (p) => {
    if (p && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  };

  // 1. 白名单（按优先级）
  for (const p of KNOWN_FONTS[key] || []) {
    try {
      if (exists(p)) push(p);
    } catch {
      // 单个探测失败不影响其它
    }
  }

  // 2. 扫字体目录补捞（Windows 扫 C:\Windows\Fonts；Unix 扫几个常见目录）
  const dirs =
    key === "win32"
      ? [opts.fontDir || WIN_FONT_DIR]
      : ["/usr/share/fonts", "/usr/local/share/fonts", "/Library/Fonts", "/System/Library/Fonts"];
  for (const dir of dirs) {
    let names;
    try {
      names = readdir(dir);
    } catch {
      continue; // 目录不存在/不可读：跳过
    }
    const matched = [];
    for (const name of names) {
      if (typeof name !== "string" || !FONT_EXT_RE.test(name)) continue;
      if (!CJK_FONT_RE.test(name)) continue;
      matched.push(name);
    }
    // 目录内按名字排序，保证同一台机器上结果稳定可复现
    matched.sort((a, b) => a.localeCompare(b));
    for (const name of matched) {
      const full = join(dir, name);
      try {
        if (exists(full)) push(full);
      } catch {
        // 忽略
      }
    }
  }

  return out;
}

/**
 * 水印规格兜底：文字水印若未指定字体（或指定的字体已不存在），则自动补一个
 * 探测到的中文字体。
 *
 * 返回**新的 spec**（不原地改），并附带 `missingFont` 标记：true 表示
 * 想要中文字体但本机一个都没找到（调用方据此给出「可能显示方块」提示）。
 * 非文字水印时原样返回。
 *
 * 「指定的字体已不存在」也要兜底：用户之前选的字体被卸载后，若仍把旧路径
 * 写进 ffmpeg，会直接报错让录制/导出失败，比显示方块更糟。
 *
 * @param {object} spec   已 normalize 的水印规格
 * @param {object} [opts] 透传给 listFonts 的注入项（另支持 opts.exists）
 * @returns {{spec: object, missingFont: boolean, font: string|null}}
 */
export function ensureWatermarkFont(spec, opts = {}) {
  const s = spec && typeof spec === "object" ? spec : {};
  const exists = typeof opts.exists === "function" ? opts.exists : existsSync;
  const fileOk = (p) => {
    try {
      return !!p && exists(p);
    } catch {
      return false;
    }
  };

  // 图片水印不涉及 drawtext 字体
  if (s.type === "image") return { spec: s, missingFont: false, font: null };
  // 用户已指定且文件仍在：直接尊重
  if (s.fontFile && fileOk(s.fontFile)) return { spec: s, missingFont: false, font: s.fontFile };

  const fonts = listFonts(opts);
  const pick = fonts[0] || null;
  if (!pick) return { spec: s, missingFont: true, font: null };
  return { spec: { ...s, fontFile: pick }, missingFont: false, font: pick };
}
