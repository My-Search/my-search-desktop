# 云同步 v3 规划：不依赖中心服务器的多设备安全同步

> 目标读者：本项目的实现者。
> 前提：**不引入任何厂商服务、账号体系、中继或中心计算节点**。唯一允许的“中心”是用户自己的存储（WebDAV / NAS / 对象存储），它只存字节、不做计算。
> 参考对象：`ZTools-main`（下称 ZTools）。它的同步内核值得借鉴，但它的“官方服务 / 私有部署”都是中心服务器架构，**不采纳**。

---

## 0. 先把“中心服务器”说清楚

| 形态 | 是否有中心 | 说明 |
|---|---|---|
| ZTools 官方 | 有（厂商） | 账号 + `z-tools.top` 同步服务 + MySQL；设备只连服务 |
| ZTools 私有部署 | 有（用户自建） | 仍是一台常驻 Go 服务 + MySQL，所有设备连它 |
| 本项目 v2/v3 | **无应用服务器** | 设备直接读写同一个 WebDAV 目录；`manifest.json`（v2）/ `manifest-v3.json`（v3）是唯一提交点 |
| 本项目 v3 可选 P2P | 无 | 同局域网设备直连交换增量；跨网络仍靠用户自己的存储“碰面” |

必须诚实的一点：**跨网络、设备不在同一局域网时，一定要有一个“碰面点”**——用户自己的 WebDAV/NAS/对象存储，或者人工导出/扫码传递。没有厂商服务器，也不做公网打洞，就不存在“任何网络下全自动同步”的魔法。本方案的选择是：

- 默认：WebDAV（用户自有）= 碰面点，**无账号、无中继、无计算服务**；
- 可选：同局域网 P2P 直连，减少对 WebDAV 的依赖与延迟；
- 永不：官方账号、托管同步服务、设备在线状态托管。

---

## 1. 现状（v2）与差距

已具备：

- 内容寻址分片：`core-<digest>` / `plugins/<id>/body-<digest>` / `plugins/<id>/data-<digest>`；
- `manifest.json` 唯一原子提交点，`If-Match` + 412 后**按片合并**（不覆盖别人刚提交的指针）；
- 只传脏片、`data` 懒下载（`pending`）；
- 冲突按插件隔离（挂起冲突片，其余片/插件照常同步）；
- 单插件 200MB、507 单独提示、云端分片面板与“查看内容”；
- 还原前留底、逐插件版本守卫（拒绝降级）。

差距（也是本方案要解决的）：

1. **粒度粗**：一个插件的 `data` 是一整片。剪贴板 `index.json` 317,906 B，每复制一条就整片重传（当前 data 片 ≈ 353,905 B）。
2. **冲突只保一边**：裁决后另一边只剩本机“还原前留底”，云端没有历史；无法回看、无法 diff。
3. **同片并发仍是 LWW**：两台设备同时改同一个 `data` 片，manifest 合并后只有一边的指针，另一边对象成为孤儿。
4. **设备级 / 账号级配置不分**：`autostart`、快捷键、窗口相关配置会跨设备跑，多设备互相打架。
5. **无 blob 层**：图片只能整片走 `data`（剪贴板图片 10.9MB）。
6. **无删除传播**：`restoreState` 只覆盖存在的键，远端删掉的核心配置本机仍在。
7. **实时性弱**：5 秒节流 + 60 秒心跳 + 30 分钟兜底，跨设备感知慢（WebDAV 无推送，这是约束）。
8. **凭据明文**：`sync-credentials.json` 明文存密码（Unix 仅 chmod 600）。

---

## 2. ZTools 做得好的点，以及“无服务器”下的落地方式

| ZTools 的做法 | 为什么好 | 我们的落地（不加服务器） |
|---|---|---|
| 每个 key 一篇文档（`PLUGIN/<id>/<key>`） | 只传变的那一条，冲突粒度到 key | v3 改为**每文件一对象**；大 JSON 用 CDC 分块；插件侧把“单文件索引”改成“按条文件”（剪贴板） |
| revision tree，多 leaf 保留 | 冲突不丢数据，可回看任意版本 | manifest 里每个对象维护 `leaves[]`（≤8），对象内容寻址天然保留旧版本 |
| 冲突逐行 diff | 用户能判断该留哪边 | 面板对 JSON/文本做行级 diff；二进制显示大小/哈希/缩略图 |
| `_rev` generation + winner 算法 | 无中心也能确定性收敛 | `generation` 大者胜，同代按 `rev` 字典序，完全客户端计算 |
| 设备级 / 账号级键白名单 | 窗口尺寸、自启、插件顺序不跨设备 | `syncScope` 注册表：`device` / `account` / `never`，默认保守 |
| 附件 digest blob + `push_missing` | 去重、缺失补传、不阻塞提交 | `blobs/<sha256>` + manifest 引用；上传前确保 blob 存在，缺失返回 `BLOB_PENDING` 并后台补 |
| checkpoint（本地 + 远端） | 断线续传、批次不重复 | 本地 `sync-state.json` 已有基线；增加每设备 `seq` 与 `pendingQueue`，提交成功才推进 |
| 实时 broadcast | 秒级多设备 | WebDAV 无推送：**自适应 HEAD 轮询**（前台 3–5s、空闲 30s、后台 5min）；可选局域网 P2P 实时 |
| 删除 tombstone | 删除能传播 | 每个对象支持 `deleted: true` 的 leaf；v3 补上 core/文件删除传播 |
| 附件 10MB 限制 + 压缩 | 防止单文件拖垮 | 单文件上限、manifest 体积上限、对象数上限、507 前置检查 |

不学的：官方账号、中心服务、MySQL、JWT 默认密钥、管理接口无鉴权、token 明文。

---

## 3. v3 目标与非目标

### 目标

1. **零应用服务器**：所有协调逻辑在客户端，所有状态在 WebDAV 对象 + 本地 `sync-state.json`。
2. **细粒度**：常规文件级增量；大文件分块；图片/二进制 blob 去重；复制一条剪贴板不再重传整片。
3. **不丢数据**：并发修改保留多 leaf；冲突可 diff、可回看、可“保留双方”；删除有 tombstone。
4. **设备/账号配置分离**：同一账号多设备不互相覆盖本机专属配置。
5. **可恢复**：断网、崩溃、半途提交都不破坏云端一致性（manifest 唯一提交点继续保留）。
6. **可运维**：GC、配额、对象数/清单体积可见；迁移与回滚有明确路径。

### 非目标

- 不做官方账号/托管服务/中继；
- 不做公网 P2P 打洞（仅同局域网直连，可选）；
- 不做服务端计算、服务端冲突合并；
- 不承诺“WebDAV 上多对象事务”（用 manifest 提交点规避）。

---

## 4. 数据布局 v3

```
<webdav_url>.cloud/
  manifest.json                       # v2 提交点（迁移后 v3 **只读**，旧客户端继续用它）
  manifest-v3.json                    # v3 唯一提交点（If-Match + ETag）
  manifest-v2.backup.json             # 迁移时快照，保留 30 天
  core/<digest>.msc                   # 内核快照（设置 + 非插件 localStorage）
  plugins/<id>/body/<digest>.msb      # 插件安装文件（整片，体积小）
  plugins/<id>/files/<pathHash>-<digest>.msf   # 每文件对象（≥ 内联阈值）
  plugins/<id>/chunks/<digest>.msk    # 大文件 CDC 分块（可选，P2）
  blobs/<sha256[0:2]>/<sha256>        # 图片/二进制，全局去重
```

**混合版本安全**：v3 不覆盖 `manifest.json`。旧客户端继续读写 v2 目录，不会看到也不懂 v3；
v3 客户端只写 `manifest-v3.json`。迁移后若 `manifest.json` 的 ETag 又变了 → 说明仍有旧版设备在同步，
面板提示“检测到旧版设备，建议全部升级；否则两边数据会分叉”，但**任何一边都不会破坏另一边**。

对象命名一律“内容摘要”，重复上传幂等；`manifest-v3.json` 最后写，写失败旧 manifest 仍指向旧对象。
设备在线状态只记在 manifest 的 `devices` 字段（每次提交流水更新），不额外写对象。

### manifest v3（示意）

```jsonc
{
  "schema": "ms.cloud/3",
  "rev": 42,
  "updatedAt": 1763700000000,
  "updatedBy": "dev-a",
  "appVersion": "7.9.40",
  "devices": {
    "dev-a": { "name": "DESKTOP-A", "platform": "windows", "lastSeen": 1763699990000 }
  },
  "core": {
    "leaves": [
      { "rev": "3-a1b2", "digest": "sha256:...", "bytes": 8200, "device": "dev-a", "ts": 1763699000000, "parents": ["2-c3d4"] }
    ]
  },
  "plugins": {
    "com.mysearch.clipboard": {
      "body": { "leaves": [ { "rev": "5-...", "digest": "...", "bytes": 66500, "device": "dev-a", "ts": ..., "parents": [] } ] },
      "files": {
        "kv/annotations.json": {
          "inline": "{\"t-...\":{\"favorite\":true}}",       // ≤ 2KB，直接内联，改一次只写 manifest
          "leaves": []
        },
        "clipboard/index.json": {
          "leaves": [
            { "rev": "7-...", "digest": "...", "bytes": 317906, "device": "dev-a", "ts": ..., "parents": ["6-..."] },
            { "rev": "7-...", "digest": "...", "bytes": 318100, "device": "dev-b", "ts": ..., "parents": ["6-..."] }
          ]
        }
      },
      "blobs": { "clipboard/a.png": "sha256:..." }
    }
  }
}
```

要点：

- **每文件 leaves**：同一路径多个 leaf = 冲突；单 leaf = 正常。
- `inline` 只给 ≤2KB 且总内联 ≤128KB/插件的小文件，省对象数；超过就落对象。
- `blobs` 按路径引用摘要，多个插件引用同一张图只存一份。
- `devices` 只用于面板显示“哪台设备最后改了什么”，不参与裁决。

---

## 5. 同步算法（无服务器）

### 5.1 本地状态

`sync-state.json` 增加（v3）：

```jsonc
{
  "cloudFormat": 3,
  "manifestEtag": "\"etag\"",
  "files": {                      // 每对象基线（判断“本机改没改”）
    "core": "sha256:...",
    "plugins/com.mysearch.clipboard/body": "sha256:...",
    "plugins/com.mysearch.clipboard/files/clipboard/index.json": "sha256:..."
  },
  "leaves": {                     // 上次见到的 leaf 集合（判断“远端有没有新分支”）
    "plugins/.../files/...": ["7-a", "7-b"]
  },
  "pending": { "com.mysearch.clipboard": { "paths": ["clipboard/index.json"] } },
  "queue": [ { "op": "put", "key": "...", "digest": "..." } ],
  "devices": { "dev-a": { "lastSeq": 12 } }
}
```

### 5.2 一轮同步（Pull → Plan → Push → Commit）

1. **HEAD/GET manifest**（带 ETag）。无变化且本机摘要一致 → 直接退出（只花一次 HEAD）。
2. **逐对象三方比较**：`local` / `base` / `remote leaves`。
   - 只有本机变 → 上传新对象，追加 leaf（parent=base）；
   - 只有远端变 → 下载（或懒加载：`pending`）；
   - 两边都变且 leaf 集合不同 → **不裁决，保留双方 leaf**，标记冲突；
   - 远端删除（tombstone leaf）→ 本机未改则删，改过则保留为新 leaf（冲突）。
3. **上传对象**：先 ensure blob（图片），再 PUT 文件对象/分块；对象名=摘要，重复即幂等。
4. **提交 manifest**：`If-Match` 旧 ETag；412 → 重读 → **按对象合并 leaf 集**（并集，不是指针覆盖）→ 重试一次。
5. **落基线**：只有提交成功才推进 `files/leaves`；冲突挂起项不推进（下一轮还会提示）。

### 5.3 412 合并（v3 的关键差异）

v2 的合并是“本轮上传的片用本机指针，其余用远端”。v3 要改成：

- 对每个对象：把本轮的 leaf 与刚读到的远端 leaf **取并集**（同 `rev` 去重）；
- 若并集 >1，说明真并发：保留全部 leaf，状态标记冲突，不自动选 winner 覆盖；
- 只有 leaf 唯一时才更新“当前指针”，并推进基线。
- **内联小文件**同样参与比较：两边 inline 值都变且不同 → 把其中一份转成对象 leaf（保持可回看），manifest 里保留双 leaf，按文件冲突展示。
- **Rust 侧配套**：`obj_put` 现在只对 `manifest.json` 的 412 返回 `SYNC_CONFLICT`；v3 必须把 `manifest-v3.json` 也加进特判，否则 v3 的 412 会被当成“对象已存在”吞掉，合并逻辑永远不触发。

这样两台设备同时改同一个文件也不会丢内容——两边对象都还在云端，manifest 同时引用。

### 5.4 winner（展示用，不用于删除）

```
1) generation 大者胜（rev 形如 "N-hash"）
2) generation 相同：rev 字典序大者胜
3) 仍相同：deviceId 字典序
```

winner 只决定“默认显示/默认应用”，不删除其他 leaf；用户可随时切换或“保留双方”。

---

## 6. 冲突处理与保留

- **检测**：同路径多个 leaf；或本机改动 + 远端 leaf 不在基线里。
- **保留**：leaf 指向的对象一直留在云端（内容寻址，不需要额外复制）；GC 只删“无 leaf 引用且超过宽限期”的对象。
- **展示**：面板“冲突”页按插件 → 文件列出；JSON/文本行级 diff（左右两栏），二进制显示大小/哈希/预览。
- **动作**：
  - 用本机 / 用云端：生成新 revision（`parents=[所有 leaves]`，generation+1），leaf 集收敛为 1；
  - 保留双方：把另一边写成 `path.conflict-<device>-<ts>`（同目录），两边都保留；
  - 撤销：从历史 leaf 恢复（保留最近 5 个 leaf，30 天）。
- **自动收敛**：两边内容摘要相同 → 自动合并为一个 leaf，不打扰用户。
- **冲突隔离**：文件级；一个文件冲突只挂起该文件，其它文件/插件照常同步（v2 的插件级隔离是下限，v3 提升到文件级）。

---

## 7. 细粒度传输

### 7.1 文件对象

- 常规文件（≥2KB 或不能内联）各自一个对象：`plugins/<id>/files/<pathHash>-<digest>.msf`；
- `pathHash = sha256(相对路径)[0:16]`，避免路径过长/非法字符；
- 小文件内联进 manifest（≤2KB，单插件合计 ≤128KB），改一次只写 manifest，不产生对象。

### 7.2 大文件：CDC 分块（P2）

针对“一个 320KB 的单文件每次整传”的场景：

- 用内容定义分块（FastCDC，平均 64KB，最小 16KB，最大 256KB）；
- 文件对象变成 `{ chunks: [digest...], bytes }`；每块独立对象、全局去重；
- 追加/插入只影响 1–2 个块，重传 ≈ 64–128KB；
- 还原时按顺序拼接并校验整体摘要；
- 单文件上限 64MB（超过走 blob/流式，不 CDC）。

### 7.3 剪贴板按条拆分（同步层虚拟拆分，已落地）

不改插件本地存储格式，仍在磁盘上保留一个 `clipboard/index.json`（插件读写零改动），
由 `plugin.json` 声明：

```json
"backup": {
  "pluginData": ["kv", "clipboard/index.json"],
  "blobs": ["clipboard"],
  "itemized": [{
    "file": "clipboard/index.json",
    "itemsKey": "items",
    "idField": "id",
    "dir": "clipboard/items",
    "filter": { "retained": true },
    "blobFields": ["relPath"]
  }]
}
```

Rust 扫描时只把 `filter` 命中的条目（剪贴板里就是收藏/分类，插件通过
`setRetained` 标记为 `retained:true`）虚拟成 `clipboard/items/<id>.json`；
普通历史留在本机，不产生对象。`blobFields: ["relPath"]` 让 blob 层只收集
这些被选中条目引用的图片，而不是 `clipboard/` 下所有图片。
`kv/annotations.json` 仍是独立文件（收藏/分类改一次只传 78B 级小对象）。

下载时把选中条目合并回 `index.json`，而不是让插件去读一个它并不认识的
`items/` 目录；旧版插件/旧归档仍能读原索引。

**效果**：只有收藏/分类条目及其图片上云；普通复制不产生新对象，
云端占用由「全部历史 + 全部图片」降到「2 条收藏 + 65KB 插件本体」量级。
v2 兼容层仍按旧 `data` 片全量同步（`manifest.json` 只读，不参与 v3 裁剪）。

### 7.4 Blob 层

- `blobs/<sha256[0:2]>/<sha256>`，全局去重；
- 上传文件对象前先 ensure 其引用的 blob；
- 缺失返回 `BLOB_PENDING`，后台补传，不阻塞其它对象；
- 图片 ≤512KB 可打包（`packs/<id>/<packId>.bin`，单包 ≤16MB，死数据 >50% 重写）；
- 导出默认含图；GC 依据 manifest 引用 + 7 天宽限。

---

## 8. 作用域：设备级 / 账号级

新增 `src/lib/sync/scope.ts`：

```ts
type SyncScope = "account" | "device" | "never";
```

| 类别 | 默认 | 例子 |
|---|---|---|
| account | 同步 | 主题、代理、插件数据、剪贴板收藏/分类、AI 会话 |
| device | 不同步 | 开机自启、窗口尺寸/位置、插件排序、开发挂载项目、市场缓存、托盘行为 |
| never | 不同步且不进备份 | GitHub Token、同步密码、设备 id、本地日志 |

- localStorage：由 `shouldSyncKey` 升级为 `scopeOfKey`（保留现有黑名单，新增 device 名单）；
- Rust 设置：`BACKUP_SETTINGS_KEYS` 拆为 account/device 两组，`autostart`、窗口相关移到 device；
- 插件：`plugin.json` 增加 `backup.scope`（`dataScope: "account" | "device"`），默认 account。
- 面板提供“高级：把本机专属设置也同步”开关，默认关，避免误覆盖。

---

## 9. 实时性

### 9.1 WebDAV 自适应轮询（P1）

- 窗口聚焦且 5 分钟内有交互：每 **4 秒** `HEAD manifest-v3.json`（带 `If-None-Match`，304 几乎零成本）+ 抖动；
- 空闲：30 秒；
- 后台/最小化：5 分钟（可配置）；
- 本地写入：2 秒防抖后直接跑一轮（合并短时间多次改）。
- 预计：同网 WebDAV 下 5 秒内感知，跨网 10–30 秒。

### 9.2 可选：局域网直连（P3，默认关）

- 发现：UDP 广播 + mDNS（`_mysearch._tcp`），TXT 带 `deviceId`、`vaultId`、`version`；
- 身份：每设备 Ed25519 密钥对；首次配对用 6 位码/二维码，公钥存本地信任表；
- 传输：TCP + X25519 ECDH + ChaCha20-Poly1305（不做明文 HTTP），消息复用 v3 的 manifest/对象格式；
- 合并：交换 leaf 向量 → 取并集 → 双方本地写入；之后各自决定是否推 WebDAV；
- 安全：仅同子网、配对后可用、可随时撤销；不做公网打洞、不做中继；
- 降级：P2P 失败 → 无感回退 WebDAV 轮询。
- **完全没有 WebDAV 时**：提供“导出增量包”（`.msdelta`，只含未同步对象 + manifest 片段）→ 通过 U 盘/局域网共享/二维码（小包）传递，另一端导入。这是跨网络、零服务器的最后兜底，但需要人工搬运，不承诺自动化。

---

## 10. 安全

1. **凭据**：改用 OS 凭据库（`keyring` crate；Windows DPAPI / macOS Keychain / Linux Secret Service）；迁移时读旧 `sync-credentials.json` → 写入凭据库 → 删除明文文件。绝不进备份、不进 manifest。凭据库不可用时退化为“机器绑定的加密文件”（DPAPI/Keychain 派生密钥），不再接受明文。
2. **对象校验**：下载后校验摘要与长度；ZIP 解包限制条目数/总大小/路径穿越（已有基础，v3 保持）。
3. **manifest 防御**：schema 校验、插件 id 白名单字符、路径规范化、leaf/对象数量与体积上限、重复 digest 去重、拒绝绝对路径与 `..`。
4. **版本拦截**：读到未知 `schema`（如未来 `ms.cloud/4`）**只读不写**，提示升级；绝不覆盖。v2 与 v3 用不同 manifest 文件，旧版客户端不会误读 v3。
5. **可选端到端加密（P4）**：Argon2id 派生 + XChaCha20-Poly1305，对象名用 HMAC 摘要，manifest 加密；开启后 WebDAV 网页端不可读、面板需先解锁；默认关。
6. **可选 manifest 签名（P4）**：设备 Ed25519 对 manifest 签名，读取时校验信任设备集合；防存储方篡改。

---

## 11. 配额、GC、体积治理

- 单插件 200MB（沿用）、单文件 64MB、manifest ≤2MB、单插件对象数 ≤20k、总对象数 ≤100k；
- 面板显示：manifest 体积、对象数、每插件占用、blobs 占用、待 GC 数；
- GC（客户端执行，需用户确认或自动低峰）：
  - 引用集 = manifest 所有 leaf 的 digest + blobs 引用 + 保留历史；
  - 未引用且 `lastSeen > 7 天` 才删；
  - **迁移兼容期**：`manifest.json` 及其引用的 v2 对象一律不删，直到用户确认“停用 v2 并归档”；
  - 两阶段：先标记（写 `gc/mark-<ts>.json`），7 天后真删；可 dry-run；
- 历史保留：活跃 leaf ≤8；收敛后的历史 leaf 保留最近 5 个 / 30 天，超出后只保留 winner；
- 删除传播：tombstone leaf 参与引用，避免“删了又被旧设备复活”。

---

## 12. 迁移 v2 → v3

1. **只读探测**：v3 客户端读 `manifest.json`（`schema: "ms.cloud/2"`）→ 进入迁移；把旧 manifest 复制为 `manifest-v2.backup.json`，**`manifest.json` 本身保持不动**（旧客户端继续用）。
2. **拆片**：只读下载每个 `data` 片（一次性），解包后按文件拆成 v3 对象：
   - 小文件内联；大文件对象；图片进 blobs；
   - v2 的 `core` / `body` 对象与 v3 兼容，可直接复用摘要，不重复上传；
   - 记录 v2 摘要 → v3 对象映射，失败可重试/续跑。
3. **写 `manifest-v3.json`**：`schema: "ms.cloud/3"`，`devices` 初始化本机；`legacyV2` 记录旧 manifest rev/etag。
4. **兼容期**：v2 对象保留 30 天；v3 客户端**只读不写** `manifest.json` 与 v2 data 对象。

**P1-mini 实际迁移（已落地）**：不走“下载 v2 data 片再解包拆文件”的重路径，而是
先让 `runV2Round` 完成一轮（复用 v2 的懒下载、冲突裁决、`pre-remote` 留底），
本机与旧云端对齐后直接 `cloud_v3_scan` 建 v3。`core` / `body` 摘要直接复用，
不重传；`manifest.json` 保持不动；`legacyV2` 记录旧 rev / updatedAt。
v3 每一轮会顺带检查旧客户端是否在 v3 之后又提交过 v2，若是只给警告、不自动合并，
避免两边各看一半还静默覆盖。
5. **回滚**：面板“停用 v3”→ 删除/重命名 `manifest-v3.json` 即可回到 v2；`manifest.json` 从未被改过。
6. **混合版本**：旧客户端读不到 `manifest-v3.json`，不会误写；若 `manifest.json` ETag 变化 → 提示“仍有旧版设备在同步，两边会分叉”。
7. **未来 schema**：v3 客户端遇到未知 `schema`（如 `ms.cloud/4`）→ 只读拒绝写入，提示升级。

迁移验收：用剪贴板（90 文件/10.9MB）+ 资源监视器（大 body）各跑一遍；断点续跑；迁移后收藏/分类可读；两设备交叉同步无重复对象；旧版客户端仍能正常同步 v2（不受 v3 影响）。

---

## 13. 分阶段实施

### P0 安全底座（2–4 天）

| 项 | 改动 | 验收 |
|---|---|---|
| 设备/账号作用域 | `scope.ts`、`snapshot.ts`、`BACKUP_SETTINGS_KEYS` 分组、面板提示 | 两台设备不同 `autostart`，互不覆盖；主题仍同步 |
| 凭据 OS 级保护 | 独立 `credential_store.rs`：Windows DPAPI（当前用户 + 本机绑定），Unix 0600 回退；兼容旧明文并自动迁移 | 删除 `sync-credentials.json` 后仍能同步；文件不再含明文 |
| v2 冲突保留（过渡） | 覆盖本机前写 `backups/pre-remote-*`；面板显示快照并可打开备份目录 | 选“用云端”后能找到本机旧版 |
| 设备表 | manifest `devices` + 面板显示最后提交设备/时间 | 面板显示设备名与提交时间 |

**P0 实施记录（已完成，2026-11-20）**

- `src/lib/sync/scope.ts`：`account / device / never` 三档；设备级含 `RECENT_ATTACH_KEY`、`auto_download_update`、`PLUGIN_DATA:*:viewSize`；**注册表按记录处理**——`source.dev === true` 的开发挂载记录上传前改写为普通安装副本（`dir=plugins/<id>`、`source.kind=file`），插件文件仍随 body 片同步；还原时同 id 用本机 dev 记录覆盖，新设备则拿到可运行副本。对应 `PLUGIN_DATA:*` 按设备数据、不跨机。
- `src/lib/sync/snapshot.ts`：采集/还原/修剪统一走 `scopeOfKey`，不再维护第二套黑名单；`shouldSyncKey` 委托给作用域模块。
- `src-tauri/src/credential_store.rs`：Windows 用 `CryptProtectData`（`CRYPTPROTECT_UI_FORBIDDEN` + 固定熵）；文件格式 `{v:2,cipher:"dpapi",data}`；旧 `{password}` 首次读取自动升级；Unix 保持 0600 明文回退。DPAPI 往返单测已过。
- `src-tauri/src/lib.rs`：`autostart_enabled` 移出 `BACKUP_SETTINGS_KEYS`（设备专属），旧归档即使带该键也不写、不应用；单测改口径。
- `src-tauri/src/sync_state.rs`：新增 `deviceName`（电脑名），旧状态文件自动补齐。
- `src/lib/sync/cloud.ts`：manifest `devices` 表在 bootstrap / 全量推送 / 稳态提交 / 412 合并四处维护；真正落地下载前写 `pre-remote-` 快照并写入 `lastLocalBackupPath`。
- `PanelSync.vue`：冲突区显示“覆盖前的本机快照 + 打开备份目录”，WebDAV 卡片显示“最后提交：设备名，时间”。
- 验证：`npm run typecheck`、`npm run build`、`node test/cloud-sync-v2.test.mjs`（68）、`node test/sync-panel-ui.test.mjs`（66）、`node test/sync-scope.test.mjs`（54）、`node test/sync-snapshot.test.mjs`（27）、`cargo test --lib`（186 通过 / 6 ignored）、DPAPI 与备份白名单单测均在其中。

> 说明：P0 没有引入 `keyring` crate，是为了不新增网络依赖并保持现有构建链稳定；Windows 上 DPAPI 已满足“文件不含明文、绑定当前用户”。macOS Keychain / Linux Secret Service 可在后续以新的 `cipher` 值接入，不影响现有文件格式。

### P1 v3 内核（8–12 天）

| 项 | 改动 | 验收 |
|---|---|---|
| manifest v3 + leaves | `cloud.ts` 拆 `manifest.ts` / `plan.ts`；`sync_state.rs` 白名单 | 同文件并发保留 2 leaf；不同文件并发零冲突 |
| 每文件对象 + 内联 | `backup.rs` 收集/打包/还原；`cloud.ts` 计划器 | 剪贴板改 1 条只传 1 个小对象（或仅 manifest） |
| 剪贴板按条拆分 | `plugins/clipboard`：`clipboard/items/<id>.json` + `meta.json`；`backup.pluginData` 仍声明 `["kv","clipboard"]` | 复制 1 条：上传 ≤2KB；收藏/分类仍落在 `kv/annotations.json` |
| blob 层 | `cloud_sync.rs` 对象、`backup.rs`、面板 | 两插件同一图只存一份；缺失补传 |
| 删除 tombstone | leaf `deleted` + 还原修剪 | A 删配置，B 未改 → B 也删；B 改过 → 冲突 |
| 冲突 UI + diff | `PanelSync.vue`、`style.css` | 行级 diff 正确；保留双方可用 |
| 迁移 | `migrateV2`、备份/回滚 | 旧云端可升级、可回滚；旧客户端拒绝写 |

**P1-mini 实施记录（已完成，2026-11-20）**

这一轮没有把 P1 一次铺满：先落「manifest-v3 + 每文件对象 + 内联 + 剪贴板仅收藏/分类 + 图片 blob」，
leaves / 行级 diff / tombstone / CDC 留结构后置。这样先把**真实痛点**（354KB/次、图片不同步）
解决，同时不把多 leaf 状态机和冲突 UI 一起拖进来。

- `src/lib/sync/cloud-v3.ts`（新建）：v3 计划器与轮次。三方比较（本机 / 远端 / 基线），
  每文件独立上传/下载，≤2KB UTF-8 内联，`history` 保留最近 8 个旧对象引用；
  双边改同一文件挂起为插件级冲突，不静默覆盖。
- `src/lib/sync/cloud.ts`：`runCloudRound` 改为入口分流：`cloudFormat !== 3` 走原 v2；
  没有 `manifest-v3.json` 时先跑一轮 v2 把本机与旧云端对齐，再建立 v3。旧 `manifest.json` 保持只读。
- `src-tauri/src/cloud_sync.rs`：新增 `cloud_v3_scan`、`cloud_v3_file_put/get/delete`、
  `cloud_v3_blob_put/get`、`cloud_manifest_v3_get/put`。对象名
  `plugins/<id>/files/<pathHash>-<digest>.msf`、`blobs/<sha256[0:2]>/<sha256>`；
  下载前校验 SHA-256，manifest 上限 2MB。
- `src-tauri/src/backup.rs`：`plugin_backup_policy` 读 `backup.blobs` / `backup.itemized`；
  `collect_plugin_blob_files` 只收显式前缀、排除 `pluginData` 已覆盖文件；
  `itemized` 的 `filter` / `blobFields` 让只同步被选中条目及其引用图片；
  内置剪贴板旧安装副本缺字段时自动补默认策略，不要求用户先重装插件。
- `plugins/clipboard/plugin.json`：新增 `blobs: ["clipboard"]` 与 `itemized` 声明，
  并用 `filter: { "retained": true }` 只同步收藏/分类条目、`blobFields: ["relPath"]`
  只同步这些条目的图片；本地仍写一个 `index.json`，同步层虚拟拆成
  `clipboard/items/<id>.json`，下载时合并回索引，插件零改动、旧归档仍可读。
- `src-tauri/src/sync_state.rs`：新增 `v3` 基线字段（core / 每插件 body / state / files / blobs），
  `sync_state_patch` 白名单放行；旧状态文件自动补 `null`。
- `src-tauri/src/cloud.rs`：`SyncConfig.cloudFormat` 默认 3，旧配置自动升级；
  保留 `2` 作为回滚开关。
- `PanelSync.vue` / `cloud.ts`：面板改为「云端对象」，v3 直接列 manifest 里的文件/图片清单
  （不下载分片）；显示 `v3 文件级`、每插件文件数/图片数；旧客户端在 v3 后提交 v2 时给警告。
- 验证：`npm run typecheck`、`npm run build`、`node test/cloud-sync-v2.test.mjs`（68）、
  `node test/cloud-sync-v3.test.mjs`（41）、`node test/sync-panel-ui.test.mjs`（74）、
  `node test/sync-scope.test.mjs`（54）、`node test/sync-snapshot.test.mjs`（27）、
  `cargo test --lib`（191 通过 / 6 ignored）。

**本轮明确没做**：多 leaf 合并与 diff UI、tombstone 删除传播、CDC 大文件分块、
按插件懒下载、云端孤儿对象 GC、macOS Keychain / Linux Secret Service。
这些不影响 P1-mini 的正确性；等真实多设备并发或对象数上来再补，避免提前背复杂度。

### P2 细粒度与治理（4–6 天）

- CDC 分块（大文件）、摘要缓存（`(mtime,size)→digest`）、对象数/体积上限、GC（两阶段 + dry-run）、面板配额；
- 验收：320KB 大 JSON 追加 1 条上传 ≤128KB；10k 对象 GC 不误删。

### P3 可选局域网 P2P（8–15 天，默认关）

- 发现/配对/传输/合并/降级；只在同子网、配对设备间启用；
- 验收：断公网仍能两机同步；P2P 失败自动回退 WebDAV；无明文传输。

### P4 可选端到端加密 / manifest 签名（4–8 天）

- 默认关；开启需密码短语；关闭需解密迁移；
- 验收：WebDAV 上无明文；换设备输入短语可恢复；面板可解锁查看。

### 改动落点（文件级）

| 层 | 文件 | 改什么 |
|---|---|---|
| 计划器/轮次 | `src/lib/sync/cloud.ts`（建议拆 `cloud/manifest.ts`、`cloud/plan.ts`、`cloud/round.ts`） | manifest v3、leaf 合并、每文件计划、迁移入口 |
| 快照/作用域 | `src/lib/sync/snapshot.ts` | `scopeOfKey`、文件收集、内联/对象判定 |
| 宿主 | `src/lib/sync/host.ts` | 自适应轮询调度、冲突裁决（文件级）、队列 |
| 类型/IPC | `src/lib/sync/bridge.ts` | v3 类型、`files/leaves`、blob 命令、`sync_state_patch` 白名单 |
| 对象层 | `src-tauri/src/cloud_sync.rs` | blob/对象 PUT/GET、manifest 守卫、`If-Match`、507 |
| 打包/还原 | `src-tauri/src/backup.rs` | 每文件打包、内联、CDC、blob 引用、还原 |
| 持久化 | `src-tauri/src/sync_state.rs` | `files/leaves/pending/queue/devices`、v3 字段、迁移标记 |
| 心跳 | `src-tauri/src/sync_service.rs` | 轮询间隔（前台/空闲/后台） |
| 面板 | `src/windows/config/panels/PanelSync.vue` + `src/css/style.css` | 冲突 diff、保留双方、设备表、对象数/清单体积 |
| 剪贴板 | `plugins/clipboard/ui/index.js` + `plugin.json` | 按条文件、`items/` 目录、兼容旧 `index.json` 读取 |
| 测试 | `test/cloud-sync-v3.test.mjs`、`test/sync-panel-ui.test.mjs`、`src-tauri` 单测 | 见下 |

### 测试与文档（贯穿，约占 30%）

- `test/cloud-sync-v3.test.mjs`（41 条，已落地）：三方决策表、首次建立、无变化不提交、
  剪贴板加一条只传一条、图片 blob 下载、双边冲突挂起、v2→v3 迁移；
- `test/sync-panel-ui.test.mjs`（74 条，已落地）：v2 回退布局 + v3 文件级卡片（真实 manifest-v3 桩）、
  文件/图片计数、虚拟条目清单；截图 `test/_shot-sync-panel-v3.png`；
- Rust `cargo test --lib`（191 通过 / 6 ignored，已落地）：v3 对象名/内联阈值/虚拟条目路径/条目 upsert/remove；
- 文档：`docs/cloud-sync-v3-plan.md`（含 P0/P1-mini 记录）、`docs/cloud-sync-v2.md`、README、CHANGELOG。

> 未覆盖（P2 再补）：leaves 合并、tombstone 删除传播、CDC 拼接、GC 不误删、恶意 manifest 的模糊测试。

---

## 14. 关键权衡

| 选择 | 代价 | 缓解 |
|---|---|---|
| 每文件对象 | WebDAV 请求数上升（一次同步几十~几百 PUT/GET） | 小文件内联、并发 4、批量计划、按需懒加载 |
| manifest 变重 | 每设备首轮读全量 | manifest ≤2MB 上限；内联阈值；按插件分页可选 |
| 多 leaf | 状态复杂、UI 复杂 | leaf ≤8、相同摘要自动收敛、默认 winner 展示 |
| CDC | CPU、实现复杂 | 只对 >64KB 文件、进程内缓存、单文件 64MB 上限 |
| 自适应轮询 | WebDAV 压力/耗电 | 前台 4s、后台 5min、304、抖动、可配置 |
| 局域网 P2P | 安全面、NAT/防火墙 | 默认关、同子网、配对、加密、失败回退 |
| E2E 加密 | 面板/网页不可读、迁移复杂 | 默认关、明确提示、导出需短语 |

---

## 15. 需要你拍板的决策点

1. **WebDAV 是否算“中心服务器”**？
   - 若算：跨网络同步只能靠局域网直连或人工传递；本方案 P3 变主线。
   - 若不算（推荐）：WebDAV 是用户自有存储，方案按 P0 → P1 → P2 推进。
2. **是否接受 v3 破坏性 schema**（旧版本只读拒绝）？推荐接受，换来文件级冲突与历史。
3. **冲突保留策略**：每对象保留 5 个 leaf / 30 天，是否合适？
4. **是否做端到端加密**（P4）？做了面板就看不到云端明文，需要解锁流程。
5. **优先级**：推荐 P0（作用域 + 凭据 + 保留）→ P1（v3 内核）→ P2；P3/P4 视需要。

---

## 16. 一句话总结

不引入任何厂商服务器：把“协调”压在 `manifest-v3.json` 一个提交点上，把“粒度”降到文件/块，把“冲突”从覆盖改成多 leaf 保留，把“设备差异”从全量同步改成作用域，把“实时”交给自适应轮询 + 可选局域网直连。这样既拿到 ZTools 同步内核的优点（细粒度、不丢版本、可 diff），又不背它的账号、MySQL 和中心服务。
