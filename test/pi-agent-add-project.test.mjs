/**
 * pi-agent「添加项目」通路回归测试（Node 桩，不依赖浏览器 / 不依赖 pi）。
 *
 * 要钉死的契约（新增能力的核心，肉眼很难发现，因此必须上测试）：
 *
 *   1. 点 + 弹出的气泡里有「选择文件夹…」按钮，点击 → `ms.ui.pickFolder()`
 *      → 拿到路径 → 调后端 `addProject`；用户取消（返回 null）不调 addProject。
 *   2. 宿主把拖入路径投递给插件时，**文件夹**加为项目，**文件**不算项目。
 *      插件自己无法判定 isDir（只能用 file.read 读已登记内容），必须依赖
 *      宿主在 `ms-dropped-paths` 的 detail.entries 里带回 isDir。
 *   3. 旧宿主不带 entries 时退化为「全部按文件」，绝不误把文件夹当项目。
 *   4. 这是本功能最关键的回归点：早期实现只处理图片，拖入文件夹没有任何反应。
 *   5. 添加**成功**后「添加项目」气泡（容器）必须自动关闭；添加失败时保持打开，
 *      方便用户看到错误后修正（三个入口：手动输入 / 选择文件夹 / 拖入文件夹）。
 *
 * 用法: node test/pi-agent-add-project.test.mjs
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = path.join(root, "plugins", "pi-agent", "ui");
const src = readFileSync(path.join(pluginDir, "index.js"), "utf8");

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("PASS ", name, extra ? ` — ${extra}` : ""); }
  else { fail++; console.log("FAIL ", name, extra ? ` — ${extra}` : ""); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================= DOM 桩 ================= */

function makeClassList(el) {
  const set = new Set();
  return {
    add: (...c) => c.forEach((x) => set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    toggle: (c, on) => (on === undefined ? (set.has(c) ? set.delete(c) : set.add(c)) : (on ? set.add(c) : set.delete(c))),
    contains: (c) => set.has(c),
    _set: set,
  };
}

function makeElement(tag = "div") {
  const el = {
    tagName: String(tag).toUpperCase(),
    id: "",
    className: "",
    value: "",
    checked: false,
    disabled: false,
    hidden: false,
    title: "",
    textContent: "",
    innerHTML: "",
    placeholder: "",
    spellcheck: true,
    autocomplete: "",
    type: "",
    open: false,
    style: {},
    dataset: {},
    children: [],
    parentNode: null,
    _handlers: {},
    _attrs: {},
    classList: makeClassList(null),
    addEventListener(type, fn) { (this._handlers[type] ??= []).push(fn); },
    removeEventListener() {},
    dispatchEvent(ev) { (this._handlers[ev?.type] ?? []).forEach((fn) => fn.call(this, ev)); return true; },
    _fire(type, ev) { (this._handlers[type] ?? []).forEach((fn) => fn.call(this, ev || { type })); },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    insertBefore(c) { c.parentNode = this; this.children.unshift(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return this._attrs[k] ?? null; },
    removeAttribute(k) { delete this._attrs[k]; },
    querySelector(sel) { return findIn(this, sel); },
    querySelectorAll(sel) { return findAllIn(this, sel); },
    contains(node) { return node === this || this.children.includes(node) || this.children.some((c) => c.contains?.(node)); },
    closest(sel) { let n = this; while (n) { if (matches(n, sel.split(/\s+/).pop())) return n; n = n.parentNode; } return null; },
    focus() {},
    blur() {},
    click() { this._fire("click", { type: "click", target: this, stopPropagation() {}, preventDefault() {} }); },
    scrollTo() {},
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    get scrollHeight() { return 0; },
    get clientHeight() { return 0; },
    get scrollTop() { return 0; },
    set scrollTop(_v) {},
    get textContent() { return this._text != null ? this._text : this._tchild(); },
    set textContent(v) { this._text = String(v); this.children = []; },
    _tchild() { return this.children.map((c) => c.textContent).join(""); },
  };
  return el;
}

/* 极小 CSS 选择器支持：#id / .class / tag。够本测试用。 */
function matches(el, sel) {
  sel = sel.trim();
  if (sel.startsWith("#")) return el.id === sel.slice(1);
  if (sel.startsWith(".")) return el.classList.contains(sel.slice(1));
  return el.tagName === sel.toUpperCase();
}
function walk(el, out) {
  for (const c of el.children || []) { out.push(c); walk(c, out); }
  return out;
}
function findIn(root, sel) {
  // 逗号分隔的多选择器：返回第一个命中（够用）
  const parts = sel.split(",").map((s) => s.trim());
  const all = walk(root, []);
  for (const p of parts) {
    const hit = all.find((e) => matches(e, p.split(/\s+/).pop()));
    if (hit) return hit;
  }
  return null;
}
function findAllIn(root, sel) {
  const parts = sel.split(",").map((s) => s.trim());
  const all = walk(root, []);
  const out = [];
  for (const e of all) {
    const last = parts.some((p) => matches(e, p.split(/\s+/).pop()));
    // 粗略支持「父 子」：要求祖先里含父选择器（够用即可）
    const needsAncestor = parts.some((p) => p.includes(" ") && matches(e, p.split(/\s+/).pop()));
    if (last && !needsAncestor) out.push(e);
  }
  // 多段「A B」：遍历祖先
  for (const p of parts) {
    if (!p.includes(" ")) continue;
    const [anc, leaf] = p.split(/\s+/);
    for (const e of all) {
      if (!matches(e, leaf)) continue;
      let a = e.parentNode;
      let ok = false;
      while (a) { if (matches(a, anc)) { ok = true; break; } a = a.parentNode; }
      if (ok && !out.includes(e)) out.push(e);
    }
  }
  return out;
}

/** document 桩：按 id 惰性建元素，记录 document 级监听器 */
function makeEnv() {
  const byId = new Map();
  const docListeners = {};
  const docEl = makeElement("html");
  const bodyEl = makeElement("body");
  const doc = {
    hidden: false,
    documentElement: docEl,
    body: bodyEl,
    getElementById(id) {
      if (!byId.has(id)) { const e = makeElement("div"); e.id = id; byId.set(id, e); }
      return byId.get(id);
    },
    createElement: (t) => makeElement(t),
    querySelector(sel) { return findIn(docEl, sel); },
    querySelectorAll(sel) { return findAllIn(docEl, sel); },
    addEventListener(type, fn) { (docListeners[type] ??= []).push(fn); },
    removeEventListener() {},
    _emit(type, detail) { (docListeners[type] ?? []).forEach((fn) => fn({ type, detail })); },
    _has(type) { return (docListeners[type] ?? []).length > 0; },
    _listeners: docListeners,
  };
  // 左侧栏（bindEvents 里 querySelector('.pi-agent-container .sidebar-left') 会用到）
  const container = makeElement("div");
  container.classList.add("pi-agent-container");
  const leftbar = makeElement("div");
  leftbar.classList.add("sidebar-left");
  container.appendChild(leftbar);
  docEl.appendChild(container);
  return { doc, byId, container, leftbar };
}

/* ================= 宿主 ms 桩 ================= */

function makeMs(opts = {}) {
  const calls = [];
  const pickCalls = [];
  let projects = (opts.projects ?? [{ id: "p1", name: "项目一", path: "D:/data/proj1", badgeCount: 0, runningCount: 0, unseenCount: 0, sessionCount: 0 }]).slice();
  const backend = {
    async call(method, params) {
      calls.push({ method, params });
      switch (method) {
        case "init": return { ok: true, hasPi: true };
        case "listModels": return { models: [], defaultModel: "" };
        case "getConfig": return { config: {} };
        case "setConfig": return { ok: true };
        case "listProjects": return { projects };
        case "listSessions": return { sessions: [], badgeCount: 0 };
        case "loadSession": return { transcript: [] };
        case "markViewed": return { ok: true };
        case "addProject": {
          const p = String(params?.path || "");
          if (!p) return { error: "项目路径不能为空" };
          if (projects.some((x) => x.path.toLowerCase() === p.toLowerCase())) return { error: "项目已存在: " + p };
          const proj = { id: "p" + (projects.length + 1), name: p.split(/[\\/]/).pop(), path: p, badgeCount: 0, runningCount: 0, unseenCount: 0, sessionCount: 0 };
          projects.push(proj);
          return { ok: true, project: proj };
        }
        default: return { ok: true };
      }
    },
    onNotification() { return () => {}; },
    offNotification() {},
  };
  const ms = {
    backend,
    log() {},
    ui: {
      confirm: async () => true,
      toast() {},
      registerThemeProvider() { return () => {}; },
      applyTheme() {},
      onThemeChanged() { return () => {}; },
      theme: "dark",
      async pickFolder(o) { pickCalls.push(o || {}); return opts.pickResult ?? null; },
    },
    store: { get: async () => null, set: async () => true },
    input: opts.input === false ? undefined : { readFile: async () => { throw new Error("not image"); }, attachments: () => [] },
  };
  return { ms, calls, pickCalls, getProjects: () => projects.slice() };
}

function boot(msOpts = {}) {
  const { doc, byId, leftbar } = makeEnv();
  // 预置关键元素，让插件 init 的结构性引用能拿到
  for (const id of ["pi-project-list", "pi-session-list", "pi-chat-body", "pi-input", "pi-send-btn",
    "pi-model-select", "pi-chat-header", "pi-settings", "pi-settings-body", "pi-settings-title",
    "pi-settings-agent-path", "pi-settings-close", "pi-add-popover", "pi-add-project", "pi-pick-folder",
    "pi-confirm-add", "pi-cancel-add", "pi-project-path", "pi-welcome", "pi-load-more", "pi-scroll-bottom",
    "pi-image-chips", "pi-image-warn", "pi-install-overlay", "pi-install-btn", "pi-install-skip"]) {
    byId.set(id, Object.assign(makeElement("div"), { id }));
  }
  // 气泡默认隐藏
  byId.get("pi-add-popover").hidden = true;

  const { ms, calls, pickCalls, getProjects } = makeMs(msOpts);
  globalThis.document = doc;
  globalThis.window = globalThis;
  globalThis.setInterval = () => 0;   // 关掉轮询，避免测试挂住
  globalThis.clearInterval = () => {};
  globalThis.setTimeout = globalThis.setTimeout; // 保留真实 setTimeout
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

  const fn = new Function(
    "ms", "env", "plugin", "host", "keyword", "inputValue", "onSubKeyword", "md2html", "openExternal",
    '"use strict";' + String.fromCharCode(10) + src
  );
  fn(ms, {}, { id: "com.mysearch.pi-agent", name: "Pi Agent", version: "2.6.0" }, doc, "AI", "", () => {}, (s) => s, () => {});
  return { doc, byId, leftbar, calls, pickCalls, getProjects, ms };
}

/* ================= 场景 ================= */

/* 场景 1：源码契约 —— 事件订阅与关键函数存在 */
{
  check("源码订阅了 ms-dropped-paths", /((addEventListener|onDoc)\(\s*(document,\s*)?["']ms-dropped-paths["'])/.test(src));
  check("源码读取 detail.entries（宿主带回的 isDir 描述）", /detail\.entries/.test(src));
  check("源码订阅了 ms-drop-hover（原生拖放下的悬停高亮）", /((addEventListener|onDoc)\(\s*(document,\s*)?["']ms-drop-hover["'])/.test(src));
  check("源码用 closest 判定悬停是否落在左侧栏", /closest\(/.test(src) && /isOverSidebar/.test(src));
  check("源码定义了 pickFolderAndAdd", /function pickFolderAndAdd\s*\(/.test(src));
  check("pickFolderAndAdd 调用了 ms.ui.pickFolder", /ms\.ui\.pickFolder\s*\(/.test(src));
}

/* 场景 2：拖入文件夹 → addProject */
{
  const b = boot();
  await sleep(60);
  b.doc._emit("ms-dropped-paths", {
    paths: ["D:/code/dragged-folder"],
    entries: [{ path: "D:/code/dragged-folder", isDir: true }],
  });
  await sleep(80);
  const adds = b.calls.filter((c) => c.method === "addProject");
  check("拖入文件夹调用了 addProject", adds.length === 1, JSON.stringify(adds));
  check("addProject 收到的是拖入的文件夹路径",
    adds[0]?.params?.path === "D:/code/dragged-folder", JSON.stringify(adds[0]?.params));
  check("mock 后端里新增了该项目",
    b.getProjects().some((p) => p.path === "D:/code/dragged-folder"),
    JSON.stringify(b.getProjects().map((p) => p.path)));
}

/* 场景 2b：添加完成后「添加项目」气泡必须关闭（拖入入口） */
{
  const b = boot();
  await sleep(60);
  // 用户先把气泡打开（模拟“手动输入”开着，然后直接拖了个文件夹进来）
  b.byId.get("pi-add-popover").hidden = false;
  b.doc._emit("ms-dropped-paths", {
    paths: ["D:/code/drop-closes-pop"],
    entries: [{ path: "D:/code/drop-closes-pop", isDir: true }],
  });
  await sleep(120);
  check("拖入文件夹添加成功后，气泡自动关闭",
    b.byId.get("pi-add-popover").hidden === true,
    String(b.byId.get("pi-add-popover").hidden));
}

/* 场景 2c：添加失败（目录不存在）时气泡保持打开，方便用户修正 */
{
  const b = boot();
  await sleep(60);
  // 让 addProject 拒绝（真实后端在 sendError 时让 plugin_backend_call 抛错，
  // 而不是 resolve 一个 { error } 对象）
  const origCall = b.ms.backend.call;
  b.ms.backend.call = (method, params) =>
    method === "addProject" ? Promise.reject(new Error("目录不存在: " + params.path)) : origCall(method, params);
  b.byId.get("pi-add-popover").hidden = false;
  b.doc._emit("ms-dropped-paths", {
    paths: ["D:/code/nope"],
    entries: [{ path: "D:/code/nope", isDir: true }],
  });
  await sleep(120);
  check("添加失败时气泡不被关闭",
    b.byId.get("pi-add-popover").hidden === false,
    String(b.byId.get("pi-add-popover").hidden));
}

/* 场景 3：拖入文件 → 不当作项目 */
{
  const b = boot();
  await sleep(60);
  b.doc._emit("ms-dropped-paths", {
    paths: ["D:/code/some-file.txt"],
    entries: [{ path: "D:/code/some-file.txt", isDir: false }],
  });
  await sleep(80);
  check("拖入普通文件不调用 addProject",
    b.calls.filter((c) => c.method === "addProject").length === 0,
    JSON.stringify(b.calls.filter((c) => c.method === "addProject")));
}

/* 场景 4：混合拖入 —— 只有文件夹加项目，文件被忽略 */
{
  const b = boot();
  await sleep(60);
  b.doc._emit("ms-dropped-paths", {
    paths: ["D:/code/folder-a", "D:/code/pic.png", "D:/code/folder-b"],
    entries: [
      { path: "D:/code/folder-a", isDir: true },
      { path: "D:/code/pic.png", isDir: false },
      { path: "D:/code/folder-b", isDir: true },
    ],
  });
  await sleep(120);
  const adds = b.calls.filter((c) => c.method === "addProject").map((c) => c.params.path);
  check("混合拖入只把两个文件夹加为项目（文件被排除）",
    adds.length === 2 && adds.includes("D:/code/folder-a") && adds.includes("D:/code/folder-b"),
    JSON.stringify(adds));
  check("文件路径绝不进入 addProject", !adds.includes("D:/code/pic.png"), JSON.stringify(adds));
}

/* 场景 5：旧宿主不带 entries → 退化为「全部按文件」，不误加项目 */
{
  const b = boot();
  await sleep(60);
  b.doc._emit("ms-dropped-paths", { paths: ["D:/code/legacy-folder"] });
  await sleep(80);
  check("旧宿主（无 entries）不会把路径误当成项目",
    b.calls.filter((c) => c.method === "addProject").length === 0,
    JSON.stringify(b.calls.filter((c) => c.method === "addProject")));
}

/* 场景 6：点「选择文件夹…」→ pickFolder → addProject */
{
  const b = boot({ pickResult: "D:/code/picked-folder" });
  await sleep(60);
  // 模拟气泡已打开（UI 上点 + 后面板）
  b.byId.get("pi-add-popover").hidden = false;
  const btn = b.byId.get("pi-pick-folder");
  check("气泡里存在「选择文件夹」按钮（DOM 引用可解析）", !!btn);
  btn._fire("click", { type: "click", target: btn, stopPropagation() {}, preventDefault() {} });
  await sleep(120);
  check("点击后调用了 ms.ui.pickFolder", b.pickCalls.length === 1, JSON.stringify(b.pickCalls));
  const adds = b.calls.filter((c) => c.method === "addProject");
  check("选中后调用 addProject 且路径正确",
    adds.length === 1 && adds[0].params.path === "D:/code/picked-folder",
    JSON.stringify(adds));
  check("添加成功后气泡自动关闭",
    b.byId.get("pi-add-popover").hidden === true,
    String(b.byId.get("pi-add-popover").hidden));
}

/* 场景 7：用户取消选择（pickFolder 返回 null）→ 不调 addProject */
{
  const b = boot({ pickResult: null });
  await sleep(60);
  const btn = b.byId.get("pi-pick-folder");
  btn._fire("click", { type: "click", target: btn, stopPropagation() {}, preventDefault() {} });
  await sleep(120);
  check("取消选择时调用了 pickFolder", b.pickCalls.length === 1);
  check("取消选择时不调用 addProject",
    b.calls.filter((c) => c.method === "addProject").length === 0,
    JSON.stringify(b.calls.filter((c) => c.method === "addProject")));
}

/* 场景 8：宿主缺 pickFolder（旧宿主）→ 不崩、不误调 addProject */
{
  const b = boot();
  await sleep(60);
  b.ms.ui.pickFolder = undefined;
  const btn = b.byId.get("pi-pick-folder");
  btn._fire("click", { type: "click", target: btn, stopPropagation() {}, preventDefault() {} });
  await sleep(80);
  check("宿主无 pickFolder 时不崩且不调用 addProject",
    b.calls.filter((c) => c.method === "addProject").length === 0);
}

/* 场景 9：拖拽悬停高亮（宿主投递的 ms-drop-hover，原生拖放主路径） */
{
  const b = boot();
  await sleep(60);
  const leftbar = b.leftbar;
  // 悬停在左侧栏内 → 高亮
  b.doc._emit("ms-drop-hover", { active: true, hit: leftbar });
  check("悬停在左侧栏内 → pi-drop-active", leftbar.classList.contains("pi-drop-active"));

  // 悬停在栏内的子元素（如添加按钮）→ 仍高亮
  const addBtn = b.byId.get("pi-add-project");
  leftbar.appendChild(addBtn);
  b.doc._emit("ms-drop-hover", { active: true, hit: addBtn });
  check("悬停在栏内子元素 → 仍保持 pi-drop-active", leftbar.classList.contains("pi-drop-active"));

  // 悬停移到栏外的元素 → 不高亮
  const elsewhere = b.byId.get("pi-chat-body");
  b.doc._emit("ms-drop-hover", { active: true, hit: elsewhere });
  check("悬停在栏外元素 → 不高亮", !leftbar.classList.contains("pi-drop-active"));

  // active=false（离开/放下）→ 清除
  leftbar.classList.add("pi-drop-active");
  b.doc._emit("ms-drop-hover", { active: false, hit: null });
  check("ms-drop-hover active=false → 高亮清除", !leftbar.classList.contains("pi-drop-active"));

  // 真正投递路径时也要清除高亮
  leftbar.classList.add("pi-drop-active");
  b.doc._emit("ms-dropped-paths", {
    paths: ["D:/code/x"], entries: [{ path: "D:/code/x", isDir: true }],
  });
  await sleep(60);
  check("投递事件后高亮清除", !leftbar.classList.contains("pi-drop-active"));
}

/* 场景 9b：HTML5 dragover 兜底（未开启原生拖放的环境 / 旧宿主） */
{
  const b = boot();
  await sleep(60);
  const leftbar = b.leftbar;
  leftbar._fire("dragover", {
    type: "dragover",
    dataTransfer: { types: ["Files"], files: [{ name: "a.txt" }] },
    preventDefault() {},
  });
  check("dragover 兼底：悬停左侧栏进入 pi-drop-active", leftbar.classList.contains("pi-drop-active"));
  leftbar._fire("dragleave", { type: "dragleave", relatedTarget: b.doc.body });
  check("dragleave 兼底：离开左侧栏后高亮清除", !leftbar.classList.contains("pi-drop-active"));
}

/* 场景 10：空载荷不崩 */
{
  const b = boot();
  await sleep(60);
  b.doc._emit("ms-dropped-paths", {});
  b.doc._emit("ms-dropped-paths", undefined);
  b.doc._emit("ms-dropped-paths", { paths: [] });
  await sleep(60);
  check("空载荷/缺载荷不调用 addProject、不抛错",
    b.calls.filter((c) => c.method === "addProject").length === 0);
}

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
