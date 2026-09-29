/**
 * 截图框选/标注遮罩窗口入口（overlay.html）
 *
 * 宿主按显示器开一个 `overlay-N` 透明全屏窗口，本文件挂载
 * `src/windows/overlay/App.vue`：铺满该屏的**冻结底图** + 半透明暗角 +
 * 拖拽框选高亮 + 标注工具条。
 *
 * 这不是插件视图——插件详情视图跑在搜索窗里，开不了窗口。遮罩是宿主
 * 自己的窗口，供「截图」插件（以及任何申请了 screenshot.overlay 权限的
 * 插件）调起。窗口间靠 URL 参数 `?monitor=N` + `screenshot_*` 命令协作。
 */
import { createApp } from "vue";
import App from "./windows/overlay/App.vue";

window.addEventListener("error", (event) => {
  console.error("[截图遮罩] 未捕获的错误:", event.error ?? event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  console.error("[截图遮罩] 未处理的 Promise 拒绝:", event.reason);
});

const app = createApp(App);
app.config.errorHandler = (err, _instance, info) => {
  console.error("[截图遮罩] Vue 渲染错误:", err, info);
};
app.mount("#app");
