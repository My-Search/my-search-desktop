/**
 * 备份与同步的 IPC 桥梁 —— 对接 Rust 侧 backup.rs + cloud.rs 的命令。
 */
import { invoke } from "@tauri-apps/api/core";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// ===================== 配置 / 凭据 =====================

export interface SyncConfig {
  enabled: boolean;
  webdavUrl: string;
  webdavUser: string;
  remoteFile: string;
  conflict: "newer" | "local" | "remote" | "ask";
  autoOnChange: boolean;
  intervalMinutes: number;
  /** 只读：是否已保存密码 */
  hasPassword: boolean;
  /** 云端格式：2 = v2 分片；3 = v3 每文件对象（缺省按 2 兼容旧测试/旧调用） */
  cloudFormat?: number;
}

/** 读同步配置 */
export async function syncGetConfig(): Promise<SyncConfig> {
  if (!isTauri) return fallbackConfig();
  return await invoke<SyncConfig>("sync_get_config");
}

/** 写同步配置 */
export async function syncSetConfig(
  config: Partial<Omit<SyncConfig, "hasPassword">>,
  password?: string
): Promise<SyncConfig> {
  if (!isTauri) return fallbackConfig();
  return await invoke<SyncConfig>("sync_set_config", {
    config,
    password: password ?? null,
  });
}

/** 清空密码 */
export async function syncClearCredentials(): Promise<SyncConfig> {
  if (!isTauri) return fallbackConfig();
  return await invoke<SyncConfig>("sync_clear_credentials");
}

/** 一个待用户裁决的分片冲突（插件级隔离：只挂起这一片，其它插件照常同步） */
export interface SyncConflictShard {
  /** 插件 id；`core`（软件主体配置）冲突时为空串 */
  pluginId: string;
  kind: "core" | "body" | "data";
  /** 冲突文件相对路径（v3 文件级冲突；v2 冲突没有） */
  path?: string;
  /** 两侧体积，便于用户在面板上判断 */
  localBytes?: number;
  remoteBytes?: number;
  remoteUpdatedAt?: number;
}

/** 同步的持久化状态（Rust 侧 `sync-state.json` 的只读镜像） */
export interface SyncPersistedState {
  deviceId: string;
  /** 本机可读名（电脑名；仅用于面板展示「哪台设备最后同步」） */
  deviceName: string;
  target: string;
  initialized: boolean;
  remoteRev: string;
  /**
   * 上次见到的远端原始 ETag（含引号）。
   * 上传时作为 `If-Match`，下载时作为 `If-None-Match`；无 ETag 时为空串。
   */
  remoteEtag: string;
  /** 上次成功同步时本机快照摘要 */
  lastLocalDigest: string;
  lastSyncAt: number;
  /** 最近一次已应用的远端版本 */
  appliedRev: string;
  /** 还原代次（每次应用还原后自增） */
  epoch: number;
  /** 云同步格式：0 = 未确定（旧 v1 整包），2 = v2 分片 */
  cloudFormat?: number;
  /** v2：上次见到的云端 manifest 原始 ETag（含引号） */
  manifestEtag?: string;
  /** v2：分片同步基线（见 `ShardsBaseline`） */
  shards?: ShardsBaseline | null;
  /** v2：远端已有、本机尚未下载的插件数据分片 `{pluginId: digest}` */
  pending?: Record<string, string> | null;
  /** v2：等待用户裁决的冲突片（插件级隔离，其它片已照常同步） */
  conflicts?: SyncConflictShard[] | null;
  /** v3：每文件同步基线（远端 manifest 对齐后的摘要集合） */
  v3?: V3Baseline | null;
}

/** v3 单插件基线 */
export interface V3PluginBaseline {
  body: string;
  /** 上次对齐的插件 localStorage 子集（用于判断本机/远端谁变了） */
  state?: Record<string, unknown>;
  files: Record<string, string>;
  blobs: Record<string, string>;
}

/** v3 全量基线 */
export interface V3Baseline {
  core: string;
  plugins: Record<string, V3PluginBaseline>;
}

/** v2 分片同步基线：每片记「上次与本机对齐的摘要」 */
export interface ShardsBaseline {
  core: string;
  plugins: Record<string, { body: string; data: string }>;
}

function fallbackState(): SyncPersistedState {
  return {
    deviceId: "",
    deviceName: "",
    target: "",
    initialized: false,
    remoteRev: "",
    remoteEtag: "",
    lastLocalDigest: "",
    lastSyncAt: 0,
    appliedRev: "",
    epoch: 1,
    cloudFormat: 0,
    manifestEtag: "",
    shards: null,
    pending: null,
    conflicts: [],
    v3: null,
  };
}

/** 读同步持久化状态 */
export async function syncStateGet(): Promise<SyncPersistedState> {
  if (!isTauri) return fallbackState();
  return await invoke<SyncPersistedState>("sync_state_get");
}

/** 局部更新同步持久化状态（只允许白名单字段） */
export async function syncStatePatch(
  patch: Partial<
    Pick<
      SyncPersistedState,
      | "initialized"
      | "remoteRev"
      | "remoteEtag"
      | "lastLocalDigest"
      | "lastSyncAt"
      | "appliedRev"
      | "cloudFormat"
      | "manifestEtag"
    >
  > & {
    shards?: ShardsBaseline | null;
    pending?: Record<string, string> | null;
    conflicts?: SyncConflictShard[] | null;
    v3?: V3Baseline | null;
  }
): Promise<SyncPersistedState> {
  if (!isTauri) return fallbackState();
  return await invoke<SyncPersistedState>("sync_state_patch", { patch });
}

/** 重置远端同步基线（保留设备 id） */
export async function syncStateReset(): Promise<SyncPersistedState> {
  if (!isTauri) return fallbackState();
  return await invoke<SyncPersistedState>("sync_state_reset");
}

/**
 * 本机「可同步落盘数据」的指纹（插件安装文件 / 插件私有数据 / 内部状态）。
 *
 * 与 localStorage + Rust 设置的摘要一起参与「本机变没变」的判定：插件私有数据
 * （剪贴板索引、待办、AI 会话…）与插件文件不在 localStorage 里，只靠前端摘要会
 * 出现「插件数据变了却判定本机没变 → 跳过上传」。
 */
export async function syncDataDigest(): Promise<string> {
  if (!isTauri) return "";
  return await invoke<string>("sync_data_digest");
}

/**
 * 请求常驻主窗口执行一轮同步（设置窗口不自己跑引擎）。
 * 执行结果通过 `sync://status` 广播回来。
 */
export async function syncRequest(trigger = "manual"): Promise<void> {
  if (!isTauri) return;
  await invoke("sync_request", { trigger });
}

/**
 * 用户对首次连接 / 冲突的选择。
 *
 * `pluginIds` 省略 = 全局选择（首次连接、或「全部按这个来」）；给定则只对这几个插件
 * 生效（`""` 表示 core / 软件主体配置），其它插件的冲突继续挂起、互不影响。
 */
export async function syncResolveChoice(
  choice: "local" | "remote",
  pluginIds?: string[]
): Promise<void> {
  if (!isTauri) return;
  await invoke("sync_resolve_choice", { choice, pluginIds: pluginIds ?? null });
}

/**
 * 一次还原影响到的资源范围（`sync://applied` 的 `scope`）。
 *
 * - `all`：插件文件/数据 + 用户配置都变了 → 插件必须重载
 * - `plugins`：只有插件相关数据变了
 * - `config`：只有用户配置/Rust 设置变了 → 不打断插件，只需重应用主题
 */
export type SyncAppliedScope = "all" | "plugins" | "config";

/**
 * 提交一次「还原已应用」：Rust 递增 epoch 并广播 `sync://applied`，
 * 所有窗口据此按 `scope` 决定重载插件 / 重应用主题 / 刷新界面。
 */
export async function syncCommitApplied(
  source = "import",
  scope: SyncAppliedScope = "all"
): Promise<number> {
  if (!isTauri) return 0;
  const r = await invoke<{ epoch: number }>("sync_commit_applied", { source, scope });
  return r?.epoch ?? 0;
}

function fallbackConfig(): SyncConfig {
  return {
    enabled: false,
    webdavUrl: "",
    webdavUser: "",
    remoteFile: "my-search-backup.msbackup",
    conflict: "newer",
    autoOnChange: true,
    intervalMinutes: 30,
    hasPassword: false,
    cloudFormat: 3,
  };
}

// ===================== 远端操作 =====================

export interface RemoteMeta {
  exists: boolean;
  /** 稳定版本令牌（无 ETag 时是 `size-modified` 兜底） */
  rev: string;
  /** 原始 ETag（含引号），用于条件请求 */
  etag: string;
  modified: number;
  size: number;
}

export interface DownloadResult {
  path: string;
  size: number;
  rev: string;
  etag: string;
  modified: number;
  /** 远端版本与 `knownEtag` 一致（HTTP 304），没有落盘 */
  notModified: boolean;
}

export async function syncRemoteMeta(): Promise<RemoteMeta> {
  if (!isTauri) throw new Error("仅在桌面端可用");
  return await invoke<RemoteMeta>("sync_remote_meta");
}

export async function syncTest(): Promise<{ ok: boolean; message: string }> {
  if (!isTauri) throw new Error("仅在桌面端可用");
  return await invoke<{ ok: boolean; message: string }>("sync_test");
}

/**
 * 上传备份。
 *
 * `ifMatch` 三种语义：
 * - `""`：只在远端不存在时创建（`If-None-Match: *`）
 * - 非空：条件更新（`If-Match`），远端变了返回 412 → 抛 `SYNC_CONFLICT:`
 * - `null` / 不传：无条件覆盖（只在用户明确选择「本机覆盖远端」时用）
 */
export async function syncUpload(
  path: string,
  ifMatch?: string | null
): Promise<RemoteMeta> {
  if (!isTauri) throw new Error("仅在桌面端可用");
  return await invoke<RemoteMeta>("sync_upload", { path, ifMatch: ifMatch ?? null });
}

/**
 * 下载远端备份到本机备份目录。
 * `knownEtag` 非空时走条件请求，远端没变返回 `notModified: true`。
 */
export async function syncDownload(knownEtag?: string | null): Promise<DownloadResult> {
  if (!isTauri) throw new Error("仅在桌面端可用");
  return await invoke<DownloadResult>("sync_download", { knownEtag: knownEtag ?? null });
}

// ===================== 云同步 v2（分片对象 + manifest） =====================

export interface CloudShardInfo {
  digest: string;
  bytes: number;
  files: number;
}

export interface CloudDigests {
  core: CloudShardInfo;
  plugins: Record<string, { body: CloudShardInfo; data: CloudShardInfo }>;
  appVersion: string;
  at: number;
}

export interface CloudShardRef {
  digest: string;
  bytes: number;
  updatedAt: number;
}

export interface CloudDeviceInfo {
  /** 电脑名；旧 manifest 可能没有 */
  name?: string;
  appVersion?: string;
  /** 这台设备最后一次提交 manifest 的时间 */
  lastSyncAt: number;
}

export interface CloudManifest {
  schema: "ms.cloud/2";
  rev: number;
  updatedAt: number;
  updatedBy: string;
  appVersion: string;
  /**
   * 设备表：只用于展示「哪台设备最后同步」，**不参与冲突判定**。
   * 旧客户端不写这个字段，读取时按空表兼容。
   */
  devices?: Record<string, CloudDeviceInfo>;
  core: CloudShardRef;
  plugins: Record<
    string,
    { body?: CloudShardRef; data?: CloudShardRef; pluginVersion?: string }
  >;
}

export interface CloudManifestResult {
  exists: boolean;
  etag?: string;
  rev?: string;
  size?: number;
  modified?: number;
  manifest: CloudManifest | null;
}

/** 读云端提交点 manifest（不存在时 `exists:false`，不报错） */
export async function cloudManifestGet(): Promise<CloudManifestResult> {
  if (!isTauri) throw new Error("仅在桌面端可用");
  return await invoke<CloudManifestResult>("cloud_manifest_get");
}

/** 写 manifest（提交点）。`ifMatch` 为空串 = 仅创建，非空 = 条件更新（412 → `SYNC_CONFLICT`） */
export async function cloudManifestPut(
  manifest: CloudManifest,
  ifMatch?: string | null
): Promise<{ ok: boolean; etag: string; rev: string; size: number; modified: number }> {
  if (!isTauri) throw new Error("仅在桌面端可用");
  return await invoke("cloud_manifest_put", { manifest, ifMatch: ifMatch ?? null });
}

// ===================== v3：manifest-v3 + 每文件对象 + blob =====================

export interface V3HistoryEntry {
  digest: string;
  bytes: number;
  device?: string;
  ts?: number;
}

export interface V3FileRef {
  digest: string;
  bytes: number;
  updatedAt?: number;
  /** ≤2KB 的 UTF-8 文本直接内联，不产生对象 */
  inline?: string;
  /** 旧版本引用（不参与裁决，至少保证对象不被 manifest 遗忘） */
  history?: V3HistoryEntry[];
}

export interface V3BlobRef {
  digest: string;
  bytes: number;
  updatedAt?: number;
}

export interface V3PluginManifest {
  body?: CloudShardRef;
  state?: Record<string, unknown>;
  files?: Record<string, V3FileRef>;
  blobs?: Record<string, V3BlobRef>;
}

export interface CloudManifestV3 {
  schema: "ms.cloud/3";
  rev: number;
  updatedAt: number;
  updatedBy: string;
  appVersion: string;
  devices?: Record<string, CloudDeviceInfo>;
  core?: CloudShardRef;
  plugins: Record<string, V3PluginManifest>;
  /** v2 迁移时留下的旧提交点信息（只用于提示/回滚，不参与同步） */
  legacyV2?: { rev: number; etag?: string; updatedAt?: number; migratedAt: number } | null;
}

export interface CloudManifestV3Result {
  exists: boolean;
  etag?: string;
  rev?: string;
  size?: number;
  modified?: number;
  manifest: CloudManifestV3 | null;
}

export async function cloudManifestV3Get(): Promise<CloudManifestV3Result> {
  if (!isTauri) throw new Error("仅在桌面端可用");
  return await invoke<CloudManifestV3Result>("cloud_manifest_v3_get");
}

export async function cloudManifestV3Put(
  manifest: CloudManifestV3,
  ifMatch?: string | null
): Promise<{ ok: boolean; etag: string; rev: string; size: number; modified: number }> {
  if (!isTauri) throw new Error("仅在桌面端可用");
  return await invoke("cloud_manifest_v3_put", { manifest, ifMatch: ifMatch ?? null });
}

export interface V3LocalFile {
  path: string;
  digest: string;
  bytes: number;
  inline?: string;
}

export interface V3LocalPlugin {
  body: CloudShardInfo;
  state: Record<string, unknown>;
  files: V3LocalFile[];
  blobs: V3LocalFile[];
}

export interface V3Scan {
  core: CloudShardInfo;
  plugins: Record<string, V3LocalPlugin>;
  appVersion: string;
  at: number;
}

/** 扫描本机 v3 快照（不联网）：core/body 摘要 + 每文件摘要 + 内联 + blob。 */
export async function cloudV3Scan(
  localStorage: { core: Record<string, unknown>; plugins: Record<string, Record<string, unknown>> }
): Promise<V3Scan> {
  if (!isTauri) throw new Error("仅在桌面端可用");
  return await invoke<V3Scan>("cloud_v3_scan", { localStorage });
}

/** 上传单个文件对象；虚拟条目（itemized）由 Rust 从源索引取当前条目。 */
export async function cloudV3FilePut(
  pluginId: string,
  rel: string
): Promise<{ rel: string; path: string; digest: string; bytes: number; uploaded: boolean }> {
  if (!isTauri) throw new Error("仅在桌面端可用");
  return await invoke("cloud_v3_file_put", { pluginId, rel });
}

/** 下载/内联写入单个文件；虚拟条目会合并回源索引。 */
export async function cloudV3FileGet(
  pluginId: string,
  rel: string,
  digest: string,
  inlineText?: string
): Promise<{ path: string; bytes: number; virtual?: boolean; id?: string }> {
  if (!isTauri) throw new Error("仅在桌面端可用");
  return await invoke("cloud_v3_file_get", {
    pluginId,
    rel,
    digest,
    inlineText: inlineText ?? null,
  });
}

export async function cloudV3FileDelete(
  pluginId: string,
  rel: string
): Promise<{ removed: boolean; virtual?: boolean }> {
  if (!isTauri) throw new Error("仅在桌面端可用");
  return await invoke("cloud_v3_file_delete", { pluginId, rel });
}

/** 上传图片/二进制 blob（内容寻址，跨插件去重）。 */
export async function cloudV3BlobPut(
  pluginId: string,
  rel: string
): Promise<{ rel: string; path: string; digest: string; bytes: number; uploaded: boolean }> {
  if (!isTauri) throw new Error("仅在桌面端可用");
  return await invoke("cloud_v3_blob_put", { pluginId, rel });
}

export async function cloudV3BlobGet(
  pluginId: string,
  rel: string,
  digest: string
): Promise<{ path: string; bytes: number; digest: string }> {
  if (!isTauri) throw new Error("仅在桌面端可用");
  return await invoke("cloud_v3_blob_get", { pluginId, rel, digest });
}

/** 计算本机各分片摘要（不联网；切片由前端按插件归属完成） */
export async function cloudDigests(
  localStorage: { core: Record<string, unknown>; plugins: Record<string, Record<string, unknown>> }
): Promise<CloudDigests> {
  if (!isTauri) throw new Error("仅在桌面端可用");
  return await invoke<CloudDigests>("cloud_digests", { localStorage });
}

/** 打包并上传一个分片（`core` / `body:<id>` / `data:<id>`），已存在则跳过 */
export async function cloudShardPut(
  scope: string,
  localStorage: Record<string, unknown>
): Promise<{ rel: string; digest: string; bytes: number; uploaded: boolean; pluginId: string }> {
  if (!isTauri) throw new Error("仅在桌面端可用");
  return await invoke("cloud_shard_put", { scope, localStorage });
}

/** 下载一个分片到备份目录，返回可交给 `backupRestore` 的路径 */
export async function cloudShardGet(
  rel: string
): Promise<{ path: string; bytes: number; rev: string; etag: string; rel: string }> {
  if (!isTauri) throw new Error("仅在桌面端可用");
  return await invoke("cloud_shard_get", { rel });
}

/** 删除云端对象（清空插件云端数据 / GC） */
export async function cloudObjectDelete(rel: string): Promise<{ rel: string; removed: boolean }> {
  if (!isTauri) throw new Error("仅在桌面端可用");
  return await invoke("cloud_object_delete", { rel });
}

/** 分片内的具体条目（面板「查看云端内容」按需调用） */
export interface CloudShardInspect {
  rel: string;
  bytes: number;
  totalBytes: number;
  entries: Array<{ name: string; size: number }>;
  truncated: boolean;
}

export async function cloudShardInspect(rel: string): Promise<CloudShardInspect> {
  if (!isTauri) throw new Error("仅在桌面端可用");
  return await invoke<CloudShardInspect>("cloud_shard_inspect", { rel });
}

/** 云端配额常量（单插件 / 单分片上限，字节） */
export async function cloudQuota(): Promise<{ pluginBytes: number; shardBytes: number }> {
  if (!isTauri) return { pluginBytes: 200 * 1024 * 1024, shardBytes: 200 * 1024 * 1024 };
  return await invoke("cloud_quota");
}

// ===================== 导出 / 导入 / 还原 =====================

export async function backupExport(
  localStorage: Record<string, unknown>,
  toDownloads?: boolean
): Promise<{ path: string; exported: string; size: number }> {
  if (!isTauri) throw new Error("仅在桌面端可用");
  return await invoke("backup_export", {
    localStorage,
    toDownloads: toDownloads ?? null,
  });
}

export async function backupSnapshot(
  localStorage: Record<string, unknown>,
  prefix?: string
): Promise<string> {
  if (!isTauri) throw new Error("仅在桌面端可用");
  return await invoke<string>("backup_snapshot", {
    localStorage,
    prefix: prefix ?? null,
  });
}

export async function backupExportAs(
  localStorage: Record<string, unknown>,
  path: string
): Promise<{ path: string; size: number }> {
  if (!isTauri) throw new Error("仅在桌面端可用");
  return await invoke("backup_export_as", { localStorage, path });
}

export interface BackupInspect {
  ok: boolean;
  manifest: Record<string, unknown>;
  formatVersion: number;
  exportedAt: number;
  appVersion: string;
  localStorageKeys: number;
  pluginIds: string[];
  pluginFiles: number;
  pluginDataFiles: number;
  /** 插件云数据 store 文件数（`sync-store/<id>.json`，`ms.store.sync.*` 写入） */
  syncStoreFiles: number;
  hasSettings: boolean;
  hasPlugins: boolean;
  hasPluginData: boolean;
  hasSyncStore: boolean;
  totalBytes: number;
}

export async function backupInspect(path: string): Promise<BackupInspect> {
  if (!isTauri) throw new Error("仅在桌面端可用");
  return await invoke<BackupInspect>("backup_inspect", { path });
}

export interface RestoreReport {
  snapshotPath: string | null;
  localStorageKeys: number;
  plugins: number;
  pluginData: number;
  settings: boolean;
  /** Rust 按实际分类判定的广播作用域 */
  scope: SyncAppliedScope;
  /**
   * 被「版本守卫」跳过的插件 id：这些插件本机版本高于归档版本，还原时
   * **保留本机文件与数据**（拒绝降级）。前端据此保留本机注册表记录，
   * 保证版本号与磁盘代码一致。
   */
  downgradeSkipped: string[];
  localStorage: Record<string, unknown>;
  manifest: Record<string, unknown>;
}

export async function backupRestore(
  path: string,
  categories?: string[],
  localStorage?: Record<string, unknown>
): Promise<RestoreReport> {
  if (!isTauri) throw new Error("仅在桌面端可用");
  return await invoke<RestoreReport>("backup_restore", {
    path,
    categories: categories ?? null,
    localStorage: localStorage ?? null,
  });
}

/**
 * 还原**单个插件主体分片**（云同步 v2）：只替换 `plugins/<id>/`。
 * 与 `backupRestore(["plugins"])` 的区别：后者是整个插件目录交换。
 */
export async function backupRestorePluginShard(
  path: string,
  pluginId: string
): Promise<{ pluginId: string; files: number; skipped: boolean }> {
  if (!isTauri) throw new Error("仅在桌面端可用");
  return await invoke("backup_restore_plugin_shard", { path, pluginId });
}

export async function backupDir(): Promise<string> {
  if (!isTauri) return "";
  return await invoke<string>("backup_dir");
}

export async function backupOpenDir(): Promise<void> {
  if (!isTauri) return;
  await invoke("backup_open_dir");
}

export async function pickBackupFile(): Promise<string | null> {
  if (!isTauri) return null;
  try {
    const pkg: any = await import("@tauri-apps/plugin-dialog");
    const picked = await pkg.open({
      multiple: false,
      title: "选择备份归档",
      filters: [{ name: "备份归档", extensions: ["msbackup"] }],
    });
    return typeof picked === "string" ? picked : null;
  } catch (e) {
    console.warn("文件选择对话框不可用:", e);
    return null;
  }
}

export async function saveBackupPath(defaultName?: string): Promise<string | null> {
  if (!isTauri) return null;
  try {
    const pkg: any = await import("@tauri-apps/plugin-dialog");
    const picked = await pkg.save({
      title: "导出备份",
      defaultPath: defaultName ?? "my-search-backup.msbackup",
      filters: [{ name: "备份归档", extensions: ["msbackup"] }],
    });
    return typeof picked === "string" ? picked : null;
  } catch (e) {
    console.warn("保存对话框不可过:", e);
    return null;
  }
}