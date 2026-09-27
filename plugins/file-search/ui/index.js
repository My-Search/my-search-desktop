/**
 * 文件搜索 - 前端入口脚本
 *
 * 宿主注入参数: ms, env, plugin, host, keyword, inputValue, onSubKeyword, md2html, openExternal
 *
 * 工作流（与搜索窗口的「附件模式」配合）：
 *   1. 用户在搜索框粘贴/拖入**文件夹**（可多个，多批粘贴会合并去重）→
 *      结果只剩声明了 folders 能力的插件（本插件 + 其它同能力插件）；
 *   2. 输入「文件搜索 : 关键词」回车 → 宿主打开本视图并把关键词经
 *      onSubKeyword 推过来（挂载时也会自动推一次）；
 *   3. 本插件用 ms.input.attachments() 取全部附加文件夹、ms.input.listFolder()
 *      逐根递归列举（按轮带 gen：单根失败不拖垮其余根，扫描中可「停止」——
 *      在途 walk 带着已收集的部分返回）。结果默认「全部文件」页签、按修改
 *      时间从新到旧排序，再按关键词（空格分词、AND 语义）与类型页签
 *      （图片/音频/视频/Office及常见文档/压缩包/文件夹/其它文件）双重过滤，
 *      点击条目用系统默认程序打开；行右侧「文件夹图标」始终显示，点击用资源管理器
 *      定位（打开所在目录并选中该条目）；
 *   4. 视图开着时再粘贴/移除文件夹：宿主广播 ms-attachments-changed，
 *      本插件自动重扫，不用手点「重新扫描」。
 *
 * 附件只读：ms.input 全部挂在 file.read 权限下，Rust 侧还会校验路径必须
 * 落在已附加的集合内——本插件访问不到用户没放进搜索框的路径。
 *
 * 信息分层（渲染约定）：
 *   - fs-status：只放**异常/过程**消息（扫描中、无附件、权限缺失、失败），
 *     成功后清空并整行隐藏，不留空行；
 *   - fs-meta：常驻统计（匹配 x / 共 y 项 · 关键词…），0 命中也照常刷新；
 *   - fs-cats：类型页签（默认「全部文件」；页签数字 = 当前关键词在该类下的命中数）；
 *   - fs-folders：附加文件夹 chips，让人知道在哪些目录里搜（失败的根标红）；
 *   - fs-foot：操作提示（怎么改关键词、点击行为）。
 */
(function (ms, env, plugin, host, keyword, inputValue, onSubKeyword, md2html, openExternal) {
  "use strict";

  // ===== DOM =====
  var dom = {};
  ["fs-status", "fs-meta", "fs-cats", "fs-list", "fs-folders", "fs-foot", "fs-rescan"].forEach(function (id) {
    dom[id] = document.getElementById(id);
  });
  /** 本实例的根节点（会话被卸载后脱离文档；老实例靠它判活，不打扰新实例） */
  var rootEl = document.getElementById("app");

  // ===== 状态 =====
  /** 附加的文件夹（AttachedEntry[]，kind === "folder"） */
  var folders = [];
  /** 递归列举到的全部条目（AttachmentDirEntry[]，带本插件补的 rootName） */
  var entries = [];
  /** 当前查询词（宿主经 onSubKeyword 推入的 yyy） */
  var query = "";
  /** 当前类型页签（默认「全部文件」） */
  var cat = "all";
  /** 列举代次计数：每轮扫描 +1，Rust 侧按 gen 判断是否取消本轮 */
  var scanGen = 0;
  /** 当前扫描轮（「停止」收尾与部分结果落地用；null = 没有进行中的轮） */
  var activeRound = null;
  /** 是否正在列举（扫描中按钮变「停止」；收尾时复位） */
  var scanning = false;
  /** 是否完成过一次成功扫描（区分「还没数据」与「扫出 0 项」） */
  var scanned = false;
  /** 各文件夹本轮扫描失败的错误消息（key = 文件夹 path；chips 标红用） */
  var failedPaths = {};
  /** 本轮列举是否触到上限（单根 LIST_LIMIT 或合计 TOTAL_LIMIT），foot 提示用 */
  var capped = false;
  /** 扫描期间附件增删过：这轮结束后补扫一次，别停在过期的文件夹集合上 */
  var pendingRescan = false;
  /** 最多渲染的行数（防超大目录把 DOM 撑爆） */
  var RENDER_LIMIT = 300;
  /** 单个文件夹的列举上限 */
  var LIST_LIMIT = 30000;
  /** 全部文件夹合计的条目上限（单根上限 × 根数可能失控，这里兜底） */
  var TOTAL_LIMIT = 50000;
  /** 宿主是否支持「在资源管理器中定位」（ms.input.reveal；旧宿主没有则不渲染图标） */
  var canReveal = !!(ms.input && typeof ms.input.reveal === "function");
  /** 宿主是否支持「取系统文件图标」（ms.input.fileIcons；旧宿主没有则退回内置字形） */
  var canFileIcons = !!(ms.input && typeof ms.input.fileIcons === "function");
  /** 路径 → 系统图标 data URL（资源管理器同款；异步到达后补渲染） */
  var iconMap = {};
  /** 正在请求中的路径（避免每次 render 重复发 IPC） */
  var iconPending = {};
  /** 图标缓存条数上限（超过整体清空，避免超大目录攒满 data URL） */
  var ICON_CACHE_MAX = 2000;

  /** 类型页签（顺序与文案 = 产品定义；exts 没列到的文件归「其它文件」） */
  var CATS = [
    { id: "all", label: "全部文件" },
    { id: "image", label: "图片", exts: ["png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "ico", "tif", "tiff", "heic", "heif", "avif"] },
    { id: "audio", label: "音频", exts: ["mp3", "wav", "flac", "ogg", "opus", "m4a", "aac", "wma", "ape", "alac", "mid", "midi"] },
    { id: "video", label: "视频", exts: ["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "mpg", "mpeg", "3gp"] },
    { id: "doc", label: "Office及常见文档", exts: ["doc", "docx", "docm", "xls", "xlsx", "xlsm", "ppt", "pptx", "pptm", "pdf", "txt", "md", "markdown", "rtf", "csv", "odt", "ods", "odp", "epub"] },
    { id: "archive", label: "压缩包", exts: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "tgz", "zst", "jar"] },
    { id: "dir", label: "文件夹" },
    { id: "other", label: "其它文件" },
  ];

  /**
   * 「在资源管理器中定位」按钮的图标（内联 SVG）。
   *
   * 刻意不用 emoji（📍）：emoji 是彩色字体字形，跨平台/主题下大小、基线与
   * 配色都不受控，还会随系统字体版本变形；内联 SVG 用 currentColor 跟随
   * 按钮文字色（悬停变品牌色），尺寸由 CSS 固定，视觉与其它图标一致。
   * 形状为「文件夹」（黄），语义比图钉更贴近「定位到所在文件夹」。
   */
  var LOCATE_SVG =
    '<svg class="fs-locate-svg" viewBox="0 0 1340 1024" width="15" height="15" ' +
    'aria-hidden="true" focusable="false">' +
    '<path d="M1076.895 87.537H500.266L411.611 0H25.33A25.702 25.702 0 0 0 0 25.33v883.568A115.475 115.475 0 0 0 115.102 1024h960.675a116.22 116.22 0 0 0 116.22-116.22V203.012a115.847 115.847 0 0 0-115.102-115.475z" fill="#EFB81B"/>' +
    '<path d="M1076.15 1024H118.455A118.827 118.827 0 0 1 0 905.173l149-683.909a21.977 21.977 0 0 1 21.977-21.977H1319.02a21.977 21.977 0 0 1 21.978 21.977l-149 686.889A115.847 115.847 0 0 1 1076.15 1024z" fill="#FFD55F"/>' +
    "</svg>";

  // ===== 工具 =====
  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  /** 状态行：只承载异常/过程消息，空文本 = 整行隐藏（不占一行空白） */
  function setStatus(text, kind) {
    var el = dom["fs-status"];
    if (!el) return;
    el.textContent = text || "";
    el.className = "fs-status" + (kind ? " is-" + kind : "");
    el.hidden = !text;
  }

  /** 统计行：innerHTML，调用方负责 esc 插值部分 */
  function setMeta(html) {
    var el = dom["fs-meta"];
    if (!el) return;
    el.innerHTML = html || "";
    el.hidden = !html;
  }

  function fmtSize(n) {
    if (!isFinite(n) || n < 0) return "";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
    return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
  }

  function fmtTime(ms) {
    if (!ms) return "";
    var d = new Date(ms);
    if (isNaN(d.getTime())) return "";
    var pad = function (x) { return String(x).padStart(2, "0"); };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  /** 路径 → 末级目录名（chips 展示用） */
  function baseName(p) {
    var s = String(p == null ? "" : p).replace(/[\\/]+$/, "");
    var i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    return i >= 0 ? s.slice(i + 1) : s;
  }

  /** 按扩展名给个轻量图标字形（**回退用**：取不到系统图标时才显示，纯文本不引外部资源） */
  function glyphOf(entry) {
    if (entry.isDir) return "📁"; // 📁
    var name = entry.name || "";
    var dot = name.lastIndexOf(".");
    var ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
    if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "avif"].indexOf(ext) >= 0) return "🖼️"; // 🖼
    if (["mp4", "mkv", "mov", "avi", "webm"].indexOf(ext) >= 0) return "🎬"; // 🎬
    if (["mp3", "wav", "flac", "ogg", "m4a"].indexOf(ext) >= 0) return "🎵"; // 🎵
    if (["zip", "rar", "7z", "tar", "gz"].indexOf(ext) >= 0) return "🗜"; // 🗜
    if (["pdf"].indexOf(ext) >= 0) return "📄"; // 📄
    if (["doc", "docx", "md", "txt", "rtf"].indexOf(ext) >= 0) return "📃"; // 📃
    if (["js", "ts", "tsx", "jsx", "py", "rs", "go", "java", "c", "cpp", "h", "json", "html", "css", "vue", "sh", "ps1", "yml", "yaml", "toml", "xml"].indexOf(ext) >= 0) return "🔧"; // 🔧
    return "📄"; // 📄
  }

  /**
   * 图标字形：优先系统图标（资源管理器同款，<img> 直出），没有则回退 emoji。
   * 系统图标是异步取的，未就绪时先渲染回退字形，取到后由 flushIcons 触发重渲。
   */
  function iconHtml(entry) {
    var url = iconMap[entry.path];
    if (url) {
      return '<img class="fs-icon" src="' + esc(url) + '" alt="" aria-hidden="true">';
    }
    return '<span class="fs-glyph-text">' + glyphOf(entry) + "</span>";
  }

  /** 已缓存的图标条数（key 计数即可） */
  function iconCount() {
    var n = 0;
    for (var k in iconMap) {
      if (Object.prototype.hasOwnProperty.call(iconMap, k)) n++;
    }
    return n;
  }

  /** 收集要取图标的条目并批量请求（同批去重、已在途/已缓存的跳过） */
  function requestIcons(list) {
    if (!canFileIcons || !list || !list.length) return;
    // 缓存上限：data URL 不小，超大目录（TOTAL_LIMIT 级别）不该无限攒图标。
    // 超限时整体清空（与宿主 Rust 侧 ICON_CACHE_MAX 同款策略），只影响性能不影响正确性。
    if (iconCount() >= ICON_CACHE_MAX) {
      iconMap = {};
      iconPending = {};
    }
    var want = [];
    var seen = {};
    for (var i = 0; i < list.length; i++) {
      var p = list[i].path;
      if (!p || iconMap[p] || iconPending[p] || seen[p]) continue;
      seen[p] = true;
      iconPending[p] = true;
      want.push({ path: p, isDir: !!list[i].isDir });
    }
    if (!want.length) return;
    var req = ms.input.fileIcons(want);
    Promise.resolve(req)
      .then(function (map) {
        var changed = false;
        var got = map || {};
        for (var p in got) {
          if (Object.prototype.hasOwnProperty.call(got, p) && got[p] && !iconMap[p]) {
            iconMap[p] = got[p];
            changed = true;
          }
        }
        if (changed) render();
      })
      .catch(function (err) {
        // 只有权限/集合类错误才会到这里（取不到图标是「不在返回值里」而非报错）。
        // 静默即可：图标是装饰，不该用状态行打扰用户；权限问题在扫描阶段已提示。
        if (ms.log) ms.log("debug", "取系统图标失败：" + String((err && err.message) || err));
      })
      .then(function () {
        for (var j = 0; j < want.length; j++) delete iconPending[want[j].path];
      });
  }

  /** 文件扩展名（小写；无扩展名、点开头的隐藏文件返回 ""） */
  function extOf(name) {
    var n = String(name == null ? "" : name);
    var dot = n.lastIndexOf(".");
    return dot > 0 ? n.slice(dot + 1).toLowerCase() : "";
  }

  /** 条目 → 类型页签 id */
  function catOf(entry) {
    if (entry.isDir) return "dir";
    var ext = extOf(entry.name);
    for (var i = 1; i < CATS.length; i++) {
      if (CATS[i].exts && CATS[i].exts.indexOf(ext) >= 0) return CATS[i].id;
    }
    return "other";
  }

  function inCat(entry, id) {
    return id === "all" || catOf(entry) === id;
  }

  /** 默认展示序：按修改时间从新到旧（mtimeMs 缺失按 0，即排最旧） */
  function sortByMtime(list) {
    list.sort(function (a, b) {
      return (b.mtimeMs || 0) - (a.mtimeMs || 0);
    });
    return list;
  }

  /** 查询词：空格分词、统一小写；全部命中（AND）才算匹配相对路径 */
  function splitQuery(q) {
    return String(q == null ? "" : q).trim().toLowerCase().split(/\s+/).filter(function (t) { return t !== ""; });
  }

  function matchEntry(entry, terms) {
    if (terms.length === 0) return true;
    var hay = String(entry.relPath || entry.name || "").toLowerCase();
    // 多文件夹时把来源根目录名并进匹配：输入文件夹名即可只看该根下的文件
    if (folders.length > 1 && entry.rootName) {
      hay = String(entry.rootName).toLowerCase() + "/" + hay;
    }
    for (var i = 0; i < terms.length; i++) {
      if (hay.indexOf(terms[i]) < 0) return false;
    }
    return true;
  }

  /** 命中关键词高亮：先在原文上算区间，再逐段 esc 拼接（防止转义串被误匹配） */
  function highlight(raw, terms) {
    var s = String(raw == null ? "" : raw);
    if (!terms.length) return esc(s);
    var low = s.toLowerCase();
    var marks = [];
    for (var i = 0; i < terms.length; i++) {
      var t = terms[i];
      var from = 0;
      var at;
      while ((at = low.indexOf(t, from)) >= 0) {
        marks.push([at, at + t.length]);
        from = at + t.length;
      }
    }
    if (!marks.length) return esc(s);
    marks.sort(function (a, b) { return a[0] - b[0]; });
    var merged = [marks[0]];
    for (var j = 1; j < marks.length; j++) {
      var last = merged[merged.length - 1];
      if (marks[j][0] <= last[1]) last[1] = Math.max(last[1], marks[j][1]);
      else merged.push(marks[j]);
    }
    var out = "";
    var pos = 0;
    for (var k = 0; k < merged.length; k++) {
      out += esc(s.slice(pos, merged[k][0])) +
        '<span class="fs-hit">' + esc(s.slice(merged[k][0], merged[k][1])) + "</span>";
      pos = merged[k][1];
    }
    return out + esc(s.slice(pos));
  }

  // ===== 渲染 =====
  function emptyState(icon, title, sub) {
    return '<div class="fs-empty">' +
      '<div class="fs-empty-icon">' + icon + "</div>" +
      '<div class="fs-empty-title">' + title + "</div>" +
      '<div class="fs-empty-sub">' + sub + "</div>" +
      "</div>";
  }

  /** 附加文件夹 chips（basename 展示，title 带完整路径；失败根标红 ⚠） */
  function renderFolders() {
    var el = dom["fs-folders"];
    if (!el) return;
    if (!folders.length) {
      el.innerHTML = "";
      el.hidden = true;
      return;
    }
    var html = "";
    for (var i = 0; i < folders.length; i++) {
      var f = folders[i];
      var fail = failedPaths[f.path];
      html += '<span class="fs-chip' + (fail ? " is-err" : "") + '" title="' +
        esc(fail ? f.path + " — " + fail : f.path) + '">' +
        '<span class="fs-chip-icon">📁</span>' +
        '<span class="fs-chip-name">' + esc(baseName(f.path)) + "</span>" +
        (fail ? '<span class="fs-chip-mark">⚠</span>' : "") +
        "</span>";
    }
    el.innerHTML = html;
    el.hidden = false;
  }

  /** 类型页签：数字 = 当前关键词下该类的命中数（点过去能看到几条） */
  function renderCats(terms) {
    var el = dom["fs-cats"];
    if (!el) return;
    if (entries.length === 0) {
      el.innerHTML = "";
      el.hidden = true;
      return;
    }
    var counts = {};
    CATS.forEach(function (c) { counts[c.id] = 0; });
    for (var i = 0; i < entries.length; i++) {
      if (!matchEntry(entries[i], terms)) continue;
      counts.all++;
      counts[catOf(entries[i])]++;
    }
    var html = "";
    for (var j = 0; j < CATS.length; j++) {
      var c = CATS[j];
      html += '<button type="button" class="fs-cat' + (cat === c.id ? " is-on" : "") +
        '" data-cat="' + c.id + '">' + esc(c.label) +
        '<span class="fs-cat-n">' + counts[c.id] + "</span></button>";
    }
    el.innerHTML = html;
    el.hidden = false;
  }

  function render() {
    if (!dom["fs-list"]) return;
    var terms = splitQuery(query);
    var foot = dom["fs-foot"];
    var multiRoot = folders.length > 1;

    // 还没数据：异常由状态行说明，主体区整体收起（不留空框）
    if (entries.length === 0) {
      renderCats(terms);
      dom["fs-list"].innerHTML = "";
      dom["fs-list"].hidden = true;
      if (foot) foot.hidden = true;
      if (scanned && folders.length) {
        // 扫过了但 0 项：是有效状态，给居中空态 + 统计
        setMeta("共 0 项" + (multiRoot ? " · 来自 " + folders.length + " 个文件夹" : ""));
        dom["fs-list"].hidden = false;
        dom["fs-list"].innerHTML = emptyState(
          "📂", // 📂
          "文件夹里没有文件",
          "已附加的文件夹是空的，或没有可读取的内容"
        );
        if (foot) {
          foot.textContent = "点击右上角「重新扫描」可刷新文件夹内容";
          foot.hidden = false;
        }
      } else {
        setMeta("");
      }
      return;
    }

    // 当前页签文案（空态与统计行要用）
    var catLabel = "";
    for (var ci = 0; ci < CATS.length; ci++) {
      if (CATS[ci].id === cat) catLabel = CATS[ci].label;
    }

    // 关键词 ∧ 类型页签 双重过滤（默认「全部文件」）
    var hits = [];
    var total = 0; // 关键词 ∧ 分类的命中（列表 + 「匹配」统计）
    var catTotal = 0; // 分类自身条数（不看关键词，给统计行与空态用）
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var inThis = inCat(e, cat);
      if (inThis) catTotal++;
      if (!inThis || !matchEntry(e, terms)) continue;
      total++;
      if (hits.length < RENDER_LIMIT) hits.push(e);
    }
    renderCats(terms);

    var html = "";
    if (hits.length === 0) {
      var sub;
      if (cat !== "all") {
        sub = catTotal > 0
          ? "该分类共 " + catTotal + " 项，换个关键词试试；点「全部文件」可看全部类型"
          : "扫描结果里没有这个类型的文件，点其它页签看看";
      } else if (terms.length > 1) {
        sub = "已扫描 " + entries.length + " 项；空格分隔的词需要全部命中，试试去掉一个词";
      } else {
        sub = "已扫描 " + entries.length + " 项，换个关键词试试";
      }
      html = emptyState(
        "🔍", // 🔍
        cat !== "all"
          ? "「" + esc(catLabel) + "」下没有" +
            (terms.length ? "匹配「" + esc(query) + "」的文件" : "文件")
          : "没有匹配「" + esc(query) + "」的文件",
        sub
      );
    } else {
      for (var k = 0; k < hits.length; k++) {
        var e = hits[k];
        var meta = [];
        if (!e.isDir && e.size) meta.push(fmtSize(e.size));
        if (e.mtimeMs) meta.push(fmtTime(e.mtimeMs));
        var rel = e.isDir ? e.relPath + "/" : e.relPath;
        // 多文件夹时行首标来源根：不同根下的 relPath 可能重名，不标分不清
        var pathText = multiRoot && e.rootName ? e.rootName + "/" + rel : rel;
        var hasPath = pathText.indexOf("/") >= 0; // 根目录文件没有路径行，避免显示孤零零的「.」
        html +=
          '<div class="fs-row" data-path="' + esc(e.path) + '" title="' + esc(e.path) + '">' +
          '<span class="fs-icon-box">' + iconHtml(e) + "</span>" +
          '<span class="fs-text">' +
          '<div class="fs-name">' + highlight(e.name, terms) + "</div>" +
          (hasPath ? '<div class="fs-path">' + highlight(pathText, terms) + "</div>" : "") +
          "</span>" +
          (meta.length ? '<span class="fs-size">' + esc(meta.join(" · ")) + "</span>" : "") +
          // 定位按钮（始终显示）：点击在资源管理器中打开并选中该条目；
          // 旧宿主没有 ms.input.reveal 时整体不渲染，避免点了没反应。
          // 图标用内联 SVG（不用 emoji，跨平台/主题下形状与颜色可控）。
          (canReveal
            ? '<button type="button" class="fs-locate" data-locate="' + esc(e.path) +
              '" title="在资源管理器中定位" aria-label="在资源管理器中定位">' +
              LOCATE_SVG +
              "</button>"
            : "") +
          "</div>";
      }
      if (total > hits.length) {
        html += '<div class="fs-more">共 ' + total + " 个匹配，仅显示前 " + hits.length + " 条，请细化关键词</div>";
      }
    }
    dom["fs-list"].innerHTML = html;
    dom["fs-list"].hidden = false;
    // 渲染后补取可见条目的系统图标（资源管理器同款）；到货后 render() 自会重绘
    if (hits.length) requestIcons(hits);

    // 统计行：分类非「全部」时带上该类总数；0 命中也照常刷新
    var rootNote = multiRoot ? " · 来自 " + folders.length + " 个文件夹" : "";
    var scope;
    if (cat === "all") {
      scope = terms.length
        ? "匹配 " + total + " / 共 " + entries.length + " 项"
        : "共 " + entries.length + " 项";
    } else {
      scope = terms.length
        ? "匹配 " + total + " / 分类「" + esc(catLabel) + "」" + catTotal + " 项 · 共 " + entries.length + " 项"
        : "分类「" + esc(catLabel) + "」" + catTotal + " 项 · 共 " + entries.length + " 项";
    }
    setMeta(
      scope + rootNote +
        (terms.length ? " · 关键词「<span class=\"fs-q\">" + esc(query) + "</span>\"" : "")
    );

    if (foot) {
      var tip = canReveal
        ? "点击条目用系统默认程序打开；点行尾文件夹图标在资源管理器中定位"
        : "点击条目用系统默认程序打开";
      var footText = terms.length
        ? tip
        : "在搜索框输入「文件搜索 : 关键词」回车可筛选；" + tip;
      if (capped) {
        footText += "；已达 " + TOTAL_LIMIT + " 项扫描上限，部分文件夹未完整列举";
      }
      foot.textContent = footText;
      foot.hidden = false;
    }
  }

  /** 权限/能力类错误 → 状态行给可操作的提示 */
  function explainError(e) {
    var msg = String((e && e.message) || e);
    if (msg.indexOf("file.read") >= 0) {
      return "缺少「读取附加文件」权限（file.read）：请在 设置 → 插件 → 文件搜索 中授予后重新打开";
    }
    if (msg.indexOf("附加") >= 0 || msg.indexOf("网关") >= 0) {
      return msg;
    }
    return msg;
  }

  // ===== 扫描 =====
  /** 扫描中按钮 = 「停止」；空闲 = 「重新扫描」 */
  function setScanButton(busy) {
    var btn = dom["fs-rescan"];
    if (!btn) return;
    btn.textContent = busy ? "停止" : "重新扫描";
    if (busy) btn.classList.add("is-stop");
    else btn.classList.remove("is-stop");
  }

  /**
   * 收尾一轮扫描：把已返回的结果装配成 entries（按修改时间从新到旧排序）
   * 并渲染。两种触发：全部根返回（stopped=false）、或用户点「停止」
   * （stopped=true，立即用已返回的部分收尾）。每轮只生效一次；停止后才
   * 迟到的根被 round.finished 挡掉，不会覆盖已展示的部分结果。
   */
  function finishRound(round, stopped) {
    if (round.finished) return;
    if (!stopped && round.done < round.results.length) return; // 还没集齐，继续等
    if (activeRound !== round) return; // 已有新轮，旧轮作废
    round.finished = true;
    scanning = false;
    activeRound = null;
    setScanButton(false);
    if (stopped) pendingRescan = false; // 用户主动停：附件变化不再触发补扫

    var got = 0;
    var failCount = 0;
    var firstErr = null;
    capped = false;
    var failed = {};
    var list = [];
    for (var i = 0; i < round.results.length; i++) {
      var r = round.results[i];
      if (!r) continue; // 停止时尚未返回的根
      var root = round.folders[i] || {};
      got++;
      if (r.list) {
        var rootName = baseName(root.path);
        if (r.list.length >= LIST_LIMIT) capped = true; // 单根被 Rust 侧截断
        for (var j = 0; j < r.list.length; j++) {
          if (list.length >= TOTAL_LIMIT) {
            capped = true;
            break;
          }
          r.list[j].rootName = rootName; // 行内标注来源根（多根展示与过滤用）
          list.push(r.list[j]);
        }
      } else {
        failCount++;
        failed[root.path] = explainError(r.err);
        if (!firstErr) firstErr = r.err;
      }
    }

    entries = list;
    failedPaths = failed;
    // 换了结果集：旧图标缓存按路径仍然有效（同文件图标不变），保留即可；
    // 但「在途」标记要清，避免上一轮未返回的请求挡住本轮重取。
    iconPending = {};
    sortByMtime(entries);
    renderFolders(); // 失败根标红（部分失败时尤其需要：定位是哪一路挂了）

    // 没有任何可展示数据：停止 → 中性提示；否则是整体扫描失败
    //（不能进「文件夹里没有文件」的空态，会误导）
    if (entries.length === 0 && (got === 0 || failCount === got)) {
      scanned = false;
      render();
      setStatus(
        stopped
          ? got === 0
            ? "已停止：未收集到结果"
            : "已停止：" + failCount + " 个文件夹扫描失败"
          : "扫描失败（" + failCount + " 个文件夹）：" + explainError(firstErr),
        stopped ? "warn" : "err"
      );
      finishSideEffects(stopped);
      return;
    }

    scanned = true;
    if (stopped) {
      setStatus(
        "已停止：收集到 " + entries.length + " 项（" + got + "/" + round.results.length +
          " 个文件夹完成）" + (failCount ? "，" + failCount + " 个失败" : ""),
        "warn"
      );
    } else if (failCount > 0) {
      setStatus(failCount + " / " + round.results.length + " 个文件夹扫描失败，已展示其余结果", "warn");
    } else {
      setStatus(""); // 成功不占状态行，总数交给统计行
    }
    render();
    finishSideEffects(stopped);
  }

  /** 收尾后的联动：自然结束且扫描期间附件增删过 → 补一轮（停止时不补） */
  function finishSideEffects(stopped) {
    if (stopped) return;
    if (pendingRescan) {
      pendingRescan = false;
      refresh();
    }
  }

  function refresh() {
    if (scanning) {
      // 不能并发起两轮（gen/装配会互踩）：标记完等这轮结束再补扫
      pendingRescan = true;
      return;
    }
    if (!ms.input || typeof ms.input.attachments !== "function") {
      setStatus("宿主不支持附件 API（请升级应用）", "err");
      return;
    }

    var atts;
    try {
      atts = ms.input.attachments() || [];
    } catch (e) {
      entries = [];
      scanned = false;
      render();
      setStatus(explainError(e), "err");
      return;
    }
    folders = atts.filter(function (a) { return a && a.kind === "folder"; });
    failedPaths = {};
    capped = false;
    renderFolders();

    if (folders.length === 0) {
      entries = [];
      scanned = false;
      render();
      setStatus("请先在搜索框粘贴或拖入文件夹（可多个）", "warn");
      return;
    }

    scanning = true;
    setScanButton(true);
    setStatus("正在扫描 " + folders.length + " 个文件夹…（点「停止」可中断）");

    var round = {
      gen: ++scanGen, // 本轮代次：停止时 Rust 按它中止在途 walk
      folders: folders.slice(), // 快照：收尾时与 results 按下标配对
      results: new Array(folders.length).fill(null),
      done: 0,
      finished: false,
    };
    activeRound = round;

    // 逐根发起（不用 allSettled：「停止」需要在部分根返回时就能收尾展示）
    round.folders.forEach(function (f, i) {
      var p;
      try {
        p = ms.input.listFolder(f.path, { limit: LIST_LIMIT, gen: round.gen });
      } catch (e2) {
        p = Promise.reject(e2);
      }
      Promise.resolve(p)
        .then(
          function (list) { round.results[i] = { list: list || [] }; },
          function (err) { round.results[i] = { err: err }; }
        )
        .then(function () {
          round.done++;
          finishRound(round, false);
        });
    });
  }

  /** 「停止」：立即用已返回的部分收尾，并通知 Rust 中止在途 walk */
  function stopScan() {
    if (!scanning || !activeRound) return;
    var round = activeRound;
    finishRound(round, true); // 先收 UI（按钮与部分结果立刻就位）
    try {
      if (ms.input && typeof ms.input.cancelListFolder === "function") {
        var p = ms.input.cancelListFolder(round.gen);
        if (p && typeof p.catch === "function") p.catch(function () {});
      }
    } catch (e) {
      /* 旧宿主没有该 API：仅前端停止，后端 walk 自行跑完（有上限，不会失控） */
    }
  }

  // ===== 事件 =====
  // 子关键词（搜索框「文件搜索 : yyy」回车推入；挂载时宿主也会自动推一次）
  if (typeof onSubKeyword === "function") {
    onSubKeyword(function (msg) {
      query = String(msg == null ? "" : msg);
      render();
      return true;
    });
  }

  // 列表点击：文件夹定位按钮 → 资源管理器中定位；行其余区域 → 系统默认程序打开
  //（两种都走 Rust 侧校验：路径必须在附加集合内）
  if (dom["fs-list"]) {
    dom["fs-list"].addEventListener("click", function (e) {
      var t = e.target;
      var locateBtn = t && t.closest ? t.closest(".fs-locate") : null;
      if (locateBtn) {
        e.stopPropagation();
        var lp = locateBtn.getAttribute("data-locate");
        if (!lp || !ms.input || typeof ms.input.reveal !== "function") return;
        Promise.resolve(ms.input.reveal(lp)).catch(function (err) {
          setStatus("定位失败：" + explainError(err), "err");
        });
        return;
      }
      var row = t && t.closest ? t.closest(".fs-row") : null;
      if (!row) return;
      var path = row.getAttribute("data-path");
      if (!path || !ms.input || typeof ms.input.open !== "function") return;
      Promise.resolve(ms.input.open(path)).catch(function (err) {
        setStatus("打开失败：" + explainError(err), "err");
      });
    });
  }

  if (dom["fs-rescan"]) {
    dom["fs-rescan"].addEventListener("click", function () {
      if (scanning) stopScan();
      else refresh();
    });
  }

  // 类型页签切换（只重渲列表与统计；计数跟着关键词实时变）
  if (dom["fs-cats"]) {
    dom["fs-cats"].addEventListener("click", function (e) {
      var btn = e.target && e.target.closest ? e.target.closest(".fs-cat") : null;
      if (!btn) return;
      var id = btn.getAttribute("data-cat");
      if (!id || id === cat) return;
      for (var i = 0; i < CATS.length; i++) {
        if (CATS[i].id === id) {
          cat = id;
          render();
          return;
        }
      }
    });
  }

  // 附件变化广播（宿主在粘贴/拖入/移除后派发；事件名与 usePluginViewHost
  // 的 ATTACHMENTS_CHANGED_EVENT 字符串约定一致）。挂在 document 上：
  // 停靠（最小化）中的会话 DOM 仍在文档里，同样收得到。用挂载时捕获的
  // 根节点判活——会话被卸载（exit）后老实例自动失效，不会写进旧 DOM。
  document.addEventListener("ms-attachments-changed", function () {
    if (!rootEl || !rootEl.isConnected) return;
    if (scanning) {
      pendingRescan = true;
      return;
    }
    refresh();
  });

  // ===== 初始化 =====
  // 输入框里已有的「父 : 子」直接当首屏查询（挂载后宿主还会再推一次，幂等）
  if (typeof inputValue === "string" && inputValue.indexOf(" : ") >= 0) {
    query = String(inputValue).split(" : ").slice(1).join(" : ").trim();
  }
  refresh();
  render();

})(ms, env, plugin, host, keyword, inputValue, onSubKeyword, md2html, openExternal);
