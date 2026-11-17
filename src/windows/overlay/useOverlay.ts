/**
 * 截图遮罩的逻辑层（选区 / 底图 / 宿主 IPC）。
 *
 * 协作协议：
 *   - 宿主开 `overlay-N` 窗口时抓了一张整屏位图，缓存在 Rust（PENDING_CAPTURE）；
 *   - 本页用 `screenshot_overlay_image(N)` 取**自己这一屏**的底图铺满；
 *   - 用户拖拽框选（CSS 像素），松开时用 `screenshot_crop(N, x,y,w,h)` 让宿主
 *     从整屏里裁出这块（物理像素，宿主处理 DPI）；
 *   - 标注只作用于「当前可见的选区画布」，复制/保存前把标注合成进位图。
 *
 * 关键坐标约定：页面上一律 CSS 像素；**只在调 `screenshot_crop` / `commit`
 * 时**交给 Rust 换算（`screenshot_crop` 的入参是 CSS 像素，内部乘 scaleFactor）。
 *
 * 标注引擎（笔画 / 工具 / 撤销 / 文字 / 马赛克 / 模糊）已抽到
 * `src/lib/annotation.ts`，由截图遮罩与**贴图窗口**共用（贴图工具栏与截图
 * 完全同一套的实现基础）；这里 re-export 全部引擎 API，宿主组件照旧只 import 本文件。
 */
import { invoke } from "@tauri-apps/api/core";
import { mutableState } from "../../lib/annotation.ts";

export * from "../../lib/annotation.ts";

/* ---------------- 类型 ---------------- */

export interface MonitorInfo {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
  isPrimary: boolean;
}

export interface OverlayImage {
  dataUrl: string;
  width: number;
  height: number;
  monitor: MonitorInfo;
  monitorCount: number;
  originX: number;
  originY: number;
}

const state = mutableState();

/* ---------------- 初始化 ---------------- */

/** 从 URL `?monitor=N` 读本页是第几屏 */
export function monitorIndexFromUrl(): number {
  try {
    const q = new URLSearchParams(window.location.search);
    const n = parseInt(q.get("monitor") ?? "0", 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** 取本屏冻结底图，进入可框选状态。失败（抓屏被清/多屏错位）时给 error。 */
export async function initOverlay(): Promise<void> {
  const idx = monitorIndexFromUrl();
  try {
    const img = await invoke<OverlayImage>("screenshot_overlay_image", { monitorIndex: idx });
    state.baseImage = img.dataUrl;
    state.monitor = img.monitor;
    state.monitorCount = img.monitorCount;
    state.ready = true;
    state.error = "";
  } catch (e) {
    state.error = `加载屏幕底图失败：${String((e as Error)?.message ?? e)}`;
    state.ready = false;
  }
}

/* ---------------- 框选 ---------------- */

export function beginSelect(x: number, y: number): void {
  if (state.active) return; // 已进入编辑态的屏不再开新选区
  state.dragging = true;
  state.sel = { x, y, w: 0, h: 0 };
}

export function updateSelect(x: number, y: number): void {
  if (!state.dragging || !state.sel) return;
  const s = state.sel;
  s.w = x - s.x;
  s.h = y - s.y;
}

/**
 * 松开：把负宽高的选区规整成正的。
 * 返回规整后的选区（供调用方决定是否 `commitSelection`）。
 */
export function endSelect(): { x: number; y: number; w: number; h: number } | null {
  state.dragging = false;
  const s = state.sel;
  if (!s) return null;
  const x = Math.min(s.x, s.x + s.w);
  const y = Math.min(s.y, s.y + s.h);
  const w = Math.abs(s.w);
  const h = Math.abs(s.h);
  state.sel = { x, y, w, h };
  if (w < 4 || h < 4) {
    // 太小视为误触，清掉
    state.sel = null;
    return null;
  }
  return { x, y, w, h };
}


/* ---------------- 编辑态：调整选区范围 ---------------- */

/** 可拖拽的把手位置（四角 + 四边） */
export type HandleDir = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
/** 选区内的操作：移动整个选区，还是拖某个把手改大小 */
export type SelDrag = { mode: "move" } | { mode: "resize"; dir: HandleDir };

/** 最小选区边长（CSS 像素）：比这更小的选区没有意义，且会让裁片退化成 0 像素 */
const MIN_SEL = 8;

/** 选区是否已经可以调整（编辑态下才有意义） */
export function selRect(): { x: number; y: number; w: number; h: number } | null {
  return state.sel;
}

/**
 * 按把手方向算出「新的选区矩形」。
 *
 * 纯函数，便于单测：给定原矩形、把手方向与鼠标当前位置，返回调整后的矩形。
 * 规则：
 *   - 被拖的那条边/那个角跟随鼠标，**对面那条边保持不动**；
 *   - 允许拖过头（左右互换），结果始终是正矩形（`x/y/w/h` 都非负）；
 *   - 最小边长 `MIN_SEL`：缩到比它还小时就卡住，避免选区塌成 0 或翻转。
 */
export function resizeRect(
  rect: { x: number; y: number; w: number; h: number },
  dir: HandleDir,
  px: number,
  py: number
): { x: number; y: number; w: number; h: number } {
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.w;
  let bottom = rect.y + rect.h;

  if (dir.includes("w")) left = px;
  if (dir.includes("e")) right = px;
  if (dir.includes("n")) top = py;
  if (dir.includes("s")) bottom = py;

  // 允许拖过头（互换），再统一成正矩形
  let x = Math.min(left, right);
  let y = Math.min(top, bottom);
  let w = Math.abs(right - left);
  let h = Math.abs(bottom - top);

  // 最小尺寸：朝哪边被拖就卡住哪边
  if (w < MIN_SEL) {
    w = MIN_SEL;
    if (dir.includes("w")) x = right - MIN_SEL;
  }
  if (h < MIN_SEL) {
    h = MIN_SEL;
    if (dir.includes("n")) y = bottom - MIN_SEL;
  }
  return { x, y, w, h };
}

/** 开始调整选区：记住起点与原始矩形，之后每次 move 都基于原始矩形重算（避免累积误差） */
let selEdit: {
  drag: SelDrag;
  startX: number;
  startY: number;
  orig: { x: number; y: number; w: number; h: number };
} | null = null;

/** 按下选区（或把手）：准备移动 / 缩放 */
export function beginSelEdit(drag: SelDrag, x: number, y: number): void {
  const s = state.sel;
  if (!s || !state.active) return;
  selEdit = { drag, startX: x, startY: y, orig: { ...s } };
}

/** 拖动中：移动选区或改大小。返回是否真的动过（供上层决定要不要重绘预览） */
export function updateSelEdit(x: number, y: number): boolean {
  if (!selEdit) return false;
  const { drag, orig } = selEdit;
  if (drag.mode === "move") {
    const dx = x - selEdit.startX;
    const dy = y - selEdit.startY;
    state.sel = { x: orig.x + dx, y: orig.y + dy, w: orig.w, h: orig.h };
  } else {
    state.sel = resizeRect(orig, drag.dir, x, y);
  }
  return true;
}

/** 松手：把最终选区规整成整数像素，并返回它（供上层按新范围重取裁片） */
export function endSelEdit(): { x: number; y: number; w: number; h: number } | null {
  if (!selEdit) return null;
  const orig = selEdit.orig;
  selEdit = null;
  const s = state.sel;
  if (!s) return null;
  state.sel = {
    x: Math.round(s.x),
    y: Math.round(s.y),
    w: Math.round(s.w),
    h: Math.round(s.h),
  };
  // 没动过就不必让上层重取裁片（省一次 IPC + 一次整块 PNG 编码）
  const moved =
    state.sel.x !== Math.round(orig.x) ||
    state.sel.y !== Math.round(orig.y) ||
    state.sel.w !== Math.round(orig.w) ||
    state.sel.h !== Math.round(orig.h);
  return moved ? { ...state.sel } : null;
}

/** 是否正在调整选区（供上层在拖动中做廉价预览、松手后再精确重取） */
export function isEditingSel(): boolean {
  return selEdit !== null;
}


/** 用宿主抓屏裁出选区 → 本屏进入编辑态（其它屏由宿主关闭）。 */
export async function commitSelection(): Promise<{ dataUrl: string; width: number; height: number } | null> {
  const s = state.sel;
  const m = state.monitor;
  if (!s || !m) return null;
  try {
    const crop = await invoke<{ dataUrl: string; width: number; height: number }>(
      "screenshot_crop",
      {
        monitorIndex: m.index,
        x: s.x,
        y: s.y,
        width: s.w,
        height: s.h,
      }
    );
    // 进入编辑态：冻结选区，后续标注都画在选区画布上。
    // 只在**首次**进入时落到「选择」工具；调整范围后的重取裁片也会走这里，
    // 那时必须保留用户正拿着的工具（否则画到一半拖了下边缘，笔就变回箭头了）。
    if (!state.active) state.tool = "select";
    state.active = true;
    return { dataUrl: crop.dataUrl, width: crop.width, height: crop.height };
  } catch (e) {
    state.error = `裁切选区失败：${String((e as Error)?.message ?? e)}`;
    return null;
  }
}

/** 框选矩形在整屏帧里的精确裁片（标注页当底图，1:1 清晰）。 */
export async function selectionImage(): Promise<{ dataUrl: string; width: number; height: number } | null> {
  try {
    return await invoke<{ dataUrl: string; width: number; height: number }>(
      "screenshot_selection_image"
    );
  } catch {
    return null;
  }
}

/* ---------------- 完成 / 取消 ---------------- */

export async function closeAllOverlays(): Promise<void> {
  try {
    await invoke("screenshot_close_overlay");
  } catch {
    /* 宿主可能已关；忽略 */
  }
}

/** 取消：关所有遮罩，恢复主窗。 */
export async function cancelCapture(): Promise<void> {
  await closeAllOverlays();
}
