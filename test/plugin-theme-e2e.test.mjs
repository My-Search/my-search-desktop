/**
 * 端到端回归：真实宿主装载管线下的插件主题适配（市场插件 / pi-agent）。
 *
 * 为什么需要它：`plugin-theme-ui.test.mjs` 用**合成 DOM + 直接注入 CSS** 验证
 * 变量链，但它绕过了真实装载管线（解包 → 落盘 → plugin_read_text → mountSession →
 * scopeCss → 注入）。曾经出现过「合成测试全绿、真实页面仍旧白岛」的漏网——
 * 本测试走的就是真实链路：用宿主的打包器生成真实 .mspp（与内置包同源），
 * 经「从文件安装」全流程落盘，再在深色搜索窗口里打开真实插件的 detailView，
 * 读**真实计算样式**判定是否跟随主题。
 *
 * 用法: npm run build && node test/plugin-theme-e2e.test.mjs
 * 需要本机装有 Chrome / Edge；找不到浏览器时跳过（退出码 0）。
 */
import { createServer } from "http";
import { readFile, rm, mkdir, cp, writeFile } from "fs/promises";
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

const bin = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));
if (!bin) {
  console.log("跳过：未找到 Chrome / Edge。");
  server.close();
  process.exit(0);
}

const userDir = path.join(root, "test", `_chrome-profile-theme-e2e-${process.pid}`);
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
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] }
);
const wsUrl = await new Promise((resolve, reject) => {
  let buf = "";
  const t = setTimeout(() => reject(new Error("浏览器启动超时")), 20000);
  chrome.stderr.on("data", (d) => {
    buf += d.toString();
    const m = buf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (m) {
      clearTimeout(t);
      resolve(m[1]);
    }
  });
});
const ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
const pageErrors = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
  if (msg.method === "Runtime.exceptionThrown")
    pageErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
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
const {
  result: { sessionId },
} = await S("Target.attachToTarget", { targetId: pageTarget.targetId, flatten: true });
await S("Runtime.enable", {}, sessionId);
await S("Page.enable", {}, sessionId);
const evalJs = async (expr) => {
  const r = await S("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.result?.exceptionDetails)
    throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

/* ---------- 用真实源文件打包两个插件的 .mspp（与内置包同源） ---------- */
// 注意：市场插件的 plugin.json 声明 minAppVersion 7.9.16，而当前 app 是 7.9.15，
// 会被版本门拦下无法安装。本测试要验的是**主题适配**而非版本门，因此拷一份源目录、
// 把 minAppVersion 降到当前版本再打包（只动测试副本，源文件一字不改）。
const stage = path.join(root, "test", "_tmp", "theme-e2e-src");
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
async function stagePlugin(name) {
  const src = path.join(root, "plugins", name);
  const dst = path.join(stage, name);
  await cp(src, dst, { recursive: true });
  const mfPath = path.join(dst, "plugin.json");
  const mf = JSON.parse(await readFile(mfPath, "utf8"));
  if (mf.minAppVersion) {
    mf.minAppVersion = "7.9.0"; // 降到当前版本以下，只为让本测试能装上
    await writeFile(mfPath, JSON.stringify(mf, null, 2));
  }
  return dst;
}

const packed = {};
for (const name of ["market", "pi-agent"]) {
  const stagedDir = await stagePlugin(name);
  const out = path.join(root, "test", "_tmp", `${name}-theme-e2e.mspp`);
  await mkdir(path.join(root, "test", "_tmp"), { recursive: true });
  const p = spawn(process.execPath, [path.join(root, "test", "pack-plugin.mjs"), stagedDir, "-o", out], {
    cwd: root,
    stdio: "ignore",
  });
  const code = await new Promise((r) => p.on("exit", r));
  if (code !== 0 || !existsSync(out)) {
    console.error(`打包 ${name} 失败`);
    process.exit(1);
  }
  packed[name] = readFileSync(out).toString("base64");
}

/* ---------- IPC 模拟：真实脚本解包 → 落盘到「虚拟文件系统」→ plugin_read_text 读回 ---------- */
await S(
  "Page.addScriptToEvaluateOnNewDocument",
  {
    source: `
    window.__pkgs = ${JSON.stringify(packed)};
    window.__installed = {};
    window.__TAURI_INTERNALS__ = {
      invoke(cmd, args) {
        if (cmd === 'plugin:dialog|open') {
          // 用 __pickName 决定这次「选中」的是哪个包（模拟用户在文件框里选不同文件）
          return Promise.resolve('C:\\\\fake\\\\' + (window.__pickName || 'market') + '.mspp');
        }
        if (cmd === 'plugin_read_local_base64') {
          const p = String(args && args.path || '');
          // 内置引导给的 resourcePath，或「从文件安装」选中的路径，都按名字取包
          const key = p.includes('pi-agent') ? 'pi-agent' : 'market';
          return Promise.resolve(window.__pkgs[key]);
        }
        if (cmd === 'plugin_install') {
          const fs = JSON.parse(localStorage.getItem('__mock_fs') || '{}');
          for (const f of (args.files || [])) fs[args.pluginId + '/' + f.path] = f.data;
          localStorage.setItem('__mock_fs', JSON.stringify(fs));
          window.__installed[args.pluginId] = true;
          return Promise.resolve('plugins/' + args.pluginId);
        }
        if (cmd === 'plugin_read_text') {
          const fs = JSON.parse(localStorage.getItem('__mock_fs') || '{}');
          const b64 = fs[args.pluginId + '/' + args.relPath];
          if (b64 == null) return Promise.reject('文件不存在: ' + args.relPath);
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return Promise.resolve(new TextDecoder('utf-8').decode(bytes));
        }
        if (cmd === 'plugin_list_files') {
          const fs = JSON.parse(localStorage.getItem('__mock_fs') || '{}');
          const prefix = args.pluginId + '/';
          return Promise.resolve(Object.keys(fs).filter(k => k.startsWith(prefix)).map(k => ({ path: k.slice(prefix.length), size: 0 })));
        }
        if (cmd === 'plugin_gateway_sync') return Promise.resolve(null);
        if (cmd === 'plugin_backend_list') return Promise.resolve([]);
        if (cmd === 'get_default_subscribe_text') return Promise.resolve('');
        if (cmd === 'get_toggle_shortcut') return Promise.resolve('ctrl+alt+s');
        if (cmd === 'get_shortcut_bindings') return Promise.resolve([{ shortcut: 'ctrl+alt+s', action: 'toggle-window', target: null }]);
        if (cmd === 'get_autostart_enabled') return Promise.resolve(false);
        // 内置插件清单：两个都「可用」，resourcePath 指向本地包（read_local_base64 按名取）
        if (cmd === 'builtin_list') {
          const fs = JSON.parse(localStorage.getItem('__mock_fs') || '{}');
          return Promise.resolve([
            { id: 'com.mysearch.pi-agent', available: true, installed: !!fs['com.mysearch.pi-agent/plugin.json'],
              removed: false, version: null, resourcePath: 'C:\\\\fake\\\\pi-agent.mspp' },
            { id: 'com.mysearch.market', available: true, installed: !!fs['com.mysearch.market/plugin.json'],
              removed: false, version: null, resourcePath: 'C:\\\\fake\\\\market.mspp' },
          ]);
        }
        if (cmd === 'builtin_mark_removed') return Promise.resolve(null);
        if (cmd === 'builtin_clear_removed') return Promise.resolve(null);
        if (cmd === 'market_fetch_raw') {
          // 返回一份最小目录，让市场视图渲染出真实卡片（验证 badge / icon / 按钮配色）
          const catalog = {
            schemaVersion: 1,
            baseUrl: 'https://github.com/My-Search/my-search-plugin-market/releases/download/',
            plugins: [
              { id: 'com.demo.one', name: '演示插件一', version: '1.0.0', author: 'demo',
                description: '用于主题测试的示例插件', minAppVersion: '7.9.0',
                download: 'com.demo.one/com.demo.one.mspp', sha256: 'a'.repeat(64), official: true },
            ],
          };
          const b = btoa(unescape(encodeURIComponent(JSON.stringify(catalog))));
          const bytes = Uint8Array.from(b, (c) => c.charCodeAt(0));
          return Promise.resolve(bytes.buffer);
        }
        if (cmd === 'plugin:event|listen' && args && args.event) {
          const list = window.__eventHandlers.get(args.event) || [];
          list.push(args.handler);
          window.__eventHandlers.set(args.event, list);
          return Promise.resolve(window.__eventNextId++);
        }
        if (cmd === 'plugin:event|unlisten') return Promise.resolve(null);
        return Promise.resolve(null);
      },
      transformCallback(cb, once) {
        const cbId = Math.random().toString(36).slice(2);
        window.__cbIds = window.__cbIds || {};
        window.__cbIds[cbId] = cb;
        return cbId;
      },
      unregisterCallback(cbId) { delete (window.__cbIds || {})[cbId]; },
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      plugins: {},
    };
    window.__eventHandlers = new Map();
    window.__eventNextId = 1;
    // 等价 Rust app.emit：触发已注册的事件监听器（listen 的 handler 是回调 id）
    window.__emitTauriEvent = (event, payload) => {
      const list = window.__eventHandlers.get(event) || [];
      list.forEach((idOrFn) => {
        const cb = typeof idOrFn === 'function' ? idOrFn : (window.__cbIds || {})[idOrFn];
        if (typeof cb === 'function') { try { cb({ event, id: window.__eventNextId++, payload }); } catch (e) {} }
      });
      return list.length;
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(){} };
  `,
  },
  sessionId
);

/* ---------- 逐个插件：安装 → 深色窗口打开视图 → 读真实计算样式 ---------- */

// 安装步骤走 config 窗口的真实入口（面板「从文件安装」），
// 落盘走真实 IPC（plugin_install），读回走 plugin_read_text —— 与线上同一条链路。
async function installBoth() {
  // 通过 config 窗口的真实安装入口
  await S("Page.navigate", { url: base + "/config.html" }, sessionId);
  await sleep(700);
  await evalJs(`localStorage.clear(); 1`);
  await S("Page.navigate", { url: base + "/config.html" }, sessionId);
  await sleep(1500);
  await evalJs(`document.querySelector('.cfg-nav .nav-item[data-pane="plugins"]').click(); 1`);
  // 等面板真正渲染出「从文件安装」再动手（此前不等会点到 undefined）
  for (let i = 0; i < 40; i++) {
    const ready = await evalJs(
      `!![...document.querySelectorAll('.page.plugins button')].find(x => x.textContent.includes('从文件安装'))`
    );
    if (ready) break;
    await sleep(150);
  }
  for (const key of ["pi-agent", "market"]) {
    await evalJs(`
      (() => {
        window.__pickName = ${JSON.stringify(key)};
        const b = [...document.querySelectorAll('.page.plugins button')].find(x => x.textContent.includes('从文件安装'));
        if (!b) throw new Error('未找到「从文件安装」按钮');
        b.click();
      })()
    `);
    await sleep(700);
    // 权限确认（若出现）——点确定
    const hasOk = await evalJs(`!!document.querySelector('#msgOk')`);
    if (hasOk) {
      await evalJs(`document.querySelector('#msgOk').click(); 1`);
      await sleep(800);
    }
    await sleep(400);
  }
}

await installBoth();
const installedIds = await evalJs(`JSON.stringify(Object.keys(window.__installed))`);
check(
  "真实安装管线：两个插件包都落盘（pi-agent + market）",
  /com\.mysearch\.pi-agent/.test(installedIds) && /com\.mysearch\.market/.test(installedIds),
  installedIds
);

/* ---------- 回归：已安装副本是旧内容时，启动引导必须刷新它 ----------
 * 这是用户实际遇到的情况：`plugins/<id>/` 里是旧版界面文件，而内置引导
 * 只判「已安装」就跳过，导致源码修好、页面照旧。这里手工把已安装副本改回
 * 「旧 CSS」，删掉注册表里的内容指纹，跑一次真实的 setupBuiltinAutoInstall，
 * 断言：副本被刷成新版，且注册表写入了指纹。
 */
{
  const before = await evalJs(`(() => {
    const fs = JSON.parse(localStorage.getItem('__mock_fs') || '{}');
    return { css: fs['com.mysearch.market/ui/detail.css'] || null, hasFp: (localStorage.getItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY') || '').includes('builtinFingerprint') };
  })()`);
  const beforeCss = before.css ? Buffer.from(before.css, "base64").toString("utf8") : "";
  check(
    "前置：安装后副本已是主题化 CSS（var(--surface)）",
    beforeCss.includes("var(--surface"),
    beforeCss.slice(0, 60)
  );

  // 把副本改回「旧 CSS」，并把注册表记录改成「内置安装 + 无指纹」
  // （模拟用户机器上的真实状态：上次由内置引导装的旧版本，老注册表没有指纹）
  await evalJs(`(() => {
    const fs = JSON.parse(localStorage.getItem('__mock_fs') || '{}');
    fs['com.mysearch.market/ui/detail.css'] = btoa('body{background:var(--bg,#fff);color:var(--fg,#333)}');
    localStorage.setItem('__mock_fs', JSON.stringify(fs));
    const raw = localStorage.getItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY');
    const reg = JSON.parse(raw);
    for (const p of reg.plugins) {
      if (p.id === 'com.mysearch.market') {
        p.source = { kind: 'builtin' };
        delete p.builtinFingerprint;
      }
    }
    localStorage.setItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY', JSON.stringify(reg));
    return 1;
  })()`);
  // 重新加载搜索窗口 → 触发真实的启动引导（setupBuiltinAutoInstall）
  await S("Page.navigate", { url: base + "/index.html" }, sessionId);
  await sleep(2500);
  const after = await evalJs(`(() => {
    const fs = JSON.parse(localStorage.getItem('__mock_fs') || '{}');
    const css = fs['com.mysearch.market/ui/detail.css'] || '';
    const d = atob(css);
    const raw = localStorage.getItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY') || '';
    return { themed: d.includes('var(--surface'), fp: /"builtinFingerprint":"[0-9a-f]{8}/.test(raw) };
  })()`);
  check(
    "回归：旧副本在启动引导后被刷新为主题化 CSS（这就是用户遇到的场景）",
    after.themed === true,
    `themed=${after.themed}`
  );
  check("回归：刷新后注册表写入了内容指纹（下次启动不再重复刷新）", after.fp === true, `fp=${after.fp}`);
}

// 打开插件视图并探测真实计算样式。
// 用「快捷键打开插件」事件（my-search://shortcut-open-plugin）直接按 id 打开，
// 不依赖关键词搜索/回车的时序；这是线上同一条挂载路径（usePluginViewHost.open）。
async function openPluginView(theme, pluginId, probe) {
  await S("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] }, sessionId);
  await S("Page.navigate", { url: base + "/empty.html" }, sessionId);
  await sleep(250);
  await evalJs(`localStorage.setItem('my-search-desktop:theme', ${JSON.stringify(theme)}); 1`);
  await S("Page.navigate", { url: base + "/index.html" }, sessionId);
  await sleep(1500);
  await evalJs(`window.__emitTauriEvent('my-search://shortcut-open-plugin', { pluginId: ${JSON.stringify(pluginId)} }); 1`);
  // 等视图真正挂上（轮询 probe 的 mounted）
  for (let i = 0; i < 30; i++) {
    await sleep(200);
    const r = await evalJs(probe);
    const o = JSON.parse(r || "null");
    if (o?.mounted) return o;
  }
  return JSON.parse((await evalJs(probe)) || "null");
}

// 市场插件的 `body{...}` 经 scopeCss 映射到 `.plugin-view`（会话载体本身透明），
// 所以背景要量 `.plugin-view`，文字色量容器内元素。
const marketProbe = `JSON.stringify((() => {
  const pv = document.querySelector('#text_show .plugin-view');
  const root = document.querySelector('#text_show .plugin-view .ms-plugin-session');
  if (!root || !pv) return { mounted: false, html: (document.querySelector('#text_show')?.innerHTML || '').slice(0, 120) };
  const pvcs = getComputedStyle(pv);
  const title = root.querySelector('.market-header h2');
  const state = root.querySelector('.market-state');
  const desc = root.querySelector('.plugin-desc');
  const tab = root.querySelector('.tab');
  const hero = root.querySelector('.hero');
  const shapeA = root.querySelector('.shape-a');
  return {
    mounted: true,
    viewBg: pvcs.backgroundColor,
    viewColor: pvcs.color,
    titleColor: title ? getComputedStyle(title).color : null,
    stateColor: state ? getComputedStyle(state).color : null,
    descColor: desc ? getComputedStyle(desc).color : null,
    tabColor: tab ? getComputedStyle(tab).color : null,
    cardCount: root.querySelectorAll('.plugin-card').length,
    htmlClass: document.documentElement.className,
    // hero 装饰（渐变底 + 装饰块）：必须随主题变，且**不依赖 JS**。
    // 历史坑：曾写成 html.theme-dark 死规则（scopeCss 后永不匹配）；
    // 又曾改用 JS 打类（首帧浅色→深色闪一下，FOUC）。
    heroBg: hero ? getComputedStyle(hero).backgroundImage : null,
    shapeABg: shapeA ? getComputedStyle(shapeA).backgroundColor : null,
    pageClass: root.querySelector('.page')?.className ?? null,
  };
})())`;

const darkMarket = await openPluginView("dark", "com.mysearch.market", marketProbe);
const lightMarket = await openPluginView("light", "com.mysearch.market", marketProbe);
console.log("\n[dark market]", JSON.stringify(darkMarket));
console.log("[light market]", JSON.stringify(lightMarket));

check("市场：真实装载下视图已挂载", darkMarket?.mounted === true, JSON.stringify(darkMarket)?.slice(0, 140));
check("市场[深]：html 挂 theme-dark", String(darkMarket?.htmlClass || "").includes("theme-dark"), darkMarket?.htmlClass);

const lum = (s) => {
  const m = String(s).match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const [r, g, b] = m[1].split(",").map((x) => parseFloat(x) / 255);
  const ch = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
};
const darkMarketLum = lum(darkMarket?.viewBg);
check(
  "市场[深]：面板底是深色（相对亮度 < 0.3，旧实现是 #fff 白岛）",
  darkMarketLum != null && darkMarketLum < 0.3,
  `bg=${darkMarket?.viewBg} lum=${darkMarketLum?.toFixed(3)}`
);
const lightMarketLum = lum(lightMarket?.viewBg);
check(
  "市场[浅]：面板底是浅色（相对亮度 > 0.6）",
  lightMarketLum != null && lightMarketLum > 0.6,
  `bg=${lightMarket?.viewBg} lum=${lightMarketLum?.toFixed(3)}`
);
check(
  "市场：浅/深面板底确实不同（真的跟随主题，而非写死一套）",
  darkMarket?.viewBg !== lightMarket?.viewBg,
  `${lightMarket?.viewBg} vs ${darkMarket?.viewBg}`
);
check(
  "市场：正文色浅深不同（--text 联动）",
  darkMarket?.viewColor !== lightMarket?.viewColor,
  `${lightMarket?.viewColor} vs ${darkMarket?.viewColor}`
);
check(
  "市场：次要文字（--muted）浅深不同",
  darkMarket?.titleColor !== lightMarket?.titleColor || darkMarket?.stateColor !== lightMarket?.stateColor,
  `title ${lightMarket?.titleColor}/${darkMarket?.titleColor}`
);

// 回归：hero 的渐变底与装饰块必须随主题变，且**纯 CSS 实现**。
// 曾经写成 `html.theme-dark .hero {…}`，被宿主的 scopeCss 改写成
// `.plugin-view .ms-plugin-session html.theme-dark .hero` —— 容器内没有 html
// 元素，规则永不匹配，于是深色下 hero 仍是浅蓝。
//
// 后又改成 JS 打 `.page.theme-dark` 类修正，但脚本在 </body> 前执行，
// 首帧已按浅色渲染 → 深色用户看到「浅→深」闪一下（FOUC）。
// 终解：装饰色全部由宿主变量 color-mix 推导，不依赖任何 JS / 主题类。
check(
  "市场：hero 渐变底浅深不同（装饰色曾因 html.theme-dark 死规则而失效）",
  !!darkMarket?.heroBg && !!lightMarket?.heroBg && darkMarket.heroBg !== lightMarket.heroBg,
  `dark ${String(darkMarket?.heroBg).slice(0, 44)} / light ${String(lightMarket?.heroBg).slice(0, 44)}`
);
check(
  "市场：hero 装饰块浅深不同",
  !!darkMarket?.shapeABg && darkMarket.shapeABg !== lightMarket?.shapeABg,
  `dark ${darkMarket?.shapeABg} / light ${lightMarket?.shapeABg}`
);
/**
 * 从 computed 颜色/渐变串里取出第一个颜色并算相对亮度。
 * 需兼容两种序列化：`rgb(r, g, b)`（0-255）与 `color(srgb r g b)`（0-1 浮点）
 * —— `color-mix()` 在 Chromium 里按后者输出，老写法解析不出会误判。
 */
const luminanceOfFirstColor = (s) => {
  const str = String(s || "");
  const srgb = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(str);
  let r, g, b;
  if (srgb) {
    [r, g, b] = [+srgb[1], +srgb[2], +srgb[3]].map((v) => v * 255);
  } else {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(str);
    if (!m) return null;
    [r, g, b] = [+m[1], +m[2], +m[3]];
  }
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};

check(
  "市场：深色下 hero 底确实压暗（相对亮度 < 0.45，不再是浅蓝）",
  (() => {
    const lum = luminanceOfFirstColor(darkMarket?.heroBg);
    return lum !== null && lum < 0.45;
  })(),
  `lum=${luminanceOfFirstColor(darkMarket?.heroBg)?.toFixed(3)}`
);
check(
  "市场：浅色下 hero 底是浅色（相对亮度 > 0.7）",
  (() => {
    const lum = luminanceOfFirstColor(lightMarket?.heroBg);
    return lum !== null && lum > 0.7;
  })(),
  `lum=${luminanceOfFirstColor(lightMarket?.heroBg)?.toFixed(3)}`
);
// 反 FOUC：装饰色不能靠 JS 打类切换，否则首帧会闪。
// 判据——页面容器上**不应**出现 theme-dark 类（主题类方案已被废弃）。
check(
  "市场：不靠 JS 主题类（反 FOUC，装饰色纯 CSS 跟随宿主变量）",
  !/theme-dark/.test(darkMarket?.pageClass || "") && !/theme-dark/.test(lightMarket?.pageClass || ""),
  `dark "${darkMarket?.pageClass}" / light "${lightMarket?.pageClass}"`
);

const piProbe = `JSON.stringify((() => {
  const root = document.querySelector('#text_show .plugin-view .ms-plugin-session .pi-agent-container');
  if (!root) return { mounted: false, html: (document.querySelector('#text_show')?.innerHTML || '').slice(0, 120) };
  const cs = getComputedStyle(root);
  const sidebar = root.querySelector('.sidebar-left');
  const input = root.querySelector('.input-box');
  return {
    mounted: true,
    bg: cs.backgroundColor,
    color: cs.color,
    sidebarBg: sidebar ? getComputedStyle(sidebar).backgroundColor : null,
    inputBg: input ? getComputedStyle(input).backgroundColor : null,
    htmlClass: document.documentElement.className,
  };
})())`;
const darkPi = await openPluginView("dark", "com.mysearch.pi-agent", piProbe);
const lightPi = await openPluginView("light", "com.mysearch.pi-agent", piProbe);
console.log("\n[dark pi]", JSON.stringify(darkPi));
console.log("[light pi]", JSON.stringify(lightPi));
check("pi-agent：真实装载下视图已挂载", darkPi?.mounted === true, JSON.stringify(darkPi)?.slice(0, 140));

/* ---------- 新增契约：插件声明 theme:"dark" → 打开时整个呼出窗口跟随 ----------
 * pi-agent 清单声明 `detailView.theme: "dark"`（设计稿是深色）。因此即使软件
 * 本身是浅色主题，打开它时 `<html>` 也必须变成 theme-dark（呼出窗口的搜索框、
 * 结果列表、插件面板同色），关闭后恢复软件原主题。这正是用户反馈的问题。
 */
check(
  "pi-agent[软件浅色]：插件声明 dark → 呼出窗口整体切深色（html 挂 theme-dark）",
  String(lightPi?.htmlClass || "").includes("theme-dark"),
  lightPi?.htmlClass
);
check(
  "pi-agent[软件浅色]：面板底因此是深色（与上方搜索框同色，不再有割裂观感）",
  (lum(lightPi?.bg) ?? 9) < 0.3,
  `bg=${lightPi?.bg}`
);
check(
  "pi-agent：深/浅软件主题下打开同一插件，面板底一致（都被接管为插件的深色）",
  darkPi?.bg === lightPi?.bg,
  `${lightPi?.bg} vs ${darkPi?.bg}`
);
check(
  "pi-agent：侧栏（--surface）在两种软件主题下一致（同一套插件主题）",
  darkPi?.sidebarBg === lightPi?.sidebarBg,
  `${lightPi?.sidebarBg} vs ${darkPi?.sidebarBg}`
);
check(
  "pi-agent：输入框（--code-bg）在两种软件主题下均是深色（同一套插件主题）",
  (lum(lightPi?.inputBg) ?? 9) < 0.5 && (lum(darkPi?.inputBg) ?? 9) < 0.5,
  `${lightPi?.inputBg} / ${darkPi?.inputBg}`
);

/* ---------- 关闭插件视图后必须恢复软件原主题 ---------- */
{
  // 软件浅色 + 打开 pi-agent（应切深色）
  await S("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] }, sessionId);
  await S("Page.navigate", { url: base + "/empty.html" }, sessionId);
  await sleep(250);
  await evalJs(`localStorage.setItem('my-search-desktop:theme', '"light"'); 1`);
  await S("Page.navigate", { url: base + "/index.html" }, sessionId);
  await sleep(1500);
  await evalJs(`window.__emitTauriEvent('my-search://shortcut-open-plugin', { pluginId: 'com.mysearch.pi-agent' }); 1`);
  for (let i = 0; i < 30; i++) {
    await sleep(200);
    const c = await evalJs(`document.documentElement.className`);
    if (String(c).includes("theme-dark")) break;
  }
  const opened = await evalJs(`document.documentElement.className`);
  check("恢复前置：打开 pi-agent 后 html 是 theme-dark", String(opened).includes("theme-dark"), opened);

  // 关闭插件视图（Esc 路径：App.vue 的 hideTextView → pluginViewHost.clear）
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1`);
  await sleep(600);
  const closed = await evalJs(`document.documentElement.className`);
  check(
    "关闭插件视图后恢复软件原主题（浅色 → html 回到 theme-light）",
    String(closed).includes("theme-light") && !String(closed).includes("theme-dark"),
    closed
  );
  const stored = await evalJs(`localStorage.getItem('my-search-desktop:theme')`);
  check(
    "临时覆盖不污染软件主题设置（localStorage 仍是 light）",
    String(stored).includes("light") && !String(stored).includes("dark"),
    stored
  );
}

/* ---------- 插件界面内切换主题：左下角三选 → 宿主立即重算并应用 ----------
 * pi-agent 在设置面板的「外观」页提供「深色 / 浅色 / 跟随系统」三选（默认深色）。
 * 切换后插件调 `ms.ui.applyTheme()`，宿主重算 provider → 立即切整个呼出窗口。
 * 这里点「浅色」，断言呼出窗口从深色翻成浅色（并且是插件主动驱动的）。
 */
{
  await S("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] }, sessionId);
  await S("Page.navigate", { url: base + "/empty.html" }, sessionId);
  await sleep(250);
  await evalJs(`localStorage.setItem('my-search-desktop:theme', '"light"'); 1`);
  await S("Page.navigate", { url: base + "/index.html" }, sessionId);
  await sleep(1500);
  await evalJs(`window.__emitTauriEvent('my-search://shortcut-open-plugin', { pluginId: 'com.mysearch.pi-agent' }); 1`);
  // 等挂载 + 主题接管成深色
  let openedDark = false;
  for (let i = 0; i < 30; i++) {
    await sleep(200);
    const c = await evalJs(`document.documentElement.className`);
    if (String(c).includes("theme-dark")) { openedDark = true; break; }
  }
  check("插件内切换前置：打开 pi-agent 后呼出窗口是深色", openedDark);

  // 打开设置面板（左下角齿轮）→ 左菜单点「外观」
  const hasGear = await evalJs(`!!document.querySelector('#text_show .plugin-view #pi-settings-btn')`);
  check("pi-agent：左下角存在设置按钮", hasGear === true);
  await evalJs(`document.querySelector('#text_show .plugin-view #pi-settings-btn').click(); 1`);
  await sleep(400);
  const needAppearance = await evalJs(
    `!!document.querySelector('#text_show .plugin-view #pi-settings-nav-appearance')`
  );
  check("pi-agent：设置面板左菜单存在「外观」页", needAppearance === true);
  await evalJs(`document.querySelector('#text_show .plugin-view #pi-settings-nav-appearance').click(); 1`);
  await sleep(400);

  const optsShown = await evalJs(
    `JSON.stringify([...document.querySelectorAll('#text_show .plugin-view .pi-theme-group .pi-theme-choice')].map(b => b.getAttribute('data-theme')))`
  );
  check(
    "pi-agent：外观页给出 深色 / 浅色 / 跟随系统 三选",
    /dark/.test(optsShown) && /light/.test(optsShown) && /inherit/.test(optsShown),
    optsShown
  );
  const activeOpt = await evalJs(
    `document.querySelector('#text_show .plugin-view .pi-theme-group .pi-theme-choice.active')?.getAttribute('data-theme')`
  );
  check("pi-agent：外观页默认选中「深色」", activeOpt === "dark", String(activeOpt));

  // 点「浅色」→ 宿主立即把呼出窗口切成浅色
  await evalJs(
    `document.querySelector('#text_show .plugin-view .pi-theme-group .pi-theme-choice[data-theme="light"]').click(); 1`
  );
  await sleep(500);
  const afterLight = await evalJs(`document.documentElement.className`);
  check(
    "pi-agent：外观页选「浅色」→ 宿主立即把呼出窗口切成浅色（插件驱动主题）",
    String(afterLight).includes("theme-light") && !String(afterLight).includes("theme-dark"),
    afterLight
  );
  const savedPref = await evalJs(
    `String(localStorage.getItem('my-search-desktop:PLUGIN_DATA:com.mysearch.pi-agent:theme'))`
  );
  check(
    "pi-agent：界面主题选择已持久化（ms.store，下次打开仍是它）",
    /light/.test(String(savedPref)),
    String(savedPref)?.slice(0, 120)
  );
}

check("全程无未捕获页面异常", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | ").slice(0, 200));

console.log(`\n结果: ${pass} passed, ${fail} failed`);
chrome.kill();
server.close();
process.exit(fail === 0 ? 0 : 1);
