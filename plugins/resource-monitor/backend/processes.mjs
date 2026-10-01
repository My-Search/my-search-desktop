/**
 * 资源监控插件 —— 进程控制（按程序名列举 / 终止 / 定位文件）。
 *
 * 为什么单独一个文件：这块涉及「拿本机进程信息 + 结束进程 + 打开文件位置」这类
 * 有副作用的操作，与纯采样的 aggregate.mjs 分开，边界更清楚，也便于写单测（注入假 exec）。
 *
 * 安全要点：
 *   - **不把程序名拼进命令行**：进程名可能带空格 / 引号 / 中日文，直接拼进
 *     PowerShell 字符串会有注入风险。这里统一把目标名放进**环境变量**
 *     （`MS_RM_NAME`），脚本侧用 `$env:MS_RM_NAME` 读，命令行里永远不含用户输入。
 *   - **绝不杀自己**：目标 pid 与传入的 `selfPid`（插件后台进程）比对，命中即跳过。
 *   - 杀进程用 `taskkill /PID <n> /T /F`（/T 带上子进程树）。
 *   - 定位文件：拿到的可执行路径来自系统（非用户输入），只交给 `explorer /select,`
 *     的原生打开，不做字符串拼接进 shell。
 */
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Windows 系统命令的绝对路径（宿主不继承 PATH，必须绝对路径） */
const SYS_ROOT = process.env.SystemRoot || "C:\\Windows";
const TASKKILL = join(SYS_ROOT, "System32", "taskkill.exe");
const EXPLORER = join(SYS_ROOT, "explorer.exe");

function resolvePowerShell() {
  const cands = [
    join(SYS_ROOT, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    join(process.env.ProgramFiles || "C:\\Program Files", "PowerShell", "7", "pwsh.exe"),
  ];
  for (const p of cands) {
    try {
      if (existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * 列举某程序名对应的所有进程实例。
 * @returns Promise<Array<{pid:number,name:string,ws:number,cpuTicks:number}>>
 */
export function listProcesses(name, { spawnFn = nodeSpawn } = {}) {
  return new Promise((resolve, reject) => {
    const target = String(name ?? "").trim();
    if (!target) return resolve([]);
    if (process.platform !== "win32") return resolve([]);
    const ps = resolvePowerShell();
    if (!ps) return reject(new Error("未找到 Windows PowerShell，无法列举进程"));

    // 脚本从环境变量读目标名；命令行里不含用户输入。
    // ExecutablePath 在「受保护进程」上会是空（如 svchost.exe），如实留空由上层提示。
    const script = [
      "$ErrorActionPreference='SilentlyContinue'",
      "$n=$env:MS_RM_NAME",
      "$out=@()",
      "foreach($p in (Get-CimInstance Win32_Process -Property ProcessId,Name,ExecutablePath,KernelModeTime,UserModeTime,WorkingSetSize)){",
      "  if($p.Name -eq $n){ $out += [pscustomobject]@{ pid=[int]$p.ProcessId; name=[string]$p.Name; path=[string]$p.ExecutablePath; ws=[long]$p.WorkingSetSize; cpuTicks=[long]($p.KernelModeTime+$p.UserModeTime) } }",
      "}",
      "ConvertTo-Json -InputObject @($out) -Depth 3 -Compress",
    ].join("; ");

    let child;
    try {
      child = spawnFn(ps, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
        windowsHide: true,
        env: { ...process.env, MS_RM_NAME: target },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      return reject(e);
    }

    let out = "";
    let err = "";
    if (child.stdout) child.stdout.on("data", (c) => (out += c));
    if (child.stderr) child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("exit", () => {
      let arr = [];
      try {
        const j = JSON.parse(String(out).trim() || "[]");
        arr = Array.isArray(j) ? j : j && j.pid ? [j] : [];
      } catch {
        // 解析失败（无匹配时可能返回空）→ 当作空列表，但把 stderr 带上便于排查
        if (err.trim()) return reject(new Error("列举进程失败: " + err.trim().slice(0, 200)));
        arr = [];
      }
      resolve(
        arr
          .filter((p) => p && Number.isFinite(Number(p.pid)) && p.name === target)
          .map((p) => ({
            pid: Math.trunc(Number(p.pid)),
            name: String(p.name),
            path: String(p.path ?? ""),
            ws: Number(p.ws) || 0,
            cpuTicks: Number(p.cpuTicks) || 0,
          }))
      );
    });
  });
}

/**
 * 取某程序名「最合适用于定位文件」的可执行路径（纯函数，便于单测）。
 *
 * 同名可能对应多个进程（多实例 / 不同安装位置）。选择策略：
 *   - 优先**存在**的路径（有些受保护进程 ExecutablePath 为空，或文件已删）；
 *   - 多个不同路径时，取出现次数最多的那个（多数实例所在的位置最可能是「主程序」）；
 *   - 全部不存在 → 退回第一个非空路径（至少给用户一个线索），仍无 → null。
 *
 * @param {Array<{path?:string}>} processes
 * @param {(p:string)=>boolean} [exists] 便于测试注入
 * @returns {string|null}
 */
export function pickExecutablePath(processes, exists = existsSync) {
  const counts = new Map();
  for (const p of processes ?? []) {
    const path = String(p?.path ?? "").trim();
    if (!path) continue;
    counts.set(path, (counts.get(path) || 0) + 1);
  }
  if (counts.size === 0) return null;

  const paths = [...counts.keys()];
  const existing = paths.filter((p) => {
    try { return exists(p); } catch { return false; }
  });
  const pool = existing.length > 0 ? existing : paths;
  // 出现次数最多者胜；并列时取字典序，保证结果稳定
  pool.sort((a, b) => (counts.get(b) - counts.get(a)) || (a < b ? -1 : 1));
  return pool[0] || null;
}

/**
 * 在系统文件管理器中定位某程序的可执行文件（Windows 资源管理器选中该文件）。
 *
 * 两条路径：
 *   1) **快路径**：调用方传入 `cachedPath`（采样时已顺带取到的路径）→ 直接打开，
 *      无需再枚举进程，点击即刻生效；
 *   2) **回退**：没有缓存（进程刚启动还没采到、或受保护进程无路径）→ 现场枚举一次。
 *
 * @param {string} name 程序名
 * @param {object} opts
 * @param {string} [opts.cachedPath] 采样时缓存的可执行路径（快路径）
 * @param {(p:string)=>boolean} [opts.exists] 便于测试
 * @param {typeof nodeSpawn} [opts.spawnFn] 便于测试
 * @param {(p:string)=>Promise<Array>} [opts.listFn] 便于测试
 * @returns Promise<{ name, path, opened, reason }>
 */
export async function revealProcessFile(name, opts = {}) {
  const { exists = existsSync, spawnFn = nodeSpawn, listFn = listProcesses, cachedPath = "" } = opts;
  const target = String(name ?? "").trim();
  if (!target) throw new Error("缺少程序名");
  if (process.platform !== "win32") throw new Error("打开文件位置目前仅支持 Windows");

  // 快路径：用采样缓存里的路径，省掉一次冷启动枚举（约 2s）
  const cached = String(cachedPath ?? "").trim();
  if (cached) {
    if (!(await existsAsync(cached, exists))) {
      // 缓存过期（程序已更新/移动）→ 落到下面现场枚举一次
    } else {
      await openInExplorer(cached, spawnFn);
      return { name: target, path: cached, opened: true, reason: "" };
    }
  }

  const list = await listFn(target, { spawnFn });
  if (!list || list.length === 0) {
    return { name: target, path: "", opened: false, reason: "该程序此刻没有正在运行的进程" };
  }
  const path = pickExecutablePath(list, exists);
  if (!path) {
    return {
      name: target,
      path: "",
      opened: false,
      reason: "拿不到可执行文件路径（该进程受保护，或已被结束）",
    };
  }
  if (!(await existsAsync(path, exists))) {
    return { name: target, path, opened: false, reason: "可执行文件已不存在（可能已被删除或移动）" };
  }

  await openInExplorer(path, spawnFn);
  return { name: target, path, opened: true, reason: "" };
}

/**
 * 调 `explorer.exe /select,"<path>"` 打开所在目录并选中该文件。
 *
 * **关键**：路径（含空格，如 `C:\Program Files\...`）必须**只把路径本身**用引号
 * 包住，即命令行形态为 `/select,"C:\Program Files\App\app.exe"`。
 * 否则 Node 会把整个 `/select,C:\Program Files\App\app.exe` 参数用引号包起来，
 * explorer 就不再认识 `/select,` 开关，会打开错误的位置。
 * 因此这里显式拼 `/select,"..."`，并用 `windowsVerbatimArguments` 让 Node 原样传递。
 * 路径来自系统枚举（非用户输入），仍以独立参数交给 explorer，不做 shell 拼接。
 */
function openInExplorer(path, spawnFn) {
  return new Promise((resolve, reject) => {
    try {
      const child = spawnFn(
        existsSync(EXPLORER) ? EXPLORER : "explorer.exe",
        ['/select,"' + path + '"'],
        { detached: true, windowsHide: false, stdio: "ignore", windowsVerbatimArguments: true }
      );
      // explorer 常常不返回退出码，detached 后即可 unref；只兜住 spawn 自身错误
      if (child && typeof child.unref === "function") child.unref();
      child && child.on && child.on("error", reject);
      setTimeout(resolve, 120);
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/** exists 的异步友好包装（exists 是同步函数，这里统一成 Promise 语义） */
function existsAsync(path, exists) {
  try { return Promise.resolve(!!exists(path)); } catch { return Promise.resolve(false); }
}

/**
 * 终止某程序名对应的所有进程实例。
 *
 * @param {string} name 程序名（精确匹配，如 chrome.exe）
 * @param {object} opts
 * @param {number} opts.selfPid 调用方自己的 pid（插件后台进程），命中则拒绝
 * @param {boolean} [opts.force] 默认 true（/F）。false 时发温和的关闭请求
 * @param {typeof nodeSpawn} [opts.spawnFn]
 * @param {(p:string)=>Promise<Array>} [opts.listFn] 便于测试注入
 * @returns Promise<{ name, matched, killed, failed:[{pid,error}], skipped:[{pid,reason}] }>
 */
export async function killProcess(name, opts = {}) {
  const { selfPid = null, force = true, spawnFn = nodeSpawn, listFn = listProcesses } = opts;
  const target = String(name ?? "").trim();
  if (!target) throw new Error("缺少程序名");
  if (process.platform !== "win32") throw new Error("终止进程目前仅支持 Windows");

  const list = await listFn(target, { spawnFn });
  const killed = [];
  const failed = [];
  const skipped = [];

  for (const p of list) {
    if (selfPid != null && p.pid === selfPid) {
      skipped.push({ pid: p.pid, reason: "拒绝终止插件自身的采样进程" });
      continue;
    }
    try {
      await runTaskkill(p.pid, force, spawnFn);
      killed.push(p.pid);
    } catch (e) {
      failed.push({ pid: p.pid, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return { name: target, matched: list.length, killed: killed.length, killedPids: killed, failed, skipped };
}

/** 调 taskkill 结束单个 pid（含子进程树） */
function runTaskkill(pid, force, spawnFn) {
  return new Promise((resolve, reject) => {
    const exe = existsSync(TASKKILL) ? TASKKILL : "taskkill";
    const args = ["/PID", String(pid), "/T"];
    if (force) args.push("/F");
    let child;
    try {
      child = spawnFn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return reject(e);
    }
    let err = "";
    if (child.stdout) child.stdout.on("data", () => {});
    if (child.stderr) child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(err.trim() || `taskkill 退出码 ${code}`));
    });
  });
}
