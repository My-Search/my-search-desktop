# 云同步 v2 实现基线（分片 + manifest 提交点）

> 状态：P1 已落地（对象层 / 分片构建 / 迁移 / 只传脏片 / 懒下载 / 面板占用视图）。
> 后续阶段见文末「待做」。

## 1. 为什么改

v1 的云端只有一份 `.msbackup` 整包：

- 改一条待办要重传整包（几 MB ~ 几百 MB）；
- 新设备要下整包才能用；
- 无法回答「每个插件占了多少云空间」；
- 两设备并发只能整包互斥（`If-Match`），冲突粒度太粗。

v2 把用户态拆成**不可变分片对象**，用 `manifest.json` 记录「当前生效的是哪几片」。

## 2. 云端布局

```text
<remote_file + ".cloud">/   ← 默认 my-search → my-search.cloud
  manifest.json                        ← 唯一原子提交点（最后写）
  core-<digest>.msbackup               ← internal/ + settings + 非插件 localStorage
  plugins/<id>/body-<digest>.msbackup  ← 插件主体（安装文件 / 开发挂载源码副本）
  plugins/<id>/data-<digest>.msbackup  ← 插件数据（kv 等白名单 + sync-store/<id>.json）
```

- **按摘要命名**：同一内容重复上传幂等（`If-None-Match: *` 命中 412 即复用），
  不需要逐片 ETag，也不存在「两个设备同时写同一片、后者静默覆盖前者」。
- **manifest 是提交点**：先传对象、最后写 manifest。写失败 → 旧 manifest 仍指向旧对象，
  远端永远是某个完整状态。
- **manifest 结构**（`schema: "ms.cloud/2"`）：

```json
{
  "schema": "ms.cloud/2",
  "rev": 12,
  "updatedAt": 1730000000000,
  "updatedBy": "<deviceId>",
  "appVersion": "7.9.40",
  "core":    { "digest": "…", "bytes": 12345, "updatedAt": … },
  "plugins": {
    "todo-list": {
      "body": { "digest": "…", "bytes": …, "updatedAt": … },
      "data": { "digest": "…", "bytes": …, "updatedAt": … }
    }
  }
}
```

## 3. 摘要与决策

- 分片摘要 = `sha256(排序后的(相对路径, 文件内容 sha256, 大小) + 该片 localStorage 子集 [+ core 的 Rust 设置])`
  （`backup::shard_digest`）。**按内容而不是 mtime**：还原会重写文件、改 mtime，
  按时间做摘要会让「刚还原完」立刻被判成「本机有改动」。
- 单分片决策（`cloud.decideShardAction`）：

| 远端 | 基线 | 本机==基线 | 远端==基线 | 结果 |
|------|------|-----------|-----------|------|
| 无 | * | - | - | 本机有内容 → 上传；否则跳过 |
| 有 | 无 | - | - | 内容相同 → 跳过；本机空 → 下载；都有 → 冲突 |
| 有 | 有 | 是 | 是 | 跳过 |
| 有 | 有 | 是 | 否 | 下载 |
| 有 | 有 | 否 | 是 | 上传 |
| 有 | 有 | 否 | 否 | 按冲突策略（newer/local/remote/ask） |

- **本机没有该插件**：基线里有 → 判为「卸载」，只从 manifest 摘引用（对象交给 GC）；
  基线里没有 → 判为「新设备从未装过」，从云端装回来（body 立即下、data 懒下）。

## 4. 下载策略

| 分片 | 时机 |
|------|------|
| `core` | 每轮立即（配置/设置/注册表） |
| `body` | 每轮立即（插件开箱可用） |
| `data` | **懒加载**：仅记录 `pending[pluginId] = digest`；`ensurePluginData(id)`（打开插件 / 面板「下载数据」）时才拉 |

`pending` 存在时永远不拿本机数据覆盖远端；本机也改过 → 按冲突策略，`ask` 返回 `conflict`
让界面问用户。

状态落盘（`sync-state.json`）新增：`cloudFormat` / `manifestEtag` / `shards`（基线）/
`pending`（待下载）。

## 5. 分片内容

| 分片 | 内容 |
|------|------|
| `core` | `internal/`（内置插件卸载标记等）+ `settings.json` 里的**用户配置**（`BACKUP_SETTINGS_KEYS`：快捷键绑定、开机自启、Alt+点击、代理、主题、呼出键、动作解绑标记）+ 非插件的 localStorage（订阅、标签、权重、历史、主题、界面偏好、插件注册表等） |
| `body` | `plugins/<id>/` 安装文件（开发挂载收源码目录，跳过 `node_modules/target/dist`） |
| `data` | `plugin-data/<id>/` 白名单（默认 `kv/`，插件可声明）+ `sync-store/<id>.json` + 该插件的 `PLUGIN_DATA:*` |

**不进备份**：GitHub Token、WebDAV 密码、搜索数据缓存、订阅指纹、插件重启标记、插件日志；
以及 `settings.json` 里的机器相关状态（`file_assoc_mspp`）与一次性迁移标记
（`pin_shortcut_migrated_v1/v2`）——这些跨机携带会让新设备行为错乱。

## 6. 落地实现（代码位置）

| 层 | 文件 |
|----|------|
| 对象层 / 分片打包 / 摘要 / manifest 命令 | `src-tauri/src/cloud_sync.rs` |
| 分片文件收集与内容摘要 | `src-tauri/src/backup.rs`（`collect_plugin_body_files` / `collect_plugin_data_files` / `collect_core_files` / `shard_digest`） |
| 单插件主体分片的落地还原 | `src-tauri/src/backup.rs::restore_plugin_shard` + 命令 `backup_restore_plugin_shard` |
| 持久化基线 | `src-tauri/src/sync_state.rs`（`cloudFormat/manifestEtag/shards/pending/conflicts`） |
| 内核 | `src/lib/sync/cloud.ts`（`runCloudRound` / `decideShardAction` / `ensurePluginData` / `cloudOverview`） |
| 宿主接线 | `src/lib/sync/host.ts`（`runCloudRound` 取代 v1 整包轮次；持有逐插件裁决 `choices`，轮次结束按仍冲突的片清理） |
| IPC | `src/lib/sync/bridge.ts` |
| 面板 | `src/windows/config/panels/PanelSync.vue`「云端分片」卡片（位置固定在 WebDAV 配置卡下方、不随导出/导入 tab 切换） |

命令：`cloud_manifest_get` / `cloud_manifest_put` / `cloud_digests` / `cloud_shard_put` /
`cloud_shard_get` / `cloud_object_delete` / `cloud_quota` / `cloud_shard_inspect`。

### 面板语义

窄窗口（面板宽 < 约 560px）时表格在**自己的容器内横滚**，不撑破页面；名字列保持可读宽度，
不会被长 id 挤成一两个字。

| 位置 | 行为 |
|----|------|
| 插件列 | 两行：**插件名**在上，灰字小号 id 在下；两者都按列宽省略。云端有但本机未安装的插件只有 id，名字退化为 id |
| 云端占用 / 本机占用 / 配额剩余 / 状态 | 直接读 manifest + 本机目录体积，只读 |
| 「查看内容」 | 点开才下载该插件的 `body` / `data` 两片（`cloud_shard_inspect`），本地解析 ZIP 条目后列出「文件名 + 大小」（最多 2000 条）；只读、不改动本机数据；再次点「重新读取」才刷新 |
| 「下载数据」 | 仅 `pending`（本机缺该插件 data 片）时出现，等价 `ensurePluginData` |
| 冲突面板 | 按**插件**一行：插件名 + 片类型（插件程序 / 插件数据 / 软件主体）+ 两侧体积 + 云端更新时间，每行「用云端 / 用本机」只对该插件生效；底部另有「全部用云端 / 全部用本机」。没列出冲突的插件此时早已同步完成 |
| 「立即同步」 | 有冲突时仍可点：冲突片挂起，其余插件/分片照常推拉 |

> `cloud_shard_inspect` 刻意**不**把文件清单写进 manifest：清单会随每次改动变大，
> 让 manifest 这个原子提交点变重；按需下载解析反而是 O(单插件) 的代价。

## 7. 迁移（v1 → v2）

远端没有 v2 manifest 时：

1. 从未同步过 + 远端有 v1 整包 → 让用户选（本机 / 云端）；
2. 远端有 v1 整包且 `etag == state.remoteEtag`（v1 语义：上次同步后没变）→ 推本机分片；
3. 远端整包比上次新 → 先拉整包还原，再拆片上传；
4. 已经用过 v2（`cloudFormat === 2`）但 manifest 不见了 → 视为「云端被清空」，推本机，
   **绝不**用旧整包覆盖本机（此时 `remoteEtag` 存的是 manifest ETag，不能拿来比整包）。

旧整包保留在原处，可回滚。

## 8. 配额

| 项 | 限制 | 强制点 |
|----|------|--------|
| 单分片对象 | 200MB | `cloud_shard_put` |
| 单插件（body + data 逻辑和） | 200MB | 引擎告警（`lastError` 提示）+ 面板「配额剩余」 |
| JSON 层单键 / 单插件 / 合计 | 64KB / 512KB / 8MB | `plugin_sync_store` 写入时 |

WebDAV `507` → `CLOUD_FULL:`，前端提示「云端空间不足」而不是普通网络错误。

## 9. `backup.pluginData`（哪些本机数据上云）

默认白名单只有 `kv`（`ms.store.readJson/writeJson` 的结构化小数据，含剪贴板插件的
`annotations`：**收藏 / 分类 / 二次编辑文本**都在这一个文件里）。插件可在 `plugin.json`
里显式声明：

| 写法 | 含义 |
|------|------|
| 不写 | 只上云 `kv/` |
| `true` | `plugin-data/<id>/` 全量 |
| `false` | 一个都不上云（只留 `sync-store`） |
| `["kv", "clipboard/index.json"]` | 精确前缀；**数组即以声明为准**（不再隐式带 `kv`） |

现状：剪贴板插件声明了 `["kv", "clipboard/index.json"]`——注解（分类/收藏/编辑）本来就在
`kv`，条目本体（文本正文 + 图片元数据）在 `index.json`，两者一起上云才能让「收藏/分类」
在新设备上真的有东西可指。图片二进制（`clipboard/*.png`，约 10.9MB）仍留本机，
等 blob 层（第 12 节）落地后按内容寻址再同步。

> 代价：`index.json` 每复制一次都会变，`data` 分片是「一插件一片」的粗粒度对象，
> 因此每次变化会重传该片（当前 ≈ 320KB）。细粒度化（按文件/按 blob 分对象）属于第 12 节。

## 10. 多设备并发与安全边界

### 保证

| 场景 | 结果 |
|------|------|
| 本机没改、远端变了 | **下载**（不会被本机旧数据盖掉） |
| 本机改了、远端没变 | **上传**（不碰别的设备已提交的内容） |
| 两边都改了 | 冲突：`newer` 比 `remoteUpdatedAt` 与 `lastSyncAt`；`local` / `remote` / `ask` 按设置 |
| 首连遇到云端已有数据 | 强制 `needs-choice`，绝不静默选一边 |
| 两台设备同时提交 manifest | 条件 PUT（`If-Match`）→ 412 → 重读远端 → **按片合并** → 重试一次 |

**冲突按插件隔离（本轮）**：某个分片冲突不再让整轮停摆——只把这几片记进
`conflicts` 挂起（`heldKeys`），其余分片、其余插件照常下载/上传，manifest 照常提交
（挂起片的指针保持远端版本）。面板按**插件**一行列出「哪一片、两侧体积、云端更新时间」，
每行单独「用云端 / 用本机」；裁决只对该插件生效（`sync_resolve_choice` 的 `pluginIds`，
`""` 表示 core），其它插件不受影响。挂起片的基线**不推进**，所以下次同步仍会提示它，
不会因为「基线已对齐」而误判成「本机单边修改」把它覆盖掉。

**412 合并规则（本轮修复）**：只有本机**真正上传过**的分片才用本机引用，其余一律取刚读到
的远端版本；`core` 同理。旧实现是整份「本机 manifest 覆盖远端」，会把另一设备在这几秒内
刚提交的分片指针回滚成旧值（对象还在云端，但 manifest 不再引用 → 表现为「数据丢了」）。
另外 Rust 侧原先把所有 412 都当成「对象已存在（同内容）」吞掉，导致 manifest 冲突根本走不到
合并分支；现在对 `manifest.json` 的 412 返回 `SYNC_CONFLICT`，分片仍按幂等处理。
还有一处同源隐患一并修掉：`buildOutManifest` 原来无条件把**本机** core 摘要写进 manifest，
当 core 是「下载/冲突挂起」时会把云端主体指针指回旧摘要（其它设备会拉到过期配置）；
现在只有本轮真的上传了 core 才用本机引用。

**P0 安全底座（本轮）**：

- `scope.ts` 统一 `account / device / never`。设备键（`RECENT_ATTACH_KEY`、
  `auto_download_update`、`PLUGIN_DATA:*:viewSize`）不采集、不还原、不触发同步；
  `autostart_enabled` 移出 `BACKUP_SETTINGS_KEYS`。
- 注册表里的开发挂载记录上传前改写为普通安装副本（`dir=plugins/<id>`、`source.kind=file`），
  本机还原时同 id 保留原始 dev 记录；其 `PLUGIN_DATA:*` 按设备数据，`prune` 不删。
- WebDAV 密码 Windows 走 DPAPI 密文（`credential_store.rs`），旧 `{password}` 自动迁移；
  Unix 仍为 0600 文件，`cipher` 字段显式声明。
- 真正下载落地前写 `backups/pre-remote-*.msbackup`（`collectBackupState` 保留设备键与 dev 原始记录），
  面板显示并可直接打开备份目录。
- manifest 增 `devices` 表（设备名 / 版本 / 最后提交时间），面板显示「最后提交」；412 合并保留其它设备行。

### 边界（说清楚，别过度承诺）

1. **差分的粒度是「分片」不是「文件」**：一个插件的 `data` 是一整片，改一条记录也要重传整片。
2. **同一分片被两设备同时改** → 单片级 last-write-wins，没有内容级合并（JSON 不会自动 merge）。
   `data` 片是懒下载的，本机没拉过远端新片时不会静默覆盖（先记 `pending`），但真并发改动只能靠
   冲突策略或用户选择。**注意隔离只做在分片/插件之间**：同一个插件内部 body 与 data 一起裁决，
   但不会把「剪贴板冲突」升级成「整轮冻结」，也不会波及别的插件。
3. **时钟**：`newer` 比较的是「远端片 `updatedAt`」与「本机 `lastSyncAt`」，两台机器时钟差大会判错边；
   把策略设成 `ask` 最稳。
4. **服务器不给 ETag**：条件提交退化为「先 HEAD 取 ETag 再 `If-Match`」（本次补强），仍有
   HEAD→PUT 的窄竞态；ETag 完全不可用的 WebDAV 实现只能最后写入者胜。

## 11. 测试

- `node test/cloud-sync-v2.test.mjs`（68 条）：决策表、对象路径、首轮全量、无变化不传、
  远端数据变化懒加载、`ensurePluginData`、只传脏片、卸载摘引用、**412 并发合并不回滚他人分片**、
  **冲突按插件隔离**（一个插件冲突时其它插件照常上传/提交、冲突片基线不推进、逐插件裁决后恢复）。
- `node test/sync-panel-ui.test.mjs`（74 条）：面板布局、云端对象卡片（插件名/id/查看内容）、
  v3 文件级计数/虚拟条目清单、**冲突明细按插件一行 + 单插件裁决按钮**。
- `node test/sync-scope.test.mjs`（54 条）：作用域分档、开发挂载记录改写/合并。
- `node test/sync-snapshot.test.mjs`（27 条）：内存 localStorage 驱动采集/还原/prune，
  设备键不上云、dev 原始记录只进本机留底、prune 不删设备数据。
- `node test/cloud-sync-v3.test.mjs`（41 条）：v3 三方决策、首次建立、无变化不提交、
  剪贴板单条上传、图片 blob、双边冲突、v2→v3 迁移。
- Rust：`cloud_sync::tests::*`（路径白名单 / 插件 id / URL 编码 / v3 对象名与虚拟条目）、
  `backup::shard_tests::*`（稳定序列化、摘要不依赖 mtime 但跟随内容、`backup.pluginData` 白名单）、
  `credential_store::tests::dpapi_roundtrip`（Windows DPAPI 往返）。
- `npm run typecheck` / `npm run build` / `cargo check` / `cargo test --lib`（191 通过 / 6 ignored）。

## 12. v3 接续（已落地，2026-11-20）

v2 仍是旧客户端的兼容层；新客户端默认 `cloudFormat=3`：

- 新增 `manifest-v3.json` 唯一提交点，`manifest.json` 保持只读；
- `core` / `body` 复用 v2 对象，插件数据降到每文件对象；≤2KB 文本内联；
- 剪贴板 `clipboard/index.json` 由同步层虚拟拆成 `clipboard/items/<id>.json`，
  但只拆 `filter: { "retained": true }` 命中的收藏/分类条目；`blobFields: ["relPath"]`
  让图片 blob 只同步这些条目的引用图片。普通历史留本机，插件本地存储不改；
  收藏/分类仍在 `kv/annotations.json`；
- 图片走 `blobs/<sha256[0:2]>/<sha256>` 内容寻址；
- 迁移 = 先跑一轮 v2 对齐，再扫描本机建 v3；不拆 v2 归档、不重传 core/body；
  旧 v2 `data` 片仍按原白名单全量，作为旧客户端兼容层；
- 旧客户端在 v3 之后提交 v2 时，v3 轮次会警告，不自动合并。

未做：leaves / tombstone / diff UI / CDC / 按插件懒下载 / 孤儿对象 GC。

## 13. 待做（下一阶段）

1. **blob 冷打包与所有权（v3 已完成基本层）**：`blobs/<前两位>/<sha256>` 内容寻址与
   跨插件去重已落地；尚未做 `≤512KB` 小图追加打包（`packs/<id>/<packId>.bin`，单包 ≤16MB，
   死数据 >50% 重写）、宿主按 `sync-store` 引用做**权威归属**（插件无删除权）、
   `lastSeenAt` 超 7 天且无 owners 才 GC、`getBlob` 缺失返回 `BLOB_PENDING` + 后台预取。
   图片不再需要靠 `backup.pluginData` 进 `data` 片，改用 `backup.blobs` 声明。
2. **摘要性能**：现在每轮读全部分片文件内容算摘要。插件主体有几十 MB 时应加
   `(mtime,size) → digest` 的进程内缓存（内容变化才重算）。
3. **core 删除传播**：`restoreState` 只覆盖归档里存在的键；远端删掉的核心键本机仍保留。
   需要给 `pruneState` 加「只清理 core 分区」的过滤器。
4. **GC**：对象目录清理（manifest 不引用的 `core-*` / `plugins/**` / `blobs/**`，宽限期 7 天）。

