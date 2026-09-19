/**
 * 插件清单（plugin.json）解析与校验 —— 纯函数，便于单测。
 *
 * 这是插件系统的**唯一契约**：安装时的校验、面板的展示、权限弹窗、
 * 宿主网关的鉴权、开发脚手架的生成，全部以这里的类型为准。
 *
 * 设计要点：
 * - **永不抛异常**：解析失败返回 { ok: false, errors }，错误码可读、可翻译。
 * - **不信任输入**：清单来自用户安装的第三方压缩包，所有字段都要类型与范围校验。
 * - **路径即权限**：`entry` 类字段一律要求「相对路径 + 无 .. + 无绝对路径」，
 *   在解析阶段就掐死路径穿越（与 Rust 侧二次校验形成双保险）。
 */

// permissions.ts 是无依赖的叶子模块（零 import），因此可以安全地被这里引用：
// 校验权限串需要区分「未知权限」与「缺 scope」两种错误，只看注入的
// checkPermissions 回调无法区分（scoped 权限的基础 id 单查永远是 false）。
import { getPermissionSpec } from "./permissions.ts";

/** 插件 API 面版本：宿主支持的最高版本；插件清单里声明自己按哪版写的 */
export const PLUGIN_API_VERSION = 1;
/** 清单文件名（压缩包根目录下必须存在） */
export const PLUGIN_MANIFEST_FILE = "plugin.json";

/** 已安装插件目录名（位于应用数据目录下） */
export const PLUGINS_DIR_NAME = "plugins";

/** 插件分发后缀（安装包本质是 zip） */
export const PLUGIN_PACKAGE_EXT = ".msplugin";

/** 官方保留的 id 前缀（第三方不得占用，避免冒充官方插件） */
export const RESERVED_ID_PREFIXES = ["com.mysearch.", "mysearch."];
/** 官方保留的 id（单独占位，防止与内置能力混淆） */
export const RESERVED_IDS = ["core", "host", "system"];

/** 后台进程自动启动策略（清单里声明的是「请求」，有效状态由用户在面板决定） */
export type PluginAutostart = "always" | "on-demand" | "prompt" | "never";

/**
 * 关闭插件界面时的行为（同样是「请求」，有效值由用户在面板决定）：
 * - `minimize`：最小化——后台进程继续运行，由空闲回收（`idleExitSec`）决定何时退出；
 * - `exit`    ：退出——关闭界面即停止后台进程（deactivate 优雅退出，超时强杀）。
 */
export type PluginCloseBehavior = "minimize" | "exit";

/** 关闭行为的默认值（老插件未声明时保持现状：不因关闭界面而停进程） */
export const DEFAULT_CLOSE_BEHAVIOR: PluginCloseBehavior = "minimize";

/** 后台进程规格 */
export interface PluginBackendSpec {
  /** 可执行文件相对路径（如 backend/ai-ask.exe） */
  entry: string;
  /** 通信协议：stdio JSON-RPC（默认，无端口）/ 本地 HTTP（插件自起服务） */
  protocol?: "jsonrpc-stdio" | "localhost-http";
  /** 请求的自动启动策略（默认 on-demand） */
  autostart?: PluginAutostart;
  /**
   * 关闭插件界面时的行为（默认 minimize）。
   *
   * 与 `autostart` 同一条原则：这里只是**请求**，用户在面板上的选择优先，
   * 插件升级不会覆盖用户已经改过的值。
   */
  closeBehavior?: PluginCloseBehavior;
  /** 启动握手超时（默认 3000ms） */
  startupTimeoutMs?: number;
  /** 单次调用超时（默认 30000ms） */
  callTimeoutMs?: number;
  /** 空闲多久后自动退出（秒，0 = 不自动退出；默认 30） */
  idleExitSec?: number;
  /** 前台关闭后的保留窗口期（秒，默认 5）——避免切走一下回来就要冷启动 */
  graceSec?: number;
  /** 优雅退出等待（秒，默认 5） */
  shutdownTimeoutSec?: number;
  /** 崩溃后最大重启次数（默认 3） */
  maxRestarts?: number;
  /** 注入环境变量；值支持 $secret:<name> 从系统钥匙串取 */
  env?: Record<string, string>;
}

/** 贡献点：搜索结果项 */
export interface PluginSearchItemContribution {
  /** 标题（可含 [标签]，与订阅数据项写法一致） */
  title: string;
  desc?: string;
  /** 命中即打开的关键词（如 "问AI"） */
  keyword: string;
  /** 图标：插件内相对路径，或 data: URL */
  icon?: string;
  /** 数据项 resource（默认空，由插件视图自渲染） */
  resource?: string;
  /** 是否默认展示在结果列表（默认 true） */
  visible?: boolean;
}

/** 贡献点：命令（搜索框关键词前缀注册） */
export interface PluginCommandContribution {
  id: string;
  /** 关键词前缀，约定含 " : " 分隔符（如 "问AI : "），与脚本项子关键词一致 */
  prefix: string;
  title: string;
  desc?: string;
}

/** 贡献点：详情视图 */
export interface PluginDetailViewContribution {
  /** 入口 HTML 相对路径 */
  entry: string;
  /**
   * 入口脚本相对路径（可选）。
   * 缺省时按 `entry` 同名 `.js` → 同目录 `index.js` 的顺序探测，
   * 显式声明可避免多入口插件被猜错。
   */
  script?: string;
  /** 隔离形态：v1 仅 inlay（与现有 [脚本] 项同一渲染路径） */
  mode?: "inlay";
  /**
   * 兼容模式：
   * - "ms-script-env"：注入与老脚本项等价的局部 MS_SCRIPT_ENV（老 view:js 可零改动迁移）
   */
  compat?: "ms-script-env";
  /**
   * 关闭界面时的行为（默认 minimize；纯前端插件的**建议值**来源）。
   *
   * 与 `backend.closeBehavior` 是同一个开关的两处声明（有效值只有一个，
   * 存在注册表的 `PluginRecord.closeBehavior` 里）：带后台进程的插件写
   * `backend.closeBehavior` 即可，纯前端插件（没有 backend）用这里的字段
   * 表达「关闭界面时是否保留界面」的诉求。两处都写且不一致时安装会给出告警。
   */
  closeBehavior?: PluginCloseBehavior;
}

/** 贡献点：插件自己的设置页 */
export interface PluginSettingsPanelContribution {
  entry: string;
  title?: string;
}

export interface PluginContributes {
  searchItem?: PluginSearchItemContribution | PluginSearchItemContribution[];
  command?: PluginCommandContribution[];
  detailView?: PluginDetailViewContribution;
  settingsPanel?: PluginSettingsPanelContribution;
}

/** 插件清单 */
export interface PluginManifest {
  /** 反向域名式唯一 id，如 com.zhuangjie.ai-ask */
  id: string;
  name: string;
  version: string;
  /** 按哪一版插件 API 编写 */
  apiVersion: number;
  /** 要求的最低宿主版本（如 "7.9.15"） */
  minAppVersion?: string;
  author?: string;
  description?: string;
  homepage?: string;
  /** 图标相对路径 */
  icon?: string;
  license?: string;
  /** 必需权限（缺失则拒绝安装/启动） */
  permissions?: string[];
  /** 可选权限（缺失时功能降级，可在面板里随时授予） */
  optionalPermissions?: string[];
  contributes?: PluginContributes;
  backend?: PluginBackendSpec;
}

/** 校验结果 */
export type ManifestParseResult =
  | { ok: true; manifest: PluginManifest; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

/** 数值字段的合法区间（越界即夹紧，不算错误——避免第三方程子写错就让插件装不上） */
const NUMBER_LIMITS = {
  startupTimeoutMs: { min: 200, max: 30000, def: 3000 },
  callTimeoutMs: { min: 1000, max: 300000, def: 30000 },
  idleExitSec: { min: 0, max: 86400, def: 30 },
  graceSec: { min: 0, max: 3600, def: 5 },
  shutdownTimeoutSec: { min: 0, max: 60, def: 5 },
  maxRestarts: { min: 0, max: 20, def: 3 },
} as const;

/** 反向域名 id：至少两段，允许字母数字与中划线，段不以中划线开头/结尾 */
const ID_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
/** 语义化版本（允许预发布后缀，不强制三段携带 build 元数据） */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/** 关键词前缀里的分隔符（与 script-runtime 的 SEARCH_BOUNDARY 一致） */
export const COMMAND_BOUNDARY = " : ";

/** 是否为合法插件 id */
export function isValidPluginId(id: unknown): boolean {
  if (typeof id !== "string") return false;
  if (id.length === 0 || id.length > 128) return false;
  if (RESERVED_IDS.includes(id)) return false;
  return ID_PATTERN.test(id);
}

/** 是否为合法版本号 */
export function isValidVersion(v: unknown): boolean {
  return typeof v === "string" && VERSION_PATTERN.test(v);
}

/**
 * 入口路径安全校验：必须是插件目录内的相对路径。
 * 这是防路径穿越（zip-slip）的第一道闸门，Rust 侧安装时还会再验一次。
 */
export function isSafeRelativePath(p: unknown): boolean {
  if (typeof p !== "string") return false;
  const s = p.trim();
  if (s.length === 0 || s.length > 512) return false;
  if (s.includes("\0")) return false;
  // 反斜杠统一按分隔符看待（Windows 作者写 .\ui\x.html 也要拦）
  const normalized = s.replace(/\\/g, "/");
  if (normalized.startsWith("/")) return false;
  if (/^[A-Za-z]:/.test(normalized)) return false;
  if (normalized.includes("://")) return false;
  const parts = normalized.split("/");
  if (parts.some((seg) => seg === "..")) return false;
  return true;
}

/**
 * 图标字段的取值校验：三种形态之一
 *   1. 插件目录内的相对路径（`icon.png`、`assets/logo.svg`）——由宿主读成 data URL；
 *   2. `data:` 内联资源（图标很小，作者常直接内联）；
 *   3. `http(s):` 网络地址（如第三方 favicon 服务）。
 *
 * 第 3 种是刻意支持的：图标只是**展示**用途，由 WebView 直接加载，
 * 不经过宿主的网络代理（也就不涉及 `net.fetch` 权限与 SSRF 面）。
 * 但仍要求是 http(s)，挡掉 `javascript:` / `file:` 这类会在 <img src> 里
 * 产生意外行为的协议。
 */
export function isValidIconRef(p: unknown): boolean {
  if (typeof p !== "string") return false;
  const s = p.trim();
  if (s.length === 0) return false;
  if (s.startsWith("data:")) return true;
  if (/^https?:\/\//i.test(s)) return true;
  // 走到这里必须是「插件目录内的相对路径」。关键是先排掉**任何**带协议前缀
  // 的写法：`javascript:alert(1)` 既没有 `://` 也没有 `..`，会被
  // isSafeRelativePath 当成普通文件名放行，而它一旦落进 <img src> 就是
  // 可执行的 URL（同文档下就是 XSS 面）。协议头 = 冒号出现在任何斜杠之前。
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return false;
  return isSafeRelativePath(s);
}

/** 比较语义化版本（仅数字段，忽略预发布后缀），a>b 返回正数 */
export function compareVersion(a: string, b: string): number {
  const pick = (v: string): number[] =>
    v
      .split("-")[0]
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [pick(a), pick(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function clampNumber(v: unknown, key: keyof typeof NUMBER_LIMITS): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number.parseInt(String(v), 10);
  if (!Number.isFinite(n)) return null;
  const { min, max } = NUMBER_LIMITS[key];
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 归一化后台进程规格（补齐默认值 + 夹紧数值区间） */
export function normalizeBackendSpec(
  raw: unknown
): { ok: true; spec: PluginBackendSpec } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["backend.invalid"] };
  }
  const src = raw as Record<string, unknown>;
  const entry = asString(src.entry);
  if (!entry) {
    errors.push("backend.entry.missing");
  } else if (!isSafeRelativePath(entry)) {
    errors.push("backend.entry.unsafe");
  }

  const protocol = src.protocol;
  if (protocol != null && protocol !== "jsonrpc-stdio" && protocol !== "localhost-http") {
    errors.push("backend.protocol.invalid");
  }

  const autostart = src.autostart;
  if (autostart != null && !["always", "on-demand", "prompt", "never"].includes(String(autostart))) {
    errors.push("backend.autostart.invalid");
  }

  const closeBehavior = src.closeBehavior;
  if (closeBehavior != null && !["minimize", "exit"].includes(String(closeBehavior))) {
    errors.push("backend.closeBehavior.invalid");
  }

  let env: Record<string, string> | undefined;
  if (src.env != null) {
    if (typeof src.env !== "object" || Array.isArray(src.env)) {
      errors.push("backend.env.invalid");
    } else {
      env = {};
      for (const [k, v] of Object.entries(src.env as Record<string, unknown>)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
          errors.push(`backend.env.key.invalid:${k}`);
          continue;
        }
        env[k] = String(v ?? "");
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const spec: PluginBackendSpec = {
    entry: entry as string,
    protocol: (protocol as PluginBackendSpec["protocol"]) ?? "jsonrpc-stdio",
    autostart: (autostart as PluginAutostart) ?? "on-demand",
    closeBehavior: (closeBehavior as PluginCloseBehavior) ?? DEFAULT_CLOSE_BEHAVIOR,
  };
  for (const key of Object.keys(NUMBER_LIMITS) as Array<keyof typeof NUMBER_LIMITS>) {
    const n = clampNumber(src[key], key);
    if (n != null) (spec as unknown as Record<string, number>)[key] = n;
  }
  if (env) spec.env = env;
  return { ok: true, spec };
}

/** 归一化贡献点（searchItem 允许单对象或数组；命令 id 去重） */
function normalizeContributes(
  raw: unknown,
  errors: string[],
  warnings: string[]
): PluginContributes | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    errors.push("contributes.invalid");
    return undefined;
  }
  const src = raw as Record<string, unknown>;
  const out: PluginContributes = {};

  // ---- searchItem（单对象或数组）----
  const rawItems = src.searchItem == null ? [] : Array.isArray(src.searchItem) ? src.searchItem : [src.searchItem];
  const items: PluginSearchItemContribution[] = [];
  for (const [i, it] of rawItems.entries()) {
    if (it == null || typeof it !== "object") {
      errors.push(`contributes.searchItem.invalid:${i}`);
      continue;
    }
    const o = it as Record<string, unknown>;
    const title = asString(o.title);
    const keyword = asString(o.keyword);
    if (!title) errors.push(`contributes.searchItem.title.missing:${i}`);
    if (!keyword) errors.push(`contributes.searchItem.keyword.missing:${i}`);
    if (!title || !keyword) continue;
    const icon = asString(o.icon);
    if (icon && !isValidIconRef(icon)) {
      errors.push(`contributes.searchItem.icon.unsafe:${i}`);
    }
    items.push({
      title,
      keyword,
      desc: asString(o.desc) ?? undefined,
      icon: icon ?? undefined,
      resource: asString(o.resource) ?? undefined,
      visible: o.visible === undefined ? true : Boolean(o.visible),
    });
  }
  if (items.length === 1) out.searchItem = items[0];
  else if (items.length > 1) out.searchItem = items;

  // ---- command ----
  if (src.command != null) {
    if (!Array.isArray(src.command)) {
      errors.push("contributes.command.invalid");
    } else {
      const seen = new Set<string>();
      const cmds: PluginCommandContribution[] = [];
      for (const [i, it] of src.command.entries()) {
        if (it == null || typeof it !== "object") {
          errors.push(`contributes.command.invalid:${i}`);
          continue;
        }
        const o = it as Record<string, unknown>;
        const id = asString(o.id);
        const prefix = asString(o.prefix);
        const title = asString(o.title);
        if (!id) errors.push(`contributes.command.id.missing:${i}`);
        if (!prefix) errors.push(`contributes.command.prefix.missing:${i}`);
        if (!title) errors.push(`contributes.command.title.missing:${i}`);
        if (!id || !prefix || !title) continue;
        if (seen.has(id)) {
          errors.push(`contributes.command.id.duplicated:${id}`);
          continue;
        }
        seen.add(id);
        if (!prefix.includes(COMMAND_BOUNDARY)) {
          // 不是错误：宿主会按「关键词 + 空格」也能命中，但子关键词转发依赖分隔符
          warnings.push(`contributes.command.prefix.no_boundary:${id}`);
        }
        cmds.push({ id, prefix, title, desc: asString(o.desc) ?? undefined });
      }
      if (cmds.length > 0) out.command = cmds;
    }
  }

  // ---- detailView ----
  if (src.detailView != null) {
    if (typeof src.detailView !== "object" || Array.isArray(src.detailView)) {
      errors.push("contributes.detailView.invalid");
    } else {
      const o = src.detailView as Record<string, unknown>;
      const entry = asString(o.entry);
      if (!entry) errors.push("contributes.detailView.entry.missing");
      else if (!isSafeRelativePath(entry)) errors.push("contributes.detailView.entry.unsafe");
      else {
        if (o.mode != null && o.mode !== "inlay") errors.push("contributes.detailView.mode.unsupported");
        if (o.compat != null && o.compat !== "ms-script-env") {
          errors.push("contributes.detailView.compat.unsupported");
        }
        const closeBehavior = o.closeBehavior;
        if (closeBehavior != null && !["minimize", "exit"].includes(String(closeBehavior))) {
          errors.push("contributes.detailView.closeBehavior.invalid");
        }
        const script = asString(o.script);
        if (script && !isSafeRelativePath(script)) errors.push("contributes.detailView.script.unsafe");
        out.detailView = {
          entry,
          script: script ?? undefined,
          mode: "inlay",
          compat: o.compat === "ms-script-env" ? "ms-script-env" : undefined,
          closeBehavior:
            closeBehavior === "exit" || closeBehavior === "minimize"
              ? (closeBehavior as PluginCloseBehavior)
              : undefined,
        };
      }
    }
  }

  // ---- settingsPanel ----
  if (src.settingsPanel != null) {
    if (typeof src.settingsPanel !== "object" || Array.isArray(src.settingsPanel)) {
      errors.push("contributes.settingsPanel.invalid");
    } else {
      const o = src.settingsPanel as Record<string, unknown>;
      const entry = asString(o.entry);
      if (!entry) errors.push("contributes.settingsPanel.entry.missing");
      else if (!isSafeRelativePath(entry)) errors.push("contributes.settingsPanel.entry.unsafe");
      else out.settingsPanel = { entry, title: asString(o.title) ?? undefined };
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/** 权限串格式：`base` 或 `base:scope`（scope 由权限目录定义是否必需） */
export function splitPermission(raw: string): { base: string; scope: string | null } {
  const idx = raw.indexOf(":");
  if (idx < 0) return { base: raw.trim(), scope: null };
  return { base: raw.slice(0, idx).trim(), scope: raw.slice(idx + 1).trim() || null };
}

/**
 * 清单错误码 → 用户可读文案。
 *
 * 错误码是给机器判定的（测试断言、i18n 查表），但直接 `errors.join("; ")`
 * 弹给用户就成了「id.invalid; apiVersion.tooNew」这种天书。安装失败时
 * 用户至少要知道**哪一项**不对，所以这里统一翻译一层。
 */
export function describeManifestError(code: string): string {
  const [head, ...rest] = code.split(":");
  const arg = rest.join(":");
  switch (head) {
    case "json.invalid":
      return "plugin.json 不是合法的 JSON";
    case "manifest.invalid":
      return "清单内容不是一个 JSON 对象";
    case "id.missing":
      return "缺少插件 id";
    case "id.invalid":
      return "插件 id 非法（需为反向域名式，如 com.example.my-plugin；只能用小写字母、数字、中划线与点）";
    case "id.reservedPrefix":
      return `id 使用了官方保留前缀（${arg}），除非确实是你自己发布的插件，否则建议改名`;
    // 警告码（会拼进安装确认弹窗，同样需要人话）
    case "contributes.command.prefix.no_boundary":
      return `命令「${arg}」的前缀里没有分隔符：仍能用「前缀 + 空格」唤起，但「前缀 : 子词」的子搜索转发会失效`;
    case "name.missing":
      return "缺少插件名称（name）";
    case "name.tooLong":
      return "插件名称过长（上限 48 字）";
    case "version.missing":
      return "缺少版本号（version）";
    case "version.invalid":
      return "版本号格式非法（需形如 1.0.0）";
    case "apiVersion.missing":
      return "缺少插件 API 版本（apiVersion）";
    case "apiVersion.invalid":
      return "插件 API 版本非法（应为大于等于 1 的整数）";
    case "apiVersion.tooNew":
      return `插件要求的 API 版本（${arg || "?"}）高于本应用支持的版本（${PLUGIN_API_VERSION}），请升级应用`;
    case "minAppVersion.invalid":
      return "minAppVersion 格式非法（需形如 7.9.15）";
    case "minAppVersion.tooNew":
      return `插件要求应用版本不低于 ${arg}，当前版本过低，请先升级应用`;
    case "icon.unsafe":
      return "图标路径不安全（不允许绝对路径或 .. 上跳）";
    case "permissions.invalid":
      return "permissions 必须是字符串数组";
    case "permissions.entry.invalid":
      return "permissions 里存在空项或非字符串项";
    case "permissions.unknown":
      return `声明了未知权限：${arg}`;
    case "permissions.scope.missing":
      return `权限「${arg}」缺少必需的 scope（如 net.fetch:https://api.example.com/*）`;
    case "permissions.scope.invalid":
      return `权限「${arg}」的 scope 写法不合法`;
    case "permissions.overlap":
      return `权限「${arg}」同时出现在 permissions 与 optionalPermissions`;
    case "optionalPermissions.invalid":
      return "optionalPermissions 必须是字符串数组";
    case "optionalPermissions.entry.invalid":
      return "optionalPermissions 里存在空项或非字符串项";
    case "optionalPermissions.unknown":
      return `声明了未知的可选权限：${arg}`;
    case "optionalPermissions.scope.missing":
      return `可选权限「${arg}」缺少必需的 scope`;
    case "optionalPermissions.scope.invalid":
      return `可选权限「${arg}」的 scope 写法不合法`;
    case "contributes.invalid":
      return "contributes 必须是一个对象";
    case "contributes.searchItem.invalid":
      return "contributes.searchItem 必须是对象或对象数组";
    case "contributes.searchItem.title.missing":
      return `第 ${arg} 个搜索项缺少 title`;
    case "contributes.searchItem.keyword.missing":
      return `第 ${arg} 个搜索项缺少 keyword`;
    case "contributes.searchItem.icon.unsafe":
      return `第 ${arg} 个搜索项的图标路径不安全`;
    case "contributes.command.invalid":
      return arg ? `第 ${arg} 个命令不是合法对象` : "contributes.command 必须是数组";
    case "contributes.command.id.missing":
      return `第 ${arg} 个命令缺少 id`;
    case "contributes.command.prefix.missing":
      return `第 ${arg} 个命令缺少 prefix`;
    case "contributes.command.title.missing":
      return `第 ${arg} 个命令缺少 title`;
    case "contributes.command.id.duplicated":
      return `命令 id 重复：${arg}`;
    case "contributes.detailView.invalid":
      return "contributes.detailView 必须是一个对象";
    case "contributes.detailView.entry.missing":
      return "contributes.detailView 缺少入口文件（entry）";
    case "contributes.detailView.entry.unsafe":
      return "contributes.detailView.entry 路径不安全";
    case "contributes.detailView.script.unsafe":
      return "contributes.detailView.script 路径不安全";
    case "contributes.detailView.mode.unsupported":
      return "contributes.detailView.mode 暂只支持 inlay";
    case "contributes.detailView.compat.unsupported":
      return "contributes.detailView.compat 暂只支持 ms-script-env";
    case "contributes.settingsPanel.invalid":
      return "contributes.settingsPanel 必须是一个对象";
    case "contributes.settingsPanel.entry.missing":
      return "contributes.settingsPanel 缺少入口文件（entry）";
    case "contributes.settingsPanel.entry.unsafe":
      return "contributes.settingsPanel.entry 路径不安全";
    case "backend.invalid":
      return "backend 必须是一个对象";
    case "backend.entry.missing":
      return "backend 缺少可执行文件入口（entry）";
    case "backend.entry.unsafe":
      return "backend.entry 路径不安全（必须位于插件目录内）";
    case "backend.protocol.invalid":
      return "backend.protocol 只支持 jsonrpc-stdio / localhost-http";
    case "backend.autostart.invalid":
      return "backend.autostart 只支持 always / on-demand / prompt / never";
    case "backend.closeBehavior.invalid":
      return "backend.closeBehavior 只支持 minimize（关闭界面时最小化）/ exit（关闭界面时退出后台进程）";
    case "backend.closeBehavior.conflictsWithAlways":
      return "同时声明了「开机自启」与「关闭界面时退出」：两者冲突，生效时以开机自启为准（进程常驻，关闭界面不会停止）";
    case "contributes.detailView.closeBehavior.invalid":
      return "contributes.detailView.closeBehavior 只支持 minimize（关闭界面时保留界面）/ exit（关闭界面时卸载界面）";
    case "contributes.detailView.closeBehavior.conflictsWithBackend":
      return "contributes.detailView.closeBehavior 与 backend.closeBehavior 声明不一致：生效时以 detailView 的声明为准";

    case "backend.env.invalid":
      return "backend.env 必须是「环境变量名 → 值」的对象";
    case "backend.env.key.invalid":
      return `环境变量名非法：${arg}`;
    case "backend.withoutSpawnPermission":
      return "声明了 backend 但没有申请 backend.spawn 权限";
    case "spawnPermission.withoutBackend":
      return "申请了 backend.spawn 权限但没有声明 backend";
    default:
      return code;
  }
}

/** 批量翻译错误码（保持顺序，去掉重复项） */
export function describeManifestErrors(errors: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const code of errors) {
    const text = describeManifestError(code);
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/**
 * 校验清单要求的最低宿主版本是否满足当前应用版本。
 *
 * 单独成函数（而不是塞进 `parsePluginManifest`）的原因：清单解析是纯函数、
 * 与「当前应用版本」无关；宿主版本由构建期注入（`__APP_VERSION__`），
 * 浏览器调试环境下可能取不到，取不到时不做拦截（返回 ok）。
 *
 * @returns ok=false 时 `error` 为可直接展示的文案
 */
export function checkMinAppVersion(
  manifest: PluginManifest,
  hostVersion: string | null | undefined
): { ok: true } | { ok: false; error: string } {
  const need = manifest.minAppVersion;
  if (!need || !hostVersion) return { ok: true };
  if (compareVersion(hostVersion, need) >= 0) return { ok: true };
  return {
    ok: false,
    error: `该插件要求应用版本不低于 ${need}，当前版本为 ${hostVersion}，请先升级应用`,
  };
}

/**
 * 解析并校验插件清单。
 *
 * @param raw 清单对象或 JSON 字符串（来自 plugin.json）
 * @param checkPermissions 权限串校验函数（注入以避免循环依赖，见 permissions.ts）
 * @returns 成功返回归一化后的清单；失败返回错误码数组（永不抛异常）
 */
export function parsePluginManifest(
  raw: unknown,
  checkPermissions?: (id: string) => boolean
): ManifestParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  let obj: Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch (e) {
      return { ok: false, errors: ["json.invalid"], warnings };
    }
  } else if (raw != null && typeof raw === "object" && !Array.isArray(raw)) {
    obj = raw as Record<string, unknown>;
  } else {
    return { ok: false, errors: ["manifest.invalid"], warnings };
  }

  // ---- 必填：id / name / version / apiVersion ----
  const id = asString(obj.id);
  if (!id) errors.push("id.missing");
  else if (!isValidPluginId(id)) errors.push("id.invalid");
  else if (RESERVED_ID_PREFIXES.some((p) => id.startsWith(p)) && id !== "com.mysearch.builtin") {
    // 官方前缀（com.mysearch.* / mysearch.*）声明为保留；但**不做硬拦截**：
    // 「本地文件安装」是用户主动选择的行为，宿主也没有签名/市场可用来判定谁算官方，
    // 拦下来只会让官方示例插件（plugins/ 目录里的那些）装不上。
    // 因此降级为警告，由安装确认弹窗提示用户「这不是官方插件」。
    warnings.push(`id.reservedPrefix:${id}`);
  }

  const name = asString(obj.name);
  if (!name) errors.push("name.missing");
  else if (name.length > 48) errors.push("name.tooLong");

  const version = asString(obj.version);
  if (!version) errors.push("version.missing");
  else if (!isValidVersion(version)) errors.push("version.invalid");

  const apiVersionRaw = obj.apiVersion;
  const apiVersion = typeof apiVersionRaw === "number" ? apiVersionRaw : Number.parseInt(String(apiVersionRaw ?? ""), 10);
  if (!Number.isFinite(apiVersion)) errors.push("apiVersion.missing");
  else if (apiVersion > PLUGIN_API_VERSION) errors.push("apiVersion.tooNew");
  else if (apiVersion < 1) errors.push("apiVersion.invalid");

  const minAppVersion = asString(obj.minAppVersion);
  if (minAppVersion && !/^\d+(\.\d+)*$/.test(minAppVersion)) {
    errors.push("minAppVersion.invalid");
  }

  const icon = asString(obj.icon);
  if (icon && !isValidIconRef(icon)) errors.push("icon.unsafe");

  // ---- 权限 ----
  const permissions = normalizePermissionList(obj.permissions, "permissions", errors, checkPermissions);
  const optionalPermissions = normalizePermissionList(
    obj.optionalPermissions,
    "optionalPermissions",
    errors,
    checkPermissions
  );
  const overlap = permissions.filter((p) => optionalPermissions.includes(p));
  if (overlap.length > 0) {
    errors.push(`permissions.overlap:${overlap[0]}`);
  }

  const contributes = normalizeContributes(obj.contributes, errors, warnings);

  // ---- 后台进程与 backend.spawn 权限的一致性 ----
  let backend: PluginBackendSpec | undefined;
  if (obj.backend != null) {
    const r = normalizeBackendSpec(obj.backend);
    if (!r.ok) errors.push(...r.errors);
    else backend = r.spec;
  }
  const allPerms = [...permissions, ...optionalPermissions];
  const declaresSpawn = allPerms.some((p) => splitPermission(p).base === "backend.spawn");
  if (backend && !declaresSpawn) {
    errors.push("backend.withoutSpawnPermission");
  }
  if (!backend && declaresSpawn) {
    errors.push("spawnPermission.withoutBackend");
  }
  // 两个行为默认值互相矛盾：开机自启要求进程常驻，而「关闭界面即退出」要求
  // 进程随界面走。不拦（用户的选择才是最终值），但要在安装确认里说清楚：
  // 生效时以「开机自启」为准，关闭界面不会停止进程。
  if (backend && backend.autostart === "always" && backend.closeBehavior === "exit") {
    warnings.push("backend.closeBehavior.conflictsWithAlways");
  }
  // 同一个开关的两种写法（backend.closeBehavior / contributes.detailView.closeBehavior）
  // 不一致时，插件作者的本意无法推断——按「界面入口自己的声明优先」处理并告警。
  if (
    backend?.closeBehavior &&
    contributes?.detailView?.closeBehavior &&
    backend.closeBehavior !== contributes.detailView.closeBehavior
  ) {
    warnings.push("contributes.detailView.closeBehavior.conflictsWithBackend");
  }

  if (errors.length > 0) return { ok: false, errors, warnings };

  const manifest: PluginManifest = {
    id: id as string,
    name: name as string,
    version: version as string,
    apiVersion,
    minAppVersion: minAppVersion ?? undefined,
    author: asString(obj.author) ?? undefined,
    description: asString(obj.description) ?? undefined,
    homepage: asString(obj.homepage) ?? undefined,
    icon: icon ?? undefined,
    license: asString(obj.license) ?? undefined,
    permissions: permissions.length > 0 ? permissions : undefined,
    optionalPermissions: optionalPermissions.length > 0 ? optionalPermissions : undefined,
    contributes,
    backend,
  };
  return { ok: true, manifest, warnings };
}

function normalizePermissionList(
  raw: unknown,
  field: string,
  errors: string[],
  checkPermissions?: (id: string) => boolean
): string[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    errors.push(`${field}.invalid`);
    return [];
  }
  const out: string[] = [];
  for (const item of raw) {
    const s = asString(item);
    if (!s) {
      errors.push(`${field}.entry.invalid`);
      continue;
    }
    const { base, scope } = splitPermission(s);
    // 基础 id 是否被宿主认识：**不能**用 `checkPermissions(base)` 判断——
    // 对 net.fetch / secret.read 这类「scope 必需」的权限，基础 id 单独传入
    // 永远返回 false（因为缺 scope），会把「缺 scope」误报成「未知权限」。
    // permissions.ts 是无依赖的叶子模块，这里直接查目录最准确。
    const baseKnown = getPermissionSpec(base) != null;
    if (checkPermissions && !baseKnown) {
      errors.push(`${field}.unknown:${s}`);
      continue;
    }
    if (checkPermissions && !checkPermissions(s)) {
      // 基础 id 认识、但整串不合法 → 基本都是 scope 缺失/写法不对
      errors.push(scope ? `${field}.scope.invalid:${s}` : `${field}.scope.missing:${base}`);
      continue;
    }
    if (out.includes(s)) continue;
    out.push(s);
  }
  return out;
}

/**
 * 计算「本次升级新增的必需权限」——用于安装/升级时的重新授权。
 * 已授权集合里已有（或已被更宽的 scope 覆盖）的不算新增。
 */
export function diffNewPermissions(
  oldGranted: string[],
  newManifest: PluginManifest,
  covers: (granted: string, request: string) => boolean
): string[] {
  const required = newManifest.permissions ?? [];
  return required.filter((req) => !oldGranted.some((g) => covers(g, req)));
}

/** 取插件贡献的所有搜索项（统一成数组） */
export function listSearchItems(m: PluginManifest): PluginSearchItemContribution[] {
  const v = m.contributes?.searchItem;
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

/** 取插件声明的命令 */
export function listCommands(m: PluginManifest): PluginCommandContribution[] {
  return m.contributes?.command ?? [];
}

/**
 * 取插件对「关闭界面时」的建议值（清单侧的**唯一**口径）。
 *
 * 优先级：`contributes.detailView.closeBehavior` → `backend.closeBehavior` → 默认 minimize。
 * 界面入口自己的声明优先，因为「关闭界面时保留/卸载界面」首先说的是界面；
 * 没有 detailView 的插件（纯命令/纯后台）由 backend 的声明代表。
 */
export function detailViewCloseBehaviorOf(
  m: PluginManifest | null | undefined
): PluginCloseBehavior {
  const fromView = m?.contributes?.detailView?.closeBehavior;
  if (fromView === "exit" || fromView === "minimize") return fromView;
  const fromBackend = m?.backend?.closeBehavior;
  if (fromBackend === "exit" || fromBackend === "minimize") return fromBackend;
  return DEFAULT_CLOSE_BEHAVIOR;
}
