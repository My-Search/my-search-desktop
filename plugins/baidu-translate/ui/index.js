/**
 * 百度翻译插件入口 —— 内嵌「可嵌入的翻译页」，子关键词自动填入翻译框并聚焦。
 *
 * 为什么不用 `https://fanyi.baidu.com/`：
 *   该地址返回 `X-Frame-Options: deny` + `Content-Security-Policy: frame-ancestors 'none'`，
 *   iframe 里根本渲染不出来；官方内嵌页 `iframe.html` 也已失效（200 但空 body）。
 *   实测唯一既能嵌入、又能按 URL 预填的是 `mtpe-individual/transText`：
 *     https://fanyi.baidu.com/mtpe-individual/transText?query=11&lang=en2zh
 *   （在应用真实来源 http://tauri.localhost 下验证：输入框显示 11、译文显示 eleven）
 *
 * 为什么必须改 iframe 的 src（顶层导航）而不是改 hash：预填只在「顶层页面导航」时
 * 被百度路由读取，iframe 内改 hash 不生效（实测）。
 *
 * 本文件被 runPluginEntry 以 new Function("ms","onSubKeyword",...,code) 调用，
 * `ms` 和 `onSubKeyword` 是函数作用域参数，直接可用。
 */

const frame = document.getElementById("bt-frame");
/** 唯一可嵌入的翻译页（fanyi.baidu.com/ 会被 X-Frame-Options 拒绝） */
const BASE = "https://fanyi.baidu.com/mtpe-individual/transText";

/** 语言对：含中文 → 中译英；否则英译中（与百度页的自动方向一致） */
function langPair(text) {
  return /[\u4e00-\u9fa5]/.test(text) ? "zh2en" : "en2zh";
}

/** 构造预填 URL（空文本退回不带参数的首页） */
function buildUrl(text) {
  const q = String(text == null ? "" : text).trim();
  if (!q) return BASE;
  return BASE + "?query=" + encodeURIComponent(q) + "&lang=" + langPair(q);
}

/** 上一次导航过的地址：同内容不重复导航，避免 iframe 反复重载闪烁 */
let lastUrl = "";

/** 把子关键词填进翻译框（改 src 触发顶层导航 → 百度路由按 query 预填） */
function setQuery(text) {
  if (!frame) return;
  const q = String(text == null ? "" : text).trim();
  if (!q) return;
  const target = buildUrl(q);
  if (target === lastUrl) return;
  lastUrl = target;
  frame.src = target;
}

/**
 * 自动聚焦：把焦点交给 iframe（跨域拿不到内部 DOM，但聚焦 iframe 元素
 * 会把键盘焦点交给它的文档，翻译输入框随之可输入 —— 实测敲字落在百度输入框里）。
 */
function focusInput() {
  if (!frame) return;
  try {
    frame.focus();
  } catch (e) {
    /* 忽略：聚焦失败不影响翻译功能 */
  }
}

// 打开插件即聚焦。iframe 刚插入时可能尚未完成布局，双次兜底更稳。
requestAnimationFrame(() => {
  focusInput();
  setTimeout(focusInput, 200);
});

if (typeof onSubKeyword === "function") {
  onSubKeyword(function (msg) {
    setQuery(msg);
    focusInput();
  });
}
