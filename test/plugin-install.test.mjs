/**
 * 插件安装链路测试 —— 从 `.msplugin` 字节到「可落盘的文件表」。
 *
 * 覆盖用户实际会遇到的形态与失败：
 *   1. 真实示例包（plugins/baidu-translate.zip，带包裹目录）能一路预处理通过
 *   2. 包裹目录被剥掉后，清单位于根、可被 Rust 侧读到
 *   3. 落盘文件表**包含 plugin.json**（历史上被当成普通文件过滤掉，
 *      导致 Rust 侧 `plugin.json 缺失` 必然失败）+ 字段名 `data` 与 Rust 对齐
 *   4. backend/ 下的可执行文件被正确标记
 *   5. 清单错误 / minAppVersion 不足 / 缺清单 → 可读中文文案
 *   6. 目录直挂（开发模式）用的清单解析
 *   7. 注册表安装/升级/卸载语义（保留用户选择、降级拒绝、数据清理）
 *
 * 为了不依赖 localStorage / Vue，这里对 registry 的部分用最小桩替代。
 *
 * 用法: node test/plugin-install.test.mjs
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { preparePackage, preparePackageFromBase64, InstallPrepError, isExecutablePath, sha256Hex } from "../src/lib/plugins/install.ts";
import { bytesToBase64, writeZip } from "../src/lib/plugins/package.ts";
import { isKnownPermission } from "../src/lib/plugins/permissions.ts";
import {
  describeManifestErrors,
  parsePluginManifest,
  checkMinAppVersion,
  compareVersion,
  isValidPluginId,
  isSafeRelativePath,
  isValidIconRef,
} from "../src/lib/plugins/manifest.ts";
import { buildPluginItems, isInlineIconRef } from "../src/lib/plugins/plugin-items.ts";
import { listSearchItems } from "../src/lib/plugins/manifest.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const enc = new TextEncoder();

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = "") => {
  if (cond) {
    pass++;
    console.log("PASS ", name, extra);
  } else {
    fail++;
    console.log("FAIL ", name, extra);
  }
};

/* ============ 1. 真实安装包端到端 ============ */
{
  const buf = readFileSync(path.join(root, "plugins", "baidu-translate.zip"));
  const bytes = new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const prepared = await preparePackage(bytes, {
    hostVersion: "7.9.15",
    checkPermissions: isKnownPermission,
  });
  ok(prepared.manifest.id === "com.mysearch.baidu-translate", "真实包预处理成功", prepared.manifest.id);
  ok(prepared.manifest.name === "百度翻译", "清单名称正确", prepared.manifest.name);

  // 演示插件的搜索项标题不应带 [推荐] / [脚本] 这类标签——
  // 插件项在结果列表里靠「图标左下角角标」标识，不需要再用标签占用标题空间
  const demoItems = listSearchItems(prepared.manifest);
  ok(demoItems.length === 1, "百度翻译贡献 1 个搜索项", `${demoItems.length}`);
  ok(demoItems[0].title === "百度翻译", "搜索项标题不含标签", demoItems[0].title);
  ok(!/\[[^\]]*\]/.test(demoItems[0].title), "搜索项标题里没有任何 [..] 标签");
  ok(
    prepared.manifest.icon === "https://api.xinac.net/icon/?url=https://fanyi.baidu.com",
    "清单图标使用指定的 favicon 服务地址",
    String(prepared.manifest.icon)
  );
  ok(
    prepared.files.some((f) => f.path === "plugin.json"),
    "落盘文件表包含 plugin.json（Rust 侧校验依赖它）"
  );
  ok(
    prepared.files.every((f) => typeof f.data === "string" && f.data.length > 0 && !("base64" in f)),
    "文件表字段为 data（与 Rust InstallFile 对齐）"
  );
  ok(
    prepared.files.some((f) => f.path === "ui/detail.html"),
    "包裹目录已剥离（路径为 ui/detail.html 而非 baidu-translate/ui/detail.html）",
    prepared.files.map((f) => f.path).join(",")
  );
  ok(prepared.sha256.length === 64 && /^[0-9a-f]+$/.test(prepared.sha256), "包摘要为 64 位十六进制", prepared.sha256.slice(0, 16) + "…");

  // 往返：清单原文能被 Rust 侧重新解析出同一个 id
  const back = JSON.parse(prepared.manifestText);
  ok(back.id === prepared.manifest.id, "清单原文可被重新解析（Rust 侧 id 一致性校验会通过）");

  // base64 入口（面板真实路径）
  const viaB64 = await preparePackageFromBase64(bytesToBase64(bytes), {
    hostVersion: "7.9.15",
    checkPermissions: isKnownPermission,
  });
  ok(viaB64.manifest.id === prepared.manifest.id, "base64 入口与字节入口一致");
}

/* ============ 2. 包裹目录（用户右键压缩整目录） ============ */
{
  const zip = await writeZip([
    {
      name: "my-plugin/plugin.json",
      data: enc.encode(
        JSON.stringify({
          id: "com.example.wrapped",
          name: "被包裹的插件",
          version: "1.0.0",
          apiVersion: 1,
          permissions: ["ui.inlay"],
        })
      ),
    },
    { name: "my-plugin/ui/index.html", data: enc.encode("<p>hi</p>") },
    { name: "my-plugin/ui/index.js", data: enc.encode("ms.log('info','ok')") },
  ]);
  const prepared = await preparePackage(zip, { checkPermissions: isKnownPermission });
  ok(prepared.manifest.id === "com.example.wrapped", "包裹目录包可安装");
  ok(
    prepared.files.map((f) => f.path).sort().join(",") === "plugin.json,ui/index.html,ui/index.js",
    "包裹目录剥净",
    prepared.files.map((f) => f.path).join(",")
  );
}

/* ============ 3. 可执行位标记 ============ */
{
  ok(isExecutablePath("backend/run.exe"), "backend/*.exe 标记可执行");
  ok(isExecutablePath("backend/tool.py"), "backend/*.py 标记可执行");
  ok(!isExecutablePath("ui/index.js"), "ui/*.js 不标记可执行");
  ok(!isExecutablePath("backend/readme.txt"), "backend 下非可执行扩展名不标记");

  const zip = await writeZip([
    {
      name: "plugin.json",
      data: enc.encode(JSON.stringify({ id: "com.example.be", name: "带后端", version: "1.0.0", apiVersion: 1, permissions: ["backend.spawn"], backend: { entry: "backend/serve.exe" } })),
    },
    { name: "backend/serve.exe", data: enc.encode("MZfake") },
  ]);
  const prepared = await preparePackage(zip, { checkPermissions: isKnownPermission });
  const exe = prepared.files.find((f) => f.path === "backend/serve.exe");
  ok(exe?.executable === true, "安装包里的 backend 可执行文件被标记");
  ok(prepared.manifest.backend?.entry === "backend/serve.exe", "backend 规格解析正确");
}

/* ============ 4. 失败形态给可读文案 ============ */
{
  // 缺清单
  const noManifest = await writeZip([{ name: "readme.txt", data: enc.encode("nothing") }]);
  let e1 = null;
  try {
    await preparePackage(noManifest);
  } catch (e) {
    e1 = e;
  }
  ok(e1 instanceof InstallPrepError, "缺 plugin.json 抛 InstallPrepError");
  ok(/plugin\.json/.test(e1.message), "缺清单文案提到 plugin.json", e1.message);

  // 清单非法 JSON
  const badJson = await writeZip([{ name: "plugin.json", data: enc.encode("{ not json") }]);
  let e2 = null;
  try {
    await preparePackage(badJson);
  } catch (e) {
    e2 = e;
  }
  ok(e2 instanceof InstallPrepError && /JSON/.test(e2.message), "非法 JSON 文案可读", e2?.message);

  // 非 ZIP
  let e3 = null;
  try {
    await preparePackage(enc.encode("not a zip at all, definitely not"));
  } catch (e) {
    e3 = e;
  }
  ok(e3 instanceof InstallPrepError, "非 ZIP 抛 InstallPrepError", e3?.message);

  // minAppVersion 不足
  const tooNew = await writeZip([
    {
      name: "plugin.json",
      data: enc.encode(JSON.stringify({ id: "com.example.future", name: "未来插件", version: "1.0.0", apiVersion: 1, minAppVersion: "99.0.0" })),
    },
  ]);
  let e4 = null;
  try {
    await preparePackage(tooNew, { hostVersion: "7.9.15" });
  } catch (e) {
    e4 = e;
  }
  ok(e4 instanceof InstallPrepError && /99\.0\.0/.test(e4.message), "minAppVersion 不足被拦下", e4?.message);

  // 未知权限
  const unknownPerm = await writeZip([
    {
      name: "plugin.json",
      data: enc.encode(JSON.stringify({ id: "com.example.badperm", name: "坏权限", version: "1.0.0", apiVersion: 1, permissions: ["net.evil"] })),
    },
  ]);
  let e5 = null;
  try {
    await preparePackage(unknownPerm, { checkPermissions: isKnownPermission });
  } catch (e) {
    e5 = e;
  }
  ok(e5 instanceof InstallPrepError && /net\.evil/.test(e5.message), "未知权限被拦下且点名", e5?.message);
}

/* ============ 5. 保留前缀降级为警告（官方示例插件要能装） ============ */
{
  const reserved = await writeZip([
    {
      name: "plugin.json",
      data: enc.encode(
        JSON.stringify({
          id: "com.mysearch.official-demo",
          name: "官方示例",
          version: "1.0.0",
          apiVersion: 1,
          permissions: ["ui.inlay"],
        })
      ),
    },
  ]);
  const prepared = await preparePackage(reserved, { checkPermissions: isKnownPermission });
  ok(prepared.manifest.id === "com.mysearch.official-demo", "保留前缀不再硬拦截（降级为警告）");
  // 警告必须是**已翻译**的可读文案：它会被原样拼进安装确认弹窗，
  // 透传 `id.reservedPrefix:com.mysearch.official-demo` 就是给用户看天书。
  ok(
    prepared.warnings.some((w) => w.includes("官方保留前缀")),
    "保留前缀产生可读警告（不再是内部错误码）",
    prepared.warnings.join(",")
  );
  ok(
    !prepared.warnings.some((w) => w.includes("reservedPrefix:")),
    "警告里不再出现内部错误码原文",
    prepared.warnings.join(",")
  );
}

/* ============ 6. 清单校验与版本比较 ============ */
{
  ok(compareVersion("7.9.15", "7.9.9") > 0, "版本比较：7.9.15 > 7.9.9");
  ok(compareVersion("7.10.0", "7.9.99") > 0, "版本比较按数字段而非字典序");
  ok(compareVersion("2.0.0", "2.0.0") === 0, "版本比较：相等");

  ok(isValidPluginId("com.example.a-b"), "合法 id 通过");
  ok(!isValidPluginId("single"), "单段 id 拒绝");
  ok(!isValidPluginId("Com.Example"), "大写拒绝");
  ok(!isValidPluginId("com..example"), "连续点拒绝");
  ok(!isValidPluginId("-bad.example"), "以中划线开头拒绝");

  ok(isSafeRelativePath("ui/detail.html"), "安全相对路径");
  ok(!isSafeRelativePath("../evil"), "相对路径拒绝 ..");
  ok(!isSafeRelativePath("C:/x"), "相对路径拒绝盘符");
  ok(!isSafeRelativePath("/etc/x"), "相对路径拒绝绝对路径");

  // 图标引用：支持「相对路径 / data: / http(s):」三种形态
  ok(isValidIconRef("icon.png"), "图标允许插件内相对路径");
  ok(isValidIconRef("assets/logo.svg"), "图标允许子目录相对路径");
  ok(isValidIconRef("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="), "图标允许 data: 内联");
  ok(
    isValidIconRef("https://api.xinac.net/icon/?url=https://fanyi.baidu.com"),
    "图标允许 https 网络地址（第三方 favicon 服务）"
  );
  ok(isValidIconRef("http://example.com/i.png"), "图标允许 http 网络地址");
  ok(!isValidIconRef("javascript:alert(1)"), "图标拒绝 javascript:");
  ok(!isValidIconRef("file:///etc/passwd"), "图标拒绝 file:");
  ok(!isValidIconRef("../outside.png"), "图标拒绝路径穿越");
  ok(!isValidIconRef(""), "图标拒绝空串");

  // 清单错误码 → 可读文案（不再把内部码抛给用户）
  const parsed = parsePluginManifest(JSON.stringify({ name: "x" }), isKnownPermission);
  ok(!parsed.ok, "缺 id / version / apiVersion 时解析失败");
  const msgs = describeManifestErrors(parsed.errors);
  ok(msgs.every((m) => !/^[a-zA-Z.]+$/.test(m)), "错误文案均为中文可读", msgs.join(" | "));
  ok(msgs.some((m) => m.includes("缺少插件 id")), "错误文案点明缺 id");

  const okManifest = parsePluginManifest(
    JSON.stringify({ id: "com.example.ok", name: "好插件", version: "1.2.3", apiVersion: 1 }),
    isKnownPermission
  );
  ok(okManifest.ok, "最小合法清单通过");
  ok(checkMinAppVersion(okManifest.manifest, "1.0.0").ok, "minAppVersion 缺省时不拦");

  // 权限与 backend 的一致性（两条互斥规则）
  const spawnNoBackend = parsePluginManifest(
    JSON.stringify({ id: "com.example.x1", name: "x", version: "1.0.0", apiVersion: 1, permissions: ["backend.spawn"] }),
    isKnownPermission
  );
  ok(!spawnNoBackend.ok, "申请 backend.spawn 但无 backend → 拒绝");
  const backendNoSpawn = parsePluginManifest(
    JSON.stringify({ id: "com.example.x2", name: "x", version: "1.0.0", apiVersion: 1, backend: { entry: "backend/a.exe" } }),
    isKnownPermission
  );
  ok(!backendNoSpawn.ok, "声明 backend 但未申请 backend.spawn → 拒绝");

  // scope 必需但缺失
  const noScope = parsePluginManifest(
    JSON.stringify({ id: "com.example.x3", name: "x", version: "1.0.0", apiVersion: 1, permissions: ["net.fetch"] }),
    isKnownPermission
  );
  ok(!noScope.ok, "net.fetch 缺 scope → 拒绝");
  ok(
    describeManifestErrors(noScope.errors).some((m) => m.includes("scope")),
    "缺 scope 文案可读",
    describeManifestErrors(noScope.errors).join(" | ")
  );

  // apiVersion 过高
  const tooNewApi = parsePluginManifest(
    JSON.stringify({ id: "com.example.x4", name: "x", version: "1.0.0", apiVersion: 999 }),
    isKnownPermission
  );
  ok(!tooNewApi.ok, "apiVersion 过高 → 拒绝");
  ok(
    describeManifestErrors(tooNewApi.errors).some((m) => m.includes("API 版本")),
    "apiVersion 文案可读"
  );

  // 贡献点：searchItem / command / detailView
  const contributes = parsePluginManifest(
    JSON.stringify({
      id: "com.example.x5",
      name: "x",
      version: "1.0.0",
      apiVersion: 1,
      contributes: {
        searchItem: { title: "[推荐][脚本]测试", keyword: "测试" },
        command: [{ id: "go", prefix: "测试 : ", title: "测试" }],
        detailView: { entry: "ui/index.html", compat: "ms-script-env" },
      },
    }),
    isKnownPermission
  );
  ok(contributes.ok, "含贡献点的清单通过", contributes.ok ? "" : contributes.errors.join(","));
  ok(contributes.ok && contributes.manifest.contributes?.searchItem?.keyword === "测试", "searchItem 保留关键词");
  ok(contributes.ok && contributes.manifest.contributes?.detailView?.compat === "ms-script-env", "detailView compat 保留");

  const unsafeEntry = parsePluginManifest(
    JSON.stringify({
      id: "com.example.x6",
      name: "x",
      version: "1.0.0",
      apiVersion: 1,
      contributes: { detailView: { entry: "../../etc/passwd" } },
    }),
    isKnownPermission
  );
  ok(!unsafeEntry.ok, "detailView 入口路径穿越 → 拒绝");

  // 数值字段夹紧（写错不让插件装不上）
  const clamped = parsePluginManifest(
    JSON.stringify({
      id: "com.example.x7",
      name: "x",
      version: "1.0.0",
      apiVersion: 1,
      permissions: ["backend.spawn"],
      backend: { entry: "backend/a.exe", callTimeoutMs: 999999, idleExitSec: -5 },
    }),
    isKnownPermission
  );
  ok(clamped.ok, "越界数值不致命");
  ok(clamped.ok && clamped.manifest.backend?.callTimeoutMs === 300000, "callTimeoutMs 夹到上限", String(clamped.manifest.backend?.callTimeoutMs));
  ok(clamped.ok && clamped.manifest.backend?.idleExitSec === 0, "idleExitSec 夹到下限", String(clamped.manifest.backend?.idleExitSec));
}

/* ============ 7. sha256 工具 ============ */
{
  const h = await sha256Hex(enc.encode("abc"));
  ok(h === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "sha256 标准向量", h);
}

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
