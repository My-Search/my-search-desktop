/**
 * 截图插件 - 前台入口脚本
 *
 * 宿主注入参数: ms, env, plugin, host, keyword, inputValue, onSubKeyword, md2html, openExternal
 * （宿主用 `new Function("ms","env","plugin","host",... , code)` 调用本文件，
 *  所以下面 IIFE 的形参声明 + 末尾实参回传是必需的：既拿到注入值，
 *  又让本文件能被当普通 <script> 直接加载调试。）
 *
 * ============================ 这个插件做了什么 ============================
 *
 * 三条能力，全部围绕「截图」：
 *
 *   1) **全局快捷键截图**：按 Ctrl+Alt+X（可在本页顶部改绑）→ 宿主弹全屏遮罩
 *      → 拖拽框选 → 标注 → 「复制」进系统剪贴板，或「保存」落盘。
 *      热键由**宿主**注册（`screenshot` 动作，见宿主 lib.rs 的
 *      register_binding_handlers）；本插件只通过 `ms.screenshot.getShortcut/
 *      setShortcut` 读写**自己这一条**绑定，不自己存一份键值，
 *      因此和「设置 → 快捷键」面板永远一致。
 *
 *   2) **查看最近 7 天截图**：`ms.screenshot.list()` 拿到插件私有目录里的
 *      全部截图 → 在前端按 mtimeMs 过滤出 7 天内的 → 分页展示（每页 24 张）。
 *      缩略图懒加载（IntersectionObserver），点开看大图 / 复制 / 删除。
 *
 *   3) **自动刷新**：插件视图开着时，宿主遮罩保存完会广播
 *      `my-search://screenshot-saved`，`ms.screenshot.onSaved` 收到后重扫列表。
 *      视图没开时事件自然丢弃，下次打开 `list()` 兜底——所以不需要常驻轮询。
 *
 * ============================ 关于「后台运行」============================
 *
 * 本插件**不需要**后台进程来支撑上面三条能力：热键注册在宿主 Rust 侧，
 * 截图与落盘也在宿主 Rust 侧，只有「画廊界面」需要插件代码，而它只在
 * 用户打开插件时才跑。因此我们**没有**申请 `backend.spawn` 权限——这是
 * 刻意的：能不给的重权限就不给（`backend.spawn` 是「等同运行本机程序」的
 * 极高风险权限）。
 *
 * backend/ 目录里的进程是**可选示例**：它演示「插件自带后台进程」这条链路
 * （jsonrpc-stdio 握手、PowerShell 抓屏兜底、在插件私有目录里落盘+建索引）。
 * 想学后台进程怎么写可以看它；不申请 backend.spawn 时它不会被启动。
 *
 * ============================ 数据放在哪 ============================
 *
 * 截图文件：`<app_data>/plugin-data/com.zhuangjie.screenshot/shots/*.png`
 *   —— 宿主 `screenshot_save_shot` 写、`screenshot_read_shot` 读，
 *   路径由宿主拼（插件只能给相对名），从根上杜绝目录穿越。
 * 界面偏好：`ms.store`（localStorage，按插件 id 命名空间隔离），
 *   例如每页张数、上次分页位置。
 */
(function (ms, env, plugin, host, keyword, inputValue, onSubKeyword, md2html, openExternal) {
  "use strict";

  /* ======================= 常量 ======================= */

  /** 「最近 N 天」窗口（需求：最近 7 天） */
  var RECENT_DAYS = 7;
  /** 每页张数（分页粒度） */
  var PAGE_SIZE = 24;
  /** 一天毫秒数 */
  var DAY_MS = 24 * 60 * 60 * 1000;
  /** 缩略图并发上限：一次别把几十张图全读进来（每张都是完整 PNG 的 base64） */
  var THUMB_CONCURRENCY = 4;

  /* ======================= DOM ======================= */
  var dom = {};
  ["ss-status", "ss-meta", "ss-grid", "ss-empty", "ss-pager", "ss-pageinfo",
   "ss-prev", "ss-next", "ss-hotkey-btn", "ss-hotkey-clear", "ss-empty-key",
   "ss-shot", "ss-refresh", "ss-viewer", "ss-viewer-img", "ss-viewer-name"].forEach(function (id) {
    dom[id] = document.getElementById(id);
  });
  /** 本实例根节点：会话被宿主「保活」后旧实例仍在内存里，靠它判活（别打扰新实例） */
  var rootEl = document.getElementById("app");

  /* ======================= 状态 ======================= */
  /** 全部（未过滤）截图，按时间从新到旧 —— 宿主 list() 已排好序 */
  var all = [];
  /** 过滤后的「最近 7 天」列表 */
  var recent = [];
  /** 当前页（从 0 开始） */
  var page = 0;
  /** 正在刷新（防重入） */
  var loading = false;
  /** 待重扫标记：刷新中又有新事件时，等这轮结束再补一次 */
  var pendingReload = false;
  /** 大图预览当前项 */
  var viewerItem = null;

  /* ======================= 小工具 ======================= */

  /** 写状态行（只放异常/过程消息；成功后清空并整行隐藏，不留空行） */
  function setStatus(text, isError) {
    if (!dom["ss-status"]) return;
    if (!text) {
      dom["ss-status"].textContent = "";
      dom["ss-status"].hidden = true;
      dom["ss-status"].classList.remove("error");
      return;
    }
    dom["ss-status"].textContent = text;
    dom["ss-status"].hidden = false;
    dom["ss-status"].classList.toggle("error", !!isError);
  }

  /** 毫秒时间戳 → 本地「MM-DD HH:mm」 */
  function formatTime(ms) {
    var d = new Date(Number(ms) || 0);
    if (isNaN(d.getTime())) return "";
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  /** 把「ms.screenshot.getShortcut」的键值转成展示形态（ctrl+alt+x → Ctrl+Alt+X） */
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

  /** 当前视图是否还活着（宿主关闭视图 / 换插件后旧实例要停止动作） */
  function alive() {
    return !!rootEl && rootEl.isConnected;
  }

  /* ======================= 快捷键 ======================= */

  /** 显示当前绑定的截图热键 */
  function renderHotkey(key) {
    var btn = dom["ss-hotkey-btn"];
    var clear = dom["ss-hotkey-clear"];
    var emptyKey = dom["ss-empty-key"];
    if (btn) {
      btn.textContent = key ? prettyShortcut(key) : "未设置";
      btn.classList.remove("capturing", "invalid");
    }
    if (clear) clear.hidden = !key;
    if (emptyKey) emptyKey.textContent = key ? prettyShortcut(key) : "快捷键";
  }

  /** 拉取当前热键（权威在宿主 settings.json；可能有别的入口改过，所以每次都读） */
  function loadHotkey() {
    if (typeof ms.screenshot?.getShortcut !== "function") return;
    Promise.resolve(ms.screenshot.getShortcut())
      .then(function (key) { if (alive()) renderHotkey(key); })
      .catch(function () { /* 读不到就保持原样，不打扰用户 */ });
  }

  /**
   * 录入新热键：点击后监听下一次 keydown，取「修饰键 + 主键」拼成宿主格式。
   * 只认带修饰键的组合（与宿主面板一致：单一主键做全局热键太容易误触/冲突）。
   */
  function startCapture() {
    var btn = dom["ss-hotkey-btn"];
    if (!btn || btn.classList.contains("capturing")) return;
    btn.classList.add("capturing");
    btn.textContent = "按下组合键…";

    function onKey(e) {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") {
        cleanup();
        loadHotkey();
        return;
      }

      var parts = [];
      if (e.ctrlKey) parts.push("ctrl");
      if (e.altKey) parts.push("alt");
      if (e.shiftKey) parts.push("shift");
      if (e.metaKey) parts.push("super");

      var key = e.key;
      // 只按下修饰键本身：继续等主键
      if (["Control", "Alt", "Shift", "Meta"].indexOf(key) >= 0) return;

      var main = key.length === 1 ? key.toLowerCase() : key.toLowerCase();
      if (main === " ") main = "space";
      parts.push(main);

      if (parts.length < 2) {
        // 没有修饰键：拒绝（提示后继续录）
        btn.classList.add("invalid");
        btn.textContent = "需要带修饰键（如 Ctrl+Alt+X）";
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

  /** 提交新热键给宿主（冲突等错误原样展示） */
  function applyHotkey(combo) {
    if (typeof ms.screenshot?.setShortcut !== "function") {
      setStatus("当前宿主版本不支持在插件内改快捷键，请到「设置 → 快捷键」修改", true);
      loadHotkey();
      return;
    }
    Promise.resolve(ms.screenshot.setShortcut(combo))
      .then(function (effective) {
        renderHotkey(effective || combo);
        setStatus("已绑定截图快捷键：" + prettyShortcut(effective || combo));
        setTimeout(function () { if (alive()) setStatus(""); }, 2500);
      })
      .catch(function (e) {
        setStatus("快捷键设置失败：" + errorText(e), true);
        loadHotkey();
      });
  }

  /** 解绑（关掉全局截图热键） */
  function clearHotkey() {
    if (typeof ms.screenshot?.setShortcut !== "function") return;
    Promise.resolve(ms.screenshot.setShortcut(""))
      .then(function () {
        renderHotkey("");
        setStatus("已解绑截图快捷键");
        setTimeout(function () { if (alive()) setStatus(""); }, 2000);
      })
      .catch(function (e) { setStatus("解绑失败：" + errorText(e), true); });
  }

  /* ======================= 开始截图 ======================= */

  /**
   * 触发一次框选截图：调宿主遮罩。
   *
   * 注意 `openOverlay` 返回的是「开了几个遮罩窗口」，不是图片 —— 用户框选
   * 与标注都在遮罩窗口里完成，结果由遮罩自己写剪贴板/落盘，然后广播
   * `screenshot-saved`，本页通过 onSaved 刷新。这样设计是因为：截图产出的
   * 那一刻用户可能已经关了插件视图，把结果留在遮罩侧更稳。
   */
  function startCapture_shot() {
    if (typeof ms.screenshot?.openOverlay !== "function") {
      setStatus("当前宿主版本不支持框选截图", true);
      return;
    }
    setStatus("正在打开截图遮罩…");
    Promise.resolve(ms.screenshot.openOverlay())
      .then(function (count) {
        if (!alive()) return;
        setStatus(count > 1 ? "已在 " + count + " 个屏幕上打开遮罩，拖拽选择区域" : "拖拽选择要截取的区域");
        setTimeout(function () { if (alive()) setStatus(""); }, 3000);
      })
      .catch(function (e) { setStatus("打开截图遮罩失败：" + errorText(e), true); });
  }

  /* ======================= 列表 / 分页 ======================= */

  /** 错误对象 → 可读文本（宿主抛的是带中文 message 的 Error） */
  function errorText(e) {
    if (!e) return "未知错误";
    return String(e.message || e);
  }

  /** 只保留最近 N 天（按毫秒时间戳比较，避免依赖宿主的时间格式） */
  function filterRecent(items) {
    var cutoff = Date.now() - RECENT_DAYS * DAY_MS;
    return items.filter(function (it) { return Number(it.mtimeMs) >= cutoff; });
  }

  function pageCount() {
    return Math.max(1, Math.ceil(recent.length / PAGE_SIZE));
  }

  /** 拉全量列表 → 过滤 7 天 → 渲染当前页 */
  function reload(resetPage) {
    if (!alive()) return;
    if (loading) { pendingReload = true; return; }
    if (typeof ms.screenshot?.list !== "function") {
      setStatus("当前宿主版本不支持读取截图列表", true);
      return;
    }

    loading = true;
    setStatus(recent.length === 0 ? "正在读取截图…" : "");
    Promise.resolve(ms.screenshot.list())
      .then(function (items) {
        if (!alive()) return;
        all = Array.isArray(items) ? items : [];
        recent = filterRecent(all);
        if (resetPage) page = 0;
        // 删到当前页空了 → 回退到最后一页（否则会停在空白页）
        if (page > pageCount() - 1) page = pageCount() - 1;
        setStatus("");
        render();
      })
      .catch(function (e) {
        if (alive()) setStatus("读取截图失败：" + errorText(e), true);
      })
      .then(function () {
        loading = false;
        if (pendingReload) { pendingReload = false; reload(true); }
      });
  }

  /** 渲染统计 + 画廊 + 分页 */
  function render() {
    var total = all.length;
    if (dom["ss-meta"]) {
      // 常驻统计：0 命中也要照常刷新，不留空
      dom["ss-meta"].textContent =
        "最近 " + RECENT_DAYS + " 天 " + recent.length + " 张 · 共 " + total + " 张";
    }

    var grid = dom["ss-grid"];
    var empty = dom["ss-empty"];
    var pager = dom["ss-pager"];

    if (!grid) return;
    grid.innerHTML = "";

    if (recent.length === 0) {
      if (empty) empty.hidden = false;
      if (pager) pager.hidden = true;
      return;
    }
    if (empty) empty.hidden = true;

    var start = page * PAGE_SIZE;
    var slice = recent.slice(start, start + PAGE_SIZE);
    slice.forEach(function (item) { grid.appendChild(buildCard(item)); });

    // 分页：只有一页时也不隐藏（显示「第 1 / 1 页」让用户知道看全了没）
    if (pager) pager.hidden = false;
    if (dom["ss-pageinfo"]) {
      dom["ss-pageinfo"].textContent = "第 " + (page + 1) + " / " + pageCount() + " 页";
    }
    if (dom["ss-prev"]) dom["ss-prev"].disabled = page <= 0;
    if (dom["ss-next"]) dom["ss-next"].disabled = page >= pageCount() - 1;

    // 缩略图：只读当前页（限流），翻页才读下一页
    loadThumbs(slice);
  }

  /** 造一张卡片（缩略图先占位，进视口再加载） */
  function buildCard(item) {
    var card = document.createElement("div");
    card.className = "ss-card";
    card.setAttribute("data-rel", item.relPath);
    card.title = item.relPath + "\n" + formatTime(item.mtimeMs);

    var ph = document.createElement("div");
    ph.className = "ss-thumb-placeholder";
    ph.textContent = "加载中…";
    card.appendChild(ph);

    var foot = document.createElement("div");
    foot.className = "ss-card-foot";

    var time = document.createElement("span");
    time.className = "ss-card-time";
    time.textContent = formatTime(item.mtimeMs);
    foot.appendChild(time);

    var del = document.createElement("button");
    del.className = "ss-card-del";
    del.type = "button";
    del.textContent = "✕";
    del.title = "删除这张截图";
    del.addEventListener("click", function (e) {
      e.stopPropagation();
      removeItem(item);
    });
    foot.appendChild(del);

    card.appendChild(foot);

    card.addEventListener("click", function () { openViewer(item); });
    return card;
  }

  /**
   * 加载当前页的缩略图。
   *
   * 只读**当前页**（≤ PAGE_SIZE 张），并发不超过 THUMB_CONCURRENCY —— 每张
   * readShot 都要把整个 PNG 读成 base64 传过来，不便宜，所以要限流；
   * 但也不必做视口懒加载：一页最多 24 张，限流后开销可控，而
   * IntersectionObserver 在部分环境（headless / 无合成器）不触发回调，
   * 「缩略图永远加载中」的故障比起多读几张严重得多。翻页才读下一页，
   * 天然就是懒加载。
   *
   * 已加载的卡片打 `data-loaded` 标记，切页回来不重复读。
   */
  var thumbQueue = [];
  var thumbActive = 0;

  function loadThumbs(slice) {
    var targets = slice.map(function (it) {
      var el = dom["ss-grid"].querySelector('[data-rel="' + cssEscape(it.relPath) + '"]');
      return el ? { item: it, el: el } : null;
    }).filter(Boolean);
    targets.forEach(function (t) { enqueueThumb(t); });
  }

  function enqueueThumb(t) {
    if (!t.el || t.el.getAttribute("data-loaded") === "1") return;
    thumbQueue.push(t);
    pumpThumbs();
  }

  function pumpThumbs() {
    while (thumbActive < THUMB_CONCURRENCY && thumbQueue.length > 0) {
      var t = thumbQueue.shift();
      if (!t.el || !t.el.isConnected || t.el.getAttribute("data-loaded") === "1") continue;
      thumbActive++;
      loadOneThumb(t);
    }
  }

  function loadOneThumb(t) {
    t.el.setAttribute("data-loaded", "1"); // 先标记，避免重复入队
    Promise.resolve(ms.screenshot.readShot(t.item.relPath))
      .then(function (dataUrl) {
        if (!alive() || !t.el.isConnected) return;
        var img = document.createElement("img");
        img.className = "ss-thumb";
        img.src = dataUrl;
        img.alt = "";
        img.draggable = false;
        t.el.replaceChild(img, t.el.firstChild);
      })
      .catch(function (e) {
        if (t.el.isConnected) {
          t.el.firstChild.textContent = "读取失败";
          t.el.firstChild.title = errorText(e);
        }
      })
      .then(function () {
        thumbActive--;
        pumpThumbs();
      });
  }

  /** 选择器转义（relPath 里有点和斜杠，直接拼进 [data-rel=""] 会炸） */
  function cssEscape(s) {
    return String(s).replace(/["\\]/g, "\\$&");
  }

  /* ======================= 单张操作 ======================= */

  /** 打开大图预览 */
  function openViewer(item) {
    if (!dom["ss-viewer"]) return;
    viewerItem = item;
    if (dom["ss-viewer-name"]) dom["ss-viewer-name"].textContent = item.relPath;
    if (dom["ss-viewer-img"]) dom["ss-viewer-img"].src = "";
    dom["ss-viewer"].hidden = false;

    Promise.resolve(ms.screenshot.readShot(item.relPath))
      .then(function (dataUrl) {
        if (!alive() || !dom["ss-viewer-img"]) return;
        dom["ss-viewer-img"].src = dataUrl;
      })
      .catch(function (e) {
        setStatus("读取大图失败：" + errorText(e), true);
        closeViewer();
      });
  }

  function closeViewer() {
    if (!dom["ss-viewer"]) return;
    dom["ss-viewer"].hidden = true;
    if (dom["ss-viewer-img"]) dom["ss-viewer-img"].src = "";
    viewerItem = null;
  }

  /** 把预览中的截图复制到系统剪贴板 */
  function copyViewer() {
    if (!viewerItem) return;
    var url = dom["ss-viewer-img"] ? dom["ss-viewer-img"].src : "";
    if (!url) return;
    Promise.resolve(ms.screenshot.copy(url))
      .then(function () {
        setStatus("已复制到剪贴板");
        setTimeout(function () { if (alive()) setStatus(""); }, 2000);
      })
      .catch(function (e) { setStatus("复制失败：" + errorText(e), true); });
  }

  /**
   * 把预览中的截图「另存为」到用户选定的位置（系统保存对话框）。
   *
   * 用 `saveAs`（弹对话框）而不是 `save`（静默写进插件私有目录）：这个按钮
   * 的语义就是「我要把这张图拿出去用」——放桌面、放共享盘、发给同事。
   * 用户取消对话框时宿主 resolve(null)，不是错误，静默返回即可。
   */
  function saveAsViewer() {
    if (!viewerItem) return;
    var url = dom["ss-viewer-img"] ? dom["ss-viewer-img"].src : "";
    if (!url) return;
    if (typeof ms.screenshot?.saveAs !== "function") {
      setStatus("当前宿主版本不支持另存为", true);
      return;
    }
    Promise.resolve(ms.screenshot.saveAs(url))
      .then(function (savedPath) {
        if (!alive() || !savedPath) return; // null = 用户取消
        setStatus("已保存到：" + savedPath);
        setTimeout(function () { if (alive()) setStatus(""); }, 3000);
      })
      .catch(function (e) { setStatus("保存失败：" + errorText(e), true); });
  }

  /** 删除一张（先确认；宿主只删自己私有目录内的文件） */
  function removeItem(item) {
    var name = item.relPath;
    Promise.resolve(ms.ui?.confirm ? ms.ui.confirm("删除这张截图？\n" + name) : true)
      .then(function (ok) {
        if (ok === false) return null;
        return Promise.resolve(ms.screenshot.remove(item.relPath));
      })
      .then(function (r) {
        if (r === null) return; // 用户取消
        if (viewerItem && viewerItem.relPath === item.relPath) closeViewer();
        reload(false);
      })
      .catch(function (e) { setStatus("删除失败：" + errorText(e), true); });
  }

  /* ======================= 事件绑定 ======================= */

  function bind() {
    dom["ss-hotkey-btn"]?.addEventListener("click", startCapture);
    dom["ss-hotkey-clear"]?.addEventListener("click", clearHotkey);
    dom["ss-shot"]?.addEventListener("click", startCapture_shot);
    dom["ss-refresh"]?.addEventListener("click", function () { reload(true); });

    dom["ss-prev"]?.addEventListener("click", function () {
      if (page > 0) { page--; persistPage(); render(); }
    });
    dom["ss-next"]?.addEventListener("click", function () {
      if (page < pageCount() - 1) { page++; persistPage(); render(); }
    });

    dom["ss-viewer-close"]?.addEventListener("click", closeViewer);
    dom["ss-viewer"]?.addEventListener("click", function (e) {
      // 点遮罩空白处关闭（点图片/工具条不关）
      if (e.target === dom["ss-viewer"]) closeViewer();
    });
    dom["ss-viewer-copy"]?.addEventListener("click", copyViewer);
    dom["ss-viewer-saveas"]?.addEventListener("click", saveAsViewer);

    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if (dom["ss-viewer"] && !dom["ss-viewer"].hidden) {
        e.preventDefault();
        closeViewer();
      }
    });
  }

  /** 记住上次看到第几页（视图被保活/重开时体验连续） */
  function persistPage() {
    try { ms.store?.set("page", page); } catch (e) { /* store 未授权：忽略 */ }
  }

  function restorePage() {
    try {
      var saved = ms.store?.get("page", 0);
      var n = Math.floor(Number(saved));
      if (isFinite(n) && n >= 0) page = n;
    } catch (e) { /* 忽略 */ }
  }

  /* ======================= 启动 ======================= */

  bind();
  restorePage();
  loadHotkey();
  reload(false);

  /**
   * 宿主遮罩保存截图后广播事件 → 自动刷新。
   *
   * 只认本插件的事件（宿主可能带上别的 pluginId）。
   * 视图没打开时事件丢弃，下次打开 list() 兜底，因此不必常驻轮询。
   */
  if (typeof ms.screenshot?.onSaved === "function") {
    ms.screenshot.onSaved(function (payload) {
      if (!alive()) return;
      if (payload && payload.pluginId && payload.pluginId !== plugin.id) return;
      setStatus("检测到新截图，正在刷新…");
      reload(true);
    });
  }

  /**
   * 宿主在详情视图打开/关闭时会派发这些事件（与 file-search 同款约定），
   * 用于会话被保活时判断自己是否还该响应。
   */
  document.addEventListener("ms-attachments-changed", function () {
    if (!alive()) return;
  });

  ms.log("info", "截图插件已加载" + (plugin && plugin.id ? "（" + plugin.id + "）" : ""));
})(ms, env, plugin, host, keyword, inputValue, onSubKeyword, md2html, openExternal);
