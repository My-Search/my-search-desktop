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
import { getCurrentWindow, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";
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
const textEl = ref<HTMLTextAreaElement | null>(null);

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
 * 编辑态工具条悬浮条的高度（CSS 像素）：进入编辑时窗口向上扩出这一条，
 * 工具条画在扩出来的区域里，永不压住图片（Snipaste 同款交互）。
 */
const EDIT_HUD = 48;

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

/** 菜单：显示编辑工具（进入编辑态；激活引擎 + 落到「选择」工具） */
function startEdit() {
  menu.value.visible = false;
  st.active = true;
  setTool("select");
  editBaseIds = st.strokes.map((s) => s.id);
  mode.value = "edit";
  hudVisible.value = true;
  drawAll();
  // 编辑态向上扩出工具条悬浮条（先扩窗再画，避免工具条压住图片首帧）
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
 * 编辑态窗口几何：进入编辑时窗口向上扩出 EDIT_HUD（CSS 像素），工具条画在
 * 扩出来的区域里、永不压住图片（Snipaste 同款）；退出编辑恢复原窗口尺寸。
 * 扩出量按 DIP 计算（× scale 转物理像素），与显示器缩放无关。
 */
async function applyEditGeometry(editing: boolean) {
  const win = getCurrentWindow();
  try {
    const scale = await win.scaleFactor();
    const pos = await win.outerPosition();
    const w = Math.round(cssSize.value.w * scale);
    const h = Math.round((cssSize.value.h + (editing ? EDIT_HUD : 0)) * scale);
    // 不走 @tauri-apps/api 的 PhysicalSize/PhysicalPosition 类（测试 stub 环境
    // 里它们序列化出的字段 stub 不认识）；直接发裸 invoke，字段用 tauri 内部
    // 约定的 Physical{Width,Height,X,Y} 大写驼峰。
    const internals = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
    };
    await internals.__TAURI_INTERNALS__.invoke("plugin:window|set_size", {
      label: win.label,
      value: { type: "Physical", Width: w, Height: h },
    });
    await internals.__TAURI_INTERNALS__.invoke("plugin:window|set_position", {
      label: win.label,
      value: {
        type: "Physical",
        X: pos.x,
        Y: pos.y + (editing ? -1 : 1) * Math.round(EDIT_HUD * scale),
      },
    });
  } catch (e) {
    console.error("[贴图] 编辑扩窗失败:", e);
  }
}

/**
 * 边框开关（右键菜单「隐藏边框 / 显示边框」）。
 * 宿主创建窗口时把 decorations 状态写进 location hash，这里读它同步初始 UI。
 */
/**
 * 边框开关（右键菜单「隐藏边框 / 显示边框」）。
 * 纯 CSS（canvas 的 outline）：不调 set_decorations——窗口是无边框创建的，
 * 打开系统 decorations 会带出标题栏，破坏贴图观感；页面也没申请该权限。
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
  if (mode.value !== "edit" || st.showTextInput) return;
  menu.value.visible = false;
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

/** 文字输入框坐标：引擎的 textPos 是 CSS 像素（窗口坐标），textarea 直接用 */
const textStyle = computed(() => {
  const c = canvasEl.value;
  const k = c && c.width > 0 ? c.getBoundingClientRect().width / c.width : 1;
  return {
    left: `${(st.textPos?.x ?? 0) * k}px`,
    top: `${(st.textPos?.y ?? 0) * k + (mode.value === "edit" ? EDIT_HUD : 0)}px`,
    fontSize: `${textFontSize(st.lineWidth) * k}px`,
    color: st.color,
  };
});

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

/** 选中标注的包围盒（CSS 像素；高亮框与四角控制点用） */
const selectedBox = computed(() => {
  if (mode.value !== "edit" || st.selectedId == null || st.showTextInput) return null;
  const s = st.strokes.find((it) => it.id === st.selectedId);
  if (!s) return null;
  const b = strokeBounds(s);
  const k = cssScale();
  // 编辑态画布整体下移 EDIT_HUD（顶部让给工具条悬浮条），选中框随之偏移
  return { x: b.x * k, y: b.y * k + EDIT_HUD, w: b.w * k, h: b.h * k };
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
    @mousedown="onRootMouseDown"
    @dblclick="onDblClick"
    @contextmenu.prevent="onContextMenu"
  >
    <!-- 浏览态按住即拖动移窗；编辑态换成标注画布交互（见 onCanvasDown） -->
    <canvas
      ref="canvasEl"
      class="pin-canvas"
      :class="{ 'is-edit': mode === 'edit', 'is-hud-shift': mode === 'edit', 'is-framed': frameVisible }"
      @mousedown="mode === 'view' ? onBrowseMouseDown($event) : onCanvasDown($event)"
    ></canvas>

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

    <!-- 文字输入（贴在引擎记下的落点；编辑已有文字时预填原文） -->
    <textarea
      v-if="st.showTextInput"
      ref="textEl"
      v-model="st.textDraft"
      class="pin-text-input"
      :style="textStyle"
      placeholder="输入文字，回车或点别处确认"
      @mousedown.stop
      @dblclick.stop
      @keydown.enter.exact.prevent="onCommitText"
      @keydown.esc.stop="cancelText"
      @blur="onCommitText"
    ></textarea>

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

/* 画布：窗口多大铺多大；浏览器把画布像素缩放到这个框（1:1 时无缩放） */
.pin-canvas {
  display: block;
  width: 100%;
  height: 100%;
  outline: none;
}
.pin-canvas.is-edit {
  cursor: crosshair;
}
/* 编辑态：画布整体下移，顶部 EDIT_HUD 区域让给工具条悬浮条（窗口已同步扩高） */
.pin-canvas.is-hud-shift {
  position: absolute;
  left: 0;
  top: 48px;
  height: calc(100% - 48px);
}

/* CSS 边框（右键菜单可开关）：贴在窗口四周的 1px 半透明白线。
 * 画在 canvas 上用 outline（绘制在位图之上，inset box-shadow 会被
 * canvas 位图盖住）；窗口本身 transparent，观感即「贴图带了一圈边框」。 */
.pin-canvas.is-framed {
  outline: 1px solid rgba(255, 255, 255, 0.55);
  outline-offset: -1px;
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

/* 编辑态工具条：画在窗口顶部扩出来的悬浮条区域里（不压图片）。
 * 覆盖组件默认 top/bottom 的同时**必须两边都写**：只写 top 会留下组件的
 * bottom:28px → top+bottom 同时生效把盒子拉满整窗（真机踩过的坑）。 */
.pin-toolbar {
  position: absolute;
  top: 5px;
  bottom: auto;
  left: 50%;
  transform: translateX(-50%);
  max-width: calc(100vw - 16px);
  padding: 5px 8px;
  z-index: 30;
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

/* 文字输入：贴在点击处，半透明深底 + 虚线框（与截图输入框同一观感） */
.pin-text-input {
  position: absolute;
  z-index: 25;
  min-width: 120px;
  max-width: 90%;
  min-height: 28px;
  padding: 4px 8px;
  border: 1px dashed rgba(255, 255, 255, 0.75);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.55);
  border-radius: 3px;
  background: rgba(20, 20, 22, 0.55);
  color: inherit;
  font-family: sans-serif;
  line-height: 1.25;
  resize: none;
  outline: none;
}
.pin-text-input::placeholder {
  color: rgba(255, 255, 255, 0.55);
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
