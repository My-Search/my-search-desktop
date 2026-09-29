/**
 * github-upload 插件「拖入文件」通路的回归测试（Node 桩，不依赖浏览器）。
 *
 * 要钉死的契约（这条链路此前是**完全断的**，肉眼很难发现，因此必须上测试）：
 *
 *   1. 主窗口开着 Tauri 原生拖放处理器 → 插件页里的 HTML5 `dragover/drop`
 *      永远不会触发。所以插件必须订阅宿主的 `ms-dropped-paths` 定向事件，
 *      否则「把文件拖到插件界面上」不会发生任何事（本 bug）。
 *   2. 收到路径后要走 `ms.input.readFile(path)` → File → 上传管线，
 *      而不是把文件丢进搜索框附件列表。
 *   3. 缺 `file.read` 权限时要**明确提示**，不能静默失败（否则用户以为
 *      界面卡了）。
 *   4. 上传进行中再拖入 → 提示「当前已有上传任务」，不并行、不丢提示。
 *   5. 同一个文件不该被两条通路（定向投递 + 附件广播）重复上传。
 *   6. 附件集合变化（`ms-attachments-changed`）要触达 ingest，
 *      否则视图已开着时新加的附件不会上传。
 *
 * 用法: node test/github-upload-drop.test.mjs
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(
  path.join(root, "plugins", "com.zhuangjie.github-upload", "ui", "index.js"),
  "utf8"
);

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("PASS ", name, extra ? ` — ${extra}` : ""); }
  else { fail++; console.log("FAIL ", name, extra ? ` — ${extra}` : ""); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- DOM 桩（含 document 事件记录） ---------------- */

function makeElement(id) {
  let text = "";
  const el = {
    id,
    value: "",
    checked: false,
    style: {},
    _html: "",
    _handlers: {},
    _handlersAll: {},
    set innerHTML(v) { this._html = String(v); },
    get innerHTML() { return this._html; },
    set textContent(v) { text = String(v); this._html = String(v); },
    get textContent() { return text; },
    classList: { add() {}, remove() {}, contains() { return false; } },
    addEventListener(type, fn) { (this._handlersAll[type] ??= []).push(fn); },
    removeEventListener() {},
    dispatchEvent(ev) { this._fire(ev && ev.type, ev); return true; },
    _fire(type, ev) { (this._handlersAll[type] ?? []).forEach((fn) => fn.call(this, ev || {})); },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    getAttribute() { return null; },
    removeAttribute(k) { delete this[k]; },
    closest() { return null; },
    click() {},
  };
  return el;
}

/** document 桩：把监听器记下来，测试可手动派发（模拟宿主投递） */
function makeEnv() {
  const els = {};
  const docListeners = {};
  const doc = {
    getElementById: (id) => (els[id] ??= makeElement(id)),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener(type, fn) { (docListeners[type] ??= []).push(fn); },
    removeEventListener() {},
    createElement: () => makeElement("tmp"),
    /** 派发一个宿主要投递的事件 */
    _emit(type, detail) { (docListeners[type] ?? []).forEach((fn) => fn({ type, detail })); },
    _has(type) { return (docListeners[type] ?? []).length > 0; },
  };
  return { els, doc };
}

/** 可脚本化的宿主桩；readFile 按路径返回 data URL 或抛错 */
function makeMs(opts = {}) {
  const puts = [];
  const readCalls = [];
  const ms = {
    store: {
      get: (k, fb) => (k in (opts.store ?? {}) ? opts.store[k] : fb),
      set: () => true,
    },
    backend: {
      call: async (method) => {
        if (method === "init") return { ok: true };
        if (method === "getConfig") return { userAndRepo: "me/repo1", branch: "main", path: "/uploads", dns: "" };
        if (method === "resolveRefs") {
          return { resolved: (opts.__raw ?? []), notFound: [] };
        }
        return { ok: true };
      },
    },
    net: {
      fetch: async (url, o) => {
        if ((o?.method ?? "GET") === "PUT") {
          puts.push({ url, body: o?.body });
          return { status: 201, ok: true, text: JSON.stringify({
            content: { download_url: "https://raw.githubusercontent.com/me/repo1/main/x" } }) };
        }
        return { status: 200, ok: true, text: "[]" };
      },
    },
    system: { writeClipboard: async () => true },
    ui: { toast() {} },
    log() {},
  };
  if (opts.input !== false) {
    ms.input = {
      attachments: () => opts.attachments ?? [],
      readFile: (p) => {
        readCalls.push(p);
        const r = opts.readFile ? opts.readFile(p) : `data:text/plain;base64,QUJD`;
        return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
      },
    };
  }
  return { ms, puts, readCalls };
}

class FakeFileReader {
  readAsDataURL(file) {
    setTimeout(() => {
      this.result = `data:${file.type || "text/plain"};base64,QUJD`;
      if (this.onload) this.onload();
    }, 0);
  }
}

function boot(msOpts = {}) {
  const { els, doc } = makeEnv();
  const { ms, puts, readCalls } = makeMs(msOpts);
  globalThis.document = doc;
  globalThis.FileReader = FakeFileReader;
  const fn = new Function(
    "ms", "env", "plugin", "host", "keyword", "inputValue", "onSubKeyword", "md2html", "openExternal",
    src
  );
  fn(ms, {}, { id: "com.zhuangjie.github-upload" }, doc, "", "", () => {}, (s) => s, () => {});
  return { els, doc, puts, readCalls, ms };
}

/* ============ 场景 1：必须订阅宿主的投递事件 ============ */
{
  const { doc } = boot();
  check("插件订阅了 ms-dropped-paths（宿主的定向投递）", doc._has("ms-dropped-paths"));
  check("插件订阅了 ms-attachments-changed（附件广播）", doc._has("ms-attachments-changed"));
  check("源码里确实处理了 ms-dropped-paths", /addEventListener\(\s*["']ms-dropped-paths["']/.test(src));
}

/* ============ 场景 2：拖入路径 → 读文件 → 上传 ============ */
{
  const { doc, puts, readCalls } = boot({
    store: { token: "ghp_x", repoSelect: "me/repo1", path: "/uploads", dns: "" },
  });
  doc._emit("ms-dropped-paths", { paths: ["C:\\tmp\\hello.txt"] });
  await sleep(30);
  check("拖入后调用了 ms.input.readFile", readCalls.length === 1, JSON.stringify(readCalls));
  check("readFile 收到的是投递过来的真实路径", readCalls[0] === "C:\\tmp\\hello.txt");
  check("拖入的文件触发了上传 PUT", puts.length === 1, `puts=${puts.length}`);
  check(
    "上传内容来自该文件（不是搜索框附件）",
    puts[0] && /hello\.txt/.test(decodeURIComponent(String(puts[0].url)))
  );
}

/* ============ 场景 3：多个路径按序上传 ============ */
{
  const { doc, puts } = boot({
    store: { token: "ghp_x", repoSelect: "me/repo1", path: "/uploads", dns: "" },
  });
  doc._emit("ms-dropped-paths", { paths: ["C:\\tmp\\a.txt", "C:\\tmp\\b.txt"] });
  await sleep(60);
  check("两个拖入文件都被上传", puts.length === 2, `puts=${puts.length}`);
  check(
    "上传顺序与投递顺序一致（a 先于 b）",
    puts.length === 2 &&
      /a\.txt/.test(decodeURIComponent(String(puts[0].url))) &&
      /b\.txt/.test(decodeURIComponent(String(puts[1].url)))
  );
}

/* ============ 场景 4：空载荷 / 无载荷不崩、不上传 ============ */
{
  const { doc, puts } = boot();
  doc._emit("ms-dropped-paths", { paths: [] });
  doc._emit("ms-dropped-paths", {});
  doc._emit("ms-dropped-paths", undefined);
  await sleep(20);
  check("空载荷/缺载荷不触发上传，也不抛错", puts.length === 0, `puts=${puts.length}`);
}

/* ============ 场景 5：缺 file.read 能力时明确提示 ============ */
{
  const { doc, els, puts } = boot({ input: false });
  doc._emit("ms-dropped-paths", { paths: ["C:\\tmp\\x.txt"] });
  await sleep(20);
  check("缺 input 能力时不上传", puts.length === 0);
  check(
    "缺 input 能力时给出可读提示（非静默失败）",
    /权限/.test(String(els["gu-msg"].innerHTML ?? "")),
    String(els["gu-msg"].innerHTML).slice(0, 80)
  );
}

/* ============ 场景 6：读取失败的文件被跳过，不炸掉整批 ============ */
{
  const { doc, puts } = boot({
    store: { token: "ghp_x", repoSelect: "me/repo1", path: "/uploads", dns: "" },
    readFile: (p) => (p.includes("bad") ? new Error("读不到") : "data:text/plain;base64,QUJD"),
  });
  doc._emit("ms-dropped-paths", { paths: ["C:\\tmp\\bad.txt", "C:\\tmp\\good.txt"] });
  await sleep(50);
  check("坏文件被跳过，好文件照常上传", puts.length === 1, `puts=${puts.length}`);
  check(
    "上传的是那个能读到的文件",
    puts[0] && /good\.txt/.test(decodeURIComponent(String(puts[0].url)))
  );
}

/* ============ 场景 6b：全部读取失败必须明确报错（不能静默吞掉） ============ */
{
  // 现实里最常见的一种：宿主没把拖入路径登记给 Rust，attachment_read 直接
  // 以「路径不在已附加的内容范围内」拒绝。插件若静默 catch，用户只会看到
  // 「检测到 1 个拖入的文件」然后什么都没发生——这正是本 bug 的观感。
  //
  // 刻意不给 token：否则初始化会自动跑 doValidate，异步把 gu-msg 覆盖成
  // 「Token 有效…」，与本条要断言的读取错误混在一起（桩里仓库列表恒为空）。
  const { doc, puts, els } = boot({
    store: { repoSelect: "me/repo1", path: "/uploads", dns: "" },
    readFile: () => new Error("路径不在已附加的内容范围内"),
  });
  doc._emit("ms-dropped-paths", { paths: ["C:\\tmp\\a.txt"] });
  await sleep(40);
  const msg = String(els["gu-msg"].innerHTML ?? "");
  check("全部读取失败时不上传", puts.length === 0, `puts=${puts.length}`);
  check("读取失败给出可读错误（不再静默）", /读取失败/.test(msg), msg.slice(0, 100));
  check("错误里带上真实原因（路径不在…）", /路径不在已附加的内容范围内/.test(msg), msg.slice(0, 120));
  check("错误里带上文件名", /a\.txt/.test(msg), msg.slice(0, 120));
}

/* ============ 场景 7：附件广播触发 ingest（视图开着时也能收到） ============ */
{
  const { doc, puts, els } = boot({
    store: { token: "ghp_x", repoSelect: "me/repo1", path: "/uploads", dns: "" },
    attachments: [{ kind: "file", name: "pasted.txt", path: "C:\\tmp\\pasted.txt" }],
  });
  doc._emit("ms-attachments-changed");
  await sleep(40);
  check("附件变化广播触发了上传（不再只在初始化时拉一次）", puts.length === 1, `puts=${puts.length}`);
  check(
    "上传的是那条附件",
    puts[0] && /pasted\.txt/.test(decodeURIComponent(String(puts[0].url)))
  );
}

/* ============ 场景 8：同文件不被两条通路重复上传 ============ */
{
  const { doc, puts, els } = boot({
    store: { token: "ghp_x", repoSelect: "me/repo1", path: "/uploads", dns: "" },
    // 搜索框附件里也放着同一个文件的路径（宿主可能两边都有）
    attachments: [{ kind: "file", name: "dup.txt", path: "C:\\tmp\\dup.txt" }],
  });
  // 先走定向投递
  doc._emit("ms-dropped-paths", { paths: ["C:\\tmp\\dup.txt"] });
  await sleep(40);
  const afterDrop = puts.length;
  // 再走附件广播（同一个路径）
  doc._emit("ms-attachments-changed");
  await sleep(40);
  check("先拖入后广播，同一文件不重复上传", puts.length === afterDrop, `${afterDrop} → ${puts.length}`);
  check("确实上传过一次", afterDrop === 1, `afterDrop=${afterDrop}`);
}

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
