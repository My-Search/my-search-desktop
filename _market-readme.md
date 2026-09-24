# 我的搜索 · 插件市场

本仓库是「我的搜索」桌面应用的**插件市场**：既存放官方插件包，也存放市场索引。

## 架构：两层索引

仓库根目录有两个索引文件，职责不同：

| 文件 | 谁写 | 内容 | 谁读 |
| --- | --- | --- | --- |
| `index.json` | **人工维护** | 源清单：官方插件路径 + 第三方仓库 | 我们的构建工具 |
| `index.dist.json` | **工具自动生成** | 完整索引：版本、sha256、下载地址… | **客户端** |
| `error-item.txt` | 工具自动生成 | 被排除的项与原因 | 开发者自查 |

客户端读的是：

```
https://raw.githubusercontent.com/My-Search/my-search-plugin-market/main/index.dist.json
```

### `index.json` 格式

```jsonc
{
  "official-repo": [
    // 官方插件：包在本仓库里按版本归档
    "official-plugins/com.mysearch.pi-agent"
  ],
  "three-parties": [
    // 第三方插件：用户名/仓库名，一个仓库一个插件
    "zhuangjie/github-file-upload"
  ]
}
```

**新增插件**：审核后在此加一行即可，之后开发者发版无需改动本文件。
**仓库 404**：构建工具会自动把失效的仓库从 `three-parties` 移除。

## 插件包存放位置

### 官方插件：按版本归档（仓库文件）

```
official-plugins/
  com.mysearch.pi-agent/
    2.5.2/com.mysearch.pi-agent.mspp
    2.6.0/com.mysearch.pi-agent.mspp    ← 发新版加一层版本目录
```

构建时自动列出所有版本目录、**取版本号最大者**。无需为官方插件建 Release。

### 第三方插件：自己的仓库 + Release

一个仓库一个插件，规范见
[插件上架指南](../docs/plugin-market-publish.md)：

- **tag = 插件 id**（如 `com.yourname.my-plugin`），稳定不变
- **资产名 = `<插件id>.mspp`**
- 包内 `plugin.json` 的 `id` 必须与 tag 一致（构建时核对）

## 索引如何更新

`.github/workflows/build-market-index.yml` **每小时**自动构建一次：

1. 读 `index.json`
2. 逐个解析（官方列版本目录 / 三方下载 Release 包）
3. 计算 sha256、校验包内清单、取最大版本
4. 生成 `index.dist.json` 与 `error-item.txt`，**提交回仓库**
5. 客户端下次读取即拿到最新索引

整个过程只需本仓库的 `GITHUB_TOKEN`，**不依赖任何额外 secret**——
因为索引是仓库文件，不是 Release 资产。

## 构建异常

不符合规范的项不会进入 `index.dist.json`，原因写入
[`error-item.txt`](./error-item.txt)，开发者可自行查看。常见原因：

- 仓库不存在（404，会同时从 `index.json` 自动移除）
- tag 不符合「插件 id」格式
- 包内 id 与 tag 不一致
- 包内清单校验失败、版本与目录名不一致

## 客户端下载地址约束

索引里每条 `downloadUrl` 会被客户端校验，必须满足：

- https
- host 为 `github.com`（Release 资产）或 `raw.githubusercontent.com`（官方插件目录）
- 路径为 Release 资产形态，或 `.../official-plugins/<id>/<版本>/<id>.mspp`
- 不含 userinfo、端口为缺省或 443
- 下载过程不自动跟随重定向（逐跳校验，防 SSRF）
