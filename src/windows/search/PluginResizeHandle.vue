<script setup lang="ts">
/**
 * 插件视图右下角「拖拽改窗口大小」手柄 + 「恢复默认大小」入口。
 *
 * 定位：绝对定位在 `#my_search_box` 右下角（该容器已 `position: relative`），
 * 因此贴着**整个悬浮窗**的右下角，而不只是插件内容区。
 *
 * 为什么不做成插件会话 DOM 的一部分：`.plugin-view` 是 Vue 的 `v-else-if`
 * 节点，切内容类型时会被整棵增删；手工往里插 DOM 会被 patch 顺手删掉。
 * 本组件由 DetailView.vue 模板在三个 v-if/v-else-if/v-else 分支**之外**声明，
 * 由 `visible` 门控，结构上不会被清理。
 *
 * 交互：mousedown 记录起点与当前窗口尺寸 → document 上 mousemove（rAF 节流）
 * 算出新尺寸并经 `clamp` 后 emit `resize`（宿主实时下发窗口尺寸）→ mouseup
 * emit `resize-end`（宿主写入记忆）。双击手柄 = 恢复默认大小。
 *
 * 与 tauri-bridge 的关系：本组件**不直接**碰窗口，只上报「目标尺寸」；
 * 真正的 setSize / 位置 / 记忆都由 App.vue 统一处理，保证只有插件页在改窗口。
 */
import { computed, onBeforeUnmount, ref } from "vue";
import { clampSize, type SizeLimits, type ViewSize } from "../../lib/plugins/view-size";

const props = defineProps<{
  /** 是否显示手柄（仅插件视图 + 详情可见时为真） */
  visible: boolean;
  /** 当前窗口尺寸（拖拽的起点；由宿主按实际窗口/下发值提供） */
  current: ViewSize;
  /** 尺寸上下限（min = 默认尺寸，max = 屏幕 90%） */
  limits: SizeLimits;
}>();

const emit = defineEmits<{
  /** 拖拽中：目标尺寸变化（实时，宿主应立即下发窗口尺寸） */
  (e: "resize", size: ViewSize): void;
  /** 拖拽结束：宿主可据此写入尺寸记忆 */
  (e: "resize-end", size: ViewSize): void;
  /** 请求恢复默认大小（双击手柄触发） */
  (e: "reset"): void;
}>();

/** 是否正在拖拽（控制高亮与 body 光标） */
const dragging = ref(false);

/** 拖拽起点（屏幕坐标 + 起始窗口尺寸） */
let startX = 0;
let startY = 0;
let startSize: ViewSize = { width: 0, height: 0 };
/** mousemove 的 rAF 合帧句柄 */
let raf = 0;
/** 最近一次算出的目标尺寸（mouseup 时写记忆用） */
let lastSize: ViewSize | null = null;

/** 上一次拖拽算出的尺寸（供父组件/调试读取；也避免 mouseup 时拿不到值） */
const lastComputed = ref<ViewSize | null>(null);

function onMouseDown(e: MouseEvent): void {
  if (e.button !== 0) return;
  // 阻止拖拽时触发窗口拖动/文本选择等默认行为
  e.preventDefault();
  e.stopPropagation();
  dragging.value = true;
  startX = e.clientX;
  startY = e.clientY;
  startSize = { width: props.current.width, height: props.current.height };
  lastSize = null;
  // 拖拽期间禁用文本选择与统一光标，避免滑过插件内容时选中文本
  document.body.style.userSelect = "none";
  document.body.style.cursor = "nwse-resize";
  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("mouseup", onMouseUp, true);
}

function computeSize(clientX: number, clientY: number): ViewSize {
  const dx = clientX - startX;
  const dy = clientY - startY;
  return clampSize(
    { width: startSize.width + dx, height: startSize.height + dy },
    props.limits
  );
}

function onMouseMove(e: MouseEvent): void {
  if (!dragging.value) return;
  const cx = e.clientX;
  const cy = e.clientY;
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    const size = computeSize(cx, cy);
    lastSize = size;
    lastComputed.value = size;
    emit("resize", size);
  });
}

function onMouseUp(e: MouseEvent): void {
  if (!dragging.value) return;
  // 优先复用最后一次 rAF 算出的尺寸：某些环境下 mouseup 的坐标可能异常
  // （如滑出窗口后被派发为 0,0），若据此重算会把尺寸打回最小。只有在
  // 完全没有中间帧（点一下就松手、rAF 未跑）时才按 mouseup 坐标算一次。
  const size = lastSize ?? computeSize(e.clientX, e.clientY);
  lastComputed.value = size;
  cleanup();
  emit("resize", size);
  emit("resize-end", size);
}

function cleanup(): void {
  dragging.value = false;
  if (raf) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
  document.body.style.userSelect = "";
  document.body.style.cursor = "";
  document.removeEventListener("mousemove", onMouseMove, true);
  document.removeEventListener("mouseup", onMouseUp, true);
}

function onDblClick(e: MouseEvent): void {
  e.preventDefault();
  e.stopPropagation();
  emit("reset");
}

/** 手柄是否可用（不可见时连监听都不挂） */
const interactive = computed(() => props.visible);

onBeforeUnmount(() => {
  if (dragging.value) cleanup();
});
</script>

<template>
  <div
    v-if="interactive"
    class="plugin-resize-handle"
    :class="{ 'is-dragging': dragging }"
    role="button"
    tabindex="-1"
    :title="'拖动改变窗口大小；双击恢复默认大小'"
    @mousedown="onMouseDown"
    @dblclick="onDblClick"
  >
    <span class="plugin-resize-grip" aria-hidden="true"></span>
  </div>
</template>
