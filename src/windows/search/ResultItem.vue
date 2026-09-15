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
import { VASSAL_SVG, LOAD_ERROR_ICON } from "../../lib/assets";
import { resolveFavicon, faviconsAttr } from "./favicon";
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
    <img
      ref="imgEl"
      class="searchItem"
      :src="favicon.src"
      :data-favicons="faviconsData"
      draggable="false"
      alt=""
    />
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
