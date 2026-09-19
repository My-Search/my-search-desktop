/**
 * 插件图标解析 —— 把清单里的 `icon` 引用变成 `<img src>` 能直接用的值。
 *
 * 清单里的图标有三种形态（与 manifest.ts 的 `isValidIconRef` 一一对应）：
 *   1. **插件目录内的相对路径**（`icon.png` / `assets/logo.svg`）——不能直接当
 *      URL 用，必须由宿主读文件转成 data URL（异步 IPC）；
 *   2. `data:` 内联资源——原样可用；
 *   3. `http(s):` 网络地址——原样可用（纯展示用途，不经过宿主的网络代理）。
 *
 * 设置面板（插件列表左侧的 logo）与搜索窗口（结果条目的图标）都要做同一件事：
 * 预读相对路径图标 → 缓存 → 同步查表取用。两边的 MIME 映射与「哪些引用需要
 * 读文件」的判定必须一致，因此集中在这里，避免各写一份慢慢漂移。
 *
 * 本模块只依赖 manifest.ts（同为纯逻辑叶子模块），Node 测试可直接导入。
 */

import { listSearchItems, type PluginManifest } from "./manifest.ts";

/** 图片扩展名 → MIME（决定 data URL 的媒体类型） */
const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
};

/**
 * 按扩展名取图标的 MIME。
 *
 * 先剥掉查询串/锚点（`icon.svg?v=2` 这种写法不该被当成扩展名 `svg?v=2`），
 * 未知扩展名按 png 处理——比 `application/octet-stream` 更容易被 WebView 接受。
 */
export function iconMimeOf(ref: string): string {
  const clean = String(ref ?? "").split("?")[0].split("#")[0];
  const ext = clean.includes(".") ? clean.split(".").pop()!.toLowerCase() : "";
  return IMAGE_MIME[ext] ?? "image/png";
}

/** 是否是「自带完整地址」的图标引用（无需读插件目录） */
export function isInlineIconRef(ref: string): boolean {
  return ref.startsWith("data:") || /^https?:\/\//i.test(ref);
}

/** 相对路径图标 + 文件内容（base64）→ 可直接用于 `<img src>` 的 data URL */
export function iconDataUrl(ref: string, base64: string): string {
  return `data:${iconMimeOf(ref)};base64,${base64}`;
}

/**
 * 一个插件需要**读文件**的图标引用（顶层 icon + 各搜索项 icon），去重保序。
 *
 * `data:` / `http(s):` 形态自带地址，不在返回之列——调用方直接用即可。
 */
export function iconRefsOf(manifest: PluginManifest | null | undefined): string[] {
  if (!manifest) return [];
  const out: string[] = [];
  const push = (ref: string | undefined): void => {
    if (!ref || isInlineIconRef(ref) || out.includes(ref)) return;
    out.push(ref);
  };
  push(manifest.icon);
  for (const it of listSearchItems(manifest)) push(it.icon);
  return out;
}

/**
 * 插件的「代表图标」引用（设置面板列表左侧的 logo 用）：
 * 优先取清单顶层的 `icon`；作者只写在搜索项上的，退回第一条搜索项的 icon。
 *
 * 与 `buildPluginItems` 的取值顺序**刻意相反**：那边是「条目 icon 优先、
 * 退回清单 icon」，因为结果列表展示的是「这一条」；面板展示的是「这个插件」。
 */
export function primaryIconRef(manifest: PluginManifest | null | undefined): string | undefined {
  if (!manifest) return undefined;
  return manifest.icon ?? listSearchItems(manifest)[0]?.icon;
}
