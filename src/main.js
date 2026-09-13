/**
 * 我的搜索（桌面版）- 主应用入口
 *
 * 一比一还原油猴脚本"我的搜索"（v7.9.5）的搜索视图与交互：
 * - 全局快捷键（默认 Ctrl+Alt+S，可在设置中自定义）呼出悬浮搜索框（Rust 端注册）
 * - 输入即搜：精确(标题/描述/内容) → 拼音 → 重叠模糊匹配
 * - 搜索PRO模式（子搜索模式）：输入 "xxx : " 或按 Tab 进入PRO模式，
 *   仅搜索 URL 含搜索模板的 [可搜索] 项，配合子搜索关键词使用
 * - ↑↓ 选择、Enter 打开、Ctrl+Enter 查看附加内容、Esc 隐藏
 * - logo 按钮 = 搜索 [系统项]（与原版一致）
 * - 简述文本 / 附加内容(vassal) / 快捷链接(links) / 标签彩色高亮
 * - 订阅管理（右键 logo / Ctrl+, / 托盘菜单打开独立配置窗口）
 */
import "./css/style.css";
import { renderTitleTags, titleContentHandler, clearHideTagForTitle, extractTagsAndCleanContent } from "./lib/tags.js";
import {
  isTauri,
  getDefaultSubscribeText,
  openExternal,
  openConfigWindow,
  setWindowHeight,
  flushWindowHeight,
  setHideOnBlur,
  hideWindow,
  onMainWindowShown,
  onClearCache,
  httpRequest,
} from "./lib/tauri-bridge.js";
import { overlapMatchingDegreeForObjectArray } from "./lib/overlap.js";
import {
  SearchEngine,
  SEARCH_BOUNDARY,
  SPECIAL_KEYWORD,
  scoreSelect,
  historySelect,
  UNFOLLOW_KEY,
  DEFAULT_UNFOLLOW,
  linksToString,
} from "./lib/search-engine.js";
import { parseAllDesignatedSingTags, subscribeItemsToText } from "./lib/subscribe-parser.js";
import {
  createScriptView,
  createScriptOpen,
  runScriptFunction,
  runViewScript,
  hasScriptView,
  scopeScriptCss,
  SCRIPT_VIEW_ERROR_TIP,
} from "./lib/script-runtime.js";
import {
  escapeHtml,
  escapeAttr,
  isUrl,
  parseUrl,
  clearUrlSearchTemplate,
  debounce,
  storageGet,
  storageSet,
  storageRemove,
  md2html,
  scrollToText,
  calcDetailWindowHeight,
  resolvePlaceholder,
  placeholderProgressText,
  shouldHideOnBlur,
  resolveViewMode,
  PLACEHOLDER_DEFAULT_TEXT,
  PLACEHOLDER_PREPARING_TEXT,
  PLACEHOLDER_RESTORE_MS,
  PLACEHOLDER_PREPARE_MS,
} from "./lib/util.js";
import {
  LOGO_ICON,
  SKETCH_ICON,
  SCRIPT_ICON,
  VASSAL_SVG,
  LOAD_ERROR_ICON,
  ICON_LOADING_PLACEHOLDER,
} from "./lib/assets.js";

// ========== 常量 ==========
const SUBSCRIBES_STORAGE_KEY = "subscribes";

/** 搜索框（含边框）高度。48 = 2(上边框)+44(#searchBox)+2(下边框)，缩放取整对称。 */
const BOX_HEIGHT = 48;
/**
 * 每条结果占用的行高（含 padding 0.5×2 与 margin 0.5×2）。
 * 30.2(line-height) + 0.5×2(padding) + 0.5×2(margin) = 32.2。
 * 这里必须是 32.2（不是 31.2），否则窗口会比 #my_search_box 实际渲染高度矮，
 * 列表底部出现"下巴"（白条）——窗口高度按 calcResultHeight 下发，但实际
 * 内容多 1px×N，N 越大下巴越明显（用户反馈的"溢出下巴"）。
 */
const ROW_HEIGHT = 32.2;
/** 简述/附加内容视图窗口高度下限（内容少时不至于空旷） */
const TEXT_VIEW_MIN_HEIGHT = 140;
/** 简述/附加内容视图窗口高度上限（内容多则在 #text_show 内部滚动） */
const TEXT_VIEW_MAX_HEIGHT = 560;
/** 测量余量：避免因缩放/取整导致内容恰好时闪出滚动条 */
const TEXT_VIEW_HEIGHT_SLACK = 2;
/** 结果区上下 padding（#matchItems: 0 15px 5px） */
const LIST_PADDING = 5;
/** 搜索结果列表固定最多可见条数（还原脚本 showSize=15，且不提供滚动） */
const SHOW_SIZE = 15;

/** favicon 源模板（还原 faviconSources） */
const FAVICON_TEMPLATES = [
  "https://api.iowen.cn/favicon/${domain}.png", // 主源
  "https://api.xinac.net/icon/?url=${rootUrl}", // 备选1
  "https://ico.txmulu.com/${domain}",           // 备选2
  "${rootUrl}/favicon.ico",                     // 永久兜底
];

/** 视图模式（还原 modeEnum） */
const MODE = {
  WAIT_SEARCH: 0,
  SHOW_RESULT: 1,
  SHOW_ITEM_DETAIL: 2,
};

// ========== 全局状态 ==========
const state = {
  engine: new SearchEngine(),
  subscribes: [],
  /** 订阅原文（tis 文本，配置窗口保存的同一份数据） */
  subscribeText: "",
  /** 当前结果 [{item, level, score?}] */
  results: [],
  /** 当前键盘选中项（-1 表示无选中，按方向键才激活） */
  activeIndex: -1,
  /** 文本详情视图内容 */
  mode: MODE.WAIT_SEARCH,
  rawKeyword: "",
  /** 搜索序号（防竞态） */
  searchSeq: 0,
  loading: false,
  /**
   * 是否有搜索在途（还原原版 searchEven.isSearching）。
   * 搜索进行中也属于「不能因失焦而隐藏」的状态（原版 blur 判定里的一项）。
   */
  searching: false,
  /** 上次加载时的「不关注标签」快照：变化时需重新加载（缓存随之失效） */
  unfollowSnapshot: "",
  /** 「缓存被外部清理后重载」的时间保护，避免异常情况下反复重拉 */
  cacheReloadGuardAt: 0,
  /** 是否处于静默后台刷新模式（不更新界面提示） */
  silentRefresh: false,
  /** 后台刷新的定时器句柄 */
  refreshTimer: null,
};

// PRO 模式特殊路由 `^\s*$` → "问AI" 转发（还原 searchableSpecialRouting["^\\s*$"]）：
// 空内容按 Tab（输入框只有 " : "）时，把输入框改写为 "问AI : " 并重新触发搜索。
// （原版通过 registry.searchData.triggerSearchHandle("问AI" + searchBoundary) 实现：
//   设置输入框 value 并手动触发 input 事件 → 立即重新搜索。
//   这里直接同步 doSearch，不走防抖，保证转发立即生效且不重复搜索）
state.engine.onRedirect = (keyword) => {
  const input = document.getElementById("my_search_input");
  if (input) input.value = keyword;
  doSearch(keyword);
};

const app = document.getElementById("app");

// ========== 视图渲染（还原 initView 的 DOM 结构） ==========
function renderApp() {
  app.innerHTML = `
    <div id="my_search_box">
      <div id="tis"></div>
      <div id="my_search_view">
        <div id="searchBox">
          <div id="ms-input-files"></div>
          <input placeholder="我的搜索" id="my_search_input" autocomplete="off" spellcheck="false" />
          <button id="logoButton" title="查看系统项（右键：设置）">
            <img src="${LOGO_ICON}" draggable="false" />
          </button>
        </div>
        <div id="matchResult">
          <ol id="matchItems"></ol>
        </div>
        <div id="text_show" class="ms-markdown-body" style="display:none"></div>
      </div>
    </div>
  `;
}

// ========== favicon（还原 getFaviconImgHtml / getFaviconAPI） ==========
function fillTemplate(template, url) {
  const info = parseUrl(clearUrlSearchTemplate(url));
  if (!info.rootUrl) return "";
  return template.replace(/\$\s*?{[^{}]*rootUrl[^{}]*}/g, info.rootUrl).replace(
    /\$\s*?{[^{}]*domain[^{}]*}/g,
    info.domain || ""
  );
}

/**
 * 生成结果项 favicon 源 URL（还原 getFaviconAPI）
 * @param {string} url 数据项 resource
 * @param {number} [index] 回退源下标
 */
function getFaviconAPI(url, index = 0) {
  const template = FAVICON_TEMPLATES[index] || FAVICON_TEMPLATES[FAVICON_TEMPLATES.length - 1];
  return fillTemplate(template, url);
}

/** 获取所有 favicon 源 URL 列表 */
function getAllFaviconUrls(url) {
  return FAVICON_TEMPLATES.map((t) => fillTemplate(t, url)).filter(Boolean);
}

/**
 * 生成结果项图标（还原 getFaviconImgHtml）
 * - 自定义 icon（脚本项）优先
 * - sketch/script 类型用内置图标
 * - 其它（URL 类型）用 favicon 服务，加载中显示加载 icon，加载完成后替换为真实 favicon，失败回退备用源再回退错误图标
 */
function getFaviconImgHtml(item) {
  if (item == null) return "";
  const resource = String(item.resource || "").trim();
  let customIcon = null;
  if (item.icon != null) {
    customIcon = item.icon;
  } else {
    let type = item.type;
    const typesAndImg = { sketch: SKETCH_ICON, script: SCRIPT_ICON };
    type = type === "url" || type === "sketch" ? (isUrl(resource) ? "url" : "sketch") : type;
    if (type !== "url") customIcon = typesAndImg[type];
  }
  if (customIcon != null) {
    return `<img src="${escapeAttr(customIcon)}" draggable="false" />`;
  }
  const faviconUrls = getAllFaviconUrls(resource);
  // 图标未加载好时显示加载占位 icon，按原版 faviconSources 顺序依次尝试
  return `<img class="searchItem" src="${ICON_LOADING_PLACEHOLDER}" data-favicons="${escapeAttr(
    faviconUrls.join("|")
  )}" draggable="false" />`;
}

// ========== 结果渲染 ==========
/** 构建快捷链接 HTML（完全按脚本 buildRelatedLinksHtml：原文直出，不转义） */
function buildRelatedLinksHtml(links) {
  if (links == null || links.length === 0) return "";
  let html = `<div class="related-links">`;
  links.forEach((link) => {
    html += `<a href="${link.url}" target="_blank" title="${link.title}">${link.text}</a>`;
  });
  html += "</div>";
  return html;
}

/**
 * 结果区窗口高度：**由内容决定**——渲染完成后实测 #my_search_box 的
 * offsetHeight（含 2px 上下边框），下发该真实值给窗口。
 *
 * 之前用「固定常量预估」（BOX_HEIGHT + LIST_PADDING + rows × ROW_HEIGHT），
 * 但 CSS 实际渲染（line-height 30.2 + padding 0.5×2 + margin 0.5×2 + ol 的
 * 下 padding 5px + 搜索框 48px + 边框）与预估有差，行数越多差越大，窗口
 * 比内容高时列表底部出现「下巴」（白条）；窗口比内容矮时底部被裁。
 * 实测 DOM 高度与预估彻底解耦，从根上消除两种情况。
 *
 * 注意：调用时机必须是 DOM 已渲染（innerHTML 赋值之后同步读 offsetHeight
 * 会触发同步 layout，读到的是最新值，无需等下一帧）。
 */
function measureBoxHeight() {
  const box = document.getElementById("my_search_box");
  if (!box) return BOX_HEIGHT;
  return box.offsetHeight;
}

/**
 * 兼容保留：按条数预估高度（仅在无法测量 DOM 时兜底，如盒子尚未挂载）。
 */
function calcResultHeight(count) {
  const rows = Math.min(count, SHOW_SIZE);
  return BOX_HEIGHT + LIST_PADDING + rows * ROW_HEIGHT;
}

function renderResults() {
  const matchItems = document.getElementById("matchItems");
  const matchResult = document.getElementById("matchResult");
  if (!matchItems || !matchResult) return;

  // 详情视图显示中：不覆盖结果
  if (state.mode === MODE.SHOW_ITEM_DETAIL) return;

  const list = state.results.slice(0, SHOW_SIZE);
  const show = list;

  if (show.length === 0) {
    // 无结果：什么都不显示（不出「没有找到…」提示），窗口收回搜索框高度
    matchItems.innerHTML = "";
    matchResult.style.display = "none";
    matchResult.classList.remove("show");
    state.mode = MODE.WAIT_SEARCH;
    syncBlurHide();
    setWindowHeight(BOX_HEIGHT);
    return;
  }

  let html = "";
  show.forEach((result, i) => {
    const item = result.item;
    // 临时展示项（如 <new> 的结果）使用同一 index 展开原项
    const refItem = state.engine.searchData[item.index] || item;
    const isSketch = !isUrl(item.resource);
    const active = i === state.activeIndex ? "active" : "";
    // 完全按脚本：标签彩块 + 标题正文 + 描述均为原文直出（不做 HTML 转义）
    const tagRendered = renderTitleTags(clearHideTagForTitle(String(item.title || "")));
    const titleContent = titleContentHandler(String(item.title || ""));
    const desc = item.desc;
    const linksHtml = buildRelatedLinksHtml(item.links);
    const vassalHtml =
      item.vassal != null
        ? `<a class="vassal" title="查看相关联/同类项内容" data-vassal="${i}">${VASSAL_SVG}</a>`
        : "";

    html += `
      <li class="resultItem ${active}" data-index="${i}">
        ${getFaviconImgHtml(refItem)}
        <a href="${isSketch ? "" : item.resource}" target="_blank" title="${desc}" index="${
      refItem.index ?? i
    }" class="enter_main_link" data-open="${i}">
          ${tagRendered}${titleContent}
          <span class="item_desc">（${desc}）</span>
        </a>
        ${linksHtml}
        ${vassalHtml}
      </li>`;
  });

  matchItems.innerHTML = html;
  matchResult.style.display = "block";
  matchResult.classList.add("show");
  state.mode = MODE.SHOW_RESULT;
  syncBlurHide();
  // 由内容决定高度：渲染完成后实测 #my_search_box 高度下发（消除预估误差）
  setWindowHeight(measureBoxHeight());
  loadResultIcons(matchItems);
  markActive();
}

/**
 * 当前是否允许「窗口失去焦点时自动隐藏」。
 *
 * 规则（用户反馈调整后）：
 *
 * | 当前状态 | 失焦是否隐藏 | 对应原版 |
 * |----------|--------------|----------|
 * | 等待搜索（输入框空、无结果无详情） | ✅ 隐藏 | `seeNowMode() === WAIT_SEARCH` |
 * | 搜索结果列表展示中 | ✅ 隐藏 | —— **桌面版调整**（原版 `!isWaitSearch` 不隐藏） |
 * | 简述内容 / 附加内容 / 脚本应用 | ❌ 不隐藏 | `SHOW_ITEM_DETAIL` |
 * | 搜索进行中 | ❌ 不隐藏 | `searchEven.isSearching` |
 * | `:debug` 指令模式 | ❌ 不隐藏 | `isInstructions("debug")` |
 *
 * 调整说明：原版只有「等待搜索」才隐藏，结果区展示中点窗口外面会留着一块列表；
 * 桌面版悬浮窗的预期是「看完就收起」，所以结果列表展示中也隐藏。
 * 详情视图（简述/附加内容/脚本应用）仍保留不隐藏。
 *
 * 差异说明：原版监听的是**输入框 blur**（焦点在窗口内部的控件之间转移也会触发），
 * 因此需要 `isLogoButtonPressedRef` 来阻止「点 logo 时输入框失焦」误隐藏；
 * 桌面版监听的是**窗口失焦**，点自己窗口内部的按钮不会让窗口失焦，
 * 所以不需要该标志（logo 按下也不会触发隐藏）。
 *
 * 另外原版有 `delayedHideTime=100ms` 的延迟：桌面版由 Rust 侧收到 blur 后
 * 直接判定，前端同步过来的 `hide` 标志在失焦那一瞬已是最新值。
 */
function shouldHideOnBlurNow() {
  // 以**真实 DOM 可见性**为准（`state.mode` 可能滞后，例如 quit 时的残留），
  // 与油猴版 seeNowMode() 一致：详情视图 > 结果列表 > 等待搜索
  const mode = resolveViewMode({
    textViewVisible: isTextViewVisible(),
    resultVisible: isResultVisible(),
    modeEnum: MODE,
  });
  return shouldHideOnBlur({
    mode,
    modeEnum: MODE,
    isSearching: state.searching,
    inputValue: document.getElementById("my_search_input")?.value ?? "",
  });
}

/**
 * 详情视图是否正在显示（还原 seeNowMode 对 textView display 的判定）。
 * `state.mode` 与 DOM 错位时的兼容判断。
 */
function isTextViewVisible() {
  const textView = document.getElementById("text_show");
  return !!textView && textView.style.display !== "none";
}

/**
 * 结果列表是否正在显示（还原 seeNowMode 对 matchResult display 的判定）。
 */
function isResultVisible() {
  const matchResult = document.getElementById("matchResult");
  return !!matchResult && matchResult.style.display !== "none";
}

/**
 * 最后一次同步给 Rust 的失焦隐藏标志（null = 尚未同步过，必须发送一次）。
 * 用于去重：值没变就不发 IPC，避免每次按键都往 Rust 跑一趟。
 */
let lastBlurHideSynced = null;

/**
 * 把最新的失焦隐藏状态同步给 Rust 侧（失焦判定在 window 事件里，只能由后端执行）。
 * 视图状态 / 搜索状态 / `:debug` 模式变化后调用。
 * @param {boolean} [force] 忽略去重，强制发送。
 *        呼出时必须 force：Rust 侧在显示窗口时会把标志复位为 true，
 *        若前端因「值未变」跳过发送，就会与 Rust 侧不一致（窗口会在本该不隐藏时被收起）。
 */
function syncBlurHide(force = false) {
  const hide = shouldHideOnBlurNow();
  if (!force && hide === lastBlurHideSynced) return;
  lastBlurHideSynced = hide;
  setHideOnBlur(hide);
}

/** 图标懒加载：按原版 faviconSources 顺序依次尝试，全部失败显示错误图标 */
function loadResultIcons(container) {
  if (!container) return;
  container.querySelectorAll("img[data-favicons]").forEach((img) => {
    const urls = (img.dataset.favicons || "").split("|").filter(Boolean);
    if (urls.length === 0) {
      img.src = LOAD_ERROR_ICON;
      return;
    }
    let index = 0;
    const tryNext = () => {
      if (index >= urls.length) {
        img.src = LOAD_ERROR_ICON;
        img.removeAttribute("data-favicons");
        return;
      }
      const url = urls[index++];
      const test = new Image();
      test.onload = () => {
        img.src = url;
        img.removeAttribute("data-favicons");
      };
      test.onerror = tryNext;
      test.src = url;
    };
    tryNext();
  });
}

/** 高亮当前选中项并确保可见 */
function markActive() {
  const items = document.querySelectorAll("#matchItems .resultItem");
  items.forEach((el, i) => {
    el.classList.toggle("active", i === state.activeIndex);
  });
  const active = items[state.activeIndex];
  if (active) active.scrollIntoView({ block: "nearest" });
}

/** 详情视图的 ResizeObserver：内容变化（图片加载/脚本视图自适应）时重新调整窗口高度 */
let textViewResizeObserver = null;
/** 上一次应用的详情视图窗口高度，避免重复设置与震荡 */
let lastTextViewHeight = 0;

function detachTextViewResize() {
  if (textViewResizeObserver) {
    textViewResizeObserver.disconnect();
    textViewResizeObserver = null;
  }
  // 同时清除脚本视图可能遗留的内联高度
  const textView = document.getElementById("text_show");
  if (textView) {
    textView.style.flex = "";
    textView.style.height = "";
  }
  lastTextViewHeight = 0;
}

/**
 * 结束脚本视图会话（还原 registry.script.clearMSSE）：
 * 退出详情视图时把会话与 window.MS_SCRIPT_ENV 一并置空，
 * 避免下一个脚本项误用上一个会话的监听器/数据。
 */
function clearScriptSession() {
  if (scriptSession == null) return;
  const listeners = scriptSession.sendListener || [];
  listeners.length = 0;
  scriptSession = null;
  try {
    delete window.MS_SCRIPT_ENV;
  } catch (e) {
    window.MS_SCRIPT_ENV = undefined;
  }
}

function attachTextViewResize(textView) {
  detachTextViewResize();
  if (typeof ResizeObserver === "undefined" || !textView) return;
  // 观察内容元素而非 #text_show 本身，避免窗口高度变化自身触发循环
  const target =
    textView.querySelector("#ms-page-body") || textView.querySelector(".script-view");
  if (!target) return;
  let raf = 0;
  textViewResizeObserver = new ResizeObserver(() => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      fitTextViewHeight();
    });
  });
  textViewResizeObserver.observe(target);
}

/**
 * 详情视图（简述内容 / 附加内容 / 脚本视图）高度自适应：
 * 内容少则窗口收紧，内容多则展开到上限后内部滚动。
 */
function fitTextViewHeight() {
  const textView = document.getElementById("text_show");
  if (!textView || textView.style.display === "none") return;
  const app = document.getElementById("app");
  const box = document.getElementById("my_search_box");
  const view = document.getElementById("my_search_view");

  // 临时解除固定高度约束，测量内容真实高度（同一帧内还原，不产生闪烁）
  const prevAppHeight = app ? app.style.height : null;
  const prevBoxHeight = box ? box.style.height : null;
  const prevViewHeight = view ? view.style.height : null;
  const prevFlex = textView.style.flex;
  const prevHeight = textView.style.height;
  if (app) app.style.height = "auto";
  if (box) box.style.height = "auto";
  if (view) view.style.height = "auto";
  textView.style.flex = "0 0 auto";
  textView.style.height = "auto";
  const contentHeight = Math.ceil(
    textView.scrollHeight || textView.getBoundingClientRect().height || 0
  );
  if (app) app.style.height = prevAppHeight;
  if (box) box.style.height = prevBoxHeight;
  if (view) view.style.height = prevViewHeight;
  textView.style.flex = prevFlex;
  textView.style.height = prevHeight;

  const height = calcDetailWindowHeight(contentHeight, {
    boxHeight: BOX_HEIGHT,
    min: TEXT_VIEW_MIN_HEIGHT,
    max: TEXT_VIEW_MAX_HEIGHT,
    slack: TEXT_VIEW_HEIGHT_SLACK,
  });
  if (height === lastTextViewHeight) return;
  lastTextViewHeight = height;
  setWindowHeight(height);
}

// ========== 文本详情视图（还原 textView.show） ==========
function showTextView(title, desc, body) {
  const textView = document.getElementById("text_show");
  const matchResult = document.getElementById("matchResult");
  const keyword = state.rawKeyword.trim();
  textView.innerHTML =
    `<div class="text-head"><span class="text-label">标题</span>：${escapeHtml(title)}<br/>` +
    `<span class="text-label">${escapeHtml(desc)}</span></div>` +
    `<div id="ms-page-body" class="markdown-body">${md2html(body)}</div>`;
  matchResult.style.display = "none";
  textView.style.display = "block";
  // 挂载代码块复制按钮（还原原版 codeCopyMount）
  codeCopyMount("#text_show");
  state.mode = MODE.SHOW_ITEM_DETAIL;
  // 简述内容 / 附加内容展示中：失焦不隐藏窗口
  syncBlurHide();
  // 高度随内容自适应（简述/附加内容与结果区一致：内容多则展开，超出上限内部滚动）
  attachTextViewResize(textView);
  fitTextViewHeight();
  // 详情视图打开时立即刷窗口高度（不能等 50ms 防抖），让用户立刻看到完整内容
  flushWindowHeight();
  // 关键词定位（还原 scrollToText）
  if (keyword.length > 1) {
    setTimeout(() => scrollToText(keyword, document.getElementById("ms-page-body")), 60);
  }
}

/** 挂载代码块右上角复制按钮（还原原版油猴脚本） */
function codeCopyMount(elementSelector) {
  document.querySelectorAll(`${elementSelector} .markdown-body pre code`).forEach((codeBlock) => {
    // 跳过已挂载的
    const pre = codeBlock.parentElement;
    if (pre.querySelector(".copy-btn")) return;
    // 创建复制按钮
    const copyButton = document.createElement("button");
    copyButton.innerText = "复制";
    copyButton.className = "copy-btn";
    // 复制代码逻辑
    copyButton.addEventListener("click", () => {
      const text = codeBlock.innerText || codeBlock.textContent;
      navigator.clipboard.writeText(text).then(() => {
        copyButton.innerText = "已复制";
        setTimeout(() => (copyButton.innerText = "复制"), 2000);
      }).catch(err => {
        console.error("复制失败:", err);
      });
    });
    // <pre> 相对定位，按钮放右上角
    pre.style.position = "relative";
    pre.appendChild(copyButton);
  });
}

function hideTextView() {
  const textView = document.getElementById("text_show");
  const matchResult = document.getElementById("matchResult");
  detachTextViewResize();
  // 退出详情视图 = 脚本会话结束（还原 itemDetailBackAfterEventListener 的 clearMSSE）
  clearScriptSession();
  if (textView) textView.style.display = "none";
  if (matchResult && state.results.length > 0) {
    matchResult.style.display = "block";
    state.mode = MODE.SHOW_RESULT;
    // 由内容决定高度：结果列表已在 DOM 中，实测下发
    setWindowHeight(measureBoxHeight());
  } else {
    state.mode = MODE.WAIT_SEARCH;
    setWindowHeight(BOX_HEIGHT);
  }
  syncBlurHide();
}

/**
 * 复位到初始视图：清空输入/结果/详情，并把窗口收回到搜索框高度。
 *
 * 呼出（隐藏前非详情视图）与点击 URL 结果时调用。否则上一次搜索留下的高窗口
 * 会被原样再次显示，而结果区已不可见，于是搜索框下面就会空出一大片（用户反馈的问题）。
 *
 * 注意：呼出时若隐藏前是详情视图（简述文档/附加内容/脚本应用），不走本函数，
 * 而是原样还原视图（见 onMainWindowShown）——详情视图的隐藏只是收起窗口，
 * DOM 未销毁，再次呼出应与隐藏前一致（用户反馈的规则）。
 */
function resetToInitialView() {
  const input = document.getElementById("my_search_input");
  const matchItems = document.getElementById("matchItems");
  const matchResult = document.getElementById("matchResult");
  const textView = document.getElementById("text_show");

  // 作废进行中的异步搜索，避免旧结果回填到刚清空的界面上
  state.searchSeq++;
  state.results = [];
  state.activeIndex = -1;
  state.rawKeyword = "";
  state.mode = MODE.WAIT_SEARCH;

  detachTextViewResize();
  if (textView) {
    textView.style.display = "none";
    textView.innerHTML = "";
  }
  if (matchItems) matchItems.innerHTML = "";
  if (matchResult) {
    matchResult.style.display = "none";
    matchResult.classList.remove("show");
  }
  if (input) input.value = "";
  // 复位视图 = 脚本会话结束
  clearScriptSession();
  // 复位后回到「等待搜索」状态：失焦可以自动隐藏（每次呼出后同步一次）
  syncBlurHide();
  // 复位时不要无条件刷回默认提示：若订阅数据仍在加载中，
  // 必须继续显示「正在加载订阅数据...」，否则会表现为静默加载。
  restoreLoadingPlaceholderIfNeeded();
  setWindowHeight(BOX_HEIGHT);
}

/**
 * 呼出时的视图分支（用户规则）：
 * - 隐藏前是详情视图（简述文档 / 附加内容 / 脚本应用）→ 只单独隐藏过，
 *   再次呼出**原样还原**：视图 DOM 在窗口隐藏期间并未销毁、输入框未动，
 *   这里只需恢复窗口高度与失焦标志，视图本身保持与隐藏前一致。
 * - 其它状态（等待搜索 / 结果列表）→ 由调用方走 resetToInitialView() 复位。
 *
 * @returns {boolean} true=详情视图已原样还原（调用方跳过复位）
 */
function resumeDetailViewIfAny() {
  if (state.mode !== MODE.SHOW_ITEM_DETAIL) return false;
  const textView = document.getElementById("text_show");
  if (!textView || textView.style.display === "none") {
    // 视图已被其它路径清掉（如数据重载）→ 不算详情视图，交给复位
    return false;
  }
  // 原样还原：窗口高度贴回内容，失焦标志同步回「详情视图不隐藏」。
  // 隐藏时 Rust 侧已把窗口物理收回到 48px，因此这里必须强制重新下发高度：
  // 先清掉 fitTextViewHeight 的去重缓存（lastTextViewHeight 记录的是隐藏前
  // 的高度，直接调用会因「值未变」而跳过 setWindowHeight，窗口就停在 48px）。
  lastTextViewHeight = 0;
  if (scriptSession != null) attachTextViewResize(textView);
  fitTextViewHeight();
  flushWindowHeight();
  syncBlurHide();
  return true;
}

// ========== 脚本项（限制的脚本视图运行时） ==========
/**
 * 当前脚本视图会话（还原油猴版 registry.script.SESSION_MS_SCRIPT_ENV）。
 * 仅在脚本视图展示中存在，视图退出即置空（还原 clearMSSE）。
 */
let scriptSession = null;

/** 去掉数组里的重复项（还原 removeDuplicates，默认按 title + desc 比较） */
function removeDuplicates(objs, props = ["title", "desc"]) {
  if (!Array.isArray(objs) || objs.length === 0) return [];
  const keyOf = (obj) => props.map((p) => String(obj?.[p] ?? "\u0000")).join("\u0001");
  const seen = new Set();
  const result = [];
  for (const item of objs) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

/** 类 AI 匹配度搜索（还原 registry.script.MS_SCRIPT_ENV_TEMPLATE.matchSearch） */
async function matchSearchByOverlap(rawKeyword) {
  const keyword = String(rawKeyword ?? "").toUpperCase();
  if (!keyword.trim()) return [];
  const scopeOf = (item) => {
    const { tags, cleaned } = extractTagsAndCleanContent(String(item.title ?? ""));
    return {
      [cleaned.toUpperCase()]: 9,
      [`${item.desc ?? ""}${tags.join()}`.toUpperCase()]: 8,
      [`${linksToString(item.links)}${item.resource ?? ""}${item.vassal ?? ""}`
        .substring(0, 4096)
        .toUpperCase()]: 2,
    };
  };
  try {
    return overlapMatchingDegreeForObjectArray(keyword, [...state.engine.searchData], scopeOf, {
      onlyHasScope: true,
    });
  } catch (e) {
    console.warn("[我的搜索] 类AI匹配搜索异常:", e);
    return [];
  }
}

/**
 * 为脚本视图提供与油猴版兼容的 API（还原 registry.script.MS_SCRIPT_ENV_TEMPLATE）
 *
 * 官方订阅中的脚本应用（如「AI」「CKEditor-本地编辑器」）会直接依赖这些接口，
 * 缺失时脚本自身会判定「当前脚本缺少所需API支持」并进入降级分支。
 */
function createScriptEnv(session = {}) {
  return {
    event: { sendListener: session.sendListener || [] },
    cache: {
      get: (k) => storageGet("script:" + k, null),
      set: (k, v) => storageSet("script:" + k, v),
      remove: (k) => storageRemove("script:" + k),
    },
    getSearchDB: () => [...state.engine.searchData],
    getSelectedText: () => getSelectedText(),
    md2html: (raw) => md2html(raw),
    request: (type, url, opts = {}) => scriptRequest(type, url, opts),
    matchSearch: (kw) => matchSearchByOverlap(kw),
    data: {
      get: () => [...state.engine.searchData],
      matchSearch: () => [],
      distinct: (items) => removeDuplicates(items),
    },
  };
}

/**
 * 让用户手动选择页面文本（还原 getSelectedText）：
 * 提示后隐藏搜索窗，等用户在页面上划选定文字（mouseup）再返回。
 */
function getSelectedText(tis = "请选择页面文本") {
  return new Promise((resolve) => {
    const box = document.getElementById("my_search_box");
    const tipElement = document.createElement("p");
    tipElement.textContent = tis;
    Object.assign(tipElement.style, {
      position: "fixed",
      top: "0",
      left: "50%",
      transform: "translateX(-50%)",
      backgroundColor: "black",
      color: "white",
      padding: "10px 20px",
      fontSize: "16px",
      zIndex: "9999",
      borderRadius: "5px",
    });
    document.body.appendChild(tipElement);
    // 本桌面版没有「被搜索的网页」：隐藏搜索窗让用户去其它应用里选文本
    hideWindow();
    const onMouseUp = () => {
      const selected = String(window.getSelection?.() ?? "").trim();
      if (!selected) return;
      tipElement.remove();
      if (box) box.style.display = "";
      document.removeEventListener("mouseup", onMouseUp);
      resolve(selected);
    };
    document.addEventListener("mouseup", onMouseUp);
  });
}

/**
 * 脚本应用的 HTTP 请求（还原 request）：
 * 原版走 GM_xmlhttpRequest / $.ajax，桌面版统一走 Rust 代理（绕开 CORS）。
 * @returns {Promise<string>} 响应文本
 */
function scriptRequest(type = "GET", url, { query, body, header = {}, headers = {} } = {}) {
  const allHeaders = { ...header, ...headers };
  let target = String(url ?? "");
  if (query && Object.keys(query).length > 0) {
    const qs = new URLSearchParams(query).toString();
    target += (target.includes("?") ? "&" : "?") + qs;
  }
  if (!target) return Promise.reject(new Error("请求地址为空"));
  return httpRequest(target, {
    method: String(type || "GET").toUpperCase(),
    headers: allHeaders,
    body: body == null ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  }).then((result) => (typeof result === "string" ? result : JSON.stringify(result)));
}

/** 外部打开（带页面模拟器时降级为直接打开；还原 open().simulator()） */
function createLocalScriptOpen() {
  return createScriptOpen(openExternal);
}

/** 脚本视图对应的数据项（还原 showView 分支） */
function createScriptViewFor(item) {
  return createScriptView({
    /** 挂载实现：先开启 MSSE 会话 → 渲染 view:html/css/js → 通知脚本 */
    mount: (afterCallback) => mountScriptView(item, { afterCallback }),
  });
}

/**
 * 脚本视图容器选择器（脚本样式只作用于该容器内部，与 script-runtime 保持一致）
 */

/** 挂载脚本视图（view:html + view:css + view:js）到 #text_show */
function mountScriptView(item, { afterCallback = null } = {}) {
  const textView = document.getElementById("text_show");
  const matchResult = document.getElementById("matchResult");
  const ro = item.resourceObj || {};

  const wrap = document.createElement("div");
  wrap.className = "script-view";
  if (ro["view:html"]) wrap.innerHTML = ro["view:html"];
  if (scriptSession) scriptSession.mounted = true;

  textView.innerHTML = "";
  if (ro["view:css"]) {
    const style = document.createElement("style");
    // 作用域限定，避免脚本样式污染主界面
    style.textContent = scopeScriptCss(ro["view:css"]);
    textView.appendChild(style);
  }
  textView.appendChild(wrap);
  matchResult.style.display = "none";
  textView.style.display = "block";
  state.mode = MODE.SHOW_ITEM_DETAIL;
  // 脚本应用（脚本视图）展示中：失焦不隐藏窗口（由用户自己 Esc / 全局呼出快捷键收起）
  syncBlurHide();
  // 脚本视图高度自适应内容（与 showTextView 一致的 ResizeObserver 方案）：
  // 脚本视图内容由脚本自由控制（常见 height:100%），初始不设固定高度，
  // 等 view:js 执行完成后由 fitTextViewHeight 根据实际内容尺寸确定窗口高度。
  detachTextViewResize();

  // view:html 中的 <script src> 在 innerHTML 下不会执行，手动重建
  wrap.querySelectorAll("script").forEach((old) => {
    const s = document.createElement("script");
    if (old.src) s.src = old.src;
    else s.textContent = old.textContent;
    old.replaceWith(s);
  });

  const runViewJs = () => {
    if (!ro["view:js"]) return;
    const env = createScriptEnv(scriptSession || {});
    try {
      // 原版 openSessionForMSSE() 会把接口挂到页面 window 上（脚本会读 window.MS_SCRIPT_ENV）
      window.MS_SCRIPT_ENV = env;
      // 包一层 IIFE：同一页面多次执行时变量/函数互相隔离（与原版 textView.show 一致）
      const verdict = runViewScript(ro["view:js"], {
        cache: env.cache,
        $: makeLocalQuery(wrap),
        view: { mount() {} },
        registry: buildMiniRegistry(wrap),
        open: createLocalScriptOpen(),
        MS_SCRIPT_ENV: env,
        request: env.request,
        md2html: env.md2html,
        data: env.data,
        event: env.event,
      });
      if (!verdict.ok) throw verdict.error;
    } catch (e) {
      console.warn("[我的搜索] 脚本视图执行异常:", e);
      const tip = document.createElement("div");
      tip.className = "script-view-tip";
      tip.textContent = SCRIPT_VIEW_ERROR_TIP;
      wrap.prepend(tip);
    }
  };

  // 等 view:html 的外部 <script src>（如 CKEditor）先加载，再执行 view:js
  waitViewRenderingComplete(() => {
    runViewJs();
    // 通知脚本消息（见 tryRunScriptTextViewHandler）
    tryRunScriptTextViewHandler();
    if (afterCallback != null) afterCallback();
    // 脚本视图内容就绪后，窗口高度随内容自适应（贴合内容高度，不固定死）
    attachTextViewResize(textView);
    fitTextViewHeight();
    flushWindowHeight();
  });
}

/** 视图渲染完成回调（还原 waitViewRenderingComplete：setTimeout 30ms） */
function waitViewRenderingComplete(callback) {
  setTimeout(callback, 30);
}

/** 脚本视图内的局部 $ 选择器（还原注册表里的 $） */
function makeLocalQuery(wrap) {
  return function $(sel, all = false) {
    if (typeof sel !== "string") return sel;
    return all ? [...wrap.querySelectorAll(sel)] : wrap.querySelector(sel);
  };
}

/**
 * 向脚本视图推送「子搜索关键词」（还原 registry.script.tryRunTextViewHandler）：
 * 例如在脚本视图上输入 `xx : 关键词` 回车时，把子关键词交给脚本处理。
 * @returns {boolean} true=已交给脚本处理（不应再执行结果项点击）
 */
function tryRunScriptTextViewHandler() {
  if (state.mode !== MODE.SHOW_ITEM_DETAIL || scriptSession == null) return false;
  const session = scriptSession;
  if (session.item == null || session.mounted !== true) return false;
  const rawKeyword = document.getElementById("my_search_input")?.value ?? "";
  const parts = rawKeyword.split(SEARCH_BOUNDARY);
  if (parts.length < 2) return false;
  const msg = (parts[1] || "").trim();
  if (!msg) return false;
  const listeners = session.sendListener || [];
  if (listeners.length === 0) return false;
  listeners.forEach((listener) => {
    try {
      listener(msg);
    } catch (e) {
      console.warn("[我的搜索] 脚本消息监听异常:", e);
    }
  });
  // 清掉子搜索部分，只留父关键词
  const input = document.getElementById("my_search_input");
  if (input) input.value = parts[0];
  return true;
}

/**
 * 提供给脚本的部分 registry（部分脚本会访问 registry.searchData 等）
 * @param {HTMLElement} wrap 脚本视图容器（用于局部选择器）
 */
function buildMiniRegistry(wrap) {
  const query = wrap ? makeLocalQuery(wrap) : null;
  return {
    searchData: {
      getData: () => [...state.engine.searchData],
      triggerSearchHandle: (kw) => {
        const input = document.getElementById("my_search_input");
        if (input) input.value = kw == null ? input.value : kw;
        const next = input ? input.value : kw;
        hideTextView();
        doSearch(next);
      },
      specialKeyword: SPECIAL_KEYWORD,
      version: state.engine.searchData.length,
    },
    view: { element: wrap ? { textView: wrap } : {} },
    $: query,
  };
}

/** 脚本项处理（还原 showView 分支） */
function handleScriptItem(item) {
  const ro = item.resourceObj || {};
  const script = ro.script || "";
  // 特殊：快捷搜索脚本（触发 <new>/<history>/<highFrequency>）
  const specialMatch = script.match(/specialKeyword\.(\w+)/);
  if (specialMatch) {
    const key = SPECIAL_KEYWORD[specialMatch[1]];
    if (key) {
      const input = document.getElementById("my_search_input");
      if (input) input.value = key;
      doSearch(key);
      return;
    }
  }
  // 需挂载视图的脚本项
  if (hasScriptView(ro)) {
    runScriptItem(item);
    return;
  }
  // 其它脚本项：显示其脚本说明与附加内容
  showTextView(item.title, "脚本项", item.vassal || ro.script || "（脚本项）");
}

/**
 * 运行脚本项：执行其 script 段（还原 Function('obj', `(${jscript})(obj)`)({...})）
 */
function runScriptItem(item) {
  const ro = item.resourceObj || {};
  const script = ro.script;
  if (script == null) {
    // 与油猴版一致的兜底提示
    window.alert?.("- _ - 脚本异常！");
    return;
  }
  // 新的脚本视图会话（还原 openSessionForMSSE / clearMSSE）
  scriptSession = { item, sendListener: [], mounted: false };
  const env = createScriptEnv(scriptSession);
  window.MS_SCRIPT_ENV = env;
  const view = createScriptViewFor(item);
  const verdict = runScriptFunction(
    script,
    {
      cache: env.cache,
      $: null,
      view,
      registry: { script: { SESSION_MS_SCRIPT_ENV: env } },
      open: createLocalScriptOpen(),
      MS_SCRIPT_ENV: env,
      request: env.request,
      md2html: env.md2html,
      data: env.data,
      event: env.event,
    },
    { view }
  );
  if (!verdict.ok) {
    console.warn("[我的搜索] 脚本项执行失败:", verdict.error);
    const tip = document.createElement("div");
    tip.className = "script-view-tip";
    tip.textContent = SCRIPT_VIEW_ERROR_TIP;
    document.getElementById("text_show")?.prepend(tip);
  }
}

/** 将展示项解析回规范化数据项（临时克隆项如 <new> 也能定位到原数据） */
function resolveItem(item) {
  if (item == null) return null;
  if (item.index != null && state.engine.searchData[item.index]) {
    return state.engine.searchData[item.index];
  }
  return item;
}

// ========== 打开数据项（还原 li>a 点击） ==========
/**
 * 打开数据项（还原原版点击 `a.enter_main_link` 的行为）：
 * - 脚本项 → 执行脚本
 * - 非 URL（简述文本）→ 显示简述内容
 * - URL → 构造真实跳转地址并打开（[[...{keyword}...]] 用子搜索关键词填充）
 *
 * 注意：**附加内容（vassal）不在此处理**。原版只有点击 vassal 图标（或其对应的
 * `a.vassal` 元素）时才展示附加内容；主链接点击/回车始终走上述三个分支。
 * 桌面版早期把 `item.vassal != null` 当成主链接行为，导致「GITHUB : 你好」回车
 * 时打开了附加内容而不是填充跳转链接（用户反馈：回车没有反应）。
 */
function openItem(rawItem) {
  const item = resolveItem(rawItem);
  if (item == null) return;
  // 点击加分 + 记录历史（使用原数据项的标题/描述作为 key）
  scoreSelect(item);
  historySelect(item);

  // 脚本项（包含快捷搜索脚本）
  if (item.type === "script") {
    handleScriptItem(item);
    return;
  }
  // 非 URL（简述文本）→ 显示简述内容
  if (!isUrl(item.resource)) {
    showTextView(item.title, item.desc, item.resource);
    return;
  }
  // URL → 构造真实跳转地址并打开
  const realUrl = buildRealUrl(item.resource);
  if (realUrl) {
    // 还原原版：点击 URL 项时先 `viewVisibilityController(false)` 收起视图，
    // 再 `window.open(url)` 打开链接。因此“点结果 → 搜索框消失”是显式行为，
    // 而不是靠失焦隐藏（简述/附加内容/脚本项在那边都是 return，不收起）。
    resetToInitialView();
    hideWindow();
    openExternal(realUrl);
  }
}

/** 展示附加内容（还原原版点击 a.vassal / Ctrl+回车 的行为） */
function openVassal(rawItem) {
  const item = resolveItem(rawItem);
  if (item == null || item.vassal == null) return;
  scoreSelect(item);
  historySelect(item);
  showTextView(item.title, "主项的相关/附加内容", item.vassal);
}

/**
 * 处理 [[...]] 搜索模板（完全还原原版 li>a 点击中的 URL 构造）：
 * - 关键词按 `" : "` 分隔后取「子搜索」部分（即分隔符之后的内容），填入 `{keyword}`
 * - 原版是按 `":"` 切分并丢弃最后一段，再 join(":")，以兼容关键词里本身带冒号
 * - 带 {-keyword-} 且子搜索为空时，去掉整个模板直接跳基础地址
 */
function buildRealUrl(initUrl) {
  let url = String(initUrl || "");
  // 与油猴版一致：按 ":" 切分，丢掉最后一段（分隔符之后的部分），剩余 join 回去
  const keyword = String(state.rawKeyword).split(":").reverse();
  keyword.pop();
  const realKeyword = keyword.reverse().join(":").trim();
  url = url.replace(/\[\[([^\[\]]*)\]\]/g, (m, inner) =>
    inner.replace(/{keyword}/g, realKeyword).replace(/\[\[+|\]\]+/g, "")
  );
  // 子搜索为空 → 去掉搜索模板
  const parts = String(state.rawKeyword).split(SEARCH_BOUNDARY);
  if (parts.length < 2 || (parts[1] || "").trim() === "") {
    url = clearUrlSearchTemplate(initUrl);
  }
  // 订阅数据里的 resource 常带结尾换行/空白，直接传给系统打开会失败（原版 window.open 会自动忽略）
  return url.trim();
}

// ========== 搜索流程 ==========
// 占位提示的文案与时长统一由 util.js 提供（与油猴版 searchPlaceholder 对齐）
let placeholderRestoreTimer = null;

/**
 * 设置搜索框占位提示。
 *
 * 严格对齐油猴版 `searchPlaceholder(target, placeholder, duration)`：
 * 每次设置都**重置**恢复计时（原版先 `clearTimeout(this.tmpVar)` 再 `setTimeout`），
 * 计时结束后自动恢复为默认提示「我的搜索」。因此进度类提示不会一直卡住。
 *
 * autoRestoreMs <= 0 表示常驻（仅用于「数据为空」这类需要用户处理的异常提示）。
 */
function setPlaceholder(text, autoRestoreMs = 0) {
  const input = document.getElementById("my_search_input");
  if (!input || text == null) return;
  // 任何一次新的占位设置都作废上一次的恢复计划，避免旧定时器覆盖新提示
  if (placeholderRestoreTimer != null) {
    clearTimeout(placeholderRestoreTimer);
    placeholderRestoreTimer = null;
  }
  input.placeholder = text;
  if (autoRestoreMs > 0) {
    placeholderRestoreTimer = setTimeout(() => {
      placeholderRestoreTimer = null;
      resetPlaceholder();
    }, autoRestoreMs);
  }
}

/** 恢复搜索框默认占位提示（如“我的搜索”） */
function resetPlaceholder() {
  const input = document.getElementById("my_search_input");
  if (input) input.placeholder = PLACEHOLDER_DEFAULT_TEXT;
}

/**
 * 展示加载进度（还原原版 refreshNewData 中的 `searchPlaceholder("UPDATE")`）：
 * 文案为 `🔁 数据库更新到 N条`（N = 当前已加载到的条数），并在 duration 后自动恢复默认提示。
 * @param {number} count 当前已加载的数据条数
 */
function showLoadProgress(count) {
  setPlaceholder(placeholderProgressText(count), PLACEHOLDER_RESTORE_MS);
}

/**
 * 重新应用当前占位提示。
 *
 * 关键修复：呼出搜索框 / 复位视图会把搜索框清空，如果此时数据仍在加载，
 * 必须重新把「加载中」提示显示出来，否则「清理缓存 → 立即呼出搜索框」时
 * 看起来就像在静默加载（搜索框没有任何加载反馈）。
 *
 * 注意：这里会重置恢复计时（与原版 searchPlaceholder 一致），
 * 保证每次呼出都能看到加载/进度提示，且数据到位后依然会按时自动恢复默认提示。
 */
function restoreLoadingPlaceholderIfNeeded() {
  if (!state.loading) {
    resetPlaceholder();
    return;
  }
  // 数据块未就绪 → 准备中提示（duration=5000）；已有数据块 → 进度提示（duration=1200）
  // （与原版一致：engine.loadedCount=0 表示还没有任何内容源解析完成）
  const { text, restoreMs } = resolvePlaceholder({
    loading: true,
    preparing: state.engine.loadedCount === 0,
    count: state.engine.searchData.length,
    restoreMs: PLACEHOLDER_RESTORE_MS,
    prepareMs: PLACEHOLDER_PREPARE_MS,
  });
  setPlaceholder(text, restoreMs);
}

async function doSearch(rawKeyword) {
  state.rawKeyword = rawKeyword;
  const seq = ++state.searchSeq;

  // 真正的空关键词 → 清空结果。
  // 注意：边界符本身（" : "，空内容按 Tab 后的值）不能在这里短路——
  // 原版会进入 PRO 模式路由并把关键词转发为 "问AI : "（searchableSpecialRouting["^\\s*$"]），
  // 需要交给引擎触发转发。
  if (rawKeyword.trim() === "") {
    state.results = [];
    state.activeIndex = -1;
    renderResults();
    return [];
  }

  // 搜索在途（还原原版 searchEven.isSearching）：
  // 原版在搜索进行中也会跳过「失焦隐藏」，避免刚输入就有结果时被误收起
  state.searching = true;
  syncBlurHide();
  let results;
  try {
    results = await state.engine.search(rawKeyword);
  } catch (e) {
    console.error("[我的搜索] 搜索失败:", e);
    results = [];
  } finally {
    state.searching = false;
    syncBlurHide();
  }
  // 竞态：已有更新的搜索
  if (seq !== state.searchSeq) return state.results;

  state.results = results || [];
  state.activeIndex = -1;
  renderResults();
  return state.results;
}

// 防抖搜索（300ms，与油猴版一致）。回车时会 flush 立即取结果，
// 避免「输入就回车」因防抖未触发而找不到第一项。
const debouncedSearch = debounce((v) => doSearch(v), 300);

function onInput(value) {
  // 进入普通搜索前先退出详情视图（恢复结果区与窗口高度）
  if (state.mode === MODE.SHOW_ITEM_DETAIL) {
    hideTextView();
  }
  // `:debug` 指令模式在输入框内容变化时生效，需要重新同步失焦隐藏状态
  syncBlurHide();
  debouncedSearch(value);
}

/**
 * 回车时取得当前应当作用的结果项（还原原版 `pos==0 → pos=1` 语义）。
 * - 防抖搜索还未触发（“输入就回车”）→ 先 flush 立即搜索
 * - 无上下选择 → 默认第一项
 * @returns {Promise<any|null>} 结果项包装 {item, level}
 */
async function resolveEnterTarget() {
  const input = document.getElementById("my_search_input");
  const value = input ? input.value : state.rawKeyword;
  // 输入内容与当前结果不同步（防抖未触发 / 结果过期）→ 立即搜索一次
  if (debouncedSearch.pending() || value !== state.rawKeyword) {
    debouncedSearch.cancel();
    await doSearch(value);
  }
  const index = state.activeIndex === -1 ? 0 : state.activeIndex;
  return state.results[index] || null;
}

// ========== 订阅加载 ==========
/** 订阅以原始 tis 文本保存（与油猴版 subscribeKey 一致），便于与配置窗口互通 */
function subscribeTextToItems(text) {
  return parseAllDesignatedSingTags(String(text || ""), "tis").map((tis) => ({
    url: tis.tabValue,
    title: tis.title || tis.tabValue,
    describe: tis.describe || "",
    fetchFun: tis.fetchFun,
    defaultTag: tis["default-tag"],
  }));
}

async function loadSubscribes() {
  let text = storageGet(SUBSCRIBES_STORAGE_KEY, null);
  // 兼容旧版：结构化数组 → tis 原文
  if (Array.isArray(text)) {
    text = subscribeItemsToText(text);
    storageSet(SUBSCRIBES_STORAGE_KEY, text);
  }
  if (typeof text !== "string" || text.trim() === "") {
    try {
      text = await getDefaultSubscribeText();
    } catch (e) {
      text = "";
    }
    storageSet(SUBSCRIBES_STORAGE_KEY, text);
  }
  state.subscribeText = text;
  state.subscribes = subscribeTextToItems(text);
}

async function loadAllData(force = false, silent = false) {
  const engine = state.engine;
  // 缓存指纹需要订阅列表：订阅变化会让缓存失效
  engine.subscribes = state.subscribes;
  // 缓存有效（未过期 且 订阅未变）→ 直接复用本地缓存，不发起网络加载
  const fromCache = !force && engine.isCacheValid();
  if (!fromCache) {
    state.loading = true;
    if (silent) {
      // 静默后台刷新：不更新界面占位提示和进度回调
      engine.onProgress = null;
    } else {
      // 进度回调：每解析完一个内容源都会调用（还原原版 refreshNewData 的 searchPlaceholder("UPDATE")）
      // 同时把已加载到的数据重新搜一遍，让用户输入后立即能搜到已到位的部分
      // （还原原版数据块到位后的 registry.searchData.triggerSearchHandle()）
      engine.onProgress = (count) => {
        // 关键：加载中即使搜索框被清空（呼出复位），也要继续显示进度
        if (state.loading) showLoadProgress(count);
        const input = document.getElementById("my_search_input");
        if (input && input.value.trim()) doSearch(input.value);
      };
      // 准备中提示：对应原版 dataInitFun 的 `searchPlaceholder("UPDATE","🔁 数据准备更新中...",5000)`
      setPlaceholder(PLACEHOLDER_PREPARING_TEXT, PLACEHOLDER_PREPARE_MS);
    }
  } else {
    engine.onProgress = null;
  }
  try {
    // 引擎内部再来一次"缓存有效判断"：用缓存则立即挂载，否则全量重新加载
    await engine.initData(state.subscribes, { force });
  } catch (e) {
    console.error("[我的搜索] 加载订阅失败:", e);
  }
  state.loading = false;
  engine.onProgress = null;
  state.unfollowSnapshot = currentUnfollowSnapshot();
  if (!silent) {
    // 非静默模式才更新界面占位提示
    updatePlaceholder(fromCache);
  }
  // 若已有输入，重新搜索一次（还原原版数据更新后的 triggerSearchHandle）
  // 静默刷新后同样需要将新数据反映到搜索结果中
  const input = document.getElementById("my_search_input");
  if (input && input.value.trim()) doSearch(input.value);

  // 每次数据加载完成后调度后台缓存自动刷新（仅非静默模式，
  // 静默模式自身在 finally 中调度，避免重复）
  if (!silent) afterDataLoaded();
}

/** 当前「不关注标签」列表快照（用于判断配置窗口中标签是否变化） */
function currentUnfollowSnapshot() {
  const stored = storageGet(UNFOLLOW_KEY, null);
  return JSON.stringify(Array.isArray(stored) ? stored : DEFAULT_UNFOLLOW);
}

function updatePlaceholder(fromCache = false) {
  const count = state.engine.searchData.length;
  const failed = state.engine.failedUrls.length;
  const { text, restoreMs } = resolvePlaceholder({
    loading: false,
    count,
    failed,
    fromCache,
    restoreMs: PLACEHOLDER_RESTORE_MS,
  });
  setPlaceholder(text, restoreMs);
}
// ========== 键盘交互 ==========
function bindEvents() {
  const input = document.getElementById("my_search_input");
  const matchItems = document.getElementById("matchItems");

  input.addEventListener("input", (e) => onInput(e.target.value));

  input.addEventListener("keyup", (e) => {
    const keyword = e.target.value.trim();
    if (keyword) state.rawKeyword = e.target.value;
    // "::" / "：：" → 子搜索分隔符
    if (keyword.endsWith("::") || keyword.endsWith("：：")) {
      let kw = keyword
        .replace(/::|：：/, SEARCH_BOUNDARY)
        .replace(/\s+/, " ");
      kw = kw.replace(/((\s{1,2}:)+ )/, SEARCH_BOUNDARY);
      e.target.value = kw.toUpperCase();
      onInput(e.target.value);
    }
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveActive(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveActive(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      // 脚本视图展示中：回车 = 把子搜索关键词推送给脚本应用
      // （还原 registry.script.tryRunTextViewHandler；推成功就不执行结果项点击）
      if (tryRunScriptTextViewHandler()) return;
      // 无上下选择（activeIndex === -1）时，回车默认作用于第一项；
      // 防抖搜索尚未触发（“输入就回车”）时先立即搜索再取第一项。
      // （还原原版：`pos == 0` 时置 `pos = 1`，即“搜索后回车相当于点击第一个”）
      resolveEnterTarget().then((result) => {
        if (!result) return;
        if (e.ctrlKey) {
          // Ctrl+回车 = 点击“附加内容”（还原原版 activeItem.find(".vassal")[0]?.click()）
          openVassal(result.item);
        } else {
          // 回车 = 点击主链接（URL 会按子搜索关键词填充 [[...]] 模板后打开）
          openItem(result.item);
        }
      });
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (state.mode === MODE.SHOW_ITEM_DETAIL) {
        hideTextView();
      } else {
        hideWindow();
      }
    } else if (e.key === "Tab") {
      e.preventDefault();
      if (!e.shiftKey) {
        if (!input.value.includes(SEARCH_BOUNDARY)) {
          input.value = input.value.toUpperCase() + SEARCH_BOUNDARY;
          onInput(input.value);
        }
      } else {
        if (input.value.includes(SEARCH_BOUNDARY)) {
          input.value = input.value.split(SEARCH_BOUNDARY)[0].toLowerCase();
          onInput(input.value);
        }
      }
    } else if (e.key === "Backspace") {
      if (input.value.endsWith(SEARCH_BOUNDARY)) {
        e.preventDefault();
        return;
      }
      if (/^\s*[\[<][^\[\]<>]*[\]>]\s*$/.test(input.value)) {
        input.value = "";
        onInput("");
        e.preventDefault();
      }
    }
  });

  // 结果点击（事件委托）
  matchItems.addEventListener("click", (e) => {
    // 快捷链接：按脚本行为 → 新窗口打开目标地址（脚本是原生 <a target="_blank">）
    const linkChip = e.target.closest(".related-links a");
    if (linkChip) {
      e.stopPropagation();
      const url = linkChip.getAttribute("href");
      e.preventDefault();
      if (url) openExternal(url);
      return;
    }
    const vassal = e.target.closest("[data-vassal]");
    if (vassal) {
      e.preventDefault();
      e.stopPropagation();
      const i = parseInt(vassal.dataset.vassal);
      const result = state.results[i];
      if (result) openVassal(result.item);
      return;
    }
    const link = e.target.closest("a[data-open]");
    if (link) {
      e.preventDefault();
      e.stopPropagation();
      const i = parseInt(link.dataset.open);
      const result = state.results[i];
      if (result) openItem(result.item);
    }
  });

  // logo 按钮：左键 = 搜索 [系统项]（还原 onClickLogo）；右键 = 订阅管理
  const logoButton = document.getElementById("logoButton");
  logoButton.addEventListener("click", () => {
    const keyword = "[系统项]";
    const next = input.value === keyword ? "" : keyword;
    input.value = next;
    onInput(next);
    input.focus();
  });
  logoButton.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openConfigWindow();
  });

  // Ctrl+, 打开订阅管理
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key === ",") {
      e.preventDefault();
      openConfigWindow();
    }
  });

  // 再次从配置窗口回到主窗口时，订阅 / 关注标签可能变化，或缓存已被清理
  // → 丢弃缓存重新加载（与油猴版「保存后 clearCache」一致）
  // @param {boolean} fromShow 是否由「呼出搜索框」触发（此时窗口正在显示，
  //        跳过 visibilityState 检查，保证加载状态立即生效）
  const reloadIfSubscribesChanged = (fromShow = false) => {
    if (!fromShow && document.visibilityState === "hidden") return;
    // 已有加载在途：不重复发起（呼出时可能紧跟在一次焦点触发之后）
    if (state.loading) return;
    const text = storageGet(SUBSCRIBES_STORAGE_KEY, "");
    const subscribesChanged =
      typeof text === "string" && text !== state.subscribeText;
    const unfollowChanged = currentUnfollowSnapshot() !== state.unfollowSnapshot;
    // 主窗口已挂载数据，但缓存已失效（例如在订阅管理里点了「清理缓存」）
    const cacheCleared =
      state.engine.searchData.length > 0 && !state.engine.isCacheValid();
    if (subscribesChanged) {
      state.subscribeText = text;
      state.subscribes = subscribeTextToItems(text);
    }
    const needReload = subscribesChanged || unfollowChanged || cacheCleared;
    if (!needReload) return;
    // 保护：3 秒内最多因「缓存被清理」重载一次，避免写缓存失败时反复拉取
    const now = Date.now();
    if (cacheCleared && now - state.cacheReloadGuardAt < 3000) return;
    state.cacheReloadGuardAt = now;
    loadAllData(true);
  };
  window.addEventListener("focus", () => reloadIfSubscribesChanged(false));
  document.addEventListener("visibilitychange", () => reloadIfSubscribesChanged(false));

  // 呼出（Rust 端显示窗口）按隐藏前的视图状态分两种（用户规则）：
  //
  // 1. 详情视图（简述文档 / 附加内容 / 脚本应用）展示中隐藏 → 只单独隐藏，
  //    再次呼出时**原样还原**：视图 DOM 未销毁、输入框不动，恢复窗口高度与失焦标志。
  // 2. 其它状态（等待搜索 / 结果列表）→ 复位到初始视图：清空输入/结果/详情，
  //    窗口收回到搜索框高度（否则上次的高窗口残留、下方空一大片）。
  onMainWindowShown(() => {
    if (!resumeDetailViewIfAny()) {
      resetToInitialView();
    }
    // 复位后再检查一次：若缓存已被清理（订阅管理里点了「清理缓存」），
    // 立即进入加载状态，让用户一呼出就能看到「正在加载订阅数据...」。
    // 先复位（清空旧视图）再加载，提示不会被复位覆盖，也不会有静默加载的观感。
    // （原样还原路径同样要检查：数据重载可能使详情内容过期，但视图仍在；
    //   reloadIfSubscribesChanged 内部只重载数据，不会销毁当前视图。）
    reloadIfSubscribesChanged(true);
    // 复位后回到「等待搜索」：强制同步给 Rust（呼出时 Rust 侧已把标志复位为 true，
    // 这里不能因「值未变」而跳过，否则两边可能不一致）。
    syncBlurHide(true);
    document.getElementById("my_search_input")?.focus();
  });

  // 托盘菜单「清理缓存」（Rust 端转发事件；托盘没有 WebView，无法直接操作 localStorage）：
  // 与设置窗口「清理可重建缓存」一致 —— 删除订阅数据缓存 + 订阅指纹，
  // 这两项都可由订阅重新构建。主窗口已挂载数据时立即丢弃旧数据并重新加载；
  // 否则下次呼出时 reloadIfSubscribesChanged 检测到缓存失效会自动重载。
  onClearCache(() => {
    storageRemove("SEARCH_DATA_KEY");
    storageRemove("SUBSCRIBE_FINGERPRINT_CACHE_KEY");
    console.log("[我的搜索] 已通过托盘清理可重建的数据缓存");
    if (state.engine.searchData.length > 0 && !state.loading) {
      loadAllData(true);
    }
  });
}

/** 收起窗口到仅显示搜索框的高度（无内容时的基准尺寸） */
function resetWindowToBoxHeight() {
  setWindowHeight(BOX_HEIGHT);
}

function moveActive(delta) {
  const total = Math.min(state.results.length, SHOW_SIZE);
  if (total <= 0) return;
  if (state.activeIndex === -1) {
    // 首次通过键盘选择：向下选第一个，向上选最后一个
    state.activeIndex = delta > 0 ? 0 : total - 1;
  } else {
    state.activeIndex = (state.activeIndex + delta + total) % total;
  }
  markActive();
}

// ========== 窗口焦点：自动聚焦输入框 ==========
async function setupFocusBehavior() {
  const input = document.getElementById("my_search_input");
  if (isTauri) {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      win.onFocusChanged(({ payload: focused }) => {
        if (focused) setTimeout(() => input.focus(), 30);
      });
      if (await win.isVisible()) input.focus();
    } catch (e) {
      /* ignore */
    }
  } else {
    input.focus();
  }
}

// ========== 缓存后台自动刷新 ==========
/**
 * 「缓存过期前提前刷新」的阈值：缓存剩余时间少于该值时触发后台静默刷新（默认 1 小时）。
 * 设为 0 表示仅在缓存已过期时才刷新（下次呼出时触发，与旧行为一致）。
 */
const CACHE_REFRESH_AHEAD_MS = 60 * 60 * 1000; // 1 小时

/** 后台检查缓存状态的间隔（默认 30 分钟检查一次） */
const CACHE_REFRESH_CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 分钟

/**
 * 检查并启动缓存后台自动刷新调度。
 *
 * 逻辑：
 * 1. 若缓存已过期（expire <= now）→ 立即执行一次静默刷新
 * 2. 若缓存即将过期（剩余时间 < CACHE_REFRESH_AHEAD_MS）→ 立即执行一次静默刷新
 * 3. 否则按 CACHE_REFRESH_CHECK_INTERVAL_MS 周期检查，
 *    一旦 expire - now <= CACHE_REFRESH_AHEAD_MS 就触发刷新
 *
 * 刷新完成（或失败）后自动重置定时器，进入下一轮等待周期。
 * 这样用户每次呼出搜索框时，看到的都是新鲜数据，不感知后台加载。
 */
function scheduleCacheRefresh() {
  // 清理已有定时器
  if (state.refreshTimer != null) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
  }

  const expire = state.engine.getCacheExpireMs();
  const now = Date.now();
  const remain = expire > 0 ? expire - now : 0;

  // 无缓存 或 缓存尚早才需要定时检查
  if (expire <= 0 || remain > CACHE_REFRESH_AHEAD_MS) {
    // 有缓存但还很新鲜 → 等到剩余时间进入阈值再刷
    const waitMs = expire > 0 && remain > CACHE_REFRESH_AHEAD_MS
      ? Math.min(remain - CACHE_REFRESH_AHEAD_MS, CACHE_REFRESH_CHECK_INTERVAL_MS)
      : CACHE_REFRESH_CHECK_INTERVAL_MS;
    state.refreshTimer = setTimeout(async () => {
      // 定时检查到了，无论什么状态都执行一次刷新判断
      await triggerSilentRefresh();
    }, waitMs);
    return;
  }

  // 缓存已过期或即将过期 → 立即静默刷新
  console.log("[我的搜索] 缓存即将过期，触发后台静默刷新");
  triggerSilentRefresh();
}

/**
 * 执行一次静默后台刷新（不更新界面占位提示，不干扰用户操作）。
 * 刷新完成后自动重新调度下一轮检查。
 */
async function triggerSilentRefresh() {
  // 已有加载在途 或 正在静默刷新中 → 跳过
  if (state.loading || state.silentRefresh) return;
  // 无订阅 → 无法加载
  if (!state.subscribes || state.subscribes.length === 0) return;
  state.silentRefresh = true;
  try {
    await loadAllData(true, true);
    console.log("[我的搜索] 后台静默刷新完成");
  } catch (e) {
    console.warn("[我的搜索] 后台静默刷新失败:", e);
  } finally {
    state.silentRefresh = false;
    // 无论如何，重新调度下一轮检查
    scheduleCacheRefresh();
  }
}

/** 将静默刷新集成到 loadAllData 的正常流程之后 */
function afterDataLoaded() {
  // 每次数据加载完成（包括首次启动和手动刷新）后调度缓存自动刷新
  scheduleCacheRefresh();
}

// ========== 启动 ==========
async function bootstrap() {
  renderApp();
  // 启动时把窗口收起到搜索框高度：
  // WebView 重新加载（开发期 Vite 整页 reload，或任何重建页面的情形）后，
  // 窗口仍保持上一次展开后的高度，而此时没有任何结果可渲染，
  // 搜索框下方就会露出一大片空白。先复位高度，再按内容展开。
  resetWindowToBoxHeight();
  bindEvents();
  await setupFocusBehavior();
  await loadSubscribes();
  // loadAllData 内部会在加载完成后自动调用 afterDataLoaded() 启动后台刷新调度
  await loadAllData();
}

bootstrap();
