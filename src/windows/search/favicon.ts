/**
 * favicon 工具（还原油猴版 getFaviconImgHtml / getFaviconAPI / faviconSources）
 *
 * 图标按 faviconSources 顺序依次尝试，全部失败则显示错误图标。
 */
import { parseUrl, clearUrlSearchTemplate, escapeAttr, isUrl } from "../../lib/util";
import { SCRIPT_ICON, SKETCH_ICON, ICON_LOADING_PLACEHOLDER, LOAD_ERROR_ICON } from "../../lib/assets";
import type { SearchItem } from "../../types/index";

/** favicon 源模板（还原 faviconSources） */
export const FAVICON_TEMPLATES = [
  "https://api.iowen.cn/favicon/${domain}.png", // 主源
  "https://api.xinac.net/icon/?url=${rootUrl}", // 备选1
  "https://ico.txmulu.com/${domain}", // 备选2
  "${rootUrl}/favicon.ico", // 永久兜底
];

/** 把模板中的 ${domain} / ${rootUrl} 替换为真实值 */
export function fillTemplate(template: string, url: string): string {
  const info = parseUrl(clearUrlSearchTemplate(url));
  if (!info.rootUrl) return "";
  return template
    .replace(/\$\s*?{[^{}]*rootUrl[^{}]*}/g, info.rootUrl)
    .replace(/\$\s*?{[^{}]*domain[^{}]*}/g, info.domain || "");
}

/** 生成结果项 favicon 源 URL（还原 getFaviconAPI） */
export function getFaviconAPI(url: string, index = 0): string {
  const template = FAVICON_TEMPLATES[index] || FAVICON_TEMPLATES[FAVICON_TEMPLATES.length - 1];
  return fillTemplate(template, url);
}

/** 获取所有 favicon 源 URL 列表（用作 data-favicons 的懒加载顺序） */
export function getAllFaviconUrls(url: string): string[] {
  return FAVICON_TEMPLATES.map((t) => fillTemplate(t, url)).filter(Boolean);
}

/** 结果项图标渲染结果 */
export interface FaviconInfo {
  /** 最终 src（自定义图标 / 加载占位） */
  src: string;
  /** 是否需要懒加载多源回退（URL 类型） */
  lazy: boolean;
  /** 懒加载源列表（lazy=true 时有效） */
  favicons: string[];
}

/**
 * 计算结果项图标（还原 getFaviconImgHtml）
 * - 自定义 icon（脚本项）优先
 * - sketch/script 类型用内置图标
 * - 其它（URL 类型）用 favicon 服务：加载中显示占位，成功后替换，失败依次回退
 */
export function resolveFavicon(item: SearchItem | null | undefined): FaviconInfo {
  const empty: FaviconInfo = { src: "", lazy: false, favicons: [] };
  if (item == null) return empty;
  const resource = String(item.resource || "").trim();
  let customIcon: string | null = null;
  if (item.icon != null) {
    customIcon = item.icon;
  } else {
    let type = item.type;
    const typesAndImg: Record<string, string> = { sketch: SKETCH_ICON, script: SCRIPT_ICON };
    type = type === "url" || type === "sketch" ? (isUrl(resource) ? "url" : "sketch") : type;
    if (type !== "url") customIcon = typesAndImg[type ?? ""] ?? null;
  }
  if (customIcon != null) {
    return { src: customIcon, lazy: false, favicons: [] };
  }
  const faviconUrls = getAllFaviconUrls(resource);
  return {
    src: ICON_LOADING_PLACEHOLDER,
    lazy: true,
    favicons: faviconUrls,
  };
}

/** data-favicons 属性值（与原版一致用 | 分隔） */
export function faviconsAttr(favicons: string[]): string | undefined {
  return favicons.length > 0 ? escapeAttr(favicons.join("|")) : undefined;
}

/** 图标加载失败时的占位图 */
export { LOAD_ERROR_ICON };
