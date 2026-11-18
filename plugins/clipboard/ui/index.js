/**
 * 剪贴板历史插件 - 前台入口脚本（领域自治版）
 *
 * 宿主注入参数: ms, env, plugin, host, keyword, inputValue, onSubKeyword, md2html, openExternal
 *
 * ============================ 架构边界 ============================
 *
 * 「系统原语归宿主，业务逻辑归插件」：
 *   1) **宿主原语层**（`ms.clipboard.list / readImage / copy / remove / clear / setRetained`）：
 *      仅负责按需监听系统剪贴板、捕获原始文本/图片帧、按插件声明的 `retained` ID 集合豁免环形缓冲淘汰。
 *      宿主不再感知「收藏」「分类」「文本二次编辑」「多维分页」等业务概念。
 *   2) **插件领域层**（本文件）：
 *      在插件自身的 `kv/annotations.json`（经 `ms.store.readJson/writeJson` 持久化，随 `.msbackup` 备份）
 *      中独立维护每条记录的 `{ favorite, category, editedText }`，并在启动时一次性接管历史版本迁移文件
 *      `annotations.legacy`；所有标签切换、分类聚合、编辑草稿与分页均由插件自主完成。
 *   3) **通用热键通道**：通过 `ms.shortcuts.get("clipboard") / set("clipboard", combo)` 读写全局快捷键。
 */
(function (ms, env, plugin, host, keyword, inputValue, onSubKeyword, md2html, openExternal) {
  "use strict";

  /* ======================= 常量 ======================= */

  var THUMB_CONCURRENCY = 4;
  var PAGE_SIZE = 30;
  var MAX_TEXT_CHARS = 100000;
  var ANNOTATIONS_KEY = "annotations";
  var LEGACY_ANNOTATIONS_KEY = "annotations.legacy";

  /* ======================= DOM ======================= */
  var dom = {};
  ["cb-status", "cb-meta", "cb-list", "cb-empty", "cb-empty-text", "cb-empty-key",
   "cb-search", "cb-refresh", "cb-clear", "cb-hotkey-btn", "cb-hotkey-clear",
   "cb-viewer", "cb-viewer-img", "cb-viewer-name", "cb-viewer-close", "cb-viewer-copy",
   "cb-tabs", "cb-fav-count", "cb-cats", "cb-cat-options"].forEach(function (id) {
    dom[id] = document.getElementById(id);
  });
  var rootEl = document.getElementById("app");

  /* ======================= 状态 ======================= */
  /** 当前过滤条件下已展示的条目（跨页累积，从新到旧） */
  var items = [];
  /** 最近一次从宿主拉回并合并完插件注解的全量条目（从新到旧） */
  var allMerged = [];
  /** 当前过滤条件下的总条数 */
  var total = 0;
  /** 是否还有下一页 */
  var hasMore = false;
  /** 收藏总条数（供「收藏」标签徽标） */
  var favTotal = 0;
  /** 当前搜索词 */
  var query = "";
  /** 当前标签："all" = 全部历史，"fav" = 只看收藏 */
  var filter = "all";
  /** 当前选中的分类（null = 不按分类筛选；只在「全部」标签下生效） */
  var activeCategory = null;
  /** 现有分类及各自条目数 */
  var categories = [];
  /** 正在行内编辑的条目 id（null = 无） */
  var editingId = null;
  /** 正在编辑分类的条目 id（null = 无） */
  var categorizingId = null;
  /** 分类编辑草稿 */
  var categoryDraft = "";
  /** 编辑中的草稿文本（防自动刷新重建列表冲掉正敲的字） */
  var editDraft = "";
  /** 正在刷新/加载（防重入） */
  var loading = false;
  /** 待重扫标记 */
  var pendingReload = false;
  /** 大图预览当前项 */
  var viewerItem = null;
  /** 缩略图缓存：relPath → dataUrl */
  var thumbCache = {};

  /**
   * 插件领域注解表：`id -> { favorite?: boolean, category?: string, editedText?: string }`。
   * 权威持久化在 `ms.store.readJson("annotations")`。
   */
  var annotations = Object.create(null);
  var annotationsLoadedPromise = null;

  /* ======================= 小工具 ======================= */

  function alive() {
    return !!rootEl && rootEl.isConnected;
  }

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

  function errorText(e) {
    if (!e) return "未知错误";
    return String(e.message || e);
  }

  function formatTime(ts) {
    var d = new Date(Number(ts) || 0);
    if (isNaN(d.getTime())) return "";
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function formatBytes(n) {
    var v = Number(n) || 0;
    if (v < 1024) return v + " B";
    if (v < 1024 * 1024) return (v / 1024).toFixed(1) + " KB";
    return (v / 1024 / 1024).toFixed(1) + " MB";
  }

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

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /**
   * 文本编辑归一化（与宿主捕获侧 `normalize_captured_text` 同口径）：
   * 剥掉尾部 `\r\n`、拒绝纯空白、按 Unicode 码点截断至 `MAX_TEXT_CHARS`（绝不切碎多字节字符）。
   */
  function normalizeEditText(raw) {
    var s = String(raw == null ? "" : raw).replace(/[\r\n]+$/, "");
    if (!s.trim()) return null;
    var cps = Array.from(s);
    if (cps.length > MAX_TEXT_CHARS) {
      return cps.slice(0, MAX_TEXT_CHARS).join("");
    }
    return s;
  }

  /** UTF-8 字节数（与 Rust `content.len()` 同口径） */
  function utf8Len(s) {
    if (typeof TextEncoder === "function") {
      try { return new TextEncoder().encode(s).length; } catch (e) { /* fallback */ }
    }
    var encoded = encodeURIComponent(s);
    var percent = 0;
    for (var i = 0; i < encoded.length; i++) {
      if (encoded.charAt(i) === "%") percent++;
    }
    return encoded.length - 2 * percent;
  }

  /* ======================= 领域存储与保留集同步 ======================= */

  function readStoreJson(key) {
    if (ms.store && typeof ms.store.readJson === "function") {
      return Promise.resolve(ms.store.readJson(key, null));
    }
    if (ms.store && typeof ms.store.get === "function") {
      return Promise.resolve(ms.store.get(key, null));
    }
    return Promise.resolve(null);
  }

  function writeStoreJson(key, val) {
    if (ms.store && typeof ms.store.writeJson === "function") {
      return Promise.resolve(ms.store.writeJson(key, val));
    }
    if (ms.store && typeof ms.store.set === "function") {
      return Promise.resolve(ms.store.set(key, val));
    }
    return Promise.resolve(false);
  }

  function removeStoreJson(key) {
    if (ms.store && typeof ms.store.removeJson === "function") {
      return Promise.resolve(ms.store.removeJson(key));
    }
    if (ms.store && typeof ms.store.remove === "function") {
      return Promise.resolve(ms.store.remove(key));
    }
    return Promise.resolve(false);
  }

  function sanitizeAnnotationEntry(raw) {
    if (!raw || typeof raw !== "object") return null;
    var fav = raw.favorite === true;
    var cat = typeof raw.category === "string" ? raw.category.replace(/\s+/g, " ").trim().slice(0, 24) : "";
    var edt = typeof raw.editedText === "string" ? raw.editedText : undefined;
    if (!fav && !cat && edt === undefined) return null;
    var out = {};
    if (fav) out.favorite = true;
    if (cat) out.category = cat;
    if (edt !== undefined) out.editedText = edt;
    return out;
  }

  /** 计算当前需要宿主豁免环形缓冲淘汰的记录 ID 集合（已收藏或已归类） */
  function retainedIdsOfAnnotations() {
    var ids = [];
    var keys = Object.keys(annotations);
    for (var i = 0; i < keys.length; i++) {
      var id = keys[i];
      var a = annotations[id];
      if (a && (a.favorite === true || (typeof a.category === "string" && a.category.length > 0))) {
        ids.push(id);
      }
    }
    return ids;
  }

  function syncRetainedToHost() {
    if (typeof ms.clipboard?.setRetained !== "function") return Promise.resolve();
    return Promise.resolve(ms.clipboard.setRetained(retainedIdsOfAnnotations()))
      .catch(function () { /* 非关键路径不阻塞界面 */ });
  }

  function persistAnnotationsAndSync() {
    var plain = {};
    var keys = Object.keys(annotations);
    for (var i = 0; i < keys.length; i++) {
      var cleaned = sanitizeAnnotationEntry(annotations[keys[i]]);
      if (cleaned) {
        annotations[keys[i]] = cleaned;
        plain[keys[i]] = cleaned;
      } else {
        delete annotations[keys[i]];
      }
    }
    return writeStoreJson(ANNOTATIONS_KEY, plain).then(function () {
      return syncRetainedToHost();
    });
  }

  /**
   * 首次加载插件注解，并自动接管宿主从旧版 `index.json` 剥离出的 `annotations.legacy`。
   */
  function ensureAnnotationsLoaded() {
    if (annotationsLoadedPromise) return annotationsLoadedPromise;
    annotationsLoadedPromise = Promise.all([
      readStoreJson(ANNOTATIONS_KEY).catch(function () { return null; }),
      readStoreJson(LEGACY_ANNOTATIONS_KEY).catch(function () { return null; }),
    ]).then(function (pair) {
      var saved = pair[0];
      var legacy = pair[1];
      var nextMap = Object.create(null);

      if (saved && typeof saved === "object") {
        Object.keys(saved).forEach(function (id) {
          var c = sanitizeAnnotationEntry(saved[id]);
          if (c) nextMap[id] = c;
        });
      }

      var migrated = false;
      if (legacy && typeof legacy === "object") {
        Object.keys(legacy).forEach(function (id) {
          var leg = sanitizeAnnotationEntry(legacy[id]);
          if (!leg) return;
          var cur = nextMap[id] || {};
          nextMap[id] = sanitizeAnnotationEntry({
            favorite: cur.favorite === true || leg.favorite === true,
            category: cur.category || leg.category || "",
            editedText: cur.editedText,
          });
          migrated = true;
        });
      }

      annotations = nextMap;
      if (migrated) {
        return persistAnnotationsAndSync().then(function () {
          return removeStoreJson(LEGACY_ANNOTATIONS_KEY).catch(function () {});
        });
      }
      return syncRetainedToHost();
    });
    return annotationsLoadedPromise;
  }

  function setItemAnnotation(id, patch) {
    var prev = annotations[id] ? Object.assign({}, annotations[id]) : null;
    var merged = Object.assign({}, prev || {}, patch);
    var cleaned = sanitizeAnnotationEntry(merged);
    if (cleaned) annotations[id] = cleaned;
    else delete annotations[id];
    return {
      commit: function () { return persistAnnotationsAndSync(); },
      rollback: function () {
        if (prev) annotations[id] = prev;
        else delete annotations[id];
      },
    };
  }

  /** 将宿主原始捕获项与插件领域注解合并为视图模型 */
  function enrichItem(raw) {
    var ann = annotations[raw.id] || null;
    var isText = raw.kind === "text";
    var hasEdited = isText && ann && typeof ann.editedText === "string";
    var effectiveText = hasEdited ? ann.editedText : raw.text;
    return {
      id: raw.id,
      kind: raw.kind,
      rawText: raw.text,
      text: effectiveText,
      edited: !!hasEdited,
      relPath: raw.relPath,
      width: raw.width,
      height: raw.height,
      size: hasEdited ? utf8Len(effectiveText) : raw.size,
      createdAt: raw.createdAt,
      source: raw.source,
      favorite: !!(ann && ann.favorite === true),
      category: ann && ann.category ? ann.category : undefined,
    };
  }

  /** 根据最新全量列表重算统计徽标、分类栏与过滤结果 */
  function recomputeStatsAndFiltered() {
    var favCount = 0;
    var catMap = Object.create(null);
    for (var i = 0; i < allMerged.length; i++) {
      var it = allMerged[i];
      if (it.favorite === true) favCount++;
      if (it.category) {
        if (!catMap[it.category]) catMap[it.category] = { name: it.category, count: 0 };
        catMap[it.category].count++;
      }
    }
    favTotal = favCount;
    categories = Object.keys(catMap).map(function (k) { return catMap[k]; });
    categories.sort(function (a, b) { return a.name.localeCompare(b.name, "zh-Hans-CN"); });
    if (activeCategory && !catMap[activeCategory]) {
      activeCategory = null;
    }

    var needle = String(query || "").trim().toLowerCase();
    var filtered = [];
    for (var j = 0; j < allMerged.length; j++) {
      var row = allMerged[j];
      if (filter === "fav" && row.favorite !== true) continue;
      if (filter === "all" && activeCategory && row.category !== activeCategory) continue;
      if (needle) {
        var hay = row.kind === "text"
          ? String(row.text || "").toLowerCase()
          : String(row.source || "").toLowerCase();
        if (hay.indexOf(needle) < 0) continue;
      }
      filtered.push(row);
    }
    return filtered;
  }

  /* ======================= 列表渲染 ======================= */

  function itemSubline(it) {
    if (it.kind === "image") {
      var dim = (it.width && it.height) ? (it.width + "×" + it.height + " · ") : "";
      return dim + formatBytes(it.size) + " · " + formatTime(it.createdAt);
    }
    var chars = it.text ? it.text.length : 0;
    return chars + " 字 · " + formatTime(it.createdAt);
  }

  function visibleItems() {
    return items;
  }

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
      badge.textContent = favTotal > 0 ? String(favTotal) : "";
      badge.hidden = favTotal === 0;
    }
  }

  function renderCategories() {
    var box = dom["cb-cats"];
    if (!box) return;
    if (filter !== "all" || !categories.length) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    var html = '<span class="cb-cats-label">分类</span>';
    for (var i = 0; i < categories.length; i++) {
      var c = categories[i];
      var on = activeCategory === c.name;
      html += '<button class="cb-cat' + (on ? " active" : "") + '" type="button" data-cat="' +
        escapeHtml(c.name) + '" title="' + (on ? "再次点击显示全部分类" : "只看「" + escapeHtml(c.name) + "」分类") + '">' +
        escapeHtml(c.name) + '<span class="cb-cat-num">' + c.count + "</span></button>";
    }
    if (activeCategory) {
      html += '<button class="cb-cat cb-cat-clear" type="button" data-act="cat-clear" title="取消分类筛选">显示全部</button>';
    }
    box.innerHTML = html;
    box.hidden = false;

    if (dom["cb-cat-options"]) {
      dom["cb-cat-options"].innerHTML = categories.map(function (c) {
        return '<option value="' + escapeHtml(c.name) + '"></option>';
      }).join("");
    }
  }

  function render() {
    var list = dom["cb-list"];
    var empty = dom["cb-empty"];
    if (!list) return;

    renderTabs();
    renderCategories();

    var shown = visibleItems();

    if (dom["cb-meta"]) {
      if (!total) {
        dom["cb-meta"].textContent = "";
      } else {
        var prefix = filter === "fav" ? "收藏 " : (activeCategory ? "分类「" + activeCategory + "」 " : "共 ");
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
          else if (activeCategory) dom["cb-empty-text"].textContent = "分类「" + activeCategory + "」下还没有内容。";
          else dom["cb-empty-text"].textContent = "还没有剪贴板历史。";
        }
      }
      if (dom["cb-clear"]) dom["cb-clear"].disabled = allMerged.length === 0;
      return;
    }
    if (empty) empty.hidden = true;
    if (dom["cb-clear"]) dom["cb-clear"].disabled = false;

    var html = "";
    for (var i = 0; i < shown.length; i++) {
      html += itemHtml(shown[i]);
    }
    html += '<div id="cb-sentinel" class="cb-sentinel">' +
      (hasMore ? "加载中…" : "已全部加载") + "</div>";
    list.innerHTML = html;

    if (editingId) {
      var ta = editBoxOf(editingId);
      if (ta) {
        var end = ta.value.length;
        ta.focus();
        ta.setSelectionRange(end, end);
        growEditBox(ta);
      }
    }

    if (categorizingId) {
      var catBox = catBoxOf(categorizingId);
      if (catBox) {
        var cend = catBox.value.length;
        catBox.focus();
        catBox.setSelectionRange(cend, cend);
      }
    }

    loadVisibleThumbs();
    scheduleSentinelCheck();
  }

  function itemHtml(it) {
    var isImg = it.kind === "image";
    var isFav = it.favorite === true;

    if (editingId === it.id) {
      return editRowHtml(it, isImg);
    }
    if (categorizingId === it.id) {
      return categoryRowHtml(it, isImg);
    }

    var preview = isImg
      ? ""
      : '<div class="cb-item-text">' + escapeHtml(it.text || "") + "</div>";
    var sourceLine = it.source
      ? '<div class="cb-item-sub">' + escapeHtml(it.source) + "</div>"
      : "";
    var catLine = it.category
      ? '<div class="cb-item-sub"><span class="cb-item-cat" title="已分类（永久保留）">分类：' +
        escapeHtml(it.category) + "</span></div>"
      : "";
    var editBtn = (!isImg && isFav)
      ? '<button class="cb-item-btn" data-act="edit" title="修改这条收藏的内容">编辑</button>'
      : "";

    return (
      '<div class="cb-item" data-id="' + escapeHtml(it.id) + '" data-kind="' + escapeHtml(it.kind) + '"' +
        (it.relPath ? ' data-rel-path="' + escapeHtml(it.relPath) + '"' : "") + ">" +
        (isImg
          ? '<div class="cb-item-thumb" data-thumb="' + escapeHtml(it.relPath) + '">图片</div>'
          : '<div class="cb-item-kind">文本</div>') +
        '<div class="cb-item-body">' +
          preview +
          sourceLine +
          catLine +
          '<div class="cb-item-sub">' + escapeHtml(itemSubline(it)) + "</div>" +
        "</div>" +
        '<div class="cb-item-actions">' +
          '<button class="cb-item-btn fav' + (isFav ? " on" : "") + '" data-act="fav" title="' +
            (isFav ? "取消收藏" : "收藏") + '">' + (isFav ? "★" : "☆") + "</button>" +
          '<button class="cb-item-btn" data-act="copy" title="复制到剪贴板">复制</button>' +
          editBtn +
          '<button class="cb-item-btn" data-act="category" title="设置分类（分类后永久保留）">分类</button>' +
          '<button class="cb-item-btn del" data-act="del" title="删除这条">删除</button>' +
        "</div>" +
      "</div>");
  }

  function categoryRowHtml(it, isImg) {
    return (
      '<div class="cb-item cb-item-categorizing" data-id="' + escapeHtml(it.id) + '"' +
        ' data-kind="' + escapeHtml(it.kind) + '"' +
        (it.relPath ? ' data-rel-path="' + escapeHtml(it.relPath) + '"' : "") + ">" +
        '<div class="cb-item-kind">' + (isImg ? "图片" : "文本") + "</div>" +
        '<div class="cb-item-body">' +
          '<input class="cb-item-cat-input" type="text" list="cb-cat-options" maxlength="24" ' +
            'data-cat-input="' + escapeHtml(it.id) + '" value="' + escapeHtml(categoryDraft) + '" ' +
            'placeholder="输入分类名（留空 = 取消分类）" spellcheck="false">' +
          '<div class="cb-item-sub">分类后的条目永久保留，不会被上限淘汰或清空。</div>' +
        "</div>" +
        '<div class="cb-item-actions">' +
          '<button class="cb-item-btn primary" data-act="cat-save" title="保存分类（Enter）">保存</button>' +
          '<button class="cb-item-btn" data-act="cat-cancel" title="放弃修改（Esc）">取消</button>' +
        "</div>" +
      "</div>");
  }

  function editRowHtml(it, isImg) {
    return (
      '<div class="cb-item cb-item-editing" data-id="' + escapeHtml(it.id) + '"' +
        ' data-kind="' + escapeHtml(it.kind) + '"' +
        (it.relPath ? ' data-rel-path="' + escapeHtml(it.relPath) + '"' : "") + ">" +
        '<div class="cb-item-kind">' + (isImg ? "图片" : "文本") + "</div>" +
        '<div class="cb-item-body">' +
          '<textarea class="cb-item-edit-input" data-edit-input="' + escapeHtml(it.id) + '" ' +
            'rows="1" spellcheck="false" placeholder="输入内容…">' +
            escapeHtml(editDraft) + "</textarea>" +
        "</div>" +
        '<div class="cb-item-actions">' +
          '<button class="cb-item-btn primary" data-act="edit-save" title="保存修改（Enter）">保存</button>' +
          '<button class="cb-item-btn" data-act="edit-cancel" title="放弃修改（Esc）">取消</button>' +
        "</div>" +
      "</div>");
  }

  function loadVisibleThumbs() {
    var pending = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.kind !== "image" || !it.relPath) continue;
      if (thumbCache[it.relPath]) {
        applyThumb(it.relPath, thumbCache[it.relPath]);
        continue;
      }
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
        .catch(function () {})
        .then(worker);
    }
    for (var w = 0; w < Math.min(THUMB_CONCURRENCY, pending.length); w++) worker();
  }

  function applyThumb(rel, dataUrl) {
    var list = dom["cb-list"];
    if (!list) return;
    var node = list.querySelector('[data-thumb="' + cssEscape(rel) + '"]');
    if (!node) return;
    node.innerHTML = '<img alt="" src="' + dataUrl + '">';
  }

  function cssEscape(s) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(s);
    return String(s).replace(/["\\]/g, "\\$&");
  }

  /* ======================= 触底加载（自动无限滚） ======================= */

  var sentinelObserver = null;

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

  function scheduleSentinelCheck() {
    ensureSentinelObserver();
    if (!sentinelObserver) {
      bindScrollFallback();
      return;
    }
    var sentinel = document.getElementById("cb-sentinel");
    if (!sentinel) return;
    sentinelObserver.disconnect();
    sentinelObserver.observe(sentinel);
  }

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

  /* ======================= 数据加载与本地分页 ======================= */

  /** 拉取原始捕获列表并与插件领域注解合并 */
  function fetchMergedAll() {
    return ensureAnnotationsLoaded().then(function () {
      return Promise.resolve(ms.clipboard.list());
    }).then(function (rawList) {
      var arr = Array.isArray(rawList) ? rawList : [];
      var aliveIds = Object.create(null);
      allMerged = arr.map(function (r) {
        aliveIds[r.id] = true;
        return enrichItem(r);
      });
      // 顺手清掉已被宿主删除/淘汰记录的孤儿注解，避免长期使用产生残留键
      var dirty = false;
      Object.keys(annotations).forEach(function (id) {
        if (!aliveIds[id]) {
          delete annotations[id];
          dirty = true;
        }
      });
      if (dirty) {
        persistAnnotationsAndSync().catch(function () {});
      }
      return recomputeStatsAndFiltered();
    });
  }

  function reload(showStatus, q) {
    if (typeof q === "string") query = q;
    if (loading) { pendingReload = true; return; }
    loading = true;
    if (showStatus) setStatus("正在刷新…");

    fetchMergedAll()
      .then(function (filtered) {
        if (!alive()) return;
        total = filtered.length;
        items = filtered.slice(0, PAGE_SIZE);
        hasMore = items.length < total;
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

  function loadMore() {
    if (loading || !hasMore) return;
    var filtered = recomputeStatsAndFiltered();
    var nextSlice = filtered.slice(items.length, items.length + PAGE_SIZE);
    items = items.concat(nextSlice);
    total = filtered.length;
    hasMore = items.length < total;
    render();
  }

  function loadFirstPageQuiet() {
    if (loading) { pendingReload = true; return; }
    loading = true;
    fetchMergedAll()
      .then(function (filtered) {
        if (!alive()) return;
        total = filtered.length;
        items = filtered.slice(0, PAGE_SIZE);
        hasMore = items.length < total;
        render();
      })
      .catch(function () {})
      .then(function () { loading = false; });
  }

  /* ======================= 条目操作 ======================= */

  function copyItem(it) {
    // 若用户对收藏文本做过二次编辑，复制时把编辑后的文本传给宿主 `copy(id, textOverride)`
    var override = (it.kind === "text" && it.edited && typeof it.text === "string")
      ? it.text
      : undefined;
    Promise.resolve(
      override !== undefined
        ? ms.clipboard.copy(it.id, override)
        : ms.clipboard.copy(it.id)
    )
      .then(function () {
        if (ms.ui && typeof ms.ui.toast === "function") {
          try { ms.ui.toast("已复制", "ok"); } catch (e) {}
        }
      })
      .catch(function (e) { setStatus("复制失败：" + errorText(e), true); });
  }

  function removeItem(it) {
    var label = it.kind === "image" ? "这张图片" : "这条文本";
    Promise.resolve(ms.ui && ms.ui.confirm ? ms.ui.confirm("删除" + label + "？") : true)
      .then(function (ok) {
        if (ok === false) return null;
        return Promise.resolve(ms.clipboard.remove(it.id));
      })
      .then(function (r) {
        if (r === null) return;
        delete annotations[it.id];
        persistAnnotationsAndSync().catch(function () {});
        if (viewerItem && viewerItem.id === it.id) closeViewer();
        if (categorizingId === it.id) categorizingId = null;
        if (editingId === it.id) editingId = null;
        reload(false);
      })
      .catch(function (e) { setStatus("删除失败：" + errorText(e), true); });
  }

  function toggleFavorite(it) {
    var next = !(it.favorite === true);
    var ask = next
      ? "收藏这条内容？收藏后不会被上限淘汰，清空时也会保留。"
      : "取消收藏这条内容？";
    Promise.resolve(ms.ui && ms.ui.confirm ? ms.ui.confirm(ask) : true)
      .then(function (ok) {
        if (ok === false) return null;
        var tx = setItemAnnotation(it.id, { favorite: next });
        it.favorite = next;
        var mergedTarget = findInAllMerged(it.id);
        if (mergedTarget) mergedTarget.favorite = next;
        var filtered = recomputeStatsAndFiltered();
        if (filter === "fav" && !next) {
          items = items.filter(function (x) { return x.id !== it.id; });
        }
        total = filtered.length;
        hasMore = items.length < total;
        if (editingId === it.id) editingId = null;
        render();
        return tx.commit().catch(function (err) {
          tx.rollback();
          throw err;
        });
      })
      .catch(function (e) {
        it.favorite = !next;
        loadFirstPageQuiet();
        setStatus((next ? "收藏失败：" : "取消收藏失败：") + errorText(e), true);
      });
  }

  /* ======================= 条目编辑（仅收藏的文本） ======================= */

  function startEdit(it) {
    if (editingId === it.id) return;
    if (it.kind !== "text" || it.favorite !== true) return;
    categorizingId = null;
    categoryDraft = "";
    editingId = it.id;
    editDraft = it.text || "";
    render();
    var ta = editBoxOf(it.id);
    if (!ta) return;
    ta.focus();
    ta.select();
    growEditBox(ta);
    if (typeof ta.scrollIntoView === "function") ta.scrollIntoView({ block: "nearest" });
  }

  function cancelEdit() {
    if (editingId === null) return;
    editingId = null;
    editDraft = "";
    render();
  }

  function saveEdit(id) {
    var it = findItem(id);
    var ta = editBoxOf(id);
    if (!it || !ta) { cancelEdit(); return; }

    var raw = ta.value;
    if (!raw.trim()) {
      editDraft = raw;
      setStatus("内容不能为空", true);
      return;
    }
    var normalized = normalizeEditText(raw);
    if (normalized === null) {
      editDraft = raw;
      setStatus("内容不能为空", true);
      return;
    }
    if (normalized === (it.text || "")) {
      cancelEdit();
      setStatus("内容未变化");
      setTimeout(function () { if (alive()) setStatus(""); }, 2000);
      return;
    }

    var oldText = it.text;
    var oldSize = it.size;
    var oldEdited = it.edited;
    var nextEdited = normalized === it.rawText ? undefined : normalized;
    var tx = setItemAnnotation(it.id, { editedText: nextEdited });

    it.text = normalized;
    it.size = utf8Len(normalized);
    it.edited = nextEdited !== undefined;
    var mergedTarget = findInAllMerged(it.id);
    if (mergedTarget) {
      mergedTarget.text = it.text;
      mergedTarget.size = it.size;
      mergedTarget.edited = it.edited;
    }
    editingId = null;
    editDraft = "";
    render();

    tx.commit()
      .then(function () {
        if (!alive()) return;
        setStatus("已保存");
        setTimeout(function () { if (alive()) setStatus(""); }, 2000);
      })
      .catch(function (e) {
        tx.rollback();
        if (!alive()) return;
        it.text = oldText;
        it.size = oldSize;
        it.edited = oldEdited;
        loadFirstPageQuiet();
        setStatus("保存失败：" + errorText(e), true);
      });
  }

  function editBoxOf(id) {
    var list = dom["cb-list"];
    if (!list) return null;
    return list.querySelector('[data-edit-input="' + cssEscape(id) + '"]');
  }

  function catBoxOf(id) {
    var list = dom["cb-list"];
    if (!list) return null;
    return list.querySelector('[data-cat-input="' + cssEscape(id) + '"]');
  }

  /* ======================= 条目分类 ======================= */

  function startCategorize(it) {
    if (categorizingId === it.id) return;
    editingId = null;
    editDraft = "";
    categorizingId = it.id;
    categoryDraft = it.category || "";
    render();
    var input = catBoxOf(it.id);
    if (!input) return;
    input.focus();
    input.select();
    if (typeof input.scrollIntoView === "function") input.scrollIntoView({ block: "nearest" });
  }

  function cancelCategorize() {
    if (categorizingId === null) return;
    categorizingId = null;
    categoryDraft = "";
    render();
  }

  function saveCategory(id) {
    var it = findItem(id);
    var input = catBoxOf(id);
    if (!it || !input) { cancelCategorize(); return; }

    var next = String(input.value || "").replace(/\s+/g, " ").trim().slice(0, 24) || null;
    var prev = it.category || null;
    if (next === prev) {
      cancelCategorize();
      setStatus("分类未变化");
      setTimeout(function () { if (alive()) setStatus(""); }, 1600);
      return;
    }

    var tx = setItemAnnotation(it.id, { category: next || "" });
    if (next) it.category = next;
    else delete it.category;
    var mergedTarget = findInAllMerged(it.id);
    if (mergedTarget) {
      if (next) mergedTarget.category = next;
      else delete mergedTarget.category;
    }
    categorizingId = null;
    categoryDraft = "";

    var filtered = recomputeStatsAndFiltered();
    if (activeCategory && next !== activeCategory) {
      items = items.filter(function (x) { return x.id !== it.id; });
    }
    total = filtered.length;
    hasMore = items.length < total;
    render();

    tx.commit()
      .then(function () {
        if (!alive()) return;
        setStatus(next ? "已分类到「" + next + "」" : "已取消分类");
        setTimeout(function () { if (alive()) setStatus(""); }, 2000);
      })
      .catch(function (e) {
        tx.rollback();
        if (!alive()) return;
        if (prev) it.category = prev;
        else delete it.category;
        loadFirstPageQuiet();
        setStatus("分类保存失败：" + errorText(e), true);
      });
  }

  function growEditBox(ta) {
    if (!ta || !ta.style) return;
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  }

  /** 清空未保留的剪贴板历史（已收藏与已分类条目通过 `retainIds` 显式保留） */
  function clearAll() {
    var favCount = favTotal;
    var catCount = categories.reduce(function (n, c) { return n + c.count; }, 0);
    var msg;
    if (favCount || catCount) {
      msg = "清空未收藏、未分类的剪贴板历史？\n\n已收藏与已分类的条目会永久保留。此操作不可撤销。";
    } else {
      msg = "清空全部剪贴板历史？此操作不可撤销。";
    }
    Promise.resolve(ms.ui && ms.ui.confirm ? ms.ui.confirm(msg) : true)
      .then(function (ok) {
        if (ok === false) return null;
        var retainIds = retainedIdsOfAnnotations();
        return Promise.resolve(ms.clipboard.clear({ keepRetained: true, retainIds: retainIds }));
      })
      .then(function (r) {
        if (r === null) return;
        thumbCache = {};
        reload(false);
        setStatus(favCount || catCount ? "已清空临时历史（收藏与分类已保留）" : "已清空剪贴板历史");
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
        if (!viewerItem || viewerItem.relPath !== rel) return;
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

  function copyViewer() {
    if (!viewerItem) return;
    copyItem(viewerItem);
  }

  /* ======================= 快捷键（统一 `ms.shortcuts.get/set`） ======================= */

  function getShortcutBinding() {
    if (ms.shortcuts && typeof ms.shortcuts.get === "function") {
      return Promise.resolve(ms.shortcuts.get("clipboard"));
    }
    if (typeof ms.clipboard?.getShortcut === "function") {
      return Promise.resolve(ms.clipboard.getShortcut());
    }
    return Promise.resolve("");
  }

  function setShortcutBinding(combo) {
    if (ms.shortcuts && typeof ms.shortcuts.set === "function") {
      return Promise.resolve(ms.shortcuts.set("clipboard", combo));
    }
    if (typeof ms.clipboard?.setShortcut === "function") {
      return Promise.resolve(ms.clipboard.setShortcut(combo));
    }
    return Promise.reject(new Error("当前宿主版本不支持在插件内修改快捷键"));
  }

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

  function loadHotkey() {
    getShortcutBinding()
      .then(function (key) { if (alive()) renderHotkey(key); })
      .catch(function () {});
  }

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

  function mainKeyOf(e) {
    var code = typeof e.code === "string" ? e.code : "";
    if (code) {
      var letter = code.match(/^Key([A-Z])$/);
      if (letter) return letter[1].toLowerCase();
      var digit = code.match(/^Digit([0-9])$/);
      if (digit) return digit[1];
      return code.toLowerCase();
    }
    var key = typeof e.key === "string" ? e.key : "";
    if (!key) return "";
    if (key === " ") return "space";
    return key.toLowerCase();
  }

  function applyHotkey(combo) {
    setShortcutBinding(combo)
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

  function clearHotkey() {
    setShortcutBinding("")
      .then(function () {
        renderHotkey("");
        setStatus("已解绑呼出快捷键");
        setTimeout(function () { if (alive()) setStatus(""); }, 2000);
      })
      .catch(function (e) { setStatus("解绑失败：" + errorText(e), true); });
  }

  /* ======================= 事件绑定 ======================= */

  function onDocKeydown(e) {
    if (e.key !== "Escape") return;
    if (dom["cb-viewer"] && !dom["cb-viewer"].hidden) {
      e.preventDefault();
      closeViewer();
    }
  }

  function bind() {
    dom["cb-hotkey-btn"]?.addEventListener("click", startCapture);
    dom["cb-hotkey-clear"]?.addEventListener("click", clearHotkey);
    dom["cb-refresh"]?.addEventListener("click", function () { reload(true); });
    dom["cb-clear"]?.addEventListener("click", clearAll);

    dom["cb-tabs"]?.addEventListener("click", function (e) {
      var btn = e.target.closest(".cb-tab[data-tab]");
      if (!btn) return;
      var tab = btn.getAttribute("data-tab");
      if (tab !== "all" && tab !== "fav") return;
      if (tab === filter) return;
      filter = tab;
      activeCategory = null;
      persistFilter(tab);
      cancelEdit();
      // 从头拉：切换标签后重算分页
      cancelCategorize();
      reload(false);
    });

    dom["cb-cats"]?.addEventListener("click", function (e) {
      var clear = e.target.closest('[data-act="cat-clear"]');
      if (clear) {
        if (!activeCategory) return;
        activeCategory = null;
      } else {
        var btn = e.target.closest(".cb-cat[data-cat]");
        if (!btn) return;
        var cat = btn.getAttribute("data-cat") || "";
        if (!cat) return;
        activeCategory = activeCategory === cat ? null : cat;
      }
      cancelEdit();
      cancelCategorize();
      reload(false);
    });

    var searchTimer = null;
    dom["cb-search"]?.addEventListener("input", function (e) {
      var v = String(e.target.value || "");
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        if (!alive()) return;
        persistQuery(v);
        cancelCategorize();
        cancelEdit();
        reload(false, v);
      }, 200);
    });

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
        else if (act === "edit") startEdit(it);
        else if (act === "edit-save") saveEdit(it.id);
        else if (act === "edit-cancel") cancelEdit();
        else if (act === "category") startCategorize(it);
        else if (act === "cat-save") saveCategory(it.id);
        else if (act === "cat-cancel") cancelCategorize();
        return;
      }
      if (it.kind === "image") openViewer(it);
      else copyItem(it);
    });

    dom["cb-list"]?.addEventListener("keydown", function (e) {
      var ta = e.target;
      if (!ta || !ta.getAttribute) return;

      var catId = ta.getAttribute("data-cat-input");
      if (catId) {
        if (e.key === "Enter" && !e.isComposing) {
          e.preventDefault();
          saveCategory(catId);
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancelCategorize();
        }
        return;
      }

      if (!ta.getAttribute("data-edit-input")) return;
      var id = ta.getAttribute("data-edit-input");
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        saveEdit(id);
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelEdit();
      }
    });

    dom["cb-list"]?.addEventListener("input", function (e) {
      var ta = e.target;
      if (!ta || !ta.getAttribute) return;
      if (ta.getAttribute("data-cat-input")) {
        categoryDraft = ta.value;
        return;
      }
      if (!ta.getAttribute("data-edit-input")) return;
      growEditBox(ta);
      editDraft = ta.value;
    });

    dom["cb-viewer-close"]?.addEventListener("click", closeViewer);
    dom["cb-viewer"]?.addEventListener("click", function (e) {
      if (e.target === dom["cb-viewer"]) closeViewer();
    });
    dom["cb-viewer-copy"]?.addEventListener("click", copyViewer);

    document.addEventListener("keydown", onDocKeydown);
  }

  function findItem(id) {
    for (var i = 0; i < items.length; i++) {
      if (items[i].id === id) return items[i];
    }
    return null;
  }

  function findInAllMerged(id) {
    for (var i = 0; i < allMerged.length; i++) {
      if (allMerged[i].id === id) return allMerged[i];
    }
    return null;
  }

  /* ======================= 偏好持久化 ======================= */

  function persistQuery(v) {
    try { ms.store?.set("query", v); } catch (e) {}
  }

  function restoreQuery() {
    try {
      var saved = ms.store?.get("query", "");
      if (typeof saved === "string" && saved) {
        query = saved;
        if (dom["cb-search"]) dom["cb-search"].value = saved;
      }
    } catch (e) {}
  }

  function persistFilter(v) {
    try { ms.store?.set("filter", v); } catch (e) {}
  }

  function restoreFilter() {
    try {
      var saved = ms.store?.get("filter", "all");
      if (saved === "fav" || saved === "all") filter = saved;
    } catch (e) {}
  }

  /* ======================= 会话回收与测试钩子 ======================= */

  if (host && typeof host === "object") {
    host.__msPluginCleanup = function () {
      if (sentinelObserver) {
        sentinelObserver.disconnect();
        sentinelObserver = null;
      }
      document.removeEventListener("keydown", onDocKeydown);
    };
  }

  if (typeof window !== "undefined" && window.__CB_TEST_HOOK__) {
    window.__CB_TEST__ = {
      ensureAnnotationsLoaded: ensureAnnotationsLoaded,
      fetchMergedAll: fetchMergedAll,
      normalizeEditText: normalizeEditText,
      utf8Len: utf8Len,
      retainedIdsOfAnnotations: retainedIdsOfAnnotations,
      setItemAnnotation: setItemAnnotation,
      getAnnotations: function () { return Object.assign({}, annotations); },
      getState: function () {
        return {
          items: items.slice(),
          allMerged: allMerged.slice(),
          total: total,
          hasMore: hasMore,
          favTotal: favTotal,
          categories: categories.slice(),
        };
      },
    };
  }

  /* ======================= 启动 ======================= */

  bind();
  restoreQuery();
  restoreFilter();
  loadHotkey();
  reload(false);

  if (typeof ms.clipboard?.onUpdated === "function") {
    ms.clipboard.onUpdated(function () {
      if (!alive()) return;
      reload(false);
    });
  }

  ms.log("info", "剪贴板历史插件已加载" + (plugin && plugin.id ? "（" + plugin.id + "）" : ""));
})(ms, env, plugin, host, keyword, inputValue, onSubKeyword, md2html, openExternal);
