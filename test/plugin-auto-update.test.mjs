/**
 * 插件级「自动更新（autoUpdate）」单元测试与源码契约校验（纯 Node 运行）。
 *
 * 覆盖契约：
 *   1. 清单契约：未声明时默认 `false`（`DEFAULT_PLUGIN_AUTO_UPDATE === false`），
 *      显式声明 `true/false` 保留，非布尔值拒绝并给出可读错误；
 *   2. 仓库内全部自研插件（`plugins/`*`/plugin.json`）均显式声明 `"autoUpdate": true` 且通过校验；
 *   3. 注册表与升级合并契约：
 *      - 安装确认弹窗可显式覆盖 `autoUpdate`（用户在安装时可直接关闭或开启）；
 *      - 后续静默升级保留用户的开关选择（用户关掉后新版写 `autoUpdate: true` 也不会强行打开，
 *        用户手动打开后新版写 `autoUpdate: false` 也不会关掉）；
 *      - 本地 `file` / `folder` 来源插件 `isPluginAutoUpdateEnabled` 恒为 `false`；
 *   4. `runPluginAutoUpdate` 编排流水线：
 *      - 所有已安装插件 `autoUpdate` 均为关闭时零网络请求（`checked: false`）；
 *      - 只要插件已开启 `autoUpdate`，普通新增权限（如 `store`）仍静默下载、自动授予并替换落盘；
 *      - 新增 `critical` 权限（如 `backend.spawn`）或 `scope:*` 时不落盘，只登记
 *        `pendingUpgrade` + 更新角标，等用户确认（不得静默提权）；
 *      - 关闭 `autoUpdate` 的插件仅更新 `updateAvailable` 角标，绝不自动下载安装；
 *   5. UI 接线契约：`PanelGeneral.vue` 无全局自动更新插件开关，`PluginInstallDialog.vue`、
 *      `PanelPlugins.vue` 与 `search/App.vue` 闭环接线完整。
 *
 * 用法: node test/plugin-auto-update.test.mjs
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

const {
  DEFAULT_PLUGIN_AUTO_UPDATE,
  describeManifestErrors,
  manifestAutoUpdateOf,
  parsePluginManifest,
} = await import("../src/lib/plugins/manifest.ts");
const { isKnownPermission } = await import("../src/lib/plugins/permissions.ts");
const {
  behaviorSuggestionOf,
  createPluginRecord,
  isPluginAutoUpdateEnabled,
  loadRegistry,
  resolveAutoUpdateOnUpgrade,
  resolveInstallDialogAutoUpdate,
  saveRegistry,
  upsertPlugin,
} = await import("../src/lib/plugins/registry.ts");
const {
  hasAnyAutoUpdatePlugin,
  runPluginAutoUpdate,
} = await import("../src/lib/plugins/auto-update.ts");
const { readCatalogWithIntegrity } = await import("../src/lib/plugins/index-signature.ts");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
function pass(label) {
  passed++;
  console.log(`PASS  ${label}`);
}

/* ============ 1. 清单契约：默认 false + 类型校验 ============ */
{
  assert.equal(DEFAULT_PLUGIN_AUTO_UPDATE, false, "清单未声明时默认必须为 false");

  const omitted = parsePluginManifest(
    { id: "com.example.omitted", name: "Omitted", version: "1.0.0", apiVersion: 1 },
    isKnownPermission
  );
  assert.equal(omitted.ok, true);
  assert.equal(manifestAutoUpdateOf(omitted.manifest), false);
  assert.equal(behaviorSuggestionOf(omitted.manifest).autoUpdate, false);

  const enabled = parsePluginManifest(
    { id: "com.example.on", name: "On", version: "1.0.0", apiVersion: 1, autoUpdate: true },
    isKnownPermission
  );
  assert.equal(enabled.ok, true);
  assert.equal(enabled.manifest.autoUpdate, true);
  assert.equal(manifestAutoUpdateOf(enabled.manifest), true);
  assert.equal(behaviorSuggestionOf(enabled.manifest).autoUpdate, true);

  const bad = parsePluginManifest(
    { id: "com.example.bad", name: "Bad", version: "1.0.0", apiVersion: 1, autoUpdate: "yes" },
    isKnownPermission
  );
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.includes("autoUpdate.invalid"));
  assert.match(describeManifestErrors(bad.errors).join("；"), /autoUpdate/);
  pass("清单 autoUpdate 默认关闭（false）且类型校验完整");
}

/* ============ 2. 仓库内全部自研插件均已声明 autoUpdate: true ============ */
{
  const pluginsDir = path.join(root, "plugins");
  let count = 0;
  for (const dir of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const mfPath = path.join(pluginsDir, dir.name, "plugin.json");
    if (!existsSync(mfPath)) continue;
    count++;
    const raw = readFileSync(mfPath, "utf8");
    const parsed = parsePluginManifest(raw, isKnownPermission);
    assert.ok(
      parsed.ok,
      `plugins/${dir.name}/plugin.json 校验失败: ${(parsed.errors || []).join(", ")}`
    );
    assert.equal(
      parsed.manifest.autoUpdate,
      true,
      `plugins/${dir.name}/plugin.json 应声明 "autoUpdate": true`
    );
  }
  assert.ok(count >= 13, `应扫描到全部自研插件（实际 ${count} 个）`);
  pass(`仓库内全部 ${count} 个自研插件均已声明 "autoUpdate": true 并通过清单校验`);
}

/* ============ 3. 注册表记录与安装/升级合并规则 ============ */
{
  const parse = (extra = {}) =>
    parsePluginManifest(
      { id: "com.example.demo", name: "Demo", version: "1.0.0", apiVersion: 1, ...extra },
      isKnownPermission
    ).manifest;

  const userTurnedOff = createPluginRecord({
    manifest: parse({ autoUpdate: true }),
    dir: "plugins/com.example.demo",
    source: { kind: "market", ref: "https://a" },
    autoUpdate: false,
  });
  assert.equal(userTurnedOff.autoUpdate, false, "安装弹窗用户关闭应覆盖清单建议值");
  assert.equal(isPluginAutoUpdateEnabled(userTurnedOff), false);

  const reg = { version: 1, plugins: [userTurnedOff] };
  const nextRec = createPluginRecord({
    manifest: parse({ version: "1.1.0", autoUpdate: true }),
    dir: "plugins/com.example.demo",
    source: { kind: "market", ref: "https://b" },
  });
  const merged = upsertPlugin(reg, nextRec, { preserveUserChoices: true });
  assert.equal(merged.autoUpdate, false, "静默升级不得覆盖用户主动关闭的 autoUpdate");

  mem.clear();
  const legacyRaw = createPluginRecord({
    manifest: parse({ autoUpdate: true }),
    dir: "plugins/com.example.demo",
    source: { kind: "builtin" },
  });
  delete legacyRaw.autoUpdate;
  saveRegistry({ version: 1, plugins: [legacyRaw] });
  const hydrated = loadRegistry().plugins[0];
  assert.equal(hydrated.autoUpdate, true, "缺字段的历史记录应按清单建议值补齐");

  assert.equal(
    resolveAutoUpdateOnUpgrade({
      current: false,
      prevManifest: parse({}),
      nextManifest: parse({ autoUpdate: true }),
    }),
    true
  );

  // 安装确认弹窗开关初始状态规则（resolveInstallDialogAutoUpdate）：
  // 1) 新装声明 autoUpdate: true 的插件 → 开关默认开启（true），用户可手动关闭
  assert.equal(
    resolveInstallDialogAutoUpdate({
      action: "install",
      existing: null,
      nextManifest: parse({ autoUpdate: true }),
    }),
    true,
    "新装声明 autoUpdate: true 的插件时，安装弹窗开关必须默认开启"
  );
  // 2) 新装未声明 autoUpdate 的插件 → 开关默认关闭（false），用户可手动开启
  assert.equal(
    resolveInstallDialogAutoUpdate({
      action: "install",
      existing: null,
      nextManifest: parse({}),
    }),
    false,
    "新装未声明 autoUpdate 的插件时，安装弹窗开关必须默认关闭"
  );
  // 3) 从未声明 autoUpdate 的旧版本升级到声明 autoUpdate: true 的新版本 → 开关默认开启（true）
  const preAutoUpdateRec = createPluginRecord({
    manifest: parse({ version: "1.0.0" }),
    dir: "plugins/com.example.demo",
    source: { kind: "market" },
  });
  assert.equal(preAutoUpdateRec.autoUpdate, false);
  assert.equal(
    resolveInstallDialogAutoUpdate({
      action: "update",
      existing: preAutoUpdateRec,
      nextManifest: parse({ version: "1.1.0", autoUpdate: true }),
    }),
    true,
    "从旧版（未声明 autoUpdate）升级到声明 autoUpdate: true 的新版时，安装弹窗开关必须默认开启"
  );
  // 4) 重新安装同版本（或显式 install）声明 autoUpdate: true 的插件 → 开关回到插件声明的开启状态
  assert.equal(
    resolveInstallDialogAutoUpdate({
      action: "install",
      existing: userTurnedOff,
      nextManifest: parse({ version: "1.0.0", autoUpdate: true }),
    }),
    true,
    "重新安装声明 autoUpdate: true 的插件时，开关应按插件声明默认开启"
  );
  // 5) 已声明 autoUpdate: true 但用户曾主动关闭后手动点跨版本 update → 保留用户关闭选择
  assert.equal(
    resolveInstallDialogAutoUpdate({
      action: "update",
      existing: userTurnedOff,
      nextManifest: parse({ version: "1.2.0", autoUpdate: true }),
    }),
    false,
    "用户主动关掉已声明开启的插件后手动升级新版本时保留关闭选择"
  );

  // upsertPlugin explicitAutoUpdate：保留其它用户偏好同时精确写入弹窗开关结果
  userTurnedOff.enabled = false;
  const upgradedViaDialog = upsertPlugin(
    { version: 1, plugins: [structuredClone(userTurnedOff)] },
    createPluginRecord({
      manifest: parse({ version: "1.2.0", autoUpdate: true }),
      dir: "plugins/com.example.demo",
      source: { kind: "file", ref: "D:/demo.mspp" },
      autoUpdate: true,
    }),
    { preserveUserChoices: true, explicitAutoUpdate: true }
  );
  assert.equal(upgradedViaDialog.enabled, false, "保留用户原本禁用态");
  assert.equal(upgradedViaDialog.autoUpdate, true, "explicitAutoUpdate 应按弹窗最终开关状态落盘");

  const localOnRec = createPluginRecord({
    manifest: parse({ autoUpdate: true }),
    dir: "plugins/com.example.demo",
    source: { kind: "file", ref: "D:/demo.mspp" },
    autoUpdate: true,
  });
  assert.equal(isPluginAutoUpdateEnabled(localOnRec), true, ".mspp 安装开启自动更新后允许参与自动更新");

  const localOffRec = createPluginRecord({
    manifest: parse({ autoUpdate: true }),
    dir: "plugins/com.example.demo",
    source: { kind: "file", ref: "D:/demo.mspp" },
    autoUpdate: false,
  });
  assert.equal(isPluginAutoUpdateEnabled(localOffRec), false, ".mspp 安装在弹窗中关闭后不自动更新");

  const folderRec = createPluginRecord({
    manifest: parse({ autoUpdate: true }),
    dir: "plugins/com.example.demo",
    source: { kind: "folder", ref: "D:/src/demo", dev: true },
    autoUpdate: true,
  });
  assert.equal(isPluginAutoUpdateEnabled(folderRec), false, "开发目录挂载插件永不参与市场覆盖");
  pass("注册表创建、安装弹窗初始状态、升级保留用户选择与来源隔离规则全部正确");
}

/* ============ 4. runPluginAutoUpdate 全静默升级编排测试 ============ */
{
  const mfOf = (obj) => {
    const r = parsePluginManifest(JSON.stringify(obj), isKnownPermission);
    assert.ok(r.ok, `测试清单解析失败: ${(r.errors || []).join(", ")}`);
    return r.manifest;
  };

  // 4.1 注册表中无任何开启 autoUpdate 的市场/内置插件 → 零网络开销短路
  let fetchCalls = 0;
  const allOffReg = {
    version: 1,
    plugins: [
      createPluginRecord({
        manifest: mfOf({ id: "com.example.off", name: "Off", version: "1.0.0", apiVersion: 1 }),
        dir: "plugins/com.example.off",
        source: { kind: "market" },
      }),
    ],
  };
  assert.equal(hasAnyAutoUpdatePlugin(allOffReg), false);
  const idleRes = await runPluginAutoUpdate({
    readRegistry: () => allOffReg,
    fetchRaw: async () => {
      fetchCalls++;
      return new Uint8Array();
    },
  });
  assert.equal(idleRes.checked, false);
  assert.equal(fetchCalls, 0, "无插件开启 autoUpdate 时不得发起网络请求");

  // 4.2 混合场景：
  //  - com.example.safe (market, autoUpdate=true, 权限不变, enabled=false) → 静默升级并保留禁用态
  //  - com.example.newperm (builtin, autoUpdate=true, 新版新增 backend.spawn) → 同样直接全静默升级并授予新权限！
  //  - com.example.manual (market, autoUpdate=false, 有新版本) → 只写 updateAvailable 角标，绝不自动下载安装
  //  - com.example.active (market, autoUpdate=true, 正在前台使用) → skippedActive 暂缓
  const pSafe = createPluginRecord({
    manifest: mfOf({
      id: "com.example.safe",
      name: "SafePlugin",
      version: "1.0.0",
      apiVersion: 1,
      autoUpdate: true,
      permissions: ["ui.inlay", "store"],
    }),
    dir: "plugins/com.example.safe",
    source: { kind: "market", ref: "https://old" },
    grants: ["ui.inlay", "store"],
  });
  pSafe.enabled = false;

  const pNewPerm = createPluginRecord({
    manifest: mfOf({
      id: "com.example.newperm",
      name: "NewPermPlugin",
      version: "1.0.0",
      apiVersion: 1,
      autoUpdate: true,
      permissions: ["ui.inlay"],
    }),
    dir: "plugins/com.example.newperm",
    source: { kind: "builtin" },
    grants: ["ui.inlay"],
  });

  const pManual = createPluginRecord({
    manifest: mfOf({
      id: "com.example.manual",
      name: "ManualPlugin",
      version: "1.0.0",
      apiVersion: 1,
      autoUpdate: true,
      permissions: ["ui.inlay"],
    }),
    dir: "plugins/com.example.manual",
    source: { kind: "market" },
    grants: ["ui.inlay"],
    autoUpdate: false,
  });

  const pActive = createPluginRecord({
    manifest: mfOf({
      id: "com.example.active",
      name: "ActivePlugin",
      version: "1.0.0",
      apiVersion: 1,
      autoUpdate: true,
      permissions: ["ui.inlay"],
    }),
    dir: "plugins/com.example.active",
    source: { kind: "market" },
    grants: ["ui.inlay"],
  });

  let regState = { version: 1, plugins: [pSafe, pNewPerm, pManual, pActive] };
  const sha = "a".repeat(64);
  const ts = "2026-11-18T00:00:00.000Z";
  const catalogJson = JSON.stringify({
    schemaVersion: 1,
    generatedAt: ts,
    baseUrl: "https://github.com/My-Search/my-search-plugin-market/releases/download",
    plugins: [
      {
        id: "com.example.safe",
        name: "SafePlugin",
        version: "1.1.0",
        apiVersion: 1,
        categories: ["tools"],
        description: "safe update",
        author: "tester",
        downloadUrl: "https://github.com/a/b/releases/download/v1.1.0/com.example.safe.mspp",
        sha256: sha,
        size: 128,
        permissions: ["ui.inlay", "store"],
        publishedAt: ts,
        updatedAt: ts,
      },
      {
        id: "com.example.newperm",
        name: "NewPermPlugin",
        version: "1.2.0",
        apiVersion: 1,
        categories: ["tools"],
        description: "newperm update",
        author: "tester",
        downloadUrl: "https://github.com/a/b/releases/download/v1.2.0/com.example.newperm.mspp",
        sha256: sha,
        size: 128,
        permissions: ["ui.inlay", "backend.spawn"],
        publishedAt: ts,
        updatedAt: ts,
      },
      {
        id: "com.example.manual",
        name: "ManualPlugin",
        version: "1.1.0",
        apiVersion: 1,
        categories: ["tools"],
        description: "manual only",
        author: "tester",
        downloadUrl: "https://github.com/a/b/releases/download/v1.1.0/com.example.manual.mspp",
        sha256: sha,
        size: 128,
        permissions: ["ui.inlay"],
        publishedAt: ts,
        updatedAt: ts,
      },
      {
        id: "com.example.active",
        name: "ActivePlugin",
        version: "1.1.0",
        apiVersion: 1,
        categories: ["tools"],
        description: "active update",
        author: "tester",
        downloadUrl: "https://github.com/a/b/releases/download/v1.1.0/com.example.active.mspp",
        sha256: sha,
        size: 128,
        permissions: ["ui.inlay"],
        publishedAt: ts,
        updatedAt: ts,
      },
    ],
  });

  const packageManifests = {
    "https://github.com/a/b/releases/download/v1.1.0/com.example.safe.mspp": mfOf({
      id: "com.example.safe",
      name: "SafePlugin",
      version: "1.1.0",
      apiVersion: 1,
      autoUpdate: true,
      permissions: ["ui.inlay", "store"],
    }),
    "https://github.com/a/b/releases/download/v1.2.0/com.example.newperm.mspp": mfOf({
      id: "com.example.newperm",
      name: "NewPermPlugin",
      version: "1.2.0",
      apiVersion: 1,
      autoUpdate: true,
      permissions: ["ui.inlay", "backend.spawn"],
      backend: { entry: "backend/run.cmd", command: ["node", "backend/index.mjs"] },
    }),
  };

  const downloadedPkgUrls = [];
  const writtenPackages = [];

  const res = await runPluginAutoUpdate({
    hostVersion: "7.9.35",
    fetchRaw: async (_pid, url) => {
      if (url.endsWith("index.dist.json")) {
        return new TextEncoder().encode(catalogJson);
      }
      downloadedPkgUrls.push(url);
      return new TextEncoder().encode(url);
    },
    readCatalog: (raw) => readCatalogWithIntegrity(raw, { requireSignature: false }),
    unpack: async (bytes) => {
      const url = new TextDecoder("utf-8").decode(bytes);
      const manifest = packageManifests[url];
      assert.ok(manifest, `不应下载此包: ${url}`);
      return {
        manifest,
        manifestText: JSON.stringify(manifest),
        files: [{ path: "plugin.json", data: "e30=" }],
        sha256: sha,
        warnings: [],
      };
    },
    writePackage: async (id) => {
      writtenPackages.push(id);
      return `plugins/${id}`;
    },
    readRegistry: () => structuredClone(regState),
    writeRegistry: (next) => {
      regState = structuredClone(next);
    },
    syncOneGateway: async () => {},
    syncShortcuts: async () => {},
    markRestart: () => {},
    isPluginActiveInForeground: (id) => id === "com.example.active",
  });

  assert.equal(res.checked, true);
  assert.deepEqual(res.updated, [{ id: "com.example.safe", from: "1.0.0", to: "1.1.0" }]);
  assert.deepEqual(res.blocked, [
    { id: "com.example.newperm", version: "1.2.0", permissions: ["backend.spawn"] },
  ]);
  assert.deepEqual(res.skippedActive, ["com.example.active"]);
  assert.ok(
    !downloadedPkgUrls.some((u) => u.includes("com.example.manual")),
    "关闭了自动更新的插件不得被后台下载"
  );
  assert.deepEqual(writtenPackages, ["com.example.safe"], "高危新增权限的版本不得落盘");

  const safeAfter = regState.plugins.find((p) => p.id === "com.example.safe");
  assert.equal(safeAfter.version, "1.1.0");
  assert.equal(safeAfter.enabled, false, "保留用户原本禁用态");

  const newPermAfter = regState.plugins.find((p) => p.id === "com.example.newperm");
  assert.equal(newPermAfter.version, "1.0.0", "新增 critical 权限不得静默升级");
  assert.ok(
    !newPermAfter.grants.some((g) => g.permission === "backend.spawn"),
    "待确认期间不得预先授予 backend.spawn"
  );
  assert.equal(newPermAfter.updateAvailable, "1.2.0", "角标指向新版本，提示用户去确认");
  assert.deepEqual(
    newPermAfter.pendingUpgrade?.blockedPermissions,
    ["backend.spawn"],
    "登记待确认权限清单"
  );
  assert.equal(newPermAfter.pendingUpgrade?.version, "1.2.0");
  assert.equal(
    newPermAfter.pendingUpgrade?.sha256,
    sha,
    "记录包摘要，用户确认后仍按该摘要复核"
  );

  const manualAfter = regState.plugins.find((p) => p.id === "com.example.manual");
  assert.equal(manualAfter.version, "1.0.0", "手动关闭自动更新的插件保持原版本");
  assert.equal(manualAfter.updateAvailable, "1.1.0", "手动更新插件仍显示可更新角标");
  pass("runPluginAutoUpdate 静默升级普通权限、拦截 critical 权限并可回退确认，跳过关闭项");
}

/* ============ 5. UI 闭环接线校验 ============ */
{
  const panelGeneral = readFileSync(
    path.join(root, "src/windows/config/panels/PanelGeneral.vue"),
    "utf8"
  );
  const installDialog = readFileSync(
    path.join(root, "src/components/PluginInstallDialog.vue"),
    "utf8"
  );
  const panelPlugins = readFileSync(
    path.join(root, "src/windows/config/panels/PanelPlugins.vue"),
    "utf8"
  );
  const searchApp = readFileSync(path.join(root, "src/windows/search/App.vue"), "utf8");
  const marketApi = readFileSync(path.join(root, "src/lib/plugins/host/market-api.ts"), "utf8");

  assert.ok(
    !panelGeneral.includes("auto-update-plugins") && !panelGeneral.includes("自动更新插件"),
    "基础配置面板不应包含全局自动更新插件开关"
  );
  assert.match(installDialog, /data-act="install-auto-update"/);
  assert.match(installDialog, /自动更新此插件/);
  assert.match(marketApi, /resolveInstallDialogAutoUpdate\(/);
  assert.match(panelPlugins, /resolveInstallDialogAutoUpdate\(/);
  assert.match(panelPlugins, /autoUpdate:\s*chosenAutoUpdate/);
  assert.match(panelPlugins, /function setAutoUpdate/);
  assert.match(panelPlugins, /rec\.autoUpdate = s\.autoUpdate/);
  assert.match(searchApp, /resolveInstallDialogAutoUpdate\(/);
  assert.match(searchApp, /autoUpdate:\s*chosenAutoUpdate/);
  assert.match(searchApp, /:show-auto-update="installDialogShowAutoUpdate"/);
  pass("基础配置不含全局开关，市场安装、面板 .mspp 安装与搜索窗 .mspp 安装三处均默认同步插件声明状态");
}

console.log(`\n全部通过：${passed} 项插件级自动更新测试`);
