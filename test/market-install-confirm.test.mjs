/**
 * 「市场安装必经用户确认」回归（纯源码契约，无需浏览器 / Rust）。
 *
 * 用户诉求：从插件市场装插件时，也要像从 .mspp 文件安装那样弹权限确认框；
 * 用户点「取消」就不装。**不允许任何静默安装非官方插件的路径**。
 *
 * 钉死的契约（改动以下任一处都会让本测试失败，请先想清楚是否真的要放开）：
 *
 *   1. `host.ts` 的 `createMarketApi` 在落盘（`installPluginPackage`）之前，
 *      必须先调用 `ctx.confirmPluginInstall(...)`，并在用户取消时提前返回；
 *   2. 宿主未注入该能力时**直接拒绝**（fail-closed）——不能有「没有弹窗就静默装」
 *      的降级分支；
 *   3. `ms.market.install` 与 `ms.market.update` 都走同一段确认逻辑（update 曾
 *      直接转发 install，改坏一处即绕过确认）；
 *   4. `usePluginHost` 把 App.vue 注入的 `confirmPluginInstall` 透传进宿主上下文；
 *   5. App.vue 把它接到安装确认弹窗（`PluginInstallDialog`）上，取消回传 false；
 *   6. 市场 UI 把 `cancelled` 当成功路径处理（不弹「操作失败」）。
 *
 * 用法: node test/market-install-confirm.test.mjs
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostTs = readFileSync(path.join(root, "src/lib/plugins/host.ts"), "utf8");
const usePluginHostTs = readFileSync(
  path.join(root, "src/windows/search/usePluginHost.ts"),
  "utf8",
);
const appVue = readFileSync(path.join(root, "src/windows/search/App.vue"), "utf8");
const marketJs = readFileSync(path.join(root, "plugins/market/ui/index.js"), "utf8");

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log("PASS ", name);
  } else {
    fail++;
    console.log("FAIL ", name, extra ? ` — ${extra}` : "");
  }
};

/* ---------- 1. host.ts：确认先于落盘 ---------- */
// 取 installOrUpdate 的函数体（从定义到 `self.install =` 之前），只在里面找。
const installOrUpdateBody = (() => {
  const start = hostTs.indexOf("async function installOrUpdate");
  const end = hostTs.indexOf("self.install =", start);
  return start >= 0 && end > start ? hostTs.slice(start, end) : "";
})();

check("host.ts：存在 installOrUpdate 安装实现", installOrUpdateBody.length > 0);

const confirmIdx = installOrUpdateBody.indexOf("ctx.confirmPluginInstall(");
const writeIdx = installOrUpdateBody.indexOf("installPluginPackage(");
check("host.ts：调用确认弹窗 ctx.confirmPluginInstall(...)", confirmIdx >= 0);
check("host.ts：确认调用发生在落盘 installPluginPackage 之前", confirmIdx >= 0 && writeIdx > confirmIdx, `confirm@${confirmIdx} write@${writeIdx}`);

// 取消分支必须提前返回（不能继续往下落盘），且返回 cancelled 标记供 UI 识别。
check(
  "host.ts：用户取消时返回 cancelled 且不再落盘",
  /if\s*\(\s*!confirmed\s*\)\s*return\s*\{[^}]*cancelled:\s*true[^}]*\}/.test(installOrUpdateBody),
);

// fail-closed：没有确认能力就拒绝安装（不得有静默降级）。
check(
  "host.ts：未注入确认能力时拒绝安装（fail-closed）",
  /if\s*\(\s*!ctx\.confirmPluginInstall\s*\)[\s\S]{0,120}?return\s*\{[^}]*ok:\s*false/.test(installOrUpdateBody),
);

/* ---------- 2. host.ts：install 与 update 共用确认逻辑 ---------- */
check(
  "host.ts：market.install 走 installOrUpdate(id, \"install\")",
  /self\.install\s*=\s*\(\s*id[^)]*\)\s*=>\s*guarded\(\s*["']install["'][\s\S]{0,80}?installOrUpdate\(id,\s*["']install["']\)/.test(hostTs),
);
check(
  "host.ts：market.update 走 installOrUpdate(id, \"update\")（不再直接转发 install）",
  /self\.update\s*=[\s\S]{0,120}?installOrUpdate\(id,\s*["']update["']\)/.test(hostTs),
);
// 旧写法 `(self.install as any)(id)` 会绕过 update 的确认语义，钉死不许回来。
check(
  "host.ts：update 不再直接调用 self.install 绕过确认",
  !/self\.update[\s\S]{0,160}?self\.install\s+as\s+any/.test(hostTs),
);

/* ---------- 3. usePluginHost.ts：透传 ---------- */
check(
  "usePluginHost.ts：选项声明 confirmPluginInstall",
  /confirmPluginInstall\??:\s*\(req:\s*PluginInstallConfirmRequest\)\s*=>\s*Promise<boolean>/.test(
    usePluginHostTs,
  ),
);
check(
  "usePluginHost.ts：hostContext 里把它交给 confirmPluginInstall",
  /confirmPluginInstall:\s*opts\.confirmPluginInstall/.test(usePluginHostTs),
);

/* ---------- 4. App.vue：接到安装确认弹窗 ---------- */
check(
  "App.vue：usePluginHost 注入了 confirmPluginInstall",
  /confirmPluginInstall:\s*\(req\)\s*=>\s*confirmMarketInstall\(req\)/.test(appVue),
);
check(
  "App.vue：confirmMarketInstall 打开安装确认弹窗（installDialogVisible）",
  /function confirmMarketInstall[\s\S]{0,900}?installDialogVisible\.value\s*=\s*true/.test(appVue),
);
check(
  "App.vue：市场弹窗取消回传 false（closeMarketInstallDialog(false)）",
  /closeMarketInstallDialog\(false\)/.test(appVue),
);
check(
  "App.vue：市场弹窗确认回传 true（closeMarketInstallDialog(true)）",
  /closeMarketInstallDialog\(true\)/.test(appVue),
);

/* ---------- 5. 市场 UI：取消不是失败 ---------- */
check(
  "market/ui/index.js：install 结果 cancelled 时静默复位（不报错）",
  /result\.cancelled\)\s*return\s+restoreBtn\(\)/.test(marketJs),
);
// cancelled 分支必须在 `!result.ok` 的 throw 之前返回——否则取消会被当成失败弹错。
check(
  "market/ui/index.js：cancelled 分支先于 !ok 的 throw 返回",
  (() => {
    const branch = /if \(action === "install"\) \{([\s\S]*?)\} else if/.exec(marketJs)?.[1] ?? "";
    const cancelIdx = branch.indexOf("result.cancelled");
    const throwIdx = branch.indexOf("throw new Error");
    return cancelIdx >= 0 && throwIdx > cancelIdx;
  })(),
);

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);