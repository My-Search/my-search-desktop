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
import type {
  PluginAutostart,
  PluginCloseBehavior,
  PluginManifest,
  PluginThemePreference,
} from "./manifest.ts";
import {
  compareVersion,
  DEFAULT_CLOSE_BEHAVIOR,
  DEFAULT_PLUGIN_AUTO_UPDATE,
  DEFAULT_PLUGIN_AUTOSTART,
  DEFAULT_PLUGIN_THEME,
  detailViewCloseBehaviorOf,
  detailViewThemeOf,
  diffNewPermissions,
  manifestAutoUpdateOf,
  parsePluginManifest,
} from "./manifest.ts";
import { hasPermission, permissionBaseId, permissionCovers } from "./permissions.ts";
import type { PluginPermissionRequest } from "./permission-requests.ts";
import { storageRemove, storageSet } from "../util.ts";

/** 注册表持久化键（与既有缓存键命名风格一致：大写下划线 + _CACHE_KEY） */
export const PLUGIN_REGISTRY_KEY = "PLUGIN_REGISTRY_CACHE_KEY";
/** 同窗口内注册表变更自定义事件名 */
export const REGISTRY_CHANGED_DOM_EVENT = "ms-plugin-registry-changed";
/** 插件私有数据的 localStorage 前缀（供无后端插件使用；后端插件用文件存储） */
export const PLUGIN_DATA_PREFIX = "PLUGIN_DATA:";
/** 注册表结构版本（结构变更时用于迁移） */
export const PLUGIN_REGISTRY_VERSION = 1;

/** 后台进程的有效启动策略（用户在面板上的选择） */
export type AutoStartMode = "always" | "on-demand" | "never";

/** 关闭插件界面的有效行为（用户在面板上的选择） */
export type CloseBehavior = "minimize" | "exit";

/** 插件界面主题的有效偏好（用户在面板上的选择，默认跟随插件声明） */
export type PluginThemeChoice = PluginThemePreference;

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
  /** 插件官方仓库地址（清单 repository 字段；面板与 repository 合并为一条「首页」，缺失时退回 homepage） */
  repository?: string;
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
  /**
   * 用户在面板上选择的「界面主题」偏好（dark / light / inherit）。
   *
   * 首次安装落在清单的建议值（`contributes.detailView.theme`）上，之后升级不覆盖；
   * 打开插件视图时宿主据此把整个呼出窗口临时切到该主题。插件运行时也可以
   * 用 `ms.ui.registerThemeProvider()` 上报自己的选择（如 pi-agent 左下角切换），
   * 运行时值优先于这里的持久偏好。
   */
  themePreference: PluginThemePreference;
  /**
   * 用户选择的「是否自动更新该插件」（仅 `market` / `builtin` 来源生效）。
   *
   * 首次安装按清单 `manifest.autoUpdate`（未声明默认 `false`）初始化，用户在安装弹窗
   * 或插件面板中修改后持久化在此，后续升级保留用户选择。
   */
  autoUpdate: boolean;
  /** 已授予权限 */
  grants: PluginGrant[];
  /** 被拒绝过的权限（面板上展示「曾拒绝」，避免反复打扰） */
  denied: string[];
  runtime: PluginRuntimeState;
  /** 完整性：安装时的包摘要（legacy/内置为 null） */
  integrity: { sha256: string | null; signed: boolean };
  /**
   * 内置插件安装时的**内容指纹**（由 `.mspp` 包内容算出，与 zip 时间戳无关）。
   *
   * 为什么需要它：内置插件的引导逻辑只判「是否已安装」，装过就永远跳过——
   * 于是随应用升级更新的内置插件（改了界面 CSS/JS）在**已装用户**身上永远
   * 不生效（`plugins/<id>/` 落盘副本是旧的），表现为「源码改好了、页面照旧」。
   * 有了指纹，启动时可对比「随版本分发的内容」与「上次装的内容」，
   * 不一致就静默重装（用户态 enabled/autoStart/closeBehavior/授权一律保留）。
   * 仅内置插件会写这个字段。
   */
  builtinFingerprint?: string | null;
  /** 待授权的权限请求（运行时被拒时登记，面板可一键授予） */
  pendingPermission?: string | null;
  /**
   * 运行时注册的命令（`ms.commands.register`）。
   *
   * 与清单 `contributes.command` 的关系：清单是「安装即生效」的声明，
   * 这里是「运行时才确定」的命令（如按同步下来的仓库列表动态生成）。
   * 两者按 `id` 合并，运行时优先；**必须落盘**，否则重启后命令消失，
   * 搜索入口与插件实际能力就不一致了。
   */
  runtimeCommands?: RuntimeCommand[] | null;
  /**
   * 权限申请历史（`ms.permissions.request` 每次尝试都记一条）。
   *
   * 用途有二：24h 频率限制的计数依据；面板「申请历史」的展示来源。
   * 只保留最近 50 条（见 permission-requests.ts），不会无限增长。
   */
  permissionRequests?: PluginPermissionRequest[] | null;
  /** legacy 脚本项的引用信息（仅 source.kind === "legacy"） */
  legacyRef?: { title: string; subscribe: string };
  /** 更新检查：市场里的最新版本（由市场模块写入） */
  updateAvailable?: string | null;
  /**
   * 自动更新被「高危新增权限」拦下时留下的待确认记录。
   *
   * 背景：`autoUpdate` 的语义是「静默升级」，但静默授予 `backend.spawn`
   * 这类 critical 权限等于让插件靠发版给自己提权。因此自动更新遇到这类
   * 新增权限时**不落盘**，只登记本字段；用户确认后再走常规安装确认链路。
   * 常规安装/更新提交成功时由 `upsertPlugin` 清空。
   */
  pendingUpgrade?: PendingUpgrade | null;
}

/** 自动更新待确认的升级（见 `PluginRecord.pendingUpgrade`） */
export interface PendingUpgrade {
  /** 新版本号 */
  version: string;
  /** 包地址（用户确认后按此下载；不复用旧包，避免确认的是 A、装的是 B） */
  downloadUrl: string;
  /** 包摘要（确认后仍要复核） */
  sha256: string;
  /** 需要用户逐条确认的新增权限（critical / scope 全通配） */
  blockedPermissions: string[];
  /** 登记时间 */
  at: number;
}

export interface PluginRegistryFile {
  version: number;
  plugins: PluginRecord[];
}

/** 运行时注册的搜索命令（见 `PluginRecord.runtimeCommands`） */
export interface RuntimeCommand {
  /** 插件内唯一（与清单 command.id 同一命名空间） */
  id: string;
  /** 关键词前缀，必须含 `" : "` 边界（如 `"翻译 : "`） */
  prefix: string;
  title: string;
  desc?: string;
  /** 注册时间（面板展示 / 排重用） */
  at: number;
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

/**
 * 清单请求 → 有效策略的默认落点。
 *
 * 缺省（作者未声明、或清单被手工构造漏了该字段）默认**开机自启**：
 * 带后台进程的插件安装后即随桌面版启动常驻，用户可在面板上改成按需/关闭。
 * - `always` / `on-demand` / `never` 原样尊重作者的明确请求；
 * - `prompt`（作者把决定权交给用户）在用户表态前折成 `on-demand`——保守起见不
 *   替作者做主，面板上以「插件建议：由你决定」呈现，用户可在设置里改。
 */
export function defaultAutoStartFrom(requested: PluginAutostart): AutoStartMode {
  switch (requested) {
    case "always":
      return "always";
    case "never":
      return "never";
    case "on-demand":
    case "prompt":
      return "on-demand";
    default:
      // 缺省/非法（手改注册表等）：落到「开机自启」的默认
      return DEFAULT_PLUGIN_AUTOSTART;
  }
}

/** 清单请求 → 「关闭界面时」的默认落点（缺省/非法一律最小化，保持老插件行为不变） */
export function defaultCloseBehaviorFrom(requested: PluginCloseBehavior | undefined | null): CloseBehavior {
  return requested === "exit" ? "exit" : DEFAULT_CLOSE_BEHAVIOR;
}

/**
 * 清单换了之后，「开机自启」该落在哪。
 *
 * 与 `closeBehavior` 的「用户改过就保留」同一条原则，但多一条**可跟随**：
 * 作者改了自己的 `autostart` 请求时，只要用户没动过这个开关，就让新建议生效。
 * 少了这条跟随，作者永远改不动自己的默认值——`requestedAutoStart` 会被写进记录
 * 却无人读取，表现就是「改了清单，已装用户的策略纹丝不动」（真实踩到过：
 * 插件改成声明开机自启，可已装的记录还停在 on-demand，后台进程一直不自启）。
 *
 * 「用户没动过」的判据是「当前值 == 旧清单的建议值」：用户若选过别的值，
 * 一定保留原值；恰好选了个与建议相同的值时无法区分，按「没动过」处理——
 * 面板上有修改入口与「恢复默认」，用户随时能改回来。
 *
 * 开发挂载（热重载）与安装升级两条路径共用本函数，避免口径分叉。
 */
export function resolveAutoStartOnUpgrade(input: {
  /** 记录里当前生效的策略 */
  current: AutoStartMode;
  /** 旧清单（算「旧的建议值」） */
  prevManifest: PluginManifest | null | undefined;
  /** 新清单（算「新的建议值」） */
  nextManifest: PluginManifest | null | undefined;
}): AutoStartMode {
  const prevSuggestion = behaviorSuggestionOf(input.prevManifest).autoStart;
  const nextSuggestion = behaviorSuggestionOf(input.nextManifest).autoStart;
  return input.current === prevSuggestion ? nextSuggestion : input.current;
}

/** 插件在清单里给出的行为建议（面板上展示「插件建议」与「恢复默认」用） */
export interface BehaviorSuggestion {
  /** 建议的后台启动策略（`prompt` 已折叠为 on-demand，另见 fromPrompt） */
  autoStart: AutoStartMode;
  /** 清单声明的是 prompt：作者希望**由用户决定**，面板上不要显示成「插件建议开机自启」 */
  fromPrompt: boolean;
  /** 建议的「关闭界面时」行为 */
  closeBehavior: CloseBehavior;
  /** 建议是否开启自动更新（清单未写时默认 false） */
  autoUpdate: boolean;
}

/**
 * 清单换了之后，「自动更新」该落在哪（与 `resolveAutoStartOnUpgrade` 同构）：
 * 用户主动改过（`current !== prevSuggestion`）则保留用户选择；未改过则跟随新清单建议。
 */
export function resolveAutoUpdateOnUpgrade(input: {
  current: boolean;
  prevManifest: PluginManifest | null | undefined;
  nextManifest: PluginManifest | null | undefined;
}): boolean {
  const prevSuggestion = manifestAutoUpdateOf(input.prevManifest);
  const nextSuggestion = manifestAutoUpdateOf(input.nextManifest);
  return input.current === prevSuggestion ? nextSuggestion : input.current;
}

/**
 * 计算安装/升级确认弹窗（`PluginInstallDialog`）打开时「自动更新此插件」开关的初始状态：
 *   - 全新安装、显式 `install` 或同版本重新安装：直接跟随插件清单声明（`manifest.autoUpdate === true`
 *     即默认开启，未声明或 `false` 即默认关闭，用户在弹窗中可随时切换）；
 *   - 跨版本升级（`action === "update"` 且目标版本高于已装版本）：经 `resolveAutoUpdateOnUpgrade`
 *     计算——旧版未声明而新版声明 `true` 时自动开启；仅当用户曾把已声明 `true` 的插件主动关闭时保留关闭。
 */
export function resolveInstallDialogAutoUpdate(input: {
  action?: "install" | "update";
  existing?: PluginRecord | null;
  nextManifest: PluginManifest | null | undefined;
}): boolean {
  const prev = input.existing;
  if (
    input.action !== "update" ||
    !prev ||
    !input.nextManifest ||
    compareVersion(input.nextManifest.version, prev.version) <= 0
  ) {
    return manifestAutoUpdateOf(input.nextManifest);
  }
  return resolveAutoUpdateOnUpgrade({
    current:
      typeof prev.autoUpdate === "boolean"
        ? prev.autoUpdate
        : manifestAutoUpdateOf(prev.manifest),
    prevManifest: prev.manifest,
    nextManifest: input.nextManifest,
  });
}

/**
 * 判定一条已安装插件记录是否处于「允许后台从市场自动更新」状态：
 * 支持 `market`、`builtin` 以及用户开启了自动更新的 `.mspp`（`file`）安装包；
 * 本地源码目录挂载（`folder`）与 `legacy` 条目永不参与市场覆盖。
 */
export function isPluginAutoUpdateEnabled(rec: PluginRecord | null | undefined): boolean {
  if (!rec) return DEFAULT_PLUGIN_AUTO_UPDATE;
  if (
    rec.source.kind !== "market" &&
    rec.source.kind !== "builtin" &&
    rec.source.kind !== "file"
  ) {
    return false;
  }
  return typeof rec.autoUpdate === "boolean"
    ? rec.autoUpdate
    : manifestAutoUpdateOf(rec.manifest);
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
  const requested = backend?.autostart ?? DEFAULT_PLUGIN_AUTOSTART;
  return {
    autoStart: defaultAutoStartFrom(requested),
    fromPrompt: requested === "prompt",
    closeBehavior: detailViewCloseBehaviorOf(manifest),
    autoUpdate: manifestAutoUpdateOf(manifest),
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
 * 求某插件**有效**的界面主题偏好（用户在面板上的选择优先，其次清单声明）。
 *
 * 这是「打开插件视图时该把呼出窗口切成什么主题」的持久侧口径，与
 * `shouldKeepFrontendOnClose` 同级：面板显示与视图宿主引用同一个函数，
 * 因此「面板上显示的值」与「打开时实际生效的值」永远一致。
 *
 * 注意运行时还有一层：插件可以用 `ms.ui.registerThemeProvider()` 上报它自己
 * 界面内的主题选择（如 pi-agent 左下角切换），那一层的优先级高于本函数。
 */
export function resolvePluginTheme(
  rec: PluginRecord | null | undefined
): PluginThemePreference {
  if (!rec) return DEFAULT_PLUGIN_THEME;
  const pref = rec.themePreference;
  if (pref === "dark" || pref === "light" || pref === "inherit") return pref;
  // 老记录（升级前装的，没有该字段）：回落到清单声明
  return detailViewThemeOf(rec.manifest);
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
  /** 安装确认框中用户显式指定的自动更新开关（省略则取清单 `manifest.autoUpdate ?? false`） */
  autoUpdate?: boolean;
  runtime?: PluginRuntimeState;
  integrity?: { sha256: string | null; signed: boolean };
  now?: number;
}): PluginRecord {
  const now = input.now ?? Date.now();
  const requested = input.manifest.backend?.autostart ?? DEFAULT_PLUGIN_AUTOSTART;
  return {
    id: input.manifest.id,
    name: input.manifest.name,
    version: input.manifest.version,
    apiVersion: input.manifest.apiVersion,
    author: input.manifest.author,
    description: input.manifest.description,
    homepage: input.manifest.homepage,
    repository: input.manifest.repository,
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
    // 界面主题同理：首次安装落在清单建议值上，升级不覆盖用户选择
    //（口径统一由 detailViewThemeOf 计算：只认 contributes.detailView.theme）。
    themePreference: detailViewThemeOf(input.manifest),
    autoUpdate:
      typeof input.autoUpdate === "boolean"
        ? input.autoUpdate
        : manifestAutoUpdateOf(input.manifest),
    grants: (input.grants ?? []).map((permission) => ({ permission, at: now, source: "install" as const })),
    denied: [],
    runtime: input.runtime ?? emptyRuntime(),
    integrity: input.integrity ?? { sha256: null, signed: false },
  };
}

/**
 * 补齐记录里缺失的字段（结构演进时的就地迁移）。
 *
 * 处理 `closeBehavior`、`themePreference` 与 `autoUpdate`：升级前装的
 * 插件记录里没有这些字段时，补上**插件建议值**；已有值一律不动。
 */
function hydrateRecord(rec: PluginRecord): PluginRecord {
  let out = rec;
  if (out.closeBehavior !== "minimize" && out.closeBehavior !== "exit") {
    out = { ...out, closeBehavior: behaviorSuggestionOf(out.manifest).closeBehavior };
  }
  const t = out.themePreference;
  if (t !== "dark" && t !== "light" && t !== "inherit") {
    out = { ...out, themePreference: detailViewThemeOf(out.manifest) };
  }
  if (typeof out.autoUpdate !== "boolean") {
    out = { ...out, autoUpdate: manifestAutoUpdateOf(out.manifest) };
  }
  return out;
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

/** 写入注册表并广播同窗口变更事件 */
export function saveRegistry(reg: PluginRegistryFile): void {
  try {
    // 走 storageSet：同时触发同步宿主的变更钩子（注册表也是要同步的数据）。
    storageSet(PLUGIN_REGISTRY_KEY, reg);
    if (
      typeof window !== "undefined" &&
      typeof window.dispatchEvent === "function" &&
      typeof CustomEvent === "function"
    ) {
      window.dispatchEvent(new CustomEvent(REGISTRY_CHANGED_DOM_EVENT));
    }
  } catch (e) {
    console.warn("插件注册表写入失败:", e);
  }
}

/** 按 id 取记录 */
export function findPlugin(reg: PluginRegistryFile, id: string): PluginRecord | undefined {
  return reg.plugins.find((p) => p.id === id);
}

/**
 * 还原后合并注册表：把「被版本守卫跳过」的插件记录换回本机记录。
 *
 * 为什么需要：备份还原会整目录交换 `plugins/`；对「本机版本更高」的插件我们
 * 拒绝降级（保留本机文件），而归档里的注册表记录也是旧版本——若照原样写回，
 * 就会出现「磁盘代码 v1.0.0、版本号显示 v1.0.0 的旧记录」这类清单与代码错配。
 * 这里把这些 id 换回本机记录，保证版本号与磁盘代码始终一致。
 */
export function keepLocalRecordsAfterRestore(
  archived: unknown,
  keepIds: readonly string[]
): PluginRegistryFile {
  const parsed =
    archived &&
    typeof archived === "object" &&
    Array.isArray((archived as PluginRegistryFile).plugins)
      ? (archived as PluginRegistryFile)
      : { version: PLUGIN_REGISTRY_VERSION, plugins: [] as PluginRecord[] };
  if (!keepIds || keepIds.length === 0) return parsed;

  const keep = new Set(keepIds);
  const local = new Map(loadRegistry().plugins.map((p) => [p.id, p]));
  const plugins = parsed.plugins.filter(
    (p): p is PluginRecord => !!p && typeof p.id === "string" && !keep.has(p.id)
  );
  for (const id of keep) {
    const rec = local.get(id);
    if (rec) plugins.push(rec);
  }
  return { version: parsed.version ?? PLUGIN_REGISTRY_VERSION, plugins };
}

/** 新增或替换记录（保留用户态字段：enabled / autoStart / closeBehavior / themePreference / grants / denied） */
export function upsertPlugin(
  reg: PluginRegistryFile,
  incoming: PluginRecord,
  opts: { preserveUserChoices?: boolean; explicitAutoUpdate?: boolean } = {}
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
    // 自启策略：用户改过就保留；没改过则跟随新清单的建议（见 resolveAutoStartOnUpgrade
    // 的说明——不跟随的话作者永远改不动自己的默认值）。
    autoStart:
      opts.preserveUserChoices === false
        ? incoming.autoStart
        : resolveAutoStartOnUpgrade({
            current: prev.autoStart,
            prevManifest: prev.manifest,
            nextManifest: incoming.manifest,
          }),
    // 用户改过的关闭行为同样不随插件升级被覆盖（与 autoStart 同理：
    // 否则插件能靠发版把自己设回「关闭即退出」，用户失去控制感）。
    // `?? incoming` 是给「升级前装的记录」（没有该字段）兜底——`loadRegistry`
    // 会补，但 upsert 也可能被别处直接用未 hydrate 的记录调用，合并结果
    // 必须保证字段存在（否则面板读到 undefined、判定函数一律不动作）。
    closeBehavior:
      opts.preserveUserChoices === false
        ? incoming.closeBehavior
        : prev.closeBehavior ?? incoming.closeBehavior,
    // 界面主题同理：用户改过就不随插件升级被覆盖（`?? incoming` 给缺字段的老记录兜底）。
    themePreference:
      opts.preserveUserChoices === false
        ? incoming.themePreference
        : prev.themePreference ?? incoming.themePreference,
    autoUpdate:
      typeof opts.explicitAutoUpdate === "boolean"
        ? opts.explicitAutoUpdate
        : opts.preserveUserChoices === false
          ? typeof incoming.autoUpdate === "boolean"
            ? incoming.autoUpdate
            : manifestAutoUpdateOf(incoming.manifest)
          : resolveAutoUpdateOnUpgrade({
              current:
                typeof prev.autoUpdate === "boolean"
                  ? prev.autoUpdate
                  : manifestAutoUpdateOf(prev.manifest),
              prevManifest: prev.manifest,
              nextManifest: incoming.manifest,
            }),
    grants: mergeGrants(prev.grants, incoming.grants),
    denied: prev.denied,
    pendingPermission: prev.pendingPermission ?? null,
    // 运行时命令是插件自己声明的能力，升级时保留（新清单若同名同 id，合成时运行时优先）。
    runtimeCommands: prev.runtimeCommands ?? null,
    // 申请历史跨版本保留（否则升级就能重置 24h 频率限制）
    permissionRequests: prev.permissionRequests ?? null,
    // 走到 upsert 说明这次升级已经提交（用户确认过或无需确认），待确认记录作废。
    pendingUpgrade: null,
    legacyRef: prev.legacyRef,
    updateAvailable: null,
    // 内置内容指纹：安装方（install-builtin）显式给出时以它为准（重装场景），
    // 否则保留旧值（普通升级不该把指纹擦掉，否则会触发一次多余的重装）。
    builtinFingerprint: incoming.builtinFingerprint ?? prev.builtinFingerprint ?? null,
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

/** 登记「自动更新被高危权限拦下」的待确认记录（就地修改） */
export function markPendingUpgrade(
  reg: PluginRegistryFile,
  id: string,
  pending: PendingUpgrade
): PluginRecord | null {
  const rec = reg.plugins.find((p) => p.id === id);
  if (!rec) return null;
  rec.pendingUpgrade = pending;
  // 角标同步指向新版本：用户点「更新」时就能看到待确认的权限。
  rec.updateAvailable = pending.version;
  return rec;
}

/** 清空待确认记录（用户确认/取消，或插件被卸载时调用） */
export function clearPendingUpgrade(reg: PluginRegistryFile, id: string): void {
  const rec = reg.plugins.find((p) => p.id === id);
  if (rec && rec.pendingUpgrade != null) rec.pendingUpgrade = null;
}

/** 该插件的待确认升级（没有则 null） */
export function pendingUpgradeOf(record: PluginRecord | null | undefined): PendingUpgrade | null {
  return record?.pendingUpgrade ?? null;
}

/* ============================================================
 * 运行时命令（ms.commands.*）
 * ============================================================ */

/** 单插件可注册的运行时命令上限（防止插件把搜索框塞满） */
export const MAX_RUNTIME_COMMANDS = 20;

/** 运行时命令 id 的合法字符（与清单 command.id 同一套约定） */
const RUNTIME_COMMAND_ID_RE = /^[a-zA-Z0-9._-]{1,64}$/;

/** 取该插件当前的运行时命令（无则空数组，绝不返回 null） */
export function runtimeCommandsOf(record: PluginRecord | null | undefined): RuntimeCommand[] {
  return record?.runtimeCommands ?? [];
}

/**
 * 规范化命令前缀：补上 `" : "` 边界并返回「父关键词」。
 *
 * 为什么允许自动补：作者写 `"翻译"` 时意图明确（就是「翻译 : 子词」），
 * 让他因为少写两个空格而运行时失败没有意义；但落盘与展示统一用规范形态，
 * 避免出现「同一命令两种前缀」。
 */
export function normalizeCommandPrefix(raw: string): { prefix: string; keyword: string } | null {
  const text = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  let keyword = text;
  const sep = text.indexOf(" : ");
  if (sep >= 0) {
    keyword = text.slice(0, sep).trim();
  } else {
    // 容忍作者只写「问AI :」「问AI:」这类缺尾空格的形态
    const tail = text.search(/\s*:\s*$/);
    if (tail >= 0) keyword = text.slice(0, tail).trim();
  }
  if (!keyword) return null;
  return { prefix: `${keyword} : `, keyword };
}

/**
 * 合并「清单命令」与「运行时命令」（同 id 以运行时为准）。
 *
 * 清单命令是作者写死的静态入口；运行时命令是插件根据当前数据动态生成的。
 * 合并后按 `id` 去重，顺序保持：清单在前（稳定的静态入口优先展示），
 * 运行时在后（新生成的排后面，不挤占老入口的位置）。
 */
export function listAllCommands(record: PluginRecord): Array<{
  id: string;
  prefix: string;
  title: string;
  desc?: string;
  source: "manifest" | "runtime";
}> {
  const manifest = record.manifest.contributes?.command ?? [];
  const runtime = runtimeCommandsOf(record);
  const byId = new Map<string, {
    id: string;
    prefix: string;
    title: string;
    desc?: string;
    source: "manifest" | "runtime";
  }>();
  for (const c of manifest) {
    if (!c?.id) continue;
    byId.set(c.id, {
      id: c.id,
      prefix: c.prefix,
      title: c.title,
      desc: c.desc,
      source: "manifest",
    });
  }
  for (const c of runtime) {
    if (!c?.id) continue;
    byId.set(c.id, {
      id: c.id,
      prefix: c.prefix,
      title: c.title,
      desc: c.desc,
      source: "runtime",
    });
  }
  return [...byId.values()];
}

/** 注册/更新一条运行时命令（就地修改；返回可读错误） */
export function upsertRuntimeCommand(
  reg: PluginRegistryFile,
  pluginId: string,
  input: { id: string; prefix: string; title: string; desc?: string }
): { ok: true; command: RuntimeCommand } | { ok: false; error: string } {
  const rec = reg.plugins.find((p) => p.id === pluginId);
  if (!rec) return { ok: false, error: "插件不存在" };
  const id = String(input?.id ?? "").trim();
  if (!RUNTIME_COMMAND_ID_RE.test(id)) {
    return { ok: false, error: "命令 id 只能是 1–64 位字母、数字、点、下划线或连字符" };
  }
  const title = String(input?.title ?? "").trim();
  if (!title) return { ok: false, error: "命令标题不能为空" };
  if (title.length > 40) return { ok: false, error: "命令标题不能超过 40 个字符" };
  const desc = input?.desc == null ? undefined : String(input.desc).trim().slice(0, 80);
  const normalized = normalizeCommandPrefix(input?.prefix);
  if (!normalized) return { ok: false, error: "命令前缀不能为空" };
  // 前缀与 id 都不能和已有命令/搜索项冲突（否则搜索框里会出现两个一样的入口）
  const existing = runtimeCommandsOf(rec);
  if (!existing.some((c) => c.id === id) && existing.length >= MAX_RUNTIME_COMMANDS) {
    return { ok: false, error: `单插件最多注册 ${MAX_RUNTIME_COMMANDS} 条运行时命令` };
  }
  const conflict = listAllCommands(rec).find(
    (c) =>
      c.id !== id &&
      normalizeCommandPrefix(c.prefix)?.keyword === normalized.keyword
  );
  if (conflict) {
    return { ok: false, error: `前缀「${normalized.keyword}」已被命令「${conflict.title}」占用` };
  }
  const command: RuntimeCommand = {
    id,
    prefix: normalized.prefix,
    title,
    desc,
    at: Date.now(),
  };
  const next = existing.filter((c) => c.id !== id).concat(command);
  rec.runtimeCommands = next;
  return { ok: true, command };
}

/** 移除一条运行时命令（就地修改） */
export function removeRuntimeCommand(
  reg: PluginRegistryFile,
  pluginId: string,
  commandId: string
): boolean {
  const rec = reg.plugins.find((p) => p.id === pluginId);
  if (!rec) return false;
  const existing = runtimeCommandsOf(rec);
  const next = existing.filter((c) => c.id !== String(commandId ?? ""));
  if (next.length === existing.length) return false;
  rec.runtimeCommands = next;
  return true;
}

/** 清空某插件的运行时命令（卸载 / 禁用时调用，避免残留入口） */
export function clearRuntimeCommands(reg: PluginRegistryFile, pluginId: string): number {
  const rec = reg.plugins.find((p) => p.id === pluginId);
  if (!rec || !rec.runtimeCommands?.length) return 0;
  const n = rec.runtimeCommands.length;
  rec.runtimeCommands = null;
  return n;
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
    // 与宿主其它数据走同一个写入口：插件数据变化同样要触发云同步。
    storageSet(`${PLUGIN_DATA_PREFIX}${pluginId}:${key}`, value);
  } catch (e) {
    console.warn("插件数据写入失败:", e);
  }
}

export function pluginDataRemove(pluginId: string, key: string): void {
  try {
    storageRemove(`${PLUGIN_DATA_PREFIX}${pluginId}:${key}`);
  } catch (e) {
    /* ignore */
  }
}

/** 清空某插件的全部私有数据（卸载时调用） */
export function pluginDataClear(pluginId: string): number {
  if (typeof localStorage === "undefined") return 0;
  const prefix = "my-search-desktop:" + PLUGIN_DATA_PREFIX + pluginId + ":";
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(prefix)) keys.push(k);
  }
  for (const k of keys) {
    storageRemove(k.slice("my-search-desktop:".length));
  }
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
