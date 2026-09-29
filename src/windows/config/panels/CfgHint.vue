<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

const props = defineProps<{ text: string }>();
const show = ref(false);
const selfRef = ref<HTMLElement | null>(null);

function onDocClick(e: MouseEvent) {
  if (!selfRef.value) return;
  if (!selfRef.value.contains(e.target as Node)) {
    show.value = false;
  }
}

onMounted(() => document.addEventListener("click", onDocClick, true));
onBeforeUnmount(() => document.removeEventListener("click", onDocClick, true));
</script>

<template>
  <span ref="selfRef" class="cfg-hint-trigger" @click.stop="show = !show">
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
    <span v-if="show" class="cfg-hint-popover">{{ props.text }}</span>
  </span>
</template>
