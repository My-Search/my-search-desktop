/**
 * 快捷键绑定（**快捷键 / 作用类型 / 作用对象**）的纯函数集合。
 *
 * 一条绑定回答三个问题：
 *   1. 按什么键：`shortcut`（"ctrl+alt+1"，格式与后端 global-hotkey 一致）
 *   2. 做什么事：`action`（toggle-window = 呼出/隐藏搜索框；open-plugin = 打开插件；
 *      quick-filter = 快速过滤；quick-open = 快捷打开项）
 *   3. 对谁做：`target`（open-plugin 时是插件 id；quick-filter 时是常用头文本；
 *      quick-open 时是匹配文本；toggle-window 时为 null）
 *
 * 存储形态（settings.json 的 `shortcut_bindings`）与 Rust 侧
 * `ShortcutBinding`（src-tauri/src/lib.rs）完全一致，读写的字段名不要改：
 *   { "shortcut": "ctrl+alt+s", "action": "toggle-window", "target": null }
 *   { "shortcut": "ctrl+alt+1", "action": "open-plugin",   "target": "com.x.y" }
 *   { "shortcut": "alt+f",      "action": "quick-filter",  "target": "百度翻译" }
 *   { "shortcut": "alt+o",      "action": "quick-open",    "target": "百度翻译" }
 *
 * 本模块只做纯计算（解析 / 校验 / 展示文案），不碰 Vue、不碰 IPC，
 * 便于单测覆盖（见 test/shortcut-bindings.test.mjs）。
 */

/** 内置作用类型（宿主自身提供，永远可用） */
export type BuiltinShortcutAction =
  | "toggle-window"
  | "open-plugin"
  | "quick-filter"
  | "quick-open";

/**
 * **宿主原生的插件动作**：由插件清单声明、但由**宿主**执行。
 * 截图（开原生遮罩）/ 剪贴板历史（广播事件让前端开插件视图）都属于这类。
 * 只有对应插件**已安装**时才可用，卸载即移除（见 `availableShortcutActions`）。
 */
export type HostNativePluginShortcutAction = "screenshot" | "clipboard";

/**
 * **插件自定义动作**：`plugin:<插件id>:<动作名>`。
 *
 * 与宿主原生动作不同，这类动作的执行逻辑在**插件自己**（后台进程 + 插件界面）。
 * 宿主只负责：把主窗口带到前台 → 打开该插件视图 → 把动作派发给插件脚本
 * （插件用 `ms.shortcuts.onAction` 接收）。录屏这类「重活在自己后端」的能力走这条。
 */
export type PluginDefinedShortcutAction = `plugin:${string}`;

/** 快捷键作用类型 */
export type ShortcutAction =
  | BuiltinShortcutAction
  | HostNativePluginShortcutAction
  | PluginDefinedShortcutAction;

/** 插件自定义动作的前缀 */
export const PLUGIN_ACTION_PREFIX = "plugin:";

/** 宿主原生的插件动作（清单里用它们的保留名，不带前缀） */
export const HOST_NATIVE_PLUGIN_ACTIONS: readonly HostNativePluginShortcutAction[] = [
  "screenshot",
  "clipboard",
];

/**
 * 兼容旧名：宿主原生的插件动作集合。
 * @deprecated 新增判断请用 `isHostNativePluginAction` / `isPluginDefinedAction`。
 */
export const PLUGIN_SHORTCUT_ACTIONS = HOST_NATIVE_PLUGIN_ACTIONS;

/** 是否是宿主原生的插件动作（截图 / 剪贴板历史） */
export function isHostNativePluginAction(v: unknown): v is HostNativePluginShortcutAction {
  return (HOST_NATIVE_PLUGIN_ACTIONS as readonly unknown[]).includes(v);
}

/** 是否是插件自定义动作（`plugin:<id>:<name>`） */
export function isPluginDefinedAction(v: unknown): v is PluginDefinedShortcutAction {
  return (
    typeof v === "string" &&
    v.startsWith(PLUGIN_ACTION_PREFIX) &&
    v.length > PLUGIN_ACTION_PREFIX.length
  );
}

/**
 * 是否是**插件动作**（其可用性取决于对应插件是否已安装）：
 * 宿主原生（screenshot / clipboard）或插件自定义（`plugin:` 前缀）都算。
 */
export function isPluginShortcutAction(v: unknown): v is ShortcutAction {
  return isHostNativePluginAction(v) || isPluginDefinedAction(v);
}

/** 拼接一个插件自定义动作 id（`plugin:<pluginId>:<name>`） */
export function pluginDefinedActionId(pluginId: string, name: string): string {
  return `${PLUGIN_ACTION_PREFIX}${pluginId}:${name}`;
}

/** 取插件自定义动作的宿主（所属插件 id）；不是插件自定义动作时返回 null */
export function pluginDefinedActionOwner(action: unknown): string | null {
  if (!isPluginDefinedAction(action)) return null;
  const rest = action.slice(PLUGIN_ACTION_PREFIX.length);
  const i = rest.indexOf(":");
  if (i <= 0) return null;
  const id = rest.slice(0, i);
  const name = rest.slice(i + 1);
  return id && name ? id : null;
}

/** 取插件自定义动作的动作名（最后一段）；不是插件自定义动作时返回 null */
export function pluginDefinedActionName(action: unknown): string | null {
  if (!isPluginDefinedAction(action)) return null;
  const rest = action.slice(PLUGIN_ACTION_PREFIX.length);
  const i = rest.indexOf(":");
  if (i <= 0) return null;
  return rest.slice(i + 1) || null;
}

/** 一条快捷键绑定 */
export interface ShortcutBinding {
  /** 组合键字符串（小写、+ 连接、修饰键在前，如 "ctrl+alt+s"） */
  shortcut: string;
  /** 作用类型 */
  action: ShortcutAction;
  /** 作用对象：open-plugin 时为插件 id，quick-filter 时为常用头文本，
   *  quick-open 时为匹配文本，插件动作（含宿主原生与自定义）为 null */
  target: string | null;
}

/** 默认「呼出 / 隐藏搜索框」快捷键（与 Rust 端 DEFAULT_TOGGLE_SHORTCUT 一致） */
export const DEFAULT_TOGGLE_SHORTCUT = "ctrl+alt+s";

/** 绑定条数上限（与 Rust 端 MAX_SHORTCUT_BINDINGS 一致） */
export const MAX_SHORTCUT_BINDINGS = 50;

/**
 * 作用类型的中文名（UI 下拉 / 列表展示共用）。
 * 只覆盖**固定名**（内置 + 宿主原生）；插件自定义动作没有固定文案，
 * 其标题来自插件清单，展示时用 `shortcutActionLabel(action, actionTitleOf?)`。
 */
export const SHORTCUT_ACTION_LABELS: Record<
  BuiltinShortcutAction | HostNativePluginShortcutAction,
  string
> = {
  "toggle-window": "呼出 / 隐藏搜索框",
  "open-plugin": "打开插件",
  "quick-filter": "快速过滤",
  "quick-open": "快捷打开项",
  screenshot: "截图（框选 + 标注）",
  clipboard: "剪贴板历史",
};

/**
 * 取作用类型的展示文案：
 * - 插件动作（宿主原生 / 自定义）→ 优先用调用方给的 `actionTitleOf`（来自插件清单，
 *   是权威来源）；清单读不到时宿主原生动作退回内置中文名，自定义动作退化为动作 id。
 * - 内置动作 → 内置中文名。
 */
export function shortcutActionLabel(
  action: ShortcutAction | string,
  actionTitleOf?: (action: string) => string | null
): string {
  const fromTitle = actionTitleOf?.(action);
  if (fromTitle) return fromTitle;
  const fromMap = (SHORTCUT_ACTION_LABELS as Record<string, string | undefined>)[action];
  if (fromMap) return fromMap;
  return action;
}

/** 是否是已知的作用类型（内置 / 宿主原生 / 插件自定义） */
export function isShortcutAction(v: unknown): v is ShortcutAction {
  if (isPluginShortcutAction(v)) return true;
  return (
    v === "toggle-window" || v === "open-plugin" || v === "quick-filter" || v === "quick-open"
  );
}

/** 该作用类型是否**需要**作用对象（缺了就不可执行）。与 Rust 端 action_requires_target 一致。 */
export function actionRequiresTarget(action: ShortcutAction): boolean {
  return action === "open-plugin" || action === "quick-filter" || action === "quick-open";
}

/**
 * 一条绑定是否已填写完整（可参与校验与提交）。
 * 需要作用对象的类型必须给出作用对象；未填完的行视为「草稿」——
 * 不校验、不提交，等用户选完插件 / 填完文本后再随下一次保存一并生效
 * （避免「新增后还没选择插件」就弹出校验报错）。
 */
export function isBindingComplete(binding: ShortcutBinding): boolean {
  if (String(binding.shortcut ?? "").trim() === "") return false;
  if (!isShortcutAction(binding.action)) return false;
  if (binding.action === "open-plugin") return String(binding.target ?? "").trim() !== "";
  if (binding.action === "quick-filter") return normalizeQuickFilterHeader(binding.target) !== "";
  if (binding.action === "quick-open") return String(binding.target ?? "").trim() !== "";
  return true;
}

/** 二次搜索分隔符（与 search-engine 的 SEARCH_BOUNDARY 一致） */
export const SEARCH_BOUNDARY = " : ";

/**
 * 归一化「快速过滤」的常用头：去掉首尾空白，并去掉用户可能顺手打上的
 * 二次搜索分隔符（` : ` / `:`），避免触发时拼成「百度翻译 :  : 」。
 * 返回空串表示没有有效内容。
 */
export function normalizeQuickFilterHeader(raw: unknown): string {
  const text = String(raw ?? "").trim();
  return text.replace(/[\s:：]+$/, "").trim();
}

/** 新建一条默认的「呼出 / 隐藏搜索框」绑定 */
export function defaultToggleBinding(shortcut: string = DEFAULT_TOGGLE_SHORTCUT): ShortcutBinding {
  return { shortcut, action: "toggle-window", target: null };
}

/**
 * 解析一条未知输入为绑定；不合法（缺字段 / 作用类型未知 / 需要作用对象却没给）返回 null。
 * 与 Rust `ShortcutBinding::from_value` 的判定保持一致。
 */
export function parseBinding(raw: unknown): ShortcutBinding | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const shortcut = typeof o.shortcut === "string" ? o.shortcut.trim() : "";
  if (shortcut === "") return null;
  if (!isShortcutAction(o.action)) return null;
  const action = o.action;
  const targetRaw = typeof o.target === "string" ? o.target.trim() : "";
  // 快速过滤存的是常用头文本，读入时归一化抹平手打的尾部「 : 」；
  // 快捷打开项存的是匹配文本，只 trim（冒号可能是标题本身的一部分）。
  const target =
    action === "quick-filter"
      ? normalizeQuickFilterHeader(targetRaw) || null
      : targetRaw === ""
        ? null
        : targetRaw;
  if (actionRequiresTarget(action) && target == null) return null;
  return { shortcut, action, target: actionRequiresTarget(action) ? target : null };
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
  return bindings.map((b) => {
    // 快速过滤的常用头落盘前归一化（去掉手打的尾部「 : 」），避免存成「百度翻译 : 」；
    // 快捷打开项只做 trim（冒号可能是标题本身的一部分）。
    let target: string | null;
    if (b.action === "quick-filter") {
      target = normalizeQuickFilterHeader(b.target) || null;
    } else if (b.action === "quick-open") {
      target = String(b.target ?? "").trim() || null;
    } else {
      target = b.target ?? null;
    }
    return { shortcut: b.shortcut, action: b.action, target };
  });
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
    } else if (b.action === "open-plugin") {
      if (!b.target) return { ok: false, reason: "「打开插件」需要选择一个插件" };
    } else if (b.action === "quick-filter") {
      if (!normalizeQuickFilterHeader(b.target)) {
        return { ok: false, reason: "「快速过滤」需要填写常用头（如「百度翻译」）" };
      }
    } else if (b.action === "quick-open") {
      if (!String(b.target ?? "").trim()) {
        return { ok: false, reason: "「快捷打开项」需要填写要打开的项名（如「百度翻译」）" };
      }
    }
    // screenshot（截图）不需要作用对象：Rust 侧就地开遮罩窗口
  }
  return { ok: true };
}

/**
 * 一条绑定的展示文案：作用类型 + 作用对象。
 *
 * @param pluginNameOf 打开插件绑定的插件名解析；
 * @param actionLabelOf **插件动作**（宿主原生 screenshot/clipboard + 自定义 `plugin:`）
 *   的标题解析（来自插件清单 `contributes.shortcut.title`）。清单读不到时
 *   （插件未装）宿主原生动作退回内置兜底文案，自定义动作退化为 id。
 */
export function describeBinding(
  binding: ShortcutBinding,
  pluginNameOf?: (id: string) => string | null,
  actionLabelOf?: (action: ShortcutAction) => string | null
): string {
  if (binding.action === "toggle-window") return SHORTCUT_ACTION_LABELS["toggle-window"];
  if (isPluginShortcutAction(binding.action)) {
    return shortcutActionLabel(binding.action, actionLabelOf as ((a: string) => string | null) | undefined);
  }
  if (binding.action === "quick-filter") {
    const header = normalizeQuickFilterHeader(binding.target);
    if (!header) return SHORTCUT_ACTION_LABELS["quick-filter"];
    // 展示时补上二次搜索分隔符，让用户一眼看出按下后会填入什么
    return `快速过滤「${header}${SEARCH_BOUNDARY}」`;
  }
  if (binding.action === "quick-open") {
    const text = String(binding.target ?? "").trim();
    if (!text) return SHORTCUT_ACTION_LABELS["quick-open"];
    return `快捷打开项「${text}」`;
  }
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
