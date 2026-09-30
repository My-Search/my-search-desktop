/**
 * 版本更新检查与后台静默下载（组合式封装）
 *
 * 对外只暴露一个「更新就绪」信号：`isDownloaded()`。搜索框据此在**叶子
 * 右下角**显示一个小红箭头（UpdateBadge），点击叶子即安装更新。
 *
 * 对应原 main.js 的：
 * - checkAndAutoDownload / scheduleUpdateCheck（检查 + 后台静默下载）
 * - startDownloadOnly / handleBadgeClick（下载与安装入口）
 */
import { reactive } from "vue";
import {
  isTauri,
  checkUpdate,
  startUpdateDownload,
  onUpdateProgress,
  onUpdateComplete,
  onAutoDownloadChanged,
  openInstaller,
  type UnlistenFn,
} from "../../lib/tauri-bridge";
import type { UpdateInfo } from "../../types/index";
import { getAutoDownloadUpdate } from "../../lib/update-settings";

/** 定时检查间隔：20 分钟 */
const UPDATE_CHECK_INTERVAL_MS = 20 * 60 * 1000;
/**
 * 「呼出即查」的最小间隔：60 秒。
 *
 * 搜索框每次呼出都会触发一次检查；用户高频呼出时若不节流，会迅速打爆
 * GitHub API 未认证限额（60 次/小时/IP）→ 403 → 旧版静默谎报「已是最新」。
 * 设置窗口切换开关时不走节流（那条路径必须当刻生效）。
 */
const MIN_RECHECK_INTERVAL_MS = 60 * 1000;

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
  /** 上次真正发起检查的时刻（用于「呼出即查」节流） */
  let lastCheckAt = 0;
  /** 是否有一次检查正在进行（防止节流窗口外的并发重复请求） */
  let checking = false;
  /** 「自动下载更新」开关变更监听（配置窗口切换时立即重求值用） */
  let unlistenSettingChange: UnlistenFn | null = null;
  /** 监听注册进行中（异步 gap 内防止重复注册） */
  let settingListenPending = false;

  /** 是否已下载好当前最新版本（= 更新就绪，可安装） */
  function isDownloaded(): boolean {
    return (
      !!state.downloadedPath &&
      !!state.downloadedVersion &&
      state.downloadedVersion === state.info?.latest_version
    );
  }

  /** 叶子按钮 / 角标提示文案（仅在更新就绪时有意义） */
  function updateTip(): string {
    return `已下载 ${state.info?.latest_version ?? ""}，点击安装更新`;
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
   * 清空全部更新状态并释放监听（用于「自动下载更新」关闭时的完全静默）。
   * `info` 清空后 `isDownloaded()` 为 false，叶子上的小红箭头随之消失，
   * 叶子点击回退到原有行为（打开设置）。
   */
  function resetUpdateState(): void {
    cleanupUpdateListeners();
    state.info = null;
    state.downloading = false;
    state.progress = 0;
    state.downloadedPath = null;
    state.downloadedVersion = "";
  }

  /**
   * 后台静默下载更新（不打开安装程序）。
   * 下载完成后记录路径与版本，`isDownloaded()` 随即为 true——
   * 叶子右下角出现小红箭头提示「可以安装了」。
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
   * 点击叶子（或叶子右下角小红箭头）时的统一入口——**只在更新就绪时由父层调用**：
   * 1. 已下载好（路径存在且版本匹配）→ 打开安装程序
   * 2. 打开失败（安装文件丢失）→ 清空标记并重新静默下载
   *
   * 下载中 / 未下载完成时不做事：下载本身是后台自动的，无需点击介入
   * （父层也只在 `isDownloaded()` 为 true 时才会把点击路由到这里）。
   */
  async function handleBadgeClick(): Promise<void> {
    // 「自动下载更新」关闭时叶子不该带箭头；若因切换竞态被点到，直接忽略。
    if (!getAutoDownloadUpdate()) return;
    if (state.downloading) return;

    if (!isDownloaded()) {
      // 版本已被检查结果更新（或文件标记被清）→ 重新静默下载
      if (state.info?.has_update) {
        state.downloadedPath = null;
        state.downloadedVersion = "";
        void startDownloadOnly();
      }
      return;
    }

    try {
      await openInstaller();
    } catch (e) {
      console.warn("[我的搜索] 打开安装程序失败:", e);
      // 安装失败通常是文件丢失：清空已下载状态后自动重新下载
      state.downloadedPath = null;
      state.downloadedVersion = "";
      state.progress = 0;
      if (state.info?.has_update) void startDownloadOnly();
    }
  }

  /**
   * 执行一次检查更新，若发现新版本则自动静默下载。
   *
   * 「自动下载更新」关闭时**完全静默**：不检查、不下载、叶子不显示红箭头，
   * 并清空既有状态（每次定时/呼出触发都重读设置，故开关免重启即可生效）。
   */
  async function checkAndAutoDownload(): Promise<void> {
    if (!isTauri) return;
    if (!getAutoDownloadUpdate()) {
      resetUpdateState();
      return;
    }
    // 并发去重：一次检查未返回时再次触发直接忽略（避免叠加请求把 API 打爆）。
    if (checking) return;
    checking = true;
    lastCheckAt = Date.now();
    try {
      const info = await checkUpdate();

      // 检查失败（数据源全部不可用）：保留上一次结果，不清空、不误报。
      // 若此前已下载好更新，红箭头继续保留，用户仍可点击安装。
      if (info.check_failed) {
        console.warn("[我的搜索] 更新检查失败（网络/数据源不可用），保留既有状态");
        return;
      }

      state.info = info;

      if (info.has_update) {
        console.log(`[我的搜索] 发现新版本: ${info.current_version} → ${info.latest_version}`);

        // 如果已经下载了相同版本，只需要展示「已下载」状态，不用重新下载
        if (state.downloadedVersion === info.latest_version && state.downloadedPath) {
          state.progress = 100;
          return;
        }

        // 有更新 → 后台静默下载（完成后叶子右下角出现红箭头）
        void startDownloadOnly();
      } else {
        // 无更新，清理已下载标记（因为服务器已无更新）
        state.downloadedPath = null;
        state.downloadedVersion = "";
        state.progress = 0;
      }
    } catch (e) {
      console.warn("[我的搜索] 更新检查失败:", e);
    } finally {
      checking = false;
    }
  }

  /**
   * 按节流规则触发一次检查（供「每次呼出」路径使用）。
   *
   * 高频呼出时若每次都真查，会迅速耗尽 GitHub 未认证 API 限额（60 次/小时），
   * 导致后续检查 403、并掩盖新版本。这里限制为最短 60 秒一次。
   */
  function throttledCheck(): void {
    if (!isTauri) return;
    if (!getAutoDownloadUpdate()) {
      resetUpdateState();
      return;
    }
    if (checking) return;
    if (Date.now() - lastCheckAt < MIN_RECHECK_INTERVAL_MS) return;
    void checkAndAutoDownload();
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
    // 监听设置窗口对「自动下载更新」的切换，当刻重求值——否则关闭开关后
    // 叶子上的红箭头要滞留到下次呼出/定时点，开启后也要等同样久才出现。
    if (unlistenSettingChange == null && !settingListenPending) {
      settingListenPending = true;
      void onAutoDownloadChanged(() => recheckSetting()).then((fn) => {
        settingListenPending = false;
        if (fn == null) return;
        // 注册完成前已被 dispose → 立即释放，避免监听泄漏
        if (checkTimer == null) {
          fn();
          return;
        }
        unlistenSettingChange = fn;
      });
    }
  }

  /**
   * 立即按当前「自动下载更新」设置重新求值一次（**不节流**）。
   *
   * 调用方：配置窗口切换开关的当刻（见 scheduleUpdateCheck 里的监听）。
   * 用户刚改过开关时无需等待下一个 20 分钟定时点——开启则马上检查并
   * （必要时）下载，关闭则马上清空（叶子红箭头立即消失）。
   */
  function recheckSetting(): void {
    void checkAndAutoDownload();
  }

  /**
   * 主窗口每次呼出时调用：按节流规则检查一次更新。
   *
   * 与 `recheckSetting` 的区别：呼出可能非常频繁，必须节流（见
   * `throttledCheck`），否则会打爆 GitHub API 限额。
   */
  function recheckOnSummon(): void {
    throttledCheck();
  }

  /** 组件卸载时清理 */
  function dispose(): void {
    if (checkTimer != null) {
      clearInterval(checkTimer);
      checkTimer = null;
    }
    cleanupUpdateListeners();
    if (unlistenSettingChange != null) {
      try {
        unlistenSettingChange();
      } catch (_) {
        /* ignore */
      }
      unlistenSettingChange = null;
    }
  }

  return {
    state,
    isDownloaded,
    updateTip,
    handleBadgeClick,
    scheduleUpdateCheck,
    recheckSetting,
    recheckOnSummon,
    dispose,
  };
}

export type UpdateCheckerApi = ReturnType<typeof useUpdateChecker>;
