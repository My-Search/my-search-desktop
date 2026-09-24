/**
 * 插件市场索引构建工具。
 *
 * 读取 `plugins/index.json`（人工维护的源清单）→ 逐个解析出插件信息
 * → 生成两个产物：
 *   - `index.dist.json` ：完整索引（客户端读它，走 raw 地址）
 *   - `index.error.json`：被排除的项与原因，**与 index.json 同构**
 *     （官方错误在 official-repo、三方错误在 three-parties，供开发者自查）
 *
 * 用法：
 *   node scripts/build-index.mjs                     # 全量构建
 *   node scripts/build-index.mjs --local <dir>       # 用本地目录当作市场仓库（离线测试）
 *   node scripts/build-index.mjs --assets <dir>      # 用本地资产目录（离线测试）
 *
 * ## 两种源
 *
 * - `official-repo`：官方插件，包在**市场仓库**里按版本归档：
 *     <路径>/<版本>/<插件id>.mspp，如 official-plugins/com.x.y/1.0.0/com.x.y.mspp
 *   解析时列出全部版本目录，取版本号最大者。
 *
 * - `three-parties`：第三方插件，一个仓库一个插件，走该仓库的 Release：
 *     tag = 插件 id，资产 = <插件id>.mspp
 *   解析时下载包、读包内 plugin.json 校验 id 一致。
 *
 * ## 异常处理
 *
 * - 不符合规范（缺包、清单非法、版本不匹配等）→ 排除该条，原因写入 index.error.json；
 * - 仓库 404（已删除/转私有）→ **自动从 index.json 移除**，下次不再处理。
 *
 * ## 设计约束（与客户端契约严格对齐）
 *
 * - `sha256` 由本脚本对**真实包字节**计算，不采信任何自报值；
 * - 生成后调用宿主的 `parseCatalog` 回验，不通过即失败退出。
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

/** 市场仓库（官方插件包与索引都放这里） */
const MARKET_REPO = "My-Search/my-search-plugin-market";
/** 索引顶层的 baseUrl（仅作信息字段保留） */
const BASE_URL = `https://github.com/${MARKET_REPO}/releases/download`;

const args = process.argv.slice(2);
const localIdx = args.indexOf("--local");
const localRepo = localIdx >= 0 ? path.resolve(root, args[localIdx + 1]) : null;
const assetsIdx = args.indexOf("--assets");
const assetsDir = assetsIdx >= 0 ? path.resolve(root, args[assetsIdx + 1]) : null;
const offline = Boolean(localRepo || assetsDir);

const outDir = path.join(root, "dist", "market");
mkdirSync(outDir, { recursive: true });

const indexPath = path.join(root, "plugins", "index.json");
if (!existsSync(indexPath)) {
  console.error("✗ 缺少 plugins/index.json（插件源清单）");
  process.exit(1);
}
const indexDoc = JSON.parse(readFileSync(indexPath, "utf8"));
const officialRepos = indexDoc["official-repo"] ?? [];
const threeParties = indexDoc["three-parties"] ?? [];

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * 出错记录：写入 index.error.json，供开发者自查为什么没上架。
 * 结构与 index.json 同构——官方错误进 official-repo、三方错误进 three-parties，
 * 每项保留**原条目信息 + reason**，便于精确定位。
 */
const errors = { official: [], threeParties: [] };
/** 记录一条排除项。kind: 'official' | 'three-party' */
function recordError(kind, item, reason) {
  if (kind === "official") {
    // 官方条目可能是字符串或 {path, official} 对象，统一记录为 {path, reason}（保留 official）
    const entry = { path: typeof item === "string" ? item : item.path, reason };
    if (typeof item === "object" && item !== null && item.official !== undefined) {
      entry.official = item.official;
    }
    errors.official.push(entry);
  } else {
    errors.threeParties.push({ repo: item, reason });
  }
}

// ===================== 通用工具 =====================

/** 取仓库默认分支 */
const _branchCache = new Map();
function defaultBranchOf(repo) {
  if (_branchCache.has(repo)) return _branchCache.get(repo);
  const b = offline
    ? "main"
    : (execFileSync("gh", ["api", `repos/${repo}`, "--jq", ".default_branch"], {
        cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      }).trim() || "main");
  _branchCache.set(repo, b);
  return b;
}

/** 仓库是否存在（用于 404 自动移除判定） */
function repoExists(repo) {
  if (offline) return true;
  try {
    execFileSync("gh", ["api", `repos/${repo}`, "--jq", ".id"], {
      cwd: root, stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/** 列出仓库某目录下的子目录名 */
function listSubdirs(repo, dirPath) {
  if (offline) {
    const d = path.join(localRepo ?? assetsDir, dirPath);
    if (!existsSync(d)) throw new Error(`本地不存在目录 ${dirPath}`);
    return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  }
  try {
    const out = execFileSync(
      "gh",
      ["api", `repos/${repo}/contents/${dirPath}`, "--jq", '.[] | select(.type=="dir") | .name'],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    // 不把原始 shell 错误抛给开发者，转成可读原因
    throw new Error(`仓库中不存在该路径：${dirPath}（请确认已按规范放置插件包）`);
  }
}

/** 取版本号列表中最大者（SemVer） */
async function pickLatestVersion(versions) {
  if (versions.length === 0) throw new Error("没有任何版本目录");
  const { compareVersion, isValidVersion } = await import("../src/lib/plugins/manifest.ts");
  const valid = versions.filter((v) => isValidVersion(v));
  if (valid.length === 0) throw new Error(`版本目录名都不是合法 SemVer: ${versions.join(", ")}`);
  return valid.reduce((best, v) => (compareVersion(v, best) > 0 ? v : best), valid[0]);
}

/** 拉取一个文件：优先 gh api（走认证通道，受限网络可用），失败退回 curl */
function fetchRaw(url, repo, filePath) {
  if (repo && filePath && !offline) {
    try {
      const out = execFileSync(
        "gh", ["api", `repos/${repo}/contents/${filePath}`, "--jq", ".content"],
        { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }
      );
      const b64 = out.replace(/\s/g, "");
      if (b64) return Buffer.from(b64, "base64");
    } catch { /* 落到 curl */ }
  }
  const tmp = path.join(outDir, `.tmp-raw-${Date.now()}`);
  try {
    execFileSync("curl", ["-fsSL", "-o", tmp, url], { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
    return readFileSync(tmp);
  } finally {
    try { if (existsSync(tmp)) execFileSync("rm", ["-f", tmp]); } catch { /* 忽略 */ }
  }
}

/** 从包内读 plugin.json 并校验（不采信外部声明） */
async function inspectPackage(bytes) {
  const { readZip } = await import("../src/lib/plugins/package.ts");
  const { parsePluginManifest, describeManifestErrors } = await import("../src/lib/plugins/manifest.ts");
  const { isKnownPermission } = await import("../src/lib/plugins/permissions.ts");
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const result = await readZip(buf);
  const entry = result.entries.find((e) => e.name === "plugin.json");
  if (!entry) throw new Error("包内根目录缺少 plugin.json");
  const parsed = parsePluginManifest(new TextDecoder("utf-8").decode(entry.data), isKnownPermission);
  if (!parsed.ok) throw new Error("清单校验失败：" + describeManifestErrors(parsed.errors).join("；"));
  return { manifest: parsed.manifest, files: result.entries };
}

const MIME = {
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon",
};

/**
 * 解析图标为**外置直链**（不再内联 data URI）。
 *
 * 内联会让索引体积暴涨——实测某个 .ico 未压缩就有 90KB，占整个索引的 96%，
 * 索引本该只有几 KB。因此改为只存地址：
 *
 * - 已声明的 http(s): 外链 → 原样保留；
 * - data: URI → 官方插件的内联图标，需外置（见下）才能用，否则丢弃；
 * - 相对路径（如 `icon.svg`）→ 按来源拼成直链：
 *     · 官方：与 .mspp 包**同目录**，即 <插件目录>/<版本>/icon.svg
 *     · 三方：开发者自己仓库的默认分支根目录，即 <他的仓库>/<ref>/icon.svg
 */
function resolveIconUrl(icon, { kind, repo, ref, pluginDir, version }) {
  if (!icon) return undefined;
  // 外链原样保留
  if (/^https?:\/\//i.test(icon)) return icon;
  // data URI：内联图标无法外置（我们不知道它对应哪个文件），丢弃并提示
  if (/^data:/i.test(icon)) return undefined;
  // 相对路径：拼成直链
  const name = icon.replace(/^\.?\//, "");
  if (!MIME[path.extname(name).toLowerCase()]) return undefined;
  if (kind === "official") {
    return `https://raw.githubusercontent.com/${repo}/${ref}/${pluginDir}/${version}/${name}`;
  }
  // 三方：仓库根目录 + 默认分支
  return `https://raw.githubusercontent.com/${repo}/${ref}/${name}`;
}

/** 组装一条索引条目（官方与三方共用） */
function buildEntry({ manifest, bytes, digest, downloadUrl, iconUrl, categories, tags, official, verified }) {
  const entry = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    author: manifest.author,
    description: manifest.description,
    categories: categories ?? ["tools"],
    downloadUrl,
    sha256: digest,
    size: bytes.length,
    permissions: [...(manifest.permissions ?? []), ...(manifest.optionalPermissions ?? [])],
    publishedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (manifest.minAppVersion) entry.minAppVersion = manifest.minAppVersion;
  if (manifest.homepage) entry.homepage = manifest.homepage;
  if (iconUrl) entry.icon = iconUrl;
  if (tags) entry.tags = tags;
  if (official !== undefined) entry.official = official;
  if (verified !== undefined) entry.verified = verified;
  return entry;
}

// ===================== 预期被自动移除的仓库（404） =====================

const autoRemoved = [];

// ===================== 解析：官方插件（仓库内按版本归档） =====================

/**
 * 解析 official-repo 的一个条目。
 * 支持两种写法：
 *   - 字符串：'official-plugins/<插件id>'
 *   - 对象：{ path, official }（显式指定是否官方徽标）
 * `official` 未指定时，取插件目录下 meta.json 的 official 字段（默认 true）。
 * 这样「包托管在我们仓库」与「是否是官方插件」就解耦了——
 * 例如 com.zhuangjie.* 由我们代管包，但仍是第三方。
 */
async function resolveOfficial(item) {
  const relPath = typeof item === "string" ? item : item.path;
  const officialOverride = typeof item === "object" && item !== null ? item.official : undefined;
  if (typeof relPath !== "string") {
    throw new Error(`official-repo 条目格式错误：${JSON.stringify(item)}`);
  }
  // relPath 形如 official-plugins/<插件id>
  const segs = relPath.split("/").filter(Boolean);
  if (segs.length !== 2 || segs[0] !== "official-plugins") {
    throw new Error(`官方路径必须是 official-plugins/<插件id>，实际为 ${relPath}`);
  }
  const id = segs[1];

  const versions = listSubdirs(MARKET_REPO, relPath);
  const version = await pickLatestVersion(versions);
  const asset = `${id}.mspp`;
  const filePath = `${relPath}/${version}/${asset}`;

  let bytes;
  if (offline) {
    const f = path.join(localRepo ?? assetsDir, filePath);
    if (!existsSync(f)) throw new Error(`本地不存在包文件 ${filePath}`);
    bytes = readFileSync(f);
  } else {
    const branch = defaultBranchOf(MARKET_REPO);
    const url = `https://raw.githubusercontent.com/${MARKET_REPO}/${branch}/${filePath}`;
    bytes = fetchRaw(url, MARKET_REPO, filePath);
  }
  const { manifest, files } = await inspectPackage(bytes);
  if (manifest.id !== id) {
    throw new Error(`包内清单 id（${manifest.id}）与目录名（${id}）不一致`);
  }
  if (manifest.version !== version) {
    throw new Error(`包内版本（${manifest.version}）与目录名（${version}）不一致`);
  }

  const branch = offline ? "main" : defaultBranchOf(MARKET_REPO);
  const downloadUrl = `https://raw.githubusercontent.com/${MARKET_REPO}/${branch}/${filePath}`;

  // 图标与 .mspp 包**同目录**（official-plugins/<id>/<版本>/icon.<ext>）。
  // 注意：我们只把地址写进索引，不读图标内容——不因此增加构建耗时。
  const iconUrl = resolveIconUrl(manifest.icon, {
    kind: "official",
    repo: MARKET_REPO,
    ref: branch,
    pluginDir: relPath,
    version,
  });

  // 分类/标签/official 取自本地源码目录的 meta.json（若有）
  let categories, tags, official = officialOverride;
  const metaFile = path.join(root, "plugins", id, "meta.json");
  if (existsSync(metaFile)) {
    const meta = JSON.parse(readFileSync(metaFile, "utf8"));
    categories = meta.categories;
    tags = meta.tags;
    if (official === undefined && meta.official !== undefined) official = meta.official;
  }
  if (official === undefined) official = true;

  return buildEntry({
    manifest, bytes,
    digest: sha256(bytes),
    downloadUrl,
    iconUrl,
    categories, tags,
    official,
  });
}

// ===================== 解析：第三方插件（仓库 Release） =====================

async function resolveThreeParty(repo) {
  if (!/^[^/]+\/[^/]+$/.test(repo)) {
    throw new Error(`第三方源格式必须是 用户名/仓库名，实际为 ${repo}`);
  }
  if (!repoExists(repo)) {
    autoRemoved.push({ repo, reason: "仓库不存在（404，可能已删除或转私有）" });
    return null; // 不算错误项，走自动移除
  }

  // 规范：一个仓库一个插件，tag = 插件 id（先列 releases 找出候选）
  let tags;
  if (offline) {
    tags = readdirSync(path.join(assetsDir ?? localRepo))
      .map((f) => /^(.+)\.mspp$/.exec(f))
      .filter(Boolean)
      .map((m) => m[1]);
  } else {
    const out = execFileSync(
      "gh", ["release", "list", "--repo", repo, "--limit", "50", "--json", "tagName", "--jq", ".[].tagName"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    tags = out.split("\n").map((s) => s.trim()).filter(Boolean);
  }
  if (tags.length === 0) throw new Error("该仓库没有任何 Release");

  const { isValidPluginId } = await import("../src/lib/plugins/manifest.ts");
  const candidates = tags.filter((t) => isValidPluginId(t));
  if (candidates.length === 0) {
    throw new Error(`没有 tag 符合「插件 id」规范（需为反向域名式），现有 tag: ${tags.join(", ")}`);
  }

  // 逐个尝试：下载包并校验包内 id 与 tag 一致
  let lastErr = null;
  for (const tag of candidates) {
    try {
      const asset = `${tag}.mspp`;
      let bytes;
      if (offline) {
        const f = path.join(assetsDir ?? localRepo, asset);
        if (!existsSync(f)) throw new Error(`本地不存在 ${asset}`);
        bytes = readFileSync(f);
      } else {
        const tmp = path.join(outDir, `.tmp-${Date.now()}-${asset}`);
        try {
          execFileSync("gh", ["release", "download", tag, "--repo", repo, "--pattern", asset, "--output", tmp, "--clobber"],
            { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
          bytes = readFileSync(tmp);
        } finally {
          try { if (existsSync(tmp)) execFileSync("rm", ["-f", tmp]); } catch { /* 忽略 */ }
        }
      }
      const { manifest, files } = await inspectPackage(bytes);
      if (manifest.id !== tag) {
        throw new Error(`包内 id（${manifest.id}）与 tag（${tag}）不一致`);
      }
      const downloadUrl = `https://github.com/${repo}/releases/download/${tag}/${asset}`;
      // 三方图标：从包内 plugin.json 的 icon 字段取，指向**开发者自己仓库**的 raw 地址。
      // 因此开发者需把图标文件按该名字放在仓库根目录（详见上架指南）。
      const ref = offline ? "main" : defaultBranchOf(repo);
      const iconUrl = resolveIconUrl(manifest.icon, { kind: "three-party", repo, ref });
      if (manifest.icon && !iconUrl) {
        console.warn(`\n   ⚠ 图标未外置：icon 需为仓库内的文件名（如 icon.svg），当前为 ${String(manifest.icon).slice(0, 24)}`);
      }
      return buildEntry({
        manifest, files, bytes,
        digest: sha256(bytes),
        downloadUrl,
        iconUrl,
        official: false,
      });
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`所有候选 tag 都无法解析：${lastErr?.message ?? "未知原因"}`);
}

// ===================== 主流程 =====================

const entries = [];
const seen = new Set();

/**
 * 处理一个源：成功则收集条目，失败则记入 index.error.json。
 * kind: 'official' | 'three-party'；item 为原条目（字符串或对象）
 */
async function processOne(kind, item, label, fn) {
  process.stdout.write(`🔄 ${label} … `);
  try {
    const entry = await fn();
    if (entry === null) { console.log("跳过（仓库不存在，已从 index.json 移除）"); return; }
    if (seen.has(entry.id)) throw new Error(`插件 id 重复：${entry.id}`);
    seen.add(entry.id);
    entries.push(entry);
    console.log(`v${entry.version}  ${(entry.size / 1024).toFixed(1)} KB  ${entry.sha256.slice(0, 12)}…`);
  } catch (e) {
    console.log("排除");
    console.error(`   ✗ ${e.message}`);
    recordError(kind, item, e.message);
  }
}

for (const p of officialRepos) {
  const label = typeof p === "string" ? p : p.path;
  await processOne("official", p, `official-repo:${label}`, () => resolveOfficial(p));
}
for (const r of threeParties) await processOne("three-party", r, `three-parties:${r}`, () => resolveThreeParty(r));

if (entries.length === 0) {
  console.error("✗ 没有任何插件解析成功");
  process.exit(1);
}

// ---- 生成 index.dist.json（客户端读它）----
const dist = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  baseUrl: BASE_URL,
  plugins: entries,
};
const distPath = path.join(outDir, "index.dist.json");
writeFileSync(distPath, JSON.stringify(dist, null, 2) + "\n");

// ---- 生成 index.error.json（开发者自查）----
// 结构与 index.json 同构：官方错误进 official-repo、三方错误进 three-parties，
// 每项保留原条目信息 + reason。始终生成（无错误时两个数组为空）。
const errDoc = {
  generatedAt: new Date().toISOString(),
  "official-repo": errors.official,
  "three-parties": errors.threeParties,
};
const errPath = path.join(outDir, "index.error.json");
writeFileSync(errPath, JSON.stringify(errDoc, null, 2) + "\n");

// ---- 用宿主解析器回验 ----
const { parseCatalog, describeCatalogErrors } = await import("../src/lib/plugins/market-types.ts");
const parsed = parseCatalog(JSON.stringify(dist));
if (!parsed.ok) {
  console.error("✗ 生成的索引未通过宿主校验：");
  for (const line of describeCatalogErrors(parsed.errors)) console.error("  · " + line);
  process.exit(1);
}

console.log("");
console.log(`✅ index.dist.json：${path.relative(root, distPath)}（${entries.length} 个插件）`);
const errCount = errors.official.length + errors.threeParties.length;
if (errCount > 0) {
  console.log(
    `⚠ index.error.json：${errCount} 个项被排除` +
      `（官方 ${errors.official.length} / 三方 ${errors.threeParties.length}）`
  );
} else {
  console.log(`✅ index.error.json：无排除项`);
}

// ---- 404 仓库自动移除：重写 index.json ----
if (autoRemoved.length > 0) {
  console.log("");
  console.log("⚠ 以下仓库不存在，将从 index.json 自动移除：");
  for (const a of autoRemoved) console.log(`   · ${a.repo}（${a.reason}）`);
  const removedSet = new Set(autoRemoved.map((a) => a.repo));
  indexDoc["three-parties"] = threeParties.filter((r) => !removedSet.has(r));
  writeFileSync(indexPath, JSON.stringify(indexDoc, null, 2) + "\n");
  console.log("   已更新 plugins/index.json");
}
