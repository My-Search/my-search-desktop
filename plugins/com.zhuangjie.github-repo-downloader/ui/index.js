/**
 * GitHub 仓库搜索与批量下载器 —— 前端入口
 *
 * 宿主注入: ms / env / plugin / host / keyword / inputValue / onSubKeyword / md2html / openExternal
 *
 * 分工：
 *   - 搜索、Token、下载全部由插件自带的 Node 后端完成（JSON-RPC over stdio）；
 *   - 前端只做 UI、筛选拼接、文件夹选择、进度展示；
 *   - Token 不进入前端存储，只保存在插件数据目录。
 *
 * 交互约定：
 *   - 结果只展示仓库，不展示代码/文件；
 *   - 勾选可以跨分页保留，新的搜索会清空选择；
 *   - 「下载」先选目标文件夹，再选压缩格式与打包方式；
 *   - 关闭下载弹窗不会中断后台任务，底栏仍显示进度，可随时点开。
 */
(function (ms, env, plugin, host, keyword, inputValue, onSubKeyword, md2html, openExternal) {
  "use strict";

  var rootEl = document.getElementById("app");
  if (!rootEl) return;

  // ===================== DOM =====================
  function $id(id) {
    return document.getElementById(id);
  }

  var dom = {
    app: rootEl,
    authBtn: $id("gh-auth-btn"),
    authDot: $id("gh-auth-dot"),
    authText: $id("gh-auth-text"),
    rate: $id("gh-rate"),
    settings: $id("gh-settings"),
    q: $id("gh-q"),
    clearQ: $id("gh-clear-q"),
    search: $id("gh-search"),
    filterToggle: $id("gh-filter-toggle"),
    filterDot: $id("gh-filter-dot"),
    language: $id("gh-language"),
    stars: $id("gh-stars"),
    updated: $id("gh-updated"),
    sort: $id("gh-sort"),
    forks: $id("gh-forks"),
    archived: $id("gh-archived"),
    advanced: $id("gh-advanced"),
    scope: $id("gh-scope"),
    owner: $id("gh-owner"),
    topic: $id("gh-topic"),
    license: $id("gh-license"),
    ownerType: $id("gh-ownertype"),
    perPage: $id("gh-perpage"),
    applyFilters: $id("gh-apply-filters"),
    meta: $id("gh-meta"),
    metaCount: $id("gh-meta-count"),
    metaExtra: $id("gh-meta-extra"),
    metaRate: $id("gh-meta-rate"),
    list: $id("gh-list"),
    empty: $id("gh-empty"),
    selectAll: $id("gh-selectall"),
    selectedCount: $id("gh-selected-count"),
    clearSelection: $id("gh-clear-selection"),
    footHint: $id("gh-foot-hint"),
    download: $id("gh-download"),
    downloadText: $id("gh-download-text"),
    downloadModal: $id("gh-download-modal"),
    dlTitle: $id("gh-dl-title"),
    dlSetup: $id("gh-dl-setup"),
    dlSummary: $id("gh-dl-summary"),
    destPath: $id("gh-dest-path"),
    pickFolder: $id("gh-pick-folder"),
    subfolder: $id("gh-subfolder"),
    subfolderName: $id("gh-subfolder-name"),
    mergeNone: $id("gh-merge-none"),
    mergeOne: $id("gh-merge-one"),
    formatZip: $id("gh-format-zip"),
    formatTar: $id("gh-format-tar"),
    mergeHint: $id("gh-merge-hint"),
    separateName: $id("gh-separate-name"),
    bundleWrap: $id("gh-bundle-name"),
    template: $id("gh-template"),
    templatePreview: $id("gh-template-preview"),
    bundle: $id("gh-bundle"),
    dlError: $id("gh-dl-error"),
    dlProgress: $id("gh-dl-progress"),
    progPercent: $id("gh-prog-percent"),
    progSub: $id("gh-prog-sub"),
    progSpeed: $id("gh-prog-speed"),
    progTrack: $id("gh-prog-track"),
    progBar: $id("gh-prog-bar"),
    progNote: $id("gh-prog-note"),
    progList: $id("gh-prog-list"),
    dlFootSetup: $id("gh-dl-foot-setup"),
    dlFootProgress: $id("gh-dl-foot-progress"),
    dlStart: $id("gh-dl-start"),
    dlCancel: $id("gh-dl-cancel"),
    dlOpen: $id("gh-dl-open"),
    dlFinish: $id("gh-dl-finish"),
    settingsModal: $id("gh-settings-modal"),
    token: $id("gh-token"),
    tokenBadge: $id("gh-token-badge"),
    tokenStatus: $id("gh-token-status"),
    tokenTest: $id("gh-token-test"),
    tokenSave: $id("gh-token-save"),
    tokenClear: $id("gh-token-clear"),
    apiBase: $id("gh-apibase"),
    proxy: $id("gh-proxy"),
    networkSave: $id("gh-network-save")
  };

  if (!dom.q || !dom.list || !dom.downloadModal) {
    // 页面结构不完整时不要继续绑定事件，避免半残状态。
    return;
  }

  // ===================== 常量 =====================
  var PREFS_KEY = "prefs";
  var FEED_KEY = "lastFeed";
  var MAX_REPOS = 100;
  var SEARCH_LIMIT = 1000;

  var LANG_COLORS = {
    JavaScript: "#f1e05a",
    TypeScript: "#3178c6",
    Python: "#3572A5",
    Java: "#b07219",
    Go: "#00ADD8",
    Rust: "#dea584",
    C: "#555555",
    "C++": "#f34b7d",
    "C#": "#178600",
    PHP: "#4F5D95",
    Ruby: "#701516",
    Swift: "#F05138",
    Kotlin: "#A97BFF",
    Shell: "#89e051",
    HTML: "#e34c26",
    CSS: "#563d7c",
    Vue: "#41b883",
    "Jupyter Notebook": "#DA5B0B",
    Dart: "#00B4AB",
    Lua: "#000080",
    Scala: "#c22d40",
    Haskell: "#5e5086",
    Elixir: "#6e4a7e"
  };

  var ICON_STAR =
    '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.6l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z"/></svg>';
  var ICON_FORK =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="4" cy="3.4" r="1.7"/><circle cx="12" cy="3.4" r="1.7"/><circle cx="8" cy="12.6" r="1.7"/><path d="M4 5.1v1.3a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2V5.1M8 8.4v2.5"/></svg>';
  var ICON_EXTERNAL =
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.4 3H3.4A1.4 1.4 0 0 0 2 4.4v8.2A1.4 1.4 0 0 0 3.4 14h8.2a1.4 1.4 0 0 0 1.4-1.4v-3"/><path d="M9.3 2H14v4.7M13.6 2.4 7.4 8.6"/></svg>';

  // ===================== 状态 =====================
  function defaultFilters() {
    return {
      language: "",
      stars: "",
      updated: "",
      sort: "best",
      forks: false,
      archived: false,
      scope: "",
      owner: "",
      topic: "",
      license: "",
      ownerType: "user",
      perPage: 30
    };
  }

  function defaultDl() {
    return {
      dest: "",
      format: "zip",
      merge: false,
      subfolder: false,
      subfolderName: "",
      template: "{owner}--{repo}",
      bundleName: ""
    };
  }

  var state = {
    text: "",
    activeQuery: "",
    filters: defaultFilters(),
    dl: defaultDl(),
    items: [],
    selected: new Map(),
    page: 0,
    totalCount: 0,
    hasMore: false,
    searched: false,
    searching: false,
    incomplete: false,
    cached: false,
    fromCache: false,
    error: "",
    rate: null,
    config: null,
    backendError: "",
    job: null,
    jobId: "",
    jobStarting: false,
    jobError: "",
    finishedNotified: false,
    jobPollTimer: 0,
    jobPollFails: 0,
    reqSeq: 0,
    disposed: false
  };

  var prefsTimer = 0;
  var feedTimer = 0;
  var searchTimer = 0;
  var notificationOffs = [];

  // ===================== 基础工具 =====================
  function alive() {
    return !state.disposed && rootEl && rootEl.isConnected !== false;
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function errText(err) {
    var msg = "";
    if (err && typeof err === "object" && "message" in err) msg = String(err.message || "");
    else msg = String(err == null ? "" : err);
    msg = msg.replace(/^Error:\s*/i, "").trim();
    return msg || "未知错误";
  }

  function shortText(text, max) {
    var s = String(text == null ? "" : text);
    max = max || 180;
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  }

  function toast(text, type) {
    try {
      if (ms.ui && typeof ms.ui.toast === "function") {
        ms.ui.toast(String(text == null ? "" : text), type === "error" ? "error" : "ok");
        return;
      }
    } catch (e) {
      /* ignore */
    }
  }

  function askConfirm(text) {
    try {
      if (ms.ui && typeof ms.ui.confirm === "function") {
        return Promise.resolve(ms.ui.confirm(String(text == null ? "" : text)));
      }
    } catch (e) {
      /* fall through */
    }
    try {
      return Promise.resolve(window.confirm(String(text == null ? "" : text)));
    } catch (e) {
      return Promise.resolve(false);
    }
  }

  function storeGet(key, fallback) {
    try {
      if (ms.store && typeof ms.store.get === "function") {
        var v = ms.store.get(key, fallback);
        return v === undefined ? fallback : v;
      }
    } catch (e) {
      /* ignore */
    }
    return fallback;
  }

  function storeSet(key, value) {
    try {
      if (ms.store && typeof ms.store.set === "function") ms.store.set(key, value);
    } catch (e) {
      /* ignore */
    }
  }

  function backendCall(method, params) {
    if (!ms.backend || typeof ms.backend.call !== "function") {
      return Promise.reject(new Error("当前宿主未提供插件后端能力，请升级「我的搜索」"));
    }
    try {
      return Promise.resolve(ms.backend.call(method, params == null ? {} : params));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  function fmtNum(n) {
    var v = Number(n) || 0;
    try {
      return v.toLocaleString("zh-CN");
    } catch (e) {
      return String(v);
    }
  }

  function fmtBytes(bytes) {
    var n = Number(bytes);
    if (!isFinite(n) || n <= 0) return "0 B";
    if (n < 1024) return Math.round(n) + " B";
    var units = ["KB", "MB", "GB", "TB"];
    var i = -1;
    do {
      n /= 1024;
      i++;
    } while (n >= 1024 && i < units.length - 1);
    var digits = n >= 100 ? 0 : n >= 10 ? 1 : 2;
    return n.toFixed(digits).replace(/\.0+$/, "") + " " + units[i];
  }

  function fmtSpeed(bytesPerSec) {
    var n = Number(bytesPerSec);
    if (!isFinite(n) || n <= 0) return "—";
    return fmtBytes(n) + "/s";
  }

  function fmtEta(sec) {
    var n = Number(sec);
    if (!isFinite(n) || n < 0) return "剩余时间未知";
    if (n < 60) return n + " 秒";
    if (n < 3600) return Math.ceil(n / 60) + " 分钟";
    var h = Math.floor(n / 3600);
    var m = Math.ceil((n % 3600) / 60);
    return h + " 小时" + (m ? " " + m + " 分钟" : "");
  }

  function fmtDuration(sec) {
    var n = Math.max(0, Math.round(Number(sec) || 0));
    if (n < 60) return n + " 秒";
    if (n < 3600) return Math.floor(n / 60) + " 分 " + (n % 60) + " 秒";
    return Math.floor(n / 3600) + " 小时 " + Math.floor((n % 3600) / 60) + " 分";
  }

  function parseIso(value) {
    var t = Date.parse(String(value || ""));
    return isFinite(t) ? t : 0;
  }

  function relativeTime(iso) {
    var t = parseIso(iso);
    if (!t) return "";
    var diff = (Date.now() - t) / 1000;
    if (diff < 0) return "刚刚";
    if (diff < 60) return "刚刚";
    if (diff < 3600) return Math.floor(diff / 60) + " 分钟前";
    if (diff < 86400) return Math.floor(diff / 3600) + " 小时前";
    if (diff < 2592000) return Math.floor(diff / 86400) + " 天前";
    if (diff < 31536000) return Math.floor(diff / 2592000) + " 个月前";
    return Math.floor(diff / 31536000) + " 年前";
  }

  function fullDate(iso) {
    var t = parseIso(iso);
    if (!t) return "";
    try {
      return new Date(t).toLocaleString("zh-CN", { hour12: false });
    } catch (e) {
      return new Date(t).toISOString();
    }
  }

  function localStamp() {
    var d = new Date();
    var pad = function (n) {
      return String(n).padStart(2, "0");
    };
    return {
      date: d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()),
      time: pad(d.getHours()) + pad(d.getMinutes())
    };
  }

  function defaultBundleName() {
    return "github-repos-" + localStamp().date;
  }

  function defaultSubfolderName() {
    return defaultBundleName();
  }

  function setSelectValue(sel, value) {
    if (!sel) return;
    var v = String(value == null ? "" : value);
    var found = false;
    for (var i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === v) {
        found = true;
        break;
      }
    }
    if (!found && v) {
      var opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v;
      sel.appendChild(opt);
    }
    sel.value = v;
  }

  // ===================== 偏好与缓存 =====================
  function loadPrefs() {
    var saved = storeGet(PREFS_KEY, null);
    if (!saved || typeof saved !== "object") return;
    var sf = saved.filters && typeof saved.filters === "object" ? saved.filters : {};
    var sd = saved.dl && typeof saved.dl === "object" ? saved.dl : {};
    var f = defaultFilters();
    var d = defaultDl();

    Object.keys(f).forEach(function (key) {
      if (key in sf && typeof sf[key] === typeof f[key]) f[key] = sf[key];
    });
    Object.keys(d).forEach(function (key) {
      if (key in sd && typeof sd[key] === typeof d[key]) d[key] = sd[key];
    });

    f.perPage = [30, 50, 100].indexOf(Number(f.perPage)) >= 0 ? Number(f.perPage) : 30;
    if (["best", "stars", "forks", "updated", "help-wanted-issues"].indexOf(String(f.sort)) < 0) f.sort = "best";
    if (f.ownerType !== "org") f.ownerType = "user";
    if (d.format !== "tar.gz") d.format = "zip";
    if (d.merge) d.format = "zip";
    state.filters = f;
    state.dl = d;
  }

  function savePrefs() {
    storeSet(PREFS_KEY, { filters: state.filters, dl: state.dl });
  }

  function savePrefsSoon() {
    clearTimeout(prefsTimer);
    prefsTimer = setTimeout(function () {
      savePrefs();
    }, 500);
  }

  function saveLastFeed() {
    if (!state.searched) return;
    var seq = state.reqSeq;
    var perPage = Number(state.filters.perPage) || 30;
    var snapshot = {
      at: Date.now(),
      text: state.text,
      query: state.activeQuery,
      perPage: perPage,
      filters: Object.assign({}, state.filters),
      items: state.items.slice(0, perPage),
      totalCount: state.totalCount,
      page: 1,
      hasMore: state.totalCount > Math.min(state.items.length, perPage),
      rate: state.rate
    };
    clearTimeout(feedTimer);
    feedTimer = setTimeout(function () {
      // 250ms 内如果又发起了新搜索/加载更多，旧快照已经过期，不能落盘
      if (state.disposed || !state.searched || state.reqSeq !== seq) return;
      storeSet(FEED_KEY, snapshot);
    }, 250);
  }

  /** 缓存结果必须和当前筛选条件完全一致，否则会把上一轮别的筛选结果当成这一轮 */
  function filtersEqual(a, b) {
    if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
    var keys = Object.keys(defaultFilters());
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (String(a[k] == null ? "" : a[k]) !== String(b[k] == null ? "" : b[k])) return false;
    }
    return true;
  }

  function loadLastFeed() {
    var feed = storeGet(FEED_KEY, null);
    if (!feed || typeof feed !== "object" || !Array.isArray(feed.items)) return false;
    var age = Date.now() - (Number(feed.at) || 0);
    if (age <= 0 || age > 7 * 24 * 60 * 60 * 1000) return false;
    var perPage = Number(feed.perPage) || 30;
    if (perPage !== Number(state.filters.perPage)) return false;
    if (!filtersEqual(feed.filters, state.filters)) return false;

    var items = feed.items.map(normalizeItem).filter(Boolean);
    state.items = items;
    state.totalCount = Math.max(0, Number(feed.totalCount) || items.length);
    state.page = 1;
    state.hasMore = feed.hasMore !== false && state.totalCount > items.length;
    state.text = String(feed.text || "");
    state.activeQuery = String(feed.query || "");
    state.searched = true;
    state.fromCache = true;
    state.error = "";
    if (feed.rate && typeof feed.rate === "object") state.rate = feed.rate;

    dom.q.value = state.text;
    updateClearButton();
    return true;
  }

  // ===================== 查询拼接 =====================
  function hasQualifier(text, names) {
    var s = " " + String(text || "").toLowerCase() + " ";
    for (var i = 0; i < names.length; i++) {
      if (s.indexOf(" " + names[i] + ":") >= 0) return true;
    }
    return false;
  }

  function qualifierValue(value) {
    var v = String(value == null ? "" : value).trim().replace(/"/g, "");
    if (!v) return "";
    return /\s/.test(v) ? '"' + v + '"' : v;
  }

  function isoDaysAgo(days) {
    var d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - (Number(days) || 0));
    var pad = function (n) {
      return String(n).padStart(2, "0");
    };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function buildQuery() {
    var text = String(state.text || "").trim();
    var f = state.filters;
    var parts = [];
    if (text) parts.push(text);
    if (text && f.scope) parts.push("in:" + f.scope);
    if (f.language && !hasQualifier(text, ["language", "lang"])) parts.push("language:" + qualifierValue(f.language));
    if (/^\d+$/.test(String(f.stars)) && !hasQualifier(text, ["stars"])) parts.push("stars:>=" + f.stars);
    if (/^\d+$/.test(String(f.updated)) && !hasQualifier(text, ["pushed", "created", "updated"])) {
      parts.push("pushed:>=" + isoDaysAgo(Number(f.updated)));
    }
    if (f.owner) {
      if (f.ownerType === "org") {
        if (!hasQualifier(text, ["org"])) parts.push("org:" + qualifierValue(f.owner));
      } else if (!hasQualifier(text, ["user"])) {
        parts.push("user:" + qualifierValue(f.owner));
      }
    }
    if (f.topic && !hasQualifier(text, ["topic"])) parts.push("topic:" + qualifierValue(f.topic));
    if (f.license && !hasQualifier(text, ["license"])) parts.push("license:" + qualifierValue(f.license));
    if (!hasQualifier(text, ["fork"])) parts.push(f.forks ? "fork:true" : "fork:false");
    if (!f.archived && !hasQualifier(text, ["archived"])) parts.push("archived:false");
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  function canSearch() {
    if (String(state.text || "").trim()) return true;
    var f = state.filters;
    return !!(f.language || f.stars || f.updated || f.owner || f.topic || f.license);
  }

  function apiSort() {
    return state.filters.sort === "best" ? "" : state.filters.sort;
  }

  // ===================== 数据结构 =====================
  function normalizeItem(raw) {
    if (!raw || typeof raw !== "object") return null;
    var full = String(raw.fullName || "");
    var parts = full.split("/");
    var owner = String(raw.owner || parts[0] || "").trim();
    var repo = String(raw.repo || parts[1] || "").trim();
    if (!owner || !repo) return null;
    return {
      fullName: full || owner + "/" + repo,
      owner: owner,
      repo: repo,
      private: raw.private === true,
      fork: raw.fork === true,
      archived: raw.archived === true,
      isTemplate: raw.isTemplate === true,
      description: String(raw.description || ""),
      language: String(raw.language || ""),
      stars: Number(raw.stars) || 0,
      forks: Number(raw.forks) || 0,
      license: String(raw.license || ""),
      updatedAt: String(raw.updatedAt || ""),
      pushedAt: String(raw.pushedAt || ""),
      defaultBranch: String(raw.defaultBranch || ""),
      htmlUrl: String(raw.htmlUrl || ""),
      size: Math.max(0, Number(raw.size) || 0),
      topics: Array.isArray(raw.topics) ? raw.topics.slice(0, 6).map(String) : []
    };
  }

  function firstSelected() {
    var found = null;
    state.selected.forEach(function (item) {
      if (!found) found = item;
    });
    return found;
  }

  // ===================== 渲染：结果 =====================
  function badgesHtml(item) {
    var out = "";
    if (item.private) out += '<span class="gh-badge gh-badge-private">私有</span>';
    if (item.archived) out += '<span class="gh-badge gh-badge-archived">已归档</span>';
    if (item.fork) out += '<span class="gh-badge gh-badge-fork">Fork</span>';
    if (item.isTemplate) out += '<span class="gh-badge gh-badge-template">模板</span>';
    return out;
  }

  function langHtml(lang) {
    if (!lang) return "";
    var color = LANG_COLORS[lang] || "#8b949e";
    return '<span class="gh-lang"><i style="background:' + esc(color) + '"></i>' + esc(lang) + "</span>";
  }

  function repoCardHtml(item, index) {
    var selected = state.selected.has(item.fullName);
    var desc = item.description ? esc(item.description) : "暂无描述";
    var updated = relativeTime(item.pushedAt || item.updatedAt);
    var updatedTitle = fullDate(item.pushedAt || item.updatedAt);
    var topics = item.topics.slice(0, 3).map(function (t) {
      return '<span class="gh-topic">' + esc(t) + "</span>";
    });
    if (item.topics.length > 3) topics.push('<span class="gh-topic">+' + (item.topics.length - 3) + "</span>");
    var license = item.license ? '<span class="gh-stat" title="许可证">' + esc(item.license) + "</span>" : "";
    var size = item.size > 0 ? '<span class="gh-stat" title="仓库体积（未压缩）">' + esc(fmtBytes(item.size * 1024)) + "</span>" : "";

    return (
      '<div class="gh-repo' + (selected ? " is-selected" : "") + '" data-index="' + index + '" data-full="' + esc(item.fullName) + '" title="' + esc(item.fullName) + '">' +
        '<label class="gh-check" title="选择这个仓库"><input type="checkbox" data-role="select"' + (selected ? " checked" : "") + ' aria-label="选择 ' + esc(item.fullName) + '"><span class="gh-checkmark"></span></label>' +
        '<div class="gh-repo-main">' +
          '<div class="gh-repo-title">' +
            '<span class="gh-owner">' + esc(item.owner) + " /</span>" +
            '<span class="gh-name">' + esc(item.repo) + "</span>" +
            badgesHtml(item) +
            (updated ? '<span class="gh-updated" title="' + esc(updatedTitle) + '">' + esc(updated) + "</span>" : "") +
          "</div>" +
          '<p class="gh-desc' + (item.description ? "" : " is-empty") + '">' + desc + "</p>" +
          '<div class="gh-repo-meta">' +
            langHtml(item.language) +
            '<span class="gh-stat" title="Star 数">' + ICON_STAR + esc(fmtNum(item.stars)) + "</span>" +
            '<span class="gh-stat" title="Fork 数">' + ICON_FORK + esc(fmtNum(item.forks)) + "</span>" +
            license + size + topics.join("") +
          "</div>" +
        "</div>" +
        '<button class="gh-open" type="button" data-role="open" title="在 GitHub 打开" aria-label="在 GitHub 打开">' + ICON_EXTERNAL + "</button>" +
      "</div>"
    );
  }

  function errorBlockHtml() {
    return (
      '<div class="gh-error-state">' +
        '<div class="gh-error-icon">!</div>' +
        "<strong>搜索没有完成</strong>" +
        "<p>" + esc(state.error) + "</p>" +
        '<div class="gh-error-actions">' +
          '<button class="gh-btn gh-btn-ghost" type="button" data-role="retry">重试</button>' +
          '<button class="gh-btn gh-btn-ghost" type="button" data-role="settings">检查设置</button>' +
        "</div>" +
      "</div>"
    );
  }

  function emptyResultHtml() {
    return (
      '<div class="gh-no-result">' +
        "<strong>没有找到匹配的仓库</strong>" +
        "<p>试试更短的关键词、降低星标门槛，或减少筛选条件。GitHub 搜索也支持 <b>language:</b>、<b>stars:&gt;1000</b>、<b>topic:</b> 等原生语法。</p>" +
        '<div class="gh-error-actions">' +
          '<button class="gh-btn gh-btn-ghost" type="button" data-role="reset">重置搜索条件</button>' +
          '<button class="gh-btn gh-btn-ghost" type="button" data-role="settings">检查设置</button>' +
        "</div>" +
      "</div>"
    );
  }

  function inlineErrorHtml() {
    return '<div class="gh-inline-error">' + esc(state.error) + ' <button class="gh-link" type="button" data-role="retry">重试</button></div>';
  }

  function renderSearchButton() {
    if (!dom.search) return;
    dom.search.disabled = state.searching;
    dom.search.textContent = state.searching ? "搜索中…" : "搜索";
    dom.search.classList.toggle("is-loading", state.searching);
  }

  function renderRate(el) {
    if (!el) return;
    var rate = state.rate;
    if (!rate || !isFinite(Number(rate.limit)) || Number(rate.limit) <= 0) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    var remaining = Number(rate.remaining);
    el.textContent = "配额 " + fmtNum(remaining) + "/" + fmtNum(rate.limit);
    el.classList.toggle("is-low", isFinite(remaining) && remaining <= 1);
    if (rate.reset) {
      try {
        el.title = "配额将于 " + new Date(Number(rate.reset) * 1000).toLocaleTimeString("zh-CN", { hour12: false }) + " 重置";
      } catch (e) {
        el.title = "";
      }
    }
  }

  function renderMeta() {
    if (!dom.meta) return;
    var show = state.searched || state.searching || !!state.error;
    dom.meta.hidden = !show;
    if (!show) return;

    if (state.searching && !state.items.length) {
      dom.metaCount.textContent = "正在搜索 GitHub…";
    } else if (state.error && !state.items.length) {
      dom.metaCount.textContent = "搜索失败";
    } else {
      dom.metaCount.textContent = "共 " + fmtNum(state.totalCount) + " 个仓库 · 已加载 " + fmtNum(state.items.length);
    }

    var extras = [];
    if (state.fromCache) extras.push("上次搜索");
    else if (state.cached) extras.push("缓存结果");
    if (state.incomplete) extras.push("GitHub 报告结果可能不完整");
    if (state.error && state.items.length) extras.push("本次请求失败");
    dom.metaExtra.textContent = extras.join(" · ");
    dom.metaExtra.classList.toggle("is-warn", !!state.error || state.incomplete);
    renderRate(dom.metaRate);
  }

  function renderList(options) {
    options = options || {};
    if (!dom.list) return;
    var showList = state.searching || !!state.error || state.items.length > 0 || state.searched;
    dom.list.hidden = !showList;
    if (dom.empty) dom.empty.hidden = showList;

    if (!showList) {
      dom.list.innerHTML = "";
      return;
    }

    var prevScroll = dom.list.scrollTop;
    var html = "";

    if (state.searching && !state.items.length) {
      html = '<div class="gh-loading-state"><i class="gh-spinner"></i><p>正在搜索 GitHub 仓库…</p></div>';
    } else if (state.error && !state.items.length) {
      html = errorBlockHtml();
    } else if (state.searched && !state.items.length) {
      html = emptyResultHtml();
    } else {
      if (state.error) html += inlineErrorHtml();
      html += state.items.map(repoCardHtml).join("");

      if (state.searching) {
        html += '<div class="gh-loading-row"><i class="gh-spinner is-small"></i>正在加载更多…</div>';
      } else if (state.hasMore) {
        var loaded = state.items.length;
        var remain = state.totalCount > 0 ? Math.max(0, Math.min(SEARCH_LIMIT, state.totalCount) - loaded) : 0;
        html += '<button class="gh-loadmore" type="button" data-role="loadmore">加载更多' + (remain > 0 ? "（约剩 " + fmtNum(remain) + " 个）" : "") + "</button>";
      } else if (state.items.length >= SEARCH_LIMIT) {
        html += '<div class="gh-list-end">已到 GitHub 搜索上限（前 1000 条结果）</div>';
      } else if (state.items.length > 0) {
        html += '<div class="gh-list-end">已加载全部 ' + fmtNum(state.items.length) + " 个结果</div>";
      }
    }

    dom.list.innerHTML = html;
    if (options.keepScroll) dom.list.scrollTop = prevScroll;
    else dom.list.scrollTop = 0;
  }

  function renderFooter() {
    if (!dom.selectedCount) return;
    var count = state.selected.size;
    var total = state.items.length;
    dom.selectedCount.innerHTML = "已选 <b>" + count + "</b> 个";
    dom.clearSelection.hidden = count === 0;
    dom.selectAll.disabled = total === 0;
    dom.selectAll.checked = total > 0 && count >= total;
    dom.selectAll.indeterminate = count > 0 && count < total;

    var running = isJobRunning();
    dom.download.disabled = count === 0 || running;
    dom.downloadText.textContent = running ? "下载中…" : count > 0 ? "下载 (" + count + ")" : "下载";

    var hint = "";
    if (state.jobStarting) hint = "正在启动下载…";
    else if (state.job) {
      var status = String(state.job.status || "");
      var pct = Math.max(0, Math.min(100, Number(state.job.overall && state.job.overall.percent) || 0));
      if (status === "running") hint = "下载中 " + Math.round(pct) + "%";
      else if (status === "merging") hint = "正在打包 " + Math.round(pct) + "%";
      else if (status === "done") hint = "下载完成 · 查看";
      else if (status === "error") hint = "下载失败 · 查看";
      else if (status === "canceled") hint = "下载已取消 · 查看";
    }
    dom.footHint.hidden = !hint;
    dom.footHint.textContent = hint;
  }

  function renderAll(options) {
    renderSearchButton();
    renderMeta();
    renderList(options);
    renderFooter();
    updateFilterDot();
  }

  // ===================== 筛选控件 =====================
  function readFiltersFromControls() {
    var f = state.filters;
    f.language = dom.language ? dom.language.value : "";
    f.stars = dom.stars ? dom.stars.value : "";
    f.updated = dom.updated ? dom.updated.value : "";
    f.sort = dom.sort && dom.sort.value ? dom.sort.value : "best";
    f.forks = !!(dom.forks && dom.forks.checked);
    f.archived = !!(dom.archived && dom.archived.checked);
    f.scope = dom.scope ? dom.scope.value : "";
    f.owner = dom.owner ? dom.owner.value.trim() : "";
    f.topic = dom.topic ? dom.topic.value.trim() : "";
    f.license = dom.license ? dom.license.value : "";
    f.ownerType = dom.ownerType && dom.ownerType.value === "org" ? "org" : "user";
    f.perPage = [30, 50, 100].indexOf(Number(dom.perPage && dom.perPage.value)) >= 0 ? Number(dom.perPage.value) : 30;
  }

  function applyFiltersToControls() {
    var f = state.filters;
    setSelectValue(dom.language, f.language);
    setSelectValue(dom.stars, f.stars);
    setSelectValue(dom.updated, f.updated);
    setSelectValue(dom.sort, f.sort || "best");
    if (dom.forks) dom.forks.checked = !!f.forks;
    if (dom.archived) dom.archived.checked = !!f.archived;
    setSelectValue(dom.scope, f.scope);
    if (dom.owner) dom.owner.value = f.owner || "";
    if (dom.topic) dom.topic.value = f.topic || "";
    setSelectValue(dom.license, f.license);
    setSelectValue(dom.ownerType, f.ownerType);
    setSelectValue(dom.perPage, String(f.perPage || 30));
    dom.advanced.hidden = advancedActiveCount() === 0;
    updateFilterDot();
  }

  function advancedActiveCount() {
    var f = state.filters;
    var n = 0;
    if (f.scope) n++;
    if (f.owner) n++;
    if (f.topic) n++;
    if (f.license) n++;
    if (Number(f.perPage) !== 30) n++;
    return n;
  }

  function updateFilterDot() {
    if (!dom.filterDot) return;
    var n = advancedActiveCount();
    dom.filterDot.hidden = n === 0;
    dom.filterToggle.title = n === 0 ? "展开更多筛选条件" : "展开更多筛选条件（已启用 " + n + " 项）";
  }

  function updateClearButton() {
    if (dom.clearQ) dom.clearQ.hidden = !dom.q.value;
  }

  function syncModalState() {
    rootEl.classList.toggle("has-modal", !dom.downloadModal.hidden || !dom.settingsModal.hidden);
  }

  function scheduleSearch(delay) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      if (canSearch()) doSearch({ reset: true });
    }, delay || 550);
  }

  /** 筛选被清空到「没有任何可搜索条件」时，别把上一轮结果留在屏幕上冒充当前筛选结果 */
  function clearResultsForEmptyCriteria() {
    clearTimeout(searchTimer);
    state.reqSeq++;
    state.items = [];
    state.selected.clear();
    state.page = 0;
    state.totalCount = 0;
    state.hasMore = false;
    state.searched = false;
    state.searching = false;
    state.error = "";
    state.activeQuery = "";
    state.fromCache = false;
    state.cached = false;
    state.incomplete = false;
    renderAll();
  }

  function handleFilterChange(delay) {
    readFiltersFromControls();
    savePrefs();
    updateFilterDot();
    if (canSearch()) scheduleSearch(delay);
    else clearResultsForEmptyCriteria();
  }

  function applyFiltersNow() {
    clearTimeout(searchTimer);
    readFiltersFromControls();
    savePrefs();
    dom.advanced.hidden = true;
    dom.filterToggle.setAttribute("aria-expanded", "false");
    updateFilterDot();
    if (canSearch()) doSearch({ reset: true });
    else clearResultsForEmptyCriteria();
  }

  // ===================== 搜索 =====================
  function doSearch(options) {
    options = options || {};
    var append = options.append === true;
    if (state.searching && append) return;
    clearTimeout(searchTimer);
    if (!canSearch()) {
      if (!append) {
        toast("请输入关键词，或至少选择一个筛选条件", "error");
        dom.q.focus();
      }
      return;
    }

    var q = append ? state.activeQuery : buildQuery();
    if (!q) return;
    if (q.length > 256) {
      // 在途请求作废，避免它稍后把这条错误覆盖掉
      state.reqSeq++;
      state.searching = false;
      state.error = "搜索条件过长（GitHub 限制 256 个字符），请精简关键词或筛选条件。";
      state.searched = true;
      state.items = [];
      state.selected.clear();
      state.page = 0;
      state.totalCount = 0;
      state.hasMore = false;
      state.fromCache = false;
      state.cached = false;
      renderAll();
      return;
    }

    var seq = ++state.reqSeq;
    state.searching = true;
    state.error = "";
    if (!append) {
      state.items = [];
      state.selected.clear();
      state.page = 0;
      state.totalCount = 0;
      state.hasMore = false;
      state.incomplete = false;
      state.cached = false;
      state.fromCache = false;
      state.searched = true;
    }
    renderAll();

    var page = append ? (Number(state.page) || 1) + 1 : 1;
    var perPage = Number(state.filters.perPage) || 30;

    backendCall("search", {
      q: q,
      sort: apiSort(),
      order: "desc",
      page: page,
      perPage: perPage,
      nocache: append
    })
      .then(function (res) {
        if (!alive() || seq !== state.reqSeq) return;
        if (!res || !Array.isArray(res.items)) throw new Error("后端返回了无法识别的搜索结果");

        var incoming = res.items.map(normalizeItem).filter(Boolean);
        if (append) {
          var known = {};
          state.items.forEach(function (item) {
            known[item.fullName] = true;
          });
          incoming = incoming.filter(function (item) {
            return !known[item.fullName];
          });
          state.items = state.items.concat(incoming);
        } else {
          state.items = incoming;
        }

        state.page = Number(res.page) || page;
        state.totalCount = Math.max(0, Number(res.totalCount) || 0);
        state.hasMore = !!res.hasMore;
        state.incomplete = !!res.incomplete;
        state.cached = !!res.cached;
        state.fromCache = false;
        state.activeQuery = String(res.query || q);
        state.searched = true;
        state.error = "";
        if (res.rate && typeof res.rate === "object") state.rate = res.rate;
        renderAll({ keepScroll: append });
        saveLastFeed();
      })
      .catch(function (err) {
        if (!alive() || seq !== state.reqSeq) return;
        state.error = errText(err);
        state.searched = true;
        if (!append) {
          state.totalCount = 0;
          state.hasMore = false;
        }
        renderAll({ keepScroll: append });
      })
      .then(function () {
        if (!alive() || seq !== state.reqSeq) return;
        state.searching = false;
        renderAll({ keepScroll: append });
      });
  }

  function resetSearch() {
    state.reqSeq++;
    state.filters = defaultFilters();
    state.text = "";
    state.activeQuery = "";
    state.items = [];
    state.selected.clear();
    state.page = 0;
    state.totalCount = 0;
    state.hasMore = false;
    state.searched = false;
    state.searching = false;
    state.error = "";
    state.fromCache = false;
    dom.q.value = "";
    updateClearButton();
    applyFiltersToControls();
    savePrefs();
    renderAll();
    dom.q.focus();
  }

  // ===================== 选择与列表事件 =====================
  function toggleSelect(item, selected) {
    if (!item) return;
    if (selected) state.selected.set(item.fullName, item);
    else state.selected.delete(item.fullName);
    renderFooter();
  }

  function onListChange(event) {
    var input = event.target.closest ? event.target.closest('input[data-role="select"]') : null;
    if (!input) return;
    var card = input.closest(".gh-repo");
    if (!card) return;
    var item = state.items[Number(card.getAttribute("data-index"))];
    if (!item) return;
    if (input.checked) state.selected.set(item.fullName, item);
    else state.selected.delete(item.fullName);
    card.classList.toggle("is-selected", input.checked);
    renderFooter();
  }

  function onListClick(event) {
    var target = event.target;
    var retry = target.closest ? target.closest('[data-role="retry"]') : null;
    if (retry) {
      event.preventDefault();
      if (canSearch()) doSearch({ reset: true });
      else openSettings();
      return;
    }

    var settingsBtn = target.closest ? target.closest('[data-role="settings"]') : null;
    if (settingsBtn) {
      event.preventDefault();
      openSettings();
      return;
    }

    var resetBtn = target.closest ? target.closest('[data-role="reset"]') : null;
    if (resetBtn) {
      event.preventDefault();
      resetSearch();
      return;
    }

    var loadmore = target.closest ? target.closest('[data-role="loadmore"]') : null;
    if (loadmore) {
      event.preventDefault();
      if (!state.searching && state.hasMore) doSearch({ append: true });
      return;
    }

    var openBtn = target.closest ? target.closest('[data-role="open"]') : null;
    if (openBtn) {
      event.preventDefault();
      event.stopPropagation();
      var openCard = openBtn.closest(".gh-repo");
      if (!openCard) return;
      var openItem = state.items[Number(openCard.getAttribute("data-index"))];
      if (openItem) openUrl(openItem.htmlUrl || "https://github.com/" + openItem.fullName);
      return;
    }

    if (target.closest && target.closest(".gh-check")) return;
    var card = target.closest ? target.closest(".gh-repo") : null;
    if (!card) return;
    var item = state.items[Number(card.getAttribute("data-index"))];
    if (!item) return;
    var selected = !state.selected.has(item.fullName);
    toggleSelect(item, selected);
    var input = card.querySelector('input[data-role="select"]');
    if (input) input.checked = selected;
    card.classList.toggle("is-selected", selected);
  }

  function openUrl(url) {
    var u = String(url || "").trim();
    if (!u) return;
    if (!/^https?:\/\/[^\s]+$/i.test(u)) {
      toast("只允许打开 http/https 链接", "error");
      return;
    }
    try {
      if (typeof openExternal === "function") {
        openExternal(u);
        return;
      }
    } catch (e) {
      /* fall through */
    }
    try {
      if (ms.system && typeof ms.system.openExternal === "function") {
        Promise.resolve(ms.system.openExternal(u)).catch(function (err) {
          toast("打开链接失败：" + errText(err), "error");
        });
        return;
      }
    } catch (e) {
      /* fall through */
    }
    try {
      window.open(u, "_blank", "noopener");
    } catch (e) {
      toast("打开链接失败：" + errText(e), "error");
    }
  }

  // ===================== 下载：设置弹窗 =====================
  function applyDlToControls() {
    var d = state.dl;
    if (!d.bundleName || /^github-repos-\d{4}-\d{2}-\d{2}$/.test(d.bundleName)) d.bundleName = defaultBundleName();
    if (!d.subfolderName || /^github-repos-\d{4}-\d{2}-\d{2}$/.test(d.subfolderName)) d.subfolderName = defaultSubfolderName();
    if (!d.template) d.template = "{owner}--{repo}";
    if (dom.template) dom.template.value = d.template;
    if (dom.bundle) dom.bundle.value = d.bundleName;
    if (dom.subfolder) dom.subfolder.checked = !!d.subfolder;
    if (dom.subfolderName) dom.subfolderName.value = d.subfolderName;
    syncDownloadControls();
  }

  function syncDownloadControls() {
    var d = state.dl;
    if (d.merge) d.format = "zip";
    dom.mergeNone.classList.toggle("is-active", !d.merge);
    dom.mergeNone.setAttribute("aria-pressed", String(!d.merge));
    dom.mergeOne.classList.toggle("is-active", !!d.merge);
    dom.mergeOne.setAttribute("aria-pressed", String(!!d.merge));
    dom.formatZip.classList.toggle("is-active", d.format === "zip");
    dom.formatZip.setAttribute("aria-pressed", String(d.format === "zip"));
    dom.formatTar.classList.toggle("is-active", d.format === "tar.gz");
    dom.formatTar.setAttribute("aria-pressed", String(d.format === "tar.gz"));
    dom.formatTar.disabled = !!d.merge;
    dom.separateName.hidden = !!d.merge;
    dom.bundleWrap.hidden = !d.merge;
    dom.subfolderName.hidden = !d.subfolder;
    dom.subfolderName.disabled = !d.subfolder;
    dom.destPath.textContent = d.dest || "尚未选择文件夹";
    dom.destPath.classList.toggle("is-empty", !d.dest);
    dom.mergeHint.textContent = d.merge
      ? "所有仓库合并成一个 ZIP；若某个仓库过大导致无法合并，会自动改为分别保存。"
      : "每个仓库下载为一个独立压缩包，文件名见下方命名规则。";
    renderDownloadSummary();
    renderDownloadPreview();
  }

  function renderDownloadSummary() {
    if (!dom.dlSummary) return;
    var count = state.selected.size;
    var total = 0;
    state.selected.forEach(function (item) {
      total += Math.max(0, Number(item.size) || 0) * 1024;
    });
    var mode = state.dl.merge ? "合并为 1 个 ZIP" : "每个仓库单独压缩";
    dom.dlSummary.innerHTML =
      "已选 <b>" + count + "</b> 个仓库 · " + esc(mode) + " · 未压缩体积约 <b>" +
      esc(total > 0 ? fmtBytes(total) : "未知") + "</b>";
  }

  function sanitizePreviewName(raw, fallback) {
    var s = String(raw == null ? "" : raw)
      .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "-")
      .replace(/[. ]+$/g, "")
      .trim();
    if (!s) s = fallback || "repo";
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(s)) s = fallback || "repo";
    if (s === "." || s === "..") s = fallback || "repo";
    return s.slice(0, 120);
  }

  function fillTemplateClient(tpl, item) {
    var stamp = localStamp();
    var owner = item ? item.owner : "owner";
    var repo = item ? item.repo : "repo";
    var full = item ? item.fullName.replace(/[\\/]/g, "--") : "owner--repo";
    var branch = item ? item.defaultBranch || "default" : "default";
    return String(tpl == null ? "" : tpl)
      .replace(/\{owner\}/gi, owner)
      .replace(/\{repo\}/gi, repo)
      .replace(/\{full_name\}/gi, full)
      .replace(/\{date\}/gi, stamp.date)
      .replace(/\{time\}/gi, stamp.time)
      .replace(/\{branch\}/gi, branch);
  }

  function archiveExt(format) {
    return format === "tar.gz" ? ".tar.gz" : ".zip";
  }

  function renderDownloadPreview() {
    if (!dom.templatePreview) return;
    var n = state.selected.size;
    if (state.dl.merge) {
      var bundle = sanitizePreviewName(state.dl.bundleName || defaultBundleName(), "github-repos");
      if (!bundle.toLowerCase().endsWith(".zip")) bundle += ".zip";
      dom.templatePreview.innerHTML = "将生成 <b>" + esc(bundle) + "</b>，内含 " + n + " 个仓库目录。";
      return;
    }
    var first = firstSelected();
    var tpl = state.dl.template || "{owner}--{repo}";
    var name = sanitizePreviewName(fillTemplateClient(tpl, first), "owner--repo");
    var ext = archiveExt(state.dl.format);
    if (!name.toLowerCase().endsWith(ext)) name += ext;
    dom.templatePreview.innerHTML = "示例：<b>" + esc(name) + "</b>" + (n > 1 ? "（其余仓库按同样规则命名）" : "");
  }

  function openDownloadModal() {
    if (state.selected.size === 0) {
      toast("请先勾选要下载的仓库", "error");
      return;
    }
    if (isJobRunning()) {
      openProgressModal();
      return;
    }
    if (!state.dl.dest) {
      // 不阻止打开，让用户看到「选择文件夹」这一必要条件。
    }
    state.jobStarting = false;
    state.jobError = "";
    dom.dlError.hidden = true;
    dom.dlError.textContent = "";
    dom.dlStart.disabled = false;
    dom.dlStart.textContent = "开始下载";
    dom.dlTitle.textContent = "下载 " + state.selected.size + " 个仓库";
    dom.dlSetup.hidden = false;
    dom.dlProgress.hidden = true;
    dom.dlFootSetup.hidden = false;
    dom.dlFootProgress.hidden = true;
    dom.downloadModal.hidden = false;
    applyDlToControls();
    syncModalState();
  }

  function closeDownloadModal() {
    if (dom.downloadModal.hidden) return;
    var running = isJobRunning();
    if (state.jobStarting) {
      askConfirm("正在创建下载任务。关闭下载窗口不会中断任务；关闭插件界面会停止下载。确定关闭吗？").then(function (ok) {
        if (ok) {
          dom.downloadModal.hidden = true;
          syncModalState();
        }
      });
      return;
    }
    if (running && !dom.dlProgress.hidden) {
      askConfirm("关闭进度窗口不会中断任务，下载会继续；关闭插件界面则会停止下载。确定关闭吗？").then(function (ok) {
        if (ok) {
          dom.downloadModal.hidden = true;
          syncModalState();
        }
      });
      return;
    }
    dom.downloadModal.hidden = true;
    syncModalState();
  }

  function showDownloadError(message) {
    if (!dom.dlError) return;
    dom.dlError.textContent = String(message || "下载失败");
    dom.dlError.hidden = false;
  }

  function pickDownloadFolder() {
    if (!ms.ui || typeof ms.ui.pickFolder !== "function") {
      showDownloadError("当前宿主版本不支持文件夹选择，请升级「我的搜索」到 7.9.15 或更高版本。");
      return;
    }
    dom.pickFolder.disabled = true;
    var picked;
    try {
      picked = ms.ui.pickFolder({
        title: "选择仓库下载到哪个文件夹",
        defaultPath: state.dl.dest || undefined
      });
    } catch (err) {
      dom.pickFolder.disabled = false;
      showDownloadError("打开文件夹选择框失败：" + errText(err));
      return;
    }
    Promise.resolve(picked)
      .then(function (dir) {
        if (!alive() || !dir) return;
        state.dl.dest = String(dir);
        dom.destPath.textContent = state.dl.dest;
        dom.destPath.classList.remove("is-empty");
        dom.dlError.hidden = true;
        savePrefs();
      })
      .catch(function (err) {
        showDownloadError("打开文件夹选择框失败：" + errText(err));
      })
      .then(function () {
        dom.pickFolder.disabled = false;
      });
  }

  function startDownload() {
    if (state.jobStarting) return;
    var count = state.selected.size;
    if (count === 0) {
      showDownloadError("请先勾选要下载的仓库。");
      return;
    }
    if (count > MAX_REPOS) {
      showDownloadError("单次最多下载 " + MAX_REPOS + " 个仓库，请分批下载。");
      return;
    }
    if (!state.dl.dest) {
      showDownloadError("请先选择下载到的文件夹。");
      dom.pickFolder.focus();
      return;
    }
    if (state.dl.merge && state.dl.format !== "zip") state.dl.format = "zip";
    if (!state.dl.template) state.dl.template = "{owner}--{repo}";
    if (!state.dl.bundleName) state.dl.bundleName = defaultBundleName();

    var items = [];
    state.selected.forEach(function (item) {
      items.push({
        fullName: item.fullName,
        owner: item.owner,
        repo: item.repo,
        private: !!item.private,
        branch: item.defaultBranch || "",
        defaultBranch: item.defaultBranch || "",
        size: Number(item.size) || 0
      });
    });

    state.jobStarting = true;
    state.finishedNotified = false;
    state.jobError = "";
    state.job = null;
    state.jobId = "";
    stopJobPolling();
    dom.dlError.hidden = true;
    dom.dlStart.disabled = true;
    dom.dlStart.textContent = "正在创建任务…";
    renderFooter();

    var options = {
      format: state.dl.format,
      merge: !!state.dl.merge,
      template: state.dl.template || "{owner}--{repo}",
      bundleName: state.dl.bundleName || defaultBundleName(),
      subfolder: !!state.dl.subfolder,
      subfolderName: state.dl.subfolder ? state.dl.subfolderName || defaultSubfolderName() : "",
      concurrency: 3
    };

    backendCall("downloadStart", { items: items, destDir: state.dl.dest, options: options })
      .then(function (res) {
        if (!alive()) return;
        if (!res || !res.jobId) throw new Error("后端没有返回下载任务 ID");
        state.jobId = res.jobId;
        state.job = null;
        state.jobStarting = false;
        showProgressView();
        renderProgressLoading();
        startJobPolling(700);
        refreshJob().catch(function (err) {
          state.jobError = errText(err);
          renderProgress();
        });
      })
      .catch(function (err) {
        if (!alive()) return;
        state.jobStarting = false;
        state.jobId = "";
        dom.dlStart.disabled = false;
        dom.dlStart.textContent = "开始下载";
        showDownloadError("创建下载任务失败：" + errText(err));
        renderFooter();
      });
  }

  // ===================== 下载：任务状态 =====================
  function isFinishedStatus(status) {
    return status === "done" || status === "error" || status === "canceled";
  }

  function isJobRunning() {
    if (state.jobStarting) return true;
    if (!state.jobId) return false;
    if (!state.job) return true;
    return state.job.status === "running" || state.job.status === "merging";
  }

  function showProgressView() {
    dom.dlSetup.hidden = true;
    dom.dlProgress.hidden = false;
    dom.dlFootSetup.hidden = true;
    dom.dlFootProgress.hidden = false;
    dom.dlTitle.textContent = state.job ? jobTitle(state.job) : "下载进度";
    dom.dlCancel.hidden = false;
    dom.dlOpen.hidden = true;
    dom.dlFinish.hidden = true;
  }

  function renderProgressLoading() {
    dom.dlTitle.textContent = "下载进度";
    dom.progPercent.textContent = "0%";
    dom.progSub.textContent = "正在创建下载任务…";
    dom.progSpeed.textContent = "";
    dom.progBar.style.width = "0%";
    dom.progBar.classList.remove("is-error");
    dom.progTrack.setAttribute("aria-valuenow", "0");
    dom.progNote.hidden = true;
    dom.progList.innerHTML = '<div class="gh-loading-row"><i class="gh-spinner is-small"></i>等待后端开始…</div>';
    dom.dlCancel.hidden = false;
    dom.dlOpen.hidden = true;
    dom.dlFinish.hidden = true;
  }

  function jobTitle(job) {
    if (!job) return "下载进度";
    if (job.status === "done") return job.overall && job.overall.failed > 0 ? "下载完成（部分失败）" : "下载完成";
    if (job.status === "error") return "下载失败";
    if (job.status === "canceled") return "下载已取消";
    if (job.status === "merging") return "正在打包";
    return "正在下载仓库";
  }

  function jobItemPercent(item) {
    if (item.status === "done") return 100;
    var total = Number(item.totalBytes) || 0;
    var bytes = Number(item.bytes) || 0;
    if (total > 0) return Math.max(0, Math.min(100, (bytes / total) * 100));
    return 0;
  }

  function jobItemStatusText(item) {
    var bytes = Number(item.bytes) || 0;
    if (item.status === "queued") return "等待中";
    if (item.status === "running") {
      var pct = jobItemPercent(item);
      return pct > 0 ? Math.round(pct) + "%" : fmtBytes(bytes);
    }
    if (item.status === "done") return "完成 · " + fmtBytes(bytes);
    if (item.status === "canceled") return "已取消";
    return "失败";
  }

  function renderJobItems(job) {
    if (!dom.progList) return;
    var items = Array.isArray(job.items) ? job.items : [];
    if (!items.length) {
      dom.progList.innerHTML = "";
      return;
    }
    var scrollTop = dom.progList.scrollTop;
    var html = items.map(function (item) {
      var status = ["queued", "running", "done", "error", "canceled"].indexOf(item.status) >= 0 ? item.status : "queued";
      var icon = "";
      if (status === "running") icon = '<i class="gh-spinner"></i>';
      else if (status === "done") icon = "✓";
      else if (status === "error") icon = "!";
      else if (status === "canceled") icon = "×";
      else icon = "·";

      var pct = jobItemPercent(item);
      var rowClass = "gh-prog-row is-" + status;
      return (
        '<div class="' + rowClass + '">' +
          '<div class="gh-prog-row-top">' +
            '<span class="gh-prog-icon is-' + status + '">' + icon + "</span>" +
            '<span class="gh-prog-name" title="' + esc(item.fullName) + '">' + esc(item.fullName) + "</span>" +
            '<span class="gh-prog-status">' + esc(jobItemStatusText(item)) + "</span>" +
          "</div>" +
          '<div class="gh-bar"><i style="width:' + pct.toFixed(1) + '%"></i></div>' +
          (item.error ? '<div class="gh-prog-error">' + esc(item.error) + "</div>" : "") +
          (item.separated ? '<div class="gh-prog-separated">合并失败，已单独保存</div>' : "") +
        "</div>"
      );
    }).join("");
    dom.progList.innerHTML = html;
    dom.progList.scrollTop = scrollTop;
  }

  function renderProgress() {
    var job = state.job;
    if (!job) {
      if (state.jobError) {
        dom.dlTitle.textContent = "下载进度";
        dom.progPercent.textContent = "—";
        dom.progSub.textContent = "无法读取任务状态";
        dom.progSpeed.textContent = "";
        dom.progBar.style.width = "0%";
        dom.progBar.classList.add("is-error");
        dom.progTrack.setAttribute("aria-valuenow", "0");
        dom.progNote.hidden = false;
        dom.progNote.textContent = state.jobError;
        dom.progNote.classList.add("is-warn");
        dom.progList.innerHTML = "";
        dom.dlCancel.hidden = true;
        dom.dlOpen.hidden = !state.dl.dest;
        dom.dlFinish.hidden = false;
        return;
      }
      renderProgressLoading();
      return;
    }
    var overall = job.overall || {};
    var status = String(job.status || "running");
    var percent = status === "done" ? 100 : Math.max(0, Math.min(99.9, Number(overall.percent) || 0));
    var percentText = status === "done" ? "100%" : (percent < 10 ? percent.toFixed(1) : String(Math.round(percent))) + "%";

    dom.dlTitle.textContent = jobTitle(job);
    dom.progPercent.textContent = percentText;
    dom.progBar.style.width = percent + "%";
    dom.progBar.classList.toggle("is-error", status === "error" || status === "canceled");
    dom.progTrack.setAttribute("aria-valuenow", String(Math.round(percent)));

    var reposDone = Number(overall.reposDone) || 0;
    var reposTotal = Number(overall.reposTotal) || 0;
    var failed = Number(overall.failed) || 0;

    if (status === "running") {
      dom.progSub.textContent = reposDone + "/" + reposTotal + " 个仓库 · " + fmtBytes(overall.doneBytes) + " / " + fmtBytes(overall.totalBytes);
      dom.progSpeed.textContent = fmtSpeed(overall.speed) + (overall.etaSec != null ? " · " + fmtEta(overall.etaSec) : "");
    } else if (status === "merging") {
      dom.progSub.textContent = "正在合并 " + reposDone + "/" + reposTotal + " 个仓库…";
      dom.progSpeed.textContent = "正在写入 ZIP";
    } else if (status === "done") {
      dom.progSub.textContent = reposDone + "/" + reposTotal + " 个仓库已保存" + (failed > 0 ? " · " + failed + " 个失败" : "");
      dom.progSpeed.textContent = "耗时 " + fmtDuration(job.elapsedSec);
    } else if (status === "error") {
      dom.progSub.textContent = "已完成 " + reposDone + "/" + reposTotal + " 个仓库";
      dom.progSpeed.textContent = "任务已停止";
    } else {
      dom.progSub.textContent = "已完成 " + reposDone + "/" + reposTotal + " 个仓库";
      dom.progSpeed.textContent = "已取消";
    }

    var note = "";
    var warn = false;
    if (job.mergeFallback) {
      note = "合并打包未成功，已改为分别保存" + (job.mergeFallbackReason ? "：" + job.mergeFallbackReason : "") + "。";
      warn = true;
    } else if (status === "error") {
      note = job.error ? "任务失败：" + job.error : "任务失败。";
      warn = true;
    } else if (status === "canceled") {
      note = "任务已取消。已完成的部分会保留在目标文件夹。";
    } else if (status === "merging") {
      note = "正在把已下载的压缩包合并为一个 ZIP，请保持应用运行。";
    } else if (status === "done" && failed > 0) {
      note = failed + " 个仓库下载失败，其余仓库已保存。";
      warn = true;
    } else if (state.jobError) {
      note = state.jobError;
      warn = true;
    }

    dom.progNote.hidden = !note;
    dom.progNote.textContent = note;
    dom.progNote.classList.toggle("is-warn", warn);

    renderJobItems(job);

    var running = status === "running" || status === "merging";
    dom.dlCancel.hidden = !running;
    dom.dlOpen.hidden = running || !(job.destDir || job.destRoot || state.dl.dest);
    dom.dlFinish.hidden = running;
  }

  function notifyFinished(job) {
    if (state.finishedNotified) return;
    state.finishedNotified = true;
    var status = job && job.status;
    if (status === "done") {
      var failed = Number(job.overall && job.overall.failed) || 0;
      toast(failed > 0 ? "下载完成，" + failed + " 个仓库失败" : "已下载 " + (Number(job.overall && job.overall.reposDone) || 0) + " 个仓库", "ok");
    } else if (status === "error") {
      toast("下载失败：" + shortText(job.error || "未知错误", 180), "error");
    } else if (status === "canceled") {
      toast("下载已取消", "ok");
    }
  }

  function handleFinished(job) {
    state.job = job;
    if (job.jobId) state.jobId = job.jobId;
    state.jobStarting = false;
    stopJobPolling();
    notifyFinished(job);
    if (isProgressVisible()) renderProgress();
    renderFooter();
  }

  function isProgressVisible() {
    return !dom.downloadModal.hidden && !dom.dlProgress.hidden;
  }

  function refreshJob() {
    if (!state.jobId) return Promise.resolve(null);
    return backendCall("getJob", { jobId: state.jobId })
      .then(function (snap) {
        if (!alive()) return null;
        if (!snap || !snap.jobId) {
          state.jobId = "";
          state.job = null;
          state.jobStarting = false;
          state.jobError = "下载任务状态已丢失，插件后端可能已重启。请检查目标文件夹里已生成的文件。";
          stopJobPolling();
          if (isProgressVisible()) renderProgress();
          renderFooter();
          return null;
        }
        state.job = snap;
        state.jobStarting = false;
        state.jobPollFails = 0;
        state.jobError = "";
        if (isFinishedStatus(snap.status)) {
          handleFinished(snap);
        } else {
          if (isProgressVisible()) renderProgress();
          renderFooter();
        }
        return snap;
      })
      .catch(function (err) {
        state.jobPollFails++;
        if (isProgressVisible()) {
          dom.progNote.hidden = false;
          dom.progNote.textContent = "读取进度失败：" + errText(err);
          dom.progNote.classList.add("is-warn");
        }
        if (state.jobPollFails >= 6) {
          state.jobError = "连续多次无法读取任务进度：" + errText(err);
          stopJobPolling();
        }
        throw err;
      });
  }

  function startJobPolling(delay) {
    stopJobPolling();
    state.jobPollFails = 0;
    state.jobPollTimer = setTimeout(function tick() {
      if (state.disposed || !alive() || !state.jobId) return;
      if (document.hidden) {
        startJobPolling(2000);
        return;
      }
      refreshJob()
        .then(function (snap) {
          if (state.disposed || !alive() || !state.jobId) return;
          if (snap && isFinishedStatus(snap.status)) return;
          startJobPolling(1500);
        })
        .catch(function () {
          if (state.disposed || !alive() || !state.jobId) return;
          if (state.jobPollFails > 0 && state.jobPollFails < 6) startJobPolling(3000);
        });
    }, delay || 1200);
  }

  function stopJobPolling() {
    if (state.jobPollTimer) clearTimeout(state.jobPollTimer);
    state.jobPollTimer = 0;
  }

  function onJobProgress(payload) {
    if (!alive() || !payload || typeof payload !== "object") return;
    if (state.jobId && payload.jobId && payload.jobId !== state.jobId) return;
    state.job = payload;
    if (payload.jobId) state.jobId = payload.jobId;
    state.jobStarting = false;
    if (isFinishedStatus(payload.status)) {
      handleFinished(payload);
      return;
    }
    if (isProgressVisible()) renderProgress();
    renderFooter();
  }

  function onJobDone(payload) {
    if (!alive() || !payload || typeof payload !== "object") return;
    if (state.jobId && payload.jobId && payload.jobId !== state.jobId) return;
    state.job = payload;
    if (payload.jobId) state.jobId = payload.jobId;
    state.jobStarting = false;
    handleFinished(payload);
  }

  function openProgressModal() {
    if (!state.job && !state.jobId && !state.jobStarting) {
      toast("当前没有可查看的下载任务", "error");
      return;
    }
    dom.downloadModal.hidden = false;
    dom.dlError.hidden = true;
    showProgressView();
    syncModalState();
    if (state.job) renderProgress();
    else if (state.jobError) renderProgress();
    else renderProgressLoading();
  }

  function cancelJob() {
    if (!state.jobId && !state.jobStarting) {
      toast("当前没有正在进行的下载任务", "error");
      return;
    }
    askConfirm("确定取消下载吗？已完成的压缩包会保留，正在下载的文件会被删除。").then(function (ok) {
      if (!ok) return;
      var params = state.jobId ? { jobId: state.jobId } : {};
      return backendCall("cancelDownload", params).then(function (res) {
        if (res && res.canceled) toast("已请求取消下载", "ok");
        else toast(res && res.reason ? res.reason : "任务已经结束", "ok");
        return refreshJob().catch(function () {});
      });
    }).catch(function (err) {
      toast("取消失败：" + errText(err), "error");
    });
  }

  function openJobFolder() {
    var job = state.job;
    var dir = (job && (job.destDir || job.destRoot)) || state.dl.dest;
    if (!dir) {
      toast("还没有生成下载目录", "error");
      return;
    }
    backendCall("openFolder", { path: dir }).catch(function (err) {
      toast("打开文件夹失败：" + errText(err), "error");
    });
  }

  function closeProgressAndFinish() {
    dom.downloadModal.hidden = true;
    syncModalState();
  }

  // ===================== 设置 / Token =====================
  function setTokenStatus(text, kind) {
    if (!dom.tokenStatus) return;
    dom.tokenStatus.textContent = String(text || "");
    dom.tokenStatus.className = "gh-token-status" + (kind === "ok" ? " is-ok" : kind === "error" ? " is-error" : "");
  }

  function setTokenBadge(text, kind) {
    if (!dom.tokenBadge) return;
    dom.tokenBadge.textContent = String(text || "");
    dom.tokenBadge.className = "gh-badge " + (kind === "ok" ? "gh-badge-ok" : kind === "error" ? "gh-badge-error" : "gh-badge-muted");
  }

  function setBackendError(message) {
    state.backendError = String(message || "");
    if (dom.authDot) dom.authDot.className = "gh-auth-dot is-error";
    if (dom.authText) dom.authText.textContent = "后端未连接";
    if (dom.authBtn) dom.authBtn.title = state.backendError;
    if (dom.metaRate) dom.metaRate.hidden = true;
  }

  function renderAuth() {
    if (!dom.authDot || !dom.authText) return;
    if (state.backendError) {
      dom.authDot.className = "gh-auth-dot is-error";
      dom.authText.textContent = "后端未连接";
      dom.authBtn.title = state.backendError;
      return;
    }
    var cfg = state.config || {};
    var authed = !!cfg.hasToken;
    dom.authDot.className = "gh-auth-dot" + (authed ? " is-auth" : "");
    dom.authText.textContent = authed ? (cfg.login ? "@" + cfg.login : "Token 已配置") : "匿名模式 · 10 次/分";
    dom.authBtn.title = authed ? "已配置 Token，点击管理 Token 与网络" : "点击配置 GitHub Token，提高配额并支持私有仓库";
  }

  function applyConfigUi(options) {
    options = options || {};
    var cfg = state.config || {};
    if (options.populateInputs) {
      if (dom.apiBase) dom.apiBase.value = cfg.apiBase || "https://api.github.com";
      if (dom.proxy) dom.proxy.value = cfg.proxy || "";
    }
    if (cfg.rateLimit && cfg.rateLimit.search && isFinite(Number(cfg.rateLimit.search.limit))) {
      state.rate = cfg.rateLimit.search;
    }
    renderAuth();

    if (cfg.hasToken) {
      setTokenBadge("已配置", "ok");
      var rate = cfg.rateLimit && cfg.rateLimit.search;
      setTokenStatus(
        "Token 已保存（尾号 " + (cfg.tokenHint || "…") + "）" +
          (cfg.login ? " · @" + cfg.login : "") +
          (rate ? " · 搜索配额 " + fmtNum(rate.remaining) + "/" + fmtNum(rate.limit) + " 次/分" : ""),
        "ok"
      );
      if (dom.tokenClear) dom.tokenClear.hidden = false;
      if (dom.tokenSave) dom.tokenSave.textContent = "更新 Token";
    } else {
      setTokenBadge("未配置", "muted");
      setTokenStatus("未配置 Token，当前为匿名访问（搜索 10 次/分钟）。配置后提升到 30 次/分钟，并可下载私有仓库。", "");
      if (dom.tokenClear) dom.tokenClear.hidden = true;
      if (dom.tokenSave) dom.tokenSave.textContent = "保存 Token";
    }
    if (dom.meta) renderMeta();
  }

  function loadConfig(options) {
    options = options || {};
    return backendCall("getConfig", {})
      .then(function (cfg) {
        if (!alive()) return null;
        state.config = cfg && typeof cfg === "object" ? cfg : {};
        state.backendError = "";
        applyConfigUi(options);
        return state.config;
      })
      .catch(function (err) {
        if (!alive()) return null;
        setBackendError(errText(err));
        if (options.toast) toast("无法连接插件后端：" + errText(err), "error");
        return null;
      });
  }

  function openSettings() {
    dom.settingsModal.hidden = false;
    syncModalState();
    dom.token.value = "";
    setTokenBadge("读取中", "muted");
    setTokenStatus("正在读取配置…", "");
    if (dom.apiBase) dom.apiBase.value = (state.config && state.config.apiBase) || "https://api.github.com";
    if (dom.proxy) dom.proxy.value = (state.config && state.config.proxy) || "";
    loadConfig({ populateInputs: true, toast: true }).then(function (cfg) {
      if (!cfg) {
        setTokenBadge("不可用", "error");
        setTokenStatus(state.backendError || "后端未连接", "error");
      }
    });
  }

  function closeSettings() {
    dom.settingsModal.hidden = true;
    syncModalState();
    dom.token.value = "";
    dom.tokenTest.disabled = false;
    dom.tokenSave.disabled = false;
    dom.networkSave.disabled = false;
    dom.tokenTest.textContent = "测试";
    dom.tokenSave.textContent = state.config && state.config.hasToken ? "更新 Token" : "保存 Token";
  }

  function testTokenFromInput() {
    var token = dom.token.value.trim();
    var hasSaved = !!(state.config && state.config.hasToken);
    if (!token && !hasSaved) {
      setTokenStatus("请先填写 GitHub Token，或先保存一个 Token。", "error");
      dom.token.focus();
      return;
    }
    dom.tokenTest.disabled = true;
    dom.tokenTest.textContent = "测试中…";
    setTokenStatus("正在验证 Token…", "");
    var params = token ? { token: token } : {};
    backendCall("testToken", params)
      .then(function (res) {
        if (!alive()) return;
        var rate = res && res.rateLimit && res.rateLimit.search;
        var who = res && res.login ? " · @" + res.login : "";
        setTokenStatus("Token 可用" + who + (rate ? " · 搜索配额 " + fmtNum(rate.remaining) + "/" + fmtNum(rate.limit) + " 次/分" : ""), "ok");
        toast("Token 验证通过", "ok");
        if (!token && state.config) {
          state.config.login = (res && res.login) || "";
          if (rate) state.config.rateLimit = { search: rate, core: res.rateLimit.core };
          applyConfigUi();
        }
      })
      .catch(function (err) {
        if (!alive()) return;
        setTokenStatus(errText(err), "error");
        toast("Token 验证失败", "error");
      })
      .then(function () {
        if (!dom.tokenTest) return;
        dom.tokenTest.disabled = false;
        dom.tokenTest.textContent = "测试";
      });
  }

  function saveToken() {
    var token = dom.token.value.trim();
    if (!token) {
      setTokenStatus("请填写要保存的 GitHub Token。", "error");
      dom.token.focus();
      return;
    }
    dom.tokenSave.disabled = true;
    dom.tokenTest.disabled = true;
    dom.tokenSave.textContent = "保存中…";
    setTokenStatus("正在验证并保存 Token…", "");

    backendCall("testToken", { token: token })
      .then(function () {
        return backendCall("setConfig", { token: token });
      })
      .then(function (cfg) {
        if (!alive()) return null;
        state.config = cfg || {};
        dom.token.value = "";
        // setConfig 会清空 login；再用已保存的 Token 读一次，界面才能显示 @login。
        return backendCall("testToken", {})
          .then(function (res) {
            if (!alive() || !state.config) return;
            state.config.login = (res && res.login) || "";
            if (res && res.rateLimit) state.config.rateLimit = res.rateLimit;
            // 不重填 API/代理输入框，避免把用户尚未保存的网络编辑覆盖掉
            applyConfigUi({ populateInputs: false });
            setTokenStatus("Token 已保存" + (state.config.login ? " · @" + state.config.login : "") + "，后续搜索会使用更高配额。", "ok");
            toast("Token 已保存", "ok");
          })
          .catch(function () {
            if (!alive()) return;
            applyConfigUi({ populateInputs: false });
            setTokenStatus("Token 已保存，但暂时无法读取账号信息。", "ok");
            toast("Token 已保存", "ok");
          });
      })
      .catch(function (err) {
        if (!alive()) return;
        setTokenStatus("保存失败：" + errText(err), "error");
        toast("Token 保存失败：" + errText(err), "error");
      })
      .then(function () {
        if (!dom.tokenSave) return;
        dom.tokenSave.disabled = false;
        dom.tokenSave.textContent = state.config && state.config.hasToken ? "更新 Token" : "保存 Token";
        if (dom.tokenTest) dom.tokenTest.disabled = false;
      });
  }

  function clearToken() {
    if (!state.config || !state.config.hasToken) {
      setTokenStatus("当前没有保存 Token。", "");
      return;
    }
    askConfirm("清除已保存的 GitHub Token？之后搜索将使用匿名配额，私有仓库将无法下载。").then(function (ok) {
      if (!ok) return;
      return backendCall("setConfig", { clearToken: true }).then(function (cfg) {
        if (!alive()) return;
        state.config = cfg || {};
        state.rate = null;
        dom.token.value = "";
        applyConfigUi({ populateInputs: false });
        setTokenStatus("Token 已清除，当前为匿名访问。", "");
        toast("Token 已清除", "ok");
      });
    }).catch(function (err) {
      setTokenStatus("清除失败：" + errText(err), "error");
      toast("清除 Token 失败", "error");
    });
  }

  function saveNetwork() {
    var apiBase = dom.apiBase.value.trim() || "https://api.github.com";
    var proxy = dom.proxy.value.trim();
    if (!/^https:\/\//i.test(apiBase)) {
      toast("API 地址必须以 https:// 开头", "error");
      dom.apiBase.focus();
      return;
    }
    if (proxy && !/^http:\/\/[^\s/:]+:\d+\/?$/i.test(proxy)) {
      toast("HTTP 代理格式应为 http://主机:端口，例如 http://127.0.0.1:7890", "error");
      dom.proxy.focus();
      return;
    }
    dom.networkSave.disabled = true;
    dom.networkSave.textContent = "保存中…";
    backendCall("setConfig", { apiBase: apiBase, proxy: proxy })
      .then(function (cfg) {
        if (!alive()) return;
        state.config = cfg || {};
        state.rate = null;
        applyConfigUi({ populateInputs: true });
        toast("网络设置已保存；下次搜索生效", "ok");
      })
      .catch(function (err) {
        toast("网络设置保存失败：" + errText(err), "error");
      })
      .then(function () {
        dom.networkSave.disabled = false;
        dom.networkSave.textContent = "保存网络设置";
      });
  }

  // ===================== 通知与恢复任务 =====================
  function registerNotifications() {
    if (!ms.backend || typeof ms.backend.onNotification !== "function") return;
    try {
      var off1 = ms.backend.onNotification("download-progress", function (payload) {
        try {
          onJobProgress(payload);
        } catch (e) {
          /* ignore */
        }
      });
      if (typeof off1 === "function") notificationOffs.push(off1);
      var off2 = ms.backend.onNotification("download-done", function (payload) {
        try {
          onJobDone(payload);
        } catch (e) {
          /* ignore */
        }
      });
      if (typeof off2 === "function") notificationOffs.push(off2);
      var off3 = ms.backend.onNotification("log", function (entry) {
        if (!entry || typeof entry !== "object") return;
        if (entry.level === "error") {
          try {
            console.warn("[GitHub 下载器]", entry.message || entry);
          } catch (e) {
            /* ignore */
          }
        }
      });
      if (typeof off3 === "function") notificationOffs.push(off3);
    } catch (e) {
      /* ignore */
    }
  }

  function restoreJob() {
    backendCall("getJob", {})
      .then(function (snap) {
        if (!alive() || !snap || !snap.jobId) return;
        var age = Date.now() - (Number(snap.finishedAt) || 0);
        if (snap.status === "running" || snap.status === "merging") {
          state.job = snap;
          state.jobId = snap.jobId;
          state.jobStarting = false;
          state.finishedNotified = false;
          openProgressModal();
          startJobPolling(700);
          return;
        }
        if (age > 0 && age < 30 * 60 * 1000) {
          state.job = snap;
          state.jobId = snap.jobId;
          state.finishedNotified = true;
          renderFooter();
        }
      })
      .catch(function () {
        /* 后端还没起来时忽略 */
      });
  }

  // ===================== 事件绑定 =====================
  function bindEvents() {
    // 搜索框
    dom.q.addEventListener("input", function () {
      state.text = dom.q.value;
      updateClearButton();
    });
    dom.q.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        doSearch({ reset: true });
      } else if (event.key === "Escape" && dom.q.value) {
        event.preventDefault();
        event.stopPropagation();
        dom.q.value = "";
        state.text = "";
        updateClearButton();
      }
    });
    dom.clearQ.addEventListener("click", function () {
      dom.q.value = "";
      state.text = "";
      updateClearButton();
      dom.q.focus();
    });
    dom.search.addEventListener("click", function () {
      doSearch({ reset: true });
    });

    // 筛选展开/收起
    dom.filterToggle.addEventListener("click", function () {
      dom.advanced.hidden = !dom.advanced.hidden;
      dom.filterToggle.setAttribute("aria-expanded", String(!dom.advanced.hidden));
    });
    dom.applyFilters.addEventListener("click", applyFiltersNow);

    // 快速筛选：变化即搜（防抖）
    [dom.language, dom.stars, dom.updated, dom.sort, dom.perPage].forEach(function (control) {
      if (!control) return;
      control.addEventListener("change", function () {
        handleFilterChange(500);
      });
    });
    [dom.forks, dom.archived].forEach(function (control) {
      if (!control) return;
      control.addEventListener("change", function () {
        handleFilterChange(500);
      });
    });

    // 高级筛选：下拉变化即搜；文本框在回车/失焦/应用时生效
    [dom.scope, dom.license, dom.ownerType].forEach(function (control) {
      if (!control) return;
      control.addEventListener("change", function () {
        handleFilterChange(600);
      });
    });
    [dom.owner, dom.topic].forEach(function (control) {
      if (!control) return;
      control.addEventListener("change", function () {
        handleFilterChange(700);
      });
      control.addEventListener("keydown", function (event) {
        if (event.key === "Enter") {
          event.preventDefault();
          applyFiltersNow();
        }
      });
    });

    // 列表（事件委托）
    dom.list.addEventListener("change", onListChange);
    dom.list.addEventListener("click", onListClick);

    // 空态示例
    dom.empty.addEventListener("click", function (event) {
      var example = event.target.closest ? event.target.closest("[data-q]") : null;
      if (!example) return;
      var q = example.getAttribute("data-q") || "";
      dom.q.value = q;
      state.text = q;
      updateClearButton();
      doSearch({ reset: true });
    });

    // 全选 / 清空
    dom.selectAll.addEventListener("change", function () {
      if (dom.selectAll.checked) {
        state.items.forEach(function (item) {
          state.selected.set(item.fullName, item);
        });
      } else {
        state.selected.clear();
      }
      renderAll({ keepScroll: true });
    });
    dom.clearSelection.addEventListener("click", function () {
      state.selected.clear();
      renderAll({ keepScroll: true });
    });

    // 底栏下载 / 进度
    dom.download.addEventListener("click", openDownloadModal);
    dom.footHint.addEventListener("click", function () {
      if (state.job || state.jobId) openProgressModal();
    });

    // 下载弹窗：背景 / 关闭
    dom.downloadModal.addEventListener("click", function (event) {
      if (event.target === dom.downloadModal) closeDownloadModal();
    });
    dom.downloadModal.addEventListener("click", function (event) {
      var closer = event.target.closest ? event.target.closest('[data-close="download"]') : null;
      if (closer) {
        event.preventDefault();
        closeDownloadModal();
      }
    });

    // 下载位置
    dom.pickFolder.addEventListener("click", pickDownloadFolder);
    dom.subfolder.addEventListener("change", function () {
      state.dl.subfolder = !!dom.subfolder.checked;
      if (state.dl.subfolder && !state.dl.subfolderName) {
        state.dl.subfolderName = defaultSubfolderName();
        dom.subfolderName.value = state.dl.subfolderName;
      }
      syncDownloadControls();
      savePrefs();
    });
    dom.subfolderName.addEventListener("input", function () {
      state.dl.subfolderName = dom.subfolderName.value;
      savePrefsSoon();
    });

    // 打包方式 / 格式
    dom.mergeNone.addEventListener("click", function () {
      state.dl.merge = false;
      syncDownloadControls();
      savePrefs();
    });
    dom.mergeOne.addEventListener("click", function () {
      state.dl.merge = true;
      state.dl.format = "zip";
      syncDownloadControls();
      savePrefs();
    });
    dom.formatZip.addEventListener("click", function () {
      state.dl.format = "zip";
      syncDownloadControls();
      savePrefs();
    });
    dom.formatTar.addEventListener("click", function () {
      if (state.dl.merge) return;
      state.dl.format = "tar.gz";
      syncDownloadControls();
      savePrefs();
    });

    // 命名
    dom.template.addEventListener("input", function () {
      state.dl.template = dom.template.value;
      renderDownloadPreview();
      savePrefsSoon();
    });
    dom.bundle.addEventListener("input", function () {
      state.dl.bundleName = dom.bundle.value;
      renderDownloadPreview();
      savePrefsSoon();
    });

    dom.dlStart.addEventListener("click", startDownload);
    dom.dlCancel.addEventListener("click", cancelJob);
    dom.dlOpen.addEventListener("click", openJobFolder);
    dom.dlFinish.addEventListener("click", closeProgressAndFinish);

    // 设置弹窗
    dom.settings.addEventListener("click", openSettings);
    dom.authBtn.addEventListener("click", openSettings);
    dom.settingsModal.addEventListener("click", function (event) {
      if (event.target === dom.settingsModal) closeSettings();
    });
    dom.settingsModal.addEventListener("click", function (event) {
      var closer = event.target.closest ? event.target.closest('[data-close="settings"]') : null;
      if (closer) {
        event.preventDefault();
        closeSettings();
      }
    });
    dom.tokenTest.addEventListener("click", testTokenFromInput);
    dom.tokenSave.addEventListener("click", saveToken);
    dom.tokenClear.addEventListener("click", clearToken);
    dom.networkSave.addEventListener("click", saveNetwork);
    dom.token.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        saveToken();
      }
    });

    // Esc 关闭当前弹窗；捕获阶段先处理，避免宿主把整个搜索窗关掉。
    rootEl.addEventListener(
      "keydown",
      function (event) {
        if (!alive()) return;
        if (event.key !== "Escape") return;
        if (!dom.settingsModal.hidden) {
          event.preventDefault();
          event.stopPropagation();
          closeSettings();
        } else if (!dom.downloadModal.hidden) {
          event.preventDefault();
          event.stopPropagation();
          closeDownloadModal();
        }
      },
      true
    );

    window.addEventListener("pagehide", cleanup);
  }

  function cleanup() {
    state.disposed = true;
    clearTimeout(searchTimer);
    clearTimeout(prefsTimer);
    clearTimeout(feedTimer);
    stopJobPolling();
    notificationOffs.forEach(function (off) {
      try {
        off();
      } catch (e) {
        /* ignore */
      }
    });
    notificationOffs = [];
  }

  // ===================== 初始化 =====================
  function normalizeUserQuery(raw) {
    var value = String(raw == null ? "" : raw).trim();
    var kw = String(keyword == null ? "" : keyword).trim();
    if (!value) return "";
    if (kw && value !== kw) {
      var escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      var re = new RegExp("^\\s*" + escaped + "\\s*[:：]?\\s*", "i");
      if (re.test(value)) value = value.replace(re, "").trim();
    }
    if (value === kw) return "";
    var repoUrl = value.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)/i);
    if (repoUrl) return "repo:" + repoUrl[1] + "/" + repoUrl[2].replace(/\.git$/i, "");
    return value;
  }

  function initialInput() {
    var raw = String(inputValue == null ? "" : inputValue).trim();
    if (!raw) return "";
    return normalizeUserQuery(raw);
  }

  function setupSubKeyword() {
    if (typeof onSubKeyword !== "function") return;
    try {
      onSubKeyword(function (message) {
        if (state.disposed) return false;
        var value = normalizeUserQuery(String(message == null ? "" : message));
        if (!value) return true;
        dom.q.value = value;
        state.text = value;
        updateClearButton();
        doSearch({ reset: true });
        return true;
      });
    } catch (e) {
      /* ignore */
    }
  }

  function init() {
    bindEvents();
    loadPrefs();
    applyFiltersToControls();
    applyDlToControls();
    renderSearchButton();

    var initial = initialInput();
    if (initial) {
      state.text = initial;
      dom.q.value = initial;
      updateClearButton();
    } else {
      loadLastFeed();
    }

    renderAll();
    setupSubKeyword();
    registerNotifications();
    updateClearButton();
    renderFooter();

    loadConfig({ populateInputs: false }).then(function () {
      restoreJob();
    });

    if (initial) doSearch({ reset: true });

    setTimeout(function () {
      if (state.disposed) return;
      if (!dom.downloadModal.hidden || !dom.settingsModal.hidden) return;
      dom.q.focus();
    }, 80);
  }

  init();
})(ms, env, plugin, host, keyword, inputValue, onSubKeyword, md2html, openExternal);
