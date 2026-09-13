/**
 * 通用工具库 - 我的搜索桌面版
 * 移植自油猴脚本"我的搜索"（v7.9.5）
 */

/** HTML 转义 */
export function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 属性值转义（用于 data-* 等） */
export function escapeAttr(str) {
  return escapeHtml(str).replace(/`/g, "&#96;");
}

/** 空占位 */
export const EMPTY_DESC = "--无描述--";

/** 判断是否为 http(s) url（还原油猴版 isHttpUrl） */
export function isHttpUrl(url = "") {
  if (url == null || typeof url !== "string") return false;
  const s = url.trim().split("#")[0];
  // 不能存在换行符
  if (s.indexOf("\n") !== -1) return false;
  return /^https?:\/\//.test(s);
}

/**
 * 判断 resource 是否只是一个 URL（还原油猴版 isUrl）
 * 用于区分“跳转链接”与“简述文本”
 */
export function isUrl(resource) {
  if (resource == null || typeof resource !== "string") return false;
  const s = resource.trim().split("#")[0];
  if (s.indexOf("\n") !== -1) return false;
  // 被空白符切割后只能有一个元素
  if (s.split(/\s+/).length !== 1) return false;
  return isHttpUrl(s);
}

/**
 * 解析 URL 为 { protocol, domain, path, params, rootUrl, rawUrl }
 * 还原油猴版 parseUrl
 */
export function parseUrl(url = "") {
  const regex = /(https?:|)\/\/([^\/]*|[^\/]*)(\/[^\s\?]*|)(\??[^\s]*|)/;
  const matches = regex.exec(url);
  if (!matches) return {};
  const protocol = matches[1];
  const domain = matches[2];
  const path = matches[3];
  const params = matches[4];
  return {
    protocol,
    domain,
    path,
    params,
    rootUrl: protocol + "//" + domain,
    rawUrl: url,
  };
}

/** 去掉可搜索 URL 模板标记 [[...]]（还原 clearUrlSearchTemplate） */
export function clearUrlSearchTemplate(url) {
  return String(url ?? "").replace(/\[\[[^\[\]]*\]\]/gm, "");
}

/**
 * 防抖（还原 debounce）。
 *
 * 额外提供 flush()/cancel()：回车需要在防抖未触发时立即拿到结果，
 * 与油猴版「搜索中回车忽略、搜索后回车选第一项」的行为对齐。
 */
export function debounce(fun, wait) {
  let timer = null;
  let pendingArgs = null;

  function debouncedFn(...args) {
    pendingArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const a = pendingArgs;
      pendingArgs = null;
      fun.apply(this, a);
    }, wait);
  }

  /** 立即执行待处理的调用（若有） */
  debouncedFn.flush = function () {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const a = pendingArgs;
    pendingArgs = null;
    if (a != null) fun.apply(this, a);
  };

  /** 丢弃待处理的调用 */
  debouncedFn.cancel = function () {
    if (timer) clearTimeout(timer);
    timer = null;
    pendingArgs = null;
  };

  /** 是否存在待处理的调用 */
  debouncedFn.pending = function () {
    return timer != null;
  };

  return debouncedFn;
}

// ========== 本地存储（替代油猴 GM_getValue/cache） ==========
const STORAGE_PREFIX = "my-search-desktop:";

/** 无 localStorage 环境（如 Node 测试）时的内存兜底实现 */
const memoryStore = new Map();
const hasLocalStorage = (() => {
  try {
    return typeof localStorage !== "undefined" && localStorage !== null;
  } catch (e) {
    return false;
  }
})();

export function storageGet(key, defaultValue = null) {
  const fullKey = STORAGE_PREFIX + key;
  try {
    if (!hasLocalStorage) {
      return memoryStore.has(fullKey) ? memoryStore.get(fullKey) : defaultValue;
    }
    const raw = localStorage.getItem(fullKey);
    if (raw == null) return defaultValue;
    return JSON.parse(raw);
  } catch (e) {
    console.warn("[我的搜索] 读取缓存失败:", key, e);
    return defaultValue;
  }
}

export function storageSet(key, value) {
  const fullKey = STORAGE_PREFIX + key;
  try {
    if (!hasLocalStorage) {
      memoryStore.set(fullKey, value);
      return;
    }
    localStorage.setItem(fullKey, JSON.stringify(value));
  } catch (e) {
    console.warn("[我的搜索] 写入缓存失败:", key, e);
  }
}

export function storageRemove(key) {
  const fullKey = STORAGE_PREFIX + key;
  try {
    if (!hasLocalStorage) {
      memoryStore.delete(fullKey);
      return;
    }
    localStorage.removeItem(fullKey);
  } catch (e) {
    /* ignore */
  }
}

// ========== 简易 Markdown 渲染（替代 showdown） ==========
function inlineMd(text) {
  let s = text;
  // 行内代码 `code`
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (m, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  // 图片 ![alt](url)
  s = s.replace(
    /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g,
    (m, alt, url) => `<img src="${url}" alt="${alt}" />`
  );
  // 链接 [text](url "title")
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)(?:\s+"([^"]*)")?\)/g,
    (m, t, url, title) =>
      `<a href="${url}" target="_blank"${title ? ` title="${title}"` : ""}>${t}</a>`
  );
  // 其它协议链接（如 clash://）
  s = s.replace(
    /\[([^\]]+)\]\(([a-zA-Z][\w+.-]*:\/\/[^\s)]+)\)/g,
    (m, t, url) => `<a href="${url}" target="_blank">${t}</a>`
  );
  // 裸链接
  s = s.replace(
    /(^|[\s(])(https?:\/\/[^\s<)]+)/g,
    (m, pre, url) => `${pre}<a href="${url}" target="_blank">${url}</a>`
  );
  // 粗体 / 斜体
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  // 恢复行内代码
  // 注：inlineMd 仅被 md2html 内部调用，所有调用方都已提前 escapeHtml，
  // 因此这里不再重复转义，否则会导致 &quot; → &amp;quot; 这类双重编码。
  s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => `<code>${codes[Number(i)]}</code>`);
  return s;
}

/**
 * 极简 Markdown → HTML
 * 支持：围栏代码块、标题、引用、无序/有序列表、分割线、段落、链接、粗体/斜体、行内代码
 */
export function md2html(rawText) {
  const text = String(rawText ?? "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const out = [];
  let i = 0;
  let inCode = false;
  let codeLang = "";
  let codeBuf = [];
  let listType = null; // "ul" | "ol"
  let paraBuf = [];

  const flushPara = () => {
    if (paraBuf.length === 0) return;
    out.push(`<p>${inlineMd(escapeHtml(paraBuf.join(" ")))}</p>`);
    paraBuf = [];
  };
  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  for (i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 围栏代码块
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      if (!inCode) {
        flushPara();
        closeList();
        inCode = true;
        codeLang = (fence[1] || "").trim();
        codeBuf = [];
      } else {
        inCode = false;
        const cls = codeLang ? ` class="language-${escapeHtml(codeLang)}"` : "";
        out.push(`<pre><code${cls}>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }

    const trimmed = line.trim();

    if (trimmed === "") {
      flushPara();
      closeList();
      continue;
    }

    // 分割线
    if (/^-{3,}$/.test(trimmed)) {
      flushPara();
      closeList();
      out.push("<hr />");
      continue;
    }

    // 标题
    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara();
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inlineMd(escapeHtml(heading[2]))}</h${level}>`);
      continue;
    }

    // 引用
    if (/^>\s?/.test(trimmed)) {
      flushPara();
      closeList();
      const quoteLines = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      i--;
      out.push(`<blockquote>${md2html(quoteLines.join("\n"))}</blockquote>`);
      continue;
    }

    // 无序列表
    const ulMatch = trimmed.match(/^[-*+]\s+(.*)$/);
    if (ulMatch) {
      flushPara();
      if (listType !== "ul") {
        closeList();
        out.push("<ul>");
        listType = "ul";
      }
      out.push(`<li>${inlineMd(escapeHtml(ulMatch[1]))}</li>`);
      continue;
    }

    // 有序列表
    const olMatch = trimmed.match(/^\d+[.)]\s+(.*)$/);
    if (olMatch) {
      flushPara();
      if (listType !== "ol") {
        closeList();
        out.push("<ol>");
        listType = "ol";
      }
      out.push(`<li>${inlineMd(escapeHtml(olMatch[1]))}</li>`);
      continue;
    }

    closeList();
    paraBuf.push(trimmed);
  }

  flushPara();
  closeList();
  if (inCode) {
    // 未闭合的代码块
    const cls = codeLang ? ` class="language-${escapeHtml(codeLang)}"` : "";
    out.push(`<pre><code${cls}>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
  }
  return out.join("\n");
}

/**
 * 将 CSS 规则限制到指定作用域选择器下（近似原版 cssFillPrefix）
 * 避免数据源中的 view:css（可能含 `*{}`、`body{}`）污染整个应用界面。
 *
 * 正确处理嵌套结构：
 * - `@media` / `@supports` 这类会随窗口变化的 at-rule：进入其内部递归作用域选择器
 * - `@keyframes`（以及内部的 `to` / `from` / `50%` 关键帧）：不能加作用域，原样保留
 * - `*` / `html` / `body` / `:root`：映射到作用域容器自身（不能污染主界面）
 *
 * 旧实现用 `split("}")` 切块，遇到 `@keyframes { to { ... } }` 这种嵌套时
 * 会把后面的规则当成 at-rule 内部内容原样输出（选择器丢失作用域），
 * 同时提前多出一个 `}`——整个后续 CSS 都会失效。
 *
 * @param {string} css
 * @param {string} prefix 例如 "#text_show .script-view"
 */
export function scopeCss(css, prefix) {
  const clean = String(css ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
  return scopeCssBlocks(clean, prefix).join("\n");
}

/** 将选择器列表作用域化（根选择器映射为容器自身） */
function scopeSelectorList(sel, prefix) {
  return sel
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (/^(\*|html|body|:root)$/i.test(s) ? prefix : `${prefix} ${s}`))
    .join(", ");
}

/**
 * 解析 CSS 为顶层块并逐个作用域化（保留原样换行，输出与原文字节接近）
 * @param {string} css
 * @param {string} prefix
 * @returns {string[]}
 */
function scopeCssBlocks(css, prefix) {
  const out = [];
  let plain = "";
  let i = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === "{") {
      // plain 中累积的就是当前块的选择器 / at-rule 头部
      const header = plain.trim();
      plain = "";
      const body = readBlock(css, i + 1);
      i = body.end + 1; // 跳到本块的闭合花括号之后
      const inner = body.text;
      if (!header) continue;
      if (header.startsWith("@")) {
        const at = header.toLowerCase();
        if (at.startsWith("@keyframes") || at.startsWith("@-webkit-keyframes")) {
          // 关键帧内部（from/to/百分比）不能加作用域，原样保留
          out.push(`${header} {${inner}}`);
        } else {
          // @media / @supports 等：递归处理内部规则
          const nested = scopeCssBlocks(inner, prefix);
          out.push(`${header} {\n${nested.join("\n")}\n}`);
        }
      } else {
        out.push(`${scopeSelectorList(header, prefix)} {${inner}}`);
      }
      continue;
    }
    // 顶层多余的 `}`（脏 CSS）直接跳过，不影响后续规则
    if (ch !== "}") plain += ch;
    i++;
  }
  if (plain.trim()) out.push(plain.trim());
  return out;
}

/** 从 pos 开始读取 `{...}` 之间的内容（配对花括号，忽略字符串与注释） */
function readBlock(css, pos) {
  let depth = 1;
  let i = pos;
  let quote = null;
  let text = "";
  for (; i < css.length; i++) {
    const ch = css[i];
    if (quote) {
      text += ch;
      if (ch === "\\") {
        text += css[i + 1] ?? "";
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      text += ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) break;
    }
    text += ch;
  }
  return { text, end: i };
}

/**
 * 在容器中高亮并滚动到指定文本（还原 scrollToText 的核心能力）
 * @param {string} text 要高亮的文本
 * @param {HTMLElement} container
 */
export function scrollToText(text, container) {
  if (!text || !container) return;
  const keyword = String(text).trim();
  if (!keyword) return;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const tag = node.parentElement?.tagName;
      if (tag === "SCRIPT" || tag === "STYLE") return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node;
  let target = null;
  const nodes = [];
  while ((node = walker.nextNode())) nodes.push(node);
  for (const textNode of nodes) {
    const idx = textNode.nodeValue.toUpperCase().indexOf(keyword.toUpperCase());
    if (idx >= 0) {
      const range = document.createRange();
      range.setStart(textNode, idx);
      range.setEnd(textNode, idx + keyword.length);
      const span = document.createElement("span");
      span.className = "highlight-text";
      span.style.background = "#ffe58f";
      try {
        range.surroundContents(span);
        target = span;
      } catch (e) {
        /* 跨节点时跳过 */
      }
      break;
    }
  }
  if (target) target.scrollIntoView({ block: "center", behavior: "smooth" });
}

/**
 * 详情视图（简述/附加内容）窗口高度换算：内容实际高度 → 窗口高度
 * 内容少时收紧到 min，内容多时展开到 max（超出部分由内部滚动承担）。
 * @param {number} contentHeight 内容区实测高度（不含搜索框）
 * @param {{boxHeight:number,min:number,max:number,slack?:number}} opts
 * @returns {number} 目标窗口高度（逻辑像素，已取整）
 */
export function calcDetailWindowHeight(contentHeight, { boxHeight, min, max, slack = 0 }) {
  const content = Math.max(0, Math.ceil(Number(contentHeight) || 0));
  const raw = content + (Number(boxHeight) || 0) + (Number(slack) || 0);
  return Math.round(Math.max(min, Math.min(max, raw)));
}

/**
 * 「窗口失去焦点时是否可以自动隐藏」判定（纯函数，便于单测）。
 *
 * 规则（用户反馈调整后）：
 * - 等待搜索（还没搜过）→ 隐藏
 * - **结果列表展示中 → 隐藏**（点窗口外面即收起，搜索结果看完就走）
 * - 简述内容 / 附加内容 / 脚本应用等详情视图 → **不隐藏**
 *   （用户主动打开、正在阅读/使用，点到外面不应把正在看的东西丢掉）
 * - 搜索进行中、`:debug` 指令模式 → 不隐藏
 *
 * 油猴版 showView() 中 input.blur 的判定（v7.9.5）：
 * ```js
 * registry.view.element.input.blur(function() {
 *   if (isLogoButtonPressedRef.value) return;              // logo 按下中不隐藏
 *   setTimeout(function(){
 *     const isDebuging = isInstructions("debug");
 *     const isSearching = registry.searchData.searchEven.isSearching;
 *     let isWaitSearch = registry.view.seeNowMode() === registry.view.modeEnum.WAIT_SEARCH;
 *     if(isDebuging || isSearching || !isWaitSearch || isLogoButtonPressedRef.value) return;
 *     registry.view.viewVisibilityController(false);
 *   }, registry.view.delayedHideTime);
 * });
 * ```
 * 相比原版，桌面版把「结果列表展示中」也纳入隐藏：原版 `!isWaitSearch` 会让结果区
 * 在失焦时保持显示，而悬浮窗的预期是「看完就收起」；
 * 详情视图仍按原版 `SHOW_ITEM_DETAIL` 处理为不隐藏。
 *
 * 说明：原版还有 `isLogoButtonPressedRef`（按下 logo 按钮期间不隐藏），
 * 那是为了绕过「焦点在窗口内部控件间转移也会触发输入框 blur」的问题；
 * 桌面版监听的是**窗口失焦**，点窗口内部按钮不会让窗口失焦，因此无需该条件。
 *
 * @param {object} s 当前状态
 * @param {object} [s.mode] 当前视图模式（`modeEnum`）
 * @param {number} [s.modeEnum] 模式枚举 `{ WAIT_SEARCH, SHOW_RESULT, SHOW_ITEM_DETAIL }`
 * @param {boolean} [s.isSearching] 是否有搜索在途（还原 searchEven.isSearching）
 * @param {string}  [s.inputValue] 搜索框内容（用于 `:debug` 判定）
 * @returns {boolean} true=失焦自动隐藏
 */
export function shouldHideOnBlur({ mode, modeEnum, isSearching = false, inputValue = "" } = {}) {
  // 搜索进行中不隐藏（还原 isSearching）
  if (isSearching) return false;
  // `:debug` 指令模式不隐藏（还原 isInstructions("debug")）
  if (/^\s*:debug\s*$/i.test(String(inputValue ?? ""))) return false;
  // 详情视图（简述内容 / 附加内容 / 脚本应用）不隐藏 —— 用户正在阅读/使用
  if (modeEnum && mode === modeEnum.SHOW_ITEM_DETAIL) return false;
  // 其余（等待搜索、结果列表展示中）都隐藏；未传模式时取安全默认：不隐藏
  if (modeEnum && mode === modeEnum.WAIT_SEARCH) return true;
  return modeEnum ? mode === modeEnum.SHOW_RESULT : false;
}

/**
 * 「当前视图模式」判定（纯函数，便于单测）。
 *
 * 还原油猴版 `seeNowMode()`：以**真实 DOM 的可见性**为准，而不是可能滞后的 state，
 * 优先级同样是 详情视图 > 结果列表 > 等待搜索/隐藏。
 *
 * @param {object} s 当前 DOM 可见性
 * @param {boolean} [s.textViewVisible] 详情视图（`#text_show`）是否显示
 * @param {boolean} [s.resultVisible] 结果列表（`#matchResult`）是否显示
 * @param {number} s.modeEnum 模式枚举 `{ HIDE, WAIT_SEARCH, SHOW_RESULT, SHOW_ITEM_DETAIL }`
 * @returns {number} 当前模式
 */
export function resolveViewMode({ textViewVisible = false, resultVisible = false, modeEnum } = {}) {
  if (textViewVisible) return modeEnum.SHOW_ITEM_DETAIL;
  if (resultVisible) return modeEnum.SHOW_RESULT;
  // 视图隐藏（窗口已收起）时按「等待搜索」处理，恢复显示后仍可失焦隐藏
  return modeEnum.WAIT_SEARCH;
}

// ========== 数据缓存的「剩余有效期」文案 ==========
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** 两位补零 */
const pad2 = (n) => String(n).padStart(2, "0");

/** 取当天零点时间戳（按自然日比较，跨夏令时也正确） */
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * 剩余时长文案（纯函数，便于单测）。
 *
 * 精度随剩余量收敛，避免「11 小时 59 分 30 秒」这种噪声：
 * - ≥1 天   → `1 天 3 小时`
 * - ≥1 小时 → `11 小时 59 分`
 * - ≥1 分钟 → `59 分 30 秒`
 * - <1 分钟 → `30 秒`
 *
 * @param {number} remainMs 剩余毫秒（≤0 或非法值 → 「已过期」）
 * @returns {string}
 */
export function formatRemainDuration(remainMs) {
  const ms = Number(remainMs);
  if (!Number.isFinite(ms) || ms <= 0) return "已过期";
  const days = Math.floor(ms / DAY_MS);
  if (days >= 1) return `${days} 天 ${Math.floor((ms % DAY_MS) / HOUR_MS)} 小时`;
  const hours = Math.floor(ms / HOUR_MS);
  if (hours >= 1) return `${hours} 小时 ${Math.floor((ms % HOUR_MS) / MINUTE_MS)} 分`;
  const minutes = Math.floor(ms / MINUTE_MS);
  if (minutes >= 1) return `${minutes} 分 ${Math.floor((ms % MINUTE_MS) / 1000)} 秒`;
  return `${Math.floor(ms / 1000)} 秒`;
}

/**
 * 过期时刻文案：当天 `15:20`、次日 `明天 15:20`、前一天 `昨天 15:20`、更远 `09-13 15:20`。
 * @param {number} ts 过期时间戳
 * @param {number} [now=Date.now()] 当前时间戳（便于测试）
 * @returns {string} 非法时间戳返回空串
 */
export function formatClockTime(ts, now = Date.now()) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return "";
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return "";
  const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  // 用「自然日」相减，避免跨夏令时（23/25 小时）被算错一天
  const dayDiff = Math.round((startOfDay(d) - startOfDay(new Date(Number(now) || Date.now()))) / DAY_MS);
  if (dayDiff === 0) return clock;
  if (dayDiff === 1) return `明天 ${clock}`;
  if (dayDiff === -1) return `昨天 ${clock}`;
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${clock}`;
}

/**
 * 数据缓存面板的「条数 + 剩余有效期」文案（纯函数，便于单测）。
 *
 * - 未过期：`1,234 条内容 · 剩 11 小时 59 分（约 15:20 过期）`
 * - 已过期：`1,234 条内容 · 已过期（15:20 失效）`
 * - 无 expire 字段（旧版缓存）：只显示条数，不虚构有效期
 *
 * @param {number} count  数据条数
 * @param {number} expire 过期时间戳（0/null/undefined → 无有效期）
 * @param {number} [now=Date.now()] 当前时间戳（便于测试）
 * @returns {string}
 */
export function formatCacheCountText(count, expire, now = Date.now()) {
  const n = Math.max(0, Math.floor(Number(count) || 0)).toLocaleString();
  const base = `${n} 条内容`;
  const exp = Number(expire);
  if (!Number.isFinite(exp) || exp <= 0) return base;
  const current = Number(now) || Date.now();
  const clock = formatClockTime(exp, current);
  // 当天可以用「约 15:20」这种模糊说法；跨天必须带上「明天 / 09-13」，不能再用「约」
  const sameDay = startOfDay(new Date(exp)) === startOfDay(new Date(current));
  if (exp > current) {
    const tail = clock ? `（${sameDay ? "约 " : ""}${clock} 过期）` : "";
    return `${base} · 剩 ${formatRemainDuration(exp - current)}${tail}`;
  }
  return `${base} · 已过期${clock ? `（${clock} 失效）` : ""}`;
}

/** 搜索框默认占位提示（还原油猴版 searchPlaceholder 的 inputDescs） */
export const PLACEHOLDER_DEFAULT_TEXT = "我的搜索";
/** 准备更新提示（还原 dataInitFun 的 `searchPlaceholder("UPDATE","🔁 数据准备更新中...",5000)`） */
export const PLACEHOLDER_PREPARING_TEXT = "🔁 数据准备更新中...";
/** 进度/状态提示的自动恢复时长（还原原版 `searchPlaceholder(target,placeholder,duration=1200)`） */
export const PLACEHOLDER_RESTORE_MS = 1200;
/** 准备中提示的自动恢复时长（还原 dataInitFun 传入的 duration=5000） */
export const PLACEHOLDER_PREPARE_MS = 5000;

/** 加载进度文案（还原原版缺省文案 `🔁 数据库更新到 N条`） */
export function placeholderProgressText(count) {
  const n = Number(count) || 0;
  return `🔁 数据库更新到 ${n}条`;
}

/**
 * 搜索框占位提示文案（纯函数，便于单测）。
 *
 * 严格对齐油猴版 `searchPlaceholder(target, placeholder, duration)`：
 * - `dataInitFun` 发起更新前：`searchPlaceholder("UPDATE", "🔁 数据准备更新中...", 5000)`
 *   → preparing 阶段，自动恢复时长由 `prepareMs`（默认 5000）决定。
 * - 每解析完一个数据块（`refreshNewData`）：`searchPlaceholder("UPDATE")`
 *   → 缺省文案 `🔁 数据库更新到 N条`，其中 N 是**当前已挂载的数据条数**（即加载进度）；
 *   每次更新都会重置恢复计时（对应原版 `clearTimeout(this.tmpVar)` + 重新 `setTimeout`），
 *   因此最后一块数据到位后再过 `restoreMs`（默认 1200）就恢复成默认提示「我的搜索」。
 *   —— 即：加载/进度提示是「会自动消失」的，绝不会一直卡住。
 * - 数据为空：常驻提示（restoreMs = 0），便于排查。
 * - 加载失败 / 复用缓存：状态提示 + 自动恢复。
 *
 * @param {object} s 状态
 * @param {boolean} s.loading       是否正在加载订阅数据
 * @param {boolean} [s.preparing]   true=尚未收到任何数据块（数据准备更新中）
 * @param {number}  s.count         当前已就绪的数据条数（加载中即为已解析到的条数）
 * @param {number}  [s.failed]      本次加载失败的内容源数量
 * @param {boolean} [s.fromCache]   本次是否直接复用了未过期的本地缓存
 * @param {number}  [s.restoreMs]   进度/状态提示的自动恢复时长（默认 1200，对应原版 duration）
 * @param {number}  [s.prepareMs]   准备中提示的自动恢复时长（默认 5000，对应原版 dataInitFun）
 * @returns {{text:string, restoreMs:number}} restoreMs>0 → 计时结束后恢复默认提示
 */
export function resolvePlaceholder({
  loading,
  preparing = false,
  count = 0,
  failed = 0,
  fromCache = false,
  restoreMs = PLACEHOLDER_RESTORE_MS,
  prepareMs = PLACEHOLDER_PREPARE_MS,
} = {}) {
  if (loading) {
    // 准备阶段：原版 dataInitFun 的 "🔁 数据准备更新中..."（duration=5000）
    if (preparing) return { text: PLACEHOLDER_PREPARING_TEXT, restoreMs: prepareMs };
    // 进度阶段：原版 searchPlaceholder("UPDATE") 的缺省文案（含加载到的条数）
    return { text: placeholderProgressText(count), restoreMs };
  }
  if (count === 0) {
    // 桌面版补充：数据为空时需要用户处理，常驻提示便于排查。
    // 区分「全部订阅加载失败」与「订阅本身解析不出数据」：
    // 前者（如订阅被写成不存在的域名）明确指出失败数量，用户一眼定位原因；
    // 否则给通用的网络/订阅管理指引。
    if (failed > 0) {
      return { text: `⚠️ 数据为空：${failed} 个订阅加载失败，请检查网络或右键 logo 打开订阅管理`, restoreMs: 0 };
    }
    return { text: "⚠️ 数据为空：请检查网络或右键 logo 打开订阅管理", restoreMs: 0 };
  }
  if (failed > 0) {
    return { text: `${placeholderProgressText(count)}（${failed} 个订阅加载失败）`, restoreMs };
  }
  if (fromCache) {
    return { text: `⚡ 数据库已就绪（本地缓存）：${count}条`, restoreMs };
  }
  return { text: placeholderProgressText(count), restoreMs };
}
