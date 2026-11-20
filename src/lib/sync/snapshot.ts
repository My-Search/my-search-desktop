/**
 * 快照采集与还原 —— 将所有用户数据（localStorage + 插件注册表 + 插件数据）
 * 汇集为一个 JSON 对象，交给 Rust 侧打包成 .msbackup 归档。
 *
 * 职责边界：
 *   - 采集：读 localStorage 里的所有用户键（**包含** `PLUGIN_DATA:*`）
 *   - 还原：把归档里的 localStorage 快照静默写回（跳过凭据与可重建缓存）
 *   - 摘要：给同步决策判断「本机到底变没变」
 *
 * 为什么包含 `PLUGIN_DATA:*`
 * --------------------------
 * 插件私有数据有两套存储：无后端插件写在 localStorage 的 `PLUGIN_DATA:*`，
 * 有后端插件写在 Rust 侧 `plugin-data/`。旧实现把前端这套排除在同步之外，
 * 导致换机/重装后无后端插件的数据全部丢失。现在两套都进备份、都能触发同步。
 *
 * 什么键跳过：
 *   - 凭据（`USER_GITHUB_TOKEN_CACHE_KEY`、`SYNC_CONFIG_CACHE_KEY`、
 *     `SYNC_STATE_CACHE_KEY`）——跨机还原不应该带 B 机器的 Token 去覆盖
 *   - 可重建的大缓存（`SEARCH_DATA_KEY`、`OLD_SEARCH_DATAS_KEY`、
 *     `SUBSCRIBE_FINGERPRINT_CACHE_KEY`）——还原后主窗口会自己重新拉
 */

import { storageGet, storageSet, storageRemove } from "../util";
import { PLUGIN_REGISTRY_KEY, keepLocalRecordsAfterRestore } from "../plugins/registry";

/** 备份时**排除**的 localStorage 键（不跨机携带、不写回） */
const SKIP_KEYS = new Set([
  "USER_GITHUB_TOKEN_CACHE_KEY",
  "SYNC_CONFIG_CACHE_KEY",
  "SYNC_STATE_CACHE_KEY",
  // 搜索数据与订阅指纹都可由订阅重建；名称以 search-keys.ts 为准。
  "SEARCH_DATA_KEY",
  "OLD_SEARCH_DATAS_KEY",
  "SUBSCRIBE_FINGERPRINT_CACHE_KEY",
  // 插件重启标记只是一次性跨窗口信号，不是用户数据。
  "PLUGIN_RESTART_MARKS_CACHE_KEY",
]);

/** 永远不碰的运行时缓存前缀 */
const SKIP_PREFIXES = ["script:"];

function isSkippedKey(key: string): boolean {
  return SKIP_KEYS.has(key) || SKIP_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * 这个 localStorage 键变化是否需要触发云同步。
 *
 * 同步宿主用它过滤 `storageSet` 钩子：内部缓存/凭据变化不该造成网络请求，
 * 也不该让「还原时写回」被误判成本机改动（还原本身走 silent）。
 */
export function shouldSyncKey(key: string): boolean {
  return !isSkippedKey(key);
}

/** 采集本地 localStorage 快照（返回一个扁平键值对对象） */
export function collectState(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  try {
    const prefix = "my-search-desktop:";
    for (let i = 0; i < localStorage.length; i++) {
      const full = localStorage.key(i);
      if (!full || !full.startsWith(prefix)) continue;
      const key = full.slice(prefix.length);
      if (isSkippedKey(key)) continue;
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

/**
 * 写回 localStorage 快照。
 *
 * `silent` 默认 **true**：还原是「接收远端数据」而不是用户编辑，写回不能
 * 反过来触发自动上传（否则会形成下载→上传回声，把远端版本推高）。
 * 本地导入如果需要后续同步，由调用方显式 `syncCommitApplied` / 手动触发。
 */
export function restoreState(
  data: Record<string, unknown>,
  opts: {
    silent?: boolean;
    /**
     * 被「版本守卫」跳过的插件 id：注册表里这些插件的记录**保留本机**。
     *
     * 还原会整目录交换 `plugins/`；对「本机版本更高」的插件我们拒绝降级（保留
     * 本机文件），但归档里的注册表记录是旧版本。不换回本机记录就会出现
     * 「磁盘代码是 v2、注册表写着 v1」的错配（表现为插件以错误的版本号工作）。
     */
    keepLocalPluginIds?: readonly string[];
  } = {}
): number {
  const silent = opts.silent !== false;
  let payload = data;
  const keepIds = opts.keepLocalPluginIds ?? [];
  if (keepIds.length > 0 && PLUGIN_REGISTRY_KEY in data) {
    payload = {
      ...data,
      [PLUGIN_REGISTRY_KEY]: keepLocalRecordsAfterRestore(data[PLUGIN_REGISTRY_KEY], keepIds),
    };
  }
  let count = 0;
  for (const [key, value] of Object.entries(payload)) {
    if (isSkippedKey(key)) continue;
    storageSet(key, value, { silent });
    count++;
  }
  return count;
}

/**
 * 删除远端已不存在、本机却还保留的用户键。
 *
 * 仅用于**全量还原**：不删的话，远端删掉的配置/插件数据会永远残留，
 * 下次上传又把它带回去，等于「删除操作永远同步不出去」。
 */
export function pruneState(data: Record<string, unknown>): number {
  const keep = new Set(Object.keys(data));
  const remove: string[] = [];
  try {
    const prefix = "my-search-desktop:";
    for (let i = 0; i < localStorage.length; i++) {
      const full = localStorage.key(i);
      if (!full || !full.startsWith(prefix)) continue;
      const key = full.slice(prefix.length);
      if (isSkippedKey(key) || keep.has(key)) continue;
      remove.push(key);
    }
  } catch {
    return 0;
  }
  for (const key of remove) storageRemove(key, { silent: true });
  return remove.length;
}

/**
 * 计算当前状态的摘要（用于判断「本机有没有变化」）。
 *
 * 用 FNV-1a 64 位而不是 JSON 明文比较：
 * - 明文会把整份订阅/历史都塞进 `sync-state.json`，体积大且泄露内容；
 * - 32 位哈希在「只改一个字符」的常见场景下碰撞概率可以接受，但 64 位更稳。
 *
 * 键排序保证同一状态得到同一摘要；`extra` 用来把 Rust 侧设置（快捷键 /
 * 自启动）也纳入摘要。
 */
export function stateDigest(extra?: unknown): string {
  const state = collectState();
  const keys = Object.keys(state).sort();
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  const feed = (text: string): void => {
    for (let i = 0; i < text.length; i++) {
      hash ^= BigInt(text.charCodeAt(i));
      hash = (hash * prime) & mask;
    }
  };
  for (const key of keys) {
    feed(key);
    feed("=");
    try {
      feed(JSON.stringify(state[key]));
    } catch {
      feed("null");
    }
    feed("\n");
  }
  if (extra !== undefined) {
    feed("|extra=");
    try {
      feed(JSON.stringify(extra));
    } catch {
      feed("null");
    }
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * 旧版「用户编辑态」指纹（保留导出，兼容仍引用它的调用方）。
 * 新代码统一用 `stateDigest`。
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
