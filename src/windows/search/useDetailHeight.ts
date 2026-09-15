/**
 * 详情视图（简述内容 / 附加内容 / 脚本视图）高度自适应。
 *
 * 对应原 main.js 的 attachTextViewResize / detachTextViewResize / fitTextViewHeight：
 * - 内容少则窗口收紧（下限 TEXT_VIEW_MIN_HEIGHT）
 * - 内容多则展开到上限（TEXT_VIEW_MAX_HEIGHT）后内部滚动
 * - 用 ResizeObserver 观察内容元素，避免窗口高度变化自身触发循环
 *
 * 高度口径（与结果列表一致）：**实测 #my_search_box 的真实高度后原样下发**。
 * 旧实现按「内容高度 + 常量搜索框高 + 2px 余量」估算，窗口恒定比盒子高 2px，
 * 导致盒子下边框下方露出白边（用户反馈的「底部溢出灰框」）。
 */
import { calcDetailWindowHeight } from "../../lib/util";
import { setWindowHeight, flushWindowHeight } from "../../lib/tauri-bridge";

/** 简述/附加内容视图窗口高度下限（内容少时不至于空旷） */
export const TEXT_VIEW_MIN_HEIGHT = 140;
/** 简述/附加内容视图窗口高度上限（内容多则在 #text_show 内部滚动） */
export const TEXT_VIEW_MAX_HEIGHT = 560;

export function useDetailHeight() {
  let resizeObserver: ResizeObserver | null = null;
  /** 上一次应用的详情视图窗口高度，避免重复设置与震荡 */
  let lastHeight = 0;

  function detach(): void {
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    // 同时清除脚本视图可能遗留的内联高度
    const textView = document.getElementById("text_show");
    if (textView) {
      textView.style.flex = "";
      textView.style.height = "";
    }
    lastHeight = 0;
  }

  function attach(textView: HTMLElement): void {
    detach();
    if (typeof ResizeObserver === "undefined" || !textView) return;
    // 观察内容元素而非 #text_show 本身，避免窗口高度变化自身触发循环
    const target =
      textView.querySelector("#ms-page-body") || textView.querySelector(".script-view");
    if (!target) return;
    let raf = 0;
    resizeObserver = new ResizeObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        fit();
      });
    });
    resizeObserver.observe(target);
  }

  /**
   * 量取 #my_search_box 的实测高度并下发为窗口高度。
   *
   * 测量前临时解除 #app/#my_search_box/#my_search_view 上的固定高度约束
   * （脚本视图可能设置过），让盒子按内容自然撑开，读完立即恢复（同一帧内，
   * 不产生闪烁）。
   */
  function fit(): void {
    const textView = document.getElementById("text_show");
    if (!textView || textView.style.display === "none") return;
    const app = document.getElementById("app");
    const box = document.getElementById("my_search_box");
    const view = document.getElementById("my_search_view");
    if (!box) return;

    // 临时解除固定高度约束，测量盒子真实高度（同一帧内还原，不产生闪烁）
    const prevAppHeight = app ? app.style.height : "";
    const prevBoxHeight = box.style.height;
    const prevViewHeight = view ? view.style.height : "";
    const prevFlex = textView.style.flex;
    const prevHeight = textView.style.height;
    if (app) app.style.height = "auto";
    box.style.height = "auto";
    if (view) view.style.height = "auto";
    textView.style.flex = "0 0 auto";
    textView.style.height = "auto";
    const measuredBoxHeight = box.offsetHeight;
    if (app) app.style.height = prevAppHeight;
    box.style.height = prevBoxHeight;
    if (view) view.style.height = prevViewHeight;
    textView.style.flex = prevFlex;
    textView.style.height = prevHeight;

    const height = calcDetailWindowHeight(measuredBoxHeight, {
      min: TEXT_VIEW_MIN_HEIGHT,
      max: TEXT_VIEW_MAX_HEIGHT,
    });
    if (height === lastHeight) return;
    lastHeight = height;
    void setWindowHeight(height);
  }

  /** 窗口隐藏后重新呼出时复位高度缓存（强制重新下发） */
  function resetCache(): void {
    lastHeight = 0;
  }

  /** 立即下发（详情视图打开时不能等 50ms 防抖） */
  function flush(): void {
    flushWindowHeight();
  }

  return { attach, detach, fit, resetCache, flush };
}

export type DetailHeightApi = ReturnType<typeof useDetailHeight>;
