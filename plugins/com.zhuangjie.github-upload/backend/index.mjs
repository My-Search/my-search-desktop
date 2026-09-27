/**
 * GitHub 文件上传 - JSON-RPC over stdio 后端（轻量可选辅助）
 *
 * ⚠️ 本后端是**完全不必须的**。前端通过 ms.net.fetch 直接调 GitHub API 完成上传。
 *
 * 后端职责：
 *   唯一职责：接收前端传来的 %NAME% 引用串，从 process.env 解析出值。
 *   这样用户可以在「设置 → 环境变量」中维护敏感/通用配置，
 *   Token 等密钥的值永远不离开后端进程，不会被前端 JS 读到。
 *
 * 完全不启动的场景（autostart: on-demand，界面未打开；或未授权 backend.spawn）：
 *   前端仍可手动填写 Token、仓库等字面量，直接通过 ms.net.fetch 上传。
 *
 * 环境变量（由宿主在 spawn 时注入）：
 *   清单声明的 $GITHUB_USER_REPO 等 + 用户额外授权的 env.read:*
 *   全部会出现在 process.env 里供 resolveRefs 读取。
 */
import { createInterface } from "node:readline";

// ===================== JSON-RPC 基础 =====================

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function sendError(id, message) {
  send({ jsonrpc: "2.0", id, error: { message: String(message) } });
}
function sendNotification(method, params) {
  send({ jsonrpc: "2.0", method, params });
}
function sendLog(level, message) {
  sendNotification("log", { level, message });
}

// ===================== 环境变量引用解析 =====================

/**
 * 解析 %NAME% 格式的引用串。
 *
 * 规则：
 *   - 输入中所有 %NAME% 模式会被替换为 process.env[NAME]（若存在）。
 *   - 找不到的变量名保留原样（不报错，前端 UI 会显示警告）。
 *   - 未以 %NAME% 形式引用的内容原样保留。
 */
const ENV_REF_RE = /%([A-Za-z_][A-Za-z0-9_]*)%/g;

function resolveText(text) {
  if (!text || typeof text !== "string") return text;
  const missing = [];
  const resolved = text.replace(ENV_REF_RE, (match, name) => {
    const val = process.env[name];
    if (val != null && val !== "") {
      return val;
    }
    missing.push(name);
    return match; // 保留原样
  });
  return { resolved, missing };
}

// ===================== 请求分发 =====================

function handleRequest(method, id, params) {
  switch (method) {
    case "init": {
      sendLog("info", "后端已启动（可选辅助）");
      sendResult(id, { ok: true });
      break;
    }

    case "getConfig": {
      // 只返回非敏感 env 值供预填
      const cfg = {
        userAndRepo: process.env.GITHUB_USER_REPO || "",
        branch: process.env.GITHUB_BRANCH || "",
        path: process.env.GITHUB_PATH || "",
        dns: process.env.CDN_DNS || "",
        hasToken: Boolean(process.env.GITHUB_TOKEN),
      };
      sendResult(id, cfg);
      break;
    }

    /**
     * 解析 %NAME% 引用 → 环境变量实际值。
     *
     * 输入: { texts: ["%GITHUB_USER_REPO%", "%GITHUB_TOKEN%", "literal"] }
     * 输出: { resolved: ["owner/repo", "ghp_xxx", "literal"], notFound: ["NAME"] }
     *
     * 前端调用时机：即将上传前，把需要解析的字段值一起发来。
     * 如果后端不可用（未授权 backend.spawn），前端直接使用字面量。
     */
    case "resolveRefs": {
      const { texts } = params || {};
      if (!Array.isArray(texts)) {
        sendError(id, "resolveRefs 需要 texts 数组参数");
        break;
      }
      const resolved = [];
      const allMissing = new Set();
      for (const t of texts) {
        const r = resolveText(t != null ? String(t) : "");
        resolved.push(r.resolved);
        for (const name of r.missing) allMissing.add(name);
      }
      sendResult(id, {
        resolved,
        notFound: [...allMissing],
      });
      break;
    }

    default:
      sendError(id, `未知方法: ${method}`);
  }
}

// ===================== 主循环 =====================

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch (e) { return; }
  const { method, id, params } = msg;
  if (method === "deactivate") {
    sendLog("info", "正在退出...");
    rl.close();
    setTimeout(() => process.exit(0), 100);
    return;
  }
  if (id != null) handleRequest(method, id, params);
});

rl.on("close", () => process.exit(0));