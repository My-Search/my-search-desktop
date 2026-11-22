/**
 * 云同步 v2 内核 —— **按分片比较、只传脏片、数据分片懒下载**。
 *
 * 与 v1 `engine.ts` 的差别
 * -----------------------
 * - v1：远端只有一个 `.msbackup` 整包，「本机变了 / 远端变了」是二值判断，
 *   任何一次改动都要整包上传、整包下载。
 * - v2：远端是「分片对象 + manifest 提交点」。本机把用户态切成
 *   `core`（内部状态/设置/非插件 localStorage）、每个插件的 `body`（安装文件）、
 *   每个插件的 `data`（kv 等白名单 + 云数据 store）。**逐片**比较摘要，
 *   只传变脏的片；`data` 默认懒下载（首次打开该插件时才拉），
 *   所以新设备首次同步只下「内核 + 各插件主体」。
 *
 * 提交语义
 * -------
 * 对象按内容摘要命名（同内容重复上传是幂等的），manifest 最后写：
 * 写失败时旧 manifest 仍指向旧对象，远端永远是一个完整状态。
 * manifest 的条件 PUT 返回 412 → 说明别的设备刚提交，重读远端后合并再写一次。
 */

import {
  backupRestore,
  backupRestorePluginShard,
  backupSnapshot,
  cloudDigests,
  cloudManifestGet,
  cloudManifestPut,
  cloudManifestV3Get,
  cloudQuota,
  cloudShardGet,
  cloudShardInspect,
  cloudShardPut,
  syncCommitApplied,
  syncDownload,
  syncRemoteMeta,
  type CloudDigests,
  type CloudManifest,
  type CloudManifestResult,
  type CloudShardRef,
  type ShardsBaseline,
  type SyncConflictShard,
  type SyncConfig,
  type SyncPersistedState,
} from "./bridge";
import { collectBackupState, collectState, restoreState, splitStateByShard } from "./snapshot";
import type { SyncRunState, SyncRoundOptions } from "./engine";
import { runV3Round } from "./cloud-v3";
import { debug, warn } from "../logger";

export const CLOUD_SCHEMA = "ms.cloud/2" as const;

/** 分片决策（纯函数，便于单测） */
export type ShardAction = "upload" | "download" | "skip" | "conflict";

export interface ShardDecisionInput {
  /** 本机该片当前摘要 */
  local: string;
  /** 上次与本机对齐的摘要（无则说明是「新出现的片」） */
  base?: string;
  /** 远端该片摘要（`undefined` = 远端没有这片） */
  remote?: string;
  /** 本机该片文件数（0 表示本机没有内容） */
  localFiles: number;
  conflict: SyncConfig["conflict"];
  /** 远端该片更新时间（ms），`newer` 策略用 */
  remoteUpdatedAt?: number;
  /** 上次成功同步时间（ms） */
  lastSyncAt: number;
}

/**
 * 单分片决策。
 *
 * | 远端 | 基线 | 本机==基线 | 远端==基线 | 结果 |
 * |------|------|-----------|-----------|------|
 * | 无   | *    | -         | -         | 本机有内容 → upload，否则 skip |
 * | 有   | 无   | -         | -         | 内容相同 → skip；本机空 → download；都有内容 → conflict |
 * | 有   | 有   | 是        | 是        | skip |
 * | 有   | 有   | 是        | 否        | download |
 * | 有   | 有   | 否        | 是        | upload |
 * | 有   | 有   | 否        | 否        | 冲突：按策略 |
 */
export function decideShardAction(i: ShardDecisionInput): ShardAction {
  if (i.remote === undefined) {
    return i.localFiles > 0 ? "upload" : "skip";
  }
  if (i.base === undefined || i.base === "") {
    if (i.local === i.remote) return "skip";
    if (i.localFiles === 0) return "download";
    return "conflict";
  }
  const localChanged = i.local !== i.base;
  const remoteChanged = i.remote !== i.base;
  if (!localChanged && !remoteChanged) return "skip";
  if (!remoteChanged) return "upload";
  if (!localChanged) return "download";
  switch (i.conflict) {
    case "local":
      return "upload";
    case "remote":
      return "download";
    case "newer":
      return (i.remoteUpdatedAt ?? 0) > (i.lastSyncAt ?? 0) ? "download" : "upload";
    case "ask":
    default:
      return "conflict";
  }
}

/** 分片对象相对路径（与 Rust `cloud_sync::shard_rel` 必须一致） */
export function shardRel(kind: "core" | "body" | "data", digest: string, pluginId = ""): string {
  if (kind === "core") return `core-${digest}.msbackup`;
  return `plugins/${pluginId}/${kind}-${digest}.msbackup`;
}

function emptyManifest(deviceId: string, appVersion: string): CloudManifest {
  return {
    schema: CLOUD_SCHEMA,
    rev: 0,
    updatedAt: Date.now(),
    updatedBy: deviceId,
    appVersion,
    devices: {},
    core: { digest: "", bytes: 0, updatedAt: 0 },
    plugins: {},
  };
}

function refOf(
  digest: string,
  bytes: number,
  updatedAt: number,
  fallback?: CloudShardRef
): CloudShardRef {
  if (!digest) return fallback ?? { digest: "", bytes: 0, updatedAt: 0 };
  return { digest, bytes, updatedAt };
}

/** 是否「manifest 条件提交冲突」（别的设备刚写过） */
function isCommitConflict(error: unknown): boolean {
  const msg = (error as Error)?.message ?? String(error);
  return msg.includes("SYNC_CONFLICT") || msg.includes("HTTP 412");
}

/** 一次轮次的依赖（与 v1 `SyncRoundOptions` 对齐，宿主直接复用） */
export interface CloudRoundOptions {
  getConfig: () => SyncConfig | Promise<SyncConfig>;
  getState: () => SyncPersistedState | Promise<SyncPersistedState>;
  patchState: (patch: Record<string, unknown>) => Promise<SyncPersistedState>;
  onState?: (state: SyncRunState) => void;
  choice?: "local" | "remote";
  /** 插件级裁决（`pluginId → 保留哪边`）；数组外的插件冲突继续挂起 */
  choices?: Record<string, "local" | "remote">;
  /** core（软件主体配置）的裁决；未给则 core 冲突也挂起 */
  coreChoice?: "local" | "remote";
}

function initialState(prev: Partial<SyncRunState>, persisted: SyncPersistedState): SyncRunState {
  return {
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
}

interface UploadJob {
  kind: "core" | "body" | "data";
  pluginId?: string;
  scope: string;
  ls: Record<string, unknown>;
  result?: { digest: string; bytes: number };
}

interface DownloadJob {
  kind: "core" | "body" | "data";
  pluginId?: string;
  rel: string;
  digest: string;
}

/**
 * 云同步入口：v3 优先；没有 `manifest-v3.json` 时先用一轮 v2 把本机与旧云端对齐，
 * 再建立 v3。这样迁移不需要把 v2 归档解包重传，也不会跳过 v2 的冲突裁决。
 */
export async function runCloudRound(
  opts: CloudRoundOptions,
  trigger: string,
  prev: Partial<SyncRunState> = {}
): Promise<SyncRunState> {
  const config = await opts.getConfig();
  if (!config.enabled) return await runV2Round(opts, trigger, prev);
  if (config.cloudFormat !== 3) {
    return await runV2Round(opts, trigger, prev);
  }

  const v3 = await cloudManifestV3Get();
  if (v3.exists) {
    return await runV3Round(opts as unknown as SyncRoundOptions, trigger, prev);
  }

  const v2 = await cloudManifestGet().catch(() => ({ exists: false } as CloudManifestResult));
  if (v2.exists) {
    const aligned = await runV2Round(opts, trigger, prev);
    if (aligned.status === "error" || aligned.needsChoice || aligned.status === "needs-choice") {
      return aligned;
    }
  }
  return await runV3Round(opts as unknown as SyncRoundOptions, trigger, prev);
}

/**
 * 执行一轮 v2 同步。返回本轮结束时的运行状态（与 v1 的 `SyncRunState` 同构，
 * 面板/插件绑定无需改动）。
 */
async function runV2Round(
  opts: CloudRoundOptions,
  trigger: string,
  prev: Partial<SyncRunState> = {}
): Promise<SyncRunState> {
  const startedAt = Date.now();
  let persisted = await opts.getState();
  const state = initialState(prev, persisted);
  const update = (partial: Partial<SyncRunState>): void => {
    Object.assign(state, partial);
    opts.onState?.({ ...state });
  };
  const patch = async (p: Record<string, unknown>): Promise<void> => {
    persisted = await opts.patchState(p);
    state.initialized = persisted.initialized;
    state.remoteRev = persisted.remoteRev;
    state.lastSyncAt = persisted.lastSyncAt;
    state.epoch = persisted.epoch;
  };

  update({ status: "syncing", lastError: "" });
  try {
    const config = await opts.getConfig();
    if (!config.enabled) {
      update({ status: "idle", lastError: "" });
      return { ...state };
    }

    update({ status: "downloading" });
    let manifest: CloudManifestResult;
    try {
      manifest = await cloudManifestGet();
    } catch (e) {
      throw new Error(`检查云端 manifest 失败: ${(e as Error)?.message ?? e}`);
    }

    const appVersion =
      (manifest.manifest as CloudManifest | null)?.appVersion ?? "";

    // ---------- 首次建立：远端没有 v2 manifest ----------
    if (!manifest.exists) {
      return await bootstrap(
        { config, persisted, state, update, patch, opts, trigger, appVersion },
        manifest
      );
    }

    const remoteManifest = manifest.manifest ?? emptyManifest(persisted.deviceId, appVersion);
    const remoteExists = Object.keys(remoteManifest.plugins ?? {}).length > 0 || !!remoteManifest.core?.digest;

    if (!persisted.initialized) {
      if (!opts.choice) {
        update({ status: "needs-choice", needsChoice: true, choiceReason: "first-connect" });
        return { ...state };
      }
      if (opts.choice === "remote") {
        await pullAllShards(remoteManifest, update, patch, opts, trigger, { includeData: true });
        return { ...state };
      }
      // 本机覆盖远端：全部片按本机上传
      await pushAllShards(config, persisted, remoteManifest, manifest.etag ? manifest.etag : null, update, patch, trigger);
      return { ...state };
    }

    if (!remoteExists) {
      // 远端 manifest 存在但没有任何片（别的设备清空过）→ 本机推全量
      await pushAllShards(config, persisted, remoteManifest, manifest.etag ? manifest.etag : null, update, patch, trigger);
      return { ...state };
    }

    // ---------- 稳态：逐片比较 ----------
    const ls = splitStateByShard();
    const digests = await cloudDigests(ls);
    const base: ShardsBaseline = persisted.shards ?? { core: "", plugins: {} };
    const pending: Record<string, string> = { ...(persisted.pending ?? {}) };
    const now = Date.now();

    const downloads: DownloadJob[] = [];
    const uploads: UploadJob[] = [];
    const conflicts: SyncConflictShard[] = [];
    const warnQuota: string[] = [];
    /** 这一片该听谁的：插件级裁决优先，其次全局 `choice`（首次连接 / 一键全选） */
    const choiceOf = (pluginId: string): "local" | "remote" | undefined =>
      (pluginId ? opts.choices?.[pluginId] : opts.coreChoice) ?? opts.choice;

    // 1) 内核片
    const coreDecision = decideShardAction({
      local: digests.core.digest,
      base: base.core,
      remote: remoteManifest.core?.digest || undefined,
      localFiles: digests.core.files,
      conflict: config.conflict,
      remoteUpdatedAt: remoteManifest.core?.updatedAt,
      lastSyncAt: persisted.lastSyncAt,
    });
    const core = resolveAction(coreDecision, choiceOf(""));
    if (core === "download") {
      downloads.push({
        kind: "core",
        rel: shardRel("core", remoteManifest.core.digest),
        digest: remoteManifest.core.digest,
      });
    } else if (core === "upload") {
      uploads.push({ kind: "core", scope: "core", ls: ls.core });
    } else if (core === "conflict") {
      conflicts.push({
        pluginId: "",
        kind: "core",
        localBytes: digests.core.bytes,
        remoteBytes: remoteManifest.core?.bytes,
        remoteUpdatedAt: remoteManifest.core?.updatedAt,
      });
    }

    // 2) 插件片
    const ids = new Set<string>([
      ...Object.keys(digests.plugins),
      ...Object.keys(remoteManifest.plugins ?? {}),
      ...Object.keys(pending),
    ]);

    /** 本机已卸载的插件：只从 manifest 里摘掉引用，不传「空片」 */
    const removed: string[] = [];

    for (const id of ids) {
      const local = digests.plugins[id];
      const remote = remoteManifest.plugins?.[id];
      const hadBefore = base.plugins?.[id] !== undefined;

      // 本机没有这个插件：区分「卸载」与「新设备从未装过」
      if (!local) {
        if (hadBefore) {
          removed.push(id); // 上次同步时还在 → 用户卸载了：摘引用（对象交给 GC）
          continue;
        }
        // 从未装过：从云端装回来（主体立即下载，数据仍懒加载）
        if (remote?.body?.digest) {
          downloads.push({
            kind: "body",
            pluginId: id,
            rel: shardRel("body", remote.body.digest, id),
            digest: remote.body.digest,
          });
        }
        if (remote?.data?.digest && choiceOf(id) === "remote") {
          downloads.push({
            kind: "data",
            pluginId: id,
            rel: shardRel("data", remote.data.digest, id),
            digest: remote.data.digest,
          });
        } else if (remote?.data?.digest) {
          pending[id] = remote.data.digest;
        }
        continue;
      }

      // body
      const bodyDecision = decideShardAction({
        local: local?.body.digest ?? "",
        base: base.plugins?.[id]?.body,
        remote: remote?.body?.digest || undefined,
        localFiles: local?.body.files ?? 0,
        conflict: config.conflict,
        remoteUpdatedAt: remote?.body?.updatedAt,
        lastSyncAt: persisted.lastSyncAt,
      });
      const body = resolveAction(bodyDecision, choiceOf(id));
      if (body === "download") {
        downloads.push({
          kind: "body",
          pluginId: id,
          rel: shardRel("body", remote!.body!.digest, id),
          digest: remote!.body!.digest,
        });
      } else if (body === "upload") {
        if ((local?.body.files ?? 0) > 0) {
          uploads.push({ kind: "body", pluginId: id, scope: `body:${id}`, ls: {} });
        }
      } else if (body === "conflict") {
        conflicts.push({
          pluginId: id,
          kind: "body",
          localBytes: local?.body.bytes ?? 0,
          remoteBytes: remote?.body?.bytes,
          remoteUpdatedAt: remote?.body?.updatedAt,
        });
      }

      // data（懒下载：远端有新数据只记 pending，不拉）
      const remoteDataDigest = remote?.data?.digest || undefined;
      if (pending[id] !== undefined) {
        // 远端又换了数据 → 更新 pending；始终不拿本机旧数据覆盖远端
        if (remoteDataDigest && remoteDataDigest !== pending[id]) pending[id] = remoteDataDigest;
      } else {
        const dataDecision = decideShardAction({
          local: local?.data.digest ?? "",
          base: base.plugins?.[id]?.data,
          remote: remoteDataDigest,
          localFiles: local?.data.files ?? 0,
          conflict: config.conflict,
          remoteUpdatedAt: remote?.data?.updatedAt,
          lastSyncAt: persisted.lastSyncAt,
        });
        const data = resolveAction(dataDecision, choiceOf(id));
        if (data === "download") {
          if (choiceOf(id) === "remote") {
            downloads.push({
              kind: "data",
              pluginId: id,
              rel: shardRel("data", remoteDataDigest!, id),
              digest: remoteDataDigest!,
            });
          } else {
            pending[id] = remoteDataDigest!;
          }
        } else if (data === "upload") {
          uploads.push({
            kind: "data",
            pluginId: id,
            scope: `data:${id}`,
            ls: ls.plugins[id] ?? {},
          });
        } else if (data === "conflict") {
          conflicts.push({
            pluginId: id,
            kind: "data",
            localBytes: local?.data.bytes ?? 0,
            remoteBytes: remote?.data?.bytes,
            remoteUpdatedAt: remote?.data?.updatedAt,
          });
        }
      }
    }

    // 冲突片只挂起自己：其余片继续下载/上传，插件之间、分片之间互不牵连。
    const heldKeys = new Set<string>(
      conflicts.map((c) => (c.kind === "core" ? "core" : `${c.pluginId}:${c.kind}`))
    );
    if (conflicts.length > 0) {
      debug(
        `[云同步] ${trigger}: ${conflicts.length} 个分片冲突已挂起，其余片继续同步: ${[...heldKeys].join(", ")}`
      );
    }

    // 3) 下载（core → body → data），逐片落盘
    if (downloads.length > 0) {
      await preserveLocalBeforeDownload(update);
    }
    for (const job of downloads) {
      update({ status: "downloading" });
      await applyDownloadJob(job, update, patch, trigger);
    }

    // 4) 上传（只传脏片）
    if (uploads.length > 0) {
      update({ status: "uploading" });
      const quota = await cloudQuota().catch(() => ({ pluginBytes: 200 * 1024 * 1024, shardBytes: 200 * 1024 * 1024 }));
      for (const job of uploads) {
        const res = await cloudShardPut(job.scope, job.ls);
        job.result = { digest: res.digest, bytes: res.bytes };
        debug(`[云同步] ${trigger}: 上传 ${job.scope} ${res.bytes} 字节`);
        if (job.pluginId && job.kind === "data") {
          const bodyBytes = digests.plugins[job.pluginId]?.body.bytes ?? 0;
          if (bodyBytes + res.bytes > quota.pluginBytes) {
            warnQuota.push(`${job.pluginId} 超过 ${Math.round(quota.pluginBytes / 1024 / 1024)}MB`);
          }
        }
      }
    }

    // 5) 提交 manifest（最后一步）
    const outManifest = buildOutManifest(
      remoteManifest,
      digests,
      uploads,
      removed,
      persisted.deviceId,
      persisted.deviceName,
      digests.appVersion || appVersion,
      now,
      uploads.some((j) => j.kind === "core")
    );
    const committed = await commitManifest(
      outManifest,
      // 有 ETag 才能做条件提交；服务器不给 ETag 时只能无条件写（这是服务器能力限制）
      manifest.etag ? manifest.etag : null,
      touchedOf(uploads),
      removed,
      persisted.deviceId,
      persisted.deviceName
    );
    update({ remoteMeta: { exists: true, rev: committed.rev, etag: committed.etag, modified: committed.modified, size: committed.size } });

    // 6) 落基线（冲突挂起的片**不推进基线**，否则下一轮会误判成「仅本机改」而上传）
    const nextBaseline = baselineAfter(remoteManifest, uploads, base, pending, heldKeys);
    const nextPending = { ...pending };
    for (const job of downloads) {
      if (job.kind === "data" && job.pluginId) delete nextPending[job.pluginId];
    }

    const nowAt = Date.now();
    await patch({
      initialized: true,
      cloudFormat: 2,
      manifestEtag: committed.etag,
      remoteRev: committed.rev,
      remoteEtag: committed.etag,
      shards: nextBaseline,
      pending: nextPending,
      conflicts,
      lastSyncAt: nowAt,
      lastLocalDigest: digests.core.digest,
    });
    update({
      status: conflicts.length ? "needs-choice" : "idle",
      needsChoice: conflicts.length > 0,
      choiceReason: conflicts.length ? "conflict" : "",
      conflicts,
      lastError: warnQuota.length ? `配额提示：${warnQuota.join("；")}` : "",
      lastSyncAt: nowAt,
      localDigest: digests.core.digest,
      initialized: true,
      remoteRev: committed.rev,
      remoteMeta: { exists: true, rev: committed.rev, etag: committed.etag, modified: committed.modified, size: committed.size },
    });
    debug(
      `[云同步] ${trigger}: 完成 ${Date.now() - startedAt}ms（下载 ${downloads.length} 片 / 上传 ${uploads.length} 片 / 待下载 ${Object.keys(nextPending).length} 个插件数据）`
    );
    return { ...state };
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    update({ status: "error", lastError: msg });
    warn(`[云同步] 失败 (${trigger}):`, msg);
    return { ...state };
  }
}

/** 用户选择优先于策略表：`local` → 冲突当上传，`remote` → 当下载 */
function resolveAction(action: ShardAction, choice?: "local" | "remote"): ShardAction {
  if (action !== "conflict" || !choice) return action;
  return choice === "local" ? "upload" : "download";
}

/**
 * 首次建立（远端还没有 v2 manifest）。
 *
 * 三种情况：
 * 1. 远端连 v1 整包都没有 → 直接把本机推成 v2；
 * 2. 远端有 v1 整包、本机从没同步过 → 让用户选（与 v1 一致的语义）；
 * 3. 远端有 v1 整包、且是上次同步的那个版本 → 本机推 v2（本机可能更新）；
 *    如果不是上次那个版本（别的设备改过）→ 先拉 v1 整包再推。
 */
async function bootstrap(
  ctx: {
    config: SyncConfig;
    persisted: SyncPersistedState;
    state: SyncRunState;
    update: (p: Partial<SyncRunState>) => void;
    patch: (p: Record<string, unknown>) => Promise<void>;
    opts: CloudRoundOptions;
    trigger: string;
    appVersion: string;
  },
  _manifest: CloudManifestResult
): Promise<SyncRunState> {
  const { state, update, patch, opts, trigger } = ctx;

  let legacy: { exists: boolean; etag: string } | null = null;
  try {
    const meta = await syncRemoteMeta();
    legacy = { exists: meta.exists, etag: meta.etag };
  } catch {
    legacy = null;
  }

  // 已经用过 v2 的设备（remoteEtag 存的是 manifest ETag，不是整包 ETag）：
  // 此时 manifest 不见了只可能是「云端目录被删」，绝不能拿旧整包覆盖本机数据。
  const usedV2 = (ctx.persisted.cloudFormat ?? 0) === 2;

  if (!usedV2) {
    if (legacy?.exists && !ctx.persisted.initialized) {
      if (!opts.choice) {
        update({ status: "needs-choice", needsChoice: true, choiceReason: "first-connect" });
        return { ...state };
      }
      if (opts.choice === "remote") {
        await pullLegacyArchive(ctx.persisted, update, trigger);
      }
    } else if (legacy?.exists && ctx.persisted.initialized) {
      const remoteChanged = !!legacy.etag && legacy.etag !== ctx.persisted.remoteEtag;
      if (remoteChanged) {
        await pullLegacyArchive(ctx.persisted, update, trigger);
      }
    }
  }

  // 推全量（迁移完成后 v1 整包保留在原处，可回滚）
  const ls = splitStateByShard();
  const digests = await cloudDigests(ls);
  const out: CloudManifest = {
    schema: CLOUD_SCHEMA,
    rev: 1,
    updatedAt: Date.now(),
    updatedBy: ctx.persisted.deviceId,
    appVersion: digests.appVersion || ctx.appVersion,
    devices: {
      [ctx.persisted.deviceId]: {
        name: ctx.persisted.deviceName || undefined,
        appVersion: digests.appVersion || ctx.appVersion,
        lastSyncAt: Date.now(),
      },
    },
    core: { digest: digests.core.digest, bytes: digests.core.bytes, updatedAt: Date.now() },
    plugins: {},
  };

  update({ status: "uploading" });
  await cloudShardPut("core", ls.core);
  const touched = new Set<string>(["core"]);
  const baseline: ShardsBaseline = { core: digests.core.digest, plugins: {} };
  for (const [id, d] of Object.entries(digests.plugins)) {
    if (d.body.files > 0) {
      const body = await cloudShardPut(`body:${id}`, {});
      touched.add(`${id}:body`);
      out.plugins[id] = {
        ...(out.plugins[id] ?? {}),
        body: { digest: body.digest, bytes: body.bytes, updatedAt: Date.now() },
      };
      baseline.plugins[id] = { body: body.digest, data: "" };
    }
    if (d.data.files > 0 || Object.keys(ls.plugins[id] ?? {}).length > 0) {
      const data = await cloudShardPut(`data:${id}`, ls.plugins[id] ?? {});
      touched.add(`${id}:data`);
      out.plugins[id] = {
        ...(out.plugins[id] ?? {}),
        data: { digest: data.digest, bytes: data.bytes, updatedAt: Date.now() },
      };
      baseline.plugins[id] = {
        body: out.plugins[id]?.body?.digest ?? "",
        data: data.digest,
      };
    }
  }
  const committed = await commitManifest(
    out,
    "",
    touched,
    [],
    ctx.persisted.deviceId,
    ctx.persisted.deviceName
  );
  const now = Date.now();
  await patch({
    initialized: true,
    cloudFormat: 2,
    manifestEtag: committed.etag,
    remoteRev: committed.rev,
    remoteEtag: committed.etag,
    shards: baseline,
    pending: {},
    conflicts: [],
    lastSyncAt: now,
    lastLocalDigest: digests.core.digest,
  });
  update({
    status: "idle",
    lastError: "",
    lastSyncAt: now,
    localDigest: digests.core.digest,
    initialized: true,
    remoteRev: committed.rev,
    remoteMeta: { exists: true, rev: committed.rev, etag: committed.etag, modified: committed.modified, size: committed.size },
  });
  debug(`[云同步] ${trigger}: 首次建立完成（core + ${Object.keys(out.plugins).length} 个插件）`);
  return { ...state };
}

/** 下载并还原 v1 整包（迁移用） */
async function pullLegacyArchive(
  persisted: SyncPersistedState,
  update: (p: Partial<SyncRunState>) => void,
  trigger: string
): Promise<void> {
  update({ status: "downloading" });
  const result = await syncDownload(persisted.remoteEtag || null);
  if (result.notModified) return;
  const restored = await backupRestore(result.path, ["all"], collectState());
  restoreState((restored.localStorage ?? {}) as Record<string, unknown>, {
    silent: true,
    keepLocalPluginIds: restored.downgradeSkipped ?? [],
  });
  await syncCommitApplied("cloud", restored.scope ?? "all");
  debug(`[云同步] ${trigger}: 已迁移 v1 整包`);
}

/** 把远端全部片拉到本机（用户选择「使用云端」时） */
async function pullAllShards(
  manifest: CloudManifest,
  update: (p: Partial<SyncRunState>) => void,
  patch: (p: Record<string, unknown>) => Promise<void>,
  _opts: CloudRoundOptions,
  trigger: string,
  o: { includeData: boolean }
): Promise<void> {
  update({ status: "downloading" });
  await preserveLocalBeforeDownload(update);
  const baseline: ShardsBaseline = { core: "", plugins: {} };
  if (!manifest.core?.digest) throw new Error("云端 manifest 缺少内核分片");
  await applyDownloadJob(
    { kind: "core", rel: shardRel("core", manifest.core.digest), digest: manifest.core.digest },
    update,
    patch,
    trigger
  );
  baseline.core = manifest.core.digest;
  for (const [id, p] of Object.entries(manifest.plugins ?? {})) {
    if (p.body?.digest) {
      await applyDownloadJob(
        { kind: "body", pluginId: id, rel: shardRel("body", p.body.digest, id), digest: p.body.digest },
        update,
        patch,
        trigger
      );
    }
    if (o.includeData && p.data?.digest) {
      await applyDownloadJob(
        { kind: "data", pluginId: id, rel: shardRel("data", p.data.digest, id), digest: p.data.digest },
        update,
        patch,
        trigger
      );
    }
    baseline.plugins[id] = {
      body: p.body?.digest ?? "",
      data: o.includeData ? p.data?.digest ?? "" : "",
    };
  }
  const now = Date.now();
  await patch({
    initialized: true,
    cloudFormat: 2,
    shards: baseline,
    pending: {},
    conflicts: [],
    lastSyncAt: now,
  });
  update({ status: "idle", lastError: "", lastSyncAt: now, initialized: true, needsChoice: false, choiceReason: "", conflicts: [] });
  debug(`[云同步] ${trigger}: 已从云端拉取全部分片`);
}

/**
 * 覆盖本机之前留一份可回滚的整机快照。
 *
 * v2 的对象是内容寻址的，云端旧对象不会立刻消失；但「本机被远端覆盖」这件事
 * 一旦发生，用户在本机就找不到原数据了。所以真正落地下载前先在 `backups/`
 * 留一个 `.msbackup`，面板可以据此回滚。
 *
 * 失败只记日志不阻断：磁盘满等情况下，同步本身不该被「留底」拖死；
 * 但状态里会保持空路径，面板不会假装有备份。
 */
async function preserveLocalBeforeDownload(
  update: (p: Partial<SyncRunState>) => void
): Promise<void> {
  try {
    const path = await backupSnapshot(collectBackupState(), "pre-remote-");
    update({ lastLocalBackupPath: path });
    debug(`[云同步] 覆盖前已留底: ${path}`);
  } catch (e) {
    warn(`[云同步] 覆盖前留底失败（继续同步）: ${(e as Error)?.message ?? e}`);
  }
}

/** 下载一个分片并按类型落地 */
async function applyDownloadJob(  job: DownloadJob,
  update: (p: Partial<SyncRunState>) => void,
  patch: (p: Record<string, unknown>) => Promise<void>,
  trigger: string
): Promise<void> {
  const got = await cloudShardGet(job.rel);
  if (job.kind === "core") {
    // 只还原「设置 + 非插件 localStorage + 内部状态」：不带 plugins / pluginData 分类，
    // 避免内核片落地时停掉所有插件后台进程（内核片本来也不含插件文件）。
    const rep = await backupRestore(got.path, ["config", "localStorage", "internal"], collectState());
    restoreState((rep.localStorage ?? {}) as Record<string, unknown>, {
      silent: true,
      keepLocalPluginIds: rep.downgradeSkipped ?? [],
    });
    await syncCommitApplied("cloud", rep.scope ?? "all");
  } else if (job.kind === "body" && job.pluginId) {
    await backupRestorePluginShard(got.path, job.pluginId);
    await syncCommitApplied("cloud", "plugins");
  } else if (job.kind === "data" && job.pluginId) {
    const rep = await backupRestore(got.path, ["pluginData"], collectState());
    restoreState((rep.localStorage ?? {}) as Record<string, unknown>, { silent: true });
    await syncCommitApplied("cloud", "plugins");
  }
  debug(`[云同步] ${trigger}: 已下载 ${job.rel}`);
}

/** 把本机全部片推上去（首次连接 / 用户选择「本机覆盖远端」） */
async function pushAllShards(
  config: SyncConfig,
  persisted: SyncPersistedState,
  remoteManifest: CloudManifest,
  ifMatch: string | null,
  update: (p: Partial<SyncRunState>) => void,
  patch: (p: Record<string, unknown>) => Promise<void>,
  trigger: string
): Promise<void> {
  update({ status: "uploading" });
  const ls = splitStateByShard();
  const digests = await cloudDigests(ls);
  const now = Date.now();
  const out: CloudManifest = {
    ...remoteManifest,
    rev: (remoteManifest.rev ?? 0) + 1,
    updatedAt: now,
    updatedBy: persisted.deviceId,
    appVersion: digests.appVersion,
    devices: {
      ...(remoteManifest.devices ?? {}),
      [persisted.deviceId]: {
        name: persisted.deviceName || undefined,
        appVersion: digests.appVersion,
        lastSyncAt: now,
      },
    },
    core: { digest: digests.core.digest, bytes: digests.core.bytes, updatedAt: now },
    plugins: { ...(remoteManifest.plugins ?? {}) },
  };
  const baseline: ShardsBaseline = { core: digests.core.digest, plugins: {} };
  const touched = new Set<string>(["core"]);
  await cloudShardPut("core", ls.core);
  for (const [id, d] of Object.entries(digests.plugins)) {
    if (d.body.files > 0) {
      const body = await cloudShardPut(`body:${id}`, {});
      touched.add(`${id}:body`);
      out.plugins[id] = { ...(out.plugins[id] ?? {}), body: { digest: body.digest, bytes: body.bytes, updatedAt: now } };
      baseline.plugins[id] = { body: body.digest, data: out.plugins[id]?.data?.digest ?? "" };
    }
    const hasData = d.data.files > 0 || Object.keys(ls.plugins[id] ?? {}).length > 0;
    if (hasData) {
      const data = await cloudShardPut(`data:${id}`, ls.plugins[id] ?? {});
      touched.add(`${id}:data`);
      out.plugins[id] = { ...(out.plugins[id] ?? {}), data: { digest: data.digest, bytes: data.bytes, updatedAt: now } };
      baseline.plugins[id] = {
        body: baseline.plugins[id]?.body ?? out.plugins[id]?.body?.digest ?? "",
        data: data.digest,
      };
    }
  }
  const committed = await commitManifest(
    out,
    ifMatch,
    touched,
    [],
    persisted.deviceId,
    persisted.deviceName
  );
  const at = Date.now();
  await patch({
    initialized: true,
    cloudFormat: 2,
    manifestEtag: committed.etag,
    remoteRev: committed.rev,
    remoteEtag: committed.etag,
    shards: baseline,
    pending: {},
    conflicts: [],
    lastSyncAt: at,
    lastLocalDigest: digests.core.digest,
  });
  update({
    status: "idle",
    lastError: "",
    lastSyncAt: at,
    localDigest: digests.core.digest,
    initialized: true,
    needsChoice: false,
    choiceReason: "",
    conflicts: [],
    remoteRev: committed.rev,
    remoteMeta: { exists: true, rev: committed.rev, etag: committed.etag, modified: committed.modified, size: committed.size },
  });
  debug(`[云同步] ${trigger}: 已推送全部分片（conflict=${config.conflict}）`);
}

/** 组装本轮提交的 manifest（远端未动的片沿用远端引用，本机上传的片覆盖） */
function buildOutManifest(
  remote: CloudManifest,
  digests: CloudDigests,
  uploads: UploadJob[],
  removed: string[],
  deviceId: string,
  deviceName: string,
  appVersion: string,
  now: number,
  coreUploaded: boolean
): CloudManifest {
  const out: CloudManifest = {
    schema: CLOUD_SCHEMA,
    rev: (remote.rev ?? 0) + 1,
    updatedAt: now,
    updatedBy: deviceId,
    appVersion: appVersion || remote.appVersion,
    // 设备表只增不减（真正的过期清理留给 GC）；名字来自本机电脑名
    devices: {
      ...(remote.devices ?? {}),
      [deviceId]: {
        name: deviceName || undefined,
        appVersion: appVersion || remote.appVersion,
        lastSyncAt: now,
      },
    },
    // 内核片没上传（未变 / 已下载 / 冲突挂起）时保持远端引用：绝不能指向本机旧摘要
    core: coreUploaded
      ? refOf(digests.core.digest, digests.core.bytes, now, remote.core)
      : (remote.core ?? { digest: "", bytes: 0, updatedAt: 0 }),
    plugins: {},
  };
  // 沿用远端已有的插件片引用（未改动 / 已下载的都保持远端版本）
  for (const [id, p] of Object.entries(remote.plugins ?? {})) {
    out.plugins[id] = { ...p };
  }
  // 只把**真正上传过**的片写成新引用：没上传的片绝不能指向本机摘要，
  // 否则 manifest 会指向云端不存在的对象。
  for (const job of uploads) {
    const res = job.result;
    if (!res) continue;
    if (job.kind === "core") {
      out.core = { digest: res.digest, bytes: res.bytes, updatedAt: now };
    } else if (job.pluginId) {
      const entry = (out.plugins[job.pluginId] ??= {});
      entry[job.kind] = { digest: res.digest, bytes: res.bytes, updatedAt: now };
    }
  }
  for (const id of removed) delete out.plugins[id];
  for (const id of Object.keys(out.plugins)) {
    if (!out.plugins[id].body && !out.plugins[id].data) delete out.plugins[id];
  }
  return out;
}

/** 本轮真正上传过的分片键（`core` / `<id>:body` / `<id>:data`），供 412 合并时区分「本机新片」与「远端新片」 */
function touchedOf(uploads: UploadJob[]): Set<string> {
  const s = new Set<string>();
  for (const job of uploads) {
    if (!job.result) continue;
    s.add(job.kind === "core" ? "core" : `${job.pluginId}:${job.kind}`);
  }
  return s;
}

/** 本轮结束后的分片基线：远端片用远端摘要，本轮上传的片用新摘要 */
function baselineAfter(
  remote: CloudManifest,
  uploads: UploadJob[],
  base: ShardsBaseline,
  pending: Record<string, string>,
  held: Set<string>
): ShardsBaseline {
  const next: ShardsBaseline = { core: base.core, plugins: { ...(base.plugins ?? {}) } };
  if (remote.core?.digest && !held.has("core")) next.core = remote.core.digest;
  for (const [id, p] of Object.entries(remote.plugins ?? {})) {
    const cur = (next.plugins[id] ??= { body: "", data: "" });
    if (p.body?.digest && !held.has(`${id}:body`)) cur.body = p.body.digest;
    // pending 表示「远端有数据、本机还没拉」：基线不能声称已对齐
    if (p.data?.digest && pending[id] === undefined && !held.has(`${id}:data`)) {
      cur.data = p.data.digest;
    }
  }
  for (const job of uploads) {
    if (!job.result) continue;
    if (job.kind === "core") next.core = job.result.digest;
    else if (job.pluginId) {
      const cur = (next.plugins[job.pluginId] ??= { body: "", data: "" });
      cur[job.kind] = job.result.digest;
    }
  }
  return next;
}

/** 提交 manifest；412 时重读远端合并后重试一次（对象已上传，只需重写指针） */
async function commitManifest(
  manifest: CloudManifest,
  ifMatch: string | null,
  touched: Set<string>,
  removed: string[],
  deviceId: string,
  deviceName = ""
): Promise<{ etag: string; rev: string; size: number; modified: number }> {
  try {
    const res = await cloudManifestPut(manifest, ifMatch);
    return { etag: res.etag, rev: String(manifest.rev), size: res.size, modified: res.modified };
  } catch (e) {
    if (!isCommitConflict(e)) throw e;
    warn("[云同步] manifest 提交冲突，重读远端后重试");
    const fresh = await cloudManifestGet();
    const freshManifest = fresh.manifest ?? emptyManifest(deviceId, manifest.appVersion);
    // 只有本轮**真正上传过**的片才允许用本机引用；其余一律取刚读到的远端版本。
    // 否则会把别的设备在这几秒内刚提交的分片指针回滚成旧值（对象还在，但 manifest 不再引用）。
    const mergedPlugins: CloudManifest["plugins"] = {};
    for (const [id, p] of Object.entries(freshManifest.plugins ?? {})) {
      mergedPlugins[id] = { ...p };
    }
    for (const [id, p] of Object.entries(manifest.plugins ?? {})) {
      const cur = (mergedPlugins[id] ??= {});
      if (touched.has(`${id}:body`) && p.body) cur.body = p.body;
      if (touched.has(`${id}:data`) && p.data) cur.data = p.data;
      if (p.pluginVersion) cur.pluginVersion = p.pluginVersion;
    }
    for (const id of removed) delete mergedPlugins[id];
    for (const id of Object.keys(mergedPlugins)) {
      if (!mergedPlugins[id].body && !mergedPlugins[id].data) delete mergedPlugins[id];
    }
    const merged: CloudManifest = {
      ...manifest,
      rev: (freshManifest.rev ?? manifest.rev) + 1,
      updatedAt: Date.now(),
      updatedBy: deviceId,
      // 412 期间别的设备可能刚写了设备表：以刚读到的为准，再补/更新本机一行
      devices: {
        ...(freshManifest.devices ?? {}),
        [deviceId]: {
          ...(freshManifest.devices?.[deviceId] ?? {}),
          name: deviceName || freshManifest.devices?.[deviceId]?.name,
          appVersion: manifest.appVersion,
          lastSyncAt: Date.now(),
        },
      },
      plugins: mergedPlugins,
      core: touched.has("core") ? manifest.core : (freshManifest.core ?? manifest.core),
    };
    const res = await cloudManifestPut(merged, fresh.etag ? fresh.etag : null);
    return { etag: res.etag, rev: String(merged.rev), size: res.size, modified: res.modified };
  }
}

/**
 * 按需下载某个插件的**数据分片**（懒加载）。
 *
 * 调用时机：用户打开该插件、或在面板点「下载数据」。只有「远端有更新、本机
 * 没改过」才自动落地；两边都改过时按冲突策略处理，`ask` 返回 `conflict`
 * 让界面问用户，绝不静默覆盖。
 */
export async function ensurePluginData(pluginId: string): Promise<{
  status: "ready" | "applied" | "conflict" | "disabled" | "missing" | "error";
  message?: string;
}> {
  try {
    const { syncGetConfig, syncStateGet, syncStatePatch } = await import("./bridge");
    const config = await syncGetConfig();
    if (!config.enabled) return { status: "disabled" };
    const st = await syncStateGet();
    const pending = st.pending ?? {};
    if (pending[pluginId] === undefined) return { status: "ready" };

    const manifest = await cloudManifestGet();
    const entry = manifest.manifest?.plugins?.[pluginId];
    if (!entry?.data?.digest) return { status: "missing" };

    const ls = splitStateByShard();
    const digests = await cloudDigests(ls);
    const localData = digests.plugins[pluginId]?.data;
    const baseData = st.shards?.plugins?.[pluginId]?.data ?? "";
    const localChanged = !!localData && localData.digest !== baseData;

    if (localChanged) {
      if (config.conflict === "local") {
        const next = { ...pending };
        delete next[pluginId];
        await syncStatePatch({ pending: next });
        return { status: "conflict", message: "本机数据也改过，已保留本机（策略：本机优先）" };
      }
      if (config.conflict === "ask") {
        return { status: "conflict", message: "本机与云端都有改动，请在同步面板选择保留哪边" };
      }
      // remote / newer：以云端为准
    }

    const got = await cloudShardGet(shardRel("data", entry.data.digest, pluginId));
    const rep = await backupRestore(got.path, ["pluginData"], collectState());
    restoreState((rep.localStorage ?? {}) as Record<string, unknown>, { silent: true });
    await syncCommitApplied("cloud", "plugins");

    const nextPending = { ...pending };
    delete nextPending[pluginId];
    const shards = st.shards ?? { core: "", plugins: {} };
    shards.plugins[pluginId] = {
      body: shards.plugins[pluginId]?.body ?? entry.body?.digest ?? "",
      data: entry.data.digest,
    };
    await syncStatePatch({ pending: nextPending, shards });
    return { status: "applied" };
  } catch (e) {
    return { status: "error", message: (e as Error)?.message ?? String(e) };
  }
}

/** 云端某插件「具体有哪些东西」：两片各自的文件清单（按需下载解析，不污染 manifest） */
export interface CloudPluginContentEntry {
  shard: "body" | "data";
  name: string;
  size: number;
  /** v3：这个条目是单个文件还是 blob（面板可显示不同图标/说明） */
  kind?: "file" | "blob";
}

export interface CloudPluginContent {
  id: string;
  entries: CloudPluginContentEntry[];
  bodyBytes: number;
  dataBytes: number;
  totalBytes: number;
  truncated: boolean;
}

export async function cloudPluginContents(pluginId: string): Promise<CloudPluginContent> {
  const v3 = await cloudManifestV3Get().catch(() => ({ exists: false, manifest: null }) as const);
  if (v3.exists && v3.manifest) {
    const entry = v3.manifest.plugins?.[pluginId];
    const out: CloudPluginContent = {
      id: pluginId,
      entries: [],
      bodyBytes: entry?.body?.bytes ?? 0,
      dataBytes: 0,
      totalBytes: 0,
      truncated: false,
    };
    for (const [path, ref] of Object.entries(entry?.files ?? {})) {
      out.entries.push({ shard: "data", kind: "file", name: path, size: ref.bytes });
      out.dataBytes += ref.bytes;
    }
    for (const [path, ref] of Object.entries(entry?.blobs ?? {})) {
      out.entries.push({ shard: "data", kind: "blob", name: path, size: ref.bytes });
      out.dataBytes += ref.bytes;
    }
    out.totalBytes = out.bodyBytes + out.dataBytes;
    return out;
  }

  const manifest = await cloudManifestGet();
  const entry = manifest.manifest?.plugins?.[pluginId];
  const out: CloudPluginContent = {
    id: pluginId,
    entries: [],
    bodyBytes: 0,
    dataBytes: 0,
    totalBytes: 0,
    truncated: false,
  };
  if (entry?.body?.digest) {
    const r = await cloudShardInspect(shardRel("body", entry.body.digest, pluginId));
    out.bodyBytes = r.bytes;
    out.truncated ||= r.truncated;
    out.entries.push(...r.entries.map((e) => ({ shard: "body" as const, ...e })));
  }
  if (entry?.data?.digest) {
    const r = await cloudShardInspect(shardRel("data", entry.data.digest, pluginId));
    out.dataBytes = r.bytes;
    out.truncated ||= r.truncated;
    out.entries.push(...r.entries.map((e) => ({ shard: "data" as const, ...e })));
  }
  out.totalBytes = out.bodyBytes + out.dataBytes;
  return out;
}

/** 面板用的「各插件云端占用」视图 */export interface PluginCloudUsage {
  id: string;
  cloudBytes: number;
  localBytes: number;
  pendingData: boolean;
  quotaBytes: number;
  remainingBytes: number;
  bodyBytes: number;
  dataBytes: number;
  /** v3：文件对象数 / blob 数 */
  fileCount?: number;
  blobCount?: number;
  /** v3：本机是否真的装了（`undefined` = 本机摘要读不到，状态未知） */
  installed?: boolean;
  /** v3：云端有内容、本机没装（面板显示「本机未安装」，可「恢复到本机」） */
  absent?: boolean;
}

export interface CloudOverview {
  enabled: boolean;
  manifestExists: boolean;
  /** 云端实际使用的格式：2 = 分片，3 = 每文件对象 */
  format?: 2 | 3;
  rev: number;
  updatedAt: number;
  updatedBy: string;
  totalBytes: number;
  plugins: PluginCloudUsage[];
  pendingCount: number;
  quotaBytes: number;
}

/** 汇总云端各插件占用 + 本机占用（面板打开时调用，不联网之外的额外开销） */
export async function cloudOverview(): Promise<CloudOverview> {
  const { syncGetConfig, syncStateGet } = await import("./bridge");
  const [config, st, manifest, v3manifest, quota, digests] = await Promise.all([
    syncGetConfig(),
    syncStateGet(),
    cloudManifestGet().catch(() => ({ exists: false, manifest: null }) as CloudManifestResult),
    cloudManifestV3Get().catch(() => ({ exists: false, manifest: null }) as const),
    cloudQuota(),
    cloudDigests(splitStateByShard()).catch(() => null),
  ]);
  const pending = st.pending ?? {};
  const plugins: PluginCloudUsage[] = [];
  let totalBytes = 0;

  if (v3manifest.exists && v3manifest.manifest) {
    const m = v3manifest.manifest;
    const ids = new Set<string>([...Object.keys(m.plugins ?? {}), ...Object.keys(digests?.plugins ?? {})]);
    for (const id of ids) {
      const ref = m.plugins?.[id];
      const bodyBytes = ref?.body?.bytes ?? 0;
      const fileBytes = Object.values(ref?.files ?? {}).reduce((n, f) => n + f.bytes, 0);
      const blobBytes = Object.values(ref?.blobs ?? {}).reduce((n, b) => n + b.bytes, 0);
      const dataBytes = fileBytes + blobBytes;
      const cloudBytes = bodyBytes + dataBytes;
      totalBytes += cloudBytes;
      const local = digests?.plugins[id];
      const localBytes =
        (local?.body.bytes ?? 0) + (local?.data.bytes ?? 0);
      // 「装了」以主体为准：只有 plugin-data 目录（卸载残留）不算能运行的安装。
      // `digests` 读不到（null）时保持 undefined，不能误报成「未安装」。
      const installed = digests ? (local?.body.files ?? 0) > 0 : undefined;
      const absent = installed === false && cloudBytes > 0;
      plugins.push({
        id,
        cloudBytes,
        localBytes,
        pendingData: false,
        quotaBytes: quota.pluginBytes,
        remainingBytes: Math.max(0, quota.pluginBytes - cloudBytes),
        bodyBytes,
        dataBytes,
        fileCount: Object.keys(ref?.files ?? {}).length,
        blobCount: Object.keys(ref?.blobs ?? {}).length,
        installed,
        absent,
      });
    }
    plugins.sort((a, b) => b.cloudBytes - a.cloudBytes);
    const absentCount = plugins.filter((p) => p.absent).length;
    return {
      enabled: !!config.enabled,
      manifestExists: true,
      format: 3,
      rev: m.rev ?? 0,
      updatedAt: m.updatedAt ?? 0,
      updatedBy: m.updatedBy ?? "",
      totalBytes,
      plugins,
      pendingCount: absentCount,
      quotaBytes: quota.pluginBytes,
    };
  }

  const m = manifest.manifest;
  const ids = new Set<string>([
    ...Object.keys(m?.plugins ?? {}),
    ...Object.keys(digests?.plugins ?? {}),
    ...Object.keys(pending),
  ]);
  for (const id of ids) {
    const ref = m?.plugins?.[id];
    const bodyBytes = ref?.body?.bytes ?? 0;
    const dataBytes = ref?.data?.bytes ?? 0;
    const cloudBytes = bodyBytes + dataBytes;
    totalBytes += cloudBytes;
    const localBytes =
      (digests?.plugins[id]?.body.bytes ?? 0) + (digests?.plugins[id]?.data.bytes ?? 0);
    plugins.push({
      id,
      cloudBytes,
      localBytes,
      pendingData: pending[id] !== undefined,
      quotaBytes: quota.pluginBytes,
      remainingBytes: Math.max(0, quota.pluginBytes - cloudBytes),
      bodyBytes,
      dataBytes,
    });
  }
  plugins.sort((a, b) => b.cloudBytes - a.cloudBytes);
  return {
    enabled: !!config.enabled,
    manifestExists: !!manifest.exists,
    format: 2,
    rev: m?.rev ?? 0,
    updatedAt: m?.updatedAt ?? 0,
    updatedBy: m?.updatedBy ?? "",
    totalBytes,
    plugins,
    pendingCount: Object.keys(pending).length,
    quotaBytes: quota.pluginBytes,
  };
}
