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

/** 同步的持久化状态（Rust 侧 `sync-state.json` 的只读镜像） */
export interface SyncPersistedState {
  deviceId: string;
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
}

function fallbackState(): SyncPersistedState {
  return {
    deviceId: "",
    target: "",
    initialized: false,
    remoteRev: "",
    remoteEtag: "",
    lastLocalDigest: "",
    lastSyncAt: 0,
    appliedRev: "",
    epoch: 1,
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
      "initialized" | "remoteRev" | "remoteEtag" | "lastLocalDigest" | "lastSyncAt" | "appliedRev"
    >
  >
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

/** 用户对首次连接/冲突的选择：本机覆盖远端 / 远端覆盖本机 */
export async function syncResolveChoice(choice: "local" | "remote"): Promise<void> {
  if (!isTauri) return;
  await invoke("sync_resolve_choice", { choice });
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
  hasSettings: boolean;
  hasPlugins: boolean;
  hasPluginData: boolean;
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