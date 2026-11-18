<script setup lang="ts">
/**
 * 贴图窗口（pin 窗口）：把剪贴板里的图片钉在屏幕上的无边框置顶小窗。
 *
 * 结构（整窗 = 那张图）：
 *   ├─ <canvas> 图片 + 标注（画布像素 = 图片自然像素，CSS 铺满窗口 → 1:1 清晰）
 *   ├─ 编辑态：**共享工具栏 MarkerToolbar.vue**（与截图遮罩完全同一套：
 *   │          选择/矩形/椭圆/箭头/画笔/文字/马赛克/模糊 + 六色 + 粗细 ± +
 *   │          编辑文字 + 撤销/重做；动作条=取消/完成）
 *   ├─ 浏览态：**按住拖动 = 移动贴图窗口**；右键菜单（显示编辑工具 / 复制 / 关闭）
 *   └─ 文字工具的浮动输入框（含再编辑：单击文字=拖动移位，双击文字=编辑）
 *
 * 标注引擎：`src/lib/annotation.ts`（截图遮罩同源）——工具/颜色/线宽/撤销/选中/
 * 移动/缩放/文字再编辑全部复用，保证「贴图的工具栏跟截图一样」不是像，是同一份代码。
 *
 * 交互契约（与 Rust `pin_image.rs` 对齐）：
 *   - 双击（浏览态）→ `pin_close` 关闭；
 *   - 右键（浏览态）→ 菜单；菜单「关闭」→ `pin_close`，「复制」→ 当前画布
 *     （含标注）合成 PNG 走 `screenshot_copy_image`；
 *   - 浏览态拖动 → `startDragging()` 由系统移动整窗（编辑态拖动=画标注，不抢）；
 *   - 窗口透明：马赛克/模糊之外，浏览器态整窗就是图本身。
 *
 * 多实例：每个贴图窗口都是本组件的一个实例，靠 `getCurrentWindow().label`
 * 向宿主 `pin_image_data` 索取自己那张图（label 形如 `pin-<ms>-<seq>`）。
 */
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import {
  COLORS,
  TOOLS,
  mutableState,
  setTool,
  setColor,
  setLineWidth,
  beginStroke,
  updateStroke,
  endStroke,
  commitText,
  closeTextInput,
  beginEditText,
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
  undo as engineUndo,
  redo as engineRedo,
  deleteSelectedStroke,
  type ResizeCorner,
} from "../../lib/annotation.ts";
import MarkerToolbar from "../../components/MarkerToolbar.vue";

/* ---------------- 状态 ---------------- */

const canvasEl = ref<HTMLCanvasElement | null>(null);
const textEl = ref<HTMLInputElement | null>(null);

/** 宿主侧注册表的 label（onMounted 里从窗口元数据读出） */
let label = "";
/** 已加载的贴图 */
let imgEl: HTMLImageElement | null = null;
/** 图片是否已铺上画布（加载失败时给错误提示） */
const ready = ref(false);
const error = ref("");

/** 画布 CSS 尺寸（= 窗口客户区尺寸，onMounted 读出后恒定）：编辑扩窗几何以它为准 */
const cssSize = ref({ w: 0, h: 0 });
/** 窗口环境（编辑扩窗 / 边框开关要用；每次操作前重新解析最新值，拖动后不过期） */
const winMetrics = { frame: false, dpr: 1 };

/** 浏览态 / 编辑态 */
const mode = ref<"view" | "edit">("view");

/**
 * 编辑态为工具条扩出的高度（CSS 像素）：进入编辑时窗口多出这一条放工具条。
 * 图片本身在屏幕上的位置/尺寸完全不动。
 */
const EDIT_HUD = 48;

/**
 * 工具条放在哪：下方有空间 → 向下扩；下方不够但上方够 → 向上扩（窗口上移，
 * 图片不动）；上下都不够（截图几乎占满屏幕）→ 工具条悬浮在图片底部内侧。
 */
type EditPlacement = "down" | "up" | "overlay";
const editPlacement = ref<EditPlacement>("down");

/** 图片在窗口内的上偏移：向上扩窗时 = EDIT_HUD（窗口上移了同样距离），否则 0 */
const imgTop = ref(0);
/** 工具条左偏移（相对窗口）：默认相对图片居中，工具条比图片宽时贴左缘 */
const toolbarLeft = ref(0);
/** 工具条 top（相对窗口）：下方/悬浮模式在图片下沿，向上扩窗时在图片上沿之外 */
const toolbarTop = ref(0);

/** 悬浮条是否可见（编辑态常显；完成编辑后短暂停留 1.2s 再淡出） */
const hudVisible = ref(false);
/** 悬浮条首帧瞬移标记（避免从屏幕顶滑下来的入场动画） */
const hudSnap = ref(false);

/** 边框是否显示（默认无边框 + 细描边投影；右键菜单「隐藏边框 / 显示边框」切换） */
const frameVisible = ref(true);

/** 标注引擎状态（截图遮罩同源的那一份接口） */
const st = mutableState();

/** 右键菜单（浏览态） */
const menu = ref({ visible: false, x: 0, y: 0 });
/** 复制成功的短提示 */
const toast = ref("");

/** 指针事件坐标 → 引擎坐标（CSS 像素，相对画布左上角，夹在画布内）。
 * 引擎约定：笔画存 CSS 像素，宿主渲染时自己 ctx.scale（与截图遮罩一致）。 */
function toEngine(e: MouseEvent): { x: number; y: number } {
  const c = canvasEl.value as HTMLCanvasElement;
  const r = c.getBoundingClientRect();
  const x = Math.max(0, Math.min(r.width, e.clientX - r.left));
  const y = Math.max(0, Math.min(r.height, e.clientY - r.top));
  return { x, y };
}

/** 画布 CSS 尺寸 → 引擎包围盒换算（选中框/控制点显示用） */
function cssScale(): number {
  const c = canvasEl.value;
  if (!c) return 1;
  const r = c.getBoundingClientRect();
  return r.width > 0 ? r.width / c.width : 1;
}

/** 全量重绘：底图 + 已完成标注 + 正在拖画的笔画（引擎渲染，与截图同一份）。
 * 引擎约定：笔画是 CSS 像素，宿主先 ctx.scale(env.scale) 再画（截图遮罩同款）。 */
function drawAll() {
  const c = canvasEl.value;
  if (!c || !imgEl) return;
  const ctx = c.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.drawImage(imgEl, 0, 0);
  const hiddenTextId = st.hiddenTextId;
  // env.scale = CSS → 画布物理像素（= c.width / CSS 宽）；马赛克/模糊采样 base=纯底图
  const env = { scale: 1 / cssScale(), originX: 0, originY: 0, base: imgCanvas() };
  ctx.save();
  ctx.scale(env.scale, env.scale);
  for (const s of st.strokes) {
    if (hiddenTextId != null && s.id === hiddenTextId) continue;
    drawStroke(ctx, s, env);
  }
  if (st.activeStroke) drawStroke(ctx, st.activeStroke, env);
  ctx.restore();
}

/**
 * 马赛克/模糊采样用的「纯底图」离屏画布（不含标注），懒建一次。
 * 引擎的 DrawEnv.base 需要物理像素底图；贴图的底图就是那张 PNG 本身。
 */
let baseCv: HTMLCanvasElement | null = null;
function imgCanvas(): HTMLCanvasElement | null {
  if (!imgEl) return null;
  if (!baseCv) {
    baseCv = document.createElement("canvas");
    baseCv.width = imgEl.naturalWidth;
    baseCv.height = imgEl.naturalHeight;
    baseCv.getContext("2d")?.drawImage(imgEl, 0, 0);
  }
  return baseCv;
}

/* ---------------- 编辑态进出 ---------------- */

/**
 * 选展开方向：优先向下（不动窗口坐标）；贴图贴近屏幕底部就向上；上下都放不下
 *（截图几乎占满屏幕）则悬浮在图片底部。用显示器**工作区**，避开任务栏/ Dock。
 */
async function chooseEditPlacement(): Promise<EditPlacement> {
  try {
    const win = getCurrentWindow();
    const [scale, pos, mon] = await Promise.all([
      win.scaleFactor(),
      win.outerPosition(),
      currentMonitor(),
    ]);
    if (!mon) return "down";
    const need = Math.round(EDIT_HUD * scale);
    const bottom = pos.y + Math.round(cssSize.value.h * scale);
    const wa = mon.workArea;
    const roomBelow = wa.position.y + wa.size.height - bottom;
    const roomAbove = pos.y - wa.position.y;
    if (roomBelow >= need) return "down";
    if (roomAbove >= need) return "up";
    return "overlay";
  } catch {
    return "down";
  }
}

/** 按当前 placement 摆好图片与工具条（进入编辑前先算，避免工具条先出现在错误方向） */
function layoutEditChrome() {
  const imgH = cssSize.value.h;
  if (editPlacement.value === "up") {
    imgTop.value = EDIT_HUD;
    toolbarTop.value = 4;
    return;
  }
  imgTop.value = 0;
  if (editPlacement.value === "overlay") {
    // 悬浮模式：工具条贴图片底部内侧；高度要等渲染后才能量准，先用 44 兜底
    const tb = document.querySelector(".pin-toolbar") as HTMLElement | null;
    const th = tb ? tb.getBoundingClientRect().height : 44;
    toolbarTop.value = Math.max(4, imgH - th - 4);
    return;
  }
  toolbarTop.value = imgH + 4;
}

/** 菜单：显示编辑工具（进入编辑态；激活引擎 + 落到「选择」工具） */
async function startEdit() {
  menu.value.visible = false;
  st.active = true;
  setTool("select");
  editBaseIds = st.strokes.map((s) => s.id);
  // 先定扩窗方向与工具条位置，再渲染工具条：避免先出现在错误方向的闪烁
  editPlacement.value = await chooseEditPlacement();
  layoutEditChrome();
  mode.value = "edit";
  hudVisible.value = true;
  drawAll();
  // 等工具条渲染后再扩窗：要量它的自然宽度决定窗口是否横向扩宽
  await nextTick();
  void applyEditGeometry(true);
}

/** 工具条「完成」：保留标注，退出编辑态（引擎回到非激活） */
function finishEdit() {
  if (st.showTextInput) commitText(st.textDraft);
  st.activeStroke = null;
  selectStroke(null);
  st.active = false;
  mode.value = "view";
  hudVisible.value = false;
  drawAll();
  void applyEditGeometry(false);
}

/**
 * 工具条「取消」/ Esc：回滚本次编辑会话新增的笔画，退出编辑态。
 * 引擎没有「会话基线」概念，这里在进入编辑时记下当时的笔画 id（editBaseIds），
 * 取消时按 id 过滤删掉之后新增的（比按数量截断稳：撤销/重做不动 id）。
 */
let editBaseIds: number[] = [];
function cancelEdit() {
  if (st.showTextInput) closeTextInput();
  st.activeStroke = null;
  const keep = new Set(editBaseIds);
  st.strokes = st.strokes.filter((s) => keep.has(s.id));
  st.undoStack = [];
  st.redoStack = [];
  selectStroke(null);
  st.active = false;
  mode.value = "view";
  hudVisible.value = false;
  drawAll();
  void applyEditGeometry(false);
}

/* ---------------- 交互 ---------------- */

/** 浏览态右键 → 打开菜单（编辑态不弹：退出编辑走工具条 / Esc） */
function onContextMenu(e: MouseEvent) {
  if (mode.value === "edit" || st.showTextInput) return;
  const mw = 150;
  const mh = 148;
  menu.value.x = Math.max(0, Math.min(e.clientX, window.innerWidth - mw - 4));
  menu.value.y = Math.max(0, Math.min(e.clientY, window.innerHeight - mh - 4));
  menu.value.visible = true;
}

/** 点击菜单/工具条之外的任意处 → 收菜单 */
function onRootMouseDown() {
  if (menu.value.visible) menu.value.visible = false;
}

/** 双击（浏览态）→ 关闭贴图；编辑态双击文字 → 编辑该文字（新交互约定） */
function onDblClick(e: MouseEvent) {
  if (mode.value === "view") {
    if (!st.showTextInput) closePin();
    return;
  }
  if (st.showTextInput) return;
  const p = toEngine(e);
  const hit = pickTextStroke(p.x, p.y);
  if (hit) {
    beginEditText(hit.id);
    drawAll();
    nextTick(() => textEl.value?.focus());
  }
}

/** 双击守卫变量（refreshDblClickGuard 用） */
let lastDownAt = 0;
let lastDownX = 0;
let lastDownY = 0;
/** 双击的第二次 mousedown 置 true：startWindowDrag 据此跳过（否则拖动循环吞掉 dblclick） */
let dblClickGuard = false;
/** 在 mousedown 阶段同步计算（click 在双击时根本不触发，守卫必须放这里） */
function refreshDblClickGuard(e: MouseEvent) {
  if (e.button !== 0) return;
  const now = Date.now();
  dblClickGuard =
    now - lastDownAt <= 500 &&
    Math.abs(e.clientX - lastDownX) <= 6 &&
    Math.abs(e.clientY - lastDownY) <= 6;
  lastDownAt = now;
  lastDownX = e.clientX;
  lastDownY = e.clientY;
}

/**
 * 编辑态窗口几何（使用**物理像素**，与显示器缩放无关）：
 *   - down：高度 + EDIT_HUD，工具条在图片下沿；
 *   - up：高度 + EDIT_HUD 且窗口上移 EDIT_HUD，画布下移 EDIT_HUD，图片原地不动；
 *   - overlay：窗口不动，工具条悬浮在图片底部内侧。
 * 工具栏比图片宽时再向右扩宽（图片仍贴左）。退出编辑恢复原尺寸/坐标。
 *
 * 画布宽高锁定为图片尺寸（`--pin-img-w/h`），扩出的透明区域不会拉伸图片。
 * 位置与尺寸用 `pin_set_bounds` 一次原子生效，避免先 resize 再 move 的抖动。
 */
async function applyEditGeometry(editing: boolean) {
  const win = getCurrentWindow();
  try {
    const scale = await win.scaleFactor();
    const imgW = cssSize.value.w;
    const imgH = cssSize.value.h;
    let cssW = imgW;
    if (editing) {
      // 工具条相对**图片**居中：图片够宽时居中；比工具条窄就贴图片左缘，
      // 窗口向右扩到装得下整条工具栏（多出来的是透明区，图片本身不动）。
      const tb = document.querySelector(".pin-toolbar") as HTMLElement | null;
      const tbW = tb ? tb.getBoundingClientRect().width : 0;
      toolbarLeft.value = tbW > 0 ? Math.max(0, (imgW - tbW) / 2) : 0;
      if (tbW > 0) cssW = Math.max(imgW, toolbarLeft.value + tbW + 8);
      // 悬浮模式的 top 依赖工具条实际高度，渲染后再校准一次
      if (editPlacement.value === "overlay") layoutEditChrome();
    }
    const grow = editing && editPlacement.value !== "overlay";
    const w = Math.round(cssW * scale);
    const h = Math.round((imgH + (grow ? EDIT_HUD : 0)) * scale);
    const pos = await win.outerPosition();
    const dy = Math.round(EDIT_HUD * scale);
    const y =
      pos.y +
      (editPlacement.value === "up" ? (editing ? -dy : dy) : 0);
    await invoke("pin_set_bounds", {
      label: win.label,
      x: pos.x,
      y,
      width: w,
      height: h,
    });
    if (!editing) {
      // 退出编辑：工具条已卸载，画布/边框回到窗口顶部
      imgTop.value = 0;
      toolbarLeft.value = 0;
      toolbarTop.value = 0;
      editPlacement.value = "down";
    }
  } catch (e) {
    console.error("[贴图] 编辑扩窗失败:", e);
  }
}

/**
 * 边框开关（右键菜单「隐藏边框 / 显示边框」）：切换 .pin-frame 覆盖层显隐。
 * 不调 set_decorations——窗口是无边框创建的，打开系统 decorations 会带出标题栏、
 * 破坏贴图观感；页面也没申请该权限。
 */
function toggleFrame() {
  frameVisible.value = !frameVisible.value;
}

/**
 * 浏览态按下 → 系统级拖动移窗（用户需求：贴图应可拖动位置）。
 * startDragging 把后续移动完全交给系统，直到松手；编辑态不走这里。
 */
function startWindowDrag(e: MouseEvent) {
  if (e.button !== 0) return;
  // 双击的第二次 mousedown 不再触发拖动：否则系统拖动循环会吞掉 dblclick
  //（真机问题：双击偶尔关不掉贴图）
  if (dblClickGuard) return;
  try {
    void getCurrentWindow().startDragging();
  } catch {
    /* 浏览器调试环境没有窗口 API */
  }
}

/** 浏览态画布按下：先刷新双击守卫（同步判定），再交给拖动。
 *  守卫必须挂在 startDragging **之前**——曾出现守卫函数写了却没人调用的
 *  事故（dblClickGuard 恒 false → 双击第二次按下照样进系统拖动循环 →
 *  dblclick 被吞 → 贴图双击关不掉）。 */
function onBrowseMouseDown(e: MouseEvent) {

  refreshDblClickGuard(e);

  startWindowDrag(e);
}

/** 拖动状态（编辑态）：画新笔 / 移动已有标注 / 缩放选中标注 */
let drawing = false;
let moving = false;
let resizing = false;
let resizeCorner: ResizeCorner | null = null;

/** 画布按下：编辑态才标注（文字命中=拖动移位；空白+文字工具=开输入框） */
function onCanvasDown(e: MouseEvent) {
  if (mode.value !== "edit") return;
  menu.value.visible = false;
  // 输入框开着时点画布：先把草稿落笔，再让这次点击继续生效（与截图遮罩
  // 同款）。mousedown 早于 blur，若等 blur 提交，本次点击会被直接吞掉
  // （截图侧曾出现「点别处后还得再点一下才能继续画」）。
  if (st.showTextInput) onCommitText();
  const p = toEngine(e);
  if (st.tool === "text") {
    // 单击在已有文字上 → 选中并开始拖动移位（与截图同款：拖动移位、双击编辑）
    const textHit = pickTextStroke(p.x, p.y);
    if (textHit) {
      moving = beginStrokeMove(textHit.id, p.x, p.y);
      if (moving) {
        drawAll();
        return;
      }
    }
    // 空白处 → 新文字输入框（引擎记下落点，提交时用它）
    // preventDefault：拦下 mousedown 的默认「焦点移交」——否则浏览器在事件派发
    // 完成后把焦点从刚插入并聚焦的 input 抢回 body，输入框立即 blur →
    // onCommitText 空提交 → 输入框一闪而过（真机表现为「文字标注没反应」）。
    // 画布本身无可选文本/无默认拖选行为，preventDefault 无副作用。
    e.preventDefault();
    beginStroke(p.x, p.y);
    drawAll();
    nextTick(() => textEl.value?.focus());
    return;
  }
  drawing = true;
  beginStroke(p.x, p.y);
  drawAll();
}

/** window 级 mousemove：画笔跟随 / 拖动标注（收口到 window，拖出画布也能跟随）。
 * 引擎坐标 = CSS 像素相对画布左上角（clamp 在画布内），与 toEngine 一致。 */
function onWinMouseMove(e: MouseEvent) {
  if (mode.value !== "edit") return;
  const p = toEngine(e);
  if (resizing) {
    if (updateStrokeResize(p.x, p.y)) drawAll();
    return;
  }
  if (moving) {
    if (updateStrokeMove(p.x, p.y)) drawAll();
    return;
  }
  if (drawing) {
    updateStroke(p.x, p.y);
    drawAll();
  }
}

/** window 级 mouseup：收尾（真的动过才补撤销点，引擎内部处理） */
function onWinMouseUp() {
  if (resizing) {
    resizing = false;
    resizeCorner = null;
    endStrokeResize();
    drawAll();
    return;
  }
  if (moving) {
    moving = false;
    endStrokeMove();
    drawAll();
    return;
  }
  if (drawing) {
    drawing = false;
    endStroke();
    drawAll();
  }
}

/** 选中标注的四角控制点：按下 → 开始缩放 */
function onAstubDown(e: MouseEvent, corner: ResizeCorner) {
  e.stopPropagation();
  if (mode.value !== "edit" || st.selectedId == null) return;
  if (beginStrokeResize(st.selectedId, corner, e.clientX, e.clientY)) {
    resizing = true;
    resizeCorner = corner;
  }
}

/* ---------------- 文字输入 ---------------- */

/** 提交文字（回车 / 失焦）。引擎按 editingTextId 决定「新增」还是「替换」。 */
function onCommitText() {
  if (!st.showTextInput) return;
  commitText(st.textDraft);
  drawAll();
}

/** Esc 取消文字输入（不落笔）。 */
function cancelText() {
  closeTextInput();
  drawAll();
}

/**
 * 文字输入框坐标/字号：引擎的 textPos 与字号都是 **CSS 像素**（相对于画布），
 * 输入框也活在 CSS 像素里，直接摆过去即可，不能再乘「CSS/画布物理像素」的
 * 比例（那会在非 100% 缩放下把框缩小、往左上挪，与落笔位置错开）。
 * 画布画字时才需要 ctx.scale(物理/CSS)（见 drawAll）。
 */
const textStyle = computed(() => ({
  left: `${st.textPos?.x ?? 0}px`,
  // 向上扩窗时画布整体下移 EDIT_HUD，输入框要跟着图片走
  top: `${(st.textPos?.y ?? 0) + imgTop.value}px`,
  fontSize: `${textFontSize(st.lineWidth)}px`,
  color: st.color,
}));

/* ---------------- 工具条回调（MarkerToolbar emit） ---------------- */

function onPickTool(id: (typeof TOOLS)[number]["id"]) {
  if (st.showTextInput && st.tool === "text") onCommitText();
  setTool(id);
  drawAll();
}
function onPickColor(c: string) {
  setColor(c);
  drawAll();
}
function bumpLineWidth(delta: number) {
  setLineWidth(st.lineWidth + delta);
  drawAll();
}
function onEditText() {
  if (st.selectedId == null) return;
  if (beginEditText(st.selectedId)) {
    drawAll();
    nextTick(() => textEl.value?.focus());
  }
}
function onUndo() {
  engineUndo();
  drawAll();
}
function onRedo() {
  engineRedo();
  drawAll();
}
function onDelete() {
  if (deleteSelectedStroke()) drawAll();
}

/* ---------------- 选中框显示 ---------------- */

/** 选中标注的包围盒（CSS 像素；高亮框与四角控制点用）。
 *  strokeBounds 返回的就是画布内 CSS 像素（与引擎/指针坐标同一套），
 *  DOM 覆盖层也按 CSS 像素摆，不做任何缩放；只补上画布相对窗口的偏移。 */
const selectedBox = computed(() => {
  if (mode.value !== "edit" || st.selectedId == null || st.showTextInput) return null;
  const s = st.strokes.find((it) => it.id === st.selectedId);
  if (!s) return null;
  const b = strokeBounds(s);
  // 向上扩窗时画布整体下移 EDIT_HUD，选中框/控制点跟随图片
  return { x: b.x, y: b.y + imgTop.value, w: b.w, h: b.h };
});

const A_CORNERS: ResizeCorner[] = ["nw", "ne", "se", "sw"];

function astubStyle(corner: ResizeCorner): Record<string, string> {
  const b = selectedBox.value;
  if (!b) return { display: "none" };
  const map: Record<ResizeCorner, [number, number]> = {
    nw: [b.x, b.y],
    ne: [b.x + b.w, b.y],
    se: [b.x + b.w, b.y + b.h],
    sw: [b.x, b.y + b.h],
  };
  const [px, py] = map[corner];
  return { left: `${px}px`, top: `${py}px` };
}

/* ---------------- 复制 / 关闭 ---------------- */

/** 菜单「关闭」/ 双击：让宿主关掉这张贴图 */
async function closePin() {
  try {
    await invoke("pin_close", { label });
  } catch (e) {
    console.error("[贴图] 关闭失败:", e);
  }
}

/** 菜单「复制」：把当前画布（含标注）合成 PNG 写进系统剪贴板 */
async function copyImage() {
  menu.value.visible = false;
  try {
    drawAll();
    const dataUrl = canvasEl.value?.toDataURL("image/png") ?? "";
    await invoke("screenshot_copy_image", { dataUrl });
    toast.value = "已复制";
    window.setTimeout(() => {
      toast.value = "";
    }, 900);
  } catch (e) {
    error.value = `复制失败: ${e}`;
  }
}

/** Esc：先退出文字输入，再退编辑态（浏览态先取消选中，再无操作防误关） */
function onKeydown(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  if (st.showTextInput) cancelText();
  else if (mode.value === "edit") cancelEdit();
  else if (st.selectedId != null) {
    selectStroke(null);
    drawAll();
  }
}

/** Ctrl+Z / Ctrl+Shift+Z / Delete（编辑态，输入框里不拦） */
function onEditKeys(e: KeyboardEvent) {
  if (mode.value !== "edit" || st.showTextInput) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) onRedo();
    else onUndo();
  } else if (e.key === "Delete" || e.key === "Backspace") {
    if (st.selectedId != null) {
      e.preventDefault();
      onDelete();
    }
  }
}

/** 页面卸载（Alt+F4 等异常关闭）→ 尽力清理宿主侧注册表 */
function onPageHide() {
  invoke("pin_cleanup", { label }).catch(() => {});
}

/* ---------------- 生命周期 ---------------- */

onMounted(async () => {
  label = getCurrentWindow().label;
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("keydown", onEditKeys);
  window.addEventListener("mousemove", onWinMouseMove);
  window.addEventListener("mouseup", onWinMouseUp);
  window.addEventListener("pagehide", onPageHide);
  try {
    const payload = await invoke<{ dataUrl: string; width: number; height: number }>(
      "pin_image_data",
      { label }
    );
    const image = new Image();
    image.onload = () => {
      imgEl = image;
      const c = canvasEl.value;
      if (c) {
        // 画布 = 图片自然像素（1:1），CSS 铺满窗口由样式负责
        c.width = image.naturalWidth || payload.width;
        c.height = image.naturalHeight || payload.height;
        drawAll();
        // 记下画布 CSS 尺寸（= 窗口客户区）：编辑扩窗几何以它为准
        const rect = c.getBoundingClientRect();
        cssSize.value = { w: rect.width, h: rect.height };
      }
      ready.value = true;
    };
    image.onerror = () => {
      error.value = "贴图加载失败";
    };
    image.src = payload.dataUrl;
  } catch (e) {
    error.value = `贴图不存在或已关闭：${e}`;
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("keydown", onEditKeys);
  window.removeEventListener("mousemove", onWinMouseMove);
  window.removeEventListener("mouseup", onWinMouseUp);
  window.removeEventListener("pagehide", onPageHide);
});
</script>

<template>
  <div
    class="pin-root"
    :style="cssSize.h > 0 ? {
      '--pin-img-w': cssSize.w + 'px',
      '--pin-img-h': cssSize.h + 'px',
      '--pin-img-top': imgTop + 'px',
    } : {}"
    @mousedown="onRootMouseDown"
    @dblclick="onDblClick"
    @contextmenu.prevent="onContextMenu"
  >
    <!-- 画布宽高在图片加载后锁定为图片自身 CSS 尺寸（--pin-img-w/h），不依赖扩窗时机，
         图片永不形变；加载前 cssSize=0，CSS 的 100% fallback 让画布先铺满窗口，
         否则首次 getBoundingClientRect 会读到 0 导致画布塌成 0 高。 -->
    <canvas
      ref="canvasEl"
      class="pin-canvas"
      :class="{ 'is-edit': mode === 'edit' }"
      @mousedown="mode === 'view' ? onBrowseMouseDown($event) : onCanvasDown($event)"
    ></canvas>

    <!-- 边框覆盖层：独立透明层画四边，避开 canvas outline 在窗口边缘被裁剪、
         编辑态被工具条遮住上边的问题（pointer-events:none 不影响标注交互）。
         高度同样锁定为图片尺寸，与画布严格重合。 -->
    <div v-if="frameVisible" class="pin-frame"></div>

    <!-- 选中标注：高亮框 + 四角控制点（缩放/改端点/改字号），与截图同款交互 -->
    <template v-if="mode === 'edit' && selectedBox">
      <div
        class="pin-selbox"
        :style="{ left: selectedBox.x + 'px', top: selectedBox.y + 'px', width: selectedBox.w + 'px', height: selectedBox.h + 'px' }"
      ></div>
      <div
        v-for="corner in A_CORNERS"
        :key="corner"
        class="pin-astub"
        :class="'pin-astub-' + corner"
        :style="astubStyle(corner)"
        @mousedown="onAstubDown($event, corner)"
      ></div>
    </template>

    <!--
      编辑工具条：**共享组件 MarkerToolbar**（截图遮罩同款 UI 与同款引擎）。
      浏览态不渲染，整窗右键即菜单；取消/完成经 actions 插槽拼进同一条工具栏。
    -->
    <MarkerToolbar
      v-if="mode === 'edit'"
      class="pin-toolbar"
      :style="{ top: toolbarTop + 'px', left: toolbarLeft + 'px' }"
      :tools="TOOLS"
      :colors="COLORS"
      :tool="st.tool"
      :color="st.color"
      :line-width="st.lineWidth"
      :show-text-edit="st.selectedId != null && st.strokes.find((s) => s.id === st.selectedId)?.kind === 'text'"
      :can-undo="st.undoStack.length > 0"
      :can-redo="st.redoStack.length > 0"
      @pick-tool="onPickTool"
      @pick-color="onPickColor"
      @bump-line-width="bumpLineWidth"
      @edit-text="onEditText"
      @undo="onUndo"
      @redo="onRedo"
    >
      <template #actions>
        <span class="ov-sep"></span>
        <button class="pt-action" title="取消（Esc，回滚本次编辑）" @click="cancelEdit">✕</button>
        <button class="pt-action done" title="完成" @click="finishEdit">✓</button>
      </template>
    </MarkerToolbar>

    <!-- 文字输入（贴在引擎记下的落点；编辑已有文字时预填原文）。
         单行 input 与截图遮罩同款：引擎 fillText 不渲染换行，多行输入会导致所见非所得。 -->
    <input
      v-if="st.showTextInput"
      ref="textEl"
      v-model="st.textDraft"
      class="pin-text-input"
      :style="textStyle"
      placeholder="输入文字，回车或点别处确认"
      @mousedown.stop
      @dblclick.stop
      @keydown.enter.prevent="onCommitText"
      @keydown.esc.stop.prevent="cancelText"
      @blur="onCommitText"
    >

    <!-- 右键菜单（浏览态） -->
    <div
      v-if="menu.visible"
      class="pin-menu"
      :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
      @mousedown.stop
      @dblclick.stop
    >
      <button class="pm-item" @click="startEdit">显示编辑工具</button>
      <button class="pm-item" @click="toggleFrame">{{ frameVisible ? "隐藏边框" : "显示边框" }}</button>
      <button class="pm-item" @click="copyImage">复制</button>
      <button class="pm-item danger" @click="closePin">关闭</button>
    </div>

    <!-- 复制成功提示 -->
    <div v-if="toast" class="pin-toast">{{ toast }}</div>

    <!-- 加载失败（贴图已被关闭 / 数据丢失） -->
    <div v-if="error" class="pin-error">{{ error }}</div>
  </div>
</template>

<style scoped>
.pin-root {
  position: fixed;
  inset: 0;
  overflow: hidden;
  cursor: default;
  background: transparent;
}

/* 画布：宽高由 --pin-img-w/h 锁定为图片 CSS 尺寸（外层内联 style 提供）。
 * 绝不写 height:100% / calc(100% - HUD)：编辑扩窗是异步的，依赖窗口高度的
 * 写法会让画布先被 WebView 缩短、图片被压扁（真机踩过）。 */
.pin-canvas {
  display: block;
  /* 宽高都锁定为图片 CSS 尺寸：编辑态窗口可能横向扩宽/向下扩高，
     图片本身绝不跟着拉伸变形；加载前 fallback 100% 铺满窗口 */
  position: relative;
  top: var(--pin-img-top, 0px);
  width: var(--pin-img-w, 100%);
  height: var(--pin-img-h, 100%);
  outline: none;
}
.pin-canvas.is-edit {
  cursor: crosshair;
}

/* CSS 边框（右键菜单可开关）：独立覆盖层 + inset 阴影画四边 1px 半透明白线。
 * 不用 canvas 的 outline：outline 落在窗口最外 1px，会被无边框窗口的边缘
 * 裁剪/抗锯齿吃掉某些边；编辑态还会被工具条盖住上边。覆盖层在图片之上、
 * 工具条之下，pointer-events:none 不影响标注。高度与画布同为图片尺寸。 */
.pin-frame {
  position: absolute;
  left: 0;
  top: var(--pin-img-top, 0px);
  /* 与画布严格重合：窗口横向扩宽后边框也只包住图片，不包透明区 */
  width: var(--pin-img-w, 100%);
  height: var(--pin-img-h, 100%);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.55);
  pointer-events: none;
  z-index: 5;
}

/* 选中标注：高亮框（细虚线）+ 四角控制点（白底蓝框圆点），与截图遮罩同款视觉 */
.pin-selbox {
  position: absolute;
  border: 1px dashed rgba(255, 255, 255, 0.85);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.45);
  pointer-events: none;
  z-index: 20;
}
.pin-astub {
  position: absolute;
  width: 10px;
  height: 10px;
  margin: -5px 0 0 -5px;
  border-radius: 50%;
  background: #fff;
  border: 1.5px solid #4da3ff;
  box-shadow: 0 0 3px rgba(0, 0, 0, 0.5);
  z-index: 21;
  cursor: nwse-resize;
}
.pin-astub-ne,
.pin-astub-sw {
  cursor: nesw-resize;
}

/* 编辑态工具条：top/left 由内联 style 固定为「图片下沿 + 4px」与「相对图片居中
 * （放不下则贴左缘）」，不依赖扩窗时机。覆盖组件默认 top/bottom 时**必须两边
 * 都写**：只写 top 会留下组件的 bottom:28px → top+bottom 同时生效把盒子拉满
 * 整窗（真机踩过的坑）。 */
.pin-toolbar {
  position: absolute;
  bottom: auto;
  /* 共享组件的默认定位是 left:50% + translateX(-50%)；这里改由内联 left 控制，
     必须同时清掉 transform，否则会被它再左移半个宽度 */
  transform: none;
  /* 共享组件的 max-width: calc(100vw - 24px) 会把窄贴图下的工具条量窄，
     导致窗口误判「装得下」而不扩宽；这里按内容自然宽度排布 */
  max-width: none;
  width: max-content;
  padding: 5px 8px;
  z-index: 30;
}
/* 工具条按钮/色块一律不许被窄贴图窗口压扁；no wrap + 不设 max-width，
 * 让工具条保持自然宽度（超宽时靠窗口扩宽兜底，按钮本身绝不缩水变形）。 */
.pin-toolbar :deep(.ov-tool),
.pin-toolbar :deep(.ov-color),
.pin-toolbar :deep(.ov-sep),
.pin-toolbar :deep(.ov-wval) {
  flex: none;
}
/* actions 插槽里的取消 / 完成：宿主作用域渲染，样式归本组件 */
.pt-action {
  min-width: 28px;
  height: 28px;
  border: none;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  flex: none;
}
.pt-action:hover {
  background: rgba(255, 255, 255, 0.2);
}
.pt-action.done {
  background: #34c759;
  color: #fff;
  font-weight: 600;
}
.pt-action.done:hover {
  background: #2eb551;
}
/* actions 插槽里的分隔线 */
.ov-sep {
  width: 1px;
  height: 20px;
  background: rgba(255, 255, 255, 0.15);
  margin: 0 4px;
  flex: none;
}

/* 文字输入：与截图输入框（.ov-text-input）同一套宿主样式 */
.pin-text-input {
  --pin-text-pad-x: 4px;
  --pin-text-pad-y: 2px;
  position: absolute;
  z-index: 25;
  min-width: 200px;
  max-width: 90%;
  /*
   * 把输入框往左上挪「内边距 + 边框」：输入框里的第一个字正好落在
   * 用户点击的位置，与落笔后 ctx.fillText 画出的文字起点重合（截图遮罩同款）。
   */
  margin-left: calc(-1 * (var(--pin-text-pad-x) + 1px));
  margin-top: calc(-1 * (var(--pin-text-pad-y) + 1px));
  /*
   * 背景**透明**：输入框只是临时脚手架，用户要看到贴图本身（文字最终以
   * 所选颜色直接压在图上）。细虚线描边 + 一圈深色阴影保证在浅底/深底上都
   * 看得出输入范围，但都不遮挡贴图内容。
   */
  background: transparent;
  border: 1px dashed rgba(255, 255, 255, 0.75);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.55);
  border-radius: 3px;
  color: inherit;
  font-family: sans-serif;
  /* line-height 与画布 textBaseline:"top" 对齐，行内文字位置和最终绘制一致 */
  line-height: 1;
  padding: var(--pin-text-pad-y) var(--pin-text-pad-x);
  outline: none;
  text-shadow: 0 0 2px rgba(0, 0, 0, 0.65);
}
/* 输入框里的占位提示也给点阴影，浅底上也看得清 */
.pin-text-input::placeholder {
  color: rgba(255, 255, 255, 0.55);
  text-shadow: 0 0 2px rgba(0, 0, 0, 0.65);
}

/* 右键菜单 */
.pin-menu {
  position: absolute;
  z-index: 40;
  min-width: 140px;
  padding: 4px;
  background: rgba(28, 28, 30, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 8px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
}
.pm-item {
  border: none;
  background: transparent;
  color: #eee;
  text-align: left;
  padding: 7px 12px;
  font-size: 13px;
  border-radius: 6px;
  cursor: pointer;
}
.pm-item:hover {
  background: rgba(255, 255, 255, 0.12);
}
.pm-item.danger:hover {
  background: rgba(243, 63, 63, 0.4);
}

/* 复制成功提示 */
.pin-toast {
  position: absolute;
  bottom: 10px;
  left: 50%;
  transform: translateX(-50%);
  padding: 4px 12px;
  border-radius: 12px;
  background: rgba(28, 28, 30, 0.85);
  color: #fff;
  font-size: 12px;
  z-index: 50;
  pointer-events: none;
}

/* 加载失败提示 */
.pin-error {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 16px;
  background: rgba(28, 28, 30, 0.9);
  color: #ffb4b4;
  font-size: 13px;
  z-index: 60;
  white-space: pre-wrap;
}
</style>
