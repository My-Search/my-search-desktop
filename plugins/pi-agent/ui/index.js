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
/** 正在新建会话（防连点） */
let creatingSession = false;
/** 会话列表定期同步的定时器 */
let sessionPollTimer = null;
/** 会话列表加载态：true 时中间栏显示「加载中…」占位（首屏初始化 / 切换项目期间） */
let sessionsLoading = false;
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
 * 上次卸载（cleanup）时保存的会话视图状态，用于 remount 后恢复。
 * 切换项目/会话时同步更新，cleanup 时将当前值写入后端 config。
 */
let savedState = { projectPath: "", sessionId: "" };

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
    const hasText = inputEl.value.trim().length > 0;
    sendBtn.disabled = !hasText;
  }
}

/** 根据输入内容更新发送按钮可用状态 */
function updateSendButtonState() {
  if (sendBtn.classList.contains("running")) return;
  const hasText = inputEl.value.trim().length > 0;
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

// ===================== 初始化 =====================

async function init() {
  bindEvents();
  setupNotificationHandlers();
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
    modelDisplay.textContent = "模型加载失败";
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
}

function updateModelDisplay() {
  const selected = modelSelect.selectedOptions?.[0];
  const m = models.find((x) => {
    const v = x.provider ? `${x.provider}:${x.id}` : x.id;
    return v === currentModelId;
  });
  modelDisplay.textContent = selected?.textContent || m?.name || m?.id || "未选择模型";
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

/** 打开设置（同时把提供商列表拉一遍） */
async function openSettings() {
  if (!settingsEl) return;
  settingsError = "";
  editingProviderId = null;
  editingIsNew = false;
  settingsEl.hidden = false;
  settingsBodyEl.innerHTML = "";
  const loading = document.createElement("div");
  loading.className = "pi-settings-empty";
  loading.textContent = "正在读取 pi 的模型配置…";
  settingsBodyEl.appendChild(loading);
  await refreshProviders();
}

function closeSettings() {
  if (!settingsEl) return;
  settingsEl.hidden = true;
  editingProviderId = null;
  editingIsNew = false;
  settingsError = "";
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
  settingsBodyEl.innerHTML = "";

  // 左栏脚注：告诉用户改的是哪个文件（出问题时知道去哪儿看）
  if (settingsPathEl) {
    settingsPathEl.textContent = providersData?.modelsPath || providersData?.agentDir || "—";
    settingsPathEl.title = providersData?.modelsPath || "";
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
    ok.textContent = "已配密钥";
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
  wrap.appendChild(secretWrap);

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
    icon.title = `${p.name || p.path}\n${p.path}\n（右键移除）`;
    icon.textContent = projectLabel(p);

    const count =
      currentProject?.path === p.path
        ? Number.isFinite(currentProject.badgeCount)
          ? currentProject.badgeCount
          : countFlaggedSessions()
        : p.badgeCount || 0;
    if (count > 0) {
      const badge = document.createElement("span");
      badge.className = "status-badge green";
      badge.textContent = count > 99 ? "99+" : String(count);
      icon.appendChild(badge);
    }

    icon.addEventListener("click", () => selectProject(p.path));
    icon.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      removeProject(p);
    });
    projectListEl.appendChild(icon);
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

  currentProject = p;
  currentSessionId = null;
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

async function confirmAddProject() {
  const raw = $("pi-project-path").value.trim();
  if (!raw) return;
  try {
    const result = await ms.backend.call("addProject", { path: raw });
    hideAddProjectPopover();
    if (result?.project) {
      await loadProjects();
      await selectProject(result.project.path);
    }
  } catch (e) {
    showError(`添加项目失败: ${e.message || e}`);
  }
}

// ===================== 会话 =====================

async function loadSessions() {
  if (!currentProject) {
    sessionsLoading = false;
    renderSessions();
    return;
  }
  try {
    const result = await ms.backend.call("listSessions", { projectPath: currentProject.path });
    sessions = result?.sessions || [];
    // 按最后消息时间（updatedAt）降序排列，最新的在最前
    sessions.sort((a, b) => {
      const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return tb - ta;
    });
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
  } catch (e) {
    sessionsLoading = false;
    renderSessions();
    showError(`加载会话失败: ${e.message || e}`);
  }
}

/** 会话是否属于「待处理」 */
function isPendingSession(s) {
  return s.flag === "running" || s.flag === "unseen" || s.pending === true;
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
  renderSessions();
  renderProjects();
}

function renderSessions() {
  sessionListEl.innerHTML = "";
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

  const pending = sessions.filter(isPendingSession);
  const rest = sessions.filter((s) => !isPendingSession(s) && s.id !== currentSessionId);
  const current = sessions.find((s) => s.id === currentSessionId && !isPendingSession(s));

  const visible = [...pending];
  if (current) visible.push(current);
  const restShown = sessionVisibleCount;
  visible.push(...rest.slice(0, restShown));

  const hiddenCount = rest.length - Math.min(restShown, rest.length);
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
  const i = sessions.indexOf(s);
  const item = document.createElement("div");
  item.className = "session-item" + (s.id === currentSessionId ? " active" : "");
  item.dataset.sessionId = s.id;

  const header = document.createElement("div");
  header.className = "session-header";
  const title = document.createElement("span");
  title.className = "session-title";
  const index = document.createElement("span");
  index.className = "session-index";
  index.textContent = `#${i + 1}`;
  title.appendChild(index);
  title.appendChild(document.createTextNode(" " + (s.title || s.id)));
  header.appendChild(title);
  if (s.id === currentSessionId) {
    const badge = document.createElement("span");
    badge.className = "badge progress";
    badge.textContent = "当前";
    header.appendChild(badge);
  }
  item.appendChild(header);

  const dotClass = s.flag === "running" ? "status-dot running" : s.flag === "unseen" ? "status-dot unseen" : "status-dot";
  const statusText =
    s.flag === "running" ? "进行中" : s.flag === "unseen" ? "已完成未查看" : s.pending ? "尚未开始" : "";
  if (s.messageCount > 0 || statusText) {
    const sub = document.createElement("div");
    sub.className = "sub-agent-list";
    const row = document.createElement("div");
    row.className = "sub-agent-item";
    const dot = document.createElement("div");
    dot.className = dotClass;
    row.appendChild(dot);
    const nameSpan = document.createElement("span");
    nameSpan.className = "sub-agent-name";
    const parts = [];
    if (statusText) parts.push(statusText);
    if (s.messageCount > 0) parts.push(`${s.messageCount} 条消息`);
    nameSpan.textContent = parts.join(" · ");
    row.appendChild(nameSpan);
    sub.appendChild(row);
    item.appendChild(sub);
  }

  item.addEventListener("click", () => selectSession(s.id));
  sessionListEl.appendChild(item);
}

async function selectSession(sessionId) {
  // 切换会话时立即保存状态
  savedState.sessionId = sessionId;
  if (currentProject) savedState.projectPath = currentProject.path;

  currentSessionId = sessionId;
  renderSessions();

  const s = sessions.find((x) => x.id === sessionId);
  chatHeader.textContent = s?.title ? `#${sessions.indexOf(s) + 1} ${s.title}` : "Pi Agent";

  clearChat();
  setSendButtonRunning(false);
  showWelcome("Pi Agent", "正在加载历史消息…");

  try { await ms.backend.call("markViewed", { projectPath: currentProject?.path || "", sessionId }); } catch (e) {}

  try {
    const result = await ms.backend.call("loadSession", {
      projectPath: currentProject?.path || "",
      sessionId,
    });
    loadedMessages = result?.transcript || [];
    clearChat();
    renderedFromEnd = loadedMessages.length;
    if (loadedMessages.length === 0) {
      showWelcome("Pi Agent", "这个会话还没有消息，在下面输入开始对话吧");
      return;
    }
    renderFrom(findLastRoundStart(loadedMessages), true);
    turnAgentNode = null;

    // 恢复后同步发送按钮状态——如果该会话正在运行中，显示「停止」并恢复打字指示器
    // 注意根据 runningSessions 判断，而不是 sessions[].flag（内存 flag 在运行中不会被刷新，会丢状态）
    if (currentSessionIsRunning()) {
      setSendButtonRunning(true);
      showTyping();
    }
  } catch (e) {
    console.warn("[PI] 读取会话历史失败:", e);
    clearChat();
    showWelcome("Pi Agent", "无法读取该会话的历史消息");
  }
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
    // 工具结果：挂到对应调用的卡片上
    if (msg && msg.role === "toolResult") {
      const card = msg.toolCallId ? findToolCard({ toolCallId: msg.toolCallId }) : null;
      if (card) {
        updateToolCard(card, { status: msg.isError ? "error" : "success", result: msg.content });
        updateAccordionSummaryCount(card.closest(".thought-accordion"));
      }
      continue;
    }
    const node = appendMessage(msg.role === "user" ? "user" : "agent", msg.content, anchor);
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
  // 历史里仍挂着「执行中」的卡片：会话并未在跑时说明是中断遗留，标记为已停止
  if (!currentSessionIsRunning()) {
    stopRunningToolCards(chatBody);
  }
  renderedFrom = from;
  updateRoundMoreButton();
  if (scrollToEnd) forceScrollToBottom();
}

/** 渲染一条历史 assistant 消息里的动作（思考段 + 工具卡片），默认收起 */
function renderHistoryActions(node, msg) {
  const acc = ensureThoughtAccordion(node);
  const body = acc.querySelector(".accordion-content");
  if (msg.thinking) {
    const block = document.createElement("div");
    block.className = "thought-text";
    block.dataset.raw = msg.thinking;
    block.textContent = msg.thinking;
    body.appendChild(block);
  }
  for (const call of msg.toolCalls || []) {
    body.appendChild(createToolCard({
      toolCallId: call.id,
      toolName: call.name,
      label: call.label,
      detail: call.detail,
      status: "running",
    }));
  }
  updateAccordionSummaryCount(acc);
  // 历史动作默认收起：点开即可回看思考与每次工具调用
  acc.open = false;
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

  const btn = sessionListEl.querySelector(".pi-new-session-btn");
  const prevLabel = btn ? btn.innerHTML : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "正在新建…";
  }

  try {
    const result = await ms.backend.call("createSession", {
      projectPath: currentProject.path,
      model: currentModelId,
    });
    if (!result?.session) throw new Error("后端未返回新会话");

    currentSessionId = result.session.id;
    chatHeader.textContent = result.session.title || "新对话";
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
  chatBody.querySelectorAll(".message, .pi-error, .tool-call-item").forEach((el) => el.remove());
  turnAgentNode = null;
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
function appendMessage(role, content, before) {
  hideWelcome();
  removeTyping();
  const div = document.createElement("div");
  div.className = "message " + role;
  const bubble = document.createElement("div");
  bubble.className = "message-content";
  if (role === "agent") {
    bubble.innerHTML = md2html(content);
  } else {
    bubble.textContent = content;
  }
  div.appendChild(bubble);
  if (before && before.parentNode === chatBody) {
    chatBody.insertBefore(div, before);
  } else {
    chatBody.appendChild(div);
  }
  if (!before) scrollToBottom();
  return div;
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
  hideWelcome();
  removeTyping();
  const node = currentTurnNode();
  const bubble = node.querySelector(".message-content");
  bubble.dataset.raw = full != null ? full : (bubble.dataset.raw || "") + delta;
  bubble.innerHTML = md2html(bubble.dataset.raw);
  node.dataset.raw = bubble.dataset.raw;
  scrollToBottom();
}

/**
 * 动作折叠区（思考 / 工具调用）。
 *
 * 同一轮里的思考文字与工具卡片统一收纳进 .accordion-content：
 *   - 运行中默认展开（能实时看到在做些什么）；
 *   - 本轮结束后由 settleTurnAccordion() 收起，标题带动作计数，
 *     随时可以点开回看思考与每次工具调用的输入 / 结果。
 */
function ensureThoughtAccordion(node) {
  node = node || currentTurnNode();
  let acc = node.querySelector(".thought-accordion");
  if (!acc) {
    acc = document.createElement("details");
    acc.className = "thought-accordion";
    acc.open = true;
    const summary = document.createElement("summary");
    summary.textContent = "思考过程 / 工具调用";
    acc.appendChild(summary);
    const body = document.createElement("div");
    body.className = "accordion-content";
    acc.appendChild(body);
    node.insertBefore(acc, node.firstChild);
  }
  acc.hidden = false;
  return acc;
}

/** 折叠区标题上的动作计数（思考段数 + 工具卡片数）：收起后也能看出收纳了多少动作 */
function updateAccordionSummaryCount(acc) {
  if (!acc) return;
  const summary = acc.querySelector("summary");
  if (!summary) return;
  const n = acc.querySelectorAll(".accordion-content > .thought-text, .accordion-content > .tool-call-item").length;
  summary.textContent = n > 0 ? "思考过程 / 工具调用 (" + n + ")" : "思考过程 / 工具调用";
}

/**
 * 思考增量：写入当前思考段。
 *
 * 后端 chat:thinking 的 content 是**整轮累计**的思考文本（工具调用后继续累加），
 * 这里要把它切成「按发生顺序排列、互不重复」的段落：
 *   - 末尾还是思考块（上一段仍开放）→ 只追加增长的部分；
 *   - 末尾是工具卡片（说明上一段已结束）→ 新起一段，展示全量里的新增部分。
 */
function appendThinking(params) {
  const full = typeof params?.content === "string" ? params.content : null;
  const delta = params?.delta || "";
  const acc = ensureThoughtAccordion();
  const body = acc.querySelector(".accordion-content");
  const prevFull = acc.dataset.thinkingFull || "";
  const nextFull = full != null ? full : prevFull + delta;
  // 正常情况下全量渐进增长；若后端重置过缓冲（不以旧全量为前缀），退化为「整段重写」
  const grown = nextFull.startsWith(prevFull);
  let block = body.lastElementChild;
  const openBlock = block && block.classList.contains("thought-text") ? block : null;
  if (openBlock && grown) {
    // 当前段仍开放：追加增长部分
    const part = nextFull.slice(prevFull.length);
    openBlock.dataset.raw = (openBlock.dataset.raw || "") + part;
    openBlock.textContent = (openBlock.textContent || "") + part;
  } else {
    block = document.createElement("div");
    block.className = "thought-text";
    block.dataset.raw = grown ? nextFull.slice(prevFull.length) : nextFull;
    block.textContent = block.dataset.raw;
    body.appendChild(block);
  }
  acc.dataset.thinkingFull = nextFull;
  updateAccordionSummaryCount(acc);
  scrollToBottom();
}

/** 工具状态 → 徽标样式与文案 */
function toolBadgeInfo(status) {
  if (status === "running") return { className: "tool-call-status-badge running", text: "执行中…" };
  if (status === "success") return { className: "tool-call-status-badge success", text: "✓ 完成" };
  if (status === "error") return { className: "tool-call-status-badge error", text: "✗ 失败" };
  return { className: "tool-call-status-badge", text: "已停止" };
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

/** 工具状态 → 图标容器类名 */
function toolIconClass(status) {
  if (status === "running") return "tool-call-icon tool-icon-running";
  if (status === "success") return "tool-call-icon tool-icon-success";
  if (status === "error") return "tool-call-icon tool-icon-error";
  return "tool-call-icon";
}

/** 新建工具调用卡片 */
function createToolCard(params) {
  const toolName = params.label || params.toolName || "未知工具";
  const status = params.status || "running";
  const card = document.createElement("div");
  card.className = "tool-call-item" + (status === "running" ? " tool-running" : status === "error" ? " tool-error" : "");
  if (params.toolCallId) card.dataset.toolId = params.toolCallId;
  card.dataset.tool = toolName;
  card.dataset.status = status;

  const header = document.createElement("div");
  header.className = "tool-call-header";
  const icon = document.createElement("div");
  icon.className = toolIconClass(status);
  icon.innerHTML = toolIconSvg(status);
  header.appendChild(icon);
  const nameSpan = document.createElement("span");
  nameSpan.className = "tool-call-name";
  nameSpan.textContent = toolName;
  header.appendChild(nameSpan);
  const badge = document.createElement("span");
  const info = toolBadgeInfo(status);
  badge.className = info.className;
  badge.textContent = info.text;
  header.appendChild(badge);
  card.appendChild(header);

  if (params.detail) {
    const detail = document.createElement("div");
    let detailClass = "tool-call-detail";
    const rawTool = (params.toolName || "").toLowerCase();
    if (rawTool === "bash" || rawTool === "shell" || rawTool === "terminal" || rawTool === "command" || rawTool === "run") {
      detailClass += " cmd-detail";
    } else if (rawTool === "edit" || rawTool === "write" || rawTool === "write_file" || rawTool === "edit_file" || rawTool === "read" || rawTool === "read_file") {
      detailClass += " edit-detail";
    } else if (status === "error") {
      detailClass += " error-detail";
    }
    detail.className = detailClass;
    detail.textContent = params.detail;
    card.appendChild(detail);
  }
  return card;
}

/** 更新工具卡片状态 / 结果（实时事件与历史回填共用） */
function updateToolCard(card, params) {
  if (!card) return;
  const status = params.status || "success";
  card.dataset.status = status;
  card.classList.remove("tool-running", "tool-error");
  if (status === "running") card.classList.add("tool-running");
  if (status === "error") card.classList.add("tool-error");
  const icon = card.querySelector(".tool-call-icon");
  if (icon) {
    icon.className = toolIconClass(status);
    icon.innerHTML = toolIconSvg(status);
  }
  const badge = card.querySelector(".tool-call-status-badge");
  if (badge) {
    const info = toolBadgeInfo(status);
    badge.className = info.className;
    badge.textContent = info.text;
  }
  if (params.result != null && params.result !== "") {
    let resultEl = card.querySelector(".tool-call-result");
    if (!resultEl) {
      resultEl = document.createElement("div");
      resultEl.className = "tool-call-result";
      card.appendChild(resultEl);
    }
    resultEl.textContent = clipText(params.result, 2000);
  }
}

/** 按 toolCallId 查已有卡片（全聊天区查——历史与实时共用同一轮时也能对上） */
function findToolCard(params) {
  const id = params && params.toolCallId;
  if (id) {
    const esc = String(id).replace(/"/g, '\\"');
    return chatBody.querySelector('.tool-call-item[data-tool-id="' + esc + '"]');
  }
  // 无 id 时兜底：本轮最后一张「执行中」卡片
  const acc = turnAgentNode && turnAgentNode.querySelector(".thought-accordion .accordion-content");
  if (!acc) return null;
  const cards = acc.querySelectorAll(".tool-call-item");
  for (let i = cards.length - 1; i >= 0; i--) {
    if (cards[i].dataset.status === "running") return cards[i];
  }
  return null;
}

/** 把节点内仍在「执行中」的工具卡片标记为已停止（用户中止 / 请求被打断） */
function stopRunningToolCards(root) {
  if (!root) return;
  root.querySelectorAll(".tool-call-item.tool-running").forEach((el) => updateToolCard(el, { status: "stopped" }));
}

/** 工具调用 — 渲染为可视化卡片（按 toolCallId 精确配对，避免同名工具串台） */
function appendTool(params) {
  hideWelcome();
  removeTyping();
  const status = params.status || "running";
  const existing = findToolCard(params);
  if (existing) {
    // 运行中的重复通知不覆盖；结束通知更新状态与结果
    if (status !== "running") updateToolCard(existing, { status, result: params.detail });
    scrollToBottom();
    return;
  }
  const acc = ensureThoughtAccordion();
  const body = acc.querySelector(".accordion-content");
  const card = createToolCard(params);
  body.appendChild(card);
  if (status !== "running") updateToolCard(card, { status, result: params.detail });
  updateAccordionSummaryCount(acc);
  scrollToBottom();
}

/** 本轮结束：收起折叠区（动作仍可随时手动展开查看） */
function settleTurnAccordion() {
  if (!turnAgentNode || turnAgentNode.parentNode !== chatBody) return;
  const acc = turnAgentNode.querySelector(".thought-accordion");
  if (!acc) return;
  acc.open = false;
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

// ===================== 后端通知 =====================

function setupNotificationHandlers() {
  if (typeof ms.backend.onNotification !== "function") return;
  if (typeof ms.backend._clearNotifications === "function") {
    try { ms.backend._clearNotifications(); } catch (e) { /* ignore */ }
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
      } else if (isIdle) {
        runningSessions.delete(sid);
        patchSessionFlag(sid, sid === currentSessionId ? null : "unseen");
      }
    }
    // 只在本会话的通知才会动当前视图/按钮
    if (!isCurrentSessionNotification(params)) return;
    if (isRunning) {
      showTyping();
      syncSendButton();
    } else if (isIdle) {
      removeTyping();
      settleTurnAccordion();
      syncSendButton();
    }
  });
  ms.backend.onNotification("chat:aborted", (params) => {
    if (params?.sessionId) {
      runningSessions.delete(params.sessionId);
      patchSessionFlag(params.sessionId, null);
    }
    if (!isCurrentSessionNotification(params)) return;
    removeTyping();
    if (turnAgentNode) turnAgentNode.dataset.sealed = "1";
    stopRunningToolCards(chatBody);
    settleTurnAccordion();
    syncSendButton();
  });
}

// ===================== 发送消息 =====================

async function sendMessage(text) {
  if (!text.trim() || (currentSessionId && runningSessions.has(currentSessionId))) return;
  if (!currentProject) {
    showError("请先添加项目");
    return;
  }

  const messageText = text.trim();
  // 记录本次调用对应的会话：await 期间用户可能切到别的会话，
  // currentSessionId 已变化，收尾/渲染都必须以 thisSessionId 为准
  const thisSessionId = currentSessionId;
  inputEl.value = "";
  autoResizeInput();
  updateSendButtonState();
  appendMessage("user", messageText);
  beginAgentTurn();
  showTyping();
  runningSessions.set(thisSessionId, { projectPath: currentProject.path, sessionId: thisSessionId });
  patchSessionFlag(thisSessionId, "running");
  setSendButtonRunning(true);

  try {
    const result = await ms.backend.call("chat", {
      projectPath: currentProject.path,
      sessionId: thisSessionId,
      message: messageText,
      model: currentModelId,
    });
    // 结果只渲染进「仍正在查看该会话」的视图；已切走则交给 loadSession 转录，
    // 避免把 A 的完成内容写进 B 的聊天区
    if (currentSessionId === thisSessionId) {
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
      settleTurnAccordion();
    }
    void refreshSessionMeta();
  } catch (e) {
    if (currentSessionId === thisSessionId) {
      removeTyping();
      if (turnAgentNode) turnAgentNode.dataset.sealed = "1";
      settleTurnAccordion();
      if (e.message && (e.message.includes("abort") || e.message.includes("cancel"))) {
        // 静默处理
      } else {
        showError(`请求失败: ${e.message || e}`);
      }
    }
  } finally {
    // 只清理本次调用登记的会话，不动其它正在跑的会话的账本
    runningSessions.delete(thisSessionId);
    syncSendButton();
    inputEl.focus();
  }
}

/** 停止当前正在运行的 agent */
async function stopAgent() {
  if (!currentSessionIsRunning()) return;
  const rec = runningSessions.get(currentSessionId);
  sendBtn.disabled = true;
  try {
    await ms.backend.call("abort", {
      projectPath: rec?.projectPath || currentProject?.path || "",
      sessionId: currentSessionId,
    });
  } catch (e) {
    console.warn("[PI] 停止 agent 失败:", e);
  }
  if (turnAgentNode) turnAgentNode.dataset.sealed = "1";
  stopRunningToolCards(chatBody);
  settleTurnAccordion();
  removeTyping();
  if (currentSessionId) runningSessions.delete(currentSessionId);
  patchSessionFlag(currentSessionId, null);
  syncSendButton();
  inputEl.focus();
  void refreshSessionMeta();
}

/** 会话元信息刷新 */
async function refreshSessionMeta({ force = false } = {}) {
  if (!currentProject) return;
  try {
    const listed = await ms.backend.call("listSessions", { projectPath: currentProject.path });
    const next = listed?.sessions || [];
    const changed =
      force ||
      next.length !== sessions.length ||
      next.some((s, i) => s.title !== sessions[i]?.title || s.flag !== sessions[i]?.flag);
    sessions = next;
    // 用后端标记补充「正在运行」的会话（核对账本，避免 remount/轮询后丢失运行态）
    for (const s of sessions) {
      if (s.flag === "running") {
        runningSessions.set(s.id, { projectPath: currentProject.path, sessionId: s.id });
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
      if (cur) chatHeader.textContent = `#${sessions.indexOf(cur) + 1} ${cur.title}`;
    }
  } catch (e) { /* 静默 */ }
}

/** 定期同步会话列表 */
function startSessionPolling() {
  if (sessionPollTimer) clearInterval(sessionPollTimer);
  sessionPollTimer = setInterval(() => {
    // 任一会话在跑就避让轮询——此时内存里的 flag 是「正在运行」的实时态，
    // 轮询反而会用旧数据干扰列表；运行结束后 map 清空、恢复轮询。
    if (document.hidden || runningSessions.size > 0 || !currentProject) return;
    void refreshSessionMeta();
  }, 8000);
}

// ===================== 事件绑定 =====================

function bindEvents() {
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
  modelSelect.addEventListener("change", () => {
    currentModelId = modelSelect.value;
    updateModelDisplay();
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
  $("pi-project-path").addEventListener("keydown", (e) => {
    if (e.key === "Enter") confirmAddProject();
    if (e.key === "Escape") hideAddProjectPopover();
  });
  document.addEventListener("click", (e) => {
    const pop = $("pi-add-popover");
    if (pop && !pop.hidden && !pop.contains(e.target) && e.target.closest?.("#pi-add-project") == null) {
      hideAddProjectPopover();
    }
  });
  $("pi-settings-btn").addEventListener("click", () => {
    hideAddProjectPopover();
    void openSettings();
  });
  if (settingsCloseBtn) settingsCloseBtn.addEventListener("click", closeSettings);
  document.addEventListener("keydown", (e) => {
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

function cleanup() {
  // 保存当前视图状态到后端 config（跨 mount 恢复用）
  if (savedState.projectPath || savedState.sessionId) {
    ms.backend.call('setConfig', { savedState }).catch(() => {});
  }
  if (sessionPollTimer) { clearInterval(sessionPollTimer); sessionPollTimer = null; }
  if (ms.backend._clearNotifications) ms.backend._clearNotifications();
}
if (host.__msPluginCleanup === undefined) {
  host.__msPluginCleanup = cleanup;
}

// ===================== 启动 =====================

init().catch((e) => {
  console.error("[PI] 初始化失败:", e);
});

})(ms, env, plugin, host, keyword, inputValue, onSubKeyword, md2html, openExternal);
