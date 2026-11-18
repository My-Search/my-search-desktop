/**
 * 表驱动原生能力模块（`screenshot`、`clipboard`、`gesture`、`shortcuts`、`backend`）。
 *
 * 核心解耦设计：
 *   1. **零透传样板**：所有原生命令直接在此按插件身份 `pluginId` 调用 `ipc.ts`，
 *      彻底移除旧版 `PluginHostContext` 与 `usePluginHost.ts` 中的 38 个透传包装器；
 *   2. **系统原语化**：
 *      - `clipboard` 仅暴露原始捕获列表、图片读取、保留集声明（`setRetained`）与剪贴板写入，
 *        不再包含「收藏 / 分类 / 文本二次编辑 / 分页」等插件自身业务逻辑；
 *      - `shortcuts` 提供统一与插件无关的 `get(action)` / `set(action, shortcut)`，
 *        取代旧版为每个插件单独硬编码的快捷键读写命令。
 */

import {
  callPluginBackend,
  clipboardHistoryClear,
  clipboardHistoryCopy,
  clipboardHistoryDelete,
  clipboardHistoryList,
  clipboardHistoryReadImage,
  clipboardHistorySetRetained,
  gestureBindingsList,
  gestureBindingsSync,
  gestureGetEnabled,
  gestureListProcesses,
  gestureRecordCancel,
  gestureRecordStart,
  gestureSetEnabled,
  listPluginBackends,
  pluginShortcutGet,
  pluginShortcutSet,
  screenshotCapture,
  screenshotCloseOverlay,
  screenshotCopyImage,
  screenshotCrop,
  screenshotDeleteShot,
  screenshotListShots,
  screenshotNotifySaved,
  screenshotOpenOverlay,
  screenshotOverlayImage,
  screenshotPickRegion,
  screenshotPruneShots,
  screenshotReadShot,
  screenshotSaveShot,
  screenshotSaveShotAs,
  type GestureBindingIpc,
} from "../ipc.ts";
import {
  defineRpcNamespace,
  type CallRunner,
  type PluginHostContext,
} from "./core.ts";
import {
  addNotificationHandler,
  addShortcutActionHandler,
  backendChangedHub,
  clearNotificationHandlers,
  clearShortcutActionHandlers,
  clipboardUpdatedHub,
  gestureRecordHub,
  removeNotificationHandler,
  removeShortcutActionHandler,
  screenshotSavedHub,
} from "./event-hub.ts";

/** 截图抓屏结果 */
export interface ScreenshotCaptureResult {
  dataUrl: string;
  originX: number;
  originY: number;
  width: number;
  height: number;
}

export interface ScreenshotMonitor {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
  isPrimary: boolean;
}

export interface ScreenshotOverlayImageResult {
  dataUrl: string;
  width: number;
  height: number;
  monitor: ScreenshotMonitor;
  monitorCount: number;
  originX: number;
  originY: number;
}

export interface ScreenshotCropResult {
  dataUrl: string;
  width: number;
  height: number;
  screenX: number;
  screenY: number;
}

export interface ScreenshotPickResult {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenshotShotEntry {
  relPath: string;
  name: string;
  size: number;
  mtimeMs: number;
  createdAt: string;
}

/** 一条原始剪贴板捕获记录（`ms.clipboard.list()` 的返回项） */
export interface ClipboardItem {
  id: string;
  kind: string;
  text?: string;
  relPath?: string;
  width?: number;
  height?: number;
  size: number;
  createdAt: number;
  source?: string;
  retained?: boolean;
}

export function createNativeApis(
  pluginId: string,
  call: CallRunner,
  ctx: PluginHostContext
): {
  screenshot: Record<string, unknown>;
  clipboard: Record<string, unknown>;
  gesture: Record<string, unknown>;
  shortcuts: Record<string, unknown>;
  backend: Record<string, unknown>;
} {
  /* ---------------- 1. 截图原语 ---------------- */
  const screenshot = defineRpcNamespace(
    "screenshot",
    pluginId,
    call,
    {
      capture: {
        permission: "screenshot.capture",
        handler: ({ pluginId: pid }) => screenshotCapture(pid),
      },
      openOverlay: {
        permission: "screenshot.overlay",
        handler: ({ pluginId: pid }) => screenshotOpenOverlay(pid),
      },
      closeOverlay: {
        permission: "screenshot.overlay",
        handler: () => screenshotCloseOverlay(),
      },
      overlayImage: {
        permission: "screenshot.overlay",
        handler: (_env, monitorIndex: number) =>
          screenshotOverlayImage(Math.floor(Number(monitorIndex)) || 0),
      },
      crop: {
        permission: "screenshot.overlay",
        handler: (
          _env,
          monitorIndex: number,
          x: number,
          y: number,
          width: number,
          height: number
        ) =>
          screenshotCrop(
            Math.floor(Number(monitorIndex)) || 0,
            Number(x) || 0,
            Number(y) || 0,
            Number(width) || 0,
            Number(height) || 0
          ),
      },
      pickRegion: {
        permission: "screenshot.overlay",
        handler: ({ pluginId: pid }) => screenshotPickRegion(pid),
      },
      copy: {
        permission: "clipboard.write",
        handler: ({ pluginId: pid }, dataUrl: string) =>
          screenshotCopyImage(String(dataUrl ?? ""), pid),
      },
      save: {
        permission: "screenshot.write",
        detail: (dataUrl: string) => `${String(dataUrl ?? "").length} 字节`,
        handler: ({ pluginId: pid }, dataUrl: string) =>
          screenshotSaveShot(pid, String(dataUrl ?? "")),
      },
      saveAs: {
        permission: "screenshot.write",
        detail: (dataUrl: string) => `${String(dataUrl ?? "").length} 字节`,
        handler: ({ pluginId: pid }, dataUrl: string, parentDir?: string) =>
          screenshotSaveShotAs(
            pid,
            String(dataUrl ?? ""),
            parentDir ? String(parentDir) : undefined
          ),
      },
      notifySaved: {
        permission: "screenshot.write",
        handler: ({ pluginId: pid }, relPath?: string) =>
          screenshotNotifySaved(pid, relPath ? String(relPath) : undefined),
      },
      list: {
        permission: "screenshot.read",
        handler: ({ pluginId: pid }) => screenshotListShots(pid),
      },
      readShot: {
        permission: "screenshot.read",
        detail: (relPath: string) => String(relPath ?? "").slice(0, 300),
        handler: ({ pluginId: pid }, relPath: string) =>
          screenshotReadShot(pid, String(relPath ?? "")),
      },
      remove: {
        permission: "screenshot.read",
        detail: (relPath: string) => String(relPath ?? "").slice(0, 300),
        handler: ({ pluginId: pid }, relPath: string) =>
          screenshotDeleteShot(pid, String(relPath ?? "")),
      },
      prune: {
        permission: "screenshot.write",
        handler: ({ pluginId: pid }, days: number) =>
          screenshotPruneShots(pid, Math.max(1, Math.floor(Number(days)) || 7)),
      },
      // 兼容旧调用：底层统一委托给通用快捷键通道 `plugin_shortcut_get/set`
      getShortcut: {
        handler: ({ pluginId: pid }) => pluginShortcutGet(pid, "screenshot"),
      },
      setShortcut: {
        detail: (shortcut: string) => String(shortcut ?? ""),
        handler: ({ pluginId: pid }, shortcut: string) =>
          pluginShortcutSet(pid, "screenshot", String(shortcut ?? "")),
      },
    },
    {
      onSaved: (handler: (payload: { pluginId?: string; relPath?: string }) => void) =>
        screenshotSavedHub.subscribe(pluginId, handler),
    }
  );

  /* ---------------- 2. 剪贴板捕获与读写原语 ---------------- */
  const clipboard = defineRpcNamespace(
    "clipboard",
    pluginId,
    call,
    {
      list: {
        permission: "clipboard.read",
        detail: (query?: string) => (query ? String(query).slice(0, 100) : ""),
        handler: ({ pluginId: pid }, query?: string) =>
          clipboardHistoryList(pid, query ? String(query) : undefined),
      },
      readImage: {
        permission: "clipboard.read",
        detail: (relPath: string) => String(relPath ?? "").slice(0, 300),
        handler: ({ pluginId: pid }, relPath: string) =>
          clipboardHistoryReadImage(pid, String(relPath ?? "")),
      },
      copy: {
        permission: "clipboard.write",
        detail: (id: string) => String(id ?? ""),
        handler: ({ pluginId: pid }, id: string, textOverride?: string) =>
          clipboardHistoryCopy(
            pid,
            String(id ?? ""),
            typeof textOverride === "string" ? textOverride : undefined
          ),
      },
      writeText: {
        permission: "clipboard.write",
        handler: async (_env, text: string) => {
          await navigator.clipboard.writeText(String(text ?? ""));
          return true;
        },
      },
      remove: {
        permission: "clipboard.read",
        detail: (id: string) => String(id ?? ""),
        handler: ({ pluginId: pid }, id: string) =>
          clipboardHistoryDelete(pid, String(id ?? "")),
      },
      clear: {
        permission: "clipboard.read",
        detail: (opts?: { keepRetained?: boolean; keepFavorites?: boolean; retainIds?: string[] }) =>
          opts?.keepRetained === false || opts?.keepFavorites === false
            ? "keepRetained=false"
            : "",
        handler: (
          { pluginId: pid },
          opts?: { keepRetained?: boolean; keepFavorites?: boolean; retainIds?: string[] }
        ) =>
          clipboardHistoryClear(pid, {
            keepRetained:
              opts?.keepRetained !== undefined
                ? Boolean(opts.keepRetained)
                : opts?.keepFavorites !== false,
            retainIds: Array.isArray(opts?.retainIds) ? opts.retainIds.map(String) : undefined,
          }),
      },
      setRetained: {
        permission: "clipboard.read",
        detail: (ids: string[]) => `${Array.isArray(ids) ? ids.length : 0} 条保留`,
        handler: ({ pluginId: pid }, ids: string[]) =>
          clipboardHistorySetRetained(
            pid,
            Array.isArray(ids) ? ids.map((id) => String(id)) : []
          ),
      },
      // 兼容旧调用：统一转发到通用快捷键读写
      getShortcut: {
        handler: ({ pluginId: pid }) => pluginShortcutGet(pid, "clipboard"),
      },
      setShortcut: {
        detail: (shortcut: string) => String(shortcut ?? ""),
        handler: ({ pluginId: pid }, shortcut: string) =>
          pluginShortcutSet(pid, "clipboard", String(shortcut ?? "")),
      },
    },
    {
      onUpdated: (handler: () => void) => clipboardUpdatedHub.subscribe(pluginId, handler),
    }
  );

  /* ---------------- 3. 鼠标手势原语 ---------------- */
  const gesture = defineRpcNamespace(
    "gesture",
    pluginId,
    call,
    {
      getEnabled: {
        handler: ({ pluginId: pid }) => gestureGetEnabled(pid),
      },
      setEnabled: {
        detail: (enabled: boolean) => String(Boolean(enabled)),
        handler: ({ pluginId: pid }, enabled: boolean) =>
          gestureSetEnabled(pid, Boolean(enabled)),
      },
      listBindings: {
        handler: ({ pluginId: pid }) => gestureBindingsList(pid),
      },
      syncBindings: {
        permission: "gesture.exec",
        detail: (bindings: unknown) =>
          `${Array.isArray(bindings) ? bindings.length : 0} 条映射`,
        handler: ({ pluginId: pid }, bindings: unknown) =>
          gestureBindingsSync(pid, (Array.isArray(bindings) ? bindings : []) as GestureBindingIpc[]),
      },
      listProcesses: {
        handler: ({ pluginId: pid }) => gestureListProcesses(pid),
      },
      recordStart: {
        permission: "gesture.exec",
        handler: ({ pluginId: pid }) => gestureRecordStart(pid),
      },
      recordCancel: {
        permission: "gesture.exec",
        handler: ({ pluginId: pid }) => gestureRecordCancel(pid),
      },
    },
    {
      onRecord: (handler: (pattern: string) => void) =>
        gestureRecordHub.subscribe(pluginId, handler),
    }
  );

  /* ---------------- 4. 通用快捷键 API ---------------- */
  const shortcuts = defineRpcNamespace(
    "shortcuts",
    pluginId,
    call,
    {
      /** 读取本插件声明动作当前绑定的全局组合键（未设置返回空串） */
      get: {
        detail: (action: string) => String(action ?? ""),
        handler: ({ pluginId: pid }, action: string) =>
          pluginShortcutGet(pid, String(action ?? "")),
      },
      /** 改绑或解绑（传空串）本插件声明动作的全局组合键 */
      set: {
        detail: (action: string, shortcut: string) =>
          `${String(action ?? "")}=${String(shortcut ?? "")}`,
        handler: ({ pluginId: pid }, action: string, shortcut: string) =>
          pluginShortcutSet(pid, String(action ?? ""), String(shortcut ?? "")),
      },
    },
    {
      onAction: (action: string, handler: () => void): (() => void) =>
        addShortcutActionHandler(pluginId, String(action ?? ""), handler),
      offAction: (action: string, handler?: () => void): void =>
        removeShortcutActionHandler(pluginId, String(action ?? ""), handler),
      _clearActionHandlers: (): void => clearShortcutActionHandlers(pluginId),
    }
  );

  /* ---------------- 5. 后台进程管理 ---------------- */
  const backend = defineRpcNamespace(
    "backend",
    pluginId,
    call,
    {
      call: {
        permission: "backend.spawn",
        detail: (method: string) => String(method ?? ""),
        handler: ({ pluginId: pid }, method: string, params: unknown = null) =>
          ctx.callBackend
            ? ctx.callBackend(pid, String(method ?? ""), params)
            : callPluginBackend(pid, String(method ?? ""), params),
      },
      status: {
        handler: async ({ pluginId: pid }) => {
          const list = await listPluginBackends();
          return list.find((s) => s.pluginId === pid) ?? null;
        },
      },
    },
    {
      onNotification: (method: string, handler: (params: unknown) => void): (() => void) =>
        addNotificationHandler(pluginId, method, handler),
      offNotification: (method: string, handler: (params: unknown) => void): void =>
        removeNotificationHandler(pluginId, method, handler),
      _clearNotifications: (): void => clearNotificationHandlers(pluginId),
      onBackendChanged: (handler: (state: unknown) => void): (() => void) =>
        backendChangedHub.subscribe(pluginId, handler),
      _clearBackendHandlers: (): void => backendChangedHub.clearPlugin(pluginId),
    }
  );

  return { screenshot, clipboard, gesture, shortcuts, backend };
}
