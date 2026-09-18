/**
 * 插件权限模型（Android 式：安装时声明、首次使用时分次授予、设置里统一撤销）。
 *
 * 三层结构：
 *   1. **权限目录（本文件）**：宿主支持哪些权限、风险等级、是否需要 scope、属于哪个分组。
 *   2. **清单声明**：插件在 plugin.json 里写「我需要哪些」——这只是**请求**。
 *   3. **授予记录**：存在插件注册表里的 `granted` 数组——这才是**唯一生效的依据**，
 *      网关鉴权只看它，且只有用户能在安装确认 / 权限弹窗 / 设置面板里改动。
 *
 * 与 Tauri capabilities 的关系：Tauri 的 capability 是**编译期静态**的，无法做到
 * 「每个插件一套权限」，所以插件权限一律走运行时的宿主网关（plugin_host_call），
 * 本文件就是网关的判定函数来源（Rust 侧只做「已授予」的最终拦截）。
 *
 * 纯函数，便于单测。
 */

/** 权限分组（面板上按分组聚合展示，与 Android 的「权限组」同构） */
export type PermissionGroup = "search" | "ui" | "data" | "network" | "device" | "danger";

/** 风险等级（决定确认弹窗的措辞与是否需要二次确认） */
export type PermissionRisk = "low" | "medium" | "high" | "critical";

/** 权限作用域：前端可见 / 后端可用 / 两者皆可 */
export type PermissionRuntime = "frontend" | "backend" | "both";

export interface PermissionSpec {
  /** 基础 id，如 "net.fetch" */
  id: string;
  group: PermissionGroup;
  title: string;
  desc: string;
  risk: PermissionRisk;
  /** 是否需要 scope（冒号后的部分），如 net.fetch:https://api.x.com/* */
  scoped?: boolean;
  runtime: PermissionRuntime;
  /** 撤销该权限后，宿主必须执行的动作说明（面板上给用户看） */
  revokeImpact?: string;
}

/** 分组的中文标题（面板小节标题） */
export const PERMISSION_GROUP_TITLES: Record<PermissionGroup, string> = {
  search: "搜索",
  ui: "界面",
  data: "数据与存储",
  network: "网络",
  device: "系统与设备",
  danger: "高风险能力",
};

/** 插件权限目录（v1）。新增权限必须同时更新本表与 Rust 侧网关白名单。 */
export const PERMISSION_CATALOG: readonly PermissionSpec[] = [
  {
    id: "search.read",
    group: "search",
    title: "读取搜索数据",
    desc: "读取订阅数据项与搜索结果（只读副本，不能修改宿主数据）",
    risk: "medium",
    runtime: "both",
    revokeImpact: "插件将无法取得任何检索结果",
  },
  {
    id: "search.write",
    group: "search",
    title: "提供搜索结果",
    desc: "向结果列表贡献条目、触发搜索、改写搜索框内容",
    risk: "medium",
    runtime: "both",
    revokeImpact: "插件贡献的搜索项会从结果里消失",
  },
  {
    id: "ui.inlay",
    group: "ui",
    title: "内嵌界面",
    desc: "在搜索详情区渲染自定义视图（与现有 [脚本] 数据项同一位置）",
    risk: "medium",
    runtime: "frontend",
    revokeImpact: "插件的应用界面不再可打开",
  },
  {
    id: "ui.window",
    group: "ui",
    title: "独立窗口",
    desc: "打开插件自己的窗口",
    risk: "medium",
    runtime: "frontend",
    revokeImpact: "插件无法再打开独立窗口",
  },
  {
    id: "ui.command",
    group: "ui",
    title: "注册命令",
    desc: "注册搜索框关键词（如「问AI : 」）直接唤起插件",
    risk: "low",
    runtime: "both",
    revokeImpact: "插件的关键词会失效",
  },
  {
    id: "ui.notify",
    group: "ui",
    title: "显示提示",
    desc: "显示应用内提示与确认弹窗",
    risk: "low",
    runtime: "both",
    revokeImpact: "插件无法再主动提示",
  },
  {
    id: "store",
    group: "data",
    title: "插件数据存储",
    desc: "读写插件自己的键值数据（独立目录，访问不到宿主存储）",
    risk: "low",
    runtime: "both",
    revokeImpact: "插件的设置与本地数据将被清空",
  },
  {
    id: "clipboard.write",
    group: "device",
    title: "写入剪贴板",
    desc: "把内容复制到系统剪贴板",
    risk: "low",
    runtime: "both",
  },
  {
    id: "clipboard.read",
    group: "device",
    title: "读取剪贴板",
    desc: "读取剪贴板内容（可能包含密码等敏感信息）",
    risk: "high",
    runtime: "both",
    revokeImpact: "依赖剪贴板的功能会失效",
  },
  {
    id: "selection.read",
    group: "device",
    title: "读取选中文本",
    desc: "读取你在其它应用里选中的文字（会临时隐藏搜索窗）",
    risk: "high",
    runtime: "both",
  },
  {
    id: "net.fetch",
    group: "network",
    title: "网络访问",
    desc: "经宿主代理由插件发起网络请求，仅限声明的域名",
    risk: "high",
    scoped: true,
    runtime: "both",
    revokeImpact: "插件的联网功能会失效",
  },
  {
    id: "system.openExternal",
    group: "device",
    title: "打开外部链接",
    desc: "用系统默认程序打开链接（请确认目标可信）",
    risk: "medium",
    runtime: "both",
  },
  {
    id: "backend.spawn",
    group: "danger",
    title: "运行本机程序",
    desc: "在后台运行插件自带的可执行文件——等同于安装并运行一个本机软件，请仅安装可信来源的插件",
    risk: "critical",
    runtime: "backend",
    revokeImpact: "后台进程会被立即停止且不再启动",
  },
  {
    id: "secret.read",
    group: "danger",
    title: "读取密钥",
    desc: "读取保存在系统钥匙串里的密钥（如 API Key），用于代替明文配置",
    risk: "critical",
    scoped: true,
    runtime: "backend",
  },
  {
    id: "plugin.install",
    group: "danger",
    title: "安装与更新插件",
    desc: "允许管理插件：从插件市场安装、升级、卸载插件（仅限已验证目录来源）。装上的插件还可能申请其它权限，请仅授权可信的插件使用此能力",
    risk: "critical",
    runtime: "frontend",
    revokeImpact: "插件将无法在市场安装、更新或卸载任何插件",
  },
] as const;

/** 权限目录索引（按基础 id） */
const CATALOG_BY_ID = new Map(PERMISSION_CATALOG.map((p) => [p.id, p]));

/** 取基础 id（去掉 scope）："net.fetch:https://a.com/*" -> "net.fetch" */
export function permissionBaseId(raw: string): string {
  const idx = raw.indexOf(":");
  return idx < 0 ? raw.trim() : raw.slice(0, idx).trim();
}

/** 取 scope：无 scope 返回 null */
export function permissionScope(raw: string): string | null {
  const idx = raw.indexOf(":");
  if (idx < 0) return null;
  return raw.slice(idx + 1).trim() || null;
}

/** 该权限串是否被宿主支持（含 scope 语法与必填 scope 校验） */
export function isKnownPermission(raw: string): boolean {
  const base = permissionBaseId(raw);
  const spec = CATALOG_BY_ID.get(base);
  if (!spec) return false;
  const scope = permissionScope(raw);
  if (spec.scoped && !scope) return false;
  if (!spec.scoped && scope) return false;
  if (scope && !isValidScopePattern(scope)) return false;
  return true;
}

/** 取权限规格 */
export function getPermissionSpec(raw: string): PermissionSpec | undefined {
  return CATALOG_BY_ID.get(permissionBaseId(raw));
}

/**
 * scope 模式校验：允许
 *   - "*"（全部，仅 debug/官方插件应使用，面板会标红）
 *   - "https://api.openai.com/*"
 *   - "https://*.openai.com/*"
 *   - localhost 带端口（需显式声明，如 `localhost:8080/*`）
 */
export function isValidScopePattern(scope: string): boolean {
  if (scope === "*") return true;
  if (scope.startsWith("https://") || scope.startsWith("http://")) {
    const rest = scope.slice(scope.indexOf("://") + 3);
    const host = rest.split("/")[0];
    if (host.length === 0) return false;
    // 只允许通配在最左一段（*.openai.com）或整体（*）
    if (host.startsWith("*.")) return host.slice(2).length > 0;
    return !host.includes("*");
  }
  // 非 http(s) 的 scope（如密钥名）只要求非空、无空格
  return /^[^\s:*]+$/.test(scope);
}

/**
 * 判断一个「已授予的权限串」是否覆盖某个「被请求的权限串」。
 * 规则：
 *   - 基础 id 必须相同；
 *   - 无 scope 的权限直接覆盖（基础 id 已能决定一切）；
 *   - scope 必须能被 granted 的 scope 覆盖：`*` 覆盖一切；`https://api.a.com/*` 覆盖
 *     `https://api.a.com/v1/x`；`https://*.a.com/*` 覆盖 `https://api.a.com/*`。
 */
export function permissionCovers(granted: string, request: string): boolean {
  const gb = permissionBaseId(granted);
  const rb = permissionBaseId(request);
  if (gb !== rb) return false;
  const gs = permissionScope(granted);
  const rs = permissionScope(request);
  if (gs == null && rs == null) return true;
  if (gs == null) return false; // 授予的是无 scope 版本，覆盖不了带 scope 的请求
  if (rs == null) return false;
  return scopeCovers(gs, rs);
}

/** scope 覆盖判定（值可能是具体 URL 或另一个 scope 模式） */
export function scopeCovers(grantedScope: string, requestScope: string): boolean {
  if (grantedScope === "*") return true;
  if (grantedScope === requestScope) return true;
  if (!requestScope.startsWith("http")) {
    // 非 URL 类 scope（密钥名等）：只认完全相等或通配
    return false;
  }
  const extract = (s: string): { origin: string; path: string } => {
    const i = s.indexOf("://");
    const rest = i < 0 ? s : s.slice(i + 3);
    const slash = rest.indexOf("/");
    if (slash < 0) return { origin: rest, path: "/*" };
    return { origin: rest.slice(0, slash), path: rest.slice(slash) };
  };
  const g = extract(grantedScope);
  const r = extract(requestScope);
  // 主机覆盖
  const hostOk = g.origin === r.origin || (g.origin.startsWith("*.") && r.origin.endsWith(g.origin.slice(1)));
  if (!hostOk) return false;
  // 路径覆盖：请求路径以授予路径前缀开头（`/*` 视为全部）
  if (g.path === "/*" || g.path === "*") return true;
  const prefix = g.path.endsWith("*") ? g.path.slice(0, -1) : g.path;
  return r.path.startsWith(prefix);
}

/** 是否满足某项权限（任一授予项覆盖即可） */
export function hasPermission(granted: readonly string[], request: string): boolean {
  return granted.some((g) => permissionCovers(g, request));
}

/** 取权限分组（用于面板聚合展示） */
export function groupOf(raw: string): PermissionGroup {
  return getPermissionSpec(raw)?.group ?? "danger";
}

/** 取权限风险等级 */
export function riskOf(raw: string): PermissionRisk {
  return getPermissionSpec(raw)?.risk ?? "critical";
}

/** 权限条目（用于安装确认 / 权限面板展示） */
export interface PermissionEntry {
  /** 清单里声明的原文（含 scope） */
  raw: string;
  spec: PermissionSpec;
  scope: string | null;
}

export interface PermissionGroupBlock {
  group: PermissionGroup;
  title: string;
  /** 该组的最高风险（决定组标题的徽标） */
  risk: PermissionRisk;
  entries: PermissionEntry[];
}

const RISK_ORDER: Record<PermissionRisk, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** 取更高的风险等级 */
export function maxRisk(a: PermissionRisk, b: PermissionRisk): PermissionRisk {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

/** 风险等级文案（安装确认弹窗上直接用） */
export const RISK_LABEL: Record<PermissionRisk, string> = {
  low: "低风险",
  medium: "中风险",
  high: "高风险",
  critical: "极高风险",
};

/**
 * 把权限串数组整理成按分组聚合的展示结构（安装确认弹窗 / 权限面板共用）。
 * 未知权限不会出现在这里（清单校验阶段已拦截）。
 */
export function groupPermissions(perms: readonly string[]): PermissionGroupBlock[] {
  const blocks = new Map<PermissionGroup, PermissionEntry[]>();
  for (const raw of perms) {
    const spec = getPermissionSpec(raw);
    if (!spec) continue;
    const list = blocks.get(spec.group) ?? [];
    list.push({ raw, spec, scope: permissionScope(raw) });
    blocks.set(spec.group, list);
  }
  const order: PermissionGroup[] = ["danger", "network", "device", "search", "ui", "data"];
  return [...blocks.entries()]
    .map(([group, entries]) => ({
      group,
      title: PERMISSION_GROUP_TITLES[group],
      risk: entries.reduce<PermissionRisk>((acc, e) => maxRisk(acc, e.spec.risk), "low"),
      entries,
    }))
    .sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
}

/**
 * 安装确认弹窗的「摘要句」：模仿 Android 的「此应用将可以：」，
 * 但用人类语言总结最高风险，避免用户被权限清单淹没。
 */
export function summarizePermissions(perms: readonly string[]): string {
  if (perms.length === 0) return "该插件未请求任何权限。";
  const risks = perms.map(riskOf);
  const top = risks.reduce<PermissionRisk>((a, b) => maxRisk(a, b), "low");
  const spawn = perms.some((p) => permissionBaseId(p) === "backend.spawn");
  const parts: string[] = [];
  if (spawn) parts.push("在后台运行本机程序");
  if (perms.some((p) => permissionBaseId(p) === "search.read")) parts.push("读取你的订阅数据");
  if (perms.some((p) => permissionBaseId(p) === "net.fetch")) parts.push("访问声明的网络地址");
  if (perms.some((p) => permissionBaseId(p) === "clipboard.read")) parts.push("读取剪贴板");
  if (perms.some((p) => permissionBaseId(p) === "secret.read")) parts.push("读取系统钥匙串里的密钥");
  if (perms.some((p) => permissionBaseId(p) === "plugin.install")) parts.push("安装、更新与卸载插件");
  const desc = parts.length > 0 ? parts.join("、") : "在应用内提供功能";
  return `该插件可以${desc}。最高风险等级：${RISK_LABEL[top]}。`;
}

/**
 * 需要「二次确认」的权限：极高风险项，安装时要求用户逐条勾选确认，
 * 而不是一个「我同意」按钮带过。
 */
export function requiresExplicitConsent(raw: string): boolean {
  const spec = getPermissionSpec(raw);
  if (!spec) return true;
  if (spec.risk === "critical") return true;
  if (permissionScope(raw) === "*") return true;
  return false;
}
