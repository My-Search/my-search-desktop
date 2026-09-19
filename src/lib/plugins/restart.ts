/**
 * 插件「重启」的前端标记 —— 写在设置窗口、消费在搜索窗口。
 *
 * 设置窗口点了「重启」后要同时做两件事：
 *   1. 后台进程立即重启（Rust 侧 stop + spawn，走 ipc.restartPluginBackend）；
 *   2. 前端会话在**下次打开**时重新挂载——因为保活（最小化）的会话内存里
 *      跑的是旧代码，而且 `decideViewRestore` 会因为入口没变而选择「恢复」，
 *      那等于重启了后端、前端还在用旧界面旧脚本。
 *
 * 两个窗口是**独立 WebView**，唯一的共享就是 localStorage（注册表就是靠它
 * 同步的）。因此前端这一半用一个「重启标记」传递意图：设置窗口写入插件 id，
 * 搜索窗口在呼出/获得焦点（syncPluginSessions）与打开插件视图（open）时消费，
 * 强制卸载该插件的会话——下次 open() 没有会话可恢复，自然重新挂载。
 *
 * 函数的语义（见各自的注释）：
 *   - markPluginFrontendRestart       写意图（幂等，同一插件只记一次）
 *   - takePluginFrontendRestartMarks  批量取出并清空（搜索窗口对齐时用）
 *   - consumePluginFrontendRestart    单个取出（打开某插件视图时用，不动其它）
 */

/** 重启标记的持久化键（与注册表键同一命名风格） */
export const PLUGIN_RESTART_MARKS_KEY = "PLUGIN_RESTART_MARKS_CACHE_KEY";

/** 标记某插件需要前端重启（幂等；解析/写入失败都吞掉，不影响主流程） */
export function markPluginFrontendRestart(pluginId: string): void {
  try {
    const marks = readMarks();
    if (!marks.includes(pluginId)) marks.push(pluginId);
    localStorage.setItem("my-search-desktop:" + PLUGIN_RESTART_MARKS_KEY, JSON.stringify(marks));
  } catch (e) {
    console.warn("插件重启标记写入失败:", e);
  }
}

/** 取出并清空全部重启标记（返回需要前端重启的插件 id 列表） */
export function takePluginFrontendRestartMarks(): string[] {
  const marks = readMarks();
  try {
    localStorage.removeItem("my-search-desktop:" + PLUGIN_RESTART_MARKS_KEY);
  } catch (e) {
    console.warn("插件重启标记清除失败:", e);
  }
  return marks;
}

/**
 * 消费单个插件的重启标记：该插件需要前端重启返回 true，并从标记集中移除
 * 它（不影响其它插件）。打开插件视图时调用，保证「设置里重启过 → 这次打开
 * 必定重新挂载」，不依赖呼出/焦点事件的时序。
 */
export function consumePluginFrontendRestart(pluginId: string): boolean {
  try {
    const marks = readMarks();
    const idx = marks.indexOf(pluginId);
    if (idx < 0) return false;
    marks.splice(idx, 1);
    localStorage.setItem("my-search-desktop:" + PLUGIN_RESTART_MARKS_KEY, JSON.stringify(marks));
    return true;
  } catch (e) {
    return false;
  }
}

/** 读重启标记（损坏/为空按空集处理） */
function readMarks(): string[] {
  try {
    const raw = localStorage.getItem("my-search-desktop:" + PLUGIN_RESTART_MARKS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x: unknown): x is string => typeof x === "string") : [];
  } catch (e) {
    return [];
  }
}