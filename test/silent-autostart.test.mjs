/**
 * 回归测试：「开机自启动必须静默」契约
 *
 * 用户反馈：登录后自启动时会弹出一个窗口。根因是 **exe 子系统**问题，不是
 * 主窗口显示问题（主窗口在 tauri.conf.json 里是 visible:false，从不自己冒出来）：
 * 登录时进程由 explorer.exe 拉起，没有父控制台；若 exe 是 console 子系统
 * （PE OptionalHeader.Subsystem == 3），Windows 会为它**新建一个控制台窗口**，
 * 且本应用常驻托盘不退出，黑窗口会一直挂着。
 *
 * 早期 main.rs 写的是：
 *     #![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
 * 只让 release 静默，debug 构建仍是控制台程序。而自启动项指向的正是「首次写
 * 入时运行的那个 exe」——开发调试阶段跑的就是 target/debug/...，于是注册表里
 * 存下 debug 路径，登录就弹黑窗（实测复现：注册表 Run\MySearch 指向
 * target\debug\my-search-desktop.exe，subsystem=3）。
 *
 * 本测试锁死两件事：
 *  1. 源码契约：main.rs 在 Windows 上**无条件**声明 windows 子系统
 *     （绝不能回退成 debug 保留控制台的写法）；
 *  2. 产物验收：已构建的 debug / release exe，PE 子系统必须是 2（GUI）。
 *     只做源码断言不够——将来若有人在别处（如 Cargo.toml 的 rustflags）
 *     把子系统改回 console，源码看起来仍是「对的」。
 *
 * 另外校验自启动项「路径自愈」没有从启动流程里掉出去（见 lib.rs 的
 * refresh_autostart_exe_path）：注册表里残留旧路径时，登录会拉起错误的那份。
 *
 * 用法：node test/silent-autostart.test.mjs
 *      （exe 不存在时只跑源码契约，并提示可构建后重跑；不算失败）
 */
import { readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = "") => {
  if (cond) {
    pass++;
    console.log(`✓ ${name}`);
  } else {
    fail++;
    console.error(`✗ ${name}${extra ? `  ${extra}` : ""}`);
  }
};

const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

// ── 1. 源码契约：Windows 上无条件 GUI 子系统 ──
const mainSrc = read("src-tauri/src/main.rs");
const mainCode = stripComments(mainSrc);

ok(
  /#!\[cfg_attr\(target_os = "windows", windows_subsystem = "windows"\)\]/.test(mainCode),
  "main.rs 声明 Windows 无条件下使用 windows 子系统（GUI，不创建控制台）"
);

ok(
  !/windows_subsystem\s*=\s*"windows"\s*\)\]\s*\n\s*#!\[cfg_attr\(not\(debug_assertions\)/.test(mainSrc) &&
    !/cfg_attr\(not\(debug_assertions\),\s*windows_subsystem/.test(mainCode),
  "main.rs 不再用 not(debug_assertions) 门控 windows 子系统（debug 构建也会静默）"
);

// main.rs 不得出现 console 子系统声明（那正是弹黑窗的写法）
ok(
  !/windows_subsystem\s*=\s*"console"/.test(mainCode),
  "main.rs 未声明 console 子系统"
);

// ── 2. 自启动「路径自愈」仍在启动流程里 ──
const libSrc = read("src-tauri/src/lib.rs");
const libCode = stripComments(libSrc);

ok(
  /fn refresh_autostart_exe_path\(/.test(libCode),
  "lib.rs 存在 refresh_autostart_exe_path（纠正注册表里的旧 exe 路径）"
);
ok(
  /refresh_autostart_exe_path\(app\)/.test(libCode),
  "refresh_autostart_exe_path 在 apply_autostart_preference 中被调用"
);
ok(
  /apply_autostart_preference\(app\.handle\(\)\)/.test(libCode),
  "apply_autostart_preference 在 setup 启动流程中被调用"
);
// 只有在用户确实开着自启动时才去动注册表
ok(
  /if want\s*\{[\s\S]{0,120}?refresh_autostart_exe_path\(app\)/.test(libCode),
  "仅在自启动开启（want == true）时才校正路径"
);
// 开发构建绝不改注册表：否则本地调试会把已安装版本的启动项顶掉
ok(
  /fn refresh_autostart_exe_path[\s\S]{0,400}?tauri::is_dev\(\)[\s\S]{0,80}?return;/.test(libCode),
  "仅正式构建（!tauri::is_dev()）执行路径自愈，dev 调试不劫持已安装版本的启动项"
);
// 读路径必须用与写入方相同的值名（tauri 的 package_info().name），否则读不到
ok(
  /package_info\(\)\.name/.test(libCode),
  "读取自启动项时使用 package_info().name 作为值名（与写入方一致）"
);
// Windows 注册表键必须与 auto-launch 一致（源码里是带转义的 \\ 形式）
ok(
  libSrc.includes("SOFTWARE\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run"),
  "使用 HKCU\\...\\CurrentVersion\\Run 键（与 tauri-plugin-autostart 一致）"
);

// ── 3. 产物验收：PE 子系统必须是 GUI(2) ──
/** 读取 PE OptionalHeader.Subsystem；返回 2=GUI / 3=CONSOLE / null=读不到 */
function peSubsystem(file) {
  try {
    const buf = readFileSync(file);
    const peOffset = buf.readUInt32LE(0x3c);
    if (buf.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") return null;
    // OptionalHeader 起点 = PE签名(4) + COFF头(20)
    const opt = peOffset + 4 + 20;
    const magic = buf.readUInt16LE(opt);
    // 0x10b = PE32, 0x20b = PE32+；Subsystem 都在 +68
    if (magic !== 0x10b && magic !== 0x20b) return null;
    return buf.readUInt16LE(opt + 68);
  } catch {
    return null;
  }
}

const targets = [
  ["debug", path.join(root, "src-tauri", "target", "debug", "my-search-desktop.exe")],
  ["release", path.join(root, "src-tauri", "target", "release", "my-search-desktop.exe")],
];
let built = 0;
for (const [label, exe] of targets) {
  if (!existsSync(exe)) {
    console.log(`- 跳过 ${label} 产物检查（未构建：${path.relative(root, exe)}）`);
    continue;
  }
  built++;
  const sub = peSubsystem(exe);
  ok(
    sub === 2,
    `${label} 产物是 GUI 子系统（启动不弹控制台窗口）`,
    sub === 3 ? "实际为 CONSOLE(3) —— 登录自启会弹出黑窗口！" : `实际=${sub}`
  );
}
if (built === 0) {
  console.log("  （提示：`cd src-tauri && cargo build` 后重跑本测试可验收产物）");
}

// ── 4. 主窗口不得在启动阶段自我显示（与「静默」相配套） ──
// 主窗口初始 visible:false；启动 setup 里只做定位/定宽，不能调 show()。
const setupBody = libCode.slice(libCode.indexOf(".setup(|app|"));
const setupEnd = setupBody.indexOf(".on_window_event");
const setupSlice = setupEnd > 0 ? setupBody.slice(0, setupEnd) : setupBody.slice(0, 4000);
ok(
  !/\.show\(\)/.test(setupSlice),
  "启动 setup 中不调用 window.show()（不主动弹主窗口）"
);

console.log(`\n结果: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
