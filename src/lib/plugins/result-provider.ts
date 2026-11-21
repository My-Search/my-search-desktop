/**
 * 搜索期结果提供者（P0-2）。
 *
 * 设计目标：让插件能在**不打开插件界面**的情况下参与搜索，等价于 uTools
 * `onMainPush` 的「每次搜索都有机会贡献结果」。三条硬约束：
 *
 *   1. **声明显式**：清单必须写 `contributes.resultProvider`，否则运行时
 *      `ms.results.provide()` 直接报错——不允许「偷偷贡献」。
 *   2. **预算硬顶**：单插件 `min(声明值, 250ms)`，全局 250ms。任何超时/异常
 *      只丢该插件自己的结果，宿主的其余搜索结果照常返回。
 *   3. **不拉起视图**：提供者是插件视图启动时注册的回调。视图没开过就没有
 *      结果——搜索不能为插件冷启动付出代价。
 *
 * 本模块是纯函数 + 一个模块级回调表，便于测试（无 DOM / 无 Tauri 依赖）。
 */

import type { SearchItem } from "../../types/index.ts";
import type { PluginProvidedResult, PluginResultProviderContribution } from "./manifest.ts";
import { isInlineIconRef } from "./icon.ts";
import { PLUGIN_ITEM_FLAG, PLUGIN_SUBSCRIBE_PREFIX } from "./plugin-items.ts";
import type { PluginRecord } from "./registry.ts";

/** 单插件单次最多返回条数（清单 maxItems 的硬顶） */
export const RESULT_PROVIDER_MAX_ITEMS = 10;
/** 一次搜索里所有插件合计最多插入条数 */
export const RESULT_PROVIDER_GLOBAL_CAP = 20;
/** 一次搜索里所有提供者共享的总预算 */
export const RESULT_PROVIDER_BUDGET_MS = 250;
/** 单插件未声明 timeoutMs 时的默认值 */
export const RESULT_PROVIDER_DEFAULT_TIMEOUT_MS = 120;
/** 并发询问的插件数上限 */
export const RESULT_PROVIDER_CONCURRENCY = 4;

/** 结果项标记：来源是搜索期提供者（点击时进入 `action.type === "result"` 分支） */
export const PLUGIN_RESULT_FLAG = "_pluginResult";
/** 结果项标记：插件返回的稳定 id（或序号） */
export const PLUGIN_RESULT_ID_FLAG = "_pluginResultId";
/** 结果项标记：回传给插件的原始 payload */
export const PLUGIN_RESULT_PAYLOAD_FLAG = "_pluginResultPayload";
/** 结果项标记：点击时要回传的动作码 */
export const PLUGIN_RESULT_ACTION_FLAG = "_pluginResultAction";

export type ResultProviderFn = (keyword: string) => unknown;

const providers = new Map<string, ResultProviderFn>();

/** 注册（或传 null 注销）某个插件的搜索期提供者 */
export function registerResultProvider(pluginId: string, fn: ResultProviderFn | null): void {
  if (!pluginId) return;
  if (fn == null) providers.delete(pluginId);
  else providers.set(pluginId, fn);
}

/** 注销提供者：传 pluginId 清单个，不传清全部（会话释放时用） */
export function clearResultProviders(pluginId?: string): void {
  if (pluginId == null) providers.clear();
  else providers.delete(pluginId);
}

/** 该插件当前是否注册了提供者（视图没开过就是 false） */
export function hasResultProvider(pluginId: string): boolean {
  return providers.has(pluginId);
}

/** 取清单里的提供者声明（未声明返回 null） */
export function resultProviderOf(record: PluginRecord): PluginResultProviderContribution | null {
  const spec = record.manifest.contributes?.resultProvider;
  return spec ?? null;
}

/**
 * 触发条件匹配。
 *
 * `prefix` 按「整词前缀」匹配：`match="天气"` 命中 `天气` / `天气 广州`，
 * 不命中 `天气预`（避免 `天气` 把 `天气预报` 这种更长的词也吞掉）。
 */
export function providerMatches(
  spec: PluginResultProviderContribution,
  rawKeyword: string
): boolean {
  const keyword = String(rawKeyword ?? "").trim();
  if (!keyword) return false;
  const trigger = spec.trigger ?? "always";
  if (trigger === "always") return true;
  const match = String(spec.match ?? "");
  if (!match) return false;
  if (trigger === "prefix") {
    return keyword === match || keyword.startsWith(`${match} `) || keyword.startsWith(`${match} :`);
  }
  try {
    return new RegExp(match).test(keyword);
  } catch {
    return false;
  }
}

/** 把插件返回值归一化为 SearchItem（非法项丢弃；单插件不超过 maxItems） */
function toSearchItems(
  record: PluginRecord,
  raw: unknown,
  keyword: string,
  maxItems: number,
  resolveIcon?: (pluginId: string, iconRef: string) => string | undefined
): SearchItem[] {
  if (!Array.isArray(raw)) return [];
  const out: SearchItem[] = [];
  const seen = new Set<string>();
  for (const [i, it] of raw.entries()) {
    if (out.length >= maxItems) break;
    if (it == null || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const title = typeof o.title === "string" ? o.title.trim() : "";
    if (!title) continue;
    const id = typeof o.id === "string" && o.id.trim() ? o.id.trim() : String(i);
    if (seen.has(id)) continue;
    seen.add(id);
    const icon = typeof o.icon === "string" && o.icon ? o.icon : undefined;
    const item: SearchItem = {
      title,
      desc: typeof o.desc === "string" ? o.desc : record.description ?? "",
      resource: "",
      type: "script",
      icon:
        icon == null
          ? undefined
          : isInlineIconRef(icon)
            ? icon
            : resolveIcon?.(record.id, icon),
      subscribe: PLUGIN_SUBSCRIBE_PREFIX + record.name,
    };
    item[PLUGIN_ITEM_FLAG] = record.id;
    item._pluginKeyword = keyword;
    item[PLUGIN_RESULT_FLAG] = true;
    item[PLUGIN_RESULT_ID_FLAG] = id;
    item[PLUGIN_RESULT_ACTION_FLAG] =
      typeof o.action === "string" && o.action ? o.action : id;
    item[PLUGIN_RESULT_PAYLOAD_FLAG] = o.payload;
    out.push(item);
  }
  return out;
}

/** 超时包装：只拒绝，不改原 Promise 的结算 */
function withTimeout<T>(p: Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
  if (!(ms > 0)) return Promise.reject(new Error(timeoutMessage));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

export interface CollectResultProvidersOptions {
  keyword: string;
  /** 当前启用插件的注册表记录 */
  records: readonly PluginRecord[];
  /** 全局预算（默认 250ms） */
  budgetMs?: number;
  /** 并发上限（默认 4） */
  concurrency?: number;
  /** 图标解析（相对路径 → data URL），由宿主注入 */
  resolveIcon?: (pluginId: string, iconRef: string) => string | undefined;
  /** 异常/超时回调（宿主写审计日志用） */
  onError?: (pluginId: string, reason: string) => void;
}

/**
 * 并发询问所有匹配的提供者，返回可直接插进结果列表的 SearchItem。
 *
 * 这个函数**永不抛错**：任何插件问题都退化为「该插件没贡献」。
 */
export async function collectProviderResults(
  opts: CollectResultProvidersOptions
): Promise<SearchItem[]> {
  const keyword = String(opts.keyword ?? "").trim();
  if (!keyword) return [];

  const candidates: Array<{
    record: PluginRecord;
    spec: PluginResultProviderContribution;
    fn: ResultProviderFn;
  }> = [];
  for (const record of opts.records) {
    if (!record.enabled) continue;
    const spec = resultProviderOf(record);
    if (!spec) continue;
    const fn = providers.get(record.id);
    if (!fn) continue;
    if (!providerMatches(spec, keyword)) continue;
    candidates.push({ record, spec, fn });
  }
  if (candidates.length === 0) return [];

  const budget = Math.min(
    RESULT_PROVIDER_BUDGET_MS,
    Math.max(1, Number(opts.budgetMs ?? RESULT_PROVIDER_BUDGET_MS))
  );
  const concurrency = Math.min(
    RESULT_PROVIDER_CONCURRENCY,
    Math.max(1, Number(opts.concurrency ?? RESULT_PROVIDER_CONCURRENCY))
  );
  const deadline = Date.now() + budget;
  const out: SearchItem[] = [];
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < candidates.length) {
      const at = cursor++;
      if (out.length >= RESULT_PROVIDER_GLOBAL_CAP) return;
      const { record, spec, fn } = candidates[at];
      const maxItems = Math.min(
        RESULT_PROVIDER_MAX_ITEMS,
        Math.max(1, Number(spec.maxItems ?? 5))
      );
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        opts.onError?.(record.id, "timeout:budget-exhausted");
        continue;
      }
      const timeout = Math.min(
        Math.max(1, Number(spec.timeoutMs ?? RESULT_PROVIDER_DEFAULT_TIMEOUT_MS)),
        budget,
        Math.max(1, remaining)
      );
      let raw: unknown;
      try {
        raw = await withTimeout(
          Promise.resolve().then(() => fn(keyword)),
          timeout,
          `timeout:${timeout}ms`
        );
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        opts.onError?.(record.id, reason);
        continue;
      }
      const items = toSearchItems(record, raw, keyword, maxItems, opts.resolveIcon);
      const room = RESULT_PROVIDER_GLOBAL_CAP - out.length;
      if (room > 0) out.push(...items.slice(0, room));
    }
  };

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrency, candidates.length); i++) workers.push(worker());
  await Promise.all(workers);
  return out;
}
