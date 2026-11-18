/**
 * 插件事件总线与会话级订阅生命周期管理（Event Hub）。
 *
 * 解决旧版 `host.ts` 的两个核心架构缺陷：
 *   1. **消除重复模板代码**：原先 `backend-changed`、`notification`、`screenshot-saved`、
 *      `clipboard-updated`、`gesture-record` 各自手写一套全局 Map + 懒加载 `listen()`，
 *      且多处监听一旦挂上永不卸载；现在统一为带引用计数的 `createTauriEventHub`；
 *   2. **杜绝会话销毁后的监听器泄漏**：原先 `screenshot.onSaved`、`clipboard.onUpdated`、
 *      `gesture.onRecord` 没有接入会话清理，插件（如 `closeBehavior: "exit"`）反复开关会不断
 *      堆积僵尸回调。现在统一提供 `disposePluginHostSession(pluginId)` 一次性回收全部订阅。
 */

import { effectiveTheme, THEME_CHANGED_EVENT } from "../../theme.ts";
import { isTauri } from "../../tauri-bridge.ts";

export interface PluginEventHub<TArg> {
  /** 为指定插件添加监听，返回幂等退订函数 */
  subscribe: (pluginId: string, handler: (arg: TArg) => void) => () => void;
  /** 清空指定插件在此通道上的全部监听（若全局已无任何订阅者则自动卸载底层 Tauri 监听） */
  clearPlugin: (pluginId: string) => void;
  /** 当前订阅该通道的插件数量（供单测验证零泄漏） */
  subscriberPluginCount: () => number;
}

/**
 * 创建带引用计数的 Tauri 事件分发器。
 *
 * - 首个插件订阅时才惰性注册底层 `listen(eventName)`；
 * - 最后一个插件退订或会话销毁时自动调用 `unlisten()` 释放底层通道；
 * - 非 Tauri 环境（Node 单测 / 浏览器纯前端调试）自动降级为纯内存表，不抛错。
 */
export function createTauriEventHub<TPayload, TArg>(opts: {
  eventName: string;
  label: string;
  route: (payload: TPayload, pluginId: string) => { match: boolean; arg: TArg };
}): PluginEventHub<TArg> {
  const byPlugin = new Map<string, Set<(arg: TArg) => void>>();
  let unlistenFn: (() => void) | null = null;
  let connecting = false;

  function maybeDetachGlobal(): void {
    if (byPlugin.size === 0 && unlistenFn) {
      const fn = unlistenFn;
      unlistenFn = null;
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
  }

  function ensureGlobal(): void {
    if (!isTauri || unlistenFn || connecting || byPlugin.size === 0) return;
    connecting = true;
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<TPayload>(opts.eventName, (event) => {
          for (const [pid, handlers] of [...byPlugin.entries()]) {
            const routed = opts.route(event.payload, pid);
            if (!routed.match) continue;
            for (const h of [...handlers]) {
              try {
                h(routed.arg);
              } catch (e) {
                console.warn(`[插件 ${pid}] ${opts.label}处理器异常:`, e);
              }
            }
          }
        })
      )
      .then((unlisten) => {
        connecting = false;
        if (byPlugin.size === 0) {
          try {
            unlisten();
          } catch {
            /* ignore */
          }
        } else {
          unlistenFn = unlisten;
        }
      })
      .catch((e) => {
        connecting = false;
        console.warn(`[插件] 注册${opts.label}监听失败:`, e);
      });
  }

  return {
    subscribe(pluginId: string, handler: (arg: TArg) => void): () => void {
      if (!pluginId || typeof handler !== "function") return () => {};
      let set = byPlugin.get(pluginId);
      if (!set) {
        set = new Set();
        byPlugin.set(pluginId, set);
      }
      set.add(handler);
      ensureGlobal();
      return () => {
        const cur = byPlugin.get(pluginId);
        if (!cur) return;
        cur.delete(handler);
        if (cur.size === 0) {
          byPlugin.delete(pluginId);
          maybeDetachGlobal();
        }
      };
    },
    clearPlugin(pluginId: string): void {
      if (byPlugin.delete(pluginId)) {
        maybeDetachGlobal();
      }
    },
    subscriberPluginCount(): number {
      return byPlugin.size;
    },
  };
}

/* ---------------- 1. 四个单层广播通道 ---------------- */

export const backendChangedHub = createTauriEventHub<
  { pluginId?: string; status?: string },
  unknown
>({
  eventName: "plugin://backend-changed",
  label: "后端状态",
  route: (payload, pid) => ({
    match: payload?.pluginId === pid,
    arg: payload,
  }),
});

export const screenshotSavedHub = createTauriEventHub<
  { pluginId?: string; relPath?: string },
  { pluginId?: string; relPath?: string }
>({
  eventName: "my-search://screenshot-saved",
  label: "截图已保存",
  route: (payload, pid) => {
    const p = payload ?? {};
    return {
      match: !p.pluginId || p.pluginId === pid,
      arg: p,
    };
  },
});

export const clipboardUpdatedHub = createTauriEventHub<unknown, void>({
  eventName: "my-search://clipboard-updated",
  label: "剪贴板更新",
  route: () => ({ match: true, arg: undefined }),
});

export const gestureRecordHub = createTauriEventHub<
  { pluginId?: string; pattern?: string },
  string
>({
  eventName: "my-search://gesture-record",
  label: "手势录制",
  route: (payload, pid) => ({
    match: !payload?.pluginId || payload.pluginId === pid,
    arg: typeof payload?.pattern === "string" ? payload.pattern : "",
  }),
});

/* ---------------- 2. 按方法分发的后端通知通道 ---------------- */

const notificationHandlers = new Map<string, Map<string, Set<(params: unknown) => void>>>();
let notificationUnlisten: (() => void) | null = null;
let notificationConnecting = false;

function maybeDetachNotificationGlobal(): void {
  if (notificationHandlers.size === 0 && notificationUnlisten) {
    const fn = notificationUnlisten;
    notificationUnlisten = null;
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
}

function ensureNotificationGlobal(): void {
  if (!isTauri || notificationUnlisten || notificationConnecting || notificationHandlers.size === 0) {
    return;
  }
  notificationConnecting = true;
  import("@tauri-apps/api/event")
    .then(({ listen }) =>
      listen<{ pluginId: string; method: string; params: unknown }>(
        "plugin://notification",
        (event) => {
          const { pluginId, method, params } = event.payload ?? ({} as any);
          const byMethod = notificationHandlers.get(pluginId);
          const handlers = byMethod?.get(method);
          if (!handlers) return;
          for (const h of [...handlers]) {
            try {
              h(params);
            } catch (e) {
              console.warn(`[插件 ${pluginId}] 通知处理器异常:`, e);
            }
          }
        }
      )
    )
    .then((unlisten) => {
      notificationConnecting = false;
      if (notificationHandlers.size === 0) {
        try {
          unlisten();
        } catch {
          /* ignore */
        }
      } else {
        notificationUnlisten = unlisten;
      }
    })
    .catch((e) => {
      notificationConnecting = false;
      console.warn("[插件] 注册通知监听失败:", e);
    });
}

export function addNotificationHandler(
  pluginId: string,
  method: string,
  handler: (params: unknown) => void
): () => void {
  if (!pluginId || !method || typeof handler !== "function") return () => {};
  let byMethod = notificationHandlers.get(pluginId);
  if (!byMethod) {
    byMethod = new Map();
    notificationHandlers.set(pluginId, byMethod);
  }
  let set = byMethod.get(method);
  if (!set) {
    set = new Set();
    byMethod.set(method, set);
  }
  set.add(handler);
  ensureNotificationGlobal();
  return () => removeNotificationHandler(pluginId, method, handler);
}

export function removeNotificationHandler(
  pluginId: string,
  method: string,
  handler: (params: unknown) => void
): void {
  const byMethod = notificationHandlers.get(pluginId);
  if (!byMethod || !method) return;
  const set = byMethod.get(method);
  if (set) {
    set.delete(handler);
    if (set.size === 0) byMethod.delete(method);
    if (byMethod.size === 0) {
      notificationHandlers.delete(pluginId);
      maybeDetachNotificationGlobal();
    }
  }
}

export function clearNotificationHandlers(pluginId: string): void {
  if (notificationHandlers.delete(pluginId)) {
    maybeDetachNotificationGlobal();
  }
}

/* ---------------- 3. 插件自定义快捷键动作分发 ---------------- */

const shortcutActionHandlers = new Map<string, Map<string, Set<() => void>>>();

export function addShortcutActionHandler(
  pluginId: string,
  action: string,
  handler: () => void
): () => void {
  if (!pluginId || !action || typeof handler !== "function") return () => {};
  let byAction = shortcutActionHandlers.get(pluginId);
  if (!byAction) {
    byAction = new Map();
    shortcutActionHandlers.set(pluginId, byAction);
  }
  let set = byAction.get(action);
  if (!set) {
    set = new Set();
    byAction.set(action, set);
  }
  set.add(handler);
  return () => removeShortcutActionHandler(pluginId, action, handler);
}

export function removeShortcutActionHandler(
  pluginId: string,
  action: string,
  handler?: () => void
): void {
  const byAction = shortcutActionHandlers.get(pluginId);
  const set = byAction?.get(action);
  if (!set) return;
  if (handler) set.delete(handler);
  else set.clear();
  if (set.size === 0) byAction?.delete(action);
  if (byAction?.size === 0) shortcutActionHandlers.delete(pluginId);
}

export function clearShortcutActionHandlers(pluginId: string): void {
  shortcutActionHandlers.delete(pluginId);
}

export function dispatchShortcutAction(pluginId: string, action: string): boolean {
  const handlers = shortcutActionHandlers.get(pluginId)?.get(action);
  if (!handlers || handlers.size === 0) return false;
  for (const h of [...handlers]) {
    try {
      h();
    } catch (e) {
      console.warn(`[插件 ${pluginId}] 快捷键动作处理器异常（${action}）:`, e);
    }
  }
  return true;
}

/* ---------------- 4. 宿主主题变更订阅 & 插件主题 Provider ---------------- */

const themeHandlers = new Map<string, Set<(theme: "light" | "dark") => void>>();
let themeListenerAttached = false;

function notifyThemeHandlers(): void {
  if (themeHandlers.size === 0) return;
  const theme = effectiveTheme();
  for (const handlers of themeHandlers.values()) {
    for (const h of [...handlers]) {
      try {
        h(theme);
      } catch (e) {
        console.warn("[插件] 主题变更处理器异常:", e);
      }
    }
  }
}

function syncDomThemeListener(): void {
  if (typeof document === "undefined") return;
  if (themeHandlers.size > 0 && !themeListenerAttached) {
    themeListenerAttached = true;
    document.addEventListener(THEME_CHANGED_EVENT, notifyThemeHandlers);
  } else if (themeHandlers.size === 0 && themeListenerAttached) {
    themeListenerAttached = false;
    document.removeEventListener(THEME_CHANGED_EVENT, notifyThemeHandlers);
  }
}

export function addThemeChangedHandler(
  pluginId: string,
  fn: (theme: "light" | "dark") => void
): () => void {
  if (!pluginId || typeof fn !== "function") return () => {};
  let set = themeHandlers.get(pluginId);
  if (!set) {
    set = new Set();
    themeHandlers.set(pluginId, set);
  }
  set.add(fn);
  syncDomThemeListener();
  return () => {
    const cur = themeHandlers.get(pluginId);
    if (!cur) return;
    cur.delete(fn);
    if (cur.size === 0) {
      themeHandlers.delete(pluginId);
      syncDomThemeListener();
    }
  };
}

export function clearThemeHandlers(pluginId: string): void {
  if (themeHandlers.delete(pluginId)) {
    syncDomThemeListener();
  }
}

const themeProviders = new Map<string, () => "light" | "dark" | "inherit">();

export function registerPluginThemeProvider(
  pluginId: string,
  fn: () => "light" | "dark" | "inherit"
): () => void {
  if (!pluginId || typeof fn !== "function") return () => {};
  themeProviders.set(pluginId, fn);
  return () => {
    if (themeProviders.get(pluginId) === fn) themeProviders.delete(pluginId);
  };
}

export function readPluginThemeProvider(
  pluginId: string
): "light" | "dark" | "inherit" | null {
  const fn = themeProviders.get(pluginId);
  if (!fn) return null;
  try {
    const v = fn();
    return v === "light" || v === "dark" || v === "inherit" ? v : null;
  } catch (e) {
    console.warn(`[插件 ${pluginId}] 主题 provider 异常:`, e);
    return null;
  }
}

export function clearThemeProvider(pluginId: string): void {
  themeProviders.delete(pluginId);
}

/* ---------------- 5. 会话级统一回收入口 ---------------- */

/**
 * 一次性销毁某插件在宿主前端侧注册的全部事件监听与状态回调。
 *
 * 视图宿主 `release(pluginId)` 或独立插件窗口卸载时只需调用本函数，
 * 不再需要逐个手调 `_clearNotifications` / `_clearBackendHandlers` 等私有钩子，
 * 彻底根除 `onSaved` / `onUpdated` / `onRecord` 等监听泄漏。
 */
export function disposePluginHostSession(pluginId: string): void {
  if (!pluginId) return;
  clearNotificationHandlers(pluginId);
  backendChangedHub.clearPlugin(pluginId);
  screenshotSavedHub.clearPlugin(pluginId);
  clipboardUpdatedHub.clearPlugin(pluginId);
  gestureRecordHub.clearPlugin(pluginId);
  clearShortcutActionHandlers(pluginId);
  clearThemeHandlers(pluginId);
  clearThemeProvider(pluginId);
}

/** 供测试检查某插件是否仍有任何残留监听 */
export function activeSubscriptionCountForPlugin(pluginId: string): number {
  let count = 0;
  if (notificationHandlers.has(pluginId)) count++;
  if (shortcutActionHandlers.has(pluginId)) count++;
  if (themeHandlers.has(pluginId)) count++;
  if (themeProviders.has(pluginId)) count++;
  // Hub 级统计（测试单插件时等价于该插件是否残留）
  count +=
    backendChangedHub.subscriberPluginCount() +
    screenshotSavedHub.subscriberPluginCount() +
    clipboardUpdatedHub.subscriberPluginCount() +
    gestureRecordHub.subscriberPluginCount();
  return count;
}
