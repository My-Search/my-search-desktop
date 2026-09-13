/**
 * 回归测试：窗口失焦自动隐藏的判定
 *
 * 用户反馈：
 *  1. 查看附加内容 / 打开脚本应用时，点了应用外面的地方（失去焦点）
 *     不应该隐藏窗口 —— 原脚本就是这样的（`SHOW_ITEM_DETAIL` 不隐藏）。
 *  2. 结果列表展示中（「呼出后搜索显示了列表，此时点窗口外」）**应该隐藏**。
 *
 * 规则（`src/lib/util.js` 的 shouldHideOnBlur / resolveViewMode）：
 * - 等待搜索 → 隐藏
 * - 结果列表展示中 → 隐藏
 * - 详情视图（简述内容 / 附加内容 / 脚本应用）→ 不隐藏
 * - 搜索进行中、`:debug` 指令模式 → 不隐藏
 *
 * 油猴版 showView() 中 input.blur 的判定（v7.9.5）：
 * ```js
 * registry.view.element.input.blur(function() {
 *   if (isLogoButtonPressedRef.value) return;
 *   setTimeout(function(){
 *     const isDebuging = isInstructions("debug");
 *     const isSearching = registry.searchData.searchEven.isSearching;
 *     let isWaitSearch = registry.view.seeNowMode() === registry.view.modeEnum.WAIT_SEARCH;
 *     if(isDebuging || isSearching || !isWaitSearch || isLogoButtonPressedRef.value) return;
 *     registry.view.viewVisibilityController(false);   // 只有这里才隐藏
 *   }, registry.view.delayedHideTime);
 * });
 * ```
 * 桌面版与原版的两点差异：
 * - 结果列表展示中：原版 `!isWaitSearch` 不隐藏，桌面版改为隐藏（本次反馈）
 * - 监听窗口失焦而非输入框 blur，所以不需要 `isLogoButtonPressedRef` 分支
 */
import { shouldHideOnBlur, resolveViewMode } from "../src/lib/util.js";

/** 与 src/main.js 的 MODE 保持一致的模式枚举 */
const MODE = {
  WAIT_SEARCH: 0,
  SHOW_RESULT: 1,
  SHOW_ITEM_DETAIL: 2,
};
/** 主窗口里同样存在 HIDE 模式（窗口已收起），数值与原版 modeEnum.HIDE 一致 */
const MODE_ENUM = { HIDE: -1, ...MODE };

/** 按「模式」判定是否隐藏（主窗口调用 shouldHideOnBlur 的真实形态） */
const hideOf = (mode, extra = {}) => shouldHideOnBlur({ mode, modeEnum: MODE_ENUM, ...extra });

let pass = 0;
let fail = 0;
const ok = (cond, name) => {
  if (cond) pass++;
  else {
    fail++;
    console.log("  FAIL:", name);
  }
};

// ---- 1. 等待搜索 → 隐藏（原有体验） ----
ok(hideOf(MODE.WAIT_SEARCH) === true, "等待搜索：失焦隐藏");
ok(
  hideOf(MODE.WAIT_SEARCH, { isSearching: false, inputValue: "" }) === true,
  "等待搜索（输入框空）：失焦隐藏"
);

// ---- 2. ★ 结果列表展示中 → 隐藏（本次用户反馈的核心） ----
ok(hideOf(MODE.SHOW_RESULT) === true, "结果列表展示中：失焦隐藏（本次调整）");
ok(
  hideOf(MODE.SHOW_RESULT, { isSearching: false, inputValue: "微信" }) === true,
  "结果列表展示中（有关键词）：失焦隐藏"
);
// 无结果时不再显示任何提示（列表清空、回到等待搜索态），失焦同样隐藏
ok(hideOf(MODE.WAIT_SEARCH, { inputValue: "不存在的关键词" }) === true, "无结果（等待搜索态）：失焦隐藏");

// ---- 3. 详情视图（简述内容 / 附加内容 / 脚本应用）→ 不隐藏（原有体验保留） ----
ok(hideOf(MODE.SHOW_ITEM_DETAIL) === false, "详情视图（简述内容 / 附加内容 / 脚本应用）：失焦不隐藏");
ok(
  hideOf(MODE.SHOW_ITEM_DETAIL, { isSearching: false, inputValue: "" }) === false,
  "详情视图 + 未搜索：失焦不隐藏"
);

// ---- 4. 搜索进行中 → 不隐藏（还原 searchEven.isSearching），优先级高于模式 ----
ok(
  hideOf(MODE.WAIT_SEARCH, { isSearching: true }) === false,
  "搜索进行中：即使还在等待搜索状态，也不隐藏"
);
ok(hideOf(MODE.SHOW_RESULT, { isSearching: true }) === false, "搜索进行中 + 结果展示：不隐藏");
ok(hideOf(MODE.SHOW_ITEM_DETAIL, { isSearching: true }) === false, "搜索进行中 + 详情视图：不隐藏");

// ---- 5. `:debug` 指令模式 → 不隐藏（还原 isInstructions("debug")）----
// 原版正则 `^\s*:debug\s*$`（i 标志）：大小写不敏感、允许两端空白
for (const v of [":debug", "  :debug  ", ":DEBUG", ":Debug", " :debug\t"]) {
  ok(hideOf(MODE.WAIT_SEARCH, { inputValue: v }) === false, `指令模式 ${JSON.stringify(v)}：不隐藏`);
  ok(hideOf(MODE.SHOW_RESULT, { inputValue: v }) === false, `指令模式 + 结果：${JSON.stringify(v)} 不隐藏`);
}
// 只有纯粹的 `:debug` 才算指令模式，其它输入不影响判定
for (const v of [":debugx", "x:debug", "debug", "", "  "]) {
  ok(hideOf(MODE.WAIT_SEARCH, { inputValue: v }) === true, `普通输入 ${JSON.stringify(v)}：仍会隐藏`);
  ok(hideOf(MODE.SHOW_RESULT, { inputValue: v }) === true, `普通输入 + 结果：${JSON.stringify(v)} 仍会隐藏`);
}

// ---- 6. 异常输入不崩溃 ----
ok(shouldHideOnBlur() === false, "无参数：不允许隐藏（安全默认）");
ok(shouldHideOnBlur({}) === false, "空对象：不允许隐藏（安全默认）");
ok(shouldHideOnBlur({ mode: undefined, modeEnum: MODE }) === false, "mode 未定义：不隐藏");
ok(
  typeof shouldHideOnBlur({ mode: MODE.SHOW_RESULT, inputValue: null }) === "boolean",
  "inputValue 为 null 不崩溃"
);
ok(
  typeof shouldHideOnBlur({ mode: MODE.SHOW_RESULT, modeEnum: undefined }) === "boolean",
  "modeEnum 缺失不崩溃（安全默认不隐藏）"
);

// ---- 7. 真值表（模式 × 搜索中 × 输入） ----
const cases = [
  // [mode, isSearching, inputValue, 期望是否隐藏]
  [MODE.WAIT_SEARCH, false, "", true], // 等待搜索 → 隐藏
  [MODE.WAIT_SEARCH, true, "", false], // isSearching
  [MODE.SHOW_RESULT, false, "", true], // ★ 结果展示 → 隐藏（桌面版调整）
  [MODE.SHOW_RESULT, true, "", false], // isSearching 优先
  [MODE.SHOW_ITEM_DETAIL, false, "", false], // 详情视图不隐藏
  [MODE.SHOW_ITEM_DETAIL, true, "", false],
  [MODE.WAIT_SEARCH, false, ":debug", false], // isDebuging
  [MODE.SHOW_RESULT, false, ":debug", false],
  [MODE.SHOW_ITEM_DETAIL, false, ":debug", false],
];
for (const [mode, isSearching, inputValue, expected] of cases) {
  ok(
    hideOf(mode, { isSearching, inputValue }) === expected,
    `真值表 mode=${mode} searching=${isSearching} input=${JSON.stringify(inputValue)} → ${
      expected ? "隐藏" : "不隐藏"
    }`
  );
}

// ---- 8. resolveViewMode：与油猴版 seeNowMode() 优先级一致（详情 > 结果 > 等待） ----
ok(
  resolveViewMode({ textViewVisible: true, resultVisible: true, modeEnum: MODE_ENUM }) ===
    MODE.SHOW_ITEM_DETAIL,
  "resolveViewMode：详情视图优先于结果列表"
);
ok(
  resolveViewMode({ textViewVisible: false, resultVisible: true, modeEnum: MODE_ENUM }) ===
    MODE.SHOW_RESULT,
  "resolveViewMode：结果列表展示中"
);
ok(
  resolveViewMode({ textViewVisible: false, resultVisible: false, modeEnum: MODE_ENUM }) ===
    MODE.WAIT_SEARCH,
  "resolveViewMode：都没有显示 → 等待搜索"
);
ok(resolveViewMode({ modeEnum: MODE_ENUM }) === MODE.WAIT_SEARCH, "resolveViewMode：无参数不崩溃");

// 组合：主窗口的实际调用链（DOM 可见性 → 模式 → 是否隐藏）
const hideFromDom = (textViewVisible, resultVisible, extra = {}) =>
  shouldHideOnBlur({
    mode: resolveViewMode({ textViewVisible, resultVisible, modeEnum: MODE_ENUM }),
    modeEnum: MODE_ENUM,
    ...extra,
  });
ok(hideFromDom(false, true) === true, "DOM 链路：结果列表显示中 → 隐藏");
ok(hideFromDom(true, false) === false, "DOM 链路：详情视图显示中 → 不隐藏");
ok(hideFromDom(false, false) === true, "DOM 链路：等待搜索 → 隐藏");
ok(hideFromDom(true, false, { inputValue: "微信" }) === false, "DOM 链路：详情视图 + 关键词 → 不隐藏");

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
