import { SearchEngine } from "../src/lib/search-engine.js";
import { md2html, parseUrl, clearUrlSearchTemplate, isUrl } from "../src/lib/util.js";
import {
  parseTag,
  clearHideTagForTitle,
  titleContentHandler,
  titleTagHandler,
} from "../src/lib/tags.js";
import { mLineFetchFun, escapeText, recoveryText } from "../src/lib/subscribe-parser.js";

const subs = [
  {
    url: "https://cdn.jsdelivr.net/gh/My-Search/official-subscribe@dev/only-system-index.ms",
    title: "系统项",
  },
  {
    url: "https://cdn.jsdelivr.net/gh/My-Search/official-subscribe@dev/index.ms",
    title: "收藏室",
  },
];
const e = new SearchEngine();
await e.loadAll(subs);

let pass = 0;
let fail = 0;
const ok = (cond, name) => {
  if (cond) pass++;
  else {
    fail++;
    console.log("  FAIL:", name);
  }
};

// 1. 数据量
ok(e.searchData.length > 300, `数据量 ${e.searchData.length} > 300`);
ok(Object.keys(e.tagsMap).length > 10, `标签数 ${Object.keys(e.tagsMap).length} > 10`);

// 2. 精确中文
ok((await e.search("微信")).length > 3, "搜 微信");
ok((await e.search("系统项")).length >= 5, "搜 系统项");
ok((await e.search("typora")).length >= 1, "搜 typora");

// 3. 拼音
ok((await e.search("weixin")).length > 3, "拼音 weixin");

// 4. 内容命中（resource/links）
ok((await e.search("github")).length > 10, "内容命中 github");

// 5. 模糊兜底（精确无结果）
const fz = await e.search("wxzf");
ok(fz.length > 0 && fz[0].level === 9, `模糊 wxzf -> ${fz.length}`);

// 6. 命中优先级：标题层在前
const r = await e.search("电脑");
ok(r.length > 10, "搜 电脑");
ok(r[0].level === 0, "标题层优先");

// 7. default-tag 生效（电脑.md -> [h'电脑应用']）
const typora = e.searchData.find((i) => i.title.includes("typora"));
ok(typora && typora.title.startsWith("[h'电脑应用']"), `default-tag 生效: ${typora && typora.title}`);

// 8. 标签解析
const t = parseTag("[h'电脑应用'][推荐]typora");
ok(t.length === 2 && t[0][3] === "电脑应用" && t[1][3] === "推荐", "parseTag 提取两个标签");
ok(clearHideTagForTitle("[h'电脑应用'][推荐]typora") === "[推荐]typora", "clearHideTagForTitle");
ok(titleContentHandler("[h'电脑应用'][推荐]typora").includes(">typora<"), "titleContentHandler 去标签");
ok(typeof titleTagHandler("x") === "string", "titleTagHandler 运行");

// 9. vassal / links 存在
ok(
  e.searchData.some((i) => i.vassal != null),
  "存在 vassal 附加内容项"
);
ok(
  e.searchData.some((i) => Array.isArray(i.links) && i.links.length > 0),
  "存在 links 快捷链接项"
);

// 10. 脚本项识别
ok(
  e.searchData.some((i) => i.type === "script"),
  "存在 script 类型项"
);

// 11. mLineFetchFun 单测
const sample = [
  "# [标签]标题A（描述A）",
  "https://example.com/a",
  "----",
  "> [相关](https://example.com/b \"说明\")",
  "补充说明文字",
  "# 标题B",
  "一些文本",
].join("\n");
const items = mLineFetchFun(sample);
ok(items.length === 2, `mLineFetchFun 解析 2 项, got ${items.length}`);
ok(items[0].title === "[标签]标题A" && items[0].desc === "描述A", "标题/描述解析");
ok(items[0].resource.trim() === "https://example.com/a", "resource 解析");
ok(items[0].vassal != null && items[0].vassal.includes("补充说明"), "vassal 解析");
ok(Array.isArray(items[0].links) && items[0].links[0].url === "https://example.com/b", "links 解析");
ok(items[1].desc === "--无描述--", "无描述默认值");

// 12. 转义/恢复
ok(recoveryText(escapeText("a`b\\c$d")) === "a`b\\c$d", "转义/恢复往返");

// 13. URL 工具
ok(isUrl("https://a.com/x") === true && isUrl("普通文本") === false, "isUrl");
ok(clearUrlSearchTemplate("https://a.com/[[s?q={keyword}]]") === "https://a.com/", "clearUrlSearchTemplate");
const p = parseUrl("https://www.example.com/path?q=1");
ok(p.domain === "www.example.com" && p.rootUrl === "https://www.example.com", "parseUrl");

// 14. md2html
const html = md2html("# 标题\n- a\n- [x](https://a.com)\n`code`\n> quote");
ok(
  html.includes("<h1>") && html.includes("<ul>") && html.includes("<blockquote>") && html.includes("<code>"),
  "md2html"
);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
