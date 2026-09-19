/**
 * 目录挂载插件的**自动重载** —— 纯逻辑（无 Vue / 无 Tauri 依赖）。
 *
 * ## 背景
 *
 * 「从目录挂载」的插件（`source.dev === true`）在开发时会被反复编辑。
 * Rust 侧的 `plugin_watch` 盯着源目录，静默期一到就广播
 * `plugin://dev-changed`，本模块负责把这条事件翻译成**该做什么**：
 *
 *   1. 重新读 `plugin.json`（作者可能改了版本 / 搜索项 / 后台入口）；
 *   2. 合并进注册表记录（**用户态一律不动**：启用态、自启策略、关闭行为、授权）；
 *   3. 决定要不要**重挂已打开的视图**（改了界面文件就必须重挂）；
 *   4. 决定要不要**重启后台进程**（改了 `backend/` 下的文件才需要）。
 *
 * ## 为什么抽成纯逻辑
 *
 * 上面四条都是判定，判定写错了在浏览器里很难复现（要同时开着插件、改文件、
 * 盯着事件）。把它们写成纯函数后可以脱离运行环境直接跑单测（见
 * `test/plugin-dev-reload.test.mjs`），调用方只负责「按结论执行动作」。
 *
 * ## 三条必须守住的原则
 *
 * - **用户态不被开发中的改动覆盖**：作者改清单不该悄悄把用户关掉的插件打开、
 *   把「关闭即退出」改回最小化——与升级（`upsertPlugin`）同一套保留列表。
 * - **新权限不静默授予**：开发插件改动清单新增权限时，只登记为「待授权」，
 *   由用户在面板/弹窗上明确同意（与安装时的确认语义一致）。
 * - **清单读不出来就什么都不做**：编辑器保存的中间态可能写出半截 JSON，
 *   此时重载会让插件凭空消失；宁可等下一次事件，也不能把好记录弄坏。
 */

import type { PluginChangedPayload } from "../plugins/ipc.ts";
import { parsePluginManifest, type PluginManifest } from "./manifest.ts";
import { grantPermission, shouldKeepFrontendOnClose, type PluginRecord } from "./registry.ts";
import { isKnownPermission, permissionCovers } from "./permissions.ts";

/** 一次重载要做的事情（由调用方执行；纯数据，便于断言） */
export interface ReloadPlan {
  /** 是否值得继续（清单没变 / 读不出来时为 false） */
  proceed: boolean;
  /** 不继续的原因（日志/提示用） */
  reason?: string;
  /** 合并后的记录（proceed 为 false 时是原记录） */
  record: PluginRecord;
  /** 清单里新出现、需要用户确认的必需权限（不静默授予） */
  newPermissions: string[];
  /** 版本号是否变化（面板/视图展示用） */
  versionChanged: boolean;
  /** 版本变化时的旧版本 */
  fromVersion: string;
}

/** 已打开视图的重挂判定需要的输入 */
export interface ViewReloadDecision {
  /** 重新挂载视图 */
  remount: boolean;
  /** 重挂前给用户的提示（null = 静默重挂） */
  notice: string | null;
}

/** 后台进程的重启判定需要的输入 */
export interface BackendReloadDecision {
  /** 重启进程 */
  restart: boolean;
  /** 原因（写日志用） */
  reason: string | null;
}

/**
 * 判断这次改动是否**只**涉及前端资源（界面 / 图标 / 样式）。
 *
 * 与 Rust 侧 `is_frontend_path` 同一套规则，但**前端仍需自己判一次**：
 * 载荷里的 `frontendOnly` 是「这次事件涉及的路径」的合并结果，而重挂视图
 * 还取决于「当前打开的入口文件是否在其中」——两件事不能混为一谈。
 */
export function isFrontendPath(rel: string): boolean {
  const p = String(rel ?? "").replace(/\\/g, "/");
  if (p === "plugin.json") return false;
  if (p.startsWith("backend/")) return false;
  return !/\.(exe|dll)$/i.test(p);
}

/** 某次变化是否碰到了插件的界面文件（决定要不要重挂视图） */
export function touchesView(paths: readonly string[], entry?: string | null, script?: string | null): boolean {
  // 载荷没带路径（目录级事件）：无法判断，按「碰了」处理（重挂是幂等且安全的）
  if (!paths || paths.length === 0) return true;
  const wanted = [entry, script].filter((p): p is string => typeof p === "string" && p !== "");
  if (wanted.length === 0) {
    // 清单没声明 detailView：任何 html/css/js 变化都可能与界面有关
    return paths.some((p) => isFrontendPath(p));
  }
  return paths.some((p) => {
    const rel = String(p ?? "").replace(/\\/g, "/");
    if (wanted.includes(rel)) return true;
    // 同目录的样式 / 脚本（`ui/detail.html` 对应 `ui/detail.css`、`ui/*.js`）
    return wanted.some((w) => sameDir(rel, w));
  });
}

/** 两个相对路径是否同目录（`ui/detail.css` 与 `ui/detail.html`） */
function sameDir(a: string, b: string): boolean {
  const dirOf = (p: string): string => {
    const i = p.lastIndexOf("/");
    return i < 0 ? "" : p.slice(0, i);
  };
  return dirOf(a) === dirOf(b) && dirOf(a) !== "";
}

/** 某次变化是否碰到了后台进程的文件（决定要不要重启进程） */
export function touchesBackend(paths: readonly string[]): boolean {
  if (!paths || paths.length === 0) {
    // 目录级事件：可能是任何文件，保守起见按「碰了后端」处理
    return true;
  }
  return paths.some((p) => {
    const rel = String(p ?? "").replace(/\\/g, "/");
    if (rel.startsWith("backend/")) return true;
    // 清单变化可能改了 backend.entry：需要重启才能生效
    return rel === "plugin.json";
  });
}

/**
 * 把一次「开发插件变化」应用到记录上。
 *
 * @param rec 当前注册表记录
 * @param manifestText 重新读到的 `plugin.json` 原文
 * @returns 可执行的重载计划
 */
export function planReload(rec: PluginRecord, manifestText: string): ReloadPlan {
  const parsed = parsePluginManifest(manifestText, isKnownPermission);
  if (!parsed.ok) {
    // 编辑器保存到一半 / 语法错误：等下一次事件，绝不把记录改坏
    return {
      proceed: false,
      reason: "新清单校验未通过（可能是保存中的中间状态），已忽略本次变化",
      record: rec,
      newPermissions: [],
      versionChanged: false,
      fromVersion: rec.version,
    };
  }
  const next: PluginManifest = parsed.manifest;
  if (next.id !== rec.id) {
    // 换了个 id 的清单（把别的插件拷进来）：不能悄悄改身份
    return {
      proceed: false,
      reason: `清单 id（${next.id}）与已挂载插件（${rec.id}）不一致，已忽略`,
      record: rec,
      newPermissions: [],
      versionChanged: false,
      fromVersion: rec.version,
    };
  }

  const grants = rec.grants.map((g) => g.permission);
  const newPermissions = (next.permissions ?? []).filter(
    (req) => !grants.some((g) => permissionCovers(g, req))
  );

  const merged: PluginRecord = {
    ...rec,
    // 清单派生的展示字段：跟着源目录里的最新清单走
    name: next.name,
    version: next.version,
    apiVersion: next.apiVersion,
    author: next.author,
    description: next.description,
    homepage: next.homepage,
    icon: next.icon,
    manifest: next,
    updatedAt: Date.now(),
    // 用户态一律保留（与 upsertPlugin 的保留列表一致）：
    // enabled / autoStart / closeBehavior / grants / denied / runtime / installedAt
    dir: rec.dir,
    source: rec.source,
  };

  // 新增的必需权限：登记为待授权（不静默授予），由用户在面板上点确认
  if (newPermissions.length > 0 && !merged.pendingPermission) {
    merged.pendingPermission = newPermissions[0];
  }

  return {
    proceed: true,
    record: merged,
    newPermissions,
    versionChanged: next.version !== rec.version,
    fromVersion: rec.version,
  };
}

/**
 * 用户确认授予「新增权限」时调用（把 planReload 报出的权限写进记录）。
 *
 * @returns 是否写入了新授权
 */
export function approveNewPermissions(rec: PluginRecord, permissions: readonly string[]): boolean {
  let changed = false;
  for (const p of permissions) {
    if (!isKnownPermission(p)) continue;
    if (grantPermission(rec, p, "install")) changed = true;
  }
  return changed;
}

/**
 * 判断「已打开的插件视图」要不要重挂。
 *
 * 规则：
 *   - 当前没有打开这个插件的视图（前台或后台保活都没有）→ 不重挂（下次打开自然读到新文件）；
 *   - 变化碰到了视图入口 / 同目录资源 / 样式 → 重挂；
 *   - 版本变化（作者改 `plugin.json`）→ 也重挂：作者往往同时改了清单里的
 *     搜索项与界面，只更新记录会让界面与清单不一致。
 *
 * 重挂 = 先彻底卸载（`release`）再 `open(同一个数据项)`：插件内存态会丢，因此
 * 给用户一条提示（而不是静默清空正在输入的内容）。
 *
 * **保活的会话也在重挂范围内**：它内存里跑的是旧代码，不重挂就等于「改了没反应」。
 */
export function decideViewReload(input: {
  /** 当前打开的插件 id（null = 没有打开任何插件视图） */
  activePluginId: string | null;
  /** 事件涉及的插件 id */
  pluginId: string;
  /** 事件带来的相对路径 */
  paths: readonly string[];
  /** 该插件声明的界面入口（可能是新清单里的） */
  entry?: string | null;
  script?: string | null;
  /** 版本是否变化 */
  versionChanged: boolean;
  /** 插件展示名（提示文案用） */
  name?: string;
  /** 后台保活中的插件 id（最小化后仍持有会话的那些） */
  parkedPluginIds?: readonly string[];
}): ViewReloadDecision {
  const holding =
    (!!input.activePluginId && input.activePluginId === input.pluginId) ||
    (input.parkedPluginIds ?? []).includes(input.pluginId);
  if (!holding) {
    return { remount: false, notice: null };
  }
  const hit = input.versionChanged || touchesView(input.paths, input.entry, input.script);
  if (!hit) return { remount: false, notice: null };
  return {
    remount: true,
    notice: `「${input.name ?? input.pluginId}」已在开发目录中更新，界面已重新加载`,
  };
}

/* ============================================================
 * 关闭界面 / 再次打开：保活（最小化）还是卸载（退出）
 * ============================================================ */

/** 关闭一次插件界面时要做的动作 */
export type ViewCloseAction = "park" | "unmount";

export interface ViewCloseDecision {
  /** `park` = 保留会话（最小化）/ `unmount` = 彻底卸载 */
  action: ViewCloseAction;
  /** 与 action 等价的可读结论（便于调用方与测试直接断言） */
  keepAlive: boolean;
  /** 判定原因（日志用） */
  reason: string;
}

/**
 * 关闭插件界面时：**保留会话**还是**彻底卸载**。
 *
 * 判定顺序（前一条命中即返回）：
 *   1. 没有会话 → 没什么可保留的（`unmount`，幂等）；
 *   2. `force` → 强制卸载（插件被禁用/卸载、开发热重载要重挂、应用退出）：
 *      这些场景下保活是错的（会话对应的记录已经不该存在或必须重读文件）；
 *   3. 否则看插件设置：`minimize` → 保活，`exit` → 卸载
 *      （判定复用注册表的 `shouldKeepFrontendOnClose`，与面板显示同源）。
 */
export function decideViewClose(input: {
  record: PluginRecord | null | undefined;
  hasSession: boolean;
  /** 强制卸载（不看插件设置） */
  force?: boolean;
  /** 强制卸载的可读原因（日志/断言用） */
  forceReason?: string;
}): ViewCloseDecision {
  if (!input.hasSession) {
    return { action: "unmount", keepAlive: false, reason: "没有会话" };
  }
  if (input.force) {
    return {
      action: "unmount",
      keepAlive: false,
      reason: input.forceReason ?? "强制卸载（不看插件设置）",
    };
  }
  const keep = shouldKeepFrontendOnClose(input.record ?? null);
  return keep
    ? { action: "park", keepAlive: true, reason: "插件设置为「最小化」：保留会话" }
    : { action: "unmount", keepAlive: false, reason: "插件设置为「退出」：卸载会话" };
}

/** 再次打开插件界面时的动作 */
export type ViewOpenAction = "restore" | "remount";

/**
 * 再次打开插件界面：**恢复**保活中的会话，还是**重新挂载**（重读文件 + 重跑脚本）。
 *
 * 恢复的前提（全部满足才恢复）：
 *   1. 存在该插件的会话（上一次关闭时是「最小化」）；
 *   2. 会话挂载时的入口路径与当前记录一致——入口换了（开发热重载改了
 *      `detailView.entry` / `script`）却恢复旧 DOM，界面就与清单对不上；
 *   3. 会话对应的记录仍在且启用（禁用/卸载的插件不该被恢复出来，调用方
 *      会在更早的分支直接报错）。
 *
 * 注意这里**不比较文件内容**：内容变化由开发热重载那条链路（`decideViewReload`）
 * 负责，它会在变化发生时就把旧会话重挂掉；因此能走到这里说明磁盘内容没变。
 */
export function decideViewRestore(input: {
  /** 是否存在该插件的会话 */
  hasSession: boolean;
  /** 注册表里现在还有这条记录吗（且启用） */
  recordUsable: boolean;
  /** 当前记录声明的入口（HTML） */
  entry: string | null | undefined;
  /** 当前记录声明的入口脚本（可能为空 = 宿主自行探测） */
  script?: string | null;
  /** 会话当初挂载时用的入口（HTML） */
  sessionEntry?: string | null;
  /** 会话当初挂载时用的入口脚本（已解析出的那个） */
  sessionScript?: string | null;
}): { action: ViewOpenAction; reason: string } {
  if (!input.hasSession) return { action: "remount", reason: "没有可恢复的会话" };
  if (!input.recordUsable) return { action: "remount", reason: "插件记录不可用" };
  const entrySame = (input.sessionEntry ?? null) === (input.entry ?? null);
  const scriptSame = (input.sessionScript ?? null) === (input.script ?? null);
  if (!entrySame || !scriptSame) {
    return { action: "remount", reason: "入口文件已变化（需要按新入口重新挂载）" };
  }
  return { action: "restore", reason: "恢复保活中的会话（不重读文件、不重跑脚本）" };
}

/**
 * 判断「后台进程」要不要重启。
 *
 * 用户拍板的策略：**只在进程当前运行/启动中时才重启**——
 *   1. 没在跑：不重启（否则改一行后端代码就会平白拉起一个进程）；
 *   2. 只有前端文件变化：不重启（避免重启一次丢掉插件的内存态）；
 *   3. 进程已被禁用 / 没有后台进程：不重启；
 *   4. 首次启动中（starting）也不重启：此时重启与用户刚点的「启动」打架。
 */
export function decideBackendReload(input: {
  /** 该插件是否声明了后台进程 */
  hasBackend: boolean;
  /** 事件带来的相对路径 */
  paths: readonly string[];
  /** 当前进程状态 */
  status: string | null | undefined;
  /** 载荷自带的「只涉及前端文件」结论（Rust 侧对本次全部路径的合并判定） */
  frontendOnly?: boolean;
}): BackendReloadDecision {
  if (!input.hasBackend) return { restart: false, reason: null };
  if (input.status !== "running") {
    // starting 时点「重启」会与用户刚点的「启动」互相踩，明确不打断
    return { restart: false, reason: input.status === "starting" ? "进程正在启动中" : null };
  }
  // 载荷声明「只涉及前端」时以它为准：那是 Rust 侧对本次全部路径的合并结论，
  // 比单看 paths 更保守（宁可漏重启一次，也不白白打断进程）
  if (input.frontendOnly === true) return { restart: false, reason: null };
  if (!touchesBackend(input.paths)) {
    return { restart: false, reason: "本次变化只涉及前端文件" };
  }
  return { restart: true, reason: "开发目录中的后端文件已更新" };
}

/**
 * 事件是否仍然值得处理（丢弃过期事件）。
 *
 * 30 秒的窗口：一次保存的事件在正常情况下是立刻被消费的；超过这个时间还
 * 没处理，说明前端刚刚经历了长时间阻塞（或窗口刚被唤醒），此时旧事件
 * 携带的 `paths` 多半已经不代表最新状态，不如丢弃、等下一次。
 */
export const EVENT_MAX_AGE_MS = 30_000;

export function isFreshEvent(payload: Pick<PluginChangedPayload, "at">, now = Date.now()): boolean {
  const at = Number(payload?.at ?? 0);
  if (!Number.isFinite(at) || at <= 0) return true; // 没有时间戳：按新鲜处理
  return now - at <= EVENT_MAX_AGE_MS;
}
