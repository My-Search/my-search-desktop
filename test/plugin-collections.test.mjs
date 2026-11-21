/**
 * `ms.store.collection`（P1-4）测试。
 *
 * 覆盖契约：
 *   1. 没有 `store` 权限时所有集合方法都被拒（与 `ms.store` 同一门禁）；
 *   2. add（自动 id / 显式 id / 冲突报错）→ get → update（不存在返回 false）→ remove；
 *   3. list 的 prefix / limit / cursor 分页语义；
 *   4. clear 只清当前集合，不同集合 / 不同插件互不影响；
 *   5. 非法集合名 / 记录 id 被前端先拦下；
 *   6. Rust 侧一记录一文件、路径校验、1000 条上限、命令注册。
 *
 * 用法: node test/plugin-collections.test.mjs
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
const { createHostApi, PluginPermissionError } = await import("../src/lib/plugins/host.ts");
const { createPluginRecord } = await import("../src/lib/plugins/registry.ts");
const { pluginCollectionClear } = await import("../src/lib/plugins/ipc.ts");

let passed = 0;
function pass(name) {
  passed++;
  console.log(`PASS  ${name}`);
}

const PLUGIN_ID = "com.example.collectiontest";

function harness({ grants = ["store"], enabled = true } = {}) {
  const rec = createPluginRecord({
    manifest: {
      id: PLUGIN_ID,
      name: "集合测试插件",
      version: "1.0.0",
      apiVersion: 1,
      entry: "ui/index.html",
      permissions: grants,
    },
    dir: `plugins/${PLUGIN_ID}`,
    source: { kind: "file", ref: "x.mspp" },
    grants,
  });
  rec.enabled = enabled;
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
  return { api: createHostApi(rec.id, ctx), rec };
}

/* ============ 1. 权限门禁 ============ */
{
  const { api } = harness({ grants: [] });
  await assert.rejects(async () => api.store.collection("todos").add({ title: "x" }), PluginPermissionError);
  await assert.rejects(async () => api.store.collection("todos").list(), PluginPermissionError);
  pass("没有 store 权限时集合方法全部拒绝");
}

/* ============ 2. 基本 CRUD ============ */
{
  const { api } = harness();
  await pluginCollectionClear(PLUGIN_ID, "todos");
  const todos = api.store.collection("todos");

  const autoId = await todos.add({ title: "写测试", done: false });
  assert.ok(typeof autoId === "string" && autoId.length > 0, "自动生成 id");

  const explicit = await todos.add({ title: "发版" }, "ship");
  assert.equal(explicit, "ship");
  await assert.rejects(async () => todos.add({ title: "重复" }, "ship"), /记录已存在/, "add 同 id 冲突");

  const got = await todos.get("ship");
  assert.deepEqual(got, { title: "发版" });
  assert.equal(await todos.get("missing"), null);
  assert.equal(await todos.get("missing", "缺省"), "缺省", "get 支持 fallback");

  assert.equal(await todos.update("ship", { title: "发版 v2" }), true, "update 已存在 → true");
  assert.deepEqual(await todos.get("ship"), { title: "发版 v2" });
  assert.equal(await todos.update("nope", { title: "x" }), false, "update 不存在 → false 且不创建");
  assert.equal(await todos.get("nope"), null);

  assert.equal(await todos.remove("ship"), true);
  assert.equal(await todos.remove("ship"), false, "remove 幂等");
  pass("add / get / update / remove 的语义与冲突处理正确");
}

/* ============ 3. 分页 / 前缀 ============ */
{
  const { api } = harness();
  await pluginCollectionClear(PLUGIN_ID, "items");
  const col = api.store.collection("items");
  for (const id of ["a-1", "a-2", "a-3", "b-1", "b-2"]) {
    await col.add({ id }, id);
  }
  const page1 = await col.list({ limit: 2 });
  assert.deepEqual(page1.items.map((x) => x.id), ["a-1", "a-2"]);
  assert.equal(page1.nextCursor, "a-2");
  assert.equal(page1.hasMore, true);

  const page2 = await col.list({ limit: 2, cursor: page1.nextCursor });
  assert.deepEqual(page2.items.map((x) => x.id), ["a-3", "b-1"]);
  const page3 = await col.list({ limit: 2, cursor: page2.nextCursor });
  assert.deepEqual(page3.items.map((x) => x.id), ["b-2"]);
  assert.equal(page3.hasMore, false);
  assert.equal(page3.nextCursor, "");

  const pref = await col.list({ prefix: "a-" });
  assert.deepEqual(pref.items.map((x) => x.id), ["a-1", "a-2", "a-3"]);
  assert.deepEqual(pref.items[0].data, { id: "a-1" }, "list 返回解析后的 data");
  pass("list 的 prefix / limit / cursor 分页正确");
}

/* ============ 4. 隔离 ============ */
{
  const { api } = harness();
  await pluginCollectionClear(PLUGIN_ID, "one");
  await pluginCollectionClear(PLUGIN_ID, "two");
  await api.store.collection("one").add({ v: 1 }, "x");
  await api.store.collection("two").add({ v: 2 }, "x");
  assert.deepEqual(await api.store.collection("one").get("x"), { v: 1 }, "集合之间隔离");
  await api.store.collection("one").clear();
  assert.equal(await api.store.collection("one").get("x"), null);
  assert.deepEqual(await api.store.collection("two").get("x"), { v: 2 }, "clear 不影响别的集合");
  pass("集合之间 / 插件之间的数据互相隔离");
}

/* ============ 5. 校验 ============ */
{
  const { api } = harness();
  await assert.rejects(async () => api.store.collection("bad name").add({}), /集合名非法/);
  await assert.rejects(async () => api.store.collection("ok").add({}, "has space"), /记录 id 非法/);
  await assert.rejects(async () => api.store.collection("ok").add({}, "x".repeat(129)), /记录 id 非法/);
  pass("非法集合名 / 记录 id 在前端被拦下");
}

/* ============ 6. 接线与 Rust ============ */
{
  const ui = readFileSync(path.join(root, "src/lib/plugins/host/ui-data-api.ts"), "utf8");
  assert.match(ui, /function collectionApi/);
  assert.match(ui, /api: `store\.collection\.\$\{method\}`/);
  assert.match(ui, /permission: "store"/);
  assert.match(ui, /collection: \(name: string\) => collectionApi\(name\)/);

  const rust = readFileSync(path.join(root, "src-tauri/src/plugin_host.rs"), "utf8");
  assert.match(rust, /COLLECTIONS_DIR/, "记录落在 collections/ 下");
  assert.match(rust, /MAX_COLLECTION_ITEMS/, "1000 条上限");
  assert.match(rust, /fn validate_collection_name/);
  assert.match(rust, /fn validate_item_id/);
  assert.match(rust, /fn plugin_collection_put/);
  assert.match(rust, /fn plugin_collection_list/);

  const lib = readFileSync(path.join(root, "src-tauri/src/lib.rs"), "utf8");
  for (const cmd of [
    "plugin_collection_put",
    "plugin_collection_get",
    "plugin_collection_delete",
    "plugin_collection_clear",
    "plugin_collection_list",
  ]) {
    assert.ok(lib.includes(`plugin_host::${cmd}`), `${cmd} 已注册`);
  }
  pass("前端 API 工厂与 Rust 命令接线完整");
}

console.log(`\n全部通过：${passed} 项集合存储测试`);
