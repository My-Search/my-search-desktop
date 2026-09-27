/**
 * 录屏与水印插件 —— 后台进程（JSON-RPC over stdin/stdout，NDJSON）。
 *
 * ============================ 它做什么 ============================
 *
 * 全部重活都在这条进程里，因为它要**拉起子进程**（ffmpeg），而插件的前台
 * 视图跑在 WebView 里，既没有 `getDisplayMedia`（见宿主 screenshot.rs 注释），
 * 也没有任意路径写文件的权限。具体三件事：
 *
 *   1. 定位本机 ffmpeg（`locateFfmpeg`，见 ffmpeg.mjs 为什么不能裸调 ffmpeg）；
 *   2. 驱动录屏：gdigrab/x11grab/avfoundation → 编码 → 落盘到私有目录；
 *   3. 给已有视频加水印：抽元数据、转码、推进度。
 *
 * 产物一律写进 `MS_PLUGIN_DATA_DIR/recordings/`——这是插件唯一有写权限的地方。
 * 「在资源管理器中定位」由本进程自己调 `explorer /select,`（宿主的
 * attachment_reveal 只放行搜索框里附加过的路径，用不上）。
 *
 * ============================ 协议（宿主约定）============================
 *
 * 传输：stdin/stdout，一行一个 JSON（NDJSON），UTF-8。
 *   **不要 console.log**！stdout 是协议通道，混入非 JSON 行会让宿主解析失败。
 *   日志走 stderr 或发 log 通知。
 *
 * 握手：宿主写 {"jsonrpc":"2.0","id":1,"method":"init",...}，须在
 *   startupTimeoutMs 内回 {"id":1,"result":{"ok":true}}。
 *
 * 通知（不带 id）：{"method":"<m>","params":{...}} → 宿主转成
 *   Tauri 事件 plugin://notification，前端用 ms.backend.onNotification 接。
 *
 * 退出：收到 {"method":"deactivate"}（无 id）后自行退出。
 */
import { createInterface } from "node:readline";
import { spawn, execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join, dirname, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { locateFfmpeg, resolveUserPath, probeVersion, FFMPEG_BIN } from "./ffmpeg.mjs";
import {
  buildRecordArgs,
  buildWatermarkArgs,
  buildThumbArgs,
  buildProbeArgs,
  defaultFormat,
  platformHints,
  normalizeRegion,
} from "./ffmpeg-args.mjs";
import { normalizeWatermark, DEFAULT_WATERMARK } from "./watermark.mjs";
import {
  provisionFfmpeg,
  existingBundled,
  defaultSources,
  isTrustedUrl,
  humanSize,
  estimatedNeed,
  freeSpaceAt,
} from "./downloader.mjs";

/* ======================= 基础通道 ======================= */

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.MS_PLUGIN_DATA_DIR || join(HERE, "..", "..", ".data");
const OUT_DIR = join(DATA_DIR, "recordings");
const CONFIG_FILE = join(DATA_DIR, "config.json");
/** 插件自带的 ffmpeg 落地目录（首次使用时下载到这里） */
const BIN_DIR = join(DATA_DIR, "ffmpeg");
const PLUGIN_ROOT = join(HERE, "..");

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function sendError(id, message) {
  send({ jsonrpc: "2.0", id, error: { message: String(message) } });
}
function sendLog(level, message) {
  send({ jsonrpc: "2.0", method: "log", params: { level, message: String(message) } });
}
/** 向前台广播（宿主转成 plugin://notification） */
function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

/* ======================= 配置持久化 ======================= */

function readConfig() {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}
function writeConfig(patch) {
  const next = { ...readConfig(), ...(patch || {}) };
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), "utf8");
  } catch (e) {
    sendLog("warn", "写配置失败: " + (e?.message || e));
  }
  return next;
}

/* ======================= 运行期状态 ======================= */

/** 当前录制会话（同一时刻只允许一个） */
let recording = null;
/** 当前转码任务（同一时刻只允许一个） */
let transcoding = null;
/** ffmpeg 探测结果缓存 */
let ffmpegInfo = null;

function ensureOutDir() {
  mkdirSync(OUT_DIR, { recursive: true });
  return OUT_DIR;
}

function timestampName(prefix) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${prefix}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes()
  )}${p(d.getSeconds())}-${process.pid.toString(16)}`;
}

/* ======================= ffmpeg 定位 ======================= */

async function ensureFfmpeg(userPath) {
  const cfg = readConfig();
  const want = String(userPath ?? cfg.ffmpegPath ?? "").trim();
  // 插件自带的那份（下载到私有目录）；不存在时返回 null，不报错
  const bundled = existingBundled(BIN_DIR);
  // 用户显式给了路径：每次都重探（可能刚装好），并更新缓存
  if (want) {
    const info = await locateFfmpeg({ userPath: want, bundledPath: bundled || "" });
    if (info.found) {
      writeConfig({ ffmpegPath: want, lastResolved: info.path, lastVersion: info.version });
    }
    ffmpegInfo = info;
    return info;
  }
  if (ffmpegInfo && ffmpegInfo.found) return ffmpegInfo;
  const info = await locateFfmpeg({ cachedPath: cfg.lastResolved || "", bundledPath: bundled || "" });
  if (info.found) writeConfig({ lastResolved: info.path, lastVersion: info.version });
  ffmpegInfo = info;
  return info;
}

/** 下载插件自带的 ffmpeg（只在用户点了「一键下载」时调用） */
let downloading = null;
async function downloadFfmpeg(params = {}) {
  if (downloading) throw new Error("已有下载任务在进行中");
  const sources = defaultSources();
  // 允许界面指定源（默认第一家；将来可做测速择优）
  const idx = Math.max(0, Math.min(sources.length - 1, Number(params.sourceIndex) || 0));
  const source = sources[idx];
  if (!source) throw new Error("当前平台没有可用的下载源");
  if (!isTrustedUrl(source.url)) throw new Error("下载源不在可信白名单内，已拒绝");

  downloading = {
    source: source.id,
    startedAt: Date.now(),
    percent: 0,
    phase: "download",
    received: 0,
    total: 0,
    message: "准备下载…",
    cancelled: false,
    abort: null,
  };

  const emit = (p) => {
    if (!downloading) return;
    downloading = { ...downloading, ...p };
    notify("ffmpeg:progress", {
      source: downloading.source,
      phase: downloading.phase,
      percent: downloading.percent || 0,
      received: downloading.received || 0,
      receivedText: humanSize(downloading.received || 0),
      total: downloading.total || 0,
      totalText: downloading.total ? humanSize(downloading.total) : "",
      message: downloading.message || "",
    });
  };

  try {
    const res = await provisionFfmpeg({
      binDir: BIN_DIR,
      source,
      platform: process.platform,
      onProgress: emit,
      // 直连 github.com 不通时，下载器会改用 api.github.com 换 CDN 直链。
      // 让用户能看到「换了条路」，而不是对着卡住的进度条猜。
      onResolved: (directUrl) => {
        try {
          emit({ phase: "download", message: "已切换到镜像直链 " + new URL(directUrl).host });
        } catch { /* 仅用于展示，失败不影响下载 */ }
      },
      verify: (exe) => probeVersion(exe),
    });
    writeConfig({ bundledVersion: res.version, bundledAt: new Date().toISOString(), bundledSource: res.source });
    ffmpegInfo = null; // 让下次 ensureFfmpeg 重新探测（这次会命中 bundled）
    const info = await ensureFfmpeg("");
    notify("ffmpeg:done", { ok: true, path: res.ffmpeg, version: res.version, bytes: res.bytes });
    return {
      ok: true,
      path: res.ffmpeg,
      version: res.version,
      bytes: res.bytes,
      bytesText: humanSize(res.bytes),
      source: res.source,
      resolved: info.path,
    };
  } catch (e) {
    notify("ffmpeg:done", { ok: false, error: e?.message || String(e) });
    const err = new Error("下载 ffmpeg 失败：" + (e?.message || e));
    err.code = "DOWNLOAD_FAILED";
    throw err;
  } finally {
    downloading = null;
  }
}

function requireFfmpeg(info) {
  if (!info?.found || !info.path) {
    const err = new Error(
      "尚未准备好 ffmpeg。可在「设置」里点「一键下载」（推荐），或自行安装后在「设置」里指定 ffmpeg.exe 路径。"
    );
    err.code = "FFMPEG_NOT_FOUND";
    throw err;
  }
  return info;
}

/* ======================= 通用子进程执行 ======================= */

/** 跑一个「一次性」的 ffmpeg/ffprobe 调用，收集 stdout/stderr */
function runOnce(exe, args, { timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message || "").trim().split(/\r?\n/).slice(-4).join(" | ");
        return reject(new Error(msg || "命令执行失败"));
      }
      resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

/* ======================= 录屏 ======================= */

async function startRecord(params = {}) {
  if (recording) throw new Error("已有录制在进行中，请先停止");
  const info = requireFfmpeg(await ensureFfmpeg(params.ffmpegPath));

  ensureOutDir();
  const region = normalizeRegion(params.region);
  const spec = normalizeWatermark(params.watermark || DEFAULT_WATERMARK);
  const output = join(OUT_DIR, timestampName("rec") + ".mp4");

  const { args, notes } = buildRecordArgs({
    output,
    platform: process.platform,
    format: params.format || defaultFormat(process.platform),
    region,
    fps: params.fps,
    drawMouse: params.drawMouse,
    audio: params.audio,
    watermark: spec,
    encoder: params.encoder,
    crf: params.crf,
  });

  sendLog("info", `开始录制: ${info.path} ${args.join(" ")}`);

  const child = spawn(info.path, args, { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
  const session = {
    child,
    output,
    startedAt: Date.now(),
    paused: false,
    endedAt: null,
    exitCode: null,
    lastError: "",
    notes,
    timer: null,
    ffmpeg: info.path,
  };
  recording = session;

  child.stderr.on("data", (d) => {
    const s = String(d);
    session.lastError = (session.lastError + s).slice(-4000);
    // ffmpeg 的进度行形如 `frame= 123 fps=30 ...`，这里不做精细解析，
    // 录制的时长以挂钟为准（更贴合用户直觉），只抓错误关键字。
    for (const line of s.split(/\r?\n/)) {
      if (/error|invalid|failed|no such/i.test(line)) sendLog("warn", "ffmpeg: " + line.trim());
    }
  });
  child.on("error", (e) => {
    sendLog("error", "启动 ffmpeg 失败: " + e.message);
    session.lastError += "\n" + e.message;
    session.exitCode = -1;
    session.endedAt = Date.now();
    notify("record:ended", { ok: false, error: e.message, output: null });
    if (recording === session) recording = null;
  });
  child.on("close", (code) => {
    session.exitCode = code;
    session.endedAt = Date.now();
    if (session.timer) clearInterval(session.timer);
    const ok = code === 0 || code === 255; // 255 是 gdigrab 收到 'q' 后的正常退出码之一
    const st = existsSync(output) ? statSync(output) : null;
    sendLog(ok ? "info" : "error", `录制结束 code=${code} size=${st ? st.size : 0}`);
    notify("record:ended", {
      ok: ok && !!st && st.size > 0,
      exitCode: code,
      output: ok && st ? relOf(output) : null,
      size: st ? st.size : 0,
      durationMs: (session.endedAt || Date.now()) - session.startedAt,
      error: ok ? null : lastLines(session.lastError),
    });
    if (recording === session) recording = null;
  });

  // 每 500ms 推一次时长，让界面计时器与后端一致（避免两边各算各的）
  session.timer = setInterval(() => {
    if (recording !== session) return;
    const st = existsSync(output) ? statSync(output) : null;
    notify("record:tick", {
      elapsedMs: Date.now() - session.startedAt - session.pausedMs,
      paused: session.paused,
      size: st ? st.size : 0,
    });
  }, 500);

  return {
    ok: true,
    output: relOf(output),
    args,
    notes,
    ffmpeg: info.path,
    startedAt: session.startedAt,
  };
}

function stopRecord() {
  if (!recording) return { ok: false, error: "当前没有进行中的录制" };
  const session = recording;
  return new Promise((resolve) => {
    const done = () => resolve({ ok: true, output: relOf(session.output) });
    // 先礼后兵：向 stdin 写 'q' 让 ffmpeg 收尾并写完 moov；3 秒没退再强杀
    try {
      session.child.stdin.write("q");
    } catch {}
    const t = setTimeout(() => {
      try {
        if (process.platform === "win32") spawn("taskkill", ["/PID", String(session.child.pid), "/T", "/F"]);
        else session.child.kill("SIGKILL");
      } catch {}
      done();
    }, 3000);
    session.child.once("close", () => {
      clearTimeout(t);
      done();
    });
  });
}

function pauseRecord(params = {}) {
  if (!recording) throw new Error("当前没有进行中的录制");
  // gdigrab 无法真正暂停；这里做「逻辑暂停」：记录累计暂停时长，
  // 让界面计时与产物时长口径一致。全量暂停/恢复需切到分段录制，见 README 已知限制。
  const session = recording;
  const want = params.paused !== false;
  if (want === session.paused) return { ok: true, paused: session.paused };
  if (want) {
    session.pausedAt = Date.now();
    session.paused = true;
  } else {
    session.pausedMs = (session.pausedMs || 0) + (Date.now() - (session.pausedAt || Date.now()));
    session.paused = false;
  }
  notify("record:tick", { elapsedMs: Date.now() - session.startedAt - (session.pausedMs || 0), paused: session.paused });
  return { ok: true, paused: session.paused, note: "gdigrab 不支持真正暂停，时间戳已按暂停时长修正" };
}

function recordStatus() {
  if (!recording) return { active: false };
  const st = existsSync(recording.output) ? statSync(recording.output) : null;
  return {
    active: true,
    output: relOf(recording.output),
    elapsedMs: Date.now() - recording.startedAt - (recording.pausedMs || 0),
    paused: recording.paused,
    size: st ? st.size : 0,
  };
}

/* ======================= 给已有视频加水印 ======================= */

async function detectVideo(params = {}) {
  const input = String(params.input || "").trim();
  if (!input || !existsSync(input)) throw new Error("视频文件不存在: " + input);
  const info = requireFfmpeg(await ensureFfmpeg(params.ffmpegPath));
  if (!info.probePath) {
    throw new Error("未找到 ffprobe（通常与 ffmpeg 同目录），无法读取视频信息");
  }
  const { stdout } = await runOnce(info.probePath, buildProbeArgs(input), { timeout: 20000 });
  let meta = {};
  try {
    meta = JSON.parse(stdout || "{}");
  } catch {
    meta = {};
  }
  const v = (meta.streams && meta.streams[0]) || {};
  const f = meta.format || {};
  const [num, den] = String(v.r_frame_rate || "0/1").split("/").map(Number);
  return {
    input,
    name: basename(input),
    size: Number(f.size) || 0,
    durationSec: Number(f.duration) || 0,
    bitRate: Number(f.bit_rate) || 0,
    width: Number(v.width) || 0,
    height: Number(v.height) || 0,
    fps: den ? Math.round((num / den) * 100) / 100 : 0,
    codec: v.codec_name || "",
  };
}

async function applyWatermark(params = {}) {
  if (transcoding) throw new Error("已有转码任务在进行中，请稍候");
  const input = String(params.input || "").trim();
  if (!input || !existsSync(input)) throw new Error("视频文件不存在: " + input);
  const info = requireFfmpeg(await ensureFfmpeg(params.ffmpegPath));

  ensureOutDir();
  const spec = normalizeWatermark(params.watermark || DEFAULT_WATERMARK);
  // 用户可指定输出名（仍需落在私有目录内，防止越权写盘）
  const wantName = String(params.outputName || "").trim();
  const safeName = wantName ? basename(wantName).replace(/[^\w\u4e00-\u9fa5.-]+/g, "_") : "";
  const output = join(
    OUT_DIR,
    (safeName && safeName.toLowerCase().endsWith(".mp4") ? safeName : timestampName("wm-" + baseNameNoExt(input)) + ".mp4")
  );

  let durationSec = Number(params.durationSec) || 0;
  if (!durationSec && info.probePath) {
    try {
      const d = await detectVideo({ input, ffmpegPath: params.ffmpegPath });
      durationSec = d.durationSec;
    } catch {
      durationSec = 0;
    }
  }

  const { args, hasFilterComplex } = buildWatermarkArgs({
    input,
    output,
    watermark: spec,
    encoder: params.encoder,
    crf: params.crf,
    timestampMode: params.timestampMode || "pts",
    progress: true,
  });

  sendLog("info", `加水印: ${args.join(" ")}`);
  const child = spawn(info.path, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  const task = { child, output, input, startedAt: Date.now(), durationSec, lastTime: 0 };
  transcoding = task;

  child.stderr.on("data", (d) => {
    const s = String(d);
    // ffmpeg 的 -progress pipe:2 会输出 `out_time_ms=<微秒>` 之类的键值行
    for (const line of s.split(/\r?\n/)) {
      const m = /out_time_ms=(\d+)/.exec(line) || /out_time_us=(\d+)/.exec(line);
      if (m) {
        task.lastTime = Number(m[1]) / 1e6;
        notify("watermark:progress", {
          seconds: task.lastTime,
          durationSec,
          percent: durationSec > 0 ? Math.min(100, (task.lastTime / durationSec) * 100) : 0,
        });
      }
    }
    task.lastError = ((task.lastError || "") + s).slice(-4000);
  });

  return await new Promise((resolve) => {
    child.on("error", (e) => {
      transcoding = null;
      resolve({ ok: false, error: "启动 ffmpeg 失败: " + e.message });
    });
    child.on("close", (code) => {
      if (transcoding === task) transcoding = null;
      const st = existsSync(output) ? statSync(output) : null;
      const ok = code === 0 && !!st && st.size > 0;
      if (!ok && st) {
        try {
          unlinkSync(output); // 半成品删掉，别让用户以为成功了
        } catch {}
      }
      notify("watermark:done", { ok, output: ok ? relOf(output) : null, size: st ? st.size : 0 });
      resolve({
        ok,
        output: ok ? relOf(output) : null,
        size: st ? st.size : 0,
        exitCode: code,
        durationSec,
        error: ok ? null : lastLines(task.lastError || "") || "转码失败",
      });
    });
  });
}

/* ======================= 作品库 ======================= */

function relOf(abs) {
  const norm = String(abs).replace(/\\/g, "/");
  const base = OUT_DIR.replace(/\\/g, "/");
  return norm.startsWith(base) ? "recordings/" + norm.slice(base.length + 1) : norm;
}

function absOf(rel) {
  const s = String(rel || "").replace(/\\/g, "/");
  // 只接受 recordings/ 下的相对路径，杜绝越界读写
  if (!s.startsWith("recordings/")) throw new Error("非法路径: " + rel);
  const name = s.slice("recordings/".length);
  if (!name || name.includes("..") || name.includes("/")) throw new Error("非法路径: " + rel);
  return join(OUT_DIR, name);
}

function listRecordings() {
  ensureOutDir();
  const out = [];
  for (const name of readdirSync(OUT_DIR)) {
    if (!/\.(mp4|mkv|webm|mov|avi)$/i.test(name)) continue;
    const full = join(OUT_DIR, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    out.push({
      relPath: "recordings/" + name,
      name,
      size: st.size,
      mtimeMs: st.mtimeMs,
      createdAt: new Date(st.mtimeMs).toISOString(),
      kind: /^wm-/i.test(name) ? "watermark" : "record",
    });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

function removeRecording(params = {}) {
  const abs = absOf(params.relPath);
  if (!existsSync(abs)) throw new Error("文件不存在");
  unlinkSync(abs);
  return { ok: true };
}

/** 抽首帧 → base64 PNG（界面用它当缩略图，规避「没有 asset 协议」的限制） */
async function thumb(params = {}) {
  const info = requireFfmpeg(await ensureFfmpeg(params.ffmpegPath));
  const abs = absOf(params.relPath);
  if (!existsSync(abs)) throw new Error("文件不存在");
  const { args } = buildThumbArgs({ input: abs, atSec: params.atSec || 1, width: params.width || 320 });
  const base64 = await new Promise((resolve, reject) => {
    const child = spawn(info.path, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let err = "";
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("error", (e) => reject(new Error("抽帧失败: " + e.message)));
    child.on("close", (code) => {
      if (code === 0 && chunks.length) resolve(Buffer.concat(chunks).toString("base64"));
      else reject(new Error(lastLines(err) || "抽帧失败"));
    });
  });
  return { relPath: params.relPath, base64, mime: "image/png" };
}

/** 在资源管理器 / Finder 中定位（本进程自己调，不走宿主 API） */
function revealFile(params = {}) {
  const abs = absOf(params.relPath);
  if (!existsSync(abs)) throw new Error("文件不存在");
  try {
    if (process.platform === "win32") {
      spawn("explorer.exe", ["/select,", abs], { detached: true, windowsHide: false, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", ["-R", abs], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [dirname(abs)], { detached: true, stdio: "ignore" }).unref();
    }
  } catch (e) {
    throw new Error("打开文件管理器失败: " + e.message);
  }
  return { ok: true };
}

/** 用系统默认播放器打开 */
function openFile(params = {}) {
  const abs = absOf(params.relPath);
  if (!existsSync(abs)) throw new Error("文件不存在");
  try {
    if (process.platform === "win32") {
      // start 是 cmd 内建命令，必须经 cmd /c；空标题 "" 用于吞掉带引号的路径
      spawn("cmd.exe", ["/c", "start", "", abs], { detached: true, windowsHide: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [abs], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [abs], { detached: true, stdio: "ignore" }).unref();
    }
  } catch (e) {
    throw new Error("打开失败: " + e.message);
  }
  return { ok: true };
}

/* ======================= 能力与设置 ======================= */

async function capabilities(params = {}) {
  const info = await ensureFfmpeg(params.ffmpegPath);
  const cfg = readConfig();
  const bundled = existingBundled(BIN_DIR);
  const sources = defaultSources();
  return {
    platform: process.platform,
    dataDir: DATA_DIR,
    outDir: OUT_DIR,
    binDir: BIN_DIR,
    ffmpeg: {
      found: !!info.found,
      path: info.path,
      version: info.version,
      probePath: info.probePath,
      probeFound: !!info.probeFound,
      source: info.source,
      userPath: cfg.ffmpegPath || "",
      tried: info.tried || [],
      // 自带副本的状态：界面据此决定显示「一键下载」还是「已就绪」
      bundled: {
        present: !!bundled,
        path: bundled,
        version: cfg.bundledVersion || null,
        downloadedAt: cfg.bundledAt || null,
      },
      download: {
        inProgress: !!downloading,
        sources: sources.map((s) => ({
          id: s.id,
          url: s.url,
          kind: s.kind,
          approxBytes: s.approxBytes || 0,
          approxText: s.approxBytes ? humanSize(s.approxBytes) : "",
        })),
        // 供界面在动手前提示空间需求 / 提前发现磁盘将满
        needBytes: estimatedNeed(sources[0] && sources[0].approxBytes),
        needText: humanSize(estimatedNeed(sources[0] && sources[0].approxBytes)),
        freeBytes: await freeSpaceAt(BIN_DIR),
      },
    },
    hints: platformHints(process.platform),
    recordings: listRecordings().length,
    busy: { recording: !!recording, transcoding: !!transcoding, downloading: !!downloading },
  };
}

/** 探测常见中文字体，供 drawtext 避免中文方块 */
function listFonts() {
  const cands =
    process.platform === "win32"
      ? [
          "C:\\Windows\\Fonts\\msyh.ttc",
          "C:\\Windows\\Fonts\\msyhbd.ttc",
          "C:\\Windows\\Fonts\\simhei.ttf",
          "C:\\Windows\\Fonts\\simsun.ttc",
          "C:\\Windows\\Fonts\\deng.ttf",
        ]
      : process.platform === "darwin"
        ? ["/System/Library/Fonts/PingFang.ttc", "/Library/Fonts/Arial Unicode.ttf"]
        : [
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
          ];
  return cands.filter((p) => {
    try {
      return existsSync(p);
    } catch {
      return false;
    }
  });
}

/* ======================= 请求分发 ======================= */

async function handleRequest(id, method, params) {
  switch (method) {
    case "init": {
      ensureOutDir();
      sendLog("info", `后端已启动，数据目录 ${DATA_DIR}`);
      sendResult(id, {
        ok: true,
        dataDir: DATA_DIR,
        outDir: OUT_DIR,
        hostVersion: process.env.MS_PLUGIN_HOST_VERSION || null,
        platform: process.platform,
      });
      return;
    }

    case "capabilities":
      sendResult(id, await capabilities(params || {}));
      return;

    case "probeFfmpeg":
      sendResult(id, await capabilities(params || {}));
      return;

    case "setFfmpegPath": {
      const p = String(params?.path || "").trim();
      const cfg = writeConfig({ ffmpegPath: p });
      ffmpegInfo = null;
      const info = await ensureFfmpeg(p);
      sendResult(id, { saved: true, ffmpegPath: cfg.ffmpegPath || "", found: !!info.found, path: info.path, version: info.version });
      return;
    }

    /** 一键下载插件自带的 ffmpeg（进度走 ffmpeg:progress 通知） */
    case "downloadFfmpeg":
      sendResult(id, await downloadFfmpeg(params || {}));
      return;

    /** 删除已下载的自带副本（换源重下 / 回收磁盘用） */
    case "removeBundledFfmpeg": {
      const bundled = existingBundled(BIN_DIR);
      if (!bundled) return sendResult(id, { ok: false, error: "没有已下载的副本" });
      try {
        rmSync(BIN_DIR, { recursive: true, force: true });
      } catch (e) {
        return sendResult(id, { ok: false, error: "删除失败: " + e.message });
      }
      ffmpegInfo = null;
      writeConfig({ bundledVersion: null, bundledAt: null, bundledSource: null, lastResolved: "" });
      sendResult(id, { ok: true });
      return;
    }

    /** 列出当前平台的下载源（界面展示用；顺序即优先级） */
    case "downloadSources": {
      const srcs = defaultSources();
      sendResult(id, {
        platform: process.platform,
        sources: srcs.map((s) => ({
          id: s.id, url: s.url, kind: s.kind,
          approxBytes: s.approxBytes || 0,
          approxText: s.approxBytes ? humanSize(s.approxBytes) : "",
        })),
        needBytes: estimatedNeed(srcs[0] && srcs[0].approxBytes),
        freeBytes: await freeSpaceAt(BIN_DIR),
      });
      return;
    }

    case "listFonts":
      sendResult(id, { fonts: listFonts() });
      return;

    case "startRecord":
      sendResult(id, await startRecord(params || {}));
      return;

    case "stopRecord":
      sendResult(id, await stopRecord());
      return;

    case "pauseRecord":
      sendResult(id, pauseRecord(params || {}));
      return;

    case "recordStatus":
      sendResult(id, recordStatus());
      return;

    case "detectVideo":
      sendResult(id, await detectVideo(params || {}));
      return;

    case "applyWatermark":
      sendResult(id, await applyWatermark(params || {}));
      return;

    case "cancelWatermark": {
      if (!transcoding) return sendResult(id, { ok: false, error: "没有进行中的转码" });
      try {
        if (process.platform === "win32") spawn("taskkill", ["/PID", String(transcoding.child.pid), "/T", "/F"]);
        else transcoding.child.kill("SIGKILL");
      } catch {}
      sendResult(id, { ok: true });
      return;
    }

    case "listRecordings":
      sendResult(id, listRecordings());
      return;

    case "removeRecording":
      sendResult(id, removeRecording(params || {}));
      return;

    case "thumb":
      sendResult(id, await thumb(params || {}));
      return;

    case "revealFile":
      sendResult(id, revealFile(params || {}));
      return;

    case "openFile":
      sendResult(id, openFile(params || {}));
      return;

    case "state":
      sendResult(id, {
        recording: recordStatus(),
        transcoding: transcoding ? { input: transcoding.input, output: relOf(transcoding.output) } : null,
      });
      return;

    default:
      sendError(id, `未知方法: ${method}`);
  }
}

/* ======================= 工具 ======================= */

function baseNameNoExt(p) {
  const b = basename(String(p || "video"));
  const e = extname(b);
  return e ? b.slice(0, -e.length) : b;
}

function lastLines(text) {
  const s = String(text || "").trim();
  if (!s) return "";
  return s.split(/\r?\n/).filter(Boolean).slice(-4).join(" | ").slice(0, 600);
}

/* ======================= 主循环 ======================= */

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  const trimmed = String(line).trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    sendLog("warn", "收到无法解析的行: " + trimmed.slice(0, 120));
    return;
  }
  const { method, id, params } = msg;

  if (method === "deactivate" && id == null) {
    sendLog("info", "收到 deactivate，正在退出…");
    // 退出前收尾：正在录制的先停掉，避免留下损坏文件
    if (recording) {
      try {
        recording.child.stdin.write("q");
      } catch {}
    }
    rl.close();
    setTimeout(() => process.exit(0), 300);
    return;
  }

  if (id != null) {
    handleRequest(id, method, params).catch((e) => {
      sendError(id, (e?.code ? "[" + e.code + "] " : "") + (e?.message || e));
      sendLog("error", "处理 " + method + " 失败: " + (e?.stack || e));
    });
  }
});

rl.on("close", () => process.exit(0));

process.on("exit", () => {
  // 进程消失时顺手杀掉 ffmpeg，别留孤儿（宿主的 Job Object 也会兜底）
  try {
    if (recording?.child?.pid && process.platform === "win32") {
      spawn("taskkill", ["/PID", String(recording.child.pid), "/T", "/F"]);
    }
  } catch {}
});

process.stderr.write("[recorder-backend] 已启动，等待 init 握手…\n");
