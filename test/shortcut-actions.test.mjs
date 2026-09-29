/**
 * 回归测试：「已安装插件 → 可用快捷键作用类型」（src/lib/plugins/shortcut-actions.ts）。
 *
 * 背景：截图 / 剪贴板历史这类作用类型曾**写死**在宿主里——插件没装也照样列出、
 * 还会注入默认热键，按下去没反应。现在按插件清单 `contributes.shortcut` 声明、
 * 由「已安装插件」动态计算。这里覆盖：
 *  1. 未安装 → 动作不可用（列表为空）
 *  2. 已安装 → 动作可用（标题 / 默认键来自清单）
 *  3. 卸载 → 动作消失
 *  4. 同 action 去重（稳定取第一个）
 *  5. legacy 记录被忽略
 *  6. 无 detailView 的纯动作插件也算可用
 *
 * 用法: node test/shortcut-actions.test.mjs
 */
import { availableShortcutActions, shortcutActionsOf } from "../src/lib/plugins/shortcut-actions.ts";

let failures = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.error(`✗ ${name}`);
    console.error(`  期望: ${JSON.stringify(expected)}`);
    console.error(`  实际: ${JSON.stringify(actual)}`);
    return;
  }
  console.log(`✓ ${name}`);
}

/** 造一条最小插件记录（只带 shortcut 计算用到的字段） */
function rec(id, shortcut, opts = {}) {
  return {
    id,
    name: id,
    version: "1.0.0",
    apiVersion: 1,
    manifest: { id, name: id, version: "1.0.0", apiVersion: 1, contributes: shortcut ? { shortcut } : undefined },
    dir: "",
    source: opts.source ?? { kind: "market", ref: "x" },
    installedAt: 0,
    updatedAt: 0,
    enabled: opts.enabled ?? true,
    autoStart: "on-demand",
    requestedAutoStart: "on-demand",
    closeBehavior: "minimize",
    themePreference: "inherit",
    grants: [],
    denied: [],
    runtime: { status: "stopped", pid: null, memoryBytes: null, startedAt: null, restarts: 0, lastError: null, keepAliveReasons: [] },
    integrity: { sha256: null, signed: false },
  };
}

const reg = (...plugins) => ({ version: 1, plugins });

// 1) 什么都没装 → 没有可用动作
check("未安装插件 → 无可用动作", availableShortcutActions(reg()), []);

// 2) 装了截图插件 → 动作可用（标题 / 默认键来自清单）
const withScreenshot = reg(
  rec("com.zhuangjie.screenshot", {
    action: "screenshot",
    title: "截图（框选 + 标注）",
    defaultShortcut: "ctrl+alt+x",
  })
);
check("装了截图插件 → 动作可用", availableShortcutActions(withScreenshot), [
  {
    action: "screenshot",
    title: "截图（框选 + 标注）",
    defaultShortcut: "ctrl+alt+x",
    pluginId: "com.zhuangjie.screenshot",
  },
]);

// 3) 卸载（列表里没有该插件）→ 动作消失
check("卸载后动作消失", availableShortcutActions(reg(rec("com.a.other", null))), []);

// 4) 同一个 action 出现两次 → 只留第一个（按注册表顺序）
const dup = availableShortcutActions(
  reg(
    rec("com.a.first", { action: "clipboard", title: "第一个" }),
    rec("com.b.second", { action: "clipboard", title: "第二个" })
  )
);
check("同 action 去重取第一个", dup.length, 1);
check("同 action 取的是第一个插件", dup[0].pluginId, "com.a.first");

// 5) legacy 记录被忽略
check(
  "legacy 记录不提供动作",
  availableShortcutActions(reg(rec("legacy.x", { action: "screenshot", title: "旧" }, { source: { kind: "legacy" } }))),
  []
);

// 6) 两个插件各一个动作 → 按 action 名排序输出
const both = availableShortcutActions(
  reg(
    rec("com.s", { action: "screenshot", title: "截图" }),
    rec("com.c", { action: "clipboard", title: "剪贴板历史" })
  )
);
check("两个动作按 action 排序", both.map((a) => a.action), ["clipboard", "screenshot"]);

// 7) 清单没写 defaultShortcut → 归一为空串（宿主据此跳过自动注入）
check(
  "缺省 defaultShortcut 归一为空串",
  shortcutActionsOf(rec("com.x", { action: "screenshot", title: "截图" }))[0].defaultShortcut,
  ""
);

// 8) 迁移桥：老版插件包（清单无 shortcut 声明）但插件仍安装 → 按旧内置默认值兜底，
//    避免用户升级应用后被静默移除既有热键
const legacyPkg = availableShortcutActions(reg(rec("com.zhuangjie.screenshot", null)));
check("老版截图插件包仍提供动作（迁移桥）", legacyPkg, [
  {
    action: "screenshot",
    title: "截图（框选 + 标注）",
    defaultShortcut: "ctrl+alt+x",
    pluginId: "com.zhuangjie.screenshot",
  },
]);
check(
  "新插件包声明优先于迁移桥",
  availableShortcutActions(
    reg(rec("com.mysearch.clipboard", { action: "clipboard", title: "自定义标题", defaultShortcut: "ctrl+alt+b" }))
  )[0].title,
  "自定义标题"
);
check(
  "未知插件（无声明、不在迁移桥）不提供动作",
  availableShortcutActions(reg(rec("com.other.plugin", null))),
  []
);

console.log("");
if (failures > 0) {
  console.error(`结果: ${failures} 项失败`);
  process.exit(1);
}
console.log("结果: 全部通过");
