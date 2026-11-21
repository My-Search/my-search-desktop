# 插件 API 版本与演进

本文回答两个问题："插件作者怎么知道我改的东西不会崩"、"宿主怎么在升级时守住兼容"。

## 一条原则

**`apiVersion` 是能力面版本，不是营销版本。** 它只在"老插件会因此报错或行为改变"时递增；
加一个可选字段、加一个新命名空间，不递增。清单里的 `version` 是插件自己的迭代版本，与宿主无关。

当前宿主支持的最高 `apiVersion` 是 `PLUGIN_API_VERSION = 1`。清单声明 `apiVersion > 1` 会被
`parsePluginManifest` 拒绝（`apiVersion.tooNew`），提示作者升级宿主；声明 `< 1` 也拒绝。

## 什么算破坏性变更

| 变更 | 是否破坏 | 处理 |
| --- | --- | --- |
| 新增 `ms.*` 命名空间 / 方法 | 否 | 直接加，类型包与文档同步 |
| 新增清单可选字段 / 贡献点 | 否 | 老清单不写就不受影响 |
| 放宽校验（如数值区间变大） | 否 | 直接改 |
| 收紧校验（如必填、路径规则变严） | **是** | 走 `apiVersion` 递增，或只对新声明生效 |
| 删除 / 重命名 `ms.*` 方法 | **是** | 旧方法至少保留一个 API 版本，内部标 `@deprecated` |
| 改变方法返回值语义 | **是** | 新增方法或参数开关，不改老语义 |
| 改变权限的 `base` id 或 scope 形态 | **是** | 老权限保留为别名；`PERMISSION_CATALOG` 不删条目 |
| 新增 critical 权限 | 否（对老插件） | 只影响新申请者；自动更新会拦截待确认 |

判断标准不是"代码改了多少"，而是"已安装插件是否需要改代码/重新授权才能继续工作"。

## 版本递增流程（`apiVersion: N → N+1`）

1. 在 `src/lib/plugins/manifest.ts` 改 `PLUGIN_API_VERSION`，并在 `describeManifestError` 补上新错误码文案；
2. `packages/plugin-types/ms.d.ts` 保留旧签名（标 `@deprecated`），加新签名；
3. `node scripts/gen-plugin-schema.mjs` 重新生成 `plugin.schema.json`（版本上限会自动跟着变）；
4. `docs/plugin-api-comparison-ztools.md` 之外，补一节迁移说明到本文末尾的"变更记录"；
5. 宿主对 `apiVersion < N` 的插件保持旧路径：运行时按 `record.manifest.apiVersion` 分支，
   **不要**用"全局新行为"覆盖老插件；
6. 全量跑 `npm run typecheck` + `node test/plugin-*.test.mjs`，特别是老清单解析与权限覆盖用例。

> 只有"所有已安装插件都必须改"时才递增；能靠"新字段/新方法 + 默认关闭"解决的，不递增。

## 类型包与 Schema 的发布

- 仓库内：`packages/plugin-types/`，`$schema` 用相对路径引用；
- 外部：可复制 `plugin.schema.json` 与 `ms.d.ts`，或指向仓库 raw 地址；
- 暂不发布 npm（生态还小、宿主与类型包同 commit 更稳）。出现第一批外部作者并需要按版本锁定类型时，
  再把 `packages/plugin-types` 提升为公开发包，包名 `@my-search/plugin-types`，`version` 与
  `PLUGIN_API_VERSION` 同步（`1.x` 对应 `apiVersion: 1`）。

无论发不发 npm，**Schema 永远由宿主常量生成**，不手写；`gen-plugin-schema.mjs --check`
在测试里跑，漂移即失败。这是"同源"的硬保证。

## 权限演进规则

1. 新增权限必须同时改三处：`permissions.ts` 目录、Rust 侧网关白名单、文档；
2. 权限 id 一旦发布不改名（scope 形态也不改），需要新语义就加新 id；
3. `risk` 只升不降：从 `high` 调成 `medium` 会让用户在未重新确认的情况下少一道提醒；
4. 任何 `scope: "*"` 或 `critical` 的新增权限，自动更新一律拦截为 `pendingUpgrade`，等用户确认；
5. 运行时申请（`ms.permissions.request`）只能申请清单里声明过的 `optionalPermissions`，
   不允许"先运行再要新能力"绕过安装确认。

## 插件作者的兼容做法

- 清单写 `minAppVersion`（如 `"7.9.40"`），宿主低于它会拒绝安装并给出明确提示；
- 用 `ms.permissions.request` 申请可选权限，不要假设一定拿到；
- 用 `typeof ms.xxx?.yyy === "function"` 探测新 API，缺失时降级而不是抛错；
- 监听 `ms.lifecycle.onDispose` 释放资源，别依赖页面 `beforeunload`；
- 需要跨版本稳定行为时，把 `apiVersion` 写死为当前值，不要跟着宿主升级自动改。

## 变更记录

| apiVersion | 日期 | 内容 |
| --- | --- | --- |
| 1 | — | 初始能力面：`search` / `ui` / `input` / `store` / `env` / `sync` / `system` / `backend` 等 |
| 1（增量，不递增） | 2026-11 | 生命周期 `ms.lifecycle`、进入参数 `action`、动态命令 `ms.commands`、搜索期结果 `ms.results`、权限申请 `ms.permissions`、`ms.store.collection`、`ms.ui.subInput`、`secret.write`、`ms.net.credentials` |
| 1（默认行为变更，需作者知晓） | 2026-11 | `ms.ui.openWindow` 默认改为 sandbox iframe + 白名单桥：插件页面不再与宿主同 JS 上下文，只开放请求-响应型 `ms` 子集。依赖 `ui.onThemeChanged` / `shortcuts.onAction` / `results.provide` 或直接访问宿主 DOM 的独立窗口，需显式传 `isolated:false` 回退。仓库内现有插件未使用 `openWindow`，故未递增 `apiVersion`；新外部作者请按隔离形态设计。 |

> 表中"增量"行刻意不递增 `apiVersion`：全部是新增命名空间/方法，老插件不调用即零影响。
