/**
 * 宿主 API 网关总装入口（`ms.*`）。
 *
 * 重构后按职责拆分为 `host/` 子模块：
 *   - `host/core.ts`        ：统一鉴权/审计管线 `createCallRunner` 与表驱动构造器 `defineRpcNamespace`
 *   - `host/event-hub.ts`   ：引用计数 Tauri/DOM 事件分发器与会话统一销毁 `disposePluginHostSession`
 *   - `host/native-api.ts`  ：表驱动系统原语（`screenshot` / `clipboard` / `gesture` / `shortcuts` / `backend`）
 *   - `host/ui-data-api.ts` ：界面、搜索、输入附件、存储（含文件化 `readJson/writeJson`）、环境变量与同步
 *   - `host/net-api.ts`     ：按域名 scope 鉴权的代理请求（支持二进制 `bodyBase64` / `responseType`）
 *   - `host/market-api.ts`  ：插件市场目录与强制用户确认的安装/更新管线
 *
 * 本文件保持所有历史导出符号兼容，外部调用方无需更改导入路径。
 */

import {
  assertKnownPermission,
  auditDenied,
  auditLog,
  createCallRunner,
  deniedPermissionsOf,
  pluginCacheGet,
  PluginPermissionError,
  PluginUnavailableError,
  readPluginSetting,
  recordDenied,
  safeStringify,
  type AuditEntry,
  type PluginHostContext,
  type PluginInstallConfirmRequest,
  type PluginSyncState,
} from "./host/core.ts";
import {
  activeSubscriptionCountForPlugin,
  dispatchShortcutAction,
  disposePluginHostSession,
  readPluginThemeProvider,
} from "./host/event-hub.ts";
import {
  createMarketApi,
  MARKET_CATALOG_URL,
  updatePluginFromMarket,
} from "./host/market-api.ts";
import {
  createNativeApis,
  type ClipboardItem,
  type ScreenshotCaptureResult,
  type ScreenshotCropResult,
  type ScreenshotMonitor,
  type ScreenshotOverlayImageResult,
  type ScreenshotPickResult,
  type ScreenshotShotEntry,
} from "./host/native-api.ts";
import {
  createNetApi,
  originOf,
  scopeAllows,
  type PluginNetFetchOptions,
  type PluginNetFetchResult,
} from "./host/net-api.ts";
import {
  bindPluginHostRuntime,
  createUiDataApis,
} from "./host/ui-data-api.ts";

export {
  PluginPermissionError,
  PluginUnavailableError,
  auditLog,
  recordDenied,
  auditDenied,
  assertKnownPermission,
  deniedPermissionsOf,
  readPluginSetting,
  pluginCacheGet,
  dispatchShortcutAction,
  readPluginThemeProvider,
  disposePluginHostSession,
  activeSubscriptionCountForPlugin,
  MARKET_CATALOG_URL,
  updatePluginFromMarket,
  bindPluginHostRuntime,
  originOf,
  scopeAllows,
};

export type {
  PluginHostContext,
  PluginInstallConfirmRequest,
  PluginSyncState,
  AuditEntry,
  PluginNetFetchOptions,
  PluginNetFetchResult,
  ScreenshotCaptureResult,
  ScreenshotOverlayImageResult,
  ScreenshotMonitor,
  ScreenshotCropResult,
  ScreenshotPickResult,
  ScreenshotShotEntry,
  ClipboardItem,
};

/**
 * 创建绑定指定 `pluginId` 的宿主沙箱 API 实例（注入插件入口脚本的 `ms` 对象）。
 */
export function createHostApi(
  pluginId: string,
  ctx: PluginHostContext
): Record<string, unknown> {
  const { record, call } = createCallRunner(pluginId, ctx);
  const uiData = createUiDataApis(pluginId, record, call, ctx);
  const native = createNativeApis(pluginId, call, ctx);
  const net = createNetApi(pluginId, call);
  const market = createMarketApi(pluginId, call, ctx);

  return {
    ...uiData,
    net,
    market,
    ...native,
    log: (level: "info" | "warn" | "error", ...args: unknown[]) => {
      const text = args
        .map((a) => (typeof a === "string" ? a : safeStringify(a)))
        .join(" ");
      ctx.log?.(pluginId, level, text);
    },
  };
}
