/**
 * 设置窗口「备份与同步」面板：真实浏览器布局验证（CDP + Chrome headless）。
 *
 * 用法：npm run build && node test/sync-panel-ui.test.mjs
 * 产出：test/_shot-sync-panel-<theme>.png（亮暗两套，供人工核对）
 *
 * 覆盖的用户反馈：
 * 1. 「保存到…」按钮前的上传图标多余 → 按钮内不应再有 <svg>
 * 2. 三个导出按钮竖排换行 → 必须并排同一行（top 相同），窄窗口（600px）也不换行
 * 3. WebDAV 输入框是浏览器原生控件（系统灰底/方形）→ 必须走主题样式：
 *    圆角、主题描边、与卡片内容等宽对齐；select 去掉原生箭头
 * 4. 面板里引用了未定义/写错的类名与 CSS 变量（btn-primary / --bg-secondary /
 *    --error）→ 会在下面通过计算样式断言回归
 *
 * 需要本机装有 Chrome / Edge；找不到浏览器时跳过（退出码 0）。
 */
import { createServer } from "http";
import { readFile, rm, writeFile } from "fs/promises";
import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
if (!existsSync(path.join(dist, "config.html"))) {
  console.error("请先 npm run build");
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
};
const server = createServer(async (req, res) => {
  try {
    const u = decodeURIComponent(req.url.split("?")[0]);
    const file = path.join(dist, u === "/" ? "/config.html" : u);
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

const userDir = path.join(root, "test", "_chrome-profile-shot-sync");
await rm(userDir, { recursive: true, force: true });
const chrome = spawn(
  bin,
  ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
   "--remote-debugging-port=0", `--user-data-dir=${userDir}`, "--window-size=880,600", "about:blank"],
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
const S = (method, params = {}, sessionId) =>
  new Promise((resolve) => { const mid = ++id; pending.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params, sessionId })); });

const { result: targets } = await S("Target.getTargets");
const pageTarget = targets.targetInfos.find((t) => t.type === "page");
const { result: { sessionId } } = await S("Target.attachToTarget", { targetId: pageTarget.targetId, flatten: true });
await S("Runtime.enable", {}, sessionId);
await S("Page.enable", {}, sessionId);
const evalJs = async (expr) => {
  const r = await S("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("PASS ", name, extra ? `— ${extra}` : ""); }
  else { fail++; console.log("FAIL ", name, extra ? `— ${extra}` : ""); }
};

await S("Page.addScriptToEvaluateOnNewDocument", {
  source: `
    const STUB_TIME = Date.now();
    const STUB_META = { exists: true, rev: 'stub-rev', etag: '"stub-rev"', modified: STUB_TIME, size: 1572864 }; // 1.5 MB
    const STUB_V3_MANIFEST = {
      schema: 'ms.cloud/3',
      rev: 7,
      updatedAt: STUB_TIME,
      updatedBy: 'stub-device',
      appVersion: '7.9.40',
      devices: { 'stub-device': { name: '测试机', appVersion: '7.9.40', lastSyncAt: STUB_TIME } },
      legacyV2: { rev: 3, etag: '"m"', updatedAt: STUB_TIME, migratedAt: STUB_TIME },
      core: { digest: 'c3', bytes: 4096, updatedAt: STUB_TIME },
      plugins: {
        demo: {
          body: { digest: 'b1', bytes: 1024, updatedAt: STUB_TIME },
          state: {},
          files: {
            'clipboard/items/a.json': { digest: 'fa', bytes: 512, updatedAt: STUB_TIME },
            'kv/annotations.json': { digest: 'fk', bytes: 78, updatedAt: STUB_TIME },
          },
          blobs: {
            'clipboard/a.png': { digest: 'bl1', bytes: 2048, updatedAt: STUB_TIME },
            'clipboard/b.png': { digest: 'bl2', bytes: 4096, updatedAt: STUB_TIME },
          },
        },
        'com.zhuanjie.resource-monitor': {
          body: { digest: 'b2', bytes: 40960, updatedAt: STUB_TIME },
          state: {},
          files: {
            'kv/state.json': { digest: 'f1', bytes: 100, updatedAt: STUB_TIME },
            'kv/rules.json': { digest: 'f2', bytes: 200, updatedAt: STUB_TIME },
            'sync/state.json': { digest: 'f3', bytes: 300, updatedAt: STUB_TIME },
          },
          blobs: {},
        },
      },
    };
    const STUB_STATE = {
      deviceId: 'stub-device', target: 'stub-target', initialized: true,
      remoteRev: 'stub-rev', remoteEtag: '"stub-rev"',
      lastLocalDigest: 'd-stub', lastSyncAt: STUB_TIME, appliedRev: 'stub-rev', epoch: 1,
    };
    // 带遗留冲突的状态（?conflict=1 时用）：只挂起这几片，其余插件早已同步完成
    const STUB_CONFLICT_STATE = Object.assign({}, STUB_STATE, {
      conflicts: [
        { pluginId: 'demo', kind: 'body', localBytes: 1024, remoteBytes: 2048, remoteUpdatedAt: STUB_TIME },
        { pluginId: 'demo', kind: 'data', localBytes: 8192, remoteBytes: 4096, remoteUpdatedAt: STUB_TIME },
        { pluginId: 'com.zhuanjie.resource-monitor', kind: 'data', localBytes: 512, remoteBytes: 640, remoteUpdatedAt: STUB_TIME },
      ],
    });
    window.__TAURI_INTERNALS__ = {
      invoke(cmd, args) {
        if (cmd === 'sync_get_config') return Promise.resolve({
          enabled: true, webdavUrl: 'https://dav.jianguoyun.com/dav/', webdavUser: '',
          remoteFile: 'my-search-backup.msbackup', conflict: 'newer',
          autoOnChange: true, intervalMinutes: 30, hasPassword: false,
        });
        if (cmd === 'sync_set_config') return Promise.resolve({
          enabled: true, webdavUrl: 'https://dav.jianguoyun.com/dav/', webdavUser: '',
          remoteFile: 'my-search-backup.msbackup', conflict: 'newer',
          autoOnChange: true, intervalMinutes: 30, hasPassword: false,
        });
        if (cmd === 'sync_remote_meta') return Promise.resolve(STUB_META);
        // ?v3=1 时切到 v3 文件级视图；其余（含 v2 回归）明确不存在，面板应回退 v2
        if (cmd === 'cloud_manifest_v3_get') return Promise.resolve(location.search.includes('v3')
          ? { exists: true, etag: '"v3"', rev: '7', size: 1000, modified: STUB_TIME, manifest: STUB_V3_MANIFEST }
          : { exists: false, manifest: null });
        // v2 云端对象卡（面板「云端对象」卡片）
        if (cmd === 'cloud_manifest_get') return Promise.resolve({
          exists: true, etag: '"m"', rev: '3', size: 900, modified: STUB_TIME,
          manifest: {
            schema: 'ms.cloud/2', rev: 3, updatedAt: STUB_TIME, updatedBy: 'stub', appVersion: '7.9.40',
            core: { digest: 'c1', bytes: 4096, updatedAt: STUB_TIME },
            plugins: {
              demo: {
                body: { digest: 'b1', bytes: 1024, updatedAt: STUB_TIME },
                data: { digest: 'd1', bytes: 2048, updatedAt: STUB_TIME },
              },
              'com.zhuanjie.resource-monitor': {
                body: { digest: 'b2', bytes: 40960, updatedAt: STUB_TIME },
                data: { digest: 'd2', bytes: 8192, updatedAt: STUB_TIME },
              },
            },
          },
        });
        if (cmd === 'cloud_quota') return Promise.resolve({ pluginBytes: 209715200, shardBytes: 209715200 });
        if (cmd === 'cloud_shard_inspect') return Promise.resolve({
          rel: args?.rel ?? 'stub', bytes: 1024, totalBytes: 2,
          entries: [
            { name: 'plugins/demo/index.js', size: 1 },
            { name: 'kv/demo/state.json', size: 1 },
          ],
          truncated: false,
        });
        // 面板已是纯 UI：只发请求、读持久化状态；执行同步的是常驻主窗口。
        if (cmd === 'sync_state_get') return Promise.resolve(location.search.includes('conflict') ? STUB_CONFLICT_STATE : STUB_STATE);
        if (cmd === 'sync_state_patch') return Promise.resolve({ ...STUB_STATE, ...(args?.patch || {}) });
        if (cmd === 'sync_state_reset') return Promise.resolve({ ...STUB_STATE, initialized: false });
        if (cmd === 'sync_request') return Promise.resolve({ accepted: true, trigger: args?.trigger ?? 'manual' });
        if (cmd === 'sync_resolve_choice') return Promise.resolve({ choice: args?.choice });
        if (cmd === 'sync_commit_applied') return Promise.resolve({ epoch: 1, source: args?.source ?? 'import', scope: args?.scope ?? 'all' });
        if (cmd === 'sync_download') return Promise.resolve({
          path: 'stub-download.msbackup', size: 1572864, rev: 'stub-rev',
          etag: '"stub-rev"', modified: STUB_TIME, notModified: false,
        });
        if (cmd === 'sync_upload') return Promise.resolve(STUB_META);
        if (cmd === 'backup_snapshot') return Promise.resolve('stub-snapshot.msbackup');
        if (cmd === 'backup_restore') return Promise.resolve({
          snapshotPath: 'stub-download.msbackup', localStorageKeys: 0, plugins: 0,
          pluginData: 0, settings: false, scope: 'all', localStorage: {}, manifest: {},
        });
        if (cmd === 'get_shortcut_bindings') return Promise.resolve([{ shortcut: 'ctrl+alt+s', action: 'toggle-window', target: null }]);
        if (cmd === 'get_default_subscribe_text') return Promise.resolve('');
        return Promise.resolve(null);
      },
      transformCallback(cb) { return cb; },
      metadata: { currentWindow: { label: 'config' }, currentWebview: { label: 'config' } },
      plugins: {},
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(){} };
  `,
}, sessionId);

for (const theme of ["dark", "light"]) {
  await S("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: theme }],
  }, sessionId);
  await S("Page.navigate", { url: base + "/config.html" }, sessionId);
  await sleep(1500);
  // 插件注册表缓存（面板据此把插件 id 显示成名字）：含一个超长 id 用于验证截断
  await evalJs(`localStorage.setItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY', JSON.stringify({
    version: 1,
    plugins: [
      { id: 'demo', name: '剪贴板', manifest: {} },
      { id: 'com.zhuanjie.resource-monitor', name: '资源监视器', manifest: {} },
    ],
  }))`);
  await evalJs(`document.querySelector('.cfg-nav .nav-item[data-pane="sync"]').click()`);
  await sleep(900);

  const geo = await evalJs(`(() => {
    const pane = document.querySelector('.page.sync .sync-tab-pane');
    const btns = [...pane.querySelectorAll('.sync-actions-row .cfg-btn')];
    const rows = [...document.querySelectorAll('.page.sync .cfg-row')];
    const inputs = rows.map(r => {
      const el = r.querySelector('.cfg-input, .cfg-select');
      if (!el) return null;
      const b = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { tag: el.tagName, w: Math.round(b.width), h: Math.round(b.height),
               x: Math.round(b.x), radius: cs.borderRadius, bg: cs.backgroundColor,
               border: cs.borderTopColor, appearance: cs.appearance,
               fontFamily: cs.fontFamily, fontSize: cs.fontSize };
    });
    const primary = pane.querySelector('.sync-actions-row .cfg-btn.primary');
    const card = document.querySelector('.page.sync .cfg-card:not(.sync-tab-pane)');
    const cr = card.getBoundingClientRect();
    const cs = getComputedStyle(card);
    const body = document.querySelector('.cfg-body');
    return {
      btnTops: btns.map(b => Math.round(b.getBoundingClientRect().top)),
      btnRects: btns.map(b => { const r = b.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width) }; }),
      firstBtnHasSvg: !!btns[0]?.querySelector('svg'),
      primaryBg: primary ? getComputedStyle(primary).backgroundColor : null,
      inputs,
      // 卡片内容右边缘 = 卡片右边 - 边框 - 内边距，输入框右边缘应与它重合
      cardContentRight: Math.round(cr.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight)),
      hOverflow: body.scrollWidth > body.clientWidth,
      docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  })()`);

  const sameRow = new Set(geo.btnTops).size === 1;
  check(`[${theme}] 三个导出按钮同一行`, sameRow, `tops=${JSON.stringify(geo.btnTops)}`);
  check(`[${theme}] 三个导出按钮都渲染`, geo.btnTops.length === 3, `n=${geo.btnTops.length}`);
  check(`[${theme}] 「保存到…」前无图标`, geo.firstBtnHasSvg === false);
  check(`[${theme}] 「保存到…」仍是主按钮（品牌色底）`, geo.primaryBg !== null && geo.primaryBg !== 'rgba(0, 0, 0, 0)', `bg=${geo.primaryBg}`);
  const filled = geo.inputs.filter(Boolean);
  check(`[${theme}] 6 个输入控件都渲染（4 input + 2 select）`, filled.length === 6, JSON.stringify(geo.inputs.map(i => i && i.tag)));
  check(`[${theme}] 输入框左边缘对齐`, new Set(filled.map(i => i.x)).size === 1, `x=${filled.map(i => i.x)}`);
  // 前 5 个（4 个文本框 + 冲突策略）占满整行；最后一个「兜底间隔」按设计收窄
  const wide = filled.slice(0, 5), narrow = filled[5];
  check(`[${theme}] 文本框与冲突策略宽度一致且占满整行`, new Set(wide.map(i => i.w)).size === 1, `w=${wide.map(i => i.w)}`);
  check(`[${theme}] 输入框右边缘与卡片内容右边缘对齐`, new Set(wide.map(i => i.x + i.w)).size === 1 && wide[0].x + wide[0].w === geo.cardContentRight, `right=${wide.map(i => i.x + i.w)} cardContentRight=${geo.cardContentRight}`);
  check(`[${theme}] 「兜底间隔」按设计收窄`, narrow.w === 130, `w=${narrow.w}`);
  check(`[${theme}] 输入框有圆角（非原生方形）`, filled.every(i => parseFloat(i.radius) >= 6), filled.map(i => i.radius).join());
  check(`[${theme}] select 去掉原生箭头`, filled.filter(i => i.tag === 'SELECT').every(i => i.appearance === 'none'), filled.map(i => i.appearance).join());
  check(`[${theme}] 输入框背景走主题（非系统默认灰）`, filled.every(i => i.bg !== 'rgb(59, 59, 59)' && i.bg !== 'rgb(255, 255, 255)'), filled.map(i => i.bg).join());
  check(`[${theme}] 输入框继承面板字体字号`, filled.every(i => i.fontSize === '13px' && i.fontFamily.includes('"PingFang SC"')), filled.map(i => i.fontFamily).join(' | ').slice(0, 120));
  check(`[${theme}] 无横向溢出（按钮行不撑破卡片）`, !geo.hOverflow && !geo.docOverflow, `body=${geo.hOverflow} doc=${geo.docOverflow}`);

  // 云端备份大小：面板加载时会 HEAD 一次远端，开关行下方应显示格式化后的大小
  const sizeLine = await evalJs(`(() => {
    const el = document.querySelector('.page.sync .sync-remote-size');
    return el ? el.textContent.trim() : null;
  })()`);
  check(`[${theme}] 显示云端备份大小`, sizeLine === '云端备份：1.5 MB', `got=${sizeLine}`);

  /* ---- 云端对象卡片：位置 / 插件名 + id / 查看内容 ---- */
  const shardCard = await evalJs(`(() => {
    const cards = [...document.querySelectorAll('.page.sync .cfg-card')];
    const idx = cards.findIndex(c => (c.querySelector('h3')?.textContent || '').trim() === '云端对象');
    const card = cards[idx];
    if (!card) return { found: false };
    const rows = [...card.querySelectorAll('.sync-cloud-row:not(.sync-cloud-head)')];
    const first = rows[0];
    const all = rows.map(r => {
      const nameEl = r.querySelector('.sync-cloud-name');
      const pidEl = r.querySelector('.sync-cloud-pid');
      const cell = r.querySelector('.sync-cloud-id');
      return {
        name: nameEl?.textContent?.trim() ?? null,
        pid: pidEl?.textContent?.trim() ?? null,
        nameClipped: nameEl ? nameEl.scrollWidth > nameEl.clientWidth + 1 : null,
        cellW: cell ? Math.round(cell.getBoundingClientRect().width) : 0,
        pidClipped: pidEl ? pidEl.scrollWidth > pidEl.clientWidth + 1 : null,
      };
    });
    return {
      found: true, idx, total: cards.length,
      inExportPane: !!card.closest('.sync-tab-pane'),
      top: Math.round(card.getBoundingClientRect().top),
      rowTop: first ? Math.round(first.getBoundingClientRect().top) : -1,
      nameText: all[0]?.name ?? null,
      pidText: all[0]?.pid ?? null,
      rows: all,
      hasOpenBtn: !!first?.querySelector('.sync-cloud-actions .cfg-btn'),
    };
  })()`);
  check(`[${theme}] 云端对象卡片渲染`, shardCard.found === true, JSON.stringify(shardCard));
  check(`[${theme}] 云端对象不在导出 tab 内（常显）`, shardCard.inExportPane === false);
  check(`[${theme}] 云端对象在 WebDAV 卡片之后`, shardCard.idx === shardCard.total - 1, `idx=${shardCard.idx}/${shardCard.total}`);
  const demoRow = shardCard.rows?.find((r) => r.pid === 'demo');
  check(`[${theme}] 主显插件名、灰字附 id`, demoRow?.name === '剪贴板' && demoRow?.pid === 'demo', `name=${demoRow?.name} pid=${demoRow?.pid}`);
  check(`[${theme}] 两行插件都渲染（含超长 id）`, shardCard.rows?.length === 2, JSON.stringify(shardCard.rows));
  check(
    `[${theme}] 名字不被 id 挤掉（未被截断）`,
    shardCard.rows?.[0]?.nameClipped === false && shardCard.rows?.[1]?.nameClipped === false,
    JSON.stringify(shardCard.rows?.map(r => r.nameClipped))
  );
  check(
    `[${theme}] 超长 id 不被新列宽挤压`,
    shardCard.rows?.every(r => r.pidClipped === false),
    JSON.stringify(shardCard.rows?.map(r => r.pidClipped))
  );
  check(
    `[${theme}] 插件列保有可用宽度`,
    (shardCard.rows?.[0]?.cellW ?? 0) >= 100 &&
      (shardCard.rows?.[1]?.cellW ?? 0) >= 100,
    JSON.stringify(shardCard.rows?.map(r => r.cellW))
  );
  check(`[${theme}] 每行有「查看内容」按钮`, shardCard.hasOpenBtn === true);

  // 点开「查看内容」→ 按需读取云端对象并列出条目
  await evalJs(`(() => {
    const cards = [...document.querySelectorAll('.page.sync .cfg-card')];
    const card = cards.find(c => (c.querySelector('h3')?.textContent || '').trim() === '云端对象');
    card.querySelector('.sync-cloud-row:not(.sync-cloud-head) .sync-cloud-actions .cfg-btn').click();
  })()`);
  await sleep(700);
  const detail = await evalJs(`(() => {
    const d = document.querySelector('.page.sync .sync-cloud-detail');
    if (!d) return null;
    const groups = [...d.querySelectorAll('.sync-cloud-group-head > span:first-child')].map(s => s.textContent.trim());
    return {
      entries: d.querySelectorAll('.sync-cloud-entry').length,
      groups,
      firstName: d.querySelector('.sync-cloud-entry-name')?.textContent?.trim() ?? null,
    };
  })()`);
  check(`[${theme}] 查看内容列出条目`, detail?.entries === 4, `entries=${detail?.entries}`);
  check(`[${theme}] 条目按主体/数据分组`, detail?.groups?.length === 2, JSON.stringify(detail?.groups));
  check(`[${theme}] 条目显示文件名`, detail?.firstName === 'plugins/demo/index.js', `name=${detail?.firstName}`);

  // 滚到云端对象卡片截一张：人工看下名字/配额/内容清单的排版
  await evalJs(`(() => {
    const cards = [...document.querySelectorAll('.page.sync .cfg-card')];
    const card = cards.find(c => (c.querySelector('h3')?.textContent || '').trim() === '云端对象');
    card?.scrollIntoView({ block: 'end' });
  })()`);
  await sleep(300);
  const shotCloud = await S("Page.captureScreenshot", { format: "png" }, sessionId);
  await writeFile(path.join(root, "test", `_shot-sync-cloud-${theme}.png`), Buffer.from(shotCloud.result.data, "base64"));

  const shot = await S("Page.captureScreenshot", { format: "png" }, sessionId);
  const out = path.join(root, "test", `_shot-sync-panel-${theme}.png`);
  await writeFile(out, Buffer.from(shot.result.data, "base64"));
  console.log(`screenshot → test/_shot-sync-panel-${theme}.png`);
}

/* ---- v3 文件级视图：真实 manifest-v3 数据下的卡片 / 计数 / 清单 ---- */
await S("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }, sessionId);
await S("Page.navigate", { url: base + "/config.html?v3=1" }, sessionId);
await sleep(1500);
await evalJs(`localStorage.setItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY', JSON.stringify({
  version: 1,
  plugins: [
    { id: 'demo', name: '剪贴板', manifest: {} },
    { id: 'com.zhuanjie.resource-monitor', name: '资源监视器', manifest: {} },
  ],
}))`);
await evalJs(`document.querySelector('.cfg-nav .nav-item[data-pane="sync"]').click()`);
await sleep(900);
const v3Ui = await evalJs(`(() => {
  const cards = [...document.querySelectorAll('.page.sync .cfg-card')];
  const card = cards.find(c => (c.querySelector('h3')?.textContent || '').trim() === '云端对象');
  if (!card) return { found: false };
  const rows = [...card.querySelectorAll('.sync-cloud-row:not(.sync-cloud-head)')].map(r => ({
    name: r.querySelector('.sync-cloud-name')?.textContent?.trim() ?? '',
    status: r.querySelector('.sync-cloud-status')?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
    size: r.querySelector('.sync-cloud-size')?.textContent?.trim() ?? '',
  }));
  const header = card.querySelector('.cfg-hint')?.textContent?.replace(/\\s+/g, ' ').trim() ?? '';
  return { found: true, header, rows, docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
})()`);
check("v3 面板渲染云端对象卡片", v3Ui.found === true);
check("v3 标出「v3 文件级」", String(v3Ui.header || "").includes("v3 文件级"), v3Ui.header);
check("v3 每行显示文件/图片计数", v3Ui.rows?.some(r => r.status.includes("2 文件 / 2 图片")) && v3Ui.rows?.some(r => r.status.includes("3 文件")), JSON.stringify(v3Ui.rows));
check("v3 卡片不横向溢出", v3Ui.docOverflow === false);

await evalJs(`(() => {
  const cards = [...document.querySelectorAll('.page.sync .cfg-card')];
  const card = cards.find(c => (c.querySelector('h3')?.textContent || '').trim() === '云端对象');
  const row = [...card.querySelectorAll('.sync-cloud-row:not(.sync-cloud-head)')]
    .find(r => (r.querySelector('.sync-cloud-name')?.textContent || '').trim() === '剪贴板');
  row.querySelector('.sync-cloud-actions .cfg-btn').click();
})()`);
await sleep(700);
const v3Detail = await evalJs(`(() => {
  const d = document.querySelector('.page.sync .sync-cloud-detail');
  if (!d) return null;
  return {
    entries: d.querySelectorAll('.sync-cloud-entry').length,
    firstName: d.querySelector('.sync-cloud-entry-name')?.textContent?.trim() ?? null,
  };
})()`);
check("v3 查看内容直接列文件/图片", v3Detail?.entries === 4, `entries=${v3Detail?.entries}`);
check("v3 清单显示虚拟条目路径", v3Detail?.firstName === 'clipboard/items/a.json', `name=${v3Detail?.firstName}`);

await evalJs(`(() => {
  const cards = [...document.querySelectorAll('.page.sync .cfg-card')];
  const card = cards.find(c => (c.querySelector('h3')?.textContent || '').trim() === '云端对象');
  card?.scrollIntoView({ block: 'end' });
})()`);
await sleep(300);
const shotV3 = await S("Page.captureScreenshot", { format: "png" }, sessionId);
await writeFile(path.join(root, "test", "_shot-sync-panel-v3.png"), Buffer.from(shotV3.result.data, "base64"));
console.log("screenshot → test/_shot-sync-panel-v3.png");

// 切换导出/导入 tab 后，导入面板的按钮也应保持一行
await S("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }, sessionId);
await S("Page.navigate", { url: base + "/config.html?conflict=1" }, sessionId);
await sleep(1500);
await evalJs(`localStorage.setItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY', JSON.stringify({
  version: 1,
  plugins: [
    { id: 'demo', name: '剪贴板', manifest: {} },
    { id: 'com.zhuanjie.resource-monitor', name: '资源监视器', manifest: {} },
  ],
}))`);
await evalJs(`document.querySelector('.cfg-nav .nav-item[data-pane="sync"]').click()`);
await sleep(900);

/* ---- 冲突按插件隔离：一行一个插件，各自裁决，互不牵连 ---- */
const conflictUi = await evalJs(`(() => {
  const box = document.querySelector('.page.sync .sync-choice');
  const pane = document.querySelector('.page.sync');
  const dbg = {
    search: location.search,
    hasPane: !!pane,
    hasNow: !!document.querySelector('.page.sync .sync-now-btn'),
    hasChoice: !!box,
    choiceHtml: box ? box.innerHTML.slice(0, 200) : null,
  };
  if (!box) return { found: false, dbg };
  const rows = [...box.querySelectorAll('.sync-conflict-row')].map(r => ({
    name: r.querySelector('.sync-conflict-name')?.textContent?.trim() ?? '',
    meta: r.querySelector('.sync-conflict-meta')?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
    btns: [...r.querySelectorAll('.sync-conflict-actions .cfg-btn')].map(b => b.textContent.trim()),
  }));
  const allBtns = [...box.querySelectorAll('.sync-actions-row .cfg-btn')].map(b => b.textContent.trim());
  const syncBtn = document.querySelector('.page.sync .sync-now-btn');
  return {
    found: true, rows, allBtns,
    title: box.querySelector('.sync-choice-title')?.textContent?.trim() ?? '',
    desc: box.querySelector('.sync-choice-desc')?.textContent?.trim() ?? '',
    syncDisabled: !!syncBtn?.disabled,
    docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  };
})()`);
check("有遗留冲突时显示冲突面板", conflictUi.found === true, JSON.stringify(conflictUi));
check(
  "同一插件的多片合并成一行（3 片 → 2 行）",
  conflictUi.rows?.length === 2,
  JSON.stringify(conflictUi.rows?.map(r => r.name))
);
check(
  "冲突行按插件显示名字（而非 id）",
  conflictUi.rows?.map(r => r.name).sort().join(",") === "剪贴板,资源监视器",
  JSON.stringify(conflictUi.rows?.map(r => r.name))
);
const demoConflictRow = conflictUi.rows?.find(r => r.name === "剪贴板");
check(
  "同一插件的 body+data 片合到一行并按类型/体积展示",
  /插件程序\/插件数据/.test(demoConflictRow?.meta ?? "") &&
    /本机 9\.0 KB/.test(demoConflictRow?.meta ?? "") &&
    /云端 6\.0 KB/.test(demoConflictRow?.meta ?? ""),
  demoConflictRow?.meta
);
check(
  "每行各有「用云端 / 用本机」",
  conflictUi.rows?.every(r => r.btns.length === 2 && r.btns[0] === "用云端" && r.btns[1] === "用本机"),
  JSON.stringify(conflictUi.rows?.map(r => r.btns))
);
check(
  "另有「全部用云端 / 全部用本机」兜底",
  conflictUi.allBtns?.[0] === "全部用云端" && conflictUi.allBtns?.[1] === "全部用本机",
  JSON.stringify(conflictUi.allBtns)
);
check(
  "有冲突时「立即同步」仍可点（其它插件照常同步）",
  conflictUi.syncDisabled === false
);
check("冲突面板未撑出横向滚动条", conflictUi.docOverflow === false);

const shotConflict = await S("Page.captureScreenshot", { format: "png" }, sessionId);
await writeFile(path.join(root, "test", "_shot-sync-conflict.png"), Buffer.from(shotConflict.result.data, "base64"));

// 切换导出/导入 tab 后，导入面板的按钮也应保持一行
await evalJs(`document.querySelectorAll('.page.sync .sync-tab')[1].click()`);
await sleep(500);
const importGeo = await evalJs(`(() => {
  const pane = document.querySelector('.page.sync .sync-tab-pane');
  const btns = [...pane.querySelectorAll('.sync-actions-row .cfg-btn')];
  return { tops: btns.map(b => Math.round(b.getBoundingClientRect().top)), n: btns.length };
})()`);
check("导入面板按钮同一行", importGeo.n >= 1 && new Set(importGeo.tops).size === 1, `tops=${JSON.stringify(importGeo.tops)}`);

// ---- 最小窗口宽度（600px，与 Rust 侧 min_inner_size 一致）----
// 三个导出按钮必须仍然是一行，且输入框不能溢出行宽。
await S("Emulation.setDeviceMetricsOverride", {
  width: 600, height: 420, deviceScaleFactor: 1, mobile: false,
}, sessionId);
await sleep(400);
const narrowGeo = await evalJs(`(() => {
  document.querySelectorAll('.page.sync .sync-tab')[0].click();
  const pane = document.querySelector('.page.sync .sync-tab-pane');
  const btns = [...pane.querySelectorAll('.sync-actions-row .cfg-btn')];
  const rows = [...document.querySelectorAll('.page.sync .cfg-card:not(.sync-tab-pane) .cfg-row')];
  const inputs = rows.map(r => {
    const el = r.querySelector('.cfg-input, .cfg-select');
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.x), w: Math.round(b.width), right: Math.round(b.right) };
  }).filter(Boolean);
  const card = document.querySelector('.page.sync .cfg-card:not(.sync-tab-pane)');
  const cr = card.getBoundingClientRect();
  const cs = getComputedStyle(card);
  const body = document.querySelector('.cfg-body');
  return {
    btnTops: btns.map(b => Math.round(b.getBoundingClientRect().top)),
    btnRight: Math.max(...btns.map(b => b.getBoundingClientRect().right)),
    cardContentRight: cr.right - parseFloat(cs.paddingRight),
    inputs,
    hOverflow: body.scrollWidth > body.clientWidth,
    docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  };
})()`);
check("[600px] 三个导出按钮仍是一行", new Set(narrowGeo.btnTops).size === 1, `tops=${JSON.stringify(narrowGeo.btnTops)}`);
check("[600px] 按钮行未超出卡片内容区", narrowGeo.btnRight <= narrowGeo.cardContentRight + 1, `btnRight=${narrowGeo.btnRight.toFixed(1)} cardContent=${narrowGeo.cardContentRight.toFixed(1)}`);
check("[600px] 输入框未溢出行宽", new Set(narrowGeo.inputs.map(i => i.x)).size === 1 && narrowGeo.inputs.every(i => i.right <= narrowGeo.cardContentRight + 1), JSON.stringify(narrowGeo.inputs));
check("[600px] 无横向滚动条", !narrowGeo.hOverflow && !narrowGeo.docOverflow, `body=${narrowGeo.hOverflow} doc=${narrowGeo.docOverflow}`);
await S("Emulation.clearDeviceMetricsOverride", {}, sessionId);

check("无页面异常", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 300));

console.log(`\n${pass} passed, ${fail} failed`);
ws.close();
chrome.kill();
server.close();
process.exit(fail ? 1 : 0);
