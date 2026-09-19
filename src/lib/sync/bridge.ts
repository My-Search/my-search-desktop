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
  rev: string;
  modified: number;
  size: number;
}

export async function syncRemoteMeta(): Promise<RemoteMeta> {
  if (!isTauri) throw new Error("仅在桌面端可用");
  return await invoke<RemoteMeta>("sync_remote_meta");
}

export async function syncTest(): Promise<{ ok: boolean; message: string }> {
  if (!isTauri) throw new Error("仅在桌面端可用");
  return await invoke<{ ok: boolean; message: string }>("sync_test");
}

export async function syncUpload(path: string): Promise<RemoteMeta> {
  if (!isTauri) throw new Error("仅在桌面端可用");
  return await invoke<RemoteMeta>("sync_upload", { path });
}

export async function syncDownload(): Promise<{ path: string; size: number }> {
  if (!isTauri) throw new Error("仅在桌面端可用");
  return await invoke<{ path: string; size: number }>("sync_download");
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
  localStorage: Record<string, unknown>;
  manifest: Record<string, unknown>;
}

export async function backupRestore(
  path: string,
  categories?: string[]
): Promise<RestoreReport> {
  if (!isTauri) throw new Error("仅在桌面端可用");
  return await invoke<RestoreReport>("backup_restore", {
    path,
    categories: categories ?? null,
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