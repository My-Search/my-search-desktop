/**
 * 标注引擎（截图遮罩与贴图窗口共用）。
 *
 * 从 useOverlay.ts 抽出的纯标注层：笔画状态、工具切换、形状/文字/马赛克/模糊、
 * 选中/移动/缩放、撤销/重做、文字再编辑（含编辑时隐藏原字）。不 import 任何
 * Tauri API、不依赖具体窗口，截图遮罩（overlay-N）与贴图小窗（pin-*）跑同一份
 * 交互与渲染逻辑——「贴图工具栏跟截图一样」的实现基础。
 *
 * 坐标约定：笔画一律存 CSS 像素（窗口坐标）；渲染时由调用方传 scale（CSS →
 * 画布物理像素）与原点（截图=选区左上角，贴图=0,0），见 DrawEnv。
 */
import { reactive, readonly } from "vue";

export interface Stroke {
  id: number;
  kind: "rect" | "ellipse" | "arrow" | "pen" | "text" | "mosaic" | "blur";
  x: number;
  y: number;
  w: number;
  h: number;
  points?: Array<{ x: number; y: number }>;
  color: string;
  lineWidth: number;
  text?: string;
  fontSize?: number;
}

export type Tool = Stroke["kind"] | "select";

export const TOOLS = [
  { id: "select", icon: "➤", label: "选择" },
  { id: "rect", icon: "▭", label: "矩形" },
  { id: "ellipse", icon: "◯", label: "椭圆" },
  { id: "arrow", icon: "➜", label: "箭头" },
  { id: "pen", icon: "✎", label: "画笔" },
  { id: "text", icon: "T", label: "文字" },
  { id: "mosaic", icon: "▩", label: "马赛克" },
  { id: "blur", icon: "◍", label: "模糊" },
] as const;

export const COLORS = ["#ff5555", "#ffaa00", "#33cc55", "#3399ff", "#ffffff", "#000000"];

interface AnnotationState {
  active: boolean;
  tool: Tool;
  color: string;
  lineWidth: number;
  strokes: Stroke[];
  activeStroke: Stroke | null;
  undoStack: Stroke[][];
  redoStack: Stroke[][];
  selectedId: number | null;
  showTextInput: boolean;
  textDraft: string;
  textPos: { x: number; y: number } | null;
  editingTextId: number | null;
  hiddenTextId: number | null;
  ready: boolean;
  error: string;
  baseImage: string;
  monitor: {
    index: number;
    x: number;
    y: number;
    width: number;
    height: number;
    scaleFactor: number;
    isPrimary: boolean;
  } | null;
  monitorCount: number;
  sel: { x: number; y: number; w: number; h: number } | null;
  dragging: boolean;
}

const state = reactive<AnnotationState>({
  active: false,
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
  hiddenTextId: null,
  ready: false,
  error: "",
  baseImage: "",
  monitor: null,
  monitorCount: 1,
  sel: null,
  dragging: false,
});

let strokeSeq = 1;

export function setTool(tool: Tool): void {
  state.tool = tool;
  state.showTextInput = false;
  state.textPos = null;
  state.textDraft = "";
  state.editingTextId = null;
  state.hiddenTextId = null;
  if (tool !== "select") state.selectedId = null;
}

export function closeTextInput(): void {
  state.showTextInput = false;
  state.textDraft = "";
  state.textPos = null;
  state.editingTextId = null;
  state.hiddenTextId = null;
}

export function setColor(color: string): void {
  state.color = color;
  restyleSelected({ color });
}

export function setLineWidth(w: number): void {
  state.lineWidth = Math.max(1, Math.min(20, w));
  restyleSelected({ lineWidth: state.lineWidth });
}

export function beginStroke(x: number, y: number): void {
  if (!state.active || state.tool === "select") return;
  if (state.tool === "text") {
    state.showTextInput = true;
    state.textDraft = "";
    state.editingTextId = null;
    state.hiddenTextId = null;
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
  if (s.kind === "rect" || s.kind === "ellipse" || s.kind === "mosaic" || s.kind === "blur") {
    const x = Math.min(s.x, s.x + s.w);
    const y = Math.min(s.y, s.y + s.h);
    s.w = Math.abs(s.w);
    s.h = Math.abs(s.h);
    s.x = x;
    s.y = y;
  }
  const tiny =
    s.kind === "pen" || s.kind === "blur"
      ? (s.points?.length ?? 0) < 2
      : Math.abs(s.w) < 3 && Math.abs(s.h) < 3;
  if (!tiny) pushStroke(s);
}

export function commitText(text: string): void {
  const pos = state.textPos;
  if (!state.active || !state.showTextInput || !pos) return;
  const t = String(text ?? "").trim();
  const editId = state.editingTextId;
  if (!t) {
    closeTextInput();
    return;
  }
  const fs = textFontSize(state.lineWidth);
  if (editId != null) {
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

export function beginEditText(id: number): boolean {
  const s = state.strokes.find((it) => it.id === id && it.kind === "text");
  if (!s) return false;
  state.tool = "text";
  state.selectedId = id;
  state.editingTextId = id;
  state.hiddenTextId = id;
  state.textPos = { x: s.x, y: s.y };
  state.textDraft = s.text ?? "";
  state.color = s.color;
  state.lineWidth = s.lineWidth;
  state.showTextInput = true;
  return true;
}

export function textFontSize(lineWidth: number): number {
  return Math.max(12, lineWidth * 5);
}

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

export function strokeBounds(s: Stroke): { x: number; y: number; w: number; h: number } {
  if (s.kind === "text") {
    const fs = s.fontSize ?? textFontSize(s.lineWidth);
    const w = measureTextWidth(s.text ?? "", fs);
    const h = fs * 1.3; // textBaseline="top" 的字形墨迹含降部 + 输入框视觉高
    return { x: s.x, y: s.y, w, h };
  }
  if (s.kind === "pen" || s.kind === "blur") {
    const pts = s.points ?? [];
    if (pts.length === 0) return { x: s.x, y: s.y, w: 0, h: 0 };
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { x: s.x + minX, y: s.y + minY, w: maxX - minX, h: maxY - minY };
  }
  const x = Math.min(s.x, s.x + s.w);
  const y = Math.min(s.y, s.y + s.h);
  return { x, y, w: Math.abs(s.w), h: Math.abs(s.h) };
}

let measureCtx: CanvasRenderingContext2D | null = null;
function measureTextWidth(text: string, fontSize: number): number {
  if (typeof document === "undefined") {
    // 无 DOM（node 单测）：CJK/全角 1.0em、ASCII 0.55em 估宽
    let w = 0;
    for (const ch of text) w += ch.charCodeAt(0) > 0xff ? fontSize : fontSize * 0.55;
    return w;
  }
  if (!measureCtx) {
    const c = document.createElement("canvas");
    measureCtx = c.getContext("2d");
  }
  measureCtx!.font = `${fontSize}px sans-serif`;
  return measureCtx!.measureText(text).width;
}

/** 点 (x,y) 是否落在一笔的包围盒内（含线宽容差）。 */
export function hitStroke(s: Stroke, x: number, y: number, tolerance = 4): boolean {
  const b = strokeBounds(s);
  const pad = Math.max(tolerance, s.lineWidth);
  return x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad;
}

/**
 * 找出鼠标位置下**最上面**的那一笔（后画的在上层）。
 * 从后往前找，命中即返回：重叠时选中的应该是视觉上盖在最上面的那一笔。
 */
export function pickStroke(x: number, y: number): Stroke | null {
  for (let i = state.strokes.length - 1; i >= 0; i--) {
    const s = state.strokes[i];
    if (hitStroke(s, x, y)) return s;
  }
  return null;
}

/**
 * 找「鼠标位置下的那条文字」（最上层优先，文字优先于框线）。
 * 若它上方有不透明笔（马赛克/模糊）盖住这个点 → 视觉上字已被涂掉，返回 null。
 */
export function pickTextStroke(x: number, y: number): Stroke | null {
  let textIdx = -1;
  for (let i = state.strokes.length - 1; i >= 0; i--) {
    const s = state.strokes[i];
    if (s.kind === "text" && hitStroke(s, x, y)) {
      textIdx = i;
      break;
    }
  }
  if (textIdx < 0) return null;
  for (let i = state.strokes.length - 1; i > textIdx; i--) {
    const s = state.strokes[i];
    if ((s.kind === "mosaic" || s.kind === "blur") && hitStroke(s, x, y)) return null;
  }
  return state.strokes[textIdx];
}

export function selectStroke(id: number | null): void {
  state.selectedId = id;
}

export function selectedStroke(): Stroke | null {
  if (state.selectedId == null) return null;
  return state.strokes.find((s) => s.id === state.selectedId) ?? null;
}
/* ---------------- 移动已有标注（拖动换位） ---------------- */

let strokeDrag: { id: number; startX: number; startY: number; orig: Stroke } | null = null;

export function beginStrokeMove(id: number, x: number, y: number): boolean {
  const s = state.strokes.find((it) => it.id === id);
  if (!s) return false;
  strokeDrag = { id, startX: x, startY: y, orig: { ...s, points: s.points?.map((p) => ({ ...p })) } };
  state.selectedId = id;
  return true;
}

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

/** 松手才入撤销栈（移动前快照），拖动过程不入栈，避免中间态撑爆撤销栈。 */
export function endStrokeMove(): boolean {
  if (!strokeDrag) return false;
  const { id, orig } = strokeDrag;
  strokeDrag = null;
  const idx = state.strokes.findIndex((s) => s.id === id);
  if (idx < 0) return false;
  const cur = state.strokes[idx];
  if (cur.x === orig.x && cur.y === orig.y) return false;
  const next = state.strokes.slice();
  next[idx] = { ...orig, x: orig.x, y: orig.y };
  state.undoStack.push(next);
  state.redoStack = [];
  return true;
}

export function isMovingStroke(): boolean {
  return strokeDrag !== null;
}

/* ---------------- 缩放已有标注（拖包围盒控制点） ---------------- */

export type ResizeCorner = "nw" | "ne" | "se" | "sw";

let strokeResize: { id: number; corner: ResizeCorner; orig: Stroke } | null = null;

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

export function beginStrokeResize(id: number, corner: ResizeCorner, _x: number, _y: number): boolean {
  const s = state.strokes.find((it) => it.id === id);
  if (!s) return false;
  strokeResize = { id, corner, orig: { ...s, points: s.points?.map((p) => ({ ...p })) } };
  return true;
}

export function updateStrokeResize(x: number, y: number): boolean {
  const rr = strokeResize;
  if (!rr) return false;
  const idx = state.strokes.findIndex((s) => s.id === rr.id);
  if (idx < 0) return false;
  const o = rr.orig;
  const b = strokeBounds(o);
  const bx1 = b.x + b.w;
  const by1 = b.y + b.h;
  const ax = rr.corner === "ne" || rr.corner === "se" ? b.x : bx1;
  const ay = rr.corner === "sw" || rr.corner === "se" ? b.y : by1;
  const nw = Math.max(4, Math.abs(x - ax));
  const nh = Math.max(4, Math.abs(y - ay));
  const nx = Math.min(x, ax);
  const ny = Math.min(y, ay);
  const sx = b.w > 0 ? nw / Math.max(1, b.w) : 1;
  const sy = b.h > 0 ? nh / Math.max(1, b.h) : 1;
  if (o.kind === "arrow") {
    const isStart = rr.corner === "nw" || rr.corner === "sw";
    const next: Stroke = { ...o };
    if (isStart) {
      next.x = x;
      next.y = y;
      next.w = o.x + o.w - x;
      next.h = o.y + o.h - y;
    } else {
      next.w = x - o.x;
      next.h = y - o.y;
    }
    state.strokes[idx] = next;
    return true;
  }
  if (o.kind === "text") {
    const fs = Math.max(10, Math.round((o.fontSize ?? textFontSize(o.lineWidth)) * sy));
    state.strokes[idx] = { ...o, fontSize: fs, lineWidth: Math.max(1, Math.round(fs / 5)) };
    return true;
  }
  const next: Stroke = {
    ...o,
    x: nx,
    y: ny,
    w: nw,
    h: nh,
    points: o.points ? scalePoints(o, o.points, sx, sy, nx, ny) : undefined,
  };
  state.strokes[idx] = next;
  return true;
}

export function endStrokeResize(): boolean {
  if (!strokeResize) return false;
  const { id, orig } = strokeResize;
  strokeResize = null;
  const idx = state.strokes.findIndex((s) => s.id === id);
  if (idx < 0) return false;
  const cur = state.strokes[idx];
  if (
    cur.x === orig.x &&
    cur.y === orig.y &&
    cur.w === orig.w &&
    cur.h === orig.h &&
    cur.fontSize === orig.fontSize
  ) {
    return false;
  }
  const next = state.strokes.slice();
  next[idx] = orig;
  state.undoStack.push(next);
  state.redoStack = [];
  return true;
}

export function isResizingStroke(): boolean {
  return strokeResize !== null;
}

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

export function restyleSelected(patch: { color?: string; lineWidth?: number }): boolean {
  const s = selectedStroke();
  if (!s) return false;
  const idx = state.strokes.findIndex((it) => it.id === s.id);
  if (idx < 0) return false;
  const next = state.strokes.slice();
  const updated: Stroke = { ...s, ...patch };
  if (updated.kind === "text" && patch.lineWidth != null) {
    updated.fontSize = textFontSize(patch.lineWidth);
  }
  next[idx] = updated;
  state.undoStack.push([...state.strokes]);
  state.redoStack = [];
  state.strokes = next;
  return true;
}

export const overlayState = readonly(state);

export function mutableState() {
  return state;
}

/* ---------------- 渲染（与宿主无关：底图/缩放/原点由调用方给） ---------------- */

export interface DrawEnv {
  scale: number;
  originX: number;
  originY: number;
  base: HTMLCanvasElement | null;
}

export function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke, env: DrawEnv): void {
  ctx.save();
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = s.lineWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  switch (s.kind) {
    case "rect": {
      const x0 = Math.min(s.x, s.x + s.w);
      const y0 = Math.min(s.y, s.y + s.h);
      ctx.strokeRect(x0, y0, Math.abs(s.w), Math.abs(s.h));
      break;
    }
    case "ellipse": {
      const x0 = Math.min(s.x, s.x + s.w);
      const y0 = Math.min(s.y, s.y + s.h);
      ctx.beginPath();
      ctx.ellipse(x0 + Math.abs(s.w) / 2, y0 + Math.abs(s.h) / 2, Math.abs(s.w) / 2, Math.abs(s.h) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case "arrow": {
      const x1 = s.x, y1 = s.y, x2 = s.x + s.w, y2 = s.y + s.h;
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const head = Math.max(10, s.lineWidth * 4);
      const back = Math.min(s.lineWidth, Math.hypot(s.w, s.h) / 2);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2 - back * Math.cos(angle), y2 - back * Math.sin(angle));
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6));
      ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6));
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "pen": {
      const pts = s.points ?? [];
      if (pts.length < 2) break;
      ctx.beginPath();
      ctx.moveTo(s.x + pts[0].x, s.y + pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(s.x + pts[i].x, s.y + pts[i].y);
      ctx.stroke();
      break;
    }
    case "text": {
      const fs = s.fontSize ?? 16;
      ctx.font = `${fs}px sans-serif`;
      ctx.textBaseline = "top";
      ctx.fillText(s.text ?? "", s.x, s.y);
      break;
    }
    case "mosaic":
      drawMosaic(ctx, s, env);
      break;
    case "blur":
      drawBlur(ctx, s, env);
      break;
  }
  ctx.restore();
}

const mosaicCache = new WeakMap<Stroke, { key: string; colors: string[] }>();

function sampleMosaicColors(
  bctx: CanvasRenderingContext2D,
  base: HTMLCanvasElement,
  x0: number,
  y0: number,
  w: number,
  h: number,
  cell: number,
  ox: number,
  oy: number,
  sf: number
): string[] {
  const pts: number[] = [];
  let minX = 0;
  let minY = 0;
  let maxX = 0;
  let maxY = 0;
  let n = 0;
  for (let yy = y0; yy < y0 + h; yy += cell) {
    for (let xx = x0; xx < x0 + w; xx += cell) {
      const px = Math.min(base.width - 1, Math.max(0, Math.round((xx - ox + cell / 2) * sf)));
      const py = Math.min(base.height - 1, Math.max(0, Math.round((yy - oy + cell / 2) * sf)));
      if (n === 0) {
        minX = maxX = px;
        minY = maxY = py;
      } else {
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
      pts.push(px, py);
      n++;
    }
  }
  if (n === 0) return [];
  const rw = maxX - minX + 1;
  const rh = maxY - minY + 1;
  const data = bctx.getImageData(minX, minY, rw, rh).data;
  const colors: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const o = ((pts[2 * i + 1] - minY) * rw + (pts[2 * i] - minX)) * 4;
    colors[i] = `rgb(${data[o]},${data[o + 1]},${data[o + 2]})`;
  }
  return colors;
}

function drawMosaic(ctx: CanvasRenderingContext2D, s: Stroke, env: DrawEnv): void {
  const base = env.base;
  if (!base) return;
  const bctx = base.getContext("2d");
  if (!bctx) return;
  const ox = env.originX;
  const oy = env.originY;
  const x0 = Math.min(s.x, s.x + s.w);
  const y0 = Math.min(s.y, s.y + s.h);
  const w = Math.abs(s.w);
  const h = Math.abs(s.h);
  const cell = Math.max(6, s.lineWidth * 4);
  const key = `${x0},${y0},${w},${h},${cell},${env.scale}`;
  let entry = mosaicCache.get(s);
  if (!entry || entry.key !== key) {
    entry = { key, colors: sampleMosaicColors(bctx, base, x0, y0, w, h, cell, ox, oy, env.scale) };
    mosaicCache.set(s, entry);
  }
  const colors = entry.colors;
  let i = 0;
  for (let yy = y0; yy < y0 + h; yy += cell) {
    for (let xx = x0; xx < x0 + w; xx += cell, i++) {
      ctx.fillStyle = colors[i] ?? "#000";
      ctx.fillRect(xx, yy, cell, cell);
    }
  }
}

const blurCache = new WeakMap<
  Stroke,
  { key: string; canvas: HTMLCanvasElement; px0: number; py0: number }
>();

export function blurRadius(lineWidth: number): number {
  return Math.max(6, lineWidth * 2);
}

export function blurBrushWidth(lineWidth: number): number {
  return Math.max(28, lineWidth * 12);
}

function drawBlur(ctx: CanvasRenderingContext2D, s: Stroke, env: DrawEnv): void {
  const base = env.base;
  if (!base) return;
  const pts = s.points ?? [];
  if (pts.length < 1) return;
  const sf = env.scale;
  const r = blurRadius(s.lineWidth);
  const brush = blurBrushWidth(s.lineWidth);
  const key = `${s.x},${s.y},${s.lineWidth},${r},${sf}|${pts.map((p) => `${p.x},${p.y}`).join(";")}`;
  let entry = blurCache.get(s);
  if (!entry || entry.key !== key) {
    const rendered = renderBlurPatch(base, s, pts, r, brush, sf, env.originX, env.originY);
    entry = { key, canvas: rendered.canvas, px0: rendered.px0, py0: rendered.py0 };
    blurCache.set(s, entry);
  }
  // ctx 此时处于 scale+translate 变换中；裁片是物理像素，先复位变换再按设备像素原点 1:1 贴。
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(entry.canvas, entry.px0, entry.py0);
  ctx.restore();
}

function renderBlurPatch(
  base: HTMLCanvasElement,
  s: Stroke,
  pts: Array<{ x: number; y: number }>,
  r: number,
  brush: number,
  sf: number,
  ox: number,
  oy: number
): { canvas: HTMLCanvasElement; px0: number; py0: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const pad = brush / 2 + r;
  const relX = s.x + minX - pad - ox;
  const relY = s.y + minY - pad - oy;
  const wCss = maxX - minX + pad * 2;
  const hCss = maxY - minY + pad * 2;
  const px0 = Math.max(0, Math.floor(relX * sf));
  const py0 = Math.max(0, Math.floor(relY * sf));
  const pw = Math.max(1, Math.min(base.width - px0, Math.ceil(wCss * sf)));
  const ph = Math.max(1, Math.min(base.height - py0, Math.ceil(hCss * sf)));

  const out = document.createElement("canvas");
  out.width = pw;
  out.height = ph;
  const octx = out.getContext("2d");
  if (!octx) return { canvas: out, px0, py0 };

  const canFilter = typeof octx.filter === "string";
  if (canFilter) {
    octx.filter = `blur(${(r * sf).toFixed(2)}px)`;
    const ex = Math.round(r * sf);
    const sx0 = Math.max(0, px0 - ex);
    const sy0 = Math.max(0, py0 - ex);
    const ex1 = Math.min(base.width, px0 + pw + ex);
    const ey1 = Math.min(base.height, py0 + ph + ex);
    octx.drawImage(base, sx0, sy0, ex1 - sx0, ey1 - sy0, sx0 - px0, sy0 - py0, ex1 - sx0, ey1 - sy0);
    octx.filter = "none";
  } else {
    const k = Math.max(2, Math.round((r * sf) / 2));
    const tmp = document.createElement("canvas");
    tmp.width = Math.max(1, Math.round(pw / k));
    tmp.height = Math.max(1, Math.round(ph / k));
    const tctx = tmp.getContext("2d");
    if (tctx) {
      tctx.imageSmoothingEnabled = true;
      tctx.drawImage(base, px0, py0, pw, ph, 0, 0, tmp.width, tmp.height);
      octx.imageSmoothingEnabled = true;
      octx.drawImage(tmp, 0, 0, tmp.width, tmp.height, 0, 0, pw, ph);
    } else {
      octx.drawImage(base, px0, py0, pw, ph, 0, 0, pw, ph);
    }
  }

  const mask = document.createElement("canvas");
  mask.width = pw;
  mask.height = ph;
  const mctx = mask.getContext("2d");
  if (!mctx) return { canvas: out, px0, py0 };
  mctx.strokeStyle = "#fff";
  mctx.fillStyle = "#fff";
  mctx.lineWidth = Math.max(1, brush * sf);
  mctx.lineCap = "round";
  mctx.lineJoin = "round";
  const mx = (i: number) => (s.x + pts[i].x - ox) * sf - px0;
  const my = (i: number) => (s.y + pts[i].y - oy) * sf - py0;
  if (pts.length === 1) {
    mctx.beginPath();
    mctx.arc(mx(0), my(0), Math.max(1, (brush * sf) / 2), 0, Math.PI * 2);
    mctx.fill();
  } else {
    mctx.beginPath();
    mctx.moveTo(mx(0), my(0));
    for (let i = 1; i < pts.length; i++) mctx.lineTo(mx(i), my(i));
    mctx.stroke();
  }
  octx.globalCompositeOperation = "destination-in";
  octx.drawImage(mask, 0, 0);
  octx.globalCompositeOperation = "source-over";
  return { canvas: out, px0, py0 };
}
