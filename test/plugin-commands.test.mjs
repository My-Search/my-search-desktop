/**
 * 运行时命令（`ms.commands.*`）与清单命令的合成测试。
 *
 * 覆盖契约：
 *   1. 清单 `contributes.command` 终于会变成搜索结果项（此前「能声明、不生效」）；
 *   2. 命令项默认参与二次搜索（补 `[可搜索]` 的运行时投影 `_pluginSubSearch = true`）；
 *   3. 前缀自动补齐 `" : "`；与 searchItem 同关键词时以 searchItem 为准（不出现两条相同入口）；
 *   4. 运行时注册：id 校验、前缀规范化、重复 id 覆盖、同前缀冲突拒绝、20 条上限；
 *   5. 注销 / 清空；同 id 的运行时命令覆盖清单命令（`listAllCommands` 合并规则）。
 *
 * 用法: node test/plugin-commands.test.mjs
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
const { parsePluginManifest } = await import("../src/lib/plugins/manifest.ts");
const { createPluginRecord } = await import("../src/lib/plugins/registry.ts");
const {
  listAllCommands,
  normalizeCommandPrefix,
  upsertRuntimeCommand,
  removeRuntimeCommand,
  clearRuntimeCommands,
  MAX_RUNTIME_COMMANDS,
} = await import("../src/lib/plugins/registry.ts");
const { buildPluginItems, pluginKeywordOf, pluginSubSearchOf, pluginCommandIdOf } =
  await import("../src/lib/plugins/plugin-items.ts");

let passed = 0;
function pass(name) {
  passed++;
  console.log(`PASS  ${name}`);
}

function recordOf(manifestPatch = {}, grants = ["ui.inlay", "ui.command"]) {
  const r = parsePluginManifest(
    JSON.stringify({
      id: "com.example.cmd",
      name: "命令测试",
      version: "1.0.0",
      apiVersion: 1,
      permissions: grants,
      contributes: {},
      ...manifestPatch,
    })
  );
  assert.equal(r.ok, true, r.ok ? "" : r.errors.join(","));
  return createPluginRecord({
    manifest: r.manifest,
    dir: "plugins/com.example.cmd",
    source: { kind: "file" },
    grants,
  });
}

/* ============ 1. 清单命令 → 搜索项 ============ */
{
  const rec = recordOf({
    contributes: {
      command: [
        { id: "ask", prefix: "问AI : ", title: "问 AI", desc: "向模型提问" },
        { id: "tr", prefix: "翻译", title: "翻译" },
      ],
    },
  });
  const items = buildPluginItems(rec);
  assert.equal(items.length, 2, "两条清单命令都合成了搜索项");
  const ask = items.find((it) => pluginCommandIdOf(it) === "ask");
  assert.ok(ask, "命令项带 _pluginCommandId 标记");
  assert.equal(pluginKeywordOf(ask), "问AI", "关键词是边界前的父词");
  assert.equal(pluginSubSearchOf(ask), true, "命令天生参与二次搜索");
  assert.equal(ask.subscribe, "插件：命令测试");
  const tr = items.find((it) => pluginCommandIdOf(it) === "tr");
  assert.equal(pluginKeywordOf(tr), "翻译", "缺失边界时按原文作为父词");
  pass("清单 contributes.command 合成搜索项（含边界规范化与二次搜索声明）");
}

/* ============ 2. 与 searchItem 去重 ============ */
{
  const rec = recordOf({
    contributes: {
      searchItem: { title: "问 AI", keyword: "问AI" },
      command: [{ id: "ask", prefix: "问AI", title: "问 AI 命令" }],
    },
  });
  const items = buildPluginItems(rec);
  const kw = items.filter((it) => pluginKeywordOf(it) === "问AI");
  assert.equal(kw.length, 1, "同一关键词只保留 searchItem，不重复加入口");
  assert.equal(pluginCommandIdOf(kw[0]), null);
  pass("命令与 searchItem 同关键词时以 searchItem 为准");
}

/* ============ 3. 运行时注册 / 覆盖 / 冲突 / 上限 ============ */
{
  const rec = recordOf();
  const reg = { version: 1, plugins: [rec] };

  const add = upsertRuntimeCommand(reg, rec.id, {
    id: "dyn",
    prefix: "仓库",
    title: "打开仓库",
    desc: "按同步列表动态生成",
  });
  assert.equal(add.ok, true, add.ok ? "" : add.error);
  assert.equal(add.command.prefix, "仓库 : ", "前缀自动补边界");
  assert.equal(rec.runtimeCommands.length, 1);

  const listed = listAllCommands(rec);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].source, "runtime");

  // 同 id 覆盖（不新增第二条）
  const again = upsertRuntimeCommand(reg, rec.id, {
    id: "dyn",
    prefix: "仓库",
    title: "打开仓库（新）",
  });
  assert.equal(again.ok, true);
  assert.equal(rec.runtimeCommands.length, 1);
  assert.equal(rec.runtimeCommands[0].title, "打开仓库（新）");

  // 同前缀不同 id → 拒绝
  const conflict = upsertRuntimeCommand(reg, rec.id, {
    id: "dyn2",
    prefix: "仓库",
    title: "重复前缀",
  });
  assert.equal(conflict.ok, false);
  assert.match(conflict.error, /已被命令/);

  // 非法 id / 空标题 → 拒绝
  assert.equal(upsertRuntimeCommand(reg, rec.id, { id: "带空格 x", prefix: "x", title: "x" }).ok, false);
  assert.equal(upsertRuntimeCommand(reg, rec.id, { id: "okid", prefix: "x", title: "  " }).ok, false);

  // 注销
  assert.equal(removeRuntimeCommand(reg, rec.id, "dyn"), true);
  assert.equal(rec.runtimeCommands.length, 0);
  assert.equal(removeRuntimeCommand(reg, rec.id, "dyn"), false, "幂等");

  // 上限
  for (let i = 0; i < MAX_RUNTIME_COMMANDS; i++) {
    const r = upsertRuntimeCommand(reg, rec.id, {
      id: `c${i}`,
      prefix: `前缀${i}`,
      title: `命令 ${i}`,
    });
    assert.equal(r.ok, true);
  }
  const over = upsertRuntimeCommand(reg, rec.id, { id: "overflow", prefix: "溢出", title: "溢出" });
  assert.equal(over.ok, false);
  assert.match(over.error, /最多注册/);

  clearRuntimeCommands(reg, rec.id);
  assert.equal(rec.runtimeCommands, null);
  pass("运行时命令：规范化 / 覆盖 / 冲突 / 校验 / 上限 / 清理全部正确");
}

/* ============ 4. 清单 + 运行时合并（运行时优先） ============ */
{
  const rec = recordOf({ contributes: { command: [{ id: "x", prefix: "旧", title: "旧命令" }] } });
  const reg = { version: 1, plugins: [rec] };
  assert.equal(upsertRuntimeCommand(reg, rec.id, { id: "x", prefix: "新", title: "新命令" }).ok, true);
  const merged = listAllCommands(rec);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, "runtime", "同 id 运行时覆盖清单");
  assert.equal(merged[0].title, "新命令");
  pass("清单与运行时命令按 id 合并，运行时优先");
}

/* ============ 5. API / 权限接线契约 ============ */
{
  const src = readFileSync(
    path.join(root, "src/lib/plugins/host/ui-data-api.ts"),
    "utf8"
  );
  assert.match(src, /defineRpcNamespace\("commands"/);
  assert.match(src, /permission: "ui\.command"/, "命令注册受 ui.command 约束");
  assert.match(src, /ctx\.persistRegistry\(\)/, "注册/注销必须落盘");
  assert.match(src, /upsertRuntimeCommand/);
  assert.match(src, /commands,/, "commands 已并入宿主 API 返回值");

  const items = readFileSync(path.join(root, "src/lib/plugins/plugin-items.ts"), "utf8");
  assert.match(items, /PLUGIN_COMMAND_FLAG/);
  assert.match(items, /listAllCommands\(record\)/);

  pass("ms.commands 的权限、落盘与搜索项合成接线完整");
}

console.log(`\n全部通过：${passed} 项动态命令测试`);
