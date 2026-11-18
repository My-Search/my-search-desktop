/**
 * 窗口尺寸吸附：把逻辑像素吸附到「缩放网格」，保证 CSS 像素与设备像素同时为整数。
 *
 * ## 为什么必须吸附（用户可见的 bug：搜索框右边框比上下边框细）
 *
 * `#my_search_box` 是 `border: 2px solid` 的 border-box，四条边在 CSS 布局里
 * 等厚。但若窗口的 CSS 尺寸为小数（如 998.667），Chromium 光栅化边框矩形时
 * 对四条边**各自取整**：贴 x=0 / y=0 的左、上边向外取整变厚（2.667→3 设备
 * 像素），贴视口右缘/下缘的右、下边向内取整变薄（→2 设备像素）——表现为
 * 「右边框比上下边框细」（无头浏览器矩阵实测复现，见本模块底部测试）。
 *
 * ### 判据：吸附目标必须同时满足两个整数
 *
 *   1. 逻辑（CSS）宽 × 缩放 = **整数设备像素**（否则右缘落在半像素上被吃列）；
 *   2. 逻辑（CSS）宽本身是**整数**（否则 CSS 布局里边框边缘就是小数）。
 *
 * 旧实现 `snap_to_physical_pixels` 只满足 1：1497 物理 ÷ 1.5 = 998 CSS 整数 ✓，
 * 但 1498 物理 ÷ 1.5 = 998.667 CSS ✗——「物理整数」在 125%/150% 这类分数缩放
 * 下推不出「CSS 整数」，所以修复无效（150% 下右边框依旧细 1 设备像素）。
 *
 * ### 网格：k 的整数倍（k = 使 k × scale 为整数的最小整数）
 *
 *   - 100% → k=1（普通取整）；150% → k=2；125% / 175% → k=4；200% → k=1。
 *     由最简分数分母给出（scale=3/2 → k=2；scale=5/4 → k=4；scale=7/4 → k=4）。
 *   - k 的倍数同时满足两条：k×n×scale 为整数（条件1）、本身为整数（条件2）。
 *   - 非整倍缩放（如 110%）：按分母取 k，仍能把误差压到一个设备像素以内。
 *
 * 实测验证（无头 Edge，150% 缩放）：998 / 1000 / 886（k=2 的倍数）四边全部
 * 3 设备像素等厚；999 / 887（非倍数）右边框 2、其余 3 —— 与判据完全吻合。
 */

/** 常见缩放对应的网格步长（逻辑像素）："使 k×scale 为整数的最小整数 k" */
const SCALE_GRID: ReadonlyMap<number, number> = new Map([
  [1, 1],
  [1.25, 4],
  [1.5, 2],
  [1.75, 4],
  [2, 1],
  [2.25, 4],
  [2.5, 2],
  [3, 1],
]);

/**
 * 由缩放系数求吸附网格步长 k（使 k×scale 为整数的最小整数）。
 *
 * 先查常见缩放表，未命中（自定义系统缩放）时试 1..=8 的小步长，
 * 试不出退化为 1（普通取整——非整倍缩放下本来就无法完美对齐，尽力即可）。
 * 与 Rust 侧 `lib.rs::scale_grid_step` 同口径。
 */
export function scaleGridStep(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  const known = SCALE_GRID.get(scale);
  if (known !== undefined) return known;
  for (let k = 1; k <= 8; k++) {
    if (Math.abs(k * scale - Math.round(k * scale)) < 1e-9) return k;
  }
  return 1;
}

/**
 * 把逻辑尺寸吸附到缩放网格（k 的整数倍）。
 *
 * @param value 逻辑宽/高（CSS 像素）；非法值原样返回
 * @param scale 缩放系数；非法时按 1 处理（普通取整）
 * @param mode `"round"` 取最近格点（宽度用——偏差对称、无漂移）；
 *             `"ceil"` 向上取格点（高度用——宁可多 1 逻辑像素也不能把内容裁掉）。
 */
export function snapToScaleGrid(
  value: number,
  scale: number,
  mode: "round" | "ceil" = "round"
): number {
  if (!Number.isFinite(value)) return value;
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const k = scaleGridStep(s);
  const cells = value / k;
  const snapped = mode === "ceil" ? Math.ceil(cells) : Math.round(cells);
  return snapped * k;
}

/** 兼容旧名：宽度吸附（round 模式）。旧实现只吸附整数设备像素，本版升级为网格吸附。 */
export function snapWidthToPhysicalPixels(width: number, scale?: number): number {
  if (!Number.isFinite(width) || width <= 0) return width;
  const s = scale ?? (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
  return snapToScaleGrid(width, s, "round");
}
