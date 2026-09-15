/**
 * 我的搜索桌面版 - 设置窗口入口（config.html）
 *
 * 参考油猴脚本"我的搜索"（v7.9.5）的配置能力，改造成常见的「设置」布局：
 * 顶栏标题 + 左侧分类菜单 + 右侧内容区。
 * - 订阅管理：订阅总览条块管理（逐条查看/添加/编辑/删除，默认视图），
 *   可切换到源码视图直接编辑 <tis::… /> 订阅原文（与主窗口共享同一份数据）
 * - 关注标签：勾选要「关注」的标签（未勾选 = 加入不关注列表，搜索时过滤）
 * - 公共仓库：提交我的订阅到 TisHub / 打开 Tis 订阅市场 / 清理 Token
 * - 数据缓存：统计本地缓存占用，一键清理可重建的数据缓存
 * - 快捷键：自定义全局呼出/隐藏快捷键（默认 Ctrl+Alt+S）
 * - 保存并应用：页面层底栏右侧的图标按钮（仅订阅管理 / 关注标签显示）
 * - 订阅市场：搜索已安装 / 市场订阅（GitHub Issues），一键安装/移除
 *
 * 注意：此窗口不加载搜索引擎/巨型依赖（如 pinyin-pro），
 * 避免引入重型依赖导致窗口空白/卡死。
 */
import "./css/style.css";
import { createApp } from "vue";
import App from "./windows/config/App.vue";

// 全局错误捕获：防止模块加载/初始化异常导致白屏
window.addEventListener("error", (event) => {
  console.error("[我的搜索-设置] 未捕获的错误:", event.error ?? event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  console.error("[我的搜索-设置] 未处理的 Promise 拒绝:", event.reason);
});

// 配置窗口的 html/body 需要可滚动 + 可选中文本（覆盖共享样式）
document.documentElement.classList.add("ms-config-root");
document.body.classList.add("ms-config-body");

const app = createApp(App);
app.config.errorHandler = (err, _instance, info) => {
  console.error("[我的搜索-设置] Vue 渲染错误:", err, info);
};
app.mount("#app");

// 取消 config.html 内联脚本的 8 秒超时兜底（Vue 已成功挂载）
if (typeof window.__cancelConfigFallback === "function") {
  window.__cancelConfigFallback();
}
