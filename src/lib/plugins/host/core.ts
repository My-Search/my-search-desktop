/**
 * 宿主 API 网关核心（错误类型、权限校验执行器、表驱动 RPC 构造器、审计日志）。
 *
 * 设计目标：
 *   1. 将散落在超长单文件中的「可用性检查 → 权限判定 → 审计记录 → 异常归档」收敛为统一管线；
 *   2. 提供声明式 `defineRpcNamespace`，让各能力模块以数据表声明 `{ permission, detail, handler }`，
 *      消除手写样板与 `PluginHostContext` 中的数十个透传回调；
 *   3. `PluginHostContext` 仅保留真正与宿主窗口 UI 强相关的少量钩子。
 */

import type { SearchItem } from "../../../types/index.ts";
import { storageGet } from "../../util.ts";
import {
  isKnownPermission,
  type PermissionGroupBlock,
} from "../permissions.ts";
import type { PluginManifest } from "../manifest.ts";
import type { PluginRecord, PluginRegistryFile } from "../registry.ts";
import {
  isGranted,
  markDenied,
  pluginDataGet,
} from "../registry.ts";
import type { AttachedEntry } from "../attachments.ts";

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

/**
 * 一次「安装确认」请求（市场安装/更新用）。
 */
export interface PluginInstallConfirmRequest {
  manifest: PluginManifest;
  iconUrl: string | null;
  permBlocks: PermissionGroupBlock[];
  warnings: string[];
  installedVersion: string | null;
  action: "install" | "update";
  running?: boolean;
  /** 本次升级的更新日志（市场目录里「本版本」的 changelog；用于安装确认弹窗） */
  changelog?: string;
  /** 安装确认框中「自动更新该插件」开关的初始值（仅市场源传入） */
  autoUpdate?: boolean;
  /** 用户在安装确认框中切换「自动更新该插件」开关时同步回写 */
  onAutoUpdateChange?: (enabled: boolean) => void;
}

/**
 * 暴露给插件的同步状态（`ms.sync.status()` / `ms.sync.trigger()` 的返回）。
 */
export interface PluginSyncState {
  enabled: boolean;
  status: "idle" | "syncing" | "uploading" | "downloading" | "error";
  lastSyncAt: number;
  lastError: string;
}

/**
 * 宿主为插件注入的运行上下文（精简后仅保留窗口/界面交互钩子；
 * 截图、剪贴板、手势、存储、快捷键等原生能力一律由网关模块直连 IPC 表驱动分派）。
 */
/** 批量权限申请的结果（`ms.permissions.request` 原样返回给插件） */
export interface PermissionRequestOutcome {
  /** 至少有一项权限在本次调用后处于已授予状态 */
  ok: boolean;
  granted: string[];
  denied: string[];
  /** 24h 内申请次数超限、本次未弹窗的权限 */
  throttled: string[];
  /** 申请本身不合法时的可读原因（未知/未声明/超量/空） */
  error?: string;
}

/** `ms.ui.subInput.set()` 的选项（等价 uTools `setSubInput`） */
export interface PluginSubInputOptions {
  placeholder?: string;
  /** 指定初始值（仅在 set 时显式传入才覆盖用户正在输入的内容） */
  value?: string;
  /** false = 隐藏但保留状态（默认 true） */
  visible?: boolean;
  /** 设置后立即聚焦 */
  focus?: boolean;
  /** 输入变化回调（宿主每次 input 都调用；跨插件视图与宿主同一 JS 域） */
  onChange?: (value: string) => void;
}

export interface PluginHostContext {
  /** 当前注册表 */
  registry: () => PluginRegistryFile;
  /** 持久化注册表 */
  persistRegistry: () => void;
  /** 搜索库的只读副本 */
  searchData: () => readonly SearchItem[];
  /** 触发一次搜索 */
  triggerSearch: (keyword: string) => void;
  /** 改写搜索框内容（不触发搜索） */
  setInput: (text: string) => void;
  /**
   * 聚焦宿主搜索框并把光标移到末尾（`ms.search.focusInput` 用）。
   *
   * 供「呼出类」插件动作（`contributes.shortcut` → `ms.shortcuts.onAction`）用：
   * 快捷键打开插件视图后，把输入焦点交还给搜索框，让用户直接输入子关键词
   * 回车（如「文件搜索 : 报告」）。只在主搜索窗口有实现；独立插件窗口等
   * 没有宿主搜索框的场合不注入，调用会得到明确报错。
   */
  focusSearchInput?: () => void;
  /** 收起详情视图回到结果列表 */
  hideDetail: () => void;
  /** 应用内提示 */
  toast: (text: string, type?: "ok" | "error") => void;
  /** 应用内确认框 */
  confirm: (text: string) => Promise<boolean>;
  /** 读取系统选中文本 */
  getSelectedText: (hint?: string) => Promise<string>;
  /** 自定义打开插件独立窗口（缺省时走宿主内置 `pluginOpenWindow` IPC） */
  openPluginWindow?: (
    pluginId: string,
    entry: string,
    title: string,
    opts?: { width?: number; height?: number; alwaysOnTop?: boolean; isolated?: boolean }
  ) => Promise<string | boolean> | void;
  /** 市场安装/更新前的用户确认弹窗（未注入时 fail-closed 拒绝安装） */
  confirmPluginInstall?: (req: PluginInstallConfirmRequest) => Promise<boolean>;
  /** 面板里请求授权 */
  requestPermission?: (pluginId: string, permission: string) => Promise<boolean>;
  /** 当前附加在搜索框里的文件/文件夹 */
  getAttachments?: () => readonly AttachedEntry[];
  /**
   * 把**用户刚在系统对话框里挑中的**文件夹并入搜索框附件（`ms.input.pickFolders` 用）。
   *
   * 为什么不是任意 `attach(paths)`：附件集合就是 `file.read` 的信任边界
   * （Rust 侧只放行附加集合内的路径）。把「加附件」开放给插件等于把
   * `file.read` 升级成全盘读——因此这里只接受「选择文件夹对话框」的产物，
   * 由 App.vue 注入实现（走与粘贴/拖入完全相同的 attachByPaths 管线）。
   * 返回实际并入的条目（描述失败 / 已存在的会被过滤或去重）。
   */
  attachPaths?: (paths: string[]) => Promise<AttachedEntry[]>;
  /** 按路径从搜索框附件里移除一项（`ms.input.detach` 用；只减不加，无扩权风险） */
  detachPath?: (path: string) => Promise<boolean>;
  /** 请求宿主重新求解并应用一次插件主题 */
  refreshPluginTheme?: () => void;
  /** 发起一次云端数据同步 */
  syncNow?: () => Promise<PluginSyncState>;
  /** 读取云端同步状态 */
  syncStatus?: () => PluginSyncState;
  /** 更新内嵌视图高度 */
  setViewHeight?: (px: number) => void;
  /** 写插件日志 */
  log?: (pluginId: string, level: "info" | "warn" | "error", text: string) => void;
  /** 读取受控密钥 */
  getSecret?: (pluginId: string, name: string) => Promise<string | null>;
  /** 写入（覆盖）受控密钥（DPAPI / 插件命名空间；空值等同删除） */
  setSecret?: (pluginId: string, name: string, value: string) => Promise<boolean>;
  /** 删除受控密钥（返回是否真的删掉了） */
  deleteSecret?: (pluginId: string, name: string) => Promise<boolean>;
  /** 列出该插件已保存的密钥名字（不含值） */
  listSecrets?: (pluginId: string) => Promise<string[]>;
  /**
   * 宿主子输入框（`ms.ui.subInput`）：在插件视图上方渲染一个宿主输入框，
   * 让插件做「列表筛选 / 二次检索」时不必自己画一个和宿主风格割裂的输入框。
   * 返回是否成功（会话不在前台/停靠中找不到时为 false）。
   */
  subInput?: (
    pluginId: string,
    action: "set" | "remove" | "focus",
    options?: PluginSubInputOptions
  ) => boolean;
  /**
   * 批量权限申请（`ms.permissions.request`）：宿主弹**一次**分组确认框，
   * 返回哪些已授予 / 被拒绝 / 被限流。频率限制与「只能申请清单声明过的权限」
   * 由宿主实现（见 `permission-requests.ts`）。
   */
  requestPermissions?: (
    pluginId: string,
    apis: string[],
    reason?: string
  ) => Promise<PermissionRequestOutcome>;
  /** 调用插件后台进程方法 */
  callBackend?: (pluginId: string, method: string, params: unknown) => Promise<unknown>;
  /** 打开宿主的「选择环境变量」授权弹层 */
  pickEnvVar?: (
    pluginId: string,
    opts: { title?: string; purpose?: string }
  ) => Promise<{ kind: "ref"; name: string; ref: string } | { kind: "literal"; value: string } | null>;
}

/** 一次调用的审计记录（环形缓冲，面板「权限与调用记录」页签展示） */
export interface AuditEntry {
  at: number;
  pluginId: string;
  api: string;
  detail?: string;
  result: "ok" | "denied" | "error";
  message?: string;
}

const AUDIT_LIMIT = 500;

/** 全局审计缓冲（进程内环形队列） */
export const auditLog: AuditEntry[] = [];

export function pushAudit(entry: AuditEntry): void {
  auditLog.push(entry);
  if (auditLog.length > AUDIT_LIMIT) {
    auditLog.splice(0, auditLog.length - AUDIT_LIMIT);
  }
}

export type CallRunner = <T>(opts: {
  api: string;
  permission?: string;
  detail?: string;
  run: (record: PluginRecord) => T | Promise<T>;
}) => T | Promise<T>;

/** 为指定插件构造统一的鉴权+审计调用器 */
export function createCallRunner(pluginId: string, ctx: PluginHostContext): {
  record: () => PluginRecord | undefined;
  call: CallRunner;
} {
  const record = (): PluginRecord | undefined =>
    ctx.registry().plugins.find((p) => p.id === pluginId);

  const call: CallRunner = <T>(opts: {
    api: string;
    permission?: string;
    detail?: string;
    run: (record: PluginRecord) => T | Promise<T>;
  }): T | Promise<T> => {
    const rec = record();
    if (!rec || !rec.enabled) {
      pushAudit({
        at: Date.now(),
        pluginId,
        api: opts.api,
        result: "denied",
        message: "插件不可用",
      });
      throw new PluginUnavailableError(pluginId);
    }
    if (opts.permission && !isGranted(rec, opts.permission)) {
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
  };

  return { record, call };
}

/** 表驱动 RPC 单项定义 */
export interface RpcMethodSpec<Args extends any[] = any[], Out = any> {
  /** 所需权限串（或从调用参数动态推导，如 scoped 权限） */
  permission?: string | ((...args: Args) => string | undefined);
  /** 审计摘要生成函数 */
  detail?: (...args: Args) => string | undefined;
  /** 实际处理函数（已通过启用态与第一道权限门禁） */
  handler: (
    env: { pluginId: string; record: PluginRecord },
    ...args: Args
  ) => Out | Promise<Out>;
}

/**
 * 根据声明式规格表生成命名空间对象。
 *
 * 每个表项自动接入 `call()` 的「启用态校验 → 权限门禁 → 审计日志」管线。
 */
export function defineRpcNamespace<S extends Record<string, RpcMethodSpec>>(
  namespace: string,
  pluginId: string,
  call: CallRunner,
  specs: S,
  extras: Record<string, unknown> = {}
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...extras };
  for (const [methodName, spec] of Object.entries(specs)) {
    out[methodName] = (...args: unknown[]) => {
      const perm =
        typeof spec.permission === "function"
          ? spec.permission(...args)
          : spec.permission;
      const detail = spec.detail ? spec.detail(...args) : undefined;
      return call({
        api: `${namespace}.${methodName}`,
        permission: perm,
        detail,
        run: (record) => spec.handler({ pluginId, record }, ...args),
      });
    };
  }
  return out;
}

export function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** 记录一次「用户拒绝」（面板展示，供后续补授） */
export function recordDenied(pluginId: string, permission: string, ctx: PluginHostContext): void {
  const reg = ctx.registry();
  const rec = reg.plugins.find((p) => p.id === pluginId);
  if (!rec) return;
  markDenied(rec, permission);
  ctx.persistRegistry();
}

/** 追加一条拒绝审计（插件视图宿主在捕获到异常时调用） */
export function auditDenied(
  pluginId: string,
  api: string,
  permission: string,
  message?: string
): void {
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

/** 读取一个未被插件写入过的键时用的默认值（与老脚本 cache.get 语义一致） */
export function pluginCacheGet<T>(
  pluginId: string,
  key: string,
  fallback: T = null as unknown as T
): T {
  return storageGet("PLUGIN_DATA:" + pluginId + ":" + key, fallback);
}
