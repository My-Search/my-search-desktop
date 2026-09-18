/**
 * 插件市场目录客户端 —— 纯逻辑（拉取的编排见宿主，本文件只做「目录 → 注册表」的
 * 推论），便于单测。
 *
 * 职责边界：
 *   - 目录的 schema 解析/校验在 `market-types.ts`，这里接收**已解析并兼容过滤**
 *     的条目（调用方先过 `compatibleEntries`），本文件不再重复版本合法性判断；
 *   - 本文件回答三个问题：什么东西可更新、什么新插件可装、什么被块名单拦下；
 *   - `updateAvailable` 的写入是**幂等重算**（不是叠加）：每次 diff 都从头扫注册表，
 *     目录里已无更优版本的插件，状态清回 null，避免「升级后还挂着旧角标」。

 * 信任边界（诚实声明）：MVP 无签名，块名单 `Blocklist` 为 P5 预留的哨兵类型，
 * 当前恒为空集；目录真实可信度由「策展仓库 + PR 评审 + sha256」承担。
 */

import type { PluginRecord, PluginRegistryFile } from "./registry.ts";
import type { MarketPluginEntry } from "./market-types.ts";
import { compareVersion } from "./manifest.ts";

/**
 * 参与市场更新的来源。规则（Raycast「本地导入只看不更」的对应物）：
 *   - `builtin`：内置插件可由市场接管更新（比随应用发版更及时）；
 *   - `market` ：市场已装的，自然跟随市场；
 *   - `file` / `folder` / `legacy`：用户主动指定的本地/老形态来源，**不参与**。
 */
const UPDATEABLE_SOURCE_KINDS = new Set(["builtin", "market"]);

/** 恶意/漏洞块名单（P5 启用；结构先留好，解析永不失败） */
export interface Blocklist {
  ids: string[];
}

/** 宽容解析块名单：任何形状都返回一个合法对象（id 只保留非空字符串） */
export function parseBlocklist(raw: unknown): Blocklist {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return { ids: [] };
  const ids = (raw as Record<string, unknown>).ids;
  if (!Array.isArray(ids)) return { ids: [] };
  return { ids: ids.filter((i): i is string => typeof i === "string" && i.length > 0) };
}

/** 目录快照（宿主持有，跨窗口共享） */
export interface MarketSnapshot {
  /** 最近一次成功拉到的目录 */
  catalog: MarketPluginEntry[] | null;
  fetchedAt: number;
  /** 拉取/校验失败的人类可读文案（空串 = 无错误） */
  error: string;
}

/** 目录与注册表的差异结论 */
export interface CatalogDiff {
  /** 已装且目录里有更高版本（来源可更新）——写 updateAvailable 用 */
  updates: { rec: PluginRecord; entry: MarketPluginEntry }[];
  /** 未安装且未被块名单拦下的可装条目 */
  newOnes: MarketPluginEntry[];
  /** 命中块名单的条目（无论装没装） */
  blocked: MarketPluginEntry[];
}

/** 目录某版本相对已装版本是否「确实更新」 */
export function isNewerVersion(entry: MarketPluginEntry, rec: PluginRecord): boolean {
  return compareVersion(entry.version, rec.version) > 0;
}

/** 该来源是否参与市场更新 */
export function isUpdateableSource(kind: PluginRecord["source"]["kind"]): boolean {
  return UPDATEABLE_SOURCE_KINDS.has(kind);
}

/**
 * 计算差异。调用方保证 `entries` 已经过 `compatibleEntries`（当前应用版本可用）。
 *
 * 块名单优先级最高：命中即进 `blocked`，不再出现在 updates / newOnes。
 */
export function diffCatalog(
  reg: PluginRegistryFile,
  entries: readonly MarketPluginEntry[],
  blocklist?: Blocklist
): CatalogDiff {
  const blockedIds = new Set((blocklist ?? { ids: [] }).ids);
  const installed = new Map(reg.plugins.map((p) => [p.id, p]));

  const updates: { rec: PluginRecord; entry: MarketPluginEntry }[] = [];
  const newOnes: MarketPluginEntry[] = [];
  const blocked: MarketPluginEntry[] = [];

  for (const entry of entries) {
    if (blockedIds.has(entry.id)) {
      blocked.push(entry);
      continue;
    }
    const rec = installed.get(entry.id);
    if (!rec) {
      newOnes.push(entry);
      continue;
    }
    if (isUpdateableSource(rec.source.kind) && isNewerVersion(entry, rec)) {
      updates.push({ rec, entry });
    }
  }
  return { updates, newOnes, blocked };
}

/**
 * 幂等重算 `updateAvailable`：
 *   - 目录里有「兼容 + 来源可更新 + 版本更高」→ 写版本号（角标出现）；
 *   - 其余情况一律清回 null（目录回到平齐 / 插件本地升级过 / 来源不可更新）。
 * 就地修改，无返回值。
 */
export function applyUpdateAvailable(reg: PluginRegistryFile, diff: CatalogDiff): void {
  const wanted = new Map(diff.updates.map((u) => [u.rec.id, u.entry.version]));
  for (const rec of reg.plugins) {
    const next = wanted.get(rec.id);
    const cur = rec.updateAvailable ?? null;
    if (next) {
      if (cur !== next) rec.updateAvailable = next;
    } else if (cur !== null) {
      rec.updateAvailable = null;
    }
  }
}

/** 清除单个插件的更新角标（更新成功后调用） */
export function clearUpdateAvailable(reg: PluginRegistryFile, id: string): void {
  const rec = reg.plugins.find((p) => p.id === id);
  if (rec && rec.updateAvailable != null) rec.updateAvailable = null;
}

/** 取可更新的数量（面板角标用） */
export function updateableCount(reg: PluginRegistryFile): number {
  return reg.plugins.filter((p) => p.updateAvailable != null).length;
}