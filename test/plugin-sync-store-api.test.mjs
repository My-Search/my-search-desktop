/**
 * `ms.store.sync.*`（插件云数据 store）的**网关鉴权 + 读写语义**纯逻辑测试。
 *
 * 为什么专门测这条：云数据是「会被上传到云端」的数据，必须满足两件事：
 *   1. **没有 `store` 权限就用不了**（与 `ms.store` 同一门禁），且被拒时绝不落盘；
 *   2. 授权后 get / set / remove / getAll / usage 的行为符合 chrome.storage.sync
 *      的直觉（缺省 fallback、键不存在返回 null、remove 返回是否存在）。
 *
 * 配额（单键 64KB / 单插件 512KB / 合计 8MB / 500 键）是 Rust 侧强制的，
 * 用 `cd src-tauri && cargo test --lib` 覆盖；这里只钉前端这一层。
 *
 * 用法: node test/plugin-sync-store-api.test.mjs
 */
import { createHostApi, PluginPermissionError, PluginUnavailableError } from "../src/lib/plugins/host.ts";
import { createPluginRecord } from "../src/lib/plugins/registry.ts";
import { devSyncStore } from "../src/lib/plugins/ipc.ts";

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

const PLUGIN_ID = "com.example.syncstoretest";

const manifestOf = (perms = []) => ({
  id: PLUGIN_ID,
  name: "云数据测试插件",
  version: "1.0.0",
  apiVersion: 1,
  entry: "ui/index.html",
  permissions: perms,
});

function harness({ grants = ["store"], enabled = true } = {}) {
  const rec = createPluginRecord({
    manifest: manifestOf(grants),
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

const expectThrow = async (fn, type, name) => {
  try {
    await fn();
    ok(false, name, "本应抛错却成功返回");
  } catch (e) {
    ok(e instanceof type, name, e?.name ?? String(e));
  }
};

/* ============ 1. 有 store 权限：完整读写语义 ============ */
{
  devSyncStore.delete(PLUGIN_ID);
  const { api } = harness({ grants: ["store"] });

  const usage = await api.store.sync.set("pref", { theme: "dark" });
  ok(usage && typeof usage === "object", "set 返回用量对象", JSON.stringify(usage));
  ok(usage.keys === 1, "用完量报告键数", String(usage.keys));
  ok(usage.bytes > 0, "用完量报告字节数", String(usage.bytes));

  const got = await api.store.sync.get("pref");
  ok(got && got.theme === "dark", "get 取回写入的值");

  const fallback = await api.store.sync.get("missing", "默认");
  ok(fallback === "默认", "缺键时返回 fallback");

  const missing = await api.store.sync.get("missing");
  ok(missing === null, "缺键且无 fallback 时返回 null");

  const all = await api.store.sync.getAll();
  ok(all && all.pref && all.pref.theme === "dark", "getAll 返回全部键值");

  const removed = await api.store.sync.remove("pref");
  ok(removed === true, "remove 返回「原本存在」");
  const removedAgain = await api.store.sync.remove("pref");
  ok(removedAgain === false, "remove 幂等：第二次返回 false");

  await api.store.sync.set("a", 1);
  await api.store.sync.clear();
  const afterClear = await api.store.sync.getAll();
  ok(Object.keys(afterClear).length === 0, "clear 清空全部键");
}

/* ============ 2. 没有 store 权限：网关拦截且不落盘 ============ */
{
  devSyncStore.delete(PLUGIN_ID);
  const { api } = harness({ grants: [] });
  await expectThrow(() => api.store.sync.set("x", 1), PluginPermissionError, "未授权 set 被拒");
  await expectThrow(() => api.store.sync.get("x"), PluginPermissionError, "未授权 get 被拒");
  await expectThrow(() => api.store.sync.getAll(), PluginPermissionError, "未授权 getAll 被拒");
  await expectThrow(() => api.store.sync.remove("x"), PluginPermissionError, "未授权 remove 被拒");
  await expectThrow(() => api.store.sync.clear(), PluginPermissionError, "未授权 clear 被拒");
  await expectThrow(() => api.store.sync.usage(), PluginPermissionError, "未授权 usage 被拒");
  ok(devSyncStore.get(PLUGIN_ID) === undefined, "被拒时不写入任何云数据");
}

/* ============ 3. 其它权限不能替代 store ============ */
{
  devSyncStore.delete(PLUGIN_ID);
  for (const other of ["sync", "file.read", "search.read", "ui.notify"]) {
    const { api } = harness({ grants: [other] });
    await expectThrow(
      () => api.store.sync.set("x", 1),
      PluginPermissionError,
      `授予 ${other} 不能调用 store.sync.set`
    );
  }
  ok(devSyncStore.get(PLUGIN_ID) === undefined, "替代权限下也没有落盘");
}

/* ============ 4. 插件被禁用：先拦「不可用」 ============ */
{
  devSyncStore.delete(PLUGIN_ID);
  const { api } = harness({ grants: ["store"], enabled: false });
  await expectThrow(() => api.store.sync.set("x", 1), PluginUnavailableError, "禁用插件的 set 被拒");
  ok(devSyncStore.get(PLUGIN_ID) === undefined, "禁用时未落盘");
}

/* ============ 5. 命名空间形状：`ms.store` 既有方法不受影响 ============ */
{
  const { api } = harness({ grants: ["store"] });
  ok(typeof api.store.get === "function", "ms.store.get 仍在");
  ok(typeof api.store.set === "function", "ms.store.set 仍在");
  ok(typeof api.store.sync === "object", "ms.store.sync 是独立命名空间");
  ok(typeof api.store.sync.set === "function", "ms.store.sync.set 存在");
}

devSyncStore.clear();
console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
