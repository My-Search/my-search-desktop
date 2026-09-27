/**
 * 截图插件 - 可选后台进程（示例）
 *
 * ============================ 这个进程是干什么的 ============================
 *
 * 它是**可选**的：前台画廊 + 全局热键 + 框选/标注/落盘全部由宿主 Rust 侧完成，
 * 本进程不参与。写在这里是为了演示「插件自带后台进程」这条链路的完整写法，
 * 并且提供一条**不依赖宿主截图能力**的兜底抓屏路径：
 *
 *   - 宿主没有 `screenshot.*` 能力时（老版本宿主），仍可用本进程的
 *     `captureFullScreen` 抓整屏；
 *   - 演示在插件私有目录（MS_PLUGIN_DATA_DIR）里落盘 + 维护 index.json 的
 *     常见做法，含「只留最近 N 天」的清理。
 *
 * ============================ 协议（宿主约定，务必对齐）============================
 *
 * 传输：**stdin/stdout，一行一个 JSON（NDJSON）**，UTF-8。
 *   —— 不要用 console.log 打日志！stdout 是协议通道，混入非 JSON 行会让宿主
 *      解析失败。日志走 stderr，或发 log 通知（见下）。
 *
 * 握手：宿主启动后立刻写一行 init 请求，必须在 startupTimeoutMs 内回包：
 *   收到 {"jsonrpc":"2.0","id":1,"method":"init","params":{...}}
 *   回   {"jsonrpc":"2.0","id":1,"result":{"ok":true}}
 *
 * 请求（宿主 → 插件）：{"jsonrpc":"2.0","id":N,"method":"xxx","params":{...}}
 * 回复（插件 → 宿主）：{"jsonrpc":"2.0","id":N,"result":...}
 *                     {"jsonrpc":"2.0","id":N,"error":{"message":"..."}}
 *
 * 通知（插件 → 宿主，**不带 id**）：
 *   - {"method":"log","params":{"level","message"}} → 写进插件日志文件
 *   - 其它 method → 广播为 Tauri 事件 plugin://notification，
 *     前端用 ms.backend.onNotification(method, fn) 接
 *
 * 退出：宿主会发 {"method":"deactivate"}（通知，无需回包），收到后自行退出；
 *      超时未退宿主会强杀进程树。
 *
 * ============================ 环境变量 ============================
 *
 * 宿主注入（以 MS_PLUGIN_ 开头的是宿主保留，插件不得在清单里占用）：
 *   MS_PLUGIN_PROTOCOL=1
 *   MS_PLUGIN_ID=com.zhuangjie.screenshot
 *   MS_PLUGIN_DATA_DIR=<app_data>/plugin-data/com.zhuangjie.screenshot   ← 私有数据目录
 *   MS_PLUGIN_HOST_VERSION=<宿主版本>
 *
 * 清单 backend.env 里声明的变量也会注入（按用户授权情况）。
 */
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, statSync, writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/* ======================= 基础通道 ======================= */

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.MS_PLUGIN_DATA_DIR || join(HERE, "..", "..", ".data");
const SHOTS_DIR = join(DATA_DIR, "shots");

/** 往 stdout 写一行 JSON —— 这是与宿主的唯一协议通道 */
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function sendError(id, message) {
  send({ jsonrpc: "2.0", id, error: { message: String(message) } });
}
/** 日志通知：宿主会落到 plugin-logs/<id>.log（别用 console.log，那会污染协议） */
function sendLog(level, message) {
  send({ jsonrpc: "2.0", method: "log", params: { level, message: String(message) } });
}

/* ======================= 截图目录 ======================= */

function ensureShotsDir() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  return SHOTS_DIR;
}

/** 扫描截图目录 → 索引数组（时间从新到旧） */
function listShots() {
  ensureShotsDir();
  const out = [];
  for (const name of readdirSync(SHOTS_DIR)) {
    if (!/\.(png|jpg|jpeg|webp)$/i.test(name)) continue;
    const full = join(SHOTS_DIR, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue; // 中途被删：跳过
    }
    if (!st.isFile()) continue;
    out.push({
      relPath: "shots/" + name,
      name,
      size: st.size,
      mtimeMs: st.mtimeMs,
      createdAt: new Date(st.mtimeMs).toISOString(),
    });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/** 删除早于 N 天的截图，返回删除数量 */
function pruneShots(days) {
  ensureShotsDir();
  const cutoff = Date.now() - Math.max(1, Number(days) || 7) * 86400000;
  let removed = 0;
  for (const item of listShots()) {
    if (item.mtimeMs >= cutoff) continue;
    try {
      unlinkSync(join(SHOTS_DIR, item.name));
      removed++;
    } catch {
      // 单个删不掉不影响其它
    }
  }
  return removed;
}

/* ======================= 兜底抓屏（PowerShell）=======================
 *
 * 为什么用 PowerShell：它自带 System.Drawing，不依赖任何 npm 包，
 * 因此在「插件只带一个 .mjs、不 npm install」的约束下最省事。
 * 前台/宿主不可用时的兜底路径，正常流程走宿主的 screenshot_capture（更快、支持多屏）。
 */

function captureViaPowerShell(outFile) {
  const ps1 = join(HERE, "capture.ps1");
  if (!existsSync(ps1)) return Promise.reject(new Error("缺少 capture.ps1"));
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps1, "-Out", outFile],
      { windowsHide: true }
    );
    let err = "";
    child.stderr.on("data", (d) => { err += String(d); });
    child.on("error", (e) => reject(new Error("启动 PowerShell 失败: " + e.message)));
    child.on("close", (code) => {
      if (code === 0 && existsSync(outFile)) resolve(outFile);
      else reject(new Error("抓屏失败（退出码 " + code + "）" + (err ? ": " + err.trim() : "")));
    });
  });
}

/* ======================= 请求分发 ======================= */

async function handleRequest(id, method, params) {
  switch (method) {
    /**
     * 握手 + 初始化。宿主在 startupTimeoutMs 内等这一包，必须回。
     * 同一个方法名也用于前台的显式初始化（幂等）。
     */
    case "init": {
      ensureShotsDir();
      sendLog("info", `后端已启动，数据目录 ${DATA_DIR}`);
      sendResult(id, {
        ok: true,
        dataDir: DATA_DIR,
        shotsDir: SHOTS_DIR,
        hostVersion: process.env.MS_PLUGIN_HOST_VERSION || null,
      });
      return;
    }

    /** 列截图（与宿主 ms.screenshot.list 同形，便于前端互换） */
    case "listShots": {
      sendResult(id, listShots());
      return;
    }

    /** 读取一张截图的 base64（不含 data URL 前缀） */
    case "readShot": {
      const rel = String(params?.relPath || "");
      const item = listShots().find((x) => x.relPath === rel);
      if (!item) throw new Error("截图不存在: " + rel);
      const buf = readFileSync(join(SHOTS_DIR, item.name));
      sendResult(id, { relPath: rel, base64: buf.toString("base64"), size: buf.length });
      return;
    }

    /** 删除一张 */
    case "removeShot": {
      const rel = String(params?.relPath || "");
      const item = listShots().find((x) => x.relPath === rel);
      if (!item) throw new Error("截图不存在: " + rel);
      unlinkSync(join(SHOTS_DIR, item.name));
      sendResult(id, { ok: true });
      return;
    }

    /** 清理超过 N 天的截图 */
    case "pruneShots": {
      sendResult(id, { removed: pruneShots(params?.days ?? 7) });
      return;
    }

    /**
     * 兜底：整屏抓屏并落盘到私有目录（不依赖宿主截图能力）。
     * 成功后发 shots:changed 通知，打开中的前台据此刷新。
     */
    case "captureFullScreen": {
      ensureShotsDir();
      const name = `shot-${Date.now()}-${process.pid.toString(16)}.png`;
      const out = join(SHOTS_DIR, name);
      await captureViaPowerShell(out);
      const st = statSync(out);
      sendResult(id, {
        relPath: "shots/" + name,
        name,
        size: st.size,
        mtimeMs: st.mtimeMs,
        createdAt: new Date(st.mtimeMs).toISOString(),
      });
      // 广播给前台（宿主会把非 log 通知转成 plugin://notification）
      send({ jsonrpc: "2.0", method: "shots:changed", params: { relPath: "shots/" + name } });
      return;
    }

    /** 面板自检用：报告本进程可用的能力 */
    case "capabilities": {
      sendResult(id, {
        powershellFallback: process.platform === "win32",
        platform: process.platform,
        dataDir: DATA_DIR,
        shots: listShots().length,
      });
      return;
    }

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
    // 宿主理论上只发合法 JSON；坏行记日志后忽略，不要让进程崩掉
    sendLog("warn", "收到无法解析的行: " + trimmed.slice(0, 120));
    return;
  }

  const { method, id, params } = msg;

  // deactivate 是**通知**（无 id）：优雅退出
  if (method === "deactivate" && id == null) {
    sendLog("info", "收到 deactivate，正在退出…");
    rl.close();
    setTimeout(() => process.exit(0), 100);
    return;
  }

  if (id != null) {
    handleRequest(id, method, params).catch((e) => {
      sendError(id, "内部错误: " + (e?.message || e));
      sendLog("error", "处理 " + method + " 失败: " + (e?.stack || e));
    });
  }
});

rl.on("close", () => process.exit(0));

// stdout 只允许协议数据；这里的 stderr 会被宿主收进插件日志
process.stderr.write("[screenshot-backend] 已启动，等待 init 握手…\n");
