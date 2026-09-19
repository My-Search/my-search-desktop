/**
 * 插件「重启标记」的纯逻辑测试。
 *
 * 场景：设置窗口与搜索窗是两个 WebView，只共享 localStorage。「重启」按钮
 * 在设置窗写标记（markPluginFrontendRestart），搜索窗在对齐/打开时消费
 * （takePluginFrontendRestartMarks 批量 / consumePluginFrontendRestart 单个），
 * 强制保活中的旧会话作废，下次打开 = 全新挂载。
 *
 * 要钉死的契约：
 *   1. mark: 同一插件幂等（只记一次）；不同插件互不影响；
 *   2. take: 取出全部并清空（消费即失效）；再次 take 为空；
 *   3. consume: 单个消费，只移除目标插件、保留其它；未标记返回 false；
 *   4. 损坏的持久化内容按空处理（不抛异常），不影响后续标记；
 *   5. 键名与前缀与注册表一致（my-search-desktop: 前缀 + _CACHE_KEY 风格）。
 *
 * 用法: node test/plugin-restart.test.mjs
 */
import {
  PLUGIN_RESTART_MARKS_KEY,
  consumePluginFrontendRestart,
  markPluginFrontendRestart,
  takePluginFrontendRestartMarks,
} from "../src/lib/plugins/restart.ts";

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

const KEY = "my-search-desktop:" + PLUGIN_RESTART_MARKS_KEY;

/** 新建一套内存版 localStorage（每段测试独立，避免互相污染） */
function freshLocalStorage() {
  const store = new Map();
  const ls = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    key: (i) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
  };
  globalThis.localStorage = ls;
  return store;
}

/* ============ 1. mark：幂等 + 互不影响 ============ */
{
  freshLocalStorage();
  markPluginFrontendRestart("com.example.a");
  markPluginFrontendRestart("com.example.a"); // 重复标记同一插件 → 仍只记一次
  markPluginFrontendRestart("com.example.b");
  const marks = takePluginFrontendRestartMarks();
  ok(marks.filter((x) => x === "com.example.a").length === 1, "同一插件重复 mark 幂等（只记一次）", JSON.stringify(marks));
  ok(marks.includes("com.example.b"), "不同插件各自独立标记不互相覆盖");
  ok(marks.length === 2, "共两个标记");
}

/* ============ 2. take：取出并清空，再次取为空 ============ */
{
  freshLocalStorage();
  markPluginFrontendRestart("com.example.a");
  const first = takePluginFrontendRestartMarks();
  const second = takePluginFrontendRestartMarks();
  ok(first.length === 1 && first[0] === "com.example.a", "take 返回全部标记");
  ok(second.length === 0, "take 之后标记被清空（消费即失效）");
  ok(globalThis.localStorage.getItem(KEY) === null, "消费后持久化键被移除");
}

/* ============ 3. consume：单个消费、不动其它 ============ */
{
  freshLocalStorage();
  markPluginFrontendRestart("com.example.a");
  markPluginFrontendRestart("com.example.b");
  ok(consumePluginFrontendRestart("com.example.a") === true, "consume 命中返回 true");
  ok(consumePluginFrontendRestart("com.example.a") === false, "重复 consume 未命中返回 false（已消费）");
  ok(consumePluginFrontendRestart("com.example.never") === false, "未标记的插件返回 false");
  const rest = takePluginFrontendRestartMarks();
  ok(rest.length === 1 && rest[0] === "com.example.b", "consume 只移除目标插件，保留其它");
}

/* ============ 4. 损坏 / 空内容按空处理（不抛异常） ============ */
{
  freshLocalStorage();
  const ls = globalThis.localStorage;
  ok(ls.getItem(KEY) === null && takePluginFrontendRestartMarks().length === 0, "从未写过 → take 为空");
  ls.setItem(KEY, "{ not json");
  ok(takePluginFrontendRestartMarks().length === 0, "损坏的 JSON 按空处理（不抛异常）");
  ls.setItem(KEY, JSON.stringify({ not: "an array" }));
  ok(takePluginFrontendRestartMarks().length === 0, "非数组内容按空处理");
  ls.setItem(KEY, JSON.stringify(["a", 42, null, "b"]));
  ok(takePluginFrontendRestartMarks().length === 2, "数组中非字符串项被过滤，只留字符串");
  // 损坏恢复后仍可正常标记
  markPluginFrontendRestart("com.example.after-corrupt");
  const after = takePluginFrontendRestartMarks();
  ok(after.length === 1 && after[0] === "com.example.after-corrupt", "损坏后 mark/take 仍可正常使用");
}

/* ============ 5. 键名约定 ============ */
{
  ok(typeof KEY === "string" && KEY === "my-search-desktop:PLUGIN_RESTART_MARKS_CACHE_KEY", "键名沿用 my-search-desktop: 前缀 + _CACHE_KEY 风格", KEY);
}

delete globalThis.localStorage;

// ============ 汇总 ============
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);