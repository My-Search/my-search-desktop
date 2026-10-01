/**
 * 资源监控插件 —— 采样数据的纯逻辑层。
 *
 * 设计原则：**采样与聚合解耦**。
 *   - `sample.ps1` 只负责吐「原始快照」（进程 PID 的累计计数器、内存、网卡累计字节）；
 *   - 本文件把这些累计量求差、按程序名聚合、排名、装进环形缓冲（默认 35 分钟）；
 *   - 全部是纯函数（无 IO、无计时器），因此可以直接单测（见 test/resource-monitor.test.mjs）。
 *
 * 关键口径（与 Windows 任务管理器一致）：
 *   - **CPU%**：`ΔCPU秒 / Δt / 逻辑核数 × 100`。这样全进程相加 ≈ 100，
 *     用户看到的「某个程序占 30%」就是任务管理器里的那个数（而非单核 100% 口径）。
 *   - **内存**：进程工作集（WorkingSetSize，字节，绝对量，首拍即可排名）。
 *   - **上传**：`ΔOtherTransferCount / Δt`（字节/秒）。这是 Windows 免管理员
 *     唯一可得的「每进程非文件 IO」计数，**含命名管道等、且收发混合**，因此是
 *     近似上界（界面上必须如实标注，见 README）。
 *
 * 计数器回绕 / PID 复用：差值出现负数时一律夹到 0；上一拍没见过的 PID 首拍差值记 0。
 * 每拍结束用「当前快照」重建上一拍状态，消失的 PID 自然被淘汰（无需额外清理）。
 *
 * ============ 报告阈值与滞回（进圈 / 出圈）============
 *
 * 榜单与趋势线的可见范围用「滞回」控制，避免名次在边界反复抖动导致线闪烁：
 *   - **进圈**（enterN，默认 10）：排名 ≤ 该值 → 纳入跟踪；
 *   - **出圈**（exitN，默认 15）：一旦被跟踪，只要排名仍 ≤ 该值就继续保留；
 *     排名真的跌出该值才移出。
 * 即「进圈看 10 名，掉到 15 名之外才移出」。两者都可在界面上动态设置。
 *
 * ============ 「断线」的语义（重要）============
 *
 * 趋势线上一条线**不应该无缘无故断开**。以下三类情况区分处理：
 *   1. **占用为 0，但进程仍在运行**（活着但空闲）——**不算掉出**：
 *      线继续画下去（本拍值为 0，压到谷底），不会断开；
 *   2. **进程从快照里消失**（退出了）——宽限 TRACK_GRACE_TICKS 拍后移出，
 *      并把它的历史旧段一并清理（见 purgeDroppedSegments）；
 *   3. **有占用但排名跌出 exitN**——判定真掉出：移出跟踪，并**清掉它的历史旧段**，
 *      以后再上榜则从全新的一段重新开始（用户要求：掉下来就清掉旧记录重新开始）。
 *
 * 因此只有「采样本身出现空档」或「程序掉出后重新上榜的新段」才会看到断口，
 * 这两种断口都是符合预期的。
 */

/** 采样周期（毫秒）——与 sample.ps1 的循环间隔保持一致 */
export const SAMPLE_MS = 5000;
/** 保留窗口（毫秒）：最近 35 分钟 */
export const WINDOW_MS = 35 * 60 * 1000;
/** 环形缓冲上限（拍数）：35 分 / 5 秒 = 420 */
export const MAX_TICKS = Math.floor(WINDOW_MS / SAMPLE_MS);
/** 每类榜单取前 N 名 */
export const TOP_N = 10;
/** 进圈排名（默认 = topN） */
export const ENTER_N = TOP_N;
/** 出圈排名（默认 = topN + 5）：进圈后掉到该名次之外才移出 */
export const EXIT_N = TOP_N + 5;
/**
 * 连续多少拍「没有任何占用（或短暂无数据）」才真正移出跟踪。
 *
 * 关键语义：某拍占用为 0 / 无数据 **不算掉出** —— 线继续画到 0；只有连续
 * 超过该拍数仍无数据（进程多半已退出）才移出并清理旧段，避免死程序的平线堆积。
 * 这里 6 拍 ≈ 30 秒（5s 采样）。
 */
export const TRACK_GRACE_TICKS = 6;
/** 阈值上限（防止界面传入离谱值把 CPU 耗光） */
export const MAX_TRACK_N = 200;
/** CPU 低于该值（%）视为 0，避免把噪声排进榜 */
export const CPU_EPSILON = 0.01;
/** 100ns（Windows FILETIME 单位）→ 秒 */
const TICKS_TO_SEC = 1e7;

/** 三类榜单的键（顺序即界面页签顺序） */
export const CATS = ["cpu", "mem", "up"];

/** 采样器状态（环形缓冲 + 上一拍累计量 + 滞回跟踪集合） */
export function createState(opts = {}) {
  return {
    topN: opts.topN ?? TOP_N,
    enterN: opts.enterN ?? opts.topN ?? ENTER_N,
    exitN: opts.exitN ?? EXIT_N,
    windowMs: opts.windowMs ?? WINDOW_MS,
    maxTicks: opts.maxTicks ?? MAX_TICKS,
    sampleMs: opts.sampleMs ?? SAMPLE_MS,
    /** pid → { name, cpuTicks, other, ws }：上一拍的累计量 */
    prev: new Map(),
    /**
     * 程序名 → 可执行路径（每拍从快照刷新；受保护进程为空则不收录）。
     * 供界面「位置」按钮**即时**定位——点一下就能开，不必再冷启动一次枚举。
     */
    paths: new Map(),
    /** 上一拍时间戳（ms）；null = 尚未建立基线 */
    prevT: null,
    /** 上一拍最近一次网卡累计字节（算真实上传/下载速率用） */
    netPrev: null,
    /** 最近的采样点（旧 → 新），每点形状见 makePoint() */
    ticks: [],
    /**
     * 滞回跟踪集合：cat → Map<name, value 最近一次值>。
     * 「在集合里」= 该程序当前仍在趋势图中显示（直到跌出 exitN）。
     */
    tracked: { cpu: new Map(), mem: new Map(), up: new Map() },
    /**
     * 每类「连续无数据拍数」：cat → Map<name, 连续次数>。
     * 只有连续超过 TRACK_GRACE_TICKS 拍都没有任何占用，才判定为真掉出并清理。
     */
    absent: { cpu: new Map(), mem: new Map(), up: new Map() },
    /** 本拍发生「真掉出」的程序：cat → Set<name>（供上层清理历史旧段） */
    dropped: { cpu: new Set(), mem: new Set(), up: new Set() },
    /** 累计收到的快照 / 有效拍数（诊断用） */
    snapshots: 0,
    points: 0,
  };
}

/** 数值兜底：非有限值 → 0，负值（可配）→ 0 */
function num(v, { nonNeg = true } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (nonNeg && n < 0) return 0;
  return n;
}

function round(v, digits) {
  const p = Math.pow(10, digits);
  return Math.round(v * p) / p;
}

/**
 * 从快照里读出「按 PID 的累计量」。
 * 快照形状（由 sample.ps1 产出）：
 *   { t, cores, mem:{totalKB,freeKB}, net:{sentTotal,recvTotal},
 *     procs:[{ pid, name, k, u, ws, other }] }
 * 其中 k/u = KernelModeTime/UserModeTime（100ns），ws = WorkingSetSize（字节），
 * other = OtherTransferCount（字节）。
 */
export function readProcs(snap) {
  const out = new Map();
  const list = Array.isArray(snap?.procs) ? snap.procs : [];
  for (const p of list) {
    const pid = Math.trunc(num(p?.pid));
    if (!pid || pid <= 0) continue;
    const name = String(p?.name ?? "").trim() || `pid-${pid}`;
    const k = num(p?.k);
    const u = num(p?.u);
    out.set(pid, {
      name,
      cpuTicks: k + u,
      other: num(p?.other),
      ws: num(p?.ws),
      path: String(p?.path ?? "").trim(),
    });
  }
  return out;
}

/**
 * 从「按 PID 的进程表」汇集「程序名 → 可执行路径」。
 *
 * 同名多实例可能有多个路径（不同安装位置）。与 pickExecutablePath 一致的策略：
 * **取出现次数最多的路径**（多数实例所在处最可能就是主程序），并列时取字典序，
 * 保证结果稳定、可预期。空路径（受保护/提权进程）不参与。
 *
 * @param {Map<number,{name:string,path?:string}>} procs
 * @returns {Map<string,string>}
 */
export function collectPaths(procs) {
  const counts = new Map(); // name → Map<path, count>
  for (const s of procs.values()) {
    const name = String(s?.name ?? "").trim();
    const path = String(s?.path ?? "").trim();
    if (!name || !path) continue;
    let m = counts.get(name);
    if (!m) { m = new Map(); counts.set(name, m); }
    m.set(path, (m.get(path) || 0) + 1);
  }
  const out = new Map();
  for (const [name, m] of counts) {
    let best = null, bestN = -1;
    for (const [path, n] of m) {
      if (n > bestN || (n === bestN && path < best)) { best = path; bestN = n; }
    }
    if (best) out.set(name, best);
  }
  return out;
}

/** 某个程序的「上次采样到的可执行路径」（没有则 null） */
export function programPath(state, name) {
  const k = String(name ?? "").trim();
  if (!k) return null;
  const p = state?.paths?.get(k);
  return p || null;
}

/**
 * 求差得到「每 PID 本拍速率」。
 * @returns Map<pid, { name, cpuPct, memBytes, upBps }>
 */
export function diffProcs(prev, cur, dtSec, cores) {
  const out = new Map();
  const denom = dtSec > 0 ? dtSec : 0;
  const c = cores > 0 ? cores : 1;
  for (const [pid, now] of cur) {
    const before = prev.get(pid);
    let cpuPct = 0;
    let upBps = 0;
    if (before && denom > 0) {
      // 计数器回绕 / 复用 → 负差值夹到 0
      const dCpuTicks = Math.max(0, now.cpuTicks - before.cpuTicks);
      const dOther = Math.max(0, now.other - before.other);
      cpuPct = ((dCpuTicks / TICKS_TO_SEC) / denom / c) * 100;
      upBps = dOther / denom;
    }
    out.set(pid, {
      name: now.name,
      cpuPct: cpuPct > 0 ? cpuPct : 0,
      memBytes: now.ws,
      upBps: upBps > 0 ? upBps : 0,
    });
  }
  return out;
}

/**
 * 按程序名聚合（同名多进程合并；记录实例数）。
 * @returns Map<name, { name, cpuPct, memBytes, upBps, instances }>
 */
export function aggregateByName(pidStats) {
  const out = new Map();
  for (const s of pidStats.values()) {
    let agg = out.get(s.name);
    if (!agg) {
      agg = { name: s.name, cpuPct: 0, memBytes: 0, upBps: 0, instances: 0 };
      out.set(s.name, agg);
    }
    agg.cpuPct += s.cpuPct;
    agg.memBytes += s.memBytes;
    agg.upBps += s.upBps;
    agg.instances += 1;
  }
  return out;
}

/**
 * 排名：把聚合结果整理成三类榜单（各自完整降序），并把「跟踪集合」按滞回更新。
 *
 * 滞回规则见文件头「报告阈值与滞回」与「断线的语义」：
 *   - 排名 ≤ enterN → 进入跟踪；
 *   - 已在集合中且排名 ≤ exitN → 保留；
 *   - **活着但空闲（占用 0）** → 保留（记 0，线不断）；
 *   - 排名 > exitN（有占用但被挤下去）→ 真掉出（清旧段）；
 *   - 进程从快照消失 → 宽限 TRACK_GRACE_TICKS 拍后移出。
 *
 * @returns { lists, tracked, dropped, sysCpuPct }
 *   - lists[cat]：完整降序榜单（条目 [name, value, instances]），调用方按需切片
 *   - tracked[cat]：滞回后的跟踪名单（趋势图据此只画“未出圈”的程序）
 *   - dropped[cat]：本拍发生「真掉出」的程序名集合（供上层清理历史旧段）
 */
export function rankAll(aggMap, state = {}, epsilon = CPU_EPSILON) {
  const topN = clampN(state.topN ?? TOP_N, 1, MAX_TRACK_N, TOP_N);
  // 进圈默认 = topN；出圈默认 = max(进圈, topN + 5)，且必须 ≥ 进圈，否则滞回没意义
  const enterN = clampN(state.enterN ?? topN, 1, MAX_TRACK_N, topN);
  const exitN = clampN(state.exitN ?? topN + 5, enterN, MAX_TRACK_N, Math.max(enterN, topN + 5));

  const cpu = [];
  const mem = [];
  const up = [];
  let sysCpuPct = 0;
  for (const a of aggMap.values()) {
    sysCpuPct += a.cpuPct;
    if (a.cpuPct > epsilon) cpu.push([a.name, round(a.cpuPct, 2), a.instances]);
    if (a.memBytes > 0) mem.push([a.name, Math.round(a.memBytes), a.instances]);
    if (a.upBps > 0) up.push([a.name, Math.round(a.upBps), a.instances]);
  }
  const desc = (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1);
  cpu.sort(desc);
  mem.sort(desc);
  up.sort(desc);

  const lists = { cpu, mem, up };
  const rankIn = { cpu: null, mem: null, up: null };
  for (const cat of CATS) {
    rankIn[cat] = new Map();
    const arr = lists[cat];
    for (let i = 0; i < arr.length; i++) rankIn[cat].set(arr[i][0], i + 1);
  }

  // 滞回更新（就地改 state.tracked，保持跨拍连续）
  const trackedOut = { cpu: [], mem: [], up: [] };
  const droppedOut = { cpu: new Set(), mem: new Set(), up: new Set() };
  // 「本拍仍在运行的进程名」：aggMap 覆盖快照里的每个进程（哪怕占用为 0），
  // 据此区分「活着但空闲（占用 0）」与「进程已退出」——前者不能断线，后者才移出。
  const alive = new Set(aggMap.keys());
  for (const cat of CATS) {
    const prevSet = state.tracked && state.tracked[cat] ? state.tracked[cat] : new Map();
    const prevAbsent = state.absent && state.absent[cat] ? state.absent[cat] : new Map();
    const nextMap = new Map();
    const nextAbsent = new Map();
    const arr = lists[cat];

    /** 本拍该程序在榜单里的值（有值 = 大于阈值） */
    const curVal = new Map();
    for (const e of arr) curVal.set(e[0], e[1]);

    // 1) 已在跟踪的程序：决定保留还是真掉出
    //    - 有值且排名 ≤ exitN            → 保留（更新为最新值）
    //    - 有值但排名 > exitN            → **真掉出**（确实被别的程序挤下去了）
    //    - 无值但进程仍在（活着但空闲 0）→ **保留，本拍记 0**（线压到谷底，不断）
    //    - 无值且进程已不在快照里（退出）→ 宽限计数，连续超阈值才移出并清理
    for (const name of prevSet.keys()) {
      const has = curVal.has(name);
      const rank = rankIn[cat].get(name);
      if (has && rank != null && rank <= exitN) {
        nextMap.set(name, curVal.get(name));
        continue;
      }
      if (has && rank != null && rank > exitN) {
        droppedOut[cat].add(name);        // 真掉出：名次跌出 exitN
        continue;
      }
      // 无值：先看进程是否还活着
      if (alive.has(name)) {
        nextMap.set(name, 0);             // 活着但空闲 → 保留，记 0（不断线）
        continue;                         // 也不计宽限（它只是没占用）
      }
      // 进程已从快照消失 → 宽限计数
      const n = (prevAbsent.get(name) || 0) + 1;
      if (n > TRACK_GRACE_TICKS) {
        droppedOut[cat].add(name);        // 长时间（>宽限）无此进程 → 判定退出
      } else {
        nextMap.set(name, 0);             // 仍在宽限内：保留，记 0
        nextAbsent.set(name, n);
      }
    }

    // 2) 新进圈：本拍有值且排名 ≤ enterN
    for (const e of arr) {
      const name = e[0];
      if (nextMap.has(name)) continue;
      const rank = rankIn[cat].get(name);
      if (rank != null && rank <= enterN) {
        nextMap.set(name, e[1]);
        nextAbsent.delete(name);
      }
    }

    if (state.tracked) state.tracked[cat] = nextMap;
    if (state.absent) state.absent[cat] = nextAbsent;
    if (state.dropped) state.dropped[cat] = new Set([...droppedOut[cat]]);

    // 输出跟踪名单（按本拍值降序；无本拍值的排后面）
    for (const name of nextMap.keys()) {
      trackedOut[cat].push([name, nextMap.get(name)]);
    }
    trackedOut[cat].sort((a, b) => (curVal.has(b[0]) ? b[1] : -1) - (curVal.has(a[0]) ? a[1] : -1));
  }

  // 每拍仍按 topN 截断，供 tick 里的「当前 Top N」使用
  return {
    cpu: cpu.slice(0, topN),
    mem: mem.slice(0, topN),
    up: up.slice(0, topN),
    sysCpuPct: round(sysCpuPct, 2),
    tracked: trackedOut,
    dropped: droppedOut,
    enterN,
    exitN,
    topN,
  };
}

/** 夹紧一个整数到 [min,max]，非法值退回 def */
export function clampN(v, min, max, def) {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/**
 * 构造一个采样点（紧凑形状）。
 *
 *   { t, s:[cpuPct,memUsed,memTotal,upBps,downBps],
 *     top:{ cpu:[[name,value,inst],…≤topN], mem:…, up:… },   // 当前 Top N（界面列表用）
 *     trk:{ cpu:[[name,value],…], mem:…, up:… } }            // 滞回跟踪集合（趋势线用）
 *
 * 趋势线取 trk（「未出圈」的集合），因此一个程序只要没掉出 exitN，线就连续保留。
 */
export function makePoint({ t, sys, top, trk }) {
  return { t, s: sys, top, trk };
}

/**
 * 吞入一份快照：
 *   - 第一份只建立基线（返回 { ok:false, reason:"warming" }）；
 *   - 之后求差 → 聚合 → 排名 → 追加进环形缓冲。
 * @returns { ok:boolean, reason?:string, point?:object }
 */
export function ingest(state, snap) {
  state.snapshots += 1;
  const t = num(snap?.t);
  if (!t) return { ok: false, reason: "no-timestamp" };
  const cur = readProcs(snap);
  // 程序名 → 可执行路径：每拍刷新（首拍也刷，让「位置」按钮一开始就可即时打开）
  state.paths = collectPaths(cur);

  // 基线：还没有上一拍，无法求差
  if (state.prevT == null) {
    state.prev = cur;
    state.prevT = t;
    return { ok: false, reason: "warming" };
  }

  const dtSec = (t - state.prevT) / 1000;
  if (!(dtSec > 0)) {
    // 时钟回拨 / 重复时间戳：不更新基线，等下一拍
    return { ok: false, reason: "non-monotonic" };
  }

  const cores = Math.max(1, Math.trunc(num(snap?.cores)) || 1);
  const pidStats = diffProcs(state.prev, cur, dtSec, cores);
  const agg = aggregateByName(pidStats);
  const ranked = rankAll(agg, state);

  // 系统级：内存（KB → 字节）与网卡真实速率（累计字节差）
  const totalKB = num(snap?.mem?.totalKB);
  const freeKB = num(snap?.mem?.freeKB);
  const memTotalBytes = Math.round(totalKB * 1024);
  const memUsedBytes = Math.max(0, Math.round((totalKB - freeKB) * 1024));

  const netSentTotal = num(snap?.net?.sentTotal);
  const netRecvTotal = num(snap?.net?.recvTotal);
  const before = state.netPrev;
  const netUpBps = before ? Math.max(0, (netSentTotal - before.sentTotal) / dtSec) : 0;
  const netDownBps = before ? Math.max(0, (netRecvTotal - before.recvTotal) / dtSec) : 0;
  state.netPrev = { sentTotal: netSentTotal, recvTotal: netRecvTotal };

  const point = makePoint({
    t,
    sys: [
      ranked.sysCpuPct,
      memUsedBytes,
      memTotalBytes,
      Math.round(netUpBps),
      Math.round(netDownBps),
    ],
    top: { cpu: ranked.cpu, mem: ranked.mem, up: ranked.up },
    trk: ranked.tracked,
  });

  // 真掉出的程序：清掉它在**历史所有拍**里的旧曲线，使它以后再上榜时从新一段开始
  purgeDroppedSegments(state, ranked.dropped);

  // 进入下一拍的基线（用当前快照重建，消失的 PID 自动淘汰）
  state.prev = cur;
  state.prevT = t;

  state.ticks.push(point);
  state.points += 1;
  trimTicks(state, t);
  return { ok: true, point };
}

/**
 * 把「已真掉出」的程序从历史各拍的 trk 名单里删除（含本拍）。
 *
 * 语义（用户要求）：程序掉出 15 名后，**旧记录一并清理**，之后若再上榜则
 * 从全新的一段开始画 —— 而不是保留旧段再并排画新段。这样趋势图只反映
 * 「最近这一次连续在榜」的过程，不会把多次零散上榜拼在一起。
 */
export function purgeDroppedSegments(state, dropped) {
  if (!dropped) return;
  // 收集需要清理的名字（按类别）
  const namesByCat = {};
  let any = false;
  for (const cat of CATS) {
    const set = dropped[cat];
    if (set && set.size > 0) { namesByCat[cat] = set; any = true; }
  }
  if (!any) return;
  for (const p of state.ticks) {
    if (!p || !p.trk) continue;
    for (const cat of CATS) {
      const set = namesByCat[cat];
      if (!set || !Array.isArray(p.trk[cat])) continue;
      p.trk[cat] = p.trk[cat].filter((e) => !set.has(e[0]));
    }
  }
}

/**
 * 动态改阈值（界面上「进圈 / 出圈」两个输入框）。
 *
 * 改完立即**就地重算**两种数据：
 *   1. 跟踪集合（trended 名单）按新 enterN/exitN 重新过滤当前 live 状态；
 *   2. 已存的历史点里，每条趋势线的「可见样本」按新阈值重新过滤。
 *
 * 历史点的做法：把每点的 trk 名单中，按该点在该类别的名次是否仍满足
 * 「进圈 ≤ enterN」或原本已在跟踪且 ≤ exitN，重新裁剪。因为历史点里只保留了
 * topN 名次（其它名次当时就被丢弃了），重算只能在这份可见数据上做——把名次
 * 超出 exitN 的部分去掉、名次 ≤ enterN 的保留；这是「向前无缝、向后近似」的折中。
 *
 * @returns {{ enterN:number, exitN:number }}
 */
export function setThresholds(state, { enterN, exitN, topN } = {}) {
  const t = clampN(topN ?? state.topN, 1, MAX_TRACK_N, state.topN);
  state.topN = t;
  state.enterN = clampN(enterN ?? state.enterN, 1, MAX_TRACK_N, t);
  state.exitN = clampN(exitN ?? state.exitN, state.enterN, MAX_TRACK_N, Math.max(state.enterN, t + 5));

  // 1) 重算 live 跟踪集合：把当前名次已超 exitN（或本拍无值）的直接移出
  for (const cat of CATS) {
    const tracked = state.tracked[cat];
    if (!tracked || tracked.size === 0) continue;
    const last = state.ticks.length > 0 ? state.ticks[state.ticks.length - 1] : null;
    const rankNow = new Map();
    if (last && last.top && Array.isArray(last.top[cat])) {
      last.top[cat].forEach((e, i) => rankNow.set(e[0], i + 1));
    }
    for (const name of [...tracked.keys()]) {
      const rank = rankNow.get(name);
      if (rank == null || rank > state.exitN) tracked.delete(name);
    }
  }

  // 2) 历史点的 trk 名单按新阈值裁剪（仅能基于当时保留的 ≤topN 名次）
  for (const p of state.ticks) {
    if (!p.trk) continue;
    for (const cat of CATS) {
      const arr = p.trk[cat];
      if (!Array.isArray(arr)) continue;
      const ranking = p.top && Array.isArray(p.top[cat]) ? p.top[cat] : [];
      const rankOf = new Map();
      ranking.forEach((e, i) => rankOf.set(e[0], i + 1));
      p.trk[cat] = arr.filter((e) => {
        const rank = rankOf.get(e[0]);
        if (rank != null) return rank <= state.exitN;
        // 当时已不在本拍榜单里（0 值维持）→ 只有在阈值没收紧到把它判为“出圈”时才丢
        return true;
      });
    }
  }

  return { enterN: state.enterN, exitN: state.exitN };
}

/** 按时间窗口与最大拍数裁剪环形缓冲 */
export function trimTicks(state, now) {
  const cutoff = now - state.windowMs;
  while (state.ticks.length > 0 && state.ticks[0].t < cutoff) state.ticks.shift();
  while (state.ticks.length > state.maxTicks) state.ticks.shift();
}

/** 环形缓冲的快照（给前台的 history 用；结构即前台渲染所需的最小集） */
export function historyPayload(state, now = Date.now()) {
  return {
    meta: {
      now,
      sampleMs: state.sampleMs,
      windowMs: state.windowMs,
      topN: state.topN,
      enterN: state.enterN,
      exitN: state.exitN,
      maxTicks: state.maxTicks,
      points: state.ticks.length,
      snapshots: state.snapshots,
    },
    points: state.ticks.map((p) => p),
    latest: state.ticks.length > 0 ? state.ticks[state.ticks.length - 1] : null,
  };
}

/** 从持久化数据恢复（进程重启后仍能看到历史）；返回恢复的拍数 */
export function restore(state, saved) {
  const list = Array.isArray(saved?.points) ? saved.points : [];
  const clean = [];
  for (const p of list) {
    if (!p || typeof p !== "object") continue;
    const t = num(p.t);
    if (!t) continue;
    const s = Array.isArray(p.s) ? p.s.map((v) => num(v)) : [0, 0, 0, 0, 0];
    const top = p.top && typeof p.top === "object" ? p.top : {};
    const trk = p.trk && typeof p.trk === "object" ? p.trk : null;
    clean.push({
      t,
      s,
      top: { cpu: sortList(top.cpu), mem: sortList(top.mem), up: sortList(top.up) },
      // 旧的持久化文件没有 trk：缺省用 top（等价于「只跟踪 TopN」的保守行为）
      trk: trk
        ? {
            cpu: sortSeries(trk.cpu),
            mem: sortSeries(trk.mem),
            up: sortSeries(trk.up),
          }
        : null,
    });
  }
  clean.sort((a, b) => a.t - b.t);
  // 恢复后为缺 trk 的老点补一份（用 top 兜底），保证渲染逻辑统一
  for (const p of clean) {
    if (!p.trk) {
      p.trk = {
        cpu: p.top.cpu.map((e) => [e[0], e[1]]),
        mem: p.top.mem.map((e) => [e[0], e[1]]),
        up: p.top.up.map((e) => [e[0], e[1]]),
      };
    }
  }
  state.ticks = clean;
  if (clean.length > 0) trimTicks(state, clean[clean.length - 1].t);
  return state.ticks.length;
}

/** 规整「跟踪序列」数组（[name,value] 对） */
function sortSeries(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list) {
    if (!Array.isArray(e) || e.length < 2) continue;
    const name = String(e[0] ?? "").trim();
    if (!name) continue;
    out.push([name, num(e[1])]);
  }
  out.sort((a, b) => b[1] - a[1]);
  return out;
}

/** 规整一个榜单数组（防御持久化文件被手改） */
function sortList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list) {
    if (!Array.isArray(e) || e.length < 2) continue;
    const name = String(e[0] ?? "").trim();
    if (!name) continue;
    out.push([name, num(e[1]), Math.max(1, Math.trunc(num(e[2]) || 1))]);
  }
  out.sort((a, b) => b[1] - a[1]);
  return out;
}

/** 前台渲染用的中文标签（榜单类型） */
export const CATEGORY_LABELS = { cpu: "CPU", mem: "内存", up: "上传" };
