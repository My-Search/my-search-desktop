<script setup lang="ts">
/**
 * 浮动提示（原 #cfgToast）。
 *
 * 受控组件：状态由 useToast 提供，出现后自动消失（定时器在 composable 里）。
 */
import type { ToastState } from "../composables/useToast";

const props = defineProps<{ state: ToastState }>();
</script>

<template>
  <div
    id="cfgToast"
    class="cfg-toast"
    :class="{ show: props.state.visible, [props.state.type]: true }"
    role="status"
    aria-live="polite"
  >
    {{ props.state.text }}
  </div>
</template>
