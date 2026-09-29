/**
 * 「已安装插件 → 可用的全局快捷键作用类型」计算（纯函数）。
 *
 * 背景：`screenshot` / `clipboard` 这类作用类型曾**写死**在宿主里——即便插件
 * 没装，设置里也照样列出、还会顺手注入一条默认热键，按下去毫无反应。
 * 现在改由插件清单 `contributes.shortcut` 声明，宿主按**当前已安装**的插件
 * 计算可用动作，再下发给 Rust（`sync_plugin_shortcut_actions`）做注册与自愈。
 *
 * 口径：
 *   - 可用性以「**已安装**」为准，与「打开插件」绑定一致：插件被禁用时不删绑定，
 *     只是按下去会提示「已禁用」（截图这类宿主原生动作则照常可用）；
 *   - 只看非 legacy 记录（legacy 是历史 `[script]` 投影，不提供插件动作）；
 *   - 同一个 action 出现多次（理论上不该有）时按插件 id 稳定取第一个，
 *     避免顺序抖动导致下发结果不稳定。
 */

import { listShortcutActions, type PluginManifest } from "./manifest.ts";
import type { PluginRecord, PluginRegistryFile } from "./registry.ts";

/** 一个可用的插件快捷键动作 */
export interface AvailableShortcutAction {
  /** 宿主动作 id（目前仅 screenshot / clipboard） */
  action: string;
  /** 下拉里的展示标题（来自清单 `contributes.shortcut.title`） */
  title: string;
  /** 首次注入用的默认组合键（清单未声明时为空串 = 不自动注入） */
  defaultShortcut: string;
  /** 提供该动作的插件 id（用于「已卸载」提示与去重） */
  pluginId: string;
}

/** 从单条插件记录里取它声明的快捷键动作 */
export function shortcutActionsOf(rec: PluginRecord): AvailableShortcutAction[] {
  const declared = listShortcutActions(rec.manifest as PluginManifest).map((s) => ({
    action: s.action,
    title: s.title,
    defaultShortcut: s.defaultShortcut ?? "",
    pluginId: rec.id,
  }));
  if (declared.length > 0) return declared;
  // 升级迁移桥：老版本插件包（在 `contributes.shortcut` 出现之前发布的）清单里
  // 没有这项声明。若对应插件**仍然安装着**，按旧内置默认值补一个，避免用户升级
  // 应用后被静默移除既有热键（用户更新到新版插件包后自然走上面的声明路径）。
  const legacy = LEGACY_ACTION_OWNERS[rec.id];
  return legacy ? [{ ...legacy, pluginId: rec.id }] : [];
}

/**
 * 已知的「旧版插件包 → 它当初由宿主写死提供的作用类型」映射（仅迁移用）。
 *
 * 这些键值是宿主曾经的硬编码默认值；在新插件包发布前用它们兜底，
 * 保证「插件还在装 → 对应作用类型仍可用」。新插件包声明了
 * `contributes.shortcut` 后，本映射对该插件即失效（`shortcutActionsOf` 先看声明）。
 */
const LEGACY_ACTION_OWNERS: Record<string, Omit<AvailableShortcutAction, "pluginId">> = {
  "com.zhuangjie.screenshot": {
    action: "screenshot",
    title: "截图（框选 + 标注）",
    defaultShortcut: "ctrl+alt+x",
  },
  "com.mysearch.clipboard": {
    action: "clipboard",
    title: "剪贴板历史",
    defaultShortcut: "ctrl+alt+v",
  },
};

/**
 * 计算当前注册表里「可用」的插件快捷键动作（已安装，按 action 去重）。
 *
 * 结果按 action 名排序，保证同一注册表每次得到同一顺序（便于测试与幂等下发）。
 */
export function availableShortcutActions(reg: PluginRegistryFile): AvailableShortcutAction[] {
  const byAction = new Map<string, AvailableShortcutAction>();
  for (const rec of reg.plugins) {
    if (rec.source.kind === "legacy") continue;
    for (const a of shortcutActionsOf(rec)) {
      if (!byAction.has(a.action)) byAction.set(a.action, a);
    }
  }
  return [...byAction.values()].sort((a, b) => a.action.localeCompare(b.action));
}
