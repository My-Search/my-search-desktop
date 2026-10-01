/**
 * 「文件搜索」插件——**一直扫描 / 边扫边显示 / 随时停止**的回归（真实浏览器 +
 * 模拟 IPC，无 Tauri）。
 *
 * 用户诉求：
 *   1. 扫描**不设条数上限**——一直搜到用户主动点「停止」（不再有
 *      「已达 50000 项扫描上限」这类截断与文案）；
 *   2. 扫描**边扫边显示**：大目录不要「转半天白屏，最后一次性刷出来」，
 *      已经找到的条目应随着扫描推进不断出现在列表里；
 *   3. 扫描中的按钮是**红字「停止」**，点下去立即用已扫到的部分收尾。
 *
 * 钉死的契约：
 *   1. 插件调用**流式**列举（命令参数带 `onBatch` Channel）；批次到达即增量渲染；
 *   2. **最终返回之前**列表里就能看到第一批条目（真·边扫边出，不是扫完才画）；
 *   3. 扫描中按钮文字为「停止」、带 `is-stop` 类、计算颜色为红；
 *   4. 点「停止」→ 按钮回到「重新扫描」、已扫到的部分结果**仍在**、
 *      状态行含「已停止」，且调用了 `attachment_list_cancel` 让 Rust 收手；
 *   5. 页面全文不出现「扫描上限 / 50000 / 未完整列举」等截断文案。
 *
 * 用法: npm run build && node test/file-search-stream-ui.test.mjs
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
  `--user-data-dir=${path.join(root, "test", "_chrome-profile-file-search-stream")}`,
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
const check = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log("PASS ", name);
  } else {
    fail++;
    console.log("FAIL ", name, extra ? ` — ${extra}` : "");
  }
};

/* ---------------- 夹具：真实「文件搜索」插件 + 一个「扫不完」的大文件夹 ---------------- */
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

const ROOT = "C:/demo/大目录";
/**
 * 「扫不完」的目录：共 3 批。
 *   批1（2 条）→ 立刻推给前端（用来断言「最终返回前已渲染」）；
 *   批2（1 条）→ 由测试手动触发；
 *   批3（1 条）→ 由测试手动触发。
 * 假 Rust 只有在收到**批3触发**之后才 resolve 最终完整列表——在此之前，
 * 插件处于「扫描中」，正好用来观察停止按钮与增量渲染。
 */
const BATCHES = [
  [
    { path: `${ROOT}/a.txt`, name: "a.txt", relPath: "a.txt", isDir: false, size: 10, mtimeMs: 1727000000000 },
    { path: `${ROOT}/b.txt`, name: "b.txt", relPath: "b.txt", isDir: false, size: 20, mtimeMs: 1727000100000 },
  ],
  [{ path: `${ROOT}/c.log`, name: "c.log", relPath: "c.log", isDir: false, size: 30, mtimeMs: 1727000200000 }],
  [{ path: `${ROOT}/d.md`, name: "d.md", relPath: "d.md", isDir: false, size: 40, mtimeMs: 1727000300000 }],
];
const FULL = BATCHES.flat();

/* ---------------- 注入 IPC 模拟 ---------------- */
await S(
  "Page.addScriptToEvaluateOnNewDocument",
  {
    source: `
    window.__files = ${JSON.stringify(PLUGIN_FILES)};
    window.__roots = [{ path: ${JSON.stringify(ROOT)}, isDir: true }];
    window.__batches = ${JSON.stringify(BATCHES)};
    window.__full = ${JSON.stringify(FULL)};
    window.__cancelCalls = [];
    window.__listCalls = [];
    window.__channelSeq = 0;
    // 往一个 Tauri Channel 推一条消息（等价 Rust channel.send）。
    // invoke 收到的可能是 Channel 实例（同进程直传），也可能是序列化串
    // "__CHANNEL__:<id>"（真 Tauri 走 JSON.stringify），两种都认。
    window.__channelId = (token) => {
      if (token && typeof token === 'object' && token.id != null) return String(token.id);
      const s = String(token);
      return s.startsWith('__CHANNEL__:') ? s.slice('__CHANNEL__:'.length) : s;
    };
    window.__pushChannel = (token, message) => {
      const cb = (window.__cbIds || {})[window.__channelId(token)];
      if (typeof cb !== 'function') return false;
      cb({ index: window.__channelSeq++, message });
      return true;
    };
    // 测试用手动「放行」下一批：批1在 invoke 里自动推（模拟边扫边出），
    // 批2/批3 由页面外触发，最终 resolve 挂在批3之后。
    window.__pendingScan = null;
    window.__pushBatch = (i) => {
      const st = window.__pendingScan;
      if (!st) return false;
      window.__pushChannel(st.token, window.__batches[i] || []);
      return true;
    };
    window.__finishScan = () => {
      const st = window.__pendingScan;
      if (!st) return false;
      window.__pendingScan = null;
      st.resolve(window.__full.map((e) => ({ ...e })));
      return true;
    };
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
        if (cmd === 'attachments_sync') { window.__roots = args.entries || []; return Promise.resolve(null); }
        // 流式列举：模拟 Rust「批到即推、扫完才 resolve」。
        if (cmd === 'attachment_list') {
          window.__listCalls.push({ path: args.path, limit: args.limit ?? null, gen: args.gen ?? null, stream: !!args.onBatch });
          if (!args.onBatch) {
            // 旧路径（不带通道）：一次性返回
            return Promise.resolve(window.__full.map((e) => ({ ...e })));
          }
          window.__pushChannel(args.onBatch, window.__batches[0].map((e) => ({ ...e })));
          return new Promise((resolve) => {
            window.__pendingScan = { token: args.onBatch, resolve };
          });
        }
        if (cmd === 'attachment_list_cancel') { window.__cancelCalls.push(args.gen); return Promise.resolve(null); }
        if (cmd === 'attachment_file_icons') return Promise.resolve([]);
        if (cmd === 'attachment_reveal') return Promise.resolve(null);
        if (cmd === 'attachment_open') return Promise.resolve(null);
        if (cmd === 'clipboard_file_paths') return Promise.resolve(window.__roots.map((r) => r.path));
        if (cmd === 'fs_describe_paths') {
          const ps = args.paths || [];
          return Promise.resolve(ps.map((p) => ({
            path: p,
            name: String(p).split(/[\\\\/]/).filter(Boolean).pop() || p,
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

await evalJs(`
  (() => {
    localStorage.clear();
    localStorage.setItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY', JSON.stringify({ version: 1, plugins: ${JSON.stringify([RECORD])} }));
    localStorage.setItem('my-search-desktop:SEARCH_DATA_KEY', JSON.stringify({ data: [], expire: Date.now() + 3600 * 1000 }));
    return 1;
  })()`);
await S("Page.navigate", { url: base + "/index.html" }, sessionId);
await sleep(1600);

/* ================= 1. 打开插件视图，粘贴文件夹附件 ================= */
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
await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); 1`);
await sleep(600);

await evalJs(`
  (() => {
    const input = document.getElementById('my_search_input');
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'placeholder', { type: 'application/octet-stream' }));
    const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
    input.focus();
    input.dispatchEvent(ev);
  })(); 1`);
await sleep(1200);

/* ================= 2. 打开视图 → 扫描中（批1 已推，最终尚未返回） ================= */
await evalJs(`
  (() => {
    const el = document.getElementById('my_search_input');
    el.focus();
    el.value = '文件搜索 : ';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  })(); 1`);
await sleep(1500); // 批1 已到达并过了增量渲染节流

const midScan = JSON.parse(await evalJs(`JSON.stringify((() => {
  const btn = document.getElementById('fs-rescan');
  const rows = Array.from(document.querySelectorAll('.fs-row'));
  return {
    btnText: btn ? btn.textContent.trim() : null,
    btnIsStop: btn ? btn.classList.contains('is-stop') : null,
    btnColor: btn ? getComputedStyle(btn).color : null,
    rowCount: rows.length,
    rowNames: rows.map((r) => (r.querySelector('.fs-name') || {}).textContent || ''),
    status: (document.getElementById('fs-status') || {}).textContent || '',
    streamCalls: window.__listCalls.filter((c) => c.stream).length,
    footHidden: (() => { const f = document.getElementById('fs-foot'); return f ? f.hidden : null; })(),
    footVisibleHeight: (() => { const f = document.getElementById('fs-foot'); return f ? f.getBoundingClientRect().height : 0; })(),
  };
})())`));

check("调用的是流式列举（attachment_list 带 onBatch 通道）", midScan.streamCalls === 1, JSON.stringify(midScan.streamCalls));
// 红色判定不写死色值：宿主浅色 --err=#e02424、深色 #ff6b6b、插件兜底 #d32f2f 都算红
const isRed = (rgb) => {
  const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(rgb || "");
  if (!m) return false;
  const [r, g, b] = [+m[1], +m[2], +m[3]];
  return r > 150 && r > g * 1.6 && r > b * 1.6;
};
check(
  "扫描中按钮为「停止」且文字为红色（is-stop）",
  midScan.btnText === "停止" && midScan.btnIsStop === true && isRed(midScan.btnColor),
  `text=${midScan.btnText} isStop=${midScan.btnIsStop} color=${midScan.btnColor}`
);
check(
  "底部提示默认收起（不占高度，不常驻显示说明文字）",
  midScan.footHidden === true && midScan.footVisibleHeight === 0,
  `hidden=${midScan.footHidden} h=${midScan.footVisibleHeight}`
);

/* ===== 2b. 按住 Alt → 底部提示出现；松开 → 收起 ===== */
// 用 CDP 真按键（Input.dispatchKeyEvent）而不是合成 KeyboardEvent：
// 插件监听的是真实 keydown/keyup，合成事件绕不过 WebView 的输入管线，
// 用真按键才能证明「按住 Alt 才显示」在真机上也成立。
const keyPress = (type, key, code, vk, mods = 0) =>
  S("Input.dispatchKeyEvent", {
    type,
    key,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    modifiers: mods,
  }, sessionId);
await keyPress("rawKeyDown", "Alt", "AltLeft", 18);
await sleep(250);
const altDown = JSON.parse(await evalJs(`JSON.stringify((() => {
  const f = document.getElementById('fs-foot');
  return {
    hidden: f ? f.hidden : null,
    h: f ? f.getBoundingClientRect().height : 0,
    text: f ? f.textContent : '',
    listRows: document.querySelectorAll('.fs-row').length,
  };
})())`));
check(
  "按住 Alt → 底部提示出现且带操作说明",
  altDown.hidden === false && altDown.h > 0 && /点击条目/.test(altDown.text),
  `hidden=${altDown.hidden} h=${altDown.h} text=${JSON.stringify(altDown.text).slice(0, 80)}`
);
check(
  "显示提示不会重排结果列表（行数不变，仅 Alt 提示切换）",
  altDown.listRows === 2,
  `rows=${altDown.listRows}`
);

await keyPress("keyUp", "Alt", "AltLeft", 18);
await sleep(250);
const altUp = JSON.parse(await evalJs(`JSON.stringify((() => {
  const f = document.getElementById('fs-foot');
  return { hidden: f ? f.hidden : null, h: f ? f.getBoundingClientRect().height : 0 };
})())`));
check(
  "松开 Alt → 底部提示重新收起（按住显示语义）",
  altUp.hidden === true && altUp.h === 0,
  `hidden=${altUp.hidden} h=${altUp.h}`
);

// 组合键（Alt+Shift）不该弹出提示：只认「纯 Alt」
await keyPress("rawKeyDown", "Alt", "AltLeft", 18, 8 /* Shift */);
await sleep(200);
const altCombo = JSON.parse(await evalJs(`JSON.stringify((() => { const f = document.getElementById('fs-foot'); return f ? f.hidden : null; })())`));
check("Alt+Shift 等组合键不弹出提示（只认纯 Alt）", altCombo === true, `hidden=${altCombo}`);
await keyPress("keyUp", "Alt", "AltLeft", 18, 8);
await sleep(150);
check(
  "边扫边显示：最终返回之前，批1 的 2 条已渲染进列表",
  midScan.rowCount === 2 && midScan.rowNames.includes("a.txt") && midScan.rowNames.includes("b.txt"),
  `rows=${midScan.rowCount} names=${JSON.stringify(midScan.rowNames)}`
);

/* ================= 3. 再推一批 → 增量追加 ================= */
await evalJs(`window.__pushBatch(1)`);
await sleep(600);
const afterBatch2 = JSON.parse(await evalJs(`JSON.stringify((() => ({
  rowCount: document.querySelectorAll('.fs-row').length,
  names: Array.from(document.querySelectorAll('.fs-row .fs-name')).map((n) => n.textContent),
}))())`));
check(
  "推入批2 后列表增量增加到 3 条（不重排丢失前批）",
  afterBatch2.rowCount === 3 && afterBatch2.names.includes("c.log"),
  `rows=${afterBatch2.rowCount} names=${JSON.stringify(afterBatch2.names)}`
);

/* ================= 4. 点「停止」→ 保留已扫到的部分 ================= */
await evalJs(`document.getElementById('fs-rescan').click(); 1`);
await sleep(600);
const afterStop = JSON.parse(await evalJs(`JSON.stringify((() => {
  const btn = document.getElementById('fs-rescan');
  const names = Array.from(document.querySelectorAll('.fs-row .fs-name')).map((n) => n.textContent);
  return {
    btnText: btn ? btn.textContent.trim() : null,
    btnIsStop: btn ? btn.classList.contains('is-stop') : null,
    btnColor: btn ? getComputedStyle(btn).color : null,
    rowCount: names.length,
    names,
    status: (document.getElementById('fs-status') || {}).textContent || '',
    cancelCalls: window.__cancelCalls,
  };
})())`));

check("点停止后按钮回到「重新扫描」且不再红", afterStop.btnText === "重新扫描" && afterStop.btnIsStop === false, `text=${afterStop.btnText}`);
check("停止后已扫到的部分结果保留（3 条仍在）", afterStop.rowCount === 3, `rows=${afterStop.rowCount} names=${JSON.stringify(afterStop.names)}`);
check("停止后有「已停止」状态提示", afterStop.status.includes("已停止"), afterStop.status);
check("停止时通知了 Rust 取消（attachment_list_cancel 带 gen）", afterStop.cancelCalls.length === 1 && afterStop.cancelCalls[0] > 0, JSON.stringify(afterStop.cancelCalls));

/* ================= 5. 停止后迟到的批次/最终返回不得污染列表 ================= */
await evalJs(`window.__pushBatch(2); window.__finishScan(); 1`);
await sleep(600);
const afterLate = JSON.parse(await evalJs(`JSON.stringify((() => ({
  rowCount: document.querySelectorAll('.fs-row').length,
  names: Array.from(document.querySelectorAll('.fs-row .fs-name')).map((n) => n.textContent),
  meta: (document.getElementById('fs-meta') || {}).textContent || '',
}))())`));
check(
  "停止后迟到的批次与最终返回被丢弃（列表仍是 3 条）",
  afterLate.rowCount === 3 && !afterLate.names.includes("d.md"),
  `rows=${afterLate.rowCount} names=${JSON.stringify(afterLate.names)}`
);

/* ================= 6. 重扫到底：不再有 50000 上限，全量到达 ================= */
// 再点「重新扫描」发起一轮，这次把批2/3 与最终返回都放行
await evalJs(`document.getElementById('fs-rescan').click(); 1`);
await sleep(1200);
await evalJs(`window.__pushBatch(1); window.__pushBatch(2); window.__finishScan(); 1`);
await sleep(800);
const finalState = JSON.parse(await evalJs(`JSON.stringify((() => {
  const btn = document.getElementById('fs-rescan');
  return {
    rowCount: document.querySelectorAll('.fs-row').length,
    names: Array.from(document.querySelectorAll('.fs-row .fs-name')).map((n) => n.textContent),
    meta: (document.getElementById('fs-meta') || {}).textContent || '',
    status: (document.getElementById('fs-status') || {}).textContent || '',
    btnText: btn ? btn.textContent.trim() : null,
    bodyText: document.body.innerText,
    listCalls: window.__listCalls.map((c) => ({ limit: c.limit, stream: c.stream })),
  };
})())`));

check("重新扫描到结束：4 条全部显示（去重不重复）", finalState.rowCount === 4, `rows=${finalState.rowCount} names=${JSON.stringify(finalState.names)}`);
check("扫描结束后状态行不残留「已停止」", !finalState.status.includes("已停止"), finalState.status);
check("按钮回到「重新扫描」", finalState.btnText === "重新扫描", finalState.btnText);
check(
  "列举调用未传条数上限（limit 为空/0，不再有 50000/30000 截断）",
  finalState.listCalls.every((c) => c.limit == null || c.limit === 0),
  JSON.stringify(finalState.listCalls)
);
check(
  "页面不再出现「扫描上限 / 50000 / 未完整列举」等截断文案",
  !/扫描上限|50000|未完整列举/.test(finalState.bodyText),
  (finalState.bodyText.match(/.{0,20}(扫描上限|50000|未完整列举).{0,20}/) || [""])[0]
);
check("页面无未捕获异常", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 400));

console.log(`\n结果: ${pass} passed, ${fail} failed`);
ws.close();
server.close();
chrome.kill();
process.exit(fail === 0 ? 0 : 1);
