/**
 * 插件打包工具：目录 → `.mspp`（ZIP）。
 *
 * 与宿主使用的是**同一份** zip 实现（`src/lib/plugins/package.ts` 的 writeZip），
 * 因此「用本工具打的包一定装得上」——不会出现打包器与解包器各写一套、
 * 只在某些边界上互相不认的情况。
 *
 * 用法:
 *   node test/pack-plugin.mjs plugins/baidu-translate
 *   node test/pack-plugin.mjs plugins/baidu-translate -o dist/baidu.mspp
 *
 * 约定：
 *   - `plugin.json` 必须位于**源目录根部**（打出的包因此是扁平结构，
 *     不依赖宿主端的「包裹目录剥离」兜底）；
 *   - 自动跳过 `.dev-source`、`.seeded-*.json` 等开发期产物与常见垃圾文件；
 *   - 支持插件目录下的 `.msppignore` 文件（语法类似 .gitignore，但只支持简单的路径/目录名匹配和 `*.ext` 通配）；
 *   - 打包前先跑一遍清单校验，不合格直接失败（别把装不上的包发给用户）。
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeZip } from "../src/lib/plugins/package.ts";
import { parsePluginManifest, describeManifestErrors, PLUGIN_MANIFEST_FILE } from "../src/lib/plugins/manifest.ts";
import { isKnownPermission } from "../src/lib/plugins/permissions.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 打包时忽略的文件/目录（发布元数据、开发期产物、版本控制与编辑器垃圾） */
// meta.json 是「市场发布元数据」（categories/tags 等），只服务于 catalog 生成，
// 不属于插件运行时内容，因此不进入分发给用户的包。
// .msppignore 同理：只是打包器自身的配置，插件运行时不会读它。
// .data 是插件的**运行时落盘目录**（如资源监控的 history.json）——含使用者本机
// 信息，绝不能随包分发。
const IGNORE = new Set([
  ".dev-source", ".git", ".gitignore", ".msppignore", ".npmignore",
  ".DS_Store", "Thumbs.db", "desktop.ini",
  "node_modules", ".vscode", ".idea", "meta.json", ".data",
]);
const IGNORE_RE = /^(\.seeded-|\.#|~$)/;

/**
 * 加载 .msppignore 文件（如果存在）。
 * 返回一个 Set<string>，每个元素是一条规则（目录名、文件名或 `*.ext` 通配）。
 * 空行和 # 开头的注释会被忽略。
 */
function loadIgnorePatterns(srcDir) {
  const ignoreFile = path.join(srcDir, ".msppignore");
  if (!existsSync(ignoreFile)) return null;
  const lines = readFileSync(ignoreFile, "utf8").split(/\r?\n/);
  const patterns = new Set();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    // 去掉尾部的 / （目录标记），统一成纯名称匹配
    patterns.add(trimmed.replace(/\/$/, ""));
  }
  return patterns;
}

/**
 * 检查路径是否匹配 .msppignore 规则。
 * 支持：
 *   - 精确匹配（目录名或文件名）：`test` 匹配任何路径中的 `test` 段
 *   - 通配符（只支持 `*.ext`）：`*.log` 匹配任何以 `.log` 结尾的文件
 */
function matchesIgnorePattern(relPath, patterns) {
  if (!patterns) return false;
  const parts = relPath.split("/");
  for (const pattern of patterns) {
    // 精确匹配（路径中的任何一段）
    if (parts.includes(pattern)) return true;
    // 通配符 *.ext
    if (pattern.startsWith("*")) {
      const suffix = pattern.slice(1); // e.g. ".log"
      if (parts.some((p) => p.endsWith(suffix))) return true;
    }
  }
  return false;
}

function collect(dir, prefix = "", out = [], patterns = null) {
  for (const name of readdirSync(dir).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    // 默认忽略规则
    if (IGNORE.has(name) || IGNORE_RE.test(name) || name.endsWith("~")) continue;
    // .msppignore 规则
    if (matchesIgnorePattern(rel, patterns)) continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      collect(full, rel, out, patterns);
    } else if (st.isFile()) {
      out.push({ name: rel, data: new Uint8Array(readFileSync(full)) });
    }
  }
  return out;
}

const args = process.argv.slice(2);
const srcArg = args.find((a) => !a.startsWith("-"));
if (!srcArg) {
  console.error("用法: node test/pack-plugin.mjs <插件目录> [-o 输出路径]");
  process.exit(1);
}
const outFlag = args.indexOf("-o");
const srcDir = path.resolve(root, srcArg);
const pkgName = path.basename(srcDir);
const outPath = outFlag >= 0 && args[outFlag + 1]
  ? path.resolve(root, args[outFlag + 1])
  : path.join(root, "dist", `${pkgName}.mspp`);

// ---- 1. 校验清单 ----
const manifestPath = path.join(srcDir, PLUGIN_MANIFEST_FILE);
let manifestText;
try {
  manifestText = readFileSync(manifestPath, "utf8");
} catch (e) {
  console.error(`错误：${srcArg} 下没有 ${PLUGIN_MANIFEST_FILE}`);
  process.exit(1);
}
const parsed = parsePluginManifest(manifestText, isKnownPermission);
if (!parsed.ok) {
  console.error("清单校验失败：");
  for (const line of describeManifestErrors(parsed.errors)) console.error("  · " + line);
  process.exit(1);
}
for (const w of describeManifestErrors(parsed.warnings)) console.warn("警告: " + w);

// ---- 2. 收集文件 ----
const ignorePatterns = loadIgnorePatterns(srcDir);
const files = collect(srcDir, "", [], ignorePatterns);
if (files.length === 0) {
  console.error("错误：目录为空");
  process.exit(1);
}
if (!files.some((f) => f.name === PLUGIN_MANIFEST_FILE)) {
  console.error(`错误：收集到的文件里没有 ${PLUGIN_MANIFEST_FILE}（不应发生，请检查目录结构）`);
  process.exit(1);
}

// 入口文件必须真实存在（否则用户装上后打不开界面）
const detail = parsed.manifest.contributes?.detailView;
if (detail?.entry && !files.some((f) => f.name === detail.entry)) {
  console.error(`错误：清单声明的 detailView.entry 不存在于包内：${detail.entry}`);
  process.exit(1);
}
if (detail?.script && !files.some((f) => f.name === detail.script)) {
  console.error(`错误：清单声明的 detailView.script 不存在于包内：${detail.script}`);
  process.exit(1);
}
const backend = parsed.manifest.backend;
if (backend?.entry && !files.some((f) => f.name === backend.entry)) {
  console.error(`错误：清单声明的 backend.entry 不存在于包内：${backend.entry}`);
  process.exit(1);
}

// ---- 3. 打包 ----
const zip = await writeZip(files);
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, zip);
const kb = (zip.length / 1024).toFixed(1);
console.log(`已打包：${path.relative(root, outPath)}（${kb} KB，${files.length} 个文件）`);
console.log(`  插件：${parsed.manifest.name} v${parsed.manifest.version}（${parsed.manifest.id}）`);
for (const f of files) console.log(`  · ${f.name}`);
