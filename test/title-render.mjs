import { renderTitleTags, titleContentHandler, clearHideTagForTitle } from "../src/lib/tags.js";

const cases = [
  "[精选好课] 恋上数据结构与算法",
  "[h'脚本'][系统项]新数据项",
  "[a][b]多标签标题",
  "无标签标题",
  "[系统项]使用说明（了解新功能）",
  "[h'电脑应用'][推荐]typora",
  "[h'常见官网']微信",
];
for (const title of cases) {
  const clean = clearHideTagForTitle(title);
  const out = renderTitleTags(clean) + titleContentHandler(clean);
  console.log(JSON.stringify(title).padEnd(36), "=>", out.replace(/<[^>]+>/g, "").trim());
}
