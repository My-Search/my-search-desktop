/// <reference types="vite/client" />

/** 由 vite.config.ts 的 define 注入的应用版本号 */
declare const __APP_VERSION__: string;

/**
 * config.html 内联兜底脚本挂到 window 上的取消函数：
 * Vue 成功挂载后调用它，取消「8 秒未挂载 → 显示加载失败提示」的兜底定时器。
 */
interface Window {
  __cancelConfigFallback?: () => void;
}
