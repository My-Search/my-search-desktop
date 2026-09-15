/**
 * 版本更新检查与后台静默下载（组合式封装）
 *
 * 对应原 main.js 的：
 * - renderUpdateBadge / setRingProgress / renderUpdateProgress / renderUpdateReady
 * - startUpdate / startDownloadOnly / checkAndAutoDownload / scheduleUpdateCheck
 */
import { reactive } from "vue";
import {
  isTauri,
  checkUpdate,
  startUpdateDownload,
  onUpdateProgress,
  onUpdateComplete,
  openInstaller,
  type UnlistenFn,
} from "../../lib/tauri-bridge";
import type { UpdateInfo } from "../../types/index";

/** 定时检查间隔：20 分钟 */
const UPDATE_CHECK_INTERVAL_MS = 20 * 60 * 1000;
/** 环形进度条周长（r=16 → 2π·16 ≈ 100.53） */
const RING_TOTAL = 100.53;

export function useUpdateChecker() {
  const state = reactive({
    /** 当前更新信息（null = 尚未检查） */
    info: null as UpdateInfo | null,
    /** 是否正在下载 */
    downloading: false,
    /** 下载进度 0-100 */
    progress: 0,
    /** 已下载好的安装文件本地路径 */
    downloadedPath: null as string | null,
    /** 已下载文件对应的版本号 */
    downloadedVersion: "",
  });

  let unlistenProgress: UnlistenFn | null = null;
  let unlistenComplete: UnlistenFn | null = null;
  let checkTimer: ReturnType<typeof setInterval> | null = null;

  /** 徽章是否可见（有更新） */
  function isBadgeVisible(): boolean {
    return !!state.info?.has_update;
  }

  /** 是否已下载好当前最新版本 */
  function isDownloaded(): boolean {
    return (
      !!state.downloadedPath &&
      !!state.downloadedVersion &&
      state.downloadedVersion === state.info?.latest_version
    );
  }

  /** 环形进度条的 stroke-dashoffset（供模板绑定） */
  function ringOffset(): number {
    const percent = Math.max(0, Math.min(100, state.progress));
    return RING_TOTAL - (percent / 100) * RING_TOTAL;
  }

  /** 徽章提示文案 */
  function badgeTitle(): string {
    const v = state.info?.latest_version ?? "";
    if (state.downloading) return `正在下载更新... ${Math.round(state.progress)}%`;
    if (isDownloaded()) return `已下载 ${v}，点击安装更新`;
    return `发现新版本 ${v}，点击查看`;
  }

  /** 清除进度/监听资源 */
  function cleanupUpdateListeners(): void {
    if (unlistenProgress) {
      try {
        unlistenProgress();
      } catch (_) {
        /* ignore */
      }
      unlistenProgress = null;
    }
    if (unlistenComplete) {
      try {
        unlistenComplete();
      } catch (_) {
        /* ignore */
      }
      unlistenComplete = null;
    }
  }

  /**
   * 后台静默下载更新（不打开安装程序）。
   * 下载完成后自动记录路径和版本，徽章变为「已下载」状态。
   */
  async function startDownloadOnly(): Promise<void> {
    if (!state.info || !state.info.download_url) return;
    if (state.downloading) return;
    state.downloading = true;

    cleanupUpdateListeners();

    // 显示进度起始
    state.progress = 0;

    try {
      unlistenProgress = await onUpdateProgress((progress) => {
        if (progress.status === "downloading") {
          state.progress = progress.percent;
        } else if (progress.status === "done") {
          // 下载完成，但尚未安装
          state.downloading = false;
        } else if (progress.status === "error") {
          console.warn("[我的搜索] 更新下载错误:", progress.error);
          state.downloading = false;
          cleanupUpdateListeners();
          state.progress = 0;
        }
      });

      // 监听下载完成事件（获取本地文件路径）
      unlistenComplete = await onUpdateComplete((payload) => {
        state.downloading = false;
        cleanupUpdateListeners();
        // 记录已下载文件路径和对应的版本号
        state.downloadedPath = payload.path;
        state.downloadedVersion = state.info?.latest_version ?? "";
        state.progress = 100;
        console.log(
          `[我的搜索] 更新下载完成: ${state.info?.latest_version} → ${payload.path}`
        );
      });

      await startUpdateDownload(state.info.download_url);
    } catch (e) {
      console.warn("[我的搜索] 启动下载失败:", e);
      state.downloading = false;
      cleanupUpdateListeners();
      state.progress = 0;
    }
  }

  /**
   * 点击更新徽章时的统一入口：
   * 1. 如果正在下载 → 显示进度，不重复触发
   * 2. 如果已下载好（路径存在且版本匹配）→ 打开安装程序
   * 3. 如果已下载好但版本不匹配 → 重新下载
   * 4. 否则 → 触发下载
   */
  async function handleBadgeClick(): Promise<void> {
    if (!state.info || !state.info.has_update) return;
    if (state.downloading) {
      // 正在下载中，徽章已有进度显示，无需额外操作
      return;
    }

    // 情况 2/3：已有下载好的文件
    if (state.downloadedPath && state.downloadedVersion) {
      if (state.downloadedVersion === state.info.latest_version) {
        // 版本一致 → 打开安装
        try {
          await openInstaller();
          state.progress = 100;
        } catch (e) {
          console.warn("[我的搜索] 打开安装程序失败:", e);
          // 安装失败可能是文件丢失，清空已下载状态重新下载
          state.downloadedPath = null;
          state.downloadedVersion = "";
          state.progress = 0;
          void startDownloadOnly();
        }
      } else {
        // 版本不一致 → 需要重新下载
        console.log(
          `[我的搜索] 已下载版本 ${state.downloadedVersion} ≠ 最新 ${state.info.latest_version}，重新下载`
        );
        state.downloadedPath = null;
        state.downloadedVersion = "";
        void startDownloadOnly();
      }
      return;
    }

    // 情况 4：无已下载文件 → 触发下载
    void startDownloadOnly();
  }

  /**
   * 执行一次检查更新，若发现新版本则自动静默下载。
   */
  async function checkAndAutoDownload(): Promise<void> {
    if (!isTauri) return;
    try {
      const info = await checkUpdate();
      state.info = info;

      if (info.has_update) {
        console.log(`[我的搜索] 发现新版本: ${info.current_version} → ${info.latest_version}`);

        // 如果已经下载了相同版本，只需要展示「已下载」状态，不用重新下载
        if (state.downloadedVersion === info.latest_version && state.downloadedPath) {
          state.progress = 100;
          return;
        }

        // 有更新 → 显示徽章 + 后台静默下载
        void startDownloadOnly();
      } else {
        // 无更新，清理已下载标记（因为服务器已无更新）
        state.downloadedPath = null;
        state.downloadedVersion = "";
        state.progress = 0;
      }
    } catch (e) {
      console.warn("[我的搜索] 更新检查失败:", e);
    }
  }

  /** 启动定时检查更新（启动时立即执行一次，之后每 20 分钟） */
  function scheduleUpdateCheck(): void {
    if (!isTauri) return;
    // 清除已有定时器
    if (checkTimer != null) {
      clearInterval(checkTimer);
      checkTimer = null;
    }
    // 立即执行一次（启动时的检查）
    void checkAndAutoDownload();
    // 每 20 分钟周期检查
    checkTimer = setInterval(() => void checkAndAutoDownload(), UPDATE_CHECK_INTERVAL_MS);
  }

  /** 组件卸载时清理 */
  function dispose(): void {
    if (checkTimer != null) {
      clearInterval(checkTimer);
      checkTimer = null;
    }
    cleanupUpdateListeners();
  }

  return {
    state,
    isBadgeVisible,
    isDownloaded,
    ringOffset,
    badgeTitle,
    handleBadgeClick,
    scheduleUpdateCheck,
    dispose,
  };
}

export type UpdateCheckerApi = ReturnType<typeof useUpdateChecker>;
