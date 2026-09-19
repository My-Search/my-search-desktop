/**
 * 插件清单签名工具 — ed25519 离线签名（预留，P5 启用）。
 *
 * MVP 阶段目录信任靠策展 + sha256；P5 升级到 Firefox 级强签名。
 * 本工具当前只做密钥生成骨架，验签逻辑待 P5 接入。
 *
 * 用法:
 *   node scripts/sign-manifest.mjs generate          # 生成密钥对（输出到 stdout）
 *   node scripts/sign-manifest.mjs sign <私钥hex> <清单.json>  # 对 plugin.json 签名
 *   node scripts/sign-manifest.mjs verify <公钥hex> <清单.json> <签名hex>
 *
 * MVP 阶段调用会提示「P5 启用」并退出。
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const cmd = process.argv[2];

switch (cmd) {
  case "generate":
    console.error("⚠️  ed25519 签名 P5 启用，当前使用策展信任（sha256 + PR 评审）");
    const seed = randomBytes(32).toString("hex");
    console.log(`私钥种子（保存好！）: ${seed}`);
    console.log("");
    console.log("公钥推导命令（安装 openssl 后运行）:");
    console.log(`  echo "${seed}" | openssl pkey -provider legacy -provider default -in /dev/stdin -pubout`);
    break;

  case "sign":
  case "verify":
    console.error("⚠️  ed25519 签名尚未启用（P5 计划），当前使用策展信任模型");
    process.exit(1);
    break;

  default:
    console.log("用法:");
    console.log("  node scripts/sign-manifest.mjs generate          # 生成密钥对");
    console.log("  node scripts/sign-manifest.mjs sign <key> <json> # 签名（P5 启用）");
    console.log("  node scripts/sign-manifest.mjs verify <key> <json> <sig> # 验签（P5 启用）");
    break;
}