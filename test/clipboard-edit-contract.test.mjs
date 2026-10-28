/**
 * 剪贴板「编辑已收藏条目」的**跨语言契约**测试（以源码为断言对象）。
 *
 * 为什么需要：这条链路从插件 UI 一路穿到 Rust，中间有五处「写错了不会报错、
 * 只会静默失效」的边界——
 *
 *   1. **命令名**：前端 invoke 的字符串与 Rust `#[tauri::command]` 名、以及
 *      `invoke_handler` 的注册表，三者必须逐字一致。少注册一项不会编译失败，
 *      运行期才报「command not found」；名字打错则同样如此。
 *   2. **参数名**：Tauri v2 把前端的 camelCase 映射到 Rust 的 snake_case。
 *      两边对不上时参数收到 undefined——而 Rust 侧 `id: String` 反序列化
 *      失败会直接抛错，属于会暴露的一类；但 `text` 若被漏传，则可能存进空串。
 *   3. **权限**：编辑是写入性操作，必须走 `clipboard.write`。若误用
 *      `clipboard.read`（remove/clear 用的就是它），在只授 read 的安装上
 *      会「点了没反应」。
 *   4. **转发**：`host.ts` 的网关方法与 `usePluginHost.ts` 的上下文注入是两处
 *      独立的接线。漏掉后者 = 搜索窗口里点了没反应（设置窗口另有注入路径）。
 *   5. **UI 门禁**：「编辑」按钮的渲染条件、Enter/Esc 的按键判定、以及
 *      「取消收藏时退出编辑态」这条边界，都是纯 JS 行为，没有任何类型系统
 *      兜底——回归了只会表现为界面怪怪的。
 *
 * 另外钉死一条工程约定：编辑文本的归一化口径必须与 `push_text`（复制入库那条
 * 路径）逐字一致，否则同一份内容「复制进来的」和「编辑保存的」会长得不一样。
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
const rustLib = read("src-tauri/src/lib.rs");
const ipc = read("src/lib/plugins/ipc.ts");
const host = read("src/lib/plugins/host.ts");
const searchHost = read("src/windows/search/usePluginHost.ts");
const ui = read("plugins/clipboard/ui/index.js");
const manifest = read("plugins/clipboard/plugin.json");

const CMD = "clipboard_history_update";

/* ============ 1. Rust 命令定义与注册 ============ */
{
  ok(
    /#\[tauri::command\]\s*\n\s*pub fn clipboard_history_update\(/.test(rust),
    "Rust 定义了 clipboard_history_update 命令"
  );
  // 签名必须与前端传参一一对应（app 由 Tauri 注入，不计入前端参数）
  ok(
    /pub fn clipboard_history_update\(\s*app: tauri::AppHandle,\s*id: String,\s*text: String,?\s*\)/.test(
      rust
    ),
    "Rust 签名是 (app, id: String, text: String)"
  );
  ok(
    rustLib.includes(`clipboard_history::${CMD},`),
    "命令已注册到 invoke_handler",
    "漏注册 → 运行期才报 command not found"
  );
  // 落盘后必须广播，否则打开中的列表不会自动刷新
  const body = rust.slice(rust.indexOf("pub fn clipboard_history_update"));
  ok(
    /app\.emit\(EVENT_CLIPBOARD_UPDATED/.test(body.slice(0, body.indexOf("\n}"))),
    "命令末尾广播 clipboard-updated 事件",
    "否则编辑后列表不刷新，要手动点「刷新」"
  );
}

/* ============ 2. 归一化口径与 push_text 一致 ============ */
{
  ok(
    /fn normalize_edit_text\(raw: &str\) -> Option<String>/.test(rust),
    "归一化抽成了可单测的纯函数 normalize_edit_text"
  );
  // 三条口径逐字对齐 push_text：剥尾部 \r\n / 按 chars() 而非字节 / 上限 MAX_TEXT_CHARS
  ok(
    rust.includes("raw.trim_end_matches(['\\r', '\\n'])"),
    "剥掉尾部 \\r\\n（与 push_text 同口径）"
  );
  ok(
    /content\.chars\(\)\.count\(\) > MAX_TEXT_CHARS/.test(rust),
    "上限判断按字符数（中文不会被按字节切成乱码）"
  );
  ok(
    rust.includes("content.chars().take(MAX_TEXT_CHARS).collect()"),
    "截断同样按字符（与 push_text 逐字一致）"
  );
  ok(
    rust.includes("normalize_edit_text_rejects_empty_trims_and_truncates"),
    "归一化有单测覆盖（空/截断/换行三种边界）"
  );
  // 只改内容，不动元数据——这是「收藏排序不跳、星标不丢」的根据
  ok(
    /item\.text = Some\(content\.clone\(\)\);/.test(rust) &&
      /item\.size = content\.len\(\) as u64;/.test(rust),
    "只改 text 与 size，其余字段原样"
  );
  // 命令体内不得触碰其它字段（写错一个就把元数据改了）
  const cmdBody = rust.slice(rust.indexOf("pub fn clipboard_history_update("));
  const cmdEnd = cmdBody.indexOf("\n}");
  ok(
    !/item\.(id|kind|created_at|source|favorite|rel_path|width|height)\s*=/.test(
      cmdBody.slice(0, cmdEnd)
    ),
    "命令体不改 id/kind/created_at/source/favorite/图片字段",
    "改了任一 → 收藏排序会跳、星标会丢"
  );
  ok(
    /if item\.kind != "text" \{\s*\n\s*return Err\("只能编辑文本历史"/.test(rust),
    "图片条目被拒绝（没有可编辑的文本形态）"
  );
}

/* ============ 3. ipc 层：命令名与参数名对齐 ============ */
{
  ok(
    /export async function clipboardHistoryUpdate\(id: string, text: string\)/.test(ipc),
    "ipc.ts 导出 clipboardHistoryUpdate(id, text)"
  );
  const fn = ipc.slice(ipc.indexOf("export async function clipboardHistoryUpdate"));
  ok(
    fn.includes(`invoke("${CMD}", { id: String(id ?? ""), text: String(text ?? "") })`),
    "invoke 参数名 id / text 与 Rust 签名对齐"
  );
  ok(
    /if \(!isTauri\) throw new Error\("编辑剪贴板历史仅在桌面端可用"\)/.test(fn),
    "浏览器调试环境抛错而非静默返回",
    "静默会让插件误以为保存成功"
  );
}

/* ============ 4. 网关层：权限 + 上下文字段 ============ */
{
  const fn = host.slice(host.indexOf("      update: (id: string, text: string) =>"));
  const api = fn.slice(0, fn.indexOf("}),") + 4);
  ok(
    api.includes('api: "clipboard.update"'),
    "网关方法名是 clipboard.update（与 ms.clipboard.update 对应）"
  );
  ok(
    api.includes('permission: "clipboard.write"'),
    "编辑走 clipboard.write 权限",
    "误用 clipboard.read 会让只授 read 的安装「点了没反应」"
  );
  ok(
    api.includes("ctx.clipboardHistoryUpdate?.(String(id ?? \"\"), String(text ?? \"\"))"),
    "网关转发到 ctx.clipboardHistoryUpdate"
  );
  ok(
    host.includes("clipboardHistoryUpdate?: (id: string, text: string) => Promise<void>;"),
    "PluginHostContext 声明了 clipboardHistoryUpdate 字段"
  );
  // 能力探测：老宿主没有该字段时应给出友好提示，而不是静默失效
  ok(
    ui.includes("typeof ms.clipboard?.update !== \"function\""),
    "插件对老宿主做能力探测并提示升级"
  );
}

/* ============ 5. 搜索窗口转发（漏了这行 = 搜索窗口里点了没反应） ============ */
{
  ok(
    searchHost.includes("clipboardHistoryUpdate,"),
    "usePluginHost.ts 导入了 clipboardHistoryUpdate"
  );
  ok(
    searchHost.includes("clipboardHistoryUpdate: (id, text) => clipboardHistoryUpdate(id, text),"),
    "搜索窗口把该能力注入插件宿主上下文"
  );
}

/* ============ 6. UI 门禁与交互 ============ */
{
  // 「编辑」只在已收藏的文本条目上出现
  ok(
    /var editBtn = \(!isImg && isFav\)/.test(ui),
    "编辑按钮渲染条件 = 非图片 且 已收藏"
  );
  ok(
    /function startEdit\(it\) \{\s*\n\s*if \(editingId === it\.id\) return;/.test(ui) &&
      /if \(it\.kind !== "text" \|\| it\.favorite !== true\) return;/.test(ui),
    "startEdit 里再兜一层门禁（图片/未收藏直接返回）"
  );
  // 按键判定：Enter 保存，但 Shift+Enter 换行、输入法选字期间不算
  ok(
    /if \(e\.key === "Enter" && !e\.shiftKey && !e\.isComposing\)/.test(ui),
    "Enter 保存带 !shiftKey 与 !isComposing 两个豁免",
    "少了任一 → 换行存不进去 / 中文选字被打断"
  );
  ok(
    /else if \(e\.key === "Escape"\) \{\s*\n\s*e\.preventDefault\(\);\s*\n\s*cancelEdit\(\);/.test(ui),
    "Esc 取消编辑"
  );
  // 空内容必须被前端先拦下（Rust 侧也会拒，这里少一次往返）
  ok(
    /if \(!raw\.trim\(\)\) \{\s*\n\s*editDraft = raw;\s*\n\s*setStatus\("内容不能为空", true\);\s*\n\s*return;/.test(
      ui
    ),
    "空内容报错并留在编辑态（不丢已敲的字）"
  );
  // 乐观更新的 size 口径必须与 Rust 一致（UTF-8 字节，不是 UTF-16 code unit）
  ok(
    ui.includes("it.size = utf8Len(raw);"),
    "乐观更新的 size 走 utf8Len（与 Rust 的 content.len() 同口径）"
  );
  ok(
    /return encoded\.length - 2 \* percent;/.test(ui),
    "encodeURIComponent 兜底算法用「字符数 − 2×% 数」",
    "推导错会算出 3 倍字节数（%XX%XX%XX 每 3 字符 = 1 字节）"
  );
  // 内容未变不发 IPC
  ok(
    /if \(raw === \(it\.text \|\| ""\)\) \{\s*\n\s*cancelEdit\(\);/.test(ui),
    "内容未变直接退出，不发 IPC"
  );
  // 乐观更新 + 失败回滚
  ok(
    /it\.text = oldText;\s*\n\s*it\.size = oldSize;/.test(ui),
    "保存失败回滚 text/size（界面与磁盘一致）"
  );
  // 编辑态被打断的清理：三条路径
  ok(
    /if \(editingId === it\.id\) editingId = null;\s*\n\s*render\(\);\s*\n\s*return Promise\.resolve\(ms\.clipboard\.setFavorite/.test(
      ui
    ),
    "取消收藏时退出编辑态（不收藏了就不该还能编辑）"
  );
  ok(
    /if \(editingId === it\.id\) editingId = null;\s*\n\s*reload\(false\);/.test(ui),
    "删除正在编辑的行时清掉编辑态"
  );
  ok(
    /cancelEdit\(\);\s*\n\s*\/\/ 从头拉/.test(ui) && /cancelEdit\(\);\s*\n\s*reload\(false, v\);/.test(ui),
    "切标签 / 改搜索词前退出编辑态（该行可能被过滤掉）"
  );
  // 草稿暂存：宿主每广播一次 clipboard-updated 就会重写列表 DOM
  ok(
    ui.includes("var editDraft = \"\";") && ui.includes("editDraft = ta.value;"),
    "输入暂存到 editDraft（防自动刷新冲掉正敲的字）"
  );
  ok(
    /escapeHtml\(editDraft\) \+ "<\/textarea>"/.test(ui),
    "编辑框回填的是草稿而非 it.text",
    "否则广播一次刷新，输入框内容就退回原文"
  );
  ok(
    /if \(editingId\) \{\s*\n\s*var ta = editBoxOf\(editingId\);/.test(ui),
    "列表重建后补聚焦（否则敲几个字就得重点一次）"
  );
}

/* ============ 7. 清单：版本与说明同步 ============ */
{
  const m = JSON.parse(manifest);
  // 版本应 ≥ 引入行内编辑的 1.4.0（后续升 1.4.1/1.4.2… 不应让本契约失效）
  const verNum = (m.version || "").split(".").map(Number);
  const ge140 = verNum[0] === 1 && verNum[1] === 4 && verNum[2] >= 0;
  ok(ge140, `插件版本应 ≥ 1.4.0（当前 ${m.version}）`);
  ok(
    typeof m.changelog === "string" && m.changelog.trim().length > 0,
    "清单带上了非空 changelog（市场/升级提示会展示）"
  );
  ok(
    m.permissions.includes("clipboard.write"),
    "清单仍声明 clipboard.write（编辑复用它，不新增权限）"
  );
  // 没有新增权限 → 老用户升级不会被打断重新授权
  ok(
    m.permissions.length === 5,
    "权限数量未变（不触发重新授权弹窗）"
  );
}

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
