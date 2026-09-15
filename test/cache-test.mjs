/**
 * 数据缓存测试：验证「未过期复用缓存、过期重新加载」
 *
 * 关键验证点（对应油猴版 SEARCH_DATA_KEY + effectiveDuration）：
 * 1. 首次加载会发起网络请求，并写入带过期时间的缓存
 * 2. 重启（新引擎实例）时缓存未过期 → 直接复用，**不发任何网络请求**
 * 3. 缓存数据挂载后，搜索结果与「真正加载」的结果一致
 * 4. 缓存过期 → 重新联网加载
 * 5. 订阅变化 → 缓存立即失效（避免改了订阅还展示旧数据）
 */

// ---- 1. 用内存版 localStorage 模拟持久化存储 ----
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const { SearchEngine, EFFECTIVE_DURATION, SEARCH_DATA_KEY, subscribeFingerprint } =
  await import("../src/lib/search-engine.ts");

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
  if (cond) {
    pass++;
    console.log("  ok -", name);
  } else {
    fail++;
    console.log("  FAIL:", name);
  }
};

// ---- 2. 首次加载：联网 + 写缓存 ----
const networkCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => {
  networkCalls.push(args[0]);
  return realFetch(...args);
};

const first = new SearchEngine();
await first.initData(SUBS);
const firstCalls = networkCalls.length;
ok(firstCalls > 0, `首次加载发起网络请求（${firstCalls} 次）`);
ok(first.searchData.length > 100, `首次加载数据量 ${first.searchData.length} 条`);

const pkg = JSON.parse(store.get("my-search-desktop:" + SEARCH_DATA_KEY));
ok(Array.isArray(pkg.data) && pkg.data.length === first.searchData.length, "已写入数据缓存");
ok(pkg.expire - Date.now() > EFFECTIVE_DURATION - 60_000, "缓存有效期为 12 小时");

// 缓存里不应保存体积较大的派生索引字段
ok(
  !("_titleUpper" in pkg.data[0]) && !("_titlePinyin" in pkg.data[0]),
  "缓存不保存派生索引字段（体积更小）"
);

// ---- 3. 模拟重启：断网后新引擎应直接复用缓存 ----
networkCalls.length = 0;
globalThis.fetch = () => {
  throw new Error("重启后不应发起网络请求（缓存未过期）");
};

const second = new SearchEngine();
await second.initData(SUBS);
ok(networkCalls.length === 0, "重启后未发起网络请求（直接复用缓存）");
ok(
  second.searchData.length === first.searchData.length,
  `缓存挂载数据量一致（${second.searchData.length} 条）`
);
// 索引字段在挂载时重建
ok(
  typeof second.searchData[0]._titleUpper === "string" &&
    typeof second.searchData[0]._titlePinyin === "string",
  "缓存挂载时重建了检索索引"
);

// ---- 4. 搜索结果一致性：缓存挂载 vs 首次加载 ----
const kw = "微信";
const r1 = await first.search(kw);
const r2 = await second.search(kw);
const sig = (rs) => rs.slice(0, 15).map((r) => `${r.level}:${r.item.title}`).join("|");
ok(r2.length > 0, `缓存数据可正常搜索「${kw}」(${r2.length} 条)`);
ok(sig(r1) === sig(r2), "缓存挂载后的搜索结果与首次加载完全一致");
ok((await second.search("weixin")).length > 0, "缓存挂载后拼音搜索可用");

// ---- 5. 缓存过期 → 重新联网 ----
const expired = JSON.parse(store.get("my-search-desktop:" + SEARCH_DATA_KEY));
expired.expire = Date.now() - 1000;
store.set("my-search-desktop:" + SEARCH_DATA_KEY, JSON.stringify(expired));

networkCalls.length = 0;
globalThis.fetch = (...args) => {
  networkCalls.push(args[0]);
  return realFetch(...args);
};
const third = new SearchEngine();
await third.initData(SUBS);
ok(networkCalls.length > 0, `缓存过期后重新联网加载（${networkCalls.length} 次请求）`);
ok(third.searchData.length > 100, "过期后重新加载成功");

// ---- 6. 订阅变化 → 缓存失效 ----
const changed = new SearchEngine();
const changedSubs = [...SUBS, { url: "https://example.com/x.ms", title: "新订阅" }];
ok(
  subscribeFingerprint(SUBS) !== subscribeFingerprint(changedSubs),
  "订阅指纹随订阅变化"
);
networkCalls.length = 0;
await changed.initData(changedSubs);
ok(networkCalls.length > 0, "订阅变化后重新联网加载（不使用旧缓存）");

// ---- 7. force 强制刷新 ----
networkCalls.length = 0;
const forced = new SearchEngine();
await forced.initData(SUBS, { force: true });
ok(networkCalls.length > 0, "force=true 时忽略缓存，强制重新加载");

// ---- 8. 离线回退：缓存过期但网络全失败 → 复用旧缓存（不清空） ----
const expired2 = JSON.parse(store.get("my-search-desktop:" + SEARCH_DATA_KEY));
expired2.expire = Date.now() - 1000;
store.set("my-search-desktop:" + SEARCH_DATA_KEY, JSON.stringify(expired2));
const offlinePkgSize = store.get("my-search-desktop:" + SEARCH_DATA_KEY);
globalThis.fetch = () => Promise.reject(new Error("offline"));
const offline = new SearchEngine();
await offline.initData(SUBS);
ok(offline.searchData.length > 100, `离线时回退到旧缓存（${offline.searchData.length} 条）`);
ok(store.get("my-search-desktop:" + SEARCH_DATA_KEY) === offlinePkgSize, "离线回退不覆写好缓存");

// ---- 9. 网络失败时不得把好缓存覆盖为空 ----
store.clear();
globalThis.fetch = (...args) => {
  networkCalls.push(args[0]);
  return realFetch(...args);
};
networkCalls.length = 0;
const good = new SearchEngine();
await good.initData(SUBS);
const goodSize = store.get("my-search-desktop:" + SEARCH_DATA_KEY).length;
ok(goodSize > 0, `正常加载写入缓存（${(goodSize / 1024).toFixed(0)}KB）`);
// 现在断网并强制刷新：不应清掉好缓存
store.set("my-search-desktop:" + SEARCH_DATA_KEY, JSON.stringify({ ...expired2, expire: Date.now() - 1 }));
const beforeFail = store.get("my-search-desktop:" + SEARCH_DATA_KEY);
globalThis.fetch = () => Promise.reject(new Error("offline"));
const failLoad = new SearchEngine();
await failLoad.loadAll(SUBS);
ok(store.get("my-search-desktop:" + SEARCH_DATA_KEY) === beforeFail, "加载失败时不覆盖已有缓存");

globalThis.fetch = realFetch;
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
