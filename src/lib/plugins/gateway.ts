/**
 * 网关同步（前端 → Rust）—— 单一映射来源。
 *
 * 两个窗口都可能触发同步（设置窗口装/卸/改权限，搜索窗口首次使用插件时
 * 弹窗授权），因此把「注册表记录 → 网关配置」的映射集中在这里，
 * 避免两处各写一份、字段对不上。
 *
 * Rust 侧只持有镜像：`GATEWAY` 是进程内表，前端才是唯一真相源。
 */

import {
  syncGateway,
  syncGatewayBatch,
  syncPluginShortcutActions,
  type GatewaySpecIpc,
} from "./ipc.ts";
import { buildPluginEnv } from "./env-store.ts";
import { listShortcutActions } from "./manifest.ts";
import {
  PLUGIN_REGISTRY_KEY,
  REGISTRY_CHANGED_DOM_EVENT,
  type PluginRecord,
  type PluginRegistryFile,
} from "./registry.ts";
import { isTauri } from "../tauri-bridge.ts";

/**
 * 判定插件是否应接入后台剪贴板持续捕获（`GatewaySpec.clipboardCapture`）。
 *
 * 优先以清单显式声明 `contributes.clipboardCapture` 为准；
 * 老版本剪贴板插件包尚未更新清单时，若其显式认领了 `clipboard` 快捷键动作则自动兼容开启。
 */
export function wantsClipboardCapture(rec: PluginRecord): boolean {
  const explicit = rec.manifest.contributes?.clipboardCapture;
  if (typeof explicit === "boolean") return explicit;
  return listShortcutActions(rec.manifest).some((s) => s.action === "clipboard");
}

/** 由插件记录生成下发给 Rust 的网关配置 */
export function gatewaySpecOf(rec: PluginRecord): GatewaySpecIpc {
  const backend = rec.manifest.backend;
  return {
    pluginId: rec.id,
    enabled: rec.enabled,
    autoStart: rec.autoStart,
    grants: rec.grants.map((g) => g.permission),
    backendEntry: backend?.entry || null,
    backendCommand: backend?.command ?? null,
    backendProtocol: backend?.protocol ?? null,
    // 「开机自启」的插件不做空闲回收（idleExitSec=0 表示常驻）
    idleExitSec: rec.autoStart === "always" ? 0 : backend?.idleExitSec ?? 30,
    graceSec: backend?.graceSec ?? 5,
    shutdownTimeoutSec: backend?.shutdownTimeoutSec ?? 5,
    maxRestarts: backend?.maxRestarts ?? 3,
    startupTimeoutMs: backend?.startupTimeoutMs ?? 3000,
    callTimeoutMs: backend?.callTimeoutMs ?? 30000,
    env: buildPluginEnv(rec),
    clipboardCapture: wantsClipboardCapture(rec),
  };
}

/** 同步单个插件的网关配置 */
export async function syncRecordGateway(rec: PluginRecord): Promise<void> {
  await syncGateway(gatewaySpecOf(rec));
}

/**
 * 原子批量同步整张插件注册表到 Rust 网关（一次 IPC + 一次快照落盘 + 一次原生能力调和）。
 *
 * 消除旧实现「每个插件各发一次 `plugin_gateway_sync` 写盘」的 N 次放大，
 * 同时让 Rust 自动剔除已从注册表移除的残留网关条目。
 */
export async function syncRegistryGateway(reg: PluginRegistryFile): Promise<void> {
  const specs = reg.plugins
    .filter((p) => p.source.kind !== "legacy")
    .map((p) => gatewaySpecOf(p));
  await syncGatewayBatch(specs);
}

/**
 * 把「当前已安装插件提供的快捷键作用类型」下发给 Rust。
 *
 * 携带 `pluginId` 使宿主能动态解析快捷键归属插件与权限，无需在 Rust 中硬编码插件 ID。
 */
let lastShortcutActionsJson: string | null = null;
export async function syncShortcutActions(reg?: PluginRegistryFile): Promise<void> {
  const { availableShortcutActions } = await import("./shortcut-actions.ts");
  const registry = reg ?? (await import("./registry.ts")).loadRegistry();
  const actions = availableShortcutActions(registry).map((a) => ({
    action: a.action,
    pluginId: a.pluginId,
    defaultShortcut: a.defaultShortcut,
  }));
  const json = JSON.stringify(actions);
  if (json === lastShortcutActionsJson) return;
  await syncPluginShortcutActions(actions);
  lastShortcutActionsJson = json;
}

/**
 * 订阅注册表与网关变更（统一同窗 DOM 事件、`storage` 事件与 Tauri `plugin://registry-changed` 广播）。
 *
 * 使 `main` 搜索窗、`config` 设置窗与 `plugin-win-*` 插件独立窗口保持毫秒级无轮询状态一致。
 */
export function onRegistryChanged(handler: () => void): () => void {
  let disposed = false;
  let scheduled = false;
  const trigger = () => {
    if (disposed || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!disposed) handler();
    });
  };

  const onDom = () => trigger();
  const onStorage = (e: StorageEvent) => {
    if (!e.key || e.key === "my-search-desktop:" + PLUGIN_REGISTRY_KEY) {
      trigger();
    }
  };

  if (typeof window !== "undefined") {
    window.addEventListener(REGISTRY_CHANGED_DOM_EVENT, onDom);
    window.addEventListener("storage", onStorage);
  }

  let unlistenTauri: (() => void) | null = null;
  if (isTauri) {
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen("plugin://registry-changed", () => {
          trigger();
        })
      )
      .then((fn) => {
        if (disposed) fn();
        else unlistenTauri = fn;
      })
      .catch(() => {
        /* ignore */
      });
  }

  return () => {
    disposed = true;
    if (typeof window !== "undefined") {
      window.removeEventListener(REGISTRY_CHANGED_DOM_EVENT, onDom);
      window.removeEventListener("storage", onStorage);
    }
    if (unlistenTauri) {
      try {
        unlistenTauri();
      } catch {
        /* ignore */
      }
      unlistenTauri = null;
    }
  };
}
