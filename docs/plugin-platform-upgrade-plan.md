# 插件平台改造方案

> 目标：在不扩大攻击面的前提下，把插件平台从「消费型 API + 手滑防护」升级为「贡献型 API + 可解释授权 + 可验证供应链」。
> 依据：`docs/plugin-api-comparison-ztools.md` 的对照结论 + 本轮对源码的二次核对。
> 状态：**已实施（2026-11-21）**。P0 四项、P1 五项、P2-3/P2-4/P2-5/P2-6 均已落地并通过单测 / `typecheck` / `cargo check`；实施记录见第 9 节。本文保留原始方案与决策上下文，未改写的段落仍是「为什么这么做」的依据。

---

## 0. 核对后的三条修正（比上一版评审更准）

1. **不是"缺 API"，而是"契约已声明、实现没接线"**——这是最划算的一类改造：
   - `ms.system.getSecret` 已存在（`ui-data-api.ts:769`，权限 `secret.read:<name>`），但 `ctx.getSecret` **从未被注入**（`usePluginHost.ts:588-673` 没有这个键），永远返回 `null`；
   - `secret.read` 已在权限目录里（`permissions.ts:245`，文案"读取系统钥匙串里的密钥"），Rust 侧 **DPAPI 凭据库已实现**（`credential_store.rs`），但只服务云同步，没对插件开放；
   - `ui.command` 已在权限目录里（`permissions.ts:89`），`listCommands()` 已实现（`manifest.ts:1168`），但**全仓无人调用**——`contributes.command` 目前是"能声明、不生效"。
2. **自动更新的问题不是"没做校验"，而是"契约与测试把静默扩权写死了"**：`auto-update.ts:167-184` 直接 `grants: allPerms` 并清掉历史 `denied`；`test/plugin-auto-update.test.mjs:15-16` 把这条行为当成契约断言。改它必须**同步改测试**，否则红。
3. **签名不是从零开始**：`scripts/sign-manifest.mjs` 已有 ed25519 骨架，注释写着"P5 启用"。P5 是"接上验签"，不是"设计签名体系"。

> 结论：本轮改造的主线是**把已经承诺的东西兑现**，其次才是新增贡献型能力。这样每一步都有现成的落点、测试和文案，风险最低。

---

## 1. 设计原则（用来否决方案，不是用来装饰）

| # | 原则 | 具体含义（可执行的判据） |
|---|---|---|
| P1 | **声明式优先** | 任何"插件给宿主加东西"的能力，必须先有 `contributes.*` 声明（可审核、可展示、可校验），运行时注册只是"激活声明"，不能凭空创造入口 |
| P2 | **识别失败即拒绝** | 身份在 `createHostApi(pluginId, …)` 构造期绑定；任何"取不到记录/取不到权限"的分支一律 fail-closed（ZTools 的 `requireInternalPlugin` 是反面教材） |
| P3 | **宿主永不因插件而慢/崩** | 插件参与宿主主流程（搜索、渲染）时必须有：并发上限、单插件超时、总预算、条数上限、异常静默降级 |
| P4 | **权限是能力串，不是通道名** | 用户看到的永远是 `clipboard.read` / `net.fetch:https://api.x.com/*` 这种能读懂的东西，绝不出现 IPC 通道名 |
| P5 | **单一真相源** | 命令/结果/权限的生效依据只有注册表 + 清单；运行时注册必须落盘并广播 `plugin://registry-changed`，不允许出现"内存里有一套、磁盘上另一套" |
| P6 | **双端校验** | 前端 `isGranted` 只是第一道；凡落地到 Rust 的能力（文件、网络、进程、密钥）必须在 Rust 侧再判一次 |
| P7 | **契约即测试** | 每条新契约都要有纯 Node 单测（沿用 `test/*.test.mjs` 风格）+ 至少一个真实插件的 e2e；改旧契约必须同改旧测试 |
| P8 | **不追 API 数量** | 模拟键鼠、shell、浏览器自动化、支付一律不做，除非出现明确插件场景；每开一个 `critical` 能力都要配权限 + 审计 + 撤销文案 |

---

## 2. 目标 API 形态（改造后的 `ms.*` 全景）

```
ms.plugin      info / granted / has
ms.permissions request(apis, reason) / status()            ← 新增（P1）
ms.lifecycle   onShow / onHide / onEnter / onDispose        ← 新增（P0）
ms.results     provide(handler) / revoke()                  ← 新增（P0，贡献型）
ms.commands    register / unregister / list                 ← 新增（P0，兑现 ui.command）
ms.search      data / query / trigger / setInput / focusInput / closeView / score
ms.ui          toast / confirm / setHeight / openWindow / theme / registerThemeProvider
               + subInput(set/remove/focus)                 ← 新增（P1）
ms.input       attachments / pickFolders / pickFiles / saveFile / readFile / listFolder / open / reveal …
ms.store       get/set/remove/keys/readJson/writeJson/removeJson
               + collection(name).add/update/remove/list    ← 新增（P1）
               + sync.*
ms.env         pick / …
ms.system      openExternal / readClipboard / writeClipboard / getSelectedText
               + getSecret（兑现）/ setSecret / deleteSecret ← P1
               + pasteBack(text|image)                      ← P2（新权限 system.paste）
ms.net         fetch（scope 鉴权）+ credentials（P2，凭据不出 Rust）
ms.screenshot  capture / overlay / crop / pickRegion / copy / save / saveAs / list / readShot / remove / prune / onSaved
ms.clipboard   list / readImage / copy / writeText / remove / clear / setRetained / onUpdated
ms.gesture     … / onRecord
ms.shortcuts   get / set / onAction
ms.backend     call / status / onNotification / onBackendChanged
ms.market      catalog / install / update
ms.log         info / warn / error
```

**形态上的三条硬约束**
- 所有新增方法都走 `defineRpcNamespace`（表驱动），不允许手写 `call({...})` 样板；
- 所有事件订阅都走 `event-hub.ts` 的引用计数 hub，并接入 `disposePluginHostSession`（零泄漏是既有契约，有单测）；
- 所有"贡献型"注册（results/commands/providers）都返回**退订函数**，且插件被禁用/卸载时由宿主统一回收。

---

## 3. 分期改造

### P0 — 兑现承诺 + 打开贡献型入口（1–2 个迭代）

#### P0-1 生命周期与进入参数

**问题**：保活插件再次打开时没有任何事件（`decideViewRestore` 返回 `restore` 就不重跑脚本），插件只能轮询；也不知道"用户是从搜索/热键/附件/子关键词哪条路进来的"。

**设计**
- `runPluginEntry` 的注入参数增加第 11 个 `action`（保持既有 10 个参数顺序不变，纯追加，老插件零改动）：
  ```ts
  type PluginEnterAction = {
    type: "text" | "files" | "folders" | "subKeyword" | "shortcut" | "command" | "result";
    code: string;          // 命中的 searchItem.keyword / command.id / shortcut.action
    keyword: string;       // 父关键词
    payload: unknown;      // 子词文本 / 附件列表 / 结果项快照
    from: "search" | "hotkey" | "attachment" | "subsearch" | "restore";
    at: number;
  };
  ```
- 新增 `ms.lifecycle`：`onShow(fn)` / `onHide(fn)` / `onEnter(fn)` / `onDispose(fn)`，全部返回退订函数。
- 触发点**复用现有收口**，不新增状态机：
  - `usePluginViewHost.ts:305/574`（`sessionActive = true`）→ `onShow` + `onEnter`；
  - `:432`（`decideViewClose` → `park`）→ `onHide`；`unmount` → `onDispose`；
  - `:560`（`decideViewRestore` → `restore`）→ `onShow` + `onEnter(from:"restore")`。
- 权限：`ui.inlay`（与视图同生命周期，不新增授权负担）。

**落点**：`host/ui-data-api.ts`（新增命名空间）、`host/event-hub.ts`（新增 `lifecycleHub`，纯内存型，不需要 Tauri listen）、`usePluginViewHost.ts`、`plugin-window.ts`（独立窗口同样注入）。

**验收**
- 保活插件第二次打开：`onShow` 恰好 1 次、`onEnter.from === "restore"`；
- `closeBehavior:"exit"` 的插件关闭时 `onDispose` 1 次，且 `activeSubscriptionCountForPlugin(id) === 0`；
- 老插件（不注册任何 lifecycle）行为逐字节不变（回归 `plugin-keepalive*.test.mjs`）。

**测试**：新增 `test/plugin-lifecycle.test.mjs`（纯函数 + 注入桩）；扩 `plugin-keepalive.test.mjs` 断言事件次数。

---

#### P0-2 搜索期结果提供者（`ms.results.provide`）

**问题**：插件只能贡献静态条目，"搜索即出结果"必须先打开视图，交互多一步。这是与 ZTools `onMainPush` 差距最大的一项。

**设计（声明 + 激活 + 预算三件套）**
1. 清单新增贡献点：
   ```jsonc
   "contributes": {
     "resultProvider": {
       "trigger": "always" | "prefix" | "regex",   // always=每次搜索都问；prefix/regex=命中才问
       "match": "翻译 : ",                          // trigger != always 时必填
       "maxItems": 5,                               // 上限 10，超出截断
       "timeoutMs": 200                             // 上限 250
     }
   }
   ```
   校验进 `parsePluginManifest` + `describeManifestErrors`（中文文案，如"结果提供者的超时不能超过 250ms"）。
2. 运行时 `ms.results.provide(async (q) => items[])`，权限复用 **`search.write`**（不新增权限）；未声明 `contributes.resultProvider` 时调用直接报错（P1 原则）。
3. 宿主侧调度器 `src/lib/plugins/result-provider.ts`（新文件，纯函数 + 可注入时钟，便于单测）：
   - 输入 `{ keyword, attachments, mode }`，输出 `SearchItem[]`；
   - **并发上限 4**、**单插件超时 = min(声明, 250ms)**、**总预算 250ms**、**每插件 ≤10 条**、**全局 ≤20 条**；
   - 任一插件抛错/超时 → 跳过并写审计（`result:"error"`），**绝不影响其余结果**；
   - 结果项复用 `plugin-items.ts` 的合成规则（`subscribe: "插件：<name>"`、`_pluginId` 标记、**不写 `SEARCH_DATA_KEY` 缓存**）。
4. 接线点：`useSearchState.ts:217 doSearch()` 在 `engine.search()` 之后、`state.results` 赋值之前 `await` 调度器（带预算，最坏 +250ms）；`attachPluginItems()` 的"集合没变不重搜 / 详情视图不重搜"两条克制规则**保持不变**。
5. 冷启动策略：**不为了搜索去拉起插件视图**（这正是 ZTools `queryMainPush` 的性能坑）。未激活的 provider 本轮跳过，并在结果列表尾部给一条"启用 XX 以获得实时结果"的提示项（可选，默认关）。

**落点**：`manifest.ts`、`plugin-items.ts`、`host/ui-data-api.ts`、新增 `result-provider.ts`、`useSearchState.ts`、`usePluginHost.ts`（注册表 → provider 清单）。

**验收**
- 3 个 provider（1 个 50ms、1 个 300ms、1 个抛错）并发：总耗时 ≤ 260ms，结果只含第一个插件的条目，审计里有 1 条 timeout + 1 条 error；
- 搜索主流程 P95 增量 < 250ms（用 `test/` 里的计时桩断言）；
- 禁用插件后其 provider 立即失效（`registry-changed` 广播驱动）；
- 详情视图打开时不触发 provider（不打断用户）。

**测试**：新增 `test/plugin-result-provider.test.mjs`（超时/并发/降级/上限/竞态）；扩 `plugin-subsearch.test.mjs` 确认 PRO 模式不被污染。

---

#### P0-3 动态命令（兑现 `ui.command`）

**问题**：`contributes.command` 能声明但不生效；`ui.command` 权限是空转的。

**设计**
- `ms.commands.register({ id, prefix, title, desc })` / `unregister(id)` / `list()`，权限 `ui.command`（已存在，risk `low`）。
- **单一真相源**：注册写入 `PluginRecord.runtimeCommands`（新字段，与 `grants` 同级），`persist()` + `syncRegistryGateway()` + 广播 `plugin://registry-changed`；`buildPluginItems()` 合成时把 `runtimeCommands` 与清单 `command` 合并（同 id 以运行时为准）。
- 约束：单插件 ≤ 20 条；`prefix` 必须含 `" : "` 边界（沿用 `contributes.command.prefix.no_boundary` 告警）；与宿主保留前缀冲突时拒绝并给可读原因。
- 卸载/禁用即清空（`disposePluginHostSession` + `registry-changed` 双保险）。

**落点**：`registry.ts`（新字段 + 合并函数）、`plugin-items.ts`、`host/ui-data-api.ts`、`gateway.ts`（如需下发）、`PanelPlugins.vue`（展示"运行时命令"列表，可一键清除）。

**验收**：注册后 ≤1s 内搜索框可命中；卸载后消失；重启后仍在（落盘）；面板能看到并清除；`listCommands()` 终于有调用方。

**测试**：新增 `test/plugin-commands.test.mjs`；扩 `plugin-install.test.mjs` 断言卸载清理。

---

#### P0-4 自动更新分级（安全自查，必须做）

**问题**：`auto-update.ts:167-184` 无条件 `grants: allPerms` + 清 `denied`，等于"开了自动更新 = 永久授权未来任何权限"。

**设计**
- 新增纯函数 `classifyUpgradePermissions(prev, next)` → `{ silent: string[], blocked: string[] }`：
  - `blocked` = 新增的 `risk === "critical"`（如 `backend.spawn`、`gesture.exec`）**或** `scope === "*"`（如 `net.fetch:*`、`file.read:*`）；
  - 其余新增权限走 `silent`（保持现有体验）。
- `blocked.length > 0` 时：**不替换落盘**，只写 `updateAvailable` + `pendingUpgrade`（新字段，存包 sha256 与待确认权限），面板/呼出时提示"XX 有新版，新增了高危权限，需你确认"。
- 用户确认后走**既有安装确认弹窗**（`PermissionGroupBlock` + critical 逐条勾选），复用 `grantPermission` 链路。
- 同步修改 `test/plugin-auto-update.test.mjs:15-16` 的契约断言（这是**有意的契约变更**，要在 PR 描述里写明）。

**落点**：`auto-update.ts`、`registry.ts`、`permissions.ts`（导出 `isCriticalOrWildcard`）、`PanelPlugins.vue`、`PluginInstallDialog.vue`。

**验收**：新版新增 `backend.spawn` → 不静默安装、出现待确认；新增 `ui.notify` → 静默安装（回归旧体验）；用户拒绝后 `denied` 留痕且不再反复提示。

---

### P1 — 把生态门槛降下来（2–3 个迭代）

#### P1-1 权限申请闭环 `ms.permissions.request`

- 现状：`ctx.requestPermission` 已存在（`usePluginHost.ts:611`），但只是 `confirm("插件请求权限：\n<权限串>")` 的纯文本弹窗，且**没有插件侧入口**。
- 改造：
  - 新增 `ms.permissions.request(apis: string[], reason: string)`（无需权限即可调用——申请本身不是能力）；
  - 弹窗升级为复用安装确认的 `PermissionGroupBlock`（分组 + 风险徽标 + 撤销影响文案 + critical 逐条勾选），并显示插件给的 `reason`；
  - 申请落盘 `PluginRecord.permissionRequests[]`（`{ apis, reason, at, status: pending|granted|denied }`），面板新增"申请历史"页签；
  - 限流：同一插件同一权限 24h 内最多申请 3 次，超限直接返回 `denied` 并审计（防骚扰）；
  - 粒度**只用能力串**（P4 原则）。
- 落点：`host/ui-data-api.ts`、`host/core.ts`（`PluginHostContext.requestPermission` 扩签名）、`usePluginHost.ts`、`registry.ts`、`PanelPlugins.vue`。
- 验收：申请→批准→`grants` 落盘→网关同步→原调用重试成功；拒绝→`denied` 留痕→24h 内不再弹；面板可见历史。
- 测试：新增 `test/plugin-permission-request.test.mjs`；扩 `market-install-confirm.test.mjs` 复用同一展示组件的断言。

#### P1-2 密钥能力兑现（`secret.read` + DPAPI）

- 现状：`ms.system.getSecret` 永远 `null`；`credential_store.rs` 的 DPAPI 已实现但只服务云同步。
- 改造：
  - Rust 新增 `plugin_secret_get/set/delete`（按 `plugin_id` 命名空间隔离，复用 `credential_store` 的加解密），并在 `plugin_host.rs` 的网关里校验 `secret.read:<name>` / `secret.write:<name>`；
  - 前端注入 `ctx.getSecret`，新增 `ms.system.setSecret/deleteSecret`（新权限 `secret.write`，risk `high`，撤销文案"删除后插件需重新录入"）；
  - **密钥永不出现在 localStorage**；`ms.env.pick` 的"环境变量授权"与密钥体系并列存在，文档写清两者区别（env 进子进程环境，secret 只在调用时返回）。
- 验收：写入→重启→读取一致；卸载插件→密钥目录清除；未授权读取→Rust 侧拒绝（前端绕过也无效）。
- 测试：新增 `test/plugin-secret.test.mjs`（前端桩）+ Rust 单测（命名空间隔离 / 权限拒绝）。

#### P1-3 类型包 + Schema + 脚手架

- 新增 `packages/plugin-types/`：`ms.d.ts`（从 JSDoc 生成）、`plugin.schema.json`（**与 `parsePluginManifest` 同源**，用一份 JSON Schema 驱动校验，避免"文档/校验/schema 三份真相"）、`README`。
- 清单里支持 `"$schema": "https://.../plugin.schema.json"`，编辑器即时补全（ZTools 最值得抄的 DX 点）。
- 新增 `scripts/create-plugin.mjs`：`node scripts/create-plugin.mjs my-plugin` → 生成 `plugin.json + ui/detail.html + ui/index.js + meta.json`，3 条命令跑通。
- 文档：`docs/plugin-api-versioning.md`（`apiVersion` v1→v2 兼容矩阵 + 弃用策略：新增可选字段不升版、改语义必须升版 + 至少两个小版本的兼容期）。
- 验收：`npm run typecheck` 覆盖 types 包；schema 与运行时校验对同一批"坏清单"给出一致结论（用现有 `describeManifestErrors` 的用例集做交叉测试）。

#### P1-4 `ms.store.collection`（集合语义）

- 现状：只有键值，列表型数据要整数组序列化（写放大 + 并发覆盖）。
- 改造：`ms.store.collection(name)` → `add / update / remove / get / list({ prefix, limit, cursor })`，底层仍落 `plugin-data/<id>/kv/<name>/*.json`（逐条一文件），复用 `readJson/writeJson` 的配额与备份声明（`backup.itemized` 天然适配）。
- 不抄 ZTools 的整套 `db`（LMDB + 附件 + 同步 IPC），只做"逐条读写 + 游标"，成本低一个量级。
- 验收：1000 条列表的增删改不触发全量写；`backup.itemized` 能按条备份/还原；配额超限给可读错误。

#### P1-5 宿主子输入框 `ms.ui.subInput`

- `set({ placeholder, value, focus, onChange })` / `remove()` / `focus()`，权限 `ui.inlay`。
- 宿主渲染在插件容器**上方**（与搜索框同一套键盘/焦点/高度联动），插件不再各画各的 input。
- 与 `ms.search.setInput` 的区别写进文档：subInput 是"插件内的二级输入"，setInput 是"改宿主主搜索框"。
- 验收：Esc/Tab/上下键行为与宿主一致；插件卸载即移除；`setHeight` 与 subInput 高度联动不打架。

---

### P2 — 按真实需求开，不提前背攻击面

| 项 | 内容 | 前置条件 |
|---|---|---|
| P2-1 | `ms.system.pasteBack(text\|image)`，新权限 `system.paste`（risk high，撤销文案"将内容写回你当前正在使用的应用"） | 有翻译/剪贴板类插件明确提出闭环需求 |
| P2-2 | `contributes.providers` + `ms.providers.register`（先 `translation`，后 `ocr`），新权限 `provider.translate` / `provider.ocr`；宿主设置页聚合 + 默认 provider | P0-2 的调度器与超时机制已稳定（直接复用） |
| P2-3 | `ms.net.credentials`：凭据只存 Rust，请求时由代理注入，插件永远拿不到明文 | P1-2 密钥体系落地 |
| P2-4 | 隔离窗口形态：`ui.window` 升级为独立 WebView + 严格 `postMessage` 协议，作为"需要强隔离插件"的推荐形态 | 明确"哪些插件必须强隔离"的判据（例如申请 `file.read:*`） |
| P2-5 | 敏感值下沉：GitHub Token / WebDAV 密码 / env 值从 localStorage 迁到 `credential_store`，前端只拿句柄 | P1-2 + P2-3 |
| P2-6 | 签名启用（P5）：`sign-manifest.mjs` 接上 ed25519 验签，市场索引对 sha256 签名，客户端验签后 `integrity.signed = true` | 密钥管理流程确定（谁持有私钥、如何轮换） |
| P2-7 | backend 资源约束：`resources: { maxMemoryMB, maxCpuPercent }` + 崩溃 N 次自动禁用提示 | 有插件出现资源失控的真实案例 |
| P2-8 | MCP tools（`ms.tools.register`），**每工具一条权限** + 调用审计 | 真有外部 AI 客户端接入需求 |

---

## 4. 明确不做（写进方案，防止以后被"对齐 ZTools"带跑）

- ❌ 模拟键鼠 / 任意 shell / 浏览器自动化（ubrowser）/ 支付：每一项都是 `critical` 级攻击面，且我们的 `backend` + `gesture` 已覆盖大部分真实场景。
- ❌ 把 `internal` 式管理面开放给第三方插件（ZTools 的 208 个 internal 方法是"设置页私有契约"，不是公共 API）。
- ❌ 同步 IPC 风格的业务 API（`sendSync`）：我们保持"本地同步 JS + 跨进程 `invoke`"。
- ❌ 会话级 preload / 多窗口共享身份：坚持"构造期绑定 pluginId"。
- ❌ 为了搜索去拉起插件视图（ZTools `queryMainPush` 的性能坑）。

---

## 5. 里程碑与工作量（粗估，供排期）

| 里程碑 | 内容 | 估时 | 退出条件 |
|---|---|---|---|
| M1 | P0-1 生命周期 + P0-4 自动更新分级 | 3–4 天 | 新单测全绿；`plugin-keepalive*` / `plugin-auto-update` 回归通过（含契约变更说明） |
| M2 | P0-2 结果提供者 + P0-3 动态命令 | 5–7 天 | 搜索 P95 增量 < 250ms；`file-search` 或 `baidu-translate` 改造成 provider 并跑通 e2e |
| M3 | P1-1 权限申请 + P1-2 密钥兑现 | 4–6 天 | 申请闭环 e2e；Rust 侧权限拒绝单测；卸载清密钥 |
| M4 | P1-3 类型包/脚手架 + P1-4 集合 + P1-5 subInput | 5–7 天 | 新作者 3 条命令跑通；schema 与运行时校验交叉一致 |
| M5 | P2 按需 | — | 每项都要先有"真实插件需求"作为立项依据 |

**每个里程碑的固定动作**：`npm run typecheck` → 相关 `test/*.test.mjs` → 一个真实插件 e2e → 更新 `docs/plugin-market-publish.md` 与 README 的 `ms.*` 章节 → 在 `docs/plugin-api-versioning.md` 登记变更。

---

## 6. 风险与回滚

| 风险 | 触发点 | 缓解 | 回滚 |
|---|---|---|---|
| 搜索变慢 | P0-2 provider 超时/并发失控 | 总预算 250ms 硬上限 + 单插件超时 + 并发 4；调度器纯函数可单测 | 清单级开关 `contributes.resultProvider` 不声明即完全不参与；宿主侧再加一个全局 kill switch（设置项，默认开） |
| 老插件行为变化 | P0-1 注入参数追加 | 只追加第 11 个参数，前 10 个顺序/语义不变；lifecycle 不注册即无副作用 | 参数追加可单独 revert，不影响其余 |
| 自动更新体验倒退 | P0-4 分级后高危更新要确认 | 只阻断 critical/`*`，其余仍静默；面板给"一键确认"入口 | 分级函数是纯函数，可配置阈值回退到旧行为（但**不建议**） |
| 命令表双真相源 | P0-3 运行时命令 | 强制落盘 + 广播；面板可见可清 | `runtimeCommands` 字段可整体忽略（合成时不合并即回到旧行为） |
| 密钥迁移丢数据 | P2-5 | 迁移只读旧值→写新库→校验→再删旧值；失败保留旧值 | 迁移脚本幂等，可重跑 |
| 契约测试红 | P0-4 改旧断言 | PR 里显式标注"有意契约变更"，同步改测试与文档 | — |

---

## 7. 决策点（已按实施结果落定）

1. **结果提供者的默认开关**：已落为「清单声明 `contributes.resultProvider` 才参与」——未声明零开销，声明后受 250ms 总预算 / 单插件超时 / 全局 20 条硬上限约束。比全局开关更符合「声明式优先」。
2. **自动更新分级的阈值**：已落为「新增 `critical` 权限或 `scope:"*"` 才阻断」，其余新增权限仍静默授予；阻断时只登记 `pendingUpgrade` + 更新角标，不落盘。
3. **类型包发布形态**：已落为仓库内 `packages/plugin-types/`（`ms.d.ts` + 生成的 `plugin.schema.json`），暂不发 npm；插件用相对 `$schema` / `/// <reference>` 引用。
4. **P2 立项门槛**：已写进本文第 4 节与 `docs/plugin-api-versioning.md`；没有真实插件需求不开新 `critical` 能力。本轮 P2-1/P2-2/P2-7/P2-8 均未开。

---

## 8. 一句话总结

> 这轮改造不是"把 API 追到 300 个"，而是**把已经写进权限目录和清单校验里的承诺兑现**（`ui.command`、`secret.read`、`getSecret`），**把插件从"只能用宿主"变成"能给宿主加东西"**（results / commands / providers），**把授权从"失败才弹窗"变成"能解释、能审批、能追溯"**，最后**把供应链从 sha256 升级到验签**。
> 每一步都有现成落点、现成测试风格、现成文案体系——这是"更优雅"的来源；每一步都带预算、超时、fail-closed 和双端校验——这是"更强"的来源。

---

## 9. 实施记录（2026-11-21）

| 项 | 落地形态 | 关键文件 | 测试 |
|---|---|---|---|
| P0-1 | `action` 作为第 11 个注入参数；`ms.lifecycle.onShow/onHide/onEnter/onDispose/current`；恢复/停靠/释放分别派发 show/hide/dispose | `host/event-hub.ts`、`host/ui-data-api.ts`、`windows/search/usePluginViewHost.ts` | `plugin-lifecycle` 4 项；keepalive 51 / behavior 70 / subsearch 20 / ui 46 回归 |
| P0-2 | `contributes.resultProvider` + `ms.results.provide/clear/active/limits`；触发式 prefix/regex、并发 4、总预算 250ms、单插件 1–10 条、全局 20 条 | `result-provider.ts`、`useSearchState.ts`、`usePluginHost.ts` | `plugin-result-provider` 6 项 |
| P0-3 | `ms.commands.register/unregister/list/limits`；运行时命令落注册表（单插件 ≤20），与清单命令按 id 合并 | `registry.ts`、`plugin-items.ts` | `plugin-commands` 5 项 |
| P0-4 | 新增 `critical` 或 `scope:"*"` 的自动更新只登记 `pendingUpgrade`，不落盘、不授予；面板显示「待确认 + 高危权限」 | `auto-update.ts`、`registry.ts`、`PanelPlugins.vue` | `plugin-auto-update` 5 项（含有意契约变更） |
| P1-1 | `ms.permissions.request/history/limits`；24h 内非授予记录 ≤3 次、单次 ≤8 项、只申请清单已声明但未授予的权限；面板显示申请历史 | `permission-requests.ts`、`usePluginHost.ts` | `plugin-permission-request` 5 项 |
| P1-2 | `secret.read/write:<name>`；Rust `plugin-secrets/<id>.json`（Windows DPAPI）；`ctx.getSecret` 从此真正注入 | `credential_store.rs`、`plugin_host.rs`、`core.ts` | `plugin-secrets` 5 项；`cargo check` |
| P1-3 | `npm run plugin:schema` 生成 JSON Schema（`--check` 防漂移）；`npm run plugin:new` 脚手架；`packages/plugin-types/` 类型包；API 版本演进文档 | `scripts/gen-plugin-schema.mjs`、`scripts/create-plugin.mjs`、`packages/plugin-types/`、`docs/plugin-api-versioning.md` | `plugin-types` 6 项 |
| P1-4 | `ms.store.collection(name)`：逐条 JSON、`add/update/set/get/remove/list(cursor)/clear`、单集合 ≤1000 条 | `plugin_host.rs`、`ui-data-api.ts` | `plugin-collections` 6 项 |
| P1-5 | `ms.ui.subInput.set/remove/focus`；宿主在插件视图上方渲染，键盘事件不外泄；复用 `ui.inlay` | `usePluginViewHost.ts`、`style.css` | `plugin-subinput` 4 项 |
| P2-3 | 凭据值只进 Rust；`ms.net.credentials.set/list/remove` 只回元数据；`ms.net.fetch({credential})` 由 Rust 按 origin 注入 | `credential_store.rs`、`plugin_host.rs`、`net-api.ts` | `plugin-credentials` 6 项 |
| P2-4 | 独立窗口默认 `sandbox="allow-scripts allow-modals allow-downloads"` iframe，**不含 `allow-same-origin` / `allow-forms`**（后者可绕过 `net.fetch` scope 直接向任意站点 POST）；`ms` 经 `postMessage` 白名单代理；宿主主题变量显式注入；`mode=legacy` 回退旧同上下文形态 | `window-bridge.ts`、`plugin-window.ts`、`plugin_host.rs` | `plugin-window-isolation` 7 项；`plugin-ui` 真实浏览器 46 项（含父窗口读不到 iframe 文档、store 生命周期经桥生效） |
| P2-5 | 环境变量值迁到 Rust `host-env.json`（DPAPI）；前端只在内存持有；旧 localStorage 一次性迁移后删除；`plugin-gateway.json` 整份密封，避免快照里的注入值明文落盘 | `credential_store.rs`、`env-store.ts`、`plugin_host.rs` | `plugin-credentials` 6 项；`env-store` 79 项回归；Rust `sealed_file_roundtrip` |
| P2-6 | ed25519 签**市场索引**；签名覆盖除 `integrity` 外的整个目录对象（键排序后序列化）；客户端 fail-closed；发布脚本拒绝未签名索引 | `index-signature.ts`、`build-index.mjs`、`publish-market.mjs`、`gen-market-key.mjs` | `plugin-index-signature` 5 项；`market-offline-carry` 12 项 |

**隔离窗口的取舍（需要作者知道）**：隔离模式只开放「请求-响应」型 API 白名单（`search.*` / `ui.toast` / `store.*` / `net.*` / `backend.*` / `secret.*` 等），不提供回调型 API（`ui.onThemeChanged`、`shortcuts.onAction`、`results.provide`）与 `ui.openWindow`。依赖这些能力的插件应继续使用内嵌视图；独立窗口需要回调时走 `mode=legacy` 并接受「插件与宿主同上下文」的信任模型。

**仍待办（非本轮代码缺陷）**：
- 市场已发布的旧索引目前无签名，新版客户端 fail-closed；**上线前必须先发布一份用 `market-2026-01` 签名的索引**，否则市场链路会整体拒绝。生产私钥应改由 CI secret 注入，本地 `.secrets/` 只用于开发。
- `ms.d.ts` 已补本轮新增的 `net.credentials` / `openWindow({isolated})` / lifecycle / commands / results 等，但尚未对**全部历史 API** 做逐项类型与运行时对齐审计。
- P2-1（pasteBack）、P2-2（providers）、P2-7（backend 资源约束）、P2-8（MCP）按「无真实插件需求不开」原则**未实施**。
- `scripts/sign-manifest.mjs` 已改为废弃提示并指向 `gen-market-key.mjs` / `build-index.mjs`（签名对象是索引，不是单插件清单）。
