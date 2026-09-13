/**
 * 回归测试：详情视图（简述内容 / 附加内容）窗口高度应随内容自适应，
 * 而不是固定值 —— 内容少时收紧、内容多时展开到上限。
 */
import { calcDetailWindowHeight } from "../src/lib/util.js";

const OPTS = { boxHeight: 47, min: 140, max: 560, slack: 2 };

let pass = 0;
let fail = 0;
const ok = (cond, name) => {
  if (cond) pass++;
  else {
    fail++;
    console.log("  FAIL:", name);
  }
};

const h = (content) => calcDetailWindowHeight(content, OPTS);

// 1. 内容极少 → 取到下限（不出现固定 560 的大片空白）
ok(h(0) === OPTS.min, `空内容取下限 ${h(0)}`);
ok(h(10) === OPTS.min, `单行内容取下限 ${h(10)}`);
ok(h(90) === OPTS.min, `少量内容取下限 ${h(90)}`);

// 2. 内容中等 → 精确跟随内容（含搜索框高度与测量余量）
ok(h(200) === 200 + 47 + 2, `中等内容 200 → ${h(200)}`);
ok(h(300) === 300 + 47 + 2, `中等内容 300 → ${h(300)}`);
ok(h(400) === 400 + 47 + 2, `中等内容 400 → ${h(400)}`);

// 3. 内容超长 → 收敛到上限（超出部分内部滚动）
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
ok(new Set([h(100), h(250), h(450)]).size === 3, "多档内容得到多档高度");

// 6. 边界/异常输入不应产生 NaN
ok(Number.isFinite(h(undefined)), "undefined 内容不产生 NaN");
ok(Number.isFinite(h(-100)), "负数内容不产生 NaN");
ok(h(-100) === OPTS.min, "负数内容取下限");

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
