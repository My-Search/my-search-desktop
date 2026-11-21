/**
 * 快照作用域测试（`src/lib/sync/snapshot.ts`）。
 *
 * 用内存 localStorage 驱动真实模块，钉死：
 *   - 同步采集只拿 account 键；
 *   - 设备键（最近附件 / 插件窗口尺寸）不进云；
 *   - 开发挂载记录上云时改写为普通安装副本，但本机留底保留原始记录；
 *   - 还原时本机 dev 记录优先，且不会被 prune 删掉；
 *   - never 键（凭据/缓存）任何路径都不碰。
 *
 * 用法: node test/sync-snapshot.test.mjs
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
register(pathToFileURL(path.join(root, "test/_cloud-stub-loader.mjs")).href, pathToFileURL(root));

/** 内存 localStorage（key 顺序按插入顺序） */
const map = new Map();
globalThis.localStorage = {
  get length() {
    return map.size;
  },
  key(i) {
    return [...map.keys()][i] ?? null;
  },
  getItem(k) {
    return map.has(k) ? map.get(k) : null;
  },
  setItem(k, v) {
    map.set(k, String(v));
  },
  removeItem(k) {
    map.delete(k);
  },
};

const PREFIX = "my-search-desktop:";
const snapshot = await import(
  pathToFileURL(path.join(root, "src/lib/sync/snapshot.ts")).href
);

let passed = 0;
const failures = [];
function ok(name, cond, extra = "") {
  if (cond) passed += 1;
  else failures.push(`${name}${extra ? ` — ${extra}` : ""}`);
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function put(key, value) {
  map.set(PREFIX + key, JSON.stringify(value));
}
function get(key) {
  const raw = map.get(PREFIX + key);
  return raw === undefined ? undefined : JSON.parse(raw);
}

const registry = {
  version: 1,
  plugins: [
    { id: "market-a", name: "A", dir: "plugins/market-a", source: { kind: "market", ref: "https://x" } },
    { id: "dev-b", name: "B", dir: "D:\\code\\dev-b", source: { kind: "folder", dev: true, ref: "D:\\code\\dev-b" } },
  ],
};
put("PLUGIN_REGISTRY_CACHE_KEY", registry);
put("PLUGIN_DATA:market-a:kv", { n: 1 });
put("PLUGIN_DATA:dev-b:kv", { secretLocal: true });
put("PLUGIN_DATA:dev-b:viewSize", { w: 900, h: 700 });
put("RECENT_ATTACH_KEY", [{ path: "D:\\tmp\\a.txt" }]);
put("auto_download_update", false);
put("theme", "dark");
put("USER_GITHUB_TOKEN_CACHE_KEY", "ghp_secret");
put("script:foo", { x: 1 });

/* ===================== 1) 同步采集 ===================== */
const syncState = snapshot.collectState();
ok("含主题", syncState.theme === "dark");
ok("含市场插件数据", !!syncState["PLUGIN_DATA:market-a:kv"]);
ok("不含 dev 插件数据", syncState["PLUGIN_DATA:dev-b:kv"] === undefined);
ok("不含设备键（最近附件）", syncState.RECENT_ATTACH_KEY === undefined);
ok("不含设备键（更新偏好）", syncState.auto_download_update === undefined);
ok("不含设备键（插件窗口尺寸）", syncState["PLUGIN_DATA:dev-b:viewSize"] === undefined);
ok("不含 never 键", syncState.USER_GITHUB_TOKEN_CACHE_KEY === undefined);
ok("不含 script 前缀", syncState["script:foo"] === undefined);

const upRegistry = syncState.PLUGIN_REGISTRY_CACHE_KEY;
ok("上云注册表仍有 dev 插件", !!upRegistry.plugins.find((p) => p.id === "dev-b"));
const upDev = upRegistry.plugins.find((p) => p.id === "dev-b");
eq("上云 dev 记录改为 plugins/<id>", upDev.dir, "plugins/dev-b");
eq("上云 dev 记录去掉 dev 标记", upDev.source.dev, undefined);
eq("上云 dev 记录来源为文件安装", upDev.source.kind, "file");

/* ===================== 2) 本机留底 ===================== */
const backupState = snapshot.collectBackupState();
ok("留底含设备键", !!backupState.RECENT_ATTACH_KEY);
ok("留底含插件窗口尺寸", !!backupState["PLUGIN_DATA:dev-b:viewSize"]);
ok("留底含 dev 插件数据", !!backupState["PLUGIN_DATA:dev-b:kv"]);
ok("留底不含 never 键", backupState.USER_GITHUB_TOKEN_CACHE_KEY === undefined);
const bakDev = backupState.PLUGIN_REGISTRY_CACHE_KEY.plugins.find((p) => p.id === "dev-b");
eq("留底保留 dev 原始路径", bakDev.source.ref, "D:\\code\\dev-b");

/* ===================== 3) 还原：本机 dev 记录优先 ===================== */
const incoming = {
  version: 1,
  plugins: [
    { id: "market-a", name: "A", dir: "plugins/market-a", source: { kind: "market" } },
    { id: "dev-b", name: "B", dir: "plugins/dev-b", source: { kind: "file", ref: "dev-mount-sync" } },
    { id: "new-c", name: "C", dir: "plugins/new-c", source: { kind: "file" } },
  ],
};
snapshot.restoreState({ PLUGIN_REGISTRY_CACHE_KEY: incoming, theme: "light" }, { silent: true });
const after = get("PLUGIN_REGISTRY_CACHE_KEY");
eq("还原后记录数", after.plugins.length, 3);
eq(
  "同 id 时本机 dev 记录优先",
  after.plugins.find((p) => p.id === "dev-b").source.ref,
  "D:\\code\\dev-b"
);
ok("新设备插件记录保留", !!after.plugins.find((p) => p.id === "new-c"));
ok("主题已写回", get("theme") === "light");
ok("设备键不会被还原覆盖", !!get("RECENT_ATTACH_KEY"));

/* ===================== 4) prune：设备数据不能被删 ===================== */
const removed = snapshot.pruneState({ PLUGIN_REGISTRY_CACHE_KEY: after, theme: "light" });
eq("prune 删掉云端已无的普通插件数据", removed, 1);
ok("市场插件数据已删", get("PLUGIN_DATA:market-a:kv") === undefined);
ok("prune 不删设备键（更新偏好）", get("auto_download_update") === false);
ok("prune 不删 dev 插件数据", !!get("PLUGIN_DATA:dev-b:kv"));
ok("prune 不删设备键（最近附件）", !!get("RECENT_ATTACH_KEY"));

if (failures.length) {
  console.error(`✗ sync-snapshot: ${failures.length} 条失败 / ${passed + failures.length} 条断言`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`✓ sync-snapshot: ${passed} 条断言全部通过`);

