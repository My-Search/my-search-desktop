/**
 * 回归测试：快捷键绑定的纯函数逻辑（src/lib/shortcut-bindings.ts）
 *
 * 「设置 → 快捷键」现在每条配置由三部分组成：**快捷键 / 作用类型 / 作用对象**
 * （作用类型 = 呼出隐藏窗口 或 打开插件；打开插件时作用对象 = 插件 id）。
 * 这里覆盖：
 *  1. parseBinding(s)：字段校验（作用类型未知 / 打开插件缺插件 id 都判非法）
 *  2. parseBindings：脏数据跳过 + 去重 + 兜底默认呼出键
 *  3. validateBindings：空列表 / 重复键 / 多条呼出 / 缺插件 都要拦下来
 *  4. serializeBindings：字段名与 Rust 侧 ShortcutBinding 对齐（往返一致）
 *  5. nextFreeShortcut / describeBinding / canRemoveBinding：UI 辅助逻辑
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
  DEFAULT_TOGGLE_SHORTCUT,
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

// ---- canRemoveBinding ----
check("呼出/隐藏不可删除", canRemoveBinding(defaultToggleBinding()), false);
check(
  "插件绑定可删除",
  canRemoveBinding({ shortcut: "ctrl+alt+1", action: "open-plugin", target: "com.a.b" }),
  true
);

console.log("");
if (failures > 0) {
  console.error(`结果: ${failures} 项失败`);
  process.exit(1);
}
console.log("结果: 全部通过");
