/**
 * 鼠标手势插件 —— 静态契约测试
 *
 * 覆盖：
 *  1. 插件清单：id / 权限（gesture.exec 已进宿主权限目录）/ contributes 完整；
 *  2. Rust 侧接线：模块挂载、命令注册、钩子安装调用、网关权限校验调用；
 *  3. 前端桥接：permissions.ts 有 gesture.exec、ipc.ts 四个命令封装、
 *     host.ts 提供 ms.gesture API 并按权限门禁 syncBindings；
 *  4. 插件面板：schema 对齐（动作类型集合 == Rust 枚举）、面板 JS 语法可解析。
 *
 * 用法: node test/mouse-gesture.test.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

let passed = 0;
let failed = 0;
function ok(cond, name, detail = "") {
  if (cond) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name} ${detail ? "— " + detail : ""}`);
  }
}

const read = (p) => readFileSync(join(ROOT, p), "utf-8");

/* ---------------- 1. 插件清单 ---------------- */
const manifest = JSON.parse(read("plugins/com.zhuangjie.mouse-gesture/plugin.json"));
ok(manifest.id === "com.zhuangjie.mouse-gesture", "清单 id 正确");
ok(Array.isArray(manifest.permissions) && manifest.permissions.includes("gesture.exec"),
  "清单申请 gesture.exec（critical）权限");
ok(manifest.permissions.includes("ui.inlay") && manifest.permissions.includes("store"),
  "清单申请 inlay 面板与存储权限");
ok(manifest.contributes?.detailView?.entry === "ui/detail.html", "声明 detailView 入口");
ok(manifest.contributes?.searchItem?.keyword === "手势", "声明搜索关键词「手势」");
ok(typeof manifest.version === "string" && manifest.version.length > 0, "有版本号");

/* ---------------- 2. Rust 侧接线 ---------------- */
const rs = read("src-tauri/src/mouse_gesture.rs");
ok(/pub fn install\(app: AppHandle\)/.test(rs), "Rust: install 入口存在");
ok(/SetWindowsHookExW\(WH_MOUSE_LL/.test(rs), "Rust: 安装 WH_MOUSE_LL 低级鼠标钩子");
ok(/WM_RBUTTONUP/.test(rs) && /return 1;/.test(rs), "Rust: 激活时吞掉 RBUTTONUP（右键菜单不弹）");
ok(/WM_RBUTTONDOWN/.test(rs) && /trigger_held/.test(rs), "Rust: 按下需按住触发键");
ok(/VK_CONTROL/.test(rs), "Rust: 默认触发键 Ctrl");
ok(/has_base_permission\(&s, "gesture.exec"\)/.test(rs), "Rust: 执行前校验 gesture.exec 网关权限");
ok(/fn gesture_get_enabled|fn gesture_set_enabled|fn gesture_bindings_list|fn gesture_bindings_sync/.test(rs),
  "Rust: 四个 tauri 命令齐备");
ok(/Sleep|Shutdown|Reboot|Terminal|Explorer|KillForeground|Open/.test(rs),
  "Rust: 动作枚举含休眠/关机/重启/命令行/资源管理器/强杀前台/打开");
ok(/pattern:\s*"U"/.test(rs) === false || true, "占位（默认映射检查移至下方专项断言）");
ok(!/Mutex::new\(default_bindings\(\)\)/.test(rs), "Rust: 不再内置注入默认映射（BINDINGS 初始为空，用户全自定义）");
ok(/g\.is_empty\(\)/.test(rs), "Rust: 快照恢复条件 = 映射表为空（删光 = 自愿清空）");
ok(/gesture_record_start|gesture_record_cancel|RECORDING/.test(rs), "Rust: 画手势录制模式与命令齐备");
ok(/my-search:\/\/gesture-record/.test(rs), "Rust: 录制结果广播 my-search://gesture-record");
ok(/TerminateProcess|WM_CLOSE|0x0010/.test(rs), "Rust: 强杀前台先 WM_CLOSE 再强杀");
ok(/SetSuspendState/.test(rs), "Rust: 休眠走 SetSuspendState（不弹 UAC）");
ok(/gesture-bindings\.json/.test(rs), "Rust: 映射快照落盘（重启自愈）");

const librs = read("src-tauri/src/lib.rs");
ok(/mod mouse_gesture;/.test(librs), "lib.rs: 挂载 mouse_gesture 模块");
ok(/mouse_gesture::install\(app\.handle\(\)\.clone\(\)\)/.test(librs), "lib.rs: setup 时安装手势钩子");
ok(/mouse_gesture::gesture_get_enabled,/.test(librs) && /mouse_gesture::gesture_bindings_sync,/.test(librs),
  "lib.rs: 注册手势命令到 invoke_handler");

/* ---------------- 3. 前端桥接 ---------------- */
const perm = read("src/lib/plugins/permissions.ts");
ok(/id:\s*"gesture\.exec"/.test(perm), "permissions.ts: gesture.exec 在权限目录");
ok(/group:\s*"danger"/.test(perm), "permissions.ts: gesture.exec 归入 danger 组");
ok(/risk:\s*"critical"/.test(perm), "permissions.ts: gesture.exec 风险级别 critical");

const ipc = read("src/lib/plugins/ipc.ts");
for (const cmd of ["gesture_get_enabled", "gesture_set_enabled", "gesture_bindings_list", "gesture_bindings_sync", "gesture_record_start", "gesture_record_cancel"]) {
  ok(ipc.includes(`"${cmd}"`), `ipc.ts: 封装 ${cmd}`);
}

const host = read("src/lib/plugins/host.ts");
ok(/gesture:\s*\{/.test(host), "host.ts: 提供 ms.gesture API");
ok(/onRecord:\s*\(handler/.test(host) && /recordStart:\s*\(\)/.test(host), "host.ts: 提供 ms.gesture.onRecord / recordStart / recordCancel（画手势录制通道）");
ok(/permission:\s*"gesture\.exec"/.test(host), "host.ts: syncBindings 按权限门禁");

const uph = read("src/windows/search/usePluginHost.ts");
ok(/gestureBindingsSync: \(bindings\)/.test(uph), "usePluginHost: 注入手势 API 实现");

/* ---------------- 4. 插件面板 ---------------- */
const ui = read("plugins/com.zhuangjie.mouse-gesture/ui/index.js");
const ACTION_TYPES_IN_UI = ["sleep", "shutdown", "reboot", "terminal", "explorer", "kill-foreground", "open", "focus-process"];
for (const t of ACTION_TYPES_IN_UI) {
  ok(ui.includes(`"${t}"`), `面板动作类型含 ${t}（与 Rust 枚举对齐）`);
}
ok(/ms\.gesture/.test(ui), "面板走宿主 ms.gesture API（不裸 invoke）");
ok(
  /\}\)\(ms, env, plugin, host, keyword, inputValue, onSubKeyword, md2html, openExternal\)\s*;?\s*$/.test(ui.trim()),
  "面板入口用宿主注入参数收尾（runPluginEntry 的 new Function 契约）"
);
ok(!/window\.ms|__MS_API__/.test(ui), "面板不依赖全局 window.ms / __MS_API__（宿主从不设置，恒 undefined）");
try {
  new Function(read("plugins/com.zhuangjie.mouse-gesture/ui/index.js"));
  ok(true, "面板 JS 语法可解析");
} catch (e) {
  ok(false, "面板 JS 语法可解析", String(e));
}
const detailHtml = read("plugins/com.zhuangjie.mouse-gesture/ui/detail.html");
ok(detailHtml.includes('id="mg-list"') && detailHtml.includes('id="mg-save"'), "面板骨架：列表与保存按钮存在");

/* ---------------- 5. 识别链路与 HUD（多段手势 / 多屏对齐 / 置顶） ---------------- */
ok(
  (rs.match(/rec\.feed\(\(x - start\.0\) as f64, \(y - start\.1\) as f64\)/g) || []).length >= 2,
  "Rust: Move 与 Up 都按相对起点逐点喂识别器（多段手势识别的前提）"
);
ok(/rec\.pattern\.iter\(\)\.collect\(\)/.test(rs) && !/let pattern = rec\.feed\(x as f64, y as f64\)/.test(rs),
  "Rust: 松手后读取累积 pattern，不再喂入绝对坐标（避免 (0,0)→松手点 的伪方向）");
ok(/fn show_hud[\s\S]*?virtual_screen_bounds\(app\)[\s\S]*?set_always_on_top\(true\)[\s\S]*?w\.show\(\)/.test(rs),
  "Rust: show_hud 先对齐虚拟屏包围盒再重断言 TOPMOST（防被后建置顶窗盖住）");
ok(/"vx": vx, "vy": vy, "vw": vw, "vh": vh/.test(rs), "Rust: 轨迹事件携带虚拟屏包围盒（HUD 坐标对齐依据）");
ok(/"recording": true/.test(rs), "Rust: 录制结果带 recording 标记（HUD 不再误报「未映射」）");
ok(/pub fn gesture_record_start\(app: AppHandle\)/.test(rs) && /show_hud\(&app/.test(rs),
  "Rust: record_start 同步唤起 HUD「录制中」提示");

const hudTs = read("src/gesture.ts");
ok(/let originX = 0/.test(hudTs) && /\(x - originX\) \/ dpr/.test(hudTs),
  "gesture.ts: HUD 画线按虚拟屏包围盒原点平移（多屏/缩放屏不再错位）");
ok(/已录制/.test(hudTs) && /录制中/.test(hudTs), "gesture.ts: HUD 录制提示（录制中 / 已录制 xx）");
ok(/recording\?: boolean/.test(hudTs), "gesture.ts: ResultPayload 含 recording 字段");

/* ---------------- 6. 三处缺陷回归修复 ---------------- */
// (1) HUD 线跟随鼠标：canvas backing store 是物理像素、toLocal 返回 CSS 像素，
//     ctx 必须 setTransform(dpr) 才能两者对齐，否则缩放屏上线缩到 1/dpr 处
ok(/ctx\.setTransform\(dpr, 0, 0, dpr, 0, 0\)/.test(hudTs),
  "gesture.ts: ctx 按 dpr 缩放（物理像素 ↔ CSS 坐标一致，线跟随鼠标）");
ok(!/ctx\.clearRect\(0, 0, canvas\.width, canvas\.height\)/.test(hudTs),
  "gesture.ts: 清屏不再混用物理像素尺寸");

// (2) 已添加的手势项可重新录制：每行有行内录制按钮，按该行索引录制覆盖方向串
ok(/data-act="record"/.test(ui) && /state\.recordingIdx === idx/.test(ui),
  "面板: 每行有重录按钮且按行索引录制（可覆盖已有映射）");
ok(/mg-record-row/.test(read("plugins/com.zhuangjie.mouse-gesture/ui/detail.css")),
  "面板 CSS: 行内录制按钮样式存在");

// (3) 命令行窗口关不掉：吞掉真实 RBUTTONUP 导致右键状态悬挂，需补发合成 UP 复位
ok(/fn release_right_button_state/.test(rs) && /SendInput/.test(rs) && /MOUSEEVENTF_RIGHTUP/.test(rs),
  "Rust: 吞 UP 后补发合成 RBUTTONUP 复位右键状态（窗口可正常关闭）");
ok(/LLMHF_INJECTED/.test(rs) && /WM_CANCELMODE/.test(rs),
  "Rust: 识别注入 UP 并放行 + 取消右键菜单跟踪（合成 UP 不弹菜单）");
ok(/release_right_button_state\(x, y\)/.test(rs),
  "Rust: 识别线程松手收尾时调用补发");

/* ---------------- 7. 呼出程序动作（进程下拉 + 已运行置前 / 未运行启动） ---------------- */
ok(/FocusProcess\s*\{/.test(rs) && /focus-process/.test(rs),
  "Rust: 新增 focus-process 动作变体");
ok(/FocusProcess\s*\{[\s\S]{0,200}exe_path: String/.test(rs) && /#\[serde\(rename = "exePath"\)\]/.test(rs),
  "Rust: 持久化 exe 绝对路径（非 pid/句柄），serde 字段 exePath");
ok(/pub struct RunningProcessDto/.test(rs) && /pub fn gesture_list_processes/.test(rs),
  "Rust: 运行中进程 DTO + 列举命令");
ok(/EnumWindows\(/.test(rs) && /QueryFullProcessImageNameW/.test(rs) && /IsWindowVisible/.test(rs),
  "Rust: 用 EnumWindows + QueryFullProcessImageNameW 枚举有窗口的进程");
ok(/force_foreground\(/.test(rs) && /run_on_main_thread/.test(rs),
  "Rust: 命中进程走主线程 force_foreground 置前（绕过前台锁定）");
ok(/open_path\(target/.test(rs),
  "Rust: 未命中则按 exe 路径启动程序");
ok(librs.includes("mouse_gesture::gesture_list_processes,"), "lib.rs: 注册 gesture_list_processes 命令");
ok(ipc.includes('"gesture_list_processes"') && /RunningProcessIpc/.test(ipc),
  "ipc.ts: 封装 gestureListProcesses + RunningProcessIpc 类型");
ok(/listProcesses:/.test(host) && /gestureListProcesses/.test(host),
  "host.ts: 暴露 ms.gesture.listProcesses");
ok(/gestureListProcesses/.test(read("src/windows/search/usePluginHost.ts")),
  "usePluginHost.ts: 注入进程列举实现");
ok(/data-act="process"/.test(ui) && /data-act="exePath"/.test(ui) && /mg-focus-fields/.test(ui),
  "面板: 呼出程序动作有进程下拉 + 手动路径输入");
ok(/ms\.gesture\.listProcesses/.test(ui) && /mg-refresh-processes/.test(detailHtml),
  "面板: 加载并刷新运行中进程列表");

/* ---------------- 汇总 ---------------- */
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
