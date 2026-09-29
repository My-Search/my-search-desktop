/**
 * `.mspp` 文件关联（资源管理器图标 + 双击安装）的**接线**测试。
 *
 * 要钉死的契约（这些环节写错了不会编译报错，只会静默失效）：
 *   1. Rust 侧必须把 `.mspp` 登记到注册表，`shell\open\command` 要带我们的
 *      命令行开关——否则双击只会弹「你要如何打开这个文件？」；
 *   2. Rust 侧的待处理槽必须被正确消费：取出即清空（幂等），否则每呼出一次
 *      窗口都会重复弹安装确认；
 *   3. 前端必须**同时**注册事件监听与主动拉一次：冷启动双击时 Rust 的广播
 *      早于前端挂监听，只有主动拉取兜得住；
 *   4. 打开后要把文件附加成附件 chip（用户能看到那个叶子）再弹安装确认——
 *      附件是 `ms.input.*` 的数据源，也让 chip 可点（多点一次不重复弹）。
 *
 * 前三项查 Rust 源码，第四项查 Vue 源码——与 `drop-target.test.mjs` 同一风格。
 * Rust 的**行为**（参数解析）由 `cargo test file_assoc` 覆盖，这里只查接线。
 *
 * 用法: node test/file-assoc-wiring.test.mjs
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

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

/* ============ 1. 注册表布局（icon + open command） ============ */
const faSrc = read("src-tauri/src/file_assoc.rs");

ok(/const PROGID: &str = "MySearch\.PluginPackage"/.test(faSrc), "定义了 ProgID（文件类型程序标识）");
ok(/create_subkey\(format!\("\.\{MSPP_EXT\}"\)\)/.test(faSrc), "登记扩展名键 .mspp → ProgID");
ok(/create_subkey\("DefaultIcon"\)/.test(faSrc), "写 DefaultIcon（资源管理器显示的图标）");
ok(/create_subkey\(r"shell\\open\\command"\)/.test(faSrc), "写 shell\\open\\command（双击的处理程序）");
// 引号包住 exe 与 %1（路径含空格时不被拆成多个参数）——这里逐个查字面量，
// 免得把 Rust 的 \" 转义塞进正则后难以阅读。
{
  const cmdLine = faSrc.split("\n").find((l) => l.includes("{CLI_FLAG}") && l.includes("set_value")) ?? "";
  ok(
    cmdLine.includes('\\"{exe}\\"') && cmdLine.includes('\\"%1\\"'),
    "open 命令的 exe 与 %1 都被引号包住（路径含空格才不拆参）",
    cmdLine.trim()
  );
}
ok(
  /strip_verbatim_prefix/.test(faSrc) && /strip_prefix\(r"\\\\\?\\"\)/.test(faSrc),
  "DefaultIcon 路径剥掉 \\\\?\\ 前缀（resource_dir/canonicalize 会产出 verbatim 路径，shell 图标提取器不认识它，会导致「注册了但图标不生效」）",
);

ok(
  /SHChangeNotify\(/.test(faSrc),
  "写完后 SHChangeNotify 通知 shell（否则图标缓存不刷新，表现为「改了没效果」）",
);
ok(
  /software\\classes/i.test(faSrc) || /Software\\Classes/.test(faSrc),
  "写在 HKCU\\Software\\Classes（当前用户，不需要管理员权限）",
);
// dev 下写注册表会把关联顶到 target/debug 的 exe，顶掉已安装版本
ok(/tauri::is_dev\(\)/.test(faSrc) || /is_dev\(\)/.test(read("src-tauri/src/lib.rs")), "正式构建才注册（dev 不写注册表）");

/* ============ 2. 待处理槽的幂等消费 ============ */
ok(
  /guard\.take\(\)/.test(read("src-tauri/src/lib.rs")),
  "take_pending_plugin_open 取出即清空（幂等，不会重复弹确认框）",
);

/* ============ 3. 单实例 + 命令行转发 ============ */
const libSrc = read("src-tauri/src/lib.rs");
ok(
  /tauri_plugin_single_instance::init/.test(libSrc),
  "用了单实例插件（否则双击会再起一个进程：双托盘 + 快捷键注册冲突）",
);
ok(
  /plugin_path_from_args\(&argv\)/.test(libSrc),
  "单实例回调里解析第二个实例的 argv（双击插件包时路径从这里进来）",
);
ok(
  /plugin_path_from_args\(&std::env::args\(\)/.test(libSrc),
  "setup 里也解析自身 argv（应用尚未运行时双击的场景）",
);

/* ============ 4. 前端链路 ============ */
// 注意：「从外部打开插件包」（双击 .mspp / 命令行传入）现由**设置窗口**处理：
// Rust 端打开配置窗口并广播事件，配置窗口切到插件面板弹安装确认。
// 搜索窗口不再监听该事件（避免两边抢同一个幂等待处理槽），只保留 chip 点击安装。
const configAppSrc = read("src/windows/config/App.vue");
const searchAppSrc = read("src/windows/search/App.vue");
const bridgeSrc = read("src/lib/tauri-bridge.ts");
const boxSrc = read("src/windows/search/SearchBox.vue");

ok(
  /invoke<string \| null>\("take_pending_plugin_open"\)/.test(bridgeSrc),
  "tauri-bridge 暴露 takePendingPluginOpen（拉取待打开路径）",
);
ok(
  /listen\("my-search:\/\/open-plugin-package"/.test(bridgeSrc),
  "tauri-bridge 监听 Rust 的叫醒事件",
);
ok(
  /onOpenPluginPackage\(\(\) => \{\s*void handleExternalPluginOpen\(\);/.test(configAppSrc),
  "配置窗口 App.vue 收到事件即调 handleExternalPluginOpen",
);
// 关键：冷启动双击时 Rust 的广播早于前端挂监听，只有主动拉兜得住
ok(
  /void handleExternalPluginOpen\(\);/.test(configAppSrc),
  "配置窗口 App.vue 挂载时也主动拉一次（兜住早于监听的广播）",
);
// 拿到路径后切到插件面板并把路径交给 PanelPlugins 弹安装确认
// （取代旧设计：在搜索窗口里把 .mspp 附加成附件 chip）
ok(
  /switchPane\("plugins"\);\s*pendingPluginPath\.value = path;/.test(configAppSrc),
  "打开时切到插件面板并把路径交给 PanelPlugins（幂等待处理槽）",
);
// 搜索窗口保留 chip 点击安装路径：安装成功后摘掉附件里的 chip
ok(
  /if \(pendingInstallIndex >= 0\) onDetachEntry\(pendingInstallIndex\)/.test(searchAppSrc),
  "安装成功后摘掉附件里的那个 chip（-1 = 不在附件里时不动）",
);
// chip 本身可点（点 chip 而非 × 按钮）
ok(
  /@click="isPluginPackage\(f\) && emit\('chip-click', i\)"/.test(boxSrc),
  "SearchBox 的 .mspp chip 可点击（点 chip 弹安装确认，与双击行为一致）",
);
ok(
  /endsWith\(".mspp"\)/.test(boxSrc),
  "SearchBox 正确识别 .mspp 后缀",
);

/* ============ 5. 图标资源与打包 ============ */
const confSrc = read("src-tauri/tauri.conf.json");
ok(
  /"resources\/mspp\.ico"/.test(confSrc),
  "tauri.conf.json 把 mspp.ico 打进 bundle（DefaultIcon 指向它，缺了就碎图标）",
);
const iconExists = (() => {
  try {
    const b = readFileSync(path.join(ROOT, "src-tauri/resources/mspp.ico"));
    // ICONDIR：reserved=0, type=1(icon), count>0
    return b.length > 6 && b.readUInt16LE(0) === 0 && b.readUInt16LE(2) === 1 && b.readUInt16LE(4) > 0;
  } catch (e) {
    return false;
  }
})();
ok(iconExists, "resources/mspp.ico 存在且是合法 ICO 头（多尺寸文件类型图标）");

/* ============ 6. 设置开关（系统级写入必须给用户关闭入口） ============ */
const panelSrc = read("src/windows/config/panels/PanelGeneral.vue");
ok(
  /getFileAssocEnabled/.test(panelSrc) && /setFileAssocEnabled/.test(panelSrc),
  "常规设置面板有「关联 .mspp 插件包」开关（写注册表必须可关闭）",
);

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
