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

process.exitCode = fail > 0 ? 1 : 0;
console.log(`\n结果: ${pass} passed, ${fail} failed`);