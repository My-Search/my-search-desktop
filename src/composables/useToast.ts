/**
 * 浮动提示（toast）——两个窗口共用。
 *
 * 设置窗口原本用底栏文字提示，后改为浮动 toast：出现后自动消失，不占版面。
 * 这里抽成 composable，供 MessageToast.vue（或设置窗口的 ToastHost.vue）渲染。
 */
import { reactive } from "vue";

export interface ToastState {
  visible: boolean;
  text: string;
  /** 语义（决定颜色） */
  type: "ok" | "error";
}

/** 默认展示时长（ms），与设置窗口原实现一致 */
const DEFAULT_TOAST_MS = 2600;

export function useToast() {
  const state = reactive<ToastState>({
    visible: false,
    text: "",
    type: "ok",
  });

  let timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 显示提示
   * @param text 提示文案
   * @param type 语义（决定颜色）
   */
  function showToast(text: string, type: "ok" | "error" = "ok", duration = DEFAULT_TOAST_MS): void {
    state.text = text;
    state.type = type;
    state.visible = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      state.visible = false;
      timer = null;
    }, duration);
  }

  /** 主动隐藏（组件卸载时调用，避免定时器悬挂） */
  function disposeToast(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return { state, showToast, disposeToast };
}
