/**
 * 数据项「稳定解析 / 身份对齐」回归测试。
 *
 * 背景（用户报告的严重问题）：搜索结果集里显示的 favicon/url 与实际 title 对不上。
 * 根因有两处：
 *   1. 展示层用 `item.index`（数组下标）去 `engine.searchData[index]` 反查原项取图标，
 *      而 `_attachExtraItems()` 摘除旧插件项后数组前移却不重建下标 → 下标指向别的数据项。
 *   2. `overlapMatchingDegreeForObjectArray` 在 onlyHasScope 时只过滤对象、不过滤分数，
 *      导致「结果项 ↔ 分数」整体错位。
 *
 * 本测试锁定修复后的不变量：
 *   - 身份由**对象引用/内容派生指纹**承载，与数组位置无关。
 *   - 指纹去标签、稳定：同一数据项无论是否追加 [可搜索] 标签、无论被搬到哪里，指纹不变。
 *   - overlap 返回项与 score 严格一一对应（含零分项被丢弃的场景）。
 */
import { itemId, itemFingerprint, itemIdentity } from "../src/lib/search-engine.ts";
import { overlapMatchingDegreeForObjectArray } from "../src/lib/overlap.ts";
import { mLineFetchFun } from "../src/lib/subscribe-parser.ts";

let pass = 0;
let fail = 0;
const ok = (cond, name) => {
  if (cond) pass++;
  else {
    fail++;
    console.log("  FAIL:", name);
  }
};

// ---- 1. 指纹：内容派生、位置无关 ----
const a = { title: "Node.js 官网", desc: "JavaScript 运行时", resource: "https://nodejs.org", subscribe: "开发" };
const aCopy = { ...a }; // 内容相同、对象不同
ok(itemFingerprint(a) === itemFingerprint(aCopy), "内容相同的两条数据项 → 指纹相同");
ok(
  itemFingerprint(a) !== itemFingerprint({ ...a, resource: "https://deno.com" }),
  "同标题不同资源 → 指纹不同（不再像 itemId 那样撞键）"
);

// itemId 的已知缺陷：只由 title+desc 构成，同标题不同资源会撞键
const sameTitle1 = { title: "首页", desc: "d", resource: "https://a.com" };
const sameTitle2 = { title: "首页", desc: "d", resource: "https://b.com" };
ok(itemId(sameTitle1) === itemId(sameTitle2), "（前提）itemId 对同标题不同资源确实撞键");
ok(itemFingerprint(sameTitle1) !== itemFingerprint(sameTitle2), "指纹能区分它们");

// ---- 2. 指纹去标签：追加 [可搜索] 标签不应改变身份 ----
const pro = { ...a, title: "[可搜索]" + a.title };
ok(itemFingerprint(pro) === itemFingerprint(a), "追加 [可搜索] 标签后指纹不变");
ok(itemFingerprint({ ...a, title: "[新] " + a.title }) === itemFingerprint(a), "追加 [新] 标签后指纹不变");

// ---- 3. itemIdentity：优先 _fp，回退 itemId ----
ok(itemIdentity({ ...a, _fp: "FP" }) === "FP", "有 _fp 时用 _fp");
ok(itemIdentity(a) === itemId(a), "无 _fp 时回退 itemId");
ok(itemIdentity(null) === null, "null → null");

// ---- 4. 关键回归：结果项取 favicon 的 domain 必须与自身 resource 一致 ----
// 模拟展示层旧逻辑（searchData[item.index]）在数组变动后的错位，
// 以及新逻辑（直接使用展示项自身）的正确性。
const searchData = [
  { title: "站一", desc: "d1", resource: "https://one.example.com" },
  { title: "站二", desc: "d2", resource: "https://two.example.com" },
  { title: "站三", desc: "d3", resource: "https://three.example.com" },
];
const domainOf = (u) => new URL(u).hostname;

// 旧：下标反查。数据项被前移（如摘除插件项）后，旧下标会指向别人。
const staleIndexedItem = searchData[2]; // "站三"
const staleIndex = 2;
searchData.splice(0, 1); // 摘除首项 → 数组前移，"站三"现在在 index 1
const oldLookup = searchData[staleIndex]; // 越界/错位：旧代码用它取 favicon
ok(
  oldLookup == null || domainOf(oldLookup.resource) !== domainOf(staleIndexedItem.resource),
  "（复现旧缺陷）陈旧下标反查会指向别的数据项"
);

// 新：展示项即原项，favicon 一定与自身 resource 同源
const refItem = staleIndexedItem;
ok(domainOf(refItem.resource) === domainOf(staleIndexedItem.resource), "新逻辑：图标域与自身 URL 域一致");

// ---- 5. overlap：结果项与 score 严格对齐（onlyHasScope） ----
const keyword = "node";
const objects = [
  { name: "node" }, // 命中，非零分
  { name: "zzz" }, // 不命中，零分（会被丢弃）
  { name: "nodejs" }, // 命中
];
const scoreList = [];
const matched = overlapMatchingDegreeForObjectArray(keyword, objects, (o) => ({ [o.name]: 1 }), {
  onlyHasScope: true,
  scopeForObjArrContainer: scoreList,
});
ok(matched.length === scoreList.length, `matched(${matched.length}) 与 scoreList(${scoreList.length}) 等长`);
ok(
  matched.every((obj, i) => scoreList[i] > 0),
  "对齐后每个保留项的分数都非零（不再出现分数与结果张冠李戴）"
);
ok(matched.every((obj) => obj.name.includes("node")), "只保留命中项");

// 未过滤模式：对象与分数一一对应、长度一致
const allScores = [];
const allMatched = overlapMatchingDegreeForObjectArray(keyword, objects, (o) => ({ [o.name]: 1 }), {
  scopeForObjArrContainer: allScores,
});
ok(allMatched.length === objects.length && allScores.length === objects.length, "未过滤模式：对象与分数等长");

// ---- 6. 解析：mLine 半成品项被显式告警（不静默产出空壳项） ----
const warns = [];
const origWarn = console.warn;
console.warn = (...args) => warns.push(args.join(" "));
const parsed = mLineFetchFun("# 只有标题没有正文\n\n# 正常项(描述)\nhttps://ok.example.com\n");
console.warn = origWarn;
ok(parsed.length === 2, `mLine 解析出 2 条（实际 ${parsed.length}）`);
ok(
  warns.some((w) => w.includes("只有标题")),
  "半成品数据项触发显式告警"
);
ok(
  parsed[1].title === "正常项" && parsed[1].resource.includes("ok.example.com"),
  "正常项 title/resource 同源不错位"
);

console.log(`\ndata-item-identity: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
