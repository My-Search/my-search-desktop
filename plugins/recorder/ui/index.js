/**
 * 录屏与水印插件 - 前台入口脚本
 *
 * 宿主注入参数: ms, env, plugin, host, keyword, inputValue, onSubKeyword, md2html, openExternal
 * （宿主用 `new Function("ms","env","plugin","host",...,code)` 调用本文件，
 *  所以下面 IIFE 的形参声明 + 末尾实参回传是必需的：既拿到注入值，
 *  又让本文件能被当普通 <script> 直接加载调试。）
 *
 * ============================ 这个插件做了什么 ============================
 *
 * 三件事，重活全在后端（ffmpeg）：
 *
 *   1) **录屏**：收集区域/帧率/编码器 → `ms.backend.call("startRecord")`
 *      → 后端拉 gdigrab 录制；录制中由后端每 500ms 推 `record:tick` 通知，
 *      界面计时器与之对齐（不自己算，避免两处口径不一致）。
 *
 *   2) **给已有视频加水印**：拖文件/填路径 → `detectVideo` 读元数据
 *      → 配置水印 → `applyWatermark` 转码，后端推 `watermark:progress`。
 *
 *   3) **水印编辑**：文字/图片、九宫格定位、字号/透明度/描边/时间戳，
 *      带 canvas 实时预览；可存成预设（`ms.store`）。
 *
 * ============================ 为什么没有浏览器录屏 ============================
 *
 * 宿主 WebView 没有 `getDisplayMedia`（见宿主 screenshot.rs 注释），
 * 插件视图也拿不到整屏像素，所以录屏只能靠外部 ffmpeg。代价是需要用户
 * 自己装 ffmpeg——界面顶部有明确的安装引导与「手动指定路径」入口。
 *
 * ============================ 数据放在哪 ============================
 *
 * 视频：`<app_data>/plugin-data/com.mysearch.recorder/recordings/*.mp4`
 *   —— 后端写、后端读，路径由后端拼（插件只能给相对名，杜绝目录穿越）。
 * 界面偏好与水印预设：`ms.store`（localStorage，按插件 id 命名空间隔离）。
 */
(function (ms, env, plugin, host, keyword, inputValue, onSubKeyword, md2html, openExternal) {
  "use strict";

  /* ======================= 常量 ======================= */

  var STORE_WM = "watermark.default";     // 「加水印」页的当前水印
  var STORE_WM_REC = "watermark.record";  // 「录屏」页的当前水印
  var STORE_PRESETS = "watermark.presets";// 命名预设列表
  var STORE_PREFS = "prefs";              // 帧率/编码器等

  /** 与后端 watermark.mjs 的 DEFAULT_WATERMARK 保持同构 */
  var DEFAULT_WM = {
    enabled: true,
    type: "text",
    text: "我的搜索",
    imagePath: "",
    fontFile: "",
    sizePct: 4,
    color: "#FFFFFF",
    opacity: 0.6,
    border: true,
    borderColor: "#000000",
    anchor: "bottom-right",
    marginPct: 2,
    timestamp: false
  };

  var ANCHORS = [
    "top-left", "top-center", "top-right",
    "middle-left", "center", "middle-right",
    "bottom-left", "bottom-center", "bottom-right"
  ];

  /* ======================= DOM ======================= */

  var dom = {};
  [
    "rc-ffbar", "rc-ffdot", "rc-fftext", "rc-fffix", "rc-ffdl",
    "rc-dl", "rc-dl-fill", "rc-dl-text",
    "rc-status",
    "rc-pane-rec", "rc-pane-wm", "rc-pane-lib", "rc-pane-set",
    "rc-rec-btn", "rc-rec-timer", "rc-rec-pause", "rc-rec-info",
    "rc-region-mode", "rc-region-box", "rc-region-x", "rc-region-y", "rc-region-w", "rc-region-h",
    "rc-region-pick", "rc-region-frame",
    "rc-pick", "rc-pick-hint", "rc-pick-stage", "rc-pick-img", "rc-pick-rect", "rc-pick-size", "rc-pick-ok",
    "rc-fps", "rc-encoder", "rc-draw-mouse", "rc-rec-wm-on", "rc-rec-wm-editor",
    "rc-drop", "rc-wm-input", "rc-video-meta", "rc-wm-on", "rc-wm-editor",
    "rc-wm-apply", "rc-wm-cancel", "rc-wm-progress", "rc-wm-progress-fill", "rc-wm-progress-text",
    "rc-lib-count", "rc-lib-grid", "rc-lib-empty",
    "rc-set-ffpath", "rc-set-ffinfo", "rc-set-capture", "rc-set-outdir", "rc-set-bindir",
    "rc-set-dl", "rc-set-dlrm", "rc-set-bundled", "rc-set-sources",
    "rc-preset-name", "rc-preset-list"
  ].forEach(function (id) {
    dom[id] = document.getElementById(id);
  });
  /** 本实例根节点：会话被宿主「保活」后旧实例仍在内存里，靠它判活（别打扰新实例） */
  var rootEl = document.getElementById("app");

  /* ======================= 状态 ======================= */

  var caps = null;              // 后端 capabilities 结果
  /** 能力是否已探测完（boot 走完 loadCapabilities）。快捷键动作早到时据此排队 */
  var capsReady = false;
  var recordingActive = false;
  var paused = false;
  var tickTimer = null;         // 本地计时兜底（后端 tick 未到时不让秒针停住）
  var tickBase = null;          // { elapsedMs, at } 本地推算基准
  var transcoding = false;
  var downloading = false;      // 正在下载自带 ffmpeg
  var currentVideo = null;      // detectVideo 结果
  var wmEditors = {};           // { rec: Editor, wm: Editor }
  var unsubs = [];
  /** 区域框选浮层的运行态：{ originX, originY, width, height, natW, natH } */
  var pickState = null;
  /** 框选中的拖拽矩形（画布 CSS 像素） */
  var pickDrag = null;
  /** 后端在录制中途推来的提示（如「ddagrab 回退 GDI」），随每拍 info 一起显示 */
  var tickNote = null;

  /** 判定本实例是否还「活着」：宿主保活后旧实例仍在内存，别去动新实例的 DOM */
  function alive() {
    return !rootEl || document.body.contains(rootEl);
  }

  /* ======================= 小工具 ======================= */

  function setStatus(text, kind) {
    var el = dom["rc-status"];
    if (!el) return;
    if (!text) {
      el.textContent = "";
      el.hidden = true;
      el.className = "rc-status";
      return;
    }
    el.textContent = text;
    el.hidden = false;
    el.className = "rc-status" + (kind === "error" ? " error" : kind === "ok" ? " ok" : "");
  }

  function toast(text, kind) {
    try {
      ms.ui.toast(text, kind === "error" ? "error" : "info");
    } catch (e) {
      /* 权限未授予时降级为状态行 */
      setStatus(text, kind);
    }
  }

  function fmtDuration(ms) {
    var t = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return p(Math.floor(t / 3600)) + ":" + p(Math.floor((t % 3600) / 60)) + ":" + p(t % 60);
  }

  function fmtSize(bytes) {
    var b = Number(bytes) || 0;
    if (b < 1024) return b + " B";
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
    if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + " MB";
    return (b / 1024 / 1024 / 1024).toFixed(2) + " GB";
  }

  function fmtTime(ms) {
    var d = new Date(Number(ms) || 0);
    if (isNaN(d.getTime())) return "";
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  /** ms.store.get 是同步的（宿主约定） */
  function storeGet(key, fallback) {
    try {
      var v = ms.store.get(key, fallback);
      return v === undefined || v === null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function storeSet(key, value) {
    try {
      return ms.store.set(key, value);
    } catch (e) {
      return null;
    }
  }

  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  function $(sel, ctx) {
    return (ctx || document).querySelector(sel);
  }

  /** 提示信息里的错误 → 统一文案 */
  function errText(e) {
    var m = (e && e.message) || String(e || "未知错误");
    return m.replace(/^\[FFMPEG_NOT_FOUND\]\s*/, "");
  }

  /* ======================= 后端调用封装 ======================= */

  function call(method, params) {
    return ms.backend.call(method, params || {});
  }

  /* ======================= 水印编辑器 ======================= */

  /**
   * 把一个 <template id="rc-wm-template"> 渲染进容器，并与数据双向绑定。
   * 录屏页和加水印页各一个实例，互不干扰（各自独立的 spec）。
   */
  function createEditor(container, initial, opts) {
    if (!container) return null;
    var tpl = document.getElementById("rc-wm-template");
    var node = tpl.content.firstElementChild.cloneNode(true);
    container.innerHTML = "";
    container.appendChild(node);

    var spec = Object.assign({}, DEFAULT_WM, initial || {});
    var onChange = (opts && opts.onChange) || function () {};

    /** 表单控件 ← spec */
    function fill() {
      node.querySelectorAll("[data-wm]").forEach(function (el) {
        var k = el.getAttribute("data-wm");
        var v = spec[k];
        if (el.type === "checkbox") el.checked = !!v;
        else el.value = v == null ? "" : v;
      });
      updateOuts();
      syncTypeVisibility();
      drawPreview();
    }

    /** 滑块的数值展示 */
    function updateOuts() {
      node.querySelectorAll("[data-wm-out]").forEach(function (el) {
        var k = el.getAttribute("data-wm-out");
        var v = spec[k];
        if (k === "marginPct" || k === "sizePct") el.textContent = v + "%";
        else if (k === "opacity") el.textContent = Math.round(v * 100) + "%";
        else el.textContent = v;
      });
    }

    function syncTypeVisibility() {
      $(".rc-wm-text", node).hidden = spec.type === "image";
      $(".rc-wm-image", node).hidden = spec.type !== "image";
    }

    /** canvas 实时预览：位置/字号口径必须与后端 ffmpeg 表达式一致 */
    function drawPreview() {
      var cv = $(".rc-preview-canvas", node);
      if (!cv) return;
      var ctx = cv.getContext("2d");
      var W = cv.width, H = cv.height;
      // 模拟「深色视频画面」，否则白字在白底上看不见
      var g = ctx.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, "#2b2f36");
      g.addColorStop(1, "#4a5058");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);

      if (!spec.enabled) {
        ctx.fillStyle = "rgba(255,255,255,0.35)";
        ctx.font = "12px sans-serif";
        ctx.fillText("水印已关闭", 8, H - 8);
        return;
      }

      var margin = (spec.marginPct / 100) * H;
      var fontPx = Math.max(8, Math.round(H * (spec.sizePct / 100)));
      ctx.globalAlpha = spec.opacity;

      if (spec.type === "image") {
        // 图片水印在预览里用占位方块表示（避免异步加载图片）
        var bw = Math.max(24, W * (spec.sizePct / 100) * 2);
        var bh = bw * 0.6;
        var pos = anchorXY(spec.anchor, W, H, bw, bh, margin);
        ctx.strokeStyle = spec.color;
        ctx.lineWidth = 1;
        ctx.strokeRect(pos.x, pos.y, bw, bh);
        ctx.fillStyle = spec.color;
        ctx.font = "10px sans-serif";
        ctx.textBaseline = "top";
        ctx.fillText("LOGO", pos.x + 4, pos.y + 4);
        ctx.globalAlpha = 1;
        return;
      }

      var text = spec.timestamp
        ? (spec.text || "") + " 00:12:34"
        : (spec.text || "（水印文字）");
      ctx.font = fontPx + "px sans-serif";
      ctx.textBaseline = "alphabetic";
      var tw = ctx.measureText(text).width;
      var pos2 = anchorXY(spec.anchor, W, H, tw, fontPx, margin);

      if (spec.border) {
        ctx.lineWidth = Math.max(1, fontPx / 14);
        ctx.strokeStyle = spec.borderColor;
        ctx.strokeText(text, pos2.x, pos2.y + fontPx * 0.8);
      }
      ctx.fillStyle = spec.color;
      ctx.fillText(text, pos2.x, pos2.y + fontPx * 0.8);
      ctx.globalAlpha = 1;
    }

    /** 九宫格定位（与后端 watermark.mjs 的 previewBox 同口径） */
    function anchorXY(anchor, W, H, bw, bh, margin) {
      var a = ANCHORS.indexOf(anchor) >= 0 ? anchor : "bottom-right";
      var vertical = a === "center" ? "middle" : a.split("-")[0];
      var horizontal = a === "center" ? "center" : a.split("-")[1];
      var x = horizontal === "left" ? margin
        : horizontal === "center" ? (W - bw) / 2
        : W - bw - margin;
      var y = vertical === "top" ? margin
        : vertical === "middle" ? (H - bh) / 2
        : H - bh - margin;
      return { x: x, y: y };
    }

    /** 控件 → spec */
    node.addEventListener("input", function (ev) {
      var el = ev.target;
      var k = el.getAttribute && el.getAttribute("data-wm");
      if (!k) return;
      if (el.type === "checkbox") spec[k] = el.checked;
      else if (el.type === "range" || el.type === "number") spec[k] = Number(el.value);
      else spec[k] = el.value;
      updateOuts();
      if (k === "type") syncTypeVisibility();
      drawPreview();
      onChange(getSpec());
    });

    node.addEventListener("change", function (ev) {
      var el = ev.target;
      var k = el.getAttribute && el.getAttribute("data-wm");
      if (!k) return;
      if (el.type === "checkbox") spec[k] = el.checked;
      else spec[k] = el.value;
      updateOuts();
      if (k === "type") syncTypeVisibility();
      drawPreview();
      onChange(getSpec());
    });

    function getSpec() {
      return clone(spec);
    }
    function setSpec(next) {
      spec = Object.assign({}, DEFAULT_WM, next || {});
      fill();
    }
    function setEnabled(v) {
      spec.enabled = !!v;
      fill();
    }

    fill();
    return { node: node, getSpec: getSpec, setSpec: setSpec, setEnabled: setEnabled, drawPreview: drawPreview };
  }

  /* ======================= 页签切换 ======================= */

  function activateTab(name) {
    document.querySelectorAll(".rc-tab").forEach(function (b) {
      var on = b.getAttribute("data-tab") === name;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    ["rec", "wm", "lib", "set"].forEach(function (n) {
      var pane = dom["rc-pane-" + n];
      if (pane) pane.hidden = n !== name;
    });
    if (name === "lib") refreshLibrary();
    if (name === "set") renderSettings();
    if (wmEditors[name] && wmEditors[name].drawPreview) wmEditors[name].drawPreview();
  }

  /* ======================= ffmpeg 状态条 ======================= */

  function renderFfStatus() {
    var ff = (caps && caps.ffmpeg) || {};
    if (ff.found) {
      // 状态条只留「已就绪」四个字；版本与完整路径挪到悬停 title，别撑爆一行
      dom["rc-ffdot"].className = "rc-dot on";
      dom["rc-fftext"].textContent = "ffmpeg 已就绪";
      dom["rc-fftext"].title = "ffmpeg 已就绪" + (ff.version ? "（v" + ff.version + "）" : "") + "：" + (ff.path || "");
      if (dom["rc-fffix"]) dom["rc-fffix"].hidden = true;
      if (dom["rc-ffdl"]) dom["rc-ffdl"].hidden = true;
    } else {
      dom["rc-ffdot"].className = "rc-dot off";
      var needTxt = ff.download && ff.download.needText;
      dom["rc-fftext"].textContent = "尚未准备好 ffmpeg —— 点「一键下载」由插件自带" +
        (needTxt ? "（约 " + needTxt + "）" : "") + "，或手动指定已安装的路径";
      dom["rc-fftext"].title = "";
      if (dom["rc-fffix"]) dom["rc-fffix"].hidden = false;
      if (dom["rc-ffdl"]) dom["rc-ffdl"].hidden = !canDownload();
    }
  }

  /** 是否可下载（有可用源且当前没在下载） */
  function canDownload() {
    var dl = caps && caps.ffmpeg && caps.ffmpeg.download;
    if (!dl || !dl.sources || !dl.sources.length) return false;
    return !downloading && !dl.inProgress;
  }

  /* ======================= 一键下载 ffmpeg ======================= */

  function setDownloadProgress(pct, text) {
    if (dom["rc-dl-fill"]) dom["rc-dl-fill"].style.width = Math.max(0, Math.min(100, Number(pct) || 0)).toFixed(1) + "%";
    if (dom["rc-dl-text"]) dom["rc-dl-text"].textContent = text || "";
  }

  async function downloadFfmpeg() {
    if (downloading) return;
    if (!canDownload()) {
      toast("当前没有可用的下载源", "error");
      return;
    }
    downloading = true;
    dom["rc-dl"].hidden = false;
    setDownloadProgress(0, "准备下载…");
    if (dom["rc-ffdl"]) dom["rc-ffdl"].disabled = true;
    if (dom["rc-set-dl"]) dom["rc-set-dl"].disabled = true;

    try {
      var r = await call("downloadFfmpeg", {});
      downloading = false;
      dom["rc-dl"].hidden = true;
      await loadCapabilities(false);
      if (r && r.ok) {
        toast("ffmpeg 已就绪" + (r.version ? "（v" + r.version + "）" : ""));
        setStatus("ffmpeg 下载完成：" + r.path, "ok");
      } else {
        setStatus("下载完成但未能启用，请到「设置」手动指定路径", "error");
      }
      renderSettings();
    } catch (e) {
      downloading = false;
      dom["rc-dl"].hidden = true;
      // 预检错误（如磁盘不足）自带完整指引，再追加「手动指定」就重复了
      var msg = errText(e);
      var selfExplained = /手动指定/.test(msg);
      setStatus("下载失败：" + msg + (selfExplained ? "" : "。你也可以在「设置」里手动指定已安装的 ffmpeg 路径。"), "error");
      toast(selfExplained && /磁盘空间不足/.test(msg) ? "磁盘空间不足" : "下载失败", "error");
    } finally {
      if (dom["rc-ffdl"]) dom["rc-ffdl"].disabled = false;
      if (dom["rc-set-dl"]) dom["rc-set-dl"].disabled = false;
    }
  }

  async function removeBundledFfmpeg() {
    try {
      var r = await call("removeBundledFfmpeg", {});
      if (!r || !r.ok) {
        setStatus("删除失败：" + ((r && r.error) || "未知原因"), "error");
        return;
      }
      await loadCapabilities(false);
      renderSettings();
      toast("已删除自带副本");
    } catch (e) {
      setStatus("删除失败：" + errText(e), "error");
    }
  }

  /* ======================= 录屏 ======================= */

  function collectRegion() {
    if (dom["rc-region-mode"].value !== "custom") return null;
    return {
      x: Number(dom["rc-region-x"].value) || 0,
      y: Number(dom["rc-region-y"].value) || 0,
      width: Number(dom["rc-region-w"].value) || 0,
      height: Number(dom["rc-region-h"].value) || 0
    };
  }

  /* ---------- 区域偏好：坐标、模式、边框开关（跨会话记住） ---------- */

  function readRegionPrefs() {
    var p = storeGet(STORE_PREFS, {});
    return p && typeof p === "object" ? p : {};
  }

  function persistRegionPrefs() {
    var p = Object.assign({}, readRegionPrefs(), {
      regionMode: dom["rc-region-mode"].value,
      region: {
        x: Number(dom["rc-region-x"].value) || 0,
        y: Number(dom["rc-region-y"].value) || 0,
        width: Number(dom["rc-region-w"].value) || 0,
        height: Number(dom["rc-region-h"].value) || 0
      },
      showRegionFrame: dom["rc-region-frame"].checked !== false
    });
    storeSet(STORE_PREFS, p);
  }

  function restoreRegionPrefs() {
    var p = readRegionPrefs();
    if (p.regionMode === "custom" || p.regionMode === "full") {
      dom["rc-region-mode"].value = p.regionMode;
    }
    if (p.region && typeof p.region === "object") {
      if (p.region.x != null) dom["rc-region-x"].value = String(p.region.x);
      if (p.region.y != null) dom["rc-region-y"].value = String(p.region.y);
      if (p.region.width != null) dom["rc-region-w"].value = String(p.region.width);
      if (p.region.height != null) dom["rc-region-h"].value = String(p.region.height);
    }
    if (typeof p.showRegionFrame === "boolean") dom["rc-region-frame"].checked = p.showRegionFrame;
    dom["rc-region-box"].hidden = dom["rc-region-mode"].value !== "custom";
  }

  /* ======================= 区域框选（屏幕直接框选 / 面板内截图） ======================= */

  var pickStageBound = false;

  /**
   * 框选录制区域：直接在**全屏遮罩上拖**（宿主的 `ms.screenshot.pickRegion`，
   * 与截图热键同一套交互——松手即得坐标、遮罩自动关闭）。
   *
   * 不再静默退回「面板里那张缩略截图」：那条路要先把桌面压成一张图塞进小
   * 弹窗里拖着选，既糊又反直觉。屏幕直接框不可用时（缺 screenshot.overlay
   * 权限、或宿主没带这个命令），给一条**说清楚缺什么**的报错，让用户去补；
   * 只有在他明确同意时才开面板兜底。
   */
  async function openRegionPicker() {
    if (recordingActive) {
      toast("录制中不能重新框选区域", "error");
      return;
    }
    var err = null;
    try {
      if (!ms || !ms.screenshot || typeof ms.screenshot.pickRegion !== "function") {
        throw new Error("当前宿主版本不支持屏幕框选");
      }
      var rect = await ms.screenshot.pickRegion();
      if (!rect) return; // 用户按 Esc 取消：什么都不动
      if (!applyRegionRect(rect)) {
        toast("选中的区域太小了（至少 16 × 16），请重新框选", "error");
      }
      return;
    } catch (e) {
      err = e;
    }
    // 到这里 = 屏幕直接框失败。问用户要不要退而用面板截图框选，而不是默认就走。
    var msg = pickFailHint(err);
    setStatus("屏幕框选不可用：" + msg, "error");
    var usePanel = false;
    try {
      usePanel = await ms.ui.confirm("屏幕直接框选不可用（" + msg + "）。\n\n改用在弹窗里对着桌面截图拖选？");
    } catch (e) {
      usePanel = false; // 没弹成 confirm 就别自作主张
    }
    if (usePanel) openPanelPicker();
  }

  /** 把 pickRegion 的失败原因翻成「用户下一步能照做」的中文 */
  function pickFailHint(e) {
    var m = errText(e);
    if (/缺少权限|permission|screenshot\.overlay/i.test(m)) {
      return "需要「全屏框选遮罩」权限，请到 设置→插件→录屏与水印→权限 里勾选「全屏框选遮罩」";
    }
    if (/不支持屏幕框选|当前版本/i.test(m)) {
      return "宿主未带屏幕框选命令，请重启应用（或更新到最新版）后重试";
    }
    return m;
  }

  /**
   * 把一个矩形（虚拟桌面**物理**像素）写进区域输入框并记住偏好。
   * 尺寸小于 16×16 视为误操作，返回 false 由调用方给提示。
   */
  function applyRegionRect(rect) {
    var x = Math.max(0, Math.round(Number(rect.x) || 0));
    var y = Math.max(0, Math.round(Number(rect.y) || 0));
    var w = Math.round(Number(rect.width) || 0);
    var h = Math.round(Number(rect.height) || 0);
    if (w < 16 || h < 16) return false;
    dom["rc-region-mode"].value = "custom";
    dom["rc-region-box"].hidden = false;
    dom["rc-region-x"].value = String(x);
    dom["rc-region-y"].value = String(y);
    dom["rc-region-w"].value = String(w);
    dom["rc-region-h"].value = String(h);
    persistRegionPrefs();
    toast("已设置录制区域：" + w + " × " + h);
    return true;
  }

  /**
   * 兜底路径：面板内框选。后端抓一张整虚拟桌面的冻结截图（物理坐标，与
   * gdigrab/ddagrab 同一坐标空间），用户在图上拖出录制矩形，这里再按
   * 「图上像素 → 物理屏幕像素」换算回真实坐标。
   */
  async function openPanelPicker() {
    var box = dom["rc-pick"];
    if (!box) return;
    box.hidden = false;
    pickState = null;
    pickDrag = null;
    dom["rc-pick-hint"].textContent = "正在截取当前桌面…";
    dom["rc-pick-ok"].disabled = true;
    dom["rc-pick-rect"].hidden = true;
    dom["rc-pick-size"].textContent = "按住鼠标在图上拖出要录的区域";
    bindPickStage();
    try {
      var snap = await call("screenSnapshot", {});
      if (!alive() || box.hidden) return;
      if (!snap || !snap.dataUrl) throw new Error("截图结果为空");
      dom["rc-pick-img"].src = snap.dataUrl;
      pickState = {
        originX: Number(snap.originX) || 0,
        originY: Number(snap.originY) || 0,
        width: Number(snap.width) || 0,
        height: Number(snap.height) || 0
      };
      dom["rc-pick-hint"].textContent = "这是一张冻结的桌面截图（含当前窗口），在图上按住拖动即可";
    } catch (e) {
      closeRegionPicker();
      toast("截图失败：" + errText(e), "error");
    }
  }

  function closeRegionPicker() {
    var box = dom["rc-pick"];
    if (box) box.hidden = true;
    pickState = null;
    pickDrag = null;
    try {
      if (dom["rc-pick-img"]) dom["rc-pick-img"].removeAttribute("src");
    } catch (e) { /* 忽略 */ }
  }

  function bindPickStage() {
    if (pickStageBound) return;
    var stage = dom["rc-pick-stage"];
    if (!stage) return;
    pickStageBound = true;

    function stagePos(ev) {
      var img = dom["rc-pick-img"];
      var r = img.getBoundingClientRect();
      return {
        x: Math.min(Math.max(ev.clientX - r.left, 0), r.width),
        y: Math.min(Math.max(ev.clientY - r.top, 0), r.height)
      };
    }

    stage.addEventListener("mousedown", function (ev) {
      if (!pickState || ev.button !== 0) return;
      var p = stagePos(ev);
      pickDrag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      ev.preventDefault();
    });
    stage.addEventListener("mousemove", function (ev) {
      if (!pickDrag) return;
      var p = stagePos(ev);
      pickDrag.x1 = p.x;
      pickDrag.y1 = p.y;
      updatePickRect();
    });
    // 在浮层任意处松手都算结束（鼠标移出图片才松开也不会卡住）
    document.addEventListener("mouseup", function (ev) {
      if (!pickDrag) return;
      var p = stagePos(ev); // 已按图片边界钳制
      pickDrag.x1 = p.x;
      pickDrag.y1 = p.y;
      updatePickRect();
      pickDrag = null;
    });
  }

  /** 画框 + 更新「使用该区域」按钮与尺寸文案 */
  function updatePickRect() {
    var rect = dom["rc-pick-rect"];
    if (!rect || !pickDrag) return;
    var l = Math.min(pickDrag.x0, pickDrag.x1);
    var t = Math.min(pickDrag.y0, pickDrag.y1);
    var w = Math.abs(pickDrag.x1 - pickDrag.x0);
    var h = Math.abs(pickDrag.y1 - pickDrag.y0);
    rect.style.left = l + "px";
    rect.style.top = t + "px";
    rect.style.width = w + "px";
    rect.style.height = h + "px";
    rect.hidden = w < 2 || h < 2;

    var scr = pickRectToScreen(l, t, w, h);
    if (!scr) return;
    dom["rc-pick-size"].textContent = scr.width + " × " + scr.height + " px" +
      "（" + scr.x + ", " + scr.y + "）";
    dom["rc-pick-ok"].disabled = !(scr.width >= 16 && scr.height >= 16);
  }

  /**
   * 图上 CSS 像素矩形 → 物理屏幕矩形。
   * 换算用截图的天然尺寸（naturalWidth）而非显示尺寸，缩放显示不影响精度。
   */
  function pickRectToScreen(l, t, w, h) {
    var img = dom["rc-pick-img"];
    if (!pickState || !img || !img.naturalWidth || !img.naturalHeight) return null;
    var kx = pickState.width / img.naturalWidth;
    var ky = pickState.height / img.naturalHeight;
    var x = pickState.originX + Math.round(l * kx);
    var y = pickState.originY + Math.round(t * ky);
    return {
      x: Math.max(0, x),
      y: Math.max(0, y),
      width: Math.round(w * kx),
      height: Math.round(h * ky)
    };
  }

  /** 把面板内框选的结果写回区域输入框并记住偏好 */
  function applyPickedRegion() {
    var rect = dom["rc-pick-rect"];
    if (!rect || rect.hidden) return;
    var l = parseFloat(rect.style.left) || 0;
    var t = parseFloat(rect.style.top) || 0;
    var w = parseFloat(rect.style.width) || 0;
    var h = parseFloat(rect.style.height) || 0;
    var scr = pickRectToScreen(l, t, w, h);
    if (!scr || !applyRegionRect(scr)) {
      toast("区域太小了，至少 16 × 16 像素", "error");
      return;
    }
    closeRegionPicker();
  }

  async function startRecording() {
    if (!caps || !caps.ffmpeg || !caps.ffmpeg.found) {
      toast("请先下载或指定 ffmpeg", "error");
      setStatus("尚未准备好 ffmpeg：可在顶部点「一键下载」，或在「设置」页手动指定路径。", "error");
      activateTab("set");
      return;
    }
    var region = collectRegion();
    if (dom["rc-region-mode"].value === "custom" && (!region || region.width <= 0 || region.height <= 0)) {
      toast("自定义区域的宽高必须大于 0", "error");
      return;
    }

    var r = null;
    try {
      r = await call("startRecord", {
        region: region,
        fps: Number(dom["rc-fps"].value) || 30,
        encoder: dom["rc-encoder"].value,
        drawMouse: dom["rc-draw-mouse"].checked,
        showRegionFrame: dom["rc-region-frame"].checked !== false,
        watermark: dom["rc-rec-wm-on"].checked && wmEditors.rec ? wmEditors.rec.getSpec() : { enabled: false }
      });
    } catch (e) {
      setStatus("启动录制失败：" + errText(e), "error");
      return;
    }
    persistRegionPrefs();

    recordingActive = true;
    paused = false;
    tickNote = null;
    dom["rc-rec-btn"].textContent = "停止录制";
    dom["rc-rec-btn"].classList.add("recording");
    dom["rc-rec-pause"].disabled = false;
    dom["rc-rec-pause"].textContent = "暂停";
    dom["rc-rec-info"].textContent = "录制中…" + (r && r.notes && r.notes.length ? "（" + r.notes.join("；") + "）" : "");
    setStatus("");
    tickBase = { elapsedMs: 0, at: Date.now() };
    startLocalTick();
  }

  async function stopRecording() {
    dom["rc-rec-btn"].disabled = true;
    try {
      await call("stopRecord", {});
      setStatus("正在收尾（等待 ffmpeg 写完文件头）…");
    } catch (e) {
      setStatus("停止失败：" + errText(e), "error");
    }
  }

  async function togglePause() {
    if (!recordingActive) return;
    try {
      var r = await call("pauseRecord", { paused: !paused });
      paused = !!r.paused;
      dom["rc-rec-pause"].textContent = paused ? "继续" : "暂停";
      tickBase = { elapsedMs: paused ? tickBase.elapsedMs : tickBase.elapsedMs, at: Date.now() };
    } catch (e) {
      setStatus("暂停失败：" + errText(e), "error");
    }
  }

  /** 本地计时兜底：后端 tick 是权威，但在它到达之前先让秒针动起来 */
  function startLocalTick() {
    stopLocalTick();
    tickTimer = setInterval(function () {
      if (!recordingActive || paused) return;
      var base = tickBase || { elapsedMs: 0, at: Date.now() };
      dom["rc-rec-timer"].textContent = fmtDuration(base.elapsedMs + (Date.now() - base.at));
    }, 200);
  }

  function stopLocalTick() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
  }

  function onRecordEnded(p) {
    recordingActive = false;
    paused = false;
    if (dom["rc-rec-btn"]) {
      dom["rc-rec-btn"].disabled = false;
      dom["rc-rec-btn"].textContent = "开始录制";
      dom["rc-rec-btn"].classList.remove("recording");
      dom["rc-rec-pause"].disabled = true;
      dom["rc-rec-pause"].textContent = "暂停";
    }
    stopLocalTick();
    if (!alive()) return;
    if (p && p.ok) {
      dom["rc-rec-timer"].textContent = fmtDuration(p.durationMs || 0);
      dom["rc-rec-info"].textContent = "已保存：" + p.output + "（" + fmtSize(p.size) + "）";
      setStatus("录制完成：" + p.output, "ok");
      toast("录制完成");
      refreshLibrary();
    } else {
      dom["rc-rec-info"].textContent = "未生成文件";
      setStatus("录制失败：" + ((p && p.error) || "未知原因"), "error");
      toast("录制失败", "error");
    }
  }

  /* ======================= 加水印 ======================= */

  async function detectVideo(path) {
    var p = String(path || dom["rc-wm-input"].value || "").trim();
    if (!p) {
      toast("请先填写或拖入视频文件路径", "error");
      return;
    }
    dom["rc-wm-input"].value = p;
    setStatus("正在读取视频信息…");
    try {
      var info = await call("detectVideo", { input: p });
      currentVideo = info;
      renderVideoMeta(info);
      setStatus("");
    } catch (e) {
      currentVideo = null;
      dom["rc-video-meta"].hidden = true;
      setStatus("读取失败：" + errText(e), "error");
    }
  }

  function renderVideoMeta(info) {
    var el = dom["rc-video-meta"];
    if (!el || !info) return;
    el.hidden = false;
    el.innerHTML =
      '<div class="rc-vmeta-grid">' +
      "<div><b>文件：</b>" + escapeHtml(info.name) + "</div>" +
      "<div><b>分辨率：</b>" + info.width + " × " + info.height + "</div>" +
      "<div><b>时长：</b>" + fmtDuration((info.durationSec || 0) * 1000) + "</div>" +
      "<div><b>帧率：</b>" + (info.fps || "?") + " fps</div>" +
      "<div><b>编码：</b>" + escapeHtml(info.codec || "?") + "</div>" +
      "<div><b>大小：</b>" + fmtSize(info.size) + "</div>" +
      "</div>";
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function applyWatermark() {
    if (transcoding) return;
    if (!caps || !caps.ffmpeg || !caps.ffmpeg.found) {
      toast("请先下载或指定 ffmpeg", "error");
      activateTab("set");
      return;
    }
    var input = String(dom["rc-wm-input"].value || "").trim();
    if (!input) {
      toast("请先选择视频文件", "error");
      return;
    }
    var spec = wmEditors.wm ? wmEditors.wm.getSpec() : DEFAULT_WM;
    if (!dom["rc-wm-on"].checked) spec.enabled = false;
    if (spec.enabled && spec.type === "text" && !String(spec.text || "").trim()) {
      toast("水印文字不能为空", "error");
      return;
    }
    if (spec.enabled && spec.type === "image" && !String(spec.imagePath || "").trim()) {
      toast("请填写图片水印的路径", "error");
      return;
    }

    transcoding = true;
    dom["rc-wm-apply"].disabled = true;
    dom["rc-wm-cancel"].hidden = false;
    dom["rc-wm-progress"].hidden = false;
    setProgress(0, "开始转码…");
    setStatus("");

    try {
      var r = await call("applyWatermark", {
        input: input,
        watermark: spec,
        durationSec: currentVideo ? currentVideo.durationSec : 0
      });
      transcoding = false;
      dom["rc-wm-apply"].disabled = false;
      dom["rc-wm-cancel"].hidden = true;
      if (r && r.ok) {
        setProgress(100, "完成：" + r.output);
        setStatus("已导出：" + r.output + "（" + fmtSize(r.size) + "）", "ok");
        toast("水印已添加");
        refreshLibrary();
        activateTab("lib");
      } else {
        setProgress(0, "");
        dom["rc-wm-progress"].hidden = true;
        setStatus("转码失败：" + ((r && r.error) || "未知原因"), "error");
        toast("转码失败", "error");
      }
    } catch (e) {
      transcoding = false;
      dom["rc-wm-apply"].disabled = false;
      dom["rc-wm-cancel"].hidden = true;
      dom["rc-wm-progress"].hidden = true;
      setStatus("转码失败：" + errText(e), "error");
      toast("转码失败", "error");
    }
  }

  function setProgress(pct, text) {
    var p = Math.max(0, Math.min(100, Number(pct) || 0));
    dom["rc-wm-progress-fill"].style.width = p.toFixed(1) + "%";
    dom["rc-wm-progress-text"].textContent = text || (p.toFixed(0) + "%");
  }

  /* ======================= 作品库 ======================= */

  async function refreshLibrary() {
    var grid = dom["rc-lib-grid"];
    if (!grid) return;
    var items = [];
    try {
      items = await call("listRecordings", {});
    } catch (e) {
      grid.innerHTML = "";
      dom["rc-lib-empty"].hidden = false;
      dom["rc-lib-count"].textContent = "";
      return;
    }
    dom["rc-lib-count"].textContent = items.length ? "共 " + items.length + " 个文件" : "";
    dom["rc-lib-empty"].hidden = items.length > 0;
    grid.innerHTML = "";

    items.forEach(function (it) {
      var card = document.createElement("div");
      card.className = "rc-lib-card";
      card.setAttribute("data-rel", it.relPath);
      card.innerHTML =
        '<div class="rc-lib-thumb rc-thumb-slot" data-rel="' + escapeHtml(it.relPath) + '"></div>' +
        '<div class="rc-lib-body">' +
        '<div class="rc-lib-name" title="' + escapeHtml(it.name) + '">' + escapeHtml(it.name) + "</div>" +
        '<div class="rc-lib-sub">' +
        '<span class="rc-tag ' + (it.kind === "watermark" ? "wm" : "rec") + '">' +
        (it.kind === "watermark" ? "水印" : "录制") + "</span>" +
        "<span>" + fmtTime(it.mtimeMs) + " · " + fmtSize(it.size) + "</span>" +
        "</div></div>" +
        '<div class="rc-lib-acts">' +
        '<button class="rc-mini" data-act="lib-open">播放</button>' +
        '<button class="rc-mini" data-act="lib-reveal">定位</button>' +
        '<button class="rc-mini del" data-act="lib-del">删除</button>' +
        "</div>";
      grid.appendChild(card);
    });

    // 缩略图延后、串行加载（每次都要拉一帧，别一口气打满）
    loadThumbs(items);
  }

  async function loadThumbs(items) {
    for (var i = 0; i < items.length; i++) {
      if (!alive()) return;
      var it = items[i];
      var slot = rootEl.querySelector('.rc-thumb-slot[data-rel="' + cssEscape(it.relPath) + '"]');
      if (!slot) continue;
      try {
        var t = await call("thumb", { relPath: it.relPath, atSec: 1, width: 320 });
        if (t && t.base64) {
          var img = document.createElement("img");
          img.className = "rc-lib-thumb";
          img.alt = it.name;
          img.src = "data:" + (t.mime || "image/png") + ";base64," + t.base64;
          slot.replaceWith(img);
        } else {
          slot.textContent = "无缩略图";
          slot.className = "rc-lib-thumb rc-thumb-placeholder";
        }
      } catch (e) {
        slot.textContent = "无缩略图";
        slot.className = "rc-lib-thumb rc-thumb-placeholder";
      }
    }
  }

  function cssEscape(s) {
    return String(s).replace(/["\\]/g, "\\$&");
  }

  async function libraryAction(card, act) {
    var rel = card.getAttribute("data-rel");
    if (!rel) return;
    try {
      if (act === "lib-open") {
        await call("openFile", { relPath: rel });
      } else if (act === "lib-reveal") {
        await call("revealFile", { relPath: rel });
      } else if (act === "lib-del") {
        var yes = true;
        try {
          yes = await ms.ui.confirm("确定删除 " + rel.replace("recordings/", "") + " 吗？");
        } catch (e) {
          yes = true;
        }
        if (!yes) return;
        await call("removeRecording", { relPath: rel });
        refreshLibrary();
      }
    } catch (e) {
      setStatus("操作失败：" + errText(e), "error");
    }
  }

  /* ======================= 设置 / 预设 ======================= */

  function renderSettings() {
    if (!dom["rc-set-ffinfo"]) return;
    var ff = (caps && caps.ffmpeg) || {};
    if (ff.found) {
      dom["rc-set-ffinfo"].textContent = "已检测到： " + ff.path + (ff.version ? "  版本 v" + ff.version : "") +
        (ff.probeFound ? "  （ffprobe 可用）" : "  （未找到 ffprobe，无法读取视频时长信息）");
    } else {
      var tried = (ff.tried || []).filter(Boolean);
      dom["rc-set-ffinfo"].textContent = "未检测到可用 ffmpeg。" + (tried.length ? " 已尝试：" + tried.join("、") : "");
    }

    // 自带副本状态
    var b = ff.bundled || {};
    if (dom["rc-set-bundled"]) {
      dom["rc-set-bundled"].textContent = b.present
        ? "插件自带副本：已就绪" + (b.version ? "（v" + b.version + "）" : "") + "  " + b.path +
          (b.downloadedAt ? "  下载于 " + fmtTime(Date.parse(b.downloadedAt)) : "")
        : "插件自带副本：尚未下载";
    }
    if (dom["rc-set-dlrm"]) dom["rc-set-dlrm"].hidden = !b.present;
    if (dom["rc-set-dl"]) dom["rc-set-dl"].disabled = !canDownload();

    // 下载源（让用户知道包从哪来）
    if (dom["rc-set-sources"]) {
      var srcs = (ff.download && ff.download.sources) || [];
      var bits = srcs.map(function (s) { return s.id + (s.approxText ? "（约 " + s.approxText + "）" : ""); });
      var need = ff.download && ff.download.needText;
      if (need) bits.push("需约 " + need + " 空间");
      var free = ff.download && ff.download.freeBytes;
      if (typeof free === "number") bits.push("当前可用 " + fmtSize(free));
      dom["rc-set-sources"].textContent = bits.length ? "下载源：" + bits.join("；") : "";
    }

    if (dom["rc-set-ffpath"] && !dom["rc-set-ffpath"].value) {
      dom["rc-set-ffpath"].value = ff.userPath || "";
    }
    if (dom["rc-set-outdir"]) dom["rc-set-outdir"].textContent = "视频目录：" + ((caps && caps.outDir) || "（未知）");
    if (dom["rc-set-bindir"]) dom["rc-set-bindir"].textContent = "自带 ffmpeg 目录：" + ((caps && caps.binDir) || "（未知）");

    // 采集后端：如实展示当前会用哪个、以及为什么降级
    if (dom["rc-set-capture"]) {
      var cap = caps && caps.capture;
      if (!cap) {
        dom["rc-set-capture"].textContent = "";
      } else if (cap.backend === "ddagrab") {
        dom["rc-set-capture"].textContent = "采集后端：Desktop Duplication（ddagrab，GPU 直出，录屏时光标不闪）";
      } else {
        var why = !cap.dda
          ? "当前 ffmpeg/环境不支持 ddagrab"
          : cap.singleMonitor === false
            ? "检测到多屏（ddagrab 单次只能取一个显示器）"
            : "已手动指定";
        dom["rc-set-capture"].textContent = "采集后端：GDI（gdigrab，" + why + "；录屏时光标可能闪烁）";
      }
    }
    renderPresets();
  }

  function readPresets() {
    var list = storeGet(STORE_PRESETS, []);
    return Array.isArray(list) ? list : [];
  }

  function renderPresets() {
    var box = dom["rc-preset-list"];
    if (!box) return;
    var list = readPresets();
    box.innerHTML = "";
    if (!list.length) {
      box.innerHTML = '<div class="rc-help">还没有保存的预设。</div>';
      return;
    }
    list.forEach(function (p, i) {
      var row = document.createElement("div");
      row.className = "rc-preset-item";
      row.innerHTML =
        '<span class="rc-preset-name">' + escapeHtml(p.name) + " <span class='rc-muted'>" +
        (p.spec && p.spec.type === "image" ? "图片" : "文字") + "</span></span>" +
        '<button class="rc-mini" data-act="preset-apply" data-i="' + i + '">套用到加水印</button>' +
        '<button class="rc-mini del" data-act="preset-del" data-i="' + i + '">删除</button>';
      box.appendChild(row);
    });
  }

  function saveCurrentAsPreset() {
    var name = String(dom["rc-preset-name"].value || "").trim();
    if (!name) {
      toast("请先给预设起个名字", "error");
      return;
    }
    var spec = wmEditors.wm ? wmEditors.wm.getSpec() : clone(DEFAULT_WM);
    var list = readPresets().filter(function (p) { return p.name !== name; });
    list.push({ name: name, spec: spec, savedAt: Date.now() });
    storeSet(STORE_PRESETS, list);
    dom["rc-preset-name"].value = "";
    renderPresets();
    toast("已保存预设「" + name + "」");
  }

  /* ======================= 初始化 ======================= */

  async function loadCapabilities(showErrors) {
    try {
      caps = await call("capabilities", {});
      renderFfStatus();
      if (dom["rc-set-ffinfo"]) renderSettings();
      if (showErrors && caps && caps.ffmpeg && !caps.ffmpeg.found) {
        var canDl = caps.ffmpeg.download && caps.ffmpeg.download.sources && caps.ffmpeg.download.sources.length;
        setStatus(
          canDl
            ? "首次使用需要准备 ffmpeg：点顶部「一键下载」由插件自动获取（约 40MB），或用你自己已安装的那份。"
            : "未检测到 ffmpeg。请在「设置」页手动指定已安装的 ffmpeg 路径。",
          "error"
        );
      }
    } catch (e) {
      dom["rc-ffdot"].className = "rc-dot off";
      dom["rc-fftext"].textContent = "后台进程不可用：" + errText(e);
      if (showErrors) setStatus("后台进程不可用：" + errText(e), "error");
    }
  }

  async function loadFonts() {
    try {
      var r = await call("listFonts", {});
      var fonts = (r && r.fonts) || [];
      if (!fonts.length) return;
      Object.keys(wmEditors).forEach(function (k) {
        var sel = wmEditors[k].node.querySelector('[data-wm="fontFile"]');
        if (!sel) return;
        var cur = wmEditors[k].getSpec().fontFile;
        sel.innerHTML = '<option value="">自动（可能显示方块）</option>';
        fonts.forEach(function (f) {
          var o = document.createElement("option");
          o.value = f;
          o.textContent = f.split(/[\\/]/).pop() + "  —  " + f;
          sel.appendChild(o);
        });
        sel.value = cur || "";
      });
    } catch (e) {
      /* 字体探测失败不致命，drawtext 会退回 fontconfig 默认 */
    }
  }

  async function refreshBackendState() {
    try {
      var s = await call("state", {});
      if (s && s.recording && s.recording.active) {
        recordingActive = true;
        dom["rc-rec-btn"].textContent = "停止录制";
        dom["rc-rec-btn"].classList.add("recording");
        dom["rc-rec-pause"].disabled = false;
        tickBase = { elapsedMs: s.recording.elapsedMs || 0, at: Date.now() };
        startLocalTick();
      }
    } catch (e) {
      /* 拉不到就按未录制处理 */
    }
  }

  function bindEvents() {
    // 页签
    document.querySelectorAll('.rc-tab[data-act="tab"]').forEach(function (b) {
      b.addEventListener("click", function () {
        activateTab(b.getAttribute("data-tab"));
      });
    });

    // 录屏
    dom["rc-rec-btn"].addEventListener("click", function () {
      if (recordingActive) stopRecording();
      else startRecording();
    });
    dom["rc-rec-pause"].addEventListener("click", togglePause);
    dom["rc-region-mode"].addEventListener("change", function () {
      dom["rc-region-box"].hidden = dom["rc-region-mode"].value !== "custom";
      persistRegionPrefs();
    });
    // 区域坐标手改也记下来，下次打开还是这组值
    ["rc-region-x", "rc-region-y", "rc-region-w", "rc-region-h", "rc-region-frame"].forEach(function (id) {
      var el = dom[id];
      if (el) el.addEventListener("change", persistRegionPrefs);
    });
    dom["rc-rec-wm-on"].addEventListener("change", function () {
      if (wmEditors.rec) wmEditors.rec.setEnabled(dom["rc-rec-wm-on"].checked);
      storeSet(STORE_WM_REC, wmEditors.rec ? wmEditors.rec.getSpec() : DEFAULT_WM);
    });

    // 加水印
    dom["rc-wm-input"].addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") detectVideo(dom["rc-wm-input"].value);
    });
    dom["rc-wm-apply"].addEventListener("click", applyWatermark);
    dom["rc-wm-cancel"].addEventListener("click", async function () {
      try {
        await call("cancelWatermark", {});
        setStatus("已请求取消转码");
      } catch (e) {
        setStatus("取消失败：" + errText(e), "error");
      }
    });
    dom["rc-wm-on"].addEventListener("change", function () {
      if (wmEditors.wm) wmEditors.wm.setEnabled(dom["rc-wm-on"].checked);
      storeSet(STORE_WM, wmEditors.wm ? wmEditors.wm.getSpec() : DEFAULT_WM);
    });

    // 拖拽
    var drop = dom["rc-drop"];
    if (drop) {
      ["dragenter", "dragover"].forEach(function (t) {
        drop.addEventListener(t, function (ev) {
          ev.preventDefault();
          drop.classList.add("dragover");
        });
      });
      ["dragleave", "drop"].forEach(function (t) {
        drop.addEventListener(t, function (ev) {
          ev.preventDefault();
          drop.classList.remove("dragover");
        });
      });
      drop.addEventListener("drop", function (ev) {
        var dt = ev.dataTransfer;
        var f = dt && dt.files && dt.files[0];
        // WebView 里 File 默认拿不到绝对路径，宿主附件才是可靠来源
        var path = (f && (f.path || f.webkitRelativePath)) || "";
        if (!path) {
          pickFromAttachments();
          return;
        }
        detectVideo(path);
      });
    }

    // 作品库（事件委托）
    if (dom["rc-lib-grid"]) {
      dom["rc-lib-grid"].addEventListener("click", function (ev) {
        var btn = ev.target.closest("button[data-act]");
        if (!btn) return;
        var card = btn.closest(".rc-lib-card");
        if (card) libraryAction(card, btn.getAttribute("data-act"));
      });
    }

    // 设置
    dom["rc-set-ffpath"].addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") saveFfmpegPath();
    });
    dom["rc-preset-name"].addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") saveCurrentAsPreset();
    });
    if (dom["rc-preset-list"]) {
      dom["rc-preset-list"].addEventListener("click", function (ev) {
        var btn = ev.target.closest("button[data-act]");
        if (!btn) return;
        var act = btn.getAttribute("data-act");
        var i = Number(btn.getAttribute("data-i"));
        var list = readPresets();
        if (act === "preset-apply" && list[i]) {
          if (wmEditors.wm) wmEditors.wm.setSpec(list[i].spec);
          if (wmEditors.rec) wmEditors.rec.setSpec(list[i].spec);
          storeSet(STORE_WM, list[i].spec);
          toast("已套用预设「" + list[i].name + "」");
          activateTab("wm");
        } else if (act === "preset-del" && list[i]) {
          list.splice(i, 1);
          storeSet(STORE_PRESETS, list);
          renderPresets();
        }
      });
    }

    // 通用 data-act 按钮
    document.body.addEventListener("click", function (ev) {
      var btn = ev.target.closest("button[data-act]");
      if (!btn) return;
      var act = btn.getAttribute("data-act");
      if (act === "goto-settings") activateTab("set");
      else if (act === "lib-refresh") refreshLibrary();
      else if (act === "detect") detectVideo(dom["rc-wm-input"].value);
      else if (act === "set-ffpath") saveFfmpegPath();
      else if (act === "reprobe") loadCapabilities(true);
      else if (act === "download-ffmpeg") downloadFfmpeg();
      else if (act === "remove-bundled") removeBundledFfmpeg();
      else if (act === "preset-save") saveCurrentAsPreset();
      else if (act === "pick-video") pickFromAttachments();
      else if (act === "region-pick") openRegionPicker();
      else if (act === "pick-ok") applyPickedRegion();
      else if (act === "pick-cancel") closeRegionPicker();
    });
  }

  async function saveFfmpegPath() {
    var p = String(dom["rc-set-ffpath"].value || "").trim();
    setStatus("正在检测 " + (p || "自动路径") + " …");
    try {
      var r = await call("setFfmpegPath", { path: p });
      await loadCapabilities(false);
      if (r && r.found) {
        setStatus("已保存，检测到 ffmpeg：" + r.path + (r.version ? "（v" + r.version + "）" : ""), "ok");
        toast("ffmpeg 已就绪");
      } else {
        setStatus("已保存，但在该路径下没找到可用的 ffmpeg。请确认填写的是 ffmpeg.exe（或它所在目录）。", "error");
      }
      renderSettings();
    } catch (e) {
      setStatus("保存失败：" + errText(e), "error");
    }
  }

  /** 从「搜索框附件」里挑视频：WebView 拿不到拖入文件的真实路径，宿主附件是可靠来源 */
  async function pickFromAttachments() {
    var list = [];
    try {
      list = await ms.input.attachments();
    } catch (e) {
      setStatus("读取附件需要 file.read 权限：" + errText(e), "error");
      return;
    }
    var vids = (list || []).filter(function (a) {
      return a && a.kind === "file" && /\.(mp4|mkv|webm|mov|avi|flv|wmv|m4v)$/i.test(a.name || a.path || "");
    });
    if (!vids.length) {
      setStatus("搜索框里没有视频附件。把视频拖进搜索框，或直接在输入框里填绝对路径。");
      return;
    }
    detectVideo(vids[0].path);
  }

  /* ======================= 启动 ======================= */

  async function boot() {
    // 1. 两个水印编辑器
    wmEditors.rec = createEditor(dom["rc-rec-wm-editor"], storeGet(STORE_WM_REC, clone(DEFAULT_WM)), {
      onChange: function (s) { storeSet(STORE_WM_REC, s); }
    });
    wmEditors.wm = createEditor(dom["rc-wm-editor"], storeGet(STORE_WM, clone(DEFAULT_WM)), {
      onChange: function (s) { storeSet(STORE_WM, s); }
    });

    var recSpec = wmEditors.rec.getSpec();
    dom["rc-rec-wm-on"].checked = recSpec.enabled !== false;
    wmEditors.rec.setEnabled(dom["rc-rec-wm-on"].checked);
    var wmSpec = wmEditors.wm.getSpec();
    dom["rc-wm-on"].checked = wmSpec.enabled !== false;
    wmEditors.wm.setEnabled(dom["rc-wm-on"].checked);

    // 2. 恢复界面偏好
    var prefs = storeGet(STORE_PREFS, {});
    if (prefs.fps) dom["rc-fps"].value = String(prefs.fps);
    if (prefs.encoder) dom["rc-encoder"].value = prefs.encoder;
    restoreRegionPrefs();

    bindEvents();
    activateTab("rec");

    // 3. 后端：能力探测 + 字体 + 状态
    await loadCapabilities(true);
    loadFonts();
    refreshBackendState();

    // 4. 后端通知（录制计时/结束、转码进度）
    try {
      unsubs.push(ms.backend.onNotification("record:tick", function (p) {
        if (!alive() || !p) return;
        tickBase = { elapsedMs: p.elapsedMs || 0, at: Date.now() };
        paused = !!p.paused;
        if (!paused) dom["rc-rec-timer"].textContent = fmtDuration(p.elapsedMs || 0);
        // 后端中途换采集后端（ddagrab 回退 gdigrab）时用 note 提示一句，之后每拍都带上
        if (p.note) tickNote = p.note;
        var txt = paused ? "已暂停" : "录制中…";
        if (tickNote) txt += "（" + tickNote + "）";
        if (p.size) txt += "  已写入 " + fmtSize(p.size);
        dom["rc-rec-info"].textContent = txt;
      }));
      unsubs.push(ms.backend.onNotification("record:ended", function (p) {
        if (!alive()) return;
        onRecordEnded(p || {});
      }));
      unsubs.push(ms.backend.onNotification("watermark:progress", function (p) {
        if (!alive() || !p) return;
        var d = p.durationSec ? fmtDuration(p.seconds * 1000) + " / " + fmtDuration(p.durationSec * 1000) : fmtDuration(p.seconds * 1000);
        setProgress(p.percent || 0, d);
      }));
      unsubs.push(ms.backend.onNotification("watermark:done", function (p) {
        if (!alive() || !p || !p.ok) return;
        // 成功收尾由 applyWatermark 的返回值处理，这里只兜底刷新
        refreshLibrary();
      }));
      // 下载自带 ffmpeg 的进度（后端流式推送）
      unsubs.push(ms.backend.onNotification("ffmpeg:progress", function (p) {
        if (!alive() || !p) return;
        downloading = true;
        if (dom["rc-dl"]) dom["rc-dl"].hidden = false;
        var label = p.phase === "extract" ? "正在解包…"
          : p.phase === "verify" ? "校验中…"
          : p.message || "下载中";
        if (p.totalText) label += "  " + p.receivedText + " / " + p.totalText;
        else if (p.receivedText) label += "  " + p.receivedText;
        setDownloadProgress(p.percent || 0, label);
      }));
      unsubs.push(ms.backend.onNotification("ffmpeg:done", function (p) {
        if (!alive()) return;
        downloading = false;
        if (!p || !p.ok) {
          if (dom["rc-dl"]) dom["rc-dl"].hidden = true;
        }
      }));
    } catch (e) {
      /* 通知订阅失败不影响主流程 */
    }

    // 5. 若从搜索框带了视频附件进来，自动切到「加水印」页并读取
    bindAttachmentWatcher();
    var entered = String(keyword || "").trim();
    if (entered && /\.(mp4|mkv|webm|mov|avi|flv|wmv|m4v)$/i.test(entered)) {
      detectVideo(entered);
      activateTab("wm");
    } else {
      pickVideoFromAttachmentsSilently();
    }

    // 6. 能力就绪：若快捷键动作在 boot 期间早到了，现在补执行
    capsReady = true;
    if (pendingToggle) {
      pendingToggle = false;
      void toggleRecording();
    }
  }

  /** 附件变化时（用户拖入视频）自动识别 */
  function bindAttachmentWatcher() {
    function onChanged() {
      if (!alive()) return;
      pickVideoFromAttachmentsSilently();
    }
    document.addEventListener("ms-attachments-changed", onChanged);
    unsubs.push(function () {
      document.removeEventListener("ms-attachments-changed", onChanged);
    });
  }

  async function pickVideoFromAttachmentsSilently() {
    try {
      var list = await ms.input.attachments();
      var vids = (list || []).filter(function (a) {
        return a && a.kind === "file" && /\.(mp4|mkv|webm|mov|avi|flv|wmv|m4v)$/i.test(a.name || a.path || "");
      });
      if (vids.length && vids[0].path && vids[0].path !== (currentVideo && currentVideo.input)) {
        detectVideo(vids[0].path);
        activateTab("wm");
      }
    } catch (e) {
      /* 无 file.read 权限或无附件：静默 */
    }
  }

  /** 子关键词（「录屏 : xxx」）→ 当作视频路径处理 */
  if (typeof onSubKeyword === "function") {
    onSubKeyword(function (sub) {
      var s = String(sub || "").trim();
      if (!s || !alive()) return;
      if (/\.(mp4|mkv|webm|mov|avi|flv|wmv|m4v)$/i.test(s)) {
        detectVideo(s);
        activateTab("wm");
      }
    });
  }

  /* ======================= 全局快捷键动作（宿主转发） =======================
   *
   * 清单 contributes.shortcut 里声明了本地动作名 `record-toggle`；宿主把它注册成
   * 全局热键（`plugin:com.mysearch.recorder:record-toggle`），按下后打开本视图并把
   * 动作名派发到这里。行为：**没在录 → 开始；在录 → 停止**（一个键开关）。
   *
   * 注意：宿主派发时视图可能刚挂载（脚本刚跑完，boot 是异步的）——若此刻
   * ffmpeg 能力尚未探测完，直接开录会失败。这里的处理：把动作记成「待执行」，
   * 等 boot 完成（capsReady 置位）后再执行；已就绪则立即执行。
   */
  var pendingToggle = false;

  async function toggleRecording() {
    if (!capsReady) {
      // 能力还没探完（视图刚被快捷键拉起）：先记下，boot 完成后再执行
      pendingToggle = true;
      return;
    }
    if (recordingActive) {
      await stopRecording();
    } else {
      await startRecording();
    }
  }

  /**
   * 处理宿主派发的快捷键动作。只有 `record-toggle` 是这个插件认识的动作；
   * 其它名字（清单改版后新增）静默忽略——宿主对「没处理器」的场景会自行提示。
   */
  function onShortcutAction(name) {
    if (name === "record-toggle") void toggleRecording();
  }

  if (ms && ms.shortcuts && typeof ms.shortcuts.onAction === "function") {
    var offAction = ms.shortcuts.onAction("record-toggle", function () {
      onShortcutAction("record-toggle");
    });
    if (typeof offAction === "function") unsubs.push(offAction);
  }

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
