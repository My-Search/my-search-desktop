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
import { isKnownPermission, permissionBaseId } from "./permissions.ts";
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
import { attachmentList, attachmentListCancel, attachmentOpen, attachmentRead, attachmentReveal } from "./ipc.ts";
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
    market: createMarketApi(pluginId, call),

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
 * 创建插件市场的宿主 API（`ms.market.*`，gate: plugin.install）。
 *
 * 与其它 API 不同：市场 API 不可能在创建时获得 `api` 引用（创建中），
 * 因此在这里单独提取成函数，避开循环引用问题。
 */
function createMarketApi(pluginId: string, call: <T>(opts: {
  api: string;
  permission?: string;
  detail?: string;
  run: (record: any) => T | Promise<T>;
}) => T | Promise<T>): Record<string, unknown> {
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
  self.install = (id: string) => guarded("install", async () => {
    const { marketFetchRaw, installPluginPackage } = await import("./ipc.ts");
    const { loadRegistry, saveRegistry, createPluginRecord, upsertPlugin } = await import("./registry.ts");
    const { isKnownPermission } = await import("./permissions.ts");
    const { parseCatalog } = await import("./market-types.ts");
    const catalogRaw = await marketFetchRaw(pluginId, MARKET_CATALOG_URL, "");
    const parsed = parseCatalog(new TextDecoder("utf-8").decode(catalogRaw));
    const entry = parsed.ok ? parsed.catalog.plugins.find((e) => e.id === id) : null;
    if (!entry) return { ok: false, error: `市场中未找到插件: ${id}` };
    // 下载地址以目录条目为准：插件包可能托管在开发者自己的仓库（见 sources.json
    // 准入名单），因此不能再按固定模板拼 URL。Rust 侧会按 host 白名单再判一次。
    const pkgUrl = entry.downloadUrl;
    const b64 = await marketFetchRaw(pluginId, pkgUrl, entry.sha256);
    const { preparePackage } = await import("./install.ts");
    const prepared = await preparePackage(b64, {
      hostVersion: typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : null,
      checkPermissions: isKnownPermission,
    });
    const allPerms = [...(prepared.manifest.permissions ?? []), ...(prepared.manifest.optionalPermissions ?? [])];
    await installPluginPackage(id, prepared.files);
    const reg = loadRegistry();
    const record = createPluginRecord({
      manifest: prepared.manifest,
      dir: `plugins/${id}`,
      // ref 记录实际下载地址，便于排障与「来源仓库」展示
      source: { kind: "market", ref: pkgUrl },
      grants: allPerms,
      integrity: { sha256: prepared.sha256, signed: false },
    });
    upsertPlugin(reg, record, { preserveUserChoices: false });
    saveRegistry(reg);
    return { ok: true };
  });
  self.update = (id: string) => guarded("update", async () => {
    const result = await (self.install as any)(id);
    return result.ok ? { ok: true as const, updatedTo: "" } : result;
  });
  self.uninstall = (id: string) => guarded("uninstall", async () => {
    const { removePluginDir } = await import("./ipc.ts");
    const { loadRegistry, saveRegistry, removePlugin } = await import("./registry.ts");
    await removePluginDir(id);
    const reg = loadRegistry();
    removePlugin(reg, id);
    saveRegistry(reg);
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
