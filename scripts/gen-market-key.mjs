/**
 * 生成插件市场索引签名密钥对（ed25519）。
 *
 * 私钥**只写本地文件**（默认 `.secrets/market-index-key.json`，已被 .gitignore 忽略），
 * 公钥打印出来，贴进 `src/lib/plugins/index-signature.ts` 的 `MARKET_INDEX_PUBLIC_KEYS`。
 *
 * 用法：
 *   node scripts/gen-market-key.mjs                  # 生成新密钥（已存在则拒绝覆盖）
 *   node scripts/gen-market-key.mjs --key-id market-2027-01
 *   node scripts/gen-market-key.mjs --force          # 覆盖旧私钥（旧索引将全部验签失败）
 *
 * 生产环境：把私钥内容放进 CI secret（`MARKET_INDEX_PRIVATE_KEY`，32 字节 hex 种子），
 * 本机文件应删除或离线保管；公钥随客户端发版，轮换时同时保留新旧 keyId。
 */
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  return args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true;
}

const keyId = String(flag("key-id", "market-2026-01"));
const out = path.resolve(root, String(flag("out", ".secrets/market-index-key.json")));
const force = Boolean(flag("force", false));

if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(keyId)) {
  console.error("✗ keyId 需为 3-32 位小写字母/数字/点/中划线/下划线");
  process.exit(1);
}
if (existsSync(out) && !force) {
  console.error(`✗ 私钥已存在：${path.relative(root, out)}（确要覆盖请加 --force）`);
  process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privJwk = privateKey.export({ format: "jwk" });
const pubJwk = publicKey.export({ format: "jwk" });

/** base64url → hex（32 字节） */
function b64urlToHex(s) {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("hex");
}

const seedHex = b64urlToHex(privJwk.d);
const publicKeyHex = b64urlToHex(pubJwk.x);
if (seedHex.length !== 64 || publicKeyHex.length !== 64) {
  console.error("✗ 密钥导出长度异常，已中止");
  process.exit(1);
}

mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(
  out,
  `${JSON.stringify({ keyId, privateKey: seedHex, publicKey: publicKeyHex, createdAt: new Date().toISOString() }, null, 2)}\n`,
  "utf8"
);

console.log(`\n✓ 已生成 ed25519 索引签名密钥`);
console.log(`  私钥文件  ${path.relative(root, out)}（不要提交；生产放 CI secret MARKET_INDEX_PRIVATE_KEY）`);
console.log(`  keyId     ${keyId}`);
console.log(`  公钥 hex  ${publicKeyHex}`);
console.log(`\n把这一行加进 src/lib/plugins/index-signature.ts 的 MARKET_INDEX_PUBLIC_KEYS：`);
console.log(`  { keyId: "${keyId}", publicKey: "${publicKeyHex}" }\n`);
