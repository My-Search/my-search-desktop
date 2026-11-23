# GitHub 仓库搜索与批量下载器

在「我的搜索」中按关键词、语言、Star、更新时间、Fork、归档状态、Owner、Topic、License 等条件搜索 GitHub 仓库，勾选后批量下载；下载时可选择本机目标文件夹。

## 功能

- 只展示仓库结果，不混入代码、Issue、用户等其他类型。
- 支持排序（最佳匹配 / Star / Fork / 最近更新）、每页 30/50/100 条，最多翻到 GitHub 的前 1000 条结果。
- 批量勾选（最多 100 个仓库），跨分页保留选择。
- 下载目标文件夹通过系统文件夹选择框指定，并记住上次选择。
- 两种打包方式：
  - 每个仓库一个独立 ZIP（或 TAR.GZ）。
  - 合并为一个 ZIP；合并失败时自动回退为分别保存。
- 文件名模板：`{owner}`、`{repo}`、`{full_name}`、`{date}`、`{time}`、`{branch}`；同名自动追加 ` (2)`、` (3)`。
- 可选在目标目录下新建子文件夹。
- 实时进度：总进度、下载速度、预计剩余时间、逐仓库状态；支持取消；关闭插件界面后任务仍在后台继续，重新打开可恢复进度。
- 可选 GitHub Token：提高搜索配额到 30 次/分钟，并支持私有仓库下载。Token 只保存在插件数据目录，不进入前端脚本。
- 可选 HTTP 代理（CONNECT 隧道）与企业 GitHub API 地址。

## 环境要求

- 「我的搜索」7.9.15 及以上。
- 本机 Node.js 18 及以上（插件后端是零依赖 Node 程序，通过 `node backend/index.mjs` 启动）。

## 使用

1. 在搜索框输入 `仓库` 唤起插件，例如 `仓库 react`，也可直接粘贴 `https://github.com/owner/repo`。
2. 按需筛选，勾选结果；底栏会显示已选数量。
3. 点击「下载」，选择目标文件夹，设置格式 / 合并方式 / 命名后开始。
4. 下载完成后可在进度页或底栏入口打开目标文件夹。

## 权限说明

- `ui.inlay`：在搜索结果内嵌插件界面、调用系统文件夹选择框。
- `ui.notify`：Toast 与确认框。
- `store`：保存筛选、命名、上次下载目录等偏好（不保存 Token）。
- `backend.spawn`：启动零依赖 Node 后端，负责 GitHub 请求与写盘。
- `system.openExternal`：在 GitHub 打开仓库页面。

## 数据位置

- 配置（含 Token）：`<MS_PLUGIN_DATA_DIR>/config.json`，POSIX 下权限 600。
- 偏好与上次结果：宿主插件存储（localStorage 作用域）。
- 临时文件：目标文件夹下 `.ms-grd-tmp-<jobId>`，任务结束后清理；启动新任务时清理超过 1 天的同类目录。

## 开发 / 打包

```bash
node --check plugins/com.zhuangjie.github-repo-downloader/ui/index.js
node --check plugins/com.zhuangjie.github-repo-downloader/backend/index.mjs
node test/github-repo-downloader-ui.test.mjs
node test/pack-plugin.mjs plugins/com.zhuangjie.github-repo-downloader -o dist/com.zhuangjie.github-repo-downloader.mspp
```

后端是 JSON-RPC over stdio，方法包括：`init`、`ping`、`status`、`getConfig`、`setConfig`、`testToken`、`search`、`downloadStart`、`getJob`、`cancelDownload`、`openFolder`。
