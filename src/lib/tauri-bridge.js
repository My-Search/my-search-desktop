/**
 * Tauri 桥接层 - 封装前端对 Rust 后端的调用
 * 在纯浏览器环境（开发调试）下降级为 fetch
 */

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";

/** 是否运行在 Tauri 环境 */
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * HTTP GET（优先走 Rust 代理，浏览器环境降级 fetch）
 */
export async function httpGet(url) {
  if (isTauri) {
    return await invoke("http_get", { url });
  }
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return await resp.text();
}

/**
 * 打开外部链接（默认浏览器）
 */
export async function openExternal(url) {
  if (isTauri) {
    try {
      return await invoke("open_url", { url });
    } catch (e) {
      // 降级
      window.open(url, "_blank");
    }
  } else {
    window.open(url, "_blank");
  }
}

/**
 * 退出应用
 */
export async function quitApp() {
  if (isTauri) {
    await invoke("quit_app");
  }
}

/**
 * 获取默认订阅
 */
export async function getDefaultSubscribes() {
  if (isTauri) {
    return await invoke("get_default_subscribes");
  }
  return [
    {
      url: "https://raw.githubusercontent.com/My-Search/official-subscribe/refs/heads/dev/only-system-index.ms",
      title: "官方订阅-系统项",
      describe: "我的搜索官方内置订阅的系统项部分",
    },
    {
      url: "https://raw.githubusercontent.com/My-Search/official-subscribe/refs/heads/dev/index.ms",
      title: "官方作者zhuangjie订阅-小庄的收藏室",
      describe: "我的搜索官方内置订阅之作者zhuangjie订阅",
    },
  ];
}

/**
 * 调整窗口高度（有结果时展开，无结果时收起只显示搜索框）
 * @param {number} height 目标高度（逻辑像素）
 */
export async function setWindowHeight(height) {
  if (isTauri) {
    try {
      await invoke("set_window_height", { height });
    } catch (e) {
      console.warn("调整窗口高度失败:", e);
    }
  }
}

/**
 * 隐藏窗口（悬浮窗失焦自动隐藏，前端也可主动调用）
 */
export async function hideWindow() {
  if (isTauri) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().hide();
  }
}

/**
 * 隐藏窗口并清空（Esc 时）
 */
export async function hideAndClear() {
  await hideWindow();
}
