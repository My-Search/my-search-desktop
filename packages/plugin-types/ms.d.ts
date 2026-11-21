/**
 * my-search-desktop 插件前端 API 类型（v1）。
 *
 * 用法（仓库内插件）：
 *   /// <reference path="../../packages/plugin-types/ms.d.ts" />
 * 或在 tsconfig 的 `types`/`include` 里加入本文件。
 *
 * 说明：
 * - `ms` 是宿主注入到插件视图的网关，所有调用都经过权限与审计，**不是** Electron preload；
 * - 标注「需权限」的方法在未授权时会抛出错误；
 * - 本文件只描述前端可见面；`backend` 是 stdio JSON-RPC 客户端。
 */

export interface MsPluginInfo {
  id: string;
  name: string;
  version: string;
  /** 插件目录（只读展示用） */
  dir: string;
  /** 插件私有数据目录 */
  dataDir: string;
}

export interface MsSearchItem {
  title: string;
  desc?: string;
  keyword: string;
  icon?: string;
  resource?: string;
  [key: string]: unknown;
}

export type MsEnterType =
  | "text"
  | "files"
  | "folders"
  | "subKeyword"
  | "shortcut"
  | "command"
  | "restore"
  | "result";

export type MsEnterFrom =
  | "search"
  | "hotkey"
  | "attachment"
  | "subsearch"
  | "restore"
  | "command";

export interface MsEnterAction {
  type: MsEnterType;
  /** 关键词 / 命令前缀 / 结果动作码 */
  code: string;
  keyword: string;
  /** files/folders 为路径数组；result 为点击回传数据 */
  payload?: unknown;
  from: MsEnterFrom;
  at: number;
}

export interface MsResultItem {
  id?: string;
  title: string;
  desc?: string;
  icon?: string;
  action?: string;
  payload?: unknown;
}

export interface MsSubInputOptions {
  placeholder?: string;
  value?: string;
  visible?: boolean;
  focus?: boolean;
  onChange?: (value: string) => void;
}

export interface MsPermissionRequestOutcome {
  ok: boolean;
  granted: string[];
  denied: string[];
  throttled: boolean;
  error?: string;
}

export interface MsCollectionPage<T = unknown> {
  items: Array<{ id: string; data: T }>;
  nextCursor?: string;
  hasMore: boolean;
}

/** `ms.net.fetch` 的可选参数 */
export interface MsNetFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** 二进制请求体（base64）；与 body 二选一 */
  bodyBase64?: string;
  responseType?: "text" | "base64";
  maxBytes?: number;
  timeoutSecs?: number;
  throwOnHttpError?: boolean;
  /** 使用哪条网络凭据；值由宿主在发请求时注入，插件永远拿不到 */
  credential?: string;
}

export interface MsNetFetchResult {
  status: number;
  ok: boolean;
  text: string;
  headers: Record<string, string>;
  base64?: string;
  contentType?: string;
}

/** 凭据只回元数据，**不含 value** */
export interface MsNetCredentialMeta {
  name: string;
  origin: string;
  scheme: "bearer" | "basic" | "header";
  header?: string | null;
  username?: string | null;
}

export interface MsCollection<T = unknown> {
  add(data: T, id?: string): Promise<string>;
  update(id: string, data: T): Promise<boolean>;
  set(id: string, data: T): Promise<void>;
  get(id: string, fallback?: T): Promise<T | undefined>;
  remove(id: string): Promise<boolean>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<MsCollectionPage<T>>;
  clear(): Promise<number>;
}

export interface MsApi {
  /** 当前插件信息（同步只读） */
  readonly plugin: MsPluginInfo;

  search: {
    /** 需权限 search.read */
    data(): Promise<MsSearchItem[]>;
    getSearchDB(): Promise<unknown>;
    /** 需权限 search.write */
    query(keyword: string, options?: { limit?: number }): Promise<unknown>;
    /** 需权限 search.write */
    trigger(keyword: string): Promise<void>;
    setInput(text: string): Promise<void>;
    focusInput(): Promise<void>;
    closeView(): Promise<void>;
    score(text: string, keyword: string): Promise<number>;
  };

  ui: {
    toast(message: string, kind?: "info" | "success" | "error"): Promise<void>;
    confirm(message: string, options?: { title?: string; danger?: boolean }): Promise<boolean>;
    setHeight(height: number): Promise<void>;
    /** 需权限 ui.window：打开独立窗口；默认 sandbox 隔离，`isolated:false` 仅排障回退 */
    openWindow(options: {
      entry?: string;
      title?: string;
      width?: number;
      height?: number;
      alwaysOnTop?: boolean;
      isolated?: boolean;
    }): Promise<unknown>;
    /** 需权限 ui.inlay */
    pickFolder(options?: { title?: string }): Promise<string | null>;
    /** 需权限 ui.inlay：在插件视图上方渲染宿主输入框 */
    subInput: {
      set(options: MsSubInputOptions): Promise<boolean>;
      remove(): Promise<boolean>;
      focus(): Promise<boolean>;
    };
  };

  input: {
    /** 需权限 input.read */
    attachments(): Promise<Array<{ path: string; name: string; isDir?: boolean }>>;
    pickFolders(options?: { title?: string; multiple?: boolean }): Promise<string[]>;
    pickFiles(options?: { title?: string; multiple?: boolean; filters?: Array<{ name: string; extensions: string[] }> }): Promise<string[]>;
    saveFile(options?: { title?: string; defaultName?: string; content?: string; base64?: string }): Promise<string | null>;
    readFile(filePath: string): Promise<string>;
    listFolder(filePath: string, options?: { depth?: number }): Promise<unknown>;
    listFolderStream(filePath: string, options?: { depth?: number }): Promise<unknown>;
    cancelListFolder(token: string): Promise<void>;
    open(filePath: string): Promise<void>;
    reveal(filePath: string): Promise<void>;
    fileIcons(paths: string[]): Promise<Array<string | null>>;
    detach(path: string): Promise<void>;
  };

  store: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    remove(key: string): Promise<boolean>;
    keys(): Promise<string[]>;
    readJson<T = unknown>(name: string, fallback?: T): Promise<T>;
    writeJson(name: string, value: unknown): Promise<void>;
    removeJson(name: string): Promise<boolean>;
    /** 需权限 store：集合（每条记录一个 JSON 文件，按 id 分页） */
    collection<T = unknown>(name: string): MsCollection<T>;
  };

  /** 需权限 store.sync：跨设备同步存储 */
  "store.sync": {
    getAll<T = unknown>(): Promise<Record<string, T>>;
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    remove(key: string): Promise<boolean>;
    clear(): Promise<void>;
    usage(): Promise<{ bytes: number; keys: number }>;
  };

  env: {
    /** 需权限 env.read:<NAME> 的变量才会出现在返回值里 */
    list(): Promise<Array<{ name: string; granted: boolean }>>;
    pick(options?: { title?: string }): Promise<string | null>;
  };

  sync: {
    status(): Promise<unknown>;
    trigger(): Promise<void>;
  };

  system: {
    openExternal(url: string): Promise<void>;
    /** 需权限 clipboard.read */
    readClipboard(): Promise<string>;
    /** 需权限 clipboard.write */
    writeClipboard(text: string): Promise<void>;
    /** 需权限 selection.read */
    getSelectedText(): Promise<string>;
    /** 需权限 secret.read:<name> */
    getSecret(name: string): Promise<string | null>;
    /** 需权限 secret.write:<name> */
    setSecret(name: string, value: string): Promise<void>;
    /** 需权限 secret.write:<name> */
    deleteSecret(name: string): Promise<boolean>;
    listSecrets(): Promise<string[]>;
  };

  /** 需权限 ui.inlay */
  lifecycle: {
    onShow(fn: () => void): () => void;
    onHide(fn: () => void): () => void;
    onEnter(fn: (action: MsEnterAction) => void): () => void;
    onDispose(fn: () => void): () => void;
    current(): MsEnterAction | null;
  };

  /** 需权限 ui.command */
  commands: {
    register(command: { id: string; prefix: string; title: string; desc?: string }): Promise<void>;
    unregister(id: string): Promise<boolean>;
    list(): Promise<Array<{ id: string; prefix: string; title: string; desc?: string; runtime: boolean }>>;
    limits(): Promise<{ maxCommands: number; idPattern: string; prefixBoundary: string }>;
  };

  /** 需权限 search.write，且清单须声明 contributes.resultProvider */
  results: {
    /** 传 null 等价于注销 */
    provide(fn: ((keyword: string) => MsResultItem[] | void | Promise<MsResultItem[] | void>) | null): Promise<boolean>;
    clear(): Promise<boolean>;
    active(): Promise<boolean>;
    limits(): Promise<{ maxItems: number; globalCap: number; budgetMs: number }>;
  };

  /** 运行时申请可选权限（不需要 permissions 权限本身） */
  permissions: {
    request(apis: string[], reason: string): Promise<MsPermissionRequestOutcome>;
    history(): Promise<Array<{ apis: string[]; reason: string; at: number; result: string }>>;
    limits(): Promise<{ windowMs: number; limit: number; maxApis: number; historyLimit: number }>;
  };

  /** 需权限 clipboard.read / clipboard.write / clipboard.history */
  clipboard: {
    read(): Promise<string>;
    write(text: string): Promise<void>;
    history(options?: { limit?: number }): Promise<Array<{ text: string; at: number }>>;
  };

  /** 需权限 screenshot.capture */
  screenshot: {
    capture(options?: { mode?: "region" | "window" | "screen" }): Promise<string | null>;
  };

  /** 全局快捷键动作 */
  shortcuts: {
    onAction(action: string, fn: () => void): () => void;
  };

  /** 网络（需权限 net.fetch:<origin>/*），由 Rust 代理，绕不过 CORS */
  net: {
    fetch(url: string, options?: MsNetFetchOptions): Promise<MsNetFetchResult>;
    /** 凭据值只进 Rust DPAPI 库；此处只提交与查看元数据 */
    credentials: {
      set(
        name: string,
        value: string,
        options: {
          scheme: "bearer" | "basic" | "header";
          /** 必填：凭据绑定 origin，跨 origin 请求会被拒绝 */
          origin: string;
          header?: string;
          username?: string;
        }
      ): Promise<boolean>;
      list(): Promise<MsNetCredentialMeta[]>;
      remove(name: string): Promise<boolean>;
    };
  };

  /** 后台进程（stdio JSON-RPC）；未配置 backend 时调用会失败 */
  backend: {
    call<T = unknown>(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<T>;
    notify(method: string, params?: unknown): Promise<void>;
    status(): Promise<{ running: boolean; pid?: number }>;
    start(): Promise<void>;
    stop(): Promise<void>;
  };

  /** 插件内日志（写入宿主日志文件，带插件 id 前缀） */
  log(level: "info" | "warn" | "error", ...args: unknown[]): void;
}

declare global {
  const ms: MsApi;
  interface Window {
    ms: MsApi;
  }
  /** 插件视图注册子关键词回调（由宿主在启动脚本时注入） */
  function onSubKeyword(fn: (keyword: string, payload?: unknown) => void): () => void;
}
