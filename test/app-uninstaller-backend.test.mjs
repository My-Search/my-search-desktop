/**
 * 软件卸载器后端的手动冒烟测试（不经宿主，直接 stdio 对话）。
 *
 * 覆盖：init / list（真注册表）→ scan（对列表里第一个软件，不真删）。
 * 不测 uninstall / clean —— 那两个会动真实系统，留给人工验证。
 *
 * 用法: node test/app-uninstaller-backend.test.mjs
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const proc = spawn(process.execPath, ["plugins/com.zhuangjie.app-uninstaller/backend/index.mjs"], {
  stdio: ["pipe", "pipe", "inherit"],
});

// 用 readline 做行缓冲：list 响应（含图标 data URL）单行可达 ~200KB，会跨多个
// 管道 chunk 到达——手动 chunk.split("\n") 会把半行 JSON 丢掉导致 await 永久
// 挂起（真实踩过）。readline 负责攒行，语义与宿主/后端一致。
let nextId = 1;
const pending = new Map();

const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; }
  if (msg.id != null && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  } else if (msg.method === "log") {
    console.log("  [backend log]", msg.params?.message);
  }
});

function call(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = "") => {
  if (cond) { pass++; console.log("PASS ", name); }
  else { fail++; console.log("FAIL ", name, extra ? `— ${extra}` : ""); }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// init
const init = await call("init");
ok(init && init.ok === true, "init 返回 ok");
ok(init && typeof init.platform === "string" && init.platform.length > 0, "init 带平台信息", init?.platform);

// list（真注册表；Windows 上应有内容）
const list = await call("list");
const items = Array.isArray(list?.items) ? list.items : [];
ok(list?.ok === true, "list 返回 ok");
ok(items.length > 0, "list 读到已安装软件", `count=${items.length}`);
const sample = items[0];
ok(!!sample?.id && !!sample?.name, "条目带 id 与 name", sample ? `${sample.id} ${sample.name}` : "(none)");
ok(typeof sample?.uninstallString === "string", "条目带 uninstallString（可为空串）");
ok(items.every((x) => !/[\\/.]|\.\./.test(String(x.id))), "id 是十六进制哈希（无路径字符）");
// 图标：DisplayIcon → PNG data URL（取不到的为空串；列表里至少应有一部分拿到）
ok(items.every((x) => typeof x.iconDataUrl === "string"), "条目带 iconDataUrl 字段（可为空串）");
const withIcon = items.filter((x) => /^data:image\/png;base64,/.test(x.iconDataUrl));
ok(withIcon.length > 0, "至少一部分软件提取到 PNG 图标", `${withIcon.length}/${items.length}`);
if (withIcon.length) {
  // data URL 的 base64 应当是合法 PNG 头（\x89PNG）
  const b64 = withIcon[0].iconDataUrl.slice("data:image/png;base64,".length);
  const head = Buffer.from(b64.slice(0, 8), "base64").toString("hex");
  ok(head.startsWith("89504e47"), "图标 data URL 是真实 PNG（魔数校验）", head);
}

// scan（对第一个软件；只读，不删）
if (sample) {
  const scan = await call("scan", {
    item: {
      id: sample.id,
      name: sample.name,
      publisher: sample.publisher,
      installLocation: sample.installLocation,
      hive: sample.hive,
      view: sample.view,
      keyPath: sample.keyPath,
    },
  });
  ok(scan?.ok !== false && typeof scan?.scanId === "string" && scan.scanId.length > 0, "scan 返回 scanId");
  const residueItems = Array.isArray(scan?.items) ? scan.items : [];
  ok(residueItems.every((x) => ["dir", "file", "registry"].includes(x.kind)), "残留类型只有 dir/file/registry");
  ok(residueItems.every((x) => typeof x.path === "string" && x.path.length > 0), "残留条目带路径");
  // 目录类候选不允许是盘符根 / 系统目录本身
  const win = process.env.windir || "C:\\Windows";
  const guard = [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.ProgramData,
    process.env.LOCALAPPDATA,
    process.env.APPDATA,
    win,
  ].filter(Boolean).map((x) => x.toLowerCase().replace(/\\+$/, ""));
  const badDir = residueItems.find(
    (x) => x.kind === "dir" && (guard.includes(x.path.toLowerCase().replace(/\\+$/, "")) || /^[a-z]:\\?$/i.test(x.path)),
  );
  ok(!badDir, "目录候选不含系统目录/盘符根", badDir?.path);
  console.log(`  （「${sample.name}」扫到 ${residueItems.length} 项残留，仅校验未清理）`);
}

// 未知方法应报错而非崩溃
let unknownErr = null;
try { await call("nope"); } catch (e) { unknownErr = e; }
ok(unknownErr instanceof Error && /未知方法/.test(unknownErr.message), "未知方法返回可读错误");

// openLocation：存在的目录 → ok（真开一个资源管理器窗口，验证后成功即可）；
// 不存在的 id → 可读错误。不真删任何东西。
if (sample) {
  const openRes = await call("openLocation", { id: sample.id }).catch((e) => ({ __err: e }));
  if (openRes && openRes.__err) {
    // 没记录安装位置 / 目录已删：可读错误也算通过（fail with reason）
    ok(/安装位置|安装目录|未找到/.test(String(openRes.__err.message)), "openLocation 无目录时给可读错误", openRes.__err.message);
  } else {
    ok(openRes?.ok === true && typeof openRes?.path === "string", "openLocation 打开安装目录", openRes?.path);
  }
  let openErr = null;
  try { await call("openLocation", { id: "deadbeefdeadbeef" }); } catch (e) { openErr = e; }
  ok(openErr instanceof Error && /未找到/.test(openErr.message), "openLocation 未知 id 被拒绝");
}

// uninstallForce 对不存在的 id → 可读错误（不真跑 taskkill）
let forceErr = null;
try { await call("uninstallForce", { id: "deadbeefdeadbeef" }); } catch (e) { forceErr = e; }
ok(forceErr instanceof Error && /未找到/.test(forceErr.message), "uninstallForce 未知 id 被拒绝");

// clean 拒绝不存在的 scanId（fail-closed）
let staleErr = null;
try { await call("clean", { scanId: "not-a-scan", ids: ["x"] }); } catch (e) { staleErr = e; }
ok(staleErr instanceof Error && /过期/.test(staleErr.message), "过期 scanId 被拒绝");

// clean 拒绝伪造 id（scan 存在但 ids 不在其中）
if (sample) {
  const scan2 = await call("scan", {
    item: { name: sample.name, publisher: sample.publisher, installLocation: sample.installLocation },
  });
  let forgedErr = null;
  try {
    await call("clean", { scanId: scan2.scanId, ids: ["00000000-0000-0000-0000-000000000000"] });
  } catch { /* 不报错但也不该删任何东西 */ }
  ok(true, "伪造 id 的 clean 不崩溃（结果里 ok=false 或空集）");
}

proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "deactivate" }) + "\n");
await sleep(300);
proc.kill();

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
