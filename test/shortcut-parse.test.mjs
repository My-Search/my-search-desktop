/**
 * 回归测试：快捷键录入的纯函数逻辑（src/lib/shortcut.js）
 *
 * 「快捷键设置」面板把 keydown 事件转成 global-hotkey 可解析的字符串
 * （小写、+ 连接、修饰键在前，如 "ctrl+alt+s"），然后交给 Rust 端注册。
 * 这里覆盖：
 *  1. interpretKeydown：组合 / 纯修饰键 / Esc 取消 / Backspace 清空 / 忽略
 *  2. validateCombo：必须含修饰键、主键需在白名单内
 *  3. comboToString / shortcutToCaps：存储串 <-> 展示键帽 的往返一致
 */
import {
  interpretKeydown,
  validateCombo,
  shortcutToCaps,
  comboToString,
  isSupportedMainKey,
} from "../src/lib/shortcut.js";

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

/** 构造一个模拟 keydown 事件（只含 shortcut.js 用到的字段） */
function ev({ code, key, ctrlKey = false, altKey = false, shiftKey = false, metaKey = false }) {
  return { code, key, ctrlKey, altKey, shiftKey, metaKey };
}

// ---- interpretKeydown：组合键 ----
check(
  "Ctrl+Alt+S 组合",
  interpretKeydown(ev({ code: "KeyS", key: "s", ctrlKey: true, altKey: true })),
  { kind: "combo", modifiers: ["ctrl", "alt"], mainKey: "KeyS", mainKeyLabel: "s" }
);
check(
  "Ctrl+Shift+F9 组合（大小写无关）",
  interpretKeydown(ev({ code: "F9", key: "F9", ctrlKey: true, shiftKey: true })),
  { kind: "combo", modifiers: ["ctrl", "shift"], mainKey: "F9", mainKeyLabel: "F9" }
);
check(
  "Win(Meta)+Q 组合（Meta -> super）",
  interpretKeydown(ev({ code: "KeyQ", key: "q", metaKey: true })),
  { kind: "combo", modifiers: ["super"], mainKey: "KeyQ", mainKeyLabel: "q" }
);
check(
  "数字主键",
  interpretKeydown(ev({ code: "Digit0", key: "0", altKey: true })),
  { kind: "combo", modifiers: ["alt"], mainKey: "Digit0", mainKeyLabel: "0" }
);
check(
  "修饰键收集顺序固定 ctrl/alt/shift/super",
  interpretKeydown(ev({ code: "Comma", key: ",", shiftKey: true, ctrlKey: true, metaKey: true }))
    .modifiers,
  ["ctrl", "shift", "super"]
);

// ---- interpretKeydown：特殊键 ----
check(
  "纯修饰键 -> 等待主键",
  interpretKeydown(ev({ code: "ControlLeft", key: "Control", ctrlKey: true })).kind,
  "modifier-only"
);
check(
  "Esc -> 取消",
  interpretKeydown(ev({ code: "Escape", key: "Escape" })).kind,
  "cancel"
);
check(
  "Esc 带修饰键也优先取消",
  interpretKeydown(ev({ code: "Escape", key: "Escape", ctrlKey: true })).kind,
  "cancel"
);
check(
  "仅 Backspace -> 清空",
  interpretKeydown(ev({ code: "Backspace", key: "Backspace" })).kind,
  "clear"
);
check(
  "Ctrl+Backspace 是组合而不是清空",
  interpretKeydown(ev({ code: "Backspace", key: "Backspace", ctrlKey: true })).kind,
  "combo"
);
check(
  "无 code 无 key -> 忽略",
  interpretKeydown(ev({})).kind,
  "ignore"
);

// ---- interpretKeydown：code 缺失时用 key 推断 ----
check(
  "缺 code：字母 key 推断 KeyS",
  interpretKeydown(ev({ key: "s", ctrlKey: true, altKey: true })).mainKey,
  "KeyS"
);
check(
  "缺 code：数字 key 推断 Digit1",
  interpretKeydown(ev({ key: "1", altKey: true })).mainKey,
  "Digit1"
);
check(
  "缺 code：无法推断的 key -> 忽略",
  interpretKeydown(ev({ key: "死", ctrlKey: true })).kind,
  "ignore"
);

// ---- validateCombo ----
check(
  "无修饰键 -> 拒绝",
  validateCombo([], "KeyS").ok,
  false
);
check(
  "有修饰键 + 合法主键 -> 通过",
  validateCombo(["ctrl", "alt"], "KeyS").ok,
  true
);
check(
  "修饰键 + 非白名单主键（MediaSelect）-> 拒绝",
  validateCombo(["ctrl"], "MediaSelect").ok,
  false
);
check(
  "修饰键本身不能当主键",
  validateCombo(["alt"], "ControlLeft").ok,
  false
);

// ---- isSupportedMainKey ----
check("KeyA 支持", isSupportedMainKey("KeyA"), true);
check("Digit9 支持", isSupportedMainKey("Digit9"), true);
check("F24 支持", isSupportedMainKey("F24"), true);
check("F25 不支持", isSupportedMainKey("F25"), false);
check("ArrowUp 支持", isSupportedMainKey("ArrowUp"), true);
check("Numpad0 支持", isSupportedMainKey("Numpad0"), true);
check("Semicolon 支持", isSupportedMainKey("Semicolon"), true);
check("Space 支持", isSupportedMainKey("Space"), true);
check("ShiftLeft 是修饰键，不支持做主键", isSupportedMainKey("ShiftLeft"), false);
check("空串不支持", isSupportedMainKey(""), false);

// ---- comboToString / shortcutToCaps ----
check(
  "组合转存储串",
  comboToString(["ctrl", "alt"], "KeyS"),
  "ctrl+alt+s"
);
check(
  "默认快捷键解析为键帽",
  shortcutToCaps("ctrl+alt+s"),
  ["Ctrl", "Alt", "S"]
);
check(
  "Win 键展示为 Win",
  shortcutToCaps("super+q"),
  ["Win", "Q"]
);
check(
  "方向键展示为箭头",
  shortcutToCaps("ctrl+arrowup"),
  ["Ctrl", "↑"]
);
check(
  "数字与 F 键",
  shortcutToCaps("ctrl+shift+f9"),
  ["Ctrl", "Shift", "F9"]
);
check(
  "未知片段原样保留（不空白）",
  shortcutToCaps("ctrl+???"),
  ["Ctrl", "???"]
);
check(
  "空值 -> 空数组",
  shortcutToCaps(null),
  []
);

console.log("");
if (failures.length || failures > 0) {
  console.error(`结果: ${failures} 项失败`);
  process.exit(1);
}
console.log("结果: 全部通过");
