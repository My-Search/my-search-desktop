/**
 * 回归测试：失焦隐藏的「无条件」契约（用户规则）
 *
 * 用户规则：点窗口外面时，不管当前在干什么（等待搜索 / 结果列表 / 正在查看
 * 简述内容、附加内容、脚本应用 / 搜索进行中 / `:debug`）都先隐藏；
 * 之后再唤醒即可原样显示。
 *
 * 实现契约（本测试以源码为断言对象，防止旧的分状态门控被重新引入）：
 *  1. 隐藏动作在 Rust 侧 `on_window_event` 收到 `Focused(false)` 时**无条件**执行；
 *  2. 不再存在 `BlurHideState` / `set_hide_on_blur` 这类「按状态同步是否允许隐藏」的门控；
 *  3. 前端不再有 `syncBlurHide` / `resolveViewMode` / `shouldHideOnBlur` 分状态判定。
 *
 * 真实交互（详情视图 / 脚本应用下点窗口外仍隐藏、唤醒后原样还原）由
 * `test/blur-hide-ui.test.mjs` 与 `test/summon-keep-input.test.mjs` 在浏览器里覆盖。
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

let pass = 0;
let fail = 0;
const ok = (cond, name) => {
  if (cond) pass++;
  else {
    fail++;
    console.log("  FAIL:", name);
  }
};
/** 去掉注释，避免「文档里提到旧名字」被误判为「代码里还在用」 */
const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/^\s*\/\/!.*$/gm, "");
/** 去掉注释与测试说明后，检查源码里是否还残留某个标识符 */
const codeHas = (src, token) => stripComments(src).includes(token);

const rust = read("src-tauri/src/lib.rs");
const rustCode = stripComments(rust);

// ---- 1. Rust：失焦即隐藏，且没有任何「按状态豁免」的门控 ----
ok(/WindowEvent::Focused\(false\)/.test(rustCode), "Rust 监听 WindowEvent::Focused(false)");
ok(!codeHas(rust, "BlurHideState"), "Rust 不再有 BlurHideState 门控结构");
ok(!codeHas(rust, "set_hide_on_blur"), "Rust 不再有 set_hide_on_blur 命令");
// 断言的是「不再用原子布尔当**失焦门控**」这个意图，而不是「源码里不许出现 AtomicBool」：
// AtomicBool 现在另有用途（AUTOSTART_APPLIED：本次会话是否已应用「开机自启动」偏好，
// 见 apply_autostart_preference），与失焦隐藏无关，不该被这条契约误伤。
ok(
  !/AtomicBool[\s\S]{0,120}(hide|Hide)|(hide|Hide)[\s\S]{0,120}AtomicBool/.test(rustCode),
  "Rust 不再用原子布尔做失焦门控（AtomicBool 不得服务于 hide 门控）"
);
// on_window_event 里对 main 窗口的 Focused(false) 分支必须直接走到「收起 + 隐藏」
// （收起 + 隐藏统一走 collapse_and_hide()，见下面第 4 节：兜底路径也复用同一份实现）
ok(
  /if\s+window\.label\(\)\s*!=\s*"main"[\s\S]{0,600}?(collapse_and_hide\(window\)|window\.hide\(\))/.test(rustCode),
  "Rust on_window_event：主窗口失焦分支直接收起（无前置状态判断）"
);
// 门控标志的读取（如果存在）不应出现在失焦分支里
ok(
  !/Focused\(false\)[\s\S]{0,600}?store\([\s\S]{0,40}?Ordering::/.test(rustCode),
  "Rust 失焦分支内不再读写任何原子门控标志"
);

// ---- 2. 前端：分状态判定与同步机制已彻底移除 ----
const bridge = read("src/lib/tauri-bridge.ts");
const util = read("src/lib/util.ts");
const state = read("src/windows/search/useSearchState.ts");
const app = read("src/windows/search/App.vue");

ok(!codeHas(bridge, "setHideOnBlur"), "前端 tauri-bridge 不再导出 setHideOnBlur");
ok(!codeHas(util, "shouldHideOnBlur"), "前端 util 不再有 shouldHideOnBlur 分状态判定");
ok(!codeHas(util, "resolveViewMode"), "前端 util 不再有 resolveViewMode 分状态判定");
ok(!codeHas(state, "syncBlurHide"), "useSearchState 不再有 syncBlurHide 同步");
ok(!codeHas(state, "bindVisibilityReaders"), "useSearchState 不再读取 DOM 可见性来判定隐藏");
ok(!codeHas(app, "syncBlurHide"), "App.vue 不再调用 syncBlurHide");
ok(!codeHas(app, "bindVisibilityReaders"), "App.vue 不再绑定可见性读取器");

// ---- 3. 唤醒还原逻辑仍在（详情视图原样还原，不丢内容） ----
ok(codeHas(app, "resumeDetailViewIfAny"), "App.vue 保留唤醒还原逻辑 resumeDetailViewIfAny");
ok(
  /state\.mode\s*!==\s*MODE\.SHOW_ITEM_DETAIL[\s\S]{0,200}?detailVisible\.value/.test(stripComments(app)),
  "唤醒还原：详情视图状态下不走复位（原样保留）"
);

// ---- 4. 「点窗口外就收起」的兜底：焦点事件丢失时仍执行同一条用户规则 ----
// 背景（用户反馈）：打开插件前端、按 Esc 后点窗口外，呼出框收不起来——窗口是
// 置顶 + 跳任务栏的，收不起来就一直浮在别的应用上面。根因不是「要不要隐藏」的
// 门控，而是 `Focused(false)` 事件本身可能不到达（呼出时被前台锁定拒绝、
// WebView2 在插件界面焦点元素被移除后不再上报失焦）。兜底必须是**同一条规则**
// 的另一条触发路径，不能引入新的状态门控。
const outside = read("src-tauri/src/outside_click.rs");
const outsideCode = stripComments(outside);
const altClick = stripComments(read("src-tauri/src/alt_click.rs"));

ok(codeHas(rust, "mod outside_click"), "Rust 注册 outside_click 兜底模块");
ok(codeHas(rust, "outside_click::spawn_watchdog"), "Rust setup 启动「点窗口外就收起」兜底线程");
ok(
  /WM_LBUTTONDOWN[\s\S]{0,200}?outside_click::record_click/.test(altClick),
  "鼠标钩子在左键按下时记录坐标（供兜底判定）"
);
// 记录动作必须发生在 hook_proc 里的 Alt+点击开关判断**之前**：兜底与该偏好无关
ok(
  /fn hook_proc[\s\S]{0,400}?outside_click::record_click[\s\S]{0,400}?ENABLED\.load/.test(altClick),
  "点击记录位于 Alt+点击开关判断之前（兜底不依赖该偏好）"
);
ok(codeHas(outsideCode, "inside_window"), "兜底判定：点击点在主窗口矩形内不算点外面");
ok(codeHas(outsideCode, "point_is_self"), "兜底判定：落点属于本进程（原生对话框/设置窗/托盘菜单）不算点外面");
ok(codeHas(outsideCode, "collapse_and_hide"), "兜底收起复用 collapse_and_hide（与失焦路径同一份实现）");
ok(
  codeHas(outsideCode, "blur_hide_suppressed"),
  "兜底与失焦隐藏共用同一抑制期（不新增门控）"
);
ok(
  codeHas(rust, "pub(crate) fn blur_hide_suppressed"),
  "Rust 提供 blur_hide_suppressed（失焦分支与兜底共用抑制口径）"
);

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
