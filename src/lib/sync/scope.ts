/**
 * 同步作用域：一个键到底该不该上云、要不要跟设备走。
 *
 * 为什么需要它
 * ------------
 * v2 是「黑名单式」同步：除了少数凭据/缓存，localStorage 里的键全部上云。
 * 这会把**设备专属**的东西也带过去——插件窗口尺寸、最近附件路径、更新下载偏好，
 * 换设备后互相覆盖，用户看到的是「窗口突然变大」「最近文件指向不存在的盘符」。
 *
 * v3 起统一用三档：
 *   - `account`：用户数据，跨设备同步（主题、订阅、插件数据、收藏/分类…）
 *   - `device`：只属于这台机器（窗口尺寸、最近路径、自启、插件排序…）
 *   - `never`：凭据/可重建缓存/一次性信号，既不进备份也不上云
 *
 * 规则集中在这里，`snapshot.ts` 只负责调用，避免「采集/还原/触发同步」三处口径漂移。
 */

export type SyncScope = "account" | "device" | "never";

/** 永不进备份、不上云、也不触发同步的键（凭据 / 可重建缓存 / 一次性信号） */
const NEVER_KEYS = new Set([
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

/** 永远不碰的运行时缓存前缀（脚本宿主私有存储） */
const NEVER_PREFIXES = ["script:"];

/**
 * 设备专属键：随机器走，不同步。
 * - `RECENT_ATTACH_KEY`：最近附件的**绝对路径**，换机必失效（plugins/attachments.ts）
 * - `auto_download_update`：是否自动下载更新，按机器/网络环境决定（update-settings.ts）
 */
const DEVICE_KEYS = new Set(["RECENT_ATTACH_KEY", "auto_download_update"]);

/**
 * 插件私有数据里的设备专属键后缀。
 * `PLUGIN_DATA:<pluginId>:viewSize` 是插件视图窗口尺寸（plugins/view-size.ts），
 * 跟屏幕分辨率绑定，跨设备同步只会让窗口错位。
 */
const DEVICE_PLUGIN_DATA_SUFFIXES = [":viewSize"];

function isNeverKey(key: string): boolean {
  return NEVER_KEYS.has(key) || NEVER_PREFIXES.some((p) => key.startsWith(p));
}

function isDeviceKey(key: string): boolean {
  if (DEVICE_KEYS.has(key)) return true;
  if (key.startsWith("PLUGIN_DATA:")) {
    return DEVICE_PLUGIN_DATA_SUFFIXES.some((suffix) => key.endsWith(suffix));
  }
  return false;
}

/** 这个键的同步作用域（纯函数，便于单测与面板展示） */
export function scopeOfKey(key: string): SyncScope {
  if (isNeverKey(key)) return "never";
  if (isDeviceKey(key)) return "device";
  return "account";
}

/** 这个 localStorage 键变化是否需要触发云同步（只有 account 才算） */
export function shouldSyncKey(key: string): boolean {
  return scopeOfKey(key) === "account";
}

/** 是否属于「只在本机生效」的键（采集/还原时跳过） */
export function isDeviceScopedKey(key: string): boolean {
  return scopeOfKey(key) === "device";
}

/** 是否属于「绝不能碰」的键 */
export function isNeverScopedKey(key: string): boolean {
  return scopeOfKey(key) === "never";
}

/** 面板/诊断用：把当前规则导出一份可读清单 */
export function describeScope(key: string): { scope: SyncScope; reason: string } {
  const scope = scopeOfKey(key);
  if (scope === "never") {
    return {
      scope,
      reason: NEVER_PREFIXES.some((p) => key.startsWith(p))
        ? "运行时缓存前缀"
        : "凭据 / 可重建缓存 / 一次性信号",
    };
  }
  if (scope === "device") {
    return { scope, reason: "设备专属（窗口尺寸 / 最近路径 / 更新偏好）" };
  }
  return { scope, reason: "用户数据，跨设备同步" };
}

// ===================== 插件注册表里的设备专属记录 =====================
//
// 注册表是**一个** localStorage 键，但其中「开发挂载」记录带着源目录绝对路径
// （`source.dev=true` + `source.ref=<本地路径>`）。源目录只存在于本机，直接同步
// 记录会让新设备指向不存在的目录；但插件文件本身会随 body 片完整打包。
//
// 因此注册表按记录级处理：
//   - 采集/上传：dev 记录**改写为普通安装副本**（`dir=plugins/<id>`、
//     `source.kind=file`）——插件文件本身已随 body 片同步，新设备拿到的是可运行副本；
//   - 还原：把本机的 dev 记录合并回来，同 id 时本机 dev 记录优先；
//   - 对应插件的 `PLUGIN_DATA:*` 仍按设备数据对待（开发目录的数据不跨机）。

/** 一条插件记录是不是「开发挂载」（带本机绝对路径，不应跨设备） */
export function isDevicePluginRecord(record: unknown): boolean {
  if (!record || typeof record !== "object") return false;
  const source = (record as { source?: unknown }).source;
  if (!source || typeof source !== "object") return false;
  const s = source as { dev?: unknown };
  return s.dev === true;
}

/** 注册表里所有设备专属插件的 id（用于过滤对应的 `PLUGIN_DATA:*`） */
export function devicePluginIdsOfRegistry(registry: unknown): Set<string> {
  const out = new Set<string>();
  if (!registry || typeof registry !== "object") return out;
  const plugins = (registry as { plugins?: unknown }).plugins;
  if (!Array.isArray(plugins)) return out;
  for (const rec of plugins) {
    if (!isDevicePluginRecord(rec)) continue;
    const id = (rec as { id?: unknown }).id;
    if (typeof id === "string" && id) out.add(id);
  }
  return out;
}

/**
 * 把一条设备专用记录改写为「云端的普通安装副本」。
 *
 * 开发目录本身不会存在于别的设备，但插件文件已经被 body 片完整打包；
 * 新设备只需要一条指向 `plugins/<id>` 的普通记录即可运行。
 */
export function normalizeDevicePluginRecord(rec: unknown): unknown {
  if (!isDevicePluginRecord(rec)) return rec;
  const r = rec as Record<string, unknown> & { id?: unknown; source?: unknown };
  const id = typeof r.id === "string" ? r.id : "";
  if (!id) return rec;
  const source =
    r.source && typeof r.source === "object" ? { ...(r.source as object) } : {};
  delete (source as { dev?: unknown }).dev;
  return {
    ...r,
    dir: `plugins/${id}`,
    source: { ...source, kind: "file", ref: "dev-mount-sync" },
  };
}

/** 上传/备份用：设备专属记录改写为普通安装副本（没有 dev 记录时原样返回） */
export function registryForSync<T>(registry: T): T {
  if (!registry || typeof registry !== "object") return registry;
  const plugins = (registry as { plugins?: unknown }).plugins;
  if (!Array.isArray(plugins)) return registry;
  let changed = false;
  const normalized = plugins.map((rec) => {
    const next = normalizeDevicePluginRecord(rec);
    if (next !== rec) changed = true;
    return next;
  });
  if (!changed) return registry;
  return { ...(registry as object), plugins: normalized } as T;
}

/**
 * 还原用：以云端注册表为底，把**本机**的 dev 记录合并回去。
 *
 * 同时清掉云端可能残留的 dev 记录（旧版本客户端没有过滤规则时会上传它们）。
 * 同 id 时保留本机记录：路径只有本机才是对的。
 */
export function registryWithLocalDevicePlugins<T>(remote: T, local: unknown): T {
  if (!remote || typeof remote !== "object") return remote;
  const remotePlugins = (remote as { plugins?: unknown }).plugins;
  if (!Array.isArray(remotePlugins)) return remote;

  const localDev = new Map<string, unknown>();
  if (local && typeof local === "object") {
    const lp = (local as { plugins?: unknown }).plugins;
    if (Array.isArray(lp)) {
      for (const rec of lp) {
        if (!isDevicePluginRecord(rec)) continue;
        const id = (rec as { id?: unknown }).id;
        if (typeof id === "string" && id) localDev.set(id, rec);
      }
    }
  }

  const merged: unknown[] = [];
  const seen = new Set<string>();
  for (const rec of remotePlugins) {
    if (isDevicePluginRecord(rec)) continue; // 旧客户端残留
    const id = (rec as { id?: unknown }).id;
    if (typeof id === "string" && localDev.has(id)) {
      // 云端有同 id 的非 dev 记录（可能是市场版），本机 dev 版优先
      merged.push(localDev.get(id));
      seen.add(id);
      continue;
    }
    merged.push(rec);
    if (typeof id === "string") seen.add(id);
  }
  for (const [id, rec] of localDev) {
    if (!seen.has(id)) merged.push(rec);
  }
  return { ...(remote as object), plugins: merged } as T;
}
