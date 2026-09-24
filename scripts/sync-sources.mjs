/**
 * 插件市场同步工具：按 `plugins/sources.json` 的准入名单，从各开发者仓库
 * 拉取插件包 → 校验 → 计算 sha256 → 生成 catalog.json 与发布命令。
 *
 * 用法：
 *   node scripts/sync-sources.mjs                # 同步全部源
 *   node scripts/sync-sources.mjs --only <id>    # 只同步指定插件 id
 *   node scripts/sync-sources.mjs --local <dir>  # 用本地目录当作 GitHub 仓库（离线/测试）
 *   node scripts/sync-sources.mjs --assets <dir> # 用本地已下载的资产目录（离线/测试）
 *
 * 工作流（开发者自助发布）：
 *   1. 开发者提 issue 报仓库地址 → 我们审核后在 `plugins/sources.json` 加一条；
 *   2. 开发者此后自行发版（在自己仓库建 Release、传 `<id>.mspp`），无需联系我们；
 *   3. 我们（或 CI 定时）跑本脚本，它拉取最新包、算哈希、更新索引。
 *
 * 设计约束（与客户端契约严格对齐）：
 *   - `downloadUrl` 指向**开发者仓库**的 Release 资产地址；
 *   - `sha256` 由本脚本对拉取到的**真实包字节**计算，不采信开发者自报；
 *   - 生成后用宿主自己的 `parseCatalog` 回验，不通过即失败退出。
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

/** 市场目录自身的下载根（catalog.json 由我们发布） */
const BASE_URL = "https://github.com/My-Search/my-search-plugin-market/releases/download";

const args = process.argv.slice(2);
const onlyIdx = args.indexOf("--only");
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;
const localIdx = args.indexOf("--local");
const localRepo = localIdx >= 0 ? path.resolve(root, args[localIdx + 1]) : null;
const assetsIdx = args.indexOf("--assets");
const assetsDir = assetsIdx >= 0 ? path.resolve(root, args[assetsIdx + 1]) : null;

const outDir = path.join(root, "dist", "market");
mkdirSync(outDir, { recursive: true });

const sourcesFile = path.join(root, "plugins", "sources.json");
if (!existsSync(sourcesFile)) {
  console.error("✗ 缺少 plugins/sources.json（上架准入名单）");
  process.exit(1);
}
const allSources = JSON.parse(readFileSync(sourcesFile, "utf8")).sources ?? [];
const sources = only ? allSources.filter((s) => s.id === only) : allSources;
if (sources.length === 0) {
  console.error(only ? `✗ sources.json 中没有 id 为 ${only} 的源` : "✗ sources.json 没有条目");
  process.exit(1);
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** 从 URL 里取出资产文件名（最后一段） */
function assetNameOf(url) {
  const tail = url.split("/").pop() ?? "";
  return decodeURIComponent(tail);
}

/** 从 URL 里取出仓库 owner/name（用于归档检测），非 github release 地址返回 null */
function repoOfUrl(url) {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download\//.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * 下载插件包字节。
 * 三种来源（优先级从高到低）：
 *   1. 离线：--assets 指定本地目录（文件名 = 资产名）
 *   2. 离线：--local 指定本地目录（当仓库用）
 *   3. 真实：gh release download（按 repo+tag+asset，或按显式 url）
 */
function fetchAsset(src) {
  const asset = src.url ? assetNameOf(src.url) : src.asset;

  if (assetsDir) {
    const f = path.join(assetsDir, asset);
    if (!existsSync(f)) throw new Error(`本地资产不存在: ${f}`);
    return readFileSync(f);
  }
  if (localRepo) {
    const f = path.join(localRepo, asset);
    if (!existsSync(f)) throw new Error(`本地仓库中不存在资产 ${asset}: ${f}`);
    return readFileSync(f);
  }

  const tmp = path.join(outDir, `.tmp-${Date.now()}-${asset}`);
  try {
    if (src.url) {
      // 显式地址：直接下载（gh 支持完整 URL）
      execFileSync("gh", ["release", "download", src.url, "--output", tmp, "--clobber"], {
        cwd: root, stdio: ["ignore", "pipe", "inherit"],
      });
    } else {
      const repo = repoOf(src);
      execFileSync(
        "gh",
        ["release", "download", tagOf(src), "--repo", repo, "--pattern", asset, "--output", tmp, "--clobber"],
        { cwd: root, stdio: ["ignore", "pipe", "inherit"] }
      );
    }
    return readFileSync(tmp);
  } finally {
    try { if (existsSync(tmp)) execFileSync("rm", ["-f", tmp]); } catch { /* 忽略 */ }
  }
}

/** 取该源的仓库 owner/name（用于归档检测） */
function repoOf(src) {
  if (src.repo) return src.repo;
  if (src.url) return repoOfUrl(src.url);
  if (src.path) return src.repo; // path 模式必须配 repo
  throw new Error("sources.json 条目缺少 repo / url / path");
}

// ===================== path 模式（官方插件按版本归档） =====================
//
// 约定：包放在市场仓库的 `official-plugins/<插件id>/<版本>/<插件id>.mspp`，
// 同步时**自动列出所有版本目录、取版本号最大的一个**作为默认安装版本。
// 好处：官方插件全放同一个仓库、按版本分层归档，发新版只需加一个目录，
// 不用为主仓的每个插件单独建 Release，也不用改 sources.json。

/** path 模式默认的官方插件根目录（仓库内） */
const OFFICIAL_PLUGINS_ROOT = "official-plugins";

/** 取仓库默认分支（列目录与 raw 地址都用它） */
let _defaultBranch = null;
function defaultBranchOf(repo) {
  if (_defaultBranch) return _defaultBranch;
  if (localRepo || assetsDir) return (_defaultBranch = "main");
  const out = execFileSync("gh", ["api", `repos/${repo}`, "--jq", ".default_branch"], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  });
  return (_defaultBranch = out.trim() || "main");
}

/**
 * 列出某插件在仓库里的全部版本号（目录名）。
 * 离线模式（--local/--assets）改为扫描本地 `official-plugins/<id>/` 的子目录。
 */
function listVersions(repo, id, root_) {
  if (localRepo) {
    const dir = path.join(localRepo, root_, id);
    if (!existsSync(dir)) throw new Error(`本地不存在 ${root_}/${id}`);
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  }
  if (assetsDir) {
    // 离线：目录名形如 <id>@<版本>
    return readdirSync(assetsDir)
      .map((f) => /^(.+)@(.+)\.mspp$/.exec(f))
      .filter((m) => m && m[1] === id)
      .map((m) => m[2]);
  }
  // 真实：用 contents API 列目录
  const apiPath = `repos/${repo}/contents/${root_}/${id}`;
  try {
    const out = execFileSync("gh", ["api", apiPath, "--jq", '.[] | select(.type=="dir") | .name'], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    throw new Error(`无法列出 ${root_}/${id} 的版本目录（${repo}）: ${String(e.message ?? e).split("\n")[0]}`);
  }
}

/** 从版本号列表里取最大者（SemVer 比较，复用宿主的 compareVersion） */
async function pickLatestVersion(versions) {
  if (versions.length === 0) throw new Error("该插件没有任何版本目录");
  const { compareVersion, isValidVersion } = await import("../src/lib/plugins/manifest.ts");
  const valid = versions.filter((v) => isValidVersion(v));
  if (valid.length === 0) throw new Error(`版本目录名都不是合法 SemVer: ${versions.join(", ")}`);
  return valid.reduce((best, v) => (compareVersion(v, best) > 0 ? v : best), valid[0]);
}

/** path 模式下该插件的下载地址（raw 直链） */
function officialRawUrl(repo, branch, id, version, root_, asset) {
  return `https://raw.githubusercontent.com/${repo}/${branch}/${root_}/${id}/${version}/${asset}`;
}

// ===================== 下载 =====================

/**
 * 拉取 raw 文件。
 * 优先用 `gh api`（走 gh 的认证通道，在直连受限的网络下也能用），
 * 失败再退回 curl。两者都拿不到即报错。
 */
function fetchRaw(url, repo, filePath) {
  // 首选 gh api：repos/<repo>/contents/<path>?ref=<ref> 返回 base64 内容
  if (repo && filePath) {
    try {
      const out = execFileSync(
        "gh",
        ["api", `repos/${repo}/contents/${filePath}`, "--jq", ".content"],
        { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }
      );
      // GitHub 返回的 base64 带换行，需去掉
      const b64 = out.replace(/\s/g, "");
      if (b64) return Buffer.from(b64, "base64");
    } catch {
      /* 落到 curl 兜底 */
    }
  }
  const tmp = path.join(outDir, `.tmp-raw-${Date.now()}`);
  try {
    execFileSync("curl", ["-fsSL", "-o", tmp, url], { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
    return readFileSync(tmp);
  } finally {
    try { if (existsSync(tmp)) execFileSync("rm", ["-f", tmp]); } catch { /* 忽略 */ }
  }
}

/** 解析 path 模式：返回 { bytes, downloadUrl, version } */
async function resolvePathMode(src) {
  const repo = src.repo;
  if (!repo) throw new Error("path 模式必须同时提供 repo（包所在仓库）");
  const root_ = src.pathRoot ?? OFFICIAL_PLUGINS_ROOT;
  const asset = src.asset ?? `${src.id}.mspp`;

  if (assetsDir) {
    // 离线：<id>@<版本>.mspp，取最大版本
    const versions = listVersions(repo, src.id, root_);
    const version = await pickLatestVersion(versions);
    const f = path.join(assetsDir, `${src.id}@${version}.mspp`);
    if (!existsSync(f)) throw new Error(`本地资产不存在: ${f}`);
    return {
      bytes: readFileSync(f),
      downloadUrl: officialRawUrl(repo, "main", src.id, version, root_, asset),
      version,
    };
  }
  if (localRepo) {
    const versions = listVersions(repo, src.id, root_);
    const version = await pickLatestVersion(versions);
    const f = path.join(localRepo, root_, src.id, version, asset);
    if (!existsSync(f)) throw new Error(`本地不存在包: ${f}`);
    return {
      bytes: readFileSync(f),
      downloadUrl: officialRawUrl(repo, "main", src.id, version, root_, asset),
      version,
    };
  }
  // 真实模式：列目录 → 取最大版本 → 按 raw 地址下载
  const branch = defaultBranchOf(repo);
  const versions = listVersions(repo, src.id, root_);
  const version = await pickLatestVersion(versions);
  const url = officialRawUrl(repo, branch, src.id, version, root_, asset);
  return {
    bytes: fetchRaw(url, repo, `${root_}/${src.id}/${version}/${asset}`),
    downloadUrl: url,
    version,
  };
}

// ===================== 下载（Release / 显式 url） =====================

/** 从开发者仓库下载指定 Release 资产，返回字节。 */

/**
 * 取仓库里应发布的 release tag。
 * 约定（见 docs/plugin-market-publish.md）：**tag = 插件 id**，一个插件一个 tag、
 * 发新版时覆盖同名资产。这样下载地址稳定，无需每次改索引里的 URL 结构。
 * `sources.json` 可用 `tag` 字段显式覆盖（例如仓库用 `v1.2.3` 式 tag）。
 * 离线模式统一用 `latest` 占位。
 */
function tagOf(src) {
  if (localRepo || assetsDir) return src.tag ?? "latest";
  return src.tag ?? src.id;
}

/** 组织下载地址：<base>/<repo-owner>/<repo-name>/releases/download/<tag>/<asset> */
function downloadUrlFor(repo, tag, asset) {
  return `https://github.com/${repo}/releases/download/${tag}/${asset}`;
}

/** 该源最终写进索引的下载地址：显式 url 优先，否则按 repo/tag/asset 拼 */
function downloadUrlOf(src) {
  if (src.url) return src.url;
  const asset = src.asset;
  if (!asset) throw new Error("sources.json 条目缺少 asset（用 url 时可不填）");
  return downloadUrlFor(repoOf(src), tagOf(src), asset);
}

/**
 * 检测仓库是否已归档（archived）。
 * 归档意味着作者已停止维护 —— 这是最可靠的"插件不再可用"信号，几乎不会误报。
 * 检测失败（网络/权限等）不视为归档，避免误判正常插件。
 */
function isRepoArchived(repo) {
  if (localRepo || assetsDir) return false; // 离线模式跳过
  if (!repo) return false;
  try {
    const out = execFileSync(
      "gh", ["api", `repos/${repo}`, "--jq", ".archived"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    return out.trim() === "true";
  } catch {
    return false;
  }
}

const MIME = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

/**
 * 从包内读取 plugin.json（不解压落盘，用宿主同一份 readZip）。
 * 这是"我们校验、不采信开发者自报"的关键：清单与哈希都从真实包字节得出。
 * 同时返回包内文件表，供解析图标使用。
 */
async function inspectPackage(bytes) {
  const { readZip } = await import("../src/lib/plugins/package.ts");
  const { parsePluginManifest, describeManifestErrors } = await import("../src/lib/plugins/manifest.ts");
  const { isKnownPermission } = await import("../src/lib/plugins/permissions.ts");
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const result = await readZip(buf);
  const entry = result.entries.find((e) => e.name === "plugin.json");
  if (!entry) throw new Error("包内根目录缺少 plugin.json");
  const manifestText = new TextDecoder("utf-8").decode(entry.data);
  const parsed = parsePluginManifest(manifestText, isKnownPermission);
  if (!parsed.ok) {
    throw new Error("清单校验失败：" + describeManifestErrors(parsed.errors).join("；"));
  }
  return { manifest: parsed.manifest, files: result.entries };
}

/**
 * 解析 catalog 的 icon 字段。
 * 市场 UI 是 `<img src="{icon}">` 直出，**相对路径加载不了**，因此：
 *   - 已是 http(s): / data: 的绝对地址 → 原样保留；
 *   - 清单里的本地文件（如 icon.svg）→ 从**包内**取出并内联为 data URI
 *     （第三方插件的图标不在我们本地源码里，只能从包里拿）。
 */
function resolveIcon(icon, files) {
  if (!icon) return undefined;
  if (/^(https?|data):/i.test(icon)) return icon;
  const entry = files.find((f) => f.name === icon);
  if (!entry) {
    console.warn(`  ⚠ 包内未找到图标 ${icon}，catalog 将不展示图标`);
    return undefined;
  }
  const mime = MIME[path.extname(icon).toLowerCase()];
  if (!mime) {
    console.warn(`  ⚠ 未知图标格式，跳过：${icon}`);
    return undefined;
  }
  return `data:${mime};base64,${Buffer.from(entry.data).toString("base64")}`;
}

/** 读取本地插件源码目录的 meta.json（categories/tags 等展示元数据） */
function readMetaFor(src) {
  if (!src?.dir) return null;
  const f = path.join(root, "plugins", src.dir, "meta.json");
  if (!existsSync(f)) return null;
  return JSON.parse(readFileSync(f, "utf8"));
}

const entries = [];
let failed = 0;

for (const src of sources) {
  const { id } = src;
  const mode = src.path ? `path:${src.repo}/${src.pathRoot ?? OFFICIAL_PLUGINS_ROOT}/${id}` : (src.url ?? repoOf(src));
  process.stdout.write(`🔄 ${id} ← ${mode} … `);
  try {
    // path 模式：列版本目录取最大版本；其余：按 Release / 显式地址下载
    let bytes, downloadUrl, pickedVersion;
    if (src.path) {
      const r = await resolvePathMode(src);
      bytes = r.bytes;
      downloadUrl = r.downloadUrl;
      pickedVersion = r.version;
    } else {
      bytes = fetchAsset(src);
      downloadUrl = downloadUrlOf(src);
    }
    const digest = sha256(bytes);
    // 关键：清单与图标都从**包内**读取，而不是信任 sources.json 或开发者声明
    const { manifest, files } = await inspectPackage(bytes);

    if (manifest.id !== id) {
      throw new Error(`包内清单 id（${manifest.id}）与准入名单 id（${id}）不一致`);
    }
    // path 模式下，包内版本应与目录名一致，防止"目录写 2.0.0、包里是 1.0.0"
    if (pickedVersion && manifest.version !== pickedVersion) {
      throw new Error(`包内版本（${manifest.version}）与目录名（${pickedVersion}）不一致`);
    }

    const meta = readMetaFor(src);

    const entry = {
      id,
      name: manifest.name,
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      author: manifest.author,
      description: manifest.description,
      categories: meta?.categories ?? ["tools"],
      downloadUrl,
      sha256: digest,
      size: bytes.length,
      permissions: [...(manifest.permissions ?? []), ...(manifest.optionalPermissions ?? [])],
      publishedAt: meta?.publishedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (manifest.minAppVersion) entry.minAppVersion = manifest.minAppVersion;
    if (manifest.homepage) entry.homepage = manifest.homepage;
    const icon = resolveIcon(manifest.icon, files);
    if (icon) entry.icon = icon;
    if (meta?.tags) entry.tags = meta.tags;
    if (meta?.changelog) entry.changelog = meta.changelog;
    if (src.official !== undefined) entry.official = src.official;
    if (src.verified !== undefined) entry.verified = src.verified;

    // ---- 废弃判定：让用户在安装前就知道插件可能已不可用 ----
    // ① 人工标记（官方插件无法靠仓库归档检测，只能手标）
    // ② 自动检测：仓库被作者归档（archived）= 已停止维护，几乎不会误报
    let deprecated = src.deprecated === true;
    let deprecatedReason = src.deprecatedReason;
    if (!deprecated) {
      const repo = src.repo ?? repoOfUrl(src.url ?? "");
      if (repo && isRepoArchived(repo)) {
        deprecated = true;
        deprecatedReason = "作者已归档该仓库，插件不再维护";
      }
    }
    if (deprecated) {
      entry.deprecated = true;
      entry.deprecatedReason = deprecatedReason ?? "该插件已停止维护";
    }

    entries.push(entry);
    const flag = deprecated ? "  ⚠ 已废弃" : "";
    const picked = pickedVersion ? `  (选中 ${pickedVersion})` : "";
    console.log(`v${manifest.version}  ${(bytes.length / 1024).toFixed(1)} KB  ${digest.slice(0, 12)}…${flag}${picked}`);
  } catch (e) {
    failed++;
    console.log("失败");
    console.error(`   ✗ ${id}: ${e.message}`);
  }
}

if (entries.length === 0) {
  console.error("✗ 没有任何插件同步成功");
  process.exit(1);
}

const catalog = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  baseUrl: BASE_URL,
  plugins: entries,
};

const catalogPath = path.join(outDir, "catalog.json");
writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + "\n");

// ---- 用宿主自己的解析器回验（产出物一定被客户端接受）----
const { parseCatalog, describeCatalogErrors } = await import("../src/lib/plugins/market-types.ts");
const parsed = parseCatalog(JSON.stringify(catalog));
if (!parsed.ok) {
  console.error("✗ 生成的 catalog 未通过宿主校验：");
  for (const line of describeCatalogErrors(parsed.errors)) console.error("  · " + line);
  process.exit(1);
}

// ---- 发布命令（只需发布 catalog 本身；插件包在各个开发者仓库里）----
const lines = [
  "#!/usr/bin/env bash",
  "# 由 scripts/sync-sources.mjs 生成 —— 只需发布目录；插件包在各开发者仓库里",
  "set -euo pipefail",
  `REPO="My-Search/my-search-plugin-market"`,
  `OUT="dist/market"`,
  "",
  'if gh release view "catalog" --repo "$REPO" >/dev/null 2>&1; then',
  '  gh release upload "catalog" --repo "$REPO" --clobber "$OUT/catalog.json"',
  "else",
  '  gh release create "catalog" --repo "$REPO" --title "插件市场目录" --notes "插件市场目录（catalog.json）" "$OUT/catalog.json"',
  "fi",
  "",
];
writeFileSync(path.join(outDir, "publish.sh"), lines.join("\n"), { mode: 0o755 });

console.log("");
console.log(`✅ catalog：${path.relative(root, catalogPath)}（${entries.length} 个插件）`);
console.log(`✅ 发布命令：dist/market/publish.sh`);
if (failed > 0) {
  console.error(`⚠ ${failed} 个源同步失败（见上方错误）`);
  process.exitCode = 1;
}
console.log("   未执行任何发布动作；确认后手动运行 publish.sh。");
