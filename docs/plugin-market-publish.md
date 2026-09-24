# 插件上架指南

本文面向**第三方插件开发者**。只要你把插件放在自己的 GitHub 仓库里，按下面的规范发布，
就能把它上架到「我的搜索」插件市场。

## 三步走

1. **规范你的仓库** —— 按下面的结构组织代码，并用**插件 id 作为 Release tag** 上传打包好的 `.mspp`；
2. **提一个 issue** —— 只写你的**仓库地址**（`用户名/仓库名`），等我们审核；
3. **自己发版** —— 审核通过后，你**在自己仓库发新 Release 即可**，不用再找我们。
   市场索引每小时自动重建，最长一小时内你的新版就会出现在市场里。

> 换句话说：我们只审核**一次**（确认这个仓库是你的、插件不违规），之后你的发布节奏完全自主。

## 出问题了怎么知道

如果索引构建时你的插件不符合规范，它**不会进入市场**，但原因会写在一份公开清单里：

```
https://github.com/My-Search/my-search-plugin-market/blob/main/error-item.txt
```

该文件列出每个被排除的项及原因（例如"包内 id 与 tag 不一致"、"仓库不存在"）。
**每次构建后都可以去看一眼**——不用等我们通知，也不用反复来问。

另外：如果你的仓库被删除或转为私有，我们会自动把它从源清单里移除，不再重复处理。

---

## 一、仓库规范

### 1. 目录结构

最小可用结构（以纯前端插件为例）：

```
你的仓库/
├── plugin.json          # 插件清单（必需，必须在根目录）
├── meta.json            # 市场展示元数据（必需，仅用于上架，不进分发包）
├── icon.svg             # 图标（可选，也可在 plugin.json 里内联 data: URI）
└── ui/
    ├── detail.html      # 插件界面（必需，路径由 plugin.json 声明）
    └── index.js         # 界面脚本（可选）
```

含后端进程的插件再加 `backend/` 目录。可直接参考这两个真实样板：

- **最小纯前端**：`plugins/file-search/` —— 结构最标准，建议直接抄它改
- **含后端 + 环境变量 + 主题**：`plugins/pi-agent/`
- **第三方命名范式**：`plugins/com.zhuangjie.github-upload/`

### 2. `plugin.json`

```jsonc
{
  "id": "com.yourname.my-plugin",     // 必需：反向域名，见下方命名规范
  "name": "我的插件",                  // 必需：≤48 字
  "version": "1.0.0",                 // 必需：SemVer，发新版必须递增
  "apiVersion": 1,                    // 必需：当前插件 API 版本为 1
  "minAppVersion": "7.9.16",          // 可选：低于此版本的应用会对你隐藏
  "author": "你的名字",                // 必需
  "description": "一句话说明",          // 必需
  "homepage": "https://github.com/you/repo",
  "icon": "icon.svg",                 // 相对路径 / data: URI / http(s) URL
  "permissions": ["ui.inlay"],        // 必需：声明所需权限
  "contributes": {
    "searchItem": {
      "title": "我的插件",
      "desc": "在主搜索框里的说明",
      "keyword": "我的插件",             // 用于唤起插件
      "subSearch": false              // true = 参与「插件 : 关键词」二次搜索
    },
    "detailView": {
      "entry": "ui/detail.html",      // 必需：入口页面
      "script": "ui/index.js",
      "mode": "inlay",
      "closeBehavior": "exit"
    }
  }
}
```

#### id 命名规范（最容易踩坑）

- 必须是**反向域名式**，至少两段：`^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$`
- 只用**小写**字母、数字、中划线、点；每段不能以中划线开头/结尾
- 长度 ≤128；`core` / `host` / `system` 是保留 id
- **`com.mysearch.` 与 `mysearch.` 是官方保留前缀**，第三方请用自己的域名
  （例如 `com.zhuangjie.github-upload`）

#### 常见清单错误

| 现象 | 原因 |
| --- | --- |
| `id` 被拒 | 不是反向域名式（如用了中文或单段名） |
| `apiVersion` 被拒 | 高于当前宿主支持的版本（现为 1） |
| 权限被拒 | 用了权限目录之外的权限 id，或 scoped 权限没写 scope |
| `backend.withoutSpawnPermission` | 声明了 `backend` 但没申请 `backend.spawn` |
| `spawnPermission.withoutBackend` | 申请了 `backend.spawn` 但没有 `backend` |
| 环境变量名被拒 | 代码里用了 `MS_PLUGIN_` 前缀（保留） |

### 3. `meta.json`（市场展示元数据）

```json
{
  "categories": ["tools"],
  "tags": ["工具", "示例"],
  "official": false,
  "changelog": "首个版本"
}
```

- **`categories` 必填且不能为空数组**（分类缺失会导致整个索引被拒绝）；
- `tags` 会参与市场内的搜索匹配；
- `official` 由我们维护（第三方恒为 `false`）；
- `meta.json` **不会**进入最终分发给用户的包（打包器会自动排除）。

### 4. 权限

只能声明以下权限（`permissions.ts` 中的权限目录）：

| 权限 id | 分组 | 风险 | 是否需 scope |
| --- | --- | --- | --- |
| `search.read` / `search.write` | search | 中 | 否 |
| `ui.inlay` / `ui.window` | ui | 中 | 否 |
| `ui.command` / `ui.notify` | ui | 低 | 否 |
| `store` | data | 低 | 否 |
| `file.read` | data | 高 | 否 |
| `env.read` | data | 高 | **是**（变量名） |
| `clipboard.write` / `clipboard.read` | device | 低 / 高 | 否 |
| `selection.read` | device | 高 | 否 |
| `system.openExternal` | device | 中 | 否 |
| `net.fetch` | network | 高 | **是**（URL 模式） |
| `backend.spawn` | danger | 极高 | 否 |
| `secret.read` | danger | 极高 | **是**（密钥名） |
| `plugin.install` | danger | 极高 | 否 |

- scoped 权限的 scope 写法：`*`、`https://api.example.com/*`、`https://*.example.com/*`
- `permissions` 与 `optionalPermissions` 不能有重复项
- **极高风险**（`backend.spawn` / `secret.read` / `plugin.install`）或 scope 为 `*`
  的权限，用户安装时会被要求**逐条勾选**确认——请只申请真正需要的权限。

---

## 二、打包与发布 Release

### 1. 打包

在「我的搜索」主仓库里，用统一打包器打出 `.mspp`（本质是 ZIP，与宿主同一份实现，
保证打得出来就装得上）：

```bash
node test/pack-plugin.mjs plugins/你的插件目录 -o dist/com.you.plugin.mspp
```

打包器会在打包前强制校验：清单合法性、目录非空、以及清单声明的入口文件
（`detailView.entry` / `detailView.script` / `backend.entry`）确实存在。
校验不过会直接失败——这能挡住「用户装上后界面打不开」这类事故。

> 建议：把这条命令写进你仓库的 CI，每次发版自动打包。

### 2. 发布 Release

在你自己的仓库建一个 Release：

- **tag = 你的插件 id**（例如 `com.yourname.my-plugin`）—— 固定不变，发新版时覆盖同名资产
- **资产名 = `<插件id>.mspp`**（必须完全一致）
- 上传打包好的 `.mspp`

```bash
gh release create com.yourname.my-plugin \
  --title "我的插件 v1.0.0" \
  dist/com.yourname.my-plugin.mspp
```

发新版本时：

```bash
# 先把 plugin.json 的 version 递增（如 1.0.0 → 1.0.1），重新打包，然后：
gh release upload com.yourname.my-plugin dist/com.yourname.my-plugin.mspp --clobber
```

**后缀必须是 `.mspp`**，用别的后缀会导致市场索引构建失败（你会在 `error-item.txt` 里看到原因）。

#### 发布规范要点（务必逐条对照）

一个仓库**只放一个插件**。你的仓库会被写进市场源清单（`three-parties` 数组），
索引构建时按以下规则解析：

| 规则 | 要求 |
| --- | --- |
| Release tag | **必须等于你的插件 id**（如 `com.yourname.my-plugin`）。不符合反向域名格式的 tag 会被忽略 |
| 资产名 | **必须是 `<插件id>.mspp`**，与 tag 同名 |
| 包内 id | 包内 `plugin.json` 的 `id` **必须与 tag 一致**（我们会下载包核对，防张冠李戴） |
| 版本 | 由包内 `plugin.json` 的 `version` 决定，递增即可 |
| 数量 | 我们取**第一个能成功解析**的候选 tag；发新版沿用同一 tag 覆盖资产即可 |

发新版：

```bash
# 1) 递增 plugin.json 里的 version（如 1.0.0 → 1.0.1）
# 2) 重新打包
# 3) 覆盖上传（tag 不变）
gh release upload com.yourname.my-plugin dist/com.yourname.my-plugin.mspp --clobber
```

最长一小时后，市场索引自动重建，用户即可看到新版本。

> 注意：tag 必须**稳定不变**。如果你为每个版本新建 tag（如 `v1.0.0`、
> `v1.0.1`），它们不符合「tag = 插件 id」的规则，会被忽略。

### 3. 官方插件：按版本归档（不适用于第三方）

官方插件放在市场仓库里，采用**按版本归档**的方式（无需建 Release）：

```
official-plugins/
  com.mysearch.pi-agent/
    2.5.2/com.mysearch.pi-agent.mspp
    2.6.0/com.mysearch.pi-agent.mspp    ← 发新版就加一个版本目录
```

索引构建时会**自动列出所有版本目录、取版本号最大的一个**。
我们同样会校验「目录名版本」与「包内 `plugin.json` 的 version」是否一致。

第三方开发者**不需要**关心这一节——你用自己的仓库发 Release 即可。

### 4. 废弃标记

如果你不再维护某个插件，我们会给它打上「已废弃」标记：

- **自动**：仓库被归档（GitHub 上标为 archived）时，同步工具会自动标记，
  用户会在市场里看到「已废弃」徽标和提示；
- **手动**：你也可以直接说一声，我们手标（官方插件走这条路，因为它托管在我们的仓库里）。

标记为废弃后，**不会禁止用户安装**——已有的用户可能仍在依赖它，或需要装上做数据迁移。
所以如果你想彻底停止分发，请另外告知我们。

---

## 三、提交上架 issue

规范好仓库后，提一个 issue，包含：

| 项 | 说明 |
| --- | --- |
| **仓库地址** | `https://github.com/you/your-plugin`（必需） |
| 插件 id | 你的 `plugin.json` 里的 `id` |
| 分类 | 期望的市场分类（如 `tools` / `ai` / `productivity`） |
| 简介 | 一句话说明插件做什么 |

审核通过后，我们会在市场准入名单（`plugins/sources.json`）里加上你的一条记录。
**此后你只需在自己仓库发版**，索引会自动同步，无需再联系我们。

如果后续改了仓库地址或插件 id，请再开一个 issue 告知（这两项是索引的锚点）。

---

## 四、我们如何校验你的包

为了让你放心，也为了说明为什么可以自助发版，同步时的校验链路如下：

1. **按准入名单拉包** —— 只从审核过的仓库地址取
2. **解包校验清单** —— 读取包内 `plugin.json`，跑完整的清单校验规则，
   并要求包内 id 与准入名单一致（防止张冠李戴）
3. **计算 sha256** —— 对**真实包字节**计算，不采信任何自报值
4. **生成索引** —— 写入 catalog.json，客户端安装前会再验一次这个哈希

也就是说：**哈希始终由我们计算**，你不需要（也无法）手写哈希。

---

## 五、客户端侧的安全边界

下载地址并非无限制。客户端（Rust 侧）对每个下载地址做如下校验：

- 必须 **https**
- host 必须是 `github.com`（或 GitHub 资产重定向终点 `objects.githubusercontent.com`）
- 端口必须为缺省或 `443`
- 路径必须是 Release 资产形态：`/<owner>/<repo>/releases/download/<tag>/<asset>`
- **拒绝含 userinfo 的地址**（防 `github.com@evil.com` 这类伪造）
- **不自动跟随重定向**：每一跳都重新校验，防止被引到内网（SSRF）

因此请把包放在 GitHub Release 里，不要用第三方网盘/自建站中转。

---

## 六、已知边界

- **插件目前没有签名机制**，完整性依赖我们计算的 sha256。请勿把 release 资产替换为
  内容不同的包而沿用同名 tag —— 索引里的哈希会对不上，用户安装会被拒绝。
- 市场索引**只保留每个插件的最新版本**，客户端不提供「安装指定旧版本 / 回滚」。
  如果你需要回滚，请在 `plugin.json` 里**递增版本号**并重新发布（不要降低版本号，
  否则客户端不会认为是更新）。
- 请不要删除已发布 Release 里正在使用的资产，否则已装用户重装会 404；如需下线插件，
  请开 issue 告知。
