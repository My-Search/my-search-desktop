/**
 * 宿主级「环境变量」集中配置 —— 一份配置，多插件共用。
 *
 * 设计目标（用户诉求）：
 *   1. **统一配置**：变量的名字/值/说明在「设置 → 环境变量」里维护一次；
 *   2. **插件只见被授权的**：插件对某个变量是否有可见性，完全由注册表里的
 *      `env.read:<NAME>` 授予记录决定——**未授权的变量对插件既列不出、读不到，
 *      也不会被注入它的后台进程**（本文件的 `buildPluginEnv` 是唯一出口）。
 *
 * 值怎么到达插件：**不经插件 JS 上下文**，而是宿主在下发网关配置时把
 * 「已授权变量」交给 Rust（`GatewaySpec.env`），由 Rust 在 spawn 插件后台进程时
 * 注入为真正的进程环境变量。插件（如 pi-agent）在自己的配置里写 `$NAME` 引用即可，
 * 由它自己（或它读取的库）从进程环境解析。
 *
 * 存储：明文 localStorage（与 GitHub Token / WebDAV 密码同一级别）。
 * 这意味授权是 **consent / 使用授权层**，不是沙箱边界——插件与宿主同 window、
 * 同 localStorage（详见 README「插件系统 → 已知边界」）。因此：
 *   - 变量的值**绝不渲染进任何插件可读的 DOM**（选择器只显示名字与说明）；
 *   - 所有读写收敛在本文件，「日后换 Rust 侧钥匙串」只需改这一处。
 *
 * 纯逻辑 + localStorage，可被 Node 测试直接 import（见 test/env-store.test.mjs）。
 */

// 显式带 .ts 后缀：本模块被 Node 测试直接 import（见 test/env-store.test.mjs），
// 而 Node 的 ESM 解析器不做扩展名补全。
import { storageGet, storageSet } from "../util.ts";

/** 存储键（与既有缓存键命名风格一致：大写下划线 + _CACHE_KEY） */
export const ENV_VARS_KEY = "ENV_VARS_CACHE_KEY";

/** 环境变量名（POSIX 风格；与清单 backend.env 的键校验保持一致） */
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 宿主保留前缀：宿主在 spawn 插件后台进程时会设置 `MS_PLUGIN_*`（协议、身份、
 * 数据目录、宿主版本），且**宿主的取值优先**（Rust 侧后写覆盖）。因此用户若建一个
 * 叫 `MS_PLUGIN_ID` 的变量，它永远不会生效——这种「建了却不工作」的静默失效很难排查，
 * 干脆在面板上就不允许创建（校验期报错比运行期困惑好）。
 */
export const RESERVED_ENV_PREFIX = "MS_PLUGIN_";

/** 是否为宿主保留名（不可由用户创建 / 授权） */
export function isReservedEnvName(name: unknown): boolean {
  return typeof name === "string" && name.startsWith(RESERVED_ENV_PREFIX);
}

/**
 * 清单 `backend.env` 值里的「引用存储变量」语法：
 *   `$NAME` / `${NAME}`         —— 引用宿主环境变量存储里的 NAME
 *   `$env:NAME` / `$secret:NAME` —— 同上（带前缀的显式写法，$secret 为兼容旧注释的别名）
 * 引用的变量同样要过 `env.read:<NAME>` 授权，未授权时**整个键都不注入**
 * （注入空串会让插件把「未配置」误判成「配了个空值」）。
 */
const ENV_REF_RE = /^\$(?:\{(?<braced>[A-Za-z_][A-Za-z0-9_]*)\}|(?:env|secret):(?<prefixed>[A-Za-z_][A-Za-z0-9_]*)|(?<plain>[A-Za-z_][A-Za-z0-9_]*))$/;

/** 单个环境变量（用户维护的一项） */
export interface EnvVar {
  /** 变量名（=POSIX 环境变量名） */
  name: string;
  /** 变量值 */
  value: string;
  /** 用途说明（面板与选择器里给用户看，也帮插件作者理解该填什么） */
  description?: string;
  /** 是否按密钥处理（面板默认掩码显示；默认 true） */
  secret?: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 面板/选择器里显示的掩码（**固定长度**，不泄漏真实值的长度） */
export const MASKED_VALUE = "••••••••";

/** 变量名是否合法（格式正确**且**不是宿主保留名） */
export function isValidEnvName(name: unknown): boolean {
  return typeof name === "string" && ENV_NAME_RE.test(name) && !isReservedEnvName(name);
}

/** 取掩码文案（固定长度；空值显示为「（空）」） */
export function maskValue(value: unknown): string {
  const s = String(value ?? "");
  return s === "" ? "（空）" : MASKED_VALUE;
}

/** 从清单值里取出被引用的变量名（不是引用则返回 null） */
export function parseEnvRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = ENV_REF_RE.exec(value.trim());
  if (!m || !m.groups) return null;
  return m.groups.braced ?? m.groups.prefixed ?? m.groups.plain ?? null;
}

/** 生成给插件配置用的引用串（选择器选中后填入输入框的形态） */
export function envRefOf(name: string): string {
  return `$${name}`;
}

// ========== 存储读写 ==========

/** 读取全部变量（按名字排序，非法记录被丢弃） */
export function loadEnvVars(): EnvVar[] {
  const raw = storageGet<unknown>(ENV_VARS_KEY, null);
  if (!Array.isArray(raw)) return [];
  const out: EnvVar[] = [];
  for (const item of raw) {
    if (item == null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const name = String(o.name ?? "");
    if (!isValidEnvName(name)) continue;
    out.push({
      name,
      value: String(o.value ?? ""),
      description: o.description == null ? undefined : String(o.description),
      secret: o.secret == null ? true : Boolean(o.secret),
      createdAt: Number(o.createdAt) || 0,
      updatedAt: Number(o.updatedAt) || 0,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** 写入全部变量（去重 + 丢弃非法项；返回落盘后的列表） */
export function saveEnvVars(list: readonly EnvVar[]): EnvVar[] {
  const seen = new Set<string>();
  const clean: EnvVar[] = [];
  for (const v of list) {
    if (!isValidEnvName(v?.name)) continue;
    if (seen.has(v.name)) continue;
    seen.add(v.name);
    const now = Date.now();
    clean.push({
      name: v.name,
      value: String(v.value ?? ""),
      description: v.description ? String(v.description) : undefined,
      secret: v.secret == null ? true : Boolean(v.secret),
      createdAt: Number(v.createdAt) || now,
      updatedAt: Number(v.updatedAt) || now,
    });
  }
  clean.sort((a, b) => a.name.localeCompare(b.name));
  storageSet(ENV_VARS_KEY, clean);
  return clean;
}

/** 取单个变量 */
export function getEnvVar(name: string): EnvVar | undefined {
  return loadEnvVars().find((v) => v.name === name);
}

/** 新增或更新一项（返回落盘后的列表；名字非法时原样返回、不写入） */
export function upsertEnvVar(item: {
  name: string;
  value: string;
  description?: string;
  secret?: boolean;
}): EnvVar[] {
  if (!isValidEnvName(item.name)) return loadEnvVars();
  const list = loadEnvVars();
  const now = Date.now();
  const idx = list.findIndex((v) => v.name === item.name);
  if (idx >= 0) {
    list[idx] = {
      ...list[idx],
      value: String(item.value ?? ""),
      description: item.description ? String(item.description) : undefined,
      secret: item.secret == null ? list[idx].secret ?? true : Boolean(item.secret),
      updatedAt: now,
    };
  } else {
    list.push({
      name: item.name,
      value: String(item.value ?? ""),
      description: item.description ? String(item.description) : undefined,
      secret: item.secret == null ? true : Boolean(item.secret),
      createdAt: now,
      updatedAt: now,
    });
  }
  return saveEnvVars(list);
}

/** 删除一项（返回落盘后的列表） */
export function removeEnvVar(name: string): EnvVar[] {
  return saveEnvVars(loadEnvVars().filter((v) => v.name !== name));
}

// ========== 授权与注入 ==========

/** 结构化的授予记录（避免 import registry.ts 造成不必要的依赖） */
export interface GrantLike {
  permission: string;
}

/** 权限串前缀：`env.read:<变量名>` */
export const ENV_PERMISSION_BASE = "env.read";

/** 生成某变量的权限串 */
export function envPermissionOf(name: string): string {
  return `${ENV_PERMISSION_BASE}:${name}`;
}

/**
 * 取「该插件已授权可见」的变量名集合。
 * 只认 `env.read:<NAME>`（scope 全等；与 permissions.ts 的 scopeCovers 对
 * 非 URL scope「只认完全相等」一致）。
 */
export function envGrantsOf(record: { grants?: readonly GrantLike[] } | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const g of record?.grants ?? []) {
    const p = String(g?.permission ?? "");
    if (!p.startsWith(`${ENV_PERMISSION_BASE}:`)) continue;
    const name = p.slice(ENV_PERMISSION_BASE.length + 1);
    if (isValidEnvName(name)) out.add(name);
  }
  return out;
}

/**
 * 解析「引用型值」——纯函数，便于测试。
 * 规则：非引用原样返回；引用的变量未授权或不存在时返回 `null`（调用方应**丢弃该键**）。
 */
export function resolveEnvRef(
  value: string,
  granted: ReadonlySet<string>,
  lookup: (name: string) => EnvVar | undefined
): string | null {
  const name = parseEnvRef(value);
  if (!name) return value;
  if (!granted.has(name)) return null;
  const item = lookup(name);
  return item ? item.value : null;
}

/**
 * 计算「下发给某个插件后台进程的环境变量」——**本文件的唯一出口，安全关键**。
 *
 * 组成：
 *   1. 清单 `backend.env` 里的**字面量**（作者自带、不含用户密钥）——原样注入；
 *   2. 清单 `backend.env` 里的**引用**（`$NAME` 等）——仅在已授权且存在时注入；
 *   3. 该插件**已授权**（`env.read:<NAME>`）的存储变量——按变量名注入。
 *
 * 未授权或已删除的变量**不会出现在结果里**（不注入空串）。
 */
export function buildPluginEnv(
  record: {
    grants?: readonly GrantLike[];
    manifest?: { backend?: { env?: Record<string, string> } };
  } | null | undefined,
  load: () => EnvVar[] = loadEnvVars
): Record<string, string> {
  const granted = envGrantsOf(record);
  const all = load();
  const byName = new Map(all.map((v) => [v.name, v]));
  const lookup = (name: string): EnvVar | undefined => byName.get(name);
  const out: Record<string, string> = {};

  // 1 + 2：清单声明
  const declared = record?.manifest?.backend?.env;
  if (declared && typeof declared === "object") {
    for (const [key, raw] of Object.entries(declared)) {
      const resolved = resolveEnvRef(String(raw ?? ""), granted, lookup);
      if (resolved == null) continue; // 未授权/不存在/空 → 整键丢弃
      out[key] = resolved;
    }
  }

  // 3：已授权的存储变量（按变量名注入，供插件直接引用 process.env.NAME）
  for (const name of granted) {
    const item = lookup(name);
    if (item) out[name] = item.value;
  }

  return out;
}

/** 清单里请求的引用型变量名（供插件面板显示「待授权」项） */
export function requestedEnvRefs(record: {
  manifest?: { backend?: { env?: Record<string, string> } };
} | null | undefined): string[] {
  const declared = record?.manifest?.backend?.env;
  if (!declared || typeof declared !== "object") return [];
  const out = new Set<string>();
  for (const raw of Object.values(declared)) {
    const name = parseEnvRef(raw);
    if (name) out.add(name);
  }
  return [...out].sort();
}
