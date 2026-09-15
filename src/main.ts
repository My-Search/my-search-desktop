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

// 全局错误捕获：防止模块加载/初始化异常导致白屏
window.addEventListener("error", (event) => {
  console.error("[我的搜索] 未捕获的错误:", event.error ?? event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  console.error("[我的搜索] 未处理的 Promise 拒绝:", event.reason);
});

const app = createApp(App);
app.config.errorHandler = (err, _instance, info) => {
  console.error("[我的搜索] Vue 渲染错误:", err, info);
};
app.mount("#app");
