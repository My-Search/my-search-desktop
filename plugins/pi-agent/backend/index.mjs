/**
 * Pi Agent 后端 - JSON-RPC over stdio（基于 pi SDK）
 *
 * 协议：
 *   宿主发 init → 后端回复 {"id":1,"result":{"ok":true}}
 *   宿主发 chat → 后端回复流式通知 chat:delta → 最后回复完整结果
 *   后端可随时发通知: {"jsonrpc":"2.0","method":"chat:delta","params":{...}}
 *   宿主发 deactivate → 后端退出（无回复）
 *
 * 关于模块格式（重要）：
 *   `@earendil-works/pi-coding-agent` 是**纯 ESM 包**（package.json 的 exports
 *   只提供 "import"，没有 require 入口），因此本文件必须是 ESM（.mjs），
 *   用 createRequire 加载可选的 CJS 依赖、用动态 import() 加载 pi。
 *
 * 关于 pi 的定位（重要）：
 *   宿主不负责安装 pi（那会让「点启动」阻塞几十秒甚至几分钟，进而超时被杀、
 *   反复重装）。本后端按顺序**复用本机已有的 pi**：
 *     1) 环境变量 PI_CODING_AGENT_MODULE（显式指定，便于调试）
 *     2) ~/.pi/agent/npm/node_modules/（pi 自管的依赖目录）
 *     3) 全局 npm root（npm i -g @earendil-works/pi-coding-agent）
 *     4) 插件自带 backend/node_modules/（离线自包含安装）
 *   全都找不到时返回 hasPi:false，前端提示用户安装 pi。
 */

import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execSync } from "node:child_process";
import { nameSessionFromFirstMessage } from "./session-title.mjs";
import {
  SUPPORTED_APIS,
  loadModelsFile,
  saveProviderToFile,
  removeProviderFromFile,
  isCustomProvider,
  validateProvider,
  describeProvider,
  describeBuiltinProvider,
} from "./model-config.mjs";

const require = createRequire(import.meta.url);

// ===================== 状态 =====================
let pluginId = "unknown";
let dataDir = "";
let agentDir = "";
let pi = null;          // pi SDK 模块（动态 import 的命名空间）
let piLoadError = "";   // 加载失败原因（用于前端提示）
let modelRuntime = null;
let modelRegistry = null;

/** 会话运行时缓存：key = `${projectPath}::${sessionId}` */
const runtimes = new Map();
/** 当前选中的模型（provider + id），由前端传入 */
let selectedModel = null;

/**
 * 每个项目当前「草稿」会话（新建会话创建、尚未发出首条消息的那个）。
 *
 * pi 只在**首条 assistant 消息到达**时才把会话写进磁盘
 * （SessionManager._persist 里 hasAssistant 为假就只挂内存）。
 * 因此刚点「新建会话」的会话既没有文件、也不在 SessionManager.list 里，
 * 前端刷新列表就会「什么都没发生」。这里记住草稿，listSessions 时补进去。
 */
const drafts = new Map(); // projectPath → rec

/** 「已完成未查看」的已读时间戳：key `${projectPath}::${sessionId}` → ISO 时间 */
let viewedMap = null;

// ===================== 持久化（插件私有数据） =====================

function projectsPath() {
  return path.join(dataDir, "pi-agent-projects.json");
}

function configPath() {
  return path.join(dataDir, "pi-agent-config.json");
}

/** 「已看过」时间戳（用于项目角标：已完成未查看 + 进行中） */
function seenPath() {
  return path.join(dataDir, "pi-agent-seen.json");
}

function loadJson(file, fallback) {
  try {
    if (file && fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    }
  } catch (e) {
    sendLog("warn", `读取 ${file} 失败: ${e.message}`);
  }
  return fallback;
}

function saveJson(file, value) {
  try {
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
    }
  } catch (e) {
    sendLog("error", `写入 ${file} 失败: ${e.message}`);
  }
}

const loadProjects = () => {
  const data = loadJson(projectsPath(), []);
  return Array.isArray(data) ? data : [];
};
const saveProjects = (projects) => saveJson(projectsPath(), projects);
const loadConfig = () => loadJson(configPath(), {});
const saveConfig = (cfg) => saveJson(configPath(), cfg);

/* ---------------- 「已查看」时间戳（项目角标口径） ---------------- */

/**
 * 角标口径：**已完成未查看 + 进行中**的会话数（不是历史总数）。
 *
 * 判定：
 *   - 进行中 = 该会话正在跑（内存里有 runtime 且处于 agent_start…agent_end 之间）
 *   - 未查看 = 会话文件最后修改时间 晚于 用户最后一次打开它的时间
 *
 * 首次启用（还没有 seen 文件）时做一次**基线**：把当前所有已知会话都记为
 * 「已查看」。否则安装插件的那一刻，历史里 120 个会话会全部算成未读，
 * 角标直接爆成 99+——那正是要修掉的噪声。
 */
function seenKey(projectPath, sessionId) {
  return `${projectPath}::${sessionId}`;
}

function loadSeen() {
  if (viewedMap) return viewedMap;
  const raw = loadJson(seenPath(), null);
  viewedMap = new Map(raw && typeof raw === "object" ? Object.entries(raw) : []);
  return viewedMap;
}

function saveSeen() {
  if (!viewedMap) return;
  saveJson(seenPath(), Object.fromEntries(viewedMap));
}

/** 记录「用户看过这个会话了」（打开会话时由前端调用） */
function markViewed(projectPath, sessionId, at = new Date().toISOString()) {
  if (!projectPath || !sessionId) return;
  const seen = loadSeen();
  seen.set(seenKey(projectPath, sessionId), at);
  saveSeen();
}

/**
 * 首次见到某个项目时，把它磁盘上已有会话全部记为「已查看」（基线）。
 *
 * 只做一次，并且**按项目**记录（marker 存在 seen 表里）：否则安装插件那一刻，
 * 历史里上百个会话会全被算成未读，角标直接爆 99+——那正是要修掉的噪声。
 * 用 marker 而不是「seen 文件是否存在」判断，是因为后加的项目同样需要基线。
 */
function ensureSeenBaseline(sessions, projectPath) {
  const seen = loadSeen();
  const marker = `__baseline__::${projectPath}`;
  if (seen.has(marker)) return;
  const now = new Date().toISOString();
  for (const s of sessions || []) {
    const key = seenKey(projectPath, s.id);
    if (seen.has(key)) continue;
    const modified = s.modified instanceof Date ? s.modified.toISOString() : String(s.modified || "");
    seen.set(key, modified || now);
  }
  seen.set(marker, now);
  saveSeen();
}

// ===================== pi SDK 定位与加载 =====================

/** 候选 pi 安装位置（按优先级：越靠前越优先） */
function piModuleCandidates() {
  const list = [];
  // 1) 显式指定（排障用）
  if (process.env.PI_CODING_AGENT_MODULE) {
    list.push(process.env.PI_CODING_AGENT_MODULE);
  }
  // 2) 全局 npm root —— 用户安装 pi 本体的地方，版本通常最新
  const globalRoots = [
    path.join(process.env.APPDATA || "", "npm", "node_modules"),           // Windows
    path.join(os.homedir(), ".npm-global", "lib", "node_modules"),          // Linux/mac
    "/usr/local/lib/node_modules",
    "/usr/lib/node_modules",
  ];
  for (const r of globalRoots) if (r) list.push(r);
  // 3) 插件自带（离线自包含安装时）
  const here = path.dirname(fileURLToPath(import.meta.url));
  list.push(path.join(here, "node_modules"));
  // 4) pi 自管的依赖目录 —— 注意这里往往是被扩展固定的**旧版本**（如 0.79.x），
  //    排最后以免旧 API 覆盖用户主用的新版本
  list.push(path.join(os.homedir(), ".pi", "agent", "npm", "node_modules"));
  return list;
}

/** 解析版本号用于比较（"0.85.1" → [0,85,1]） */
function parseVersion(v) {
  return String(v || "0")
    .split(".")
    .map((x) => parseInt(x, 10) || 0);
}

/** 版本比较：a > b 返回正数 */
function compareVersion(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * 找出最合适的 pi 安装。
 *
 * 不只看「存在」——多个副本时**选版本最高的那个**：用户机器上同时存在
 * pi 自管目录（0.79.x，被扩展钉死）和全局安装（0.85.x，用户主用）时，
 * 旧版的 API 形状不同（没有 ModelRuntime），会导致模型列表读不出来。
 */
function findPiEntry() {
  let best = null;
  for (const base of piModuleCandidates()) {
    if (!base) continue;
    const pkgJson = path.join(base, "@earendil-works", "pi-coding-agent", "package.json");
    if (!fs.existsSync(pkgJson)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(pkgJson, "utf8"));
      const entry = path.join(path.dirname(pkgJson), meta.main || "dist/index.js");
      if (!fs.existsSync(entry)) continue;
      if (!best || compareVersion(meta.version, best.version) > 0) {
        best = { entry, base, version: meta.version };
      }
    } catch (e) { /* 继续找下一个 */ }
  }
  return best;
}

/** 加载 pi SDK（ESM 动态 import，路径形式导入以绕过 exports 解析） */
async function ensurePi() {
  if (pi) return pi;
  if (pi !== null && piLoadError) return null; // 已知失败，不重复尝试

  const found = findPiEntry();
  if (!found) {
    piLoadError =
      "未找到 pi（@earendil-works/pi-coding-agent）。" +
      "请先安装：npm i -g @earendil-works/pi-coding-agent";
    return null;
  }
  try {
    pi = await import(pathToFileURL(found.entry).href);
    sendLog("info", `pi SDK 已加载 v${found.version}（${found.base}）`);
    return pi;
  } catch (e) {
    pi = null;
    piLoadError = `pi SDK 加载失败: ${e.message}`;
    sendLog("error", piLoadError);
    return null;
  }
}

/**
 * 初始化模型注册表（pi 约定：agentDir 默认 ~/.pi/agent）。
 *
 * 兼容两代 API：
 *   - 0.85.x：`ModelRuntime.create({authPath, modelsPath})` → `new ModelRegistry(runtime)`
 *   - 0.79.x：`AuthStorage.create(authPath)` → `ModelRegistry.create(authStorage, modelsPath)`
 */
async function ensureModelRegistry() {
  if (modelRegistry) return modelRegistry;
  const sdk = await ensurePi();
  if (!sdk) return null;
  try {
    agentDir = sdk.getAgentDir ? sdk.getAgentDir() : path.join(os.homedir(), ".pi", "agent");
    const authPath = path.join(agentDir, "auth.json");
    const modelsPath = path.join(agentDir, "models.json");

    if (sdk.ModelRuntime?.create) {
      // 0.85.x
      modelRuntime = await sdk.ModelRuntime.create({
        authPath,
        modelsPath,
        refreshOnCreate: true,
      });
      modelRegistry = new sdk.ModelRegistry(modelRuntime);
    } else if (sdk.ModelRegistry?.create) {
      // 0.79.x
      const authStorage = sdk.AuthStorage?.create?.(authPath);
      modelRegistry = sdk.ModelRegistry.create(authStorage, modelsPath);
    } else {
      throw new Error("该版本的 pi 未提供可识别的 ModelRegistry API");
    }
    if (modelRegistry.refresh) {
      try { await modelRegistry.refresh(); } catch (e) { /* 刷新失败不致命 */ }
    }
    sendLog("info", `模型注册表就绪（agentDir=${agentDir}）`);
  } catch (e) {
    sendLog("warn", `ModelRegistry 初始化失败: ${e.message}`);
    modelRegistry = null;
  }
  return modelRegistry;
}

// ===================== JSON-RPC 通信 =====================

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
const sendNotification = (method, params) => send({ jsonrpc: "2.0", method, params });
const sendLog = (level, message) => sendNotification("log", { level, message });
const sendResult = (id, result) => send({ jsonrpc: "2.0", id, result });
const sendError = (id, message) => send({ jsonrpc: "2.0", id, error: { message } });

// ===================== 模型 =====================

async function handleListModels(id) {
  const registry = await ensureModelRegistry();
  const cfg = loadConfig();
  const models = [];
  if (registry) {
    try {
      const all = registry.getAll();
      const available = new Set(registry.getAvailable().map((m) => `${m.provider}:${m.id}`));
      for (const m of all) {
        models.push({
          provider: m.provider,
          id: m.id,
          name: m.name || m.id,
          reasoning: Boolean(m.reasoning),
          available: available.has(`${m.provider}:${m.id}`),
        });
      }
      sendLog("info", `从 pi 读取到 ${models.length} 个模型（可用 ${available.size} 个）`);
    } catch (e) {
      sendLog("warn", `读取模型失败: ${e.message}`);
    }
  }
  // 默认模型：用户的 settings.json（defaultProvider/defaultModel），否则第一个可用
  let defaultModel = cfg.model || "";
  if (!defaultModel && registry) {
    try {
      const all = registry.getAll();
      const available = new Set(registry.getAvailable().map((m) => `${m.provider}:${m.id}`));
      const first = all.find((m) => available.has(`${m.provider}:${m.id}`)) || all[0];
      if (first) defaultModel = `${first.provider}:${first.id}`;
    } catch (e) { /* ignore */ }
  }
  sendResult(id, {
    models,
    defaultModel,
    hasPi: Boolean(registry),
    piError: piLoadError || undefined,
    agentDir: agentDir || undefined,
  });
}

// ===================== 项目 =====================

/**
 * 列出项目，并附带每个项目的**角标数**（界面左侧图标角标用）。
 *
 * 角标口径 = 已完成未查看 + 进行中的会话数（不是历史会话总数）：
 * 历史总数只增不减，几十个会话就顶到 99+，用户无法从中得到任何信息。
 * 具体判定见 sessionFlag()。
 *
 * 会话数来自 pi 的 SessionManager.list（按 cwd 计算会话目录），
 * 因此这里必须等 pi 就绪；取不到就退化为 0（角标不显示）。
 */
async function handleListProjects(id) {
  const projects = loadProjects();
  const sdk = await ensurePi();
  const out = [];
  for (const p of projects) {
    let badgeCount = 0;
    let sessionCount = 0;
    try {
      if (sdk?.SessionManager?.list) {
        const infos = await sdk.SessionManager.list(p.path);
        sessionCount = (infos || []).length;
        ensureSeenBaseline(infos, p.path);
        badgeCount = (infos || []).filter((s) => sessionFlag(p.path, s) !== null).length;
        // 未落盘的草稿会话也算一条待办（与 listSessions 的口径保持一致）
        const draft = drafts.get(p.path);
        if (draft && !(infos || []).some((s) => s.id === draft.sessionId)) badgeCount += 1;
      }
    } catch (e) { /* 单个项目取不到不影响整体 */ }
    out.push({ ...p, sessionCount, badgeCount });
  }
  sendResult(id, { projects: out });
}

function handleAddProject(id, params) {
  const raw = String(params?.path || "").trim();
  if (!raw) { sendError(id, "项目路径不能为空"); return; }
  const resolved = path.resolve(raw);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    sendError(id, `目录不存在: ${resolved}`);
    return;
  }
  const projects = loadProjects();
  if (projects.some((p) => p.path === resolved)) {
    sendError(id, `项目已存在: ${resolved}`);
    return;
  }
  const project = {
    id: Buffer.from(resolved).toString("base64url").slice(0, 24),
    name: path.basename(resolved),
    path: resolved,
    addedAt: new Date().toISOString(),
    lastOpenedAt: new Date().toISOString(),
  };
  projects.push(project);
  saveProjects(projects);
  sendResult(id, { ok: true, project });
}

function handleRemoveProject(id, params) {
  const target = String(params?.path || "").trim();
  const projects = loadProjects();
  const next = projects.filter((p) => p.path !== target);
  if (next.length === projects.length) { sendError(id, `项目不存在: ${target}`); return; }
  saveProjects(next);
  drafts.delete(target);
  for (const [key, rec] of [...runtimes]) {
    if (rec.projectPath !== target) continue;
    try { rec.unsubscribe?.(); } catch (e) { /* ignore */ }
    try { rec.session?.dispose?.(); } catch (e) { /* ignore */ }
    runtimes.delete(key);
  }
  sendResult(id, { ok: true });
}

function touchProject(projectPath) {
  const projects = loadProjects();
  const p = projects.find((x) => x.path === projectPath);
  if (p) { p.lastOpenedAt = new Date().toISOString(); saveProjects(projects); }
}

// ===================== 会话 =====================

/**
 * 会话是否正在跑（agent_start…agent_end 之间）。
 *
 * 角标的「进行中」以它为准：用户切到别的项目时，原来那个项目里还在跑的会话
 * 依然应该被算进角标，这样用户知道「那边还有活没干完」。
 */
function isRunning(projectPath, sessionId) {
  for (const rec of runtimes.values()) {
    if (rec.projectPath !== projectPath || rec.sessionId !== sessionId) continue;
    return rec.running === true;
  }
  const draft = drafts.get(projectPath);
  return Boolean(draft && draft.sessionId === sessionId && draft.running === true);
}

/**
 * 会话的角标归类。
 *
 * 返回 "running"（进行中）/ "unseen"（已完成未查看）/ null（无需求）。
 * 判定顺序：先看是否在跑；否则比较「文件最后修改」与「最后一次打开」。
 * 尚未开始（pending，未落盘的草稿）由调用方另行累加，不走这里。
 */
function sessionFlag(projectPath, session) {
  const id = session.id;
  if (isRunning(projectPath, id)) return "running";
  const seenAt = loadSeen().get(seenKey(projectPath, id)) || "";
  const modified = session.modified instanceof Date ? session.modified.toISOString() : String(session.modified || "");
  if (!modified) return null;
  if (!seenAt || modified > seenAt) return "unseen";
  return null;
}

/** 未落盘的待创建会话（刚点「新建会话」）→ 列表项形状 */
function pendingToList(rec) {
  return {
    id: rec.id,
    title: rec.title || "新对话",
    updatedAt: rec.createdAt,
    file: "",
    messageCount: 0,
    pending: true,
  };
}

async function handleListSessions(id, params) {
  const projectPath = String(params?.projectPath || "");
  const sdk = await ensurePi();
  if (!sdk?.SessionManager?.list) { sendResult(id, { sessions: [], hasPi: false, piError: piLoadError }); return; }
  try {
    const infos = await sdk.SessionManager.list(projectPath);
    // 首次运行先建基线，避免历史会话一次性全被算成「未查看」
    ensureSeenBaseline(infos, projectPath);

    const sessions = (infos || []).map((s) => ({
      id: s.id,
      title: s.name || s.firstMessage || "会话",
      updatedAt: s.modified ? new Date(s.modified).toISOString() : "",
      file: s.path || "",
      messageCount: s.messageCount ?? 0,
      flag: sessionFlag(projectPath, s),
    }));

    // 尚未落盘的草稿会话补到最前面。
    // 草稿只在「新建后还没成功发出消息」期间存在（发送成功即从 drafts 移除），
    // 所以这里必然是未落盘状态，不会与磁盘里的会话重复。
    const draft = drafts.get(projectPath);
    if (draft && !sessions.some((s) => s.id === draft.sessionId)) {
      sessions.unshift({
        ...pendingToList({ id: draft.sessionId, title: draft.title, createdAt: draft.createdAt }),
        flag: draft.running ? "running" : null,
      });
    }

    // 角标口径 = 已完成未查看 + 进行中（含刚建好、还没发消息的草稿：
    // 那也是一条还没了结的会话，用户回到项目时应该看到它）
    const badgeCount = sessions.filter(
      (s) => s.flag === "running" || s.flag === "unseen" || s.pending
    ).length;
    sendResult(id, { sessions, badgeCount });
  } catch (e) {
    sendLog("warn", `列出会话失败: ${e.message}`);
    sendResult(id, { sessions: [], badgeCount: 0 });
  }
}

/** 解析 "provider:modelId" → pi 的 Model 对象 */
async function resolveModel(modelKey) {
  if (!modelKey) return undefined;
  const registry = await ensureModelRegistry();
  if (!registry) return undefined;
  const idx = modelKey.indexOf(":");
  if (idx <= 0) return undefined;
  const provider = modelKey.slice(0, idx);
  const id = modelKey.slice(idx + 1);
  try {
    return registry.find(provider, id) || undefined;
  } catch (e) {
    return undefined;
  }
}

/**
 * 取（或建）某会话的 AgentSession。
 *
 * 0.85.x 的正确用法是 createAgentSession（内部会装配 ModelRuntime / tools /
 * resourceLoader 等），而不是自己拼参数去碰 ModelRuntime。
 *
 * `sessionId` 为空 = 项目的「草稿会话」：已有草稿就复用，没有才新建。
 * 注意草稿的缓存键是 `项目::会话id`（不是 `项目::new`）——早先用固定的
 * "new" 当键，第二次点「新建会话」会命中缓存把同一个会话原样返回。
 */
async function getOrCreateSession(projectPath, sessionId, modelKey) {
  if (!sessionId) {
    const draft = drafts.get(projectPath);
    if (draft) return draft;
  }
  const key = `${projectPath}::${sessionId}`;
  const existing = runtimes.get(key);
  if (existing) return existing;
  if (sessionId) {
    throw new Error(`会话未加载: ${sessionId}`);
  }
  return await createSessionRuntime(projectPath, modelKey, { asDraft: true });
}

/**
 * 新建一个**全新**的会话 runtime（新 sessionId / 新会话文件）。
 *
 * pi 的 AgentSession 没有「换会话」的公开方法（newSession 只在内部 runtime
 * 上），因此这里用官方文档给出的组合重建：新的 SessionManager +
 * createAgentSession。旧的 runtime 若已落盘就留在 runtimes 里（它没被销毁，
 * 只是前端不再指向它）；若是空草稿就顺手回收，避免草稿越攒越多。
 */
async function createSessionRuntime(projectPath, modelKey, { asDraft = false } = {}) {
  const sdk = await ensurePi();
  if (!sdk) throw new Error(piLoadError || "pi SDK 不可用");

  const prevDraft = drafts.get(projectPath);
  if (prevDraft) {
    // 空草稿（还没发过消息、没落盘）直接回收；发过消息的留在 runtimes 里
    runtimes.delete(`${projectPath}::${prevDraft.sessionId}`);
    try { prevDraft.unsubscribe?.(); } catch (e) { /* ignore */ }
    try { prevDraft.session?.dispose?.(); } catch (e) { /* ignore */ }
    drafts.delete(projectPath);
  }

  const model = await resolveModel(modelKey || selectedModel?.key);
  const sessionManager = sdk.SessionManager.create(projectPath);
  const { session, modelFallbackMessage } = await sdk.createAgentSession({
    cwd: projectPath,
    agentDir: agentDir || undefined,
    sessionManager,
    model,
  });
  if (modelFallbackMessage) sendLog("warn", modelFallbackMessage);

  const rec = {
    key: `${projectPath}::${session.sessionId}`,
    projectPath,
    session,
    sessionId: session.sessionId,
    running: false,
    unsubscribe: null,
  };
  rec.unsubscribe = session.subscribe((event) => {
    try { handleAgentEvent(rec, event); } catch (e) { sendLog("warn", `事件处理异常: ${e.message}`); }
  });
  runtimes.set(rec.key, rec);
  if (asDraft) drafts.set(projectPath, rec);
  sendLog("info", `会话已创建 sessionId=${rec.sessionId} cwd=${projectPath}`);
  return rec;
}

/** 打开已有会话（从磁盘 JSONL 恢复） */
async function openSession(projectPath, sessionFile, modelKey) {
  const sdk = await ensurePi();
  if (!sdk) throw new Error(piLoadError || "pi SDK 不可用");
  const key = `${projectPath}::${sessionFile}`;
  const existing = runtimes.get(key);
  if (existing) return existing;

  const model = await resolveModel(modelKey || selectedModel?.key);
  const sessionManager = sdk.SessionManager.open(sessionFile);
  const { session, modelFallbackMessage } = await sdk.createAgentSession({
    cwd: projectPath,
    agentDir: agentDir || undefined,
    sessionManager,
    model,
  });
  if (modelFallbackMessage) sendLog("warn", modelFallbackMessage);
  const rec = {
    key,
    projectPath,
    session,
    sessionId: session.sessionId,
    running: false,
    unsubscribe: null,
  };
  rec.unsubscribe = session.subscribe((event) => {
    try { handleAgentEvent(rec, event); } catch (e) { sendLog("warn", `事件处理异常: ${e.message}`); }
  });
  runtimes.set(key, rec);
  return rec;
}

/** 会话是否存在（找内存里的记录） */
function findRuntimeBySessionId(projectPath, sessionId) {
  for (const rec of runtimes.values()) {
    if (rec.projectPath === projectPath && rec.sessionId === sessionId) return rec;
  }
  return null;
}

/** 按 id 找会话文件（用于打开历史会话） */
async function findSessionFile(projectPath, sessionId) {
  const sdk = await ensurePi();
  if (!sdk?.SessionManager?.list) return null;
  const infos = await sdk.SessionManager.list(projectPath);
  const hit = (infos || []).find((s) => s.id === sessionId);
  return hit?.path || null;
}

/**
 * pi agent 事件 → 插件通知（对齐 0.85.x 的事件形状）
 *
 * - message_update + assistantMessageEvent.type==="text_delta" → chat:delta
 * - tool_execution_start / tool_execution_end → chat:tool
 * - agent_start / agent_end → chat:status
 *
 * 重要：delta 通知同时带上 `content`（本轮**累积全文**）。
 * 视图脚本重新挂载时可能残留旧的监听器（宿主按 Set 存 handler，旧闭包无法
 * 被自动回收），若只发增量就会被重复累加，表现为「每个字都重复 N 遍」。
 * 带上累积全文后，前端直接覆盖写入即可，天然幂等。
 */

/** 工具名 → 可读显示名 */
function toolDisplayName(name) {
  if (!name) return "工具";
  const map = {
    "read": "📖 读取文件",
    "read_file": "📖 读取文件",
    "write": "✏️ 写入文件",
    "write_file": "✏️ 写入文件",
    "edit": "🔧 编辑文件",
    "edit_file": "🔧 编辑文件",
    "bash": "💻 执行命令",
    "shell": "💻 执行命令",
    "terminal": "💻 执行命令",
    "command": "💻 执行命令",
    "run": "▶️ 运行",
    "search": "🔍 搜索",
    "grep": "🔍 搜索",
    "find": "🔍 搜索文件",
    "web_search": "🌐 搜索网页",
    "web_fetch": "🌐 获取网页",
    "fetch": "🌐 获取内容",
    "ask_user": "💬 询问用户",
    "ask": "💬 询问",
    "subagent": "🤖 调用子 Agent",
    "sub_agent": "🤖 调用子 Agent",
    "start_sub_agent": "🤖 调用子 Agent",
    "plan": "📋 制定计划",
    "thinking": "🧠 思考中",
    "think": "🧠 思考",
    "reasoning": "🧠 推理",
    "list_dir": "📂 列出目录",
    "ls": "📂 列出目录",
    "glob": "🔍 搜索文件",
    "move": "📦 移动文件",
    "copy": "📦 复制文件",
    "delete": "🗑️ 删除",
    "rename": "✏️ 重命名",
    "mkdir": "📁 创建目录",
    "create_directory": "📁 创建目录",
    "file_system": "📁 文件操作",
    "diff": "📊 查看差异",
    "tool_error": "⚠️ 工具错误",
  };
  return map[name.toLowerCase()] || `🛠️ ${name}`;
}
/**
 * 从工具调用参数生成可读摘要（工具卡片上展示的「输入」）。
 * 事件推送（tool_execution_start）与历史提取（transcript）共用同一套文案。
 */
function describeToolCallArguments(args) {
  const a = args || {};
  let detail = "";
  // 命令执行：显示命令本身
  if (a.command) {
    detail = String(a.command);
    if (detail.length > 120) detail = detail.slice(0, 120) + "…";
  }
  // 编辑/写入文件：显示文件路径 + 处理策略（追加/替换等）
  else if (a.file_path || a.filePath) {
    const fp = a.file_path || a.filePath;
    if (a.old_str) {
      detail = `📄 ${fp}\n替换: ${String(a.old_str).slice(0, 60)} → ${String(a.new_str || "").slice(0, 60)}`;
    } else if (a.insert) {
      detail = `📄 ${fp}\n插入: ${String(a.insert).slice(0, 80)}`;
    } else if (a.content) {
      detail = `📄 ${fp}\n${String(a.content).slice(0, 80)}`;
    } else {
      detail = `📄 ${fp}`;
    }
  }
  // 读取/删除/移动文件等：至少显示路径
  else if (a.path) {
    detail = String(a.path);
  }
  else if (a.url) detail = `🔗 ${a.url}`;
  else if (a.query) detail = `🔍 ${String(a.query).slice(0, 100)}`;
  else if (a.pattern) detail = `🔍 ${a.pattern}`;
  else if (a.directory || a.dir) detail = `📂 ${a.directory || a.dir}`;
  else if (a.text) detail = String(a.text).slice(0, 80);
  // fallback: 把 args 序列化成可读格式
  else if (typeof a === "object" && Object.keys(a).length > 0) {
    const entries = Object.entries(a).slice(0, 3);
    detail = entries.map(([k, v]) => `${k}=${String(v).slice(0, 40)}`).join(", ");
  }
  return detail;
}

/**
 * 从 tool_execution_end 事件生成可读结果（工具卡片展开后展示）。
 *
 * pi 的工具结果形状是 { content: [{type:"text", text}], details }；
 * 失败时 isError=true，正文通常就是错误信息。统一在这里抽文本并截断，
 * 保证前端「展开动作」时能看到每次调用的输出 / 报错。
 */
function describeToolResult(event) {
  const result = event?.result;
  let text = "";
  if (result && typeof result === "object") {
    if (Array.isArray(result.content)) {
      text = result.content.filter((c) => c?.type === "text").map((c) => c.text || "").join("\n");
    } else if (typeof result.content === "string") {
      text = result.content;
    }
    if (!text) text = String(result.output || result.stdout || result.error || "");
    // 兼容旧形状：带退出码的命令结果
    const exitCode = result.exitCode ?? result.exit_code;
    if (exitCode != null && exitCode !== 0 && !text) text = "退出码 " + exitCode;
  } else if (typeof result === "string") {
    text = result;
  }
  if (!text && event?.error) text = String(event.error);
  text = text.trim();
  if (!text && event?.isError) text = "工具执行失败";
  if (text.length > 1500) text = text.slice(0, 1500) + "…";
  return text || undefined;
}

function handleAgentEvent(rec, event) {
  if (!event || typeof event !== "object") return;
  switch (event.type) {
    case "message_update": {
      const ev = event.assistantMessageEvent;
      if (ev?.type === "text_delta" && ev.delta) {
        rec.streamText = (rec.streamText || "") + ev.delta;
        sendNotification("chat:delta", {
          sessionId: rec.sessionId,
          delta: ev.delta,
          content: rec.streamText,
        });
      } else if (ev?.type === "thinking_delta" && ev.delta) {
        rec.streamThinking = (rec.streamThinking || "") + ev.delta;
        sendNotification("chat:thinking", {
          sessionId: rec.sessionId,
          delta: ev.delta,
          content: rec.streamThinking,
        });
      }
      break;
    }
    case "tool_execution_start":
      // 提取工具的详细动作信息（toolCallId 供前端按调用配对，避免同名工具串台）
      sendNotification("chat:tool", {
        sessionId: rec.sessionId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        status: "running",
        label: toolDisplayName(event.toolName),
        detail: describeToolCallArguments(event.args || event.arguments || {}),
      });
      break;
    case "tool_execution_end":
      // 完成时：把可读结果带回（工具卡片展开后能看到输出 / 报错）
      sendNotification("chat:tool", {
        sessionId: rec.sessionId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        status: event.isError ? "error" : "success",
        label: toolDisplayName(event.toolName),
        detail: describeToolResult(event),
      });
      break;
    case "agent_start":
      // 新一轮开始：清空累积缓冲，标记「进行中」（项目角标要用）
      rec.streamText = "";
      rec.streamThinking = "";
      rec.running = true;
      sendNotification("chat:status", { sessionId: rec.sessionId, status: "running" });
      break;
    case "agent_end":
      rec.running = false;
      sendNotification("chat:status", { sessionId: rec.sessionId, status: "idle" });
      break;
    default:
      break;
  }
}

// ===================== 会话操作 =====================

/**
 * 新建会话。
 *
 * **每次都必须是新的**：早先直接走 getOrCreateSession(projectPath, null)，
 * 而它的缓存键是 `${projectPath}::new`，第二次点击会命中缓存、把同一个
 * AgentSession 原样返回（两次返回同一个 id），用户看到的就是「新建会话没反应」。
 *
 * 现在改为每次重建 runtime（见 createSessionRuntime），id 与文件都是新的。
 */
async function handleCreateSession(id, params) {
  const projectPath = String(params?.projectPath || "");
  if (!projectPath) { sendError(id, "projectPath 不能为空"); return; }
  touchProject(projectPath);
  try {
    const sdk = await ensurePi();
    if (!sdk) throw new Error(piLoadError || "pi SDK 不可用");

    // ★ 每次都重建一个**全新**的会话 runtime（新 sessionId / 新会话文件）
    const rec = await createSessionRuntime(projectPath, params?.model, { asDraft: true });
    const customTitle = String(params?.title || "").trim();
    const title = customTitle || "新对话";
    rec.title = title;
    if (customTitle) rec.session.setSessionName(customTitle);

    // 记住草稿：pi 要等首条 assistant 消息才落盘，列表得能先看到它
    rec.createdAt = rec.createdAt || new Date().toISOString();

    sendLog("info", `新建会话 sessionId=${rec.sessionId}`);
    sendResult(id, {
      ok: true,
      session: {
        id: rec.sessionId,
        title,
        projectPath,
        file: rec.session.sessionFile || "",
        // 还没落盘：pi 要等首条 assistant 消息才写文件
        pending: !isPersisted(rec),
      },
    });
  } catch (e) {
    sendLog("error", `创建会话失败: ${e.message}`);
    sendError(id, `创建会话失败: ${e.message}`);
  }
}

/** 会话是否真的落到磁盘了（pi 在有 assistant 消息前不写文件） */
function isPersisted(rec) {
  const file = rec?.session?.sessionFile;
  try {
    return Boolean(file && fs.existsSync(file));
  } catch (e) {
    return false;
  }
}

/**
 * 把 pi 的上下文消息（buildSessionContext().messages / session.messages）转成前端可渲染的
 * transcript 条目列表。
 *
 * 关键点：**不只提取文本**。历史里的顺序产物要完整带出，聊天区才能「展开查看动作」：
 *   - assistant.content[].thinking   → { role:"assistant", content:文本, thinking:"..." }
 *   - assistant.content[].toolCall   → { role:"assistant", content:文本, toolCalls:[...] }
 *   - role==="toolResult" 的消息     → { role:"toolResult", toolCallId, toolName, isError, content }
 * 文本与动作挂在同一条 assistant 条目上，前端渲染时会把它们放回同一个气泡（含折叠区）。
 */
function buildTranscriptFromMessages(messages) {
  const out = [];
  try {
    const pushAssistant = (text, thinking, toolCalls) => {
      if (!text && !thinking && !toolCalls.length) return;
      const entry = { role: "assistant", content: text || "" };
      if (thinking) entry.thinking = thinking;
      if (toolCalls.length) entry.toolCalls = toolCalls;
      out.push(entry);
    };

    for (const m of messages || []) {
      const role = m?.role;
      const content = m?.content;
      if (role === "user") {
        const text = typeof content === "string" ? content
          : Array.isArray(content) ? content.filter((c) => c?.type === "text").map((c) => c.text || "").join("\n") : "";
        if (text) out.push({ role: "user", content: text });
        continue;
      }
      if (role === "toolResult") {
        const text = typeof content === "string" ? content
          : Array.isArray(content) ? content.filter((c) => c?.type === "text").map((c) => c.text || "").join("\n") : "";
        out.push({
          role: "toolResult",
          toolCallId: m.toolCallId || "",
          toolName: m.toolName || "",
          isError: Boolean(m.isError),
          content: text,
        });
        continue;
      }
      if (role === "assistant") {
        let text = "";
        let thinking = "";
        const toolCalls = [];
        if (typeof content === "string") text = content;
        else if (Array.isArray(content)) {
          for (const c of content) {
            if (c?.type === "text") text += (text ? "\n" : "") + (c.text || "");
            else if (c?.type === "thinking" && c.thinking) thinking += (thinking ? "\n" : "") + c.thinking;
            else if (c?.type === "toolCall") {
              toolCalls.push({
                id: c.id || "",
                name: c.name || "",
                label: toolDisplayName(c.name),
                detail: describeToolCallArguments(c.arguments || {}),
              });
            }
          }
        }
        // 带思考但不带任何工具调用、也没有正文的中间态（如仅思考的回复）也需要保留
        pushAssistant(text, thinking, toolCalls);
        continue;
      }
      // system / 其它角色：忽略
    }
  } catch (e) { /* ignore */ }
  return out;
}

/** 从内存 runtime 抽取转录（草稿会话未落盘时用，与磁盘读取共用同一转换） */
function readMessagesOfRuntime(rec) {
  try {
    return buildTranscriptFromMessages(rec?.session?.messages || []);
  } catch (e) {
    return [];
  }
}

/** 读取会话历史（从 pi 的 JSONL） */
async function handleLoadSession(id, params) {
  const projectPath = String(params?.projectPath || "");
  const sessionId = String(params?.sessionId || "");
  const sdk = await ensurePi();
  if (!sdk?.SessionManager) { sendResult(id, { transcript: [] }); return; }

  // 草稿会话（还没发过消息、pi 尚未落盘）：直接从内存 runtime 取，空历史
  const draft = drafts.get(projectPath);
  if (draft && draft.sessionId === sessionId) {
    sendResult(id, { transcript: readMessagesOfRuntime(draft) });
    return;
  }

  try {
    const file = (await findSessionFile(projectPath, sessionId)) || sessionId;
    if (!file || !fs.existsSync(file)) { sendResult(id, { transcript: [] }); return; }
    const manager = sdk.SessionManager.open(file);
    const context = manager.buildSessionContext();
    // 完整转录：文本 + 思考 + 工具调用 + 工具结果（前端据此渲染可展开的动作区）
    const transcript = buildTranscriptFromMessages(context?.messages || []);
    sendResult(id, { transcript });
  } catch (e) {
    sendLog("warn", `读取会话失败: ${e.message}`);
    sendResult(id, { transcript: [] });
  }
}

// ===================== 对话 =====================

/**
 * 发消息给 pi agent。
 *
 * 流式 delta 由 subscribe 的 chat:delta 通知推送；prompt() 的 Promise 在
 * **整轮 agent 结束（含工具调用）后** resolve，此时把最终文本作为 result 返回。
 */
async function handleChat(id, params) {
  const projectPath = String(params?.projectPath || "");
  const sessionId = params?.sessionId || null;
  const message = String(params?.message || "").trim();
  const modelKey = params?.model || null;
  if (!message) { sendError(id, "消息不能为空"); return; }
  if (!projectPath) { sendError(id, "projectPath 不能为空"); return; }

  if (modelKey) selectedModel = { key: modelKey };

  let rec = sessionId ? findRuntimeBySessionId(projectPath, sessionId) : null;
  // 草稿会话（新建但还没落盘）也在这里：findRuntimeBySessionId 查 runtimes，
  // 而草稿的 key 是 `项目::会话id`，能查到；查不到再按文件打开。
  try {
    if (!rec) {
      if (sessionId) {
        const file = await findSessionFile(projectPath, sessionId);
        if (!file) throw new Error(`找不到会话文件: ${sessionId}`);
        rec = await openSession(projectPath, file, modelKey);
      } else {
        rec = await getOrCreateSession(projectPath, null, modelKey);
      }
    }
  } catch (e) {
    sendError(id, e.message);
    return;
  }

  const session = rec.session;
  if (!session?.prompt) { sendError(id, "agent 会话不可用"); return; }

  try {
    nameSessionFromFirstMessage(rec, message);
    await session.prompt(message, { source: "interactive" });
  } catch (e) {
    sendError(id, `发送失败: ${e.message}`);
    return;
  }

  // 发送成功：消息已落盘，草稿身份结束（列表改为从磁盘读）。
  // 放在 prompt 成功之后：发送失败时草稿要留着，用户还能接着试。
  if (drafts.get(projectPath) === rec) drafts.delete(projectPath);

  // 取最后一条 assistant 文本作为完整回复
  let fullContent = "";
  try {
    const messages = session.messages || [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role !== "assistant") continue;
      const content = m.content;
      if (typeof content === "string") fullContent = content;
      else if (Array.isArray(content)) {
        fullContent = content.filter((c) => c?.type === "text").map((c) => c.text || "").join("\n");
      }
      if (m.errorMessage) { sendError(id, m.errorMessage); return; }
      break;
    }
  } catch (e) { /* ignore */ }

  sendResult(id, { content: fullContent, sessionId: rec.sessionId });
}

// ===================== 配置 =====================

function handleSetConfig(id, params) {
  const cfg = loadConfig();
  if (params) Object.assign(cfg, params);
  saveConfig(cfg);
  if (params?.model) selectedModel = { key: String(params.model) };
  sendResult(id, { ok: true });
}

const handleGetConfig = (id) => sendResult(id, { config: loadConfig() });

// ===================== 模型配置（读写 pi 自己的 models.json） =====================

/**
 * 设置面板用：列出「自定义提供商」（models.json 里的，可编辑）+「内置提供商」
 * （pi 自带目录的，只读）。
 *
 * 内置的也要列出来，否则用户会以为 pi 只有自己加的那几个提供商；
 * 但内置的密钥由 pi 的 /login 管理（auth.json），插件不去碰。
 */
async function handleListProviders(id) {
  const registry = await ensureModelRegistry();
  if (!registry) {
    sendError(id, piLoadError || "pi 未就绪，无法读取模型配置");
    return;
  }
  if (!agentDir) {
    // ensureModelRegistry 没走到（极端情况）：按 pi 的约定兜底
    agentDir = path.join(os.homedir(), ".pi", "agent");
  }
  const modelsPath = path.join(agentDir, "models.json");

  const availability = new Set();
  const builtinModels = new Map();   // providerId → [model...]
  let allModels = [];
  try {
    allModels = registry.getAll();
    for (const m of registry.getAvailable()) availability.add(`${m.provider}:${m.id}`);
  } catch (e) {
    sendLog("warn", `读取模型快照失败: ${e.message}`);
  }
  for (const m of allModels) {
    if (!builtinModels.has(m.provider)) builtinModels.set(m.provider, []);
    builtinModels.get(m.provider).push(m);
  }

  const { data, exists, error } = loadModelsFile(modelsPath);

  const custom = Object.entries(data.providers).map(([pid, raw]) => {
    let auth = null;
    try { auth = registry.getProviderAuthStatus?.(pid); } catch (e) { /* ignore */ }
    return describeProvider(pid, raw, { availability, auth });
  });

  const customIds = new Set(custom.map((p) => p.id));
  const builtin = [];
  for (const [pid, models] of builtinModels) {
    if (customIds.has(pid)) continue;   // 自定义里已经列过（它可能覆盖了同名内置提供商）
    let auth = null;
    try { auth = registry.getProviderAuthStatus?.(pid); } catch (e) { /* ignore */ }
    let displayName = pid;
    try { displayName = registry.getProviderDisplayName?.(pid) || pid; } catch (e) { /* ignore */ }
    builtin.push(describeBuiltinProvider(pid, { name: displayName, models, availability, auth }));
  }
  builtin.sort((a, b) => b.availableCount - a.availableCount || a.id.localeCompare(b.id));

  sendResult(id, {
    custom,
    builtin,
    agentDir,
    modelsPath,
    fileExists: exists,
    fileError: error || undefined,
    supportedApis: SUPPORTED_APIS,
  });
}

/** 保存（新增或覆盖）一个提供商，并让 pi 立即重新加载 models.json */
async function handleSaveProvider(id, params) {
  const registry = await ensureModelRegistry();
  if (!registry) {
    sendError(id, piLoadError || "pi 未就绪，无法保存模型配置");
    return;
  }
  const modelsPath = path.join(agentDir || path.join(os.homedir(), ".pi", "agent"), "models.json");
  try {
    const { id: pid, provider } = validateProvider(params?.id, params?.provider);
    // 面板不回显既有密钥，所以「留空 = 不改动」要在写盘前把它补回来，
    // 否则用户改个 Base URL 就会把 apiKey 抹掉。
    if (params?.keepApiKey && provider.apiKey === undefined) {
      const { data } = loadModelsFile(modelsPath);
      const previous = data.providers?.[pid];
      if (previous && previous.apiKey !== undefined) provider.apiKey = previous.apiKey;
    }
    const { backupPath } = saveProviderToFile(modelsPath, pid, provider);
    // 只重组这一个提供商，且不联网（不因设置面板的一次保存去拉远端目录）
    try {
      await registry.refresh?.({ providers: [pid], allowNetwork: false });
    } catch (e) {
      sendLog("warn", `保存后刷新模型失败（文件已写入）: ${e.message}`);
    }
    sendLog("info", `模型配置已保存: ${pid}（${provider.models.length} 个模型）`);
    sendResult(id, { ok: true, id: pid, modelsPath, backupPath: backupPath || undefined });
  } catch (e) {
    sendError(id, e.message || String(e));
  }
}

/** 删除一个自定义提供商（内置的删不了） */
async function handleDeleteProvider(id, params) {
  const registry = await ensureModelRegistry();
  if (!registry) {
    sendError(id, piLoadError || "pi 未就绪，无法删除模型配置");
    return;
  }
  const modelsPath = path.join(agentDir || path.join(os.homedir(), ".pi", "agent"), "models.json");
  const pid = String(params?.id || "").trim();
  if (!pid) {
    sendError(id, "缺少提供商 ID");
    return;
  }
  try {
    if (!isCustomProvider(modelsPath, pid)) {
      sendError(id, `models.json 里没有提供商「${pid}」，内置提供商不可删除`);
      return;
    }
    const { backupPath } = removeProviderFromFile(modelsPath, pid);
    try {
      await registry.refresh?.({ providers: [pid], allowNetwork: false });
    } catch (e) {
      sendLog("warn", `删除后刷新模型失败（文件已写入）: ${e.message}`);
    }
    sendLog("info", `模型配置已删除: ${pid}`);
    sendResult(id, { ok: true, id: pid, backupPath: backupPath || undefined });
  } catch (e) {
    sendError(id, e.message || String(e));
  }
}

/**
 * 标记会话「已查看」（前端打开会话时调用）。
 *
 * 项目角标口径 = 已完成未查看 + 进行中，所以用户点开一个会话就要把它
 * 从「未查看」里清掉，否则角标永远不消。
 */
function handleMarkViewed(id, params) {
	  markViewed(String(params?.projectPath || ""), String(params?.sessionId || ""));
	  sendResult(id, { ok: true });
	}

// ===================== Pi 自动安装 =====================

  /**
   * 自动安装 pi（@earendil-works/pi-coding-agent）。
   *
   * 策略：
   *   1. 先看本机有没有 npm（`npm --version`）；
   *   2. 有就 `npm i -g @earendil-works/pi-coding-agent`；
   *   3. 如果 npm 没有但发现 pnpm/yarn，也可以用它们装；
   *   4. 安装完后重新加载 pi SDK。
   *
   * 输出会通过 stderr 逐行推给前端（每行一个 JSON log），
   * 前端借此展示进度（但后端代码保持简单，不做流式进度框）。
   */
  async function handleInstallPi(id) {
    // 先检查是否已安装（重复点击防护）
    if (pi) {
      sendResult(id, { ok: true, message: "pi 已安装" });
      return;
    }

    // 找可用的包管理器
    const managers = [
      { cmd: "npm", label: "npm" },
      { cmd: "pnpm", label: "pnpm" },
      { cmd: "yarn", label: "yarn" },
    ];
    let chosen = null;
    for (const m of managers) {
      try {
        execSync(`${m.cmd} --version`, { stdio: "ignore", timeout: 5000 });
        chosen = m;
        break;
      } catch (e) { /* 不可用，继续找下一个 */ }
    }
    if (!chosen) {
      sendError(id, "未找到 npm/pnpm/yarn，请先安装 Node.js（https://nodejs.org）后再安装 pi");
      return;
    }

    sendLog("info", `使用 ${chosen.label} 安装 @earendil-works/pi-coding-agent…`);

    try {
      execSync(`${chosen.cmd} install -g @earendil-works/pi-coding-agent`, {
        stdio: "pipe",
        timeout: 120000,  // 2 分钟超时
        windowsHide: true,
      });
      sendLog("info", "pi 安装成功，正在重新加载…");

      // 安装完成后重置 pi 状态以重新加载
      pi = null;
      piLoadError = "";
      modelRegistry = null;
      modelRuntime = null;

      // 尝试重新加载 pi SDK
      const sdk = await ensurePi();
      if (sdk) {
        await ensureModelRegistry();
        sendResult(id, { ok: true, hasPi: true, message: "pi 安装并加载成功" });
      } else {
        sendResult(id, { ok: true, hasPi: false, piError: piLoadError || "安装完成但加载失败，请尝试重启应用" });
      }
    } catch (e) {
      const stderr = e.stderr?.toString() || e.message || "未知错误";
      // 裁剪过长输出
      const trimmed = stderr.length > 500 ? stderr.slice(0, 500) + "\n…（输出已截断）" : stderr;
      sendLog("error", `pi 安装失败: ${trimmed}`);
sendError(id, `pi 安装失败：\n${trimmed}`);
    }
  }

// ===================== 方法派发 =====================

async function handleRequest(id, method, params) {
  switch (method) {
    case "init":
      pluginId = params?.pluginId || pluginId;
      dataDir = params?.dataDir || dataDir;
      await ensureModelRegistry();
      sendLog("info", `初始化完成 (${pluginId}) agentDir=${agentDir || "(未加载)"}`);
      sendResult(id, { ok: true, hasPi: Boolean(modelRegistry), piError: piLoadError || undefined });
      break;

    case "listModels": await handleListModels(id); break;
    case "listProjects": await handleListProjects(id); break;
    case "addProject": handleAddProject(id, params); break;
    case "removeProject": handleRemoveProject(id, params); break;
    case "listSessions": await handleListSessions(id, params); break;
    case "createSession": await handleCreateSession(id, params); break;
    case "loadSession": await handleLoadSession(id, params); break;
    case "chat": await handleChat(id, params); break;
    case "setConfig": handleSetConfig(id, params); break;
    case "getConfig": handleGetConfig(id); break;
    case "listProviders": await handleListProviders(id); break;
    case "saveProvider": await handleSaveProvider(id, params); break;
    case "deleteProvider": await handleDeleteProvider(id, params); break;
case "markViewed": handleMarkViewed(id, params); break;
    case "installPi": await handleInstallPi(id); break;

    case "abort":
      // 支持指定会话停止（前端传 sessionId+projectPath）
      // 无参数时停掉所有运行中会话（兼容旧行为）
      const targetProjectPath = params?.projectPath || null;
      const targetSessionId = params?.sessionId || null;
      let abortedCount = 0;
      for (const rec of runtimes.values()) {
        if (targetProjectPath && rec.projectPath !== targetProjectPath) continue;
        if (targetSessionId && rec.sessionId !== targetSessionId) continue;
        try {
          rec.running = false;
          await rec.session?.abort?.();
          abortedCount++;
          sendNotification("chat:aborted", {
            sessionId: rec.sessionId,
            projectPath: rec.projectPath,
          });
          sendLog("info", `会话已停止: ${rec.sessionId}`);
        } catch (e) { /* ignore */ }
      }
      sendResult(id, { ok: true, aborted: abortedCount });
      break;

    case "deactivate":
      sendLog("info", "收到 deactivate 通知");
      break;

    default:
      sendLog("warn", `未知方法: ${method}`);
      sendError(id, `未知方法: ${method}`);
  }
}

// ===================== 主循环 =====================

const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); }
  catch (e) { sendLog("error", `JSON 解析失败: ${trimmed.slice(0, 100)}`); return; }

  const { method, id, params } = msg;
  if (id != null) {
    handleRequest(id, method, params).catch((e) => {
      sendLog("error", `未捕获异常: ${e.message}`);
      sendError(id, `内部错误: ${e.message}`);
    });
  } else if (method === "deactivate") {
    for (const rec of runtimes.values()) {
      try { rec.unsubscribe?.(); } catch (e) { /* ignore */ }
      try { rec.session?.dispose?.(); } catch (e) { /* ignore */ }
    }
    runtimes.clear();
    sendLog("info", "正在退出...");
    setTimeout(() => process.exit(0), 100);
  }
});

process.stderr.write("[pi-agent-backend] 后端已启动，等待初始化...\n");
