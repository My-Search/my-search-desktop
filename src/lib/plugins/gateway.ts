/**
 * 网关同步（前端 → Rust）—— 单一映射来源。
 *
 * 两个窗口都可能触发同步（设置窗口装/卸/改权限，搜索窗口首次使用插件时
 * 弹窗授权），因此把「注册表记录 → 网关配置」的映射集中在这里，
 * 避免两处各写一份、字段对不上。
 *
 * Rust 侧只持有镜像：`GATEWAY` 是进程内表，前端才是唯一真相源。
 */

import { syncGateway } from "./ipc.ts";
import type { PluginRecord } from "./registry.ts";

/** 由插件记录生成下发给 Rust 的网关配置 */
export function gatewaySpecOf(rec: PluginRecord): {
  pluginId: string;
  enabled: boolean;
  autoStart: string;
  grants: string[];
  backendEntry: string | null;
  backendProtocol: string | null;
  idleExitSec: number;
  graceSec: number;
  maxRestarts: number;
  startupTimeoutMs: number;
  callTimeoutMs: number;
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
    maxRestarts: backend?.maxRestarts ?? 3,
    startupTimeoutMs: backend?.startupTimeoutMs ?? 3000,
    callTimeoutMs: backend?.callTimeoutMs ?? 30000,
  };
}

/** 同步单个插件的网关配置 */
export async function syncRecordGateway(rec: PluginRecord): Promise<void> {
  await syncGateway(gatewaySpecOf(rec));
}
