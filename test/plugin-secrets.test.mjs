/**
 * 密钥能力兑现（P1-2）测试。
 *
 * 覆盖契约：
 *   1. `secret.write` 进入权限目录（high / scoped / backend），且 `secret.read` 一直存在；
 *   2. 密钥按「插件命名空间 + 名字」隔离（dev 回退实现即可验证读写/列举/删除）；
 *   3. `ms.system.getSecret/setSecret/deleteSecret/listSecrets` 的权限门禁；
 *   4. 宿主上下文真的注入了 get/set/delete/list（此前 `ctx.getSecret` 从未注入，
 *      导致 `ms.system.getSecret` 永远返回 null —— 这是本次修的核心 bug）；
 *   5. Rust 侧命令存在、按 scope 二次校验、整份文件走 DPAPI。
 *
 * 用法: node test/plugin-secrets.test.mjs
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
const {
  isKnownPermission,
  permissionCovers,
  riskOf,
  getPermissionSpec,
} = await import("../src/lib/plugins/permissions.ts");
const {
  pluginSecretGet,
  pluginSecretSet,
  pluginSecretDelete,
  pluginSecretList,
} = await import("../src/lib/plugins/ipc.ts");

let passed = 0;
function pass(name) {
  passed++;
  console.log(`PASS  ${name}`);
}

/* ============ 1. 权限目录 ============ */
{
  assert.equal(isKnownPermission("secret.read"), false, "带 scope 的权限不能裸用");
  assert.equal(isKnownPermission("secret.read:OPENAI_KEY"), true);
  assert.equal(isKnownPermission("secret.write"), false);
  assert.equal(isKnownPermission("secret.write:OPENAI_KEY"), true);
  assert.equal(riskOf("secret.read"), "critical");
  assert.equal(riskOf("secret.write"), "high");
  assert.equal(getPermissionSpec("secret.write").scoped, true);
  assert.equal(getPermissionSpec("secret.write").runtime, "backend");
  assert.equal(
    permissionCovers("secret.write:*", "secret.write:ANY"),
    true,
    "通配 scope 覆盖具体名字"
  );
  assert.equal(
    permissionCovers("secret.write:OPENAI", "secret.write:OTHER"),
    false,
    "具体名字不能跨用"
  );
  assert.equal(permissionCovers("secret.read", "secret.write:OPENAI"), false);
  pass("secret.read / secret.write 的权限目录与 scope 语义正确");
}

/* ============ 2. 命名空间隔离与读写 ============ */
{
  const A = "com.example.sec-a";
  const B = "com.example.sec-b";
  await pluginSecretSet(A, "OPENAI_KEY", "sk-a");
  await pluginSecretSet(B, "OPENAI_KEY", "sk-b");
  assert.equal(await pluginSecretGet(A, "OPENAI_KEY"), "sk-a");
  assert.equal(await pluginSecretGet(B, "OPENAI_KEY"), "sk-b", "插件之间互不可见");
  assert.equal(await pluginSecretGet(A, "OTHER"), null, "不存在的名字返回 null");

  await pluginSecretSet(A, "OPENAI_KEY", "sk-a2");
  assert.equal(await pluginSecretGet(A, "OPENAI_KEY"), "sk-a2", "覆盖写生效");

  assert.deepEqual(await pluginSecretList(A), ["OPENAI_KEY"], "只列名字不返回值");
  assert.equal(await pluginSecretDelete(A, "OPENAI_KEY"), true);
  assert.equal(await pluginSecretDelete(A, "OPENAI_KEY"), false, "重复删除幂等");
  assert.equal(await pluginSecretGet(A, "OPENAI_KEY"), null);
  assert.deepEqual(await pluginSecretList(A), []);
  assert.equal(await pluginSecretGet(B, "OPENAI_KEY"), "sk-b", "删 A 不影响 B");

  // 空值等同删除，避免「已设置但为空」的歧义
  await pluginSecretSet(A, "EMPTY", "x");
  await pluginSecretSet(A, "EMPTY", "");
  assert.equal(await pluginSecretGet(A, "EMPTY"), null);
  pass("密钥按插件命名空间隔离，读写/覆盖/列举/删除语义正确");
}

/* ============ 3. API 权限门禁 ============ */
{
  const ui = readFileSync(path.join(root, "src/lib/plugins/host/ui-data-api.ts"), "utf8");
  assert.match(ui, /permission: \(name: string\) => `secret\.read:\$\{String\(name \?\? ""\)\}`/);
  assert.match(ui, /permission: \(name: string\) => `secret\.write:\$\{String\(name \?\? ""\)\}`/);
  assert.match(ui, /ctx\.getSecret\?\.\(pid/, "getSecret 走注入");
  assert.match(ui, /ctx\.setSecret/, "setSecret 走注入");
  assert.match(ui, /ctx\.deleteSecret/, "deleteSecret 走注入");
  assert.match(ui, /listSecrets/, "listSecrets 暴露给插件");
  pass("ms.system 的密钥读写均按 <base>:<name> 授权");
}

/* ============ 4. 宿主注入（修复「永远返回 null」） ============ */
{
  const host = readFileSync(path.join(root, "src/windows/search/usePluginHost.ts"), "utf8");
  assert.match(host, /getSecret: \(id, name\) => pluginSecretGet\(id, name\)/);
  assert.match(host, /setSecret: \(id, name, value\) => pluginSecretSet\(id, name, value\)/);
  assert.match(host, /deleteSecret: \(id, name\) => pluginSecretDelete\(id, name\)/);
  assert.match(host, /listSecrets: \(id\) => pluginSecretList\(id\)/);

  const win = readFileSync(path.join(root, "src/plugin-window.ts"), "utf8");
  assert.match(win, /getSecret: \(id, name\) => pluginSecretGet\(id, name\)/, "独立窗口同样可用");
  pass("主窗口与独立窗口都注入了 ctx.getSecret / setSecret / deleteSecret / listSecrets");
}

/* ============ 5. Rust 纵深防御 ============ */
{
  const rust = readFileSync(path.join(root, "src-tauri/src/plugin_host.rs"), "utf8");
  assert.match(rust, /fn plugin_secret_get/, "读取命令存在");
  assert.match(rust, /fn plugin_secret_set/, "写入命令存在");
  assert.match(rust, /fn plugin_secret_delete/, "删除命令存在");
  assert.match(rust, /fn plugin_secret_list/, "列名命令存在");
  assert.match(rust, /require_scoped_grant\(&plugin_id, "secret\.read", &name\)/);
  assert.match(rust, /require_scoped_grant\(&plugin_id, "secret\.write", &name\)/);
  assert.match(rust, /fn has_scoped_grant/, "scope 二次校验存在");

  const lib = readFileSync(path.join(root, "src-tauri/src/lib.rs"), "utf8");
  for (const cmd of [
    "plugin_secret_get",
    "plugin_secret_set",
    "plugin_secret_delete",
    "plugin_secret_list",
  ]) {
    assert.ok(lib.includes(`plugin_host::${cmd}`), `${cmd} 已注册到 invoke_handler`);
  }

  const store = readFileSync(path.join(root, "src-tauri/src/credential_store.rs"), "utf8");
  assert.match(store, /PLUGIN_SECRETS_DIR/, "密钥落在独立目录");
  assert.match(store, /encrypt_dpapi\(&entries_json\)/, "整份文件 DPAPI 加密");
  assert.match(store, /validate_secret_plugin_id/, "插件 id 校验（防路径穿越）");
  assert.match(store, /MAX_SECRET_VALUE/, "单值长度上限");
  assert.match(store, /MAX_PLUGIN_SECRETS/, "每插件密钥数量上限");
  pass("Rust 侧命令注册、scope 二次校验、DPAPI 与路径/配额防护齐备");
}

console.log(`\n全部通过：${passed} 项密钥能力测试`);
