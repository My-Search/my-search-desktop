/**
 * 内置插件桥接层 —— 把 Rust 侧 builtin 模块的能力暴露给前端。
 *
 * 两个入口：
 *   1. 启动时收到 `builtin://available` 事件 → 自动安装（搜索窗、配置窗各接一次，幂等）；
 *   2. 配置窗面板 → 手动管理（列表 / 卸载标记 / 恢复）。
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../tauri-bridge.ts";

/* ============================================================
 * 类型
 * ============================================================ */

/** 与 Rust `BuiltinEntry` 对齐 */
export interface BuiltinEntry {
  id: string;
  available: boolean;
  installed: boolean;
  removed: boolean;
  version: string | null;
  resourcePath: string | null;
}

/** 与 Rust `BootstrapReport` 对齐 */
export interface BootstrapReport {
  installable: string[];
  skippedRemoved: string[];
}

/* ============================================================
 * 命令调用
 * ============================================================ */

/** 列出所有内置插件的状态 */
export async function builtinList(): Promise<BuiltinEntry[]> {
  if (!isTauri) return [];
  return await invoke<BuiltinEntry[]>("builtin_list");
}

/** 标记内置插件「已被用户卸载」（升级不复活） */
export async function builtinMarkRemoved(id: string): Promise<void> {
  if (!isTauri) return;
  await invoke("builtin_mark_removed", { id });
}

/** 清除「已卸载」标记（恢复内置用） */
export async function builtinClearRemoved(id: string): Promise<void> {
  if (!isTauri) return;
  await invoke("builtin_clear_removed", { id });
}

/** 取内置插件资源路径（前端拿它走「从文件安装」管线） */
export async function builtinResourcePath(id: string): Promise<string> {
  if (!isTauri) throw new Error("内置插件资源路径仅在桌面端可用");
  return await invoke<string>("builtin_resource_path", { id });
}

/* ============================================================
 * 启动事件监听（`builtin://available`）
 * ============================================================ */

/** 注册内置插件自动安装监听。返回取消函数，供 onUnmounted 清理。 */
export function onBuiltinAvailable(
  handler: (report: BootstrapReport) => void
): () => void {
  if (!isTauri) return () => {};
  let unlisten: (() => void) | null = null;
  import("@tauri-apps/api/event").then(({ listen }) => {
    listen<BootstrapReport>("builtin://available", (event) => {
      handler(event.payload);
    }).then((fn) => { unlisten = fn; });
  }).catch((e) => {
    console.warn("监听内置插件事件失败:", e);
  });
  return () => { unlisten?.(); };
}