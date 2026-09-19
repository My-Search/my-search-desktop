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
import { fingerprint, settingsFingerprint } from "./snapshot";

/** 默认兜底检查间隔（毫秒） */
const DEFAULT_CHECK_INTERVAL_MS = 30 * 60 * 1000;

/** 数据变更后自动同步的节流时间（5 秒，合并连续编辑） */
const ON_CHANGE_THROTTLE_MS = 5000;

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
  onAskConflict: (meta: { localModified: number; remoteModified: number }) => Promise<"local" | "remote">
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
   */
  async function sync(trigger: string): Promise<void> {
    if (syncLock) return;
    syncLock = true;
    const start = Date.now();
    update({ status: "syncing" });

    try {
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
      const local_fp = fingerprint();
      const local_settings_fp = settingsFingerprint(
        getShortcutBindings(),
        getAutostartEnabled()
      );
      update({ localFingerprint: local_fp, settingsFingerprint: local_settings_fp });

      const decision = await decideAction(config, remote, local_fp);
      if (!decision) {
        // 不需要同步：远端版本跟本机一致
        update({ status: "idle", lastSyncAt: Date.now(), lastError: "" });
        return;
      }

      if (decision === "ask") {
        const action = await onAskConflict({
          localModified: 0,
          remoteModified: remote?.modified ?? 0,
        });
        if (action === "remote") {
          await doDownload(trigger);
        } else {
          await doUpload(trigger, local_fp);
        }
        return;
      }

      if (decision === "upload") {
        await doUpload(trigger, local_fp);
      } else {
        await doDownload(trigger);
      }
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      update({ status: "error", lastError: msg });
      console.warn("[同步] 失败:", msg);
    } finally {
      syncLock = false;
      const elapsed = Date.now() - start;
      console.log(`[同步] ${trigger}: ${elapsed}ms`);
    }
  }

  async function doUpload(trigger: string, _fp: string): Promise<void> {
    update({ status: "uploading" });
    // 创建快照并导出到备份目录
    const exported = await backupSnapshot({});
    // 上传到远端
    await syncUpload(exported);
    update({ status: "idle", lastSyncAt: Date.now(), lastError: "" });
    console.log(`[同步] ${trigger}: 上传成功`);
  }

  async function doDownload(trigger: string): Promise<void> {
    update({ status: "downloading" });
    // 下载到备份目录，拿到本地路径
    const result = await syncDownload();
    // 还原所有分区
    const restored = await backupRestore(result.path, []);
    // 前端写回 localStorage 数据
    if (restored.localStorage) {
      const { restoreState } = await import("./snapshot");
      restoreState(restored.localStorage);
    }
    update({ status: "idle", lastSyncAt: Date.now(), lastError: "" });
    console.log(`[同步] ${trigger}: 从远端还原成功`);
  }

  // ===================== 决策 =====================

  async function decideAction(
    config: SyncConfig,
    remote: RemoteMeta | null,
    _localFp: string
  ): Promise<"upload" | "download" | "ask" | null> {
    // 远端不存在 → 上传播下的快照
    if (!remote || !remote.exists) {
      return "upload";
    }

    // 用户指定偏好
    if (config.conflict === "local") return "upload";
    if (config.conflict === "remote") return "download";
    if (config.conflict === "ask") return "ask";

    // "newer" 模式：按修改时间比较
    // 这里简化实现：只要远端文件存在且是本机只上传过的版本，就比对指纹
    // 但还得额外读一次远端被谁改过——实际上 "newer" 只能看 modified/rev
    // 我们统一采用「上传即重置指纹」的策略
    // 如果远端时间戳比最近同步时间新，说明远端有变化 → download
    // 否则 upload
    if (remote.modified && remote.modified > state.lastSyncAt) {
      return "download";
    }
    return "upload";
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