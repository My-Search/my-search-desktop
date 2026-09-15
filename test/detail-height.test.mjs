/**
 * 回归测试：详情视图（简述内容 / 附加内容）窗口高度应随内容自适应，
 * 而不是固定值 —— 内容少时收紧、内容多时展开到上限。
 *
 * 口径（修复「底部溢出灰框」后）：入参是 #my_search_box 的**实测高度**
 * （已含 2px 上下边框与 44px 搜索框），函数只做 [min, max] 区间钳制，
 * 不再叠加任何余量 —— 窗口与盒子必须严格等高，否则下边框下方会露出白边。
 */
import { calcDetailWindowHeight } from "../src/lib/util.ts";

const OPTS = { min: 140, max: 560 };

let pass = 0;
let fail = 0;
const ok = (cond, name) => {
  if (cond) pass++;
  else {
    fail++;
    console.log("  FAIL:", name);
  }
};

const h = (box) => calcDetailWindowHeight(box, OPTS);

// 1. 内容极少（盒子被 min 抬到下限）→ 取到下限（不出现固定 560 的大片空白）
ok(h(0) === OPTS.min, `空内容取下限 ${h(0)}`);
ok(h(10) === OPTS.min, `单行内容取下限 ${h(10)}`);
ok(h(100) === OPTS.min, `少量内容取下限 ${h(100)}`);
ok(h(139) === OPTS.min, `略低于下限 → 抬到下限 ${h(139)}`);
ok(h(140) === OPTS.min, `恰好下限 → 保持 ${h(140)}`);

// 2. 内容中等 → **原样采用实测高度**（核心：不再 +boxHeight +slack）
ok(h(200) === 200, `实测 200 → ${h(200)}（原样）`);
ok(h(300) === 300, `实测 300 → ${h(300)}（原样）`);
ok(h(400) === 400, `实测 400 → ${h(400)}（原样）`);
ok(h(559) === 559, `实测 559 → ${h(559)}（原样）`);

// 3. 内容超长 → 收敛到上限（超出部分内部滚动）：此时盒子被 #text_show 的
//    max-height 截断（实测即 560），钳制后仍为上限，窗口与盒子等高
ok(h(560) === OPTS.max, `实测 560（内容封顶）→ ${h(560)}`);
ok(h(1000) === OPTS.max, `超长内容取上限 ${h(1000)}`);
ok(h(100000) === OPTS.max, `极长内容取上限 ${h(100000)}`);

// 4. 严格单调（内容越多越高），且始终落在 [min, max]
const samples = [0, 40, 91, 150, 260, 380, 470, 511, 512, 800, 5000];
for (let i = 0; i < samples.length; i++) {
  const v = h(samples[i]);
  ok(v >= OPTS.min && v <= OPTS.max, `[${samples[i]}] 落在区间内: ${v}`);
  if (i > 0) ok(v >= h(samples[i - 1]), `[${samples[i]}] 单调不减`);
}

// 5. 关键回归：不同内容得到不同高度（戳破「固定高度」的写法）
ok(h(100) !== h(400), "内容不同 → 高度不同（不再是固定值）");
ok(new Set([h(150), h(250), h(450)]).size === 3, "多档内容得到多档高度");

// 6. 区间内高度与实测严格相等（无隐藏余量）：等差采样应逐点相等
for (const v of [150, 200, 257, 333, 421, 508, 559]) {
  ok(h(v) === v, `无余量：h(${v}) === ${v}，实际 ${h(v)}`);
}

// 7. 边界/异常输入不应产生 NaN
ok(Number.isFinite(h(undefined)), "undefined 内容不产生 NaN");
ok(Number.isFinite(h(-100)), "负数内容不产生 NaN");
ok(h(-100) === OPTS.min, "负数内容取下限");
ok(h(NaN) === OPTS.min, "NaN 内容取下限");

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
