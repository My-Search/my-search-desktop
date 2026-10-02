/**
 * 内置插件「恢复后 logo 应回来」的源码契约回归（无需浏览器 / Rust）。
 *
 * 用户诉求：
 *   内置插件卸载后进入「已丢弃的内置插件」，点「重新安装」恢复 —— 恢复出来的
 *   插件在列表里应显示**它自己的 logo**，而不是 🧩 占位图。
 *
 * 背景（这次踩到的坑）：
 *   - 卸载内置插件时面板会**清掉该插件缓存的 logo**（`iconMap` 里
 *     `<id>/<ref>` 的键），避免残留旧图；
 *   - 但 `restoreBuiltin()` 恢复后没有重新预读图标，`iconOf()` 查不到缓存，
 *     于是列表退回 🧩 占位图 —— 插件明明有 icon.svg 却显示占位。
 *
 * 钉死的契约（改动以下任一处都会让本测试失败）：
 *   1. `forgetIconCache(id)` 同时清 `iconMap` 与 `iconFailed`（含失败的 id 也要清，
 *      否则恢复后 `iconOf` 直接因失败标记返回 undefined）；
 *   2. 卸载路径调用 `forgetIconCache`（不是手写 for 循环，避免漂移）；
 *   3. `restoreBuiltin()` 恢复成功后 `forgetIconCache` + `preloadIcons()` —— 这是本次修复；
 *   4. 覆盖安装 / 开发挂载也在预读前 `forgetIconCache`（换图标后不显示旧图）。
 *
 * 用法: node test/plugin-icon-restore.test.mjs
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const panel = read("src/windows/config/panels/PanelPlugins.vue");

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log("PASS ", name, extra ? ` — ${extra}` : "");
  } else {
    fail++;
    console.log("FAIL ", name, extra ? ` — ${extra}` : "");
  }
};

/** 取 `function <name>(...) { ... }` 的函数体（按首个 `\n}` 收尾，够用且稳定） */
function bodyOf(name) {
  const start = panel.indexOf(`function ${name}(`);
  if (start < 0) return "";
  const end = panel.indexOf("\n}", start);
  return end > start ? panel.slice(start, end) : "";
}

/* ---------- 1. forgetIconCache：两个缓存都要清 ---------- */
const forget = bodyOf("forgetIconCache");
check("PanelPlugins.vue：存在 forgetIconCache", forget.length > 0);
check(
  "forgetIconCache：清 iconMap 里该插件的键",
  /iconMap\.value/.test(forget) && /startsWith\(/.test(forget)
);
check(
  "forgetIconCache：同时清 iconFailed（否则恢复后仍被当成失败）",
  /delete iconFailed\.value\[/.test(forget)
);

/* ---------- 2. 卸载路径用 forgetIconCache（不再手写循环） ---------- */
const uninstall = bodyOf("uninstallPlugin");
check("uninstallPlugin：调用 forgetIconCache", /forgetIconCache\(rec\.id\)/.test(uninstall));
check(
  "uninstallPlugin：不再手写 for 循环清 iconMap（统一走 forgetIconCache）",
  !/for \(const k of Object\.keys\(iconMap\.value\)\)/.test(uninstall)
);

/* ---------- 3. 恢复内置插件：重新预读图标（本次 bug） ---------- */
const restore = bodyOf("restoreBuiltin");
check("restoreBuiltin：恢复后清图标缓存", /forgetIconCache\(/.test(restore));
check("restoreBuiltin：恢复后重新预读图标", /await preloadIcons\(\)/.test(restore));
// 顺序：先忘记旧缓存/失败标记，再预读（反过来会读到刚被删的键）
check(
  "restoreBuiltin：先 forgetIconCache 再 preloadIcons",
  restore.indexOf("forgetIconCache(") >= 0 &&
    restore.indexOf("forgetIconCache(") < restore.indexOf("await preloadIcons()")
);

/* ---------- 4. 覆盖安装 / 开发挂载：预读前也清缓存 ---------- */
const installConfirm = bodyOf("onInstallConfirm");
check(
  "onInstallConfirm：预读前 forgetIconCache（覆盖安装换图标不残留）",
  /forgetIconCache\(/.test(installConfirm) &&
    installConfirm.indexOf("forgetIconCache(") < installConfirm.indexOf("await preloadIcons()")
);
const devDir = bodyOf("installDevDir");
check(
  "installDevDir：预读前 forgetIconCache",
  /forgetIconCache\(/.test(devDir) &&
    devDir.indexOf("forgetIconCache(") < devDir.indexOf("await preloadIcons()")
);

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
