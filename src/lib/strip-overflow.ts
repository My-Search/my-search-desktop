/**
 * 「最近添加」条带的横向溢出边缘判定 —— 纯逻辑（可单测）。
 *
 * ## 为什么需要它
 *
 * `#recentStrip` 是一行横向滚动、滚动条被藏掉的条目带（见 style.css）。
 * 藏掉滚动条后，用户看不出「右边还有内容」——尤其条目恰好被裁掉半个时，
 * 更像样式坏了。于是要在**还有被裁内容的那一侧**做渐隐（「隧道」效果）：
 * 右侧还有隐藏内容 → 右边缘渐隐；向左滚过、左侧露出被裁内容 → 左边缘渐隐；
 * 滚到最右 / 回到最左，对应侧的渐隐消失。
 *
 * 判定只依赖三个滚动几何量，与 DOM / Vue 无关，因此独立成模块直接单测
 * （与 `drop-target.ts` 同一套「纯逻辑 + Node 直接加载」的约定）。
 */

/** 条带滚动几何（`Element` 的 scrollLeft / scrollWidth / clientWidth） */
export interface StripScrollMetrics {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}

/** 两侧是否有被裁（隐藏）的内容 */
export interface StripEdges {
  /** 左边缘之外还有内容（已向左滚过）→ 左侧需要渐隐 */
  left: boolean;
  /** 右边缘之外还有内容 → 右侧需要渐隐 */
  right: boolean;
}

/**
 * 判定条带左右两侧是否存在被裁内容。
 *
 * @param metrics 条带的 scrollLeft / scrollWidth / clientWidth
 * @param tol     容差（像素）。浏览器在分数滚动位置下 `scrollLeft` 常带零点几的
 *                误差；不设容差会让「已经滚到最右」被误判成「右边还有内容」，
 *                渐隐该消失时却常驻。默认 1px 足够吸收这类抖动。
 */
export function computeStripEdges(
  metrics: Partial<StripScrollMetrics> | null | undefined,
  tol = 1
): StripEdges {
  const scrollLeft = Number(metrics?.scrollLeft);
  const scrollWidth = Number(metrics?.scrollWidth);
  const clientWidth = Number(metrics?.clientWidth);
  // 任一几何量非法（元素未挂载 / 未布局 / 取到 NaN）→ 视为无溢出，
  // 宁可不加渐隐，也不要画出「明明没有隐藏内容却渐隐」的假象。
  if (
    !Number.isFinite(scrollLeft) ||
    !Number.isFinite(scrollWidth) ||
    !Number.isFinite(clientWidth)
  ) {
    return { left: false, right: false };
  }
  const t = Number.isFinite(tol) && tol >= 0 ? tol : 1;
  // 可视宽 ≤0（display:none 的隐藏态 / 尚未布局）→ 没有任何可显示的内容，
  // 画渐隐毫无意义，还会在「收起→展开」的瞬间闪一下假的右渐隐。直接判无溢出。
  if (clientWidth <= 0) return { left: false, right: false };
  // 内容总宽都不超过可视宽 → 完全没有横向溢出，两侧都不渐隐。
  if (scrollWidth - clientWidth <= t) return { left: false, right: false };
  return {
    left: scrollLeft > t,
    right: scrollLeft + clientWidth < scrollWidth - t,
  };
}
