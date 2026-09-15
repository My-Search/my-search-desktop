<script setup lang="ts">
/**
 * 通用确认/提示弹窗（原 #msgOverlay）。
 *
 * 受控组件：状态由 useMessageDialog 提供，事件回传 ok / cancel。
 * 关闭交互：Esc=取消、点击遮罩空白处=取消、Enter=确定（由 App 层统一监听 Esc，
 * 这里只处理遮罩点击，避免与全局快捷键（Ctrl+,）冲突）。
 *
 * 弹窗打开时自动聚焦「确定」按钮：原版（config.js:282）在 showMessage 里主动
 * okBtn.focus()。缺少聚焦时 Enter 会同时触发文档监听器的 handleOk 和仍持有焦点
 * 的触发按钮（“删除”“清理缓存”等），导致级联重复操作。
 */
import { nextTick, ref, watch } from "vue";
import type { MessageDialogState } from "../composables/useMessageDialog";

const props = defineProps<{ state: MessageDialogState }>();
const emit = defineEmits<{ (e: "ok"): void; (e: "cancel"): void }>();

const okBtn = ref<HTMLButtonElement | null>(null);

// 弹窗打开时自动聚焦确定按钮（复原原版 okBtn.focus()）
watch(
  () => props.state.visible,
  (v) => {
    if (v) nextTick(() => okBtn.value?.focus());
  }
);

function onOverlayClick(e: MouseEvent) {
  // 仅点击遮罩本身（而非对话框内部）才关闭
  if (e.target === e.currentTarget) emit("cancel");
}
</script>

<template>
  <div id="msgOverlay" class="token-overlay" :class="{ show: props.state.visible }" @click="onOverlayClick">
    <div class="token-dialog">
      <h3 id="msgTitle">{{ props.state.title }}</h3>
      <p id="msgText">{{ props.state.text }}</p>
      <div class="token-actions">
        <button
          v-if="props.state.showCancel"
          id="msgCancel"
          class="cfg-btn ghost"
          @click="emit('cancel')"
        >
          {{ props.state.cancelText }}
        </button>
        <button id="msgOk" ref="okBtn" class="cfg-btn primary" @click="emit('ok')">
          {{ props.state.okText }}
        </button>
      </div>
    </div>
  </div>
</template>
