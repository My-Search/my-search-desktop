/**
 * `ms.sync.*` 宿主 API 的**网关鉴权**纯逻辑测试。
 *
 * 为什么专门测这条：给插件新开一门「能上传用户整份数据」的能力，最容易出事
 * 的地方就是「忘写 permission」或「写了个目录里不存在的串」——那样插件不写
 * 权限也能调，或者用户撤销了授权却仍然生效。这里把三种情形都钉死：
 *
 *   1. 未授予 `sync` → 抛 PluginPermissionError，且**不**触达底层回调；
 *   2. 已授予 `sync` → 正常调用，返回值透传；
 *   3. 插件被禁用 → 抛 PluginUnavailableError（连权限都不看）。
 *   4. `sync` 权限不能靠其它权限覆盖（`store` / `file.read` 都不行）。
 *
 * 用法: node test/plugin-sync-api.test.mjs
 */
import { createHostApi, PluginPermissionError, PluginUnavailableError } from "../src/lib/plugins/host.ts";
import { createPluginRecord } from "../src/lib/plugins/registry.ts";

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

/** 最小合法清单 */
const manifestOf = (perms = [], id = "com.example.synctest") => ({
  id,
  name: "同步测试插件",
  version: "1.0.0",
  apiVersion: 1,
  entry: "ui/index.html",
  permissions: perms,
});

/**
 * 造一套「注册表 + 上下文」，底层的 synсNow/syncStatus 用计数器替身，
 * 以便断言「被网关拦下时底层根本没被调用」。
 */
function harness({ grants = ["sync"], enabled = true } = {}) {
  const rec = createPluginRecord({
    manifest: manifestOf(["sync"]),
    dir: "plugins/com.example.synctest",
    source: { kind: "file", ref: "x.mspp" },
    grants,
  });
  rec.enabled = enabled;

  const hits = { now: 0, status: 0 };
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
    syncNow: async () => {
      hits.now++;
      return { enabled: true, status: "idle", lastSyncAt: 123, lastError: "" };
    },
    syncStatus: () => {
      hits.status++;
      return { enabled: true, status: "uploading", lastSyncAt: 99, lastError: "" };
    },
  };
  return { api: createHostApi(rec.id, ctx), hits };
}

const expectThrow = async (fn, type, name) => {
  try {
    await fn();
    ok(false, name, "本应抛错却成功返回");
  } catch (e) {
    ok(e instanceof type, name, e?.name ?? String(e));
  }
};

/* ============ 1. 已授予 sync → 正常调用 ============ */
{
  const { api, hits } = harness({ grants: ["sync"] });
  const st = await api.sync.trigger();
  ok(hits.now === 1, "trigger 触达底层回调");
  ok(st.lastSyncAt === 123, "返回值原样透传", JSON.stringify(st));
  ok(st.enabled === true, "enabled 透传");

  const s2 = api.sync.status();
  ok(hits.status === 1, "status 触达底层回调");
  ok(s2.status === "uploading", "status 透传");
}

/* ============ 2. 未授予 sync → 网关拦截，不触达底层 ============ */
{
  const { api, hits } = harness({ grants: [] });
  await expectThrow(() => api.sync.trigger(), PluginPermissionError, "未授权 trigger 被拒");
  await expectThrow(() => api.sync.status(), PluginPermissionError, "未授权 status 被拒");
  ok(hits.now === 0, "被拒时底层 trigger 未被调用");
  ok(hits.status === 0, "被拒时底层 status 未被调用");
}

/* ============ 3. 其它权限不能覆盖 sync ============ */
{
  for (const other of ["store", "file.read", "search.read", "net.fetch:https://a.com/*"]) {
    const { api } = harness({ grants: [other] });
    await expectThrow(
      () => api.sync.trigger(),
      PluginPermissionError,
      `授予 ${other} 不能调用 sync.trigger`
    );
  }
}

/* ============ 4. 插件被禁用 → 先拦「不可用」 ============ */
{
  const { api, hits } = harness({ grants: ["sync"], enabled: false });
  await expectThrow(() => api.sync.trigger(), PluginUnavailableError, "禁用插件的 trigger 被拒");
  ok(hits.now === 0, "禁用时底层未被调用");
}

/* ============ 5. 未注入同步能力（如浏览器调试）时的行为 ============ */
{
  const rec = createPluginRecord({
    manifest: manifestOf(["sync"]),
    dir: "plugins/com.example.synctest",
    source: { kind: "file", ref: "x.mspp" },
    grants: ["sync"],
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
    // 刻意不注入 syncNow / syncStatus
  };
  const api = createHostApi(rec.id, ctx);
  // status 退化为「未开启」而不是抛错：插件读状态不该因为它没被注入就炸
  const st = api.sync.status();
  ok(st.enabled === false, "无注入时 status 退化为未开启", JSON.stringify(st));
  // trigger 必须明确报错：静默假装同步成功会让插件显示错误的状态
  await expectThrow(() => api.sync.trigger(), Error, "无注入时 trigger 明确报错");
}

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
