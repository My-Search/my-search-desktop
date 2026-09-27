/**
 * 定位本机 ffmpeg / ffprobe（**纯探测逻辑**，只有少量 IO，可注入依赖以便单测）。
 *
 * ## 为什么不能直接 `spawn("ffmpeg")`
 *
 * 宿主启动插件后端进程时**刻意不继承 `PATH`**（见 plugin_host.rs 的注释：
 * 防止插件顺走 PATH 里的凭据）。所以在本进程里裸调 `ffmpeg` 必然 ENOENT，
 * 哪怕用户明明装了、命令行敲得动。必须自己按**绝对路径**找。
 *
 * ## 探测顺序（先便宜后昂贵，命中即停）
 *
 *   1. 用户在界面上手填的路径（最高优先级，允许指向目录或 exe）；
 *   2. **插件自带**（首次使用时下载到私有目录的那份，见 downloader.mjs）——
 *      排在系统探测之前，保证「装完插件就能用」且版本可预期；
 *   3. 插件私有配置里缓存的上次命中路径（只要文件还在就直接用）；
 *   4. 环境变量提示：`FFMPEG_PATH` / `FFMPEG_HOME` / `FFMPEG_BIN`；
 *   5. `where` / `which`（Windows 上经 `cmd /c where`，Unix 上直接 `which`；
 *      注意这依赖 shell 自己的搜索路径，进程 env 里没有 PATH 也能工作）；
 *   6. 常见安装目录扫描（scoop / chocolatey / winget / Program Files /
 *      C:\ffmpeg\bin / Homebrew / /usr/local/bin …）。
 *
 * 找不到不是错误——界面据此显示「一键下载」或「手动指定路径」。
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";

export const FFMPEG_BIN = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
export const FFPROBE_BIN = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";

/** 把「用户给的路径」归一成 exe 路径：允许填目录、也可填 exe 本身 */
export function resolveUserPath(p, binName = FFMPEG_BIN) {
  const s = String(p ?? "").trim().replace(/^"|"$/g, "");
  if (!s) return null;
  try {
    const st = statSync(s);
    if (st.isDirectory()) {
      const cand = join(s, binName);
      return existsSync(cand) ? cand : null;
    }
    if (st.isFile()) return s;
  } catch {
    return null;
  }
  return null;
}

/**
 * 常见安装位置的候选列表（按平台给）。
 *
 * `home`/`env` 由调用方注入，便于测试时伪造。只列出**目录**，函数会去
 * 每个目录里找 ffmpeg.exe；同时把 `.../bin` 这类子目录也一并覆盖。
 */
export function candidateDirs({ home = "", env = {}, platform = process.platform } = {}) {
  const out = [];
  const push = (...dirs) => {
    for (const d of dirs) if (d && !out.includes(d)) out.push(d);
  };

  if (platform === "win32") {
    const la = env.LOCALAPPDATA || (home ? join(home, "AppData", "Local") : "");
    const ra = env.APPDATA || (home ? join(home, "AppData", "Roaming") : "");
    push(
      "C:\\ffmpeg\\bin",
      "C:\\ffmpeg",
      "C:\\Program Files\\ffmpeg\\bin",
      "C:\\Program Files (x86)\\ffmpeg\\bin",
      "C:\\ProgramData\\chocolatey\\bin",
      join(la || "C:\\", "Microsoft", "WinGet", "Links"),
      join(ra || "C:\\", "scoop", "shims"),
      join(home || "C:\\", "scoop", "shims"),
      join(la || "C:\\", "Programs", "ffmpeg", "bin"),
      "C:\\tools\\ffmpeg\\bin"
    );
  } else {
    push(
      "/usr/bin",
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "/snap/bin",
      home ? join(home, ".local", "bin") : "",
      home ? join(home, "bin") : ""
    );
  }
  return out.filter(Boolean);
}

/** 在候选目录里找可执行文件 */
export function findInDirs(dirs, binName = FFMPEG_BIN) {
  for (const d of dirs) {
    const cand = join(d, binName);
    try {
      if (existsSync(cand) && statSync(cand).isFile()) return cand;
    } catch {
      // 目录不可读就跳过，不影响其它候选
    }
  }
  return null;
}

/** 执行 `where`/`which` 并把首行当作路径返回（失败返回 null） */
export function lookupViaShell(binName, { platform = process.platform, run = defaultRun } = {}) {
  const cmd = platform === "win32" ? "cmd.exe" : "sh";
  const args = platform === "win32" ? ["/c", "where", binName] : ["-lc", `command -v ${binName}`];
  return new Promise((resolve) => {
    run(cmd, args, { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      const first = String(stdout || "").split(/\r?\n/).map((l) => l.trim()).find(Boolean);
      if (!first) return resolve(null);
      // `where` 可能返回多个，取第一个真实存在的
      try {
        if (existsSync(first)) return resolve(first);
      } catch {}
      resolve(null);
    });
  });
}

/** 读版本号（成功说明这个 exe 确实能跑），失败返回 null */
export function probeVersion(exe, { run = defaultRun } = {}) {
  return new Promise((resolve) => {
    run(exe, ["-version"], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const m = /ffmpeg version\s+(\S+)/i.exec(String(stdout || ""));
      if (m) return resolve(m[1]);
      // 有些构建的 banner 不带 "version"，只要能跑就认
      resolve(String(stdout || "").trim() ? "unknown" : null);
    });
  });
}

function defaultRun(cmd, args, opts, cb) {
  return execFile(cmd, args, opts, cb);
}

/**
 * 主入口：找到可用的 ffmpeg（并顺带找 ffprobe）。
 *
 * @param {object} opts
 * @param {string} opts.userPath   用户在界面上填的路径（最高优先级）
 * @param {string} opts.bundledPath 插件自带（下载）的 ffmpeg 路径
 * @param {string} opts.cachedPath 上次探测缓存（次优先）
 * @param {object} opts.env        环境变量表（默认 process.env）
 * @param {string} opts.home       家目录
 * @param {Function} opts.run      注入的 execFile（单测用）
 * @param {boolean} opts.verify    是否执行 -version 校验（默认 true）
 * @returns {Promise<{found:boolean, path:string|null, version:string|null,
 *   probePath:string|null, probeFound:boolean, source:string|null,
 *   tried:string[]}>}
 */
export async function locateFfmpeg(opts = {}) {
  const {
    userPath = "",
    cachedPath = "",
    bundledPath = "",
    env = process.env,
    home = env.USERPROFILE || env.HOME || "",
    platform = process.platform,
    run = defaultRun,
    verify = true,
  } = opts;

  const binName = platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const probeName = platform === "win32" ? "ffprobe.exe" : "ffprobe";
  const tried = [];

  const verifyOrAccept = async (exe, source) => {
    tried.push(exe);
    if (!exe) return null;
    if (!verify) return { exe, version: null, source };
    const version = await probeVersion(exe, { run });
    return version ? { exe, version, source } : null;
  };

  /* 1. 用户手填（最高优先级：用户明确指定就听他的） */
  let hit = await verifyOrAccept(resolveUserPath(userPath, binName), "user");
  if (hit) return await finish(hit);

  /* 2. 插件自带（下载到私有目录的那份）——排在系统探测之前：
   *    既然用户装了本插件、我们也已经下好了，就用这份最可预期的版本 */
  if (bundledPath) {
    hit = await verifyOrAccept(resolveUserPath(bundledPath, binName), "bundled");
    if (hit) return await finish(hit);
  }

  /* 3. 上次缓存 */
  if (cachedPath && cachedPath !== userPath) {
    hit = await verifyOrAccept(resolveUserPath(cachedPath, binName), "cache");
    if (hit) return await finish(hit);
  }

  /* 4. 环境变量提示 */
  for (const key of ["FFMPEG_PATH", "FFMPEG_HOME", "FFMPEG_BIN"]) {
    const v = env[key];
    if (!v) continue;
    const exe = resolveUserPath(v, binName) || (env.FFMPEG_HOME ? resolveUserPath(join(env.FFMPEG_HOME, "bin"), binName) : null);
    hit = await verifyOrAccept(exe, "env:" + key);
    if (hit) return await finish(hit);
  }

  /* 5. shell 查找 */
  const viaShell = await lookupViaShell(binName, { platform, run });
  hit = await verifyOrAccept(viaShell, "shell");
  if (hit) return await finish(hit);

  /* 6. 常见目录 */
  const fromDirs = findInDirs(candidateDirs({ home, env, platform }), binName);
  hit = await verifyOrAccept(fromDirs, "common-dir");
  if (hit) return await finish(hit);

  return {
    found: false,
    path: null,
    version: null,
    probePath: null,
    probeFound: false,
    source: null,
    tried,
  };

  /** 找到 ffmpeg 后顺带定位 ffprobe（找不到也不影响录制，只是少个元数据能力） */
  async function finish(h) {
    let probePath = null;
    const sibling = join(h.exe, "..", probeName);
    if (existsSync(sibling)) probePath = sibling;
    else {
      const viaShell2 = await lookupViaShell(probeName, { platform, run });
      probePath = viaShell2 || findInDirs(candidateDirs({ home, env, platform }), probeName);
    }
    return {
      found: true,
      path: h.exe,
      version: h.version,
      probePath,
      probeFound: !!probePath,
      source: h.source,
      tried,
    };
  }
}
