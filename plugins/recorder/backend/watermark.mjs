/**
 * 水印规格 → ffmpeg 参数（**纯函数**，可单测，不含任何 IO）。
 *
 * ## 为什么单独一个文件
 *
 * 「把用户在界面上的选择翻成 ffmpeg 滤镜字符串」是整条链路里最容易出错、
 * 又最值得单测的一段：位置表达式、中文转义、透明度、时间戳占位符，任何
 * 一个写错都只会在真正转码时炸掉（而本机未必装了 ffmpeg，跑不到那一步）。
 * 因此它被抽成无副作用的纯函数，由 test/recorder-plugin.test.mjs 直接断言。
 *
 * ## 约定
 *
 * - 位置用九宫格枚举（`anchor`），配合 `margin` 与相对尺寸（`sizePct`）。
 *   尺寸用**相对视频高度的百分比**表达，这样同一个水印在大分辨率视频上
 *   不会小得看不见（固定像素尺寸是新手最常见的坑）。
 * - 颜色一律 `#RRGGBB`，透明度单独用 `opacity`（0..1）→ 换算成 drawtext 的
 *   `@alpha` 后缀，不要求用户在颜色里手写 `@0.5`。
 * - 文字里的 `:` `'` `%` 等对 drawtext 有特殊含义的字符必须转义，否则
 *   ffmpeg 直接报语法错误。转义规则见 `escapeDrawtext`。
 */

/** 九宫格锚点 */
export const ANCHORS = [
  "top-left",
  "top-center",
  "top-right",
  "middle-left",
  "center",
  "middle-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
];

/** 默认水印规格（界面首次打开时的初值） */
export const DEFAULT_WATERMARK = {
  enabled: true,
  /** "text"（文字） | "image"（图片） */
  type: "text",
  /** 文字内容，支持 ffmpeg 时间戳占位符写法（见 withTimestamp） */
  text: "我的搜索",
  /** 图片水印的绝对路径（仅 type=image 用） */
  imagePath: "",
  /** 字体文件绝对路径（留空 = 由后端自动探测一个中文字体，见 index.mjs 的 ensureWatermarkFont） */
  fontFile: "",
  /** 字号 = 视频高度的百分比（1..100） */
  sizePct: 4,
  /** 颜色 #RRGGBB */
  color: "#FFFFFF",
  /** 透明度 0..1 */
  opacity: 0.6,
  /** 是否描边（深色描边让浅色背景上的白字依然可读） */
  border: true,
  /** 描边颜色 */
  borderColor: "#000000",
  /** 九宫格位置 */
  anchor: "bottom-right",
  /** 距边缘的留白，同样是视频高度的百分比 */
  marginPct: 2,
  /** 是否在文字后追加本地时间戳 */
  timestamp: false,
};

/* ============================ 基础工具 ============================ */

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** 规范化 #RRGGBB（接受 3 位简写、不带 #；非法值退回 #FFFFFF） */
export function normalizeColor(input, fallback = "#FFFFFF") {
  let s = String(input ?? "").trim();
  if (!s) return fallback;
  if (!s.startsWith("#")) s = "#" + s;
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    const [, r, g, b] = s;
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toUpperCase();
  return fallback;
}

/**
 * 0..1 透明度 → drawtext 颜色后缀 `@0.5`。
 * 1.0 时**不加后缀**（drawtext 对 `@1.0` 的解析在部分版本上有差异，统一省略）。
 */
export function alphaSuffix(opacity) {
  const a = clamp(Number(opacity), 0, 1);
  if (!Number.isFinite(a) || a >= 1) return "";
  // 三位小数足够表达界面上的滑块精度，且避免浮点尾巴（0.6000000000000001）
  return "@" + String(Math.round(a * 1000) / 1000);
}

/**
 * 转义 drawtext 的 `text=` 取值。
 *
 * drawtext 的滤镜串是「一层 ffmpeg 滤镜图语法 + 一层 drawtext 自己的键值」，
 * 特殊字符必须按**两层**转义，否则会报语法错或渲染成乱码。各家 ffmpeg
 * 构建对反斜杠的吞并层数略有差异，下面的层数都是在本插件自带的 BtbN
 * Windows 构建上实测出来的（`test/recorder-plugin.test.mjs` 有对应的
 * 实机渲染冒烟测试兜底）：
 *
 * | 字符 | 转义        | 说明 |
 * |------|-------------|------|
 * | `:`  | `\\:`       | 滤镜图先吃一层反斜杠；只写 `\:` 会被判成选项分隔符（旧实现就是这里炸） |
 * | `,;[]` | `\,` `\;` `\[` `\]` | 滤镜**图**层面的分隔符 / 标签字符 |
 * | `'`  | `\\\'`      | ffmpeg 的引号处理比较绕，实测三层反斜杠最稳 |
 * | `\`  | `\\\\`      | 反斜杠自身 |
 * | `%`  | 见 `percentAsLiteral` | |
 *
 * `%` 是 drawtext 的扩展前缀，两种模式下写法不同：
 * - `expansion=normal`（开启时间戳时）：字面 `%` 必须写成**四个反斜杠 + %**
 *   （该构建上 `%%` 反而报 `Stray %`）。
 * - `expansion=none`（未开启时间戳时）：`%` 无特殊含义，**原样**写出即可。
 * 由 `percentAsLiteral` 开关区分，避免「进度 100%」这类文字直接让录制失败。
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {boolean} [opts.percentAsLiteral] expansion=normal 时传 true
 */
export function escapeDrawtext(text, opts = {}) {
  const pctLiteral = opts.percentAsLiteral === true;
  let out = "";
  for (const ch of String(text ?? "")) {
    switch (ch) {
      case "\\": out += "\\\\\\\\"; break;
      case ":": out += "\\\\:"; break;
      case ",": case ";": case "[": case "]": out += "\\" + ch; break;
      case "'": out += "\\\\\\'"; break;
      case "%": out += pctLiteral ? "\\\\\\\\%" : "%"; break;
      case "\n": out += "\\n"; break;
      case "\r": break;
      default: out += ch;
    }
  }
  return out;
}

/**
 * 位置 → drawtext 的 `x=` / `y=` 表达式。
 *
 * drawtext 里有几个「魔法变量」：`w`/`h` 是输入（视频）宽高，
 * `text_w`/`text_h` 是渲染后文字宽高。表达式中 `*0.4` 即留白占屏比。
 */
export function positionExpr(anchor, marginPct) {
  const m = clamp(Number(marginPct) || 0, 0, 50) / 100;
  const a = ANCHORS.includes(anchor) ? anchor : "bottom-right";
  const [v, h] = a === "center" ? ["middle", "center"] : a.split("-");
  // split 后 center 是单段，需归一
  const vertical = a === "center" ? "middle" : v;
  const horizontal = a === "center" ? "center" : h;

  const x =
    horizontal === "left"
      ? `(w*${m})`
      : horizontal === "center"
        ? `((w-text_w)/2)`
        : `(w-text_w-w*${m})`;
  const y =
    vertical === "top"
      ? `(h*${m})`
      : vertical === "middle"
        ? `((h-text_h)/2)`
        : `(h-text_h-h*${m})`;
  return { x, y };
}

/**
 * 图片水印的位置 → overlay 的 `x=` / `y=` 表达式。
 *
 * 与 drawtext 不同：overlay 的「叠加层」有自己的尺寸变量 `overlay_w`/
 * `overlay_h`，且要先把水印缩放到目标宽度（用 `scale2ref` 或直接先 scale）。
 * 这里只产出定位表达式，缩放由 `buildWatermarkFilter` 负责。
 */
export function overlayPositionExpr(anchor, marginPct) {
  const m = clamp(Number(marginPct) || 0, 0, 50) / 100;
  const a = ANCHORS.includes(anchor) ? anchor : "bottom-right";
  const vertical = a === "center" ? "middle" : a.split("-")[0];
  const horizontal = a === "center" ? "center" : a.split("-")[1];

  const x =
    horizontal === "left"
      ? `(main_w*${m})`
      : horizontal === "center"
        ? `((main_w-overlay_w)/2)`
        : `(main_w-overlay_w-main_w*${m})`;
  const y =
    vertical === "top"
      ? `(main_h*${m})`
      : vertical === "middle"
        ? `((main_h-overlay_h)/2)`
        : `(main_h-overlay_h-main_h*${m})`;
  return { x, y };
}

/** 把规格收敛成规范值（界面上可能给出空串/越界数，统一在这里兜住） */
export function normalizeWatermark(spec) {
  const s = spec && typeof spec === "object" ? spec : {};
  const type = s.type === "image" ? "image" : "text";
  return {
    enabled: s.enabled !== false,
    type,
    text: typeof s.text === "string" ? s.text : DEFAULT_WATERMARK.text,
    imagePath: typeof s.imagePath === "string" ? s.imagePath : "",
    fontFile: typeof s.fontFile === "string" ? s.fontFile : "",
    sizePct: clamp(Number(s.sizePct) || DEFAULT_WATERMARK.sizePct, 1, 60),
    color: normalizeColor(s.color, DEFAULT_WATERMARK.color),
    opacity: clamp(Number(s.opacity ?? DEFAULT_WATERMARK.opacity), 0, 1),
    border: s.border !== false,
    borderColor: normalizeColor(s.borderColor, DEFAULT_WATERMARK.borderColor),
    anchor: ANCHORS.includes(s.anchor) ? s.anchor : DEFAULT_WATERMARK.anchor,
    marginPct: clamp(Number(s.marginPct ?? DEFAULT_WATERMARK.marginPct), 0, 25),
    timestamp: s.timestamp === true,
  };
}

/**
 * 时间戳占位符（**原文**，调用方不要再对它做用户文字转义）。
 *
 * - `pts`：视频内时长，跟进度走（给已有视频加水印）。
 * - `localtime`：挂钟时间，录制时更符合直觉。
 *
 * 反斜杠层数按滤镜图两层的规则写死（`\\:` 两个反斜杠），实测该构建可用；
 * 多段格式化串（`%H\\:%M\\:%S`）在部分构建上会被判失败，故统一用单冒号的
 * `%T`（等价 `%H:%M:%S`）与 `%Y-%m-%d %T`。注意 `%` 只能一个（不能 `%%`），
 * 因为占位符本身就靠 `%{...}` 触发扩展。
 */
export function timestampPlaceholder(mode) {
  return mode === "localtime" ? "%{localtime\\\\:%Y-%m-%d %T}" : "%{pts\\\\:hms}";
}

/** 兼容旧名：文字 + 空格 + 占位符（占位符不做用户文字转义） */
export function withTimestamp(text, mode) {
  const ph = timestampPlaceholder(mode);
  return String(text || "").trim() ? `${text} ${ph}` : ph;
}

/* ============================ 滤镜构造 ============================ */

/**
 * 构造文字水印的 drawtext 滤镜串。
 *
 * 注意 `fontsize` 用 `h*百分比`：drawtext 支持表达式，`h` 是视频高度，
 * 这样字号随分辨率自适应（1080p 上 4% ≈ 43px）。
 *
 * ## `expansion` 的选择（关键）
 *
 * - **不开时间戳**：强制 `expansion=none`。这样用户文字里的 `%`、`{}` 都
 *   不再有特殊含义，可原样输出——「进度 100%」这类水印才不会被 ffmpeg
 *   判成 `Stray %` 而让整条录制命令失败（本插件自带构建的已知坑）。
 * - **开时间戳**：必须用默认（normal）扩展，占位符才会求值；此时用户文字里
 *   的字面 `%` 按 normal 模式转义（四个反斜杠），实测可用。
 *
 * 占位符由 `timestampPlaceholder` 产出**原文**，**不**参与用户文字转义，
 * 否则 `%` 被加倍会变成字面量（旧实现的双重转义 bug，实测直接渲染不出时间）。
 */
export function buildTextFilter(spec, opts = {}) {
  const w = normalizeWatermark(spec);
  const mode = opts.timestampMode || "pts";
  const userText = String(w.text ?? "");
  const useTimestamp = !!w.timestamp;
  if (!useTimestamp && !userText.trim()) throw new Error("文字水印内容为空");

  // 用户文字转义：开时间戳时字面 % 走 normal 规则，否则 % 原样（expansion=none）
  const escaped = escapeDrawtext(userText, { percentAsLiteral: useTimestamp });
  // 占位符原文追加在转义后的用户文字之后；用户文字为空时只留占位符
  const textValue = useTimestamp
    ? escaped.trim()
      ? `${escaped} ${timestampPlaceholder(mode)}`
      : timestampPlaceholder(mode)
    : escaped;

  const { x, y } = positionExpr(w.anchor, w.marginPct);
  const parts = [
    `text=${textValue}`,
    `fontsize=h*${(w.sizePct / 100).toFixed(4)}`,
    `fontcolor=${w.color}${alphaSuffix(w.opacity)}`,
    `x=${x}`,
    `y=${y}`,
  ];
  // expansion=none 时不必写（本就是默认值）；显式写出来更利于阅读与回归测试
  if (!useTimestamp) parts.push("expansion=none");
  if (w.fontFile) parts.push(`fontfile=${escapeFilterPath(w.fontFile)}`);
  if (w.border) {
    parts.push("borderw=2", `bordercolor=${w.borderColor}${alphaSuffix(Math.min(1, w.opacity + 0.3))}`);
  }
  return "drawtext=" + parts.join(":");
}

/**
 * 构造图片水印的 filter_complex 片段。
 *
 * 返回 `{ filter, hasSecondInput }`：图片水印需要额外一路输入 [N:v]，并用
 * overlay 合成，所以不能走 `-vf`，只能走 `-filter_complex`（这也是它比文字
 * 水印复杂的地方）。先把 logo 等比缩放到视频宽度的 `sizePct`，再按九宫格定位
 * 叠加。
 *
 * ## 缩放基准（按可靠性排序）
 *
 * 1. `opts.videoWidth` 已知（录屏区域宽度 / ffprobe 读出的宽度）→ 直接算出
 *    绝对像素 `scale=w=<n>:h=-1`，任何版本的 ffmpeg 都认，首选。
 * 2. 否则用 `rw`（新版 scale 的「参考宽度」= 滤镜图首个视频输入，即主视频）。
 *
 * **不要写 `scale=main_w*...`**：`main_w` 是 scale2ref 的变量，在 `scale` 里
 * 任何版本都不被接受——旧版报「表达式求值失败」，新版直接报
 * 「Expressions with scale2ref variables are not valid in scale filter」。
 * （图片水印此前一直转码失败，就是这个原因。）
 *
 * @param {object} opts
 * @param {boolean} opts.hwDownload      ddagrab：先把硬件帧下载成 BGRA 再合成
 * @param {number}  opts.imageInputIndex 图片输入的序号（前面可能已有音频输入）
 * @param {number}  opts.videoWidth      主视频宽度（像素），用于绝对缩放
 */
export function buildImageFilter(spec, opts = {}) {
  const w = normalizeWatermark(spec);
  if (!w.imagePath) throw new Error("图片水印未指定图片路径");
  const { x, y } = overlayPositionExpr(w.anchor, w.marginPct);
  const idx = Number(opts.imageInputIndex) > 0 ? Math.floor(Number(opts.imageInputIndex)) : 1;
  const pct = (w.sizePct / 100).toFixed(4);
  const scaleExpr =
    Number(opts.videoWidth) > 0
      ? `w=${Math.max(2, Math.round((Number(opts.videoWidth) * w.sizePct) / 100))}:h=-1`
      : `w=rw*${pct}:h=-1`;
  const download = opts.hwDownload ? "[0:v]hwdownload,format=bgra[base];" : "";
  const mainLabel = opts.hwDownload ? "[base]" : "[0:v]";
  const scale = `[${idx}:v]format=rgba,scale=${scaleExpr}[wm]`;
  const overlay =
    `${mainLabel}[wm]overlay=${x}:${y}:format=auto` +
    (w.opacity < 1 ? `,format=rgba,colorchannelmixer=aa=${w.opacity.toFixed(3)}` : "");
  return { filter: `${download}${scale};${overlay}`, hasSecondInput: true };
}

/**
 * 字体/图片路径进滤镜串前的转义。
 *
 * Windows 盘符里的冒号对滤镜图是特殊字符，直接写 `C:\a\b.ttc` 会被当成
 * 「选项分隔符」而报 `No option name near '\a\b.ttc'`。实测（本插件自带的
 * BtbN Windows 构建）**唯一可靠**的写法是：正斜杠 + 单反斜杠转义冒号 +
 * 用单引号把整个路径括起来：
 *
 *     fontfile='C\:/Windows/Fonts/msyh.ttc'   ← 实测通过，中文正常渲染
 *
 * 反例（都报 No option name / 解析失败）：`C\:/…`（缺引号）、
 * `'C:/…'`（缺冒号转义）、`'C\\:/…'`（多一层反斜杠）。
 * 路径含空格/逗号时同一写法也安全；含单引号（极罕见）时按 ffmpeg 惯例
 * 用 `'\''` 断开再拼接。Unix 路径不含冒号，原样返回。
 */
export function escapeFilterPath(p) {
  const s = String(p ?? "");
  if (!s) return s;
  // Windows 风格（含盘符冒号或反斜杠）→ 反斜杠归一为正斜杠，冒号单反斜杠转义，整体单引号包裹
  if (/^[A-Za-z]:/.test(s) || s.includes("\\")) {
    const inner = s.replace(/\\/g, "/").replace(/:/g, "\\:");
    return "'" + inner.replace(/'/g, "'\\''") + "'";
  }
  return s;
}

/**
 * 统一入口：给定规格，产出「怎么调用 ffmpeg」的完整描述。
 *
 * 返回：
 *   { kind: "text", filter: "drawtext=..." }         → 走 -vf
 *   { kind: "image", filter: "...;[0:v][wm]overlay…", hasSecondInput: true } → 走 -filter_complex
 *   null                                              → 未启用水印
 */
export function buildWatermarkFilter(spec, opts = {}) {
  const w = normalizeWatermark(spec);
  if (!w.enabled) return null;
  if (w.type === "image") {
    if (!w.imagePath) return null; // 选了图片但还没挑图：静默跳过，别让转码失败
    const { filter, hasSecondInput } = buildImageFilter(w, opts);
    return { kind: "image", filter, hasSecondInput: !!hasSecondInput, spec: w };
  }
  if (!String(w.text || "").trim()) return null;
  return { kind: "text", filter: buildTextFilter(w, opts), spec: w };
}

/* ============================ 浏览器端预览 ============================ */

/**
 * 在给定画布尺寸下算出水印的**像素落点**，供界面上的实时预览用。
 *
 * 与 ffmpeg 的表达式同源（同一套 anchor/margin/size 语义），但这里用 JS 算，
 * 因为界面预览没有 ffmpeg 可用。两边必须保持一致，否则「预览位置」和
 * 「导出结果」会对不上——这也是把它放进纯函数模块一起单测的原因。
 */
export function previewBox(spec, canvasW, canvasH, boxW, boxH) {
  const w = normalizeWatermark(spec);
  const margin = (w.marginPct / 100) * canvasH;
  const vertical = w.anchor === "center" ? "middle" : w.anchor.split("-")[0];
  const horizontal = w.anchor === "center" ? "center" : w.anchor.split("-")[1];

  let x =
    horizontal === "left" ? margin : horizontal === "center" ? (canvasW - boxW) / 2 : canvasW - boxW - margin;
  let y =
    vertical === "top" ? margin : vertical === "middle" ? (canvasH - boxH) / 2 : canvasH - boxH - margin;
  return { x: Math.round(x), y: Math.round(y) };
}

/** 预览用的字号（像素）：与 ffmpeg 的 `fontsize=h*百分比` 同口径 */
export function previewFontSize(spec, canvasH) {
  const w = normalizeWatermark(spec);
  return Math.max(8, Math.round(canvasH * (w.sizePct / 100)));
}
