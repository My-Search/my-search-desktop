/**
 * 同步内核测试用的内存桩（bridge + snapshot）。
 *
 * 通过 `globalThis.__SYNC_STUB__` 拿到测试文件里的 `calls` / `state`，
 * 这样断言可以直接读调用计数与可编程的远端状态。
 */
const { calls, state } = globalThis.__SYNC_STUB__;

// ===== ./bridge 的导出 =====
export async function syncRemoteMeta() {
  calls.remoteMeta++;
  return {
    exists: state.remoteExists,
    rev: state.remoteExists ? "rev-1" : "",
    modified: state.remoteModified,
    size: state.remoteExists ? 1024 : 0,
  };
}

export async function syncUpload(_path) {
  calls.upload++;
  if (state.uploadThrows) throw new Error(state.uploadThrows);
  return { exists: true, rev: "rev-2", modified: Date.now(), size: 1024 };
}

export async function syncDownload() {
  calls.download++;
  return { path: "/tmp/fake-backup.msbackup", size: 1024 };
}

export async function backupSnapshot(_localStorage, _prefix) {
  calls.snapshot++;
  return "/tmp/fake-snapshot.msbackup";
}

export async function backupRestore(path, categories) {
  calls.restore.push({ path, categories });
  return {
    snapshotPath: "/tmp/prev.msbackup",
    localStorageKeys: 1,
    plugins: 0,
    pluginData: 0,
    settings: false,
    localStorage: { subscribes: [] },
    manifest: {},
  };
}

// engine.ts 里 import 了但本测试路径用不到的（保持导出形状一致）
export async function backupExport() {
  throw new Error("not stubbed");
}
export async function backupInspect() {
  throw new Error("not stubbed");
}

// ===== ./snapshot 的导出 =====
export function collectState() {
  return { subscribes: [] };
}
export function restoreState(_data) {
  return 0;
}
export function fingerprint() {
  return "fp";
}
export function settingsFingerprint() {
  return "sfp";
}
