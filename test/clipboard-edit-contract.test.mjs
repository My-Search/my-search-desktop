/**
 * 剪贴板插件「领域自治 + 编辑已收藏条目」跨语言契约测试。
 *
 * 重构后的架构边界（以源码为断言对象，防止退化回宿主耦合业务逻辑）：
 *   1. **宿主 Rust 原语层**（`clipboard_history.rs` + `plugin_host.rs`）：
 *      - 不再硬编码 `CLIPBOARD_PLUGIN_ID`，不再包含 `favorite` / `category` / `update` / `page` 等业务命令；
 *      - 提供 `clipboard_history_set_retained`（防淘汰保留集）与带 `text_override` 的 `clipboard_history_copy`；
 *      - 提供通用文件化存储 `plugin_storage_read` / `plugin_storage_write` / `plugin_storage_delete`；
 *      - 旧版 `index.json` 中的 `favorite` / `category` 自动迁移为 `annotations.legacy.json`。
 *   2. **网关与 IPC 层**（`ipc.ts` + `host/native-api.ts` + `host/ui-data-api.ts`）：
 *      - `ms.clipboard.copy(id, textOverride)` 走 `clipboard.write` 权限；
 *      - `ms.clipboard.setRetained(ids)` 走 `clipboard.read` 权限；
 *      - `ms.store.readJson / writeJson / removeJson` 走 `store` 权限；
 *      - `usePluginHost.ts` 不再保留任何剪贴板透传样板回调。
 *   3. **插件 UI 门禁与交互**（`plugins/clipboard/ui/index.js`）：
 *      - 「编辑」按钮仅在非图片且已收藏条目上渲染；
 *      - Enter 保存（豁免 Shift+Enter 换行与中文输入法 `isComposing`），Esc 取消；
 *      - 空内容拦截、内容未变不写盘、乐观更新 `utf8Len`、失败回滚、草稿防冲刷与列表重建补聚焦；
 *      - 清单权限数量保持 5 项，显式声明 `contributes.clipboardCapture: true`。
 *
 * 用法: node test/clipboard-edit-contract.test.mjs
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = "") => {
  if (cond) {
    pass++;
    console.log("PASS ", name, extra ? ` — ${extra}` : "");
  } else {
    fail++;
    console.log("FAIL ", name, extra ? ` — ${extra}` : "");
  }
};

const rust = read("src-tauri/src/clipboard_history.rs");
const pluginHostRs = read("src-tauri/src/plugin_host.rs");
const rustLib = read("src-tauri/src/lib.rs");
const ipc = read("src/lib/plugins/ipc.ts");
const nativeApi = read("src/lib/plugins/host/native-api.ts");
const uiDataApi = read("src/lib/plugins/host/ui-data-api.ts");
const searchHost = read("src/windows/search/usePluginHost.ts");
const ui = read("plugins/clipboard/ui/index.js");
const manifest = read("plugins/clipboard/plugin.json");

/* ============ 1. Rust 原语解耦与注册 ============ */
{
  ok(!rust.includes("CLIPBOARD_PLUGIN_ID"), "Rust clipboard_history.rs 已彻底移除硬编码 CLIPBOARD_PLUGIN_ID");
  ok(!rustLib.includes("CLIPBOARD_PLUGIN_ID"), "Rust lib.rs 已彻底移除硬编码 CLIPBOARD_PLUGIN_ID");
  ok(
    !/pub fn clipboard_history_(set_favorite|set_category|update|page)/.test(rust),
    "Rust 已剥离插件专属业务 CRUD（favorite / category / update / page）"
  );
  ok(
    /pub fn clipboard_history_set_retained\(/.test(rust) &&
      rustLib.includes("clipboard_history::clipboard_history_set_retained,"),
    "Rust 定义并注册 clipboard_history_set_retained 防淘汰原语"
  );
  ok(
    /pub fn clipboard_history_copy\([\s\S]{0,160}?text_override:\s*Option<String>/.test(rust),
    "Rust clipboard_history_copy 支持可选 text_override（复制插件侧编辑后的文本）"
  );
  ok(
    /pub fn plugin_storage_read\(/.test(pluginHostRs) &&
      /pub fn plugin_storage_write\(/.test(pluginHostRs) &&
      rustLib.includes("plugin_host::plugin_storage_write,"),
    "Rust plugin_host 提供并注册通用文件化存储 plugin_storage_read/write"
  );
  ok(
    rust.includes("annotations.legacy") &&
      rust.includes("legacy_favorite_and_category_migrate_into_retained_and_annotation_map"),
    "Rust 保留旧版 index.json 收藏/分类无损迁移与单测"
  );
}

/* ============ 2. 捕获文本归一化与插件编辑归一化对齐 ============ */
{
  ok(
    rust.includes("raw.trim_end_matches(['\\r', '\\n'])") &&
      /content\.chars\(\)\.count\(\) > MAX_TEXT_CHARS/.test(rust),
    "Rust 捕获侧剥尾部 \\r\\n 并按 Unicode 字符数截断"
  );
  ok(
    /function normalizeEditText\(raw\)/.test(ui) &&
      ui.includes(".replace(/[\\r\\n]+$/, \"\")") &&
      ui.includes("Array.from(s)"),
    "插件侧 normalizeEditText 同步剥尾部 \\r\\n 并按码点截断"
  );
}

/* ============ 3. IPC 与表驱动网关层对齐 ============ */
{
  ok(
    /export async function clipboardHistoryCopy\(\s*pluginId:\s*string,\s*id:\s*string,\s*textOverride\?:\s*string/.test(
      ipc
    ),
    "ipc.ts clipboardHistoryCopy 携带 pluginId 与可选 textOverride"
  );
  ok(
    /export async function clipboardHistorySetRetained\(/.test(ipc) &&
      /export async function pluginStorageWrite\(/.test(ipc),
    "ipc.ts 封装 clipboardHistorySetRetained 与 pluginStorageWrite"
  );
  ok(
    /copy:\s*\{[\s\S]{0,120}?permission:\s*"clipboard\.write"/.test(nativeApi) &&
      /setRetained:\s*\{[\s\S]{0,120}?permission:\s*"clipboard\.read"/.test(nativeApi),
    "host/native-api.ts 表驱动声明 clipboard.copy (clipboard.write) 与 setRetained (clipboard.read)"
  );
  ok(
    /readJson:\s*\{[\s\S]{0,120}?permission:\s*"store"/.test(uiDataApi) &&
      /writeJson:\s*\{[\s\S]{0,120}?permission:\s*"store"/.test(uiDataApi),
    "host/ui-data-api.ts 表驱动声明 store.readJson / writeJson (store 权限)"
  );
  ok(
    !searchHost.includes("clipboardHistory"),
    "usePluginHost.ts 已清零剪贴板透传样板回调"
  );
}

/* ============ 4. 插件 UI 门禁与交互不变式 ============ */
{
  ok(
    /var editBtn = \(!isImg && isFav\)/.test(ui),
    "编辑按钮渲染条件 = 非图片 且 已收藏"
  );
  ok(
    /function startEdit\(it\) \{\s*\n\s*if \(editingId === it\.id\) return;/.test(ui) &&
      /if \(it\.kind !== "text" \|\| it\.favorite !== true\) return;/.test(ui),
    "startEdit 二次门禁（图片/未收藏直接返回）"
  );
  ok(
    /if \(e\.key === "Enter" && !e\.shiftKey && !e\.isComposing\)/.test(ui),
    "Enter 保存带 !shiftKey 与 !isComposing 两个豁免"
  );
  ok(
    /else if \(e\.key === "Escape"\) \{\s*\n\s*e\.preventDefault\(\);\s*\n\s*cancelEdit\(\);/.test(ui),
    "Esc 取消编辑"
  );
  ok(
    /if \(!raw\.trim\(\)\) \{\s*\n\s*editDraft = raw;\s*\n\s*setStatus\("内容不能为空", true\);\s*\n\s*return;/.test(
      ui
    ),
    "空内容报错并留在编辑态（不丢已敲的字）"
  );
  ok(
    ui.includes("it.size = utf8Len(normalized);") &&
      /return encoded\.length - 2 \* percent;/.test(ui),
    "乐观更新的 size 走 utf8Len（UTF-8 字节口径）"
  );
  ok(
    /if \(normalized === \(it\.text \|\| ""\)\) \{\s*\n\s*cancelEdit\(\);/.test(ui),
    "内容未变直接退出，不写盘"
  );
  ok(
    /it\.text = oldText;\s*\n\s*it\.size = oldSize;/.test(ui),
    "保存失败回滚 text/size"
  );
  ok(
    /if \(editingId === it\.id\) editingId = null;\s*\n\s*render\(\);/.test(ui) &&
      /if \(editingId === it\.id\) editingId = null;\s*\n\s*reload\(false\);/.test(ui) &&
      /cancelEdit\(\);\s*\n\s*\/\/ 从头拉/.test(ui) &&
      /cancelEdit\(\);\s*\n\s*reload\(false, v\);/.test(ui),
    "取消收藏 / 删除行 / 切标签 / 改搜索词时正确清理编辑态"
  );
  ok(
    ui.includes('var editDraft = "";') &&
      ui.includes("editDraft = ta.value;") &&
      /escapeHtml\(editDraft\) \+ "<\/textarea>"/.test(ui) &&
      /if \(editingId\) \{\s*\n\s*var ta = editBoxOf\(editingId\);/.test(ui),
    "editDraft 草稿暂存 + 重渲染回填补聚焦"
  );
}

/* ============ 5. 清单契约 ============ */
{
  const m = JSON.parse(manifest);
  const verNum = (m.version || "").split(".").map(Number);
  const ge160 = verNum[0] > 1 || (verNum[0] === 1 && verNum[1] >= 6);
  ok(ge160, `插件版本应 ≥ 1.6.0（当前 ${m.version}）`);
  ok(m.contributes?.clipboardCapture === true, "清单显式声明 contributes.clipboardCapture: true");
  ok(typeof m.changelog === "string" && m.changelog.trim().length > 0, "清单包含非空 changelog");
  ok(m.permissions.includes("clipboard.write") && m.permissions.includes("store"), "清单声明 clipboard.write 与 store");
  ok(m.permissions.length === 5, "权限数量保持 5 项（老用户升级不弹重授权）");
}

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
