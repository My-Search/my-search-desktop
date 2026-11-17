<script setup lang="ts">
/**
 * 标注工具条（截图遮罩与贴图窗口共用，用户需求：贴图显示的工具栏要跟截图一样）。
 *
 * 纯展示组件：状态（当前工具 / 颜色 / 线宽 / 能否撤销）全部由 props 传入，
 * 交互通过 emit 抛回宿主——这样两个宿主各自决定「改状态后要不要重绘画布」。
 * 按钮样式与截图版完全一致（.ov-toolbar / .ov-tool / .ov-color 同款），
 * 贴图窗口里就是截图那套工具栏，不是另一套皮肤。
 */
import type { Tool } from "../lib/annotation.ts";

export interface ToolDef {
  id: Tool;
  icon: string;
  label: string;
}

const props = defineProps<{
  tools: readonly ToolDef[];
  colors: readonly string[];
  tool: Tool;
  color: string;
  lineWidth: number;
  /** 当前选中的是不是文字标注（决定要不要亮出「编辑文字」按钮） */
  showTextEdit: boolean;
  canUndo: boolean;
  canRedo: boolean;
}>();

const emit = defineEmits<{
  (e: "pick-tool", id: Tool): void;
  (e: "pick-color", color: string): void;
  (e: "bump-line-width", delta: number): void;
  (e: "edit-text"): void;
  (e: "undo"): void;
  (e: "redo"): void;
}>();
</script>

<template>
  <div class="ov-toolbar mk-toolbar" @mousedown.stop @dblclick.stop>
    <button
      v-for="t in props.tools"
      :key="t.id"
      class="ov-tool"
      :class="{ on: props.tool === t.id }"
      :title="t.label"
      @click.stop="emit('pick-tool', t.id)"
    >
      {{ t.icon }}
    </button>
    <span class="ov-sep"></span>
    <!-- 改色可能作用在**已选中的那一笔**上，宿主必须立刻重绘，否则要等下一次交互才变色 -->
    <button
      v-for="c in props.colors"
      :key="c"
      class="ov-color"
      :class="{ on: props.color === c }"
      :style="{ background: c }"
      @click.stop="emit('pick-color', c)"
    />
    <span class="ov-sep"></span>
    <!-- 粗细：未选中改「下一笔」，选中时同时改这一笔（文字同步字号） -->
    <button class="ov-tool ov-w" title="细一点（字号也变小）" @click.stop="emit('bump-line-width', -2)">−</button>
    <span class="ov-wval" :title="'当前粗细 ' + props.lineWidth">{{ props.lineWidth }}</span>
    <button class="ov-tool ov-w" title="粗一点（字号也变大）" @click.stop="emit('bump-line-width', 2)">＋</button>
    <span class="ov-sep"></span>
    <!-- 选中文字标注时才出现：重新编辑它的内容 -->
    <button v-if="props.showTextEdit" class="ov-tool" title="编辑文字" @click.stop="emit('edit-text')">✎T</button>
    <span v-if="props.showTextEdit" class="ov-sep"></span>
    <button class="ov-tool" title="撤销 (Ctrl+Z)" :disabled="!props.canUndo" @click.stop="emit('undo')">↶</button>
    <button class="ov-tool" title="重做 (Ctrl+Shift+Z)" :disabled="!props.canRedo" @click.stop="emit('redo')">↷</button>
    <!-- 宿主专属动作（截图=复制/保存/取消；贴图=取消/完成）从这里拼进同一条工具栏 -->
    <slot name="actions"></slot>
  </div>
</template>

<style scoped>
/*
 * 与截图遮罩原工具条同款样式（原 .ov-toolbar 系规则整体搬进来）。
 * 选择器保留 ov- 前缀：截图侧测试（screenshot-overlay-ui 等）按这些 class 断言，
 * 换名会打破测试；scoped 不影响「同一页面上另一个组件也用同名 class」的隔离。
 */
.ov-toolbar {
  position: absolute;
  left: 50%;
  bottom: 28px;
  transform: translateX(-50%);
  display: flex;
  flex-wrap: nowrap;
  justify-content: center;
  align-items: center;
  gap: 6px;
  /* 工具条整体不许超出屏幕：极窄屏时宁可缩小间距，也不能让按钮折行 */
  max-width: calc(100vw - 24px);
  background: rgba(28, 30, 34, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  padding: 8px 12px;
  z-index: 10;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4);
}
.ov-tool {
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #cfd3da;
  font-size: 16px;
  cursor: pointer;
  display: grid;
  place-items: center;
}
.ov-tool:hover {
  background: rgba(255, 255, 255, 0.1);
}
.ov-tool.on {
  background: #4da3ff;
  color: #fff;
}
.ov-tool:disabled {
  opacity: 0.35;
  cursor: default;
}
.ov-color {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  padding: 0;
}
.ov-color.on {
  border-color: #fff;
  box-shadow: 0 0 0 1px #4da3ff;
}
.ov-sep {
  width: 1px;
  height: 20px;
  background: rgba(255, 255, 255, 0.15);
  margin: 0 4px;
  /* 分隔线是纯装饰：工具条折行时别把它单独留在某一行，也别被压扁 */
  flex: none;
}
/* 线宽显示：夹在 − / ＋ 之间的小数字 */
.ov-wval {
  min-width: 18px;
  text-align: center;
  color: #e8e8e8;
  font-size: 12px;
  font-family: ui-monospace, Consolas, monospace;
  user-select: none;
}
.ov-tool.ov-w {
  font-weight: 700;
}
</style>
