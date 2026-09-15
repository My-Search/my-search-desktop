<script setup lang="ts">
/**
 * 关注标签面板（原 panes.tags + paneBinders.tags）。
 * 取消勾选 = 搜索时过滤掉含该标签的内容。
 */
import { computed } from "vue";
import { storageGet } from "../../../lib/util";
import { TAGS_KEY } from "../configShared";
import type { TagsCheckedApi } from "../useTagsChecked";
import type { TagStat } from "../../../types/index";

const props = defineProps<{ tags: TagsCheckedApi }>();

const tagsOfData = computed<TagStat[]>(() => {
  const raw = storageGet<TagStat[] | null>(TAGS_KEY, null);
  return Array.isArray(raw) ? raw : [];
});

function onToggle(name: string, e: Event): void {
  props.tags.setChecked(name, (e.target as HTMLInputElement).checked);
}
</script>

<template>
  <section class="page tags">
    <div class="cfg-card">
      <div class="cfg-card-head">
        <h3>关注标签</h3>
        <span class="cfg-hint">取消勾选 = 搜索时过滤掉含该标签的内容</span>
      </div>
      <div class="tagsCheckBoxDiv">
        <template v-if="tagsOfData.length > 0">
          <label
            v-for="item in tagsOfData"
            :key="item.name"
            class="tag-chip"
            :class="{ on: props.tags.checked.get(item.name) ?? false }"
            :title="item.name"
          >
            <input
              type="checkbox"
              name="_tagsCheckBox"
              :value="item.name"
              :checked="props.tags.checked.get(item.name) ?? false"
              @change="onToggle(item.name, $event)"
            />
            <span class="tag-name">{{ item.name }}</span>
            <span class="tag-count">{{ item.count ?? 0 }}</span>
          </label>
        </template>
        <div v-else class="tags-empty">
          暂无标签数据：请先在主窗口加载一次订阅数据（打开搜索框，等待「数据库更新到 N 条」）。
        </div>
      </div>
    </div>
  </section>
</template>
