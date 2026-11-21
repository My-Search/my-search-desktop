/**
 * ⚠️ 已废弃：本脚本不再承担签名职责。
 *
 * 现行签名体系（P2-6）签的是**市场索引**，不是单个 `plugin.json`：
 *   - 生成/轮换密钥：`node scripts/gen-market-key.mjs`
 *   - 构建并签名索引：`node scripts/build-index.mjs`（需要私钥，见脚本内说明）
 *   - 发布前校验：`node scripts/publish-market.mjs`
 *   - 客户端验签：`src/lib/plugins/index-signature.ts::readCatalogWithIntegrity`
 *
 * 为什么不再逐插件签名：索引里的 `sha256` 才是下载完整性的信任根；
 * 平台签索引后，任何一个条目的下载地址/哈希被篡改都会导致整份索引验签失败。
 * 这样三方开发者的提交流程不变（仍然只提插件包 + 清单），签名成本只在平台侧。
 *
 * 本脚本保留仅为兼容旧的调用习惯：任何 `generate/sign/verify` 都直接报错退出，
 * 避免有人误以为「签了 plugin.json 就完成了供应链校验」。
 */
console.error("scripts/sign-manifest.mjs 已废弃：请使用 scripts/gen-market-key.mjs + scripts/build-index.mjs（签名对象是市场索引）。");
console.error("客户端验签逻辑见 src/lib/plugins/index-signature.ts；文档见 docs/plugin-api-versioning.md。");
process.exit(2);
