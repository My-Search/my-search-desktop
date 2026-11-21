/**
 * 同步内核测试用的内存桩（bridge + snapshot）。
 *
 * 通过 `globalThis.__SYNC_STUB__` 拿到测试文件里的 `calls` / `state`，
 * 这样断言可以直接读调用参数与可编程的远端状态。
 *
 * 注意：引擎的持久化状态不再放在这里——它由测试通过 `getState/patchState`
 * 注入，与真实调用方（SyncHost）保持一致。
 */
const { calls, state } = globalThis.__SYNC_STUB__;

function revOf() {
  return state.remoteRev || "rev-1";
}

// ===== ./bridge 的导出 =====
export async function syncRemoteMeta() {
  calls.remoteMeta++;
  const rev = revOf();
  return {
    exists: state.remoteExists,
    rev: state.remoteExists ? rev : "",
    etag: state.remoteExists ? `"${rev}"` : "",
    modified: state.remoteModified,
    size: state.remoteExists ? 1024 : 0,
  };
}

export async function syncUpload(_path, ifMatch) {
  calls.upload++;
  calls.uploadIfMatch.push(ifMatch);
  if (state.uploadThrows) throw new Error(state.uploadThrows);
  if (state.uploadConflict > 0) {
    state.uploadConflict--;
    // 模拟「读元信息 → PUT」之间别的设备改了远端：下一次 HEAD 会看到新版本
    if (state.conflictRev) state.remoteRev = state.conflictRev;
    throw new Error("SYNC_CONFLICT: 远端备份已被其他设备修改");
  }
  const rev = state.nextRev || "rev-uploaded";
  return {
    exists: true,
    rev,
    etag: `"${rev}"`,
    modified: state.remoteModified || Date.now(),
    size: 1024,
  };
}

export async function syncDownload(knownEtag) {
  calls.download++;
  calls.downloadEtag.push(knownEtag);
  const rev = revOf();
  if (state.downloadNotModified) {
    return {
      path: "",
      size: 0,
      rev,
      etag: `"${rev}"`,
      modified: 0,
      notModified: true,
    };
  }
  return {
    path: "/tmp/fake-backup.msbackup",
    size: 1024,
    rev,
    etag: `"${rev}"`,
    modified: state.remoteModified,
    notModified: false,
  };
}

export async function syncCommitApplied(source, scope = "all") {
  calls.commit++;
  calls.commitSources.push(source);
  calls.commitScopes.push(scope);
  return 1;
}

export async function backupSnapshot(_localStorage, _prefix) {
  calls.snapshot++;
  return "/tmp/fake-snapshot.msbackup";
}

export async function backupRestore(path, categories, localStorage) {
  calls.restore.push({ path, categories, localStorage });
  return {
    snapshotPath: "/tmp/prev.msbackup",
    localStorageKeys: 1,
    plugins: 0,
    pluginData: 0,
    settings: false,
    scope: "all",
    localStorage: { subscribes: ["from-remote"] },
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
  return { subscribes: ["local"] };
}

/** 「覆盖前留底」用的本机完整快照：与 collectState 同源（设备专属键的差异由真实实现负责，桩内不区分） */
export function collectBackupState() {
  return collectState();
}

export function restoreState(data, opts) {
  calls.restoreState.push({ data, options: opts });
  return Object.keys(data).length;
}

export function pruneState(data) {
  calls.prune.push(data);
  return 0;
}

export function stateDigest(_extra) {
  calls.digest++;
  calls.digestExtras.push(_extra);
  return state.localDigest;
}
