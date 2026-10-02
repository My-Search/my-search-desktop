/**
 * 资源监控插件的单测。
 *
 * 与仓库既有测试的分工：这里**不启浏览器**（UI 交互另行验证），只钉住三块
 * 最容易悄悄写错、又与「本机是否 Windows」无关的逻辑：
 *
 *   1. 清单合法（否则插件根本装不上）；
 *   2. aggregate.mjs 的纯数学：累计量求差、按程序名聚合、Top-N 排名、
 *      环形缓冲裁剪、持久化恢复，以及边界（首拍基线、计数器回绕/PID 复用、
 *      核数归一、窗口裁剪）；
 *   3. 后端 JSON-RPC：真起一次进程，喂 init 握手 + history/status，
 *      断言协议形态与数据形状正确（不依赖 PowerShell 是否可用）。
 *
 * 用法: node test/resource-monitor.test.mjs
 */
import { readFileSync, mkdtempSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Windows 上动态 import 必须给 file:// URL，直接给绝对路径会被当成 'd:' 协议 */
const importFile = (abs) => import(pathToFileURL(abs).href);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = path.join(root, "plugins", "resource-monitor");
const backendDir = path.join(pluginDir, "backend");

let pass = 0;
let fail = 0;
function ok(cond, name, extra = "") {
  if (cond) {
    pass++;
    console.log("PASS ", name, extra ? ` — ${extra}` : "");
  } else {
    fail++;
    console.log("FAIL ", name, extra ? ` — ${extra}` : "");
  }
}
function eq(actual, expected, name) {
  ok(actual === expected, name, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/* ============================ 1. 清单 ============================ */

console.log("\n--- 清单 ---");

const manifestTs = await importFile(path.join(root, "src", "lib", "plugins", "manifest.ts"));
const permsTs = await importFile(path.join(root, "src", "lib", "plugins", "permissions.ts"));
const manifestText = readFileSync(path.join(pluginDir, "plugin.json"), "utf8");
const parsed = manifestTs.parsePluginManifest(manifestText, permsTs.isKnownPermission);
ok(parsed.ok, "plugin.json 通过宿主清单校验", parsed.ok ? "" : manifestTs.describeManifestErrors(parsed.errors).join("；"));

const manifest = JSON.parse(manifestText);
eq(manifest.id, "com.zhuangjie.resource-monitor", "id 合法");
eq(manifest.contributes.detailView.mode, "inlay", "详情视图模式必须是 inlay");
eq(manifest.contributes.detailView.entry, "ui/detail.html", "detailView.entry 指向界面");
eq(manifest.contributes.detailView.script, "ui/index.js", "detailView.script 指向脚本");
eq(manifest.contributes.searchItem.keyword, "资源监控", "搜索关键词 = 资源监控");
ok(manifest.permissions.includes("backend.spawn"), "声明了 backend.spawn（拉起采样进程必需）");
ok(manifest.permissions.includes("ui.inlay"), "声明了 ui.inlay（内嵌界面）");
eq(manifest.backend.entry, "backend/run.cmd", "backend.entry 指向启动器");
eq(manifest.backend.autostart, "always", "开机自启常驻采样");

/* ============================ 2. aggregate 纯逻辑 ============================ */

console.log("\n--- aggregate 纯逻辑 ---");

const agg = await importFile(path.join(backendDir, "aggregate.mjs"));

/** 造一份快照（procs 项按 [pid,name,k,u,ws,other,path] 紧凑传参；path 可省） */
function snap(t, cores, procs, opts = {}) {
  return {
    t,
    cores,
    mem: { totalKB: opts.totalKB ?? 16 * 1024 * 1024, freeKB: opts.freeKB ?? 8 * 1024 * 1024 },
    net: { sentTotal: opts.sentTotal ?? 0, recvTotal: opts.recvTotal ?? 0 },
    procs: procs.map(([pid, name, k, u, ws, other, path]) => ({ pid, name, k, u, ws, other, path: path ?? "" })),
  };
}

// --- 2.0 保留窗口常量 = 35 分钟 ---
{
  eq(agg.SAMPLE_MS, 5000, "采样周期 = 5 秒");
  eq(agg.WINDOW_MS, 35 * 60 * 1000, "保留窗口 = 35 分钟");
  eq(agg.MAX_TICKS, 420, "环形缓冲上限 = 35分/5秒 = 420 拍");
  const st = agg.createState();
  eq(st.windowMs, 35 * 60 * 1000, "createState 默认窗口 = 35 分钟");
}

// --- 2.1 首拍只建基线 ---
{
  const st = agg.createState();
  const r1 = agg.ingest(st, snap(1000, 4, [[1, "a", 0, 0, 1000, 0]]));
  eq(r1.ok, false, "首拍不产出数据点（只建基线）");
  eq(r1.reason, "warming", "首拍原因是 warming");
}

// --- 2.2 CPU%：ΔCPU秒 / Δt / 核数 * 100 ---
{
  const st = agg.createState();
  // t=0：进程 a 用了 0 个 CPU tick；t=5000(5s)：用了 4 核 × 2s = 2s CPU
  // 期望 CPU% = 2s / 5s / 4核 * 100 = 10%
  const TICKS = 1e7; // 每秒 1e7 个 100ns tick
  agg.ingest(st, snap(1000, 4, [[1, "a", 0, 0, 1000, 0]]));
  const r = agg.ingest(st, snap(6000, 4, [[1, "a", 1 * TICKS, 1 * TICKS, 1000, 0]]));
  ok(r.ok, "第二拍产出数据点");
  eq(r.point.top.cpu[0][0], "a", "CPU 榜首是 a");
  eq(r.point.top.cpu[0][1], 10, "CPU% = 10（2s/5s/4核）");
  eq(r.point.s[0], 10, "系统 CPU% ≈ 10");
}

// --- 2.3 单核满载在 4 核机上是 25% ---
{
  const st = agg.createState();
  const TICKS = 1e7;
  agg.ingest(st, snap(1000, 4, [[1, "busy", 0, 0, 1000, 0]]));
  const r = agg.ingest(st, snap(6000, 4, [[1, "busy", 5 * TICKS, 0, 1000, 0]])); // 5s CPU / 5s / 4核
  eq(r.point.top.cpu[0][1], 25, "单核跑满 5 秒 = 25%（4 核口径）");
}

// --- 2.4 按程序名聚合 + 实例数 ---
{
  const st = agg.createState();
  const TICKS = 1e7;
  const p = [
    [1, "chrome", 0, 0, 1000, 0],
    [2, "chrome", 0, 0, 2000, 0],
    [3, "code", 0, 0, 500, 0],
  ];
  agg.ingest(st, snap(1000, 2, p));
  const p2 = [
    [1, "chrome", TICKS, 0, 1000, 0],   // 1s CPU
    [2, "chrome", TICKS, 0, 2000, 0],   // 1s CPU
    [3, "code", 0, 0, 500, 0],
  ];
  const r = agg.ingest(st, snap(6000, 2, p2));
  const chrome = r.point.top.cpu.find((e) => e[0] === "chrome");
  const chromeMem = r.point.top.mem.find((e) => e[0] === "chrome");
  const code = r.point.top.mem.find((e) => e[0] === "code");
  eq(chrome[2], 2, "同名多进程合并，实例数 = 2");
  eq(chrome[1], 20, "chrome 合并 CPU% = 20（各 1s/5s/2核=10%）");
  eq(chromeMem[1], 3000, "内存按程序名求和 = 3000 字节（1000+2000）");
  eq(code[1], 500, "单进程程序内存 = 其工作集 500 字节");
}

// --- 2.5 内存首拍即可排名（绝对量，不需要差值）---
{
  const st = agg.createState();
  const TICKS = 1e7;
  agg.ingest(st, snap(1000, 2, [[1, "big", 0, 0, 999, 0]]));
  const r = agg.ingest(st, snap(6000, 2, [[1, "big", TICKS, 0, 12345, 0]]));
  eq(r.point.top.mem[0][0], "big", "内存榜列出 big");
  eq(r.point.top.mem[0][1], 12345, "内存 = 当前工作集（非差值）");
}

// --- 2.5b 采集可执行路径（供「位置」按钮即时打开）---
{
  // readProcs 读出 path（缺省为空串）
  const procs = agg.readProcs(snap(1000, 2, [
    [1, "chrome.exe", 0, 0, 1, 0, "C:\\A\\chrome.exe"],
    [2, "chrome.exe", 0, 0, 1, 0, "C:\\A\\chrome.exe"],
    [3, "chrome.exe", 0, 0, 1, 0, "C:\\B\\chrome.exe"],
    [4, "svc.exe", 0, 0, 1, 0, ""],
    [5, "nopath.exe", 0, 0, 1, 0],
  ]));
  eq(procs.get(1).path, "C:\\A\\chrome.exe", "readProcs 读出 ExecutablePath");
  eq(procs.get(4).path, "", "受保护进程 path 为空");
  eq(procs.get(5).path, "", "快照缺 path 时兜底为空串");

  // collectPaths：同名多实例取出现次数最多的路径；空路径不参与
  const paths = agg.collectPaths(procs);
  eq(paths.get("chrome.exe"), "C:\\A\\chrome.exe", "多实例取出现次数最多的路径");
  eq(paths.has("svc.exe"), false, "全为空路径的程序不收录");
  eq(paths.has("nopath.exe"), false, "缺失路径的程序不收录");

  // 并列时取字典序，保证稳定
  const tie = agg.collectPaths(agg.readProcs(snap(0, 1, [
    [1, "x.exe", 0, 0, 1, 0, "C:\\B\\x.exe"],
    [2, "x.exe", 0, 0, 1, 0, "C:\\A\\x.exe"],
  ])));
  eq(tie.get("x.exe"), "C:\\A\\x.exe", "并列时取字典序（结果稳定）");

  // ingest 后 programPath 可取到；未知程序 / 空名返回 null
  const st = agg.createState();
  agg.ingest(st, snap(1000, 2, [[1, "chrome.exe", 0, 0, 1, 0, "C:\\A\\chrome.exe"]]));
  eq(agg.programPath(st, "chrome.exe"), "C:\\A\\chrome.exe", "ingest 后 programPath 取到路径");
  eq(agg.programPath(st, "ghost.exe"), null, "未知程序 → null");
  eq(agg.programPath(st, ""), null, "空名 → null");

  // 首拍（只建基线、不产出数据点）也应已经缓存路径 → 榜单出现即可点「位置」
  const st2 = agg.createState();
  const r1 = agg.ingest(st2, snap(1000, 2, [[1, "early.exe", 0, 0, 1, 0, "C:\\E\\early.exe"]]));
  eq(r1.ok, false, "首拍仍只建基线");
  eq(agg.programPath(st2, "early.exe"), "C:\\E\\early.exe", "首拍即缓存路径（无需等下一拍）");

  // 程序退出后，路径缓存随下一拍刷新而移除
  const r2 = agg.ingest(st2, snap(6000, 2, [[2, "other.exe", 1e7, 0, 1, 0, "C:\\O\\other.exe"]]));
  eq(r2.ok, true, "第二拍产出数据点");
  eq(agg.programPath(st2, "early.exe"), null, "退出后的程序不再有路径缓存");
  eq(agg.programPath(st2, "other.exe"), "C:\\O\\other.exe", "仍在运行的程序路径已更新");
}

// --- 2.6 上传：ΔOtherTransferCount / Δt ---
{
  const st = agg.createState();
  agg.ingest(st, snap(1000, 2, [[1, "up", 0, 0, 0, 0]]));
  const r = agg.ingest(st, snap(6000, 2, [[1, "up", 0, 0, 0, 50000]])); // 50KB / 5s
  eq(r.point.top.up[0][0], "up", "上传榜首是 up");
  eq(r.point.top.up[0][1], 10000, "上传 = 10000 B/s（50KB/5s）");
}

// --- 2.7 计数器回绕 / PID 复用（负差值夹到 0）---
{
  const st = agg.createState();
  agg.ingest(st, snap(1000, 1, [[1, "x", 100 * 1e7, 0, 0, 100000]]));
  const r = agg.ingest(st, snap(6000, 1, [[1, "x", 10 * 1e7, 0, 0, 50000]])); // 变小了
  ok(r.ok, "回绕拍仍产出数据点");
  eq(r.point.top.cpu.length, 0, "负 CPU 差值不进榜");
  eq(r.point.top.up.length, 0, "负上传差值不进榜");
}

// --- 2.8 首个出现的进程（上一拍没有）差值为 0 ---
{
  const st = agg.createState();
  agg.ingest(st, snap(1000, 1, [[1, "old", 0, 0, 100, 0]]));
  const r = agg.ingest(st, snap(6000, 1, [[1, "old", 0, 0, 100, 0], [2, "new", 1e7, 0, 999999, 1e7]]));
  const nwCpu = r.point.top.cpu.find((e) => e[0] === "new");
  eq(nwCpu, undefined, "新进程首拍不计 CPU（无基线，差值为 0）");
  const nwMem = r.point.top.mem.find((e) => e[0] === "new");
  ok(nwMem && nwMem[1] === 999999, "但新进程的内存照常计入（绝对值）");
}

// --- 2.9 非单调时间戳被跳过 ---
{
  const st = agg.createState();
  agg.ingest(st, snap(6000, 1, [[1, "a", 0, 0, 0, 0]]));
  const r = agg.ingest(st, snap(1000, 1, [[1, "a", 1e7, 0, 0, 1e7]]));
  eq(r.ok, false, "时间戳回拨的拍被跳过");
  eq(r.reason, "non-monotonic", "原因是 non-monotonic");
}

// --- 2.10 Top-N 截断 ---
{
  const st = agg.createState({ topN: 3 });
  const TICKS = 1e7;
  const make = (dt) => [1, 2, 3, 4, 5].map((i) => [i, "p" + i, dt * TICKS * i, 0, 0, 0]);
  agg.ingest(st, snap(1000, 1, make(0)));
  const r = agg.ingest(st, snap(6000, 1, make(1)));
  eq(r.point.top.cpu.length, 3, "CPU 榜被截断到 Top 3");
  eq(r.point.top.cpu[0][0], "p5", "榜首是 CPU 最多的 p5");
}

// --- 2.11 环形缓冲按窗口 / 上限裁剪 ---
{
  const st = agg.createState({ sampleMs: 1000, windowMs: 5000, maxTicks: 99, topN: 3 });
  const TICKS = 1e7;
  for (let i = 0; i <= 10; i++) {
    agg.ingest(st, snap((i + 1) * 1000, 1, [[1, "a", i * TICKS, 0, 0, 0]]));
  }
  // 最后一拍 t=10000，窗口 5000ms → 只保留 t>=5000 的点
  ok(st.ticks.length <= 6, `超出 1 小时窗口的旧点被裁掉（剩 ${st.ticks.length}）`);
  ok(st.ticks[0].t >= 5000, "最老的点不早于窗口边界");
}

// --- 2.12 historyPayload 形状 ---
{
  const st = agg.createState({ sampleMs: 1000 });
  const TICKS = 1e7;
  agg.ingest(st, snap(1000, 1, [[1, "a", 0, 0, 0, 0]]));
  agg.ingest(st, snap(6000, 1, [[1, "a", TICKS, 0, 10, TICKS]]));
  const h = agg.historyPayload(st, 9999);
  ok(Array.isArray(h.points) && h.points.length === 1, "historyPayload.points 是数组");
  eq(h.latest.t, 6000, "latest 指向最后一拍");
  eq(h.meta.points, 1, "meta.points 与实际一致");
  eq(h.meta.sampleMs, 1000, "meta.sampleMs 透传");
}

// --- 2.13 持久化恢复（含脏数据防御）---
{
  const st = agg.createState({ sampleMs: 1000 });
  const n = agg.restore(st, {
    points: [
      { t: 2000, s: [1, 2, 3, 4, 5], top: { cpu: [["b", 5, 1]], mem: [], up: [] } },
      { t: 1000, s: [1, 2, 3, 4, 5], top: { cpu: [["a", 9, 1]], mem: [], up: [] } }, // 乱序
      { t: 0, s: [], top: {} },                                                     // 缺时间戳 → 丢弃
      { t: 3000, s: [1, 2, 3, 4, 5], top: { cpu: [["c", 1, 0]], mem: [["x", 1, 0]], up: [["", 9, 1]] } },
      null,
      "garbage",
    ],
  });
  eq(n, 3, "恢复 3 个有效点（丢弃垃圾项）");
  eq(st.ticks[0].t, 1000, "恢复后按时间升序");
  eq(st.ticks[2].t, 3000, "最后一点是 t=3000");
  // 实例数兜底为 >= 1；空名字被过滤
  const c = st.ticks[2].top.cpu[0];
  eq(c[2], 1, "实例数 0 兜底为 1");
  const upNames = st.ticks[2].top.up.map((e) => e[0]);
  ok(upNames.indexOf("") < 0, "空名字的程序被过滤");
}

// --- 2.14 CPU 近乎 0 的噪声不进榜 ---
{
  const st = agg.createState();
  agg.ingest(st, snap(1000, 1, [[1, "idle", 0, 0, 0, 0]]));
  const r = agg.ingest(st, snap(6000, 1, [[1, "idle", 1, 0, 0, 0]])); // 1 tick ≈ 1e-7 s
  eq(r.point.top.cpu.length, 0, "CPU 低于阈值不进榜（避免噪声）");
}

/* ============================ 2b. 滞回（进圈 / 出圈） ============================ */

console.log("\n--- 滞回 Top-N（进圈 10 / 出圈 15） ---");

/**
 * 按「每拍增量」喂数据：CPU 计数器是**累计量**且必须单调递增，
 * 所以这里把每拍的速率累加进累积计数，模拟真实内核计数器。
 *
 * `cum` 可跨多次调用复用（多次 feedRates 时需要传同一个 Map，
 * 否则计数器会被重置 —— 这在真实采样里不会发生）。
 * @param {Array<{t:number, rate:Object<string,number>, cores?:number}>} ticks
 * @param {Map<string,number>} [cum] 累计计数（复用请显式传入）
 */
function feedRates(st, ticks, cum = new Map()) {
  const TICKS = 1e7;
  let last = null;
  for (const tk of ticks) {
    for (const [name, r] of Object.entries(tk.rate || {})) {
      cum.set(name, (cum.get(name) || 0) + Math.round(r * TICKS));
    }
    const procs = [];
    let pid = 1;
    for (const [name, cpuTicks] of cum) {
      procs.push([pid++, name, 0, cpuTicks, 0, 0]);
    }
    last = agg.ingest(st, snap(tk.t, tk.cores || 1, procs));
  }
  return last;
}
/** names → {name: rate} */
function rateMap(names, fn) {
  const o = {};
  names.forEach((n, i) => (o[n] = fn(n, i)));
  return o;
}

// --- 2b.1 默认阈值 = 进 10 / 出 15 ---
{
  const st = agg.createState();
  eq(st.enterN, 10, "默认进圈 = 10");
  eq(st.exitN, 15, "默认出圈 = 15");
}

// --- 2b.2 进圈：排名 11 的程序不能进入跟踪 ---
{
  const st = agg.createState(); // enter 10 / exit 15
  const N = 20;
  const names = []; for (let i = 0; i < N; i++) names.push("p" + i);
  const r = feedRates(st, [
    { t: 1000, rate: rateMap(names, () => 0) },        // 建基线
    { t: 6000, rate: rateMap(names, (_, i) => N - i) }, // p0 第 1 … p19 第 20
  ]);
  const trk = r.point.trk.cpu.map((e) => e[0]);
  ok(trk.indexOf("p0") >= 0, "第 1 名进入跟踪");
  ok(trk.indexOf("p9") >= 0, "第 10 名进入跟踪");
  ok(trk.indexOf("p10") < 0, "第 11 名**不**进入跟踪（进圈只看 10）");
}

// --- 2b.3 出圈：已在跟踪的程序，掉到 ~12 名仍保留，掉到 15 名之外才移出并清掉旧段 ---
{
  const st = agg.createState(); // enter 10 / exit 15
  const N = 20;
  const names = []; for (let i = 0; i < N; i++) names.push("p" + i);
  const cum = new Map(); // 跨多次调用复用，模拟单调递增的内核计数器
  const r = feedRates(st, [
    { t: 1000, rate: rateMap(names, () => 0) },
    // 拍2：p0 独大 → 第 1 名 → 进入跟踪
    { t: 6000, rate: rateMap(names, (n) => (n === "p0" ? 1000 : 0)) },
    // 拍3：其余程序排成 198..161，p0 插到第 12 名（176.5，仍 ≤ 出圈 15）→ 应保留
    { t: 11000, rate: rateMap(names, (n, i) => (n === "p0" ? 176.5 : 198 - i * 2)) },
  ], cum);
  ok(r.point.trk.cpu.map((e) => e[0]).indexOf("p0") >= 0, "掉到第 12 名仍在跟踪（≤ 出圈 15）");
  const before = st.ticks.filter((p) => p.trk.cpu.some((e) => e[0] === "p0")).length;
  ok(before >= 2, "掉出前历史里已有 p0 的旧段");

  // 拍4：p0 明显被挤到 15 名之外（有值但排名 > 15）→ 移出并**清掉旧段**
  const r2 = feedRates(st, [
    { t: 16000, rate: rateMap(names, (n, i) => (n === "p0" ? 0.5 : 400 - i * 2)) },
  ], cum);
  ok(r2.point.trk.cpu.map((e) => e[0]).indexOf("p0") < 0, "掉出 15 名后移出跟踪");
  ok(!st.tracked.cpu.has("p0"), "跟踪集合里不再有 p0");
  eq(st.ticks.filter((p) => p.trk.cpu.some((e) => e[0] === "p0")).length, 0, "旧段被清理（历史里 0 条 p0）");

  // 拍5：p0 又冲上第一 → 从全新一段开始，历史里只有这 1 条新记录
  feedRates(st, [
    { t: 21000, rate: rateMap(names, (n) => (n === "p0" ? 1000 : 0)) },
  ], cum);
  eq(st.ticks.filter((p) => p.trk.cpu.some((e) => e[0] === "p0")).length, 1, "重新上榜只留新段（1 条）");
}

// --- 2b.3b 占用为 0 / 短暂无数据不算掉出：线连续保留 ---
{
  const st = agg.createState();
  const N = 8;
  const names = []; for (let i = 0; i < N; i++) names.push("p" + i);
  // p0 先第 1 名进圈
  const cum = new Map();
  feedRates(st, [{ t: 1000, rate: rateMap(names, () => 0) }], cum);
  feedRates(st, [{ t: 6000, rate: rateMap(names, (n) => (n === "p0" ? 1000 : 0)) }], cum);
  ok(st.tracked.cpu.has("p0"), "p0 已进圈");
  // 之后 p0 占用归 0（其余程序仍在跑）：连喂几拍，p0 应始终留在跟踪里（值为 0）
  const trk = [];
  for (let k = 1; k <= 4; k++) {
    for (const n of names) cum.set(n, cum.get(n) + Math.round((n === "p0" ? 0 : 1000 + names.indexOf(n)) * 1e7));
    const procs = names.map((n, i) => [i + 1, n, 0, cum.get(n), 0, 0]);
    const r = agg.ingest(st, snap(6000 + k * 5000, 1, procs));
    trk.push(r.point.trk.cpu.some((e) => e[0] === "p0"));
  }
  ok(trk.every(Boolean), "占用归 0 的连续 4 拍里 p0 一直保留（线不断）");
  const p0val = st.ticks[st.ticks.length - 1].trk.cpu.find((e) => e[0] === "p0");
  eq(p0val && p0val[1], 0, "保留期间值为 0（画到谷底）");

  // 关键回归：即使占用归 0 **远超宽限拍数**，只要进程仍在快照里（活着），就绝不能断线
  for (let k = 5; k <= agg.TRACK_GRACE_TICKS + 5; k++) {
    for (const n of names) cum.set(n, cum.get(n) + Math.round((n === "p0" ? 0 : 1000 + names.indexOf(n)) * 1e7));
    const procs = names.map((n, i) => [i + 1, n, 0, cum.get(n), 0, 0]);
    const r = agg.ingest(st, snap(6000 + k * 5000, 1, procs));
    if (!r.point.trk.cpu.some((e) => e[0] === "p0")) { ok(false, "空闲超过宽限后仍应保留（不该断线）"); break; }
  }
  ok(st.tracked.cpu.has("p0"), "长时间空闲（进程仍在）后 p0 依旧在跟踪集合里");
  eq(st.ticks.filter((p) => p.trk.cpu.some((e) => e[0] === "p0")).length > 10, true, "空闲期全部保留为连续记录");
}

// --- 2b.3c 长时间无数据（进程退出）→ 超过宽限后移出并清理 ---
{
  const st = agg.createState();
  const N = 8;
  const names = []; for (let i = 0; i < N; i++) names.push("p" + i);
  const cum = new Map();
  feedRates(st, [{ t: 1000, rate: rateMap(names, () => 0) }], cum);
  feedRates(st, [{ t: 6000, rate: rateMap(names, (n) => (n === "p0" ? 1000 : 0)) }], cum);
  ok(st.tracked.cpu.has("p0"), "p0 已进圈");
  // p0 的进程彻底消失（快照里不再有 p0）；其余程序继续累加
  for (let k = 1; k <= agg.TRACK_GRACE_TICKS + 1; k++) {
    for (const n of names.slice(1)) cum.set(n, cum.get(n) + Math.round((1000 + names.indexOf(n)) * 1e7));
    agg.ingest(st, snap(6000 + k * 5000, 1, names.slice(1).map((n, i) => [i + 2, n, 0, cum.get(n), 0, 0])));
  }
  ok(!st.tracked.cpu.has("p0"), "超过宽限拍数后 p0 被移出跟踪");
  eq(st.ticks.filter((p) => p.trk.cpu.some((e) => e[0] === "p0")).length, 0, "p0 的旧段被清理");
}

// --- 2b.4 动态改阈值：收紧出圈 → 已跟踪的弱项被移出 ---
{
  const st = agg.createState(); // 默认 exit 15
  const N = 20;
  const names = []; for (let i = 0; i < N; i++) names.push("p" + i);
  const r = feedRates(st, [
    { t: 1000, rate: rateMap(names, () => 0) },
    // p12 先独大 → 第 1 名 → 进入跟踪
    { t: 6000, rate: rateMap(names, (n) => (n === "p12" ? 1000 : 0)) },
    // 把 p12 压到第 13 名（137，介于第 12 名 140 与第 13 名 135 之间）——默认出圈 15 下仍保留
    { t: 11000, rate: rateMap(names, (n, i) => (n === "p12" ? 137 : 200 - i * 5)) },
  ]);
  ok(r.point.trk.cpu.map((e) => e[0]).indexOf("p12") >= 0, "p12 在第 13 名时仍被跟踪（≤ 出圈 15）");
  // 收紧出圈到 12：p12 当前第 13 名 > 12 → 被移出
  const th = agg.setThresholds(st, { enterN: 10, exitN: 12 });
  eq(th.exitN, 12, "出圈已改为 12");
  ok(!st.tracked.cpu.has("p12"), "收紧出圈后 p12 被移出跟踪");
}

// --- 2b.5 setThresholds 夹紧：出圈不得小于进圈 ---
{
  const st = agg.createState();
  const r = agg.setThresholds(st, { enterN: 20, exitN: 5 });
  eq(r.exitN, 20, "出圈被夹到 ≥ 进圈");
  eq(r.enterN, 20, "进圈 = 20");
}

// --- 2b.6 阈值随持久化恢复（save → restore）---
{
  const st = agg.createState();
  agg.setThresholds(st, { enterN: 7, exitN: 9 });
  const payload = { thresholds: { topN: 7, enterN: 7, exitN: 9 }, points: [] };
  const st2 = agg.createState();
  agg.setThresholds(st2, payload.thresholds);
  agg.restore(st2, payload);
  eq(st2.enterN, 7, "恢复后进圈 = 7");
  eq(st2.exitN, 9, "恢复后出圈 = 9");
}

/* ============================ 2c. CSV 导出 ============================ */

console.log("\n--- CSV 导出 ---");

const csvMod = await importFile(path.join(backendDir, "export-csv.mjs"));

{
  eq(csvMod.csvCell('a,b'), '"a,b"', "含逗号的单元格被引号包裹");
  eq(csvMod.csvCell('say "hi"'), '"say ""hi"""', "引号被翻倍转义");
  eq(csvMod.csvCell("plain"), "plain", "普通文本不加引号");
}

{
  const points = [
    { t: 1700000000000, s: [10, 100, 200, 1, 2], top: { cpu: [["chrome", 43.6, 5]], mem: [["chrome", 3000, 5]], up: [] }, trk: { cpu: [["chrome", 43.6]], mem: [["chrome", 3000]], up: [] } },
    { t: 1700000005000, s: [20, 150, 200, 3, 4], top: { cpu: [["chrome", 50, 5]], mem: [], up: [["node", 999, 1]] }, trk: { cpu: [["chrome", 50]], mem: [], up: [["node", 999]] } },
  ];
  const csv = csvMod.buildTopCsv(points);
  const lines = csv.replace(/^\uFEFF/, "").trim().split("\r\n");
  eq(lines[0], "time,iso,category,program,value,instances", "Top CSV 表头正确");
  // 第 2 点应有 2 行（cpu chrome + up node）
  const dataLines = lines.slice(1);
  eq(dataLines.length, 4, "Top CSV 行数 = 各拍各榜条目之和（2+1+1）");
  ok(dataLines[0].includes(",cpu,chrome,43.6,5"), "含 cpu/chrome/43.6/5 行");
  ok(dataLines.some((l) => l.includes(",up,node,999,1")), "含 up/node 行");

  const sys = csvMod.buildSystemCsv(points);
  const sl = sys.replace(/^\uFEFF/, "").trim().split("\r\n");
  eq(sl[0], "time,iso,cpu_pct,mem_used_bytes,mem_total_bytes,net_up_Bps,net_down_Bps", "System CSV 表头带单位");
  ok(sl[1].includes(",10,100,200,1,2"), "系统行数值正确");

  // 趋势导出（用 trk）
  const trkRows = points.map((p) => ({ t: p.t, top: p.trk }));
  const trkCsv = csvMod.buildTopCsv(trkRows);
  ok(trkCsv.includes(",chrome,"), "趋势 CSV 用 trk 数据");

  // BOM 让 Excel 正确识别 UTF-8
  ok(csv.charCodeAt(0) === 0xfeff, "CSV 带 UTF-8 BOM");

  const fn = csvMod.exportFilename("resource-top", new Date(2026, 8, 30, 18, 5, 9).getTime());
  ok(/^resource-top-2026\d{4}-180509\.csv$/.test(fn), "导出文件名含时间戳", fn);
}

/* ============================ 2d. 进程终止（注入假 exec） ============================ */

console.log("\n--- 进程终止 ---");

const procMod = await importFile(path.join(backendDir, "processes.mjs"));

/** 假 spawn：记录 taskkill 调用，返回成功退出码 */
function fakeSpawn(record) {
  return (exe, args, opts) => {
    record.push({ exe: String(exe), args, env: opts && opts.env });
    const listeners = {};
    const child = {
      stdout: { on: () => {}, setEncoding: () => {} },
      stderr: { on: () => {}, setEncoding: () => {} },
      on: (ev, fn) => { listeners[ev] = fn; return child; },
      kill: () => {},
      pid: 999,
    };
    // 立刻触发 exit(0)
    setTimeout(() => listeners.exit && listeners.exit(0), 0);
    return child;
  };
}

/**
 * 假 spawn：记录调用，并在成功时把该 pid 从「存活集合」移除。
 * 这样 `aliveFn: (pid) => alive.has(pid)` 就能模拟「taskkill 生效后进程消失」。
 */
function fakeKillSpawn(record, alive) {
  return (exe, args, opts) => {
    record.push({ exe: String(exe), args, env: opts && opts.env });
    const pid = Number(args[args.indexOf("/PID") + 1]);
    const listeners = {};
    const child = {
      stdout: { on: () => {}, setEncoding: () => {} },
      stderr: { on: () => {}, setEncoding: () => {} },
      on: (ev, fn) => { listeners[ev] = fn; return child; },
      kill: () => {},
      pid: 999,
    };
    setTimeout(() => { alive.delete(pid); listeners.exit && listeners.exit(0); }, 0);
    return child;
  };
}

{
  // killProcess 用注入的 listFn 提供实例，spawnFn 记录 taskkill
  const calls = [];
  const alive = new Set([111, 222]);
  const r = await procMod.killProcess("chrome.exe", {
    selfPid: 555,
    spawnFn: fakeKillSpawn(calls, alive),
    listFn: async () => [
      { pid: 111, name: "chrome.exe" },
      { pid: 222, name: "chrome.exe" },
    ],
    aliveFn: (pid) => alive.has(pid),
  });
  eq(r.matched, 2, "匹配到 2 个实例");
  eq(r.killed, 2, "成功终止 2 个");
  eq(calls.length, 2, "调用了 2 次 taskkill");
  ok(calls[0].args.includes("/PID") && calls[0].args.includes("111"), "taskkill 带 /PID 111");
  ok(calls[0].args.includes("/F") && calls[0].args.includes("/T"), "默认强制并带上子进程树");
}

{
  // 自身进程必须跳过
  const calls = [];
  const alive = new Set([555, 777]);
  const r = await procMod.killProcess("node.exe", {
    selfPid: 555,
    spawnFn: fakeKillSpawn(calls, alive),
    listFn: async () => [
      { pid: 555, name: "node.exe" },
      { pid: 777, name: "node.exe" },
    ],
    aliveFn: (pid) => alive.has(pid),
  });
  eq(r.skipped.length, 1, "自身进程被跳过");
  eq(r.killed, 1, "另一个实例被终止");
  eq(calls.length, 1, "只对非自身实例调 taskkill");
  eq(calls[0].args.includes("555"), false, "绝不 taskkill 自身 pid");
}

{
  // taskkill 失败且进程仍在 → 进 failed，不抛
  const spawnFn = (exe, args, opts) => {
    const listeners = {};
    const child = {
      stdout: { on: () => {} }, stderr: { on: (ev, fn) => { if (ev === "data") fn("access denied"); } },
      on: (ev, fn) => { listeners[ev] = fn; return child; }, kill: () => {},
    };
    setTimeout(() => listeners.exit && listeners.exit(1), 0); // 非 0 退出
    return child;
  };
  const listFn = async () => [{ pid: 42, name: "x.exe" }];
  const r = await procMod.killProcess("x.exe", { selfPid: 1, spawnFn, listFn, aliveFn: () => true });
  eq(r.killed, 0, "失败时不计数为成功");
  eq(r.failed.length, 1, "失败项进入 failed");
  ok(/access denied/.test(r.failed[0].error), "带上 taskkill 的错误信息");
}

{
  // 程序名为空 / 无匹配
  let threw = false;
  try { await procMod.killProcess("", {}); } catch { threw = true; }
  ok(threw, "空程序名抛错");
  const r = await procMod.killProcess("ghost.exe", { selfPid: 1, spawnFn: fakeSpawn([]), listFn: async () => [] });
  eq(r.matched, 0, "无匹配时 matched = 0");
  eq(r.killed, 0, "无匹配时 killed = 0");
}

{
  // 已退出的实例不算失败：杀前探活就发现不存在 → skipped
  const calls = [];
  const alive = new Set([222]); // 111 已消失
  const r = await procMod.killProcess("chrome.exe", {
    spawnFn: fakeKillSpawn(calls, alive),
    listFn: async () => [
      { pid: 111, name: "chrome.exe" },
      { pid: 222, name: "chrome.exe" },
    ],
    aliveFn: (pid) => alive.has(pid),
  });
  eq(r.killed, 1, "存活的实例被终止");
  eq(r.failed.length, 0, "已退出的实例不算失败");
  eq(r.skipped.length, 1, "已退出的实例进入 skipped");
  ok(/已不再运行/.test(r.skipped[0].reason), "跳过原因说明进程已不在");
  eq(calls.length, 1, "只对存活的实例调 taskkill");
}

{
  // 成败以探活为准：taskkill 退出码非 0，但进程确实没了 → 记为成功（同名父子的常见情形）
  const spawnFn = (exe, args, opts) => {
    const listeners = {};
    const child = {
      stdout: { on: () => {} },
      stderr: { on: (ev, fn) => { if (ev === "data") fn(Buffer.from("ERROR: not found", "utf8")); } },
      on: (ev, fn) => { listeners[ev] = fn; return child; },
      kill: () => {},
    };
    setTimeout(() => listeners.exit && listeners.exit(128), 0); // 非 0 退出
    return child;
  };
  let probes = 0;
  const r = await procMod.killProcess("x.exe", {
    spawnFn,
    listFn: async () => [{ pid: 42, name: "x.exe" }],
    aliveFn: () => probes++ === 0, // 杀前活着，杀后消失
  });
  eq(r.killed, 1, "进程确实消失 → 计为成功，即便 taskkill 非 0 退出");
  eq(r.failed.length, 0, "不产生假失败");
}

{
  // taskkill 失败且进程仍在 → failed，且错误文本按 OEM 代码页解码（非乱码）
  const spawnFn = (exe, args, opts) => {
    const listeners = {};
    const child = {
      stdout: { on: () => {} },
      // 「拒绝访问」的 GBK(936) 字节：若按 UTF-8 解码会变成 U+FFFD 乱码
      stderr: { on: (ev, fn) => { if (ev === "data") fn(Buffer.from([190, 220, 190, 248, 183, 195, 206, 202])); } },
      on: (ev, fn) => { listeners[ev] = fn; return child; },
      kill: () => {},
    };
    setTimeout(() => listeners.exit && listeners.exit(1), 0);
    return child;
  };
  const r = await procMod.killProcess("x.exe", {
    spawnFn,
    listFn: async () => [{ pid: 42, name: "x.exe" }],
    aliveFn: () => true, // 杀不掉，仍在
  });
  eq(r.killed, 0, "杀不掉时不计数为成功");
  eq(r.failed.length, 1, "失败项进入 failed");
  eq(r.failed[0].error, "拒绝访问", "GBK 输出解码为可读中文（非乱码）");
}

{
  // 多行 taskkill 输出被压成一行（避免 toast 刷屏），且保留「原因」行
  // 下面两组字节均为 GBK(936) 编码的真实 taskkill 文案，验证「解码 + 压缩」两步都对
  const GBK_LINE1 = Buffer.from([206, 222, 183, 168, 214, 213, 214, 185, 32, 80, 73, 68, 32, 52, 50, 32, 40, 202, 244, 211, 218, 32, 80, 73, 68, 32, 52, 32, 215, 211, 189, 248, 179, 204, 41, 181, 196, 189, 248, 179, 204, 161, 163]); // 无法终止 PID 42 (属于 PID 4 子进程)的进程。
  const GBK_LINE2 = Buffer.from([212, 173, 210, 242, 58, 32, 190, 220, 190, 248, 183, 195, 206, 202, 161, 163]); // 原因: 拒绝访问。
  const spawnFn = (exe, args, opts) => {
    const listeners = {};
    const child = {
      stdout: { on: () => {} },
      stderr: {
        on: (ev, fn) => {
          if (ev !== "data") return;
          // 模拟 taskkill 对子树逐条报错的多行输出（全 GBK）
          fn(Buffer.concat([GBK_LINE1, Buffer.from("\r\n", "utf8"), GBK_LINE2, Buffer.from("\r\n", "utf8")]));
        },
      },
      on: (ev, fn) => { listeners[ev] = fn; return child; },
      kill: () => {},
    };
    setTimeout(() => listeners.exit && listeners.exit(128), 0);
    return child;
  };
  const r = await procMod.killProcess("x.exe", {
    spawnFn,
    listFn: async () => [{ pid: 42, name: "x.exe" }],
    aliveFn: () => true,
  });
  eq(r.failed.length, 1, "多行输出仍归为一次失败");
  ok(!/[\r\n]/.test(r.failed[0].error), "错误文本已压成单行");
  ok(/原因[:：]\s*拒绝访问/.test(r.failed[0].error), "保留可读的「原因: 拒绝访问」（GBK 解码正确）");
  ok(!/[\uFFFD]/.test(r.failed[0].error), "没有解码乱码");
}

{
  // protectedPids：监控自身相关进程（后台 / 采样 PowerShell）一律跳过，且不调 taskkill
  const calls = [];
  const alive = new Set([100, 200, 300]);
  const r = await procMod.killProcess("powershell.exe", {
    protectedPids: [100, 200],
    spawnFn: fakeKillSpawn(calls, alive),
    listFn: async () => [
      { pid: 100, name: "powershell.exe" },
      { pid: 200, name: "powershell.exe" },
      { pid: 300, name: "powershell.exe" },
    ],
    aliveFn: (pid) => alive.has(pid),
  });
  eq(r.skipped.length, 2, "受保护的两个 pid 被跳过");
  eq(r.killed, 1, "其余实例正常终止");
  eq(calls.length, 1, "受保护 pid 不调 taskkill");
  eq(calls[0].args.includes("100"), false, "绝不 taskkill 受保护 pid");
  eq(calls[0].args.includes("200"), false, "绝不 taskkill 受保护 pid");
}

{
  // 枚举自身必须被剔除：listProcesses 的返回值里不该含那次用来枚举的 PowerShell
  const enumPid = 4321;
  const spawnFn = (exe, args, opts) => {
    const listeners = {};
    const child = {
      pid: enumPid,
      stdout: { on: (ev, fn) => { if (ev === "data") fn(JSON.stringify([{ pid: enumPid, name: "powershell.exe", path: "", ws: 1, cpuTicks: 1 }, { pid: 9, name: "powershell.exe", path: "", ws: 1, cpuTicks: 1 }])); } },
      stderr: { on: () => {} },
      on: (ev, fn) => { listeners[ev] = fn; return child; },
      kill: () => {},
    };
    setTimeout(() => listeners.exit && listeners.exit(0), 0);
    return child;
  };
  const list = await procMod.listProcesses("powershell.exe", { spawnFn });
  eq(list.length, 1, "枚举自身被排除，只剩真实实例");
  eq(list[0].pid, 9, "保留的是真实实例");
}

{
  // isAlive：本进程必活；不存在的 pid 必死
  ok(procMod.isAlive(process.pid) === true, "isAlive 对本进程返回 true");
  ok(procMod.isAlive(999999) === false, "isAlive 对不存在的 pid 返回 false");
}

{
  // 脚本注入防护：目标名必须走环境变量，不能出现在命令行里
  const src = readFileSync(path.join(backendDir, "processes.mjs"), "utf8");
  ok(/\$env:MS_RM_NAME/.test(src), "PowerShell 从 $env:MS_RM_NAME 读目标名");
  ok(/MS_RM_NAME:\s*target/.test(src), "目标名通过 env 传入（不进命令行）");
  ok(/ExecutablePath/.test(src), "列举时读取 ExecutablePath（用于打开文件位置）");
  ok(/windowsVerbatimArguments/.test(src), "explorer 参数用 windowsVerbatimArguments 原样传递");
  ok(/MS_RM_NAME/.test(src) && /UTF8Encoding/.test(src), "列举脚本显式输出 UTF-8（中文程序名才不会对不上）");
  ok(/protectedPids/.test(src), "支持保护监控自身相关进程（后台 / 采样）");
  ok(/gb18030/.test(src), "taskkill 输出按 OEM 代码页解码，避免乱码");
  ok(/isAlive/.test(src), "以探活而非 taskkill 退出码判定成败");
  // 采样脚本也顺带采集 ExecutablePath（供「位置」按钮即时打开，见 sample.ps1 头注释）
  const sampleSrc = readFileSync(path.join(backendDir, "sample.ps1"), "utf8");
  ok(/ExecutablePath/.test(sampleSrc), "sample.ps1 也采集 ExecutablePath（列表点击即可即时定位）");
}

/* ============================ 2e. 打开文件位置 ============================ */

console.log("\n--- 打开文件位置 ---");

{
  // pickExecutablePath：多实例同路径 → 取该路径；忽略空路径
  const list = [
    { pid: 1, path: "D:\\A\\app.exe" },
    { pid: 2, path: "D:\\A\\app.exe" },
    { pid: 3, path: "" }, // 受保护进程无路径
  ];
  eq(procMod.pickExecutablePath(list, () => true), "D:\\A\\app.exe", "多实例同路径取该路径");
  eq(procMod.pickExecutablePath(list, () => false), "D:\\A\\app.exe", "文件都不存在时仍退回第一个非空路径（给线索）");
  eq(procMod.pickExecutablePath([{ path: "" }, {}], () => true), null, "全为空路径 → null");
  eq(procMod.pickExecutablePath([], () => true), null, "空列表 → null");
}

{
  // 多个不同路径：优先存在的；都存在于不同路径时取出现次数最多的
  const list = [
    { path: "D:\\A\\app.exe" },
    { path: "D:\\B\\app.exe" },
    { path: "D:\\B\\app.exe" },
    { path: "D:\\C\\app.exe" }, // 假设这个已删除（exists false）
  ];
  const exists = (p) => p !== "D:\\C\\app.exe";
  eq(procMod.pickExecutablePath(list, exists), "D:\\B\\app.exe", "取存在且实例最多的路径");
  // 若 C 也存在（三者都在）→ 仍取次数最多的 B
  eq(procMod.pickExecutablePath(list, () => true), "D:\\B\\app.exe", "文件都存在时取实例最多的路径");
}

{
  // revealProcessFile：程序未运行 → opened=false 且带原因，不抛
  const r = await procMod.revealProcessFile("ghost.exe", {
    listFn: async () => [],
    exists: () => true,
    spawnFn: fakeSpawn([]),
  });
  eq(r.opened, false, "程序未运行 → opened=false");
  ok(/没有正在运行/.test(r.reason), "给出「没有进程」的原因");
}

{
  // revealProcessFile：受保护进程（拿不到路径）→ opened=false 且带原因
  const r = await procMod.revealProcessFile("svchost.exe", {
    listFn: async () => [{ pid: 4, name: "svchost.exe", path: "" }],
    exists: () => true,
    spawnFn: fakeSpawn([]),
  });
  eq(r.opened, false, "无路径 → opened=false");
  ok(/受保护|路径/.test(r.reason), "给出「拿不到路径」的原因");
}

{
  // revealProcessFile：文件已删除 → opened=false
  const r = await procMod.revealProcessFile("gone.exe", {
    listFn: async () => [{ pid: 5, name: "gone.exe", path: "D:\\X\\gone.exe" }],
    exists: () => false,
    spawnFn: fakeSpawn([]),
  });
  eq(r.opened, false, "文件不存在 → opened=false");
  ok(/不存在/.test(r.reason), "给出「文件不存在」的原因");
}

{
  // revealProcessFile：成功 → 调 explorer，opened=true
  const calls = [];
  const spawnFn = (exe, args, opts) => {
    calls.push({ exe: String(exe), args, opts });
    const child = { unref: () => {}, on: () => {} };
    return child;
  };
  const r = await procMod.revealProcessFile("app.exe", {
    listFn: async () => [{ pid: 9, name: "app.exe", path: "D:\\A\\app.exe" }],
    exists: () => true,
    spawnFn,
  });
  eq(r.opened, true, "成功打开 → opened=true");
  eq(r.path, "D:\\A\\app.exe", "回传定位到的路径");
  eq(calls.length, 1, "调用了一次 explorer");
  ok(/explorer/i.test(calls[0].exe), "用的是 explorer");
  eq(calls[0].args.length, 1, "只有一个参数（不拆路径，避免空格问题）");
  // 关键：只有**路径**被引号包住（/select,"<path>"）。否则含空格的路径（如 Program Files）
  // 会被 Node 整体加引号，explorer 认不出 /select 开关 → 打开错误的位置（见 README）。
  eq(calls[0].args[0], '/select,"D:\\A\\app.exe"', '参数为 /select,"<path>"（引号只包路径）');
  ok(calls[0].opts && calls[0].opts.windowsVerbatimArguments === true, "用 windowsVerbatimArguments 原样传参");
}

{
  // 含空格的路径（如 Program Files）：引号只包路径，且原样传递
  const calls = [];
  const spawnFn = (exe, args, opts) => {
    calls.push({ exe: String(exe), args, opts });
    return { unref: () => {}, on: () => {} };
  };
  const spaced = "C:\\Program Files\\Some App\\my app.exe";
  const r = await procMod.revealProcessFile("my app.exe", {
    listFn: async () => [{ pid: 3, name: "my app.exe", path: spaced }],
    exists: () => true,
    spawnFn,
  });
  eq(r.opened, true, "含空格路径也能打开");
  eq(calls[0].args[0], '/select,"' + spaced + '"', '空格路径：/select,"<path>"');
  eq(calls[0].opts.windowsVerbatimArguments, true, "空格路径：原样传参");
}

{
  // 快路径：给了 cachedPath 就直接打开，**不再**枚举进程（这就是「点击立即打开」）
  const calls = [];
  let listCalled = 0;
  const spawnFn = (exe, args, opts) => {
    calls.push({ exe: String(exe), args, opts });
    return { unref: () => {}, on: () => {} };
  };
  const r = await procMod.revealProcessFile("app.exe", {
    cachedPath: "D:\\A\\app.exe",
    exists: () => true,
    spawnFn,
    listFn: async () => { listCalled += 1; return []; },
  });
  eq(r.opened, true, "有缓存路径 → 直接打开");
  eq(r.path, "D:\\A\\app.exe", "用缓存路径");
  eq(listCalled, 0, "快路径不再枚举进程");
  eq(calls.length, 1, "仍然只调一次 explorer");
  eq(calls[0].args[0], '/select,"D:\\A\\app.exe"', '快路径同样用 /select,"<path>"');
}

{
  // 缓存路径已失效（文件不存在）→ 回退现场枚举，用新路径打开
  const calls = [];
  let listCalled = 0;
  const spawnFn = (exe, args, opts) => {
    calls.push({ exe: String(exe), args, opts });
    return { unref: () => {}, on: () => {} };
  };
  const r = await procMod.revealProcessFile("app.exe", {
    cachedPath: "D:\\old\\gone.exe",
    exists: (p) => p !== "D:\\old\\gone.exe",
    spawnFn,
    listFn: async () => { listCalled += 1; return [{ pid: 1, name: "app.exe", path: "D:\\A\\app.exe" }]; },
  });
  eq(r.opened, true, "缓存失效 → 回退枚举后仍能打开");
  eq(r.path, "D:\\A\\app.exe", "改用现场枚举到的新路径");
  eq(listCalled, 1, "缓存失效时才枚举一次");
}

{
  // 空程序名抛错
  let threw = false;
  try { await procMod.revealProcessFile("", {}); } catch { threw = true; }
  ok(threw, "revealProcessFile 空程序名抛错");
}

/* ============================ 3. 后端 JSON-RPC ============================ */

console.log("\n--- 后端 JSON-RPC ---");

function startBackend(extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(backendDir, "index.mjs")], {
    // 落盘目录指向本次测试专用的临时目录：后端默认写 `plugins/resource-monitor/.data/`
    // 并在启动时把上次的 thresholds / 历史读回来，若复用默认目录，上一次「setThresholds
    // 改成 topN=8」的用例会污染下一次运行（表现为 TopN=10 断言拿到 8）。
    env: {
      ...process.env,
      MS_RM_INTERVAL_MS: "1000",
      MS_PLUGIN_DATA_DIR: mkdtempSync(join(tmpdir(), "ms-rm-test-")),
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages = [];
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try { messages.push(JSON.parse(line)); } catch { messages.push({ __nonjson: line }); }
    }
  });
  const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
  return { child, messages, send };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return true;
    await wait(50);
  }
  return false;
}

{
  const be = startBackend();
  const { child, messages, send } = be;
  let nonjson = 0;

  send({ jsonrpc: "2.0", id: 1, method: "init", params: { apiVersion: 1, pluginId: "test", hostVersion: "0", dataDir: "" } });
  const initOk = await waitFor(() => messages.some((m) => m.id === 1));
  ok(initOk, "init 在超时内返回");
  const init = messages.find((m) => m.id === 1);
  ok(init && init.result && init.result.ok === true, "init 返回 { ok: true }", init ? JSON.stringify(init.result) : "无响应");

  send({ jsonrpc: "2.0", id: 2, method: "capabilities", params: null });
  await waitFor(() => messages.some((m) => m.id === 2));
  const caps = messages.find((m) => m.id === 2);
  ok(caps && caps.result && Array.isArray(caps.result.categories), "capabilities 返回 categories 数组");
  eq(caps.result.windowMs, 35 * 60 * 1000, "窗口 = 35 分钟");
  eq(caps.result.topN, 10, "TopN = 10");

  send({ jsonrpc: "2.0", id: 3, method: "history", params: null });
  await waitFor(() => messages.some((m) => m.id === 3));
  const hist = messages.find((m) => m.id === 3);
  ok(hist && hist.result && Array.isArray(hist.result.points), "history 返回 points 数组");
  ok(hist.result.meta && typeof hist.result.meta.maxTicks === "number", "history.meta 含 maxTicks");

  send({ jsonrpc: "2.0", id: 4, method: "status", params: null });
  await waitFor(() => messages.some((m) => m.id === 4));
  const stt = messages.find((m) => m.id === 4);
  ok(stt && stt.result && typeof stt.result.supported === "boolean", "status 返回 supported 布尔值");

  // Windows 上应能拿到 tick（非 Windows 时只断言协议不崩）
  if (process.platform === "win32") {
    const gotTick = await waitFor(() => messages.some((m) => m.method === "tick"), 9000);
    ok(gotTick, "Windows 上收到 tick 通知");
    const tick = messages.find((m) => m.method === "tick");
    if (tick) {
      ok(tick.params && tick.params.point && tick.params.point.top, "tick 带 point.top");
      ok(Array.isArray(tick.params.point.top.cpu), "tick.point.top.cpu 是数组");
      ok(tick.params.point.trk && Array.isArray(tick.params.point.trk.cpu), "tick 带 point.trk（滞回跟踪集合）");
    }
  }

  /* ---- 新增方法：setThresholds / exportCsv / listProcesses / killProcess ---- */

  send({ jsonrpc: "2.0", id: 10, method: "setThresholds", params: { enterN: 8, exitN: 12, topN: 8 } });
  await waitFor(() => messages.some((m) => m.id === 10));
  const th = messages.find((m) => m.id === 10);
  ok(th && th.result && th.result.ok === true, "setThresholds 返回 ok");
  eq(th.result.enterN, 8, "enterN 已设为 8");
  eq(th.result.exitN, 12, "exitN 已设为 12");
  eq(th.result.status.topN, 8, "status 反映了新的 topN");
  ok(messages.some((m) => m.method === "thresholds"), "广播了 thresholds 通知");

  send({ jsonrpc: "2.0", id: 11, method: "exportCsv", params: { kind: "top", minutes: 60 } });
  send({ jsonrpc: "2.0", id: 12, method: "exportCsv", params: { kind: "system", minutes: 60 } });
  await waitFor(() => messages.some((m) => m.id === 11) && messages.some((m) => m.id === 12));
  const ex1 = messages.find((m) => m.id === 11);
  const ex2 = messages.find((m) => m.id === 12);
  ok(ex1 && ex1.result && /^time,iso,category,program,value,instances/.test(ex1.result.csv.replace(/^\uFEFF/, "")), "exportCsv(top) 表头正确");
  ok(/^resource-top-\d{8}-\d{6}\.csv$/.test(ex1.result.filename), "导出文件名带时间戳", ex1.result.filename);
  ok(ex2 && /cpu_pct,mem_used_bytes/.test(ex2.result.csv), "exportCsv(system) 表头正确");
  ok(typeof ex1.result.bytes === "number" && ex1.result.bytes > 0, "返回字节数");

  // 临界：未知 kind 退回默认，不应报错
  send({ jsonrpc: "2.0", id: 13, method: "exportCsv", params: { kind: "nonsense" } });
  await waitFor(() => messages.some((m) => m.id === 13));
  ok(messages.find((m) => m.id === 13)?.result?.csv != null, "未知 kind 不报错（退回 Top 表）");

  // listProcesses：查一个几乎必然存在的名字（当前 node）应至少匹配 0 个且不报错
  send({ jsonrpc: "2.0", id: 14, method: "listProcesses", params: { name: "这个进程名不存在.exe" } });
  await waitFor(() => messages.some((m) => m.id === 14));
  const lp = messages.find((m) => m.id === 14);
  ok(lp && lp.result && Array.isArray(lp.result.processes), "listProcesses 返回数组");
  eq(lp.result.processes.length, 0, "不存在的程序名匹配 0 个");

  // killProcess：不存在的名字 → matched 0、不报错（非 Windows 会抛错，跳过）
  if (process.platform === "win32") {
    send({ jsonrpc: "2.0", id: 15, method: "killProcess", params: { name: "这个进程名不存在.exe" } });
    await waitFor(() => messages.some((m) => m.id === 15), 6000);
    const kp = messages.find((m) => m.id === 15);
    ok(kp && kp.result && kp.result.matched === 0 && kp.result.killed === 0, "killProcess 对不存在的名字零匹配零终止");
  }

  // killProcess：空名字应返回错误
  send({ jsonrpc: "2.0", id: 16, method: "killProcess", params: { name: "" } });
  await waitFor(() => messages.some((m) => m.id === 16));
  const kerr = messages.find((m) => m.id === 16);
  ok(kerr && kerr.error && /程序名/.test(kerr.error.message), "空程序名返回可读错误");

  // killProcess：不存在 —— 已在上方断言；这里测 revealProcessFile 的返回形态
  if (process.platform === "win32") {
    send({ jsonrpc: "2.0", id: 17, method: "revealProcessFile", params: { name: "这个进程名不存在.exe" } });
    await waitFor(() => messages.some((m) => m.id === 17), 6000);
    const rv = messages.find((m) => m.id === 17);
    ok(rv && rv.result && rv.result.opened === false, "revealProcessFile 对不存在的程序返回 opened=false");
    ok(rv.result && /没有正在运行/.test(rv.result.reason || ""), "并给出原因");
  }

  // revealProcessFile：空名字应返回错误
  send({ jsonrpc: "2.0", id: 18, method: "revealProcessFile", params: { name: "" } });
  await waitFor(() => messages.some((m) => m.id === 18));
  const rverr = messages.find((m) => m.id === 18);
  ok(rverr && rverr.error && /程序名/.test(rverr.error.message), "revealProcessFile 空程序名返回可读错误");

  send({ jsonrpc: "2.0", method: "deactivate" });
  await wait(500);
  const exited = child.exitCode != null || child.killed;
  ok(exited || child.exitCode === 0, "deactivate 后进程退出");

  // stdout 必须是纯 JSON（NDJSON 协议）
  for (const m of messages) if (m.__nonjson) nonjson++;
  eq(nonjson, 0, "stdout 全部是合法 JSON 行（无协议污染）");

  try { child.kill("SIGKILL"); } catch { /* ignore */ }
}

/* ============================ 汇总 ============================ */

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
