/**
 * 百度翻译插件入口 —— 直接嵌入 fanyi.baidu.com，子关键词自动填入翻译框。
 *
 * 本文件被 runPluginEntry 以 new Function("ms","onSubKeyword",...,code) 调用，
 * `ms` 和 `onSubKeyword` 是函数作用域参数，直接可用。
 */

const frame = document.getElementById("bt-frame");
const BASE = "https://fanyi.baidu.com/";

function setQuery(text) {
  if (!frame || !text) return;
  const target = BASE + "#/" + encodeURIComponent(text);
  // 避免重复导航同一内容
  if (frame.src === target) return;
  frame.src = target;
}

if (typeof onSubKeyword === "function") {
  onSubKeyword(function (msg) {
    setQuery(msg);
  });
}
