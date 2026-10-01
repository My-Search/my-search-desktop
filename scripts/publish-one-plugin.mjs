/**
 * 一次性上架脚本：把「资源监控」插件发布到插件市场仓库（官方托管归档）。
 *
 * 与 scripts/publish-market.mjs 的区别：那个脚本会**重新发布仓库内全部插件**，
 * 本脚本只发布一个插件，避免误动其它插件的在架版本。
 *
 * 归档位置（与 build-index.mjs 的 resolveOfficial 对齐）：
 *   official-plugins/<id>/<版本>/<id>.mspp
 *   official-plugins/<id>/<版本>/icon.<ext>
 *
 * 用法：
 *   node scripts/publish-one-plugin.mjs <插件目录> [--dry-run]
 * 环境变量：
 *   MARKET_REPO  市场仓库（默认 My-Search/my-search-plugin-market）
 *
 * 依赖已登录的 gh（对市场仓库有 contents:write）。
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const MARKET_REPO = process.env.MARKET_REPO || "My-Search/my-search-plugin-market";

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const dirArg = args.find((a) => !a.startsWith("--"));
if (!dirArg) {
  console.error("用法: node scripts/publish-one-plugin.mjs <插件目录> [--dry-run]");
  process.exit(1);
}
const pluginDir = path.resolve(root, dirArg);

function gh(ghArgs, { input } = {}) {
  return execFileSync("gh", ghArgs, {
    cwd: root,
    encoding: "utf8",
    input,
    stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
  });
}

const manifest = JSON.parse(readFileSync(path.join(pluginDir, "plugin.json"), "utf8"));
const { id, version, icon } = manifest;
if (!id || !version) {
  console.error("✗ plugin.json 缺 id 或 version");
  process.exit(1);
}
console.log(`插件：${id} v${version}`);

// 打包到临时位置
const outPkg = path.join(root, "dist", "_pub", `${id}.mspp`);
execFileSync("node", ["test/pack-plugin.mjs", `plugins/${path.basename(pluginDir)}`, "-o", outPkg], {
  cwd: root,
  stdio: "inherit",
});

// 相对图标（只处理本地相对路径）
let iconFile = null;
if (icon && /^[.\w-]+\.\w+$/.test(icon)) {
  const f = path.join(pluginDir, icon);
  if (existsSync(f)) iconFile = f;
}

const base = `official-plugins/${id}/${version}`;
const branch = gh(["api", `repos/${MARKET_REPO}`, "--jq", ".default_branch"]).trim() || "main";
console.log(`市场仓库：${MARKET_REPO}（分支 ${branch}）`);
console.log(`归档路径：${base}/`);

/** 上传一个文件（存在则带 sha 覆盖）；返回 committed 行 */
function put(relPath, absPath, message) {
  const content = readFileSync(absPath).toString("base64");
  let sha;
  try {
    sha = gh(["api", `repos/${MARKET_REPO}/contents/${relPath}?ref=${branch}`, "--jq", ".sha"]).trim() || undefined;
  } catch {
    sha = undefined; // 404：新文件
  }
  if (DRY) {
    console.log(`  [dry-run] ${sha ? "覆盖" : "新建"} ${relPath}（${Buffer.byteLength(content, "base64")} 字节）`);
    return;
  }
  const payload = JSON.stringify({ message, content, branch, ...(sha ? { sha } : {}) });
  gh(["api", "--method", "PUT", `repos/${MARKET_REPO}/contents/${relPath}`, "--input", "-"], { input: payload });
  console.log(`  ↑ ${relPath}`);
}

const msg = `chore(market): 上架 ${id} v${version}`;
put(`${base}/${id}.mspp`, outPkg, msg);
if (iconFile) put(`${base}/${icon}`, iconFile, msg + "（图标）");

console.log(DRY ? "\n[dry-run] 未做任何写操作" : "\n✔ 上传完成");
