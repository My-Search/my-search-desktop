/**
 * 贴图窗口入口（pin.html）
 *
 * 宿主把**剪贴板里的图片**开成一个无边框置顶小窗（`pin-<ms>-<seq>`），
 * 本文件挂载 `src/windows/pin/PinApp.vue`：1:1 铺满图片 + 右键菜单
 * （显示编辑工具 / 关闭 / 复制）+ 编辑工具条（画笔 / 矩形 / 椭圆 / 箭头 /
 * 文字 / 橡皮）。
 *
 * 这不是插件视图——贴图是独立小窗，与截图遮罩同理由宿主创建；
 * 页面通过 `pin_image_data` / `pin_close` / `pin_cleanup` 与宿主协作。
 */
import { createApp } from "vue";
import App from "./windows/pin/PinApp.vue";

window.addEventListener("error", (event) => {
  console.error("[贴图] 未捕获的错误:", event.error ?? event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  console.error("[贴图] 未处理的 Promise 拒绝:", event.reason);
});

const app = createApp(App);
app.config.errorHandler = (err, _instance, info) => {
  console.error("[贴图] Vue 渲染错误:", err, info);
};
app.mount("#app");
