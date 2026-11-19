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
} from "../registry.ts";
import { loadEnvVars } from "../env-store.ts";
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
  pluginStorageDelete,
  pluginStorageRead,
  pluginStorageWrite,
} from "../ipc.ts";
import {
  defineRpcNamespace,
  type CallRunner,
  type PluginHostContext,
  type PluginSyncState,
} from "./core.ts";
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
          if (ctx.openPluginWindow) {
            const r = await ctx.openPluginWindow(pid, resolvedEntry, resolvedTitle, {
              width: opts.width,
              height: opts.height,
              alwaysOnTop: opts.alwaysOnTop,
            });
            return r ?? true;
          }
          return await pluginOpenWindow(pid, {
            entry: resolvedEntry,
            title: resolvedTitle,
            width: opts.width,
            height: opts.height,
            alwaysOnTop: opts.alwaysOnTop,
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
  });

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
  });

  return { plugin, search, ui, input, store, env, sync, system };
}
