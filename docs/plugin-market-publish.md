# 插件开发与上架指南

> English version: [plugin-market-publish.en.md](./plugin-market-publish.en.md)

> 本文在市场仓库有一份副本，供第三方开发者直接查阅：
> https://github.com/My-Search/my-search-plugin-market/blob/main/docs/plugin-market-publish.md
> **改动本文件后请同步推送该副本**（内容需保持一致）。


本文从零开始，带你完成：**写一个插件 → 本地调试 → 打包 → 发布到市场**。

如果你只想快速了解发布约定，可跳转到 [第四节](#四打包与发布)。

---

## 一、插件是什么

「我的搜索」的插件是一个**目录**，至少包含一个 `plugin.json` 清单和一个界面文件。
用户在搜索框里输入插件的关键词即可唤起它。

插件能力包括：

- 在搜索结果里注册入口（关键词唤出）
- 提供一个自定义界面（HTML + JS，可用宿主注入的 `ms.*` API）
- 读写本地存储、访问网络、操作剪贴板、读取文件
- 启动一个后台进程（Node/Python 等），与界面通讯
- 参与「关键词 : 子关键词」二次搜索

---

## 二、从零写一个插件

### 1. 建目录

```
my-plugin/
├── plugin.json          # 清单（必需，必须在根目录）
├── meta.json            # 市场展示元数据（上架需要）
├── icon.svg             # 图标（可选）
└── ui/
    ├── detail.html      # 界面（必需）
    └── index.js         # 界面脚本（可选）
```

### 2. 写清单 `plugin.json`

```jsonc
{
  "id": "com.yourname.hello",        // 必需：反向域名，全局唯一
  "name": "你好插件",                 // 必需：≤48 字
  "version": "1.0.0",                // 必需：SemVer，发新版必须递增
  "apiVersion": 1,                   // 必需：当前插件 API 版本为 1
  "minAppVersion": "7.9.15",         // 可选：低于此版本的应用会隐藏本插件
  "author": "你的名字",               // 必需
  "description": "一句话说明",        // 必需
  "homepage": "https://github.com/you/my-plugin",
  "icon": "icon.svg",                // 相对路径 / data: URI / http(s) 直链
  "permissions": ["ui.inlay"],       // 必需：声明所需权限
  "contributes": {
    "searchItem": {
      "title": "你好插件",
      "desc": "在主搜索框里的说明",
      "keyword": "你好",              // 用户输入这个词唤起插件
      "subSearch": false             // true = 参与「你好 : 子词」二次搜索
    },
    "detailView": {
      "entry": "ui/detail.html",     // 必需：界面入口
      "script": "ui/index.js",
      "mode": "inlay",
      "closeBehavior": "exit"        // 关闭时退出（另一选项 minimize 保活）
    }
  }
}
```

**id 命名规范**（最容易踩坑）：

- 必须是**反向域名式**，至少两段，如 `com.yourname.hello`
- 只用**小写**字母、数字、中划线、点；每段不能以中划线开头/结尾
- 长度 ≤128；`core` / `host` / `system` 是保留 id
- **`com.mysearch.` 与 `mysearch.` 是官方保留前缀**，第三方请用自己的域名

### 3. 写界面 `ui/detail.html`

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>你好插件</title>
</head>
<body>
  <div id="app">
    <h2>你好，世界</h2>
    <button id="btn">点我</button>
    <p id="out"></p>
  </div>
  <script src="index.js"></script>
</body>
</html>
```

### 4. 写脚本 `ui/index.js`

宿主会注入 `ms` 对象（API 见下方），`ms.plugin.id` 是你的插件 id。

```js
document.getElementById("btn").addEventListener("click", async () => {
  // 写本地存储（需要 store 权限）
  await ms.store.set("lastClick", Date.now());
  // 弹提示（需要 ui.notify 权限）
  ms.ui.toast("已记录", "info");
  document.getElementById("out").textContent = "已保存";
  // 调整插件区域高度（需要 ui.inlay 权限）
  ms.ui.setHeight(200);
});

ms.log("info", "插件已加载");
```

### 5. 常用 API（`ms.*`）

调 API 需要先在 `permissions` 里声明对应权限，否则会抛错。

| API | 权限 | 说明 |
| --- | --- | --- |
| `ms.search.query(kw, limit)` | `search.read` | 查询搜索数据 |
| `ms.search.setInput(text)` | `search.write` | 设置搜索框内容 |
| `ms.search.closeView()` | `search.write` | 关闭插件界面 |
| `ms.ui.toast(text, type)` | `ui.notify` | 弹提示 |
| `ms.ui.setHeight(px)` | `ui.inlay` | 调整界面高度 |
| `ms.store.get/set/remove/keys()` | `store` | 本地键值存储 |
| `ms.input.readFile(path)` | `file.read` | 读文件（转 data URL） |
| `ms.input.listFolder(path)` | `file.read` | 列目录 |
| `ms.net.fetch(url, opts)` | `net.fetch:<scope>` | 发 HTTP 请求 |
| `ms.system.writeClipboard(t)` | `clipboard.write` | 写剪贴板 |
| `ms.system.openExternal(url)` | `system.openExternal` | 用系统浏览器打开 |
| `ms.env.list/pick()` | 无 | 环境变量 |
| `ms.backend.call(m, p)` | `backend.spawn` | 调后台进程 |
| `ms.log(level, ...)` | 无 | 打日志 |
| `onSubKeyword(fn)` | 无 | 接收「关键词 : 子词」转发 |

### 6. 完整示例

仓库里有可直接参考的真实插件，建议照抄结构：

- **`plugins/file-search/`** —— 最小纯前端插件，最推荐作为起点
- **`plugins/pi-agent/`** —— 含后台进程、环境变量、主题适配的完整示例
- **`plugins/com.zhuangjie.github-upload/`** —— 第三方命名范式示例

---

## 三、本地调试

把插件目录挂载到应用里（无需打包，改完即生效）：

1. 在插件配置面板选择「从目录挂载」，指向你的插件目录
2. 应用会写入一个 `.dev-source` 文件标记该目录
3. 改 `ui/**` 会自动重载；改 `plugin.json` 会重新读取清单

---

## 四、打包与发布

### 1. 打包

用统一打包器打出 `.mspp`（本质是 ZIP，与宿主同一份实现，保证打得出来就装得上）：

```bash
node test/pack-plugin.mjs 你的插件目录 -o dist/com.yourname.hello.mspp
```

打包器会在打包前强制校验：

- 清单合法（id/version/权限等）
- 目录非空
- 清单声明的入口文件确实存在（`detailView.entry` 等）

**校验不过会直接失败** —— 这能挡住「用户装上后界面打不开」这类事故。
建议把这条命令写进你仓库的 CI。

### 2. `meta.json`（市场展示元数据）

```json
{
  "categories": ["tools"],
  "tags": ["示例", "工具"]
}
```

- **`categories` 必填且不能为空数组**（缺失会导致构建失败）
- `tags` 会参与市场内的搜索匹配
- `meta.json` **不会**进入分发给用户的 `.mspp` 包（打包器自动排除）

### 3. 发布 Release（第三方）

一个仓库**只放一个插件**。发布规则如下：

| 规则 | 要求 |
| --- | --- |
| Release tag | **必须等于你的插件 id**（如 `com.yourname.hello`） |
| 资产名 | **必须是 `<插件id>.mspp`**，与 tag 同名 |
| 包内 id | 包内 `plugin.json` 的 `id` 必须与 tag 一致（我们会下载包核对） |
| 版本 | 由包内 `plugin.json` 的 `version` 决定，递增即可 |
| tag 稳定性 | **必须稳定不变**；不要为每个版本新建 tag |

```bash
# 首次发布
gh release create com.yourname.hello \
  --title "你好插件 v1.0.0" \
  dist/com.yourname.hello.mspp

# 发新版：先递增 plugin.json 的 version，重新打包，覆盖上传（tag 不变）
gh release upload com.yourname.hello dist/com.yourname.hello.mspp --clobber
```

### 4. 提交上架

提一个 issue，内容只需：

| 项 | 说明 |
| --- | --- |
| **仓库地址** | `用户名/仓库名`（必需） |
| 简介 | 一句话说明插件做什么（可选） |

审核通过后，我们会把你的仓库加入市场源清单。**此后你只需在自己仓库发版**，
市场索引每小时自动重建，无需再联系我们。

---

## 五、出问题了怎么知道

如果构建时你的插件不符合规范，它不会进入市场，但原因会写在公开文件里：

```
https://github.com/My-Search/my-search-plugin-market/blob/main/index.error.json
```

示例内容：

```json
{
  "generatedAt": "2026-09-24T10:43:35.874Z",
  "official-repo": [],
  "three-parties": [
    { "repo": "user/repo", "reason": "无任何 Release" }
  ]
}
```

常见原因：

| 原因 | 怎么办 |
| --- | --- |
| 无任何 Release | 按上文规范创建 Release |
| 没有 tag 符合「插件 id」规范 | tag 必须是你的插件 id |
| 包内 id 与 tag 不一致 | 检查 `plugin.json` 的 `id` |
| 清单校验失败 | 按原因修正清单 |
| 下载不到包 | 确认资产名是 `<插件id>.mspp` |

如果你的仓库被删除或转为私有，我们会自动把它从源清单移除，不再重复处理。

---

## 六、我们如何校验你的包

为了保证市场里每个包都是可信的，构建时会：

1. 按源清单拉取你的包
2. **解包校验清单** —— 读取包内 `plugin.json` 跑完整校验，并核对 id 与 tag 一致
3. **计算 sha256** —— 对**真实包字节**计算，不采信任何自报值
4. 写入索引 —— 客户端安装前会再验一次这个哈希

也就是说：**哈希始终由我们计算**，你不需要（也无法）手写哈希。

---

## 七、客户端侧的安全边界

下载地址被客户端严格校验：

- 必须 **https**
- host 只能是 `github.com`（Release 资产）或 `raw.githubusercontent.com`（官方插件目录）
- 端口必须为缺省或 `443`
- **拒绝含 userinfo 的地址**（防 `github.com@evil.com` 伪造）
- **不自动跟随重定向**：每一跳都重新校验，防止被引到内网（SSRF）

因此请把包放在 **GitHub Release** 里，不要用第三方网盘或自建站中转。

---

## 八、权限清单

只能声明以下权限（其余会被拒绝）：

| 权限 | 分组 | 风险 | 是否需 scope |
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

- scoped 权限写法：`*`、`https://api.example.com/*`、`https://*.example.com/*`
- `permissions` 与 `optionalPermissions` 不能重复
- **极高风险**权限（`backend.spawn` / `secret.read` / `plugin.install`）或 scope 为 `*`
  的权限，用户安装时会被要求**逐条勾选**确认 —— 请只申请真正需要的权限

---

## 九、废弃与下架

如果不再维护某个插件，市场会给它打上「已废弃」标记：

- **自动**：仓库被归档（GitHub archived）时自动标记
- **手动**：联系我们手标（官方插件走这条路）

标记后**不会禁止安装**（已有用户可能仍依赖它），只是显示徽标与提示。
如需彻底停止分发，请另外告知我们。

---

## 十、已知边界

- **插件目前没有签名机制**，完整性依赖我们计算的 sha256。请勿把 release 资产替换为
  内容不同的包而沿用同名 tag —— 哈希会对不上，用户安装会被拒绝。
- 市场索引**只保留每个插件的最新版本**，客户端不提供「安装指定旧版本 / 回滚」。
  需要回滚请在 `plugin.json` 里**递增版本号**重新发布（不要降版本号，否则客户端
  不会认为是更新）。
- 请不要删除已发布 Release 里正在使用的资产，否则已装用户重装会 404。
