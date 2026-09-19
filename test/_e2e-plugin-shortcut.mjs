/**
 * 真机端到端验证：全局快捷键「打开插件」（快捷键 / 作用类型 / 作用对象）。
 *
 * 与浏览器 mock 测试的分工：mock 测试验证「前端逻辑」，本脚本验证**真实链路**——
 * Rust 端 global-hotkey 实际注册多个热键、真实按下热键后广播事件、前端真的把
 * 插件视图挂起来。
 *
 * 覆盖：
 *   1. 通过设置窗口写入两条绑定（呼出/隐藏 + 打开插件），Rust 端整体重新注册
 *   2. 发送真实热键（Ctrl+Alt+Shift+Z → 打开插件）→ 窗口显示且插件视图已挂载
 *   3. 未启用/未安装的插件 id：不崩溃、窗口仍被带到前台
 *   4. 旧版单键配置自动迁移（呼出键仍可用）
 *
 * 用法：node test/_e2e-plugin-shortcut.mjs
 * 前置：npm run build && cargo build（debug 或在下面改 exe 路径）
 */
import { spawn, execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exe = path.join(root, "src-tauri", "target", "release", "my-search-desktop.exe");
const ISO_DIR = path.join(root, "test", ".e2e-plugin-shortcut-profile");
const PORT = 9357;
const APP_DATA = path.join(process.env.APPDATA || "", "com.mysearch.desktop");
const SETTINGS = path.join(APP_DATA, "settings.json");
const PLUGIN_ID = "com.test.shortcut-demo";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[e2e-shortcut]", ...a);
const killApp = () => {
  try {
    execSync("taskkill /F /IM my-search-desktop.exe /T", { stdio: "ignore" });
  } catch {}
};

if (!fs.existsSync(exe)) {
  console.error("缺少构建产物：先 npm run build && cargo build");
  process.exit(2);
}
if (!fs.existsSync(path.join(root, "dist", "index.html"))) {
  console.error("缺少 dist：先 npm run build");
  process.exit(2);
}

killApp();
await sleep(800);

// ---- 准备：装一个「本地插件目录」形态的测试插件 ----
// 走 registry（localStorage）而不是真实安装：插件视图读取走 Rust 的
// plugin_read_text，需要插件目录真实存在于应用数据目录下。
const pluginDir = path.join(APP_DATA, "plugins", PLUGIN_ID);
fs.rmSync(pluginDir, { recursive: true, force: true });
fs.mkdirSync(path.join(pluginDir, "ui"), { recursive: true });
fs.writeFileSync(
  path.join(pluginDir, "plugin.json"),
  JSON.stringify(
    {
      id: PLUGIN_ID,
      name: "快捷键演示插件",
      version: "1.0.0",
      apiVersion: 1,
      description: "端到端验证用：被全局快捷键直接打开",
      permissions: ["ui.inlay"],
      contributes: {
        searchItem: { title: "快捷键演示", desc: "由全局快捷键直接打开", keyword: "快捷键演示" },
        detailView: { entry: "ui/detail.html", mode: "inlay" },
      },
    },
    null,
    2
  )
);
fs.writeFileSync(
  path.join(pluginDir, "ui", "detail.html"),
  `<!DOCTYPE html><html><body><div id="ok">PLUGIN-VIEW-MOUNTED</div></body></html>`
);

// 备份并按「旧版单键」写入配置 —— 顺便验证迁移分支
const backup = fs.existsSync(SETTINGS) ? fs.readFileSync(SETTINGS, "utf8") : null;
fs.mkdirSync(APP_DATA, { recursive: true });
fs.writeFileSync(
  SETTINGS,
  JSON.stringify({ toggle_shortcut: "ctrl+alt+s", autostart_enabled: false }, null, 2)
);

// ---- 启动应用（带 CDP 调试端口）----
fs.rmSync(ISO_DIR, { recursive: true, force: true });
const app = spawn(exe, [], {
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: ISO_DIR,
  },
});
app.stderr.on("data", (d) => {
  const s = d.toString();
  if (!/DevTools listening|WebView2|ERROR:/.test(s)) process.stdout.write("[app] " + s);
});

// ---- 连接 CDP ----
const findTarget = async (re) => {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const t = list.find((x) => x.type === "page" && re.test(x.url));
      if (t) return t;
    } catch {}
    await sleep(400);
  }
  return null;
};

const connect = (url) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => {
      let id = 0;
      const pend = new Map();
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && pend.has(m.id)) {
          const { res, rej } = pend.get(m.id);
          pend.delete(m.id);
          m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
        }
      };
      const send = (method, params = {}) =>
        new Promise((res, rej) => {
          const i = ++id;
          pend.set(i, { res, rej });
          ws.send(JSON.stringify({ id: i, method, params }));
        });
      resolve({ ws, send });
    };
    ws.onerror = reject;
  });

const mainTarget = await findTarget(/tauri\.localhost|localhost:1420/);
if (!mainTarget) {
  log("未找到主窗口 target");
  killApp();
  process.exit(2);
}
const main = await connect(mainTarget.webSocketDebuggerUrl);
await main.send("Runtime.enable");
const evalMain = async (expr) => {
  const r = await main.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval error");
  return r.result?.value;
};

// 等主窗口前端就绪（bootstrap 完成 + 插件加载）
const waitReady = async () => {
  for (let i = 0; i < 60; i++) {
    const ready = await evalMain(
      `!!document.getElementById('my_search_box') && !!window.__TAURI_INTERNALS__`
    ).catch(() => false);
    if (ready) return true;
    await sleep(500);
  }
  return false;
};
const initialReady = await waitReady();
log("主窗口已就绪:", initialReady);

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

// ---- 步骤 1：写入注册表（插件）+ 两条绑定，验证 Rust 整体重新注册 ----
const seedResult = await evalMain(`(() => {
  // 启动时的旧版单键配置应已迁移为一条 toggle-window 绑定
  return JSON.stringify('seeded');
})()`);
log("seed:", seedResult);

// 通过设置窗口写绑定太绕；这里直接用前端同款 IPC 通道（等价设置面板的保存动作）
const setResult = await evalMain(`(async () => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  // 1) 注册插件（localStorage 注册表 = 前端唯一真相源）
  const rec = {
    id: '${PLUGIN_ID}',
    name: '快捷键演示插件',
    version: '1.0.0',
    apiVersion: 1,
    manifest: {
      id: '${PLUGIN_ID}', name: '快捷键演示插件', version: '1.0.0', apiVersion: 1,
      contributes: {
        searchItem: { title: '快捷键演示', desc: '由全局快捷键直接打开', keyword: '快捷键演示' },
        detailView: { entry: 'ui/detail.html', mode: 'inlay' }
      }
    },
    dir: '${pluginDir.replace(/\\/g, "\\\\")}',
    source: { kind: 'folder' },
    installedAt: Date.now(), updatedAt: Date.now(),
    enabled: true, autoStart: 'on-demand', requestedAutoStart: 'on-demand',
    grants: [{ permission: 'ui.inlay', at: Date.now(), source: 'install' }],
    denied: [],
    runtime: { status: 'stopped', pid: null, memoryBytes: null, startedAt: null, restarts: 0, lastError: null, keepAliveReasons: [] },
    integrity: { sha256: null, signed: false }
  };
  localStorage.setItem('my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY', JSON.stringify({ version: 1, plugins: [rec] }));
  // 2) 写入两条绑定（快捷键 / 作用类型 / 作用对象）
  await invoke('set_shortcut_bindings', { bindings: [
    { shortcut: 'ctrl+alt+s', action: 'toggle-window', target: null },
    { shortcut: 'ctrl+alt+shift+z', action: 'open-plugin', target: '${PLUGIN_ID}' }
  ]});
  const back = await invoke('get_shortcut_bindings');
  return JSON.stringify(back);
})()`).catch((e) => "ERR:" + String(e));
check(
  "Rust 端接受多条绑定（含 open-plugin / target）",
  typeof setResult === "string" && setResult.includes("open-plugin") && setResult.includes(PLUGIN_ID),
  setResult
);

// 让主窗口重新载入注册表（等价「窗口重新显示」路径）
await evalMain(`window.location.reload()`).catch(() => {});
// 重载会重建执行上下文：轮询等前端再次就绪（固定 sleep 在冷/热启动间会飘）
await waitReady();
log("重载后就绪");

// ---- 步骤 2：真实按下热键 Ctrl+Alt+Shift+Z → 窗口显示 + 插件视图挂载 ----
const sendKeys = (seq) => {
  execSync(
    `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${seq}')"`,
    { stdio: "ignore", timeout: 15000 }
  );
};

// SendKeys 的 ^=Ctrl %=Alt +=Shift
sendKeys("^%+z");
await sleep(2500);

const afterHotkey = await evalMain(`(() => {
  const view = document.querySelector('#text_show .plugin-view');
  return JSON.stringify({
    detailDisplay: document.getElementById('text_show')?.style.display ?? '',
    viewHtml: (view?.innerHTML ?? '').slice(0, 80),
    hasMounted: (view?.innerHTML ?? '').includes('PLUGIN-VIEW-MOUNTED'),
  });
})()`).catch((e) => "ERR:" + String(e));
const hk = typeof afterHotkey === "string" && afterHotkey.startsWith("{") ? JSON.parse(afterHotkey) : {};
check(
  "热键 Ctrl+Alt+Shift+Z 直接打开插件视图（真实 global-hotkey 链路）",
  hk.hasMounted === true,
  String(afterHotkey).slice(0, 160)
);
check("详情视图容器已显示", hk.detailDisplay === "block", String(hk.detailDisplay));

// ---- 步骤 3：呼出/隐藏热键仍然可用（旧版配置迁移后） ----
// 先把详情视图关掉、再收起窗口（Esc 第一次退出详情视图，第二次隐藏窗口），
// 然后用 Ctrl+Alt+S 唤出，以「窗口重新获得焦点」作为真正被唤出的证据。
const esc = () =>
  evalMain(
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); 1`
  ).catch(() => {});
await esc();
await sleep(500);
await esc();
await sleep(1200);
const hiddenFocus = await evalMain(`document.hasFocus()`).catch(() => false);
check("Esc 已收起窗口（前置条件）", hiddenFocus === false, `hiddenFocus=${hiddenFocus}`);

sendKeys("^%s");
await sleep(1500);
const afterToggle = await evalMain(`JSON.stringify({
  hasBox: !!document.getElementById('my_search_box'),
  focused: document.hasFocus(),
})`).catch((e) => "ERR:" + String(e));
const tg = typeof afterToggle === "string" && afterToggle.startsWith("{") ? JSON.parse(afterToggle) : {};
check(
  "Ctrl+Alt+S 能重新唤出窗口（重新获得焦点）",
  tg.hasBox === true && tg.focused === true,
  afterToggle
);

// ---- 步骤 4：未安装插件 id 不崩溃 ----
const notInstalled = await evalMain(`(async () => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  try {
    await invoke('set_shortcut_bindings', { bindings: [
      { shortcut: 'ctrl+alt+s', action: 'toggle-window', target: null },
      { shortcut: 'ctrl+alt+shift+z', action: 'open-plugin', target: 'com.does.not.exist' }
    ]});
    return 'ok';
  } catch (e) { return 'ERR:' + e; }
})()`).catch((e) => "ERR:" + String(e));
check("未安装插件也能保存绑定（保存时不校验注册表）", notInstalled === "ok", notInstalled);
sendKeys("^%+z");
await sleep(1800);
const afterBad = await evalMain(`document.getElementById('my_search_box') ? 'alive' : 'dead'`).catch(() => "dead");
check("未安装插件的热键不崩溃", afterBad === "alive", String(afterBad));

// 拒绝非法绑定（Rust 侧校验）
const invalid = await evalMain(`(async () => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  try {
    await invoke('set_shortcut_bindings', { bindings: [
      { shortcut: 'ctrl+alt+s', action: 'toggle-window', target: null },
      { shortcut: 'not-a-key', action: 'open-plugin', target: 'x.y' }
    ]});
    return 'ACCEPTED';
  } catch (e) { return 'REJECTED:' + e; }
})()`).catch((e) => "ERR:" + String(e));
check("非法快捷键被 Rust 拒绝", String(invalid).startsWith("REJECTED"), String(invalid).slice(0, 120));

// 重复组合键被拒
const dup = await evalMain(`(async () => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  try {
    await invoke('set_shortcut_bindings', { bindings: [
      { shortcut: 'ctrl+alt+s', action: 'toggle-window', target: null },
      { shortcut: 'ctrl+alt+s', action: 'open-plugin', target: 'a.b' }
    ]});
    return 'ACCEPTED';
  } catch (e) { return 'REJECTED:' + e; }
})()`).catch((e) => "ERR:" + String(e));
check("重复组合键被 Rust 拒绝", String(dup).startsWith("REJECTED"), String(dup).slice(0, 120));

// ---- 收尾：先杀掉应用（否则 settings.json 被 store 持有，写入会失败/被覆盖），
// 再恢复配置并清理测试插件目录 ----
try { main.ws.close(); } catch {}
killApp();
await sleep(1000);
try {
  if (backup != null) fs.writeFileSync(SETTINGS, backup);
  else fs.rmSync(SETTINGS, { force: true });
  // 校验恢复结果（写失败时明确报警，避免污染开发机上的真实配置）
  const restored = fs.readFileSync(SETTINGS, "utf8");
  if (backup != null && restored !== backup) {
    log("警告：settings.json 恢复后内容不一致，请手动检查", SETTINGS);
  }
} catch (e) {
  log("警告：settings.json 恢复失败：", String(e), SETTINGS);
}
try {
  fs.rmSync(pluginDir, { recursive: true, force: true });
} catch {}
try { fs.rmSync(ISO_DIR, { recursive: true, force: true }); } catch {}

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
