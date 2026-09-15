<script setup lang="ts">
/**
 * 搜索结果列表（原 #matchResult > ol#matchItems）。
 *
 * 原实现每次 renderResults() 覆盖 innerHTML；这里改为数据驱动的 v-for，
 * DOM 结构与类名保持完全一致（#matchItems > li.resultItem）。
 *
 * 无结果时不显示任何内容（不出「没有找到…」提示），窗口收回搜索框高度。
 */
import ResultItem from "./ResultItem.vue";
import type { SearchResult } from "../../lib/search-engine";
import type { SearchItem } from "../../types/index";

const props = defineProps<{
  results: SearchResult[];
  /** 当前键盘选中项（-1 = 无选中） */
  activeIndex: number;
  /** 临时展示项使用同一 index 展开原项（如 <new> 的结果） */
  resolveRefItem: (item: SearchItem) => SearchItem;
}>();

const emit = defineEmits<{
  (e: "open", index: number): void;
  (e: "vassal", index: number): void;
  (e: "link", url: string): void;
}>();
</script>

<template>
  <ol id="matchItems">
    <ResultItem
      v-for="(result, i) in props.results"
      :key="i"
      :item="result.item"
      :ref-item="props.resolveRefItem(result.item)"
      :index="i"
      :active="i === props.activeIndex"
      :result-index="i"
      @open="(idx: number) => emit('open', idx)"
      @vassal="(idx: number) => emit('vassal', idx)"
      @link="(url: string) => emit('link', url)"
    />
  </ol>
</template>
