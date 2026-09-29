/**
 * 发布后校验：下载市场索引里每个插件的真实包字节，核对 sha256 与索引一致。
 * 这正是客户端安装前会做的校验；若不一致，用户安装会失败。
 *
 * 用法: node test/_verify-market-publish.mjs
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MARKET_REPO = "My-Search/my-search-plugin-market";

/** 从市场仓库读一个文件的原始字节（走 gh api，认证通道稳定） */
function ghFileBytes(relPath) {
  const b64 = execFileSync(
    "gh",
    ["api", `repos/${MARKET_REPO}/contents/${relPath}`, "--jq", ".content"],
    { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 }
  );
  return Buffer.from(b64.replace(/\s/g, ""), "base64");
}

const indexBytes = ghFileBytes("index.dist.json");
const index = JSON.parse(indexBytes.toString("utf8"));

console.log(`市场索引 generatedAt=${index.generatedAt}，共 ${index.plugins.length} 个插件\n`);

let ok = 0;
let bad = 0;
for (const p of index.plugins) {
  // 官方包：downloadUrl 指向市场仓库自身的 raw 路径 → 换算成仓库内相对路径
  const m = new RegExp(`/${MARKET_REPO}/(?:main|master)/(.+)$`).exec(p.downloadUrl);
  if (!m) {
    console.log(`SKIP ${p.id}（非市场仓库托管：${p.downloadUrl}）`);
    continue;
  }
  const relPath = m[1];
  let bytes;
  try {
    bytes = ghFileBytes(relPath);
  } catch (e) {
    bad++;
    console.log(`FAIL ${p.id} v${p.version} — 下载失败：${String(e.message).slice(0, 120)}`);
    continue;
  }
  const sha = createHash("sha256").update(bytes).digest("hex");
  const match = sha === p.sha256 && bytes.length === p.size;
  if (match) ok++;
  else bad++;
  console.log(
    `${match ? "PASS" : "FAIL"} ${p.id} v${p.version} ` +
      `bytes=${bytes.length}/${p.size} sha=${sha.slice(0, 12)}=${p.sha256.slice(0, 12)}`
  );
}

// 顺带核对本地 index.json 源清单里的版本记录已随本次发布更新
const srcManifest = JSON.parse(readFileSync(path.join(root, "plugins", "index.json"), "utf8"));
console.log("\n源清单 lastVersion：");
for (const s of srcManifest["official-repo"]) {
  console.log(`  ${s.plugin.replace("official-plugins/", "")} → ${s.lastVersion}`);
}

console.log(`\n结果: ${ok} passed, ${bad} failed`);
process.exit(bad === 0 ? 0 : 1);
