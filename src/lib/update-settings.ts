/**
 * 更新相关的用户偏好（基础配置 / 常规设置里维护）。
 *
 * 存储键：my-search-desktop:auto_download_update
 * 默认：true（开启）—— 检测到新版本后在后台静默下载，点击徽章即可安装。
 *
 * 关闭后进入「全手动更新」：搜索主窗口不再检查、不再显示更新徽章、不再下载；
 * 更新入口只剩「设置 → 关于」面板——检测到新版本后由用户手动点击
 * 「下载并安装」，下载完成再自动拉起安装程序。
 *
 * 采用 localStorage 持久化：配置窗口与搜索窗口同源共享同一份存储，
 * 另一窗口总能读到最新值；但「读到」不等于「立刻重求值」——写入时会
 * 额外广播 my-search://auto-download-update-changed 事件（见 tauri-bridge），
 * 让搜索窗口当刻隐藏/显示更新徽章，而不必等下次呼出或定时检查
 * （见 useUpdateChecker）。
 */

import { storageGet, storageSet } from "./util";
import { notifyAutoDownloadChanged } from "./tauri-bridge";

/** 存储键（不含前缀，storageGet/storageSet 会自动补 `my-search-desktop:`） */
const AUTO_DOWNLOAD_KEY = "auto_download_update";

/** 默认值：开启自动下载更新 */
const DEFAULT_AUTO_DOWNLOAD_UPDATE = true;

/** 读取「自动下载更新」开关（未设置过时返回默认开启） */
export function getAutoDownloadUpdate(): boolean {
  return storageGet<boolean>(AUTO_DOWNLOAD_KEY, DEFAULT_AUTO_DOWNLOAD_UPDATE) !== false;
}

/** 写入「自动下载更新」开关（持久化到本地存储，并广播给搜索窗口立即生效） */
export function setAutoDownloadUpdate(enabled: boolean): void {
  storageSet(AUTO_DOWNLOAD_KEY, enabled);
  // 用户刚改动开关时（尤其关闭），搜索窗口的更新徽章必须当刻消失/出现，
  // 不能滞留到下一次主窗口呼出或 20 分钟定时检查。
  void notifyAutoDownloadChanged();
}
