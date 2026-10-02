/**
 * 资源监控插件 - 前台入口脚本
 *
 * 宿主注入参数: ms, env, plugin, host, keyword, inputValue, onSubKeyword,
 *               md2html, openExternal
 * （宿主用 `new Function("ms","env",...,code)` 调用本文件，所以下面 IIFE 的
 *  形参声明 + 末尾实参回传是必需的：既拿到注入值，又让本文件能被当普通
 *  <script> 直接加载调试。）
 *
 * ============================ 它做什么 ============================
 *
 *   数据全部来自后台进程（每 5s 采样，滚动保留最近 35 分钟）：
 *     - 打开时 `ms.backend.call("history")` 一次取回整段，秒填趋势图；
 *     - 之后靠 `ms.backend.onNotification("tick", …)` 增量追加新采样点。
 *
 *   渲染三块：
 *     1) 顶部系统卡片（整机 CPU / 内存 / 真实上传 / 真实下载）；
 *     2) 多线趋势图（纯手写 SVG，不引图表库），每条线 = 一个程序；
 *     3) 当前 Top 10 条形列表。
 *
 *   三个类别页签：CPU 占用 / 内存占用 / 上传占用。
 *
 *   点图表可「定格」某个采样时刻：下面的榜单（以及顶部卡片）随之切到**那一刻**
 *   的数据，方便回看历史；点「回到最新」或再点一次 / 按 Esc 即清除，恢复跟随最新。
 *
 * ============================ 关于「上传」的口径 ============================
 *
 *   Windows 上免管理员拿不到「真·每进程发送字节」（那需要管理员 + ETW）。
 *   因此上传榜用 `OtherTransferCount` 的差值近似——它**含命名管道等非文件 IO、
 *   且收发混合**，是个偏上界的近似值（界面上有明确标注）。顶部的「真实上传 /
 *   下载」则取自网卡累计字节，是系统级真实速率，可作对照。
 *
 * ============================ 状态放哪 ============================
 *
 *   采样历史由后台持有并落盘；前台只持有内存中的渲染态（当前页签、隐藏的
 *   线、悬浮位置、定格的时刻）。界面偏好（如页签）用 ms.store 记住，跨会话保留。
 */
(function (ms, env, plugin, host, keyword, inputValue, onSubKeyword, md2html, openExternal) {
  "use strict";

  /* ======================= 常量 ======================= */

  var CATS = ["cpu", "mem", "up"];
  var CAT_LABEL = { cpu: "CPU 占用", mem: "内存占用", up: "上传占用" };
  var CAT_UNIT = { cpu: "%", mem: "bytes", up: "bps" };
  var STORE_CAT = "ui.category";
  var STORE_SOLO = "ui.solo";       // { cpu:name|null, mem:…, up:… }：每类「只看这一个」
  var MAX_SERIES = 8;               // 趋势图最多画几条线（其余进图例，可点开）
  var PAD_L = 54;                   // 左侧留白：容得下 "977 KB/s" 这类 Y 轴刻度
  var PAD_R = 8;

  /** 趋势线配色：中饱和、深浅底都能读；按程序名哈希稳定分配 */
  var PALETTE = [
    "#5b5bd6", "#e02424", "#1a9c5b", "#e6a23c", "#2f7fe0", "#d946ef",
    "#0ea5e9", "#f97316", "#10b981", "#8b5cf6", "#f43f5e", "#14b8a6",
    "#a855f7", "#84cc16"
  ];

  /* ======================= DOM ======================= */

  var dom = {};
  [
    "rm-c-cpu", "rm-c-mem", "rm-c-mem-sub", "rm-c-up", "rm-c-down",
    "rm-status", "rm-clear", "rm-export", "rm-chartwrap", "rm-chart", "rm-cross", "rm-tip",
    "rm-legend", "rm-note", "rm-list", "rm-empty", "rm-pinbar",
    "rm-enter", "rm-exit", "rm-apply", "rm-cfg-hint",
    "rm-zin", "rm-zout", "rm-zreset", "rm-zlabel"
  ].forEach(function (id) {
    dom[id] = document.getElementById(id);
  });
  var rootEl = document.getElementById("app");
  var tabs = Array.prototype.slice.call(document.querySelectorAll(".rm-tab"));

  /* ======================= 状态 ======================= */

  var points = [];          // [{t, s:[...], top:{...}, trk:{...}}]
  var activeCat = "cpu";
  var solo = { cpu: null, mem: null, up: null }; // 每个类别里「只看这一个」（null = 不单选）
  var status = null;
  var sampleMs = 5000;      // 采样间隔（从 history.meta / status 同步；算断线阈值用）
  var enterN = 10;          // 进圈名次（标尺；真实值以后台 status 为准）
  var exitN = 15;           // 出圈名次
  var topN = 10;
  var unsubs = [];
  var chartW = 0;
  var hoverIdx = -1;
  var pinnedT = null;       // 定格的采样时刻（null = 跟随最新）；点图表设定，点「取消定格」/ Esc 清除

  /**
   * 时间范围（缩放）状态。spanMs = 当前显示的时间跨度（毫秒）；
   *      endT   = 右端时间（null = 跟随最新）；放大后用户可拖动平移右端。
   *
   * 档位按「5 分钟一档」从 5 分到 35 分（= 后台保留窗口）：
   *   默认显示 10 分；放大 → 逐档缩短（到 5 分）；缩小 → 逐档 +5 分（到 35 分）。
   * 放大 = 缩短 span，缩小 = 拉长 span。
   */
  var SPAN_MINUTES = [5, 10, 15, 20, 25, 30, 35];           // 可用的分钟档位（升序）
  var DEFAULT_SPAN_MS = 10 * 60 * 1000;                     // 默认显示 10 分钟
  var SPAN_STEPS = SPAN_MINUTES.slice().reverse().map(function (m) { return m * 60000; }); // 降序：35…5 分
  var windowMs = 35 * 60 * 1000;                            // 后台保留窗口（由 history.meta 同步）
  var spanMs = DEFAULT_SPAN_MS;
  var panEndT = null;       // null = 贴住最新；数值 = 右端固定在某个采样时刻

  function alive() {
    return !rootEl || document.body.contains(rootEl);
  }

  /* ======================= 小工具 ======================= */

  function fmtBytes(v) {
    v = Number(v) || 0;
    var u = ["B", "KB", "MB", "GB", "TB"];
    var i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i === 0 ? v.toFixed(0) : v.toFixed(v >= 100 ? 0 : 1)) + " " + u[i];
  }
  function fmtBps(v) { return fmtBytes(v) + "/s"; }
  function fmtPct(v) { return (Number(v) || 0).toFixed(1) + "%"; }
  function fmtValue(cat, v) {
    if (cat === "cpu") return fmtPct(v);
    if (cat === "mem") return fmtBytes(v);
    return fmtBps(v);
  }
  /** Y 轴刻度用短格式（避免挤） */
  function fmtAxis(cat, v) {
    if (cat === "cpu") return (Number(v) || 0).toFixed(0) + "%";
    if (cat === "mem") return fmtBytes(v);
    return fmtBytes(v) + "/s";
  }
  function fmtTime(t) {
    var d = new Date(t);
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }
  function fmtClock(t) {
    var d = new Date(t);
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function agoText(t) {
    if (!t) return "尚未采样";
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 3) return "刚刚更新";
    if (s < 60) return s + " 秒前更新";
    return Math.round(s / 60) + " 分钟前更新";
  }
  function colorOf(name) {
    var h = 0;
    for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function esc(s) { return String(s == null ? "" : s); }

  /* ======================= 数据存取 ======================= */

  function latest() { return points.length ? points[points.length - 1] : null; }

  /** 按时间戳找采样点（points 已按 t 升序）；找不到返回 null */
  function pointAt(t) {
    if (t == null) return null;
    for (var i = 0; i < points.length; i++) if (points[i].t === t) return points[i];
    return null;
  }

  /**
   * 「定格」解析：定格态返回那一刻的点，否则 null（= 应显示最新）。
   * 定格的点已被滚动窗口裁掉的情况，由 ensureSorted() 提前取消定格，这里不再兜底。
   */
  function pinnedPoint() {
    if (pinnedT == null) return null;
    return pointAt(pinnedT);
  }

  /** 需要「具体某一拍」的渲染（榜单）都用它取数：定格态取定格点，否则取最新 */
  function displayPoint() { return pinnedPoint() || latest(); }

  /* ======================= 渲染：系统卡片 ======================= */

  function renderCards() {
    // 定格某个时刻时，卡片也切到那一刻的数据，与下方榜单保持同一「快照」
    var p = displayPoint();
    if (!p) {
      dom["rm-c-cpu"].textContent = "--";
      dom["rm-c-mem"].textContent = "--";
      dom["rm-c-mem-sub"].textContent = "";
      dom["rm-c-up"].textContent = "--";
      dom["rm-c-down"].textContent = "--";
      return;
    }
    var s = p.s || [];
    dom["rm-c-cpu"].textContent = fmtPct(s[0]);
    var used = s[1] || 0, total = s[2] || 0;
    // 内存主数值用**占用百分比**（与 CPU 卡片口径一致），具体用量放在下方副行
    if (total > 0) {
      dom["rm-c-mem"].textContent = (used / total * 100).toFixed(0) + "%";
      dom["rm-c-mem-sub"].textContent = fmtBytes(used) + " / " + fmtBytes(total);
    } else {
      dom["rm-c-mem"].textContent = fmtBytes(used);
      dom["rm-c-mem-sub"].textContent = "";
    }
    dom["rm-c-up"].textContent = fmtBps(s[3]);
    dom["rm-c-down"].textContent = fmtBps(s[4]);
  }

  /* ======================= 渲染：状态行 ======================= */

  function renderStatus() {
    var p = latest();
    var pin = pinnedPoint();
    var parts = [];
    if (status && status.supported === false) {
      parts.push(status.platform === "win32"
        ? "未找到 PowerShell，无法采样"
        : "本插件目前仅支持 Windows");
    } else if (pin) {
      // 定格态：明确告诉用户下方看到的是「那一刻」的快照，而非实时
      parts.push("已定格 " + fmtTime(pin.t) + " 的快照");
    } else if (p) {
      parts.push(agoText(p.t));
      if (status && status.restarts) parts.push("重启 " + status.restarts + " 次");
    } else {
      parts.push("正在采集…");
    }
    dom["rm-status"].textContent = parts.join(" · ");
    dom["rm-status"].classList.toggle("warn", !!(status && status.lastError) || (status && status.supported === false));
    if (status && status.lastError) dom["rm-status"].title = String(status.lastError);
    dom["rm-empty"].hidden = points.length > 0;
  }

  /* ======================= 渲染：趋势图 ======================= */

  /** 某采样点该类别里，该程序的值（趋势线取 trk，回退 top） */
  function trkValue(p, cat, name) {
    var src = (p.trk && p.trk[cat]) ? p.trk[cat] : ((p.top && p.top[cat]) || []);
    for (var i = 0; i < src.length; i++) if (src[i][0] === name) return src[i][1] || 0;
    return null; // 该拍未跟踪（线在此断开/不画点）
  }

  /**
   * 该类别窗口内出现过的所有程序（含被隐藏的），按峰值降序。
   *
   * 取值来源是「滞回跟踪集合」(trk)：一个程序只要没跌出 exitN，就会一直留在
   * 窗口内的这条线里——这正是用户要的「进 10 名就上，掉出 15 名才下」。
   */
  function seriesNames(cat) {
    var peak = new Map();
    for (var i = 0; i < points.length; i++) {
      var src = (points[i].trk && points[i].trk[cat]) ? points[i].trk[cat] : ((points[i].top && points[i].top[cat]) || []);
      for (var j = 0; j < src.length; j++) {
        var n = src[j][0], v = src[j][1] || 0;
        if (!peak.has(n) || v > peak.get(n)) peak.set(n, v);
      }
    }
    var arr = Array.from(peak.keys());
    arr.sort(function (a, b) { return (peak.get(b) || 0) - (peak.get(a) || 0) || (a < b ? -1 : 1); });
    return arr;
  }

  /** 已可视化的线：选中了某个 tag 就只画它，否则画全部（上限 MAX_SERIES） */
  function visibleSeries(cat) {
    if (solo[cat]) return [solo[cat]]; // 单选模式：只显示这一个
    return seriesNames(cat).slice(0, MAX_SERIES);
  }

  /** 同步悬浮/图例用：某程序此刻是否在图上 */
  function isVisibleNow(cat, name) {
    return visibleSeries(cat).indexOf(name) >= 0;
  }

  function renderChart() {
    var wrap = dom["rm-chartwrap"];
    var box = dom["rm-chart"];
    if (!box) return;
    chartW = Math.max(280, Math.floor(wrap.clientWidth || 320) - 8);
    var H = 168;
    var padL = PAD_L, padR = PAD_R, padT = 8, padB = 18;
    var w = chartW, h = H;

    var p = latest();
    var visible = p ? visibleSeries(activeCat) : [];

    // 空态：仍画出坐标框与提示
    var svg = svgEl("svg", { viewBox: "0 0 " + w + " " + h, width: "100%", height: h });

    if (!p || points.length === 0) {
      box.innerHTML = "";
      box.appendChild(svg);
      return;
    }

    // --- 时间轴：按缩放后的范围（spanMs），右端默认贴住最新，可平移 ---
    var latestT = p.t;
    var tEnd = (panEndT == null) ? latestT : Math.min(panEndT, latestT);
    var tStart = tEnd - spanMs;
    // 平移不能早于最早数据、也不能越过最新
    var earliest = points.length ? points[0].t : tStart;
    if (tStart < earliest) { tStart = earliest; tEnd = tStart + spanMs; }
    if (tEnd > latestT) { tEnd = latestT; tStart = tEnd - spanMs; }
    var xOf = function (t) { return padL + (t - tStart) / (tEnd - tStart) * (w - padL - padR); };

    // 只画窗口内的点（放大后视野外的点不参与，避免折线画到框外）
    var inWin = function (t) { return t >= tStart && t <= tEnd; };

    // --- Y 轴：按可见线在窗口内的最大值自适应，取一个好看的整数上限 ---
    var maxV = 0;
    var series = [];
    for (var si = 0; si < visible.length; si++) {
      var name = visible[si];
      var pts = [];
      for (var i = 0; i < points.length; i++) {
        if (!inWin(points[i].t)) continue;
        var v = trkValue(points[i], activeCat, name);
        if (v == null) continue; // 该拍未跟踪 → 断点
        pts.push([points[i].t, v]);
        if (v > maxV) maxV = v;
      }
      if (pts.length > 0) series.push({ name: name, pts: pts });
    }
    var yMax = niceMax(activeCat, maxV);
    var yOf = function (v) { return padT + (1 - (v / (yMax || 1))) * (h - padT - padB); };

    // --- 网格 + Y 轴刻度（4 段）---
    var g = svgEl("g", {});
    for (var k = 0; k <= 4; k++) {
      var val = yMax * k / 4;
      var y = yOf(val);
      g.appendChild(svgEl("line", { class: "rm-gridline", x1: padL, y1: y, x2: w - padR, y2: y }));
      var lb = svgEl("text", { class: "rm-axis", x: padL - 5, y: y + 3, "text-anchor": "end" });
      lb.textContent = fmtAxis(activeCat, val);
      g.appendChild(lb);
    }
    // --- X 轴刻度：按当前跨度分成 4 段，末端始终标时间 ---
    for (var ti = 0; ti <= 4; ti++) {
      var tt = tEnd - spanMs * (4 - ti) / 4;
      var xx = xOf(tt);
      var lx = svgEl("text", {
        class: "rm-axis", x: xx, y: h - 5,
        "text-anchor": ti === 4 ? "end" : (ti === 0 ? "start" : "middle")
      });
      lx.textContent = (ti === 4) ? fmtClock(tt) : "-" + fmtDur(spanMs * (4 - ti) / 4);
      g.appendChild(lx);
    }
    svg.appendChild(g);

    // --- 折线（采样点不连续处断开，避免「消失又回来」被连成一条假直线）---
    var gapMs = Math.max(3000, sampleMs * 2.5);
    for (var s2 = 0; s2 < series.length; s2++) {
      var se = series[s2];
      var d = "";
      for (var pi = 0; pi < se.pts.length; pi++) {
        var p0 = se.pts[pi];
        var isNew = pi === 0 || (p0[0] - se.pts[pi - 1][0]) > gapMs;
        d += (isNew ? "M" : "L") + xOf(p0[0]).toFixed(1) + " " + yOf(p0[1]).toFixed(1) + " ";
      }
      if (d) {
        svg.appendChild(svgEl("path", {
          class: "rm-series", d: d.trim(), stroke: colorOf(se.name),
          "data-name": se.name
        }));
      }
    }

    // --- 定格标记：在图上给定格的时刻画一条竖线 + 圆点，明确「看的是哪一拍」---
    if (pinnedT != null && pinnedT >= tStart && pinnedT <= tEnd) {
      var px = xOf(pinnedT);
      svg.appendChild(svgEl("line", {
        class: "rm-pinmark",
        x1: px, y1: padT, x2: px, y2: h - padB
      }));
      svg.appendChild(svgEl("circle", {
        class: "rm-pindot", cx: px, cy: padT + 4, r: 3
      }));
    }

    box.innerHTML = "";
    box.appendChild(svg);
    renderLegend(visible);
    renderNote();
    // 记录本帧几何，供已绑定一次（bindEvents）的悬浮逻辑使用
    geom = { tStart: tStart, tEnd: tEnd };
    updateZoomUi();
  }

  /** 按时间跨度给出可读的时长（用于 X 轴刻度） */
  function fmtDur(ms) {
    var s = Math.round(ms / 1000);
    if (s < 60) return s + "s";
    var m = Math.round(s / 60);
    if (m < 60) return m + "m";
    var h = m / 60;
    return (h % 1 === 0 ? h.toFixed(0) : h.toFixed(1)) + "h";
  }

  /** 当前跨度对应的分钟数（用于标签）；不在整档上时四舍五入 */
  function spanLabel() {
    var m = Math.round(spanMs / 60000);
    return "最近 " + m + " 分";
  }

  /** 找离 spanMs 最近的档位下标（SPAN_STEPS 是降序数组） */
  function nearestStepIndex() {
    var best = 0, bestD = Infinity;
    for (var i = 0; i < SPAN_STEPS.length; i++) {
      var d = Math.abs(SPAN_STEPS[i] - spanMs);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /** 更新缩放标签文字与按钮可用态 */
  function updateZoomUi() {
    if (dom["rm-zlabel"]) dom["rm-zlabel"].textContent = spanLabel();
    var atMin = spanMs <= SPAN_STEPS[SPAN_STEPS.length - 1]; // 已到最细（5 分）
    var atMax = spanMs >= SPAN_STEPS[0];                     // 已到最粗（35 分）
    if (dom["rm-zin"]) dom["rm-zin"].disabled = atMin;
    if (dom["rm-zout"]) dom["rm-zout"].disabled = atMax;
    // 平移/缩放到底=贴住最新；非贴住时「回到最新」按钮高亮可用
    if (dom["rm-zreset"]) dom["rm-zreset"].disabled = (panEndT == null);
    // 只要处于放大态（比最大档窄）就能拖动平移，光标提示可抓取
    var wrap = dom["rm-chartwrap"];
    if (wrap) wrap.classList.toggle("rm-pannable", spanMs < SPAN_STEPS[0]);
  }

  /** 放大：跨度 −5 分钟（看细节），到 5 分为止 */
  function zoomIn() {
    var i = nearestStepIndex();
    if (i < SPAN_STEPS.length - 1) spanMs = SPAN_STEPS[i + 1];
    renderChart();
  }
  /** 缩小：跨度 +5 分钟（看更久），到 35 分（后台窗口上限）即贴住最新 */
  function zoomOut() {
    var i = nearestStepIndex();
    if (i > 0) spanMs = SPAN_STEPS[i - 1];
    if (spanMs >= SPAN_STEPS[0]) panEndT = null; // 放到最大自然回到最新
    renderChart();
  }
  /** 回到最新（取消平移） */
  function zoomReset() {
    panEndT = null;
    renderChart();
  }

  /** 取一个「好看的」Y 轴上限：略微上浮并取整 */
  function niceMax(cat, v) {
    if (!(v > 0)) return cat === "cpu" ? 100 : 1;
    if (cat === "cpu") return Math.min(100, Math.max(10, Math.ceil(v / 5) * 5));
    // 字节 / 速率：按 1-2-5 台阶
    var mag = Math.pow(10, Math.floor(Math.log10(v)));
    var n = v / mag;
    var step;
    if (n <= 1) step = 1; else if (n <= 2) step = 2; else if (n <= 5) step = 5; else step = 10;
    return step * mag;
  }

  function svgEl(tag, attrs) {
    var e = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) e.setAttribute(k, attrs[k]);
    return e;
  }

  /* ======================= 渲染：图例 ======================= */

  /**
   * 图例 = 图下面的 tag 条。
   * 交互：点某个 tag → **只看这一个**（其余不画）；再点同一个 → 取消单选，恢复全部。
   * 点另一个 tag（已处于单选态）→ 直接切换到那个。
   */
  function renderLegend(visible) {
    var all = seriesNames(activeCat);
    var cur = solo[activeCat];
    dom["rm-legend"].innerHTML = "";
    if (all.length === 0) { dom["rm-legend"].hidden = true; return; }
    dom["rm-legend"].hidden = false;

    for (var i = 0; i < all.length; i++) {
      var name = all[i];
      var isSolo = cur === name;
      // 单选态下：选中的高亮，其余置灰；非单选态下：受同屏上限限制而没画出来的置灰
      var dim = cur ? !isSolo : (visible.indexOf(name) < 0);
      var cls = "rm-legend-item" + (isSolo ? " solo" : "") + (dim ? " off" : "");
      var item = el("span", cls);
      item.title = isSolo ? (name + "（再次点击：显示全部）") : (name + "（只看这一个）");
      var dot = el("span", "rm-legend-dot");
      dot.style.background = colorOf(name);
      item.appendChild(dot);
      item.appendChild(el("span", null, name));
      (function (nm) {
        item.addEventListener("click", function () { toggleSolo(nm); });
      })(name);
      dom["rm-legend"].appendChild(item);
    }

    var hint = el("span", "rm-legend-more");
    if (cur) {
      hint.textContent = "（只看 " + cur + "；再点一次该 tag 恢复全部）";
    } else if (all.length > MAX_SERIES) {
      hint.textContent = "（最多同屏 " + MAX_SERIES + " 条，已显示 " + Math.min(all.length, MAX_SERIES) + " 条；点 tag 可只看一个）";
    } else {
      hint.textContent = "（点 tag 只看那一个）";
    }
    dom["rm-legend"].appendChild(hint);
  }

  /** 单选切换：点已选中的 → 取消；否则切到它 */
  function toggleSolo(name) {
    solo[activeCat] = (solo[activeCat] === name) ? null : name;
    saveSolo();
    renderChart();
  }

  /* ======================= 渲染：说明 ======================= */

  function renderNote() {
    if (activeCat === "cpu") {
      dom["rm-note"].textContent = "按程序名聚合（同名多进程合并），数值 = 占整机 CPU 的百分比（各程序相加 ≈ 100%）。";
    } else if (activeCat === "mem") {
      dom["rm-note"].textContent = "按程序名聚合，数值 = 该程序所有进程的工作集（物理内存）之和。";
    } else {
      dom["rm-note"].textContent = "近似值：免管理员只能取到「非文件 IO」计数（含命名管道等、收发混合），偏上界；顶部「真实上传/下载」是网卡实测速率，可作对照。";
    }
  }

  /* ======================= 渲染：Top 10 列表 ======================= */

  /**
   * 榜单：跟随最新，或（定格时）定格在那一刻。
   * 定格只是**在已有采样点上选一拍**，不额外向后台取数——所以它天然就是
   * 「只显示当时的数据」，且清除后立即回到最新。
   */
  function renderList() {
    var pin = pinnedPoint();
    var p = displayPoint();
    var box = dom["rm-list"];
    box.innerHTML = "";
    if (!p) return;

    // 定格时给榜单加一行说明，点明「看的是哪一刻」；实时态不占用纵向空间
    if (pin) {
      var head = el("div", "rm-listhead");
      head.appendChild(el("span", "rm-listhead-t", "定格榜单 · " + fmtTime(pin.t)));
      head.appendChild(el("span", "rm-listhead-badge", "已定格"));
      box.appendChild(head);
    }

    var list = (p.top && p.top[activeCat]) || [];
    if (list.length === 0) {
      var e = el("div", "rm-empty", (pin ? "那一刻" : "最近一拍")
        + "该类别的占用都很低（无进入 Top " + topN + " 的程序）。");
      box.appendChild(e);
      return;
    }
    var max = list[0][1] || 1;
    for (var i = 0; i < list.length; i++) {
      var name = list[i][0], val = list[i][1] || 0, inst = list[i][2] || 1;
      var row = el("div", "rm-row");

      var rank = el("span", "rm-rank", String(i + 1));
      var dot = el("span", "rm-dot");
      dot.style.background = colorOf(name);
      var nm = el("span", "rm-name");
      nm.appendChild(document.createTextNode(name));
      if (inst > 1) nm.appendChild(el("span", "rm-inst", "×" + inst + " 进程"));
      var vv = el("span", "rm-val", fmtValue(activeCat, val));

      // 操作按钮：打开文件位置 / 终止进程（都按程序名）
      var acts = el("span", "rm-acts");
      var reveal = el("button", "rm-kill", "位置");
      reveal.title = "打开 " + name + " 的可执行文件所在位置";
      reveal.setAttribute("data-act", "reveal");
      (function (nm2) {
        reveal.addEventListener("click", function (ev) {
          ev.stopPropagation();
          onRevealClick(nm2);
        });
      })(name);

      var kill = el("button", "rm-kill", "终止");
      kill.title = "结束 " + name + " 的所有进程（" + inst + " 个）";
      kill.setAttribute("data-act", "kill");
      (function (nm2, inst2) {
        kill.addEventListener("click", function (ev) {
          ev.stopPropagation();
          onKillClick(nm2, inst2);
        });
      })(name, inst);
      acts.appendChild(reveal);
      acts.appendChild(kill);

      var bar = el("div", "rm-bar");
      var fill = el("i");
      fill.style.width = Math.max(2, Math.round(val / max * 100)) + "%";
      fill.style.background = colorOf(name);
      bar.appendChild(fill);

      row.appendChild(rank);
      row.appendChild(dot);
      row.appendChild(nm);
      row.appendChild(vv);
      row.appendChild(acts);
      row.appendChild(bar);
      box.appendChild(row);
    }
  }

  /* ======================= 定格某一时刻（榜单快照） ======================= */

  /**
   * 定格某一时刻：下方榜单（及顶部卡片）切到那一拍的快照；
   * 再点同一时刻或点「取消定格」即清除，恢复跟随最新。
   */
  function togglePin(t) {
    pinnedT = (pinnedT === t) ? null : t;   // 点同一时刻 = 取消
    renderAll();
  }

  /** 清除定格，回到实时 */
  function clearPin() {
    if (pinnedT == null) return;
    pinnedT = null;
    renderAll();
  }

  /** 显示/隐藏「定格 · 时间 ⟶ 取消定格」提示条 */
  function renderPinBar() {
    var bar = dom["rm-pinbar"];
    if (!bar) return;
    var pin = pinnedPoint();
    if (!pin) { bar.hidden = true; return; }
    bar.hidden = false;
    bar.innerHTML = "";
    bar.appendChild(el("span", "rm-pin-dot"));
    bar.appendChild(el("span", "rm-pin-text", "定格 " + fmtTime(pin.t) + " 的快照"));
    var back = el("button", "rm-pin-back", "取消定格");
    back.type = "button";
    back.title = "取消定格，恢复显示最新数据（等同按 Esc）";
    back.addEventListener("click", function (ev) { ev.stopPropagation(); clearPin(); });
    bar.appendChild(back);
  }

  /** 打开某程序可执行文件的位置（后台用资源管理器选中） */
  function onRevealClick(name) {
    ms.backend.call("revealProcessFile", { name: name }).then(function (r) {
      if (r && r.opened) ms.ui.toast("已在资源管理器中定位：" + (r.path || name));
      else ms.ui.toast("无法打开位置：" + ((r && r.reason) || "未知原因"), "error");
    }).catch(function (e) {
      ms.ui.toast("打开位置失败：" + (e && e.message ? e.message : e), "error");
    });
  }

  /** 终止某程序：先确认（带实例数），再调后台 killProcess */
  function onKillClick(name, inst) {
    var warn = "结束「" + name + "」的所有进程？"
      + (inst > 1 ? "（共 " + inst + " 个实例）" : "")
      + "\n\n未保存的数据会丢失；若它是本应用自身相关进程，可能影响使用。";
    ms.ui.confirm(warn).then(function (ok) {
      if (!ok) return;
      return ms.backend.call("killProcess", { name: name, force: true }).then(function (r) {
        var matched = (r && r.matched != null) ? r.matched : 0;
        var killed = (r && r.killed != null) ? r.killed : 0;
        var skipped = (r && r.skipped) || [];
        var failed = (r && r.failed) || [];

        // 一个都没匹配到：多半是它已经退出了，不必显示 "0/0"
        if (matched === 0) {
          ms.ui.toast("「" + name + "」当前没有正在运行的进程");
          return;
        }

        // 一个没杀成、也没跳过 → 用错误样式，别用「成功」口吻误导
        if (killed === 0 && failed.length > 0 && skipped.length === 0) {
          ms.ui.toast("结束「" + name + "」失败：" + failed[0].error, "error");
          return;
        }

        var msg = "已结束 " + killed + "/" + matched + " 个进程";
        if (skipped.length) msg += "；跳过 " + skipped.length + " 个（" + skipped[0].reason + "）";
        if (failed.length) msg += "；失败 " + failed.length + " 个（" + failed[0].error + "）";
        ms.ui.toast(msg, failed.length ? "error" : "ok");
      });
    }).catch(function (e) {
      ms.ui.toast("终止失败：" + (e && e.message ? e.message : e), "error");
    });
  }

  /* ======================= 悬浮提示 ======================= */

  /** 本帧趋势图的时间范围（renderChart 每次更新；只读，供悬浮换算 X） */
  var geom = null;

  /** 只在 bindEvents 里绑定一次：每次重绘只换 DOM，不重复挂监听 */
  function bindHoverOnce() {
    var box = dom["rm-chartwrap"];
    if (!box) return;

    function hideHover() {
      hoverIdx = -1;
      dom["rm-cross"].hidden = true;
      dom["rm-tip"].hidden = true;
    }

    /**
     * 把光标 X 换算成时间，找**当前显示窗口内**最近的采样点。
     * 悬浮与点击（定格）共用这一套「光标 → 最近一拍」的换算，避免两处规则漂移。
     */
    function nearestPoint(ev) {
      if (!geom || points.length === 0) return null;
      var rect = box.getBoundingClientRect();
      var x = ev.clientX - rect.left;
      if (x < PAD_L || x > rect.width - PAD_R) return null; // 落在坐标区外 → 不算
      var ratio = (x - PAD_L) / (rect.width - PAD_L - PAD_R);
      var target = geom.tStart + ratio * (geom.tEnd - geom.tStart);
      var best = null, bestD = Infinity;
      for (var i = 0; i < points.length; i++) {
        var pt = points[i];
        if (pt.t < geom.tStart || pt.t > geom.tEnd) continue; // 只看窗口内的点
        var d = Math.abs(pt.t - target);
        if (d < bestD) { bestD = d; best = pt; }
      }
      return best;
    }

    /** 由采样点的 t 反算其在图上的 X（像素） */
    function xOfT(t) {
      var rect = box.getBoundingClientRect();
      return PAD_L + (t - geom.tStart) / (geom.tEnd - geom.tStart) * (rect.width - PAD_L - PAD_R);
    }

    function onMove(ev) {
      if (!geom || points.length === 0) { hideHover(); return; }
      var rect = box.getBoundingClientRect();
      var best = nearestPoint(ev);
      if (!best) { hideHover(); return; }

      // 竖向标线对齐到该采样点的实际 X
      var cx = xOfT(best.t);
      dom["rm-cross"].hidden = false;
      dom["rm-cross"].style.left = cx + "px";

      var rows = [];
      // 悬浮明细取「趋势跟踪集合」trk，与图上画出来的线一致（含单选过滤）
      var src = (best.trk && best.trk[activeCat]) ? best.trk[activeCat] : ((best.top && best.top[activeCat]) || []);
      for (var ri = 0; ri < src.length; ri++) {
        var nm = src[ri][0];
        if (!isVisibleNow(activeCat, nm)) continue;
        rows.push([nm, src[ri][1] || 0]);
      }
      rows.sort(function (a, b) { return b[1] - a[1]; });
      rows = rows.slice(0, MAX_SERIES);

      var tip = dom["rm-tip"];
      tip.innerHTML = "";
      tip.appendChild(el("div", "rm-tip-time", fmtTime(best.t) + (pinnedT === best.t ? " · 已定格" : "")));
      if (rows.length === 0) rows.push(["(该时刻无上榜程序)", -1]);
      for (var j = 0; j < rows.length; j++) {
        var r = el("div", "rm-tip-row");
        var d2 = el("span", "rm-dot");
        d2.style.background = rows[j][1] < 0 ? "transparent" : colorOf(rows[j][0]);
        r.appendChild(d2);
        r.appendChild(el("span", "rm-tip-name", rows[j][0]));
        r.appendChild(el("span", "rm-tip-val", rows[j][1] < 0 ? "" : fmtValue(activeCat, rows[j][1])));
        tip.appendChild(r);
      }
      tip.hidden = false;
      // 定位：默认在标线右侧，靠近右边界时翻到标线左侧
      var tw = tip.offsetWidth || 160;
      var left = cx + 12;
      if (left + tw > rect.width) left = Math.max(4, cx - tw - 12);
      tip.style.left = left + "px";
      tip.style.top = "16px";
    }

    box.addEventListener("mousemove", function (ev) {
      if (panning) { hideHover(); return; } // 拖动平移时不显示悬浮框
      onMove(ev);
    });
    box.addEventListener("mouseleave", hideHover);

    /** 单击图表 → 定格该时刻（再点同一时刻 = 取消）；拖动平移过的按下不触发 */
    box.addEventListener("click", function (ev) {
      if (panning || lastDragMoved) return;   // 拖动平移过的抬起不算点击
      if (!geom) return;
      if (ev.target && ev.target.closest && ev.target.closest(".rm-zoombar")) return; // 缩放按钮不拦
      var best = nearestPoint(ev);
      if (!best) return;
      togglePin(best.t);
    });
  }

  /* ======================= 拖动平移（放大后） ======================= */

  var panning = false;
  var lastDragMoved = false;   // 上一次按下-抬起是否发生了实际拖动（用于区分「点击定格」与「拖动平移」）

  /**
   * 放大后按住拖动可平移时间窗口。
   * 拖动位移（像素）→ 时间位移：按当前窗口的「像素/毫秒」比例换算，
   * 右端反向移动（向右拖 = 看更早 = 右端变小）。
   *
   * 只要处于放大态（span < 最大档）就能拖，起点取**当前显示窗口的右端**
   * （即 geom.tEnd，可能是「贴住最新」或上一次平移的结果）。
   */
  function bindPan() {
    var box = dom["rm-chartwrap"];
    if (!box) return;
    var startX = 0, startEnd = 0, moved = false;

    box.addEventListener("mousedown", function (ev) {
      if (!geom) return;
      if (spanMs >= SPAN_STEPS[0]) return;      // 已经是最大范围，无需平移
      if (ev.button !== 0) return;
      if (ev.target && ev.target.closest && ev.target.closest(".rm-zoombar")) return; // 别拦缩放按钮
      panning = true; moved = false;
      lastDragMoved = false;
      startX = ev.clientX;
      startEnd = geom.tEnd;                       // 从当前显示的右端开始
      var rect = box.getBoundingClientRect();
      var plotW = Math.max(1, rect.width - PAD_L - PAD_R);
      var perPx = spanMs / plotW;                 // 每像素多少毫秒
      var latestT = points.length ? points[points.length - 1].t : Date.now();
      var earliest = points.length ? points[0].t : latestT - spanMs;
      var minEnd = Math.min(latestT, earliest + spanMs); // 左边界不能早于最早数据
      var maxEnd = latestT;

      function onDrag(e2) {
        if (!panning) return;
        var dx = e2.clientX - startX;
        if (Math.abs(dx) > 3) moved = true;
        var end = startEnd - dx * perPx;          // 右拖 → 看更早
        panEndT = Math.max(minEnd, Math.min(maxEnd, end));
        box.classList.add("rm-panning");
        renderChart();
      }
      function onUp() {
        panning = false;
        lastDragMoved = moved;                    // 交给随后的 click 判断：拖动过就不算「点击定格」
        box.classList.remove("rm-panning");
        window.removeEventListener("mousemove", onDrag);
        window.removeEventListener("mouseup", onUp);
      }
      window.addEventListener("mousemove", onDrag);
      window.addEventListener("mouseup", onUp);
      ev.preventDefault();
    });
  }

  /* ======================= 数据接入 ======================= */

  function ensureSorted() {
    points.sort(function (a, b) { return a.t - b.t; });
    if (points.length > 0) {
      var cutoff = points[points.length - 1].t - windowMs;
      while (points.length > 0 && points[0].t < cutoff) points.shift();
    }
    // 定格的点若已滚出保留窗口，自动解除定格（避免榜单卡在一份已不存在的快照上）
    if (pinnedT != null && !pointAt(pinnedT)) pinnedT = null;
  }

  function renderAll() {
    if (!alive()) return;
    renderCards();
    renderStatus();
    renderPinBar();
    renderChart();
    renderList();
    renderThresholds();
  }

  /** 同步后台下发的阈值到本地变量与输入框 */
  function applyThresholds(src) {
    if (!src) return;
    if (Number.isFinite(Number(src.topN))) topN = Math.trunc(Number(src.topN));
    if (Number.isFinite(Number(src.enterN))) enterN = Math.trunc(Number(src.enterN));
    if (Number.isFinite(Number(src.exitN))) exitN = Math.trunc(Number(src.exitN));
    if (Number.isFinite(Number(src.sampleMs))) sampleMs = Math.trunc(Number(src.sampleMs));
    if (Number.isFinite(Number(src.windowMs)) && Number(src.windowMs) > 0) {
      windowMs = Math.trunc(Number(src.windowMs));
      // 跨度不能超过后台实际保留窗口（否则右侧会出现空档）
      if (spanMs > windowMs) spanMs = windowMs;
    }
  }

  function loadHistory() {
    return ms.backend.call("history", null).then(function (res) {
      if (res && res.meta) applyThresholds(res.meta);
      if (res && Array.isArray(res.points)) {
        points = res.points.slice();
        ensureSorted();
      }
      renderAll();
    });
  }

  function subscribe() {
    var off = ms.backend.onNotification("tick", function (params) {
      if (!alive()) return;
      if (params && params.status) {
        status = params.status;
        applyThresholds(status);
      }
      if (params && params.point) {
        points.push(params.point);
        ensureSorted();
        renderAll();
      }
    });
    unsubs.push(off);

    var off2 = ms.backend.onNotification("status", function (params) {
      if (!alive()) return;
      status = params;
      applyThresholds(params);
      renderStatus();
    });
    unsubs.push(off2);

    var off3 = ms.backend.onNotification("cleared", function () {
      if (!alive()) return;
      points = [];
      pinnedT = null;      // 历史没了，定格自然失效
      renderAll();
    });
    unsubs.push(off3);

    // 后台改了阈值（可能来自另一个打开的窗口）→ 重新拉一次历史并重绘
    var off4 = ms.backend.onNotification("thresholds", function (params) {
      if (!alive()) return;
      applyThresholds(params);
      loadHistory();
    });
    unsubs.push(off4);
  }

  /* ======================= 持久化界面偏好 ======================= */

  function loadPrefs() {
    return Promise.all([
      ms.store.get(STORE_CAT, "cpu"),
      ms.store.get(STORE_SOLO, null)
    ]).then(function (r) {
      var cat = r[0];
      if (CATS.indexOf(cat) >= 0) activeCat = cat;
      var s = r[1];
      if (s && typeof s === "object") {
        CATS.forEach(function (c) {
          if (typeof s[c] === "string" && s[c]) solo[c] = s[c];
        });
      }
      syncTabs();
    }).catch(function () { /* 偏好读取失败不影响主流程 */ });
  }
  function saveSolo() {
    try { ms.store.set(STORE_SOLO, solo); } catch (e) { /* ignore */ }
  }
  function saveCat() {
    try { ms.store.set(STORE_CAT, activeCat); } catch (e) { /* ignore */ }
  }

  function syncTabs() {
    tabs.forEach(function (t) {
      var on = t.getAttribute("data-cat") === activeCat;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    });
  }

  /* ======================= 事件绑定 ======================= */

  function bindEvents() {
    bindHoverOnce();
    tabs.forEach(function (t) {
      t.addEventListener("click", function () {
        var c = t.getAttribute("data-cat");
        if (CATS.indexOf(c) < 0 || c === activeCat) return;
        activeCat = c;
        syncTabs();
        saveCat();
        renderAll();
      });
    });
    if (dom["rm-clear"]) {
      dom["rm-clear"].addEventListener("click", function () {
        ms.ui.confirm("清空采样历史？（后台会继续采样）").then(function (ok) {
          if (!ok) return;
          return ms.backend.call("clear", null).then(function () {
            points = [];
            pinnedT = null;
            renderAll();
          });
        }).catch(function () { /* ignore */ });
      });
    }
    if (dom["rm-export"]) {
      dom["rm-export"].addEventListener("click", onExportClick);
    }
    // 缩放：+/−/回到最新
    if (dom["rm-zin"]) dom["rm-zin"].addEventListener("click", function (ev) { ev.stopPropagation(); zoomIn(); });
    if (dom["rm-zout"]) dom["rm-zout"].addEventListener("click", function (ev) { ev.stopPropagation(); zoomOut(); });
    if (dom["rm-zreset"]) dom["rm-zreset"].addEventListener("click", function (ev) { ev.stopPropagation(); zoomReset(); });
    bindPan();
    if (dom["rm-apply"]) {
      dom["rm-apply"].addEventListener("click", onApplyThresholds);
    }
    ["rm-enter", "rm-exit"].forEach(function (id) {
      if (dom[id]) {
        dom[id].addEventListener("keydown", function (ev) {
          if (ev.key === "Enter") { ev.preventDefault(); onApplyThresholds(); }
        });
      }
    });
    var reflow = null;
    window.addEventListener("resize", function () {
      if (reflow) clearTimeout(reflow);
      reflow = setTimeout(function () { if (alive()) renderChart(); }, 120);
    });
    // Esc：清除定格，回到最新
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && pinnedT != null) clearPin();
    });
    // 主题切换：颜色走 CSS 变量会自动跟随；这里只需重画画布尺寸无关的内容
    var offTheme = ms.ui.onThemeChanged && ms.ui.onThemeChanged(function () { if (alive()) renderAll(); });
    if (offTheme) unsubs.push(offTheme);
  }

  /* ======================= 阈值设置 ======================= */

  /** 把当前阈值写回输入框（后台可能改过） */
  function renderThresholds() {
    if (dom["rm-enter"] && !isEditing(dom["rm-enter"])) dom["rm-enter"].value = String(enterN);
    if (dom["rm-exit"] && !isEditing(dom["rm-exit"])) dom["rm-exit"].value = String(exitN);
    if (dom["rm-cfg-hint"]) {
      dom["rm-cfg-hint"].textContent = "进圈看 " + enterN + " 名；掉到 " + exitN + " 名之外才移出趋势图";
    }
  }
  function isEditing(input) { return document.activeElement === input; }

  function onApplyThresholds() {
    var en = parseInt(dom["rm-enter"] ? dom["rm-enter"].value : "", 10);
    var ex = parseInt(dom["rm-exit"] ? dom["rm-exit"].value : "", 10);
    if (!Number.isFinite(en) || en < 1) { ms.ui.toast("「进圈」需 ≥ 1", "error"); return; }
    if (!Number.isFinite(ex) || ex < 1) { ms.ui.toast("「出圈」需 ≥ 1", "error"); return; }
    if (ex < en) { ms.ui.toast("「出圈」不能小于「进圈」", "error"); return; }
    ms.backend.call("setThresholds", { enterN: en, exitN: ex, topN: en }).then(function (r) {
      applyThresholds(r);
      ms.ui.toast("已应用：进圈 " + r.enterN + " / 出圈 " + r.exitN);
      // 后台会广播 thresholds → 另一窗口；本窗口直接重拉历史
      return loadHistory();
    }).catch(function (e) {
      ms.ui.toast("应用失败：" + (e && e.message ? e.message : e), "error");
    });
  }

  /* ======================= 导出 CSV ======================= */

  /**
   * 导出：向后台要 CSV 文本，再用浏览器下载（前端插件没有任意路径写权限，
   * 因此走 Blob + <a download>，落到系统的下载目录）。
   */
  function onExportClick() {
    ms.ui.confirm("导出当前保留窗口（最近 35 分钟）的数据为 CSV？\n（三张表：Top 榜长表 / 系统级长表 / 趋势跟踪长表，共 3 个文件）").then(function (ok) {
      if (!ok) return;
      var kinds = ["top", "system", "tracked"];
      var labels = { top: "Top 榜", system: "系统指标", tracked: "趋势跟踪" };
      // 串行下载，避免浏览器把多个下载拦成「多文件」询问
      return kinds.reduce(function (chain, kind) {
        return chain.then(function () {
          return ms.backend.call("exportCsv", { kind: kind, minutes: Math.round(windowMs / 60000) }).then(function (r) {
            if (!r || !r.csv) throw new Error("导出为空");
            downloadText(r.filename, r.csv);
            return true;
          });
        });
      }, Promise.resolve()).then(function () {
        ms.ui.toast("已导出 3 个 CSV 文件（" + kinds.map(function (k) { return labels[k]; }).join(" / ") + "）");
      });
    }).catch(function (e) {
      ms.ui.toast("导出失败：" + (e && e.message ? e.message : e), "error");
    });
  }

  function downloadText(filename, text) {
    var blob = new Blob(["\uFEFF" + text.replace(/^\uFEFF/, "")], { type: "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename || "resource.csv";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      try { document.body.removeChild(a); } catch (e) { /* ignore */ }
      URL.revokeObjectURL(url);
    }, 0);
  }

  /* ======================= 启动 ======================= */

  function boot() {
    bindEvents();
    loadPrefs().then(function () {
      subscribe();
      return loadHistory();
    }).catch(function (e) {
      ms.log("error", "初始化失败: " + (e && e.message ? e.message : e));
      dom["rm-status"].textContent = "后台连接失败：" + (e && e.message ? e.message : e);
      dom["rm-status"].classList.add("warn");
    });
  }

  // 视图销毁（exit 关闭）时清理监听；保活（minimize）时不触发
  window.addEventListener("beforeunload", function () {
    unsubs.forEach(function (f) { try { f && f(); } catch (e) { /* ignore */ } });
    unsubs = [];
  });

  boot();

  // 末尾回传注入值（既拿到宿主 API，又让本文件能被当普通 <script> 加载）
})(
  typeof ms !== "undefined" ? ms : window.ms,
  typeof env !== "undefined" ? env : undefined,
  typeof plugin !== "undefined" ? plugin : undefined,
  typeof host !== "undefined" ? host : undefined,
  typeof keyword !== "undefined" ? keyword : "",
  typeof inputValue !== "undefined" ? inputValue : "",
  typeof onSubKeyword !== "undefined" ? onSubKeyword : undefined,
  typeof md2html !== "undefined" ? md2html : undefined,
  typeof openExternal !== "undefined" ? openExternal : undefined
);
