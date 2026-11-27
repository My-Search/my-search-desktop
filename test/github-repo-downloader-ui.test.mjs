/**
 * GitHub 仓库搜索与批量下载器 —— 真实 Chrome UI 回归
 *
 * 用固定后端桩启动插件页，验证：
 *   1. 首屏引导、搜索请求参数、仓库卡片渲染、分页加载；
 *   2. 勾选、全选状态、底栏计数；
 *   3. 下载弹窗：选择文件夹、合并模式、开始下载的 RPC 参数；
 *   4. 进度视图：running → done、打开文件夹按钮；
 *   5. 设置弹窗：Token 测试 / 保存、网络设置；
 *   6. 页面无 JS 异常，并输出截图供人工检查。
 *
 * 用法: node test/github-repo-downloader-ui.test.mjs
 */
import { createServer } from "http";
import { readFile, writeFile, mkdir, rm } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = path.join(root, "plugins", "com.zhuangjie.github-repo-downloader");
const uiDir = path.join(pluginDir, "ui");
const fixture = path.join(root, "test", "fixtures", "github-repo-downloader-mock.js");
const outDir = path.join(root, "test", "_tmp", "github-repo-downloader-ui");
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const pageHtml = readFileSync(path.join(uiDir, "detail.html"), "utf8").replace(
  '<script src="index.js"></script>',
  '<script src="mock-host.js"></script>\n<script src="index.js"></script>'
);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml"
};

const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent((req.url || "/").split("?")[0]);
    if (url === "/" || url === "/harness.html") {
      res.writeHead(200, { "Content-Type": MIME[".html"] });
      res.end(pageHtml);
      return;
    }
    let body;
    if (url === "/mock-host.js") body = await readFile(fixture);
    else if (url === "/index.js") body = await readFile(path.join(uiDir, "index.js"));
    else if (url === "/detail.css") body = await readFile(path.join(uiDir, "detail.css"));
    else if (url === "/icon.svg") body = await readFile(path.join(pluginDir, "icon.svg"));
    else {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(url)] || "application/octet-stream" });
    res.end(body);
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const candidates = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe"
];
const bin = candidates.find((p) => existsSync(p));
if (!bin) {
  console.log("未找到 Chrome/Edge，跳过浏览器 UI 测试");
  server.close();
  process.exit(0);
}

const userDir = path.join(root, "test", "_chrome-profile-github-repo-downloader");
await rm(userDir, { recursive: true, force: true });
const chrome = spawn(
  bin,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDir}`,
    "--window-size=1100,760",
    "about:blank"
  ],
  { stdio: ["ignore", "ignore", "pipe"] }
);

const wsUrl = await new Promise((resolve, reject) => {
  let buffer = "";
  const timer = setTimeout(() => reject(new Error("浏览器启动超时")), 20000);
  chrome.stderr.on("data", (data) => {
    buffer += data.toString();
    const m = buffer.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (m) {
      clearTimeout(timer);
      resolve(m[1]);
    }
  });
});

const ws = new WebSocket(wsUrl);
await new Promise((resolve) => (ws.onopen = resolve));
let seq = 0;
const pending = new Map();
const pageErrors = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
  if (msg.method === "Runtime.exceptionThrown") {
    pageErrors.push(
      msg.params.exceptionDetails.exception?.description ||
        msg.params.exceptionDetails.text ||
        "unknown exception"
    );
  }
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    pageErrors.push(
      "console.error: " +
        msg.params.args.map((a) => a.value || a.description || "").join(" ")
    );
  }
};

function send(method, params = {}, sessionId) {
  return new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

const { result: targets } = await send("Target.getTargets");
const pageTarget = targets.targetInfos.find((t) => t.type === "page");
const {
  result: { sessionId }
} = await send("Target.attachToTarget", { targetId: pageTarget.targetId, flatten: true });
await send("Runtime.enable", {}, sessionId);
await send("Page.enable", {}, sessionId);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evalJs = async (expression) => {
  const res = await send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    sessionId
  );
  if (res.result?.exceptionDetails) {
    throw new Error(
      String(
        res.result.exceptionDetails.exception?.description ||
          res.result.exceptionDetails.text ||
          "eval error"
      ).slice(0, 600)
    );
  }
  return res.result?.result?.value;
};

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log("PASS ", name, extra ? ` — ${extra}` : "");
  } else {
    fail++;
    console.log("FAIL ", name, extra ? ` — ${extra}` : "");
  }
};

async function screenshot(name) {
  const res = await send("Page.captureScreenshot", { format: "png", fromSurface: true }, sessionId);
  if (res.result?.data) {
    await writeFile(path.join(outDir, name), Buffer.from(res.result.data, "base64"));
  }
}

await send("Page.navigate", { url: base + "/harness.html" }, sessionId);
await sleep(500);

/* ---------------- 清单：关闭界面即退出 ---------------- */
const manifest = JSON.parse(readFileSync(path.join(pluginDir, "plugin.json"), "utf8"));
check(
  "关闭界面即停止后台：backend.closeBehavior",
  manifest.backend?.closeBehavior === "exit",
  manifest.backend?.closeBehavior
);
check(
  "关闭界面即卸载界面：detailView.closeBehavior",
  manifest.contributes?.detailView?.closeBehavior === "exit",
  manifest.contributes?.detailView?.closeBehavior
);
check(
  "两处声明一致（无冲突告警）",
  manifest.backend?.closeBehavior === manifest.contributes?.detailView?.closeBehavior
);

/* ---------------- 首屏 ---------------- */
const intro = await evalJs(`(() => ({
  emptyVisible: !document.getElementById("gh-empty").hidden,
  listHidden: document.getElementById("gh-list").hidden,
  auth: document.getElementById("gh-auth-text").textContent,
  metaHidden: document.getElementById("gh-meta").hidden,
  downloadDisabled: document.getElementById("gh-download").disabled,
  hasJsError: false
}))()`);
check("首屏显示引导", intro.emptyVisible === true);
check("首屏列表不占位", intro.listHidden === true);
check("匿名模式提示", String(intro.auth).includes("匿名"), intro.auth);
check("首屏结果元信息隐藏", intro.metaHidden === true);
check("首屏下载按钮禁用", intro.downloadDisabled === true);

/* ---------------- 搜索 ---------------- */
await evalJs(`(() => {
  const q = document.getElementById("gh-q");
  q.value = "octocat";
  q.dispatchEvent(new Event("input", { bubbles: true }));
  document.getElementById("gh-search").click();
  return true;
})()`);
await sleep(450);

const search1 = await evalJs(`(() => ({
  cards: document.querySelectorAll(".gh-repo").length,
  meta: document.getElementById("gh-meta-count").textContent,
  rate: document.getElementById("gh-meta-rate").textContent,
  loadmore: !!document.querySelector('[data-role="loadmore"]'),
  callQ: window.__mock.searchCalls[0] && window.__mock.searchCalls[0].q,
  callPage: window.__mock.searchCalls[0] && window.__mock.searchCalls[0].page,
  emptyHidden: document.getElementById("gh-empty").hidden
}))()`);
check("搜索结果只渲染仓库卡片", search1.cards === 2, `cards=${search1.cards}`);
check("结果统计正确", String(search1.meta).includes("共 6 个仓库") && String(search1.meta).includes("已加载 2"), search1.meta);
check("显示搜索配额", String(search1.rate).includes("8/10"), search1.rate);
check("首屏引导已隐藏", search1.emptyHidden === true);
check("请求携带筛选限定词", String(search1.callQ).includes("octocat") && String(search1.callQ).includes("fork:false") && String(search1.callQ).includes("archived:false"), search1.callQ);
check("首屏请求页码为 1", search1.callPage === 1);
check("有更多结果时显示加载更多", search1.loadmore === true);
await screenshot("01-search.png");

/* ---------------- 分页加载 ---------------- */
await evalJs(`document.querySelector('[data-role="loadmore"]').click()`);
await sleep(400);
const page2 = await evalJs(`(() => ({
  cards: document.querySelectorAll(".gh-repo").length,
  meta: document.getElementById("gh-meta-count").textContent,
  loadmore: !!document.querySelector('[data-role="loadmore"]'),
  page: window.__mock.searchCalls[1] && window.__mock.searchCalls[1].page,
  selected: document.getElementById("gh-selected-count").textContent
}))()`);
check("加载更多追加结果", page2.cards === 3, `cards=${page2.cards}`);
check("第二页页码正确", page2.page === 2);
check("全部加载后隐藏加载更多", page2.loadmore === false);
check("分页后统计更新", String(page2.meta).includes("已加载 3"), page2.meta);
check("分页保留已选为空", String(page2.selected).includes("已选 0"), page2.selected);

/* ---------------- 勾选与全选 ---------------- */
await evalJs(`document.querySelector('.gh-repo input[data-role="select"]').click()`);
await sleep(100);
const selected = await evalJs(`(() => ({
  count: document.getElementById("gh-selected-count").textContent,
  disabled: document.getElementById("gh-download").disabled,
  cardSelected: document.querySelector(".gh-repo").classList.contains("is-selected"),
  selectAllIndeterminate: document.getElementById("gh-selectall").indeterminate
}))()`);
check("勾选后计数为 1", String(selected.count).includes("已选 1"), selected.count);
check("勾选后下载按钮可用", selected.disabled === false);
check("卡片展示选中态", selected.cardSelected === true);
check("部分勾选时全选为半选", selected.selectAllIndeterminate === true);
await screenshot("02-selected.png");

/* ---------------- 下载设置 ---------------- */
await evalJs(`document.getElementById("gh-download").click()`);
await sleep(120);
const dlOpen = await evalJs(`(() => ({
  visible: !document.getElementById("gh-download-modal").hidden,
  summary: document.getElementById("gh-dl-summary").textContent,
  dest: document.getElementById("gh-dest-path").textContent,
  mergePreview: document.getElementById("gh-template-preview").textContent,
  templateVisible: !document.getElementById("gh-separate-name").hidden,
  bundleHidden: document.getElementById("gh-bundle-name").hidden
}))()`);
check("下载弹窗打开", dlOpen.visible === true);
check("下载摘要包含已选数量", String(dlOpen.summary).includes("已选 1"), dlOpen.summary);
check("未选文件夹时提示", String(dlOpen.dest).includes("尚未选择"), dlOpen.dest);
check("单独压缩时显示命名规则", dlOpen.templateVisible === true && dlOpen.bundleHidden === true);
check("文件名预览可用", String(dlOpen.mergePreview).includes(".zip"), dlOpen.mergePreview);

await evalJs(`document.getElementById("gh-pick-folder").click()`);
await sleep(250);
const picked = await evalJs(`(() => ({
  dest: document.getElementById("gh-dest-path").textContent,
  empty: document.getElementById("gh-dest-path").classList.contains("is-empty"),
  calls: window.__mock.pickFolderCalls.length,
  toast: window.__mock.toasts.map(t => t.text).join(" | ")
}))()`);
check("文件夹选择回填路径", String(picked.dest).includes("Downloads"), picked.dest);
check("路径非空样式", picked.empty === false);
check("调用了宿主文件夹选择", picked.calls === 1);

await evalJs(`document.getElementById("gh-merge-one").click()`);
await sleep(80);
const merged = await evalJs(`(() => ({
  tarDisabled: document.getElementById("gh-format-tar").disabled,
  zipActive: document.getElementById("gh-format-zip").classList.contains("is-active"),
  templateHidden: document.getElementById("gh-separate-name").hidden,
  bundleVisible: !document.getElementById("gh-bundle-name").hidden,
  preview: document.getElementById("gh-template-preview").textContent
}))()`);
check("合并模式禁用 TAR.GZ", merged.tarDisabled === true);
check("合并模式强制 ZIP", merged.zipActive === true);
check("合并模式切换包名输入", merged.templateHidden === true && merged.bundleVisible === true);
check("合并模式预览包名", String(merged.preview).includes(".zip"), merged.preview);
await screenshot("03-download-setup.png");

await evalJs(`document.getElementById("gh-dl-start").click()`);
await sleep(300);
const running = await evalJs(`(() => ({
  startCalls: window.__mock.startCalls.length,
  destDir: window.__mock.startCalls[0] && window.__mock.startCalls[0].destDir,
  items: window.__mock.startCalls[0] && window.__mock.startCalls[0].items.length,
  options: window.__mock.startCalls[0] && window.__mock.startCalls[0].options,
  setupHidden: document.getElementById("gh-dl-setup").hidden,
  progressVisible: !document.getElementById("gh-dl-progress").hidden,
  percent: document.getElementById("gh-prog-percent").textContent,
  jobCalls: window.__mock.jobCalls
}))()`);
check("开始下载调用了后端", running.startCalls === 1);
check("下载目录透传正确", String(running.destDir).includes("Downloads"), running.destDir);
check("下载仓库数量正确", running.items === 1);
check("合并参数正确", running.options && running.options.merge === true && running.options.format === "zip");
check("切换到进度视图", running.setupHidden === true && running.progressVisible === true);
check("进度读取 running 快照", running.percent === "45%", running.percent);
await screenshot("04-download-running.png");

await sleep(1400);
const done = await evalJs(`(() => ({
  percent: document.getElementById("gh-prog-percent").textContent,
  title: document.getElementById("gh-dl-title").textContent,
  openVisible: !document.getElementById("gh-dl-open").hidden,
  finishVisible: !document.getElementById("gh-dl-finish").hidden,
  cancelHidden: document.getElementById("gh-dl-cancel").hidden,
  listRows: document.querySelectorAll(".gh-prog-row").length,
  toast: window.__mock.toasts.map(t => t.text).join(" | "),
  footHint: document.getElementById("gh-foot-hint").textContent
}))()`);
check("轮询后进度 100%", done.percent === "100%", done.percent);
check("完成态标题", String(done.title).includes("完成"), done.title);
check("完成态显示打开文件夹", done.openVisible === true);
check("完成态显示完成按钮", done.finishVisible === true);
check("完成态隐藏取消", done.cancelHidden === true);
check("逐仓库进度行渲染", done.listRows === 1);
check("完成通知 toast", String(done.toast).includes("已下载"), done.toast);
check("底栏保留完成入口", String(done.footHint).includes("下载完成"), done.footHint);
await screenshot("05-download-done.png");

await evalJs(`document.getElementById("gh-dl-finish").click()`);
await sleep(80);
const closed = await evalJs(`document.getElementById("gh-download-modal").hidden`);
check("完成按钮关闭弹窗", closed === true);

/* ---------------- 设置 ---------------- */
await evalJs(`document.getElementById("gh-settings").click()`);
await sleep(350);
const settings = await evalJs(`(() => ({
  visible: !document.getElementById("gh-settings-modal").hidden,
  badge: document.getElementById("gh-token-badge").textContent,
  status: document.getElementById("gh-token-status").textContent,
  apiBase: document.getElementById("gh-apibase").value,
  saveText: document.getElementById("gh-token-save").textContent
}))()`);
check("设置弹窗打开", settings.visible === true);
check("未配置 Token 提示", String(settings.badge).includes("未配置"), settings.badge);
check("API 地址回填", String(settings.apiBase).includes("api.github.com"), settings.apiBase);

await evalJs(`(() => {
  document.getElementById("gh-token").value = "ghp_mock_token_1234";
  document.getElementById("gh-token-test").click();
})()`);
await sleep(300);
const tested = await evalJs(`(() => ({
  status: document.getElementById("gh-token-status").textContent,
  cls: document.getElementById("gh-token-status").className,
  toast: window.__mock.toasts.map(t => t.text).join(" | ")
}))()`);
check("Token 测试成功", String(tested.status).includes("可用"), tested.status);
check("Token 测试显示账号", String(tested.status).includes("@mockuser"));
check("Token 状态绿色样式", String(tested.cls).includes("is-ok"));
check("Token 测试 toast", String(tested.toast).includes("验证通过"));

await evalJs(`document.getElementById("gh-token-save").click()`);
await sleep(450);
const saved = await evalJs(`(() => ({
  badge: document.getElementById("gh-token-badge").textContent,
  badgeCls: document.getElementById("gh-token-badge").className,
  status: document.getElementById("gh-token-status").textContent,
  tokenValue: document.getElementById("gh-token").value,
  clearVisible: !document.getElementById("gh-token-clear").hidden,
  auth: document.getElementById("gh-auth-text").textContent
}))()`);
check("Token 保存后徽标已配置", String(saved.badge).includes("已配置"), saved.badge);
check("Token 保存后绿色徽标", String(saved.badgeCls).includes("gh-badge-ok"));
check("Token 输入框清空", saved.tokenValue === "");
check("显示清除按钮", saved.clearVisible === true);
check("头部切换登录态", String(saved.auth).includes("@mockuser"), saved.auth);

await evalJs(`document.getElementById("gh-apibase").value = "https://api.github.com";
document.getElementById("gh-proxy").value = "http://127.0.0.1:7890";
document.getElementById("gh-network-save").click();`);
await sleep(200);
const network = await evalJs(`(() => ({
  toast: window.__mock.toasts.map(t => t.text).join(" | "),
  proxy: window.__mock.config.proxy
}))()`);
check("网络设置保存", String(network.toast).includes("网络设置已保存"));
check("代理写入配置", network.proxy === "http://127.0.0.1:7890", network.proxy);
await screenshot("06-settings.png");

await evalJs(`document.querySelector('[data-close="settings"]').click()`);
await sleep(80);
check("设置弹窗可关闭", await evalJs(`document.getElementById("gh-settings-modal").hidden`) === true);

/* ---------------- 长列表滚动 ---------------- */
await evalJs(`(() => {
  const q = document.getElementById("gh-q");
  q.value = "bulk";
  q.dispatchEvent(new Event("input", { bubbles: true }));
  document.getElementById("gh-search").click();
  return true;
})()`);
await sleep(400);
const bulk = await evalJs(`(() => {
  const app = document.getElementById("app");
  const list = document.getElementById("gh-list");
  return {
    cards: document.querySelectorAll(".gh-repo").length,
    appHeight: Math.round(app.getBoundingClientRect().height),
    listClient: list.clientHeight,
    listScroll: list.scrollHeight,
    footerVisible: document.getElementById("gh-download").getBoundingClientRect().bottom <= app.getBoundingClientRect().bottom,
    selected: document.getElementById("gh-selected-count").textContent
  };
})()`);
check("长列表渲染 40 个仓库", bulk.cards === 40, `cards=${bulk.cards}`);
check("长列表内部滚动", bulk.listScroll > bulk.listClient, `scroll=${bulk.listScroll} client=${bulk.listClient}`);
check("插件高度不超过 520", bulk.appHeight <= 522, `height=${bulk.appHeight}`);
check("底栏在可视范围内", bulk.footerVisible === true);
check("新搜索清空选择", String(bulk.selected).includes("已选 0"), bulk.selected);
await screenshot("07-bulk.png");

/* ---------------- 无 JS 异常 ---------------- */
await sleep(120);
check("页面无未捕获异常", pageErrors.length === 0, pageErrors.join(" | "));

console.log(`\n${pass} passed, ${fail} failed; screenshots: ${outDir}`);
ws.close();
chrome.kill();
server.close();
process.exit(fail ? 1 : 0);
