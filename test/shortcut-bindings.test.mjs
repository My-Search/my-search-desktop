/**
 * 回归测试：快捷键绑定的纯函数逻辑（src/lib/shortcut-bindings.ts）
 *
 * 「设置 → 快捷键」现在每条配置由三部分组成：**快捷键 / 作用类型 / 作用对象**
 * （作用类型 = 呼出隐藏窗口 / 打开插件 / 快速过滤 / 快捷打开项；打开插件时作用对象 =
 * 插件 id，快速过滤时作用对象 = 常用头文本，快捷打开项时作用对象 = 匹配文本）。
 * 这里覆盖：
 *  1. parseBinding(s)：字段校验（作用类型未知 / 打开插件缺插件 id / 快速过滤缺常用头 /
 *     快捷打开项缺匹配文本 都判非法）
 *  2. parseBindings：脏数据跳过 + 去重 + 兜底默认呼出键
 *  3. validateBindings：空列表 / 重复键 / 多条呼出 / 缺插件 / 缺常用头 / 缺匹配文本 都要拦下来
 *  4. isBindingComplete：草稿判定（作用对象没填完的行不参与校验，填完即完整）
 *  5. serializeBindings：字段名与 Rust 侧 ShortcutBinding 对齐（往返一致）
 *  6. nextFreeShortcut / describeBinding / canRemoveBinding：UI 辅助逻辑
 *  7. normalizeQuickFilterHeader：常用头归一化（去尾部「 : 」）
 */
import {
  parseBinding,
  parseBindings,
  validateBindings,
  serializeBindings,
  nextFreeShortcut,
  describeBinding,
  canRemoveBinding,
  defaultToggleBinding,
  isBindingComplete,
  normalizeQuickFilterHeader,
  actionRequiresTarget,
  isPluginShortcutAction,
  PLUGIN_SHORTCUT_ACTIONS,
  DEFAULT_TOGGLE_SHORTCUT,
  SEARCH_BOUNDARY,
} from "../src/lib/shortcut-bindings.ts";

let failures = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.error(`✗ ${name}`);
    console.error(`  期望: ${JSON.stringify(expected)}`);
    console.error(`  实际: ${JSON.stringify(actual)}`);
    return;
  }
  console.log(`✓ ${name}`);
}

// ---- parseBinding ----
check(
  "解析呼出/隐藏绑定",
  parseBinding({ shortcut: "ctrl+alt+s", action: "toggle-window" }),
  { shortcut: "ctrl+alt+s", action: "toggle-window", target: null }
);
check(
  "解析打开插件绑定（含作用对象）",
  parseBinding({ shortcut: "ctrl+alt+1", action: "open-plugin", target: "com.a.b" }),
  { shortcut: "ctrl+alt+1", action: "open-plugin", target: "com.a.b" }
);
check("打开插件缺少作用对象 -> 非法", parseBinding({ shortcut: "ctrl+alt+1", action: "open-plugin" }), null);
check("作用类型未知 -> 非法", parseBinding({ shortcut: "ctrl+alt+1", action: "run-shell" }), null);
check("缺快捷键 -> 非法", parseBinding({ action: "toggle-window" }), null);
check("空快捷键 -> 非法", parseBinding({ shortcut: "   ", action: "toggle-window" }), null);
check("非对象 -> 非法", parseBinding("ctrl+alt+s"), null);
check(
  "呼出/隐藏的 target 被归一为 null",
  parseBinding({ shortcut: "ctrl+alt+s", action: "toggle-window", target: "com.a.b" }),
  { shortcut: "ctrl+alt+s", action: "toggle-window", target: null }
);
check(
  "插件 id 两侧空白被裁掉",
  parseBinding({ shortcut: "ctrl+alt+1", action: "open-plugin", target: " com.a.b " }),
  { shortcut: "ctrl+alt+1", action: "open-plugin", target: "com.a.b" }
);

// ---- parseBinding：快速过滤 ----
check(
  "解析快速过滤绑定（含常用头）",
  parseBinding({ shortcut: "alt+f", action: "quick-filter", target: "百度翻译" }),
  { shortcut: "alt+f", action: "quick-filter", target: "百度翻译" }
);
check("快速过滤缺常用头 -> 非法", parseBinding({ shortcut: "alt+f", action: "quick-filter" }), null);
check(
  "快速过滤空常用头 -> 非法",
  parseBinding({ shortcut: "alt+f", action: "quick-filter", target: "   " }),
  null
);
check(
  "快速过滤常用头尾部「 : 」被归一化掉",
  parseBinding({ shortcut: "alt+f", action: "quick-filter", target: "百度翻译 : " }),
  { shortcut: "alt+f", action: "quick-filter", target: "百度翻译" }
);

// ---- parseBinding：快捷打开项 ----
check(
  "解析快捷打开项绑定（含匹配文本）",
  parseBinding({ shortcut: "alt+o", action: "quick-open", target: "百度翻译" }),
  { shortcut: "alt+o", action: "quick-open", target: "百度翻译" }
);
check("快捷打开项缺匹配文本 -> 非法", parseBinding({ shortcut: "alt+o", action: "quick-open" }), null);
check(
  "快捷打开项空匹配文本 -> 非法",
  parseBinding({ shortcut: "alt+o", action: "quick-open", target: "   " }),
  null
);
check(
  "快捷打开项只 trim，不吞冒号（冒号可能是标题的一部分）",
  parseBinding({ shortcut: "alt+o", action: "quick-open", target: "  百度翻译 :  " }),
  { shortcut: "alt+o", action: "quick-open", target: "百度翻译 :" }
);
check(
  "快捷打开项保留空格 AND 的多个词",
  parseBinding({ shortcut: "alt+o", action: "quick-open", target: " 百度 翻译 " }),
  { shortcut: "alt+o", action: "quick-open", target: "百度 翻译" }
);

// ---- normalizeQuickFilterHeader ----
check("归一化：去首尾空白", normalizeQuickFilterHeader("  百度翻译  "), "百度翻译");
check("归一化：去尾部「 : 」", normalizeQuickFilterHeader("百度翻译 : "), "百度翻译");
check("归一化：去尾部半角冒号", normalizeQuickFilterHeader("百度翻译:"), "百度翻译");
check("归一化：去尾部全角冒号", normalizeQuickFilterHeader("百度翻译："), "百度翻译");
check("归一化：去尾部多个冒号", normalizeQuickFilterHeader("百度翻译 : :  "), "百度翻译");
check("归一化：全空 -> 空串", normalizeQuickFilterHeader("  :  "), "");
check("归一化：保留中间冒号", normalizeQuickFilterHeader("A:B"), "A:B");

// ---- actionRequiresTarget ----
check("打开插件需要作用对象", actionRequiresTarget("open-plugin"), true);
check("快速过滤需要作用对象", actionRequiresTarget("quick-filter"), true);
check("快捷打开项需要作用对象", actionRequiresTarget("quick-open"), true);
check("呼出/隐藏不需要作用对象", actionRequiresTarget("toggle-window"), false);
check("截图不需要作用对象", actionRequiresTarget("screenshot"), false);

// ---- 截图（screenshot）动作：无作用对象、进白名单、可校验 ----
check(
  "解析截图绑定（无作用对象）",
  parseBinding({ shortcut: "ctrl+alt+x", action: "screenshot" }),
  { shortcut: "ctrl+alt+x", action: "screenshot", target: null }
);
check(
  "截图的 target 被归一为 null（即使传了）",
  parseBinding({ shortcut: "ctrl+alt+x", action: "screenshot", target: "com.a.b" }),
  { shortcut: "ctrl+alt+x", action: "screenshot", target: null }
);
check(
  "截图绑定通过校验（无作用对象也合法）",
  validateBindings([
    { shortcut: "ctrl+alt+s", action: "toggle-window", target: null },
    { shortcut: "ctrl+alt+x", action: "screenshot", target: null },
  ]).ok,
  true
);
check(
  "截图绑定序列化 target 为 null",
  serializeBindings([{ shortcut: "ctrl+alt+x", action: "screenshot", target: null }]),
  [{ shortcut: "ctrl+alt+x", action: "screenshot", target: null }]
);
check(
  "截图文案",
  describeBinding({ shortcut: "ctrl+alt+x", action: "screenshot", target: null }),
  "截图（框选 + 标注）"
);
check(
  "截图绑定可删除",
  canRemoveBinding({ shortcut: "ctrl+alt+x", action: "screenshot", target: null }),
  true
);

// ---- 剪贴板历史（clipboard）动作：无作用对象、进白名单、可校验 ----
check("剪贴板历史不需要作用对象", actionRequiresTarget("clipboard"), false);
check(
  "解析剪贴板历史绑定（无作用对象）",
  parseBinding({ shortcut: "ctrl+alt+v", action: "clipboard" }),
  { shortcut: "ctrl+alt+v", action: "clipboard", target: null }
);
check(
  "剪贴板历史的 target 被归一为 null（即使传了）",
  parseBinding({ shortcut: "ctrl+alt+v", action: "clipboard", target: "com.a.b" }),
  { shortcut: "ctrl+alt+v", action: "clipboard", target: null }
);
check(
  "剪贴板历史绑定通过校验（无作用对象也合法）",
  validateBindings([
    { shortcut: "ctrl+alt+s", action: "toggle-window", target: null },
    { shortcut: "ctrl+alt+v", action: "clipboard", target: null },
  ]).ok,
  true
);
check(
  "剪贴板历史绑定序列化 target 为 null",
  serializeBindings([{ shortcut: "ctrl+alt+v", action: "clipboard", target: null }]),
  [{ shortcut: "ctrl+alt+v", action: "clipboard", target: null }]
);
check(
  "剪贴板历史文案",
  describeBinding({ shortcut: "ctrl+alt+v", action: "clipboard", target: null }),
  "剪贴板历史"
);
check(
  "剪贴板历史绑定可删除",
  canRemoveBinding({ shortcut: "ctrl+alt+v", action: "clipboard", target: null }),
  true
);

// ---- parseBindings ----
check(
  "脏数据跳过、重复键去重、呼出只留一条",
  parseBindings([
    { shortcut: "ctrl+alt+s", action: "toggle-window" },
    { shortcut: "ctrl+alt+s", action: "open-plugin", target: "com.a.b" },
    { shortcut: "", action: "toggle-window" },
    { shortcut: "ctrl+alt+9", action: "toggle-window" },
    { shortcut: "ctrl+shift+1", action: "open-plugin", target: "com.c.d" },
  ]),
  [
    { shortcut: "ctrl+alt+s", action: "toggle-window", target: null },
    { shortcut: "ctrl+shift+1", action: "open-plugin", target: "com.c.d" },
  ]
);
check("非数组 -> 默认呼出键", parseBindings(null), [defaultToggleBinding()]);
check("空数组 -> 默认呼出键", parseBindings([]), [defaultToggleBinding()]);
check("默认呼出键值", defaultToggleBinding().shortcut, DEFAULT_TOGGLE_SHORTCUT);

// ---- validateBindings ----
check("空列表被拒", validateBindings([]).ok, false);
check(
  "重复快捷键被拒",
  validateBindings([
    { shortcut: "ctrl+alt+1", action: "toggle-window", target: null },
    { shortcut: "ctrl+alt+1", action: "open-plugin", target: "com.a.b" },
  ]).ok,
  false
);
check(
  "两条呼出被拒",
  validateBindings([
    { shortcut: "ctrl+alt+s", action: "toggle-window", target: null },
    { shortcut: "ctrl+alt+9", action: "toggle-window", target: null },
  ]).ok,
  false
);
check(
  "打开插件缺作用对象被拒",
  validateBindings([
    { shortcut: "ctrl+alt+s", action: "toggle-window", target: null },
    { shortcut: "ctrl+alt+1", action: "open-plugin", target: null },
  ]).ok,
  false
);
check(
  "合法组合通过",
  validateBindings([
    { shortcut: "ctrl+alt+s", action: "toggle-window", target: null },
    { shortcut: "ctrl+alt+1", action: "open-plugin", target: "com.a.b" },
  ]).ok,
  true
);
check(
  "快速过滤缺常用头被拒",
  validateBindings([
    { shortcut: "ctrl+alt+s", action: "toggle-window", target: null },
    { shortcut: "alt+f", action: "quick-filter", target: null },
  ]).ok,
  false
);
check(
  "快速过滤只有空白/分隔符被拒",
  validateBindings([
    { shortcut: "ctrl+alt+s", action: "toggle-window", target: null },
    { shortcut: "alt+f", action: "quick-filter", target: " : " },
  ]).ok,
  false
);
check(
  "快速过滤填了常用头即通过",
  validateBindings([
    { shortcut: "ctrl+alt+s", action: "toggle-window", target: null },
    { shortcut: "alt+f", action: "quick-filter", target: "百度翻译" },
  ]).ok,
  true
);
check(
  "快捷打开项缺匹配文本被拒",
  validateBindings([
    { shortcut: "ctrl+alt+s", action: "toggle-window", target: null },
    { shortcut: "alt+o", action: "quick-open", target: null },
  ]).ok,
  false
);
check(
  "快捷打开项只有空白被拒",
  validateBindings([
    { shortcut: "ctrl+alt+s", action: "toggle-window", target: null },
    { shortcut: "alt+o", action: "quick-open", target: "   " },
  ]).ok,
  false
);
check(
  "快捷打开项填了匹配文本即通过",
  validateBindings([
    { shortcut: "ctrl+alt+s", action: "toggle-window", target: null },
    { shortcut: "alt+o", action: "quick-open", target: "百度翻译" },
  ]).ok,
  true
);

// ---- isBindingComplete（草稿判定：新增/切换后填完才校验、才提交） ----
check("呼出/隐藏视为填完", isBindingComplete({ shortcut: "ctrl+alt+s", action: "toggle-window", target: null }), true);
check(
  "打开插件未选插件 -> 草稿",
  isBindingComplete({ shortcut: "ctrl+alt+1", action: "open-plugin", target: null }),
  false
);
check(
  "打开插件已选插件 -> 填完",
  isBindingComplete({ shortcut: "ctrl+alt+1", action: "open-plugin", target: "com.a.b" }),
  true
);
check(
  "快速过滤未填常用头 -> 草稿",
  isBindingComplete({ shortcut: "alt+f", action: "quick-filter", target: null }),
  false
);
check(
  "快速过滤只有分隔符 -> 草稿",
  isBindingComplete({ shortcut: "alt+f", action: "quick-filter", target: " : " }),
  false
);
check(
  "快速过滤填了常用头 -> 填完",
  isBindingComplete({ shortcut: "alt+f", action: "quick-filter", target: "百度翻译" }),
  true
);
check(
  "快捷打开项只有空白 -> 草稿",
  isBindingComplete({ shortcut: "alt+o", action: "quick-open", target: "   " }),
  false
);
check(
  "快捷打开项填了匹配文本 -> 填完",
  isBindingComplete({ shortcut: "alt+o", action: "quick-open", target: "百度翻译" }),
  true
);
check("缺快捷键 -> 草稿", isBindingComplete({ shortcut: "  ", action: "toggle-window", target: null }), false);
check(
  "面板同款流程：草稿过滤掉后整单通过校验（新增/切换不报错）",
  validateBindings(
    [
      { shortcut: "ctrl+alt+s", action: "toggle-window", target: null },
      { shortcut: "ctrl+alt+1", action: "open-plugin", target: null },
      { shortcut: "alt+f", action: "quick-filter", target: null },
    ].filter(isBindingComplete)
  ).ok,
  true
);
check(
  "面板同款流程：草稿填完后整单通过校验并被保留",
  validateBindings(
    [
      { shortcut: "ctrl+alt+s", action: "toggle-window", target: null },
      { shortcut: "ctrl+alt+1", action: "open-plugin", target: "com.a.b" },
    ].filter(isBindingComplete)
  ).ok,
  true
);

// ---- serializeBindings（字段名必须与 Rust ShortcutBinding 一致） ----
check(
  "序列化字段与后端对齐",
  serializeBindings([
    { shortcut: "ctrl+alt+s", action: "toggle-window", target: null },
    { shortcut: "ctrl+alt+1", action: "open-plugin", target: "com.a.b" },
  ]),
  [
    { shortcut: "ctrl+alt+s", action: "toggle-window", target: null },
    { shortcut: "ctrl+alt+1", action: "open-plugin", target: "com.a.b" },
  ]
);
check(
  "序列化时快速过滤常用头归一化（去尾部「 : 」）",
  serializeBindings([{ shortcut: "alt+f", action: "quick-filter", target: "百度翻译 : " }]),
  [{ shortcut: "alt+f", action: "quick-filter", target: "百度翻译" }]
);
check(
  "序列化时快捷打开项只 trim（保留冒号）",
  serializeBindings([{ shortcut: "alt+o", action: "quick-open", target: " 百度翻译 : " }]),
  [{ shortcut: "alt+o", action: "quick-open", target: "百度翻译 :" }]
);

// ---- nextFreeShortcut ----
check("优先用 ctrl+alt+1", nextFreeShortcut([defaultToggleBinding()]), "ctrl+alt+1");
check(
  "占用后顺延",
  nextFreeShortcut([
    defaultToggleBinding(),
    { shortcut: "ctrl+alt+1", action: "open-plugin", target: "com.a.b" },
  ]),
  "ctrl+alt+2"
);
check(
  "数字用满后落到 F 键",
  nextFreeShortcut([
    defaultToggleBinding(),
    ...Array.from({ length: 9 }, (_, i) => ({
      shortcut: `ctrl+alt+${i + 1}`,
      action: "open-plugin",
      target: `com.a.${i}`,
    })),
  ]),
  "ctrl+alt+f1"
);

// ---- describeBinding ----
check(
  "呼出/隐藏文案",
  describeBinding({ shortcut: "ctrl+alt+s", action: "toggle-window", target: null }),
  "呼出 / 隐藏搜索框"
);
check(
  "打开插件带上插件名",
  describeBinding({ shortcut: "ctrl+alt+1", action: "open-plugin", target: "com.a.b" }, (id) =>
    id === "com.a.b" ? "示例插件" : null
  ),
  "打开插件「示例插件」"
);
check(
  "插件已卸载时退化为 id",
  describeBinding({ shortcut: "ctrl+alt+1", action: "open-plugin", target: "com.a.b" }, () => null),
  "打开插件「com.a.b」"
);
check(
  "快速过滤文案带上自动补的分隔符",
  describeBinding({ shortcut: "alt+f", action: "quick-filter", target: "百度翻译" }),
  `快速过滤「百度翻译${SEARCH_BOUNDARY}」`
);
check(
  "快速过滤常用头为空时退化为类型名",
  describeBinding({ shortcut: "alt+f", action: "quick-filter", target: null }),
  "快速过滤"
);
check(
  "快捷打开项文案带上匹配文本",
  describeBinding({ shortcut: "alt+o", action: "quick-open", target: "百度翻译" }),
  "快捷打开项「百度翻译」"
);
check(
  "快捷打开项匹配文本为空时退化为类型名",
  describeBinding({ shortcut: "alt+o", action: "quick-open", target: null }),
  "快捷打开项"
);

// ---- canRemoveBinding ----
check("呼出/隐藏不可删除", canRemoveBinding(defaultToggleBinding()), false);
check(
  "插件绑定可删除",
  canRemoveBinding({ shortcut: "ctrl+alt+1", action: "open-plugin", target: "com.a.b" }),
  true
);
check(
  "快速过滤绑定可删除",
  canRemoveBinding({ shortcut: "alt+f", action: "quick-filter", target: "百度翻译" }),
  true
);
check(
  "快捷打开项绑定可删除",
  canRemoveBinding({ shortcut: "alt+o", action: "quick-open", target: "百度翻译" }),
  true
);

// ---- 插件动作：isPluginShortcutAction / describeBinding 的标题解析 ----
check("截图是插件动作", isPluginShortcutAction("screenshot"), true);
check("剪贴板历史是插件动作", isPluginShortcutAction("clipboard"), true);
check("呼出/隐藏不是插件动作", isPluginShortcutAction("toggle-window"), false);
check("打开插件不是插件动作", isPluginShortcutAction("open-plugin"), false);
check("PLUGIN_SHORTCUT_ACTIONS 收录两个动作", [...PLUGIN_SHORTCUT_ACTIONS], ["screenshot", "clipboard"]);
check(
  "插件动作标题解析优先于内置兜底",
  describeBinding({ shortcut: "ctrl+alt+x", action: "screenshot", target: null }, undefined, () => "截图（自定义标题）"),
  "截图（自定义标题）"
);
check(
  "无标题解析器时退回内置兜底文案",
  describeBinding({ shortcut: "ctrl+alt+v", action: "clipboard", target: null }, undefined, () => null),
  "剪贴板历史"
);

console.log("");
if (failures > 0) {
  console.error(`结果: ${failures} 项失败`);
  process.exit(1);
}
console.log("结果: 全部通过");
