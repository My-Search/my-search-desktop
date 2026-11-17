<script setup lang="ts">
/**
 * 截图框选/标注遮罩（overlay 窗口）。
 *
 * 结构（整屏铺满，十字光标）：
 *   ├─ <img> 冻结底图（本屏那一块抓屏）
 *   ├─ .ov-dim 半透明暗角（clip-path 挖洞露出选区）
 *   ├─ .ov-sel 选区高亮框 + 尺寸徽标
 *   └─ 编辑态：选区画布（标注）+ 悬浮工具条
 *
 * 多屏：每屏一个 overlay 窗口。只有鼠标松开的「那一屏」进入编辑态；
 * 编辑屏确认/取消后由宿主统一关所有窗口。
 *
 * 标注底图：进入编辑态时用 `screenshot_selection_image` 取「选区在整屏帧里
 * 的精确裁片」铺满选区画布（1:1 物理像素，清晰不糊），用户在上面画标注。
 */
import { ref, reactive, computed, onMounted, onBeforeUnmount, nextTick } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  initOverlay,
  beginSelect,
  updateSelect,
  endSelect,
  commitSelection,
  selectionImage,
  beginStroke,
  updateStroke,
  endStroke,
  commitText,
  beginEditText,
  closeTextInput,
  textFontSize,
  pickStroke,
  pickTextStroke,
  selectStroke,
  beginStrokeMove,
  updateStrokeMove,
  endStrokeMove,
  beginStrokeResize,
  updateStrokeResize,
  endStrokeResize,
  strokeBounds,
  drawStroke,
  beginSelEdit,
  updateSelEdit,
  endSelEdit,
  isEditingSel,
  undo,
  redo,
  setTool,
  setColor,
  setLineWidth,
  deleteSelectedStroke,
  cancelCapture,
  mutableState,
  type ResizeCorner,
  type Stroke,
  type Tool,
} from "./useOverlay.ts";
import MarkerToolbar from "../../components/MarkerToolbar.vue";

const st = mutableState();

/* ---------------- DOM ---------------- */
const selCanvasRef = ref<HTMLCanvasElement | null>(null);
/** 标注底图（选区的精确裁片，离屏 canvas，马赛克取样/合成用） */
const baseCanvasRef = ref<HTMLCanvasElement | null>(null);

/** 选区的精确裁片（物理像素尺寸 = 选区画布尺寸） */
const crop = reactive({ dataUrl: "", width: 0, height: 0 });

/* ---------------- 主题 ---------------- */
const theme = ref<"dark" | "light">("dark");
async function resolveTheme(): Promise<void> {
  try {
    const { readThemeOverride } = await import("../../lib/theme-override");
    const o = readThemeOverride();
    if (o === "dark" || o === "light") {
      theme.value = o;
      return;
    }
  } catch {
    /* 浏览器调试 */
  }
  try {
    theme.value = window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
  } catch {
    theme.value = "dark";
  }
}

/* ---------------- 尺寸/缩放 ---------------- */
const view = reactive({ w: 0, h: 0, scale: 1 });
async function measure(): Promise<void> {
  view.w = window.innerWidth;
  view.h = window.innerHeight;
  try {
    view.scale = (await getCurrentWindow().scaleFactor()) || 1;
  } catch {
    view.scale = 1;
  }
}

/* ---------------- 选区计算属性 ---------------- */
const selStyle = computed(() => {
  const s = st.sel;
  if (!s) return { display: "none" };
  const x = Math.min(s.x, s.x + s.w);
  const y = Math.min(s.y, s.y + s.h);
  const w = Math.abs(s.w);
  const h = Math.abs(s.h);
  return {
    left: x + "px",
    top: y + "px",
    width: w + "px",
    height: h + "px",
    display: w > 0 && h > 0 ? "block" : "none",
  };
});

const sizeBadge = computed(() => {
  const s = st.sel;
  if (!s) return "";
  return `${Math.round(Math.abs(s.w) * view.scale)} × ${Math.round(Math.abs(s.h) * view.scale)} px`;
});

/** 暗角挖洞：四块多边形盖住选区外的全部区域 */
const dimClip = computed(() => {
  const s = st.sel;
  if (!s || st.active) return "none";
  const x = Math.min(s.x, s.x + s.w);
  const y = Math.min(s.y, s.y + s.h);
  const r = Math.max(s.x, s.x + s.w);
  const b = Math.max(s.y, s.y + s.h);
  return [
    `polygon(0 0, 100% 0, 100% ${y}px, 0 ${y}px)`,
    `polygon(0 ${b}px, 100% ${b}px, 100% 100%, 0 100%)`,
    `polygon(0 ${y}px, ${x}px ${y}px, ${x}px ${b}px, 0 ${b}px)`,
    `polygon(${r}px ${y}px, 100% ${y}px, 100% ${b}px, ${r}px ${b}px)`,
  ].join(", ");
});

/* ---------------- 框选 ---------------- */
let mouseDown = false;
function onMouseDown(e: MouseEvent): void {
  if (pickMouseDown()) return; // 采集中=确认复制，只剩提示=收起；都吞掉，别误开一次新框选
  if (st.active) return;
  mouseDown = true;
  beginSelect(e.clientX, e.clientY);
}
function onMouseMove(e: MouseEvent): void {
  if (!mouseDown || st.active) return;
  updateSelect(e.clientX, e.clientY);
}
async function onMouseUp(e: MouseEvent): Promise<void> {
  if (st.active || !mouseDown) return;
  mouseDown = false;
  const sel = endSelect();
  if (!sel) return;
  const committed = await commitSelection();
  if (committed) {
    crop.dataUrl = committed.dataUrl;
    crop.width = committed.width;
    crop.height = committed.height;
    await nextTick();
    // 本地帧先立刻铺上（首次进编辑态不等第二次 IPC），宿主精确裁片随后无缝替换
    renderLiveBase();
    drawStrokes();
    const selImg = await selectionImage();
    setupSelCanvas(selImg ?? committed);
  }
}

/* ---------------- 选区画布 + 标注 ---------------- */
function setupSelCanvas(base: { dataUrl: string; width: number; height: number }): void {
  const c = selCanvasRef.value;
  if (!c) return;
  // 画布物理像素尺寸 = 裁片尺寸（清晰）；CSS 显示为选区大小
  c.width = Math.max(1, base.width);
  c.height = Math.max(1, base.height);
  drawBaseToCanvas(base.dataUrl);
  drawStrokes();
}

/**
 * 调整选区范围后，把标注底图重取到新范围。
 *
 * 松手瞬间先用**本地整屏帧**裁一版（零 IPC、逐像素与宿主一致，见 renderLiveBase），
 * 用户不会感到任何等待；宿主的精确裁片随后到达再覆盖——两条路径同样的裁剪算法，
 * 像素相同，覆盖无闪烁。
 */
async function refreshSelectionBase(): Promise<void> {
  const s = st.sel;
  if (!s) return;
  renderLiveBase();
  drawStrokes();
  const committed = await commitSelection();
  if (!committed) return;
  crop.dataUrl = committed.dataUrl;
  crop.width = committed.width;
  crop.height = committed.height;
  const selImg = await selectionImage();
  await nextTick();
  setupSelCanvas(selImg ?? committed);
  drawStrokes();
}

async function drawBaseToCanvas(dataUrl: string): Promise<void> {
  const img = new Image();
  await new Promise<void>((resolve) => {
    img.onload = () => resolve();
    img.onerror = () => resolve();
    img.src = dataUrl;
  });
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext("2d")?.drawImage(img, 0, 0);
  baseCanvasRef.value = c;
  drawStrokes();
}

/* ---------------- 改范围时的实时裁剪 ---------------- */
/**
 * 本屏**整屏冻结帧**的本地解码副本。
 * initOverlay 拿到底图后立刻 preload——用户框完选开始拖之前通常已解码完。
 */
let frameImg: HTMLImageElement | null = null;
function preloadFrame(): void {
  if (!st.baseImage || frameImg) return;
  const img = new Image();
  img.src = st.baseImage;
  frameImg = img;
}

/** 实时裁剪用的离屏画布（复用，避免每次 move 都新建对象） */
let liveBaseCanvas: HTMLCanvasElement | null = null;

/**
 * 拖把手 / 移动选区时，**直接从本地整屏帧裁出当前范围**铺进标注画布。
 *
 * 为什么必须实时重裁：不裁的话画布还是旧范围的旧裁片，被 CSS 拉伸到新框里——
 * 画面被拽变形（用户反馈「改变范围时图片拉伸、看不到真实框中效果」），松手
 * 经宿主重取才「跳」成真图。本地帧解码后裁剪是纯 drawImage，每帧零 IPC、零编码，
 * 拖到哪就看到哪。
 *
 * 坐标换算与宿主 `screenshot_crop` 逐边一致：CSS × scale → 物理像素，每条边独立
 * round、钳在帧内——松手后宿主重取的裁片与这里逐像素相同，切换无闪烁。
 */
function renderLiveBase(): void {
  const s = st.sel;
  const img = frameImg;
  if (!s || !img || !img.complete || !img.naturalWidth) return;
  const sf = view.scale;
  const x0 = Math.min(s.x, s.x + s.w);
  const y0 = Math.min(s.y, s.y + s.h);
  const x1 = Math.max(s.x, s.x + s.w);
  const y1 = Math.max(s.y, s.y + s.h);
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const sx0 = Math.max(0, Math.min(W, Math.round(x0 * sf)));
  const sy0 = Math.max(0, Math.min(H, Math.round(y0 * sf)));
  const sx1 = Math.max(sx0, Math.min(W, Math.round(x1 * sf)));
  const sy1 = Math.max(sy0, Math.min(H, Math.round(y1 * sf)));
  const sw = Math.max(1, sx1 - sx0);
  const sh = Math.max(1, sy1 - sy0);

  if (!liveBaseCanvas) liveBaseCanvas = document.createElement("canvas");
  const base = liveBaseCanvas;
  // 赋尺寸本身会清空画布：尺寸没变时别赋值——拖动整个选区时宽高不变，
  // 白清白重画纯属浪费（每次全屏帧 drawImage 都要重来一遍）。
  if (base.width !== sw) base.width = sw;
  if (base.height !== sh) base.height = sh;
  const bctx = base.getContext("2d");
  if (!bctx) return;
  bctx.imageSmoothingEnabled = false; // 整数坐标 1:1 拷贝，禁掉插值保锐利
  bctx.drawImage(img, sx0, sy0, sw, sh, 0, 0, sw, sh);
  baseCanvasRef.value = base;

  // 可见画布的物理尺寸也要跟着新范围走，否则底图画上去会被裁掉/留白，
  // 再经 CSS 拉伸又回到「变形」老路。
  const c = selCanvasRef.value;
  if (c && (c.width !== sw || c.height !== sh)) {
    c.width = sw;
    c.height = sh;
  }
}

function drawStrokes(): void {
  const c = selCanvasRef.value;
  if (!c) return;
  const ctx = c.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, c.width, c.height);
  // 先把底图（选区裁片）画上
  if (baseCanvasRef.value) ctx.drawImage(baseCanvasRef.value, 0, 0);
  // 再叠加标注（CSS 像素坐标 → 画布物理像素：乘 scale）
  ctx.save();
  ctx.scale(view.scale, view.scale);
  const s = st.sel;
  const ox = s ? Math.min(s.x, s.x + s.w) : 0;
  const oy = s ? Math.min(s.y, s.y + s.h) : 0;
  ctx.translate(-ox, -oy);
  // 编辑中的原文字**不画**：输入框里就是它的内容（beginEditText 预填原文），
  // 画布上仍画着会与输入框叠出重影（用户反馈：编辑时原来贴上的还在）。
  // hiddenTextId 由 beginEditText 置位、closeTextInput（提交/取消）复位。
  const hiddenTextId = st.hiddenTextId;
  // 绘制引擎在 src/lib/annotation.ts（与贴图窗口共用同一份渲染逻辑）
  const env = { scale: view.scale, originX: ox, originY: oy, base: baseCanvasRef.value };
  for (const stroke of st.strokes) {
    if (hiddenTextId != null && stroke.id === hiddenTextId) continue;
    drawStroke(ctx, stroke, env);
  }
  // 正在画的那一笔也画上：拖动过程中就能看到，而不是松手才出现。
  // 它用的是同一个 drawStroke，所以「拖动时看到的」与「松手后的」必然一致。
  if (st.activeStroke) drawStroke(ctx, st.activeStroke, env);
  ctx.restore();
}

/* ---------------- 标注交互 ---------------- */

let drawing = false;
/** 本次按下是否在「移动已有标注」（决定 mouseup 时走哪条收尾逻辑） */
let movingStroke = false;
/** 本次按下是否在「缩放已有标注」（拖包围盒控制点） */
let resizingStroke = false;

/**
 * 编辑态下按下选区：**唯一的 mousedown 入口**，按当前工具分流。
 *
 *   - 工具是「选择」→ 命中已有标注就拖它；否则拖的是**整个选区**（同时取消选中，
 *     所以「点一下空白」自然就是取消选中）；
 *   - 其它工具 → 开始画一笔。
 *
 * 注意必须只有一个入口：先前把「移动选区」单独绑到另一个 handler 上，结果工具
 * 不是「选择」时那次 mousedown 谁也没接（画不出任何东西）——测试立刻抓到了。
 *
 * 文字标注的新交互（用户需求）：**单击拖动移位、双击才编辑**。
 *   - 文字工具下点在已有文字上 → 不再直接开编辑框，而是选中并开始拖动；
 *     真正的编辑入口收敛为「双击文字」与「✎T 按钮」（见 onCanvasDblClick）。
 *   - 命中判断用 pickTextStroke（文字优先于框线），与双击编辑同一条规则。
 */
function selMouseDown(e: MouseEvent): void {
  if (!st.active) return;
  if (pickMouseDown()) return; // 第一下是「确认取色」或「收提示」，第二下才开始画/拖
  // 文字输入框还开着就先落笔（「点别处即写入」）——必须在这里、且在下面的
  // 新建笔之前做：mousedown 早于 blur，若等 blur 才提交，这次点击会先开一个
  // 空输入框、随后 blur 又把那个新输入框关掉。
  if (st.showTextInput) onCommitText();
  if (st.tool === "select") {
    const hit = pickStroke(e.clientX, e.clientY);
    if (hit) {
      selectStroke(hit.id);
      movingStroke = beginStrokeMove(hit.id, e.clientX, e.clientY);
      drawStrokes();
      return;
    }
    // 空白处：取消选中。靠近边缘（把手光标提示区）按下 → 按那个方向缩放，
    // 否则拖动整个选区。把手元素本身的按下由 handleMouseDown 拦下，这里兜住
    // 「离边缘很近但没点中把手方块」的情况——否则那次按下会什么也不发生。
    selectStroke(null);
    const nearDir = handleAt(e.clientX, e.clientY);
    beginSelEdit(
      nearDir ? { mode: "resize", dir: nearDir } : { mode: "move" },
      e.clientX,
      e.clientY
    );
    drawStrokes();
    return;
  }
  if (st.tool === "text") {
    // 文字工具点在**已有文字**上 → 拖动移位（不是编辑）。空白处才开新输入框。
    // 命中用 pickTextStroke（文字优先）：文字被矩形框住时，点框内文字拖的是字
    // 而不是被框的包围盒抢走（与双击编辑同一条规则）。
    const textHit = pickTextStroke(e.clientX, e.clientY);
    if (textHit) {
      movingStroke = beginStrokeMove(textHit.id, e.clientX, e.clientY);
      if (movingStroke) {
        drawStrokes();
        return;
      }
    }
  }
  drawing = true;
  beginStroke(e.clientX, e.clientY);
  drawStrokes();
}

/**
 * window 级统一 mousemove / mouseup：编辑态的所有拖拽都在这里分派。
 *
 * 为什么必须收口到 window——选区把手、标注画布是各自独立的元素，按住拖着
 * 指针迟早移出它们，挂在元素上的 handler 一移出就断（拖范围冻结、在外面松手
 * 收不了尾）。先前 `.ov-sel` / `.ov-handle` 上的 `@mousemove.stop` 还会把事件
 * 拦在半路：拖把手时指针一进入选区内部，window 上的调整逻辑就再也收不到 move。
 * 按优先级分派（三种拖拽互斥，由各自的 mousedown 置位）：
 *   拖已有标注 > 画新笔 > 调整选区范围 > 光标提示。
 */
function onWinMouseMove(e: MouseEvent): void {
  lastMouse.x = e.clientX;
  lastMouse.y = e.clientY;
  if (picking) {
    updatePickAtCursor(); // 采集态：芯片跟着光标走，实时取样
    return;
  }
  if (resizingStroke) {
    if (updateStrokeResize(e.clientX, e.clientY)) drawStrokes();
    return;
  }
  if (movingStroke) {
    if (updateStrokeMove(e.clientX, e.clientY)) drawStrokes();
    return;
  }
  if (drawing) {
    updateStroke(e.clientX, e.clientY);
    drawStrokes();
    return;
  }
  if (isEditingSel()) {
    if (updateSelEdit(e.clientX, e.clientY)) {
      // 每帧按新范围从本地整屏帧重裁底图：拖到哪就看到框里的真实画面，
      // 不是把旧裁片拉伸变形（那正是「改变范围时图片拉伸」的来源）。
      // 合并到 rAF：鼠标 move 一秒钟可达上千次，逐事件跑「重裁 + 全量重绘」
      // 是「改范围卡顿」的另一主因——每帧最多跑一次，视觉上完全等价。
      scheduleLiveRender();
    }
    return;
  }
  updateSelCursor(e);
}

/* ---------------- 标注交互 ---------------- */

/**
 * 调整选区的渲染合并到每帧一次。
 * 鼠标 move 事件远多于屏幕刷新率；拖动期间所有事件都只排一个 rAF，
 * 帧回调里用「当时的最新选区」渲染一次——高频拖动不再逐事件全量重绘。
 */
let liveRenderRaf = 0;
function scheduleLiveRender(): void {
  if (liveRenderRaf) return;
  liveRenderRaf = requestAnimationFrame(() => {
    liveRenderRaf = 0;
    if (!isEditingSel()) return; // 拖动已结束：mouseup 的收尾渲染负责
    renderLiveBase();
    drawStrokes();
  });
}
function cancelLiveRender(): void {
  if (liveRenderRaf) {
    cancelAnimationFrame(liveRenderRaf);
    liveRenderRaf = 0;
  }
}

function onWinMouseUp(): void {
  if (resizingStroke) {
    resizingStroke = false;
    endStrokeResize(); // 真的变过才补一个撤销点
    drawStrokes();
    return;
  }
  if (movingStroke) {
    movingStroke = false;
    endStrokeMove(); // 真的挪动过才补一个撤销点
    drawStrokes();
    return;
  }
  if (drawing) {
    drawing = false;
    endStroke();
    drawStrokes();
    return;
  }
  if (isEditingSel()) {
    cancelLiveRender(); // 拖动结束：丢掉挂起的合并渲染，由下面的收尾统一画
    const changed = endSelEdit();
    if (changed) {
      // 范围变了：重取裁片 + 重建画布（旧标注按窗口坐标跟着走，不丢）
      void refreshSelectionBase();
    } else {
      // 没改范围也可能有亚像素移动被规整过，补一帧让画面与选区对齐
      renderLiveBase();
      drawStrokes();
    }
  }
  // 没有任何拖拽进行中：框选的收尾由 .ov-root 的 onMouseUp 负责（它先于本
  // handler 执行并把 mouseDown 置回 false），这里不重复处理。
}

/* ---------------- 调整选区范围 ---------------- */

/** 八向把手（四角 + 四边），用绝对定位摆在选区边缘上 */
const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;

/** 按窗口坐标命中哪个把手（用于显示对应光标） */
function handleAt(x: number, y: number): (typeof HANDLES)[number] | null {
  const s = st.sel;
  if (!s) return null;
  const x0 = Math.min(s.x, s.x + s.w);
  const y0 = Math.min(s.y, s.y + s.h);
  const x1 = x0 + Math.abs(s.w);
  const y1 = y0 + Math.abs(s.h);
  const r = 10; // 把手的命中半径（比视觉尺寸大，好点）
  const nearL = Math.abs(x - x0) <= r;
  const nearR = Math.abs(x - x1) <= r;
  const nearT = Math.abs(y - y0) <= r;
  const nearB = Math.abs(y - y1) <= r;
  const inX = x >= x0 - r && x <= x1 + r;
  const inY = y >= y0 - r && y <= y1 + r;
  if (!inX || !inY) return null;
  if (nearL && nearT) return "nw";
  if (nearR && nearT) return "ne";
  if (nearL && nearB) return "sw";
  if (nearR && nearB) return "se";
  if (nearL) return "w";
  if (nearR) return "e";
  if (nearT) return "n";
  if (nearB) return "s";
  return null;
}

/** 把手方向 → CSS 光标 */
function handleCursor(dir: (typeof HANDLES)[number]): string {
  switch (dir) {
    case "nw":
    case "se":
      return "nwse-resize";
    case "ne":
    case "sw":
      return "nesw-resize";
    case "n":
    case "s":
      return "ns-resize";
    default:
      return "ew-resize";
  }
}

/** 鼠标在选区边缘时的光标（未拖动时给用户「这里能拉」的提示） */
const selCursor = ref("crosshair");
function updateSelCursor(e: MouseEvent): void {
  if (!st.active) {
    selCursor.value = "crosshair";
    return;
  }
  const dir = handleAt(e.clientX, e.clientY);
  selCursor.value = dir ? handleCursor(dir) : st.tool === "select" ? "move" : "crosshair";
}

/** 按下把手 → 开始缩放 */
function handleMouseDown(e: MouseEvent, dir: (typeof HANDLES)[number]): void {
  e.stopPropagation();
  if (!st.active) return;
  if (pickMouseDown()) return; // 同上：先处理取色，别把「确认」变成一次拖拽
  if (st.showTextInput) onCommitText(); // 点把手也视为「离开输入框」→ 先落笔
  beginSelEdit({ mode: "resize", dir }, e.clientX, e.clientY);
}

/**
 * （旧版这里有个 textCanceled 布尔守卫，已删——它是真实回归的来源：
 * Esc 关掉输入框后 Vue 卸载了 <input>，随后的 blur 事件不再发生，守卫标记
 * 无人消费，残留到下一次编辑会话，把下一次的正常提交吞掉（onCommitText
 * 直接 return，hiddenTextId 都没复位，画布上原文字一直隐藏）。
 * closeTextInput 已把 showTextInput=false、draft 清空：卸载触发的那次 blur
 * 走 onCommitText 会被 `!st.showTextInput` 拦下，双保险本来就在。）
 *
 * 确认文字标注（回车或**失去焦点**）：入栈后立刻重绘。
 */
function onCommitText(): void {
  if (!st.showTextInput) return;
  commitText(st.textDraft);
  drawStrokes();
}

/** Esc 取消文字输入（不落笔）。 */
function cancelText(): void {
  // closeTextInput 复位全部文字输入状态（含 hiddenTextId）：编辑中取消时
  // 原文会原样恢复显示——必须跟着重绘一次，否则画布上还停在「已隐藏」。
  // （卸载 <input> 触发的那次 blur 由 `!st.showTextInput` 拦下，不会误提交。）
  closeTextInput();
  drawStrokes();
}

/** 选中文字标注后点「编辑文字」：重开输入框、填入原文，提交时替换该条。 */
function onEditText(): void {
  const id = st.selectedId;
  if (id == null) return;
  beginEditText(id);
  drawStrokes();
}

/** 双击画布上的文字标注 → 直接进入编辑。
 *
 * 交互约定（用户需求）：文字**单击拖动移位、双击才编辑**——单击在文字上现在
 * 是「选中并开始拖动」（selMouseDown 文字分支），编辑入口只有：
 *   1. 双击文字（本函数）；
 *   2. 选中后点工具条的「✎T」按钮。
 *
 * 命中用 pickTextStroke（文字优先）：文字被矩形框住时，双击框内文字应编辑文字
 * 而不是被矩形的包围盒抢走（与单击拖动同一条规则）。
 */
function onCanvasDblClick(e: MouseEvent): void {
  if (!st.active) return;
  if (st.showTextInput) return; // 输入框开着时双击属于输入框内部交互，别抢
  const hit = pickTextStroke(e.clientX, e.clientY);
  if (hit) {
    beginEditText(hit.id);
    drawStrokes();
  }
}

/* ---------------- 完成 / 取消 ---------------- */
const busy = ref(false);
/** 保存失败时的提示（在工具条上方飘一条；成功/取消不留痕） */
const saveError = ref("");

/**
 * 插件截图目录（系统「另存为」对话框的起始目录）。
 *
 * 目录由宿主拼（`plugin_host::plugin_data_dir`），这里只问一次、之后复用；
 * 读写失败就返回空串，让宿主自己去兜底，不要因为「问不到目录」把保存整条路堵死。
 */
let shotsDirCache: string | null = null;
async function selectShotDir(): Promise<string> {
  if (shotsDirCache !== null) return shotsDirCache;
  try {
    shotsDirCache = await invoke<string>("screenshot_shots_dir", {
      pluginId: "com.zhuangjie.screenshot",
    });
  } catch {
    shotsDirCache = "";
  }
  return shotsDirCache;
}

/** 选区画布已经包含「底图 + 标注」（drawStrokes 每次重绘都先画底图），直接导出。 */
function composePng(): string | null {
  const c = selCanvasRef.value;
  if (!c || !crop.dataUrl) return null;
  return c.toDataURL("image/png");
}

/** 复制到剪贴板。 */
async function doCopy(): Promise<void> {
  const png = composePng();
  if (!png || busy.value) return;
  busy.value = true;
  try {
    await invoke("screenshot_copy_image", { dataUrl: png });
    await invoke("screenshot_close_overlay");
  } finally {
    busy.value = false;
  }
}

/**
 * 保存：弹系统「另存为」对话框，让用户**自己选目录和文件名**。
 *
 * 为什么不是直接落插件私有目录：那个目录用户根本找不到（在 `app_data` 深处），
 * 「保存」理应是用户能去的地方——这一点和其他截图工具一致。
 *
 * 但画廊（查看最近 7 天截图）是靠插件私有目录喂的，所以：落盘成功后，若用户
 * **恰好存进了本插件的截图目录**，就原样收进画廊并广播刷新；存到别处则只落盘、
 * 不打扰画廊（否则画廊会列出一堆其实在用户桌面上的文件，删除按钮也会误删）。
 *
 * 取消对话框 = 什么都不做，遮罩保持打开让用户接着编辑（别把「取消保存」当成
 * 「取消截图」，那是 Esc 的事）。
 *
 * 对话框必须在最前：遮罩窗口是 `always_on_top` 的，所以弹对话框前要把遮罩
 * 临时降下来（`setAlwaysOnTop(false)`），对话框关闭后再恢复。否则对话框会被
 * 遮罩挡住，用户看不见。
 */
async function doSave(): Promise<void> {
  const png = composePng();
  if (!png || busy.value) return;
  busy.value = true;
  try {
    // 起始目录：截图插件私有目录（若在调试/测试环境下拿不到就不传，宿主自己兜底）
    let shotsDir: string | null = null;
    try {
      shotsDir = await selectShotDir();
    } catch {
      shotsDir = null;
    }

    // 临时取消 always_on_top，让系统对话框能显示在最前
    const win = getCurrentWindow();
    await win.setAlwaysOnTop(false);

    let savedPath: string | null = null;
    try {
      savedPath = await invoke<string | null>("screenshot_save_shot_as", {
        pluginId: "com.zhuangjie.screenshot",
        dataUrl: png,
        parentDir: shotsDir,
      });
    } catch (e) {
      saveError.value = `保存失败：${String((e as Error)?.message ?? e)}`;
      // 恢复 always_on_top，即使保存失败
      await win.setAlwaysOnTop(true);
      return;
    }

    // 对话框关闭后恢复 always_on_top
    await win.setAlwaysOnTop(true);

    if (!savedPath) return; // 用户取消：留在遮罩里继续编辑
    await addToGallery(png, savedPath);
    await invoke("screenshot_close_overlay");
  } finally {
    busy.value = false;
  }
}

/** 落盘路径是否就在插件截图目录里（是 → 值得同时收进画廊）。 */
function isInShotsDir(dir: string, filePath: string): boolean {
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
  return norm(filePath).toLowerCase().startsWith(norm(dir).toLowerCase() + "/");
}

/**
 * 若刚保存的位置在插件截图目录内，把同一张图**再登记一份**进画廊。
 *
 * `screenshot_save_shot` 不接受调用方传路径（文件名由宿主生成，从根上杜绝
 * 目录穿越），所以这里不是「移动/改名」，而是把同一份字节在截图目录里再写一张：
 * 用户选的文件名原样保留在用户自己选的位置，画廊里那张是它自己的副本。
 * 两份都在，符合「我刚保存的东西，在画廊里也能看到」的直觉。
 */
async function addToGallery(png: string, savedPath: string): Promise<void> {
  try {
    const dir = await selectShotDir();
    if (!isInShotsDir(dir, savedPath)) return;
    await invoke("screenshot_save_shot", {
      pluginId: "com.zhuangjie.screenshot",
      dataUrl: png,
    });
    await invoke("screenshot_notify_saved", {
      pluginId: "com.zhuangjie.screenshot",
      relPath: null,
    });
  } catch {
    /* 收录失败不影响「已经保存成功」这件事，不打扰用户 */
  }
}

async function doCancel(): Promise<void> {
  await cancelCapture();
}

/* ---------------- 取色（按 C） ---------------- */
/**
 * 取色芯片的显示状态（show=false 时整体隐藏）。
 * copied=true：按下鼠标确认复制后，芯片转成「已复制」提示态（短暂显示）。
 */
const pickChip = reactive({ show: false, x: 0, y: 0, hex: "", rgb: "", copied: false });
/** 采集中：按 C 之后、按下鼠标确认之前——芯片跟随光标实时取样，尚未复制 */
let picking = false;
/** 「已复制」提示的自动收起计时器 */
let pickHintTimer = 0;
/** 最近一次鼠标位置（窗口坐标）：按 C 时在这里取样 */
const lastMouse = { x: -1, y: -1 };
/** 取样用的 1×1 离屏画布（复用，避免每次取样分配对象） */
const pickCanvas = document.createElement("canvas");
pickCanvas.width = 1;
pickCanvas.height = 1;
pickCanvas.getContext("2d")!.imageSmoothingEnabled = false;

/**
 * 取窗口坐标 (cssX, cssY) 处冻结帧的像素色值。
 *
 * 优先从**整屏帧**取（CSS × scale → 物理坐标，钳在帧内）；帧还没解码完就
 * 退化到选区底图（同样换算后减掉选区原点）。两路都没有时返回 null。
 */
function sampleColorAt(cssX: number, cssY: number): { hex: string; rgb: string } | null {
  const sf = view.scale;
  const px = Math.round(cssX * sf);
  const py = Math.round(cssY * sf);
  const ctx = pickCanvas.getContext("2d");
  if (!ctx) return null;
  const img = frameImg;
  if (img && img.complete && img.naturalWidth) {
    const x = Math.min(img.naturalWidth - 1, Math.max(0, px));
    const y = Math.min(img.naturalHeight - 1, Math.max(0, py));
    ctx.drawImage(img, x, y, 1, 1, 0, 0, 1, 1);
  } else {
    const base = baseCanvasRef.value;
    const sel = st.sel;
    if (!base || !sel) return null;
    const sx0 = Math.round(Math.min(sel.x, sel.x + sel.w) * sf);
    const sy0 = Math.round(Math.min(sel.y, sel.y + sel.h) * sf);
    const bx = px - sx0;
    const by = py - sy0;
    if (bx < 0 || by < 0 || bx >= base.width || by >= base.height) return null;
    ctx.drawImage(base, bx, by, 1, 1, 0, 0, 1, 1);
  }
  const d = ctx.getImageData(0, 0, 1, 1).data;
  if (d[3] === 0) return null; // 透明处没有颜色可言
  const r = d[0];
  const g = d[1];
  const b = d[2];
  const hex = "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
  return { hex, rgb: `rgb(${r}, ${g}, ${b})` };
}

/** 在光标处取样并把芯片摆到光标旁（只采集显示，不复制——复制在按下鼠标确认时发生）。 */
function updatePickAtCursor(): boolean {
  const mx = lastMouse.x >= 0 ? lastMouse.x : Math.round(view.w / 2);
  const my = lastMouse.y >= 0 ? lastMouse.y : Math.round(view.h / 2);
  const c = sampleColorAt(mx, my);
  if (c) {
    pickChip.hex = c.hex;
    pickChip.rgb = c.rgb;
  }
  // 芯片摆在光标右下；贴边翻到左上，别跑出屏幕
  const pad = 14;
  const w = 200;
  const h = 36;
  let x = mx + pad;
  let y = my + pad;
  if (x + w > view.w) x = mx - pad - w;
  if (y + h > view.h) y = my - pad - h;
  pickChip.x = Math.max(0, x);
  pickChip.y = Math.max(0, y);
  pickChip.show = true;
  return !!c;
}

/** 按 C：进入采集——芯片立刻出现在光标处，之后跟随光标实时取样，此时还不会复制。 */
function startPick(): void {
  dismissPick(); // 清掉上一次的「已复制」提示与计时器
  if (!updatePickAtCursor()) dismissPick(); // 帧没解码出来取不到色：不进采集态
  else picking = true;
}

/**
 * 采集期间按下鼠标 = 确认：HEX 写进剪贴板，芯片转成「已复制」提示后自动收起。
 * 失败不打断提示（芯片照常显示），但要留痕：Windows 剪贴板偶发被占用。
 */
function confirmPick(): void {
  picking = false;
  pickChip.copied = true;
  void invoke("screenshot_copy_text", { text: pickChip.hex }).catch((err) => {
    console.warn("取色复制 HEX 失败：", err);
  });
  if (pickHintTimer) clearTimeout(pickHintTimer);
  pickHintTimer = window.setTimeout(() => {
    pickHintTimer = 0;
    pickChip.show = false;
    pickChip.copied = false;
  }, 1200);
}

function dismissPick(): void {
  picking = false;
  if (pickHintTimer) {
    clearTimeout(pickHintTimer);
    pickHintTimer = 0;
  }
  pickChip.show = false;
  pickChip.copied = false;
}

/**
 * 取色期间的按下统一走这里：采集中 → 复制并收起；只剩「已复制」提示 → 直接收起。
 * 返回 true = 这次按下被取色吃掉，调用方别再开始框选/画笔/拖把手。
 */
function pickMouseDown(): boolean {
  if (!pickChip.show) return false;
  if (picking) confirmPick();
  else dismissPick();
  return true;
}

/* ---------------- 键盘 ---------------- */
function onKeyDown(e: KeyboardEvent): void {
  // 正在输入文字时，键盘交给输入框（否则 Delete 会删掉选中的标注）
  if (st.showTextInput) return;
  if (e.key === "Escape") {
    e.preventDefault();
    // 取色芯片先收起——一次 Esc 只做一件事，别连带关掉整个截图
    if (pickChip.show) {
      dismissPick();
      return;
    }
    // 有选中标注时先取消选中（比直接关掉整个截图更符合直觉）
    if (st.selectedId != null) {
      selectStroke(null);
      drawStrokes();
      return;
    }
    void doCancel();
  } else if ((e.key === "c" || e.key === "C") && !e.ctrlKey && !e.metaKey && !e.altKey) {
    // 按 C 进入取色采集（芯片跟随光标实时取样）；Ctrl+C 等组合键留给复制，不拦。
    // 复制发生在随后的鼠标按下（确认），见 confirmPick。
    e.preventDefault();
    startPick();
  } else if (e.key === "Delete" || e.key === "Backspace") {
    // 删掉选中的标注
    if (st.selectedId != null) {
      e.preventDefault();
      deleteSelectedStroke();
      drawStrokes();
    }
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
    drawStrokes();
  }
}

/* ---------------- 生命周期 ---------------- */
onMounted(async () => {
  await resolveTheme();
  await measure();
  await initOverlay();
  preloadFrame(); // 提前解码整屏帧：拖把手时的实时裁剪才不会等图片解码
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", measure);
  // 编辑态的一切拖拽（画笔/挪标注/调范围）都收口在 window：指针移出选区
  // 甚至拖到窗口边缘外也要继续跟随、松手也要能收尾——挂在元素上会「拖出去就断」。
  window.addEventListener("mousemove", onWinMouseMove);
  window.addEventListener("mouseup", onWinMouseUp);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("resize", measure);
  window.removeEventListener("mousemove", onWinMouseMove);
  window.removeEventListener("mouseup", onWinMouseUp);
});

/* ---------------- 工具配置 ---------------- */
/**
 * 工具条改为共享组件 MarkerToolbar.vue（截图与贴图同一套 UI，用户需求：
 * 贴图显示工具栏应跟截图时一样）。TOOLS/COLORS 与回调经 props/emit 传入，
 * 这里只保留「切工具前先提交文字」的截图特有收尾。
 */
const TOOLS = [
  { id: "select", icon: "➤", label: "选择" },
  { id: "rect", icon: "▭", label: "矩形" },
  { id: "ellipse", icon: "◯", label: "椭圆" },
  { id: "arrow", icon: "➜", label: "箭头" },
  { id: "pen", icon: "✎", label: "画笔" },
  { id: "text", icon: "T", label: "文字" },
  { id: "mosaic", icon: "▩", label: "马赛克" },
  { id: "blur", icon: "◍", label: "模糊" },
] as const;
const COLORS = ["#ff5555", "#ffaa00", "#33cc55", "#3399ff", "#ffffff", "#000000"];

/**
 * 切工具前先把还没提交的文字写入：用户「文字输一半去点别的工具」时，
 * 按「失去焦点即写入」的语义应当保留这段文字，而不是默默丢掉。
 */
function onPickTool(id: (typeof TOOLS)[number]["id"]): void {
  if (st.showTextInput && st.tool === "text") onCommitText();
  setTool(id);
  drawStrokes();
}

/** 工具条回调：改色可能作用在已选中的那一笔上，必须立刻重绘 */
function onPickColor(c: string): void {
  setColor(c);
  drawStrokes();
}

/** 工具条回调：撤销 / 重做后立刻重绘 */
function onUndo(): void {
  undo();
  drawStrokes();
}
function onRedo(): void {
  redo();
  drawStrokes();
}

/** 调粗 / 调细当前（或下一笔）线宽；文字笔会同步字号 */
function bumpLineWidth(delta: number): void {
  setLineWidth(st.lineWidth + delta);
  drawStrokes();
}

/**
 * 当前选中标注的包围盒（窗口坐标）—— 高亮框用。
 *
 * 用 computed 而不是缓存：拖动/撤销都会改 strokes，computed 天然跟着重算，
 * 不会出现「框还停在旧位置」的错位。
 */
const selectedBounds = computed(() => {
  const id = st.selectedId;
  if (id == null) return null;
  const s = st.strokes.find((it) => it.id === id);
  return s ? strokeBounds(s) : null;
});

/** 选中的是不是文字标注（决定工具栏要不要出现「编辑文字」） */
const selectedIsText = computed(() => {
  const id = st.selectedId;
  if (id == null) return false;
  const s = st.strokes.find((it) => it.id === id);
  return s?.kind === "text";
});

/* ---------------- 选中标注的包围盒控制点（拖它缩放/改字号） ---------------- */

/**
 * 四个角的控制点位置。
 *
 * 与「选区八向把手」是两码事：那套改的是截图范围，这套改的是**选中的那一笔**。
 * 所以用独立的 class（.ov-astub），只有选中标注时才渲染。
 */
const A_CORNERS = ["nw", "ne", "se", "sw"] as const;

function astubStyle(corner: ResizeCorner): Record<string, string> {
  const b = selectedBounds.value;
  if (!b) return { display: "none" };
  // strokeBounds 已把宽高规整为正，所以右下角就是 (x+w, y+h)。
  const map: Record<ResizeCorner, [number, number]> = {
    nw: [b.x, b.y],
    ne: [b.x + b.w, b.y],
    se: [b.x + b.w, b.y + b.h],
    sw: [b.x, b.y + b.h],
  };
  const [px, py] = map[corner];
  return { left: px + "px", top: py + "px" };
}

/** 按下控制点 → 开始缩放选中的那一笔 */
function astubMouseDown(e: MouseEvent, corner: ResizeCorner): void {
  e.stopPropagation();
  if (!st.active) return;
  if (pickMouseDown()) return;
  if (st.showTextInput) onCommitText(); // 同上：点控制点也先落笔
  const id = st.selectedId;
  if (id == null) return;
  if (beginStrokeResize(id, corner, e.clientX, e.clientY)) {
    resizingStroke = true;
  }
}

/** 把手在窗口里的位置（贴选区边缘；选区可能是负宽高，先规整） */
function handleStyle(dir: (typeof HANDLES)[number]): Record<string, string> {
  const s = st.sel;
  if (!s) return { display: "none" };
  const x0 = Math.min(s.x, s.x + s.w);
  const y0 = Math.min(s.y, s.y + s.h);
  const x1 = x0 + Math.abs(s.w);
  const y1 = y0 + Math.abs(s.h);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const map: Record<(typeof HANDLES)[number], [number, number]> = {
    nw: [x0, y0],
    n: [cx, y0],
    ne: [x1, y0],
    e: [x1, cy],
    se: [x1, y1],
    s: [cx, y1],
    sw: [x0, y1],
    w: [x0, cy],
  };
  const [px, py] = map[dir];
  return {
    left: px + "px",
    top: py + "px",
    cursor: handleCursor(dir),
  };
}
</script>

<template>
  <div
    class="ov-root"
    :class="theme === 'dark' ? 'ov-dark' : 'ov-light'"
    :style="{ cursor: st.active ? selCursor : 'crosshair' }"
    @mousedown="onMouseDown"
    @mousemove="onMouseMove"
    @mouseup="onMouseUp"
  >
    <img v-if="st.baseImage && !st.error" class="ov-base" :src="st.baseImage" alt="" draggable="false" />
    <div v-if="!st.active && !st.error" class="ov-dim" :style="{ clipPath: dimClip }" />

    <div v-if="st.error" class="ov-msg ov-error">
      <p>{{ st.error }}</p>
      <button class="ov-btn" @click.stop="doCancel">关闭（Esc）</button>
    </div>
    <div v-else-if="!st.ready" class="ov-msg">正在截取屏幕…</div>

    <div v-if="st.sel && !st.active" class="ov-sel" :style="selStyle">
      <span class="ov-size">{{ sizeBadge }}</span>
    </div>

    <template v-if="st.active && st.sel">
      <!--
        编辑态选区：mousedown 在此起步（画新笔 / 选中挪动 / 拖空白移选区），
        move/up 一律交给 window 级的统一处理器——它们不能加 .stop，否则指针一
        移出这块元素，拖拽就断了（把手调整尤其明显：按住把手往里拖，指针立刻
        进入选区内部，move 被拦在元素上，window 收不到 → 完全拉不动）。
      -->
      <div
        class="ov-sel ov-active"
        :style="selStyle"
        @mousedown.stop="selMouseDown"
        @dblclick="onCanvasDblClick"
      >
        <canvas ref="selCanvasRef" class="ov-canvas"></canvas>
      </div>

      <!--
        选中标注的高亮框：用 **DOM** 画而不是画进 canvas —— 它是纯粹的编辑提示，
        一旦画进 canvas 就会出现在导出的图里（用户要的是「干净」的截图）。
        框住的范围用 strokeBounds 现算，随拖动实时更新。
      -->
      <div
        v-if="selectedBounds"
        class="ov-picked"
        :style="{
          left: selectedBounds.x + 'px',
          top: selectedBounds.y + 'px',
          width: Math.max(2, selectedBounds.w) + 'px',
          height: Math.max(2, selectedBounds.h) + 'px',
        }"
      ></div>

      <!--
        选中标注的**四角控制点**：拖它改这一笔的几何（缩放 / 改端点 / 改字号）。
        与选区八向把手是两码事——那套改截图范围，这套改选中的那一笔，
        所以用独立 class 且只有选中标注时才渲染。
      -->
      <div
        v-for="c in A_CORNERS"
        :key="'astub-' + c"
        class="ov-astub"
        :class="'ov-astub-' + c"
        :style="astubStyle(c)"
        @mousedown="astubMouseDown($event, c)"
      ></div>

      <!--
        八向把手：拖它们改选区范围（同样用 DOM，不进导出图）。
        用绝对定位摆在选区边缘，配合 selCursor 给出「这里能拉」的光标提示。
        move/up 同样交给 window：按住把手后指针几乎立刻移出把手这 10px 的小方块，
        在把手元素上拦 move 会让调整在起步时就僵住。
      -->
      <!-- 把手在任何工具下都可拖：标注到一半随时改范围，不必先切回「选择」 -->
      <div
        v-for="dir in HANDLES"
        :key="dir"
        class="ov-handle"
        :class="'ov-handle-' + dir"
        :style="handleStyle(dir)"
        @mousedown="handleMouseDown($event, dir)"
      ></div>

      <div class="ov-tip" :style="{ left: st.sel.x + 'px', top: st.sel.y + st.sel.h + 6 + 'px' }">
        拖标注移动 · 拖边缘改范围 · 双击文字编辑 ·「复制」或「保存」（保存会弹出另存为对话框）
      </div>

      <!--
        文字输入框：贴在被点击的位置（st.textPos），字号与最终画上去的字号一致
        （textFontSize）——所输即所见，避免「框在这、字画到那儿」。
      -->
      <div
        v-if="st.showTextInput && st.textPos"
        class="ov-textbox"
        :style="{
          left: st.textPos.x + 'px',
          top: st.textPos.y + 'px',
          '--ov-text-size': textFontSize(st.lineWidth) + 'px',
          color: st.color,
        }"
      >
        <input
          v-model="st.textDraft"
          class="ov-text-input"
          placeholder="输入文字，回车或点别处确认"
          autofocus
          @keydown.enter.prevent="onCommitText()"
          @keydown.esc.prevent="cancelText()"
          @blur="onCommitText()"
          @mousedown.stop
        />
      </div>

      <MarkerToolbar
        :tools="TOOLS"
        :colors="COLORS"
        :tool="st.tool"
        :color="st.color"
        :line-width="st.lineWidth"
        :show-text-edit="selectedIsText"
        :can-undo="st.undoStack.length > 0"
        :can-redo="st.redoStack.length > 0"
        @pick-tool="onPickTool"
        @pick-color="onPickColor"
        @bump-line-width="bumpLineWidth"
        @edit-text="onEditText"
        @undo="onUndo"
        @redo="onRedo"
      >
        <!--
          确认区：三个按钮 + 保存失败提示（截图特有，经 actions 插槽拼进同一条工具栏）。
          `.ov-actions`（nowrap + 不收缩）单独成组，保证「复制/保存/取消」三个按钮
          **永远在同一行**——工具条本身允许换行（窄屏时工具区先折行），但这三个
          是「拍板」动作，折行会让「取消」跑到下一行、和「保存」贴不到一起，
          很容易点错。
        -->
        <template #actions>
          <span class="ov-sep"></span>
          <div class="ov-actions">
            <!-- 保存失败（如目标目录被删、磁盘只读）在按钮正上方飘一条，不挤动布局 -->
            <div v-if="saveError" class="ov-save-err" :title="saveError">{{ saveError }}</div>
            <button class="ov-btn primary" :disabled="busy" @click="doCopy">复制</button>
            <button class="ov-btn" :disabled="busy" title="另存为…（选择保存位置）" @click="doSave">保存</button>
            <button class="ov-btn danger" @click="doCancel">取消 (Esc)</button>
          </div>
        </template>
      </MarkerToolbar>
    </template>

    <!--
      取色芯片（按 C）：按下 C 进入采集，芯片跟随光标实时显示 HEX/RGB；
      按下鼠标确认 → HEX 进剪贴板，芯片变「已复制」提示后自动收起。
      pointer-events:none——它只是显示层，不能挡住下面的画布交互；
      按下事件由各个 mousedown 入口统一处理（吞掉那一次按下）。
    -->
    <div
      v-if="pickChip.show"
      class="ov-pick"
      :style="{ left: pickChip.x + 'px', top: pickChip.y + 'px' }"
    >
      <i class="ov-pick-sw" :style="{ background: pickChip.hex }"></i>
      <b class="ov-pick-hex">{{ pickChip.hex }}</b>
      <span class="ov-pick-rgb">{{ pickChip.rgb }}</span>
      <span v-if="pickChip.copied" class="ov-pick-ok">已复制</span>
    </div>
  </div>
</template>

<style scoped>
.ov-root {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  cursor: crosshair;
  overflow: hidden;
  font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
}
.ov-base {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: fill;
  user-select: none;
  -webkit-user-drag: none;
}
.ov-dim {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  pointer-events: none;
}
.ov-sel {
  position: absolute;
  border: 1.5px solid #4da3ff;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.3);
  pointer-events: none;
  z-index: 5;
}
.ov-sel.ov-active {
  pointer-events: auto;
  border-style: dashed;
  cursor: crosshair;
}
.ov-size {
  position: absolute;
  top: -26px;
  left: 0;
  background: #1f2329;
  color: #fff;
  font-size: 12px;
  padding: 2px 6px;
  border-radius: 3px;
  white-space: nowrap;
}
/*
 * 取色芯片（按 C）：色块 + HEX + RGB，确认复制后追加「已复制」提示。
 * 固定深色底，不随明暗主题变——它要如实呈现取到的颜色，自己不能被主题色带偏。
 * pointer-events:none：不参与命中测试，按下确认/收起交给 mousedown 入口。
 */
.ov-pick {
  position: fixed;
  z-index: 40;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 8px;
  background: rgba(28, 28, 30, 0.94);
  border: 1px solid rgba(255, 255, 255, 0.16);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  color: #f2f2f2;
  font-size: 12px;
  font-family: ui-monospace, Consolas, monospace;
  white-space: nowrap;
  pointer-events: none;
}
.ov-pick-sw {
  width: 16px;
  height: 16px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.35);
  box-sizing: border-box;
}
.ov-pick-hex {
  font-weight: 600;
  letter-spacing: 0.02em;
}
.ov-pick-rgb {
  opacity: 0.72;
}
/* 「已复制」提示：确认复制后短暂高亮，绿色一眼可辨 */
.ov-pick-ok {
  color: #3ddc84;
  font-weight: 600;
}
.ov-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
/*
 * 选中标注的高亮框：虚线 + 四角小方块，纯编辑提示（DOM，不进导出图）。
 * pointer-events:none —— 点它应该落到下面的画布上（用来拖动/取消选中），
 * 而不是被这层挡住。
 */
.ov-picked {
  position: absolute;
  border: 1px dashed #4da3ff;
  background: rgba(77, 163, 255, 0.08);
  pointer-events: none;
  z-index: 6;
}
/*
 * 选区把手：拖它改范围。做成「中心点定位」（margin 抵消一半宽高），
 * 这样 JS 里只算边缘坐标即可，不必关心把手自身尺寸。
 */
.ov-handle {
  position: absolute;
  width: 10px;
  height: 10px;
  margin: -5px 0 0 -5px;
  border-radius: 2px;
  background: #fff;
  border: 1.5px solid #4da3ff;
  box-shadow: 0 0 3px rgba(0, 0, 0, 0.5);
  z-index: 8;
}
/* 边中点的把手做成小长条，视觉上区分「改一边」与「改两角」 */
.ov-handle-n,
.ov-handle-s {
  width: 18px;
  margin-left: -9px;
  border-radius: 3px;
}
.ov-handle-e,
.ov-handle-w {
  height: 18px;
  margin-top: -9px;
  border-radius: 3px;
}
.ov-tip {
  position: absolute;
  bottom: -24px;
  left: 0;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.8);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
  white-space: nowrap;
  pointer-events: none;
}
.ov-msg {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: #fff;
  font-size: 15px;
  background: rgba(0, 0, 0, 0.6);
  padding: 14px 22px;
  border-radius: 8px;
  text-align: center;
}
.ov-error {
  color: #ff8080;
}
.ov-error p {
  margin: 0 0 10px;
}
/* 分隔线：actions 插槽里的这条在宿主作用域渲染，样式归 App.vue（组件内另有一份同款） */
.ov-sep {
  width: 1px;
  height: 20px;
  background: rgba(255, 255, 255, 0.15);
  margin: 0 4px;
  flex: none;
}
/*
 * 确认区（复制 / 保存 / 取消）：整组不许换行、不许收缩。
 * 它经 actions 插槽拼进共享工具条（MarkerToolbar），自己不再定位；
 * `flex: none` 让它在工具条（可换行）里作为一个整体参与折行，
 * `white-space: nowrap` 兜住「文字比按钮宽」的极端情况——不然窄屏上
 * 「取消 (Esc)」会折成两行，看起来像坏掉了。
 */
.ov-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  white-space: nowrap;
  position: relative;
}
/* 保存失败提示：贴在按钮正上方，绝对定位以免把按钮顶走 */
.ov-save-err {
  position: absolute;
  bottom: calc(100% + 6px);
  right: 0;
  max-width: 320px;
  padding: 6px 10px;
  border-radius: 6px;
  background: rgba(120, 24, 24, 0.92);
  border: 1px solid rgba(255, 80, 80, 0.45);
  color: #ffd9d9;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
}
.ov-btn {
  /* 按钮文字永不换行（「取消 (Esc)」「复制」都得是一行） */
  white-space: nowrap;
  flex: none;
  padding: 6px 14px;
  border: none;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
  font-size: 13px;
  cursor: pointer;
}
.ov-btn:hover {
  background: rgba(255, 255, 255, 0.2);
}
.ov-btn.primary {
  background: #4da3ff;
}
.ov-btn.primary:hover {
  background: #3b8fe0;
}
.ov-btn.danger {
  background: rgba(255, 80, 80, 0.25);
}
.ov-btn.danger:hover {
  background: rgba(255, 80, 80, 0.4);
}
.ov-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.ov-textbox {
  position: absolute;
  z-index: 20;
  /*
   * 把输入框往左上挪「内边距 + 边框」那么多：这样**输入框里的第一个字**正好落在
   * 用户点击的位置，与落笔后 ctx.fillText 画出的文字起点重合。
   * 偏移量由下面那对变量算出来，改 padding 时不会忘掉这处补偿。
   */
  margin-left: calc(-1 * (var(--ov-text-pad-x) + 1px));
  margin-top: calc(-1 * (var(--ov-text-pad-y) + 1px));
}
.ov-text-input {
  --ov-text-pad-x: 4px;
  --ov-text-pad-y: 2px;
  /*
   * 背景**透明**：输入框只是临时脚手架，用户要看到底图本身（输入的文字
   * 以所选颜色直接压在图上）。用极细的浅色描边 + 一圈深色阴影保证在浅底/深底
   * 上都看得出输入范围，但都不遮挡底图内容。
   */
  background: transparent;
  border: 1px dashed rgba(255, 255, 255, 0.75);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.55);
  color: inherit;
  font-family: sans-serif;
  font-size: var(--ov-text-size, 16px);
  line-height: 1;
  padding: var(--ov-text-pad-y) var(--ov-text-pad-x);
  border-radius: 3px;
  outline: none;
  min-width: 200px;
  text-shadow: 0 0 2px rgba(0, 0, 0, 0.65);
}
/* 输入框里的占位提示也给点阴影，浅底上也看得清 */
.ov-text-input::placeholder {
  color: rgba(255, 255, 255, 0.55);
}
/*
 * 选中标注的四角控制点：拖它缩放 / 改端点 / 改字号。
 * 白底蓝框、中心点定位（margin 抵消一半宽高），与选区把手同款视觉但独立 class
 * —— 它改的是「选中的那一笔」，不是截图范围。
 */
.ov-astub {
  position: absolute;
  width: 10px;
  height: 10px;
  margin: -5px 0 0 -5px;
  border-radius: 50%;
  background: #fff;
  border: 1.5px solid #4da3ff;
  box-shadow: 0 0 3px rgba(0, 0, 0, 0.5);
  z-index: 9;
  cursor: nwse-resize;
}
.ov-astub-ne,
.ov-astub-sw {
  cursor: nesw-resize;
}
</style>
