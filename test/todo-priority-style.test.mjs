/**
 * 待办清单「统一底色 + 标题前状态圆点」的样式契约。
 *
 * 用户反馈演进：每项前面的颜色条不好看 → 改整行淡色底 → 仍太花，改为——
 *
 *   1. **行底色统一**：所有待办同一张卡片底，不允许再按 [data-priority]
 *      给 .todo-item 设置背景 / 边框（红黄绿块消失）；
 *   2. **优先级只通过标题前 .todo-dot 表达**：三档各有圆点着色规则，
 *      颜色走主题变量（--todo-high/mid/low），随深浅主题自动适配；
 *   3. **[hidden] 必须真正生效**：插件容器要有 scoped 的 display:none 兜底
 *      （.todo-empty 自带 display:flex 会顶掉 UA 的 hidden 规则——
 *      「列表有数据但底部仍显示空态提示」的根因）；
 *   4. **已完成行灰底覆盖、圆点灰化**；
 *   5. 逾期项仍保留警示边框。
 *
 * 用法: node test/todo-priority-style.test.mjs
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(
  path.join(root, "plugins", "com.zhuangjie.todo-list", "ui", "detail.css"),
  "utf8"
);
/* 注释剔除后的 CSS：选择器匹配不再被规则前方的注释文本干扰 */
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, "");

let pass = 0;
let fail = 0;
function ok(cond, name, extra = "") {
  if (cond) {
    pass++;
    console.log("PASS ", name, extra ? ` — ${extra}` : "");
  } else {
    fail++;
    console.log("FAIL ", name, extra ? ` — ${extra}` : "");
  }
}

/** 抓出某条规则的声明体（选择器精确匹配；连续空白视为一个空白） */
function ruleBody(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const m = cssNoComments.match(new RegExp(`(?:^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`, "m"));
  return m ? m[1] : null;
}

/**
 * 抓出「包含某选择器」的规则声明体——用于逗号分组的选择器列表。
 *
 * 规则可能是 `.a, .b, .c { … }`：整串精确匹配会漏掉，这里把每个分组
 * 拆开逐条比对，命中即可。返回所有命中的声明体（去重）。
 */
function ruleBodiesIncluding(selector) {
  const out = [];
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(cssNoComments))) {
    const sels = m[1].split(",").map((s) => s.trim());
    if (sels.includes(selector)) out.push(m[2]);
  }
  return out;
}

/* 1. 左缘色条与整行染色都必须消失（行底色统一） */
ok(!/inset\s+3px\s+0\s+0/.test(css), "不再使用 3px 内投影色条（inset box-shadow）");
ok(
  !/box-shadow\s*:\s*inset[^;]*var\(--todo-(high|mid|low)\)/.test(css),
  "优先级不再通过 inset 色条表达"
);
for (const level of ["high", "mid", "low"]) {
  ok(
    ruleBody(`.todo-item[data-priority="${level}"]`) === null,
    `行底色不再按优先级 ${level} 染色（统一的卡片底）`
  );
  ok(
    !ruleBodiesIncluding(`.todo-item[data-priority="${level}"]:hover`).some((b) => /background\s*:/.test(b)),
    `优先级 ${level} 行没有专属背景染色`
  );
}
ok(!/todo-chip-prio/.test(css), "优先级 chip 样式已移除（状态只走圆点）");

/* 2. 状态圆点：三档各有着色规则，颜色走主题变量 */
for (const [level, token] of [["high", "--todo-high"], ["mid", "--todo-mid"], ["low", "--todo-low"]]) {
  const body = ruleBody(`.todo-item[data-priority="${level}"] .todo-dot`) || "";
  ok(
    /background\s*:/.test(body) && body.includes(`var(${token}`),
    `优先级 ${level} 的状态圆点着色走 ${token}`,
    body.replace(/\s+/g, " ").trim().slice(0, 90)
  );
}
ok(ruleBody(".todo-dot") !== null, "存在 .todo-dot 基础规则（圆点本体）");
ok(ruleBody(".todo-title-line") !== null, "存在 .todo-title-line（圆点 + 标题同一行）");

/* 3. [hidden] 兜底：空态提示等 toggled 元素必须真正隐藏 */
ok(
  /\[hidden\]\s*\{[^}]*display\s*:\s*none/.test(css),
  "存在 [hidden] display:none 兜底（否则 .todo-empty 的 flex 会顶掉 hidden 属性）"
);

/* 4. 行基础背景仍是卡片底（统一观感 + 深色主题跟随） */
const base = ruleBody(".todo-item") || "";
ok(
  /background\s*:\s*var\(--card/.test(base),
  "行基础背景 = var(--card)（统一且随主题）",
  base.replace(/\s+/g, " ").trim().slice(0, 90)
);

/* 5. 已完成行灰底覆盖，不再引用优先级色 */
const doneRules = ruleBodiesIncluding(".todo-item.todo-item-done");
ok(doneRules.length > 0, "已完成行有显式灰底规则", `${doneRules.length} 条`);
const doneBody = doneRules.join(" ");
ok(/background\s*:/.test(doneBody), "已完成行灰底覆盖", doneBody.replace(/\s+/g, " ").trim().slice(0, 90));
ok(
  !/var\(--todo-(high|mid|low)\)/.test(doneBody),
  "已完成行不再引用优先级色"
);

/* 6. 逾期边框仍保留 */
const overdue = ruleBody(".todo-item.todo-item-overdue") || "";
ok(/border-color\s*:/.test(overdue), "逾期项仍保留警示边框", overdue.trim().slice(0, 80));

console.log(`\n待办优先级样式：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
