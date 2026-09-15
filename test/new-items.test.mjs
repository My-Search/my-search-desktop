/**
 * 「新数据」增量路径回归测试（<new> 特殊搜索）
 *
 * 这是 recordNewItems（还原油猴版 compareBlocks）最核心、也最容易改坏的行为，
 * 必须同时满足三条：
 *   1. **首次加载**：没有历史记录 → 不把全部数据当成「新」（返回 0 条）；
 *   2. **下次加载出现新条目**：只把真正新增的那条标记为「新」，旧条目不算；
 *   3. **再次加载且数据未变**：仍为 0 条（去重不重复标）。
 *
 * 测试用受控的本地数据源（内置 mLineFetchFun 格式）替代真实网络，数据可精确控制。
 *
 * 注意：必须先装好 localStorage 再动态 import 引擎——
 * util.ts 在模块加载时判定一次 `hasLocalStorage`，静态 import 会提前求值。
 */

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const { SearchEngine, SPECIAL_KEYWORD } = await import("../src/lib/search-engine.ts");

const PREFIX = "my-search-desktop:";
const ROOT_URL = "https://example.com/root.ms";
const CONTENT_URL = "https://example.com/content.ms";

// 根订阅是「配置」文件，引用内容源（内容源用内置 mLineFetchFun 解析 `# 标题` 行）
const ROOT_BODY = `<tis::${CONTENT_URL} title="内容源" fetchFun="mLineFetchFun" />`;

/**
 * 受控内容源：每条数据 = `# 标题` + 正文行。
 * 注：mLineFetchFun 与油猴版一致，靠「下一个标题行/文件末尾」提交上一条，
 * 因此每条标题下必须有正文（真实订阅文件即此格式）。
 */
const itemBlocks = (titles) =>
  titles.map((t) => `# ${t}\n${t} 的正文内容`).join("\n\n") + "\n";
let contentTitles = ["条目A", "条目B"];
globalThis.fetch = async (url) => {
  const u = String(url);
  const body = u === ROOT_URL ? ROOT_BODY : itemBlocks(contentTitles);
  return { ok: true, text: async () => body };
};

const SUBS = [{ url: ROOT_URL, title: "根订阅" }];

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = "") => {
  if (cond) {
    pass++;
    console.log(`  ok - ${name}`);
  } else {
    fail++;
    console.log(`  FAIL: ${name}${extra ? `  → ${extra}` : ""}`);
  }
};

const newTitles = (results) => results.map((r) => String(r.item.title));

// ---------- 第 1 次加载：2 条数据（首次 → 不标记） ----------
const e1 = new SearchEngine();
await e1.loadAll(SUBS);
ok(e1.searchData.length === 2, "首次加载 2 条", `实际 ${e1.searchData.length}`);

const nw1 = await e1.search(SPECIAL_KEYWORD.new);
ok(nw1.length === 0, "首次加载 <new> 为 0 条（不把全部数据当新）", `实际 ${nw1.length}`);

// ---------- 第 2 次加载：新增 1 条 ----------
contentTitles = ["条目A", "条目B", "条目C"];
const e2 = new SearchEngine();
await e2.loadAll(SUBS);
ok(e2.searchData.length === 3, "增量加载 3 条", `实际 ${e2.searchData.length}`);

const nw2 = await e2.search(SPECIAL_KEYWORD.new);
ok(nw2.length === 1, "增量加载 <new> 恰为 1 条（仅新增项）", `实际 ${nw2.length}`);
ok(
  nw2.length === 1 && newTitles(nw2)[0].includes("条目C"),
  "新增项确实是「条目C」",
  newTitles(nw2).join(", ")
);
ok(
  nw2.length === 1 && newTitles(nw2)[0].includes("[最新一条]"),
  "首条带 [最新一条] 标记",
  newTitles(nw2).join(", ")
);

// ---------- 第 3 次加载：数据不变 → 记录保留且不重复累积 ----------
// 原版语义：「还没有过期的（新数据），保留下来放在最新数据中」，
// 即新增项在 7 天有效期内持续可见；但不应因再次加载而重复计数。
const e3 = new SearchEngine();
await e3.loadAll(SUBS);
const nw3 = await e3.search(SPECIAL_KEYWORD.new);
ok(nw3.length === 1, "数据未变时 <new> 仍为 1 条（有效期内保留）", `实际 ${nw3.length}`);
ok(
  nw3.length === 1 && newTitles(nw3)[0].includes("条目C"),
  "保留的仍是「条目C」",
  newTitles(nw3).join(", ")
);
const recAfterLoad3 = JSON.parse(store.get(PREFIX + "SEARCH_NEW_ITEMS_KEY") ?? "[]");
ok(recAfterLoad3.length === 1, "记录未重复累积（仍为 1 条）", `实际 ${recAfterLoad3.length}`);

// ---------- 第 4 次加载：记录已过期 → 不再展示 ----------
const rec = JSON.parse(store.get(PREFIX + "SEARCH_NEW_ITEMS_KEY") ?? "[]");
ok(Array.isArray(rec) && rec.length === 1, "存储中有 1 条新数据记录", `实际 ${rec.length}`);
if (Array.isArray(rec) && rec.length > 0) {
  rec.forEach((r) => (r.expires = Date.now() - 1000));
  store.set(PREFIX + "SEARCH_NEW_ITEMS_KEY", JSON.stringify(rec));
  const e4 = new SearchEngine();
  await e4.loadAll(SUBS);
  const nw4 = await e4.search(SPECIAL_KEYWORD.new);
  ok(nw4.length === 0, "过期记录不再展示", `实际 ${nw4.length}`);
}

console.log("");
if (fail) {
  console.error(`结果: ${pass} 通过, ${fail} 失败`);
  process.exit(1);
}
console.log(`结果: ${pass} 通过, 0 失败`);
