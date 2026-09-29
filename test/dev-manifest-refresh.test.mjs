/**
 * 目录挂载插件的「启动时重读清单」测试。
 *
 * ## 为什么要有这条
 *
 * 目录挂载（`source.dev`）的插件靠 Rust 侧文件监听热重载，但监听只在**应用运行
 * 期间**有效。作者在应用关闭时改了 `plugin.json`（改默认热键、改自启策略、加权限），
 * 重启后没有任何事件来触发重载——记录里还是旧清单，表现是「改了清单却毫无反应，
 * 只能删了重挂」。`refreshDevManifests` 补的就是这一步。
 *
 * ## 覆盖
 *
 *   1. 关闭期间改了清单 → 启动后被重读并写回（版本 / 自启策略跟随）
 *   2. 清单没变 → 不写回（避免每次启动重写注册表 + 重放网关同步）
 *   3. 用户改过的自启选择不被清单重读覆盖
 *   4. 源目录读不出来（目录被删）→ 保留旧记录，不把插件弄丢
 *   5. 半截 JSON（保存中间态）→ 跳过本次，记录不变
 *   6. 清单里的 id 与记录不符 → 跳过（不悄悄改身份）
 *
 * 用法: node test/dev-manifest-refresh.test.mjs
 */
import {
  createPluginRecord,
  loadRegistry,
  saveRegistry,
  PLUGIN_REGISTRY_KEY,
} from "../src/lib/plugins/registry.ts";
import { planReload } from "../src/lib/plugins/dev-reload.ts";
import { manifestChanged } from "../src/lib/plugins/install-builtin.ts";
import { parsePluginManifest } from "../src/lib/plugins/manifest.ts";
import { isKnownPermission } from "../src/lib/plugins/permissions.ts";

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

function mockLocalStorage() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    key: (i) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
  };
  return store;
}

const KEY = `my-search-desktop:${PLUGIN_REGISTRY_KEY}`;
const ID = "com.zhuangjie.screenshot";

/** 造一份清单原文（模拟源目录里的 plugin.json） */
function manifestText(over = {}) {
  return JSON.stringify({
    id: ID,
    name: "截图",
    version: "1.0.0",
    apiVersion: 1,
    permissions: ["ui.inlay"],
    // 声明 backend 时必须同时声明 backend.spawn，否则清单校验直接不过
    optionalPermissions: ["backend.spawn"],
    backend: { entry: "backend/run.cmd", protocol: "jsonrpc-stdio", autostart: "on-demand" },
    ...over,
  });
}

/**
 * 造一条「已挂载的 dev 记录」（清单是**旧**的）。
 *
 * 清单必须走 `parsePluginManifest`：生产环境的记录里存的都是**规范化后**的清单
 * （默认值已补齐），`manifestChanged` 靠对比规范化清单来判断「有没有变」。
 * 用裸 JSON.parse 会与重读时规范化出的清单处处不等，测出假的「每次都变了」。
 */
function makeDevRecord() {
  const parsed = parsePluginManifest(manifestText(), isKnownPermission);
  if (!parsed.ok) throw new Error("测试清单非法：" + parsed.errors.join(","));
  return createPluginRecord({
    manifest: parsed.manifest,
    dir: "plugins/screenshot",
    source: { kind: "folder", ref: "plugins/screenshot", dev: true },
    grants: ["ui.inlay", "backend.spawn"],
    integrity: { sha256: null, signed: false },
  });
}

/**
 * `refreshDevManifests` 的纯逻辑部分（与 install-builtin 里那份逐行同构）。
 *
 * 为什么不直接调真函数：它内部走 `readPluginText` IPC 读源目录，Node 里没有
 * Tauri 环境。这里用同一个 `planReload` + `manifestChanged` 复现「读出来之后
 * 怎么判」，读文件那一步在测试里用参数代替。
 */
function refreshDevManifests(files) {
  const registry = loadRegistry();
  let changed = false;
  for (const rec of registry.plugins) {
    if (!rec.source.dev || !rec.source.ref) continue;
    const manifestTextOf = files[rec.id];
    if (manifestTextOf == null) continue; // 读不出来 → 保留旧记录
    const plan = planReload(rec, manifestTextOf);
    if (!plan.proceed) continue;
    if (!manifestChanged(rec, plan.record) && plan.newPermissions.length === 0) continue;
    const idx = registry.plugins.findIndex((p) => p.id === rec.id);
    if (idx >= 0) registry.plugins[idx] = plan.record;
    changed = true;
  }
  if (changed) saveRegistry(registry);
  return changed;
}

/* ============ 1. 关闭期间改了清单 → 启动后重读并生效 ============ */
{
  mockLocalStorage();
  const rec = makeDevRecord();
  saveRegistry({ version: 1, plugins: [rec] });
  ok(rec.autoStart === "on-demand", "初始：旧清单建议 on-demand，记录 on-demand", rec.autoStart);

  // 作者在应用关闭时把清单改成 v2.0.0 + autostart=always
  const changed = refreshDevManifests({
    [ID]: manifestText({ version: "2.0.0", backend: { entry: "backend/run.cmd", protocol: "jsonrpc-stdio", autostart: "always" } }),
  });
  ok(changed === true, "清单变了 → 检测到需要写回");

  const after = loadRegistry().plugins.find((p) => p.id === ID);
  ok(after !== undefined, "记录仍在");
  ok(after.version === "2.0.0", "版本跟随新清单", after.version);
  ok(after.autoStart === "always", "自启策略跟随新清单建议（用户没改过）", after.autoStart);
}

/* ============ 2. 清单没变 → 不写回 ============ */
{
  mockLocalStorage();
  saveRegistry({ version: 1, plugins: [makeDevRecord()] });
  const changed = refreshDevManifests({ [ID]: manifestText() });
  ok(changed === false, "清单内容一致 → 不写回（避免每次启动重写注册表）");
}

/* ============ 3. 用户改过的选择不被覆盖 ============ */
{
  mockLocalStorage();
  const rec = makeDevRecord();
  rec.autoStart = "never"; // 用户手动关掉自启
  saveRegistry({ version: 1, plugins: [rec] });

  refreshDevManifests({
    [ID]: manifestText({ version: "2.0.0", backend: { entry: "backend/run.cmd", protocol: "jsonrpc-stdio", autostart: "always" } }),
  });
  const after = loadRegistry().plugins.find((p) => p.id === ID);
  ok(after.version === "2.0.0", "版本照常更新");
  ok(after.autoStart === "never", "用户改过的自启选择不被清单重读覆盖", after.autoStart);
}

/* ============ 4. 源目录读不出来 → 保留旧记录 ============ */
{
  mockLocalStorage();
  saveRegistry({ version: 1, plugins: [makeDevRecord()] });
  const changed = refreshDevManifests({ [ID]: null });
  ok(changed === false, "读不到清单（目录被删）→ 不写回");
  const after = loadRegistry().plugins.find((p) => p.id === ID);
  ok(after !== undefined, "插件不会因为读不到清单而消失");
  ok(after.version === "1.0.0", "旧记录原样保留");
}

/* ============ 5. 半截 JSON（保存中间态）→ 跳过 ============ */
{
  mockLocalStorage();
  saveRegistry({ version: 1, plugins: [makeDevRecord()] });
  const changed = refreshDevManifests({ [ID]: '{ "id": "com.zhuangjie.screenshot", "name":' });
  ok(changed === false, "半截 JSON 跳过本次重载");
  const after = loadRegistry().plugins.find((p) => p.id === ID);
  ok(after.version === "1.0.0", "记录未被半截清单改坏");
}

/* ============ 6. 清单 id 与记录不符 → 跳过 ============ */
{
  mockLocalStorage();
  saveRegistry({ version: 1, plugins: [makeDevRecord()] });
  const changed = refreshDevManifests({ [ID]: manifestText({ id: "com.example.other" }) });
  ok(changed === false, "清单 id 不符 → 不悄悄改身份");
  const after = loadRegistry().plugins.find((p) => p.id === ID);
  ok(after.version === "1.0.0", "记录不变");
}

/* ============ 7. manifestChanged 纯函数边界 ============ */
{
  const a = makeDevRecord();
  const b = makeDevRecord();
  ok(manifestChanged(a, b) === false, "同样清单 → 判为未变");

  const newer = { ...makeDevRecord(), version: "9.9.9" };
  ok(manifestChanged(a, newer) === true, "版本变了 → 判为已变");

  const auto = makeDevRecord();
  auto.autoStart = "always";
  ok(manifestChanged(a, auto) === true, "自启策略变了 → 判为已变");

  const named = { ...makeDevRecord(), name: "改了名字" };
  ok(manifestChanged(a, named) === true, "名称变了 → 判为已变");
}

console.log("");
if (fail > 0) {
  console.error(`结果: ${fail} 项失败（${pass} 通过）`);
  process.exit(1);
}
console.log(`结果: 全部通过（${pass} 项）`);
