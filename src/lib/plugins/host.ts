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
import { isKnownPermission, permissionBaseId } from "./permissions.ts";
import type { PluginRecord, PluginRegistryFile } from "./registry.ts";
import {
  isGranted,
  markDenied,
  pluginDataGet,
  pluginDataSet,
  pluginDataRemove,
  saveRegistry,
} from "./registry.ts";

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
          ? { id: rec.id, name: rec.name, version: rec.version, enabled: rec.enabled }
          : { id: pluginId, name: pluginId, version: "?", enabled: false };
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
            return await pluginFetch(target, options);
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
    const catalogUrl = "https://github.com/My-Search/my-search-plugin-market/releases/download/catalog/catalog.json";
    const raw = await marketFetchRaw(pluginId, catalogUrl, "");
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
    const catalogUrl = "https://github.com/My-Search/my-search-plugin-market/releases/download/catalog/catalog.json";
    const catalogRaw = await marketFetchRaw(pluginId, catalogUrl, "");
    const parsed = parseCatalog(new TextDecoder("utf-8").decode(catalogRaw));
    const entry = parsed.ok ? parsed.catalog.plugins.find((e) => e.id === id) : null;
    if (!entry) return { ok: false, error: `市场中未找到插件: ${id}` };
    const pkgUrl = `https://github.com/My-Search/my-search-plugin-market/releases/download/${id}/${id}.msplugin`;
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
      source: { kind: "market" },
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
 * 经宿主发起的网络请求（Rust 代理，绕 CORS）。
 * 与 `http_request` 共用实现，但**只对已通过 scope 判定的 URL 放行**。
 */
async function pluginFetch(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string }
): Promise<{ status: number; ok: boolean; text: string; headers: Record<string, string> }> {
  const { isTauri } = await import("../tauri-bridge.ts");
  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    const text = await invoke<string>("plugin_net_fetch", {
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
  }
}

/** 读取一个未被插件写入过的键时用的默认值（与老脚本 cache.get 语义一致） */
export function pluginCacheGet<T>(pluginId: string, key: string, fallback: T = null as unknown as T): T {
  return storageGet("PLUGIN_DATA:" + pluginId + ":" + key, fallback);
}
