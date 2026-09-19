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

/** 打开独立配置窗口（订阅管理） */
export async function openConfigWindow(): Promise<void> {
  if (isTauri) {
    await invoke("open_config_window");
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
  invoke("set_window_height", { height: h }).catch((e) => {
    console.warn("调整窗口高度失败:", e);
  });
}

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
};

/**
 * 检查 GitHub Releases 是否有新版本。
 */
export async function checkUpdate(): Promise<UpdateInfo> {
  if (!isTauri) return { ...EMPTY_UPDATE_INFO };
  try {
    return await invoke<UpdateInfo>("check_update");
  } catch (e) {
    console.warn("检查更新失败:", e);
    return { ...EMPTY_UPDATE_INFO };
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
