/**
 * 我的搜索桌面版 - 主应用入口
 * 全局悬浮窗搜索工具（Ctrl+Alt+S 呼出）
 */
import "./css/style.css";
import { SearchEngine } from "./lib/search-engine.js";
import {
  isTauri,
  getDefaultSubscribes,
  openExternal,
  quitApp,
  hideWindow,
} from "./lib/tauri-bridge.js";

// ========== 全局状态 ==========
// 订阅持久化键
const SUBSCRIBES_STORAGE_KEY = "my-search-desktop:subscribes";

const state = {
  engine: new SearchEngine(),
  results: [],        // 当前搜索结果 [{item, level}]
  activeIndex: 0,     // 键盘导航选中项
  subscribes: [],     // 订阅列表
  showSubscribePanel: false,
  selectedText: "",
};

// ========== DOM 引用 ==========
const app = document.getElementById("app");

// ========== 模板渲染 ==========
function renderApp() {
  app.innerHTML = `
    <div class="search-container">
      <div class="drag-bar"></div>
      <div class="search-input-wrap">
        <span class="search-icon">🔍</span>
        <input class="search-input" type="text" placeholder="输入关键词搜索（支持拼音）..." autocomplete="off" spellcheck="false" />
        <div class="search-actions">
          <span class="status-badge" id="statusBadge">加载中...</span>
          <button class="icon-btn" id="btnSubscribe" title="订阅管理">📚</button>
          <button class="icon-btn" id="btnRefresh" title="刷新数据">🔄</button>
          <button class="icon-btn" id="btnQuit" title="退出">✕</button>
        </div>
      </div>
      <div class="result-list" id="resultList"></div>
      <div class="footer-bar">
        <div class="footer-hints">
          <span><kbd>↑↓</kbd> 选择</span>
          <span><kbd>Enter</kbd> 打开</span>
          <span><kbd>Esc</kbd> 关闭</span>
        </div>
        <div class="footer-right">
          <span class="sub-count" id="subCount">0 个订阅</span>
          <span>我的搜索 v7.9.5 桌面版</span>
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

// ========== 结果渲染 ==========
function renderResults() {
  const list = document.getElementById("resultList");
  if (!list) return;

  if (state.results.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">🔍</span>
        <span class="empty-text">输入关键词搜索你的收藏</span>
        <span class="empty-hint">支持拼音搜索，如输入 "bilibili" 或 "b站"</span>
      </div>`;
    return;
  }

  list.innerHTML = state.results
    .map(({ item, level }, i) => {
      const title = escapeHtml(item.title || "");
      const desc = escapeHtml(item.desc || "");
      const subscribe = escapeHtml(item.subscribe || "");
      const active = i === state.activeIndex ? "active" : "";
      const links = (item.links || [])
        .map(
          (l) =>
            `<span class="link-chip" data-url="${escapeHtml(l.url)}" title="${escapeHtml(
              l.title || l.text
            )}">${escapeHtml(l.text)}</span>`
        )
        .join("");
      const vassal = item.vassal
        ? `<div class="item-vassal">${renderVassalContent(item.vassal)}</div>`
        : "";

      return `
      <div class="result-item ${active}" data-index="${i}">
        <div class="item-title-row">
          <span class="item-title">${title}</span>
          ${level === 2 ? '<span class="item-tag">模糊</span>' : ""}
        </div>
        ${desc !== "--无描述--" ? `<div class="item-desc">${desc}</div>` : ""}
        ${links ? `<div class="item-links">${links}</div>` : ""}
        ${vassal}
        <div class="item-subscribe">${subscribe}</div>
      </div>`;
    })
    .join("");
}

/**
 * 渲染附加内容（vassal）：简单 markdown 链接转 HTML
 */
function renderVassalContent(text) {
  // 转换 [text](url "title") 为链接
  return escapeHtml(text)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\s*\)/g, (m, t, u) => {
      return `<a href="#" data-url="${escapeHtml(u)}">${escapeHtml(t)}</a>`;
    })
    .replace(/\n/g, "<br/>");
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
      renderResults();
      return;
    }
    state.results = state.engine.search(keyword);
    state.activeIndex = 0;
    renderResults();
  }, 80); // 轻微防抖
}

// ========== 打开数据项 ==========
function openResultItem(result) {
  const { item } = result;
  if (!item) return;
  // 提取 resource 中的第一个 URL
  const urlMatch = (item.resource || "").match(/https?:\/\/[^\s)\]"'<>]+/);
  const url = urlMatch ? urlMatch[0] : null;
  if (url) {
    openExternal(url);
  }
}

// ========== 事件绑定 ==========
function bindEvents() {
  const input = document.querySelector(".search-input");
  const resultList = document.getElementById("resultList");
  const statusBadge = document.getElementById("statusBadge");
  const subCount = document.getElementById("subCount");

  // 输入
  input.addEventListener("input", (e) => {
    onSearchInput(e.target.value);
  });

  // 键盘导航
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (state.results.length > 0) {
        state.activeIndex = (state.activeIndex + 1) % state.results.length;
        renderResults();
        scrollActiveIntoView();
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (state.results.length > 0) {
        state.activeIndex =
          (state.activeIndex - 1 + state.results.length) % state.results.length;
        renderResults();
        scrollActiveIntoView();
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      const result = state.results[state.activeIndex];
      if (result) openResultItem(result);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (state.showSubscribePanel) {
        closeSubscribePanel();
      } else {
        hideWindow();
      }
    }
  });

  // 结果点击
  resultList.addEventListener("click", (e) => {
    const linkChip = e.target.closest(".link-chip");
    if (linkChip) {
      const url = linkChip.dataset.url;
      if (url) openExternal(url);
      return;
    }
    const link = e.target.closest('a[data-url]');
    if (link) {
      e.preventDefault();
      const url = link.dataset.url;
      if (url) openExternal(url);
      return;
    }
    const itemEl = e.target.closest(".result-item");
    if (itemEl) {
      const index = parseInt(itemEl.dataset.index);
      if (!isNaN(index) && state.results[index]) {
        openResultItem(state.results[index]);
      }
    }
  });

  // 订阅管理
  document.getElementById("btnSubscribe").addEventListener("click", openSubscribePanel);
  document.getElementById("btnRefresh").addEventListener("click", refreshData);
  document.getElementById("btnQuit").addEventListener("click", () => quitApp());
  document.getElementById("subCount").addEventListener("click", openSubscribePanel);
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
  const list = document.getElementById("resultList");
  const active = list.querySelector(".result-item.active");
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
  const statusBadge = document.getElementById("statusBadge");
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
    document.getElementById("subCount").textContent = `${state.subscribes.length} 个订阅`;
    statusBadge.textContent = "加载中...";
    statusBadge.classList.add("loading");
    await state.engine.loadAll(state.subscribes);
    statusBadge.textContent = `${state.engine.searchData.length} 条数据`;
    statusBadge.classList.remove("loading");
  } catch (e) {
    console.error("初始化数据失败:", e);
    statusBadge.textContent = "加载失败";
    statusBadge.classList.remove("loading");
  }
}

async function refreshData() {
  const statusBadge = document.getElementById("statusBadge");
  statusBadge.textContent = "刷新中...";
  statusBadge.classList.add("loading");
  try {
    await state.engine.reload();
    statusBadge.textContent = `${state.engine.searchData.length} 条数据`;
  } catch (e) {
    console.error("刷新失败:", e);
    statusBadge.textContent = "刷新失败";
  } finally {
    statusBadge.classList.remove("loading");
  }
  renderResults();
}

function saveSubscribes() {
  saveSubscribesToStorage();
  document.getElementById("subCount").textContent = `${state.subscribes.length} 个订阅`;
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
      const input = document.querySelector(".search-input");
      if (input) {
        setTimeout(() => input.focus(), 50);
      }
    }
  });
  // 启动时若可见则聚焦
  if (await win.isVisible()) {
    const input = document.querySelector(".search-input");
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
    const input = document.querySelector(".search-input");
    input.focus();
  }
}

bootstrap();
