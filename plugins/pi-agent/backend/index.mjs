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
import { spawn } from "node:child_process";
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

/**
 * 「已完成未查看」的已读标记：key `${projectPath}::${sessionId}` →
 *   { at: ISO 时间, msg: 标记时的消息条数 }
 * 新格式同时记录**消息条数**：会话正在跑/被追加时文件时间戳一直变，只靠时间戳
 * 判定会导致「当前打开、还在写的会话」永远算未读，且右键「全部已读」几秒后又被
 * 重新标成未读。改为「消息条数是否比上次标记时更多」就不再受时间抖动影响。
 * 兼容旧格式（纯 ISO 字符串）：没有 msg 时退回时间戳比较。
 */
let viewedMap = null;

/**
 * 当前前端正在打开的会话（内存态，不落盘）。
 * 「正在你眼前」的会话不该算未读——即使它在跑、消息条数还在涨。
 * 切换会话/项目时前端会改写它；插件进程重启后为空。
 */
let activeView = null; // { projectPath, sessionId }

/**
 * 已被「全部标为已读」消掉的草稿（key `${projectPath}::${sessionId}`）。
 * 草稿没有磁盘文件、也没有消息条数水位，所以单独用一个集合记「这条草稿用户
 * 已经处理过了」，不再算进角标；草稿被新草稿取代/落盘后自动作废。
 */
const readDrafts = new Set();

/** 草稿是否仍算「待办」（未读） */
function draftIsPending(projectPath, rec) {
  if (!rec) return false;
  // 正在眼前打开的草稿不算待办（同 sessionFlag 的 activeView 逻辑）
  if (activeView && activeView.projectPath === projectPath && activeView.sessionId === rec.sessionId) {
    return false;
  }
  return !readDrafts.has(`${projectPath}::${rec.sessionId}`);
}

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

/** 规范化 one 条 seen 记录：新格式 {at,msg} 原样返回；旧格式（字符串）补成对象。 */
function normSeen(v) {
  if (v == null) return null;
  if (typeof v === "string") return { at: v, msg: null };
  if (typeof v === "object") {
    return { at: String(v.at || ""), msg: Number.isFinite(v.msg) ? v.msg : null };
  }
  return null;
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

/** 写一条「已查看」：msg 为标记时的消息条数（拿不到就只记时间戳）。 */
function setSeen(projectPath, sessionId, { at, msg } = {}) {
  if (!projectPath || !sessionId) return;
  const seen = loadSeen();
  const prev = normSeen(seen.get(seenKey(projectPath, sessionId)));
  const nextMsg = Number.isFinite(msg) ? msg : (prev ? prev.msg : null);
  // 消息条数只增不减：不要让一次旧的标记把已读水位降回去
  const keepMsg = prev && prev.msg != null && (nextMsg == null || prev.msg > nextMsg) ? prev.msg : nextMsg;
  seen.set(seenKey(projectPath, sessionId), {
    at: at || new Date().toISOString(),
    msg: keepMsg,
  });
  saveSeen();
}

/** 记录「用户看过这个会话了」。msg 由调用方解析后传入（拿不到则不传）。 */
function markViewed(projectPath, sessionId, msg) {
  setSeen(projectPath, sessionId, { at: new Date().toISOString(), msg });
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
    const msg = Number.isFinite(s.messageCount) ? s.messageCount : null;
    seen.set(key, { at: modified || now, msg });
  }
  seen.set(marker, { at: now, msg: null });
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

/**
 * 旧包名兼容：把 `@mariozechner/pi-tui` 等别名指向本机 `@earendil-works/*`。
 *
 * 背景：相当一批社区扩展是在 pi 改名之前发布的，import 的是旧包名
 * `@mariozechner/pi-tui` / `@mariozechner/pi-coding-agent` / `.../pi-agent-core` /
 * `.../pi-ai`。这些包在本机并不存在（pi 已改名为 `@earendil-works/*`），于是扩展
 * 加载时报 "Cannot find module"，工具要么不注册、要么注册了也执行即错——用户看到
 * 的就是「插件明明装了，agent 却用不了」（典型：pi-ask-tool 的 ask 工具）。
 *
 * 做法：在 <agentDir>/npm/node_modules/@mariozechner/ 下建软链指向同名新包。
 *   - 只建**缺失**的链接（已有真包不动），幂等；
 *   - 链接目标用本机实际解析到的 @earendil-works/*（以 findPiEntry 选中的那份为准，
 *     避免版本错配）；
 *   - 建不上（无权限 / 平台不支持）只记日志，不影响主流程。
 *
 * 为什么不在 Node 层做 module resolve hook：jiti 加载扩展时走的是自己的
 * 解析链路，Node 的 registerHooks 未必能拦到；写进 node_modules 是对 jiti/原生两条
 * 路径都生效的、最朴素可靠的方式。
 */
const LEGACY_PI_PACKAGES = [
  ["pi-tui", "@earendil-works/pi-tui"],
  ["pi-coding-agent", "@earendil-works/pi-coding-agent"],
  ["pi-agent-core", "@earendil-works/pi-agent-core"],
  ["pi-ai", "@earendil-works/pi-ai"],
];

/** 从 startDir 向上找 node_modules 里的新包目录（避免依赖 require.resolve 的 exports） */
function findInstalledPackageDir(pkgName, startDirs) {
  const rel = pkgName.split("/");
  for (const start of startDirs) {
    if (!start) continue;
    let dir = start;
    for (let i = 0; i < 8; i++) {
      const p = path.join(dir, "node_modules", ...rel);
      if (fs.existsSync(path.join(p, "package.json"))) return p;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

/** 建一次旧包名软链（幂等）；只在目标位置缺失链接时动手 */
function ensureLegacyPackageAliases(found) {
  // 注意：ensurePi() 可能在 agentDir 确定之前被调，所以这里用默认值兑底
  const baseAgentDir = agentDir || path.join(os.homedir(), ".pi", "agent");
  const scopeDir = path.join(baseAgentDir, "npm", "node_modules", "@mariozechner");
  // 新包的可能位置：pi 自己的安装目录、其内嵌 node_modules、agentDir 依赖目录
  const startDirs = [
    found?.base ? path.dirname(path.dirname(found.base)) : null, // .../node_modules
    found?.entry ? path.dirname(path.dirname(found.entry)) : null,
    path.join(baseAgentDir, "npm", "node_modules"),
  ].filter(Boolean);

  let created = 0;
  for (const [legacyName, realName] of LEGACY_PI_PACKAGES) {
    const linkPath = path.join(scopeDir, legacyName);
    try {
      if (fs.existsSync(linkPath)) continue; // 已有（真包或旧链接）不碰
    } catch (e) { continue; }
    const target = findInstalledPackageDir(realName, startDirs);
    if (!target) continue; // 本机没这个新包（如 pi-agent-core 可能没独立装），跳过
    try {
      fs.mkdirSync(scopeDir, { recursive: true });
      fs.symlinkSync(target, linkPath, "junction"); // junction：Windows 非管理员也能建
      created += 1;
    } catch (e) {
      // Windows 上 junction 失败时退化为直接复制链接（dir symlink）
      try { fs.symlinkSync(target, linkPath, "dir"); created += 1; }
      catch (e2) { sendLog("warn", `旧包名兼容链接失败 ${legacyName}: ${e2.message}`); }
    }
  }
  if (created > 0) sendLog("info", `已为 ${created} 个旧包名（@mariozechner/*）建立新包兼容链接`);
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
  // 加载前先把旧包名别名补上，否则依赖旧包名的扩展会在加载期就失败
  try { ensureLegacyPackageAliases(found); } catch (e) { sendLog("warn", `旧包名兼容处理失败: ${e.message}`); }
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

/**
 * 把底层错误（模型不可用 / 鉴权 / 网络 / 配额 / 模型名错误）转成中文可读原因，
 * 让前端能直接展示「为什么失败」，而不是只甩一行原始报错。
 */
function describeModelError(e) {
  const raw = e && (e.message || e) ? String(e.message || e) : "未知错误";
  const t = raw.toLowerCase();
  if (/401|unauthorized|invalid api key|api key|authentication/i.test(raw)) {
    return "模型鉴权失败（401）：API Key 无效或已过期。请到「模型配置」检查该提供商的密钥。";
  }
  if (/403|forbidden|permission|access denied/i.test(raw)) {
    return "模型无访问权限（403）：该账户 / 密钥没有使用此模型的权限。";
  }
  if (/429|rate limit|too many requests|quota/i.test(raw)) {
    return "触发限流或额度用尽（429）：请稍后重试，或换一个模型 / 提供商。";
  }
  if (/not found|does not exist|unknown model|no such model/i.test(raw)) {
    return "模型不存在或已下线：请确认模型名称。";
  }
  if (/enotfound|econnrefused|etimedout|esocket|network|dns|fetch failed|getaddrinfo|connect/i.test(t)) {
    return "网络异常，无法连接模型服务：请检查网络后重试。";
  }
  if (/api key|apikey/i.test(t) && /empty|missing|not set|未设置|未配置|为空|null/i.test(raw)) {
    return "未配置 API Key：请到「模型配置」为该提供商填写密钥。";
  }
  const trimmed = raw.length > 300 ? raw.slice(0, 300) + "…" : raw;
  return `发送失败：${trimmed}`;
}

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
        const input = Array.isArray(m.input) ? m.input : [];
        models.push({
          provider: m.provider,
          id: m.id,
          name: m.name || m.id,
          reasoning: Boolean(m.reasoning),
          // 图片输入能力：models.json 里 input 含 "image"；缺省视为不支持（未知也按不支持处理，
          // 避免把不支持图片的模型当支持——前端会据此阻止发送）。
          image: input.includes("image"),
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
 * 各项目「正在等用户回答的 ask」数：Map<projectPath, count>。
 *
 * 纯内存统计（遍历 runtimes 的 pendingAsk），不碰磁盘——ask 本就不落盘。
 * 单独抽出来是为了让前端能在 ask 出现/消失时**轻量**刷新黄问号：listProjects
 * 要对每个项目做 SessionManager.list（全量扫会话文件，大项目可达数秒），
 * 只为拿一个内存计数去付那个代价，就是「项目角标反应慢」的根因。
 */
function computeAskCountsByProject() {
  const byProject = new Map();
  for (const rec of runtimes.values()) {
    const pending = rec?.pendingAsk;
    if (!pending || pending.answered) continue;
    const key = rec.projectPath || "";
    byProject.set(key, (byProject.get(key) || 0) + 1);
  }
  return byProject;
}

/**
 * 列出项目，并附带每个项目的**角标数**（界面左侧图标角标用）。
 *
 * 角标口径 = 已完成未查看 + 进行中的会话数（不是历史会话总数）：
 * 历史总数只增不减，几十个会话就顶到 99+，用户无法从中得到任何信息。
 * 具体判定见 sessionFlag()。
 *
 * 除了总数 badgeCount，这里还把待办拆开返回：
 *   - runningCount：处理中（界面上画黄点）
 *   - unseenCount ：已完成未读（界面上画绿点）
 * 前端据此在图标右下角画状态圆点，「有活没干完」「有回答没看」一眼可辨。
 * badgeCount 恒等于 runningCount + unseenCount（含草稿一并归类）。
 *
 * 会话数来自 pi 的 SessionManager.list（按 cwd 计算会话目录），
 * 因此这里必须等 pi 就绪；取不到就退化为 0（角标不显示）。
 */
async function handleListProjects(id) {
  const projects = loadProjects();
  const sdk = await ensurePi();
  // 每个项目「正在等用户回答的 ask」数：纯内存统计（见 computeAskCountsByProject）。
  const askCountByProject = computeAskCountsByProject();
  const out = [];
  for (const p of projects) {
    let badgeCount = 0;
    let runningCount = 0;
    let unseenCount = 0;
    let sessionCount = 0;
    try {
      if (sdk?.SessionManager?.list) {
        const infos = await sdk.SessionManager.list(p.path);
        sessionCount = (infos || []).length;
        ensureSeenBaseline(infos, p.path);
        for (const s of infos || []) {
          const flag = sessionFlag(p.path, s);
          if (flag === null) continue;
          badgeCount += 1;
          if (flag === "running") runningCount += 1;
          else unseenCount += 1;
        }
        // 未落盘的草稿会话也算一条待办（与 listSessions 的口径保持一致），
        // 按是否在跑归到 running / unseen，保证 badgeCount === running + unseen
        const draft = drafts.get(p.path);
        if (draft && !(infos || []).some((s) => s.id === draft.sessionId)) {
          if (runtimeIsRunning(draft)) {
            badgeCount += 1;
            runningCount += 1;
          } else if (draftIsPending(p.path, draft)) {
            badgeCount += 1;
            unseenCount += 1;
          }
        }
      }
    } catch (e) { /* 单个项目取不到不影响整体 */ }
    const askCount = askCountByProject.get(p.path) || 0;
    out.push({ ...p, sessionCount, badgeCount, runningCount, unseenCount, askCount });
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
 * 会话是否正在跑（权威运行态）。
 *
 * 口径对齐 pi-web 的 `isRunning()`：
 *   - `rec.running`（agent_start…agent_end 之间，含首轮发送中）
 *     这一项覆盖「上一轮还没收尾、下一轮 prompt 刚进来」的窗口；
 *   - `session.isStreaming`（模型正在流式输出）；
 *   - `session.isCompacting`（正在压缩上下文）；
 *   - `session.isBashRunning`（正在跑 bash 工具）。
 *
 * 为什么不能只看 `rec.running`：agent_end 先于文件收尾、agent_start 又晚于用户
 * 消息落盘，只看它会在两端漏判；isStreaming / isCompacting / isBashRunning 是
 * SDK 自己的实时态，能把这些缝补上。
 *
 * 角标的「进行中」以它为准：用户切到别的项目时，原来那个项目里还在跑的会话
 * 依然应该被算进角标，这样用户知道「那边还有活没干完」。
 */
function isRunning(projectPath, sessionId) {
  for (const rec of runtimes.values()) {
    if (rec.projectPath !== projectPath || rec.sessionId !== sessionId) continue;
    return runtimeIsRunning(rec);
  }
  const draft = drafts.get(projectPath);
  if (draft && draft.sessionId === sessionId) return runtimeIsRunning(draft);
  return false;
}

/** 单个 runtime 是否在跑（对齐 pi-web：进程活着 + 任一活动态） */
function runtimeIsRunning(rec) {
  if (rec.running === true) return true;
  const s = rec.session;
  if (!s) return false;
  try {
    // 不能只看 rec.running：agent_end 会先于文件收尾、agent_start 又晚于用户消息
    // 落盘，只看它会在两端漏判；isStreaming / isCompacting / isBashRunning 是
    // SDK 自己的实时态，能把这些缝补上（与 pi-web 的 isRunning() 同一口径）。
    return Boolean(s.isStreaming || s.isCompacting || s.isBashRunning);
  } catch (e) {
    return false;
  }
}

/**
 * 查询某个会话此刻是否真的在跑（权威运行态，来自后端内存 rec.running）。
 *
 * 前端在「打开会话 / 超时后收尾」时点用它来对账内存里的 runningSessions 账本——
 * 避免「切走再切回状态没了」或「列表显示完成但视图还卡在运行」这类账本与后端
 * 不一致的问题。
 */
async function handleGetSessionStatus(id, params) {
  const projectPath = String(params?.projectPath || "");
  const sessionId = String(params?.sessionId || "");
  if (!projectPath || !sessionId) { sendError(id, "projectPath / sessionId 不能为空"); return; }
  const running = isRunning(projectPath, sessionId);
  sendResult(id, { sessionId, projectPath, running });
}

/**
 * 会话的角标归类。
 *
 * 返回：
 *   "running"  处理中（agent 正在跑）
 *   "unseen"   已完成未读（跑完了，用户还没点开看过）
 *   null       已查看（没有待处理事项）
 *
 * 判定顺序：先看是否在跑；再按「文件最后修改 vs 最后一次打开」判定已完成未读。
 * 尚未开始（pending，未落盘的草稿）由调用方另行累加，不走这里。
 *
 * ★ 为什么**没有**「处理失败」这个态（对齐 pi-web）：
 *   曾经这里去读会话 JSONL 的末尾，把 stopReason 不是 stop/length 的收尾当成
 *   「处理失败」。但「工具跑一半 / 发完问题还没回答」的尾部形态在**一轮进行中**
 *   与**真·中断**是完全一样的，光看文件根本分不出来——于是正在跑的会话被大量
 *   误报为「处理失败」。pi-web 的做法是：
 *     - 「运行中」只信**权威运行态**（见 isRunning：agent 在跑 / 正在流式 /
 *       正在压缩 / 正在跑 bash）；
 *     - 其余会话只有「已读 / 未读」之分，不推断失败。
 *   本插件采用同一口径：失败不再从文件推断，报错原因由 chat:error 实时提示。
 */
function sessionFlag(projectPath, session) {
  const id = session.id;
  if (isRunning(projectPath, id)) return "running";

  // 你正开着的会话不算未读：即使它在跑、消息条数还在涨，你就在看它。
  // （离开时前端会把 activeView 切走，再跑完的会重新算未读。）
  if (activeView && activeView.projectPath === projectPath && activeView.sessionId === id) {
    return null;
  }

  const rec = normSeen(loadSeen().get(seenKey(projectPath, id)));
  const msg = Number.isFinite(session.messageCount) ? session.messageCount : null;

  // 首选：按「消息条数」判定。比上次标记时多出消息才算未读——不受文件/消息
  // 时间戳抖动、也不受「会话还在被追加」的影响（那正是绿角标粘着不走的原因）。
  if (rec && rec.msg != null && msg != null) {
    return msg > rec.msg ? "unseen" : null;
  }

  // 兑底一：旧格式（只有时间戳）。modified <= seenAt 才算看过。
  const seenAt = rec?.at || "";
  const modified = session.modified instanceof Date ? session.modified.toISOString() : String(session.modified || "");
  if (seenAt) {
    const isViewed = Boolean(modified) && modified <= seenAt;
    return isViewed ? null : (modified ? "unseen" : null);
  }

  // 兑底二：既无消息数也无已读时间戳（全新会话）→ 算未读；没时间戳的旧文件
  // 按「无待办」处理。
  if (!modified) return null;
  return "unseen";
}

/** 未落盘的待创建会话（刚点「新建会话」）→ 列表项形状 */
function pendingToList(rec) {
  return {
    id: rec.id,
    title: rec.title || "新对话",
    updatedAt: rec.createdAt,
    createdAt: rec.createdAt,
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
      // 创建时间：界面用它给会话编「#L1」这样的序号（L = 最新创建），
      // 与列表的「最后消息时间」排序相互独立
      createdAt: s.created ? new Date(s.created).toISOString() : "",
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
        flag: runtimeIsRunning(draft) ? "running" : null,
        // 已被「全部已读」消掉的草稿不再算待办
        pending: draftIsPending(projectPath, draft),
      });
    }

    // 角标口径 = 处理中 + 已完成未读（含刚建好、还没发消息的草稿：
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

// ===================== 扩展 UI 桥接（让 ask 这类工具真正可用） =====================
//
// 背景：pi 的扩展可以在**执行中**弹 UI（ctx.ui.select/confirm/input/editor/custom）。
// 但 AgentSession 默认的扩展模式是 "print"、没有任何 UIContext，`ctx.hasUI` 恒为
// false——于是社区里的问询类工具（pi-ask-tool 的 `ask`、rpiv-ask-user-question）
// 会直接返回 "Error: ask tool requires interactive mode"。用户看到的就是「插件的
// 工具调用失败」。
//
// 做法：给会话 bindExtensions 一个 **RPC UIContext**（mode: "rpc"），把每一次 UI
// 请求当作一条 JSON-RPC 通知发给前端（`ext_ui:request`），前端渲染后调
// `ext_ui:respond` 把结果回传；后端再把结果 resolve 回扩展的工具调用。

/** 待回应的 UI 请求：id → { resolve, timer } */
const pendingExtUi = new Map();
let extUiSeq = 0;

/**
 * 把一次 UI 请求发给前端并等回应。
 *  - timeoutMs 到点（或前端一直不回）就回默认值，避免工具调用永久卡住；
 *  - 前端未实现该 UI（老版本）时，也会因超时安全退化。
 */
function requestExtUi(payload, defaultValue, timeoutMs = 600000) {
  const id = `extui-${++extUiSeq}`;
  return new Promise((resolve) => {
    const finish = (value) => {
      const rec = pendingExtUi.get(id);
      if (!rec) return;
      pendingExtUi.delete(id);
      if (rec.timer) clearTimeout(rec.timer);
      resolve(value === undefined ? defaultValue : value);
    };
    const timer = setTimeout(() => finish(defaultValue), timeoutMs);
    pendingExtUi.set(id, { resolve: finish, timer });
    sendNotification("ext_ui:request", { id, ...payload });
  });
}

/** 前端回传 UI 结果（ext_ui:respond） */
function handleExtUiRespond(id, value) {
  const rec = pendingExtUi.get(id);
  if (!rec) return;
  rec.resolve(value);
}

/** 前端主动取消一个 UI 请求（如关闭弹框） */
function cancelExtUi(id) {
  const rec = pendingExtUi.get(id);
  if (rec) rec.resolve(undefined);
}

/**
 * 构造给扩展用的 UIContext。
 *
 * 只实现真正用得上的方法；其余（setWidget/theme/编辑器等 TUI 专属能力）给成
 * 无害的空实现——宁可扩展降级，也不要因为它调了个我们没实现的 API 而报错。
 *
 * `custom(factory)` 是难点：它是扩展自绘的 TUI 组件。这里照 pi-web 的思路，用
 * 一个**无头 TUI**（只有 terminal.columns/rows + requestRender）把组件 render()
 * 出的**纯文本行**发给前端；前端把键盘输入回传，我们再喂给 component.handleInput。
 * 这样即使是不认识的结构化工具也能用（只是呈现为文本面板）。对 `ask` 这类我们**
 * 认识**的工具，我们还会另外走原生卡片（见 handleAgentEvent 的 tool_execution_start）。
 */
function createExtUiContext(rec) {
  const plain = (text) => (typeof text === "string" ? text : "");
  const themeStub = new Proxy({}, {
    get(_t, prop) {
      if (prop === "fg" || prop === "bg") return (_name, text) => plain(text);
      if (prop === "bold" || prop === "italic" || prop === "underline" || prop === "inverse" || prop === "strikethrough") return (text) => plain(text);
      if (prop === "getFgAnsi" || prop === "getBgAnsi") return () => "";
      if (prop === "getThinkingBorderColor" || prop === "getBashModeBorderColor") return () => (text) => plain(text);
      return () => "";
    },
  });

  return {
    select: (title, options, opts) =>
      requestExtUi(
        { kind: "select", title: String(title ?? ""), options: (options || []).map(String) },
        undefined,
        opts?.timeout
      ),
    confirm: (title, message, opts) =>
      requestExtUi(
        { kind: "confirm", title: String(title ?? ""), message: String(message ?? "") },
        false,
        opts?.timeout
      ),
    input: (title, placeholder, opts) =>
      requestExtUi(
        { kind: "input", title: String(title ?? ""), placeholder: placeholder ? String(placeholder) : "" },
        undefined,
        opts?.timeout
      ),
    editor: (title, prefill) =>
      requestExtUi(
        { kind: "editor", title: String(title ?? ""), prefill: prefill ? String(prefill) : "" },
        undefined
      ),
    notify: (message, type) =>
      sendNotification("ext_ui:notify", { message: String(message ?? ""), type: type || "info" }),

    // TUI 专属能力：空实现，避免扩展因缺方法而抛错
    onTerminalInput: () => () => {},
    setStatus: (key, text) => sendNotification("ext_ui:status", { key, text: text ?? null }),
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: (title) => sendNotification("ext_ui:title", { title: String(title ?? "") }),
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    theme: themeStub,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "不支持主题切换" }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},

    /** 自绘 TUI 组件 → 文本行 + 键盘输入双向桥 */
    custom: (factory, options) => requestCustomUi(rec, factory, options),
  };
}

/**
 * `ctx.ui.custom(factory)` 的桥接。
 *
 * 服务端用一个无头 TUI 让扩展的组件正常构建/渲染，把 render(width) 的每行文本
 * 发给前端（ext_ui:request, kind: "custom"）；前端显示为一个面板并把按键回传。
 */
function requestCustomUi(rec, factory, options) {
  if (typeof factory !== "function") return Promise.resolve(undefined);
  // 这一次 custom 是问询工具内部调的吗？那就**不用自绘面板**，改等前端的原生卡片：
  // 用户在前端选完 → extUiRespond → resolvePendingAsk → 这里拿到结果 → 交给 done。
  if (rec?.pendingAsk) return requestCustomUiForAsk(rec, factory);
  const id = `extui-${++extUiSeq}`;
  const width = (() => {
    const o = typeof options === "function" ? options() : options;
    const w = o && typeof o === "object" ? o.width : undefined;
    return Number.isFinite(w) ? Math.max(40, Math.min(140, Math.round(w))) : 92;
  })();
  const tui = {
    terminal: Object.freeze({ columns: width, rows: 40, kittyProtocolActive: false }),
    requestRender: () => { try { pushCustomRender(); } catch (e) { /* ignore */ } },
  };
  const theme = createExtUiContext(rec).theme;
  const keybindings = {};

  let component = null;
  let settled = false;
  let resolveFn = null;
  const promise = new Promise((resolve) => { resolveFn = resolve; });

  const finish = (value) => {
    if (settled) return;
    settled = true;
    pendingExtUi.delete(id);
    try { component?.dispose?.(); } catch (e) { /* ignore */ }
    sendNotification("ext_ui:close", { id });
    resolveFn(value);
  };

  const pushCustomRender = () => {
    if (settled || !component) return;
    let lines;
    try { lines = component.render(width) || []; }
    catch (e) { lines = [`扩展界面渲染失败：${e.message}`]; }
    sendNotification("ext_ui:request", { id, kind: "custom", lines });
  };

  // 前端的按键/关闭回传
  pendingExtUi.set(id, {
    resolve: (v) => {
      // v = { input: "..." } 表示一次按键；v = { done: true, value } 表示结束
      if (v && typeof v === "object" && "input" in v) {
        try { component?.handleInput?.(String(v.input)); } catch (e) { /* ignore */ }
        pushCustomRender();
        return;
      }
      finish(v && typeof v === "object" && "value" in v ? v.value : undefined);
    },
    timer: null,
  });

  Promise.resolve()
    .then(() => (settled ? undefined : factory(tui, theme, keybindings, (value) => finish(value))))
    .then((comp) => {
      if (settled) { try { comp?.dispose?.(); } catch (e) { /* ignore */ } return; }
      if (!comp || typeof comp.render !== "function") { finish(undefined); return; }
      component = comp;
      pushCustomRender();
    })
    .catch((e) => {
      sendLog("warn", `扩展自定义界面构建失败: ${e.message}`);
      finish(undefined);
    });

  return promise;
}

/**
 * ask 工具内部的 custom：不自绘，等前端原生卡片回答。
 *
 * ask 的组件工厂会在构建时就绑好若干交互，然后通过 `done(value)` 结束。我们没真正
 * 渲染它的组件，所以只需等前端把答案回传，再构造 ask 期望的 `{ cancelled, selectedOption }`
 * 喂给它的 `done`。
 *
 * 注意：这里仍然调一次 factory——因为有些实现把“关闭/回调”逻辑放在工厂里，不调可能
 * 留下未注册的 handler。但不驱动它、不渲染，拿到 done 后立即结束。
 */
function requestCustomUiForAsk(rec, factory) {
  const pending = rec.pendingAsk;
  // 先构建一次组件工厂（让扩展内部的 done 回调注册就位），但不渲染、不驱动。
  // 有些实现在工厂里就会把 done 包一层；不调可能让它以为“界面从未构建”。
  try {
    const tui = { terminal: { columns: 92, rows: 40, kittyProtocolActive: false }, requestRender: () => {} };
    const theme = createExtUiContext(rec).theme;
    factory(tui, theme, {}, (value) => {
      // 若扩展自己先调了 done（如默认值），则直接采纳并释放 pending
      if (rec.pendingAsk === pending) rec.pendingAsk = null;
      pending.settle(value);
    });
  } catch (e) {
    sendLog("warn", `ask 组件构建异常（已忽略，改用原生卡片）: ${e.message}`);
  }
  // 等前端原生卡片的回答（askAnswer → resolvePendingAsk → settle）
  return pending.answerPromise.then((value) => {
    if (rec.pendingAsk === pending) rec.pendingAsk = null;
    return value;
  });
}

/** 问询类工具名（不同包的名字不一样：pi-ask-tool 叫 ask，rpiv 叫 ask_user_question） */
const ASK_TOOL_NAMES = new Set(["ask", "ask_user_question"]);

/**
 * 把问询工具的 questions 结构转发给前端，让它用**原生问答卡片**渲染。
 *
 * 为什么单独做：这类工具内部走 ctx.ui.custom（自绘 TUI 组件），在 Web 宿主里只能把
 * 它 render() 成文本行（难看、也不好点）。而它的入参本身就是一份结构化 questions JSON
 * （id/question/description/options/multi/recommended）——直接交给前端渲染成卡片，体验
 * 好得多。
 *
 * 流程：这里给会话放一个 pendingAsk（带 settle）；紧接着 ask 工具内部调用的 custom
 * 会 await 它；用户在前端卡片选完 → askAnswer RPC → resolvePendingAsk → settle({ cancelled,
 * selectedOption }) → 喂给 ask 组件的 done()——于是 ask 工具正常拿到答案并继续。
 */
function maybeForwardAskTool(rec, toolName, toolCallId, args) {
  try {
    if (!ASK_TOOL_NAMES.has(String(toolName || ""))) return;
    const questions = Array.isArray(args?.questions) ? args.questions : null;
    if (!questions || !questions.length) return;

    // 旧的未回答 ask 先释放，避免跨调用串台
    clearPendingAsk(rec);
    let resolveAnswer = null;
    const answerPromise = new Promise((resolve) => { resolveAnswer = resolve; });
    rec.pendingAsk = {
      toolCallId: String(toolCallId || ""),
      questions,
      answerPromise,
      settle: (v) => resolveAnswer(v),
      answered: false,
      // 会话归属 + 创建时刻：前端切回会话时要靠 getPendingAsk 找回这张卡片，
      // 通知失效时也要带上 sessionId 让前端精确移除（见 clearPendingAsk）。
      sessionId: rec.sessionId,
      projectPath: rec.projectPath,
      createdAt: Date.now(),
    };

    sendNotification("chat:ask", {
      sessionId: rec.sessionId,
      projectPath: rec.projectPath,
      toolCallId,
      toolName: String(toolName),
      questions,
    });
  } catch (e) {
    sendLog("warn", `转发 ask 失败: ${e.message}`);
  }
}

/**
 * 前端原生卡片提交后回传答案。
 * answers 形如 [{ id, question, value: string | string[] }]。
 * 返回 true 表示确实消费了一个待回答的 ask。
 */
function resolvePendingAsk(rec, answers) {
  const pending = rec?.pendingAsk;
  if (!pending || pending.answered) return false;
  pending.answered = true;
  const list = Array.isArray(answers) ? answers : [];
  const first = list[0] || {};
  const value = first.value;
  const selectedOption = Array.isArray(value) ? value.join("、") : value == null ? "" : String(value);
  pending.settle({ cancelled: false, selectedOption });
  return true;
}

/** 通过 toolCallId 找到持有该 ask 的会话 */
function findRecByPendingAsk(toolCallId) {
  for (const rec of runtimes.values()) {
    if (rec.pendingAsk && String(toolCallId || "") === rec.pendingAsk.toolCallId) return rec;
  }
  return null;
}

/** 清掉一个会话上未回答的 ask（以取消结束，不抛错） */
function clearPendingAsk(rec) {
  const pending = rec?.pendingAsk;
  if (!pending) return;
  rec.pendingAsk = null;
  if (!pending.answered) {
    pending.answered = true;
    try { pending.settle({ cancelled: true }); } catch (e) { /* ignore */ }
    // 这个 ask 是被动失效的（轮次结束 / 会话重载 / 停止 / 被新 ask 顶掉），
    // 前端那张原生卡片若还挂着就成了「点了没反应」的僵尸卡片——通知它移除。
    // 用户主动取消（askCancel）和正常作答（answered=true 走到这里）不发：
    // 前者前端已自行移除，后者本就没有待回答卡片了。
    sendNotification("chat:ask-cleared", {
      sessionId: pending.sessionId ?? rec?.sessionId ?? "",
      projectPath: pending.projectPath ?? rec?.projectPath ?? "",
      toolCallId: pending.toolCallId || "",
    });
  }
}

/**
 * 给一个会话绑定 RPC UI（幂等）。失败只记日志：绑不上 UI 只是“需要交互的工具”不能用，
 * 不能把会话创建/打开弄挂。
 */
let extUiWarned = false;

/**
 * 正在用**原生卡片**处理的 ask 工具调用。
 *
 * ask 工具内部会走 ctx.ui.custom 自绘界面；我们已经在 tool_execution_start 时把
 * questions 结构发给前端弹原生卡片了，如果再让 custom 面板也弹出来，用户会看到
 * 两个重叠的界面。所以设一个**一次性标记**（rec.pendingNativeAsk），让紧接着的
 * 那次 custom 直接静默返回——前端已负责问答。
 */

async function bindSessionUi(rec) {
  if (!rec?.session || typeof rec.session.bindExtensions !== "function") {
    if (!extUiWarned) {
      extUiWarned = true;
      sendLog("warn", "该版本的 pi 不支持 session.bindExtensions，扩展的交互式 UI（如 ask）将不可用");
    }
    return;
  }
  try {
    await rec.session.bindExtensions({ uiContext: createExtUiContext(rec), mode: "rpc" });
  } catch (e) {
    sendLog("warn", `绑定扩展 UI 失败: ${e.message}`);
  }
}

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
    readDrafts.delete(`${projectPath}::${prevDraft.sessionId}`);
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
    turnGeneration: 0,  // 每轮递增，abort 后丢弃旧轮事件
  };
  rec.unsubscribe = session.subscribe((event) => {
    try { handleAgentEvent(rec, event); } catch (e) { sendLog("warn", `事件处理异常: ${e.message}`); }
  });
  // 绑定 RPC UI：让 ask 等需要在执行中弹 UI 的扩展工具真正可用（详见 createExtUiContext）
  await bindSessionUi(rec);
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
  // 打开历史会话同样要绑 UI（否则历史会话里调 ask 仍报 requires interactive mode）
  await bindSessionUi(rec);
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
 * 工具名 → 家族（决定工具行上显示哪一类「状态词」）。
 *
 * 参考 ZCode 前端 `ToolCallBlocks/renderers/*` 的 kindLabel 设计：工具行左侧
 * 不是「正在执行」这类通用词，而是按工具类别给出的动作词——读取类说「正在读取」、
 * 命令类说「正在执行」、编辑类说「正在编辑」。前端据此渲染单行摘要的类别文字。
 */
function toolKind(name) {
  let n = String(name || "").toLowerCase();
  if (!n) return "other";
  if (TOOL_KIND_MAP[n]) return TOOL_KIND_MAP[n];
  // MCP / 包装工具常带前缀（mcp_bash、tool_read），剥掉再查一次
  const stripped = n.replace(/^(mcp|tool|my|_)+[_-]?/, "");
  if (stripped && stripped !== n && TOOL_KIND_MAP[stripped]) return TOOL_KIND_MAP[stripped];
  // 仍未登记：做子串兜底，覆盖 read_file_v2 / bash_exec 这类变体
  n = stripped || n;
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

/** 工具名 → 家族（精确表；未命中再走上面的前缀兜底） */
const TOOL_KIND_MAP = {
  read: "read", read_file: "read", "read-file": "read",
  write: "write", write_file: "write", "write-file": "write", create: "write",
  edit: "edit", edit_file: "edit", "edit-file": "edit", multiedit: "edit", patch: "edit", apply_patch: "edit",
  bash: "execute", shell: "execute", terminal: "execute", command: "execute", run: "execute",
  search: "search", grep: "search", find: "search",
  glob: "list", list_dir: "list", ls: "list", dir: "list", list_files: "list",
  web_search: "fetch", web_fetch: "fetch", fetch: "fetch",
  subagent: "agent", sub_agent: "agent", start_sub_agent: "agent", task: "agent",
  // 文件系统类动作归入 write，读起来才像「正在移动 / 正在删除」
  move: "write", copy: "write", delete: "write", rename: "write", mkdir: "write", create_directory: "write",
  ask_user: "other", ask: "other", plan: "other", thinking: "other", think: "other", reasoning: "other",
};

/**
 * 工具家族 + 状态 → 类别词。
 *
 * 对齐 ZCode `tool-call-summary.ts` 的 `TOOL_CALL_STATUS_MESSAGE_IDS`：
 * 等待中 / 执行中 / 已执行 / 执行失败 / 已停止。这里按家族再细化一层，
 * 让读取类显示「正在读取」而不是笼统的「正在执行」。
 */
function toolKindLabel(name, status) {
  const kind = toolKind(name);
  const running = status === "running";
  const failed = status === "error";
  const stopped = status === "stopped";
  const words = {
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
  if (stopped) return "已停止";
  const w = words[kind] || words.other;
  return running ? w.running : failed ? w.error : w.success;
}

/** 数字前缀（+N / -N），供编辑类工具显示变更量 */
function changeStatOf(additions, deletions) {
  const a = Number(additions) || 0;
  const d = Number(deletions) || 0;
  if (!a && !d) return "";
  const parts = [];
  if (a) parts.push("+" + a);
  if (d) parts.push("-" + d);
  return parts.join(" ");
}

/** 从一段文本粗略估算变更行数（pi 的编辑结果有时带 ±行号统计，兜底用新旧文本行数差） */
function estimateChangeStat(args) {
  const a = args || {};
  // 常见的显式统计字段（不同 pi 版本 / 不同工具叫法不一）
  const explicit = changeStatOf(
    a.additions ?? a.linesAdded ?? a.added,
    a.deletions ?? a.linesRemoved ?? a.removed,
  );
  if (explicit) return explicit;
  const countLines = (v) => (typeof v === "string" && v ? v.split("\n").length : 0);
  const added = countLines(a.new_str ?? a.newString ?? a.new_text ?? a.content ?? a.insert);
  const removed = countLines(a.old_str ?? a.oldString ?? a.old_text);
  return changeStatOf(added, removed);
}

/**
 * 工具调用参数 → 结构化摘要（工具行上的「主文本 / 次文本 / 变更量」）。
 *
 * 参考 ZCode `getCompactToolCallSummary`：primaryText 是主体（命令 / 路径 / 查询词），
 * secondaryText 是补充说明，changeStat 是编辑类的 +N -N。前端把这三段渲染成一行
 * 内联摘要，点开才看完整的参数与结果。
 */
function describeToolSummary(args) {
  const a = args || {};
  const clip = (v, n) => {
    const s = String(v == null ? "" : v);
    return s.length > n ? s.slice(0, n) + "…" : s;
  };
  const out = { primaryText: "", secondaryText: "", changeStat: "" };

  if (a.command) {
    out.primaryText = clip(a.command, 160);
    return out;
  }
  const fp = a.file_path || a.filePath || a.path || a.directory || a.dir;
  if (fp) {
    out.primaryText = clip(fp, 160);
    out.changeStat = estimateChangeStat(a);
    if (a.old_str && a.new_str) out.secondaryText = `替换: ${clip(a.old_str, 50)} → ${clip(a.new_str, 50)}`;
    else if (a.old_str) out.secondaryText = `替换: ${clip(a.old_str, 50)}`;
    else if (a.insert) out.secondaryText = `插入: ${clip(a.insert, 60)}`;
    return out;
  }
  if (a.query) out.primaryText = clip(a.query, 160);
  else if (a.pattern) out.primaryText = clip(a.pattern, 160);
  else if (a.url) out.primaryText = clip(a.url, 160);
  else if (a.prompt) out.primaryText = clip(a.prompt, 160);
  else if (a.description) out.primaryText = clip(a.description, 160);
  else if (a.text) out.primaryText = clip(a.text, 160);
  else if (typeof a === "object" && Object.keys(a).length > 0) {
    // 兜底：前 3 个键值对，保持「一行摘要」的量级
    out.primaryText = Object.entries(a).slice(0, 3).map(([k, v]) => `${k}=${clip(v, 40)}`).join(", ");
  }
  return out;
}

/** 工具参数 → JSON 文本（展开后展示的「参数」块；截断避免长内容撑爆消息） */
function describeToolInputJson(args) {
  try {
    const text = JSON.stringify(args ?? {}, null, 2);
    if (!text || text === "{}") return "";
    return text.length > 4000 ? text.slice(0, 4000) + "\n…" : text;
  } catch (e) {
    return "";
  }
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
  // turn generation 过滤：abort 后会丢弃旧轮事件，避免新旧内容叠加
  const gen = rec.turnGeneration || 0;
  switch (event.type) {
    case "message_update": {
      if (gen !== rec.turnGeneration) break;
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
    case "tool_execution_start": {
      if (gen !== rec.turnGeneration) break;
      // 提取工具的详细动作信息（toolCallId 供前端按调用配对，避免同名工具串台）
      const startArgs = event.args || event.arguments || {};
      // 问询类工具（ask / ask_user_question）：把 questions 结构原样转给前端，
      // 让前端用原生问答卡片收集选择（详见 maybeForwardAskTool）。
      maybeForwardAskTool(rec, event.toolName, event.toolCallId, startArgs);
      const startSummary = describeToolSummary(startArgs);
      sendNotification("chat:tool", {
        sessionId: rec.sessionId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        status: "running",
        label: toolDisplayName(event.toolName),
        detail: describeToolCallArguments(startArgs),
        // 结构化摘要（工具行渲染用）；既有 label/detail 保留，向后兼容
        kind: toolKind(event.toolName),
        kindLabel: toolKindLabel(event.toolName, "running"),
        primaryText: startSummary.primaryText,
        secondaryText: startSummary.secondaryText,
        changeStat: startSummary.changeStat,
        inputJson: describeToolInputJson(startArgs),
      });
      break;
    }
    case "tool_execution_end": {
      if (gen !== rec.turnGeneration) break;
      // 完成时：把可读结果带回（工具行展开后能看到输出 / 报错）
      const endSummary = describeToolSummary(event.args || event.arguments || {});
      const endStatus = event.isError ? "error" : "success";
      const resultText = describeToolResult(event);
      sendNotification("chat:tool", {
        sessionId: rec.sessionId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        status: endStatus,
        label: toolDisplayName(event.toolName),
        detail: resultText,
        // 结构化字段：类别词随完成态改写（正在读取 → 已读取 / 读取失败）
        kind: toolKind(event.toolName),
        kindLabel: toolKindLabel(event.toolName, endStatus),
        primaryText: endSummary.primaryText,
        secondaryText: endSummary.secondaryText,
        changeStat: endSummary.changeStat,
        resultText: resultText || "",
      });
      break;
    }
    case "message_end": {
      if (gen !== rec.turnGeneration) break;
      // 用户消息落盘 → 把它此刻的 entryId 推给前端，实时发出的气泡也能带上
      // 「编辑」按钮（否则只有重载历史才有）。assistant 消息不需要。
      //
      // 注意时序：pi 先 `_emit(message_end)` 给订阅者，**之后**才 appendMessage 落盘
      // （见 agent-session.js 的 _handleAgentEvent）。所以此刻查不到 entryId，
      // 必须让出当前微任务，等落盘完成后再查。
      const msg = event.message;
      if (msg?.role !== "user") break;
      const text = contentText(msg.content, "");
      const imageCount = contentImageCount(msg.content);
      // 纯文本或纯图片都推送：纯图片消息也能拿到 entryId（从而可编辑/重发）。
      if (!text && !imageCount) break;
      setTimeout(() => {
        try {
          const userEntryId = findLastUserEntryId(rec, text, imageCount);
          if (!userEntryId) return;
          sendNotification("chat:user-entry", {
            sessionId: rec.sessionId,
            entryId: userEntryId,
            text,
          });
        } catch (e) { /* ignore */ }
      }, 0);
      break;
    }
    case "agent_start":
      // 新一轮开始：递增 generation（丢弃旧轮），清空累积缓冲，标记「进行中」（项目角标要用）
      rec.turnGeneration = (rec.turnGeneration || 0) + 1;
      rec.streamText = "";
      rec.streamThinking = "";
      rec.running = true;
      rec.turnStartedAt = Date.now();
      sendNotification("chat:status", { sessionId: rec.sessionId, status: "running" });
      break;
    case "agent_end": {
      // generation 检查：abort 后的旧轮 agent_end 丢弃（由 chat:aborted 接管前端清理）。
      // 否则旧轮 idle 通知会错误地清掉 runningSessions 并触发 settleTurnWork，
      // 与新轮 running 状态叠加，导致前端出现「已停止的旧回答 + 正在流式的新回答」。
      if (gen !== rec.turnGeneration) break;
      rec.running = false;
      // 本轮已结束：若还有未回答的 ask 等待，清掉（否则下次 custom 会误接旧 promise）
      clearPendingAsk(rec);
      // 本轮耗时：前端据此显示「工作中 8 秒」→「已工作 8 秒」
      const durationMs = rec.turnStartedAt ? Math.max(0, Date.now() - rec.turnStartedAt) : undefined;
      rec.turnStartedAt = null;
      sendNotification("chat:status", {
        sessionId: rec.sessionId,
        status: "idle",
        ...(durationMs !== undefined ? { durationMs } : {}),
      });
      // 本轮期间装/卸过插件：现在空闲了，把新扩展接上（见 reloadAllSessions 注释）。
      // 放到最后、且不 await 分支外层（这里已在同步 switch 里）——用微任务异步做，
      // 以免阻塞 idle 通知的投递。
      if (pendingReload.has(rec.key)) {
        pendingReload.delete(rec.key);
        void reloadRuntime(rec);
      }
      break;
    }
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
    const pushAssistant = (text, thinking, toolCalls, durationMs) => {
      if (!text && !thinking && !toolCalls.length) return;
      const entry = { role: "assistant", content: text || "" };
      if (thinking) entry.thinking = thinking;
      if (toolCalls.length) entry.toolCalls = toolCalls;
      // 本轮耗时（有 timestamp 才算得出）：前端据此显示「已工作 N 秒」
      if (typeof durationMs === "number" && durationMs >= 0) entry.durationMs = durationMs;
      out.push(entry);
    };

    // 该轮起点（最近一条 user 消息的时间戳），用于给 assistant 条目算耗时
    let turnStartedAt = null;

    for (const m of messages || []) {
      const role = m?.role;
      const content = m?.content;
      if (role === "user") {
        const text = typeof content === "string" ? content
          : Array.isArray(content) ? content.filter((c) => c?.type === "text").map((c) => c.text || "").join("\n") : "";
        // 图片内容块：提取为可渲染的缩略图（{mimeType, data}），前端据此显示
        const images = Array.isArray(content)
          ? content.filter((c) => c?.type === "image" && c?.data && c?.mimeType)
              .map((c) => ({ mimeType: c.mimeType, data: c.data }))
          : [];
        // 纯文本或仅图片都保留：否则空文本的图片消息会在历史里消失，
        // 也会让 user 条目与分支上的 message 对不齐（导致后续 entryId 错配）。
        if (text || images.length) {
          out.push({ role: "user", content: text, ...(images.length ? { images } : {}) });
          const t = timestampOf(m);
          if (t != null) turnStartedAt = t;
        }
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
              const args = c.arguments || {};
              const summary = describeToolSummary(args);
              toolCalls.push({
                id: c.id || "",
                name: c.name || "",
                label: toolDisplayName(c.name),
                detail: describeToolCallArguments(args),
                // 结构化摘要：与实时 chat:tool 事件同一套，前端共用一种渲染
                kind: toolKind(c.name),
                primaryText: summary.primaryText,
                secondaryText: summary.secondaryText,
                changeStat: summary.changeStat,
                inputJson: describeToolInputJson(args),
              });
            }
          }
        }
        const at = timestampOf(m);
        const durationMs = at != null && turnStartedAt != null ? Math.max(0, at - turnStartedAt) : undefined;
        // 带思考但不带任何工具调用、也没有正文的中间态（如仅思考的回复）也需要保留
        pushAssistant(text, thinking, toolCalls, durationMs);
        continue;
      }
      // system / 其它角色：忽略
    }
  } catch (e) { /* ignore */ }
  return out;
}

/** 从消息上取时间戳（毫秒）；兼容 number / ISO 字符串 / 缺失 */
function timestampOf(m) {
  const raw = m?.timestamp ?? m?.createdAt;
  if (raw == null) return null;
  if (typeof raw === "number") return raw;
  const t = Date.parse(String(raw));
  return Number.isNaN(t) ? null : t;
}

/** 从 pi 的消息 content（string 或 [{type:"text",text}]）里取出纯文本 */
function contentText(content, fallback = "") {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((c) => c?.type === "text").map((c) => c.text || "").join("\n");
  }
  return fallback;
}

/** 从 user 消息 content 里取出图片块数量（content 为 string 时是 0） */
function contentImageCount(content) {
  if (!Array.isArray(content)) return 0;
  return content.filter((c) => c?.type === "image" && c?.data && c?.mimeType).length;
}

/**
 * 当前分支上的 user 消息条目（带 entryId + 纯文本 + 图片数），按会话顺序。
 * 图片数用于「同一文本 + 不同图片」的精准配对（比如连续发「看看这个」配不同截图）。
 * 纯图片（无文本）的消息也纳入：否则历史里图片消息缺失会让 user 条目对不齐。
 */
function userEntriesOfBranch(rec) {
  const out = [];
  try {
    const branch = rec?.session?.sessionManager?.getBranch?.() || [];
    for (const e of branch) {
      if (e?.type !== "message") continue;
      const msg = e.message;
      if (msg?.role !== "user") continue;
      const text = contentText(msg.content, "");
      const imageCount = contentImageCount(msg.content);
      if (text || imageCount) out.push({ entryId: e.id, text, imageCount });
    }
  } catch (e) { /* 无分支信息（草稿）→ 空数组 */ }
  return out;
}

/**
 * 分支上最后一条「文本 + 图片数」都匹配 target 的 user 条目 id（刚发出的那条）。
 * text 命中但图片数不同（不同截图）不算——优先取文本相同且图片数也相同的最后一条；
 * 若找不到完全匹配，退化为仅按文本匹配的最后一条（向后兼容历史数据）。
 */
function findLastUserEntryId(rec, text, imageCount) {
  const target = String(text || "");
  const list = userEntriesOfBranch(rec);
  const byText = list.filter((u) => u.text === target);
  if (!byText.length) return null;
  const exact = byText.filter((u) => u.imageCount === (imageCount || 0));
  const pick = (exact.length ? exact : byText);
  return pick[pick.length - 1].entryId;
}

/**
 * 给转录里的 user 条目补上分支 entryId（用于前端「编辑某条消息」）。
 *
 * session.messages 里**不带 entryId**，而 navigateTree 需要 entryId 才能定位。
 * SessionManager.getBranch() 则返回当前分支上带 id 的原始条目（顺序与上下文一致），
 * 因此把分支上的 user 文本序列与转录里的 user 条目按序对齐即可。
 *
 * 注意 getBranch 返回的条目含 message / usage / compaction 等多种类型，只取
 * type==="message" && role==="user" 的；草稿会话未落盘时两者都不存在，返回原样。
 */
function attachUserEntryIds(rec, transcript) {
  try {
    const ids = userEntriesOfBranch(rec);
    // 按序配对：分支上的 user 与转录里的 user 一一对应（都按会话时间顺序）
    let k = 0;
    for (const item of transcript || []) {
      if (item?.role !== "user") continue;
      const hit = ids[k];
      if (hit) item.entryId = hit.entryId;
      k++;
    }
  } catch (e) { /* 沉默：没有分支信息时前端不显示编辑入口 */ }
  return transcript;
}

/** 从内存 runtime 抽取转录（草稿会话未落盘时用，与磁盘读取共用同一转换） */
function readMessagesOfRuntime(rec) {
  try {
    const transcript = buildTranscriptFromMessages(rec?.session?.messages || []);
    return attachUserEntryIds(rec, transcript);
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
    // 给 user 条目补入口 id，前端才能对某条历史消息发起「编辑并重发」
    attachUserEntryIds({ session: { sessionManager: manager } }, transcript);
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
  // 图片：前端传来的 [{ data: base64(无前缀), mimeType }]，可选。
  const images = Array.isArray(params?.images)
    ? params.images
        .filter((im) => im && typeof im.data === "string" && im.data && typeof im.mimeType === "string" && im.mimeType)
        .map((im) => ({ type: "image", data: im.data, mimeType: im.mimeType }))
    : [];
  // 文本 + 图片二选一即可；都为空才拒绝（避免 pi 收到空 prompt）。
  if (!message && !images.length) { sendError(id, "消息不能为空"); return; }
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
    // 有图片时一并交给 pi；pi 内部会做模型维度的自动缩放（inputLimits.images.resize）。
    await session.prompt(message, { source: "interactive", ...(images.length ? { images } : {}) });
  } catch (e) {
    const reason = describeModelError(e);
    // 本轮没真正跑起来就失败了（模型不可用 / 鉴权 / 网络等）：
    // 清掉「进行中」标记并通知前端，避免列表 / 视图卡在运行态（假死）。
    if (rec.running) {
      rec.running = false;
      sendNotification("chat:aborted", { sessionId: rec.sessionId, projectPath });
    }
    sendNotification("chat:error", {
      sessionId: rec.sessionId,
      projectPath,
      error: reason,
    });
    sendError(id, reason);
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
      if (m.errorMessage) {
        const reason = describeModelError({ message: m.errorMessage });
        // 本轮以错误结束：把可读原因推给前端（不仅回 RPC 错误），
        // 并清掉运行态，避免视图卡在「运行中」但实际已停止。
        sendNotification("chat:error", {
          sessionId: rec.sessionId,
          projectPath,
          error: reason,
        });
        sendError(id, reason);
        return;
      }
      break;
    }
  } catch (e) { /* ignore */ }

  // 本次提问的 entryId：供前端给刚发出的气泡挂上「编辑」按钮（否则只有重载历史才有）。
  // prompt() resolve 时该 user 消息已落盘，取分支上最后一条「文本 + 图片数」匹配的 user 条目。
  const userEntryId = findLastUserEntryId(rec, message, images.length);

  sendResult(id, { content: fullContent, sessionId: rec.sessionId, userEntryId });
}

/**
 * 编辑某条已发送的用户消息并重发（等价 pi 原生 /tree：选中 user 消息 → 文本回到
 * 编辑器 → 提交后从该处开新分支）。
 *
 * 步骤：
 *   1. 定位会话 runtime（内存优先，否则从会话文件打开）；
 *   2. 解析出目标 user 条目的 entryId（前端传 entryId，退化时按 userIndex 数第几条）；
 *   3. navigateTree(entryId)：leaf 回退到该消息的父节点 → 该消息及其之后的分支全部
 *      退出当前上下文（正是「回车确认后下面消息消失」）；
 *   4. 回传截断后的转录，前端据此整体重绘；
 *   5. 若 newText 非空，紧接着 prompt(newText)，事件流按既有通知机制推给前端。
 *
 * 不传 summarize：不做分支摘要，避免在重启处插入一段多余的「已放弃分支的总结」。
 */
async function handleEditUserMessage(id, params) {
  const projectPath = String(params?.projectPath || "");
  const sessionId = String(params?.sessionId || "");
  const entryId = params?.entryId ? String(params.entryId) : null;
  const userIndex = Number.isInteger(params?.userIndex) ? params.userIndex : null;
  const newText = typeof params?.newText === "string" ? params.newText.trim() : "";
  const modelKey = params?.model || null;
  if (!projectPath || !sessionId) { sendError(id, "projectPath / sessionId 不能为空"); return; }
  if (modelKey) selectedModel = { key: modelKey };

  // 草稿会话（未落盘）没有可定位的分支条目，直接拒绝
  const draft = drafts.get(projectPath);
  if (draft && draft.sessionId === sessionId) { sendError(id, "草稿会话暂不支持编辑消息"); return; }

  let rec = findRuntimeBySessionId(projectPath, sessionId);
  try {
    if (!rec) {
      const file = await findSessionFile(projectPath, sessionId);
      if (!file) throw new Error(`找不到会话文件: ${sessionId}`);
      rec = await openSession(projectPath, file, modelKey);
    }
  } catch (e) {
    sendError(id, e.message);
    return;
  }

  const session = rec?.session;
  if (!session?.navigateTree) { sendError(id, "当前 pi 版本不支持消息编辑（缺少 navigateTree）"); return; }

  // 运行中也可以编辑：先中止当前这一轮，等 agent 真正 idle 后再改写历史
  // （navigateTree 在 streaming 时会直接抛错，所以必须先 abort + waitForIdle）。
  if (session.isStreaming) {
    sendLog("info", `编辑前中止正在运行的会话: ${rec.sessionId}`);
    // 立刻递增 generation：此后到达的旧轮缓冲事件（delta / tool）全被丢弃，
    // 防止与新轮内容叠加显示。新轮的 agent_start 还会再递增一次，无影响。
    rec.turnGeneration = (rec.turnGeneration || 0) + 1;
    try {
      await session.abort();
    } catch (e) {
      sendLog("warn", `中止失败（继续尝试编辑）: ${e.message}`);
    }
    if (session.isStreaming) {
      try { await session.waitForIdle?.(); } catch (e) { /* ignore */ }
    }
    if (session.isStreaming) {
      sendError(id, "无法停止当前回答，请稍后重试");
      return;
    }
    sendNotification("chat:aborted", { sessionId: rec.sessionId, projectPath });
  }

  // 解析目标 entryId：优先用前端给的；失效时先按原文匹配，再退化到 userIndex
  const oldText = typeof params?.oldText === "string" ? params.oldText : "";
  let targetId = entryId;
  // 目标原始图片：编辑后重发时需要把它一并带上（navigateTree 会把原消息摘掉）。
  let originalImages = [];
  try {
    const branch = session.sessionManager?.getBranch?.() || [];
    const userEntries = branch.filter(
      (e) => e?.type === "message" && e.message?.role === "user"
        && (contentText(e.message.content, "").length > 0 || contentImageCount(e.message.content) > 0)
    );
    const stillValid = targetId && userEntries.some((e) => e.id === targetId);
    if (!stillValid) {
      // entryId 缺失或不在此分支上（会话已变动）：按原文匹配同一条消息
      if (oldText) {
        const idxHit = userIndex != null ? userEntries.findIndex(
          (e, i) => i === userIndex && contentText(e.message.content, "") === oldText
        ) : -1;
        const anchor = idxHit >= 0 ? userEntries[idxHit]
          : userEntries.find((e) => contentText(e.message.content, "") === oldText);
        if (!anchor) { sendError(id, "该消息已不在当前会话分支上，无法编辑"); return; }
        targetId = anchor.id;
      } else if (userIndex != null && userIndex >= 0 && userIndex < userEntries.length) {
        targetId = userEntries[userIndex].id;
      } else {
        sendError(id, "无法定位要编辑的消息");
        return;
      }
    }
    // 取出目标条目的图片块（用于重发时保留图片）
    const target = userEntries.find((e) => e.id === targetId);
    if (target) originalImages = (target.message?.content || [])
      .filter((c) => c?.type === "image" && c?.data && c?.mimeType)
      .map((c) => ({ type: "image", data: c.data, mimeType: c.mimeType }));
  } catch (e) {
    sendError(id, `定位消息失败: ${e.message}`);
    return;
  }

  // 截断：leaf 回退到目标 user 消息的父节点（该消息与其后全部退出当前上下文）
  try {
    await session.navigateTree(targetId, { summarize: false });
  } catch (e) {
    sendError(id, `编辑失败: ${e.message}`);
    return;
  }

  // 截断后的转录（含 entryId），前端据此重绘
  const transcript = readMessagesOfRuntime(rec);

  if (!newText) {
    // 只截断不重发：回传转录，前端整体重绘（下方消息消失）
    sendResult(id, { ok: true, transcript, sessionId: rec.sessionId, resent: false });
    return;
  }

  // 重发：与 handleChat 同路径，只是不再新建/查找 runtime。
  // 先回传「已截断」的结果，让前端立刻去掉下方消息；prompt 在后台进行，
  // 事件照常推送。注意**此处不重绘**：刚重发的 user 消息要等 prompt 内部落盘，
  // 前端用回传的 userEntryId 就地更新那条气泡即可（否则会把它抹掉）。
  sendResult(id, { ok: true, transcript, sessionId: rec.sessionId, resent: true });

  // running/idle 通知由 agent_start / agent_end 事件自动发出（见 handleAgentEvent），
  // 这里不重复发，避免前端收到两份状态。
  try {
    nameSessionFromFirstMessage(rec, newText);
    // 保留原消息的图片（navigateTree 已摘掉原消息），否则重发会丢失图片
    await session.prompt(newText, { source: "interactive", ...(originalImages.length ? { images: originalImages } : {}) });
    if (drafts.get(projectPath) === rec) drafts.delete(projectPath);
  } catch (e) {
    sendLog("warn", `重发失败: ${e.message}`);
    sendNotification("chat:error", {
      sessionId: rec.sessionId,
      projectPath,
      error: String(e.message || e),
    });
  }
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

// ===================== Pi 插件（包）管理 =====================
//
// 这里的「插件」指 pi 自己的**包**体系：settings.json 里的 `packages`
// （npm:@scope/pkg、git:host/user/repo、本地路径），一个包可以携带
// extensions / skills / prompts / themes 四类资源。
//
// 我们不自己解析 settings.json，而是复用 pi SDK 的 DefaultPackageManager：
//    - listConfiguredPackages() 列已配置的包（含 scope、安装路径）；
//    - resolve() 复用 pi 的加载规则，统计一个包实际带来多少资源；
//    - installAndPersist()/removeAndPersist() 安装/卸载并同步写回 settings.json。
// 这样版本升级后 pi 改了包语义，插件不用跟着改。

/** 惰性构造：依赖 pi SDK 与 agentDir，因此放到 ensurePi/ensureModelRegistry 之后 */
let packageManager = null;

/**
 * 每次重新构造包管理器。
 *
 * SettingsManager.create() 会在构造时读取 settings.json 并缓存；如果用户在
 * pi CLI 里装了包（或手改了 settings.json），缓存就会过期。列表是一次点击操作，
 * 重建成本极低，所以列出/安装/卸载前总是用最新文件重建一份。
 */
async function ensurePackageManager() {
  const sdk = await ensurePi();
  if (!sdk?.DefaultPackageManager || !sdk?.SettingsManager) {
    piLoadError = piLoadError || "该版本的 pi 未提供包管理 API（DefaultPackageManager），请升级 pi";
    return null;
  }
  if (!agentDir) {
    agentDir = sdk.getAgentDir ? sdk.getAgentDir() : path.join(os.homedir(), ".pi", "agent");
  }
  try {
    // NOTE: 这里用 agentDir 而不是 process.cwd()。
    //  - process.cwd() 在 app 里是**插件安装目录**，与会话真正使用的 cwd（项目路径）
    //    不一致；SettingsManager/DefaultPackageManager 会按 cwd 去解析项目级配置与
    //    本地路径来源，导致「设置里列出的插件」与「会话实际解析出的插件」口径不同。
    //  - 本面板管理的是**用户级**插件（settings.json 的 packages），因此以 agentDir
    //    为基准才是正确、且与项目无关的。
    const settingsManager = sdk.SettingsManager.create(agentDir, agentDir);
    packageManager = new sdk.DefaultPackageManager({
      cwd: agentDir,
      agentDir,
      settingsManager,
    });
    return packageManager;
  } catch (e) {
    sendLog("warn", `包管理器初始化失败: ${e.message}`);
    packageManager = null;
    return null;
  }
}

/*
 * 安装/卸载/更新插件后，让**已经打开着的会话**立刻用上新的扩展与工具。
 *
 * 为什么必须显式做这一步：
 *   AgentSession 在**构造时**就把扩展（extensions）解析进 ExtensionRunner，
 *   之后不会再自己重读磁盘。而本后端把每个会话的 runtime 缓存在 `runtimes` 里
 *   长期复用（切回会话不再重建）。于是：清单（listPlugins）每次点击都会重新读
 *   settings.json，所以设置里「看得到」刚装的插件；可正在用的那个会话却仍旧是
 *   旧的一套工具——用户看到的就是「设置里明明装了，agent 却没有这些工具」。
 *
 * 会话若正在跑（模型流式输出 / 压缩 / bash 工具中），此刻 reload 会把执行中的
 * 扩展 runner 换掉、打断本轮，所以只挂一个 `pendingReload` 标记，等本轮 agent_end
 * 之后再 reload（见 handleAgentEvent 的 agent_end 分支）。
 *
 * 返回统计信息，供前端提示用户「有几个会话已生效、几个要等本轮跑完」。
 */
let pendingReload = new Set(); // 待空闲后 reload 的 runtime key

/** 立刻 reload 一个会话 runtime（已确保不在跑）；失败只记日志，不影响插件操作结果 */
async function reloadRuntime(rec) {
  try {
    if (typeof rec?.session?.reload !== "function") return false;
    clearPendingAsk(rec); // 换 runner 后旧的 ask 等待器失效，先释放
    await rec.session.reload();
    // reload 会新建 extension runner，之前绑定的 UI context 一并丢失——重新绑上，
    // 否则 reload 后 ask 又会回到 requires interactive mode。
    await bindSessionUi(rec);
    sendLog("info", `会话已重载扩展: sessionId=${rec.sessionId}`);
    return true;
  } catch (e) {
    sendLog("warn", `会话重载扩展失败 (${rec?.sessionId}): ${e.message}`);
    return false;
  }
}

/**
 * 把「插件集合已变化」应用到所有活着的会话。
 * 正在跑的会话不立即 reload，而是打标记，等它空闲下来再重载。
 */
async function reloadAllSessions() {
  const seen = new Set();
  let reloaded = 0;
  let deferred = 0;
  for (const rec of runtimes.values()) {
    if (!rec || seen.has(rec.key)) continue;
    seen.add(rec.key);
    if (runtimeIsRunning(rec)) {
      pendingReload.add(rec.key);
      deferred += 1;
      continue;
    }
    if (await reloadRuntime(rec)) reloaded += 1;
  }
  return { reloaded, deferred };
}

// ===================== settings.json 监听（全自动保持一致） =====================
//
// 目标：设置里列出的插件 = agent 能用的插件，**且用户不需要做任何操作**。
//
// 除了本插件面板的安装/卸载/更新会调 reloadAllSessions() 外，用户也可能在终端用
// `pi install` 装包、或手改 ~/.pi/agent/settings.json。这些外部修改不会经过本后端。
// 这里监听 settings.json 的 mtime：一旦变化就重建包管理器缓存，并重载所有会话，
// 使得「用户在设置里看到什么，agent 就是什么」。
//
// 用轮询 mtime（2s）而不是 fs.watch：
//   - fs.watch 在 Windows 上对「编辑器原子保存（rename 替换）」会丢事件；
//   - 只读一个文件的 statSync，开销可忽略；
//   - 后端本来就有长驻进程，无需额外生命周期管理。
let settingsMtimeMs = 0;
let settingsPollTimer = null;

/** settings.json 的 stat.mtimeMs；文件不存在返回 0 */
function settingsFileMtime() {
  try {
    return fs.statSync(path.join(agentDir, "settings.json")).mtimeMs;
  } catch (e) {
    return 0;
  }
}

/**
 * 用户级 settings.json 变化 → 重载所有会话。
 *
 * 注意：本插件面板自己安装/卸载时也会改 settings.json，于是这里会和面板的显式
 * reloadAllSessions() 重叠。重叠是幂等且无害的（reload 不贵，且 stats 会合并），
 * 所以不做去重——去重反而会在「面板 reload 先跑、mtime 后变」时漏掉。
 */
async function onSettingsChanged() {
  // 让下次 ensurePackageManager() 拿到新的 settings（它每次都会重建 SettingsManager）
  packageManager = null;
  const stat = await reloadAllSessions();
  sendNotification("plugin:changed", {
    reason: "settings.json",
    reloaded: stat.reloaded,
    deferred: stat.deferred,
  });
  sendLog(
    "info",
    `检测到 pi settings.json 变化，已重载会话（${stat.reloaded} 个已生效，${stat.deferred} 个待本轮结束）`
  );
}

/** 启动 settings.json 轮询监听（幂等；在 init 后调用） */
function startSettingsWatch() {
  if (settingsPollTimer) return;
  settingsMtimeMs = settingsFileMtime();
  settingsPollTimer = setInterval(() => {
    const cur = settingsFileMtime();
    if (cur && cur !== settingsMtimeMs) {
      settingsMtimeMs = cur;
      onSettingsChanged().catch((e) => sendLog("warn", `settings 变化处理失败: ${e.message}`));
    } else if (cur) {
      settingsMtimeMs = cur;
    }
  }, 2000);
  // 不阻止进程退出（unref 后定时器不会 hold 住事件循环）
  try { settingsPollTimer.unref?.(); } catch (e) { /* ignore */ }
}

/** 把 pi 的 ProgressEvent 转成前端能显示的一行提示 */
function pluginProgressNotify(source) {
  return (ev) => {
    try {
      sendNotification("plugin:progress", {
        source: ev?.source || source || "",
        action: ev?.action || "",
        type: ev?.type || "",
        message: ev?.message || "",
      });
    } catch (e) { /* ignore */ }
  };
}

/** 读包安装目录里的 package.json，补上人类可读的名称/版本/描述 */
function readPackageMeta(installedPath) {
  try {
    const pjPath = path.join(installedPath, "package.json");
    if (!fs.existsSync(pjPath)) return null;
    const pj = JSON.parse(fs.readFileSync(pjPath, "utf8"));
    return {
      name: pj.name || "",
      version: pj.version || "",
      description: pj.description || "",
      homepage: typeof pj.homepage === "string" ? pj.homepage : "",
      isPiPackage: Array.isArray(pj.keywords) && pj.keywords.includes("pi-package"),
    };
  } catch (e) {
    return null;
  }
}

/**
 * 收集「agent 实际能用的工具名」——给设置面板一个**可验证**的口径。
 *
 * 优先读真实会话（权威）：只要有一个活着（或草稿）的 runtime，就取它的
 * getActiveToolNames()/getAllTools()。这正是模型发请求时看到的工具集。
 * 一个会话都没有（用户还没开始对话）时退而求其次：把已解析出的扩展文件加载
 * 一遍，直接数它们注册的工具名（不比构建整个 AgentSession，开销小）。
 *
 * 返回 { names, source: "session" | "extensions" }，取不到时 names 为空数组。
 */
async function collectAgentTools() {
  // 1) 真实会话：最权威
  const live = [];
  for (const rec of runtimes.values()) if (rec?.session) live.push(rec);
  for (const rec of drafts.values()) if (rec?.session && !live.includes(rec)) live.push(rec);
  if (live.length) {
    const rec = live[live.length - 1];
    try {
      const active = typeof rec.session.getActiveToolNames === "function"
        ? rec.session.getActiveToolNames()
        : [];
      const all = typeof rec.session.getAllTools === "function"
        ? rec.session.getAllTools().map((t) => t.name)
        : active;
      return { names: [...new Set(all)], active: [...new Set(active)], source: "session" };
    } catch (e) {
      sendLog("warn", `读取会话工具失败: ${e.message}`);
    }
  }

  // 2) 没有会话：直接加载扩展文件，数它们注册的工具名
  const sdk = await ensurePi();
  const pm = await ensurePackageManager();
  if (!sdk?.discoverAndLoadExtensions || !pm) return { names: [], active: [], source: "none" };
  try {
    const resolved = await pm.resolve(async () => "skip");
    const paths = (resolved?.extensions || []).filter((r) => r.enabled).map((r) => r.path);
    if (!paths.length) return { names: [], active: [], source: "extensions" };
    const result = await sdk.discoverAndLoadExtensions(paths, agentDir || process.cwd(), agentDir || undefined);
    const names = new Set();
    for (const ext of result?.extensions || []) {
      for (const name of ext.tools?.keys?.() || []) names.add(name);
    }
    return { names: [...names], active: [], source: "extensions" };
  } catch (e) {
    sendLog("warn", `统计扩展工具失败: ${e.message}`);
    return { names: [], active: [], source: "none" };
  }
}

/**
 * 列出已配置的 pi 插件（包）。
 *
 * 除了 listConfiguredPackages 给的信息，还尝试：
 *   1. 读 package.json 补名称/版本/描述；
 *   2. 用 resolve() 统计整机实际加载的 extensions/skills/prompts/themes 数量。
 * resolve() 只做路径解析、不联网（onMissing=skip），因此可以安全地在列表里调用。
 */
async function handleListPlugins(id) {
  const pm = await ensurePackageManager();
  if (!pm) {
    sendError(id, piLoadError || "pi 未就绪，无法读取插件列表");
    return;
  }

  let configured = [];
  try {
    configured = pm.listConfiguredPackages();
  } catch (e) {
    sendError(id, `读取 pi 插件失败: ${e.message || e}`);
    return;
  }

  const plugins = configured.map((c) => {
    const meta = c.installedPath ? readPackageMeta(c.installedPath) : null;
    return {
      source: c.source,
      scope: c.scope,
      filtered: Boolean(c.filtered),
      installedPath: c.installedPath || "",
      installed: Boolean(c.installedPath),
      name: meta?.name || "",
      version: meta?.version || "",
      description: meta?.description || "",
      homepage: meta?.homepage || "",
      isPiPackage: Boolean(meta?.isPiPackage),
    };
  });

  // 整机资源统计（各类型加载了多少个文件）
  const counts = { extensions: 0, skills: 0, prompts: 0, themes: 0 };
  try {
    const resolved = await pm.resolve(async () => "skip");
    for (const k of Object.keys(counts)) counts[k] = resolved?.[k]?.length || 0;
  } catch (e) {
    sendLog("warn", `解析插件资源失败: ${e.message}`);
  }

  // 「agent 实际能用的工具」——列表另一侧的可验证口径（让它和插件清单对得上）
  const agentTools = await collectAgentTools();

  sendResult(id, {
    plugins,
    counts,
    agentTools,
    agentDir,
    settingsPath: path.join(agentDir, "settings.json"),
  });
}

/**
 * 安装一个 pi 插件（包），并写回 settings.json。
 *
 * 来源字符串原样交给 pi 解析（与 `pi install <source>` 完全一致）：
 *   npm:@scope/pkg@1.2.3 / git:github.com/user/repo / https://… / 本地路径。
 * 安装可能耗时较久（npm/ git 拉取），进度通过 plugin:progress 通知前端。
 */
async function handleInstallPlugin(id, params) {
  const pm = await ensurePackageManager();
  if (!pm) {
    sendError(id, piLoadError || "pi 未就绪，无法安装插件");
    return;
  }
  const source = String(params?.source || "").trim();
  if (!source) {
    sendError(id, "请填写插件来源，例如 npm:@scope/pkg 或 git:github.com/user/repo");
    return;
  }
  const local = Boolean(params?.local);
  try {
    pm.setProgressCallback(pluginProgressNotify(source));
    await pm.installAndPersist(source, { local });
    // 让已经打开着的会话也用上新插件携带的扩展/工具（否则只对新建会话生效）
    const { reloaded, deferred } = await reloadAllSessions();
    sendLog("info", `插件已安装: ${source}（会话重载 ${reloaded}，待重载 ${deferred}）`);
    sendResult(id, { ok: true, source, reloaded, deferred });
  } catch (e) {
    const raw = e?.message || String(e);
    const trimmed = raw.length > 800 ? raw.slice(0, 800) + "\n…（输出已截断）" : raw;
    sendLog("error", `插件安装失败: ${trimmed}`);
    sendError(id, `插件安装失败：\n${trimmed}`);
  } finally {
    try { pm.setProgressCallback(undefined); } catch (e) { /* ignore */ }
  }
}

/** 把 Windows 反斜杠路径归一成正斜杠，便于 pi 做来源匹配 */
function normalizePluginSource(source) {
  const s = String(source || "").trim();
  // 只对看起来像本地路径的做转换：npm:/git:/协议 URL 不受影响
  if (s.startsWith("npm:") || s.startsWith("git:") || /^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  return s.replace(/\\/g, "/");
}

/**
 * 卸载一个 pi 插件（包），并从 settings.json 移除其来源。
 *
 * 本地路径的坑：installAndPersist 会把来源以**平台原生**形式（Windows 是 `D:\a\b`）
 * 写进 settings.json，而 removeSourceFromSettings 内部按正斜杠归一化后的键去匹配，
 * 反斜杠形式可能匹配不到（返回 true 却没真删）。所以：
 *   1. 先用原来源 removeAndPersist；
 *   2. 若 settings.json 里仍然存在该来源，则用正斜杠形式再试一次。
 */
async function handleRemovePlugin(id, params) {
  const pm = await ensurePackageManager();
  if (!pm) {
    sendError(id, piLoadError || "pi 未就绪，无法卸载插件");
    return;
  }
  const rawSource = String(params?.source || "").trim();
  if (!rawSource) {
    sendError(id, "缺少插件来源");
    return;
  }
  const local = Boolean(params?.local);

  /** 当前 settings 里是否还报着这个来源（两种写法都试） */
  const stillConfigured = () => {
    const norm = normalizePluginSource(rawSource);
    try {
      return pm.listConfiguredPackages().some((c) => {
        const s = String(c.source || "");
        return s === rawSource || normalizePluginSource(s) === norm;
      });
    } catch (e) {
      return false;
    }
  };

  try {
    pm.setProgressCallback(pluginProgressNotify(rawSource));
    await pm.removeAndPersist(rawSource, { local });
    // 本地路径可能需要归一化后再删一次
    if (stillConfigured()) {
      const norm = normalizePluginSource(rawSource);
      if (norm !== rawSource) {
        sendLog("info", `卸载后用归一化来源重试: ${norm}`);
        await pm.removeAndPersist(norm, { local });
      }
    }
    if (stillConfigured()) {
      sendError(id, `卸载失败：settings.json 中仍有该来源（${rawSource}）`);
      return;
    }
    const { reloaded, deferred } = await reloadAllSessions();
    sendLog("info", `插件已卸载: ${rawSource}（会话重载 ${reloaded}，待重载 ${deferred}）`);
    sendResult(id, { ok: true, source: rawSource, reloaded, deferred });
  } catch (e) {
    const raw = e?.message || String(e);
    const trimmed = raw.length > 800 ? raw.slice(0, 800) + "\n…（输出已截断）" : raw;
    sendLog("error", `插件卸载失败: ${trimmed}`);
    sendError(id, `插件卸载失败：\n${trimmed}`);
  } finally {
    try { pm.setProgressCallback(undefined); } catch (e) { /* ignore */ }
  }
}

/** 更新一个已安装的 pi 插件（npm 拉最新 / git 对齐 ref） */
async function handleUpdatePlugin(id, params) {
  const pm = await ensurePackageManager();
  if (!pm) {
    sendError(id, piLoadError || "pi 未就绪，无法更新插件");
    return;
  }
  const source = String(params?.source || "").trim() || undefined;
  try {
    pm.setProgressCallback(pluginProgressNotify(source || ""));
    await pm.update(source);
    const { reloaded, deferred } = await reloadAllSessions();
    sendLog("info", `插件已更新: ${source || "（全部）"}（会话重载 ${reloaded}，待重载 ${deferred}）`);
    sendResult(id, { ok: true, source: source || "", reloaded, deferred });
  } catch (e) {
    const raw = e?.message || String(e);
    const trimmed = raw.length > 800 ? raw.slice(0, 800) + "\n…（输出已截断）" : raw;
    sendLog("error", `插件更新失败: ${trimmed}`);
    sendError(id, `插件更新失败：\n${trimmed}`);
  } finally {
    try { pm.setProgressCallback(undefined); } catch (e) { /* ignore */ }
  }
}

/**
 * 取一个会话当前的磁盘信息（用于把「已读」标记对齐到当下内容）。
 * 拿不到（pi 未就绪 / 项目还没落盘）就返回 null，调用方退化为「只比时间戳」。
 */
async function lookupSessionInfo(projectPath, sessionId) {
  try {
    const sdk = await ensurePi();
    if (!sdk?.SessionManager?.list) return null;
    const infos = await sdk.SessionManager.list(projectPath);
    return (infos || []).find((s) => s?.id === sessionId) || null;
  } catch (e) {
    return null;
  }
}

/**
 * 标记会话「已查看」（前端打开会话时调用）。
 *
 * 项目角标口径 = 已完成未查看 + 进行中，所以用户点开一个会话就要把它
 * 从「未查看」里清掉，否则角标永远不消。
 *
 * 关键：标记时**按消息条数**记下水位（msg）。只记时间戳的话，会话在你看着的
 * 同时还在被追加写，modified 永远晚于 seenAt，“已读”秒后就失效——角标又冒出来。
 */
async function handleMarkViewed(id, params) {
  const projectPath = String(params?.projectPath || "");
  const sessionId = String(params?.sessionId || "");
  const info = await lookupSessionInfo(projectPath, sessionId);
  const msg = info && Number.isFinite(info.messageCount) ? info.messageCount : undefined;
  markViewed(projectPath, sessionId, msg);
  sendResult(id, { ok: true });
}

/**
 * 设置/清除「前端当前打开的会话」（内存态）。
 *
 * sessionFlag 对正在眼前这个会话直接判定为已读，这样刚跑完/边跑边看的那条
 * 不会因为消息条数还在涨又变回未读；用户切走后前端再调一次（带新 sessionId
 * 或不带）覆盖它。
 */
function handleSetActiveSession(id, params) {
  const projectPath = String(params?.projectPath || "");
  const sessionId = String(params?.sessionId || "");
  activeView = projectPath && sessionId ? { projectPath, sessionId } : null;
  sendResult(id, { ok: true });
}

/**
 * 把一个项目下**所有**会话标记为「已查看」（前端右键项目 → 全部标为已读）。
 *
 * 做法：从磁盘列出该项目全部会话，把它们逐个写进 seen 表（时间取「此刻」、
 * 消息条数取当前值），保证任何一条都判定为已读。
 * 与 ensureSeenBaseline 不同：这里**无条件覆盖**已记水位，哪怕之前更早——因为
 * 用户点「全部已读」就是要现在把它们全部消掉。
 */
async function handleMarkAllViewed(id, params) {
  const projectPath = String(params?.projectPath || "");
  if (!projectPath) { sendResult(id, { ok: false, marked: 0 }); return; }
  let marked = 0;
  try {
    const sdk = await ensurePi();
    if (sdk?.SessionManager?.list) {
      const infos = await sdk.SessionManager.list(projectPath);
      const now = new Date().toISOString();
      const seen = loadSeen();
      for (const s of infos || []) {
        if (!s?.id) continue;
        // 时间取「此刻」（>= 任何已有 modified）、消息条数取当前值：
        // 无论后续按时间戳还是按消息数判定，都判为已读。
        const msg = Number.isFinite(s.messageCount) ? s.messageCount : null;
        seen.set(seenKey(projectPath, s.id), { at: now, msg });
        marked++;
      }
      saveSeen();
      // 草稿不在磁盘上，单独标已读（否则“全部已读”后它又顶着角标）
      const draft = drafts.get(projectPath);
      if (draft) readDrafts.add(`${projectPath}::${draft.sessionId}`);
    }
  } catch (e) {
    sendLog("warn", `全部标为已读失败: ${e.message}`);
  }
  sendResult(id, { ok: true, marked });
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

    // 找可用的包管理器（探测也很短，但一律用异步 spawn——见下方注释）
    const managers = [
      { cmd: "npm", label: "npm" },
      { cmd: "pnpm", label: "pnpm" },
      { cmd: "yarn", label: "yarn" },
    ];
    let chosen = null;
    for (const m of managers) {
      const r = await runCommand(m.cmd, ["--version"], 5000, null);
      if (r.ok) { chosen = m; break; }
    }
    if (!chosen) {
      sendError(id, "未找到 npm/pnpm/yarn，请先安装 Node.js（https://nodejs.org）后再安装 pi");
      return;
    }

    sendLog("info", `使用 ${chosen.label} 安装 @earendil-works/pi-coding-agent…`);
    sendNotification("plugin:progress", {
      source: "installPi",
      action: chosen.cmd,
      type: "start",
      message: `正在用 ${chosen.label} 安装 pi（最长 2 分钟）…`,
    });

    // 用**异步 spawn** 而非 execSync：execSync 会把后端事件循环整个阻塞几十秒
    // 到 2 分钟——期间所有其它 RPC（含正在流式输出的 chat）全部无响应，用户看到
    // 的就是「点安装后插件卡死」。改成异步后，输出逐行推给前端，事件循环保持可用。
    const r = await runCommand(
      chosen.cmd,
      ["install", "-g", "@earendil-works/pi-coding-agent"],
      120000,
      (line) => sendLog("info", `[${chosen.label}] ${line}`),
    );
    if (!r.ok) {
      const raw = r.output || r.error || "未知错误";
      const trimmed = raw.length > 500 ? raw.slice(0, 500) + "\n…（输出已截断）" : raw;
      sendLog("error", `pi 安装失败: ${trimmed}`);
      sendError(id, `pi 安装失败：\n${trimmed}`);
      return;
    }

    sendLog("info", "pi 安装成功，正在重新加载…");

    // 安装完成后重置 pi 状态以重新加载
    pi = null;
    piLoadError = "";
    modelRegistry = null;
    modelRuntime = null;
    packageManager = null;

    // 尝试重新加载 pi SDK
    try {
      const sdk = await ensurePi();
      if (sdk) {
        await ensureModelRegistry();
        sendResult(id, { ok: true, hasPi: true, message: "pi 安装并加载成功" });
      } else {
        sendResult(id, { ok: true, hasPi: false, piError: piLoadError || "安装完成但加载失败，请尝试重启应用" });
      }
    } catch (e) {
      sendResult(id, { ok: false, hasPi: false, piError: `安装完成但加载失败: ${e.message}` });
    }
  }

/**
 * 异步执行一个外部命令，返回 { ok, output, error }。
 *
 * 用 spawn 而不是 execSync：不阻塞事件循环，且可把 stdout/stderr 逐行回调出去
 * （长任务进度可见）。超时到点连带杀掉子进程。
 */
function runCommand(cmd, args, timeoutMs, onLine) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch (e) {
      resolve({ ok: false, error: e.message });
      return;
    }
    let out = "";
    const collect = (buf) => {
      const text = String(buf);
      out += text;
      if (out.length > 200000) out = out.slice(-100000); // 防御：输出过大时只留尾部
      if (onLine) {
        for (const line of text.split("\n")) {
          const t = line.trim();
          if (t) onLine(t);
        }
      }
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) { /* ignore */ }
      resolve({ ok: false, output: out, error: `命令超时（${timeoutMs}ms）` });
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, output: out, error: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: out, error: code === 0 ? "" : `退出码 ${code}` });
    });
  });
}

// ===================== 方法派发 =====================

async function handleRequest(id, method, params) {
  switch (method) {
    case "init":
      pluginId = params?.pluginId || pluginId;
      dataDir = params?.dataDir || dataDir;
      await ensureModelRegistry();
      // 监听用户级 settings.json：外部（pi CLI / 手改）换插件后也自动让会话生效
      startSettingsWatch();
      sendLog("info", `初始化完成 (${pluginId}) agentDir=${agentDir || "(未加载)"}`);
      sendResult(id, { ok: true, hasPi: Boolean(modelRegistry), piError: piLoadError || undefined });
      break;

    case "listModels": await handleListModels(id); break;
    case "listProjects": await handleListProjects(id); break;
    case "addProject": handleAddProject(id, params); break;
    case "removeProject": handleRemoveProject(id, params); break;
    case "listSessions": await handleListSessions(id, params); break;
    case "getSessionStatus": await handleGetSessionStatus(id, params); break;
    case "createSession": await handleCreateSession(id, params); break;
    case "loadSession": await handleLoadSession(id, params); break;
    case "chat": await handleChat(id, params); break;
    case "editUserMessage": await handleEditUserMessage(id, params); break;
    case "setConfig": handleSetConfig(id, params); break;
    case "getConfig": handleGetConfig(id); break;
    case "listProviders": await handleListProviders(id); break;
    case "saveProvider": await handleSaveProvider(id, params); break;
    case "deleteProvider": await handleDeleteProvider(id, params); break;
    case "listPlugins": await handleListPlugins(id); break;
    case "installPlugin": await handleInstallPlugin(id, params); break;
    case "removePlugin": await handleRemovePlugin(id, params); break;
    case "updatePlugin": await handleUpdatePlugin(id, params); break;
    case "reloadSessions": {
      // 手动让所有活着的会话重载扩展（排查用；安装/卸载/更新已自动调用）
      const stat = await reloadAllSessions();
      sendResult(id, { ok: true, ...stat });
      break;
    }
    case "extUiRespond": {
      // 前端回传某个扩展 UI 请求的结果
      handleExtUiRespond(params?.id, params?.value);
      sendResult(id, { ok: true });
      break;
    }
    case "askAnswer": {
      // 前端原生问答卡片提交：把答案交给等待中的 ask 工具。
      // 找不到等待中的 ask 时（比如自定义界面用别的路径）交给前端自己决定后续。
      const rec = findRecByPendingAsk(params?.toolCallId);
      const handled = rec ? resolvePendingAsk(rec, params?.answers) : false;
      sendResult(id, { ok: true, handled });
      break;
    }
    case "askCancel": {
      // 用户取消问答：以 cancelled 结束等待中的 ask，不让它永久挂起
      const rec = findRecByPendingAsk(params?.toolCallId);
      let ok = false;
      if (rec?.pendingAsk) {
        rec.pendingAsk.answered = true;
        rec.pendingAsk.settle({ cancelled: true });
        ok = true;
      }
      sendResult(id, { ok });
      break;
    }
    case "extUiCancel": {
      cancelExtUi(params?.id);
      sendResult(id, { ok: true });
      break;
    }
    case "getPendingAsk": {
      // 前端切回某个会话时问「这里还有没有没回答的 ask」：有就重建卡片，没有就什么都不挂。
      // 前端内存账本（pendingAskBySession）只是缓存，插件重挂 / 错过 chat:ask 通知时
      // 就只能靠这里兜底，所以它是恢复卡片的权威来源。
      const rec = findRuntimeBySessionId(params?.projectPath, params?.sessionId);
      const pending = rec?.pendingAsk;
      sendResult(id, {
        pendingAsk: pending && !pending.answered
          ? {
              toolCallId: pending.toolCallId || "",
              questions: pending.questions || [],
              createdAt: pending.createdAt || 0,
            }          : null,
      });
      break;
    }
    case "getAskCounts": {
      // 黄问号角标专用的轻量查询：只读内存，不扫磁盘（对比 listProjects 的全量扫描）。
      // 前端在 chat:ask / chat:ask-cleared 时调它，跨项目的黄问号才能「即时」亮起/消失。
      const counts = {};
      for (const [projectPath, n] of computeAskCountsByProject()) counts[projectPath] = n;
      sendResult(id, { counts });
      break;
    }
case "markViewed": await handleMarkViewed(id, params); break;
    case "setActiveSession": handleSetActiveSession(id, params); break;
    case "markAllViewed": await handleMarkAllViewed(id, params); break;
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
          clearPendingAsk(rec); // 停止时释放等待中的问答，避免卡片悬空
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

/**
 * 优雅停止所有会话：**先 abort 再 dispose**。
 *
 * 直接 dispose 一个正在跑（流式输出 / 工具执行 / 压缩）的会话，会把底层 agent
 * 连同正在进行的请求一起硬拆——扩展 runner、工具进程可能来不及收尾。这里先
 * 逐个 `abort()`（失败也无妨），再 unsubscribe + dispose，最后清空表。
 */
async function shutdownAllSessions() {
  for (const rec of runtimes.values()) {
    try { rec.running = false; } catch (e) { /* ignore */ }
    try { clearPendingAsk(rec); } catch (e) { /* ignore */ }
    try { await rec.session?.abort?.(); } catch (e) { /* ignore */ }
    try { rec.unsubscribe?.(); } catch (e) { /* ignore */ }
    try { rec.session?.dispose?.(); } catch (e) { /* ignore */ }
  }
  runtimes.clear();
  drafts.clear();
  pendingReload.clear();
}

/**
 * 输入分帧：**按 `\n` 手工切分**，不用 `readline`。
 *
 * 为什么不用 readline：它把 U+2028/U+2029（LS/PS）也当成行分隔符，而
 * `JSON.stringify` 并不会转义它们——当用户消息、文件路径或模型输出里含这两个
 * 字符时，一条合法 JSON 会被 readline 从中间切断成两条非法 JSON，报文丢失。
 * 手工只认 `\n`，与 `JSON.stringify` 的转义规则一致。UTF-8 用 StringDecoder
 * 缓冲，避免多字节字符被 chunk 边界切断。
 */
const { StringDecoder } = require("node:string_decoder");
const stdinDecoder = new StringDecoder("utf8");
/** 输入单行上限（字符数）：畸形的超长行直接丢弃，避免内存无限增长 */
const MAX_INPUT_LINE_CHARS = 8 * 1024 * 1024;
let inputBuf = "";
let inputDropping = false;

function dispatchLine(line) {
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
    onDeactivate();
  } else if (method === "extUiRespond" || method === "ext_ui:respond") {
    // 兼容前端以“无 id 通知”形式回传 UI 结果
    handleExtUiRespond(params?.id, params?.value);
  } else if (method === "extUiCancel" || method === "ext_ui:cancel") {
    cancelExtUi(params?.id);
  }
}

/** 收到 deactivate：优雅收尾（先 abort 再 dispose）后退出；重复调用幂等 */
let shuttingDown = false;
function onDeactivate() {
  if (shuttingDown) return;
  shuttingDown = true;
  sendLog("info", "正在退出...");
  shutdownAllSessions()
    .catch((e) => sendLog("warn", `退出前清理会话失败: ${e.message}`))
    .finally(() => setTimeout(() => process.exit(0), 100));
}

process.stdin.on("data", (chunk) => {
  inputBuf += stdinDecoder.write(chunk);
  let idx;
  while ((idx = inputBuf.indexOf("\n")) >= 0) {
    const line = inputBuf.slice(0, idx);
    inputBuf = inputBuf.slice(idx + 1);
    if (inputDropping) { inputDropping = false; continue; } // 超长行剩下的尾巴，整行丢弃
    if (line.length > MAX_INPUT_LINE_CHARS) {
      sendLog("error", `输入单行超过 ${MAX_INPUT_LINE_CHARS} 字符，已丢弃`);
      continue;
    }
    dispatchLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  }
  // 还没有换行、且缓冲已超限：丢弃直到下一个换行，避免无换行巨串吃内存
  if (!inputDropping && inputBuf.length > MAX_INPUT_LINE_CHARS) {
    sendLog("error", `输入单行超过 ${MAX_INPUT_LINE_CHARS} 字符，丢弃该行剩余内容`);
    inputBuf = "";
    inputDropping = true;
  }
});
process.stdin.on("end", () => {
  const rest = inputBuf + stdinDecoder.end();
  inputBuf = "";
  if (rest.trim()) dispatchLine(rest);
});
process.stdin.resume();

/**
 * 进程级兜底：任何漏网异常 / 未处理拒绝都不能让后端「静默退出」。
 *
 * 之前没有这两个 handler——后端一旦有未被 try/catch 罩住的异常，Node 默认直接
 * 结束进程；前端只能干等满 callTimeoutMs（5 分钟）才看到「调用超时」，期间
 * 表现为「发送后一直转圈」。这里改为：记日志 + 通知前端，且**不退出**——绝大
 * 多数异常只影响当次调用，进程留着下次还能正常工作。
 */
process.on("uncaughtException", (e) => {
  try {
    sendLog("error", `未捕获异常（进程继续运行）: ${e?.stack || e?.message || e}`);
    sendNotification("backend:fatal", {
      kind: "uncaughtException",
      message: String(e?.message || e),
    });
  } catch (_) { /* 连日志都发不出去时只能放弃 */ }
});
process.on("unhandledRejection", (reason) => {
  try {
    sendLog("warn", `未处理的 Promise 拒绝: ${reason?.stack || reason?.message || reason}`);
    sendNotification("backend:fatal", {
      kind: "unhandledRejection",
      message: String(reason?.message || reason),
    });
  } catch (_) { /* ignore */ }
});

process.stderr.write("[pi-agent-backend] 后端已启动，等待初始化...\n");
