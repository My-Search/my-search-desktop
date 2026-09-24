/**
 * 插件市场目录（catalog.json）schema 与校验 —— 纯函数，便于单测。
 *
 * 这是市场插件的唯一数据契约：市场 UI 的列表、详情、安装按钮全部以这里的
 * 类型为准。与 manifest.ts 同一套风格：**永不抛异常**，失败返回可读错误码，
 * 校验在解析期掐死「下载地址越权 / 哈希缺失 / 重复条目」三类硬伤。
 *
 * 安全设计：
 *   - `downloadUrl` 限定 https + host 白名单（github.com 的 Release 资产路径），
 *     目录被攻破时也只能把下载指向白名单 host——真正的完整性靠 sha256
 *     （客户端安装前验）。允许指向开发者自己仓库，是为了让开发者自助发版，
 *     准入由 `plugins/sources.json` 的审核名单控制。
 *   - `sha256` 必须是 64 位小写 hex，缺则整条目拒绝。
 *   - 同一 id 重复出现时取版本更高的一条；版本相同视为冲突拒绝（防漂移）。
 */

import { compareVersion, isValidPluginId, isValidVersion } from "./manifest.ts";

/** 目录结构版本（与插件 apiVersion 是两套概念，各自演进） */
export const MARKET_CATALOG_SCHEMA_VERSION = 1;

/** 目录文件名（仓库根 / Pages 部署根） */
export const MARKET_CATALOG_FILE = "catalog.json";

/** SHA-256 摘要：64 位小写十六进制 */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** 目录解析结果 */
export type CatalogParseResult =
  | { ok: true; catalog: MarketCatalog }
  | { ok: false; errors: string[] };

/** 目录顶层 */
export interface MarketCatalog {
  schemaVersion: 1;
  /** 生成时间（ISO） */
  generatedAt: string;
  /**
   * 下载前缀（受控根），如
   * `https://github.com/<org>/mysearch-plugin-market/releases/download`。
   * 目录内每条 `downloadUrl` 必须以此开头。
   */
  baseUrl: string;
  plugins: MarketPluginEntry[];
}

/** 目录里的一条插件元数据（用于列表 / 详情 / 安装预处理） */
export interface MarketPluginEntry {
  /** 与 plugin.json.id 一致的反向域名 */
  id: string;
  name: string;
  /** SemVer */
  version: string;
  /** 目标插件 API 面版本 */
  apiVersion: number;
  /** 最低宿主版本：低于当前应用版本则在前端隐藏（Raycast 式兼容过滤） */
  minAppVersion?: string;
  author: string;
  homepage?: string;
  /** data: / http(s): 直出（目录不做相对路径图标，规避读包 IPC） */
  icon?: string;
  categories: string[];
  tags?: string[];
  /** 卡片摘要（UI 截断 ≤120 字） */
  description: string;
  changelog?: string;
  /** 完整 URL，必须以 baseUrl 为前缀；安装前宿主与前端会再对 sha256 验包 */
  downloadUrl: string;
  /** .mspp 包摘要（CI 计算填入，作者不手写） */
  sha256: string;
  /** 包字节数（列表展示） */
  size?: number;
  /** 声明权限（来自清单，安装确认时预填展示；真正校验在安装管线） */
  permissions: string[];
  /** com.mysearch.* 第一方插件 */
  official?: boolean;
  /** 第三方策展徽标（维护组评审后标记） */
  verified?: boolean;
  downloads?: number;
  /**
   * 已废弃：作者归档仓库、或维护组主动下架。
   * 仅作**提醒**用途 —— 市场 UI 会打徽标并说明原因，但**不禁止安装**
   * （用户可能仍在依赖它，或需要装来迁移数据）。
   */
  deprecated?: boolean;
  /** 废弃原因（面向用户展示） */
  deprecatedReason?: string;
  publishedAt: string;
  updatedAt: string;
}

/* ============================================================
 * 基础校验工具（无依赖，避免把 manifest 的解析器拖进来）
 * ============================================================ */

/** 非空字符串 */
function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** http(s) URL；https 强制，仅 localhost/127.0.0.1 允许 http（本地目录服务调试用） */
function isWebUrl(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const m = /^(https?):\/\/([^/]+)/i.exec(v);
  if (!m) return false;
  const scheme = m[1].toLowerCase();
  if (scheme === "https") return true;
  if (scheme === "http") {
    const host = m[2].split(":")[0].toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  }
  return false;
}

/** 版本号与 id 复用 manifest 的语法（同一套契约，不另造） */
const validVersion = (v: unknown): boolean => isValidVersion(v);
const validPluginId = (v: unknown): boolean => isValidPluginId(v);

/**
 * 下载地址允许的 host 白名单。
 *
 * 插件包可以托管在开发者自己的仓库里（审核一次入 sources.json，之后开发者自行发版），
 * 因此 downloadUrl 不再要求以目录的单一 baseUrl 为前缀。真正收紧的是 host：
 *   - `github.com`           —— 开发者仓库的 Release 资产
 *   - 官方 market 仓库       —— 第一方插件（与 Rust DEFAULT_MARKET_BASE 同源）
 * 与 Rust 侧 `is_allowed_release_url` 同一口径：**两侧必须一起改**，
 * 前端这层只是数据契约校验，真正的安全边界在 Rust（下载时再判一次）。
 */
const ALLOWED_DOWNLOAD_HOSTS = [
  "github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
];

/** 解析 URL 的 host（小写，去端口与 userinfo）；无法解析/含 userinfo/非标端口返回 null */
function urlHostOf(v: string): string | null {
  // 拒绝 userinfo：https://github.com@evil.com 的真实 host 是 evil.com，
  // 任何按字符串前缀判断的写法都会中招，这里直接判死。
  const m = /^https:\/\/([^/?#]+)/i.exec(v);
  if (!m) return null;
  const authority = m[1];
  if (authority.includes("@")) return null;
  const colon = authority.lastIndexOf(":");
  if (colon >= 0) {
    // 端口必须为空或缺省 443；github.com:8443 不能借非标端口绕过
    const port = authority.slice(colon + 1);
    if (port !== "443") return null;
  }
  const host = (colon >= 0 ? authority.slice(0, colon) : authority).toLowerCase();
  return host || null;
}

/**
 * 是否为允许的插件包下载地址。允许两种形态（host + 路径双重收紧）：
 *
 * 1. Release 资产：`github.com/<owner>/<repo>/releases/download/<tag>/<asset>`
 *    —— 第三方插件在自己的仓库发 Release；
 * 2. 官方插件目录（仓库文件直链）：
 *    `raw.githubusercontent.com/<owner>/<repo>/<ref>/official-plugins/<id>/<版本>/<id>.mspp`
 *    —— 官方插件按版本归档，免去逐个建 Release。
 *
 * （http 仅放行 localhost，供本地目录服务调试）
 *
 * 与 Rust 侧 `is_allowed_release_url`（market.rs）同一口径，**两侧必须一起改**。
 */
export function isAllowedDownloadUrl(v: unknown): boolean {
  if (typeof v !== "string" || v.length === 0) return false;
  if (v.startsWith("http://")) {
    // 本地目录服务调试：仅 localhost，端口不限
    const m = /^http:\/\/([^/?#]+)/i.exec(v);
    if (!m) return false;
    const host = m[1].split(":")[0].toLowerCase();
    return host === "localhost" || host === "127.0.0.1";
  }
  const host = urlHostOf(v);
  if (!host || !ALLOWED_DOWNLOAD_HOSTS.includes(host)) return false;
  const schemeEnd = v.indexOf("://") + 3;
  const slash = v.indexOf("/", schemeEnd);
  const path = slash < 0 ? "" : v.slice(slash);

  // 官方插件目录：owner/repo/ref/official-plugins/<id>/<版本>/<资产>.mspp（严格 7 段）
  if (host === "raw.githubusercontent.com") {
    const segs = path.replace(/^\//, "").split("/");
    if (segs.length !== 7 || segs.some((s) => s === "")) return false;
    if (segs[3] !== "official-plugins") return false;
    return segs[6].endsWith(".mspp");
  }

  // GitHub 资产 302 的真实终点，路径不含 release 段，host 本身即受控
  if (host === "objects.githubusercontent.com") return path.startsWith("/") && path.length > 1;
  const MARKER = "/releases/download/";
  const idx = path.indexOf(MARKER);
  if (idx < 0) return false;
  const ownerRepo = path.slice(0, idx).replace(/^\//, "").split("/");
  if (ownerRepo.length !== 2 || ownerRepo.some((s) => s === "")) return false;
  const tagAsset = path.slice(idx + MARKER.length).split("/");
  return tagAsset.length === 2 && tagAsset.every((s) => s !== "");
}


/* ============================================================
 * 解析与校验
 * ============================================================ */

/**
 * 解析并校验目录。失败返回错误码数组（可读文案见 describeCatalogErrors）。
 * 注意：解析成功 ≠ 目录可信——是否接受还取决于块名单与签名（P5）。
 */
export function parseCatalog(raw: unknown): CatalogParseResult {
  let obj: Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { ok: false, errors: ["json.invalid"] };
    }
  } else if (raw != null && typeof raw === "object" && !Array.isArray(raw)) {
    obj = raw as Record<string, unknown>;
  } else {
    return { ok: false, errors: ["catalog.invalid"] };
  }

  const errors: string[] = [];

  if (obj.schemaVersion !== MARKET_CATALOG_SCHEMA_VERSION) {
    errors.push(`catalog.schemaVersion.unsupported:${String(obj.schemaVersion ?? "")}`);
  }
  if (!asString(obj.generatedAt)) errors.push("catalog.generatedAt.missing");

  const baseUrl = asString(obj.baseUrl);
  if (!baseUrl) {
    errors.push("catalog.baseUrl.missing");
  } else if (!isWebUrl(baseUrl)) {
    errors.push("catalog.baseUrl.invalid");
  }

  const rawPlugins = obj.plugins;
  if (!Array.isArray(rawPlugins)) {
    errors.push("catalog.plugins.invalid");
  } else {
    for (const [i, it] of rawPlugins.entries()) {
      const prefix = `entry:${i}:`;
      if (it == null || typeof it !== "object" || Array.isArray(it)) {
        errors.push(`${prefix}invalid`);
        continue;
      }
      const e = it as Record<string, unknown>;
      const id = asString(e.id);
      if (!id) errors.push(`${prefix}id.missing`);
      else if (!validPluginId(id)) errors.push(`${prefix}id.invalid`);

      const name = asString(e.name);
      if (!name) errors.push(`${prefix}name.missing`);
      else if (name.length > 128) errors.push(`${prefix}name.tooLong`);

      const version = asString(e.version);
      if (!version) errors.push(`${prefix}version.missing`);
      else if (!validVersion(version)) errors.push(`${prefix}version.invalid`);

      const apiVersion = typeof e.apiVersion === "number" ? e.apiVersion : Number.NaN;
      if (!Number.isFinite(apiVersion) || apiVersion < 1) errors.push(`${prefix}apiVersion.invalid`);

      const minAppVersion = asString(e.minAppVersion);
      if (minAppVersion && !validVersion(minAppVersion)) errors.push(`${prefix}minAppVersion.invalid`);

      if (!asString(e.author)) errors.push(`${prefix}author.missing`);
      if (!asString(e.description)) errors.push(`${prefix}description.missing`);

      const categories = e.categories;
      if (!Array.isArray(categories) || categories.length === 0) {
        errors.push(`${prefix}categories.invalid`);
      } else if (!categories.every((c) => typeof c === "string" && c.length > 0)) {
        errors.push(`${prefix}categories.invalid`);
      }

      const permissions = e.permissions;
      if (!Array.isArray(permissions) || !permissions.every((p) => typeof p === "string" && p.length > 0)) {
        errors.push(`${prefix}permissions.invalid`);
      }

      // 下载地址硬约束：https + host 在允许白名单内 + 位于 Release 资产路径下。
      // 注意：不再要求以目录 baseUrl 为前缀——插件包可托管在开发者自己的仓库
      // （见 plugins/sources.json 的准入名单），Rust 侧下载时按 host 再判一次。
      const downloadUrl = asString(e.downloadUrl);
      if (!downloadUrl) {
        errors.push(`${prefix}downloadUrl.missing`);
      } else if (!isAllowedDownloadUrl(downloadUrl)) {
        errors.push(`${prefix}downloadUrl.notAllowed`);
      }

      const sha256 = asString(e.sha256);
      if (!sha256 || !SHA256_HEX.test(sha256)) errors.push(`${prefix}sha256.invalid`);

      const size = e.size;
      if (size != null && (typeof size !== "number" || !Number.isFinite(size) || size < 0)) {
        errors.push(`${prefix}size.invalid`);
      }

      const official = e.official;
      const verified = e.verified;
      if (official != null && typeof official !== "boolean") errors.push(`${prefix}official.invalid`);
      if (verified != null && typeof verified !== "boolean") errors.push(`${prefix}verified.invalid`);
      if (e.deprecated != null && typeof e.deprecated !== "boolean") errors.push(`${prefix}deprecated.invalid`);

      const publishedAt = asString(e.publishedAt);
      if (!publishedAt) errors.push(`${prefix}publishedAt.missing`);
      if (!asString(e.updatedAt)) errors.push(`${prefix}updatedAt.missing`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // 去重：同一 id 保留更高版本；版本相同判冲突
  const rawList = Array.isArray(rawPlugins) ? rawPlugins : [];
  const seen = new Map<string, MarketPluginEntry>();
  const dupError: string[] = [];
  for (const [i, it] of rawList.entries()) {
    const e = it as Record<string, unknown>;
    const id = e.id as string;
    const pending: MarketPluginEntry = {
      id,
      name: e.name as string,
      version: e.version as string,
      apiVersion: e.apiVersion as number,
      minAppVersion: asString(e.minAppVersion),
      author: e.author as string,
      homepage: asString(e.homepage),
      icon: asString(e.icon),
      categories: e.categories as string[],
      tags: Array.isArray(e.tags) ? (e.tags as string[]).filter((t) => typeof t === "string") : undefined,
      description: e.description as string,
      changelog: asString(e.changelog),
      downloadUrl: e.downloadUrl as string,
      sha256: e.sha256 as string,
      size: typeof e.size === "number" ? e.size : undefined,
      permissions: e.permissions as string[],
      official: typeof e.official === "boolean" ? e.official : undefined,
      verified: typeof e.verified === "boolean" ? e.verified : undefined,
      downloads: typeof e.downloads === "number" ? e.downloads : undefined,
      deprecated: e.deprecated === true ? true : undefined,
      deprecatedReason: asString(e.deprecatedReason),
      publishedAt: e.publishedAt as string,
      updatedAt: e.updatedAt as string,
    };
    if (seen.has(id)) {
      const prev = seen.get(id)!;
      const cmp = compareVersion(pending.version, prev.version);
      if (cmp > 0) seen.set(id, pending);
      else if (cmp === 0) dupError.push(`entry:${i}:duplicate:${pending.id}`);
      // cmp < 0：保留更高的 prev，跳过本条
    } else {
      seen.set(id, pending);
    }
  }
  if (dupError.length > 0) return { ok: false, errors: dupError };

  return {
    ok: true,
    catalog: {
      schemaVersion: MARKET_CATALOG_SCHEMA_VERSION,
      generatedAt: obj.generatedAt as string,
      baseUrl: baseUrl as string,
      plugins: [...seen.values()],
    },
  };
}

/** 错误码 → 可读中文文案（用户直接看，不给天书） */
export function describeCatalogErrors(errors: readonly string[]): string[] {
  return errors.map((err) => {
    // 顶层错误 `catalog.*` / `json.invalid`
    if (!err.startsWith("entry:")) {
      const [code, arg] = splitOnce(err);
      switch (code) {
        case "json.invalid":
          return "目录 JSON 解析失败";
        case "catalog.invalid":
          return "目录数据不是合法对象";
        case "catalog.schemaVersion.unsupported":
          return `不支持的目录结构版本：${arg || "未知"}`;
        case "catalog.generatedAt.missing":
          return "目录缺少生成时间";
        case "catalog.baseUrl.missing":
          return "目录缺少下载前缀（baseUrl）";
        case "catalog.baseUrl.invalid":
          return "下载前缀必须是 https 地址（本地调试可用 localhost）";
        case "catalog.plugins.invalid":
          return "目录缺少插件列表（plugins 必须是数组）";
        default:
          return `目录校验失败：${err}`;
      }
    }
    // 条目错误 `entry:<i>:<code>[:<arg>]`
    const first = err.indexOf(":");
    const second = err.indexOf(":", first + 1);
    if (second < 0) return `目录校验失败：${err}`;
    const code = err.slice(second + 1);
    return describeEntryError(code);
  });
}

/** 条目的错误码 → 中文文案 */
function describeEntryError(code: string): string {
  if (code.startsWith("duplicate:")) return `插件「${code.slice("duplicate:".length)}」在目录里出现多条相同版本（目录冲突，已整体拒绝）`;
  switch (code) {
    case "invalid":
      return "条目不是合法对象";
    case "id.missing":
      return "缺少插件 id";
    case "id.invalid":
      return "插件 id 非法";
    case "name.missing":
      return "缺少插件名称";
    case "name.tooLong":
      return "插件名称过长（超过 128 字）";
    case "version.missing":
      return "缺少版本号";
    case "version.invalid":
      return "版本号格式非法";
    case "apiVersion.invalid":
      return "apiVersion 非法";
    case "minAppVersion.invalid":
      return "minAppVersion 格式非法";
    case "author.missing":
      return "缺少作者";
    case "description.missing":
      return "缺少描述";
    case "categories.invalid":
      return "分类必须是字符串数组";
    case "permissions.invalid":
      return "权限声明必须是字符串数组";
    case "downloadUrl.missing":
      return "缺少下载地址";
    case "downloadUrl.notAllowed":
      return "下载地址必须是 https 且位于 github.com 的 Release 资产路径下";
    case "downloadUrl.outOfBase":
      return "下载地址超出目录受控前缀";
    case "downloadUrl.insecure":
      return "下载地址必须走 https";
    case "sha256.invalid":
      return "sha256 校验值必须是 64 位十六进制";
    case "size.invalid":
      return "大小字段非法";
    case "official.invalid":
      return "official 必须是布尔值";
    case "verified.invalid":
      return "verified 必须是布尔值";
    case "deprecated.invalid":
      return "deprecated 必须是布尔值";
    case "publishedAt.missing":
      return "缺少发布时间";
    case "updatedAt.missing":
      return "缺少更新时间";
    default:
      return `未知错误（${code}）`;
  }
}

/** 从错误码里提取「名:值」结构 */
function splitOnce(s: string): [string, string] {
  const i = s.indexOf(":");
  return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)];
}

/**
 * 兼容过滤：只返回「当前应用版本满足 minAppVersion」的条目
 * （Raycast 的 OS/版本过滤在目录端的对应物）。
 */
export function compatibleEntries(catalog: MarketCatalog, appVersion: string): MarketPluginEntry[] {
  return catalog.plugins.filter(
    (p) => !p.minAppVersion || compareVersion(appVersion, p.minAppVersion) >= 0
  );
}