/**
 * 界面、搜索、输入附件、键值存储、环境变量、云同步与系统能力模块
 * （`plugin`、`search`、`ui`、`input`、`store`、`env`、`sync`、`system`）。
 */

import type { SearchItem, SearchResult } from "../../../types/index.ts";
import { openExternal } from "../../tauri-bridge.ts";
import { effectiveTheme } from "../../theme.ts";
import type { PluginRecord } from "../registry.ts";
import {
  findPlugin,
  isGranted,
  loadRegistry,
  pluginDataGet,
  pluginDataRemove,
  pluginDataSet,
  resolvePluginTheme,
  listAllCommands,
  removeRuntimeCommand,
  upsertRuntimeCommand,
  MAX_RUNTIME_COMMANDS,
  type PluginRegistryFile,
} from "../registry.ts";
import { loadEnvVars } from "../env-store.ts";
import {
  hasResultProvider,
  registerResultProvider,
  resultProviderOf,
  RESULT_PROVIDER_BUDGET_MS,
  RESULT_PROVIDER_GLOBAL_CAP,
  RESULT_PROVIDER_MAX_ITEMS,
  type ResultProviderFn,
} from "../result-provider.ts";
import {
  attachmentFileIcons,
  attachmentList,
  attachmentListCancel,
  attachmentListStream,
  attachmentOpen,
  attachmentRead,
  attachmentReveal,
  pluginOpenWindow,
  pluginPickFiles,
  pluginSaveFile,
  pluginCollectionClear,
  pluginCollectionDelete,
  pluginCollectionGet,
  pluginCollectionList,
  pluginCollectionPut,
  pluginStorageDelete,
  pluginStorageRead,
  pluginStorageWrite,
  pluginSyncStoreClear,
  pluginSyncStoreGet,
  pluginSyncStoreGetAll,
  pluginSyncStoreRemove,
  pluginSyncStoreSet,
  pluginSyncStoreUsage,
} from "../ipc.ts";
import {
  addLifecycleHandler,
  readLifecycleState,
  type PluginEnterAction,
} from "./event-hub.ts";
import {
  defineRpcNamespace,
  type CallRunner,
  type PermissionRequestOutcome,
  type PluginHostContext,
  type PluginSubInputOptions,
  type PluginSyncState,
} from "./core.ts";
import {
  PERMISSION_REQUEST_LIMIT,
  PERMISSION_REQUEST_MAX_APIS,
  PERMISSION_REQUEST_WINDOW_MS,
} from "../permission-requests.ts";
import {
  addThemeChangedHandler,
  clearThemeHandlers,
  clearThemeProvider,
  registerPluginThemeProvider,
} from "./event-hub.ts";

/** 宿主检索与加权实现（由 search 窗口注入，避免循环依赖） */
let hostSearch: (keyword: string) => SearchResult[] | Promise<SearchResult[]> = () => [];
let scoreItem: (item: SearchItem) => void = () => undefined;

export function bindPluginHostRuntime(hooks: {
  search?: (keyword: string) => SearchResult[] | Promise<SearchResult[]>;
  score?: (item: SearchItem) => void;
}): void {
  if (hooks.search) hostSearch = hooks.search;
  if (hooks.score) scoreItem = hooks.score;
}

function offlineSyncState(): PluginSyncState {
  return { enabled: false, status: "idle", lastSyncAt: 0, lastError: "" };
}

function cloneItem(item: SearchItem): SearchItem {
  try {
    return structuredClone(item);
  } catch {
    return JSON.parse(JSON.stringify(item)) as SearchItem;
  }
}

function pluginDataKeys(pluginId: string): string[] {
  const prefix = "my-search-desktop:PLUGIN_DATA:" + pluginId + ":";
  const out: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) out.push(k.slice(prefix.length));
    }
  } catch {
    /* ignore */
  }
  return out;
}

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
  } catch {
    return [];
  }
}

function envDescribe(
  pluginId: string
): Array<{ name: string; description: string; secret: boolean }> {
  const granted = new Set(envGrantedNames(pluginId));
  if (granted.size === 0) return [];
  try {
    return loadEnvVars()
      .filter((v) => granted.has(v.name))
      .map((v) => ({
        name: v.name,
        description: String(v.description ?? ""),
        secret: v.secret !== false,
      }));
  } catch {
    return [];
  }
}

export function createUiDataApis(
  pluginId: string,
  record: () => PluginRecord | undefined,
  call: CallRunner,
  ctx: PluginHostContext
): {
  plugin: Record<string, unknown>;
  search: Record<string, unknown>;
  ui: Record<string, unknown>;
  input: Record<string, unknown>;
  store: Record<string, unknown>;
  env: Record<string, unknown>;
  sync: Record<string, unknown>;
  system: Record<string, unknown>;
  lifecycle: Record<string, unknown>;
  commands: Record<string, unknown>;
  results: Record<string, unknown>;
  permissions: Record<string, unknown>;
} {
  /* ---------------- 1. 插件自身元信息 ---------------- */
  const plugin = {
    id: pluginId,
    get info() {
      const rec = record();
      return rec
        ? {
            id: rec.id,
            name: rec.name,
            version: rec.version,
            enabled: rec.enabled,
            theme: resolvePluginTheme(rec),
            callTimeoutMs: rec.manifest.backend?.callTimeoutMs ?? 30000,
          }
        : {
            id: pluginId,
            name: pluginId,
            version: "?",
            enabled: false,
            theme: "inherit" as const,
          };
    },
    granted: () => record()?.grants.map((g) => g.permission) ?? [],
    has: (permission: string) => {
      const rec = record();
      return rec ? isGranted(rec, permission) : false;
    },
  };

  /* ---------------- 2. 搜索能力 ---------------- */
  const search = defineRpcNamespace("search", pluginId, call, {
    data: {
      permission: "search.read",
      handler: () => ctx.searchData().map(cloneItem),
    },
    getSearchDB: {
      permission: "search.read",
      handler: () => ctx.searchData().map(cloneItem),
    },
    query: {
      permission: "search.read",
      detail: (keyword: string) => String(keyword ?? "").slice(0, 80),
      handler: async (_env, keyword: string, limit = 30) => {
        const kw = String(keyword ?? "");
        const raw = await hostSearch(kw);
        return raw.slice(0, Math.max(1, Math.min(200, limit))).map((r) => ({
          level: r.level,
          item: cloneItem(r.item),
        }));
      },
    },
    trigger: {
      permission: "search.write",
      detail: (keyword: string) => String(keyword ?? "").slice(0, 80),
      handler: (_env, keyword: string) => {
        ctx.triggerSearch(String(keyword ?? ""));
        return true;
      },
    },
    setInput: {
      permission: "search.write",
      handler: (_env, text: string) => {
        ctx.setInput(String(text ?? ""));
        return true;
      },
    },
    /**
     * 聚焦宿主搜索框并把光标移到末尾。与 `setInput` / `trigger` 同权限
     * （search.write，都是「写搜索框」语义），典型用法是呼出类插件动作里
     * 两者连用：先 `setInput("文件搜索 : ")` 预填前缀，再聚焦——用户直接
     * 输入关键词回车即可。没有宿主搜索框的窗口（独立插件窗口）报错。
     */
    focusInput: {
      permission: "search.write",
      handler: () => {
        if (!ctx.focusSearchInput) {
          throw new Error("当前窗口不支持聚焦搜索框（请在主窗口的插件界面里使用）");
        }
        ctx.focusSearchInput();
        return true;
      },
    },
    closeView: {
      permission: "search.write",
      handler: () => {
        ctx.hideDetail();
        return true;
      },
    },
    score: {
      permission: "search.write",
      handler: (_env, item: SearchItem) => {
        scoreItem(item);
        return true;
      },
    },
  });

  /* ---------------- 2.6 权限申请闭环 ---------------- */
  /**
   * `ms.permissions.request(apis, reason)`：批量申请清单里声明过的权限。
   *
   * 申请本身**不需要权限**（否则「没权限就申请不了权限」是死循环），
   * 但宿主会校验：只能申请清单声明过的、一次 ≤8 项、同权限 24h 内 ≤3 次。
   */
  const permissions = defineRpcNamespace("permissions", pluginId, call, {
    request: {
      detail: (apis: unknown, reason: unknown) =>
        `${Array.isArray(apis) ? apis.length : 0} 项:${String(reason ?? "").slice(0, 60)}`,
      handler: async (
        _env,
        apis: unknown,
        reason?: unknown
      ): Promise<PermissionRequestOutcome> => {
        if (!ctx.requestPermissions) {
          throw new Error("当前窗口不支持权限申请（请在主窗口的插件界面里使用）");
        }
        const list = Array.isArray(apis) ? apis.map((p) => String(p ?? "")) : [];
        return await ctx.requestPermissions(
          pluginId,
          list,
          typeof reason === "string" ? reason.slice(0, 200) : undefined
        );
      },
    },
    /** 本插件最近的申请历史（最多 20 条，供插件自查「别再骚扰用户」） */
    history: {
      handler: ({ record: rec }) => (rec.permissionRequests ?? []).slice(-20),
    },
    limits: {
      handler: () => ({
        maxApisPerRequest: PERMISSION_REQUEST_MAX_APIS,
        windowMs: PERMISSION_REQUEST_WINDOW_MS,
        maxPerWindow: PERMISSION_REQUEST_LIMIT,
      }),
    },
  });

  /* ---------------- 2.5 搜索期结果提供者 ---------------- */
  /**
   * `ms.results.provide(fn)`：注册「每次搜索都有机会贡献结果」的回调。
   *
   * 约束：
   *   - 清单必须声明 `contributes.resultProvider`（声明 ≠ 自动参与，
   *     视图开过、注册了回调才参与）；
   *   - 权限 `search.write`（与 triggerSearch / setInput 同族）；
   *   - 回调返回数组，宿主按清单 `maxItems`（≤10）与全局 20 条截断，
   *     超时/异常只丢自己的结果。
   */
  const results = defineRpcNamespace("results", pluginId, call, {
    provide: {
      permission: "search.write",
      detail: (fn: unknown) => (typeof fn === "function" ? "register" : "unregister"),
      handler: (_env, fn: unknown) => {
        const rec = record();
        if (!rec) throw new Error("插件未加载，无法注册结果提供者");
        if (fn != null && typeof fn !== "function") {
          throw new Error("ms.results.provide 需要传入函数（传 null 表示注销）");
        }
        if (fn != null && !resultProviderOf(rec)) {
          throw new Error(
            "清单未声明 contributes.resultProvider，插件不能提供搜索结果"
          );
        }
        registerResultProvider(pluginId, (fn as ResultProviderFn | null) ?? null);
        return true;
      },
    },
    /** 注销本插件的提供者（等价 provide(null)） */
    clear: {
      permission: "search.write",
      handler: () => {
        registerResultProvider(pluginId, null);
        return true;
      },
    },
    /** 当前是否已注册（视图重载后可据此判断要不要重新注册） */
    active: {
      permission: "search.write",
      handler: () => hasResultProvider(pluginId),
    },
    limits: {
      permission: "search.write",
      handler: () => ({
        maxItems: RESULT_PROVIDER_MAX_ITEMS,
        globalCap: RESULT_PROVIDER_GLOBAL_CAP,
        budgetMs: RESULT_PROVIDER_BUDGET_MS,
      }),
    },
  });

  /* ---------------- 3. 界面与独立窗口能力 ---------------- */
  const ui = defineRpcNamespace(
    "ui",
    pluginId,
    call,
    {
      toast: {
        permission: "ui.notify",
        handler: (_env, text: string, type: "ok" | "error" = "ok") => {
          ctx.toast(String(text ?? ""), type === "error" ? "error" : "ok");
          return true;
        },
      },
      confirm: {
        permission: "ui.notify",
        handler: (_env, text: string) => ctx.confirm(String(text ?? "")),
      },
      setHeight: {
        permission: "ui.inlay",
        handler: (_env, px: number) => {
          const n = Math.max(0, Math.min(2000, Math.round(Number(px) || 0)));
          ctx.setViewHeight?.(n);
          return true;
        },
      },
      /**
       * 打开插件独立窗口（`ui.window` 权限）。
       *
       * 既兼容旧签名 `openWindow(entry, title)`，也支持对象参数
       * `openWindow({ entry, title, width, height, alwaysOnTop })`。
       * 优先走宿主注入钩子（便于测试/自定义），缺省直接调用宿主 `plugin_open_window`。
       */
      openWindow: {
        permission: "ui.window",
        detail: (entryOrOpts?: unknown) =>
          typeof entryOrOpts === "string"
            ? entryOrOpts.slice(0, 120)
            : String((entryOrOpts as any)?.entry ?? ""),
        handler: async (
          { pluginId: pid, record: rec },
          entryOrOpts?:
            | string
            | {
                entry?: string;
                title?: string;
                width?: number;
                height?: number;
                alwaysOnTop?: boolean;
                /** 默认 true（sandbox iframe + 白名单桥）；false 回退同上下文旧形态 */
                isolated?: boolean;
              },
          maybeTitle?: string
        ) => {
          const opts =
            typeof entryOrOpts === "object" && entryOrOpts !== null
              ? entryOrOpts
              : {
                  entry: typeof entryOrOpts === "string" ? entryOrOpts : undefined,
                  title: maybeTitle,
                };
          const resolvedEntry =
            opts.entry?.trim() || rec.manifest.contributes?.detailView?.entry || "";
          if (!resolvedEntry) {
            throw new Error("缺少窗口入口文件（entry）");
          }
          const resolvedTitle = opts.title?.trim() || rec.name || pid;
          const isolated = opts.isolated !== false;
          if (ctx.openPluginWindow) {
            const r = await ctx.openPluginWindow(pid, resolvedEntry, resolvedTitle, {
              width: opts.width,
              height: opts.height,
              alwaysOnTop: opts.alwaysOnTop,
              isolated,
            });
            return r ?? true;
          }
          return await pluginOpenWindow(pid, {
            entry: resolvedEntry,
            title: resolvedTitle,
            width: opts.width,
            height: opts.height,
            alwaysOnTop: opts.alwaysOnTop,
            isolated,
          });
        },
      },
      pickFolder: {
        permission: "ui.inlay",
        handler: async (
          { pluginId: pid },
          opts?: { title?: string; defaultPath?: string }
        ): Promise<string | null> => {
          const { isTauri } = await import("../../tauri-bridge.ts");
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
            if (typeof picked === "string") return picked;
            if (picked && typeof picked === "object" && typeof (picked as any).path === "string") {
              return (picked as any).path;
            }
            return null;
          } catch (e) {
            console.warn(`[插件 ${pid}] 打开文件夹选择对话框失败:`, e);
            throw new Error("文件夹选择对话框不可用");
          }
        },
      },
    },
    {
      onThemeChanged: (fn: (theme: "light" | "dark") => void): (() => void) =>
        addThemeChangedHandler(pluginId, fn),
      _clearThemeHandlers: (): void => clearThemeHandlers(pluginId),
      registerThemeProvider: (fn: () => "light" | "dark" | "inherit"): (() => void) =>
        registerPluginThemeProvider(pluginId, fn),
      applyTheme: (): boolean => {
        try {
          ctx.refreshPluginTheme?.();
        } catch (e) {
          console.warn(`[插件 ${pluginId}] 应用插件主题失败:`, e);
        }
        return true;
      },
      _clearThemeProvider: (): void => clearThemeProvider(pluginId),
      /**
       * `ms.ui.subInput`：宿主渲染在插件视图上方的输入框（P1-5）。
       * 由 `ui.inlay` 授权（与「能渲染插件界面」同一件事，不新增负担）。
       */
      subInput: {
        set: (opts: PluginSubInputOptions = {}) =>
          call({
            api: "ui.subInput.set",
            permission: "ui.inlay",
            detail: String(opts.placeholder ?? "").slice(0, 40),
            run: () => {
              if (!ctx.subInput) throw new Error("当前窗口不支持子输入框");
              return ctx.subInput(pluginId, "set", opts);
            },
          }),
        remove: () =>
          call({
            api: "ui.subInput.remove",
            permission: "ui.inlay",
            run: () => {
              if (!ctx.subInput) return false;
              return ctx.subInput(pluginId, "remove");
            },
          }),
        focus: () =>
          call({
            api: "ui.subInput.focus",
            permission: "ui.inlay",
            run: () => {
              if (!ctx.subInput) return false;
              return ctx.subInput(pluginId, "focus");
            },
          }),
      },
    }
  );
  Object.defineProperty(ui, "theme", {
    enumerable: true,
    get: (): "light" | "dark" => effectiveTheme(),
  });

  /* ---------------- 4. 输入附件与受控文件对话框 ---------------- */
  const input = defineRpcNamespace("input", pluginId, call, {
    attachments: {
      permission: "file.read",
      handler: () => (ctx.getAttachments?.() ?? []).map((a) => ({ ...a })),
    },
    /**
     * 弹系统「选择文件夹」对话框，并把用户挑中的文件夹**并入搜索框附件**
     * （`multiple` 缺省 true，可一次选多个）。返回实际附加的条目
     * （与 `attachments()` 同构：{ kind, name, path }）；用户取消返回 `[]`。
     *
     * 安全语义：这是插件能「扩」附件集合的唯一入口，且路径只能来自
     * 系统对话框——用户的显式挑选就是授权，插件无法凭空附加任意路径
     * （见 PluginHostContext.attachPaths 的注释）。并入走宿主既有的
     * attachByPaths 管线（describePaths → chips → Rust 登记 → 广播
     * ms-attachments-changed），因此打开着的插件视图会自动重扫。
     */
    pickFolders: {
      permission: "file.read",
      detail: () => "选择文件夹对话框",
      handler: async (
        { pluginId: pid },
        opts: { title?: string; multiple?: boolean; defaultPath?: string } = {}
      ) => {
        if (!ctx.attachPaths) {
          throw new Error("当前窗口不支持添加搜索附件（请在主窗口的插件界面里使用）");
        }
        const { isTauri } = await import("../../tauri-bridge.ts");
        if (!isTauri) return []; // 浏览器调试环境没有系统对话框：等同取消
        let picked: unknown;
        try {
          const pkg: any = await import("@tauri-apps/plugin-dialog");
          picked = await pkg.open({
            directory: true,
            multiple: opts?.multiple !== false,
            title: String(opts?.title ?? "选择要搜索的文件夹"),
            defaultPath:
              typeof opts?.defaultPath === "string" && opts.defaultPath.trim() !== ""
                ? opts.defaultPath
                : undefined,
          });
        } catch (e) {
          console.warn(`[插件 ${pid}] 打开文件夹选择对话框失败:`, e);
          throw new Error("文件夹选择对话框不可用");
        }
        const paths = (
          Array.isArray(picked)
            ? picked
            : typeof picked === "string"
              ? [picked]
              : picked && typeof picked === "object" && typeof (picked as any).path === "string"
                ? [(picked as any).path]
                : []
        )
          .map((p) => String(p ?? "").trim())
          .filter(Boolean);
        if (paths.length === 0) return []; // 用户取消
        const attached = await ctx.attachPaths(paths);
        return (attached ?? []).map((a) => ({ ...a }));
      },
    },
    /**
     * 按路径把一个文件/文件夹从搜索框附件里移除（插件给附件 chips 配 × 用）。
     * 只做「减法」：移除只会**收紧**插件的可见访问范围，不存在扩权风险。
     * 路径不存在时返回 `false`（幂等，不报错）。
     */
    detach: {
      permission: "file.read",
      detail: (path: string) => String(path ?? "").slice(0, 300),
      handler: async (_env, path: string) => {
        const p = String(path ?? "").trim();
        if (!p) throw new Error("缺少路径");
        if (!ctx.detachPath) {
          throw new Error("当前窗口不支持移除搜索附件（请在主窗口的插件界面里使用）");
        }
        return await ctx.detachPath(p);
      },
    },
    readFile: {
      permission: "file.read",
      detail: (path: string) => String(path ?? "").slice(0, 300),
      handler: async ({ pluginId: pid }, path: string) => {
        const p = String(path ?? "").trim();
        if (!p) throw new Error("缺少文件路径");
        return await attachmentRead(pid, p);
      },
    },
    listFolder: {
      permission: "file.read",
      detail: (path: string) => String(path ?? "").slice(0, 300),
      handler: async (
        { pluginId: pid },
        path: string,
        opts: { limit?: number; gen?: number } = {}
      ) => {
        const p = String(path ?? "").trim();
        if (!p) throw new Error("缺少文件夹路径");
        const limit = Math.max(0, Math.floor(Number(opts?.limit)) || 0);
        const gen = Math.floor(Number(opts?.gen));
        return await attachmentList(
          pid,
          p,
          limit,
          Number.isFinite(gen) && gen > 0 ? gen : undefined
        );
      },
    },
    listFolderStream: {
      permission: "file.read",
      detail: (path: string) => String(path ?? "").slice(0, 300),
      handler: async (
        { pluginId: pid },
        path: string,
        onBatch: (entries: unknown[]) => void,
        opts: { limit?: number; gen?: number } = {}
      ) => {
        const p = String(path ?? "").trim();
        if (!p) throw new Error("缺少文件夹路径");
        if (typeof onBatch !== "function") throw new Error("缺少批次回调 onBatch");
        const limit = Math.max(0, Math.floor(Number(opts?.limit)) || 0);
        const gen = Math.floor(Number(opts?.gen));
        return await attachmentListStream(
          pid,
          p,
          (batch) => onBatch(batch as unknown[]),
          limit,
          Number.isFinite(gen) && gen > 0 ? gen : undefined
        );
      },
    },
    cancelListFolder: {
      permission: "file.read",
      handler: async (_env, gen: number) => {
        const g = Math.floor(Number(gen));
        if (!Number.isFinite(g) || g <= 0) throw new Error("缺少列举代次（gen）");
        await attachmentListCancel(g);
        return true;
      },
    },
    open: {
      permission: "file.read",
      detail: (path: string) => String(path ?? "").slice(0, 300),
      handler: async ({ pluginId: pid }, path: string) => {
        const p = String(path ?? "").trim();
        if (!p) throw new Error("缺少路径");
        await attachmentOpen(pid, p);
        return true;
      },
    },
    reveal: {
      permission: "file.read",
      detail: (path: string) => String(path ?? "").slice(0, 300),
      handler: async ({ pluginId: pid }, path: string) => {
        const p = String(path ?? "").trim();
        if (!p) throw new Error("缺少路径");
        await attachmentReveal(pid, p);
        return true;
      },
    },
    fileIcons: {
      permission: "file.read",
      detail: (entries: unknown[]) => `${Array.isArray(entries) ? entries.length : 0} 个路径`,
      handler: async (
        { pluginId: pid },
        entries: { path: string; isDir?: boolean }[]
      ) => {
        const list = (Array.isArray(entries) ? entries : [])
          .filter((e) => e && String(e.path ?? "").trim() !== "")
          .map((e) => ({ path: String(e.path), isDir: !!e.isDir }));
        if (list.length === 0) return {};
        const map = await attachmentFileIcons(list, pid);
        const out: Record<string, string> = {};
        for (const [k, v] of map) out[k] = v;
        return out;
      },
    },
    pickFiles: {
      permission: "file.read",
      handler: async ({ pluginId: pid }) => {
        const files = await pluginPickFiles(pid);
        return files.map((f) => ({ ...f }));
      },
    },
    saveFile: {
      permission: "file.write",
      detail: (fileName: string) => String(fileName ?? "").slice(0, 200),
      handler: async ({ pluginId: pid }, fileName: string, dataBase64: string) => {
        const name = String(fileName ?? "").trim();
        if (!name) throw new Error("缺少文件名");
        if (typeof dataBase64 !== "string") throw new Error("缺少 base64 内容");
        return await pluginSaveFile(pid, name, dataBase64);
      },
    },
  });

  /* ---------------- 5. 键值存储（轻量同步 localStorage + 大容量异步文件化 JSON） ---------------- */
  /**
   * `ms.store.collection(name)` 的工厂（P1-4）。
   *
   * 为什么不直接把集合方法摊在 `ms.store` 上：集合是有名字的命名空间，
   * `ms.store.collection("todos").add({...})` 比 `ms.store.add("todos", …)`
   * 更难写错，也方便插件把「一个集合」当对象传来传去。
   */
  function collectionApi(rawName: string): Record<string, unknown> {
    const name = String(rawName ?? "").trim();
    const NAME_RE = /^[a-zA-Z0-9._-]{1,64}$/;
    const ID_RE = /^[a-zA-Z0-9._-]{1,128}$/;
    const assertReady = (): void => {
      if (!NAME_RE.test(name)) {
        throw new Error("集合名非法（1-64 字，仅字母数字 . _ -）");
      }
    };
    const run = <T>(method: string, detail: string, fn: () => Promise<T> | T): Promise<T> =>
      Promise.resolve(
        call({
          api: `store.collection.${method}`,
          permission: "store",
          detail: `${name}:${detail}`.slice(0, 120),
          run: () => fn(),
        })
      );
    return {
      name,
      add: async (data: unknown, id?: string) => {
        assertReady();
        const itemId = String(id ?? "").trim() || newId();
        if (!ID_RE.test(itemId)) throw new Error("记录 id 非法（1-128 字，仅字母数字 . _ -）");
        const created = await run("add", itemId, () =>
          pluginCollectionPut(pluginId, name, itemId, data, "add")
        );
        if (!created) throw new Error(`记录已存在: ${itemId}`);
        return itemId;
      },
      update: async (id: string, data: unknown) => {
        assertReady();
        const itemId = String(id ?? "").trim();
        if (!ID_RE.test(itemId)) throw new Error("记录 id 非法");
        return await run("update", itemId, () =>
          pluginCollectionPut(pluginId, name, itemId, data, "update")
        );
      },
      remove: async (id: string) => {
        assertReady();
        return await run("remove", String(id ?? ""), () =>
          pluginCollectionDelete(pluginId, name, String(id ?? "").trim())
        );
      },
      get: async (id: string, fallback: unknown = null) => {
        assertReady();
        const raw = await run("get", String(id ?? ""), () =>
          pluginCollectionGet(pluginId, name, String(id ?? "").trim())
        );
        if (raw == null) return fallback;
        return parseCollectionJson(raw, `记录 ${id}`);
      },
      list: async (opts: { prefix?: string; limit?: number; cursor?: string } = {}) => {
        assertReady();
        const page = await run("list", String(opts.prefix ?? ""), () =>
          pluginCollectionList(pluginId, name, {
            prefix: opts.prefix == null ? "" : String(opts.prefix),
            limit: opts.limit,
            cursor: opts.cursor,
          })
        );
        return {
          items: page.items.map((it) => ({
            id: it.id,
            data: parseCollectionJson(it.data, `记录 ${it.id}`),
          })),
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        };
      },
      clear: async () => {
        assertReady();
        return await run("clear", "", () => pluginCollectionClear(pluginId, name));
      },
    };
  }

  function newId(): string {
    const c = globalThis.crypto as Crypto | undefined;
    if (c?.randomUUID) return c.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function parseCollectionJson(raw: string, what: string): unknown {
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`${what} 不是合法 JSON（可能已损坏）`);
    }
  }

  const store = defineRpcNamespace("store", pluginId, call, {
    get: {
      permission: "store",
      handler: ({ pluginId: pid }, key: string, fallback: unknown = null) =>
        pluginDataGet(pid, String(key ?? ""), fallback),
    },
    set: {
      permission: "store",
      handler: ({ pluginId: pid }, key: string, value: unknown) => {
        pluginDataSet(pid, String(key ?? ""), value);
        return true;
      },
    },
    remove: {
      permission: "store",
      handler: ({ pluginId: pid }, key: string) => {
        pluginDataRemove(pid, String(key ?? ""));
        return true;
      },
    },
    keys: {
      permission: "store",
      handler: ({ pluginId: pid }) => pluginDataKeys(pid),
    },
    /**
     * 从插件私有目录 `plugin-data/<pluginId>/kv/<key>.json` 读取结构化 JSON（突破 localStorage 5MB 配额，且天然随 `.msbackup` 备份）。
     */
    readJson: {
      permission: "store",
      detail: (key: string) => String(key ?? "").slice(0, 64),
      handler: async ({ pluginId: pid }, key: string, fallback: unknown = null) => {
        const val = await pluginStorageRead(pid, String(key ?? ""));
        return val === null || val === undefined ? fallback : val;
      },
    },
    /**
     * 原子写入结构化 JSON 到 `plugin-data/<pluginId>/kv/<key>.json`。
     */
    writeJson: {
      permission: "store",
      detail: (key: string) => String(key ?? "").slice(0, 64),
      handler: async ({ pluginId: pid }, key: string, value: unknown) => {
        await pluginStorageWrite(pid, String(key ?? ""), value);
        return true;
      },
    },
    /**
     * 删除 `plugin-data/<pluginId>/kv/<key>.json`。
     */
    removeJson: {
      permission: "store",
      detail: (key: string) => String(key ?? "").slice(0, 64),
      handler: async ({ pluginId: pid }, key: string) => {
        await pluginStorageDelete(pid, String(key ?? ""));
        return true;
      },
    },
  }, {
    /**
     * `ms.store.collection(name)`：按集合名拿到 add / update / remove / get / list / clear。
     * 所有方法都走 `store` 权限（与 ms.store 同一门禁），不新增授权负担。
     */
    collection: (name: string) => collectionApi(name),
  });

  /**
   * 5b. 云数据 store（`ms.store.sync.*`）——`chrome.storage.sync` 的等价物。
   *
   * 与上面 `ms.store` / `readJson` / `writeJson` 的区别：
   *   - 这份数据**专为跨设备同步**而存在，随云备份上传（`sync-store/<id>.json`）；
   *   - 有**硬配额**：单键 64KB、单插件 512KB、所有插件合计 8MB、单插件最多 500 键；
   *   - 写入成功即广播 `plugin-sync://changed`，常驻主窗口的同步宿主会立刻安排一轮
   *     上传，不需要插件自己调 `ms.sync.trigger()`。
   *
   * 典型用法：只放「换设备后必须还原」的小状态（用户的筛选偏好、订阅列表、
   * 上次打开的文件路径…）。图片、索引、录屏、下载的工具请留在插件本地目录。
   *
   * 权限沿用 `store`（与 `ms.store` 同一语义），不给已安装插件新增授权负担。
   */
  const syncStore = defineRpcNamespace("store.sync", pluginId, call, {
    /** 读取全部云数据（键值对象） */
    getAll: {
      permission: "store",
      handler: async ({ pluginId: pid }) => await pluginSyncStoreGetAll(pid),
    },
    /** 读取一个键；不存在时返回 `fallback` */
    get: {
      permission: "store",
      detail: (key: string) => String(key ?? "").slice(0, 64),
      handler: async ({ pluginId: pid }, key: string, fallback: unknown = null) => {
        const v = await pluginSyncStoreGet(pid, String(key ?? ""));
        return v === null || v === undefined ? fallback : v;
      },
    },
    /** 写入一个键；超配额抛错（错误文案可直接 toast 给用户） */
    set: {
      permission: "store",
      detail: (key: string) => String(key ?? "").slice(0, 64),
      handler: async ({ pluginId: pid }, key: string, value: unknown) =>
        await pluginSyncStoreSet(pid, String(key ?? ""), value),
    },
    /** 删除一个键；返回原本是否存在 */
    remove: {
      permission: "store",
      detail: (key: string) => String(key ?? "").slice(0, 64),
      handler: async ({ pluginId: pid }, key: string) =>
        await pluginSyncStoreRemove(pid, String(key ?? "")),
    },
    /** 清空该插件的全部云数据 */
    clear: {
      permission: "store",
      handler: async ({ pluginId: pid }) => {
        await pluginSyncStoreClear(pid);
        return true;
      },
    },
    /** 查询用量（字节数 / 键数 / 配额），用于插件自检或面板提示 */
    usage: {
      permission: "store",
      handler: async ({ pluginId: pid }) => await pluginSyncStoreUsage(pid),
    },
  });
  (store as Record<string, unknown>).sync = syncStore;

  /* ---------------- 6. 环境变量 ---------------- */
  const env = defineRpcNamespace(
    "env",
    pluginId,
    call,
    {
      list: {
        handler: ({ pluginId: pid }) => envDescribe(pid),
      },
      pick: {
        handler: async (
          { pluginId: pid },
          opts: { title?: string; purpose?: string } = {}
        ) => {
          if (!ctx.pickEnvVar) return null;
          return await ctx.pickEnvVar(pid, {
            title: opts?.title ? String(opts.title) : undefined,
            purpose: opts?.purpose ? String(opts.purpose) : undefined,
          });
        },
      },
    },
    {
      granted: () => envGrantedNames(pluginId),
      has: (name: string) => envGrantedNames(pluginId).includes(String(name ?? "")),
    }
  );

  /* ---------------- 7. 云同步 ---------------- */
  const sync = defineRpcNamespace("sync", pluginId, call, {
    status: {
      permission: "sync",
      handler: (): PluginSyncState => ctx.syncStatus?.() ?? offlineSyncState(),
    },
    trigger: {
      permission: "sync",
      handler: async (): Promise<PluginSyncState> => {
        if (!ctx.syncNow) throw new Error("当前窗口不支持数据同步");
        return await ctx.syncNow();
      },
    },
  });

  /* ---------------- 8. 系统交互 ---------------- */
  const system = defineRpcNamespace("system", pluginId, call, {
    openExternal: {
      permission: "system.openExternal",
      detail: (url: string) => String(url ?? "").slice(0, 200),
      handler: async (_env, url: string) => {
        const u = String(url ?? "");
        if (!/^https?:\/\//i.test(u)) throw new Error("仅允许打开 http/https 链接");
        await openExternal(u);
        return true;
      },
    },
    readClipboard: {
      permission: "clipboard.read",
      handler: async () => {
        try {
          return await navigator.clipboard.readText();
        } catch {
          throw new Error("读取剪贴板失败（可能被系统权限拒绝）");
        }
      },
    },
    writeClipboard: {
      permission: "clipboard.write",
      handler: async (_env, text: string) => {
        try {
          await navigator.clipboard.writeText(String(text ?? ""));
          return true;
        } catch {
          throw new Error("写入剪贴板失败");
        }
      },
    },
    getSelectedText: {
      permission: "selection.read",
      handler: (_env, hint?: string) =>
        ctx.getSelectedText(String(hint ?? "请选择页面文本")),
    },
    getSecret: {
      permission: (name: string) => `secret.read:${String(name ?? "")}`,
      handler: ({ pluginId: pid }, name: string) =>
        ctx.getSecret?.(pid, String(name ?? "")) ?? Promise.resolve(null),
    },
    /**
     * `ms.system.setSecret(name, value)`（P1-2）：把密钥写进系统的 DPAPI 存储。
     *
     * 为什么值得单独开一个写权限：插件常见的做法是「让用户粘贴一次 API Key」，
     * 如果没有这层能力，密钥只能明文进 localStorage——一次误备份就泄漏。
     * 写入后插件仍可以通过 `getSecret` 读回，但**不会**在宿主日志里出现明文。
     */
    setSecret: {
      permission: (name: string) => `secret.write:${String(name ?? "")}`,
      detail: (name: unknown) => String(name ?? "").slice(0, 64),
      handler: async ({ pluginId: pid }, name: string, value: string) => {
        const n = String(name ?? "").trim();
        if (!n) throw new Error("密钥名不能为空");
        if (!ctx.setSecret) throw new Error("当前窗口不支持写入密钥");
        return await ctx.setSecret(pid, n, String(value ?? ""));
      },
    },
    /** 删除密钥（`secret.write:<name>`；不存在的名字返回 false） */
    deleteSecret: {
      permission: (name: string) => `secret.write:${String(name ?? "")}`,
      detail: (name: unknown) => String(name ?? "").slice(0, 64),
      handler: async ({ pluginId: pid }, name: string) => {
        if (!ctx.deleteSecret) throw new Error("当前窗口不支持删除密钥");
        return await ctx.deleteSecret(pid, String(name ?? "").trim());
      },
    },
    /**
     * 列出本插件已保存的密钥**名字**（不含值）。
     *
     * 不设权限门禁：名字通常是插件自己写进去的，值才是秘密；而 `secret.read`
     * 是带 scope 的权限，没有「任意 scope」的授予形态可复用。真正的读取仍要
     * `secret.read:<name>`。
     */
    listSecrets: {
      handler: async ({ pluginId: pid }) => {
        if (!ctx.listSecrets) return [];
        return await ctx.listSecrets(pid);
      },
    },
  });

  /* ---------------- 9. 生命周期 ---------------- */
  /**
   * `ms.lifecycle.*`：插件视图的显示/隐藏/进入/销毁事件。
   *
   * 为什么需要：`minimize` 语义下关闭界面只是把会话停到停车场，再次打开
   * **不会重跑脚本**——插件没有「我又回到前台」的信号，只能轮询或让用户手动刷新。
   * 另外「这次是从搜索/快捷键/附件/子关键词哪条路进来的」也只有宿主知道。
   *
   * 权限沿用 `ui.inlay`：事件与视图同生命周期，不新增授权负担。
   * 注册返回退订函数；`onShow` / `onEnter` 支持「注册晚于事件」的粘性补发。
   */
  const lifecycle = defineRpcNamespace("lifecycle", pluginId, call, {
    onShow: {
      permission: "ui.inlay",
      handler: (_env, fn: (arg?: unknown) => void) =>
        addLifecycleHandler(pluginId, "show", fn),
    },
    onHide: {
      permission: "ui.inlay",
      handler: (_env, fn: (arg?: unknown) => void) =>
        addLifecycleHandler(pluginId, "hide", fn),
    },
    onEnter: {
      permission: "ui.inlay",
      handler: (_env, fn: (arg?: PluginEnterAction) => void) =>
        addLifecycleHandler(pluginId, "enter", fn as unknown as (arg?: unknown) => void),
    },
    onDispose: {
      permission: "ui.inlay",
      handler: (_env, fn: (arg?: unknown) => void) =>
        addLifecycleHandler(pluginId, "dispose", fn),
    },
    /** 当前是否可见 + 最近一次进入参数（供「注册晚于事件」之外的自查） */
    current: {
      permission: "ui.inlay",
      handler: () => readLifecycleState(pluginId),
    },
  });

  /* ---------------- 10. 运行时命令 ---------------- */
  /**
   * `ms.commands.*`：注册/注销搜索命令（等价于 uTools 的 `setFeature`）。
   *
   * 设计取舍：
   *   - **必须落盘**（写注册表并广播 `plugin://registry-changed`），否则重启后
   *     命令消失，搜索入口与插件实际能力对不上；
   *   - 单插件上限 20 条，前缀必须含 `" : "`（缺失时自动补齐）；
   *   - 与清单 `contributes.command` 同 id 合并，运行时优先。
   */
  const commands = defineRpcNamespace("commands", pluginId, call, {
    register: {
      permission: "ui.command",
      detail: (cmd: { id?: string; prefix?: string; title?: string; desc?: string }) =>
        `${String(cmd?.id ?? "")}:${String(cmd?.prefix ?? "")}`.slice(0, 120),
      handler: (
        _env,
        cmd: { id: string; prefix: string; title: string; desc?: string }
      ) => {
        const reg = ctx.registry() as PluginRegistryFile;
        const res = upsertRuntimeCommand(reg, pluginId, {
          id: String(cmd?.id ?? ""),
          prefix: String(cmd?.prefix ?? ""),
          title: String(cmd?.title ?? ""),
          desc: cmd?.desc == null ? undefined : String(cmd.desc),
        });
        if (!res.ok) throw new Error(res.error);
        ctx.persistRegistry();
        return res.command;
      },
    },
    unregister: {
      permission: "ui.command",
      detail: (id: string) => String(id ?? "").slice(0, 64),
      handler: (_env, id: string) => {
        const reg = ctx.registry() as PluginRegistryFile;
        const removed = removeRuntimeCommand(reg, pluginId, String(id ?? ""));
        if (removed) ctx.persistRegistry();
        return removed;
      },
    },
    list: {
      permission: "ui.command",
      handler: ({ record: rec }) => listAllCommands(rec),
    },
    /** 配额与规范（作者自检用） */
    limits: {
      permission: "ui.command",
      handler: () => ({
        maxRuntimeCommands: MAX_RUNTIME_COMMANDS,
        prefixBoundary: " : ",
        idPattern: "^[a-zA-Z0-9._-]{1,64}$",
      }),
    },
  });

  return {
    plugin,
    search,
    ui,
    input,
    store,
    env,
    sync,
    system,
    lifecycle,
    commands,
    results,
    permissions,
  };
}
