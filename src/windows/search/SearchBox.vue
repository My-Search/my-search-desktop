<script setup lang="ts">
/**
 * 搜索框（原 #searchBox + #my_search_box 内部结构）。
 *
 * - 输入框：v-model + input 事件（防抖搜索由父层处理）
 * - 键盘：↑↓ 选择、Enter 打开、Ctrl+Enter 附加内容、Esc 隐藏、Tab 进/出 PRO 模式、Backspace 清标签
 * - logo 按钮：左键 = 打开设置 / 右键 = 切换 [系统项]（有更新时由 UpdateBadge 接管）
 * - 更新徽章：环形进度（有更新时替换叶子）
 */
import { computed, ref, watch } from "vue";
import { SEARCH_BOUNDARY } from "../../lib/search-engine";
import { LOGO_ICON } from "../../lib/assets";
import UpdateBadge from "./UpdateBadge.vue";
import type { UpdateCheckerApi } from "./useUpdateChecker";

const props = defineProps<{
  /** 输入框内容（v-model） */
  modelValue: string;
  placeholder: string;
  /** 更新检查状态（徽章显示/进度） */
  update: UpdateCheckerApi;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", v: string): void;
  (e: "input", v: string): void;
  (e: "keydown", ev: KeyboardEvent): void;
  (e: "settings"): void;
  (e: "badge-click"): void;
  (e: "system-item"): void;
}>();

const inputEl = ref<HTMLInputElement | null>(null);

/** 内部值：与父层 modelValue 双向同步 */
const value = computed({
  get: () => props.modelValue,
  set: (v: string) => emit("update:modelValue", v),
});

/** logo 是否隐藏（有更新时被徽章替换） */
const showBadge = computed(() => props.update.isBadgeVisible());
const showLogo = computed(() => !showBadge.value);

function onInput(e: Event) {
  const v = (e.target as HTMLInputElement).value;
  emit("update:modelValue", v);
  emit("input", v);
}

function onKeydown(e: KeyboardEvent) {
  e.stopPropagation();
  emit("keydown", e);
}

function onKeyup(e: KeyboardEvent) {
  const keyword = (e.target as HTMLInputElement).value.trim();
  // "::" / "：：" → 子搜索分隔符
  if (keyword.endsWith("::") || keyword.endsWith("：：")) {
    let kw = keyword.replace(/::|：：/, SEARCH_BOUNDARY).replace(/\s+/, " ");
    kw = kw.replace(/((\s{1,2}:)+ )/, SEARCH_BOUNDARY);
    const upper = kw.toUpperCase();
    emit("update:modelValue", upper);
    emit("input", upper);
  }
}

/** 供父层聚焦/读取/改写输入框 */
function focus(): void {
  inputEl.value?.focus();
}
function select(): void {
  inputEl.value?.select();
}

defineExpose({ focus, select, element: inputEl });

// 父层改写 modelValue 时同步到原生 input（Vue 会处理，这里仅确保光标位置不丢）
watch(
  () => props.modelValue,
  () => {
    const el = inputEl.value;
    if (el && el.value !== props.modelValue) el.value = props.modelValue;
  }
);

/** logo 点击处理：区分左键和右键 */
function onLogoClick(e: MouseEvent) {
  // 左键：判断是否有更新
  if (props.update.state.info && props.update.state.info.has_update) {
    // 有更新：触发 badge-click 处理更新
    emit("badge-click");
  } else {
    // 无更新：打开设置
    emit("settings");
  }
}

/** logo 右击菜单（切换 [系统项]） */
function onLogoContextMenu(e: MouseEvent) {
  e.preventDefault();
  emit("system-item");
}
</script>

<template>
  <div id="searchBox">
    <div id="ms-input-files"></div>
    <input
      ref="inputEl"
      :value="value"
      :placeholder="props.placeholder"
      id="my_search_input"
      autocomplete="off"
      spellcheck="false"
      @input="onInput"
      @keydown="onKeydown"
      @keyup="onKeyup"
    />
    <div class="logo-wrapper">
      <!-- 叶子 logo（默认显示） -->
      <button
        v-show="showLogo"
        id="logoButton"
        title="打开设置（右击：切换 [系统项]）"
        @click="onLogoClick"
        @contextmenu="onLogoContextMenu"
      >
        <img :src="LOGO_ICON" draggable="false" alt="logo" />
      </button>
      <!-- 有更新时：把叶子替换为"苹果枝叶"升级 icon，外层套环形进度条 -->
      <UpdateBadge
        v-show="showBadge"
        :update="props.update"
        @click="onLogoClick"
        @contextmenu="onLogoContextMenu"
      />
    </div>
  </div>
</template>
