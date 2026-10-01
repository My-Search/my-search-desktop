/**
 * 录屏 / 转码的 ffmpeg 参数拼装（**纯函数**，可单测）。
 *
 * ## 为什么要抽出来
 *
 * ffmpeg 的参数是「位置敏感」的：同一个 `-i` 放前面是输入、放后面是输出；
 * gdigrab 的 `-offset_x` 必须在 `-i desktop` **之前**；`-vf` 与
 * `-filter_complex` 互斥。这些约束写错了不会报「参数错」，而是报一堆
 * 看不懂的滤镜/流错误。集中到一个纯函数里，既能单测又能一眼看清顺序。
 *
 * ## 关键取舍：编码器
 *
 * Windows 自带的 ffmpeg 构建**未必带 libx264**（有些精简包只有 `mpeg4`）。
 * 因此默认走「尽力而为」策略：优先 `libx264`，失败时界面提示并允许降级。
 * 参数里用 `-preset ultrafast` 是因为录屏对 CPU 敏感，画质让位于不掉帧。
 */
import { buildWatermarkFilter, escapeFilterPath } from "./watermark.mjs";

/** 规范化区域：{x,y,width,height}，全屏时返回 null */
export function normalizeRegion(region) {
  if (!region || typeof region !== "object") return null;
  const x = Math.max(0, Math.floor(Number(region.x) || 0));
  const y = Math.max(0, Math.floor(Number(region.y) || 0));
  const width = Math.floor(Number(region.width) || 0);
  const height = Math.floor(Number(region.height) || 0);
  if (width <= 0 || height <= 0) return null;
  // 宽高必须是偶数：libx264 的 yuv420p 要求，奇数会直接失败
  const even = (n) => (n % 2 === 0 ? n : n - 1);
  return { x, y, width: Math.max(2, even(width)), height: Math.max(2, even(height)) };
}

/**
 * 构造录屏命令。
 *
 * @param {object} opts
 * @param {string} opts.output        输出文件绝对路径
 * @param {string} opts.format        平台采集后端：win32 → gdigrab（或 ddagrab）；darwin → avfoundation；否则 x11grab
 * @param {object|null} opts.region   区域（null = 全屏）
 * @param {number} opts.fps           帧率
 * @param {boolean} opts.drawMouse    是否录制鼠标指针
 * @param {object} opts.audio         { system:boolean, mic:boolean, micDevice?:string }
 * @param {object} opts.watermark     水印规格（可为 null）
 * @param {string} opts.encoder       "libx264" | "mpeg4" | ...
 * @param {number} opts.crf           画质（越小越好，0..51），仅 x264 有意义
 * @param {string} opts.display       X11 的 DISPLAY（默认 :0.0）
 * @param {string} opts.avfoundationIndex  macOS 的屏幕索引（默认 "1"）
 * @param {number} opts.videoWidth    主视频宽度（像素）；图片水印按它算绝对缩放，见 watermark.mjs
 * @returns {{args:string[], hasFilterComplex:boolean, notes:string[]}}
 */
export function buildRecordArgs(opts = {}) {
  const platform = opts.platform || process.platform;
  const format = opts.format || defaultFormat(platform);
  const fps = clampInt(opts.fps, 1, 60, 30);
  const encoder = opts.encoder || "libx264";
  const crf = clampInt(opts.crf, 0, 51, 23);
  const region = normalizeRegion(opts.region);
  const notes = [];
  const args = [];

  // ---- 覆盖输出（重跑同名文件不要卡在交互式提问上）----
  args.push("-y");

  // ddagrab 出的是 D3D11 硬件帧，软件滤镜/编码器都吃不了，必须先下载回内存。
  // 这是它和 gdigrab（出普通 BGRA）唯一的参数差异。
  const hwChain = format === "ddagrab" ? "hwdownload,format=bgra" : "";

  // ---- 输入（采集）----
  if (format === "ddagrab") {
    // Windows：Desktop Duplication API（GPU 直接给帧）。相比 gdigrab 的
    // BitBlt(SRCCOPY|CAPTUREBLT)，它不经过 GDI 合成层——CAPTUREBLT 每帧都要
    // 「隐藏光标 → 拷屏 → 再显示光标」，录屏时鼠标狂闪就是这么来的。
    // ddagrab 是 lavfi 源滤镜，所以走 -f lavfi -i。
    const parts = ["framerate=" + fps, "draw_mouse=" + (opts.drawMouse === false ? 0 : 1)];
    if (region) {
      // offset_x/offset_y 是**所选输出（显示器）本地坐标**，不是虚拟桌面坐标。
      // 两者只在单屏时相等（虚拟桌面原点恒为主屏原点），因此后端只在单屏
      // 场景选本后端，见 index.mjs 的 probeCapture。
      parts.push(`video_size=${region.width}x${region.height}`);
      parts.push(`offset_x=${region.x}`);
      parts.push(`offset_y=${region.y}`);
    }
    args.push("-f", "lavfi", "-i", "ddagrab=" + parts.join(":"));
  } else if (format === "gdigrab") {
    args.push("-f", "gdigrab");
    args.push("-framerate", String(fps));
    args.push("-draw_mouse", opts.drawMouse === false ? "0" : "1");
    if (region) {
      // 顺序要求：offset/video_size 必须在 -i 之前
      args.push("-offset_x", String(region.x), "-offset_y", String(region.y));
      args.push("-video_size", `${region.width}x${region.height}`);
    }
    args.push("-i", "desktop");
  } else if (format === "x11grab") {
    args.push("-f", "x11grab");
    args.push("-framerate", String(fps));
    args.push("-draw_mouse", opts.drawMouse === false ? "0" : "1");
    const display = opts.display || ":0.0";
    args.push("-i", region ? `${display}+${region.x},${region.y}` : display);
    if (region) args.push("-video_size", `${region.width}x${region.height}`);
  } else if (format === "avfoundation") {
    args.push("-f", "avfoundation");
    args.push("-framerate", String(fps));
    args.push("-i", opts.avfoundationIndex || "1");
    if (region) notes.push("macOS 采集不支持区域裁剪，已按全屏录制");
  } else {
    throw new Error("不支持的采集格式: " + format);
  }

  // ---- 音频输入（可选；缺少设备时会让整条命令失败，故默认关闭）----
  const audio = opts.audio || {};
  let audioInputs = 0;
  if (audio.system && platform === "win32") {
    // Windows 的系统声音需要虚拟声卡（VB-Cable 等）或 dshow 设备名，
    // 名字因机器而异，不能硬编码——这里只记提示，由用户自行配置。
    notes.push("Windows 采集系统声音需要先安装虚拟声卡（如 VB-Cable）");
  }
  if (audio.mic && audio.micDevice) {
    args.push("-f", "dshow", "-i", `audio=${audio.micDevice}`);
    audioInputs++;
  }
  if (audioInputs === 0) args.push("-an");

  // ---- 水印（编码时烘焙进画面）----
  // 图片水印要占一路输入，序号排在视频(+可选音频)之后：音频在前时它就是 [2:v]，
  // 写死 [1:v] 会把音频输入当图片用。
  const wmImageIndex = 1 + audioInputs;
  const wm = buildWatermarkFilter(opts.watermark, {
    timestampMode: "localtime",
    hwDownload: !!hwChain,
    imageInputIndex: wmImageIndex,
    // 图片水印的缩放基准：优先用调用方已知的主视频宽度（录屏区域宽 /
    // 探测到的桌面宽），见 watermark.mjs 为什么不能用 main_w。
    videoWidth: Number(opts.videoWidth) > 0 ? opts.videoWidth : region ? region.width : undefined,
  });
  let hasFilterComplex = false;
  if (wm) {
    if (wm.kind === "image") {
      // 图片水印要额外一路输入，且只能用 -filter_complex
      args.push("-i", opts.watermark.imagePath);
      args.push("-filter_complex", wm.filter);
      hasFilterComplex = true;
    } else if (hwChain) {
      args.push("-vf", `${hwChain},${wm.filter}`);
    } else {
      args.push("-vf", wm.filter);
    }
    // drawtext 依赖字体；显式给出 fontfile 时无需 fontconfig
    if (wm.kind === "text" && !wm.spec.fontFile) {
      notes.push("未指定字体文件，中文可能显示为方块（建议在设置里选择中文字体）");
    }
  } else if (hwChain) {
    // 无水印也要把硬件帧下载回内存，否则编码器拒绝输入
    args.push("-vf", hwChain);
  }

  // ---- 编码 ----
  if (encoder === "libx264") {
    args.push("-c:v", "libx264", "-preset", "ultrafast", "-crf", String(crf));
    args.push("-pix_fmt", "yuv420p"); // 保证播放器/剪辑软件都能读
  } else {
    args.push("-c:v", encoder, "-q:v", String(clampInt(opts.qv, 1, 31, 5)));
  }
  args.push("-movflags", "+faststart"); // moov 前置，便于边下边播、也防录制中断后文件不可读
  if (audioInputs > 0) args.push("-c:a", "aac", "-b:a", "128k");

  args.push(opts.output);
  return { args, hasFilterComplex, notes };
}

/** 给已有视频加水印的参数 */
export function buildWatermarkArgs(opts = {}) {
  const input = String(opts.input || "");
  const output = String(opts.output || "");
  if (!input) throw new Error("缺少输入视频路径");
  if (!output) throw new Error("缺少输出视频路径");

  const notes = [];
  const wm = buildWatermarkFilter(opts.watermark, {
    timestampMode: opts.timestampMode || "pts",
    videoWidth: opts.videoWidth,
  });
  if (!wm) throw new Error("水印未启用或配置不完整");
  // 与录制路径同一提示口径：文字水印没拿到字体时中文可能变方块
  if (wm.kind === "text" && !wm.spec.fontFile) {
    notes.push("未指定字体文件，中文可能显示为方块（建议在设置里选择中文字体）");
  }

  const args = ["-y", "-i", input];
  let hasFilterComplex = false;
  if (wm.kind === "image") {
    args.push("-i", optionsImagePath(opts.watermark));
    args.push("-filter_complex", wm.filter);
    hasFilterComplex = true;
  } else {
    args.push("-vf", wm.filter);
  }
  args.push("-c:v", opts.encoder || "libx264", "-preset", opts.preset || "medium");
  args.push("-crf", String(clampInt(opts.crf, 0, 51, 23)));
  args.push("-pix_fmt", "yuv420p");
  args.push("-c:a", "copy"); // 音频不重编码：省时间、不损质
  args.push("-movflags", "+faststart");
  if (opts.progress) args.push("-progress", "pipe:2", "-nostats");
  args.push(output);
  return { args, hasFilterComplex, notes };
}

function optionsImagePath(wm) {
  return String(wm?.imagePath || "");
}

/** 抽首帧当缩略图 */
export function buildThumbArgs(opts = {}) {
  return {
    args: [
      "-y",
      "-ss", String(Math.max(0, Number(opts.atSec) || 0)),
      "-i", String(opts.input || ""),
      "-frames:v", "1",
      "-vf", "scale=" + clampInt(opts.width, 16, 1920, 320) + ":-2",
      "-f", "image2pipe",
      "-vcodec", "png",
      "pipe:1",
    ],
  };
}

/** 读元数据（时长/分辨率/码率）*/
export function buildProbeArgs(input) {
  return [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,r_frame_rate,codec_name:format=duration,bit_rate,size",
    "-of", "json",
    String(input || ""),
  ];
}

export function defaultFormat(platform = process.platform) {
  if (platform === "win32") return "gdigrab";
  if (platform === "darwin") return "avfoundation";
  return "x11grab";
}

function clampInt(v, lo, hi, dflt) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

/** 给界面用的「本平台建议」提示 */
export function platformHints(platform = process.platform) {
  if (platform === "win32") {
    return {
      format: "gdigrab",
      regionSupported: true,
      systemAudio: "需要虚拟声卡（VB-Cable 等）",
    };
  }
  if (platform === "darwin") {
    return { format: "avfoundation", regionSupported: false, systemAudio: "需安装 BlackHole 等虚拟声卡" };
  }
  return { format: "x11grab", regionSupported: true, systemAudio: "PulseAudio 可用 pulse 采集" };
}

export { escapeFilterPath };
