<script setup lang="ts">
/**
 * 搜索主窗口根组件（原 main.js 的 renderApp + bindEvents + 各流程）。
 *
 * 结构（DOM 与原版 HTML 完全一致，供既有测试与 CSS 复用）：
 *   #my_search_box
 *     > #tis
 *     > #my_search_view
 *         > SearchBox (#searchBox)
 *         > #matchResult > ResultList (#matchItems)
 *         > DetailView (#text_show)
 *
 * 职责：
 * - 键盘交互（↑↓ / Enter / Ctrl+Enter / Esc / Tab / Backspace / ::(PRO 模式)）
 * - 打开数据项（脚本项 / 简述文本 / URL 模板填充）
 * - 窗口高度（结果区实测高度、详情视图自适应、复位）
 * - 呼出分支（详情视图原样还原 / 其它复位）
 * - 缓存清理与订阅变化重载
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import SearchBox from "./SearchBox.vue";
import ResultList from "./ResultList.vue";
import DetailView, { type DetailContent } from "./DetailView.vue";
import { useSearchState, MODE, BOX_HEIGHT } from "./useSearchState";
import { useUpdateChecker } from "./useUpdateChecker";
import { useScriptHost } from "./useScriptHost";
import { isUrl, clearUrlSearchTemplate } from "../../lib/util";
import {
  openExternal,
  openConfigWindow,
  hideWindow,
  setWindowHeight,
  onMainWindowShown,
  onClearCache,
  onWindowFocusChanged,
  isWindowVisible,
  isTauri,
} from "../../lib/tauri-bridge";
import { SEARCH_BOUNDARY, SPECIAL_KEYWORD, scoreSelect, historySelect } from "../../lib/search-engine";
import type { SearchItem } from "../../types/index";

const search = useSearchState();
const update = useUpdateChecker();
const { state, engine, placeholder, visibleResults } = search;

/** 详情视图内容（null = 未打开） */
const detail = ref<DetailContent | null>(null);
/** 详情视图是否显示 */
const detailVisible = ref(false);

const searchBoxRef = ref<InstanceType<typeof SearchBox> | null>(null);
const detailRef = ref<InstanceType<typeof DetailView> | null>(null);

/** 输入框值（v-model） */
const inputValue = ref("");

/** 结果列表是否显示（在非详情视图且有结果时展示） */
const resultVisible = computed(
  () => !detailVisible.value && state.results.length > 0 && state.mode === MODE.SHOW_RESULT
);

// ============== 脚本宿主 ==============
const scriptHost = useScriptHost({
  engine,
  fitHeight: () => detailRef.value?.fitHeight(),
  flushHeight: () => detailRef.value?.flushHeight(),
  hideTextView: () => hideTextView(),
  doSearch: (kw) => void search.doSearch(kw),
  // 脚本视图挂载完成后自动转发子关键词（读/写搜索框）
  getInputValue: () => inputValue.value,
  setInputValue: (kw) => {
    inputValue.value = kw;
  },
});

// ============== 视图高度 ==============
/** 由内容决定高度：渲染完成后实测 #my_search_box 的 offsetHeight 并下发 */
async function syncWindowHeightToContent(): Promise<void> {
  await nextTick();
  const box = document.getElementById("my_search_box");
  if (!box) {
    void setWindowHeight(BOX_HEIGHT);
    return;
  }
  void setWindowHeight(box.offsetHeight);
}

/** 收起窗口到搜索框高度 */
function collapseToBoxHeight(): void {
  void setWindowHeight(BOX_HEIGHT);
}

// ============== 视图切换 ==============
/** 结束脚本视图会话 + 关闭详情视图 */
function hideTextView(): void {
  scriptHost.clearScriptSession();
  detailVisible.value = false;
  state.mode = state.results.length > 0 ? MODE.SHOW_RESULT : MODE.WAIT_SEARCH;
  void nextTick(() => {
    if (state.results.length > 0) {
      void syncWindowHeightToContent();
    } else {
      collapseToBoxHeight();
    }
  });
}

/** 显示文本详情（简述内容 / 附加内容） */
function showTextView(title: string, desc: string, body: string): void {
  scriptHost.clearScriptSession();
  detail.value = { kind: "text", title, desc, body };
  detailVisible.value = true;
  state.mode = MODE.SHOW_ITEM_DETAIL;
}

/** 显示脚本视图 */
function showScriptView(item: SearchItem): void {
  detail.value = { kind: "script", title: item.title ?? "", desc: "脚本项", body: "", item };
  detailVisible.value = true;
  state.mode = MODE.SHOW_ITEM_DETAIL;
}

/**
 * 复位到初始视图：清空输入/结果/详情，并把窗口收回到搜索框高度。
 *
 * 呼出（隐藏前非详情视图）与点击 URL 结果时调用。
 */
function resetToInitialView(): void {
  detailVisible.value = false;
  detail.value = null;
  inputValue.value = "";
  state.results = [];
  state.activeIndex = -1;
  state.rawKeyword = "";
  state.mode = MODE.WAIT_SEARCH;
  search.debouncedSearch.cancel();
  scriptHost.clearScriptSession();
  // 复位时不要无条件刷回默认提示：若订阅数据仍在加载中，
  // 必须继续显示「正在加载订阅数据...」，否则会表现为静默加载。
  search.restoreLoadingPlaceholderIfNeeded();
  collapseToBoxHeight();
}

/**
 * 呼出时的视图分支（用户规则）：
 * - 隐藏前是详情视图 → 失焦只是「先隐藏」，再次呼出**原样还原**（DOM 未销毁、输入框未动）
 * - 其它状态（等待搜索 / 结果列表）→ 交给 resetToInitialView() 复位
 * @returns true=详情视图已原样还原（调用方跳过复位）
 */
function resumeDetailViewIfAny(): boolean {
  if (state.mode !== MODE.SHOW_ITEM_DETAIL || !detailVisible.value) return false;
  // 原样还原：窗口高度贴回内容。
  // 隐藏时 Rust 侧已把窗口物理收回到 48px，因此必须强制重新下发高度：
  // 先清掉 fitTextViewHeight 的去重缓存，再重新测量。
  detailRef.value?.resetHeightCache();
  void nextTick(() => {
    detailRef.value?.reapply();
    detailRef.value?.flushHeight();
  });
  return true;
}

// ============== 打开数据项 ==============
/** 将展示项解析回规范化数据项（临时克隆项如 <new> 也能定位到原数据） */
function resolveItem(item: SearchItem | null | undefined): SearchItem | null {
  if (item == null) return null;
  if (item.index != null && engine.searchData[item.index]) {
    return engine.searchData[item.index];
  }
  return item;
}

/** 结果项展开原项（供图标使用） */
function resolveRefItem(item: SearchItem): SearchItem {
  const resolved = engine.searchData[item.index ?? -1];
  return resolved || item;
}

/**
 * 处理 [[...]] 搜索模板（完全还原原版 li>a 点击中的 URL 构造）：
 * - 关键词按 `" : "` 分隔后取「子搜索」部分（即分隔符之后的内容），填入 `{keyword}`
 * - 原版是按 `":"` 切分并丢弃最后一段，再 join(":")，以兼容关键词里本身带冒号
 * - 带 {-keyword-} 且子搜索为空时，去掉整个模板直接跳基础地址
 */
function buildRealUrl(initUrl: string): string {
  let url = String(initUrl || "");
  // 与油猴版一致：按 ":" 切分，丢掉最后一段（分隔符之后的部分），剩余 join 回去
  const keyword = String(state.rawKeyword).split(":").reverse();
  keyword.pop();
  const realKeyword = keyword.reverse().join(":").trim();
  url = url.replace(/\[\[([^\[\]]*)\]\]/g, (m, inner: string) =>
    inner.replace(/{keyword}/g, realKeyword).replace(/\[\[+|\]\]+/g, "")
  );
  // 子搜索为空 → 去掉搜索模板
  const parts = String(state.rawKeyword).split(SEARCH_BOUNDARY);
  if (parts.length < 2 || (parts[1] || "").trim() === "") {
    url = clearUrlSearchTemplate(initUrl);
  }
  // 订阅数据里的 resource 常带结尾换行/空白，直接传给系统打开会失败
  return url.trim();
}

/**
 * 打开数据项（还原原版点击 `a.enter_main_link` 的行为）：
 * - 脚本项 → 执行脚本
 * - 非 URL（简述文本）→ 显示简述内容
 * - URL → 构造真实跳转地址并打开（[[...{keyword}...]] 用子搜索关键词填充）
 *
 * 注意：**附加内容（vassal）不在此处理**，由 openVassal 单独处理。
 */
function openItem(rawItem: SearchItem | null | undefined): void {
  const item = resolveItem(rawItem);
  if (item == null) return;
  // 点击加分 + 记录历史（使用原数据项的标题/描述作为 key）
  scoreSelect(item);
  historySelect(item);

  // 脚本项（包含快捷搜索脚本）
  if (item.type === "script") {
    handleScriptItem(item);
    return;
  }
  // 非 URL（简述文本）→ 显示简述内容
  if (!isUrl(item.resource)) {
    showTextView(item.title ?? "", item.desc ?? "", item.resource ?? "");
    return;
  }
  // URL → 构造真实跳转地址并打开
  const realUrl = buildRealUrl(item.resource ?? "");
  if (realUrl) {
    // 还原原版：点击 URL 项时先 viewVisibilityController(false) 收起视图，
    // 再 window.open(url) 打开链接。因此“点结果 → 搜索框消失”是显式行为。
    resetToInitialView();
    void hideWindow();
    void openExternal(realUrl);
  }
}

/** 展示附加内容（还原原版点击 a.vassal / Ctrl+回车 的行为） */
function openVassal(rawItem: SearchItem | null | undefined): void {
  const item = resolveItem(rawItem);
  if (item == null || item.vassal == null) return;
  scoreSelect(item);
  historySelect(item);
  showTextView(item.title ?? "", "主项的相关/附加内容", item.vassal);
}

/** 脚本项处理（还原 showView 分支） */
function handleScriptItem(item: SearchItem): void {
  const ro = item.resourceObj || {};
  const script = ro.script || "";
  // 特殊：快捷搜索脚本（触发 <new>/<history>/<highFrequency>）
  const specialMatch = script.match(/specialKeyword\.(\w+)/);
  if (specialMatch) {
    const key = SPECIAL_KEYWORD[specialMatch[1] as keyof typeof SPECIAL_KEYWORD];
    if (key) {
      inputValue.value = key;
      void search.doSearch(key);
      return;
    }
  }
  // 需挂载视图的脚本项
  if (scriptHost.hasScriptView(ro)) {
    runScriptItem(item);
    return;
  }
  // 其它脚本项：显示其脚本说明与附加内容
  showTextView(item.title ?? "", "脚本项", item.vassal || ro.script || "（脚本项）");
}

/** 运行脚本项（还原 Function('obj', `(${jscript})(obj)`)({...})） */
function runScriptItem(item: SearchItem): void {
  // 先切到脚本视图（渲染 .script-view 容器），再执行 script 段
  showScriptView(item);
  void nextTick(() => {
    const verdict = scriptHost.runScriptItem(item, (afterCallback) => {
      const host = document.querySelector<HTMLElement>("#text_show .script-view");
      const owner = document.getElementById("text_show");
      if (host && owner) {
        scriptHost.mountScriptView(item, host, owner, afterCallback);
        detailRef.value?.onScriptMounted();
      }
    });
    if (!verdict.ok) {
      const host = document.getElementById("text_show");
      if (host) {
        const tip = document.createElement("div");
        tip.className = "script-view-tip";
        tip.textContent = "脚本视图运行出错，已显示其 HTML 内容。";
        host.prepend(tip);
      }
    }
  });
}

// ============== 键盘交互 ==============
function onInput(v: string): void {
  if (state.mode === MODE.SHOW_ITEM_DETAIL) {
    // 脚本视图展示中，且用户只是在「父关键词 : 子关键词」里改后半段
    // （还原油猴版 handler 开头的守卫）：不退出详情视图、不重搜，
    // 否则脚本会话会被销毁，「问AI : 你好」的「你好」就传不进应用。
    if (search.isSubKeywordEditing(v)) {
      search.onInput(v); // 只记录输入、不重搜（保住脚本视图）
      return;
    }
    // 进入普通搜索前先退出详情视图（恢复结果区与窗口高度）
    hideTextView();
  }
  search.onInput(v);
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    search.moveActive(1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    search.moveActive(-1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    // 脚本视图展示中：回车 = 把子搜索关键词推送给脚本应用
    // （还原 registry.script.tryRunTextViewHandler；推成功就不执行结果项点击）
    const pushed = scriptHost.tryRunScriptTextViewHandler(inputValue.value);
    if (pushed.handled) {
      // 清掉子搜索部分，只留「父关键词 : 」（原版 input.val(rawKeyword.replace(msg,""))）
      inputValue.value = pushed.nextKeyword;
      return;
    }
    // 无上下选择（activeIndex === -1）时，回车默认作用于第一项；
    // 防抖搜索尚未触发（“输入就回车”）时先立即搜索再取第一项。
    // （还原原版：`pos == 0` 时置 `pos = 1`，即“搜索后回车相当于点击第一个”）
    void search.resolveEnterTarget(inputValue.value).then((result) => {
      if (!result) return;
      if (e.ctrlKey) {
        // Ctrl+回车 = 点击“附加内容”（还原原版 activeItem.find(".vassal")[0]?.click()）
        openVassal(result.item);
      } else {
        // 回车 = 点击主链接（URL 会按子搜索关键词填充 [[...]] 模板后打开）
        openItem(result.item);
      }
    });
  } else if (e.key === "Escape") {
    e.preventDefault();
    if (state.mode === MODE.SHOW_ITEM_DETAIL) {
      hideTextView();
    } else {
      void hideWindow();
    }
  } else if (e.key === "Tab") {
    e.preventDefault();
    if (!e.shiftKey) {
      if (!inputValue.value.includes(SEARCH_BOUNDARY)) {
        inputValue.value = inputValue.value.toUpperCase() + SEARCH_BOUNDARY;
        onInput(inputValue.value);
      }
    } else {
      if (inputValue.value.includes(SEARCH_BOUNDARY)) {
        inputValue.value = inputValue.value.split(SEARCH_BOUNDARY)[0].toLowerCase();
        onInput(inputValue.value);
      }
    }
  } else if (e.key === "Backspace") {
    if (inputValue.value.endsWith(SEARCH_BOUNDARY)) {
      e.preventDefault();
      return;
    }
    if (/^\s*[\[<][^\[\]<>]*[\]>]\s*$/.test(inputValue.value)) {
      inputValue.value = "";
      onInput("");
      e.preventDefault();
    }
  }
}

/** logo 左键：有更新时按状态处理（安装/下载/显示进度），否则搜索 [系统项] */
function onLogoClick(): void {
  if (update.state.info && update.state.info.has_update) {
    void update.handleBadgeClick();
    return;
  }
  // 无更新：保持原有行为，搜索 [系统项]
  const keyword = "[系统项]";
  const next = inputValue.value === keyword ? "" : keyword;
  inputValue.value = next;
  onInput(next);
  searchBoxRef.value?.focus();
}

/** 结果项点击（由 ResultList 冒泡） */
function onResultOpen(index: number): void {
  const result = state.results[index];
  if (result) openItem(result.item);
}
function onResultVassal(index: number): void {
  const result = state.results[index];
  if (result) openVassal(result.item);
}
function onResultLink(url: string): void {
  void openExternal(url);
}

// ============== 特殊路由转发（PRO 模式空父关键词 → "问AI"） ==============
search.onRedirect((keyword) => {
  inputValue.value = keyword;
  // 走正常输入路径（原版 triggerSearchHandle 派发 input 事件）：
  // 记录「已进入子搜索模式」状态，后续输入「问AI : 你好」时才会命中编辑守卫。
  search.onInput(keyword);
});

// 输入值读取器（占位提示/子搜索都用它）
search.bindInputValueGetter(() => inputValue.value);
search.bindAfterResultsRendered(() => {
  if (state.mode === MODE.SHOW_RESULT) {
    void syncWindowHeightToContent();
  } else {
    collapseToBoxHeight();
  }
});

// ============== 生命周期 ==============
let unlistenShown: (() => void) | null = null;

/** 全局 ESC：输入框无焦点时，与输入框按 ESC 行为完全等价 */
function onGlobalEsc(e: KeyboardEvent): void {
  if (e.key !== "Escape") return;
  e.preventDefault();
  // 捕获阶段拦截并阻止冒泡，避免输入框聚焦时重复触发
  e.stopPropagation();
  if (state.mode === MODE.SHOW_ITEM_DETAIL) {
    hideTextView();
  } else {
    void hideWindow();
  }
}

onMounted(async () => {
  // 启动时把窗口收起到搜索框高度（WebView 重载后窗口可能保持上次展开的高度）
  collapseToBoxHeight();

  // 键盘监听必须在任何 await 之前注册：
  // 否则订阅/数据加载较慢时，加载期间按 Esc / Ctrl+, 会完全没有响应。
  // Ctrl+, 打开订阅管理（配置窗口）
  document.addEventListener("keydown", onGlobalKeydown);
  // 全局 ESC：详情视图 / 结果列表显示时，输入框无焦点也与输入框 ESC 行为一致
  document.addEventListener("keydown", onGlobalEsc, true);

  try {
    await search.loadSubscribes();
    await search.loadAllData();
  } catch (e) {
    console.error("[我的搜索] 初始化加载失败:", e);
  }
  update.scheduleUpdateCheck();

  // 呼出（Rust 端显示窗口）按隐藏前的视图状态分两种（用户规则）：
  // 1. 详情视图展示中隐藏 → 原样还原；2. 其它状态 → 复位到初始视图
  unlistenShown = await onMainWindowShown(() => {
    if (!resumeDetailViewIfAny()) {
      resetToInitialView();
    }
    // 复位后再检查一次：若缓存已被清理，立即进入加载状态
    search.reloadIfSubscribesChanged(true);
    searchBoxRef.value?.focus();
  });

  // 托盘菜单「清理缓存」
  await onClearCache(() => {
    search.clearRebuildableCache();
  });

  // 窗口再次获得焦点 / 页面可见性变化时，检测订阅 / 标签 / 缓存是否变化
  window.addEventListener("focus", onWindowFocus);
  document.addEventListener("visibilitychange", onVisibilityChange);

  // 自动聚焦输入框
  if (isTauri) {
    await onWindowFocusChanged((focused) => {
      if (focused) setTimeout(() => searchBoxRef.value?.focus(), 30);
    });
    if (await isWindowVisible()) searchBoxRef.value?.focus();
  } else {
    searchBoxRef.value?.focus();
  }
});

function onGlobalKeydown(e: KeyboardEvent): void {
  // Ctrl+, 打开订阅管理
  if (e.ctrlKey && e.key === ",") {
    e.preventDefault();
    void openConfigWindow();
  }
}

function onWindowFocus(): void {
  search.reloadIfSubscribesChanged(false);
  searchBoxRef.value?.focus();
}

function onVisibilityChange(): void {
  search.reloadIfSubscribesChanged(false);
}

onBeforeUnmount(() => {
  document.removeEventListener("keydown", onGlobalKeydown);
  document.removeEventListener("keydown", onGlobalEsc, true);
  window.removeEventListener("focus", onWindowFocus);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  unlistenShown?.();
  update.dispose();
});

// 结果列表激活项变化时滚动到可见（还原 markActive 的 scrollIntoView）
watch(
  () => state.activeIndex,
  async (idx) => {
    await nextTick();
    const items = document.querySelectorAll("#matchItems .resultItem");
    const active = items[idx] as HTMLElement | undefined;
    if (active) active.scrollIntoView({ block: "nearest" });
  }
);

defineExpose({ inputValue });
</script>

<template>
  <div id="my_search_box">
    <div id="tis"></div>
    <div id="my_search_view">
      <SearchBox
        ref="searchBoxRef"
        v-model="inputValue"
        :placeholder="placeholder"
        :update="update"
        @input="onInput"
        @keydown="onKeydown"
        @logo-click="onLogoClick"
        @badge-click="onLogoClick"
        @settings="openConfigWindow()"
      />
      <div id="matchResult" :style="{ display: resultVisible ? 'block' : 'none' }" :class="{ show: resultVisible }">
        <ResultList
          :results="visibleResults"
          :active-index="state.activeIndex"
          :resolve-ref-item="resolveRefItem"
          @open="onResultOpen"
          @vassal="onResultVassal"
          @link="onResultLink"
        />
      </div>
      <DetailView
        ref="detailRef"
        :visible="detailVisible"
        :content="detail"
        :keyword="state.rawKeyword"
      />
    </div>
  </div>
</template>
