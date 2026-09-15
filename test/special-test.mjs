/**
 * 特殊关键词冒烟验证：<new> / <history> / <highFrequency>
 *
 * 关于 <new> 的期望（对齐油猴版 compareBlocks）：
 * - **首次加载**：原版 `oldNewItems == null` 时写入空记录并 return，
 *   注释写明「如果是第一次加载数据，那不要这次的『新』」→ 应返回 0 条。
 *   （否则第一次装好就会把全部数据标成「新」，与用户直觉不符）
 * - **再次加载且数据未变**：应返回 0 条（正确去重）。
 */
import { SearchEngine, SPECIAL_KEYWORD } from "../src/lib/search-engine.ts";

const SUBS = [
  { url: "https://cdn.jsdelivr.net/gh/My-Search/official-subscribe@dev/only-system-index.ms", title: "系统项" },
  { url: "https://cdn.jsdelivr.net/gh/My-Search/official-subscribe@dev/index.ms", title: "收藏室" },
];

const failures = [];
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  → ${extra}` : ""}`);
  if (!ok) failures.push(name);
};

const e = new SearchEngine();
await e.loadAll(SUBS);

// ---- <new> 首次加载：应为 0（不把全部数据当「新」）----
const nw = await e.search(SPECIAL_KEYWORD.new);
check("<new> 首次加载应为 0 条", nw.length === 0, `实际 ${nw.length}`);

// ---- 加分 + 历史 ----
const { scoreSelect, historySelect } = await import("../src/lib/search-engine.ts");
const item = e.searchData[0];
scoreSelect(item);
historySelect(item);
const hf = await e.search(SPECIAL_KEYWORD.highFrequency);
check("<highFrequency> 有结果", hf.length > 0, `${hf.length} 条 · 首条 ${hf[0] && hf[0].item.title}`);
const hs = await e.search(SPECIAL_KEYWORD.history);
check("<history> 有结果", hs.length > 0, `${hs.length} 条 · 首条 ${hs[0] && hs[0].item.title}`);

// ---- 再次 reload：数据与上次相同，<new> 应为 0（正确去重）----
await e.reload();
const nw2 = await e.search(SPECIAL_KEYWORD.new);
check("reload 后 <new> 仍为 0 条（去重正确）", nw2.length === 0, `实际 ${nw2.length}`);

// ---- 普通关键词仍正常 ----
const wx = await e.search("微信");
check("普通搜索「微信」有结果", wx.length > 0, `${wx.length} 条`);

console.log("");
if (failures.length) {
  console.error(`结果: ${failures.length} 项失败`);
  process.exit(1);
}
console.log("结果: 全部通过");
