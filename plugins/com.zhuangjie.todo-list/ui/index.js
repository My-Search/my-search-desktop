/**
 * 待办清单 —— 前端入口脚本
 *
 * 宿主注入参数: ms, env, plugin, host, keyword, inputValue, onSubKeyword, md2html, openExternal
 *
 * 设计要点：
 *
 * 1. **纯前端、无后台进程**。数据存在 `ms.store`（localStorage 命名空间
 *    `PLUGIN_DATA:<id>:<key>`，随插件卸载/清数据一并清除），因此不需要
 *    `backend.spawn` 这类极高风险权限，安装时用户不用逐条勾选确认。
 *
 * 2. **单一真源 + 全量重渲染**。所有状态收敛在 `state.todos`；
 *    任何写操作都走 `commit()`（改状态 → 落盘 → 重绘），渲染是纯函数。
 *    列表整段 innerHTML 重建，所以事件**全部委托**在 #app 上。
 *
 * 3. **minimize 生命周期**。清单里声明了 `closeBehavior: "minimize"`，
 *    关闭视图只是把 DOM 停放到宿主停车区，脚本上下文**保活**（不会重跑）。
 *    所以：写入必须即时落盘（不能等卸载时保存）；重开时也不能指望重新
 *    从 ms.store 读一遍来做初始化 —— 每次变更后都从 store 取真值做基准。
 *
 * 4. **权限降级**。`ui.notify` 是 optionalPermissions：未授予时 `ms.ui.toast`
 *    会抛 PluginPermissionError，本插件捕获后静默（DOM 内已有可见反馈）。
 *    数据备份/迁移交给软件自身的「备份与同步」面板，插件不重复造导出入口。
 *
 * 输入语法（新增/编辑框通用）：
 *   写周报 #工作 #季度 !高 2026-09-30 ~今天 ~明天
 *   - `#标签`   任意多个
 *   - `!紧急|普通|低` / `!h|m|l`  紧急等级，取最后一个
 *   - 行尾日期 2026-09-30 / 2026/9/30 / 09-30 / 今天 / 明天 / 后天
 */
(function (ms, env, plugin, host, keyword, inputValue, onSubKeyword, md2html, openExternal) {
  "use strict";

  // 本实例的根节点：会话被卸载后本实例脱离文档，靠它判活（不打扰新实例）
  var appEl = document.getElementById("app");
  if (!appEl) return; // 理论上不会发生（detail.html 必有 #app）

  // ===== DOM =====
  var dom = {};
  ["todo-input", "todo-add", "todo-hint", "todo-stats", "todo-tabs", "todo-clear-done",
   "todo-sort", "todo-sort-dir", "todo-level", "todo-status", "todo-list", "todo-empty",
   "todo-empty-text"
  ].forEach(function (id) {
    dom[id] = document.getElementById(id);
  });

  function alive() {
    return document.body && document.body.contains(appEl);
  }

  // ===== 常量 =====
  var STORE_KEY = "todos";
  /** 排序偏好单独一个键：改排序不该重写整个待办列表（也避免写失败丢数据） */
  var PREFS_KEY = "prefs";
  /** 存储格式版本：将来结构变了按版本迁移，别直接读坏老数据 */
  var SCHEMA_VERSION = 1;
  /**
   * 紧急等级：三档。内部值沿用 high/mid/low（已落库的数据不用迁移），
   * 对外文案是「紧急 / 普通 / 低」。
   */
  var URGENCIES = {
    high: { label: "紧急", weight: 2, cls: "todo-chip-prio-high", parse: /^(紧急|高|h|high|重要|urgent)$/i },
    mid: { label: "普通", weight: 1, cls: "todo-chip-prio-mid", parse: /^(普通|中|m|mid|medium|normal)$/i },
    low: { label: "低", weight: 0, cls: "todo-chip-prio-low", parse: /^(低|l|low)$/i }
  };
  /** 排序权重：数字越小越靠前（紧急在前），未设置排最后 */
  var URGENCY_ORDER = { high: 0, mid: 1, low: 2 };
  /** 新增待办的默认紧急等级（选择器初值，也是文本未指定时的兜底） */
  var DEFAULT_LEVEL = "mid";
  /** 排序模式：创建时间 / 紧急等级 */
  var SORT_MODES = ["created", "urgency"];
  var SORT_MODE_LABEL = { created: "创建时间", urgency: "紧急等级" };
  var FILTERS = ["all", "active", "today", "done"];
  /** 单条待办标题上限（防手滑粘贴整篇文档把渲染卡住） */
  var MAX_TEXT = 500;
  var MAX_TODOS = 5000;

  // ===== 状态 =====
  var state = {
    todos: [],
    filter: "all",
    /** 排序模式：默认按创建时间 */
    sortMode: "created",
    /** 排序方向：false = 降序（新→旧 / 紧急→低），默认降序 */
    sortAsc: false,
    /** 正在行内编辑的待办 id（null = 无） */
    editingId: null
  };
  /** 最近一次异常/过程消息（null = 无，整行隐藏） */
  var statusMsg = null;
  /** 「清除已完成」需要二次点击确认（避免误点丢数据） */
  var clearArmed = false;
  var clearTimer = null;

  // ===== 工具 =====

  function escapeHtml(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  /** 本地日期 YYYY-MM-DD（不用 toISOString：那是 UTC，会差一天） */
  function toISODate(d) {
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return d.getFullYear() + "-" + (m < 10 ? "0" : "") + m + "-" + (day < 10 ? "0" : "") + day;
  }

  function todayISO() {
    return toISODate(new Date());
  }

  function isValidISODate(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var parts = s.split("-");
    var y = +parts[0], m = +parts[1], d = +parts[2];
    if (m < 1 || m > 12 || d < 1 || d > 31) return false;
    var probe = new Date(y, m - 1, d);
    return probe.getFullYear() === y && probe.getMonth() === m - 1 && probe.getDate() === d;
  }

  function uid() {
    return "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function setStatus(msg, isError) {
    statusMsg = msg ? { text: msg, error: !!isError } : null;
    renderStatus();
  }

  function renderStatus() {
    if (!dom["todo-status"]) return;
    if (!statusMsg) {
      dom["todo-status"].hidden = true;
      dom["todo-status"].textContent = "";
      dom["todo-status"].className = "todo-status";
      return;
    }
    dom["todo-status"].hidden = false;
    dom["todo-status"].textContent = statusMsg.text;
    dom["todo-status"].className = "todo-status" + (statusMsg.error ? " todo-status-error" : "");
  }

  /** 只把 ms.ui.toast 当锦上添花：没授权就静默（DOM 里已有可见反馈） */
  function toast(text, type) {
    try {
      ms.ui.toast(text, type || "info");
    } catch (e) {
      /* ui.notify 未授予：忽略 */
    }
  }

  // ===== 输入解析 =====

  /**
   * 解析输入框内容，拆出标题 / 标签 / 紧急等级 / 截止日期。
   * 返回 { ok, text, tags, priority, due, error }
   */
  function parseTodoInput(raw) {
    var out = { ok: false, text: "", tags: [], priority: null, due: null, error: null };
    var s = String(raw == null ? "" : raw).replace(/\s+/g, " ").trim();
    if (!s) {
      out.error = "内容不能为空";
      return out;
    }

    // 1) 日期：优先「行尾 ISO/月日」，其次行尾中文相对日
    var m = s.match(/[ \t](\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
    if (m) {
      var iso = m[1] + "-" + ("0" + m[2]).slice(-2) + "-" + ("0" + m[3]).slice(-2);
      if (!isValidISODate(iso)) {
        out.error = "日期不合法：" + m[0].trim();
        return out;
      }
      out.due = iso;
      s = s.slice(0, m.index).trim();
    } else {
      m = s.match(/[ \t](\d{1,2})[-/](\d{1,2})$/);
      if (m) {
        var mm = +m[1], dd = +m[2];
        if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
          var now = new Date();
          var iso2 = now.getFullYear() + "-" + ("0" + mm).slice(-2) + "-" + ("0" + dd).slice(-2);
          if (isValidISODate(iso2)) {
            // 已过期的月日视为明年（「12-31」在 1 月输入时更可能是当年年底，此处按就近未来取）
            if (iso2 < todayISO()) iso2 = (now.getFullYear() + 1) + "-" + ("0" + mm).slice(-2) + "-" + ("0" + dd).slice(-2);
            out.due = iso2;
            s = s.slice(0, m.index).trim();
          }
        } else {
          out.error = "日期不合法：" + m[0].trim();
          return out;
        }
      } else {
        m = s.match(/[ \t](今天|今日|明天|明日|后天)$/);
        if (m) {
          var d = new Date();
          if (m[1] === "明天" || m[1] === "明日") d.setDate(d.getDate() + 1);
          else if (m[1] === "后天") d.setDate(d.getDate() + 2);
          out.due = toISODate(d);
          s = s.slice(0, m.index).trim();
        }
      }
    }

    // 2) 紧急等级：全串扫描取最后一个（允许出现在任意位置）
    var prioRe = /!([^\s!]+)/g;
    var hit;
    while ((hit = prioRe.exec(s)) !== null) {
      var word = hit[1];
      for (var key in URGENCIES) {
        if (URGENCIES[key].parse.test(word)) {
          out.priority = key;
          break;
        }
      }
    }
    s = s.replace(prioRe, " ").replace(/\s+/g, " ").trim();

    // 3) 标签：#tag（去重、保序、单标签 ≤24 字）
    var tagRe = /#([^\s#]+)/g;
    var seen = {};
    while ((hit = tagRe.exec(s)) !== null) {
      var tag = hit[1].slice(0, 24);
      if (tag && !seen[tag]) {
        seen[tag] = 1;
        out.tags.push(tag);
      }
    }
    s = s.replace(tagRe, " ").replace(/\s+/g, " ").trim();

    if (!s) {
      out.error = "标题不能为空";
      return out;
    }
    out.text = s.slice(0, MAX_TEXT);
    out.ok = true;
    return out;
  }

  // ===== 持久化 =====

  function normalizeTodo(raw) {
    if (!raw || typeof raw !== "object") return null;
    var text = String(raw.text == null ? "" : raw.text).trim();
    if (!text) return null;
    var priority = raw.priority === "high" || raw.priority === "mid" || raw.priority === "low" ? raw.priority : null;
    var due = typeof raw.due === "string" && isValidISODate(raw.due) ? raw.due : null;
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : uid(),
      text: text.slice(0, MAX_TEXT),
      done: !!raw.done,
      priority: priority,
      tags: Array.isArray(raw.tags)
        ? raw.tags.map(function (t) { return String(t).slice(0, 24); }).filter(Boolean).slice(0, 10)
        : [],
      due: due,
      createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
      updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now(),
      completedAt: typeof raw.completedAt === "number" ? raw.completedAt : null
    };
  }

  /** 从本地存储读取（容错：字段缺失/类型不对一律规范化；老格式按版本迁移） */
  function loadTodos() {
    var raw;
    try {
      raw = ms.store.get(STORE_KEY, null);
    } catch (e) {
      setStatus("读取本地数据失败：" + (e && e.message ? e.message : e), true);
      return [];
    }
    if (!raw) return [];
    var list = null;
    if (Array.isArray(raw)) {
      // 早期版本直接存数组，无 version 包装
      list = raw;
    } else if (raw && typeof raw === "object") {
      if (raw.version > SCHEMA_VERSION) {
        setStatus("数据由更新版本的插件写入（v" + raw.version + "），请升级插件后再打开", true);
        return [];
      }
      if (Array.isArray(raw.todos)) list = raw.todos;
    }
    if (!list) return [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var t = normalizeTodo(list[i]);
      if (t) out.push(t);
    }
    return out.slice(0, MAX_TODOS);
  }

  /** 落盘。注意 closeBehavior=minimize 时脚本不会重跑，写入必须即时完成。 */
  function persist() {
    try {
      ms.store.set(STORE_KEY, { version: SCHEMA_VERSION, todos: state.todos });
      return true;
    } catch (e) {
      setStatus("保存失败（本地存储可能已满）：" + (e && e.message ? e.message : e), true);
      return false;
    }
  }

  /** 读取排序偏好（容错：非法值一律回落到默认「创建时间降序」） */
  function loadPrefs() {
    var raw;
    try {
      raw = ms.store.get(PREFS_KEY, null);
    } catch (e) {
      return;
    }
    if (!raw || typeof raw !== "object") return;
    if (SORT_MODES.indexOf(raw.sortMode) !== -1) state.sortMode = raw.sortMode;
    if (typeof raw.sortAsc === "boolean") state.sortAsc = raw.sortAsc;
  }

  /** 排序偏好是轻量设置，单独键存放，不跟待办数据混在一起 */
  function persistPrefs() {
    try {
      ms.store.set(PREFS_KEY, { sortMode: state.sortMode, sortAsc: state.sortAsc });
    } catch (e) {
      /* 偏好写不进去不影响使用，忽略 */
    }
  }

  /** 唯一的写入口：改状态 → 落盘 → 重绘 */
  function commit() {
    persist();
    render();
  }

  // ===== 排序 / 筛选 =====

  /** 紧急等级权重（未设置排最后，数字越小越靠前） */
  function urgencyRank(t) {
    var r = URGENCY_ORDER[t.priority];
    return r === undefined ? 3 : r;
  }

  /**
   * 排序比较器。
   *
   * 两条不随方向翻转的硬约束（翻转了就变成反语义）：
   *
   *  1. **未完成恒在已完成之前** —— 否则已完成会混进未完成中间；
   *  2. **紧急等级恒为「紧急在前」** —— 紧急等级本身有强度语义，
   *     「降序」在它这里指「紧急的在上」而不是「未设置的在上」。
   *     方向只作用于同一紧急档内的兜底排序（截止日期 / 创建时间）。
   *
   * 只有「创建时间」模式是真正对称的：升序 = 旧→新，降序 = 新→旧。
   */
  function compareTodos(a, b) {
    if (a.done !== b.done) return a.done ? 1 : -1;

    var asc = state.sortAsc;
    if (state.sortMode === "urgency") {
      // 先按紧急等级（恒紧急在前）
      var ur = urgencyRank(a) - urgencyRank(b);
      if (ur !== 0) return ur;
      // 同档内：方向决定按「截止日期」正序还是倒序。
      // 注意：**没有截止日期的恒排最后**，不能塞一个 "9999-99-99" 哨兵值了事 ——
      // 降序时那个哨兵会被翻转成「最早」，把无截止的项顶到最前面。
      var hasA = !!a.due, hasB = !!b.due;
      if (hasA !== hasB) return hasA ? -1 : 1;
      if (hasA && hasB) {
        var dcmp = a.due === b.due ? 0 : (a.due < b.due ? -1 : 1);
        if (dcmp !== 0) return asc ? dcmp : -dcmp;
      }
      return asc ? a.createdAt - b.createdAt : b.createdAt - a.createdAt;
    }

    // 创建时间模式：整体按方向翻转
    var cmp = a.createdAt - b.createdAt;
    return asc ? cmp : -cmp;
  }

  /** 切换排序模式：默认方向为「降序」（新的/紧急的在上） */
  function setSortMode(mode) {
    if (SORT_MODES.indexOf(mode) === -1) return;
    state.sortMode = mode;
  }

  function toggleSortAsc() {
    state.sortAsc = !state.sortAsc;
  }

  function matchFilter(t, filter) {
    if (filter === "active") return !t.done;
    if (filter === "done") return t.done;
    if (filter === "today") {
      if (t.done) return false;
      return !!t.due && t.due <= todayISO();
    }
    return true;
  }

  function counts() {
    var c = { all: state.todos.length, active: 0, today: 0, done: 0 };
    var today = todayISO();
    for (var i = 0; i < state.todos.length; i++) {
      var t = state.todos[i];
      if (t.done) c.done++;
      else {
        c.active++;
        if (t.due && t.due <= today) c.today++;
      }
    }
    return c;
  }

  // ===== 渲染（纯函数：只读 state，产出 HTML 字符串） =====

  function chipHtml(cls, text) {
    return '<span class="todo-chip ' + cls + '">' + escapeHtml(text) + "</span>";
  }

  /** 截止日期展示：今天/明天/昨天更直观；已逾期标红 */
  function dueLabel(due) {
    var today = todayISO();
    if (due === today) return "今天";
    var t = new Date();
    t.setDate(t.getDate() + 1);
    if (due === toISODate(t)) return "明天";
    t = new Date();
    t.setDate(t.getDate() - 1);
    if (due === toISODate(t)) return "昨天";
    return due;
  }

  function metaHtml(t) {
    var parts = [];
    if (t.priority && URGENCIES[t.priority]) {
      parts.push(chipHtml("todo-chip-prio-" + (t.priority === "mid" ? "mid" : t.priority),
        "紧急 " + URGENCIES[t.priority].label));
    }
    for (var i = 0; i < t.tags.length; i++) {
      parts.push(chipHtml("todo-chip-tag", "#" + t.tags[i]));
    }
    if (t.due) {
      var overdue = !t.done && t.due < todayISO();
      parts.push(chipHtml("todo-chip-due" + (overdue ? " todo-chip-due-over" : ""),
        (overdue ? "已逾期 · " : "截止 ") + dueLabel(t.due)));
    }
    if (!parts.length) return "";
    return '<div class="todo-meta">' + parts.join("") + "</div>";
  }

  function itemHtml(t) {
    var cls = "todo-item";
    if (t.done) cls += " todo-item-done";
    if (!t.done && t.due && t.due < todayISO()) cls += " todo-item-overdue";
    var prio = t.priority || "none";

    var bodyHtml;
    if (state.editingId === t.id) {
      // 行内编辑：输入框内容原样（未解析）回填，保存时再解析
      bodyHtml =
        '<div class="todo-edit-row">' +
          '<input class="todo-edit-input" type="text" data-edit-input="' + escapeHtml(t.id) + '" ' +
                 'value="' + escapeHtml(serializeEdit(t)) + '">' +
          '<button class="todo-btn todo-btn-primary" data-action="edit-save" data-id="' + escapeHtml(t.id) + '">保存</button>' +
          '<button class="todo-btn" data-action="edit-cancel" data-id="' + escapeHtml(t.id) + '">取消</button>' +
        "</div>";
    } else {
      bodyHtml =
        '<span class="todo-text" data-action="edit-start" data-id="' + escapeHtml(t.id) + '" ' +
              'title="双击编辑">' + escapeHtml(t.text) + "</span>" + metaHtml(t);
    }

    return '<li class="' + cls + '" data-id="' + escapeHtml(t.id) + '" data-priority="' + escapeHtml(prio) + '">' +
      '<input class="todo-check" type="checkbox" data-action="toggle" data-id="' + escapeHtml(t.id) + '"' +
             (t.done ? " checked" : "") + ' aria-label="完成"' + ">" +
      '<div class="todo-body">' + bodyHtml + "</div>" +
      '<div class="todo-actions">' +
        '<button class="todo-icon-btn" data-action="cycle-prio" data-id="' + escapeHtml(t.id) + '" ' +
                'title="切换紧急等级（当前：' + (t.priority && URGENCIES[t.priority] ? URGENCIES[t.priority].label : "未设置") + '）">' +
                // 显示等级首字，比统一的 "!" 更能一眼看出当前档位
                (t.priority && URGENCIES[t.priority] ? URGENCIES[t.priority].label.charAt(0) : "·") + "</button>" +
        '<button class="todo-icon-btn todo-icon-btn-danger" data-action="remove" data-id="' + escapeHtml(t.id) + '" ' +
                'title="删除">✕</button>' +
      "</div>" +
    "</li>";
  }

  /** 编辑态回填：把已解析的元信息还原成可直接再解析的文本 */
  function serializeEdit(t) {
    var s = t.text;
    for (var i = 0; i < t.tags.length; i++) s += " #" + t.tags[i];
    if (t.priority && URGENCIES[t.priority]) s += " !" + URGENCIES[t.priority].label;
    if (t.due) s += " " + t.due;
    return s;
  }

  function renderList() {
    var visible = state.todos.filter(function (t) { return matchFilter(t, state.filter); });
    visible.sort(compareTodos);

    dom["todo-list"].innerHTML = visible.map(itemHtml).join("");

    var isEmpty = visible.length === 0;
    dom["todo-empty"].hidden = !isEmpty;
    if (isEmpty) {
      dom["todo-empty-text"].textContent = state.todos.length === 0
        ? "还没有待办，在上方输入后回车即可添加"
        : "当前筛选下没有条目";
    }
  }

  function renderTabs() {
    var c = counts();
    var nums = dom["todo-tabs"].querySelectorAll(".todo-tab-num");
    for (var i = 0; i < nums.length; i++) {
      var k = nums[i].getAttribute("data-num");
      nums[i].textContent = c[k] == null ? "0" : String(c[k]);
    }
    var tabs = dom["todo-tabs"].querySelectorAll(".todo-tab");
    for (var j = 0; j < tabs.length; j++) {
      var f = tabs[j].getAttribute("data-filter");
      if (f === state.filter) tabs[j].classList.add("active");
      else tabs[j].classList.remove("active");
    }
    // 「清除已完成」只在确有已完成项时出现
    dom["todo-clear-done"].hidden = c.done === 0;
  }

  function renderStats() {
    var c = counts();
    var html = "共 <b>" + c.all + "</b> 条 · 未完成 <b>" + c.active + "</b> 条";
    if (c.today > 0) {
      var overdue = state.todos.filter(function (t) {
        return !t.done && t.due && t.due < todayISO();
      }).length;
      html += ' · <span class="' + (overdue > 0 ? "todo-stat-over" : "todo-stat-due") + '">' +
        (overdue > 0 ? "已逾期 " + overdue + " 条（含今天到期 " + c.today + "）" : "今天到期 " + c.today + " 条") +
        "</span>";
    }
    dom["todo-stats"].innerHTML = html;
  }

  function renderHint() {
    var parsed = parseTodoInput(dom["todo-input"].value);
    var el = dom["todo-hint"];
    if (parsed.error) {
      // 空输入不算错误，直接不提示
      if (/可以留空|不能为空/.test(parsed.error) && !dom["todo-input"].value.trim()) {
        el.hidden = true;
        el.textContent = "";
        return;
      }
      el.hidden = false;
      el.className = "todo-hint todo-hint-error";
      el.textContent = parsed.error;
      return;
    }
    if (!parsed.priority && !parsed.tags.length && !parsed.due) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    var chips = [];
    // 等级一定展示：文本写了就用文本的，否则用选择器当前值（并标注来源，避免误以为没生效）
    var lvl = effectiveLevel(parsed);
    chips.push('<span class="todo-chip-inline">' + URGENCIES[lvl].label +
      (parsed.priority ? "" : "（选择器）") + "</span>");
    for (var i = 0; i < parsed.tags.length; i++) chips.push('<span class="todo-chip-inline">#' + escapeHtml(parsed.tags[i]) + "</span>");
    if (parsed.due) chips.push('<span class="todo-chip-inline">截止 ' + escapeHtml(dueLabel(parsed.due)) + "</span>");
    el.hidden = false;
    el.className = "todo-hint";
    el.innerHTML = "将按 " + chips.join(" ") + " 保存";
  }

  /** 排序控件：模式按钮的高亮 + 方向按钮的文案/箭头 */
  function renderSort() {
    var btns = dom["todo-sort"].querySelectorAll("[data-sort]");
    for (var i = 0; i < btns.length; i++) {
      var m = btns[i].getAttribute("data-sort");
      if (m === state.sortMode) btns[i].classList.add("active");
      else btns[i].classList.remove("active");
    }
    // 方向按钮：降序显示 ↓（新→旧 / 紧急→低），升序显示 ↑
    var dir = dom["todo-sort-dir"];
    if (dir) {
      dir.textContent = state.sortAsc ? "↑" : "↓";
      dir.title = state.sortAsc ? "当前升序，点击改为降序" : "当前降序，点击改为升序";
    }
  }

  function render() {
    if (!alive()) return;
    renderStats();
    renderTabs();
    renderSort();
    renderStatus();
    renderList();
    renderHint();
  }

  // ===== 操作 =====

  /**
   * 新增时的有效紧急等级：**文本优先，选择器兜底**。
   *
   * 文本里显式写了 `!紧急` / `!低` 时，用户是在这一条上临时改主意，
   * 不该被选择器覆盖；没写才用选择器当前值（默认「普通」）。
   */
  function effectiveLevel(parsed) {
    if (parsed.priority) return parsed.priority;
    var v = dom["todo-level"] ? dom["todo-level"].value : "";
    return URGENCIES[v] ? v : DEFAULT_LEVEL;
  }

  /** 把新增区重置为默认状态（等级回到默认档，输入框清空） */
  function resetComposer() {
    if (dom["todo-level"]) dom["todo-level"].value = DEFAULT_LEVEL;
    if (dom["todo-input"]) dom["todo-input"].value = "";
  }

  function findTodo(id) {
    for (var i = 0; i < state.todos.length; i++) {
      if (state.todos[i].id === id) return state.todos[i];
    }
    return null;
  }

  function addFromInput() {
    var parsed = parseTodoInput(dom["todo-input"].value);
    if (!parsed.ok) {
      renderHint();
      setStatus(parsed.error, true);
      return false;
    }
    if (state.todos.length >= MAX_TODOS) {
      setStatus("待办数量已达上限（" + MAX_TODOS + " 条），请先清理", true);
      return false;
    }
    state.todos.push({
      id: uid(),
      text: parsed.text,
      done: false,
      priority: effectiveLevel(parsed),
      tags: parsed.tags,
      due: parsed.due,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      completedAt: null
    });
    resetComposer();
    setStatus(null);
    commit();
    return true;
  }

  /** 「待办 : 买牛奶」二次搜索 → 快速新增 */
  function quickAdd(text) {
    var parsed = parseTodoInput(text);
    if (!parsed.ok) {
      setStatus(parsed.error + "（快速新增未生效）", true);
      return;
    }
    if (state.todos.length >= MAX_TODOS) {
      setStatus("待办数量已达上限（" + MAX_TODOS + " 条）", true);
      return;
    }
    state.todos.push({
      id: uid(),
      text: parsed.text,
      done: false,
      // 二次搜索新增没有选择器上下文（界面可能还没渲染），用默认档；
      // 文本里写了 `!紧急` 等仍以文本为准
      priority: parsed.priority || DEFAULT_LEVEL,
      tags: parsed.tags,
      due: parsed.due,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      completedAt: null
    });
    setStatus("已添加：「" + parsed.text + "」（" + URGENCIES[parsed.priority || DEFAULT_LEVEL].label + "）");
    toast("已添加", "ok");
    commit();
  }

  function toggleTodo(id) {
    var t = findTodo(id);
    if (!t) return;
    t.done = !t.done;
    t.completedAt = t.done ? Date.now() : null;
    t.updatedAt = Date.now();
    commit();
  }

  function removeTodo(id) {
    var before = state.todos.length;
    state.todos = state.todos.filter(function (t) { return t.id !== id; });
    if (state.todos.length === before) return;
    if (state.editingId === id) state.editingId = null;
    setStatus(null);
    commit();
  }

  function cyclePriority(id) {
    var t = findTodo(id);
    if (!t) return;
    // null → high → mid → low → null
    t.priority = t.priority === null ? "high"
      : t.priority === "high" ? "mid"
      : t.priority === "mid" ? "low"
      : null;
    t.updatedAt = Date.now();
    commit();
  }

  function startEdit(id) {
    state.editingId = id;
    render();
    var input = dom["todo-list"].querySelector('[data-edit-input="' + id + '"]');
    if (input) {
      input.focus();
      input.select();
    }
  }

  function cancelEdit() {
    state.editingId = null;
    render();
  }

  function saveEdit(id) {
    var input = dom["todo-list"].querySelector('[data-edit-input="' + id + '"]');
    if (!input) { state.editingId = null; render(); return; }
    var parsed = parseTodoInput(input.value);
    if (!parsed.ok) {
      setStatus(parsed.error, true);
      return; // 留在编辑态让人改
    }
    var t = findTodo(id);
    if (!t) { state.editingId = null; render(); return; }
    t.text = parsed.text;
    t.priority = parsed.priority;
    t.tags = parsed.tags;
    t.due = parsed.due;
    t.updatedAt = Date.now();
    state.editingId = null;
    setStatus(null);
    commit();
  }

  function clearDone() {
    if (!clearArmed) {
      clearArmed = true;
      dom["todo-clear-done"].textContent = "再点一次确认清除";
      clearTimer = setTimeout(function () {
        clearArmed = false;
        clearTimer = null;
        dom["todo-clear-done"].textContent = "清除已完成";
      }, 3000);
      return;
    }
    if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; }
    clearArmed = false;
    dom["todo-clear-done"].textContent = "清除已完成";
    var n = state.todos.filter(function (t) { return t.done; }).length;
    state.todos = state.todos.filter(function (t) { return !t.done; });
    setStatus("已清除 " + n + " 条已完成", false);
    commit();
  }

  // ===== 事件绑定 =====

  function bindEvents() {
    // 新增
    if (dom["todo-add"]) dom["todo-add"].addEventListener("click", function () { addFromInput(); });

    if (dom["todo-input"]) {
      dom["todo-input"].addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.isComposing) {
          e.preventDefault();
          addFromInput();
        }
      });
      dom["todo-input"].addEventListener("input", function () {
        clearArmed = false;
        renderHint();
      });
    }

    // 等级选择器：改了要立刻刷新提示（否则提示里还显示旧等级）
    if (dom["todo-level"]) {
      dom["todo-level"].addEventListener("change", function () {
        renderHint();
      });
    }

    // 筛选页签（列表会被重建，所以这里用委托）
    if (dom["todo-tabs"]) {
      dom["todo-tabs"].addEventListener("click", function (e) {
        var btn = e.target.closest ? e.target.closest(".todo-tab") : null;
        if (!btn) return;
        var f = btn.getAttribute("data-filter");
        if (FILTERS.indexOf(f) === -1) return;
        state.filter = f;
        state.editingId = null;
        render();
      });
    }

    if (dom["todo-clear-done"]) dom["todo-clear-done"].addEventListener("click", clearDone);

    // 排序：模式按钮（委托） + 方向切换
    if (dom["todo-sort"]) {
      dom["todo-sort"].addEventListener("click", function (e) {
        var btn = e.target.closest ? e.target.closest("[data-sort]") : null;
        if (!btn) return;
        setSortMode(btn.getAttribute("data-sort"));
        state.editingId = null;
        persistPrefs();
        render();
      });
    }
    if (dom["todo-sort-dir"]) {
      dom["todo-sort-dir"].addEventListener("click", function () {
        toggleSortAsc();
        state.editingId = null;
        persistPrefs();
        render();
      });
    }

    // 列表：单击 / 双击 / 按钮 / 编辑框，全部委托在 #todo-list 上
    if (dom["todo-list"]) {
      dom["todo-list"].addEventListener("click", function (e) {
        var el = e.target.closest ? e.target.closest("[data-action]") : null;
        if (!el) return;
        var action = el.getAttribute("data-action");
        var id = el.getAttribute("data-id");
        if (action === "toggle") { toggleTodo(id); return; }
        if (action === "remove") { removeTodo(id); return; }
        if (action === "cycle-prio") { cyclePriority(id); return; }
        if (action === "edit-save") { saveEdit(id); return; }
        if (action === "edit-cancel") { cancelEdit(); return; }
        // edit-start 只在双击时触发（见 dblclick），单击不进入编辑
      });

      dom["todo-list"].addEventListener("dblclick", function (e) {
        var el = e.target.closest ? e.target.closest('[data-action="edit-start"]') : null;
        if (!el) return;
        startEdit(el.getAttribute("data-id"));
      });

      dom["todo-list"].addEventListener("keydown", function (e) {
        var t = e.target;
        if (!t || !t.getAttribute || !t.getAttribute("data-edit-input")) return;
        var id = t.getAttribute("data-edit-input");
        if (e.key === "Enter" && !e.isComposing) {
          e.preventDefault();
          saveEdit(id);
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancelEdit();
        }
      });
    }
  }

  // ===== 启动 =====

  function boot() {
    // 先恢复排序偏好，再排序，否则首帧会按默认顺序渲染一次再跳（闪动）
    loadPrefs();
    state.todos = loadTodos();
    state.todos.sort(compareTodos);
    // 等级选择器回到默认档（minimize 保活时 DOM 会沿用上次的值，这里显式复位一次语义）
    if (dom["todo-level"] && !URGENCIES[dom["todo-level"].value]) {
      dom["todo-level"].value = DEFAULT_LEVEL;
    }
    // 首次运行写入一次，确保 store 键存在（也便于用户看到数据结构）
    if (!ms.store.get(STORE_KEY, null)) persist();

    bindEvents();
    render();

    // 「待办 : 买牛奶」→ 快速新增。挂载时宿主会立刻推一次当前子关键词，
    // 因此只在子词非空时才落库，避免空子词被当成一次空新增。
    if (typeof onSubKeyword === "function") {
      onSubKeyword(function (sub) {
        if (!alive()) return;
        var s = String(sub == null ? "" : sub).trim();
        if (!s) return;
        quickAdd(s);
      });
    }

    ms.log("info", "待办清单已加载 id=" + plugin.id + " v=" + plugin.version +
      " todos=" + state.todos.length + " store=" + (ms.plugin.has("store") ? "granted" : "missing"));
  }

  boot();
})(ms, env, plugin, host, keyword, inputValue, onSubKeyword, md2html, openExternal);
