/**
 * 宿主子输入框（P1-5）测试。
 *
 * 覆盖契约：
 *   1. `ms.ui.subInput.set/remove/focus` 受 `ui.inlay` 门禁；
 *   2. 调用会原样转发到宿主注入的 `ctx.subInput`（含 placeholder/value/onChange）；
 *   3. 未注入（独立窗口）时 set 抛出明确错误、remove/focus 返回 false；
 *   4. 视图宿主：创建输入框、插在会话载体前、键盘事件 stopPropagation、
 *      停靠时与载体一起搬走、会话销毁时删除；
 *   5. 样式：has-sub-input 时插件会话让出高度。
 *
 * 用法: node test/plugin-subinput.test.mjs
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
const { createHostApi, PluginPermissionError } = await import("../src/lib/plugins/host.ts");
const { createPluginRecord } = await import("../src/lib/plugins/registry.ts");

let passed = 0;
function pass(name) {
  passed++;
  console.log(`PASS  ${name}`);
}

const PLUGIN_ID = "com.example.subinput";

function harness({ grants = ["ui.inlay"], subInput } = {}) {
  const rec = createPluginRecord({
    manifest: {
      id: PLUGIN_ID,
      name: "子输入框测试",
      version: "1.0.0",
      apiVersion: 1,
      entry: "ui/index.html",
      permissions: grants,
    },
    dir: `plugins/${PLUGIN_ID}`,
    source: { kind: "file" },
    grants,
  });
  const calls = [];
  const ctx = {
    registry: () => ({ version: 1, plugins: [rec] }),
    persistRegistry: () => {},
    searchData: () => [],
    triggerSearch: () => {},
    setInput: () => {},
    hideDetail: () => {},
    toast: () => {},
    confirm: async () => true,
    getSelectedText: async () => "",
    subInput:
      subInput === null
        ? undefined
        : subInput ??
          ((id, action, options) => {
            calls.push({ id, action, options });
            return true;
          }),
  };
  return { api: createHostApi(rec.id, ctx), calls, rec };
}

/* ============ 1. 权限门禁 ============ */
{
  const { api, calls } = harness({ grants: [] });
  await assert.rejects(async () => api.ui.subInput.set({ placeholder: "筛选" }), PluginPermissionError);
  assert.equal(calls.length, 0, "被拒绝时不会触达宿主");
  pass("没有 ui.inlay 时子输入框 API 被拒");
}

/* ============ 2. 转发语义 ============ */
{
  const { api, calls } = harness();
  const onChange = (v) => v;
  assert.equal(await api.ui.subInput.set({ placeholder: "筛选文件", value: "rc", focus: true, onChange }), true);
  assert.equal(calls[0].id, PLUGIN_ID);
  assert.equal(calls[0].action, "set");
  assert.deepEqual(calls[0].options, { placeholder: "筛选文件", value: "rc", focus: true, onChange });

  assert.equal(await api.ui.subInput.focus(), true);
  assert.equal(calls[1].action, "focus");
  assert.equal(await api.ui.subInput.remove(), true);
  assert.equal(calls[2].action, "remove");
  pass("set / focus / remove 原样转发给宿主，onChange 函数不被吞掉");
}

/* ============ 3. 未注入的窗口 ============ */
{
  const { api } = harness({ subInput: null });
  await assert.rejects(async () => api.ui.subInput.set({}), /不支持子输入框/);
  assert.equal(await api.ui.subInput.focus(), false);
  assert.equal(await api.ui.subInput.remove(), false);
  pass("独立窗口等未注入场景：set 抛明确错误，focus/remove 返回 false");
}

/* ============ 4. 视图宿主实现契约 ============ */
{
  const view = readFileSync(
    path.join(root, "src/windows/search/usePluginViewHost.ts"),
    "utf8"
  );
  assert.match(view, /function subInput\(/, "视图宿主暴露 subInput");
  assert.match(view, /wrap\.className = "ms-sub-input"/);
  assert.match(view, /className = "ms-sub-input-field"/);
  assert.match(view, /carrier\.parentElement\?\.insertBefore\(wrap, carrier\)/, "插在会话载体之前");
  assert.match(view, /e\.stopPropagation\(\)/, "键盘不再冒泡给宿主快捷键");
  assert.match(view, /session\.subInputOnChange\?\.\(field\.value\)/);
  assert.match(view, /if \(session\.subInput\) lot\.appendChild\(session\.subInput\)/, "停靠时一起搬走");
  assert.match(view, /session\.subInput\?\.remove\(\)/, "会话销毁时删除");
  assert.match(view, /has-sub-input/, "布局标记存在");

  const app = readFileSync(path.join(root, "src/windows/search/App.vue"), "utf8");
  assert.match(app, /subInput: \(id, action, options\) => pluginViewHost\.subInput/, "App 注入");

  const host = readFileSync(path.join(root, "src/windows/search/usePluginHost.ts"), "utf8");
  assert.match(host, /subInput: opts\.subInput/, "宿主上下文转发");

  const css = readFileSync(path.join(root, "src/css/style.css"), "utf8");
  assert.match(css, /\.plugin-view\.has-sub-input\s*\{/, "有输入框时改为纵向布局");
  assert.match(css, /\.ms-sub-input-field/, "输入框样式存在");
  pass("视图宿主 / App / 宿主上下文 / CSS 的接线完整");
}

console.log(`\n全部通过：${passed} 项子输入框测试`);
