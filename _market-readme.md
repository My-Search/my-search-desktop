# 我的搜索 · 插件市场

本仓库是「我的搜索」桌面应用的**市场索引源**。

## 架构：索引在这里，插件包在开发者自己的仓库

客户端只读一个入口——本仓库的 `catalog` Release 资产：

```
https://github.com/My-Search/my-search-plugin-market/releases/download/catalog/catalog.json
```

索引里每条记录的 `downloadUrl` 指向**该插件自己的仓库**的 Release 资产，例如：

```
https://github.com/<开发者>/<仓库>/releases/download/<插件id>/<插件id>.mspp
```

也就是说，插件包**不集中存放在本仓库**。本仓库只保存"有哪些插件、当前版本、哈希是多少"。

## 如何上架一个新插件

1. 开发者按 [插件上架指南](../docs/plugin-market-publish.md) 规范自己的仓库并发 Release；
2. 开发者提 issue 报仓库地址；
3. 我们审核后，在主仓库的 `plugins/sources.json` 里加一条准入记录；
4. 跑同步工具：`npm run sync:market` —— 它会拉取各仓库的包、校验、算 sha256、生成索引；
5. `bash dist/market/publish.sh` 发布索引。

**之后开发者自己发版即可**，我们只需（或由 CI 定时）重跑第 4、5 步。

### 三种指定包地址的方式

`sources.json` 的条目支持三种写法：

```jsonc
// 方式一：仓库 + 资产（第三方推荐；能自动检测仓库归档）
{ "id": "com.example.a", "repo": "example/plugins", "asset": "com.example.a.mspp" }

// 方式二：直接指定完整包地址
{ "id": "com.example.b",
  "url": "https://github.com/My-Search/my-search-plugin-market/releases/download/com.example.b/com.example.b.mspp" }

// 方式三：按版本归档（官方插件推荐）
// 包放在 <repo>/official-plugins/<id>/<版本>/<id>.mspp，自动取最大版本
{ "id": "com.example.c", "repo": "My-Search/my-search-plugin-market", "path": true }
```

方式三是官方插件的省事做法：**不用为每个插件建 Release**，把包按
`official-plugins/<插件id>/<版本>/<插件id>.mspp` 放进仓库即可，
同步时自动列出所有版本、取版本号最大者作为默认安装版本。

三种方式的地址都必须是 **github.com 的 Release 资产**或
**raw.githubusercontent.com 的 `official-plugins` 目录下的 `.mspp`**（客户端会校验）。

### 废弃标记

`deprecated: true`（+ `deprecatedReason`）会在市场里给插件打上「已废弃」徽标并展示原因，
但**不禁止安装**。此外同步工具还会**自动检测仓库归档**（GitHub archived）并标记，
无需手动维护。

## 同步工具做了什么

`scripts/sync-sources.mjs`（在主仓库 `My-Search/my-search-desktop`）：

```bash
npm run sync:market                # 同步全部源
npm run sync:market -- --only <id> # 只同步指定插件
```

对每个源：

1. 按准入名单从对应仓库拉取 Release 资产
2. **解包并校验包内 `plugin.json`**，要求包内 id 与准入名单一致
3. 对**真实包字节**计算 sha256（不采信任何自报值）
4. 生成 `catalog.json`，并用客户端自己的 `parseCatalog` 回验，不通过则拒绝产出

## 目录结构（catalog.json）

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "…",           // 生成时间
  "baseUrl": "https://github.com/My-Search/my-search-plugin-market/releases/download",
  "plugins": [
    {
      "id": "com.example.plugin",
      "name": "…", "version": "1.0.0", "apiVersion": 1,
      "minAppVersion": "7.9.15",  // 低于宿主版本时对用户隐藏
      "author": "…", "description": "…",
      "categories": ["tools"],     // 必填，不能为空
      "tags": ["…"],               // 用于市场内搜索
      "downloadUrl": "…",          // 指向插件自己仓库的 Release 资产
      "sha256": "…",               // 64 位小写 hex，安装前校验
      "size": 1234,
      "permissions": ["ui.inlay"],
      "official": false, "verified": false,
      "deprecated": false,            // true = 已废弃（仅提醒，不禁止安装）
      "deprecatedReason": "…",         // 废弃原因（展示给用户）
      "publishedAt": "…", "updatedAt": "…"
    }
  ]
}
```

### `downloadUrl` 的约束

客户端会校验每条下载地址，必须是：

- https；
- host 为 `github.com`（或 GitHub 资产重定向终点 `objects.githubusercontent.com`）；
- 端口缺省或 `443`；
- 路径形如 `/<owner>/<repo>/releases/download/<tag>/<asset>`；
- 不含 userinfo（拒绝 `github.com@evil.com` 这类伪造）。

因此请把包托管在 **GitHub Release**，不要用网盘或自建站中转。

## 版本约定

- **tag = 插件 id**，固定不变；发新版时用 `--clobber` 覆盖同名资产；
- 索引只保留每个插件的**最新版本**（客户端暂不支持安装旧版本/回滚）；
- 更新请在 `plugin.json` 里递增 `version`（不要降版本号）；
- 已发布、正在使用的资产请勿删除，否则已装用户重装会 404。
