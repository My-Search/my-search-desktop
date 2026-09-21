/**
 * 打包内置插件为 .msplugin 文件到 resources/plugins/
 * 
 * 用法：
 *   npm run pack:builtin
 * 
 * 约定：
 *   - 从 plugins/ 目录读取内置插件源码
 *   - 打包到 src-tauri/resources/plugins/
 *   - 只打包白名单内的插件（com.mysearch.baidu-translate、com.mysearch.pi-agent、com.mysearch.market）
 *   - market 插件不存在时跳过（不报错，CI 会填真包）
 */
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const pluginsDir = path.join(root, "plugins");
const outputDir = path.join(root, "src-tauri", "resources", "plugins");

const BUILTIN_PLUGINS = [
  "pi-agent",
  "market",
];

mkdirSync(outputDir, { recursive: true });

for (const name of BUILTIN_PLUGINS) {
  const srcDir = path.join(pluginsDir, name);
  if (!existsSync(srcDir)) {
    console.warn(`⚠️  跳过 ${name}（目录不存在，CI 会填真包）`);
    continue;
  }

  const outFile = path.join(outputDir, `com.mysearch.${name}.msplugin`);
  console.log(`📦 打包 ${name} → ${path.relative(root, outFile)}`);
  
  try {
    execSync(`node test/pack-plugin.mjs plugins/${name} -o ${outFile}`, {
      cwd: root,
      stdio: "inherit",
    });
  } catch (err) {
    console.error(`❌ 打包 ${name} 失败`);
    process.exit(1);
  }
}

console.log("✅ 内置插件打包完成");
