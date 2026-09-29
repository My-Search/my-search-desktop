/**
 * 「文件搜索」插件的**结果行图标**与**定位按钮**回归（真实浏览器 + 模拟 IPC，无 Tauri）。
 *
 * 用户诉求：
 *   1. 搜索结果的文件图标要**跟资源管理器一样**（.docx 显示 Word 图标、
 *      .pdf 显示 PDF 图标…），而不是一开始的内置 emoji 字形；
 *   2. 行右侧「在资源管理器中定位」按钮**不要用 emoji（📍）**，改用内联
 *      SVG（黄色文件夹），尺寸/配色可控。
 *
 * 钉死的契约：
 *   1. 插件会调 `ms.input.fileIcons([...])` 拿系统图标，且**只传已附加文件夹
 *      里列出的条目**（带 path + isDir）；
 *   2. 回包里的 data URL 渲染成 `<img class="fs-icon" src="data:...">`
 *      （不是 emoji 字形）；取不到的条目退回 emoji 字形（`glyphOf`），
 *      整行图标位不塌陷；
 *   3. 旧宿主（没有 `ms.input.fileIcons`）不报错、纯 emoji 回退（降级可用）；
 *   4. 定位按钮渲染的是**内联 SVG**（`svg.fs-locate-svg`），不再有 emoji 文本；
 *   5. 点定位按钮 → 调 `ms.input.reveal(path)`（不是 open）；点行其余区域 → `open`。
 *
 * 用法: npm run build && node test/file-search-icons-ui.test.mjs
 */
import { createServer } from "http";
import { readFile } from "fs/promises";
import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
if (!existsSync(path.join(dist, "index.html"))) {
  console.error("请先 npm run build");
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const server = createServer(async (req, res) => {
  try {
    const u = decodeURIComponent(req.url.split("?")[0]);
    const file = path.join(dist, u === "/" ? "/index.html" : u);
    if (!file.startsWith(dist)) return res.writeHead(403).end("forbidden");
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

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

const chrome = spawn(bin, [
  "--headless=new",
  "--remote-debugging-port=0",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  `--user-data-dir=${path.join(root, "test", "_chrome-profile-file-search-icons")}`,
  "about:blank",
]);
const wsUrl = await new Promise((resolve, reject) => {
  let buf = "";
  chrome.stderr.on("data", (d) => {
    buf += d.toString();
    const m = buf.match(/ws:\/\/[^\s]+/);
    if (m) resolve(m[0]);
  });
  setTimeout(() => reject(new Error("等待 DevTools 超时")), 20000);
});
const ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));
let msgId = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const S = (method, params = {}, sessionId) =>
  new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

const { result: targets } = await S("Target.getTargets");
const page = targets.targetInfos.find((t) => t.type === "page");
const { result: attach } = await S("Target.attachToTarget", { targetId: page.targetId, flatten: true });
const sessionId = attach.sessionId;
await S("Page.enable", {}, sessionId);
await S("Runtime.enable", {}, sessionId);

const pageErrors = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.exceptionThrown") {
    pageErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || "?");
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evalJs = async (expr) => {
  const r = await S(
    "Runtime.evaluate",
    { expression: expr, awaitPromise: true, returnByValue: true },
    sessionId
  );
  if (r.result?.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description || "eval error");
  }
  return r.result?.result?.value;
};

let pass = 0;
let fail = 0;
// 与 plugin-view-height-ui.test.mjs 同款约定：check(名称, 断言, 附加说明)
const check = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log("PASS ", name);
  } else {
    fail++;
    console.log("FAIL ", name, extra ? ` — ${extra}` : "");
  }
};

/* ---------------- 夹具：真实「文件搜索」插件 + 两个假文件夹与文件 ---------------- */
const PLUGIN_ID = "com.mysearch.file-search";
const PLUGIN_DIR = path.join(root, "plugins", "file-search");
const manifest = JSON.parse(readFileSync(path.join(PLUGIN_DIR, "plugin.json"), "utf8"));
const PLUGIN_FILES = {
  [PLUGIN_ID]: {
    "ui/detail.html": readFileSync(path.join(PLUGIN_DIR, "ui", "detail.html"), "utf8"),
    "ui/detail.css": readFileSync(path.join(PLUGIN_DIR, "ui", "detail.css"), "utf8"),
    "ui/index.js": readFileSync(path.join(PLUGIN_DIR, "ui", "index.js"), "utf8"),
    "icon.svg": readFileSync(path.join(PLUGIN_DIR, "icon.svg"), "utf8"),
  },
};
const now = Date.now();
const RECORD = {
  id: PLUGIN_ID,
  name: manifest.name,
  version: manifest.version,
  apiVersion: manifest.apiVersion,
  description: manifest.description,
  manifest,
  dir: `plugins/${PLUGIN_ID}`,
  source: { kind: "builtin", ref: "builtin" },
  installedAt: now,
  updatedAt: now,
  enabled: true,
  autoStart: "on-demand",
  requestedAutoStart: "on-demand",
  closeBehavior: manifest.contributes.detailView.closeBehavior,
  grants: [
    { permission: "ui.inlay", at: now, source: "install" },
    { permission: "file.read", at: now, source: "install" },
  ],
  denied: [],
  runtime: { status: "stopped", pid: null, memoryBytes: null, startedAt: null, restarts: 0, lastError: null, keepAliveReasons: [] },
  integrity: { sha256: null, signed: false },
};

/** 两个附加文件夹 + 里面的条目（覆盖：能取到图标 / 取不到图标两类） */
const ROOTS = [
  { path: "C:/demo/项目A", isDir: true },
  { path: "C:/demo/资料", isDir: true },
];
const FILE_TREE = {
  "C:/demo/项目A": [
    { path: "C:/demo/项目A/报告.docx", name: "报告.docx", relPath: "报告.docx", isDir: false, size: 20480, mtimeMs: 1727000000000 },
    { path: "C:/demo/项目A/演示.pptx", name: "演示.pptx", relPath: "演示.pptx", isDir: false, size: 512000, mtimeMs: 1727000100000 },
  ],
  "C:/demo/资料": [
    { path: "C:/demo/资料/手册.pdf", name: "手册.pdf", relPath: "手册.pdf", isDir: false, size: 1024, mtimeMs: 1727000200000 },
    { path: "C:/demo/资料/说明.txt", name: "说明.txt", relPath: "说明.txt", isDir: false, size: 64, mtimeMs: 1727000300000 },
  ],
};
/** fileIcons 假回包：只给「报告.docx / 手册.pdf」两个图标（说明.txt 缺席 = 取不到） */
const ICON_REPLY = {
  "C:/demo/项目A/报告.docx": "data:image/png;base64,AAABAAEA-report-icon",
  "C:/demo/资料/手册.pdf": "data:image/png;base64,AAABAAEA-pdf-icon",
};

/* ---------------- 注入 IPC 模拟 ---------------- */
await S(
  "Page.addScriptToEvaluateOnNewDocument",
  {
    source: `
    window.__files = ${JSON.stringify(PLUGIN_FILES)};
    window.__roots = ${JSON.stringify(ROOTS)};
    window.__tree = ${JSON.stringify(FILE_TREE)};
    window.__iconReply = ${JSON.stringify(ICON_REPLY)};
    window.__iconCalls = [];
    window.__revealCalls = [];
    window.__openCalls = [];
    window.__noIconApi = ${JSON.stringify(process.env.NO_ICON_API === "1")};
    window.__TAURI_INTERNALS__ = {
      invoke(cmd, args) {
        if (cmd === 'set_window_height') return Promise.resolve(null);
        if (cmd === 'plugin_read_text') {
          const f = window.__files[args.pluginId] || {};
          const t = f[args.relPath];
          return t == null ? Promise.reject('文件不存在: ' + args.relPath) : Promise.resolve(t);
        }
        if (cmd === 'plugin_read_binary') return Promise.reject('无图标');
        if (cmd === 'plugin_backend_list') return Promise.resolve([]);
        if (cmd === 'get_default_subscribe_text') return Promise.resolve('');
        if (cmd === 'get_toggle_shortcut') return Promise.resolve('ctrl+alt+s');
        if (cmd === 'get_autostart_enabled') return Promise.resolve(false);
        // 附件集合 / 列举：返回夹具（与真实 Rust attachment_list 同形状）
        if (cmd === 'attachments_sync') { window.__roots = args.entries || []; return Promise.resolve(null); }
        if (cmd === 'attachment_list') {
          const list = window.__tree[args.path] || [];
          return Promise.resolve(list.map((e) => ({ ...e })));
        }
        if (cmd === 'attachment_list_cancel') return Promise.resolve(null);
        // 系统文件图标：记录调用，回假图标（欠缺的路径不回 = 取不到）
        if (cmd === 'attachment_file_icons') {
          const entries = args.entries || [];
          window.__iconCalls.push({ entries: entries.map((e) => ({ ...e })), pluginId: args.pluginId ?? null });
          const out = [];
          for (const e of entries) {
            const icon = window.__iconReply[e.path];
            if (icon) out.push({ path: e.path, icon });
          }
          return Promise.resolve(out);
        }
        if (cmd === 'attachment_reveal') { window.__revealCalls.push(args.path); return Promise.resolve(null); }
        if (cmd === 'attachment_open') { window.__openCalls.push(args.path); return Promise.resolve(null); }
        // 剪贴板里的文件夹路径（粘贴走这条路拿真实路径）
        if (cmd === 'clipboard_file_paths') return Promise.resolve(window.__roots.map((r) => r.path));
        // 路径 → {名称, 是否文件夹}
        if (cmd === 'fs_describe_paths') {
          const ps = args.paths || [];
          return Promise.resolve(ps.map((p) => ({
            path: p,
            name: String(p).split(/[\\/]/).filter(Boolean).pop() || p,
            isDir: (window.__roots.find((r) => r.path === p) || {}).isDir === true,
          })));
        }
        if (cmd === 'plugin:event|listen' && args && args.event) {
          const list = window.__eventHandlers.get(args.event) || [];
          list.push(args.handler);
          window.__eventHandlers.set(args.event, list);
          return Promise.resolve(window.__eventNextId++);
        }
        return Promise.resolve(null);
      },
      transformCallback(cb) { const cbId = Math.random().toString(36).slice(2); window.__cbIds = window.__cbIds || {}; window.__cbIds[cbId] = cb; return cbId; },
      unregisterCallback(cbId) { delete (window.__cbIds || {})[cbId]; },
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      plugins: {},
    };
    window.__eventHandlers = new Map();
    window.__eventNextId = 1;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(){} };
    window.__emitTauriEvent = () => 0;
  `,
  },
  sessionId
);

await S("Page.navigate", { url: base + "/index.html" }, sessionId);
await sleep(600);

// 登记附件（搜索框附加集合）+ 插件注册表
await evalJs(`
  (() => {
    localStorage.clear();
    localStorage.setItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY', JSON.stringify({ version: 1, plugins: ${JSON.stringify([RECORD])} }));
    localStorage.setItem('my-search-desktop:SEARCH_DATA_KEY', JSON.stringify({ data: [], expire: Date.now() + 3600 * 1000 }));
    return 1;
  })()`);
await S("Page.navigate", { url: base + "/index.html" }, sessionId);
await sleep(1600);

/* ================= 1. 打开插件视图并加两个文件夹附件 ================= */
await evalJs(`
  (() => {
    const el = document.getElementById('my_search_input');
    el.focus(); el.value = '文件搜索';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })(); 1`);
await sleep(700);
await evalJs(`
  (() => {
    const el = document.getElementById('my_search_input');
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  })(); 1`);
await sleep(1200);

const opened = await evalJs(`!!document.querySelector('#text_show .plugin-view')`);
check("插件视图已打开", opened === true, `opened=${opened}`);

/* ================= 2. 关闭插件视图，粘贴两个文件夹进搜索框，再打开 ================= */
// 先把插件视图关掉（Esc 即 exit 关闭），回到搜索态才能往输入框粘贴
await evalJs(`
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  1`);
await sleep(600);

// 构造一个「粘贴了文件夹」的事件：clipboardData.types 含 'Files'，files 非空
await evalJs(`
  (() => {
    const input = document.getElementById('my_search_input');
    const dt = new DataTransfer();
    // 伪造一个文件项，让 hasFileData 判定为真（真实路径由 clipboard_file_paths 提供）
    dt.items.add(new File(['x'], 'placeholder', { type: 'application/octet-stream' }));
    const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
    input.focus();
    input.dispatchEvent(ev);
  })(); 1`);
await sleep(1200);

const attached = JSON.parse(await evalJs(`JSON.stringify((() => {
  // 附件 chip 出现 = 附件状态已建立（走的是 App.vue applyAttachments 真实管线）
  const chips = Array.from(document.querySelectorAll('#my_search_box .attach-chip, #my_search_box .chip, #my_search_box [class*="chip"]'))
    .map((el) => el.textContent.trim()).filter(Boolean);
  return { chips, syncCalls: window.__iconCalls.length };
})())`));
check("粘贴文件夹后输入框出现附件 chip", attached.chips.length >= 2, `chips=${JSON.stringify(attached.chips)}`);

/* ================= 3. 重新打开插件视图 → 应扫描并渲染结果行 ================= */
await evalJs(`
  (() => {
    const el = document.getElementById('my_search_input');
    el.focus();
    el.value = '文件搜索 : ';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  })(); 1`);
await sleep(2000);

const rows = JSON.parse(await evalJs(`JSON.stringify((() => {
  const list = document.getElementById('fs-list');
  const rowEls = Array.from(document.querySelectorAll('.fs-row'));
  return {
    count: rowEls.length,
    names: rowEls.map((r) => (r.querySelector('.fs-name') || {}).textContent || ''),
    hasImg: rowEls.map((r) => !!r.querySelector('.fs-icon-box img.fs-icon')),
    imgSrcs: rowEls.map((r) => { const i = r.querySelector('.fs-icon-box img.fs-icon'); return i ? i.getAttribute('src') : null; }),
    fallbackGlyph: rowEls.map((r) => { const g = r.querySelector('.fs-icon-box .fs-glyph-text'); return g ? g.textContent : null; }),
    locateSvg: rowEls.map((r) => !!r.querySelector('button.fs-locate svg.fs-locate-svg')),
    locateText: rowEls.map((r) => { const b = r.querySelector('button.fs-locate'); return b ? b.textContent.trim() : null; }),
    listHidden: list ? list.hidden : null,
  };
})())`));

check("结果行已渲染（4 个文件）", rows.count === 4, `count=${rows.count} names=${JSON.stringify(rows.names)}`);

/* ================= 4. 系统图标（资源管理器同款） ================= */
const iconCalls = JSON.parse(await evalJs(`JSON.stringify(window.__iconCalls)`));
check(
  "插件调用了 ms.input.fileIcons（批量取系统图标）",
  iconCalls.length >= 1,
  `calls=${iconCalls.length}`
);
// 注意：宿主自己的搜索框 chips 也会调同一个命令（无 pluginId、条目是文件夹根），
// 所以要按**插件身份**挑出插件那一次，不能拿 iconCalls[0] 断言。
const pluginIconCalls = iconCalls.filter((c) => c.pluginId === PLUGIN_ID);
check(
  "fileIcons 带插件身份（pluginId）以走严格校验",
  pluginIconCalls.length >= 1,
  `pluginIds=${JSON.stringify(iconCalls.map((c) => c.pluginId))}`
);
check(
  "fileIcons 只传已附加文件夹里列出的文件条目（含 path + isDir，不含文件夹根）",
  pluginIconCalls.length >= 1 &&
    pluginIconCalls[0].entries.length === 4 &&
    pluginIconCalls[0].entries.every(
      (e) => typeof e.path === "string" && e.path.startsWith("C:/demo/") && typeof e.isDir === "boolean" && e.isDir === false
    ),
  JSON.stringify(pluginIconCalls[0]?.entries?.map((e) => e.path))
);

check(
  "取到图标的行渲染 <img class=fs-icon src=data:...>（不是 emoji）",
  rows.hasImg.filter(Boolean).length === 2 &&
    rows.imgSrcs.filter((s) => s && s.startsWith("data:image/")).length === 2,
  `hasImg=${JSON.stringify(rows.hasImg)} srcs=${JSON.stringify(rows.imgSrcs)}`
);
check(
  "取不到图标的行退回 emoji 字形（说明.txt 无图标，回退不塌陷）",
  rows.fallbackGlyph.filter(Boolean).length === 2,
  `glyphs=${JSON.stringify(rows.fallbackGlyph)}`
);

/* ================= 5. 定位按钮：内联 SVG，不是 emoji ================= */
check(
  "定位按钮渲染内联 SVG（svg.fs-locate-svg）",
  rows.locateSvg.length === 4 && rows.locateSvg.every(Boolean),
  `svg=${JSON.stringify(rows.locateSvg)}`
);
check(
  "定位按钮内不再有 emoji 文本（📍）",
  rows.locateText.every((t) => t === "" || t === null) &&
    !rows.locateText.some((t) => t && t.includes("📍")),
  JSON.stringify(rows.locateText)
);
check(
  "SVG 是黄色文件夹（含 #EFB81B / #FFD55F 两个填充）",
  (await evalJs(`(() => {
    const svg = document.querySelector('.fs-row button.fs-locate svg.fs-locate-svg');
    if (!svg) return false;
    const html = svg.innerHTML;
    return html.includes('#EFB81B') && html.includes('#FFD55F');
  })()`)) === true
);

/* ================= 6. 点定位 → reveal；点行 → open ================= */
// 行按修改时间从新到旧排序，先取第一行的真实路径，断言与调用一致（不写死文件名）
const firstRowPath = String(await evalJs(`(() => {
  const row = document.querySelector('.fs-row');
  return row ? row.getAttribute('data-path') : '';
})()`));
await evalJs(`(() => {
  const btn = document.querySelector('.fs-row button.fs-locate');
  btn.click();
})(); 1`);
await sleep(500);
const revealCalls = JSON.parse(await evalJs(`JSON.stringify(window.__revealCalls)`));
check(
  "点定位按钮 → 调 ms.input.reveal(该行路径)",
  revealCalls.length === 1 && revealCalls[0] === firstRowPath,
  `path=${firstRowPath} reveal=${JSON.stringify(revealCalls)}`
);

await evalJs(`(() => {
  const name = document.querySelector('.fs-row .fs-name');
  name.click();
})(); 1`);
await sleep(500);
const openCalls = JSON.parse(await evalJs(`JSON.stringify(window.__openCalls)`));
check(
  "点行其余区域 → 调 ms.input.open(同一行路径)",
  openCalls.length === 1 && openCalls[0] === firstRowPath,
  `path=${firstRowPath} open=${JSON.stringify(openCalls)}`
);

check("页面无未捕获异常", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 400));

console.log(`\n结果: ${pass} passed, ${fail} failed`);
ws.close();
server.close();
chrome.kill();
process.exit(fail === 0 ? 0 : 1);
