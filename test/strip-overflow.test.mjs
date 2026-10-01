/**
 * 「最近添加」条带横向溢出边缘判定（computeStripEdges）纯逻辑测试。
 *
 * 背景：条带滚动条被藏掉，用户看不出「右边还有内容」。给**还有被裁内容的一侧**
 * 做渐隐（隧道效果，见 style.css .fade-left / .fade-right），判定即本模块。
 *
 * 覆盖契约：
 *   1. 未溢出（内容宽 ≤ 可视宽）→ 两侧都不渐隐
 *   2. 仅右侧有隐藏内容（scrollLeft=0 但内容更宽）→ 只右渐隐
 *   3. 向左滚过（scrollLeft>0）→ 左渐隐；滚到最右 → 右渐隐消失
 *   4. 两端都还有隐藏内容（夹在中间）→ 两侧都渐隐
 *   5. 容差：分数 scrollLeft 的零点几误差不误判「右边还有」
 *   6. 非法/缺失输入（NaN / null / undefined / 隐藏态 clientWidth=0）→ 安全回退
 *
 * 用法: node test/strip-overflow.test.mjs
 */
import { computeStripEdges } from "../src/lib/strip-overflow.ts";

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = "") => {
  if (cond) {
    pass++;
    console.log("PASS ", name);
  } else {
    fail++;
    console.log("FAIL ", name, extra ? ` — ${extra}` : "");
  }
};

const eq = (got, want) =>
  got.left === want.left && got.right === want.right;

/* ---------- 1. 未溢出 ---------- */
{
  const e = computeStripEdges({ scrollLeft: 0, scrollWidth: 300, clientWidth: 300 });
  ok(eq(e, { left: false, right: false }), "内容不超过可视宽 → 两侧都不渐隐", JSON.stringify(e));
}
{
  // 内容比可视区窄（条目没排满一行）
  const e = computeStripEdges({ scrollLeft: 0, scrollWidth: 120, clientWidth: 400 });
  ok(eq(e, { left: false, right: false }), "内容比可视区窄 → 两侧都不渐隐", JSON.stringify(e));
}

/* ---------- 2. 仅右侧有隐藏内容 ---------- */
{
  const e = computeStripEdges({ scrollLeft: 0, scrollWidth: 800, clientWidth: 400 });
  ok(eq(e, { left: false, right: true }), "起点内容溢出 → 只右渐隐", JSON.stringify(e));
}

/* ---------- 3. 左滚 / 到最右 ---------- */
{
  // 滚到中间：左右都还有内容
  const e = computeStripEdges({ scrollLeft: 200, scrollWidth: 800, clientWidth: 400 });
  ok(eq(e, { left: true, right: true }), "滚到中间 → 两侧都渐隐", JSON.stringify(e));
}
{
  // 滚到最右：右侧到底，右渐隐应消失，只剩左
  const e = computeStripEdges({ scrollLeft: 400, scrollWidth: 800, clientWidth: 400 });
  ok(eq(e, { left: true, right: false }), "滚到最右 → 只左渐隐（右消失）", JSON.stringify(e));
}
{
  // 回到最左：左渐隐消失
  const e = computeStripEdges({ scrollLeft: 0, scrollWidth: 800, clientWidth: 400 });
  ok(e.left === false, "回到最左 → 左渐隐消失");
}

/* ---------- 4. 两端都有隐藏内容（等价于中间态，单独再断言一次） ---------- */
{
  const e = computeStripEdges({ scrollLeft: 100, scrollWidth: 1000, clientWidth: 300 });
  ok(e.left === true && e.right === true, "夹在中间 → 左右都还有隐藏内容");
}

/* ---------- 5. 容差：分数滚动位置不误判 ---------- */
{
  // 已滚到最右，但 scrollLeft 带 0.5 的亚像素误差（Chrome 常见）
  const e = computeStripEdges({ scrollLeft: 399.5, scrollWidth: 800, clientWidth: 400 });
  ok(e.right === false, "最右 + 0.5 亚像素误差 → 不误判「右边还有」");
}
{
  // 起始位置 scrollLeft 是 0.4（几乎为 0）→ 不应判成「左边还有」
  const e = computeStripEdges({ scrollLeft: 0.4, scrollWidth: 800, clientWidth: 400 });
  ok(e.left === false, "scrollLeft 近似 0 → 不误判「左边还有」");
}
{
  // 自定义容差：tol=0 时亚像素误差会被当作真实偏移（证明容差确实生效）
  const e = computeStripEdges({ scrollLeft: 0.5, scrollWidth: 800, clientWidth: 400 }, 0);
  ok(e.left === true, "tol=0 时 0.5px 偏移被视为「左边还有内容」");
}

/* ---------- 6. 非法 / 缺失输入安全回退 ---------- */
{
  for (const bad of [null, undefined, {}, { scrollLeft: NaN, scrollWidth: 800, clientWidth: 400 }]) {
    const e = computeStripEdges(bad);
    ok(eq(e, { left: false, right: false }), `非法输入 ${JSON.stringify(bad)} → 安全回退`, JSON.stringify(e));
  }
}
{
  // 隐藏态（display:none）clientWidth / scrollWidth 都是 0 → 不渐隐
  const e = computeStripEdges({ scrollLeft: 0, scrollWidth: 0, clientWidth: 0 });
  ok(eq(e, { left: false, right: false }), "隐藏态全 0 → 不渐隐（不会画出假的右渐隐）", JSON.stringify(e));
}
{
  // clientWidth=0 但 scrollWidth>0（尚未布局）→ 仍不应画右渐隐（避免闪一下）
  const e = computeStripEdges({ scrollLeft: 0, scrollWidth: 500, clientWidth: 0 });
  ok(e.right === false, "clientWidth=0（未布局）→ 不画右渐隐");
}

/* ---------- 7. 单调性：同一内容，滚动越靠右，left 越可能为真、right 越可能为假 ---------- */
{
  const geo = (s) => computeStripEdges({ scrollLeft: s, scrollWidth: 800, clientWidth: 400 });
  const a = geo(0);
  const b = geo(200);
  const c = geo(400);
  ok(a.left === false && b.left === true && c.left === true, "滚动越靠右 → left 单调趋真");
  ok(a.right === true && b.right === true && c.right === false, "滚动越靠右 → right 单调趋假");
}

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
