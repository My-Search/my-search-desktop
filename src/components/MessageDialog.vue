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
 *
 * 两个按钮都挂 @click.stop：
 *   1) 点击冒泡到遮罩时会命中 onOverlayClick → 再 emit 一次 cancel，把刚 resolve
 *      的 ok 又覆盖掉（Promise 只认第一次，表现为「点确定变成取消」），而 ok
 *      又触发了嵌套弹窗（“是否同时删除插件保存的数据？”），极易写坏卸载流程；
 *   2) 真实场景：插件面板的卸载弹窗是**连续两次** confirm。第一次点「确定」时
 *      浏览器仍认为鼠标处于按下状态，若此刻同步切换 DOM 把按钮换到光标下方，
 *      第二次弹窗会收到一个 click ——点击弹窗任意位置都会莫名触发
 *      「确定/取消」。
 * stop 只拦住遮罩，不影响 keyboard 的 Enter/Esc 链路。
 *
 * 【重要】遮罩使用 HTML **top layer**（popover 属性）：
 *   - 插件界面与宿主弹窗处在**同一个层叠上下文**里（插件会话挂在
 *     #text_show .plugin-view 下），插件作者可以写任意大的 z-index
 *     （例：pi-agent 用 100 / 9999，右下角缩放手柄用 2147483647）。
 *     只靠 CSS z-index 赢不了所有插件，用户会看到「弹窗被盖住 / 点了没反应」。
 *   - popover 元素渲染在浏览器**顶层**（top layer），永远压在所有 z-index 之上，
 *     不受任何层叠上下文 / transform / filter 影响，这才是宿主模态层应有的保证。
 *   - 用 `manual` 模式打开：不接管焦点、不自动关（焦点由我们自己的 okBtn.focus()
 *     管理），关闭时机完全由 state.visible 驱动。
 * 代码里保留 CSS 的 z-index 兜底：万一运行环境不支持 popover，行为退回原样。
 */
import { nextTick, ref, watch } from "vue";
import type { MessageDialogState } from "../composables/useMessageDialog";

const props = defineProps<{ state: MessageDialogState }>();
const emit = defineEmits<{ (e: "ok"): void; (e: "cancel"): void }>();

const okBtn = ref<HTMLButtonElement | null>(null);
const overlay = ref<HTMLElement | null>(null);

/**
 * 把遮罩送入 / 移出 top layer。
 *
 * 时序很关键：`showPopover()` 在元素 `display:none` 时会**抛异常**。而遮罩的
 * 显隐是由 `.show` 类控制的，所以必须等类生效、元素已可见之后再 showPopover；
 * watcher 里已经用 nextTick 等到 DOM 补丁落地，这里再保一道 `offsetParent` 检查。
 * 不支持 popover 的环境（或非 HTMLElement）静默跳过，CSS z-index 兜底。
 */
function syncTopLayer(visible: boolean): void {
  const el = overlay.value as (HTMLElement & {
    showPopover?: () => void;
    hidePopover?: () => void;
  }) | null;
  if (!el) return;
  try {
    if (visible) {
      // 已开则不动（幂等）
      if (!el.matches(":popover-open")) {
        if (typeof el.showPopover === "function") el.showPopover();
      }
    } else if (el.matches(":popover-open")) {
      el.hidePopover?.();
    }
  } catch {
    /* 不支持 popover / 时机不合法：忽略，靠 CSS z-index 兜底 */
  }
}

// 弹窗打开时：送入 top layer + 自动聚焦确定按钮（复原原版 okBtn.focus()）。
// nextTick 之后再操作：等 DOM 的 class / popover 属性随响应式更新到位。
watch(
  () => props.state.visible,
  (v) => {
    nextTick(() => {
      syncTopLayer(v);
      if (v) okBtn.value?.focus();
    });
  },
  { immediate: true, flush: "post" }
);

function onOverlayClick(e: MouseEvent) {
  // 仅点击遮罩本身（而非对话框内部）才关闭
  if (e.target === e.currentTarget) emit("cancel");
}
</script>

<template>
  <div
    id="msgOverlay"
    ref="overlay"
    class="token-overlay"
    :class="{ show: props.state.visible }"
    popover="manual"
    @click="onOverlayClick"
  >
    <div class="token-dialog">
      <h3 id="msgTitle">{{ props.state.title }}</h3>
      <p id="msgText">{{ props.state.text }}</p>
      <div class="token-actions">
        <button
          v-if="props.state.showCancel"
          id="msgCancel"
          class="cfg-btn ghost"
          @click.stop="emit('cancel')"
        >
          {{ props.state.cancelText }}
        </button>
        <button id="msgOk" ref="okBtn" class="cfg-btn primary" @click.stop="emit('ok')">
          {{ props.state.okText }}
        </button>
      </div>
    </div>
  </div>
</template>
