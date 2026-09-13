import fs from "fs";
const L = fs.readFileSync("我的搜索-7.9.5.js", "utf8").split("\n");
L.forEach((l, i) => {
  if (/titleTagHandler|item_title|titleContentHandler|class="flag"|titleTagHandlers/.test(l)) {
    console.log((i + 1) + "| " + l.replace(/\t/g, "  ").slice(0, 180));
  }
});
