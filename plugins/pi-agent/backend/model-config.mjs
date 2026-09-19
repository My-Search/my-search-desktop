/**
 * pi models.json 的读写 / 校验 / 拆解（纯函数，不做 JSON-RPC）。
 *
 * 这里操作的是 **pi 官方的** `~/.pi/agent/models.json`（`ModelConfig.load()` 读的
 * 同一个文件），不是插件私有的第二份配置——设置面板里改完，终端里的 `pi /model`
 * 立刻就能看到，两边永远一致。
 *
 * 三条硬约束（都会被测试盯住）：
 *   1. **只碰 providers 字段**：文件里其它键（pi 未来新增的顶层配置）原样保留；
 *   2. **未知字段原样往返**：模型/提供商上我们不认识的字段（compat、thinkingLevelMap、
 *      cost……）收进 `advanced` 交给前端折叠编辑，保存时合并回去，绝不静默丢弃；
 *   3. **写前备份**：JSON 注释（pi 支持 JSONC）重写后会丢，所以首次覆盖前复制一份
 *      `models.json.bak`，用户至少能找回原文。
 */

import fs from "node:fs";
import path from "node:path";

/** pi 支持的 API 类型（docs/models.md「Supported APIs」） */
export const SUPPORTED_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
];

/** 前端表单直接编辑的提供商字段，其余进 advanced */
const PROVIDER_KNOWN_KEYS = ["name", "baseUrl", "api", "apiKey", "models"];

/** 前端表单直接编辑的模型字段，其余进 advanced */
const MODEL_KNOWN_KEYS = [
  "id",
  "name",
  "api",
  "reasoning",
  "input",
  "contextWindow",
  "maxTokens",
];

const PROVIDER_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * 读取 models.json。
 *
 * 失败不抛异常而是返回 `error`：设置面板要**展示**问题（好让用户去修），
 * 而不是整个面板打不开。
 */
export function loadModelsFile(modelsPath) {
  if (!modelsPath || !fs.existsSync(modelsPath)) {
    return { data: { providers: {} }, exists: false, error: "" };
  }
  let raw;
  try {
    raw = fs.readFileSync(modelsPath, "utf8");
  } catch (e) {
    return { data: { providers: {} }, exists: true, error: `读取 models.json 失败: ${e.message}` };
  }
  try {
    const parsed = JSON.parse(stripJsonComments(stripBom(raw)));
    if (!isPlainObject(parsed)) throw new Error("顶层不是对象");
    if (!isPlainObject(parsed.providers)) parsed.providers = {};
    return { data: parsed, exists: true, error: "" };
  } catch (e) {
    return { data: { providers: {} }, exists: true, error: `models.json 解析失败: ${e.message}` };
  }
}

/** pi 允许 models.json 带注释（JSONC），读取时先剥掉 */
function stripJsonComments(text) {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (c === "\n") { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") { out += text[i + 1] ?? ""; i++; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === "/" && next === "/") { inLine = true; i++; continue; }
    if (c === "/" && next === "*") { inBlock = true; i++; continue; }
    out += c;
  }
  return out;
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 写盘：先备份，再只替换 providers 字段。
 *
 * `mutate(providers)` 直接改传进去的对象；其余顶层键（含 pi 未来新增的）保持不动。
 */
function writeModelsFile(modelsPath, mutate) {
  const dir = path.dirname(modelsPath);
  fs.mkdirSync(dir, { recursive: true });

  const { data, exists, error } = loadModelsFile(modelsPath);
  if (error) {
    // 解析失败时**拒绝写入**：此刻重写会把用户原有内容整段冲掉
    throw new Error(`${error}（请先修复该文件，本次未写入任何内容）`);
  }

  const backupPath = `${modelsPath}.bak`;
  if (exists) {
    try {
      fs.copyFileSync(modelsPath, backupPath);
    } catch (e) {
      throw new Error(`备份 models.json 失败: ${e.message}`);
    }
  }

  mutate(data.providers);
  data.providers = sortProviders(data.providers);
  fs.writeFileSync(modelsPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  return { backupPath: exists ? backupPath : "" };
}

/** 提供商按键名排序，避免每次保存后文件里顺序跳来跳去 */
function sortProviders(providers) {
  const out = {};
  for (const key of Object.keys(providers).sort()) out[key] = providers[key];
  return out;
}

/** 新增/覆盖一个提供商 */
export function saveProviderToFile(modelsPath, providerId, provider) {
  return writeModelsFile(modelsPath, (providers) => {
    providers[providerId] = provider;
  });
}

/** 删除一个提供商；文件里没有它时抛错（内置提供商走不到这里） */
export function removeProviderFromFile(modelsPath, providerId) {
  const { data } = loadModelsFile(modelsPath);
  if (!Object.prototype.hasOwnProperty.call(data.providers, providerId)) {
    throw new Error(`models.json 里没有提供商「${providerId}」（内置提供商不可删除）`);
  }
  return writeModelsFile(modelsPath, (providers) => {
    delete providers[providerId];
  });
}

/** 提供商是否已存在于 models.json（用于区分「自定义」与「内置」） */
export function isCustomProvider(modelsPath, providerId) {
  const { data } = loadModelsFile(modelsPath);
  return Object.prototype.hasOwnProperty.call(data.providers, providerId);
}

/**
 * 拆出前端表单能直接编辑的字段，其余原样收进 `advanced`。
 *
 * 返回的 `known.models` 里每个模型同样带自己的 `advanced`。
 */
export function splitProvider(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const known = {};
  const advanced = {};
  for (const [k, v] of Object.entries(src)) {
    if (PROVIDER_KNOWN_KEYS.includes(k)) known[k] = v;
    else advanced[k] = v;
  }
  return {
    name: known.name ?? "",
    baseUrl: known.baseUrl ?? "",
    api: known.api ?? "",
    apiKey: known.apiKey ?? "",
    models: Array.isArray(known.models) ? known.models.map(splitModel) : [],
    advanced,
  };
}

/** 同上，针对单个模型 */
export function splitModel(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const known = {};
  const advanced = {};
  for (const [k, v] of Object.entries(src)) {
    if (MODEL_KNOWN_KEYS.includes(k)) known[k] = v;
    else advanced[k] = v;
  }
  return {
    id: known.id ?? "",
    name: known.name ?? "",
    api: known.api ?? "",
    reasoning: known.reasoning === true,
    input: Array.isArray(known.input) ? known.input : [],
    contextWindow: typeof known.contextWindow === "number" ? known.contextWindow : undefined,
    maxTokens: typeof known.maxTokens === "number" ? known.maxTokens : undefined,
    advanced,
  };
}

/**
 * 校验并规范化一个提供商（前端表单 → models.json 里的对象）。
 *
 * 校验失败抛中文 Error（后端会转成 `插件返回错误: …` 直接显示在面板上）。
 * 空值一律**省略**而不是写成 `""`：pi 的 schema 对可选字段不接受空串。
 */
export function validateProvider(providerId, provider) {
  const id = String(providerId || "").trim();
  if (!PROVIDER_ID_RE.test(id)) {
    throw new Error("提供商 ID 只能包含字母、数字、点、下划线和短横线（1-64 位）");
  }

  if (!isPlainObject(provider)) throw new Error("提供商配置必须是对象");

  const models = Array.isArray(provider.models) ? provider.models : [];
  const out = {};

  const name = String(provider.name ?? "").trim();
  if (name) out.name = name;

  const baseUrl = String(provider.baseUrl ?? "").trim();
  if (baseUrl) {
    let parsed;
    try { parsed = new URL(baseUrl); } catch (e) { parsed = null; }
    if (!parsed || !/^https?:$/.test(parsed.protocol)) {
      throw new Error("Base URL 必须是 http/https 开头的完整地址");
    }
    out.baseUrl = baseUrl;
  }

  const api = String(provider.api ?? "").trim();
  if (api) {
    if (!SUPPORTED_APIS.includes(api)) {
      throw new Error(`API 类型只能是：${SUPPORTED_APIS.join(" / ")}`);
    }
    out.api = api;
  }

  const apiKey = provider.apiKey;
  if (typeof apiKey === "string" && apiKey.trim()) out.apiKey = apiKey.trim();
  else if (isPlainObject(apiKey)) out.apiKey = apiKey;   // pi 也接受对象形式

  // 有模型就必须能连上：baseUrl 与 api 二选一缺失都会被 pi 拒绝加载整个文件，
  // 因此在写盘前就拦下来（错误提示直接告诉用户缺什么）。
  if (models.length > 0) {
    if (!out.baseUrl) throw new Error("有模型时必须填写 Base URL");
    if (!out.api && !models.every((m) => String(m?.api ?? "").trim())) {
      throw new Error("有模型时必须选择 API 类型（或在每个模型上单独指定）");
    }
  }

  const seen = new Set();
  out.models = models.map((m, i) => {
    const model = validateModel(m, i, out.api);
    if (seen.has(model.id)) throw new Error(`模型 ID 重复: ${model.id}`);
    seen.add(model.id);
    return model;
  });

  // advanced 合并回去；空对象不写
  const advanced = isPlainObject(provider.advanced) ? provider.advanced : {};
  for (const [k, v] of Object.entries(advanced)) {
    if (k === "advanced") continue;
    if (PROVIDER_KNOWN_KEYS.includes(k)) continue;   // 表单字段优先
    if (v === undefined) continue;
    if ((k === "headers" || k === "compat" || k === "modelOverrides") && !isPlainObject(v)) {
      throw new Error(`高级字段 ${k} 必须是 JSON 对象`);
    }
    out[k] = v;
  }

  return { id, provider: out };
}

/** 单个模型的校验 + 规范化 */
function validateModel(raw, index, providerApi) {
  if (!isPlainObject(raw)) throw new Error(`第 ${index + 1} 个模型不是对象`);
  const id = String(raw.id ?? "").trim();
  if (!id) throw new Error(`第 ${index + 1} 个模型缺少 ID`);

  const out = { id };

  const name = String(raw.name ?? "").trim();
  if (name) out.name = name;

  const api = String(raw.api ?? "").trim();
  if (api) {
    if (!SUPPORTED_APIS.includes(api)) {
      throw new Error(`模型 ${id} 的 API 类型非法: ${api}`);
    }
    out.api = api;
  } else if (!providerApi) {
    throw new Error(`模型 ${id} 未指定 API，且提供商也没有默认 API`);
  }

  if (raw.reasoning === true) out.reasoning = true;
  if (Array.isArray(raw.input) && raw.input.length > 0) {
    const input = raw.input.filter((v) => v === "text" || v === "image");
    if (input.length === 0) throw new Error(`模型 ${id} 的输入类型只能是 text / image`);
    out.input = input;
  }

  for (const key of ["contextWindow", "maxTokens"]) {
    const v = raw[key];
    if (v === undefined || v === null || v === "") continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`模型 ${id} 的 ${key} 必须是正数`);
    out[key] = Math.floor(n);
  }

  const advanced = isPlainObject(raw.advanced) ? raw.advanced : {};
  for (const [k, v] of Object.entries(advanced)) {
    if (k === "advanced") continue;
    if (MODEL_KNOWN_KEYS.includes(k)) continue;
    if (v === undefined) continue;
    if ((k === "compat" || k === "samplingParams" || k === "cost" || k === "thinkingLevelMap" || k === "headers") && !isPlainObject(v)) {
      throw new Error(`模型 ${id} 的高级字段 ${k} 必须是 JSON 对象`);
    }
    out[k] = v;
  }

  return out;
}

/**
 * 把 models.json 里的原始提供商整理成前端要的形状。
 *
 * `availability` 是「provider:modelId → 是否可用」的集合（来自 pi 的 registry），
 * 用来在列表里标「已配置密钥」。没有 registry 时传空集合即可。
 */
export function describeProvider(providerId, raw, { availability = new Set(), auth = null } = {}) {
  const split = splitProvider(raw);
  return {
    id: providerId,
    name: split.name,
    baseUrl: split.baseUrl,
    api: split.api,
    hasApiKey: Boolean(split.apiKey),
    models: split.models.map((m) => ({
      ...m,
      available: availability.has(`${providerId}:${m.id}`),
    })),
    advanced: split.advanced,
    builtin: false,
    authConfigured: Boolean(auth?.configured),
    authSource: auth?.source || "",
  };
}

/** pi 自带的提供商（只读展示用） */
export function describeBuiltinProvider(providerId, { name, models = [], availability = new Set(), auth = null } = {}) {
  const availableModels = models.filter((m) => availability.has(`${providerId}:${m.id}`));
  return {
    id: providerId,
    name: name || providerId,
    modelCount: models.length,
    availableCount: availableModels.length,
    sampleModels: availableModels.slice(0, 20).map((m) => m.name || m.id),
    builtin: true,
    authConfigured: Boolean(auth?.configured),
    authSource: auth?.source || "",
  };
}
