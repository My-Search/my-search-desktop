/**
 * 搜索窗口的同步桥 —— 让插件（`ms.sync.*`）能用上数据同步。
 *
 * 真正的同步执行者是 `lib/sync/host.ts` 的常驻单例（主窗口就是搜索窗口）。
 * 本模块只做两件事：
 *   - 应用启动时启动宿主；
 *   - 把 `ms.sync.status()` / `ms.sync.trigger()` 映射成宿主调用。
 *
 * 不再按「有没有插件申请 sync 权限」启停：同步是用户级功能，开关在设置里，
 * 与插件数量无关；插件只是额外的触发入口。
 */

import { pluginSyncState, syncHost } from "../../lib/sync/host.ts";
import type { PluginSyncState } from "../../lib/plugins/host.ts";

/** 桥的对外 API */
export interface SyncBridge {
  /** 启动常驻同步宿主（幂等） */
  start: () => Promise<void>;
  status: () => PluginSyncState;
  now: () => Promise<PluginSyncState>;
  dispose: () => void;
}

export function useSyncBridge(): SyncBridge {
  return {
    start: () => syncHost.start(),

    status: () => pluginSyncState(),

    async now(): Promise<PluginSyncState> {
      await syncHost.start();
      if (!syncHost.currentConfig()?.enabled) {
        throw new Error(
          "数据同步未开启（请先在「设置 → 备份与同步」里开启并配置云端同步）"
        );
      }
      await syncHost.request("plugin");
      return pluginSyncState();
    },

    dispose: () => syncHost.dispose(),
  };
}
