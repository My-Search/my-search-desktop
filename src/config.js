/**
 * 我的搜索桌面版 - 配置窗口
 * 独立窗口管理订阅（与主窗口共享 localStorage 数据）
 * 注意：此窗口不加载搜索引擎/订阅数据，只做订阅列表的增删改查，
 * 避免引入重型依赖导致窗口空白/卡死。
 */
import "./css/style.css";
import { isTauri, getDefaultSubscribes } from "./lib/tauri-bridge.js";

// ========== 全局状态 ==========
const SUBSCRIBES_STORAGE_KEY = "my-search-desktop:subscribes";

const state = {
  subscribes: [],
};

const app = document.getElementById("app");

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ========== 模板渲染（复用订阅面板结构） ==========
function renderApp() {
  app.innerHTML = `
    <div class="config-window">
      <div class="panel-header">
        <h3>📚 订阅管理</h3>
        <button class="icon-btn" id="panelClose" title="关闭">✕</button>
      </div>
      <div class="panel-body" id="panelBody"></div>
      <div class="panel-footer">
        <input type="text" id="newSubUrl" placeholder="输入订阅 URL（支持 tis:: 格式或直接 URL）" />
        <button id="btnAddSub">添加</button>
      </div>
    </div>
  `;
}

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
          <button class="remove" data-index="${i}">移除</button>
        </div>
      </div>`
        )
        .join("")
    : '<div class="empty-state" style="padding:20px"><span class="empty-text">暂无订阅，添加一个订阅开始搜索吧</span></div>';
}

// ========== 数据持久化（与主窗口共享） ==========
function loadSubscribes() {
  try {
    const raw = localStorage.getItem(SUBSCRIBES_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.warn("读取本地订阅失败:", e);
    return null;
  }
}

function saveSubscribes() {
  try {
    localStorage.setItem(SUBSCRIBES_STORAGE_KEY, JSON.stringify(state.subscribes));
  } catch (e) {
    console.warn("保存本地订阅失败:", e);
  }
}

// ========== 事件 ==========
function bindEvents() {
  document.getElementById("panelClose").addEventListener("click", closeWindow);
  document.getElementById("btnAddSub").addEventListener("click", addSubscribe);
  document.getElementById("newSubUrl").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addSubscribe();
    // Esc 关闭配置窗口
    if (e.key === "Escape") closeWindow();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeWindow();
  });

  document.getElementById("panelBody").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const index = parseInt(btn.dataset.index);
    if (isNaN(index)) return;
    state.subscribes.splice(index, 1);
    saveSubscribes();
    renderSubscribePanel();
  });
}

function closeWindow() {
  if (isTauri) {
    import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().close())
      .catch(() => window.close());
  } else {
    window.close();
  }
}

function addSubscribe() {
  const input = document.getElementById("newSubUrl");
  const value = input.value.trim();
  if (!value) return;
  let url = value;
  let title = "";
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
}

// ========== 启动 ==========
async function bootstrap() {
  // 先渲染基础 UI，保证窗口不空白
  renderApp();
  bindEvents();

  // 再异步加载订阅数据（失败也不影响 UI 展示）
  try {
    const saved = loadSubscribes();
    if (saved && saved.length > 0) {
      state.subscribes = saved;
    } else {
      const defaults = await getDefaultSubscribes();
      state.subscribes = defaults;
      saveSubscribes();
    }
  } catch (e) {
    console.error("加载订阅失败:", e);
    state.subscribes = [];
  }
  renderSubscribePanel();
}

bootstrap();
