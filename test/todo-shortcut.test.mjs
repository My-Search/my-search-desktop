/**
 * 待办清单「安装后默认 Ctrl+Alt+T 呼出」契约测试（纯 Node，无需浏览器）。
 *
 * 链路：插件清单 `contributes.shortcut` 声明本地动作 `open-todo` + 默认键
 * `ctrl+alt+t` → 前端算出可用动作下发给 Rust（`sync_plugin_shortcut_actions`）
 * → Rust `reconcile_plugin_actions` 对「新可用 + 未解绑 + 默认键未被占用」的
 * 动作自动注入绑定 → 按下后宿主打开插件视图并把动作派发给
 * `ms.shortcuts.onAction("open-todo", …)` 注册的处理器。
 *
 * 本测试钉死静态契约（真实链路见 todo-shortcut-ui.test.mjs）：
 *   1. 清单能通过宿主的 parsePluginManifest（含权限名校验）；
 *   2. 声明的动作 / 标题 / 默认键正确，动作名符合本地动作命名规则；
 *   3. 全局动作 id 拼接 / 解析往返一致；
 *   4. shortcutActionsOf / availableShortcutActions 能从清单算出该动作；
 *   5. 默认键 ctrl+alt+t 与宿主呼出键、其他插件的默认键互不冲突；
 *   6. ui/index.js 确实注册了 open-todo 处理器，且没有「注册完立刻注销」
 *      （曾有回归把返回的取消函数直接调用，处理器永远不触发）。
 *
 * 用法: node test/todo-shortcut.test.mjs
 */
import { readFileSync, readdirSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { parsePluginManifest, listShortcutActions } from "../src/lib/plugins/manifest.ts";
import { isKnownPermission } from "../src/lib/plugins/permissions.ts";
import { availableShortcutActions, shortcutActionsOf } from "../src/lib/plugins/shortcut-actions.ts";
import {
  DEFAULT_TOGGLE_SHORTCUT,
  pluginDefinedActionId,
  pluginDefinedActionName,
  pluginDefinedActionOwner,
  isPluginDefinedAction,
} from "../src/lib/shortcut-bindings.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = path.join(root, "plugins", "com.zhuangjie.todo-list");

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

const manifestRaw = readFileSync(path.join(pluginDir, "plugin.json"), "utf8");

/* 1. 清单解析通过（真实宿主解析器 + 权限白名单） */
const parsed = parsePluginManifest(manifestRaw, isKnownPermission);
ok(parsed.ok, "清单通过 parsePluginManifest 校验", (parsed.errors || []).join(", ") || "no errors");

/* 2. contributes.shortcut 声明 */
const actions = parsed.ok ? listShortcutActions(parsed.manifest) : [];
ok(actions.length === 1, "清单只声明一个快捷键动作", `got ${actions.length}`);
const a = actions[0] || {};
ok(a.action === "open-todo", "本地动作名为 open-todo", a.action ?? "(missing)");
ok(typeof a.title === "string" && a.title.trim() !== "", "动作标题非空", a.title ?? "(missing)");
ok(a.defaultShortcut === "ctrl+alt+t", "默认键为 ctrl+alt+t", a.defaultShortcut ?? "(missing)");
ok(!a.action.startsWith("plugin:"), "动作名不带宿主内部前缀 plugin:（宿主负责拼接）");
ok(!["screenshot", "clipboard"].includes(a.action), "动作名不是宿主原生保留名（属插件自定义动作）");
ok(/^[a-z][a-z0-9_-]*$/.test(a.action), "动作名符合本地动作命名规则（小写字母开头）");

/* 3. 全局动作 id 往返 */
const globalId = pluginDefinedActionId("com.zhuangjie.todo-list", a.action);
ok(globalId === "plugin:com.zhuangjie.todo-list:open-todo", "全局动作 id 拼接正确", globalId);
ok(isPluginDefinedAction(globalId), "全局动作 id 被识别为插件自定义动作");
ok(pluginDefinedActionName(globalId) === "open-todo", "从全局 id 取回本地动作名");
ok(pluginDefinedActionOwner(globalId) === "com.zhuangjie.todo-list", "从全局 id 取回宿主插件 id");

/* 4. 从清单算可用动作（与快捷键面板 / 下发链路同一实现） */
const rec = {
  id: "com.zhuangjie.todo-list",
  manifest: parsed.ok ? parsed.manifest : {},
  source: { kind: "market", ref: "x" },
};
const declared = shortcutActionsOf(rec);
ok(
  declared.length === 1 &&
    declared[0].action === globalId &&
    declared[0].defaultShortcut === "ctrl+alt+t" &&
    declared[0].pluginId === "com.zhuangjie.todo-list",
  "shortcutActionsOf 从清单算出该动作（id / 默认键 / 宿主）"
);
const avail = availableShortcutActions({ version: 1, plugins: [rec] });
ok(
  avail.some((x) => x.action === globalId && x.defaultShortcut === "ctrl+alt+t"),
  "availableShortcutActions 包含该动作（会随安装下发给 Rust 注入默认热键）"
);

/* 5. 默认键全网无冲突：宿主呼出键 + 全部插件清单声明的默认键 */
const pluginDirs = readdirSync(path.join(root, "plugins"), { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(path.join(root, "plugins", d.name, "plugin.json")))
  .map((d) => d.name);
/** 每条声明的默认键（允许重复出现，查重用；首见者进 taken 映射） */
const declaredKeys = [];
/** shortcut -> 首个声明者（归属展示用） */
const taken = new Map();
taken.set(DEFAULT_TOGGLE_SHORTCUT, "宿主（呼出/隐藏搜索框）");
for (const dir of pluginDirs) {
  try {
    const m = JSON.parse(readFileSync(path.join(root, "plugins", dir, "plugin.json"), "utf8"));
    const list = Array.isArray(m?.contributes?.shortcut)
      ? m.contributes.shortcut
      : m?.contributes?.shortcut
        ? [m.contributes.shortcut]
        : [];
    for (const s of list) {
      if (!s?.defaultShortcut) continue;
      declaredKeys.push(s.defaultShortcut);
      if (!taken.has(s.defaultShortcut)) {
        taken.set(s.defaultShortcut, `插件 ${dir}（${s.action}）`);
      }
    }
  } catch (e) {
    /* 读不了的清单不参与统计 */
  }
}
const dupKeys = declaredKeys.filter((k, i) => declaredKeys.indexOf(k) !== i);
ok(dupKeys.length === 0, "插件默认键互不重复", dupKeys.join(", ") || "no duplicates");
ok(taken.get("ctrl+alt+t") === "插件 com.zhuangjie.todo-list（open-todo）",
  "ctrl+alt+t 全网唯一且归属待办清单", [...taken.keys()].join(", "));
ok(taken.has(DEFAULT_TOGGLE_SHORTCUT), "宿主默认呼出键未被插件占用", DEFAULT_TOGGLE_SHORTCUT);

/* 6. ui/index.js 注册处理器（源码契约；行为契约见 todo-shortcut-ui.test.mjs） */
const uiSource = readFileSync(path.join(pluginDir, "ui", "index.js"), "utf8");
ok(
  /ms\.shortcuts\.onAction\(\s*"open-todo"/.test(uiSource),
  "ui/index.js 注册了 open-todo 动作处理器"
);
ok(
  !/offShortcut\s*\(/.test(uiSource),
  "没有「注册完立刻注销」（曾把返回的取消函数误调用，处理器永不触发）",
  "回归守卫：处理器需陪整个会话，销毁由宿主 _clearActionHandlers 统一清理"
);
ok(
  /open-todo[\s\S]{0,600}?if\s*\(\s*!alive\(\)\s*\)\s*return/.test(uiSource),
  "处理器带 alive() 守卫（会话销毁后不碰 DOM）"
);

console.log(`\n待办快捷键契约：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
