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
import { usePluginHost } from "./usePluginHost";
import { usePluginViewHost } from "./usePluginViewHost";
import { pluginIdOf } from "../../lib/plugins/plugin-items";
import { decideViewReload } from "../../lib/plugins/dev-reload";
import { takePluginFrontendRestartMarks } from "../../lib/plugins/restart";
import { bindPluginHostRuntime } from "../../lib/plugins/host";
import { useMessageDialog } from "../../composables/useMessageDialog";
import { useToast } from "../../composables/useToast";
import { setupBuiltinAutoInstall } from "../../lib/plugins/install-builtin";
import MessageDialog from "../../components/MessageDialog.vue";
import ToastHost from "../../components/ToastHost.vue";
import { isUrl, clearUrlSearchTemplate } from "../../lib/util";
import {
  openExternal,
  openConfigWindow,
  hideWindow,
  setWindowHeight,
  onMainWindowShown,
  onClearCache,
  onShortcutOpenPlugin,
  onWindowFocusChanged,
  isWindowVisible,
  isTauri,
} from "../../lib/tauri-bridge";
import { SEARCH_BOUNDARY, SPECIAL_KEYWORD, scoreSelect, historySelect } from "../../lib/search-engine";
import type { SearchItem } from "../../types/index";

const search = useSearchState();
const update = useUpdateChecker();
const { state, engine, placeholder, visibleResults } = search;

/** 应用内提示 / 确认（替代原生 alert/confirm：macOS WKWebView 不支持） */
const toast = useToast();
const message = useMessageDialog();

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

// ============== 插件宿主 ==============
/** 插件注册表 + 宿主 API 网关（授权弹窗 / 搜索数据 / 存储 / 网络…） */
const pluginHost = usePluginHost({
  getSearchData: () => engine.searchData,
  triggerSearch: (kw) => {
    inputValue.value = kw;
    void search.doSearch(kw);
  },
  setInput: (text) => {
    inputValue.value = text;
  },
  hideDetail: () => hideTextView(),
  toast: (text, type) => toast.showToast(text, type ?? "ok"),
  confirm: (text) => message.showMessage(text, { title: "插件请求" }),
  getSelectedText: (hint) => scriptHost.getSelectedText(hint),
  onItemsChanged: () => {
    // 装/卸/禁用插件后：重新合成插件项，已有输入时立即重搜
    search.attachPluginItems();
  },
  // 开发目录里的插件改了：按需重挂已打开的界面（判定在 usePluginHost 里，
  // 用的是纯函数 decideViewReload；这里只执行 DOM 侧的动作）。
  // 「已打开」包括**保活中的会话**——它内存里跑的是旧代码，不重挂就等于改了没反应。
  onDevPluginReloaded: (info) => {
    const decision = decideViewReload({
      activePluginId: pluginViewHost.activePluginId.value,
      pluginId: info.record.id,
      paths: info.paths,
      entry: info.record.manifest.contributes?.detailView?.entry,
      script: info.record.manifest.contributes?.detailView?.script,
      versionChanged: info.versionChanged,
      name: info.record.name,
      parkedPluginIds: pluginViewHost.keepAliveIds(),
    });
    if (!decision.remount) return;
    void remountPluginView(info.record.id, decision.notice);
  },
});

/**
 * 重挂已打开的插件视图（开发热重载用）。
 *
 * 为什么走「合成一个数据项 → open()」而不是原地刷新：插件的入口 HTML/CSS/JS
 * 是挂载时一次性读入并执行的（见 usePluginViewHost.mountSession），原地刷新没有
 * 对应的接口；而 `open()` 本就是「收掉旧的 + 挂新的」，且它需要的载体数据项
 * 由 `itemForPlugin` 现成合成（快捷键打开插件走的就是这条路）。
 *
 * 重挂前必须**强制卸载**旧会话：保活（最小化）的会话同理——它内存里跑的是旧代码，
 * 而且 `decideViewRestore` 会因为入口没变而选择「恢复」，那就等于改了没反应。
 *
 * 重挂会丢掉插件视图内的内存态（正在输入的内容等），因此给一条提示。
 */
async function remountPluginView(pluginId: string, notice: string | null): Promise<void> {
  const item = pluginHost.itemForPlugin(pluginId);
  const wasForeground = detailVisible.value && state.mode === MODE.SHOW_ITEM_DETAIL && pluginViewHost.isActive();
  // 无条件卸载旧会话（不按 closeBehavior：这里的旧代码必须消失）
  pluginViewHost.release(pluginId, "开发热重载：按新文件重新挂载");
  if (!item) return; // 插件被禁用 / 卸载：视图会在下次交互时自然收起
  if (!wasForeground) {
    // 保活中的后台会话：已卸载，等用户下次打开自然读到新文件（此时不必打断用户）
    if (notice) toast.showToast(notice, "ok");
    return;
  }
  try {
    await pluginViewHost.open(item);
    // 重挂后按内容重新下发窗口高度（否则会沿用旧内容的测量结果）
    detailRef.value?.onScriptMounted();
    if (notice) toast.showToast(notice, "ok");
  } catch (e) {
    console.warn(`[插件] 开发热重载重挂视图失败（${pluginId}）:`, e);
  }
}

/** 插件详情视图宿主（渲染 detailView.entry + 入口脚本） */
const pluginViewHost = usePluginViewHost({
  getRecord: (id) => pluginHost.get(id),
  createApi: (id) => pluginHost.apiFor(id),
  hostContext: pluginHost.hostContext(),
  readText: (id, rel) => pluginHost.readText(id, rel),
  matchSearch: (kw) => scriptHost.matchSearchByOverlap?.(kw) ?? Promise.resolve([]),
  getInputValue: () => inputValue.value,
  setInputValue: (kw) => {
    inputValue.value = kw;
  },
  fitHeight: () => detailRef.value?.fitHeight(),
  flushHeight: () => detailRef.value?.flushHeight(),
  container: computed(() => detailRef.value?.pluginContainer ?? null),  onError: (id, msg) => console.warn(`[插件 ${id}] ${msg}`),
  // 关闭界面时是否停后台进程由插件的 closeBehavior 决定（判定在 usePluginViewHost.clear）
  stopBackend: (id) => pluginHost.stopBackend(id),
});

// 宿主检索 / 加权实现注入（插件 ms.search.query / ms.search.score 用）
bindPluginHostRuntime({
  search: (kw) => engine.search(kw),
  score: (item) => scoreSelect(item),
});

// ============== 视图高度 ==============
/**
 * 由内容决定高度：渲染完成后实测 #my_search_box 的 offsetHeight 并下发。
 *
 * 为什么只量 #searchBox / #matchResult / #text_show 三个视图子节点、而不是
 * 直接读盒子的 offsetHeight：盒子里还住着**弹层节点**（toast、确认弹窗）。
 * 它们本该是 fixed/absolute 的（不参与布局），但只要有一条样式漏了（历史上
 * 真的漏过一次：搜索窗的 #cfgToast 没有 fixed 规则），它们就会被当成普通块
 * 撑高盒子——而下发的高度是白名单值（48 / 内容高度），多出来的部分只会溢出
 * 窗口，表现为**搜索框下边框消失**。按视图子节点求和可以让这层错误无法生效。
 */
const VIEW_PART_IDS = ["searchBox", "matchResult", "text_show"] as const;

function measuredBoxHeight(): number {
  const box = document.getElementById("my_search_box");
  if (!box) return BOX_HEIGHT;
  let sum = 0;
  for (const id of VIEW_PART_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    // display:none 的节点 offsetHeight 为 0，天然不参与
    sum += el.offsetHeight;
  }
  // 上下各 2px 灰边框（盒子是 border-box，视图子节点只覆盖内容区）
  const borders = box.offsetHeight - (box.clientHeight || box.offsetHeight);
  const total = sum > 0 ? sum + Math.max(0, borders) : box.offsetHeight;
  // 与 #my_search_box 的实测高度取小者：求和路径只用于「兜住异常撑高」，
  // 正常情况下两者一致（相等时取实测值，保持既有像素级行为不变）。
  return Math.min(total, box.offsetHeight);
}

async function syncWindowHeightToContent(): Promise<void> {
  await nextTick();
  void setWindowHeight(measuredBoxHeight());
}

/** 收起窗口到搜索框高度 */
function collapseToBoxHeight(): void {
  void setWindowHeight(BOX_HEIGHT);
}

// ============== 视图切换 ==============
/** 结束脚本 / 插件视图会话 + 关闭详情视图 */
function hideTextView(): void {
  scriptHost.clearScriptSession();
  // 插件视图：按插件设置「最小化」（停靠保活）或「退出」（卸载），
  // 由视图宿主内部判定；这里只负责收掉详情视图本身。
  pluginViewHost.clear();
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
  pluginViewHost.clear();
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
  pluginViewHost.clear();
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

  // 插件贡献的项：走插件视图（与老脚本项分流；老路径一字不动）
  if (pluginIdOf(item) != null) {
    void openPluginView(item);
    return;
  }
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

// ============== 插件视图 ==============
/**
 * 打开插件视图。
 *
 * 与脚本视图的分流点：插件项自带 `_pluginId`，渲染容器是 `.plugin-view`
 * （脚本项是 `.script-view`），两者互斥——先关掉脚本会话再挂插件视图。
 */
async function openPluginView(item: SearchItem): Promise<void> {
  scriptHost.clearScriptSession();
  detail.value = { kind: "plugin", title: item.title ?? "", desc: "插件项", body: "", item };
  detailVisible.value = true;
  state.mode = MODE.SHOW_ITEM_DETAIL;
  // 等容器渲染出来（.plugin-view 由 DetailView 的 v-else-if 分支产出）
  await nextTick();
  const result = await pluginViewHost.open(item);
  if (!result.ok) {
    toast.showToast(result.error ?? "插件视图打开失败", "error");
    return;
  }
  detailRef.value?.onScriptMounted();
}

/**
 * 全局快捷键触发的「打开插件」（快捷键作用于 open-plugin 时由 Rust 端广播事件）。
 *
 * 与点结果项打开插件的差别只有一步：快捷键没有「被点击的数据项」，
 * 因此由插件宿主合成一个载体项（该插件的第一个搜索项 / 最小占位项），
 * 其余路径完全一致（关脚本会话 → 挂插件视图 → 高度自适应）。
 */
async function openPluginByShortcut(pluginId: string): Promise<void> {
  // 插件可能刚在设置窗口里被装/卸/启停：先对一次注册表指纹，避免用到旧记录
  await pluginHost.reload();
  const record = pluginHost.get(pluginId);
  if (!record) {
    toast.showToast(`插件不存在（可能已卸载）：${pluginId}`, "error");
    return;
  }
  if (!record.enabled) {
    toast.showToast(`插件「${record.name}」已禁用，请先在设置 → 插件中启用`, "error");
    return;
  }
  const item = pluginHost.itemForPlugin(pluginId);
  if (!item) {
    toast.showToast(`插件「${record.name}」不可用`, "error");
    return;
  }
  await openPluginView(item);
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

/**
 * 对齐注册表变化后的插件会话（呼出 / 获得焦点 / 页面可见性变化时调用）。
 *
 * 设置窗口是**另一个 WebView**，用户可以在那里禁用/卸载插件；搜索窗只能
 * 在这些时间点发现。被禁用/卸载的插件不该还能被恢复出来，因此：
 *   1. 清掉失效的保活会话（`reapSessions`）；
 *   2. 若被清掉的恰好是**前台的**那个插件，详情视图会剩下一个空容器——
 *      把它一并收掉，回到结果列表/等待搜索，而不是给用户看一片空白。
 */
function syncPluginSessions(): void {
  const before = pluginViewHost.sessionCount();
  const activeBefore = pluginViewHost.activePluginId.value;
  pluginViewHost.reapSessions();
  // 设置里点了「重启」的插件：释放其（保活中的）前端会话，下次打开 = 全新挂载。
  // 后端已在设置窗口重启过，这里只丢前端会话、不联动停后端。
  for (const pluginId of takePluginFrontendRestartMarks()) {
    pluginViewHost.release(pluginId, "设置中重启了插件：前端会话已释放（下次打开重新挂载）", { stopBackend: false });
  }
  const reapedForeground = !!activeBefore && pluginViewHost.sessionCount() < before && !pluginViewHost.hasSession(activeBefore);
  if (reapedForeground && detailVisible.value && detail.value?.kind === "plugin") {
    detailVisible.value = false;
    detail.value = null;
    state.mode = state.results.length > 0 ? MODE.SHOW_RESULT : MODE.WAIT_SEARCH;
    void nextTick(() => {
      if (state.results.length > 0) void syncWindowHeightToContent();
      else collapseToBoxHeight();
    });
  }
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
    // 视图展示中：回车 = 把子搜索关键词推送给脚本应用 / 插件
    // （还原 registry.script.tryRunTextViewHandler；推成功就不执行结果项点击）
    const pushed = pluginViewHost.isActive()
      ? pluginViewHost.tryRunTextViewHandler(inputValue.value)
      : scriptHost.tryRunScriptTextViewHandler(inputValue.value);
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
/** 「打开插件」快捷键事件监听器 */
let unlistenPluginShortcut: (() => void) | null = null;
/** 内置插件自动安装监听器 */
let unlistenBuiltin: (() => void) | null = null;

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

  // ── 关键：以下数据加载不阻塞首帧渲染 ──
  // Vue mount() 已完成，骨架屏已移除，搜索框已可交互。
  // 把网络/文件 IO 放到 nextTick 之后，让 WebView 先完成首帧合成，
  // 避免冷启动首次呼出时因数据加载阻塞而显示空白窗口。
  await nextTick();

  // 插件注册表必须在「数据加载」之前就绪：插件项在 loadAllData 收尾时会挂进检索库
  // 内置插件先修补/安装（写 localStorage），再 reload 使内存注册表拿到最新权限
  try {
    unlistenBuiltin = await setupBuiltinAutoInstall();
    await pluginHost.reload(true);
    search.bindPluginItems(() => pluginHost.pluginItems());
    // 目录挂载插件的热重载：监听 Rust 侧广播的源目录变化（幂等，可安全重复调用）
    await pluginHost.startDevWatcher();
  } catch (e) {
    console.warn("[我的搜索] 插件加载失败:", e);
  }

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
    // 插件可能在设置窗口里被装/卸/启停：呼出时对一次注册表指纹，变了才重载。
    // 重载后顺手清掉「注册表里已经不该存在」的保活会话（禁用/卸载的插件不该
    // 还能被恢复出来）——设置窗口与搜索窗是两个 WebView，只能在这一刻对齐。
    void pluginHost
      .reload()
      .then(() => {
        syncPluginSessions();
        search.attachPluginItems();
      });
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

  // 全局快捷键「打开插件」（设置 → 快捷键里作用的插件键按下时 Rust 端广播）：
  // 无论窗口此前是隐藏还是显示，Rust 已保证窗口可见并聚焦，这里直接开插件视图。
  unlistenPluginShortcut = await onShortcutOpenPlugin((pluginId) => {
    void openPluginByShortcut(pluginId);
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
  // 焦点回到搜索窗口时，插件注册表可能已在设置窗口里被改动
  // （被禁用/卸载的插件：把它的保活会话一并清掉）
  void pluginHost
    .reload()
    .then(() => {
      syncPluginSessions();
      search.attachPluginItems();
    });
  searchBoxRef.value?.focus();
}

function onVisibilityChange(): void {
  search.reloadIfSubscribesChanged(false);
  void pluginHost
    .reload()
    .then(() => {
      syncPluginSessions();
      search.attachPluginItems();
    });
}

onBeforeUnmount(() => {
  document.removeEventListener("keydown", onGlobalKeydown);
  document.removeEventListener("keydown", onGlobalEsc, true);
  window.removeEventListener("focus", onWindowFocus);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  unlistenShown?.();
  unlistenPluginShortcut?.();
  unlistenBuiltin?.();
  pluginViewHost.disposeAll("应用退出");
  pluginHost.stopDevWatcher();
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
    <ToastHost :state="toast.state" />
    <MessageDialog :state="message.state" @ok="message.handleOk" @cancel="message.handleCancel" />
  </div>
</template>
