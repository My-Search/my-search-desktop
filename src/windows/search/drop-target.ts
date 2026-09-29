/**
 * 拖放落点判定 —— 「这次拖入该归谁」的纯逻辑。
 *
 * ## 为什么需要它
 *
 * 主窗口保留着 Tauri 的**原生**拖放处理器（见 App.vue 的 onDragDropEvent），
 * 这带来两个后果：
 *   1. 插件页里那套标准 HTML5 `dragover/drop` **永远不会触发**——事件在
 *      WebView 层就被原生处理器吃掉了（Tauri 文档：dragDropEnabled=true 时
 *      前端收不到 HTML5 drop）。因此插件无法自己判断「文件落在我身上了」；
 *   2. 原生 `drop` 事件只带 `paths` 和一个窗口坐标，宿主**必须自己**把坐标
 *      换算成「落在哪个元素上」，否则只能一律丢进搜索框附件区——这正是
 *      「拖到插件页面，高亮的却是上面的搜索框」这个 bug 的成因。
 *
 * 于是本模块把「坐标 → 归谁」这段判定独立出来：
 *   - 输入：落点元素、当前是否有前台插件会话、该会话的载体元素；
 *   - 输出：`"plugin"`（交给插件视图）或 `"attachments"`（进搜索框附件）。
 *
 * ## 为什么只认「前台会话的载体」
 *
 * 插件会话可以被**停靠**（`closeBehavior: "minimize"`，DOM 搬进隐藏的停车场
 * 保活）。停靠中的载体仍在 document 里（`display:none`），若不加限制，一个
 * 看不见的视图也可能把文件吃掉——用户会觉得「文件凭空消失了」。所以判定
 * 严格限定为：落点必须命中**当前前台会话**的载体子树，其余一律进附件列表。
 *
 * 纯逻辑、无 Vue / 无 DOM 查询（`elementFromPoint` 的结果由调用方传入），
 * 因此可以直接单测。
 */

/** 落点归属 */
export type DropTarget = "plugin" | "attachments";

/**
 * 会话载体的属性名（与 `plugin-channels.ts` 的 `PLUGIN_SESSION_ATTR` 一致）。
 *
 * 这里重新声明而不是 import：本模块要能被 Node 桩测试直接加载，不想拖进
 * `plugin-channels.ts` 对 `script-runtime.ts` 的类型依赖。两处值必须同步，
 * 由测试 `drop-target.test.mjs` 兜住。
 */
export const SESSION_ATTR = "data-ms-plugin-session";

/**
 * 沿 DOM 树向上找「承载拖放的那个元素」。
 *
 * 从落点元素一路向上找最近的会话载体（`.ms-plugin-session`），找到就判断它
 * 是不是**当前前台会话**那一个。
 *
 * @param hit        落点元素（`document.elementFromPoint` 的结果，可能为 null）
 * @param sessionEl  当前前台插件会话的载体元素（没有前台会话时为 null）
 * @returns 落点归属
 */
export function resolveDropTarget(
  hit: Element | null,
  sessionEl: Element | null
): DropTarget {
  // 没有前台插件会话：插件视图不在屏幕上，一切照旧进附件。
  if (!sessionEl) return "attachments";
  if (!hit) return "attachments";
  // 落点必须落在**前台**会话载体的子树里。停靠（保活）中的会话载体不在
  // 这里传进来，因此它们收不到投递，文件不会被看不见的视图吃掉。
  return sessionEl.contains(hit) ? "plugin" : "attachments";
}

/**
 * 把 Tauri 原生拖放事件里的**物理坐标**换算成 CSS 像素坐标。
 *
 * Tauri 的 `payload.position` 是 `PhysicalPosition`（物理像素），在 HiDPI 屏上
 * 与 CSS 像素差一个 `scaleFactor`。不换算的话落点判定会整体偏移——1.5x 缩放
 * 下拉到插件区上半部分会被判成落在搜索框，正是这个 bug 的另一种表现。
 *
 * @param x            物理 X
 * @param y            物理 Y
 * @param scaleFactor  窗口缩放系数（`getCurrentWindow().scaleFactor()`）
 */
export function toCssPoint(
  x: number,
  y: number,
  scaleFactor: number | string
): { x: number; y: number } {
  // 用 Number() 而不是隐式转换：scaleFactor 经 IPC 回来可能是字符串 "1.5"。
  const raw = Number(scaleFactor);
  // 非法系数一律按 1 处理：宁可落点判定退化成「不缩放」，也不要在
  // scaleFactor 取不到（0 / NaN / 负数）时把坐标除成 NaN 或负数。
  const s = Number.isFinite(raw) && raw > 0 ? raw : 1;
  return { x: x / s, y: y / s };
}
