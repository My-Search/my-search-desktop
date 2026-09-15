/**
 * 应用内确认/提示弹窗（替代 window.confirm / window.alert）
 *
 * 为什么不用原生弹窗：macOS 的 WKWebView 里 wry 未实现 runJavaScriptAlertPanel /
 * runJavaScriptConfirmPanel，window.confirm 会直接返回 false、window.alert 完全无效果。
 * 设置窗口的「清理缓存」「删除订阅」「提交到 TisHub」等都依赖用户确认，
 * 所以统一改成应用内弹窗（样式复用 .token-overlay/.token-dialog）。
 *
 * 用法（配合 MessageDialog.vue）：
 *   const { state, showMessage, confirmMessage, alertMessage, handleOk, handleCancel } = useMessageDialog();
 *   // 组件里 <MessageDialog :state="state" @ok="handleOk" @cancel="handleCancel" />
 */
import { reactive } from "vue";

/** 弹窗状态 */
export interface MessageDialogState {
  visible: boolean;
  title: string;
  text: string;
  okText: string;
  cancelText: string;
  showCancel: boolean;
}

/** 弹窗选项 */
export interface MessageDialogOptions {
  title?: string;
  okText?: string;
  cancelText?: string;
  showCancel?: boolean;
}

export function useMessageDialog() {
  const state = reactive<MessageDialogState>({
    visible: false,
    title: "提示",
    text: "",
    okText: "确定",
    cancelText: "取消",
    showCancel: true,
  });

  let resolver: ((value: boolean) => void) | null = null;

  /**
   * 弹出确认框（单按钮时退化为提示框）
   * @returns 点「确定」为 true；点「取消」/Esc 为 false
   */
  function showMessage(text: string, opts: MessageDialogOptions = {}): Promise<boolean> {
    const { title = "提示", okText = "确定", cancelText = "取消", showCancel = true } = opts;
    return new Promise((resolve) => {
      resolver = resolve;
      state.title = title;
      state.text = text;
      state.okText = okText;
      state.cancelText = cancelText;
      state.showCancel = showCancel;
      state.visible = true;
    });
  }

  /** 关闭弹窗并返回结果（内部/键盘共用） */
  function closeMessage(result: boolean): void {
    state.visible = false;
    const resolve = resolver;
    resolver = null;
    if (resolve) resolve(!!result);
  }

  /** 确认框（对齐 window.confirm 的语义与返回类型） */
  function confirmMessage(text: string, opts?: MessageDialogOptions): Promise<boolean> {
    return showMessage(text, opts);
  }

  /** 提示框（只有一个「确定」按钮，对齐 window.alert） */
  function alertMessage(text: string, opts: MessageDialogOptions = {}): Promise<boolean> {
    return showMessage(text, { ...opts, title: opts.title || "提示", showCancel: false });
  }

  return {
    state,
    showMessage,
    confirmMessage,
    alertMessage,
    handleOk: () => closeMessage(true),
    handleCancel: () => closeMessage(false),
  };
}
