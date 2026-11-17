/**
 * 软件卸载器 —— 前端入口脚本
 *
 * 宿主注入参数: ms, env, plugin, host, keyword, inputValue, onSubKeyword, md2html, openExternal
 *
 * 数据流：
 *   - 列表来自后端 `list`（注册表 Uninstall 键），前端搜索/过滤纯本地；
 *   - 「卸载」调后端 `uninstall`：只传软件 id，命令由后端按注册表启动，
 *     前端永远不拼命令行；
 *   - 「扫描残留」调后端 `scan`：返回候选列表（安装目录/快捷方式/注册表），
 *     默认**全部勾选但用户可自由调整**，清理前经宿主确认弹窗二次确认；
 *   - 「清理选中」调后端 `clean`：scanId + 勾选的 id，路径校验全部在后端。
 */
(function (ms, env, plugin, host, keyword, inputValue, onSubKeyword, md2html, openExternal) {
  "use strict";

  var appEl = document.getElementById("app");
  if (!appEl) return;

  // ===== DOM =====
  var dom = {};
  ["un-refresh", "un-stats", "un-search", "un-platform", "un-status", "un-list",
   "un-empty", "un-empty-text", "un-residue", "un-residue-title", "un-residue-close",
   "un-check-all", "un-residue-meta", "un-clean", "un-residue-list"
  ].forEach(function (id) {
    dom[id] = document.getElementById(id);
  });

  function alive() {
    return document.body && document.body.contains(appEl);
  }

  // ===== 状态 =====
  /** 全部已安装软件（后端权威数据） */
  var items = [];
  /** 当前搜索词（本地过滤） */
  var query = "";
  /** 平台是否受支持（后端 init 返回） */
  var supported = true;
  /** 最近一次残留扫描 { scanId, name, items } */
  var residue = null;
  /** 正在加载/操作（防重入） */
  var busy = false;
  /** 挂载时记录的软件快照（id → item）：卸载进程退出通知到达时按它找「刚卸载的是谁」 */
  var installedSnapshot = {};

  // ===== 工具 =====

  function escapeHtml(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function errorText(e) {
    if (!e) return "未知错误";
    return String(e.message || e);
  }

  function setStatus(text, isError) {
    if (!dom["un-status"]) return;
    if (!text) {
      dom["un-status"].hidden = true;
      dom["un-status"].textContent = "";
      dom["un-status"].className = "un-status";
      return;
    }
    dom["un-status"].hidden = false;
    dom["un-status"].textContent = text;
    dom["un-status"].className = "un-status" + (isError ? " error" : "");
  }

  function toast(text, type) {
    try {
      ms.ui.toast(text, type || "info");
    } catch (e) {
      /* ui.notify 未授予：忽略 */
    }
  }

  /** 字节数 → 人类可读 */
  function formatBytes(n) {
    var v = Number(n) || 0;
    if (v < 1024) return v + " B";
    if (v < 1024 * 1024) return (v / 1024).toFixed(1) + " KB";
    if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + " MB";
    return (v / 1024 / 1024 / 1024).toFixed(2) + " GB";
  }

  /** YYYYMMDD → YYYY-MM-DD（注册表 InstallDate 的存储格式） */
  function formatDate(s) {
    var m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(s || ""));
    return m ? m[1] + "-" + m[2] + "-" + m[3] : "";
  }

  /** 后端调用（统一错误文案；后台进程由宿主按需拉起） */
  function call(method, params) {
    if (!ms.backend || typeof ms.backend.call !== "function") {
      return Promise.reject(new Error("后台能力不可用（需要授权 backend.spawn）"));
    }
    return Promise.resolve(ms.backend.call(method, params || null));
  }

  // ===== 列表渲染 =====

  /** 按搜索词过滤（名称 / 发布者 / 版本 / 安装位置） */
  function visibleItems() {
    var q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(function (it) {
      return [it.name, it.publisher, it.version, it.installLocation]
        .join(" ")
        .toLowerCase()
        .indexOf(q) !== -1;
    });
  }

  function itemHtml(it) {
    var meta = [];
    if (it.version) meta.push("v" + it.version);
    if (it.publisher) meta.push(it.publisher);
    if (it.estimatedSize > 0) meta.push(formatBytes(it.estimatedSize));
    var date = formatDate(it.installDate);
    if (date) meta.push(date);

    // 图标：后端从注册表 DisplayIcon 提取的 PNG（32×32）；取不到回落 📦 占位
    var iconHtml = it.iconDataUrl
      ? '<div class="un-item-icon" aria-hidden="true"><img src="' +
        escapeHtml(it.iconDataUrl) +
        '" alt="" loading="lazy" onerror="this.remove()"></div>'
      : '<div class="un-item-icon" aria-hidden="true">📦</div>';

    var hasUninstaller = !!(it.uninstallString || it.quietUninstallString);

    return (
      '<div class="un-item" data-id="' + escapeHtml(it.id) + '">' +
        iconHtml +
        '<div class="un-item-body">' +
          '<div class="un-item-name">' + escapeHtml(it.name) + "</div>" +
          (meta.length ? '<div class="un-item-meta">' + escapeHtml(meta.join(" · ")) + "</div>" : "") +
          (it.installLocation
            ? '<div class="un-item-path" title="安装位置">' + escapeHtml(it.installLocation) + "</div>"
            : "") +
        "</div>" +
        '<div class="un-item-actions">' +
          (hasUninstaller
            ? '<button class="un-btn un-btn-danger" data-act="uninstall" data-id="' + escapeHtml(it.id) +
              '" title="运行该软件自带的卸载程序；卸载结束后自动扫描残留">卸载</button>' +
              '<button class="un-btn" data-act="uninstallForce" data-id="' + escapeHtml(it.id) +
              '" title="先结束该软件的进程（解开文件占用），再运行卸载程序">强制卸载</button>'
            : '<button class="un-btn" disabled title="该软件没有提供卸载命令">无卸载项</button>') +
          '<button class="un-btn" data-act="open" data-id="' + escapeHtml(it.id) +
            '" title="在资源管理器中打开该软件的安装目录">打开位置</button>' +
          '<button class="un-btn" data-act="scan" data-id="' + escapeHtml(it.id) +
            '" title="扫描该软件的安装目录、快捷方式与注册表残留">扫描残留</button>' +
        "</div>" +
      "</div>");
  }

  function renderList() {
    var list = dom["un-list"];
    var empty = dom["un-empty"];
    if (!list) return;

    var shown = visibleItems();
    if (dom["un-stats"]) {
      dom["un-stats"].textContent = query.trim()
        ? "匹配 " + shown.length + " / " + items.length + " 个软件"
        : "共 " + items.length + " 个软件";
    }

    if (!shown.length) {
      list.innerHTML = "";
      if (empty) {
        empty.hidden = false;
        if (dom["un-empty-text"]) {
          dom["un-empty-text"].textContent = query.trim()
            ? "没有匹配「" + query.trim() + "」的软件。"
            : "没有找到已安装软件。";
        }
      }
      return;
    }
    if (empty) empty.hidden = true;
    list.innerHTML = shown.map(itemHtml).join("");
  }

  // ===== 残留面板 =====

  var KIND_LABEL = { dir: "目录", file: "文件", registry: "注册表" };

  function residueItemHtml(r) {
    return (
      '<label class="un-residue-item">' +
        '<input type="checkbox" data-res-id="' + escapeHtml(r.id) + '" checked>' +
        '<div class="un-residue-body">' +
          '<div class="un-residue-label">' +
            '<span class="un-residue-kind-' + escapeHtml(r.kind) + '">[' + (KIND_LABEL[r.kind] || r.kind) + ']</span> ' +
            escapeHtml(r.label || "") +
          "</div>" +
          '<div class="un-residue-path">' + escapeHtml(r.path) + "</div>" +
        "</div>" +
        (r.kind !== "registry" && r.size > 0
          ? '<span class="un-residue-size">' + formatBytes(r.size) + (r.fileCount ? " · " + r.fileCount + " 个文件" : "") + "</span>"
          : "") +
      "</label>");
  }

  function renderResidue() {
    var box = dom["un-residue"];
    if (!box) return;
    if (!residue || !residue.items.length) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    if (dom["un-residue-title"]) {
      dom["un-residue-title"].textContent = "「" + residue.name + "」的残留（" + residue.items.length + " 项）";
    }
    if (dom["un-residue-list"]) {
      dom["un-residue-list"].innerHTML = residue.items.map(residueItemHtml).join("");
    }
    syncResidueMeta();
    box.hidden = false;
    if (typeof box.scrollIntoView === "function") {
      box.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  /** 统计勾选数与总大小，控制「清理选中」的可用态 */
  function syncResidueMeta() {
    if (!residue) return;
    var checked = 0;
    var bytes = 0;
    var boxes = (dom["un-residue-list"] || { querySelectorAll: function () { return []; } })
      .querySelectorAll("input[data-res-id]");
    for (var i = 0; i < boxes.length; i++) {
      if (!boxes[i].checked) continue;
      checked++;
      var r = findResidue(boxes[i].getAttribute("data-res-id"));
      if (r && r.size > 0) bytes += r.size;
    }
    if (dom["un-residue-meta"]) {
      dom["un-residue-meta"].textContent = "已选 " + checked + " / " + residue.items.length +
        (bytes > 0 ? " · 约 " + formatBytes(bytes) : "");
    }
    if (dom["un-clean"]) dom["un-clean"].disabled = checked === 0;
    if (dom["un-check-all"]) {
      dom["un-check-all"].checked = checked === residue.items.length && residue.items.length > 0;
    }
  }

  function findResidue(id) {
    if (!residue) return null;
    for (var i = 0; i < residue.items.length; i++) {
      if (residue.items[i].id === id) return residue.items[i];
    }
    return null;
  }

  function findSoftware(id) {
    for (var i = 0; i < items.length; i++) {
      if (items[i].id === id) return items[i];
    }
    return null;
  }

  // ===== 操作 =====

  /** 读取已安装软件列表 */
  function loadList(showStatus) {
    if (busy) return;
    busy = true;
    if (showStatus) setStatus("正在读取已安装软件…");
    call("list")
      .then(function (r) {
        if (!alive()) return;
        items = Array.isArray(r && r.items) ? r.items : [];
        // 快照：卸载进程退出通知到达时按 id 找回「刚卸载的是谁」（通知里只有 id）
        installedSnapshot = {};
        for (var i = 0; i < items.length; i++) installedSnapshot[items[i].id] = items[i];
        renderList();
        setStatus("");
      })
      .catch(function (e) {
        if (!alive()) return;
        items = [];
        renderList();
        setStatus("读取已安装软件失败：" + errorText(e), true);
      })
      .then(function () {
        busy = false;
      });
  }

  /**
   * 启动卸载程序（force = 强制卸载）。
   *
   * 只传 id；命令由后端按注册表条目启动。「卸载结束后自动扫描残留」不在
   * 这里定时猜——后端在卸载进程**退出**时发 `uninstall-finished` 通知，
   * 前端监听到后调 scan()（与手动扫描同一条路径，含确认弹窗）。
   * 保留 8 秒后的延迟刷新兜底（通知机制万一没触发，列表也能反映卸载结果）。
   */
  function uninstall(it, force) {
    var ask = force
      ? "强制卸载「" + it.name + "」？\n\n将先结束该软件的进程（未保存的数据会丢失），然后运行它自带的卸载程序；卸载结束后自动扫描残留。"
      : "启动「" + it.name + "」的卸载程序？\n\n卸载向导完成后将自动扫描残留（也可以随时手动点「扫描残留」）。";
    Promise.resolve(ms.ui && ms.ui.confirm ? ms.ui.confirm(ask) : true)
      .then(function (ok) {
        if (ok === false) return null;
        setStatus((force ? "正在强制卸载「" : "正在启动「") + it.name + "」…");
        return call(force ? "uninstallForce" : "uninstall", { id: it.id });
      })
      .then(function (r) {
        if (r === null) return;
        if (!alive()) return;
        setStatus((force ? "已强制启动「" : "已启动「") + it.name + "」的卸载程序；卸载结束后自动扫描残留。");
        toast(force ? "强制卸载已启动" : "卸载程序已启动", "ok");
        // 卸载向导可能已经跑完（很快的卸载器）：延迟几秒刷新一次列表，
        // 让「已卸载」的状态能反映出来。
        setTimeout(function () {
          if (alive() && !busy) loadList(false);
        }, 8000);
      })
      .catch(function (e) {
        if (!alive()) return;
        setStatus((force ? "强制卸载启动失败：" : "启动卸载程序失败：") + errorText(e), true);
      });
  }

  /** 打开软件安装目录（资源管理器；目录由后端按注册表条目解析） */
  function openLocation(it) {
    call("openLocation", { id: it.id })
      .then(function (r) {
        if (!alive()) return;
        setStatus("已在资源管理器打开「" + ((r && r.name) || it.name) + "」的安装目录。");
      })
      .catch(function (e) {
        if (!alive()) return;
        setStatus("打开安装目录失败：" + errorText(e), true);
      });
  }

  /** 扫描某软件的残留 */
  function scan(it) {
    if (busy) return;
    busy = true;
    setStatus("正在扫描「" + it.name + "」的残留…");
    // 只把扫描需要的字段发给后端（后端还有一层白名单过滤）
    call("scan", {
      item: {
        id: it.id,
        name: it.name,
        publisher: it.publisher,
        installLocation: it.installLocation,
        hive: it.hive,
        view: it.view,
        keyPath: it.keyPath,
      },
    })
      .then(function (r) {
        if (!alive()) return;
        residue = {
          scanId: r && r.scanId,
          name: (r && r.name) || it.name,
          items: Array.isArray(r && r.items) ? r.items : [],
        };
        renderResidue();
        if (!residue.items.length) {
          setStatus("「" + it.name + "」没有扫到残留，很干净。");
        } else {
          setStatus("扫到 " + residue.items.length + " 项残留，请确认后清理。");
        }
      })
      .catch(function (e) {
        if (!alive()) return;
        setStatus("扫描残留失败：" + errorText(e), true);
      })
      .then(function () {
        busy = false;
      });
  }

  /** 清理勾选的残留（先经宿主确认弹窗，路径校验在后端兜底） */
  function clean() {
    if (!residue || busy) return;
    var boxes = (dom["un-residue-list"] || { querySelectorAll: function () { return []; } })
      .querySelectorAll("input[data-res-id]");
    var ids = [];
    var previews = [];
    for (var i = 0; i < boxes.length; i++) {
      if (!boxes[i].checked) continue;
      ids.push(boxes[i].getAttribute("data-res-id"));
      var r = findResidue(boxes[i].getAttribute("data-res-id"));
      if (r) previews.push("[" + (KIND_LABEL[r.kind] || r.kind) + "] " + r.path);
    }
    if (!ids.length) return;

    var ask = "清理选中的 " + ids.length + " 项残留？\n\n" +
      previews.slice(0, 6).join("\n") +
      (previews.length > 6 ? "\n… 等共 " + previews.length + " 项" : "") +
      "\n\n此操作不可撤销。";
    Promise.resolve(ms.ui && ms.ui.confirm ? ms.ui.confirm(ask) : true)
      .then(function (ok) {
        if (ok === false) return null;
        if (dom["un-clean"]) dom["un-clean"].disabled = true;
        setStatus("正在清理…");
        return call("clean", { scanId: residue.scanId, ids: ids });
      })
      .then(function (r) {
        if (r === null) return;
        if (!alive()) return;
        var results = Array.isArray(r && r.results) ? r.results : [];
        var okCount = results.filter(function (x) { return x.ok; }).length;
        var failCount = results.length - okCount;

        // 从面板移除清理成功的项
        var okIds = {};
        results.forEach(function (x) { if (x.ok) okIds[x.id] = true; });
        residue.items = residue.items.filter(function (x) { return !okIds[x.id]; });

        if (failCount > 0) {
          var firstErr = results.filter(function (x) { return !x.ok; })[0];
          setStatus("已清理 " + okCount + " 项，" + failCount + " 项失败（" +
            (firstErr && firstErr.error ? firstErr.error : "未知原因") +
            "）。可稍后重试或手动删除。", true);
        } else {
          setStatus("已清理 " + okCount + " 项残留。");
          toast("残留已清理", "ok");
        }
        renderResidue();
        if (!residue.items.length) {
          setStatus("残留已全部清理。");
        }
      })
      .catch(function (e) {
        if (!alive()) return;
        setStatus("清理失败：" + errorText(e), true);
      })
      .then(function () {
        if (dom["un-clean"]) dom["un-clean"].disabled = false;
        syncResidueMeta();
        busy = false;
      });
  }

  // ===== 事件绑定 =====

  function bindEvents() {
    // 刷新
    if (dom["un-refresh"]) {
      dom["un-refresh"].addEventListener("click", function () {
        loadList(true);
      });
    }

    // 搜索：输入即过滤（纯本地，不打后端）
    if (dom["un-search"]) {
      dom["un-search"].addEventListener("input", function (e) {
        query = String(e.target.value || "");
        renderList();
      });
    }

    // 列表：卸载 / 强制卸载 / 打开位置 / 扫描（列表是 innerHTML 重建的，只能委托）
    if (dom["un-list"]) {
      dom["un-list"].addEventListener("click", function (e) {
        var btn = e.target.closest ? e.target.closest("[data-act]") : null;
        if (!btn) return;
        var id = btn.getAttribute("data-id");
        var it = findSoftware(id);
        if (!it) return;
        var act = btn.getAttribute("data-act");
        if (act === "uninstall") uninstall(it, false);
        else if (act === "uninstallForce") uninstall(it, true);
        else if (act === "open") openLocation(it);
        else if (act === "scan") scan(it);
      });
    }

    // 残留面板：全选 / 勾选变化 / 清理 / 关闭
    if (dom["un-check-all"]) {
      dom["un-check-all"].addEventListener("change", function (e) {
        var on = e.target.checked;
        var boxes = (dom["un-residue-list"] || { querySelectorAll: function () { return []; } })
          .querySelectorAll("input[data-res-id]");
        for (var i = 0; i < boxes.length; i++) boxes[i].checked = on;
        syncResidueMeta();
      });
    }
    if (dom["un-residue-list"]) {
      dom["un-residue-list"].addEventListener("change", function (e) {
        if (e.target && e.target.getAttribute && e.target.getAttribute("data-res-id")) {
          syncResidueMeta();
        }
      });
    }
    if (dom["un-clean"]) {
      dom["un-clean"].addEventListener("click", clean);
    }
    if (dom["un-residue-close"]) {
      dom["un-residue-close"].addEventListener("click", function () {
        residue = null;
        renderResidue();
      });
    }
  }

  // ===== 启动 =====

  function boot() {
    bindEvents();

    // 先探平台：后端 init 报「不支持」时禁用操作并给出可读说明，界面不崩。
    call("init")
      .then(function (r) {
        supported = !!(r && r.supported);
        if (dom["un-platform"]) {
          dom["un-platform"].textContent = r && r.platform ? "平台：" + r.platform : "";
        }
        if (!supported) {
          if (dom["un-stats"]) {
            dom["un-stats"].textContent = "当前操作系统不支持：软件卸载器依赖 Windows 注册表与 PowerShell。";
          }
          setStatus("仅支持 Windows", true);
          return;
        }
        loadList(true);
      })
      .catch(function (e) {
        // 后台进程拉不起来（未授权 / Node 缺失）：给出可操作的提示
        if (dom["un-stats"]) {
          dom["un-stats"].textContent = "后台服务不可用。";
        }
        setStatus("后台服务不可用：" + errorText(e) + "（可在「设置 → 插件」中检查本插件的后台状态）", true);
      });

    // 「卸载 : 关键字」→ 搜索框过滤。挂载时宿主会立刻推一次当前子关键词，
    // 因此只在子词非空时才写入搜索框，避免空子词清掉用户已输入的内容。
    if (typeof onSubKeyword === "function") {
      onSubKeyword(function (sub) {
        if (!alive()) return;
        var s = String(sub == null ? "" : sub).trim();
        if (!s) return;
        query = s;
        if (dom["un-search"]) dom["un-search"].value = s;
        renderList();
      });
    }

    // 卸载进程退出通知（后端 uninstall/uninstallForce 里 child exit 时发出）：
    // 「卸载/强制卸载完成后自动扫描残留」的触发点。用**启动卸载前**记录的
    // 快照（installedSnapshot）找回软件条目——列表此时可能已被 8 秒兜底刷新
    // 更新过（该软件可能已从注册表消失）。与手动「扫描残留」走同一条 scan()
    // 路径（含确认弹窗与勾选清理），只是触发方式不同。
    if (ms && ms.backend && typeof ms.backend.onNotification === "function") {
      ms.backend.onNotification("uninstall-finished", function (params) {
        if (!alive()) return;
        var sid = params && params.softwareId;
        var it = (sid && installedSnapshot[sid]) || null;
        // 快照里没有（比如刷新过且软件已卸干净）：退化为按名字找当前列表
        if (!it && params && params.name) {
          var nm = String(params.name).toLowerCase();
          for (var i = 0; i < items.length; i++) {
            if (String(items[i].name || "").toLowerCase() === nm) { it = items[i]; break; }
          }
        }
        if (!it) {
          setStatus("卸载已结束；列表里已找不到该软件的注册表条目（可能已卸载干净）。可点「刷新」后再检查残留。");
          return;
        }
        setStatus("「" + it.name + "」的卸载已结束，自动扫描残留…");
        scan(it);
      });
    }

    ms.log("info", "软件卸载器已加载 id=" + plugin.id + " v=" + plugin.version);
  }

  boot();
})(ms, env, plugin, host, keyword, inputValue, onSubKeyword, md2html, openExternal);