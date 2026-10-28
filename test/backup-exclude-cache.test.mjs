/**
 * 备份归档「排除派生缓存」的**源码契约**测试（以源码为断言对象）。
 *
 * 为什么需要：这条排除规则是「磁盘占用膨胀」的根因修复，而它的失效方式是
 * **静默**的——把那个 `if is_reconstructible_plugin_data { continue; }` 删掉，
 * 编译照过、测试也可能照过（纯函数还在、规则还在，只是没人调用了），
 * 表现为「备份又变回几百 MB」。
 *
 * 实测过的现场（修前）：
 *   - `%APPDATA%\com.mysearch.desktop\plugin-data\com.mysearch.recorder\ffmpeg\`
 *     = 321MB（ffmpeg.exe 161MB + ffprobe.exe 161MB，运行时从 GitHub 下载）
 *   - 每份 `.msbackup` 都把它整份打进 zip（该函数 `collect_files` 无任何排除）
 *   - `KEEP_BACKUPS = 12` 份上限 → 最坏 ~1.6GB
 *   - 而 `MAX_ENTRY_BYTES = 256MB` 拦不住：两个 160MB 文件都在阈值内
 *
 * 用法: node test/backup-exclude-cache.test.mjs
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = "") => {
  if (cond) {
    pass++;
    console.log("PASS ", name, extra ? ` — ${extra}` : "");
  } else {
    fail++;
    console.log("FAIL ", name, extra ? ` — ${extra}` : "");
  }
};

const backup = read("src-tauri/src/backup.rs");
const lib = read("src-tauri/src/lib.rs");

/* ============ 1. 纯函数存在且规则完整 ============ */
{
  ok(
    /fn is_reconstructible_plugin_data\(rel: &str\) -> bool/.test(backup),
    "backup.rs 定义了 is_reconstructible_plugin_data 纯函数"
  );
  // ffmpeg 目录名规则：不区分大小写、任意层级
  ok(
    /seg\.eq_ignore_ascii_case\("ffmpeg"\)/.test(backup),
    "按目录名排除 ffmpeg（不区分大小写）"
  );
  // 可执行/原生扩展名规则
  ok(
    /"exe" \| "dll" \| "dylib" \| "so" \| "node"/.test(backup),
    "排除可执行/原生扩展名 exe/dll/dylib/so/node"
  );
  // 只认扩展名，不认文件名里的 "ffmpeg" 字样——避免误伤 about-ffmpeg.txt
  ok(
    /rsplit_once\('\.'\)/.test(backup),
    "扩展名判定走 rsplit_once('.')（不会被文件名里的 ffmpeg 误伤）"
  );
}

/* ============ 2. 真的接进了收集路径（最关键） ============ */
{
  // 纯函数若无人调用，等于没修
  ok(
    /if is_reconstructible_plugin_data\(&rel\) \{\s*\n\s*continue;\s*\n\s*\}/.test(backup),
    "collect_plugin_files 对 plugin-data 调用排除并 continue",
    "删掉这个 if → 备份又变回几百 MB（编译照过）"
  );
  // 切出 collect_plugin_files 的函数体，按分支位置判断归属
  const fn = backup.slice(backup.indexOf("fn collect_plugin_files"));
  const body = fn.slice(0, fn.indexOf("\n}") + 2);
  const pluginsAt = body.indexOf("PLUGINS_DIR");
  const dataAt = body.indexOf("PLUGIN_DATA_DIR");
  const excludeAt = body.indexOf("is_reconstructible_plugin_data");
  ok(pluginsAt >= 0 && dataAt > pluginsAt, "函数体同时含 plugins/ 与 plugin-data/ 两个分支");
  ok(
    excludeAt > dataAt,
    "排除调用位于 plugin-data 分支（不在 plugins 分支）",
    "误伤 plugins/ 会让还原后的插件缺文件"
  );
  ok(
    !body.slice(pluginsAt, dataAt).includes("is_reconstructible_plugin_data"),
    "plugins/ 分支不应用排除规则"
  );
}

/* ============ 3. 该保留的用户态数据没有被规则误伤 ============ */
{
  ok(
    backup.includes("recordings"),
    "注释里点名 recordings 属用户态、故意不排除",
    "录屏产出不可再生成，静默丢弃等于数据丢失"
  );
  ok(
    /is_reconstructible_plugin_data_public/.test(backup),
    "导出了 *_public 测试入口（与既有 is_safe_relative_public 同模式）"
  );
}

/* ============ 4. 单测确实覆盖了「必须排除」和「必须保留」两侧 ============ */
{
  ok(
    lib.includes("fn backup_excludes_reconstructible_plugin_data()"),
    "lib.rs 有备份排除规则的单测"
  );
  // 正向：ffmpeg 两个二进制必须被挡（这就是 321MB 的来源）
  ok(
    lib.includes('is_recon("com.mysearch.recorder/ffmpeg/ffmpeg.exe")') &&
      lib.includes('is_recon("com.mysearch.recorder/ffmpeg/ffprobe.exe")'),
    "单测断言 ffmpeg.exe / ffprobe.exe 被排除"
  );
  // 反向：用户态数据必须留下
  ok(
    lib.includes('!is_recon("com.mysearch.recorder/recordings/rec-20260930.mp4")'),
    "单测断言 recordings/*.mp4 被保留"
  );
  ok(
    lib.includes('!is_recon("com.mysearch.clipboard/clipboard/index.json")'),
    "单测断言剪贴板索引被保留"
  );
  // 误伤防护：about-ffmpeg.txt 这类同名文件不能被排除
  ok(
    lib.includes('!is_recon("com.demo.data/notes/about-ffmpeg.txt")'),
    "单测断言 about-ffmpeg.txt 这类同名文件不被误伤"
  );
}

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
