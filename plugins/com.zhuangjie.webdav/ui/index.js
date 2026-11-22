/**
 * WebDAV 网盘 - 前端入口脚本
 *
 * 宿主注入参数: ms, env, plugin, host, keyword, inputValue, onSubKeyword, md2html, openExternal
 *
 * 结构约定（便于 Node 桩测试）：
 *   - 所有 DOM 查询/事件绑定都在 init() 里，函数定义本身不碰 DOM；
 *   - TEST_MODE（window.__WD_TEST__ === true，仅测试桩会设置）下跳过 init、
 *     并把纯逻辑（路径/编解码/XML 解析/客户端/流程规划）挂在 window.__wdTest 上；
 *   - 运行时（浏览器里）没有这个标志，正常走 init()。
 */
(function (ms, env, plugin, host, keyword, inputValue, onSubKeyword, md2html, openExternal) {
  "use strict";

  var TEST_MODE = typeof window !== "undefined" && window.__WD_TEST__ === true;

  /* ============================================================
   * 常量
   * ============================================================ */
  var STORE_SERVERS = "webdav.servers";     // [{id,name,url,username,password}]
  var STORE_ACTIVE = "webdav.activeServer"; // 服务器 id
  var STORE_FAVORITES = "webdav.favorites"; // { [serverId]: [{path,name}] }
  var STORE_PREFS = "webdav.prefs";         // {sortKey,sortDir,showHidden}

  var MAX_UPLOAD = 32 * 1024 * 1024;        // 与宿主文本响应上限对齐
  var MAX_DOWNLOAD = 64 * 1024 * 1024;      // 与宿主二进制响应上限对齐
  var MAX_TEXT = 4 * 1024 * 1024;           // 文本预览上限

  var PROPFIND_BODY =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<D:propfind xmlns:D="DAV:">\n' +
    "  <D:prop>\n" +
    "    <D:resourcetype/>\n" +
    "    <D:displayname/>\n" +
    "    <D:getcontentlength/>\n" +
    "    <D:getlastmodified/>\n" +
    "    <D:getcontenttype/>\n" +
    "    <D:getetag/>\n" +
    "  </D:prop>\n" +
    "</D:propfind>";

  var TEXT_EXTS = {
    txt: 1, log: 1, json: 1, js: 1, mjs: 1, cjs: 1, ts: 1, tsx: 1, jsx: 1,
    css: 1, scss: 1, less: 1, html: 1, htm: 1, xml: 1, svg: 1, yml: 1, yaml: 1,
    csv: 1, tsv: 1, ini: 1, conf: 1, cfg: 1, sh: 1, bash: 1, bat: 1, ps1: 1,
    py: 1, rb: 1, go: 1, rs: 1, java: 1, c: 1, h: 1, cpp: 1, hpp: 1, sql: 1,
    toml: 1, properties: 1, env: 1, gitignore: 1, license: 1,
  };
  var MD_EXTS = { md: 1, markdown: 1, mdown: 1 };
  var IMG_EXTS = { jpg: 1, jpeg: 1, png: 1, gif: 1, webp: 1, bmp: 1, svg: 1, ico: 1, avif: 1 };
  var AUDIO_EXTS = { mp3: 1, wav: 1, ogg: 1, m4a: 1, flac: 1, aac: 1 };
  var VIDEO_EXTS = { mp4: 1, webm: 1, mkv: 1, mov: 1, m4v: 1 };
  var MIME_MAP = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
    webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml", ico: "image/x-icon", avif: "image/avif",
    mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", flac: "audio/flac", aac: "audio/aac",
    mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska", mov: "video/quicktime", m4v: "video/mp4",
    pdf: "application/pdf", json: "application/json", txt: "text/plain",
    md: "text/markdown", html: "text/html", css: "text/css", xml: "application/xml",
    zip: "application/zip", gz: "application/gzip", "7z": "application/x-7z-compressed",
    doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };

  var ICONS = {
    folder: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>',
    file: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>',
    image: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
    media: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 9l5 3-5 3z"/></svg>',
    audio: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
    pdf: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></svg>',
    text: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h8"/></svg>',
    eye: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    download: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>',
    rename: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.83 2.83 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>',
    trash: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14"/></svg>',
    star: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
  };

  /* ============================================================
   * 基础工具（纯函数，可测）
   * ============================================================ */

  /** 相对路径拼接 + 归一化（解 `..`/`.`，统一分隔符，保证前导 `/`） */
  function normalizePath(p) {
    var s = String(p == null ? "/" : p).replace(/\\/g, "/").trim();
    var parts = s.split("/");
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (!part || part === ".") continue;
      if (part === "..") { if (out.length) out.pop(); continue; }
      out.push(part);
    }
    return "/" + out.join("/");
  }

  function joinPath(a, b) {
    return normalizePath(String(a == null ? "/" : a) + "/" + String(b == null ? "" : b));
  }

  function parentPath(p) {
    var n = normalizePath(p);
    if (n === "/") return "/";
    var idx = n.lastIndexOf("/");
    return idx <= 0 ? "/" : n.slice(0, idx);
  }

  /** 最后一段名字；根目录返回 ""。容忍 Windows 反斜杠 */
  function baseName(p) {
    var n = normalizePath(p);
    if (n === "/") return "";
    var idx = n.lastIndexOf("/");
    return n.slice(idx + 1);
  }

  function samePath(a, b) {
    return normalizePath(a) === normalizePath(b);
  }

  /** child 是否等于 parent 或位于 parent 之下（都是归一化路径） */
  function isUnder(parent, child) {
    var pa = normalizePath(parent);
    var ca = normalizePath(child);
    if (pa === "/") return true;
    return ca === pa || ca.indexOf(pa + "/") === 0;
  }

  /** 把 under 前缀 from 的路径改挂到 to 下（重命名/移动后修收藏夹） */
  function replacePrefix(path, from, to) {
    var p = normalizePath(path);
    if (!isUnder(from, p)) return p;
    var f = normalizePath(from);
    var t = normalizePath(to);
    if (f === t) return p;
    var rest = f === "/" ? p : p.slice(f.length); // 带前导 / 或为 ""
    return t === "/" ? normalizePath(rest) : normalizePath(t + rest);
  }

  /** 把（已解码的）路径逐段 encodeURIComponent，用于拼 URL（保留前导 /） */
  function encodePath(path) {
    var p = normalizePath(path);
    if (p === "/") return "/";
    return "/" + p.slice(1).split("/").map(function (seg) {
      try { return encodeURIComponent(seg); } catch (e) { return seg; }
    }).join("/");
  }

  /** 按 `/` 分段 decode（单段失败就原样保留：容忍服务器返回的怪 href） */
  function decodePathname(p) {
    return String(p == null ? "/" : p).split("/").map(function (seg) {
      try { return decodeURIComponent(seg.replace(/\+/g, "%2B")); } catch (e) { return seg; }
    }).join("/");
  }

  /**
   * 归一化服务器地址：补协议、去 query/hash、保证尾 `/`。
   * 返回值可直接当 URL 前缀拼接相对路径。
   */
  function normalizeBaseUrl(raw) {
    var s = String(raw == null ? "" : raw).trim();
    if (!s) throw new Error("请填写服务器地址");
    if (!/^https?:\/\//i.test(s)) s = "https://" + s;
    var u;
    try { u = new URL(s); } catch (e) { throw new Error("服务器地址不合法：" + s); }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("服务器地址仅支持 http/https：" + s);
    u.hash = "";
    u.search = "";
    if (u.pathname === "" || u.pathname === "/") u.pathname = "/";
    else if (u.pathname.slice(-1) !== "/") u.pathname += "/";
    return u.toString();
  }

  /** baseUrl + WebDAV 路径 → 完整 URL（路径逐段编码） */
  function urlFor(baseUrl, path) {
    var base = normalizeBaseUrl(baseUrl);
    var p = encodePath(path);
    if (p === "/") return base;
    return base + p.slice(1);
  }

  /**
   * 服务器返回的 href（绝对/相对/带百分号编码/裸 Unicode）→ 插件侧路径。
   * 优先按「baseUrl 路径前缀」剥出相对部分；对不上就退回完整 pathname
   * （挂载点不在 baseUrl 下时服务器语义本身就不清晰，能用即可）。
   */
  function pathFromHref(href, baseUrl) {
    if (href == null) return null;
    var h = String(href).trim();
    if (!h) return null;
    var u;
    try { u = new URL(h, baseUrl); } catch (e) { return null; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    var basePath;
    try { basePath = decodePathname(new URL(baseUrl).pathname); } catch (e) { basePath = "/"; }
    var targetPath = decodePathname(u.pathname);
    if (basePath.slice(-1) !== "/") basePath += "/";
    // href 正好是 baseUrl 目录本身（有无尾斜杠两种形态）→ 根目录
    if (targetPath === basePath.slice(0, -1) || targetPath + "/" === basePath) return "/";
    if (targetPath.indexOf(basePath) === 0) {
      return normalizePath(targetPath.slice(basePath.length) || "/");
    }
    return normalizePath(targetPath);
  }

  /* ---------------- 编码（纯 JS，避免 btoa 的 Latin-1 限制） ---------------- */

  var B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  function utf8Bytes(str) {
    var s = String(str == null ? "" : str);
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(s);
    // 退化实现（仅旧环境兜底）
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        var c2 = s.charCodeAt(++i);
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return new Uint8Array(out);
  }

  function bytesToBase64(bytes) {
    var out = [];
    for (var i = 0; i < bytes.length; i += 0x8000) {
      var chunk = Array.prototype.slice.call(bytes.subarray(i, i + 0x8000));
      out.push(String.fromCharCode.apply(null, chunk));
    }
    var bin = out.join("");
    var res = "";
    for (var j = 0; j < bin.length; j += 3) {
      var b0 = bin.charCodeAt(j);
      var b1 = j + 1 < bin.length ? bin.charCodeAt(j + 1) : NaN;
      var b2 = j + 2 < bin.length ? bin.charCodeAt(j + 2) : NaN;
      res += B64_CHARS.charAt(b0 >> 2);
      res += B64_CHARS.charAt(((b0 & 3) << 4) | (isNaN(b1) ? 0 : b1 >> 4));
      if (isNaN(b1)) { res += "=="; continue; } // 剩 1 字节
      res += B64_CHARS.charAt(((b1 & 15) << 2) | (isNaN(b2) ? 0 : b2 >> 6));
      res += isNaN(b2) ? "=" : B64_CHARS.charAt(b2 & 63); // 剩 2 字节时补一个 =
    }
    return res;
  }

  function base64ToBytes(b64) {
    var s = String(b64 == null ? "" : b64).replace(/[\s=]+$/, "");
    var len = s.length;
    var arr = [];
    var buffer = 0, bits = 0;
    for (var i = 0; i < len; i++) {
      var v = B64_CHARS.indexOf(s.charAt(i));
      if (v < 0) continue; // 跳过换行等杂物
      buffer = (buffer << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        arr.push((buffer >> bits) & 0xff);
        buffer &= (1 << bits) - 1;
      }
    }
    return new Uint8Array(arr);
  }

  function bytesToUtf8(bytes) {
    if (typeof TextDecoder !== "undefined") {
      try { return new TextDecoder("utf-8").decode(bytes); } catch (e) { /* fallthrough */ }
    }
    return null;
  }

  function utf8ToBase64(str) {
    return bytesToBase64(utf8Bytes(str));
  }

  function base64ToUtf8(b64) {
    return bytesToUtf8(base64ToBytes(b64));
  }

  /** 按 Content-Type 的 charset 解码字节（GBK 等）；失败退回 utf-8 宽松解码 */
  function bytesToText(bytes, contentType) {
    var cs = "";
    var m = /charset=([\w-]+)/i.exec(String(contentType || ""));
    if (m) cs = m[1];
    if (cs && cs.toLowerCase() !== "utf-8" && cs.toLowerCase() !== "utf8" && typeof TextDecoder !== "undefined") {
      try { return new TextDecoder(cs).decode(bytes); } catch (e) { /* fallthrough */ }
    }
    var t = bytesToUtf8(bytes);
    return t == null ? "" : t;
  }

  /** `data:<mime>;base64,xxx` → { mime, base64, bytes }；不认识返回 null */
  function dataUrlParts(dataUrl) {
    if (typeof dataUrl !== "string") return null;
    var m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(dataUrl);
    if (!m) return null;
    var mime = m[1] || "";
    if (m[2]) {
      var b64 = m[3] || "";
      return { mime: mime, base64: b64, bytes: base64ToBytes(b64).length };
    }
    // 非 base64 data URL：按文本转回 base64
    var raw = "";
    try { raw = decodeURIComponent(m[3] || ""); } catch (e) { raw = m[3] || ""; }
    var bytes = utf8Bytes(raw);
    return { mime: mime, base64: bytesToBase64(bytes), bytes: bytes.length };
  }

  /* ---------------- 类型/格式 ---------------- */

  function extOf(name) {
    var n = String(name || "");
    var idx = n.lastIndexOf(".");
    if (idx <= 0 || idx === n.length - 1) return "";
    return n.slice(idx + 1).toLowerCase();
  }

  function mimeOfName(name) {
    return MIME_MAP[extOf(name)] || "application/octet-stream";
  }

  /** "dir" | "image" | "audio" | "video" | "pdf" | "markdown" | "text" | "other" */
  function kindOfName(name, contentType) {
    var ext = extOf(name);
    var ct = String(contentType || "").toLowerCase();
    if (IMG_EXTS[ext] || ct.indexOf("image/") === 0) return "image";
    if (AUDIO_EXTS[ext] || ct.indexOf("audio/") === 0) return "audio";
    if (VIDEO_EXTS[ext] || ct.indexOf("video/") === 0) return "video";
    if (ext === "pdf" || ct.indexOf("application/pdf") === 0) return "pdf";
    if (MD_EXTS[ext] || ct.indexOf("text/markdown") === 0) return "markdown";
    if (TEXT_EXTS[ext] || ct.indexOf("text/") === 0 || ct.indexOf("application/json") === 0 || ct.indexOf("application/xml") === 0) return "text";
    return "other";
  }

  function kindOfEntry(entry) {
    if (entry.isDir) return "dir";
    return kindOfName(entry.name, entry.contentType);
  }

  function isPreviewable(entry) {
    var k = kindOfEntry(entry);
    return k !== "dir" && k !== "other";
  }

  function fmtSize(bytes) {
    var n = Number(bytes);
    if (!isFinite(n) || n < 0) return "-";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
    return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
  }

  function two(n) { return n < 10 ? "0" + n : "" + n; }

  function fmtTime(ms) {
    var t = Number(ms);
    if (!isFinite(t) || t <= 0) return "-";
    var d = new Date(t);
    if (isNaN(d.getTime())) return "-";
    var now = new Date();
    var sameYear = d.getFullYear() === now.getFullYear();
    var datePart = sameYear
      ? two(d.getMonth() + 1) + "-" + two(d.getDate())
      : d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate());
    return datePart + " " + two(d.getHours()) + ":" + two(d.getMinutes());
  }

  /** 文件/文件夹名合法性：非法返回错误文案，合法返回 "" */
  function validateName(name) {
    var s = String(name == null ? "" : name).trim();
    if (!s) return "名称不能为空";
    if (s === "." || s === "..") return "名称不能是 . 或 ..";
    if (/[/\\]/.test(s)) return "名称不能包含 / 或 \\";
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f]/.test(s)) return "名称包含非法控制字符";
    if (s.length > 255) return "名称过长（上限 255 字符）";
    return "";
  }

  function hasOwn(obj, key) {
    return obj != null && Object.prototype.hasOwnProperty.call(obj, key);
  }

  /* ============================================================
   * 错误
   * ============================================================ */

  function WebDavError(status, method, url, body) {
    this.name = "WebDavError";
    this.status = status;
    this.method = method;
    this.url = url;
    this.body = String(body == null ? "" : body);
    this.message = "HTTP " + status + (this.body ? "：" + this.body.slice(0, 200) : "");
  }
  WebDavError.prototype = Object.create(Error.prototype);
  WebDavError.prototype.constructor = WebDavError;

  /** 把任何异常翻译成给用户看的中文文案 */
  function explainError(err) {
    var msg = String((err && err.message) || err || "");
    if (err instanceof WebDavError) {
      switch (err.status) {
        case 401: return "认证失败（401）：用户名或应用密码错误";
        case 403: return "没有权限（403）：账号无权访问该路径";
        case 404: return "不存在（404）：文件或目录可能已被删除";
        case 405: return "目标已存在（405）：同名文件或文件夹已存在";
        case 409: return "父目录不存在（409）";
        case 412: return "目标已存在（412）：已按「不覆盖」跳过";
        case 507: return "服务器空间不足（507）";
        default:
          return "请求失败（HTTP " + err.status + "）" + (err.body ? "：" + err.body.slice(0, 160) : "");
      }
    }
    if (msg.indexOf("缺少权限") >= 0) {
      return msg + "（请在插件面板为该服务器地址授权网络访问）";
    }
    if (msg.indexOf("响应过大") >= 0) return msg;
    if (err instanceof TypeError || msg.indexOf("fetch") >= 0 || msg.indexOf("network") >= 0) {
      return "网络请求失败：请检查服务器地址与网络连接";
    }
    if (msg.indexOf("解析失败") >= 0 || msg.indexOf("DOMParser") >= 0) return msg;
    return msg || "未知错误";
  }

  /* ============================================================
   * 多状态（PROPFIND）XML 解析
   * ============================================================ */

  /** 所有 localName 匹配的后代元素（命名空间无关） */
  function elsByLocalName(root, name) {
    var out = [];
    var all;
    try { all = root.getElementsByTagName("*"); } catch (e) { all = []; }
    for (var i = 0; i < all.length; i++) {
      if (all[i].localName === name) out.push(all[i]);
    }
    return out;
  }

  function firstByLocalName(root, name) {
    var list = elsByLocalName(root, name);
    return list.length ? list[0] : null;
  }

  function elText(root, name) {
    var el = firstByLocalName(root, name);
    return el ? String(el.textContent || "") : "";
  }

  /**
   * 解析 PROPFIND 响应 → 条目数组（含请求目录自身，调用方按需过滤）。
   * 兼容带前缀（D:/d:）与默认命名空间两种写法；多 propstat 时优先取 200 的那份。
   */
  function parseMultiStatus(xml, baseUrl) {
    var doc;
    try {
      doc = new DOMParser().parseFromString(String(xml == null ? "" : xml), "application/xml");
    } catch (e) {
      throw new Error("目录列表解析失败：" + e.message);
    }
    if (!doc || doc.getElementsByTagName("parsererror").length) {
      throw new Error("目录列表解析失败：服务器返回的不是合法 XML");
    }
    var responses = elsByLocalName(doc, "response");
    var seen = {};
    var out = [];
    for (var i = 0; i < responses.length; i++) {
      var resp = responses[i];
      var href = elText(resp, "href");
      var path = pathFromHref(href, baseUrl);
      if (path == null || hasOwn(seen, path)) continue;
      seen[path] = true;

      var prop = pickProp(resp);
      var rt = prop ? firstByLocalName(prop, "resourcetype") : null;
      var isDir = rt ? elsByLocalName(rt, "collection").length > 0 : false;
      var size = parseInt(elText(prop || resp, "getcontentlength"), 10);
      if (!isFinite(size) || size < 0) size = 0;
      var mt = Date.parse(elText(prop || resp, "getlastmodified"));
      if (!isFinite(mt)) mt = 0;
      var displayName = prop ? String(prop && elText(prop, "displayname") || "").trim() : "";
      var entry = {
        path: path,
        name: displayName || baseName(path) || path,
        isDir: isDir,
        size: isDir ? 0 : size,
        mtimeMs: mt,
        contentType: prop ? elText(prop, "getcontenttype") : "",
        etag: prop ? elText(prop, "getetag") : "",
      };
      out.push(entry);
    }
    return out;
  }

  /** 在一个 response 里挑出「可用的 prop」：优先 status 200 的 propstat */
  function pickProp(resp) {
    var propstats = elsByLocalName(resp, "propstat");
    var fallback = null;
    for (var i = 0; i < propstats.length; i++) {
      var ps = propstats[i];
      var st = elText(ps, "status");
      var prop = firstByLocalName(ps, "prop");
      if (!prop) continue;
      if (!fallback) fallback = prop;
      // 状态文本形如 "HTTP/1.1 200 OK"
      if (!st || st.indexOf("200") >= 0) return prop;
    }
    if (fallback) return fallback;
    return firstByLocalName(resp, "prop");
  }

  /* ============================================================
   * WebDAV 客户端
   * ============================================================ */

  function WebDavClient(server) {
    this.server = server;
    this.baseUrl = normalizeBaseUrl(server && server.url);
    var user = String((server && server.username) || "");
    var pass = String((server && server.password) || "");
    this.auth = (user || pass) ? "Basic " + utf8ToBase64(user + ":" + pass) : "";
  }

  /**
   * 发一个请求。throwOnHttpError=false 由本层自己把非 2xx 转成 WebDavError，
   * 这样 401/404/409/412 可以按语义分别处理（宿主默认会把非 2xx 直接抛成
   * 泛化字符串，丢失状态码）。
   */
  WebDavClient.prototype.request = function (method, path, opts) {
    opts = opts || {};
    var url = opts.url || urlFor(this.baseUrl, path);
    var headers = {};
    if (this.auth) headers.Authorization = this.auth;
    if (opts.headers) {
      for (var k in opts.headers) if (hasOwn(opts.headers, k)) headers[k] = String(opts.headers[k]);
    }
    var o = {
      method: method,
      headers: headers,
      responseType: opts.responseType || "text",
      timeoutSecs: opts.timeoutSecs || 30,
      throwOnHttpError: false,
    };
    if (opts.maxBytes) o.maxBytes = opts.maxBytes;
    if (opts.body != null) o.body = String(opts.body);
    if (opts.bodyBase64 != null) o.bodyBase64 = String(opts.bodyBase64);
    var self = this;
    var p;
    try {
      p = ms.net.fetch(url, o);
    } catch (e) {
      return Promise.reject(e);
    }
    return Promise.resolve(p).then(function (res) {
      if (!res || typeof res.status !== "number") throw new Error("宿主网络接口返回异常");
      if (!res.ok) throw new WebDavError(res.status, method, url, res.text);
      return res;
    });
  };

  WebDavClient.prototype.propfind = function (path, depth) {
    return this.request("PROPFIND", path, {
      headers: { Depth: String(depth == null ? 1 : depth), "Content-Type": "application/xml" },
      body: PROPFIND_BODY,
      responseType: "text",
      maxBytes: 32 * 1024 * 1024,
    }).then(function (res) {
      if (!res.text || !String(res.text).trim()) return [];
      return parseMultiStatus(res.text, this.baseUrl);
    }.bind(this));
  };

  /** 列目录（不含自身） */
  WebDavClient.prototype.list = function (path) {
    var p = normalizePath(path);
    return this.propfind(p, 1).then(function (entries) {
      return entries.filter(function (e) { return !samePath(e.path, p); });
    });
  };

  /** 单条信息（Depth 0 的自身）；不存在返回 null */
  WebDavClient.prototype.stat = function (path) {
    var p = normalizePath(path);
    return this.propfind(p, 0).then(function (entries) {
      return entries.length ? entries[0] : null;
    });
  };

  WebDavClient.prototype.mkdir = function (path) {
    return this.request("MKCOL", path);
  };

  /** 删除文件/文件夹（服务器递归）；404 视为已删除 */
  WebDavClient.prototype.remove = function (path) {
    var self = this;
    return this.request("DELETE", path).catch(function (e) {
      if (e instanceof WebDavError && e.status === 404) return { status: 404, ok: true, text: "", headers: {} };
      throw e;
    });
  };

  WebDavClient.prototype.move = function (src, dst, overwrite) {
    return this.request("MOVE", src, {
      headers: { Destination: urlFor(this.baseUrl, dst), Overwrite: overwrite ? "T" : "F" },
    });
  };

  WebDavClient.prototype.copy = function (src, dst, overwrite) {
    return this.request("COPY", src, {
      headers: { Destination: urlFor(this.baseUrl, dst), Overwrite: overwrite ? "T" : "F" },
    });
  };

  WebDavClient.prototype.put = function (path, base64, mime) {
    return this.request("PUT", path, {
      bodyBase64: base64 == null ? "" : base64,
      headers: { "Content-Type": mime || mimeOfName(path) },
      timeoutSecs: 300,
    });
  };

  WebDavClient.prototype.getBase64 = function (path, maxBytes) {
    return this.request("GET", path, {
      responseType: "base64",
      maxBytes: maxBytes || MAX_DOWNLOAD,
      timeoutSecs: 300,
    }).then(function (res) { return res.base64 || ""; });
  };

  WebDavClient.prototype.getText = function (path, maxBytes) {
    var self = this;
    return this.request("GET", path, {
      responseType: "base64",
      maxBytes: maxBytes || MAX_TEXT,
      timeoutSecs: 60,
    }).then(function (res) {
      return bytesToText(base64ToBytes(res.base64 || ""), res.contentType);
    });
  };

  /** 连通性测试：PROPFIND 根目录 Depth 0 */
  WebDavClient.prototype.test = function () {
    return this.propfind("/", 0).then(function (entries) {
      return entries[0] || { path: "/", isDir: true, name: "/", size: 0, mtimeMs: 0 };
    });
  };

  /* ============================================================
   * 存储归一化
   * ============================================================ */

  /**
   * 一份配置的身份：地址 + 账号。
   *
   * 用「地址 + 账号」而不是 id 判重：同一个 WebDAV 账号在旧版里被反复保存时，
   * 每次都会生成一个新的 id，但地址和账号完全相同——它们本来就是同一份配置。
   */
  function serverKeyOf(url, username) {
    return String(url || "").trim() + "\u0000" + String(username || "").trim();
  }

  function normalizeServersDetailed(raw) {
    var list = Array.isArray(raw) ? raw : [];
    var seen = {};
    var seenKey = {};
    var out = [];
    var dropped = 0;
    var alias = {};
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (!s || typeof s !== "object") continue;
      var url = String(s.url || "").trim();
      if (!url) continue;
      var user = String(s.username || "");
      var key = serverKeyOf(url, user);
      // 历史 bug 会为同一份配置攒出多条记录：保留第一条，后面的并入（补空字段）
      if (hasOwn(seenKey, key)) {
        var kept = out[seenKey[key]];
        if (!kept.password && s.password) kept.password = String(s.password);
        if (!kept.name && s.name) kept.name = String(s.name).trim();
        if (s.id) alias[String(s.id)] = kept.id;
        dropped++;
        continue;
      }
      var id = String(s.id || "").trim();
      if (!id || hasOwn(seen, id)) id = "srv-" + (i + 1) + "-" + String(i * 7919 + url.length) + "-" + i;
      while (hasOwn(seen, id)) id += "x";
      seen[id] = true;
      seenKey[key] = out.length;
      out.push({
        id: id,
        name: String(s.name || "").trim() || (function () { try { return new URL(/^https?:\/\//i.test(url) ? url : "https://" + url).host; } catch (e) { return "服务器"; } })(),
        url: url,
        username: user,
        password: String(s.password || ""),
      });
    }
    return { list: out, alias: alias, dropped: dropped };
  }

  function normalizeServers(raw) {
    return normalizeServersDetailed(raw).list;
  }

  function normalizeFavorites(raw) {
    var src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    var out = {};
    for (var k in src) {
      if (!hasOwn(src, k)) continue;
      var list = Array.isArray(src[k]) ? src[k] : [];
      var items = [];
      var seen = {};
      for (var i = 0; i < list.length; i++) {
        var it = list[i];
        // 只认 {path,name} 形态；裸字符串等旧数据直接丢弃（插件无历史版本）
        if (!it || typeof it !== "object") continue;
        var path = normalizePath(String(it.path || ""));
        if (path === "/" || hasOwn(seen, path)) continue;
        seen[path] = true;
        items.push({ path: path, name: it.name ? String(it.name) : baseName(path) });
      }
      out[k] = items;
    }
    return out;
  }

  function normalizePrefs(raw) {
    var p = raw && typeof raw === "object" ? raw : {};
    var key = p.sortKey === "size" || p.sortKey === "time" ? p.sortKey : "name";
    var dir = Number(p.sortDir) === -1 ? -1 : 1;
    return {
      sortKey: key,
      sortDir: dir,
      // 严格布尔：字符串 "x" 这类脏值一律视为关
      showHidden: p.showHidden === true || p.showHidden === 1,
    };
  }

  /* ============================================================
   * 流程规划（纯逻辑，可测）
   * ============================================================ */

  /**
   * 上传规划：逐个问「目标目录已有同名文件，是否覆盖」。
   * ask(name) 返回 Promise<boolean>；返回 false 或没有 ask 时跳过该项。
   */
  function planUploads(files, existingNames, ask) {
    var accepted = [], skipped = [];
    var chain = Promise.resolve();
    (files || []).forEach(function (f) {
      chain = chain.then(function () {
        var name = baseName(f.name || f.path);
        if (hasOwn(existingNames || {}, name)) {
          var verdict = ask ? Promise.resolve(ask(name)) : Promise.resolve(false);
          return verdict.then(function (ok) {
            if (ok) accepted.push({ path: f.path, name: name, size: f.size, overwrite: true });
            else skipped.push(name);
          });
        }
        accepted.push({ path: f.path, name: name, size: f.size, overwrite: false });
      });
    });
    return chain.then(function () { return { accepted: accepted, skipped: skipped }; });
  }

  /**
   * 粘贴规划：mode "copy" | "cut"。
   * 返回 { jobs, conflicts, skipped }：
   *   - jobs: { item, name, target, overwrite:false, conflict:bool }
   *   - conflicts: 目标目录同名项的名字列表（调用方统一问一次）
   *   - skipped: { item, reason }
   */
  function planPaste(items, cwd, entries, mode) {
    var jobs = [], conflicts = [], skipped = [];
    var byName = {};
    (entries || []).forEach(function (e) { byName[e.name] = true; });
    (items || []).forEach(function (item) {
      var name = item.name || baseName(item.path);
      var target = joinPath(cwd, name);
      if (samePath(target, item.path)) {
        skipped.push({ item: item, reason: "已在当前目录" });
        return;
      }
      if (mode === "cut" && isUnder(item.path, target)) {
        skipped.push({ item: item, reason: "目标在源目录内部" });
        return;
      }
      var conflict = hasOwn(byName, name);
      if (conflict) conflicts.push(name);
      jobs.push({ item: item, name: name, target: target, overwrite: false, conflict: conflict });
    });
    return { jobs: jobs, conflicts: conflicts, skipped: skipped };
  }

  /* ============================================================
   * 状态与 DOM
   * ============================================================ */

  var dom = {};
  var previewToken = 0; // 预览请求代次：快速翻页时旧响应直接丢弃
  var state = {
    servers: [],
    activeId: "",
    favorites: {},
    prefs: { sortKey: "name", sortDir: 1, showHidden: false },
    client: null,
    cwd: "/",
    entries: [],
    loading: false,
    error: "",
    filter: "",
    selection: {},   // { [path]: true }
    selCount: 0,
    lastIndex: -1,   // shift 范围选择的锚点（visibleEntries 里的下标）
    clipboard: null, // { mode: "copy"|"cut", items: [{path,name,isDir}] }
    preview: null,   // { entry, url, kind }
    busy: false,
    srvEditId: null,
    loadToken: 0,
  };

  function $id(id) { return document.getElementById(id); }

  function bindDom() {
    var ids = [
      "wd-server", "wd-server-manage", "wd-up", "wd-refresh", "wd-new-folder", "wd-upload", "wd-filter",
      "wd-crumbs", "wd-star", "wd-favorites",
      "wd-select-all", "wd-list", "wd-sort-name", "wd-sort-size", "wd-sort-time", "wd-hidden",
      "wd-selection-bar", "wd-selection-count", "wd-sel-download", "wd-sel-copy", "wd-sel-cut",
      "wd-sel-rename", "wd-sel-delete", "wd-sel-clear",
      "wd-paste-bar", "wd-paste-text", "wd-paste-ok", "wd-paste-cancel",
      "wd-progress", "wd-progress-bar", "wd-progress-text", "wd-progress-pct",
      "wd-status", "wd-drop",
      "wd-dlg", "wd-dlg-title", "wd-srv-list", "wd-srv-name", "wd-srv-url", "wd-srv-user", "wd-srv-pass",
      "wd-srv-add", "wd-srv-delete", "wd-srv-cancel", "wd-srv-save",
      "wd-prompt", "wd-prompt-title", "wd-prompt-input", "wd-prompt-ok", "wd-prompt-cancel",
      "wd-preview", "wd-preview-close", "wd-preview-title", "wd-preview-prev", "wd-preview-next",
      "wd-preview-download", "wd-preview-link", "wd-preview-body", "wd-preview-foot",
    ];
    ids.forEach(function (id) { dom[id] = $id(id); });
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function clearNode(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function iconNode(name, cls) {
    var span = el("span", cls || "wd-name-icon");
    span.innerHTML = ICONS[name] || ICONS.file;
    return span;
  }

  function toast(text, type) {
    try {
      if (ms.ui && typeof ms.ui.toast === "function") ms.ui.toast(String(text), type === "error" ? "error" : "ok");
    } catch (e) { /* toast 失败不打扰主流程 */ }
  }

  function uiConfirm(text) {
    try {
      if (ms.ui && typeof ms.ui.confirm === "function") return Promise.resolve(ms.ui.confirm(String(text)));
    } catch (e) { /* 走兜底 */ }
    try {
      if (typeof window !== "undefined" && typeof window.confirm === "function") {
        return Promise.resolve(window.confirm(String(text)));
      }
    } catch (e) { /* ignore */ }
    return Promise.resolve(true);
  }

  function setStatus(text, isError) {
    if (!dom["wd-status"]) return;
    dom["wd-status"].textContent = String(text || "");
    if (dom["wd-status"].classList) {
      if (isError) dom["wd-status"].classList.add("is-error");
      else dom["wd-status"].classList.remove("is-error");
    }
  }

  /* ---------------- 进度 ---------------- */

  function beginProgress(text) {
    if (!dom["wd-progress"]) return;
    dom["wd-progress"].style.display = "block";
    if (dom["wd-progress"].classList) dom["wd-progress"].classList.remove("err");
    setProgressValue(0, text || "准备中…");
  }

  function setProgressValue(pct, text) {
    if (!dom["wd-progress"]) return;
    var v = Math.max(0, Math.min(100, Math.round(pct)));
    if (dom["wd-progress-bar"]) dom["wd-progress-bar"].style.width = v + "%";
    if (dom["wd-progress-pct"]) dom["wd-progress-pct"].textContent = v + "%";
    if (dom["wd-progress-text"] && text != null) dom["wd-progress-text"].textContent = String(text);
    if (dom["wd-progress"].setAttribute) dom["wd-progress"].setAttribute("aria-valuenow", String(v));
  }

  function endProgress(ok, text) {
    if (!dom["wd-progress"]) return;
    if (ok) {
      setProgressValue(100, text || "完成");
      setTimeout(function () {
        if (dom["wd-progress"]) dom["wd-progress"].style.display = "none";
      }, 1500);
    } else {
      if (dom["wd-progress"].classList) dom["wd-progress"].classList.add("err");
      if (dom["wd-progress-text"] && text) dom["wd-progress-text"].textContent = String(text);
      setTimeout(function () {
        if (dom["wd-progress"]) dom["wd-progress"].style.display = "none";
      }, 2500);
    }
  }

  /* ============================================================
   * 存取
   * ============================================================ */

  function storeGet(key, fallback) {
    try { return ms.store.get(key, fallback); } catch (e) { return fallback; }
  }

  function storeSet(key, value) {
    try { return ms.store.set(key, value); } catch (e) { return false; }
  }

  function loadStore() {
    return Promise.all([
      Promise.resolve(storeGet(STORE_SERVERS, [])),
      Promise.resolve(storeGet(STORE_ACTIVE, "")),
      Promise.resolve(storeGet(STORE_FAVORITES, {})),
      Promise.resolve(storeGet(STORE_PREFS, null)),
    ]).then(function (vals) {
      var srv = normalizeServersDetailed(vals[0]);
      state.servers = srv.list;
      state.activeId = String(vals[1] || "");
      state.favorites = normalizeFavorites(vals[2]);
      state.prefs = normalizePrefs(vals[3]);

      // 合并掉的历史重复项：把被删 id 下的收藏并入保留项，活动服务器指向也一并修正
      var favChanged = false;
      for (var from in srv.alias) {
        if (!hasOwn(srv.alias, from)) continue;
        var to = srv.alias[from];
        var src = state.favorites[from];
        if (Array.isArray(src) && src.length) {
          var dst = state.favorites[to] || (state.favorites[to] = []);
          src.forEach(function (f) {
            if (!dst.some(function (d) { return samePath(d.path, f.path); })) dst.push(f);
          });
          favChanged = true;
        }
        if (hasOwn(state.favorites, from)) {
          delete state.favorites[from];
          favChanged = true;
        }
        if (state.activeId === from) state.activeId = to;
      }

      if (!state.servers.some(function (s) { return s.id === state.activeId; })) {
        state.activeId = state.servers.length ? state.servers[0].id : "";
      }

      // 历史重复/脏数据在加载时一次清理并写回，之后每次打开都不会再有同名配置
      var rawCount = Array.isArray(vals[0]) ? vals[0].length : 0;
      if (srv.dropped > 0 || rawCount !== state.servers.length) {
        saveServers();
        saveActive();
        if (favChanged) saveFavorites();
        else if (srv.dropped > 0) saveFavorites();
      }
    });
  }

  function saveServers() { storeSet(STORE_SERVERS, state.servers); }
  function saveFavorites() { storeSet(STORE_FAVORITES, state.favorites); }
  function savePrefs() { storeSet(STORE_PREFS, state.prefs); }

  function saveActive() { storeSet(STORE_ACTIVE, state.activeId); }

  function currentServer() {
    for (var i = 0; i < state.servers.length; i++) {
      if (state.servers[i].id === state.activeId) return state.servers[i];
    }
    return null;
  }

  function favoritesFor(serverId) {
    var list = state.favorites[serverId];
    return Array.isArray(list) ? list : [];
  }

  /** 把 fromId 的收藏并入 toId（去重），返回是否有改动（合并重复服务器时用） */
  function mergeFavoritesInto(fromId, toId) {
    if (!fromId || !toId || fromId === toId) return false;
    var src = state.favorites[fromId];
    var changed = false;
    if (Array.isArray(src) && src.length) {
      var dst = state.favorites[toId] || (state.favorites[toId] = []);
      src.forEach(function (f) {
        if (!dst.some(function (d) { return samePath(d.path, f.path); })) {
          dst.push(f);
          changed = true;
        }
      });
    }
    if (hasOwn(state.favorites, fromId)) {
      delete state.favorites[fromId];
      changed = true;
    }
    return changed;
  }

  /** 应用当前服务器：重建客户端、回到根目录（切服务器不做目录记忆，收藏夹足够快） */
  function applyServer() {
    var server = currentServer();
    state.client = server ? new WebDavClient(server) : null;
    state.cwd = "/";
    state.entries = [];
    state.selection = {};
    state.selCount = 0;
    state.lastIndex = -1;
    state.filter = "";
    state.error = "";
    state.clipboard = null;
    closePreview();
  }

  /* ============================================================
   * 渲染
   * ============================================================ */

  function renderAll() {
    renderToolbar();
    renderServers();
    renderCrumbs();
    renderFavorites();
    renderList();
    renderSelectionBar();
    renderPasteBar();
    renderSortHeader();
  }

  function renderToolbar() {
    var noServer = !state.client;
    ["wd-up", "wd-refresh", "wd-new-folder", "wd-upload"].forEach(function (id) {
      if (dom[id]) dom[id].disabled = noServer || (id !== "wd-refresh" && state.busy);
    });
    if (dom["wd-refresh"]) dom["wd-refresh"].disabled = noServer;
    if (dom["wd-upload"]) dom["wd-upload"].disabled = noServer || state.busy;
  }

  function renderServers() {
    if (!dom["wd-server"]) return;
    clearNode(dom["wd-server"]);
    if (!state.servers.length) {
      var opt = el("option", null, "未配置服务器");
      opt.value = "";
      dom["wd-server"].appendChild(opt);
      dom["wd-server"].disabled = true;
      return;
    }
    dom["wd-server"].disabled = false;
    state.servers.forEach(function (s) {
      var opt = el("option", null, s.name);
      opt.value = s.id;
      if (s.id === state.activeId) opt.selected = true;
      dom["wd-server"].appendChild(opt);
    });
  }

  function renderCrumbs() {
    if (!dom["wd-crumbs"]) return;
    clearNode(dom["wd-crumbs"]);
    var server = currentServer();
    if (!server) {
      dom["wd-crumbs"].appendChild(el("span", "wd-crumb-sep", "未选择服务器"));
      updateStarButton();
      return;
    }
    var rootBtn = el("button", "wd-crumb" + (state.cwd === "/" ? " is-current" : ""), server.name);
    rootBtn.addEventListener("click", function () { loadDir("/"); });
    dom["wd-crumbs"].appendChild(rootBtn);

    var parts = state.cwd.split("/").filter(Boolean);
    var acc = "";
    for (var i = 0; i < parts.length; i++) {
      acc += "/" + parts[i];
      var path = acc;
      var label = parts[i];
      dom["wd-crumbs"].appendChild(el("span", "wd-crumb-sep", "/"));
      (function (p, seg) {
        var isCurrent = p === state.cwd;
        var btn = el("button", "wd-crumb" + (isCurrent ? " is-current" : ""), seg);
        if (!isCurrent) btn.addEventListener("click", function () { loadDir(p); });
        dom["wd-crumbs"].appendChild(btn);
      })(acc, label);
    }
    updateStarButton();
  }

  function updateStarButton() {
    if (!dom["wd-star"]) return;
    var on = currentServer() && favoritesFor(state.activeId).some(function (f) { return samePath(f.path, state.cwd); });
    if (dom["wd-star"].classList) {
      if (on) dom["wd-star"].classList.add("is-on");
      else dom["wd-star"].classList.remove("is-on");
    }
    dom["wd-star"].title = on ? "取消收藏当前文件夹" : "收藏当前文件夹";
  }

  function renderFavorites() {
    if (!dom["wd-favorites"]) return;
    clearNode(dom["wd-favorites"]);
    if (!currentServer()) return;
    var favs = favoritesFor(state.activeId);
    if (!favs.length) {
      dom["wd-favorites"].appendChild(el("span", "wd-fav-hint", "收藏夹为空：进入文件夹后点右上角 ☆ 收藏"));
      return;
    }
    favs.forEach(function (fav) {
      var item = el("span", "wd-fav-item");
      var link = el("button", "wd-fav-link", "★ " + (fav.name || baseName(fav.path)));
      link.title = fav.path;
      link.addEventListener("click", function () { loadDir(fav.path); });
      var del = el("button", "wd-fav-del", "×");
      del.title = "移除收藏";
      del.addEventListener("click", function () {
        removeFavorite(fav.path);
        renderAll();
      });
      item.appendChild(link);
      item.appendChild(del);
      dom["wd-favorites"].appendChild(item);
    });
  }

  function renderSortHeader() {
    var map = { name: "wd-sort-name", size: "wd-sort-size", time: "wd-sort-time" };
    for (var k in map) {
      if (!hasOwn(map, k)) continue;
      var btn = dom[map[k]];
      if (!btn) continue;
      var active = state.prefs.sortKey === k;
      if (btn.classList) {
        if (active) btn.classList.add("is-active");
        else btn.classList.remove("is-active");
      }
      btn.textContent = (k === "name" ? "名称" : k === "size" ? "大小" : "修改时间") + (active ? (state.prefs.sortDir === 1 ? " ▲" : " ▼") : "");
    }
    if (dom["wd-hidden"]) dom["wd-hidden"].textContent = state.prefs.showHidden ? "隐藏文件：开" : "隐藏文件：关";
  }

  function visibleEntries() {
    var kw = state.filter.trim().toLowerCase();
    var out = state.entries.filter(function (e) {
      if (!state.prefs.showHidden && e.name.charAt(0) === ".") return false;
      if (kw && String(e.name).toLowerCase().indexOf(kw) < 0) return false;
      return true;
    });
    out.sort(cmpEntries);
    return out;
  }

  function cmpEntries(a, b) {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    var d = state.prefs.sortDir;
    if (state.prefs.sortKey === "size") return ((a.size || 0) - (b.size || 0)) * d;
    if (state.prefs.sortKey === "time") return ((a.mtimeMs || 0) - (b.mtimeMs || 0)) * d;
    return String(a.name).localeCompare(String(b.name), "zh-CN", { numeric: true, sensitivity: "base" }) * d;
  }

  function renderList() {
    if (!dom["wd-list"]) return;
    clearNode(dom["wd-list"]);
    updateSelectAllBox();

    if (!currentServer()) {
      dom["wd-list"].appendChild(el("div", "wd-row is-empty", "尚未配置服务器：点右上角 ⚙ 添加一个 WebDAV 服务器"));
      return;
    }
    if (state.loading && !state.entries.length) {
      dom["wd-list"].appendChild(el("div", "wd-row is-loading", "加载中…"));
      return;
    }
    if (state.error) {
      var errRow = el("div", "wd-row is-error");
      errRow.appendChild(el("div", null, "加载失败：" + state.error));
      var retry = el("button", "wd-btn", "重试");
      retry.addEventListener("click", function () { loadDir(state.cwd); });
      errRow.appendChild(retry);
      if (state.error.indexOf("401") >= 0) {
        var cfg = el("button", "wd-btn", "检查服务器设置");
        cfg.addEventListener("click", function () { openServerDialog(); });
        errRow.appendChild(cfg);
      }
      dom["wd-list"].appendChild(errRow);
      return;
    }

    var list = visibleEntries();
    if (!list.length) {
      dom["wd-list"].appendChild(el("div", "wd-row is-empty", state.filter ? "没有匹配「" + state.filter + "」的条目" : "空目录"));
      return;
    }
    list.forEach(function (entry, index) {
      dom["wd-list"].appendChild(buildRow(entry, index));
    });
    var hiddenCount = state.prefs.showHidden
      ? 0
      : state.entries.filter(function (e) { return e.name.charAt(0) === "."; }).length;
    var nFiles = 0, nDirs = 0;
    state.entries.forEach(function (e) { if (e.isDir) nDirs++; else nFiles++; });
    setStatus(nDirs + " 个文件夹、 " + nFiles + " 个文件" + (state.filter ? "（过滤后 " + list.length + " 项）" : "") + (hiddenCount && !state.prefs.showHidden ? " · " + hiddenCount + " 个隐藏项未显示" : ""));
  }

  function buildRow(entry, index) {
    var selected = !!state.selection[entry.path];
    var row = el("div", "wd-row" + (selected ? " is-selected" : ""));
    row.setAttribute("data-path", entry.path);

    var cb = el("input");
    cb.type = "checkbox";
    cb.className = "wd-check";
    cb.checked = selected;
    cb.addEventListener("click", function (e) {
      e.stopPropagation();
    });
    cb.addEventListener("change", function () {
      toggleSelect(entry.path, cb.checked);
    });
    row.appendChild(cb);

    var nameWrap = el("div", "wd-name");
    var kind = kindOfEntry(entry);
    nameWrap.appendChild(iconNode(kind === "dir" ? "folder" : kind === "image" ? "image" : kind === "audio" || kind === "video" ? "audio" : kind === "pdf" ? "pdf" : kind === "markdown" || kind === "text" ? "text" : "file",
      "wd-name-icon" + (kind === "dir" ? " is-dir" : kind === "image" ? " is-image" : kind === "audio" || kind === "video" ? " is-media" : kind === "pdf" ? " is-pdf" : "")));
    var nameBtn = el("button", "wd-name-btn", entry.name);
    nameBtn.title = entry.path;
    nameBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      openEntry(entry);
    });
    nameWrap.appendChild(nameBtn);
    row.appendChild(nameWrap);

    row.appendChild(el("span", "wd-cell", entry.isDir ? "-" : fmtSize(entry.size)));
    row.appendChild(el("span", "wd-cell", fmtTime(entry.mtimeMs)));

    var actions = el("span", "wd-actions");
    if (!entry.isDir && isPreviewable(entry)) {
      var previewBtn = el("button", "wd-act-btn", "");
      previewBtn.title = "预览";
      previewBtn.innerHTML = ICONS.eye;
      previewBtn.addEventListener("click", function (e) { e.stopPropagation(); openPreview(entry); });
      actions.appendChild(previewBtn);
    }
    if (!entry.isDir) {
      var dlBtn = el("button", "wd-act-btn", "");
      dlBtn.title = "下载";
      dlBtn.innerHTML = ICONS.download;
      dlBtn.addEventListener("click", function (e) { e.stopPropagation(); downloadEntries([entry]); });
      actions.appendChild(dlBtn);
    }
    var renameBtn = el("button", "wd-act-btn", "");
    renameBtn.title = "重命名";
    renameBtn.innerHTML = ICONS.rename;
    renameBtn.addEventListener("click", function (e) { e.stopPropagation(); renameEntry(entry); });
    actions.appendChild(renameBtn);
    var delBtn = el("button", "wd-act-btn is-danger", "");
    delBtn.title = "删除";
    delBtn.innerHTML = ICONS.trash;
    delBtn.addEventListener("click", function (e) { e.stopPropagation(); deleteEntries([entry]); });
    actions.appendChild(delBtn);
    row.appendChild(actions);

    row.addEventListener("click", function (e) {
      onRowClick(entry, index, e);
    });
    row.addEventListener("dblclick", function (e) {
      if (e.target && e.target.closest && e.target.closest("button, input")) return;
      openEntry(entry);
    });
    return row;
  }

  function updateSelectAllBox() {
    if (!dom["wd-select-all"]) return;
    var list = visibleEntries();
    var selected = list.filter(function (e) { return state.selection[e.path]; }).length;
    dom["wd-select-all"].checked = list.length > 0 && selected === list.length;
    try { dom["wd-select-all"].indeterminate = selected > 0 && selected < list.length; } catch (e) { /* 桩可能不支持 */ }
  }

  function renderSelectionBar() {
    if (!dom["wd-selection-bar"]) return;
    var sel = selectedEntries();
    if (!sel.length) {
      dom["wd-selection-bar"].style.display = "none";
      return;
    }
    dom["wd-selection-bar"].style.display = "flex";
    if (dom["wd-selection-count"]) dom["wd-selection-count"].textContent = "已选 " + sel.length + " 项";
    var hasDir = sel.some(function (e) { return e.isDir; });
    if (dom["wd-sel-download"]) dom["wd-sel-download"].disabled = hasDir || state.busy;
    if (dom["wd-sel-rename"]) dom["wd-sel-rename"].disabled = sel.length !== 1 || state.busy;
    if (dom["wd-sel-delete"]) dom["wd-sel-delete"].disabled = state.busy;
    if (dom["wd-sel-copy"]) dom["wd-sel-copy"].disabled = state.busy;
    if (dom["wd-sel-cut"]) dom["wd-sel-cut"].disabled = state.busy;
  }

  function renderPasteBar() {
    if (!dom["wd-paste-bar"]) return;
    if (!state.clipboard) {
      dom["wd-paste-bar"].style.display = "none";
      return;
    }
    dom["wd-paste-bar"].style.display = "flex";
    if (dom["wd-paste-text"]) {
      dom["wd-paste-text"].textContent =
        (state.clipboard.mode === "cut" ? "已剪切 " : "已复制 ") + state.clipboard.items.length + " 项 — 粘贴到当前目录";
    }
    if (dom["wd-paste-ok"]) dom["wd-paste-ok"].disabled = state.busy || !state.client;
  }

  /* ============================================================
   * 选择
   * ============================================================ */

  function selectedEntries() {
    return state.entries.filter(function (e) { return state.selection[e.path]; });
  }

  function setSelection(map) {
    state.selection = map || {};
    state.selCount = 0;
    for (var k in state.selection) if (hasOwn(state.selection, k)) state.selCount++;
    renderList();
    renderSelectionBar();
  }

  function toggleSelect(path, on) {
    if (on === undefined) on = !state.selection[path];
    if (on) state.selection[path] = true;
    else delete state.selection[path];
    state.selCount = selectedEntries().length;
    renderList();
    renderSelectionBar();
  }

  function selectOnly(path) {
    var map = {};
    map[path] = true;
    setSelection(map);
  }

  function onRowClick(entry, index, e) {
    if (e && (e.ctrlKey || e.metaKey)) {
      toggleSelect(entry.path);
    } else if (e && e.shiftKey && state.lastIndex >= 0) {
      var list = visibleEntries();
      var from = Math.min(state.lastIndex, index), to = Math.max(state.lastIndex, index);
      var map = {};
      for (var i = from; i <= to; i++) if (list[i]) map[list[i].path] = true;
      setSelection(map);
    } else {
      selectOnly(entry.path);
    }
    state.lastIndex = index;
  }

  /* ============================================================
   * 导航
   * ============================================================ */

  function openEntry(entry) {
    if (entry.isDir) loadDir(entry.path);
    else if (isPreviewable(entry)) openPreview(entry);
    else downloadEntries([entry]);
  }

  function loadDir(path) {
    if (!state.client) {
      openServerDialog();
      return;
    }
    var p = normalizePath(path);
    var token = ++state.loadToken;
    state.loading = true;
    state.error = "";
    state.selection = {};
    state.selCount = 0;
    state.lastIndex = -1;
    renderAll();
    return state.client.list(p).then(function (entries) {
      if (token !== state.loadToken) return;
      state.cwd = p;
      state.entries = entries;
      state.loading = false;
      renderAll();
    }).catch(function (e) {
      if (token !== state.loadToken) return;
      state.loading = false;
      state.error = explainError(e);
      renderAll();
      toast(state.error, "error");
    });
  }

  function refresh() { loadDir(state.cwd); }

  /* ============================================================
   * 收藏夹
   * ============================================================ */

  function toggleFavorite() {
    var favs = favoritesFor(state.activeId);
    var idx = -1;
    for (var i = 0; i < favs.length; i++) {
      if (samePath(favs[i].path, state.cwd)) { idx = i; break; }
    }
    if (idx >= 0) favs.splice(idx, 1);
    else favs.push({ path: state.cwd, name: baseName(state.cwd) || "根目录" });
    state.favorites[state.activeId] = favs;
    saveFavorites();
    renderAll();
    toast(idx >= 0 ? "已取消收藏" : "已收藏当前文件夹");
  }

  function removeFavorite(path) {
    var favs = favoritesFor(state.activeId);
    state.favorites[state.activeId] = favs.filter(function (f) { return !samePath(f.path, path); });
    saveFavorites();
  }

  /** 重命名/移动后同步修正收藏夹（含子目录收藏整体换前缀） */
  function renameFavorites(serverId, from, to) {
    var favs = state.favorites[serverId];
    if (!Array.isArray(favs)) return;
    state.favorites[serverId] = favs.map(function (f) {
      var newPath = replacePrefix(f.path, from, to);
      // 名字跟着路径走：只有收藏路径真的变了才重算
      return { path: newPath, name: samePath(newPath, f.path) ? f.name : (baseName(newPath) || f.name) };
    });
    saveFavorites();
  }

  /** 删除后清理指向被删路径（或其子路径）的收藏 */
  function pruneFavorites(serverId, deletedPaths) {
    var favs = state.favorites[serverId];
    if (!Array.isArray(favs)) return;
    state.favorites[serverId] = favs.filter(function (f) {
      return !deletedPaths.some(function (d) { return samePath(d, f.path) || isUnder(d, f.path); });
    });
    saveFavorites();
  }

  /* ============================================================
   * 上传
   * ============================================================ */

  function pickAndUpload() {
    if (!state.client) { openServerDialog(); return; }
    if (state.busy) { toast("有任务正在进行，请稍候", "error"); return; }
    if (!ms.input || typeof ms.input.pickFiles !== "function") {
      toast("当前宿主版本不支持选择文件，请更新应用", "error");
      return;
    }
    return Promise.resolve(ms.input.pickFiles()).then(function (files) {
      if (!Array.isArray(files) || !files.length) return;
      return runUpload(files.map(function (f) { return { path: f.path, name: f.name, size: f.size }; }));
    }).catch(function (e) {
      toast(explainError(e), "error");
    });
  }

  function uploadDropped(paths) {
    if (!state.client) { openServerDialog(); return; }
    if (state.busy) { toast("有任务正在进行，请稍候", "error"); return; }
    var files = (paths || []).filter(function (p) { return p && String(p).trim(); })
      .map(function (p) { return { path: String(p), name: baseName(p) }; });
    if (!files.length) return Promise.resolve();
    return runUpload(files);
  }

  function runUpload(files) {
    var existing = {};
    state.entries.forEach(function (e) { existing[e.name] = true; });
    state.busy = true;
    renderToolbar();
    beginProgress("准备上传…");
    return planUploads(files, existing, function (name) {
      return uiConfirm("当前目录已有「" + name + "」，覆盖吗？");
    }).then(function (plan) {
      var okCount = 0, failCount = 0, failMsg = "";
      var total = plan.accepted.length;
      var chain = Promise.resolve();
      plan.accepted.forEach(function (item, i) {
        chain = chain.then(function () {
          setProgressValue((i / Math.max(1, total)) * 100, "上传 " + item.name);
          return uploadOne(state.client, item.path, joinPath(state.cwd, item.name)).then(function () {
            okCount++;
          }).catch(function (e) {
            failCount++;
            failMsg = explainError(e);
          });
        });
      });
      return chain.then(function () {
        state.busy = false;
        renderToolbar();
        endProgress(failCount === 0, failCount ? "上传失败：" + failMsg : "上传完成");
        refresh();
        if (total === 0) toast(plan.skipped.length ? "已跳过 " + plan.skipped.length + " 个同名文件" : "没有要上传的文件");
        else toast("上传完成 " + okCount + " 个" + (plan.skipped.length ? "，跳过 " + plan.skipped.length + " 个" : "") + (failCount ? "，失败 " + failCount + " 个（" + failMsg + "）" : ""), failCount ? "error" : "ok");
      });
    }).catch(function (e) {
      state.busy = false;
      renderToolbar();
      endProgress(false, explainError(e));
      toast(explainError(e), "error");
    });
  }

  /** 读一个本地文件（宿主返回 data URL）并 PUT 到目标路径 */
  function uploadOne(client, srcPath, targetPath) {
    return Promise.resolve(ms.input.readFile(srcPath)).then(function (dataUrl) {
      var parts = dataUrlParts(dataUrl);
      if (!parts) throw new Error("读取文件失败：宿主返回的数据无法解析");
      if (parts.bytes > MAX_UPLOAD) {
        throw new Error("文件超过上传上限（" + fmtSize(MAX_UPLOAD) + "）：" + baseName(targetPath));
      }
      var mime = parts.mime || mimeOfName(targetPath);
      return client.put(targetPath, parts.base64, mime);
    });
  }

  /* ============================================================
   * 下载
   * ============================================================ */

  function downloadEntries(list) {
    if (!state.client) return;
    var files = (list || []).filter(function (e) { return !e.isDir; });
    if (!files.length) { toast("文件夹暂不支持打包下载", "error"); return; }
    if (state.busy) { toast("有任务正在进行，请稍候", "error"); return; }
    state.busy = true;
    renderToolbar();
    beginProgress("准备下载…");
    var okCount = 0, cancelled = false, failMsg = "";
    var chain = Promise.resolve();
    files.forEach(function (entry, i) {
      chain = chain.then(function () {
        if (cancelled) return;
        setProgressValue((i / files.length) * 100, "下载 " + entry.name);
        return state.client.getBase64(entry.path, MAX_DOWNLOAD).then(function (b64) {
          return Promise.resolve(ms.input.saveFile(entry.name, b64)).then(function (saved) {
            if (saved == null) { cancelled = true; return; }
            okCount++;
          });
        }).catch(function (e) {
          failMsg = explainError(e);
        });
      });
    });
    return chain.then(function () {
      state.busy = false;
      renderToolbar();
      endProgress(!failMsg && !cancelled, cancelled ? "已取消" : failMsg ? "下载失败：" + failMsg : "下载完成");
      if (cancelled) toast("已保存 " + okCount + " 个，其余已取消");
      else if (failMsg) toast("下载失败：" + failMsg, "error");
      else toast("已保存 " + okCount + " 个文件");
    });
  }

  /* ============================================================
   * 剪贴板（站内复制/剪切/粘贴）
   * ============================================================ */

  function clipboardSet(mode) {
    var sel = selectedEntries();
    if (!sel.length) return;
    state.clipboard = {
      mode: mode,
      items: sel.map(function (e) { return { path: e.path, name: e.name, isDir: e.isDir }; }),
    };
    renderPasteBar();
    toast((mode === "cut" ? "已剪切 " : "已复制 ") + sel.length + " 项：导航到目标文件夹后点「粘贴到这里」");
  }

  function clipboardClear() {
    state.clipboard = null;
    renderPasteBar();
  }

  function clipboardPaste() {
    if (!state.client || !state.clipboard || state.busy) return;
    var mode = state.clipboard.mode;
    var plan = planPaste(state.clipboard.items, state.cwd, state.entries, mode);
    var jobs = plan.jobs;
    if (!jobs.length) {
      toast(plan.skipped.length ? plan.skipped[0].reason : "没有可粘贴的条目", "error");
      return;
    }
    var ask = function () {
      if (!plan.conflicts.length) return Promise.resolve(true);
      return uiConfirm("目标目录已有同名项：" + plan.conflicts.slice(0, 3).join("、") + (plan.conflicts.length > 3 ? " 等 " + plan.conflicts.length + " 项" : "") + "，覆盖吗？");
    };
    state.busy = true;
    renderToolbar();
    beginProgress("粘贴中…");
    return ask().then(function (overwriteAll) {
      if (!overwriteAll) jobs = jobs.filter(function (j) { return !j.conflict; });
      var okCount = 0, failCount = 0, failMsg = "";
      var chain = Promise.resolve();
      jobs.forEach(function (job, i) {
        chain = chain.then(function () {
          setProgressValue((i / Math.max(1, jobs.length)) * 100, (mode === "cut" ? "移动 " : "复制 ") + job.name);
          var op = mode === "cut" ? state.client.move : state.client.copy;
          return op.call(state.client, job.item.path, job.target, job.conflict).then(function () {
            okCount++;
            if (mode === "cut") renameFavorites(state.activeId, job.item.path, job.target);
          }).catch(function (e) {
            failCount++;
            failMsg = explainError(e);
          });
        });
      });
      return chain.then(function () {
        state.busy = false;
        if (mode === "cut") clipboardClear();
        renderToolbar();
        endProgress(failCount === 0, failCount ? "粘贴失败：" + failMsg : "粘贴完成");
        refresh();
        toast((mode === "cut" ? "移动完成 " : "复制完成 ") + okCount + " 项" + (failCount ? "，失败 " + failCount + " 项（" + failMsg + "）" : "") + (jobs.length < plan.jobs.length ? "，已保留同名项" : ""), failCount ? "error" : "ok");
      });
    }).catch(function (e) {
      state.busy = false;
      renderToolbar();
      endProgress(false, explainError(e));
      toast(explainError(e), "error");
    });
  }

  /* ============================================================
   * 新建 / 重命名 / 删除
   * ============================================================ */

  function newFolder() {
    if (!state.client) return;
    return showPrompt("新建文件夹", "新建文件夹").then(function (name) {
      if (name == null) return;
      name = name.trim();
      var err = validateName(name);
      if (err) { toast(err, "error"); return; }
      var target = joinPath(state.cwd, name);
      state.busy = true;
      return state.client.mkdir(target).then(function () {
        state.busy = false;
        return refresh();
      }).catch(function (e) {
        state.busy = false;
        var msg = explainError(e);
        if (e instanceof WebDavError && e.status === 405) msg = "同名文件或文件夹已存在";
        toast(msg, "error");
        return refresh();
      });
    });
  }

  function renameEntry(entry) {
    if (!state.client || state.busy) return;
    return showPrompt("重命名", entry.name).then(function (name) {
      if (name == null) return;
      name = name.trim();
      if (!name || name === entry.name) return;
      var err = validateName(name);
      if (err) { toast(err, "error"); return; }
      var target = joinPath(parentPath(entry.path), name);
      state.busy = true;
      return state.client.move(entry.path, target, false).then(function () {
        state.busy = false;
        renameFavorites(state.activeId, entry.path, target);
        return refresh();
      }).then(function () {
        toast("已重命名为 " + name);
      }).catch(function (e) {
        state.busy = false;
        var msg = explainError(e);
        if (e instanceof WebDavError && e.status === 412) msg = "同名文件已存在（412）";
        toast(msg, "error");
      });
    });
  }

  function deleteEntries(list) {
    if (!state.client || state.busy) return;
    var items = (list || []).slice();
    if (!items.length) return;
    var names = items.map(function (e) { return e.name; });
    return uiConfirm("确定删除 " + items.length + " 项吗？（" + names.slice(0, 3).join("、") + (names.length > 3 ? " 等" : "") + "）文件夹会整体递归删除，不可恢复。")
      .then(function (ok) {
        if (!ok) return;
        state.busy = true;
        renderToolbar();
        beginProgress("删除中…");
        var okCount = 0, failCount = 0, failMsg = "";
        var chain = Promise.resolve();
        items.forEach(function (entry, i) {
          chain = chain.then(function () {
            setProgressValue((i / items.length) * 100, "删除 " + entry.name);
            return state.client.remove(entry.path).then(function () {
              okCount++;
            }).catch(function (e) {
              failCount++;
              failMsg = explainError(e);
            });
          });
        });
        return chain.then(function () {
          state.busy = false;
          renderToolbar();
          endProgress(failCount === 0, failCount ? "删除失败：" + failMsg : "删除完成");
          pruneFavorites(state.activeId, items.map(function (e) { return e.path; }));
          setSelection({});
          refresh();
          toast("已删除 " + okCount + " 项" + (failCount ? "，失败 " + failCount + " 项（" + failMsg + "）" : ""), failCount ? "error" : "ok");
        });
      });
  }

  /* ============================================================
   * 预览
   * ============================================================ */

  function previewableFiles() {
    return visibleEntries().filter(isPreviewable);
  }

  function openPreview(entry) {
    if (!state.client) return;
    var kind = kindOfEntry(entry);
    closePreview();
    state.preview = { entry: entry, url: null, kind: kind };
    if (dom["wd-preview"]) {
      dom["wd-preview"].style.display = "flex";
      if (dom["wd-preview-title"]) dom["wd-preview-title"].textContent = entry.name;
      if (dom["wd-preview-foot"]) dom["wd-preview-foot"].textContent = fmtSize(entry.size) + (entry.mtimeMs ? " · " + fmtTime(entry.mtimeMs) : "");
      updatePreviewNav();
    }
    renderPreviewBody();
    fetchPreview(entry, kind);
  }

  function updatePreviewNav() {
    var files = previewableFiles();
    var idx = -1;
    for (var i = 0; i < files.length; i++) {
      if (state.preview && samePath(files[i].path, state.preview.entry.path)) { idx = i; break; }
    }
    if (dom["wd-preview-prev"]) dom["wd-preview-prev"].disabled = idx <= 0;
    if (dom["wd-preview-next"]) dom["wd-preview-next"].disabled = idx < 0 || idx >= files.length - 1;
  }

  function clearPreviewBody() {
    if (!dom["wd-preview-body"]) return;
    clearNode(dom["wd-preview-body"]);
  }

  function renderPreviewBody() {
    clearPreviewBody();
    if (!dom["wd-preview-body"]) return;
    dom["wd-preview-body"].appendChild(el("div", "wd-preview-msg", "加载中…"));
  }

  function setPreviewMessage(text, isError) {
    clearPreviewBody();
    if (!dom["wd-preview-body"]) return;
    dom["wd-preview-body"].appendChild(el("div", "wd-preview-msg" + (isError ? " is-error" : ""), text));
  }

  function fetchPreview(entry, kind) {
    var client = state.client;
    var mine = ++previewToken;
    if (entry.size > MAX_DOWNLOAD) {
      setPreviewMessage("文件超过预览上限（" + fmtSize(MAX_DOWNLOAD) + "），请直接下载", true);
      return;
    }
    if (kind === "text" || kind === "markdown") {
      client.getText(entry.path, MAX_TEXT).then(function (text) {
        if (!isPreviewCurrent(mine, entry)) return;
        renderTextPreview(text, kind === "markdown");
      }).catch(function (e) {
        if (!isPreviewCurrent(mine, entry)) return;
        setPreviewMessage("加载失败：" + explainError(e), true);
      });
      return;
    }
    client.getBase64(entry.path, MAX_DOWNLOAD).then(function (b64) {
      if (!isPreviewCurrent(mine, entry)) return;
      renderMediaPreview(entry, kind, b64);
    }).catch(function (e) {
      if (!isPreviewCurrent(mine, entry)) return;
      setPreviewMessage("加载失败：" + explainError(e), true);
    });
  }

  function isPreviewCurrent(token, entry) {
    return token === previewToken && state.preview && samePath(state.preview.entry.path, entry.path);
  }

  function renderTextPreview(text, isMarkdown) {
    clearPreviewBody();
    if (!dom["wd-preview-body"]) return;
    if (isMarkdown && typeof md2html === "function") {
      var box = el("div", "wd-preview-md");
      box.innerHTML = md2html(text);
      dom["wd-preview-body"].appendChild(box);
    } else {
      var pre = el("pre", "wd-preview-text");
      pre.textContent = String(text == null ? "" : text);
      dom["wd-preview-body"].appendChild(pre);
    }
  }

  function renderMediaPreview(entry, kind, b64) {
    var bytes = base64ToBytes(b64);
    var mime = entry.contentType || mimeOfName(entry.name);
    var blob;
    try {
      blob = new Blob([bytes], { type: mime });
    } catch (e) {
      setPreviewMessage("无法构造预览数据", true);
      return;
    }
    var url = URL.createObjectURL(blob);
    revokePreviewUrl();
    state.preview.url = url;
    clearPreviewBody();
    if (!dom["wd-preview-body"]) return;
    var node;
    if (kind === "image") {
      node = document.createElement("img");
      node.src = url;
      node.alt = entry.name;
    } else if (kind === "audio") {
      node = document.createElement("audio");
      node.controls = true;
      node.src = url;
    } else if (kind === "video") {
      node = document.createElement("video");
      node.controls = true;
      node.src = url;
    } else if (kind === "pdf") {
      node = document.createElement("iframe");
      node.src = url;
    } else {
      setPreviewMessage("该类型暂不支持预览", false);
      return;
    }
    dom["wd-preview-body"].appendChild(node);
  }

  function revokePreviewUrl() {
    if (state.preview && state.preview.url) {
      try { URL.revokeObjectURL(state.preview.url); } catch (e) { /* ignore */ }
      state.preview.url = null;
    }
  }

  function closePreview() {
    revokePreviewUrl();
    state.preview = null;
    previewToken++;
    if (dom["wd-preview"]) dom["wd-preview"].style.display = "none";
  }

  function previewStep(delta) {
    if (!state.preview) return;
    var files = previewableFiles();
    var idx = -1;
    for (var i = 0; i < files.length; i++) {
      if (samePath(files[i].path, state.preview.entry.path)) { idx = i; break; }
    }
    if (idx < 0) return;
    var next = files[idx + delta];
    if (next) openPreview(next);
  }

  function previewCopyLink() {
    if (!state.preview || !state.client) return;
    var url = urlFor(state.client.baseUrl, state.preview.entry.path);
    try {
      if (ms.clipboard && typeof ms.clipboard.writeText === "function") {
        Promise.resolve(ms.clipboard.writeText(url)).then(function () {
          toast("已复制直链");
        }).catch(function (e) {
          toast("复制失败：" + explainError(e) + "（可在插件面板授权「写剪贴板」）", "error");
        });
        return;
      }
    } catch (e) { /* fallthrough */ }
    toast("当前宿主不支持复制，链接见下方状态栏", "error");
    setStatus(url);
  }

  /* ============================================================
   * 对话框
   * ============================================================ */

  var promptResolver = null;

  /** 返回 Promise<string|null>：确定 → 输入值（trim 后），取消 → null */
  function showPrompt(title, defaultValue) {
    if (!dom["wd-prompt"] || !dom["wd-prompt-input"]) {
      return Promise.resolve(null);
    }
    if (dom["wd-prompt-title"]) dom["wd-prompt-title"].textContent = String(title || "输入");
    dom["wd-prompt-input"].value = String(defaultValue == null ? "" : defaultValue);
    dom["wd-prompt"].style.display = "flex";
    try { dom["wd-prompt-input"].focus(); } catch (e) { /* ignore */ }
    return new Promise(function (resolve) {
      promptResolver = resolve;
    });
  }

  function settlePrompt(ok) {
    var resolve = promptResolver;
    promptResolver = null;
    if (!dom["wd-prompt"]) return;
    dom["wd-prompt"].style.display = "none";
    if (!resolve) return;
    var value = ok && dom["wd-prompt-input"] ? String(dom["wd-prompt-input"].value || "") : null;
    resolve(value == null ? null : value.trim());
  }

  function openServerDialog() {
    if (!dom["wd-dlg"]) return;
    // 打开时就进入「编辑当前服务器」状态：表单里显示的是哪台，保存就更新哪台。
    // 旧版这里固定置 null，于是「打开 → 直接保存」必然新增一条同名配置。
    var current = currentServer();
    state.srvEditId = current ? current.id : null;
    fillServerForm(current || null);
    renderServerList();
    dom["wd-dlg"].style.display = "flex";
    try { if (dom["wd-srv-name"]) dom["wd-srv-name"].focus(); } catch (e) { /* ignore */ }
  }

  function closeServerDialog() {
    state.srvEditId = null;
    if (dom["wd-dlg"]) dom["wd-dlg"].style.display = "none";
  }

  function renderServerList() {
    if (!dom["wd-srv-list"]) return;
    clearNode(dom["wd-srv-list"]);
    var editing = null;
    state.servers.forEach(function (s) {
      if (s.id === state.srvEditId) editing = s;
      var item = el("div", "wd-srv-item" + (s.id === state.srvEditId ? " is-active" : ""));
      item.appendChild(el("span", "wd-srv-name", s.name || s.id));
      item.appendChild(el("span", "wd-srv-url", s.url));
      if (s.id === state.activeId) item.appendChild(el("span", "wd-srv-badge", "当前"));
      item.addEventListener("click", function () {
        state.srvEditId = s.id;
        fillServerForm(s);
        renderServerList();
      });
      dom["wd-srv-list"].appendChild(item);
    });
    // 标题写明「正在编辑哪台 / 正在新增」，避免用户以为打开对话框就是新配置
    if (dom["wd-dlg-title"]) {
      dom["wd-dlg-title"].textContent = editing
        ? "服务器设置 · 编辑「" + (editing.name || editing.url) + "」"
        : "服务器设置 · 新增";
    }
  }

  function fillServerForm(server) {
    if (dom["wd-srv-name"]) dom["wd-srv-name"].value = server ? String(server.name || "") : "";
    if (dom["wd-srv-url"]) dom["wd-srv-url"].value = server ? String(server.url || "") : "";
    if (dom["wd-srv-user"]) dom["wd-srv-user"].value = server ? String(server.username || "") : "";
    if (dom["wd-srv-pass"]) dom["wd-srv-pass"].value = server ? String(server.password || "") : "";
  }

  /** 读表单 → 校验 → 新增/更新服务器；成功返回 true 并关对话框 */
  function saveServerForm() {
    var url;
    try {
      url = normalizeBaseUrl(dom["wd-srv-url"] ? dom["wd-srv-url"].value : "");
    } catch (e) {
      toast(String(e.message || e), "error");
      return false;
    }
    var name = String(dom["wd-srv-name"] && dom["wd-srv-name"].value || "").trim();
    if (!name) {
      try { name = new URL(url).host; } catch (e) { name = "服务器"; }
    }
    var user = String(dom["wd-srv-user"] && dom["wd-srv-user"].value || "").trim();
    var pass = String(dom["wd-srv-pass"] && dom["wd-srv-pass"].value || "");
    var key = serverKeyOf(url, user);
    var targetId = state.srvEditId;
    if (!targetId) {
      // 「新增」时地址+账号已经存在：视为编辑那台，不再凭空多一条
      for (var j = 0; j < state.servers.length; j++) {
        if (serverKeyOf(state.servers[j].url, state.servers[j].username) === key) {
          targetId = state.servers[j].id;
          break;
        }
      }
    }
    if (targetId) {
      var edit = null;
      for (var i = 0; i < state.servers.length; i++) {
        if (state.servers[i].id === targetId) { edit = state.servers[i]; break; }
      }
      if (edit) {
        edit.name = name;
        edit.url = url;
        edit.username = user;
        edit.password = pass;
      } else {
        targetId = ""; // 编辑目标已被删除：退回新增
      }
    }
    if (targetId) {
      // 改成了与另一条完全相同的地址+账号：把它并进当前这条（历史重复数据的自然收敛）
      var mergedFav = false;
      var rest = [];
      for (var m = 0; m < state.servers.length; m++) {
        var s = state.servers[m];
        if (s.id !== targetId && serverKeyOf(s.url, s.username) === key) {
          mergedFav = mergeFavoritesInto(s.id, targetId) || mergedFav;
          continue;
        }
        rest.push(s);
      }
      if (rest.length !== state.servers.length) state.servers = rest;
      if (mergedFav) saveFavorites();
    } else {
      var id = "srv-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e6).toString(36);
      while (state.servers.some(function (s) { return s.id === id; })) id += "x";
      state.servers.push({ id: id, name: name, url: url, username: user, password: pass });
      targetId = id;
    }
    state.srvEditId = targetId;
    if (!state.activeId || !state.servers.some(function (s) { return s.id === state.activeId; })) {
      state.activeId = targetId;
    }
    saveServers();
    saveActive();
    closeServerDialog();
    applyServer();
    renderAll();
    if (state.client) loadDir("/");
    return true;
  }

  function deleteServer() {
    var target = state.srvEditId || state.activeId;
    if (!target) { toast("没有可删除的服务器", "error"); return; }
    var server = null;
    for (var i = 0; i < state.servers.length; i++) if (state.servers[i].id === target) server = state.servers[i];
    if (!server) return;
    uiConfirm("确定删除服务器「" + (server.name || server.id) + "」吗？仅移除本地配置，不会动云端文件。").then(function (ok) {
      if (!ok) return;
      state.servers = state.servers.filter(function (s) { return s.id !== target; });
      delete state.favorites[target];
      saveFavorites();
      if (state.activeId === target) {
        state.activeId = state.servers.length ? state.servers[0].id : "";
      }
      saveServers();
      saveActive();
      closeServerDialog();
      applyServer();
      renderAll();
      if (state.client) loadDir("/");
    });
  }

  /* ============================================================
   * 事件绑定与初始化
   * ============================================================ */

  function onSubKeywordMsg(msg) {
    var text = String(msg == null ? "" : msg);
    state.filter = text;
    if (dom["wd-filter"]) dom["wd-filter"].value = text;
    renderList();
    return true;
  }

  function bindEvents() {
    if (dom["wd-server"]) {
      dom["wd-server"].addEventListener("change", function () {
        state.activeId = dom["wd-server"].value;
        saveActive();
        applyServer();
        renderAll();
        if (state.client) loadDir("/");
      });
    }
    if (dom["wd-server-manage"]) dom["wd-server-manage"].addEventListener("click", openServerDialog);
    if (dom["wd-up"]) dom["wd-up"].addEventListener("click", function () { if (state.cwd !== "/") loadDir(parentPath(state.cwd)); });
    if (dom["wd-refresh"]) dom["wd-refresh"].addEventListener("click", refresh);
    if (dom["wd-new-folder"]) dom["wd-new-folder"].addEventListener("click", newFolder);
    if (dom["wd-upload"]) dom["wd-upload"].addEventListener("click", pickAndUpload);
    if (dom["wd-filter"]) {
      dom["wd-filter"].addEventListener("input", function () {
        state.filter = dom["wd-filter"].value;
        renderList();
      });
    }
    if (dom["wd-star"]) dom["wd-star"].addEventListener("click", toggleFavorite);
    if (dom["wd-select-all"]) {
      dom["wd-select-all"].addEventListener("change", function () {
        var on = dom["wd-select-all"].checked;
        var map = {};
        if (on) visibleEntries().forEach(function (e) { map[e.path] = true; });
        setSelection(map);
      });
    }
    [["wd-sort-name", "name"], ["wd-sort-size", "size"], ["wd-sort-time", "time"]].forEach(function (pair) {
      var btn = dom[pair[0]];
      if (!btn) return;
      btn.addEventListener("click", function () {
        var key = pair[1];
        if (state.prefs.sortKey === key) state.prefs.sortDir = -state.prefs.sortDir;
        else { state.prefs.sortKey = key; state.prefs.sortDir = 1; }
        savePrefs();
        renderList();
        renderSortHeader();
      });
    });
    if (dom["wd-hidden"]) {
      dom["wd-hidden"].addEventListener("click", function () {
        state.prefs.showHidden = !state.prefs.showHidden;
        savePrefs();
        renderList();
        renderSortHeader();
      });
    }
    if (dom["wd-sel-download"]) dom["wd-sel-download"].addEventListener("click", function () { downloadEntries(selectedEntries()); });
    if (dom["wd-sel-copy"]) dom["wd-sel-copy"].addEventListener("click", function () { clipboardSet("copy"); });
    if (dom["wd-sel-cut"]) dom["wd-sel-cut"].addEventListener("click", function () { clipboardSet("cut"); });
    if (dom["wd-sel-rename"]) dom["wd-sel-rename"].addEventListener("click", function () {
      var sel = selectedEntries();
      if (sel.length === 1) renameEntry(sel[0]);
    });
    if (dom["wd-sel-delete"]) dom["wd-sel-delete"].addEventListener("click", function () { deleteEntries(selectedEntries()); });
    if (dom["wd-sel-clear"]) dom["wd-sel-clear"].addEventListener("click", function () { setSelection({}); });
    if (dom["wd-paste-ok"]) dom["wd-paste-ok"].addEventListener("click", clipboardPaste);
    if (dom["wd-paste-cancel"]) dom["wd-paste-cancel"].addEventListener("click", clipboardClear);

    // 服务器对话框
    if (dom["wd-srv-save"]) dom["wd-srv-save"].addEventListener("click", saveServerForm);
    if (dom["wd-srv-add"]) dom["wd-srv-add"].addEventListener("click", function () {
      state.srvEditId = null;
      fillServerForm(null);
      renderServerList();
      try { if (dom["wd-srv-name"]) dom["wd-srv-name"].focus(); } catch (e) { /* ignore */ }
    });
    if (dom["wd-srv-delete"]) dom["wd-srv-delete"].addEventListener("click", deleteServer);
    if (dom["wd-srv-cancel"]) dom["wd-srv-cancel"].addEventListener("click", closeServerDialog);

    // 输入对话框
    if (dom["wd-prompt-ok"]) dom["wd-prompt-ok"].addEventListener("click", function () { settlePrompt(true); });
    if (dom["wd-prompt-cancel"]) dom["wd-prompt-cancel"].addEventListener("click", function () { settlePrompt(false); });
    if (dom["wd-prompt-input"]) {
      dom["wd-prompt-input"].addEventListener("keydown", function (e) {
        if (e && e.key === "Enter") settlePrompt(true);
        else if (e && e.key === "Escape") settlePrompt(false);
      });
    }
    if (dom["wd-srv-pass"]) {
      dom["wd-srv-pass"].addEventListener("keydown", function (e) {
        if (e && e.key === "Enter") saveServerForm();
      });
    }

    // 预览
    if (dom["wd-preview-close"]) dom["wd-preview-close"].addEventListener("click", closePreview);
    if (dom["wd-preview-prev"]) dom["wd-preview-prev"].addEventListener("click", function () { previewStep(-1); });
    if (dom["wd-preview-next"]) dom["wd-preview-next"].addEventListener("click", function () { previewStep(1); });
    if (dom["wd-preview-download"]) dom["wd-preview-download"].addEventListener("click", function () {
      if (state.preview) downloadEntries([state.preview.entry]);
    });
    if (dom["wd-preview-link"]) dom["wd-preview-link"].addEventListener("click", previewCopyLink);

    // 预览里的 markdown 链接 → 系统浏览器
    if (dom["wd-preview-body"]) {
      dom["wd-preview-body"].addEventListener("click", function (e) {
        var target = e && e.target;
        var a = target && target.closest ? target.closest("a") : null;
        if (!a) return;
        var href = a.getAttribute("href") || "";
        if (/^https?:\/\//i.test(href)) {
          e.preventDefault();
          try { openExternal(href); } catch (err) { /* ignore */ }
        }
      });
    }

    // 宿主投递的拖拽事件（原生拖放吃掉了 HTML5 事件，只能听宿主转发）
    document.addEventListener("ms-dropped-paths", function (e) {
      var paths = e && e.detail && e.detail.paths;
      if (Array.isArray(paths) && paths.length) uploadDropped(paths);
    });
    document.addEventListener("ms-drop-hover", function (e) {
      if (!dom["wd-drop"]) return;
      var active = !!(e && e.detail && e.detail.active);
      var hit = e && e.detail ? e.detail.hit : null;
      var inside = false;
      try { inside = !!(hit && host && host.contains && host.contains(hit)); } catch (err) { inside = false; }
      if (active && inside && state.client && !state.busy) dom["wd-drop"].style.display = "flex";
      else dom["wd-drop"].style.display = "none";
    });

    // 界面关闭时回收对象 URL
    try {
      window.addEventListener("beforeunload", closePreview);
    } catch (e) { /* ignore */ }
  }

  function init() {
    bindDom();
    bindEvents();
    setStatus("正在加载配置…");
    loadStore().then(function () {
      // 必须先 applyServer 建客户端：否则 loadDir 会因 client 为空再次弹设置框，
      // 「每次打开插件都弹服务器设置」就是这么来的。
      applyServer();
      renderAll();
      if (!currentServer()) {
        setStatus("请先添加一个 WebDAV 服务器");
        openServerDialog();
      } else {
        loadDir("/");
      }
    }).catch(function (e) {
      setStatus("配置加载失败：" + explainError(e), true);
    });
  }

  /* ============================================================
   * 子关键词 & 启动
   * ============================================================ */

  if (typeof onSubKeyword === "function") {
    onSubKeyword(onSubKeywordMsg);
  }

  /* ============================================================
   * 测试导出（仅 window.__WD_TEST__ === true 时存在）
   * ============================================================ */

  if (TEST_MODE && typeof window !== "undefined") {
    window.__wdTest = {
      // 路径 / URL
      normalizePath: normalizePath, joinPath: joinPath, parentPath: parentPath,
      baseName: baseName, samePath: samePath, isUnder: isUnder, replacePrefix: replacePrefix,
      encodePath: encodePath, decodePathname: decodePathname,
      normalizeBaseUrl: normalizeBaseUrl, urlFor: urlFor, pathFromHref: pathFromHref,
      // 编解码 / 类型 / 格式
      utf8Bytes: utf8Bytes, bytesToBase64: bytesToBase64, base64ToBytes: base64ToBytes,
      utf8ToBase64: utf8ToBase64, base64ToUtf8: base64ToUtf8, bytesToText: bytesToText,
      dataUrlParts: dataUrlParts, mimeOfName: mimeOfName, kindOfName: kindOfName,
      kindOfEntry: kindOfEntry, isPreviewable: isPreviewable,
      fmtSize: fmtSize, fmtTime: fmtTime, validateName: validateName, extOf: extOf,
      // 错误 / XML / 客户端
      WebDavError: WebDavError, explainError: explainError,
      parseMultiStatus: parseMultiStatus, elsByLocalName: elsByLocalName,
      firstByLocalName: firstByLocalName, pickProp: pickProp,
      WebDavClient: WebDavClient,
      // 存储 / 流程规划
      normalizeServers: normalizeServers, normalizeFavorites: normalizeFavorites, normalizePrefs: normalizePrefs,
      planUploads: planUploads, planPaste: planPaste,
      uploadOne: uploadOne,
      // 常量 / 状态
      PROPFIND_BODY: PROPFIND_BODY, MAX_UPLOAD: MAX_UPLOAD, MAX_DOWNLOAD: MAX_DOWNLOAD, MAX_TEXT: MAX_TEXT,
      TEXT_EXTS: TEXT_EXTS, MD_EXTS: MD_EXTS,
      state: state,
      // 流程入口（测试驱动 UI 流程用）
      loadStore: loadStore, applyServer: applyServer, renderAll: renderAll,
      loadDir: loadDir, refresh: refresh, visibleEntries: visibleEntries,
      toggleSelect: toggleSelect, selectOnly: selectOnly, setSelection: setSelection,
      selectedEntries: selectedEntries, onRowClick: onRowClick,
      clipboardSet: clipboardSet, clipboardClear: clipboardClear, clipboardPaste: clipboardPaste,
      planPasteNow: function () { return planPaste(state.clipboard ? state.clipboard.items : [], state.cwd, state.entries, state.clipboard ? state.clipboard.mode : "copy"); },
      downloadEntries: downloadEntries,
      newFolder: newFolder, renameEntry: renameEntry, deleteEntries: deleteEntries,
      toggleFavorite: toggleFavorite, removeFavorite: removeFavorite,
      renameFavorites: renameFavorites, pruneFavorites: pruneFavorites,
      favoritesFor: favoritesFor,
      pickAndUpload: pickAndUpload, runUpload: runUpload, uploadDropped: uploadDropped,
      openPreview: openPreview, closePreview: closePreview, previewStep: previewStep,
      previewCopyLink: previewCopyLink, previewableFiles: previewableFiles,
      openServerDialog: openServerDialog, closeServerDialog: closeServerDialog,
      saveServerForm: saveServerForm, deleteServer: deleteServer, fillServerForm: fillServerForm,
      renderServerList: renderServerList,
      showPrompt: showPrompt, settlePrompt: settlePrompt,
      init: init, bindDom: bindDom, bindEvents: bindEvents,
      toastCalls: null,
    };
  }

  if (!TEST_MODE) {
    init();
  }
})(ms, env, plugin, host, keyword, inputValue, onSubKeyword, md2html, openExternal);
