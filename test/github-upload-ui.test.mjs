/**
 * GitHub 文件上传插件 UI 回归测试（Node 桩，不依赖浏览器）。
 *
 * 覆盖本轮修过的几个点：
 *   1. ghFetch 必须按 { status, ok, text } 契约解包 ms.net.fetch 的返回
 *      （当字符串用 → 仓库列表恒为空、上传成功也取不到 content）；
 *   2. fetchRepos 按 permissions.push 过滤（不再按无关的 has_issues）；
 *   3. 仓库配置归一化（完整 URL / .git 后缀）与 404 的指路型报错；
 *   4. Token 变更后自动校验（防抖合批、同值去重、清空取消）。
 *
 * 用法: node test/github-upload-ui.test.mjs
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

/* ---------------- DOM 桩 ---------------- */

function escText(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function makeElement(id) {
  let text = "";
  const el = {
    id,
    value: "",
    checked: false,
    disabled: false,
    style: {},
    _html: "",
    _handlers: {},
    set innerHTML(v) { this._html = String(v); },
    get innerHTML() { return this._html; },
    set textContent(v) { text = String(v); this._html = escText(v); },
    get textContent() { return text; },
    // 真实可用的 classList：进度条要靠 done/err 这两个 class 表达结果，
    // 旧的空实现让「成功/失败态」在桩上永远测不出来
    _classes: new Set(),
    classList: {
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); },
      _s: null,
    },
    // 同类型可挂多个 listener（真实 DOM 语义）；_handlers 保留单槽兼容旧用法
    _handlersAll: {},
    addEventListener(type, fn) {
      this._handlers[type] = fn;
      (this._handlersAll[type] ??= []).push(fn);
    },
    removeEventListener() {},
    dispatchEvent(ev) { this._fire(ev && ev.type, ev); return true; },
    _fire(type, ev) {
      (this._handlersAll[type] ?? []).forEach((fn) => fn.call(this, ev || {}));
    },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    getAttribute() { return null; },
    removeAttribute(k) { delete this[k]; },
    closest() { return null; },
    click() {},
  };
  el.classList._s = el._classes;
  if (id === "gu-repo-input") {
    // 可输入过滤的 combobox：桩里补上真实可用的 classList / select，
    // 否则「过滤列表」「回填后全选」这些路径在桩上无处可测。
    const classes = new Set();
    el.classList = {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    };
    el._classes = classes;
    el._selected = false;
    el.select = () => { el._selected = true; };
    el.contains = () => false;
  }
  return el;
}

function makeEnv() {
  const els = {};
  const doc = {
    getElementById: (id) => (els[id] ??= makeElement(id)),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
    createElement: () => makeElement("tmp"),
  };
  return { els, doc };
}

/** 可脚本化的宿主桩：net.fetch 行为按 (method, url) 编排 */
function makeMs(opts) {
  const calls = []; // { method, url, headers, body }
  const toasts = [];
  const storeData = { ...(opts.store ?? {}) };
  const ms = {
    store: {
      get: (k, fb) => (k in storeData ? storeData[k] : fb),
      set: (k, v) => { storeData[k] = v; return true; },
    },
    backend: {
      call: async (method, params) => {
        if (method === "init") return { ok: true };
        if (method === "getConfig") return { userAndRepo: "", branch: "", path: "", dns: "", hasToken: true };
        if (method === "resolveRefs") {
          const resolved = (params?.texts ?? []).map((t) =>
            String(t).replace(/%([A-Z_]+)%/g, (m, name) => opts.envRefs?.[name] ?? m)
          );
          const notFound = [];
          for (const t of params?.texts ?? []) {
            const m = /%([A-Z_]+)%/.exec(String(t));
            if (m && !(m[1] in (opts.envRefs ?? {}))) notFound.push(m[1]);
          }
          return { resolved, notFound };
        }
        return { ok: true };
      },
    },
    net: {
      fetch: async (url, o) => {
        calls.push({ method: o?.method ?? "GET", url, headers: o?.headers ?? {}, body: o?.body });
        return opts.onFetch(url, o ?? {});
      },
    },
    system: { writeClipboard: async () => true },
    ui: { toast: (m) => toasts.push(String(m)) },
    env: undefined,
    log() {},
  };
  return { ms, calls, storeData, toasts };
}

/* ---------------- 场景公共载具 ---------------- */

class FakeFileReader {
  readAsDataURL(file) {
    setTimeout(() => {
      this.result = `data:${file.type};base64,QUJD`;
      if (this.onload) this.onload();
    }, 0);
  }
}

function boot(store, onFetch, envRefs) {
  const { els, doc } = makeEnv();
  const { ms, calls, storeData, toasts } = makeMs({ store, onFetch, envRefs });
  globalThis.document = doc;
  globalThis.FileReader = FakeFileReader;
  const fn = new Function(
    "ms", "env", "plugin", "host", "keyword", "inputValue", "onSubKeyword", "md2html", "openExternal",
    src
  );
  fn(ms, {}, { id: "com.zhuangjie.github-upload" }, doc, "", "", () => {}, (s) => s, () => {});
  // storeData 是本实例的存储副本（ms.store.set 写它）——保存→重开场景用它续 boot
  return { els, calls, storeData, toasts };
}

function triggerUpload(els, file) {
  const h = els["gu-file-input"]._handlers.change;
  h.call(els["gu-file-input"], { target: { files: [file] } });
}

/** 打开配置面板（顶部「配置」按钮 → 保存态） */
function openConfig(els) {
  els["gu-config-toggle"]._handlers.click.call(els["gu-config-toggle"]);
}

/** 模拟用户在仓库框里输入：写值 + 补发 input（程序改 value 不会自动触发） */
function typeRepo(els, text) {
  els["gu-repo-input"].value = text;
  els["gu-repo-input"]._fire("input", {});
}

/** 与插件 repoItems 同源的仓库列表（用于断言过滤结果） */
const pushedRepos = JSON.stringify([
  { full_name: "me/repo1", default_branch: "main", visibility: "public", pushed_at: "2026-09-20T00:00:00Z", has_issues: false, permissions: { push: true } },
  { full_name: "me/noPush", default_branch: "main", visibility: "private", pushed_at: "2026-09-19T00:00:00Z", has_issues: true, permissions: { push: false } },
  { full_name: "me/issuesOff", default_branch: "master", visibility: "public", pushed_at: "2026-09-18T00:00:00Z", has_issues: false, permissions: { push: true } },
  { full_name: "someone/blog-images", default_branch: "main", visibility: "public", pushed_at: "2026-09-17T00:00:00Z", has_issues: false, permissions: { push: true } },
]);

/** 仓库名是否出现在列表 HTML 里（列表项 data-repo="<full name>"） */
const listHas = (html, fullName) => String(html).includes(`data-repo="${fullName}"`);

/** 标准 net.fetch 编排：仓库列表 + contents GET(404) + PUT 成功 */
function makeFetch(extra = {}) {
  return async (url, o) => {
    if (url.includes("/user/repos")) return { status: 200, ok: true, text: pushedRepos };
    if ((o.method ?? "GET") === "GET" && url.includes("/contents/")) {
      throw new Error('HTTP 404: { "message": "Not Found" }');
    }
    if (o.method === "PUT") {
      const p = url.split("/contents")[1] ?? "";
      return {
        status: 201,
        ok: true,
        text: JSON.stringify({
          content: { download_url: "https://raw.githubusercontent.com" + (extra.ownerPath ?? "/me/repo1/main") + p },
        }),
      };
    }
    throw new Error("unexpected: " + url);
  };
}

/* ============ 场景 1：校验 → 列表；归一化仓库；上传成功 ============ */
{
  const store = {
    token: "%GITHUB_TOKEN%",
    repoSelect: "",
    repoInput: "https://github.com/me/repo1.git",
    branch: "",
    path: "",
    dns: "",
    compression: 0,
    compression_config: "0.9:600:0.9",
  };
  const putResult = JSON.stringify({
    content: { download_url: "https://raw.githubusercontent.com/me/repo1/main/uploads/2026/09/22/x.txt" },
  });

  const { els, calls } = boot(store, async (url, o) => {
    if (url.includes("/user/repos")) return { status: 200, ok: true, text: pushedRepos };
    if (url.includes("/contents/") && (o.method ?? "GET") === "GET") {
      const e = new Error('HTTP 404: { "message": "Not Found" }');
      throw e; // 宿主 Tauri 路径：非 2xx 直接 reject 字符串式错误
    }
    if (o.method === "PUT") return { status: 201, ok: true, text: putResult };
    throw new Error("unexpected url: " + url);
  }, { GITHUB_TOKEN: "ghp_real_token" });

  await sleep(150); // loadStore → tryInitBackend → doValidate

  // 仓库候选现在挂在 combobox 的列表里（打开才渲染），不再是常驻的 <select> options
  openConfig(els);
  typeRepo(els, "");
  const listHtml = els["gu-repo-list"]._html;
  check("校验后仓库候选按契约解包（不再恒为空）", listHas(listHtml, "me/repo1") && listHas(listHtml, "me/issuesOff"), listHtml.slice(0, 160));
  check("列出的都是可推送仓库（permissions.push）", listHas(listHtml, "me/repo1") && !listHtml.includes("me/noPush"));
  check("has_issues=false 的可推送仓库也在列表里（不再被误滤）", listHas(listHtml, "me/issuesOff"));
  const msg1 = els["gu-msg"]._html;
  // 打开视图时的校验是「安静」的：Token 存在存储里，每次打开都报「Token 有效，共 N 个」
  // 是纯噪音（用户明确反馈过），所以这条只在用户主动点「校验 Token」时出现
  check("打开视图时不刷「Token 有效」噪音", !msg1.includes("Token 有效"), msg1 || "(空)");
  els["gu-validate-token"]._handlers.click.call(els["gu-validate-token"]);
  await sleep(80);
  check("主动点「校验 Token」有回执（含可推送仓库数）",
    els["gu-msg"]._html.includes("Token 有效，共 3 个可推送仓库"), els["gu-msg"]._html);

  triggerUpload(els, { name: "x.txt", type: "text/plain", size: 3 });
  await sleep(150);

  const put = calls.find((c) => c.method === "PUT");
  check("上传走了 PUT", !!put);
  check("仓库配置归一化（URL+.git → owner/repo）", !!put && put.url.startsWith("https://api.github.com/repos/me/repo1/contents/uploads/"), put?.url);
  check("Token 经 resolveRefs 解析后进入 Authorization", !!put && put.headers.Authorization === "token ghp_real_token", put?.headers.Authorization);
  check("上传成功提示", els["gu-msg"]._html.includes("上传成功"), els["gu-msg"]._html);
  check("结果区含下载链接", els["gu-result"]._html.includes("raw.githubusercontent.com/me/repo1"), els["gu-result"]._html.slice(0, 160));
}

/* ============ 场景 2：PUT 404 → 指路型报错 ============ */
{
  const store = {
    token: "ghp_literal",
    repoSelect: "",
    repoInput: "me/missing-repo",
    branch: "", path: "", dns: "",
    compression: 0, compression_config: "0.9:600:0.9",
  };
  const { els } = boot(store, async (url, o) => {
    if (url.includes("/user/repos")) return { status: 200, ok: true, text: pushedRepos };
    if ((o.method ?? "GET") === "GET" && url.includes("/contents/")) {
      throw new Error('HTTP 404: { "message": "Not Found" }');
    }
    if (o.method === "PUT") throw new Error('HTTP 404: { "message": "Not Found", "status": "404" }');
    throw new Error("unexpected: " + url);
  });
  await sleep(150);

  triggerUpload(els, { name: "x.txt", type: "text/plain", size: 3 });
  await sleep(150);

  const msg = els["gu-msg"]._html;
  check("404 报错点名了仓库", msg.includes('仓库 "me/missing-repo" 不存在或 Token 无权访问'), msg.slice(0, 200));
  check("404 报错给出排查方向", msg.includes("owner/repo") && msg.includes("细粒度 Token"), msg.slice(0, 300));
}

/* ============ 场景 3：仓库格式非法 → 上传前即拒绝 ============ */
{
  const store = {
    token: "ghp_literal",
    repoSelect: "",
    repoInput: "just-a-name",
    branch: "", path: "", dns: "",
    compression: 0, compression_config: "0.9:600:0.9",
  };
  let putCalled = false;
  const { els, calls } = boot(store, async (url, o) => {
    if (url.includes("/user/repos")) return { status: 200, ok: true, text: pushedRepos };
    if (o.method === "PUT") { putCalled = true; throw new Error("should not reach"); }
    throw new Error("unexpected: " + url);
  });
  await sleep(150);
  triggerUpload(els, { name: "x.txt", type: "text/plain", size: 3 });
  await sleep(150);
  const msg = els["gu-msg"]._html;
  check("非 owner/repo 仓库在上传前被拒绝", msg.includes("owner/repo 格式"), msg.slice(0, 200));
  check("非法仓库没有发出 PUT", !putCalled && !calls.some((c) => c.method === "PUT"));
}

/* ============ 场景 4：输入过滤选中仓库 → 保存 → 重开不丢 ============ */
{
  const store = {
    token: "ghp_literal", repoSelect: "", repoInput: "",
    branch: "", path: "", dns: "", compression: 0, compression_config: "0.9:600:0.9",
  };
  const onFetch = makeFetch();
  const first = boot(store, onFetch);
  await sleep(200); // 自动校验 → 候选就绪
  openConfig(first.els);
  typeRepo(first.els, "repo1"); // 用户输入过滤词
  const filtered = first.els["gu-repo-list"]._html;
  check("输入过滤词后列表只剩匹配项", listHas(filtered, "me/repo1") && !listHas(filtered, "me/issuesOff"), filtered.slice(0, 200));
  check("过滤命中项高亮匹配词", filtered.includes("<mark>") && filtered.includes("repo1"), filtered.slice(0, 200));
  first.els["gu-repo-input"]._handlersAll.keydown[0].call(first.els["gu-repo-input"], { key: "Enter", preventDefault() {} });
  check("回车选中高亮项并回填输入框", first.els["gu-repo-input"].value === "me/repo1", first.els["gu-repo-input"].value);
  check("选中仓库后自动带出默认分支", first.els["gu-branch"].value === "main", first.els["gu-branch"].value);
  check("选中后下拉收起", first.els["gu-repo-list"].style.display === "none", String(first.els["gu-repo-list"].style.display));

  first.els["gu-save-config"]._handlers.click.call(first.els["gu-save-config"]);
  await sleep(50);
  check("保存把选中的仓库写入存储", first.storeData.repoInput === "me/repo1", String(first.storeData.repoInput));

  const second = boot(first.storeData, onFetch); // 重新打开
  await sleep(250); // 自动校验
  check("重开后仓库仍是已存值", second.els["gu-repo-input"].value === "me/repo1", second.els["gu-repo-input"].value);
}

/* ============ 场景 5：手填仓库（不在候选里）原样保存、原样可上传 ============ */
{
  const store = {
    token: "ghp_literal", repoSelect: "", repoInput: "me/typed-repo",
    branch: "", path: "", dns: "", compression: 0, compression_config: "0.9:600:0.9",
  };
  const { els, calls } = boot(store, makeFetch());
  await sleep(250); // 自动校验
  check("手填仓库原样显示（不被候选覆盖）", els["gu-repo-input"].value === "me/typed-repo", els["gu-repo-input"].value);
  openConfig(els);
  typeRepo(els, "me/not-in-list");
  const empty = els["gu-repo-list"]._html;
  check("候选为空时给出「可手填」提示而不是死列表", empty.includes("没有匹配的仓库"), empty.slice(0, 200));
  els["gu-repo-list"]._fire("mousedown", { preventDefault() {}, target: { closest: () => null } });
  check("候选为空时点列表不改变输入值", els["gu-repo-input"].value === "me/not-in-list", els["gu-repo-input"].value);
  els["gu-repo-input"].value = "me/typed-repo";
  triggerUpload(els, { name: "x.txt", type: "text/plain", size: 3 });
  await sleep(200);
  const put = calls.find((c) => c.method === "PUT");
  check("手填仓库照样能上传", !!put && put.url.includes("/repos/me/typed-repo/contents/"), put?.url);
}

/* ============ 场景 6：点保存 → 落盘 + 自动收起 ============ */
{
  const store = { token: "", repoSelect: "", repoInput: "", branch: "", path: "", dns: "", compression: 0, compression_config: "0.9:600:0.9" };
  const { els, storeData } = boot(store, async () => { throw new Error("不应联网"); });
  await sleep(120);
  openConfig(els);
  check("配置面板已打开", els["gu-config-panel"].style.display === "block");
  check("打开后按钮变为「保存」", els["gu-config-toggle"]._html.includes("保存"), els["gu-config-toggle"]._html);
  els["gu-path"].value = "/custom-uploads";
  els["gu-save-config"]._handlers.click.call(els["gu-save-config"]); // 面板内「保存并收起」
  await sleep(50);
  check("面板内保存写入了存储", storeData.path === "/custom-uploads", String(storeData.path));
  check("面板内保存后面板自动收起", els["gu-config-panel"].style.display === "none", String(els["gu-config-panel"].style.display));
  check("收起后按钮变回「配置」", els["gu-config-toggle"]._html.includes("配置"), els["gu-config-toggle"]._html);
  check("收起时清掉仓库下拉浮层", els["gu-repo-list"].style.display === "none", String(els["gu-repo-list"].style.display));

  // 顶部的「保存」态按钮同样是「保存并收起」
  openConfig(els);
  els["gu-dns"].value = "https://my.cdn";
  els["gu-config-toggle"]._handlers.click.call(els["gu-config-toggle"]);
  await sleep(50);
  check("顶部保存按钮也落盘", storeData.dns === "https://my.cdn", String(storeData.dns));
  check("顶部保存按钮也收起面板", els["gu-config-panel"].style.display === "none", String(els["gu-config-panel"].style.display));
}

/* ============ 场景 7：仓库为空时上传 → 回退存储（兼容旧版 repoSelect 键） ============ */
{
  // 只存了旧版的 repoSelect（升级用户的历史数据）→ 迁移到输入框
  const store = { token: "", repoSelect: "me/saved-repo", repoInput: "", branch: "", path: "", dns: "", compression: 0, compression_config: "0.9:600:0.9" };
  const { els, calls } = boot(store, makeFetch());
  await sleep(120);
  check("旧版 repoSelect 迁移进输入框", els["gu-repo-input"].value === "me/saved-repo", els["gu-repo-input"].value);
  els["gu-repo-input"].value = ""; // 输入框被清空 → 上传时回退存储
  triggerUpload(els, { name: "x.txt", type: "text/plain", size: 3 });
  await sleep(200);
  const put = calls.find((c) => c.method === "PUT");
  check("PUT 使用了存储里的仓库（DOM 取空时回退）", !!put && put.url.includes("/repos/me/saved-repo/contents/"), put?.url);
}

/* ============ 场景 8：Token 变更后自动校验（防抖合批、同值去重、清空取消） ============ */
{
  const store = { token: "", repoSelect: "", repoInput: "", branch: "", path: "", dns: "", compression: 0, compression_config: "0.9:600:0.9" };
  const { els, calls } = boot(store, makeFetch());
  await sleep(150);
  const countRepos = () => calls.filter((c) => c.url.includes("/user/repos")).length;
  check("Token 为空时初始化不发起校验", countRepos() === 0, String(countRepos()));

  // 逐字输入：多次 input 事件只在停顿 700ms 后打一次 API
  els["gu-token"].value = "ghp_";
  els["gu-token"]._fire("input", {});
  await sleep(200);
  els["gu-token"].value = "ghp_new";
  els["gu-token"]._fire("input", {});
  await sleep(200);
  els["gu-token"].value = "ghp_new_token";
  els["gu-token"]._fire("input", {});
  await sleep(950);

  const repoCalls = calls.filter((c) => c.url.includes("/user/repos"));
  check("Token 变更后自动发起校验（防抖合批为一次）", repoCalls.length === 1, String(repoCalls.length));
  check("自动校验请求携带最新 Token", repoCalls[0]?.headers.Authorization === "token ghp_new_token", repoCalls[0]?.headers.Authorization);
  check("自动校验不刷「Token 有效」噪音（成功是稳态，不该反复提示）",
    !els["gu-msg"]._html.includes("Token 有效"), els["gu-msg"]._html || "(空)");
  // 安静只是「不弹提示」，候选该拉的还得拉：打开配置能看到过滤用的仓库列表
  openConfig(els);
  typeRepo(els, "");
  check("自动校验仍把候选拉起来（安静 ≠ 不干活）", listHas(els["gu-repo-list"]._html, "me/repo1"), els["gu-repo-list"]._html.slice(0, 160));
  els["gu-config-toggle"]._handlers.click.call(els["gu-config-toggle"]); // 收起

  // 同一 Token 再触发 input → 不重复请求
  els["gu-token"]._fire("input", {});
  await sleep(950);
  check("相同 Token 不重复校验", countRepos() === 1, String(countRepos()));

  // 清空输入 → 取消将发未发的校验
  els["gu-token"].value = "";
  els["gu-token"]._fire("input", {});
  await sleep(950);
  check("清空 Token 不发起校验", countRepos() === 1, String(countRepos()));
}

/* ============ 场景 9：改动即自动保存（面板收起时落盘，不依赖用户点保存） ============ */
{
  const store = { token: "", repoSelect: "", repoInput: "", branch: "", path: "/uploads", dns: "", compression: 0, compression_config: "0.9:600:0.9" };
  const { els, storeData, toasts } = boot(store, async () => { throw new Error("不应联网"); });
  await sleep(120);
  openConfig(els);
  els["gu-branch"].value = "dev";
  els["gu-branch"]._fire("input", {});
  await sleep(30);
  // 还没收起面板：此时不应落盘（用户可能还在改）
  check("面板未收起时不抢先落盘", storeData.branch !== "dev", String(storeData.branch));

  els["gu-config-toggle"]._handlers.click.call(els["gu-config-toggle"]); // 收起（= 「保存」态按钮）
  await sleep(50);
  check("收起面板即自动保存分支", storeData.branch === "dev", String(storeData.branch));
  check("自动保存不刷「配置已保存」提示（不顶掉上传结果）", !els["gu-msg"]._html.includes("配置已保存"), els["gu-msg"]._html || "(空)");
  check("自动保存也不弹 toast", toasts.length === 0, JSON.stringify(toasts));

  // 字段失焦也保存（用户改完直接点上传区，不会经过顶部按钮）
  openConfig(els);
  els["gu-dns"].value = "https://my.cdn";
  els["gu-dns"]._fire("change", {});
  await sleep(30);
  check("字段失焦/变更即落盘", storeData.dns === "https://my.cdn", String(storeData.dns));
}

/* ============ 场景 10：上传进度条（阶段推进 / 成功推满 / 失败标红） ============ */
{
  const store = { token: "ghp_literal", repoInput: "me/repo1", repoSelect: "", branch: "", path: "", dns: "", compression: 0, compression_config: "0.9:600:0.9" };
  let releasePut;
  const putGate = new Promise((r) => { releasePut = r; });
  const { els } = boot(store, async (url, o) => {
    if (url.includes("/user/repos")) return { status: 200, ok: true, text: pushedRepos };
    if ((o.method ?? "GET") === "GET" && url.includes("/contents/")) throw new Error('HTTP 404: { "message": "Not Found" }');
    if (o.method === "PUT") {
      await putGate; // 卡住 PUT，好在「上传中」这一刻观察进度条
      const p = url.split("/contents")[1] ?? "";
      return { status: 201, ok: true, text: JSON.stringify({ content: { download_url: "https://raw.githubusercontent.com/me/repo1/main" + p } }) };
    }
    throw new Error("unexpected: " + url);
  });
  await sleep(150);

  check("未上传时进度条隐藏", els["gu-progress"].style.display !== "block", String(els["gu-progress"].style.display));

  triggerUpload(els, { name: "x.txt", type: "text/plain", size: 3 });
  await sleep(60);
  check("上传开始即显示进度条", els["gu-progress"].style.display === "block", String(els["gu-progress"].style.display));
  const pctDuring = parseInt(els["gu-progress-pct"]._html, 10);
  check("进度条显示百分比与阶段文案", Number.isFinite(pctDuring) && els["gu-progress-text"]._html.length > 0,
    `${els["gu-progress-pct"]._html} / ${els["gu-progress-text"]._html}`);
  const widthDuring = String(els["gu-progress-bar"].style.width || "");
  check("进度条宽度与百分比一致", widthDuring === `${pctDuring}%`, widthDuring);

  releasePut();
  for (let i = 0; i < 30; i++) {
    await sleep(50);
    if (els["gu-msg"]._html.includes("上传成功")) break;
  }
  check("成功后进度推满 100%", els["gu-progress-bar"].style.width === "100%", String(els["gu-progress-bar"].style.width));
  check("成功后进度条标记完成色", els["gu-progress"]._classes?.has("done") === true, JSON.stringify([...(els["gu-progress"]._classes ?? [])]));
}

/* ============ 场景 11：上传失败 → 进度停在当前阶段并标红 ============ */
{
  const store = { token: "ghp_literal", repoInput: "me/repo1", repoSelect: "", branch: "", path: "", dns: "", compression: 0, compression_config: "0.9:600:0.9" };
  const { els } = boot(store, async (url, o) => {
    if (url.includes("/user/repos")) return { status: 200, ok: true, text: pushedRepos };
    if ((o.method ?? "GET") === "GET" && url.includes("/contents/")) throw new Error('HTTP 404: { "message": "Not Found" }');
    if (o.method === "PUT") throw new Error("HTTP 500: boom");
    throw new Error("unexpected: " + url);
  });
  await sleep(150);
  triggerUpload(els, { name: "x.txt", type: "text/plain", size: 3 });
  for (let i = 0; i < 30; i++) {
    await sleep(50);
    if (els["gu-msg"]._html.includes("上传失败")) break;
  }
  const pct = parseInt(els["gu-progress-pct"]._html, 10);
  check("失败时进度不推满 100%（不撒谎）", pct < 100, String(pct));
  check("失败时进度条标红", els["gu-progress"]._classes?.has("err") === true, JSON.stringify([...(els["gu-progress"]._classes ?? [])]));
  check("失败时进度条仍可见（让用户看到卡在哪一步）", els["gu-progress"].style.display === "block", String(els["gu-progress"].style.display));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
