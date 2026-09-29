<script setup lang="ts">
/**
 * 常规设置面板（收纳与搜索/订阅无关的通用开关）。
 *
 * - 开机自启动：桌面版本质是「常驻托盘的呼出工具」，默认开机自启。
 * - Alt+点击文件快速带入：资源管理器/桌面中 Alt+点击文件 → 呼出搜索框并附加。
 * - 自动下载更新：默认开启（后台静默下载，点徽章安装）；关闭后仅「关于」可手动更新。
 * - 主题：支持浅色 / 深色 / 跟随系统（默认跟随系统）。
 */
import { onMounted, ref } from "vue";
import {
  getAutostartEnabled,
  setAutostartEnabled,
  getAltClickEnabled,
  setAltClickEnabled,
  getFileAssocEnabled,
  setFileAssocEnabled,
} from "../../../lib/tauri-bridge";
import { getTheme, setTheme, type Theme } from "../../../lib/theme";
import { getAutoDownloadUpdate, setAutoDownloadUpdate } from "../../../lib/update-settings";

const props = defineProps<{
  notify: (text: string, type?: "ok" | "error") => void;
}>();

/** 系统里当前是否已启用开机自启动 */
const enabled = ref(false);
/** 首次读取状态中（避免开关先显示关闭再跳到开启的闪烁） */
const loading = ref(true);
/** 正在写入（写入期间禁用开关，避免连点产生并发写注册表） */
const saving = ref(false);

/** 「Alt+点击文件快速带入」开关 */
const altClick = ref(true);
/** 首次读取中（同 loading，避免闪烁） */
const altLoading = ref(true);
/** 正在写入（写入期间禁用开关） */
const altSaving = ref(false);

/** 「关联 .mspp 插件包」开关 */
const fileAssoc = ref(true);
/** 首次读取中（同 loading，避免闪烁） */
const faLoading = ref(true);
/** 正在写入（写/清注册表期间禁用开关） */
const faSaving = ref(false);

/** 「自动下载更新」开关（默认开启） */
const autoDownloadUpdate = ref(true);
/** 首次读取中（同 loading，避免闪烁） */
const adLoading = ref(true);
/** 正在写入（期间禁用开关） */
const adSaving = ref(false);

/** 当前主题 */
const theme = ref<Theme>("system");

/** 读取一次系统真实状态 */
async function refresh(): Promise<void> {
  try {
    enabled.value = await getAutostartEnabled();
  } catch (e) {
    console.warn("读取开机自启动状态失败:", e);
  } finally {
    loading.value = false;
  }
}

/** 读取「Alt+点击文件快速带入」当前状态 */
async function refreshAlt(): Promise<void> {
  try {
    altClick.value = await getAltClickEnabled();
  } catch (e) {
    console.warn("读取 Alt+点击设置失败:", e);
  } finally {
    altLoading.value = false;
  }
}

/** 读取「自动下载更新」当前状态（本地存储，同步可读） */
function refreshAutoDownload(): void {
  try {
    autoDownloadUpdate.value = getAutoDownloadUpdate();
  } catch (e) {
    console.warn("读取自动下载更新设置失败:", e);
  } finally {
    adLoading.value = false;
  }
}

/** 读取「关联 .mspp 插件包」当前状态 */
async function refreshFileAssoc(): Promise<void> {
  try {
    fileAssoc.value = await getFileAssocEnabled();
  } catch (e) {
    console.warn("读取文件关联设置失败:", e);
  } finally {
    faLoading.value = false;
  }
}

/** 切换开关：先乐观更新，失败则回滚并提示 */
async function toggle(): Promise<void> {
  if (saving.value || loading.value) return;
  const next = !enabled.value;
  saving.value = true;
  enabled.value = next;
  try {
    await setAutostartEnabled(next);
    props.notify(next ? "已开启开机自启动。" : "已关闭开机自启动。", "ok");
  } catch (e) {
    enabled.value = !next;
    props.notify((e as Error)?.message ?? "设置开机自启动失败", "error");
  } finally {
    saving.value = false;
  }
}

/** 切换「自动下载更新」：先乐观更新，失败则回滚并提示 */
function toggleAutoDownload(): void {
  if (adSaving.value || adLoading.value) return;
  const next = !autoDownloadUpdate.value;
  adSaving.value = true;
  autoDownloadUpdate.value = next;
  try {
    setAutoDownloadUpdate(next);
    props.notify(
      next
        ? "已开启自动下载更新，检测到新版本将后台自动下载。"
        : "已关闭自动下载更新，仅可在「关于」面板手动下载安装。",
      "ok"
    );
  } catch (e) {
    autoDownloadUpdate.value = !next;
    props.notify((e as Error)?.message ?? "设置自动下载更新失败", "error");
  } finally {
    adSaving.value = false;
  }
}

/** 切换「Alt+点击文件快速带入」：先乐观更新，失败则回滚并提示 */
async function toggleAlt(): Promise<void> {
  if (altSaving.value || altLoading.value) return;
  const next = !altClick.value;
  altSaving.value = true;
  altClick.value = next;
  try {
    await setAltClickEnabled(next);
    props.notify(
      next ? "已开启 Alt+点击文件快速带入。" : "已关闭 Alt+点击文件快速带入。",
      "ok"
    );
  } catch (e) {
    altClick.value = !next;
    props.notify((e as Error)?.message ?? "设置 Alt+点击文件快速带入失败", "error");
  } finally {
    altSaving.value = false;
  }
}

/** 切换「关联 .mspp 插件包」：先乐观更新，失败则回滚并提示 */
async function toggleFileAssoc(): Promise<void> {
  if (faSaving.value || faLoading.value) return;
  const next = !fileAssoc.value;
  faSaving.value = true;
  fileAssoc.value = next;
  try {
    // 用后端返回的**注册表真实状态**回填：正式构建下若被权限/策略拦下，
    // 也会如实显示成未关联，而不是停在乐观值上骗自己。
    const actual = await setFileAssocEnabled(next);
    fileAssoc.value = actual;
    if (actual !== next) {
      props.notify("系统未接受该关联设置，请检查权限后重试。", "error");
      return;
    }
    props.notify(
      next
        ? "已关联 .mspp 插件包：资源管理器里双击插件包即可唤出安装确认。"
        : "已取消 .mspp 插件包关联，资源管理器中双击不再唤起本程序。",
      "ok"
    );
  } catch (e) {
    fileAssoc.value = !next;
    // Tauri 2 对 `Err(String)` 是**直接以字符串 reject** 的，`.message` 为
    // undefined——只取 .message 会把真正的失败原因（如「开发构建默认不写入…」）
    // 吞成兜底文案，用户看不到为什么失败（本项目实际踩过）。两种形态都要认。
    const msg = typeof e === "string" ? e : (e as Error)?.message;
    props.notify(msg || "设置文件关联失败", "error");
  } finally {
    faSaving.value = false;
  }
}

/** 切换主题 */
function onThemeChange(next: Theme): void {
  if (theme.value === next) return;
  theme.value = next;
  // setTheme 会把主题偏好与「已解析的深浅色」通过 themeReporter 上报原生层
  // （标题栏 / WebView 底色同步 + 广播 CSS 事件），无需在此另行调用。
  setTheme(next);
  const labels: Record<Theme, string> = {
    light: "已切换为浅色主题。",
    dark: "已切换为深色主题。",
    system: "已设置为跟随系统主题。",
  };
  props.notify(labels[next], "ok");
}

onMounted(async () => {
  refreshAutoDownload();
  void refreshFileAssoc();
  await Promise.all([refresh(), refreshAlt()]);
  theme.value = getTheme();
});
</script>

<template>
  <section class="page general">
    <div class="cfg-card">
      <div class="cfg-card-head">
        <h3>常规设置</h3>
      </div>

      <!-- 开机自启动 -->
      <div class="general-row">
        <div class="general-info">
          <span class="general-label">开机自启动</span>
          <span class="general-desc">
            登录系统后自动启动我的搜索并常驻托盘，按下呼出快捷键即可使用
          </span>
        </div>
        <label
          class="switch"
          :class="{ on: enabled, disabled: loading || saving }"
          title="开机自启动（默认开启，可随时关闭）"
        >
          <input
            type="checkbox"
            data-act="autostart"
            :checked="enabled"
            :disabled="loading || saving"
            @change="toggle"
          />
          <span class="switch-track" aria-hidden="true">
            <span class="switch-thumb"></span>
          </span>
        </label>
      </div>

      <!-- Alt+点击文件快速带入 -->
      <div class="general-row">
        <div class="general-info">
          <span class="general-label">Alt+点击文件快速带入</span>
          <span class="general-desc">
            在资源管理器或桌面按住 Alt 点击文件/文件夹，呼出搜索框并自动附加该文件
          </span>
        </div>
        <label
          class="switch"
          :class="{ on: altClick, disabled: altLoading || altSaving }"
          title="Alt+点击资源管理器文件快速带入（默认开启，可随时关闭）"
        >
          <input
            type="checkbox"
            data-act="alt-click"
            :checked="altClick"
            :disabled="altLoading || altSaving"
            @change="toggleAlt"
          />
          <span class="switch-track" aria-hidden="true">
            <span class="switch-thumb"></span>
          </span>
        </label>
      </div>

      <!-- 关联 .mspp 插件包 -->
      <div class="general-row">
        <div class="general-info">
          <span class="general-label">关联 .mspp 插件包</span>
          <span class="general-desc">
            在资源管理器中给 .mspp 插件包注册图标与双击处理；开启后双击插件包会唤出安装确认（写入当前用户注册表，卸载时可在此关闭）
          </span>
        </div>
        <label
          class="switch"
          :class="{ on: fileAssoc, disabled: faLoading || faSaving }"
          title="关联 .mspp 插件包（默认开启，可随时关闭）"
        >
          <input
            type="checkbox"
            data-act="file-assoc"
            :checked="fileAssoc"
            :disabled="faLoading || faSaving"
            @change="toggleFileAssoc"
          />
          <span class="switch-track" aria-hidden="true">
            <span class="switch-thumb"></span>
          </span>
        </label>
      </div>

      <!-- 自动下载更新 -->
      <div class="general-row">
        <div class="general-info">
          <span class="general-label">自动下载更新</span>
          <span class="general-desc">
            检测到新版本后在后台自动下载，点击更新徽章即可安装；关闭后不再自动检查下载，仅能在「关于」面板手动下载并安装
          </span>
        </div>
        <label
          class="switch"
          :class="{ on: autoDownloadUpdate, disabled: adLoading || adSaving }"
          title="自动下载更新（默认开启，可随时关闭）"
        >
          <input
            type="checkbox"
            data-act="auto-download-update"
            :checked="autoDownloadUpdate"
            :disabled="adLoading || adSaving"
            @change="toggleAutoDownload"
          />
          <span class="switch-track" aria-hidden="true">
            <span class="switch-thumb"></span>
          </span>
        </label>
      </div>

      <!-- 主题 -->
      <div class="general-row">
        <div class="general-info">
          <span class="general-label">主题</span>
          <span class="general-desc">选择界面配色风格，默认跟随系统设置</span>
        </div>
        <div class="theme-segmented segmented">
          <label :class="{ on: theme === 'light' }">
            <input
              type="radio"
              name="theme"
              value="light"
              :checked="theme === 'light'"
              @change="onThemeChange('light')"
            />
            <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14">
              <path fill-rule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clip-rule="evenodd" />
            </svg>
            <span>浅色</span>
          </label>
          <label :class="{ on: theme === 'dark' }">
            <input
              type="radio"
              name="theme"
              value="dark"
              :checked="theme === 'dark'"
              @change="onThemeChange('dark')"
            />
            <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14">
              <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
            </svg>
            <span>深色</span>
          </label>
          <label :class="{ on: theme === 'system' }">
            <input
              type="radio"
              name="theme"
              value="system"
              :checked="theme === 'system'"
              @change="onThemeChange('system')"
            />
            <svg viewBox="0 0 1024 1024" fill="currentColor" width="14" height="14">
              <path d="M797.769143 137.508571h-571.977143c-64.146286 0-116.297143 53.833143-116.297143 120.027429v370.102857c0 66.194286 52.224 119.954286 116.297143 119.954286h571.977143c64.219429 0 116.297143-53.76 116.297143-119.954286v-370.102857c0-66.194286-52.150857-120.027429-116.297143-120.027429z m38.765714 490.057143a39.497143 39.497143 0 0 1-38.765714 40.009143h-571.977143a39.497143 39.497143 0 0 1-38.765714-40.009143V257.462857c0-21.942857 17.408-39.936 38.765714-39.936h571.977143a39.497143 39.497143 0 0 1 38.765714 39.936v370.102857z m-496.347428 210.066286a39.497143 39.497143 0 0 0-38.765715 40.009143 39.497143 39.497143 0 0 0 38.765715 40.009143h343.478857a39.497143 39.497143 0 0 0 38.765714-39.936 39.497143 39.497143 0 0 0-38.765714-40.082286H340.114286z" />
            </svg>
            <span>跟随系统</span>
          </label>
        </div>
      </div>
    </div>
  </section>
</template>
