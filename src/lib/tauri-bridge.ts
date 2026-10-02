/**
 * Tauri 桥接层 - 封装前端对 Rust 后端的调用
 * 在纯浏览器环境（开发调试）下降级为 fetch
 */

import { invoke } from "@tauri-apps/api/core";
import {
  DEFAULT_TOGGLE_SHORTCUT,
  defaultToggleBinding,
  parseBindings,
  serializeBindings,
  type ShortcutBinding,
} from "./shortcut-bindings.ts";
import type {
  HttpRequestOptions,
  RawGithubUrl,
  UpdateCompletePayload,
  UpdateInfo,
  UpdateProgress,
} from "../types/index.ts";

/** 取消监听函数（Tauri listen 的返回值） */
export type UnlistenFn = () => void;

/** 是否运行在 Tauri 环境 */
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** 官方订阅原文本（与油猴版内置订阅一致，含 title/describe 属性） */
export const DEFAULT_SUBSCRIBE_TEXT = `
<tis::https://raw.githubusercontent.com/My-Search/official-subscribe/refs/heads/dev/only-system-index.ms title="官方订阅-系统项" describe="我的搜索官方内置订阅的系统项部分，含内置的应用与系统项" />
<tis::https://raw.githubusercontent.com/My-Search/official-subscribe/refs/heads/dev/index.ms title="官方作者zhuangjie订阅-小庄的收藏室" describe="我的搜索官方内置订阅之作者zhuangjie订阅，收藏了一些实用的软件、网站、教程" />
`.trim();

/**
 * HTTP GET（优先走 Rust 代理，浏览器环境降级 fetch）
 * Rust 端内置 jsDelivr -> raw.githubusercontent -> GitHub API 回退，
 * 因此即便直连 GitHub 被墙也能拿到订阅内容。
 */
export async function httpGet(url: string): Promise<string> {
  if (isTauri) {
    return await invoke<string>("http_get", { url });
  }
  // 浏览器开发环境：与 Rust 端一致的回退策略
  // （jsDelivr CDN 优先，raw.githubusercontent 直连兜底）
  const candidates: string[] = [];
  if (url.includes("raw.githubusercontent.com/")) {
    const cdn = rawToJsDelivr(url);
    if (cdn) candidates.push(cdn);
  }
  candidates.push(url);
  let lastErr: unknown = null;
  for (const candidate of candidates) {
    try {
      const resp = await fetch(candidate);
      if (resp.ok) return await resp.text();
      lastErr = new Error(`HTTP ${resp.status}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("请求失败");
}

/**
 * 通用 HTTP 请求（供 TisHub 订阅市场使用）
 * Tauri 环境走 Rust 代理（绕开 CORS、可带 GitHub Token）；
 * 浏览器环境直接 fetch（受 CORS 限制，仅便于开发调试）。
 * @returns 已解析的 JSON（解析失败时返回文本）
 */
export async function httpRequest(
  url: string,
  { method = "GET", headers = {}, body }: HttpRequestOptions = {}
): Promise<unknown> {
  if (isTauri) {
    const text = await invoke<string>("http_request", {
      method,
      url,
      headers,
      body: body == null ? null : typeof body === "string" ? body : JSON.stringify(body),
    });
    return parseMaybeJson(text);
  }
  const resp = await fetch(url, {
    method,
    headers,
    body: body == null ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
  return parseMaybeJson(text);
}

function parseMaybeJson(text: string | null): unknown {
  if (text == null || text === "") return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    return text;
  }
}

/**
 * 解析 raw.githubusercontent.com URL 为 { owner, repo, branch, path }。
 * 与 Rust 端 parse_raw_github_url 保持一致的两种形式：
 *   - `{owner}/{repo}/{branch}/{path...}`
 *   - `{owner}/{repo}/refs/{heads|tags}/{ref}/{path...}`
 * 缺少文件名时返回 null（不拼非法 URL）。
 */
export function parseRawGithubUrl(url: string): RawGithubUrl | null {
  const prefix = "https://raw.githubusercontent.com/";
  if (typeof url !== "string" || !url.startsWith(prefix)) return null;
  const parts = url.slice(prefix.length).split("/").filter(Boolean);
  if (parts.length < 4) return null;
  const [owner, repo] = parts;
  let branch: string;
  let pathStart: number;
  if (parts[2] === "refs") {
    if (parts.length < 6 || (parts[3] !== "heads" && parts[3] !== "tags")) return null;
    branch = parts[4];
    pathStart = 5;
  } else {
    branch = parts[2];
    pathStart = 3;
  }
  return { owner, repo, branch, path: parts.slice(pathStart).join("/") };
}

/** raw.githubusercontent -> jsDelivr CDN */
function rawToJsDelivr(url: string): string | null {
  const parsed = parseRawGithubUrl(url);
  if (!parsed) return null;
  const { owner, repo, branch, path } = parsed;
  return `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${path}`;
}

/** 打开外部链接（默认浏览器） */
export async function openExternal(url: string): Promise<void> {
  if (!url) return;
  if (isTauri) {
    try {
      return await invoke("open_url", { url });
    } catch (e) {
      window.open(url, "_blank");
    }
  } else {
    window.open(url, "_blank");
  }
}

/** 退出应用 */
export async function quitApp(): Promise<void> {
  if (isTauri) {
    await invoke("quit_app");
  }
}

/**
 * 把主题上报到原生层：Rust 端同步所有窗口的原生标题栏主题与 WebView 底色，
 * 并广播 theme-changed 事件让各窗口重应用 CSS 类。
 *
 * - `theme`：主题**偏好**（light / dark / system）。强制 light/dark 时 Rust 用
 *   `set_theme(Some(..))` 钉住原生层；system 时 `set_theme(None)` 恢复实时跟随
 *   系统——若 system 也钉，tao 会把 WebView2 的 `PreferredColorScheme` 强制成
 *   同色，matchMedia 不再反映系统偏好，前端解析出的永远是钉住值（自锁）。
 * - `resolved`：前端按 `matchMedia("(prefers-color-scheme: dark)")` 解析出的
 *   深浅色，仅供 Rust 铺底窗口背景色用（与 WebView2 渲染同源，防首帧闪白）。
 *
 * CSS 类始终由前端的 matchMedia 决定；原生层只负责标题栏/底色，两值分工明确，
 * 原生标题栏与页面内容不会出现「一深一浅」。
 */
export async function applyAppTheme(
  theme: "light" | "dark" | "system",
  resolved: "light" | "dark",
): Promise<void> {
  if (!isTauri) return;
  try {
    await invoke("apply_app_theme", { theme, resolved });
  } catch (e) {
    console.warn("应用主题失败:", e);
  }
}

/** 打开独立配置窗口（订阅管理） */
export async function openConfigWindow(): Promise<void> {
  if (isTauri) {
    await invoke("open_config_window");
  }
}

/**
 * 打开某个插件的界面（插件面板的「从插件市场安装」用它打开市场）。
 *
 * 插件详情视图只存在于主搜索窗口，Rust 侧负责收起设置窗口、呼出主窗口并广播
 * open-plugin 事件，由主窗口的前端打开视图；插件是否存在 / 启用 / 有界面的判定
 * 都在那边完成（与全局快捷键「打开插件」同一条路径）。
 */
export async function openPluginView(pluginId: string): Promise<void> {
  if (isTauri) {
    await invoke("open_plugin_view", { pluginId });
  }
}

/** 获取默认订阅原文本 */
export async function getDefaultSubscribeText(): Promise<string> {
  if (isTauri) {
    return await invoke<string>("get_default_subscribe_text");
  }
  return DEFAULT_SUBSCRIBE_TEXT;
}

/**
 * 获取当前「呼出/隐藏」全局快捷键字符串（如 "ctrl+alt+s"）。
 * 非 Tauri 环境（浏览器调试）返回默认值。
 */
export async function getToggleShortcut(): Promise<string> {
  if (isTauri) {
    try {
      return await invoke<string>("get_toggle_shortcut");
    } catch (e) {
      console.warn("读取快捷键设置失败:", e);
    }
  }
  return DEFAULT_TOGGLE_SHORTCUT;
}

/**
 * 设置「呼出/隐藏」全局快捷键（Rust 端立即重新注册并持久化）。
 * @param shortcut 如 "ctrl+alt+s"
 * @throws 设置失败时抛错（如组合键被其它程序占用）
 */
export async function setToggleShortcut(shortcut: string): Promise<void> {
  if (isTauri) {
    await invoke("set_toggle_shortcut", { shortcut });
  }
}

/**
 * 获取全部快捷键绑定（**快捷键 / 作用类型 / 作用对象**）。
 *
 * 非 Tauri 环境（浏览器调试）返回默认的「呼出/隐藏搜索框」一条，
 * 保证设置面板在浏览器里也能渲染。
 */
export async function getShortcutBindings(): Promise<ShortcutBinding[]> {
  if (isTauri) {
    try {
      return parseBindings(await invoke<unknown>("get_shortcut_bindings"));
    } catch (e) {
      console.warn("读取快捷键设置失败:", e);
    }
  }
  return [defaultToggleBinding(DEFAULT_TOGGLE_SHORTCUT)];
}

/**
 * 设置整套快捷键绑定（Rust 端整体重新注册并持久化）。
 * @throws 校验不通过 / 注册失败（如组合键被其它程序占用）时抛错
 */
export async function setShortcutBindings(bindings: readonly ShortcutBinding[]): Promise<void> {
  if (!isTauri) return;
  await invoke("set_shortcut_bindings", { bindings: serializeBindings(bindings) });
}

/**
 * 监听「插件快捷键」触发事件（Rust 端注册的 open-plugin 热键按下时广播）。
 * 主窗口据此打开对应插件的视图。
 */
export async function onShortcutOpenPlugin(
  handler: (pluginId: string) => void
): Promise<UnlistenFn | null> {
  if (!isTauri) return null;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<{ pluginId?: string }>("my-search://shortcut-open-plugin", (event) => {
      const id = event.payload?.pluginId;
      if (typeof id === "string" && id !== "") handler(id);
    });
  } catch (e) {
    console.warn("监听插件快捷键事件失败:", e);
    return null;
  }
}

/**
 * 监听「快速过滤」快捷键事件（Rust 端注册的 quick-filter 热键按下时广播）。
 * 主窗口据此把常用头填入搜索框并立即搜索。
 */
export async function onShortcutQuickFilter(
  handler: (filter: string) => void
): Promise<UnlistenFn | null> {
  if (!isTauri) return null;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<{ filter?: unknown }>("my-search://shortcut-quick-filter", (event) => {
      const filter = event.payload?.filter;
      if (typeof filter === "string" && filter.trim() !== "") handler(filter);
    });
  } catch (e) {
    console.warn("监听快速过滤快捷键事件失败:", e);
    return null;
  }
}

/**
 * 监听「快捷打开项」快捷键事件（Rust 端注册的 quick-open 热键按下时广播）。
 * 主窗口据此按文本精确匹配数据项并直接打开（多项时列出结果）。
 */
export async function onShortcutQuickOpen(
  handler: (text: string) => void
): Promise<UnlistenFn | null> {
  if (!isTauri) return null;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<{ text?: unknown }>("my-search://shortcut-quick-open", (event) => {
      const text = event.payload?.text;
      if (typeof text === "string" && text.trim() !== "") handler(text);
    });
  } catch (e) {
    console.warn("监听快捷打开项快捷键事件失败:", e);
    return null;
  }
}

/**
 * 监听「剪贴板历史」快捷键事件（Rust 端注册的 clipboard 热键按下时广播）。
 * 主窗口据此打开内置剪贴板历史插件的详情视图。
 */
export async function onShortcutClipboard(
  handler: (pluginId: string) => void
): Promise<UnlistenFn | null> {
  if (!isTauri) return null;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<{ pluginId?: unknown }>("my-search://shortcut-clipboard", (event) => {
      const id = event.payload?.pluginId;
      if (typeof id === "string" && id !== "") handler(id);
    });
  } catch (e) {
    console.warn("监听剪贴板历史快捷键事件失败:", e);
    return null;
  }
}

/**
 * 监听「插件自定义动作」快捷键事件（Rust 端注册的 `plugin:<id>:<name>` 热键按下时广播）。
 *
 * 主窗口据此打开该插件视图，并把动作名（去掉 `plugin:` 前缀的本地名）派发给插件脚本
 * （插件用 `ms.shortcuts.onAction(name, fn)` 接收）。
 */
export async function onShortcutPluginAction(
  handler: (pluginId: string, action: string) => void
): Promise<UnlistenFn | null> {
  if (!isTauri) return null;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<{ pluginId?: unknown; action?: unknown }>(
      "my-search://shortcut-plugin-action",
      (event) => {
        const id = event.payload?.pluginId;
        const action = event.payload?.action;
        if (typeof id === "string" && id !== "" && typeof action === "string" && action !== "") {
          handler(id, action);
        }
      }
    );
  } catch (e) {
    console.warn("监听插件动作快捷键事件失败:", e);
    return null;
  }
}

/**
 * 监听「剪贴板历史有更新」事件（Rust 原生监听到剪贴板变更后广播，无 payload）。
 * 插件视图开着时据此刷新列表；事件本身不带数据，真实内容由前端调
 * `clipboardHistoryList()` 主动拉取（见插件 ui/index.js）。
 */
export async function onClipboardUpdated(handler: () => void): Promise<UnlistenFn | null> {
  if (!isTauri) return null;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen("my-search://clipboard-updated", () => handler());
  } catch (e) {
    console.warn("监听剪贴板更新事件失败:", e);
    return null;
  }
}

/**
 * 监听「Alt+点击文件带入」事件（Rust 端在资源管理器/桌面检测到
 * Alt+点击文件时广播，此时窗口已显示并完成复位）。主窗口据此把路径
 * 并入附件——与粘贴/拖入走同一条管线（attachByPaths）。
 */
export async function onAttachPaths(
  handler: (paths: string[]) => void
): Promise<UnlistenFn | null> {
  if (!isTauri) return null;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<{ paths?: unknown }>("my-search://attach-paths", (event) => {
      const raw = event.payload?.paths;
      if (!Array.isArray(raw)) return;
      const paths = raw.filter((p): p is string => typeof p === "string" && p !== "");
      if (paths.length > 0) handler(paths);
    });
  } catch (e) {
    console.warn("监听 Alt+点击带入事件失败:", e);
    return null;
  }
}

/** 浏览器调试环境下的「开机自启动」默认值（与 Rust 端 DEFAULT_AUTOSTART_ENABLED 一致） */
const DEFAULT_AUTOSTART = true;

/**
 * 获取「开机自启动」当前是否生效（供「设置 → 常规设置」展示）。
 * 返回的是**系统里的真实状态**（而非用户偏好），与任务管理器一致。
 */
export async function getAutostartEnabled(): Promise<boolean> {
  if (isTauri) {
    try {
      return await invoke<boolean>("get_autostart_enabled");
    } catch (e) {
      console.warn("读取开机自启动状态失败:", e);
    }
  }
  return DEFAULT_AUTOSTART;
}

/**
 * 设置「开机自启动」（Rust 端立即写入系统启动项并持久化偏好）。
 */
export async function setAutostartEnabled(enabled: boolean): Promise<void> {
  if (isTauri) {
    await invoke("set_autostart_enabled_cmd", { enabled });
  }
}

/** 「Alt+点击文件快速带入」默认值（与 Rust 端 DEFAULT_ALT_CLICK_ENABLED 一致） */
const DEFAULT_ALT_CLICK = true;

/**
 * 获取「Alt+点击文件快速带入」当前是否开启（供「设置 → 常规设置」展示）。
 */
export async function getAltClickEnabled(): Promise<boolean> {
  if (isTauri) {
    try {
      return await invoke<boolean>("get_alt_click_enabled");
    } catch (e) {
      console.warn("读取 Alt+点击设置失败:", e);
    }
  }
  return DEFAULT_ALT_CLICK;
}

/**
 * 设置「Alt+点击文件快速带入」（Rust 端立即更新钩子开关并持久化偏好）。
 */
export async function setAltClickEnabled(enabled: boolean): Promise<void> {
  if (isTauri) {
    await invoke("set_alt_click_enabled_cmd", { enabled });
  }
}

/* ============================================================
 * `.mspp` 文件关联（双击插件包 → 打开本程序并弹安装确认）
 * ============================================================ */

/** 「关联 .mspp 插件包」在浏览器调试环境下的默认值 */
const DEFAULT_FILE_ASSOC = true;

/**
 * 获取「关联 .mspp 插件包」当前是否生效。
 *
 * Rust 侧返回的是**系统注册表的真实状态**（用户可能在 Windows「默认应用」
 * 里改过），因此与开关的显示保持一致口径。
 */
export async function getFileAssocEnabled(): Promise<boolean> {
  if (isTauri) {
    try {
      return await invoke<boolean>("get_file_assoc_enabled");
    } catch (e) {
      console.warn("读取文件关联设置失败:", e);
    }
  }
  return DEFAULT_FILE_ASSOC;
}

/**
 * 设置「关联 .mspp 插件包」（Rust 端立即写/清 HKCU 注册表并持久化偏好）。
 *
 * 返回**写入后的注册表真实状态**：正式构建下可能因权限/策略被系统拦下，
 * 靠这个返回值把开关回填成实际生效的样子，而不是前端乐观假设。
 */
export async function setFileAssocEnabled(enabled: boolean): Promise<boolean> {
  if (isTauri) {
    return await invoke<boolean>("set_file_assoc_enabled_cmd", { enabled });
  }
  return enabled;
}

/**
 * 监听「打开插件包」事件（双击 .mspp / 命令行传入时由 Rust 广播，无 payload）。
 *
 * 事件只负责**叫醒**：真正的路径要调 `takePendingPluginOpen` 拉取。
 * 这样即使广播早于前端挂监听（冷启动双击的场景）也不会丢——前端挂载时
 * 会主动拉一次作为兜底。
 */
export async function onOpenPluginPackage(
  handler: () => void
): Promise<UnlistenFn | null> {
  if (!isTauri) return null;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen("my-search://open-plugin-package", () => handler());
  } catch (e) {
    console.warn("监听打开插件包事件失败:", e);
    return null;
  }
}

/**
 * 取出并清空「待打开的插件包路径」（幂等：取出即清空，重复调用返回 null）。
 */
export async function takePendingPluginOpen(): Promise<string | null> {
  if (!isTauri) return null;
  try {
    const path = await invoke<string | null>("take_pending_plugin_open");
    return typeof path === "string" && path !== "" ? path : null;
  } catch (e) {
    console.warn("读取待打开插件包失败:", e);
    return null;
  }
}

/**
 * 监听「开机自启动」状态变更（托盘菜单里切换后同步设置窗口开关）。
 */
export async function onAutostartChanged(
  handler: (enabled: boolean) => void
): Promise<UnlistenFn | null> {
  if (!isTauri) return null;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<boolean>("my-search://autostart-changed", (event) => handler(event.payload));
  } catch (e) {
    console.warn("监听自启动状态变更失败:", e);
    return null;
  }
}

/**
 * 调整窗口高度（有结果时展开，无结果时收起只显示搜索框）。
 *
 * 内部带防抖（trailing-edge 50ms）：冷启动首次搜索期间，数据分块到位
 * 会连续触发 doSearch → renderResults → setWindowHeight 多次（高度
 * 在 48→521→1500→521→521 跳变），每次都触发 WebView2 重新合成，
 * 合成未完成时能看到「半透明/边框错位」的中间帧（「闪的一下」）。
 * 防抖把同帧内多次调整合并为一次最终下发，根除中间帧。
 *
 * 提供 flushWindowHeight() 立即下发（如详情视图高度变化需要立即可见时）。
 *
 * @param height 目标高度（逻辑像素）
 */
export async function setWindowHeight(height: number): Promise<void> {
  if (!isTauri) return;
  pendingHeight = height;
  if (heightFlushTimer != null) {
    clearTimeout(heightFlushTimer);
  }
  heightFlushTimer = setTimeout(() => {
    flushWindowHeight();
  }, HEIGHT_DEBOUNCE_MS);
}

/** 立即下发当前 pending 的窗口高度（用于详情视图等需要立即生效的场景） */
export function flushWindowHeight(): void {
  if (!isTauri) return;
  if (heightFlushTimer != null) {
    clearTimeout(heightFlushTimer);
    heightFlushTimer = null;
  }
  if (pendingHeight == null) return;
  const h = pendingHeight;
  pendingHeight = null;
  // 插件视图拖拽出的自定义宽度优先：`set_window_height` 会在 Rust 侧按屏幕
  // 分档重算宽度，若继续走它会把用户拖出来的宽度冲掉（见 setWindowWidthOverride）。
  // 走 override 时改用前端 window API 一次下发宽+高，Rust 命令完全不经手。
  if (widthOverride != null) {
    void applyWindowSize(widthOverride, h);
    return;
  }
  invoke("set_window_height", { height: h }).catch((e) => {
    console.warn("调整窗口高度失败:", e);
  });
}

/**
 * 取消当前**尚未下发**的防抖高度（丢弃 pendingHeight 与定时器）。
 *
 * 场景：插件「双击还原」这类需要重新确定高度的过渡——过渡期间可能有旧的
 * `setWindowHeight` 排在防抖队列里（如布局翻转瞬间 ResizeObserver 触发的
 * `fit()` 量到半变布局后写进来的小值）。清掉它，保证随后那次权威下发不会被
 * 早先排队的值覆盖/抢先。
 *
 * 只影响尚未落到 Rust 的那一次；已 invoke 出去的无法撤回（也不需要）。
 */
export function cancelPendingHeight(): void {
  if (heightFlushTimer != null) {
    clearTimeout(heightFlushTimer);
    heightFlushTimer = null;
  }
  pendingHeight = null;
}

/**
 * 插件视图自定义宽度覆盖值（逻辑像素，null = 未覆盖，按屏幕分档）。
 *
 * 为什么需要它：主窗口宽度一直由 Rust 的 `window_width_for()` 按屏幕比例决定，
 * 而高度的每次自适应（useDetailHeight 的 ResizeObserver）都会重新调
 * `set_window_height`，Rust 侧顺手把宽度也重算一遍——插件页拖出来的宽度于是
 * 会在下一次高度更新时被打回。这里在前端拦一道：只要覆盖值存在，高度下发就
 * 改走 `applyWindowSize`（宽=覆盖值、高=目标值），不再调用 Rust 命令。
 *
 * 仅插件视图期间设置，关闭/切走后必须置回 null（见 App.vue 的
 * applyPluginViewSize / clearPluginViewSizeState），否则普通搜索也会被锁成
 * 插件的宽度。
 */
let widthOverride: number | null = null;

/**
 * 设置/清除插件视图的自定义窗口宽度覆盖（逻辑像素）。传 null 清除。
 *
 * 清除后不会立即改变窗口——下一次 `setWindowHeight`/`flushWindowHeight` 或
 * 显式 `applyWindowSize` 才生效；调用方通常紧随其后主动下发一次屏幕分档宽度。
 */
export function setWindowWidthOverride(width: number | null): void {
  widthOverride = width;
}

/** 当前是否处于插件视图自定义宽度下（调试/测试用） */
export function getWindowWidthOverride(): number | null {
  return widthOverride;
}

/**
 * 一次下发窗口的**宽 + 高**（逻辑像素），走前端 `getCurrentWindow().setSize()`。
 *
 * 与 `set_window_height` 的区别：那个只收高度、宽度由 Rust 按屏幕分档算；
 * 这个宽高都由调用方给定，用于插件视图的自定义尺寸。使用项目已授权的
 * `core:window:allow-set-size`，不新增 Rust 命令。
 */
export async function applyWindowSize(width: number, height: number): Promise<void> {
  if (!isTauri) return;
  try {
    const { getCurrentWindow, LogicalSize } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setSize(new LogicalSize(width, height));
  } catch (e) {
    console.warn("调整窗口尺寸失败:", e);
  }
}

/**
 * 以动画方式过渡窗口尺寸（逻辑像素）。
 *
 * ## 为什么不是前端 rAF 逐帧 setSize
 *
 * 早期实现在 rAF 里每帧 fire-and-forget 调 `win.setSize()`：这是 60fps 的跨进程
 * IPC（JS→wry→tao→Win32）且不等返回就连发下一条，原生端缩放指令会堆积，表现为
 * 明显卡顿。
 *
 * ## 为什么不是「窗口一次性到位 + 内容 transform」
 *
 * 那样窗口与内容走两条时间线：窗口先跳到目标尺寸、内容再 scale 放大，用户会看到
 * 「窗口放大一次、内容放大一次」的二次观感。
 *
 * ## 现方案：Rust 原生动画线程
 *
 * 只发**一次** IPC `animate_window_size`，由 Rust 在后台线程按帧直接 `set_size`：
 * 无每帧往返、无堆积；且每帧改的是**窗口**，内容靠 CSS `height:100%` 解析视口自然
 * 铺满——窗口与内容**同帧变化**，严格跟随，无二次放大。
 *
 * **不移动窗口位置**——位置应由调用方在动画**之前**一次到位。
 *
 * @param width  目标宽度
 * @param height 目标高度
 * @param durationMs 动画时长（毫秒），默认 90（偏快，减少等待感）
 * @param onFrame 保留参数（当前实现由 Rust 驱动，不再逐帧回调前端）；仅为兼容
 *   既有调用点签名，忽略即可。
 */
export const WINDOW_RESIZE_ANIM_MS = 90;

export async function animateWindowSize(
  width: number,
  height: number,
  durationMs = WINDOW_RESIZE_ANIM_MS,
  _onFrame?: (w: number, h: number) => void,
): Promise<void> {
  if (!isTauri) return;
  // 目标值非法（NaN/Infinity/非正）：不做动画，也不下发，避免把非法尺寸传给窗口
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return;
  }
  try {
    await invoke("animate_window_size", {
      fromWidth: window.innerWidth,
      fromHeight: window.innerHeight,
      toWidth: width,
      toHeight: height,
      durationMs,
    });
  } catch (e) {
    console.warn("窗口尺寸过渡失败:", e);
  }
}

/** 取消正在进行的窗口尺寸动画（如用户开始拖拽时打断残余动画） */
export function cancelWindowResizeAnimation(): void {
  if (!isTauri) return;
  void invoke("cancel_window_resize_animation").catch(() => {});
}

/**
 * 获取当前显示器下的屏幕分档宽度（逻辑像素）。
 *
 * 复用 Rust 侧 `target_window_width` 的计算口径（按屏幕宽度分档取占比，
 * 限制在 [320px, 屏幕宽度 90%] 内），用于前端过渡动画计算目标宽度。
 */
export async function getDefaultWindowWidth(): Promise<number> {
  if (!isTauri) return window.innerWidth;
  try {
    const w = await invoke<number>("get_default_window_width");
    // 容错：命令缺失/返回非正数时退回当前视口宽度，避免把 NaN/null 喂给动画
    if (typeof w === "number" && Number.isFinite(w) && w > 0) return w;
  } catch (e) {
    console.warn("获取默认窗口宽度失败:", e);
  }
  return window.innerWidth;
}

/**
 * 登记 / 清除「插件视图自定义窗口尺寸」到 Rust（逻辑像素；传 null 清除）。
 *
 * ## 为什么需要它（消除呼出时「窗口先放大、内容再放大」）
 *
 * 隐藏时 Rust 会把窗口物理收回到 48px。旧实现再呼出时是「先显示成 48px/分档宽，
 * 前端再发一次 90ms 尺寸动画补回记忆尺寸」——窗口（原生 set_size）先长满，内容
 * （`height:100%` 的 WebView 视口）滞后到最后一帧才跟上，用户看到两次放大。
 *
 * 现在前端在**进入插件视图 / 拖拽结束**时把尺寸登记到 Rust，`show_main_window`
 * 会在 `show()` **之前**按该尺寸建好窗口并完全居中。呼出时窗口已是最终尺寸，
 * 前端不再产生任何 resize，不存在两条时间线。
 *
 * 退出插件视图（切走 / 关闭 / 双击还原 / 复位）时必须传 null 清除，否则下次
 * 呼出（哪怕不在插件页）会以插件尺寸建窗。
 */
export async function setMainWindowViewSize(
  size: { width: number; height: number } | null
): Promise<void> {
  if (!isTauri) return;
  const width = size && Number.isFinite(size.width) && size.width > 0 ? size.width : null;
  const height = size && Number.isFinite(size.height) && size.height > 0 ? size.height : null;
  try {
    await invoke("set_main_window_view_size", { width, height });
  } catch (e) {
    // 命令缺失（旧版本 Rust）/ 调用失败：只影响呼出观感，退回「动画补尺寸」路径，
    // 不阻断插件视图本身
    console.warn("登记插件视图窗口尺寸失败:", e);
  }
}

/**
 * 把窗口移动到指定逻辑坐标（左上角）。用于插件视图的自定义尺寸居中。
 * 使用已授权的 `core:window:allow-set-position`。
 */
export async function setWindowPosition(x: number, y: number): Promise<void> {
  if (!isTauri) return;
  try {
    const { getCurrentWindow, LogicalPosition } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setPosition(new LogicalPosition(x, y));
  } catch (e) {
    console.warn("调整窗口位置失败:", e);
  }
}

/**
 * 把主窗口位置复位到常态（水平居中 + 顶部约屏高 22%），并把宽度复位成屏幕分档。
 *
 * 用于**退出插件视图**：插件页会按自己的规则移动窗口（applyPluginWindowSize 的
 * setWindowPosition），退出后必须回到普通搜索窗的位置。定位口径在 Rust 侧
 * （`position_window_top_center`，与 show_main_window 共用），前端不复刻公式，
 * 避免两处公式不一致导致落点偏差。
 *
 * 只改宽度与位置，不改高度；高度由调用方随后按内容下发（set_window_height）。
 */
export async function resetMainWindowPosition(): Promise<void> {
  if (!isTauri) return;
  try {
    await invoke("reset_main_window_position");
  } catch (e) {
    console.warn("复位窗口位置失败:", e);
  }
}

/**
 * 取主窗口当前所在显示器的信息（逻辑像素），供插件视图居中计算用。
 *
 * 返回的 `x/y/width/height` 均已换算成**逻辑像素**（Tauri 的 monitor.size()
 * 是物理像素，需除以缩放系数），与 `setWindowPosition` 的 LogicalPosition
 * 口径一致；`scale` 一并返回备用。取不到时返回 null（调用方回退到不定位）。
 */
export async function getMainMonitorRect(): Promise<{
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
} | null> {
  if (!isTauri) return null;
  try {
    const { currentMonitor } = await import("@tauri-apps/api/window");
    const monitor = await currentMonitor();
    if (!monitor) return null;
    const scale = monitor.scaleFactor > 0 ? monitor.scaleFactor : 1;
    return {
      x: monitor.position.x / scale,
      y: monitor.position.y / scale,
      width: monitor.size.width / scale,
      height: monitor.size.height / scale,
      scale,
    };
  } catch (e) {
    console.warn("读取显示器信息失败:", e);
    return null;
  }
}

/**
 * 「最近添加」条带：把主窗口整体上移 delta（逻辑像素）并等量增高，或反向
 * 还原（delta 为负）。Rust 侧用一次 SetWindowPos 原子完成「改位 + 改高」——
 * 分两次调用会产生中间帧，条带悬在窗口上边缘之外时会看到跳变。
 * delta > 0 展开（顶边上移、底边不动，内容屏幕位置不变）；delta < 0 收起。
 */
/** 防抖尾沿时长（ms）——50ms 足以合并不在同一帧内的多次调整 */
const HEIGHT_DEBOUNCE_MS = 50;
/** 待下发的目标高度（null = 没有待下发） */
let pendingHeight: number | null = null;
/** 防抖定时器 */
let heightFlushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 监听主窗口“重新显示”事件（Rust 端 toggle_window 显示窗口时广播）。
 * 用于前端在每次呼出时复位残留的详情/结果视图与窗口高度，避免上次搜索的高窗口残留。
 * 注意：输入框内容属于用户会话，前端复位时会保留未处理完的输入并重新触发搜索。
 */
export async function onMainWindowShown(handler: () => void): Promise<UnlistenFn | null> {
  if (!isTauri) return null;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen("my-search://main-window-shown", () => handler());
  } catch (e) {
    console.warn("监听主窗口显示事件失败:", e);
    return null;
  }
}

/**
 * 监听托盘「清理缓存」事件。
 * 托盘菜单无 WebView，无法直接操作 localStorage，因此 Rust 端通过事件
 * 通知前端执行清理；前端收到后删除可重建缓存键（订阅数据 + 订阅指纹），
 * 主窗口下次唤出时检测到缓存失效会自动重新加载。
 */
export async function onClearCache(handler: () => void): Promise<UnlistenFn | null> {
  if (!isTauri) return null;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen("my-search://clear-cache", () => handler());
  } catch (e) {
    console.warn("监听清理缓存事件失败:", e);
    return null;
  }
}

/**
 * 隐藏窗口（悬浮窗失焦自动隐藏，前端也可主动调用）
 * @see 失焦隐藏现由 Rust 侧无条件执行（`on_window_event` 收到 Focused(false) 即隐藏），
 *      前端无需再同步「是否允许隐藏」。
 */
export async function hideWindow(): Promise<void> {
  if (isTauri) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    // 已经隐藏就不用再隐藏（Esc / 打开外链后可能重复调用）
    if (!(await win.isVisible())) return;
    await win.hide();
  }
}

/** 拖动窗口（用于搜索框拖拽） */
export async function startDragging(): Promise<void> {
  if (isTauri) {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().startDragging();
    } catch (e) {
      /* ignore */
    }
  }
}

/** 监听窗口焦点变化（用于自动聚焦输入框） */
export async function onWindowFocusChanged(
  handler: (focused: boolean) => void
): Promise<UnlistenFn | null> {
  if (!isTauri) return null;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return await getCurrentWindow().onFocusChanged(({ payload }) => handler(payload));
  } catch (e) {
    console.warn("监听窗口焦点变化失败:", e);
    return null;
  }
}

/** 当前窗口是否可见（非 Tauri 环境视为可见） */
export async function isWindowVisible(): Promise<boolean> {
  if (!isTauri) return true;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return await getCurrentWindow().isVisible();
  } catch (e) {
    return true;
  }
}

// ===================== 版本更新 =====================

const EMPTY_UPDATE_INFO: UpdateInfo = {
  has_update: false,
  latest_version: "",
  current_version: "",
  download_url: "",
  release_url: "",
  check_failed: false,
};

/**
 * 检查 GitHub Releases 是否有新版本。
 */
export async function checkUpdate(): Promise<UpdateInfo> {
  if (!isTauri) return { ...EMPTY_UPDATE_INFO };
  try {
    return await invoke<UpdateInfo>("check_update");
  } catch (e) {
    // 命令本身失败（如 IPC 异常）：标记 check_failed，避免上层把它当成
    // 「已是最新」——这正是旧版「检测不到新版本」被掩盖的路径。
    console.warn("检查更新失败:", e);
    return { ...EMPTY_UPDATE_INFO, check_failed: true };
  }
}

/**
 * 开始下载更新包（自动推送到安装目录，完成后打开安装文件）。
 * @param downloadUrl 下载地址
 */
export async function startUpdateDownload(downloadUrl: string): Promise<void> {
  if (!isTauri) return;
  await invoke("start_update_download", { downloadUrl });
}

/**
 * 监听下载进度。
 */
export async function onUpdateProgress(
  handler: (progress: UpdateProgress) => void
): Promise<UnlistenFn | null> {
  if (!isTauri) return null;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<UpdateProgress>("update://progress", (event) => handler(event.payload));
  } catch (e) {
    console.warn("监听下载进度失败:", e);
    return null;
  }
}

/**
 * 监听下载完成事件。
 */
export async function onUpdateComplete(
  handler: (payload: UpdateCompletePayload) => void
): Promise<UnlistenFn | null> {
  if (!isTauri) return null;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<UpdateCompletePayload>("update://complete", (event) =>
      handler(event.payload)
    );
  } catch (e) {
    console.warn("监听下载完成事件失败:", e);
    return null;
  }
}

/**
 * 打开已下载好的安装文件（由用户在界面点击「安装更新」时调用）。
 * 会先校验文件是否存在再打开安装程序。
 */
export async function openInstaller(): Promise<void> {
  if (!isTauri) return;
  await invoke("open_installer");
}

/**
 * 广播「自动下载更新」开关变化（配置窗口写入设置后调用）。
 *
 * 两窗口虽共享 localStorage，但另一窗口不会自动感知写入；若不广播，
 * 关闭开关后搜索窗口叶子上的更新红箭头要滞留到下一次呼出或 20 分钟定时点才消失。
 * 搜索窗口收到后立即按新开关重新求值（见 useUpdateChecker.recheckSetting）。
 */
export async function notifyAutoDownloadChanged(): Promise<void> {
  if (!isTauri) return;
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit("my-search://auto-download-update-changed");
  } catch (e) {
    console.warn("广播自动下载更新设置变更失败:", e);
  }
}

/**
 * 监听「自动下载更新」开关变化（搜索窗口 useUpdateChecker 注册）。
 * 收到即重求值：关闭 → 立刻隐藏叶子红箭头进入静默；开启 → 立刻检查并下载。
 */
export async function onAutoDownloadChanged(handler: () => void): Promise<UnlistenFn | null> {
  if (!isTauri) return null;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen("my-search://auto-download-update-changed", () => handler());
  } catch (e) {
    console.warn("监听自动下载更新设置变更失败:", e);
    return null;
  }
}
