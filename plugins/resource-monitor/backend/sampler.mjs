/**
 * 资源监控插件 —— 采样进程管理。
 *
 * 职责：把 `sample.ps1` 当作一个**长驻子进程**拉起，按行解析它 stdout 上的
 * JSON 快照，通过回调交给上层（index.mjs → aggregate.mjs）。进程意外退出时
 * 自动重启（带退避），stop() 时优雅收尾。
 *
 * 为什么用长驻脚本而不是每 5 秒新起一个 powershell：
 *   - 冷启动一个 PowerShell + 首次 CIM 查询要 ~1s，长驻后单拍只需 ~0.5s；
 *   - 避免每 5 秒一次的进程创建抖动，采样时间点也更稳定。
 *
 * 宿主不继承 PATH（见 recorder 插件的经验），因此 powershell 必须用绝对路径。
 * 找不到 powershell 时不算致命：上层会进入「不支持」状态并把原因显示在界面。
 */
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** 候选 powershell 绝对路径（Windows 自带；pwsh 为可选的新版 PowerShell） */
const WIN_PS_CANDIDATES = [
  join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  join(process.env.ProgramFiles || "C:\\Program Files", "PowerShell", "7", "pwsh.exe"),
  join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "PowerShell", "7", "pwsh.exe"),
];

/** 解析可用的 powershell；找不到返回 null（非 Windows 亦然） */
export function resolvePowerShell() {
  for (const p of WIN_PS_CANDIDATES) {
    try {
      if (existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * 创建一个采样器。
 * @param {object} opts
 * @param {string} opts.scriptPath   sample.ps1 的绝对路径
 * @param {number} [opts.intervalMs] 采样间隔（毫秒）
 * @param {(snap:object)=>void} opts.onSnapshot  解析出一条快照
 * @param {(err:Error)=>void}   [opts.onError]
 * @param {(level:string,msg:string)=>void} [opts.log]
 * @param {typeof nodeSpawn} [opts.spawnFn] 便于测试注入
 */
export function createSampler(opts) {
  const {
    scriptPath,
    intervalMs = 5000,
    onSnapshot,
    onError = () => {},
    log = () => {},
    spawnFn = nodeSpawn,
  } = opts;

  let child = null;
  let stopping = false;
  let restarts = 0;
  let lastLineAt = 0;
  let stderrTail = "";
  let restartTimer = null;
  let buf = "";

  function handleLine(line) {
    const s = String(line).trim();
    if (!s) return;
    let snap;
    try {
      snap = JSON.parse(s);
    } catch {
      // 非 JSON 行（脚本偶发警告等）：记日志，丢弃
      log("warn", "采样行无法解析: " + s.slice(0, 160));
      return;
    }
    if (snap && snap.err) {
      // 脚本自报的单拍错误：交给上层跳过，不触发重启
      onError(new Error("采样脚本报错: " + snap.err));
      return;
    }
    lastLineAt = Date.now();
    try {
      onSnapshot(snap);
    } catch (e) {
      onError(e instanceof Error ? e : new Error(String(e)));
    }
  }

  function scheduleRestart(reason) {
    if (stopping) return;
    // 指数退避：1s、2s、4s… 上限 30s，避免崩溃风暴
    const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(restarts, 5)));
    restarts += 1;
    log("warn", `采样进程退出（${reason}），${delay}ms 后重启（第 ${restarts} 次）`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      start();
    }, delay);
    if (typeof restartTimer.unref === "function") restartTimer.unref();
  }

  function start() {
    if (child || stopping) return;
    const ps = resolvePowerShell();
    if (!ps) {
      onError(new Error("未找到 Windows PowerShell，无法采样（本插件目前仅支持 Windows）"));
      return;
    }
    try {
      child = spawnFn(
        ps,
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          scriptPath,
          "-IntervalMs",
          String(Math.max(1000, Math.trunc(intervalMs))),
        ],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
      );
    } catch (e) {
      child = null;
      onError(e instanceof Error ? e : new Error(String(e)));
      scheduleRestart("spawn 失败");
      return;
    }

    log("info", "采样进程已启动 pid=" + child.pid);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        handleLine(line);
      }
      // 防御：单行异常长（不该发生）时截断，避免内存无限增长
      if (buf.length > 4 * 1024 * 1024) buf = "";
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
    });
    child.on("error", (e) => {
      onError(e instanceof Error ? e : new Error(String(e)));
    });
    child.on("exit", (code, signal) => {
      child = null;
      buf = "";
      if (stopping) return;
      const tail = stderrTail.trim().split(/\r?\n/).slice(-2).join(" | ");
      scheduleRestart(`code=${code} signal=${signal}${tail ? " :: " + tail : ""}`);
      stderrTail = "";
    });
  }

  function stop() {
    stopping = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    const c = child;
    child = null;
    if (!c || c.exitCode != null) return;
    try {
      // 先礼后兵：脚本会在读到 stdin 关闭 / SIGTERM 后退出
      c.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    const t = setTimeout(() => {
      try {
        c.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, 1500);
    if (typeof t.unref === "function") t.unref();
  }

  return {
    start,
    stop,
    get pid() {
      return child ? child.pid : null;
    },
    get running() {
      return child != null;
    },
    get restarts() {
      return restarts;
    },
    get lastLineAt() {
      return lastLineAt;
    },
  };
}
