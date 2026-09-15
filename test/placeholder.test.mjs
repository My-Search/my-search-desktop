/**
 * 回归测试：搜索框占位提示（严格对齐油猴版 searchPlaceholder 的语义）
 *
 * 用户反馈的两个问题（都要被本测试锁死）：
 *  1. 「通过订阅管理清理掉缓存后，立即打开搜索框，看不到正在加载订阅的数据」——静默加载；
 *  2. 「怎么一直显示加载中？我搜索也有数据了，也没有显示加载进度」——提示卡住不消失、
 *     且不显示进度条数。
 *
 * 油猴版逻辑（v7.9.5）：
 *  - dataInitFun：`searchPlaceholder("UPDATE", "🔁 数据准备更新中...", 5000)`
 *      → 开始加载时显示「准备更新中」，5s 后自动恢复默认提示。
 *  - refreshNewData（每解析完一个数据块，防抖 200ms）：`searchPlaceholder("UPDATE")`
 *      → 缺省文案 `🔁 数据库更新到 N条`（N = 当前数据条数，即加载进度），
 *        并重置恢复计时（clearTimeout + setTimeout），1200ms 后自动恢复默认提示。
 *  - searchPlaceholder 每次都先 clearTimeout 再 setTimeout ⇒ 提示「一定会自动消失」。
 */
import {
  resolvePlaceholder,
  placeholderProgressText,
  PLACEHOLDER_DEFAULT_TEXT,
  PLACEHOLDER_PREPARING_TEXT,
  PLACEHOLDER_RESTORE_MS,
  PLACEHOLDER_PREPARE_MS,
} from "../src/lib/util.ts";

let pass = 0;
let fail = 0;
const ok = (cond, name) => {
  if (cond) pass++;
  else {
    fail++;
    console.log("  FAIL:", name);
  }
};

// ---- 1. 时长常量与原版一致 ----
ok(PLACEHOLDER_RESTORE_MS === 1200, "进度提示 duration = 1200（原版默认值）");
ok(PLACEHOLDER_PREPARE_MS === 5000, "准备中 duration = 5000（原版 dataInitFun）");
ok(PLACEHOLDER_DEFAULT_TEXT === "我的搜索", "默认提示为「我的搜索」");
ok(
  PLACEHOLDER_PREPARING_TEXT === "🔁 数据准备更新中...",
  "准备中提示与原版文案一致"
);

// ---- 2. 准备阶段（equivalent: dataInitFun 的 5000ms 提示） ----
const preparing = resolvePlaceholder({ loading: true, preparing: true, count: 0 });
ok(preparing.text === "🔁 数据准备更新中...", "准备阶段显示「数据准备更新中...」");
ok(preparing.restoreMs === 5000, "准备提示 5s 后自动恢复");
// 关键回归（问题 2）：准备提示绝不能是“常驻”，否则会一直显示加载中
ok(preparing.restoreMs > 0, "准备提示会自动消失（不会一直卡在加载中）");

// ---- 3. 进度阶段（equivalent: refreshNewData 的 searchPlaceholder("UPDATE")） ----
const p0 = resolvePlaceholder({ loading: true, preparing: false, count: 0 });
ok(p0.text === "🔁 数据库更新到 0条", "进度提示显示条数（0 条）");
ok(p0.restoreMs === 1200, "进度提示 1.2s 后自动恢复");

const p128 = resolvePlaceholder({ loading: true, preparing: false, count: 128 });
ok(p128.text === "🔁 数据库更新到 128条", "进度提示随加载条数变化（128 条）");
ok(p128.restoreMs === 1200, "进度提示自动恢复");

const p417 = resolvePlaceholder({ loading: true, preparing: false, count: 417 });
ok(p417.text === "🔁 数据库更新到 417条", "加载完成时的进度文案（417 条）");

// 关键回归（问题 2 的核心）：加载中的提示必须带自动恢复时长
for (const count of [0, 1, 50, 200, 417]) {
  const r = resolvePlaceholder({ loading: true, preparing: false, count });
  ok(r.restoreMs > 0, `[${count}] 加载中提示会自动恢复（restoreMs=${r.restoreMs}）`);
}

// 关键回归：文案里必须出现条数（用户反馈「也没有显示加载进度」）
for (const count of [0, 7, 417]) {
  ok(
    resolvePlaceholder({ loading: true, count, preparing: false }).text.includes(`${count}条`),
    `[${count}] 进度提示包含条数`
  );
}

// 关键回归（问题 1）：加载中优先于「数据为空」，避免清理缓存后无任何反馈
ok(
  resolvePlaceholder({ loading: true, count: 0, preparing: true }).text !==
    resolvePlaceholder({ loading: false, count: 0 }).text,
  "加载中优先于数据为空（清理缓存后立刻有反馈）"
);

// ---- 4. 文案构造函数 ----
ok(placeholderProgressText(0) === "🔁 数据库更新到 0条", "placeholderProgressText(0)");
ok(placeholderProgressText(417) === "🔁 数据库更新到 417条", "placeholderProgressText(417)");
ok(placeholderProgressText(undefined) === "🔁 数据库更新到 0条", "非法输入按 0 处理");
ok(placeholderProgressText("88") === "🔁 数据库更新到 88条", "字符串数量可用");

// ---- 5. 加载完成后的状态提示 ----
const failed = resolvePlaceholder({ loading: false, count: 400, failed: 2 });
ok(failed.text.includes("400条") && failed.text.includes("2 个订阅加载失败"), "失败提示内容");
ok(failed.restoreMs === 1200, "失败提示自动恢复");

const cache = resolvePlaceholder({ loading: false, count: 417, fromCache: true });
ok(cache.text.includes("本地缓存") && cache.text.includes("417条"), "缓存提示内容");
ok(cache.restoreMs === 1200, "缓存提示自动恢复");

const normal = resolvePlaceholder({ loading: false, count: 417 });
ok(normal.text === "🔁 数据库更新到 417条", "正常更新提示");
ok(normal.restoreMs === 1200, "正常提示自动恢复");

// 数据为空是唯一需要常驻的提示（否则用户看不到排查指引）
const empty = resolvePlaceholder({ loading: false, count: 0 });
ok(empty.text.includes("数据为空"), "空数据提示");
ok(empty.restoreMs === 0, "空数据提示常驻（唯一常驻场景）");

// 数据为空且有订阅加载失败 → 提示必须包含失败数量（一眼定位原因，
// 如订阅被写成不存在的域名时不再像「网络问题」）
const emptyFailed = resolvePlaceholder({ loading: false, count: 0, failed: 3 });
ok(emptyFailed.text.includes("数据为空") && emptyFailed.text.includes("3 个订阅加载失败"), "空数据+失败提示含失败数量");
ok(emptyFailed.restoreMs === 0, "空数据+失败提示同样常驻");

// ---- 6. 任何「加载中」提示都必须带正数 restoreMs（禁止卡死） ----
const loadingCases = [
  { loading: true, preparing: true, count: 0 },
  { loading: true, preparing: false, count: 0 },
  { loading: true, preparing: false, count: 417 },
  { loading: true },
];
ok(
  loadingCases.every((c) => resolvePlaceholder(c).restoreMs > 0),
  "所有加载中提示都是自动恢复的（不会一直显示加载中）"
);

// ---- 7. 异常输入不崩溃 ----
ok(typeof resolvePlaceholder().text === "string", "无参数可用");
ok(resolvePlaceholder().text.length > 0, "无参数非空");
ok(Number.isFinite(resolvePlaceholder({ restoreMs: 1200 }).restoreMs), "restoreMs 为有限数");

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
