<script setup lang="ts">
/**
 * 单条搜索结果（原 renderResults 里每个 <li class="resultItem">）。
 *
 * 关键点：
 * - 标题标签彩色高亮 / 标题正文：v-html（内容与原版一致，不做二次转义）
 * - favicon 多源回退懒加载：请求时按 data-favicons 顺序依次尝试
 * - 快捷链接(links) / 附加内容(vassal) 图标与事件
 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { renderTitleTags, titleContentHandler, clearHideTagForTitle } from "../../lib/tags";
import { isUrl } from "../../lib/util";
import { VASSAL_SVG, LOAD_ERROR_ICON, ICON_LOADING_PLACEHOLDER, PLUGIN_BADGE_SVG } from "../../lib/assets";
import { resolveFavicon, faviconsAttr } from "./favicon";
import { fetchFavicon } from "../../lib/tauri-bridge.ts";
import { pluginIdOf } from "../../lib/plugins/plugin-items";
import type { SearchItem } from "../../types/index";

const props = defineProps<{
  item: SearchItem;
  active: boolean;
  /** 在 state.results 中的下标（点击时回传给 App） */
  resultIndex: number;
}>();

const emit = defineEmits<{
  (e: "open", index: number): void;
  (e: "vassal", index: number): void;
  (e: "link", url: string): void;
}>();

/** 标题（标签 + 正文，与原版一致原文直出） */
const titleHtml = computed(
  () =>
    renderTitleTags(clearHideTagForTitle(String(props.item.title || ""))) +
    titleContentHandler(String(props.item.title || ""))
);

const desc = computed(() => String(props.item.desc ?? ""));
const isSketch = computed(() => !isUrl(props.item.resource));
const links = computed(() => props.item.links ?? []);
const favicon = computed(() => resolveFavicon(props.item));
const faviconsData = computed(() => faviconsAttr(favicon.value.favicons));

/**
 * 是否是插件贡献的条目。
 *
 * 插件项在结果列表里长得和订阅数据项一样（同一套渲染），因此额外在图标
 * 左下角压一个统一的角标，让用户一眼能区分「这条来自插件」。
 */
const isPluginItem = computed(() => pluginIdOf(props.item) != null);

// ---------- favicon 加载 ----------
//
// 图标**不再由 WebView 直接请求**，而是交给 Rust 的 `fetch_favicon`：
// WebView2 会无条件跟随操作系统代理（不受应用内规则代理约束），开着代理软件时
// 图标会被代理拦掉，且关掉应用里的「代理总开关」也管不到它。改由 Rust 拉取后，
// 图标与其它后端请求走同一套规则代理（命中规则才走系统代理，其余直连），
// 并且能在多源之间做与后端一致的「跟随规则」回退。
//
// 回退顺序不变（faviconSources）：主源→备选1→备选2→站点自身 favicon.ico，
// 只是现在由 Rust 依次尝试、成功即返回 data URL，前端 `<img>` 直接显示。
const imgEl = ref<HTMLImageElement | null>(null);

/** 当前加载代次：结果项复用时旧请求返回要丢弃（防止图标错位）。 */
let loadToken = 0;
/** 组件是否已卸载（避免卸载后写 ref / 触发告警） */
let disposed = false;

async function loadIcon(): Promise<void> {
  const img = imgEl.value;
  if (!img || !favicon.value.lazy) return;
  const urls = favicon.value.favicons;
  if (urls.length === 0) {
    img.src = LOAD_ERROR_ICON;
    return;
  }
  const token = ++loadToken;
  img.src = ICON_LOADING_PLACEHOLDER;
  const dataUrl = await fetchFavicon(urls);
  // 期间结果项被复用 / 组件已卸载 / 又发起了新一轮 → 丢弃本次结果
  if (disposed || token !== loadToken || !imgEl.value) return;
  imgEl.value.src = dataUrl ?? LOAD_ERROR_ICON;
}

onMounted(() => {
  void loadIcon();
});
// 结果项被复用时（key 相同的极端情形）重新加载图标
watch(() => favicon.value, () => void loadIcon(), { flush: "post" });
onBeforeUnmount(() => {
  disposed = true;
  loadToken++; // 让在途请求的返回失效
});

/**
 * 图标加载失败时的兜底。
 *
 * 自定义图标（插件声明的 `icon`，也可能是网络地址）走的是**直出**路径，
 * 没有多源回退。离线或图标服务不可用时，`<img>` 会显示成「碎图」——比
 * 统一的占位图难看得多，也不利于用户判断「这是条目图标没加载，不是功能坏了」。
 * 因此失败后退到统一的错误占位图（与懒加载链全失败时的表现一致）。
 */
function onIconError(e: Event): void {
  const img = e.target as HTMLImageElement;
  if (img.src === LOAD_ERROR_ICON) return; // 已是占位图，避免死循环
  img.src = LOAD_ERROR_ICON;
}

function onClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  // 快捷链接：按脚本行为 → 打开目标地址（脚本是原生 <a target="_blank">）
  const linkChip = target.closest(".related-links a");
  if (linkChip) {
    e.stopPropagation();
    e.preventDefault();
    const url = linkChip.getAttribute("href");
    if (url) emit("link", url);
    return;
  }
  // 附加内容（vassal 图标）
  const vassalEl = target.closest("[data-vassal]");
  if (vassalEl) {
    e.preventDefault();
    e.stopPropagation();
    emit("vassal", props.resultIndex);
    return;
  }
  // 主链接
  const link = target.closest("a[data-open]");
  if (link) {
    e.preventDefault();
    e.stopPropagation();
    emit("open", props.resultIndex);
  }
}
</script>

<template>
  <li class="resultItem" :class="{ active: props.active }" :data-index="props.resultIndex" @click="onClick">
    <span class="item-icon" :class="{ 'is-plugin': isPluginItem }">
      <img
        ref="imgEl"
        class="searchItem"
        :src="favicon.src"
        :data-favicons="faviconsData"
        draggable="false"
        alt=""
        @error="onIconError"
      />
      <!-- 插件项角标：统一固定在图标左下角（图标内部），表示该条目由插件提供 -->
      <span
        v-if="isPluginItem"
        class="plugin-badge"
        title="来自插件"
        aria-label="来自插件"
        v-html="PLUGIN_BADGE_SVG"
      ></span>
    </span>
    <a
      :href="isSketch ? '' : String(props.item.resource ?? '')"
      target="_blank"
      :title="desc"
      :index="props.resultIndex"
      class="enter_main_link"
      :data-open="props.resultIndex"
    >
      <span v-html="titleHtml"></span>
      <span class="item_desc">（{{ desc }}）</span>
    </a>
    <div v-if="links.length" class="related-links">
      <a
        v-for="(link, i) in links"
        :key="i"
        :href="link.url"
        target="_blank"
        :title="link.title"
        >{{ link.text }}</a
      >
    </div>
    <a
      v-if="props.item.vassal != null"
      class="vassal"
      title="查看相关联/同类项内容"
      :data-vassal="props.resultIndex"
      v-html="VASSAL_SVG"
    ></a>
  </li>
</template>
