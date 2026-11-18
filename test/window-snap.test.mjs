/**
 * 窗口尺寸「缩放网格吸附」单元测试（纯 Node 运行，无需浏览器）。
 *
 * 用户反馈：「呼出搜索的边框的右边框的宽度明显与上下两个的边框宽度大小不一样，
 * 右边框宽度窄」。
 *
 * 根因（无头 Edge 矩阵实测，150% 缩放复现）：`#my_search_box` 是
 * `border: 2px solid` 的 border-box，四条边在 CSS 布局里等厚；但窗口逻辑宽度
 * 不是整数 CSS 像素（如 1920×0.52=998.4 → Windows 往返 999 或 998.667）时，
 * Chromium 光栅化边框矩形对四条边**逐边取整**：贴 x=0/y=0 的左、上边向外取整
 * 变厚（3 设备像素），贴视口右/下缘的右、下边向内取整变薄（2 设备像素）。
 *
 * 判据（两个整数缺一不可）：
 *   1. 逻辑宽 × 缩放 = 整数设备像素（右缘不落半像素）；
 *   2. 逻辑宽本身 = 整数 CSS 像素（布局里边框边缘就不是小数）。
 * 旧实现 `snap_to_physical_pixels` 只满足 1：1498÷1.5=998.667 仍是 CSS 小数，
 * 修复无效。网格吸附（k 的整数倍，k=使 k×scale 为整数的最小整数：1.5→2、
 * 1.25→4）同时满足两条。无头矩阵验证：150% 下 998/1000/886 四边全 3 设备
 * 像素等厚；999/887 右边框 2、其余 3。
 *
 * 本测试锁死 TS 侧口径（Rust 侧 lib.rs::scale_grid_step 同口径由 cargo test
 * 锁定）：步长查表、round/ceil 两模式、全缩放×全输入的「CSS 整数 + 物理整数」
 * 双整数不变量、非法值原样返回（不改变调用方守卫语义）。
 *
 * 用法: node test/window-snap.test.mjs
 */
import assert from "node:assert/strict";
import process from "node:process";

const { snapToScaleGrid, scaleGridStep, snapWidthToPhysicalPixels } = await import(
  "../src/lib/window-snap.ts"
);

/** 双整数不变量：吸附结果必须是整数 CSS 像素，且 ×缩放是整数设备像素 */
function assertDualIntegral(value, scale, label) {
  assert.ok(
    Number.isInteger(value),
    `${label}: 吸附后 CSS 像素 ${value} 不是整数（右边框/下边框会被逐边取整吃薄）`
  );
  const phys = value * scale;
  assert.ok(
    Number.isInteger(phys),
    `${label}: 吸附后 ×${scale} = ${phys} 设备像素不是整数（右缘落半像素被吃列）`
  );
}

// ---------- 网格步长查表 ----------
// "使 k×scale 为整数的最小整数 k"：1.5=3/2→2、1.25=5/4→4、1.75=7/4→4、整数→1
assert.equal(scaleGridStep(1), 1);
assert.equal(scaleGridStep(1.5), 2);
assert.equal(scaleGridStep(1.25), 4);
assert.equal(scaleGridStep(1.75), 4);
assert.equal(scaleGridStep(2), 1);
assert.equal(scaleGridStep(2.5), 2);
assert.equal(scaleGridStep(3), 1);
// 非法/退化缩放：一律按 1（普通取整）
assert.equal(scaleGridStep(0), 1);
assert.equal(scaleGridStep(-1), 1);
assert.equal(scaleGridStep(Number.NaN), 1);
assert.equal(scaleGridStep(Number.POSITIVE_INFINITY), 1);

// ---------- round 模式（宽度口径） ----------
// 具体回归值：1920 屏 0.52 分档 = 998.4
assert.equal(snapToScaleGrid(998.4, 1.0, "round"), 998);
// 150% 下的奇数宽（旧实现原样放行 → 右边框细 1 设备像素）：吸附到偶数
assert.equal(snapToScaleGrid(999.0, 1.5, "round"), 1000);
assert.equal(snapToScaleGrid(998.0, 1.5, "round"), 998);
assert.equal(snapToScaleGrid(887.47, 1.5, "round"), 888);
// 125%：k=4
assert.equal(snapToScaleGrid(998.4, 1.25, "round"), 1000);
assert.equal(snapToScaleGrid(1000.0, 1.25, "round"), 1000);
// 100%/200%：k=1，普通取整
assert.equal(snapToScaleGrid(998.6, 2.0, "round"), 999);
assert.equal(snapToScaleGrid(653.7, 1.0, "round"), 654);

// 全缩放 × 全输入：round 结果满足双整数不变量
for (const scale of [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3]) {
  for (const width of [320, 653.7, 887.47, 998.4, 999, 1500.9, 2560]) {
    assertDualIntegral(snapToScaleGrid(width, scale, "round"), scale, `width=${width}@${scale}x`);
  }
}

// ---------- ceil 模式（高度口径：宁多 1 逻辑像素也不裁内容/下边框） ----------
assert.equal(snapToScaleGrid(301.333, 1.5, "ceil"), 302);
assert.equal(snapToScaleGrid(48, 1.5, "ceil"), 48); // 已在格点上不动
assert.equal(snapToScaleGrid(300.1, 1.25, "ceil"), 304); // k=4 → 上一格 304
assert.equal(snapToScaleGrid(48.5, 1.0, "ceil"), 49);
for (const scale of [1, 1.25, 1.5, 1.75, 2]) {
  for (const height of [48, 120.4, 301.333, 700, 900.7]) {
    const snapped = snapToScaleGrid(height, scale, "ceil");
    assertDualIntegral(snapped, scale, `height=${height}@${scale}x`);
    // ceil 语义：绝不低于原值（不裁内容）
    assert.ok(snapped >= height - 1e-9, `height=${height}@${scale}x ceil 结果 ${snapped} < 原值`);
  }
}

// ---------- 非法值原样返回（调用方守卫语义不变） ----------
assert.equal(snapToScaleGrid(Number.NaN, 1.5, "round"), Number.NaN);
assert.equal(snapToScaleGrid(Number.POSITIVE_INFINITY, 1.5, "round"), Number.POSITIVE_INFINITY);
assert.equal(snapWidthToPhysicalPixels(Number.NaN), Number.NaN);
assert.equal(snapWidthToPhysicalPixels(-5), -5); // 非正原样返回
assert.equal(snapWidthToPhysicalPixels(0), 0);

// ---------- 兼容包装与缺省 scale ----------
assert.equal(snapWidthToPhysicalPixels(999, 1.5), 1000);
assert.equal(snapWidthToPhysicalPixels(998.4, 1.0), 998);
// 浏览器环境缺省取 devicePixelRatio（Node 下按 1 处理）
assert.equal(snapWidthToPhysicalPixels(998.4), 998);

console.log("window-snap: all assertions passed");
process.exit(0);
