/**
 * 我的搜索桌面版 - 设置窗口
 *
 * 参考油猴脚本"我的搜索"（v7.9.5）的配置能力，改造成常见的「设置」布局：
 * 顶栏标题 + 左侧分类菜单 + 右侧内容区。
 * - 订阅管理：订阅总览条块管理（逐条查看/添加/编辑/删除，默认视图），
 *   可切换到源码视图直接编辑 <tis::... /> 订阅原文（与主窗口共享同一份数据）
 * - 关注标签：勾选要「关注」的标签（未勾选 = 加入不关注列表，搜索时过滤）
 * - 公共仓库：提交我的订阅到 TisHub / 打开 Tis 订阅市场 / 清理 Token
 * - 数据缓存：统计本地缓存占用，一键清理可重建的数据缓存
 * - 快捷键设置：自定义全局呼出/隐藏快捷键（默认 Ctrl+Alt+S，后续快捷功能也放这里）
 * - 保存并应用：页面层底栏右侧的图标按钮（仅订阅管理 / 关注标签显示），
 *   写入订阅文本与关注标签，主窗口会自动重新加载
 * - 订阅市场：搜索已安装 / 市场订阅（GitHub Issues），一键安装/移除
 *
 * 注意：此窗口不加载搜索引擎/巨型依赖（如 pinyin-pro），
 * 避免引入重型依赖导致窗口空白/卡死。
 */
import "./css/style.css";
import {
  isTauri,
  getDefaultSubscribeText,
  httpRequest,
  openExternal,
  getToggleShortcut,
  setToggleShortcut,
} from "./lib/tauri-bridge.js";
import {
  escapeHtml,
  escapeAttr,
  storageGet,
  storageSet,
  storageRemove,
  debounce,
  formatCacheCountText,
} from "./lib/util.js";
import {
  interpretKeydown,
  validateCombo,
  shortcutToCaps,
  comboToString,
} from "./lib/shortcut.js";
import {
  parseAllDesignatedSingTags,
  parseTis,
  rebuildTags,
  subscribeItemsToText,
} from "./lib/subscribe-parser.js";

// ========== 存储键（与主窗口/搜索引擎保持一致） ==========
/** 订阅原文（tis 文本），主窗口从这里加载 */
const SUBSCRIBES_KEY = "subscribes";
/** 用户维护的不关注标签列表 */
const UNFOLLOW_KEY = "USER_UNFOLLOW_LIST_CACHE_KEY";
/** 数据项标签统计（由主窗口写入） */
const TAGS_KEY = "DATA_ITEM_TAGS_CACHE_KEY";
/** 数据缓存（与搜索引擎 SEARCH_DATA_KEY 一致）：主窗口写入，这里可清理 */
const SEARCH_DATA_KEY = "SEARCH_DATA_KEY";
/** 订阅列表指纹（与搜索引擎一致）：清理缓存时一并清除 */
const SUBSCRIBE_FINGERPRINT_KEY = "SUBSCRIBE_FINGERPRINT_CACHE_KEY";
/** 已安装的 TisHub 订阅 */
const TISHUB_KEY = "USE_INSTALL_TISHUB_CACHE_KEY";
/** GitHub Token */
const TOKEN_KEY = "USER_GITHUB_TOKEN_CACHE_KEY";
/** 默认不关注的标签 */
const DEFAULT_UNFOLLOW = ["成人内容", "Adults only"];

const TISHUB_LOGO = "https://cdn.jsdelivr.net/gh/My-Search/TisHub/favicon.ico";
const TISHUB_REPO = "https://github.com/My-Search/TisHub";

/** 默认全局呼出快捷键（与 Rust 端 DEFAULT_TOGGLE_SHORTCUT 一致） */
const DEFAULT_TOGGLE_SHORTCUT = "ctrl+alt+s";
/** 当前生效的呼出快捷键（bootstrap 时从后端读取，「快捷键设置」面板展示/保存用） */
let toggleShortcutSaved = DEFAULT_TOGGLE_SHORTCUT;

const app = document.getElementById("app");

// ========== 订阅文本读写（与主窗口共享） ==========
function getSubscribe() {
  const saved = storageGet(SUBSCRIBES_KEY, null);
  // 兼容旧版结构化数组
  if (Array.isArray(saved)) {
    const text = subscribeItemsToText(saved);
    storageSet(SUBSCRIBES_KEY, text);
    return text;
  }
  if (typeof saved === "string" && saved.trim() !== "") return saved;
  return "";
}

/** 写入订阅文本并返回有效 tis 数量（还原 editSubscribe） */
function editSubscribe(subscribe) {
  const tisArr = parseAllDesignatedSingTags(String(subscribe ?? ""), "tis");
  const subscribeText = "\n" + rebuildTags(tisArr) + "\n";
  const newSubscribeInfo = subscribeText.replace(/\n+/gm, "\n\n");
  storageSet(SUBSCRIBES_KEY, newSubscribeInfo);
  return tisArr.length;
}

// ========== GitHub API（还原 GithubAPI） ==========
/** 由 initInteractions 注入，用于 token 更新后刷新界面状态 */
let onTokenChanged = () => {};

const GithubAPI = {
  clearToken() {
    storageRemove(TOKEN_KEY);
  },
  /** 同步读取已缓存 Token */
  getToken() {
    return storageGet(TOKEN_KEY, null);
  },
  /**
   * 确保拿到 Token：已缓存则直接返回，否则弹出输入框并等待用户输入
   * （还原油猴版 setToken/prompt 语义，但改为异步等待）
   */
  async requestToken() {
    const cached = storageGet(TOKEN_KEY, null);
    if (cached != null && cached !== "") return cached;
    const value = await askToken();
    if (value == null || value === "") return null;
    storageSet(TOKEN_KEY, value);
    onTokenChanged();
    return value;
  },
  baseRequest(type, url, { query, body, headers } = {}) {
    let full = url;
    if (query) {
      const q = new URLSearchParams(query).toString();
      if (q) full += (full.includes("?") ? "&" : "?") + q;
    }
    const h = { ...(headers || {}) };
    const token = storageGet(TOKEN_KEY, null);
    if (token && !h.Authorization) h.Authorization = `Bearer ${token}`;
    return httpRequest(full, {
      method: type,
      headers: h,
      body: body == null ? undefined : body,
    });
  },
  getUserInfo() {
    return this.baseRequest("GET", "https://api.github.com/user");
  },
  commitIssues(body) {
    const token = storageGet(TOKEN_KEY, null);
    return this.baseRequest("POST", "https://api.github.com/repos/My-Search/TisHub/issues", {
      body,
      headers: { Authorization: `Bearer ${token}` },
    });
  },
  // get issues 不要加 Authorization 头，可能会出现 401
  getTisForIssues({ keyword, state } = {}) {
    if (keyword) {
      return this.baseRequest(
        "GET",
        `https://api.github.com/search/issues?q=repo:My-Search/TisHub+state:${state}+in:title+${keyword}`,
        { headers: {} }
      )
        .then((response) => (response && response.items) || [])
        .catch(() => []);
    }
    const query = state != null ? { state } : null;
    return this.baseRequest("GET", "https://api.github.com/repos/My-Search/TisHub/issues", {
      query,
      headers: {},
    });
  },
};

// ========== TisHub 订阅市场（还原 TisHub） ==========
const TisHub = {
  tisFilter(source, filterList) {
    if (typeof source === "string") source = parseTis(source);
    if (typeof filterList === "string") filterList = parseTis(filterList);
    for (const filterItem of filterList) {
      const tabMetaInfos = parseAllDesignatedSingTags(String(filterItem), "tis");
      let subscribedLink = null;
      if (tabMetaInfos != null && tabMetaInfos.length > 0) {
        subscribedLink = tabMetaInfos[0].tabValue;
      }
      if (subscribedLink == null) subscribedLink = filterItem;
      source = source.filter((resultSubscribed) => !String(resultSubscribed).includes(subscribedLink));
    }
    return source;
  },
  getTisHubAllTis(filterList = []) {
    return Promise.all([this.getOpenIssuesTis(), this.getClosedIssuesTis()]).then((values) => {
      const result = [];
      for (const value of values) {
        if (value == null) continue;
        for (const tisListObj of value) {
          if (tisListObj != null) result.push(...tisListObj.tisList);
        }
      }
      return this.tisFilter(result, filterList);
    });
  },
  // {keyword,state}，其中 state {open, closed, all}
  getTisForIssues(params = {}) {
    return new Promise((resolve) => {
      GithubAPI.getTisForIssues(params)
        .then((response) => {
          if (response != null && Array.isArray(response)) {
            resolve(
              response.map((obj) => ({
                owner: obj.user.login,
                ownerProfile: obj.user.html_url,
                title: obj.title,
                tisList: parseTis(obj.body),
                status: obj.state,
              }))
            );
          } else {
            resolve([]);
          }
        })
        .catch(() => resolve([]));
    });
  },
  getOpenIssuesTis(params = {}) {
    return this.getTisForIssues({ state: "open", ...params });
  },
  getClosedIssuesTis(params = {}) {
    return this.getTisForIssues({ state: "closed", ...params });
  },
};

// ========== 页面内 Token 输入框（替代 window.prompt） ==========
let askTokenResolver = null;
function askToken() {
  return new Promise((resolve) => {
    askTokenResolver = resolve;
    const overlay = document.getElementById("tokenOverlay");
    overlay.classList.add("show");
    const input = document.getElementById("tokenInput");
    input.value = "";
    input.focus();
  });
}
function closeAskToken(value) {
  const overlay = document.getElementById("tokenOverlay");
  if (overlay) overlay.classList.remove("show");
  if (askTokenResolver) {
    askTokenResolver(value);
    askTokenResolver = null;
  }
}

// ========== 页面内确认/提示弹窗（替代 window.confirm / window.alert） ==========
//
// macOS 的 WKWebView 里 wry 未实现 runJavaScriptAlertPanel/
// runJavaScriptConfirmPanel，window.confirm 会直接返回 false、window.alert 完全无效果。
// 而设置窗口的「清理缓存」「删除订阅」「提交到 TisHub」都依赖用户确认，
// 所以统一改成应用内弹窗（样式复用 .token-overlay/.token-dialog）。
let msgDialogResolver = null;

/**
 * 弹出确认框（单按钮时退化为提示框）
 * @param {string} text 正文
 * @param {{title?:string, okText?:string, cancelText?:string, showCancel?:boolean}} [opts]
 * @returns {Promise<boolean>} 点「确定」为 true；点「取消」/Esc 为 false
 */
function showMessage(text, { title = "提示", okText = "确定", cancelText = "取消", showCancel = true } = {}) {
  return new Promise((resolve) => {
    const overlay = document.getElementById("msgOverlay");
    const titleEl = document.getElementById("msgTitle");
    const textEl = document.getElementById("msgText");
    const cancelBtn = document.getElementById("msgCancel");
    const okBtn = document.getElementById("msgOk");
    if (!overlay || !titleEl || !textEl || !cancelBtn || !okBtn) {
      // 极早期调用（UI 未渲染）时的兼容：至少不静默丢提示
      if (showCancel) console.warn(`[我的搜索] ${title}：${text}`);
      resolve(!showCancel);
      return;
    }
    msgDialogResolver = resolve;
    titleEl.textContent = title;
    textEl.textContent = text;
    cancelBtn.textContent = cancelText;
    cancelBtn.style.display = showCancel ? "" : "none";
    okBtn.textContent = okText;
    overlay.classList.add("show");
    okBtn.focus();
  });
}

/** 关闭弹窗并返回结果（内部/键盘共用） */
function closeMessage(result) {
  const overlay = document.getElementById("msgOverlay");
  if (overlay) overlay.classList.remove("show");
  const resolve = msgDialogResolver;
  msgDialogResolver = null;
  if (resolve) resolve(!!result);
}

/** 确认框（对齐 window.confirm 的语义与返回类型） */
function confirmMessage(text, opts) {
  return showMessage(text, opts);
}

/** 提示框（只有一个「确定」按钮，对齐 window.alert） */
function alertMessage(text, opts = {}) {
  return showMessage(text, { ...opts, title: opts.title || "提示", showCancel: false });
}

// ========== 数据缓存：统计与展示 ==========
/**
 * 缓存条目定义。clearable=true 的缓存属于「可安全重建」，一键清理后主窗口会重新加载；
 * 其余为用户数据（订阅原文、标签偏好等），仅统计占用，不提供一键清理。
 */
const CACHE_BLUEPRINT = [
  {
    key: SEARCH_DATA_KEY,
    label: "订阅数据缓存",
    desc: "主窗口加载订阅后的搜索结果缓存，可由订阅重新构建",
    clearable: true,
  },
  {
    key: SUBSCRIBE_FINGERPRINT_KEY,
    label: "订阅指纹",
    desc: "订阅原文指纹，用于判断数据缓存是否已失效",
    clearable: true,
  },
  {
    key: TAGS_KEY,
    label: "标签统计",
    desc: "数据项标签及数量统计，主窗口加载数据时刷新",
    clearable: false,
  },
  {
    key: "ITEM_WEIGHT_CACHE_KEY",
    label: "条目权重",
    desc: "根据你的选择行为累积的排序权重",
    clearable: false,
  },
  {
    key: "HISTORY_CACHE_KEY",
    label: "搜索历史",
    desc: "最近 60 条搜索记录",
    clearable: false,
  },
  {
    key: "SEARCH_NEW_ITEMS_KEY",
    label: "新增条目记录",
    desc: "订阅更新后标记出来的新条目",
    clearable: false,
  },
  {
    key: SUBSCRIBES_KEY,
    label: "订阅原文",
    desc: "「订阅管理」中保存的 <tis::… /> 文本",
    clearable: false,
  },
  {
    key: UNFOLLOW_KEY,
    label: "不关注标签",
    desc: "你在「关注标签」中取消勾选的标签",
    clearable: false,
  },
  {
    key: TISHUB_KEY,
    label: "已安装订阅",
    desc: "TisHub 已安装订阅的本地记录",
    clearable: false,
  },
  {
    key: TOKEN_KEY,
    label: "GitHub Token",
    desc: "用于向 TisHub 提交订阅的 GitHub Token",
    clearable: false,
  },
];

/** 一键清理时移除的缓存键（均可由主窗口重新构建） */
const CACHE_CLEAR_KEYS = [SEARCH_DATA_KEY, SUBSCRIBE_FINGERPRINT_KEY];

function formatBytes(bytes) {
  const n = Math.max(0, Math.round(Number(bytes) || 0));
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/** 序列化体积（UTF-8 估算），仅用于展示相对大小 */
function rawByteSize(raw) {
  if (raw == null) return 0;
  try {
    return new Blob([typeof raw === "string" ? raw : JSON.stringify(raw)]).size;
  } catch (e) {
    return 0;
  }
}

/** 每个缓存键的「条数 / 项数」描述文案 */
function cacheCountText(key, raw) {
  if (raw == null) return "";
  if (key === SEARCH_DATA_KEY) {
    const data = Array.isArray(raw.data) ? raw.data : [];
    // 显示「剩余有效期」：未过期给出剩余时长 + 具体过期时刻，已过期给出失效时刻
    return formatCacheCountText(data.length, raw.expire);
  }
  if (key === SUBSCRIBE_FINGERPRINT_KEY) return "已生成";
  if (Array.isArray(raw)) {
    const total = raw.reduce((sum, it) => sum + (Number(it && it.count) || 0), 0);
    return total > 0
      ? `${raw.length.toLocaleString()} 项 · ${total.toLocaleString()} 条`
      : `${raw.length.toLocaleString()} 项`;
  }
  if (typeof raw === "object") return `${Object.keys(raw).length.toLocaleString()} 项`;
  if (typeof raw === "string") return `${raw.length.toLocaleString()} 字符`;
  return "";
}

function collectCache(subscribeTextValue) {
  return CACHE_BLUEPRINT.map((bp) => {
    // 订阅原文可能处于「已编辑未保存」状态，面板切换会销毁编辑框，
    // 所以这里优先用 JS 侧传入的当前文本估算占用。
    const raw =
      bp.key === SUBSCRIBES_KEY && subscribeTextValue != null
        ? subscribeTextValue
        : storageGet(bp.key, null);
    const bytes = rawByteSize(raw);
    return {
      key: bp.key,
      label: bp.label,
      desc: bp.desc,
      clearable: !!bp.clearable,
      bytes,
      sizeText: formatBytes(bytes),
      countText: cacheCountText(bp.key, raw),
      expired: bp.key === SEARCH_DATA_KEY && isCacheExpired(raw),
    };
  });
}

/** 订阅数据缓存是否已过期（无 expire 字段的旧缓存不算过期，与 isCacheValid 不会误判一致） */
function isCacheExpired(raw) {
  if (raw == null || typeof raw !== "object") return false;
  const expire = Number(raw.expire);
  return Number.isFinite(expire) && expire > 0 && expire <= Date.now();
}

/**
 * 渲染数据缓存面板。
 * @param {string} [subscribeTextValue] 当前订阅原文（含未保存的编辑），用于估算其占用
 */
function renderCachePanel(subscribeTextValue) {
  const listEl = document.getElementById("cacheList");
  if (!listEl) return;

  const entries = collectCache(subscribeTextValue);
  const total = entries.reduce((sum, e) => sum + e.bytes, 0);
  const totalEl = document.getElementById("cacheTotalSize");
  if (totalEl) totalEl.textContent = formatBytes(total);

  listEl.innerHTML = entries
    .map((e) => {
      const empty = e.bytes === 0;
      const badge = e.clearable ? '<span class="cache-badge">可清理</span>' : "";
      const cls = `cache-item${empty ? " empty" : ""}${e.expired ? " expired" : ""}`;
      return `
        <div class="${cls}" data-key="${escapeAttr(e.key)}">
          <div class="cache-item-main">
            <div class="cache-item-title"><span>${escapeHtml(e.label)}</span>${badge}</div>
            <div class="cache-item-desc">${escapeHtml(e.desc)}</div>
          </div>
          <div class="cache-item-meta">
            <span class="cache-size">${empty ? "空" : escapeHtml(e.sizeText)}</span>
            ${e.countText ? `<span class="cache-count">${escapeHtml(e.countText)}</span>` : ""}
          </div>
        </div>`;
    })
    .join("");

  // 剩余时间是“活”的：面板停留期间每秒刷新一次
  startCacheCountdown();
}

// ---------- 数据缓存的剩余时间倒计时 ----------
/**
 * 只重算「订阅数据缓存」一条的剩余时间，不动其余 DOM。
 * @returns {boolean} 是否还需要继续倒数
 */
function paintCacheCountdown() {
  const item = document.querySelector(
    '#cacheList .cache-item[data-key="' + SEARCH_DATA_KEY + '"]'
  );
  // 面板已切走 → 不需要再倒计时
  if (!item) return false;
  const el = item.querySelector(".cache-count");
  if (!el) return false;
  const raw = storageGet(SEARCH_DATA_KEY, null);
  const expired = isCacheExpired(raw);
  // 过期的这一刻也要再刷一次，否则会停在「剩 0 秒」
  el.textContent = cacheCountText(SEARCH_DATA_KEY, raw);
  item.classList.toggle("expired", expired);
  return !expired;
}

/** 倒计时定时器（面板销毁 / 已过期时自动停止，不空转） */
let cacheCountdownTimer = null;

function stopCacheCountdown() {
  if (cacheCountdownTimer) {
    clearInterval(cacheCountdownTimer);
    cacheCountdownTimer = null;
  }
}

/**
 * 启动剩余时间倒计时（每秒一次）。
 * 文案最小精度为秒（剩余不足 1 分钟时），1 秒的刷新间隔足够且开销极小；
 * 一旦没有可倒计时的内容就自动停掉定时器。
 */
function startCacheCountdown() {
  stopCacheCountdown();
  if (!paintCacheCountdown()) return;
  cacheCountdownTimer = setInterval(() => {
    if (!paintCacheCountdown()) stopCacheCountdown();
  }, 1000);
}

// ========== 渲染 ==========
/**
 * 计算每个标签的勾选态。
 * @param {Array} tagsOfData 标签统计
 * @param {Array} userUnfollowList 不关注列表
 * @param {Map<string,boolean>} [checkedMap] 内存中的勾选态（优先于缓存）
 */
function giveTagsStatus(tagsOfData, userUnfollowList, checkedMap) {
  const userUnfollowMap = {};
  for (const item of userUnfollowList) userUnfollowMap[item] = "";
  return tagsOfData.map((item) => {
    const checked =
      checkedMap && checkedMap.has(item.name)
        ? checkedMap.get(item.name)
        : userUnfollowMap[item.name] == null;
    return { ...item, status: checked ? 1 : 0 };
  });
}

/** 单个「关注标签」胶囊的 HTML */
function tagChipHtml(item) {
  return `
    <label class="tag-chip" title="${escapeAttr(item.name)}">
      <input type="checkbox" name="_tagsCheckBox" value="${escapeAttr(item.name)}" ${
    item.status == 1 ? "checked" : ""
  } />
      <span class="tag-name">${escapeHtml(item.name)}</span>
      <span class="tag-count">${item.count ?? 0}</span>
    </label>`;
}

// ========== 面板模板（按需渲染，切走即销毁） ==========
/** 有内容需要保存的页面：只有这两个页面显示底栏的「保存并应用」按钮 */
const PANES_WITH_SAVE = ["subscribes", "tags"];

/**
 * 「快捷键设置」面板的条目。目前只有一项：全局呼出/隐藏。
 * 后续新增快捷功能时在此追加条目（录入/展示逻辑由 paneBinders.shortcut 统一处理）。
 */
const SHORTCUT_ITEMS = [
  {
    id: "toggle",
    label: "呼出 / 隐藏搜索框",
    desc: "在任意应用中按下该组合键，呼出或收起搜索框（原快捷键 Ctrl+Alt+S）",
    placeholder: "点击后按下新的组合键…",
  },
];

/** 订阅条块左侧的固定图标（数据库样式，fill 跟随 currentColor） */
const SUB_ITEM_ICON = `<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M0.499902 124.275727a511.400117 123.675845 0 1 0 1022.800235 0 511.400117 123.675845 0 1 0-1022.800235 0Z"/><path d="M511.90002 248.651435c-136.673306 0-265.048233-12.897481-361.72935-36.292911C53.289592 188.863113 0 157.669205 0 124.275727s53.289592-64.587385 150.17067-87.982815C246.851787 12.997461 375.226714 0 511.90002 0s265.048233 12.897481 361.729349 36.292912c96.881078 23.495411 150.17067 54.689318 150.17067 87.982815s-53.289592 64.587385-150.17067 87.982816c-96.681117 23.395431-225.056044 36.392892-361.729349 36.392892zM511.90002 1.099785C230.155048 1.099785 0.999805 56.388987 0.999805 124.275727c0 67.986721 229.155243 123.275923 510.900215 123.275923s511.000195-55.289201 511.000195-123.275923C1022.900215 56.388987 793.644991 1.099785 511.90002 1.099785zM914.621363 311.239211c-93.681703 26.594806-239.253271 43.691467-402.721343 43.691467s-309.139621-17.096661-402.721344-43.691467C41.191955 330.535442 0.599883 354.930678 0.599883 381.425503c0 62.987698 228.955282 113.877758 511.400117 113.877758s511.500098-50.990041 511.500098-113.877758c-0.09998-26.494825-40.692052-50.890061-108.878735-70.186292z"/><path d="M511.90002 495.903144c-136.673306 0-265.048233-11.897676-361.72935-33.393478C53.289592 440.913884 0 412.119508 0 381.425503c0-25.894942 37.692638-50.390158 109.078696-70.686194h0.199961c97.680922 27.794571 244.452255 43.691467 402.621363 43.691466s304.840461-15.896895 402.621363-43.691466h0.19996c71.286077 20.296036 109.078696 44.791252 109.078696 70.686194 0 30.694005-53.289592 59.388401-150.17067 80.984183-96.681117 21.595782-225.056044 33.493458-361.729349 33.493458zM109.178676 311.739113c-34.393283 9.798086-61.188049 20.695958-79.584456 32.393674-18.99629 11.997657-28.594415 24.595196-28.594415 37.292716 0 62.487795 229.255224 113.477836 511.000195 113.477836s510.900215-50.890061 510.900215-113.477836c0-12.7975-9.598125-25.29506-28.594415-37.392697-18.396407-11.697715-45.191174-22.495606-79.584457-32.393673-97.880883 27.794571-244.552236 43.691467-402.821323 43.691466s-304.940441-15.896895-402.721344-43.591486z"/><path d="M914.621363 575.787541c-93.681703 26.594806-239.253271 43.691467-402.721343 43.691467s-309.139621-17.096661-402.721344-43.691467C41.091974 595.183753 0.499902 619.578988 0.499902 645.973833c0 62.987698 228.955282 113.877758 511.400118 113.877758s511.500098-50.990041 511.500097-113.877758c0-26.394845-40.592072-50.79008-108.778754-70.186292z"/><path d="M511.90002 760.551455c-136.673306 0-265.048233-11.897676-361.72935-33.393478C53.289592 705.562195 0 676.667838 0 645.973833c0-25.894942 37.692638-50.390158 109.078696-70.686194h0.199961C206.959578 603.082211 353.630931 618.979106 511.90002 618.979106s304.840461-15.896895 402.621363-43.691467h0.19996c71.286077 20.296036 109.078696 44.791252 109.078696 70.686194 0 30.694005-53.289592 59.388401-150.17067 80.984183-96.681117 21.695763-225.056044 33.593439-361.729349 33.593439zM109.178676 576.287444C74.685413 586.185511 47.990627 596.983402 29.59422 608.681117 10.59793 620.678774 0.999805 633.276313 0.999805 645.973833c0 62.487795 229.255224 113.477836 511.000195 113.477837s510.900215-50.890061 510.900215-113.477837c0-12.7975-9.598125-25.29506-28.594415-37.392697-18.396407-11.697715-45.191174-22.495606-79.584457-32.393673C816.840461 604.082015 670.169108 619.97891 511.90002 619.97891s-304.940441-15.896895-402.721344-43.691466z"/><path d="M914.621363 839.236087C820.93966 865.830892 675.368092 882.927553 511.90002 882.927553s-309.139621-16.99668-402.721344-43.691466C41.191955 858.532318 0.599883 882.927553 0.599883 909.422378c0 62.987698 228.955282 113.877758 511.400117 113.877759s511.500098-50.990041 511.500098-113.877759c-0.09998-26.394845-40.692052-50.79008-108.878735-70.186291z"/><path d="M511.90002 1024c-136.673306 0-265.048233-11.897676-361.72935-33.393478C53.289592 969.01074 0 940.116384 0 909.422378c0-25.894942 37.692638-50.390158 109.078696-70.686194h0.199961c97.680922 27.794571 244.452255 43.691467 402.621363 43.691467s304.840461-15.896895 402.621363-43.691467h0.19996c71.286077 20.296036 109.078696 44.791252 109.078696 70.686194 0 30.694005-53.289592 59.388401-150.17067 80.984183-96.681117 21.695763-225.056044 33.593439-361.729349 33.593439zM109.178676 839.735989c-34.393283 9.798086-61.188049 20.695958-79.584456 32.393673-18.99629 11.997657-28.594415 24.595196-28.594415 37.292716C0.999805 972.010154 230.255028 1022.900215 512 1022.900215s510.900215-50.890061 510.900215-113.477837c0-12.7975-9.598125-25.29506-28.594415-37.392696-18.396407-11.697715-45.191174-22.495606-79.584457-32.393673-97.880883 27.794571-244.552236 43.791447-402.821323 43.791447s-304.940441-15.996876-402.721344-43.691467z"/></svg>`;

// 每个 panes.xxx() 返回该面板的 HTML 字符串。仅在进入该面板时才渲染，
// 切走时整个面板从 DOM 移除，不做保活。
const panes = {
  subscribes() {
    return `
      <section class="page subscribes">
        <div class="cfg-card">
          <div class="cfg-card-head">
            <h3>订阅总览</h3>
            <span class="cfg-hint-icon" title="每行一个 <tis::… />，支持 title / describe 属性" aria-label="每行一个 <tis::… />，支持 title / describe 属性">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                   stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            </span>
          </div>
          <!-- 顶部工具条：计数 + 操作按钮 -->
          <div class="sub-toolbar">
            <span class="sub-count"></span>
            <button type="button" class="sub-reset" data-act="reset-defaults" title="重置为默认订阅（覆盖当前所有订阅）" aria-label="重置为默认订阅">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="1 4 1 10 7 10" />
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
              </svg>
            </button>
            <div class="sub-view-toggle" role="tablist">
              <button type="button" data-view="cards" class="on" title="按条块管理每条订阅">条块</button>
              <button type="button" data-view="src" title="直接编辑 <tis::… /> 原文（高级）">源码</button>
            </div>
          </div>
          <!-- 条块列表（JS 填充） -->
          <div class="sub-list"></div>
          <!-- 添加订阅（折叠态只有一个按钮） -->
          <div class="sub-add-wrap"></div>
          <!-- 源码视图：保留原始文本域，仅源码模式下显示 -->
          <textarea id="all_subscribe" spellcheck="false" placeholder="&lt;tis::https://…/index.ms title=&quot;订阅名&quot; describe=&quot;描述&quot; /&gt;"></textarea>
        </div>
      </section>`;
  },

  tags(checkedMap) {
    const userUnfollowList = storageGet(UNFOLLOW_KEY, null) ?? DEFAULT_UNFOLLOW;
    let tagsOfData = storageGet(TAGS_KEY, null);
    let body;
    if (Array.isArray(tagsOfData) && tagsOfData.length > 0) {
      // 勾选态优先用内存里的 state（面板不保活，重进时未保存的勾选不能丢）
      body = giveTagsStatus(tagsOfData, userUnfollowList, checkedMap).map(tagChipHtml).join("");
    } else {
      body =
        '<div class="tags-empty">暂无标签数据：请先在主窗口加载一次订阅数据（打开搜索框，等待「数据库更新到 N 条」）。</div>';
    }
    return `
      <section class="page tags">
        <div class="cfg-card">
          <div class="cfg-card-head">
            <h3>关注标签</h3>
            <span class="cfg-hint">取消勾选 = 搜索时过滤掉含该标签的内容</span>
          </div>
          <div class="tagsCheckBoxDiv">${body}</div>
        </div>
      </section>`;
  },

  repo() {
    return `
      <section class="page repo">
        <div class="cfg-card">
          <div class="cfg-card-head">
            <h3>公共仓库</h3>
            <span class="cfg-hint">TisHub 是一个开源订阅仓库，订阅以 Issues 方式共享</span>
          </div>
          <div class="cfg-btn-row">
            <button id="pushTis" class="cfg-btn primary">提交我的订阅到 TisHub <span class="badge submitable">-</span></button>
            <button id="openTisHub" class="cfg-btn">Tis 订阅市场</button>
            <button id="clearToken" class="cfg-btn ghost" style="display:none;">清理 Token</button>
          </div>
          <div class="cfg-note">
            提交订阅需要 GitHub Token，仅缓存在本地；Token 失效或需要更换时，可先点击「清理 Token」后重试。
            <a href="${TISHUB_REPO}" data-ext="${TISHUB_REPO}" class="cfg-hub-link">打开 TisHub 仓库 ↗</a>
          </div>
        </div>
      </section>`;
  },

  cache() {
    return `
      <section class="page cache">
        <div class="cfg-card">
          <div class="cfg-card-head">
            <h3>数据缓存</h3>
            <span class="cfg-hint">主窗口与设置窗口共用本地缓存</span>
          </div>
          <div class="cache-summary">
            <div class="cache-summary-main">
              <span class="cache-summary-label">本地缓存总占用</span>
              <span id="cacheTotalSize" class="cache-summary-value">0 B</span>
            </div>
            <button id="clearDataCache" class="cfg-btn">清理可重建缓存</button>
          </div>
          <div id="cacheList" class="cache-list"></div>
          <div class="cfg-note">
            「订阅数据缓存 / 订阅指纹」可由订阅重新生成，清理后主窗口会在下次唤出时重新加载；
            其余为用户数据（订阅原文、关注标签、权重、历史等），仅统计占用、不在此处清理。
          </div>
        </div>
      </section>`;
  },

  // 「快捷键设置」面板目前只有一项：全局呼出/隐藏。
  // 后续新增快捷功能时在此追加条目（录入/展示逻辑由 paneBinders.shortcut 统一处理）。
  shortcut() {
    return `
      <section class="page shortcut">
        <div class="cfg-card">
          <div class="cfg-card-head">
            <h3>快捷键设置</h3>
            <span class="cfg-hint">组合键需包含 Ctrl / Alt / Shift / Win 至少一个修饰键</span>
          </div>
          ${SHORTCUT_ITEMS.map(
            (item) => `
          <div class="shortcut-row" data-shortcut-id="${escapeAttr(item.id)}">
            <div class="shortcut-info">
              <span class="shortcut-label">${escapeHtml(item.label)}</span>
              <span class="shortcut-desc">${escapeHtml(item.desc)}</span>
            </div>
            <div class="shortcut-value">
              <span class="shortcut-caps" title="当前快捷键"></span>
              <button type="button" class="shortcut-capture" data-act="capture"
                      title="点击后按下新的组合键"
                      aria-label="点击录入新的快捷键">${escapeHtml(item.placeholder)}</button>
              <button type="button" class="cfg-btn ghost shortcut-reset" data-act="reset"
                      title="恢复为默认快捷键 Ctrl+Alt+S">恢复默认</button>
            </div>
          </div>`
          ).join("")}
          <div class="cfg-note">
            点击「点击后按下新的组合键…」进入录入状态，按下组合键即完成录入；
            Esc 取消录入，Backspace 清空。保存后立即生效；
            若提示注册失败，说明该组合键已被系统或其它程序占用，请换一个。
          </div>
        </div>
      </section>`;
  },

  "tis-hub"() {
    return `
      <section class="page tis-hub">
        <div class="cfg-card">
          <div class="cfg-card-head">
            <button id="backHome" class="cfg-back" title="返回公共仓库">← 返回</button>
            <h3>订阅市场</h3>
            <a href="${TISHUB_REPO}" data-ext="${TISHUB_REPO}" class="cfg-hub-link" title="TisHub 是一个 GitHub 仓库，订阅以 Issues 的方式存在">TisHub ↗</a>
          </div>
          <div class="hub-search">
            <img class="hub-logo" src="${TISHUB_LOGO}" alt="TisHub" />
            <div class="keyword">
              <input name="keyword" placeholder="输入关键字，回车搜索…" />
              <button id="search-tishub">搜索</button>
            </div>
          </div>
          <div class="search-type segmented">
            <label>
              <input type="radio" name="search-type" value="installed" checked>
              <span>已安装</span>
            </label>
            <label>
              <input type="radio" name="search-type" value="market">
              <span>市场订阅</span>
            </label>
          </div>
        </div>
        <div class="result-list">
          <div class="list-rol"></div>
        </div>
      </section>`;
  },
};

function renderApp() {
  app.innerHTML = `
    <div id="ms-config-view">
      <header class="cfg-header">
        <div class="cfg-title">
          <span class="cfg-logo" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </span>
          <span>设置</span>
        </div>
        <span class="cfg-header-sub">我的搜索</span>
      </header>

      <div class="cfg-main">
        <aside class="cfg-nav">
          <button class="nav-item on" data-pane="subscribes">订阅管理</button>
          <button class="nav-item" data-pane="tags">关注标签</button>
          <button class="nav-item" data-pane="repo">公共仓库</button>
          <button class="nav-item" data-pane="cache">数据缓存</button>
          <button class="nav-item" data-pane="shortcut">快捷键设置</button>
        </aside>

        <main class="cfg-body"></main>
      </div>

      <!--
        页面层底栏：目前只有「保存并应用」一个按钮，固定在底栏右侧，
        仅在需要保存的页面（订阅管理 / 关注标签）显示，详见 setPane / syncPageFooter。
        按钮只保留图标，文字改由 title / aria-label 提供。
      -->
      <footer class="cfg-footer">
        <button class="btn-save" type="button" data-role="save"
                title="保存并应用" aria-label="保存并应用">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none"
               stroke="currentColor" stroke-width="2.6"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </button>
      </footer>

      <!-- 提示：浮动 toast（无底部栏，不占地） -->
      <div id="cfgToast" class="cfg-toast" role="status" aria-live="polite"></div>

      <div id="tokenOverlay" class="token-overlay">
        <div class="token-dialog">
          <h3>GitHub Token</h3>
          <p>请输入您的 GitHub Token（仅缓存在本地，用于提交订阅到 TisHub）：</p>
          <input id="tokenInput" type="text" placeholder="ghp_xxx / github_pat_xxx" />
          <div class="token-actions">
            <button id="tokenCancel" class="cfg-btn ghost">取消</button>
            <button id="tokenOk" class="cfg-btn primary">确定</button>
          </div>
        </div>
      </div>

      <!--
        通用确认/提示弹窗。

        为什么不直接用 window.confirm / window.alert：在 macOS 的 WKWebView 里
        wry 没有实现 runJavaScriptAlertPanel / runJavaScriptConfirmPanel，
        这两个 API 是**静默无效**的（confirm 永远返回 false），
        会导致「清理缓存」「删除订阅」「提交到 TisHub」这些按钮点了完全没反应。
        所以这里统一用应用内弹窗，三个平台表现一致。
      -->
      <div id="msgOverlay" class="token-overlay">
        <div class="token-dialog">
          <h3 id="msgTitle"></h3>
          <p id="msgText"></p>
          <div class="token-actions">
            <button id="msgCancel" class="cfg-btn ghost">取消</button>
            <button id="msgOk" class="cfg-btn primary">确定</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

/** 内容面板挂载点 */
const paneHost = () => document.querySelector("#ms-config-view .cfg-body");

/**
 * 切换右侧内容面板（按需渲染，不保活）。
 *
 * 面板不做常驻/缓存：每次进入都用 panes.xxx() 重新生成 HTML，
 * 并把上一个面板整体从 DOM 移除。因此各面板的瞬时状态（未保存的
 * 订阅原文、面板内的输入）不依赖 DOM 存活，而由 `state`（见 initInteractions）持有。
 *
 * 「保存并应用」是页面层底栏右侧的图标按钮（见 renderApp 里的 .cfg-footer），
 * 只有订阅管理 / 关注标签两个页面需要它，由 syncPageFooter() 控制显隐。
 *
 * @param {string} pane 内容面板（subscribes / tags / repo / cache / tis-hub）
 * @param {string} [navPane] 左侧菜单要高亮的分项；订阅市场（tis-hub）属于「公共仓库」的分支视图
 * @param {*} [data] 该面板的渲染数据（如关注标签的勾选态），透传给 panes.xxx(data)
 */
function setPane(pane = "subscribes", navPane = pane, data) {
  const host = paneHost();
  if (!host) return;

  const build = panes[pane] || panes.subscribes;
  // 直接替换 innerHTML：旧面板（连同其事件监听）被整体丢弃，不做保活
  host.innerHTML = build(data);

  document.querySelectorAll("#ms-config-view .cfg-nav .nav-item").forEach((el) => {
    el.classList.toggle("on", el.dataset.pane === navPane);
  });

  syncPageFooter(pane);
}

/**
 * 底栏只服务于「有内容需要保存」的页面：订阅管理、关注标签。
 * 底栏常驻在 DOM 里（按钮事件只在初始化时绑定一次），这里只切换显隐。
 * @param {string} pane 已渲染/待渲染的内容面板
 */
function syncPageFooter(pane) {
  const footer = document.querySelector("#ms-config-view .cfg-footer");
  if (footer) footer.classList.toggle("show", PANES_WITH_SAVE.includes(pane));
}

// ========== 视图逻辑 ==========
/**
 * 面板按需渲染（不保活）后，DOM 里的元素会随面板切换而销毁，
 * 因此所有「跨面板需要保留」的状态都集中放在这里，而不是依赖 DOM 存活。
 */
function initInteractions() {
  const $ = (sel, all = false) => {
    if (all) return [...document.querySelectorAll(sel)];
    return document.querySelector(sel);
  };

  /** 面板挂载点内的查询（仅当前已渲染的面板内有元素） */
  const $pane = (sel) => document.querySelector(`#ms-config-view .cfg-body ${sel}`);

  const configTip = $("#cfgToast");
  let currentPane = "subscribes";
  let commitableTisList = null;
  /** toast 自动隐藏定时器 */
  let toastTimer = null;
  /**
   * 「快捷键设置」录入态标志（paneBinders.shortcut 置位/复位）。
   * 放在函数级作用域供全局 keydown（Esc 关窗）判断让路。
   */
  let shortcutCapturing = false;
  /**
   * 当前面板的清理函数（showPane 切换时调用）。
   * 大多数面板的监听都绑在自身 DOM 上（随 innerHTML 替换自动销毁），
   * 只有把监听挂到 document/window 的面板才需要在这里登记清理。
   */
  let paneDispose = null;

  /**
   * 跨面板状态。面板会被销毁重建，所以这些都放在 JS 里：
   * - subscribeDraft：订阅原文（含未保存的编辑），是文本域的唯一数据源
   * - tagChecked：标签名 -> 是否勾选（关注标签面板未挂载时也能保存）
   * - tisHubInput：订阅市场面板的关键字输入（切走再回来不丢）
   * - tisHubMode：已安装 / 市场订阅
   */
  const state = {
    subscribeDraft: "",
    tagChecked: new Map(),
    tisHubInput: "",
    tisHubMode: "installed",
    // 订阅总览的视图模式与瞬时状态（面板销毁重建，这些状态靠 state 保留）
    subView: "cards", // cards=条块管理 | src=源码编辑
    subAddOpen: false, // 「添加订阅」是否展开
    subEditIndex: null, // 正在行内编辑的订阅序号
    // 关注标签的脏标记：有未保存勾选时，外部数据进来要「合并」而不是覆盖
    // （订阅原文不需要：它只会被用户自己编辑，没有任何外部写入路径）
    tagDirty: false,
    // 标签统计签名（名称+数量），用于判断外部数据是否变化而需要重渲染
    tagsSignature: "",
    // 快捷键设置：面板不保活，录入中的值暂存于此
    // saved 当前生效值（bootstrap 时从后端读入 toggleShortcutSaved）；
    // pending 待保存值（null = 未改动）
    paneShortcut: { saved: toggleShortcutSaved, pending: null },
  };

  /**
   * 显示提示。底部栏已移除，改用浮动 toast：出现后自动消失，不占版面。
   * @param {string} text 提示文案
   * @param {'ok'|'error'} [type] 语义（决定颜色）
   */
  function showTip(text, type = "ok") {
    if (!configTip) return;
    configTip.textContent = text;
    configTip.className = `cfg-toast show ${type}`;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      configTip.className = `cfg-toast ${type}`;
    }, 2600);
  }

  // 已安装订阅：优先从订阅原文推导（保证安装立即生效）
  let installedList = [];
  function loadInstalledList() {
    const fromText = parseAllDesignatedSingTags(state.subscribeDraft, "tis").map((tis) => ({
      name: tis.title || tis.tabValue,
      describe: tis.describe || "",
      body: rebuildTags([tis]),
      state: "enable",
    }));
    const stored = (storageGet(TISHUB_KEY, []) || []).filter((it) => it.state === "disable");
    const names = new Set(fromText.map((it) => it.name));
    return [...fromText, ...stored.filter((it) => !names.has(it.name))];
  }

  function persistInstalled() {
    storageSet(TISHUB_KEY, installedList);
  }

  // ---------- 订阅原文：以 state.subscribeDraft 为准 ----------
  /** 将当前文本域里的内容收回 state（离开面板前调用，避免编辑丢失） */
  function stashSubscribeDraft() {
    const ta = $pane("#all_subscribe");
    if (ta) state.subscribeDraft = ta.value;
  }

  /** 将 state 写回订阅原文并持久化，返回有效 tis 数量 */
  function commitSubscribeDraft() {
    return editSubscribe(state.subscribeDraft);
  }

  /**
   * 从订阅原文解析出条块列表。
   * 返回 [{index, name, describe, url, body}]，index 是在原文中的序号，
   * body 是还原后的单条 tis 文本（编辑/删除时按 tabValue 定位）。
   */
  function parseSubscribeItems() {
    return parseAllDesignatedSingTags(state.subscribeDraft, "tis").map((tis, index) => ({
      index,
      name: tis.title || tis.tabValue,
      describe: tis.describe || "",
      url: tis.tabValue,
      body: rebuildTags([tis]),
    }));
  }

  /** 用条块列表重建订阅原文（逐条 rebuildTags 后换行拼接，保持两行分隔的存储格式） */
  function subscribeItemsToRawText(items) {
    return items.map((it) => it.body).join("\n\n");
  }

  /** 订阅原文 -> state 并持久化（条块操作后统一出口，返回有效数） */
  function writeSubscribeItems(items) {
    state.subscribeDraft = subscribeItemsToRawText(items);
    const count = commitSubscribeDraft();
    renderSubList();
    return count;
  }

  /** 将一段 tis 文本写入订阅原文并持久化 */
  function appendSubscribeToText(tisBody) {
    const cur = state.subscribeDraft.trim();
    state.subscribeDraft = cur === "" ? tisBody : cur + "\n" + tisBody;
    commitSubscribeDraft();
    syncSubscribeTextarea();
  }

  function removeSubscribeFromText(tisBody) {
    const metas = parseAllDesignatedSingTags(tisBody, "tis");
    const url = metas.length > 0 ? metas[0].tabValue : null;
    const lines = state.subscribeDraft.split("\n").filter((line) => {
      if (!line.includes("<tis::")) return true;
      const m = parseAllDesignatedSingTags(line, "tis");
      if (m.length > 0 && url != null) return m[0].tabValue !== url;
      return !line.includes(tisBody);
    });
    state.subscribeDraft = lines.join("\n");
    commitSubscribeDraft();
    syncSubscribeTextarea();
  }

  /** state -> 文本域（仅在订阅管理面板已渲染时生效） */
  function syncSubscribeTextarea() {
    const ta = $pane("#all_subscribe");
    if (ta) ta.value = state.subscribeDraft;
  }

  // ---------- 订阅总览：条块视图 ----------
  /** 单个订阅条块的 HTML（name/describe/url 均已转义） */
  function subItemHtml(item, editing) {
    if (editing) {
      return `
        <div class="sub-item editing" data-index="${item.index}">
          <span class="sub-icon" aria-hidden="true">${SUB_ITEM_ICON}</span>
          <div class="sub-main">
            <input class="sub-edit-name" value="${escapeAttr(item.name)}" placeholder="订阅名称" />
            <input class="sub-edit-describe" value="${escapeAttr(item.describe)}" placeholder="描述（可选）" />
            <input class="sub-edit-url sub-url" value="${escapeAttr(item.url)}" placeholder="https://…/index.ms" />
          </div>
          <div class="sub-ops">
            <button class="sub-op" data-act="save-edit" title="确定"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></button>
            <button class="sub-op" data-act="cancel-edit" title="取消"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
          </div>
        </div>`;
    }
    return `
      <div class="sub-item" data-index="${item.index}" draggable="true">
        <button type="button" class="sub-drag" title="拖拽排序" aria-label="拖拽排序">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
            <circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/>
            <circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/>
            <circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/>
          </svg>
        </button>
        <span class="sub-icon" aria-hidden="true">${SUB_ITEM_ICON}</span>
        <div class="sub-main">
          <span class="sub-name" title="${escapeAttr(item.name)}">${escapeHtml(item.name)}</span>
          ${
            item.describe
              ? `<span class="sub-describe" title="${escapeAttr(item.describe)}">${escapeHtml(item.describe)}</span>`
              : ""
          }
          <span class="sub-url" title="${escapeAttr(item.url)}">${escapeHtml(item.url)}</span>
        </div>
        <div class="sub-ops">
          <button class="sub-op" data-act="open" title="打开订阅地址"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></button>
          <button class="sub-op" data-act="edit" title="编辑"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg></button>
          <button class="sub-op danger" data-act="remove" title="删除"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
        </div>
      </div>`;
  }

  /** 添加订阅区域的 HTML（折叠 = 一个虚线按钮；展开 = 表单） */
  function subAddHtml(open) {
    if (!open) {
      return `<button type="button" class="sub-add-toggle" data-act="open-add">＋ 添加订阅</button>`;
    }
    return `
      <div class="sub-add open">
        <div class="sub-add-row">
          <input class="sub-add-url" placeholder="订阅地址（必填，https://…/index.ms）" />
        </div>
        <div class="sub-add-row">
          <input class="sub-add-name" placeholder="订阅名称（可选，默认取地址）" />
          <input class="sub-add-describe" placeholder="描述（可选）" />
        </div>
        <div class="sub-add-actions">
          <button type="button" class="cfg-btn ghost" data-act="close-add">取消</button>
          <button type="button" class="cfg-btn primary" data-act="confirm-add">添加</button>
        </div>
      </div>`;
  }

  /** 重新渲染条块列表 + 计数 + 添加区（订阅原文不变时不会丢状态） */
  function renderSubList() {
    const page = document.querySelector("#ms-config-view .page.subscribes");
    if (!page) return;
    const list = page.querySelector(".sub-list");
    const addWrap = page.querySelector(".sub-add-wrap");
    const countEl = page.querySelector(".sub-count");
    if (!list || !addWrap) return;

    page.classList.toggle("src-mode", state.subView === "src");

    const items = parseSubscribeItems();
    if (countEl) countEl.textContent = `共 ${items.length} 条订阅`;

    if (items.length === 0) {
      list.innerHTML = '<div class="sub-empty">暂无订阅。点击下方「＋ 添加订阅」，或切到「源码」直接粘贴 <tis::… /> 文本。</div>';
    } else {
      list.innerHTML = items.map((it) => subItemHtml(it, state.subEditIndex === it.index)).join("");
    }
    addWrap.innerHTML = subAddHtml(state.subAddOpen);
    syncSubscribeTextarea();

    // 展开添加表单时自动聚焦地址框 + 键盘：Enter 确认 / Esc 取消
    if (state.subAddOpen) {
      const urlInput = addWrap.querySelector(".sub-add-url");
      if (urlInput) urlInput.focus();
      addWrap.onkeydown = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          addWrap.querySelector('[data-act="confirm-add"]')?.click();
        } else if (e.key === "Escape") {
          e.stopPropagation(); // 别触发窗口级 Esc 关窗
          addWrap.querySelector('[data-act="close-add"]')?.click();
        }
      };
    } else {
      addWrap.onkeydown = null;
    }
    // 行内编辑时自动聚焦名称框 + 键盘：Enter 确认 / Esc 取消
    if (state.subEditIndex != null) {
      const nameInput = list.querySelector('.sub-item.editing .sub-edit-name');
      if (nameInput) nameInput.focus();
      list.onkeydown = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          list.querySelector('[data-act="save-edit"]')?.click();
        } else if (e.key === "Escape") {
          e.stopPropagation(); // 别触发窗口级 Esc 关窗
          list.querySelector('[data-act="cancel-edit"]')?.click();
        }
      };
    } else {
      list.onkeydown = null;
    }
  }

  // ---------- 关注标签：勾选态以 state.tagChecked 为准 ----------
  /** 标签统计签名（名称 + 数量），任一变化都需重渲染面板 */
  function tagsSignature() {
    const tagsOfData = storageGet(TAGS_KEY, null);
    if (!Array.isArray(tagsOfData)) return "";
    return tagsOfData.map((t) => `${t.name}:${t.count ?? 0}`).join("|");
  }

  /**
   * 从缓存载入勾选态。
   * 有未保存改动时采用「合并」而不是覆盖：保留用户已经点过的勾选，
   * 只把新出现的标签按存储里的默认值补进来（否则切到主窗口再回来会丢改动）。
   */
  function loadTagChecked() {
    const userUnfollowList = storageGet(UNFOLLOW_KEY, null) ?? DEFAULT_UNFOLLOW;
    const unfollow = new Set(userUnfollowList);
    const tagsOfData = storageGet(TAGS_KEY, null);
    if (!Array.isArray(tagsOfData)) {
      state.tagChecked = new Map();
      return;
    }

    const previous = state.tagChecked;
    const next = new Map();
    for (const item of tagsOfData) {
      const storedChecked = !unfollow.has(item.name);
      // 未编辑过：完全以存储为准；已编辑：保留用户勾选，只补新标签
      next.set(
        item.name,
        !state.tagDirty || !previous.has(item.name) ? storedChecked : previous.get(item.name)
      );
    }
    state.tagChecked = next;
  }

  /** 保存关注标签：把 state.tagChecked 写回缓存 */
  function saveTagChecked() {
    const followed = [];
    const unfollowed = [];
    for (const [name, checked] of state.tagChecked) {
      (checked ? followed : unfollowed).push(name);
    }
    // 剃除已转关注的，添加新关注的
    let userUnfollowList = (storageGet(UNFOLLOW_KEY, null) ?? DEFAULT_UNFOLLOW).filter(
      (item) => !followed.includes(item)
    );
    userUnfollowList = userUnfollowList.concat(
      unfollowed.filter((item) => !userUnfollowList.includes(item))
    );
    storageSet(UNFOLLOW_KEY, userUnfollowList);
    state.tagDirty = false;
  }

  // ---------- 刷新视图状态（Token 显示、可提交数） ----------
  // 面板可能未挂载，所以所有 DOM 访问都要判空。
  async function refreshViewState() {
    const clearTokenBtn = $pane("#clearToken");
    const pushTisBtn = $pane("#pushTis");
    if (clearTokenBtn) {
      clearTokenBtn.style.display = GithubAPI.getToken() == null ? "none" : "inline-block";
    }
    try {
      const tisList = await TisHub.getTisHubAllTis();
      commitableTisList = TisHub.tisFilter(state.subscribeDraft, tisList) || [];
    } catch (e) {
      commitableTisList = null;
    }
    const badge = pushTisBtn && pushTisBtn.querySelector("span");
    if (badge) badge.textContent = commitableTisList == null ? "-" : commitableTisList.length;
  }
  onTokenChanged = refreshViewState;

  // ---------- 各面板的事件绑定（每次渲染后重新绑定） ----------
  const paneBinders = {
    subscribes() {
      const page = document.querySelector("#ms-config-view .page.subscribes");
      const ta = $pane("#all_subscribe");
      if (ta) {
        ta.value = state.subscribeDraft;
        ta.oninput = () => {
          state.subscribeDraft = ta.value;
          refreshSubscribeText();
        };
      }
      renderSubList();
      if (!page) return;

      // 视图切换：条块 / 源码
      const toggle = page.querySelector(".sub-view-toggle");
      if (toggle) {
        toggle.querySelectorAll("button").forEach((btn) => {
          btn.classList.toggle("on", btn.dataset.view === state.subView);
          btn.addEventListener("click", () => {
            if (btn.dataset.view === state.subView) return;
            if (btn.dataset.view === "src") {
              // 条块 -> 源码：无未保存的编辑态可直接切
              state.subView = "src";
              state.subAddOpen = false;
              state.subEditIndex = null;
            } else {
              // 源码 -> 条块：先把文本域内容收回 state，再重渲染
              stashSubscribeDraft();
              state.subView = "cards";
            }
            renderSubList();
            // 切换后同步两个视图的选中态
            toggle.querySelectorAll("button").forEach((b) => {
              b.classList.toggle("on", b.dataset.view === state.subView);
            });
          });
        });
      }

      // 条块列表 + 添加区的事件委托
      const list = page.querySelector(".sub-list");
      if (list) list.addEventListener("click", onSubListClick);
      const addWrap = page.querySelector(".sub-add-wrap");
      if (addWrap) addWrap.addEventListener("click", onSubAddClick);

      // 重置为默认订阅（工具栏上的图标按钮）
      const resetBtn = page.querySelector(".sub-reset");
      if (resetBtn) {
        resetBtn.addEventListener("click", async () => {
          if (state.subEditIndex != null) {
            showTip("请先完成当前编辑操作。", "error");
            return;
          }
          if (!(await confirmMessage("确定重置为默认订阅吗？这将覆盖当前所有订阅，不可撤销。"))) return;
          try {
            const defaults = await getDefaultSubscribeText();
            editSubscribe(defaults);
            state.subscribeDraft = getSubscribe();
            state.subAddOpen = false;
            state.subEditIndex = null;
            state.subView = "cards";
            renderSubList();
            refreshSubscribeText();
            showTip("已重置为默认订阅。", "ok");
          } catch (e) {
            showTip("获取默认订阅失败: " + (e.message ?? e), "error");
          }
        });
      }

      // 拖拽排序（HTML5 DnD，事件委托在列表上，重渲染无需重绑）
      if (list) {
        let dragIndex = null;
        list.addEventListener("dragstart", (e) => {
          const itemEl = e.target.closest(".sub-item");
          if (!itemEl || state.subEditIndex != null) {
            e.preventDefault(); // 编辑态/非条块目标禁止拖拽
            return;
          }
          dragIndex = Number(itemEl.dataset.index);
          itemEl.classList.add("dragging");
          e.dataTransfer.effectAllowed = "move";
          try {
            e.dataTransfer.setData("text/plain", String(dragIndex));
          } catch {}
        });
        list.addEventListener("dragover", (e) => {
          e.preventDefault(); // 允许放置
          e.dataTransfer.dropEffect = "move";
          const itemEl = e.target.closest(".sub-item");
          list.querySelectorAll(".sub-item").forEach((el) => {
            el.classList.toggle(
              "drag-over",
              el === itemEl && Number(el.dataset.index) !== dragIndex
            );
          });
        });
        list.addEventListener("dragleave", (e) => {
          if (e.target === list) {
            list.querySelectorAll(".sub-item.drag-over").forEach((el) => el.classList.remove("drag-over"));
          }
        });
        list.addEventListener("drop", (e) => {
          e.preventDefault();
          const itemEl = e.target.closest(".sub-item");
          const overIndex = itemEl ? Number(itemEl.dataset.index) : null;
          list.querySelectorAll(".sub-item.drag-over").forEach((el) => el.classList.remove("drag-over"));
          if (dragIndex == null || overIndex == null || dragIndex === overIndex) return;
          const items = parseSubscribeItems();
          const from = items.findIndex((it) => it.index === dragIndex);
          const to = items.findIndex((it) => it.index === overIndex);
          if (from < 0 || to < 0) return;
          const [moved] = items.splice(from, 1);
          items.splice(to, 0, moved);
          dragIndex = null;
          writeSubscribeItems(items);
          refreshSubscribeText();
        });
        list.addEventListener("dragend", () => {
          dragIndex = null;
          list.querySelectorAll(".sub-item").forEach((el) =>
            el.classList.remove("dragging", "drag-over")
          );
        });
      }
    },

    tags() {
      syncChips();
      document
        .querySelectorAll("#ms-config-view .tag-chip input")
        .forEach((cb) =>
          cb.addEventListener("change", () => {
            state.tagChecked.set(cb.value, cb.checked);
            state.tagDirty = true;
            syncChips();
          })
        );
    },

    repo() {
      const pushTisBtn = $pane("#pushTis");
      const openTisHubBtn = $pane("#openTisHub");
      const clearTokenBtn = $pane("#clearToken");
      if (openTisHubBtn) {
        openTisHubBtn.onclick = () => showPane("tis-hub", "repo");
      }
      if (clearTokenBtn) {
        clearTokenBtn.onclick = () => {
          GithubAPI.clearToken();
          refreshViewState();
        };
      }
      if (pushTisBtn) pushTisBtn.onclick = onPushTis;
      refreshViewState();
    },

    cache() {
      const btn = $pane("#clearDataCache");
      if (btn) {
        btn.onclick = async () => {
          if (
            !(await confirmMessage("确定清理可重建的数据缓存吗？主窗口将在下次唤出时重新加载订阅数据。"))
          )
            return;
          for (const key of CACHE_CLEAR_KEYS) storageRemove(key);
          renderCachePanel(state.subscribeDraft);
          showTip("已清理数据缓存，主窗口将重新加载订阅数据。", "ok");
        };
      }
      renderCachePanel(state.subscribeDraft);
    },

    shortcut() {
      const page = document.querySelector("#ms-config-view .page.shortcut");
      if (!page) return;
      const row = page.querySelector(".shortcut-row");
      if (!row) return;

      const capsEl = row.querySelector(".shortcut-caps");
      const captureBtn = row.querySelector(".shortcut-capture");
      const resetBtn = row.querySelector(".shortcut-reset");

      /** 默认快捷键（与 Rust 端 DEFAULT_TOGGLE_SHORTCUT 一致） */
      const DEFAULT_SHORTCUT = DEFAULT_TOGGLE_SHORTCUT;

      /** 当前展示值：pending（未保存的录入）优先，否则为已生效值 */
      const displayValue = () => state.paneShortcut.pending ?? state.paneShortcut.saved;

      /** 渲染「当前生效值」的键帽展示 */
      const paintCaps = () => {
        capsEl.innerHTML = shortcutToCaps(displayValue())
          .map((cap) => `<kbd class="kbd">${escapeHtml(cap)}</kbd>`)
          .join('<span class="kbd-plus">+</span>');
      };

      /** 渲染录入按钮：录入态提示按下组合键，普通态显示待保存/当前值 */
      const paintCaptureBtn = () => {
        captureBtn.classList.remove("capturing", "invalid");
        if (capturing) {
          captureBtn.classList.add("capturing");
          captureBtn.textContent = "按下新的组合键…（Esc 取消）";
          return;
        }
        captureBtn.textContent =
          state.paneShortcut.pending != null
            ? shortcutToCaps(displayValue()).join(" + ")
            : "点击修改快捷键";
      };

      /** 把 pending 保存到后端并立即生效 */
      async function saveShortcut() {
        const value = state.paneShortcut.pending;
        if (value == null) return;
        try {
          await setToggleShortcut(value);
          state.paneShortcut.saved = value;
          toggleShortcutSaved = value; // 同步模块级变量（与后端 store 一致）
          state.paneShortcut.pending = null;
          paintCaps();
          paintCaptureBtn();
          showTip("快捷键已保存并生效。", "ok");
        } catch (e) {
          // 注册失败（被占用等）：丢弃待保存值，回到当前生效值的展示
          state.paneShortcut.pending = null;
          paintCaps();
          paintCaptureBtn();
          showTip(e.message ?? String(e), "error");
        }
      }

      /** 录入态：点击按钮后进入，keydown 捕获组合键 */
      let capturing = false;
      const stopCapture = () => {
        capturing = false;
        shortcutCapturing = false;
        paintCaptureBtn();
      };

      const onKeydown = (e) => {
        if (!capturing) return;
        // 拦截所有按键（含 Tab / 空格），录入期间不触发页面其它行为（含 Esc 关窗）
        e.preventDefault();
        e.stopPropagation();

        const parsed = interpretKeydown(e);
        if (parsed.kind === "cancel") {
          stopCapture();
          return;
        }
        if (parsed.kind === "clear") {
          // 清空 = 复位为「当前生效值」
          state.paneShortcut.pending = null;
          paintCaps();
          stopCapture();
          return;
        }
        if (parsed.kind !== "combo") return; // modifier-only / ignore：继续等待主键

        const check = validateCombo(parsed.modifiers, parsed.mainKey);
        if (!check.ok) {
          captureBtn.classList.add("invalid");
          captureBtn.textContent = check.reason;
          return;
        }
        state.paneShortcut.pending = comboToString(parsed.modifiers, parsed.mainKey);
        capturing = false;
        shortcutCapturing = false;
        paintCaps();
        paintCaptureBtn();
        saveShortcut();
      };

      captureBtn.addEventListener("click", () => {
        if (capturing) {
          stopCapture();
        } else {
          capturing = true;
          shortcutCapturing = true;
          captureBtn.classList.remove("invalid");
          paintCaptureBtn();
        }
      });
      document.addEventListener("keydown", onKeydown);
      // 面板切换时 showPane 会调用 paneDispose：移除 document 级监听 + 复位录入态
      paneDispose = () => {
        document.removeEventListener("keydown", onKeydown);
        shortcutCapturing = false;
      };

      // 恢复默认：直接保存默认值（立即生效）
      resetBtn.addEventListener("click", () => {
        if (capturing) stopCapture();
        state.paneShortcut.pending = DEFAULT_SHORTCUT;
        paintCaps();
        paintCaptureBtn();
        saveShortcut();
      });

      paintCaps();
      paintCaptureBtn();
    },

    "tis-hub"() {
      const backHome = $pane("#backHome");
      if (backHome) backHome.onclick = () => showPane("repo");

      const input = $pane(".tis-hub .keyword input");
      const btn = $pane("#search-tishub");
      if (input) {
        input.value = state.tisHubInput;
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") searchFun();
        });
        input.addEventListener("input", () => {
          state.tisHubInput = input.value;
        });
      }
      if (btn) btn.onclick = () => searchFun();

      // 分段控件（已安装 / 市场订阅）恢复选中态 + 切换时重新搜索
      const radios = document.querySelectorAll(
        '#ms-config-view input[name="search-type"]'
      );
      radios.forEach((radio) => {
        radio.checked = radio.value === state.tisHubMode;
        radio.addEventListener("change", function () {
          if (!this.checked) return;
          state.tisHubMode = this.value;
          syncSegmented();
          searchFun();
        });
      });
      syncSegmented();

      // 结果区事件委托（安装 / 移除 / 外链）
      const resultList = $pane(".tis-hub .result-list");
      if (resultList) resultList.addEventListener("click", onResultClick);

      // 首次进入或数据变动后，重新跑一次搜索
      searchFun();
    },
  };

  /** 将 state 里的数据传给面板模板（面板不保活，每次渲染都要带上） */
  function paneData(pane) {
    return pane === "tags" ? state.tagChecked : undefined;
  }

  /** 渲染指定面板并绑定事件 */
  function showPane(pane = "subscribes", navPane = pane) {
    // 离开订阅管理面板前先把编辑收回 state，避免未保存内容丢失
    stashSubscribeDraft();
    // 离开旧面板前的清理：快捷键录入监听器挂在 document 上，不随 DOM 销毁，
    // 必须显式移除并复位录入态（否则全局 Esc 关窗会被残留的 shortcutCapturing 拦截）
    if (paneDispose) {
      paneDispose();
      paneDispose = null;
    }
    currentPane = pane;

    setPane(pane, navPane, paneData(pane));

    const bind = paneBinders[pane];
    if (bind) bind();
  }

  // ---------- 订阅总览：条块操作 ----------
  /** 条块列表点击（事件委托）：打开 / 编辑 / 删除 / 行内编辑确定取消 */
  async function onSubListClick(e) {
    const btn = e.target.closest(".sub-op");
    if (!btn) return;
    const itemEl = btn.closest(".sub-item");
    if (!itemEl) return;
    const index = Number(itemEl.dataset.index);
    const items = parseSubscribeItems();
    const item = items.find((it) => it.index === index);
    if (!item) return;
    const act = btn.dataset.act;

    if (act === "open") {
      if (item.url) openExternal(item.url);
      return;
    }
    if (act === "edit") {
      state.subEditIndex = index;
      state.subAddOpen = false;
      renderSubList();
      return;
    }
    if (act === "cancel-edit") {
      state.subEditIndex = null;
      renderSubList();
      return;
    }
    if (act === "save-edit") {
      const row = itemEl;
      const name = row.querySelector(".sub-edit-name")?.value.trim() ?? "";
      const describe = row.querySelector(".sub-edit-describe")?.value.trim() ?? "";
      const url = row.querySelector(".sub-edit-url")?.value.trim() ?? "";
      if (!url) {
        showTip("订阅地址不能为空。", "error");
        return;
      }
      // 重建这一条：保留其它未知属性，仅更新 title / describe / 地址
      const meta = parseAllDesignatedSingTags(item.body, "tis")[0] || {};
      const { tabName, tabValue, title, describe: _oldDescribe, ...rest } = meta;
      const next = [...items];
      next[index] = {
        ...item,
        url,
        name: name || url,
        describe,
        body: rebuildTags([{ tabName: "tis", tabValue: url, ...rest, ...(name ? { title: name } : {}), ...(describe ? { describe } : {}) }]),
      };
      state.subEditIndex = null;
      writeSubscribeItems(next);
      refreshSubscribeText();
      showTip("订阅已更新。", "ok");
      return;
    }
    if (act === "remove") {
      if (!(await confirmMessage(`确定删除订阅「${item.name}」吗？`))) return;
      const next = items.filter((it) => it.index !== index);
      state.subEditIndex = null;
      writeSubscribeItems(next);
      refreshSubscribeText();
      showTip("订阅已删除。", "ok");
      return;
    }
  }

  /** 添加订阅区域点击：展开 / 收起 / 确认添加 */
  function onSubAddClick(e) {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    const addWrap = document.querySelector("#ms-config-view .sub-add-wrap");
    if (!addWrap) return;

    if (act === "open-add") {
      state.subAddOpen = true;
      state.subEditIndex = null;
      renderSubList();
      return;
    }
    if (act === "close-add") {
      state.subAddOpen = false;
      renderSubList();
      return;
    }
    if (act === "confirm-add") {
      const url = addWrap.querySelector(".sub-add-url")?.value.trim() ?? "";
      const name = addWrap.querySelector(".sub-add-name")?.value.trim() ?? "";
      const describe = addWrap.querySelector(".sub-add-describe")?.value.trim() ?? "";
      if (!url) {
        showTip("请先填写订阅地址。", "error");
        return;
      }
      const items = parseSubscribeItems();
      if (items.some((it) => it.url === url)) {
        showTip("该订阅已存在（地址重复）。", "error");
        return;
      }
      const attrs = {};
      if (name) attrs.title = name;
      if (describe) attrs.describe = describe;
      const body = rebuildTags([{ tabName: "tis", tabValue: url, ...attrs }]);
      state.subAddOpen = false;
      state.subEditIndex = null;
      writeSubscribeItems([...items, { index: items.length, url, name: name || url, describe, body }]);
      refreshSubscribeText();
      showTip("订阅已添加。", "ok");
    }
  }

  // ---------- 关注标签 chip 选中态（与 :has() 双保险） ----------
  function syncChips() {
    document.querySelectorAll("#ms-config-view .tag-chip").forEach((chip) => {
      const cb = chip.querySelector("input");
      chip.classList.toggle("on", cb.checked);
    });
  }

  function syncSegmented() {
    document
      .querySelectorAll("#ms-config-view .search-type.segmented label")
      .forEach((l) => l.classList.toggle("on", l.querySelector("input").checked));
  }

  // ---------- 订阅市场 ----------
  function stateAsName(tisState) {
    return (
      (tisState === "disable" && "移除（未启用）") ||
      (tisState === "enable" && "移除") ||
      "安装"
    );
  }

  /** 当前列表结果（供安装/移除时取到完整 tis 文本） */
  let currentResultList = [];

  const searchFun = async function () {
    const input = $pane(".tis-hub .keyword input");
    const resultElement = $pane(".tis-hub .result-list > .list-rol");
    if (!resultElement) return; // 面板已被切走

    const keyword = ((input && input.value) || state.tisHubInput || "").trim();
    state.tisHubInput = keyword;
    let resultTisList = installedList.filter(
      (item) => keyword === "" || item.name.includes(keyword)
    );
    resultElement.innerHTML = '<div class="loading">加载中…</div>';

    if (state.tisHubMode === "market") {
      try {
        const marketResult = (await TisHub.getClosedIssuesTis({ keyword })).map((hubTisInfo) => ({
          name: hubTisInfo.title,
          describe: hubTisInfo.describe,
          body: hubTisInfo.tisList.join("\n") || "",
          state: "installable",
        }));
        const installedMap = installedList.reduce((map, item) => {
          map[item.name] = item;
          return map;
        }, {});
        resultTisList = marketResult;
        resultTisList.forEach((hubTis) => {
          if (installedMap[hubTis.name]) hubTis.state = installedMap[hubTis.name].state;
        });
      } catch (e) {
        resultElement.innerHTML = `<div class="loading">市场订阅加载失败：${escapeHtml(
          e.message
        )}</div>`;
        return;
      }
    }

    resultElement.innerHTML = "";
    if (resultTisList.length === 0) {
      // 无内容：什么都不显示（不出现「没有找到相关订阅」提示）
      currentResultList = [];
      return;
    }
    currentResultList = resultTisList;

    for (const tis of resultTisList) {
      const tisMetaInfo = parseAllDesignatedSingTags(String(tis.body || ""), "tis")[0] || {};
      const item = document.createElement("div");
      item.className = "hub-tis";
      item.innerHTML = `
        <div class="tis-info">
          <a class="title" href="${escapeAttr(tisMetaInfo.tabValue || TISHUB_REPO)}" data-ext="${escapeAttr(
        tisMetaInfo.tabValue || ""
      )}" target="_blank">${escapeHtml(tis.name)}</a>
          <span class="describe">${escapeHtml(
            tisMetaInfo.describe ||
              tis.describe ||
              "订阅没有描述信息，请确认订阅安全或信任后再安装！"
          )}</span>
        </div>
        <button class="tis-button" data-name="${escapeAttr(tis.name)}">${stateAsName(
        tis.state
      )}</button>
      `;
      resultElement.appendChild(item);
    }
  };

  /** 结果区事件委托：安装/移除 + 外链 */
  function onResultClick(e) {
    const extLink = e.target.closest("a[data-ext]");
    if (extLink) {
      e.preventDefault();
      const url = extLink.dataset.ext;
      if (url) openExternal(url);
      return;
    }
    const button = e.target.closest(".tis-button");
    if (!button) return;
    const tisName = button.dataset.name;
    const installed = installedList.find((item) => item.name === tisName);
    const fromList = currentResultList.find((item) => item.name === tisName);
    if (installed != null) {
      // 移除
      removeSubscribeFromText(installed.body);
      installedList = installedList.filter((item) => item.name !== tisName);
      if (fromList) fromList.state = "installable";
      button.textContent = stateAsName("installable");
    } else {
      // 安装
      const marketTis = fromList || { name: tisName, body: ``, state: "installable" };
      if (!marketTis.body) {
        showTip("该订阅内容为空，无法安装。", "error");
        return;
      }
      appendSubscribeToText(marketTis.body);
      marketTis.state = "enable";
      installedList.unshift(marketTis);
      button.textContent = stateAsName(marketTis.state);
    }
    persistInstalled();
    showTip("订阅已更新，主窗口会自动重新加载。", "ok");
  }

  // ---------- 提交我的订阅到 TisHub 公共仓库 ----------
  async function onPushTis() {
    if (!(await confirmMessage("是否确认要提交到TisHub公共仓库？"))) return;
    if (commitableTisList == null || commitableTisList.length === 0) {
      await alertMessage("经过与TisHub中订阅的比较，本地没有可提交的订阅！");
      return;
    }
    const token = await GithubAPI.requestToken();
    if (token == null) {
      await alertMessage("获取token失败，无法继续！");
      return;
    }
    try {
      const userInfo = await GithubAPI.getUserInfo();
      if (userInfo == null) throw new Error("请检查网络或提交的Token不可用！");
      for (const singleTisText of commitableTisList) {
        const tisMetaInfo = parseAllDesignatedSingTags(String(singleTisText), "tis")[0];
        if (tisMetaInfo == null) continue;
        await GithubAPI.commitIssues({
          title: tisMetaInfo.title || `${userInfo.name}的订阅`,
          body: singleTisText,
        });
      }
      await alertMessage("提交成功(issues)！感谢您的参与，脚本因你而更加精彩。");
      refreshViewState();
    } catch (e) {
      await alertMessage(`提交异常！原因：${e.message}`);
    }
  }

  // ---------- 订阅原文输入（防抖刷新可提交数） ----------
  const refreshSubscribeText = debounce(() => refreshViewState(), 300);

  /** 把底栏的「保存并应用」图标按钮接到保存逻辑（底栏常驻，只绑一次） */
  function bindPaneSaveButton() {
    const btn = $('#ms-config-view .cfg-footer button[data-role="save"]');
    if (btn) btn.addEventListener("click", onSaveAndApply);
  }

  // ---------- 关闭 ----------
  function configViewClose() {
    closeWindow();
  }

  // ---------- 保存并应用 ----------
  function onSaveAndApply() {
    stashSubscribeDraft();
    // 关注标签若已挂载，以面板为准；否则用 state 里保留的勾选态
    saveTagChecked();
    const validCount = commitSubscribeDraft();

    showTip(`保存配置成功！有效订阅数：${validCount}。主窗口会自动重新加载。`, "ok");
    // 重新判断已安装状态
    installedList = loadInstalledList();
    persistInstalled();
    refreshViewState();
    // 保存后保持窗口打开，由用户手动关闭（Esc / 右上角关闭）
  }

  // ---------- 左侧导航：切换右侧内容面板 ----------
  $(".cfg-nav .nav-item", true).forEach((btn) => {
    btn.addEventListener("click", () => showPane(btn.dataset.pane));
  });

  // ---------- 底栏（页面层）：保存并应用 ----------
  bindPaneSaveButton();

  // ---------- 外链统一交给系统浏览器（顶栏等常驻区域） ----------
  document.querySelectorAll("#ms-config-view a[data-ext]").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      if (a.dataset.ext) openExternal(a.dataset.ext);
    });
  });

  // ---------- Esc 关闭；token 弹窗相关 ----------
  // 「快捷键设置」录入态时按键被录入逻辑独占（见 paneBinders.shortcut 的
  // shortcutCapturing 标志），这里的 Esc=关窗等行为全部让路。
  document.addEventListener("keydown", (e) => {
    if (shortcutCapturing) return;
    // 确认/提示弹窗优先：Esc=取消，Enter=确定（与原生 confirm 行为一致）
    const msgOverlay = document.getElementById("msgOverlay");
    if (msgOverlay && msgOverlay.classList.contains("show")) {
      if (e.key === "Escape") closeMessage(false);
      if (e.key === "Enter") closeMessage(true);
      return;
    }
    const overlay = document.getElementById("tokenOverlay");
    if (overlay && overlay.classList.contains("show")) {
      if (e.key === "Escape") closeAskToken(null);
      if (e.key === "Enter") closeAskToken(document.getElementById("tokenInput").value.trim());
      return;
    }
    if (e.key === "Escape") configViewClose();
  });
  document.getElementById("tokenOk").addEventListener("click", () =>
    closeAskToken(document.getElementById("tokenInput").value.trim())
  );
  document.getElementById("tokenCancel").addEventListener("click", () => closeAskToken(null));
  document.getElementById("msgOk").addEventListener("click", () => closeMessage(true));
  document.getElementById("msgCancel").addEventListener("click", () => closeMessage(false));

  // ---------- 窗口重获焦点：外部数据可能已变，按需重渲染当前面板 ----------
  /**
   * 面板不保活，所以「外部改了缓存」不会自动反映。
   * 重获焦点时检查一遍，只有真的变了才重渲染（避免无谓闪烁）；
   * 有未保存改动时绝不覆盖用户编辑。
   */
  function refreshPaneIfStale() {
    if (currentPane === "cache") {
      // 缓存占用随时可能变，直接重算
      renderCachePanel(state.subscribeDraft);
      return;
    }

    if (currentPane === "tags") {
      const signature = tagsSignature();
      // 数据没变：不要重渲染（会白闪一下，也浪费）
      if (signature === state.tagsSignature) return;
      // 签名变了就重渲染（可能是新增标签，也可能只是计数变了；计数也显示在胶囊上）。
      // loadTagChecked 是合并语义，未保存的勾选仍会保留。
      state.tagsSignature = signature;
      loadTagChecked();
      showPane("tags");
      return;
    }

    if (currentPane === "tis-hub") {
      // 市场结果依赖网络，回到窗口时重跑一次
      searchFun();
      return;
    }

    if (currentPane === "repo") {
      refreshViewState();
    }
  }

  // ---------- 缓存面板的倒计时：离开面板/窗口隐藏时停掉（避免后台空转） ----------
  // 注意：切到其它面板时面板 DOM 被整体替换，paintCacheCountdown 找不到节点会自行停掉；
  // 这里额外处理窗口隐藏（最小化/关闭），让定时器没有必要地在后台跑。
  window.addEventListener("blur", stopCacheCountdown);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopCacheCountdown();
    else if (currentPane === "cache") startCacheCountdown();
  });

  // Tauri：监听窗口焦点变化；浏览器调试时退化为 window focus 事件
  if (isTauri) {
    import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => {
        const win = getCurrentWindow();
        win.onFocusChanged(({ payload: focused }) => {
          if (focused) refreshPaneIfStale();
          else stopCacheCountdown();
        });
      })
      .catch(() => {});
  } else {
    window.addEventListener("focus", refreshPaneIfStale);
  }

  // ---------- 初始化 ----------
  state.subscribeDraft = getSubscribe();
  state.tagsSignature = tagsSignature();
  loadTagChecked();
  installedList = loadInstalledList();
  showPane(currentPane);
  // 注意：这里不调 refreshViewState()——它会发一次 GitHub 网络请求，
  // 而「可提交数 / Token 状态」只在公共仓库面板可见，进入该面板时 paneBinders.repo
  // 会自己刷新。默认停在订阅管理面板时没必要联网。
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

// ========== 启动 ==========
async function bootstrap() {
  // 首次运行：写入默认订阅原文（并兼容旧版数组）
  const saved = storageGet(SUBSCRIBES_KEY, null);
  if (Array.isArray(saved)) {
    storageSet(SUBSCRIBES_KEY, subscribeItemsToText(saved));
  } else if (typeof saved !== "string" || saved.trim() === "") {
    try {
      const defaults = await getDefaultSubscribeText();
      storageSet(SUBSCRIBES_KEY, defaults);
    } catch (e) {
      console.warn("获取默认订阅失败:", e);
    }
  }
  // 快捷键当前生效值从后端读取（浏览器调试时回退默认值）；
  // 在 renderApp 之前 await，避免「快捷键设置」面板先渲染默认值再跳变
  try {
    toggleShortcutSaved = await getToggleShortcut();
  } catch (e) {
    console.warn("读取快捷键设置失败:", e);
  }
  renderApp();
  initInteractions();
}

// 配置窗口的 html/body 需要可滚动 + 可选中文本（覆盖共享样式）
document.documentElement.classList.add("ms-config-root");
document.body.classList.add("ms-config-body");

bootstrap();
