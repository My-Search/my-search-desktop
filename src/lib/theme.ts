/**
 * 主题管理 - 支持浅色 / 深色 / 跟随系统
 *
 * 存储键：my-search-desktop:theme
 * 默认：system（跟随系统偏好）
 *
 * 实现方式：
 * - 在 <html> 上添加 theme-light 或 theme-dark 类，CSS 据此强制覆盖变量。
 * - 未添加类时（默认）由 prefers-color-scheme 媒体查询控制，等价于跟随系统。
 */

import { storageGet, storageSet } from "./util.ts";

export type Theme = "light" | "dark" | "system";

/** 已解析的实际深浅色（system 也解析成二者之一） */
export type ResolvedTheme = "light" | "dark";

const THEME_KEY = "theme";
const THEME_CLASS_LIGHT = "theme-light";
const THEME_CLASS_DARK = "theme-dark";

/** 主题变更的 DOM 事件名（同一窗口内所有主题应用路径的最终汇聚点，插件宿主据此通知插件） */
export const THEME_CHANGED_EVENT = "my-search-theme-changed";

let systemMedia: MediaQueryList | null = null;
let systemListener: ((e: MediaQueryListEvent) => void) | null = null;

/**
 * 「主题偏好 + 已解析深浅色」的接收器（各窗口入口注册，转发给 Rust 原生层）。
 *
 * 为什么要同时上报两值：
 * - **偏好**（`theme`，含 "system"）决定原生层钉不钉主题：强制 light/dark 时
 *   Rust 用 `set_theme(Some(..))` 钉住；"system" 时 `set_theme(None)` 恢复
 *   实时跟随系统。钉住会通过 tao → ThemeChanged → wry 链路把 WebView2 的
 *   `PreferredColorScheme` 强制成同色——若 system 模式也钉，matchMedia 便
 *   不再反映系统偏好，`resolveTheme("system")` 会把钉住值原样读回来，
 *   形成「切回跟随系统后停留在旧颜色」的自锁闭环。
 * - **已解析结果**（`resolved`）只用于原生窗口**底色铺底**（防首帧闪白）：
 *   它来自本模块的 `matchMedia`，与 WebView2 渲染同源；Rust 自己在 system
 *   模式下只能读注册表（Windows 之外读不到），拿上报值更准。
 */
let themeReporter: ((theme: Theme, resolved: ResolvedTheme) => void) | null = null;

/**
 * 「当前是否有临时主题覆盖」的查询钩子（由 theme-override.ts 注入）。
 *
 * 覆盖生效期间（打开插件视图，详见 theme-override.ts），自动主题路径
 * （系统偏好变化 / Rust 跨窗口事件）不应把覆盖顶掉：此刻用户看到的是
 * 插件主题，若系统偏好一变就把 `html` 类改回软件主题，插件界面会瞬间
 * 与上方搜索框割裂。退出覆盖时 theme-override 会自行恢复最新软件主题。
 *
 * 用注入的查询函数而不是直接 import theme-override：两边互不 import，
 * 避免模块循环（theme-override 需要 applyTheme / getTheme）。
 */
let overrideQuery: (() => boolean) | null = null;

/** 注册「是否有临时主题覆盖」的查询（theme-override.ts 调用一次） */
export function setThemeOverrideQuery(cb: (() => boolean) | null): void {
  overrideQuery = cb;
}

/** 是否处于临时主题覆盖期间（自动主题路径据此让路） */
function themeOverridden(): boolean {
  try {
    return overrideQuery?.() ?? false;
  } catch (e) {
    return false;
  }
}

/** 注册主题上报回调（入口调用一次；注册时立即回调一次当前偏好与解析值） */
export function setThemeReporter(
  cb: ((theme: Theme, resolved: ResolvedTheme) => void) | null,
): void {
  themeReporter = cb;
  if (cb) cb(getTheme(), resolveTheme(getTheme()));
}

/** 系统是否偏好深色（resolveTheme / applyTheme 共用同一判据，避免各处各写一份） */
function systemPrefersDark(): boolean {
  return !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
}

/** 把主题设置解析为实际深浅色（system → 跟随系统偏好，与 CSS 类同源） */
export function resolveTheme(theme: Theme = getTheme()): ResolvedTheme {
  if (theme === "light") return "light";
  if (theme === "dark") return "dark";
  return systemPrefersDark() ? "dark" : "light";
}

/** 读取本地存储的主题设置 */
export function getTheme(): Theme {
  const v = storageGet<Theme | null>(THEME_KEY, null);
  if (v === "light" || v === "dark" || v === "system") return v;
  return "system";
}

/** 设置主题并持久化 */
export function setTheme(theme: Theme): void {
  storageSet(THEME_KEY, theme);
  applyTheme(theme);
  // 用户显式切换：上报偏好（含 system，原生层据此决定是否钉主题）与
  // 已解析深浅色（标题栏 / WebView 底色铺底同步）
  themeReporter?.(theme, resolveTheme(theme));
}

/**
 * 应用主题到文档。
 * - light：强制浅色（添加 theme-light，移除 theme-dark）
 * - dark：强制深色（添加 theme-dark，移除 theme-light）
 * - system：根据系统偏好应用对应的类（确保 WebView 背景色同步）
 */
export function applyTheme(theme: Theme): void {
  const html = document.documentElement;
  // 记录变更前的生效主题，避免 class 未变时仍派发 THEME_CHANGED_EVENT
  //（设置窗口初始化时 initTheme → applyTheme 由于内联脚本已挂类，
  // 唯一效果是 dispatch 了一个空事件，触发插件宿主的 theme 回调 -> 频闪）。
  const before = html.classList.contains(THEME_CLASS_DARK)
    ? "dark"
    : html.classList.contains(THEME_CLASS_LIGHT)
      ? "light"
      : null;
  if (theme === "light") {
    html.classList.add(THEME_CLASS_LIGHT);
    html.classList.remove(THEME_CLASS_DARK);
  } else if (theme === "dark") {
    html.classList.add(THEME_CLASS_DARK);
    html.classList.remove(THEME_CLASS_LIGHT);
  } else {
    // system：根据系统偏好应用对应的类
    const isDark = systemPrefersDark();
    if (isDark) {
      html.classList.add(THEME_CLASS_DARK);
      html.classList.remove(THEME_CLASS_LIGHT);
    } else {
      html.classList.add(THEME_CLASS_LIGHT);
      html.classList.remove(THEME_CLASS_DARK);
    }
  }
  const after = html.classList.contains(THEME_CLASS_DARK) ? "dark" : "light";
  // class 未变：跳过事件派发（插件宿主不需要收到空通知，其 theme getter 仍返回正确值）
  if (before === after) return;
  // 通知本窗口内的插件宿主（ms.ui.onThemeChanged）：
  // 跨窗口同步（Rust 事件）与 system 模式下的系统偏好变化最终都落在这里
  document.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT));
}

/**
 * 当前**生效**的主题（插件宿主 `ms.ui.theme` 用）。
 * theme.ts 保证 `<html>` 上恒有且仅有一个 theme-light / theme-dark 类
 * （system 模式按系统偏好解析后同样落类）；仅在无类时（如纯浏览器调试
 * 且未走过 initTheme）回退到系统偏好。
 */
export function effectiveTheme(): "light" | "dark" {
  const html = document.documentElement;
  if (html.classList.contains(THEME_CLASS_DARK)) return "dark";
  if (html.classList.contains(THEME_CLASS_LIGHT)) return "light";
  const isDark =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  return isDark ? "dark" : "light";
}

/**
 * 初始化主题：读取存储并应用，同时监听系统主题变化（system 模式下自动响应）
 * 以及来自 Rust 后端的主题变更事件（跨窗口同步）
 */
export function initTheme(): void {
  const theme = getTheme();
  applyTheme(theme);

  // 监听系统主题变化：当用户选择 system 时，根据系统偏好应用对应的类；
  // 如果从 light/dark 切回 system，需要确保立即应用正确的类。
  if (typeof window !== "undefined" && window.matchMedia) {
    systemMedia = window.matchMedia("(prefers-color-scheme: dark)");
    systemListener = () => {
      const theme = getTheme();
      if (theme === "system") {
        // 插件视图临时覆盖期间以插件主题为准，不让系统偏好抢走（退出覆盖时自会恢复）
        if (themeOverridden()) return;
        // 跟随系统模式：重新应用当前系统偏好，并同步原生层的标题栏 / 底色
        applyTheme(theme);
        themeReporter?.(theme, resolveTheme(theme));
      }
      // 若当前是 light/dark，系统变化不影响当前强制主题
    };
    systemMedia.addEventListener?.("change", systemListener);
  }

  // 监听来自 Rust 后端的主题变更事件（用于跨窗口同步）
  if (typeof window !== "undefined") {
    try {
      void import("@tauri-apps/api/event").then(({ listen }) => {
        // 必须 return listen(...)：listen 内部同步调用
        // window.__TAURI_INTERNALS__.transformCallback，非 Tauri 环境下会**同步抛错**
        // 并返回已拒绝的 Promise。若不 return，这个拒绝会逃出下面的 .catch，
        // 变成未处理拒绝（浏览器里表现为 pageerror，测试里表现为 EXC）。
        return listen("my-search://theme-changed", () => {
          // 幂等保护：若当前生效的主题类与存储值一致则跳过，
          // 避免设置窗口初始化时自家 emit 的 theme-changed 被自己收到后
          // 又 dispatch THEME_CHANGED_EVENT 导致插件宿主重复通知。
          const theme = getTheme();
          const resolved = resolveTheme(theme);
          if (effectiveTheme() === resolved) return;
          // 覆盖期间以插件主题为准：此刻的 class 差异本就该存在，不能按存储值改回
          if (themeOverridden()) return;
          applyTheme(theme);
        });
      }).catch((e) => {
        // 浏览器环境或 Tauri API 不可用时静默失败
        console.warn("监听主题变更事件失败:", e);
      });
    } catch (e) {
      // 浏览器环境（开发调试）下不需要监听 Tauri 事件
      console.log("未启用主题变更事件监听器（可能为非 Tauri 环境）");
    }
  }
}

/** 清理主题监听器（窗口卸载时调用） */
export function disposeTheme(): void {
  if (systemMedia && systemListener) {
    systemMedia.removeEventListener?.("change", systemListener);
    systemMedia = null;
    systemListener = null;
  }
}
