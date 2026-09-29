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

/**
 * 「高度由用户手动锁定」开关（插件视图拖拽改大小期间为 true）。
 *
 * 为什么需要：插件视图的窗口高度原本由内容自适应——`fit()` 实测 `#my_search_box`
 * 高度后就下发。但用户在插件页拖右下角改过大小后，这个自动高度会跟用户对着干：
 * 插件内容一变（异步出结果、列表增长），ResizeObserver 就触发 `fit()`，把窗口
 * 高度打回「内容高度」，用户拖出来的高度白拖。开启本锁后 `fit()` 直接返回，
 * 高度完全交给 App.vue 的插件尺寸逻辑控制。
 *
 * 用模块级变量而非 composable 内部状态：多个 useDetailHeight 实例（虽然当前
 * 只有 DetailView 一处）共享同一把锁，语义是「整个详情区当前是否手动锁定」。
 *
 * ## 契约：锁要覆盖「布局过渡」的整段，不能提前解
 *
 * `resetCache()` 只清「上次下发的高度」去重缓存，**不解除锁**（保持现语义）。
 *
 * 调用方（App.vue 的插件尺寸逻辑）必须遵守：凡是会**改变插件视图布局**的操作
 * （摘/加 `.plugin-sized` 拉伸类、切内容类型），都要在**锁住**的状态下做，等
 * 布局稳定（nextTick + 一帧）后再解锁并做一次显式 `fit()`。否则 ResizeObserver
 * 会在布局「半变」的瞬间触发 `fit()`，量到错误的（通常是很小的）盒子高度并写进
 * 防抖下发队列——这正是曾经「双击还原后概率性变很矮」的根因。
 */
let manualHeightLocked = false;

/** 设置「手动高度锁」（插件视图应用自定义尺寸时开，离开插件视图时关） */
export function setDetailManualHeightLock(locked: boolean): void {
  manualHeightLocked = locked;
}

/** 当前是否处于手动高度锁（调试/测试用） */
export function isDetailManualHeightLocked(): boolean {
  return manualHeightLocked;
}

/**
 * 插件 / 脚本视图的窗口高度按盒子**实测值原样下发**，不套用文本视图的
 * `TEXT_VIEW_MIN_HEIGHT` 下限（上限仍用 `TEXT_VIEW_MAX_HEIGHT`，超出则详情区内部滚动）。
 *
 * 为什么：文本视图的内容是宿主自己排的（markdown），内容少时窗口太矮会显得
 * 空旷，所以给一个下限。但插件/脚本视图的排版由插件自己决定——插件若把内容
 * 做矮（如「文件搜索」的空态：`.fs-list` 的空态 + 插件自带 padding 合计只有
 * 116px），下限 140 会把窗口撑到比 `#my_search_box` 高 24px：盒子的下边框
 * 停在 116，窗口却到 140，下边框之下露出一条空带（浅色主题下是 body 的白底，
 * 表现为「盒子底部多出一条白条 / 底部溢出」）。插件要多大就多大，宿主不替它
 * 加高度。
 */

export function useDetailHeight() {
  let resizeObserver: ResizeObserver | null = null;
  /** 上一次应用的详情视图窗口高度，避免重复设置与震荡 */
  let lastHeight = 0;
  /**
   * 当前详情视图是否为插件/脚本视图（外部 DOM 自排版）。
   * true → 高度按盒子实测原样下发，不套文本视图的 140 下限。
   * `fit()` 可能在 attach() 之外被调用（open/reapply 路径），故每次按 DOM 现况判定，
   * 而不是只在 attach 时缓存一次。
   */
  function isExternalView(): boolean {
    const textView = document.getElementById("text_show");
    if (!textView) return false;
    return !!(textView.querySelector(".plugin-view") || textView.querySelector(".script-view"));
  }

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
    // 观察内容元素而非 #text_show 本身，避免窗口高度变化自身触发循环。
    // 插件视图（.plugin-view）必须在列：它的内容是**异步长出来的**——挂载时
    // 往往还在扫描/请求，结果列表后到。漏了它，窗口高度就停在挂载那一刻的
    // 测量值，出现「明明出了结果却被裁掉看不见；隐藏再打开又正常」（重开会
    // 走一次显式的 onScriptMounted → fit）。三个选择器分属 v-else-if 的三个
    // 互斥分支，同一次挂载只会命中一个。
    const target =
      textView.querySelector("#ms-page-body") ||
      textView.querySelector(".script-view") ||
      textView.querySelector(".plugin-view");
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
   * 测量前临时解除 #ms-app/#my_search_box/#my_search_view 上的固定高度约束
   * （脚本视图可能设置过），让盒子按内容自然撑开，读完立即恢复（同一帧内，
   * 不产生闪烁）。
   */
  /**
   * 测量「内容自适应」的目标窗口高度（逻辑像素），**不下发**。
   *
   * 供「双击还原」这类需要先算出目标高度、再走平滑过渡动画的场景使用：
   * 调用方在保持高度锁的状态下调用它拿到目标值，动画结束后再解锁并做权威下发。
   *
   * 测量前临时解除 #ms-app/#my_search_box/#my_search_view 上的固定高度约束
   * （脚本视图可能设置过），让盒子按内容自然撑开，读完立即恢复（同一帧内，
   * 不产生闪烁）。
   *
   * @returns 目标高度；无详情元素时返回 null
   */
  function measure(): number | null {
    const textView = document.getElementById("text_show");
    if (!textView || textView.style.display === "none") return null;
    const app = document.getElementById("ms-app");
    const box = document.getElementById("my_search_box");
    const view = document.getElementById("my_search_view");
    if (!box) return null;

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

    const external = isExternalView();
    return calcDetailWindowHeight(measuredBoxHeight, {
      min: external ? 0 : TEXT_VIEW_MIN_HEIGHT,
      max: TEXT_VIEW_MAX_HEIGHT,
    });
  }

  function fit(): void {
    // 插件视图已被用户拖拽锁定高度：不再按内容自适应下发，避免把用户拖出来的
    // 高度打回去（宽度同理由 tauri-bridge 的 widthOverride 拦截）。
    if (manualHeightLocked) return;
    const height = measure();
    if (height == null) return;
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

  return { attach, detach, fit, measure, resetCache, flush };
}

export type DetailHeightApi = ReturnType<typeof useDetailHeight>;
