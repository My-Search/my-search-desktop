import { SearchEngine } from "../src/lib/search-engine.js";
import { renderTitleTags, titleContentHandler, clearHideTagForTitle } from "../src/lib/tags.js";
import { escapeHtml } from "../src/lib/util.js";

const e = new SearchEngine();
await e.loadAll([
  { url: "https://cdn.jsdelivr.net/gh/My-Search/official-subscribe@dev/only-system-index.ms", title: "系统项" },
  { url: "https://cdn.jsdelivr.net/gh/My-Search/official-subscribe@dev/index.ms", title: "收藏室" },
]);

const item = e.searchData.find((i) => i.title.includes("恋上数据结构"));
const clean = clearHideTagForTitle(String(item.title));
const tagRendered = renderTitleTags(escapeHtml(clean));
const titleContent = titleContentHandler(clean);

console.log("原始标题 :", JSON.stringify(item.title));
console.log("渲染结果 HTML:");
console.log("  " + tagRendered + titleContent);
console.log("\n用户可见文本:", (tagRendered + titleContent).replace(/<[^>]+>/g, ""));
