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
  isAllowedDownloadUrl,
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
  downloadUrl: "https://github.com/org/market/releases/download/v1.0.0/com.example.demo.mspp",
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
  const r = parseCatalog(catalogOf([entryOf({ downloadUrl: "https://evil.com/x.mspp" })]));
  ok(r.ok === false && r.errors.some((e) => e.endsWith("downloadUrl.notAllowed")), "非白名单 host 的下载地址被拒");
}
{
  const r = parseCatalog(catalogOf([entryOf({ sha256: "zz".repeat(32) })]));
  ok(r.ok === false && r.errors.some((e) => e.endsWith("sha256.invalid")), "非法 sha256 被拒");
}
{
  const r = parseCatalog(catalogOf([entryOf({ downloadUrl: "http://github.com/org/market/releases/download/v1.0.0/a.mspp" })]));
  ok(r.ok === false && r.errors.some((e) => e.endsWith("downloadUrl.notAllowed")), "http 下载地址被拒（非 localhost）");
}
{
  // 第三方开发者仓库：插件包托管在开发者自己的仓库里，应被接受
  const r = parseCatalog(catalogOf([entryOf({ downloadUrl: "https://github.com/someone/my-plugin/releases/download/v1.0.0/com.x.y.mspp" })]));
  ok(r.ok === true, "第三方开发者仓库地址被接受");
}
{
  // 官方插件目录（raw 直链）：按版本归档的包应被接受
  const url = "https://raw.githubusercontent.com/My-Search/my-search-plugin-market/main/official-plugins/com.mysearch.market/2.0.0/com.mysearch.market.mspp";
  const r = parseCatalog(catalogOf([entryOf({ downloadUrl: url })]));
  ok(r.ok === true, "官方插件 raw 直链被接受");
}
{
  // raw 域不可被借用取仓库里的任意文件
  const base = "https://raw.githubusercontent.com/My-Search/my-search-plugin-market/main";
  const bad = [
    ["借 raw 取源码", `${base}/src/lib/main.ts`],
    ["相似目录名", `${base}/official-plugins-evil/x/1.0.0/x.mspp`],
    ["缺版本层", `${base}/official-plugins/x/x.mspp`],
    ["资产非 .mspp", `${base}/official-plugins/x/1.0.0/x.sh`],
  ];
  for (const [name, url] of bad) {
    const r = parseCatalog(catalogOf([entryOf({ downloadUrl: url })]));
    ok(r.ok === false, `raw 地址拒绝：${name}`);
  }
}
{
  // 市场索引本身的 raw 直链（4 段，与插件包的 7 段不同形态）。
  // 回归：索引从 Release 迁到仓库文件后曾因 raw 只认 7 段而拉不到索引。
  // 注意：索引不是 downloadUrl，而是客户端内置常量，这里直接测谓词。
  const good = [
    "https://raw.githubusercontent.com/My-Search/my-search-plugin-market/main/index.dist.json",
    // 大小写不敏感
    "https://raw.githubusercontent.com/my-search/MY-SEARCH-PLUGIN-MARKET/main/index.dist.json",
  ];
  for (const url of good) {
    ok(isAllowedDownloadUrl(url) === true, `市场索引地址被接受：${url}`);
  }
  const bad = [
    ["他人仓库顶替", "https://raw.githubusercontent.com/attacker/my-search-plugin-market/main/index.dist.json"],
    ["我们仓库换文件名", "https://raw.githubusercontent.com/My-Search/my-search-plugin-market/main/evil.json"],
    ["我们仓库的源清单", "https://raw.githubusercontent.com/My-Search/my-search-plugin-market/main/index.json"],
    ["多一层目录", "https://raw.githubusercontent.com/My-Search/my-search-plugin-market/main/sub/index.dist.json"],
    ["段数不足", "https://raw.githubusercontent.com/My-Search/index.dist.json"],
    ["非 main 分支", "https://raw.githubusercontent.com/My-Search/my-search-plugin-market/dev/index.dist.json"],
  ];
  for (const [name, url] of bad) {
    ok(isAllowedDownloadUrl(url) === false, `市场索引地址拒绝：${name}`);
  }
}
{
  // 各类伪造与越权地址必须拒绝
  const bad = [
    ["子域名伪造", "https://github.com.evil.com/a/b/releases/download/v1/x.mspp"],
    ["userinfo 伪造", "https://github.com@evil.com/a/b/releases/download/v1/x.mspp"],
    ["非标端口", "https://github.com:8443/a/b/releases/download/v1/x.mspp"],
    ["非 Release 路径", "https://github.com/a/b/raw/main/x.mspp"],
    ["路径段伪造", "https://github.com/a/b/releases/download-evil/v1/x.mspp"],
    ["缺少资产名", "https://github.com/a/b/releases/download"],
  ];
  for (const [name, url] of bad) {
    const r = parseCatalog(catalogOf([entryOf({ downloadUrl: url })]));
    ok(r.ok === false, `下载地址拒绝：${name}`);
  }
}
{
  // 废弃标记：仅作提醒，不影响解析通过（不禁止安装）
  const r = parseCatalog(catalogOf([entryOf({ deprecated: true, deprecatedReason: "作者已归档该仓库，插件不再维护" })]));
  ok(r.ok === true, "带 deprecated 的条目解析通过");
  ok(r.ok && r.catalog.plugins[0].deprecated === true, "deprecated 字段被保留");
  ok(r.ok && r.catalog.plugins[0].deprecatedReason === "作者已归档该仓库，插件不再维护", "废弃原因被保留");
}
{
  // 未标废弃时不应凭空产生字段
  const r = parseCatalog(catalogOf([entryOf()]));
  ok(r.ok && r.catalog.plugins[0].deprecated === undefined, "未标记时 deprecated 为 undefined");
}
{
  // 非法类型应被拒
  const r = parseCatalog(catalogOf([entryOf({ deprecated: "yes" })]));
  ok(r.ok === false && r.errors.some((e) => e.endsWith("deprecated.invalid")), "deprecated 非布尔被拒");
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
  const r = parseCatalog(catalogOf([entryOf({ downloadUrl: "https://evil.com/x.mspp" })]));
  const text = describeCatalogErrors(r.ok ? [] : r.errors).join("；");
  ok(text.includes("github.com"), "notAllowed 文案点明允许的 host", text);
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

/* ============ 3. 目录客户端（market.ts diff / updateAvailable / 块名单） ============ */
import {
  applyUpdateAvailable,
  clearUpdateAvailable,
  diffCatalog,
  isNewerVersion,
  isUpdateableSource,
  parseBlocklist,
  updateableCount,
} from "../src/lib/plugins/market.ts";

/** 造一个安装在册的插件记录 */
const recOf = (id, version, sourceKind) => {
  let rec = {
    id,
    name: id,
    version,
    apiVersion: 1,
    manifest: { id, name: id, version, apiVersion: 1, permissions: [], optionalPermissions: [] },
    dir: "X:/plugin-data",
    source: { kind: sourceKind },
    installedAt: 0,
    updatedAt: 0,
    enabled: true,
    autoStart: "disabled",
    requestedAutoStart: "no",
    closeBehavior: "stop",
    grants: [],
    denied: [],
    runtime: { status: "stopped", pid: null, memoryBytes: null, startedAt: null, restarts: 0, lastError: null, keepAliveReasons: [] },
    integrity: { sha256: null, signed: false },
    updateAvailable: null,
  };
  return rec;
};
const regOf = (...recs) => ({ version: 1, plugins: recs });

{
  const r = regOf(recOf("com.a.demo", "1.0.0", "market"));
  const entries = [entryOf({ id: "com.a.demo", version: "1.2.0" })];
  const d = diffCatalog(r, entries);
  ok(d.updates.length === 1 && d.updates[0].rec.id === "com.a.demo", "市场来源低版本 → 可更新");
  ok(d.updates[0].entry.version === "1.2.0", "更新的目标版本正确");
  ok(d.newOnes.length === 0, "未装清单无新增");
}
{
  const r = regOf(recOf("com.a.demo", "1.0.0", "builtin"));
  const d = diffCatalog(r, [entryOf({ id: "com.a.demo", version: "1.2.0" })]);
  ok(d.updates.length === 1 && d.updates[0].rec.source.kind === "builtin", "内置插件可被市场接管更新");
}
for (const kind of ["folder", "file", "legacy"]) {
  const r = regOf(recOf("com.a.demo", "1.0.0", kind));
  const d = diffCatalog(r, [entryOf({ id: "com.a.demo", version: "1.2.0" })]);
  ok(d.updates.length === 0, `本地来源 ${kind} 不参与市场更新`);
  ok(isUpdateableSource(kind) === false, `isUpdateableSource(${kind}) = false`);
}
{
  const r = regOf(recOf("com.a.demo", "2.0.0", "market"));
  const d = diffCatalog(r, [entryOf({ id: "com.a.demo", version: "1.2.0" })]);
  ok(d.updates.length === 0, "目录版本不高于已装 → 不报更新");
}
{
  const r = regOf(); // 空注册表
  const d = diffCatalog(r, [entryOf({ id: "com.only-new", version: "1.0.0" })]);
  ok(d.newOnes.length === 1 && d.newOnes[0].id === "com.only-new", "未安装 → 进入 newOnes");
}
{
  const r = regOf(recOf("com.b.blocked", "1.0.0", "market"));
  const d = diffCatalog(r, [entryOf({ id: "com.b.blocked", version: "9.9.9" })], { ids: ["com.b.blocked"] });
  ok(d.blocked.length === 1 && d.updates.length === 0, "命中块名单 → 不进 updates");
}
{
  const r = regOf(recOf("com.b.blocked", "1.0.0", "market"));
  const d = diffCatalog(r, [entryOf({ id: "com.b.blocked", version: "9.9.9" })], { ids: ["com.b.blocked"] });
  ok(d.blocked[0].id === "com.b.blocked", "块名单条目单独列出");
}
{
  // applyUpdateAvailable 幂等：先写角标，目录再变平齐 → 清回
  const r = regOf(recOf("com.a.demo", "1.0.0", "market"));
  applyUpdateAvailable(r, diffCatalog(r, [entryOf({ id: "com.a.demo", version: "1.2.0" })]));
  ok(r.plugins[0].updateAvailable === "1.2.0", "市场有更高版本 → 写上角标");
  ok(updateableCount(r) === 1, "updateableCount = 1");
  applyUpdateAvailable(r, diffCatalog(r, [entryOf({ id: "com.a.demo", version: "1.0.0" })]));
  ok(r.plugins[0].updateAvailable === null, "目录平齐 → 幂等清回 null");
}
{
  const r = regOf(recOf("com.a.demo", "1.0.0", "folder"));
  applyUpdateAvailable(r, diffCatalog(r, [entryOf({ id: "com.a.demo", version: "1.2.0" })]));
  ok(r.plugins[0].updateAvailable === null, "folder 来源即便目录更高也不写角标");
}
{
  const r = regOf(recOf("com.a.demo", "1.2.0", "market"));
  applyUpdateAvailable(r, diffCatalog(r, [entryOf({ id: "com.a.demo", version: "1.2.0" })]));
  ok(r.plugins[0].updateAvailable == null, "本地已升级到目录版本 → 无角标");
}
{
  clearUpdateAvailable(regOf(recOf("com.a.demo", "1.0.0", "market")), "com.a.demo");
  const r = regOf(recOf("com.a.demo", "1.0.0", "market"));
  r.plugins[0].updateAvailable = "1.2.0";
  clearUpdateAvailable(r, "com.a.demo");
  ok(r.plugins[0].updateAvailable === null, "clearUpdateAvailable 清角标");
}
{
  const b = parseBlocklist({ ids: ["com.a", "com.b", "", 42, "com.c"] });
  ok(b.ids.join(",") === "com.a,com.b,com.c", "块名单宽容解析，只留非空字符串");
  ok(parseBlocklist(null).ids.length === 0, "parseBlocklist(null) → 空");
  ok(parseBlocklist("nope").ids.length === 0, "parseBlocklist(字符串) → 空");
}
{
  ok(isNewerVersion(entryOf({ version: "1.2.0" }), recOf("com.x", "1.0.0", "market")), "isNewerVersion 判真");
  ok(!isNewerVersion(entryOf({ version: "1.0.0" }), recOf("com.x", "1.0.0", "market")), "同版本非更新");
  ok(!isNewerVersion(entryOf({ version: "0.9.0" }), recOf("com.x", "1.0.0", "market")), "更低版本非更新");
}

process.exitCode = fail > 0 ? 1 : 0;
console.log(`\n结果: ${pass} passed, ${fail} failed`);