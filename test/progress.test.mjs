/**
 * 加载进度测试：验证引擎按「数据块」上报进度（还原原版 refreshNewData →
 * searchPlaceholder("UPDATE") 的行为）。
 *
 * 修复的背景：用户反馈「怎么一直显示加载中？且我搜索也有数据了，且也没有显示加载进度」。
 * 原版在每解析完一个内容源时都会刷新一次 `🔁 数据库更新到 N条`，
 * 因此进度提示应当：
 *  1. 随加载推进而更新（条数单调不减）；
 *  2. 在加载完成后自然停止上报（不会永远停留在「加载中」）。
 */
import { SearchEngine } from "../src/lib/search-engine.ts";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const SUBS = [
  {
    url: "https://cdn.jsdelivr.net/gh/My-Search/official-subscribe@dev/only-system-index.ms",
    title: "系统项",
  },
  {
    url: "https://cdn.jsdelivr.net/gh/My-Search/official-subscribe@dev/index.ms",
    title: "收藏室",
  },
];

let pass = 0;
let fail = 0;
const ok = (cond, name) => {
  if (cond) pass++;
  else {
    fail++;
    console.log("  FAIL:", name);
  }
};

// ---- 1. 加载过程中会上报进度 ----
const engine = new SearchEngine();
const events = [];
engine.onProgress = (count) => events.push(count);

await engine.loadAll(SUBS);

ok(events.length > 0, `加载过程中上报了 ${events.length} 次进度`);
ok(engine.searchData.length > 300, `最终数据量 ${engine.searchData.length} 条`);

// 进度条数单调不减（数据块依次挂载）
ok(
  events.every((v, i) => i === 0 || v >= events[i - 1]),
  "进度条数单调不减"
);

// 关键回归：加载结束后不再上报（保证进度提示能自然停下，而不是永远加载中）
const afterCount = events.length;
await new Promise((r) => setTimeout(r, 300));
ok(events.length === afterCount, "加载完成后不再上报进度（不会一直显示加载中）");

// 最后一次进度应等于最终条数（进度走到 100%）
ok(
  events[events.length - 1] === engine.searchData.length,
  `最后进度(${events[events.length - 1]}) = 最终条数(${engine.searchData.length})`
);

// 进度报告的是「已挂载到引擎的条数」，与最终数据一致
ok(events[events.length - 1] > 300, "最终进度为完整条数（非中途截断）");

// ---- 2. 缓存挂载不应触发进度上报（原版直接用缓存不发起更新） ----
const cached = new SearchEngine();
const cachedEvents = [];
cached.onProgress = (c) => cachedEvents.push(c);
await cached.initData(SUBS); // 命中上一步写入的缓存
ok(cached.searchData.length > 300, "缓存挂载数据可用");
ok(cachedEvents.length === 0, "命中缓存时不上报加载进度（无网络更新）");

// ---- 3. 进度回调抛异常不影响加载 ----
const boom = new SearchEngine();
boom.onProgress = () => {
  throw new Error("callback boom");
};
let boomErr = null;
try {
  await boom.loadAll(SUBS);
} catch (e) {
  boomErr = e;
}
ok(boomErr === null, "进度回调异常不阻断加载");
ok(boom.searchData.length > 300, "回调异常时数据依然加载完整");

// ---- 4. 未设置回调时正常工作 ----
const plain = new SearchEngine();
await plain.loadAll(SUBS);
ok(plain.searchData.length > 300, "未设置 onProgress 时正常加载");

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
