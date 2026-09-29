/**
 * 遮罩编辑逻辑的纯函数测试（选区缩放 + 标注命中测试）。
 *
 * 为什么单独测纯函数：这两块逻辑（改范围、选中已有标注）的坐标算术很容易写错，
 * 而它们的错误在真机上表现为「拖了没反应 / 选中了别的标注」，靠肉眼很难定位。
 * 抽成纯函数后可以穷举边界（拖过头、缩到最小、重叠时选谁）。
 *
 * 用法: node test/overlay-edit.test.mjs
 */
import { resizeRect, strokeBounds, hitStroke } from "../src/windows/overlay/useOverlay.ts";

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = "") => {
  if (cond) {
    pass++;
    console.log("PASS ", name, extra ? ` — ${extra}` : "");
  } else {
    fail++;
    console.log("FAIL ", name, extra ? ` — ${extra}` : "");
  }
};

/* ============ 1. 选区缩放：拖哪条边，对面那条不动 ============ */
{
  const base = { x: 100, y: 100, w: 200, h: 150 };

  // 拖右边 → 左/上/下不动
  const e = resizeRect(base, "e", 400, 999);
  ok(e.x === 100 && e.y === 100 && e.w === 300 && e.h === 150, "拖右边：只改宽度", JSON.stringify(e));

  // 拖左边 → 右边不动
  const w = resizeRect(base, "w", 50, 999);
  ok(w.x === 50 && w.w === 250 && w.y === 100 && w.h === 150, "拖左边：左边界跟随、右边不动", JSON.stringify(w));

  // 拖下边 → 上边不动
  const s = resizeRect(base, "s", 999, 400);
  ok(s.y === 100 && s.h === 300 && s.x === 100 && s.w === 200, "拖下边：只改高度", JSON.stringify(s));

  // 拖上边 → 下边不动
  const n = resizeRect(base, "n", 999, 60);
  ok(n.y === 60 && n.h === 190, "拖上边：上边界跟随、下边不动", JSON.stringify(n));

  // 拖右下角 → 左上不动
  const se = resizeRect(base, "se", 400, 400);
  ok(se.x === 100 && se.y === 100 && se.w === 300 && se.h === 300, "拖右下角：左上角不动", JSON.stringify(se));

  // 拖左上角 → 右下不动
  const nw = resizeRect(base, "nw", 40, 30);
  ok(nw.x === 40 && nw.y === 30 && nw.w === 260 && nw.h === 220, "拖左上角：右下角不动", JSON.stringify(nw));
}

/* ============ 2. 拖过头（交叉）→ 结果仍是正矩形 ============ */
{
  const base = { x: 100, y: 100, w: 200, h: 150 };
  // 把左边拖到右边之外
  const crossed = resizeRect(base, "w", 500, 100);
  ok(crossed.w > 0 && crossed.h > 0, "拖过头后仍是正宽高", JSON.stringify(crossed));
  ok(crossed.x === 300 && crossed.w === 200, "拖过头后左右互换（x 落在原右边界）", JSON.stringify(crossed));
}

/* ============ 3. 最小尺寸卡住 ============ */
{
  const base = { x: 100, y: 100, w: 200, h: 150 };
  const tiny = resizeRect(base, "e", 101, 100);
  ok(tiny.w === 8, "缩到小于最小宽度时卡在 8px", String(tiny.w));
  const tinyH = resizeRect(base, "s", 100, 101);
  ok(tinyH.h === 8, "缩到小于最小高度时卡在 8px", String(tinyH.h));
  // 从左边缩：x 应该贴在右边界左侧 8px 处
  const tinyW = resizeRect(base, "w", 299, 100);
  ok(tinyW.w === 8 && tinyW.x === 292, "从左边缩到最小：左边卡在右边界左侧", JSON.stringify(tinyW));
}

/* ============ 4. 标注包围盒 ============ */
{
  const rect = { id: 1, kind: "rect", x: 50, y: 60, w: 100, h: 80, color: "#f00", lineWidth: 3 };
  const b = strokeBounds(rect);
  ok(b.x === 50 && b.y === 60 && b.w === 100 && b.h === 80, "矩形包围盒 = 自身几何", JSON.stringify(b));

  // 负宽高（拖动中）也要给正包围盒
  const neg = strokeBounds({ ...rect, w: -100, h: -80 });
  ok(neg.x === -50 && neg.y === -20 && neg.w === 100 && neg.h === 80, "负宽高 → 正包围盒", JSON.stringify(neg));

  // 画笔：按路径点取极值（点存的是相对起点的偏移）
  const pen = {
    id: 2, kind: "pen", x: 100, y: 100, w: 0, h: 0,
    points: [{ x: 0, y: 0 }, { x: 20, y: 10 }, { x: 5, y: 30 }],
    color: "#f00", lineWidth: 3,
  };
  const pb = strokeBounds(pen);
  ok(pb.x === 100 && pb.y === 100 && pb.w === 20 && pb.h === 30, "画笔包围盒 = 路径极值", JSON.stringify(pb));

  // 文字：按字号与字数估算
  const text = { id: 3, kind: "text", x: 10, y: 20, w: 0, h: 0, text: "abcd", fontSize: 20, color: "#f00", lineWidth: 3 };
  const tb = strokeBounds(text);
  ok(tb.x === 10 && tb.y === 20 && tb.h === 20 && tb.w > 0, "文字包围盒高度 = 字号", JSON.stringify(tb));
}

/* ============ 5. 命中测试（含容差） ============ */
{
  const rect = { id: 1, kind: "rect", x: 100, y: 100, w: 100, h: 100, color: "#f00", lineWidth: 3 };
  ok(hitStroke(rect, 150, 150) === true, "点在矩形内部 → 命中");
  ok(hitStroke(rect, 100, 100) === true, "点在矩形边上 → 命中");
  ok(hitStroke(rect, 105, 105) === true, "点在边附近（容差内）→ 命中");
  ok(hitStroke(rect, 400, 400) === false, "点得很远 → 不命中");
  ok(hitStroke(rect, 96, 96) === true, "点在边外侧一点（线宽容差内）→ 命中");
}

/* ============ 6. 重叠时选中「最上面」的那一笔 ============ */
{
  // pickStroke 依赖模块内部状态，这里用同样的规则直接验证顺序语义：
  // 后画的在上层，从后往前找 → 应选中最后画的那个。
  const strokes = [
    { id: 1, kind: "rect", x: 0, y: 0, w: 200, h: 200, color: "#f00", lineWidth: 3 },
    { id: 2, kind: "rect", x: 50, y: 50, w: 200, h: 200, color: "#0f0", lineWidth: 3 },
  ];
  const pick = (x, y) => {
    for (let i = strokes.length - 1; i >= 0; i--) {
      if (hitStroke(strokes[i], x, y)) return strokes[i].id;
    }
    return null;
  };
  ok(pick(100, 100) === 2, "重叠处选中最上层（后画的）", String(pick(100, 100)));
  ok(pick(10, 10) === 1, "只被下层覆盖处选中下层", String(pick(10, 10)));
  ok(pick(500, 500) === null, "空白处不选中任何标注");
}

console.log("");
if (fail > 0) {
  console.error(`结果: ${fail} 项失败（${pass} 通过）`);
  process.exit(1);
}
console.log(`结果: 全部通过（${pass} 项）`);