/**
 * 「开机自启动」生产级端到端验证（release exe + 真实 Windows 注册表）：
 *
 * 1. 首次运行（settings.json 里没有 autostart_enabled）→ 自动写入
 *    HKCU\...\Run\MySearch，即「默认开机自启」
 * 2. 首轮启动后 settings.json 落盘 autostart_enabled=true（偏好已记忆）
 * 3. 设置窗口「常规」面板里开关显示为开启（真实 IPC 链路）
 * 4. 面板里关闭 → 注册表 Run 项被真实删除 + settings.json 写 false
 * 5. 面板里重新开启 → 注册表 Run 项恢复（值为 exe 路径）
 * 6. 写入 false 后重启应用 → 仍然关闭（不会把用户关掉的开关又打开）
 *
 * 副作用管理：测试前备份 settings.json 与注册表原值，结束时完整还原。
 * 用法：node test/_e2e-autostart.mjs
 */
import { spawn, execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exe = path.join(root, "src-tauri", "target", "release", "my-search-desktop.exe");
const ISO_DIR = path.join(root, "test", ".e2e-autostart-profile");
const SETTINGS = path.join(process.env.APPDATA || "", "com.mysearch.desktop", "settings.json");
const SETTINGS_BAK = SETTINGS + ".e2e-autostart.bak";
const RUN_KEY = "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run";
const VALUE_NAME = "MySearch";
const PORT = 9357;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[e2e-autostart]", ...a);

if (!fs.existsSync(exe)) {
  console.error("缺少 release 构建，请先 cargo build --release");
  process.exit(2);
}

// ── 注册表工具（静默，返回字符串或 null） ──
const regQuery = () => {
  try {
    const out = execSync(`reg query "${RUN_KEY}" /v ${VALUE_NAME}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const m = out.match(/REG_SZ\s+(.*)/);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
};
const regDelete = () => {
  try { execSync(`reg delete "${RUN_KEY}" /v ${VALUE_NAME} /f`, { stdio: "ignore" }); } catch {}
};
const regSet = (value) => {
  try { execSync(`reg add "${RUN_KEY}" /v ${VALUE_NAME} /t REG_SZ /d "${value}" /f`, { stdio: "ignore" }); } catch {}
};

const killApp = () => {
  try { execSync("taskkill /F /IM my-search-desktop.exe /T", { stdio: "ignore" }); } catch {}
};
const freePort = (p) => {
  try {
    execSync(`powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${p} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`, { stdio: "ignore" });
  } catch {}
};

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; log("PASS", name, extra); }
  else { fail++; log("FAIL", name, extra); }
};

// ── 备份现状 ──
const originalRegValue = regQuery();
if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, SETTINGS_BAK);
const restoreAll = () => {
  regDelete();
  if (originalRegValue != null) regSet(originalRegValue);
  if (fs.existsSync(SETTINGS_BAK)) {
    fs.copyFileSync(SETTINGS_BAK, SETTINGS);
    fs.rmSync(SETTINGS_BAK, { force: true });
  } else if (fs.existsSync(SETTINGS)) {
    fs.rmSync(SETTINGS, { force: true });
  }
};
log("初始注册表值:", originalRegValue === null ? "(无)" : originalRegValue);

// 前置：清掉启动项、并从 settings.json 里移除 autostart_enabled（模拟「首次运行」）
regDelete();
if (fs.existsSync(SETTINGS)) {
  const cur = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
  delete cur.autostart_enabled;
  fs.writeFileSync(SETTINGS, JSON.stringify(cur, null, 2));
}
if (fs.existsSync(ISO_DIR)) fs.rmSync(ISO_DIR, { recursive: true, force: true });
killApp();
await sleep(800);
freePort(PORT);

// ── 启动应用并接上 CDP ──
let app = null;
async function launch() {
  app = spawn(exe, [], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, WEBVIEW2_USER_DATA_FOLDER: ISO_DIR },
  });
  app.stderr.on("data", (d) => process.stdout.write("[app-err] " + d));
  for (let i = 0; i < 60; i++) {
    try { await fetch(`http://127.0.0.1:${PORT}/json/list`); return; } catch { await sleep(400); }
  }
  throw new Error("CDP 未就绪");
}
const listTargets = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();

function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => {
      let id = 0;
      const pend = new Map();
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && pend.has(m.id)) {
          const { resolve, reject } = pend.get(m.id);
          pend.delete(m.id);
          m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
        }
      };
      const send = (method, params = {}) => new Promise((res, rej) => {
        const i = ++id;
        pend.set(i, { resolve: res, reject: rej });
        ws.send(JSON.stringify({ id: i, method, params }));
      });
      resolve({ ws, send });
    };
    ws.onerror = reject;
  });
}

try {
  // ========== 第一次启动：默认开机自启 ==========
  await launch();
  log("第一次启动完成");
  await sleep(2500); // 等 setup 里的偏好应用完成

  const regAfterFirst = regQuery();
  check("首次运行默认写入开机自启动项（HKCU Run）", regAfterFirst != null, String(regAfterFirst));
  check(
    "启动项指向当前 exe",
    regAfterFirst != null && regAfterFirst.toLowerCase().includes("my-search-desktop.exe"),
    String(regAfterFirst)
  );

  let saved = fs.existsSync(SETTINGS) ? JSON.parse(fs.readFileSync(SETTINGS, "utf8")) : {};
  check("偏好已落盘 autostart_enabled=true", saved.autostart_enabled === true, JSON.stringify(saved));

  // ========== 设置窗口：常规面板开关状态 ==========
  let mainT = null;
  for (let i = 0; i < 40; i++) {
    const list = await listTargets();
    mainT = list.find((x) => x.type === "page" && !/config/.test(x.url) && x.url !== "about:blank");
    if (mainT) break;
    await sleep(400);
  }
  if (!mainT) throw new Error("主窗口 target 未出现");
  const main = await wsConnect(mainT.webSocketDebuggerUrl);
  await main.send("Runtime.enable");
  await main.send("Page.enable");
  const mainEval = async (expr) => {
    const r = await main.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval error");
    return r.result?.value;
  };
  for (let i = 0; i < 40; i++) {
    if (await mainEval(`!!document.getElementById('my_search_box')`)) break;
    await sleep(400);
  }
  const invokeRes = await mainEval(
    `window.__TAURI_INTERNALS__.invoke('open_config_window').then(() => 'OK').catch((e) => 'ERR:' + e)`
  );
  log("open_config_window 返回:", invokeRes);
  await sleep(1500);
  log("targets:", JSON.stringify((await listTargets()).map((t) => `${t.type}|${t.url}`)));

  let cfgTarget = null;
  for (let i = 0; i < 40; i++) {
    const list = await listTargets();
    cfgTarget = list.find((x) => x.type === "page" && /config/.test(x.url));
    if (cfgTarget) break;
    await sleep(500);
  }
  check("设置窗口已打开", !!cfgTarget, cfgTarget?.url ?? "not found");
  if (!cfgTarget) throw new Error("设置窗口未出现");

  const cfg = await wsConnect(cfgTarget.webSocketDebuggerUrl);
  await cfg.send("Runtime.enable");
  await cfg.send("Page.enable");
  const cfgEval = async (expr) => {
    const r = await cfg.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval error");
    return r.result?.value;
  };
  for (let i = 0; i < 40; i++) {
    if (await cfgEval(`!!document.querySelector('.nav-item[data-pane="general"]')`)) break;
    await sleep(400);
  }
  await cfgEval(`document.querySelector('.nav-item[data-pane="general"]').click()`);
  await sleep(900);
  const switchOn = await cfgEval(`document.querySelector('.page.general .switch input[data-act="autostart"]')?.checked`);
  check("常规面板开关显示为开启（真实后端状态）", switchOn === true, `checked=${switchOn}`);

  // ========== 面板里关闭 → 注册表真实删除 ==========
  await cfgEval(`document.querySelector('.page.general .switch input[data-act="autostart"]').click()`);
  await sleep(1500);
  const regAfterOff = regQuery();
  saved = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
  check("面板关闭后注册表启动项被删除", regAfterOff === null, String(regAfterOff));
  check("面板关闭后偏好写为 false", saved.autostart_enabled === false, JSON.stringify(saved));
  const switchOff = await cfgEval(`document.querySelector('.page.general .switch input[data-act="autostart"]').checked`);
  check("开关保持关闭态", switchOff === false, `checked=${switchOff}`);

  // ========== 面板里重新开启 → 注册表恢复 ==========
  await cfgEval(`document.querySelector('.page.general .switch input[data-act="autostart"]').click()`);
  await sleep(1500);
  const regAfterOn = regQuery();
  saved = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
  check("面板重新开启后注册表启动项恢复", regAfterOn != null, String(regAfterOn));
  check("重新开启后偏好写为 true", saved.autostart_enabled === true, JSON.stringify(saved));

  // ========== 关掉后重启：不会被默认值又打开 ==========
  await cfgEval(`document.querySelector('.page.general .switch input[data-act="autostart"]').click()`);
  await sleep(1500);
  check("重启前注册表已无启动项", regQuery() === null);

  try { cfg.ws.close(); } catch {}
  try { main.ws.close(); } catch {}
  killApp();
  await sleep(1500);
  freePort(PORT);

  await launch();
  await sleep(2500);
  log("第二次启动完成（验证用户关闭后不被重新打开）");
  const regAfterRestart = regQuery();
  check("重启后仍保持关闭（尊重用户选择）", regAfterRestart === null, String(regAfterRestart));
  saved = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
  check("重启后偏好仍为 false", saved.autostart_enabled === false, JSON.stringify(saved));
} catch (e) {
  fail++;
  log("FAIL 异常:", String(e));
} finally {
  killApp();
  await sleep(800);
  freePort(PORT);
  try { fs.rmSync(ISO_DIR, { recursive: true, force: true }); } catch {}
  restoreAll();
  log("已还原注册表与 settings.json 原状");
}

console.log(`\n结果: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
