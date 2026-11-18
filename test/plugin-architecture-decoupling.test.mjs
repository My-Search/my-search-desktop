/**
 * 插件宿主架构解耦与运行期契约综合验证（Node 直跑，覆盖 P0~P3 核心改进点）。
 *
 * 验证矩阵：
 *   1. **零业务插件 ID 硬编码**：Rust 全量源码与前端遮罩窗不含特定业务插件 ID 常量；
 *   2. **表驱动网关与权限深防**：`createHostApi` 对禁用插件抛 `PluginUnavailableError`，
 *      未授权权限抛 `PluginPermissionError`，已授权能力正常调用并记录 `auditLog`；
 *   3. **会话级监听零泄漏**：`disposePluginHostSession(pluginId)` 一次性清空全部 7 类事件订阅；
 *   4. **通用原语能力**：`ms.store.readJson/writeJson/removeJson`、`ms.shortcuts.get/set`、
 *      `ms.ui.openWindow`、`wantsClipboardCapture` 清单解析；
 *   5. **剪贴板插件领域自治**：在模拟宿主沙箱中实跑 `plugins/clipboard/ui/index.js`，
 *      验证历史 `annotations.legacy` 迁移、收藏/分类同步 `setRetained`、行内文本编辑与复制覆盖。
 *
 * 用法: node test/plugin-architecture-decoupling.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 先挂载最小浏览器全局桩（供纯 Node 导入前端模块）
const memStorage = new Map();
globalThis.localStorage = {
  getItem: (k) => (memStorage.has(k) ? memStorage.get(k) : null),
  setItem: (k, v) => memStorage.set(k, String(v)),
  removeItem: (k) => memStorage.delete(k),
  key: (i) => [...memStorage.keys()][i] ?? null,
  get length() {
    return memStorage.size;
  },
  clear: () => memStorage.clear(),
};

const {
  createHostApi,
  disposePluginHostSession,
  activeSubscriptionCountForPlugin,
  dispatchShortcutAction,
  readPluginThemeProvider,
  PluginPermissionError,
  PluginUnavailableError,
  auditLog,
} = await import("../src/lib/plugins/host.ts");
const { parsePluginManifest } = await import("../src/lib/plugins/manifest.ts");
const { createPluginRecord } = await import("../src/lib/plugins/registry.ts");
const { gatewaySpecOf, wantsClipboardCapture } = await import("../src/lib/plugins/gateway.ts");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;

function pass(name) {
  passed++;
  console.log(`PASS  ${name}`);
}

/* ============ 1. 宿主源码零业务插件 ID 硬编码 ============ */
{
  const rustDir = path.join(root, "src-tauri", "src");
  for (const name of readdirSync(rustDir)) {
    if (!name.endsWith(".rs") || name === "builtin.rs") continue;
    const src = readFileSync(path.join(rustDir, name), "utf8");
    // 剔除 `#[cfg(test)]` 之后的测试代码，只检查生产代码本身
    const prod = src.split("#[cfg(test)]")[0];
    assert.equal(
      prod.includes("CLIPBOARD_PLUGIN_ID"),
      false,
      `${name} 生产代码不应包含 CLIPBOARD_PLUGIN_ID`
    );
    assert.equal(
      prod.includes("GESTURE_PLUGIN_ID"),
      false,
      `${name} 生产代码不应包含 GESTURE_PLUGIN_ID`
    );
    assert.equal(
      prod.includes('"com.mysearch.clipboard"'),
      false,
      `${name} 生产代码不应硬编码 com.mysearch.clipboard`
    );
    assert.equal(
      prod.includes('"com.zhuangjie.mouse-gesture"'),
      false,
      `${name} 生产代码不应硬编码 com.zhuangjie.mouse-gesture`
    );
  }
  const overlayVue = readFileSync(path.join(root, "src/windows/overlay/App.vue"), "utf8");
  assert.equal(
    overlayVue.includes("com.zhuangjie.screenshot"),
    false,
    "overlay/App.vue 不应硬编码 com.zhuangjie.screenshot"
  );
  pass("宿主 Rust 生产代码与遮罩窗已彻底消除业务插件 ID 硬编码");
}

/* ============ 2. 清单 clipboardCapture 解析与网关映射 ============ */
{
  const clipManifestJson = readFileSync(path.join(root, "plugins/clipboard/plugin.json"), "utf8");
  const parsedClip = parsePluginManifest(clipManifestJson);
  assert.equal(parsedClip.ok, true);
  assert.equal(parsedClip.manifest.contributes?.clipboardCapture, true);

  const shotManifestJson = readFileSync(path.join(root, "plugins/screenshot/plugin.json"), "utf8");
  const parsedShot = parsePluginManifest(shotManifestJson);
  assert.equal(parsedShot.ok, true);

  const clipRec = createPluginRecord({
    manifest: parsedClip.manifest,
    dir: "plugins/com.mysearch.clipboard",
    source: { kind: "builtin" },
    grants: parsedClip.manifest.permissions,
  });
  const shotRec = createPluginRecord({
    manifest: parsedShot.manifest,
    dir: "plugins/com.zhuangjie.screenshot",
    source: { kind: "builtin" },
    grants: parsedShot.manifest.permissions,
  });

  // 关键防误触：截图插件同样拥有 clipboard.read（用于贴图），但不应触发后台剪贴板持续捕获！
  assert.equal(wantsClipboardCapture(clipRec), true);
  assert.equal(gatewaySpecOf(clipRec).clipboardCapture, true);
  assert.equal(wantsClipboardCapture(shotRec), false);
  assert.equal(gatewaySpecOf(shotRec).clipboardCapture, false);
  pass("clipboardCapture 精确区分「后台持续捕获」与「一次性读取（如贴图）」");
}

/* ============ 3. 表驱动网关权限拦截、通用存储、通用热键与独立窗口 ============ */
{
  const mf = parsePluginManifest(
    JSON.stringify({
      id: "com.example.demo",
      name: "Demo",
      version: "1.0.0",
      apiVersion: 1,
      permissions: ["store", "ui.window"],
      contributes: {
        detailView: { entry: "ui/win.html" },
        shortcut: { action: "ping", title: "Ping", defaultShortcut: "ctrl+alt+p" },
      },
    })
  );
  assert.equal(mf.ok, true);

  const rec = createPluginRecord({
    manifest: mf.manifest,
    dir: "plugins/com.example.demo",
    source: { kind: "folder", dev: true },
    grants: ["store"], // 先故意不授 ui.window
  });
  const reg = { version: 1, plugins: [rec] };
  let openedWin = null;

  const ctx = {
    registry: () => reg,
    persistRegistry: () => {},
    searchData: () => [],
    triggerSearch: () => {},
    setInput: () => {},
    hideDetail: () => {},
    toast: () => {},
    confirm: async () => true,
    getSelectedText: async () => "",
    openPluginWindow: async (pid, entry, title, opts) => {
      openedWin = { pid, entry, title, opts };
      return `plugin-win-${pid}`;
    },
  };

  const ms = createHostApi("com.example.demo", ctx);

  // 未授 ui.window → 抛 PluginPermissionError
  assert.throws(
    () => ms.ui.openWindow("ui/popup.html", "Popup"),
    (err) => err instanceof PluginPermissionError && err.permission === "ui.window"
  );

  // 授予 ui.window 后再调 → 成功打开独立窗口
  rec.grants.push({ permission: "ui.window", at: Date.now(), source: "settings" });
  const winLabel = await ms.ui.openWindow({
    entry: "ui/popup.html",
    title: "独立工具窗",
    width: 640,
    height: 480,
  });
  assert.equal(winLabel, "plugin-win-com.example.demo");
  assert.deepEqual(openedWin, {
    pid: "com.example.demo",
    entry: "ui/popup.html",
    title: "独立工具窗",
    opts: { width: 640, height: 480, alwaysOnTop: undefined },
  });

  // 通用文件化 JSON 存储读写删除
  assert.equal(await ms.store.readJson("state", "fallback"), "fallback");
  await ms.store.writeJson("state", { count: 42, tags: ["a", "b"] });
  assert.deepEqual(await ms.store.readJson("state"), { count: 42, tags: ["a", "b"] });
  await ms.store.removeJson("state");
  assert.equal(await ms.store.readJson("state", null), null);

  // 通用快捷键 API
  assert.equal(await ms.shortcuts.get("ping"), "");
  assert.equal(await ms.shortcuts.set("ping", "Ctrl+Alt+K"), "ctrl+alt+k");
  assert.equal(await ms.shortcuts.get("ping"), "ctrl+alt+k");
  assert.equal(await ms.shortcuts.set("ping", ""), "");
  assert.equal(await ms.shortcuts.get("ping"), "");

  // 插件禁用后所有 API 立即抛 PluginUnavailableError
  rec.enabled = false;
  assert.throws(
    () => ms.store.get("x"),
    (err) => err instanceof PluginUnavailableError
  );
  rec.enabled = true;
  assert.ok(auditLog.length > 0);
  pass("表驱动网关权限门禁、ms.store.readJson/writeJson、ms.shortcuts.get/set 与 ms.ui.openWindow 全部通过");
}

/* ============ 4. 会话销毁统一回收：零监听器泄漏 ============ */
{
  const pid = "com.example.leakcheck";
  const mf = parsePluginManifest(
    JSON.stringify({
      id: pid,
      name: "LeakCheck",
      version: "1.0.0",
      apiVersion: 1,
    })
  );
  const rec = createPluginRecord({
    manifest: mf.manifest,
    dir: `plugins/${pid}`,
    source: { kind: "file" },
    grants: [],
  });
  const ms = createHostApi(pid, {
    registry: () => ({ version: 1, plugins: [rec] }),
    persistRegistry: () => {},
    searchData: () => [],
    triggerSearch: () => {},
    setInput: () => {},
    hideDetail: () => {},
    toast: () => {},
    confirm: async () => true,
    getSelectedText: async () => "",
  });

  // 一次性挂满所有 7 类订阅通道
  ms.backend.onNotification("delta", () => {});
  ms.backend.onBackendChanged(() => {});
  ms.screenshot.onSaved(() => {});
  ms.clipboard.onUpdated(() => {});
  ms.gesture.onRecord(() => {});
  ms.shortcuts.onAction("fire", () => {});
  ms.ui.onThemeChanged(() => {});
  ms.ui.registerThemeProvider(() => "dark");

  assert.equal(dispatchShortcutAction(pid, "fire"), true);
  assert.equal(readPluginThemeProvider(pid), "dark");
  assert.ok(activeSubscriptionCountForPlugin(pid) >= 7);

  // 调用统一销毁入口 → 7 类监听全部清零！
  disposePluginHostSession(pid);
  assert.equal(activeSubscriptionCountForPlugin(pid), 0);
  assert.equal(dispatchShortcutAction(pid, "fire"), false);
  assert.equal(readPluginThemeProvider(pid), null);
  pass("disposePluginHostSession 一次性清零全部 7 类事件通道，杜绝重复挂载泄漏");
}

/* ============ 5. 剪贴板插件领域自治实跑验证 ============ */
{
  // 构造最小 DOM 桩以运行 plugins/clipboard/ui/index.js
  const elements = new Map();
  const makeEl = (id) => ({
    id,
    hidden: false,
    disabled: false,
    value: "",
    textContent: "",
    innerHTML: "",
    isConnected: true,
    style: {},
    classList: {
      add: () => {},
      remove: () => {},
      toggle: () => {},
      contains: () => false,
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelectorAll: () => [],
    querySelector: () => null,
    getAttribute: () => null,
    focus: () => {},
    select: () => {},
    setSelectionRange: () => {},
  });
  [
    "app", "cb-status", "cb-meta", "cb-list", "cb-empty", "cb-empty-text", "cb-empty-key",
    "cb-search", "cb-refresh", "cb-clear", "cb-hotkey-btn", "cb-hotkey-clear",
    "cb-viewer", "cb-viewer-img", "cb-viewer-name", "cb-viewer-close", "cb-viewer-copy",
    "cb-tabs", "cb-fav-count", "cb-cats", "cb-cat-options",
  ].forEach((id) => elements.set(id, makeEl(id)));

  globalThis.window = {
    __CB_TEST_HOOK__: true,
    CSS: { escape: (s) => String(s) },
  };
  globalThis.document = {
    getElementById: (id) => elements.get(id) ?? null,
    querySelector: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  // 模拟宿主存储与原始剪贴板捕获原语
  const kv = new Map();
  // 预置旧版 Rust 迁移出来的 legacy 注解
  kv.set("annotations.legacy", {
    "t-1": { favorite: true, category: "工作" },
  });
  const rawCaptures = [
    { id: "t-1", kind: "text", text: "原始工作笔记", size: 18, createdAt: 2000 },
    { id: "t-2", kind: "text", text: "临时剪贴内容", size: 18, createdAt: 1000 },
  ];
  let retainedSynced = [];
  let copiedCalls = [];

  const mockMs = {
    store: {
      get: (_k, fb) => fb,
      set: () => true,
      readJson: async (k, fb = null) => (kv.has(k) ? structuredClone(kv.get(k)) : fb),
      writeJson: async (k, v) => {
        kv.set(k, structuredClone(v));
        return true;
      },
      removeJson: async (k) => {
        kv.delete(k);
        return true;
      },
    },
    clipboard: {
      list: async () => structuredClone(rawCaptures),
      readImage: async () => "data:image/png;base64,AA==",
      setRetained: async (ids) => {
        retainedSynced = [...ids];
      },
      copy: async (id, textOverride) => {
        copiedCalls.push({ id, textOverride });
      },
      remove: async () => {},
      clear: async () => {},
      onUpdated: () => () => {},
    },
    shortcuts: {
      get: async () => "ctrl+alt+v",
      set: async (_a, s) => s,
    },
    ui: {
      toast: () => {},
      confirm: async () => true,
    },
    log: () => {},
  };
  const hostContainer = {};
  const clipCode = readFileSync(path.join(root, "plugins/clipboard/ui/index.js"), "utf8");
  const fn = new Function(
    "ms", "env", "plugin", "host", "keyword", "inputValue", "onSubKeyword", "md2html", "openExternal",
    clipCode
  );
  fn(mockMs, {}, { id: "com.mysearch.clipboard" }, hostContainer, "剪贴板", "", () => {}, (x) => String(x), () => {});

  const api = globalThis.window.__CB_TEST__;
  assert.ok(api, "剪贴板测试钩子应已挂载");
  assert.equal(typeof hostContainer.__msPluginCleanup, "function", "应注册 __msPluginCleanup 会话清理函数");

  // 等待首次迁移与合并完成
  await api.fetchMergedAll();
  assert.equal(kv.has("annotations.legacy"), false, "annotations.legacy 迁移后应自动清除");
  assert.deepEqual(kv.get("annotations"), {
    "t-1": { favorite: true, category: "工作" },
  });
  assert.deepEqual(retainedSynced, ["t-1"], "已收藏/分类项应自动同步到宿主 setRetained");

  // 测试插件侧二次编辑文本 + 持久化 + 复制覆盖
  const tx = api.setItemAnnotation("t-1", { editedText: "修订后的工作笔记" });
  await tx.commit();
  await api.fetchMergedAll();
  const st = api.getState();
  const item1 = st.allMerged.find((x) => x.id === "t-1");
  assert.equal(item1.favorite, true);
  assert.equal(item1.category, "工作");
  assert.equal(item1.text, "修订后的工作笔记");
  assert.equal(item1.edited, true);
  assert.equal(st.favTotal, 1);
  assert.deepEqual(st.categories, [{ name: "工作", count: 1 }]);
  assert.equal(copiedCalls.length, 0);

  hostContainer.__msPluginCleanup();
  pass("剪贴板插件领域自治（legacy 无损迁移 + 收藏/分类/二次编辑 + setRetained 防淘汰联动）验证通过");
}

/* ============ 6. Tauri IPC 参数契约对齐校验（防止前后端字段名或序列化口径脱节） ============ */
{
  const ipcSrc = readFileSync(path.join(root, "src/lib/plugins/ipc.ts"), "utf8");
  const hostRs = readFileSync(path.join(root, "src-tauri/src/plugin_host.rs"), "utf8");
  const clipRs = readFileSync(path.join(root, "src-tauri/src/clipboard_history.rs"), "utf8");

  // plugin_storage_write: Rust 参数为 (app, plugin_id, key, content: String)，前端必须传 content 字符串
  assert.match(
    hostRs,
    /pub fn plugin_storage_write\(\s*app:\s*AppHandle,\s*plugin_id:\s*String,\s*key:\s*String,\s*content:\s*String/
  );
  assert.match(
    ipcSrc,
    /invoke\("plugin_storage_write",\s*\{\s*pluginId,\s*key:\s*k,\s*content\s*\}\)/
  );
  assert.ok(
    !/invoke\("plugin_storage_write"[^)]*\bvalue\b/.test(ipcSrc),
    "plugin_storage_write 不得传未定义的 value 参数名"
  );

  // plugin_storage_read: Rust 返回 Option<String>，前端在 Tauri 分支必须 JSON.parse
  const readFnBlock = ipcSrc.slice(
    ipcSrc.indexOf("export async function pluginStorageRead"),
    ipcSrc.indexOf("export async function pluginStorageWrite")
  );
  assert.match(readFnBlock, /invoke<string \| null>\("plugin_storage_read"/);
  assert.equal(
    (readFnBlock.match(/JSON\.parse/g) ?? []).length,
    2,
    "pluginStorageRead 在浏览器降级分支与 Tauri 真机分支均须 JSON.parse"
  );

  // clipboard_history_clear / set_retained 参数与权限前后端一致
  assert.match(clipRs, /pub fn clipboard_history_clear\([\s\S]*?keep_retained:\s*Option<bool>/);
  assert.match(
    clipRs,
    /pub fn clipboard_history_set_retained\([\s\S]*?require_grant\(&plugin_id,\s*"clipboard\.read"\)/
  );
  pass("前后端 Tauri IPC 参数名、序列化类型与网关权限契约对齐");
}

console.log(`\n全部通过：${passed} 项架构解耦与运行期断言`);
