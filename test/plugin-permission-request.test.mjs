/**
 * 权限申请闭环（P1-1）测试。
 *
 * 覆盖契约：
 *   1. 只能申请清单声明过的权限（含 scope 覆盖）；
 *   2. 一次 ≤8 项、未知权限/空列表拒绝；
 *   3. 24h 内同权限最多 3 次（超限返回 throttled，且不计已授予的）；
 *   4. 已授予的权限不重复讨要；
 *   5. 历史写入有上限、弹窗文案包含分组/风险/理由；
 *   6. 接线契约（ms.permissions 无需权限、宿主注入、面板展示历史）。
 *
 * 用法: node test/plugin-permission-request.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
  key: (i) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size;
  },
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { parsePluginManifest } = await import("../src/lib/plugins/manifest.ts");
const { createPluginRecord } = await import("../src/lib/plugins/registry.ts");
const {
  planPermissionRequest,
  recordPermissionRequest,
  countRecentRequests,
  permissionRequestText,
  clearPermissionRequests,
  PERMISSION_REQUEST_LIMIT,
  PERMISSION_REQUEST_MAX_APIS,
  PERMISSION_REQUEST_WINDOW_MS,
  PERMISSION_REQUEST_HISTORY_LIMIT,
} = await import("../src/lib/plugins/permission-requests.ts");

let passed = 0;
function pass(name) {
  passed++;
  console.log(`PASS  ${name}`);
}

function rec(permissions, grants = []) {
  const r = parsePluginManifest(
    JSON.stringify({
      id: "com.example.perm",
      name: "权限测试",
      version: "1.0.0",
      apiVersion: 1,
      permissions,
    })
  );
  assert.equal(r.ok, true, r.ok ? "" : r.errors.join(","));
  return createPluginRecord({
    manifest: r.manifest,
    dir: "plugins/com.example.perm",
    source: { kind: "file" },
    grants,
  });
}

const NOW = 1_700_000_000_000;

/* ============ 1. 声明校验 ============ */
{
  const r = rec(["search.read", "clipboard.read"]);
  assert.equal(planPermissionRequest(r, [], NOW).ok, false);
  assert.equal(planPermissionRequest(r, [], NOW).reason, "empty");

  const unknown = planPermissionRequest(r, ["magic.unicorn"], NOW);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, "unknown");

  const undeclared = planPermissionRequest(r, ["clipboard.write"], NOW);
  assert.equal(undeclared.ok, false);
  assert.equal(undeclared.reason, "undeclared");
  assert.match(undeclared.message, /clipboard\.write/);

  const tooMany = planPermissionRequest(r, ["search.read", "clipboard.read"], NOW);
  assert.equal(tooMany.ok, true, "两项声明过的权限可一起申请");

  const many = [
    "search.read",
    "search.write",
    "ui.inlay",
    "ui.window",
    "ui.command",
    "ui.notify",
    "store",
    "file.read",
    "file.write",
  ];
  const over = planPermissionRequest(
    rec(many),
    many.slice(0, PERMISSION_REQUEST_MAX_APIS + 1),
    NOW
  );
  assert.equal(over.ok, false);
  assert.equal(over.reason, "tooMany");

  const wildcard = planPermissionRequest(r, ["*"], NOW);
  assert.equal(wildcard.ok, false, "通配符不能申请");
  pass("空/未知/未声明/超量/通配符申请全部被拒绝");
}

/* ============ 2. scope 覆盖 ============ */
{
  const exact = rec(["secret.read:OPENAI_KEY"]);
  assert.equal(
    planPermissionRequest(exact, ["secret.read:OPENAI_KEY"], NOW).ok,
    true,
    "声明了具体 scope 就能申请它"
  );
  assert.equal(
    planPermissionRequest(exact, ["secret.read:OTHER"], NOW).ok,
    false,
    "声明的 scope 覆盖不了别的名字"
  );
  const wild = rec(["secret.read:*"]);
  assert.equal(
    planPermissionRequest(wild, ["secret.read:ANY"], NOW).ok,
    true,
    "通配 scope 覆盖具体申请"
  );
  pass("scope 覆盖与 manifest 声明一致（permissionCovers 同源）");
}

/* ============ 3. 已授予 / 频率 ============ */
{
  const r = rec(["search.read", "clipboard.read"], ["search.read"]);
  const plan = planPermissionRequest(r, ["search.read", "clipboard.read"], NOW);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.already, ["search.read"]);
  assert.deepEqual(plan.apis, ["clipboard.read"], "只申请缺的那项");

  for (let i = 0; i < PERMISSION_REQUEST_LIMIT; i++) {
    recordPermissionRequest(r, {
      apis: ["clipboard.read"],
      reason: "测试",
      at: NOW - i * 1000,
      result: "denied",
    });
  }
  const throttled = planPermissionRequest(r, ["clipboard.read"], NOW);
  assert.equal(throttled.ok, false);
  assert.equal(throttled.reason, "throttled");
  assert.deepEqual(throttled.throttled, ["clipboard.read"]);
  assert.equal(countRecentRequests(r, "clipboard.read", NOW), PERMISSION_REQUEST_LIMIT);

  // 窗口外的不计入
  const later = NOW + PERMISSION_REQUEST_WINDOW_MS + 1;
  assert.equal(countRecentRequests(r, "clipboard.read", later), 0);
  assert.equal(planPermissionRequest(r, ["clipboard.read"], later).ok, true);

  // 已授予的历史不计入频率（成功授权不是骚扰）
  const g = rec(["clipboard.read"]);
  for (let i = 0; i < 5; i++) {
    recordPermissionRequest(g, {
      apis: ["clipboard.read"],
      reason: "",
      at: NOW,
      result: "granted",
    });
  }
  assert.equal(countRecentRequests(g, "clipboard.read", NOW), 0);
  pass("已授予不重复申请；24h 内 3 次后限流，窗口外重置");
}

/* ============ 4. 历史与文案 ============ */
{
  const r = rec(["search.read"]);
  for (let i = 0; i < PERMISSION_REQUEST_HISTORY_LIMIT + 10; i++) {
    recordPermissionRequest(r, {
      apis: ["search.read"],
      reason: `第 ${i} 次`,
      at: NOW + i,
      result: "denied",
    });
  }
  assert.equal(r.permissionRequests.length, PERMISSION_REQUEST_HISTORY_LIMIT, "历史有上限");
  assert.equal(r.permissionRequests[0].reason, "第 10 次", "丢最旧的");

  const text = permissionRequestText(r, ["search.read", "clipboard.read"], "为了同步剪贴板");
  assert.match(text, /插件「权限测试」请求以下权限/);
  assert.match(text, /【搜索】/, "按分组展示");
  assert.match(text, /【设备与系统】/);
  assert.match(text, /理由：为了同步剪贴板/);

  clearPermissionRequests(r);
  assert.equal(r.permissionRequests, null);
  pass("申请历史上限与弹窗文案（分组 / 风险 / 理由）正确");
}

/* ============ 5. 接线契约 ============ */
{
  const ui = readFileSync(path.join(root, "src/lib/plugins/host/ui-data-api.ts"), "utf8");
  assert.match(ui, /defineRpcNamespace\("permissions"/);
  assert.match(ui, /ctx\.requestPermissions\(/, "申请走宿主注入");
  assert.match(ui, /PERMISSION_REQUEST_MAX_APIS/, "limits 暴露配额");
  // 申请本身不带 permission 字段（否则没权限就申请不了权限）
  const ns = ui.slice(ui.indexOf('defineRpcNamespace("permissions"'), ui.indexOf('defineRpcNamespace("results"'));
  assert.ok(!/permission:\s*"/.test(ns), "权限申请不应要求任何权限");

  const ctx = readFileSync(path.join(root, "src/lib/plugins/host/core.ts"), "utf8");
  assert.match(ctx, /requestPermissions\?:/, "宿主上下文声明注入点");

  const host = readFileSync(path.join(root, "src/windows/search/usePluginHost.ts"), "utf8");
  assert.match(host, /planPermissionRequest\(rec, apis, now\)/);
  assert.match(host, /permissionRequestText\(rec, plan\.apis, reason\)/);
  assert.match(host, /recordPermissionRequest\(rec, \{/, "失败与成功都写历史");

  const panel = readFileSync(
    path.join(root, "src/windows/config/panels/PanelPlugins.vue"),
    "utf8"
  );
  assert.match(panel, /requestHistoryOf\(permPanel\.record\)/);
  assert.match(panel, /申请历史/);
  pass("ms.permissions / 宿主注入 / 面板申请历史的接线完整");
}

console.log(`\n全部通过：${passed} 项权限申请测试`);
