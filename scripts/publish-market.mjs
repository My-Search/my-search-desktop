/**
 * 发布官方插件包到插件市场仓库。
 *
 * 用法：
 *   node scripts/publish-market.mjs                 # 打包 + 上传（含索引）
 *   node scripts/publish-market.mjs --dry-run       # 只打包、写本地 staging，不调 API
 *   node scripts/publish-market.mjs --no-index      # 只传插件包，不动索引文件
 *
 * 约定（与 scripts/build-index.mjs 的 resolveOfficial 严格对齐）：
 *   - 官方插件按 `<id>/<版本>/<id>.mspp` 归档到市场仓库的 official-plugins/ 下；
 *   - 图标与 .mspp **同目录**（official-plugins/<id>/<版本>/icon.<ext>）——
 *     构建索引时会按这个位置拼出图标直链；
 *   - 版本取包内 plugin.json 的 version（保持现有版本号即覆盖同版本目录）；
 *   - 索引（index.dist.json / index.error.json）**在本次打包的字节上重建后**一并提交，
 *     保证索引里的 sha256 与实际上传的包字节一致（否则客户端安装会校验失败）。
 *     重建走 `build-index.mjs --local <staging>`：staging 是本次要上传内容的本地镜像，
 *     因此无需等 CI 每小时重建，也不会出现「索引与包不同步」的窗口。
 *
 * 环境变量：
 *   MARKET_REPO   市场仓库（默认 My-Search/my-search-plugin-market）
 *
 * 依赖已登录的 `gh`（对市场仓库有 contents:write 权限）。
 */
import { readFileSync, mkdirSync, existsSync, rmSync, cpSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const SKIP_INDEX = args.includes("--no-index");

const MARKET_REPO = process.env.MARKET_REPO || "My-Search/my-search-plugin-market";

/**
 * 要发布的插件：源目录名 → 期望 id。
 * 覆盖全部仓库内插件（内置 + 官方非内置）。版本号取自各自 plugin.json。
 */
const PLUGINS = [
  { dir: "pi-agent", id: "com.mysearch.pi-agent" },
  { dir: "market", id: "com.mysearch.market" },
  { dir: "file-search", id: "com.mysearch.file-search" },
  { dir: "baidu-translate", id: "com.mysearch.baidu-translate" },
  { dir: "clipboard", id: "com.mysearch.clipboard" },
  { dir: "recorder", id: "com.mysearch.recorder" },
  { dir: "screenshot", id: "com.zhuangjie.screenshot" },
  { dir: "com.zhuangjie.github-upload", id: "com.zhuangjie.github-upload" },
  { dir: "com.zhuangjie.todo-list", id: "com.zhuangjie.todo-list" },
  { dir: "resource-monitor", id: "com.zhuangjie.resource-monitor" },
];

const pkgsDir = path.join(root, "dist", "market-pkgs");

function run(cmd, cmdArgs, opts = {}) {
  return execFileSync(cmd, cmdArgs, { cwd: root, stdio: "inherit", ...opts });
}

/** 读插件清单，做基础校验（id 与声明一致、有版本） */
function readManifest(dir, expectId) {
  const p = path.join(root, "plugins", dir, "plugin.json");
  const m = JSON.parse(readFileSync(p, "utf8"));
  if (m.id !== expectId) {
    throw new Error(`plugins/${dir}/plugin.json 的 id（${m.id}）与脚本声明（${expectId}）不一致`);
  }
  if (!m.version) throw new Error(`plugins/${dir}/plugin.json 缺 version`);
  return m;
}

/** 相对图标名（只处理本地相对路径图标；外链/无图标则不发布图标文件） */
function localIconName(dir, manifest) {
  const icon = manifest.icon;
  if (!icon || !/^[.\w-]+\.\w+$/.test(icon)) return null; // 外链或 data URI
  const file = path.join(root, "plugins", dir, icon);
  return existsSync(file) ? icon : null;
}

// ---------- 1. 打包 ----------
console.log("=== 1/4 打包插件 ===");
mkdirSync(pkgsDir, { recursive: true });
const built = [];
for (const { dir, id } of PLUGINS) {
  const manifest = readManifest(dir, id);
  const outFile = path.join(pkgsDir, `${id}.mspp`);
  run("node", ["test/pack-plugin.mjs", `plugins/${dir}`, "-o", outFile]);
  built.push({ ...PLUGINS.find((p) => p.dir === dir), manifest, outFile });
}
console.log(`\n✔ 打包完成：${built.length} 个\n`);

// ---------- 2. 生成本地上传镜像（staging） ----------
// 结构与市场仓库一致：official-plugins/<id>/<版本>/{<id>.mspp, icon.<ext>}。
// 用途有二：
//   1) dry-run 时即产物；
//   2) 正式发布时供 build-index --local 读取——索引必须基于「要上传的同一批字节」
//      计算 sha256，否则索引与包不同步（客户端安装会校验失败）。
const staging = path.join(root, "dist", "_market-staging");
rmSync(staging, { recursive: true, force: true });
for (const b of built) {
  const dest = path.join(staging, "official-plugins", b.id, b.manifest.version);
  mkdirSync(dest, { recursive: true });
  cpSync(b.outFile, path.join(dest, `${b.id}.mspp`));
  const icon = localIconName(b.dir, b.manifest);
  if (icon) cpSync(path.join(root, "plugins", b.dir, icon), path.join(dest, icon));
}
console.log(`✔ 本地上传镜像已生成：${path.relative(root, staging)}`);

// 让 build-index 在 staging 上重建索引（读取的是刚打包的字节）。
// build-index 会顺带回写 plugins/index.json 的时间字段。
if (!SKIP_INDEX) {
  console.log("\n=== 重建市场索引（基于本次打包字节）===");
  // staging 是「官方插件」的镜像，按设计不含三方插件包（它们在开发者自己仓库）。
  // 因此把市场**已发布索引**作为兜底传给构建器，三方条目原样沿用，
  // 否则离线解析会把在架的三方插件误判为「该仓库没有任何 Release」并下架。
  const carry = resolveCarryIndex();
  run("node", [
    "scripts/build-index.mjs",
    "--local", staging,
    ...(carry ? ["--carry", carry] : []),
  ]);
  console.log("");
}

/**
 * 取「待沿用」的索引路径（三方条目兜底），失败返回 null。
 *
 * - 正式发布：从市场仓库取当前索引（权威，含 CI 解析出的三方条目）；
 * - 演练（--dry-run）：约定不联网，退回本地上次构建的索引，没有则本次跳过三方。
 */
function resolveCarryIndex() {
  const localPrev = path.join(root, "dist", "market", "index.dist.json");
  if (DRY) {
    if (existsSync(localPrev)) {
      console.log(`↩ [dry-run] 用本地上次索引作兜底：${path.relative(root, localPrev)}`);
      return localPrev;
    }
    console.warn("⚠ [dry-run] 本地无上次索引，三方插件本次将跳过");
    return null;
  }
  try {
    const b64 = gh([
      "api", `repos/${MARKET_REPO}/contents/index.dist.json?ref=${marketBranch()}`,
      "--jq", ".content",
    ]);
    const dest = path.join(root, "dist", "_market-prev-index.dist.json");
    writeFileSync(dest, Buffer.from(b64.replace(/\s/g, ""), "base64"));
    console.log(`↩ 已取回市场当前索引作兜底：${path.relative(root, dest)}`);
    return dest;
  } catch {
    console.warn("⚠ 取回市场当前索引失败（首次发布？），三方插件本次将跳过");
    return null;
  }
}

// ---------- 4. 上传（GitHub Contents API） ----------
//
// 不走 `git clone && git push`：本机到 github.com 的 git/HTTPS 传输不稳定
// （实测 clone 多次 "Connection was reset / early EOF"），而 `gh api` 走
// API 端点稳定可用，且已登录账号对市场仓库有 push 权限。
// Contents API 逐文件 PUT（存在则带 sha 覆盖），天然幂等。
function gh(args, { input } = {}) {
  return execFileSync("gh", args, {
    cwd: root,
    encoding: "utf8",
    input,
    stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
  });
}

/** 取市场仓库默认分支 */
function marketBranch() {
  return gh(["api", `repos/${MARKET_REPO}`, "--jq", ".default_branch"]).trim() || "main";
}

/** 上传单个文件到市场仓库（存在则覆盖）。返回 true=新建/更新，false=内容一致未变 */
function putFile(relPath, absPath, message, branch) {
  const content = readFileSync(absPath).toString("base64");
  // 查询已有文件的 sha（内容一致时 API 会拒绝，先比对可跳过无谓提交）
  let sha;
  try {
    const out = gh([
      "api", `repos/${MARKET_REPO}/contents/${relPath}?ref=${branch}`,
      "--jq", ".sha",
    ]);
    sha = out.trim() || undefined;
  } catch {
    sha = undefined; // 404 = 新文件
  }
  const payload = JSON.stringify({
    message,
    content,
    branch,
    ...(sha ? { sha } : {}),
  });
  try {
    gh(["api", "--method", "PUT", `repos/${MARKET_REPO}/contents/${relPath}`, "--input", "-"],
      { input: payload });
    return true;
  } catch (e) {
    const msg = String(e.stderr || e.message || "");
    // 「sha mismatched / already exists」等：内容未变时 GitHub 也会报
    if (/already exists|sha/i.test(msg) && sha) {
      console.log(`  = 未变化，跳过：${relPath}`);
      return false;
    }
    throw e;
  }
}

// ---------- 3. 准备上传 ----------
console.log("=== 3/4 准备上传 ===");
const branch = marketBranch();
console.log(`市场仓库：${MARKET_REPO}（分支 ${branch}）`);

if (DRY) {
  console.log("[dry-run] 仅写本地 staging，不调用 API");
  console.log(`✔ 产物已就绪：${path.relative(root, staging)}`);
  process.exit(0);
}

// ---------- 4. 逐个上传插件包与图标 ----------
console.log("=== 4/4 上传插件包与图标 ===");
let uploaded = 0;
for (const b of built) {
  const base = `official-plugins/${b.id}/${b.manifest.version}`;
  const msg = `chore(market): 发布 ${b.id} v${b.manifest.version} [skip ci]`;
  if (putFile(`${base}/${b.id}.mspp`, b.outFile, msg, branch)) {
    uploaded++;
    console.log(`  ↑ ${base}/${b.id}.mspp`);
  }
  const icon = localIconName(b.dir, b.manifest);
  if (icon) {
    const iconSrc = path.join(root, "plugins", b.dir, icon);
    if (putFile(`${base}/${icon}`, iconSrc, msg, branch)) {
      uploaded++;
      console.log(`  ↑ ${base}/${icon}`);
    }
  }
}

// 索引文件（已在 staging 字节上重建，见第 2 步）
if (!SKIP_INDEX) {
  const distDir = path.join(root, "dist", "market");
  for (const f of ["index.dist.json", "index.error.json"]) {
    const src = path.join(distDir, f);
    if (existsSync(src)) {
      if (putFile(f, src, `chore(market): 更新索引 ${f} [skip ci]`, branch)) {
        uploaded++;
        console.log(`  ↑ ${f}`);
      }
    } else {
      console.warn(`⚠ 未找到 dist/market/${f}，跳过（可先跑 node scripts/build-index.mjs）`);
    }
  }
}

console.log(`\n✔ 发布完成：${built.length} 个插件，${uploaded} 个文件有变更（其余内容一致已跳过）`);

