# 录屏与水印（com.mysearch.recorder）

屏幕录制 + 给视频加水印，两个能力共用一套水印配置。重活交给 **ffmpeg**——
插件会在首次使用时**自动下载自带一份**，装上即可用，无需你手动配置环境。

## 全局快捷键（`Ctrl+Alt+R` 开始 / 停止）

清单里用 `contributes.shortcut` 声明了一个**插件自定义动作**：

```jsonc
"shortcut": { "action": "record-toggle", "title": "录屏（开始 / 停止）", "defaultShortcut": "ctrl+alt+r" }
```

装上本插件后，「设置 → 快捷键」的作用类型里会出现「录屏（开始 / 停止）」，
并自动绑好 `Ctrl+Alt+R`（键被占用则跳过，可自行录入）。

按下热键的流程（与截图 / 剪贴板这类宿主原生动作不同，录屏的执行逻辑在插件自己里）：

1. 宿主把主窗口带到前台并**打开/恢复录屏插件视图**；
2. 宿主把动作名 `record-toggle` 派发给插件脚本（Rust 广播
   `my-search://shortcut-plugin-action`，前端 `dispatchShortcutAction`）；
3. 插件用 `ms.shortcuts.onAction("record-toggle", fn)` 接住，执行
   **没在录 → 开始；在录 → 停止**（一个键开关）。

```js
if (ms.shortcuts && typeof ms.shortcuts.onAction === "function") {
  ms.shortcuts.onAction("record-toggle", function () { toggleRecording(); });
}
```

> 细节：视图可能是被快捷键**冷启动**拉起的（脚本刚跑、`boot()` 还没探完 ffmpeg 能力）。
> 此时动作先记成 `pendingToggle`，等 `boot()` 完成（`capsReady`）后再执行，避免「按了没反应」。
> 卸载插件时该作用类型与绑定、系统热键一并移除。

## 目录结构

```
plugins/recorder/
├── plugin.json              清单（权限、搜索项、backend 声明）
├── meta.json                市场元数据（categories/tags）
├── icon.svg
├── ui/
│   ├── detail.html          四个页签：录屏 / 加水印 / 作品库 / 设置
│   ├── detail.css           自动作用域注入的样式
│   └── index.js             前台控制器（收参数 → ms.backend.call → 展示进度）
└── backend/
    ├── index.mjs            JSON-RPC stdio 主循环（读配置、驱动 ffmpeg、管产物）
    ├── downloader.mjs       下载 / 校验 / 解包自带的 ffmpeg
    ├── ffmpeg.mjs           定位 ffmpeg/ffprobe（自带 → 缓存 → 环境变量 → PATH → 常见目录）
    ├── ffmpeg-args.mjs      录屏/转码参数拼装（纯函数，可单测）
    ├── watermark.mjs        水印规格 → ffmpeg 滤镜（纯函数，可单测）
    ├── run.cmd / run.sh     启动器（ASCII-only）
    └── package.json         零依赖
```

## ffmpeg 从哪来

插件**自带** ffmpeg——但不是在安装包里塞二进制，而是**首次使用时下载**：

```
1. 打开插件 → 顶部状态条显示「尚未准备好 ffmpeg」→ 点「一键下载」
2. 从官方构建源流式下载 → 解包 → 校验可运行 → 落到插件私有目录
3. 之后每次都用这一份（版本可预期、随插件卸载一起清理）
```

### 为什么不直接打进插件包

宿主安装管线对**单文件有 64MB 上限**（`src-tauri/src/plugin_host.rs` 的
`MAX_FILE_BYTES` 与前端 `package.ts` 的 `MAX_ENTRY_BYTES`），而完整版
`ffmpeg.exe` 通常 80–130MB——**装不进 `.mspp`**。下载方案还能按平台分发
对应构建（Windows/macOS/Linux），且不把几十 MB 二进制提交进 git。

### 下载源与安全

| 平台 | 源 | 包 |
|---|---|---|
| Windows | BtbN/FFmpeg-Builds（GitHub Release） | `ffmpeg-master-latest-win64-gpl.zip` |
| macOS | evermeet.cx | `getrelease/zip` |
| Linux | johnvansickle.com | `ffmpeg-release-<arch>-static.tar.xz` |

分层校验，任何一层不过就**丢弃整包**：

1. **URL 白名单**——必须 https、主机在允许列表内、无 userinfo、端口为 443
   （防清单被篡改后指向任意地址）；
2. **sha256**——清单给了 `expectedSha256` 就强校验（当前构建源无稳定摘要，
   留作将来加签）；
3. **能真的跑起来**——解包后执行 `ffmpeg -version`，这是最终防线：
   「文件在」不等于「是可执行文件」。

> 解包用系统自带工具（Windows 的 `tar.exe`、macOS/Linux 的 `unzip`/`tar`），
> 因为 Node 没有内置 zip/xz 解压，而引入 npm 依赖会破坏「后端零依赖」前提。

### 连不上 github.com 时的自动换路（实测踩到的坑）

很多网络环境**能通 GitHub 的 CDN，却连不上 `github.com` 本身**。实测：

```
github.com:443                            → 超时
api.github.com:443                        → 通
release-assets.githubusercontent.com:443  → 通
evermeet.cx / johnvansickle.com           → 超时
```

此时直接 GET 资产地址会在**建连阶段**就挂掉（`UND_ERR_CONNECT_TIMEOUT`），
用户看到的只有一句「下载失败」。

所以下载器会**先试直连，失败后自动改走 API 换算直链**：

1. `api.github.com/repos/<o>/<r>/releases/tags/<tag>` → 拿到资产 id；
2. `api.github.com/repos/<o>/<r>/releases/assets/<id>`，
   带 `Accept: application/octet-stream` → 返回 **302 + Location 指向 CDN**；
3. 用该直链重新下载（换算出的地址**仍要过一遍白名单**，
   防止 API 被劫持后把我们导向任意地址）。

整个过程界面上会显示「已切换到镜像直链 <host>」，而不是让人对着卡住的进度条猜。

### 下载前的磁盘空间预检

完整包接近 200MB（Windows 实测 186.9MB），解包时还要再占一份，合计约 530MB。
磁盘写满时 `fetch` 会在中途抛 `ENOSPC`，同样只会显示「下载失败」。

因此下载**开始前**先查目标卷可用空间：不足就直接给出可读的错误
（「磁盘空间不足：所在分区只剩 X，需要约 Y」）并提示「手动指定」这条不占空间的退路。
探测不到可用空间时不拦截——**宁可不拦，也不要因为探测失败误杀**。

### 三种使用方式（优先级从高到低）

1. **你手填的路径**（设置页）——最高，明确指定就听你的；
2. **插件自带那份**（下载到私有目录）——保证「装完就能用」；
3. **系统探测**——缓存路径 → `FFMPEG_PATH` 等环境变量 → `where`/`which`
   → 常见安装目录（scoop / choco / winget / Homebrew / `/usr/local/bin` …）。

因此：你**已经装过 ffmpeg** 也可以直接用（把设置页的路径留空走自动探测即可）；
想强制用某一份就在设置页填它的路径。

### 为什么不能自动调用 PATH 里的 ffmpeg

宿主启动插件后台进程时**刻意不继承 `PATH`**（`plugin_host.rs`：避免插件顺走
PATH 里的凭据）。所以后端里裸调 `ffmpeg` 必然 `ENOENT`，哪怕命令行里明明能用。
`backend/ffmpeg.mjs` 因此一律按**绝对路径**探测。

## 功能

### 1. 录屏（可选实时水印）

- **采集后端**：Windows 优先 `ddagrab`（Desktop Duplication，GPU 直出帧），
  探测不可用或**多屏**时自动退回 `gdigrab`；macOS `avfoundation`、
  Linux `x11grab`。
  为什么默认不再是 gdigrab：它的 `BitBlt(SRCCOPY|CAPTUREBLT)` 每帧都要
  「隐藏光标 → 拷屏 → 再显示」，录屏时鼠标会一直闪（微软文档与 python-mss
  issue #179 都记录了这个行为），而且没有任何开关能关掉 CAPTUREBLT；
  ddagrab 不走 GDI 合成层，光标由 GPU 直接合成，没有这个问题。
  探测（滤镜是否可用、是不是单屏）跑两帧存进 `config.json`，结果与当前
  选用的后端在「设置」页如实展示；`config.json` 里写 `captureBackend`:
  `"gdi"` / `"dda"` 可强制指定。
- **区域**：全屏，或自定义 `x/y/宽/高`（宽高自动取偶数——libx264 的
  yuv420p 要求，奇数会直接失败）。点「框选区域…」有两条路：
  1. **屏幕上直接拖**（首选）：调宿主的 `ms.screenshot.pickRegion()`，
     与截图热键同一套全屏遮罩，松手即回物理像素矩形、遮罩自动关闭；
     Esc 取消则不动现有坐标。需要 `screenshot.overlay`（全屏框选遮罩）权限。
  2. **面板内截图框选**（兜底）：未授权、宿主版本不支持时自动改走这条——
     后端冻结一张桌面截图，用户在图上拖出矩形，按「图上像素 → 物理屏幕像素」
     换算回坐标。
  两条路的结果都会写进区域输入框，模式/坐标/边框开关跨会话记住。
- **录制时的区域边框**：自定义区域录制时，屏幕上会常驻一圈画在录制框
  **外侧** 3px 的边框（`backend/region-border.ps1`，置顶且点击穿透），
  全程提示「正在录这一块」——因为在录制矩形之外，它不会被录进视频；
  不想要可在区域设置里取消勾选。
- **参数**：帧率（15/24/30/60）、编码器（libx264 推荐，mpeg4 兜底）、是否录鼠标。
- **计时**：界面计时以后端 `record:tick`（每 500ms 一拍）为准，
  暂停期间**冻结**、恢复后继续，与 `record:ended` 回报的产物时长同一口径。
- **实时水印**：水印作为 ffmpeg 滤镜在**编码时烘焙进画面**（不是后处理），
  所以录制过程中就带水印，代价几乎为零。
- **产物**：`<app_data>/plugin-data/com.mysearch.recorder/recordings/rec-*.mp4`。
  使用 `-movflags +faststart`，即使录制中断，已写入的部分通常仍可播放。

### 2. 给已有视频加水印

- 入口：拖文件到页面、粘贴到搜索框（本插件声明了 `handlers.files`）、
  或直接填绝对路径。三处都会自动读取视频元数据（分辨率/时长/帧率/编码）。
- 转码：`libx264 -crf`，音频 `-c:a copy`（不重编码，省时间不损质）。
- 进度：解析 ffmpeg 的 `-progress` 输出 → 实时进度条；可中途取消。

### 3. 水印配置（可保存预设）

| 项 | 说明 |
|---|---|
| 类型 | 文字 / 图片（Logo，建议带透明通道 PNG） |
| 文字 | 内容；可附加时间戳（录制用挂钟 `%{localtime}`，转码用视频进度 `%{pts}`） |
| 位置 | 九宫格（左上…右下/居中）+ 边距（占视频高度百分比） |
| 字号 | 占视频高度百分比——**随分辨率自适应**（1080p 上 4% ≈ 43px） |
| 外观 | 颜色、不透明度、描边（浅色背景上保持可读） |
| 中文字体 | 可显式指定字体文件，避免 drawtext 中文显示成方块 |

字号用**相对百分比**而非固定像素，是刻意的：同一个水印在 4K 和 720p
上视觉大小一致，否则固定像素在小视频上大得离谱、在大视频上小得看不见。

界面里的 canvas 预览与后端 ffmpeg 用**同一套定位/字号语义**
（`watermark.mjs` 的 `previewBox`/`previewFontSize` 与 `ui/index.js`
的 `anchorXY` 对齐），因此预览位置 ≈ 导出位置。两边都由
`test/recorder-plugin.test.mjs` 断言，防止改一边忘另一边。

预设存在 `ms.store`（localStorage，按插件 id 隔离），可保存/套用/删除。

## 权限

| 权限 | 用途 |
|---|---|
| `ui.inlay` | 详情视图 |
| `ui.notify` | 完成/失败的浮层提示 |
| `store` | 保存水印预设与界面偏好 |
| `file.read` | 读搜索框附件里的视频路径与元数据 |
| `backend.spawn` | **极高风险**：拉起后端进程与 ffmpeg，安装时需逐项确认 |
| `screenshot.overlay` | 屏幕上直接框选录制区域（宿主全屏遮罩）；未授权时自动退回面板内截图框选 |

> 下载 ffmpeg 走的是**后端进程自己的网络请求**（Node 原生 `fetch`），
> 不需要给插件前端额外的 `net.fetch` 权限——前端 JS 依然碰不到网络。

安全边界（后端侧）：

- 只读写 `MS_PLUGIN_DATA_DIR` 下的 `recordings/` 与 `ffmpeg/`，相对路径经
  `absOf()` 校验（拒绝 `..` 与子目录），从根上杜绝目录穿越；
- ffmpeg 一律**绝对路径**调用，参数用数组经 `execFile`/`spawn` 传递，
  不拼 shell 字符串，规避注入；
- 下载只允许白名单 https 主机；解包后必须能运行才留下；
- 录制与转码各自只允许一个并发任务，避免多个 ffmpeg 抢屏幕/磁盘。

## 已知限制

1. **首次需联网下载**（Windows 约 187MB，解包+落地约需 530MB 空闲空间）。
   若在离线环境：自行安装 ffmpeg 后在「设置」页指定路径即可，功能完全等价。
   注意 `evermeet.cx`（macOS）与 `johnvansickle.com`（Linux）在部分网络下也不通，
   届时同理需要走「手动指定」。
2. **暂停是「逻辑暂停」**：gdigrab 与 ddagrab 都无法真正暂停采集，当前实现
   记录累计暂停时长用于修正界面计时与产物时长口径，但画面里仍包含暂停期间
   的内容（时间戳水印已跳过这段时间）。真要分段，需改为「停止 → 起新文件 →
   合并」，尚未实现。
3. **多屏下退回 gdigrab**：ddagrab 一次只能取一个显示器，且其 `offset_x/y`
   是**输出本地坐标**、`output_idx` 与系统显示器顺序没有可靠对应关系；
   为避免「静默录错屏幕」，多屏时自动退回 gdigrab 录整个虚拟桌面——
   代价是录屏时鼠标可能闪烁（见功能节说明）。单屏不受影响。
4. **区域框选与常驻边框仅 Windows**：首选的「屏幕上直接框选」走宿主全屏
   遮罩（宿主的抓屏实现目前只有 Windows）；兜底的面板内截图框选与录制
   边框靠 `backend/screen-snapshot.ps1` / `backend/region-border.ps1`
   （Win10+ 自带的 PowerShell）。其它平台只能手填坐标，录制时没有边框。
5. **系统声音**：Windows 需先装虚拟声卡（VB-Cable 等）并在后端扩展
   dshow 设备名；当前版本只支持麦克风（需显式给出设备名），默认 `-an` 静音。
6. **编码器兜底**：部分精简版 ffmpeg 不带 libx264。已提供 mpeg4 选项，
   但它画质/体积都差，且不支持 `-crf`（改用 `-q:v`）。
7. **图片水印的缩放基准**：优先用已知的主视频宽度算绝对像素；拿不到宽度时
   （如 macOS 全屏且没有 ffprobe）退回新版 scale 的 `rw` 变量——极老的
   ffmpeg（2025 年前的构建）不认 `rw`，此组合下图片水印会报滤镜错误，
   换文字水印或指定 ffmpeg 路径即可。
8. **产物只在插件私有目录**：宿主没有「任意路径写文件」的插件 API，
   所以不能直接导出到用户选的目录。用「作品库 → 定位」在资源管理器里
   找到文件后自行移动/另存。
9. **缩略图串行加载**：每张缩略图都要 ffmpeg 抽一帧，串行避免打满 CPU。
10. **Windows 需要 `tar.exe`**（Win10 1803+ 自带）解包；极旧系统会退回
    PowerShell `Expand-Archive`。

## 开发与调试

```bash
# 打包（会先跑清单校验，不合格直接失败）
node test/pack-plugin.mjs plugins/recorder -o dist/com.mysearch.recorder.mspp

# 单测：纯函数（水印滤镜、参数拼装、九宫格定位、URL 白名单、解包挑选）
#      + 后端 JSON-RPC 握手
node test/recorder-plugin.test.mjs

# 前台 e2e（真实浏览器；未装 Chrome/Edge 时自动跳过）
node test/recorder-plugin-ui.test.mjs
```

开发循环：宿主「设置 → 插件 → 从目录挂载」指向 `plugins/recorder`，
`ui/**` 与 `backend/**` 的改动会自动重载。
