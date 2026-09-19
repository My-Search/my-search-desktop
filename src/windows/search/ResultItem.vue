<script setup lang="ts">
/**
 * 单条搜索结果（原 renderResults 里每个 <li class="resultItem">）。
 *
 * 关键点：
 * - 标题标签彩色高亮 / 标题正文：v-html（内容与原版一致，不做二次转义）
 * - favicon 多源回退懒加载：请求时按 data-favicons 顺序依次尝试
 * - 快捷链接(links) / 附加内容(vassal) 图标与事件
 */
import { ref, computed, watch, onMounted } from "vue";
import { renderTitleTags, titleContentHandler, clearHideTagForTitle } from "../../lib/tags";
import { isUrl } from "../../lib/util";
import { VASSAL_SVG, LOAD_ERROR_ICON, PLUGIN_BADGE_SVG } from "../../lib/assets";
import { resolveFavicon, faviconsAttr } from "./favicon";
import { pluginIdOf } from "../../lib/plugins/plugin-items";
import type { SearchItem } from "../../types/index";

const props = defineProps<{
  item: SearchItem;
  /** 原数据项（临时展示项如 <new> 的结果会展开原项取图标） */
  refItem: SearchItem;
  index: number;
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
const favicon = computed(() => resolveFavicon(props.refItem));
const faviconsData = computed(() => faviconsAttr(favicon.value.favicons));

/**
 * 是否是插件贡献的条目。
 *
 * 插件项在结果列表里长得和订阅数据项一样（同一套渲染），因此额外在图标
 * 左下角压一个统一的角标，让用户一眼能区分「这条来自插件」。
 */
const isPluginItem = computed(() => pluginIdOf(props.item) != null);

// ---------- favicon 懒加载（按 faviconSources 顺序依次尝试，全部失败显示错误图标） ----------
const imgEl = ref<HTMLImageElement | null>(null);

function loadIcon(): void {
  const img = imgEl.value;
  if (!img || !favicon.value.lazy) return;
  const urls = favicon.value.favicons;
  if (urls.length === 0) {
    img.src = LOAD_ERROR_ICON;
    return;
  }
  let index = 0;
  const tryNext = () => {
    if (index >= urls.length) {
      img.src = LOAD_ERROR_ICON;
      return;
    }
    const url = urls[index++];
    const test = new Image();
    test.onload = () => {
      img.src = url;
    };
    test.onerror = tryNext;
    test.src = url;
  };
  tryNext();
}

onMounted(loadIcon);
// 结果项被复用时（key 相同的极端情形）重新加载图标
watch(() => favicon.value, loadIcon, { flush: "post" });

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
  <li class="resultItem" :class="{ active: props.active }" :data-index="props.index" @click="onClick">
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
      :index="props.refItem.index ?? props.index"
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
