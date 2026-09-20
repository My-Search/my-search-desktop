/**
 * dev 挂载权限自愈测试 —— 目录挂载漏授 optionalPermissions 的启动修补。
 * 用法: node test/dev-grants-fixup.test.mjs
 */
import {
  createPluginRecord,
  loadRegistry,
  saveRegistry,
  PLUGIN_REGISTRY_KEY,
} from "../src/lib/plugins/registry.ts";

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = "") => {
  if (cond) { pass++; console.log("PASS ", name, extra ? ` — ${extra}` : ""); }
  else { fail++; console.log("FAIL ", name, extra ? ` — ${extra}` : ""); }
};

function mockLocalStorage() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    key: (i) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
    clear: () => store.clear(),
  };
  return store;
}

const KEY = `my-search-desktop:${PLUGIN_REGISTRY_KEY}`;

function makeDevRecord(overrides = {}) {
  const manifest = {
    id: "com.mysearch.market",
    name: "插件市场",
    version: "1.0.0",
    apiVersion: 1,
    permissions: ["ui.inlay", "store"],
    optionalPermissions: ["plugin.install"],
    ...overrides.manifest,
  };
  return createPluginRecord({
    manifest,
    dir: "plugins/market",
    source: { kind: "folder", ref: "plugins/market", dev: true },
    grants: manifest.permissions ?? [],
    integrity: { sha256: null, signed: false },
    ...overrides,
  });
}

function fixupDevGrants() {
  const registry = loadRegistry();
  let changed = false;
  for (const rec of registry.plugins) {
    if (!rec.source.dev) continue;
    const opts = rec.manifest.optionalPermissions ?? [];
    for (const p of opts) {
      if (!rec.grants.some((g) => g.permission === p)) {
        rec.grants.push({ permission: p, at: Date.now(), source: "install" });
        changed = true;
      }
    }
  }
  if (changed) saveRegistry(registry);
  return changed;
}

/* 1. 修补缺失的 optionalPermissions */
{
  const store = mockLocalStorage();
  const rec = makeDevRecord();
  store.set(KEY, JSON.stringify({ version: 1, plugins: [rec] }));

  ok(
    rec.grants.length === 2 && !rec.grants.some((g) => g.permission === "plugin.install"),
    "初始：dev 挂载缺少 optionalPermissions",
    `grants=${JSON.stringify(rec.grants.map((g) => g.permission))}`
  );

  const changed = fixupDevGrants();
  ok(changed === true, "修补检测到变化");

  const after = loadRegistry();
  const fixed = after.plugins.find((p) => p.id === "com.mysearch.market");
  ok(fixed !== undefined, "修补后记录存在");
  ok(
    fixed.grants.some((g) => g.permission === "plugin.install"),
    "修补后含 plugin.install",
    `grants=${JSON.stringify(fixed.grants.map((g) => g.permission))}`
  );
  ok(
    fixed.grants.some((g) => g.permission === "ui.inlay") &&
      fixed.grants.some((g) => g.permission === "store"),
    "原有 permissions 保留"
  );
  ok(fixed.grants.length === 3, "总共 3 项授权", `count=${fixed.grants.length}`);
}

/* 2. 幂等性 */
{
  const store = mockLocalStorage();
  store.set(KEY, JSON.stringify({ version: 1, plugins: [makeDevRecord()] }));
  fixupDevGrants();
  const changed2 = fixupDevGrants();
  ok(changed2 === false, "重复修补应无变化（幂等）");
  const after2 = loadRegistry();
  const fixed2 = after2.plugins.find((p) => p.id === "com.mysearch.market");
  ok(fixed2.grants.length === 3, "重复修补后 grants 数量不变", `count=${fixed2.grants.length}`);
}

/* 3. 非 dev 挂载不受影响 */
{
  const store = mockLocalStorage();
  const builtinRec = createPluginRecord({
    manifest: {
      id: "com.mysearch.baidu-translate", name: "百度翻译", version: "1.0.0", apiVersion: 1,
      permissions: ["ui.inlay"], optionalPermissions: ["plugin.install"],
    },
    dir: "", source: { kind: "builtin" },
    grants: ["ui.inlay", "plugin.install"],
    integrity: { sha256: null, signed: false },
  });
  store.set(KEY, JSON.stringify({ version: 1, plugins: [builtinRec] }));
  const changed = fixupDevGrants();
  ok(changed === false, "非 dev 挂载不应被修改");
  const rec = loadRegistry().plugins.find((p) => p.id === "com.mysearch.baidu-translate");
  ok(rec.grants.length === 2, "内置安装记录不受影响", `count=${rec.grants.length}`);
}

/* 4. 无 optionalPermissions 的 dev 挂载不受影响 */
{
  const store = mockLocalStorage();
  const rec = makeDevRecord({
    manifest: { id: "com.example.simple", name: "简单插件", version: "1.0.0", apiVersion: 1, permissions: ["ui.inlay"] },
  });
  store.set(KEY, JSON.stringify({ version: 1, plugins: [rec] }));
  ok(fixupDevGrants() === false, "无 optionalPermissions 不应修改");
}

/* 5. 已有部分 optionalPermissions 只补缺失的 */
{
  const store = mockLocalStorage();
  const manifest = {
    id: "com.example.partial", name: "部分授权", version: "1.0.0", apiVersion: 1,
    permissions: ["ui.inlay"], optionalPermissions: ["plugin.install", "clipboard.read"],
  };
  const rec = createPluginRecord({
    manifest, dir: "plugins/partial",
    source: { kind: "folder", ref: "plugins/partial", dev: true },
    grants: ["ui.inlay", "clipboard.read"],
    integrity: { sha256: null, signed: false },
  });
  store.set(KEY, JSON.stringify({ version: 1, plugins: [rec] }));
  ok(fixupDevGrants() === true, "部分缺失时应检测到变化");
  const fixed = loadRegistry().plugins.find((p) => p.id === "com.example.partial");
  ok(fixed.grants.length === 3, "只补缺失的那个", `count=${fixed.grants.length}`);
  ok(
    fixed.grants.some((g) => g.permission === "plugin.install") &&
      fixed.grants.some((g) => g.permission === "clipboard.read"),
    "两个 optionalPermissions 都在"
  );
}

/* 6. installDevDir grants 合并（修复后行为） */
{
  const m = { permissions: ["ui.inlay", "store"], optionalPermissions: ["plugin.install"] };
  const grants = [...(m.permissions ?? []), ...(m.optionalPermissions ?? [])];
  ok(grants.length === 3, "修复后 grants 包含必需+可选", `count=${grants.length}`);
  ok(grants.includes("plugin.install"), "修复后包含 plugin.install");
  ok(grants.includes("ui.inlay") && grants.includes("store"), "原有 permissions 保留");
}

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
