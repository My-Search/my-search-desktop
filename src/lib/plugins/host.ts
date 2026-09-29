/**
 * 宿主 API 网关（前端侧）—— 插件**唯一**能触碰宿主能力的入口。
 *
 * 一次调用的完整链路：
 *
 *   插件代码
 *     └─ ms.xxx()            ← 宿主注入的对象（已绑定 pluginId，插件改不了身份）
 *          └─ hostApi.call() ← 本文件：①查注册表 ②查 enabled ③查已授予权限
 *                            ④写审计日志 ⑤分派到具体实现
 *               └─ Rust     ← 涉及原生能力时才过插件网关命令（再校验一次）
 *
 * 权限判定用 `permissions.ts` 的 `hasPermission`（支持 scope 覆盖），
 * 未授予 → 抛 `PluginPermissionError`，由插件视图宿主捕获并弹「请求授权」，
 * 用户同意后重试该调用（Android 式：拒绝不崩、可随时补授）。
 */

import type { SearchItem } from "../../types/index.ts";
import type { SearchResult } from "../../types/index.ts";
import { storageGet } from "../util.ts";
import { openExternal } from "../tauri-bridge.ts";
import { effectiveTheme, THEME_CHANGED_EVENT } from "../theme.ts";
import {
  groupPermissions,
  isKnownPermission,
  permissionBaseId,
  type PermissionGroupBlock,
} from "./permissions.ts";
import { iconDataUrl, isInlineIconRef } from "./icon.ts";
import type { PluginManifest } from "./manifest.ts";
import type { PluginRecord, PluginRegistryFile } from "./registry.ts";
import {
  findPlugin,
  isGranted,
  loadRegistry,
  markDenied,
  pluginDataGet,
  pluginDataSet,
  pluginDataRemove,
  resolvePluginTheme,
  saveRegistry,
} from "./registry.ts";
import { loadEnvVars } from "./env-store.ts";
import {
  attachmentFileIcons,
  attachmentList,
  attachmentListCancel,
  attachmentOpen,
  attachmentRead,
  attachmentReveal,
} from "./ipc.ts";
import type { AttachedEntry } from "./attachments.ts";

/** 权限不足（插件视图宿主据此弹授权，而不是当异常吞掉） */
export class PluginPermissionError extends Error {
  readonly permission: string;
  readonly pluginId: string;
  constructor(pluginId: string, permission: string) {
    super(`插件「${pluginId}」缺少权限: ${permission}`);
    this.name = "PluginPermissionError";
    this.pluginId = pluginId;
    this.permission = permission;
  }
}

/** 插件被禁用 / 已卸载 */
export class PluginUnavailableError extends Error {
  constructor(pluginId: string) {
    super(`插件不可用（已禁用或已卸载）: ${pluginId}`);
    this.name = "PluginUnavailableError";
  }
}

/** 宿主为插件注入的运行上下文（由 App.vue 提供宿主侧实现，解耦视图与引擎） */
export interface PluginHostContext {
  /** 当前注册表（引用，允许网关写回 grants/pendingPermission） */
  registry: () => PluginRegistryFile;
  /** 持久化注册表 */
  persistRegistry: () => void;
  /** 搜索库的只读副本（深拷贝，避免插件篡改宿主数据） */
  searchData: () => readonly SearchItem[];
  /** 触发一次搜索（等价老脚本的 registry.searchData.triggerSearchHandle） */
  triggerSearch: (keyword: string) => void;
  /** 改写搜索框内容（不触发搜索） */
  setInput: (text: string) => void;
  /** 收起详情视图回到结果列表 */
  hideDetail: () => void;
  /** 应用内提示 */
  toast: (text: string, type?: "ok" | "error") => void;
  /** 应用内确认框 */
  confirm: (text: string) => Promise<boolean>;
  /** 读取系统选中文本（会临时隐藏主窗，复用老脚本能力） */
  getSelectedText: (hint?: string) => Promise<string>;
  /** 打开插件独立窗口（M3 提供，未实现时抛错） */
  openPluginWindow?: (pluginId: string, entry: string, title: string) => void;
  /**
   * 安装前的用户确认（`ms.market.install` / `update` 的必经闸门）。
   *
   * 由窗口层注入：弹窗是宿主 UI（PluginInstallDialog.vue），插件运行时不该知道它的
   * 存在。返回 `true` = 用户确认安装，`false` = 用户取消。
   *
   * **未注入时市场安装一律拒绝**（fail-closed）：宁可报错也不静默把插件装进用户
   * 机器——「装插件」是对用户系统影响最大的动作，不能有绕过确认的路径。
   */
  confirmPluginInstall?: (req: PluginInstallConfirmRequest) => Promise<boolean>;
  /** 面板里请求授权（由面板注入；详情视图内为 null 时走内联弹窗） */
  requestPermission?: (pluginId: string, permission: string) => Promise<boolean>;
  /** 当前附加在搜索框里的文件/文件夹（ms.input.attachments 的数据源） */
  getAttachments?: () => readonly AttachedEntry[];
  /**
   * 请求宿主重新求解并应用一次插件主题（`ms.ui.registerThemeProvider` /
   * `ms.ui.applyTheme` 的下游）。
   *
   * 由搜索窗的视图宿主注入：它会读走本模块登记的 provider 返回值，再决定
   * 把呼出窗口切成插件主题还是恢复软件主题（详见 usePluginViewHost 与
   * theme-override.ts）。未注入时两个 API 退化为空操作。
   */
  refreshPluginTheme?: () => void;

  // ===== 截图（新增）=====
  /** 整屏抓屏 → { dataUrl, width, height }（mask 之前调用） */
  screenshotCapture?: () => Promise<ScreenshotCaptureResult>;
  /** 打开全屏框选遮罩（每显示器一个透明窗口），返回窗口数 */
  screenshotOpenOverlay?: () => Promise<number>;
  /** 关闭遮罩 */
  screenshotCloseOverlay?: () => Promise<void>;
  /** 取某屏的抓屏底图（data URL） */
  screenshotOverlayImage?: (monitorIndex: number) => Promise<ScreenshotOverlayImageResult>;
  /** 在遮罩里框选某屏一块 → 裁出 PNG data URL */
  screenshotCrop?: (
    monitorIndex: number,
    x: number,
    y: number,
    width: number,
    height: number
  ) => Promise<ScreenshotCropResult>;
  /** 在屏幕上直接框选一个矩形（开遮罩→拖选→关遮罩一次完成），Esc 取消返回 null */
  screenshotPickRegion?: () => Promise<ScreenshotPickResult | null>;
  /** 把 PNG data URL 写进系统剪贴板 */
  screenshotCopyImage?: (dataUrl: string) => Promise<void>;
  /** 把 PNG 落盘到插件私有目录，返回索引记录 */
  screenshotSaveShot?: (pluginId: string, dataUrl: string) => Promise<ScreenshotShotEntry>;
  /**
   * 弹系统「另存为」对话框，把 PNG 存到用户选定的位置。
   * 用户取消 → null（不是错误）；保存成功 → 落盘的绝对路径。
   */
  screenshotSaveShotAs?: (
    pluginId: string,
    dataUrl: string,
    parentDir?: string
  ) => Promise<string | null>;
  /** 插件截图目录的绝对路径（另存为对话框的起始目录） */
  screenshotShotsDir?: (pluginId: string) => Promise<string>;
  /** 广播「新截图已保存」事件，打开中的插件画廊据此刷新 */
  screenshotNotifySaved?: (pluginId?: string, relPath?: string) => Promise<void>;
  /** 列出插件私有目录的截图（时间从新到旧） */
  screenshotListShots?: (pluginId: string) => Promise<ScreenshotShotEntry[]>;
  /** 读回一张截图 → data URL */
  screenshotReadShot?: (pluginId: string, relPath: string) => Promise<string>;
  /** 删除一张截图 */
  screenshotDeleteShot?: (pluginId: string, relPath: string) => Promise<void>;
  /** 删除早于 N 天的截图，返回删掉的张数 */
  screenshotPruneShots?: (pluginId: string, days: number) => Promise<number>;
  /** 读「截图」动作当前绑的全局快捷键（权威在宿主的 shortcut_bindings） */
  screenshotGetShortcut?: () => Promise<string>;
  /** 给「截图」动作改绑全局快捷键（空串 = 解绑），返回实际生效的键 */
  screenshotSetShortcut?: (shortcut: string) => Promise<string>;

  // ===== 剪贴板历史（新增）=====
  /** 列出剪贴板历史（从新到旧）；query 非空时交 Rust 先做文本粗筛 */
  clipboardHistoryList?: (query?: string) => Promise<ClipboardItem[]>;
  /** 分页拉取剪贴板历史（过滤在分页前完成，返回总数与是否还有更多） */
  clipboardHistoryPage?: (opts: {
    query?: string;
    favoriteOnly?: boolean;
    offset?: number;
    limit?: number;
  }) => Promise<ClipboardPage>;
  /** 读回一张剪贴板图片 → data URL */
  clipboardHistoryReadImage?: (relPath: string) => Promise<string>;
  /** 删除一条剪贴板历史 */
  clipboardHistoryDelete?: (id: string) => Promise<void>;
  /** 清空剪贴板历史（keepFavorites=true 时保留收藏条目） */
  clipboardHistoryClear?: (keepFavorites?: boolean) => Promise<void>;
  /** 把某条历史复制回系统剪贴板（用户显式触发） */
  clipboardHistoryCopy?: (id: string) => Promise<void>;
  /** 收藏 / 取消收藏一条剪贴板历史 */
  clipboardHistorySetFavorite?: (id: string, favorite: boolean) => Promise<void>;
  /** 读「剪贴板历史」动作当前绑的全局快捷键（空串 = 未绑） */
  clipboardHistoryGetShortcut?: () => Promise<string>;
  /** 给「剪贴板历史」动作改绑全局快捷键（空串 = 解绑），返回实际生效的键 */
  clipboardHistorySetShortcut?: (shortcut: string) => Promise<string>;

  // ===== 数据同步（新增）=====
  /**
   * 发起一次数据同步（等价设置面板的「立即同步」），返回本轮结束后的状态。
   *
   * 由搜索窗注入（那里常驻着同步引擎；设置窗口不在时不至于无人能同步）。
   * **不做**「插件只能同步自己那块数据」的裁剪：同步走的是用户配置的云端备份，
   * 其单位就是「整份状态」，半份快照会污染用户的历史备份——这一点在权限描述里
   * 已向用户讲明（安装弹窗还会额外提醒）。
   */
  syncNow?: () => Promise<PluginSyncState>;
  /** 读同步状态（不触发同步；插件据此做进度/错误展示） */
  syncStatus?: () => PluginSyncState;
}

/**
 * 一次「安装确认」请求（市场安装/更新用）。
 *
 * 与 `install.ts` 的 `PreparedInstall` 相比，这里刻意只带**展示所需**的字段：
 * 待装文件（`files`）留在宿主侧，弹窗确认后由宿主自己落盘，插件拿不到也改不了
 * 即将写入磁盘的内容。
 */
export interface PluginInstallConfirmRequest {
  /** 待安装插件的清单（弹窗据此展示名称/版本/作者/描述） */
  manifest: PluginManifest;
  /** 可直接用于 `<img src>` 的图标（null = 无图标，弹窗显示占位） */
  iconUrl: string | null;
  /** 权限分组（弹窗渲染「请求权限」列表） */
  permBlocks: PermissionGroupBlock[];
  /** 清单校验警告（非致命，弹窗展示） */
  warnings: string[];
  /** 已安装版本（null = 未装过；弹窗按钮据此显示 安装/重新安装/升级） */
  installedVersion: string | null;
  /** 安装来源（市场卡片上点的是「安装」还是「更新」；仅用于文案） */
  action: "install" | "update";
}

/**
 * 暴露给插件的同步状态（`ms.sync.status()` / `ms.sync.trigger()` 的返回）。
 *
 * 刻意**不含** WebDAV 地址 / 用户名 / 是否已存密码：插件只需要知道「有没有开、
 * 现在在干嘛、上次啥时候、失败原因」，给它账号信息属于无谓的扩大暴露面。
 */
export interface PluginSyncState {
  /** 用户是否开启了云端同步（未开启时 trigger 会抛错） */
  enabled: boolean;
  status: "idle" | "syncing" | "uploading" | "downloading" | "error";
  lastSyncAt: number;
  lastError: string;
}

/** 截图抓屏结果 */
export interface ScreenshotCaptureResult {
  dataUrl: string;
  originX: number;
  originY: number;
  width: number;
  height: number;
}

/** 遮罩底图（某屏） */
export interface ScreenshotOverlayImageResult {
  dataUrl: string;
  width: number;
  height: number;
  monitor: ScreenshotMonitor;
  monitorCount: number;
  originX: number;
  originY: number;
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

/** 框选结果 */
export interface ScreenshotCropResult {
  dataUrl: string;
  width: number;
  height: number;
  screenX: number;
  screenY: number;
}

/** 「屏幕上直接框选」得到的矩形（虚拟桌面物理像素，与录屏采集坐标同口径） */
export interface ScreenshotPickResult {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 一条截图索引记录 */
export interface ScreenshotShotEntry {
  relPath: string;
  name: string;
  size: number;
  mtimeMs: number;
  createdAt: string;
}

/** 一条剪贴板历史（`ms.clipboard.list()` 的返回项） */
export interface ClipboardItem {
  /** 稳定 id（复制/删除时用） */
  id: string;
  /** "text" | "image" */
  kind: string;
  /** 文本内容（kind=text） */
  text?: string;
  /** 图片相对路径（kind=image，形如 "clipboard/xxx.png"） */
  relPath?: string;
  /** 图片宽（kind=image） */
  width?: number;
  /** 图片高（kind=image） */
  height?: number;
  /** 字节数 */
  size: number;
  /** 记录时间（毫秒时间戳） */
  createdAt: number;
  /** 来源描述（如「文件：a.txt」） */
  source?: string;
  /** 是否已收藏（收藏条目永久保留，不参与上限淘汰与默认清空） */
  favorite?: boolean;
}

/** 一页剪贴板历史（`ms.clipboard.page()` 的返回项） */
export interface ClipboardPage {
  /** 本页条目（从新到旧） */
  items: ClipboardItem[];
  /** 当前过滤条件下的总条数（不受分页影响） */
  total: number;
  /** 是否还有下一页 */
  hasMore: boolean;
}

/** 一次调用的审计记录（环形缓冲，面板「权限与调用记录」页签展示） */
export interface AuditEntry {
  at: number;
  pluginId: string;
  /** 调用的 API 名（如 "search.query"） */
  api: string;
  /** 涉及的具体资源（URL / 权限串） */
  detail?: string;
  result: "ok" | "denied" | "error";
  message?: string;
}

/** 审计日志上限（超出后丢弃最旧的） */
const AUDIT_LIMIT = 500;

/** 全局审计缓冲（插件面板展示，进程内即可，不落盘以免膨胀） */
export const auditLog: AuditEntry[] = [];

function pushAudit(entry: AuditEntry): void {
  auditLog.push(entry);
  if (auditLog.length > AUDIT_LIMIT) auditLog.splice(0, auditLog.length - AUDIT_LIMIT);
}

/* ============================================================
 * 后端通知监听管理器（模块级，跨 API 实例共享）
 * ============================================================ */

/** 通知监听器：pluginId → (method → Set<handler>) */
const notificationHandlers = new Map<string, Map<string, Set<(params: unknown) => void>>>();
/** 全局 Tauri 事件监听器 */
let globalNotificationListener: (() => void) | null = null;

/** 确保全局 listener 已注册（延迟加载避免模块启动时依赖 Tauri runtime） */
function ensureGlobalNotificationListener(): void {
  if (globalNotificationListener) return;
  import("@tauri-apps/api/event").then(({ listen }) => {
    listen<{ pluginId: string; method: string; params: unknown }>(
      "plugin://notification",
      (event) => {
        const { pluginId, method, params } = event.payload;
        const handlersByMethod = notificationHandlers.get(pluginId);
        if (!handlersByMethod) return;
        const handlers = handlersByMethod.get(method);
        if (handlers) {
          for (const h of handlers) {
            try { h(params); } catch (e) { console.warn(`[插件 ${pluginId}] 通知处理器异常:`, e); }
          }
        }
      },
    ).then((unlisten) => {
      globalNotificationListener = unlisten;
    }).catch((e) => {
      console.warn(`[插件] 注册通知监听失败:`, e);
    });
  });
}

/**
 * 为某个插件注册通知方法监听。
 * 返回取消监听的函数。
 */
function addNotificationHandler(
  pluginId: string,
  method: string,
  handler: (params: unknown) => void,
): () => void {
  if (!method || typeof handler !== "function") return () => {};
  ensureGlobalNotificationListener();
  let handlersByMethod = notificationHandlers.get(pluginId);
  if (!handlersByMethod) {
    handlersByMethod = new Map();
    notificationHandlers.set(pluginId, handlersByMethod);
  }
  let handlers = handlersByMethod.get(method);
  if (!handlers) {
    handlers = new Set();
    handlersByMethod.set(method, handlers);
  }
  handlers.add(handler);
  return () => {
    if (handlers) handlers.delete(handler);
    if (handlers?.size === 0) handlersByMethod?.delete(method);
    if (handlersByMethod?.size === 0) notificationHandlers.delete(pluginId);
  };
}

/** 清理某插件的所有通知监听（视图销毁时调用） */
function clearNotificationHandlers(pluginId: string): void {
  notificationHandlers.delete(pluginId);
}

/* ============================================================
 * 「截图已保存」事件监听管理器（模块级，跨 API 实例共享）
 *
 * 宿主遮罩保存截图后广播 `my-search://screenshot-saved`。与后端通知同构：
 * 全局 listen 一次，按 payload.pluginId 分发给订阅了 onSaved 的插件。
 * 未订阅时事件自然丢弃——画廊下次打开用 list() 兜底补齐。
 * ============================================================ */

/** 已保存事件监听器：pluginId → Set<handler> */
const screenshotSavedHandlers = new Map<string, Set<(payload: { pluginId?: string; relPath?: string }) => void>>();
let screenshotSavedListener: (() => void) | null = null;

function ensureScreenshotSavedListener(): void {
  if (screenshotSavedListener) return;
  import("@tauri-apps/api/event").then(({ listen }) => {
    listen<{ pluginId?: string; relPath?: string }>(
      "my-search://screenshot-saved",
      (event) => {
        const payload = event.payload ?? {};
        // 带 pluginId 的事件只发给对应插件；无 pluginId（宿主自己触发）发给所有订阅者
        for (const [pid, handlers] of screenshotSavedHandlers) {
          if (payload.pluginId && payload.pluginId !== pid) continue;
          for (const h of handlers) {
            try { h(payload); } catch (e) { console.warn(`[插件 ${pid}] 截图已保存处理器异常:`, e); }
          }
        }
      },
    ).then((unlisten) => {
      screenshotSavedListener = unlisten;
    }).catch((e) => {
      console.warn(`[插件] 注册截图已保存监听失败:`, e);
    });
  });
}

/** 为某插件注册「截图已保存」监听，返回取消函数。 */
function addScreenshotSavedListener(
  pluginId: string,
  handler: (payload: { pluginId?: string; relPath?: string }) => void,
): () => void {
  if (typeof handler !== "function") return () => {};
  ensureScreenshotSavedListener();
  let handlers = screenshotSavedHandlers.get(pluginId);
  if (!handlers) {
    handlers = new Set();
    screenshotSavedHandlers.set(pluginId, handlers);
  }
  handlers.add(handler);
  return () => {
    if (handlers) handlers.delete(handler);
    if (handlers?.size === 0) screenshotSavedHandlers.delete(pluginId);
  };
}

/* ============================================================
 * 「剪贴板有更新」事件监听管理器（模块级，跨 API 实例共享）
 *
 * 宿主原生监听剪贴板变更后广播 `my-search://clipboard-updated`（无 payload）。
 * 与截图已保存同构：全局 listen 一次，分发给订阅了 onUpdated 的插件实例。
 * 未订阅时事件自然丢弃——视图下次打开用 list() 兜底补齐。
 * ============================================================ */

/** 剪贴板更新监听器：pluginId → Set<handler> */
const clipboardUpdatedHandlers = new Map<string, Set<() => void>>();
let clipboardUpdatedListener: (() => void) | null = null;

function ensureClipboardUpdatedListener(): void {
  if (clipboardUpdatedListener) return;
  import("@tauri-apps/api/event").then(({ listen }) => {
    listen("my-search://clipboard-updated", () => {
      for (const [pid, handlers] of clipboardUpdatedHandlers) {
        for (const h of handlers) {
          try { h(); } catch (e) { console.warn(`[插件 ${pid}] 剪贴板更新处理器异常:`, e); }
        }
      }
    }).then((unlisten) => {
      clipboardUpdatedListener = unlisten;
    }).catch((e) => {
      console.warn(`[插件] 注册剪贴板更新监听失败:`, e);
    });
  });
}

/** 为某插件注册「剪贴板有更新」监听，返回取消函数。 */
function addClipboardUpdatedListener(pluginId: string, handler: () => void): () => void {
  if (typeof handler !== "function") return () => {};
  ensureClipboardUpdatedListener();
  let handlers = clipboardUpdatedHandlers.get(pluginId);
  if (!handlers) {
    handlers = new Set();
    clipboardUpdatedHandlers.set(pluginId, handlers);
  }
  handlers.add(handler);
  return () => {
    if (handlers) handlers.delete(handler);
    if (handlers?.size === 0) clipboardUpdatedHandlers.delete(pluginId);
  };
}

/* ============================================================
 * 主题变更监听管理器（模块级，跨 API 实例共享）
 *
 * 通知源只有一个 DOM 事件（THEME_CHANGED_EVENT，由 theme.ts 的 applyTheme
 * 派发）：跨窗口同步（设置窗口切主题 → Rust 事件 → 本窗口 theme.ts 监听
 * → applyTheme）与 system 模式下系统偏好变化，最终都汇聚到那里。
 * 因此本模块不需要自己碰 Tauri 事件 / matchMedia，浏览器调试环境同样工作。
 * ============================================================ */

/** 主题变更监听器：pluginId → Set<fn> */
const themeHandlers = new Map<string, Set<(theme: "light" | "dark") => void>>();
/** document 上的全局监听是否已挂（只挂一次） */
let themeListenerReady = false;

function notifyThemeHandlers(): void {
  if (themeHandlers.size === 0) return;
  const theme = effectiveTheme();
  for (const handlers of themeHandlers.values()) {
    for (const h of handlers) {
      try {
        h(theme);
      } catch (e) {
        console.warn("[插件] 主题变更处理器异常:", e);
      }
    }
  }
}

/** 确保全局监听已注册（首次订阅时挂，避免模块启动期依赖 DOM 就绪） */
function ensureThemeListener(): void {
  if (themeListenerReady) return;
  themeListenerReady = true;
  try {
    document.addEventListener(THEME_CHANGED_EVENT, notifyThemeHandlers);
  } catch (e) {
    console.warn("[插件] 注册主题监听失败:", e);
  }
}

/** 清理某插件的所有主题监听（视图卸载时调用） */
function clearThemeHandlers(pluginId: string): void {
  themeHandlers.delete(pluginId);
}

/* ============================================================
 * 插件主题 provider（插件自报「我该用深色还是浅色」）
 *
 * 与上面的 themeHandlers 方向相反：那是宿主 → 插件的通知；这是插件 → 宿主的
 * 上报。插件（如 pi-agent 左下角的主题切换）在入口脚本里调用
 * `ms.ui.registerThemeProvider(fn)` 登记一个返回 "dark" | "light" | "inherit"
 * 的函数，宿主在**每次打开/恢复插件视图**时读一次，据此决定呼出窗口的主题；
 * 插件界面内改主题后调用 `ms.ui.applyTheme()` 让宿主立即重新求解。
 *
 * 值缓存在模块级（跨挂载/恢复保留），随会话卸载（`_clearThemeProvider`）清理。
 * ============================================================ */

/** 插件主题 provider：pluginId → 返回当前偏好的函数 */
const themeProviders = new Map<string, () => "light" | "dark" | "inherit">();

/**
 * 市场索引地址（客户端唯一切入口）。
 *
 * 索引是市场仓库根目录下的 `index.dist.json`（仓库文件，走 raw 读取）：
 * 由 `plugins/index.json`（人工维护的源清单）经 tools 定时解析生成，
 * 内含每个插件的版本、sha256 与实际下载地址。
 *
 * 走仓库文件而非 Release 的原因：发布只需 git push，不需要额外的跨仓库 token。
 */
const MARKET_CATALOG_URL =
  "https://raw.githubusercontent.com/My-Search/my-search-plugin-market/main/index.dist.json";

/**
 * 取某插件自报的主题偏好（无 provider / provider 抛错 → null，由调用方回落到
 * 清单声明与用户偏好）。宿主不缓存返回值的合法性：插件每次读都可能给新值。
 */
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

/** 清理某插件的主题 provider（视图卸载时调用） */
function clearThemeProvider(pluginId: string): void {
  themeProviders.delete(pluginId);
}

/** 未注入同步能力时的兜底状态（浏览器调试 / 未启用同步：一律「关」） */
function offlineSyncState(): PluginSyncState {
  return { enabled: false, status: "idle", lastSyncAt: 0, lastError: "" };
}

/**
 * 创建某个插件的宿主 API 实例。
 *
 * 返回的对象会被注入到插件视图的沙箱作用域里（`ms.*`）；
 * 所有方法都已绑定 pluginId，插件无法伪造身份去调用别的插件的能力。
 */
export function createHostApi(pluginId: string, ctx: PluginHostContext): Record<string, unknown> {
  const record = (): PluginRecord | undefined => ctx.registry().plugins.find((p) => p.id === pluginId);

  /** 统一入口：可用性 → 权限 → 审计 → 执行 */
  function call<T>(opts: {
    api: string;
    permission?: string;
    detail?: string;
    run: (record: PluginRecord) => T | Promise<T>;
  }): T | Promise<T> {
    const rec = record();
    if (!rec || !rec.enabled) {
      pushAudit({ at: Date.now(), pluginId, api: opts.api, result: "denied", message: "插件不可用" });
      throw new PluginUnavailableError(pluginId);
    }
    if (opts.permission) {
      // 权限串可能带 scope（net.fetch:https://... 由具体实现补全后只传基础 id 检查）
      if (!isGranted(rec, opts.permission)) {
        pushAudit({
          at: Date.now(),
          pluginId,
          api: opts.api,
          detail: opts.permission,
          result: "denied",
          message: "未授予权限",
        });
        throw new PluginPermissionError(pluginId, opts.permission);
      }
    }
    try {
      const out = opts.run(rec);
      if (out instanceof Promise) {
        return out.then(
          (v) => {
            pushAudit({ at: Date.now(), pluginId, api: opts.api, detail: opts.detail, result: "ok" });
            return v;
          },
          (e) => {
            pushAudit({
              at: Date.now(),
              pluginId,
              api: opts.api,
              detail: opts.detail,
              result: "error",
              message: String((e as Error)?.message ?? e),
            });
            throw e;
          }
        );
      }
      pushAudit({ at: Date.now(), pluginId, api: opts.api, detail: opts.detail, result: "ok" });
      return out;
    } catch (e) {
      pushAudit({
        at: Date.now(),
        pluginId,
        api: opts.api,
        detail: opts.detail,
        result: "error",
        message: String((e as Error)?.message ?? e),
      });
      throw e;
    }
  }

  /** 深拷贝数据项（插件拿到的是副本，改不动宿主） */
  const cloneItem = (item: SearchItem): SearchItem => {
    try {
      return structuredClone(item);
    } catch (e) {
      return JSON.parse(JSON.stringify(item)) as SearchItem;
    }
  };

  const api: Record<string, unknown> = {
    /** 插件元信息（含已授予权限，便于插件做能力降级） */
    plugin: {
      id: pluginId,
      get info() {
        const rec = record();
        return rec
          ? {
              id: rec.id,
              name: rec.name,
              version: rec.version,
              enabled: rec.enabled,
              /**
               * 本插件界面**声明的**默认主题（"dark" | "light" | "inherit"）。
               *
               * 供插件初始化自己的主题偏好用：插件在界面里提供主题切换时，默认值
               * 应当取自这里（而不是硬编码 "inherit"）——否则插件会用自己的默认值
               * 覆盖清单声明，出现「清单写了 dark、界面却仍跟随宿主」的怪象。
               * 口径与视图宿主一致：用户面板选择 → 清单声明 → inherit。
               */
              theme: resolvePluginTheme(rec),
            }
          : { id: pluginId, name: pluginId, version: "?", enabled: false, theme: "inherit" as const };
      },
      granted: () => record()?.grants.map((g) => g.permission) ?? [],
      has: (permission: string) => {
        const rec = record();
        return rec ? isGranted(rec, permission) : false;
      },
    },

    /* ---------------- 搜索 ---------------- */
    search: {
      /** 全部数据项（只读副本） */
      data: () =>
        call({ api: "search.data", permission: "search.read", run: () => ctx.searchData().map(cloneItem) }),
      /** 直接返回数据项数组（与老脚本 getSearchDB 语义一致，便于迁移） */
      getSearchDB: () =>
        call({ api: "search.getSearchDB", permission: "search.read", run: () => ctx.searchData().map(cloneItem) }),
      /**
       * 检索：复用宿主的检索实现（由宿主注入），返回精简结果。
       * @param keyword 关键词
       * @param limit 最多返回条数（默认 30）
       */
      query: (keyword: string, limit = 30) =>
        call({
          api: "search.query",
          permission: "search.read",
          detail: String(keyword).slice(0, 80),
          run: async () => {
            const kw = String(keyword ?? "");
            const raw = await hostSearch(kw);
            return raw.slice(0, Math.max(1, Math.min(200, limit))).map((r) => ({
              level: r.level,
              item: cloneItem(r.item),
            }));
          },
        }),
      /** 触发宿主搜索（等价 registry.searchData.triggerSearchHandle） */
      trigger: (keyword: string) =>
        call({
          api: "search.trigger",
          permission: "search.write",
          detail: String(keyword).slice(0, 80),
          run: () => {
            ctx.triggerSearch(String(keyword ?? ""));
            return true;
          },
        }),
      /** 改写搜索框（不触发搜索） */
      setInput: (text: string) =>
        call({
          api: "search.setInput",
          permission: "search.write",
          run: () => {
            ctx.setInput(String(text ?? ""));
            return true;
          },
        }),
      /** 收起详情视图，回到结果列表 */
      closeView: () =>
        call({
          api: "search.closeView",
          permission: "search.write",
          run: () => {
            ctx.hideDetail();
            return true;
          },
        }),
      /** 点击加权（插件条目被使用时） */
      score: (item: SearchItem) =>
        call({
          api: "search.score",
          permission: "search.write",
          run: () => {
            // 延迟引用于 runtime，避免与 search-engine 形成循环依赖
            scoreItem(item);
            return true;
          },
        }),
    },

    /* ---------------- 界面 ---------------- */
    ui: {
      toast: (text: string, type: "ok" | "error" = "ok") =>
        call({
          api: "ui.toast",
          permission: "ui.notify",
          run: () => {
            ctx.toast(String(text ?? ""), type === "error" ? "error" : "ok");
            return true;
          },
        }),
      confirm: (text: string) =>
        call({
          api: "ui.confirm",
          permission: "ui.notify",
          run: () => ctx.confirm(String(text ?? "")),
        }),
      /** 设置视图高度（宿主按内容自适应时一般不需要手动调用） */
      setHeight: (px: number) =>
        call({
          api: "ui.setHeight",
          permission: "ui.inlay",
          run: () => {
            const n = Math.max(0, Math.min(2000, Math.round(Number(px) || 0)));
            ctx.setViewHeight?.(n);
            return true;
          },
        }),
      /** 打开独立窗口（v1 未实现，保留 API 形状） */
      openWindow: (entry: string, title?: string) =>
        call({
          api: "ui.openWindow",
          permission: "ui.window",
          run: () => {
            if (!ctx.openPluginWindow) throw new Error("当前版本尚不支持独立窗口");
            ctx.openPluginWindow(pluginId, String(entry ?? ""), String(title ?? ""));
            return true;
          },
        }),
      /**
       * 弹系统「选择文件夹」对话框，返回用户选中的**绝对路径**；
       * 用户取消返回 `null`（取消不是错误）。
       *
       * 挂在 `ui.inlay` 权限下：这是纯界面行为——只把用户**主动挑选**的一个
       * 路径交回插件，并不授予插件访问该路径的读取能力（插件要读它仍需
       * `file.read` 且走附加集合校验）。因此不新增权限项、不加重安装负担。
       *
       * 典型的「添加项目」用法：用户不想手敲路径，点按钮选一个文件夹，
       * 拿到路径后交给插件自己的后端去登记。
       */
      pickFolder: (opts?: { title?: string; defaultPath?: string }) =>
        call({
          api: "ui.pickFolder",
          permission: "ui.inlay",
          run: async (): Promise<string | null> => {
            const { isTauri } = await import("../tauri-bridge.ts");
            // 浏览器调试环境没有系统对话框：返回 null（等同取消），
            // 不抛错——插件据此保持「手动输入」这条退路即可。
            if (!isTauri) return null;
            try {
              const pkg: any = await import("@tauri-apps/plugin-dialog");
              const picked = await pkg.open({
                directory: true,
                multiple: false,
                title: String(opts?.title ?? "选择文件夹"),
                defaultPath:
                  typeof opts?.defaultPath === "string" && opts.defaultPath.trim() !== ""
                    ? opts.defaultPath
                    : undefined,
              });
              // 不同版本可能回字符串或 { path }；统一收敛成绝对路径字符串。
              if (typeof picked === "string") return picked;
              if (picked && typeof picked === "object" && typeof (picked as any).path === "string") {
                return (picked as any).path;
              }
              return null;
            } catch (e) {
              console.warn(`[插件 ${pluginId}] 打开文件夹选择对话框失败:`, e);
              throw new Error("文件夹选择对话框不可用");
            }
          },
        }),

      /**
       * 当前生效主题（"light"/"dark"；「跟随系统」时返回按系统偏好解析后的结果）。
       * 不做权限门控：属环境信息（同 plugin.*），插件据此做逻辑级主题适配
       * （如选图标、切动态渲染的配色）。纯 CSS 换色不需要它——直接用宿主
       * 共享变量 `var(--text, 兜底)` 即可（见 style.css「插件共享主题变量」节）。
       */
      get theme(): "light" | "dark" {
        return effectiveTheme();
      },
      /**
       * 订阅主题变更，返回退订函数（与 backend.onNotification 同形态）。
       * 保活（停靠）会话继续收到；会话卸载时由宿主统一清理（_clearThemeHandlers）。
       */
      onThemeChanged: (fn: (theme: "light" | "dark") => void): (() => void) => {
        if (typeof fn !== "function") return () => {};
        let handlers = themeHandlers.get(pluginId);
        if (!handlers) {
          handlers = new Set();
          themeHandlers.set(pluginId, handlers);
        }
        handlers.add(fn);
        ensureThemeListener();
        return () => {
          handlers.delete(fn);
          if (handlers.size === 0) themeHandlers.delete(pluginId);
        };
      },
      /** 清理本插件的全部主题订阅（视图宿主卸载会话时调用） */
      _clearThemeHandlers: (): void => {
        clearThemeHandlers(pluginId);
      },
      /**
       * 登记「本插件界面当前想用哪套主题」的 provider，返回退订函数。
       *
       * provider 返回 `"dark"` / `"light"` 时，宿主在打开本插件视图期间会把
       * **整个呼出窗口**切成该主题（搜索框与插件面板同色），关闭后恢复软件主题；
       * 返回 `"inherit"` 表示跟随宿主主题。宿主在每次打开/恢复视图时读一次，
       * 因此保活（最小化）的会话也能在再次打开时被重新询问。
       *
       * 典型用法（插件自带的主题切换，如 pi-agent 左下角）：
       * ```js
       * let pref = await ms.store.get("theme") ?? "inherit";
       * ms.ui.registerThemeProvider(() => pref);
       * // 用户切换后：
       * pref = "light";
       * await ms.store.set("theme", pref);
       * ms.ui.applyTheme();   // 让宿主立即重新求解并应用
       * ```
       * 不做权限门控：与 `theme` 同源，属界面环境信息。
       */
      registerThemeProvider: (
        fn: () => "light" | "dark" | "inherit"
      ): (() => void) => {
        if (typeof fn !== "function") return () => {};
        themeProviders.set(pluginId, fn);
        return () => {
          if (themeProviders.get(pluginId) === fn) themeProviders.delete(pluginId);
        };
      },
      /**
       * 让宿主立即重新求解并应用一次本插件的主题（provider 值变化后调用）。
       * 不做权限门控：纯界面行为，且只影响本插件自己的视图。
       */
      applyTheme: (): boolean => {
        try {
          ctx.refreshPluginTheme?.();
        } catch (e) {
          console.warn(`[插件 ${pluginId}] 应用插件主题失败:`, e);
        }
        return true;
      },
      /** 清理本插件的主题 provider（视图宿主卸载会话时调用） */
      _clearThemeProvider: (): void => {
        clearThemeProvider(pluginId);
      },
    },

    /* ---------------- 输入附件（粘贴/拖入搜索框的文件与文件夹） ----------------
     *
     * 整个命名空间挂在 `file.read` 权限下：元数据、内容读取、目录列举、
     * 系统打开一并受控。前端查权限是第一道；Rust 侧（attachment_* 命令）
     * 还会复核网关 grants +「路径必须落在已登记的附加集合内」，插件因此
     * 拿不到集合之外的本地文件。
     *
     * 语义提醒：附件是**用户主动放进搜索框**的内容，插件可以选择不处理
     * （如文件搜索插件遇到非目标文件夹时给出提示即可）。
     */
    input: {
      /** 当前附加的文件/文件夹（浅拷贝：插件改不动宿主状态） */
      attachments: () =>
        call({
          api: "input.attachments",
          permission: "file.read",
          run: () => (ctx.getAttachments?.() ?? []).map((a) => ({ ...a })),
        }),
      /** 读附加文件内容 → data URL（`data:<mime>;base64,...`） */
      readFile: (path: string) =>
        call({
          api: "input.readFile",
          permission: "file.read",
          detail: String(path ?? "").slice(0, 300),
          run: async () => {
            const p = String(path ?? "").trim();
            if (!p) throw new Error("缺少文件路径");
            return await attachmentRead(pluginId, p);
          },
        }),
      /** 递归列举附加文件夹（{path,name,relPath,isDir,size,mtimeMs}[]；gen 见 cancelListFolder） */
      listFolder: (path: string, opts: { limit?: number; gen?: number } = {}) =>
        call({
          api: "input.listFolder",
          permission: "file.read",
          detail: String(path ?? "").slice(0, 300),
          run: async () => {
            const p = String(path ?? "").trim();
            if (!p) throw new Error("缺少文件夹路径");
            const limit = Number(opts?.limit) || 20000;
            const gen = Math.floor(Number(opts?.gen));
            return await attachmentList(
              pluginId,
              p,
              limit,
              Number.isFinite(gen) && gen > 0 ? gen : undefined
            );
          },
        }),
      /** 取消一代列举（gen = 该轮 listFolder 传入的 gen）：在途 walk 尽快带着部分结果返回 */
      cancelListFolder: (gen: number) =>
        call({
          api: "input.cancelListFolder",
          permission: "file.read",
          run: async () => {
            const g = Math.floor(Number(gen));
            if (!Number.isFinite(g) || g <= 0) throw new Error("缺少列举代次（gen）");
            await attachmentListCancel(g);
            return true;
          },
        }),
      /** 用系统默认程序打开附加的文件 / 文件夹 */
      open: (path: string) =>
        call({
          api: "input.open",
          permission: "file.read",
          detail: String(path ?? "").slice(0, 300),
          run: async () => {
            const p = String(path ?? "").trim();
            if (!p) throw new Error("缺少路径");
            await attachmentOpen(pluginId, p);
            return true;
          },
        }),
      /**
       * 在系统文件管理器（Windows 资源管理器）中定位附加的文件 / 文件夹：
       * 打开所在目录并选中该条目。与 `open` 同权限、同「附加集合」校验。
       */
      reveal: (path: string) =>
        call({
          api: "input.reveal",
          permission: "file.read",
          detail: String(path ?? "").slice(0, 300),
          run: async () => {
            const p = String(path ?? "").trim();
            if (!p) throw new Error("缺少路径");
            await attachmentReveal(pluginId, p);
            return true;
          },
        }),
      /**
       * 批量取**系统文件图标**（资源管理器同款：.docx 显示 Word 图标、
       * .pdf 显示 PDF 图标…），返回 `path → PNG data URL`。
       *
       * 与 `listFolder` 同权限（`file.read`），Rust 侧还会做「网关 grants +
       * 附加集合」双重校验——传入集合外的路径会整批报错（调用方需自行过滤，
       * 本 API 只服务已附加文件夹里的条目）。
       *
       * 语义提醒：取值失败/取不到的条目**不会出现在返回的 Map 里**（调用方
       * 用 `map.get(path)` 拿到 undefined/空串时退回内置图标），不会抛错——
       * 只有「权限/集合校验」这类调用级错误才抛。
       */
      fileIcons: (entries: { path: string; isDir?: boolean }[]) =>
        call({
          api: "input.fileIcons",
          permission: "file.read",
          detail: `${Array.isArray(entries) ? entries.length : 0} 个路径`,
          run: async () => {
            const list = (Array.isArray(entries) ? entries : [])
              .filter((e) => e && String(e.path ?? "").trim() !== "")
              .map((e) => ({ path: String(e.path), isDir: !!e.isDir }));
            if (list.length === 0) return {};
            const map = await attachmentFileIcons(list, pluginId);
            // Map 过不了插件与宿主之间的结构化克隆边界（new Function 直传
            // 时虽然是同进程对象，但 API 契约要稳定、可序列化）——统一成
            // 普通对象 `{ [path]: dataUrl }`。
            const out: Record<string, string> = {};
            for (const [k, v] of map) out[k] = v;
            return out;
          },
        }),
    },

    /* ---------------- 存储 ---------------- */
    store: {
      get: (key: string, fallback: unknown = null) =>
        call({
          api: "store.get",
          permission: "store",
          run: () => pluginDataGet(pluginId, String(key ?? ""), fallback),
        }),
      set: (key: string, value: unknown) =>
        call({
          api: "store.set",
          permission: "store",
          run: () => {
            pluginDataSet(pluginId, String(key ?? ""), value);
            return true;
          },
        }),
      remove: (key: string) =>
        call({
          api: "store.remove",
          permission: "store",
          run: () => {
            pluginDataRemove(pluginId, String(key ?? ""));
            return true;
          },
        }),
      keys: () =>
        call({
          api: "store.keys",
          permission: "store",
          run: () => pluginDataKeys(pluginId),
        }),
    },

    /* ---------------- 环境变量（宿主集中配置；逐项授权） ----------------
     *
     * 设计要点（与 README「环境变量」一节对应）：
     *   - **只看得见被授权的**：`list()` / `granted()` / `has()` 都以注册表里的
     *     `env.read:<NAME>` 授予记录为准，未授权的变量对插件**完全不可见**；
     *   - **值不出插件上下文**：本命名空间**不提供 `get()`**。值只由宿主在下发
     *     网关配置时交给 Rust，由 Rust 在 spawn 后台进程时注入为真正的进程环境
     *     变量（插件在自己的配置里写 `$NAME` 引用即可）。这样密钥不会进入插件
     *     JS 上下文，也不会出现在插件可读的 DOM 里（inlay 不是沙箱）；
     *   - `pick()` 打开**宿主绘制**的授权弹层：用户亲自选择/授权，插件无法伪造。
     */
    env: {
      /** 已授权可见的变量名（不带值） */
      granted: () => envGrantedNames(pluginId),
      /** 是否已获授权使用某个变量 */
      has: (name: string) => envGrantedNames(pluginId).includes(String(name ?? "")),
      /**
       * 已授权变量的元信息（名字 + 用途说明；**绝不含值**）。
       * 插件据此渲染「从环境变量取密钥」那类只读提示或下拉。
       */
      list: () =>
        call({
          api: "env.list",
          run: () => envDescribe(pluginId),
        }),
      /**
       * 打开宿主的授权选择器（用户亲自操作）。
       * 返回 `{ kind:"ref", name, ref:"$NAME" }`（插件把它填进自己的输入框）、
       * `{ kind:"literal", value }`（用户选择手工输入字面量）、或 `null`（取消）。
       */
      pick: (opts: { title?: string; purpose?: string } = {}) =>
        call({
          api: "env.pick",
          run: async () => {
            if (!ctx.pickEnvVar) return null;
            return await ctx.pickEnvVar(pluginId, {
              title: opts?.title ? String(opts.title) : undefined,
              purpose: opts?.purpose ? String(opts.purpose) : undefined,
            });
          },
        }),
    },

    /* ---------------- 数据同步（gate: sync） ----------------
     *
     * 宿主原生只实现了一种数据源（WebDAV），但这里按「能力」而非「数据源」暴露：
     * 以后接入第三方同步源时 API 与权限都不变，插件无需改清单、用户无需重新授权。
     *
     * 同步对象是**用户自己的云端备份**（整份可备份数据：设置、订阅、插件与插件
     * 数据），因此它能读到的东西超出「这个插件自己的数据」——安装时已向用户
     * 提醒过，权限描述里也写明了。
     */
    sync: {
      /** 读同步状态（不触发；未配置同步时 enabled=false） */
      status: () =>
        call({
          api: "sync.status",
          permission: "sync",
          run: (): PluginSyncState => ctx.syncStatus?.() ?? offlineSyncState(),
        }),
      /**
       * 发起一次同步（按用户的冲突策略决定上传还是下载），返回结束后的状态。
       *
       * 语义提醒：这是**异步且可能较久**的动作（上传/下载整份备份），不要放在
       * 界面主流程里阻塞用户；失败以返回值的 `status: "error"` + `lastError`
       * 表达（而非抛错），只有「权限不足 / 未配置同步」才抛。
       */
      trigger: () =>
        call({
          api: "sync.trigger",
          permission: "sync",
          run: async (): Promise<PluginSyncState> => {
            if (!ctx.syncNow) throw new Error("当前窗口不支持数据同步");
            return await ctx.syncNow();
          },
        }),
    },

    /* ---------------- 网络 ---------------- */
    net: {
      /**
       * 经宿主的 Rust 代理发起请求（绕 CORS）。
       * scope 由调用方给出：`net.fetch:<scope>`，逐一尝试已授予的 scope 是否覆盖。
       */
      fetch: (url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
        call({
          api: "net.fetch",
          detail: String(url).slice(0, 200),
          run: async (rec) => {
            const target = String(url ?? "");
            const scopes = rec.grants
              .filter((g) => permissionBaseId(g.permission) === "net.fetch")
              .map((g) => g.permission);
            const allowed = scopes.find((s) => scopeAllows(s, target));
            if (!allowed) {
              throw new PluginPermissionError(pluginId, `net.fetch:${originOf(target)}/*`);
            }
            return await pluginFetch(pluginId, target, options);
          },
        }),
    },

/* ---------------- 插件市场（gate: plugin.install） ---------------- */
    market: createMarketApi(pluginId, call, ctx),

    /* ---------------- 系统 ---------------- */
    system: {
      openExternal: (url: string) =>
        call({
          api: "system.openExternal",
          permission: "system.openExternal",
          detail: String(url).slice(0, 200),
          run: async () => {
            const u = String(url ?? "");
            if (!/^https?:\/\//i.test(u)) throw new Error("仅允许打开 http/https 链接");
            await openExternal(u);
            return true;
          },
        }),
      /** 读取剪贴板 */
      readClipboard: () =>
        call({
          api: "system.readClipboard",
          permission: "clipboard.read",
          run: async () => {
            try {
              return await navigator.clipboard.readText();
            } catch (e) {
              throw new Error("读取剪贴板失败（可能被系统权限拒绝）");
            }
          },
        }),
      /** 写入剪贴板 */
      writeClipboard: (text: string) =>
        call({
          api: "system.writeClipboard",
          permission: "clipboard.write",
          run: async () => {
            try {
              await navigator.clipboard.writeText(String(text ?? ""));
              return true;
            } catch (e) {
              throw new Error("写入剪贴板失败");
            }
          },
        }),
      /** 读取选中的文本（复用老脚本 getSelectedText） */
      getSelectedText: (hint?: string) =>
        call({
          api: "system.getSelectedText",
          permission: "selection.read",
          run: () => ctx.getSelectedText(String(hint ?? "请选择页面文本")),
        }),
      /** 读取钥匙串密钥（仅后端插件可用） */
      getSecret: (name: string) =>
        call({
          api: "system.getSecret",
          permission: `secret.read:${String(name)}`,
          run: () => ctx.getSecret?.(pluginId, String(name)) ?? Promise.resolve(null),
        }),
    },

    /* ---------------- 截图（mask 均为新权限） ---------------- */
    screenshot: {
      /** 整屏抓屏 → PNG data URL（不含框选遮罩，纯截全屏） */
      capture: () =>
        call({
          api: "screenshot.capture",
          permission: "screenshot.capture",
          run: () =>
            ctx.screenshotCapture?.() ??
            Promise.reject(new Error("当前版本不支持截图")),
        }),
      /** 打开全屏框选遮罩（抓屏 + 每显示器一个透明窗口），返回窗口数 */
      openOverlay: () =>
        call({
          api: "screenshot.openOverlay",
          permission: "screenshot.overlay",
          run: () =>
            ctx.screenshotOpenOverlay?.() ??
            Promise.reject(new Error("当前版本不支持框选遮罩")),
        }),
      /** 关闭遮罩（用户取消时调用） */
      closeOverlay: () =>
        call({
          api: "screenshot.closeOverlay",
          permission: "screenshot.overlay",
          run: () => ctx.screenshotCloseOverlay?.() ?? Promise.resolve(),
        }),
      /** 取某屏抓屏底图（data URL）——遮罩页铺满窗口用，插件一般不用直接调 */
      overlayImage: (monitorIndex: number) =>
        call({
          api: "screenshot.overlayImage",
          permission: "screenshot.overlay",
          run: () =>
            ctx.screenshotOverlayImage?.(Math.floor(Number(monitorIndex)) || 0) ??
            Promise.reject(new Error("当前版本不支持框选遮罩")),
        }),
      /** 框选并裁出 PNG data URL（遮罩页内部用；插件调 openOverlay 即可） */
      crop: (monitorIndex: number, x: number, y: number, width: number, height: number) =>
        call({
          api: "screenshot.crop",
          permission: "screenshot.overlay",
          run: () =>
            ctx.screenshotCrop?.(
              Math.floor(Number(monitorIndex)) || 0,
              Number(x) || 0,
              Number(y) || 0,
              Number(width) || 0,
              Number(height) || 0
            ) ?? Promise.reject(new Error("当前版本不支持框选遮罩")),
        }),
      /**
       * **在屏幕上直接框选**：一次调用完成「开遮罩 → 用户拖选 → 关遮罩」，
       * 返回虚拟桌面**物理**像素矩形（与 gdigrab/ddagrab 的采集坐标同口径）；
       * 用户按 Esc 取消返回 null。适合录屏选区这类「只要坐标不要图」的场景。
       * 需要 `screenshot.overlay` 权限。
       */
      pickRegion: () =>
        call({
          api: "screenshot.pickRegion",
          permission: "screenshot.overlay",
          run: () =>
            ctx.screenshotPickRegion?.() ??
            Promise.reject(new Error("当前版本不支持屏幕框选")),
        }),
      /** 把 PNG data URL 写进系统剪贴板（不走 navigator.clipboard，能写真正的图片） */
      copy: (dataUrl: string) =>
        call({
          api: "screenshot.copy",
          permission: "clipboard.write",
          run: () => ctx.screenshotCopyImage?.(String(dataUrl ?? "")),
        }),
      /** 把 PNG 落盘到插件私有目录，返回索引记录（含 relPath，供 read/list 用） */
      save: (dataUrl: string) =>
        call({
          api: "screenshot.save",
          permission: "screenshot.write",
          detail: `${String(dataUrl ?? "").length} 字节`,
          run: () =>
            ctx.screenshotSaveShot?.(pluginId, String(dataUrl ?? "")) ??
            Promise.reject(new Error("当前版本不支持保存截图")),
        }),
      /**
       * 弹系统「另存为」对话框，把这张 PNG 存到**用户选定**的位置。
       *
       * 与 `save` 的区别：`save` 只能存进插件私有目录（用户找不到），
       * 本 API 让用户自己挑目录和文件名——「导出到桌面」这类需求走它。
       * 用户取消时 resolve(null)（取消不是错误，别当异常处理）。
       */
      saveAs: (dataUrl: string, parentDir?: string) =>
        call({
          api: "screenshot.saveAs",
          permission: "screenshot.write",
          detail: `${String(dataUrl ?? "").length} 字节`,
          run: () =>
            ctx.screenshotSaveShotAs?.(
              pluginId,
              String(dataUrl ?? ""),
              parentDir ? String(parentDir) : undefined
            ) ?? Promise.reject(new Error("当前版本不支持另存为")),
        }),
      /** 广播「新截图已保存」，打开中的插件画廊据此刷新 */
      notifySaved: (relPath?: string) =>        call({
          api: "screenshot.notifySaved",
          permission: "screenshot.write",
          run: () => ctx.screenshotNotifySaved?.(pluginId, relPath ? String(relPath) : undefined),
        }),
      /** 列出插件私有目录的截图（时间从新到旧） */
      list: () =>
        call({
          api: "screenshot.list",
          permission: "screenshot.read",
          run: () => ctx.screenshotListShots?.(pluginId) ?? Promise.resolve([]),
        }),
      /** 读回一张截图 → data URL（画廊缩略图/大图） */
      readShot: (relPath: string) =>
        call({
          api: "screenshot.readShot",
          permission: "screenshot.read",
          detail: String(relPath ?? "").slice(0, 300),
          run: () =>
            ctx.screenshotReadShot?.(pluginId, String(relPath ?? "")) ??
            Promise.reject(new Error("当前版本不支持读取截图")),
        }),
      /** 删除一张截图 */
      remove: (relPath: string) =>
        call({
          api: "screenshot.remove",
          permission: "screenshot.read",
          detail: String(relPath ?? "").slice(0, 300),
          run: () => ctx.screenshotDeleteShot?.(pluginId, String(relPath ?? "")),
        }),
      /** 删除早于 N 天的截图，返回删掉的张数（画廊「只留最近 N 天」用） */
      prune: (days: number) =>
        call({
          api: "screenshot.prune",
          permission: "screenshot.write",
          run: () => ctx.screenshotPruneShots?.(pluginId, Math.max(1, Math.floor(Number(days)) || 7)),
        }),
      /**
       * 读当前「截图」全局快捷键（无绑定时返回默认 ctrl+alt+x）。
       *
       * 不申请额外权限：读的是**本动作**的键，不含其它动作的信息；
       * 权威存储是宿主的 settings.json，插件不要自己存一份（会不一致）。
       */
      getShortcut: () =>
        call({
          api: "screenshot.getShortcut",
          run: () => ctx.screenshotGetShortcut?.() ?? Promise.resolve(""),
        }),
      /**
       * 改绑「截图」全局快捷键（插件前台的设置项）。传空串 = 解绑（关掉热键）。
       * 冲突（该键已被其它动作占用）会抛错，文案可直接展示给用户。
       */
      setShortcut: (shortcut: string) =>
        call({
          api: "screenshot.setShortcut",
          detail: String(shortcut ?? ""),
          run: () =>
            ctx.screenshotSetShortcut?.(String(shortcut ?? "")) ??
            Promise.reject(new Error("当前版本不支持在插件内改快捷键")),
        }),
      /**
       * 监听「新截图已保存」事件（宿主热键触发遮罩保存后广播）。
       * 打开中的画廊用它在后台自动刷新；未打开时事件被丢弃，下次打开 list() 兜底。
       * 返回取消订阅函数。
       */
      onSaved: (handler: (payload: { pluginId?: string; relPath?: string }) => void) => {
        // 与 backend.onNotification 同一路由：全局 listen 一次，按 payload.pluginId 分发
        const unsubscribe = addScreenshotSavedListener(pluginId, handler);
        return unsubscribe;
      },
    },

    /* ---------------- 剪贴板历史 ---------------- */
    clipboard: {
      /**
       * 列出剪贴板历史（从新到旧）。
       *
       * `query` 非空时交给 Rust 先按文本做一次粗筛（图片用来源描述参与匹配），
       * 前端仍可在此基础上再过滤。需要 `clipboard.read` 权限。
       */
      list: (query?: string) =>
        call({
          api: "clipboard.list",
          permission: "clipboard.read",
          detail: query ? String(query).slice(0, 100) : "",
          run: () => ctx.clipboardHistoryList?.(query ? String(query) : undefined) ?? Promise.resolve([]),
        }),
      /**
       * 分页拉取剪贴板历史（从新到旧）。
       *
       * 关键词与「仅收藏」过滤在 Rust 侧**分页之前**完成，返回的 `total` 是
       * 过滤后总条数、`hasMore` 指示是否还有下一页——前端据此做「每页 30 条 +
       * 触底加载更多」。需要 `clipboard.read` 权限。
       */
      page: (opts?: { query?: string; favoriteOnly?: boolean; offset?: number; limit?: number }) =>
        call({
          api: "clipboard.page",
          permission: "clipboard.read",
          detail: opts?.query ? String(opts.query).slice(0, 100) : "",
          run: () =>
            ctx.clipboardHistoryPage?.({
              query: opts?.query,
              favoriteOnly: opts?.favoriteOnly,
              offset: opts?.offset,
              limit: opts?.limit,
            }) ?? Promise.resolve({ items: [], total: 0, hasMore: false }),
        }),
      /**
       * 读回一张剪贴板图片 → data URL（列表缩略图 / 大图预览）。
       * 需要 `clipboard.read` 权限。
       */
      readImage: (relPath: string) =>
        call({
          api: "clipboard.readImage",
          permission: "clipboard.read",
          detail: String(relPath ?? "").slice(0, 300),
          run: () =>
            ctx.clipboardHistoryReadImage?.(String(relPath ?? "")) ??
            Promise.reject(new Error("当前版本不支持读取剪贴板图片")),
        }),
      /**
       * 把某条历史复制回系统剪贴板。
       *
       * 这是**用户显式触发**的写入：宿主监听路径永远只读，只有点「复制」才会写。
       * 需要 `clipboard.write` 权限。
       */
      copy: (id: string) =>
        call({
          api: "clipboard.copy",
          permission: "clipboard.write",
          detail: String(id ?? ""),
          run: () =>
            ctx.clipboardHistoryCopy?.(String(id ?? "")) ??
            Promise.reject(new Error("当前版本不支持复制剪贴板历史")),
        }),
      /** 删除一条历史（图片连同磁盘文件一起删）。需要 `clipboard.read` 权限。 */
      remove: (id: string) =>
        call({
          api: "clipboard.remove",
          permission: "clipboard.read",
          detail: String(id ?? ""),
          run: () =>
            ctx.clipboardHistoryDelete?.(String(id ?? "")) ??
            Promise.reject(new Error("当前版本不支持删除剪贴板历史")),
        }),
      /**
       * 清空剪贴板历史。
       *
       * 默认**保留收藏条目**（只清未收藏的）；传 `{ keepFavorites: false }`
       * 则连同收藏一起清空——是否保留由插件按用户选择决定。
       * 需要 `clipboard.read` 权限。
       */
      clear: (opts?: { keepFavorites?: boolean }) =>
        call({
          api: "clipboard.clear",
          permission: "clipboard.read",
          detail: opts?.keepFavorites === false ? "keepFavorites=false" : "",
          run: () =>
            ctx.clipboardHistoryClear?.(opts?.keepFavorites !== false) ??
            Promise.reject(new Error("当前版本不支持清空剪贴板历史")),
        }),
      /**
       * 收藏 / 取消收藏一条历史。
       *
       * 收藏条目永久保留：不参与历史上限淘汰，也不被默认「清空」删除。
       * 这是**用户显式触发**的写入性操作，与复制同属修改类，需要
       * `clipboard.write` 权限。
       */
      setFavorite: (id: string, favorite: boolean) =>
        call({
          api: "clipboard.setFavorite",
          permission: "clipboard.write",
          detail: String(id ?? ""),
          run: () =>
            ctx.clipboardHistorySetFavorite?.(String(id ?? ""), !!favorite) ??
            Promise.reject(new Error("当前版本不支持收藏剪贴板历史")),
        }),
      /**
       * 读当前「剪贴板历史」全局快捷键（空串 = 未绑）。
       * 不申请额外权限：读的是本动作的键，权威在宿主 settings.json。
       */
      getShortcut: () =>
        call({
          api: "clipboard.getShortcut",
          run: () => ctx.clipboardHistoryGetShortcut?.() ?? Promise.resolve(""),
        }),
      /** 改绑「剪贴板历史」全局快捷键（空串 = 解绑）。 */
      setShortcut: (shortcut: string) =>
        call({
          api: "clipboard.setShortcut",
          detail: String(shortcut ?? ""),
          run: () =>
            ctx.clipboardHistorySetShortcut?.(String(shortcut ?? "")) ??
            Promise.reject(new Error("当前版本不支持在插件内改快捷键")),
        }),
      /**
       * 监听「剪贴板有更新」事件（宿主原监听到剪贴板变更后广播）。
       * 打开中的列表用它在后台自动刷新；未打开时事件被丢弃，下次打开 list() 兜底。
       * 返回取消订阅函数。
       */
      onUpdated: (handler: () => void) => addClipboardUpdatedListener(pluginId, handler),
    },

    /* ---------------- 后端 ---------------- */
    backend: {
      /** 调用后端方法（未运行时按需拉起） */
      call: (method: string, params: unknown = null) =>
        call({
          api: "backend.call",
          permission: "backend.spawn",
          detail: String(method),
          run: () => ctx.callBackend?.(pluginId, String(method), params) ?? Promise.reject(new Error("后台能力不可用")),
        }),

      /** 监听后端通知（如流式响应 chat:delta） */
      onNotification: (method: string, handler: (params: unknown) => void): (() => void) => {
        return addNotificationHandler(pluginId, method, handler);
      },

      /** 取消监听后端通知 */
      offNotification: (method: string, handler: (params: unknown) => void): void => {
        // 通过 addNotificationHandler 返回的取消函数更精准，
        // 这里用移除最后一个匹配 handler 的简化方式
        const handlersByMethod = notificationHandlers.get(pluginId);
        if (!handlersByMethod || !method) return;
        const handlers = handlersByMethod.get(method);
        if (handlers) {
          handlers.delete(handler);
          if (handlers.size === 0) handlersByMethod.delete(method);
          if (handlersByMethod.size === 0) notificationHandlers.delete(pluginId);
        }
      },

      /** 清理所有通知监听（视图销毁时调用） */
      _clearNotifications: (): void => {
        clearNotificationHandlers(pluginId);
      },
    },

    /** 写日志（落到插件日志文件，面板可查看） */
    log: (level: "info" | "warn" | "error", ...args: unknown[]) => {
      const text = args.map((a) => (typeof a === "string" ? a : safeStringify(a))).join(" ");
      ctx.log?.(pluginId, level, text);
    },
  };

  // getSecret / callBackend / log / setViewHeight 这些由宿主按需注入
  return api;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch (e) {
    return String(v);
  }
}

/**
 * 从预处理结果里取「可直接用于 `<img src>` 的图标」。
 *
 * 三种形态与 `icon.ts` 的说明一致：`data:` / `http(s):` 直用；插件目录内的相对
 * 路径则从已解包的文件表里按 base64 拼 data URL（不额外读盘——文件已在内存里）。
 * 取不到就返回 null，弹窗显示占位图标。
 */
function iconUrlOf(prepared: { manifest: PluginManifest; files: readonly { path: string; data: string }[] }): string | null {
  const ref = prepared.manifest.icon;
  if (!ref) return null;
  if (isInlineIconRef(ref)) return ref;
  const file = prepared.files.find((f) => f.path === ref);
  return file ? iconDataUrl(ref, file.data) : null;
}

/**
 * 创建插件市场的宿主 API（`ms.market.*`，gate: plugin.install）。
 *
 * 与其它 API 不同：市场 API 不可能在创建时获得 `api` 引用（创建中），
 * 因此在这里单独提取成函数，避开循环引用问题。
 */
function createMarketApi(
  pluginId: string,
  call: <T>(opts: {
    api: string;
    permission?: string;
    detail?: string;
    run: (record: any) => T | Promise<T>;
  }) => T | Promise<T>,
  ctx: PluginHostContext
): Record<string, unknown> {
  function guarded<T>(name: string, run: () => T | Promise<T>): T | Promise<T> {
    return call({ api: `market.${name}`, permission: "plugin.install", run: () => run() });
  }

  const self: Record<string, unknown> = {};
  type MarketResult = { ok: boolean; error?: string } | { ok: true }; 
  type AsyncMarketFn = (...args: any[]) => Promise<any>;

  async function catalogFetch() {
    const { marketFetchRaw } = await import("./ipc.ts");
    const { compatibleEntries, parseCatalog } = await import("./market-types.ts");
    const { diffCatalog, applyUpdateAvailable } = await import("./market.ts");
    const { loadRegistry } = await import("./registry.ts");
    const reg = loadRegistry();
    const raw = await marketFetchRaw(pluginId, MARKET_CATALOG_URL, "");
    const text = new TextDecoder("utf-8").decode(raw);
    const parsed = parseCatalog(text);
    if (!parsed.ok) return null;
    const compat = compatibleEntries(parsed.catalog, typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "");
    const diff = diffCatalog(reg, compat);
    applyUpdateAvailable(reg, diff);
    return { reg, catalog: parsed.catalog, diff };
  }

  self.list = () => guarded("list", async () => {
    const result = await catalogFetch();
    if (!result) return { entries: [], installedMap: {}, updates: [], blocked: [], error: "解析目录失败" };
    const installedMap: Record<string, string> = {};
    for (const rec of result.reg.plugins) {
      if (rec.source.kind === "builtin" || rec.source.kind === "market") {
        installedMap[rec.id] = rec.version;
      }
    }
    return {
      entries: result.catalog.plugins,
      installedMap,
      updates: result.diff.updates.map((u) => ({ id: u.rec.id, currentVersion: u.rec.version, availableVersion: u.entry.version })),
      blocked: result.diff.blocked.map((b) => b.id),
      error: null as string | null,
    };
  });
  /**
   * 市场安装 / 更新的公共实现（两者只差确认弹窗的文案与来源标记）。
   *
   * **必经用户确认**：下载并解包后、落盘前，交给宿主注入的 `confirmPluginInstall`
   * 弹安装确认框；用户取消即返回 `{ ok:false, cancelled:true }`，磁盘与注册表都
   * 不动。宿主未注入该能力时**直接拒绝**（fail-closed）——静默安装是对用户系统
   * 影响最大的动作，不能有绕过确认的路径。
   */
  async function installOrUpdate(id: string, action: "install" | "update") {
    if (!ctx.confirmPluginInstall) {
      return { ok: false as const, error: "当前窗口不支持安装确认，已取消安装" };
    }
    const { marketFetchRaw, installPluginPackage } = await import("./ipc.ts");
    const { loadRegistry, saveRegistry, createPluginRecord, upsertPlugin, findPlugin } = await import("./registry.ts");
    const { parseCatalog } = await import("./market-types.ts");
    const catalogRaw = await marketFetchRaw(pluginId, MARKET_CATALOG_URL, "");
    const parsed = parseCatalog(new TextDecoder("utf-8").decode(catalogRaw));
    const entry = parsed.ok ? parsed.catalog.plugins.find((e) => e.id === id) : null;
    if (!entry) return { ok: false as const, error: `市场中未找到插件: ${id}` };
    // 下载地址以目录条目为准：插件包可能托管在开发者自己的仓库（见 sources.json
    // 准入名单），因此不能再按固定模板拼 URL。Rust 侧会按 host 白名单再判一次。
    const pkgUrl = entry.downloadUrl;
    const b64 = await marketFetchRaw(pluginId, pkgUrl, entry.sha256);
    const { preparePackage } = await import("./install.ts");
    const prepared = await preparePackage(b64, {
      hostVersion: typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : null,
      checkPermissions: isKnownPermission,
    });

    // 落盘前先问用户：展示清单、权限分组、校验警告与已装版本。
    const mf = prepared.manifest;
    const installedVersion = findPlugin(loadRegistry(), mf.id)?.version ?? null;
    const confirmed = await ctx.confirmPluginInstall({
      manifest: mf,
      iconUrl: iconUrlOf(prepared),
      permBlocks: groupPermissions([...(mf.permissions ?? []), ...(mf.optionalPermissions ?? [])]),
      warnings: prepared.warnings,
      installedVersion,
      action,
    });
    if (!confirmed) return { ok: false as const, cancelled: true };

    const allPerms = [...(mf.permissions ?? []), ...(mf.optionalPermissions ?? [])];
    await installPluginPackage(id, prepared.files);
    const reg = loadRegistry();
    const record = createPluginRecord({
      manifest: mf,
      dir: `plugins/${id}`,
      // ref 记录实际下载地址，便于排障与「来源仓库」展示
      source: { kind: "market", ref: pkgUrl },
      grants: allPerms,
      integrity: { sha256: prepared.sha256, signed: false },
    });
    upsertPlugin(reg, record, { preserveUserChoices: false });
    saveRegistry(reg);
    // 市场里可能装了提供快捷键动作的插件（如剪贴板历史）：立刻把可用动作下发给宿主
    try {
      const { syncShortcutActions } = await import("./gateway.ts");
      await syncShortcutActions(reg);
    } catch (e) {
      console.warn("[插件市场] 快捷键动作同步失败:", e);
    }
    return { ok: true as const, version: mf.version };
  }

  self.install = (id: string) => guarded("install", () => installOrUpdate(id, "install"));
  self.update = (id: string) => guarded("update", async () => {
    const result = await installOrUpdate(id, "update");
    return result.ok ? { ok: true as const, updatedTo: result.version } : result;
  });
  self.uninstall = (id: string) => guarded("uninstall", async () => {
    const { removePluginDir, stopPluginBackend } = await import("./ipc.ts");
    const { loadRegistry, saveRegistry, removePlugin } = await import("./registry.ts");
    // 卸载前先停掉运行中的后台进程：未停的进程持有插件目录的文件句柄，
    // Windows 上会直接删不掉；即使删除成功进程也会变成孤儿继续跑。
    // 记录或清单拿不到（目录缺失）时也照常尝试——stop 对未运行的插件是幂等的。
    const rec = findPlugin(loadRegistry(), id);
    if (!rec || rec.manifest.backend) {
      try {
        await stopPluginBackend(id);
      } catch (e) {
        console.warn(`[插件市场] 卸载前停止后台进程失败（${id}）:`, e);
      }
    }
    await removePluginDir(id);
    const reg = loadRegistry();
    removePlugin(reg, id);
    saveRegistry(reg);
    // 卸载可能带走了某个快捷键作用类型：立刻下发，让宿主移除绑定并注销热键
    try {
      const { syncShortcutActions } = await import("./gateway.ts");
      await syncShortcutActions(reg);
    } catch (e) {
      console.warn("[插件市场] 快捷键动作同步失败:", e);
    }
    return { ok: true };
  });
  self.checkUpdates = () => guarded("checkUpdates", async () => {
    const result = await catalogFetch();
    if (!result) return 0;
    const { updateableCount } = await import("./market.ts");
    return updateableCount(result.reg);
  });
  self.refreshCatalog = () => guarded("refreshCatalog", async () => {
    const result = await catalogFetch();
    if (!result) return { entries: [], installedMap: {}, updates: [], blocked: [], error: null };
    const installedMap: Record<string, string> = {};
    for (const rec of result.reg.plugins) {
      if (rec.source.kind === "builtin" || rec.source.kind === "market") {
        installedMap[rec.id] = rec.version;
      }
    }
    return {
      entries: result.catalog.plugins,
      installedMap,
      updates: result.diff.updates.map((u) => ({ id: u.rec.id, currentVersion: u.rec.version, availableVersion: u.entry.version })),
      blocked: result.diff.blocked.map((b) => b.id),
      error: null as string | null,
    };
  });

  return self;
}

/* ========================================================
 * 需要宿主注入的少量能力（避免 lib/plugins 反向依赖窗口层）
 * ==================================================== */

/** 宿主检索实现（由 search 窗口注入，等价 engine.search） */
let hostSearch: (keyword: string) => SearchResult[] | Promise<SearchResult[]> = () => [];
/** 点击加权实现（由 search 窗口注入） */
let scoreItem: (item: SearchItem) => void = () => undefined;

export function bindPluginHostRuntime(hooks: {
  search?: (keyword: string) => SearchResult[] | Promise<SearchResult[]>;
  score?: (item: SearchItem) => void;
}): void {
  if (hooks.search) hostSearch = hooks.search;
  if (hooks.score) scoreItem = hooks.score;
}

/* ============================================================
 * 工具
 * ============================================================ */

/** 取 URL 的 origin（权限提示文案用） */
export function originOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch (e) {
    return url;
  }
}

/**
 * 判断已授予的 net.fetch scope 是否允许该 URL。
 * 支持 `*`、`https://api.x.com/*`、`https://*.x.com/*`。
 */
export function scopeAllows(grantedPermission: string, url: string): boolean {
  const scope = grantedPermission.slice(grantedPermission.indexOf(":") + 1);
  if (!scope) return false;
  if (scope === "*") return true;
  let target: URL;
  try {
    target = new URL(url);
  } catch (e) {
    return false;
  }
  const origin = `${target.protocol}//${target.host}${target.pathname}`;
  if (!scope.startsWith("http")) return false;
  const s = scope.slice(scope.indexOf("://") + 3);
  const slash = s.indexOf("/");
  const hostPattern = slash < 0 ? s : s.slice(0, slash);
  const pathPattern = slash < 0 ? "/*" : s.slice(slash);
  const hostOk =
    hostPattern === target.host ||
    (hostPattern.startsWith("*.") && target.host.endsWith(hostPattern.slice(1)));
  if (!hostOk) return false;
  if (pathPattern === "/*" || pathPattern === "*") return true;
  const prefix = pathPattern.endsWith("*") ? pathPattern.slice(0, -1) : pathPattern;
  return origin.endsWith(prefix) || target.pathname.startsWith(prefix);
}

/** 插件私有存储的键列表 */
function pluginDataKeys(pluginId: string): string[] {
  const prefix = "my-search-desktop:PLUGIN_DATA:" + pluginId + ":";
  const out: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) out.push(k.slice(prefix.length));
    }
  } catch (e) {
    /* ignore */
  }
  return out;
}

/**
 * 该插件**已授权可见**的环境变量名（来自注册表的 `env.read:<NAME>` 授予记录）。
 *
 * 这是 `ms.env.*` 的唯一数据源：未授权的变量对插件完全不可见
 * （列不出、`has()` 为 false、也不会被注入它的后台进程）。
 */
function envGrantedNames(pluginId: string): string[] {
  try {
    const rec = findPlugin(loadRegistry(), pluginId);
    if (!rec) return [];
    const out: string[] = [];
    for (const g of rec.grants) {
      const p = String(g?.permission ?? "");
      if (!p.startsWith("env.read:")) continue;
      const name = p.slice("env.read:".length);
      if (name && !out.includes(name)) out.push(name);
    }
    return out;
  } catch (e) {
    return [];
  }
}

/** 已授权变量的元信息（名字 + 说明；**绝不含值**） */
function envDescribe(pluginId: string): Array<{ name: string; description: string; secret: boolean }> {
  const granted = new Set(envGrantedNames(pluginId));
  if (granted.size === 0) return [];
  try {
    return loadEnvVars()
      .filter((v) => granted.has(v.name))
      .map((v) => ({ name: v.name, description: String(v.description ?? ""), secret: v.secret !== false }));
  } catch (e) {
    return [];
  }
}

/**
 * 经宿主发起的网络请求（Rust 代理，绕 CORS）。
 * 与 `http_request` 共用实现，但**只对已通过 scope 判定的 URL 放行**。
 */
async function pluginFetch(
  pluginId: string,
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string }
): Promise<{ status: number; ok: boolean; text: string; headers: Record<string, string> }> {
  const { isTauri } = await import("../tauri-bridge.ts");
  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    const text = await invoke<string>("plugin_net_fetch", {
      pluginId,
      url,
      method: options.method ?? "GET",
      headers: options.headers ?? {},
      body: options.body ?? null,
    });
    return { status: 200, ok: true, text, headers: {} };
  }
  // 浏览器调试：直连（受 CORS 限制，仅便于开发）
  const resp = await fetch(url, {
    method: options.method ?? "GET",
    headers: options.headers,
    body: options.body,
  });
  const text = await resp.text();
  return { status: resp.status, ok: resp.ok, text, headers: {} };
}

/** 记录一次「用户拒绝」（面板展示，供后续补授） */
export function recordDenied(pluginId: string, permission: string, ctx: PluginHostContext): void {
  const reg = ctx.registry();
  const rec = reg.plugins.find((p) => p.id === pluginId);
  if (!rec) return;
  markDenied(rec, permission);
  ctx.persistRegistry();
}

/** 追加一条审计（插件视图宿主在捕获到异常时调用） */
export function auditDenied(pluginId: string, api: string, permission: string, message?: string): void {
  pushAudit({ at: Date.now(), pluginId, api, detail: permission, result: "denied", message });
}

/** 校验权限串是否为宿主已知权限（面板里手工授予时用） */
export function assertKnownPermission(permission: string): void {
  if (!isKnownPermission(permission)) throw new Error(`未知权限: ${permission}`);
}

/** 供面板显示：注册表里所有被拒绝过的权限 */
export function deniedPermissionsOf(record: PluginRecord): string[] {
  return record.denied.slice();
}

/** 读取插件的某个设置（面板侧：插件设置页入口） */
export function readPluginSetting<T>(pluginId: string, key: string, fallback: T): T {
  return pluginDataGet(pluginId, key, fallback);
}

/** 更新视图高度钩子（由视图宿主注入；与 PluginHostContext 解耦，避免类型循环） */
declare module "./host.ts" {
  // 占位：实际实现由 host.ts 注入 ctx.setViewHeight
  interface PluginHostContext {
    setViewHeight?: (px: number) => void;
    log?: (pluginId: string, level: "info" | "warn" | "error", text: string) => void;
    getSecret?: (pluginId: string, name: string) => Promise<string | null>;
    callBackend?: (pluginId: string, method: string, params: unknown) => Promise<unknown>;
    /** 打开宿主的「选择环境变量」授权弹层（ms.env.pick） */
    pickEnvVar?: (
      pluginId: string,
      opts: { title?: string; purpose?: string }
    ) => Promise<{ kind: "ref"; name: string; ref: string } | { kind: "literal"; value: string } | null>;
  }
}

/** 读取一个未被插件写入过的键时用的默认值（与老脚本 cache.get 语义一致） */
export function pluginCacheGet<T>(pluginId: string, key: string, fallback: T = null as unknown as T): T {
  return storageGet("PLUGIN_DATA:" + pluginId + ":" + key, fallback);
}
