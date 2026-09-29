/**
 * 临时主题覆盖层（插件视图用）。
 *
 * ## 为什么需要它
 *
 * 搜索窗口的深/浅色完全由 `<html>` 上的 `theme-light` / `theme-dark` 类驱动
 * （见 theme.ts 的 applyTheme）：搜索框、结果列表、详情区、内嵌插件界面、
 * 原生 `color-scheme` 全挂在这一根开关上。
 *
 * 插件（如默认为深色设计稿的 pi-agent）在软件为浅色主题时打开，会出现
 * 「插件面板深、上方搜索框浅」的割裂观感。本模块让宿主在**打开插件期间**
 * 把 `html` 的类临时切到插件主题，关闭时按软件设置还原——整个呼出窗口
 * 因此与插件界面同色，且不需要插件各自写死或重复适配。
 *
 * ## 与「软件主题」的边界（重要）
 *
 * 覆盖**绝不写 localStorage**：真正的软件主题设置只有 `setTheme()` 会写。
 * 覆盖只改 `<html>` 的类并上报原生层，因此：
 *   - 覆盖期间设置里读到的仍是软件原设置（不会被临时值污染）；
 *   - `clearThemeOverride()` 用 `getTheme()` 还原，不会把临时值永久化。
 *
 * ## 与自动主题路径的关系
 *
 * `initTheme()` 注册的 systemListener（跟随系统偏好变化）与 Rust 跨窗口
 * 主题变更事件，都会调用 applyTheme——若用户在覆盖期间改了系统主题或
 * 在设置窗口切了主题，这些自动路径不应把覆盖顶掉。因此本模块导出
 * `isThemeOverridden()`，theme.ts 在自动路径里据此提前返回；覆盖生效
 * 期间「以插件主题为准」，退出覆盖后立即恢复软件（新）主题。
 *
 * 覆盖层与 theme.ts 之间**不引入 import 环**：theme.ts 单向依赖本模块的
 * 纯查询函数（`isThemeOverridden` / `readOverride` 经 setter 注入），本模块
 * 单向依赖 theme.ts 的 applyTheme/getTheme。
 */

import { applyTheme, getTheme, resolveTheme, setThemeOverrideQuery, type ResolvedTheme, type Theme } from "./theme.ts";

/** 当前临时覆盖的深浅色；null = 无覆盖（跟随软件主题） */
let override: ResolvedTheme | null = null;

/**
 * 把「是否有覆盖」告诉 theme.ts：覆盖期间自动主题路径（系统偏好变化 /
 * Rust 跨窗口事件）必须让路，否则插件主题会被软件主题顶掉。
 * 模块加载即注册（纯查询，开销可忽略）。
 */
setThemeOverrideQuery(() => override !== null);

/**
 * 「上报原生层」的钩子：由窗口入口在 setThemeReporter 之外的**同一路**
 * 注册（main.ts / config.ts 各自注入）。参数为（偏好, 已解析深浅色），与
 * theme.ts 的 themeReporter 同契约：原生层据偏好决定是否钉主题。
 *
 * 为什么覆盖层不能直接用 theme.ts 的 themeReporter：themeReporter 是私有的，
 * 而覆盖也需要在原生层同步窗口底色/标题栏（否则滚动条、overscroll 区域会
 * 与页面不同色）。这里用回调注入，避免为它开一个仅内部使用的导出。
 */
let overrideReporter: ((theme: Theme, resolved: ResolvedTheme) => void) | null = null;

/** 注册覆盖层的原生层上报回调（入口调用一次即可） */
export function setThemeOverrideReporter(
  cb: ((theme: Theme, resolved: ResolvedTheme) => void) | null,
): void {
  overrideReporter = cb;
}

/** 当前是否有临时覆盖 */
export function isThemeOverridden(): boolean {
  return override !== null;
}

/** 当前覆盖的深浅色（无覆盖时返回 null；调试与测试断言用） */
export function readThemeOverride(): ResolvedTheme | null {
  return override;
}

/**
 * 应用临时主题覆盖（只影响当前 `html` 类与原生层，不写 localStorage）。
 *
 * 复用 theme.ts 的 `applyTheme`：它内部保证「类没变就不派发事件」的幂等，
 * 覆盖与还原都会真实改类，因此 `THEME_CHANGED_EVENT` 正常派发——插件的
 * `ms.ui.onThemeChanged` 与依赖 `html` 类的宿主样式同步更新。
 */
export function applyThemeOverride(theme: ResolvedTheme): void {
  if (theme !== "light" && theme !== "dark") return;
  override = theme;
  applyTheme(theme);
  // 覆盖期间把原生层也钉成覆盖值（偏好位 = 强制 light/dark），标题栏/底色随插件主题
  overrideReporter?.(theme, theme);
}

/**
 * 清除覆盖，恢复软件主题（幂等：没有覆盖时什么都不做）。
 *
 * 还原同样走 `applyTheme(getTheme())`：`system` 会按当时的系统偏好解析成
 * 对应的类，与覆盖前完全一致。
 */
export function clearThemeOverride(): void {
  if (override === null) return;
  override = null;
  const theme = getTheme();
  applyTheme(theme);
  // 上报**软件偏好**（可能是 system）而非仅解析值：否则 pref=system 时会把
  // 当时的解析值当强制主题重新钉回原生层，系统主题变化后再也收不到信号。
  overrideReporter?.(theme, resolveTheme(theme));
}

/** 仅测试用：清空覆盖状态而不触碰 DOM */
export function _resetThemeOverrideForTest(): void {
  override = null;
}
