/**
 * 手势轨迹 HUD 入口（gesture.html）
 *
 * 这是宿主常驻隐藏窗口（gesture-hud）的页面：Rust 侧低级鼠标钩子识别手势时，
 * 通过 `my-search://gesture-trail`（轨迹点序列）与 `my-search://gesture-result`
 * （识别结果）两个事件驱动本页面画轨迹与提示。
 *
 * 坐标约定：事件携带**虚拟屏幕物理像素**（MSLLHOOKSTRUCT.pt 口径，多屏时原点
 * 不在 (0,0)），并随事件附带虚拟屏包围盒（vx/vy/vw/vh）；本窗口由 Rust 铺在
 * 虚拟屏包围盒上，画线时先减去包围盒原点再按 devicePixelRatio 换算。
 * 手势结束（result 事件）后短暂展示反馈再自隐藏——由 Rust 在下一次手势激活时
 * 重新 show 本窗口，页面不负责 show。
 */
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface TrailPayload {
  points: Array<[number, number]>;
  active: boolean;
  /** 虚拟屏幕包围盒（物理像素）：钩子坐标系的原点与尺寸 */
  vx?: number;
  vy?: number;
  vw?: number;
  vh?: number;
}

interface ResultPayload {
  pattern: string;
  matched: boolean;
  label?: string;
  denied?: boolean;
  /** 拖拽距离不够的静默结束：HUD 不显示提示、立即自隐藏 */
  silent?: boolean;
  /** 录制模式相关：true 时 HUD 显示「录制中/已录制」而非「未映射」 */
  recording?: boolean;
}

const canvas = document.getElementById("trail") as HTMLCanvasElement;
const tip = document.getElementById("tip") as HTMLDivElement;
const ctx = canvas.getContext("2d")!;

/** 虚拟屏包围盒原点（物理像素）：钩子坐标 − 它 = 本窗口内坐标。
 *  Rust 侧把本窗口铺在包围盒上；事件缺省时按 (0,0) 兜底（单屏主屏布局）。 */
let originX = 0;
let originY = 0;

/** 虚拟屏物理像素 → 本窗口 CSS 像素（先平移原点，再按 dpr 换算） */
function toLocal(x: number, y: number): [number, number] {
  const dpr = window.devicePixelRatio || 1;
  return [(x - originX) / dpr, (y - originY) / dpr];
}

function resizeCanvas(): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  // canvas 的 backing store 是物理像素，而 toLocal() 产出 CSS 像素。
  // 必须让 ctx 以 CSS 像素为单位（乘 dpr），否则缩放屏（dpr≠1）上
  // 线会被画到实际位置的 1/dpr 处——鼠标在 A 点、线出现在 B 点。
  // 设置 canvas.width/height 会重置变换，故每次 resize 都要重新断言。
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();

/** 清屏（ctx 已是 CSS 像素坐标系，用 CSS 尺寸即可铺满 backing store） */
function clearCanvas(): void {
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
}

/** 画轨迹：底色描边 + 高亮细线（与截图标注画笔观感一致） */
function drawTrail(points: Array<[number, number]>): void {
  // HUD 由 Rust 在手势激活时 set_size，resize 事件可能晚于首批轨迹点；
  // 每帧校验一次尺寸，确保 ctx 变换与 backing store 对齐。
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(window.innerWidth * dpr)) resizeCanvas();
  clearCanvas();
  if (points.length < 2) return;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const [width, color] of [
    [10, "rgba(0,0,0,0.25)"],
    [5, "#ff5555"],
  ] as const) {
    ctx.beginPath();
    const [x0, y0] = toLocal(points[0][0], points[0][1]);
    ctx.moveTo(x0, y0);
    for (let i = 1; i < points.length; i++) {
      const [x, y] = toLocal(points[i][0], points[i][1]);
      ctx.lineTo(x, y);
    }
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.stroke();
  }
}

/** 提示跟随轨迹末端 */
function moveTip(points: Array<[number, number]>): void {
  if (!points.length) {
    tip.style.display = "none";
    return;
  }
  const [x, y] = toLocal(points[points.length - 1][0], points[points.length - 1][1]);
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}

let hideTimer: number | null = null;

/** 手势结束：按模式给反馈。
 *  recording:true = 录制相关（不执行动作）：
 *   - pattern 为空（进入录制模式 / 未画出方向）：持续显示「录制中」，不自隐藏；
 *   - pattern 非空（画完松手）：显示「已录制 xx」1.2s 后自隐藏，方向串由面板回填。
 *  silent = 拖拽距离不够 / 取消录制的静默结束：不显示提示，立即清画布并自隐藏。 */
function finish(payload: ResultPayload): void {
  if (payload.silent) {
    if (hideTimer !== null) window.clearTimeout(hideTimer);
    tip.style.display = "none";
    clearCanvas();
    void getCurrentWindow().hide();
    return;
  }
  if (payload.recording) {
    if (!payload.pattern) {
      // 录制中：常驻提示，等用户画完（或取消）——期间轨迹照常绘制
      tip.classList.remove("warn");
      tip.textContent = "◎ 录制中…按住 Ctrl+右键画手势";
      tip.style.display = "block";
      return;
    }
    tip.classList.remove("warn");
    tip.textContent = `◎ 已录制 ${payload.pattern}`;
    tip.style.display = "block";
    if (hideTimer !== null) window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      tip.style.display = "none";
      clearCanvas();
      void getCurrentWindow().hide();
    }, 1200);
    return;
  }
  tip.classList.toggle("warn", Boolean(payload.denied));
  tip.textContent = payload.denied
    ? `手势 ${payload.pattern} · 未授权执行`
    : payload.matched
      ? `手势 ${payload.pattern} · ${payload.label ?? "执行"}`
      : `手势 ${payload.pattern} · 未映射`;
  tip.style.display = "block";
  if (hideTimer !== null) window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    tip.style.display = "none";
    clearCanvas();
    void getCurrentWindow().hide();
  }, 1200);
}

void listen<TrailPayload>("my-search://gesture-trail", (event) => {
  const { points, vx, vy } = event.payload;
  if (typeof vx === "number" && typeof vy === "number") {
    originX = vx;
    originY = vy;
  }
  drawTrail(points);
  moveTip(points);
  // 自隐藏只由 result 事件负责（Rust 保证所有路径都发 result）；
  // 录制中 result 收场前 HUD 常驻，轨迹事件不得触发隐藏。
});

void listen<ResultPayload>("my-search://gesture-result", (event) => {
  finish(event.payload);
});
