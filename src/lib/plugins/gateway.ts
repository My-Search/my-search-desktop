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

/**
 * 已成功下发到 Rust 的网关配置指纹（插件 id → spec JSON）。
 *
 * 为什么需要：搜索窗口的 `ms.backend.call` 在每次调用前都会「确保 Rust 侧有记录」
 * 地重放一次 `syncRecordGateway`（见 `usePluginHost.callBackend`）。而一次网关
 * 同步在 Rust 侧要做三件重活：写 `plugin-gateway.json`、调和原生钩子
 * （剪贴板/鼠标手势）、向所有窗口广播 `plugin://registry-changed`。后端每 1~2 秒
 * 轮询一次的插件（如 pi-agent）会把这三件事变成常态开销。
 *
 * 内容没变就跳过 IPC —— 语义完全不变（Rust 侧持有的仍是同一份配置），
 * 只有**成功**下发才记指纹，失败仍允许下次重试。
 */
const lastGatewaySpecJson = new Map<string, string>();

/** 同步单个插件的网关配置（内容未变则跳过 IPC） */
export async function syncRecordGateway(rec: PluginRecord): Promise<void> {
  const spec = gatewaySpecOf(rec);
  const json = JSON.stringify(spec);
  if (lastGatewaySpecJson.get(rec.id) === json) return;
  await syncGateway(spec);
  lastGatewaySpecJson.set(rec.id, json);
}

/**
 * 原子批量同步整张插件注册表到 Rust 网关（一次 IPC + 一次快照落盘 + 一次原生能力调和）。
 *
 * 消除旧实现「每个插件各发一次 `plugin_gateway_sync` 写盘」的 N 次放大，
 * 同时让 Rust 自动剔除已从注册表移除的残留网关条目。
 *
 * 批量下发后把每个插件的指纹写进缓存：随后同内容的单条 `syncRecordGateway`
 * （如 `ms.backend.call` 前的兜底同步）就不必再发一次 IPC。
 */
export async function syncRegistryGateway(reg: PluginRegistryFile): Promise<void> {
  const specs = reg.plugins
    .filter((p) => p.source.kind !== "legacy")
    .map((p) => gatewaySpecOf(p));
  await syncGatewayBatch(specs);
  // 批量成功后再重建指纹表：已移除插件的旧条目一并丢弃
  lastGatewaySpecJson.clear();
  for (const spec of specs) {
    lastGatewaySpecJson.set(spec.pluginId, JSON.stringify(spec));
  }
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
