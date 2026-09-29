/**
 * 一次性检查：市场仓库的发布指南副本与本仓库的差异（只读，不改任何东西）。
 * 用法: node test/_check-doc-sync.mjs [相对路径...]
 * 默认检查中英文两版指南。
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MARKET_REPO = "My-Search/my-search-plugin-market";

const files = process.argv.slice(2);
if (files.length === 0) {
  files.push(
    "docs/plugin-market-publish.md",
    "docs/plugin-market-publish.en.md"
  );
}

// 统一换行符后再比较，避免 CRLF/LF 差异掩盖真实内容差异
const norm = (s) => s.replace(/\r\n/g, "\n");

for (const rel of files) {
  console.log(`\n================ ${rel} ================`);
  let remote;
  try {
    const b64 = execFileSync(
      "gh",
      ["api", `repos/${MARKET_REPO}/contents/${rel}`, "--jq", ".content"],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
    );
    remote = norm(Buffer.from(b64.replace(/\s/g, ""), "base64").toString("utf8"));
  } catch (err) {
    console.log(`市场仓库读取失败（可能尚未创建该文件）: ${String(err.message).slice(0, 160)}`);
    continue;
  }

  const local = norm(readFileSync(path.join(root, rel), "utf8"));
  const iq = local === remote ? "一致" : "有差异";
  console.log(`本地 ${local.length} 字符 / ${local.split("\n").length} 行`);
  console.log(`市场 ${remote.length} 字符 / ${remote.split("\n").length} 行`);
  console.log(`>>> 内容${iq}`);

  if (iq === "一致") continue;

  const lset = new Set(local.split("\n"));
  const rset = new Set(remote.split("\n"));
  const onlyLocal = [...lset].filter((l) => l.trim() && !rset.has(l));
  const onlyRemote = [...rset].filter((l) => l.trim() && !lset.has(l));

  console.log(`\n—— 仅本地有（市场缺失）${onlyLocal.length} 行 ——`);
  console.log(onlyLocal.slice(0, 30).join("\n") || "(无)");
  console.log(`\n—— 仅市场有（本地已改/删）${onlyRemote.length} 行 ——`);
  console.log(onlyRemote.slice(0, 30).join("\n") || "(无)");
}
