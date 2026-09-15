<script setup lang="ts">
/**
 * GitHub Token 输入弹窗（原 #tokenOverlay，替代 window.prompt）。
 * 受控组件：visible 控制显隐，ok/cancel 回传结果。
 */
import { nextTick, ref, watch } from "vue";

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{ (e: "ok", value: string): void; (e: "cancel"): void }>();

const inputEl = ref<HTMLInputElement | null>(null);
const value = ref("");

watch(
  () => props.visible,
  async (v) => {
    if (v) {
      value.value = "";
      await nextTick();
      inputEl.value?.focus();
    }
  }
);

function closeOk(): void {
  emit("ok", value.value.trim());
}

function onOverlayClick(e: MouseEvent): void {
  if (e.target === e.currentTarget) emit("cancel");
}
</script>

<template>
  <div
    id="tokenOverlay"
    class="token-overlay"
    :class="{ show: props.visible }"
    @click="onOverlayClick"
  >
    <div class="token-dialog">
      <h3>GitHub Token</h3>
      <p>请输入您的 GitHub Token（仅缓存在本地，用于提交订阅到 TisHub）：</p>
      <input
        id="tokenInput"
        ref="inputEl"
        type="text"
        v-model="value"
        placeholder="ghp_xxx / github_pat_xxx"
        @keydown.enter.prevent="closeOk()"
      />
      <div class="token-actions">
        <button id="tokenCancel" class="cfg-btn ghost" @click="emit('cancel')">取消</button>
        <button id="tokenOk" class="cfg-btn primary" @click="closeOk">确定</button>
      </div>
    </div>
  </div>
</template>
