/**
 * WebDAV 网盘插件回归测试（Node 桩，不依赖浏览器）。
 *
 * 覆盖：
 *   1. 路径/URL 纯逻辑（归一化、编码、href → 路径还原）；
 *   2. PROPFIND 多状态 XML 解析（带前缀 / 默认命名空间 / 多 propstat / 去重）；
 *   3. WebDavClient 请求契约（Basic 认证、Depth、Destination 编码、PUT bodyBase64、404 容忍）；
 *   4. 存储归一化与流程规划（上传覆盖询问、粘贴冲突/自嵌套跳过）；
 *   5. UI 流程（Node DOM 桩）：加载目录、过滤、选择、上传、下载、剪切粘贴、
 *      删除、新建文件夹、重命名、服务器表单、预览、子关键词、拖入路径。
 *
 * 插件为单文件 IIFE；TEST_MODE（window.__WD_TEST__ === true）下跳过 init 并把
 * 内部函数挂在 window.__wdTest 上——测试经此入口驱动。
 *
 * 用法: node test/webdav-plugin.test.mjs
 */
import { readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = path.join(root, "plugins", "com.zhuangjie.webdav");
const src = readFileSync(path.join(pluginDir, "ui", "index.js"), "utf8");

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("PASS ", name, extra ? ` — ${extra}` : ""); }
  else { fail++; console.log("FAIL ", name, extra ? ` — ${extra}` : ""); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* 进度条收尾用的长 setTimeout 在测试里无意义（拖慢退出），改为立即触发 */
const realSetTimeout = setTimeout;
globalThis.setTimeout = (fn, ms) => realSetTimeout(fn, 0);

/* ============================================================
 * 极简 XML DOM 桩（够 PROPFIND 解析用）
 * ============================================================ */

function unescapeXml(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

class XText {
  constructor(data) { this.nodeType = 3; this.data = data; }
  get textContent() { return this.data; }
}

class XEl {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = tag;
    this.localName = tag.includes(":") ? tag.slice(tag.indexOf(":") + 1) : tag;
    this.childNodes = [];
    this.parentNode = null;
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join("");
  }
  appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c; }
  getElementsByTagName(name) {
    const out = [];
    const walk = (el) => {
      for (const c of el.childNodes) {
        if (c.nodeType !== 1) continue;
        if (name === "*" || c.localName === name || c.tagName === name) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

class XDoc extends XEl {
  constructor() { super("#document"); }
}

const ATTR_RE = /([A-Za-z_][\w.:-]*)\s*=\s*("[^"]*"|'[^']*')/g;

/** 解析 PROPFIND 子集的 XML；结构非法时插入 parsererror（模拟 DOMParser 行为） */
function parseXmlStub(xml) {
  const doc = new XDoc();
  const stack = [doc];
  const TOKEN = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<![^>]*>|<\/\s*([A-Za-z_][\w.:-]*)\s*>|<([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)\s*>/g;
  let last = 0;
  let m;
  let broken = false;
  const flushText = (to) => {
    if (to > last) {
      const raw = xml.slice(last, to);
      if (raw) stack[stack.length - 1].appendChild(new XText(unescapeXml(raw)));
    }
  };
  while ((m = TOKEN.exec(xml)) !== null) {
    flushText(m.index);
    last = TOKEN.lastIndex;
    if (m[1] != null) { // CDATA
      stack[stack.length - 1].appendChild(new XText(m[1]));
      continue;
    }
    if (m[2] != null) { // 闭合标签
      const name = m[2];
      let idx = -1;
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === name) { idx = i; break; }
      }
      if (idx < 0) { broken = true; break; }
      stack.length = idx;
      continue;
    }
    if (m[3] != null) { // 开始标签
      const el = new XEl(m[3]);
      const attrs = m[4] || "";
      let am;
      ATTR_RE.lastIndex = 0;
      while ((am = ATTR_RE.exec(attrs)) !== null) {
        el.attrs = el.attrs || {};
        el.attrs[am[1]] = unescapeXml(am[2].slice(1, -1));
      }
      stack[stack.length - 1].appendChild(el);
      if (m[5] !== "/") stack.push(el);
      continue;
    }
    // 注释 / PI / DOCTYPE：跳过
  }
  flushText(xml.length);
  if (broken || stack.length > 1) {
    doc.appendChild(new XEl("parsererror"));
  }
  return doc;
}

globalThis.DOMParser = class {
  parseFromString(xml) {
    return parseXmlStub(String(xml ?? ""));
  }
};

/* ============================================================
 * DOM 桩（元素 / 文档，仿 github-upload 测试并补子节点语义）
 * ============================================================ */

function escText(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function makeElement(tag) {
  const el = {
    tagName: tag || "div",
    value: "",
    checked: false,
    disabled: false,
    title: "",
    type: "",
    style: {},
    _html: "",
    _attrs: {},
    _children: [],
    _handlers: {},
    _handlersAll: {},
    _classes: new Set(),
    parentNode: null,
    classList: {
      add(c) { el._classes.add(c); },
      remove(c) { el._classes.delete(c); },
      contains(c) { return el._classes.has(c); },
      toggle(c, on) { on ? el._classes.add(c) : el._classes.delete(c); },
    },
    get childNodes() { return el._children; },
    get firstChild() { return el._children[0] || null; },
    appendChild(c) { c.parentNode = el; el._children.push(c); return c; },
    removeChild(c) {
      const i = el._children.indexOf(c);
      if (i >= 0) el._children.splice(i, 1);
      return c;
    },
    contains(node) {
      for (let cur = node; cur; cur = cur.parentNode) if (cur === el) return true;
      return false;
    },
    setAttribute(k, v) { el._attrs[k] = String(v); },
    getAttribute(k) { return k in el._attrs ? el._attrs[k] : null; },
    set innerHTML(v) { el._html = String(v); el._children = []; },
    get innerHTML() { return el._html; },
    set textContent(v) { el._children = []; el._text = String(v); el._html = escText(v); },
    get textContent() { return el._text ?? el._children.map((c) => c.textContent).join(""); },
    addEventListener(type, fn) { el._handlers[type] = fn; (el._handlersAll[type] ??= []).push(fn); },
    removeEventListener() {},
    dispatchEvent(ev) { el._fire(ev && ev.type, ev); return true; },
    _fire(type, ev) { (el._handlersAll[type] ?? []).forEach((fn) => fn.call(el, ev || {})); },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    closest() { return null; },
    focus() { el._focused = true; },
    click() {},
    select() {},
  };
  return el;
}

function makeEnv() {
  const els = {};
  const handlers = {};
  const doc = {
    getElementById: (id) => (els[id] ??= makeElement("div")),
    createElement: (tag) => makeElement(tag),
    createTextNode: (t) => ({ nodeType: 3, data: String(t) }),
    addEventListener: (type, fn) => { (handlers[type] ??= []).push(fn); },
    removeEventListener: () => {},
    dispatchEvent: (ev) => {
      (handlers[ev && ev.type] ?? []).forEach((fn) => fn.call(doc, ev || {}));
      return true;
    },
    querySelectorAll: () => [],
    querySelector: () => null,
    contains: () => true,
    _handlers: handlers,
  };
  return { els, doc };
}

/* ============================================================
 * 宿主 ms 桩 + 载具
 * ============================================================ */

const res = (status, text, extra = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  text: text ?? "",
  headers: {},
  ...extra,
});

function makeMs(opts = {}) {
  const calls = [];
  const toasts = [];
  const confirms = [];
  const savedFiles = [];
  const copied = [];
  const storeData = { ...(opts.store ?? {}) };
  const ms = {
    store: {
      get: (k, fb) => (k in storeData ? storeData[k] : fb),
      set: (k, v) => { storeData[k] = v; return true; },
    },
    net: {
      fetch: async (url, o) => {
        o = o ?? {};
        calls.push({
          method: o.method ?? "GET", url,
          headers: o.headers ?? {}, body: o.body,
          bodyBase64: o.bodyBase64, responseType: o.responseType,
        });
        if (!opts.onFetch) throw new Error("unexpected fetch: " + (o.method ?? "GET") + " " + url);
        return await opts.onFetch(o.method ?? "GET", url, o);
      },
    },
    input: {
      readFile: async (p) => {
        if (opts.files && p in opts.files) return opts.files[p];
        throw new Error("no such attached file: " + p);
      },
      saveFile: async (name, b64) => {
        savedFiles.push({ name, base64: b64 });
        if (opts.saveResults) {
          const nxt = opts.saveResults.shift();
          return nxt === undefined ? "/saved/" + name : nxt;
        }
        return "/saved/" + name;
      },
      pickFiles: async () => opts.pickedFiles ?? [],
    },
    ui: {
      toast: (text, type) => toasts.push({ text: String(text), type: type || "ok" }),
      confirm: (text) => {
        confirms.push(String(text));
        const nxt = opts.answers?.length ? opts.answers.shift() : true;
        return Promise.resolve(nxt);
      },
    },
    clipboard: {
      writeText: async (t) => { copied.push(String(t)); return true; },
    },
    log() {},
  };
  return { ms, calls, toasts, confirms, savedFiles, copied, storeData };
}

/** 载入插件（TEST_MODE）并返回测试钩子 */
function boot(opts = {}) {
  globalThis.window = globalThis;
  globalThis.window.__WD_TEST__ = true;
  const { els, doc } = makeEnv();
  globalThis.document = doc;
  const host = makeMs(opts);
  const fn = new Function(
    "ms", "env", "plugin", "host", "keyword", "inputValue", "onSubKeyword", "md2html", "openExternal",
    src
  );
  let subHandler = null;
  const openedExternally = [];
  fn(
    host.ms, {}, { id: "com.zhuangjie.webdav" }, doc, "", "",
    (h) => { subHandler = h; },
    (s) => String(s),
    (u) => openedExternally.push(String(u))
  );
  const T = globalThis.__wdTest;
  if (!T) throw new Error("__wdTest 缺失：插件 TEST_MODE 未生效");
  return { T, els, doc, ...host, subHandler, openedExternally };
}

/* ---------------- 测试数据 ---------------- */

const BASE = "https://dav.example.com/dav/";
const SRV = { id: "srv1", name: "测试盘", url: BASE, username: "user", password: "pass" };

function entryXml(href, { isDir = false, size, mtime, name, contentType } = {}) {
  const parts = [];
  parts.push(`      <D:resourcetype>${isDir ? "<D:collection/>" : ""}</D:resourcetype>`);
  if (name != null) parts.push(`      <D:displayname>${name}</D:displayname>`);
  if (size != null && !isDir) parts.push(`      <D:getcontentlength>${size}</D:getcontentlength>`);
  if (mtime != null) parts.push(`      <D:getlastmodified>${mtime}</D:getlastmodified>`);
  if (contentType != null) parts.push(`      <D:getcontenttype>${contentType}</D:getcontenttype>`);
  return [
    "    <D:response>",
    `      <D:href>${href}</D:href>`,
    "      <D:propstat>",
    "        <D:prop>",
    ...parts,
    "        </D:prop>",
    "        <D:status>HTTP/1.1 200 OK</D:status>",
    "      </D:propstat>",
    "    </D:response>",
  ].join("\n");
}

function multistatus(responses, { prefixed = true } = {}) {
  if (prefixed) {
    return [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<D:multistatus xmlns:D="DAV:">',
      ...responses,
      "</D:multistatus>",
    ].join("\n");
  }
  const body = responses.map((r) => r.replace(/D:/g, "")).join("\n");
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<multistatus xmlns="DAV:">',
    body,
    "</multistatus>",
  ].join("\n");
}

const MTIME = "Tue, 17 Nov 2026 08:30:00 GMT";
const MTIME_MS = Date.parse(MTIME);

/** 标准目录列表：根 + docs 文件夹 + 两个文件 */
function standardRootXml() {
  return multistatus([
    entryXml("/dav/", { isDir: true, name: "dav", mtime: MTIME }),
    entryXml("/dav/docs/", { isDir: true, name: "docs", mtime: MTIME }),
    entryXml("/dav/%E6%8A%A5%E5%91%8A.png", { size: 12345, mtime: MTIME, contentType: "image/png" }),
    entryXml("/dav/note.txt", { size: 28, mtime: MTIME, contentType: "text/plain" }),
  ]);
}

const rootFetch = (method, url) => {
  if (method === "PROPFIND") return res(207, standardRootXml());
  if (method === "PUT" || method === "MKCOL" || method === "MOVE" || method === "COPY" || method === "DELETE") return res(201, "");
  throw new Error("unexpected " + method + " " + url);
};

/* ============================================================
 * 测试套件（顺序执行，避免 boot() 互相污染全局桩）
 * ============================================================ */

async function suiteManifest() {
  console.log("---- 清单一致性 ----");
  const mf = JSON.parse(readFileSync(path.join(pluginDir, "plugin.json"), "utf8"));
  const meta = JSON.parse(readFileSync(path.join(pluginDir, "meta.json"), "utf8"));
  check("id 与目录名一致", mf.id === "com.zhuangjie.webdav");
  check("detailView 入口存在", existsSync(path.join(pluginDir, mf.contributes.detailView.entry)));
  check("script 存在", existsSync(path.join(pluginDir, mf.contributes.detailView.script)));
  check("图标存在", existsSync(path.join(pluginDir, mf.icon)));
  check("必需权限齐全", eq(mf.permissions, ["ui.inlay", "ui.notify", "store", "net.fetch:*", "file.read", "file.write"]), mf.permissions.join(","));
  check("可选权限", eq(mf.optionalPermissions, ["clipboard.write"]));
  check("searchItem keyword", mf.contributes.searchItem.keyword === "网盘");
  check("closeBehavior exit", mf.contributes.detailView.closeBehavior === "exit");
  check("meta 分类非空", Array.isArray(meta.categories) && meta.categories.length > 0);
  check("apiVersion/minAppVersion", mf.apiVersion === 1 && mf.minAppVersion === "7.9.35");
}

async function suitePaths() {
  const { T } = boot({});
  console.log("---- 路径工具 ----");
  check("normalizePath 解 ..", T.normalizePath("/a/b/../c") === "/a/c");
  check("normalizePath 反斜杠", T.normalizePath("a\\b\\\\c") === "/a/b/c");
  check("normalizePath 上跳越界", T.normalizePath("/a/../../b") === "/b");
  check("normalizePath 空", T.normalizePath("") === "/");
  check("joinPath", T.joinPath("/", "docs") === "/docs" && T.joinPath("/a/", "b") === "/a/b");
  check("parentPath 根", T.parentPath("/") === "/" && T.parentPath("/a") === "/");
  check("parentPath 子", T.parentPath("/a/b") === "/a");
  check("baseName 根", T.baseName("/") === "");
  check("baseName Windows 路径", T.baseName("C:\\Users\\x\\a.txt") === "a.txt");
  check("samePath 容忍重复斜杠", T.samePath("/a//b", "/a/b"));
  check("isUnder 精确", T.isUnder("/docs", "/docs"));
  check("isUnder 子", T.isUnder("/docs", "/docs/a/f.txt"));
  check("isUnder 前缀撞名不算", !T.isUnder("/docs", "/docsx"));
  check("isUnder 根包含一切", T.isUnder("/", "/anything"));
  check("replacePrefix 换前缀", T.replacePrefix("/docs/a/f.txt", "/docs", "/target") === "/target/a/f.txt");
  check("replacePrefix 不在树下原样", T.replacePrefix("/other/x", "/docs", "/target") === "/other/x");
  check("replacePrefix 到根", T.replacePrefix("/docs/x", "/docs", "/") === "/x");
  check("replacePrefix 从根", T.replacePrefix("/a/b", "/", "/t") === "/t/a/b");
}

async function suiteUrl() {
  const { T } = boot({});
  console.log("---- 编码与 URL ----");
  check("encodePath 空格与中文", T.encodePath("/a b/图片.png") === "/a%20b/%E5%9B%BE%E7%89%87.png");
  check("encodePath 根", T.encodePath("/") === "/");
  check("encodePath 百分号再编码", T.encodePath("/a/50%.txt") === "/a/50%25.txt");
  check("decodePathname", T.decodePathname("/dav/%E4%B8%AD.txt") === "/dav/中.txt");
  check("decodePathname 坏转义原样保留", T.decodePathname("/dav/50%.txt") === "/dav/50%.txt");
  check("normalizeBaseUrl 补协议", T.normalizeBaseUrl("dav.example.com/dav") === "https://dav.example.com/dav/");
  check("normalizeBaseUrl 去 query/hash", T.normalizeBaseUrl("https://h/dav?x=1#f") === "https://h/dav/");
  check("normalizeBaseUrl 补尾斜杠", T.normalizeBaseUrl("https://h/dav") === "https://h/dav/");
  check("normalizeBaseUrl 空报错", (() => { try { T.normalizeBaseUrl(""); return false; } catch (e) { return String(e.message).includes("服务器地址"); } })());
  check("urlFor 拼接", T.urlFor("https://h/dav/", "/a b.txt") === "https://h/dav/a%20b.txt");
  check("urlFor 根", T.urlFor("https://h/dav/", "/") === "https://h/dav/");
  check("urlFor 无路径前缀", T.urlFor("https://h/", "/x/y") === "https://h/x/y");
  check("pathFromHref 绝对编码 href", T.pathFromHref("https://dav.example.com/dav/a%20b.txt", BASE) === "/a b.txt");
  check("pathFromHref 相对 href", T.pathFromHref("b.txt", BASE) === "/b.txt");
  check("pathFromHref 目录自身无尾斜杠", T.pathFromHref("/dav", BASE) === "/");
  check("pathFromHref 目录自身带尾斜杠", T.pathFromHref("/dav/", BASE) === "/");
  check("pathFromHref 裸 Unicode href", T.pathFromHref("/dav/中.txt", BASE) === "/中.txt");
  check("pathFromHref base 之外的挂载", T.pathFromHref("/other/x", BASE) === "/other/x");
  check("pathFromHref null", T.pathFromHref(null, BASE) === null);
}

async function suiteCodec() {
  const { T } = boot({});
  console.log("---- 编解码 ----");
  check("utf8ToBase64 ASCII", T.utf8ToBase64("user:pass") === Buffer.from("user:pass").toString("base64"));
  check("utf8ToBase64 中文", T.utf8ToBase64("用户:密码") === Buffer.from("用户:密码", "utf8").toString("base64"));
  check("base64ToUtf8 回程", T.base64ToUtf8(T.utf8ToBase64("WebDAV 网盘 ✓")) === "WebDAV 网盘 ✓");
  check("base64ToBytes", eq(Array.from(T.base64ToBytes("QUJD")), [65, 66, 67]));
  check("base64ToBytes 含空白与 =", eq(Array.from(T.base64ToBytes("QUJD ==")), [65, 66, 67]));
  const random = new Uint8Array(1000);
  for (let i = 0; i < random.length; i++) random[i] = (i * 37 + 11) & 0xff;
  check("base64 随机字节回程", eq(Array.from(T.base64ToBytes(T.bytesToBase64(random))), Array.from(random)));
  check("dataUrlParts base64", (() => {
    const p = T.dataUrlParts("data:image/png;base64,AAEC");
    return p && p.mime === "image/png" && p.base64 === "AAEC" && p.bytes === 3;
  })());
  check("dataUrlParts 非 data URL", T.dataUrlParts("http://x/y") === null && T.dataUrlParts(42) === null);
  check("bytesToText utf-8", T.bytesToText(T.base64ToBytes(T.utf8ToBase64("中文")), "text/plain; charset=utf-8") === "中文");
}

async function suiteKinds() {
  const { T } = boot({});
  console.log("---- 类型与格式 ----");
  check("mimeOfName 大写扩展名", T.mimeOfName("a.PNG") === "image/png");
  check("mimeOfName 未知", T.mimeOfName("app.exe") === "application/octet-stream");
  check("kindOfName 一组", (() => {
    const cases = [
      ["photo.jpg", "", "image"], ["song.mp3", "", "audio"], ["clip.mp4", "", "video"],
      ["doc.pdf", "", "pdf"], ["note.md", "", "markdown"], ["data.json", "", "text"],
      ["app.exe", "", "other"], ["x", "image/webp", "image"], ["y", "application/pdf", "pdf"],
    ];
    return cases.every(([n, ct, want]) => T.kindOfName(n, ct) === want);
  })());
  check("isPreviewable", T.isPreviewable({ name: "a.txt", isDir: false }) && !T.isPreviewable({ name: "a.exe", isDir: false }) && !T.isPreviewable({ name: "d", isDir: true }));
  check("fmtSize", T.fmtSize(0) === "0 B" && T.fmtSize(1024) === "1.0 KB" && T.fmtSize(1536) === "1.5 KB" && T.fmtSize(5 * 1048576) === "5.0 MB");
  check("fmtTime 无效", T.fmtTime(0) === "-" && T.fmtTime(NaN) === "-");
  check("fmtTime 当年", T.fmtTime(new Date(2026, 10, 18, 9, 5).getTime()).includes("11-18 09:05"));
  check("validateName 一组", (() => {
    return T.validateName("") !== "" && T.validateName("a/b") !== "" && T.validateName("a\\b") !== ""
      && T.validateName("..") !== "" && T.validateName("文件 v2.txt") === "";
  })());
}

async function suiteXml() {
  const { T } = boot({
    onFetch: async (method, url) => {
      if (method === "PROPFIND" && url === BASE + "docs") {
        // stat（Depth 0）只会收到「自身一条」的响应
        return res(207, multistatus([entryXml("/dav/docs/", { isDir: true, name: "docs", mtime: MTIME })]));
      }
      if (method === "PROPFIND") return res(207, standardRootXml());
      throw new Error("unexpected " + method + " " + url);
    },
  });
  console.log("---- PROPFIND 解析 ----");
  const xml = standardRootXml();
  const entries = T.parseMultiStatus(xml, BASE);
  check("条目数（含自身）", entries.length === 4, `got ${entries.length}`);
  const self = entries.find((e) => e.path === "/");
  check("自身条目识别", !!self && self.isDir);
  const docs = entries.find((e) => e.path === "/docs");
  check("文件夹字段", !!docs && docs.isDir && docs.size === 0 && docs.name === "docs");
  const png = entries.find((e) => e.path === "/报告.png");
  check("文件字段（大小/时间/类型）", !!png && png.size === 12345 && png.mtimeMs === MTIME_MS && png.contentType === "image/png");
  const note = entries.find((e) => e.path === "/note.txt");
  check("displayName 缺省回退 basename", !!note && note.name === "note.txt");

  const nsXml = multistatus([
    entryXml("/dav/", { isDir: true, name: "dav", mtime: MTIME }),
    entryXml("/dav/docs/", { isDir: true, name: "docs" }),
  ], { prefixed: false });
  const nsEntries = T.parseMultiStatus(nsXml, BASE);
  check("默认命名空间解析", nsEntries.length === 2 && nsEntries[1].path === "/docs", JSON.stringify(nsEntries.map((e) => e.path)));

  const multi = [
    "    <D:response>",
    "      <D:href>/dav/docs/</D:href>",
    "      <D:propstat>",
    "        <D:prop><D:getetag/></D:prop>",
    "        <D:status>HTTP/1.1 404 Not Found</D:status>",
    "      </D:propstat>",
    "      <D:propstat>",
    "        <D:prop><D:resourcetype><D:collection/></D:resourcetype><D:displayname>docs</D:displayname></D:prop>",
    "        <D:status>HTTP/1.1 200 OK</D:status>",
    "      </D:propstat>",
    "    </D:response>",
  ].join("\n");
  const multiEntries = T.parseMultiStatus(multistatus([multi]), BASE);
  check("多 propstat 取 200", multiEntries.length === 1 && multiEntries[0].isDir && multiEntries[0].name === "docs");

  const dup = multistatus([
    entryXml("/dav/docs/", { isDir: true, name: "docs" }),
    entryXml("/dav/docs/", { isDir: true, name: "docs" }),
  ]);
  check("重复 href 去重", T.parseMultiStatus(dup, BASE).length === 1);

  let threw = "";
  try { T.parseMultiStatus("<not well-formed <open>", BASE); } catch (e) { threw = String(e.message); }
  check("非法 XML 报错", threw.includes("解析失败"), threw);

  const client = new T.WebDavClient(SRV);
  const list = await client.list("/");
  check("list 过滤自身", list.length === 3 && list.every((e) => e.path !== "/"), JSON.stringify(list.map((e) => e.path)));
  const st = await client.stat("/docs");
  check("stat Depth 0", !!st && st.path === "/docs" && st.isDir);
}

async function suiteClient() {
  console.log("---- 客户端契约 ----");
  const captured = [];
  const { T } = boot({
    onFetch: async (method, url, o) => {
      captured.push({ method, url, o });
      if (method === "PROPFIND") return res(207, multistatus([
        entryXml("/dav/", { isDir: true, name: "dav", mtime: MTIME }),
      ]));
      return res(200, "", { base64: T.utf8ToBase64("ok"), contentType: "text/plain" });
    },
  });
  const client = new T.WebDavClient(SRV);
  check("Basic 认证头", client.auth === "Basic " + Buffer.from("user:pass").toString("base64"));
  check("中文凭据 Basic", new T.WebDavClient({ url: BASE, username: "用户", password: "密码" }).auth === "Basic " + Buffer.from("用户:密码").toString("base64"));

  await client.propfind("/sub", 1);
  let c = captured[captured.length - 1];
  check("PROPFIND 方法与 URL", c.method === "PROPFIND" && c.url === BASE + "sub");
  check("Depth 头", c.o.headers.Depth === "1");
  check("Content-Type application/xml", c.o.headers["Content-Type"] === "application/xml");
  check("Authorization 头", c.o.headers.Authorization === client.auth);
  check("请求体为 PROPFIND 模板", c.o.body === T.PROPFIND_BODY);
  check("throwOnHttpError=false 由客户端自行处理", c.o.throwOnHttpError === false);

  await client.move("/old name.txt", "/新目录/old name.txt", false);
  c = captured[captured.length - 1];
  check("MOVE Destination 编码", c.method === "MOVE"
    && c.o.headers.Destination === BASE + "%E6%96%B0%E7%9B%AE%E5%BD%95/old%20name.txt");
  check("MOVE 默认不覆盖", c.o.headers.Overwrite === "F");

  await client.copy("/a", "/b", true);
  c = captured[captured.length - 1];
  check("COPY 覆盖头", c.method === "COPY" && c.o.headers.Overwrite === "T");

  await client.put("/x.png", "AAEC", "image/png");
  c = captured[captured.length - 1];
  check("PUT bodyBase64 与 Content-Type", c.method === "PUT" && c.o.bodyBase64 === "AAEC" && c.o.headers["Content-Type"] === "image/png");

  await client.put("/y.txt", "QUJD", null);
  c = captured[captured.length - 1];
  check("PUT 默认按扩展名补 mime", c.o.headers["Content-Type"] === "text/plain");

  const b64 = await client.getBase64("/z.bin", 1024);
  c = captured[captured.length - 1];
  check("GET responseType base64 与 maxBytes", c.o.responseType === "base64" && c.o.maxBytes === 1024);
  check("getBase64 返回 base64", b64 === T.utf8ToBase64("ok"));

  await client.mkdir("/newdir");
  check("MKCOL", captured[captured.length - 1].method === "MKCOL");
  await client.remove("/gone");
  check("DELETE", captured[captured.length - 1].method === "DELETE");

  // 404 容忍
  {
    const { T: T2 } = boot({
      onFetch: async (method) => {
        if (method === "DELETE") return res(404, "Not Found");
        throw new Error("unexpected " + method);
      },
    });
    const c2 = new T2.WebDavClient(SRV);
    let ok = false;
    try { await c2.remove("/nope"); ok = true; } catch (e) { ok = false; }
    check("remove 404 视为已删除", ok);
  }

  // getText 解码
  {
    const { T: T3 } = boot({
      onFetch: async () => res(200, "", { base64: T3.utf8ToBase64("中文内容"), contentType: "text/plain; charset=utf-8" }),
    });
    const c3 = new T3.WebDavClient(SRV);
    const text = await c3.getText("/note.txt");
    check("getText 解码", text === "中文内容");
  }

  // 错误映射
  {
    const { T: T4 } = boot({ onFetch: async () => res(401, "Unauthorized") });
    const c4 = new T4.WebDavClient(SRV);
    let err = null;
    try { await c4.list("/"); } catch (e) { err = e; }
    check("401 → WebDavError", err instanceof T4.WebDavError && err.status === 401);
    check("explainError 401", T4.explainError(err).includes("认证失败"));
    check("explainError 404", T4.explainError(new T4.WebDavError(404, "GET", "u", "")).includes("不存在"));
    check("explainError 405", T4.explainError(new T4.WebDavError(405, "MKCOL", "u", "")).includes("已存在"));
    check("explainError 412", T4.explainError(new T4.WebDavError(412, "MOVE", "u", "")).includes("已存在"));
    check("explainError 网络错误", T4.explainError(new TypeError("fetch failed")).includes("网络请求失败"));
    check("explainError 权限", T4.explainError(new Error("缺少权限: net.fetch:https://x/*")).includes("授权"));
  }
}

async function suiteStore() {
  const { T } = boot({});
  console.log("---- 存储归一化 ----");
  const servers = T.normalizeServers([
    { id: "a", url: " https://x/ ", name: " X ", username: "u", password: "p" },
    { id: "a", url: "https://y/" },
    { url: "https://z/dav/" },
    { id: "no-url" },
    "junk", null,
  ]);
  check("servers 过滤与去重", servers.length === 3 && new Set(servers.map((s) => s.id)).size === 3);
  check("servers trim", servers[0].url === "https://x/" && servers[0].name === "X");
  check("servers 无名回退 host", servers[1].name === "y" && servers[2].name === "z");

  const favs = T.normalizeFavorites({
    srv1: [{ path: "/docs/", name: "docs" }, "/a b/", { path: "/" }, { path: "/docs" }, "junk", null],
    broken: "nope",
  });
  check("favorites 归一化去重（裸字符串丢弃）", eq(favs.srv1, [{ path: "/docs", name: "docs" }]), JSON.stringify(favs.srv1));
  check("favorites 非数组键丢弃", eq(favs.broken, []));

  const prefs = T.normalizePrefs({ sortKey: "size", sortDir: -1, showHidden: 1 });
  check("prefs 合法值", prefs.sortKey === "size" && prefs.sortDir === -1 && prefs.showHidden === true);
  const dflt = T.normalizePrefs({ sortKey: "bogus", sortDir: 0, showHidden: "x" });
  check("prefs 非法回退默认", dflt.sortKey === "name" && dflt.sortDir === 1 && dflt.showHidden === false);

  // 同一地址 + 同一账号 = 同一份配置（旧版每次保存都新增，会产生重复）
  const dup = T.normalizeServers([
    { id: "a", name: "rn", url: "https://x/", username: "u", password: "" },
    { id: "b", name: "", url: "https://x/", username: "u", password: "p2" },
    { id: "c", name: "other", url: "https://x/", username: "u2" },
    { id: "d", name: "n", url: "https://x/", username: "u3" },
  ]);
  check("servers 按地址+账号去重", dup.length === 3, `got ${dup.length}`);
  check("去重后补空密码", dup[0].password === "p2" && dup[0].name === "rn");
  check("不同账号不算重复", dup[1].id === "c" && dup[2].id === "d");
}

async function suitePlans() {
  const { T } = boot({});
  console.log("---- 流程规划 ----");
  const entries = [{ path: "/docs", name: "docs", isDir: true }, { path: "/a.txt", name: "a.txt", isDir: false }];

  const r1 = await T.planUploads([{ path: "C:\\x\\a.txt" }, { path: "C:\\x\\new.txt" }], { "a.txt": true }, () => Promise.resolve(true));
  check("planUploads 覆盖同意", r1.accepted.length === 2 && r1.accepted[0].overwrite === true && r1.accepted[1].overwrite === false);
  const r2 = await T.planUploads([{ path: "C:\\x\\a.txt" }], { "a.txt": true }, () => Promise.resolve(false));
  check("planUploads 覆盖拒绝跳过", r2.accepted.length === 0 && r2.skipped.length === 1);
  const r3 = await T.planUploads([{ path: "C:\\x\\a.txt" }], { "a.txt": true }, null);
  check("planUploads 无 ask 视为拒绝", r3.skipped.length === 1 && r3.accepted.length === 0);

  const same = T.planPaste([{ path: "/a.txt", name: "a.txt", isDir: false }], "/", entries, "copy");
  check("planPaste 原地跳过", same.jobs.length === 0 && same.skipped.length === 1 && same.skipped[0].reason === "已在当前目录");

  const nested = T.planPaste([{ path: "/docs", name: "docs", isDir: true }], "/docs/sub", [], "cut");
  check("planPaste 剪切进自身子目录跳过", nested.jobs.length === 0 && nested.skipped[0].reason === "目标在源目录内部");

  const withConflict = T.planPaste(
    [{ path: "/a.txt", name: "a.txt", isDir: false }, { path: "/b.txt", name: "b.txt", isDir: false }],
    "/other", [{ name: "a.txt", isDir: false }], "cut"
  );
  check("planPaste 冲突标记", withConflict.conflicts.length === 1 && withConflict.conflicts[0] === "a.txt"
    && withConflict.jobs.length === 2 && withConflict.jobs[0].conflict === true);
  check("planPaste 目标拼接", withConflict.jobs[0].target === "/other/a.txt");
}

async function flowLoadDir() {
  console.log("---- 流程：加载目录/渲染/过滤/排序 ----");
  const { T, els, toasts } = boot({ store: { "webdav.servers": [SRV], "webdav.activeServer": "srv1" }, onFetch: rootFetch });
  T.bindDom();
  await T.loadStore();
  T.applyServer();
  T.renderAll();
  check("applyServer 建客户端", !!T.state.client);
  await T.loadDir("/");
  check("loadDir 填充条目", T.state.entries.length === 3 && T.state.cwd === "/");
  check("列表渲染行数", els["wd-list"]._children.length === 3, `got ${els["wd-list"]._children.length}`);
  check("状态栏统计", els["wd-status"].textContent.includes("1 个文件夹") && els["wd-status"].textContent.includes("2 个文件"));
  check("面包屑含服务器名", els["wd-crumbs"].textContent.includes("测试盘"));
  check("无错误 toast", toasts.length === 0);
  T.state.filter = "报";
  check("过滤后可见条目", T.visibleEntries().length === 1);
  T.state.filter = "";
  T.state.prefs.sortKey = "size";
  const bySize = T.visibleEntries().map((e) => e.name);
  check("按大小排序（目录仍在前）", bySize[0] === "docs" && bySize[bySize.length - 1] === "报告.png", bySize.join(","));
}

async function flowSubKeyword() {
  console.log("---- 流程：子关键词过滤 ----");
  const { T, els, subHandler } = boot({ store: { "webdav.servers": [SRV], "webdav.activeServer": "srv1" }, onFetch: rootFetch });
  T.bindDom();
  await T.loadStore();
  T.applyServer();
  await T.loadDir("/");
  check("onSubKeyword 注册", typeof subHandler === "function");
  subHandler("note");
  check("子关键词作为过滤词", T.state.filter === "note" && T.visibleEntries().length === 1);
  check("过滤框回填", els["wd-filter"].value === "note");
}

async function flowSelection() {
  console.log("---- 流程：选择与全选 ----");
  const { T, els } = boot({ store: { "webdav.servers": [SRV], "webdav.activeServer": "srv1" }, onFetch: rootFetch });
  T.bindDom();
  T.bindEvents();
  await T.loadStore();
  T.applyServer();
  await T.loadDir("/");
  const rows = els["wd-list"]._children;
  const vis = T.visibleEntries(); // docs, note.txt, 报告.png
  rows[0]._fire("click", {});
  check("单击选中一项", T.state.selCount === 1 && !!T.state.selection[vis[0].path]);
  check("选中条出现", els["wd-selection-bar"].style.display === "flex");
  rows[1]._fire("click", { ctrlKey: true });
  check("ctrl 追加选中", T.state.selCount === 2);
  rows[2]._fire("click", { shiftKey: true });
  check("shift 范围选中（自 lastIndex 起）", T.state.selCount === 2);
  els["wd-select-all"].checked = false;
  els["wd-select-all"]._fire("change", {});
  check("取消全选", T.state.selCount === 0 && els["wd-selection-bar"].style.display === "none");
  els["wd-select-all"].checked = true;
  els["wd-select-all"]._fire("change", {});
  check("全选", T.state.selCount === 3);
  check("含文件夹时下载禁用", els["wd-sel-download"].disabled === true);
  check("多选时重命名禁用", els["wd-sel-rename"].disabled === true);

  T.state.entries.push({ path: "/.hidden", name: ".hidden", isDir: false, size: 1, mtimeMs: 0 });
  T.state.prefs.showHidden = false;
  check("默认隐藏点开头文件", T.visibleEntries().every((e) => e.name.charAt(0) !== "."));
  T.state.prefs.showHidden = true;
  check("开启后显示", T.visibleEntries().some((e) => e.name === ".hidden"));
}

async function flowUpload() {
  console.log("---- 流程：上传 ----");
  const files = { "C:\\资料\\报 告.png": "data:image/png;base64,AAEC" };
  const { T, els, doc, calls, toasts, confirms } = boot({
    store: { "webdav.servers": [SRV], "webdav.activeServer": "srv1" },
    onFetch: rootFetch,
    files,
  });
  T.bindDom();
  T.bindEvents();
  await T.loadStore();
  T.applyServer();
  await T.loadDir("/");

  doc.dispatchEvent({ type: "ms-drop-hover", detail: { active: true, hit: els["wd-list"] } });
  check("悬停高亮显示", els["wd-drop"].style.display === "flex");
  doc.dispatchEvent({ type: "ms-drop-hover", detail: { active: false, hit: null } });
  check("离开清除高亮", els["wd-drop"].style.display === "none");

  doc.dispatchEvent({ type: "ms-dropped-paths", detail: { paths: ["C:\\资料\\报 告.png"], entries: [{ path: "C:\\资料\\报 告.png", isDir: false }] } });
  await sleep(30);
  const put = calls.find((c) => c.method === "PUT");
  check("拖入触发 PUT", !!put);
  check("PUT 目标编码", put && put.url === BASE + "%E6%8A%A5%20%E5%91%8A.png", put && put.url);
  check("PUT base64 体", put && put.bodyBase64 === "AAEC");
  check("PUT mime", put && put.headers["Content-Type"] === "image/png");
  check("上传完成 toast", toasts.some((t) => t.text.includes("上传完成 1 个")), JSON.stringify(toasts));
  check("无覆盖询问（名字不同）", confirms.length === 0);

  // 覆盖询问：拖入与现有条目同名（报告.png 已在根目录）→ 拒绝 → 跳过
  const { T: T2, calls: calls2, confirms: confirms2, toasts: toasts2 } = boot({
    store: { "webdav.servers": [SRV], "webdav.activeServer": "srv1" },
    onFetch: rootFetch,
    files: { "C:\\资料\\报告.png": "data:image/png;base64,AAEC" },
    answers: [false],
  });
  T2.bindDom(); T2.bindEvents();
  await T2.loadStore(); T2.applyServer(); await T2.loadDir("/");
  check("目录已有同名", T2.state.entries.some((e) => e.name === "报告.png"));
  await T2.uploadDropped(["C:\\资料\\报告.png"]);
  check("覆盖询问弹出", confirms2.length === 1 && confirms2[0].includes("覆盖"));
  check("拒绝后无 PUT", !calls2.some((c) => c.method === "PUT"));
  check("跳过提示", toasts2.some((t) => t.text.includes("已跳过 1 个同名文件")));
  check("流程收尾 busy=false", T2.state.busy === false);

  // pickFiles 入口
  const { T: T3, calls: calls3 } = boot({
    store: { "webdav.servers": [SRV], "webdav.activeServer": "srv1" },
    onFetch: rootFetch,
    files,
    pickedFiles: [{ path: "C:\\资料\\报 告.png", name: "报 告.png", size: 3 }],
  });
  T3.bindDom(); T3.bindEvents();
  await T3.loadStore(); T3.applyServer(); await T3.loadDir("/");
  await T3.pickAndUpload();
  check("pickFiles 上传 PUT", calls3.some((c) => c.method === "PUT" && c.url === BASE + "%E6%8A%A5%20%E5%91%8A.png"));
}

async function flowDownload() {
  console.log("---- 流程：下载与取消 ----");
  const { T, savedFiles } = boot({
    store: { "webdav.servers": [SRV], "webdav.activeServer": "srv1" },
    onFetch: async (method, url) => {
      if (method === "PROPFIND") return res(207, standardRootXml());
      if (method === "GET" && url.endsWith("note.txt")) return res(200, "", { base64: T.utf8ToBase64("hello note"), contentType: "text/plain" });
      throw new Error("unexpected " + method + " " + url);
    },
  });
  T.bindDom();
  await T.loadStore(); T.applyServer(); await T.loadDir("/");
  const note = T.state.entries.find((e) => e.name === "note.txt");
  await T.downloadEntries([note]);
  check("下载保存文件名", savedFiles.length === 1 && savedFiles[0].name === "note.txt");
  check("下载内容 base64", savedFiles[0].base64 === T.utf8ToBase64("hello note"));

  const docs = T.state.entries.find((e) => e.name === "docs");
  await T.downloadEntries([docs]);
  check("文件夹下载被拒（无新增保存）", savedFiles.length === 1);

  const { T: T2, savedFiles: saved2 } = boot({
    store: { "webdav.servers": [SRV], "webdav.activeServer": "srv1" },
    onFetch: async (method, url) => {
      if (method === "PROPFIND") return res(207, standardRootXml());
      if (method === "GET") return res(200, "", { base64: T2.utf8ToBase64("x"), contentType: "text/plain" });
      throw new Error("unexpected " + method);
    },
    saveResults: [null],
  });
  T2.bindDom();
  await T2.loadStore(); T2.applyServer(); await T2.loadDir("/");
  const two = T2.state.entries.filter((e) => !e.isDir);
  await T2.downloadEntries(two);
  check("取消后中止批量", saved2.length === 1);
}

async function flowClipboard() {
  console.log("---- 流程：剪切粘贴与收藏联动 ----");
  const { T, calls, els, storeData } = boot({
    store: {
      "webdav.servers": [SRV], "webdav.activeServer": "srv1",
      "webdav.favorites": { srv1: [{ path: "/docs", name: "docs" }] },
    },
    onFetch: async (method, url) => {
      if (method === "PROPFIND") {
        if (url === BASE) return res(207, standardRootXml());
        return res(207, multistatus([entryXml("/dav/docs/", { isDir: true, name: "docs", mtime: MTIME })]));
      }
      if (method === "MOVE") return res(201, "");
      throw new Error("unexpected " + method + " " + url);
    },
  });
  T.bindDom();
  await T.loadStore(); T.applyServer(); await T.loadDir("/");
  const note = T.state.entries.find((e) => e.name === "note.txt");
  T.selectOnly(note.path);
  T.clipboardSet("cut");
  check("剪切条显示", els["wd-paste-bar"].style.display === "flex" && els["wd-paste-text"].textContent.includes("已剪切 1 项"));
  await T.loadDir("/docs"); // 进入目标目录再粘贴
  await T.clipboardPaste();
  const mv = calls.find((c) => c.method === "MOVE");
  check("粘贴触发 MOVE", !!mv && mv.url === BASE + "note.txt");
  check("Destination 指向当前目录", mv && mv.headers.Destination === BASE + "docs/note.txt");
  check("剪切后清空剪贴板", T.state.clipboard === null);
  // 文件夹移动的收藏换前缀由 renameFavorites 单元覆盖（见删除/重命名流程）；
  // 这里验证把文件夹剪切进其自身子目录会被拒绝跳过（防 409）
  T.state.clipboard = { mode: "cut", items: [{ path: "/docs", name: "docs", isDir: true }] };
  await T.clipboardPaste();
  check("剪切进自身子目录被拒", !calls.some((c) => c.method === "MOVE" && c.url === BASE + "docs/docs"));
  check("自嵌套提示", T.state.clipboard !== null); // 全部跳过时保留剪贴板待用户处理

  // 复制模式：粘贴后剪贴板保留
  const { T: T3, calls: calls3 } = boot({
    store: { "webdav.servers": [SRV], "webdav.activeServer": "srv1" },
    onFetch: async (method, url) => {
      if (method === "PROPFIND") {
        if (url === BASE) return res(207, standardRootXml());
        return res(207, multistatus([entryXml("/dav/docs/", { isDir: true, name: "docs", mtime: MTIME })]));
      }
      if (method === "COPY") return res(201, "");
      throw new Error("unexpected " + method + " " + url);
    },
  });
  T3.bindDom();
  await T3.loadStore(); T3.applyServer(); await T3.loadDir("/");
  const note3 = T3.state.entries.find((e) => e.name === "note.txt");
  T3.selectOnly(note3.path);
  T3.clipboardSet("copy");
  await T3.loadDir("/docs");
  await T3.clipboardPaste();
  check("COPY 触发", calls3.some((c) => c.method === "COPY" && c.headers.Destination === BASE + "docs/note.txt"));
  check("复制后剪贴板保留", T3.state.clipboard !== null);
}

async function flowDeleteRename() {
  console.log("---- 流程：删除与重命名 ----");
  const { T, calls, storeData, toasts } = boot({
    store: {
      "webdav.servers": [SRV], "webdav.activeServer": "srv1",
      "webdav.favorites": { srv1: [{ path: "/a", name: "a" }, { path: "/docs", name: "docs" }, { path: "/docs/keep", name: "keep" }] },
    },
    onFetch: async (method) => {
      if (method === "PROPFIND") return res(207, standardRootXml());
      if (method === "DELETE" || method === "MOVE") return res(204, "");
      throw new Error("unexpected " + method);
    },
    answers: [true],
  });
  T.bindDom();
  await T.loadStore(); T.applyServer(); await T.loadDir("/");
  const docs = T.state.entries.find((e) => e.name === "docs");
  await T.deleteEntries([docs, T.state.entries.find((e) => e.name === "note.txt")]);
  check("删除触发两次 DELETE", calls.filter((c) => c.method === "DELETE").length === 2);
  const favsAfter = storeData["webdav.favorites"].srv1;
  check("删除清理收藏（含子目录）", eq(favsAfter, [{ path: "/a", name: "a" }]), JSON.stringify(favsAfter));
  check("删除后清空选择", T.state.selCount === 0);
  check("删除完成 toast", toasts.some((t) => t.text.includes("已删除 2 项")));

  {
    const { T: T2, calls: calls2, confirms: confirms2 } = boot({
      store: { "webdav.servers": [SRV], "webdav.activeServer": "srv1" },
      onFetch: async (method) => {
        if (method === "PROPFIND") return res(207, standardRootXml());
        throw new Error("unexpected " + method);
      },
      answers: [false],
    });
    T2.bindDom();
    await T2.loadStore(); T2.applyServer(); await T2.loadDir("/");
    await T2.deleteEntries([T2.state.entries[0]]);
    check("拒绝确认后不删", confirms2.length === 1 && !calls2.some((c) => c.method === "DELETE"));
  }

  const { T: T3, calls: calls3, toasts: toasts3, storeData: store3, els: els3 } = boot({
    store: {
      "webdav.servers": [SRV], "webdav.activeServer": "srv1",
      "webdav.favorites": { srv1: [{ path: "/docs", name: "docs" }] },
    },
    onFetch: async (method) => {
      if (method === "PROPFIND") return res(207, standardRootXml());
      if (method === "MOVE") return res(201, "");
      throw new Error("unexpected " + method);
    },
  });
  T3.bindDom();
  await T3.loadStore(); T3.applyServer(); await T3.loadDir("/");
  const p = T3.renameEntry(T3.state.entries.find((e) => e.name === "docs"));
  check("重命名对话框预填原名", els3["wd-prompt-input"].value === "docs");
  els3["wd-prompt-input"].value = "文档";
  T3.settlePrompt(true);
  await p;
  const mv = calls3.find((c) => c.method === "MOVE");
  check("重命名 MOVE", !!mv && mv.headers.Overwrite === "F");
  check("重命名收藏更新", eq(store3["webdav.favorites"].srv1, [{ path: "/文档", name: "文档" }]), JSON.stringify(store3["webdav.favorites"].srv1));
  check("重命名 toast", toasts3.some((t) => t.text.includes("已重命名为 文档")));
}

async function flowNewFolder() {
  console.log("---- 流程：新建文件夹 ----");
  const { T, calls, els } = boot({
    store: { "webdav.servers": [SRV], "webdav.activeServer": "srv1" },
    onFetch: async (method) => {
      if (method === "PROPFIND") return res(207, standardRootXml());
      if (method === "MKCOL") return res(201, "");
      throw new Error("unexpected " + method);
    },
  });
  T.bindDom();
  await T.loadStore(); T.applyServer(); await T.loadDir("/");
  const p = T.newFolder();
  check("新建文件夹预填", els["wd-prompt-input"].value === "新建文件夹");
  els["wd-prompt-input"].value = "新目录";
  T.settlePrompt(true);
  await p;
  check("MKCOL 触发", calls.some((c) => c.method === "MKCOL" && c.url === BASE + "%E6%96%B0%E7%9B%AE%E5%BD%95"));

  {
    const { T: T2, toasts: toasts2, els: els2 } = boot({
      store: { "webdav.servers": [SRV], "webdav.activeServer": "srv1" },
      onFetch: async (method) => {
        if (method === "PROPFIND") return res(207, standardRootXml());
        if (method === "MKCOL") return res(405, "Method Not Allowed");
        throw new Error("unexpected " + method);
      },
    });
    T2.bindDom();
    await T2.loadStore(); T2.applyServer(); await T2.loadDir("/");
    const p2 = T2.newFolder();
    els2["wd-prompt-input"].value = "docs";
    T2.settlePrompt(true);
    await p2;
    check("405 提示同名已存在", toasts2.some((t) => t.text.includes("同名文件或文件夹已存在")));
  }

  {
    const { T: T3, calls: calls3, els: els3 } = boot({
      store: { "webdav.servers": [SRV], "webdav.activeServer": "srv1" },
      onFetch: rootFetch,
    });
    T3.bindDom();
    await T3.loadStore(); T3.applyServer(); await T3.loadDir("/");
    const p3 = T3.newFolder();
    els3["wd-prompt-input"].value = "a/b";
    T3.settlePrompt(true);
    await p3;
    check("非法名不发起 MKCOL", !calls3.some((c) => c.method === "MKCOL"));
  }
}

async function flowServerForm() {
  console.log("---- 流程：服务器表单 ----");
  const { T, els, storeData, calls } = boot({
    onFetch: async (method) => {
      if (method === "PROPFIND") return res(207, multistatus([entryXml("/dav/", { isDir: true, name: "dav", mtime: MTIME })]));
      throw new Error("unexpected " + method);
    },
  });
  T.bindDom(); T.bindEvents();
  await T.loadStore();
  T.applyServer();
  T.renderAll();
  check("无服务器时列表提示", els["wd-list"].textContent.includes("尚未配置服务器"));
  check("无服务器时 select 禁用", els["wd-server"].disabled === true);
  T.openServerDialog();
  check("对话框打开", els["wd-dlg"].style.display === "flex");
  els["wd-srv-name"].value = "坚果云";
  els["wd-srv-url"].value = "dav.jianguoyun.com/dav/";
  els["wd-srv-user"].value = "me@example.com";
  els["wd-srv-pass"].value = "app-pass";
  const ok = T.saveServerForm();
  check("保存成功并关闭", ok === true && els["wd-dlg"].style.display === "none");
  const saved = storeData["webdav.servers"];
  check("地址归一化入库", saved.length === 1 && saved[0].url === "https://dav.jianguoyun.com/dav/");
  check("自动激活", storeData["webdav.activeServer"] === saved[0].id && T.state.client !== null);
  check("保存后自动列目录", calls.some((c) => c.method === "PROPFIND" && c.url === "https://dav.jianguoyun.com/dav/"));

  T.openServerDialog();
  check("服务器列表渲染", els["wd-srv-list"]._children.length === 1);
  els["wd-srv-list"]._children[0]._fire("click", {});
  check("点击条目回填表单", els["wd-srv-url"].value === "https://dav.jianguoyun.com/dav/");
  els["wd-srv-url"].value = "https://dav.jianguoyun.com/dav/backup/";
  T.saveServerForm();
  check("编辑保存", storeData["webdav.servers"][0].url === "https://dav.jianguoyun.com/dav/backup/");
}

async function flowServerDialogDefaults() {
  console.log("---- 回归：打开插件不再误弹设置框 / 保存不新增重复配置 ----");
  {
    // 已配置服务器时启动：必须建好客户端并直接列目录，不能弹设置框
    const { T, els, calls } = boot({
      store: { "webdav.servers": [SRV], "webdav.activeServer": "srv1" },
      onFetch: rootFetch,
    });
    T.init();
    await sleep(40);
    check("启动后不弹设置框", !els["wd-dlg"].style.display || els["wd-dlg"].style.display === "none", els["wd-dlg"].style.display);
    check("启动后客户端已建立", T.state.client !== null);
    check("启动后自动列出根目录", calls.some((c) => c.method === "PROPFIND" && c.url === BASE) && T.state.entries.length === 3);
    check("状态栏已更新", !els["wd-status"].textContent.includes("正在加载配置"), els["wd-status"].textContent);
  }

  {
    // 打开设置框默认编辑当前服务器：直接保存必须更新，而不是新增一条
    const { T, els, storeData } = boot({
      store: { "webdav.servers": [SRV], "webdav.activeServer": "srv1" },
      onFetch: rootFetch,
    });
    T.bindDom();
    T.bindEvents();
    await T.loadStore();
    T.applyServer();

    T.openServerDialog();
    check("默认选中当前服务器", T.state.srvEditId === "srv1");
    check("表单一打开就是当前配置", els["wd-srv-name"].value === SRV.name && els["wd-srv-url"].value === SRV.url);
    check("对话框标题标明编辑", els["wd-dlg-title"].textContent.includes("编辑"), els["wd-dlg-title"].textContent);
    els["wd-srv-name"].value = "改名后";
    T.saveServerForm();
    check("直接保存不新增", storeData["webdav.servers"].length === 1, `got ${storeData["webdav.servers"].length}`);
    check("直接保存更新当前项", storeData["webdav.servers"][0].name === "改名后");

    // 点「新增」后填一份与现有完全相同的地址+账号：也只更新，不新增
    els["wd-srv-add"]._fire("click", {});
    check("新增后表单清空", T.state.srvEditId === null && els["wd-srv-url"].value === "");
    els["wd-srv-name"].value = "rn";
    els["wd-srv-url"].value = SRV.url;
    els["wd-srv-user"].value = SRV.username;
    els["wd-srv-pass"].value = SRV.password;
    T.saveServerForm();
    check("重复地址+账号不新增", storeData["webdav.servers"].length === 1, `got ${storeData["webdav.servers"].length}`);

    // 换一个地址仍然能正常新增
    els["wd-srv-add"]._fire("click", {});
    els["wd-srv-name"].value = "第二台";
    els["wd-srv-url"].value = "https://other.example.com/dav/";
    els["wd-srv-user"].value = "u2";
    T.saveServerForm();
    check("不同地址正常新增", storeData["webdav.servers"].length === 2, `got ${storeData["webdav.servers"].length}`);
  }

  {
    // 历史重复配置：加载时合并、写回存储，收藏与活动服务器一起收敛
    const dupServers = [
      { id: "a", name: "rn", url: BASE, username: "u", password: "" },
      { id: "b", name: "rn", url: BASE, username: "u", password: "p2" },
    ];
    const { T, storeData } = boot({
      store: {
        "webdav.servers": dupServers,
        "webdav.activeServer": "b",
        "webdav.favorites": { a: [{ path: "/docs", name: "docs" }], b: [{ path: "/docs", name: "docs" }, { path: "/x", name: "x" }] },
      },
      onFetch: rootFetch,
    });
    T.bindDom();
    await T.loadStore();
    check("加载时合并历史重复", T.state.servers.length === 1 && T.state.servers[0].id === "a", `got ${T.state.servers.length}`);
    check("活动服务器指向保留项", T.state.activeId === "a", T.state.activeId);
    check("重复项写回存储", storeData["webdav.servers"].length === 1 && storeData["webdav.activeServer"] === "a");
    const favs = T.favoritesFor("a").map((f) => f.path).sort();
    check("收藏并入保留项", eq(favs, ["/docs", "/x"]), JSON.stringify(favs));
    check("被合并项的收藏已清掉", !("b" in storeData["webdav.favorites"]));
    check("保留项密码补齐", T.state.servers[0].password === "p2");
  }
}

async function flowPreview() {
  console.log("---- 流程：文本预览与复制直链 ----");
  const { T, els, copied } = boot({
    store: { "webdav.servers": [SRV], "webdav.activeServer": "srv1" },
    onFetch: async (method, url) => {
      if (method === "PROPFIND") return res(207, standardRootXml());
      if (method === "GET" && url.endsWith("note.txt")) {
        return res(200, "", { base64: T.utf8ToBase64("第一行\n第二行"), contentType: "text/plain; charset=utf-8" });
      }
      throw new Error("unexpected " + method + " " + url);
    },
  });
  T.bindDom();
  await T.loadStore(); T.applyServer(); await T.loadDir("/");
  const note = T.state.entries.find((e) => e.name === "note.txt");
  T.openPreview(note);
  check("预览壳显示", els["wd-preview"].style.display === "flex" && els["wd-preview-title"].textContent === "note.txt");
  await sleep(20);
  const pre = els["wd-preview-body"]._children[0];
  check("文本预览内容", pre && pre.tagName === "pre" && pre.textContent === "第一行\n第二行", pre && pre.textContent);
  check("预览页脚信息", els["wd-preview-foot"].textContent.includes("28 B"));
  T.previewCopyLink();
  await sleep(10);
  check("复制直链", copied.length === 1 && copied[0] === BASE + "note.txt");
  T.closePreview();
  check("关闭预览", els["wd-preview"].style.display === "none" && T.state.preview === null);
}

async function flowErrorCard() {
  console.log("---- 流程：错误卡片 ----");
  const { T, els, toasts } = boot({
    store: { "webdav.servers": [SRV], "webdav.activeServer": "srv1" },
    onFetch: async (method) => {
      if (method === "PROPFIND") return res(401, "Unauthorized");
      throw new Error("unexpected " + method);
    },
  });
  T.bindDom();
  await T.loadStore(); T.applyServer();
  await T.loadDir("/");
  check("错误卡片文案", els["wd-list"].textContent.includes("认证失败"));
  check("错误 toast", toasts.some((t) => t.type === "error"));
  check("401 提供设置入口", els["wd-list"].textContent.includes("检查服务器设置"));
}

async function flowLoadStoreOrder() {
  console.log("---- 回归：loadStore 槽位顺序 ----");
  const store = {
    "webdav.servers": [SRV],
    "webdav.activeServer": "srv1",
    "webdav.favorites": { srv1: [{ path: "/docs", name: "docs" }] },
    "webdav.prefs": { sortKey: "time", sortDir: -1, showHidden: true },
  };
  const { T, els } = boot({ store, onFetch: rootFetch });
  T.bindDom();
  await T.loadStore();
  check("activeId 来自正确槽位", T.state.activeId === "srv1");
  check("favorites 来自正确槽位", eq(T.favoritesFor("srv1"), [{ path: "/docs", name: "docs" }]));
  check("prefs 来自正确槽位", T.state.prefs.sortKey === "time" && T.state.prefs.sortDir === -1 && T.state.prefs.showHidden === true);
  T.renderAll();
  check("收藏夹渲染", els["wd-favorites"].textContent.includes("docs"));
  check("排序头高亮 time", els["wd-sort-time"].textContent.includes("▼"));
}

const suites = [
  suiteManifest, suitePaths, suiteUrl, suiteCodec, suiteKinds, suiteXml, suiteClient,
  suiteStore, suitePlans,
  flowLoadDir, flowSubKeyword, flowSelection, flowUpload, flowDownload, flowClipboard,
  flowDeleteRename, flowNewFolder, flowServerForm, flowServerDialogDefaults, flowPreview, flowErrorCard, flowLoadStoreOrder,
];

let chain = Promise.resolve();
for (const fn of suites) {
  chain = chain.then(async () => {
    try {
      await fn();
    } catch (e) {
      fail++;
      console.log("FAIL ", fn.name, " — 流程异常: " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e));
    }
  });
}

chain.then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
