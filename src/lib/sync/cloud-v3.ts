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
  syncGetConfig,
  syncStateGet,
  syncStatePatch,
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
import { loadRegistry } from "../plugins/registry.ts";

const V3_SCHEMA = "ms.cloud/3" as const;

function errText(e: unknown): string {
  return (e as Error)?.message ?? String(e);
}

/**
 * 本机插件的「安装时间」表：用于区分「卸载前的老副本」与「卸载后又重装」。
 *
 * 注册表在 localStorage 里，非桌面端/测试环境读不到时返回空表——此时
 * `installedAt` 视为 0，会按「老副本」处理（宁可不复活，也不误传）。
 */
function installedAtMap(): Map<string, number> {
  if (typeof localStorage === "undefined") return new Map();
  try {
    return new Map(loadRegistry().plugins.map((p) => [p.id, p.installedAt ?? 0]));
  } catch {
    return new Map();
  }
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

/** 只落地主体分片，不广播：批量恢复多个插件时由调用方合并成一次 reload。 */
async function downloadBodyShard(rel: string, pluginId: string): Promise<void> {
  const got = await cloudShardGet(rel);
  await backupRestorePluginShard(got.path, pluginId);
}

async function applyBodyDownload(rel: string, pluginId: string): Promise<void> {
  await downloadBodyShard(rel, pluginId);
  await syncCommitApplied("cloud", "plugins");
}

/**
 * 把一个「本机完全没有」的远端插件装回本机：主体 → 状态 → 文件 → 图片。
 *
 * 顺序不能反：`backup.itemized` 规则来自插件的 `plugin.json`，主体没落地前
 * 下载虚拟条目会被当成普通文件写到 `clipboard/items/…`，而插件并不读那个目录。
 */
async function downloadPluginPayload(pluginId: string, entry: V3PluginManifest): Promise<void> {
  if (entry.body?.digest) {
    await downloadBodyShard(`plugins/${pluginId}/body-${entry.body.digest}.msbackup`, pluginId);
  }
  if (entry.state && Object.keys(entry.state).length) {
    restoreState(entry.state, { silent: true });
  }
  for (const [path, ref] of Object.entries(entry.files ?? {})) {
    await cloudV3FileGet(pluginId, path, ref.digest, ref.inline);
  }
  for (const [path, ref] of Object.entries(entry.blobs ?? {})) {
    await cloudV3BlobGet(pluginId, path, ref.digest);
  }
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
  const installedAt = installedAtMap();
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
    // 墓碑要跨「本机覆盖云端」保留：否则一台设备 bootstrap 就把别的设备
    // 的卸载记录抹掉，旧插件的副本又会重新上云。
    deleted: { ...(manifest.manifest?.deleted ?? {}) },
  };

  if (scan.core.digest) {
    const core = await cloudShardPut("core", ls.core);
    out.core = refOf(core.digest, core.bytes, now);
  }

  for (const [id, plugin] of Object.entries(scan.plugins)) {
    const tomb = out.deleted?.[id];
    if (tomb) {
      // 卸载之前的老副本：不再复活；卸载之后重装（安装时间晚于墓碑）才继续
      if ((installedAt.get(id) ?? 0) <= (tomb.at ?? 0)) continue;
      delete out.deleted![id];
    }
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

  // 本机待办的云端删除（离线卸载后第一次同步就走 bootstrap 的情况）：
  // 云端本来没有这个条目 → 直接清待办；本机还留着旧副本 → 删掉并写墓碑。
  const pendingDeletes: Record<string, { at: number; target?: string }> = {
    ...(persisted.pendingPluginDeletes ?? {}),
  };
  const pendingHandled = new Set<string>();
  for (const [id, meta] of Object.entries(pendingDeletes)) {
    if (meta.target && persisted.target && meta.target !== persisted.target) {
      pendingHandled.add(id);
      continue;
    }
    if (scan.plugins[id] && (installedAt.get(id) ?? 0) > (meta.at ?? 0)) {
      pendingHandled.add(id);
      continue;
    }
    const entry = out.plugins[id];
    if (entry) {
      out.deleted = {
        ...(out.deleted ?? {}),
        [id]: {
          at: Math.max(out.deleted?.[id]?.at ?? 0, meta.at ?? 0),
          by: persisted.deviceId,
          body: entry.body?.digest ?? "",
        },
      };
      delete out.plugins[id];
    }
    pendingHandled.add(id);
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
  let pendingLeft: Record<string, { at: number; target?: string }> | null = null;
  if (pendingHandled.size) {
    const stNow = await syncStateGet().catch(() => persisted);
    const left: Record<string, { at: number; target?: string }> = {
      ...(stNow.pendingPluginDeletes ?? {}),
    };
    for (const id of pendingHandled) delete left[id];
    pendingLeft = Object.keys(left).length ? left : null;
  }
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
    ...(pendingHandled.size ? { pendingPluginDeletes: pendingLeft } : {}),
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
    deleted: { ...(remote.deleted ?? {}) },
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
  const installedAt = installedAtMap();

  /* ---------- 本机待办的云端删除 ---------- */
  // 卸载时云同步没开/离线：删除请求先记在 sync-state，这里补做。
  // 重装过（installedAt 晚于删除时间）就取消这条待办，交给正常的逐插件流程上传。
  const pendingDeletes: Record<string, { at: number; target?: string }> = {
    ...(persisted.pendingPluginDeletes ?? {}),
  };
  const appliedDeleteIds = new Set<string>();
  const cancelledDeleteIds = new Set<string>();
  for (const [id, meta] of Object.entries(pendingDeletes)) {
    // 待办属于别的同步目标（用户换过 WebDAV）：直接丢弃，别误删新目标的插件
    if (meta.target && persisted.target && meta.target !== persisted.target) {
      cancelledDeleteIds.add(id);
      continue;
    }
    if (scan.plugins[id] && (installedAt.get(id) ?? 0) > (meta.at ?? 0)) {
      cancelledDeleteIds.add(id);
      // 卸载后又装回来了：云端那份是旧副本，丢掉；按「新插件」从空基线重新上传
      delete out.plugins[id];
      debug("[云同步 v3] 插件已重装，取消云端删除待办", id);
      continue;
    }
    const body = out.plugins[id]?.body?.digest ?? "";
    const prev = out.deleted?.[id];
    out.deleted = {
      ...(out.deleted ?? {}),
      [id]: {
        at: Math.max(prev?.at ?? 0, meta.at ?? 0),
        by: persisted.deviceId,
        body: body || prev?.body || "",
      },
    };
    delete out.plugins[id];
    appliedDeleteIds.add(id);
    changed = true;
    debug("[云同步 v3] 已删除云端插件并留下墓碑", id, body.slice(0, 8));
  }

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
  const pluginIds = new Set<string>([...Object.keys(scan.plugins), ...Object.keys(out.plugins)]);
  // 首次连接「用云端」可能一次装回多个缺失插件：先留一份本机快照，不必每个插件各拍一张
  const willInstallAbsent = [...pluginIds].some(
    (id) => !scan.plugins[id] && !!out.plugins[id] && !out.deleted?.[id] && choiceOf(id) === "remote"
  );
  if (willInstallAbsent) await preserveBeforeDownload(update);
  let installedAbsent = false;
  const revivedIds = new Set<string>();
  for (const id of pluginIds) {
    const local = scan.plugins[id];
    const remotePlugin = out.plugins[id];
    let basePlugin = pluginBaseOf(base, id);

    // 云端墓碑：这个插件被某台设备卸载并删除了。
    // - 本机没有 / 是卸载前的老副本：什么都不做，也绝不能把旧副本再传上去；
    // - 本机在卸载之后重新装过：解除墓碑，按「新插件」从空基线全量上传。
    const tomb = out.deleted?.[id];
    if (tomb) {
      if (!local || (installedAt.get(id) ?? 0) <= (tomb.at ?? 0)) {
        debug(`[云同步 v3] 跳过已从云端删除的插件 ${id}`);
        continue;
      }
      delete out.deleted![id];
      basePlugin = { body: "", state: {}, files: {}, blobs: {} };
      revivedIds.add(id);
      changed = true;
      debug(`[云同步 v3] 插件卸载后重装，解除墓碑 ${id}`);
    }

    // 本机没装这个插件。
    // - 首次连接 / 本轮明确裁决「用云端」：必须把云端插件装回来，否则新设备
    //   只拉到 core，插件永远停在「云端有、本机 0 B」，基线却被推进成已同步。
    // - 稳态下（已与这个云端建立基线）没装：可能是用户主动卸载，保持「不下载、
    //   不删远端」；面板标「本机未安装」，需要时用「恢复到本机」单独装回。
    if (!local) {
      if (remotePlugin) out.plugins[id] = pluginPayload(remotePlugin);
      if (remotePlugin && choiceOf(id) === "remote") {
        await downloadPluginPayload(id, remotePlugin);
        installedAbsent = true;
        debug(`[云同步 v3] 装回本机缺失插件 ${id}（files=${Object.keys(remotePlugin.files ?? {}).length}）`);
      }
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

  // 装回的插件要等文件/状态全部落地后再统一 reload，否则插件先起来只能读到半份数据
  if (installedAbsent) await syncCommitApplied("cloud", "plugins");

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
        deleted: { ...(fresh.deleted ?? {}) },
      };
      for (const [id, p] of Object.entries(fresh.plugins ?? {})) merged.plugins[id] = pluginPayload(p);
      // 墓碑一律以「刚重读的远端」为准：远端已解除（别人重装）就跟着解除；
      // 远端仍有墓碑时，任何残留的插件条目都视为并发上传的旧副本，必须删掉。
      merged.deleted = { ...(fresh.deleted ?? {}) };
      for (const id of appliedDeleteIds) {
        if (out.deleted?.[id]) merged.deleted![id] = out.deleted[id];
        delete merged.plugins[id];
      }
      for (const id of revivedIds) delete merged.deleted![id];
      for (const id of Object.keys(merged.deleted!)) {
        if (appliedDeleteIds.has(id) || revivedIds.has(id)) continue;
        delete merged.plugins[id];
      }
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
    out.deleted = merged.deleted;
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
  // 清掉本轮已经写进云端的删除待办；本轮之后才产生的待办（同步途中卸载）要留着
  let pendingLeft: Record<string, { at: number; target?: string }> | null = null;
  if (appliedDeleteIds.size || cancelledDeleteIds.size) {
    const stNow = await syncStateGet().catch(() => persisted);
    const left: Record<string, { at: number; target?: string }> = {
      ...(stNow.pendingPluginDeletes ?? {}),
    };
    for (const id of appliedDeleteIds) delete left[id];
    for (const id of cancelledDeleteIds) delete left[id];
    pendingLeft = Object.keys(left).length ? left : null;
  }
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
    ...(appliedDeleteIds.size || cancelledDeleteIds.size ? { pendingPluginDeletes: pendingLeft } : {}),
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

/**
 * 手动把云端某个插件恢复到本机（面板「恢复到本机」）。
 *
 * 与同步轮次的区别：只补「本机缺的」——主体、缺失的文件/图片、以及本机完全
 * 没有这个插件时的状态；**不覆盖**本机已有的文件。用户点这个按钮通常是因为
 * 该插件根本没装（新设备、误删），不是在解决冲突。
 *
 * 返回 `ready` = 本机已经完整，不需要动。
 */
export async function restorePluginFromCloud(
  pluginId: string,
  options: { backup?: boolean; commit?: boolean } = {}
): Promise<{
  status: "applied" | "ready" | "missing" | "disabled" | "error";
  message?: string;
}> {
  try {
    const config = await syncGetConfig();
    if (!config.enabled) return { status: "disabled" };
    const m = await cloudManifestV3Get();
    if (!m.exists || !m.manifest) {
      return { status: "missing", message: "云端还没有 v3 清单（可能仍在用旧版同步）" };
    }
    const entry = m.manifest.plugins?.[pluginId];
    if (m.manifest.deleted?.[pluginId]) {
      return {
        status: "missing",
        message: "该插件已从云端删除（卸载时清理），如需使用请重新安装",
      };
    }
    if (!entry) return { status: "missing", message: "云端没有该插件的数据" };

    const files = entry.files ?? {};
    const blobs = entry.blobs ?? {};
    const scan = await cloudV3Scan(splitStateByShard());
    const local = scan.plugins[pluginId];
    const localFiles = fileMapOf(local);
    const localBlobs = blobMapOf(local);
    const needBody = (local?.body.files ?? 0) === 0 && !!entry.body?.digest;
    const needState =
      Object.keys(entry.state ?? {}).length > 0 &&
      Object.keys(local?.state ?? {}).length === 0;
    const missingFiles = Object.keys(files).filter((p) => !localFiles[p]);
    const missingBlobs = Object.keys(blobs).filter((p) => !localBlobs[p]);
    if (!needBody && !needState && !missingFiles.length && !missingBlobs.length) {
      return { status: "ready" };
    }

    // 覆盖前留底：恢复失败也能从备份目录找回本机原状。
    // 批量恢复由调用方只在第一项留底，避免 N 个插件 N 份整包快照。
    if (options.backup !== false) {
      await backupSnapshot(collectBackupState(), "pre-remote-").catch(() => undefined);
    }

    if (needBody && entry.body?.digest) {
      await downloadBodyShard(`plugins/${pluginId}/body-${entry.body.digest}.msbackup`, pluginId);
    }
    if (needState && entry.state) restoreState(entry.state, { silent: true });
    for (const path of missingFiles) {
      const ref = files[path];
      await cloudV3FileGet(pluginId, path, ref.digest, ref.inline);
    }
    for (const path of missingBlobs) {
      const ref = blobs[path];
      await cloudV3BlobGet(pluginId, path, ref.digest);
    }

    // 基线只推进「这次真的补下来」的条目；本机已有的保持原基线，否则下一轮
    // 会把用户本地改过的文件当成「云端更新」再覆盖回来。
    const st = await syncStateGet();
    const base = (st.v3 ?? emptyBaseline()) as V3Baseline;
    const prev = base.plugins[pluginId] ?? { body: "", state: {}, files: {}, blobs: {} };
    const next: V3PluginBaseline = {
      body: needBody ? (entry.body?.digest ?? "") : (prev.body ?? ""),
      state: needState ? (entry.state ?? {}) : (prev.state ?? {}),
      files: { ...(prev.files ?? {}) },
      blobs: { ...(prev.blobs ?? {}) },
    };
    for (const path of missingFiles) next.files[path] = files[path].digest;
    for (const path of missingBlobs) next.blobs[path] = blobs[path].digest;
    base.plugins[pluginId] = next;
    await syncStatePatch({ v3: base });
    if (options.commit !== false) await syncCommitApplied("cloud", "plugins");
    return { status: "applied" };
  } catch (e) {
    return { status: "error", message: errText(e) };
  }
}

/** 把某个插件从本机 v3 基线里摘掉（卸载后调用，避免下一轮拿旧基线做三方比较） */
async function dropPluginBaseline(pluginId: string): Promise<void> {
  const st = await syncStateGet();
  const base = st.v3;
  if (!base?.plugins?.[pluginId]) return;
  const next: V3Baseline = { ...base, plugins: { ...base.plugins } };
  delete next.plugins[pluginId];
  await syncStatePatch({ v3: next });
}

/** 记一条「云同步恢复后要删掉这个插件」的待办（离线 / 失败时兜底） */
async function queuePluginDeletion(pluginId: string, at: number, target?: string): Promise<void> {
  const st = await syncStateGet();
  const pending: Record<string, { at: number; target?: string }> = {
    ...(st.pendingPluginDeletes ?? {}),
  };
  pending[pluginId] = { at, ...(target ? { target } : {}) };
  await syncStatePatch({ pendingPluginDeletes: pending });
}

async function clearQueuedDeletion(pluginId: string): Promise<void> {
  const st = await syncStateGet();
  const pending = { ...(st.pendingPluginDeletes ?? {}) };
  if (!pending[pluginId]) return;
  delete pending[pluginId];
  await syncStatePatch({ pendingPluginDeletes: Object.keys(pending).length ? pending : null });
}

/**
 * 卸载插件时把云端那份也删掉（并留下墓碑，防止别的设备把旧副本推回来）。
 *
 * 只删 **v3 清单条目 + 本机基线**，不物理删 shard：墓碑已经能阻断复活，
 * 孤儿 shard 留给未来的 GC，误删也还能从备份里捞回。
 *
 * 失败/离线不是问题：删除请求会写进 `pendingPluginDeletes`，下一轮同步补做。
 */
export async function removePluginFromCloud(pluginId: string): Promise<{
  status: "deleted" | "queued" | "missing" | "disabled" | "error";
  message?: string;
}> {
  const at = Date.now();
  try {
    const config = await syncGetConfig().catch(() => null);
    const st = await syncStateGet().catch(() => null);
    const target = st?.target || "";
    // 基线先摘掉：即使云端删除失败，也不会拿旧基线把已卸载的插件判成「本机改了」
    await dropPluginBaseline(pluginId).catch(() => undefined);
    if (!config) {
      await queuePluginDeletion(pluginId, at, target || undefined);
      return { status: "queued", message: "读不到同步状态，已记为待办" };
    }
    // 云同步暂时关着也记待办：等用户开启后由下一轮同步补做，别让旧条目留在云端
    if (!config.enabled) {
      await queuePluginDeletion(pluginId, at, target || undefined);
      return { status: "queued", message: "云同步未开启，已记为待办" };
    }

    await queuePluginDeletion(pluginId, at, target || undefined);
    const by = st?.deviceId || "";
    let lastErr = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const m = await cloudManifestV3Get();
      if (!m.exists || !m.manifest || m.manifest.schema !== V3_SCHEMA) {
        return { status: "queued", message: "云端还没有 v3 清单，已记为待办" };
      }
      const man = m.manifest;
      const entry = man.plugins?.[pluginId];
      if (!entry) {
        await clearQueuedDeletion(pluginId);
        return man.deleted?.[pluginId] ? { status: "deleted" } : { status: "missing" };
      }
      const out: CloudManifestV3 = {
        ...man,
        rev: (man.rev ?? 0) + 1,
        updatedAt: at,
        updatedBy: by || man.updatedBy,
        plugins: { ...(man.plugins ?? {}) },
        deleted: {
          ...(man.deleted ?? {}),
          [pluginId]: { at, by: by || undefined, body: entry.body?.digest ?? "" },
        },
      };
      delete out.plugins[pluginId];
      try {
        await cloudManifestV3Put(out, m.etag ?? null);
        await clearQueuedDeletion(pluginId);
        await syncCommitApplied("cloud", "plugins");
        return { status: "deleted" };
      } catch (e) {
        lastErr = errText(e);
        if (!/SYNC_CONFLICT|HTTP 412/i.test(lastErr) || attempt === 1) break;
        warn("[云同步 v3] 删除插件时清单冲突，重读后重试");
      }
    }
    return { status: "queued", message: lastErr || "云端暂不可写，已记为待办" };
  } catch (e) {
    return { status: "error", message: errText(e) };
  }
}

export { emptyBaseline, V3_SCHEMA };


