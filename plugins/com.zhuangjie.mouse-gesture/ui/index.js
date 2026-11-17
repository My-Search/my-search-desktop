/**
 * 鼠标手势 —— 前端入口脚本
 *
 * 宿主注入参数: ms, env, plugin, host, keyword, inputValue, onSubKeyword, md2html, openExternal
 * 本面板用的 API：ms.gesture.{getEnabled,setEnabled,listBindings,syncBindings}
 * （宿主 host.ts 提供；syncBindings 需 gesture.exec 权限——装插件时用户已确认）
 *
 * 职责：
 *  1. 读取/展示手势映射（ms.gesture.listBindings，权威在 Rust；本面板是编辑器）；
 *  2. 编辑映射（方向串 + 动作类型 + 目标），保存下发 ms.gesture.syncBindings
 *     （Rust 全量覆盖 + 快照落盘 + 钩子即刻生效）；
 *  3. 总开关 ms.gesture.getEnabled / setEnabled。
 *
 * 存储策略：映射的真源在 Rust（BINDINGS + 快照文件）；面板只在保存时下发，
 * 不在 ms.store 里存一份（避免两份漂移——这是宿主快捷键同款决策）。
 *
 * 动作 schema（与 Rust GestureAction 对齐，serde tag = "type"）：
 *   { type: "sleep", seconds?: number }
 *   { type: "shutdown" } / { type: "reboot" } / { type: "terminal" }
 *   { type: "explorer", path?: string }
 *   { type: "kill-foreground" }
 *   { type: "open", target: string }
 *   { type: "focus-process", exePath: string, title?: string }
 */
(function (ms, env, plugin, host, keyword, inputValue, onSubKeyword, md2html, openExternal) {
  "use strict";

  var appEl = document.getElementById("app");
  if (!appEl) return;

  // ===== DOM =====
  var dom = {};
  ["mg-enabled", "mg-list", "mg-add", "mg-record", "mg-refresh-processes", "mg-import", "mg-save", "mg-dirty-hint"].forEach(function (id) {
    dom[id] = document.getElementById(id);
  });

  function alive() {
    return document.body && document.body.contains(appEl);
  }

  /** 经宿主 API 调 Rust（ms.gesture 由宿主注入；权限/审计走宿主 call 管线） */
  function g() {
    if (ms && ms.gesture) return ms.gesture;
    throw new Error("宿主未提供手势 API（当前版本不支持）");
  }


  // ===== 动作类型定义（与 Rust 对齐） =====
  var ACTION_TYPES = [
    { type: "sleep", label: "休眠" },
    { type: "shutdown", label: "关机" },
    { type: "reboot", label: "重启" },
    { type: "terminal", label: "打开命令行窗口" },
    { type: "explorer", label: "打开资源管理器" },
    { type: "kill-foreground", label: "强制关闭前台程序" },
    { type: "open", label: "打开程序 / 文件夹 / 文件 / 网址" },
    { type: "focus-process", label: "呼出程序（已运行则置前，否则启动）" },
  ];

  // ===== 状态（编辑副本；保存时下发） =====
  var state = {
    bindings: [], // [{ pattern, action, label }]
    dirty: false,
    /** 正在为哪一行录制手势（null = 未在录制） */
    recordingIdx: null,
    /** 当前运行中的窗口进程（「呼出程序」下拉数据源，面板加载时拉取） */
    processes: [],
  };

  /** 录制结果监听（宿主广播 my-search://gesture-record；面板挂载期间有效） */
  var unlistenRecord = null;

  /** 开始为一行录制：Rust 置录制模式（手势只识别不执行），结果走 ms.gesture.onRecord */
  function startRecord(idx) {
    if (!ms.gesture || typeof ms.gesture.recordStart !== "function") {
      showToast("当前宿主版本不支持画手势录制", true);
      return;
    }
    state.recordingIdx = idx;
    render();
    updateRecordUi();
    ms.gesture.recordStart().then(function () {
      showToast(idx < state.bindings.length
        ? "按住 Ctrl + 右键画手势，松手覆盖本行方向（Esc 或再点一次取消）"
        : "按住 Ctrl + 右键在屏幕上画出新手势（Esc 或再点一次取消）");
    }).catch(function (e) {
      state.recordingIdx = null;
      updateRecordUi();
      render();
      showToast("启动录制失败: " + ((e && e.message) || e), true);
    });
  }

  function cancelRecord() {
    if (state.recordingIdx === null) return;
    state.recordingIdx = null;
    updateRecordUi();
    render();
    try { ms.gesture.recordCancel(); } catch (e) { /* 忽略 */ }
    showToast("已取消录制");
  }

  /** 录制按钮态与面板标题提示 */
  function updateRecordUi() {
    var recording = state.recordingIdx !== null;
    if (dom["mg-record"]) {
      dom["mg-record"].textContent = recording ? "取消录制 (Esc)" : "◎ 画手势录制（新增）";
      dom["mg-record"].classList.toggle("active", recording);
    }
    document.title = recording ? "鼠标手势 — 正在录制手势" : "鼠标手势";
  }

  function applyRecordedPattern(pattern) {
    var idx = state.recordingIdx;
    state.recordingIdx = null;
    updateRecordUi();
    if (idx == null) return;
    if (!pattern) {
      showToast("未识别到手势（拖拽太短），再试一次", true);
      render();
      return;
    }
    if (state.bindings[idx]) {
      state.bindings[idx].pattern = pattern;
    } else {
      // 录制「新映射」：结果落成一条新行（默认动作「打开…」，可在面板里改）
      state.bindings[idx] = { pattern: pattern, action: { type: "open", target: "" }, label: null };
    }
    markDirty();
    render();
    showToast("已录制手势：" + pattern + "（记得保存映射）");
  }

  /** 订阅宿主录制广播（面板挂载期间有效；会话销毁随 DOM 脱离自然停用） */
  function bindRecordListener() {
    if (ms.gesture && typeof ms.gesture.onRecord === "function") {
      unlistenRecord = ms.gesture.onRecord(function (pattern) {
        if (!alive()) return;
        applyRecordedPattern(String(pattern || ""));
      });
    }
  }
  /** 导入推荐映射（面板侧定义，与 Rust default_bindings 同一套；追加不覆盖） */
  function importDefaults() {
    var defaults = [
      { pattern: "D",  action: { type: "terminal" }, label: "命令行窗口" },
      { pattern: "R",  action: { type: "explorer", path: null }, label: "资源管理器" },
      { pattern: "L",  action: { type: "kill-foreground" }, label: "强制关闭前台程序" },
      { pattern: "DU", action: { type: "reboot" }, label: "重启" },
      { pattern: "UD", action: { type: "shutdown" }, label: "关机" },
    ];
    var added = 0;
    defaults.forEach(function (d) {
      var dup = state.bindings.some(function (b) { return b.pattern === d.pattern; });
      if (!dup) { state.bindings.push(d); added++; }
    });
    if (added > 0) {
      markDirty();
      render();
      showToast("已导入 " + added + " 条推荐映射（未保存，确认后点「保存映射」）");
    } else {
      showToast("推荐映射均已存在，无需导入");
    }
  }

  function markDirty() {
    if (!state.dirty) {
      state.dirty = true;
      dom["mg-save"].disabled = false;
      dom["mg-dirty-hint"].hidden = false;
    }
  }

  function clearDirty() {
    state.dirty = false;
    dom["mg-save"].disabled = true;
    dom["mg-dirty-hint"].hidden = true;
  }

  // ===== 渲染（全量重建；事件委托在 #app） =====
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function render() {
    var html = "";
    state.bindings.forEach(function (b, idx) {
      var isOpen = b.action.type === "open";
      var isPath = b.action.type === "explorer";
      var isFocus = b.action.type === "focus-process";
      var options = ACTION_TYPES.map(function (t) {
        return '<option value="' + t.type + '"' +
          (t.type === b.action.type ? " selected" : "") + ">" + t.label + "</option>";
      }).join("");
      var recording = state.recordingIdx === idx;
      html +=
        '<div class="mg-row' + (isOpen ? " is-open" : "") + (recording ? " is-recording" : "") + '" data-idx="' + idx + '">' +
        '  <input class="mg-pattern-input" data-act="pattern" value="' + esc(b.pattern) + '"' +
        '        maxlength="8" title="方向串：U=上 D=下 L=左 R=右，按轨迹顺序拼写，如 UD">' +
        '  <div>' +
        '    <select data-act="type">' + options + "</select>" +
        (isOpen
          ? '<input class="mg-open-target" data-act="target" value="' + esc(b.action.target || "") +
            '" placeholder="D:/tools/app.exe、C:/dir 或 https://…">'
          : "") +
        (isPath
          ? '<input class="mg-open-target" data-act="path" value="' + esc(b.action.path || "") +
            '" placeholder="默认打开「此电脑」，可填目录路径">'
          : "") +
        (isFocus
          ? '<div class="mg-focus-fields">' +
            '<select class="mg-process-select" data-act="process" title="从当前运行中的程序选择，自动填入 exe 路径">' +
            '<option value="">— 选择运行中的程序 —</option>' +
            state.processes.map(function (p, pi) {
              var selected = p.exePath === b.action.exePath ? " selected" : "";
              var label = p.name + (p.title ? " — " + p.title : "");
              return '<option value="' + pi + '"' + selected + ">" + esc(label) + "</option>";
            }).join("") +
            "</select>" +
            '<input class="mg-exe-input" data-act="exePath" value="' + esc(b.action.exePath || "") +
            '" placeholder="exe 绝对路径（可手动填写，程序未运行时按此路径启动）">' +
            "</div>"
          : "") +
        "  </div>" +
        '  <div class="mg-row-ops">' +
        '    <button class="mg-record-row' + (recording ? " active" : "") + '" data-act="record" type="button"' +
        '            title="' + (recording ? "取消录制" : "重画手势覆盖本行方向串") + '">' + (recording ? "■" : "◎") + '</button>' +
        '    <button class="mg-del" data-act="del" type="button" title="删除此映射">✕</button>' +
        "  </div>" +
        "</div>";
    });
    if (!state.bindings.length) {
      html = '<p class="mg-empty" style="padding:10px 8px;color:var(--mg-muted,#7a8087);font-size:12.5px">还没有映射，点下方按钮添加。</p>';
    }
    dom["mg-list"].innerHTML = html;
  }

  // ===== 数据加载与保存 =====
  function refresh() {
    g().listBindings().then(function (list) {
      if (!alive()) return;
      state.bindings = (list || []).map(function (b) {
        return { pattern: b.pattern, action: b.action, label: b.label || null };
      });
      clearDirty();
      render();
    }).catch(function (e) {
      showToast("读取映射失败: " + ((e && e.message) || e), true);
    });
    g().getEnabled().then(function (on) {
      if (alive()) dom["mg-enabled"].checked = Boolean(on);
    }).catch(function () { /* 展示失败不影响 */ });
    loadProcesses();
  }

  /** 拉取运行中的进程（「呼出程序」下拉数据源）；失败不影响其它配置 */
  function loadProcesses() {
    if (!ms.gesture || typeof ms.gesture.listProcesses !== "function") return;
    ms.gesture.listProcesses().then(function (list) {
      if (!alive()) return;
      state.processes = Array.isArray(list) ? list : [];
      render();
    }).catch(function () { /* 进程列表展示失败不影响映射编辑 */ });
  }

  function save() {
    var payload = state.bindings.map(function (b) {
      return { pattern: b.pattern, action: b.action, label: b.label || null };
    });
    g().syncBindings(payload).then(function () {
      if (!alive()) return;
      clearDirty();
      render();
      showToast("已保存并生效");
    }).catch(function (e) {
      showToast("保存失败: " + ((e && e.message) || e), true);
    });
  }

  // ===== 提示条 =====
  var toastTimer = null;
  function showToast(text, isErr) {
    var el = appEl.querySelector(".mg-toast");
    if (!el) {
      el = document.createElement("p");
      el.className = "mg-toast";
      appEl.insertBefore(el, appEl.querySelector(".mg-footer"));
    }
    el.textContent = text;
    el.classList.toggle("err", Boolean(isErr));
    el.style.display = "block";
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.style.display = "none"; }, 2600);
  }

  // ===== 事件（委托在 #app；列表会被整体重建） =====
  appEl.addEventListener("input", function (e) {
    var row = e.target.closest ? e.target.closest(".mg-row") : null;
    if (!row) return;
    var idx = Number(row.getAttribute("data-idx"));
    var b = state.bindings[idx];
    if (!b) return;
    var act = e.target.getAttribute("data-act");
    if (act === "pattern") {
      // 只留 UDLR，自动大写
      b.pattern = e.target.value.toUpperCase().replace(/[^UDLR]/g, "");
      e.target.value = b.pattern;
    } else if (act === "target") {
      b.action = { type: "open", target: e.target.value.trim() };
    } else if (act === "path") {
      b.action = { type: "explorer", path: e.target.value.trim() || null };
    } else if (act === "exePath") {
      // 手动输入 / 修改 exe 路径；保留下拉选中的标题备注
      b.action = {
        type: "focus-process",
        exePath: e.target.value.trim(),
        title: (b.action && b.action.title) || null,
      };
    }
    markDirty();
  });

  appEl.addEventListener("change", function (e) {
    // 动作类型切换
    if (e.target.getAttribute && e.target.getAttribute("data-act") === "type") {
      var row = e.target.closest(".mg-row");
      var idx = Number(row.getAttribute("data-idx"));
      var b = state.bindings[idx];
      if (!b) return;
      var type = e.target.value;
      if (type === "open") b.action = { type: "open", target: b.action.target || "" };
      else if (type === "explorer") b.action = { type: "explorer", path: b.action.path || null };
      else if (type === "sleep") b.action = { type: "sleep", seconds: null };
      else if (type === "focus-process") b.action = { type: "focus-process", exePath: "", title: null };
      else b.action = { type: type };
      markDirty();
      render();
      return;
    }
    // 从下拉选择运行中的进程：exe 路径 + 标题一起写入（重渲染使手动框同步）
    if (e.target.getAttribute && e.target.getAttribute("data-act") === "process") {
      var prow = e.target.closest(".mg-row");
      var pidx = Number(prow.getAttribute("data-idx"));
      var pb = state.bindings[pidx];
      if (!pb) return;
      var picked = state.processes[Number(e.target.value)];
      if (picked) {
        pb.action = { type: "focus-process", exePath: picked.exePath, title: picked.title };
      }
      markDirty();
      render();
      return;
    }
    // 总开关
    if (e.target === dom["mg-enabled"]) {
      g().setEnabled(e.target.checked).then(function () {
        showToast(e.target.checked ? "手势已启用" : "手势已停用（设置即时生效）");
      }).catch(function (err2) {
        showToast("切换失败: " + ((err2 && err2.message) || err2), true);
        e.target.checked = !e.target.checked;
      });
    }
  });

  appEl.addEventListener("click", function (e) {
    // 行内「重录」：为已有映射重新画手势覆盖其方向串；再点一次取消
    var rt = e.target.closest ? e.target.closest('[data-act="record"]') : null;
    if (rt) {
      var row = rt.closest(".mg-row");
      var idx = Number(row.getAttribute("data-idx"));
      if (state.recordingIdx === idx) cancelRecord();
      else startRecord(idx);
      return;
    }
    // 删除
    var t = e.target.closest ? e.target.closest('[data-act="del"]') : null;
    if (!t) return;
    var delRow = t.closest(".mg-row");
    var delIdx = Number(delRow.getAttribute("data-idx"));
    if (state.recordingIdx === delIdx) cancelRecord();
    state.bindings.splice(delIdx, 1);
    markDirty();
    render();
  });

  dom["mg-add"].addEventListener("click", function () {
    state.bindings.push({ pattern: "", action: { type: "open", target: "" }, label: null });
    markDirty();
    render();
    var rows = dom["mg-list"].querySelectorAll(".mg-row");
    var last = rows[rows.length - 1];
    if (last) last.querySelector('[data-act="pattern"]').focus();
  });

  dom["mg-record"].addEventListener("click", function () {
    if (state.recordingIdx !== null) cancelRecord();
    else startRecord(state.bindings.length);
  });

  if (dom["mg-refresh-processes"]) {
    dom["mg-refresh-processes"].addEventListener("click", function () {
      loadProcesses();
      showToast("已刷新运行中的进程列表");
    });
  }

  dom["mg-import"].addEventListener("click", importDefaults);

  // 录制中按 Esc 取消
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && state.recordingIdx !== null) {
      e.preventDefault();
      cancelRecord();
    }
  });

  dom["mg-save"].addEventListener("click", save);

  // ===== 启动 =====
  bindRecordListener();
  refresh();
})(ms, env, plugin, host, keyword, inputValue, onSubKeyword, md2html, openExternal);
