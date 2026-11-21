/**
 * P1-3：类型包 / JSON Schema / 脚手架。
 *
 * 契约：
 *   1. `plugin.schema.json` 与宿主校验常量同源（重新生成必须字节一致）；
 *   2. Schema 的权限枚举与 `PERMISSION_CATALOG` 一致，必填字段与解析器一致；
 *   3. 清单解析接受并保留 `$schema`（宿主忽略其内容）；
 *   4. `create-plugin` 生成的插件能被 `parsePluginManifest` 直接接受；
 *   5. 非法 id / 非空目录被脚手架拒绝；
 *   6. `ms.d.ts` 覆盖本轮新增的 API 面。
 *
 * 用法: node test/plugin-types.test.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { parsePluginManifest } = await import("../src/lib/plugins/manifest.ts");
const { PERMISSION_CATALOG } = await import("../src/lib/plugins/permissions.ts");

let passed = 0;
function pass(name) {
  passed++;
  console.log(`PASS  ${name}`);
}

/* ============ 1. Schema 同源 ============ */
{
  execFileSync(process.execPath, ["scripts/gen-plugin-schema.mjs", "--check"], {
    cwd: root,
    stdio: "pipe",
  });
  pass("plugin.schema.json 与宿主校验常量一致（--check 通过）");
}

/* ============ 2. Schema 内容与权限目录对齐 ============ */
{
  const schema = JSON.parse(readFileSync(path.join(root, "packages/plugin-types/plugin.schema.json"), "utf8"));
  const perm = schema.$defs.permission;
  const unscoped = perm.anyOf.find((x) => Array.isArray(x.enum));
  const catalogIds = PERMISSION_CATALOG.map((p) => p.id);
  assert.deepEqual(unscoped.enum, catalogIds, "基础权限枚举来自 PERMISSION_CATALOG");

  const scopedIds = PERMISSION_CATALOG.filter((p) => p.scoped).map((p) => p.id);
  const scoped = perm.anyOf.find((x) => typeof x.pattern === "string");
  if (scopedIds.length) {
    assert.ok(scoped, "scoped 权限有 pattern 分支");
    for (const id of scopedIds) assert.ok(scoped.pattern.includes(id.replace(/\./g, "\\.")), `pattern 覆盖 ${id}`);
  } else {
    assert.equal(scoped, undefined);
  }

  assert.deepEqual(schema.required, ["id", "name", "version", "apiVersion"]);
  assert.equal(schema.properties.apiVersion.maximum, 1);
  assert.equal(schema.properties.name.maxLength, 48);
  assert.ok(schema.$defs.resultProvider, "结果提供者已进入 Schema");
  assert.ok(schema.$defs.contributes.properties.clipboardCapture);
  pass("Schema 的必填、上限、权限枚举、新贡献点均来自宿主同一批常量");
}

/* ============ 3. $schema 解析 ============ */
{
  const manifest = {
    $schema: "../../packages/plugin-types/plugin.schema.json",
    id: "com.example.schema",
    name: "Schema 测试",
    version: "1.0.0",
    apiVersion: 1,
  };
  const r = parsePluginManifest(manifest, () => true);
  assert.equal(r.ok, true);
  assert.equal(r.manifest.$schema, manifest.$schema, "保留 $schema 供工具链使用");
  assert.equal(r.warnings.length, 0);
  pass("清单可带 $schema，且不影响安装校验");
}

/* ============ 4. 脚手架产物可直接解析 ============ */
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), "ms-plugin-scaffold-"));
  const dest = path.join(tmp, "demo");
  try {
    execFileSync(
      process.execPath,
      ["scripts/create-plugin.mjs", dest, "--id", "com.example.demo", "--name", "演示插件", "--keyword", "演示", "--desc", "一句话"],
      { cwd: root, stdio: "pipe" }
    );

    const raw = readFileSync(path.join(dest, "plugin.json"), "utf8");
    const r = parsePluginManifest(raw, (p) => p === "search.read" || p === "store");
    assert.equal(r.ok, true, `脚手架清单应合法：${JSON.stringify(r)}`);
    assert.equal(r.manifest.id, "com.example.demo");
    assert.equal(r.manifest.contributes.searchItem.keyword, "演示");
    assert.equal(r.manifest.contributes.detailView.entry, "ui/index.html");

    const js = readFileSync(path.join(dest, "ui/index.js"), "utf8");
    assert.match(js, /ms\.lifecycle\.onDispose/);
    assert.match(js, /onSubKeyword/);
    assert.match(js, /ms\.ui\.subInput/);
    assert.ok(readFileSync(path.join(dest, "ui/index.html"), "utf8").includes("<main>"));
    pass("create-plugin 生成的清单可被解析、示例脚本覆盖新 API");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/* ============ 5. 脚手架拒绝非法输入 ============ */
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), "ms-plugin-scaffold-bad-"));
  try {
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          ["scripts/create-plugin.mjs", path.join(tmp, "x"), "--id", "Bad_ID", "--name", "坏"],
          { cwd: root, stdio: "pipe" }
        ),
      /id 不合法/,
      "id 校验与宿主同源"
    );

    const occupied = path.join(tmp, "occupied");
    execFileSync(
      process.execPath,
      ["scripts/create-plugin.mjs", occupied, "--id", "com.example.one", "--name", "一"],
      { cwd: root, stdio: "pipe" }
    );
    writeFileSync(path.join(occupied, "user-file.txt"), "keep me", "utf8");
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          ["scripts/create-plugin.mjs", occupied, "--id", "com.example.two", "--name", "二"],
          { cwd: root, stdio: "pipe" }
        ),
      /目标目录非空/,
      "不静默覆盖用户已有目录"
    );
    assert.equal(readFileSync(path.join(occupied, "user-file.txt"), "utf8"), "keep me");
    pass("非法 id 与非空目录都被拒绝，不破坏已有文件");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/* ============ 6. 类型声明覆盖新 API ============ */
{
  const dts = readFileSync(path.join(root, "packages/plugin-types/ms.d.ts"), "utf8");
  for (const token of [
    "interface MsApi",
    "lifecycle:",
    "commands:",
    "results:",
    "permissions:",
    "collection<T = unknown>",
    "subInput:",
    "secret",
    "MsPermissionRequestOutcome",
    "MsNetFetchOptions",
    "credentials:",
    "isolated?: boolean",
  ]) {
    assert.ok(dts.includes(token), `ms.d.ts 应包含 ${token}`);
  }
  assert.match(dts, /declare global/, "作为环境声明直接可用");
  assert.ok(
    !dts.includes("defaultTimeoutMs"),
    "results.limits 的真实契约没有 defaultTimeoutMs，类型不得虚构字段"
  );
  pass("ms.d.ts 覆盖生命周期 / 命令 / 结果 / 权限 / 集合 / 子输入框 / 密钥 / 网络凭据 / 隔离窗口");
}

console.log(`\n全部通过：${passed} 项类型包测试`);
