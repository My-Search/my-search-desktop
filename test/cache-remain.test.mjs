/**
 * 数据缓存「剩余时间」测试：验证设置窗口「数据缓存」面板展示的
 * 过期剩余时长计算正确（对应用户需求：在数据缓存页面显示数据的过期剩余时间）。
 *
 * 关键验证点：
 * 1. 剩余时长的分档文案（天/小时/分/秒），精度随剩余量收敛，不出现「11 小时 59 分 30 秒」这种噪声
 * 2. 过期时刻文案（当天 / 明天 / 昨天 / 更远日期）
 * 3. 「条数 + 剩余时间」组合文案：未过期给出剩余时长与过期时刻，已过期给出失效时刻
 * 4. 边界与异常输入（0 / 负数 / NaN / null / 超长时长）不崩溃、语义正确
 * 5. 缓存未过期期间，剩余时长随时间单调递减（秒级刷新文案确实在变小）
 */
import {
  formatRemainDuration,
  formatClockTime,
  formatCacheCountText,
} from "../src/lib/util.js";

let pass = 0;
let fail = 0;
const ok = (cond, name) => {
  if (cond) pass++;
  else {
    fail++;
    console.log("  FAIL:", name);
  }
};

const HOUR = 1000 * 60 * 60;
const MINUTE = 1000 * 60;

// ---- 1. 剩余时长分档 ----
// 12 小时（effectiveDuration 默认值）应显示为「12 小时 0 分」
ok(formatRemainDuration(12 * HOUR) === "12 小时 0 分", `12 小时 → ${formatRemainDuration(12 * HOUR)}`);
// 未过期后的典型值：11 小时 59 分
ok(
  formatRemainDuration(11 * HOUR + 59 * MINUTE) === "11 小时 59 分",
  "11 小时 59 分"
);
// 精度收敛：不足 1 分钟时显示秒，不再显示 0 分 0 秒
ok(formatRemainDuration(30 * 1000) === "30 秒", `30 秒 → ${formatRemainDuration(30 * 1000)}`);
ok(formatRemainDuration(59 * 1000) === "59 秒", "59 秒");
ok(formatRemainDuration(MINUTE) === "1 分 0 秒", "1 分 0 秒");
ok(formatRemainDuration(90 * MINUTE) === "1 小时 30 分", "1 小时 30 分");
ok(formatRemainDuration(26 * HOUR) === "1 天 2 小时", "1 天 2 小时");
ok(formatRemainDuration(3 * 24 * HOUR + 5 * HOUR) === "3 天 5 小时", "3 天 5 小时");
// 天数分档不出现「小时」以外的零碎单位
ok(!formatRemainDuration(26 * HOUR).includes("分"), "≥1 天时精确到小时即可（不显示分）");
// 关键回归：小时档不显示秒（避免每分钟都跳秒的噪声）
ok(
  !/\d 小时 \d+ 分 \d+ 秒/.test(formatRemainDuration(11 * HOUR + 59 * MINUTE + 30 * 1000)),
  "小时档不显示秒（精度收敛）"
);

// ---- 2. 已过期 / 非法输入 ----
for (const bad of [0, -1, -HOUR, NaN, undefined, null, "abc", Infinity, -Infinity]) {
  ok(formatRemainDuration(bad) === "已过期", `非法剩余时长(${String(bad)}) → 已过期`);
}

// ---- 3. 过期时刻文案 ----
const now = new Date(2026, 8, 12, 6, 0, 0).getTime(); // 2026-09-12 06:00:00
const at = (d, h, m) => new Date(2026, 8, d, h, m, 0).getTime();
ok(formatClockTime(at(12, 23, 59), now) === "23:59", "当天 → 只显示时刻");
ok(formatClockTime(at(13, 3, 5), now) === "明天 03:05", "次日 → 明天 HH:MM（含补零）");
ok(formatClockTime(at(11, 9, 5), now) === "昨天 09:05", "前一日 → 昨天 HH:MM");
ok(formatClockTime(at(20, 3, 5), now) === "09-20 03:05", "更远 → MM-DD HH:MM");
// 跨月也要正确
ok(formatClockTime(new Date(2026, 9, 2, 8, 5).getTime(), now) === "10-02 08:05", "跨月 → 10-02 08:05");
// 非法时间戳返回空串（由调用方决定不显示该括号）
for (const bad of [0, -1, NaN, undefined, null, "x"]) {
  ok(formatClockTime(bad, now) === "", `非法时间戳(${String(bad)}) → 空串`);
}

// ---- 4. 「条数 + 剩余时间」组合文案 ----
const in12h = formatCacheCountText(1234, now + 12 * HOUR, now);
ok(in12h.startsWith("1,234 条内容"), `千分位条数 → ${in12h}`);
ok(in12h.includes("剩 12 小时 0 分"), "包含剩余时长");
ok(in12h.includes("18:00 过期"), "包含当天过期时刻");
ok(in12h.includes("约 18:00"), "当天过期时用「约」表述");

// 跨天过期：不能再用「约」，必须带出「明天」
const tomorrow = new Date(2026, 8, 13, 3, 19, 0).getTime();
const crossDay = formatCacheCountText(10, tomorrow, now);
ok(crossDay.includes("剩 21 小时 19 分"), `跨天剩余时长 → ${crossDay}`);
ok(crossDay.includes("明天 03:19 过期"), "跨天过期写「明天 HH:MM」");
ok(!crossDay.includes("约 明天"), "跨天不用「约」（避免歧义）");

// 已过期：给出「已过期」与失效时刻（失效时刻在 
// 「现在」之前，仍按「当天」显示，所以这里用 now-1s 的 05:59）
const expired = formatCacheCountText(88, now - 1000, now);
ok(expired.includes("88 条内容"), `已过期条数 → ${expired}`);
ok(expired.includes("已过期"), "已过期文案");
ok(!expired.includes("剩 "), "已过期不再显示剩余时长");
ok(expired.includes("05:59 失效"), "已过期显示失效时刻");

// 无 expire 字段（旧版缓存）：只显示条数，不虚构有效期
for (const none of [null, undefined, 0]) {
  const t = formatCacheCountText(5, none, now);
  ok(t === "5 条内容", `无有效期(${String(none)}) → 仅条数，实际 ${t}`);
}

// ---- 5. 异常输入不崩溃 ----
ok(typeof formatCacheCountText(undefined, undefined) === "string", "无参数可用");
ok(formatCacheCountText(-5, now + HOUR, now).startsWith("0 条内容"), "负数条数按 0 处理");
ok(formatCacheCountText(NaN, now + HOUR, now).startsWith("0 条内容"), "NaN 条数按 0 处理");
ok(formatRemainDuration(Number.MAX_SAFE_INTEGER).length > 0, "超大剩余时长可用");
ok(formatClockTime(Number.MAX_SAFE_INTEGER, now).length >= 0, "超大时间戳不崩溃");

// ---- 6. 倒计时的核心性质：剩余时长随时间递减 ----
const expireAt = now + 12 * HOUR;
const before = formatCacheCountText(417, expireAt, now);
const after = formatCacheCountText(417, expireAt, now + 60_000); // 一分钟后
ok(before !== after, "剩余时间随时间变化（文案不是静态的）");
ok(
  formatRemainDuration(expireAt - (now + 60_000)) === "11 小时 59 分",
  `一分钟后剩余 → ${formatRemainDuration(expireAt - (now + 60_000))}`
);
// 逐秒递减：剩余不足 1 分钟时，每秒文案都要变化
const nearExpire = now + 59_500;
ok(
  formatRemainDuration(nearExpire - now) !== formatRemainDuration(nearExpire - (now + 1000)),
  "剩余不足 1 分钟时逐秒变化（面板每秒刷新有意义）"
);
// 过期瞬间：从「剩 1 秒」变为「已过期」
ok(formatRemainDuration(1000) === "1 秒", "剩余 1 秒");
ok(formatRemainDuration(0) === "已过期", "剩余 0 秒即已过期");
ok(
  formatCacheCountText(1, now, now).includes("已过期"),
  "expire == now 判定为已过期（不显示「剩 0 秒」）"
);

console.log(`\n结果: ${pass} passed, ${fail} failed`);process.exit(fail === 0 ? 0 : 1);
