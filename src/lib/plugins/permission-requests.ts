/**
 * 权限「申请 — 审批」闭环（P1-1）。
 *
 * 与既有「运行时缺权限 → 宿主直接 confirm」相比，这里补齐三件事：
 *   1. **批量申请**：插件可以一次列出它需要的几项权限并说明理由，
 *      用户在**一次**弹窗里看完（而不是每调一个 API 弹一次）；
 *   2. **只能申请清单里声明过的权限**：`plugin.json` 没写的权限不能现场讨要，
 *      否则「声明最小权限」就失去意义（恶意插件可以安装后才索要全盘读写）；
 *   3. **频率限制**：同一权限 24 小时内最多申请 3 次，之后返回 `throttled`，
 *      避免插件把用户点烦了就点同意了。
 *
 * 本模块是纯函数，便于单测；真正的弹窗与授予动作由宿主注入。
 */

import {
  getPermissionSpec,
  groupOf,
  hasPermission,
  isKnownPermission,
  permissionBaseId,
  permissionCovers,
  RISK_LABEL,
} from "./permissions.ts";
import type { PluginRecord } from "./registry.ts";

/** 同一权限的申请频率窗口 */
export const PERMISSION_REQUEST_WINDOW_MS = 24 * 60 * 60 * 1000;
/** 窗口内同一权限最多申请几次 */
export const PERMISSION_REQUEST_LIMIT = 3;
/** 一次最多申请几项权限 */
export const PERMISSION_REQUEST_MAX_APIS = 8;
/** 每插件保留的申请历史条数（面板展示用，超出丢弃最旧） */
export const PERMISSION_REQUEST_HISTORY_LIMIT = 50;

export type PermissionRequestResult = "granted" | "denied" | "throttled" | "invalid";

export interface PluginPermissionRequest {
  /** 本次申请的权限串（已去重、已校验） */
  apis: string[];
  /** 插件给出的理由（≤200 字，可为空） */
  reason: string;
  at: number;
  result: PermissionRequestResult;
  /** 宿主拒绝/限流时的可读原因（写进历史，便于用户事后核对） */
  message?: string;
}

/** 申请计划的判定结果 */
export type PermissionRequestPlan =
  | { ok: true; apis: string[]; already: string[] }
  | { ok: false; reason: "empty" | "tooMany" | "unknown" | "undeclared" | "throttled"; message: string; throttled?: string[] };

/** 把申请串归一化：去空白、去重（保留顺序） */
function normalizeApis(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const p = v.trim();
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/** 清单是否声明过该权限（声明可带 scope，用 permissionCovers 判断覆盖） */
function declaredByManifest(record: PluginRecord, permission: string): boolean {
  const declared = [
    ...(record.manifest.permissions ?? []),
    ...(record.manifest.optionalPermissions ?? []),
  ];
  return declared.some((d) => permissionCovers(d, permission));
}

/** 窗口内该权限已被申请过几次 */
export function countRecentRequests(
  record: PluginRecord,
  permission: string,
  now: number
): number {
  const list = record.permissionRequests ?? [];
  return list.filter(
    (r) =>
      now - r.at < PERMISSION_REQUEST_WINDOW_MS &&
      r.result !== "granted" &&
      r.apis.some((p) => permissionBaseId(p) === permissionBaseId(permission))
  ).length;
}

/**
 * 判定这次申请能不能弹窗（不改变任何状态）。
 *
 * - `empty`：没有有效权限串；
 * - `tooMany`：超过 8 项（要求插件分批申请，别一次糊用户一脸）；
 * - `unknown`：不在权限目录里（拼错 / 未实现的权限）；
 * - `undeclared`：清单没声明（安装后临时扩权，一律拒绝）；
 * - `throttled`：24h 内同一权限已申请 3 次。
 */
export function planPermissionRequest(
  record: PluginRecord,
  rawApis: unknown,
  now = Date.now()
): PermissionRequestPlan {
  const apis = normalizeApis(rawApis);
  if (apis.length === 0) {
    return { ok: false, reason: "empty", message: "没有要申请的权限" };
  }
  if (apis.length > PERMISSION_REQUEST_MAX_APIS) {
    return {
      ok: false,
      reason: "tooMany",
      message: `一次最多申请 ${PERMISSION_REQUEST_MAX_APIS} 项权限（本次 ${apis.length} 项）`,
    };
  }
  const unknown = apis.filter((p) => !isKnownPermission(p) || p === "*");
  if (unknown.length > 0) {
    return {
      ok: false,
      reason: "unknown",
      message: `未知权限：${unknown.join("、")}`,
    };
  }
  const undeclared = apis.filter((p) => !declaredByManifest(record, p));
  if (undeclared.length > 0) {
    return {
      ok: false,
      reason: "undeclared",
      message: `清单未声明这些权限，不能现场申请：${undeclared.join("、")}`,
    };
  }
  const granted = record.grants.map((g) => g.permission);
  const already = apis.filter((p) => hasPermission(granted, p));
  const missing = apis.filter((p) => !hasPermission(granted, p));
  const throttled = missing.filter(
    (p) => countRecentRequests(record, p, now) >= PERMISSION_REQUEST_LIMIT
  );
  if (throttled.length > 0) {
    return {
      ok: false,
      reason: "throttled",
      message: `24 小时内申请次数已达上限：${throttled.join("、")}（请稍后再试或让用户手动授权）`,
      throttled,
    };
  }
  return { ok: true, apis: missing, already };
}

/** 追加一条申请历史（就地修改 record；超出上限丢最旧的） */
export function recordPermissionRequest(
  record: PluginRecord,
  entry: PluginPermissionRequest
): void {
  const list = record.permissionRequests ?? [];
  list.push(entry);
  if (list.length > PERMISSION_REQUEST_HISTORY_LIMIT) {
    list.splice(0, list.length - PERMISSION_REQUEST_HISTORY_LIMIT);
  }
  record.permissionRequests = list;
}

/** 清空申请历史（卸载/重置时用） */
export function clearPermissionRequests(record: PluginRecord): void {
  record.permissionRequests = null;
}

/** 权限申请弹窗的正文（分组 + 风险 + 理由） */
export function permissionRequestText(
  record: PluginRecord,
  apis: readonly string[],
  reason?: string
): string {
  const groups = new Map<string, string[]>();
  for (const api of apis) {
    const g = groupOf(api);
    const list = groups.get(g) ?? [];
    list.push(api);
    groups.set(g, list);
  }
  const lines: string[] = [`插件「${record.name}」请求以下权限：`];
  for (const [group, list] of groups) {
    lines.push("", `【${GROUP_LABEL[group] ?? group}】`);
    for (const api of list) {
      const spec = getPermissionSpec(api);
      const risk = spec ? RISK_LABEL[spec.risk] : "未知风险";
      const title = spec?.title ?? api;
      lines.push(`· ${title}（${risk}）`);
      if (spec?.desc) lines.push(`  ${spec.desc}`);
    }
  }
  const why = String(reason ?? "").trim();
  if (why) lines.push("", `理由：${why.slice(0, 200)}`);
  lines.push("", "允许后立即生效；拒绝不会影响插件已获得的其他权限。");
  return lines.join("\n");
}

const GROUP_LABEL: Record<string, string> = {
  search: "搜索",
  ui: "界面",
  data: "数据与文件",
  network: "网络",
  device: "设备与系统",
  danger: "高危能力",
};
