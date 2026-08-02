/**
 * 我的搜索桌面版 - 主应用入口
 * 全局悬浮窗搜索工具（Ctrl+Alt+S 呼出）
 * UI 一比一还原油猴版：呼出时只显示搜索框，输入时展开结果列表
 */
import "./css/style.css";
import { SearchEngine } from "./lib/search-engine.js";
import {
  isTauri,
  getDefaultSubscribes,
  openExternal,
  quitApp,
  hideWindow,
  setWindowHeight,
  openConfigWindow,
} from "./lib/tauri-bridge.js";

// ========== 全局状态 ==========
const SUBSCRIBES_STORAGE_KEY = "my-search-desktop:subscribes";

// 原版 logo 图标（油猴脚本同款）
const LOGO_ICON =
  "data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBzdGFuZGFsb25lPSJubyI/PjwhRE9DVFlQRSBzdmcgUFVCTElDICItLy9XM0MvL0RURCBTVkcgMS4xLy9FTiIgImh0dHA6Ly93d3cudzMub3JnL0dyYXBoaWNzL1NWRy8xLjEvRFREL3N2ZzExLmR0ZCI+PHN2ZyB0PSIxNjc3MDgxNTk3NzA3IiBjbGFzcz0iaWNvbiIgdmlld0JveD0iMCAwIDEwMjQgMTAyNCIgdmVyc2lvbj0iMS4xIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHAtaWQ9IjEzNDYxIiB4bWxuczp4bGluaz0iaHR0cDovL3d3dy53My5vcmcvMTk5OS94bGluayIgd2lkdGg9IjIwMCIgaGVpZ2h0PSIyMDAiPjxwYXRoIGQ9Ik0yMjQuMiA0NzIuM2MtMTMtNS43LTMuNy0yMy41IDguMi0xOSA5MSAzNCAxNDYuOCAxMDguNyAxODIuNCAxMzguNSA1LjYgNC43IDE0IDIuOSAxNy4zLTMuNSAxNi44LTMyIDQ1LjgtMTEzLjctNTcuMS0xNjguNi04Ny4zLTQ2LjUtMTg4LTUzLjYtMjQ3LjMtODIuMi0xNC41LTctMzEuMSA0LjYtMjkuOSAyMC43IDUgNjkuNyAyOC45IDEyNC43IDYyLjMgMTgxLjUgNjcuMyAxMTQuMyAxNDAuNiAxMzIuOSAyMTYuNiAxMDQgMi4yLTAuOSA0LjUtMS44IDctMyA3LTMuNCA4LjMtMTIuOSAyLjUtMTguMSAwLjEgMC00NS43LTY5LjMtMTYyLTE1MC4zeiIgZmlsbD0iI0ZGRDQwMSIgcC1pZD0iMTM0NjIiPjwvcGF0aD48cGF0aCBkPSJNMjgyLjcgODQ5LjljNzkuNS0xMzcgMTcyLjQtMjYzLjEgMzg1LjQtNDAxLjMgOS44LTYuNCAyLjEtMjEuNS04LjktMTcuNEM0OTcuNyA0OTIuOCA0MjkuNyA1ODUgMzczLjMgNjQwLjhjLTguNyA4LjctMjMuNCA2LjMtMjkuMS00LjYtMjcuMi01MS44LTY5LjUtMTc0LjEgOTcuMy0yNjMuMSAxNDcuNy03OC44IDMxOS45LTkxLjQgNDI5LjctOTMuMyAxOC45LTAuMyAzMS41IDE5LjQgMjMuMyAzNi40Qzg2My43IDM4MCA4NDIuNiA0NzggNzg5LjkgNTY3LjYgNjgwLjggNzUzLjEgNTQ1LjUgNzY2LjcgNDIyLjIgNzE5LjhjLTguOC0zLjQtMTguOC0wLjItMjQgNy43LTE2LjYgMjUuMi01MC4zIDgwLjEtNTguNyAxMjIuNC0xMS40IDU2LjgtODIuMiA0My45LTU2LjggMHoiIGZpbGw9IiM4QkMwM0MiIHAtaWQ9IjEzNDYzIj48L3BhdGg+PHBhdGggZD0iTTM3NSA0MTkuNmMtMzAuMSAyOC4yLTQ1LjggNTcuNy01Mi40IDg2LjEgNDAuNiAzMi40IDcwLjIgNjcuNyA5Mi4xIDg1LjkgMS4yIDEgMi41IDEuNiAzLjkgMi4xIDYuNS02LjcgMTMuMy0xMy43IDIwLjQtMjAuNyAxNS4yLTM3LjkgMjUuMy0xMDUuNy02NC0xNTMuNHpNMzE4LjggNTQ4LjJjMS42IDM2LjEgMTQuNyA2Ny42IDI1LjUgODguMSA1LjcgMTAuOSAyMC4zIDEzLjMgMjkuMSA0LjYgNC45LTQuOSAxMC0xMCAxNS4xLTE1LjQtMC42LTEtMS4zLTItMi4yLTIuOCAwLTAuMS0yMC4xLTMwLjUtNjcuNS03NC41eiIgZmlsbD0iIzhCQTAwMCIgcC1pZD0iMTM0NjQiPjwvcGF0aD48L3N2Zz4=";

// vassal 关联项图标（原版同款：链接图标）
const VASSAL_SVG =
  '<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path d="M574 665.4c-8.2 0-16.4-3.1-22.6-9.4-12.5-12.5-12.5-32.8 0-45.3l148-148c33.1-33.1 33.1-86.9 0-120-16-16-37.3-24.8-60-24.8s-44 8.8-60 24.8L445 498.6c-12.5 12.5-32.8 12.5-45.3 0s-12.5-32.8 0-45.3l134.3-134.3c26.5-26.5 61.8-41.1 99.4-41.1 37.5 0 72.8 14.6 99.4 41.1 54.8 54.8 54.8 143.9 0 198.7l-148 148c-6.2 6.3-14.4 9.4-22.6 9.4z" fill="#0088cc"/><path d="M450 820.8c-37.5 0-72.8-14.6-99.4-41.1-54.8-54.8-54.8-143.9 0-198.7l148-148c12.5-12.5 32.8-12.5 45.3 0s12.5 32.8 0 45.3L395.9 626.3c-33.1 33.1-33.1 86.9 0 120 16 16 37.3 24.8 60 24.8s44-8.8 60-24.8l134.3-134.3c12.5-12.5 32.8-12.5 45.3 0s12.5 32.8 0 45.3L561 795.7c-26.5 26.4-61.8 41.1-99.4 41.1z" fill="#0088cc"/></svg>';

// 图标加载占位（原版同款：灰色圆角方块，加载中显示旋转圆圈）
const ICON_LOADING_SVG =
  '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect x="1" y="1" width="22" height="22" rx="4" fill="#e8eaed"/><circle cx="12" cy="12" r="4" fill="none" stroke="#9aa0a6" stroke-width="2" stroke-dasharray="4 2"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></circle></svg>';

const state = {
  engine: new SearchEngine(),
  results: [],        // 当前搜索结果 [{item, level}]
  activeIndex: 0,     // 键盘导航选中项
  subscribes: [],     // 订阅列表
  showSubscribePanel: false,
  selectedText: "",
  // vassal 模式：点击"查看相关联/同类项"后，在搜索框下方展示该关联内容
  vassalMode: false,
  vassalTitle: "",    // 当前 vassal 所属数据项标题
  vassalItems: [],    // 解析出的关联条目 [{title, desc, url}]
};

// ========== DOM 引用 ==========
const app = document.getElementById("app");

// ========== 模板渲染（还原油猴版结构） ==========
function renderApp() {
  app.innerHTML = `
    <div id="my_search_box">
      <div id="tis"></div>
      <div id="my_search_view">
        <div id="searchBox">
          <div id="ms-input-files"></div>
          <input placeholder="输入关键词搜索（支持拼音）..." id="my_search_input" autocomplete="off" spellcheck="false" />
          <button id="logoButton" title="订阅管理">
            <img src="${LOGO_ICON}" draggable="false" />
          </button>
        </div>
        <div id="matchResult">
          <ol id="matchItems"></ol>
        </div>
      </div>
    </div>
    <div class="subscribe-overlay" id="subscribeOverlay">
      <div class="subscribe-panel">
        <div class="panel-header">
          <h3>📚 订阅管理</h3>
          <button class="icon-btn" id="panelClose">✕</button>
        </div>
        <div class="panel-body" id="panelBody"></div>
        <div class="panel-footer">
          <input type="text" id="newSubUrl" placeholder="输入订阅 URL（支持 tis:: 格式或直接 URL）" />
          <button id="btnAddSub">添加</button>
          <button class="btn-close" id="panelClose2">关闭</button>
        </div>
      </div>
    </div>
  `;
}

// ========== 订阅管理 ==========
function renderSubscribePanel() {
  const body = document.getElementById("panelBody");
  if (!body) return;
  body.innerHTML = state.subscribes.length
    ? state.subscribes
        .map(
          (sub, i) => `
      <div class="subscribe-item-row">
        <div class="sub-info">
          <div class="sub-title">${escapeHtml(sub.title || sub.url)}</div>
          <div class="sub-url">${escapeHtml(sub.url)}</div>
        </div>
        <div class="sub-actions">
          <button class="refresh" data-index="${i}">刷新</button>
          <button class="remove" data-index="${i}">移除</button>
        </div>
      </div>`
        )
        .join("")
    : '<div class="empty-state" style="padding:20px"><span class="empty-text">暂无订阅，添加一个订阅开始搜索吧</span></div>';
}

// ========== 结果渲染（还原油猴版 li.resultItem 结构） ==========
// 搜索框高度 47px（45px 输入框 + 2px 边框）；每条结果约 31.2px
const BOX_HEIGHT = 47;
const ROW_HEIGHT = 31.2;
const MAX_RESULT_HEIGHT = 420;

/**
 * 渲染结果列表
 * - vassal 模式：显示关联内容条目（点击 vassal 图标进入）
 * - 普通搜索：显示搜索结果
 * - 无内容：显示"无匹配结果"弹框提示
 */
function renderResults() {
  const list = document.getElementById("matchItems");
  const matchResult = document.getElementById("matchResult");
  if (!list || !matchResult) return;

  // vassal 模式：渲染关联内容
  if (state.vassalMode) {
    matchResult.classList.add("show");
    matchResult.style.display = "block";
    // vassal 关联内容也展开到最大高度
    setWindowHeight(BOX_HEIGHT + MAX_RESULT_HEIGHT);
    list.innerHTML = state.vassalItems
      .map((item, i) => {
        const title = escapeHtml(item.title || "");
        const desc = escapeHtml(item.desc || "");
        const active = i === state.activeIndex ? "active" : "";
        const faviconHtml = item.url ? getFaviconImgHtml({ resource: item.url }) : "";
        const vassalHtml = `<a class="vassal-back" title="返回搜索结果" data-vassal-back="1">‹ 返回</a>`;
        return `
        <li class="resultItem vassal-item ${active}" data-index="${i}">
          ${faviconHtml}
          <a class="enter_main_link" title="${desc}" data-open="${i}">
            <span class="item_title">${title}</span>
            <span class="item_desc">（${desc}）</span>
          </a>
          ${vassalHtml}
        </li>`;
      })
      .join("");
    loadResultIcons(list);
    return;
  }

  // 空结果：隐藏列表，无内容时显示提示弹框
  if (state.results.length === 0) {
    list.innerHTML = "";
    matchResult.classList.remove("show");
    matchResult.style.display = "none";
    setWindowHeight(BOX_HEIGHT);
    // 输入了内容但无匹配 → 显示无结果提示弹框
    const input = document.getElementById("my_search_input");
    const kw = (input && input.value || "").trim();
    if (kw && !state.showSubscribePanel) {
      showNoResultToast(kw);
    }
    return;
  }

  matchResult.classList.add("show");
  matchResult.style.display = "block";

  // 搜索时结果区直接展开到最大高度（问题②：显示最大的高度）
  setWindowHeight(BOX_HEIGHT + MAX_RESULT_HEIGHT);

  list.innerHTML = state.results
    .map(({ item, level }, i) => {
      const title = escapeHtml(item.title || "");
      const desc = escapeHtml(item.desc || "");
      const active = i === state.activeIndex ? "active" : "";
      const faviconHtml = getFaviconImgHtml(item);
      const linksHtml = buildRelatedLinksHtml(item.links);
      const vassalHtml = item.vassal
        ? `<a class="vassal" title="查看相关联/同类项内容" data-vassal="${i}">${VASSAL_SVG}</a>`
        : "";

      return `
      <li class="resultItem ${active}" data-index="${i}">
        ${faviconHtml}
        <a class="enter_main_link" title="${desc}" data-open="${i}">
          <span class="item_title">${title}</span>
          <span class="item_desc">（${desc}）</span>
        </a>
        ${linksHtml}
        ${vassalHtml}
      </li>`;
    })
    .join("");
}

/**
 * 图标加载占位（base64 data URI，避免内联 SVG 转义问题）
 */
function iconLoadingPlaceholder() {
  return "data:image/svg+xml;base64," + btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><rect x="1" y="1" width="22" height="22" rx="4" fill="#e8eaed"/><circle cx="12" cy="12" r="4" fill="none" stroke="#9aa0a6" stroke-width="2" stroke-dasharray="4 2"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></circle></svg>'
  );
}

/**
 * 获取 favicon 图标 HTML（还原油猴版 getFaviconImgHtml）
 * 优先从 item.icon 读取，否则用资源域名生成 favicon 服务地址
 * 加载中先显示占位图标，加载完成后再替换为真实图标
 */
function getFaviconImgHtml(item) {
  const icon = item.icon;
  if (icon) {
    return `<img src="${iconLoadingPlaceholder()}" data-src="${escapeHtml(icon)}" draggable="false" loading="lazy" />`;
  }
  // 从 resource 提取域名生成 favicon
  const urlMatch = (item.resource || "").match(/https?:\/\/([^\/\s]+)/);
  if (urlMatch) {
    const domain = urlMatch[1];
    return `<img src="${iconLoadingPlaceholder()}" data-src="https://api.iowen.cn/favicon/${escapeHtml(domain)}.png" draggable="false" loading="lazy" data-fallback="https://${escapeHtml(domain)}/favicon.ico" />`;
  }
  return "";
}

/**
 * 构建关联链接 HTML（还原油猴版 buildRelatedLinksHtml）
 */
function buildRelatedLinksHtml(links) {
  if (!links || links.length === 0) return "";
  let html = `<div class="related-links">`;
  links.forEach((link) => {
    html += `<a href="#" data-url="${escapeHtml(link.url)}" title="${escapeHtml(
      link.title || link.text
    )}">${escapeHtml(link.text)}</a>`;
  });
  html += "</div>";
  return html;
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ========== 搜索逻辑 ==========
let searchTimer = null;

function onSearchInput(value) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const keyword = value;
    if (!keyword.trim()) {
      state.results = [];
      state.activeIndex = 0;
      // 清空输入时退出 vassal 模式
      state.vassalMode = false;
      state.vassalItems = [];
      renderResults();
      return;
    }
    // 新输入关键词时退出 vassal 模式，回到正常搜索
    state.vassalMode = false;
    state.vassalItems = [];
    state.results = state.engine.search(keyword);
    state.activeIndex = 0;
    renderResults();
    loadResultIcons(document.getElementById("matchItems"));
  }, 80); // 轻微防抖
}

// ========== 打开数据项 ==========
function openResultItem(result) {
  const { item } = result;
  if (!item) return;
  // vassal 模式下点击条目：打开其链接
  if (state.vassalMode) {
    const url = item.url || "";
    if (url) openExternal(url);
    return;
  }
  // 提取 resource 中的第一个 URL
  const urlMatch = (item.resource || "").match(/https?:\/\/[^\s)\]"'<>]+/);
  const url = urlMatch ? urlMatch[0] : null;
  if (url) {
    openExternal(url);
  }
}

// ========== vassal 关联内容 ==========
/**
 * 解析 vassal 文本（markdown 风格）为关联条目列表
 * 支持格式：
 *   > [文字](url)        引用链接行
 *   - [文字](url)        列表链接行
 *   [文字](url)          裸链接行
 *   # 标题(描述)         标题行（作为条目标题）
 *   普通文本行           作为纯文本条目
 * @param {string} vassalText
 * @returns {Array<{title, desc, url}>}
 */
function parseVassalText(vassalText) {
  const items = [];
  const lines = String(vassalText || "").split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    // 标题行：# 标题(描述)
    const titleMatch = line.match(/^#\s*([^（(]+)(?:[（(](.*)[）)])?\s*$/);
    if (titleMatch) {
      items.push({
        title: titleMatch[1].trim(),
        desc: titleMatch[2] ? titleMatch[2].trim() : "",
        url: "",
      });
      continue;
    }
    // 链接行（支持 > 、- 、* 前缀）：[文字](url "title")
    const linkMatch = line.match(/^[>\-*]?\s*\[([^\]]+)\]\((https?:\/\/[^\s)]+)(?:\s+"([^"]*)")?\)/);
    if (linkMatch) {
      items.push({
        title: linkMatch[1].trim(),
        desc: linkMatch[3] || "",
        url: linkMatch[2],
      });
      continue;
    }
    // 裸 URL 行
    const urlMatch = line.match(/^(https?:\/\/[^\s]+)/);
    if (urlMatch) {
      items.push({
        title: urlMatch[1],
        desc: "",
        url: urlMatch[1],
      });
      continue;
    }
    // 普通文本行
    items.push({ title: line, desc: "", url: "" });
  }
  return items;
}

/**
 * 打开 vassal 关联内容（点击"查看相关联/同类项"）
 * 照原脚本：在搜索框下方展示该数据项的关联内容
 */
function openVassal(index) {
  const result = state.results[index];
  if (!result || !result.item || !result.item.vassal) return;
  state.vassalMode = true;
  state.vassalTitle = result.item.title || "";
  state.vassalItems = parseVassalText(result.item.vassal);
  state.activeIndex = 0;
  renderResults();
}

/** 退出 vassal 模式，回到搜索结果 */
function closeVassal() {
  state.vassalMode = false;
  state.vassalTitle = "";
  state.vassalItems = [];
  state.activeIndex = 0;
  renderResults();
}

// ========== 无结果提示弹框 ==========
let noResultToastTimer = null;

/**
 * 显示"无匹配结果"提示弹框（搜索框下方）
 */
function showNoResultToast(keyword) {
  const matchResult = document.getElementById("matchResult");
  const list = document.getElementById("matchItems");
  if (!matchResult || !list) return;
  clearTimeout(noResultToastTimer);
  matchResult.classList.add("show");
  matchResult.style.display = "block";
  // 提示插入 matchItems 列表内部（保留 <ol> 结构，避免破坏后续渲染）
  list.innerHTML = `
    <li class="no-result-toast">
      <span class="no-result-icon">🔍</span>
      <span class="no-result-text">没有找到与「${escapeHtml(keyword)}」相关的内容</span>
    </li>`;
  // 提示弹框只显示 2.5 秒后收起
  noResultToastTimer = setTimeout(() => {
    matchResult.classList.remove("show");
    matchResult.style.display = "none";
    setWindowHeight(BOX_HEIGHT);
  }, 2500);
}

// ========== 图标加载 ==========
/**
 * 结果区图标懒加载：data-src 存在时替换为真实图标（保留加载占位）
 */
function loadResultIcons(container) {
  if (!container) return;
  container.querySelectorAll("img[data-src]").forEach((img) => {
    const realSrc = img.dataset.src;
    if (!realSrc) return;
    const realImg = new Image();
    realImg.onload = () => {
      img.src = realSrc;
      img.removeAttribute("data-src");
    };
    realImg.onerror = () => {
      // 有 fallback 时尝试 fallback，否则保留占位
      if (img.dataset.fallback) {
        const fallbackSrc = img.dataset.fallback;
        const fbImg = new Image();
        fbImg.onload = () => {
          img.src = fallbackSrc;
          img.removeAttribute("data-src");
          img.removeAttribute("data-fallback");
        };
        fbImg.onerror = () => {
          img.removeAttribute("data-src");
          img.removeAttribute("data-fallback");
        };
        fbImg.src = fallbackSrc;
      } else {
        img.removeAttribute("data-src");
      }
    };
    realImg.src = realSrc;
  });
}

// ========== 事件绑定 ==========
function bindEvents() {
  const input = document.getElementById("my_search_input");
  const matchResult = document.getElementById("matchResult");

  // 输入
  input.addEventListener("input", (e) => {
    onSearchInput(e.target.value);
  });

  // 键盘导航
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const total = state.vassalMode ? state.vassalItems.length : state.results.length;
      if (total > 0) {
        state.activeIndex = (state.activeIndex + 1) % total;
        renderResults();
        scrollActiveIntoView();
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const total = state.vassalMode ? state.vassalItems.length : state.results.length;
      if (total > 0) {
        state.activeIndex =
          (state.activeIndex - 1 + total) % total;
        renderResults();
        scrollActiveIntoView();
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (state.vassalMode) {
        const item = state.vassalItems[state.activeIndex];
        if (item && item.url) openExternal(item.url);
      } else {
        const result = state.results[state.activeIndex];
        if (result) openResultItem(result);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (state.showSubscribePanel) {
        closeSubscribePanel();
      } else if (state.vassalMode) {
        // vassal 模式下按 Esc 先返回搜索结果
        closeVassal();
      } else {
        hideWindow();
      }
    }
  });

  // 结果点击（事件委托）
  matchResult.addEventListener("click", (e) => {
    const linkChip = e.target.closest(".related-links a[data-url]");
    if (linkChip) {
      e.preventDefault();
      const url = linkChip.dataset.url;
      if (url) openExternal(url);
      return;
    }
    // vassal 模式下点击"返回"回到搜索结果
    const vassalBack = e.target.closest("[data-vassal-back]");
    if (vassalBack) {
      e.preventDefault();
      closeVassal();
      return;
    }
    const vassal = e.target.closest(".vassal");
    if (vassal) {
      const index = parseInt(vassal.dataset.vassal);
      if (!isNaN(index)) {
        // 照原脚本：点击后在搜索框下方展示该数据项的关联内容
        openVassal(index);
      }
      return;
    }
    const link = e.target.closest("a[data-open]");
    if (link) {
      e.preventDefault();
      const index = parseInt(link.dataset.open);
      if (!isNaN(index) && state.results[index]) {
        openResultItem(state.results[index]);
      }
    }
  });

  // logo 按钮：打开独立配置窗口（订阅管理）
  document.getElementById("logoButton").addEventListener("click", () => {
    openConfigWindow();
  });

  // 订阅管理
  document.getElementById("panelClose").addEventListener("click", closeSubscribePanel);
  document.getElementById("panelClose2").addEventListener("click", closeSubscribePanel);
  document.getElementById("subscribeOverlay").addEventListener("click", (e) => {
    if (e.target.id === "subscribeOverlay") closeSubscribePanel();
  });
  document.getElementById("btnAddSub").addEventListener("click", addSubscribe);

  // 订阅面板操作（事件委托）
  document.getElementById("panelBody").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const index = parseInt(btn.dataset.index);
    if (isNaN(index)) return;
    if (btn.classList.contains("remove")) {
      state.subscribes.splice(index, 1);
      saveSubscribes();
      renderSubscribePanel();
      refreshData();
    } else if (btn.classList.contains("refresh")) {
      refreshData();
    }
  });

  // 新订阅输入回车
  document.getElementById("newSubUrl").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addSubscribe();
  });
}

function scrollActiveIntoView() {
  const active = document.querySelector("#matchItems .resultItem.active");
  if (active) active.scrollIntoView({ block: "nearest" });
}

// ========== 订阅管理逻辑 ==========
function openSubscribePanel() {
  state.showSubscribePanel = true;
  document.getElementById("subscribeOverlay").classList.add("show");
  renderSubscribePanel();
}

function closeSubscribePanel() {
  state.showSubscribePanel = false;
  document.getElementById("subscribeOverlay").classList.remove("show");
}

function addSubscribe() {
  const input = document.getElementById("newSubUrl");
  const value = input.value.trim();
  if (!value) return;
  let url = value;
  let title = "";
  // 支持 tis::URL title="xx" 格式
  const tisMatch = value.match(/^tis::(\S+)(?:\s+title="([^"]*)")?/);
  if (tisMatch) {
    url = tisMatch[1];
    title = tisMatch[2] || "";
  }
  if (!/^https?:\/\//.test(url)) {
    alert("请输入有效的 URL（http/https）");
    return;
  }
  state.subscribes.push({ url, title: title || url, describe: "" });
  input.value = "";
  saveSubscribes();
  renderSubscribePanel();
  refreshData();
}

// ========== 数据加载 ==========
async function initData() {
  try {
    // 优先加载本地保存的订阅，否则用默认订阅
    const saved = loadSubscribesFromStorage();
    if (saved && saved.length > 0) {
      state.subscribes = saved;
    } else {
      const defaults = await getDefaultSubscribes();
      state.subscribes = defaults;
      saveSubscribesToStorage();
    }
    await state.engine.loadAll(state.subscribes);
    // 加载完成后显示 tis 提示（订阅数）
    const tis = document.getElementById("tis");
    if (tis) {
      tis.textContent = `${state.engine.searchData.length} 条数据 · ${state.subscribes.length} 个订阅`;
    }
  } catch (e) {
    console.error("初始化数据失败:", e);
  }
}

async function refreshData() {
  try {
    await state.engine.reload();
    const tis = document.getElementById("tis");
    if (tis) {
      tis.textContent = `${state.engine.searchData.length} 条数据 · ${state.subscribes.length} 个订阅`;
    }
  } catch (e) {
    console.error("刷新失败:", e);
  }
  renderResults();
}

function saveSubscribes() {
  saveSubscribesToStorage();
}

/** 从 localStorage 读取订阅 */
function loadSubscribesFromStorage() {
  try {
    const raw = localStorage.getItem(SUBSCRIBES_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.warn("读取本地订阅失败:", e);
    return null;
  }
}

/** 保存订阅到 localStorage */
function saveSubscribesToStorage() {
  try {
    localStorage.setItem(SUBSCRIBES_STORAGE_KEY, JSON.stringify(state.subscribes));
  } catch (e) {
    console.warn("保存本地订阅失败:", e);
  }
}

// ========== 窗口显示时自动聚焦 ==========
async function setupFocusBehavior() {
  if (!isTauri) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  // 监听窗口显示事件，自动聚焦输入框
  win.onFocusChanged(({ payload: focused }) => {
    if (focused) {
      const input = document.getElementById("my_search_input");
      if (input) {
        setTimeout(() => input.focus(), 50);
      }
    }
  });
  // 启动时若可见则聚焦
  if (await win.isVisible()) {
    const input = document.getElementById("my_search_input");
    if (input) input.focus();
  }
}

// ========== 启动 ==========
async function bootstrap() {
  renderApp();
  bindEvents();
  await initData();
  await setupFocusBehavior();

  // 窗口初始隐藏，由全局快捷键呼出（Tauri 环境）
  if (!isTauri) {
    const input = document.getElementById("my_search_input");
    input.focus();
  }
}

bootstrap();
