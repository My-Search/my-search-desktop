/**
 * GitHub 文件上传插件 —— 满高布局 + 拖拽/粘贴/选择 三通道回归（无头 Chrome）。
 *
 * 覆盖：
 *   1. 容器满高 484px（宿主 #text_show border-box max-height510 − padding26
 *      的精确口径，盒子总高恰好 560 顶到窗口上限），上传区 flex 吃满剩余空间；
 *   2. #text_show（宿主真实规则，运行时从 style.css 提取）不出现纵向溢出；
 *   3. 选择文件（点上传区 → file input.click 被调用）；
 *   4. 拖拽文件到面板 → 走完整上传链路（PUT 发出、成功提示）；
 *   5. Ctrl+V 粘贴图片 → 上传 + 图片预览出现（gu-preview 可见且 src 为 data:image）；
 *   6. 配置面板开合不改变容器总高（绝对定位浮层，宿主窗口高度不抖）。
 *
 * 用法: node test/github-upload-layout.test.mjs
 */
import { createServer } from "http";
import { readFile, rm } from "fs/promises";
import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const filesDir = path.join(root, "plugins", "com.zhuangjie.github-upload", "ui");

/** 从宿主真实 style.css 提取 #text_show 规则（布局口径以它为准） */
async function extractTextShowRule() {
  const css = await readFile(path.join(root, "src", "css", "style.css"), "utf8");
  const m = /#text_show\s*\{[^}]*\}/.exec(css);
  if (!m) throw new Error("style.css 中未找到 #text_show 规则");
  return m[0];
}
const textShowRule = await extractTextShowRule();

const server = createServer(async (req, res) => {
  try {
    const u = decodeURIComponent(req.url.split("?")[0]);
    if (u === "/api/plugin-files") {
      const [html, css, js] = await Promise.all([
        readFile(path.join(filesDir, "detail.html"), "utf8"),
        readFile(path.join(filesDir, "detail.css"), "utf8"),
        readFile(path.join(filesDir, "index.js"), "utf8"),
      ]);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ html, css, js, textShowRule }));
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HARNESS);
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const HARNESS = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>github-upload layout harness</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; background: #fff; }
  #my_search_box { position: relative; border: 2px solid #cecece; width: 100%; background: #fff; }
  #searchBox { height: 44px; }
  /* #text_show 规则由服务端从宿主 style.css 提取注入（含 display:none，
     与真实宿主一致：由外联逻辑翻成 display:block） */
</style></head>
<body>
<div id="my_search_box">
  <div id="searchBox"></div>
  <div id="text_show"><div class="plugin-view" id="plugin-host"></div></div>
</div>
<script type="module">
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const files = await (await fetch("/api/plugin-files")).json();

// 宿主 #text_show 真实规则 + display:none（宿主用内联样式翻开）
const hostStyle = document.createElement("style");
hostStyle.textContent = files.textShowRule;
document.head.appendChild(hostStyle);
document.getElementById("text_show").style.display = "block";

// 插件样式（宿主会按 #text_show .plugin-view 作用域重写；本夹具直接内联同效）
const pluginStyle = document.createElement("style");
pluginStyle.textContent = files.css;
document.head.appendChild(pluginStyle);

const host = document.getElementById("plugin-host");
host.innerHTML = files.html;

const calls = [];          // { method, url }
window.__calls = calls;
window.__clicks = 0;

const repos = JSON.stringify([
  { full_name: "me/repo1", default_branch: "main", visibility: "public",
    pushed_at: "2026-09-20T00:00:00Z", permissions: { push: true } },
]);

const ms = {
  store: {
    _v: { token: "ghp_t", repoSelect: "", repoInput: "me/repo1", branch: "", path: "", dns: "",
          compression: 0, compression_config: "0.9:600:0.9" },
    get(k, fb) { return k in this._v ? this._v[k] : fb; },
    set(k, v) { this._v[k] = v; return true; },
  },
  backend: {
    async call(method, params) {
      if (method === "init") return { ok: true };
      if (method === "getConfig") return { userAndRepo: "", branch: "", path: "", dns: "", hasToken: true };
      if (method === "resolveRefs") return { resolved: params?.texts ?? [], notFound: [] };
      return { ok: true };
    },
  },
  net: {
    async fetch(url, o) {
      const method = o?.method ?? "GET";
      calls.push({ method, url });
      if (url.includes("/user/repos")) return { status: 200, ok: true, text: repos };
      if (method === "GET" && url.includes("/contents/")) throw new Error('HTTP 404: { "message": "Not Found" }');
      if (method === "PUT") {
        const path = url.split("/contents")[1] ?? "";
        return { status: 201, ok: true, text: JSON.stringify({
          content: { download_url: "https://raw.githubusercontent.com/me/repo1/main" + path },
        })};
      }
      throw new Error("unexpected: " + url);
    },
  },
  system: { writeClipboard: async () => true },
  ui: { toast() {} },
  env: undefined,
  log() {},
};

// 选择文件的断言点：拦截 file input 的 click（不真弹系统对话框）
const fileInput = document.getElementById("gu-file-input");
fileInput.click = () => { window.__clicks++; };

const fn = new Function("ms", "env", "plugin", "host", "keyword", "inputValue", "onSubKeyword", "md2html", "openExternal", files.js);
fn(ms, {}, { id: "com.zhuangjie.github-upload" }, host, "", "", () => {}, (s) => s, () => {});

window.__ready = true;
</script>
</body></html>`;

const candidates = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];
const bin = candidates.find((p) => existsSync(p));
if (!bin) {
  console.log("未找到浏览器，跳过");
  server.close();
  process.exit(0);
}

const userDir = path.join(root, "test", "_chrome-profile-gh-upload-layout");
await rm(userDir, { recursive: true, force: true });
const chrome = spawn(
  bin,
  ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${userDir}`, "about:blank"],
  { stdio: ["ignore", "ignore", "pipe"] }
);
const wsUrl = await new Promise((resolve, reject) => {
  let buf = "";
  const t = setTimeout(() => reject(new Error("浏览器启动超时")), 20000);
  chrome.stderr.on("data", (d) => {
    buf += d.toString();
    const m = buf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (m) { clearTimeout(t); resolve(m[1]); }
  });
});
const ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
const pageErrors = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === "Runtime.exceptionThrown") {
    pageErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  }
};
function S(method, params = {}, sessionId) {
  return new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
  });
}
const { result: targets } = await S("Target.getTargets");
const pageTarget = targets.targetInfos.find((t) => t.type === "page");
const { result: { sessionId } } = await S("Target.attachToTarget", { targetId: pageTarget.targetId, flatten: true });
await S("Runtime.enable", {}, sessionId);
await S("Page.enable", {}, sessionId);
const evalJs = async (expr) => {
  const r = await S("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.result?.exceptionDetails) {
    throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails).slice(0, 400));
  }
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("PASS ", name, extra ? ` — ${extra}` : ""); }
  else { fail++; console.log("FAIL ", name, extra ? ` — ${extra}` : ""); }
};

await S("Page.navigate", { url: base + "/" }, sessionId);
await sleep(1200);
check("夹具加载（插件 UI 已挂载）", await evalJs(`!!window.__ready`));

/* ---- 1. 满高布局 ---- */
const containerH = await evalJs(`getComputedStyle(document.querySelector(".gu-container")).height`);
check("容器满高 484px（510-26 精确口径）", containerH === "484px", containerH);
const dropH = await evalJs(`document.getElementById("gu-drop-zone").getBoundingClientRect().height`);
check("上传区 flex 吃满剩余空间（>300px）", dropH > 300, `drop=${Math.round(dropH)}px`);
const scrollDiff = await evalJs(`
  (() => { const t = document.getElementById("text_show");
    return t.scrollHeight - t.clientHeight; })()
`);
check("#text_show 零纵向溢出（宿主真实规则）", scrollDiff === 0, `scrollHeight-clientHeight=${scrollDiff}`);
const winBox = await evalJs(`
  (() => { const b = document.getElementById("my_search_box");
    return b.getBoundingClientRect().height; })()
`);
// 盒子 = 4(边框) + 44(搜索行) + 510(#text_show 顶到 max-height) = 558
check("盒子高度顶满（558 = text_show 落在 510 上限）", winBox === 558, `box=${Math.round(winBox)}px`);

/* ---- 2. 选择文件：点上传区 → file input.click ---- */
await evalJs(`
  document.getElementById("gu-drop-zone").dispatchEvent(new MouseEvent("click", { bubbles: true }))
`);
check("点击上传区触发文件选择（file input.click）", (await evalJs(`window.__clicks`)) === 1, `clicks=${await evalJs("window.__clicks")}`);
await sleep(300); // 等初始化期的自动校验完成，避免与上传断言混淆

/* ---- 3. 拖拽文件 → 完整上传链路 ---- */
await evalJs(`
  (() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([65, 66, 67])], "a.txt", { type: "text/plain" }));
    document.querySelector(".gu-container").dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: dt }));
  })()
`);
let ok = false;
for (let i = 0; i < 40; i++) {
  await sleep(100);
  if (await evalJs(`document.getElementById("gu-msg").innerHTML.includes("上传成功")`)) { ok = true; break; }
}
check("拖拽文件触发上传并成功", ok, await evalJs(`document.getElementById("gu-msg").textContent`));
const puts1 = await evalJs(`window.__calls.filter(c => c.method === "PUT").length`);
check("拖拽上传发出 PUT", puts1 === 1, `puts=${puts1}`);

/* ---- 4. 粘贴图片 → 上传 + 预览 ---- */
await evalJs(`
  document.getElementById("gu-msg").innerHTML = "";
  (() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" }));
    document.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: dt }));
  })()
`);
ok = false;
for (let i = 0; i < 40; i++) {
  await sleep(100);
  if (await evalJs(`document.getElementById("gu-msg").innerHTML.includes("上传成功")`)) { ok = true; break; }
}
check("粘贴图片触发上传并成功", ok, await evalJs(`document.getElementById("gu-msg").textContent`));
const puts2 = await evalJs(`window.__calls.filter(c => c.method === "PUT").length`);
check("粘贴上传发出第二个 PUT", puts2 === 2, `puts=${puts2}`);
const preview = await evalJs(`
  (() => { const p = document.getElementById("gu-preview");
    return { visible: p.style.display === "block", isDataImg: String(p.src || "").startsWith("data:image"), hintHidden: document.getElementById("gu-drop-hint").style.display === "none" }; })()
`);
check("图片预览出现（可见 + data:image）", preview.visible && preview.isDataImg, JSON.stringify(preview));
check("预览时提示文案隐藏", preview.hintHidden);

/* ---- 5. 配置面板开合不改变容器总高 ---- */
await evalJs(`document.getElementById("gu-config-toggle").click()`);
await sleep(100);
const panelState = await evalJs(`
  (() => { const c = document.querySelector(".gu-container"), p = document.getElementById("gu-config-panel");
    return { h: getComputedStyle(c).height, panel: getComputedStyle(p).display }; })()
`);
check("配置面板打开为浮层", panelState.panel === "block", JSON.stringify(panelState));
check("开面板后容器总高不变（484px）", panelState.h === "484px", panelState.h);
await evalJs(`document.getElementById("gu-config-toggle").click()`);

check("页面无未捕获异常", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 300));

console.log(`\n${pass} passed, ${fail} failed`);
ws.close();
chrome.kill();
server.close();
process.exit(fail === 0 ? 0 : 1);
