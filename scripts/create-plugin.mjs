/**
 * 插件脚手架：生成一个能装、能跑、能被搜到的最小插件。
 *
 * 用法：
 *   node scripts/create-plugin.mjs plugins/hello \
 *     --id com.example.hello --name "你好插件" --keyword "你好"
 *
 * 参数：
 *   --id       反向域名 id（必填，校验规则与宿主一致）
 *   --name     显示名（必填）
 *   --keyword  搜索关键词（缺省用 name）
 *   --desc     一句话描述
 *   --author   作者
 *   --force    目标目录非空时覆盖同名文件（默认拒绝）
 *
 * 生成物：
 *   plugin.json          清单（带 $schema，编辑器可直接补全）
 *   ui/index.html        视图入口
 *   ui/index.js          脚本入口（含 ms / onSubKeyword / lifecycle 示例）
 *   icon.svg             占位图标
 *   README.md            开发说明
 */
import { mkdir, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isValidPluginId, isValidVersion } from "../src/lib/plugins/manifest.ts";
import { isKnownPermission } from "../src/lib/plugins/permissions.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith("--"));
const flags = new Map();
for (let i = 0; i < argv.length; i++) {
  const key = argv[i];
  if (!key.startsWith("--")) continue;
  const next = argv[i + 1];
  if (next && !next.startsWith("--")) {
    flags.set(key.slice(2), next);
    i++;
  } else {
    flags.set(key.slice(2), true);
  }
}

const target = positional[0];
if (!target) fail("请给出目标目录，例如 plugins/hello");

const id = String(flags.get("id") ?? "").trim();
if (!id) fail("缺少 --id（反向域名，如 com.example.hello）");
if (!isValidPluginId(id)) {
  fail(`id 不合法：${id}\n规则：小写字母/数字/中划线，至少两段，如 com.example.hello`);
}

const name = String(flags.get("name") ?? "").trim();
if (!name) fail("缺少 --name（插件显示名）");
if ([...name].length > 48) fail("name 超过 48 个字符");

const keyword = String(flags.get("keyword") ?? name).trim();
if (!keyword) fail("keyword 不能为空");
if (keyword.includes(" : ")) fail(`keyword 不要包含分隔符 " : "（子关键词由宿主拼接）`);

const desc = String(flags.get("desc") ?? "").trim();
const author = String(flags.get("author") ?? "").trim();
const version = String(flags.get("version") ?? "1.0.0").trim();
if (!isValidVersion(version)) fail(`version 不合法：${version}`);

// 清单只声明实际用到的权限：脚手架默认不申请任何权限（最小权限原则）。
// 需要读搜索数据时再加 "search.read"，并在此处用 isKnownPermission 自检。
for (const p of ["search.read"]) {
  if (!isKnownPermission(p)) fail(`宿主不认识权限 ${p}，请检查 permissions.ts`);
}

const dest = path.resolve(target);
const isInsideRepo = !path.relative(root, dest).startsWith("..");
const schemaRef = isInsideRepo
  ? path.relative(dest, path.join(root, "packages/plugin-types/plugin.schema.json")).replace(/\\/g, "/")
  : "../../packages/plugin-types/plugin.schema.json";

try {
  const entries = await readdir(dest);
  if (entries.length > 0 && !flags.get("force")) {
    fail(`目标目录非空：${dest}\n确认要覆盖请加 --force（只会覆盖同名文件，不会删别的）`);
  }
} catch {
  /* 目录不存在：稍后创建 */
}

const manifest = {
  $schema: schemaRef,
  id,
  name,
  version,
  apiVersion: 1,
  author: author || undefined,
  description: desc || `${name}：my-search-desktop 插件`,
  icon: "icon.svg",
  contributes: {
    searchItem: {
      title: name,
      desc: desc || "输入关键词打开",
      keyword,
      icon: "icon.svg",
      subSearch: false,
    },
    detailView: {
      entry: "ui/index.html",
      script: "ui/index.js",
      mode: "inlay",
    },
  },
};

const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(name)}</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0;
        font: 14px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
        color: var(--text, #222);
        background: transparent;
      }
      main { padding: 16px 20px 24px; }
      h1 { font-size: 16px; margin: 0 0 8px; }
      .tip { color: var(--muted, #888); }
      #out { margin-top: 12px; white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(name)}</h1>
      <p class="tip">这是脚手架生成的示例界面，改 ui/index.js 开始写。</p>
      <div id="out"></div>
    </main>
    <script type="module" src="./index.js"></script>
  </body>
</html>
`;

// 该引用写在 ui/index.js 里，比清单深一层目录
const typesRef = `../${schemaRef.replace("plugin.schema.json", "ms.d.ts")}`;
const js = `/// <reference path="${typesRef}" />
/* global ms, onSubKeyword */

const out = document.getElementById("out");

function render(text) {
  if (out) out.textContent = text;
}

// 视图被关闭 / 切走时释放自己的资源（定时器、监听、订阅）
ms.lifecycle.onDispose(() => {
  clearInterval(timer);
});

// 用户「关键词 : 子词」进入二次搜索时回调（需要清单 searchItem.subSearch=true）
onSubKeyword((keyword, payload) => {
  render(\`子关键词：\${keyword}\\n\${JSON.stringify(payload ?? null, null, 2)}\`);
});

// 进入参数：从搜索进入带 keyword，从快捷键/恢复进入也各有来源
const action = ms.lifecycle.current();
if (action) render(\`进入方式：\${action.type} / \${action.from}\\n关键词：\${action.code}\`);

// 演示：宿主子输入框（上方筛选框）；不需要可整段删掉
ms.ui.subInput
  .set({
    placeholder: "试试输入…",
    onChange: (value) => render(\`输入框：\${value}\`),
  })
  .catch(() => {
    /* 独立窗口等形态不支持子输入框，忽略即可 */
  });

const timer = setInterval(() => {
  // 占位：真实插件在这里轮询 / 刷新
}, 5000);
`;

const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="24" fill="#4c8dff"/>
  <path d="M36 44h56M36 64h56M36 84h32" stroke="#fff" stroke-width="8" stroke-linecap="round"/>
</svg>
`;

const readme = `# ${name}

my-search-desktop 插件（\`${id}\`）。

## 开发

1. 在应用里「设置 → 插件 → 从文件夹加载」选中本目录（或打包成 \`.mspp\` 安装）；
2. 搜索「${keyword}」即可打开；
3. 直接改 \`ui/index.html\` / \`ui/index.js\`，重新打开插件视图生效。

## 结构

| 路径 | 说明 |
| --- | --- |
| \`plugin.json\` | 清单，带 \`$schema\` 可自动补全 |
| \`ui/index.html\` | 视图入口 |
| \`ui/index.js\` | 脚本入口；顶部有 \`ms.d.ts\` 引用 |
| \`icon.svg\` | 占位图标 |

## 常用 API

- \`ms.search.data()\`：读搜索结果（需 \`search.read\`）
- \`ms.store.get/set\`：插件私有键值存储
- \`ms.ui.subInput.set\`：宿主在视图上方渲染输入框
- \`ms.lifecycle.onEnter/onDispose\`：生命周期
- \`onSubKeyword(fn)\`：二次搜索子关键词

完整类型见 \`packages/plugin-types/ms.d.ts\`，权限表见 \`src/lib/plugins/permissions.ts\`。
`;

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

await mkdir(path.join(dest, "ui"), { recursive: true });
await writeFile(path.join(dest, "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
await writeFile(path.join(dest, "ui/index.html"), html, "utf8");
await writeFile(path.join(dest, "ui/index.js"), js, "utf8");
await writeFile(path.join(dest, "icon.svg"), icon, "utf8");
await writeFile(path.join(dest, "README.md"), readme, "utf8");

console.log(`\n✓ 已生成插件：${dest}`);
console.log(`  id      ${id}`);
console.log(`  关键词  ${keyword}`);
console.log(`  下一步  cd ${path.relative(process.cwd(), dest) || "."} && 编辑 ui/index.js\n`);
