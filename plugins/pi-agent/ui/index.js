/**
 * Pi Agent 前端入口脚本（界面严格对齐设计稿 pi-ui.html）
 *
 * 接收 scope 参数:
 *   ms            - 宿主 API 网关
 *   env           - 兼容 ScriptEnv
 *   plugin        - 插件记录元数据
 *   host          - 插件 DOM 宿主 (容器)
 *   keyword       - 搜索关键词
 *   inputValue    - 输入框当前内容
 *   onSubKeyword  - 注册子关键词处理器
 *   md2html       - Markdown 转 HTML 函数
 *   openExternal  - 打开 URL
 *
 * 设计约束：
 *   - 模型/密钥不在插件里另存一份：设置面板（左菜单 + 右内容）里的「模型配置」
 *     直接读写 pi 自己的 models.json（~/.pi/agent/models.json），
 *     因此终端里的 pi 与这里的配置永远一致。
 *   - 会话与消息全部来自 pi 的会话文件（~/.pi/agent/sessions/...）。
 */
(function (ms, env, plugin, host, keyword, inputValue, onSubKeyword, md2html, openExternal) {

"use strict";

// ===================== 状态 =====================
let projects = [];            // [{ id, name, path, lastOpenedAt }]
let currentProject = null;    // 当前选中的项目
let sessions = [];            // 当前项目的会话列表
let currentSessionId = null;
let currentModelId = "";      // "provider:modelId"
let models = [];              // pi 返回的模型列表
/**
 * 正在运行 agent 的会话：Map<sessionId, { projectPath, sessionId }>。
 * sessionId 全局唯一（跨项目也唯一），可按 sessionId 直接判断某个会话是否在跑。
 * 发送时登记、chat:status(idle)/chat:aborted/请求结束 时按会话删除。
 * 不再用单一 isSending 全局开关——否则「会话 A 还在跑，切到 B」会把 A 的运行
 * 状态一起丢掉，B 也没法同时发送下一条。
 */
const runningSessions = new Map();
/**
 * 每个会话「待回答的 ask」：Map<sessionId, params>。
 * params 是 chat:ask 通知的原始载荷（toolCallId/questions/sessionId/projectPath）。
 * 用户切到别的会话时卡片要收起来、切回来再原样重新挂出，所以得按会话记着；
 * 侧边栏的「待回答」角标也从这里读。真正权威的仍是后端 pendingAsk——本账本只是
 * 缓存，切回会话时会用 getPendingAsk 对账（插件重挂/错过通知都能兜住）。
 */
const pendingAskBySession = new Map();
/**
 * 未作答卡片的用户已选状态：Map<sessionId, { toolCallId, answers, texts }>。
 * 切走时暂存、切回时回填，避免「切一圈回来选中的选项没了」。answers 是
 * qid -> string | string[]，texts 是 qid -> 输入框文本。
 */
const askCardStates = new Map();
/** 正在新建会话（防连点） */
let creatingSession = false;
/** 会话列表定期同步的定时器 */
let sessionPollTimer = null;
/** 会话列表「X 分钟前」这类相对时间标签的轻量刷新定时器：
 *  只改文本、不重排、不重拉；相对时间随「当前时刻」推移（3 分钟前→4 分钟前），
 *  慢轮询只在 id/title/flag 变化时才重渲染，覆盖不到「标签变旧」，所以单独刷。 */
let relTimeTimer = null;
/**
 * 项目状态圆点计数的定期同步定时器。
 *
 * 为什么要独立于会话轮询：非当前项目的 running/unseen 只有 listProjects 才知道
 * （listSessions 只覆盖当前项目），而 listProjects 原先只在启动时调一次——
 * 于是「别的项目」的状态圆点永远冻结在启动那一刻；更糟的是启动时
 * ensureSeenBaseline 会把历史会话全标成已查看，unseen 恒为 0，
 * 于是实际几乎只会看到一个（甚至看不到）黄点，绿点与「两圆同心」永远不出现。
 *
 * 这个轮询**刻意不受** runningSessions 限制：正在跑恰恰是最需要看到黄点的时候。
 */
let projectPollTimer = null;
/** listProjects 请求在途标记：避免慢响应时叠加请求 */
let projectPollBusy = false;
/** 会话列表加载态：true 时中间栏显示「加载中…」占位（首屏初始化 / 切换项目期间） */
let sessionsLoading = false;
/**
 * listSessions 请求序号：每次发起 +1，响应回来时号不对就丢弃。
 *
 * listSessions 要全量解析项目下所有会话文件（大项目可达数秒），期间用户可能
 * 已切换项目、或新一轮加载/轮询已发出——过期响应若照常写入，会把旧项目的
 * 会话列表/角标盖到新项目上，markViewed 还会带错 projectPath 落盘（seen 表里
 * 出现「同一会话挂在多个项目下」的脏 key，之后那个项目的角标就永远不清零）。
 * 与 projectPath 校验配合：path 防串项目，序号防同项目新旧响应乱序。
 */
let sessionsReqSeq = 0;
/** 已加载的会话消息（用于「加载更多历史」分页） */
let loadedMessages = [];
/** 当前已渲染区间的左端点（向前渲染，值只会变小）；-1 = 还没渲染任何历史 */
let renderedFrom = -1;
/** 已渲染区间的右端点（历史快照的长度；新消息直接 append，不进这个区间） */
let renderedFromEnd = 0;
/** 每点一次「加载更多」往前加的**轮次数**（一轮 = 一条提问 + 它后面的回答） */
const ROUNDS_PER_PAGE = 1;
/** 会话列表默认展示的条数（待处理的 + 当前会话，其余按页展开） */
const SESSIONS_PER_PAGE = 10;
/** 会话列表当前展开到的条数 */
let sessionVisibleCount = SESSIONS_PER_PAGE;

/**
 * 界面主题偏好（"inherit" | "dark" | "light"）。
 *
 * pi 的设计稿是深色的，因此插件清单里声明 `detailView.theme: "dark"`——软件
 * 本身是浅色时，打开本插件也会把**整个呼出窗口**切成深色，避免「上方搜索框浅、
 * 下方插件深」的割裂观感。这里保存用户在左下角选择的偏好（用 ms.store 私有命名
 * 空间持久化），并通过 `ms.ui.registerThemeProvider` 上报给宿主，宿主据此决定
 * 呼出窗口的主题；"inherit" 表示跟随宿主的软件主题。
 *
 * 初值由 setupTheme 从 `ms.plugin.info.theme`（清单声明）确定——**不能**写死
 * "inherit"，否则插件默认值会盖掉清单声明的 dark。
 */
let themePreference = "inherit";

/**
 * 当前轮次的 agent 气泡节点（流式写入的唯一目标）。
 *
 * 早先每次流式都用「DOM 里最后一个 .message.agent」来定位，而打字指示器
 * 刚被 removeTyping() 摘掉——此时排在最后的是一个 .message.user 节点，
 * 于是「最后一个 agent 节点」退回到**上一轮的历史回答**上。新回答就被
 * 写进了那个位于提问**上方**的旧气泡，表现为「提问在最下面、回答在上面，
 * 刷新后才正常」。改为显式持有本轮节点，不再靠 DOM 反查。
 */
let turnAgentNode = null;

/**
 * 流式闸门：true 表示当前允许写入流式内容。
 *
 * 编辑重发 / 停止时置 false，直到**新一轮真正开始**（收到 running 通知或重绘视图）
 * 才置 true。用来丢弃 abort 后仍在途的旧轮 delta——它们若被写入，会以「新气泡」
 * 的形态出现在刚重发的提问下面，表现为「上面的回答还接着下面一起回」。
 */
let streamGateOpen = true;

/**
 * 上次卸载（cleanup）时保存的会话视图状态，用于 remount 后恢复。
 * 切换项目/会话时同步更新，cleanup 时将当前值写入后端 config。
 */
let savedState = { projectPath: "", sessionId: "" };

/**
 * 事件绑定幂等标记 + 文档级监听登记表。
 *
 * `init()` 可能被调用多次（例如安装完 pi 后重新 init）。若每次都向 `sendBtn`
 * 等元素、以及全局 `document` 再挂一遍匿名监听：
 *   - 元素监听会重复触发（一次点击跑两遍）；
 *   - document 上的匿名闭包永远不会被回收——视图重挂后，一次拖放会触发**新旧
 *     两份** ingestDroppedPaths（表现为重复加项目 / 重复贴图）。
 * 这里用标记保证同一次会话内只绑一次，并把已绑的 document 监听登记下来，
 * 交由 cleanup() 在视图销毁时统一移除。
 */
let eventsBound = false;
let imageInputsBound = false;
/** [{ target, type, fn, capture }] —— cleanup 时统一 removeEventListener */
const docListeners = [];
function onDoc(target, type, fn, capture = false) {
  target.addEventListener(type, fn, capture);
  docListeners.push({ target, type, fn, capture });
}
function removeDocListeners() {
  for (const { target, type, fn, capture } of docListeners) {
    try { target.removeEventListener(type, fn, capture); } catch (e) { /* ignore */ }
  }
  docListeners.length = 0;
}

// DOM 引用
const $ = (id) => document.getElementById(id);
const projectListEl = $("pi-project-list");
const sessionListEl = $("pi-session-list");
const chatBody = $("pi-chat-body");
const welcomeEl = $("pi-welcome");
const loadMoreBtn = $("pi-load-more");
const scrollBottomBtn = $("pi-scroll-bottom");
const inputEl = $("pi-input");
const sendBtn = $("pi-send-btn");
const modelSelect = $("pi-model-select");
const modelDisplay = $("current-model-display");
const chatHeader = $("pi-chat-header");

// 设置面板（整屏覆盖）DOM
const settingsEl = $("pi-settings");
const settingsBodyEl = $("pi-settings-body");
const settingsTitleEl = $("pi-settings-title");
const settingsPathEl = $("pi-settings-agent-path");
const settingsCloseBtn = $("pi-settings-close");

/** 切换发送按钮的运行/空闲状态 */
function setSendButtonRunning(running) {
  if (running) {
    sendBtn.classList.add("running");
    sendBtn.disabled = false;
    sendBtn.title = "停止 Agent";
    sendBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>';
  } else {
    sendBtn.classList.remove("running");
    sendBtn.title = "发送消息";
    sendBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>';
    const hasText = inputEl.value.trim().length > 0 || pendingImages.length > 0;
    sendBtn.disabled = !hasText;
  }
}

/** 根据输入内容更新发送按钮可用状态 */
function updateSendButtonState() {
  if (sendBtn.classList.contains("running")) return;
  const hasText = inputEl.value.trim().length > 0 || pendingImages.length > 0;
  sendBtn.disabled = !hasText;
}

/** 当前会话是否正在运行 agent（用于决定显示「停止」还是「发送」按钮） */
function currentSessionIsRunning() {
  return Boolean(currentProject && currentSessionId && runningSessions.has(currentSessionId));
}

/**
 * 把发送按钮同步到「当前会话的运行状态」。
 * 会话切换/通知到达/请求结束都要走这里，保证按钮永远反映当前会话，
 * 而不是残留上一个会话的运行态。
 */
function syncSendButton() {
  if (currentSessionIsRunning()) {
    setSendButtonRunning(true);
  } else {
    setSendButtonRunning(false);
  }
}

/**
 * 通知是否属于当前正在查看的会话。
 * 其余会话的通知（如旧会话的流式 delta/完成）只更新后台状态，
 * 不污染当前视图、不误动当前发送按钮。
 */
function isCurrentSessionNotification(params) {
  const sid = params && params.sessionId;
  return !sid || sid === currentSessionId;
}

// Pi 安装相关 DOM
const installOverlay = $("pi-install-overlay");
const installBtn = $("pi-install-btn");
const installSkip = $("pi-install-skip");
const installError = $("pi-install-error");
const installProgress = $("pi-install-progress");
const installProgressFill = $("pi-install-progress-fill");
const installProgressText = $("pi-install-progress-text");

// ===================== 界面主题 =====================

/**
 * 主题三选（设置 → 外观）：
 *   - `dark`    深色（默认，即 pi 设计稿的深色）
 *   - `light`   浅色
 *   - `inherit` 跟随系统（软件）——宿主当前是浅色就跟浅色，深色就跟深色
 *
 * 选择存在插件私有 ms.store 里，并通过 `ms.ui.registerThemeProvider` 上报给宿主；
 * 宿主据此把**整个呼出窗口**切成该主题（搜索框与插件面板同色），关闭插件后恢复
 * 软件原主题。
 */
const THEME_OPTIONS = [
  { value: "dark", label: "深色", desc: "按 pi 设计稿的深色界面（默认）" },
  { value: "light", label: "浅色", desc: "浅色界面" },
  { value: "inherit", label: "跟随系统", desc: "跟随软件（我的搜索）当前的主题" },
];

/**
 * 恢复主题偏好并向上汇报给宿主（宿主据此切整个呼出窗口的主题）。
 *
 * 时机：init() 最开头、后端就绪之前。主题是纯前端的事，不该等后端握手
 * （否则后端慢/未安装时用户看到浅色呼出窗口 + 深色插件）。宿主在每次打开/恢复
 * 本视图时都会重新询问 provider，因此同步设置一次即可。
 */
function setupTheme() {
  // 初值：清单声明的默认主题（宿主在 ms.plugin.info.theme 里给出，pi-agent 是 dark），
  // 兜底也取 "dark"——本插件的默认就是深色。
  const declared = ms.plugin?.info?.theme;
  if (declared === "dark" || declared === "light" || declared === "inherit") {
    themePreference = declared;
  } else {
    themePreference = "dark";
  }

  // 先登记 provider（同步、返回当前偏好），并把当前值交给宿主：此刻宿主会
  // 应用一次主题覆盖，避免首帧闪烁。
  ms.ui?.registerThemeProvider?.(() => themePreference);
  ms.ui?.applyTheme?.();

  // 异步读回用户持久化的偏好：读到后以用户选择为准（覆盖清单声明）
  Promise.resolve(ms.store?.get?.("theme", null))
    .then((saved) => {
      if (saved !== "dark" && saved !== "light" && saved !== "inherit") return;
      if (saved === themePreference) return;
      themePreference = saved;
      ms.ui?.applyTheme?.();
      renderSettingsBody();
    })
    .catch(() => { /* 读不到就用清单声明（dark） */ });

  // 宿主主题变化时重绘「外观」页（"跟随系统" 下选中态要跟着变）。
  // 先清掉旧的订阅：init() 可能被重复调用（如安装完 pi 后重新 init），而宿主把
  // 主题 handler 存在 Set 里、不会自动去重，重复注册会让一次主题变化重绘多次。
  ms.ui?._clearThemeHandlers?.();
  ms.ui?.onThemeChanged?.(() => renderSettingsBody());
}

/** 选择主题：写偏好 + 持久化 + 让宿主立即应用 + 重绘外观页 */
function selectTheme(next) {
  if (next !== "dark" && next !== "light" && next !== "inherit") return;
  themePreference = next;
  Promise.resolve(ms.store?.set?.("theme", next)).catch(() => {});
  ms.ui?.applyTheme?.();
  renderSettingsBody();
}

/** 当前**生效**的深浅（"跟随系统" 时按宿主当前主题解析） */
function effectiveThemeNow() {
  if (themePreference === "dark" || themePreference === "light") return themePreference;
  return ms.ui?.theme === "light" ? "light" : "dark";
}

// ===================== 会话列表宽度（可拖拽调整） =====================

/**
 * 中间会话列表栏宽度：用户可拖手柄调整，有最小/最大限制。
 *
 * 宽度写在容器的 CSS 变量 `--pi-session-width` 上（.sidebar-middle 用
 * `width: var(--pi-session-width, 290px)` 读取），并通过 ms.store 持久化，
 * 重开插件/切项目都保持用户设定的宽度。取值范围 [MIN, MAX]，默认 290px。
 */
const SESSION_WIDTH_DEFAULT = 290;
const SESSION_WIDTH_MIN = 180;   // 再窄会话标题就退化成省略号了：最小宽度硬约束
const SESSION_WIDTH_MAX = 520;   // 超过此宽度主对话区会被挤扁：最大宽度硬约束

/** 把当前宽度钳制到合法区间（非数字则回落到默认值） */
function clampSessionWidth(w) {
  const n = Number(w);
  if (!Number.isFinite(n)) return SESSION_WIDTH_DEFAULT;
  return Math.min(SESSION_WIDTH_MAX, Math.max(SESSION_WIDTH_MIN, Math.round(n)));
}

/** 应用宽度：写到容器 CSS 变量（.sidebar-middle 读取它） */
function applySessionWidth(w) {
  const clamped = clampSessionWidth(w);
  const container = $("pi-agent");
  if (container) container.style.setProperty("--pi-session-width", clamped + "px");
  return clamped;
}

/**
 * 初始化会话列表宽度手柄：
 *   1. 先从 ms.store 恢复上次拖拽的宽度（异步入场，失败即用默认值）；
 *   2. 绑定拖拽（pointer events，兼容鼠标/触控笔/触摸）。
 * 拖拽用 pointer capture：鼠标移出窗口再回来也能继续跟随，不会"丢"。
 */
function setupSidebarResizer() {
  const resizer = $("pi-sidebar-resizer");
  const sidebar = $("pi-sidebar-middle");
  if (!resizer || !sidebar) return;

  // 恢复用户上次设定的宽度
  Promise.resolve(ms.store?.get?.("sessionWidth", null))
    .then((saved) => {
      if (saved == null) return;
      applySessionWidth(saved);
    })
    .catch(() => { /* 读不到就用默认宽度 */ });

  let dragging = false;
  let startX = 0;
  let startWidth = 0;

  const onPointerMove = (e) => {
    if (!dragging) return;
    applySessionWidth(startWidth + (e.clientX - startX));
  };

  const onPointerUp = (e) => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove("pi-resizing");
    document.body.classList.remove("pi-sidebar-resizing");
    try { resizer.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    // 落定后持久化（拖拽过程不写，避免频繁 IO）
    const finalWidth = clampSessionWidth(sidebar.getBoundingClientRect().width);
    applySessionWidth(finalWidth);
    Promise.resolve(ms.store?.set?.("sessionWidth", finalWidth)).catch(() => {});
  };

  const onPointerDown = (e) => {
    // 只认左键/主指针
    if (e.button != null && e.button !== 0) return;
    dragging = true;
    startX = e.clientX;
    startWidth = sidebar.getBoundingClientRect().width;
    resizer.classList.add("pi-resizing");
    document.body.classList.add("pi-sidebar-resizing");
    try { resizer.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    e.preventDefault();
  };

  resizer.addEventListener("pointerdown", onPointerDown);
  // 双击恢复默认宽度
  resizer.addEventListener("dblclick", () => {
    const w = applySessionWidth(SESSION_WIDTH_DEFAULT);
    Promise.resolve(ms.store?.set?.("sessionWidth", w)).catch(() => {});
  });

  // 键盘无障碍：左右方向键微调（每次 10px，Shift 时 1px 精调）
  resizer.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const step = e.shiftKey ? 1 : 10;
    const delta = e.key === "ArrowLeft" ? -step : step;
    const w = applySessionWidth(sidebar.getBoundingClientRect().width + delta);
    Promise.resolve(ms.store?.set?.("sessionWidth", w)).catch(() => {});
  });
}

// ===================== 初始化 =====================

async function init() {
  setupTheme();
  // 会话列表宽度手柄：纯前端、不依赖后端，尽早绑定恢复用户宽度
  setupSidebarResizer();
  bindEvents();
  setupNotificationHandlers();
  // 各项目状态圆点独立轮询：非当前项目的运行/未查看状态只有这里会更新
  startProjectPolling();
  updateSendButtonState();
  // 会话列表先进入加载态：从后端就绪到会话拉取完成，中间栏持续显示「加载中…」
  sessionsLoading = true;
  renderSessions();

  // Step 1: 后端就绪（加载 pi + 模型注册表）
  try {
    const ready = await ms.backend.call("init", { pluginId: plugin?.id || "pi-agent" });
    if (!ready?.hasPi) {
      sessionsLoading = false;
      renderSessions();
      showInstallPrompt(ready?.piError || "未找到 pi（@earendil-works/pi-coding-agent）");
      return;
    }
  } catch (e) {
    // 后端初始化失败也可能是 pi 未安装，显示安装提示
    sessionsLoading = false;
    renderSessions();
    showInstallPrompt(`后端初始化失败: ${e.message || e}`);
    return;
  }

  // Step 2: 模型（直接用 pi 的配置，无需用户填写）
  loadModels();

  // Step 3: 从后端恢复上次保存的视图状态
  await restoreSavedState();

  // Step 4: 项目 + 会话
  await loadProjects();

  // Step 5: 「AI : 你的问题」呼出
  handleSubKeyword();
}

// ===================== Pi 安装 =====================

function showInstallPrompt(errorMsg) {
  hideWelcome();
  if (installOverlay) installOverlay.hidden = false;
  if (installError) {
    if (errorMsg) {
      installError.textContent = errorMsg;
      installError.hidden = false;
    } else {
      installError.hidden = true;
    }
  }
  if (installProgress) installProgress.hidden = true;
}

function hideInstallPrompt() {
  if (installOverlay) installOverlay.hidden = true;
  if (installProgress) installProgress.hidden = true;
}

async function handleInstall() {
  if (!installBtn || !installProgress || !installProgressFill || !installProgressText) return;
  installBtn.disabled = true;
  installBtn.textContent = "正在安装…";
  installProgress.hidden = false;
  installProgressFill.style.width = "0%";
  installProgressText.textContent = "正在安装 pi（@earendil-works/pi-coding-agent）…";
  if (installError) installError.hidden = true;

  // 模拟进度
  let progress = 0;
  const progressInterval = setInterval(() => {
    progress = Math.min(progress + 5, 80);
    installProgressFill.style.width = progress + "%";
  }, 2000);

  try {
    const result = await ms.backend.call("installPi");
    clearInterval(progressInterval);
    if (result?.ok) {
      installProgressFill.style.width = "100%";
      installProgressText.textContent = "安装完成，正在初始化…";
      await new Promise(r => setTimeout(r, 800));
      hideInstallPrompt();
      installBtn.disabled = false;
      installBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>安装 Pi';
      // 安装成功后重新初始化
      await init();
    } else {
      throw new Error(result?.error || "安装失败");
    }
  } catch (e) {
    clearInterval(progressInterval);
    installProgressFill.style.width = "0%";
    installProgress.hidden = true;
    if (installError) {
      installError.textContent = `安装失败: ${e.message || e}`;
      installError.hidden = false;
    }
    installBtn.disabled = false;
    installBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>重新安装 Pi';
  }
}

async function loadModels() {
  try {
    const result = await ms.backend.call("listModels");
    models = result?.models || [];
    renderModelOptions(models, result?.defaultModel || "");
    if (!result?.hasPi && result?.piError) {
      showError(result.piError);
    }
  } catch (e) {
    console.warn("[PI] 模型列表加载失败:", e);
    if (modelDisplay) modelDisplay.textContent = "模型加载失败";
  }
}

// ===================== 模型（只读切换，不做配置） =====================

function renderModelOptions(list, defaultModel) {
  modelSelect.innerHTML = "";
  const pick = (m) => (m.provider ? `${m.provider}:${m.id}` : m.id);
  const seen = new Set();
  const dedupe = (arr) =>
    arr.filter((m) => {
      const v = pick(m);
      if (seen.has(v)) return false;
      seen.add(v);
      return true;
    });

  // pi 的注册表有上千条内置模型，按「可用 / 其他」分组，可用置顶
  const available = dedupe(list.filter((m) => m.available === true));
  const others = dedupe(list.filter((m) => m.available !== true));

  const addGroup = (label, arr) => {
    if (arr.length === 0) return;
    const group = document.createElement("optgroup");
    group.label = label;
    for (const m of arr) {
      const opt = document.createElement("option");
      opt.value = pick(m);
      opt.textContent = m.name || m.id;
      group.appendChild(opt);
    }
    modelSelect.appendChild(group);
  };

  addGroup("可用", available);
  addGroup("其他（未配置密钥）", others);

  // 默认模型：优先 pi 的设置（defaultProvider/defaultModel），否则第一个可用
  currentModelId = defaultModel || (available[0] ? pick(available[0]) : (list[0] ? pick(list[0]) : ""));
  modelSelect.value = currentModelId;
  updateModelDisplay();
  // 模型加载完成后，依据图片支持情况刷新提示与发送按钮态
  updateImageWarn();
  updateSendButtonState();
}

function updateModelDisplay() {
  const selected = modelSelect.selectedOptions?.[0];
  const m = models.find((x) => {
    const v = x.provider ? `${x.provider}:${x.id}` : x.id;
    return v === currentModelId;
  });
  const label = selected?.textContent || m?.name || m?.id || "未选择模型";
  if (modelDisplay) modelDisplay.textContent = label;
}

// ===================== 设置面板（整屏覆盖：左菜单 + 右内容） =====================
//
// 目前只有「模型配置」一页。它直接编辑 **pi 自己的** models.json
// （~/.pi/agent/models.json）——不是插件私有的第二份配置：
//
//   - 写入由后端 model-config.mjs 负责（只替换 providers 字段、写前备份 .bak）；
//   - 内置提供商（pi 自带目录里的 openai / anthropic …）只读展示，
//     它们的密钥走 pi 的 /login（auth.json），插件不去碰；
//   - 不认识的字段（compat / thinkingLevelMap / cost …）收进「高级配置」
//     折叠区原样往返，避免保存一次就把用户的精细化配置抹平。

/** 后端最近一次 listProviders 的结果 */
let providersData = null;
/** 正在编辑的提供商 id；null = 提供商列表页 */
let editingProviderId = null;
/** 是否正在新增（新增时 id 可编辑，编辑时 id 只读） */
let editingIsNew = false;
/** 面板内错误信息（保存/删除失败时显示） */
let settingsError = "";
/** 当前设置页：`"models"`（模型配置）/ `"appearance"`（外观）/ `"plugins"`（插件） */
let settingsPane = "models";

/** 插件页状态 */
let pluginsData = null;       // 后端 listPlugins 的结果
let pluginsError = "";        // 插件页错误
let pluginsBusy = false;      // 安装/卸载进行中
let pluginsProgress = "";     // 进度提示文本
let pluginsSourceDraft = "";  // 「添加插件」输入框草稿（失败时回填）

/** 归一化设置页标识 */
function normalizePane(pane) {
  return pane === "appearance" || pane === "plugins" ? pane : "models";
}

/** 切换设置页（左菜单点击）：切 active 高亮 + 重绘右栏 */
function setSettingsPane(pane) {
  settingsPane = normalizePane(pane);
  // 离开模型页时退出「编辑提供商」子页，回来时是干净的列表
  editingProviderId = null;
  editingIsNew = false;
  updateSettingsNav();
  renderSettingsBody();
  // 首次进入插件页：拉取列表
  if (settingsPane === "plugins" && !pluginsData && !pluginsBusy) {
    void refreshPlugins();
  }
}

/** 同步左菜单高亮与标题 */
function updateSettingsNav() {
  document.querySelectorAll(".pi-settings-nav-item").forEach((el) => {
    el.classList.toggle("active", el.getAttribute("data-pane") === settingsPane);
  });
  if (settingsTitleEl) {
    settingsTitleEl.textContent =
      settingsPane === "appearance" ? "外观" :
      settingsPane === "plugins" ? "插件" : "模型配置";
  }
  // 「配置文件」脚注：模型页显示 models.json，插件页显示 settings.json，外观页隐藏
  const foot = document.querySelector(".pi-settings-nav-foot");
  if (foot) {
    foot.hidden = settingsPane === "appearance";
    const label = foot.querySelector(".pi-settings-nav-foot-label");
    if (label) label.textContent = settingsPane === "plugins" ? "插件配置" : "配置文件";
  }
}

/** 打开设置（同时把提供商列表拉一遍） */
async function openSettings(opts = {}) {
  if (!settingsEl) return;
  settingsError = "";
  editingProviderId = null;
  editingIsNew = false;
  // 默认打开模型配置页；也可指定打开「外观」/「插件」
  settingsPane = normalizePane(opts.pane);
  settingsEl.hidden = false;
  updateSettingsNav();
  settingsBodyEl.innerHTML = "";
  const loading = document.createElement("div");
  loading.className = "pi-settings-empty";
  loading.textContent = settingsPane === "plugins" ? "正在读取 pi 插件列表…" : "正在读取 pi 的模型配置…";
  settingsBodyEl.appendChild(loading);
  if (settingsPane === "plugins") {
    await refreshPlugins();
  } else {
    await refreshProviders();
  }
}

function closeSettings() {
  if (!settingsEl) return;
  settingsEl.hidden = true;
  editingProviderId = null;
  editingIsNew = false;
  settingsError = "";
  settingsPane = "models";
}

function isSettingsOpen() {
  return Boolean(settingsEl) && !settingsEl.hidden;
}

/** 拉取提供商列表并重绘 */
async function refreshProviders() {
  try {
    providersData = await ms.backend.call("listProviders");
  } catch (e) {
    providersData = null;
    settingsError = `读取模型配置失败: ${e.message || e}`;
  }
  renderSettingsBody();
}

function renderSettingsBody() {
  if (!settingsBodyEl) return;
  // 未打开设置时不动 DOM（onThemeChanged / store 回调可能在设置关闭时触发）
  if (settingsEl && settingsEl.hidden) return;
  settingsBodyEl.innerHTML = "";

  // 左栏脚注：告诉用户改的是哪个文件（出问题时知道去哪儿看）
  if (settingsPathEl) {
    if (settingsPane === "plugins") {
      settingsPathEl.textContent = pluginsData?.settingsPath || pluginsData?.agentDir || "—";
      settingsPathEl.title = pluginsData?.settingsPath || "";
    } else {
      settingsPathEl.textContent = providersData?.modelsPath || providersData?.agentDir || "—";
      settingsPathEl.title = providersData?.modelsPath || "";
    }
  }
  updateSettingsNav();

  // 外观页：与模型配置无关，直接渲染
  if (settingsPane === "appearance") {
    renderAppearancePane();
    return;
  }
  // 插件页
  if (settingsPane === "plugins") {
    renderPluginsPane();
    return;
  }

  if (settingsError) {
    settingsBodyEl.appendChild(errorBar(settingsError));
  }
  if (providersData?.fileError) {
    settingsBodyEl.appendChild(errorBar(providersData.fileError));
  }

  if (editingProviderId === null) {
    renderProviderList();
  } else {
    renderProviderDetail();
  }
}

// ---------- 外观（界面主题） ----------

/**
 * 「外观」页：界面主题三选（深色 / 浅色 / 跟随系统）。
 *
 * 为什么必须由宿主配合：插件界面内嵌在搜索窗里，只改插件自己的颜色无法解决
 * 「上方搜索框浅、下方插件深」的割裂；宿主据此把**整个呼出窗口**临时切成该
 * 主题（详见宿主 README「主题兼容」）。因此这里每一项都调 selectTheme →
 * ms.ui.applyTheme，让宿主立即重算并应用。
 */
function renderAppearancePane() {
  const card = document.createElement("div");
  card.className = "pi-appearance";

  const title = document.createElement("div");
  title.className = "pi-appearance-title";
  title.textContent = "界面主题";
  card.appendChild(title);

  const hint = hintEl(
    "选择 pi agent 的界面主题。打开本插件时，整个呼出窗口会跟随此设置（搜索框与插件面板同色）；关闭插件后恢复软件原主题。"
  );
  card.appendChild(hint);

  const group = document.createElement("div");
  group.className = "pi-theme-group";
  for (const opt of THEME_OPTIONS) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "pi-theme-choice";
    item.dataset.theme = opt.value;
    if (themePreference === opt.value) item.classList.add("active");
    item.title = opt.desc;

    const radio = document.createElement("span");
    radio.className = "pi-theme-radio";
    item.appendChild(radio);

    const texts = document.createElement("span");
    texts.className = "pi-theme-choice-texts";
    const label = document.createElement("span");
    label.className = "pi-theme-choice-label";
    label.textContent = opt.label;
    const desc = document.createElement("span");
    desc.className = "pi-theme-choice-desc";
    // 「跟随系统」时把实际跟到的深浅标出来，用户才知道当前是什么效果
    desc.textContent =
      opt.value === "inherit" && themePreference === "inherit"
        ? `${opt.desc}（当前：${effectiveThemeNow() === "dark" ? "深色" : "浅色"}）`
        : opt.desc;
    texts.appendChild(label);
    texts.appendChild(desc);
    item.appendChild(texts);

    item.addEventListener("click", () => selectTheme(opt.value));
    group.appendChild(item);
  }
  card.appendChild(group);

  settingsBodyEl.appendChild(card);
}

// ---------- 插件（pi 包） ----------
//
// 「插件」指 pi 自己的包体系（settings.json 的 packages）：一个包可以携带
// extensions / skills / prompts / themes 四类资源。安装/卸载完全交给后端
// 的 DefaultPackageManager（与 `pi install/remove` 同语义）。

/** 拉取插件列表并重绘 */
async function refreshPlugins() {
  if (pluginsBusy) return;
  pluginsBusy = true;
  pluginsError = "";
  try {
    pluginsData = await ms.backend.call("listPlugins");
  } catch (e) {
    pluginsData = null;
    pluginsError = `读取插件列表失败: ${e.message || e}`;
  } finally {
    pluginsBusy = false;
  }
  renderSettingsBody();
}

/** 从来源字符串推断一个短标签（用于展示） */
function pluginKindLabel(source) {
  const s = String(source || "");
  if (s.startsWith("npm:")) return "npm";
  if (s.startsWith("git:") || /^(https?|ssh|git):\/\//.test(s)) return "git";
  return "本地";
}

/** 插件页整体渲染 */
function renderPluginsPane() {
  const wrap = document.createElement("div");
  wrap.className = "pi-plugins";

  const title = document.createElement("div");
  title.className = "pi-appearance-title";
  title.textContent = "Pi 插件";
  wrap.appendChild(title);

  wrap.appendChild(hintEl(
    "Pi 插件（包）可携带扩展、技能、提示词模板与主题。安装来源与 `pi install` 一致：`npm:@scope/pkg`、`git:github.com/user/repo`、`https://…` 或本地路径。安装/卸载/更新后写入 pi 自己的 settings.json，并会**自动重载已打开的会话**（正在回答的会话会在本轮跑完后重载），无需重启。"
  ));

  if (pluginsError) wrap.appendChild(errorBar(pluginsError));
  if (pluginsProgress) {
    const p = document.createElement("div");
    p.className = "pi-plugins-progress";
    p.textContent = pluginsProgress;
    wrap.appendChild(p);
  }

  // ---- 添加插件 ----
  const addRow = document.createElement("div");
  addRow.className = "pi-plugins-add";
  const input = document.createElement("input");
  input.type = "text";
  input.id = "pi-plugin-source";
  input.placeholder = "例如 npm:pi-mcp-adapter 或 git:github.com/user/repo";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.value = pluginsSourceDraft || "";
  input.disabled = pluginsBusy;
  input.addEventListener("input", () => { pluginsSourceDraft = input.value; });
  addRow.appendChild(input);
  const addBtn = document.createElement("button");
  addBtn.className = "btn-primary pi-plugin-install-btn";
  addBtn.id = "pi-plugin-install";
  addBtn.textContent = pluginsBusy ? "处理中…" : "安装";
  addBtn.disabled = pluginsBusy;
  const doInstall = () => {
    const source = input.value.trim();
    if (!source) {
      ms.ui?.toast?.("请填写插件来源", "error");
      return;
    }
    pluginsSourceDraft = source;
    void installPlugin(source);
  };
  addBtn.addEventListener("click", doInstall);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doInstall();
  });
  addRow.appendChild(addBtn);
  wrap.appendChild(addRow);

  // ---- 已安装列表 ----
  const plugins = pluginsData?.plugins || [];
  const listTitle = document.createElement("div");
  listTitle.className = "pi-settings-section-title";
  listTitle.style.marginTop = "10px";
  listTitle.textContent = `已安装插件（${plugins.length}）`;
  wrap.appendChild(listTitle);

  if (!pluginsData) {
    const empty = document.createElement("div");
    empty.className = "pi-settings-empty";
    empty.textContent = "正在读取…";
    wrap.appendChild(empty);
  } else if (plugins.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pi-settings-empty";
    empty.textContent = "还没有安装插件。在上方输入 npm 包名或 git 仓库地址即可安装。";
    wrap.appendChild(empty);
  } else {
    for (const p of plugins) wrap.appendChild(pluginRow(p));
  }

  // ---- 资源概览（整机实际加载数 + agent 实际能用的工具） ----
  const counts = pluginsData?.counts;
  if (counts) {
    const foot = document.createElement("div");
    foot.className = "pi-plugins-counts";
    foot.textContent =
      `当前已加载：扩展 ${counts.extensions} · 技能 ${counts.skills} · ` +
      `提示词 ${counts.prompts} · 主题 ${counts.themes}`;
    wrap.appendChild(foot);
  }
  // agent 侧口径：让用户确认「这些插件真的接到了 agent 上」
  const at = pluginsData?.agentTools;
  if (at && Array.isArray(at.names)) {
    const extNames = at.names.filter((n) => !BUILTIN_TOOL_NAMES.has(n));
    const foot2 = document.createElement("div");
    foot2.className = "pi-plugins-counts";
    if (at.source === "session") {
      foot2.textContent =
        `agent 当前可用工具 ${at.names.length} 个` +
        (extNames.length ? `（其中插件提供 ${extNames.length} 个：${extNames.join("、")}）` : "（无插件工具）");
    } else if (at.source === "extensions") {
      foot2.textContent =
        `插件提供工具 ${extNames.length} 个` +
        (extNames.length ? `：${extNames.join("、")}` : "（尚未开始会话，打开一个会话后生效）");
    }
    if (foot2.textContent) wrap.appendChild(foot2);
  }

  settingsBodyEl.appendChild(wrap);
}

/** 一行已安装插件 */
function pluginRow(p) {
  const row = document.createElement("div");
  row.className = "pi-provider-row pi-plugin-row";
  row.dataset.pluginSource = p.source;

  const info = document.createElement("div");
  info.className = "pi-provider-info";

  const nameLine = document.createElement("div");
  nameLine.className = "pi-provider-name";
  const nameSpan = document.createElement("span");
  nameSpan.className = "pi-provider-name-text";
  nameSpan.textContent = p.name || p.source;
  nameLine.appendChild(nameSpan);

  const kind = document.createElement("span");
  kind.className = "pi-chip custom";
  kind.textContent = pluginKindLabel(p.source);
  nameLine.appendChild(kind);

  if (p.version) {
    const ver = document.createElement("span");
    ver.className = "pi-chip";
    ver.textContent = "v" + p.version;
    nameLine.appendChild(ver);
  }
  if (p.scope === "project") {
    const sc = document.createElement("span");
    sc.className = "pi-chip builtin";
    sc.textContent = "项目";
    nameLine.appendChild(sc);
  }
  if (!p.installed) {
    const miss = document.createElement("span");
    miss.className = "pi-chip warn";
    miss.textContent = "未安装";
    miss.title = "已在 settings.json 中声明，但磁盘上没有找到安装目录";
    nameLine.appendChild(miss);
  }
  info.appendChild(nameLine);

  const sub = document.createElement("div");
  sub.className = "pi-provider-sub";
  sub.textContent = p.description || p.source;
  if (p.description && p.source && p.description !== p.source) sub.title = p.source;
  info.appendChild(sub);
  row.appendChild(info);

  // 操作：更新 + 卸载
  const actions = document.createElement("div");
  actions.className = "pi-plugin-actions";

  const updateBtn = document.createElement("button");
  updateBtn.className = "pi-back-btn";
  updateBtn.textContent = "更新";
  updateBtn.disabled = pluginsBusy || !p.installed;
  updateBtn.addEventListener("click", () => void updatePlugin(p.source));
  actions.appendChild(updateBtn);

  const removeBtn = document.createElement("button");
  removeBtn.className = "pi-back-btn pi-plugin-remove";
  removeBtn.textContent = "卸载";
  removeBtn.disabled = pluginsBusy;
  removeBtn.addEventListener("click", () => void removePlugin(p));
  actions.appendChild(removeBtn);

  row.appendChild(actions);
  return row;
}

/** pi 内置工具名（用于从工具列表中区分出「插件提供的」工具） */
const BUILTIN_TOOL_NAMES = new Set([
  "read", "bash", "powershell", "edit", "write", "grep", "find", "ls",
]);

/**
 * 插件安装/卸载/更新后，后端会把已打开的会话重载扩展（正在跑的会等本轮结束）。
 * 这里把结果拼成一句提示，让用户知道「有几个会话已经生效 / 有几个还需稍等」。
 */
function reloadHint(res) {
  const reloaded = Number(res?.reloaded) || 0;
  const deferred = Number(res?.deferred) || 0;
  const parts = [];
  if (reloaded > 0) parts.push(`${reloaded} 个会话已生效`);
  if (deferred > 0) parts.push(`${deferred} 个正在回答的会话本轮结束后生效`);
  return parts.length ? `（${parts.join("，")}）` : "";
}

/** 安装一个插件（来源字符串） */
async function installPlugin(source) {
  pluginsBusy = true;
  pluginsError = "";
  pluginsProgress = `正在安装 ${source} …`;
  renderSettingsBody();
  try {
    const res = await ms.backend.call("installPlugin", { source });
    pluginsProgress = "";
    pluginsSourceDraft = "";
    ms.ui?.toast?.(`已安装：${source}${reloadHint(res)}`);
  } catch (e) {
    pluginsError = `安装失败: ${e.message || e}`;
    // 失败时把来源回填到输入框，避免用户重新输入
    pluginsSourceDraft = source;
  } finally {
    pluginsBusy = false;
    pluginsProgress = "";
    await refreshPlugins();
  }
}

/** 卸载一个插件 */
async function removePlugin(p) {
  const label = p.name || p.source;
  let ok = true;
  if (typeof ms.ui?.confirm === "function") {
    ok = await ms.ui.confirm(
      `卸载插件「${label}」？\n将从 pi 的 settings.json 移除并删除已安装文件（${p.source}）。`
    );
  }
  if (!ok) return;
  pluginsBusy = true;
  pluginsError = "";
  pluginsProgress = `正在卸载 ${p.source} …`;
  renderSettingsBody();
  try {
    const res = await ms.backend.call("removePlugin", { source: p.source });
    ms.ui?.toast?.(`已卸载：${label}${reloadHint(res)}`);
  } catch (e) {
    pluginsError = `卸载失败: ${e.message || e}`;
  } finally {
    pluginsBusy = false;
    pluginsProgress = "";
    await refreshPlugins();
  }
}

/** 更新一个插件 */
async function updatePlugin(source) {
  pluginsBusy = true;
  pluginsError = "";
  pluginsProgress = `正在更新 ${source} …`;
  renderSettingsBody();
  try {
    const res = await ms.backend.call("updatePlugin", { source });
    ms.ui?.toast?.(`已更新：${source}${reloadHint(res)}`);
  } catch (e) {
    pluginsError = `更新失败: ${e.message || e}`;
  } finally {
    pluginsBusy = false;
    pluginsProgress = "";
    await refreshPlugins();
  }
}

function errorBar(text) {
  const div = document.createElement("div");
  div.className = "pi-settings-error";
  div.textContent = text;
  return div;
}

function hintEl(text, { withCode = false } = {}) {
  const div = document.createElement("div");
  div.className = "pi-settings-hint";
  if (withCode) {
    const parts = String(text).split("`");
    parts.forEach((part, i) => {
      if (i % 2 === 1) {
        const code = document.createElement("code");
        code.textContent = part;
        div.appendChild(code);
      } else if (part) {
        div.appendChild(document.createTextNode(part));
      }
    });
  } else {
    div.textContent = text;
  }
  return div;
}

// ---------- 提供商列表 ----------

function renderProviderList() {
  if (!providersData) {
    const empty = document.createElement("div");
    empty.className = "pi-settings-empty";
    empty.textContent = "无法读取模型配置";
    settingsBodyEl.appendChild(empty);
    return;
  }
  if (providersData.fileError) {
    // 文件坏了就不要再让用户往里写（后端也会拒绝）
    return;
  }

  const addBtn = document.createElement("button");
  addBtn.className = "btn-primary pi-add-provider-btn";
  addBtn.id = "pi-add-provider";
  addBtn.textContent = "＋ 新增提供商";
  addBtn.addEventListener("click", () => {
    editingProviderId = "";
    editingIsNew = true;
    settingsError = "";
    renderSettingsBody();
  });
  settingsBodyEl.appendChild(addBtn);

  // 自定义（models.json 里的，可编辑）
  const custom = providersData.custom || [];
  const customTitle = document.createElement("div");
  customTitle.className = "pi-settings-section-title";
  customTitle.textContent = `自定义提供商（${custom.length}）`;
  settingsBodyEl.appendChild(customTitle);

  if (custom.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pi-settings-empty";
    empty.textContent = "还没有自定义提供商。点上面「新增提供商」接入 Ollama、vLLM、第三方中转等。";
    settingsBodyEl.appendChild(empty);
  } else {
    for (const p of custom) settingsBodyEl.appendChild(providerRow(p));
  }

  // 内置（pi 自带目录，只读）
  const builtin = providersData.builtin || [];
  const builtinTitle = document.createElement("div");
  builtinTitle.className = "pi-settings-section-title";
  builtinTitle.style.marginTop = "8px";
  builtinTitle.textContent = `内置提供商（${builtin.length}）`;
  settingsBodyEl.appendChild(builtinTitle);
  settingsBodyEl.appendChild(
    hintEl("pi 自带的提供商目录，密钥请用 pi 的 /login 配置（存在 auth.json）。这里只读展示。")
  );
  for (const p of builtin) settingsBodyEl.appendChild(providerRow(p));
}

/** 一行提供商（自定义可点进详情；内置只读） */
function providerRow(p) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "pi-provider-row" + (p.builtin ? " builtin" : "");
  row.dataset.providerId = p.id;

  const info = document.createElement("div");
  info.className = "pi-provider-info";

  const nameLine = document.createElement("div");
  nameLine.className = "pi-provider-name";
  const nameSpan = document.createElement("span");
  nameSpan.className = "pi-provider-name-text";
  nameSpan.textContent = p.name || p.id;
  nameLine.appendChild(nameSpan);
  const chip = document.createElement("span");
  chip.className = "pi-chip " + (p.builtin ? "builtin" : "custom");
  chip.textContent = p.builtin ? "内置" : "自定义";
  nameLine.appendChild(chip);
  if (p.authConfigured) {
    const ok = document.createElement("span");
    ok.className = "pi-chip ok";
    // 从环境变量取密钥时明确写出变量名——用户一眼能看出「密钥没存在这里」
    const fromEnv = p.authSource === "environment";
    ok.textContent = fromEnv && p.authLabel ? `环境变量 ${p.authLabel}` : "已配密钥";
    if (fromEnv) ok.classList.add("env");
    if (fromEnv) ok.title = "该提供商的 apiKey 引用宿主环境变量（设置 → 环境变量）";
    nameLine.appendChild(ok);
  }
  info.appendChild(nameLine);

  const sub = document.createElement("div");
  sub.className = "pi-provider-sub";
  if (p.builtin) {
    sub.textContent = `${p.modelCount} 个模型 · 可用 ${p.availableCount}` +
      (p.sampleModels?.length ? ` · ${p.sampleModels.slice(0, 3).join(", ")}…` : "");
  } else {
    const bits = [p.baseUrl || "（未填 Base URL）", `${p.models?.length || 0} 个模型`];
    sub.textContent = bits.join(" · ");
  }
  info.appendChild(sub);
  row.appendChild(info);

  if (!p.builtin) {
    const arrow = document.createElement("span");
    arrow.className = "pi-provider-arrow";
    arrow.textContent = "›";
    row.appendChild(arrow);
    row.addEventListener("click", () => {
      editingProviderId = p.id;
      editingIsNew = false;
      settingsError = "";
      renderSettingsBody();
    });
  }
  return row;
}

// ---------- 提供商详情（表单） ----------

function renderProviderDetail() {
  const isNew = editingIsNew;
  const existing = isNew ? null : (providersData?.custom || []).find((p) => p.id === editingProviderId);

  // 工具条：返回 + 标题状态
  const toolbar = document.createElement("div");
  toolbar.className = "pi-settings-toolbar";
  const back = document.createElement("button");
  back.className = "pi-back-btn";
  back.id = "pi-settings-back";
  back.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>返回列表';
  back.addEventListener("click", () => {
    editingProviderId = null;
    editingIsNew = false;
    settingsError = "";
    renderSettingsBody();
  });
  toolbar.appendChild(back);
  const spacer = document.createElement("div");
  spacer.className = "pi-spacer";
  toolbar.appendChild(spacer);
  settingsBodyEl.appendChild(toolbar);

  settingsBodyEl.appendChild(
    hintEl(isNew
      ? "新增的提供商会写进 pi 的 models.json。填好 Base URL、API 类型与 API Key 后保存即可在底部模型列表里看到。"
      : "修改会直接写进 pi 的 models.json（原文件先备份为 models.json.bak）。")
  );

  // ---- 提供商字段 ----
  const idField = field("提供商 ID", "pi-provider-id", "例如 ollama / my-proxy", existing?.id ?? "");
  idField.input.disabled = !isNew;
  if (!isNew) idField.input.title = "ID 建好后不可修改（改名请删除后新建）";
  settingsBodyEl.appendChild(idField.wrap);

  const nameField = field("显示名称（可选）", "pi-provider-name", "例如 Ollama（本地）", existing?.name ?? "");
  settingsBodyEl.appendChild(nameField.wrap);

  const urlField = field("Base URL", "pi-provider-baseurl", "例如 http://localhost:11434/v1", existing?.baseUrl ?? "");
  settingsBodyEl.appendChild(urlField.wrap);

  settingsBodyEl.appendChild(apiSelectField(existing?.api || "", providersData?.supportedApis || []));

  const keyField = secretField("API Key", "pi-provider-apikey", existing?.hasApiKey ? "" : "", existing);
  settingsBodyEl.appendChild(keyField.wrap);

  // ---- 高级配置（提供商级） ----
  const provAdvanced = textareaAdvanced(
    "高级配置（provider）",
    existing?.advanced || {},
    "providers.<id> 上除 name/baseUrl/api/apiKey/models 之外的字段，例如 headers、compat、authHeader。"
  );
  settingsBodyEl.appendChild(provAdvanced.wrap);

  // ---- 模型列表 ----
  const modelsTitle = document.createElement("div");
  modelsTitle.className = "pi-settings-section-title";
  modelsTitle.style.marginTop = "6px";
  modelsTitle.textContent = `模型（${existing?.models?.length ?? 0}）`;
  settingsBodyEl.appendChild(modelsTitle);

  const modelCards = [];
  const modelsWrap = document.createElement("div");
  modelsWrap.id = "pi-provider-models";
  const removeCard = (card) => {
    const idx = modelCards.indexOf(card);
    if (idx >= 0) modelCards.splice(idx, 1);
  };
  const initialModels = existing?.models?.length ? existing.models : [];
  for (const m of initialModels) {
    const card = modelCard(m, removeCard);
    modelCards.push(card);
    modelsWrap.appendChild(card.el);
  }
  settingsBodyEl.appendChild(modelsWrap);

  const addModelBtn = document.createElement("button");
  addModelBtn.className = "pi-add-model-btn";
  addModelBtn.id = "pi-add-model";
  addModelBtn.textContent = "＋ 添加模型";
  addModelBtn.addEventListener("click", () => {
    const card = modelCard({ id: "", reasoning: false, input: [], advanced: {} }, removeCard);
    modelCards.push(card);
    modelsWrap.appendChild(card.el);
    card.idInput.focus();
  });
  settingsBodyEl.appendChild(addModelBtn);

  // ---- 底部操作 ----
  const actions = document.createElement("div");
  actions.className = "pi-settings-actions";
  actions.style.marginTop = "10px";

  if (!isNew) {
    const del = document.createElement("button");
    del.className = "pi-btn-danger";
    del.id = "pi-delete-provider";
    del.textContent = "删除提供商";
    del.addEventListener("click", () => deleteProvider(existing));
    actions.appendChild(del);
  }
  const aSpacer = document.createElement("div");
  aSpacer.className = "pi-spacer";
  actions.appendChild(aSpacer);

  const cancel = document.createElement("button");
  cancel.className = "btn-secondary";
  cancel.id = "pi-cancel-provider";
  cancel.textContent = "取消";
  cancel.addEventListener("click", () => {
    editingProviderId = null;
    editingIsNew = false;
    settingsError = "";
    renderSettingsBody();
  });
  actions.appendChild(cancel);

  const save = document.createElement("button");
  save.className = "btn-primary";
  save.id = "pi-save-provider";
  save.textContent = "保存";
  save.addEventListener("click", () => {
    void saveProvider({
      id: idField.input.value,
      name: nameField.input.value,
      baseUrl: urlField.input.value,
      api: apiSelectInputValue(settingsBodyEl),
      apiKeyInput: keyField.input,
      apiKeyExisting: keyField.hasExisting,
      advanced: provAdvanced.textarea,
      models: modelCards,
      saveBtn: save,
    });
  });
  actions.appendChild(save);
  settingsBodyEl.appendChild(actions);
}

/** 一个带 label 的文本输入 */
function field(labelText, id, placeholder, value) {
  const wrap = document.createElement("div");
  wrap.className = "pi-field";
  const label = document.createElement("label");
  label.textContent = labelText;
  label.setAttribute("for", id);
  wrap.appendChild(label);
  const input = document.createElement("input");
  input.type = "text";
  input.id = id;
  input.placeholder = placeholder || "";
  input.value = value ?? "";
  input.spellcheck = false;
  input.autocomplete = "off";
  wrap.appendChild(input);
  return { wrap, input };
}

function apiSelectField(value, apis) {
  const wrap = document.createElement("div");
  wrap.className = "pi-field";
  const label = document.createElement("label");
  label.textContent = "API 类型";
  wrap.appendChild(label);
  const select = document.createElement("select");
  select.id = "pi-provider-api";
  const optBlank = document.createElement("option");
  optBlank.value = "";
  optBlank.textContent = "（每个模型单独指定）";
  select.appendChild(optBlank);
  for (const api of apis) {
    const opt = document.createElement("option");
    opt.value = api;
    opt.textContent = api;
    select.appendChild(opt);
  }
  select.value = value || "";
  wrap.appendChild(select);
  return wrap;
}

/** 下拉当前值（单独取，避免把 select 混进 field() 的 input 语义里） */
function apiSelectInputValue(root) {
  return root.querySelector("#pi-provider-api")?.value || "";
}

/**
 * API Key 输入框。
 *
 * 已经存在密钥时**不回显**（后端只回 hasApiKey 布尔）：留空 = 不改动，
 * 填了才覆盖。这样面板不会把别人的密钥明文摊在屏幕上。
 *
 * 还有第三条路：**引用宿主集中维护的环境变量**（设置 → 环境变量）。
 * 点右侧「变量」按钮 → 宿主弹出可搜索的授权面板 → 选中后这里填入 `$NAME`，
 * 由 pi 在请求时从**后端进程环境**解析（宿主会在 spawn 时把已授权的变量
 * 注入进程 env，见宿主 `env-store.ts`）。因此密钥不必存进 models.json，
 * 也不会出现在本插件的 JS 上下文里。
 */
function secretField(labelText, id, value, existing) {
  const wrap = document.createElement("div");
  wrap.className = "pi-field";
  const label = document.createElement("label");
  label.textContent = labelText;
  label.setAttribute("for", id);
  wrap.appendChild(label);

  const secretWrap = document.createElement("div");
  secretWrap.className = "pi-secret-wrap";
  const input = document.createElement("input");
  input.type = "password";
  input.id = id;
  input.spellcheck = false;
  input.autocomplete = "off";
  input.value = value ?? "";
  input.placeholder = existing?.hasApiKey ? "已配置，留空表示不修改" : "例如 sk-…（本地服务可填任意占位值）";
  secretWrap.appendChild(input);

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "pi-secret-toggle";
  toggle.textContent = "显示";
  toggle.addEventListener("click", () => {
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    toggle.textContent = show ? "隐藏" : "显示";
  });
  secretWrap.appendChild(toggle);

  /**
   * 「变量」按钮：打开宿主的授权选择器。
   *
   * 只有宿主提供 `ms.env.pick` 时才显示——独立调试（无宿主）时按钮不出现，
   * 面板保持原样可用。
   */
  let envRefNote = null;
  if (ms?.env && typeof ms.env.pick === "function") {
    const pickBtn = document.createElement("button");
    pickBtn.type = "button";
    pickBtn.className = "pi-secret-pick";
    pickBtn.id = id + "-pick";
    pickBtn.title = "从「设置 → 环境变量」中选择（推荐：密钥不落这里）";
    pickBtn.textContent = "变量";
    pickBtn.addEventListener("click", async () => {
      try {
        const picked = await ms.env.pick({
          title: "选择 API Key 来源",
          purpose: "该提供商的 apiKey 将引用这个环境变量",
        });
        if (!picked) return;
        if (picked.kind === "ref") {
          input.type = "text";
          toggle.textContent = "隐藏";
          input.value = picked.ref; // 形如 $MY_KEY
          showEnvNote(picked.name);
        } else if (picked.kind === "literal") {
          input.value = picked.value;
          hideEnvNote();
        }
      } catch (e) {
        ms.ui?.toast?.("选择环境变量失败：" + String(e?.message || e), "error");
      }
    });
    secretWrap.appendChild(pickBtn);
  }

  wrap.appendChild(secretWrap);

  /** 输入框下方的提示条：明确告诉用户「这里存的是引用，不是密钥」 */
  function showEnvNote(name) {
    if (!envRefNote) {
      envRefNote = document.createElement("div");
      envRefNote.className = "pi-field-note";
      wrap.appendChild(envRefNote);
    }
    envRefNote.textContent = `引用环境变量 ${name}：密钥由宿主在后台进程里注入，不会写入 models.json`;
  }
  function hideEnvNote() {
    if (envRefNote) {
      envRefNote.remove();
      envRefNote = null;
    }
  }

  // 已有配置就是从环境变量取的（后端回了 authSource）→ 进来就显示提示
  if (existing?.authSource === "environment") {
    showEnvNote(existing.authLabel || "（环境变量）");
  }

  return { wrap, input, hasExisting: Boolean(existing?.hasApiKey) };
}

/** 「高级配置」折叠区：JSON 文本编辑 */
function textareaAdvanced(title, value, hint) {
  const details = document.createElement("details");
  details.className = "pi-advanced";
  const hasContent = value && Object.keys(value).length > 0;
  if (hasContent) details.open = true;

  const summary = document.createElement("summary");
  summary.textContent = `${title}${hasContent ? `（${Object.keys(value).length} 项）` : "（无）"}`;
  details.appendChild(summary);

  const body = document.createElement("div");
  body.className = "pi-advanced-body";
  body.appendChild(hintEl(hint || ""));
  const textarea = document.createElement("textarea");
  textarea.className = "pi-advanced-json";
  textarea.spellcheck = false;
  textarea.value = hasContent ? JSON.stringify(value, null, 2) : "";
  textarea.placeholder = "{\n  // 留空表示不设置\n}";
  body.appendChild(textarea);
  details.appendChild(body);

  return { wrap: details, textarea };
}

/** 单个模型卡片；`onRemove` 由调用方传入（卡片不自己维护列表） */
function modelCard(m, onRemove) {
  const el = document.createElement("div");
  el.className = "pi-model-card";

  const head = document.createElement("div");
  head.className = "pi-model-card-head";
  const title = document.createElement("div");
  title.className = "pi-model-card-title";
  title.textContent = m.id || "新模型";
  head.appendChild(title);

  if (m.available === true) {
    const chip = document.createElement("span");
    chip.className = "pi-chip ok";
    chip.textContent = "可用";
    head.appendChild(chip);
  }

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "pi-icon-btn pi-remove-model";
  remove.title = "删除这个模型";
  remove.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg>';
  head.appendChild(remove);
  el.appendChild(head);

  const idField = field("模型 ID", "", "例如 llama3.1:8b", m.id ?? "");
  idField.input.classList.add("pi-model-id");
  el.appendChild(idField.wrap);
  idField.input.addEventListener("input", () => {
    title.textContent = idField.input.value || "新模型";
  });

  const nameField = field("显示名（可选）", "", "例如 Llama 3.1 8B", m.name ?? "");
  nameField.input.classList.add("pi-model-name");
  el.appendChild(nameField.wrap);

  const row = document.createElement("div");
  row.className = "pi-field-row";
  const ctxField = field("上下文窗口", "", "例如 128000", m.contextWindow ?? "");
  ctxField.input.classList.add("pi-model-context");
  const maxField = field("最大输出", "", "例如 16384", m.maxTokens ?? "");
  maxField.input.classList.add("pi-model-maxtokens");
  row.appendChild(ctxField.wrap);
  row.appendChild(maxField.wrap);
  el.appendChild(row);

  const opts = document.createElement("div");
  opts.className = "pi-field";
  opts.style.flexDirection = "row";
  opts.style.gap = "16px";

  const reasoningLabel = document.createElement("label");
  reasoningLabel.className = "pi-check-row";
  const reasoningInput = document.createElement("input");
  reasoningInput.type = "checkbox";
  reasoningInput.classList.add("pi-model-reasoning");
  reasoningInput.checked = m.reasoning === true;
  reasoningLabel.appendChild(reasoningInput);
  reasoningLabel.appendChild(document.createTextNode("支持推理（reasoning）"));
  opts.appendChild(reasoningLabel);

  const imageLabel = document.createElement("label");
  imageLabel.className = "pi-check-row";
  const imageInput = document.createElement("input");
  imageInput.type = "checkbox";
  imageInput.classList.add("pi-model-image");
  imageInput.checked = Array.isArray(m.input) && m.input.includes("image");
  imageLabel.appendChild(imageInput);
  imageLabel.appendChild(document.createTextNode("支持图片输入"));
  opts.appendChild(imageLabel);
  el.appendChild(opts);

  const advanced = textareaAdvanced("高级配置（模型）", m.advanced || {},
    "该模型上除 id/name/api/reasoning/input/contextWindow/maxTokens 之外的字段，例如 cost、thinkingLevelMap、samplingParams。");
  el.appendChild(advanced.wrap);

  remove.addEventListener("click", () => {
    el.remove();
    if (onRemove) onRemove(card);
  });

  const card = {
    el,
    idInput: idField.input,
    nameInput: nameField.input,
    contextInput: ctxField.input,
    maxInput: maxField.input,
    reasoningInput,
    imageInput,
    advancedTextarea: advanced.textarea,
  };
  return card;
}

/** 把一张模型卡片读成后端要的对象；JSON 非法时抛带字段名的 Error */
function readModelCard(card) {
  const id = card.idInput.value.trim();
  if (!id) throw new Error("有模型没填 ID");

  const out = { id };
  const name = card.nameInput.value.trim();
  if (name) out.name = name;
  if (card.reasoningInput.checked) out.reasoning = true;

  const input = [];
  if (card.imageInput.checked) input.push("image");
  if (input.length) out.input = ["text", ...input];

  const ctx = card.contextInput.value.trim();
  if (ctx) out.contextWindow = Number(ctx);
  const max = card.maxInput.value.trim();
  if (max) out.maxTokens = Number(max);

  const advanced = parseAdvancedJson(card.advancedTextarea, `模型 ${id}`);
  if (advanced && Object.keys(advanced).length) out.advanced = advanced;
  return out;
}

/** 解析「高级配置」JSON 文本；空 = {}；非法抛 Error（不会发请求） */
function parseAdvancedJson(textarea, label) {
  const raw = textarea.value.trim();
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${label}的高级配置不是合法 JSON: ${e.message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label}的高级配置必须是 JSON 对象`);
  }
  return parsed;
}

/** 保存当前表单里的提供商 */
async function saveProvider(form) {
  settingsError = "";
  let provider;
  let keepApiKey = false;
  try {
    const id = String(form.id ?? "").trim();
    if (!id) throw new Error("请填写提供商 ID");

    provider = { models: form.models.map(readModelCard) };
    const name = String(form.name ?? "").trim();
    if (name) provider.name = name;
    const baseUrl = String(form.baseUrl ?? "").trim();
    if (baseUrl) provider.baseUrl = baseUrl;
    const api = apiSelectInputValue(settingsBodyEl);
    if (api) provider.api = api;

    const typedKey = String(form.apiKeyInput?.value ?? "").trim();
    if (typedKey) provider.apiKey = typedKey;
    else if (form.apiKeyExisting) keepApiKey = true;

    const advanced = parseAdvancedJson(form.advanced, "提供商");
    if (Object.keys(advanced).length) provider.advanced = advanced;
  } catch (e) {
    settingsError = e.message || String(e);
    renderSettingsBody();
    return;
  }

  if (form.saveBtn) {
    form.saveBtn.disabled = true;
    form.saveBtn.textContent = "保存中…";
  }
  try {
    const id = String(form.id).trim();
    await ms.backend.call("saveProvider", { id, provider, keepApiKey });
    await loadModels();
    editingProviderId = null;
    editingIsNew = false;
    await refreshProviders();
    if (typeof ms.ui?.toast === "function") ms.ui.toast("模型配置已保存");
  } catch (e) {
    settingsError = `保存失败: ${e.message || e}`;
    renderSettingsBody();
  }
}

/** 删除一个提供商（二次确认） */
async function deleteProvider(p) {
  if (!p) return;
  let ok = true;
  if (typeof ms.ui?.confirm === "function") {
    ok = await ms.ui.confirm(`删除提供商「${p.name || p.id}」？（会从 models.json 里移除，原文件备份为 models.json.bak）`);
  }
  if (!ok) return;

  settingsError = "";
  try {
    await ms.backend.call("deleteProvider", { id: p.id });
    await loadModels();
    editingProviderId = null;
    editingIsNew = false;
    await refreshProviders();
    if (typeof ms.ui?.toast === "function") ms.ui.toast("提供商已删除");
  } catch (e) {
    settingsError = `删除失败: ${e.message || e}`;
    renderSettingsBody();
  }
}

// ===================== 项目（最左侧图标栏） =====================
async function loadProjects() {
  try {
    const result = await ms.backend.call("listProjects");
    projects = result?.projects || [];
    renderProjects();
    if (projects.length > 0) {
      // 优先恢复上次保存的状态，回退到最近打开的项目
      const savedProject = savedState.projectPath
        ? projects.find((p) => p.path === savedState.projectPath) : null;
      if (savedProject) {
        await selectProject(savedProject.path);
      } else {
        const last = [...projects].sort(
          (a, b) => String(b.lastOpenedAt || "").localeCompare(String(a.lastOpenedAt || ""))
        )[0];
        await selectProject(last.path);
      }
    } else {
      sessionsLoading = false;
      renderSessions();
    }
  } catch (e) {
    sessionsLoading = false;
    renderSessions();
    showError(`加载项目失败: ${e.message || e}`);
  }
}

/** 项目图标显示名：取文件夹名首字母/前两位 */
function projectLabel(p) {
  const name = String(p.name || "").trim();
  if (!name) return "?";
  const letters = name.match(/[A-Za-z0-9]/g);
  if (letters && letters.length >= 2 && /^[\x00-\x7F]/.test(name)) {
    return (letters[0] + letters[1]).toUpperCase();
  }
  return name.slice(0, 2);
}

/**
 * 项目待办计数：处理中 / 已完成未读 / 待回答。
 *
 * 当前项目以内存 `sessions[].flag` 为准（切会话、跑完、已读都会实时改写它，
 * 比后端轮询更快）；拿不到内存数据时回退到后端 listProjects 带回来的计数。
 * 其它项目只能以后端计数为准。
 *
 * 「待回答」：以内存账本 pendingAskBySession 为准（收到 chat:ask / chat:ask-cleared
 * 即时改写，最快），但**取两者较大值**兜底——若 ask 是别处（如终端里的 pi）触发的、
 * 本前端没收到通知，账本会漏记，此时后端的 askCount（getAskCounts 带回）能补上。
 */
function projectFlags(p) {
  const isCurrent = currentProject?.path === p.path;
  if (isCurrent && sessions.length > 0) {
    let running = 0;
    let unseen = 0;
    let asking = 0;
    for (const s of sessions) {
      if (pendingAskBySession.has(s.id)) asking += 1;
      if (s.flag === "running") running += 1;
      else if (s.flag === "unseen") unseen += 1;
      else if (s.pending) unseen += 1; // 尚未开始的草稿按「未读」归类，与后端口径一致
    }
    // 后端计数兜底：账本漏记（通知丢失/别处触发）时也能亮出黄问号。
    // 取 max 而非相加，避免同一批 ask 被两边重复计数。
    if (Number.isFinite(p.askCount)) asking = Math.max(asking, p.askCount);
    return { running, unseen, asking };
  }
  const running = Number.isFinite(p.runningCount) ? p.runningCount : 0;
  const unseen = Number.isFinite(p.unseenCount) ? p.unseenCount : 0;
  const asking = Number.isFinite(p.askCount) ? p.askCount : 0;
  return { running, unseen, asking };
}

function renderProjects() {
  projectListEl.innerHTML = "";
  if (projects.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pi-sidebar-empty";
    empty.textContent = "点击下方 + 添加项目";
    projectListEl.appendChild(empty);
    return;
  }

  for (const p of projects) {
    const icon = document.createElement("div");
    icon.className = "project-icon" + (currentProject?.path === p.path ? " active" : "");
    icon.title = `${p.name || p.path}\n${p.path}\n（右键：标为已读 / 移除项目）`;
    icon.textContent = projectLabel(p);

    const { running, unseen, asking } = projectFlags(p);

    // 状态圆点：只画一个。优先级（高者覆盖低者）：
    //   1. 有待回答的 ask → 黄问号（最需要用户动作，必须压过其它提示）
    //   2. 有已完未读 → 绿点（数字=未读数）
    //   3. 只有处理中 → 黄点（数字=处理中数）
    // 绿点时若还有处理中的会话，描边换成黄色提示「有活跃的」。
    //（不再有「处理失败」红点：一轮进行中与真·中断从文件上无法区分，已按
    // pi-web 口径去掉该态，报错原因改由 chat:error 实时提示。）
    if (asking > 0) {
      const dot = document.createElement("span");
      dot.className = "project-status-dot yellow ask";
      dot.textContent = "?";
      dot.title = asking > 1 ? `${asking} 个会话有待回答的问题` : "这个项目有会话在等你回答";
      icon.appendChild(dot);
    } else if (unseen > 0) {
      const dot = document.createElement("span");
      dot.className = "project-status-dot green" + (running > 0 ? " has-running" : "");
      dot.textContent = unseen > 99 ? "99+" : String(unseen);
      dot.title = running > 0 ? `已完成未读 ${unseen}（另有 ${running} 个处理中）` : `已完成未读 ${unseen}`;
      icon.appendChild(dot);
    } else if (running > 0) {
      const dot = document.createElement("span");
      dot.className = "project-status-dot yellow";
      dot.textContent = running > 99 ? "99+" : String(running);
      dot.title = `处理中 ${running}`;
      icon.appendChild(dot);
    }

    icon.addEventListener("click", () => selectProject(p.path));
    icon.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openProjectMenu(p, e.clientX, e.clientY);
    });
    projectListEl.appendChild(icon);
  }
}

/**
 * 项目图标右键菜单：目前两项
 *   - 「全部标为已读」：把该项目下所有未查看会话清掉（绿角标归零）
 *   - 「移除项目」：从列表移除（不删磁盘文件）
 *
 * 用一次性浮层实现：点菜单外任意处 / Esc / 选中任一项后自动关闭。坐标取右键
 * 时的 clientX/clientY，菜单相对插件容器绝对定位（宿主会把整个插件面板作为
 * 一个定位上下文）。
 */
function openProjectMenu(p, x, y) {
  closeProjectMenu();
  const menu = document.createElement("div");
  menu.className = "pi-project-menu";
  menu.id = "pi-project-menu";

  const markBtn = document.createElement("button");
  markBtn.type = "button";
  markBtn.className = "pi-project-menu-item";
  markBtn.textContent = "全部标为已读";
  markBtn.addEventListener("click", () => {
    closeProjectMenu();
    void markProjectAllRead(p);
  });
  menu.appendChild(markBtn);

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "pi-project-menu-item danger";
  removeBtn.textContent = "移除项目";
  removeBtn.addEventListener("click", () => {
    closeProjectMenu();
    void removeProject(p);
  });
  menu.appendChild(removeBtn);

  // 定位：用 position: fixed + 视口坐标（右键时的 clientX/clientY）。
  // 挂到插件根容器里（保留容器上定义的 CSS 变量与主题色），但用 fixed 定位——
  // 容器有 overflow:hidden，若用 absolute 会被裁掉；fixed 相对视口定位，
  // overflow:hidden 的祖先不会裁剪它（只有 transform/filter 会，此处没有）。
  // 贴边时下一帧量尺寸往回收。
  const root = document.getElementById("pi-agent") || document.body;
  menu.style.position = "fixed";
  menu.style.left = x + "px";
  menu.style.top = y + "px";
  root.appendChild(menu);

  requestAnimationFrame(() => {
    const mw = menu.offsetWidth || 0;
    const mh = menu.offsetHeight || 0;
    const maxLeft = window.innerWidth - mw - 8;
    const maxTop = window.innerHeight - mh - 8;
    menu.style.left = Math.max(4, Math.min(x, maxLeft)) + "px";
    menu.style.top = Math.max(4, Math.min(y, maxTop)) + "px";
  });

  // 关闭时机：点外面（含其它元素）/ Esc / 滚动
  setTimeout(() => {
    document.addEventListener("mousedown", onDocDown, true);
    document.addEventListener("keydown", onDocKey, true);
  }, 0);

  function onDocDown(ev) {
    if (!menu.contains(ev.target)) closeProjectMenu();
  }
  function onDocKey(ev) {
    if (ev.key === "Escape") closeProjectMenu();
  }
  menu.__cleanup = () => {
    document.removeEventListener("mousedown", onDocDown, true);
    document.removeEventListener("keydown", onDocKey, true);
  };
}

function closeProjectMenu() {
  const menu = document.getElementById("pi-project-menu");
  if (!menu) return;
  if (typeof menu.__cleanup === "function") menu.__cleanup();
  menu.remove();
}

/**
 * 把一个项目下所有会话标为已读（清掉绿角标）。
 *
 * 若操作的是当前项目，还要把内存里 sessions[].flag 一并清掉并重渲染——后端 seen
 * 表改了，但当前项目圆点/列表以内存 flag 为准，不就地更新的话要等轮询才反映出来。
 * 非当前项目直接刷新项目列表拿到后端重算后的计数。
 *
 * 注意：不管后端还是本地都要把「草稿（pending）」一并消掉。草稿本身不是
 * 「未读」，但它被算进角标（见 projectFlags / isPendingSession），只清 unseen
 * 会让角标看着“读不完”。
 */
async function markProjectAllRead(p) {
  if (!p) return;
  try {
    await ms.backend.call("markAllViewed", { projectPath: p.path });
    if (currentProject?.path === p.path) {
      // 未读 + 草稿都归位；没有 failed 这个态可清。
      for (const s of sessions) {
        if (s.flag === "unseen") s.flag = null;
        if (s.pending) s.pending = false;
      }
      if (Number.isFinite(currentProject.badgeCount)) {
        currentProject.badgeCount = Math.max(0, countFlaggedSessions());
      }
      renderSessions();
      renderProjects();
      // 拉一次会话列表以后端为准（清掉可能残留的 flag，避免“角标清了但列表
      // 还挂着未读”或反之的错位）。不用 loadSessions：它会重新选中会话、
      // 重载转录；refreshSessionMeta 只刷元信息。
      await refreshSessionMeta({ force: true });
    }
    await loadProjects();
    if (typeof ms.ui?.toast === "function") ms.ui.toast("已全部标为已读");
  } catch (e) {
    showError(`标为已读失败: ${e.message || e}`);
  }
}

/** 当前项目里「进行中 + 已完成未查看 + 尚未开始」的会话数（后端已算好，缺失时本地兜底） */
function countFlaggedSessions() {
  return sessions.filter(isPendingSession).length;
}

async function selectProject(projectPath) {
  const p = projects.find((x) => x.path === projectPath);
  if (!p) return;
  if (currentProject?.path === projectPath) return;

  // 切换项目时立即保存状态
  savedState.projectPath = projectPath;
  savedState.sessionId = "";

  // 离开当前会话前，暂存未提交卡片的选择（同会话切换，切回来能回填）
  if (currentSessionId) archiveCurrentAskState();

  currentProject = p;
  currentSessionId = null;
  // 切项目 = 离开原来的会话：清空后端的「当前打开会话」，旧的跑完能正常算未读
  void ms.backend.call("setActiveSession", {}).catch(() => {});
  sessions = [];
  loadedMessages = [];
  renderedFrom = -1;
  renderedFromEnd = 0;
  sessionVisibleCount = SESSIONS_PER_PAGE;
  sessionsLoading = true;
  renderProjects();
  renderSessions();
  clearChat();
  setSendButtonRunning(false);
  showWelcome("Pi Agent", "正在加载会话…");

  await loadSessions();
  // 切过来后同步一次各项目待回答计数：本项目的黄问号随后会由 restoreAskCard /
  // 内存账本接管，这里主要是让**其它项目**的问号保持准（同时也是首次进入的兜底）。
  void refreshAskCounts();
}

async function removeProject(p) {
  let ok = true;
  if (typeof ms.ui?.confirm === "function") {
    ok = await ms.ui.confirm(`移除项目「${p.name || p.path}」？（不会删除磁盘上的文件）`);
  }
  if (!ok) return;
  try {
    await ms.backend.call("removeProject", { path: p.path });
    if (currentProject?.path === p.path) {
      currentProject = null;
      currentSessionId = null;
      sessions = [];
      clearChat();
      setSendButtonRunning(false);
      chatHeader.textContent = "Pi Agent";
      chatHeader.title = "Pi Agent";
    }
    await loadProjects();
  } catch (e) {
    showError(`移除失败: ${e.message || e}`);
  }
}

// ===================== 添加项目气泡 =====================

function showAddProjectPopover() {
  $("pi-add-popover").hidden = false;
  $("pi-project-path").focus();
}

function hideAddProjectPopover() {
  $("pi-add-popover").hidden = true;
  $("pi-project-path").value = "";
}

/** 气泡当前是否已隐藏（避免重复关闭、也便于测试断言） */
function isAddProjectPopoverHidden() {
  const pop = $("pi-add-popover");
  return !pop || pop.hidden === true;
}

async function confirmAddProject() {
  const raw = $("pi-project-path").value.trim();
  if (!raw) return;
  try {
    await addProjectPath(raw);
  } catch (e) {
    showError(`添加项目失败: ${e.message || e}`);
  }
}

/**
 * 弹系统「选择文件夹」对话框并把选中的文件夹加为项目。
 *
 * 走宿主的 `ms.ui.pickFolder`（挂在 ui.inlay 权限下，不额外申请权限）：
 * 用户取消返回 null → 静默收尾；成功则与手动输入走同一条 `addProjectPath`。
 * 宿主若在浏览器调试环境（没有系统对话框）会返回 null，此时退化为无操作，
 * 气泡里的手动输入路径仍可用。
 */
async function pickFolderAndAdd() {
  const btn = $("pi-pick-folder");
  if (!ms.ui || typeof ms.ui.pickFolder !== "function") {
    piToast("当前宿主不支持文件夹选择，请手动输入路径");
    return;
  }
  if (btn) btn.disabled = true;
  try {
    const picked = await ms.ui.pickFolder({ title: "选择项目文件夹" });
    if (!picked) return; // 用户取消
    await addProjectPath(picked);
  } catch (e) {
    showError(`添加项目失败: ${e.message || e}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

/**
 * 把一条路径登记为项目（手动输入 / 系统选择 / 拖入共用）。
 *
 * 后端 `addProject` 会做目录存在性与去重校验，重复项目会以错误返回；
 * 这里对「已存在」做降级处理：不弹错，直接切到该项目（更符合拖入/重复选择
 * 时的直觉）。其余错误照旧抛出，由调用方提示。
 *
 * **添加成功即关闭添加项目气泡**：在这里统一收口，三个入口（手动输入 / 系统
 * 选择 / 拖入文件夹）都会关，不必各自调用——之前拖入路径就漏关，用户会看到
 * 项目已加进去、气泡却还开着。添加失败（或空路径）时保持气泡打开，方便用户
 * 看到错误后修正再试。
 */
async function addProjectPath(path) {
  const closeOnSuccess = () => { if (!isAddProjectPopoverHidden()) hideAddProjectPopover(); };
  try {
    const result = await ms.backend.call("addProject", { path });
    if (result?.project) {
      await loadProjects();
      await selectProject(result.project.path);
    }
    if (result) closeOnSuccess();
    return result;
  } catch (e) {
    const msg = String((e && e.message) || e);
    // 已存在：视为成功切换（从后端返回里拿到真实 resolved 路径无法直接拿，
    // 用本地 projects 里同名匹配一次）
    if (/已存在/.test(msg)) {
      const key = normalizePath(path);
      const hit = projects.find((p) => normalizePath(p.path) === key);
      if (hit) {
        await selectProject(hit.path);
        closeOnSuccess();
        return { ok: true, project: hit };
      }
      piToast("该项目已在列表中");
      closeOnSuccess();
      return null;
    }
    throw e;
  }
}

/**
 * 粗略归一化路径（**仅**用于前端已存在项的模糊匹配；真正解析在后端）。
 * Windows 盘符可能来自选择器（`D:\a\b`）或拖入（`D:\a\b\`），大小写也可能不同，
 * 因此统一为「小写 + 正斜杠 + 去掉尾部分隔符」再比较。
 */
function normalizePath(p) {
  return String(p || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

// ===================== 会话 =====================

/**
 * 按「最后消息时间」降序就地排序：最新的在最前。
 *
 * 列表顺序**只由时间决定**，不因「当前正在查看哪个会话」而改变——查看会话
 * 只是高亮它，不该把它顶到最上面。没有时间戳的会话（如刚建、未落盘的草稿）
 * 排在最后。
 */
function sortSessionsByTime(list) {
  list.sort((a, b) => {
    const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return tb - ta;
  });
  return list;
}

/**
 * 刚发了消息的会话提到最前：它的「最后消息时间」就是此刻。
 *
 * 列表顺序由时间决定，这里把内存里的 updatedAt 推到当前时刻并重排，让
 * 「最新发送的会话在最上面」立刻成立——不必等 8s 轮询（运行中还会被避让）
 * 或本轮跑完后的 refreshSessionMeta。轮询回来会用后端真实时间戳覆盖，两者
 * 只差毫秒级。
 */
function bumpSessionToTop(sessionId) {
  const s = sessions.find((x) => x.id === sessionId);
  if (!s) return;
  s.updatedAt = new Date().toISOString();
  sortSessionsByTime(sessions);
  renderSessions();
}

/**
 * 会话序号：按**创建时间**编号，最新创建的为 `#L1`（L = Latest）。
 *
 * 与列表排序解耦——列表按「最后消息时间」降序（谁刚说过话谁在上），序号按
 * 「创建时间」降序（谁刚新建谁是 L1）。这样聊得多的老会话不会因为被排到上面
 * 就顶着 L1，序号在整个会话生命周期里固定不变。
 *
 * 返回 `id → "#L<n>"` 映射；`createdAt` 缺失时退回 `updatedAt` 兜底排序
 * （后端旧数据 / 未落盘草稿）。
 */
function computeSessionLabels(list) {
  const at = (s) => {
    const t = s.createdAt || s.updatedAt;
    return t ? new Date(t).getTime() : 0;
  };
  const ordered = [...list].sort((a, b) => at(b) - at(a));
  const map = new Map();
  ordered.forEach((s, i) => map.set(s.id, `#L${i + 1}`));
  return map;
}

/** 会话序号标签缓存：renderSessions 时按当前列表重算 */
let sessionLabels = new Map();

/** 取某会话的序号标签（会话不在列表里时返回空串） */
function sessionLabel(sessionId) {
  return sessionLabels.get(sessionId) || "";
}

async function loadSessions() {
  if (!currentProject) {
    sessionsLoading = false;
    renderSessions();
    return;
  }
  const projectPath = currentProject.path;
  const seq = ++sessionsReqSeq;
  try {
    const result = await ms.backend.call("listSessions", { projectPath });
    // 过期响应：期间已切换项目，或更新的请求已发出 → 丢弃，避免盖掉新状态
    if (seq !== sessionsReqSeq || currentProject?.path !== projectPath) return;
    sessions = result?.sessions || [];
    sortSessionsByTime(sessions);
    currentProject.sessionCount = sessions.length;
    currentProject.badgeCount = result?.badgeCount ?? countFlaggedSessions();
    // 用后端标记核对「正在运行」会话账本——插件重新挂载/切换项目回来时，
    // 后端仍记得哪些会话在跑，这里先把账本填上，selectSession 才能恢复停止按钮
    for (const s of sessions) {
      if (s.flag === "running") runningSessions.set(s.id, { projectPath: currentProject.path, sessionId: s.id });
    }
    sessionsLoading = false;
    renderSessions();
    renderProjects();

    if (sessions.length > 0) {
      // 优先恢复上次保存的会话，回退到第一个会话
      const savedSession = savedState.sessionId
        ? sessions.find((s) => s.id === savedState.sessionId) : null;
      await selectSession(savedSession ? savedSession.id : sessions[0].id);
    } else {
      await createSession();
    }
    startSessionPolling();
    startRelTimeRefresh();
  } catch (e) {
    if (seq !== sessionsReqSeq || currentProject?.path !== projectPath) return;
    sessionsLoading = false;
    renderSessions();
    showError(`加载会话失败: ${e.message || e}`);
  }
}

/** 会话是否属于「待处理」（算进角标，需要用户关注） */
function isPendingSession(s) {
  return s.flag === "running" || s.flag === "unseen" || s.pending === true || pendingAskBySession.has(s.id);
}

/**
 * 更新内存会话列表里某个会话的状态点，让列表立即反映运行/完成，
 * 不用等 8s 轮询（运行中轮询本就被避让，flag 会长期滞后）。
 */
function patchSessionFlag(sid, flag) {
  if (!sid) return;
  const s = sessions.find((x) => x.id === sid);
  if (!s || s.flag === flag) return;
  s.flag = flag;
  // 状态点变了角标口径跟着变（running/unseen 都计入），同步重算，
  // 否则「跑完了 / 刚查看」要等 8s 轮询角标才动
  if (currentProject && Number.isFinite(currentProject.badgeCount)) {
    currentProject.badgeCount = Math.max(0, countFlaggedSessions());
  }
  renderSessions();
  renderProjects();
}

function renderSessions() {
  sessionListEl.innerHTML = "";
  // 序号按创建时间重算（最新创建 = #L1），与下面的时间排序无关
  sessionLabels = computeSessionLabels(sessions);
  // 加载态占位：切换项目/首屏期间先显示「加载中…」，避免闪一下「暂无历史会话」
  if (sessionsLoading) {
    const loading = document.createElement("div");
    loading.className = "pi-empty pi-sessions-loading";
    loading.innerHTML = '<span class="pi-loading-dot"></span>加载中…';
    sessionListEl.appendChild(loading);
    return;
  }
  if (!currentProject) {
    const empty = document.createElement("div");
    empty.className = "pi-empty";
    empty.textContent = "请先添加项目";
    sessionListEl.appendChild(empty);
    return;
  }

  const newBtn = document.createElement("button");
  newBtn.className = "load-history-btn pi-new-session-btn";
  newBtn.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>新建会话';
  newBtn.addEventListener("click", () => createSession());
  sessionListEl.appendChild(newBtn);

  if (sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pi-empty";
    empty.textContent = "暂无历史会话\n在上方新建一个开始对话";
    empty.style.whiteSpace = "pre-line";
    sessionListEl.appendChild(empty);
    return;
  }

  // 顺序恒为「最后消息时间」降序（sortSessionsByTime 已排好）：点开某个会话只是
  // 把它高亮，**不**把它顶到最上面——否则「看哪个哪个就跳上去」，时间序被查看
  // 行为打乱，用户找不回原来的位置。
  // 窗口默认只铺开前 SESSIONS_PER_PAGE 条；但「待处理」（进行中/未查看/草稿）
  // 与当前会话即便排在窗口之外也必须渲染：前者是还没了结的活，后者是用户当前
  // 所在位置，都不能从列表里消失。于是把窗口撑到至少覆盖它们——只影响「多渲染
  // 几条」，不改顺序。
  let visibleCount = sessionVisibleCount;
  sessions.forEach((s, i) => {
    if (isPendingSession(s) || s.id === currentSessionId) {
      visibleCount = Math.max(visibleCount, i + 1);
    }
  });
  const visible = sessions.slice(0, visibleCount);

  const hiddenCount = sessions.length - visible.length;
  const hasMore = hiddenCount > 0;

  for (const s of visible) {
    renderSessionItem(s);
  }

  if (hasMore) {
    const moreBtn = document.createElement("button");
    moreBtn.className = "load-history-btn pi-more-sessions-btn";
    moreBtn.textContent = `加载更多历史会话（还有 ${hiddenCount} 条）`;
    moreBtn.addEventListener("click", () => {
      sessionVisibleCount += SESSIONS_PER_PAGE;
      renderSessions();
    });
    sessionListEl.appendChild(moreBtn);
  }
}

/** 渲染单条会话 */
function renderSessionItem(s) {
  const item = document.createElement("div");
  item.className = "session-item" + (s.id === currentSessionId ? " active" : "");
  item.dataset.sessionId = s.id;

  const header = document.createElement("div");
  header.className = "session-header";
  const title = document.createElement("span");
  title.className = "session-title";
  const index = document.createElement("span");
  index.className = "session-index";
  // 序号 = 创建序（最新创建 #L1），不是列表位置
  index.textContent = sessionLabel(s.id);
  title.appendChild(index);
  title.appendChild(document.createTextNode(" " + (s.title || s.id)));
  header.appendChild(title);
  if (s.id === currentSessionId) {
    const badge = document.createElement("span");
    badge.className = "badge progress";
    badge.textContent = "当前";
    header.appendChild(badge);
  }
  // 「待回答」提示：该会话有未作答的 ask。当前会话不显示——卡片就在聊天区里，
  // 再挂个角标反而多余。
  if (pendingAskBySession.has(s.id) && s.id !== currentSessionId) {
    const askBadge = document.createElement("span");
    askBadge.className = "badge ask";
    askBadge.textContent = "待回答";
    askBadge.title = "这个会话有一个问题在等你回答";
    header.appendChild(askBadge);
  }
  item.appendChild(header);

  // 状态点颜色 + 状态文案。三态：处理中 / 已完成未读 / 已查看（空）。
  // 「已查看」不写字，只留时间（时间行仍在）；「尚未开始」是未落盘草稿。
  //（没有「处理失败」态：见后端 sessionFlag 注释——文件尾部无法区分进行中与中断。）
  const dotClass =
    s.flag === "running" ? "status-dot running"
    : s.flag === "unseen" ? "status-dot unseen"
    : "status-dot";
  const statusText =
    s.flag === "running" ? "处理中"
    : s.flag === "unseen" ? "已完成未读"
    : s.pending ? "尚未开始"
    : "";
  // 底部子行：一行装下「状态 · 时间前」，不换行——
  //   状态（处理中/已完成未读/尚未开始）· 相对时间（刚刚 / N 分钟前 / N
  //   小时前 / N 天前 / N 个月前 / N 年前）。「已查看」不再写字，只留时间。
  // 两段各自独立判定：任一有内容就渲染底部行，缺的段自动省略（如无状态的旧会话
  // 只显示「3 小时前」，无时间戳的草稿只显示「尚未开始」）。
  const relTime = formatRelativeTime(s.updatedAt);
  if (statusText || relTime) {
    const sub = document.createElement("div");
    sub.className = "sub-agent-list";
    const row = document.createElement("div");
    row.className = "sub-agent-item";
    const dot = document.createElement("div");
    dot.className = dotClass;
    row.appendChild(dot);
    const nameSpan = document.createElement("span");
    nameSpan.className = "sub-agent-name";
    // 状态 · 时间前：两段拼成一行，缺的段自动跳过（分隔符只在段之间加）。
    // 时间那段用独立 span 包裹：hover 看绝对时间，且定时刷新用它重算相对时间。
    if (statusText) nameSpan.appendChild(document.createTextNode(statusText + (relTime ? " · " : "")));
    if (relTime) {
      const timeSpan = document.createElement("span");
      timeSpan.className = "session-time";
      timeSpan.textContent = relTime;
      timeSpan.dataset.time = s.updatedAt || "";
      timeSpan.title = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : "";
      nameSpan.appendChild(timeSpan);
    }
    row.appendChild(nameSpan);
    sub.appendChild(row);
    item.appendChild(sub);
  }

  item.addEventListener("click", () => selectSession(s.id));
  sessionListEl.appendChild(item);
}

async function selectSession(sessionId) {
  // 捕获发起时的项目：await 期间用户可能已切换项目，后续 markViewed / loadSession /
  // 转录渲染都必须以这个 projectPath 为准，绝不能读「当时的 currentProject」
  const projectPath = currentProject?.path || "";
  // 切换会话时立即保存状态
  savedState.sessionId = sessionId;
  if (currentProject) savedState.projectPath = projectPath;

  // 切走前先暂存旧会话未提交卡片的选择（此刻 currentSessionId 还是旧会话，
  // clearChat 里的 ask 卡片移除随后进行；顺序不能反，否则拿不到旧会话的卡片）。
  if (currentSessionId && currentSessionId !== sessionId) archiveCurrentAskState();

  currentSessionId = sessionId;
  renderSessions();

  const s = sessions.find((x) => x.id === sessionId);
  const label = sessionLabel(sessionId);
  chatHeader.textContent = s?.title ? `${label ? label + " " : ""}${s.title}` : "Pi Agent";
  chatHeader.title = chatHeader.textContent;

  clearChat();
  setSendButtonRunning(false);
  showWelcome("Pi Agent", "正在加载历史消息…");

  // 先告诉后端「我现在正开这个会话」：后端对正在打开的会话直接判定为已读，
  // 不会因为它在跑/消息条数还在涨又变回未读（切走时再改写/清空）。
  try { await ms.backend.call("setActiveSession", { projectPath, sessionId }); } catch (e) {}
  try { await ms.backend.call("markViewed", { projectPath, sessionId }); } catch (e) {}
  // 已读后本地立即生效：清掉状态点、重算角标并重渲染——否则角标要等 8s 轮询
  // 才会下降，而轮询在「有会话在跑 / 窗口隐藏 / 已切到其它项目」时根本不刷新，
  // 用户看到的就是「查看了会话但角标一动不动」。仅在仍是当前项目时写入，
  // 防止把过期会话的已读状态盖到刚切换的项目上。
  if (currentProject?.path === projectPath) {
    const viewed = sessions.find((x) => x.id === sessionId);
    // 已读：清掉「已完成未读」状态点（没有 failed 这个态需要保留）
    if (viewed && viewed.flag === "unseen") {
      viewed.flag = null;
      if (Number.isFinite(currentProject.badgeCount)) {
        currentProject.badgeCount = Math.max(0, countFlaggedSessions());
      }
      renderSessions();
      renderProjects();
    }
  }

  try {
    const result = await ms.backend.call("loadSession", {
      projectPath,
      sessionId,
    });
    // 转录过期校验：项目或会话已切换，丢弃，不要把旧会话渲染进新视图
    if (currentProject?.path !== projectPath || currentSessionId !== sessionId) return;
    loadedMessages = result?.transcript || [];
    clearChat();
    renderedFromEnd = loadedMessages.length;
    if (loadedMessages.length === 0) {
      showWelcome("Pi Agent", "这个会话还没有消息，在下面输入开始对话吧");
    } else {
      renderFrom(findLastRoundStart(loadedMessages), true);
      // 若该会话正在跑：把历史里那条半截回答认领为当前轮气泡，后续 delta 原地覆盖，
      // 避免「半截回答 + 完整回答」两份并存（见 adoptPartialTurnNode）。
      // 注意：此刻 runningSessions 可能还没被下面的对账填上，adoptPartialTurnNode
      // 只把它当作**可写性**判定；真正的对账完成后还会再补一次（见下方）。
      turnAgentNode = null;
      adoptPartialTurnNode();

      // 恢复后同步发送按钮状态——如果该会话正在运行中，显示「停止」并恢复打字指示器
      // 注意根据 runningSessions 判断，而不是 sessions[].flag（内存 flag 在运行中不会被刷新，会丢状态）
      if (currentSessionIsRunning()) {
        setSendButtonRunning(true);
        showTyping();
      }
    }

    // 以「后端真实运行态」为准对账内存账本：切走再切回、或插件重新挂载后，
    // runningSessions 可能已失准（超时清过 / 列表 flag 残留），直接问后端该会话
    // 是否在跑，避免「切回状态没了」或「列表显示完成但视图还卡在运行」的假死。
    try {
      const st = await ms.backend.call("getSessionStatus", { projectPath, sessionId });
      if (currentProject?.path === projectPath && currentSessionId === sessionId) {
        // 只信明确的布尔答案：后端未实现该方法 / 返回空时**保持现有账本**。
        // 否则一次「问不到」就会被当成「没在跑」，把列表 flag 刚水合出来的
        // 运行态一笔抹掉（表现为切到运行中的会话，按钮却是「发送」）。
        if (typeof st?.running === "boolean") {
          if (st.running) {
            runningSessions.set(sessionId, { projectPath, sessionId });
            setSendButtonRunning(true);
            showTyping();
            // 对账前可能因账本尚未水合而没认领到半截回答气泡，这里补一次
            //（幂等：已认领时 turnAgentNode 已指向该节点，重复调用无副作用）。
            if (!turnAgentNode) adoptPartialTurnNode();
          } else {
            runningSessions.delete(sessionId);
            syncSendButton();
          }
        }
      }
    } catch (e) { /* 查不到状态就按现有账本处理 */ }

    // 把该会话待回答的 ask 卡片挂回来（切回仍可作答）。
    // 放在最后：空消息会话也会走到这，且不会打断上面的运行态恢复。
    if (currentProject?.path === projectPath && currentSessionId === sessionId) {
      await restoreAskCard(sessionId);
    }
  } catch (e) {
    if (currentProject?.path !== projectPath || currentSessionId !== sessionId) return;
    console.warn("[PI] 读取会话历史失败:", e);
    clearChat();
    showWelcome("Pi Agent", "无法读取该会话的历史消息");
  }
}

/**
 * 切回一个**正在运行**的会话时，把历史里那条「半截回答」气泡认领为本轮气泡。
 *
 * 为什么需要：openSession 读到的 transcript 可能已经包含本轮**已流出的部分文本**，
 * 它会被当成历史气泡渲染（sealed=1）；而随后的 chat:delta 带的是**累积全文**、
 * 会新建一个气泡再写一遍完整回答——用户就会同时看到「半截回答」和「完整回答」
 * 两份。这里把那条尚未收尾的 agent 气泡（转录最后一条就是它）改挂成当前轮节点，
 * 后续 delta 用累积全文原地覆盖，视觉上自然衔接。
 *
 * @returns 是否已认领（未认领时保持 turnAgentNode=null，由 currentTurnNode 新建）
 */
function adoptPartialTurnNode() {
  if (!currentSessionIsRunning()) return false;
  const last = loadedMessages[loadedMessages.length - 1];
  if (!last || last.role !== "assistant") return false;
  const nodes = chatBody.querySelectorAll(".message.agent");
  const node = nodes[nodes.length - 1];
  if (!node) return false;
  // 摘掉「历史/已收尾」标记（renderFrom 给历史气泡打过 sealed=1），恢复可写
  delete node.dataset.sealed;
  turnAgentNode = node;
  return true;
}

/**
 * 找到「最近一轮」的起点下标。
 */
function findLastRoundStart(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return i;
  }
  return Math.max(0, messages.length - 1);
}

/** 往前找第 n 轮的起点 */
function findPrevRoundStart(messages, from, rounds = 1) {
  let idx = from;
  for (let r = 0; r < rounds; r++) {
    let prev = idx - 1;
    while (prev >= 0 && messages[prev]?.role !== "user") prev--;
    if (prev < 0) return 0;
    idx = prev;
  }
  return idx;
}

/**
 * 渲染历史消息（含思考 / 工具调用的收纳展示）。
 *
 * transcript 条目（后端 buildTranscriptFromMessages 产出）：
 *   - { role: "user", content }
 *   - { role: "assistant", content, thinking?, toolCalls? }
 *   - { role: "toolResult", toolCallId, toolName, isError, content }
 * 工具结果条目按 toolCallId 回填到对应工具卡片（成功 / 失败徽标 + 结果文本），
 * 不产生独立气泡；assistant 条目里的思考与工具调用渲染进折叠区（默认收起，点开可看）。
 */
function renderFrom(from, scrollToEnd = false) {
  const nothingRendered = renderedFrom < 0;
  const end = nothingRendered ? renderedFromEnd : renderedFrom;
  const batch = loadedMessages.slice(from, Math.max(from, end));
  const anchor = chatBody.querySelector(".message, .pi-error");
  for (const msg of batch) {
    // 工具结果：回填到对应的工具行上（不是独立气泡）
    if (msg && msg.role === "toolResult") {
      const row = msg.toolCallId ? findToolRow({ toolCallId: msg.toolCallId }) : null;
      if (row) {
        updateToolRow(row, {
          status: msg.isError ? "error" : "success",
          resultText: msg.content,
          kindLabel: toolKindLabel(row.dataset.kind || row.dataset.tool, msg.isError ? "error" : "success"),
        });
      }
      continue;
    }
    const node = appendMessage(msg.role === "user" ? "user" : "agent", msg.content, anchor, msg.entryId, msg.images);
    node.dataset.sealed = "1";
    // 纯动作（无正文）的历史回答：不显示空气泡
    if (msg.role === "assistant" && !msg.content) {
      const bubble = node.querySelector(".message-content");
      if (bubble) bubble.hidden = true;
    }
    if (msg.role === "assistant" && (msg.thinking || (msg.toolCalls && msg.toolCalls.length))) {
      renderHistoryActions(node, msg);
    }
  }
  // 历史里仍挂着「执行中」的工具行：会话并未在跑时说明是中断遗留，标记为已停止
  if (!currentSessionIsRunning()) {
    stopRunningToolRows(chatBody);
  }
  renderedFrom = from;
  updateRoundMoreButton();
  if (scrollToEnd) forceScrollToBottom();
}

/**
 * 渲染一条历史 assistant 消息里的动作，默认收起。
 *
 * 结构与实时完全一致：一个 .turn-work 分组，里面是独立的思考行与工具行。
 * 历史轮次的工具行先以「执行中」建出（结果在后面的 toolResult 条目里，由
 * renderFrom 按 toolCallId 回填成功 / 失败）；循环结束后仍未配对上的，说明是
 * 中断遗留，由 stopRunningToolRows 统一标成「已停止」——不假装成功。
 */
function renderHistoryActions(node, msg) {
  const work = ensureTurnWork(node, { live: false });
  const body = work.querySelector(".turn-work-body");
  if (msg.thinking) {
    body.appendChild(createReasoningRow(msg.thinking, { settled: true }));
  }
  for (const call of msg.toolCalls || []) {
    body.appendChild(createToolRow({
      toolCallId: call.id,
      toolName: call.name,
      label: call.label,
      detail: call.detail,
      kind: call.kind,
      primaryText: call.primaryText,
      secondaryText: call.secondaryText,
      changeStat: call.changeStat,
      inputJson: call.inputJson,
      status: "running",
    }));
  }
  // 历史分组直接落定：标题「已工作 N 秒」/「已处理」，并收起
  stopTurnWorkTicker();
  setTurnWorkStatus(work, "worked", msg.durationMs);
  work.open = false;
}

/** 上方按钮：还有更早的轮次就显示 */
function updateRoundMoreButton() {
  const hasEarlier = renderedFrom > 0;
  loadMoreBtn.hidden = !hasEarlier;
  if (!hasEarlier) return;
  const roundsLeft = countRounds(loadedMessages, 0, renderedFrom);
  loadMoreBtn.innerHTML = "";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M18 15l-6-6-6 6");
  svg.appendChild(path);
  loadMoreBtn.appendChild(svg);
  loadMoreBtn.appendChild(
    document.createTextNode(`加载更早的 ${Math.min(ROUNDS_PER_PAGE, roundsLeft)} 轮对话（还剩 ${roundsLeft} 轮）`)
  );
}

function countRounds(messages, from, to) {
  let n = 0;
  for (let i = from; i < to; i++) if (messages[i]?.role === "user") n++;
  return n;
}

function loadMoreRounds() {
  if (renderedFrom <= 0) return;
  const prevScrollHeight = chatBody.scrollHeight;
  const prevScrollTop = chatBody.scrollTop;
  const next = findPrevRoundStart(loadedMessages, renderedFrom, ROUNDS_PER_PAGE);
  renderFrom(next, false);
  requestAnimationFrame(() => {
    chatBody.scrollTop = prevScrollTop + (chatBody.scrollHeight - prevScrollHeight);
  });
}

/** 新建会话 */
async function createSession() {
  if (!currentProject) {
    showError("请先添加项目");
    return;
  }
  if (creatingSession) return;
  creatingSession = true;
  const projectPath = currentProject.path;

  const btn = sessionListEl.querySelector(".pi-new-session-btn");
  const prevLabel = btn ? btn.innerHTML : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "正在新建…";
  }

  try {
    const result = await ms.backend.call("createSession", {
      projectPath,
      model: currentModelId,
    });
    // await 期间已切换项目：会话属于旧项目，别把新视图状态盖过来，回到该项目时自会加载到
    if (currentProject?.path !== projectPath) return;
    if (!result?.session) throw new Error("后端未返回新会话");

    currentSessionId = result.session.id;
    chatHeader.textContent = result.session.title || "新对话";
    chatHeader.title = chatHeader.textContent;
    clearChat();
    setSendButtonRunning(false);
    showWelcome("Pi Agent", "这个会话还没有消息，在下面输入开始对话吧");
    await refreshSessionMeta({ force: true });
    renderProjects();
    inputEl.focus();
  } catch (e) {
    showError(`新建会话失败: ${e.message || e}`);
  } finally {
    creatingSession = false;
    const fresh = sessionListEl.querySelector(".pi-new-session-btn");
    if (fresh && prevLabel) fresh.innerHTML = prevLabel;
  }
}

// ===================== 消息渲染 =====================

function clearChat() {
  // ask 卡片一并移除：它不隶属任何一条消息，是「当前会话正在等我回答」的临时界面，
  // 切走必须收起（否则会串到别的会话里）。未作答的选择状态由 archivedAskStateFor
  // 在切换前存进 askCardStates，切回时 restoreAskCard 再挂出来。
  chatBody.querySelectorAll(".message, .pi-error, .turn-work, .pi-ask-card").forEach((el) => el.remove());
  stopTurnWorkTicker();
  turnAgentNode = null;
  editingNode = null;   // 正在编辑的气泡已被移除，别留下悬挂引用
  streamGateOpen = true;   // 重绘视图：恢复正常流式接收
  renderedFrom = -1;
  renderedFromEnd = 0;
  loadMoreBtn.hidden = true;
  if (scrollBottomBtn) scrollBottomBtn.hidden = true;
  // 注意：这里不再重置发送按钮——切换会话时若目标会话仍在运行，
  // 需要在 selectSession 里恢复「停止」按钮；由调用方按需 setSendButtonRunning/syncSendButton。
  hideWelcome();
  removeTyping();
}

function showWelcome(title, text) {
  if (!welcomeEl) return;
  welcomeEl.innerHTML = "";
  const h = document.createElement("h2");
  h.textContent = title;
  const p = document.createElement("p");
  p.textContent = text;
  welcomeEl.appendChild(h);
  welcomeEl.appendChild(p);
  welcomeEl.hidden = false;
}

function hideWelcome() {
  if (welcomeEl) welcomeEl.hidden = true;
}

/** 追加一条消息 */
/**
 * 渲染一组图片缩略图（用户消息里附带的图片）。
 * images: [{ dataUrl }] 或 [{ mimeType, data }]，统一转成 data URL。
 * 返回容器元素（无图片返回 null）。
 */
function buildImageThumbs(images) {
  if (!images || !images.length) return null;
  const wrap = document.createElement("div");
  wrap.className = "pi-msg-images";
  for (const im of images) {
    const url = typeof im === "string" ? im : (im?.dataUrl || (im?.data && im?.mimeType ? `data:${im.mimeType};base64,${im.data}` : ""));
    if (!url) continue;
    const fig = document.createElement("div");
    fig.className = "pi-msg-image";
    const img = document.createElement("img");
    img.src = url;
    img.alt = "图片";
    img.loading = "lazy";
    fig.appendChild(img);
    wrap.appendChild(fig);
  }
  return wrap.childNodes.length ? wrap : null;
}

function appendMessage(role, content, before, entryId, images) {
  hideWelcome();
  removeTyping();
  const div = document.createElement("div");
  div.className = "message " + role;
  if (entryId) div.dataset.entryId = entryId;
  // 把图片挂在节点上：编辑重发时据此保留图片（后端也会从原文重新取，双保险）。
  if (role === "user" && images && images.length) div.__images = images;
  const bubble = document.createElement("div");
  bubble.className = "message-content";
  if (role === "agent") {
    bubble.innerHTML = md2html(content);
    // 记下**纯文本原文**：它是流式累积全文（chat:delta 的 content）的对照基准，
    // 供「切回运行中会话时采纳半截回答」判断前缀（见 adoptPartialTurnNode）。
    bubble.dataset.raw = content || "";
    div.dataset.raw = content || "";
  } else {
    const thumbs = role === "user" ? buildImageThumbs(images) : null;
    if (thumbs) bubble.appendChild(thumbs);
    const text = document.createElement("div");
    text.className = "pi-msg-text";
    text.textContent = content || "";
    bubble.appendChild(text);
  }
  div.appendChild(bubble);
  // 用户消息：悬停时出现「编辑」按钮（点了把这条拉回编辑态，确认后重发）
  if (role === "user") attachEditButton(div);
  if (before && before.parentNode === chatBody) {
    chatBody.insertBefore(div, before);
  } else {
    chatBody.appendChild(div);
  }
  if (!before) scrollToBottom();
  return div;
}

// ===================== 编辑已发送的用户消息 =====================

/**
 * 当前处于编辑态的用户气泡（同一时刻只允许一条）。
 * 确认后会：截断该消息之后的所有内容 → 用新文本重发（后端在同一 RPC 里完成）。
 */
let editingNode = null;

/** 给用户气泡挂一个「编辑」按钮（悬停时才出现，位于气泡下方） */
function attachEditButton(node) {
  // 没有 entryId 就无法定位（草稿会话/后端未给分支信息）→ 不提供编辑入口
  if (!node.dataset.entryId) return;
  if (node.querySelector(".msg-edit-btn")) return;
  const btn = document.createElement("button");
  btn.className = "msg-edit-btn";
  btn.type = "button";
  btn.title = "编辑这条消息（确认后从这里重新开始）";
  btn.innerHTML =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path>' +
    '<path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg><span>编辑</span>';
  // 阻止 mousedown 抢焦点：否则点按钮会先让别的输入框失焦，产生多余的取消
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    enterEditMode(node);
  });
  node.appendChild(btn);
}

/** 进入编辑态：气泡换成输入框，焦点落在末尾 */
function enterEditMode(node) {
  if (!node.dataset.entryId) return;
  if (editingNode === node) return;              // 已在这条上编辑
  if (editingNode) cancelEditMode(editingNode);  // 切到另一条：先放弃上一条的编辑
  // 运行中也可编辑：确认时后端会先中止当前回答，再从这条重发
  const bubble = node.querySelector(".message-content");
  if (!bubble) return;
  // 取纯文本部分（.pi-msg-text），避免图片 alt 混入
  const original = bubble.querySelector(".pi-msg-text")?.textContent || bubble.textContent || "";

  editingNode = node;
  node.classList.add("editing");
  node.dataset.originalText = original;

  const box = document.createElement("div");
  box.className = "msg-edit-box";
  const ta = document.createElement("textarea");
  ta.className = "msg-edit-input";
  ta.value = original;
  ta.rows = 1;
  ta.spellcheck = false;
  const hint = document.createElement("div");
  hint.className = "msg-edit-hint";
  hint.innerHTML = "Enter 确认并重发 · Shift+Enter 换行 · Esc 或点击别处取消";

  box.appendChild(ta);
  box.appendChild(hint);
  node.appendChild(box);

  const autoGrow = () => {
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 240) + "px";
  };
  autoGrow();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  ta.addEventListener("input", autoGrow);
  // 失焦即取消：只有 Enter 才算确认。用闭包变量而非 dataset 记录「已确认」，
  // 这样即使后续 confirm 流程先拆除 DOM 再触发 blur，也不会被误判成一次取消。
  let confirmed = false;
  ta.addEventListener("blur", () => {
    if (confirmed) return;
    cancelEditMode(node);
  });
  ta.addEventListener("keydown", (e) => {
    // 不让按键冒泡到宿主/文档级快捷键（否则 Esc 会顺带关掉设置面板等）
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      confirmed = true;
      void confirmEditMessage(node, ta.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEditMode(node);
    }
  });
}

/** 退出编辑态，恢复到普通气泡 */
function cancelEditMode(node) {
  if (editingNode !== node) return;
  editingNode = null;
  node.classList.remove("editing");
  node.querySelector(".msg-edit-box")?.remove();
  delete node.dataset.originalText;
}

/**
 * 确认编辑：截断该消息之后的一切，并用新文本重发。
 *
 * DOM 侧先乐观清掉该节点之后的所有消息（保证「回车后下面的消息立即消失」），
 * 再以后端返回的截断后转录为准整体重绘，最后重发的流式内容照常追加。
 */
/**
 * 确认编辑：截断该消息之后的一切，并用新文本重发。
 *
 * 关键点：**就地改写**这条气泡（而不是用后端转录整体重绘）。后端在 prompt 之前
 * 只回传「截断后的转录」，此时刚重发的 user 消息还没落盘，若拿它重绘就会把刚发
 * 的这条抹掉（表现为「重发后消息不见了，要重新加载才出现」）。因此这里保留节点、
 * 更新文本与 entryId，只删掉它**之后**的内容，后续流式照常追加。
 *
 * 运行中也可编辑：后端会先 abort 当前回答，再截断重发。
 */
async function confirmEditMessage(node, rawText) {
  const newText = String(rawText || "").trim();
  const entryId = node.dataset.entryId;
  const projectPath = currentProject?.path || "";
  const sessionId = currentSessionId;
  // 提前退出也要收回编辑态（此时 confirmed 已置位，blur 不会再帮忙收）
  if (!newText || !entryId || !projectPath || !sessionId) { cancelEditMode(node); return; }

  // 该条消息在当前分支里是第几条 user（后端 entryId 失效时的兜底）
  const userIndex = userIndexOfNode(node);
  const oldText = node.dataset.originalText || "";

  cancelEditMode(node);
  // 乐观：就地改写这条气泡的文本（保留图片），并移除它之后的所有内容。
  // 关闸：丢弃 abort 后仍在途的旧轮 delta（否则它们会以新气泡形态冒出来）。
  streamGateOpen = false;
  const bubble = node.querySelector(".message-content");
  if (bubble) {
    // 重新构建气泡内容：图片（来自历史的 node.__images）+ 新文本，
    // 不能用 textContent 整体覆盖，否则会把已渲染的缩略图清掉。
    bubble.innerHTML = "";
    const thumbs = buildImageThumbs(node.__images);
    if (thumbs) bubble.appendChild(thumbs);
    const txt = document.createElement("div");
    txt.className = "pi-msg-text";
    txt.textContent = newText;
    bubble.appendChild(txt);
  }
  delete node.dataset.raw;
  removeMessagesAfter(node);
  // 运行中编辑：先把「停止」按钮切回，避免用户在等待期间误点
  beginAgentTurn();
  setSendButtonRunning(true);
  syncSendButton();
  showTyping();

  let result = null;
  try {
    result = await ms.backend.call("editUserMessage", {
      projectPath,
      sessionId,
      entryId,
      userIndex,
      oldText,
      newText,
    });
  } catch (e) {
    removeTyping();
    showError(`编辑失败: ${e.message || e}`);
    // 失败就重新拉一次历史，回到一致的视图
    await reloadCurrentSession();
    return;
  }

  // 期间用户切走了会话/项目 → 丢弃渲染，交给 selectSession
  if (currentProject?.path !== projectPath || currentSessionId !== sessionId) return;

  // 用后端回传的新 entryId 更新这条气泡，之后它也能被再次编辑
  if (result?.userEntryId) node.dataset.entryId = result.userEntryId;
  // 已截断但没重发（newText 为空时不会走到这里）：同步一次转录以保证一致
  if (result && result.transcript && !result.resent) {
    loadedMessages = result.transcript;
    renderedFromEnd = loadedMessages.length;
    removeTyping();
    clearChat();
    if (loadedMessages.length === 0) {
      showWelcome("Pi Agent", "这个会话还没有消息，在下面输入开始对话吧");
    } else {
      renderFrom(findLastRoundStart(loadedMessages), true);
    }
    turnAgentNode = null;
    syncSendButton();
    return;
  }

  // 重发已由后端发起：补上「运行中」的视觉状态，流式内容经 chat:delta 等追加
  turnAgentNode = null;
  setSendButtonRunning(true);
  syncSendButton();
  showTyping();
}

/** 该节点对应的 user 消息在**完整转录**里是第几条（从 0 数）；找不到返回 -1 */
function userIndexOfNode(node) {
  // 不能用 DOM 顺序：聊天区只渲染最近若干轮，早先的消息并不在 DOM 里。
  // 改为按「文本 + 出现次序」在 loadedMessages 里定位，与后端的分支顺序一致。
  const text = node.querySelector(".pi-msg-text")?.textContent || node.querySelector(".message-content")?.textContent || "";
  let seen = 0;
  for (const el of chatBody.querySelectorAll(".message.user")) {
    if (el === node) break;
    const t = el.querySelector(".pi-msg-text")?.textContent || el.querySelector(".message-content")?.textContent || "";
    if (t === text) seen++;
  }
  let idx = -1;
  for (const msg of loadedMessages) {
    if (msg?.role !== "user") continue;
    idx++;
    if (msg.content === text) {
      if (seen === 0) return idx;
      seen--;
    }
  }
  return -1;
}

/** 移除某条消息之后的所有内容（消息 / 错误 / 本轮工作分组） */
function removeMessagesAfter(node) {
  const children = Array.from(chatBody.children);
  const at = children.indexOf(node);
  if (at < 0) return;
  for (let i = at + 1; i < children.length; i++) {
    const el = children[i];
    if (el.classList.contains("message") || el.classList.contains("pi-error")) el.remove();
  }
  removeTyping();
}

/**
 * 找到刚发出的那条用户气泡（用于回填 entryId）。
 *
 * 取最后一个「文本相同且还没有 entryId」的 user 气泡——历史条目在 renderFrom 时
 * 已带 entryId，所以能命中的必然是这次新发的。文本为空时退化为最后一个无 id 的。
 */
function findLiveUserNode(text) {
  const nodes = chatBody.querySelectorAll(".message.user:not(.editing)");
  let hit = null;
  for (const el of nodes) {
    if (el.dataset.entryId) continue;
    // 只取纯文本部分（.pi-msg-text），避免把图片 alt 当正文
    const content = el.querySelector(".pi-msg-text")?.textContent || el.querySelector(".message-content")?.textContent || "";
    if (text != null && content !== text) continue;
    hit = el;
  }
  return hit;
}

/** 重新拉取当前会话历史并重绘（编辑失败等场景兜底） */
async function reloadCurrentSession() {
  const projectPath = currentProject?.path || "";
  const sessionId = currentSessionId;
  if (!projectPath || !sessionId) return;
  try {
    const result = await ms.backend.call("loadSession", { projectPath, sessionId });
    if (currentProject?.path !== projectPath || currentSessionId !== sessionId) return;
    loadedMessages = result?.transcript || [];
    clearChat();
    renderedFromEnd = loadedMessages.length;
    if (loadedMessages.length === 0) {
      showWelcome("Pi Agent", "这个会话还没有消息，在下面输入开始对话吧");
    } else {
      renderFrom(findLastRoundStart(loadedMessages), true);
    }
    turnAgentNode = null;
  } catch (e) { /* 静默 */ }
}

/** 本轮回答气泡（懒创建） */
function currentTurnNode() {
  if (turnAgentNode && turnAgentNode.parentNode === chatBody) return turnAgentNode;
  turnAgentNode = appendMessage("agent", "");
  return turnAgentNode;
}

/** 开一轮新的 agent 回答 */
function beginAgentTurn() {
  turnAgentNode = null;
}

/** 流式增量：写入当前 agent 气泡 */
function appendDelta(params) {
  const full = typeof params?.content === "string" ? params.content : null;
  const delta = params?.delta || "";
  // 闸门关闭（刚编辑重发/停止，新一轮还没真正开始）：丢弃在途的旧轮 delta
  if (!streamGateOpen) return;
  hideWelcome();
  removeTyping();
  // 若当前 turn 已 sealed（被 abort / 编辑截断），静默丢弃旧轮残留的 delta
  if (turnAgentNode && turnAgentNode.dataset.sealed === "1") return;
  const node = currentTurnNode();
  const bubble = node.querySelector(".message-content");
  bubble.dataset.raw = full != null ? full : (bubble.dataset.raw || "") + delta;
  bubble.innerHTML = md2html(bubble.dataset.raw);
  node.dataset.raw = bubble.dataset.raw;
  scrollToBottom();
}

/**
 * 一轮的「工作分组」（思考 + 工具调用）。
 *
 * 参考 ZCode 前端的 `AssistantHistoryStatus`：整轮动作收进一条可折叠的标题线——
 * 运行中是「工作中 8 秒」（默认展开，能实时看到在做些什么），结束后变成
 * 「已工作 8 秒」/「已处理」并自动收起，随时可以点开回看全部思考与工具调用。
 *
 * 分组内部是**独立的行**：每段思考是一个 .reasoning-row，每次工具调用是一个
 * .tool-row（单行内联摘要）。不再把两者混在同一个折叠区的滚动列表里。
 */
function ensureTurnWork(node, { live = true } = {}) {
  node = node || currentTurnNode();
  let work = node.querySelector(".turn-work");
  if (!work) {
    work = document.createElement("details");
    work.className = "turn-work";
    work.open = true;
    work.dataset.state = live ? "running" : "worked";
    work.dataset.startedAt = String(Date.now());

    const trigger = document.createElement("summary");
    trigger.className = "turn-work-trigger";
    const status = document.createElement("span");
    status.className = "turn-work-status";
    trigger.appendChild(status);
    work.appendChild(trigger);

    const body = document.createElement("div");
    body.className = "turn-work-body";
    work.appendChild(body);

    node.insertBefore(work, node.firstChild);
    if (live) {
      setTurnWorkStatus(work, "running");
      startTurnWorkTicker();
    } else {
      setTurnWorkStatus(work, "worked");
    }
  }
  work.hidden = false;
  return work;
}

/** 分组标题线的状态文案（工作中 N 秒 / 已工作 N 秒 / 已处理 / 已停止） */
function setTurnWorkStatus(work, state, durationMs) {
  if (!work) return;
  const el = work.querySelector(".turn-work-status");
  if (!el) return;
  work.dataset.state = state;
  if (state === "running") {
    const startedAt = Number(work.dataset.startedAt || 0) || Date.now();
    el.textContent = `工作中 ${formatDuration(Date.now() - startedAt)}`;
    el.classList.add("streaming");
  } else if (state === "stopped") {
    el.textContent = "已停止";
    el.classList.remove("streaming");
  } else {
    el.textContent = durationMs ? `已工作 ${formatDuration(durationMs)}` : "已处理";
    el.classList.remove("streaming");
  }
}

/** 每轮「工作中 N 秒」的秒表：只更新仍在运行的分组，没有则自行停止。 */
let turnWorkTicker = null;
function startTurnWorkTicker() {
  if (turnWorkTicker) return;
  turnWorkTicker = setInterval(() => {
    const running = chatBody.querySelectorAll('.turn-work[data-state="running"]');
    if (running.length === 0) {
      stopTurnWorkTicker();
      return;
    }
    running.forEach((w) => setTurnWorkStatus(w, "running"));
  }, 1000);
}
function stopTurnWorkTicker() {
  if (turnWorkTicker) {
    clearInterval(turnWorkTicker);
    turnWorkTicker = null;
  }
}

/**
 * 本轮结束：秒表停下、标题落定、分组收起（动作仍可随时手动展开查看）。
 *
 * `durationMs` 由后端 chat:status(idle) 带回（真实耗时）；历史轮次由 transcript
 * 的 durationMs 给出。都没有就退化为「已处理」——不编造一个耗时。
 */
function settleTurnWork(durationMs, { stopped = false } = {}) {
  if (!turnAgentNode || turnAgentNode.parentNode !== chatBody) return;
  const work = turnAgentNode.querySelector(".turn-work");
  if (!work) return;
  // 已经落定过就不再改写：chat 请求 resolve 往往晚于 chat:status(idle) 通知，
  // 若无条件重写，会把带真实耗时的「已工作 N 秒」覆盖成「已处理」。
  if (work.dataset.state !== "running") return;
  stopTurnWorkTicker();
  work.querySelectorAll(".reasoning-row").forEach((row) => finalizeReasoningRow(row));
  // 中止时把仍在跑的工具行标为已停止；正常结束不动它们（后端会发自己的 end 事件，
  // 这里强行改写会把「刚好并发的两个工具」里后到的那个误判成中断）。
  if (stopped) {
    work.querySelectorAll(".tool-row").forEach((row) => {
      if (row.dataset.status === "running") updateToolRow(row, { status: "stopped" });
    });
  }
  setTurnWorkStatus(work, stopped ? "stopped" : "worked", durationMs);
  work.open = false;
}

/** 毫秒 → 「8 秒」/「1 分 20 秒」/「1 时 5 分」（对齐 ZCode chat.history.duration.* 口径） */
function formatDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours} 时 ${restMinutes} 分` : `${hours} 时`;
}

/**
 * 相对时间：ISO 时间戳 → 「刚刚 / N 分钟前 / N 小时前 / N 天前 / N 个月前 / N 年前」。
 *
 * 用于会话列表里每条会话的最后活跃时间：用户扫一眼就能知道这条是刚聊的还是陈年
 * 旧账，不必去读绝对日期。空/非法时间戳返回空串（列表项就不显示时间）。
 *
 * 单位阈值（与「几月/几年」的整数量级对齐）：
 *   < 1 分钟   → 刚刚
 *   < 60 分钟  → N 分钟前
 *   < 24 小时  → N 小时前
 *   < 30 天    → N 天前
 *   < 12 个月  → N 个月前（按 30 天计一个月，简单稳定）
 *   >= 12 个月 → N 年前
 */
function formatRelativeTime(iso) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diff = Date.now() - then;
  if (diff < 0) return "刚刚";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "刚刚";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  // 按整 30 天计一个月，足够稳定且不与「N 天前」重叠（29 天仍显示「29 天前」）
  const month = Math.floor(day / 30);
  if (month < 12) return `${month} 个月前`;
  const year = Math.floor(month / 12);
  return `${year} 年前`;
}

// ---------- 思考行（独立折叠，默认收起） ----------

/**
 * 新建一个思考行。
 *
 * 标题：流式中是「正在思考」（带扫光），落定后是「思考 · 持续了 N 秒」。
 * 正文默认收起，标题右侧在流式期间显示最后一行作为单行摘要（超宽省略），
 * 这样不用展开也能看出它在想什么——对齐 ZCode 的 ReasoningTrigger。
 */
function createReasoningRow(text, { settled = false, durationMs } = {}) {
  const row = document.createElement("details");
  row.className = "reasoning-row";
  row.dataset.raw = text || "";

  const trigger = document.createElement("summary");
  trigger.className = "reasoning-trigger";
  const label = document.createElement("span");
  label.className = "reasoning-label" + (settled ? "" : " streaming");
  label.textContent = settled ? "思考" : "正在思考";
  trigger.appendChild(label);
  const meta = document.createElement("span");
  meta.className = "reasoning-meta";
  meta.textContent = settled ? (durationMs ? `· ${formatDuration(durationMs)}` : "· 持续了几秒") : "";
  trigger.appendChild(meta);
  const stream = document.createElement("span");
  stream.className = "reasoning-stream";
  trigger.appendChild(stream);
  row.appendChild(trigger);

  const content = document.createElement("div");
  content.className = "reasoning-content";
  const textEl = document.createElement("div");
  textEl.className = "reasoning-text";
  textEl.textContent = text || "";
  content.appendChild(textEl);
  row.appendChild(content);

  if (settled) {
    row.dataset.settled = "1";
  } else {
    row.dataset.startedAt = String(Date.now());
    row.dataset.settled = "0";
  }
  updateReasoningStream(row);
  return row;
}

/** 流式期间的一行摘要：取最后一行非空文本；展开或落定后隐藏 */
function updateReasoningStream(row) {
  const stream = row.querySelector(".reasoning-stream");
  if (!stream) return;
  if (row.dataset.settled === "1" || row.open) {
    stream.textContent = "";
    stream.hidden = true;
    return;
  }
  const raw = row.dataset.raw || "";
  const lines = raw.split("\n").map((s) => s.trim()).filter(Boolean);
  const last = lines.length ? lines[lines.length - 1] : "";
  stream.textContent = last;
  stream.hidden = !last;
}

/** 一段思考结束：标题落定 + 记下真实耗时（前端时钟） */
function finalizeReasoningRow(row) {
  if (!row || row.dataset.settled === "1") return;
  const startedAt = Number(row.dataset.startedAt || 0);
  const durationMs = startedAt ? Date.now() - startedAt : 0;
  row.dataset.settled = "1";
  const label = row.querySelector(".reasoning-label");
  if (label) {
    label.textContent = "思考";
    label.classList.remove("streaming");
  }
  const meta = row.querySelector(".reasoning-meta");
  if (meta) meta.textContent = `· ${formatDuration(durationMs)}`;
  updateReasoningStream(row);
}

/**
 * 思考增量：写入当前思考行。
 *
 * 后端 chat:thinking 的 content 是**整轮累计**的思考文本（工具调用后继续累加），
 * 这里要把它切成「按发生顺序排列、互不重复」的行：
 *   - 末尾还是思考行（上一段仍开放）→ 只追加增长的部分；
 *   - 末尾是工具行（说明上一段已结束）→ 新起一行，展示全量里的新增部分。
 */
function appendThinking(params) {
  const full = typeof params?.content === "string" ? params.content : null;
  const delta = params?.delta || "";
  // 闸门关闭（编辑重发/停止后旧轮残留）：丢弃，避免写进新一轮的折叠区
  if (!streamGateOpen) return;
  const work = ensureTurnWork();
  const body = work.querySelector(".turn-work-body");
  const prevFull = work.dataset.thinkingFull || "";
  const nextFull = full != null ? full : prevFull + delta;
  // 正常情况下全量渐进增长；若后端重置过缓冲（不以旧全量为前缀），退化为「整段重写」
  const grown = nextFull.startsWith(prevFull);
  const last = body.lastElementChild;
  let openRow = last && last.classList.contains("reasoning-row") && last.dataset.settled !== "1" ? last : null;
  if (!openRow) {
    // 上一段思考（若还挂着）先落定，再开新行
    body.querySelectorAll(".reasoning-row").forEach((r) => finalizeReasoningRow(r));
    openRow = createReasoningRow("", { settled: false });
    body.appendChild(openRow);
  }
  const textEl = openRow.querySelector(".reasoning-text");
  if (grown && !openRow.dataset.rewritten) {
    const part = nextFull.slice(prevFull.length);
    openRow.dataset.raw = (openRow.dataset.raw || "") + part;
  } else {
    openRow.dataset.raw = nextFull;
    openRow.dataset.rewritten = "1";
  }
  textEl.textContent = openRow.dataset.raw;
  work.dataset.thinkingFull = nextFull;
  updateReasoningStream(openRow);
  scrollToBottom();
}

// ---------- 工具行（单行内联摘要，点击展开参数与结果） ----------

/** 工具家族 + 状态 → 类别词（后端已给 kindLabel；这里兜底，便于 mock / 旧数据） */
const KIND_LABELS = {
  read: { running: "正在读取", success: "已读取", error: "读取失败" },
  write: { running: "正在写入", success: "已写入", error: "写入失败" },
  edit: { running: "正在编辑", success: "已编辑", error: "编辑失败" },
  execute: { running: "正在执行", success: "已执行", error: "执行失败" },
  search: { running: "正在搜索", success: "已搜索", error: "搜索失败" },
  list: { running: "正在浏览", success: "已浏览", error: "浏览失败" },
  fetch: { running: "正在获取", success: "已获取", error: "获取失败" },
  agent: { running: "正在调用", success: "已调用", error: "调用失败" },
  other: { running: "正在执行", success: "已执行", error: "执行失败" },
};

/** 工具名 → 家族（与后端 toolKind 同一套判定；旧数据没带 kind 时兜底） */
function inferToolKind(name) {
  const n = String(name || "").toLowerCase().replace(/^(mcp|tool|my|_)+[_-]?/, "");
  if (!n) return "other";
  if (/(read|cat|view)/.test(n)) return "read";
  if (/(write|create_file)/.test(n)) return "write";
  if (/(edit|replace|patch|apply)/.test(n)) return "edit";
  if (/(bash|shell|terminal|command|exec|run)/.test(n)) return "execute";
  if (/(list|ls|dir|glob)/.test(n)) return "list";
  if (/(search|grep|find|query)/.test(n)) return "search";
  if (/(fetch|web|http|curl|download|url)/.test(n)) return "fetch";
  if (/(subagent|sub_agent|agent|task)/.test(n)) return "agent";
  return "other";
}

/** 家族 + 状态 → 类别词 */
function toolKindLabel(kindOrName, status) {
  if (status === "stopped") return "已停止";
  const kind = KIND_LABELS[kindOrName] ? kindOrName : inferToolKind(kindOrName);
  const words = KIND_LABELS[kind] || KIND_LABELS.other;
  return status === "running" ? words.running : status === "error" ? words.error : words.success;
}

/** 状态 → 类名（供 CSS 上色：运行蓝 / 成功绿 / 失败红 / 停止灰） */
function toolStatusClass(status) {
  if (status === "running") return "running";
  if (status === "error") return "error";
  if (status === "stopped") return "stopped";
  return "success";
}

/** 工具状态 → 图标 */
function toolIconSvg(status) {
  if (status === "running") {
    return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><path d="M12 6v6l4 2"></path></svg>';
  }
  if (status === "success") {
    return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>';
  }
  if (status === "error") {
    return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
  }
  return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="6" y1="12" x2="18" y2="12"></line></svg>';
}

/** 过长文本截断（工具结果） */
function clipText(text, max) {
  const t = String(text == null ? "" : text);
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/**
 * 新建工具行。
 *
 * 单行摘要：`图标 + 类别词 + 主文本 + 变更量 + 次文本 + 箭头`。
 * 点开才看参数（inputJson）与结果 / 报错（resultText）。
 * `data-tool-id` / `data-status` 保留——toolCallId 精确配对与「执行中→已停止」
 * 的收尾都依赖它们。
 */
function createToolRow(params) {
  const row = document.createElement("details");
  row.className = "tool-row";
  if (params.toolCallId) row.dataset.toolId = params.toolCallId;
  row.dataset.tool = params.toolName || "";
  row.dataset.kind = params.kind || inferToolKind(params.toolName);
  row.dataset.status = params.status || "running";

  const head = document.createElement("summary");
  head.className = "tool-row-head";
  const icon = document.createElement("span");
  icon.className = "tool-row-icon";
  head.appendChild(icon);
  const kind = document.createElement("span");
  kind.className = "tool-row-kind";
  head.appendChild(kind);
  const primary = document.createElement("span");
  primary.className = "tool-row-primary";
  head.appendChild(primary);
  const change = document.createElement("span");
  change.className = "tool-row-change";
  head.appendChild(change);
  const secondary = document.createElement("span");
  secondary.className = "tool-row-secondary";
  head.appendChild(secondary);
  const chevron = document.createElement("span");
  chevron.className = "tool-row-chevron";
  chevron.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>';
  head.appendChild(chevron);
  row.appendChild(head);

  const bodyEl = document.createElement("div");
  bodyEl.className = "tool-row-body";
  row.appendChild(bodyEl);

  renderToolRow(row, params);
  return row;
}

/** 按参数刷新工具行的摘要与展开内容（实时事件与历史回填共用） */
function renderToolRow(row, params) {
  const status = row.dataset.status || "running";
  const statusClass = toolStatusClass(status);
  row.classList.remove("tool-running", "tool-error", "tool-stopped", "tool-success");
  row.classList.add("tool-" + statusClass);

  // 类别词：后端 kindLabel 优先；否则按 kind / 工具名 + 状态推导
  const kindEl = row.querySelector(".tool-row-kind");
  if (kindEl) {
    kindEl.textContent = (params && params.kindLabel) || toolKindLabel(row.dataset.kind || row.dataset.tool, status);
    kindEl.className = "tool-row-kind " + statusClass;
  }
  const iconEl = row.querySelector(".tool-row-icon");
  if (iconEl) {
    iconEl.className = "tool-row-icon " + statusClass;
    iconEl.innerHTML = toolIconSvg(status);
  }

  // 主文本 / 次文本 / 变更量：新字段优先，回退到旧的 detail / label
  // （旧数据里路径与命令在 detail，比 label 那一句「📖 读取文件」有信息量）
  const primaryEl = row.querySelector(".tool-row-primary");
  if (primaryEl) {
    if (params && params.primaryText) row.dataset.primaryText = params.primaryText;
    let primary = row.dataset.primaryText || "";
    if (!primary && params && params.detail) primary = params.detail;
    if (!primary && params && params.label) primary = params.label;
    primaryEl.textContent = primary;
    primaryEl.hidden = !primary;
  }
  const secondaryEl = row.querySelector(".tool-row-secondary");
  if (secondaryEl) {
    if (params && params.secondaryText) row.dataset.secondaryText = params.secondaryText;
    const secondary = row.dataset.secondaryText || "";
    secondaryEl.textContent = secondary;
    secondaryEl.hidden = !secondary;
  }
  const changeEl = row.querySelector(".tool-row-change");
  if (changeEl) {
    if (params && params.changeStat) row.dataset.changeStat = params.changeStat;
    const cs = row.dataset.changeStat || "";
    changeEl.textContent = cs;
    changeEl.hidden = !cs;
  }

  // 展开内容：参数 + 结果 / 报错
  if (params && params.inputJson) row.dataset.inputJson = params.inputJson;
  if (params && params.resultText != null && params.resultText !== "") row.dataset.resultText = params.resultText;
  const bodyEl = row.querySelector(".tool-row-body");
  if (bodyEl) renderToolRowBody(bodyEl, row.dataset.inputJson || "", row.dataset.resultText || "", status);
}

/** 展开区：参数块 + 结果块（失败时结果块直接显示可读错误） */
function renderToolRowBody(bodyEl, inputJson, resultText, status) {
  bodyEl.innerHTML = "";
  if (inputJson) {
    const block = document.createElement("div");
    block.className = "tool-block";
    const title = document.createElement("div");
    title.className = "tool-block-title";
    title.textContent = "参数";
    block.appendChild(title);
    const pre = document.createElement("pre");
    pre.className = "tool-block-pre";
    pre.textContent = inputJson;
    block.appendChild(pre);
    bodyEl.appendChild(block);
  }
  if (resultText) {
    const block = document.createElement("div");
    block.className = "tool-block" + (status === "error" ? " tool-block-error" : "");
    const title = document.createElement("div");
    title.className = "tool-block-title";
    title.textContent = status === "error" ? "错误" : "结果";
    block.appendChild(title);
    const pre = document.createElement("pre");
    pre.className = "tool-block-pre";
    pre.textContent = clipText(resultText, 4000);
    block.appendChild(pre);
    bodyEl.appendChild(block);
  }
  bodyEl.hidden = !inputJson && !resultText;
}

/** 更新工具行状态 / 结果（实时事件与历史回填共用） */
function updateToolRow(row, params) {
  if (!row) return;
  if (params && params.status) row.dataset.status = params.status;
  renderToolRow(row, params || {});
}

/** 按 toolCallId 查已有工具行（全聊天区查——历史与实时共用同一轮时也能对上） */
function findToolRow(params) {
  const id = params && params.toolCallId;
  if (id) {
    const esc = String(id).replace(/"/g, '\\"');
    return chatBody.querySelector('.tool-row[data-tool-id="' + esc + '"]');
  }
  // 无 id 时兜底：本轮最后一张「执行中」的行
  const acc = turnAgentNode && turnAgentNode.querySelector(".turn-work .turn-work-body");
  if (!acc) return null;
  const rows = acc.querySelectorAll(".tool-row");
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].dataset.status === "running") return rows[i];
  }
  return null;
}

/** 把节点内仍在「执行中」的工具行标记为已停止（用户中止 / 请求被打断） */
function stopRunningToolRows(root) {
  if (!root) return;
  root.querySelectorAll(".tool-row.tool-running").forEach((el) => updateToolRow(el, { status: "stopped" }));
}

/** 工具调用 — 渲染为单行摘要（按 toolCallId 精确配对，避免同名工具串台） */
function appendTool(params) {
  // 闸门关闭（编辑重发/停止后旧轮残留）：丢弃，避免写进新一轮的动作分组
  if (!streamGateOpen) return;
  hideWelcome();
  removeTyping();
  const status = params.status || "running";
  const existing = findToolRow(params);
  if (existing) {
    // 运行中的重复通知不覆盖；结束通知更新状态与结果
    if (status !== "running") updateToolRow(existing, { ...params, status });
    scrollToBottom();
    return;
  }
  const work = ensureTurnWork();
  const body = work.querySelector(".turn-work-body");
  // 新工具开始 = 上一段思考结束
  body.querySelectorAll(".reasoning-row").forEach((r) => finalizeReasoningRow(r));
  const row = createToolRow({ ...params, status });
  body.appendChild(row);
  scrollToBottom();
}

function showTyping() {
  removeTyping();
  const node = appendMessage("agent", "");
  node.id = "pi-typing-indicator";
  node.dataset.sealed = "1";
  const bubble = node.querySelector(".message-content");
  bubble.innerHTML = '<span class="pi-typing"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span>';
  scrollToBottom();
}

function removeTyping() {
  const el = document.getElementById("pi-typing-indicator");
  if (el) el.remove();
}

function showError(msg) {
  removeTyping();
  hideWelcome();
  const div = document.createElement("div");
  div.className = "pi-error";
  div.textContent = msg;
  chatBody.appendChild(div);
  scrollToBottom();
}

/** 轻量内联提示（用于图片相关提醒，不依赖宿主 toast） */
function piToast(msg, kind = "warn") {
  let el = document.getElementById("pi-inline-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "pi-inline-toast";
    el.className = "pi-inline-toast";
    const root = document.getElementById("pi-agent");
    (root || document.body).appendChild(el);
  }
  el.className = "pi-inline-toast " + (kind || "warn");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(el.__t);
  el.__t = setTimeout(() => { el.hidden = true; }, 3200);
}

/** 当前选中的模型是否支持图片输入（models 里 image 字段） */
function currentModelSupportsImages() {
  const sel = models.find((x) => {
    const v = x.provider ? `${x.provider}:${x.id}` : x.id;
    return v === currentModelId;
  });
  // 找不到模型信息时不阻断（避免未知模型被误伤），但明确不支持时返回 false。
  if (!sel) return true;
  return Boolean(sel.image);
}

/**
 * 把一个图片文件（File/Blob）读成 data URL，并缩放到最长边 maxDim 以内，
 * 以控制粘贴/拖放/选择大图时的 base64 体积（历史重载也会传输这些图）。
 * 返回 { dataUrl, data(base64), mimeType }；读取/解码失败返回 null。
 */
async function fileToImagePayload(file, maxDim = 1600) {
  let dataUrl;
  try {
    dataUrl = await readFileAsDataUrl(file);
  } catch (e) { return null; }
  const scaled = await downscaleDataUrl(dataUrl, maxDim);
  const mimeType = scaled.mimeType || file?.type || "image/png";
  const data = scaled.dataUrl.split(",").pop() || "";
  return { dataUrl: scaled.dataUrl, data, mimeType };
}

function readFileAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error || new Error("读取失败"));
    reader.readAsDataURL(blob);
  });
}

/** 用 canvas 把 data URL 缩放到最长边 maxDim 以内（保持原格式，PNG 透明保留） */
function downscaleDataUrl(dataUrl, maxDim) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || 0, h = img.naturalHeight || 0;
      if (!w || !h || (w <= maxDim && h <= maxDim)) {
        resolve({ dataUrl, mimeType: guessMime(dataUrl) });
        return;
      }
      const scale = Math.min(1, maxDim / Math.max(w, h));
      const tw = Math.max(1, Math.round(w * scale));
      const th = Math.max(1, Math.round(h * scale));
      const canvas = document.createElement("canvas");
      canvas.width = tw; canvas.height = th;
      const ctx = canvas.getContext("2d");
      if (!ctx) { resolve({ dataUrl, mimeType: guessMime(dataUrl) }); return; }
      ctx.drawImage(img, 0, 0, tw, th);
      // 透明图保持 PNG，其余按原类型（截图大多 png，照片 jpeg）
      const srcMime = guessMime(dataUrl);
      const outMime = srcMime === "image/png" ? "image/png" : (srcMime || "image/png");
      let out;
      try { out = canvas.toDataURL(outMime, 0.85); } catch (e) { out = dataUrl; }
      resolve({ dataUrl: out, mimeType: outMime });
    };
    img.onerror = () => resolve({ dataUrl, mimeType: guessMime(dataUrl) });
    img.src = dataUrl;
  });
}

function guessMime(dataUrl) {
  const m = /^data:([^;,]+)/.exec(dataUrl || "");
  return m ? m[1] : "";
}

/** 当前待发送的图片（{dataUrl,data,mimeType} 列表） */
let pendingImages = [];
const MAX_PENDING_IMAGES = 8;

/** 把一张（已转成的）图片加入待发送队列并刷新 chip 预览 */
function addPendingImage(payload, name) {
  if (!payload || !payload.data) return;
  if (pendingImages.length >= MAX_PENDING_IMAGES) {
    piToast(`最多附带 ${MAX_PENDING_IMAGES} 张图片`);
    return;
  }
  if (!currentModelSupportsImages()) {
    piToast("当前模型不支持图片输入，请先切换到支持图片的模型");
    return;
  }
  pendingImages.push({ ...payload, name: name || "图片" });
  renderPendingImageChips();
  updateImageWarn();
  updateSendButtonState();
}

/** 渲染输入框上方的待发送图片 chip */
function renderPendingImageChips() {
  const box = document.getElementById("pi-image-chips");
  if (!box) return;
  box.innerHTML = "";
  box.hidden = pendingImages.length === 0;
  pendingImages.forEach((im, idx) => {
    const chip = document.createElement("div");
    chip.className = "pi-image-chip";
    const thumb = document.createElement("img");
    thumb.src = im.dataUrl;
    thumb.alt = im.name || "图片";
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "pi-image-chip-remove";
    rm.title = "移除";
    rm.textContent = "×";
    rm.addEventListener("click", (e) => {
      e.stopPropagation();
      pendingImages.splice(idx, 1);
      renderPendingImageChips();
      updateImageWarn();
      updateSendButtonState();
    });
    chip.appendChild(thumb);
    chip.appendChild(rm);
    box.appendChild(chip);
  });
}

/** 模型不支持图片时，在输入框上方显示提示横幅 */
function updateImageWarn() {
  const warn = document.getElementById("pi-image-warn");
  if (!warn) return;
  const blocked = pendingImages.length > 0 && !currentModelSupportsImages();
  warn.hidden = !blocked;
}

function clearPendingImages() {
  pendingImages = [];
  renderPendingImageChips();
  updateImageWarn();
}

/** 从剪贴板/文件列表里挑出图片文件并加入待发送队列（忽略非图片） */
async function addImageFiles(fileList) {
  const files = Array.from(fileList || []).filter((f) => String(f?.type || "").startsWith("image/"));
  for (const f of files) {
    const payload = await fileToImagePayload(f);
    if (payload) addPendingImage(payload, f?.name);
  }
}

/**
 * 宿主投递：文件/文件夹被拖进了本插件界面（真实路径）。
 *
 * 两类落点分流：
 *   - **文件夹** → 加为项目（`addProjectPath`）——对应左侧栏「拖拽添加项目」；
 *   - **图片文件** → 加入待发送图片队列（原有行为）。
 *
 * `entries` 是宿主补充的 `{ path, isDir }` 描述（见 usePluginViewHost 的
 * notifyPluginDrop）：插件自己无法判定 isDir，只能依赖宿主回传。旧宿主不带
 * `entries` 时退化为「全部当文件」，仍是原来只处理图片的行为，不会误把
 * 文件夹当图片去读（读文件夹会失败并被下面的 catch 静默吃掉）。
 */
function ingestDroppedPaths(paths, entries) {
  if (!paths || !paths.length) return;

  // 建立 path → isDir 映射（大小写/分隔符无关地匹配）
  const dirSet = new Set();
  if (Array.isArray(entries)) {
    for (const en of entries) {
      if (en && en.isDir) dirSet.add(normalizePath(en.path));
    }
  }
  const isDir = (p) => dirSet.has(normalizePath(p));

  const folders = paths.filter(isDir);
  const files = paths.filter((p) => !isDir(p));

  if (folders.length > 0) void ingestDroppedFolders(folders);

  if (files.length === 0) return;
  if (!ms.input || typeof ms.input.readFile !== "function") {
    piToast("缺少 file.read 权限，无法读取拖入的图片");
    return;
  }
  if (!currentModelSupportsImages()) {
    piToast("当前模型不支持图片输入，请先切换模型");
    return;
  }
  for (const p of files) {
    Promise.resolve(ms.input.readFile(p)).then((dataUrl) => {
      const blob = dataUrlToBlob(dataUrl);
      return fileToImagePayload(blob, 1600).then((payload) => {
        if (payload) addPendingImage(payload, String(p).split(/[\\/]/).pop() || "图片");
      });
    }).catch((e) => {
      // 拖入的非图片（文本等）静默忽略；图片读取失败才提示
      if (/image/i.test(String(p))) piToast(`读取拖入文件失败：${String((e && e.message) || e)}`);
    });
  }
}

/**
 * 把拖入的文件夹逐个加为项目。
 *
 * 多个文件夹时逐个添加（后端有去重），最后切到第一个成功的；全部失败则提示。
 * 添加完统一 `loadProjects` 一次而不是每个都刷，减少闪烁。
 */
async function ingestDroppedFolders(folders) {
  let firstAdded = null;
  let failCount = 0;
  for (const folder of folders) {
    try {
      const r = await addProjectPath(folder);
      if (r?.project && !firstAdded) firstAdded = r.project;
    } catch (e) {
      failCount += 1;
      showError(`添加项目失败：${String((e && e.message) || e)}`);
    }
  }
  if (folders.length > 1) {
    await loadProjects();
  } else if (failCount === 0) {
    await loadProjects();
  }
  const okCount = folders.length - failCount;
  if (okCount > 1) piToast(`已添加 ${okCount} 个项目`);
}

function dataUrlToBlob(dataUrl) {
  try {
    const [head, b64] = String(dataUrl || "").split(",");
    const mime = (/data:([^;]+)/.exec(head) || [])[1] || "image/png";
    const bin = atob(b64 || "");
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  } catch (e) {
    return null;
  }
}

/** 绑定图片相关的输入事件（粘贴 / 选择文件 / 拖放投递） */
function bindImageInputs() {
  // 幂等：理由同 bindEvents（init 可能被多次调用）
  if (imageInputsBound) return;
  imageInputsBound = true;
  // 粘贴：剪贴板里的图片（截图 / 复制的图片）
  inputEl.addEventListener("paste", (e) => {
    const cd = e.clipboardData || (e.originalEvent && e.originalEvent.clipboardData);
    if (!cd) return;
    // 只处理“有文件”的粘贴；纯文本粘贴保持原生（不拦截、不丢撤销栈）
    const hasFiles = (cd.files && cd.files.length > 0) || Array.from(cd.types || []).includes("Files");
    if (!hasFiles) return;
    const imageItems = Array.from(cd.items || []).filter((it) => it?.kind === "file" && /image\//.test(it?.type || ""));
    if (!imageItems.length) return; // 非图片文件：交给宿主默认处理（进搜索框附件）
    e.preventDefault();
    const files = imageItems.map((it) => it.getAsFile()).filter(Boolean);
    void addImageFiles(files);
  });

  // 选择本地图片文件
  const fileInput = document.getElementById("pi-file-input");
  if (fileInput) {
    fileInput.addEventListener("change", (e) => {
      const files = e.target.files;
      void addImageFiles(files);
      e.target.value = "";
    });
  }
  const fileBtn = document.getElementById("pi-attach-btn");
  if (fileBtn) fileBtn.addEventListener("click", (e) => {
    e.preventDefault();
    if (fileInput) fileInput.click();
  });

  // 宿主把拖入本界面（真实路径）的文件投递过来。
  // detail.entries 带 {path,isDir}，据此把「文件夹」当项目、「图片」当附件。
  onDoc(document, "ms-dropped-paths", (e) => {
    const detail = (e && e.detail) || {};
    setDropActive(false);
    ingestDroppedPaths(detail.paths, detail.entries);
  });

  // 拖拽悬停高亮（原生拖放下 HTML5 dragover 不会触发，靠宿主投递的状态）：
  // detail = { active, hit }，hit 是宿主 elementFromPoint 找到的悬停元素。
  // 只有悬停落在左侧项目栏内才高亮——拖到输入区/会话列表不应误导用户。
  onDoc(document, "ms-drop-hover", (e) => {
    const detail = (e && e.detail) || {};
    if (!detail.active) { setDropActive(false); return; }
    setDropActive(isOverSidebar(detail.hit));
  });

  // 兼容旧宿主 / 浏览器调试：未开启原生拖放时 HTML5 dragover 仍会触发。
  // 有原生拖放的宿主里这两条永远收不到（宿主处理器先吃掉了），但不冲突。
  const leftbar = document.querySelector(".pi-agent-container .sidebar-left");
  if (leftbar) {
    leftbar.addEventListener("dragover", (e) => {
      // 只有拖「文件（含文件夹）」才提示，内部元素拖拽不响应
      const types = e.dataTransfer && e.dataTransfer.types;
      const hasFiles = types && Array.from(types).includes("Files");
      if (!hasFiles && !(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length)) return;
      e.preventDefault();
      setDropActive(true);
    });
    leftbar.addEventListener("dragleave", (e) => {
      // 只有真正离开栏（relatedTarget 不在栏内）才取消
      if (!leftbar.contains(e.relatedTarget)) setDropActive(false);
    });
    leftbar.addEventListener("drop", () => setDropActive(false));
  }
}

/** 悬停元素是否落在左侧项目栏内（含栏内任意子元素） */
function isOverSidebar(hit) {
  if (!hit) return false;
  const leftbar = document.querySelector(".pi-agent-container .sidebar-left");
  if (!leftbar) return false;
  // hit 可能是 Element（宿主直接传入），用 closest 向上找；
  // 宿主也可能传 null / 非元素，用 contains 兜底。
  if (typeof hit.closest === "function") {
    const inside = hit.closest(".pi-agent-container .sidebar-left");
    if (inside === leftbar) return true;
  }
  return leftbar.contains(hit);
}

/** 开关左侧栏的「可拖入添加项目」高亮 */
function setDropActive(on) {
  const leftbar = document.querySelector(".pi-agent-container .sidebar-left");
  if (leftbar) leftbar.classList.toggle("pi-drop-active", !!on);
}

function scrollToBottom() {
  const threshold = 80;
  const atBottom = chatBody.scrollHeight - chatBody.scrollTop - chatBody.clientHeight < threshold;
  if (!atBottom) {
    updateScrollBottomButton();
    return;
  }
  requestAnimationFrame(() => {
    chatBody.scrollTop = chatBody.scrollHeight;
    updateScrollBottomButton();
  });
}

function forceScrollToBottom() {
  requestAnimationFrame(() => {
    chatBody.scrollTop = chatBody.scrollHeight;
    updateScrollBottomButton();
  });
}

let suppressScrollButton = false;

function updateScrollBottomButton() {
  if (!scrollBottomBtn) return;
  if (suppressScrollButton) return;
  const threshold = 80;
  const atBottom = chatBody.scrollHeight - chatBody.scrollTop - chatBody.clientHeight < threshold;
  scrollBottomBtn.hidden = atBottom;
}

function jumpToLatest() {
  if (!scrollBottomBtn) return;
  scrollBottomBtn.hidden = true;
  suppressScrollButton = true;
  const done = () => {
    suppressScrollButton = false;
    updateScrollBottomButton();
  };
  try {
    chatBody.scrollTo({ top: chatBody.scrollHeight, behavior: "smooth" });
    setTimeout(done, 400);
  } catch (e) {
    chatBody.scrollTop = chatBody.scrollHeight;
    done();
  }
}

/**
 * 后端是否曾处于 running（用于「重启一次只对账一次」）。
 * 初值 true：首次收到 running 通知不算「重连」，避免启动时多打一次后端。
 */
let backendWasRunning = true;

/**
 * 后端重启后的权威对账。
 *
 * 后端进程重启会丢掉内存里的会话 runtime 与 pendingAsk——前端必须放弃本地
 * 账本、重新问后端，否则「运行中 / 待回答」会一直是过期状态（卡片点了没反应）。
 * 这里只对**当前打开的会话**对账（其余会话在切回时本来就会走 selectSession 的
 * 对账路径，不必提前唤醒它们的后端 runtime）。
 */
async function reconcileAfterReconnect() {
  const projectPath = currentProject?.path || "";
  const sessionId = currentSessionId || "";
  if (!projectPath || !sessionId) return;
  try {
    // 运行态：以这次查询为准（后端刚重启，之前的 running 已不存在）
    const st = await ms.backend.call("getSessionStatus", { projectPath, sessionId });
    if (currentProject?.path !== projectPath || currentSessionId !== sessionId) return;
    if (st?.running) {
      runningSessions.set(sessionId, { projectPath, sessionId });
      setSendButtonRunning(true);
      showTyping();
    } else {
      runningSessions.delete(sessionId);
      removeTyping();
      syncSendButton();
    }
  } catch (e) { /* 后端不可用时保持现状，等下一次对账 */ }
  try {
    // 待回答卡片：后端重启后 pendingAsk 已空，前端的卡片要一并撤掉
    await restoreAskCard(sessionId);
  } catch (e) { /* ignore */ }
  void refreshProjectFlags();
}

// ===================== 后端通知 =====================

function setupNotificationHandlers() {
  if (typeof ms.backend.onNotification !== "function") return;
  if (typeof ms.backend._clearNotifications === "function") {
    try { ms.backend._clearNotifications(); } catch (e) { /* ignore */ }
  }

  /**
   * 后端进程状态变更（崩溃 / 重启 / 被停止）。
   *
   * 后端一重启，它内存里的会话运行态与 pendingAsk 全部归零；前端若继续拿旧账本
   * 显示「运行中 / 待回答」，用户会看到卡片点了没反应、按钮卡在「停止」。
   * 这里在后端进入非 running 状态时清掉本地运行账本，并在恢复为 running 后
   * 对当前会话做一次权威对账（getSessionStatus / getPendingAsk）。
   */
  const onBackendState = (state) => {
    try {
      const status = String(state?.status || "");
      if (!status) return;
      const wasRunning = backendWasRunning;
      // 后端进程不在了（停止/崩溃/出错）：本地一切运行态都不可信，先清账本
      if (status !== "running") {
        backendWasRunning = false;
        for (const [sid, rec] of [...runningSessions]) {
          runningSessions.delete(sid);
          patchSessionFlag(sid, "unseen");
        }
        syncSendButton();
        removeTyping();
        return;
      }
      // 后端重新拉起：恢复对账（仅一次，避免重复通知时反复打后端）
      if (!wasRunning) {
        backendWasRunning = true;
        void reconcileAfterReconnect();
      }
    } catch (e) { /* ignore */ }
  };
  if (typeof ms.backend.onBackendChanged === "function") {
    ms.backend.onBackendChanged(onBackendState);
  }

  ms.backend.onNotification("chat:delta", (params) => {
    if (!isCurrentSessionNotification(params)) return;
    if (params?.delta || params?.content) appendDelta(params);
  });
  ms.backend.onNotification("chat:thinking", (params) => {
    if (!isCurrentSessionNotification(params)) return;
    if (params?.delta || params?.content) appendThinking(params);
  });
  ms.backend.onNotification("chat:tool", (params) => {
    if (!isCurrentSessionNotification(params)) return;
    if (params) appendTool(params);
  });
  ms.backend.onNotification("chat:status", (params) => {
    const sid = params?.sessionId;
    const isRunning = params?.status === "running";
    const isIdle = params?.status === "idle";
    // 无论当前看哪个会话，都先更新「运行会话」账本，保证切换回该会话时能恢复运行态
    if (sid) {
      if (isRunning) {
        runningSessions.set(sid, {
          projectPath: params?.projectPath || currentProject?.path || "",
          sessionId: sid,
        });
        patchSessionFlag(sid, "running");
        // 别的项目上的会话开跑 → 立刻拉一次项目计数，让那个项目的黄点马上亮起
        void refreshProjectFlags();
      } else if (isIdle) {
        runningSessions.delete(sid);
        patchSessionFlag(sid, sid === currentSessionId ? null : "unseen");
        // 跑完 → 该项目的黄点应消失；若不在当前会话则转为绿点（未查看）
        void refreshProjectFlags();
      }
    }
    // 只在本会话的通知才会动当前视图/按钮
    if (!isCurrentSessionNotification(params)) return;
    if (isRunning) {
      // 新一轮真正开始 → 开闸，允许流式写入（此前丢弃的都是旧轮残留）
      streamGateOpen = true;
      showTyping();
      syncSendButton();
    } else if (isIdle) {
      removeTyping();
      // 后端在 idle 通知里带回本轮耗时 → 标题从「工作中 N 秒」落定为「已工作 N 秒」
      settleTurnWork(params?.durationMs);
      syncSendButton();
    }
  });
  // 用户消息落盘：把 entryId 挂到对应气泡上，实时发出的消息也能立即编辑
  ms.backend.onNotification("chat:user-entry", (params) => {
    if (!isCurrentSessionNotification(params)) return;
    if (!params?.entryId) return;
    const node = findLiveUserNode(params.text);
    if (!node) return;
    node.dataset.entryId = params.entryId;
    attachEditButton(node);
  });
  ms.backend.onNotification("chat:aborted", (params) => {
    if (params?.sessionId) {
      runningSessions.delete(params.sessionId);
      patchSessionFlag(params.sessionId, null);
    }
    if (!isCurrentSessionNotification(params)) return;
    removeTyping();
    if (turnAgentNode) turnAgentNode.dataset.sealed = "1";
    // 中止：仍在「执行中」的工具行 + 分组标题都落定为「已停止」
    stopRunningToolRows(chatBody);
    settleTurnWork(undefined, { stopped: true });
    syncSendButton();
  });
  // 任意会话出错（首轮发送失败 / 重发失败 / 模型不可用）：清掉运行态（不等轮询），
  // 并把原因展示出来。对齐 pi-web：不再据此把会话标成「处理失败」——错误是**本轮**
  // 的事实，不应该变成一个持久的会话状态（那正是把正常运行中的会话误标失败的根因）。
  ms.backend.onNotification("chat:error", (params) => {
    if (params?.sessionId) {
      runningSessions.delete(params.sessionId);
      patchSessionFlag(params.sessionId, null);
      // 别的项目上的会话出错 → 立刻拉一次项目计数，让那个项目的圆点及时归位
      void refreshProjectFlags();
    }
    if (!isCurrentSessionNotification(params)) return;
    removeTyping();
    if (turnAgentNode) turnAgentNode.dataset.sealed = "1";
    settleTurnWork(undefined, { stopped: true });
    syncSendButton();
    if (params?.error) showError(params.error);
  });

  // 问询类工具（ask / ask_user_question）开始执行：用它自带的 questions 结构，
  // 在聊天区弹一张**原生问答卡片**（而不是让扩展自绘 TUI）。
  ms.backend.onNotification("chat:ask", (params) => {
    // 先记账（供侧边栏「待回答」角标 + 切回恢复），再判断是否属于当前会话。
    // 不属于当前会话的，只留账本、不挂卡片——切过去时 restoreAskCard 会挂出来。
    rememberAsk(params);
    if (!isCurrentSessionNotification(params)) return;
    showAskCard(params);
  });

  // 后端把某个未作答的 ask 被动清掉了（轮次结束 / 会话重载 / 停止 / 被新 ask 顶掉）。
  // 这类卡片若还挂着就成了「点了没反应」的僵尸卡片，这里按会话精确移除。
  ms.backend.onNotification("chat:ask-cleared", (params) => {
    forgetAskFor(params?.sessionId || "", params?.toolCallId || "");
  });

  // 扩展通过 ctx.ui.select/confirm/input/editor/notify/custom 弹的通用 UI。
  // select/confirm/input/editor 渲染为通用弹框；custom 渲染为文本面板（兼容各种自绘界面）。
  ms.backend.onNotification("ext_ui:request", (params) => {
    showExtUiRequest(params);
  });
  ms.backend.onNotification("ext_ui:close", (params) => {
    closeExtUiById(params?.id);
  });
  ms.backend.onNotification("ext_ui:notify", (params) => {
    // pi 的 notify 类型是 info / warning / error，映射到 toast 的三种样式。
    // 关键：info（例如扩展在 agent_end 报「本轮已完成」）必须是中性色。
    // 以前它落到没有专属样式的基础类上，而基础类是报错红——正常完成提示看起来像报错。
    const type = params?.type;
    const kind = type === "error" ? "error" : type === "warning" ? "warn" : "info";
    piToast(String(params?.message || ""), kind);
  });
  ms.backend.onNotification("plugin:progress", (params) => {
    if (!isSettingsOpen() || settingsPane !== "plugins") return;
    if (!pluginsBusy) return;
    const msg = String(params?.message || "").trim();
    if (!msg) return;
    pluginsProgress = msg;
    // 只更新进度行文本，避免整页重绘打断输入
    const el = settingsBodyEl?.querySelector(".pi-plugins-progress");
    if (el) {
      el.textContent = msg;
    } else {
      renderSettingsBody();
    }
  });

  // pi 的 settings.json 被外部改动（如终端里 `pi install`）：后端会重载所有会话。
  // 这里刷新插件页，让「列表」和「agent 实际能用」始终一致。
  ms.backend.onNotification("plugin:changed", (params) => {
    const reloaded = Number(params?.reloaded) || 0;
    const deferred = Number(params?.deferred) || 0;
    if (isSettingsOpen() && settingsPane === "plugins") {
      void refreshPlugins();
    }
    if (reloaded + deferred > 0) {
      piToast(`pi 插件设置已变化，会话已重载${reloadHint({ reloaded, deferred })}`);
    }
  });

  // 后端进程级兜底（uncaughtException / unhandledRejection）：后端不会因此退出，
  // 但当前这一轮很可能是坏的——提示用户并做一次运行态对账，避免「一直转圈」。
  ms.backend.onNotification("backend:fatal", (params) => {
    console.warn("[PI] 后端异常:", params);
    piToast("后台发生异常（已自动恢复），如本轮无响应请重试");
    void reconcileAfterReconnect();
  });
}

// ===================== 扩展 UI：ask 卡片与通用弹框 =====================

/**
 * ask 问答卡片。
 *
 * 后端在 ask 工具开始执行时把 questions 结构发过来（chat:ask）。这里就在聊天区底部
 * 弹一张卡片：每个 question 按它的类型渲染
 *   - 有 options（单选）= 一排可点的选项（选完直接提交）
 *   - 有 options（multi 多选）= 可多选 + “确认”按钮
 *   - 无 options = 一个输入框
 * 选完后拼成一段**人类可读的文字**，当作普通用户消息发回给 agent（sendMessage）。
 * 这样与扩展实现解耦：无论它内部怎么 callUI，答案都走正常对话通道。
 */
function showAskCard(params) {
  const questions = Array.isArray(params?.questions) ? params.questions : [];
  if (!questions.length) return;
  const sid = params?.sessionId || currentSessionId || "";
  // 只收掉**本会话**已有的卡片（切回来时重挂、agent 又来一问时换新）。
  // 绝不能像早先那样 querySelectorAll 全删——那会把别的会话仍在等待的卡片也误删。
  removeAskCardFor(sid, params?.toolCallId);

  const card = document.createElement("div");
  card.className = "pi-ask-card";
  card.dataset.toolCallId = params?.toolCallId || "";
  card.dataset.sessionId = sid;
  // 会话切换的令牌：卡片是异步操作的目标，切走/重挂后旧回调不能再改动视图。
  if (currentSessionId) card.dataset.ownerSession = currentSessionId;

  const header = document.createElement("div");
  header.className = "pi-ask-card-header";
  header.innerHTML = '<span class="pi-ask-icon">?</span><span>需要你的回答</span>';
  card.appendChild(header);

  /** 每个 question 的当前选择：qid -> string | string[] */
  const answers = new Map();
  const inputsByQid = new Map();

  // 回填用户上次的选择（切走再切回时保留，不丢已选项/已输入文本）
  const saved = askCardStates.get(sid);
  const savedMatches = saved && String(saved.toolCallId || "") === String(params?.toolCallId || "");
  if (savedMatches) {
    for (const [k, v] of Object.entries(saved.answers || {})) {
      answers.set(k, Array.isArray(v) ? v.slice() : v);
    }
  }

  questions.forEach((q, qi) => {
    const qid = String(q?.id || q?.question || `q${qi}`);
    const block = document.createElement("div");
    block.className = "pi-ask-q";

    const title = document.createElement("div");
    title.className = "pi-ask-q-title";
    title.textContent = String(q?.question || q?.header || `问题 ${qi + 1}`);
    block.appendChild(title);

    if (q?.description) {
      const desc = document.createElement("div");
      desc.className = "pi-ask-q-desc";
      desc.innerHTML = typeof md2html === "function" ? md2html(String(q.description)) : escHtml(String(q.description));
      block.appendChild(desc);
    }

    const options = Array.isArray(q?.options) ? q.options : [];
    const isMulti = Boolean(q?.multi || q?.multiSelect || q?.multiple);

    if (options.length) {
      const list = document.createElement("div");
      list.className = isMulti ? "pi-ask-options multi" : "pi-ask-options";
      options.forEach((opt, oi) => {
        const value = String(opt?.label ?? opt?.value ?? opt);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "pi-ask-option";
        btn.dataset.value = value;
        const label = document.createElement("span");
        label.className = "pi-ask-option-label";
        label.textContent = value;
        btn.appendChild(label);
        const hintText = opt?.description || opt?.hint || "";
        if (hintText) {
          const hint = document.createElement("span");
          hint.className = "pi-ask-option-hint";
          hint.textContent = String(hintText);
          btn.appendChild(hint);
        }
        if (opt?.recommended) {
          const rec = document.createElement("span");
          rec.className = "pi-ask-option-rec";
          rec.textContent = "推荐";
          btn.appendChild(rec);
        }
        btn.addEventListener("click", () => {
          if (isMulti) {
            const cur = Array.isArray(answers.get(qid)) ? answers.get(qid) : [];
            const idx = cur.indexOf(value);
            if (idx >= 0) cur.splice(idx, 1);
            else cur.push(value);
            answers.set(qid, cur);
            btn.classList.toggle("selected", cur.includes(value));
            updateAskSubmit(card);
          } else {
            answers.set(qid, value);
            list.querySelectorAll(".pi-ask-option").forEach((n) => n.classList.remove("selected"));
            btn.classList.add("selected");
            updateAskSubmit(card);
          }
        });
        list.appendChild(btn);
      });
      // 回填多选的已选项（切回会话时保留）
      if (isMulti) {
        const cur = Array.isArray(answers.get(qid)) ? answers.get(qid) : [];
        answers.set(qid, cur);
        list.querySelectorAll(".pi-ask-option").forEach((n) => {
          if (cur.includes(n.dataset.value)) n.classList.add("selected");
        });
      } else if (answers.get(qid) != null) {
        const cur = String(answers.get(qid));
        list.querySelectorAll(".pi-ask-option").forEach((n) => {
          if (n.dataset.value === cur) n.classList.add("selected");
        });
      }
      block.appendChild(list);
    } else {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.className = "pi-ask-input";
      inp.placeholder = String(q?.placeholder || "输入你的回答…");
      if (savedMatches && saved.texts && saved.texts[qid] != null) {
        inp.value = String(saved.texts[qid]);
        answers.set(qid, inp.value);
      }
      inp.addEventListener("input", () => {
        answers.set(qid, inp.value);
        updateAskSubmit(card);
      });
      block.appendChild(inp);
      inputsByQid.set(qid, inp);
    }
    card.appendChild(block);
  });

  const footer = document.createElement("div");
  footer.className = "pi-ask-footer";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "pi-ask-btn ghost";
  cancelBtn.textContent = "取消";
  cancelBtn.addEventListener("click", () => {
    // 用户明确取消：账本与已选状态都作废，别再在切回时把这张卡片挂回来
    forgetAskFor(sid, params?.toolCallId);
    card.remove();
    // 告知后端：用户取消这次问答（让等待中的 ask 以“取消”结束，不卡住）
    void ms.backend
      .call("askCancel", { toolCallId: params?.toolCallId })
      .catch(() => {});
  });
  const submitBtn = document.createElement("button");
  submitBtn.type = "button";
  submitBtn.className = "pi-ask-btn primary";
  submitBtn.textContent = "提交";
  submitBtn.disabled = true;
  submitBtn.addEventListener("click", () => {
    const answerList = [];
    questions.forEach((q, qi) => {
      const qid = String(q?.id || q?.question || `q${qi}`);
      const picked = answers.get(qid);
      let val;
      if (Array.isArray(picked)) val = picked.join("、");
      else val = picked == null ? "" : String(picked);
      if (!String(val).trim()) return;
      answerList.push({
        id: qid,
        question: String(q?.question || q?.header || `问题 ${qi + 1}`),
        value: val,
      });
    });
    if (!answerList.length) return;
    forgetAskFor(sid, params?.toolCallId); // 已作答：账本/暂存状态作废
    card.remove();
    // 把用户的回答回显到聊天区（agent 回复会紧跟在后面）。
    // 只有卡片确实属于当前会话时才回显——否则会把答案画到别的会话的聊天区里。
    if (!card.dataset.ownerSession || card.dataset.ownerSession === currentSessionId) {
      const echo = answerList.map((a) => `${a.question}：${a.value}`).join("；");
      appendMessage("user", echo);
    }
    // 把答案交回正等待的 ask 工具（不再当普通消息发，否则会多问一轮）
    void ms.backend
      .call("askAnswer", { toolCallId: params?.toolCallId, answers: answerList })
      .catch(() => { /* 后端自己处理 */ });
  });
  footer.appendChild(cancelBtn);
  footer.appendChild(submitBtn);
  card.appendChild(footer);

  function updateAskSubmit(elm) {
    const btn = elm.querySelector(".pi-ask-btn.primary");
    if (!btn) return;
    let ok = false;
    questions.forEach((q, qi) => {
      const qid = String(q?.id || q?.question || `q${qi}`);
      const v = answers.get(qid);
      if (Array.isArray(v) ? v.length : (v && String(v).trim())) ok = true;
    });
    btn.disabled = !ok;
  }

  // 把「当前选择」挂到卡片上，供切走归档时读取（避免闭包外拿不到 answers/inputsByQid）
  card.__collectAskState = () => {
    const ans = {};
    for (const [k, v] of answers.entries()) ans[k] = Array.isArray(v) ? v.slice() : v;
    const texts = {};
    for (const [k, el] of inputsByQid.entries()) texts[k] = el.value;
    return { toolCallId: params?.toolCallId || "", answers: ans, texts };
  };

  updateAskSubmit(card); // 回填后同步「提交」可用态（如切回时已选过）
  chatBody.appendChild(card);
  card.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

/**
 * 记下某会话来了一个待回答 ask（供侧边栏角标 / 切回恢复用）。
 * 同时刷新会话列表，让「待回答」提示即时出现。
 */
function rememberAsk(params) {
  const sid = params?.sessionId;
  if (!sid) return;
  pendingAskBySession.set(sid, params);
  renderSessions();
  renderProjects(); // 项目图标右下角的黄问号提示（当前项目即时生效）
  // 这个 ask 可能属于**别的项目**（用户在 B 项目，A 项目里某会话来了个 ask）。
  // 当前项目的黄问号靠内存账本即可；别的项目要问后端拿 askCount——用轻量的
  // getAskCounts（只读内存），别用 listProjects（对每个项目全量扫会话文件，会卡）。
  void refreshAskCounts();
}

/** 移除某会话的 ask 卡片 DOM（可按 toolCallId 精确匹配，缺省则移除该会话的全部） */
function removeAskCardFor(sessionId, toolCallId) {
  chatBody.querySelectorAll(".pi-ask-card").forEach((n) => {
    if (sessionId && n.dataset.sessionId !== sessionId) return;
    if (toolCallId && n.dataset.toolCallId !== String(toolCallId)) return;
    n.remove();
  });
}

/**
 * 彻底忘掉某会话的待回答 ask：账本 + 暂存状态 + 卡片 DOM。
 * 用于「已作答 / 用户取消 / 后端通知失效」三种终态。
 */
function forgetAskFor(sessionId, toolCallId) {
  const sid = sessionId || "";
  const cur = pendingAskBySession.get(sid);
  // toolCallId 给定时只在该 id 匹配时清账本，避免「新 ask 已顶掉旧 ask」时误清新账本
  if (cur && (!toolCallId || String(cur.toolCallId || "") === String(toolCallId))) {
    pendingAskBySession.delete(sid);
  }
  if (!toolCallId) askCardStates.delete(sid);
  else {
    const st = askCardStates.get(sid);
    if (st && String(st.toolCallId || "") === String(toolCallId)) askCardStates.delete(sid);
  }
  removeAskCardFor(sid, toolCallId);
  renderSessions();
  renderProjects(); // 可能要让项目图标的黄问号消失
  void refreshAskCounts(); // 同步其它项目的黄问号（轻量查询，别用 listProjects）
}

/**
 * 切走会话前，把当前未提交卡片的选择暂存起来（切回时回填）。
 * 没有卡片就什么都不做，避免覆盖更早暂存的状态。
 */
function archiveCurrentAskState() {
  const sid = currentSessionId || "";
  if (!sid) return;
  const card = chatBody.querySelector(`.pi-ask-card[data-session-id="${cssEscape(sid)}"]`);
  if (!card || typeof card.__collectAskState !== "function") return;
  askCardStates.set(sid, card.__collectAskState());
}

/**
 * 切回会话时把待回答卡片挂回来：先看内存账本，没有就问后端（getPendingAsk）兜底。
 * 后端没有在等（已取消/轮次结束/已作答）就什么都不挂，并清掉过期账本。
 */
async function restoreAskCard(sessionId) {
  const projectPath = currentProject?.path || "";
  let params = pendingAskBySession.get(sessionId) || null;
  try {
    const res = await ms.backend.call("getPendingAsk", { projectPath, sessionId });
    if (currentProject?.path !== projectPath || currentSessionId !== sessionId) return;
    const serverAsk = res?.pendingAsk;
    if (serverAsk) {
      // 后端为准；内存账本缺 questions 时用后端补全
      params = {
        ...(params || {}),
        sessionId,
        projectPath,
        toolCallId: serverAsk.toolCallId,
        questions: serverAsk.questions,
      };
      pendingAskBySession.set(sessionId, params);
    } else {
      pendingAskBySession.delete(sessionId);
      askCardStates.delete(sessionId);
      renderSessions();
      renderProjects(); // 后端已无待回答：黄问号/待回答角标一并清掉
      return;
    }
  } catch (e) {
    // 查询失败就退回内存账本（离线的老 ask 仍尽量恢复）
    if (currentProject?.path !== projectPath || currentSessionId !== sessionId) return;
    if (!params) return;
  }
  if (!params) return;
  // 已有卡片就别重复挂（例如恢复期间又收到一次 chat:ask）
  if (chatBody.querySelector(`.pi-ask-card[data-session-id="${cssEscape(sessionId)}"]`)) return;
  showAskCard(params);
}

/** escHtml 兼容：项目里可能叫别的名字 */
function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** 当前打开的扩展 UI 弹框（id → 清理函数） */
const extUiDialogs = new Map();

/**
 * 渲染扩展通过 ctx.ui.* 弹的通用 UI。
 *   select / confirm / input / editor → 通用弹框，回传结果
 *   custom                           → 文本面板（把扩展自绘的 TUI 行显示出来，接收按键）
 */
function showExtUiRequest(params) {
  const id = params?.id;
  if (!id) return;
  closeExtUiById(id);
  const kind = params?.kind;
  if (kind === "custom") return showExtUiCustom(params);

  const overlay = document.createElement("div");
  overlay.className = "pi-extui-overlay";
  const box = document.createElement("div");
  box.className = "pi-extui-box";

  const title = document.createElement("div");
  title.className = "pi-extui-title";
  title.textContent = String(params?.title || "扩展请求");
  box.appendChild(title);

  let getValue = () => undefined;

  if (params?.message) {
    const msg = document.createElement("div");
    msg.className = "pi-extui-message";
    msg.innerHTML = typeof md2html === "function" ? md2html(String(params.message)) : escHtml(String(params.message));
    box.appendChild(msg);
  }

  if (kind === "select") {
    const list = document.createElement("div");
    list.className = "pi-ask-options";
    const options = Array.isArray(params.options) ? params.options : [];
    let chosen;
    options.forEach((opt) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pi-ask-option";
      btn.textContent = String(opt);
      btn.addEventListener("click", () => {
        list.querySelectorAll(".pi-ask-option").forEach((n) => n.classList.remove("selected"));
        btn.classList.add("selected");
        chosen = String(opt);
        confirmBtn.disabled = false;
      });
      list.appendChild(btn);
    });
    box.appendChild(list);
    getValue = () => chosen;
  } else if (kind === "input") {
    const inp = document.createElement("input");
    inp.type = "text";
    inp.className = "pi-ask-input";
    inp.placeholder = String(params?.placeholder || "");
    box.appendChild(inp);
    getValue = () => inp.value;
  } else if (kind === "editor") {
    const ta = document.createElement("textarea");
    ta.className = "pi-extui-editor";
    ta.value = String(params?.prefill || "");
    box.appendChild(ta);
    getValue = () => ta.value;
  }

  const footer = document.createElement("div");
  footer.className = "pi-extui-footer";
  const confirmBtn = document.createElement("button");
  confirmBtn.type = "button";
  confirmBtn.className = "pi-ask-btn primary";
  confirmBtn.textContent = kind === "confirm" ? "确定" : "提交";
  if (kind === "select" || kind === "input" || kind === "editor") confirmBtn.disabled = kind === "select";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "pi-ask-btn ghost";
  cancelBtn.textContent = "取消";

  const respond = (value) => {
    closeExtUiById(id);
    void ms.backend.call("extUiRespond", { id, value }).catch(() => {});
  };
  confirmBtn.addEventListener("click", () => {
    if (kind === "confirm") respond(true);
    else respond(getValue());
  });
  cancelBtn.addEventListener("click", () => {
    if (kind === "confirm") respond(false);
    else respond(undefined);
  });
  footer.appendChild(cancelBtn);
  footer.appendChild(confirmBtn);
  box.appendChild(footer);
  overlay.appendChild(box);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) cancelBtn.click(); });
  document.body.appendChild(overlay);
  const inp = box.querySelector("input,textarea");
  inp?.focus();

  extUiDialogs.set(id, () => overlay.remove());
}

/** custom UI：把扩展自绘的文本行显示为面板，按键回传 */
function showExtUiCustom(params) {
  const id = params?.id;
  let overlay = document.querySelector(`.pi-extui-overlay[data-id="${cssEscape(id)}"]`);
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "pi-extui-overlay";
    overlay.dataset.id = id;
    const box = document.createElement("div");
    box.className = "pi-extui-box pi-extui-terminal-box";
    const pre = document.createElement("pre");
    pre.className = "pi-extui-terminal";
    pre.tabIndex = 0;
    box.appendChild(pre);
    const hint = document.createElement("div");
    hint.className = "pi-extui-hint";
    hint.textContent = "↑↓ 选择 · Enter 确认 · Esc 取消";
    box.appendChild(hint);
    overlay.appendChild(box);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) sendExtUiInput(id, "\u001b"); });
    pre.addEventListener("keydown", (e) => {
      let data = null;
      if (e.key === "ArrowUp") data = "\u001b[A";
      else if (e.key === "ArrowDown") data = "\u001b[B";
      else if (e.key === "Enter") data = "\r";
      else if (e.key === "Escape") data = "\u001b";
      else if (e.key === " ") data = " ";
      else if (e.key.length === 1) data = e.key;
      if (data != null) { e.preventDefault(); sendExtUiInput(id, data); }
    });
    document.body.appendChild(overlay);
    pre.focus();
    extUiDialogs.set(id, () => overlay.remove());
  }
  const pre = overlay.querySelector(".pi-extui-terminal");
  if (pre) pre.textContent = (Array.isArray(params.lines) ? params.lines : []).join("\n");
}

/** 把一次按键回传给后端的 custom UI */
function sendExtUiInput(id, input) {
  void ms.backend.call("extUiRespond", { id, value: { input } }).catch(() => {});
}

/** 关闭某个扩展 UI 弹框 */
function closeExtUiById(id) {
  const cleanup = extUiDialogs.get(id);
  if (cleanup) {
    try { cleanup(); } catch (e) { /* ignore */ }
    extUiDialogs.delete(id);
  }
}

/** CSS.escape 兼容 */
function cssEscape(s) {
  if (window.CSS && typeof CSS.escape === "function") return CSS.escape(String(s));
  return String(s).replace(/["\\]/g, "\\$&");
}

// ===================== 发送消息 =====================

/**
 * 后端单次调用的超时上限（毫秒）：清单声明 → 宿主下发 → 兜底 5 分钟。
 * 只用于文案展示，避免把时长写死在与 manifest 脱节的地方。
 */
function callTimeoutMs() {
  const n = Number(ms.plugin?.info?.callTimeoutMs);
  return Number.isFinite(n) && n > 0 ? n : 300000;
}

/** 超时文案：<60s 显示秒，否则显示分钟 */
function formatCallTimeout() {
  const sec = Math.round(callTimeoutMs() / 1000);
  return sec < 60 ? `${sec} 秒` : `${Math.round(sec / 60)} 分钟`;
}

async function sendMessage(text) {
  if (!text.trim() && pendingImages.length === 0) return;
  if (currentSessionId && runningSessions.has(currentSessionId)) return;
  if (!currentProject) {
    showError("请先添加项目");
    return;
  }
  // 模型不支持图片却带了图：直接阻止发送（按你的取舍：明确不支持就拦截）
  if (pendingImages.length > 0 && !currentModelSupportsImages()) {
    piToast("当前模型不支持图片输入，请先切换到支持图片的模型");
    return;
  }

  const messageText = text.trim();
  // 记录本次调用对应的会话：await 期间用户可能切到别的会话，
  // currentSessionId 已变化，收尾/渲染都必须以 thisSessionId 为准
  const thisSessionId = currentSessionId;
  inputEl.value = "";
  autoResizeInput();
  // 取出本次要发的图片（base64 + mimeType），发完即清空
  const images = pendingImages.map((im) => ({ data: im.data, mimeType: im.mimeType }));
  clearPendingImages();
  updateSendButtonState();
  streamGateOpen = true;   // 正常新一轮：开闸接收流式
  const userNode = appendMessage("user", messageText, null, undefined, images);
  beginAgentTurn();
  showTyping();
  runningSessions.set(thisSessionId, { projectPath: currentProject.path, sessionId: thisSessionId });
  // 刚发消息 → 该会话的最后消息时间就是此刻：先把它提到最前（时间序），
  // 再打「进行中」标记（patchSessionFlag 会重绘，覆盖掉这里的排序结果）
  bumpSessionToTop(thisSessionId);
  patchSessionFlag(thisSessionId, "running");
  setSendButtonRunning(true);

  try {
    const result = await ms.backend.call("chat", {
      projectPath: currentProject.path,
      sessionId: thisSessionId,
      message: messageText,
      model: currentModelId,
      images,
    });
    // 结果只渲染进「仍正在查看该会话」的视图；已切走则交给 loadSession 转录，
    // 避免把 A 的完成内容写进 B 的聊天区
    if (currentSessionId === thisSessionId) {
      // 兜底：若 chat:user-entry 通知没赶上，用返回值补上 entryId（实时可编辑）
      if (result?.userEntryId && userNode.isConnected && !userNode.dataset.entryId) {
        userNode.dataset.entryId = result.userEntryId;
        attachEditButton(userNode);
      }
      removeTyping();
      const finalText = result?.content || "";
      if (!finalText) {
        showError("Pi 未返回有效响应");
      } else {
        const node = currentTurnNode();
        const bubble = node.querySelector(".message-content");
        const streamed = node.dataset.raw || "";
        const next = streamed && streamed.length >= finalText.length ? streamed : finalText;
        bubble.dataset.raw = next;
        bubble.innerHTML = md2html(next);
        node.dataset.raw = next;
      }
      if (turnAgentNode) turnAgentNode.dataset.sealed = "1";
      settleTurnWork();
    }
    void refreshSessionMeta();
  } catch (e) {
    if (currentSessionId === thisSessionId) {
      removeTyping();
      if (turnAgentNode) turnAgentNode.dataset.sealed = "1";
      settleTurnWork();
      if (e.message && (e.message.includes("abort") || e.message.includes("cancel"))) {
        // 静默处理
      } else if (e.message && e.message.includes("调用超时")) {
        // 宿主侧超时：后端可能仍在流式执行，给一个友好提示且保留「停止」能力。
        // 时长取自清单（避免与 callTimeoutMs 脱节后文案说谎）。
        showError(
          `请求超时（已等待 ${formatCallTimeout()}）：后台可能仍在运行，可继续等待或点「停止」。` +
          "若持续无响应，请检查模型服务是否可用。"
        );
      } else {
        showError(`请求失败: ${e.message || e}`);
      }
    }
  } finally {
    // 不直接清账本：超时只是 RPC 被宿主掐断，后端可能仍在流式执行。
    // 以「后端真实运行态」为准对账，避免「视图里状态丢了、实际还在跑」的假死。
    if (currentSessionId === thisSessionId) {
      try {
        const st = await ms.backend.call("getSessionStatus", {
          projectPath: currentProject?.path || "",
          sessionId: thisSessionId,
        });
        if (st?.running) {
          runningSessions.set(thisSessionId, { projectPath: currentProject?.path || "", sessionId: thisSessionId });
        } else {
          runningSessions.delete(thisSessionId);
        }
      } catch (e) {
        runningSessions.delete(thisSessionId);
      }
      syncSendButton();
    }
    inputEl.focus();
  }
}

/** 停止当前正在运行的 agent */
async function stopAgent() {
  if (!currentSessionIsRunning()) return;
  const rec = runningSessions.get(currentSessionId);
  sendBtn.disabled = true;
  // 关闸：丢弃 abort 后仍在途的旧轮 delta（否则会继续往已停止的气泡里追加）
  streamGateOpen = false;
  try {
    await ms.backend.call("abort", {
      projectPath: rec?.projectPath || currentProject?.path || "",
      sessionId: currentSessionId,
    });
  } catch (e) {
    console.warn("[PI] 停止 agent 失败:", e);
  }
  if (turnAgentNode) turnAgentNode.dataset.sealed = "1";
  stopRunningToolRows(chatBody);
  settleTurnWork(undefined, { stopped: true });
  removeTyping();
  if (currentSessionId) runningSessions.delete(currentSessionId);
  patchSessionFlag(currentSessionId, null);
  syncSendButton();
  inputEl.focus();
  void refreshSessionMeta();
}

/** 会话元信息刷新 */
async function refreshSessionMeta({ force = false } = {}) {
  // 加载中不发轮询请求：loadSessions 正在跑，轮询响应回来反而可能乱序覆盖
  if (!currentProject || sessionsLoading) return;
  const projectPath = currentProject.path;
  const seq = ++sessionsReqSeq;
  try {
    const listed = await ms.backend.call("listSessions", { projectPath });
    // 过期响应：已切换项目或有更新的请求 → 丢弃
    if (seq !== sessionsReqSeq || currentProject?.path !== projectPath) return;
    const next = sortSessionsByTime(listed?.sessions || []);
    const changed =
      force ||
      next.length !== sessions.length ||
      next.some((s, i) => s.id !== sessions[i]?.id || s.title !== sessions[i]?.title || s.flag !== sessions[i]?.flag);
    sessions = next;
    // 用后端标记补充「正在运行」的会话（核对账本，避免 remount/轮询后丢失运行态）
    for (const s of sessions) {
      if (s.flag === "running") {
        runningSessions.set(s.id, { projectPath, sessionId: s.id });
      }
    }
    if (currentProject) {
      currentProject.sessionCount = sessions.length;
      currentProject.badgeCount = listed?.badgeCount ?? 0;
    }
    if (changed) {
      renderSessions();
      renderProjects();
      const cur = sessions.find((x) => x.id === currentSessionId);
      if (cur) {
        const label = sessionLabel(cur.id);
        chatHeader.textContent = `${label ? label + " " : ""}${cur.title}`;
        chatHeader.title = chatHeader.textContent;
      }
    }
  } catch (e) { /* 静默 */ }
}

/** 定期同步会话列表 */
function startSessionPolling() {
  // 先清后设：本函数在每次 loadSessions() 成功后都会调用（切项目/加项目），
  // 不清就会每切一次项目多留一个 8s 定时器在打后端（与 startRelTimeRefresh /
  // startProjectPolling 的写法保持一致）。
  if (sessionPollTimer) clearInterval(sessionPollTimer);
  sessionPollTimer = setInterval(() => {
    // 任一会话在跑就避让轮询——此时内存里的 flag 是「正在运行」的实时态，
    // 轮询反而会用旧数据干扰列表；运行结束后 map 清空、恢复轮询。
    if (document.hidden || runningSessions.size > 0 || !currentProject) return;
    void refreshSessionMeta();
  }, 8000);
}

/**
 * 轻量刷新会话列表里的相对时间标签（「3 分钟前」→「4 分钟前」）。
 * 不重排、不重拉后端，只把每个标签按当前时刻重新算一遍，避免慢轮询覆盖不到
 * 「标签随真实时间变旧」的情况。无标签（新会话/空时间戳）直接跳过。
 */
function startRelTimeRefresh() {
  if (relTimeTimer) clearInterval(relTimeTimer);
  relTimeTimer = setInterval(() => {
    if (document.hidden || !sessionListEl) return;
    const nodes = sessionListEl.querySelectorAll(".session-time[data-time]");
    for (const node of nodes) {
      const t = node.dataset.time;
      if (!t) continue;
      const next = formatRelativeTime(t);
      if (next && node.textContent !== next) node.textContent = next;
    }
  }, 30000);
}

/**
 * 只刷新各项目的「待回答」计数（黄问号）。
 *
 * 走轻量 RPC getAskCounts（后端纯内存统计），**不要**用 refreshProjectFlags
 * 里的 listProjects——那条路径会对每个项目做 SessionManager.list（全量扫会话
 * 文件，大项目能到秒级），只为亮一个问号去付那个代价，就是黄问号反应慢的根因。
 * ask 出现/消失都调它，跨项目的问号才能即时响应。
 */
async function refreshAskCounts() {
  try {
    const result = await ms.backend.call("getAskCounts");
    const counts = result?.counts || {};
    let changed = false;
    for (const p of projects) {
      const next = Number(counts[p.path]) || 0;
      if (p.askCount !== next) {
        p.askCount = next;
        changed = true;
      }
    }
    if (changed) renderProjects();
  } catch (e) {
    /* 静默：拿不到就沿用内存账本/上次的值 */
  }
}

/**
 * 拉一次 listProjects，把各项目的状态圆点计数（running/unseen）合并进内存，
 * 有变化就重绘左栏图标。
 *
 * 当前项目的圆点由内存 sessions[].flag 实时决定（见 projectFlags），
 * 这里更新的是**其它项目**的圆点——它们只能来自后端。
 */
async function refreshProjectFlags() {
  if (projectPollBusy) return;
  projectPollBusy = true;
  try {
    const result = await ms.backend.call("listProjects");
    const next = result?.projects || [];
    if (next.length === 0) return;
    let changed = false;
    for (const p of next) {
      const cur = projects.find((x) => x.path === p.path);
      if (!cur) continue;
      if (
        cur.runningCount !== p.runningCount ||
        cur.unseenCount !== p.unseenCount ||
        cur.badgeCount !== p.badgeCount ||
        cur.askCount !== p.askCount
      ) {
        cur.runningCount = p.runningCount;
        cur.unseenCount = p.unseenCount;
        cur.badgeCount = p.badgeCount;
        cur.askCount = p.askCount;
        changed = true;
      }
    }
    if (changed) renderProjects();
  } catch (e) {
    /* 静默：拉不到就保持上一次的状态 */
  } finally {
    projectPollBusy = false;
  }
}

/**
 * 定期同步各项目状态圆点（不受「有会话在跑」影响）。
 *
 * 间隔不必太短：开始/结束运行时的即时变化已由 chat:status 里的
 * refreshProjectFlags 兜住（那条路径是瞬时的），这里只是防止漏事件的对账。
 */
function startProjectPolling() {
  if (projectPollTimer) clearInterval(projectPollTimer);
  projectPollTimer = setInterval(() => {
    if (document.hidden) return;
    // 黄问号先走轻量查询（只读内存、0ms 级），别让它被下面的慢查询拖住；
    // listProjects 只对账 running/unseen 圆点。
    void refreshAskCounts();
    void refreshProjectFlags();
  }, 6000);
}

// ===================== 事件绑定 =====================

function bindEvents() {
  // 幂等：init() 可能被多次调用（如安装完 pi 后重新 init），重复绑定会让一次
  // 点击触发两遍、并让 document 上的匿名监听越积越多。每次会话只绑一次。
  if (eventsBound) return;
  eventsBound = true;
  sendBtn.addEventListener("click", () => {
    if (sendBtn.classList.contains("running")) {
      stopAgent();
    } else {
      sendMessage(inputEl.value);
    }
  });
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (inputEl.value.trim().length > 0) {
        sendMessage(inputEl.value);
      }
    }
  });
  inputEl.addEventListener("input", () => {
    autoResizeInput();
    updateSendButtonState();
  });
  // 图片输入：粘贴 / 选择文件 / 拖放投递（需在 init 末尾、所有 DOM 就绪后绑定）
  bindImageInputs();
  modelSelect.addEventListener("change", () => {
    currentModelId = modelSelect.value;
    updateModelDisplay();
    // 模型切换可能影响图片支持：刷新待发送图片的「不支持」提示与发送按钮态
    updateImageWarn();
    updateSendButtonState();
    void ms.backend.call("setConfig", { model: currentModelId }).catch(() => {});
  });
  $("pi-add-project").addEventListener("click", (e) => {
    e.stopPropagation();
    const pop = $("pi-add-popover");
    if (pop.hidden) showAddProjectPopover();
    else hideAddProjectPopover();
  });
  $("pi-cancel-add").addEventListener("click", hideAddProjectPopover);
  $("pi-confirm-add").addEventListener("click", confirmAddProject);
  const pickFolderBtn = $("pi-pick-folder");
  if (pickFolderBtn) pickFolderBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    void pickFolderAndAdd();
  });
  $("pi-project-path").addEventListener("keydown", (e) => {
    if (e.key === "Enter") confirmAddProject();
    if (e.key === "Escape") hideAddProjectPopover();
  });
  onDoc(document, "click", (e) => {
    const pop = $("pi-add-popover");
    if (pop && !pop.hidden && !pop.contains(e.target) && e.target.closest?.("#pi-add-project") == null) {
      hideAddProjectPopover();
    }
  });
  $("pi-settings-btn").addEventListener("click", () => {
    hideAddProjectPopover();
    void openSettings();
  });
  // 设置左菜单：切换「模型配置 / 外观」两个页
  document.querySelectorAll(".pi-settings-nav-item").forEach((el) => {
    el.addEventListener("click", () => setSettingsPane(el.getAttribute("data-pane")));
  });
  if (settingsCloseBtn) settingsCloseBtn.addEventListener("click", closeSettings);
  onDoc(document, "keydown", (e) => {
    if (e.key === "Escape" && isSettingsOpen()) {
      e.stopPropagation();
      closeSettings();
    }
  }, true);
  loadMoreBtn.addEventListener("click", () => loadMoreRounds());
  chatBody.addEventListener("scroll", () => updateScrollBottomButton(), { passive: true });
  if (scrollBottomBtn) scrollBottomBtn.addEventListener("click", jumpToLatest);
  if (installBtn) installBtn.addEventListener("click", handleInstall);
  if (installSkip && installOverlay) {
    installSkip.addEventListener("click", () => {
      installOverlay.hidden = true;
    });
  }
}
function autoResizeInput() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + "px";
}

// ===================== 子关键词处理 =====================

function handleSubKeyword() {
  if (typeof onSubKeyword === "function") {
    onSubKeyword(function (msg) {
      const text = typeof msg === "string" ? msg.trim() : "";
      if (text) sendMessage(text);
    });
  }
  if (inputValue && typeof inputValue === "string") {
    const parts = inputValue.split(" : ");
    const sub = parts.length >= 2 ? parts[1].trim() : "";
    if (sub) {
      const trySend = (attempt = 0) => {
        if (currentProject && currentSessionId) sendMessage(sub);
        else if (attempt < 20) setTimeout(() => trySend(attempt + 1), 300);
      };
      setTimeout(() => trySend(), 300);
    }
  }
}

// ===================== 清理 =====================

/**
 * 从后端 config 恢复上次卸载时保存的视图状态。
 * 在 loadProjects 之前调用，loadProjects 会优先使用恢复的值。
 */
async function restoreSavedState() {
  try {
    const result = await ms.backend.call('getConfig');
    const st = result?.config?.savedState;
    if (st && typeof st === 'object') {
      savedState.projectPath = String(st.projectPath || '');
      savedState.sessionId = String(st.sessionId || '');
    }
  } catch (e) {
    savedState = { projectPath: '', sessionId: '' };
  }
}

let cleanedUp = false;
function cleanup() {
  // 幂等：宿主在会话销毁时调用，重挂/重复调用不应重复清理。
  if (cleanedUp) return;
  cleanedUp = true;
  // 保存当前视图状态到后端 config（跨 mount 恢复用）
  if (savedState.projectPath || savedState.sessionId) {
    try { ms.backend.call('setConfig', { savedState }).catch(() => {}); } catch (e) { /* ignore */ }
  }
  // 清掉**所有**轮询定时器：早先只清了 sessionPollTimer / relTimeTimer，
  // 漏掉 projectPollTimer（6s）与 turnWorkTicker——视图已销毁却仍在打后端。
  if (sessionPollTimer) { clearInterval(sessionPollTimer); sessionPollTimer = null; }
  if (relTimeTimer) { clearInterval(relTimeTimer); relTimeTimer = null; }
  if (projectPollTimer) { clearInterval(projectPollTimer); projectPollTimer = null; }
  if (typeof turnWorkTicker !== "undefined" && turnWorkTicker) {
    clearInterval(turnWorkTicker);
    turnWorkTicker = null;
  }
  // 移掉本会话挂到 document/window 上的监听，避免重挂后重复触发
  removeDocListeners();
  // 释放可能挂在浮层里的扩展 UI 对话框（连同定时器等）
  try { for (const id of [...extUiDialogs.keys()]) closeExtUiById(id); } catch (e) { /* ignore */ }
  if (ms.backend._clearNotifications) ms.backend._clearNotifications();
  if (ms.ui?._clearThemeHandlers) ms.ui._clearThemeHandlers();
}
if (host.__msPluginCleanup === undefined) {
  host.__msPluginCleanup = cleanup;
}

// ===================== 启动 =====================

init().catch((e) => {
  console.error("[PI] 初始化失败:", e);
});

})(ms, env, plugin, host, keyword, inputValue, onSubKeyword, md2html, openExternal);
