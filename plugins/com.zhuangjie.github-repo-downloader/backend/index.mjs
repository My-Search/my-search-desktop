/**
 * GitHub 仓库搜索与批量下载器 —— 后端（JSON-RPC over stdio，零 npm 依赖）
 *
 * 职责：
 *   - `search`         调 GitHub Search API 搜索仓库（只返回仓库条目，不碰代码/文件）；
 *   - `getConfig`      返回是否已配置 Token / API 地址 / 代理（**绝不回传 Token 本身**）；
 *   - `setConfig`      保存 Token / API 地址 / 代理到插件自己的数据目录；
 *   - `testToken`      校验 Token 并读取当前账号与配额；
 *   - `downloadStart`  创建批量下载任务（立即返回 jobId，下载在后台继续）；
 *   - `getJob`         查询任务快照（界面关闭再打开时可恢复进度）；
 *   - `cancelDownload` 取消任务（删除未完成的临时文件）；
 *   - `openFolder`     用系统文件管理器打开下载目录。
 *
 * 为什么下载必须走后台：插件前端只能通过系统「另存为」逐个写文件，
 * 而「批量下载到用户选择的文件夹」需要流式写盘 + 进度 + 取消 + 合并 ZIP，
 * 这些只有本机 Node 进程能做。搜索也放在这里，Token 因此只存在于后端进程，
 * 不会出现在插件前端 JS / localStorage 里。
 *
 * 安全约束（有意为之）：
 *   1. Token 只落在 `MS_PLUGIN_DATA_DIR/config.json`，不回传前端；
 *   2. 下载目标目录必须由前端通过系统文件夹选择框拿到，且必须已存在；
 *   3. 子目录名/文件名都做 Windows 非法字符与 `..` 过滤，写入路径必须落在目标目录内；
 *   4. 合并 ZIP 不执行任何外部命令，纯 Node 实现（避免 shell 注入与平台差异）。
 *
 * 平台：Windows / macOS / Linux（仅依赖 Node.js 18+ 内置模块）。
 */
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import tls from "node:tls";
import net from "node:net";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";

// ===================== JSON-RPC 基础 =====================

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function sendError(id, message) {
  send({ jsonrpc: "2.0", id, error: { message: String(message) } });
}
function sendNotification(method, params) {
  send({ jsonrpc: "2.0", method, params });
}
function sendLog(level, message) {
  sendNotification("log", { level, message });
}

const VERSION = "1.0.0";
const USER_AGENT = `my-search-github-repo-downloader/${VERSION}`;
const DEFAULT_API_BASE = "https://api.github.com";
const IS_WIN = process.platform === "win32";

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.MS_PLUGIN_DATA_DIR
  ? path.resolve(process.env.MS_PLUGIN_DATA_DIR)
  : path.join(PLUGIN_DIR, ".data");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

// ===================== 配置（Token / API / 代理） =====================

const DEFAULT_CONFIG = {
  token: "",
  apiBase: DEFAULT_API_BASE,
  proxy: "",
};

/** 校验并归一化 API 地址：只允许 https，去掉尾部斜杠 */
function normalizeApiBase(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return DEFAULT_API_BASE;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error("API 地址格式不正确（需要形如 https://api.github.com）");
  }
  if (u.protocol !== "https:") throw new Error("API 地址必须是 https:// 开头");
  u.hash = "";
  u.search = "";
  const href = u.toString().replace(/\/+$/, "");
  return href || DEFAULT_API_BASE;
}

/** 校验并归一化代理地址：暂只支持 http:// 的 CONNECT 代理（如 Clash 的 7890 端口） */
function normalizeProxy(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error("代理地址格式不正确（需要形如 http://127.0.0.1:7890）");
  }
  if (u.protocol !== "http:") {
    throw new Error("暂只支持 http:// 代理（如 http://127.0.0.1:7890）；https 代理请先用 http 端口转发");
  }
  if (!u.hostname) throw new Error("代理地址缺少主机名");
  u.pathname = "/";
  return u.toString().replace(/\/+$/, "");
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const cfg = { ...DEFAULT_CONFIG };
    if (typeof parsed?.token === "string") cfg.token = parsed.token.trim();
    if (typeof parsed?.apiBase === "string" && parsed.apiBase.trim()) {
      try {
        cfg.apiBase = normalizeApiBase(parsed.apiBase);
      } catch {
        cfg.apiBase = DEFAULT_API_BASE;
      }
    }
    if (typeof parsed?.proxy === "string" && parsed.proxy.trim()) {
      try {
        cfg.proxy = normalizeProxy(parsed.proxy);
      } catch {
        cfg.proxy = "";
      }
    }
    return cfg;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = CONFIG_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", "utf8");
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {
      /* Windows 没有 POSIX 权限位，忽略 */
    }
    fs.renameSync(tmp, CONFIG_PATH);
  } catch (e) {
    throw new Error(`保存配置失败：${e?.message || e}`);
  }
}

let config = loadConfig();
/** 运行时状态（不落盘） */
const state = {
  login: "",
  rate: {
    search: null,
    core: null,
  },
  searchCache: new Map(),
  searchCacheMax: 24,
  searchCacheTtlMs: 90_000,
};

// ===================== HTTP（直连 / HTTP CONNECT 代理） =====================

/**
 * 与代理建立 CONNECT 隧道，返回一条已经连通的原始 socket。
 * 仅支持 http:// 代理（绝大多数本地代理客户端都提供 HTTP 端口）。
 */
function tunnelThroughProxy(proxyUrl, targetHost, targetPort, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = new URL(proxyUrl);
    const proxyPort = Number(p.port) || 80;
    const socket = net.connect({ host: p.hostname, port: proxyPort });
    let settled = false;
    const timer = setTimeout(() => fail(new Error("连接代理超时")), timeoutMs);
    if (timer.unref) timer.unref();

    function fail(e) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      reject(e);
    }

    socket.once("error", (e) => fail(new Error(`连接代理失败：${e.message}`)));
    socket.once("connect", () => {
      let buf = "";
      const onData = (chunk) => {
        buf += chunk.toString("latin1");
        const idx = buf.indexOf("\r\n\r\n");
        if (idx < 0) {
          if (buf.length > 16 * 1024) fail(new Error("代理响应异常（CONNECT 头过大）"));
          return;
        }
        socket.removeListener("data", onData);
        const statusLine = buf.slice(0, idx).split("\r\n")[0] || "";
        const m = /^HTTP\/1\.[01]\s+(\d{3})/i.exec(statusLine);
        const code = m ? Number(m[1]) : 0;
        if (code !== 200) {
          fail(new Error(`代理拒绝连接（HTTP ${code || "?"}），请检查代理是否允许 CONNECT`));
          return;
        }
        clearTimeout(timer);
        settled = true;
        resolve(socket);
      };
      socket.on("data", onData);
      const auth = p.username
        ? `Proxy-Authorization: Basic ${Buffer.from(
            `${decodeURIComponent(p.username)}:${decodeURIComponent(p.password || "")}`
          ).toString("base64")}\r\n`
        : "";
      socket.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
          `Host: ${targetHost}:${targetPort}\r\n` +
          `Proxy-Connection: keep-alive\r\n` +
          auth +
          `\r\n`
      );
    });
  });
}

/**
 * 发一个 HTTPS 请求，返回响应流（不读取 body）。
 * 支持直连与 HTTP CONNECT 代理，支持超时与 AbortSignal。
 */
function requestHttps(urlStr, opts = {}) {
  const { method = "GET", headers = {}, timeoutMs = 30_000, signal = null } = opts;
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch {
      reject(new Error("非法 URL"));
      return;
    }
    if (u.protocol !== "https:") {
      reject(new Error("仅支持 HTTPS 请求"));
      return;
    }
    const host = u.hostname;
    const port = Number(u.port) || 443;
    const reqPath = `${u.pathname}${u.search}`;
    let req = null;
    let settled = false;

    function fail(e) {
      if (settled) return;
      settled = true;
      try {
        req?.destroy();
      } catch {
        /* ignore */
      }
      reject(e);
    }
    function succeed(res) {
      if (settled) {
        try {
          res.resume();
        } catch {
          /* ignore */
        }
        return;
      }
      settled = true;
      resolve(res);
    }

    function start(createConnection) {
      const options = {
        method,
        headers,
        host,
        port,
        path: reqPath,
        agent: false,
        ...(createConnection ? { createConnection } : {}),
      };
      req = https.request(options, succeed);
      if (signal) {
        if (signal.aborted) {
          req.destroy(new Error("已取消"));
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            try {
              req.destroy(new Error("已取消"));
            } catch {
              /* ignore */
            }
          },
          { once: true }
        );
      }
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）`)));
      req.on("error", (e) => fail(e));
      req.end();
    }

    if (!config.proxy) {
      start(null);
      return;
    }
    tunnelThroughProxy(config.proxy, host, port, timeoutMs)
      .then((raw) => {
        const tlsSocket = tls.connect({ socket: raw, servername: host });
        let tlsDone = false;
        tlsSocket.once("error", (e) => {
          try {
            raw.destroy();
          } catch {
            /* ignore */
          }
          fail(new Error(`代理 TLS 握手失败：${e.message}`));
        });
        tlsSocket.once("secureConnect", () => {
          if (tlsDone) return;
          tlsDone = true;
          start(() => tlsSocket);
        });
        tlsSocket.setTimeout(timeoutMs, () => {
          try {
            tlsSocket.destroy();
          } catch {
            /* ignore */
          }
          fail(new Error("代理连接超时"));
        });
      })
      .catch((e) => fail(e));
  });
}

/** 跟随重定向（最多 6 跳）；跨主机时丢弃 Authorization，避免把 Token 带给 codeload */
async function requestWithRedirects(urlStr, opts, maxHops = 6) {
  let current = urlStr;
  let currentOpts = { ...opts, headers: { ...(opts.headers || {}) } };
  const originalHost = new URL(urlStr).hostname;
  for (let hop = 0; hop <= maxHops; hop++) {
    const res = await requestHttps(current, currentOpts);
    const code = res.statusCode || 0;
    if ([301, 302, 303, 307, 308].includes(code)) {
      const loc = res.headers.location;
      if (!loc) throw new Error(`HTTP ${code} 但缺少 Location`);
      let next;
      try {
        next = new URL(loc, current);
      } catch {
        throw new Error("重定向地址非法");
      }
      if (next.protocol !== "https:") throw new Error("拒绝非 HTTPS 重定向");
      try {
        res.resume();
      } catch {
        /* ignore */
      }
      if (next.hostname !== originalHost) {
        const headers = { ...(currentOpts.headers || {}) };
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === "authorization") delete headers[key];
        }
        currentOpts = { ...currentOpts, headers };
      }
      if (code === 303) currentOpts = { ...currentOpts, method: "GET" };
      current = next.toString();
      continue;
    }
    return { res, finalUrl: current };
  }
  throw new Error("重定向次数过多");
}

/** 读取响应体（有上限，防止异常响应撑爆内存） */
async function readBody(res, maxBytes = 8 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of res) {
    total += chunk.length;
    if (total > maxBytes) throw new Error(`响应过大（上限 ${Math.round(maxBytes / 1024 / 1024)} MB）`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// ===================== GitHub API =====================

function parseRate(headers) {
  const pick = (name) => {
    const raw = headers?.[name];
    if (raw == null || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  return {
    limit: pick("x-ratelimit-limit"),
    remaining: pick("x-ratelimit-remaining"),
    reset: pick("x-ratelimit-reset"),
    used: pick("x-ratelimit-used"),
  };
}

function apiErrorMessage(status, data, rate, pathname) {
  const msg = String(data?.message || "").trim();
  if (status === 401) return "Token 无效或已过期，请在「设置」中重新填写 GitHub Token";
  if (status === 403 || status === 429) {
    if (rate?.remaining === 0) {
      const reset = rate?.reset ? new Date(rate.reset * 1000) : null;
      const when = reset ? `，${reset.toLocaleTimeString("zh-CN", { hour12: false })} 重置` : "";
      return `GitHub API 配额已用完${when}。配置 Token 后配额会大幅提高（搜索 10 → 30 次/分钟）`;
    }
    return `GitHub 拒绝访问${msg ? `：${msg}` : "（可能是 Token 权限不足或触发了二级限流）"}`;
  }
  if (status === 422) return `搜索条件不合法${msg ? `：${msg}` : ""}（检查筛选值或 GitHub 搜索语法）`;
  if (status === 404) return "接口不存在或仓库不可见（私有仓库需要有效 Token）";
  if (status >= 500) return `GitHub 服务暂时不可用（HTTP ${status}）${msg ? `：${msg}` : ""}`;
  return `GitHub API 请求失败（HTTP ${status}）${msg ? `：${msg}` : ""}`;
}

/**
 * 调 GitHub REST API（JSON）。
 * @param {string} pathname 以 / 开头的路径
 * @param {Record<string,string|number>|null} query
 * @param {{token?:string, timeoutMs?:number}} extra
 */
async function githubApi(pathname, query = null, extra = {}) {
  const token = extra.token !== undefined ? String(extra.token || "") : config.token;
  const base = config.apiBase.replace(/\/+$/, "");
  const u = new URL(base + pathname);
  if (query && typeof query === "object") {
    for (const [key, value] of Object.entries(query)) {
      if (value == null || value === "") continue;
      u.searchParams.set(key, String(value));
    }
  }
  const headers = {
    "User-Agent": USER_AGENT,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const { res } = await requestWithRedirects(u.toString(), {
    headers,
    timeoutMs: extra.timeoutMs ?? 25_000,
  });
  const rate = parseRate(res.headers);
  const body = await readBody(res, 8 * 1024 * 1024);
  let data = null;
  if (body.length > 0) {
    try {
      data = JSON.parse(body.toString("utf8"));
    } catch {
      data = null;
    }
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(apiErrorMessage(res.statusCode, data, rate, pathname));
  }
  if (data == null) throw new Error("GitHub 返回了无法解析的数据");
  return { data, rate, headers: res.headers, status: res.statusCode };
}

/** 把 GitHub 返回的仓库对象裁成界面需要的字段（不把无关的大字段传给前端） */
function mapRepo(item) {
  const owner = item?.owner || {};
  return {
    fullName: String(item.full_name || ""),
    owner: String(owner.login || (item.full_name || "").split("/")[0] || ""),
    repo: String(item.name || (item.full_name || "").split("/")[1] || ""),
    private: item.private === true,
    fork: item.fork === true,
    archived: item.archived === true,
    disabled: item.disabled === true,
    isTemplate: item.is_template === true,
    description: String(item.description || ""),
    language: item.language || "",
    stars: Number(item.stargazers_count) || 0,
    forks: Number(item.forks_count) || 0,
    watchers: Number(item.watchers_count) || 0,
    openIssues: Number(item.open_issues_count) || 0,
    topics: Array.isArray(item.topics) ? item.topics.slice(0, 20).map(String) : [],
    license: item.license?.spdx_id && item.license.spdx_id !== "NOASSERTION" ? String(item.license.spdx_id) : "",
    updatedAt: item.updated_at || "",
    pushedAt: item.pushed_at || "",
    createdAt: item.created_at || "",
    defaultBranch: String(item.default_branch || ""),
    htmlUrl: String(item.html_url || ""),
    size: Number(item.size) || 0,
    homepage: String(item.homepage || ""),
    ownerType: String(owner.type || "User"),
    visibility: String(item.visibility || (item.private ? "private" : "public")),
  };
}

const SORTS = new Set(["", "stars", "forks", "updated", "help-wanted-issues"]);

async function searchRepos(params = {}) {
  const q = String(params.q ?? "").trim();
  if (!q) throw new Error("请输入搜索关键词");
  if (q.length > 256) throw new Error("搜索条件过长（GitHub 限制 256 个字符），请精简筛选条件");
  const sort = SORTS.has(String(params.sort || "")) ? String(params.sort || "") : "";
  const order = params.order === "asc" ? "asc" : "desc";
  const page = Math.max(1, Math.min(34, Math.floor(Number(params.page) || 1)));
  const perPage = Math.max(10, Math.min(100, Math.floor(Number(params.perPage) || 30)));
  if (page * perPage > 1000) throw new Error("GitHub 搜索最多只能翻到前 1000 条结果");

  const cacheKey = [config.apiBase, config.token ? "auth" : "anon", q, sort, order, page, perPage].join("|");
  const cached = state.searchCache.get(cacheKey);
  if (!params.nocache && cached && Date.now() - cached.at < state.searchCacheTtlMs) {
    return { ...cached.payload, cached: true };
  }

  const query = { q, per_page: perPage, page };
  if (sort) {
    query.sort = sort;
    query.order = order;
  }
  const { data, rate } = await githubApi("/search/repositories", query);
  state.rate.search = rate;

  const rawItems = Array.isArray(data.items) ? data.items : [];
  const totalCount = Number(data.total_count) || 0;
  const items = rawItems.map(mapRepo);
  const payload = {
    items,
    totalCount,
    incomplete: data.incomplete_results === true,
    page,
    perPage,
    hasMore: page * perPage < Math.min(totalCount, 1000),
    rate,
    cached: false,
    query: q,
  };

  state.searchCache.set(cacheKey, { at: Date.now(), payload });
  while (state.searchCache.size > state.searchCacheMax) {
    const first = state.searchCache.keys().next().value;
    state.searchCache.delete(first);
  }
  return payload;
}

/** 读 `/rate_limit` 的 resources 字段（GitHub Enterprise 也支持） */
function pickRateLimit(data) {
  const core = data?.resources?.core;
  const search = data?.resources?.search;
  const out = { core: null, search: null };
  if (core) {
    out.core = {
      limit: Number(core.limit) || null,
      remaining: Number(core.remaining) || 0,
      reset: Number(core.reset) || null,
      used: Number(core.used) || null,
    };
  }
  if (search) {
    out.search = {
      limit: Number(search.limit) || null,
      remaining: Number(search.remaining) || 0,
      reset: Number(search.reset) || null,
      used: Number(search.used) || null,
    };
  }
  return out;
}

async function testToken(params = {}) {
  const temp = typeof params.token === "string" ? params.token.trim() : config.token;
  const { data, rate } = await githubApi("/rate_limit", null, { token: temp });
  const searchRate = pickRateLimit(data).search || rate;
  let login = "";
  let name = "";
  try {
    const user = await githubApi("/user", null, { token: temp });
    login = String(user.data.login || "");
    name = String(user.data.name || "");
  } catch {
    // 细粒度 Token 可能没有 user 读取权限；能通过 /rate_limit 就视为可用
  }
  // 「测试候选 Token」不能污染当前实际生效 Token 的配额/账号状态；
  // 只有测试已保存的 Token（或保存后再测）才更新全局运行时状态。
  if (temp === config.token) {
    state.rate.search = searchRate;
    state.login = login;
  }
  return {
    ok: true,
    login,
    name,
    rateLimit: {
      core: pickRateLimit(data).core || null,
      search: searchRate,
    },
  };
}

// ===================== 下载：路径 / 命名 =====================

function sanitizeSegment(raw, fallback = "repo") {
  let s = String(raw ?? "").replace(/[\u0000-\u001f<>:"/\\|?*]/g, "-").trim();
  s = s.replace(/[. ]+$/g, "").trim();
  if (!s) s = fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(s)) s = fallback;
  if (s === "." || s === "..") s = fallback;
  if (s.length > 120) s = s.slice(0, 120).trim();
  return s || fallback;
}

function dateStamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}${pad(d.getMinutes())}`,
  };
}

function fillTemplate(tpl, item, stamp) {
  return String(tpl ?? "")
    .replace(/\{owner\}/gi, item.owner)
    .replace(/\{repo\}/gi, item.repo)
    .replace(/\{full_name\}/gi, item.fullName.replace(/[\\/]/g, "--"))
    .replace(/\{date\}/gi, stamp.date)
    .replace(/\{time\}/gi, stamp.time)
    .replace(/\{branch\}/gi, item.branch || item.defaultBranch || "default");
}

function archiveExt(format) {
  return format === "tar.gz" ? ".tar.gz" : ".zip";
}

function ensureExt(base, ext) {
  return base.toLowerCase().endsWith(ext) ? base : base + ext;
}

/** 同一任务内避免重名的最终文件路径（存在同名时追加 (2)、(3)…） */
async function allocatePath(dir, fileName, used) {
  const extMatch = fileName.match(/(\.tar\.gz|\.zip)$/i);
  const ext = extMatch ? extMatch[1] : "";
  const base = ext ? fileName.slice(0, -ext.length) : fileName;
  for (let i = 1; i <= 999; i++) {
    const name = i === 1 ? `${base}${ext}` : `${base} (${i})${ext}`;
    const full = path.join(dir, name);
    const key = IS_WIN ? full.toLowerCase() : full;
    if (used.has(key)) continue;
    try {
      await fsp.access(full);
      continue; // 已存在
    } catch {
      // 等待 access 期间，另一个并发下载可能已经预定了同一路径。
      // 这里必须再查一次，否则两个同名仓库会拿到同一个最终文件名。
      if (used.has(key)) continue;
      used.add(key);
      return full;
    }
  }
  throw new Error(`同名文件过多：${fileName}`);
}

function itemBaseName(job, item) {
  const tpl = job.opts.template || "{owner}--{repo}";
  const filled = fillTemplate(tpl, item, job.stamp);
  const fallback = `${item.owner}--${item.repo}`;
  return ensureExt(sanitizeSegment(filled, fallback), archiveExt(job.opts.format));
}

/**
 * 清理目标目录里上一次崩溃遗留的临时目录（只认我们自己的 `.ms-grd-tmp-` 前缀，
 * 且超过 1 天；绝不动用户其它文件）。
 */
async function cleanupStaleTempDirs(destDir) {
  try {
    const entries = await fsp.readdir(destDir, { withFileTypes: true });
    const now = Date.now();
    for (const ent of entries) {
      if (!ent.isDirectory() || !ent.name.startsWith(".ms-grd-tmp-")) continue;
      const full = path.join(destDir, ent.name);
      try {
        const st = await fsp.stat(full);
        if (now - st.mtimeMs > 24 * 60 * 60 * 1000) {
          await fsp.rm(full, { recursive: true, force: true });
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* 目录读不了就算了，下载时再报可读错误 */
  }
}

// ===================== 下载：HTTP 与任务 =====================

function downloadError(status, body, item) {
  let msg = body.toString("utf8").trim();
  try {
    const parsed = JSON.parse(msg);
    if (parsed?.message) msg = String(parsed.message);
  } catch {
    msg = msg.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  if (status === 404) {
    return new Error(
      item.private
        ? "仓库不存在、已改名，或当前 Token 无权访问该私有仓库（HTTP 404）"
        : "仓库不存在或已删除（HTTP 404）"
    );
  }
  if (status === 401) return new Error("Token 无效或已过期（HTTP 401）");
  if (status === 403 || status === 429) return new Error(`下载被 GitHub 拒绝（HTTP ${status}）${msg ? `：${msg}` : ""}`);
  return new Error(`下载失败（HTTP ${status}）${msg ? `：${msg.slice(0, 200)}` : ""}`);
}

/** 构造单个仓库的下载地址（公开仓库优先走 codeload，不消耗 API 配额） */
function downloadUrlFor(item, format) {
  const enc = encodeURIComponent;
  const branch = String(item.branch || "").trim();
  const simpleBranch = branch && !branch.includes("/");
  const useCodeload = !item.private && simpleBranch && config.apiBase === DEFAULT_API_BASE;
  if (useCodeload) {
    const mid = format === "tar.gz" ? "tar.gz" : "zip";
    return {
      url: `https://codeload.github.com/${enc(item.owner)}/${enc(item.repo)}/${mid}/refs/heads/${enc(branch)}`,
      headers: { "User-Agent": USER_AGENT, Accept: "application/octet-stream" },
      viaApi: false,
    };
  }
  const mid = format === "tar.gz" ? "tarball" : "zipball";
  const apiPath = `/repos/${enc(item.owner)}/${enc(item.repo)}/${mid}${branch ? `/${enc(branch)}` : ""}`;
  const headers = { "User-Agent": USER_AGENT, Accept: "application/vnd.github+json" };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  return { url: `${config.apiBase}${apiPath}`, headers, viaApi: true };
}

function newJob(params) {
  const itemsRaw = Array.isArray(params?.items) ? params.items : [];
  if (itemsRaw.length === 0) throw new Error("没有选择任何仓库");
  if (itemsRaw.length > 100) throw new Error("单次最多下载 100 个仓库，请分批下载");
  const items = itemsRaw.map((raw, index) => {
    const fullName = String(raw?.fullName || "").trim();
    const [ownerFromName, repoFromName] = fullName.split("/");
    const owner = String(raw?.owner || ownerFromName || "").trim();
    const repo = String(raw?.repo || repoFromName || "").trim();
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) {
      throw new Error(`仓库名不合法：${fullName || `${owner}/${repo}`}`);
    }
    // 正则本身允许点号；但 "." / ".." 作为路径片段会被 Windows 当成特殊目录，
    // 也会在合并 ZIP 的 owner/repo 前缀里变成目录穿越，必须挡掉。
    if (owner === "." || owner === ".." || repo === "." || repo === "..") {
      throw new Error(`仓库名不合法：${fullName || `${owner}/${repo}`}`);
    }
    return {
      index,
      fullName: fullName || `${owner}/${repo}`,
      owner,
      repo,
      private: raw?.private === true,
      branch: String(raw?.branch || raw?.defaultBranch || "").trim().slice(0, 200),
      defaultBranch: String(raw?.defaultBranch || raw?.branch || "").trim().slice(0, 200),
      size: Math.max(0, Number(raw?.size) || 0),
      status: "queued",
      bytes: 0,
      totalBytes: 0,
      error: "",
      finalPath: "",
      separated: false,
      separatedReason: "",
      tempZip: "",
    };
  });

  const destRootRaw = String(params?.destDir || "").trim();
  if (!destRootRaw) throw new Error("请选择下载到哪个文件夹");
  const destRoot = path.resolve(destRootRaw);

  const optsRaw = params?.options && typeof params.options === "object" ? params.options : {};
  const format = optsRaw.format === "tar.gz" || optsRaw.format === "tar" ? "tar.gz" : "zip";
  const merge = optsRaw.merge === true;
  if (merge && format !== "zip") throw new Error("合并打包目前只支持 ZIP 格式");
  const stamp = dateStamp();
  const template = String(optsRaw.template || "{owner}--{repo}").slice(0, 120);
  const bundleName = sanitizeSegment(
    fillTemplate(String(optsRaw.bundleName || `github-repos-{date}`), { owner: "", repo: "", fullName: "", branch: "" }, stamp),
    `github-repos-${stamp.date}`
  );
  const subfolder = optsRaw.subfolder === true;
  const subfolderName = subfolder
    ? sanitizeSegment(
        fillTemplate(String(optsRaw.subfolderName || `github-repos-{date}`), { owner: "", repo: "", fullName: "", branch: "" }, stamp),
        `github-repos-${stamp.date}`
      )
    : "";
  const concurrency = Math.max(1, Math.min(4, Math.floor(Number(optsRaw.concurrency) || 3)));

  return {
    id: randomUUID(),
    createdAt: Date.now(),
    startedAt: Date.now(),
    finishedAt: 0,
    status: "running",
    phase: "download",
    canceled: false,
    error: "",
    mergeFallback: false,
    mergeFallbackReason: "",
    outputPath: "",
    destRoot,
    destDir: destRoot,
    opts: { format, merge, template, bundleName, subfolder, subfolderName, concurrency },
    stamp,
    items,
    reposDone: 0,
    failed: 0,
    doneBytes: 0,
    knownTotal: 0,
    mergeBytes: 0,
    mergeTotal: 0,
    speed: 0,
    _lastBytes: 0,
    _lastTick: Date.now(),
    _lastEmit: 0,
    abort: new AbortController(),
    usedPaths: new Set(),
    partDir: "",
  };
}

/** 生成给前端的状态快照（体积可控；不含 Token） */
function snapshot(job, withOptions = false) {
  const now = Date.now();
  const elapsed = Math.max(0, (job.finishedAt || now) - job.startedAt) / 1000;
  const speed = job.speed || 0;
  let percent = 0;
  if (job.phase === "merge") {
    percent = job.mergeTotal > 0 ? Math.min(99, (job.mergeBytes / job.mergeTotal) * 100) : 0;
  } else {
    const runningFraction = job.items
      .filter((i) => i.status === "running")
      .reduce((sum, i) => sum + (i.totalBytes > 0 ? Math.min(1, i.bytes / i.totalBytes) : 0), 0);
    const done = job.items.filter((i) => ["done", "error", "canceled"].includes(i.status)).length;
    percent = job.items.length > 0 ? Math.min(100, ((done + runningFraction) / job.items.length) * 100) : 0;
  }
  let totalBytes = 0;
  for (const i of job.items) {
    totalBytes += i.totalBytes || Math.round((i.size || 0) * 1024 * 0.75);
  }
  let etaSec = null;
  if (speed > 0 && totalBytes > 0) {
    const remain = Math.max(0, totalBytes - job.doneBytes);
    etaSec = Math.round(remain / speed);
  }
  return {
    jobId: job.id,
    status: job.status,
    phase: job.phase,
    canceled: job.canceled,
    error: job.error || "",
    destDir: job.destDir,
    destRoot: job.destRoot,
    outputPath: job.outputPath || "",
    mergeFallback: job.mergeFallback,
    mergeFallbackReason: job.mergeFallbackReason || "",
    createdAt: job.createdAt,
    finishedAt: job.finishedAt || 0,
    elapsedSec: Math.round(elapsed),
    overall: {
      percent: Math.round(percent * 10) / 10,
      doneBytes: job.doneBytes,
      totalBytes,
      speed,
      etaSec,
      reposDone: job.reposDone,
      reposTotal: job.items.length,
      failed: job.failed,
    },
    items: job.items.map((i) => ({
      index: i.index,
      fullName: i.fullName,
      status: i.status,
      bytes: i.bytes,
      totalBytes: i.totalBytes,
      error: i.error,
      finalPath: i.finalPath,
      separated: i.separated,
      separatedReason: i.separatedReason,
    })),
    ...(withOptions
      ? {
          options: {
            format: job.opts.format,
            merge: job.opts.merge,
            template: job.opts.template,
            bundleName: job.opts.bundleName,
            subfolder: job.opts.subfolder,
            subfolderName: job.opts.subfolderName,
            concurrency: job.opts.concurrency,
          },
        }
      : {}),
  };
}

function emitProgress(job, force = false) {
  const now = Date.now();
  if (!force && now - job._lastEmit < 500) return;
  job._lastEmit = now;
  const dt = Math.max(0.001, (now - job._lastTick) / 1000);
  const delta = job.doneBytes - job._lastBytes;
  const instant = delta / dt;
  job.speed = job.speed > 0 ? job.speed * 0.7 + instant * 0.3 : instant;
  job._lastBytes = job.doneBytes;
  job._lastTick = now;
  try {
    sendNotification("download-progress", snapshot(job));
  } catch {
    /* stdout 关了也无所谓，任务会自然结束 */
  }
}

async function downloadOne(job, item) {
  if (job.canceled) {
    item.status = "canceled";
    return;
  }
  item.status = "running";
  emitProgress(job, true);

  const { url, headers } = downloadUrlFor(item, job.opts.format);
  const extPart = job.opts.format === "tar.gz" ? ".tar.gz" : ".zip";
  const partPath = path.join(
    job.partDir,
    `${String(item.index + 1).padStart(3, "0")}-${item.owner}-${item.repo}${extPart}.part`
  );

  try {
    const { res } = await requestWithRedirects(url, {
      headers,
      timeoutMs: 120_000,
      signal: job.abort.signal,
    });
    if (res.statusCode !== 200) {
      const body = await readBody(res, 16 * 1024).catch(() => Buffer.alloc(0));
      throw downloadError(res.statusCode, body, item);
    }
    const len = Number(res.headers["content-length"]) || 0;
    if (len > 0) {
      item.totalBytes = len;
      job.knownTotal += len;
    }
    const ws = fs.createWriteStream(partPath, { flags: "wx" });
    let lastTick = Date.now();
    res.on("data", (chunk) => {
      item.bytes += chunk.length;
      job.doneBytes += chunk.length;
      const now = Date.now();
      if (now - lastTick >= 400) {
        lastTick = now;
        emitProgress(job);
      }
    });
    await pipeline(res, ws);

    if (job.canceled) {
      item.status = "canceled";
      await fsp.rm(partPath, { force: true }).catch(() => {});
      return;
    }

    if (job.opts.merge && job.opts.format === "zip") {
      item.tempZip = partPath;
      item.status = "done";
      item.finalPath = "";
    } else {
      const finalPath = await allocatePath(job.destDir, itemBaseName(job, item), job.usedPaths);
      await fsp.rename(partPath, finalPath).catch(async (e) => {
        if (e?.code === "EXDEV") {
          await fsp.copyFile(partPath, finalPath);
          await fsp.rm(partPath, { force: true });
        } else {
          throw e;
        }
      });
      item.finalPath = finalPath;
      item.status = "done";
    }
    job.reposDone++;
    emitProgress(job, true);
  } catch (e) {
    await fsp.rm(partPath, { force: true }).catch(() => {});
    if (job.canceled || e?.name === "AbortError" || /已取消/.test(String(e?.message || ""))) {
      item.status = "canceled";
    } else {
      item.status = "error";
      item.error = String(e?.message || e).slice(0, 320);
      job.failed++;
      sendLog("warn", `下载失败 ${item.fullName}: ${item.error}`);
    }
    emitProgress(job, true);
  }
}

async function finishJob(job, status) {
  job.status = status;
  job.finishedAt = Date.now();
  job.phase = status === "done" ? "done" : job.phase;
  emitProgress(job, true);
}

async function runJob(job) {
  try {
    await cleanupStaleTempDirs(job.destRoot);
    let destDir = job.destRoot;
    if (job.opts.subfolder) {
      const sub = sanitizeSegment(job.opts.subfolderName, `github-repos-${job.stamp.date}`);
      const candidate = path.resolve(path.join(destDir, sub));
      if (candidate !== destDir && !candidate.startsWith(destDir + path.sep)) {
        throw new Error("子文件夹名称不合法");
      }
      await fsp.mkdir(candidate, { recursive: true });
      destDir = candidate;
    }
    job.destDir = destDir;
    await fsp.access(destDir, fs.constants.W_OK);

    job.partDir = path.join(destDir, `.ms-grd-tmp-${job.id.slice(0, 8)}`);
    await fsp.mkdir(job.partDir, { recursive: true });

    const limit = Math.min(job.opts.concurrency, job.items.length);
    let cursor = 0;
    const workers = Array.from({ length: limit }, async () => {
      while (!job.canceled) {
        const index = cursor++;
        if (index >= job.items.length) return;
        await downloadOne(job, job.items[index]);
      }
    });
    await Promise.all(workers);

    if (job.canceled) {
      // 合并模式下，已下载完的仓库还只是临时 zip；取消时把它们分别保存，
      // 兑现界面「已完成的部分会保留」的承诺，而不是随临时目录一起删掉。
      if (job.opts.merge && job.opts.format === "zip" && job.items.some((i) => i.tempZip)) {
        await fallbackSeparate(job, "任务已取消，合并未完成，已完成的仓库已分别保存");
      }
      await finishJob(job, "canceled");
      return;
    }

    if (job.opts.merge && job.opts.format === "zip") {
      job.phase = "merge";
      job.status = "merging";
      emitProgress(job, true);
      await mergeJob(job);
      if (job.canceled) {
        await finishJob(job, "canceled");
        return;
      }
      job.phase = "done";
    }

    const allFailed = job.items.length > 0 && job.items.every((i) => i.status === "error");
    await finishJob(job, allFailed ? "error" : "done");
    if (allFailed && job.items[0]?.error) job.error = `全部仓库下载失败：${job.items[0].error}`;
  } catch (e) {
    job.error = String(e?.message || e).slice(0, 400);
    sendLog("error", `下载任务失败: ${job.error}`);
    await finishJob(job, job.canceled ? "canceled" : "error");
  } finally {
    if (job.partDir) {
      await fsp.rm(job.partDir, { recursive: true, force: true }).catch(() => {});
    }
    if (activeJob === job) activeJob = null;
    lastJob = job;
    try {
      sendNotification("download-done", snapshot(job));
    } catch {
      /* ignore */
    }
  }
}

let activeJob = null;
let lastJob = null;

async function startDownload(params) {
  if (activeJob && (activeJob.status === "running" || activeJob.status === "merging")) {
    throw new Error("已有下载任务正在进行，请等它完成或先取消");
  }
  const job = newJob(params);
  activeJob = job;
  lastJob = job;
  sendLog("info", `开始下载 ${job.items.length} 个仓库 → ${job.destRoot}`);
  void runJob(job);
  return {
    jobId: job.id,
    count: job.items.length,
    destDir: job.destRoot,
    format: job.opts.format,
    merge: job.opts.merge,
  };
}

function getJob(jobId) {
  const job = jobId ? (activeJob?.id === jobId ? activeJob : lastJob?.id === jobId ? lastJob : null) : activeJob || lastJob;
  return job ? snapshot(job, true) : null;
}

function cancelDownload(jobId) {
  const job = jobId ? (activeJob?.id === jobId ? activeJob : null) : activeJob;
  if (!job) return { canceled: false, reason: "任务不存在或已结束" };
  if (job.status !== "running" && job.status !== "merging") return { canceled: false, reason: "任务已结束" };
  job.canceled = true;
  try {
    job.abort.abort();
  } catch {
    /* ignore */
  }
  emitProgress(job, true);
  return { canceled: true };
}

function openFolder(target) {
  const dir = path.resolve(String(target || ""));
  let st;
  try {
    st = fs.statSync(dir);
  } catch {
    throw new Error("文件夹不存在");
  }
  if (!st.isDirectory()) throw new Error("目标不是文件夹");
  let cmd;
  let args;
  if (process.platform === "win32") {
    cmd = "explorer.exe";
    args = [dir];
  } else if (process.platform === "darwin") {
    cmd = "open";
    args = [dir];
  } else {
    cmd = "xdg-open";
    args = [dir];
  }
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {
    /* 打不开就让用户自己点任务栏；这里不阻塞 RPC 返回 */
  });
  child.unref();
  return { ok: true, path: dir };
}

// ===================== 合并 ZIP（纯 Node，不执行外部命令） =====================

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;
const MAX_MERGE_BYTES = 0xffffffff; // 单个 ZIP 不支持超过 4GB（超过就回退为分别保存）

class Zip64Error extends Error {
  constructor(message) {
    super(message);
    this.name = "Zip64Error";
  }
}

function decodeZipName(buf, flags) {
  // GitHub 的 zipball 一定是 UTF-8；非 UTF-8 的旧包按 latin1 读也不会破坏 ASCII 路径
  try {
    if (flags & 0x0800) return buf.toString("utf8");
    const utf8 = buf.toString("utf8");
    if (!utf8.includes("\uFFFD")) return utf8;
    return buf.toString("latin1");
  } catch {
    return buf.toString("utf8");
  }
}

/** 从文件句柄精确读一段（`fh.read` 不保证一次读满） */
async function readExact(fh, length, position) {
  const buf = Buffer.alloc(length);
  let off = 0;
  while (off < length) {
    const { bytesRead } = await fh.read(buf, off, length - off, position + off);
    if (bytesRead <= 0) throw new Error("读取文件失败（提前结束）");
    off += bytesRead;
  }
  return buf;
}

/** 读 ZIP 的中央目录（同一时间只保留一个文件的中央目录在内存里） */
async function readZipDirectory(zipPath) {
  const fh = await fsp.open(zipPath, "r");
  try {
    const st = await fh.stat();
    if (st.size < 22) throw new Error("压缩包不完整");
    const tailLen = Math.min(st.size, 22 + 0xffff);
    const tail = await readExact(fh, tailLen, st.size - tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        const commentLen = tail.readUInt16LE(i + 20);
        if (i + 22 + commentLen <= tail.length) {
          eocd = i;
          break;
        }
      }
    }
    if (eocd < 0) throw new Error("不是有效的 ZIP 文件（缺少目录结尾）");
    const entries = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      throw new Zip64Error("仓库压缩包为 ZIP64 格式（文件数或体积超过 ZIP 经典上限），无法合并");
    }
    if (cdOffset + cdSize > st.size) throw new Error("ZIP 目录偏移越界");
    if (cdSize > 128 * 1024 * 1024) throw new Error("ZIP 目录过大");
    const cd = await readExact(fh, cdSize, cdOffset);
    const list = [];
    let p = 0;
    for (let i = 0; i < entries; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CD_SIG) throw new Error("ZIP 中央目录损坏");
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const time = cd.readUInt16LE(p + 12);
      const date = cd.readUInt16LE(p + 14);
      const crc = cd.readUInt32LE(p + 16);
      const csize = cd.readUInt32LE(p + 20);
      const usize = cd.readUInt32LE(p + 24);
      const nlen = cd.readUInt16LE(p + 28);
      const elen = cd.readUInt16LE(p + 30);
      const clen = cd.readUInt16LE(p + 32);
      const disk = cd.readUInt16LE(p + 34);
      const internalAttr = cd.readUInt16LE(p + 36);
      const externalAttr = cd.readUInt32LE(p + 38);
      const lho = cd.readUInt32LE(p + 42);
      if (csize === 0xffffffff || usize === 0xffffffff || lho === 0xffffffff) {
        throw new Zip64Error("仓库压缩包包含 ZIP64 条目，无法合并");
      }
      if (disk !== 0) throw new Error("不支持分卷 ZIP");
      if (flags & 0x0001) throw new Error("不支持加密 ZIP");
      const nameBuf = cd.subarray(p + 46, p + 46 + nlen);
      list.push({
        name: decodeZipName(nameBuf, flags),
        flags,
        method,
        time,
        date,
        crc,
        csize,
        usize,
        lho,
        internalAttr,
        externalAttr,
      });
      p += 46 + nlen + elen + clen;
    }
    return { fh, size: st.size, list };
  } catch (e) {
    await fh.close().catch(() => {});
    throw e;
  }
}

function stripArchiveRoot(name) {
  const parts = String(name).replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= 1) return "";
  return parts.slice(1).join("/");
}

function safeArchivePath(name) {
  if (!name) return "";
  const parts = name.split("/");
  if (parts.some((p) => p === ".." || p === "." || p === "")) return "";
  return parts.join("/");
}

/**
 * 读所有源 ZIP 的中央目录，返回合并后的总字节数（用于进度）。
 * 顺带提前发现 ZIP64，避免写到一半才失败。
 */
async function scanMergeSources(sources) {
  const metas = [];
  let total = 0;
  try {
    for (const src of sources) {
      const meta = await readZipDirectory(src.zipPath);
      meta.source = src;
      metas.push(meta);
      for (const entry of meta.list) {
        if (!entry.name.endsWith("/")) total += entry.csize;
      }
    }
    return { metas, total };
  } catch (e) {
    for (const m of metas) await m.fh.close().catch(() => {});
    throw e;
  }
}

/**
 * 合并多个 ZIP：不重新压缩，逐条复制原始压缩数据（只改写文件名/目录结构），
 * 因此速度快、内存占用低；输出为经典 ZIP（超过 4GB / 65535 条会抛 Zip64Error）。
 */
async function mergeZips({ sources, outPath, rootPrefix, onProgress, onTotal, isCanceled }) {
  const { metas, total } = await scanMergeSources(sources);
  onTotal?.(total);
  const out = fs.createWriteStream(outPath, { flags: "wx" });
  out.on("error", () => {
    /* 具体错误通过 write 回调 / end 的 promise 上报，这里只兜住未处理的 error 事件 */
  });
  let outPos = 0;
  const central = [];
  const dirs = new Set();

  const writeBuf = (buf) =>
    new Promise((resolve, reject) => {
      out.write(buf, (err) => (err ? reject(err) : resolve()));
    });

  const writeDirEntry = async (dirName, time, date) => {
    const normalized = dirName.endsWith("/") ? dirName : dirName + "/";
    if (dirs.has(normalized)) return;
    dirs.add(normalized);
    const nameBuf = Buffer.from(normalized, "utf8");
    const offset = outPos;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LFH_SIG, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(time || 0, 10);
    local.writeUInt16LE(date || 0, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(0, 18);
    local.writeUInt32LE(0, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    await writeBuf(local);
    await writeBuf(nameBuf);
    outPos += local.length + nameBuf.length;
    central.push({
      nameBuf,
      flags: 0x0800,
      method: 0,
      time: time || 0,
      date: date || 0,
      crc: 0,
      csize: 0,
      usize: 0,
      internalAttr: 0,
      externalAttr: ((0o40755 << 16) | 0x10) >>> 0,
      offset,
    });
  };

  const ensureDirs = async (fullName, time, date) => {
    const parts = fullName.split("/").filter(Boolean);
    parts.pop(); // 文件名本身
    let prefix = "";
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      await writeDirEntry(prefix, time, date);
    }
  };

  try {
    if (rootPrefix) await writeDirEntry(rootPrefix, 0, 0);

    for (const meta of metas) {
      const { source, fh, size, list } = meta;
      const prefix = [rootPrefix, source.prefix].filter(Boolean).join("/");
      for (const entry of list) {
        if (isCanceled?.()) throw new Error("已取消");
        const rawName = String(entry.name || "").replace(/\\/g, "/").replace(/^\/+/, "");
        if (!rawName) continue;
        if (rawName.endsWith("/")) {
          const rest = safeArchivePath(stripArchiveRoot(rawName.replace(/\/+$/, "")));
          if (rest) await writeDirEntry([prefix, rest].filter(Boolean).join("/"), entry.time, entry.date);
          continue;
        }
        const rest = safeArchivePath(stripArchiveRoot(rawName));
        if (!rest) continue;
        const newName = [prefix, rest].filter(Boolean).join("/");
        await ensureDirs(newName, entry.time, entry.date);

        if (entry.lho + 30 > size) throw new Error("ZIP 本地头偏移越界");
        const localHeader = await readExact(fh, 30, entry.lho);
        if (localHeader.readUInt32LE(0) !== LFH_SIG) throw new Error("ZIP 本地文件头损坏");
        const localNameLen = localHeader.readUInt16LE(26);
        const localExtraLen = localHeader.readUInt16LE(28);
        const dataStart = entry.lho + 30 + localNameLen + localExtraLen;
        if (dataStart + entry.csize > size) throw new Error("ZIP 数据偏移越界");

        const nameBuf = Buffer.from(newName, "utf8");
        const entryOffset = outPos;
        const newFlags = (entry.flags & ~0x0008) | 0x0800; // 去掉 data descriptor，统一 UTF-8
        const local = Buffer.alloc(30);
        local.writeUInt32LE(LFH_SIG, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(newFlags, 6);
        local.writeUInt16LE(entry.method, 8);
        local.writeUInt16LE(entry.time, 10);
        local.writeUInt16LE(entry.date, 12);
        local.writeUInt32LE(entry.crc, 14);
        local.writeUInt32LE(entry.csize, 18);
        local.writeUInt32LE(entry.usize, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);
        await writeBuf(local);
        await writeBuf(nameBuf);
        outPos += local.length + nameBuf.length;

        if (entry.csize > 0) {
          const rs = fs.createReadStream(source.zipPath, {
            start: dataStart,
            end: dataStart + entry.csize - 1,
            highWaterMark: 64 * 1024,
          });
          for await (const chunk of rs) {
            if (isCanceled?.()) throw new Error("已取消");
            await writeBuf(chunk);
            outPos += chunk.length;
            if (outPos > MAX_MERGE_BYTES) throw new Zip64Error("合并后的压缩包超过 4GB，无法生成单个 ZIP");
            onProgress?.(chunk.length);
          }
        }

        central.push({
          nameBuf,
          flags: newFlags,
          method: entry.method,
          time: entry.time,
          date: entry.date,
          crc: entry.crc,
          csize: entry.csize,
          usize: entry.usize,
          internalAttr: entry.internalAttr,
          externalAttr: entry.externalAttr,
          offset: entryOffset,
        });
        if (central.length > 0xfffe) throw new Zip64Error("合并后的文件数超过 ZIP 经典上限");
      }
      await fh.close().catch(() => {});
    }

    const cdStart = outPos;
    for (const rec of central) {
      const head = Buffer.alloc(46);
      head.writeUInt32LE(CD_SIG, 0);
      head.writeUInt16LE(20, 4); // version made by
      head.writeUInt16LE(20, 6); // version needed
      head.writeUInt16LE(rec.flags, 8);
      head.writeUInt16LE(rec.method, 10);
      head.writeUInt16LE(rec.time, 12);
      head.writeUInt16LE(rec.date, 14);
      head.writeUInt32LE(rec.crc, 16);
      head.writeUInt32LE(rec.csize, 20);
      head.writeUInt32LE(rec.usize, 24);
      head.writeUInt16LE(rec.nameBuf.length, 28);
      head.writeUInt16LE(0, 30); // extra
      head.writeUInt16LE(0, 32); // comment
      head.writeUInt16LE(0, 34); // disk
      head.writeUInt16LE(rec.internalAttr, 36);
      head.writeUInt32LE(rec.externalAttr >>> 0, 38);
      head.writeUInt32LE(rec.offset, 42);
      await writeBuf(head);
      await writeBuf(rec.nameBuf);
      outPos += head.length + rec.nameBuf.length;
    }
    const cdSize = outPos - cdStart;
    if (cdSize > MAX_MERGE_BYTES) throw new Zip64Error("合并后的目录超过 4GB");
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(central.length & 0xffff, 8);
    eocd.writeUInt16LE(central.length & 0xffff, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);
    await writeBuf(eocd);
    outPos += eocd.length;
    await new Promise((resolve, reject) => {
      out.once("error", reject);
      out.end(resolve);
    });
  } catch (e) {
    try {
      out.destroy();
    } catch {
      /* ignore */
    }
    await fsp.rm(outPath, { force: true }).catch(() => {});
    throw e;
  } finally {
    for (const meta of metas) await meta.fh.close().catch(() => {});
  }
}

/** 合并失败（如 ZIP64 / 取消）时的兜底：把已下载的仓库压缩包分别保存到目标目录 */
async function fallbackSeparate(job, reason) {
  for (const item of job.items) {
    if (!item.tempZip) continue;
    try {
      const finalPath = await allocatePath(job.destDir, itemBaseName(job, item), job.usedPaths);
      await fsp.rename(item.tempZip, finalPath);
      item.finalPath = finalPath;
      item.separated = true;
      item.separatedReason = reason;
    } catch (e) {
      item.status = "error";
      item.error = `合并失败且单独保存也失败：${String(e?.message || e).slice(0, 200)}`;
      job.failed++;
    }
  }
  job.outputPath = "";
  job.mergeFallback = true;
  job.mergeFallbackReason = reason;
}

async function mergeJob(job) {
  const sources = job.items
    .filter((i) => i.status === "done" && i.tempZip)
    .map((i) => ({ zipPath: i.tempZip, prefix: `${i.owner}/${i.repo}` }));
  if (sources.length === 0) {
    throw new Error("没有可合并的仓库（全部下载失败）");
  }
  const ext = ".zip";
  const bundleBase = sanitizeSegment(job.opts.bundleName, `github-repos-${job.stamp.date}`);
  const outPath = await allocatePath(job.destDir, ensureExt(bundleBase, ext), job.usedPaths);
  job.outputPath = outPath;
  job.mergeBytes = 0;

  try {
    await mergeZips({
      sources,
      outPath,
      rootPrefix: bundleBase.replace(/\.zip$/i, ""),
      onTotal: (total) => {
        job.mergeTotal = total;
        emitProgress(job, true);
      },
      onProgress: (delta) => {
        job.mergeBytes += delta;
        emitProgress(job);
      },
      isCanceled: () => job.canceled,
    });
    job.mergeBytes = job.mergeTotal;
    emitProgress(job, true);
  } catch (e) {
    await fsp.rm(outPath, { force: true }).catch(() => {});
    if (job.canceled) {
      if (job.items.some((i) => i.tempZip)) {
        await fallbackSeparate(job, "任务已取消，合并未完成，已完成的仓库已分别保存");
      }
      throw e;
    }
    const reason = `合并为一个 ZIP 失败（${String(e?.message || e)}），已改为分别保存`;
    sendLog("warn", reason);
    await fallbackSeparate(job, reason);
  }
}

// ===================== RPC 分发 =====================

function getConfigPublic() {
  return {
    hasToken: Boolean(config.token),
    tokenHint: config.token ? `…${config.token.slice(-4)}` : "",
    login: state.login,
    apiBase: config.apiBase,
    proxy: config.proxy,
    version: VERSION,
    platform: process.platform,
    rateLimit: state.rate,
  };
}

function setConfig(params = {}) {
  const next = { ...config };
  let changed = false;
  if (params.clearToken === true) {
    if (next.token) {
      next.token = "";
      state.login = "";
      changed = true;
    }
  } else if (typeof params.token === "string") {
    const t = params.token.trim();
    if (t && t !== next.token) {
      next.token = t;
      state.login = "";
      changed = true;
    }
  }
  if (params.apiBase !== undefined) {
    const base = normalizeApiBase(params.apiBase);
    if (base !== next.apiBase) {
      next.apiBase = base;
      changed = true;
    }
  }
  if (params.proxy !== undefined) {
    const proxy = normalizeProxy(params.proxy);
    if (proxy !== next.proxy) {
      next.proxy = proxy;
      changed = true;
    }
  }
  if (changed) {
    config = next;
    state.searchCache.clear();
    state.rate.search = null;
    saveConfig();
  }
  return getConfigPublic();
}

async function handleRequest(method, id, params) {
  try {
    let result;
    switch (method) {
      case "init":
      case "ping":
        result = { ok: true, version: VERSION, platform: process.platform, node: process.version };
        break;
      case "status":
        result = {
          ok: true,
          version: VERSION,
          platform: process.platform,
          activeJobId: activeJob?.id || "",
          hasToken: Boolean(config.token),
        };
        break;
      case "getConfig":
        result = getConfigPublic();
        break;
      case "setConfig":
        result = setConfig(params || {});
        break;
      case "testToken":
        result = await testToken(params || {});
        break;
      case "search":
        result = await searchRepos(params || {});
        break;
      case "downloadStart":
        result = await startDownload(params || {});
        break;
      case "getJob":
        result = getJob(params?.jobId || "");
        break;
      case "cancelDownload":
        result = cancelDownload(params?.jobId || "");
        break;
      case "openFolder":
        result = openFolder(params?.path || "");
        break;
      default:
        throw new Error(`未知方法: ${method}`);
    }
    sendResult(id, result);
  } catch (e) {
    sendError(id, e?.message || e);
  }
}

// ===================== 主循环 =====================

process.on("uncaughtException", (e) => {
  sendLog("error", `后端未捕获异常：${e?.stack || e?.message || e}`);
});
process.on("unhandledRejection", (e) => {
  sendLog("error", `后端未处理 Promise：${e?.stack || e?.message || e}`);
});

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  const { method, id, params } = msg;
  if (method === "deactivate") {
    sendLog("info", "正在退出...");
    if (activeJob && (activeJob.status === "running" || activeJob.status === "merging")) {
      activeJob.canceled = true;
      try {
        activeJob.abort.abort();
      } catch {
        /* ignore */
      }
    }
    rl.close();
    setTimeout(() => process.exit(0), 150);
    return;
  }
  if (id != null) handleRequest(method, id, params);
});

rl.on("close", () => process.exit(0));

sendLog("info", `GitHub 仓库下载器后端已启动（v${VERSION}，Node ${process.version}）`);
