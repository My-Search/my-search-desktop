/**
 * 清理 Windows 图标目录里用不到的东西。
 *
 * `tauri icon` 不论目标平台都会输出 android/ios 子目录和 icon.icns，
 * 而 Windows 的 bundle 目标（nsis / msi）用不到它们，所以删掉以免仓库里堆垃圾。
 * 其余 png 全部保留（含 Square / StoreLogo：万一以后加 AppX/MSIX 目标就要用到）。
 *
 * 用法：node test/prune-win-icons.mjs
 */
import fs from 'fs';
import path from 'path';

const DIR = path.join(process.cwd(), 'src-tauri', 'icons', 'windows');
const DROP_DIRS = ['android', 'ios'];
const DROP_FILES = ['icon.icns'];

if (!fs.existsSync(DIR)) {
  console.error(`目录不存在：${DIR}（先运行 npm run icons 生成）`);
  process.exit(1);
}

for (const d of DROP_DIRS) {
  const p = path.join(DIR, d);
  if (fs.existsSync(p)) {
    fs.rmSync(p, { recursive: true, force: true });
    console.log(`  删除目录 ${d}/`);
  }
}
for (const f of DROP_FILES) {
  const p = path.join(DIR, f);
  if (fs.existsSync(p)) {
    fs.rmSync(p, { force: true });
    console.log(`  删除文件 ${f}`);
  }
}

const kept = fs.readdirSync(DIR).filter((f) => fs.statSync(path.join(DIR, f)).isFile());
console.log(`Windows 图标目录保留 ${kept.length} 个文件：${kept.join(', ')}`);
