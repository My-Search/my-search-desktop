/**
 * 同步作用域（`src/lib/sync/scope.ts`）测试。
 *
 * 钉死的语义：
 *   - `never`：凭据 / 可重建缓存 / 一次性信号，不采集、不还原、不触发同步；
 *   - `device`：窗口尺寸、最近附件路径、更新下载偏好等只在本机生效；
 *   - `account`：其余用户数据跨设备同步。
 *
 * 用法: node test/sync-scope.test.mjs
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
register(pathToFileURL(path.join(root, "test/_cloud-stub-loader.mjs")).href, pathToFileURL(root));

const scope = await import(
  pathToFileURL(path.join(root, "src/lib/sync/scope.ts")).href
);

let passed = 0;
const failures = [];
function eq(name, actual, expected) {
  if (actual === expected) {
    passed += 1;
  } else {
    failures.push(`${name} — 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}
function ok(name, cond, extra = "") {
  if (cond) {
    passed += 1;
  } else {
    failures.push(`${name}${extra ? ` — ${extra}` : ""}`);
  }
}

/* ===================== 1) account：该同步 ===================== */
for (const key of [
  "subscribes",
  "ITEM_WEIGHT_CACHE_KEY",
  "HISTORY_CACHE_KEY",
  "PLUGIN_REGISTRY_KEY",
  "PLUGIN_DATA:clipboard:index.json",
  "PLUGIN_DATA:todo:items",
]) {
  eq(`account: ${key}`, scope.scopeOfKey(key), "account");
  ok(`account 触发同步: ${key}`, scope.shouldSyncKey(key));
}

/* ===================== 2) device：只在本机 ===================== */
for (const key of [
  "RECENT_ATTACH_KEY",
  "auto_download_update",
  "PLUGIN_DATA:clipboard:viewSize",
  "PLUGIN_DATA:screenshot:viewSize",
]) {
  eq(`device: ${key}`, scope.scopeOfKey(key), "device");
  ok(`device 不触发同步: ${key}`, !scope.shouldSyncKey(key));
}

/* ===================== 3) never：绝不碰 ===================== */
for (const key of [
  "USER_GITHUB_TOKEN_CACHE_KEY",
  "SYNC_CONFIG_CACHE_KEY",
  "SYNC_STATE_CACHE_KEY",
  "SEARCH_DATA_KEY",
  "OLD_SEARCH_DATAS_KEY",
  "SUBSCRIBE_FINGERPRINT_CACHE_KEY",
  "PLUGIN_RESTART_MARKS_CACHE_KEY",
  "script:foo",
]) {
  eq(`never: ${key}`, scope.scopeOfKey(key), "never");
  ok(`never 不触发同步: ${key}`, !scope.shouldSyncKey(key));
}

/* ===================== 4) 边界：前缀不能误伤 ===================== */
eq("普通 script 词不误伤", scope.scopeOfKey("scripture"), "account");
eq(
  "viewSize 只在插件数据后缀生效",
  scope.scopeOfKey("viewSize"),
  "account"
);
eq(
  "plugin-data 大写前缀不命中 viewSize 规则",
  scope.scopeOfKey("PLUGIN_DATA:clipboard:ViewSize"),
  "account"
);

/* ===================== 5) 诊断文案 ===================== */
ok("describeScope 给出 device 理由", scope.describeScope("RECENT_ATTACH_KEY").reason.includes("设备"));
ok("describeScope 给出 never 理由", scope.describeScope("script:foo").reason.includes("前缀"));
ok("describeScope 给出 account 理由", scope.describeScope("theme").reason.includes("跨设备"));

/* ===================== 6) 开发挂载记录按设备过滤 ===================== */
const registry = {
  version: 1,
  plugins: [
    { id: "market-a", source: { kind: "market", ref: "https://x" } },
    { id: "dev-b", source: { kind: "folder", dev: true, ref: "D:\\code\\dev-b" } },
    { id: "builtin-c", source: { kind: "builtin" } },
  ],
};
ok(
  "dev 记录识别",
  scope.isDevicePluginRecord({ id: "dev", source: { kind: "folder", dev: true } })
);
ok(
  "非 dev 记录不误伤",
  !scope.isDevicePluginRecord({ id: "m", source: { kind: "market" } })
);
eq(
  "设备插件 id 集合",
  JSON.stringify([...scope.devicePluginIdsOfRegistry(registry)]),
  '["dev-b"]'
);
const stripped = scope.registryForSync(registry);
eq("上传前 dev 记录仍保留（改写为普通安装副本）", stripped.plugins.length, 3);
const dev = stripped.plugins.find((p) => p.id === "dev-b");
eq("上传前 dev 记录目录改为 plugins/<id>", dev.dir, "plugins/dev-b");
eq("上传前 dev 标记被移除", dev.source.dev, undefined);
eq("上传前来源改为普通文件安装", dev.source.kind, "file");
ok("上传前保留市场/内置", stripped.plugins.some((p) => p.id === "market-a") && stripped.plugins.some((p) => p.id === "builtin-c"));

const remote = {
  version: 1,
  plugins: [
    { id: "market-a", source: { kind: "market" } },
    // 上云后的 dev 记录：普通安装副本（没有本机源路径）
    { id: "dev-b", dir: "plugins/dev-b", source: { kind: "file", ref: "dev-mount-sync" } },
  ],
};
const local = {
  version: 1,
  plugins: [
    { id: "market-a", source: { kind: "market" } },
    { id: "dev-b", dir: "D:\\code\\dev-b", source: { kind: "folder", dev: true, ref: "D:\\code\\dev-b" } },
  ],
};
const merged = scope.registryWithLocalDevicePlugins(remote, local);
eq("还原后记录数", merged.plugins.length, 2);
eq(
  "同 id 时本机 dev 记录优先",
  merged.plugins.find((p) => p.id === "dev-b").source.ref,
  "D:\\code\\dev-b"
);
ok("本机 dev 记录仍标记为 dev", merged.plugins.find((p) => p.id === "dev-b").source.dev === true);

/* ===================== 7) 无 dev 记录时不做无谓复制 ===================== */
const plain = { version: 1, plugins: [{ id: "a", source: { kind: "market" } }] };
ok("无 dev 时不重建对象", scope.registryForSync(plain) === plain);

/* ===================== 8) 「暂停使用」是设备专属，不能跟着注册表上云 ===================== */
const pauseRegistry = {
  version: 1,
  plugins: [
    { id: "market-a", enabled: false, source: { kind: "market" } },
    { id: "dev-b", enabled: true, source: { kind: "folder", dev: true, ref: "D:\\code\\dev-b" } },
  ],
};
const pauseUploaded = scope.registryForSync(pauseRegistry);
eq(
  "上传时去掉暂停状态",
  pauseUploaded.plugins.find((p) => p.id === "market-a").enabled,
  undefined
);
eq(
  "dev 记录也不带暂停状态",
  pauseUploaded.plugins.find((p) => p.id === "dev-b").enabled,
  undefined
);
const pauseRestored = scope.registryWithLocalDevicePlugins(pauseUploaded, pauseRegistry);
eq(
  "还原时沿本机暂停状态",
  pauseRestored.plugins.find((p) => p.id === "market-a").enabled,
  false
);
const pauseNewDevice = scope.registryWithLocalDevicePlugins(pauseUploaded, {
  version: 1,
  plugins: [],
});
eq(
  "新设备默认使用中（不继承别人暂停）",
  pauseNewDevice.plugins.find((p) => p.id === "market-a").enabled,
  true
);

if (failures.length) {
  console.error(`✗ sync-scope: ${failures.length} 条失败 / ${passed + failures.length} 条断言`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`✓ sync-scope: ${passed} 条断言全部通过`);
