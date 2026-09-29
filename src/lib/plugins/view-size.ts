/**
 * 插件视图的「窗口尺寸记忆」与「居中定位」纯逻辑。
 *
 * 背景：插件不是独立窗口，而是主窗口详情区里的 DOM 会话；用户在插件页拖右下角
 * 改变的是**整个主窗口**的宽高。这里只放与 Vue / DOM / Tauri 无关的纯函数，
 * 便于单测，也给 App.vue 的窗口操作提供口径统一的输入。
 *
 * 三条口径（与项目既有实现保持一致）：
 *   - 默认尺寸 = 首次打开时「屏幕分档宽 + 内容自适应高」，同时也是**最小尺寸**
 *     （用户只能放大，不能缩到默认以下）；
 *   - 最大尺寸 = 屏幕宽 90% / 屏幕高（沿用 Rust 侧 MAX_SCREEN_WIDTH_RATIO 口径）；
 *   - 居中 = 水平居中；垂直方向顶部占「剩余空间」的 22%（窗口越高越接近居中，
 *     与 Rust 侧 `position_window_top_center` 的 0.22 习惯一致），窗口高于屏幕时
 *     顶部贴边（y 为 0 偏移）。
 *
 * 记忆按插件隔离：存储键带 pluginId（走 registry 的 pluginDataGet/Set/Remove，
 * 落到 `my-search-desktop:PLUGIN_DATA:<pluginId>:viewSize`）。
 */
import { pluginDataGet, pluginDataSet, pluginDataRemove } from "./registry.ts";

/** 插件尺寸记忆在插件私有数据里的键名 */
export const PLUGIN_VIEW_SIZE_KEY = "viewSize";

/** 垂直方向顶部占「剩余空间」的比例（与 Rust position_window_top_center 同口径） */
export const TOP_RATIO = 0.22;
/**
 * 「完全居中」的垂直比例：0.5 表示上下边距相等（水平本来就居中）。
 *
 * 用于**插件页调整过大小之后**：此时按用户要求改为上下左右完全居中，
 * 而不是常态搜索窗的「顶部 22%」。窗口高于屏幕时仍取 0（贴顶，不推到屏幕外）。
 */
export const FULL_CENTER_RATIO = 0.5;

/** 窗口尺寸（逻辑像素） */
export interface ViewSize {
  width: number;
  height: number;
}

/** 尺寸上下限（逻辑像素） */
export interface SizeLimits {
  minW: number;
  minH: number;
  maxW: number;
  maxH: number;
}

/**
 * 把尺寸夹到 [min, max] 内（逐轴，非等比）。
 *
 * 注意 min 用的是**默认尺寸**：用户只能放大，拖到比默认还小会被挡回默认。
 * 若默认尺寸本身超过 max（极小屏幕上内容很高的插件），以 min 优先——宁可
 * 略超屏幕上限，也不要出现「默认尺寸本身就非法、被夹成更小」的怪状。
 */
export function clampSize(size: ViewSize, limits: SizeLimits): ViewSize {
  const lowerW = Math.max(0, limits.minW);
  const lowerH = Math.max(0, limits.minH);
  // max 至少要能容纳 min（min 优先）
  const upperW = Math.max(lowerW, limits.maxW);
  const upperH = Math.max(lowerH, limits.maxH);
  return {
    width: Math.min(Math.max(size.width, lowerW), upperW),
    height: Math.min(Math.max(size.height, lowerH), upperH),
  };
}

/**
 * 计算窗口应放置的左上角逻辑坐标。
 *
 * - 水平：严格居中于显示器（含显示器自身偏移，多显示器下也对）；
 * - 垂直：顶部 = 显示器顶 + 剩余空间 × topRatio。
 *   - `topRatio = TOP_RATIO (0.22)`：常态搜索窗口径（顶部约屏高 22%）；
 *   - `topRatio = FULL_CENTER_RATIO (0.5)`：上下完全居中（插件页调整过大小后用）。
 *   窗口越高剩余空间越小，顶部越靠上；窗口高于屏幕时剩余为负，取 0（贴顶），
 *   避免窗口被推到屏幕上方之外。
 *
 * @param rect 显示器矩形（逻辑像素，含 origin）
 * @param size 窗口尺寸（逻辑像素）
 * @param topRatio 垂直方向顶部占「剩余空间」的比例（默认 TOP_RATIO）
 */
export function centeredPosition(
  rect: { x: number; y: number; width: number; height: number },
  size: ViewSize,
  topRatio: number = TOP_RATIO
): { x: number; y: number } {
  const remainingX = rect.width - size.width;
  const remainingY = rect.height - size.height;
  const x = Math.round(rect.x + remainingX / 2);
  const y = Math.round(rect.y + Math.max(0, remainingY) * topRatio);
  return { x, y };
}

/** 依据显示器矩形算出尺寸上下限（最大 = 宽 90% / 高 100%） */
export function limitsForScreen(
  rect: { width: number; height: number },
  fallback: ViewSize
): SizeLimits {
  const maxW = rect.width > 0 ? rect.width * 0.9 : fallback.width;
  const maxH = rect.height > 0 ? rect.height : fallback.height;
  return { minW: fallback.width, minH: fallback.height, maxW, maxH };
}

/** 读取某插件记忆的窗口尺寸；无记忆或结构不合法返回 null */
export function readPluginViewSize(pluginId: string): ViewSize | null {
  if (!pluginId) return null;
  const raw = pluginDataGet<unknown>(pluginId, PLUGIN_VIEW_SIZE_KEY, null);
  if (raw == null || typeof raw !== "object") return null;
  const r = raw as Partial<ViewSize>;
  if (typeof r.width !== "number" || typeof r.height !== "number") return null;
  if (!Number.isFinite(r.width) || !Number.isFinite(r.height)) return null;
  if (r.width <= 0 || r.height <= 0) return null;
  return { width: r.width, height: r.height };
}

/** 写入某插件的窗口尺寸记忆 */
export function writePluginViewSize(pluginId: string, size: ViewSize): void {
  if (!pluginId) return;
  pluginDataSet(pluginId, PLUGIN_VIEW_SIZE_KEY, { width: size.width, height: size.height });
}

/** 清除某插件的窗口尺寸记忆（「恢复默认大小」用；下次打开回到内容自适应尺寸） */
export function clearPluginViewSize(pluginId: string): void {
  if (!pluginId) return;
  pluginDataRemove(pluginId, PLUGIN_VIEW_SIZE_KEY);
}

/**
 * 综合「记忆值 / 默认值 / 上下限」得到本次应采用的尺寸。
 *
 * 规则：有合法记忆 → 记忆值经 clamp；无记忆 → 默认值（也 clamp 一道，防止
 * 默认值在极端屏幕上超过上限）。
 */
export function resolveViewSize(
  remembered: ViewSize | null,
  defaultSize: ViewSize,
  limits: SizeLimits
): ViewSize {
  const base = remembered ?? defaultSize;
  return clampSize(base, limits);
}
