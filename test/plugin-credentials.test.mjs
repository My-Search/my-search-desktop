/**
 * P2-3 / P2-5：凭据下沉（env 值进 Rust、网络凭据由 Rust 注入）。
 *
 * 契约：
 *   1. 首启迁移：旧 localStorage 明文 → 写入凭据库成功后才删除旧键；
 *   2. 凭据库已有数据 → 以远端为准，旧键清除；
 *   3. 迁移写失败 → 保留旧值，不丢配置；
 *   4. `ms.net.credentials` 受 `net.fetch:<origin>` 约束；列表只返回元数据、不含值；
 *   5. 凭据绑定 origin：跨 origin 使用被拒绝（dev 路径同样校验）；
 *   6. Rust 侧：host_env_load/save、plugin_net_credential_set/list/delete 已注册，
 *      `plugin_net_fetch` 支持 credential 注入且值不经前端。
 *
 * 用法: node test/plugin-credentials.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
  key: (i) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
};

const envStore = await import("../src/lib/plugins/env-store.ts");
const { createHostApi, PluginPermissionError } = await import("../src/lib/plugins/host.ts");
const { createPluginRecord } = await import("../src/lib/plugins/registry.ts");
const ipc = await import("../src/lib/plugins/ipc.ts");

let passed = 0;
function pass(name) {
  passed++;
  console.log(`PASS  ${name}`);
}

const { ENV_VARS_KEY, __resetEnvStoreForTests, initEnvStore, loadEnvVars } = envStore;

const FULL_KEY = `my-search-desktop:${ENV_VARS_KEY}`;

function seedLegacy(value = "sk-legacy") {
  store.set(
    FULL_KEY,
    JSON.stringify([
      { name: "MY_KEY", value, secret: true, createdAt: 1, updatedAt: 1 },
    ])
  );
}

/* ============ 1. 首启迁移 ============ */
{
  store.clear();
  seedLegacy();
  __resetEnvStoreForTests();
  const saved = [];
  await initEnvStore({
    load: async () => null,
    save: async (vars) => {
      saved.push(...vars);
    },
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].name, "MY_KEY");
  assert.equal(saved[0].value, "sk-legacy", "值写进凭据库");
  assert.equal(store.has(FULL_KEY), false, "迁移成功后删除旧明文键");
  assert.equal(loadEnvVars()[0].value, "sk-legacy");
  pass("旧 localStorage 明文迁移到凭据库，成功后删除旧键");
}

/* ============ 2. 凭据库为准 ============ */
{
  store.clear();
  seedLegacy("sk-stale");
  __resetEnvStoreForTests();
  await initEnvStore({
    load: async () => [
      { name: "REMOTE", value: "sk-remote", description: "来自 Rust", secret: true },
    ],
    save: async () => {
      throw new Error("不应写入");
    },
  });
  const vars = loadEnvVars();
  assert.deepEqual(vars.map((v) => v.name), ["REMOTE"]);
  assert.equal(vars[0].value, "sk-remote");
  assert.equal(store.has(FULL_KEY), false, "权威源存在时清掉旧键");
  pass("凭据库已有配置时以它为准，旧明文键被清除");
}

/* ============ 3. 迁移失败不丢数据 ============ */
{
  store.clear();
  seedLegacy("sk-keep");
  __resetEnvStoreForTests();
  await initEnvStore({
    load: async () => null,
    save: async () => {
      throw new Error("DPAPI 不可用");
    },
  });
  assert.equal(loadEnvVars()[0].value, "sk-keep");
  assert.equal(store.has(FULL_KEY), true, "写失败必须保留旧值");
  assert.equal(JSON.parse(store.get(FULL_KEY))[0].value, "sk-keep");
  pass("迁移写失败时保留 localStorage 旧值（不静默丢配置）");
}

/* ============ 4. 网络凭据 API ============ */
const PLUGIN = "com.example.netcred";
function harness(grants) {
  const rec = createPluginRecord({
    manifest: {
      id: PLUGIN,
      name: "网络凭据测试",
      version: "1.0.0",
      apiVersion: 1,
      entry: "ui/index.html",
      permissions: grants,
    },
    dir: `plugins/${PLUGIN}`,
    source: { kind: "file" },
    grants,
  });
  const ctx = {
    registry: () => ({ version: 1, plugins: [rec] }),
    persistRegistry: () => {},
    searchData: () => [],
    triggerSearch: () => {},
    setInput: () => {},
    hideDetail: () => {},
    toast: () => {},
    confirm: async () => true,
    getSelectedText: async () => "",
  };
  return createHostApi(PLUGIN, ctx);
}

{
  const api = harness(["net.fetch:https://api.example.com/*"]);
  await api.net.credentials.set("token", "sk-123", {
    scheme: "bearer",
    origin: "https://api.example.com",
  });
  const list = await api.net.credentials.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "token");
  assert.equal(list[0].origin, "https://api.example.com");
  assert.equal("value" in list[0], false, "★ 列表绝不返回值");
  assert.equal(JSON.stringify(list).includes("sk-123"), false, "★ 元数据里没有明文");

  const [header, value] = ipc.devNetCredentialHeader(PLUGIN, "token", "https://api.example.com");
  assert.equal(header, "authorization");
  assert.equal(value, "Bearer sk-123", "仅在请求注入时使用，不经过插件");

  assert.throws(
    () => ipc.devNetCredentialHeader(PLUGIN, "token", "https://evil.example.com"),
    /只允许发往/
  );
  assert.equal(await api.net.credentials.remove("token"), true);
  pass("凭据只回元数据；注入时绑定 origin，跨站使用被拒绝");
}

/* ============ 5. 权限门禁 ============ */
{
  const api = harness(["store"]);
  await assert.rejects(
    async () =>
      api.net.credentials.set("x", "v", { scheme: "bearer", origin: "https://api.example.com" }),
    PluginPermissionError
  );
  await assert.rejects(async () => api.net.credentials.list(), PluginPermissionError);

  const wrongScope = harness(["net.fetch:https://other.example.com/*"]);
  await assert.rejects(
    async () =>
      wrongScope.net.credentials.set("x", "v", {
        scheme: "bearer",
        origin: "https://api.example.com",
      }),
    PluginPermissionError
  );
  pass("无 net.fetch / scope 不覆盖 origin 时，凭据操作被拒绝");
}

/* ============ 6. Rust 与源码契约 ============ */
{
  const rust = readFileSync(path.join(root, "src-tauri/src/plugin_host.rs"), "utf8");
  assert.match(rust, /plugin_net_credential_set/);
  assert.match(rust, /plugin_net_credential_list/);
  assert.match(rust, /plugin_net_credential_delete/);
  assert.match(rust, /host_env_load/);
  assert.match(rust, /host_env_save/);
  assert.match(rust, /credential\.filter/, "net fetch 支持 credential 注入");
  assert.match(rust, /cred\.origin != target_origin/, "凭据绑定 origin");

  const lib = readFileSync(path.join(root, "src-tauri/src/lib.rs"), "utf8");
  for (const cmd of [
    "host_env_load",
    "host_env_save",
    "plugin_net_credential_set",
    "plugin_net_credential_list",
    "plugin_net_credential_delete",
  ]) {
    assert.ok(lib.includes(`plugin_host::${cmd}`), `命令已注册：${cmd}`);
  }

  const credential = readFileSync(path.join(root, "src-tauri/src/credential_store.rs"), "utf8");
  assert.match(credential, /HOST_ENV_FILE/);
  assert.match(credential, /NET_CREDENTIALS_DIR/);
  assert.match(credential, /encrypt_dpapi\(&json_text\)/, "env 值用 DPAPI");
  assert.match(credential, /encrypt_dpapi\(&entries_json\)/, "网络凭据用 DPAPI");

  const main = readFileSync(path.join(root, "src/main.ts"), "utf8");
  const config = readFileSync(path.join(root, "src/config.ts"), "utf8");
  const win = readFileSync(path.join(root, "src/plugin-window.ts"), "utf8");
  assert.match(main, /initEnvStore\(\)/, "主窗口挂载前初始化");
  assert.match(config, /initEnvStore\(\)/, "设置窗口挂载前初始化");
  assert.match(win, /initEnvStore\(\)/, "插件窗口网关同步前初始化");
  pass("Rust 命令 / DPAPI 存储 / 三个入口的初始化接线完整");
}

console.log(`\n全部通过：${passed} 项凭据下沉测试`);
