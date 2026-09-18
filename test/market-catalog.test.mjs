/**
 * 插件市场纯逻辑测试 —— 目录 schema 校验、兼容过滤、版本比对、权限契约。
 *
 * 要钉死的契约：
 *   1. 权限侧：`plugin.install` 存在、属「高风险能力」组、要求二次确认、摘要句覆盖。
 *   2. 目录侧（market-types.ts）：schema 校验（id/sha256/downloadUrl 前缀/版本）、
 *      minAppVersion 兼容过滤、重复 id 取更高版本。
 *   3. 客户端侧（market.ts）：diffCatalog（更新集合/新插件）、applyUpdateAvailable
 *      只写给 market/builtin 来源，legacy/folder 不参与。
 *   4. ms.market.* 服务端装配的纯逻辑（Task 8 扩）。
 *
 * 用法: node test/market-catalog.test.mjs
 */
import {
  groupOf,
  isKnownPermission,
  permissionBaseId,
  requiresExplicitConsent,
  riskOf,
  summarizePermissions,
} from "../src/lib/plugins/permissions.ts";

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = "") => {
  if (cond) {
    pass++;
    console.log("PASS ", name, extra ? ` — ${extra}` : "");
  } else {
    fail++;
    console.log("FAIL ", name, extra ? ` — ${extra}` : "");
  }
};

/* ============ 1. 权限契约：plugin.install ============ */
{
  ok(isKnownPermission("plugin.install"), "plugin.install 在权限目录中");
  ok(permissionBaseId("plugin.install") === "plugin.install", "无 scope 权限基础 id 即自身");
  ok(groupOf("plugin.install") === "danger", "归入「高风险能力」组", groupOf("plugin.install"));
  ok(riskOf("plugin.install") === "critical", "风险等级 critical（与 backend.spawn 同级）");
  ok(requiresExplicitConsent("plugin.install") === true, "要求二次确认（逐条勾选）");
  const text = summarizePermissions(["plugin.install"]);
  ok(text.includes("安装、更新与卸载插件"), "摘要句点名安装能力", text);
}
{
  // 带 scope 的写法应被视为非法（该权限无 scope 语法）
  ok(isKnownPermission("plugin.install:https://x.com/*") === false, "plugin.install 不接受 scope");
}

/* ============ 2. 目录 schema 解析与校验（market-types.ts） ============ */
import {
  MARKET_CATALOG_SCHEMA_VERSION,
  compatibleEntries,
  describeCatalogErrors,
  parseCatalog,
} from "../src/lib/plugins/market-types.ts";
import { compareVersion } from "../src/lib/plugins/manifest.ts";

/** 造一份目录条目 */
const entryOf = (over = {}) => ({
  id: "com.example.demo",
  name: "示例插件",
  version: "1.0.0",
  apiVersion: 1,
  minAppVersion: "7.9.16",
  author: "示例作者",
  description: "演示目录条目",
  categories: ["工具"],
  permissions: ["ui.inlay", "store"],
  downloadUrl: "https://github.com/org/market/releases/download/v1.0.0/com.example.demo.msplugin",
  sha256: "a".repeat(64),
  publishedAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  ...over,
});

const catalogOf = (plugins, over = {}) => ({
  schemaVersion: 1,
  generatedAt: "2026-09-18T00:00:00Z",
  baseUrl: "https://github.com/org/market/releases/download",
  plugins,
  ...over,
});

{
  const r = parseCatalog(catalogOf([entryOf()]));
  ok(r.ok === true, "合法目录通过");
  ok(r.ok && r.catalog.plugins.length === 1, "条目被保留");
  ok(r.ok && r.catalog.baseUrl === catalogOf([]).baseUrl, "baseUrl 保留");
}
{
  const r = parseCatalog("not-json");
  ok(r.ok === false && r.errors[0] === "json.invalid", "非法 JSON → json.invalid");
}
{
  const r = parseCatalog(catalogOf([entryOf({ id: "带-非法字符" })]));
  ok(r.ok === false && r.errors.some((e) => e.includes("id.invalid")), "非法插件 id 被拒");
}
{
  const r = parseCatalog({ ...catalogOf([entryOf()]), baseUrl: "javascript:alert(1)" });
  ok(r.ok === false && r.errors.some((e) => e.includes("catalog.baseUrl.invalid")), "非 https baseUrl 被拒");
}
{
  const r = parseCatalog(catalogOf([entryOf({ downloadUrl: "https://evil.com/x.msplugin" })]));
  ok(r.ok === false && r.errors.some((e) => e.endsWith("downloadUrl.outOfBase")), "下载地址越出受控前缀被拒");
}
{
  const r = parseCatalog(catalogOf([entryOf({ sha256: "zz".repeat(32) })]));
  ok(r.ok === false && r.errors.some((e) => e.endsWith("sha256.invalid")), "非法 sha256 被拒");
}
{
  const r = parseCatalog(catalogOf([entryOf({ downloadUrl: "http://github.com/org/market/releases/download/v1.0.0/a.msplugin" })]));
  ok(r.ok === false && r.errors.some((e) => e.endsWith("downloadUrl.insecure")), "http 下载地址被拒（非 localhost）");
}
{
  // 重复 id：更高版本胜出
  const low = entryOf({ version: "1.0.0" });
  const high = entryOf({ version: "1.2.0" });
  const r = parseCatalog(catalogOf([low, high]));
  ok(r.ok === true, "重复 id 不同版本 → 合法");
  ok(r.ok && r.catalog.plugins.length === 1, "去重为一条");
  ok(r.ok && r.catalog.plugins[0].version === "1.2.0", "保留更高版本 1.2.0");
}
{
  // 重复 id 且同版本 → 冲突拒绝
  const a = entryOf();
  const b = entryOf({ description: "另一条撞版本" });
  const r = parseCatalog(catalogOf([a, b]));
  ok(r.ok === false && r.errors.some((e) => e.includes("duplicate")), "同 id 同版本 → duplicate 拒绝");
}
{
  // 错误文案可读
  const r = parseCatalog(catalogOf([entryOf({ downloadUrl: "https://evil.com/x.msplugin" })]));
  const text = describeCatalogErrors(r.ok ? [] : r.errors).join("；");
  ok(text.includes("受控前缀"), "outOfBase 文案点名前缀", text);
}
{
  const perms = r => ok(
    compareVersion("7.9.20", "7.9.16") >= 0 && r.ok && compatibleEntries(r.catalog, "7.9.20").length === 1,
    "minAppVersion 满足当前版本 → 可见"
  );
  perms(parseCatalog(catalogOf([entryOf()])));
}
{
  const r = parseCatalog(catalogOf([entryOf()]));
  ok(r.ok && compatibleEntries(r.catalog, "7.9.10").length === 0, "minAppVersion 高于当前版本 → 隐藏");
}
{
  const r = parseCatalog(catalogOf([entryOf({ minAppVersion: undefined })]));
  ok(r.ok && compatibleEntries(r.catalog, "0.1.0").length === 1, "未声明 minAppVersion → 恒兼容");
}
{
  ok(compareVersion("1.2.0", "1.0.0") > 0 && compareVersion("1.0.0", "1.0.0") === 0, "compareVersion 版本比较正确");
}
{
  ok(MARKET_CATALOG_SCHEMA_VERSION === 1, "目录结构版本常量 = 1");
}

process.exitCode = fail > 0 ? 1 : 0;
console.log(`\n结果: ${pass} passed, ${fail} failed`);