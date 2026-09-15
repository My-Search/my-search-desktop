/**
 * 全局快捷键录入/展示的纯函数集合（设置窗口「快捷键」面板使用）。
 *
 * 快捷键在后端的存储/注册形式与 global-hotkey 的字符串解析一致：
 * 小写、以「+」连接、修饰键在前、主键在最后，如 "ctrl+alt+s"、"ctrl+shift+f9"。
 * global-hotkey 对按键名的白名单（parse_key，v0.8）：
 *   KeyA..KeyZ / Digit0..Digit9（简写 a..z、0..9 亦可）、F1..F24、
 *   方向键（ArrowDown/Down 等）、Numpad 系、媒体键、
 *   Backquote/Backslash/BracketLeft/BracketRight/Comma/Equal/Minus/Period/Quote/
 *   Semicolon/Slash、Backspace/CapsLock/Enter/Space/Tab/Delete/End/Home/Insert/
 *   PageDown/PageUp/PrintScreen/ScrollLock/NumLock、Esc、Pause。
 *
 * 浏览器 keydown 事件的 e.code 恰好就是 "KeyA"/"Digit0"/"F9"/"ArrowDown"/"Backquote"
 * 这类命名，所以主键直接以 e.code 进入白名单；仅当浏览器没有提供 code
 * （个别输入法/虚拟键盘）时才回退到 e.key 推断。
 */

/** 修饰键：e.code -> 快捷键字符串中的小写名（global-hotkey 识别 ctrl/alt/shift/super） */
const MODIFIER_CODES: Record<string, string> = {
  ControlLeft: "ctrl",
  ControlRight: "ctrl",
  AltLeft: "alt",
  AltRight: "alt",
  ShiftLeft: "shift",
  ShiftRight: "shift",
  MetaLeft: "super",
  MetaRight: "super",
};

/** e.key 里可能是修饰键的集合（key 名与 code 名不同时用于判定） */
const MODIFIER_KEYS = new Set([
  "Control",
  "Alt",
  "Shift",
  "Meta",
  "AltGraph",
  "Fn",
  "FnLock",
]);

/** 主键白名单：除修饰键外允许录入的 e.code 前缀/精确名（对应 global-hotkey parse_key） */
const MAIN_KEY_EXACT = new Set([
  "Backquote",
  "Backslash",
  "BracketLeft",
  "BracketRight",
  "Comma",
  "Equal",
  "Minus",
  "Period",
  "Quote",
  "Semicolon",
  "Slash",
  "Backspace",
  "CapsLock",
  "Enter",
  "NumpadEnter",
  "Space",
  "Tab",
  "Delete",
  "End",
  "Home",
  "Insert",
  "PageDown",
  "PageUp",
  "PrintScreen",
  "ScrollLock",
  "NumLock",
  "Pause",
  "NumpadAdd",
  "NumpadDecimal",
  "NumpadDivide",
  "NumpadEqual",
  "NumpadMultiply",
  "NumpadSubtract",
]);

/** 录入交互中的特殊键：Esc=取消，Backspace=清空（交给调用方处理，不算组合键） */
export const CANCEL_KEY = "escape";

/** 主键是否在白名单内（e.code 或回退时用 e.key 推断的 code 形式） */
export function isSupportedMainKey(code: string | null | undefined): boolean {
  if (typeof code !== "string" || code === "") return false;
  if (code in MODIFIER_CODES) return false;
  if (MAIN_KEY_EXACT.has(code)) return true;
  return /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4])|Numpad[0-9]|Arrow(Up|Down|Left|Right))$/.test(
    code
  );
}

/**
 * 判断修饰键 + 主键的组合是否可被后端注册：
 * global-hotkey 要求修饰键在前、只能有一个主键；这里约定**必须至少含一个修饰键**
 * （无修饰键的单键全局热键极易与日常输入冲突，不允许录入）。
 * @param {string[]} modifiers 已收集的修饰键名（ctrl/alt/shift/super）
 * @param {string} mainKey 主键 code（白名单内）
 */
export function validateCombo(
  modifiers: string[],
  mainKey: string | null | undefined
): { ok: boolean; reason?: string } {
  if (!(modifiers.length > 0)) return { ok: false, reason: "至少需要一个修饰键（Ctrl / Alt / Shift / Win）" };
  if (mainKey == null || !isSupportedMainKey(mainKey)) {
    return { ok: false, reason: "不支持该按键，请换一个" };
  }
  return { ok: true };
}

/**
 * 把 keydown 事件转换为「修饰键数组 + 主键 code」的中间结果。
 *
 * 返回：
 * - { kind: "modifier-only" }  只按了修饰键（等待主键）
 * - { kind: "cancel" }         Esc（取消录入）
 * - { kind: "clear" }          仅 Backspace（清空已录入）
 * - { kind: "combo", modifiers, mainKey, mainKeyLabel }
 *                              形成了一次组合（可能合法也可能非法，由 validateCombo 校验）
 * - { kind: "ignore" }         其余（未形成组合，忽略）
 *
 * @param {{code?: string, key?: string, ctrlKey?: boolean, altKey?: boolean,
 *          shiftKey?: boolean, metaKey?: boolean}} ev 只取用到的字段，便于测试
 */
export interface ShortcutKeydownEvent {
  code?: string;
  key?: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}

/** interpretKeydown 的解析结果 */
export type KeydownVerdict =
  | { kind: "modifier-only" }
  | { kind: "cancel" }
  | { kind: "clear" }
  | { kind: "combo"; modifiers: string[]; mainKey: string; mainKeyLabel: string }
  | { kind: "ignore" };

export function interpretKeydown(ev: ShortcutKeydownEvent): KeydownVerdict {
  const code = typeof ev.code === "string" ? ev.code : "";
  const key = typeof ev.key === "string" ? ev.key : "";

  // 修饰键按下（code 可靠时以 code 为准）
  if (code in MODIFIER_CODES) return { kind: "modifier-only" };

  // code 缺失时用 key 判断是否修饰键（个别环境异常事件，无 ctrlKey 标志可依）
  if (!code && MODIFIER_KEYS.has(key)) return { kind: "modifier-only" };

  const modifierNames: string[] = [
    ev.ctrlKey ? "ctrl" : null,
    ev.altKey ? "alt" : null,
    ev.shiftKey ? "shift" : null,
    ev.metaKey ? "super" : null,
  ].filter((v): v is string => Boolean(v));

  // Esc 取消录入；未带修饰键的 Backspace 表示清空
  if (code === "Escape" || key === "Escape") return { kind: "cancel" };
  if (code === "Backspace" && modifierNames.length === 0) return { kind: "clear" };

  if (!code && !key) return { kind: "ignore" };

  let mainKey = code;
  let mainKeyLabel = key;
  if (!mainKey && key) {
    // 浏览器未提供 code：用 key 推断 code 形式（字母/数字/F 键等可覆盖，其余不支持）
    if (/^[a-zA-Z]$/.test(key)) mainKey = "Key" + key.toUpperCase();
    else if (/^[0-9]$/.test(key)) mainKey = "Digit" + key;
    else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) mainKey = key;
    else return { kind: "ignore" };
    mainKeyLabel = key.toUpperCase();
  }

  return { kind: "combo", modifiers: modifierNames, mainKey, mainKeyLabel };
}

/**
 * 组合键字符串（"ctrl+alt+s"）-> 展示用键帽数组（["Ctrl", "Alt", "S"]）。
 * 无法识别的片段原样展示（首字母大写），保证存储值损坏时不至于空白。
 * @param {string} shortcut
 * @returns {string[]}
 */
export function shortcutToCaps(shortcut: string | null | undefined): string[] {
  return String(shortcut ?? "")
    .split("+")
    .map((t) => t.trim())
    .filter(Boolean)
    .map((token) => {
      if (/^key[a-z]$/i.test(token)) return token.slice(3).toUpperCase();
      if (/^digit[0-9]$/i.test(token)) return token.slice(5);
      if (/^numpad[0-9]$/i.test(token)) return "Num " + token.slice(6);
      if (/^arrowup$/i.test(token)) return "↑";
      if (/^arrowdown$/i.test(token)) return "↓";
      if (/^arrowleft$/i.test(token)) return "←";
      if (/^arrowright$/i.test(token)) return "→";
      if (/^esc(ape)?$/i.test(token)) return "Esc";
      if (/^space$/i.test(token)) return "Space";
      if (/^super$/i.test(token)) return "Win";
      if (/^ctrl$/i.test(token)) return "Ctrl";
      if (/^alt$/i.test(token)) return "Alt";
      if (/^shift$/i.test(token)) return "Shift";
      return token.charAt(0).toUpperCase() + token.slice(1);
    });
}

/**
 * 修饰键数组 + 主键 code -> 存储用字符串（"ctrl+alt+s"）。
 * KeyA/Digit0 这类 code 归一为 global-hotkey 同样识别的简写 a/0，
 * 保证存储串人类可读、也便于在展示端统一处理。
 * @param {string[]} modifiers
 * @param {string} mainKey
 */
export function comboToString(modifiers: string[], mainKey: string | null | undefined): string {
  let key = String(mainKey ?? "").toLowerCase();
  const letter = key.match(/^key([a-z])$/);
  if (letter) key = letter[1];
  const digit = key.match(/^digit([0-9])$/);
  if (digit) key = digit[1];
  return [...modifiers, key].join("+");
}
