/**
 * 搜索主窗口的状态与业务逻辑（组合式封装）
 *
 * 由原 main.js 的全局 `state` + 各流程函数迁移而来：
 * - 搜索引擎实例与订阅加载（loadSubscribes / loadAllData）
 * - 输入防抖搜索（doSearch / debouncedSearch / resolveEnterTarget）
 * - 视图模式（WAIT_SEARCH / SHOW_RESULT / SHOW_ITEM_DETAIL）
 * - 占位提示（setPlaceholder / restoreLoadingPlaceholderIfNeeded）
 * - 缓存后台自动刷新调度（scheduleCacheRefresh / triggerSilentRefresh）
 * - 订阅变化/缓存清理检测（reloadIfSubscribesChanged）
 */
import { reactive, computed, ref } from "vue";
import { SearchEngine, SEARCH_BOUNDARY, UNFOLLOW_KEY, DEFAULT_UNFOLLOW, type SearchResult } from "../../lib/search-engine";
import { parseAllDesignatedSingTags, subscribeItemsToText } from "../../lib/subscribe-parser";
import type { DesignatedSingTag } from "../../lib/subscribe-parser";
import {
  debounce,
  storageGet,
  storageSet,
  storageRemove,
  resolvePlaceholder,
  placeholderProgressText,
  PLACEHOLDER_DEFAULT_TEXT,
  PLACEHOLDER_PREPARING_TEXT,
  PLACEHOLDER_RESTORE_MS,
  PLACEHOLDER_PREPARE_MS,
} from "../../lib/util";
import { setWindowHeight, getDefaultSubscribeText } from "../../lib/tauri-bridge";
import type { SubscribeItem } from "../../types/index";

/** 订阅原文存储键（与配置窗口共享） */
export const SUBSCRIBES_STORAGE_KEY = "subscribes";

/** 搜索框（含边框）高度 */
export const BOX_HEIGHT = 48;
/** 结果区上下 padding（#matchItems: 0 15px 5px） */
export const LIST_PADDING = 5;
/** 搜索结果列表固定最多可见条数（还原脚本 showSize=15） */
export const SHOW_SIZE = 15;

/** 视图模式（还原 modeEnum） */
export const MODE = {
  WAIT_SEARCH: 0,
  SHOW_RESULT: 1,
  SHOW_ITEM_DETAIL: 2,
} as const;

/** 订阅文本（tis 原文）→ 订阅条目数组 */
export function subscribeTextToItems(text: string): SubscribeItem[] {
  return parseAllDesignatedSingTags(String(text || ""), "tis").map((tis: DesignatedSingTag) => ({
    url: tis.tabValue,
    title: tis.title || tis.tabValue,
    describe: tis.describe || "",
    fetchFun: tis.fetchFun,
    defaultTag: tis["default-tag"],
  }));
}

export function useSearchState() {
  const state = reactive({
    subscribes: [] as SubscribeItem[],
    /** 订阅原文（tis 文本，配置窗口保存的同一份数据） */
    subscribeText: "",
    /** 当前结果 [{item, level, score?}] */
    results: [] as SearchResult[],
    /** 当前键盘选中项（-1 表示无选中，按方向键才激活） */
    activeIndex: -1,
    /** 视图模式 */
    mode: MODE.WAIT_SEARCH as number,
    rawKeyword: "",
    loading: false,
    /** 上次加载时的「不关注标签」快照：变化时需重新加载（缓存随之失效） */
    unfollowSnapshot: "",
    /** 「缓存被外部清理后重载」的时间保护，避免异常情况下反复重拉 */
    cacheReloadGuardAt: 0,
  });

  /** 搜索序号（防竞态，非响应式） */
  let searchSeq = 0;
  /** 缓存后台刷新定时器 */
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** 是否处于静默后台刷新模式（不更新界面提示） */
  let silentRefresh = false;

  // ============== 子搜索模式状态（还原 registry.searchData.subSearch + searchHistory） ==============
  /** 是否已经进入子搜索模式（还原 subSearch.isEnteredSubSearchMode） */
  let subSearchEntered = false;
  /** 最近一次搜索关键词（还原 searchHistory.history[0]） */
  let lastKeyword = "";

  /** 是否处于子搜索模式（还原 subSearch.isSubSearchMode） */
  function isSubSearchMode(keyword: string | null | undefined): boolean {
    return String(keyword ?? "").includes(SEARCH_BOUNDARY);
  }

  /** 取父关键词（还原 subSearch.getParentKeyword） */
  function parentKeywordOf(keyword: string | null | undefined): string {
    return String(keyword ?? "").split(SEARCH_BOUNDARY)[0].trim();
  }

  /** 维护子搜索「进入 / 退出」状态（还原 searchHistory.add） */
  function recordKeyword(rawKeyword: string): void {
    if (!rawKeyword) return;
    if (rawKeyword !== SEARCH_BOUNDARY && rawKeyword.endsWith(SEARCH_BOUNDARY)) {
      subSearchEntered = true;
    } else if (subSearchEntered && !rawKeyword.includes(SEARCH_BOUNDARY)) {
      subSearchEntered = false;
    }
    lastKeyword = rawKeyword;
  }

  /**
   * 判断是否只是在「编辑子关键词」（还原油猴版 handler 开头的守卫）：
   * 已进入子搜索模式、当前仍是子搜索模式、且父关键词与最近一次真实搜索相同
   * → 用户只是在改「父关键词 : 子关键词」的后半段，不重新搜索、也不能退出脚本视图。
   *
   * 这是脚本应用（如「问AI」）第二步的关键：在脚本视图里输入「问AI : 你好」时，
   * 输入事件不会把视图切走，脚本会话与会话监听器得以存活，回车才能把「你好」推给应用。
   */
  function isSubKeywordEditing(rawKeyword: string): boolean {
    return (
      subSearchEntered &&
      isSubSearchMode(rawKeyword) &&
      parentKeywordOf(lastKeyword) === parentKeywordOf(rawKeyword)
    );
  }

  const engine = new SearchEngine();

  // PRO 模式特殊路由 `^\s*$` → "问AI" 转发：把输入框改写为 "问AI : " 并重新触发搜索
  // （原版通过 registry.searchData.triggerSearchHandle("问AI" + searchBoundary) 实现）
  let redirectHandler: ((keyword: string) => void) | null = null;
  engine.onRedirect = (keyword) => {
    redirectHandler?.(keyword);
  };
  /** 注册特殊路由转发处理（由 App.vue 设置：改写输入框 + 重新搜索） */
  function onRedirect(handler: (keyword: string) => void): void {
    redirectHandler = handler;
  }

  // ============== 占位提示 ==============
  const placeholder = ref(PLACEHOLDER_DEFAULT_TEXT);
  let placeholderRestoreTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 设置搜索框占位提示。
   *
   * 严格对齐油猴版 `searchPlaceholder(target, placeholder, duration)`：
   * 每次设置都**重置**恢复计时（原版先 clearTimeout 再 setTimeout），
   * 计时结束后自动恢复为默认提示「我的搜索」。因此进度类提示不会一直卡住。
   *
   * autoRestoreMs <= 0 表示常驻（仅用于「数据为空」这类需要用户处理的异常提示）。
   */
  function setPlaceholder(text: string, autoRestoreMs = 0): void {
    if (text == null) return;
    if (placeholderRestoreTimer != null) {
      clearTimeout(placeholderRestoreTimer);
      placeholderRestoreTimer = null;
    }
    placeholder.value = text;
    if (autoRestoreMs > 0) {
      placeholderRestoreTimer = setTimeout(() => {
        placeholderRestoreTimer = null;
        resetPlaceholder();
      }, autoRestoreMs);
    }
  }

  /** 恢复搜索框默认占位提示 */
  function resetPlaceholder(): void {
    placeholder.value = PLACEHOLDER_DEFAULT_TEXT;
  }

  /** 展示加载进度（文案为 `🔁 数据库更新到 N条`） */
  function showLoadProgress(count: number): void {
    setPlaceholder(placeholderProgressText(count), PLACEHOLDER_RESTORE_MS);
  }

  /**
   * 重新应用当前占位提示。
   *
   * 关键修复：呼出搜索框 / 复位视图会把搜索框清空，如果此时数据仍在加载，
   * 必须重新把「加载中」提示显示出来，否则「清理缓存 → 立即呼出搜索框」时
   * 看起来就像在静默加载（搜索框没有任何加载反馈）。
   */
  function restoreLoadingPlaceholderIfNeeded(): void {
    if (!state.loading) {
      resetPlaceholder();
      return;
    }
    // 数据块未就绪 → 准备中提示（duration=5000）；已有数据块 → 进度提示（duration=1200）
    const { text, restoreMs } = resolvePlaceholder({
      loading: true,
      preparing: engine.loadedCount === 0,
      count: engine.searchData.length,
      restoreMs: PLACEHOLDER_RESTORE_MS,
      prepareMs: PLACEHOLDER_PREPARE_MS,
    });
    setPlaceholder(text, restoreMs);
  }

  function updatePlaceholder(fromCache = false): void {
    const count = engine.searchData.length;
    const failed = engine.failedUrls.length;
    const { text, restoreMs } = resolvePlaceholder({
      loading: false,
      count,
      failed,
      fromCache,
      restoreMs: PLACEHOLDER_RESTORE_MS,
    });
    setPlaceholder(text, restoreMs);
  }

  // ============== 搜索 ==============
  /** 由 App.vue 注入：搜索完成后由视图测量并下发窗口高度 */
  let afterResultsRendered: (() => void) | null = null;

  function bindAfterResultsRendered(handler: () => void): void {
    afterResultsRendered = handler;
  }

  /**
   * 执行搜索（输入防抖后的真正搜索）。
   * 空关键词 → 清空结果；PRO 模式空父关键词 → 由上层的 onRedirect 改写输入并重搜。
   */
  async function doSearch(rawKeyword: string): Promise<SearchResult[]> {
    state.rawKeyword = rawKeyword;
    const seq = ++searchSeq;

    // 真正的空关键词 → 清空结果。
    // 注意：边界符本身（" : "，空内容按 Tab 后的值）不能在这里短路——
    // 原版会进入 PRO 模式路由并把关键词转发为 "问AI : "（searchableSpecialRouting["^\\s*$"]），
    // 需要交给引擎触发转发。
    if (rawKeyword.trim() === "") {
      state.results = [];
      state.activeIndex = -1;
      state.mode = MODE.WAIT_SEARCH;
      afterResultsRendered?.();
      return [];
    }

    // 执行检索。注：原版用 searchEven.isSearching 在搜索中跳过失焦隐藏，
    // 桌面版失焦隐藏已改为无条件（见 README「失焦隐藏」），因此不再维护这个状态位。
    let results: SearchResult[];
    try {
      results = await engine.search(rawKeyword);
    } catch (e) {
      console.error("[我的搜索] 搜索失败:", e);
      results = [];
    }
    // 竞态：已有更新的搜索
    if (seq !== searchSeq) return state.results;

    state.results = results || [];
    state.activeIndex = -1;
    state.mode = state.results.length > 0 ? MODE.SHOW_RESULT : MODE.WAIT_SEARCH;
    afterResultsRendered?.();
    return state.results;
  }

  // 防抖搜索（300ms，与油猴版一致）。回车时会 flush 立即取结果，
  // 避免「输入就回车」因防抖未触发而找不到第一项。
  const debouncedSearch = debounce((v: string) => {
    void doSearch(v);
  }, 300);

  /** 输入处理（还原油猴版 handler：编辑子关键词时不重搜，保住脚本视图） */
  function onInput(value: string): void {
    if (isSubKeywordEditing(value)) {
      // 原版 keyup 会把当前输入写入全局 keyword（供 [[{keyword}]] 模板填充），
      // 但不重新搜索：结果集保持「刚按 Tab 进入子搜索模式」时的内容。
      state.rawKeyword = value;
      return;
    }
    recordKeyword(value);
    debouncedSearch(value);
  }

  /**
   * 回车时取得当前应当作用的结果项（还原原版 `pos==0 → pos=1` 语义）。
   * - 防抖搜索还未触发（“输入就回车”）→ 先立即搜索
   * - 无上下选择 → 默认第一项
   */
  async function resolveEnterTarget(inputValue: string): Promise<SearchResult | null> {
    // 输入内容与当前结果不同步（防抖未触发 / 结果过期）→ 立即搜索一次
    if (debouncedSearch.pending() || inputValue !== state.rawKeyword) {
      debouncedSearch.cancel();
      await doSearch(inputValue);
    }
    const index = state.activeIndex === -1 ? 0 : state.activeIndex;
    return state.results[index] || null;
  }

  // ============== 订阅加载 ==============
  async function loadSubscribes(): Promise<void> {
    let text = storageGet<string | SubscribeItem[] | null>(SUBSCRIBES_STORAGE_KEY, null);
    // 兼容旧版：结构化数组 → tis 原文
    if (Array.isArray(text)) {
      text = subscribeItemsToText(text);
      storageSet(SUBSCRIBES_STORAGE_KEY, text);
    }
    if (typeof text !== "string" || text.trim() === "") {
      try {
        text = await getDefaultSubscribeText();
      } catch (e) {
        text = "";
      }
      storageSet(SUBSCRIBES_STORAGE_KEY, text);
    }
    state.subscribeText = text as string;
    state.subscribes = subscribeTextToItems(text as string);
  }

  async function loadAllData(force = false, silent = false): Promise<void> {
    // 缓存指纹需要订阅列表：订阅变化会让缓存失效
    engine.subscribes = state.subscribes;
    // 缓存有效（未过期 且 订阅未变）→ 直接复用本地缓存，不发起网络加载
    const fromCache = !force && engine.isCacheValid();
    if (!fromCache) {
      state.loading = true;
      if (silent) {
        // 静默后台刷新：不更新界面占位提示和进度回调
        engine.onProgress = null;
      } else {
        // 进度回调：每解析完一个内容源都会调用（还原原版 refreshNewData 的 searchPlaceholder("UPDATE")）
        // 同时把已加载到的数据重新搜一遍，让用户输入后立即能搜到已到位的部分
        engine.onProgress = (count) => {
          // 关键：加载中即使搜索框被清空（呼出复位），也要继续显示进度
          if (state.loading) showLoadProgress(count);
          if (currentInputValue() && currentInputValue().trim()) {
            void doSearch(currentInputValue());
          }
        };
        // 准备中提示：还原 dataInitFun 的 `searchPlaceholder("UPDATE","🔁 数据准备更新中...",5000)`
        setPlaceholder(PLACEHOLDER_PREPARING_TEXT, PLACEHOLDER_PREPARE_MS);
      }
    } else {
      engine.onProgress = null;
    }
    try {
      // 引擎内部再来一次"缓存有效判断"：用缓存则立即挂载，否则全量重新加载
      await engine.initData(state.subscribes, { force });
    } catch (e) {
      console.error("[我的搜索] 加载订阅失败:", e);
    }
    state.loading = false;
    engine.onProgress = null;
    state.unfollowSnapshot = currentUnfollowSnapshot();
    if (!silent) {
      // 非静默模式才更新界面占位提示
      updatePlaceholder(fromCache);
    }
    // 若已有输入，重新搜索一次（还原原版数据更新后的 triggerSearchHandle）
    const value = currentInputValue();
    if (value && value.trim()) void doSearch(value);

    // 每次数据加载完成后调度后台缓存自动刷新（仅非静默模式，
    // 静默模式自身在 finally 中调度，避免重复）
    if (!silent) scheduleCacheRefresh();
  }

  /** 由 App.vue 注入：读取输入框当前值 */
  let inputValueGetter: (() => string) | null = null;
  function bindInputValueGetter(getter: () => string): void {
    inputValueGetter = getter;
  }
  function currentInputValue(): string {
    return inputValueGetter?.() ?? "";
  }

  /** 当前「不关注标签」列表快照（用于判断配置窗口中标签是否变化） */
  function currentUnfollowSnapshot(): string {
    const stored = storageGet<string[] | null>(UNFOLLOW_KEY, null);
    return JSON.stringify(Array.isArray(stored) ? stored : DEFAULT_UNFOLLOW);
  }

  // ============== 缓存后台自动刷新 ==============
  /**
   * 「缓存过期前提前刷新」的阈值：缓存剩余时间少于该值时触发后台静默刷新（默认 1 小时）。
   * 设为 0 表示仅在缓存已过期时才刷新（下次呼出时触发，与旧行为一致）。
   */
  const CACHE_REFRESH_AHEAD_MS = 60 * 60 * 1000;
  /** 后台检查缓存状态的间隔（默认 30 分钟检查一次） */
  const CACHE_REFRESH_CHECK_INTERVAL_MS = 30 * 60 * 1000;

  /**
   * 检查并启动缓存后台自动刷新调度。
   *
   * 逻辑：
   * 1. 若缓存已过期（expire <= now）→ 立即执行一次静默刷新
   * 2. 若缓存即将过期（剩余时间 < CACHE_REFRESH_AHEAD_MS）→ 立即执行一次静默刷新
   * 3. 否则按 CACHE_REFRESH_CHECK_INTERVAL_MS 周期检查，
   *    一旦 expire - now <= CACHE_REFRESH_AHEAD_MS 就触发刷新
   */
  function scheduleCacheRefresh(): void {
    // 清理已有定时器
    if (refreshTimer != null) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }

    const expire = engine.getCacheExpireMs();
    const now = Date.now();
    const remain = expire > 0 ? expire - now : 0;

    // 无缓存 或 缓存尚早才需要定时检查
    if (expire <= 0 || remain > CACHE_REFRESH_AHEAD_MS) {
      // 有缓存但还很新鲜 → 等到剩余时间进入阈值再刷
      const waitMs =
        expire > 0 && remain > CACHE_REFRESH_AHEAD_MS
          ? Math.min(remain - CACHE_REFRESH_AHEAD_MS, CACHE_REFRESH_CHECK_INTERVAL_MS)
          : CACHE_REFRESH_CHECK_INTERVAL_MS;
      refreshTimer = setTimeout(() => {
        // 定时检查到了，无论什么状态都执行一次刷新判断
        void triggerSilentRefresh();
      }, waitMs);
      return;
    }

    // 缓存已过期或即将过期 → 立即静默刷新
    console.log("[我的搜索] 缓存即将过期，触发后台静默刷新");
    void triggerSilentRefresh();
  }

  /**
   * 执行一次静默后台刷新（不更新界面占位提示，不干扰用户操作）。
   * 刷新完成后自动重新调度下一轮检查。
   */
  async function triggerSilentRefresh(): Promise<void> {
    // 已有加载在途 或 正在静默刷新中 → 跳过
    if (state.loading || silentRefresh) return;
    // 无订阅 → 无法加载
    if (!state.subscribes || state.subscribes.length === 0) return;
    silentRefresh = true;
    try {
      await loadAllData(true, true);
      console.log("[我的搜索] 后台静默刷新完成");
    } catch (e) {
      console.warn("[我的搜索] 后台静默刷新失败:", e);
    } finally {
      silentRefresh = false;
      // 无论如何，重新调度下一轮检查
      scheduleCacheRefresh();
    }
  }

  /**
   * 从配置窗口回来时检测是否需要重载（订阅变化 / 标签变化 / 缓存被清理）。
   * @param fromShow 是否由「呼出搜索框」触发（此时窗口正在显示，跳过 visibilityState 检查）
   */
  function reloadIfSubscribesChanged(fromShow = false): void {
    if (!fromShow && typeof document !== "undefined" && document.visibilityState === "hidden") {
      return;
    }
    // 已有加载在途：不重复发起（呼出时可能紧跟在一次焦点触发之后）
    if (state.loading) return;
    const text = storageGet<string | null>(SUBSCRIBES_STORAGE_KEY, "");
    const subscribesChanged = typeof text === "string" && text !== state.subscribeText;
    const unfollowChanged = currentUnfollowSnapshot() !== state.unfollowSnapshot;
    // 主窗口已挂载数据，但缓存已失效（例如在订阅管理里点了「清理缓存」）
    const cacheCleared = engine.searchData.length > 0 && !engine.isCacheValid();
    if (subscribesChanged) {
      state.subscribeText = text as string;
      state.subscribes = subscribeTextToItems(text as string);
    }
    const needReload = subscribesChanged || unfollowChanged || cacheCleared;
    if (!needReload) return;
    // 保护：3 秒内最多因「缓存被清理」重载一次，避免写缓存失败时反复拉取
    const now = Date.now();
    if (cacheCleared && now - state.cacheReloadGuardAt < 3000) return;
    state.cacheReloadGuardAt = now;
    void loadAllData(true);
  }

  /**
   * 托盘菜单「清理缓存」（Rust 端转发事件）：
   * 删除订阅数据缓存 + 订阅指纹（均可由订阅重新构建）。
   * 主窗口已挂载数据时立即丢弃旧数据并重新加载；
   * 否则下次呼出时 reloadIfSubscribesChanged 检测到缓存失效会自动重载。
   */
  function clearRebuildableCache(): void {
    storageRemove("SEARCH_DATA_KEY");
    storageRemove("SUBSCRIBE_FINGERPRINT_CACHE_KEY");
    console.log("[我的搜索] 已通过托盘清理可重建的数据缓存");
    if (engine.searchData.length > 0 && !state.loading) {
      void loadAllData(true);
    }
  }

  /** 键盘移动选中项 */
  function moveActive(delta: number): void {
    const total = Math.min(state.results.length, SHOW_SIZE);
    if (total <= 0) return;
    if (state.activeIndex === -1) {
      // 首次通过键盘选择：向下选第一个，向上选最后一个
      state.activeIndex = delta > 0 ? 0 : total - 1;
    } else {
      state.activeIndex = (state.activeIndex + delta + total) % total;
    }
  }

  /** 收起窗口到仅显示搜索框的高度 */
  function resetWindowToBoxHeight(): void {
    void setWindowHeight(BOX_HEIGHT);
  }

  /** 可见结果列表（最多 SHOW_SIZE 条） */
  const visibleResults = computed(() => state.results.slice(0, SHOW_SIZE));

  return {
    state,
    engine,
    placeholder,
    visibleResults,
    // 生命周期/绑定
    onRedirect,
    bindInputValueGetter,
    bindAfterResultsRendered,
    // 搜索
    doSearch,
    debouncedSearch,
    onInput,
    isSubKeywordEditing,
    parentKeywordOf,
    resolveEnterTarget,
    moveActive,
    // 订阅与缓存
    loadSubscribes,
    loadAllData,
    reloadIfSubscribesChanged,
    clearRebuildableCache,
    scheduleCacheRefresh,
    triggerSilentRefresh,
    restoreLoadingPlaceholderIfNeeded,
    resetWindowToBoxHeight,
    // 常量
    MODE,
    BOX_HEIGHT,
    SHOW_SIZE,
    SEARCH_BOUNDARY,
  };
}

export type SearchStateApi = ReturnType<typeof useSearchState>;
