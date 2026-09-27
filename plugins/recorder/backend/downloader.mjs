/**
 * 自带 ffmpeg 的下载 / 校验 / 解包（**纯逻辑 + 少量 IO，依赖可注入以便单测**）。
 *
 * ## 为什么是「下载」而不是「打进插件包」
 *
 * 宿主安装管线对**单文件**有 64MB 上限（`src-tauri/src/plugin_host.rs` 的
 * `MAX_FILE_BYTES` 与前端 `package.ts` 的 `MAX_ENTRY_BYTES` 都是），而完整版
 * ffmpeg.exe 通常 80–130MB——**装不进 .mspp**。因此改为「首次使用时下载到
 * 插件私有目录」：
 *
 *   - 不把几十 MB 二进制提交进 git、不撑大安装包；
 *   - 可以按平台分发对应构建（Windows / macOS / Linux）；
 *   - 用户仍可离线使用「自行安装的 ffmpeg」（探测链优先，见 ffmpeg.mjs）。
 *
 * ## 下载源与校验
 *
 * 默认用 **BtbN/FFmpeg-Builds** 的 GitHub Release 资产（Windows）与
 * **evermeet.cx**（macOS）/ **johnvansickle.com**（Linux）的静态构建。
 * 这些是社区长期维护的静态包，体积适中（Windows 精简包约 30–40MB）。
 *
 * 校验策略（分层，任何一层不过就**丢弃整包**）：
 *   1. 只允许 https，且主机名白名单（防被改成任意 URL）；
 *   2. 下载完成后算 sha256：若清单给了 expectedSha256 就强校验；
 *   3. 解包后必须真的能跑（`-version`）——这是最终防线，
 *      因为「文件在」不等于「是可执行文件」。
 *
 * 注意：**不信任 Content-Length**（可能缺失或撒谎），进度以累计字节为准。
 */
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";

/** 允许的下载主机（白名单；防清单被篡改后指向任意地址） */
export const ALLOWED_HOSTS = [
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "evermeet.cx",
  "johnvansickle.com",
  // 只用于「把 github.com 资产换算出直链」，不用于下载大文件本身
  "api.github.com",
];

/** 判定 URL 是否可信：必须 https、主机在白名单、且无 userinfo、端口为默认 */
export function isTrustedUrl(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  if (u.port && u.port !== "443") return false;
  const host = u.hostname.toLowerCase();
  return ALLOWED_HOSTS.some((h) => host === h || host.endsWith("." + h));
}

/**
 * 把 `github.com/<owner>/<repo>/releases/download/<tag>/<file>` 解析成
 * **CDN 直链**（`release-assets.githubusercontent.com`）。
 *
 * ## 为什么需要这一步（这是真实踩到的坑）
 *
 * 很多网络环境**能通 GitHub 的 CDN，却连不上 `github.com` 本身**
 * （实测：`github.com:443` 超时，而 `release-assets.githubusercontent.com`
 * 可直连）。此时直接 GET 资产地址会在建连阶段就挂掉，报
 * `UND_ERR_CONNECT_TIMEOUT`，用户看到的就是「下载失败」。
 *
 * 而 `api.github.com` 通常是通的，它提供 `assets/{id}` 端点：
 * 带 `Accept: application/octet-stream` 请求会返回 **302 + Location 指向 CDN**。
 * 于是「连不上 github.com」也能下载成功。
 *
 * 解析失败不抛错——调用方回退到原始 URL（直连环境本来就不需要这一步）。
 *
 * @returns {Promise<string|null>} 直链；无法解析时 null
 */
export async function resolveGithubAsset(url, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") return null;

  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/(.+)$/.exec(String(url));
  if (!m) return null;
  const [, owner, repo, tag, file] = m;

  const headers = {
    "User-Agent": opts.userAgent || "my-search-recorder-plugin",
    Accept: "application/vnd.github+json",
  };
  const timeoutMs = Number(opts.timeoutMs) || 20000;
  const withTimeout = async (fn) => {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeoutMs);
    try {
      return await fn(c.signal);
    } finally {
      clearTimeout(t);
    }
  };

  try {
    // 1. 找资产 id（用固定 tag，避免依赖 /latest 的解析）
    const relRes = await withTimeout((signal) =>
      fetchImpl(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`, {
        headers, signal, redirect: "follow",
      }),
    );
    if (!relRes || !relRes.ok) return null;
    const rel = await relRes.json();
    const asset = (rel.assets || []).find((a) => a && a.name === decodeURIComponent(file));
    if (!asset || asset.id == null) return null;

    // 2. 换直链：Accept: octet-stream 会 302 到 CDN，手动读 Location
    const accRes = await withTimeout((signal) =>
      fetchImpl(`https://api.github.com/repos/${owner}/${repo}/releases/assets/${asset.id}`, {
        headers: { ...headers, Accept: "application/octet-stream" },
        signal, redirect: "manual",
      }),
    );
    if (!accRes) return null;
    const loc = accRes.headers && accRes.headers.get && accRes.headers.get("location");
    if (!loc) return null;
    // 直链必须仍然可信（防 API 被劫持后把我们导向任意地址）
    return isTrustedUrl(loc) ? loc : null;
  } catch {
    return null;
  }
}

/**
 * 各平台的默认下载清单。
 *
 * `kind` 决定解包方式：
 *   - "zip"    → 需要系统自带解压能力（Windows 用 PowerShell Expand-Archive，
 *                macOS/Linux 用 unzip）；
 *   - "tar.xz" → 用系统 tar（Windows 10+ 自带 bsdtar，可解 xz）。
 *
 * 为什么走系统工具而不是纯 JS 解压：Node 没有内置 zip/xz 解压，
 * 而引入 npm 依赖会破坏「后端零依赖、装上即用」这一前提。
 */
export function defaultSources(platform = process.platform, arch = process.arch) {
  if (platform === "win32") {
    // BtbN 的 win64 gpl-shared/static 构建；用 latest 标签下的固定资产名
    const archTag = arch === "arm64" ? "winarm64" : "win64";
    return [
      {
        id: "btbn-win64-gpl",
        kind: "zip",
        url: `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-${archTag}-gpl.zip`,
        // 只取包内的 ffmpeg.exe / ffprobe.exe（zip 里嵌套多层目录）
        pick: ["ffmpeg.exe", "ffprobe.exe"],
        // 已知归档大小（用于下载前的磁盘空间预检；实测 2025-09 为 196MB）
        approxBytes: 196 * 1024 * 1024,
        expectedSha256: null, // GitHub latest 资产无稳定摘要，靠「解包后能否运行」兜底
      },
    ];
  }
  if (platform === "darwin") {
    return [
      {
        id: "evermeet-macos",
        kind: "zip",
        url: "https://evermeet.cx/ffmpeg/getrelease/zip",
        pick: ["ffmpeg"],
        approxBytes: 80 * 1024 * 1024,
        expectedSha256: null,
      },
    ];
  }
  // Linux：johnvansickle 静态构建（amd64 / arm64）
  const a = arch === "arm64" ? "arm64" : "amd64";
  return [
    {
      id: `jvs-linux-${a}`,
      kind: "tar.xz",
      url: `https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${a}-static.tar.xz`,
      pick: ["ffmpeg", "ffprobe"],
      approxBytes: 40 * 1024 * 1024,
      expectedSha256: null,
    },
  ];
}

/** 可读的字节数 */
export function humanSize(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + " MB";
  return (b / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

/**
 * 查目标目录所在卷的可用空间（字节）。
 *
 * 为什么需要：完整包接近 200MB，解包时还要再占一份，加起来约 500MB。
 * 磁盘满的时候 `fetch` 会在写到一半时抛 `ENOSPC`，用户看到的是
 * 「下载失败」而完全猜不到是磁盘问题——所以要在动手**之前**就查清楚。
 *
 * 查不到就返回 null（不阻断下载）——宁可不拦，也不要因为探测失败误杀。
 */
export async function freeSpaceAt(dir) {
  try {
    const { statfs } = await import("node:fs/promises");
    const st = await statfs(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

/** 下载 + 解包大致需要多少空间（保守估计：包体 ×2.5 + 64MB 余量） */
export function estimatedNeed(archiveBytes) {
  const b = Number(archiveBytes) || 0;
  if (!b) return 0;
  return Math.ceil(b * 2.5) + 64 * 1024 * 1024;
}

/**
 * 下载前的空间预检。空间不足时抛出**可读**的错误，而不是等 ENOSPC。
 *
 * @param {string} dir        落地目录
 * @param {number} needBytes  预计需要
 */
export async function assertSpaceFor(dir, needBytes, opts = {}) {
  const freeFn = opts.freeSpace || freeSpaceAt;
  const free = await freeFn(dir);
  if (free == null) return { free: null }; // 探测不到就不拦
  if (free < needBytes) {
    const e = new Error(
      `磁盘空间不足：所在分区只剩 ${humanSize(free)}，` +
      `下载并解包大约需要 ${humanSize(needBytes)}。请清理磁盘后重试，` +
      `或在「设置」里手动指定已安装的 ffmpeg 路径（不占额外空间）。`
    );
    e.code = "ENOSPC_PREFLIGHT";
    throw e;
  }
  return { free };
}

/**
 * 流式下载到文件，边下边算 sha256 并按节流回调进度。
 *
 * @param {string} url
 * @param {string} dest            目标文件路径
 * @param {object} opts
 * @param {Function} opts.fetchImpl  注入的 fetch（默认全局 fetch）
 * @param {Function} opts.onProgress ({received, total, percent}) => void
 * @param {number}  opts.timeoutMs   单次请求超时（默认 120s）
 * @returns {Promise<{bytes:number, sha256:string, contentType:string}>}
 */
export async function downloadToFile(url, dest, opts = {}) {
  if (!isTrustedUrl(url)) throw new Error("拒绝下载：URL 不在可信白名单内（" + url + "）");
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("当前 Node 环境没有 fetch，无法下载");

  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : () => {};
  // 默认 10 分钟：这是一个约 200MB 的包，120s 的短超时会把慢速网络直接判死
  const timeoutMs = Number(opts.timeoutMs) || 600000;
  const userAgent = opts.userAgent || "my-search-recorder-plugin";

  /** 真正发起一次流式下载；失败时清掉半成品文件，避免留下截断的归档 */
  const attempt = async (target) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    mkdirSync(join(dest, ".."), { recursive: true });
    const hash = createHash("sha256");
    let received = 0;
    try {
      const res = await fetchImpl(target, {
        signal: controller.signal,
        redirect: "follow", // 会 302 到 objects/release-assets.githubusercontent.com（均在白名单）
        headers: { "User-Agent": userAgent },
      });
      if (!res.ok) throw new Error(`下载失败：HTTP ${res.status} ${res.statusText || ""}`.trim());
      if (!res.body) throw new Error("下载失败：响应没有 body");

      const total = Number(res.headers.get("content-length")) || 0;
      const out = createWriteStream(dest);
      const source = Readable.fromWeb(res.body);

      source.on("data", (chunk) => {
        received += chunk.length;
        hash.update(chunk);
        onProgress({
          received,
          total,
          percent: total > 0 ? Math.min(100, (received / total) * 100) : 0,
        });
      });

      await pipeline(source, out);
      return { bytes: received, sha256: hash.digest("hex"), contentType: "", resolvedUrl: target };
    } catch (e) {
      try { rmSync(dest, { force: true }); } catch {}
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };

  // 先用直链；连不上 github.com 的网络里，这一步会在建连阶段就超时，
  // 此时改用 api.github.com 换算出 CDN 直链再试一次。
  try {
    return await attempt(url);
  } catch (e) {
    const direct = await resolveGithubAsset(url, { fetchImpl, timeoutMs: opts.resolveTimeoutMs, userAgent });
    if (!direct || direct === url) throw e;
    opts.onResolved && opts.onResolved(direct);
    return await attempt(direct);
  }
}

/** 计算文件 sha256（校验用；流式，避免把大文件读进内存） */
export async function sha256File(path) {
  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/**
 * 用系统工具解包，然后把 `pick` 里的可执行文件挑出来放到 `outDir`。
 *
 * 解包到临时目录后**只搬运需要的文件**——zip 里可能带一堆 doc/许可文件，
 * 没必要留下（也减少「插件的私有目录里为什么有奇怪文件」的困惑）。
 */
export async function extractAndPick(archivePath, kind, pick, outDir, opts = {}) {
  const run = opts.run || defaultRun;
  const tmp = opts.tmpDir || archivePath + ".x";
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  try {
    if (kind === "zip") {
      if (process.platform === "win32") {
        // Windows 10+ 自带 tar.exe（bsdtar）能解 zip，且不必依赖 PowerShell
        // 的执行策略；两者都失败再退回 Expand-Archive。
        try {
          await run("tar.exe", ["-xf", archivePath, "-C", tmp]);
        } catch {
          await run("powershell.exe", [
            "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
            "-Command", `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${tmp}' -Force`,
          ]);
        }
      } else {
        await run("unzip", ["-o", "-q", archivePath, "-d", tmp]);
      }
    } else if (kind === "tar.xz" || kind === "tar.gz" || kind === "tar") {
      const flag = kind === "tar.xz" ? "-xJf" : kind === "tar.gz" ? "-xzf" : "-xf";
      await run("tar", [flag, archivePath, "-C", tmp]);
    } else {
      throw new Error("不支持的压缩格式: " + kind);
    }

    // 深度优先找 pick 里的文件（zip 内通常有顶层目录）
    const found = {};
    const walk = (dir, depth) => {
      if (depth > 4) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full, depth + 1);
        else if (pick.includes(e.name) && !found[e.name]) {
          found[e.name] = full;
        }
      }
    };
    walk(tmp, 0);

    const placed = {};
    for (const name of pick) {
      if (!found[name]) {
        // ffprobe 缺失是允许的（只影响元数据读取），ffmpeg 缺失才是硬错误
        if (name === "ffprobe" || name === "ffprobe.exe") continue;
        throw new Error(`压缩包里没有找到 ${name}（可能是下载源结构变了）`);
      }
      const dest = join(outDir, name);
      rmSync(dest, { force: true });
      // 用 fs.copyFileSync 而不是 rename：跨盘/跨分区 rename 会失败
      const { copyFileSync, chmodSync } = await import("node:fs");
      copyFileSync(found[name], dest);
      if (process.platform !== "win32") {
        try { chmodSync(dest, 0o755); } catch {}
      }
      placed[name] = dest;
    }
    return placed;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(archivePath, { force: true });
  }
}

function defaultRun(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: opts.timeout || 120000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message || "").trim().split(/\r?\n/).slice(-3).join(" | ") || err.message));
      resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

/**
 * 下载 → 校验 → 解包的完整流程。
 *
 * @param {object} opts
 * @param {string} opts.binDir       落地目录（插件私有目录下的 ffmpeg/）
 * @param {object} opts.source       下载源（默认取 defaultSources()[0]）
 * @param {Function} opts.fetchImpl
 * @param {Function} opts.run
 * @param {Function} opts.onProgress ({phase, percent, received, total, message}) => void
 * @param {Function} opts.verify     解包后校验可运行性（返回 version 或 null）
 * @returns {Promise<{ok:boolean, ffmpeg:string|null, ffprobe:string|null, version:string|null, bytes:number, source:string}>}
 */
export async function provisionFfmpeg(opts = {}) {
  const binDir = opts.binDir;
  if (!binDir) throw new Error("缺少落地目录");
  const source = opts.source || defaultSources()[0];
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : () => {};
  const platform = opts.platform || process.platform;
  const archiveExt = source.kind === "zip" ? ".zip" : source.kind === "tar.xz" ? ".tar.xz" : ".tar";
  const archive = join(binDir, "download" + archiveExt);

  mkdirSync(binDir, { recursive: true });

  // 空间预检：磁盘满时宁可在动手前就说清楚，也不要下到一半 ENOSPC
  const need = estimatedNeed(source.approxBytes);
  if (need > 0) {
    if (typeof opts.assertSpace === "function") {
      await opts.assertSpace(need);
    } else {
      await assertSpaceFor(binDir, need);
    }
  }

  onProgress({ phase: "download", percent: 0, received: 0, total: 0, message: "开始下载 " + source.id });
  const dl = await downloadToFile(source.url, archive, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
    onResolved: opts.onResolved,
    onProgress: (p) => onProgress({ phase: "download", ...p, message: `下载中 ${humanSize(p.received)}` }),
  });

  // 有期望摘要就强校验（当前清单为 null，留作将来加签）
  if (source.expectedSha256) {
    if (dl.sha256.toLowerCase() !== String(source.expectedSha256).toLowerCase()) {
      rmSync(archive, { force: true });
      throw new Error("下载文件校验失败（sha256 不匹配），已丢弃");
    }
    onProgress({ phase: "verify", percent: 100, message: "校验通过" });
  }

  onProgress({ phase: "extract", percent: 100, message: "正在解包…" });
  const placed = await extractAndPick(archive, source.kind, source.pick, binDir, {
    run: opts.run,
    tmpDir: join(binDir, ".tmp-extract"),
  });

  const ffmpeg = placed["ffmpeg.exe"] || placed["ffmpeg"] || null;
  const ffprobe = placed["ffprobe.exe"] || placed["ffprobe"] || null;
  if (!ffmpeg) throw new Error("解包后没有找到 ffmpeg 可执行文件");

  // 最终防线：真的能跑起来才算成功
  let version = null;
  if (typeof opts.verify === "function") {
    version = await opts.verify(ffmpeg);
    if (!version) {
      try { rmSync(ffmpeg, { force: true }); } catch {}
      throw new Error("下载到的 ffmpeg 无法运行（可能是平台不匹配或文件损坏）");
    }
  }

  onProgress({ phase: "done", percent: 100, message: "就绪" + (version ? "（v" + version + "）" : "") });
  return { ok: true, ffmpeg, ffprobe, version, bytes: dl.bytes, source: source.id, platform };
}

/** 已落地目录里是否已有可用的 ffmpeg（避免重复下载） */
export function existingBundled(binDir, platform = process.platform) {
  const name = platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const p = join(binDir, name);
  try {
    return existsSync(p) && statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}
