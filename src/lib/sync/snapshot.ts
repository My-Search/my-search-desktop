/**
 * 快照采集与还原 —— 将所有用户数据（localStorage + 插件注册表 + 插件数据）
 * 汇集为一个 JSON 对象，交给 Rust 侧打包成 .msbackup 归档。
 *
 * 职责边界：
 *   - 采集：读 localStorage 里的所有用户键
 *   - 还原：把归档里的 localStorage 快照写回（跳过凭据与可重建缓存）
 *   - 指纹：对比快照判断「是否有变化」
 *
 * 什么键跳过：
 *   - 凭据（`USER_GITHUB_TOKEN_CACHE_KEY`、`SYNC_CONFIG_CACHE_KEY`、
 *     `SYNC_STATE_CACHE_KEY`）——跨机还原不应该带 B 机器的 Token 去覆盖
 *   - 可重建的大缓存（`SEARCH_DATA_KEY`、`SUBSCRIBE_FINGERPRINT_KEY`）
 *     ——还原后主窗口会自己重新拉
 *   - 插件数据（`PLUGIN_DATA:*`）由 Rust 侧的 `plugin-data/` 负责
 *     （前端只写注册表，不写 `PLUGIN_DATA:*` 下的 localStorage 值）
 */

import { storageGet, storageSet, storageRemove } from "../util";

/** 备份时**排除**的 localStorage 键（不跨机携带、不写回） */
const SKIP_KEYS = new Set([
  "USER_GITHUB_TOKEN_CACHE_KEY",
  "SYNC_CONFIG_CACHE_KEY",
  "SYNC_STATE_CACHE_KEY",
  "SEARCH_DATA_KEY",
  "SUBSCRIBE_FINGERPRINT_KEY",
]);

/** 永远不写的插件数据前缀 */
const SKIP_PREFIXES = ["PLUGIN_DATA:", "script:"];

/** 采集本地 localStorage 快照（返回一个扁平键值对对象） */
export function collectState(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  try {
    const prefix = "my-search-desktop:";
    for (let i = 0; i < localStorage.length; i++) {
      const full = localStorage.key(i);
      if (!full || !full.startsWith(prefix)) continue;
      const key = full.slice(prefix.length);
      if (SKIP_KEYS.has(key)) continue;
      if (SKIP_PREFIXES.some((p) => key.startsWith(p))) continue;
      try {
        out[key] = JSON.parse(localStorage.getItem(full)!);
      } catch {
        out[key] = localStorage.getItem(full); // fallback to raw string
      }
    }
  } catch (e) {
    console.warn("[同步] 采集本地状态失败:", e);
  }
  return out;
}

/** 写回 localStorage 快照（跳过 SKIP_KEYS + 凭据） */
export function restoreState(data: Record<string, unknown>): number {
  let count = 0;
  for (const [key, value] of Object.entries(data)) {
    if (SKIP_KEYS.has(key)) continue;
    if (SKIP_PREFIXES.some((p) => key.startsWith(p))) continue;
    storageSet(key, value);
    count++;
  }
  return count;
}

/**
 * 计算当前状态的指纹（用于快速比对「有没有变化」）。
 *
 * 指纹只包含用户编辑态键（订阅、标签过滤、权重、历史），
 * 不包含插件注册表（插件由 Rust 文件侧覆盖，合入指纹会因时间戳波动而误判）。
 */
export function fingerprint(): string {
  const parts: string[] = [];
  const included = [
    "subscribes",
    "ITEM_WEIGHT_CACHE_KEY",
    "USER_UNFOLLOW_LIST_CACHE_KEY",
    "DATA_ITEM_TAGS_CACHE_KEY",
    "HISTORY_CACHE_KEY",
    "USE_INSTALL_TISHUB_CACHE_KEY",
    "OLD_SEARCH_DATAS_KEY",
  ];
  for (const key of included) {
    const val = storageGet<unknown>(key, null);
    // 把值序列化成一行的 JSON 摘要；null/undefined 也写 "null" 来产生稳定的指纹
    try {
      parts.push(`${key}=${JSON.stringify(val ?? null)}`);
    } catch {
      parts.push(`${key}=null`);
    }
  }
  return parts.join("|");
}

/** 计算 settings.json 的指纹（用几个可备份键拼成） */
export function settingsFingerprint(
  shortcutBindings: unknown,
  autostartEnabled: boolean
): string {
  return `sb=${JSON.stringify(shortcutBindings)}|ae=${autostartEnabled}`;
}