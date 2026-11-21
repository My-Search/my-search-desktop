# 插件类型包（v1）

给插件作者用的两份东西，都在这个目录：

| 文件 | 用途 |
| --- | --- |
| `plugin.schema.json` | `plugin.json` 的 JSON Schema（编辑器补全 / 自检） |
| `ms.d.ts` | 插件视图里 `ms.*` 的类型声明 |

## 为什么是"同源"

`plugin.schema.json` **不是手写的**，由 `scripts/gen-plugin-schema.mjs` 从宿主校验代码生成：

- 版本、id/路径规则、数值区间来自 `src/lib/plugins/manifest.ts`（`parsePluginManifest` 用的同一批常量）；
- 权限枚举来自 `src/lib/plugins/permissions.ts` 的 `PERMISSION_CATALOG`（宿主鉴权用的同一张表）。

改动校验规则后重新生成即可，CI / 测试里跑 `node scripts/gen-plugin-schema.mjs --check` 会拦截漂移。
运行时校验仍以宿主 `parsePluginManifest` 为准——Schema 只负责"写的时候少犯错"。

## 在插件里引用

仓库内插件（如 `plugins/xxx/`）：

```json
{
  "$schema": "../../packages/plugin-types/plugin.schema.json"
}
```

```js
/// <reference path="../../packages/plugin-types/ms.d.ts" />
```

外部插件可以复制这两个文件到自己的仓库，或把 `$schema` 指向发布出去的 raw 地址。
宿主**忽略 `$schema` 字段**，它只影响编辑器体验，不影响安装。

## 发布形态

当前选择"仓库内 `packages/` + raw 引用"，不发布到 npm：

- 插件生态还小，发版节奏不必被 npm 版本号绑住；
- 宿主与类型包在同一个 commit 里改，作者拿到的一定是对应版本；
- 需要单文件分发时直接拷 `ms.d.ts` / `plugin.schema.json` 即可，无构建步骤。

何时改成 npm 公开发包：出现第一批外部作者，且需要按版本锁定类型时（见
`docs/plugin-api-versioning.md`）。

## 独立窗口（`ms.ui.openWindow`）

默认形态是 **sandbox iframe + 白名单桥**：`ms` 只暴露「请求-响应」型 API，
不提供 `ui.onThemeChanged` / `shortcuts.onAction` / `results.provide` 这类回调 API，
也不提供 `ui.openWindow`（禁止窗口套窗口）。需要这些能力的独立窗口可显式
`openWindow({ entry, isolated: false })` 回退到旧的同上下文形态——那意味着插件
页面与宿主共享 JS 世界，只应在完全信任插件代码时使用。
