/**
 * 我的搜索（桌面版）- 主窗口入口（index.html）
 *
 * 交互行为一比一还原油猴脚本"我的搜索"（v7.9.5）：
 * - 全局快捷键（默认 Ctrl+Alt+S，可在设置中自定义）呼出悬浮搜索框（Rust 端注册）
 * - 输入即搜：精确(标题/描述/内容) → 拼音 → 重叠模糊匹配
 * - 搜索PRO模式（子搜索模式）：输入 "xxx : " 或按 Tab 进入PRO模式
 * - ↑↓ 选择、Enter 打开、Ctrl+Enter 查看附加内容、Esc 隐藏
 * - logo 按钮 = 搜索 [系统项]（与原版一致）
 * - 简述文本 / 附加内容(vassal) / 快捷链接(links) / 标签彩色高亮
 * - 订阅管理（右键 logo / Ctrl+, / 托盘菜单打开独立配置窗口）
 */
import "./css/style.css";
import { createApp } from "vue";
import App from "./windows/search/App.vue";
import { initTheme, setThemeReporter } from "./lib/theme";
import { setThemeOverrideReporter } from "./lib/theme-override";
import { applyAppTheme } from "./lib/tauri-bridge";

// 全局错误捕获：防止模块加载/初始化异常导致白屏
window.addEventListener("error", (event) => {
  console.error("[我的搜索] 未捕获的错误:", event.error ?? event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  console.error("[我的搜索] 未处理的 Promise 拒绝:", event.reason);
});

// 初始化主题（在 Vue 挂载前应用，避免首帧闪烁）
initTheme();

// 上报主题偏好（含 system）与已解析的深浅色到 Rust 原生层：同步主窗口原生底色，
// 避免窗口增大/重新合成时露出白色底（搜索结果时闪白）。回调即注册时立即触发一次，
// 故无需额外调用。
setThemeReporter((theme, resolved) => {
  void applyAppTheme(theme, resolved);
});

// 插件视图的临时主题覆盖同样要同步原生层（窗口底色/标题栏），否则覆盖期间
// 滚动条、overscroll 区域会与页面不同色。与上面的通道同源（同一个命令）。
setThemeOverrideReporter((theme, resolved) => {
  void applyAppTheme(theme, resolved);
});

// 同步适配骨架屏：若当前为深色主题，将骨架屏背景也改为深色
(function adaptSkeleton() {
  const html = document.documentElement;
  const isDark = html.classList.contains("theme-dark");
  const skeleton = document.getElementById("ms-skeleton");
  if (!skeleton) return;
  if (isDark) {
    skeleton.style.background = "#17191d";
    const borderBox = skeleton.firstElementChild as HTMLElement | null;
    if (borderBox) {
      borderBox.style.background = "#17191d";
      borderBox.style.borderColor = "#33363d";
      // 叶子占位圆：深色时也改暗，避免浅灰圆在深色背景上白闪
      const flexRow = borderBox.firstElementChild as HTMLElement | null;
      if (flexRow) {
        const leafCircle = flexRow.lastElementChild as HTMLElement | null;
        if (leafCircle) leafCircle.style.background = "#33363d";
      }
    }
  }
})();

/**
 * 移除骨架屏。
 *
 * 为什么用 requestAnimationFrame 而不是 mount() 后立即移除：
 * mount() 只保证 Vue 的虚拟 DOM 已挂载到真实 DOM，但浏览器/WebView 可能
 * 还没有完成首帧合成。如果在首帧合成前移除骨架屏，会出现「骨架屏消失 →
 * 首帧未合成 → 白屏闪烁」的糟糕体验。
 *
 * requestAnimationFrame 在浏览器绘制前触发，此时 Vue 渲染的 DOM 已就绪，
 * 骨架屏淡出后 Vue 内容立即可见，不会出现任何空白间隙。
 *
 * 双 rAF：第一帧确保 Vue patch 完成，第二帧确保浏览器已完成首次绘制。
 */
function removeSkeleton(): void {
  const skeleton = document.getElementById("ms-skeleton");
  if (!skeleton) return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      skeleton.style.transition = "opacity 0.15s ease";
      skeleton.style.opacity = "0";
      setTimeout(() => skeleton.remove(), 200);
    });
  });
}

const app = createApp(App);
app.config.errorHandler = (err, _instance, info) => {
  console.error("[我的搜索] Vue 渲染错误:", err, info);
};
app.mount("#ms-app");
removeSkeleton();
