/**
 * 回归测试：「问AI : 你好」的子关键词转发契约（还原油猴版）
 *
 * 背景：官方系统项「[脚本]问AI」的使用方式是
 *   `<搜索数据项><tab><子项接收文本>`（见官方订阅说明 3.1）：
 *   呼出搜索框 → 按 Tab（空内容 → 转发为「问AI : 」）→ 回车打开「问AI」脚本应用
 *   → 输入问题再回车，问题会交给应用里的 `MS_SCRIPT_ENV.event.sendListener`。
 *
 * 桌面版曾丢失三处原版行为，导致「你好」永远传不到应用：
 *   1. 脚本视图挂载完成后没有自动调用 `tryRunTextViewHandler()`
 *      （原版在 `view.mount()` → `waitViewRenderingComplete` 回调里调用）；
 *   2. 输入框变化时无条件 `hideTextView()`，输入「问AI : 你好」的瞬间就把会话销毁了
 *      （原版 `handler` 开头有「正在编辑子关键词就不重搜」的守卫）；
 *   3. 转发后把输入框截成了 `父关键词`，而原版是
 *      `input.val(rawKeyword.replace(msg,""))`，即保留「父关键词 : 」便于连续追问。
 *
 * 本测试以源码为断言对象（不需要构建）；真实交互路径由
 * `test/ai-ask-ui.test.mjs` 在浏览器里端到端覆盖。
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
/** 去掉注释，避免「文档里提到旧做法」被误判为「代码里还在用」 */
const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const host = read("src/windows/search/useScriptHost.ts");
const state = read("src/windows/search/useSearchState.ts");
const app = read("src/windows/search/App.vue");
const hostCode = stripComments(host);
const stateCode = stripComments(state);
const appCode = stripComments(app);

// ---- 1. 挂载完成后自动转发子关键词（原版 waitViewRenderingComplete → tryRunTextViewHandler） ----
ok(
  /waitViewRenderingComplete\s*\([\s\S]{0,400}?tryRunScriptTextViewHandler\s*\(\s*opts\.getInputValue\(\)\s*\)/.test(
    hostCode
  ),
  "脚本视图挂载完成后自动调用 tryRunScriptTextViewHandler(读取输入框)"
);
ok(
  /if\s*\(\s*pushed\.handled\s*\)\s*opts\.setInputValue\s*\(\s*pushed\.nextKeyword\s*\)/.test(hostCode),
  "自动转发成功后按原版语义改写输入框（setInputValue(nextKeyword)）"
);

// ---- 2. 输入框编辑子关键词时不销毁脚本会话（原版 handler 开头守卫） ----
ok(
  /function\s+isSubKeywordEditing\s*\(/.test(stateCode),
  "useSearchState 提供 isSubKeywordEditing（还原 handler 守卫）"
);
ok(
  /function\s+onInput\s*\([\s\S]{0,600}?isSubKeywordEditing\s*\(value\)/.test(stateCode),
  "引擎侧 onInput：编辑子关键词时短路（不重搜）"
);
ok(
  /isSubKeywordEditing\s*\(v\)/.test(appCode),
  "App.vue onInput：编辑子关键词时不退出详情视图（保住脚本会话）"
);
// 守卫必须在 hideTextView() 之前生效
ok(
  /isSubKeywordEditing\s*\(v\)[\s\S]{0,400}?hideTextView\s*\(/.test(appCode),
  "App.vue：守卫判定先于 hideTextView（否则会话已被销毁）"
);

// ---- 3. 转发后保留「父关键词 : 」（原版 replace(msg,"")，不是整段截断到父关键词） ----
ok(
  /nextKeyword\s*=.*replace\s*\(\s*msg\s*,\s*""\s*\)/.test(hostCode.replace(/\s+/g, " ")),
  "tryRunScriptTextViewHandler：用 replace(msg,\"\") 还原原版输入框改写"
);
ok(
  /const\s+pushed\s*=\s*scriptHost\.tryRunScriptTextViewHandler\s*\(inputValue\.value\)/.test(appCode),
  "App.vue 回车：调用返回 { handled, nextKeyword } 的新签名"
);
ok(
  !/tryRunScriptTextViewHandler\s*\(inputValue\.value\)\s*\)\s*\{[\s\S]{0,200}?split\(SEARCH_BOUNDARY\)\[0\]/.test(
    appCode
  ),
  "App.vue 回车：不再把输入框整段截断为父关键词"
);

// ---- 4. 子关键词为空时也视为「已交给脚本」（原版 getSubSearchKeyword 返回 ""） ----
ok(
  /parts\.length\s*<\s*2\s*\)\s*return\s*\{\s*handled:\s*false/.test(hostCode.replace(/\s+/g, " ")),
  "无分隔符时不吞回车（handled=false）"
);
ok(
  !/if\s*\(\s*!msg\s*\)\s*return\s*\{\s*handled:\s*false/.test(hostCode),
  "子关键词为空时不再直接返回未处理（与原版一致地吞掉这次回车）"
);

// ---- 5. 转发结果以 onRedirect 走正常输入路径，记录「已进入子搜索模式」 ----
ok(
  /search\.onRedirect\s*\([\s\S]{0,300}?search\.onInput\s*\(keyword\)/.test(appCode),
  "问AI 转发（onRedirect）走 search.onInput，记录子搜索模式状态"
);

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
