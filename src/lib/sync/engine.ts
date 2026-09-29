/**
 * 同步引擎 —— 数据变化自动触发 + 30 分钟兜底轮询。
 *
 * 架构
 * ----
 * ┌────────────────┐    1. 数据变化      ┌──────────────┐
 * │  storageSet()  │ ───────────────────→│  SyncEngine   │
 * │  (util.ts)     │     → 节流 5 秒排程  │              │
 * └────────────────┘                     │  ┌─────────┐  │
 * ┌────────────────┐    3. 兜底轮询      │  │ 上锁：   │  │
 * │  定时器（30 分）│ ──────────────────→│  │syncLock  │  │
 * └────────────────┘    检查指纹是否变化  │  └─────────┘  │
 *                                        │      │        │
 * ┌────────────────┐    4. 远端比对      │      ↓        │
 * │  Rust 侧命令   │ ←──────────────────│  meta()       │
 * │                │    5. 上传 / 下载   │   ↓            │
 * │  sync_upload   │ ←──────────────────│  冲突判断      │
 * │  sync_download │    6. 通知结果      │   ↓            │
 * └────────────────┘                     │  上传或下载    │
 *                                        └──────────────┘
 *
 * 三个入口（都是先 createSnapshot 再上传/下载）：
 *   a) 数据变更 → autoScheduleOnChange（5s 节流）
 *   b) 定时器 → 每 30 分钟 dorScheduleBackground（先检查指纹再决定）
 *   c) 手动 syncNow()（面板上的「立即同步」）
 *
 * 冲突策略（`config.conflict`）：
 *   - "newer"（默认）：谁新用谁的（比较远端与本地的 modifiedTime / 指纹）
 *   - "local"：永远用本机覆盖远端
 *   - "remote"：永远用远端覆盖本机
 *   - "ask"：发出事件让面板展示，用户选择后再继续
 */

import {
  backupExport,
  backupSnapshot,
  backupInspect,
  backupRestore,
  syncRemoteMeta,
  syncUpload,
  syncDownload,
  type SyncConfig,
  type RemoteMeta,
} from "./bridge";
import { collectState, fingerprint, restoreState, settingsFingerprint } from "./snapshot";
import { debug, warn } from "../../lib/logger";

/** 默认兜底检查间隔（毫秒） */
const DEFAULT_CHECK_INTERVAL_MS = 30 * 60 * 1000;

/** 数据变更后自动同步的节流时间（5 秒，合并连续编辑） */
const ON_CHANGE_THROTTLE_MS = 5000;

/**
 * 冲突决策：根据用户策略与远端状态决定 upload / download / ask / null。
 *
 * - 远端不存在 → 上传（首次同步）
 * - 用户显式策略（local / remote / ask）优先
 * - "newer"：远端 last-modified（毫秒）比本机上次同步时间新 → 远端有改动，下载
 * - 其余情况 → 上传
 *
 * 纯函数（只读入参），便于单测；`lastSyncAt` 由调用方从状态里带进来。
 * 返回 null 表示无需同步——当前实现不会走到，保留该分支供将来加「指纹一致就跳过」。
 */
export function decideAction(
  config: Pick<SyncConfig, "conflict">,
  remote: RemoteMeta | null,
  lastSyncAt: number
): "upload" | "download" | "ask" | null {
  // 远端不存在 → 上传播下的快照
  if (!remote || !remote.exists) {
    return "upload";
  }

  // 用户指定偏好
  if (config.conflict === "local") return "upload";
  if (config.conflict === "remote") return "download";
  if (config.conflict === "ask") return "ask";

  // "newer" 模式：按修改时间比较（远端 last-modified 比上次同步时间新 = 远端有改动）
  if (remote.modified && remote.modified > lastSyncAt) {
    return "download";
  }
  return "upload";
}

/** 同步状态（供面板绑定） */
export interface SyncRunState {
  status: "idle" | "syncing" | "uploading" | "downloading" | "error";
  lastSyncAt: number;
  lastError: string;
  /** 远端是否有备份、版本号 */
  remoteMeta: RemoteMeta | null;
  /** 上次记录的指纹（用于兜底判断「本机变了没有」） */
  localFingerprint: string;
  settingsFingerprint: string;
}

/** 一次同步轮次的依赖（抽出来是为了让同步不只在设置窗口可用） */
export interface SyncRoundOptions {
  /** 读同步配置（每轮实时读，避免注册表/配置被别的窗口改过后用陈旧值） */
  getConfig: () => SyncConfig | Promise<SyncConfig>;
  /** 读快捷键绑定（settings 指纹用） */
  getShortcutBindings?: () => unknown;
  /** 读自启动状态（settings 指纹用） */
  getAutostartEnabled?: () => boolean;
  /** 状态回调（面板绑定 / 插件查询用） */
  onState?: (state: SyncRunState) => void;
  /** 冲突策略为 ask 时征询用户（返回远端覆盖本机 = "remote" / 本机覆盖远端 = "local"） */
  /**
   * 冲突策略为 ask 时征询用户（返回远端覆盖本机 = "remote" / 本机覆盖远端 = "local"）。
   *
   * `meta` 两个字段的用途：
   * - `remoteModified`：远端备份的修改时间——比 `lastSyncAt` 新就说明远端在
   *   本机上次同步之后被改过；
   * - `lastSyncAt`：本机上一次**成功**同步的时间。没有确认框的调用方（搜索窗口的
   *   `ms.sync.trigger`）要靠它判断「本机覆盖远端」是否安全：`cloud.rs sync_upload`
   *   是无条件 PUT（没有 If-Match/rev 保护），远端一旦更新过，覆盖就**不可逆**。
   *
   * （原字段 `localModified` 恒为 0 且两个调用方都没读，属误导性契约，已移除。）
   */
  onAskConflict: (meta: { remoteModified: number; lastSyncAt: number }) => Promise<"local" | "remote">;
}

/**
 * 执行一次完整同步：创建快照 → 检查远端 → 决策 → 上传/下载。
 *
 * 与 `createSyncEngine` 的关系：后者是「带定时器与节流的常驻引擎」，本函数是
 * 引擎的**单步内核**。设置窗口的同步面板、搜索窗口（供插件 `ms.sync.trigger`）
 * 都调它，所以这里不持有任何模块级状态——`lastSyncAt` 由调用方从状态里带进来。
 *
 * @param prev 上一轮状态（提供 `lastSyncAt` 供 "newer" 策略比较）
 * @returns 本轮结束后的状态（上传/下载/无需同步/失败都有明确 status）
 */
export async function runSyncRound(
  opts: SyncRoundOptions,
  trigger: string,
  prev: Partial<SyncRunState> = {}
): Promise<SyncRunState> {
  const state: SyncRunState = {
    status: "syncing",
    lastSyncAt: prev.lastSyncAt ?? 0,
    lastError: "",
    remoteMeta: prev.remoteMeta ?? null,
    localFingerprint: prev.localFingerprint ?? "",
    settingsFingerprint: prev.settingsFingerprint ?? "",
  };
  const update = (partial: Partial<SyncRunState>): void => {
    Object.assign(state, partial);
    opts.onState?.({ ...state });
  };

  const start = Date.now();
  update({ status: "syncing", lastError: "" });

  try {
    const config = await opts.getConfig();

    // 1) 检查远端
    update({ status: "downloading" });
    let remote: RemoteMeta;
    try {
      remote = await syncRemoteMeta();
    } catch (e) {
      throw new Error(`检查远端失败: ${(e as Error)?.message ?? e}`);
    }
    update({ remoteMeta: remote });

    // 2) 策略决策
    const localFp = fingerprint();
    const localSettingsFp = settingsFingerprint(
      opts.getShortcutBindings?.() ?? null,
      opts.getAutostartEnabled?.() ?? false
    );
    update({ localFingerprint: localFp, settingsFingerprint: localSettingsFp });

    const decision = decideAction(config, remote, state.lastSyncAt);
    if (!decision) {
      // 不需要同步：远端版本跟本机一致
      update({ status: "idle", lastSyncAt: Date.now(), lastError: "" });
      return { ...state };
    }

    if (decision === "ask") {
      const action = await opts.onAskConflict({
        lastSyncAt: state.lastSyncAt,
        remoteModified: remote?.modified ?? 0,
      });
      if (action === "remote") {
        await doDownload(update, trigger);
      } else {
        await doUpload(update, trigger);
      }
      return { ...state };
    }

    if (decision === "upload") {
      await doUpload(update, trigger);
    } else {
      await doDownload(update, trigger);
    }
    return { ...state };
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    update({ status: "error", lastError: msg });
    warn(`[同步] 失败 (${trigger}):`, msg);
    return { ...state };
  } finally {
    debug(`[同步] ${trigger}完成:${Date.now() - start}ms`);
  }
}

/** 上传：快照 → 远端（`update` 由调用方注入，避免轮次内核又持有一份状态） */
async function doUpload(
  update: (partial: Partial<SyncRunState>) => void,
  trigger: string
): Promise<void> {
  update({ status: "uploading" });
  // 创建快照并导出到备份目录
  const exported = await backupSnapshot(currentSnapshot());
  // 上传到远端
  await syncUpload(exported);
  update({ status: "idle", lastSyncAt: Date.now(), lastError: "" });
  debug(`[同步] ${trigger}: 上传成功`);
}

/** 下载：远端 → 本地路径 → 还原（含 localStorage 写回） */
async function doDownload(
  update: (partial: Partial<SyncRunState>) => void,
  trigger: string
): Promise<void> {
  update({ status: "downloading" });
  // 下载到备份目录，拿到本地路径
  const result = await syncDownload();
  // 还原所有分区
  const restored = await backupRestore(result.path, []);
  // 前端写回 localStorage 数据
  if (restored.localStorage) {
    // restoreState 由顶部静态 import 提供（snapshot.ts 本就静态在包里，
    // 这里再写一次动态 import 只会让 vite 报「动态导入不会单独分包」）
    restoreState(restored.localStorage);
  }
  update({ status: "idle", lastSyncAt: Date.now(), lastError: "" });
  debug(`[同步] ${trigger}: 从远端还原成功`);
}

/**
 * 组装要打进归档的本地快照。
 *
 * 在 `collectState()`（localStorage 用户态）之上补一项 `PLUGIN_REGISTRY_CACHE_KEY`：
 * 注册表平时不在 `my-search-desktop:` 前缀下，正常由 Rust 侧按 `settings.json`
 * 里的插件信息还原；但**插件发起的同步**常常发生在搜索窗口——那里未必有设置
 * 窗口在跑（Rust 侧写入 settings 权威副本）。带上注册表原文，跨机还原后才能
 * 把「装了哪些插件 / 授过哪些权限」原样带过去。
 */
function currentSnapshot(): Record<string, unknown> {
  const state = collectState();
  try {
    const raw = localStorage.getItem("my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY");
    if (raw) state["PLUGIN_REGISTRY_CACHE_KEY"] = JSON.parse(raw);
  } catch (e) {
    /* 读不到就按原样同步，不因注册表缺失而中断 */
  }
  return state;
}

/**
 * 创建同步引擎。
 *
 * @param config — 同步配置（来自 sync_get_config，实时读取）
 * @param getShortcutBindings — 读快捷键绑定
 * @param getAutostartEnabled — 读自启动状态
 * @param onStateChange — 状态变化回调（面板绑定用）
 * @param onAskConflict — 冲突策略为 ask 时回调（返回用户的选择：local | remote）
 * @returns 引擎实例
 */
export function createSyncEngine(
  config: SyncConfig,
  getShortcutBindings: () => unknown,
  getAutostartEnabled: () => boolean,
  onStateChange: (state: SyncRunState) => void,
  onAskConflict: (meta: { remoteModified: number; lastSyncAt: number }) => Promise<"local" | "remote">
) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let throttleTimer: ReturnType<typeof setTimeout> | null = null;
  let syncLock = false;

  const state: SyncRunState = {
    status: "idle",
    lastSyncAt: 0,
    lastError: "",
    remoteMeta: null,
    localFingerprint: "",
    settingsFingerprint: "",
  };

  function update(partial: Partial<SyncRunState>): void {
    Object.assign(state, partial);
    onStateChange(state);
  }

  // ===================== 核心同步 =====================

  /**
   * 执行一次完整的同步：创建快照 → 检查远端 → 决策 → 上传/下载。
   * 已上锁时直接返回（不排队）。
   *
   * 真正的同步逻辑在内核 `runSyncRound` 里（搜索窗口的插件 `ms.sync.trigger`
   * 也走同一条内核），这里只负责「上锁 + 把状态同步到面板」。
   */
  async function sync(trigger: string): Promise<void> {
    if (syncLock) {
      debug(`[同步] 已有任务在执行，跳过触发:${trigger}`);
      return;
    }
    syncLock = true;
    try {
      const next = await runSyncRound(
        {
          getConfig: () => config,
          getShortcutBindings,
          getAutostartEnabled,
          onState: (st) => update(st),
          onAskConflict,
        },
        trigger,
        state
      );
      update(next);
    } finally {
      syncLock = false;
    }
  }

  // ===================== 自动化入口 =====================

  /** 数据变更后的自动排程（节流 5 秒） */
  function autoScheduleOnChange(): void {
    if (!config.enabled || !config.autoOnChange) return;
    if (throttleTimer) clearTimeout(throttleTimer);
    throttleTimer = setTimeout(() => {
      throttleTimer = null;
      void sync("onChange");
    }, ON_CHANGE_THROTTLE_MS);
  }

  /** 兜底定时检查：每 30 分钟检查一次远端状态 */
  function scheduleBackground(): void {
    if (!config.enabled) return;
    stopBackground();
    const intervalMs = (config.intervalMinutes ?? 30) * 60 * 1000;
    timer = setInterval(() => {
      void sync("background");
    }, intervalMs);
  }

  function stopBackground(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  // ===================== 外部 API =====================

  return {
    /** 更新配置后调用 */
    reconfigure(newConfig: SyncConfig): void {
      Object.assign(config, newConfig);
      if (config.enabled) {
        scheduleBackground();
      } else {
        stopBackground();
      }
    },

    /** 数据变了（由 util.ts storageSet 的 hook 调用） */
    onDataChanged(): void {
      autoScheduleOnChange();
    },

    /** 手动立即同步 */
    async syncNow(): Promise<void> {
      await sync("manual");
    },

    /** 开始兜底轮询 */
    startBackground(): void {
      scheduleBackground();
      // 首次启动时也做一次检查
      if (config.enabled) {
        void sync("initial");
      }
    },

    stop(): void {
      stopBackground();
      if (throttleTimer) {
        clearTimeout(throttleTimer);
        throttleTimer = null;
      }
    },

    getState(): SyncRunState {
      return { ...state };
    },
  };
}

export type SyncEngine = ReturnType<typeof createSyncEngine>;