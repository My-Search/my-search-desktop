/**
 * 插件注册表（宿主侧的唯一权威记录）—— 纯逻辑 + localStorage 持久化。
 *
 * 一条记录回答四个问题：
 *   1. **装了什么**：id / 版本 / 清单 / 安装目录 / 来源
 *   2. **要不要跑**：enabled（插件整体开关）+ autoStart（后台进程的启动策略）
 *   3. **能做什么**：grants（已授予权限，Android 式）
 *   4. **现在什么状态**：runtime（由 Rust 侧上报，前端只做展示与调和）
 *
 * 关键设计：**清单里写的 autostart 只是「请求」**，有效策略存在
 * `autoStart` 字段里。插件升级时只更新 requestedAutoStart，绝不覆盖用户的选择——
 * 否则插件能靠发版偷偷把自己设回自启动，用户会失去控制感。
 */

// 显式带 .ts 后缀：本模块被 Node 测试直接 import（见 test/plugin-behavior.test.mjs），
// 而 Node 的 ESM 解析器不做扩展名补全。
import type { PluginAutostart, PluginCloseBehavior, PluginManifest } from "./manifest.ts";
import {
  compareVersion,
  DEFAULT_CLOSE_BEHAVIOR,
  detailViewCloseBehaviorOf,
  diffNewPermissions,
  parsePluginManifest,
} from "./manifest.ts";
import { hasPermission, permissionBaseId, permissionCovers } from "./permissions.ts";

/** 注册表持久化键（与既有缓存键命名风格一致：大写下划线 + _CACHE_KEY） */
export const PLUGIN_REGISTRY_KEY = "PLUGIN_REGISTRY_CACHE_KEY";
/** 插件私有数据的 localStorage 前缀（供无后端插件使用；后端插件用文件存储） */
export const PLUGIN_DATA_PREFIX = "PLUGIN_DATA:";
/** 注册表结构版本（结构变更时用于迁移） */
export const PLUGIN_REGISTRY_VERSION = 1;

/** 后台进程的有效启动策略（用户在面板上的选择） */
export type AutoStartMode = "always" | "on-demand" | "never";

/** 关闭插件界面的有效行为（用户在面板上的选择） */
export type CloseBehavior = "minimize" | "exit";

/** 插件来源 */
export interface PluginSource {
  kind: "builtin" | "market" | "file" | "folder" | "legacy";
  /** 来源描述（下载地址 / 本地路径 / 订阅名） */
  ref?: string;
  /** 是否开发模式（目录直挂，允许热重载） */
  dev?: boolean;
}

/** 一次授权记录 */
export interface PluginGrant {
  /** 权限串原文（含 scope） */
  permission: string;
  at: number;
  /** 授权来源：安装确认 / 运行时弹窗 / 设置面板 */
  source: "install" | "prompt" | "settings";
}

/** 运行态（由 Rust 上报） */
export type PluginStatus =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "crashed"
  | "error"
  | "unavailable";

/** 运行态详情 */
export interface PluginRuntimeState {
  status: PluginStatus;
  pid: number | null;
  /** 进程占用内存（字节，取不到时为 null） */
  memoryBytes: number | null;
  startedAt: number | null;
  restarts: number;
  lastError: string | null;
  /** 常驻原因（如「注册了全局快捷键 Ctrl+Alt+T」），面板上回答「它凭什么还在跑」 */
  keepAliveReasons: string[];
}

/** 插件记录 */
export interface PluginRecord {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  author?: string;
  description?: string;
  homepage?: string;
  description_?: never;
  icon?: string;
  /** 完整清单（含 contributes / backend） */
  manifest: PluginManifest;
  /** 安装目录（绝对路径；legacy 类型为空字符串） */
  dir: string;
  source: PluginSource;
  installedAt: number;
  updatedAt: number;
  /** 插件总开关（关闭 = 不加载视图、不提供搜索项、后台进程停止） */
  enabled: boolean;
  /** 用户在面板上选择的后台启动策略 */
  autoStart: AutoStartMode;
  /** 清单里请求的策略（只做展示与首次默认值） */
  requestedAutoStart: PluginAutostart;
  /** 用户在面板上选择的「关闭插件界面时」行为 */
  closeBehavior: CloseBehavior;
  /** 已授予权限 */
  grants: PluginGrant[];
  /** 被拒绝过的权限（面板上展示「曾拒绝」，避免反复打扰） */
  denied: string[];
  runtime: PluginRuntimeState;
  /** 完整性：安装时的包摘要（legacy/内置为 null） */
  integrity: { sha256: string | null; signed: boolean };
  /** 待授权的权限请求（运行时被拒时登记，面板可一键授予） */
  pendingPermission?: string | null;
  /** legacy 脚本项的引用信息（仅 source.kind === "legacy"） */
  legacyRef?: { title: string; subscribe: string };
  /** 更新检查：市场里的最新版本（由市场模块写入） */
  updateAvailable?: string | null;
}

export interface PluginRegistryFile {
  version: number;
  plugins: PluginRecord[];
}

/** 空运行态 */
export function emptyRuntime(): PluginRuntimeState {
  return {
    status: "stopped",
    pid: null,
    memoryBytes: null,
    startedAt: null,
    restarts: 0,
    lastError: null,
    keepAliveReasons: [],
  };
}

/** 清单请求 → 有效策略的默认落点（prompt 在用户表态前按「仅前台运行」处理） */
export function defaultAutoStartFrom(requested: PluginAutostart): AutoStartMode {
  switch (requested) {
    case "never":
      return "never";
    case "always":
    case "prompt":
    case "on-demand":
    default:
      return "always";
  }
}

/** 清单请求 → 「关闭界面时」的默认落点（缺省/非法一律最小化，保持老插件行为不变） */
export function defaultCloseBehaviorFrom(requested: PluginCloseBehavior | undefined | null): CloseBehavior {
  return requested === "exit" ? "exit" : DEFAULT_CLOSE_BEHAVIOR;
}

/** 插件在清单里给出的两个行为建议（面板上展示「插件建议」与「恢复默认」用） */
export interface BehaviorSuggestion {
  /** 建议的后台启动策略（`prompt` 已折叠为 on-demand，另见 fromPrompt） */
  autoStart: AutoStartMode;
  /** 清单声明的是 prompt：作者希望**由用户决定**，面板上不要显示成「插件建议开机自启」 */
  fromPrompt: boolean;
  /** 建议的「关闭界面时」行为 */
  closeBehavior: CloseBehavior;
}

/**
 * 取插件声明的行为建议。
 *
 * 与 `gatewaySpecOf` 的区别：这里只回答「插件想要什么」，不掺用户在面板上
 * 已经改成的值——面板靠两者对比来显示「已修改」与「恢复默认」。
 *
 * `closeBehavior` 的口径统一走 `detailViewCloseBehaviorOf`（detailView 优先、
 * backend 兜底、再兜默认值），因此带后台进程与纯前端插件在面板上的建议一致。
 */
export function behaviorSuggestionOf(manifest: PluginManifest | null | undefined): BehaviorSuggestion {
  const backend = manifest?.backend;
  const requested = backend?.autostart ?? "on-demand";
  return {
    autoStart: defaultAutoStartFrom(requested),
    fromPrompt: requested === "prompt",
    closeBehavior: detailViewCloseBehaviorOf(manifest),
  };
}

/**
 * 关闭插件界面时，是否应立即停止它的后台进程。
 *
 * 三个条件缺一不可：
 *   1. 该插件确实有后台进程（纯前端插件没什么可停的）；
 *   2. 用户把「关闭界面时」设成了 `exit`；
 *   3. 没有设为开机自启——`always` 的语义是「常驻后台」，与「随界面退出」冲突，
 *      此时以开机自启为准（面板上该控件会置灰并说明原因）。
 */
export function shouldStopBackendOnClose(rec: PluginRecord | null | undefined): boolean {
  if (!rec) return false;
  if (!rec.manifest?.backend) return false;
  if (rec.autoStart === "always") return false;
  return rec.closeBehavior === "exit";
}

/**
 * 关闭插件界面时，是否应**保留**插件前端的会话（DOM + 脚本内存态）。
 *
 * 与 `shouldStopBackendOnClose` 是同一个开关的两面：
 *   - `minimize` → 保活前端（关闭界面只是「最小化」，再打开是恢复而不是重新加载）；
 *   - `exit`     → 卸载前端（下次打开重新读入口文件并重新执行脚本）。
 *
 * 注意与后台进程的判定**不同源**：这里的依据是用户在面板上选的
 * `rec.closeBehavior`（默认 minimize），不受「开机自启」影响——开机自启说的是
 * 进程常驻，与「界面要不要保留」无关；`exit` 时前端必定卸载（哪怕进程因
 * 开机自启而继续运行），这样「退出」这个词对用户始终成立。
 *
 * 没有 `detailView` 的插件没有界面会话可保留，恒为 false。
 */
export function shouldKeepFrontendOnClose(rec: PluginRecord | null | undefined): boolean {
  if (!rec) return false;
  if (!rec.manifest?.contributes?.detailView) return false;
  return rec.closeBehavior !== "exit";
}

/** 创建一条插件记录（安装/开发挂载/legacy 投影共用） */
export function createPluginRecord(input: {
  manifest: PluginManifest;
  dir: string;
  source: PluginSource;
  grants?: string[];
  runtime?: PluginRuntimeState;
  integrity?: { sha256: string | null; signed: boolean };
  now?: number;
}): PluginRecord {
  const now = input.now ?? Date.now();
  const requested = input.manifest.backend?.autostart ?? "on-demand";
  return {
    id: input.manifest.id,
    name: input.manifest.name,
    version: input.manifest.version,
    apiVersion: input.manifest.apiVersion,
    author: input.manifest.author,
    description: input.manifest.description,
    homepage: input.manifest.homepage,
    icon: input.manifest.icon,
    manifest: input.manifest,
    dir: input.dir,
    source: input.source,
    installedAt: now,
    updatedAt: now,
    enabled: true,
    autoStart: defaultAutoStartFrom(requested),
    requestedAutoStart: requested,
    // 首次安装落在插件建议值上；此后升级不覆盖（见 upsertPlugin 的保留列表）。
    // 建议值统一由 detailViewCloseBehaviorOf 计算：纯前端插件也能用
    // `contributes.detailView.closeBehavior` 表达「关闭界面时是否保留界面」。
    closeBehavior: detailViewCloseBehaviorOf(input.manifest),
    grants: (input.grants ?? []).map((permission) => ({ permission, at: now, source: "install" as const })),
    denied: [],
    runtime: input.runtime ?? emptyRuntime(),
    integrity: input.integrity ?? { sha256: null, signed: false },
  };
}

/**
 * 补齐记录里缺失的字段（结构演进时的就地迁移）。
 *
 * 目前只处理 `closeBehavior`：它是后加的字段，升级前装的插件记录里没有。
 * 补的是**插件建议值**（等价于「这个字段早就有，只是当时没存」），
 * 已有值一律不动——用户的选择优先于任何迁移。
 */
function hydrateRecord(rec: PluginRecord): PluginRecord {
  if (rec.closeBehavior === "minimize" || rec.closeBehavior === "exit") return rec;
  return { ...rec, closeBehavior: behaviorSuggestionOf(rec.manifest).closeBehavior };
}

/** 读取注册表（结构损坏时返回空表，不影响主流程） */
export function loadRegistry(): PluginRegistryFile {
  try {
    const raw = localStorage.getItem("my-search-desktop:" + PLUGIN_REGISTRY_KEY);
    if (!raw) return { version: PLUGIN_REGISTRY_VERSION, plugins: [] };
    const parsed = JSON.parse(raw) as PluginRegistryFile;
    if (!parsed || !Array.isArray(parsed.plugins)) {
      return { version: PLUGIN_REGISTRY_VERSION, plugins: [] };
    }
    return {
      version: PLUGIN_REGISTRY_VERSION,
      plugins: parsed.plugins.filter((p) => p && typeof p.id === "string").map(hydrateRecord),
    };
  } catch (e) {
    console.warn("插件注册表读取失败（按空表处理）:", e);
    return { version: PLUGIN_REGISTRY_VERSION, plugins: [] };
  }
}

/** 写入注册表 */
export function saveRegistry(reg: PluginRegistryFile): void {
  try {
    localStorage.setItem("my-search-desktop:" + PLUGIN_REGISTRY_KEY, JSON.stringify(reg));
  } catch (e) {
    console.warn("插件注册表写入失败:", e);
  }
}

/** 按 id 取记录 */
export function findPlugin(reg: PluginRegistryFile, id: string): PluginRecord | undefined {
  return reg.plugins.find((p) => p.id === id);
}

/** 新增或替换记录（保留用户态字段：enabled / autoStart / closeBehavior / grants / denied） */
export function upsertPlugin(
  reg: PluginRegistryFile,
  incoming: PluginRecord,
  opts: { preserveUserChoices?: boolean } = {}
): PluginRecord {
  const idx = reg.plugins.findIndex((p) => p.id === incoming.id);
  if (idx < 0) {
    reg.plugins.push(incoming);
    return incoming;
  }
  const prev = reg.plugins[idx];
  const merged: PluginRecord = {
    ...incoming,
    installedAt: prev.installedAt,
    updatedAt: Date.now(),
    enabled: opts.preserveUserChoices === false ? incoming.enabled : prev.enabled,
    autoStart: opts.preserveUserChoices === false ? incoming.autoStart : prev.autoStart,
    // 用户改过的关闭行为同样不随插件升级被覆盖（与 autoStart 同理：
    // 否则插件能靠发版把自己设回「关闭即退出」，用户失去控制感）。
    // `?? incoming` 是给「升级前装的记录」（没有该字段）兜底——`loadRegistry`
    // 会补，但 upsert 也可能被别处直接用未 hydrate 的记录调用，合并结果
    // 必须保证字段存在（否则面板读到 undefined、判定函数一律不动作）。
    closeBehavior:
      opts.preserveUserChoices === false
        ? incoming.closeBehavior
        : prev.closeBehavior ?? incoming.closeBehavior,
    grants: mergeGrants(prev.grants, incoming.grants),
    denied: prev.denied,
    pendingPermission: prev.pendingPermission ?? null,
    legacyRef: prev.legacyRef,
    updateAvailable: null,
  };
  reg.plugins[idx] = merged;
  return merged;
}

/** 合并授权：同一权限取较早的时间（不刷新用户当初的授权时间） */
function mergeGrants(a: PluginGrant[], b: PluginGrant[]): PluginGrant[] {
  const map = new Map<string, PluginGrant>();
  for (const g of [...a, ...b]) {
    const existing = map.get(g.permission);
    if (!existing || g.at < existing.at) map.set(g.permission, g);
  }
  return [...map.values()];
}

/** 移除记录 */
export function removePlugin(reg: PluginRegistryFile, id: string): boolean {
  const before = reg.plugins.length;
  reg.plugins = reg.plugins.filter((p) => p.id !== id);
  return reg.plugins.length !== before;
}

/** 已启用且需要加载的插件（legacy 走另一条路径，不在这里返回） */
export function activePlugins(reg: PluginRegistryFile): PluginRecord[] {
  return reg.plugins.filter((p) => p.enabled && p.source.kind !== "legacy");
}

/* ============================================================
 * 权限授予 / 撤销 / 查询
 * ============================================================ */

/** 是否已授予某项权限（支持 scope 覆盖） */
export function isGranted(record: PluginRecord, request: string): boolean {
  return hasPermission(
    record.grants.map((g) => g.permission),
    request
  );
}

/** 授予权限（已覆盖则不重复记录） */
export function grantPermission(
  record: PluginRecord,
  permission: string,
  source: PluginGrant["source"] = "settings"
): boolean {
  if (isGranted(record, permission)) return false;
  record.grants.push({ permission, at: Date.now(), source });
  record.denied = record.denied.filter((p) => p !== permission);
  if (record.pendingPermission && permissionCovers(permission, record.pendingPermission)) {
    record.pendingPermission = null;
  }
  return true;
}

/** 撤销权限（同时清空同基础 id 的所有 scope；并重新登记为待授权以便重新弹出） */
export function revokePermission(record: PluginRecord, permission: string): boolean {
  const base = permissionBaseId(permission);
  const before = record.grants.length;
  record.grants = record.grants.filter((g) => permissionBaseId(g.permission) !== base);
  if (record.grants.length === before) return false;
  // 撤销后，清单里声明的同基础权限回归「待授权」状态
  const declared = [...(record.manifest.permissions ?? []), ...(record.manifest.optionalPermissions ?? [])];
  const next = declared.find((p) => permissionBaseId(p) === base);
  if (next) record.pendingPermission = next;
  return true;
}

/** 撤销某插件的全部权限（禁用插件时使用，可保留必要的最小集） */
export function revokeAllPermissions(record: PluginRecord): void {
  record.grants = [];
  const declared = [...(record.manifest.permissions ?? [])];
  record.pendingPermission = declared[0] ?? null;
}

/** 登记一次「被拒绝」（面板展示，避免同一权限反复打扰） */
export function markDenied(record: PluginRecord, permission: string): void {
  if (!record.denied.includes(permission)) record.denied.push(permission);
  record.pendingPermission = null;
}

/* ============================================================
 * 升级
 * ============================================================ */

export interface UpgradePlan {
  ok: boolean;
  /** 是否确实需要升级 */
  upgrade: boolean;
  from: string;
  to: string;
  /** 新增的必需权限（必须重新确认） */
  newPermissions: string[];
  /** 新增的可选权限（面板提示，可稍后授予） */
  newOptional: string[];
  /** 错误：降级 / 同版本 / 身份不符 */
  error?: string;
}

/**
 * 计算升级计划。规则：
 *   - 版本相同 → 视为重装（upgrade=false，但仍然替换文件）
 *   - 版本更低 → 拒绝（不允许静默降级，需先卸载）
 *   - 新增必需权限 → 必须重新确认，否则插件保持 disabled
 */
export function planUpgrade(prev: PluginRecord, next: PluginManifest): UpgradePlan {
  const cmp = compareVersion(next.version, prev.version);
  if (cmp < 0) {
    return {
      ok: false,
      upgrade: false,
      from: prev.version,
      to: next.version,
      newPermissions: [],
      newOptional: [],
      error: "不允许降级安装，请先卸载后再安装旧版本",
    };
  }
  const granted = prev.grants.map((g) => g.permission);
  const newPermissions = diffNewPermissions(granted, next, permissionCovers);
  const newOptional = (next.optionalPermissions ?? []).filter(
    (req) => !granted.some((g) => permissionCovers(g, req))
  );
  return {
    ok: true,
    upgrade: cmp > 0,
    from: prev.version,
    to: next.version,
    newPermissions,
    newOptional,
  };
}

/** 从 JSON 恢复清单（读安装目录里的 plugin.json 时用） */
export function manifestFromJson(json: string): PluginManifest | null {
  const r = parsePluginManifest(json);
  return r.ok ? r.manifest : null;
}

/* ============================================================
 * 插件私有数据（无后端插件用；后端插件用文件存储）
 * ============================================================ */

/** 插件私有存储读写（命名空间隔离，插件访问不到宿主键） */
export function pluginDataGet<T>(pluginId: string, key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem("my-search-desktop:" + PLUGIN_DATA_PREFIX + pluginId + ":" + key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch (e) {
    return fallback;
  }
}

export function pluginDataSet(pluginId: string, key: string, value: unknown): void {
  try {
    localStorage.setItem(
      "my-search-desktop:" + PLUGIN_DATA_PREFIX + pluginId + ":" + key,
      JSON.stringify(value)
    );
  } catch (e) {
    console.warn("插件数据写入失败:", e);
  }
}

export function pluginDataRemove(pluginId: string, key: string): void {
  try {
    localStorage.removeItem("my-search-desktop:" + PLUGIN_DATA_PREFIX + pluginId + ":" + key);
  } catch (e) {
    /* ignore */
  }
}

/** 清空某插件的全部私有数据（卸载时调用） */
export function pluginDataClear(pluginId: string): number {
  const prefix = "my-search-desktop:" + PLUGIN_DATA_PREFIX + pluginId + ":";
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(prefix)) keys.push(k);
  }
  for (const k of keys) localStorage.removeItem(k);
  return keys.length;
}

/** 该插件是否需要后台进程 */
export function hasBackend(record: PluginRecord): boolean {
  return record.manifest.backend != null;
}

/** 该插件是否已授予「运行本机程序」权限 */
export function canSpawnBackend(record: PluginRecord): boolean {
  if (!hasBackend(record)) return false;
  return record.grants.some((g) => permissionBaseId(g.permission) === "backend.spawn");
}
