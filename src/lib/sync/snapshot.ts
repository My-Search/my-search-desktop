/**
 * 快照采集与还原 —— 将所有用户数据（localStorage + 插件注册表 + 插件数据）
 * 汇集为一个 JSON 对象，交给 Rust 侧打包成 .msbackup 归档。
 *
 * 职责边界：
 *   - 采集：读 localStorage 里的 **account 作用域** 键（**包含** `PLUGIN_DATA:*`）
 *   - 还原：把归档里的 localStorage 快照静默写回（跳过凭据、可重建缓存与设备专属键）
 *   - 摘要：给同步决策判断「本机到底变没变」
 *
 * 作用域口径统一在 `scope.ts`：
 *   - `account`：跨设备同步（订阅、插件数据、主题…）
 *   - `device`：只在本机生效（最近附件路径、插件窗口尺寸、更新下载偏好…）
 *   - `never`：凭据 / 可重建缓存 / 一次性信号
 *
 * 为什么包含 `PLUGIN_DATA:*`
 * --------------------------
 * 插件私有数据有两套存储：无后端插件写在 localStorage 的 `PLUGIN_DATA:*`，
 * 有后端插件写在 Rust 侧 `plugin-data/`。旧实现把前端这套排除在同步之外，
 * 导致换机/重装后无后端插件的数据全部丢失。现在两套都进备份、都能触发同步。
 */

import { storageGet, storageSet, storageRemove } from "../util";
import { PLUGIN_REGISTRY_KEY, keepLocalRecordsAfterRestore } from "../plugins/registry";
import {
  devicePluginIdsOfRegistry,
  registryForSync,
  registryWithLocalDevicePlugins,
  scopeOfKey,
  shouldSyncKey as scopeShouldSyncKey,
} from "./scope";

const STORAGE_PREFIX = "my-search-desktop:";

/** 从 `PLUGIN_DATA:<id>:<key>` 取出插件 id（不是插件数据键时返回空串） */
function pluginIdOfDataKey(key: string): string {
  if (!key.startsWith("PLUGIN_DATA:")) return "";
  const rest = key.slice("PLUGIN_DATA:".length);
  const sep = rest.indexOf(":");
  return sep > 0 ? rest.slice(0, sep) : "";
}

/** 读取本机注册表（解析失败按空表处理） */
function localRegistry(): unknown {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + PLUGIN_REGISTRY_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * 这个 localStorage 键变化是否需要触发云同步。
 *
 * 同步宿主用它过滤 `storageSet` 钩子：内部缓存/凭据/设备专属键变化不该造成
 * 网络请求，也不该让「还原时写回」被误判成本机改动（还原本身走 silent）。
 */
export function shouldSyncKey(key: string): boolean {
  return scopeShouldSyncKey(key);
}

/** 这个键是否应进入快照（account 作用域） */
function isAccountKey(key: string): boolean {
  return scopeOfKey(key) === "account";
}

/** 采集本地 localStorage 快照（返回一个扁平键值对对象） */
export function collectState(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  try {
    const prefix = STORAGE_PREFIX;
    const registry = localRegistry();
    // 开发挂载插件的私有数据跟着「本机源目录」走，跨设备没有意义
    const devicePluginIds = devicePluginIdsOfRegistry(registry);
    for (let i = 0; i < localStorage.length; i++) {
      const full = localStorage.key(i);
      if (!full || !full.startsWith(prefix)) continue;
      const key = full.slice(prefix.length);
      if (!isAccountKey(key)) continue;
      const dataPluginId = pluginIdOfDataKey(key);
      if (dataPluginId && devicePluginIds.has(dataPluginId)) continue;
      try {
        const parsed = JSON.parse(localStorage.getItem(full)!);
        out[key] = key === PLUGIN_REGISTRY_KEY ? registryForSync(parsed) : parsed;
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
 * 采集**本机完整**快照：给「覆盖前留底」用。
 *
 * 与 `collectState` 的区别：设备专属键（最近附件、窗口尺寸…）与注册表原始
 * dev 记录都保留——这份归档只用于本机回滚，不参与跨设备同步；把 dev 记录
 * 改写成普通副本反而会让回滚后的本机开发挂载失效。
 */
export function collectBackupState(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  try {
    const prefix = STORAGE_PREFIX;
    for (let i = 0; i < localStorage.length; i++) {
      const full = localStorage.key(i);
      if (!full || !full.startsWith(prefix)) continue;
      const key = full.slice(prefix.length);
      if (scopeOfKey(key) === "never") continue;
      try {
        out[key] = JSON.parse(localStorage.getItem(full)!);
      } catch {
        out[key] = localStorage.getItem(full);
      }
    }
  } catch (e) {
    console.warn("[同步] 采集本机快照失败:", e);
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
  const local = localRegistry();
  const devicePluginIds = devicePluginIdsOfRegistry(local);
  for (const [key, value] of Object.entries(payload)) {
    if (!isAccountKey(key)) continue;
    const dataPluginId = pluginIdOfDataKey(key);
    if (dataPluginId && devicePluginIds.has(dataPluginId)) continue;
    const next =
      key === PLUGIN_REGISTRY_KEY ? registryWithLocalDevicePlugins(value, local) : value;
    storageSet(key, next, { silent });
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
    const prefix = STORAGE_PREFIX;
    const devicePluginIds = devicePluginIdsOfRegistry(localRegistry());
    for (let i = 0; i < localStorage.length; i++) {
      const full = localStorage.key(i);
      if (!full || !full.startsWith(prefix)) continue;
      const key = full.slice(prefix.length);
      if (!isAccountKey(key) || keep.has(key)) continue;
      // 开发挂载插件的私有数据是设备数据：云端没有不代表要删
      if (devicePluginIds.has(pluginIdOfDataKey(key))) continue;
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
 * 把 localStorage 快照按 v2 分片切开。
 *
 * - `PLUGIN_DATA:<id>:<key>` → 该插件的「数据分片」
 * - 其它键（含插件注册表）→ 「内核分片」
 *
 * 为什么要切：v2 云端是「按插件分片 + manifest 提交点」，同步只为变脏的分片
 * 付带宽。切片放在前端，是因为只有前端知道「哪些键属于哪个插件」；Rust 只按
 * 给定的子集算摘要、打包、上传。
 */
export function splitStateByShard(state: Record<string, unknown> = collectState()): {
  core: Record<string, unknown>;
  plugins: Record<string, Record<string, unknown>>;
} {
  const core: Record<string, unknown> = {};
  const plugins: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(state)) {
    if (key.startsWith("PLUGIN_DATA:")) {
      const rest = key.slice("PLUGIN_DATA:".length);
      const sep = rest.indexOf(":");
      if (sep > 0) {
        const id = rest.slice(0, sep);
        (plugins[id] ??= {})[key] = value;
        continue;
      }
    }
    core[key] = value;
  }
  return { core, plugins };
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
