/**
 * 截图遮罩的逻辑层（与 App.vue 分离，便于单测）。
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
 */
import { reactive, readonly } from "vue";
import { invoke } from "@tauri-apps/api/core";

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

/** 标注形状（统一直线/矩形/椭圆/笔迹/箭头/文字/马赛克/模糊为「一笔」） */
export interface Stroke {
  id: number;
  kind: "rect" | "ellipse" | "arrow" | "pen" | "text" | "mosaic" | "blur";
  /** CSS 像素，选区画布坐标系 */
  x: number;
  y: number;
  w: number;
  h: number;
  /** pen / blur：路径点（相对 x,y） */
  points?: Array<{ x: number; y: number }>;
  color: string;
  lineWidth: number;
  text?: string;
  fontSize?: number;
}

type Tool = Stroke["kind"] | "select";

/* ---------------- 状态 ---------------- */

interface OverlayState {
  ready: boolean;
  /** 本页是否承载选区（多屏时只有鼠标松开的那一屏进编辑态） */
  active: boolean;
  error: string;
  /** 冻结底图（本屏） */
  baseImage: string;
  monitor: MonitorInfo | null;
  monitorCount: number;
  /** 选区（CSS 像素，本窗口坐标系） */
  sel: { x: number; y: number; w: number; h: number } | null;
  /** 拖拽中（还没松开） */
  dragging: boolean;
  tool: Tool;
  color: string;
  lineWidth: number;
  strokes: Stroke[];
  /**
   * 正在画的那一笔（松手后才会移进 `strokes`）。
   *
   * 必须放在 **reactive 状态**里、让渲染层每帧都能一起画：它只存在模块作用域的
   * 普通变量时，`drawStrokes()` 遍历不到它，用户拖动过程中看不到任何反馈，
   * 只有松手那一刻才「啪」地出现——就是「动作完成才看到效果」的根因。
   */
  activeStroke: Stroke | null;
  /** 撤销 / 重做栈 */
  undoStack: Stroke[][];
  redoStack: Stroke[][];
  /** 当前选中的标注（编辑已有标注用；null = 没选中） */
  selectedId: number | null;
  showTextInput: boolean;
  textDraft: string;
  /** 文字输入框的落点（窗口坐标）：与最终绘制的文字同一处，避免「输入框在这、字画在那」 */
  textPos: { x: number; y: number } | null;
  /**
   * 正在编辑的**已有**文字标注 id（重新编辑文字用）。
   *
   * null = 在画新文字；非 null = 在改这一条（提交时替换它，而不是新增）。
   */
  editingTextId: number | null;
}

const state = reactive<OverlayState>({
  ready: false,
  active: false,
  error: "",
  baseImage: "",
  monitor: null,
  monitorCount: 1,
  sel: null,
  dragging: false,
  tool: "select",
  color: "#ff5555",
  lineWidth: 3,
  strokes: [],
  activeStroke: null,
  undoStack: [],
  redoStack: [],
  selectedId: null,
  showTextInput: false,
  textDraft: "",
  textPos: null,
  editingTextId: null,
});

let strokeSeq = 1;

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

/* ---------------- 标注 ---------------- */

export function setTool(tool: Tool): void {
  state.tool = tool;
  state.showTextInput = false;
  state.textPos = null;
  state.textDraft = "";
  state.editingTextId = null;
  // 切到「选择」以外的工具时清掉选中态：用户要开始画新的了，
  // 保留高亮会让人以为「新画的会附加到选中的那一笔上」。
  if (tool !== "select") state.selectedId = null;
}

/** 结束文字输入（提交或取消后共用）：把全部文字输入相关状态复位。 */
function closeTextInput(): void {
  state.showTextInput = false;
  state.textDraft = "";
  state.textPos = null;
  state.editingTextId = null;
}

/**
 * 改颜色：没选中时改的是「下一笔的颜色」，选中时**同时改这一笔**。
 *
 * 这样用户改一个已画矩形的颜色不必重画；也避免「选中着改色却看不到变化」。
 */
export function setColor(color: string): void {
  state.color = color;
  restyleSelected({ color });
}

export function setLineWidth(w: number): void {
  state.lineWidth = Math.max(1, Math.min(20, w));
  restyleSelected({ lineWidth: state.lineWidth });
}

/** 在选区画布上按下：开始一笔（select 工具不画）。 */
export function beginStroke(x: number, y: number): void {
  if (!state.active || state.tool === "select") return;
  if (state.tool === "text") {
    state.showTextInput = true;
    state.textDraft = "";
    state.editingTextId = null;
    // 输入框贴在文字将要落下的位置（与 commitText 用同一个坐标）
    state.textPos = { x, y };
    return;
  }
  state.activeStroke = {
    id: strokeSeq++,
    kind: state.tool,
    x,
    y,
    w: 0,
    h: 0,
    // 笔迹点一律存**相对笔画起点**的偏移：绘制时 drawStroke 会把 s.x/s.y 加回去，
    // 存绝对坐标会被加两次（选区离原点越远偏得越多，最终整笔落到画布外看不见）。
    points: state.tool === "pen" || state.tool === "blur" ? [{ x: 0, y: 0 }] : undefined,
    color: state.color,
    lineWidth: state.lineWidth,
  };
}

export function updateStroke(x: number, y: number): void {
  const s = state.activeStroke;
  if (!s) return;
  if (s.kind === "pen" || s.kind === "blur") {
    s.points?.push({ x: x - s.x, y: y - s.y });
  } else {
    s.w = x - s.x;
    s.h = y - s.y;
  }
}

export function endStroke(): void {
  const s = state.activeStroke;
  if (!s) return;
  state.activeStroke = null;
  // 矩形/椭圆把负宽高规整成正的（它们没有方向）；**箭头不能规整**——
  // 它的方向就是 (w,h) 的符号，归一成正值会让「从右下往左上拖」的箭头
  // 松手后翻成指向右下，与拖动时看到的完全相反（用户反馈的「与实际不一致」）。
  if (s.kind === "rect" || s.kind === "ellipse" || s.kind === "mosaic" || s.kind === "blur") {
    const x = Math.min(s.x, s.x + s.w);
    const y = Math.min(s.y, s.y + s.h);
    s.w = Math.abs(s.w);
    s.h = Math.abs(s.h);
    s.x = x;
    s.y = y;
  }
  // 太小丢弃（用绝对值：箭头保留方向后 w/h 可能是负的，直接比大小会把
  // 「从右下往左上拖」的箭头整条当成误触丢掉）
  const tiny =
    s.kind === "pen" || s.kind === "blur"
      ? (s.points?.length ?? 0) < 2
      : Math.abs(s.w) < 3 && Math.abs(s.h) < 3;
  if (!tiny) {
    pushStroke(s);
  }
}

/** 提交文字标注（回车或**失去焦点**时调用）。 */
export function commitText(text: string): void {
  const pos = state.textPos;
  if (!state.active || !state.showTextInput || !pos) return;
  const t = String(text ?? "").trim();
  const editId = state.editingTextId;
  // 空文本：不改也不落笔，只关掉输入框
  if (!t) {
    closeTextInput();
    return;
  }
  // 字号与 drawStroke 的 `font` 及输入框的 `font-size` 三处保持一致，
  // 否则「输入时看到的字号」与「画上去的字号」不同（也是「与实际不一致」的一种）。
  const fs = textFontSize(state.lineWidth);
  if (editId != null) {
    // 重新编辑已有文字：替换它的内容（原样式与位置保留），记一次撤销点
    const idx = state.strokes.findIndex((s) => s.id === editId);
    if (idx >= 0) {
      const prev = state.strokes[idx];
      const next = state.strokes.slice();
      next[idx] = { ...prev, text: t, color: state.color, lineWidth: state.lineWidth, fontSize: fs };
      state.undoStack.push([...state.strokes]);
      state.redoStack = [];
      state.strokes = next;
    }
    closeTextInput();
    return;
  }
  pushStroke({
    id: strokeSeq++,
    kind: "text",
    x: pos.x,
    y: pos.y,
    w: 0,
    h: 0,
    color: state.color,
    lineWidth: state.lineWidth,
    text: t,
    fontSize: fs,
  });
  closeTextInput();
}

/**
 * 重新编辑一条已写入的文字标注：选中它、把草稿填成原文、重开输入框。
 * 提交时会**替换**这一条（见 commitText 的 editId 分支），而不是新增一条。
 */
export function beginEditText(id: number): boolean {
  const s = state.strokes.find((it) => it.id === id && it.kind === "text");
  if (!s) return false;
  state.tool = "text";
  state.selectedId = id;
  state.editingTextId = id;
  state.textPos = { x: s.x, y: s.y };
  state.textDraft = s.text ?? "";
  state.color = s.color;
  state.lineWidth = s.lineWidth;
  state.showTextInput = true;
  return true;
}

/** 文字字号：线宽越粗字越大。绘制、输入框、提交三处共用，保证所见即所得。 */
export function textFontSize(lineWidth: number): number {
  return Math.max(12, lineWidth * 5);
}

/**
 * 入栈并清 redo。
 *
 * 栈里存的是**变更前**的快照，因此 `undo()` 弹出的就是「上一笔之前」的状态。
 * 反过来（先加进 strokes 再快照）会让撤销变成空操作——实际踩到过：
 * 点「撤销」按钮只看到按钮禁用状态变化，画布上的笔迹纹丝不动。
 */
function pushStroke(s: Stroke): void {
  state.undoStack.push([...state.strokes]);
  state.strokes = [...state.strokes, s];
  state.redoStack = [];
}

export function undo(): void {
  if (state.undoStack.length === 0) return;
  state.redoStack.push([...state.strokes]);
  state.strokes = state.undoStack.pop() ?? [];
}

export function redo(): void {
  if (state.redoStack.length === 0) return;
  state.undoStack.push([...state.strokes]);
  state.strokes = state.redoStack.pop() ?? [];
}

/* ---------------- 编辑已有标注（选中 / 移动 / 改样式 / 删除） ---------------- */

/**
 * 一笔的包围盒（选区画布坐标系 = 窗口 CSS 像素）。
 *
 * 文字与画笔的包围盒只能近似：文字按字号与字数估宽度（拿不到 ctx 的精确测量，
 * 而这里要保持纯函数、可单测），画笔按路径点取极值。用于命中测试足够——
 * 命中判定还会加一圈容差。
 */
export function strokeBounds(s: Stroke): { x: number; y: number; w: number; h: number } {
  if (s.kind === "pen" || s.kind === "blur") {
    const pts = s.points ?? [];
    if (pts.length === 0) return { x: s.x, y: s.y, w: 0, h: 0 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      const px = s.x + p.x;
      const py = s.y + p.y;
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  if (s.kind === "text") {
    const fs = s.fontSize ?? 16;
    const chars = [...String(s.text ?? "")].length;
    // 中日韩字符约为字号宽，ASCII 约 0.55 倍；粗略折中成 0.8 倍字号，
    // 命中测试再靠容差兜住误差（不追求像素级精确，否则要引入 DOM 测量）。
    return { x: s.x, y: s.y, w: chars * fs * 0.8, h: fs };
  }
  // 矩形 / 椭圆 / 箭头 / 马赛克：几何形状本身就是包围盒（可能带负宽高）
  return {
    x: Math.min(s.x, s.x + s.w),
    y: Math.min(s.y, s.y + s.h),
    w: Math.abs(s.w),
    h: Math.abs(s.h),
  };
}

/** 点是否落在某一笔上（含容差，方便点细线） */
export function hitStroke(s: Stroke, x: number, y: number, tolerance = 4): boolean {
  const b = strokeBounds(s);
  const pad = Math.max(tolerance, s.lineWidth);
  return (
    x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad
  );
}

/**
 * 找出鼠标位置下**最上面**的那一笔（后画的在上层）。
 *
 * 从后往前找，命中即返回：这符合「点谁选中谁」的直觉——重叠时选中的应该是
 * 视觉上盖在最上面的那一笔。
 */
export function pickStroke(x: number, y: number): Stroke | null {
  for (let i = state.strokes.length - 1; i >= 0; i--) {
    const s = state.strokes[i];
    if (hitStroke(s, x, y)) return s;
  }
  return null;
}

/** 选中一笔（传 null 取消选中）。选中态只是「当前操作对象」，不影响绘制内容。 */
export function selectStroke(id: number | null): void {
  state.selectedId = id;
}

/** 当前选中的那一笔（可能已被撤销掉，所以按 id 现查） */
export function selectedStroke(): Stroke | null {
  if (state.selectedId == null) return null;
  return state.strokes.find((s) => s.id === state.selectedId) ?? null;
}

/** 移动中的一笔：记住起点与原始坐标，move 时基于原始值重算 */
let strokeDrag: { id: number; startX: number; startY: number; orig: Stroke } | null = null;

export function beginStrokeMove(id: number, x: number, y: number): boolean {
  const s = state.strokes.find((it) => it.id === id);
  if (!s) return false;
  strokeDrag = { id, startX: x, startY: y, orig: { ...s, points: s.points?.map((p) => ({ ...p })) } };
  state.selectedId = id;
  return true;
}

/** 拖动中移动选中笔。返回是否真的动过 */
export function updateStrokeMove(x: number, y: number): boolean {
  if (!strokeDrag) return false;
  const dx = x - strokeDrag.startX;
  const dy = y - strokeDrag.startY;
  const idx = state.strokes.findIndex((s) => s.id === strokeDrag!.id);
  if (idx < 0) return false;
  const o = strokeDrag.orig;
  state.strokes[idx] = { ...o, x: o.x + dx, y: o.y + dy };
  return true;
}

/**
 * 松手结束移动。只有真的移动过才记一次撤销点。
 *
 * 为什么要在这里补撤销点：拖动过程中每帧都在改 `strokes`，若每帧都入栈，
 * 撤销栈会被几十条中间态撑爆；而完全不记，用户就没法撤销「挪错位置」。
 * 折中：拖动期间不入栈，**松手时**用「移动前」的快照入一次栈。
 */
export function endStrokeMove(): boolean {
  if (!strokeDrag) return false;
  const { id, orig } = strokeDrag;
  strokeDrag = null;
  const idx = state.strokes.findIndex((s) => s.id === id);
  if (idx < 0) return false;
  const cur = state.strokes[idx];
  if (cur.x === orig.x && cur.y === orig.y) return false; // 没动过
  const next = state.strokes.slice();
  next[idx] = { ...orig, x: orig.x, y: orig.y };
  // 栈里存「变更前」的整份列表
  state.undoStack.push(next);
  state.redoStack = [];
  return true;
}

/** 是否正在拖动某一笔 */
export function isMovingStroke(): boolean {
  return strokeDrag !== null;
}

/* ---------------- 缩放已有标注（拖包围盒控制点） ---------------- */

/** 包围盒四角 */
export type ResizeCorner = "nw" | "ne" | "se" | "sw";

let strokeResize: { id: number; corner: ResizeCorner; orig: Stroke } | null = null;

/** 把一条笔的轨迹点按 (sx,sy) 缩放，并平移到新的原点 */
function scalePoints(
  s: Stroke,
  pts: Array<{ x: number; y: number }>,
  sx: number,
  sy: number,
  nx: number,
  ny: number
): Array<{ x: number; y: number }> {
  return pts.map((p) => ({ x: nx + p.x * sx - s.x * sx, y: ny + p.y * sy - s.y * sy }));
}

/**
 * 拖包围盒某一角 → 改这一笔的几何。
 *
 * 各形状语义不同，这里统一到「对角固定、拖的角跟着走」：
 *   - rect / ellipse / mosaic / blur / pen：改包围盒（轨迹点按比例缩放）；
 *   - arrow：改**端点**（起点或终点跟着走，方向随之改变）；
 *   - text：改**字号**（按包围盒高度的比例缩放），左上角锚点不动。
 */
export function beginStrokeResize(id: number, corner: ResizeCorner, _x: number, _y: number): boolean {
  const s = state.strokes.find((it) => it.id === id);
  if (!s) return false;
  strokeResize = {
    id,
    corner,
    orig: { ...s, points: s.points?.map((p) => ({ ...p })) },
  };
  state.selectedId = id;
  return true;
}

/** 拖动中按光标位置重算这一笔几何。返回是否真的变了 */
export function updateStrokeResize(x: number, y: number): boolean {
  const rs = strokeResize;
  if (!rs) return false;
  const idx = state.strokes.findIndex((s) => s.id === rs.id);
  if (idx < 0) return false;
  const o = rs.orig;
  const next = state.strokes.slice();
  const corner = rs.corner;
  // 对角那个点是固定的（拖 nw 时 se 不动，反之亦然）
  const fx = corner === "nw" || corner === "sw" ? o.x + o.w : o.x;
  const fy = corner === "nw" || corner === "ne" ? o.y + o.h : o.y;
  const nx = Math.min(x, fx);
  const ny = Math.min(y, fy);
  const nw = Math.abs(x - fx);
  const nh = Math.abs(y - fy);

  if (o.kind === "arrow") {
    // 箭头改端点：拖哪个角就移动对应的那一端，另一端固定。
    // 起点 = (o.x,o.y)，终点 = (o.x+o.w, o.y+o.h)。哪一端靠拖的那个角近，就动哪一端。
    const startX = o.x, startY = o.y;
    const endX = o.x + o.w, endY = o.y + o.h;
    const dragStart = corner === "nw" || corner === "ne";
    if (dragStart) {
      next[idx] = { ...o, x, y, w: endX - x, h: endY - y };
    } else {
      next[idx] = { ...o, x: startX, y: startY, w: x - startX, h: y - startY };
    }
  } else if (o.kind === "text") {
    // 文字：按高度比例改字号（宽度随字数自动，不拉伸）。用「拖角到对角」的
    // 垂直距离与原始高度之比作缩放，字号同步线宽（fontSize = textFontSize(lineWidth)）。
    const oh = o.h > 0 ? o.h : (o.fontSize ?? 16);
    const ratio = oh > 0 ? Math.max(0.1, nh / oh) : 1;
    const baseLw = o.lineWidth > 0 ? o.lineWidth : 3;
    const newLw = Math.max(1, Math.min(20, Math.round(baseLw * ratio)));
    next[idx] = { ...o, x: nx, y: ny, lineWidth: newLw, fontSize: textFontSize(newLw), w: 0, h: 0 };
  } else if (o.kind === "pen" || o.kind === "blur") {
    const ow = o.w > 0 ? o.w : 1;
    const oh = o.h > 0 ? o.h : 1;
    const sx = ow > 1 ? nw / ow : 1;
    const sy = oh > 1 ? nh / oh : 1;
    next[idx] = {
      ...o,
      x: nx,
      y: ny,
      w: nw,
      h: nh,
      points: scalePoints(o, o.points ?? [], sx, sy, nx, ny),
    };
  } else {
    // rect / ellipse / mosaic：几何形状直接改包围盒
    next[idx] = { ...o, x: nx, y: ny, w: nw, h: nh };
  }
  state.strokes = next;
  return true;
}

/** 松手结束缩放：真的变过才补一个撤销点（与移动同一策略，拖动期间不入栈）。 */
export function endStrokeResize(): boolean {
  const rs = strokeResize;
  if (!rs) return false;
  strokeResize = null;
  const { id, orig } = rs;
  const cur = state.strokes.find((s) => s.id === id);
  if (!cur) return false;
  const same =
    cur.x === orig.x &&
    cur.y === orig.y &&
    cur.w === orig.w &&
    cur.h === orig.h &&
    cur.lineWidth === orig.lineWidth;
  if (same) return false;
  const next = state.strokes.slice();
  const i = next.findIndex((s) => s.id === id);
  next[i] = orig;
  state.undoStack.push(next);
  state.redoStack = [];
  return true;
}

/** 是否正在缩放某一笔 */
export function isResizingStroke(): boolean {
  return strokeResize !== null;
}

/** 删除选中的那一笔 */
export function deleteSelectedStroke(): boolean {
  const id = state.selectedId;
  if (id == null) return false;
  const idx = state.strokes.findIndex((s) => s.id === id);
  if (idx < 0) return false;
  state.undoStack.push([...state.strokes]);
  state.redoStack = [];
  state.strokes = state.strokes.filter((s) => s.id !== id);
  state.selectedId = null;
  return true;
}

/**
 * 改选中笔的颜色 / 线宽（选中态下点色板或调粗细时走这里）。
 *
 * 与「改了样式再画新的一笔」是两件事：没有选中时改的是「下一笔的样式」，
 * 有选中时同时改这一笔。这样用户既不必为了改一个矩形的颜色而重画，
 * 也不会在选中状态下改样式却看不到变化。
 */
export function restyleSelected(patch: { color?: string; lineWidth?: number }): boolean {
  const s = selectedStroke();
  if (!s) return false;
  const idx = state.strokes.findIndex((it) => it.id === s.id);
  if (idx < 0) return false;
  const next = state.strokes.slice();
  const updated: Stroke = { ...s, ...patch };
  // 文字字号跟随线宽（与新建文字同一条规则）
  if (updated.kind === "text" && patch.lineWidth != null) {
    updated.fontSize = textFontSize(patch.lineWidth);
  }
  next[idx] = updated;
  state.undoStack.push([...state.strokes]);
  state.redoStack = [];
  state.strokes = next;
  return true;
}

/* ---------------- 完成 / 取消 ---------------- */

/** 把选区画布（含标注）合成 PNG data URL。 */
export function composeSelectionPng(): string | null {
  const s = state.sel;
  if (!s) return null;
  // 调用方传入的选区画布（App.vue 里 <canvas ref>），这里通过参数拿
  // 见 App.vue 的 canvasRef；为保持本文件不依赖 DOM，由 App 传入画布。
  return null;
}

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

export const overlayState = readonly(state);

/** 内部可变引用（App.vue 渲染用，不导出给插件） */
export function mutableState() {
  return state;
}
