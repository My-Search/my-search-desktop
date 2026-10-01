/**
 * 网关同步（前端 → Rust）—— 单一映射来源。
 *
 * 两个窗口都可能触发同步（设置窗口装/卸/改权限，搜索窗口首次使用插件时
 * 弹窗授权），因此把「注册表记录 → 网关配置」的映射集中在这里，
 * 避免两处各写一份、字段对不上。
 *
 * Rust 侧只持有镜像：`GATEWAY` 是进程内表，前端才是唯一真相源。
 */

import { syncGateway, syncPluginShortcutActions } from "./ipc.ts";
import { buildPluginEnv } from "./env-store.ts";
import type { PluginRecord, PluginRegistryFile } from "./registry.ts";

/** 由插件记录生成下发给 Rust 的网关配置 */
export function gatewaySpecOf(rec: PluginRecord): {
  pluginId: string;
  enabled: boolean;
  autoStart: string;
  grants: string[];
  backendEntry: string | null;
  backendProtocol: string | null;
  idleExitSec: number;
  /** 前台关闭后的保留窗口期（秒） */
  graceSec: number;
  /** 优雅退出等待（秒）——deactivate 发出后等这么久再强杀 */
  shutdownTimeoutSec: number;
  maxRestarts: number;
  startupTimeoutMs: number;
  callTimeoutMs: number;
  /** 注入插件后台进程的环境变量（只含**已授权**的宿主变量） */
  env: Record<string, string>;
} {
  const backend = rec.manifest.backend;
  return {
    pluginId: rec.id,
    enabled: rec.enabled,
    autoStart: rec.autoStart,
    grants: rec.grants.map((g) => g.permission),
    backendEntry: backend?.entry ?? null,
    backendProtocol: backend?.protocol ?? null,
    // 「开机自启」的插件不做空闲回收（idleExitSec=0 表示常驻）
    idleExitSec: rec.autoStart === "always" ? 0 : backend?.idleExitSec ?? 30,
    graceSec: backend?.graceSec ?? 5,
    // 优雅退出时长：Rust 侧按此值等 deactivate 后的收尾（字段名必须与 Rust 一致，
    // 否则声明的值不生效、永远退化成默认——这正是之前 graceSec/shutdownTimeoutSec
    // 名字对不上留下的坑）。
    shutdownTimeoutSec: backend?.shutdownTimeoutSec ?? 5,
    maxRestarts: backend?.maxRestarts ?? 3,
    startupTimeoutMs: backend?.startupTimeoutMs ?? 3000,
    callTimeoutMs: backend?.callTimeoutMs ?? 30000,
    // 环境变量：清单里的字面量 + 引用，加上该插件**已授权**（env.read:<NAME>）的
    // 宿主变量（见 env-store.buildPluginEnv）。未授权的一律不出现。
    env: buildPluginEnv(rec),
  };
}

/** 同步单个插件的网关配置 */
export async function syncRecordGateway(rec: PluginRecord): Promise<void> {
  await syncGateway(gatewaySpecOf(rec));
}

/**
 * 把「当前已安装插件提供的快捷键作用类型」下发给 Rust。
 *
 * 截图 / 剪贴板历史这类插件动作是否可用取决于**插件是否安装**，而注册表在前端
 * （Rust 不持有）。安装 / 卸载 / 启用禁用 / 热重载后调用本函数，宿主据此注入
 * 缺失的默认热键、移除已卸载动作的绑定（幂等，无变化时不重注册）。
 *
 * 这里再做一层前端记忆：算出的动作集合与上次相同就跳过 IPC（reconcile 会按
 * 插件逐条调用，避免同一次注册表变化反复发同一条报文）。
 *
 * @param reg 当前注册表；缺省时现场读一次 localStorage
 */
let lastShortcutActionsJson: string | null = null;
export async function syncShortcutActions(reg?: PluginRegistryFile): Promise<void> {
  const { availableShortcutActions } = await import("./shortcut-actions.ts");
  const registry = reg ?? (await import("./registry.ts")).loadRegistry();
  const actions = availableShortcutActions(registry).map((a) => ({
    action: a.action,
    defaultShortcut: a.defaultShortcut,
  }));
  const json = JSON.stringify(actions);
  if (json === lastShortcutActionsJson) return;
  await syncPluginShortcutActions(actions);
  lastShortcutActionsJson = json;
}
