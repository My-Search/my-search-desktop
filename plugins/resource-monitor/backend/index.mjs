/**
 * 资源监控插件 —— 后台进程（JSON-RPC over stdin/stdout, NDJSON）。
 *
 * ============================ 它做什么 ============================
 *
 *   1. 拉起长驻采样脚本 sample.ps1（见 sampler.mjs），每 5s 收一份原始快照；
 *   2. 用 aggregate.mjs（纯函数）求差 / 按程序聚合 / 排名，维护**最近 35 分钟**
 *      的环形缓冲；
 *   3. 每拍向前台推 `tick` 通知；前台打开时用 `history` 一次取回整段历史；
 *   4. 每 ~30s 把缓冲落盘到 `MS_PLUGIN_DATA_DIR/history.json`，重启后仍能接上。
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
 * 退出：收到 {"method":"deactivate"}（无 id）后自行退出（先停采样、flush）。
 */
import { createInterface } from "node:readline";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createState,
  ingest,
  historyPayload,
  restore,
  setThresholds,
  programPath,
  SAMPLE_MS,
  MAX_TRACK_N,
} from "./aggregate.mjs";
import { createSampler, resolvePowerShell } from "./sampler.mjs";
import { killProcess, listProcesses, revealProcessFile } from "./processes.mjs";
import { buildTopCsv, buildSystemCsv, exportFilename } from "./export-csv.mjs";

/* ======================= 基础通道 ======================= */

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.MS_PLUGIN_DATA_DIR || join(HERE, "..", ".data");
const HISTORY_FILE = join(DATA_DIR, "history.json");
const SAMPLE_SCRIPT = join(HERE, "sample.ps1");

/** 采样间隔可用环境变量覆盖（调试用），默认 5s */
const INTERVAL_MS = clampInt(process.env.MS_RM_INTERVAL_MS, 1000, 3600000, SAMPLE_MS);
/** 落盘节流：最多每 30s 写一次（外加退出时强制写） */
const FLUSH_MS = 30000;

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

function clampInt(v, min, max, def) {
  const n = Number.parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/* ======================= 运行期状态 ======================= */

const state = createState({ sampleMs: INTERVAL_MS });
/** 最近一次错误（用于界面展示「为什么不刷新」） */
let lastError = null;
/** 采样器是否可用（Windows + 找得到 powershell） */
let platformSupported = process.platform === "win32" && resolvePowerShell() != null;
let lastFlushAt = 0;
let dirty = false;

/** 前台在打开时会先要一次 history，之后靠 tick 增量；status 供界面显示健康度 */
function statusPayload() {
  return {
    supported: platformSupported,
    platform: process.platform,
    sampleMs: INTERVAL_MS,
    topN: state.topN,
    enterN: state.enterN,
    exitN: state.exitN,
    points: state.ticks.length,
    snapshots: state.snapshots,
    lastTickAt: state.ticks.length > 0 ? state.ticks[state.ticks.length - 1].t : null,
    samplerRunning: sampler ? sampler.running : false,
    samplerPid: sampler ? sampler.pid : null,
    restarts: sampler ? sampler.restarts : 0,
    lastError: lastError ? String(lastError.message || lastError) : null,
  };
}

/* ======================= 采样编排 ======================= */

let sampler = null;

function onSnapshot(snap) {
  const r = ingest(state, snap);
  if (!r.ok) {
    // warming / 重复时间戳 / 缺时间戳：静默跳过
    return;
  }
  dirty = true;
  const now = Date.now();
  if (now - lastFlushAt >= FLUSH_MS) {
    lastFlushAt = now;
    flush(false);
  }
  // tick 只带最新一拍（体积小）；前台据此增量拼接趋势
  notify("tick", { point: r.point, status: statusPayload() });
}

function onSamplerError(err) {
  lastError = err instanceof Error ? err : new Error(String(err));
  sendLog("warn", "采样错误: " + lastError.message);
  notify("status", statusPayload());
}

function startSampler() {
  if (!platformSupported) {
    const msg =
      process.platform === "win32"
        ? "未找到 Windows PowerShell，无法采样"
        : "资源监控当前仅支持 Windows";
    lastError = new Error(msg);
    sendLog("warn", msg);
    notify("status", statusPayload());
    return;
  }
  if (sampler) return;
  sampler = createSampler({
    scriptPath: SAMPLE_SCRIPT,
    intervalMs: INTERVAL_MS,
    onSnapshot,
    onError: onSamplerError,
    log: (level, msg) => sendLog(level, msg),
  });
  sampler.start();
}

/* ======================= 持久化 ======================= */

function loadHistory() {
  try {
    const raw = readFileSync(HISTORY_FILE, "utf8");
    const saved = JSON.parse(raw);
    // 先恢复阈值（否则历史点会按默认阈值被裁），再恢复采样点
    if (saved && saved.thresholds) {
      setThresholds(state, saved.thresholds);
    }
    const n = restore(state, saved);
    if (n > 0) sendLog("info", `已恢复 ${n} 个历史采样点`);
  } catch {
    /* 首次运行无文件：忽略 */
  }
}

function flush(force) {
  if (!dirty && !force) return;
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const payload = {
      schema: 1,
      savedAt: Date.now(),
      thresholds: { topN: state.topN, enterN: state.enterN, exitN: state.exitN },
      points: state.ticks,
    };
    const tmp = HISTORY_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(payload), "utf8");
    renameSync(tmp, HISTORY_FILE); // 原子替换，避免半截文件
    dirty = false;
  } catch (e) {
    sendLog("warn", "写历史失败: " + (e?.message || e));
  }
}

/* ======================= 导出 ======================= */

/**
 * 把环形缓冲拼成 CSV。默认导出「整段窗口」（最多 35 分钟）；
 * `minutes` 可指定只导出最近 N 分钟。可选的 `kind`（"system"）导出系统级长表。
 */
function buildCsv(minutes, kind) {
  const now = state.ticks.length > 0 ? state.ticks[state.ticks.length - 1].t : Date.now();
  const m = Number(minutes);
  const cutoff = Number.isFinite(m) && m > 0 ? now - m * 60 * 1000 : 0;
  const points = cutoff > 0 ? state.ticks.filter((p) => p.t >= cutoff) : state.ticks;

  if (kind === "system") {
    return { csv: buildSystemCsv(points), filename: exportFilename("resource-system") };
  }
  // kind === "tracked"：导出趋势线（滞回跟踪）而非当前 TopN
  if (kind === "tracked") {
    const rows = points.map((p) => ({ t: p.t, top: p.trk || { cpu: [], mem: [], up: [] } }));
    return { csv: buildTopCsv(rows), filename: exportFilename("resource-trend") };
  }
  return { csv: buildTopCsv(points), filename: exportFilename("resource-top") };
}

/* ======================= 请求处理 ======================= */

async function handleRequest(id, method, params) {
  switch (method) {
    case "init": {
      sendLog("info", "init: " + JSON.stringify(params || {}));
      sendResult(id, { ok: true });
      startSampler();
      return;
    }

    case "capabilities":
      sendResult(id, {
        supported: platformSupported,
        platform: process.platform,
        sampleMs: INTERVAL_MS,
        windowMs: state.windowMs,
        topN: state.topN,
        enterN: state.enterN,
        exitN: state.exitN,
        maxTrackN: MAX_TRACK_N,
        categories: ["cpu", "mem", "up"],
      });
      return;

    /** 整段历史（前台打开时一次性取回；之后靠 tick 增量） */
    case "history":
      sendResult(id, historyPayload(state));
      return;

    /** 当前健康度与最新一拍 */
    case "status":
      sendResult(id, statusPayload());
      return;

    /** 清空历史（界面「清空」按钮） */
    case "clear": {
      state.ticks.length = 0;
      dirty = true;
      flush(true);
      notify("cleared", { at: Date.now() });
      sendResult(id, { ok: true });
      return;
    }

    /**
     * 动态设置报告阈值（界面上的「进圈 / 出圈」）。
     * enterN：排名 ≤ 该值进入跟踪；exitN：掉到该值之外才移出（须 ≥ enterN）。
     * 改完就地重算跟踪集合与历史点的可见线，并广播给所有打开的前台。
     */
    case "setThresholds": {
      const r = setThresholds(state, {
        topN: params?.topN,
        enterN: params?.enterN,
        exitN: params?.exitN,
      });
      dirty = true;
      flush(true);
      notify("thresholds", { ...r, status: statusPayload() });
      sendResult(id, { ok: true, ...r, status: statusPayload() });
      return;
    }

    /**
     * 终止进程（界面「终止」按钮）。
     * 名称对应程序名下**所有**进程实例；返回每个实例的处置结果。
     * 终止自身后台进程会被拒绝（会切断采样）。
     */
    case "killProcess": {
      const name = String(params?.name ?? "").trim();
      if (!name) throw new Error("缺少程序名");
      const force = params?.force === true;
      const result = await killProcess(name, { force, selfPid: process.pid });
      sendLog("info", `终止 ${name}: ${result.killed}/${result.matched} 个进程成功`);
      sendResult(id, result);
      return;
    }

    /** 列出某程序名对应的进程实例（终止前的确认弹窗用） */
    case "listProcesses": {
      const name = String(params?.name ?? "").trim();
      const list = await listProcesses(name);
      sendResult(id, { name, processes: list });
      return;
    }

    /**
     * 打开某程序的可执行文件所在位置（资源管理器选中该文件）。
     * 成功/失败都以结果对象返回（而非抛错），便于界面给出可读提示：
     * 例如受保护进程拿不到路径、程序已结束、文件已删除。
     */
    case "revealProcessFile": {
      const name = String(params?.name ?? "").trim();
      if (!name) throw new Error("缺少程序名");
      // 优先用采样时已缓存的路径：点击即刻打开，不再冷启动一次枚举（约 2s）
      const cachedPath = programPath(state, name) || "";
      const result = await revealProcessFile(name, { cachedPath });
      sendLog("info", `打开文件位置 ${name}: opened=${result.opened} path=${result.path || "-"}${cachedPath ? " (cached)" : ""}`);
      sendResult(id, result);
      return;
    }

    /**
     * 导出数据。返回 CSV 文本，由前台用 ms.store 之外的途径落盘
     * （前台拿不到任意路径写权限，因此由**前台**触发浏览器下载或复制）。
     * 这里只负责把环形缓冲拼成 CSV。
     */
    case "exportCsv": {
      const { csv, filename } = buildCsv(params?.minutes, params?.kind);
      sendResult(id, { csv, filename, bytes: Buffer.byteLength(csv, "utf8") });
      return;
    }

    /** 手动把采样间隔改成 1..3600 秒（界面设置项，可选） */
    case "setInterval": {
      const secs = clampInt(params?.seconds, 1, 3600, INTERVAL_MS / 1000);
      sendResult(id, {
        ok: true,
        note: "采样间隔在本次进程内生效；永久值请用环境变量 MS_RM_INTERVAL_MS",
        seconds: secs,
      });
      return;
    }

    case "state":
      sendResult(id, { ...statusPayload(), latest: state.ticks[state.ticks.length - 1] || null });
      return;

    default:
      sendError(id, `未知方法: ${method}`);
  }
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
    if (sampler) sampler.stop();
    flush(true);
    rl.close();
    setTimeout(() => process.exit(0), 300);
    return;
  }

  if (id != null) {
    handleRequest(id, method, params).catch((e) => {
      sendError(id, e?.message || String(e));
      sendLog("error", "处理 " + method + " 失败: " + (e?.stack || e));
    });
  }
});

rl.on("close", () => {
  if (sampler) sampler.stop();
  flush(true);
  process.exit(0);
});

process.on("exit", () => {
  // 进程消失时兜底杀掉 powershell，别留孤儿（宿主的 Job Object 也会兜底）
  try {
    if (sampler) sampler.stop();
  } catch {
    /* ignore */
  }
});

loadHistory();
process.stderr.write("[resource-monitor-backend] 已启动，等待 init 握手…\n");
