/**
 * 剪贴板历史插件 - 前台入口脚本
 *
 * 宿主注入参数: ms, env, plugin, host, keyword, inputValue, onSubKeyword, md2html, openExternal
 * （宿主用 `new Function("ms","env","plugin","host",... , code)` 调用本文件，
 *  所以下面 IIFE 的形参声明 + 末尾实参回传是必需的：既拿到注入值，
 *  又让本文件能被当普通 <script> 直接加载调试。）
 *
 * ============================ 这个插件做了什么 ============================
 *
 * 前台只有一件事：**展示并操作剪贴板历史**——
 *
 *   1) **列表（分页）**：`ms.clipboard.page()` 每次拿 30 条（`PAGE_SIZE`），
 *      文本直接渲染预览，图片懒加载缩略图。滚动到底部由 IntersectionObserver
 *      自动追加下一页（触底加载更多），直到 `hasMore` 为假。
 *      老宿主没有 `page` 命令时退回 `list()` 全量 + 本地切片，功能不缺失。
 *   2) **搜索**：输入关键词交给宿主**先过滤再分页**，前端即时呈现。
 *   3) **复制 / 删除 / 清空**：分别走 `ms.clipboard.copy/remove/clear`。
 *      其中 **copy 是唯一会写系统剪贴板的动作，且必须由用户点击触发**——
 *      宿主的监听路径是纯只读的，绝不会在你复制别的东西时把剪贴板改掉。
 *   4) **收藏**：`ms.clipboard.setFavorite(id, on)` 打标（收藏/取消都先确认）；
 *      顶部「全部 / 收藏」标签切换时从第一页重拉（过滤在宿主侧）。
 *      收藏条目在宿主侧永久保留（不参与上限淘汰），「清空」默认也保留收藏。
 *   5) **呼出快捷键**：读写宿主「剪贴板历史」动作的绑定（`ms.clipboard.getShortcut/
 *      setShortcut`），不自己存一份，因而与「设置 → 快捷键」永远一致。
 *   6) **自动刷新**：视图开着时，宿主原监听到剪贴板变更会广播
 *      `my-search://clipboard-updated`，`ms.clipboard.onUpdated` 收到后重拉第一页。
 *      视图没开时事件自然丢弃，下次打开 list/page 兜底——所以不需要常驻轮询。
 *
 * ============================ 数据放在哪 ============================
 *
 * 文本索引：`<app_data>/plugin-data/com.mysearch.clipboard/clipboard/index.json`
 * 图片文件：`<app_data>/plugin-data/com.mysearch.clipboard/clipboard/*.png`
 *   —— 宿主原生监听在 Rust 侧读写；插件只能拿到相对路径与 data URL，
 *   拿不到也拼不出私有目录之外的任何路径（防目录穿越）。
 * 界面偏好：`ms.store`（localStorage，按插件 id 命名空间隔离），例如搜索词。
 */
(function (ms, env, plugin, host, keyword, inputValue, onSubKeyword, md2html, openExternal) {
  "use strict";

  /* ======================= 常量 ======================= */

  /** 图片缩略图并发上限：一次别把几十张图全读进来（每张都是完整 PNG 的 base64） */
  var THUMB_CONCURRENCY = 4;

  /* ======================= DOM ======================= */
  var dom = {};
  ["cb-status", "cb-meta", "cb-list", "cb-empty", "cb-empty-text", "cb-empty-key",
   "cb-search", "cb-refresh", "cb-clear", "cb-hotkey-btn", "cb-hotkey-clear",
   "cb-viewer", "cb-viewer-img", "cb-viewer-name", "cb-tabs", "cb-fav-count"].forEach(function (id) {
    dom[id] = document.getElementById(id);
  });
  /** 本实例根节点：会话被宿主「保活」后旧实例仍在内存里，靠它判活（别打扰新实例） */
  var rootEl = document.getElementById("app");

  /** 每页条数（触底加载更多每次追加这么多） */
  var PAGE_SIZE = 30;

  /* ======================= 状态 ======================= */
  /** 已加载的条目（宿主已按时间从新到旧排序；跨页累积） */
  var items = [];
  /** 当前过滤条件下的**总条数**（由宿主返回，非已加载数） */
  var total = 0;
  /** 是否还有下一页（触底加载的依据） */
  var hasMore = false;
  /** 收藏总条数（供「收藏」标签徽标；单独向宿主取，与当前页无关） */
  var favTotal = 0;
  /** 当前搜索词 */
  var query = "";
  /** 当前标签："all" = 全部历史，"fav" = 只看收藏 */
  var filter = "all";
  /** 正在刷新/加载（防重入） */
  var loading = false;
  /** 待重扫标记：刷新中又有新事件时，等这轮结束再补一次 */
  var pendingReload = false;
  /** 大图预览当前项 */
  var viewerItem = null;
  /** 缩略图缓存：relPath → dataUrl（避免重复读同一张） */
  var thumbCache = {};

  /* ======================= 小工具 ======================= */

  /** 当前视图是否还活着（宿主关闭视图 / 换插件后旧实例要停止动作） */
  function alive() {
    return !!rootEl && rootEl.isConnected;
  }

  /** 写状态行（只放异常/过程消息；成功后清空并整行隐藏，不留空行） */
  function setStatus(text, isError) {
    if (!dom["cb-status"]) return;
    if (!text) {
      dom["cb-status"].textContent = "";
      dom["cb-status"].hidden = true;
      dom["cb-status"].classList.remove("error");
      return;
    }
    dom["cb-status"].textContent = text;
    dom["cb-status"].hidden = false;
    dom["cb-status"].classList.toggle("error", !!isError);
  }

  /** 错误对象 → 可读文本（宿主抛的是带中文 message 的 Error） */
  function errorText(e) {
    if (!e) return "未知错误";
    return String(e.message || e);
  }

  /** 毫秒时间戳 → 本地「MM-DD HH:mm」 */
  function formatTime(ms) {
    var d = new Date(Number(ms) || 0);
    if (isNaN(d.getTime())) return "";
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  /** 字节数 → 人类可读（图片尺寸行用） */
  function formatBytes(n) {
    var v = Number(n) || 0;
    if (v < 1024) return v + " B";
    if (v < 1024 * 1024) return (v / 1024).toFixed(1) + " KB";
    return (v / 1024 / 1024).toFixed(1) + " MB";
  }

  /** 把「ctrl+alt+v」转为展示形态「Ctrl+Alt+V」 */
  function prettyShortcut(key) {
    return String(key || "")
      .split("+")
      .filter(function (s) { return s !== ""; })
      .map(function (token) {
        if (token.length === 1) return token.toUpperCase();
        return token.charAt(0).toUpperCase() + token.slice(1);
      })
      .join("+");
  }

  /** 转义 HTML（文本历史直接渲染，必须防注入） */
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /* ======================= 列表渲染 ======================= */

  /** 单条的历史展示文案（文本预览 / 图片来源行） */
  function itemSubline(it) {
    if (it.kind === "image") {
      var dim = (it.width && it.height) ? (it.width + "×" + it.height + " · ") : "";
      return dim + formatBytes(it.size) + " · " + formatTime(it.createdAt);
    }
    var chars = it.text ? it.text.length : 0;
    return chars + " 字 · " + formatTime(it.createdAt);
  }

  /** 当前标签下已在内存里的条目（Rust 侧已按标签过滤，这里直接返回） */
  function visibleItems() {
    return items;
  }

  /** 同步标签高亮与收藏计数徽标 */
  function renderTabs() {
    var tabs = dom["cb-tabs"];
    if (tabs) {
      var btns = tabs.querySelectorAll(".cb-tab");
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle("active", btns[i].getAttribute("data-tab") === filter);
      }
    }
    var badge = dom["cb-fav-count"];
    if (badge) {
      // favTotal 由宿主单独统计（收藏可能不在当前已加载页里，不能靠 items 数）
      badge.textContent = favTotal > 0 ? String(favTotal) : "";
      badge.hidden = favTotal === 0;
    }
  }

  /** 渲染整个列表 */
  function render() {
    var list = dom["cb-list"];
    var empty = dom["cb-empty"];
    if (!list) return;

    renderTabs();

    var shown = visibleItems();

    if (dom["cb-meta"]) {
      if (!total) {
        dom["cb-meta"].textContent = "";
      } else {
        // 显示「已加载 / 总数」，让用户知道还有多少没滚出来
        var prefix = filter === "fav" ? "收藏 " : "共 ";
        var text = prefix + total + " 条";
        if (shown.length < total) text += "（已显示 " + shown.length + "）";
        dom["cb-meta"].textContent = text + (query ? "（匹配「" + query + "」）" : "");
      }
    }

    if (!shown.length) {
      list.innerHTML = "";
      if (empty) {
        empty.hidden = false;
        if (dom["cb-empty-text"]) {
          if (query) dom["cb-empty-text"].textContent = "没有匹配「" + query + "」的历史。";
          else if (filter === "fav") dom["cb-empty-text"].textContent = "还没有收藏任何内容。";
          else dom["cb-empty-text"].textContent = "还没有剪贴板历史。";
        }
      }
      if (dom["cb-clear"]) dom["cb-clear"].disabled = true;
      return;
    }
    if (empty) empty.hidden = true;
    if (dom["cb-clear"]) dom["cb-clear"].disabled = false;

    var html = "";
    for (var i = 0; i < shown.length; i++) {
      var it = shown[i];
      var isImg = it.kind === "image";
      var isFav = it.favorite === true;
      var preview = isImg
        ? ""
        : '<div class="cb-item-text">' + escapeHtml(it.text || "") + "</div>";
      var sourceLine = it.source
        ? '<div class="cb-item-sub">' + escapeHtml(it.source) + "</div>"
        : "";
      html +=
        '<div class="cb-item" data-id="' + escapeHtml(it.id) + '" data-kind="' + escapeHtml(it.kind) + '"' +
          (it.relPath ? ' data-rel-path="' + escapeHtml(it.relPath) + '"' : "") + ">" +
          '<div class="cb-item-kind">' + (isImg ? "图片" : "文本") + "</div>" +
          '<div class="cb-item-body">' +
            preview +
            sourceLine +
            '<div class="cb-item-sub">' + escapeHtml(itemSubline(it)) + "</div>" +
          "</div>" +
          '<div class="cb-item-actions">' +
            '<button class="cb-item-btn fav' + (isFav ? " on" : "") + '" data-act="fav" title="' +
              (isFav ? "取消收藏" : "收藏") + '">' + (isFav ? "★" : "☆") + "</button>" +
            '<button class="cb-item-btn" data-act="copy" title="复制到剪贴板">复制</button>' +
            '<button class="cb-item-btn del" data-act="del" title="删除这条">删除</button>' +
          "</div>" +
        "</div>";
    }
    // 底部哨兵：触底加载更多时显示「加载中… / 已全部加载」
    html += '<div id="cb-sentinel" class="cb-sentinel">' +
      (hasMore ? "加载中…" : "已全部加载") + "</div>";
    list.innerHTML = html;

    // 图片缩略图懒加载（并发受限）
    loadVisibleThumbs();

    // 重排后哨兵位置可能变化，重新评估一次是否需要继续加载
    scheduleSentinelCheck();
  }

  /** 为列表里的图片项按并发上限加载缩略图 */
  function loadVisibleThumbs() {
    var pending = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.kind !== "image" || !it.relPath) continue;
      if (thumbCache[it.relPath]) continue;
      pending.push(it.relPath);
    }
    var next = 0;
    function worker() {
      if (!alive()) return;
      var rel = pending[next++];
      if (rel === undefined) return;
      if (thumbCache[rel]) { worker(); return; }
      Promise.resolve(ms.clipboard.readImage(rel))
        .then(function (dataUrl) {
          if (!alive()) return;
          thumbCache[rel] = dataUrl;
          applyThumb(rel, dataUrl);
        })
        .catch(function () { /* 单张读失败不影响其它 */ })
        .then(worker);
    }
    for (var w = 0; w < Math.min(THUMB_CONCURRENCY, pending.length); w++) worker();
  }

  /** 把读到的缩略图填进对应条目的占位块（按 data-rel-path 精确定位） */
  function applyThumb(rel, dataUrl) {
    var list = dom["cb-list"];
    if (!list) return;
    var node = list.querySelector('[data-rel-path="' + cssEscape(rel) + '"] .cb-item-kind');
    if (!node) return;
    node.innerHTML = '<img alt="" src="' + dataUrl + '">';
  }

  /** CSS.escape 兜底（老 WebView 可能没有） */
  function cssEscape(s) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(s);
    return String(s).replace(/["\\]/g, "\\$&");
  }

  /* ======================= 触底加载（自动无限滚） ======================= */
  //
  // 用 IntersectionObserver 监听列表底部的哨兵节点：当它进入视口（或接近视口）
  // 就加载下一页。相比监听 scroll 事件，它由浏览器在合成层判断，不受插件视图
  // 高度/滚动容器变化影响，且不产生滚动回调的开销。
  //
  // 注意：插件的滚动容器是 `.cb-app` 自身（宿主给它固定 max-height + overflow-y），
  // 因此 `root` 传该元素，`rootMargin` 留一点提前量，滚到距底 ~120px 就预加载。
  var sentinelObserver = null;

  /** 确保观察器存在（懒创建，且只创建一次） */
  function ensureSentinelObserver() {
    if (sentinelObserver || typeof IntersectionObserver !== "function") return;
    var scroller = document.querySelector(".cb-app");
    sentinelObserver = new IntersectionObserver(function (entries) {
      if (!alive()) return;
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) { loadMore(); return; }
      }
    }, { root: scroller || null, rootMargin: "0px 0px 120px 0px", threshold: 0 });
  }

  /**
   * 重新把哨兵挂到观察器上。
   *
   * 每次 render() 都会重建列表 DOM，旧哨兵节点被替换，观察器必须重新绑定；
   * 另外首屏若一页没填满视口（无可滚动区域），IntersectionObserver 不会触发，
   * 这里用一次手动检查兜底，避免「列表明明还有更多却卡住」。
   */
  function scheduleSentinelCheck() {
    ensureSentinelObserver();
    if (!sentinelObserver) {
      // 极老 WebView 没有 IntersectionObserver：退回滚动事件监听
      bindScrollFallback();
      return;
    }
    var sentinel = document.getElementById("cb-sentinel");
    if (!sentinel) return;
    sentinelObserver.disconnect();
    sentinelObserver.observe(sentinel);
  }

  /** 无 IntersectionObserver 时的兜底：监听 .cb-app 滚动，接近底部就加载 */
  var scrollFallbackBound = false;
  function bindScrollFallback() {
    if (scrollFallbackBound) return;
    var scroller = document.querySelector(".cb-app");
    if (!scroller) return;
    scrollFallbackBound = true;
    scroller.addEventListener("scroll", function () {
      if (!alive() || loading || !hasMore) return;
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 120) loadMore();
    });
  }

  /* ======================= 数据加载（分页） ======================= */

  /** 宿主的「分页」能力是否可用（老宿主只有 list，用它兜底） */
  function canPage() {
    return typeof ms.clipboard?.page === "function";
  }

  /**
   * 拉取「第 offset 条起的一页」。
   *
   * 有 `page` 能力时走真分页（宿主在**过滤之后**再切片，返回 total/hasMore）；
   * 老宿主没有该命令时退回 list()：一次拿全量，前端自己切，
   * 保证功能在旧宿主上也能用（只是没有服务端分页的内存收益）。
   */
  function fetchPage(offset, limit) {
    if (canPage()) {
      return Promise.resolve(ms.clipboard.page({
        query: query,
        favoriteOnly: filter === "fav",
        offset: offset,
        limit: limit,
      })).then(function (p) {
        p = p || {};
        return {
          items: Array.isArray(p.items) ? p.items : [],
          total: Number(p.total) || 0,
          hasMore: !!p.hasMore,
        };
      });
    }
    // 兜底：老宿主 list() 返回全量数组，本地过滤 + 切片
    return Promise.resolve(ms.clipboard.list(query)).then(function (list) {
      var all = Array.isArray(list) ? list : [];
      if (filter === "fav") all = all.filter(function (it) { return it.favorite === true; });
      var page = all.slice(offset, offset + limit);
      return {
        items: page,
        total: all.length,
        hasMore: offset + page.length < all.length,
      };
    });
  }

  /** 重新从第一页拉取（搜索词 / 标签变化、删除、清空、外部更新后调用） */
  function reload(showStatus, q) {
    if (typeof q === "string") query = q;
    if (loading) { pendingReload = true; return; }
    loading = true;
    if (showStatus) setStatus("正在刷新…");

    Promise.all([fetchPage(0, PAGE_SIZE), fetchFavoriteTotal()])
      .then(function (res) {
        if (!alive()) return;
        var page = res[0];
        items = page.items;
        total = page.total;
        hasMore = page.hasMore;
        render();
        if (showStatus) setStatus("");
      })
      .catch(function (e) {
        if (!alive()) return;
        setStatus("读取剪贴板历史失败：" + errorText(e), true);
      })
      .then(function () {
        loading = false;
        if (pendingReload) {
          pendingReload = false;
          reload(false);
        }
      });
  }

  /**
   * 触底加载下一页（追加到现有列表，不闪、不清空）。
   *
   * 用 `loading` 防重入：滚动事件会高频触发，同一时刻只允许一页在途。
   */
  function loadMore() {
    if (loading || !hasMore) return;
    loading = true;
    Promise.resolve(fetchPage(items.length, PAGE_SIZE))
      .then(function (page) {
        if (!alive()) return;
        items = items.concat(page.items);
        total = page.total;
        hasMore = page.hasMore;
        render();
      })
      .catch(function (e) {
        if (!alive()) return;
        setStatus("加载更多失败：" + errorText(e), true);
      })
      .then(function () { loading = false; });
  }

  /** 取收藏总数（仅用于「收藏」标签徽标；失败不影响主流程） */
  function fetchFavoriteTotal() {
    if (!canPage()) {
      // 老宿主：从 list() 全量里数
      return Promise.resolve(ms.clipboard.list())
        .then(function (list) {
          var n = 0;
          (Array.isArray(list) ? list : []).forEach(function (it) { if (it.favorite) n++; });
          favTotal = n;
        })
        .catch(function () { /* 忽略 */ });
    }
    return Promise.resolve(ms.clipboard.page({ favoriteOnly: true, offset: 0, limit: 1 }))
      .then(function (p) { favTotal = Number(p && p.total) || 0; })
      .catch(function () { /* 忽略 */ });
  }

  /* ======================= 条目操作 ======================= */

  /** 复制某条到系统剪贴板（用户点击触发；这是唯一会写剪贴板的路径） */
  function copyItem(it) {
    Promise.resolve(ms.clipboard.copy(it.id))
      .then(function () {
        setStatus("已复制到剪贴板");
        setTimeout(function () { if (alive()) setStatus(""); }, 2000);
      })
      .catch(function (e) { setStatus("复制失败：" + errorText(e), true); });
  }

  /** 删除某条（先确认） */
  function removeItem(it) {
    var label = it.kind === "image" ? "这张图片" : "这条文本";
    Promise.resolve(ms.ui && ms.ui.confirm ? ms.ui.confirm("删除" + label + "？") : true)
      .then(function (ok) {
        if (ok === false) return null;
        return Promise.resolve(ms.clipboard.remove(it.id));
      })
      .then(function (r) {
        if (r === null) return; // 用户取消
        if (viewerItem && viewerItem.id === it.id) closeViewer();
        reload(false);
      })
      .catch(function (e) { setStatus("删除失败：" + errorText(e), true); });
  }

  /** 收藏 / 取消收藏某条。
   *
   *  先弹确认框（收藏 / 取消收藏都要确认），确认后才本地切换并重渲染
   *  （即时反馈），再通知宿主落盘；失败则回滚。
   *  成功后不弹状态提示；宿主保存后也会广播 clipboard-updated，重拉的列表
   *  与本地状态一致。
   *
   *  计数维护：收藏数加减 1；在「收藏」标签下取消收藏会把该条从当前列表移除，
   *  否则会出现「已取消收藏却还留在收藏列表里」的错觉。 */
  function toggleFavorite(it) {
    if (typeof ms.clipboard?.setFavorite !== "function") {
      setStatus("当前宿主版本不支持收藏，请升级", true);
      return;
    }
    var next = !(it.favorite === true);
    var ask = next
      ? "收藏这条内容？收藏后不会被上限淘汰，清空时也会保留。"
      : "取消收藏这条内容？";
    Promise.resolve(ms.ui && ms.ui.confirm ? ms.ui.confirm(ask) : true)
      .then(function (ok) {
        if (ok === false) return null;
        it.favorite = next;
        favTotal = Math.max(0, favTotal + (next ? 1 : -1));
        if (filter === "fav" && !next) {
          // 收藏标签下取消收藏：从列表移除该条，并递减总数
          items = items.filter(function (x) { return x.id !== it.id; });
          total = Math.max(0, total - 1);
        }
        render();
        return Promise.resolve(ms.clipboard.setFavorite(it.id, next));
      })
      .then(function (r) {
        if (r === null) return; // 用户取消：不动
      })
      .catch(function (e) {
        // 回滚：把标记与计数改回去，避免界面与磁盘不一致
        it.favorite = !next;
        favTotal = Math.max(0, favTotal + (next ? -1 : 1));
        loadFirstPageQuiet();
        setStatus((next ? "收藏失败：" : "取消收藏失败：") + errorText(e), true);
      });
  }

  /** 静默重拉第一页（失败回滚后校正列表，不显示状态） */
  function loadFirstPageQuiet() {
    if (loading) { pendingReload = true; return; }
    loading = true;
    Promise.resolve(fetchPage(0, PAGE_SIZE))
      .then(function (page) {
        if (!alive()) return;
        items = page.items;
        total = page.total;
        hasMore = page.hasMore;
        render();
      })
      .catch(function () { /* 静默：回滚路径不再叠加报错 */ })
      .then(function () { loading = false; });
  }

  /** 清空历史（保留收藏条目；确认框里讲清楚）。 */
  function clearAll() {
    var favCount = favTotal;
    var msg = favCount
      ? "清空未收藏的剪贴板历史？\n\n已收藏的 " + favCount + " 条会保留。此操作不可撤销。"
      : "清空全部剪贴板历史？此操作不可撤销。";
    Promise.resolve(ms.ui && ms.ui.confirm ? ms.ui.confirm(msg) : true)
      .then(function (ok) {
        if (ok === false) return null;
        // keepFavorites=true：收藏条目永久保留（宿主侧同步实现）
        return Promise.resolve(ms.clipboard.clear({ keepFavorites: true }));
      })
      .then(function (r) {
        if (r === null) return;
        thumbCache = {};
        reload(false);
        setStatus(favCount ? "已清空未收藏的历史（收藏已保留）" : "已清空剪贴板历史");
        setTimeout(function () { if (alive()) setStatus(""); }, 2000);
      })
      .catch(function (e) { setStatus("清空失败：" + errorText(e), true); });
  }

  /* ======================= 图片大图预览 ======================= */

  function openViewer(it) {
    if (!dom["cb-viewer"] || !it.relPath) return;
    viewerItem = it;
    if (dom["cb-viewer-name"]) {
      dom["cb-viewer-name"].textContent =
        (it.width && it.height ? it.width + "×" + it.height + " · " : "") + formatTime(it.createdAt);
    }
    if (dom["cb-viewer-img"]) dom["cb-viewer-img"].src = "";
    dom["cb-viewer"].hidden = false;

    var rel = it.relPath;
    Promise.resolve(ms.clipboard.readImage(rel))
      .then(function (dataUrl) {
        if (!alive() || !dom["cb-viewer-img"]) return;
        if (!viewerItem || viewerItem.relPath !== rel) return; // 期间换了目标
        dom["cb-viewer-img"].src = dataUrl;
      })
      .catch(function (e) { setStatus("加载图片失败：" + errorText(e), true); });
  }

  function closeViewer() {
    if (!dom["cb-viewer"]) return;
    dom["cb-viewer"].hidden = true;
    if (dom["cb-viewer-img"]) dom["cb-viewer-img"].src = "";
    viewerItem = null;
  }

  /** 把预览中的图片复制到剪贴板 */
  function copyViewer() {
    if (!viewerItem) return;
    copyItem(viewerItem);
  }

  /* ======================= 快捷键 ======================= */

  /** 显示当前绑定的呼出热键 */
  function renderHotkey(key) {
    var btn = dom["cb-hotkey-btn"];
    var clear = dom["cb-hotkey-clear"];
    var emptyKey = dom["cb-empty-key"];
    if (btn) {
      btn.textContent = key ? prettyShortcut(key) : "未设置";
      btn.classList.remove("capturing", "invalid");
    }
    if (clear) clear.hidden = !key;
    if (emptyKey) emptyKey.textContent = key ? prettyShortcut(key) : "快捷键";
  }

  /** 拉取当前热键（权威在宿主 settings.json，可能被别的入口改过，每次重读） */
  function loadHotkey() {
    if (typeof ms.clipboard?.getShortcut !== "function") return;
    Promise.resolve(ms.clipboard.getShortcut())
      .then(function (key) { if (alive()) renderHotkey(key); })
      .catch(function () { /* 读不到保持原样，不打扰用户 */ });
  }

  /**
   * 录入新热键：点击后监听下一次 keydown，取「修饰键 + 主键」拼成宿主格式。
   * 只认带修饰键的组合（与宿主面板一致：单一主键做全局热键太易误触/冲突）。
   *
   * 主键优先用 `e.code`（KeyV / Digit1 / ArrowDown / Space …）——这正是宿主
   * 后端 `global-hotkey` 白名单认的命名；只有 `code` 缺失时才回退 `e.key`。
   * 用 `e.key` 直接拼会在方向键 / 空格等键上得到宿主不认的名字（箭头键得到
   * "arrowdown"、空格得到 " "），导致「改绑后按下去没反应」。
   */
  function startCapture() {
    var btn = dom["cb-hotkey-btn"];
    if (!btn || btn.classList.contains("capturing")) return;
    btn.classList.add("capturing");
    btn.textContent = "按下组合键…";

    function onKey(e) {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape" || e.code === "Escape") {
        cleanup();
        loadHotkey();
        return;
      }

      var parts = [];
      if (e.ctrlKey) parts.push("ctrl");
      if (e.altKey) parts.push("alt");
      if (e.shiftKey) parts.push("shift");
      if (e.metaKey) parts.push("super");

      // 只按了修饰键本身：继续等主键
      var modKeys = ["Control", "Alt", "Shift", "Meta"];
      if (modKeys.indexOf(e.key) >= 0) return;
      if (/^(Control|Alt|Shift|Meta)(Left|Right)$/.test(e.code || "")) return;

      var main = mainKeyOf(e);
      if (!main) return;

      parts.push(main);

      if (parts.length < 2) {
        btn.classList.add("invalid");
        btn.textContent = "需要带修饰键（如 Ctrl+Alt+V）";
        return;
      }

      cleanup();
      applyHotkey(parts.join("+"));
    }

    function cleanup() {
      document.removeEventListener("keydown", onKey, true);
      btn.classList.remove("capturing", "invalid");
    }

    document.addEventListener("keydown", onKey, true);
  }

  /** 取主键名（优先 e.code，回退 e.key），归一成宿主 global-hotkey 认的形式 */
  function mainKeyOf(e) {
    var code = typeof e.code === "string" ? e.code : "";
    if (code) {
      var letter = code.match(/^Key([A-Z])$/);
      if (letter) return letter[1].toLowerCase();
      var digit = code.match(/^Digit([0-9])$/);
      if (digit) return digit[1];
      // 其余 code（ArrowDown / Space / F5 / Backquote …）原样小写交给宿主校验
      return code.toLowerCase();
    }
    var key = typeof e.key === "string" ? e.key : "";
    if (!key) return "";
    if (key === " ") return "space";
    return key.length === 1 ? key.toLowerCase() : key.toLowerCase();
  }

  /** 提交新热键给宿主（冲突等错误原样展示） */
  function applyHotkey(combo) {
    if (typeof ms.clipboard?.setShortcut !== "function") {
      setStatus("当前宿主版本不支持在插件内改快捷键，请到「设置 → 快捷键」修改", true);
      loadHotkey();
      return;
    }
    Promise.resolve(ms.clipboard.setShortcut(combo))
      .then(function (effective) {
        renderHotkey(effective || combo);
        setStatus("已绑定呼出快捷键：" + prettyShortcut(effective || combo));
        setTimeout(function () { if (alive()) setStatus(""); }, 2500);
      })
      .catch(function (e) {
        setStatus("快捷键设置失败：" + errorText(e), true);
        loadHotkey();
      });
  }

  /** 解绑（关掉全局呼出热键） */
  function clearHotkey() {
    if (typeof ms.clipboard?.setShortcut !== "function") return;
    Promise.resolve(ms.clipboard.setShortcut(""))
      .then(function () {
        renderHotkey("");
        setStatus("已解绑呼出快捷键");
        setTimeout(function () { if (alive()) setStatus(""); }, 2000);
      })
      .catch(function (e) { setStatus("解绑失败：" + errorText(e), true); });
  }

  /* ======================= 事件绑定 ======================= */

  function bind() {
    dom["cb-hotkey-btn"]?.addEventListener("click", startCapture);
    dom["cb-hotkey-clear"]?.addEventListener("click", clearHotkey);
    dom["cb-refresh"]?.addEventListener("click", function () { reload(true); });
    dom["cb-clear"]?.addEventListener("click", clearAll);

    // 标签：全部 / 收藏（过滤在宿主侧完成，切换后从第一页重拉）
    dom["cb-tabs"]?.addEventListener("click", function (e) {
      var btn = e.target.closest(".cb-tab[data-tab]");
      if (!btn) return;
      var tab = btn.getAttribute("data-tab");
      if (tab !== "all" && tab !== "fav") return;
      if (tab === filter) return;
      filter = tab;
      persistFilter(tab);
      // 从头拉：避免把另一个标签的已加载页混进当前列表
      reload(false);
    });

    // 搜索：输入即筛（交给宿主 Rust 侧粗筛，避免前端遍历大文本）
    var searchTimer = null;
    dom["cb-search"]?.addEventListener("input", function (e) {
      var v = String(e.target.value || "");
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        if (!alive()) return;
        persistQuery(v);
        reload(false, v);
      }, 200);
    });

    // 列表事件委托：收藏 / 复制 / 删除 / 点图片看大图
    dom["cb-list"]?.addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-act]");
      var row = e.target.closest(".cb-item");
      if (!row) return;
      var id = row.getAttribute("data-id");
      var it = findItem(id);
      if (!it) return;
      if (btn) {
        e.stopPropagation();
        var act = btn.getAttribute("data-act");
        if (act === "copy") copyItem(it);
        else if (act === "del") removeItem(it);
        else if (act === "fav") toggleFavorite(it);
        return;
      }
      // 点条目本身：图片看大图，文本直接复制
      if (it.kind === "image") openViewer(it);
      else copyItem(it);
    });

    dom["cb-viewer-close"]?.addEventListener("click", closeViewer);
    dom["cb-viewer"]?.addEventListener("click", function (e) {
      if (e.target === dom["cb-viewer"]) closeViewer();
    });
    dom["cb-viewer-copy"]?.addEventListener("click", copyViewer);

    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if (dom["cb-viewer"] && !dom["cb-viewer"].hidden) {
        e.preventDefault();
        closeViewer();
      }
    });
  }

  /** 按 id 在当前列表里找条目 */
  function findItem(id) {
    for (var i = 0; i < items.length; i++) {
      if (items[i].id === id) return items[i];
    }
    return null;
  }

  /* ======================= 偏好持久化 ======================= */

  function persistQuery(v) {
    try { ms.store?.set("query", v); } catch (e) { /* 未授权：忽略 */ }
  }

  function restoreQuery() {
    try {
      var saved = ms.store?.get("query", "");
      if (typeof saved === "string" && saved) {
        query = saved;
        if (dom["cb-search"]) dom["cb-search"].value = saved;
      }
    } catch (e) { /* 忽略 */ }
  }

  function persistFilter(v) {
    try { ms.store?.set("filter", v); } catch (e) { /* 未授权：忽略 */ }
  }

  /** 恢复上次停留的标签（记住用户习惯，默认「全部」） */
  function restoreFilter() {
    try {
      var saved = ms.store?.get("filter", "all");
      if (saved === "fav" || saved === "all") filter = saved;
    } catch (e) { /* 忽略 */ }
  }

  /* ======================= 启动 ======================= */

  bind();
  restoreQuery();
  restoreFilter();
  loadHotkey();
  reload(false);

  /**
   * 宿主原生监听到剪贴板变更后广播 → 自动刷新。
   * 视图没打开时事件丢弃，下次打开 list() 兜底，因此不必常驻轮询。
   */
  if (typeof ms.clipboard?.onUpdated === "function") {
    ms.clipboard.onUpdated(function () {
      if (!alive()) return;
      reload(false);
    });
  }

  ms.log("info", "剪贴板历史插件已加载" + (plugin && plugin.id ? "（" + plugin.id + "）" : ""));
})(ms, env, plugin, host, keyword, inputValue, onSubKeyword, md2html, openExternal);
