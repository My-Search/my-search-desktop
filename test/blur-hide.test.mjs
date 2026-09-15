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
ok(!codeHas(rust, "AtomicBool"), "Rust 不再用原子布尔做失焦门控");
// on_window_event 里对 main 窗口的 Focused(false) 分支必须直接走到 hide()
ok(
  /if\s+window\.label\(\)\s*!=\s*"main"[\s\S]{0,600}?window\.hide\(\)/.test(rustCode),
  "Rust on_window_event：主窗口失焦分支直接 hide()（无前置状态判断）"
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

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
