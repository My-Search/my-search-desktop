/**
 * 生成插件市场目录（catalog.json）与可发布的 .mspp 包。
 *
 * **与 sync-sources.mjs 的分工**：
 *   - 本脚本：面向**第一方插件**（源码就在本仓库 plugins/ 下），负责「打包 + 生成目录」；
 *   - sync-sources.mjs：面向**第三方插件**（源码在开发者自己仓库），负责按
 *     `plugins/sources.json` 准入名单「拉取 + 校验 + 生成目录」。
 *   两者产物同名（dist/market/），按需选一个跑；不要混用后者名单跑前者。
 *
 * 用法：
 *   node scripts/gen-catalog.mjs                 # 打包全部上架插件 + 生成 catalog
 *   node scripts/gen-catalog.mjs --only pi-agent # 只发布指定插件（增量为准，见下）
 *   node scripts/gen-catalog.mjs --no-pack       # 复用已打好的包，只重算哈希与目录
 *
 * 产物（默认 dist/market/）：
 *   dist/market/<plugin-id>.mspp   每个插件的发布包（Release 资产）
 *   dist/market/catalog.json       市场目录（Release tag `catalog` 的资产）
 *   dist/market/publish.sh         需要执行的 gh 命令清单（只生成，不执行）
 *
 * 设计约束（与客户端契约严格对齐，任何一条不符用户就装不上）：
 *   - 包地址固定为 `<baseUrl>/<id>/<id>.mspp`，后缀必须是 .mspp —— 宿主
 *     `host.ts` 安装时按 `${id}.mspp` 拼 URL，后缀不一致必然 404；
 *   - `sha256` 由本脚本对**真实包字节**计算，64 位小写 hex；
 *   - 生成后立刻用宿主自己的 `parseCatalog` 回验，不通过就失败退出，
 *     避免把不合格目录推上线（这才是「打包器=校验器」的单一口径）。
 */
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

/** 市场下载根：必须与 host.ts / market.rs 的硬编码前缀一致 */
const BASE_URL = "https://github.com/My-Search/my-search-plugin-market/releases/download";

/** 插件源目录名 → 上架目录。顺序即 catalog 内的展示顺序。 */
const PUBLISHABLE = [
  "pi-agent",
  "file-search",
  "market",
  "baidu-translate",
  "com.zhuangjie.github-upload",
];

const args = process.argv.slice(2);
const onlyIdx = args.indexOf("--only");
const only = onlyIdx >= 0 ? args.slice(onlyIdx + 1).filter((a) => !a.startsWith("-")) : null;
const doPack = !args.includes("--no-pack");

const outDir = path.join(root, "dist", "market");
mkdirSync(outDir, { recursive: true });

/** 读取插件清单 */
function readManifest(srcDir) {
  const p = path.join(srcDir, "plugin.json");
  if (!existsSync(p)) throw new Error(`缺少 plugin.json：${srcDir}`);
  return JSON.parse(readFileSync(p, "utf8"));
}

/** 读取发布元数据（categories/tags/official 等 catalog 专有字段） */
function readMeta(srcDir) {
  const p = path.join(srcDir, "meta.json");
  if (!existsSync(p)) {
    throw new Error(
      `缺少 meta.json：${srcDir}\n` +
        `  上架插件必须提供 meta.json，用于补充 categories（catalog 必填字段）。`
    );
  }
  return JSON.parse(readFileSync(p, "utf8"));
}

/** 打包单个插件（复用 test/pack-plugin.mjs，与宿主同一份 zip 实现） */
function packOne(srcRel, outFile) {
  execFileSync("node", ["test/pack-plugin.mjs", srcRel, "-o", outFile], {
    cwd: root,
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
  });
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
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
 * 解析 catalog 的 icon 字段。
 * 市场 UI 是 `<img src="{icon}">` 直出，**相对路径加载不了**，因此：
 *   - 已是 http(s): / data: 的绝对地址 → 原样保留；
 *   - 清单里的本地文件（如 icon.svg / icon.ico）→ 内联为 data URI。
 */
function resolveIcon(icon, srcDir) {
  if (!icon) return undefined;
  if (/^(https?|data):/i.test(icon)) return icon;
  const file = path.join(srcDir, icon);
  if (!existsSync(file)) {
    console.warn(`  ⚠ 图标文件不存在，catalog 将不展示图标：${icon}`);
    return undefined;
  }
  const ext = path.extname(icon).toLowerCase();
  const mime = MIME[ext];
  if (!mime) {
    console.warn(`  ⚠ 未知图标格式，跳过：${icon}`);
    return undefined;
  }
  return `data:${mime};base64,${readFileSync(file).toString("base64")}`;
}

const targets = only ?? PUBLISHABLE;
const entries = [];
const publishedAtFallback = new Date().toISOString();

for (const name of targets) {
  const srcRel = path.join("plugins", name);
  const srcDir = path.join(root, srcRel);
  if (!existsSync(srcDir)) {
    console.error(`✗ 跳过 ${name}：目录不存在`);
    process.exitCode = 1;
    continue;
  }

  const manifest = readManifest(srcDir);
  const meta = readMeta(srcDir);
  const id = manifest.id;

  // 包名固定，保证与 host.ts 拼出的 URL 一致
  const pkgFile = path.join(outDir, `${id}.mspp`);
  if (doPack) {
    process.stdout.write(`📦 打包 ${name} … `);
    packOne(srcRel, pkgFile);
    console.log("ok");
  } else if (!existsSync(pkgFile)) {
    console.error(`✗ ${id}.mspp 不存在，无法 --no-pack（先跑一次完整打包）`);
    process.exitCode = 1;
    continue;
  }

  const bytes = readFileSync(pkgFile);
  const digest = sha256(bytes);

  if (!Array.isArray(meta.categories) || meta.categories.length === 0) {
    console.error(`✗ ${name}: meta.json 的 categories 必须是非空数组（catalog 必填）`);
    process.exitCode = 1;
    continue;
  }

  const entry = {
    id,
    name: manifest.name,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    author: manifest.author,
    description: manifest.description,
    categories: meta.categories,
    // 固定后缀，杜绝历史上 .msplugin 与客户端 .mspp 不一致导致的 404
    downloadUrl: `${BASE_URL}/${id}/${id}.mspp`,
    sha256: digest,
    size: bytes.length,
    permissions: [
      ...(manifest.permissions ?? []),
      ...(manifest.optionalPermissions ?? []),
    ],
    publishedAt: meta.publishedAt ?? publishedAtFallback,
    updatedAt: new Date().toISOString(),
  };
  if (manifest.minAppVersion) entry.minAppVersion = manifest.minAppVersion;
  if (manifest.homepage) entry.homepage = manifest.homepage;
  const icon = resolveIcon(manifest.icon, srcDir);
  if (icon) entry.icon = icon;
  if (meta.tags) entry.tags = meta.tags;
  if (meta.changelog) entry.changelog = meta.changelog;
  if (meta.official !== undefined) entry.official = meta.official;
  if (meta.verified !== undefined) entry.verified = meta.verified;

  entries.push(entry);
  console.log(`   ${id} v${manifest.version}  ${(bytes.length / 1024).toFixed(1)} KB  ${digest.slice(0, 12)}…`);
}

if (entries.length === 0) {
  console.error("✗ 没有任何插件被处理");
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

// ---- 生成发布命令清单（只写文件，不执行任何网络操作）----
// 已存在的 release 走 `upload --clobber` 覆盖资产，否则 create；
// 避免 `gh release create` 在 tag 已存在时直接报错。
const lines = [
  "#!/usr/bin/env bash",
  "# 由 scripts/gen-catalog.mjs 生成 —— 发布到插件市场仓库",
  "# 逐条执行前请确认；已存在的 release 会被覆盖资产（--clobber）",
  "set -euo pipefail",
  `REPO="My-Search/my-search-plugin-market"`,
  `OUT="dist/market"`,
  "",
  "# 发布单个资产：release 已存在则覆盖资产，否则新建 release",
  "publish() {",
  '  local tag="$1" title="$2" asset="$3"',
  '  if gh release view "$tag" --repo "$REPO" >/dev/null 2>&1; then',
  '    gh release upload "$tag" --repo "$REPO" --clobber "$asset"',
  '  else',
  '    gh release create "$tag" --repo "$REPO" --title "$title" --notes "插件包 $tag" "$asset"',
  "  fi",
  "}",
  "",
  "# 1) 每个插件一个 Release，tag = 插件 id，资产 = <id>.mspp",
];
for (const e of entries) {
  lines.push(`publish "${e.id}" "${e.name} v${e.version}" "$OUT/${e.id}.mspp"`);
}
lines.push(
  "",
  "# 2) 目录 Release，tag = catalog，资产 = catalog.json",
  'publish "catalog" "插件市场目录" "$OUT/catalog.json"',
  ""
);
writeFileSync(path.join(outDir, "publish.sh"), lines.join("\n"), { mode: 0o755 });

console.log("");
console.log(`✅ catalog：${path.relative(root, catalogPath)}（${entries.length} 个插件）`);
console.log(`✅ 发布命令：${path.relative(root, path.join(outDir, "publish.sh"))}`);
console.log("   未执行任何发布动作；确认后手动运行该脚本。");
