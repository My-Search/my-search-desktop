/**
 * 搜索期结果提供者（P0-2）测试。
 *
 * 覆盖契约：
 *   1. 清单声明校验（trigger / match / maxItems / timeoutMs）；
 *   2. 触发条件（always / prefix 整词 / regex）；
 *   3. 只有「启用 + 已声明 + 已注册回调」的插件参与；
 *   4. 单插件条数上限、全局 20 条上限、超时丢弃、异常隔离；
 *   5. 结果项带 `_pluginResult` 标记与回传字段（点击走 action.type = "result"）；
 *   6. 接线契约（ms.results 权限、doSearch 合并、App 绑定）。
 *
 * 用法: node test/plugin-result-provider.test.mjs
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
const { parsePluginManifest, describeManifestError } = await import("../src/lib/plugins/manifest.ts");
const { createPluginRecord } = await import("../src/lib/plugins/registry.ts");
const {
  registerResultProvider,
  clearResultProviders,
  hasResultProvider,
  providerMatches,
  collectProviderResults,
  PLUGIN_RESULT_FLAG,
  PLUGIN_RESULT_ID_FLAG,
  PLUGIN_RESULT_ACTION_FLAG,
  RESULT_PROVIDER_MAX_ITEMS,
  RESULT_PROVIDER_GLOBAL_CAP,
} = await import("../src/lib/plugins/result-provider.ts");

let passed = 0;
function pass(name) {
  passed++;
  console.log(`PASS  ${name}`);
}

function recordOf(id, patch = {}) {
  const r = parsePluginManifest(
    JSON.stringify({
      id,
      name: `插件${id.slice(-2)}`,
      version: "1.0.0",
      apiVersion: 1,
      permissions: ["search.read", "search.write"],
      contributes: {},
      ...patch,
    })
  );
  assert.equal(r.ok, true, r.ok ? "" : r.errors.join(","));
  return createPluginRecord({
    manifest: r.manifest,
    dir: `plugins/${id}`,
    source: { kind: "file" },
    grants: ["search.read", "search.write"],
  });
}

/* ============ 1. 清单校验 ============ */
{
  const ok = parsePluginManifest(
    JSON.stringify({
      id: "com.example.weather",
      name: "天气",
      version: "1.0.0",
      apiVersion: 1,
      contributes: { resultProvider: { trigger: "prefix", match: "天气", maxItems: 8, timeoutMs: 100 } },
    })
  );
  assert.equal(ok.ok, true, ok.ok ? "" : ok.errors.join(","));
  assert.deepEqual(ok.manifest.contributes.resultProvider, {
    trigger: "prefix",
    match: "天气",
    maxItems: 8,
    timeoutMs: 100,
  });

  const bad = parsePluginManifest(
    JSON.stringify({
      id: "com.example.bad",
      name: "坏",
      version: "1.0.0",
      apiVersion: 1,
      contributes: {
        resultProvider: { trigger: "regex", match: "([", maxItems: 99, timeoutMs: 0 },
      },
    })
  );
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.includes("contributes.resultProvider.match.invalid"));
  assert.ok(bad.errors.includes("contributes.resultProvider.maxItems.invalid"));
  assert.ok(bad.errors.includes("contributes.resultProvider.timeoutMs.invalid"));
  assert.match(describeManifestError("contributes.resultProvider.maxItems.invalid"), /1-10/);

  const missing = parsePluginManifest(
    JSON.stringify({
      id: "com.example.nomatch",
      name: "缺 match",
      version: "1.0.0",
      apiVersion: 1,
      contributes: { resultProvider: { trigger: "prefix" } },
    })
  );
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.includes("contributes.resultProvider.match.missing"));
  pass("清单 resultProvider 的合法值与非法值都被正确处理");
}

/* ============ 2. 触发条件 ============ */
{
  assert.equal(providerMatches({ trigger: "always" }, "任意"), true);
  assert.equal(providerMatches({ trigger: "prefix", match: "天气" }, "天气"), true);
  assert.equal(providerMatches({ trigger: "prefix", match: "天气" }, "天气 广州"), true);
  assert.equal(providerMatches({ trigger: "prefix", match: "天气" }, "天气 : 广州"), true);
  assert.equal(providerMatches({ trigger: "prefix", match: "天气" }, "天气预报"), false, "整词前缀");
  assert.equal(providerMatches({ trigger: "prefix", match: "天气" }, "今天天气"), false, "非开头不命中");
  assert.equal(providerMatches({ trigger: "regex", match: "^[0-9]+$" }, "123"), true);
  assert.equal(providerMatches({ trigger: "regex", match: "^[0-9]+$" }, "abc"), false);
  assert.equal(providerMatches({ trigger: "regex", match: "([ " }, "任意"), false, "坏正则不炸");
  assert.equal(providerMatches({ trigger: "always" }, "   "), false, "空关键词不参与");
  pass("触发条件：always / prefix 整词 / regex / 坏正则全部安全");
}

/* ============ 3. 参与资格 ============ */
{
  clearResultProviders();
  const declared = recordOf("com.example.a", {
    contributes: { resultProvider: { trigger: "always", maxItems: 3 } },
  });
  const undeclared = recordOf("com.example.b");
  const disabled = recordOf("com.example.c", {
    contributes: { resultProvider: { trigger: "always" } },
  });
  disabled.enabled = false;

  registerResultProvider(declared.id, () => [{ title: "A 结果" }]);
  registerResultProvider(undeclared.id, () => [{ title: "不该出现" }]);
  registerResultProvider(disabled.id, () => [{ title: "不该出现" }]);

  const out = await collectProviderResults({
    keyword: "你好",
    records: [declared, undeclared, disabled],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "A 结果");
  assert.equal(out[0][PLUGIN_RESULT_FLAG], true);
  assert.equal(out[0]._pluginId, declared.id);
  assert.equal(out[0]._pluginKeyword, "你好");
  assert.equal(hasResultProvider(declared.id), true);
  pass("只有「启用 + 声明 + 已注册」的插件参与，未声明/禁用不掺入");
}

/* ============ 4. 上限 / 超时 / 异常 ============ */
{
  clearResultProviders();
  const rec = recordOf("com.example.cap", {
    contributes: { resultProvider: { trigger: "always", maxItems: 10 } },
  });
  registerResultProvider(rec.id, () =>
    Array.from({ length: 15 }, (_, i) => ({ id: `r${i}`, title: `结果 ${i}` }))
  );
  const out = await collectProviderResults({ keyword: "x", records: [rec] });
  assert.equal(out.length, RESULT_PROVIDER_MAX_ITEMS, "单插件硬顶 10 条");
  assert.equal(out[9][PLUGIN_RESULT_ID_FLAG], "r9");

  const recs = ["com.example.g1", "com.example.g2", "com.example.g3"].map((id) =>
    recordOf(id, { contributes: { resultProvider: { trigger: "always", maxItems: 10 } } })
  );
  for (const r of recs) {
    registerResultProvider(r.id, () =>
      Array.from({ length: 10 }, (_, i) => ({ title: `${r.id}-${i}` }))
    );
  }
  const many = await collectProviderResults({ keyword: "x", records: recs });
  assert.equal(many.length, RESULT_PROVIDER_GLOBAL_CAP, "全局硬顶 20 条");

  clearResultProviders();
  const slow = recordOf("com.example.slow", {
    contributes: { resultProvider: { trigger: "always", timeoutMs: 20 } },
  });
  const fast = recordOf("com.example.fast", {
    contributes: { resultProvider: { trigger: "always" } },
  });
  registerResultProvider(slow.id, () => new Promise(() => {}));
  registerResultProvider(fast.id, () => [{ title: "快的先到" }]);
  const reasons = [];
  const t0 = Date.now();
  const mixed = await collectProviderResults({
    keyword: "x",
    records: [slow, fast],
    budgetMs: 60,
    onError: (id, reason) => reasons.push(`${id}:${reason}`),
  });
  const elapsed = Date.now() - t0;
  assert.equal(mixed.length, 1, "超时插件被丢弃，不影响其它插件");
  assert.equal(mixed[0].title, "快的先到");
  assert.ok(reasons.some((r) => r.startsWith(slow.id)), "超时被上报");
  assert.ok(elapsed < 200, `总预算生效（实际 ${elapsed}ms）`);

  const throwing = recordOf("com.example.throw", {
    contributes: { resultProvider: { trigger: "always" } },
  });
  registerResultProvider(throwing.id, () => {
    throw new Error("boom");
  });
  const flagged = [];
  const safe = await collectProviderResults({
    keyword: "x",
    records: [throwing],
    onError: (id, reason) => flagged.push(`${id}:${reason}`),
  });
  assert.equal(safe.length, 0, "抛错插件不贡献");
  assert.ok(flagged[0].includes("boom"));
  pass("单插件/全局上限、超时丢弃、抛错隔离全部生效");
}

/* ============ 5. 结果项字段与归一化 ============ */
{
  clearResultProviders();
  const rec = recordOf("com.example.shape", {
    contributes: { resultProvider: { trigger: "always" } },
  });
  registerResultProvider(rec.id, () => [
    { id: "a", title: "甲", desc: "描述", action: "open-a", payload: { n: 1 } },
    { title: "乙" },
    { title: "   " },
    "不是对象",
    { id: "a", title: "重复 id" },
  ]);
  const out = await collectProviderResults({ keyword: "k", records: [rec] });
  assert.equal(out.length, 2, "空标题/非对象/重复 id 被丢弃");
  assert.equal(out[0][PLUGIN_RESULT_ACTION_FLAG], "open-a");
  assert.equal(out[0]["_pluginResultPayload"].n, 1);
  assert.equal(out[1][PLUGIN_RESULT_ACTION_FLAG], "1", "缺省 action 用序号");
  assert.equal(out[0].subscribe, `插件：${rec.name}`);
  pass("结果项归一化与点击回传字段正确");
}

/* ============ 6. 接线契约 ============ */
{
  const ui = readFileSync(path.join(root, "src/lib/plugins/host/ui-data-api.ts"), "utf8");
  assert.match(ui, /defineRpcNamespace\("results"/);
  assert.match(ui, /permission: "search\.write"/);
  assert.match(ui, /resultProviderOf\(rec\)/, "未声明时运行时拒绝");
  assert.match(ui, /registerResultProvider\(pluginId/);

  const hub = readFileSync(path.join(root, "src/lib/plugins/host/event-hub.ts"), "utf8");
  assert.match(hub, /clearResultProviders\(pluginId\)/, "会话销毁时注销提供者");
  assert.match(hub, /\| "result"/, "进入参数支持 result 类型");

  const state = readFileSync(path.join(root, "src/windows/search/useSearchState.ts"), "utf8");
  assert.match(state, /bindResultProviders/);
  assert.match(state, /resultProviders && !engine\.resultFilter/, "附件模式不掺入");
  assert.match(state, /provided\.map\(\(item\) => \(\{ item, level: 0 \}\)\)/, "提供者结果排在前面");

  const view = readFileSync(path.join(root, "src/windows/search/usePluginViewHost.ts"), "utf8");
  assert.match(view, /type: "result"/);
  assert.match(view, /PLUGIN_RESULT_ACTION_FLAG/);

  const app = readFileSync(path.join(root, "src/windows/search/App.vue"), "utf8");
  assert.match(app, /search\.bindResultProviders/);
  pass("ms.results / 会话清理 / 搜索合并 / 点击回传的接线完整");
}

console.log(`\n全部通过：${passed} 项结果提供者测试`);
