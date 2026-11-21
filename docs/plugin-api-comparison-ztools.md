# 插件 API 对照评审：ZTools（Electron）vs 我的搜索（Tauri）

> 目的：拿 ZTools（uTools 的开源实现）当镜子，逐项对照"主体软件给插件的 API"，判断哪些设计值得学、哪些是坑、我们自己哪里还欠。
> 依据：`D:\data\users\zhuangjie\Downloads\ZTools-main`（ZTools main 分支）与本仓库当前代码。所有结论都可在文末「证据索引」里按 `文件:行` 复核。
> 状态：文中 P0 / P1 / P2-3 / P2-4 / P2-5 / P2-6 已于 2026-11-21 落地；第 7 节清单已勾选，逐项实施记录见 `docs/plugin-platform-upgrade-plan.md` 第 9 节。

---

## 0. 先看结论

1. **两者是同一物种**：搜索启动器 + 插件平台 + 插件市场。差别不在功能清单，而在**信任模型**——ZTools 把插件当"可信本机程序"（插件 preload 有 Node 能力、无沙箱），我们把插件当"受限第三方"（只能过 `ms.*` 网关）。
2. **ZTools 的 API 更宽**：≈105 个顶层成员，覆盖模拟输入、屏幕/多显示器、shell、文件拖拽、浏览器窗口、ubrowser、ffmpeg、AI/OCR/翻译、支付、MCP。**我们的 API 更窄但更"有账可查"**：≈90 个方法，全部带权限声明 + 审计。
3. **最值得抄的不是数量，是三个"闭环"**：① 搜索期结果提供者（`onMainPush`）；② 进入参数对象 + `onPluginOut/onPluginDetach` 生命周期；③ 插件主动申请权限（带理由）→ 当场弹窗审批 → 按通道授权。
4. **最不能抄的是它的身份识别**：`requireInternalPlugin()` 在"识别不到调用方"时**放行**（fail-open），再叠加"session 级 preload 注入所有子窗口"，是一套典型的方便优先、安全靠自觉的实现。
5. **我们真正的短板不在 API 数量，而在四个具体位置**：搜索期无法贡献结果、没有 `onShow/onHide` 类事件（保活语义下插件不知道"我又被打开了"）、没有类型包/脚手架、自动更新会**静默授予新权限**（`auto-update.ts` 自己写明了）。
6. **我们的权限模型是"API 边界"不是"进程边界"**：inlay 形态下插件脚本与宿主同 window，恶意插件可绕过 `ms.*` 直接读宿主 localStorage（README 已诚实承认）。这条不解决，"Android 式权限"的说服力就只到"防手滑"，防不了"防恶意"。
7. **供应链上我们明显更好**：`.mspp` 有清单校验、路径穿越双校验、staging→原子替换、SHA-256 校验、安装确认分组展示；ZTools 未见包哈希/签名校验（以当前代码为据）。
8. **一句话取舍**：ZTools 用"能力全给 + 信任人"换生态繁荣；我们用"能力白名单 + 权限账本"换可控。下一步应该**在保持白名单的前提下，把"插件能给宿主加能力"这条路打开**（结果/命令/provider），而不是去追它的 API 数量。

---

## 1. 共同点（先说同，再说异）

| 维度 | 两者一致的地方 |
|---|---|
| 产品形态 | 全局热键呼出 → 搜索框 → 结果列表 → 选中后进入插件视图 |
| 插件定义 | 一个目录 + `plugin.json` 清单 + 入口 HTML/JS（ZTools 另有插件自己的 `preload`） |
| 插件视图 | 宿主内嵌展示，支持"再打开是恢复"的缓存语义（ZTools 缓存 WebContentsView；我们缓存 DOM 会话） |
| 结果项 | 插件声明的条目与普通数据项同列渲染、同一套键盘导航 |
| 分发 | 插件市场（远端索引）+ 本地安装包 + 开发目录挂载/热重载 |
| 宿主能力 | 剪贴板、截图、窗口、通知、存储、快捷键、网络、AI（ZTools 有）、同步（我们有） |
| 开发者支持 | 清单校验、热重载、日志、文档 |

差异的根：**ZTools 的插件是"页面 + preload"，我们的插件是"注入宿主 window 的脚本 + 可选后台进程"**。这一条决定了后面几乎所有 API 形态的差别。

---

## 2. API 全景

| 项目 | ZTools | 我的搜索 |
|---|---|---|
| 门面 | 单一全局对象 `window.ztools`（uTools 兼容命名） | `ms.<命名空间>.<方法>`，17 个命名空间 |
| 规模 | 顶层 ≈105 个成员；另有 `ztools.internal` ≈208 个方法（主要服务"设置"这个内置插件） | ≈90 个方法（含事件订阅、快捷读写） |
| 调用协议 | 全部走 `plugin.api` 单通道：`sendSync`（同步）/ `invoke`（异步）/ `send`（单向） | 直接 JS 函数调用；需要落地的走 `invoke` 到 Rust（表驱动 `defineRpcNamespace`） |
| 方法元数据 | 无（靠 JSDoc + 外部 types 包） | 每个方法声明 `{ permission, detail, handler }`，自动接入"启用态→权限→审计" |
| 事件 | `onPluginEnter/Out/Detach/Ready/MainPush/ThemeChange/HotkeyRecorded/FindInPageResult/ClipboardChange`… | `onSubKeyword`、`onThemeChanged`、`onAction`、`onUpdated`、`onSaved`、`onRecord`、`onNotification`、`onBackendChanged` |
| 权限 | 只覆盖 `internal` 通道（按通道 grants + 完全授权名单 + 停用名单） | 覆盖全部能力（6 组 / 4 风险等级 / scope / 前端-后端-双端 / 撤销影响文案） |
| 后台进程 | 无此概念（页面常驻 + `backgroundThrottling:false`） | 有：stdio JSON-RPC + 进程树 + 空闲回收 + 崩溃退避 + 日志 |
| 类型 | `ztools-api-types`（TS 类型 + `plugin.json` JSON Schema） | 无独立类型包（JSDoc + 两份发布文档） |
| 安装包 | `.zpx`（gzip/brotli 压缩的 ASAR）/ zip；未见哈希/签名校验 | `.mspp`（ZIP）+ 清单校验 + SHA-256 + 原子替换 + 权限确认 |

> 数量对比要注意口径：ZTools 的 208 个 `internal` 方法里有大量"设置页专用"（改主题、改壁纸、账号、同步、市场管理…），因为它把设置界面做成了一个内置插件。这不是"给所有插件的能力"，而是"给可信插件的管理面"。比数量不如比**公共 API 的覆盖面**——两边量级相当，但侧重完全不同。

---

## 3. 逐项对照："对应好坏"

### 3.1 契约形态：单对象 vs 命名空间 + 表驱动

**ZTools**
- `window.ztools = { ... }` 一个大对象，105 个成员平铺；`ztools.internal` 再挂 208 个。
- 同步调用用 `ipcRenderer.sendSync`（阻塞渲染进程直到主进程返回），异步用 `invoke`，单向用 `send`；三者共用一个 `plugin.api` 通道和一个 `pluginApiServices` 分发表（`pluginApiDispatcher.ts`）。
- 错误处理：同步 handler 抛错时兜底写 `event.returnValue = Error`；preload 侧再 `throw` 出来。

**我们**
- `createHostApi(pluginId, ctx)` 组装对象：`search / ui / input / store / env / sync / system / net / screenshot / clipboard / gesture / shortcuts / backend / market / plugin / log`。
- 每个方法在表里声明权限与审计摘要，`defineRpcNamespace()` 统一生成，写法是"数据"而不是"样板代码"。

**判语**
- 我们更好：结构可读、权限是**结构的一部分**（漏写权限在类型上就会显现），新增能力只加一行表项。
- ZTools 更好：对第三方开发者"零学习成本"——uTools 插件几乎原样迁移；单对象也方便 `console.log(ztools)` 自解释。
- ZTools 的**同步 IPC** 是明显的坏设计：`copyText/getPath/getFileIcon/getFeatures` 这类调用会卡住渲染线程；在插件里写循环就是灾难。我们全部是 JS 调用（本地同步）+ 需要跨进程的走 `invoke`，没有这个坑。

**可借鉴**：把 `ms` 的命名空间在类型层面冻结成 `Readonly`，并提供 `ms.$describe()` 之类的自省（返回方法 + 所需权限），让插件开发者能在控制台一眼看清"我能调什么、要什么权限"。

---

### 3.2 触发与声明：`features[].cmds` vs `contributes.*`

**ZTools**
- `plugin.json.features[]`：每个 feature 一个 `code`，`cmds` 支持 `string` 或 `{ type: text | regex | over | img | files | window }`。
- 匹配器族完整：中文拼音、拼音首字母、英文首字母、混输（`core/commands/matching/*`），加上正则、选中文本（over）、图片、文件、前台窗口五类上下文匹配器（`contextMatcherRegistry.ts`）。
- **可以运行时增删命令**：`ztools.setFeature / removeFeature / getFeatures`（`feature.ts`，存 LMDB，3 秒防抖后刷新命令缓存）。

**我们**
- `contributes.searchItem`（`keyword` + `subSearch`）、`contributes.command`（`"前缀 : "`）、`contributes.handlers`（files/folders，附件模式过滤）、`contributes.shortcut`（全局热键动作）、`detailView`、`settingsPanel`。
- 全部声明式、安装即生效；`subSearch` 是显式契约（不声明就不进"关键词 : 子词"候选）。

**判语**
- ZTools 更好：**触发面宽一个量级**。它能做"选中文本即翻译""拖入图片即识别""停在资源管理器窗口时给一个'在终端打开'"——这些是启动器的高价值场景；我们目前只能"输入关键词命中"。
- 我们更好：声明式、可审核、可单测；`subSearch` 这类"显式契约"避免了"注册了回调但用户看不到入口"的经典坑（ZTools 的 `onMainPush` 就有类似隐式约定）。
- ZTools 的动态命令是双刃剑：能力强，但"命令表"有两个真相源（清单 + LMDB），排查"为什么搜不到"会变难；我们的清单是唯一真相源，更容易保证一致性。

**建议**（按性价比）
1. 先补 **选中文本 / 文件（已有 handlers）/ 图片** 三类上下文触发（window 触发需要额外系统权限，放最后）。
2. 再补 **动态命令注册** `ms.commands.register()`（等价 `setFeature`），但要求写入注册表并广播 `plugin://registry-changed`，保持"单一真相源"。

---

### 3.3 搜索期贡献：`onMainPush`（ZTools 的杀手锏，我们的空白）

**ZTools**
- 插件在 preload 里 `ztools.onMainPush(callback, selectCallback)`；宿主搜索时向**已加载**的插件发 `main-push-query`（带 `{code,type,payload}` 与 `callId`），插件异步回 `main-push-result-<callId>`；结果直接进结果列表。
- 选中时发 `main-push-select`，插件的 `selectCallback` 返回 `true` 可要求"进入插件界面"。
- 实现见 `pluginManager.queryMainPush()`：会先 `preloadPlugin`，再等 `waitForPluginViewReady`，有超时兜底（拿不到就返回 `[]`）。

**我们**
- 插件只贡献**静态条目**（`buildPluginItems`），运行时只能用 `ms.search.score(item)` 影响排序、`ms.search.trigger()` 触发搜索、`ms.search.query()` 读结果。
- 想让"搜索即出结果"，只能先让用户打开插件视图 —— 交互上多一步。

**判语**
- ZTools 明显更好：`mainPush` 是"启动器生态"最有价值的一类 API（词典释义、目录浏览、命令补全、计算器、单位换算都靠它）。
- 但 ZTools 的实现有性能代价：每次查询都要确保插件页面就绪，冷启动/超时都会拖慢搜索；且要靠"插件已被预加载"这个隐含前提。
- 我们的架构反而更适合做这件事：插件可以在**后台进程**里算（不阻塞 UI），或用轻量 provider 注册；不需要为了搜索把整个 WebContentsView 拉起来。

**建议（P0）**
- 清单新增 `contributes.resultProvider`（声明式，进入审核与权限展示），运行时 `ms.results.provide(handler)` 注册。
- 宿主侧：并发查询、**总预算 150–250ms**、单插件超时即跳过、结果条数上限、错误静默降级（搜索永不因插件失败而失败）。
- 权限：复用 `search.write`（"提供搜索结果"），不新增授权负担。

---

### 3.4 生命周期与"进入参数"

**ZTools**
- `onPluginEnter({ code, type, payload, option, from })`——`from` 区分 main/panel/hotkey/redirect，`type` 是 text/over/regex/img/files/window，`payload` 是内容本身。
- `onPluginOut(isKill)`、`onPluginDetach()`、`onPluginReady()`；`onPluginEnter` 有**粘性缓存**：注册晚于事件也能补发最近一次（`pendingEnterPayload`）。
- 每个 feature 有独立 `code`，所以一个插件可以有多个"入口语义"。

**我们**
- 入口脚本注入 `ms / plugin / host / keyword / inputValue / onSubKeyword / env`；视图保活（`minimize`）时**不重跑脚本**，恢复即恢复。
- `ms.search.closeView()` 可主动关；但没有 `onShow / onHide / onEnter(action)`，也没有"我是从哪来的"（搜索/热键/附件/子关键词）。

**判语**
- ZTools 更好：进入参数是**一等公民**。这正是多入口插件的刚需（同一个插件，从热键来要"开始录屏"，从搜索来要"打开配置"）。
- 我们更好：保活语义更清晰（`closeBehavior` + `shouldKeepFrontendOnClose` 判定矩阵 + e2e 测试），ZTools 是"缓存 WebContentsView"这种更重、更难控的方案。
- 我们的缺口很实际：**保活插件再次被打开时没有任何事件**，想刷新数据只能靠轮询或让用户手动点。这是当前 `ms.*` 最该补的一块。

**建议（P0）**
- 注入 `action` 参数：`{ type: "text"|"files"|"subKeyword"|"shortcut"|"command", code, keyword, payload, from }`。
- 新增 `ms.lifecycle.onShow(fn) / onHide(fn) / onEnter(fn)`，在 `decideViewClose/decideViewRestore` 的同一条收口上触发（与现有 keepalive 判定复用，不新增状态）。

---

### 3.5 宿主 UI 原语：子输入框、高度、窗口、paste-back

| 能力 | ZTools | 我们 | 判语 |
|---|---|---|---|
| 子输入框 | `setSubInput(onChange, placeholder, isFocus)`、`removeSubInput`、`setSubInputValue`、`subInputFocus/Blur/Select` | 无；插件要自己画 input，或靠 `ms.search.setInput` | **ZTools 明显更好**：启动器里"二级输入"是核心交互，宿主提供能保证焦点/键盘/高度联动一致 |
| 调整高度 | `setExpendHeight(px)` | `ms.ui.setHeight(px)`（0–2000 夹紧） | 平手 |
| 独立窗口 | `createBrowserWindow(url, options, callback)`，返回 165 个 Electron 方法白名单（window 94 + webContents 71） | `ms.ui.openWindow({ entry, title, width, height, alwaysOnTop })`，入口限定在插件目录内，`ui.window` 权限 | **我们更安全**，ZTools 更灵活但把 Electron 内部面直接暴露给插件，语义/权限都失控 |
| 回填上一个应用 | `hideMainWindowPasteText/Image/File`、`hideMainWindowTypeString` | 无（宿主有 Alt+点击带入，但不在 `ms.*`） | **ZTools 更好**：翻译/剪贴板类插件"复制回原应用"是闭环的最后一步 |
| 通知 | `showNotification`（系统通知）+ `showToast` | `ms.ui.toast/confirm`（应用内） | 平手（场景不同） |
| 主题 | `getThemeInfo` + `onThemeChange` | `ms.ui.theme` + `onThemeChanged` + `registerThemeProvider` + `applyTheme` | **我们更好**（运行时 provider 优先级 + 面板可覆盖 + 清单默认值，三层很清楚） |

**建议**
- P1：`ms.search.setSubInput()`（或 `ms.ui.subInput`），把"二级输入框"变成宿主能力；这是插件作者最痛的一块（每个插件自己画输入框，键盘行为都不一致）。
- P2：`ms.system.pasteBack(text | image)`（权限 `system.paste`，单独授权 + 风险说明），只允许"写回前台应用"，不做任意自动化。

---

### 3.6 数据：`db`（文档库）vs `store`（KV + 云配额）

**ZTools**
- `ztools.db`：`put / get / remove / bulkDocs / allDocs / postAttachment / getAttachment / getAttachmentType`，另有 `db.promises` 包装；底层 LMDB，**按插件名做 key 前缀隔离**（`database.ts` 里 `getPluginDataPrefix`）。
- `ztools.dbStorage`：简单 KV（`setItem/getItem/removeItem`）。
- 剪贴板历史另有独立库与 API（`clipboard.getHistory/search/delete/clear/write/writeContent/updateConfig/onChange`）。

**我们**
- `ms.store`：`get/set/remove/keys`（localStorage 命名空间）+ `readJson/writeJson/removeJson`（`plugin-data/<id>/kv/*.json`，突破 5MB）。
- `ms.store.sync`：云 KV，**硬配额**（单键 64KB / 单插件 512KB / 合计 8MB / 500 键），写入即广播 `plugin-sync://changed` 自动安排上传。
- 备份范围可声明：`backup.pluginData`（true / 前缀数组 / false）、`blobs`、`itemized`（按条虚拟拆分，剪贴板是第一个使用者）。

**判语**
- ZTools 更好：`db` 更像"小型数据库"，批量写、附件、allDocs 前缀扫描都有，适合做"数据型插件"（收藏夹、笔记、字典）。
- 我们更好：**配额 + 备份声明 + 同步联动**这套"跨设备还原"语义，ZTools 没有等价物；而且我们的 `store.sync` 把"该上云的小状态"和"留在本机的大文件"分开了，这是正确的产品判断。
- 我们的短板：`store` 只有"键"没有"集合"——做列表型数据要自己序列化整个数组（写放大、并发覆盖）。

**建议**
- P1：给 `ms.store` 补集合语义（`collection(name).add/update/remove/list(prefix)`），底层仍落 `kv/*.json`，但提供逐条读写与游标；这比抄 ZTools 的整套 `db` 便宜得多。

---

### 3.7 网络与凭据

**ZTools**
- 插件页面直接 `fetch`（`webSecurity:false` + `allowRunningInsecureContent:true` + 每插件 session），没有域名白名单、没有审计。
- `ztools.http.setHeaders(headers)`：给**该插件 session 的所有 http(s) 请求**注入请求头（`webRequest.onBeforeSendHeaders` 拦截）。方便，但等于"插件可以把 token 带到任何域名上"。

**我们**
- 只有 `ms.net.fetch`：走 Rust 代理（绕 CORS），权限串是 `net.fetch:<scope>`，前端 `scopeAllows` + Rust `scope_allows` **双侧校验**；支持 `bodyBase64`、`responseType: "base64"`、`maxBytes`、`timeoutSecs`、`throwOnHttpError`。
- 插件拿不到裸 IPC，也就拿不到"绕过 scope 的 fetch"（浏览器调试分支除外，仅开发环境）。

**判语**
- 我们明显更好：这是第三方插件市场的前提条件。ZTools 的模型只适合"插件都是自己人"。
- ZTools 更好的一点：**零成本**。它的插件作者不需要理解 scope 语法；我们要求作者写 `"net.fetch:https://api.x.com/*"`，写错了就是运行时报错。这是可优化的 DX 点。
- 供应链细节：ZTools 的 `http` 头注入是"隐式凭据"，一旦插件被投毒，token 会被带到攻击者域名——这类设计不要学。

**建议**
- P1：`ms.net.fetch` 增加"按插件隔离的凭据 profile"（`ms.net.credentials.set({ 'X-Api-Key': '$MY_KEY' })`，值只存在 Rust 侧），插件仍只声明 scope，但**不必自己存明文 token**。
- P2：安装时根据清单自动生成"scope 建议"（从插件 README/配置里猜域名），降低作者写错 scope 的概率。

---

### 3.8 权限治理：ZTools 的"申请-审批闭环" vs 我们的"目录 + 审计"

**ZTools**
- 只有 `internal`（高级管理 API）有权限：`internalApiPermissions.ts`
  - 插件调 `requestInternalApiPermissions(apis, reason)` → 写待审申请 → **立即弹授权弹窗**（`internalApiRequestDialog.enqueue`）→ 用户批准/驳回。
  - 授权粒度是**通道名**（`internal:db-put` 这种），可部分批准；另有"完全授权名单""停用名单"（停用 = 挂起授权，恢复后原授权回来）。
  - 设置页可读 `permissions / requests / channels / fullAccessPluginNames / trustedPluginNames / disabledPluginNames`。
- 普通 API（文件、shell、截图、剪贴板、窗口、AI、支付）**没有权限概念**，装上就能用。

**我们**
- `permissions.ts` 是权限目录：6 组（search/ui/data/network/device/danger）× 4 风险等级 × `scoped` × `runtime(frontend/backend/both)` × `revokeImpact` 文案。
- 三层语义明确：**清单声明 = 请求**；**注册表 `grants` = 唯一生效依据**；**用户可在安装确认/权限弹窗/设置面板改动**。
- 安装确认：按分组聚合、标最高风险、`critical` 与 `scope:"*"` 要求**逐条勾选**（`requiresExplicitConsent`）。
- 运行期：`PluginPermissionError`（不是静默失败）；`recordDenied` 记录拒绝，面板可补授；`auditLog` 环形缓冲 500 条（api/detail/result/message），面板"权限与调用记录"可见。
- Rust 侧二次拦截：`GatewaySpec.grants` → `has_base_permission()`，即使前端被绕过仍拒绝。

**判语**
- 我们**整体明显更好**：这才是"给第三方插件市场用"的权限模型（风险分级、scope、撤销影响、审计、双端拦截）。
- ZTools **有一个点比我们好**：**插件可以主动申请**，并附理由，用户当场处理。我们现在只有"调用失败 → 宿主弹授权"这一条被动路径，插件没法解释"我为什么需要这个权限"。
- ZTools 的一个坏味道：授权粒度是"IPC 通道名"（`internal:db-put`），这是**实现细节泄漏到用户界面**——用户看不懂 `internal:set-window-material` 是什么。我们的粒度是"能力"（`clipboard.read`、`net.fetch:scope`），用户能理解。

**建议（P1）**
- 新增 `ms.permissions.request(apis, reason)`：写入 `record.pendingPermission`（已有字段）+ 宿主弹窗（复用安装确认的 `PermissionGroupBlock` 展示）+ 批准后写 grants 并广播；拒绝要留痕（`denied` 已有）。
- 面板加一个"申请历史"页签（谁在什么时候要过什么、批/驳），审计与授权形成闭环。

---

### 3.9 身份与网关：这是两边最本质的安全差别

**ZTools**
- 身份 = `webContents → pluginInfo`（`pluginManager.getPluginInfoByWebContents`：先查主视图 `pluginViews`，再查分离窗口 `detachedWindowManager`）。
- 每个 API handler **各自**调这个方法做鉴权；`requireInternalPlugin()` 的兜底是：
  ```ts
  if (!pluginManager) return true
  const pluginInfo = getPluginInfoByWebContents(event.sender)
  if (!pluginInfo) return true   // 不是插件调用（可能是主渲染进程），允许通过
  ```
  —— **识别不到就放行**（fail-open）。
- `setupPluginSession()` 里 `ensurePluginSessionPreload(sess, mainPreload)` 是**会话级**注册：该 session 下**所有**窗口（含插件自己 `createBrowserWindow` 出来的子窗口）都会加载宿主 preload，拿到 `window.ztools`。
- 而 `getPluginInfoByWebContents` **不认识** `pluginWindowManager` 创建的子窗口（那是第三张表），所以子窗口调 `ztools.internal.*` 时正好命中"识别不到 → 放行"。
- 再叠加 `sandbox:false` + `contextIsolation:false`：插件自己的 preload 本来就有 Node 能力（`require('fs')`、`child_process`），把结果挂到 `window` 上即可。**结论：ZTools 的插件在安装那一刻就等于"装了一个本机程序"**，权限系统只覆盖 `internal` 那一小撮管理 API。

**我们**
- 身份 = **构造期闭包绑定的 `pluginId`**（`createHostApi(pluginId, ctx)`），每次调用 `call()` 都回注册表取 `PluginRecord`，校验 `enabled` + `isGranted(permission)`，再写审计。
- 权限判定是**能力串**（含 scope 覆盖规则 `permissionCovers/scopeCovers`），不是"调用方是谁"。
- Rust 侧独立再判一次（`has_base_permission`、`scope_allows`、`ui.window`、`backend.spawn`、`clipboard.read` 的原生钩子挂载）。
- 插件拿不到裸 Tauri IPC；入口脚本只能看到注入的 `ms / plugin / host / keyword / inputValue / onSubKeyword / env`。

**判语**
- 我们**明显更好**：身份不是"运行时猜"，而是"创建时绑定"；不存在"猜不到就放行"的语义。这是权限模型能成立的前提。
- ZTools 的坑值得写进团队记忆：**"识别失败必须 fail-closed"**；**"会话级 preload 会污染所有子窗口"**；**"三张窗口表要统一身份"**。
- 我们的诚实短板：inlay 不是沙箱（插件脚本能碰宿主 DOM/localStorage），所以"恶意插件"仍可绕过 `ms.*`。我们的权限模型防的是"手滑"和"不懂事的插件"，不是"蓄意攻击"。

**建议**
- P2：把敏感值（GitHub Token、WebDAV 密码、环境变量值）从 localStorage 迁到 Rust 侧（文件 + DPAPI/keychain），前端只拿句柄；这样即使 inlay 被读，也读不到明文。
- P2：把 `ui.window` 做成真正的隔离形态（独立 WebView + 严格 `postMessage` 协议），作为"需要强隔离的插件"的推荐形态。

---

### 3.10 后台进程（我们的差异化优势）

**ZTools**：没有这个概念。插件就是 `WebContentsView`，靠 `backgroundThrottling:false` 常驻；长任务只能写在页面/preload 里，跟着窗口生死。

**我们**：`backend` 是一等公民。
- `backend.command` 直接 argv（不经 `cmd.exe`，Windows 加 `CREATE_NO_WINDOW`，无黑窗）；兼容老 `entry`。
- 协议 `jsonrpc-stdio` / `localhost-http`；`ms.backend.call/status` + `onNotification/onBackendChanged`。
- 生命周期：`autostart`（always/on-demand/prompt/never）、`idleExitSec` 空闲回收、`maxRestarts` + 退避（1s/5s/30s）、`shutdownTimeoutSec`、`deactivate` 优雅退出、`graceSec` 强杀。
- 进程树：Windows Job Object（宿主崩溃子进程一起走）/ Unix 进程组。
- 日志：`plugin-logs/<id>.log`，面板可看，1MB 保留尾部。
- 网关快照 `plugin-gateway.json`：开机自启时前端还没加载，靠快照拉起。

**判语**
- 我们明显更强，这是"插件即应用"的关键（录屏、索引、ffmpeg、本地模型都靠它）。
- 风险也在这里：`backend.spawn` 是 `critical` 权限，等于允许装一个任意可执行程序。我们的处理（逐条强提示 + 仅可信来源 + 原子安装）是对的，但**还缺运行期约束**：没有 CPU/内存配额、没有"后台进程网络访问"的独立权限、崩溃上报只有日志。

**建议**
- P2：`backend` 增加 `resources: { maxMemoryMB, maxCpuPercent }` 与"崩溃 N 次自动禁用"提示；把"后台进程出网"纳入 `net.fetch` 之外的显式声明（避免"有 backend 就绕过 scope"的观感）。

---

### 3.11 反向贡献：插件给宿主"加能力"

| 能力 | ZTools | 我们 |
|---|---|---|
| 搜索期结果 | `onMainPush` ✅ | ❌ |
| 动态命令 | `setFeature/removeFeature` ✅ | ❌（只能清单声明） |
| 翻译/OCR provider | `registerProvider` + 清单 `providers` + 设置页聚合 + 默认 provider ✅ | ❌ |
| MCP 工具 | `registerTool`（插件把工具暴露给外部 AI 客户端）✅ | ❌ |
| AI 能力 | `ai / aiChat / allAiModels / translate / ocr`（宿主代调，含官方额度与计费）✅ | ❌ |
| 主题 provider | `registerThemeProvider` ✅ | `ms.ui.registerThemeProvider` ✅（唯一一个） |
| 支付/变现 | `requestPayment / getPaymentRecords` + 阿凡达支付窗口 ✅ | ❌ |

**判语**
- ZTools 的生态想象力明显更大：插件不只是"用宿主能力"，还能"给宿主加能力"。尤其 `registerProvider` 让"翻译/OCR"从硬编码变成插件市场供给，这是架构级的正确决定。
- 我们目前只有"消费型"API，边界简单、攻击面小，但生态只能长成"一堆独立小工具"，长不出"能力插件"。
- 抄的时候必须配"三件套"：**清单声明（可审核）+ 超时/降级（不拖垮宿主）+ 权限（provider 可能读用户内容）**。ZTools 的 `registerProvider` 就没有权限概念，OCR provider 可以读任意图片 —— 我们不要这样。

**建议（P1/P2）**
- P1：`contributes.resultProvider` + `ms.results.provide`（见 3.3）。
- P1：`ms.commands.register`（见 3.2）。
- P2：`contributes.providers` + `ms.providers.register`（先做 `translation`，权限 `provider.translate`，输入内容是用户主动选中的文本）。
- P2：MCP tools 等真有外部 AI 客户端需求时再做，且必须"每工具一条权限"。

---

### 3.12 开发者体验

| 项 | ZTools | 我们 |
|---|---|---|
| 类型 | `@ztools-center/ztools-api-types`（TS 类型 + `plugin.json` 的 JSON Schema，清单里 `$schema` 直连编辑器补全） | 无独立 types 包；JSDoc 在源码里，文档在 `docs/plugin-market-publish.md` |
| 脚手架/打包 | `ztools-plugin-cli`（脚手架、打包）；开发项目注册表（多项目、顺序、热重载、DevTools 按钮） | `test/pack-plugin.mjs`；目录挂载热重载（前端重挂 / 清单热更新 / 后端按需重启） |
| 清单校验 | JSON Schema（编辑器层）+ 运行时读取（`readPluginConfig` 直接 `JSON.parse`，校验较少） | 纯函数校验 + **中文可读文案**（`describeManifestErrors`：`id.missing → "缺少插件 id"`）+ `apiVersion.tooNew` + `minAppVersion` |
| 调试 | 插件页"打开开发者工具"、日志收集 | 插件日志面板、`plugin-logs/<id>.log`、保活/主题/关闭行为的 e2e 测试 |
| 发布 | 市场 + npm 安装 + `.zpx` | GitHub Release（tag = 插件 id、资产 = `<id>.mspp`）+ 市场索引每小时重建 + 失败原因公开文件 |

**判语**
- ZTools 在"类型 + Schema + 脚手架"上领先一个身位：`$schema` 让作者在编辑器里就能校验清单，这是最低成本的 DX 提升。
- 我们在"校验可读性 + 测试覆盖 + 发布流程"上领先：`describeManifestErrors` 这种"给人看"的错误文案，是长期维护的护城河。
- 两边都缺"API 版本矩阵"：我们有 `apiVersion` 字段与 `tooNew` 校验，但没有"v1/v2 差异 + 弃用策略"的公开文档；ZTools 没有版本协商字段。

**建议（P1，性价比最高的一件事）**
- 发布 `@my-search/plugin-types`：`ms.d.ts` + `plugin.schema.json` + 从 JSDoc 生成的 API 文档；清单校验直接复用同一份 schema，避免"文档/校验/schema 三份真相"。
- 同时提供 `create-my-search-plugin` 最小脚手架（一个 `plugin.json` + `ui/detail.html` + `ui/index.js` + `meta.json`），把"从 0 到能跑"压到 3 条命令。

---

### 3.13 安装与供应链

| 项 | ZTools | 我们 |
|---|---|---|
| 包格式 | `.zpx`（gzip/brotli 压缩的 ASAR）/ zip | `.mspp`（ZIP，可当普通 zip 打开） |
| 完整性 | 未见哈希/签名校验 | 全包 SHA-256（`preparePackage`），市场下载带 `expectedSha256` 复核；`integrity.signed = false`（有哈希无签名） |
| 路径安全 | ASAR 解包（`unpack` pattern 有 `..` 检查） | 清单校验 + Rust `resolve_plugin_file` 二次校验（拒绝 `..` / 绝对路径） |
| 落盘 | 直接写插件目录 | staging → 校验 → **原子替换**（失败不破坏已装版本） |
| 权限确认 | 无（除 internal 申请） | 安装确认弹窗：分组 + 风险徽标 + critical 逐条勾选 + 升级时新增权限提示 |
| 来源 | 市场 / npm / 本地 | 市场（GitHub Release 索引）/ 本地 / 内置 |
| 更新 | 插件市场更新（用户点） | 插件级 `autoUpdate`（30 分钟检查 + 呼出节流）+ 市场更新按钮 |

**判语**
- 我们明显更好，这条是"敢开市场"的底气。
- 我们的漏洞：**自动更新会静默授予新权限**（`auto-update.ts` 顶部注释第 9–11 行自己写明"无论新版本声明了哪些权限…授予新清单声明权限并替换落盘"）。而"开发目录热重载"路径反而更严格（新权限只登记 `pendingPermission` 等用户确认）。两套口径不一致，且自动更新这条更危险。

**建议（P0，属于自查修复）**
- 自动更新分级：**新增 `critical` 权限 / `scope:"*"` → 阻断自动更新，转为"待用户确认"**；非高危新增权限可以静默（保持体验）。
- 补签名：至少"市场索引对每个包的 sha256 做签名"，客户端验签；`integrity.signed` 从 `false` 变成真实值。

---

### 3.14 平台能力覆盖面（快照）

| 能力 | ZTools | 我们 |
|---|---|---|
| 模拟键鼠 | `simulateKeyboardTap / MouseMove/Click/DoubleClick/RightClick` ✅ | ❌ |
| 屏幕/多显示器 | `getPrimaryDisplay / getAllDisplays / getCursorScreenPoint / dipToScreen*` ✅ | 截图 API 内含 monitor 信息，但无通用显示器 API |
| Shell | `shellOpenExternal / OpenPath / ShowItemInFolder / TrashItem / Beep` ✅ | 仅 `ms.system.openExternal`（限 http/https） |
| 文件 | `getPathForFile / copyFile / getCopyedFiles / startDrag / showOpenDialog / showSaveDialog / getPath` ✅ | `ms.input.*`（**限定在搜索框附件集合内**，这是刻意的安全边界）+ `pickFiles/saveFile` |
| 剪贴板历史 | `clipboard.getHistory/search/delete/clear/write/writeContent/updateConfig/onChange` ✅ | `ms.clipboard.list/readImage/copy/writeText/remove/clear/setRetained` + `onUpdated` ✅（覆盖面相当） |
| 截图 | `screenCapture(callback) / screenColorPick` | `ms.screenshot.*`（capture/overlay/crop/pickRegion/copy/save/saveAs/list/readShot/remove/prune）✅ 更完整 |
| 浏览器自动化 | `zbrowser`（ubrowser 兼容）✅ | ❌ |
| 音视频 | `runFFmpeg` ✅ | ❌（但可用 `backend` 自带 ffmpeg，`plugins/recorder` 就是这么做的） |
| AI | `ai/aiChat/allAiModels/translate/ocr` + 官方额度 ✅ | ❌（pi-agent 走自己的 backend + 用户的 key） |
| 支付 | `requestPayment/getPaymentRecords` ✅ | ❌ |
| 手势 | ❌（无） | `ms.gesture.*`（录制/映射/执行，`gesture.exec` 权限）✅ 独有 |
| 全局快捷键 | `registerGlobalShortcut / updateShortcut / startHotkeyRecording`（内部） | `ms.shortcuts.get/set/onAction` + 清单 `contributes.shortcut` ✅ 更规范 |
| 数据同步 | 账号体系 + 自建同步（内置插件管理） | `ms.sync.status/trigger` + `ms.store.sync` + 备份声明 ✅ 更贴近插件需求 |

**判语**：ZTools 是"能力全集"，我们是"业务原语 + 深做几个"。不要为了对齐数量去补模拟键鼠 / shell / 浏览器自动化——那些每一项都是 `critical` 级攻击面，等真的有插件场景再开，并且一开就要配权限与审计。

---

## 4. 值得抄的 5 个设计（按投入产出排序）

1. **搜索期结果提供者**（`onMainPush` 的思路）
   - 抄"语义"，不抄"每次拉起整个视图"。用 `contributes.resultProvider` + `ms.results.provide`，宿主侧并发 + 预算 + 超时降级。
   - 收益：插件从"打开才可用"变成"搜索即服务"，这是启动器生态的分水岭。

2. **进入参数对象 + `onPluginEnter/Out/Detach`**
   - `action = { type, code, keyword, payload, from }`；`onShow/onHide/onEnter`。
   - 收益：多入口插件（录屏、翻译、文件搜索）不用再猜"用户是怎么把我叫起来的"。

3. **权限"申请-审批"闭环**
   - `ms.permissions.request(apis, reason)` → 宿主弹窗（复用现有 `PermissionGroupBlock`）→ 批准写 grants / 驳回留痕。
   - 收益：把现在"调用失败才弹窗"的被动体验，变成插件能解释、用户能决策的主动流程。
   - 注意：**粒度用能力串，不要用 IPC 通道名**（ZTools 的 `internal:db-put` 是反例）。

4. **类型包 + JSON Schema 直连编辑器**
   - `@my-search/plugin-types` + `plugin.schema.json` + `$schema` 引用；清单校验复用同一份 schema。
   - 收益：作者在 VS Code 里就能看到字段补全与错误，比读 18KB 文档有效。

5. **宿主子输入框 / paste-back**
   - `ms.ui.subInput`（`setSubInput(onChange, placeholder, focus)`）与 `ms.system.pasteBack`。
   - 收益：启动器最常用的两条交互（二级输入、回填原应用）从"每个插件各写一遍"变成"宿主保证一致"。

---

## 5. 不要抄的 6 个坑

1. **巨型全局对象 + 把 `internal`（208 个方法）混进公共 API**：公共契约与"设置页私有契约"必须分开命名空间（我们已是 `ms.*` 分命名空间，保持）。
2. **身份识别 fail-open**：`getPluginInfoByWebContents` 返回 null 就放行 —— 任何"新窗口形态"都会变成绕过权限的后门。我们必须坚持"创建时绑定 pluginId，识别不到就拒绝"。
3. **会话级 preload 注入所有子窗口**：`ensurePluginSessionPreload(sess, mainPreload)` 让插件的 `createBrowserWindow` 子窗口也拿到 `window.ztools`；能力边界跟着窗口数量扩散。
4. **`webSecurity:false` + `contextIsolation:false` + `sandbox:false` 三连**：等于把 Electron 的全部风险敞口留给插件；插件 preload 有 Node，安全只剩"审核"。
5. **同步 IPC 做业务 API**（`sendSync`）：`copyText/getPath/getFeatures` 会阻塞渲染；插件里一次循环就能把 UI 卡死。
6. **`createBrowserWindow` 暴露 165 个 Electron 方法白名单**：这是"把内部实现当公开 API"，版本升级即破坏兼容，权限也无从谈起。

---

## 6. 我们自己的 4 个短板（自查，不是对比）

1. **自动更新静默扩权**（P0）：`auto-update.ts` 明确"无论新版本声明哪些权限…授予并替换"，与"开发热重载只登记 pendingPermission"的口径不一致。修法见 3.13。
2. **inlay 不是沙箱**（P2，已在 README 承认）：插件脚本可绕过 `ms.*` 直接读宿主 localStorage（含 token / env 明文）。权限模型是 API 边界，不是进程边界。修法：敏感值下沉 Rust + 提供隔离窗口形态。
3. **无类型包 / 无脚手架 / 无版本矩阵**（P1）：`apiVersion` 有字段没有"v1→v2 兼容策略"文档；新作者上手成本高于 ZTools。
4. **只有"消费型"API，没有"贡献型"API**（P1）：`registerThemeProvider` 是孤例；没有 result provider / command provider / capability provider，生态只能长成"一堆独立小工具"。

---

## 7. 建议落地顺序

### P0（先把"能用"补成"好用"，1–2 个迭代）
- [x] 生命周期：注入 `action` 参数；`ms.lifecycle.onShow/onHide/onEnter`（复用 keepalive 收口）。
- [x] 搜索期结果：`contributes.resultProvider` + `ms.results.provide`（权限 `search.write`；250ms 预算；单插件超时跳过；结果上限）。
- [x] 动态命令：`ms.commands.register/unregister`（权限 `ui.command`；写注册表 + 广播）。
- [x] 自动更新分级：新增 `critical` / `scope:"*"` 阻断自动更新。

**验收口径**
- 保活插件再次打开时 `onShow` 必触发一次，`onEnter` 携带 `from/type`；
- 搜索时 3 个 provider 并发，任一超时不拖慢整体（P95 增量 < 250ms）；
- 动态命令注册后 1s 内能在搜索框命中，卸载即消失；
- 自动更新遇到新 `backend.spawn` 权限时转为"待确认"，不再静默。

### P1（把生态门槛降下来）
- [x] `ms.permissions.request(apis, reason)` + 审批弹窗 + 申请历史。
- [x] `@my-search/plugin-types`（d.ts + JSON Schema + `$schema` 校验复用）。
- [x] `create-my-search-plugin` 脚手架 + 3 条命令跑通。
- [x] `ms.store` 集合语义（`collection().add/update/remove/list`）。
- [x] `ms.ui.subInput`（宿主子输入框）。

### P2（按真实需求开，不要提前背攻击面）
- [ ] `ms.system.pasteBack`（新权限 `system.paste`）。——**未开**：无真实插件需求。
- [ ] `contributes.providers` + `ms.providers.register`（先 translation，后 OCR）。——**未开**：无真实插件需求。
- [x] 敏感值下沉 Rust（token/env 不明文进 localStorage）。
- [x] 隔离窗口形态（`ui.window` sandbox iframe + postMessage 白名单桥，`mode=legacy` 可回退）。
- [ ] MCP tools（每工具一条权限 + 调用审计）。——**未开**：无外部 AI 客户端接入需求。

> 补充：P2-6 市场索引 ed25519 验签也已完成（见 `docs/plugin-platform-upgrade-plan.md` 第 9 节）。

---

## 8. 证据索引（文件:行）

**ZTools**
- `resources/preload.js:410` `window.ztools = {`；`:1063` `internal: {`；`:492` `onPluginEnter`；`:515` `onMainPush`；`:551` `setSubInput`；`:588` `db`；`:630` `clipboard`；`:692–708` `hideMainWindow*`；`:719` `createBrowserWindow`；`:833` `http`；`:843` `registerTool`；`:873` `registerProvider`；`:938` `ai`；`:411` `requestPayment`
- `src/main/api/plugin/pluginApiDispatcher.ts:14–72` 单通道分发表（sync/invoke 共用）
- `src/main/managers/pluginManager.ts:327–347` `WebContentsView`（`contextIsolation:false` / `webSecurity:false` / `sandbox:false` / `allowRunningInsecureContent`）；`:304–322` session 级 preload；`:2197–2239` `getPluginInfoByWebContents`（只认主视图 + 分离窗口）；`:1782–1824` `queryMainPush`；`:683` `showPluginView`
- `src/main/api/plugin/internal.ts:56–77` `requireInternalPlugin`（**fail-open**）
- `src/main/api/plugin/internalApiPermissions.ts:74–142` 插件申请；`:164–321` 设置页管理通道
- `src/main/api/plugin/feature.ts:63–166` 动态 features；`:217–235` 3s 防抖刷新
- `src/main/api/plugin/http.ts:29–105` 按会话注入请求头；`:136–174` `onBeforeSendHeaders` 拦截全部 http(s)
- `src/main/core/pluginWindowManager.ts:245` `ensurePluginSessionPreload`；`:257–268` 子窗口创建（同一 session）
- `src/main/api/shared/database.ts:75–160` `db` 的插件前缀隔离
- `src/main/utils/zpxArchive.ts`（`..` 检查在 `normalizeUnpackPattern`）；`pluginInstaller.ts` 未见哈希/签名校验
- `src/main/core/commands/matching/contextMatcherRegistry.ts:68–75` 五种上下文匹配器

**本仓库**
- `src/lib/plugins/host/core.ts:27–44` 权限/不可用错误；`:175–255` `createCallRunner`（启用态→权限→审计）；`:257–299` `defineRpcNamespace`；`:153–173` 审计环形缓冲
- `src/lib/plugins/permissions.ts:51–271` 权限目录；`:313–371` scope 匹配；`:483–489` `requiresExplicitConsent`
- `src/lib/plugins/host/ui-data-api.ts:172–238` search；`:375–567` input/file；`:570–627` store；`:643–685` store.sync；`:689–714` env；`:717–729` sync；`:732–774` system
- `src/lib/plugins/host/native-api.ts:144–244` screenshot；`:252–332` clipboard；`:335–403` gesture/shortcuts；`:406–436` backend
- `src/lib/plugins/host/net-api.ts:83–147` Rust 代理 + `scopeAllows`
- `src/lib/plugins/gateway.ts:39–104` `GatewaySpec`（grants/env/clipboardCapture 下发）
- `src-tauri/src/plugin_host.rs:315–410` `has_base_permission` / `any_plugin_granted`；`:1498–1507` `net.fetch` scope 复核；`:1749` / `:2541` `backend.spawn` 拦截
- `src/lib/plugins/manifest.ts:148–286` 贡献点；`:441–540` backend 规范化；`:982–1108` 清单校验；`:1151` `diffNewPermissions`
- `src/lib/plugins/auto-update.ts:1–13` **静默授予新权限**的契约声明
- `src/lib/plugins/install.ts:61–155` SHA-256 / 包预处理；`src/lib/plugins/registry.ts:634–671` `isGranted` / grants 维护
- `README.md:541–604` `ms.*` 与 `ms.store.sync`；`:694–724` 权限与"已知边界（inlay 非沙箱）"
- `docs/plugin-market-publish.md:353–380` 包校验与客户端安全边界

---

### 附：一句话记住两边的取舍

> **ZTools 把"插件"当"程序"来做，所以 API 又宽又爽，但它没有真正的权限边界；我们把"插件"当"第三方应用"来做，所以 API 有账可查，但还缺"插件给宿主加能力"的那半张网。**
> 下一步不是把 API 数量追到 300，而是把 **结果、命令、权限申请、类型包** 这四件事做扎实——这四件决定生态能不能长起来。
