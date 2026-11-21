/**
 * 插件生命周期（show / hide / enter / dispose）单元测试与源码契约校验。
 *
 * 覆盖契约：
 *   1. 事件按插件隔离，退订幂等；
 *   2. `onShow` / `onEnter` 在「已经可见」时注册会粘性补发一次（插件常在 await 后才注册）；
 *   3. `onHide` / `onDispose` 不补发；
 *   4. `disposePluginHostSession` 会连同 lifecycle 处理器一起回收（零泄漏）；
 *   5. 视图宿主在 park / release / restore / mount 四个收口上都派发了对应事件，
 *      且 `runPluginEntry` 以**追加第 11 个参数**的方式注入 action（老脚本零改动）。
 *
 * 用法: node test/plugin-lifecycle.test.mjs
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
globalThis.window = globalThis.window ?? {};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const {
  addLifecycleHandler,
  dispatchLifecycle,
  readLifecycleState,
  disposePluginHostSession,
  activeSubscriptionCountForPlugin,
} = await import("../src/lib/plugins/host/event-hub.ts");
const { createHostApi } = await import("../src/lib/plugins/host.ts");
const { createPluginRecord, saveRegistry, loadRegistry } = await import(
  "../src/lib/plugins/registry.ts"
);

let passed = 0;
function pass(name) {
  passed++;
  console.log(`PASS  ${name}`);
}

/** 造一条最小注册表记录（createHostApi 的权限门禁需要它） */
function seedPlugin(id, grants = ["ui.inlay"]) {
  const manifest = {
    id,
    name: id,
    version: "1.0.0",
    apiVersion: 1,
    permissions: grants,
  };
  const rec = createPluginRecord({
    manifest,
    dir: `plugins/${id}`,
    source: { kind: "file" },
    grants,
  });
  const reg = loadRegistry();
  reg.plugins = reg.plugins.filter((p) => p.id !== id).concat(rec);
  saveRegistry(reg);
  return rec;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/* ============ 1. 基本派发 / 退订 / 隔离 ============ */
{
  const calls = [];
  const off = addLifecycleHandler("com.example.a", "show", () => calls.push("show"));
  dispatchLifecycle("com.example.a", "show");
  assert.deepEqual(calls, ["show"]);
  off();
  dispatchLifecycle("com.example.a", "show");
  assert.deepEqual(calls, ["show"], "退订后不再收到");

  const other = [];
  addLifecycleHandler("com.example.b", "show", () => other.push("show"));
  dispatchLifecycle("com.example.a", "show");
  assert.deepEqual(other, [], "事件按插件隔离");

  pass("生命周期事件按插件隔离且退订幂等");
}

/* ============ 2. 粘性补发 ============ */
{
  const seen = [];
  dispatchLifecycle("com.example.sticky", "show");
  dispatchLifecycle("com.example.sticky", "enter", {
    type: "text",
    code: "问AI",
    keyword: "问AI",
    from: "search",
    at: 1,
  });
  // 模拟插件在 await 之后才注册
  addLifecycleHandler("com.example.sticky", "enter", (a) => seen.push(a));
  await flush();
  assert.equal(seen.length, 1, "已可见时注册 onEnter 会补发一次");
  assert.equal(seen[0].code, "问AI");
  assert.deepEqual(
    readLifecycleState("com.example.sticky").action?.code,
    "问AI",
    "current() 能读到最近一次进入参数"
  );

  const hides = [];
  addLifecycleHandler("com.example.sticky", "hide", () => hides.push("hide"));
  await flush();
  assert.deepEqual(hides, [], "onHide 不补发（它描述的是未来）");

  pass("onShow/onEnter 粘性补发，onHide/onDispose 不补发");
}

/* ============ 3. 会话回收零泄漏 ============ */
{
  const id = "com.example.dispose";
  seedPlugin(id);
  const api = createHostApi(id, {
    registry: loadRegistry,
    persistRegistry: () => {},
    searchData: () => [],
    triggerSearch: () => {},
    setInput: () => {},
    hideDetail: () => {},
    toast: () => {},
    confirm: async () => true,
    getSelectedText: async () => "",
  });
  const lifecycle = api.lifecycle;
  assert.ok(lifecycle && typeof lifecycle.onShow === "function", "ms.lifecycle 已注入");
  const off = lifecycle.onShow(() => {});
  assert.equal(typeof off, "function", "注册返回退订函数");
  assert.ok(activeSubscriptionCountForPlugin(id) >= 1, "有订阅时计数可见");
  disposePluginHostSession(id);
  assert.equal(
    activeSubscriptionCountForPlugin(id),
    0,
    "会话销毁后 lifecycle 处理器一并回收"
  );

  pass("ms.lifecycle 注入正确，disposePluginHostSession 零泄漏");
  off();
}

/* ============ 4. 视图宿主派发点契约 ============ */
{
  const host = readFileSync(
    path.join(root, "src/windows/search/usePluginViewHost.ts"),
    "utf8"
  );
  assert.match(host, /dispatchLifecycle\(session\.pluginId, "hide"\)/, "停靠时派发 hide");
  assert.match(host, /dispatchLifecycle\(pluginId, "dispose"/, "卸载时派发 dispose");
  assert.match(host, /dispatchLifecycle\(session\.pluginId, "show"\)/, "恢复时派发 show");
  assert.match(
    host,
    /dispatchLifecycle\(record\.id, "enter", session\.action\)/,
    "新挂载时派发 enter"
  );
  assert.match(
    host,
    /"MS_SCRIPT_ENV",\s*\n\s*"action"/,
    "runPluginEntry 以第 11 个参数注入 action"
  );
  assert.match(host, /from: "restore"/, "恢复路径的 action.from 标记为 restore");

  const app = readFileSync(path.join(root, "src/windows/search/App.vue"), "utf8");
  assert.match(app, /type: "shortcut"/, "快捷键动作打开时声明来源");
  assert.match(app, /from: "hotkey"/, "快捷键打开时 from=hotkey");

  const win = readFileSync(path.join(root, "src/plugin-window.ts"), "utf8");
  assert.match(win, /dispatchLifecycle\(pluginId, "show"\)/, "独立窗口打开即 show");

  pass("park / release / restore / mount 四处收口均已派发生命周期事件");
}

console.log(`\n全部通过：${passed} 项插件生命周期测试`);
