<script setup lang="ts">
/**
 * 关于软件面板（原 panes.about + paneBinders.about）。
 * 展示版本信息 + 检查更新 / 下载更新（整行点击下载）。
 */
import { onBeforeUnmount, onMounted, ref } from "vue";
import {
  checkUpdate,
  openExternal,
  openInstaller,
  startUpdateDownload,
  onUpdateProgress,
  onUpdateComplete,
  type UnlistenFn,
} from "../../../lib/tauri-bridge";

const pkgVersion = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "unknown";

/** 更新状态文案 / 语义 class */
const statusText = ref("正在检查更新…");
const statusType = ref<"checking" | "latest" | "new-version" | "error" | "">("checking");

const checkBtnText = ref("检查更新");
const checking = ref(false);

/** 当前可下载的地址（有新版本时才有值） */
let currentDownloadUrl: string | null = null;
let downloading = false;
let unlistenProgress: UnlistenFn | null = null;
let unlistenComplete: UnlistenFn | null = null;

const REPO = "https://github.com/My-Search/my-search-desktop";
const CHANGELOG = "https://github.com/My-Search/my-search-desktop/releases";

/** 渲染检查结果 */
function setStatus(text: string, type: typeof statusType.value): void {
  statusText.value = text;
  statusType.value = type;
}

/** 整行是否可点击（有新版本 / 安装文件已下载但打开失败时可重试） */
function rowClickable(): boolean {
  if (downloading) return false;
  if (statusType.value === "new-version") return true;
  // 下载完成但打开安装程序失败时，点击重试
  if (currentDownloadUrl && statusType.value === "latest" && statusText.value === "安装文件已下载，请手动运行") {
    return true;
  }
  return false;
}

/** 清理更新监听器（防止重试时累积，对应 #10） */
function cleanupUpdateListeners(): void {
  if (unlistenProgress) {
    unlistenProgress();
    unlistenProgress = null;
  }
  if (unlistenComplete) {
    unlistenComplete();
    unlistenComplete = null;
  }
}

/** 开始下载更新 */
async function startDownload(downloadUrl: string | null): Promise<void> {
  if (downloading) return;
  if (!downloadUrl) return;
  downloading = true;
  setStatus("正在下载更新…", "checking");

  // 清理旧监听器（防止重试时累积）
  cleanupUpdateListeners();

  try {
    unlistenProgress = await onUpdateProgress((progress) => {
      if (progress.status === "downloading") {
        setStatus(`正在下载更新… ${progress.percent}%`, "checking");
      } else if (progress.status === "done") {
        // done 状态只是流式下载写完，不代表 complete 事件已触发，这里不切换文案
      } else if (progress.status === "error") {
        console.warn("更新下载错误:", progress.error);
        setStatus("下载失败，请重试", "error");
        downloading = false;
      }
    });

    unlistenComplete = await onUpdateComplete(async () => {
      downloading = false;
      setStatus("正在启动安装程序…", "latest");
      // 实际打开安装程序（修复 #9：原版只写「安装程序已启动」但未调用 openInstaller）
      try {
        await openInstaller();
        setStatus("安装程序已启动", "latest");
      } catch (e) {
        console.warn("打开安装文件失败:", e);
        setStatus("安装文件已下载，请手动运行", "latest");
      }
    });

    await startUpdateDownload(downloadUrl);
  } catch (e) {
    console.warn("启动下载失败:", e);
    setStatus("下载失败，请重试", "error");
    downloading = false;
  }
}

/** 执行版本检查 */
async function doCheckUpdate(): Promise<void> {
  checking.value = true;
  checkBtnText.value = "检查中…";
  setStatus("正在检查更新…", "checking");
  currentDownloadUrl = null;
  try {
    const info = await checkUpdate();
    if (!info.has_update) {
      setStatus("当前已经是最新版本！", "latest");
    } else {
      setStatus("有新版本，点击下载", "new-version");
      currentDownloadUrl = info.download_url;
    }
  } catch (e) {
    setStatus("检查更新失败，请检查网络后重试", "error");
  } finally {
    checking.value = false;
    checkBtnText.value = "检查更新";
  }
}

function onRowClick(): void {
  if (currentDownloadUrl && !downloading) {
    void startDownload(currentDownloadUrl);
  }
}

function onCheckClick(e: MouseEvent): void {
  e.preventDefault();
  void doCheckUpdate();
}

function openLink(e: MouseEvent, url: string): void {
  e.preventDefault();
  void openExternal(url);
}

onMounted(() => {
  // 进入面板时自动检查一次
  void doCheckUpdate();
});

onBeforeUnmount(() => {
  // 面板切走时清理下载监听（修复 #10：防止重试累积）
  cleanupUpdateListeners();
});
</script>

<template>
  <section class="page about">
    <div class="cfg-card">
      <div class="cfg-card-head">
        <h3>关于软件</h3>
      </div>
      <div class="about-info">
        <div class="about-logo">
          <svg viewBox="0 0 1024 1024" width="56" height="56" xmlns="http://www.w3.org/2000/svg">
            <path
              d="M224.2 472.3c-13-5.7-3.7-23.5 8.2-19 91 34 146.8 108.7 182.4 138.5 5.6 4.7 14 2.9 17.3-3.5 16.8-32 45.8-113.7-57.1-168.6-87.3-46.5-188-53.6-247.3-82.2-14.5-7-31.1 4.6-29.9 20.7 5 69.7 28.9 124.7 62.3 181.5 67.3 114.3 140.6 132.9 216.6 104 2.2-0.9 4.5-1.8 7-3 7-3.4 8.3-12.9 2.5-18.1 0.1 0-45.7-69.3-162-150.3z"
              fill="#FFD401"
            />
            <path
              d="M282.7 849.9c79.5-137 172.4-263.1 385.4-401.3 9.8-6.4 2.1-21.5-8.9-17.4C497.7 492.8 429.7 585 373.3 640.8c-8.7 8.7-23.4 6.3-29.1-4.6-27.2-51.8-69.5-174.1 97.3-263.1 147.7-78.8 319.9-91.4 429.7-93.3 18.9-0.3 31.5 19.4 23.3 36.4C863.7 380 842.6 478 789.9 567.6 680.8 753.1 545.5 766.7 422.2 719.8c-8.8-3.4-18.8-0.2-24 7.7-16.6 25.2-50.3 80.1-58.7 122.4-11.4 56.8-82.2 43.9-56.8 0z"
              fill="#8BC03C"
            />
            <path
              d="M375 419.6c-30.1 28.2-45.8 57.7-52.4 86.1 40.6 32.4 70.2 67.7 92.1 85.9 1.2 1 2.5 1.6 3.9 2.1 6.5-6.7 13.3-13.7 20.4-20.7 15.2-37.9 25.3-105.7-64-153.4zM318.8 548.2c1.6 36.1 14.7 67.6 25.5 88.1 5.7 10.9 20.3 13.3 29.1 4.6 4.9-4.9 10-10 15.1-15.4-0.6-1-1.3-2-2.2-2.8 0-0.1-20.1-30.5-67.5-74.5z"
              fill="#8BA000"
            />
          </svg>
        </div>
        <div class="about-app-name">我的搜索桌面版</div>
        <div class="about-version">v{{ pkgVersion }}</div>
        <div class="about-desc">订阅式搜索工具 — 让我的搜索，只搜精品！</div>
        <div class="about-links">
          <a :href="REPO" :data-ext="REPO" target="_blank" @click="openLink($event, REPO)"
            >GitHub 仓库</a
          >
          <a
            :href="CHANGELOG"
            :data-ext="CHANGELOG"
            target="_blank"
            @click="openLink($event, CHANGELOG)"
            >更新日志</a
          >
          <button
            id="checkUpdateBtn"
            type="button"
            class="cfg-btn about-link-btn"
            data-act="check-update"
            :disabled="checking"
            @click="onCheckClick"
          >
            {{ checkBtnText }}
          </button>
        </div>
      </div>
      <div class="about-update">
        <div class="about-update-head">
          <span>版本更新</span>
        </div>
        <div
          class="about-update-row"
          :class="{ clickable: rowClickable() }"
          id="aboutUpdateRow"
          @click="onRowClick"
        >
          <svg
            class="about-update-icon"
            viewBox="0 0 16 16"
            width="16"
            height="16"
            fill="currentColor"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
            />
          </svg>
          <div id="aboutUpdateStatus" class="about-update-status" :class="statusType">
            {{ statusText }}
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
