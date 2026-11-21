/**
 * 插件 ↔ 宿主 的传输层。
 *
 * 这是插件系统里**唯一允许插件触碰宿主**的通道：
 *   - 前端插件只能拿到一个「已绑定 id」的 `callApi` 闭包（不是裸 Tauri IPC）；
 *   - 每次调用先过前端权限判定（本文件不做判定，由 host.ts 做），
 *     再落到 Rust 的 `plugin_file_*` / `plugin_backend_*` 命令；
 *   - 浏览器调试环境（无 Tauri）自动降级为内存文件表，保证插件开发者
 *     可以 `npm run dev` 直接调试，不需要打包。
 *
 * 之所以不用 Tauri 的 capabilities 做插件权限：capabilities 是**编译期静态**的，
 * 粒度到窗口，做不到「每个插件一套权限」。运行时的网关才是唯一可行解。
 */

import { invoke, Channel } from "@tauri-apps/api/core";
import { isTauri } from "../tauri-bridge.ts";
import { base64ToBytes } from "./package.ts";

/* ============================================================
 * 插件文件访问（相对插件目录，Rust 侧做路径穿越二次校验）
 * ============================================================ */

export interface PluginFileEntry {
  /** 相对路径（正斜杠） */
  path: string;
  size: number;
}

/** 读取插件目录内的文本文件 */
export async function readPluginText(pluginId: string, relPath: string): Promise<string> {
  if (isTauri) {
    return await invoke<string>("plugin_read_text", { pluginId, relPath });
  }
  const cached = devFileCache.get(pluginId + "/" + relPath);
  if (cached == null) throw new Error(`开发环境缺少文件: ${relPath}`);
  return cached;
}

/** 读取插件目录内的二进制文件（返回 base64，供图标/blob 使用） */
export async function readPluginBinary(pluginId: string, relPath: string): Promise<string> {
  if (isTauri) {
    return await invoke<string>("plugin_read_binary", { pluginId, relPath });
  }
  const cached = devFileCache.get(pluginId + "/" + relPath);
  if (cached == null) throw new Error(`开发环境缺少文件: ${relPath}`);
  return cached;
}

/** 列出插件目录内的文件（安装时校验 / 面板展示用） */
export async function listPluginFiles(pluginId: string): Promise<PluginFileEntry[]> {
  if (isTauri) {
    return await invoke<PluginFileEntry[]>("plugin_list_files", { pluginId });
  }
  const prefix = pluginId + "/";
  return [...devFileCache.keys()]
    .filter((k) => k.startsWith(prefix))
    .map((k) => ({ path: k.slice(prefix.length), size: devFileCache.get(k)?.length ?? 0 }));
}

/* ============================================================
 * 安装 / 卸载（Rust 侧负责落盘与原子替换）
 * ============================================================ */

/**
 * 安装一个插件包（文件已在前端解析并校验）。
 *
 * 注意：`files` **必须包含 `plugin.json`**——Rust 侧要重新读取它做 id 一致性
 * 校验，并把清单作为插件目录的一部分落盘（运行时要读）。
 */
export async function installPluginPackage(
  pluginId: string,
  files: Array<{ path: string; data: string; executable?: boolean }>
): Promise<string> {
  if (isTauri) {
    return await invoke<string>("plugin_install", { pluginId, files });
  }
  // 开发环境：写入内存文件表（manifest 由前端解析，无需真落盘）
  for (const f of files) devFileCache.set(pluginId + "/" + f.path, atob(f.data));
  return pluginId;
}

/** 卸载插件（删除安装目录） */
export async function removePluginDir(pluginId: string): Promise<void> {
  if (isTauri) {
    await invoke("plugin_remove", { pluginId });
    return;
  }
  const prefix = pluginId + "/";
  for (const k of [...devFileCache.keys()]) if (k.startsWith(prefix)) devFileCache.delete(k);
}

/**
 * 删除插件的私有数据目录（`plugin-data/<id>/`，后端进程的落盘数据）。
 * 卸载时由用户选择「是否同时删除数据」；前端 localStorage 里的数据由
 * `pluginDataClear` 清理，两者相互独立。
 */
export async function purgePluginData(pluginId: string): Promise<void> {
  if (!isTauri) return;
  await invoke("plugin_purge_data", { pluginId });
}

/** 读取开发目录中的 plugin.json 清单内容 */
export async function readDevManifest(dir: string): Promise<string> {
  if (isTauri) {
    return await invoke<string>("plugin_read_dev_manifest", { dir });
  }
  throw new Error("读取开发清单仅在桌面端可用");
}

/** 从本地目录「开发安装」（目录直挂，不拷贝文件） */
export async function installPluginFromDir(pluginId: string, dir: string): Promise<void> {
  if (isTauri) {
    await invoke("plugin_link_dir", { pluginId, dir });
    return;
  }
  throw new Error("开发安装目录仅在桌面端可用");
}

/* ============================================================
 * 开发插件热重载（目录挂载）
 * ============================================================ */

/** 「开发插件变化」事件的载荷（与 Rust `PluginChangedPayload` 对齐） */
export interface PluginChangedPayload {
  pluginId: string;
  /** 源目录（绝对路径） */
  dir: string;
  /** 本次变化涉及的文件（相对路径；可能为空 = 目录级事件） */
  paths: string[];
  /** 是否只涉及前端文件（界面/样式/图标） */
  frontendOnly: boolean;
  /** 广播时间（毫秒时间戳） */
  at: number;
}

/**
 * 登记 / 取消某个插件的源目录监听（幂等）。
 *
 * 「从目录挂载」的插件由前端在挂载时与启动时各调一次（enable=true），
 * 卸载 / 改成从文件安装时调 enable=false。**Rust 侧不读注册表**——注册表
 * 在前端 localStorage 里，让前端告诉它盯哪个目录，职责才单一。
 *
 * 浏览器调试环境（无 Tauri）静默降级：热重载是桌面端能力。
 */
export async function watchPluginDir(pluginId: string, dir: string, enable = true): Promise<void> {
  if (!isTauri) return;
  await invoke("plugin_watch_dir", { pluginId, dir, enable });
}

/**
 * 监听「开发插件变化」事件（Rust 侧 `plugin://dev-changed`）。
 *
 * 返回取消监听的函数；浏览器环境返回 no-op（与其它事件监听一致）。
 */
export async function onPluginDevChanged(
  handler: (payload: PluginChangedPayload) => void
): Promise<() => void> {
  if (!isTauri) return () => {};
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<PluginChangedPayload>("plugin://dev-changed", (event) => handler(event.payload));
  } catch (e) {
    console.warn("监听开发插件变化事件失败:", e);
    return () => {};
  }
}

/** 弹出系统目录选择框（选择插件开发目录） */
export async function pickPluginDir(): Promise<string | null> {
  if (!isTauri) return null;
  try {
    const pkg: any = await import("@tauri-apps/plugin-dialog");
    const picked = await pkg.open({ directory: true, multiple: false, title: "选择插件开发目录" });
    return typeof picked === "string" ? picked : null;
  } catch (e) {
    console.warn("目录选择对话框不可用:", e);
    return null;
  }
}

/** 弹出系统文件选择框（选择 .mspp 包） */
export async function pickPluginPackage(): Promise<string | null> {
  if (!isTauri) return null;
  try {
    const pkg: any = await import("@tauri-apps/plugin-dialog");
    const picked = await pkg.open({
      multiple: false,
      title: "选择插件安装包",
      filters: [{ name: "插件包", extensions: ["mspp", "zip"] }],
    });
    return typeof picked === "string" ? picked : null;
  } catch (e) {
    console.warn("文件选择对话框不可用:", e);
    return null;
  }
}

/** 读取本地文件为 base64（选择插件包后读入内存再解析） */
export async function readLocalFileBase64(path: string): Promise<string> {
  if (!isTauri) throw new Error("读取本地文件仅在桌面端可用");
  return await invoke<string>("plugin_read_local_base64", { path });
}

/** `plugin_pick_files` 的返回条目：只含元信息，内容仍用 `attachment_read` 读 */
export interface PickedFileEntry {
  path: string;
  name: string;
  size: number;
}

/**
 * 弹系统多选文件对话框，返回用户显式选中的文件（取消 = 空数组）。
 *
 * 选中路径由 Rust 登记进带 TTL 的「已选」集合，随后 `attachment_read`
 * 会在附件集合之外额外放行这些路径——插件仍拿不到任意本地文件。
 * 浏览器调试环境没有系统对话框，返回空数组（等同取消）。
 */
export async function pluginPickFiles(pluginId: string): Promise<PickedFileEntry[]> {
  if (!isTauri) return [];
  return await invoke<PickedFileEntry[]>("plugin_pick_files", { pluginId });
}

/**
 * 弹系统「另存为」对话框并把 base64 内容写入用户选择的位置。
 * 返回实际保存路径；用户取消返回 null。
 *
 * 浏览器调试环境退化为 `<a download>`，返回建议文件名（便于走通交互）。
 */
export async function pluginSaveFile(
  pluginId: string,
  fileName: string,
  dataBase64: string
): Promise<string | null> {
  if (isTauri) {
    return await invoke<string | null>("plugin_save_file", {
      pluginId,
      fileName,
      dataBase64,
    });
  }
  const bytes = base64ToBytes(dataBase64);
  const url = URL.createObjectURL(new Blob([bytes]));
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
  } finally {
    URL.revokeObjectURL(url);
  }
  return fileName;
}

/* ============================================================
 * 插件市场：受控下载
 * ============================================================ */

/**
 * 从市场下载一个安装包（返回原始字节）。
 *
 * Rust 侧 `market_fetch_raw` 做三道深防：调用者必须是已启用且授予
 * `plugin.install` 的插件；`url` 必须落在市场 base 白名单内；下载完再验
 * `expectedSha256`。这里把返回的 base64 解码成字节交给安装管线。
 *
 * 浏览器调试（无 Tauri）：从 `devMarketPackages` 取测试注入的包字节
 * （键为下载 URL），供端到端测试喂本地目录 fixture；未注入则抛可读错误。
 */
export async function marketFetchRaw(
  pluginId: string,
  url: string,
  expectedSha256: string
): Promise<Uint8Array> {
  if (isTauri) {
    const b64 = await invoke<string>("market_fetch_raw", { pluginId, url, expectedSha256 });
    return base64ToBytes(b64);
  }
  const cached = devMarketPackages.get(url);
  if (cached == null) throw new Error(`开发环境未注入市场包 fixture: ${url}`);
  return cached;
}

/* ============================================================
 * 后台进程控制（Rust supervisor）
 * ============================================================ */

export interface BackendStatus {
  pluginId: string;
  status: "stopped" | "starting" | "running" | "stopping" | "crashed" | "error";
  pid: number | null;
  memoryBytes: number | null;
  startedAt: number | null;
  restarts: number;
  lastError: string | null;
  keepAliveReasons: string[];
}

export interface GatewaySpecIpc {
  pluginId: string;
  enabled: boolean;
  autoStart: string;
  grants: string[];
  backendEntry: string | null;
  backendCommand?: string[] | null;
  backendProtocol: string | null;
  idleExitSec: number;
  graceSec: number;
  /** 优雅退出等待（秒）——Rust 侧按此值等 deactivate 后的收尾 */
  shutdownTimeoutSec: number;
  maxRestarts: number;
  startupTimeoutMs: number;
  callTimeoutMs: number;
  /** 注入插件后台进程的环境变量（Rust 只在 spawn 时读它） */
  env?: Record<string, string>;
  /** 是否接入宿主后台剪贴板持续捕获（需同时获授 `clipboard.read`） */
  clipboardCapture?: boolean;
}

/** 同步单个插件的网关配置 */
export async function syncGateway(payload: GatewaySpecIpc): Promise<void> {
  if (!isTauri) {
    devGateway.set(payload.pluginId, payload);
    return;
  }
  await invoke("plugin_gateway_sync", { spec: payload });
}

/**
 * 原子批量同步整张网关配置表（一次 IPC + 一次快照落盘 + 一次原生能力调和 + 自动剔除残留条目）。
 */
export async function syncGatewayBatch(specs: GatewaySpecIpc[]): Promise<void> {
  if (!isTauri) {
    devGateway.clear();
    for (const s of specs) devGateway.set(s.pluginId, s);
    return;
  }
  await invoke("plugin_gateway_sync_batch", { specs });
}

/**
 * 下发「当前已安装插件提供的快捷键作用类型」给宿主。
 *
 * 携带 `pluginId` 使宿主可按插件身份校验归属并动态路由热键事件。
 */
export async function syncPluginShortcutActions(
  actions: Array<{ action: string; pluginId?: string; defaultShortcut: string }>
): Promise<void> {
  if (!isTauri) return;
  await invoke("sync_plugin_shortcut_actions", { actions });
}

/** 通用插件快捷键读取（取代旧版各插件定制命令） */
export async function pluginShortcutGet(pluginId: string, action: string): Promise<string> {
  if (!isTauri) return devShortcuts.get(`${pluginId}:${action}`) ?? "";
  return await invoke<string>("plugin_shortcut_get", {
    pluginId,
    action: String(action ?? ""),
  });
}

/** 通用插件快捷键登记 / 改绑 / 解绑（传空串 = 解绑） */
export async function pluginShortcutSet(
  pluginId: string,
  action: string,
  shortcut: string
): Promise<string> {
  if (!isTauri) {
    const key = String(shortcut ?? "").trim().toLowerCase();
    const slot = `${pluginId}:${action}`;
    if (key) devShortcuts.set(slot, key);
    else devShortcuts.delete(slot);
    return key;
  }
  return await invoke<string>("plugin_shortcut_set", {
    pluginId,
    action: String(action ?? ""),
    shortcut: String(shortcut ?? ""),
  });
}

/* ============================================================
 * 插件文件化键值存储（`plugin-data/<pluginId>/kv/<key>.json`，不受 localStorage 5MB 配额限制）
 * ============================================================ */

export async function pluginStorageRead<T = unknown>(
  pluginId: string,
  key: string
): Promise<T | null> {
  const k = String(key ?? "").trim();
  if (!isTauri) {
    const raw = devKvStore.get(`${pluginId}:${k}`);
    return raw === undefined ? null : (JSON.parse(raw) as T);
  }
  const raw = await invoke<string | null>("plugin_storage_read", { pluginId, key: k });
  if (raw === null || raw === undefined || raw === "") return null;
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    throw new Error(`解析插件存储 JSON 失败（${k}）: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function pluginStorageWrite(
  pluginId: string,
  key: string,
  value: unknown
): Promise<void> {
  const k = String(key ?? "").trim();
  const content = JSON.stringify(value ?? null);
  if (!isTauri) {
    devKvStore.set(`${pluginId}:${k}`, content);
    // 无 Tauri 环境（浏览器调试）也广播文件存储变更：宿主据此触发云同步
    try {
      window.dispatchEvent(new CustomEvent("plugin-data://changed-dev", { detail: { pluginId, key: k } }));
    } catch { /* ignore */ }
    return;
  }
  await invoke("plugin_storage_write", { pluginId, key: k, content });
}

export async function pluginStorageDelete(pluginId: string, key: string): Promise<void> {
  const k = String(key ?? "").trim();
  if (!isTauri) {
    devKvStore.delete(`${pluginId}:${k}`);
    try {
      window.dispatchEvent(new CustomEvent("plugin-data://changed-dev", { detail: { pluginId, key: k } }));
    } catch { /* ignore */ }
    return;
  }
  await invoke("plugin_storage_delete", { pluginId, key: k });
}

/* ============================================================
 * 集合存储（ms.store.collection）——每条记录一个文件
 * ============================================================ */
export interface PluginCollectionPage {
  items: Array<{ id: string; data: string }>;
  nextCursor: string;
  hasMore: boolean;
}

const devCollections = new Map<string, string>();

function devCollectionKey(pluginId: string, collection: string, id: string): string {
  return `${pluginId}\u0000${collection}\u0000${id}`;
}

export async function pluginCollectionPut(
  pluginId: string,
  collection: string,
  id: string,
  value: unknown,
  mode: "add" | "update" | "set" = "set"
): Promise<boolean> {
  const content = JSON.stringify(value ?? null);
  if (!isTauri) {
    const key = devCollectionKey(pluginId, collection, id);
    const exists = devCollections.has(key);
    if (mode === "add" && exists) throw new Error(`记录已存在: ${id}`);
    if (mode === "update" && !exists) return false;
    devCollections.set(key, content);
    return mode === "update" ? true : !exists;
  }
  return await invoke<boolean>("plugin_collection_put", {
    pluginId,
    collection,
    id,
    content,
    mode,
  });
}

export async function pluginCollectionGet(
  pluginId: string,
  collection: string,
  id: string
): Promise<string | null> {
  if (!isTauri) return devCollections.get(devCollectionKey(pluginId, collection, id)) ?? null;
  return await invoke<string | null>("plugin_collection_get", { pluginId, collection, id });
}

export async function pluginCollectionDelete(
  pluginId: string,
  collection: string,
  id: string
): Promise<boolean> {
  if (!isTauri) return devCollections.delete(devCollectionKey(pluginId, collection, id));
  return await invoke<boolean>("plugin_collection_delete", { pluginId, collection, id });
}

export async function pluginCollectionClear(
  pluginId: string,
  collection: string
): Promise<number> {
  if (!isTauri) {
    let removed = 0;
    for (const key of [...devCollections.keys()]) {
      const [, col] = key.split("\u0000");
      if (key.startsWith(`${pluginId}\u0000`) && col === collection) {
        devCollections.delete(key);
        removed++;
      }
    }
    return removed;
  }
  return await invoke<number>("plugin_collection_clear", { pluginId, collection });
}

export async function pluginCollectionList(
  pluginId: string,
  collection: string,
  opts: { prefix?: string; limit?: number; cursor?: string } = {}
): Promise<PluginCollectionPage> {
  const limit = Math.max(1, Math.min(200, Number(opts.limit ?? 50)));
  const prefix = String(opts.prefix ?? "");
  const cursor = String(opts.cursor ?? "");
  if (!isTauri) {
    const ids = [...devCollections.keys()]
      .filter((k) => k.startsWith(`${pluginId}\u0000${collection}\u0000`))
      .map((k) => k.split("\u0000")[2])
      .filter((id) => id.startsWith(prefix) && (cursor === "" || id > cursor))
      .sort();
    const page = ids.slice(0, limit);
    return {
      items: page.map((id) => ({
        id,
        data: devCollections.get(devCollectionKey(pluginId, collection, id)) ?? "null",
      })),
      nextCursor: ids.length > limit ? page[page.length - 1] : "",
      hasMore: ids.length > limit,
    };
  }
  return await invoke<PluginCollectionPage>("plugin_collection_list", {
    pluginId,
    collection,
    prefix,
    limit,
    cursor,
  });
}

/* ============================================================
 * 插件密钥（secret.read / secret.write）
 *
 * 与 store 的 k/v 不同：值**只在需要时经 IPC 取回**，不参与 localStorage、
 * 不随插件数据备份（凭据不能以明文离开 Rust）。浏览器调试环境没有 DPAPI，
 * 用内存表模拟，保证插件开发时行为一致。
 * ============================================================ */
const devSecrets = new Map<string, string>();

export async function pluginSecretGet(pluginId: string, name: string): Promise<string | null> {
  const n = String(name ?? "").trim();
  if (!n) return null;
  if (!isTauri) return devSecrets.get(`${pluginId}:${n}`) ?? null;
  return await invoke<string | null>("plugin_secret_get", { pluginId, name: n });
}

export async function pluginSecretSet(
  pluginId: string,
  name: string,
  value: string
): Promise<boolean> {
  const n = String(name ?? "").trim();
  if (!n) throw new Error("密钥名不能为空");
  if (!isTauri) {
    if (value === "") devSecrets.delete(`${pluginId}:${n}`);
    else devSecrets.set(`${pluginId}:${n}`, value);
    return true;
  }
  return await invoke<boolean>("plugin_secret_set", { pluginId, name: n, value });
}

export async function pluginSecretDelete(pluginId: string, name: string): Promise<boolean> {
  const n = String(name ?? "").trim();
  if (!n) return false;
  if (!isTauri) return devSecrets.delete(`${pluginId}:${n}`);
  return await invoke<boolean>("plugin_secret_delete", { pluginId, name: n });
}

export async function pluginSecretList(pluginId: string): Promise<string[]> {
  if (!isTauri) {
    const prefix = `${pluginId}:`;
    return [...devSecrets.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length))
      .sort();
  }
  return await invoke<string[]>("plugin_secret_list", { pluginId });
}

/* ============================================================
 * 宿主环境变量（P2-5）
 *
 * 值只存 Rust（DPAPI），前端仅在内存持有；这里只做 IPC 包装。
 * 浏览器调试环境由 env-store 自己走 localStorage 兜底，不经过本函数。
 * ============================================================ */

/** 读取整份环境变量；`null` 表示 Rust 侧尚无文件（首次运行 / 迁移前） */
export async function hostEnvLoad(): Promise<unknown[] | null> {
  if (!isTauri) return null;
  return await invoke<unknown[] | null>("host_env_load");
}

/** 覆盖保存整份环境变量（全量提交，天然幂等） */
export async function hostEnvSave(vars: unknown[]): Promise<void> {
  if (!isTauri) return;
  await invoke("host_env_save", { vars });
}

/* ============================================================
 * 插件网络凭据（P2-3）
 *
 * 真实运行时值只存 Rust（DPAPI），前端只拿元数据；请求时由 Rust 注入。
 * 浏览器调试环境用内存表模拟，并同样校验 origin 绑定。
 * ============================================================ */

export interface PluginNetCredentialMeta {
  name: string;
  origin: string;
  scheme: "bearer" | "basic" | "header";
  header?: string | null;
  username?: string | null;
}

const devNetCredentials = new Map<
  string,
  PluginNetCredentialMeta & { value: string }
>();

export async function pluginNetCredentialSet(
  pluginId: string,
  meta: Omit<PluginNetCredentialMeta, "name"> & { name: string; value: string }
): Promise<boolean> {
  if (!isTauri) {
    const key = `${pluginId}:${meta.name}`;
    if (!meta.value) {
      return devNetCredentials.delete(key);
    }
    let origin: string;
    try {
      origin = new URL(meta.origin).origin;
    } catch {
      throw new Error("origin 必须是合法的 http(s) 地址");
    }
    devNetCredentials.set(key, { ...meta, origin });
    return true;
  }
  return await invoke<boolean>("plugin_net_credential_set", {
    pluginId,
    name: meta.name,
    value: meta.value,
    scheme: meta.scheme,
    origin: meta.origin,
    header: meta.header ?? null,
    username: meta.username ?? null,
  });
}

export async function pluginNetCredentialList(
  pluginId: string
): Promise<PluginNetCredentialMeta[]> {
  if (!isTauri) {
    const prefix = `${pluginId}:`;
    return [...devNetCredentials.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([, v]) => ({
        name: v.name,
        origin: v.origin,
        scheme: v.scheme,
        header: v.header,
        username: v.username,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  return await invoke<PluginNetCredentialMeta[]>("plugin_net_credential_list", { pluginId });
}

export async function pluginNetCredentialDelete(pluginId: string, name: string): Promise<boolean> {
  if (!isTauri) return devNetCredentials.delete(`${pluginId}:${name}`);
  return await invoke<boolean>("plugin_net_credential_delete", { pluginId, name });
}

/**
 * 浏览器调试用：按名字取要注入的请求头。
 * 真实运行时**不存在**这个出口——凭据不经过前端。
 */
export function devNetCredentialHeader(
  pluginId: string,
  name: string,
  origin: string
): [string, string] {
  const c = devNetCredentials.get(`${pluginId}:${name}`);
  if (!c) throw new Error(`没有名为 ${name} 的网络凭据`);
  if (c.origin !== origin) {
    throw new Error(`凭据 ${name} 只允许发往 ${c.origin}，当前地址是 ${origin}`);
  }
  if (c.scheme === "bearer") return ["authorization", `Bearer ${c.value}`];
  if (c.scheme === "basic") {
    // btoa 在浏览器存在；Node 测试由 net-api 自行兜底
    return ["authorization", `Basic ${btoa(`${c.username ?? ""}:${c.value}`)}`];
  }
  if (!c.header) throw new Error("header 型凭据缺少 header 名");
  return [c.header.toLowerCase(), c.value];
}

/* ============================================================
 * 插件云数据 store（`sync-store/<pluginId>.json`）
 *
 * 与上面的「文件化 KV」的区别：这份数据**专为跨设备同步而存在**，随云备份
 * 上传（带单键 / 单插件 / 全局三道配额，见 Rust `plugin_sync_store.rs`）。
 * 大文件、媒体、可重建缓存不要放这里——放 `plugin-data` 就只留在本机。
 * ============================================================ */

/** 云数据用量（写入返回 / `usage()` 查询共用） */
export interface PluginSyncUsageIpc {
  pluginId: string;
  /** 该插件已用字节 */
  bytes: number;
  /** 该插件的键数 */
  keys: number;
  /** 单键上限 */
  itemQuotaBytes: number;
  /** 单插件上限 */
  pluginQuotaBytes: number;
  /** 键数上限 */
  keysQuota: number;
  /** 所有插件合计占用 */
  totalBytes: number;
  /** 合计上限 */
  totalQuotaBytes: number;
}

/** 云数据总览（设置面板展示） */
export interface PluginSyncStatsIpc {
  plugins: Array<{ pluginId: string; cloudBytes: number; keys: number; localBytes: number }>;
  totalBytes: number;
  totalQuotaBytes: number;
  pluginQuotaBytes: number;
  itemQuotaBytes: number;
}

/** 读取某插件全部云数据 */
export async function pluginSyncStoreGetAll(pluginId: string): Promise<Record<string, unknown>> {
  if (!isTauri) return { ...(devSyncStore.get(pluginId) ?? {}) };
  return await invoke<Record<string, unknown>>("plugin_sync_store_get_all", { pluginId });
}

/** 读取一个云数据键（不存在返回 null） */
export async function pluginSyncStoreGet<T = unknown>(
  pluginId: string,
  key: string
): Promise<T | null> {
  const k = String(key ?? "").trim();
  if (!isTauri) {
    const items = devSyncStore.get(pluginId) ?? {};
    return k in items ? (items[k] as T) : null;
  }
  const v = await invoke<T | null>("plugin_sync_store_get", { pluginId, key: k });
  return v ?? null;
}

/** 写入一个云数据键（超配额会抛错，错误文案可直接展示给用户） */
export async function pluginSyncStoreSet(
  pluginId: string,
  key: string,
  value: unknown
): Promise<PluginSyncUsageIpc> {
  const k = String(key ?? "").trim();
  if (!isTauri) {
    const items = { ...(devSyncStore.get(pluginId) ?? {}), [k]: value };
    devSyncStore.set(pluginId, items);
    try {
      window.dispatchEvent(
        new CustomEvent("plugin-sync://changed-dev", { detail: { pluginId, key: k } })
      );
    } catch { /* ignore */ }
    return {
      pluginId,
      bytes: JSON.stringify(items).length,
      keys: Object.keys(items).length,
      itemQuotaBytes: 64 * 1024,
      pluginQuotaBytes: 512 * 1024,
      keysQuota: 500,
      totalBytes: 0,
      totalQuotaBytes: 8 * 1024 * 1024,
    };
  }
  return await invoke<PluginSyncUsageIpc>("plugin_sync_store_set", { pluginId, key: k, value });
}

/** 删除一个云数据键；返回它原本是否存在 */
export async function pluginSyncStoreRemove(pluginId: string, key: string): Promise<boolean> {
  const k = String(key ?? "").trim();
  if (!isTauri) {
    const items = { ...(devSyncStore.get(pluginId) ?? {}) };
    const existed = k in items;
    delete items[k];
    devSyncStore.set(pluginId, items);
    try {
      window.dispatchEvent(
        new CustomEvent("plugin-sync://changed-dev", { detail: { pluginId, key: k, removed: true } })
      );
    } catch { /* ignore */ }
    return existed;
  }
  return await invoke<boolean>("plugin_sync_store_remove", { pluginId, key: k });
}

/** 清空某插件的全部云数据 */
export async function pluginSyncStoreClear(pluginId: string): Promise<void> {
  if (!isTauri) {
    devSyncStore.delete(pluginId);
    try {
      window.dispatchEvent(
        new CustomEvent("plugin-sync://changed-dev", { detail: { pluginId, removed: true } })
      );
    } catch { /* ignore */ }
    return;
  }
  await invoke("plugin_sync_store_clear", { pluginId });
}

/** 查询某插件的云数据用量 */
export async function pluginSyncStoreUsage(pluginId: string): Promise<PluginSyncUsageIpc> {
  if (!isTauri) {
    const items = devSyncStore.get(pluginId) ?? {};
    const bytes = JSON.stringify(items).length;
    return {
      pluginId,
      bytes,
      keys: Object.keys(items).length,
      itemQuotaBytes: 64 * 1024,
      pluginQuotaBytes: 512 * 1024,
      keysQuota: 500,
      totalBytes: bytes,
      totalQuotaBytes: 8 * 1024 * 1024,
    };
  }
  return await invoke<PluginSyncUsageIpc>("plugin_sync_store_usage", { pluginId });
}

/** 所有插件的云数据占用总览（不含键值内容） */
export async function pluginSyncStoreStats(): Promise<PluginSyncStatsIpc> {
  if (!isTauri) {
    const plugins = [...devSyncStore.entries()].map(([pluginId, items]) => ({
      pluginId,
      cloudBytes: JSON.stringify(items).length,
      keys: Object.keys(items).length,
      localBytes: 0,
    }));
    return {
      plugins,
      totalBytes: plugins.reduce((n, p) => n + p.cloudBytes, 0),
      totalQuotaBytes: 8 * 1024 * 1024,
      pluginQuotaBytes: 512 * 1024,
      itemQuotaBytes: 64 * 1024,
    };
  }
  return await invoke<PluginSyncStatsIpc>("plugin_sync_store_stats", {});
}

/* ============================================================
 * 插件独立窗口（`ui.window` 权限）
 * ============================================================ */

export interface PluginOpenWindowOptionsIpc {
  entry: string;
  title?: string;
  width?: number;
  height?: number;
  alwaysOnTop?: boolean;
  /**
   * 隔离形态（P2-4）：默认 `true`。
   * `false` 只用于显式回退到旧的「插件 HTML 与宿主 API 同上下文」形态。
   */
  isolated?: boolean;
}

export async function pluginOpenWindow(
  pluginId: string,
  options: PluginOpenWindowOptionsIpc
): Promise<string> {
  if (!isTauri) throw new Error("独立插件窗口仅在桌面端可用");
  return await invoke<string>("plugin_open_window", {
    pluginId,
    entry: String(options.entry ?? ""),
    title: options.title ?? null,
    width: options.width ?? null,
    height: options.height ?? null,
    alwaysOnTop: options.alwaysOnTop ?? null,
    isolated: options.isolated !== false,
  });
}

/** 启动插件后台进程 */
export async function startPluginBackend(pluginId: string): Promise<BackendStatus> {
  if (!isTauri) throw new Error("后台进程仅在桌面端可用");
  return await invoke<BackendStatus>("plugin_backend_start", { pluginId });
}

/** 停止插件后台进程（强制结束进程树） */
export async function stopPluginBackend(pluginId: string): Promise<void> {
  if (!isTauri) return;
  await invoke("plugin_backend_stop", { pluginId });
}

/** 重启插件后台进程 */
export async function restartPluginBackend(pluginId: string): Promise<BackendStatus> {
  if (!isTauri) throw new Error("后台进程仅在桌面端可用");
  return await invoke<BackendStatus>("plugin_backend_restart", { pluginId });
}

/** 查询所有插件后台进程状态（面板轮询 / 启动后调和） */
export async function listPluginBackends(): Promise<BackendStatus[]> {
  if (!isTauri) return [];
  return await invoke<BackendStatus[]>("plugin_backend_list");
}

/** 调用插件后端方法（经 supervisor 转发，带超时与进程树约束） */
export async function callPluginBackend(
  pluginId: string,
  method: string,
  params: unknown
): Promise<unknown> {
  if (!isTauri) throw new Error("后台进程仅在桌面端可用");
  return await invoke<unknown>("plugin_backend_call", { pluginId, method, params });
}

/** 读取插件日志（尾部 N 行） */
export async function readPluginLog(pluginId: string, maxLines = 200): Promise<string> {
  if (!isTauri) return "";
  return await invoke<string>("plugin_read_log", { pluginId, maxLines });
}

/** 清空插件日志 */
export async function clearPluginLog(pluginId: string): Promise<void> {
  if (!isTauri) return;
  await invoke("plugin_clear_log", { pluginId });
}

/* ============================================================
 * 搜索框附件（粘贴 / 拖入的文件与文件夹）
 *
 * 两道校验（与 net.fetch 同构的纵深防御）：
 *   1. 前端 host.ts 先查 file.read 权限（第一道）；
 *   2. Rust 侧再查网关 grants + 路径必须落在 `attachments_sync` 登记的
 *      附加集合内（第二道）——插件拿不到集合外的本地文件。
 * ============================================================ */

/** 路径描述条目（Rust `fs_describe_paths` 的返回形状） */
export interface AttachmentPathEntry {
  path: string;
  name: string;
  isDir: boolean;
}

/** 目录列举条目（Rust `attachment_list` 的返回形状） */
export interface AttachmentDirEntry {
  path: string;
  name: string;
  /** 相对所列文件夹的路径（正斜杠） */
  relPath: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
}

/**
 * 读取系统剪贴板里的文件/文件夹路径（Windows CF_HDROP）。
 * 剪贴板没有文件时返回空数组；浏览器调试环境恒为空。
 */
export async function clipboardFilePaths(): Promise<string[]> {
  if (!isTauri) return [];
  return await invoke<string[]>("clipboard_file_paths");
}

/**
 * 按绝对路径描述条目（文件名 + 是否文件夹）。
 * 粘贴（web 层只有路径来源）与拖放（Tauri 拖拽事件只给路径）共用。
 */
export async function describePaths(paths: string[]): Promise<AttachmentPathEntry[]> {
  if (!paths?.length) return [];
  if (!isTauri) {
    return paths.map((p) => ({
      path: p,
      name: String(p).split(/[\\/]/).pop() || String(p),
      isDir: false,
    }));
  }
  return await invoke<AttachmentPathEntry[]>("fs_describe_paths", { paths });
}

/**
 * 把当前附加的路径集合登记到 Rust（读取/列举/打开前的第二道校验依据）。
 * 附件增删时由宿主调用；浏览器调试环境空实现。
 */
export async function attachmentsSync(entries: { path: string; isDir: boolean }[]): Promise<void> {
  if (!isTauri) return;
  await invoke("attachments_sync", {
    roots: (entries ?? [])
      .filter((e) => e && typeof e.path === "string" && e.path.trim() !== "")
      .map((e) => ({ path: e.path, isDir: !!e.isDir })),
  });
}

/** 读一个附加文件 → data URL（`data:<mime>;base64,...`；超限由 Rust 拒绝） */
export async function attachmentRead(pluginId: string, path: string): Promise<string> {
  if (!isTauri) throw new Error("读取附加文件仅在桌面端可用");
  return await invoke<string>("attachment_read", { pluginId, path });
}

/**
 * 读一张附加图片 → data URL，供**宿主搜索框**渲染缩略图。
 *
 * 不传 pluginId：这是宿主 UI 自己的预览，不走插件权限；Rust 侧仍要求路径
 * 落在已登记的附加集合内、且扩展名属于图片白名单（详见 attachments.rs）。
 */
export async function attachmentPreview(path: string): Promise<string> {
  if (!isTauri) throw new Error("图片预览仅在桌面端可用");
  return await invoke<string>("attachment_preview", { path });
}

/**
 * 递归列举一个附加文件夹（返回文件+子目录，按相对路径排序）。
 *
 * @param limit 条数上限；传 `0`（或省略）表示**不限条数**，一直枚举到遍历
 *   结束或经 `attachmentListCancel` 中止（Rust 侧无固定上限，深度仍受保护）。
 * @param gen 本轮列举的代次（可选）：与 `attachmentListCancel` 传相同值可中止本轮
 */
export async function attachmentList(
  pluginId: string,
  path: string,
  limit = 0,
  gen?: number
): Promise<AttachmentDirEntry[]> {
  if (!isTauri) throw new Error("列举附加文件夹仅在桌面端可用");
  return await invoke<AttachmentDirEntry[]>("attachment_list", {
    pluginId,
    path,
    limit: Math.max(0, Math.round(limit) || 0),
    ...(gen != null && Number.isFinite(gen) && gen > 0 ? { gen: Math.floor(gen) } : {}),
  });
}

/**
 * 递归列举一个附加文件夹，**边扫边回调**（流式）。
 *
 * 与 `attachmentList` 同样的参数与「附加集合 + 网关 grants」校验，区别是
 * 借 Tauri `Channel` 让 Rust 在遍历途中分批推送：`onBatch` 每收到一批
 * （`AttachmentDirEntry[]`，约 256 条）就调用一次，供调用方增量渲染；返回值
 * 仍是**完整**结果（遍历结束或取消后按相对路径排序）。`limit` 传 `0` = 不限。
 *
 * 浏览器调试环境（无 Tauri）没有 Channel，退化为一次性 `attachmentList`，
 * 结束后把整批经 `onBatch` 回调一次。
 */
export async function attachmentListStream(
  pluginId: string,
  path: string,
  onBatch: (entries: AttachmentDirEntry[]) => void,
  limit = 0,
  gen?: number
): Promise<AttachmentDirEntry[]> {
  if (!isTauri) {
    const all = await attachmentList(pluginId, path, limit, gen);
    onBatch(all);
    return all;
  }
  const channel = new Channel<AttachmentDirEntry[]>();
  channel.onmessage = (batch) => {
    try {
      onBatch(Array.isArray(batch) ? batch : []);
    } catch {
      /* 回调抛错不该拖垮列举（前端渲染问题与扫描无关） */
    }
  };
  return await invoke<AttachmentDirEntry[]>("attachment_list", {
    pluginId,
    path,
    limit: Math.max(0, Math.round(limit) || 0),
    onBatch: channel,
    ...(gen != null && Number.isFinite(gen) && gen > 0 ? { gen: Math.floor(gen) } : {}),
  });
}

/**
 * 取消一代列举（`gen` 与发起 `attachmentList` 时传入的相同）：
 * Rust 侧在途 walk 尽快带着已收集的部分返回。浏览器调试环境空实现。
 */
export async function attachmentListCancel(gen: number): Promise<void> {
  if (!isTauri) return;
  await invoke("attachment_list_cancel", { gen: Math.floor(Number(gen) || 0) });
}

/** 用系统默认程序打开一个附加路径（文件或文件夹） */
export async function attachmentOpen(pluginId: string, path: string): Promise<void> {
  if (!isTauri) throw new Error("打开本地路径仅在桌面端可用");
  await invoke("attachment_open", { pluginId, path });
}

/**
 * 在系统文件管理器（Windows 资源管理器）中定位一个附加路径：
 * 打开所在目录并选中该文件 / 文件夹。与 `attachmentOpen` 同样受
 * 「网关 grants + 附加集合」双重校验。
 */
export async function attachmentReveal(pluginId: string, path: string): Promise<void> {
  if (!isTauri) throw new Error("定位本地路径仅在桌面端可用");
  await invoke("attachment_reveal", { pluginId, path });
}

/**
 * 批量取系统文件图标（资源管理器同款），返回 `path → PNG data URL`。
 *
 * 两种调用方，两种校验口径（见 Rust `attachment_file_icons`）：
 *   - 不传 `pluginId`：宿主搜索框自己的 UI 装饰（chips / 最近添加条带），
 *     与 `attachmentPreview` 同款定位，免网关校验；条带里的历史条目未必还在
 *     当前附加集合内，因此这里不能强制集合校验。
 *   - 传 `pluginId`：插件调用（`ms.input.fileIcons`）。Rust 侧按插件身份做
 *     「网关 grants + 附加集合」双重校验，任一路径越界即整批拒绝。
 *
 * Rust 侧按**类型**缓存（同扩展名只查一次 Shell），因此前端可以放心地把
 * 全部附件一次性传过去。
 *
 * 浏览器调试环境返回空 Map：无系统图标来源，前端退回内置 SVG 图标。
 * 取不到的条目不出现在结果里（调用方按缺失走回退）；被权限/集合校验拒绝时
 * 抛出错误（由 `ms.input.fileIcons` 的网关层统一转成插件可见的报错）。
 */
export async function attachmentFileIcons(
  entries: { path: string; isDir: boolean }[],
  pluginId?: string
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const list = (entries ?? []).filter((e) => e && String(e.path ?? "").trim() !== "");
  if (list.length === 0 || !isTauri) return out;
  let results: Array<{ path: string; icon: string | null }>;
  try {
    results = await invoke<Array<{ path: string; icon: string | null }>>(
      "attachment_file_icons",
      {
        entries: list.map((e) => ({ path: e.path, isDir: !!e.isDir })),
        // 传插件身份 = 走严格校验；不传 = 宿主自身（保持历史免校验行为）
        ...(pluginId ? { pluginId } : {}),
      }
    );
  } catch (e) {
    // 插件调用（有 pluginId）：校验失败必须让调用方看到原因（权限缺失 /
    // 路径越界），不能静默成「该文件没有图标」——否则插件分不清「没图标」
    // 与「被拒绝」，也无法给用户可操作的提示。由 ms.input.fileIcons 的
    // 网关层统一转成插件可见的报错。
    if (pluginId) throw e;
    // 宿主调用：旧宿主没有该命令 / 平台不支持 → 静默退回内置图标，不影响功能
    console.warn("读取系统文件图标失败:", e);
    return out;
  }
  for (const r of results ?? []) {
    if (
      r &&
      typeof r.path === "string" &&
      typeof r.icon === "string" &&
      r.icon.startsWith("data:")
    ) {
      out.set(r.path, r.icon);
    }
  }
  return out;
}

/* ============================================================
 * 截图能力（Rust `screenshot_*` 命令；浏览器调试环境抛错，
 * 由 `ms.screenshot` 的 `ctx.*` 缺省分支转成「当前版本不支持截图」）
 * ============================================================ */

export interface ScreenshotMonitorIpc {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
  isPrimary: boolean;
}

export interface ScreenshotCaptureIpc {
  dataUrl: string;
  originX: number;
  originY: number;
  width: number;
  height: number;
  monitors?: ScreenshotMonitorIpc[];
}

export interface ScreenshotOverlayImageIpc {
  dataUrl: string;
  width: number;
  height: number;
  monitor: ScreenshotMonitorIpc;
  monitorCount: number;
  originX: number;
  originY: number;
}

export interface ScreenshotCropIpc {
  dataUrl: string;
  width: number;
  height: number;
  screenX: number;
  screenY: number;
}

export interface ScreenshotShotEntryIpc {
  relPath: string;
  name: string;
  size: number;
  mtimeMs: number;
  createdAt: string;
}

/** 整屏抓屏 → PNG data URL（不依赖遮罩窗口，纯截全屏） */
export async function screenshotCapture(pluginId: string): Promise<ScreenshotCaptureIpc> {
  if (!isTauri) throw new Error("截图仅在桌面端可用");
  return await invoke<ScreenshotCaptureIpc>("screenshot_capture", { pluginId });
}

/** 打开全屏框选遮罩（抓屏 + 每显示器一个透明窗口），返回窗口数 */
export async function screenshotOpenOverlay(pluginId: string): Promise<number> {
  if (!isTauri) throw new Error("框选遮罩仅在桌面端可用");
  return await invoke<number>("screenshot_open_overlay", { pluginId });
}

/** 关闭遮罩 */
export async function screenshotCloseOverlay(): Promise<void> {
  if (!isTauri) return;
  await invoke("screenshot_close_overlay");
}

/** 「直接在屏幕上框选」返回的矩形（虚拟桌面物理像素） */
export interface ScreenshotPickRectIpc {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 在屏幕上直接框选一个矩形：一次调用完成「开遮罩 → 用户拖选 → 关遮罩」。
 *
 * 返回虚拟桌面**物理**像素矩形（与 gdigrab/ddagrab 的采集坐标同口径）；
 * 用户按 Esc 取消返回 null。
 */
export async function screenshotPickRegion(pluginId: string): Promise<ScreenshotPickRectIpc | null> {
  if (!isTauri) throw new Error("屏幕框选仅在桌面端可用");
  return await invoke<ScreenshotPickRectIpc | null>("screenshot_pick_region", { pluginId });
}

/** 取某屏抓屏底图（data URL）——遮罩页铺满窗口用 */
export async function screenshotOverlayImage(monitorIndex: number): Promise<ScreenshotOverlayImageIpc> {
  if (!isTauri) throw new Error("框选遮罩仅在桌面端可用");
  return await invoke<ScreenshotOverlayImageIpc>("screenshot_overlay_image", {
    monitorIndex: Math.floor(Number(monitorIndex)) || 0,
  });
}

/** 框选并裁出 PNG data URL */
export async function screenshotCrop(
  monitorIndex: number,
  x: number,
  y: number,
  width: number,
  height: number
): Promise<ScreenshotCropIpc> {
  if (!isTauri) throw new Error("框选遮罩仅在桌面端可用");
  return await invoke<ScreenshotCropIpc>("screenshot_crop", {
    monitorIndex: Math.floor(Number(monitorIndex)) || 0,
    x: Number(x) || 0,
    y: Number(y) || 0,
    width: Number(width) || 0,
    height: Number(height) || 0,
  });
}

/** 把 PNG data URL 写进系统剪贴板 */
export async function screenshotCopyImage(dataUrl: string, pluginId?: string): Promise<void> {
  if (!isTauri) throw new Error("写剪贴板图片仅在桌面端可用");
  await invoke("screenshot_copy_image", {
    dataUrl: String(dataUrl ?? ""),
    ...(pluginId ? { pluginId } : {}),
  });
}

/** 把 PNG 落盘到插件私有目录，返回索引记录 */
export async function screenshotSaveShot(
  pluginId: string,
  dataUrl: string
): Promise<ScreenshotShotEntryIpc> {
  if (!isTauri) throw new Error("保存截图仅在桌面端可用");
  return await invoke<ScreenshotShotEntryIpc>("screenshot_save_shot", {
    pluginId,
    dataUrl: String(dataUrl ?? ""),
  });
}

/**
 * 弹系统「另存为」对话框，把 PNG 存到用户选定的位置。
 *
 * 返回 null = 用户取消（调用方应当**静默返回**，别报错）；
 * 返回字符串 = 实际落盘的绝对路径（扩展名已按内容校正为 .png）。
 */
export async function screenshotSaveShotAs(
  pluginId: string,
  dataUrl: string,
  parentDir?: string
): Promise<string | null> {
  if (!isTauri) throw new Error("另存为仅在桌面端可用");
  return await invoke<string | null>("screenshot_save_shot_as", {
    pluginId,
    dataUrl: String(dataUrl ?? ""),
    parentDir: parentDir ? String(parentDir) : null,
  });
}

/** 插件截图目录的绝对路径（另存为对话框的起始目录；目录不存在会就地建出来） */
export async function screenshotShotsDir(pluginId: string): Promise<string> {
  if (!isTauri) return "";
  return await invoke<string>("screenshot_shots_dir", { pluginId });
}

/** 广播「新截图已保存」 */
export async function screenshotNotifySaved(
  pluginId?: string,
  relPath?: string
): Promise<void> {
  if (!isTauri) return;
  await invoke("screenshot_notify_saved", { pluginId, relPath });
}

/** 列出插件私有目录的截图（时间从新到旧） */
export async function screenshotListShots(pluginId: string): Promise<ScreenshotShotEntryIpc[]> {
  if (!isTauri) return [];
  return await invoke<ScreenshotShotEntryIpc[]>("screenshot_list_shots", { pluginId });
}

/** 读回一张截图 → data URL */
export async function screenshotReadShot(pluginId: string, relPath: string): Promise<string> {
  if (!isTauri) throw new Error("读取截图仅在桌面端可用");
  return await invoke<string>("screenshot_read_shot", { pluginId, relPath });
}

/** 删除一张截图 */
export async function screenshotDeleteShot(pluginId: string, relPath: string): Promise<void> {
  if (!isTauri) return;
  await invoke("screenshot_delete_shot", { pluginId, relPath });
}

/** 删除早于 N 天的截图，返回删掉的张数 */
export async function screenshotPruneShots(pluginId: string, days: number): Promise<number> {
  if (!isTauri) return 0;
  return await invoke<number>("screenshot_prune_shots", {
    pluginId,
    days: Math.max(1, Math.floor(Number(days)) || 7),
  });
}

/* ============================================================
 * 鼠标手势（宿主按需原生钩子 + 插件各自独立映射表）
 * ============================================================ */

/** 读取手势功能总开关（面板展示；权威在 Rust settings.json） */
export async function gestureGetEnabled(pluginId: string): Promise<boolean> {
  if (!isTauri) return false;
  return await invoke<boolean>("gesture_get_enabled", { pluginId });
}

/** 写手势功能总开关（面板开关；置位即生效） */
export async function gestureSetEnabled(pluginId: string, enabled: boolean): Promise<void> {
  if (!isTauri) throw new Error("仅桌面端可用");
  await invoke("gesture_set_enabled", { pluginId, enabled: !!enabled });
}

/** 一条手势映射（与 Rust GestureBinding 一一对应） */
export interface GestureBindingIpc {
  /** 方向串（U/D/L/R 组合） */
  pattern: string;
  /** 动作（serde tag = "type"） */
  action: Record<string, unknown>;
  /** 展示名（可空） */
  label: string | null;
}

/** 读取手势映射表（按插件隔离存储在 `plugin-data/<pluginId>/gesture-bindings.json`） */
export async function gestureBindingsList(pluginId: string): Promise<GestureBindingIpc[]> {
  if (!isTauri) return [];
  return await invoke<GestureBindingIpc[]>("gesture_bindings_list", { pluginId });
}

/** 全量覆盖该插件的手势映射表（Rust 网关鉴权 + 清洗 + 落盘 + 即刻生效） */
export async function gestureBindingsSync(
  pluginId: string,
  bindings: GestureBindingIpc[]
): Promise<void> {
  if (!isTauri) throw new Error("仅桌面端可用");
  await invoke("gesture_bindings_sync", { pluginId, bindings });
}

/** 运行中的窗口进程（「呼出程序」动作下拉数据源；与 Rust RunningProcessDto 对应） */
export interface RunningProcessIpc {
  pid: number;
  /** exe 文件名 */
  name: string;
  /** exe 绝对路径（持久化标识） */
  exePath: string;
  /** 窗口标题 */
  title: string;
}

/** 列出当前有可见窗口的运行中进程（按 exe 路径去重） */
export async function gestureListProcesses(pluginId: string): Promise<RunningProcessIpc[]> {
  if (!isTauri) return [];
  return await invoke<RunningProcessIpc[]>("gesture_list_processes", { pluginId });
}

/** 进入画手势录制模式（下一次 Ctrl+右键手势只识别不执行；结果走录制事件） */
export async function gestureRecordStart(pluginId: string): Promise<void> {
  if (!isTauri) throw new Error("仅桌面端可用");
  await invoke("gesture_record_start", { pluginId });
}

/** 退出画手势录制模式 */
export async function gestureRecordCancel(pluginId: string): Promise<void> {
  if (!isTauri) throw new Error("仅桌面端可用");
  await invoke("gesture_record_cancel", { pluginId });
}

/* ============================================================
 * 剪贴板捕获原语（宿主按需监听 + 纯原始记录 + 保留集防淘汰）
 * ============================================================ */

/** 一条原始剪贴板捕获记录（与 Rust `ClipItem` 字段对应） */
export interface ClipboardItemIpc {
  /** 稳定 id（删除/复制/保留集用） */
  id: string;
  /** "text" | "image" */
  kind: string;
  /** 原始文本内容（kind=text） */
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
  /** 是否处于保留集（豁免环形缓冲上限淘汰与默认清空） */
  retained?: boolean;
}

/** 列出插件私有目录中的剪贴板捕获记录（从新到旧）。 */
export async function clipboardHistoryList(
  pluginId: string,
  query?: string
): Promise<ClipboardItemIpc[]> {
  if (!isTauri) return [];
  return await invoke<ClipboardItemIpc[]>("clipboard_history_list", {
    pluginId,
    query: query && query.trim() ? String(query) : null,
  });
}

/** 读回一张剪贴板图片 → data URL（列表缩略图 / 大图预览）。 */
export async function clipboardHistoryReadImage(
  pluginId: string,
  relPath: string
): Promise<string> {
  if (!isTauri) throw new Error("读取剪贴板图片仅在桌面端可用");
  return await invoke<string>("clipboard_history_read_image", {
    pluginId,
    relPath: String(relPath ?? ""),
  });
}

/** 删除一条剪贴板记录（图片连同磁盘文件一起删）。 */
export async function clipboardHistoryDelete(pluginId: string, id: string): Promise<void> {
  if (!isTauri) return;
  await invoke("clipboard_history_delete", { pluginId, id: String(id ?? "") });
}

/**
 * 清空剪贴板记录。
 *
 * - `keepRetained` 为 true（默认）时保留 `retained` 条目及 `retainIds` 指定的条目；
 * - 传 false 则全部清空。
 */
export async function clipboardHistoryClear(
  pluginId: string,
  opts?: { keepRetained?: boolean; retainIds?: string[] }
): Promise<void> {
  if (!isTauri) return;
  await invoke("clipboard_history_clear", {
    pluginId,
    keepRetained: opts?.keepRetained ?? true,
    retainIds: Array.isArray(opts?.retainIds) ? opts.retainIds.map(String) : null,
  });
}

/**
 * 同步该插件需要豁免环形缓冲淘汰的记录 ID 集合（如插件侧收藏或归类的条目）。
 */
export async function clipboardHistorySetRetained(
  pluginId: string,
  ids: string[]
): Promise<void> {
  if (!isTauri) return;
  await invoke("clipboard_history_set_retained", {
    pluginId,
    ids: (ids ?? []).map((id) => String(id)),
  });
}

/**
 * 把某条记录复制回系统剪贴板（文本条目可选传 `textOverride`，供插件编辑后复制）。
 */
export async function clipboardHistoryCopy(
  pluginId: string,
  id: string,
  textOverride?: string
): Promise<void> {
  if (!isTauri) throw new Error("复制到剪贴板仅在桌面端可用");
  await invoke("clipboard_history_copy", {
    pluginId,
    id: String(id ?? ""),
    textOverride: typeof textOverride === "string" ? textOverride : null,
  });
}

/* ============================================================
 * 开发环境（浏览器调试 / Node 单测）的内存镜像表
 * ============================================================ */

/** 无 Tauri 时插件文件存放处（键：`<id>/<相对路径>`） */
export const devFileCache = new Map<string, string>();

/** 无 Tauri 时的网关配置镜像（供调试面板展示） */
export const devGateway = new Map<string, unknown>();

/** 无 Tauri 时的市场包 fixture（键：下载 URL；供端到端测试注入） */
export const devMarketPackages = new Map<string, Uint8Array>();

/** 无 Tauri 时的文件化 KV 镜像（键：`<pluginId>:<key>`） */
export const devKvStore = new Map<string, string>();

/** 无 Tauri 时的云数据 store 镜像（键：`<pluginId>` → 键值对象） */
export const devSyncStore = new Map<string, Record<string, unknown>>();

/** 无 Tauri 时的插件快捷键镜像（键：`<pluginId>:<action>`） */
export const devShortcuts = new Map<string, string>();
