/**
 * 同步内核 —— 基于**持久化状态 + 内容摘要**的单轮决策。
 *
 * 为什么重写
 * ----------
 * 旧内核把「上次同步时间」放在内存里，于是：
 *   - 设置窗口一关就归零 → 主窗口首次自动同步永远判成「本机更新」；
 *   - 判断依据是远端 `Last-Modified`，与「本机到底变没变」无关 → 只要远端
 *     时间戳旧于本机内存时间，就静默跳过远端的新数据；
 *   - 上传是无条件 PUT → 两个设备同时改会互相覆盖且不可恢复。
 *
 * 新内核只做三件事：
 *   1. 用 `state.lastLocalDigest` 与本机当前摘要比较，判断**本机**是否变化；
 *   2. 用 `state.remoteRev` 与远端当前 rev 比较，判断**远端**是否变化；
 *   3. 两边都变才叫冲突：按用户策略决策，无法安全决策时进入 `needs-choice`，
 *      绝不擅自覆盖任何一边。
 *
 * 上传一律带条件（首次 `If-None-Match: *`，后续 `If-Match: <etag>`）；
 * 服务器返回 412 时重新读远端并重新决策，而不是把冲突当成普通失败。
 *
 * 下载一律走「Rust 事务还原 + 前端静默写回 + `sync_commit_applied` 广播」，
 * 插件重载由 `sync://applied` 的订阅方统一协调。
 */

import {
  backupSnapshot,
  backupRestore,
  syncCommitApplied,
  syncDownload,
  syncRemoteMeta,
  syncUpload,
  type RemoteMeta,
  type SyncConfig,
  type SyncPersistedState,
} from "./bridge";
import { collectState, pruneState, restoreState, stateDigest } from "./snapshot";
import { debug, warn } from "../../lib/logger";

/** 默认兜底检查间隔（毫秒） */
const DEFAULT_CHECK_INTERVAL_MS = 30 * 60 * 1000;

/** 数据变更后自动同步的节流时间（5 秒，合并连续编辑） */
export const ON_CHANGE_THROTTLE_MS = 5000;

/** 状态更新允许写入的持久化字段 */
export type SyncStatePatch = Partial<
  Pick<
    SyncPersistedState,
    "initialized" | "remoteRev" | "remoteEtag" | "lastLocalDigest" | "lastSyncAt" | "appliedRev"
  >
>;

/** 决策结果 */
export type SyncAction =
  | "upload"
  | "force-upload"
  | "download"
  | "skip"
  | "needs-choice";

/** 决策输入（纯数据，便于单测） */
export interface SyncDecisionInput {
  config: Pick<SyncConfig, "enabled" | "conflict">;
  remote: RemoteMeta | null;
  state: Pick<
    SyncPersistedState,
    "initialized" | "remoteRev" | "lastLocalDigest" | "lastSyncAt"
  >;
  /** 本机当前快照摘要 */
  localDigest: string;
  /** 用户对 needs-choice 的选择（本轮有效） */
  choice?: "local" | "remote";
}

/**
 * 冲突决策：根据持久化基线、本机摘要与远端状态决定本轮动作。
 *
 * 规则表（`localChanged` = 本机摘要与上次同步基线不同）：
 * | 远端 | 初始化 | rev 相同 | localChanged | 动作 |
 * |------|--------|----------|--------------|------|
 * | 不存在 | * | - | * | upload（首次用 If-None-Match） |
 * | 存在 | 否 | - | * | needs-choice（首次连接不自动传输） |
 * | 存在 | 是 | 是 | 否 | skip |
 * | 存在 | 是 | 是 | 是 | upload（条件上传） |
 * | 存在 | 是 | 否 | 否 | download（只有远端变了） |
 * | 存在 | 是 | 否 | 是 | 冲突：按策略 / needs-choice |
 */
export function decideAction(input: SyncDecisionInput): SyncAction {
  const { config, remote, state, localDigest, choice } = input;

  if (choice === "remote") return "download";
  if (choice === "local") {
    // 用户明确选择本机覆盖远端：无条件上传（这是唯一允许绕过 If-Match 的路径）
    return "force-upload";
  }

  if (!config.enabled) return "skip";

  // 远端为空：建立第一份基线（即使 state 显示已初始化，也说明远端被删了）
  if (!remote || !remote.exists) return "upload";

  // 远端已有备份、但本机从没和它建立过同步关系 → 必须让用户选
  if (!state.initialized) return "needs-choice";

  const localChanged = state.lastLocalDigest !== localDigest;
  const remoteChanged = remote.rev !== state.remoteRev;

  if (!remoteChanged) return localChanged ? "upload" : "skip";
  if (!localChanged) return "download";

  // 两边都变了：只有明确的用户策略才允许自动覆盖
  switch (config.conflict) {
    case "local":
      return "force-upload";
    case "remote":
      return "download";
    case "newer":
      // 保留「按修改时间」的直观语义：远端在上次成功同步后变过 → 远端新。
      // 注意这里只用于**冲突裁决**，不再用于判断「需不需要同步」。
      return remote.modified > state.lastSyncAt ? "download" : "force-upload";
    case "ask":
    default:
      return "needs-choice";
  }
}

/** 同步状态（供面板/插件绑定） */
export interface SyncRunState {
  status: "idle" | "syncing" | "uploading" | "downloading" | "error" | "needs-choice";
  lastSyncAt: number;
  lastError: string;
  /** 远端是否有备份、版本号 */
  remoteMeta: RemoteMeta | null;
  /** 本机当前摘要（诊断用） */
  localDigest: string;
  /** 是否已建立同步基线 */
  initialized: boolean;
  /** 当前远端版本（持久化基线） */
  remoteRev: string;
  /** 是否等待用户选择 */
  needsChoice: boolean;
  /** 为什么需要选择 */
  choiceReason: "" | "first-connect" | "conflict";
  /** 还原代次（用于丢弃旧回调） */
  epoch: number;
}

/** 一次同步轮次的依赖 */
export interface SyncRoundOptions {
  /** 读同步配置（每轮实时读，避免别的窗口改过后用陈旧值） */
  getConfig: () => SyncConfig | Promise<SyncConfig>;
  /** 读持久化同步状态 */
  getState: () => SyncPersistedState | Promise<SyncPersistedState>;
  /** 写持久化同步状态 */
  patchState: (patch: SyncStatePatch) => Promise<SyncPersistedState>;
  /** 读快捷键绑定（摘要额外项；Rust 设置，异步读取） */
  getShortcutBindings?: () => unknown | Promise<unknown>;
  /** 读自启动状态（摘要额外项；Rust 设置，异步读取） */
  getAutostartEnabled?: () => boolean | Promise<boolean>;
  /** 读代理设置（摘要额外项；可备份设置，异步读取） */
  getProxySettings?: () => unknown | Promise<unknown>;
  /** 读「Alt+点击文件快速带入」开关（摘要额外项；可备份设置） */
  getAltClickEnabled?: () => boolean | Promise<boolean>;
  /**
   * 读「可同步落盘数据」的指纹（插件安装文件 / 插件私有数据 / 内部状态）。
   *
   * 必须参与摘要：插件私有数据与插件文件不在 localStorage 里，只靠前端摘要会
   * 出现「插件数据变了却判定本机没变 → 跳过上传」。
   */
  getDataDigest?: () => string | Promise<string>;
  /** 状态回调 */
  onState?: (state: SyncRunState) => void;
  /** 用户本轮对 needs-choice 的选择 */
  choice?: "local" | "remote";
}

/** 判断错误是否为条件请求冲突（Rust 侧统一带 `SYNC_CONFLICT:` 前缀） */
export function isSyncConflict(error: unknown): boolean {
  const msg = (error as Error)?.message ?? String(error);
  return msg.includes("SYNC_CONFLICT");
}

/**
 * 本机摘要 = localStorage 快照 + Rust 侧设置。
 *
 * 设置（快捷键 / 自启动）存在 Rust 的 settings.json，不在 localStorage 里；
 * 不把它们纳入摘要，「只改了快捷键」就会被判成「本机没变」而永远不同步。
 */
async function digestOf(opts: SyncRoundOptions): Promise<string> {
  let sb: unknown = null;
  let ae = false;
  let pr: unknown = null;
  let ac = true;
  let pd = "";
  try {
    sb = (await opts.getShortcutBindings?.()) ?? null;
  } catch {
    sb = null;
  }
  try {
    ae = (await opts.getAutostartEnabled?.()) ?? false;
  } catch {
    ae = false;
  }
  try {
    pr = (await opts.getProxySettings?.()) ?? null;
  } catch {
    pr = null;
  }
  try {
    ac = (await opts.getAltClickEnabled?.()) ?? true;
  } catch {
    ac = true;
  }
  try {
    pd = (await opts.getDataDigest?.()) ?? "";
  } catch {
    pd = "";
  }
  // sb/ae/pr/ac = 可备份的 Rust 设置（与 BACKUP_SETTINGS_KEYS 对齐）；
  // pd = 插件安装文件 + 插件私有数据 + 内部状态的指纹（不在 localStorage 里）。
  // 任一变化都会让摘要变化 → 判定「本机有改动」→ 触发上传。
  return stateDigest({ sb, ae, pr, ac, pd });
}

function baseState(prev: Partial<SyncRunState>, persisted?: SyncPersistedState): SyncRunState {
  return {
    status: "idle",
    lastSyncAt: persisted?.lastSyncAt ?? prev.lastSyncAt ?? 0,
    lastError: "",
    remoteMeta: prev.remoteMeta ?? null,
    localDigest: prev.localDigest ?? persisted?.lastLocalDigest ?? "",
    initialized: persisted?.initialized ?? prev.initialized ?? false,
    remoteRev: persisted?.remoteRev ?? prev.remoteRev ?? "",
    needsChoice: false,
    choiceReason: "",
    epoch: persisted?.epoch ?? prev.epoch ?? 1,
  };
}

/**
 * 执行一次完整同步：读基线 → 检查远端 → 决策 → 上传/下载。
 *
 * 不持有模块级状态，所有基线由 `getState/patchState` 注入：
 * 设置窗口、主窗口 SyncHost、插件 `ms.sync.trigger()` 都走同一条内核。
 */
export async function runSyncRound(
  opts: SyncRoundOptions,
  trigger: string,
  prev: Partial<SyncRunState> = {}
): Promise<SyncRunState> {
  const startedAt = Date.now();
  let persisted = await opts.getState();
  const state = baseState(prev, persisted);
  const update = (partial: Partial<SyncRunState>): void => {
    Object.assign(state, partial);
    opts.onState?.({ ...state });
  };

  const patch = async (p: SyncStatePatch): Promise<void> => {
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

    // 1) 检查远端
    update({ status: "downloading" });
    let remote: RemoteMeta;
    try {
      remote = await syncRemoteMeta();
    } catch (e) {
      throw new Error(`检查远端失败: ${(e as Error)?.message ?? e}`);
    }
    update({ remoteMeta: remote });

    // 2) 本机摘要 + 决策
    const digest = await digestOf(opts);
    update({ localDigest: digest });

    let action = decideAction({
      config,
      remote,
      state: persisted,
      localDigest: digest,
      choice: opts.choice,
    });

    if (action === "needs-choice") {
      const reason = !persisted.initialized ? "first-connect" : "conflict";
      update({ status: "needs-choice", needsChoice: true, choiceReason: reason });
      debug(`[同步] ${trigger}: 等待用户选择（${reason}）`);
      return { ...state };
    }

    if (action === "skip") {
      await patch({ lastSyncAt: Date.now() });
      update({ status: "idle", lastError: "" });
      debug(`[同步] ${trigger}: 无需同步`);
      return { ...state };
    }

    if (action === "download") {
      await doDownload(opts, update, patch, trigger);
      return { ...state };
    }

    // 3) 上传（冲突时最多再决策一次）
    try {
      await doUpload(update, patch, trigger, digest, remote, action === "force-upload");
    } catch (e) {
      if (!isSyncConflict(e)) throw e;
      // 远端在「读元信息 → PUT」之间被别的设备改了：重新读远端再决策，
      // 绝不把 412 当成普通失败，也绝不盲目重试覆盖。
      warn(`[同步] ${trigger}: 条件上传冲突，重新决策`);
      const fresh = await syncRemoteMeta();
      update({ remoteMeta: fresh });
      action = decideAction({
        config,
        remote: fresh,
        state: persisted,
        localDigest: digest,
        choice: opts.choice,
      });
      if (action === "download") {
        await doDownload(opts, update, patch, trigger);
        return { ...state };
      }
      if (action === "upload") {
        // 理论上 412 之后远端版本必然已变；若服务器/代理行为异常导致重新
        // 决策仍是「upload」，用刚读到的 ETag 再做一次条件上传，而不是
        // 给用户弹一个莫名其妙的冲突选择。
        await doUpload(update, patch, trigger, digest, fresh, false);
        return { ...state };
      }
      if (action === "force-upload") {
        // 重新决策后仍然判定本机优先（用户策略 / 用户选择 / newer 时间判定），
        // 这时才允许无条件 PUT——条件已经刷新过一次，不会盲目覆盖。
        await doUpload(update, patch, trigger, digest, fresh, true);
        return { ...state };
      }
      if (action === "skip") {
        await patch({ lastSyncAt: Date.now() });
        update({ status: "idle", lastError: "" });
        return { ...state };
      }
      update({
        status: "needs-choice",
        needsChoice: true,
        choiceReason: "conflict",
        lastError: "",
      });
      return { ...state };
    }
    return { ...state };
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    update({ status: "error", lastError: msg });
    warn(`[同步] 失败 (${trigger}):`, msg);
    return { ...state };
  } finally {
    debug(`[同步] ${trigger}完成:${Date.now() - startedAt}ms`);
  }
}

/** 上传：快照 → 条件 PUT → 写持久化基线 */
async function doUpload(
  update: (partial: Partial<SyncRunState>) => void,
  patch: (p: SyncStatePatch) => Promise<void>,
  trigger: string,
  digest: string,
  remote: RemoteMeta,
  force: boolean
): Promise<void> {
  update({ status: "uploading", needsChoice: false, choiceReason: "" });
  const exported = await backupSnapshot(collectState());

  // 条件请求：首次创建用 If-None-Match:*，后续用远端原始 ETag；
  // 只有用户明确选择「本机覆盖远端」才允许无条件 PUT。
  const ifMatch: string | null = force
    ? null
    : !remote.exists
      ? ""
      : remote.etag || null;

  const meta = await syncUpload(exported, ifMatch);
  const now = Date.now();
  await patch({
    initialized: true,
    remoteRev: meta.rev,
    remoteEtag: meta.etag,
    lastLocalDigest: digest,
    lastSyncAt: now,
  });
  update({
    status: "idle",
    lastError: "",
    lastSyncAt: now,
    localDigest: digest,
    initialized: true,
    remoteRev: meta.rev,
    remoteMeta: meta,
  });
  debug(`[同步] ${trigger}: 上传成功`);
}

/** 下载：条件 GET → Rust 事务还原 → 静默写回 → 广播 applied */
async function doDownload(
  opts: SyncRoundOptions,
  update: (partial: Partial<SyncRunState>) => void,
  patch: (p: SyncStatePatch) => Promise<void>,
  trigger: string
): Promise<void> {
  update({ status: "downloading", needsChoice: false, choiceReason: "" });
  const persisted = await opts.getState();
  const result = await syncDownload(persisted.remoteEtag || null);

  if (result.notModified) {
    const now = Date.now();
    await patch({ lastSyncAt: now });
    update({ status: "idle", lastError: "", lastSyncAt: now });
    debug(`[同步] ${trigger}: 远端未变化（304）`);
    return;
  }

  // Rust 侧完成事务还原并按范围过滤 localStorage，前端只负责写回。
  // 还原当前状态一起传过去，供「还原前留底」使用（否则留底只有插件文件）。
  const restored = await backupRestore(result.path, ["all"], collectState());
  const back = (restored.localStorage ?? {}) as Record<string, unknown>;
  // 版本守卫：本机版本更高的插件不被降级（文件与数据都保留本机），
  // 注册表记录同样保留本机，确保「版本号」与磁盘代码一致。
  const downgradeSkipped = restored.downgradeSkipped ?? [];
  restoreState(back, { silent: true, keepLocalPluginIds: downgradeSkipped });
  pruneState(back);
  if (downgradeSkipped.length > 0) {
    debug(
      `[同步] ${trigger}: 跳过 ${downgradeSkipped.length} 个本机版本更高的插件（拒绝降级）: ${downgradeSkipped.join(", ")}`
    );
  }
  // 递增 epoch 并广播：按实际范围重载插件视图/独立窗口/后台进程。
  await syncCommitApplied("cloud", restored.scope ?? "all");

  const digest = await digestOf(opts);
  const now = Date.now();
  await patch({
    initialized: true,
    remoteRev: result.rev,
    remoteEtag: result.etag,
    lastLocalDigest: digest,
    lastSyncAt: now,
    appliedRev: result.rev,
  });
  update({
    status: "idle",
    lastError: "",
    lastSyncAt: now,
    localDigest: digest,
    initialized: true,
    remoteRev: result.rev,
    remoteMeta: {
      exists: true,
      rev: result.rev,
      etag: result.etag,
      modified: result.modified,
      size: result.size,
    },
  });
  debug(`[同步] ${trigger}: 从远端还原成功`);
}

/** 把「兜底间隔」夹到合理范围（配置层已夹过一次，这里防御脏数据） */
export function intervalMsOf(config: Pick<SyncConfig, "intervalMinutes">): number {
  const minutes = Number(config.intervalMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return DEFAULT_CHECK_INTERVAL_MS;
  return Math.max(5, minutes) * 60 * 1000;
}
