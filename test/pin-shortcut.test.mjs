/**
 * 贴图（pin）快捷键 + 窗口链路的静态契约测试（纯 Node，无需浏览器）。
 *
 * 链路（与截图同源）：截图插件清单 `contributes.shortcut` 数组里声明第二个
 * 动作 `pin`（宿主原生保留名）+ 默认键 ctrl+alt+v → 前端算出可用动作下发给
 * Rust（`sync_plugin_shortcut_actions`）→ `reconcile_plugin_actions` 自动注入
 * → `dispatch_shortcut_action` 分发到 `pin_image::start_pin_from_shortcut`：
 * 读系统剪贴板位图（`clipboard_history::current_clipboard_image`）→ 光标处开
 * 无边框置顶小窗（`pin.html` + `src/windows/pin/PinApp.vue`）。
 *
 * 键位冲突处置：ctrl+alt+v 原本是剪贴板历史的老默认键。本版本起：
 *   - Rust `migrate_pin_shortcut` 一次性把仍绑在 ctrl+alt+v 的剪贴板历史迁到
 *     ctrl+alt+b（用户自定义过/解绑过的不动，目标键被占也不动）；
 *   - 清单默认值同步改为 ctrl+alt+b；
 *   - 全部插件清单声明的默认键 + 宿主默认键之间互不冲突。
 *
 * 用法: node test/pin-shortcut.test.mjs
 */
import { readFileSync, readdirSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { parsePluginManifest, listShortcutActions } from "../src/lib/plugins/manifest.ts";
import { isKnownPermission } from "../src/lib/plugins/permissions.ts";
import { availableShortcutActions, shortcutActionsOf } from "../src/lib/plugins/shortcut-actions.ts";
import {
  HOST_NATIVE_PLUGIN_ACTIONS,
  SHORTCUT_ACTION_LABELS,
  isHostNativePluginAction,
} from "../src/lib/shortcut-bindings.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shotDir = path.join(root, "plugins", "screenshot");
const clipDir = path.join(root, "plugins", "clipboard");

let pass = 0;
let fail = 0;
function ok(cond, name, extra = "") {
  if (cond) {
    pass++;
    console.log("PASS ", name, extra ? ` — ${extra}` : "");
  } else {
    fail++;
    console.log("FAIL ", name, extra ? ` — ${extra}` : "");
  }
}

/* 1. 截图清单：数组形式声明 screenshot + pin */
const shotRaw = readFileSync(path.join(shotDir, "plugin.json"), "utf8");
const shotParsed = parsePluginManifest(shotRaw, isKnownPermission);
ok(shotParsed.ok, "截图清单通过 parsePluginManifest 校验", (shotParsed.errors || []).join(", ") || "no errors");
const shotActions = shotParsed.ok ? listShortcutActions(shotParsed.manifest) : [];
ok(
  shotActions.some((s) => s.action === "screenshot" && s.defaultShortcut === "ctrl+alt+x"),
  "截图清单保留 screenshot + ctrl+alt+x"
);
const pinAction = shotActions.find((s) => s.action === "pin");
ok(!!pinAction, "截图清单声明了 pin 动作（贴图）");
ok(pinAction?.defaultShortcut === "ctrl+alt+v", "pin 默认键为 ctrl+alt+v", pinAction?.defaultShortcut ?? "(missing)");
ok(!!pinAction?.title, "pin 动作有标题", pinAction?.title ?? "(missing)");

/* 2. 剪贴板清单：默认键迁到 ctrl+alt+b */
const clipRaw = readFileSync(path.join(clipDir, "plugin.json"), "utf8");
const clipParsed = parsePluginManifest(clipRaw, isKnownPermission);
ok(clipParsed.ok, "剪贴板清单通过 parsePluginManifest 校验", (clipParsed.errors || []).join(", ") || "no errors");
const clipActions = clipParsed.ok ? listShortcutActions(clipParsed.manifest) : [];
ok(
  clipActions.some((s) => s.action === "clipboard" && s.defaultShortcut === "ctrl+alt+b"),
  "剪贴板清单默认键已迁到 ctrl+alt+b"
);

/* 3. 动作计算链路（数组声明的第二个动作能被算出） */
const shotRec = {
  id: "com.zhuangjie.screenshot",
  source: { kind: "builtin" },
  manifest: shotParsed.ok ? shotParsed.manifest : {},
};
const shotActions2 = shortcutActionsOf(shotRec);
ok(
  shotActions2.some((a) => a.action === "pin" && a.defaultShortcut === "ctrl+alt+v" && a.pluginId === "com.zhuangjie.screenshot"),
  "shortcutActionsOf 算出 pin 动作（宿主原生名直通）"
);
const reg = { plugins: [shotRec] };
ok(
  availableShortcutActions(reg).some((a) => a.action === "pin"),
  "availableShortcutActions 含 pin"
);

/* 4. 宿主原生集合 / 标签 */
ok(HOST_NATIVE_PLUGIN_ACTIONS.includes("pin"), "HOST_NATIVE_PLUGIN_ACTIONS 包含 pin");
ok(isHostNativePluginAction("pin"), "isHostNativePluginAction('pin') 为真");
ok(!!SHORTCUT_ACTION_LABELS.pin, "SHORTCUT_ACTION_LABELS.pin 有中文文案", SHORTCUT_ACTION_LABELS.pin ?? "");

/* 5. 贴图窗口三件套 + vite 入口 */
ok(existsSync(path.join(root, "pin.html")), "pin.html 存在");
ok(existsSync(path.join(root, "src", "pin.ts")), "src/pin.ts 入口存在");
ok(existsSync(path.join(root, "src", "windows", "pin", "PinApp.vue")), "PinApp.vue 存在");
const vite = readFileSync(path.join(root, "vite.config.ts"), "utf8");
ok(/pin:\s*fileURLToPath\(new URL\("\.\/pin\.html"/.test(vite), "vite 构建入口包含 pin.html");

/* 6. PinApp.vue 交互三要素：双击关闭 / 右键菜单（编辑工具、关闭、复制） */
const pinApp = readFileSync(path.join(root, "src", "windows", "pin", "PinApp.vue"), "utf8");
ok(pinApp.includes("pin_close"), "PinApp 调用 pin_close 关闭贴图");
ok(pinApp.includes("pin_image_data"), "PinApp 调用 pin_image_data 取图");
ok(pinApp.includes("dblclick"), "PinApp 处理双击");
ok(pinApp.includes("contextmenu"), "PinApp 处理右键");
ok(pinApp.includes("显示编辑工具"), "右键菜单含「显示编辑工具」");
ok(pinApp.includes("关闭"), "右键菜单含「关闭」");
ok(pinApp.includes("复制"), "右键菜单含「复制」");
ok(pinApp.includes("screenshot_copy_image"), "复制走 screenshot_copy_image（真图片剪贴板）");
ok(pinApp.includes("pin_cleanup"), "PinApp 异常关闭时兜底 pin_cleanup");

/* 7. Rust 侧：分发 / 命令注册 / 迁移 */
const libRs = readFileSync(path.join(root, "src-tauri", "src", "lib.rs"), "utf8");
ok(libRs.includes('const SHORTCUT_ACTION_PIN: &str = "pin"'), "Rust 定义 SHORTCUT_ACTION_PIN");
ok(libRs.includes("pin_image::start_pin_from_shortcut"), "Rust 分发 pin 动作到 pin_image");
ok(
  libRs.includes("pin_image::pin_image_data") &&
    libRs.includes("pin_image::pin_close") &&
    libRs.includes("pin_image::pin_cleanup"),
  "pin_* 命令已注册进 invoke_handler"
);
ok(
  libRs.includes("fn migrate_pin_shortcut") && libRs.includes("migrate_pin_shortcut(app.handle())"),
  "Rust 一次性迁移已接线（setup 里调用）"
);
const pinRs = readFileSync(path.join(root, "src-tauri", "src", "pin_image.rs"), "utf8");
ok(pinRs.includes('WebviewUrl::App("pin.html".into())'), "Rust 开窗指向 pin.html");
ok(pinRs.includes("always_on_top(true)") && pinRs.includes("decorations(false)"), "贴图窗口无边框置顶");
ok(pinRs.includes("EVENT_PIN_NO_IMAGE"), "无图时广播 EVENT_PIN_NO_IMAGE");
ok(pinRs.includes("clipboard_history::current_clipboard_image"), "Rust 贴图读当前剪贴板位图");
const clipRs = readFileSync(path.join(root, "src-tauri", "src", "clipboard_history.rs"), "utf8");
ok(clipRs.includes("pub fn current_clipboard_image"), "clipboard_history 提供 current_clipboard_image");
const bridge = readFileSync(path.join(root, "src", "lib", "tauri-bridge.ts"), "utf8");
ok(bridge.includes("onPinNoImage") && bridge.includes("my-search://pin-no-image"), "前端桥接监听 pin-no-image");
const searchApp = readFileSync(path.join(root, "src", "windows", "search", "App.vue"), "utf8");
ok(searchApp.includes("onPinNoImage"), "主窗监听贴图无图事件并提示");

/* 8. 默认键全网无冲突：宿主默认 + 全部插件清单声明 */
const taken = new Map([["ctrl+alt+s", "宿主呼出键"]]);
let scanned = 0;
for (const dir of readdirSync(path.join(root, "plugins"), { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const mfPath = path.join(root, "plugins", dir.name, "plugin.json");
  if (!existsSync(mfPath)) continue;
  const p = parsePluginManifest(readFileSync(mfPath, "utf8"), isKnownPermission);
  if (!p.ok) continue;
  for (const s of listShortcutActions(p.manifest)) {
    if (!s.defaultShortcut) continue;
    scanned++;
    if (!taken.has(s.defaultShortcut)) {
      taken.set(s.defaultShortcut, `插件 ${dir.name}（${s.action}）`);
    }
  }
}
ok(
  taken.size === scanned + 1,
  "全部插件默认键 + 宿主默认键互不冲突",
  `声明 ${scanned} 个默认键，去重后 ${taken.size - 1} 个`
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
