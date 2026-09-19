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

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../tauri-bridge.ts";

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

/** 弹出系统文件选择框（选择 .msplugin 包） */
export async function pickPluginPackage(): Promise<string | null> {
  if (!isTauri) return null;
  try {
    const pkg: any = await import("@tauri-apps/plugin-dialog");
    const picked = await pkg.open({
      multiple: false,
      title: "选择插件安装包",
      filters: [{ name: "插件包", extensions: ["msplugin", "zip"] }],
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

/** 同步网关配置（权限表 / 启用态 / 自启策略 / 进程规格）—— RPC 供插件调用用 */
export async function syncGateway(payload: {
  pluginId: string;
  enabled: boolean;
  autoStart: string;
  grants: string[];
  backendEntry: string | null;
  backendProtocol: string | null;
  idleExitSec: number;
  graceSec: number;
  maxRestarts: number;
  startupTimeoutMs: number;
  callTimeoutMs: number;
}): Promise<void> {
  if (!isTauri) {
    devGateway.set(payload.pluginId, payload);
    return;
  }
  // Tauri v2: 当 Rust 命令参数是结构体时（spec: GatewaySpec），
  // JS 侧必须以参数名为 key 包装：{ spec: { ... } }
  await invoke("plugin_gateway_sync", { spec: payload });
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
 * 开发环境（浏览器调试）的内存文件表
 * ============================================================ */

/** 无 Tauri 时插件文件存放处（键：`<id>/<相对路径>`） */
export const devFileCache = new Map<string, string>();

/** 无 Tauri 时的网关配置镜像（供调试面板展示） */
export const devGateway = new Map<string, unknown>();
