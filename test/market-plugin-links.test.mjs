/**
 * 「插件市场：更新日志 + 首页」回归（纯源码契约，无需浏览器 / Rust）。
 *
 * 用户诉求：
 *   1. 已安装插件在插件市场里出现新版本时，卡片说明下方要显示**这一版**的更新日志；
 *   2. 每个插件卡片都要能看到它的**首页**（仓库优先，退回主页），点了用系统浏览器打开。
 *      首页就是源码地址，文案不再按地址形态区分「源码 / 仓库 / 主页」。
 *
 * 钉死的契约（改动以下任一处都会让本测试失败，请先想清楚是否真的要改）：
 *
 *   数据侧：
 *   1. manifest.ts 解析出 repository / changelog（可选字段，缺席不报错）；
 *   2. market-types.ts 的 parseCatalog 保留 repository / changelog，并提供纯函数
 *      pluginRepoUrl（repository → 反解 GitHub 仓库 → homepage）；
 *   3. host.ts 的 list / refreshCatalog：entries 逐条带 repoUrl，updates 带 changelog + repoUrl。
 *   构建侧：
 *   4. build-index.mjs 的 buildEntry 写出 repository / changelog；三方解析显式传源码仓地址。
 *   UI 侧：
 *   5. market/ui/index.js 仅在 hasUpdate 且有 changelog 时渲染 `.plugin-changelog`，
 *      且读取的是 update 上的 changelog（不是只读 entry）；
 *   6. 卡片渲染 `.plugin-link`（data-link），文案统一「首页」，点击委托走 ms.system.openExternal；
 *   7. detail.css 存在 `.plugin-changelog` 与 `.plugin-link` 样式。
 *
 * 用法: node test/market-plugin-links.test.mjs
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const manifestTs = read("src/lib/plugins/manifest.ts");
const marketTypesTs = read("src/lib/plugins/market-types.ts");
const hostTs = read("src/lib/plugins/host.ts");
const buildIndex = read("scripts/build-index.mjs");
const marketJs = read("plugins/market/ui/index.js");
const marketCss = read("plugins/market/ui/detail.css");
const panelVue = read("src/windows/config/panels/PanelPlugins.vue");

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

/* ---------- 1. manifest.ts：字段与解析 ---------- */
check("manifest.ts：PluginManifest 声明 repository", /repository\?\s*:\s*string/.test(manifestTs));
check("manifest.ts：PluginManifest 声明 changelog", /changelog\?\s*:\s*string/.test(manifestTs));
check(
  "manifest.ts：解析归一化写入 repository",
  /repository:\s*asString\(obj\.repository\)/.test(manifestTs)
);
check(
  "manifest.ts：解析归一化写入 changelog",
  /changelog:\s*asString\(obj\.changelog\)/.test(manifestTs)
);

/* ---------- 2. market-types.ts：字段保留 + pluginRepoUrl ---------- */
check("market-types.ts：MarketPluginEntry 声明 repository", /repository\?\s*:\s*string/.test(marketTypesTs));
check(
  "market-types.ts：parseCatalog 保留 repository",
  /repository:\s*asString\(e\.repository\)/.test(marketTypesTs)
);
check(
  "market-types.ts：导出 pluginRepoUrl",
  /export function pluginRepoUrl\s*\(/.test(marketTypesTs)
);
// 反解 GitHub 仓库的兜底必须在（旧目录没有 repository 字段时靠它）。
// 取 pluginRepoUrl 函数体再断言，避免匹配到同文件里其它 GitHub 地址（如下载白名单）。
const repoUrlBody = (() => {
  const start = marketTypesTs.indexOf("export function pluginRepoUrl");
  const end = marketTypesTs.indexOf("\n}", start);
  return start >= 0 && end > start ? marketTypesTs.slice(start, end) : "";
})();
check(
  "market-types.ts：pluginRepoUrl 从 GitHub Release 地址反解仓库",
  repoUrlBody.length > 0 &&
    repoUrlBody.includes("github\\.com") &&
    repoUrlBody.includes("releases\\/download\\/"),
  repoUrlBody.slice(0, 80)
);

/* ---------- 3. host.ts：list / refreshCatalog 附 repoUrl / changelog ---------- */
// 共用的组装函数（list 与 refreshCatalog 走同一段，避免两处口径分叉）
check("host.ts：存在 buildMarketView 共享组装", /function buildMarketView\s*\(/.test(hostTs));
check(
  "host.ts：entries 逐条附 repoUrl（pluginRepoUrl）",
  /entries:\s*result\.catalog\.plugins\.map\([\s\S]{0,120}?pluginRepoUrl\(/.test(hostTs)
);
check(
  "host.ts：updates 带 changelog",
  /updates:\s*result\.diff\.updates\.map\([\s\S]{0,220}?changelog:\s*u\.entry\.changelog/.test(hostTs)
);
check(
  "host.ts：updates 带 repoUrl",
  /updates:\s*result\.diff\.updates\.map\([\s\S]{0,260}?repoUrl:\s*pluginRepoUrl\(u\.entry\)/.test(hostTs)
);
// list 与 refreshCatalog 都必须走 buildMarketView（不得退回各自手拼、漏掉新字段）
const listBody = /self\.list\s*=\s*\(\)\s*=>[\s\S]*?self\.install\s*=/.exec(hostTs)?.[0] ?? "";
check("host.ts：list 走 buildMarketView", /return buildMarketView\(result\)/.test(listBody));
const refreshBody = /self\.refreshCatalog\s*=[\s\S]*?\n\s*return self;/.exec(hostTs)?.[0] ?? "";
check("host.ts：refreshCatalog 走 buildMarketView", /return buildMarketView\(result\)/.test(refreshBody));

/* ---------- 4. build-index.mjs：写出字段 ---------- */
check(
  "build-index.mjs：buildEntry 写出 repository",
  /if \(repoUrl\) entry\.repository = repoUrl;/.test(buildIndex)
);
check(
  "build-index.mjs：buildEntry 写出 changelog",
  /if \(manifest\.changelog\) entry\.changelog = manifest\.changelog;/.test(buildIndex)
);
check(
  "build-index.mjs：三方条目显式写源码仓地址",
  /repository:\s*`https:\/\/github\.com\/\$\{repo\}`/.test(buildIndex)
);

/* ---------- 5. 市场 UI：更新日志 ---------- */
check(
  "market/ui/index.js：仅在 hasUpdate 且有 changelog 时渲染更新日志",
  /if \(hasUpdate && changelog\)/.test(marketJs)
);
check(
  "market/ui/index.js：取 update 上的 changelog（而非只读 entry）",
  /const changelog = \(upd && upd\.changelog\) \|\| "";/.test(marketJs)
);
check(
  "market/ui/index.js：渲染 .plugin-changelog 区块",
  /plugin-changelog-body/.test(marketJs)
);
// 顺序：更新日志在说明（plugin-desc）之后
check(
  "market/ui/index.js：更新日志排在说明之后",
  marketJs.indexOf("plugin-changelog") > marketJs.indexOf("plugin-desc")
);

/* ---------- 6. 市场 UI：首页链接 ---------- */
check(
  "market/ui/index.js：渲染 .plugin-link 首页链接",
  /class="plugin-link" data-link=/.test(marketJs)
);
check(
  "market/ui/index.js：链接回退 repoUrl → repository → homepage",
  /const linkUrl = e\.repoUrl \|\| e\.repository \|\| e\.homepage;/.test(marketJs)
);
check(
  "market/ui/index.js：卡片链接点击委托到列表容器",
  /\$list\.addEventListener\(\s*"click"[\s\S]{0,220}?closest\("\[data-link\]"\)/.test(marketJs)
);
check(
  "market/ui/index.js：打开链接优先用 ms.system.openExternal",
  /ms\.system\.openExternal\(url\)/.test(marketJs)
);

/* ---------- 6b. 本仓库官方插件：repository 指向 plugins/<目录> ---------- *
 * 用户诉求：源码在本仓库的插件，官方地址应指向该插件的源码目录
 * （`…/my-search-desktop/tree/master/plugins/<目录>`），而不是作者主页。
 * 这里逐个校验清单，缺一个就失败——保证「源码在本仓库」的插件不漏。 */
const IN_REPO_PLUGINS = [
  "baidu-translate",
  "clipboard",
  "com.zhuangjie.github-upload",
  "com.zhuangjie.todo-list",
  "file-search",
  "market",
  "pi-agent",
  "recorder",
  "resource-monitor",
  "screenshot",
];
const REPO_TREE_PREFIX = "https://github.com/My-Search/my-search-desktop/tree/master/plugins/";
for (const dir of IN_REPO_PLUGINS) {
  const mf = JSON.parse(read(`plugins/${dir}/plugin.json`));
  check(
    `plugins/${dir}/plugin.json：repository 指向本仓库源码目录`,
    mf.repository === `${REPO_TREE_PREFIX}${dir}`,
    mf.repository || "(missing)"
  );
}
// 链接文案统一为「首页」：不再按地址形态区分「源码 / 仓库 / 主页」
// （首页就是源码地址，同一份地址换个说法只会让用户困惑）。
check(
  "market/ui/index.js：卡片链接文案统一为「首页」",
  /LINK_ICON \+ "<span>首页<\/span>"/.test(marketJs),
  marketJs.slice(0, 80)
);
check(
  "market/ui/index.js：不再按形态输出「源码 / 仓库 / 主页」标签",
  !/"源码"/.test(marketJs) && !/"仓库"/.test(marketJs) && !/"主页"/.test(marketJs)
);
// 设置面板：repository 与 homepage 合并成一条「首页」，不再分形态标注
check(
  "PanelPlugins.vue：存在 homepageOf（repository 优先，退回 homepage）",
  /function homepageOf\(/.test(panelVue) && /record\.repository \|\| record\.homepage/.test(panelVue)
);
check(
  "PanelPlugins.vue：首页行使用 homepageOf 且标签为「首页」",
  /\{\{\s*homepageOf\(record\)\s*\}\}/.test(panelVue) &&
    /class="plugin-info-label">首页</.test(panelVue) &&
    !/repoLabel\(/.test(panelVue)
);

/* ---------- 7. CSS 契约 ---------- */
check("detail.css：存在 .plugin-changelog 样式", /\.plugin-changelog\s*\{/.test(marketCss));
check("detail.css：更新日志保留换行（white-space: pre-line）", /\.plugin-changelog-body\s*\{[^}]*white-space:\s*pre-line/.test(marketCss));
check("detail.css：存在 .plugin-link 样式", /\.plugin-link\s*\{/.test(marketCss));
// 颜色必须走宿主 token（主题契约），不得写死纯色
check(
  "detail.css：更新日志/链接颜色走宿主 token",
  /\.plugin-changelog\s*\{[^}]*var\(--market-accent/.test(marketCss) &&
    /\.plugin-link\s*\{[^}]*var\(--market-accent/.test(marketCss)
);

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
