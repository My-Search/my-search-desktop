/**
 * P2-6：市场索引 ed25519 验签（fail-closed）。
 *
 * 契约：
 *   1. 正确签名的目录 → 接受，`signed: true`；
 *   2. 目录任意字段（sha256 / downloadUrl / 条目）被改 → 验签失败，整份拒绝；
 *   3. 未签名目录：官方链路默认拒绝；仅显式 `requireSignature:false` 时接受（测试/本地）；
 *   4. 未知 keyId / 结构不合法 → 拒绝，不降级；
 *   5. 签名与 JSON 美化格式无关（键序、空白不影响）；
 *   6. 安装记录 `integrity.signed` 在市场验签通过后为 true；
 *   7. build-index 会在有私钥时自动签名。
 *
 * 用法: node test/plugin-index-signature.test.mjs
 */
import assert from "node:assert/strict";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
} from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { catalogSigningPayload, readCatalogWithIntegrity } = await import(
  "../src/lib/plugins/index-signature.ts"
);

let passed = 0;
function pass(name) {
  passed++;
  console.log(`PASS  ${name}`);
}

/* ---------- 测试密钥（进程内生成，绝不进入生产密钥环） ---------- */
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const seedHex = Buffer.from(privateKey.export({ format: "jwk" }).d.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("hex");
const publicHex = Buffer.from(publicKey.export({ format: "jwk" }).x.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("hex");
const KEYS = [{ keyId: "test-key", publicKey: publicHex }];

function signCatalog(doc, keyId = "test-key") {
  const pkcs8 = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.from(seedHex, "hex"),
  ]);
  const key = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  return {
    ...doc,
    integrity: {
      algorithm: "ed25519",
      keyId,
      signature: nodeSign(null, Buffer.from(catalogSigningPayload(doc), "utf8"), key).toString("hex"),
      signedAt: new Date().toISOString(),
    },
  };
}

function catalog() {
  return {
    schemaVersion: 1,
    generatedAt: "2026-11-21T00:00:00.000Z",
    baseUrl: "https://github.com/My-Search/my-search-plugin-market/releases/download",
    plugins: [
      {
        id: "com.example.demo",
        name: "Demo",
        version: "1.0.0",
        apiVersion: 1,
        author: "tester",
        description: "demo",
        categories: ["tools"],
        downloadUrl: "https://github.com/My-Search/my-search-plugin-market/releases/download/x/com.example.demo.mspp",
        sha256: "a".repeat(64),
        permissions: [],
        publishedAt: "2026-11-01T00:00:00.000Z",
        updatedAt: "2026-11-01T00:00:00.000Z",
      },
    ],
  };
}

/* ============ 1. 合法签名 ============ */
{
  const doc = signCatalog(catalog());
  const r = await readCatalogWithIntegrity(JSON.stringify(doc), { keys: KEYS });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.signed, true);
  assert.equal(r.catalog.plugins.length, 1);
  pass("正确签名的目录被接受（signed=true）");
}

/* ============ 2. 篡改检测 ============ */
{
  const doc = signCatalog(catalog());
  const tamperedSha = structuredClone(doc);
  tamperedSha.plugins[0].sha256 = "b".repeat(64);
  const r1 = await readCatalogWithIntegrity(JSON.stringify(tamperedSha), { keys: KEYS });
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.includes("catalog.signature.badSignature"), "改 sha256 必须验签失败");

  const tamperedUrl = structuredClone(doc);
  tamperedUrl.plugins[0].downloadUrl = tamperedUrl.plugins[0].downloadUrl.replace("My-Search", "attacker");
  const r2 = await readCatalogWithIntegrity(JSON.stringify(tamperedUrl), { keys: KEYS });
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.includes("catalog.signature.badSignature"), "改下载地址必须验签失败");

  const extra = structuredClone(doc);
  extra.plugins.push({ ...extra.plugins[0], id: "com.example.evil" });
  const r3 = await readCatalogWithIntegrity(JSON.stringify(extra), { keys: KEYS });
  assert.equal(r3.ok, false);
  pass("任意字段/条目被改都会验签失败（sha256、downloadUrl、注入条目）");
}

/* ============ 3. 未签名与 keyId ============ */
{
  const unsigned = JSON.stringify(catalog());
  const denied = await readCatalogWithIntegrity(unsigned, { keys: KEYS });
  assert.equal(denied.ok, false);
  assert.ok(denied.errors.includes("catalog.signature.missing"), "默认 fail-closed");

  const allowed = await readCatalogWithIntegrity(unsigned, { keys: KEYS, requireSignature: false });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.signed, false);

  const wrongKey = signCatalog(catalog(), "other-key");
  const r = await readCatalogWithIntegrity(JSON.stringify(wrongKey), { keys: KEYS });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith("catalog.signature.unknownKey")), "未知 keyId 拒绝");

  const broken = signCatalog(catalog());
  broken.integrity.signature = "zz";
  const r2 = await readCatalogWithIntegrity(JSON.stringify(broken), { keys: KEYS });
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.includes("catalog.signature.invalid"));
  pass("未签名默认拒绝；显式放开才接受；未知 keyId / 坏结构也拒绝");
}

/* ============ 4. 格式无关 ============ */
{
  const doc = signCatalog(catalog());
  // 打乱顶层层级顺序 + 缩小缩进：签名载荷按键排序，不应受影响
  const reordered = {
    plugins: doc.plugins,
    baseUrl: doc.baseUrl,
    generatedAt: doc.generatedAt,
    schemaVersion: doc.schemaVersion,
    integrity: doc.integrity,
  };
  const r = await readCatalogWithIntegrity(JSON.stringify(reordered, null, 0), { keys: KEYS });
  assert.equal(r.ok, true, JSON.stringify(r));
  pass("签名与 JSON 字段顺序 / 空白格式无关");
}

/* ============ 5. 宿主接线 ============ */
{
  const marketApi = readFileSync(path.join(root, "src/lib/plugins/host/market-api.ts"), "utf8");
  assert.match(marketApi, /readCatalogWithIntegrity\(catalogRaw\)/);
  assert.match(marketApi, /readCatalogWithIntegrity\(raw\)/);
  assert.match(marketApi, /integrity: \{ sha256: prepared\.sha256, signed: true \}/, "验签通过后安装记录 signed=true");

  const autoUpdate = readFileSync(path.join(root, "src/lib/plugins/auto-update.ts"), "utf8");
  assert.match(autoUpdate, /readCatalogWithIntegrity/);
  assert.match(autoUpdate, /catalog\.signature|describeCatalogSignatureError/);

  const marketTs = readFileSync(path.join(root, "src/lib/plugins/market.ts"), "utf8");
  assert.match(marketTs, /readCatalogWithIntegrity\(raw\)/);

  const build = readFileSync(path.join(root, "scripts/build-index.mjs"), "utf8");
  assert.match(build, /signCatalog\(dist/);
  assert.match(build, /createPrivateKey/);

  const publish = readFileSync(path.join(root, "scripts/publish-market.mjs"), "utf8");
  assert.match(publish, /索引未签名，拒绝发布/);
  pass("市场安装 / 自动更新 / 检查更新 / 构建 / 发布全部接上验签");
}

console.log(`\n全部通过：${passed} 项索引验签测试`);
