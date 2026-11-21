/**
 * 云同步 v3 —— **manifest-v3 提交点 + 每文件对象 + 内联 + blob**
 *
 * 为什么单独一层
 * --------------
 * v2 的 `data` 片是「一个插件一整片」：剪贴板加一条记录就要重传 354KB，
 * 且旧对象没有 GC，云端会随复制次数线性膨胀。v3 把插件数据降到文件级：
 *
 * - core / body 仍复用 v2 的对象（按摘要命名，迁移时无需重传）；
 * - 插件数据每个文件一个对象 `plugins/<id>/files/<pathHash>-<digest>.msf`；
 * - ≤2KB 的 UTF-8 文本直接内联进 manifest，改一条只写 manifest；
 * - 图片走 `blobs/<sha256>` 全局内容寻址；
 * - 剪贴板的 `clipboard/index.json` 由 Rust 按 `plugin.json.backup.itemized`
 *   虚拟拆成 `clipboard/items/<id>.json`，加一条只上传一条（或只写内联）。
 *
 * 这一版**不铺**多 leaf / 行级 diff / tombstone 的完整 UI；遇到双边改动就挂起，
 * 交给现有「按插件裁决」流程。但每次上传都会把旧远端引用写进 `history`，
 * 保证对象不会被 manifest 遗忘，后续做历史回看时不用重新发明存储格式。
 */

import {
  backupRestore,
  backupRestorePluginShard,
  backupSnapshot,
  cloudManifestV3Get,
  cloudManifestV3Put,
  cloudManifestGet,
  cloudQuota,
  cloudShardGet,
  cloudShardPut,
  cloudV3BlobGet,
  cloudV3BlobPut,
  cloudV3FileDelete,
  cloudV3FileGet,
  cloudV3FilePut,
  cloudV3Scan,
  syncCommitApplied,
  type CloudManifestV3,
  type CloudManifestV3Result,
  type CloudShardRef,
  type V3Baseline,
  type V3FileRef,
  type V3HistoryEntry,
  type V3LocalFile,
  type V3LocalPlugin,
  type V3PluginBaseline,
  type V3PluginManifest,
  type V3Scan,
} from "./bridge";
import { collectBackupState, collectState, restoreState, splitStateByShard } from "./snapshot";
import type { SyncRunState, SyncRoundOptions } from "./engine";
import type { SyncConflictShard, SyncPersistedState } from "./bridge";
import { debug, warn } from "../logger";

const V3_SCHEMA = "ms.cloud/3" as const;

function errText(e: unknown): string {
  return (e as Error)?.message ?? String(e);
}

function emptyManifest(deviceId: string, appVersion: string): CloudManifestV3 {
  return {
    schema: V3_SCHEMA,
    rev: 0,
    updatedAt: Date.now(),
    updatedBy: deviceId,
    appVersion,
    devices: {},
    core: { digest: "", bytes: 0, updatedAt: 0 },
    plugins: {},
  };
}

function emptyBaseline(): V3Baseline {
  return { core: "", plugins: {} };
}

/** 稳定 JSON：只用于比较「状态对象变没变」，不参与签名。 */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function refOf(digest: string, bytes: number, updatedAt: number): CloudShardRef {
  return { digest, bytes, updatedAt };
}

function fileRefOf(file: V3LocalFile, now: number): V3FileRef {
  return {
    digest: file.digest,
    bytes: file.bytes,
    updatedAt: now,
    ...(file.inline !== undefined ? { inline: file.inline } : {}),
  };
}

function fileMapOf(plugin: V3LocalPlugin | undefined): Record<string, V3LocalFile> {
  const map: Record<string, V3LocalFile> = {};
  for (const f of plugin?.files ?? []) map[f.path] = f;
  return map;
}

function blobMapOf(plugin: V3LocalPlugin | undefined): Record<string, V3LocalFile> {
  const map: Record<string, V3LocalFile> = {};
  for (const f of plugin?.blobs ?? []) map[f.path] = f;
  return map;
}

function pluginBaseOf(base: V3Baseline, id: string): V3PluginBaseline {
  return (
    base.plugins[id] ?? {
      body: "",
      state: {},
      files: {},
      blobs: {},
    }
  );
}

/** 冲突是否应该自动收敛：两边摘要相同就不打扰用户。 */
function same(a: string, b: string): boolean {
  return (a || "") === (b || "");
}

type Decision =
  | "upload"
  | "download"
  | "delete-remote"
  | "delete-local"
  | "skip"
  | "conflict";

/**
 * 单对象三方比较。`exists` 必须显式传入：空摘要既可能是「空内容」也可能是
 * 「这个文件不存在」，不能只看字符串。
 */
export function decideV3(input: {
  local: string;
  remote: string;
  base: string;
  localExists: boolean;
  remoteExists: boolean;
  baseExists: boolean;
  choice?: "local" | "remote";
}): Decision {
  const { local, remote, base, localExists, remoteExists, baseExists, choice } = input;
  if (choice === "local") {
    if (localExists) return "upload";
    return remoteExists ? "delete-remote" : "skip";
  }
  if (choice === "remote") {
    if (remoteExists) return "download";
    return localExists ? "delete-local" : "skip";
  }

  if (!localExists && !remoteExists) return "skip";
  if (!localExists) {
    if (!baseExists) return "download";
    if (same(remote, base)) return "delete-remote";
    return "conflict";
  }
  if (!remoteExists) {
    if (!baseExists) return "upload";
    if (same(local, base)) return "delete-local";
    return "conflict";
  }
  if (same(local, remote)) return "skip";
  if (!baseExists) return "conflict";
  if (same(local, base)) return "download";
  if (same(remote, base)) return "upload";
  return "conflict";
}

function addHistory(ref: V3FileRef | undefined, old: V3HistoryEntry[] | undefined, device: string): V3HistoryEntry[] | undefined {
  const next = [...(old ?? [])];
  if (ref?.digest && !ref.inline) {
    next.push({ digest: ref.digest, bytes: ref.bytes, device, ts: Date.now() });
  }
  return next.length ? next.slice(-8) : undefined;
}

function conflictOf(
  pluginId: string,
  kind: "core" | "body" | "data",
  path: string | undefined,
  localBytes?: number,
  remoteBytes?: number,
  remoteUpdatedAt?: number
): SyncConflictShard {
  return {
    pluginId,
    kind,
    ...(path ? { path } : {}),
    ...(localBytes !== undefined ? { localBytes } : {}),
    ...(remoteBytes !== undefined ? { remoteBytes } : {}),
    ...(remoteUpdatedAt !== undefined ? { remoteUpdatedAt } : {}),
  };
}

/** 下载真正落地前写本机快照；失败不阻塞同步，但面板不会显示路径。 */
async function preserveBeforeDownload(update: (p: Partial<SyncRunState>) => void): Promise<string | undefined> {
  try {
    const path = await backupSnapshot(collectBackupState(), "pre-remote-");
    update({ lastLocalBackupPath: path });
    return path;
  } catch (e) {
    warn(`[云同步 v3] 覆盖前留底失败（继续同步）: ${errText(e)}`);
    return undefined;
  }
}

async function applyCoreDownload(rel: string): Promise<void> {
  const got = await cloudShardGet(rel);
  const rep = await backupRestore(got.path, ["config", "localStorage", "internal"], collectState());
  restoreState((rep.localStorage ?? {}) as Record<string, unknown>, {
    silent: true,
    keepLocalPluginIds: rep.downgradeSkipped ?? [],
  });
  await syncCommitApplied("cloud", rep.scope ?? "all");
}

async function applyBodyDownload(rel: string, pluginId: string): Promise<void> {
  const got = await cloudShardGet(rel);
  await backupRestorePluginShard(got.path, pluginId);
  await syncCommitApplied("cloud", "plugins");
}

function pluginPayload(plugin: V3PluginManifest | undefined): V3PluginManifest {
  return {
    ...(plugin ?? {}),
    files: { ...(plugin?.files ?? {}) },
    blobs: { ...(plugin?.blobs ?? {}) },
  };
}

function ensurePlugin(out: CloudManifestV3, id: string): V3PluginManifest {
  return (out.plugins[id] ??= { files: {}, blobs: {} });
}

interface V3RunOptions {
  config: Awaited<ReturnType<SyncRoundOptions["getConfig"]>>;
  persisted: SyncPersistedState;
  state: SyncRunState;
  update: (p: Partial<SyncRunState>) => void;
  patch: (p: Record<string, unknown>) => Promise<void>;
  opts: SyncRoundOptions;
  trigger: string;
  manifest: CloudManifestV3Result;
}

/** 首次建立 v3：把本机全量写成 manifest-v3 并上传所有对象。 */
async function bootstrapV3(run: V3RunOptions): Promise<SyncRunState> {
  const { config, persisted, state, update, patch, opts, trigger, manifest } = run;
  update({ status: "uploading" });
  const ls = splitStateByShard();
  const scan = await cloudV3Scan(ls);
  const now = Date.now();
  const appVersion = scan.appVersion || manifest.manifest?.appVersion || "";
  const legacy = await cloudManifestGet().catch(() => null);
  const out: CloudManifestV3 = {
    schema: V3_SCHEMA,
    rev: (manifest.manifest?.rev ?? 0) + 1,
    updatedAt: now,
    updatedBy: persisted.deviceId,
    appVersion,
    devices: {
      ...(manifest.manifest?.devices ?? {}),
      [persisted.deviceId]: {
        name: persisted.deviceName || undefined,
        appVersion,
        lastSyncAt: now,
      },
    },
    ...(legacy?.exists && legacy.manifest
      ? {
          legacyV2: {
            rev: legacy.manifest.rev ?? 0,
            etag: legacy.etag,
            updatedAt: legacy.manifest.updatedAt ?? 0,
            migratedAt: now,
          },
        }
      : {}),
    core: scan.core.digest
      ? refOf(scan.core.digest, scan.core.bytes, now)
      : { digest: "", bytes: 0, updatedAt: 0 },
    plugins: {},
  };

  if (scan.core.digest) {
    const core = await cloudShardPut("core", ls.core);
    out.core = refOf(core.digest, core.bytes, now);
  }

  for (const [id, plugin] of Object.entries(scan.plugins)) {
    const p: V3PluginManifest = { files: {}, blobs: {} };
    if (plugin.body.digest && plugin.body.files > 0) {
      const body = await cloudShardPut(`body:${id}`, {});
      p.body = refOf(body.digest, body.bytes, now);
    }
    if (Object.keys(plugin.state ?? {}).length) p.state = plugin.state;
    for (const file of plugin.files) {
      if (file.inline !== undefined) {
        p.files![file.path] = fileRefOf(file, now);
      } else {
        const put = await cloudV3FilePut(id, file.path);
        p.files![file.path] = { digest: put.digest, bytes: put.bytes, updatedAt: now };
      }
    }
    for (const blob of plugin.blobs) {
      const put = await cloudV3BlobPut(id, blob.path);
      p.blobs![blob.path] = { digest: put.digest, bytes: put.bytes, updatedAt: now };
    }
    if (p.body || p.state || Object.keys(p.files!).length || Object.keys(p.blobs!).length) {
      out.plugins[id] = p;
    }
  }

  const committed = await cloudManifestV3Put(out, manifest.etag ?? null);
  const base: V3Baseline = {
    core: out.core?.digest ?? "",
    plugins: {},
  };
  for (const [id, p] of Object.entries(out.plugins)) {
    const files: Record<string, string> = {};
    for (const [path, ref] of Object.entries(p.files ?? {})) files[path] = ref.digest;
    const blobs: Record<string, string> = {};
    for (const [path, ref] of Object.entries(p.blobs ?? {})) blobs[path] = ref.digest;
    base.plugins[id] = {
      body: p.body?.digest ?? "",
      state: p.state ?? {},
      files,
      blobs,
    };
  }
  const at = Date.now();
  await patch({
    initialized: true,
    cloudFormat: 3,
    manifestEtag: committed.etag,
    remoteRev: String(out.rev),
    remoteEtag: committed.etag,
    v3: base,
    shards: null,
    pending: {},
    conflicts: [],
    lastSyncAt: at,
    lastLocalDigest: scan.core.digest,
  });
  update({
    status: "idle",
    lastError: "",
    lastSyncAt: at,
    localDigest: scan.core.digest,
    initialized: true,
    needsChoice: false,
    choiceReason: "",
    conflicts: [],
    remoteRev: String(out.rev),
    remoteMeta: { exists: true, rev: String(out.rev), etag: committed.etag, modified: committed.modified, size: committed.size },
  });
  debug(`[云同步 v3] ${trigger}: 已建立 manifest-v3（${Object.keys(out.plugins).length} 个插件）`);
  return { ...state };
}

/** 主轮次：比较 manifest-v3 / 本机 / 基线，只传变了的文件。 */
export async function runV3Round(
  opts: SyncRoundOptions,
  trigger: string,
  prev: Partial<SyncRunState> = {}
): Promise<SyncRunState> {
  const persisted = await opts.getState();
  const state: SyncRunState = {
    status: "idle",
    lastSyncAt: persisted.lastSyncAt || prev.lastSyncAt || 0,
    lastError: "",
    remoteMeta: prev.remoteMeta ?? null,
    localDigest: prev.localDigest ?? persisted.lastLocalDigest ?? "",
    initialized: persisted.initialized ?? prev.initialized ?? false,
    remoteRev: persisted.remoteRev ?? prev.remoteRev ?? "",
    needsChoice: false,
    choiceReason: "",
    conflicts: (persisted.conflicts as SyncConflictShard[] | null) ?? [],
    lastLocalBackupPath: prev.lastLocalBackupPath,
    epoch: persisted.epoch ?? prev.epoch ?? 1,
  };
  const update = (p: Partial<SyncRunState>): void => {
    Object.assign(state, p);
    opts.onState?.({ ...state });
  };
  const patch = async (p: Record<string, unknown>): Promise<void> => {
    await opts.patchState(p as Parameters<typeof opts.patchState>[0]);
    const fresh = await opts.getState();
    state.initialized = fresh.initialized;
    state.remoteRev = fresh.remoteRev;
    state.lastSyncAt = fresh.lastSyncAt;
    state.epoch = fresh.epoch;
  };

  update({ status: "syncing", lastError: "" });
  const config = await opts.getConfig();
  if (!config.enabled) {
    update({ status: "idle" });
    return { ...state };
  }

  update({ status: "downloading" });
  let manifest: CloudManifestV3Result;
  try {
    manifest = await cloudManifestV3Get();
  } catch (e) {
    throw new Error(`检查云端 manifest-v3 失败: ${errText(e)}`);
  }

  if (!manifest.exists || !manifest.manifest) {
    return await bootstrapV3({
      config,
      persisted,
      state,
      update,
      patch,
      opts,
      trigger,
      manifest,
    });
  }

  const remote = manifest.manifest;
  if (remote.schema !== V3_SCHEMA) {
    throw new Error(`云端 schema 不受支持（${String(remote.schema)}），已拒绝写入`);
  }
  let legacyWarning = "";
  if (remote.legacyV2) {
    try {
      const legacy = await cloudManifestGet();
      const migrated = remote.legacyV2;
      // 比较基线是“迁移时的 v2”，不是“当前 v3”：否则 v3 每提交一次都会把
      // 旧客户端后来写 v2 的警告压掉，两边各看一半还以为是同步好了。
      const v2Advanced =
        legacy.exists && legacy.manifest &&
        ((legacy.manifest.rev ?? 0) > (migrated.rev ?? 0) ||
          (legacy.manifest.updatedAt ?? 0) > (migrated.updatedAt ?? 0));
      if (v2Advanced) {
        legacyWarning =
          "检测到旧客户端在 v3 建立后仍提交过 v2 manifest；新数据在 v3 里安全，但请尽快让所有设备升级，避免两边各看一半。";
      }
    } catch { /* 权限/网络抖动不阻塞 v3 */ }
  }

  // 新设备首次看到已有 v3：必须让用户选「用云端 / 用本机」，不自动覆盖。
  if (!persisted.initialized && !opts.choice) {
    update({ status: "needs-choice", needsChoice: true, choiceReason: "first-connect" });
    return { ...state };
  }
  if (!persisted.initialized && opts.choice === "local") {
    return await bootstrapV3({
      config,
      persisted,
      state,
      update,
      patch,
      opts,
      trigger,
      manifest,
    });
  }

  const ls = splitStateByShard();
  const scan = await cloudV3Scan(ls);
  const base = persisted.v3 ?? emptyBaseline();
  const now = Date.now();
  const out: CloudManifestV3 = {
    ...remote,
    rev: (remote.rev ?? 0) + 1,
    updatedAt: now,
    updatedBy: persisted.deviceId,
    devices: {
      ...(remote.devices ?? {}),
      [persisted.deviceId]: {
        name: persisted.deviceName || undefined,
        appVersion: scan.appVersion || remote.appVersion,
        lastSyncAt: now,
      },
    },
    core: { ...(remote.core ?? { digest: "", bytes: 0, updatedAt: 0 }) },
    plugins: {},
  };
  for (const [id, p] of Object.entries(remote.plugins ?? {})) {
    out.plugins[id] = pluginPayload(p);
  }

  const conflicts: SyncConflictShard[] = [];
  const touched = { core: false, body: new Set<string>(), files: new Set<string>(), blobs: new Set<string>(), state: new Set<string>() };
  const held = { core: false, plugins: new Set<string>() };
  let changed = false;
  const choiceOf = (pluginId: string): "local" | "remote" | undefined =>
    (pluginId ? opts.choices?.[pluginId] : opts.coreChoice) ?? opts.choice;

  /* ---------- core ---------- */
  const coreLocal = scan.core;
  const coreRemote = remote.core;
  const coreBase = base.core;
  const coreAction = decideV3({
    local: coreLocal.digest,
    remote: coreRemote?.digest ?? "",
    base: coreBase,
    localExists: !!coreLocal.digest,
    remoteExists: !!coreRemote?.digest,
    baseExists: !!coreBase,
    choice: choiceOf(""),
  });
  if (coreAction === "upload") {
    const res = await cloudShardPut("core", ls.core);
    out.core = refOf(res.digest, res.bytes, now);
    touched.core = true;
    changed = true;
  } else if (coreAction === "download" && coreRemote?.digest) {
    await preserveBeforeDownload(update);
    await applyCoreDownload(`core-${coreRemote.digest}.msbackup`);
  } else if (coreAction === "delete-local") {
    // core 不允许删除整份；出现说明远端 manifest 被损坏，保守跳过。
    warn("[云同步 v3] core 远端缺失但本机有内容，保留本机并等待下次上传");
  } else if (coreAction === "conflict") {
    conflicts.push(
      conflictOf("", "core", undefined, coreLocal.bytes, coreRemote?.bytes, coreRemote?.updatedAt)
    );
    held.core = true;
  }

  /* ---------- 逐插件 ---------- */
  const pluginIds = new Set<string>([...Object.keys(scan.plugins), ...Object.keys(remote.plugins ?? {})]);
  for (const id of pluginIds) {
    const local = scan.plugins[id];
    const remotePlugin = remote.plugins?.[id];
    const basePlugin = pluginBaseOf(base, id);

    // 本机没装这个插件：不下载、也不删远端，避免「临时禁用插件」把云端数据清掉。
    if (!local) {
      if (remotePlugin) out.plugins[id] = pluginPayload(remotePlugin);
      continue;
    }

    let outPlugin = ensurePlugin(out, id);
    const choice = choiceOf(id);

    // body
    const bodyLocal = local.body;
    const bodyRemote = remotePlugin?.body;
    const bodyBase = basePlugin.body;
    const bodyAction = decideV3({
      local: bodyLocal.digest,
      remote: bodyRemote?.digest ?? "",
      base: bodyBase,
      localExists: bodyLocal.files > 0,
      remoteExists: !!bodyRemote?.digest,
      baseExists: !!bodyBase,
      choice,
    });
    if (bodyAction === "upload") {
      const res = await cloudShardPut(`body:${id}`, {});
      outPlugin.body = refOf(res.digest, res.bytes, now);
      touched.body.add(id);
      changed = true;
    } else if (bodyAction === "download" && bodyRemote?.digest) {
      await preserveBeforeDownload(update);
      await applyBodyDownload(`plugins/${id}/body-${bodyRemote.digest}.msbackup`, id);
    } else if (bodyAction === "delete-remote") {
      delete outPlugin.body;
    } else if (bodyAction === "conflict") {
      conflicts.push(conflictOf(id, "body", undefined, bodyLocal.bytes, bodyRemote?.bytes, bodyRemote?.updatedAt));
      held.plugins.add(id);
    }

    // state：整个对象比较；键级删除暂不传播（v3-mini 不铺 tombstone）
    const stateLocal = local.state ?? {};
    const stateRemote = remotePlugin?.state ?? {};
    const stateBase = basePlugin.state ?? {};
    const localKey = stableJson(stateLocal);
    const remoteKey = stableJson(stateRemote);
    const baseKey = stableJson(stateBase);
    const stateAction = decideV3({
      local: localKey,
      remote: remoteKey,
      base: baseKey,
      localExists: Object.keys(stateLocal).length > 0,
      remoteExists: Object.keys(stateRemote).length > 0,
      baseExists: Object.keys(stateBase).length > 0,
      choice,
    });
    if (stateAction === "upload") {
      outPlugin.state = stateLocal;
      touched.state.add(id);
      changed = true;
    } else if (stateAction === "download") {
      restoreState(stateRemote, { silent: true });
    } else if (stateAction === "delete-local") {
      // 状态整份删除不安全：保留本机，下一轮会按 local-changed 上传。
    } else if (stateAction === "conflict") {
      conflicts.push(conflictOf(id, "data", "plugin-state", undefined, undefined, undefined));
      held.plugins.add(id);
    }

    // 文件：并集比较
    const localFiles = fileMapOf(local);
    const remoteFiles = remotePlugin?.files ?? {};
    const baseFiles = basePlugin.files ?? {};
    const filePaths = new Set([...Object.keys(localFiles), ...Object.keys(remoteFiles), ...Object.keys(baseFiles)]);
    for (const path of filePaths) {
      const lf = localFiles[path];
      const rf = remoteFiles[path];
      const bd = baseFiles[path] ?? "";
      const action = decideV3({
        local: lf?.digest ?? "",
        remote: rf?.digest ?? "",
        base: bd,
        localExists: !!lf,
        remoteExists: !!rf,
        baseExists: !!bd,
        choice,
      });
      if (action === "upload" && lf) {
        if (lf.inline !== undefined) {
          outPlugin.files![path] = { ...fileRefOf(lf, now), history: addHistory(rf, rf?.history, persisted.deviceId) };
        } else {
          const put = await cloudV3FilePut(id, path);
          outPlugin.files![path] = {
            digest: put.digest,
            bytes: put.bytes,
            updatedAt: now,
            history: addHistory(rf, rf?.history, persisted.deviceId),
          };
        }
        touched.files.add(`${id}:${path}`);
        changed = true;
      } else if (action === "download" && rf) {
        await preserveBeforeDownload(update);
        await cloudV3FileGet(id, path, rf.digest, rf.inline);
      } else if (action === "delete-remote") {
        delete outPlugin.files![path];
        touched.files.add(`${id}:${path}`);
        changed = true;
      } else if (action === "delete-local") {
        await cloudV3FileDelete(id, path);
      } else if (action === "conflict") {
        conflicts.push(conflictOf(id, "data", path, lf?.bytes, rf?.bytes, rf?.updatedAt));
        held.plugins.add(id);
      }
    }

    // blob：图片等二进制，路径 -> 摘要
    const localBlobs = blobMapOf(local);
    const remoteBlobs = remotePlugin?.blobs ?? {};
    const baseBlobs = basePlugin.blobs ?? {};
    const blobPaths = new Set([...Object.keys(localBlobs), ...Object.keys(remoteBlobs), ...Object.keys(baseBlobs)]);
    for (const path of blobPaths) {
      const lb = localBlobs[path];
      const rb = remoteBlobs[path];
      const bd = baseBlobs[path] ?? "";
      const action = decideV3({
        local: lb?.digest ?? "",
        remote: rb?.digest ?? "",
        base: bd,
        localExists: !!lb,
        remoteExists: !!rb,
        baseExists: !!bd,
        choice,
      });
      if (action === "upload" && lb) {
        const put = await cloudV3BlobPut(id, path);
        outPlugin.blobs![path] = { digest: put.digest, bytes: put.bytes, updatedAt: now };
        touched.blobs.add(`${id}:${path}`);
        changed = true;
      } else if (action === "download" && rb) {
        await preserveBeforeDownload(update);
        await cloudV3BlobGet(id, path, rb.digest);
      } else if (action === "delete-remote") {
        delete outPlugin.blobs![path];
        touched.blobs.add(`${id}:${path}`);
        changed = true;
      } else if (action === "delete-local") {
        await cloudV3FileDelete(id, path);
      } else if (action === "conflict") {
        conflicts.push(conflictOf(id, "data", path, lb?.bytes, rb?.bytes, rb?.updatedAt));
        held.plugins.add(id);
      }
    }

    if (
      !outPlugin.body &&
      !outPlugin.state &&
      !Object.keys(outPlugin.files ?? {}).length &&
      !Object.keys(outPlugin.blobs ?? {}).length
    ) {
      delete out.plugins[id];
    }
  }

  if (conflicts.length && !opts.choice && !opts.coreChoice && !Object.keys(opts.choices ?? {}).length) {
    update({
      status: "needs-choice",
      needsChoice: true,
      choiceReason: "conflict",
      conflicts,
    });
  }

  // 上传 manifest 前再检查配额：单插件引用体积（body + files + blobs）
  const quota = await cloudQuota().catch(() => ({ pluginBytes: 200 * 1024 * 1024, shardBytes: 200 * 1024 * 1024 }));
  let quotaWarn = "";
  for (const [id, p] of Object.entries(out.plugins)) {
    let bytes = p.body?.bytes ?? 0;
    for (const f of Object.values(p.files ?? {})) bytes += f.bytes;
    for (const b of Object.values(p.blobs ?? {})) bytes += b.bytes;
    if (bytes > quota.pluginBytes) quotaWarn = `${id} 超过 ${Math.round(quota.pluginBytes / 1024 / 1024)}MB`;
  }

  let committed: { etag: string; rev: string; size: number; modified: number } = {
    etag: manifest.etag ?? "",
    rev: String(remote.rev ?? 0),
    size: manifest.size ?? 0,
    modified: manifest.modified ?? now,
  };
  if (!changed) {
    debug("[云同步 v3] 无文件变化，跳过 manifest 提交");
  } else {
    try {
      committed = await cloudManifestV3Put(out, manifest.etag ?? null);
    } catch (e) {
      if (!/SYNC_CONFLICT|HTTP 412/i.test(errText(e))) throw e;
      warn("[云同步 v3] manifest-v3 提交冲突，重读后按对象合并");
      const freshRes = await cloudManifestV3Get();
      const fresh = freshRes.manifest ?? emptyManifest(persisted.deviceId, out.appVersion);
      const merged: CloudManifestV3 = {
        ...fresh,
        rev: (fresh.rev ?? out.rev) + 1,
        updatedAt: Date.now(),
        updatedBy: persisted.deviceId,
        appVersion: out.appVersion,
        devices: {
          ...(fresh.devices ?? {}),
          [persisted.deviceId]: {
            ...(fresh.devices?.[persisted.deviceId] ?? {}),
            name: persisted.deviceName || fresh.devices?.[persisted.deviceId]?.name,
            appVersion: out.appVersion,
            lastSyncAt: Date.now(),
          },
        },
        core: fresh.core ?? out.core ?? { digest: "", bytes: 0, updatedAt: 0 },
        plugins: {},
      };
      for (const [id, p] of Object.entries(fresh.plugins ?? {})) merged.plugins[id] = pluginPayload(p);
      if (touched.core) merged.core = out.core;
      for (const id of touched.body) {
        const p = ensurePlugin(merged, id);
        if (out.plugins[id]?.body) p.body = out.plugins[id].body;
      }
      for (const key of touched.state) {
        const p = ensurePlugin(merged, key);
        if (out.plugins[key]?.state) p.state = out.plugins[key].state;
      }
      for (const key of touched.files) {
        const [id, ...rest] = key.split(":");
        const path = rest.join(":");
        const p = ensurePlugin(merged, id);
        const ref = out.plugins[id]?.files?.[path];
        if (ref) {
          const old = p.files?.[path];
          p.files![path] = { ...ref, history: addHistory(old, old?.history, persisted.deviceId) };
        } else {
          delete p.files?.[path];
        }
      }
    for (const key of touched.blobs) {
      const [id, ...rest] = key.split(":");
      const path = rest.join(":");
      const p = ensurePlugin(merged, id);
      const ref = out.plugins[id]?.blobs?.[path];
      if (ref) p.blobs![path] = ref;
      else delete p.blobs?.[path];
    }
    committed = await cloudManifestV3Put(merged, freshRes.etag ?? null);
    out.core = merged.core;
    out.plugins = merged.plugins;
    }
  }

  // 基线：只推进没有挂起的对象；挂起的保留旧基线，下一轮仍能检出双边改动
  const nextBase: V3Baseline = { core: held.core ? base.core : (out.core?.digest ?? ""), plugins: {} };
  for (const [id, p] of Object.entries(out.plugins)) {
    const files: Record<string, string> = {};
    for (const [path, ref] of Object.entries(p.files ?? {})) files[path] = ref.digest;
    const blobs: Record<string, string> = {};
    for (const [path, ref] of Object.entries(p.blobs ?? {})) blobs[path] = ref.digest;
    nextBase.plugins[id] = {
      body: p.body?.digest ?? "",
      state: p.state ?? {},
      files,
      blobs,
    };
    if (held.plugins.has(id)) {
      nextBase.plugins[id] = {
        body: base.plugins[id]?.body ?? "",
        state: base.plugins[id]?.state ?? {},
        files: base.plugins[id]?.files ?? {},
        blobs: base.plugins[id]?.blobs ?? {},
      };
    }
  }

  const at = Date.now();
  await patch({
    initialized: true,
    cloudFormat: 3,
    manifestEtag: committed.etag,
    remoteRev: committed.rev,
    v3: nextBase,
    shards: null,
    pending: {},
    conflicts: conflicts.length ? conflicts : [],
    lastSyncAt: at,
    lastLocalDigest: scan.core.digest,
  });
  update({
    status: conflicts.length ? "needs-choice" : "idle",
    needsChoice: conflicts.length > 0,
    choiceReason: conflicts.length ? "conflict" : "",
    conflicts,
    lastError: quotaWarn ? `配额提醒：${quotaWarn}` : legacyWarning,
    lastSyncAt: at,
    localDigest: scan.core.digest,
    remoteRev: committed.rev,
    remoteMeta: {
      exists: true,
      rev: committed.rev,
      etag: committed.etag,
      modified: committed.modified,
      size: committed.size,
    },
  });
  debug(`[云同步 v3] ${trigger}: 完成（冲突=${conflicts.length}，插件=${Object.keys(out.plugins).length}）`);
  return { ...state };
}

export { emptyBaseline, V3_SCHEMA };
