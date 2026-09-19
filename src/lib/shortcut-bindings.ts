/**
 * 快捷键绑定（**快捷键 / 作用类型 / 作用对象**）的纯函数集合。
 *
 * 一条绑定回答三个问题：
 *   1. 按什么键：`shortcut`（"ctrl+alt+1"，格式与后端 global-hotkey 一致）
 *   2. 做什么事：`action`（toggle-window = 呼出/隐藏搜索框；open-plugin = 打开插件）
 *   3. 对谁做：`target`（open-plugin 时是插件 id；toggle-window 时为 null）
 *
 * 存储形态（settings.json 的 `shortcut_bindings`）与 Rust 侧
 * `ShortcutBinding`（src-tauri/src/lib.rs）完全一致，读写的字段名不要改：
 *   { "shortcut": "ctrl+alt+s", "action": "toggle-window", "target": null }
 *
 * 本模块只做纯计算（解析 / 校验 / 展示文案），不碰 Vue、不碰 IPC，
 * 便于单测覆盖（见 test/shortcut-bindings.test.mjs）。
 */

/** 快捷键作用类型 */
export type ShortcutAction = "toggle-window" | "open-plugin";

/** 一条快捷键绑定 */
export interface ShortcutBinding {
  /** 组合键字符串（小写、+ 连接、修饰键在前，如 "ctrl+alt+s"） */
  shortcut: string;
  /** 作用类型 */
  action: ShortcutAction;
  /** 作用对象：open-plugin 时为插件 id，其它为 null */
  target: string | null;
}

/** 默认「呼出 / 隐藏搜索框」快捷键（与 Rust 端 DEFAULT_TOGGLE_SHORTCUT 一致） */
export const DEFAULT_TOGGLE_SHORTCUT = "ctrl+alt+s";

/** 绑定条数上限（与 Rust 端 MAX_SHORTCUT_BINDINGS 一致） */
export const MAX_SHORTCUT_BINDINGS = 50;

/** 作用类型的中文名（UI 下拉 / 列表展示共用） */
export const SHORTCUT_ACTION_LABELS: Record<ShortcutAction, string> = {
  "toggle-window": "呼出 / 隐藏搜索框",
  "open-plugin": "打开插件",
};

/** 是否是已知的作用类型 */
export function isShortcutAction(v: unknown): v is ShortcutAction {
  return v === "toggle-window" || v === "open-plugin";
}

/** 新建一条默认的「呼出 / 隐藏搜索框」绑定 */
export function defaultToggleBinding(shortcut: string = DEFAULT_TOGGLE_SHORTCUT): ShortcutBinding {
  return { shortcut, action: "toggle-window", target: null };
}

/**
 * 解析一条未知输入为绑定；不合法（缺字段 / 作用类型未知 / 打开插件却没选插件）返回 null。
 * 与 Rust `ShortcutBinding::from_value` 的判定保持一致。
 */
export function parseBinding(raw: unknown): ShortcutBinding | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const shortcut = typeof o.shortcut === "string" ? o.shortcut.trim() : "";
  if (shortcut === "") return null;
  if (!isShortcutAction(o.action)) return null;
  const targetRaw = typeof o.target === "string" ? o.target.trim() : "";
  const target = targetRaw === "" ? null : targetRaw;
  if (o.action === "open-plugin" && target == null) return null;
  return { shortcut, action: o.action, target: o.action === "open-plugin" ? target : null };
}

/** 解析后端返回的绑定列表（脏数据跳过；完全为空时回落到默认呼出键） */
export function parseBindings(raw: unknown): ShortcutBinding[] {
  if (!Array.isArray(raw)) return [defaultToggleBinding()];
  const out: ShortcutBinding[] = [];
  for (const item of raw) {
    const b = parseBinding(item);
    if (!b) continue;
    if (out.some((x) => x.shortcut === b.shortcut)) continue;
    if (b.action === "toggle-window" && out.some((x) => x.action === "toggle-window")) continue;
    out.push(b);
  }
  return out.length > 0 ? out : [defaultToggleBinding()];
}

/** 绑定列表 → 发给 Rust 的普通对象（保持字段顺序稳定，便于测试断言） */
export function serializeBindings(bindings: readonly ShortcutBinding[]): Array<{
  shortcut: string;
  action: ShortcutAction;
  target: string | null;
}> {
  return bindings.map((b) => ({ shortcut: b.shortcut, action: b.action, target: b.target ?? null }));
}

/**
 * 校验整套绑定（在提交给后端前先拦一道，错误文案直接展示给用户）。
 * @returns ok=false 时 reason 为可读原因
 */
export function validateBindings(bindings: readonly ShortcutBinding[]): { ok: boolean; reason?: string } {
  if (bindings.length === 0) {
    return { ok: false, reason: "至少保留一条「呼出 / 隐藏搜索框」" };
  }
  if (bindings.length > MAX_SHORTCUT_BINDINGS) {
    return { ok: false, reason: `快捷键数量不能超过 ${MAX_SHORTCUT_BINDINGS} 条` };
  }
  const seen = new Set<string>();
  let toggleCount = 0;
  for (const b of bindings) {
    const shortcut = String(b.shortcut ?? "").trim();
    if (shortcut === "") return { ok: false, reason: "有快捷键还没录入组合键" };
    if (seen.has(shortcut)) return { ok: false, reason: `快捷键「${shortcut}」重复了，请换一个` };
    seen.add(shortcut);
    if (!isShortcutAction(b.action)) return { ok: false, reason: "有快捷键的作用类型无效" };
    if (b.action === "toggle-window") {
      toggleCount += 1;
      if (toggleCount > 1) return { ok: false, reason: "「呼出 / 隐藏搜索框」只能设置一条快捷键" };
    } else if (!b.target) {
      return { ok: false, reason: "「打开插件」需要选择一个插件" };
    }
  }
  return { ok: true };
}

/** 一条绑定的展示文案：作用类型 + 作用对象 */
export function describeBinding(binding: ShortcutBinding, pluginNameOf?: (id: string) => string | null): string {
  if (binding.action === "toggle-window") return SHORTCUT_ACTION_LABELS["toggle-window"];
  const name = binding.target ? pluginNameOf?.(binding.target) ?? null : null;
  if (!name) {
    // 插件已卸载 / 列表还没加载出来：退化为 id，避免显示成空白
    return binding.target ? `打开插件「${binding.target}」` : "打开插件";
  }
  return `打开插件「${name}」`;
}

/**
 * 新增绑定时挑一个「没被占用」的默认组合键（Ctrl+Alt+1/2/…/9，再退到 F 键）。
 * 返回 null 表示可用组合都被占了（调用方让用户自己录一个）。
 */
export function nextFreeShortcut(bindings: readonly ShortcutBinding[]): string | null {
  const used = new Set(bindings.map((b) => b.shortcut));
  for (let i = 1; i <= 9; i++) {
    const candidate = `ctrl+alt+${i}`;
    if (!used.has(candidate)) return candidate;
  }
  for (let i = 1; i <= 12; i++) {
    const candidate = `ctrl+alt+f${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return null;
}

/** 该绑定是否可以删除（呼出/隐藏是必需能力，不允许删；只能改键） */
export function canRemoveBinding(binding: ShortcutBinding): boolean {
  return binding.action !== "toggle-window";
}
