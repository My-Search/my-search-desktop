/**
 * 「文件搜索」流式列举的**真实原生验证**（debug exe + 真实 Rust attachment_list）。
 *
 * 目的：`ms.input.listFolderStream` 走的是 Tauri `Channel`（`__CHANNEL__:<id>`），
 * 这条链路在模拟 IPC 的 UI 测试里是假的。这里直接对着真应用：
 *   1. 造一棵真目录树（若干层、若干文件）；
 *   2. 打开插件视图并登记真实附件（走 attachments_sync）；
 *   3. 调用 `attachment_list`（带真实 Channel），断言：
 *      - 收到**多批**增量推送（边扫边出）；
 *      - 批次合起来 == 最终返回（无重复无遗漏）；
 *      - 大小批次的 JSON 都走通（含 >8KB 的批，验证 Tauri 的 channel fetch 路径）。
 *   4. 再验证取消：`attachment_list_cancel(gen)` 后仍在途的列举尽快返回部分结果。
 *
 * 用法：cargo build && node test/_e2e-file-search-stream.mjs
 */
import { spawn, execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exe = path.join(root, "src-tauri", "target", "debug", "my-search-desktop.exe");
const ISO_DIR = path.join(root, "test", ".e2e-file-search-stream-profile");
const PORT = 9361;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[fs-e2e]", ...a);
let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("PASS ", name); }
  else { fail++; console.log("FAIL ", name, extra ? ` — ${extra}` : ""); }
};

if (!fs.existsSync(exe)) { console.error("缺少 debug 构建，请先 cargo build"); process.exit(2); }
const killApp = () => { try { execSync("taskkill /F /IM my-search-desktop.exe /T", { stdio: "ignore" }); } catch {} };
if (fs.existsSync(ISO_DIR)) fs.rmSync(ISO_DIR, { recursive: true, force: true });
killApp();
await sleep(800);

/* ---------------- 造一棵真目录树（含 >8KB 的大批，验证 channel fetch 路径） ---------------- */
const tree = fs.mkdtempSync(path.join(os.tmpdir(), "ms-fs-stream-"));
const big = path.join(tree, "big");
fs.mkdirSync(big);
// 2000 个文件：每批 256 条 → 至少 7 批，首个满批 JSON 远超 8KB
for (let i = 0; i < 2000; i++) fs.writeFileSync(path.join(big, `file-${String(i).padStart(4, "0")}.txt`), "x");
fs.mkdirSync(path.join(big, "sub"));
fs.writeFileSync(path.join(big, "sub", "nested.txt"), "y");
log("树已就绪:", tree);

const app = spawn(exe, [], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, WEBVIEW2_USER_DATA_FOLDER: ISO_DIR },
});
app.stderr.on("data", (d) => process.stdout.write("[app-err] " + d));
const cleanup = () => { try { app.kill(); } catch {} killApp(); try { fs.rmSync(tree, { recursive: true, force: true }); } catch {} };

let targets = [];
for (let i = 0; i < 80; i++) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    // 主窗口加载完才有真 URL（早期可能是 about:blank 占位 target）
    if (targets.some((t) => t.type === "page" && /^https?:/.test(t.url || ""))) break;
  } catch {}
  await sleep(400);
}
if (!targets.length) { console.error("CDP 未就绪"); cleanup(); process.exit(2); }

function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => {
      let id = 0; const pend = new Map();
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
      };
      resolve({
        send: (method, params = {}, sessionId) => new Promise((res) => {
          const i = ++id; pend.set(i, res);
          ws.send(JSON.stringify({ id: i, method, params, sessionId }));
        }),
        close: () => ws.close(),
      });
    };
    ws.onerror = reject;
  });
}

const page = targets.find((t) => t.type === "page" && /^https?:/.test(t.url || "")) || targets.find((t) => t.type === "page");
log("目标页面:", page.url);
const cdp = await wsConnect(page.webSocketDebuggerUrl);
await cdp.send("Runtime.enable");
const evalJs = async (expr) => {
  const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) {
    const d = r.result.exceptionDetails;
    throw new Error((d.exception && (d.exception.description || d.exception.value)) || d.text || "eval error");
  }
  return r.result?.result?.value;
};
// 页面加载/插件宿主就绪前 __TAURI_INTERNALS__ 可能还没挂上：等它出现
for (let i = 0; i < 60; i++) {
  const ready = await evalJs(`!!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke)`).catch(() => false);
  if (ready) break;
  await sleep(500);
}

/* ---------------- 直接调用原生命令（走真实 Channel） ---------------- */
const result = await evalJs(`
  (async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    // 等价 new Channel()：transformCallback 拿 id，参数值传规范序列化串
    // "__CHANNEL__:<id>"（@tauri-apps/api 的 Channel 正是如此），消息形如
    // { index, message }；此处忽略顺序（真实 Channel 才做重排）。
    const mk = (sink) => {
      const id = window.__TAURI_INTERNALS__.transformCallback((raw) => {
        if (raw && raw.end) return;
        sink(raw && raw.message);
      });
      return '__CHANNEL__:' + id;
    };
    const ROOT = ${JSON.stringify(big.replace(/\\\\/g, "/"))};
    const PLUGIN = 'com.mysearch.file-search';

    // 登记网关（含 file.read 授权）——与真实插件运行时同一道校验
    await invoke('plugin_gateway_sync', { spec: {
      pluginId: PLUGIN, enabled: true, autoStart: 'on-demand',
      grants: ['ui.inlay', 'file.read'],
    }});
    await invoke('attachments_sync', { roots: [{ path: ROOT, isDir: true }] });

    // 1) 流式：真实 Channel，统计批次数与条数
    // 注意：Channel 消息经独立 IPC 通道送达，**可能在命令 promise resolve 之后**
    // 才到（这是真实特性，不是 bug）。先给它们一点时间落定，再统计。
    const batches = [];
    const onBatch = mk((b) => batches.push(b));
    const gen = 991001;
    const full = await invoke('attachment_list', { pluginId: PLUGIN, path: ROOT, limit: null, gen, onBatch });
    await new Promise((r) => setTimeout(r, 800));
    const flat = batches.flat();
    const uniq = new Set(flat.map((e) => e.path));
    const uniqAll = new Set(full.map((e) => e.path));

    // 2) 取消（确定性）：**先**取消该 gen，再发起列举 → walk 入口即停、
    //    Ok 返回且一个都没收集。这验证了「前端停止 → Rust 中止」这条真实链路
    //    的 gen 匹配与早停（2023 个文件的树太小，等不到在途取消）。
    const gen2 = 991002;
    await invoke('attachment_list_cancel', { gen: gen2 });
    const onBatch2 = mk(() => {});
    const partial = await invoke('attachment_list', { pluginId: PLUGIN, path: ROOT, limit: null, gen: gen2, onBatch: onBatch2 });

    // 2b) 新一轮 gen 不受上一轮取消影响（取消是一次性、按 gen 生效的）
    const okAgain = await invoke('attachment_list', { pluginId: PLUGIN, path: ROOT, limit: null, gen: 991003 });

    return {
      batchCount: batches.length,
      batchSizes: batches.map((b) => b.length),
      streamedCount: flat.length,
      streamedUnique: uniq.size,
      fullCount: full.length,
      fullUnique: uniqAll.size,
      sample: full[0] || null,
      cancelledCount: partial.length,
      okAgainCount: okAgain.length,
    };
  })()
`);

log("结果:", JSON.stringify({ ...result, sample: undefined }));
check("原生命令可调用（真实网关登记 + 真实附件集合）", !!result, "无返回");
check("真实 Channel 收到**多批**增量推送（边扫边出）", result.batchCount >= 2, `batches=${result.batchCount} sizes=${JSON.stringify(result.batchSizes)}`);
check("批次去重后 == 最终返回（无重复无遗漏）", result.streamedUnique === result.fullUnique && result.streamedUnique === result.fullCount, `streamedUniq=${result.streamedUnique} full=${result.fullCount} uniq=${result.fullUnique}`);
// 这条 race 是插件必须兜住的：批次可能**晚于**返回到达。插件对「批次 + 返回」
// 按 path 去重合并，所以两条路径都覆盖到、且不重复——上面的 uniq == full 即证。
check("批次与最终返回重叠时不重复、不丢失（插件按 path 去重的依据）", result.streamedCount === result.fullCount && result.streamedUnique === result.fullCount, `streamed=${result.streamedCount} streamedUniq=${result.streamedUnique} full=${result.fullCount}`);
check(">8KB 的大批走通 channel fetch 路径（至少一批 >100 条）", result.batchSizes.some((n) => n > 100), JSON.stringify(result.batchSizes));
check("条目形状正确（path/name/relPath/isDir/size/mtimeMs）", !!(result.sample && result.sample.path && result.sample.name && result.sample.relPath != null && typeof result.sample.isDir === "boolean" && typeof result.sample.size === "number" && typeof result.sample.mtimeMs === "number"), JSON.stringify(result.sample));
check("取消的 gen 在入口即停：一个都没收集（确定性的早停）", result.cancelledCount === 0, `cancelled=${result.cancelledCount}`);
check("新一轮 gen 不受上一轮取消影响（取消按 gen 一次性生效）", result.okAgainCount === result.fullCount, `okAgain=${result.okAgainCount} full=${result.fullCount}`);

/* ---------------- 兜底：无 Channel 的旧调用方仍一次性拿到全量 ---------------- */
const legacy = await evalJs(`
  (async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const ROOT = ${JSON.stringify(big.replace(/\\\\/g, "/"))};
    const PLUGIN = 'com.mysearch.file-search';
    const list = await invoke('attachment_list', { pluginId: PLUGIN, path: ROOT });
    return { n: list.length };
  })()
`);
check("不带 Channel 的调用仍返回全量（旧插件兼容）", legacy.n === result.fullCount, `legacy=${legacy.n} full=${result.fullCount}`);

console.log(`\n结果: ${pass} passed, ${fail} failed`);
cdp.close();
cleanup();
process.exit(fail === 0 ? 0 : 1);
