/**
 * pi-agent 后端**传输层**契约测试（不跑 pi、不依赖模型）。
 *
 * 钉死的是「帧解析 / 进程存活」这几条，肉眼极难发现、出问题却是灾难性的：
 *
 *   1. U+2028 / U+2029（行分隔符 / 段分隔符）不能当行边界。
 *      `JSON.stringify` 不转义它们，而 `readline` 会把它们当换行——早先一条含
 *      这两个字符的用户消息会被切成两条非法 JSON，报文直接丢失。后端现在手工
 *      只按 `\n` 分帧，必须保证「含 U+2028 的一条消息」被当成**一条**。
 *
 *   2. 未捕获异常 / 未处理拒绝不能打死进程。
 *      早先没有兜底 handler，Node 默认直接退出；前端只能干等满 callTimeoutMs
 *      （5 分钟）才看到「调用超时」。现在必须记日志 + 通知 + **继续服务**。
 *
 *   3. 畸形的超长输入行要被丢弃，且进程仍然可用（不能被一行撑爆内存后卡死）。
 *
 *   4. deactivate 走优雅退出：先 abort 再 dispose，最后进程退出。
 *
 * 用法: node test/pi-agent-protocol.test.mjs
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "plugins", "pi-agent", "backend", "index.mjs");

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("PASS ", name, extra ? ` — ${extra}` : ""); }
  else { fail++; console.log("FAIL ", name, extra ? ` — ${extra}` : ""); }
};

const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "pi-agent-proto-"));
const dataDir = path.join(tmpRoot, "data");
const projectDir = path.join(tmpRoot, "proj");
await mkdir(dataDir, { recursive: true });
await mkdir(projectDir, { recursive: true });

const child = spawn(process.execPath, [entry], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, HOME: tmpRoot, USERPROFILE: tmpRoot },
});

/* ---------------- 帧接收（与后端同款：只按 \n 切） ---------------- */
let buf = "";
const pending = new Map();
const notifications = [];
child.stdout.on("data", (d) => {
  buf += d.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method) notifications.push(msg);
  }
});
let stderrText = "";
child.stderr.on("data", (d) => { stderrText += d.toString(); });

let exited = null;
child.on("exit", (code, signal) => { exited = { code, signal }; });

let seq = 0;
function sendRaw(text) {
  child.stdin.write(text);
}
function call(method, params, timeoutMs = 20000) {
  const id = ++seq;
  sendRaw(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`超时: ${method}`)); }, timeoutMs);
    pending.set(id, (msg) => { clearTimeout(t); resolve(msg); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 1. 初始化（pi 在不在都算通过，只要能应答） ---------------- */
try {
  const init = await call("init", { pluginId: "com.mysearch.pi-agent", dataDir });
  check("init 有应答（不依赖本机是否装 pi）", init.result != null, JSON.stringify(init.result).slice(0, 120));
} catch (e) {
  check("init 有应答（不依赖本机是否装 pi）", false, e.message);
}

/* ---------------- 2. U+2028 / U+2029 不被当成行边界 ---------------- */
{
  // 关键：这一条**内嵌** LS/PS。若后端用 readline，会被切成两段、整条丢失。
  const weird = "A\u2028B\u2029C";
  const id = ++seq;
  // getConfig 不碰 pi、不需要模型，纯粹验证「这条报文被完整收到」
  sendRaw(JSON.stringify({ jsonrpc: "2.0", id, method: "getConfig", params: { probe: weird } }) + "\n");
  const reply = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("超时：含 U+2028 的报文没被应答")), 15000);
    pending.set(id, (msg) => { clearTimeout(t); resolve(msg); });
  });
  check("含 U+2028/U+2029 的报文被完整接收并应答", reply.result != null, JSON.stringify(reply.result));
}

/* ---------------- 3. 未捕获异常不打死进程 ---------------- */
{
  // askAnswer 会走 findRecByPendingAsk；给它一个会触发内部异常的载荷，再验证进程还活着。
  // 真正验证的是「无论内部怎么炸，进程都必须继续服务下一个调用」。
  try {
    await call("extUiRespond", { id: "nonexistent", value: { nested: "\u2028" } });
  } catch (e) { /* 超时也算：看下面进程是否还活 */ }
  let alive = true;
  try {
    const again = await call("getConfig", {});
    alive = again.result != null;
  } catch (e) { alive = false; }
  check("异常路径之后进程仍然可用（未被静默打死）", alive && exited == null,
    exited ? `已退出 ${JSON.stringify(exited)}` : "进程存活");
}

/* ---------------- 4. 畸形超长输入行被丢弃、进程仍可用 ---------------- */
{
  // 8MB+ 且不含换行：后端应丢弃并继续工作，而不是吃爆内存/卡死
  const huge = '{"jsonrpc":"2.0","id":99999,"method":"getConfig","params":{"x":"' + "a".repeat(9 * 1024 * 1024) + '"}}\n';
  sendRaw(huge);
  await sleep(400);
  let alive = false;
  try {
    const r = await call("getConfig", {});
    alive = r.result != null;
  } catch (e) { alive = false; }
  check("超长畸形输入行被丢弃后进程仍可用", alive, `exited=${JSON.stringify(exited)}`);
}

/* ---------------- 5. deactivate 优雅退出 ---------------- */
{
  sendRaw(JSON.stringify({ jsonrpc: "2.0", method: "deactivate" }) + "\n");
  const t0 = Date.now();
  while (exited == null && Date.now() - t0 < 15000) await sleep(100);
  check("deactivate 后进程自行退出（优雅收尾）", exited != null, JSON.stringify(exited));
  check("退出时没有崩溃信号（正常 exit）", exited != null && exited.signal == null,
    JSON.stringify(exited));
}

if (exited == null) { try { child.kill(); } catch {} }
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
