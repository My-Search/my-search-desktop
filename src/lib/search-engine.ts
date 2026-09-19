/**
 * 搜索核心 - 我的搜索桌面版
 * 移植自油猴脚本"我的搜索"（v7.9.5，作者 zhuangjie）
 *
 * 关键点（修正原桌面版的"搜索不出结果"问题）：
 * 1. 和油猴版一致地递归解析 tis 订阅（配置 → 子订阅 → 内容），并支持自定义 fetchFun。
 * 2. 一次性构建「大小写归一化 + 拼音」的检索索引，避免每次搜索对每条数据做重复计算，
 *    既保证结果正确，也保证输入时的响应速度。
 * 3. 三级搜索：精确(标题/描述/内容) → 拼音 → 重叠匹配度（AI 模糊）。
 * 4. 点击权重、选择历史、特殊关键词（<new> / <history> / <highFrequency>）。
 * 6. 搜索PRO模式（子搜索模式）：当关键词中含有 " : "（SEARCH_BOUNDARY）时，
 *    触发PRO模式搜索，仅搜索被标记为"[可搜索]"的项（URL 包含 [[...keyword...]] 模板）。
 *    支持特殊路由：空父关键词 → "问AI"，父关键词为 "问AI" → 精确搜索。
 * 5. 数据缓存（还原油猴版 SEARCH_DATA_KEY + effectiveDuration）：
 *    加载结果带过期时间写入本地存储，未过期时启动直接复用缓存，只有过期
 *    （或订阅变化 / 强制刷新）才重新发起网络加载，避免每次启动都全量拉取。
 */

import { pinyin } from "pinyin-pro";
import { httpGet } from "./tauri-bridge.ts";
import {
  getConfigFromDataSource,
  getFetchFunByName,
  resolveUrl,
  contentRecovery,
  defaultTagHandle,
  parseScriptItem,
  escapeText,
} from "./subscribe-parser.ts";
import type { DesignatedSingTag } from "./subscribe-parser.ts";
import { parseTags, extractTagsAndCleanContent } from "./tags.ts";
import { overlapMatchingDegreeForObjectArray } from "./overlap.ts";
import { storageGet, storageSet, storageRemove, isUrl } from "./util.ts";
import { pluginIdOf, pluginKeywordOf } from "./plugins/plugin-items.ts";
import type { SearchItem, SearchResult, SubscribeItem, TagStat } from "../types/index.ts";

/** 搜索结果包装（对外导出，便于视图层引用） */
export type { SearchItem, SearchResult } from "../types/index.ts";

/** 检索层级：0=标题命中 1=描述命中 2=内容命中 */
export const LEVEL_TITLE = 0;
export const LEVEL_DESC = 1;
export const LEVEL_CONTENT = 2;
/** 模糊匹配层 */
export const LEVEL_FUZZY = 9;

const SPACE = "<Space>";
const SPACE_CHAR = " ";

// ---------- 数据缓存（还原油猴版 registry.searchData） ----------
// 存储键与时长常量拆到零依赖的 search-keys.ts：设置窗口（插件面板 / 缓存面板）
// 只需要键名，若从这里导入会把 pinyin-pro 一起拖进设置窗口（详见该文件注释）。
export {
  SEARCH_DATA_KEY,
  OLD_SEARCH_DATA_KEY,
  EFFECTIVE_DURATION,
  SUBSCRIBE_FINGERPRINT_KEY,
} from "./search-keys.ts";
import {
  SEARCH_DATA_KEY,
  OLD_SEARCH_DATA_KEY,
  EFFECTIVE_DURATION,
  SUBSCRIBE_FINGERPRINT_KEY,
} from "./search-keys.ts";

/** 数据缓存包结构 */
export interface SearchDataCache {
  data: SearchItem[];
  expire: number;
}

/** 新数据记录 */
interface NewItemRecord {
  id: string;
  expires: number;
}

/** 订阅列表指纹：按内容计算，订阅增删改都会变化（顺序无关） */
export function subscribeFingerprint(subscribes: SubscribeItem[] | null | undefined): string {
  return (subscribes || [])
    .map((s) => `${s.url ?? ""}|${s.title ?? ""}|${s.fetchFun ?? ""}|${s.defaultTag ?? ""}`)
    .sort()
    .join("\n");
}

/** 特殊关键词（还原 specialKeyword） */
export const SPECIAL_KEYWORD = {
  new: "<new>",
  history: "<history>",
  highFrequency: "<highFrequency>",
} as const;

/** 子搜索分隔符（还原 subSearch.searchBoundary） */
export const SEARCH_BOUNDARY = " : ";

/** 搜索PRO标签（还原 searchProTag），标记可被子搜索搜索到的项 */
export const SEARCH_PRO_TAG = "[可搜索]";

/** 数据项唯一 id（还原 registry.searchData.idFun） */
export function itemId(item: SearchItem | null | undefined): string | null {
  if (item == null || !(item instanceof Object && item.title != null)) return null;
  return item.title.replace(/\[.*\]/, "").trim() + ("" + item.desc).trim();
}

/** links 搜索字符串（还原 links.stringifyForSearch） */
export function linksToString(links: unknown): string {
  if (!Array.isArray(links)) return "";
  return links.map((l) => `${l?.text ?? ""}${l?.title ?? ""}${l?.url ?? ""}`).join("\n");
}

/** 文本转拼音（无空格、大写） */
export function textToPinyin(text: string | null | undefined): string {
  if (text == null) return "";
  const safe = String(text).replaceAll(SPACE_CHAR, SPACE);
  try {
    const arr = pinyin(safe, { toneType: "none", type: "array" }) as string[];
    return arr.join("").replaceAll(SPACE, SPACE_CHAR).toUpperCase();
  } catch (e) {
    return "";
  }
}

// ========== 加分器 / 历史记录器（还原 DataWeightScorer / SelectHistoryRecorder） ==========
const WEIGHT_KEY = "ITEM_WEIGHT_CACHE_KEY";
const HISTORY_KEY = "HISTORY_CACHE_KEY";
const NEW_ITEMS_KEY = "SEARCH_NEW_ITEMS_KEY";
/** 上一次加载的数据项 id 集合（还原油猴版 OLD_SEARCH_DATA_KEY） */
const OLD_DATA_KEY = OLD_SEARCH_DATA_KEY;
/** 用户维护的不关注标签列表（与配置窗口共享） */
export const UNFOLLOW_KEY = "USER_UNFOLLOW_LIST_CACHE_KEY";
/** 数据项标签统计缓存（供配置窗口的“关注标签”使用） */
export const TAGS_KEY = "DATA_ITEM_TAGS_CACHE_KEY";
/** 默认不关注的标签（还原 USER_DEFAULT_UNFOLLOW） */
export const DEFAULT_UNFOLLOW = ["成人内容", "Adults only"];
/** 新数据保留天数（还原 NEW_DATA_EXPIRE_DAY_NUM） */
const NEW_DATA_EXPIRE_DAY_NUM = 7;
/** 新数据标签（还原 NEW_ITEMS_TAG） */
const NEW_ITEMS_TAG = "[新]";
const DAY_MS = 1000 * 60 * 60 * 24;

/** 给被点击项加分（还原 DataWeightScorer.select） */
export function scoreSelect(item: SearchItem | null | undefined): void {
  if (item == null) return;
  const key = itemId(item);
  if (key == null) return;
  const data = storageGet<Record<string, number>>(WEIGHT_KEY, {}) || {};
  data[key] = (data[key] ?? 0) + 1;
  storageSet(WEIGHT_KEY, data);
}

/** 稳定排序：先按层内权重降序，保持同权重原顺序 */
function sortByWeight(items: SearchItem[]): SearchItem[] {
  // 一次读取权重表，避免每条数据都读一遍 localStorage
  const data = storageGet<Record<string, number>>(WEIGHT_KEY, {}) || {};
  return items
    .map((item, i) => {
      const key = itemId(item);
      return { item, i, w: key != null && data[key] != null ? data[key] : 0 };
    })
    .sort((a, b) => b.w - a.w || a.i - b.i)
    .map((x) => x.item);
}

/** 记录选择历史（还原 SelectHistoryRecorder.select） */
export function historySelect(item: SearchItem | null | undefined): void {
  if (item == null || itemId(item) == null) return;
  const key = itemId(item);
  let history = storageGet<SearchItem[]>(HISTORY_KEY, []) || [];
  history = history.filter((_item) => itemId(_item) !== key);
  const copy: SearchItem = { ...item };
  delete copy.index;
  delete copy._titleUpper;
  delete copy._descUpper;
  delete copy._contentUpper;
  delete copy._titlePinyin;
  delete copy._descPinyin;
  delete copy._cleanedTitleUpper;
  delete copy._descTagsUpper;
  history.unshift(copy);
  storageSet(HISTORY_KEY, history.slice(0, 60));
}

/** 历史记录列表 */
export function historyList(count?: number): SearchItem[] {
  const history = storageGet<SearchItem[]>(HISTORY_KEY, []) || [];
  return count == null ? history : history.slice(0, count);
}

/** 高频项（还原 DataWeightScorer.highFrequency） */
export function highFrequencyList(allItems: SearchItem[], count?: number): SearchItem[] {
  const data = storageGet<Record<string, number>>(WEIGHT_KEY, {}) || {};
  const keys = Object.keys(data).sort((a, b) => data[b] - data[a]);
  const picked = count != null ? keys.slice(0, count) : keys;
  const map = new Map<string | null, SearchItem>();
  for (const item of allItems) map.set(itemId(item), item);
  return picked
    .map((k) => map.get(k))
    .filter((x): x is SearchItem => Boolean(x));
}

/** 读取「新数据」记录 [{id, expires}] */
export function newItemsRecord(): NewItemRecord[] {
  return storageGet<NewItemRecord[]>(NEW_ITEMS_KEY, []) || [];
}

/**
 * 记录新数据（还原 compareBlocks）
 *
 * 与上次加载的 id 集合对比，找出新增项并记录过期时间。两条与原版一致的关键规则：
 * 1. **首次加载（没有 OLD_SEARCH_DATA_KEY）不应把全部数据当成「新」**：
 *    原版 `compareBlocks` 在 `oldNewItems == null` 时写入 `[]` 并直接 return，
 *    注释写明「如果是第一次加载数据，那不要这次的『新』」。
 * 2. **过期记录（超过 NEW_DATA_EXPIRE_DAY_NUM 天）必须丢弃**：
 *    原版遍历旧记录时用 `item.expires > currentTime` 过滤，到期即消失；
 *    否则 [新] 标签会永久累积。
 */
function recordNewItems(allItems: SearchItem[]): void {
  const oldIdsRaw = storageGet<string[] | null>(OLD_DATA_KEY, null);
  // 收集本次加载的全部 id（后续无论哪条分支都要更新，作为下次比较的基线）
  const currentIds: string[] = [];
  for (const item of allItems) {
    const id = itemId(item);
    if (id != null) currentIds.push(id);
  }

  // 首次加载：写入空记录作为哨兵（下次才能区分出真正的「新增」），不标记任何新数据
  if (!Array.isArray(oldIdsRaw) || oldIdsRaw.length === 0) {
    storageSet(NEW_ITEMS_KEY, []);
    storageSet(OLD_DATA_KEY, currentIds);
    return;
  }
  const oldIds = new Set(oldIdsRaw);

  const now = Date.now();
  const currentSet = new Set(currentIds);
  // 旧记录：丢弃已过期、以及数据里已不存在的条目
  const existing = new Map<string, NewItemRecord>(
    (storageGet<NewItemRecord[]>(NEW_ITEMS_KEY, []) || [])
      .filter((r) => r != null && Number(r.expires) > now && currentSet.has(r.id))
      .map((r) => [r.id, r] as [string, NewItemRecord])
  );
  for (const id of currentIds) {
    if (!oldIds.has(id) && !existing.has(id)) {
      existing.set(id, { id, expires: now + NEW_DATA_EXPIRE_DAY_NUM * DAY_MS });
    }
  }
  storageSet(NEW_ITEMS_KEY, [...existing.values()]);
  storageSet(OLD_DATA_KEY, currentIds);
}

/**
 * 构建「新数据」结果（还原 <new> 搜索处理器）
 * 为标题加上 [新] 与“N 天前”，首条标记为 [最新一条]。
 */
export function buildNewItemsResult(allItems: SearchItem[]): SearchResult[] {
  const records = newItemsRecord();
  if (records.length === 0) return [];
  const now = Date.now();
  const byId = new Map<string | null, SearchItem>();
  for (const item of allItems) {
    const id = itemId(item);
    if (id != null && !byId.has(id)) byId.set(id, item);
  }
  const matched = records
    // 过期记录不再展示（与 recordNewItems 的清理规则一致）
    .filter((r) => Number(r.expires) > now)
    .map((r) => ({ item: byId.get(r.id), expires: r.expires }))
    .filter((x): x is { item: SearchItem; expires: number } => Boolean(x.item))
    .sort((a, b) => b.expires - a.expires);
  if (matched.length === 0) return [];
  const results: SearchResult[] = matched.map(({ item, expires }) => {
    const daysAgo = Math.floor((now - (expires - NEW_DATA_EXPIRE_DAY_NUM * DAY_MS)) / DAY_MS);
    const cleanTitle = String(item.title || "").split(NEW_ITEMS_TAG).join("");
    // 不修改原数据，克隆一份用于展示
    return {
      item: { ...item, title: `${NEW_ITEMS_TAG}${cleanTitle} | ${daysAgo}天前` },
      level: LEVEL_TITLE,
    };
  });
  results[0].item.title = (results[0].item.title as string)
    .split(NEW_ITEMS_TAG)
    .join("[最新一条]");
  return results;
}

/** 加载队列任务 */
interface LoadJob {
  url: string;
  /** meta.fetchFun 缺省（undefined）= 配置文件；空串 = 显式跳过；其余 = 内容文件 */
  meta: Record<string, string | undefined>;
  depth: number;
}

// ========== 搜索引擎 ==========
export class SearchEngine {
  /** 全部数据项 */
  searchData: SearchItem[];
  /** 订阅列表 */
  subscribes: SubscribeItem[];
  /** 数据源中自定义的 fetchFun */
  globalFetchFun: Array<{ name: string; fetchFun: string }>;
  /** 已处理过的 URL（防止重复/循环） */
  processHistory: Set<string>;
  /** 配置文件解析出、等待入队的子订阅任务（见 _runQueue） */
  _pendingChildJobs: LoadJob[];
  /** 上一次进度通知的时间戳（进度节流用） */
  _lastProgressNotifyAt: number;
  /** 文本→拼音 会话缓存 */
  textPinyinMap: Record<string, string>;
  /** 标签统计 */
  tagsMap: Record<string, TagStat>;
  /** PRO 特殊路由 `^\s*$` → "问AI" 的待转发关键词（见 search / _proSearch） */
  _pendingRedirectKeyword: string | null;
  /**
   * PRO 特殊路由转发回调（还原 searchableSpecialRouting["^\\s*$"] 的
   * triggerSearchHandle("问AI"+searchBoundary)）：主流程把输入框改写为
   * "问AI : " 并重新触发搜索
   */
  onRedirect: ((keyword: string) => void) | null;
  /** 加载状态 */
  loading: boolean;
  loadedCount: number;
  failedUrls: string[];
  /**
   * 数据块进度回调（还原油猴版 refreshNewData 中的 searchPlaceholder("UPDATE")）：
   * 每解析完一个内容源都会调用一次，参数为当前已挂载的数据条数。
   * 视图据此实时显示「🔁 数据库更新到 N条」，即原版的加载进度。
   */
  onProgress: ((count: number) => void) | null;

  constructor() {
    this.searchData = [];
    this.subscribes = [];
    this.globalFetchFun = [];
    this.processHistory = new Set();
    this._pendingChildJobs = [];
    this._lastProgressNotifyAt = 0;
    this.textPinyinMap = {};
    this.tagsMap = {};
    this._pendingRedirectKeyword = null;
    this.onRedirect = null;
    this.loading = false;
    this.loadedCount = 0;
    this.failedUrls = [];
    this.onProgress = null;
  }

  /** 文本转拼音（带缓存，还原 String.toPinyin） */
  toPinyin(text: string | null | undefined, onlyFromCache = false): string | null {
    if (text == null) return onlyFromCache ? null : "";
    if (this.textPinyinMap[text] != null) return this.textPinyinMap[text];
    if (onlyFromCache) return null;
    const result = textToPinyin(text);
    this.textPinyinMap[text] = result;
    return result;
  }

  // ---------- 缓存（还原 dataInitFun / cacheSearchData） ----------
  /**
   * 读取本地缓存（还原 registry.searchData.SEARCH_DATA_KEY）
   */
  _readCache(): SearchDataCache | null {
    const pkg = storageGet<SearchDataCache | null>(SEARCH_DATA_KEY, null);
    if (pkg == null || !Array.isArray(pkg.data)) return null;
    return pkg;
  }

  /** 写入本地缓存（相当于原版 cacheSearchData：带过期时间） */
  _writeCache(data: SearchItem[]): void {
    try {
      // 剥离派生索引字段（index / _titleUpper / _titlePinyin …）：
      // 它们体积大且可由 _buildIndex 重建，不写入缓存以减小占用
      const slim = data
        // 插件贡献的项不进缓存：它们来自本地插件注册表，装/卸/禁用随时变化，
        // 且缓存带「订阅指纹」，掺进去会让既有的失效判定失真（详见 plugin-items.ts）
        .filter((item) => pluginIdOf(item) == null)
        .map((item) => {
          const copy: Record<string, unknown> = {};
          for (const key of Object.keys(item)) {
            if (key === "index" || key.startsWith("_")) continue;
            copy[key] = item[key];
          }
          return copy as SearchItem;
        });
      storageSet(SEARCH_DATA_KEY, {
        data: slim,
        expire: Date.now() + EFFECTIVE_DURATION,
      });
    } catch (e) {
      console.warn("[我的搜索] 写入数据缓存失败:", e);
    }
  }

  /**
   * 获取当前缓存的过期时间戳，无有效缓存时返回 0。
   * @returns 过期时间戳（毫秒）或 0
   */
  getCacheExpireMs(): number {
    const pkg = this._readCache();
    if (pkg == null || !Array.isArray(pkg.data) || pkg.data.length === 0) return 0;
    const expire = Number(pkg.expire);
    return Number.isFinite(expire) && expire > 0 ? expire : 0;
  }

  /** 清除数据缓存（还原 clearCache） */
  _clearCache(): void {
    storageRemove(SEARCH_DATA_KEY);
    storageRemove(SUBSCRIBE_FINGERPRINT_KEY);
  }

  /**
   * 缓存是否可用（还原 dataInitFun 的 isNotExpire 判断 + 订阅指纹比对）
   * 过期 / 数据为空 / 订阅变化 → 不可用，需要重新加载
   */
  isCacheValid(): boolean {
    const pkg = this._readCache();
    if (pkg == null || pkg.data.length === 0) return false;
    if (!(pkg.expire != null && pkg.expire > Date.now())) return false;
    // 订阅变化 → 缓存失效（避免改了订阅还展示旧数据）
    if (storageGet(SUBSCRIBE_FINGERPRINT_KEY, null) !== subscribeFingerprint(this.subscribes)) {
      return false;
    }
    return true;
  }

  /**
   * 挂载缓存数据（还原 setData + refreshIndex 的索引重建）：
   * 缓存中不保存 _titleUpper / _titlePinyin 等派生的索引字段（体积大），
   * 挂载时一次性重建，保证「直接用缓存」与「重新加载」的搜索结果完全一致。
   */
  _mountCache(pkg: SearchDataCache): SearchItem[] {
    this.searchData = pkg.data.map((item) => ({ ...item }));
    this.loadedCount = 0;
    this.failedUrls = [];
    this.loading = false;
    try {
      parseScriptItem(this.searchData);
    } catch (e) {
      /* 脚本项解析失败不影响其它数据 */
    }
    this._buildIndex();
    // 插件项挂在订阅数据之后（不进缓存，因此这里必须重新合成）
    this._attachExtraItems();
    try {
      storageSet(TAGS_KEY, Object.values(this.tagsMap));
    } catch (e) {
      /* ignore */
    }
    console.log(`[我的搜索] 使用数据缓存: ${this.searchData.length} 条`);
    return this.searchData;
  }

  /**
   * 启动时入口（还原 dataInitFun）：
   * 缓存未过期 → 直接用缓存；否则（过期 / 订阅变化 / force）重新加载。
   * 容错：若缓存已过期但重新加载失败（离线/全失败）且旧缓存仍有数据，
   * 则回退到旧缓存，避免把已有数据清空（旧缓存不刷新过期时间，下次再试）。
   */
  async initData(
    subscribes: SubscribeItem[] | null | undefined,
    { force = false }: { force?: boolean } = {}
  ): Promise<SearchItem[]> {
    this.subscribes = subscribes || [];
    if (!force && this.isCacheValid()) return this._mountCache(this._readCache() as SearchDataCache);

    // 记住旧缓存（可能只是过期），用于加载失败时回退
    const stalePkg = this._readCache();
    const data = await this.loadAll(this.subscribes);
    // 仅当「确实一个内容源都没加载成功」时才回退（区分网络故障 vs 标签过滤为空）
    if (
      (data == null || data.length === 0) &&
      this.loadedCount === 0 &&
      stalePkg != null &&
      stalePkg.data.length > 0 &&
      subscribeFingerprint(this.subscribes) === storageGet(SUBSCRIBE_FINGERPRINT_KEY, null)
    ) {
      console.warn("[我的搜索] 重新加载失败，回退到已过期的旧缓存");
      return this._mountCache(stalePkg);
    }
    return data;
  }

  // ---------- 加载 ----------
  async loadSubscribe(
    url: string,
    meta: Record<string, string | undefined> = {},
    depth = 0
  ): Promise<void> {
    if (depth > 6) return;
    const absolute = isUrl(url) ? url : resolveUrl(meta.parentUrl || "", url);
    if (this.processHistory.has(absolute)) return;
    this.processHistory.add(absolute);

    let text: string;
    try {
      text = await httpGet(absolute);
      if (text == null) throw new Error("empty");
    } catch (e) {
      this.failedUrls.push(absolute);
      console.warn(`[我的搜索] 订阅加载失败: ${absolute}`, e);
      return;
    }

    const fetchFunName = meta.fetchFun;

    // 无 fetchFun => 是「配置」文件：解析自定义函数与子订阅
    if (fetchFunName == null) {
      const config = getConfigFromDataSource(text);
      if (config.fetchFuns.length > 0) {
        this.globalFetchFun.push(...config.fetchFuns);
      }
      // 子订阅并发加载（还原原版的行为等价结果，但不再逐个 await 串行）：
      // 配置文件下的十几个内容源若串行，即使顶层并发再大，
      // 也会退化为「一个配置内一个接一个」，整体加载时间被拉长。
      // 这里把子 tis 直接塞回队列（继承 parentUrl 供相对路径解析）。
      if (config.tis.length > 0) {
        this._pendingChildJobs.push(
          ...config.tis.map((tis: DesignatedSingTag) => ({
            url: tis.tabValue,
            meta: { ...tis, parentUrl: absolute },
            depth: depth + 1,
          }))
        );
      }
      return;
    }

    // fetchFun 为空串 => 显式跳过
    if (fetchFunName === "") return;

    // 是「内容」文件：解析数据项
    const fetchFun = getFetchFunByName(fetchFunName, this.globalFetchFun);
    let items: SearchItem[] = [];
    try {
      // 与油猴版一致：先转义再解析
      items = fetchFun(escapeText(text));
    } catch (e) {
      console.warn(`[我的搜索] 解析数据项失败: ${absolute}`, e);
      return;
    }

    for (const item of items) {
      if (item == null || item.title == null) continue;
      contentRecovery(item);
      defaultTagHandle(item, meta);
      item.subscribe = meta.title || "";
      // 与油猴版一致：过滤（USDRC 链上的 filterSearchData，weight=400）发生在
      // 「一个数据块处理完」之时，而不是等全部加载完。这样进度提示里的条数
      // 就是最终可搜索的条数（与加载完成后的数字一致）。
      if (this._isUnfollowed(item)) continue;
      this.searchData.push(item);
    }
    // 脚本项处理（还原 parseScriptItem）
    parseScriptItem(items);
    this.loadedCount++;
    // 数据块就绪 → 上报进度（还原原版每解析完一块就 searchPlaceholder("UPDATE")）
    this._notifyProgress();
  }

  /** 上报数据加载进度。
   *
   * 节流至 250ms 一次：并发提升后内容源会密集完成，
   * 逐个回调会让占位提示与重搜高频抖动（视觉上“几十条几十条地蹦”）。
   * 节流不丢最终进度——loadAll 收尾处会强制通知一次。
   */
  _notifyProgress(): void {
    if (typeof this.onProgress !== "function") return;
    const now = Date.now();
    if (now - this._lastProgressNotifyAt < 250) return;
    this._lastProgressNotifyAt = now;
    try {
      this.onProgress(this.searchData.length);
    } catch (e) {
      /* 进度回调异常不影响加载 */
    }
  }

  /**
   * 单项是否命中「不关注标签列表」（还原 filterDataByUserUnfollowList 的单项判断）
   * @returns true=应被过滤掉
   */
  _isUnfollowed(item: SearchItem): boolean {
    const unfollow = this._unfollowList();
    if (unfollow.length === 0) return false;
    const map = new Set(unfollow);
    const tags = parseTags<SearchItem>([item], (it) => String(it.title ?? ""), {});
    return tags.some((t) => map.has(t.name));
  }

  /** 当前「不关注标签」列表（未配置时回退到默认值） */
  _unfollowList(): string[] {
    const stored = storageGet<string[] | null>(UNFOLLOW_KEY, null);
    const unfollow = Array.isArray(stored) ? stored : DEFAULT_UNFOLLOW;
    return Array.isArray(unfollow) ? unfollow : [];
  }

  /** 加载全部订阅 */
  async loadAll(subscribes: SubscribeItem[] | null | undefined): Promise<SearchItem[]> {
    this.subscribes = subscribes || [];
    this.searchData = [];
    this.globalFetchFun = [];
    this.processHistory = new Set();
    this._pendingChildJobs = [];
    this.textPinyinMap = {};
    this.tagsMap = {};
    this.loadedCount = 0;
    this.failedUrls = [];
    this.loading = true;
    try {
      // 并发加载（用队列实现，避免一次性打满）
      const queue: LoadJob[] = this.subscribes.map((sub) => ({
        url: sub.url,
        meta: {
          title: sub.title,
          describe: sub.describe,
          // 注意：fetchFun 缺省必须是 undefined（代表「配置文件」），
          // 不能归一成 ""（那代表「显式跳过」，会导致订阅被整体忽略）
          fetchFun: sub.fetchFun,
          "default-tag": sub.defaultTag,
          root: "true",
        },
        depth: 0,
      }));
      await this._runQueue(queue);
      // 按“不关注标签”过滤（还原 filterSearchData）
      this._applyUnfollowFilter();
      this._buildIndex();
      // 缓存标签统计，供配置窗口的“关注标签”使用（还原 DATA_ITEM_TAGS_CACHE_KEY）
      try {
        storageSet(TAGS_KEY, Object.values(this.tagsMap));
      } catch (e) {
        /* ignore */
      }
      // 记录新增数据（用于 <new> 特殊搜索）
      try {
        recordNewItems(this.searchData);
      } catch (e) {
        /* ignore */
      }
      // 写入数据缓存（带有效期；还原 cacheSearchData）
      // 仅在确有数据时写：避免网络全失败时把上一次的好缓存覆盖为空
      if (this.searchData.length > 0) {
        this._writeCache(this.searchData);
        try {
          storageSet(SUBSCRIBE_FINGERPRINT_KEY, subscribeFingerprint(this.subscribes));
        } catch (e) {
          /* ignore */
        }
      }
      // 插件贡献的搜索项：在订阅数据全部收尾之后追加（不写缓存、不参与新数据记录）
      const pluginCount = this._attachExtraItems();
      console.log(
        `[我的搜索] 数据加载完成: ${this.searchData.length} 条` +
          (pluginCount > 0 ? `（含插件 ${pluginCount} 条）` : "") +
          ` / ${this.loadedCount} 个内容源` +
          (this.failedUrls.length ? `，失败 ${this.failedUrls.length} 个` : "")
      );
      // 收尾强制上报最终进度（不受节流影响，保证最终条数一定刷出）
      this._lastProgressNotifyAt = 0;
      this._notifyProgress();
    } finally {
      this.loading = false;
    }
    return this.searchData;
  }

  /** 队列并发执行。
   *
   * 并发数取 20：订阅加载是纯 I/O（网络请求），每个内容源文件仅几十 KB，
   * 单条请求的瓶颈在 RTT 而非带宽。20 路并发可以把「几十个内容源」
   * 压到 1~2 轮完成，避免低并发下「每轮凑满一批才出数据」的
   * 阶梯式加载观感（用户感知：数据几十条几十条地蹦出来）。
   */
  async _runQueue(queue: LoadJob[]): Promise<void> {
    const CONCURRENCY = 20;
    let active = 0;
    // 完成判定必须同时看三个地方：执行中、待执行队列、配置文件刚解析出的子订阅。
    // 否则「最后一个配置文件完成」的瞬间，其子任务刚入 _pendingChildJobs，
    // 只看 queue 会误判为全部完成而提前 resolve。
    const isDrained = () =>
      active === 0 && queue.length === 0 && this._pendingChildJobs.length === 0;
    return new Promise((resolve) => {
      const pump = () => {
        // 配置文件解析出的子订阅入队（深度+1，depth>6 时由 loadSubscribe 自行剪枝）
        if (this._pendingChildJobs.length > 0) {
          queue.push(...this._pendingChildJobs.splice(0));
        }
        while (active < CONCURRENCY && queue.length > 0) {
          const job = queue.shift() as LoadJob;
          active++;
          this.loadSubscribe(job.url, job.meta, job.depth)
            .catch((e) => console.warn("[我的搜索] 订阅加载失败:", job.url, e))
            .finally(() => {
              active--;
              pump();
              if (isDrained()) resolve();
            });
        }
        if (isDrained()) resolve();
      };
      pump();
    });
  }

  /**
   * 按用户维护的“不关注标签列表”过滤数据项（还原 filterSearchData）
   * 标题中包含任一不关注标签的数据项将被移除。
   * 注：单个数据块在 `loadSubscribe` 中已即时过滤，这里是全量兑底
   * （保证与缓存/历史数据混用时的结果一致，幂等可重复调用）。
   */
  _applyUnfollowFilter(): void {
    const unfollow = this._unfollowList();
    if (unfollow.length === 0) return;
    const map = new Set(unfollow);
    this.searchData = this.searchData.filter((item) => {
      const tags = parseTags<SearchItem>([item], (it) => String(it.title ?? ""), {});
      return !tags.some((t) => map.has(t.name));
    });
  }

  /**
   * 构建检索索引（关键：一次性归一化，避免每次搜索重复计算）
   * 为每条数据项补充内部字段（下划线前缀，仅运行时使用，不写入缓存）
   */
  _buildIndex(): void {
    const tagsMap: Record<string, TagStat> = {};
    for (let i = 0; i < this.searchData.length; i++) {
      this._indexItem(this.searchData[i], i, tagsMap);
    }
    this.tagsMap = tagsMap;
  }

  /** 为单条数据建立检索索引（供整体重建与「后挂插件项」共用） */
  _indexItem(item: SearchItem, index: number, tagsMap: Record<string, TagStat>): void {
    item.index = index;

    // 给 URL 包含 [[...keyword...]] 模板的项添加 [可搜索] 标签（还原 refreshTags）
    // 必须在 title 变量捕获前执行，否则索引字段不包含该标签
    if (this._isSearchableItem(item) && !(item.title ?? "").includes(SEARCH_PRO_TAG)) {
      item.title = SEARCH_PRO_TAG + (item.title ?? "");
    }
    // 插件贡献的「命令型」条目（声明了 keyword）同样要能被子搜索命中：
    // PRO 模式（`父 : 子`）只检索带 [可搜索] 的项，而插件项的 resource 通常是空的
    // （界面由插件自己渲染，不是 URL 模板），不补这个标签的话，
    // 「按 Tab 进入子搜索 → 插件项从结果里消失」，onSubKeyword 永远收不到消息。
    if (
      pluginIdOf(item) != null &&
      pluginKeywordOf(item) != null &&
      !(item.title ?? "").includes(SEARCH_PRO_TAG)
    ) {
      item.title = SEARCH_PRO_TAG + (item.title ?? "");
    }

    const title = String(item.title || "");
    const desc = String(item.desc || "");
    const resource = String(item.resource || "");

    item._titleUpper = title.toUpperCase();
    item._descUpper = desc.toUpperCase();
    // 简洁写法：只传标题/描述，避免把索引字段自身作为参数传入了 toPinyin
    item._titlePinyin = this.toPinyin(title) ?? "";
    item._descPinyin = this.toPinyin(desc) ?? "";

    // 内容（links + resource + vassal）前 4096 字符
    const content = `${linksToString(item.links)}${resource}${item.vassal || ""}`;
    item._contentUpper = content.substring(0, 4096).toUpperCase();

    // 模糊匹配用：清理标签后的标题，以及 desc+tags
    const { tags, cleaned } = extractTagsAndCleanContent(title);
    item._cleanedTitleUpper = cleaned.toUpperCase();
    item._descTagsUpper = `${desc}${tags.join()}`.toUpperCase();

    // 采集标签统计
    parseTags<SearchItem>([item], (it) => String(it.title ?? ""), tagsMap);
  }

  /**
   * 插件贡献的搜索项提供者（由搜索窗口注入）。
   *
   * 为什么不直接把插件项塞进 `loadAll` 的产物：插件项来自本地注册表，
   * 与「订阅数据」的生命周期完全不同（装/卸/禁用即时生效、不写缓存、
   * 不参与新数据标记与标签统计）。这里在订阅数据处理**全部收尾之后**
   * 才追加，并只对追加的部分建索引。
   */
  extraItemsProvider: (() => SearchItem[]) | null = null;

  /**
   * 把插件贡献的搜索项挂到检索库尾部（幂等：先摘掉旧的插件项再挂新的）。
   * @returns 实际挂上的插件项条数
   */
  _attachExtraItems(): number {
    const provider = this.extraItemsProvider;
    // 先摘除上一轮的插件项（重新合成后对象是新的，必须整体替换）
    if (this.searchData.some((it) => pluginIdOf(it) != null)) {
      this.searchData = this.searchData.filter((it) => pluginIdOf(it) == null);
    }
    if (!provider) return 0;
    let items: SearchItem[] = [];
    try {
      items = provider() ?? [];
    } catch (e) {
      console.warn("[我的搜索] 合成插件搜索项失败:", e);
      return 0;
    }
    if (items.length === 0) return 0;
    const tagsMap: Record<string, TagStat> = {};
    for (const item of items) {
      // 插件项不参与「标签统计」（那是订阅数据的关注/过滤功能）
      this._indexItem(item, this.searchData.length, tagsMap);
      this.searchData.push(item);
    }
    return items.length;
  }

  async reload(): Promise<SearchItem[]> {
    // 手动重新加载：丢弃缓存，强制全量拉取
    this._clearCache();
    return this.loadAll(this.subscribes);
  }

  // ---------- 精确 / 拼音搜索（还原 searchUnitHandler） ----------
  /**
   * 单轮精确搜索
   */
  _searchUnit(beforeData: SearchItem[], keywordRaw: string): SearchResult[] {
    let keyword = keywordRaw.trim().toUpperCase();
    if (keyword === "" || beforeData.length === 0) return [];

    // 多关键词：取最后一个关键词做本轮匹配，其余递归
    const searchUnits = keyword.split(/\s+/);
    keyword = searchUnits.pop() as string;

    // 仅当关键词长度 > 1 时才启用拼音（与油猴版一致）
    const enablePinyin = keyword.length > 1;
    const pinyinKeyword = enablePinyin ? textToPinyin(keyword) : "";

    const level0: SearchItem[] = [];
    const level1: SearchItem[] = [];
    const level2: SearchItem[] = [];

    for (const item of beforeData) {
      const titleUpper = item._titleUpper ?? String(item.title || "").toUpperCase();
      const descUpper = item._descUpper ?? String(item.desc || "").toUpperCase();
      const contentUpper =
        item._contentUpper ??
        String(`${linksToString(item.links)}${item.resource || ""}${item.vassal || ""}`)
          .substring(0, 4096)
          .toUpperCase();

      const titleHit =
        titleUpper.includes(keyword) ||
        (enablePinyin && (item._titlePinyin || "").includes(pinyinKeyword));
      if (titleHit) {
        level0.push(item);
        continue;
      }

      const descHit =
        descUpper.includes(keyword) ||
        (enablePinyin && (item._descPinyin || "").includes(pinyinKeyword));
      if (descHit) {
        level1.push(item);
        continue;
      }

      if (contentUpper.includes(keyword)) level2.push(item);
    }

    const ordered: SearchResult[] = [
      ...sortByWeight(level0).map((item) => ({ item, level: LEVEL_TITLE })),
      ...sortByWeight(level1).map((item) => ({ item, level: LEVEL_DESC })),
      ...sortByWeight(level2).map((item) => ({ item, level: LEVEL_CONTENT })),
    ];

    // 递归处理剩余关键词
    if (
      searchUnits.length > 0 &&
      searchUnits[searchUnits.length - 1].trim() !== SEARCH_BOUNDARY.trim()
    ) {
      const nextData = ordered.map((r) => r.item);
      return this._searchUnit(nextData, searchUnits.join(" "));
    }
    return ordered;
  }

  /** 精确搜索（对外） */
  accurateSearch(keyword: string): SearchResult[] {
    return this._searchUnit(this.searchData, keyword);
  }

  /**
   * 重叠匹配度搜索（还原 stringOverlapMatchingDegreeSearch）
   */
  fuzzySearch(rawKeyword: string): SearchResult[] {
    const scoreList: number[] = [];
    const matched = overlapMatchingDegreeForObjectArray<SearchItem>(
      String(rawKeyword).toUpperCase(),
      [...this.searchData],
      (item) => {
        const str2ScopeMap: Record<string, number> = {};
        str2ScopeMap[item._cleanedTitleUpper ?? ""] = 9;
        str2ScopeMap[item._descTagsUpper ?? ""] = 8;
        str2ScopeMap[(item._contentUpper ?? "").substring(0, 4096)] = 2;
        return str2ScopeMap;
      },
      { onlyHasScope: true, scopeForObjArrContainer: scoreList }
    );
    return matched.map((item, i) => ({
      item,
      level: LEVEL_FUZZY,
      score: scoreList[i],
    }));
  }

  // ========== 搜索PRO模式（子搜索模式） ==========

  /**
   * 判断是否为搜索PRO模式（还原 subSearch.isSubSearchMode）
   */
  _isProSearchMode(rawKeyword: string | null | undefined): boolean {
    return String(rawKeyword ?? "").includes(SEARCH_BOUNDARY);
  }

  /**
   * 获取父级关键词（还原 subSearch.getParentKeyword）
   */
  _getParentKeyword(rawKeyword: string | null | undefined): string {
    return String(rawKeyword ?? "").split(SEARCH_BOUNDARY)[0].trim();
  }

  /**
   * 判断数据项是否「可搜索」：URL 包含 [[...keyword...]] 模板且为 HTTP URL（还原 refreshTags）
   */
  _isSearchableItem(item: SearchItem): boolean {
    const resource = String(item.resource ?? "").trim();
    if (!resource) return false;
    // 是否 HTTP URL（粗略检测：包含 . 号）
    const isHttpUrl = /^[^\n]*\.[^\n]*$/.test(resource);
    if (!isHttpUrl) return false;
    // 是否包含 [[...keyword...]] 搜索模板
    return /\[\[[^\[\]]+keyword[^\[\]]+\]\]/.test(resource);
  }

  /**
   * PRO 模式特殊路由（还原 searchableSpecialRouting）
   * 返回 undefined 表示无特殊路由匹配，[] 表示已处理，数组表示搜索结果
   */
  async _proSearchSpecialRouting(
    parentKeyword: string
  ): Promise<SearchResult[] | undefined> {
    const kw = parentKeyword.trim();
    // 父关键词为 "问AI" → 精确搜索父关键词本身（还原 searchableSpecialRouting["^问AI$"]）
    // （原版：search(keywordForFill0, { isAccurateSearch: true })，keywordForFill0 即父关键词）
    if (kw === "问AI") {
      const processed = kw.trim().split(/\s+/).reverse().join(" ");
      return this._searchUnit(this.searchData, processed);
    }
    // 无特殊路由匹配
    // （空父关键词的 `^\s*$` → "问AI" 转发改在 _proSearch 中处理：
    //   需要把输入框改写为 "问AI : " 并重新触发搜索，与原版 triggerSearchHandle 一致）
    return undefined;
  }

  /**
   * 搜索PRO模式（还原 searchEven.event[".*"+searchBoundary+".*"]）
   * 仅搜索带有 [可搜索] 标签的数据项
   */
  async _proSearch(rawKeyword: string): Promise<SearchResult[]> {
    const parentKeyword = this._getParentKeyword(rawKeyword);

    // 先检查特殊路由
    const specialResult = await this._proSearchSpecialRouting(parentKeyword);
    // 无特殊路由但父关键词为空（输入框只有 " : "，如空内容按 Tab）：
    // 还原原版特殊路由 `^\s*$` → "问AI"：把搜索框改写为 "问AI : " 并重新触发搜索
    // （原版通过 searchableSpecialRouting["^\\s*$"] = "问AI" + triggerSearchHandle 转发实现）
    if (specialResult === undefined && /^\s*$/.test(parentKeyword.trim())) {
      this._pendingRedirectKeyword = "问AI" + SEARCH_BOUNDARY;
      return [];
    }
    if (specialResult !== undefined) {
      return specialResult;
    }

    // 普通 PRO 模式：只搜索已标记 [可搜索] 的项
    // 构造 `[可搜索] <parentKeyword>` 关键词，利用标题匹配过滤出标记项
    const proKeyword = `${SEARCH_PRO_TAG} ${parentKeyword}`;
    const processed = proKeyword.trim().split(/\s+/).reverse().join(" ");
    let result = this._searchUnit(this.searchData, processed);
    // 无结果时使用重叠匹配度兜底（仅搜索可搜索项）
    if ((result == null || result.length === 0) && parentKeyword.trim().length > 0) {
      // 对 parentKeyword 做模糊匹配，但限制在 [可搜索] 项内
      const searchableItems = this.searchData.filter((item) =>
        (item.title ?? "").includes(SEARCH_PRO_TAG)
      );
      const scoreList: number[] = [];
      const matched = overlapMatchingDegreeForObjectArray<SearchItem>(
        String(parentKeyword).toUpperCase(),
        searchableItems,
        (item) => {
          const str2ScopeMap: Record<string, number> = {};
          str2ScopeMap[item._cleanedTitleUpper ?? ""] = 9;
          str2ScopeMap[item._descTagsUpper ?? ""] = 8;
          str2ScopeMap[(item._contentUpper ?? "").substring(0, 4096)] = 2;
          return str2ScopeMap;
        },
        { onlyHasScope: true, scopeForObjArrContainer: scoreList }
      );
      result = matched.map((item, i) => ({
        item,
        level: LEVEL_FUZZY,
        score: scoreList[i],
      }));
    }
    return result || [];
  }

  /** 搜索路由（还原 searchEven.event 与 searchAOP） */
  async search(rawKeyword: string | null | undefined): Promise<SearchResult[]> {
    const raw = String(rawKeyword ?? "");

    // PRO模式（子搜索模式）：关键词包含 SEARCH_BOUNDARY（ : ）
    if (this._isProSearchMode(raw)) {
      const result = await this._proSearch(raw);
      // 特殊路由 `^\s*$` → "问AI" 转发（还原 searchableSpecialRouting["^\\s*$"]）：
      // 引擎通知主流程把输入框改写为 "问AI : " 并重新触发搜索
      if (this._pendingRedirectKeyword != null) {
        const redirect = this._pendingRedirectKeyword;
        this._pendingRedirectKeyword = null;
        this.onRedirect?.(redirect);
      }
      return result;
    }

    // 特殊关键词直达
    const special = this._specialSearch(raw);
    if (special) return special;

    // 逆序处理多关键词（与油猴版一致：rawKeyword.trim().split(/\s+/).reverse().join(" ")）
    const processedKeyword = raw.trim().split(/\s+/).reverse().join(" ");

    let result = this._searchUnit(this.searchData, processedKeyword);
    // 精确无结果时，使用重叠匹配度兜底
    if ((result == null || result.length === 0) && raw.trim().length > 0) {
      result = this.fuzzySearch(raw);
    }
    return result || [];
  }

  _specialSearch(rawKeyword: string): SearchResult[] | null {
    const kw = rawKeyword.trim().toLowerCase();
    if (kw === SPECIAL_KEYWORD.highFrequency.toLowerCase()) {
      return highFrequencyList(this.searchData, 45).map((item) => ({
        item,
        level: LEVEL_TITLE,
      }));
    }
    if (kw === SPECIAL_KEYWORD.history.toLowerCase()) {
      return historyList(15).map((item) => ({ item, level: LEVEL_TITLE }));
    }
    if (kw === SPECIAL_KEYWORD.new.toLowerCase()) {
      return buildNewItemsResult(this.searchData);
    }
    return null;
  }
}
