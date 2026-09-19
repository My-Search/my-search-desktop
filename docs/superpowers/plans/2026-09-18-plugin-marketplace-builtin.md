# 插件市场 + 内置插件交付 设计计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 设计并交付「插件市场」——它本身是一个插件（`com.mysearch.market`），与翻译插件（`com.mysearch.baidu-translate`）、Pi 编码代理（`com.mysearch.pi-agent`）一起作为**内置插件**随应用分发，且用户**可选择卸载**任一内置插件。

**Architecture:** 三个内置插件打包为 Tauri 资源（`resources/plugins/*.msplugin`），应用启动时由 Rust 侧引导安装到 `plugins/<id>/`（`source.kind: "builtin"`），卸载走「移除标记」（`removedBuiltins`）——升级应用不复活已卸载插件（Firefox 用户安装覆盖内置的优先级模型）。市场目录是一个 GitHub 仓库：插件源 + CI 打包出 `.msplugin` Release 资产 + GitHub Pages 托管 `catalog.json`（索引）与二进制，提交走 PR 评审（Raycast/Alfred 的策展式信任模型）。市场插件的 UI 复用宿主现有全链路：搜索关键词打开 `detailView`（inlay），安装/更新/卸载复用既有 `install.ts` 解包→校验→权限确认→原子落盘管线；危险操作（二进制下载）在 Rust 侧再拦一道（`plugin.install` 权限 + 目录 origin 白名单）。

**Tech Stack:** 现有 Tauri 2 + Vue 3 + TS + Vite（不变）；无新增第三方依赖（目录拉取走既有 reqwest/base64；包解析走既有 hand-rolled ZIP）。

## Global Constraints

- **不改插件清单格式的既有字段**，只允许在 `catalog` 侧新增字段；`plugin.json` 唯一新增点见「市场插件的插件清单」节（`optionalPermissions` 里声明 `plugin.install`）。
- **保留所有既有安全底线**：新权限不静默授予、安装先解包再校验清单再权限确认、原子落盘（staging + rename）、`planUpgrade` 的降级拒绝与新增必需权限复确认。
- 内置插件卸载 = 用户选择，**升级应用绝不复活**；只能通过「恢复内置」显式重新安装。
- `source.kind` 的 `"builtin" | "market"` 与注册表 `updateAvailable` 字段已在类型层预留——本计划把它们变成真实语义，**不新增枚举值**。
- 保留 id 前缀 `com.mysearch.` / `mysearch.` 的「官方前缀警告」语义；目录里 `com.mysearch.*` 插件必须标记 `"official": true`，`verified` 用于第三方徽标。
- 市场插件本身卸载后必须能恢复（内置恢复入口在插件的设置面板里常驻）。
- 中文文案、纯函数永抛异常转可读错误（与 `manifest.ts` 风格一致）。

---

## 一、结论先行（TL;DR）

| 问题 | 决策 | 参照 |
|---|---|---|
| 市场放哪 | 专用 GitHub 仓库（源 + CI 打包 + Release 资产 + Pages 目录），PR 提交 | Raycast / Alfred 策展式 |
| 市场是不是插件 | **是**。`com.mysearch.market` 内置插件，贡献 `searchItem` + `detailView` + `settingsPanel` | VS Code 内置扩展与商店同构（dogfooding） |
| 内置插件怎么交付 | 打成 `.msplugin` 放 Tauri 资源，Rust 启动引导安装 | Firefox system add-ons（随应用分发的签名单） |
| 卸载会不会复活 | 不会。`removedBuiltins` 标记，升级跳过；「恢复内置」显式重装 | Firefox 用户安装覆盖内置的优先级链 |
| 安装/更新的安全 | 校验 sha256 + 目录 origin 白名单 + `plugin.install` 权限 + 复用全套既有校验管线 | VS Code 签名 + 块名单；Firefox 强签名；OBS 反面教材 |
| 更新检查 | 后台拉目录 → 写 `updateAvailable` → 用户手动一键更新（不自动装） | VS Code 自动更新关闭时的手动语义；Raycast「本地导入只看不更」 |

---

## 二、主流开源项目插件市场调研与取舍

### 2.1 对比表

| | 目录宿主 | 发现 | 安装 | 更新 | 内置 vs 社区 | 信任模型 |
|---|---|---|---|---|---|---|
| **VS Code** | 专用服务（Azure DevOps Gallery API） | 应用内商店：搜索/分类/`@`筛选/评分 | 一键 + 扩展包 | 后台自动（可关） | 内置=同 API 同捆绑；社区走市场 | 市场签名 VSIX + 发布者 PAT + Verified 徽标 + 恶意块名单 + 发布者信任弹窗 |
| **Firefox AMO** | AMO，Mozilla 托管 | 商店 网站 + 内置管理器 | 一键，**未签名拒绝** | 自动；系统附加组件走 Balrog（原子集） | **system add-ons**：隐藏、不可禁用、独立根 CA 签名；严格覆盖优先级（临时 > 用户装 > 系统更新 > 内置） | 最强：PKCS7 强签名绑定 id + 自动化校验 + 人工审查 + 撤销签名 |
| **Raycast** | GitHub PR 策展 monorepo + 商店服务 | 内置 Store，OS 兼容过滤 | 一键，免重启 | 后台自动；本地导入**永不自动更** | 内置扩展 + 商店 | 开源 + CI 检查 + 团队评审；下载二进制完整性校验 |
| **Alfred** | 官方策展站点 alfred.app | 网站 + RSS + 应用内搜索 | 一键，首次装显示配置 | **手动**，可追平 | 官方与社区同列表 | 单一策展官方渠道替代签名 |
| **OBS** | 去中心（论坛/GitHub/发行源） | 手动；新版应用内插件管理器 | 手动解压/安装器 | 手动为主 | 核心插件内置 vs 外部 DLL | **无签名**——原生代码 + 口碑，应避免的反面教材 |

### 2.2 本项目的取舍

1. **宿主是 Tauri（编译期 Rust），运行时不能 `dlopen` Rust 插件，但本项目的插件是「Webview 侧插件」（JS/TS + 权限声明 + stdio 后台）**——天然具备 VS Code/Raycast 一键安装、跨平台自动分发的形态。市场要成立，就把全文结论背到两条线上：
   - **A. 目录 = 拉取式索引 + Release 二进制**（对应市场「发现与安装」）；
   - **B. 权限 = 既有 Android 式网关 + 新增 `plugin.install`**（对应市场「信任」）。
2. **内置 vs 用户安装的层叠**：取 Firefox「用户安装覆盖内置」的优先级，而不是 VS Code「@builtin 不可卸载」。因为需求明确「用户可选择卸载」。
3. **信任模型分阶段**：MVP 到 Alfred 级（策展目录 + sha256 + PR 评审），第二阶段再上 Firefox 级的离线签名。**绝不复刻 OBS 的无签名模型**。目录二进制下载的 origin 白名单 + sha256 是底线，不做这个不放市场。
4. **不发明新协议**：`.msplugin` 就是 ZIP，目录 `downloadUrl` 直指 Release 资产；目录 JSON 就是结构化索引（GitHub Pages），不需要 Gallery Query API。

---

## 三、阶段性策略（避免一步到位）

| 阶段 | 交付 | 对应章节 |
|---|---|---|
| **P1 内置交付** | 三个插件打成资源 + Rust 引导安装 + 卸载不复活 + 「恢复内置」 | §6、§7 |
| **P2 市场通道** | `market.rs`（二进制 fetch + 白名单）、`plugin.install` 权限、`market.ts` 目录客户端、注册表 `updateAvailable` 打通 | §8 |
| **P3 市场插件** | `com.mysearch.market` 插件本体（商店 UI）+ 面板联动（更新提示/一键更新/浏览市场入口） | §9 |
| **P4 目录与发布基建** | 目录仓库、`meta.json`、CI（打包→Release→Pages catalog）、提交规范、`verified`/`official` 徽标流程 | §10 |
| **P5（预留，不在本期）** | ed25519 离线签名、恶意块名单、评分评论、设置窗 `settingsPanel` 渲染、自动更新开关 | §11 |

> 建议按 P1→P4 顺序执行，每阶段都有可测试交付物；P5 单独立项。

---

## 四、架构总览

```
                          ┌───────────────────────────────┐
                          │      目录仓库（GitHub）          │
                          │  plugins/<id>/ + meta.json      │
                          │  CI: pack → Release(.msplugin) ─┼─┐
                          │  CI: Pages → catalog.json       │ │
                          └───────────────────────────────┘ │
                                                             │ https
┌─────────────┐  复用既有管线   ┌─────────────────────────────▼────────────┐
│  搜索窗      │ ──────────────▶ │  市场插件 com.mysearch.market            │
│  detailView  │                │  搜索项"插件市场"→商店 UI                  │
│  inlay       │                │  读目录→渲染→安装/更新/卸载按钮            │
└─────────────┘                │  ms.market.*（plugin.install 权限）       │
                               └──────────────┬────────────────────────────┘
                                              │ ms.market.install(id)
                ┌─────────────┐               │ ① 调 market_fetch（Rust：      ┌────────────────────┐
                │  设置窗       │              │    白名单+plugin.install）       │  Rust 侧           │
                │  PanelPlugins│◀── updateAvailable / 恢复内置 ──┼───────────▶ │  market.rs         │
                │  +市场入口    │              │ ② 前端 sha256 校验              │  builtin.rs        │
                └─────────────┘              │ ③ 复用 install.ts 解包/校验/确认  │  plugin_host.rs    │
                                             │ ④ plugin_install 原子落盘        │  （既有）           │
                                             └────────────────────────────────────┘
```

**两条执行带**：
- **前端（市场插件 + 浏览器内逻辑）**：`ms.market.*` 全在既有的 `host.ts` 权限网关内实现，纯函数部分（目录校验、版本比对、兼容过滤）在 `src/lib/plugins/market.ts`，Node 可测。
- **Rust（资源 + 下载 + 引导）**：`builtin.rs`（资源清单/引导/恢复/移除标记）+ `market.rs`（按白名单下载二进制）+ 既有 `plugin_install`（文件落盘）。

---

## 五、新增/修改文件总表

### 新建
| 文件 | 职责 |
|---|---|
| `src-tauri/src/builtin.rs` | 内置插件：资源清单、首次引导安装、`builtin_remove`/`builtin_restore`、`internal/builtins.json`（removed 标记） |
| `src-tauri/src/market.rs` | 市场 IPC：`market_fetch_raw`（origin 白名单 + `plugin.install` 双检）、目录 base 配置 |
| `src/lib/plugins/market-types.ts` | 目录 `catalog.json` schema + 校验（永不抛异常、可读中文文案，镜像 `manifest.ts` 风格） |
| `src/lib/plugins/market.ts` | 目录客户端：拉取/缓存/兼容过滤/`updateAvailable` 写入/块名单检查（纯逻辑可测） |
| `plugins/mysearch-market/plugin.json` | 市场插件清单 |
| `plugins/mysearch-market/ui/detail.html` + `detail.css` + `index.js` | 商店 UI（搜索/分类/已安装/更新 四段 + 详情 + 安装/更新/卸载） |
| `plugins/mysearch-market/README.md` | 市场插件说明 |
| `src-tauri/resources/plugins/.gitkeep` + 打包产物目录 | 内置资源落点（CI 填 `*.msplugin`） |
| `.github/workflows/publish-plugin-market.yml` | P4：pack 三个内置/参赛插件 → Release → 生成 catalog.json → Pages |
| `test/market-catalog.test.mjs` | `market-types.ts`/`market.ts` 纯逻辑测试 |
| `test/market-ui.test.mjs` | 浏览器端到端：本地目录 fixture，市场插件装/更/卸 |
| `test/builtin.test.mjs` | 前端侧内置引导/恢复/标记的纯逻辑（Rust 侧单独 `cargo test`） |
| `docs/plugin-market.md` | 面向开发者的市场接入文档（如何在目录仓库发布插件） |

### 修改
| 文件 | 改动 |
|---|---|
| `src-tauri/tauri.conf.json` | `bundle.resources` 加入 `resources/plugins/**` |
| `src-tauri/src/lib.rs` | `setup` 里调用 `builtin::bootstrap(app)`；注册 `builtin_*`/`market_fetch_raw` 命令 |
| `src/lib/plugins/permissions.ts` | 新增高风险权限 `plugin.install`（含分组/文案/`requiresExplicitConsent`） |
| `src/lib/plugins/gateway.ts` | 把 `plugin.install` 从 grants 镜像进网关（Rust 第二道防线有据可依） |
| `src/lib/plugins/ipc.ts` | `builtinRestore`/`marketFetchRaw` 等 Tauri 桥接（浏览器降级 mock） |
| `src/lib/plugins/host.ts` | 新增 `ms.market.*`（list/install/update/uninstall/checkUpdates），全部以 `plugin.install` 为门槛 |
| `src/windows/config/panels/PanelPlugins.vue` | 「内置/市场」来源徽标、卸载时提示与确认、更新列（`updateAvailable`）+ 一键更新、「恢复内置」、「浏览插件市场」入口 |
| `src/windows/config/usePluginRuntime.ts` | 暴露市场更新聚合（licence 合并 `updateAvailable` 状态） |
| `README.md` | 插件市场章节 |
| `package.json` | script：`pack:builtin`（Pack 三个内置插件到 `src-tauri/resources/plugins/`） |

---

## 六、内置插件交付设计（P1，§6-§7）

### 6.1 交付形态

每个内置插件在发布时用既有 `test/pack-plugin.mjs` 打成 `.msplugin`，放进 `src-tauri/resources/plugins/`：

```
src-tauri/resources/plugins/
  com.mysearch.baidu-translate.msplugin
  com.mysearch.pi-agent.msplugin
  com.mysearch.market.msplugin          # P3 加入
```

`tauri.conf.json` 追加：

```jsonc
"bundle": {
  ...,
  "resources": ["resources/plugins/*.msplugin"]
}
```

运行时经 `app.path().resource_dir()` → `resources/plugins/` 读取（跨平台一致）。

### 6.2 内置 id 白名单

```rust
// src-tauri/src/builtin.rs
/// 允许随资源引导的内置插件 id（防资源被篡改成任意插件走免确认通道）。
const BUILTIN_ALLOWLIST: [&str; 3] = [
    "com.mysearch.baidu-translate",
    "com.mysearch.pi-agent",
    "com.mysearch.market",
];
```

> 与前端 `manifest.ts` 的 `RESERVED_ID_PREFIXES["com.mysearch."]` 呼应：**内置引导只认资源里这块白名单**，其他内容一律不与引导流程。

### 6.3 首次引导与卸载/恢复

`data_dir` 下新增 `internal/builtins.json`：

```json
{ "schemaVersion": 1, "removed": ["com.mysearch.pi-agent"] }
```

`buildin bootstrap` 流程（应用启动、重建网关前置）：

```
for each (id, bundle) in resources:
    if id not in BUILTIN_ALLOWLIST: log+skip
    if id in builtins.json.removed:  skip            // 用户卸载过 -> 不复活
    if plugins/<id>/plugin.json 已存在: skip          // 已有同名插件（含市场版）不覆盖
    extract bundle -> staging -> atomic rename -> plugins/<id>/
    write builtin bootstrap marker（前端提示「已为您安装内置插件：x」）
```

三条命令（全部要求调用方传应用版本号，防旧客户端误删新版数据）：
- `builtin_is_installed(id) -> bool`
- `builtin_remove(id)`：删 `plugins/<id>/`，「仅当 id ∈ 白名单」才写 `removed`
- `builtin_restore(id)`：清 `removed` → 重新从资源引导 → 返回新 manifest

前端 `PanelPlugins` 对 `source.kind === "builtin"`（或资源存在但已卸）的行显示：
- 已装：徽标「内置」+ 普通卸载（卸载框文案：「卸载内置插件不会影响应用升级，升级不会把它装回来；需要时可在『恢复内置』重新安装」）
- 已卸（资源存在的 id，列表单独一个「内置未安装」分组）：按钮「恢复内置」

**关键语义**：应用升级时 `bootstrap` 对 `removed` 里的 id 一律跳过（Firefox「用户安装覆盖内置」的逆向应用：用户的卸载决定优先级最高）。内置插件的升级走两条路：随应用升级（资源里版本更高且插件仍在）由 `plugin_host`/前端升级确认后覆盖；或从市场升级（见 §8.3），此时 `source` 变成 `{kind:"market"}`（不保留 builtin 标记，避免与目录版本打架）。

### 6.4 与备份/同步的兼容

`backup.rs` 已覆盖 `plugins/<id>/` 与 `plugin-data/<id>/`；`internal/builtins.json` 加入备份分区列表（`internal/` 前缀），保证恢复备份后卸载决定仍在。**本轮只补备份收集，不引入新的同步语义。**

---

## 七、内置插件引导与恢复——Rust 实现要点（P1）

`src-tauri/src/builtin.rs` 关键签名：

```rust
pub fn bundle_manifest(app: &AppHandle) -> Vec<BundledPlugin> {
    // BundledPlugin { id, resource_path, version } —— 从 resources/plugins/*.msplugin
    // 文件名解析（id 即文件名去掉 .msplugin），版本在引导后读 plugin.json 得到
}

pub fn bootstrap(app: &AppHandle) -> Result<BootstrapReport, String> {
    // 1) load_or_init internal/builtins.json
    // 2) for bundle in bundle_manifest(app) 按 §6.3 规则 skip / install
    // 3) 返回 BootstrapReport { installed: Vec<String>, skipped_removed: Vec<String> }
}

pub fn is_builtin(id: &str) -> bool { BUILTIN_ALLOWLIST.contains(&id) }

fn install_bundle(app: &AppHandle, bundle: &BundledPlugin) -> Result<(), String>
    // 复用 plugin_host 的 staging+rename 落盘辅助（提取为 pub(crate) 函数）
```

安装细节：解压 `.msplugin`（既有 hand-rolled ZIP 读取逻辑在 `package.ts` 前端侧——**Rust 侧没有 ZIP 解包实现**。为避免跨语言重复安全校验（路径穿越等），内置引导 RUST 侧只做「整体拷贝资源 → 请求前端做安装受理」：

> **P1 修正设计**：`bootstrap` 不自己解包。改为 Rust 把资源路径通过事件 `builtin://available` 广播给两个窗口，前端用既有 `install-from-path` 管线（`install.ts` 解包 → 校验 manifest → 权限注册 → `plugin_install` 原子落盘）完成安装。Rust 只负责：存在性检查、白名单、`removed` 标记读写。
> 好处：安全校验只在 `install.ts` 一份实现；`bootstrap` 只是「把资源当作本地文件装的触发器」。

相应地 `TauriCommand` 只有：
- `builtin_list -> Vec<{id, available: bool, installed: bool, version: Option<String>}>`
- `builtin_mark_removed(id)` / `builtin_clear_removed(id)`
- `builtin_resource_path(id) -> Option<String>`（前端拿路径走既有文件安装管线）

`removed` 语义由 Rust 持久化，前端注册表只负责展示。

---

## 八、市场通道设计（P2）

### 8.1 `catalog.json` schema（`market-types.ts`）

```ts
export interface MarketCatalog {
  schemaVersion: 1;
  generatedAt: string;                 // ISO
  baseUrl: string;                     // 派生下载的根（如 https://github.com/<org>/mysearch-plugins/releases/download）
  plugins: MarketPluginEntry[];
}

export interface MarketPluginEntry {
  id: string;                          // 反向域名，与 plugin.json.id 一致
  name: string;
  version: string;                     // SemVer
  apiVersion: number;
  minAppVersion?: string;              // 低于当前 app 版本则隐藏（Raycast OS 过滤）
  author: string;
  homepage?: string;
  icon?: string;                       // data: / http(s):（目录不读相对路径）
  categories: string[];                // 如 ["翻译", "AI 代理", "工具", "效率"]
  tags?: string[];
  description: string;                 // 卡片摘要（≤120 字，UI 截断）
  changelog?: string;                  // 详情页展示
  downloadUrl: string;                 // 完整 URL，必须以 baseUrl 为前缀（校验）
  sha256: string;                      // .msplugin 摘要，安装必验
  size?: number;                       // 字节，列表展示
  permissions: string[];               // 声明权限（安装确认页预填，来自清单，信任展示用）
  official?: boolean;                  // com.mysearch.* 第一方
  verified?: boolean;                  // 第三方策展徽标
  downloads?: number;                  // 待接入计数平台（0 起步，不捏造）
  publishedAt: string;
  updatedAt: string;
}
```

校验规则（`manifest.ts` 风格，永不抛异常）：`id` 非空、`downloadUrl` 以 `baseUrl` 前缀开头、`sha256` 为 64 位 hex、`version` 为合法 SemVer、`downloadUrl` 与 `id` 的一一对应（目录内 id 重复 → 保留更大 `version`，重复两条同版本 → 报错不装）。

### 8.2 `market.ts` 目录客户端（纯逻辑，Node 可测）

```ts
export interface MarketConfig {
  catalogUrl: string;          // 默认：官方 Pages 地址；可被 store 覆盖/dev 环境变量
  catalogBaseUrl: string;      // 从 catalog.baseUrl 覆盖
}
export interface MarketSnapshot {
  catalog: MarketCatalog | null;
  fetchedAt: number;
  error?: string;              // 拉取失败的展示文案
}

export function parseCatalog(json: unknown): { ok: true; catalog: MarketCatalog } | { ok: false; errors: string[] };
export function compatibleEntries(catalog: MarketCatalog, appVersion: string): MarketPluginEntry[];
export function diffCatalog(reg: PluginRegistryFile, entries: MarketPluginEntry[]): {
  updates: { rec: PluginRecord; entry: MarketPluginEntry }[];   // 目录版本 > 已装版本，且 minAppVersion 满足
  newOnes: MarketPluginEntry[];                                  // 未安装
  blocked: MarketPluginEntry[];                                  // 命中块名单，不可见/不可装
};
export function applyUpdateAvailable(reg: PluginRegistryFile, updates: ...): PluginRegistryFile; // 写 rec.updateAvailable
export interface Blocklist { ids: string[]; }                    // 未来哨兵；本轮恒为空集
```

**更新检查触发**：市场插件打开时、`PanelPlugins` 打开时、以及应用每 6 小时后台一次（`market_check` 事件，去重、不打断用户）。结果写 `updateAvailable`（注册表字段已存在），面板「插件」列表出现「可更新」角标；**只提示，不自动装**。

### 8.3 `role` 化的引入——安装/更新/卸载如何在已有管线上跑

安装与更新**复用现有代码**，不需要新管线：

```
ms.market.install(id)        // 权限 plugin.install
  → 找到 compatible entry（目录本来就是刚拉到的）
  → ms.market.download(id)   // 内部：market_fetch_raw(downloadUrl, sha256)
       Rust: 校验 grants.plugin.install + url 前缀 ∈ catalogBaseUrl 白名单
             reqwest 拿 bytes → base64 返回
       前端: sha256 比对，不符报「包摘要不符，已拒绝」
  → 得到 .msplugin bytes → 走 install.ts 的「从字节安装」分支
       （现有 install.ts 已能处理解包/剥离包裹目录/清单校验/权限确认/报文；缺「字节直装」路径则在 P2 补一个纯函数：bytes → FileTable，复用 TestPluginZip 的单测）
  → plugin_install（Rust）原子落盘
  → 升级走得 planUpgrade：新增必需权限 → 确认框；降级 → 拒绝
ms.market.update(id)         // updateAvailable 为真的插件；同上，next=目录条目
ms.market.uninstall(id)      // 调既有 remove 命令 + 清 plugin-data + 注册表移除
```

「从字节安装」的权限确认弹窗复用宿主 `host.confirm`（已存在）+ 权限逐条展示（复用 `summarizePermissions`/`groupPermissions`）。

### 8.4 权限与第二道防线

`permissions.ts` 增加：

```ts
{
  id: "plugin.install",
  risk: "high",                       // requiresExplicitConsent 强提示
  group: "plugin",
  label: "安装与更新插件",
  desc: "允许管理插件：从市场安装、升级、卸载插件（仅限目录已验证来源）",
}
```

- 前端：`ms.market.*` 全部走 `call({ permission: "plugin.install", ... })`，未授权抛 `PluginPermissionError`。
- Rust 第二道防线：`market_fetch_raw` 命令服务端检查（镜像 `plugin_host` 既有「前端被绕过，Rust 再拒一次」的思路）：
  1. `grants` 里确有 `plugin.install`（网关配置 `gateway.ts` 把该权限镜像进 `plugin-gateway.json`）；
  2. `url` 前缀 ∈ 已配置目录 base 白名单（`market_base_whitelist` 起点为默认官方 base，可被环境变量/设置覆盖，覆盖需确认）。

### 8.5 目录拉取失败与降级

- 目录不可达 → `error` 文案展示 + **已装插件完全不受影响**（市场只负责「发现与更新提示」）；更新检查静默失败，不弹垂死错误。
- 目录校验失败（结构损坏/字段缺）→ 视为不可信，丢弃，报「目录数据无效」。
- `baseUrl` 不匹配的 `downloadUrl` 条目在解析期即拒绝（防目录被攻破后指到任意 URL）。

---

## 九、市场插件本体（P3）

### 9.1 插件清单（`plugins/mysearch-market/plugin.json`）

```jsonc
{
  "id": "com.mysearch.market",
  "name": "插件市场",
  "version": "1.0.0",
  "apiVersion": 1,
  "minAppVersion": "7.9.16",
  "author": "MySearch Team",
  "description": "浏览、安装、更新与卸载插件",
  "homepage": "https://github.com/",
  "icon": "ui/icon.svg",
  "permissions": [
    "ui.inlay",
    "store",
    "net.fetch:https://github.com/*",
    "net.fetch:https://raw.githubusercontent.com/*",
    "net.fetch:https://*.githubusercontent.com/*"
  ],
  "optionalPermissions": [
    "plugin.install"
  ],
  "contributes": {
    "searchItem": {
      "title": "[可搜索][市场]插件市场",
      "desc": "浏览、安装、更新与卸载插件",
      "keyword": "插件市场"
    },
    "detailView": {
      "entry": "ui/detail.html",
      "script": "ui/index.js",
      "closeBehavior": "exit"
    },
    "settingsPanel": {
      "entry": "ui/settings.html",
      "title": "插件市场"
    }
  }
}
```

> `plugin.install` 放 `optionalPermissions`：读目录、浏览、看详情不需要高危权限，只有点「安装/更新/卸载」才触发授权弹窗（既是 UX 也是「最小权限」）。
> `closeBehavior: "exit"`：市场是低频入口，关闭即卸载视图，避免长期驻留内存（市场不需要「停车保活」）。
> `settingsPanel`：清单层已支持，但**设置窗宿主的 settingsPanel 渲染本轮若不实现**，则市场插件出现在搜索框（`detailView` 主入口）。P5 再补设置窗内嵌；本期 `PanelPlugins` 的「浏览插件市场」按钮走既有 `my-search://shortcut-open-plugin` 到搜索窗打开 market 插件。

### 9.2 `ms.market.*` 宿主 API（`host.ts` 新增，均 gate 在 `plugin.install`）

```ts
market: {
  list: () => Promise<MarketView>;        // { entries, installedMap, updates[] , blocked[] }
  install: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  update: (id: string) => Promise<{ ok: true; updatedTo: string } | { ok: false; error: string }>;
  uninstall: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  checkUpdates: () => Promise<number>;    // 返回可更新数量，写 updateAvailable
  refreshCatalog: () => Promise<MarketView>; // 强制拉一次目录
}
```

实现尽可能薄：`market.ts` 提供纯函数，`host.ts` 组装 + 权限 + IPC 调用。

### 9.3 商店 UI（`ui/detail.html` + `index.js`）

参照 Raycast Store / Alfred Gallery 的信息架构，四段 Tab：

1. **精选**：首屏卡片（最近更新 + `verified` 前置），`official` 显示「官方」徽标。
2. **分类**：`categories` 聚合侧栏/顶栏；每类下按 `downloads` 降序（无数据时按更新时间）。
3. **已安装**：`installedMap` 反查本地注册表，显示版本 + 更新角标，行内「更新」按钮。
4. **更新**：`updates[]` 聚合（与 `PanelPlugins` 同数据源，用 `sessionStorage` 共享避免双重拉取）。

详情卡：图标、名称、作者徽标（官方/已验证）、版本、大小、更新记录（`changelog`）、**权限摘要**（复用 `summarizePermissions` 的文案：`声明权限：网络访问-指定域名、界面内嵌、安装与更新插件`，高危权限标红）、主按钮（安装 / 更新 / 已是最新 / 卸载）。

UI 约束（遵循既有插件视图契约）：
- 脚本拿 `ms` / `plugin` / `onSubKeyword`（`插件市场 : 关键字` → 检索市场）。
- 不使用第三方 CSS 框架，纯 CSS 变量 + 宿主主题；所有文本经 `escapeHtml`。
- 图标：`data:` / `http(s):` 直出（目录不做相对路径图标，规避读包 IPC）。

### 9.4 面板联动（`PanelPlugins.vue`）

- 每行来源徽标：`内置`（`source.kind==="builtin"`）/ `市场`（`["market"]`）/ `本地`（`["file","folder"]`）。
- `updateAvailable` 非空 → 「更新」按钮置上（调 `ms.market.update` 的宿主直连，或打开市场插件跳转到该插件详情——取决于实现简化，P3 选直连）。
- 头部新增按钮：「浏览插件市场」（打开市场插件 detailView）、「恢复内置插件」（列出资源里 `removed` 的 id）。
- 卸载确认文案按来源区分（内置见 §6.3）。

---

## 十、目录与发布基建（P4）

### 10.1 目录仓库结构（新仓库 `mysearch-plugin-market`，与 TisHub 订阅市场的 GitHub-Repo-as-backend 思路一致但形态不同）

```
mysearch-plugin-market/
  catalog.json                 # 产物：CI 生成后提交，GitHub Pages 托管
  plugins/
    com.mysearch.market/       # 源（含 plugin.json + ui/ + backend/）
      meta.json
    com.foo.bar/
      meta.json
  .github/workflows/
    publish.yml                # tag/v 触发：pack-plugin → GitHub Release(.msplugin) → 重写 catalog.json → Pages
  CONTRIBUTING.md              # 提交规范
```

`meta.json`（作者侧声明目录元数据，与 `plugin.json` 分离，避免污染插件清单）：

```json
{
  "categories": ["工具"],
  "tags": ["market"],
  "screenshots": [],
  "verifiedBy": null        // 未来策展流程字段
}
```

`catalog.json` 的 `downloadUrl/sha256/size` 由 CI 从 Release 资产与打包产物计算填入，**作者不手写哈希**（防伪造）；`official` 由仓库维护组只读列白名单维护。

### 10.2 提交与信任流程（Raycast/Alfred 模型）

1. 作者 Fork 目录仓库 → `plugins/<id>/` 加源 + `meta.json` → PR；
2. CI 前置检查：manifest 校验（复用 `manifest.ts` 的 Node 单测同样式）、`pack-plugin` 打包、`test/` 可选跑、图片/路径安全检查；
3. 维护组评审合入 → 打 tag → publish.yml 出 Release + 重写 catalog → Pages 更新；
4. 客户端下次拉目录即见新插件/新版本。

### 10.3 MVP 信任边界（诚实声明）

- MVP = **策展信任**（Alfred 级）：目录仓库受控、PR 评审、sha256 完整性校验。**没有离线签名**——目录仓库被攻破时可以指到恶意 URL。缓解：`downloadUrl` 前缀校验（§8.1）+ 白名单 base + 权限强确认 + 沙箱化 `plugin.install`（装恶意插件最高风险仍是 `backend.spawn`/`secret.read`，这些继续走既有强提示）。
- 升级到 **签名信任**（Firefox 级）是 P5 的第一优先：目录里每包附 ed25519 签名，公钥随应用分发；客户端离线验签。

### 10.4 内置插件在目录里的角色

三个 `com.mysearch.*` 内置插件**既随应用分发也在目录登记**。目录版本高于内置版本时，`updateAvailable` 提示走市场升级（独立于应用发版节奏）。应用升级与市场升级的优先级：**市场版胜**（`source` 记为 `market`）。

---

## 十一、P5 预留（明确不做）

- ed25519 离线签名 + 公钥轮换（Firefox 式强签名）；
- 恶意块名单 `blocked`（VS Code block-list 模式：`market.ts` 已留 `Blocklist` 类型位）；
- 评分/评论、`downloads` 计数平台；
- 设置窗 `settingsPanel` 宿主渲染（让市场插件同时内嵌进设置窗）；
- 自动更新开关（默认手动，P5 提供 `autoUpdate` 全局开关）；
- 目录分页/缓存续传/GCM 推送更新通知。

---

## 十二、实施任务分解

> 每任务独立可测、可提交。**关键规则：先在 `test/<name>.test.mjs` 写失败测试再实现（TDD），周目遵循既有插件测试的复用样式（`node test/*.test.mjs`）。**

### Task 1: 权限 `plugin.install` + 网关镜像
**Files:**
- Modify: `src/lib/plugins/permissions.ts`
- Modify: `src/lib/plugins/gateway.ts`
- Test: `test/market-catalog.test.mjs`（先加 `permission.install` 的 `requiresExplicitConsent` 断言）

**Produced:** `isKnownPermission("plugin.install")===true`、`requiresExplicitConsent("plugin.install")===true`、网关 `grants` 数组包含 `plugin.install`。

- [ ] **Step 1**: 在 `permissions.ts` 权限目录加入 `plugin.install` 定义（`risk:"high"`，分组 `plugin`）。
- [ ] **Step 2**: `gateway.ts` 无改动（grants 整体现有镜像逻辑已覆盖新权限串）；跑 `node test/market-catalog.test.mjs` 断言授权行为。
- [ ] **Step 3**: Commit `feat: plugin.install 权限`.

### Task 2: `market-types.ts` 目录 schema 与校验（纯函数）
**Files:**
- Create: `src/lib/plugins/market-types.ts`
- Test: `test/market-catalog.test.mjs`

**Interfaces:**
```ts
parseCatalog(json: unknown): { ok: true; catalog: MarketCatalog } | { ok: false; errors: string[] };
compatibleEntries(catalog: MarketCatalog, appVersion: string): MarketPluginEntry[];
```
**Produced:** 供 Task 3 使用。

- [ ] **Step 1**: 写失败测试（合法目录 / 缺 sha256 / downloadUrl 前缀越界 / 重复 id 取高版本 / `minAppVersion` 过滤 / 非 64 位 hex 拒绝）。
- [ ] **Step 2**: 实现 `parseCatalog`/`compatibleEntries`，`describeCatalogErrors` 中文文案。
- [ ] **Step 3**: PASS → Commit.

### Task 3: `market.ts` 目录客户端 + `updateAvailable` 打通
**Files:**
- Create: `src/lib/plugins/market.ts`
- Modify: `src/lib/plugins/registry.ts`（无；字段已存在）
- Test: `test/market-catalog.test.mjs`

**Interfaces:**
```ts
diffCatalog(reg, entries): { updates; newOnes; blocked };
applyUpdateAvailable(reg, updates): void;   // 写 rec.updateAvailable，返回 void（就地）
clearUpdateAvailable(reg, id): void;
```

- [ ] **Step 1**: 失败测试（版本高于已装 → updates；版本含 `plugin.install` 等权限 → 仍在；`minAppVersion` 超 → 过滤）。
- [ ] **Step 2**: 实现；`updateAvailable` 只写 `market` 来源或内置来源的插件（`legacy/folder` 不参与）。
- [ ] **Step 3**: PASS → Commit.

### Task 4: Rust `market.rs`（白名单下载）+ IPC 接入
**Files:**
- Create: `src-tauri/src/market.rs`
- Modify: `src-tauri/src/lib.rs`（注册命令 + `market_base_whitelist` 默认值）
- Modify: `src/lib/plugins/ipc.ts`（`marketFetchRaw` 桥接 + 浏览器 mock 返回目录 fixture）
- Test: `cd src-tauri && cargo test`（白名单放行/拒 URL/无权限拒）

**Interfaces:**
```rust
#[tauri::command] fn market_fetch_raw(app, state, url: String, expected_sha256: String)
  -> Result<Vec<u8>, String>
```

- [ ] **Step 1**: Rust 侧测试（fake `urls` 校验函数：前缀白名单、许可判定用注入的 grants）。
- [ ] **Step 2**: 实现 `market_fetch_raw`（reqwest → bytes；`granted plugin.install` 校验用 `plugin-gateway.json` 读入——复用 `plugin_host` 既有加载）。
- [ ] **Step 3**: `cargo test` PASS + `npm run typecheck` → Commit.

### Task 5: 内置插件交付（Rust 资源引导）
**Files:**
- Create: `src-tauri/src/builtin.rs`
- Modify: `src-tauri/tauri.conf.json`（`bundle.resources` 加 `resources/plugins/*.msplugin`）
- Modify: `src-tauri/src/lib.rs`（`setup` 里发 `builtin://available` 事件）
- Create: `src-tauri/resources/plugins/.gitkeep`（占位，CI 填真包）
- Modify: `package.json`（`pack:builtin` script：`node test/pack-plugin.mjs` 依次打三个内置插件到 `src-tauri/resources/plugins/`）
- Test: `test/builtin.test.mjs`（前端收到的 `builtin://available` 列表 → 走既有安装管线）；Rust `cargo test`

- [ ] **Step 1**: `package.json` 加 `pack:builtin`；跑一次把 `baidu-translate`、`pi-agent` 打包进 `resources/plugins/`。
- [ ] **Step 2**: `builtin.rs`：`bundle_manifest`/`is_builtin`/`builtin_list`/`builtin_mark_removed`/`builtin_clear_removed`/`builtin_resource_path`；`internal/builtins.json` 读写。
- [ ] **Step 3**: 注册命令，`setup` 后 emit `builtin://available`（携带白名单内、未 `removed`、尚未安装的 id 列表）。
- [ ] **Step 4**: 前端 `ipc.ts`/`usePluginRuntime` 监听事件 → 对每个未装 id 用 `builtin_resource_path` 拿路径 → 走既有「从文件安装」管线（需在 `install.ts` 加「按绝对路径安装」分支，复用现有 `plugin_install`）。安装完成 toast「已为您安装内置插件：x」。
- [ ] **Step 5**: 浏览器端到端（`test/builtin.test.mjs`）：内置出现 → 卸载 → 重启不复活 → 恢复内置回到列表。
- [ ] **Step 6**: Commit.

### Task 6: `PanelPlugins.vue` 内置/市场徽标 + 更新与恢复入口
**Files:**
- Modify: `src/windows/config/panels/PanelPlugins.vue`
- Modify: `src/windows/config/usePluginRuntime.ts`
- Test: `test/plugin-panel-ui.test.mjs`（扩展：徽标断言）

- [ ] **Step 1**: 来源徽标（内置/市场/本地）与「更新」列（读 `updateAvailable`）。
- [ ] **Step 2**: 卸载确认文案按来源区分；新增「恢复内置插件」弹层（调 `builtin_list` → `builtin_clear_removed` + 安装）。
- [ ] **Step 3**: 更新按钮 → `ms.market.update`（宿主直连，P3 完成前按钮带 disabled 提示「市场插件未安装」）。
- [ ] **Step 4**: 端到端 PASS → Commit.

### Task 7: 「从字节安装」管线（`install.ts` 纯函数增量）
**Files:**
- Modify: `src/lib/plugins/install.ts`
- Test: `test/market-catalog.test.mjs` / `test/plugin-install.test.mjs`

**Interfaces:**
```ts
installFromBytes(bytes: Uint8Array, opts: { source: { kind: "market"; ref: string } }): Promise<Result>
// 复用现有 unzip→strip→validate→permission confirm→plugin_install；唯一差异：输入是 bytes 不是文件路径
```

- [ ] **Step 1**: 对既有 `readPluginFileTable`（假定名；按当前实现命名对齐）抽一个 bytes 入口的失败测试。
- [ ] **Step 2**: 补 bytes 直装分支；目录安装时同时校验 sha256。
- [ ] **Step 3**: PASS → Commit.

### Task 8: `ms.market.*` 宿主 API
**Files:**
- Modify: `src/lib/plugins/host.ts`
- Modify: `src/lib/plugins/ipc.ts`
- Test: `test/market-catalog.test.mjs`

- [ ] **Step 1**: 失败测试（无 `plugin.install` 权限调 `market.install` → 抛 `PluginPermissionError`）。
- [ ] **Step 2**: 实现 `market.list/install/update/uninstall/checkUpdates/refreshCatalog`（全走 `call({permission:"plugin.install",...})`；实现薄，逻辑在 `market.ts`+`install.ts`）。
- [ ] **Step 3**: PASS → Commit.

### Task 9: 市场插件本体
**Files:**
- Create: `plugins/mysearch-market/plugin.json`、`ui/detail.html`、`ui/detail.css`、`ui/index.js`
- Test: `test/market-ui.test.mjs`（浏览器端到端：目录 fixture 服务 → 打开市场插件 → 搜索/分类 → 安装（权限弹窗）→ 已安装段出现 → 更新（新版含新权限 → 复确认）→ 卸载）

- [ ] **Step 1**: 用 `pack-plugin.mjs` 打包 → 从文件安装进宿主，`plugin://dev-changed` 热重载开发（目录挂载）。
- [ ] **Step 2**: 四段 Tab + 详情卡 + 安装/更新/卸载按钮全链路。
- [ ] **Step 3**: 页面 loading/error/empty 三态 + 权限摘要（复用 `groupPermissions`）。
- [ ] **Step 4**: 端到端 PASS → Commit.

### Task 10: 目录仓库与发布基建
**Files:**
- Create: `.github/workflows/publish-plugin-market.yml`
- Create: `docs/plugin-market.md`（开发者接入文档）
- Modify: `README.md`

- [ ] **Step 1**: workflow：checkout → `npm ci` → 遍历 `plugins/*/meta.json` → `pack-plugin` → 建 Release 上传 `.msplugin` → 用 `pack` 输出计算 `sha256/size/downloadUrl` → 重写 `catalog.json` → 部署 Pages。
- [ ] **Step 2**: `docs/plugin-market.md`：目录结构、`meta.json` 字段、提交清单、评审标准、信任边界说明。
- [ ] **Step 3**: `README.md` 插件市场章节。
- [ ] **Step 4**: Commit.

---

## 十三、测试矩阵

| 层 | 测试 | 覆盖 |
|---|---|---|
| 纯逻辑 | `test/market-catalog.test.mjs` | 目录解析/校验/兼容过滤/diff/权限契约/updateAvailable |
| 纯逻辑 | `test/builtin.test.mjs` | 前端接收内置事件→安装管线；removed 语义 |
| Rust | `cargo test` | `market_fetch_raw` 白名单/许可/哈希参数；`builtin.rs` removed 读写、白名单拒非内置 |
| 端到端 | `test/market-ui.test.mjs` | 浏览器：市场安装→通知→搜索项→打开商店→装/更/卸（含新权限复确认） |
| 回归 | 既有 `plugin-*.test.mjs` 全量 | 权限/安装/行为/保活不受影响 |

---

## 十四、风险与边界（诚实声明）

1. **MVP 无离线签名**：目录仓库被攻破可投恶意包。缓解链：sha256 + origin 白名单 + `plugin.install` 强确认 + 高危权限继续强提示 + 目录校验丢弃。P5 必须升级 ed25519 验签。
2. **`market_fetch_raw` 是「目录内任意包可达宿主执行链」**：白名单只认 base 前缀，若目录仓库被攻破仍可投递。无签名前不建议放开第三方大量上架，起步维持策展 + 少量插件。
3. **内置引导「复用文件安装管线」**：需要 `install.ts` 的绝对路径/字节入口，注意与「从文件安装」的浏览对话框路径去重（同一函数，两个触发源）。
4. **目录版本与应用版本节奏不同**：内置插件走市场更新后 `source` 变为 `market`，应用升级不再覆盖它（见 §6.3）；`minAppVersion` 兜底防不兼容。
5. **设置窗 `settingsPanel` 宿主渲染本轮不做**：市场入口在搜索窗 `detailView`；`settingsPanel` 字段保留，P5 再实现宿主渲染（届时零清单变更）。
6. **端到端测试需要本机 Chrome/Edge**（既有约定，不可用时按既有规则跳过）。
7. **打包内置资源会使安装包体积上升**：三个插件合计约几百 KB（pi-agent 大项只是 UI + 小后端，重依赖走本地 `pi`），可接受；CI 产物校验体积阈值，超出告警。

---

## 十五、验收清单（Done 的定义）

- [ ] 三个内置插件随应用资源分发，冷启动自动装上（`plugins/` 可见，来源「内置」）；
- [ ] 任一内置插件可卸载；应用升级后**不复活**；「恢复内置」可重新安装；
- [ ] `plugin.install` 权限存在、高风险、网关镜像；
- [ ] `market_fetch_raw` 白名单放行/拒绝有 Rust 测试；
- [ ] 市场插件打开 → 目录可拉 → 搜索/分类/已安装/更新四段可用；
- [ ] 安装（含权限弹窗）、更新（含新权限复确认）、卸载全流程端到端测试通过；
- [ ] `updateAvailable` 在「插件」面板出现更新角标并可一键更新；
- [ ] `cargo test` + `npm run typecheck` + `node test/*.test.mjs` 全绿；端到端 UI 测试在装有浏览器的环境通过。