# 我的搜索（桌面版）

> 打造订阅式搜索，让我的搜索，只搜精品！

「我的搜索」是 [zhuangjie](https://github.com/My-Search/my-search) 开发的订阅式搜索脚本（油猴版 v7.9.5）的**桌面版**。
本桌面版使用 **Tauri 2.0**（Rust 后端 + WebView 前端）实现，支持 **Windows / macOS / Linux**。

界面与交互一比一还原油猴版：呼出即显示搜索框，输入即搜，`↑↓` 选择、`Enter` 打开、`Esc` 隐藏。

---

## ✨ 功能特性

- **全局悬浮框**：按全局快捷键（默认 `Ctrl+Alt+S`，可在设置中自定义）在任意应用下呼出/隐藏搜索窗（显示在屏幕偏上的居中位置）；**点窗口外面即收起**（结果列表也收起，详情视图保留，见下方「失焦隐藏」）
- **订阅式搜索**：订阅自定义内容源，脚本自动递归解析 `tis::` 子订阅
- **三级搜索**：精确搜索（标题/描述/内容）→ 拼音搜索 → 重叠模糊匹配（AI 模糊模式）
- **简述内容 / 附加内容 / 快捷链接**：简述类数据项可直接阅读；附加内容（vassal）与快捷链接（links）可点击（**查看期间失去焦点不会收起窗口**，见下方「失焦隐藏」）
- **标签系统**：`[系统项]`、`[推荐]`… 彩色标签渲染，隐藏标签 `[h'xx']` 不显示但参与分类
- **特殊关键词直达**：`<new>`（新数据）、`<history>`（历史记录）、`<highFrequency>`（我的 HOT）
- **子搜索模式**：输入 `Tab` 进入（`Shift+Tab` 退出），`::` 自动转为分隔符
- **点击加权 + 历史记录**：点击过的条目会提升排序权重
- **脚本项**：`[脚本]` 数据项渲染其自定义视图（`view:html/css/js`）、外部打开能力（**脚本应用打开期间失去焦点不会收起窗口**）
- **设置窗口**：左侧分类菜单 + 右侧内容的常规设置布局——**订阅管理**（订阅总览条块管理：逐条查看/添加/编辑/删除，可切换到源码视图直接编辑 `tis::` 原文）、**关注标签**（勾选过滤）、**公共仓库**（提交订阅到 TisHub、TisHub 订阅市场 搜索/安装/移除、清理 Token）、**数据缓存**（统计本地缓存占用与条数，一键清理可重建缓存）；支持保存并应用
- **系统托盘**：左键点击呼出/隐藏搜索窗；右键菜单提供「显示/隐藏」「设置」「清理缓存」「退出」（清理缓存等价于设置窗口的「清理可重建缓存」，主窗口下次唤出时自动重新加载订阅数据）
- **数据缓存**：加载结果带有效期（12 小时）写入本地，未过期时启动直接复用、不再联网；过期或订阅变化才重新加载
- **网络容错**：`raw.githubusercontent.com` 优先走 jsDelivr CDN（国内可达、加载快），失败时回退直连（2.5s 短超时快速失败）→ GitHub API
- **并发加载**：订阅按队列 20 路并发拉取（纯 I/O 请求），配置文件解析出的子订阅直接回队继续并发，整库加载压到 1~2 轮完成，不再出现「数据几十条几十条地蹦」的阶梯式加载

---

## 🚀 快速开始（Windows）

### 方式一：一键启动脚本（推荐）

双击根目录下的 **`启动.bat`**（或 `start.bat`）：

- 自动检查 Node.js / Rust 环境
- 首次运行自动 `npm install`
- 自动释放被占用的开发端口 1420
- 前台启动应用，**关闭命令窗口（或按 Ctrl+C）即停止整个项目**

### 方式二：命令行

```bash
npm install
npm run tauri dev     # 开发运行
npm run tauri build   # 构建安装包
```

### 环境要求

| 平台 | 要求 |
|------|------|
| Windows | Windows 10/11 + [Node.js 18+](https://nodejs.org/) + [Rust](https://rustup.rs/) + WebView2（Win11 自带） |
| macOS | macOS 10.15+，Xcode Command Line Tools |
| Linux | WebKitGTK 4.1（见下方） |

Linux 系统依赖（Ubuntu/Debian）：

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

---

## ⌨️ 快捷键

| 按键 | 功能 |
|------|------|
| `Ctrl+Alt+S`（默认，可在设置中自定义） | 全局呼出 / 隐藏搜索窗 |
| `↑` / `↓` | 在结果中上下移动 |
| `Enter` | 打开当前选中项（URL 跳转 / 查看简述内容） |
| `Ctrl+Enter` | 查看当前项的「附加内容」并定位关键词 |
| `Esc` | 从详情视图返回 / 隐藏窗口（详情视图展示中不会被失焦隐藏，需要用它主动收起） |
| `Tab` / `Shift+Tab` | 进入 / 退出子搜索模式 |
| 鼠标右键点击 logo | 打开设置（也可 `Ctrl+,` 或托盘菜单） |

> logo 按钮左键点击 = 搜索 `[系统项]`（与原版一致，系统项内含使用说明）。

---

## 📁 项目结构

```
my-search-desktop/
├── 启动.bat / start.bat        # 一键启动脚本（关闭窗口即停止）
├── src/                        # 前端（Vite + 原生 JS）
│   ├── main.js                 # 主应用：搜索视图、交互、脚本视图运行时
│   ├── config.js               # 独立设置窗口（左菜单：订阅管理 / 关注标签 / 公共仓库 / 数据缓存）
│   ├── css/style.css           # 全局样式（还原原版视觉）
│   └── lib/
│       ├── search-engine.js    # 搜索核心：递归订阅加载、索引、三级搜索、权重/历史/新数据
│       ├── subscribe-parser.js # 订阅解析：tis / fetchFun 双标签 / mLine·sLineFetchFun / 脚本项解析
│       ├── tags.js             # 标签解析与彩色渲染
│       ├── overlap.js          # 重叠匹配度算法（移植自原版）
│       ├── util.js             # 工具：转义、URL、Markdown、本地存储、防抖
│       ├── assets.js           # 内嵌图标资源（由原脚本提取生成）
│       └── tauri-bridge.js     # Tauri 桥接：HTTP 代理、窗口控制、外链打开
├── src-tauri/                  # Rust 后端（Tauri 2.0）
│   ├── src/lib.rs              # 全局快捷键、悬浮窗定位、HTTP 代理回退、托盘、命令
│   ├── capabilities/           # 权限配置
│   └── tauri.conf.json         # Tauri 配置
├── public/test-data/index.ms   # 示例订阅
└── test/                       # 开发期验证脚本（Node 运行）
```

---

## 🔧 技术说明

- **全局快捷键**：`tauri-plugin-global-shortcut` 注册（默认 `Ctrl+Alt+S`，可在「设置 → 快捷键设置」自定义，持久化于应用数据目录 `settings.json`）
- **悬浮框**：无边框（`decorations: false`）+ 置顶 + 跳过任务栏 + 失焦自动隐藏（**结果列表也会在失焦时收起**，详情视图保留，见下方「失焦隐藏」）；呼出时定位到屏幕偏上的居中位置（`y ≈ 屏幕高 22%`）
- **窗口高度**：前端按「最多 15 条（`showSize`）」动态计算，结果多时可滚动查看全部（上限 420px）
- **HTTP 代理**：Rust 端 `reqwest` 提供 `http_get`，三级回退（jsDelivr CDN → 直连兜底 → GitHub API）绕开 CORS 与网络封锁
- **拼音搜索**：`pinyin-pro`（本地化，无外部 CDN 依赖），索引一次性预热
- **订阅协议**：兼容 `tis::` 单标签、`<fetchFun>` 自定义提取函数、`default-tag`、转义/恢复

### 失焦隐藏（对齐油猴版 `showView()` 的 input.blur）

窗口失焦（点了应用外面）时**是否自动隐藏，取决于当前状态**：

| 当前状态 | 失焦是否隐藏 | 对应原版判定 |
|----------|--------------|--------------|
| 等待搜索（搜索框空着 / 搜了但没有结果，没结果也没详情） | ✅ 自动隐藏 | `seeNowMode() === WAIT_SEARCH` |
| **结果列表展示中** | ✅ 自动隐藏 | ⚠️ **桌面版调整**（原版 `!isWaitSearch` 不隐藏） |
| 查看**简述内容** / **附加内容**（vassal） | ❌ 不隐藏 | `SHOW_ITEM_DETAIL` |
| 打开**脚本应用**（`view:html/css/js` 脚本视图） | ❌ 不隐藏 | `SHOW_ITEM_DETAIL` |
| 搜索进行中（防抖 + 异步检索尚未返回） | ❌ 不隐藏 | `searchEven.isSearching` |
| 输入 `:debug` 指令模式 | ❌ 不隐藏 | `isInstructions("debug")` |

- **为什么结果列表也隐藏**：原版 `!isWaitSearch` 会让结果区在失焦时也保持显示（悬浮窗一直浮在最上面）。但桌面版悬浮窗的预期是「呼出→搜索→看完就收起」，搜完列表后点窗口外面还挂着一块列表会显得粘手，因此结果列表展示中改为**失焦即收起**。
- **为什么详情视图不隐藏**：原脚本里 `input.blur` 只是「隐藏的一个必要条件」，展示内容时点窗口外面不应该把正在看的东西丢掉。桌面版早期是无条件 `Focused(false) → hide()`，看起来是「鼠标一点别处，正在看的附加内容/脚本应用就没了」，现已按原脚本修复并保留。
- **怎么实现**：失焦事件在 Rust 侧（`on_window_event`）才会收到，前端无法阻止，所以状态由前端同步过去——`set_hide_on_blur(hide)` 命令 + `BlurHideState`（原子布尔），前端在视图/搜索状态变化时调用 `syncBlurHide()`（同值不重复发 IPC）。判定本身是纯函数：`resolveViewMode()` + `shouldHideOnBlur()`（`src/lib/util.js`），便于单测。
- **状态判定以 DOM 为准**：`resolveViewMode()` 对应原版 `seeNowMode()`，按 `#text_show` / `#matchResult` 的 `display` 判当前模式（详情 > 结果 > 等待搜索），不依赖可能滞后的 `state.mode`。
- **不隐藏时怎么收起**：按 `Esc`、全局呼出快捷键（默认 `Ctrl+Alt+S`），或托盘菜单/左键点击。（窗口是置顶的，所以详情视图会一直浮在最上面，这是预期行为。）
- **点结果打开链接仍然会收起**：原版点击 URL 项是显式 `viewVisibilityController(false)` 后再 `window.open(url)`（简述/附加内容/脚本项在那边都是 `return`，不收起），桌面版同步移植了这个行为（`openItem()` 里先 `resetToInitialView()` + `hideWindow()` 再打开外链）。
- **与旧行为的差别**：点 logo 右键 / 托盘打开设置时，桌面版的设置是独立窗口（主窗口置顶会盖住它），所以 `open_config_window` 会先把主窗口收起——观感与原版一致；另外 Rust 侧 `set_hide_on_blur` 初值为 `true`，前端同步之前保持旧行为（失焦即隐藏），不会出现「窗口置顶且怎么点都不消失」。
- 相关测试：`node test/blur-hide.test.mjs`（纯函数：等待搜索 / 结果列表 → 隐藏，详情视图与搜索中 / `:debug` → 不隐藏）；`node test/blur-hide-ui.test.mjs`（真实浏览器走交互路径，验证同步给 Rust 的 `set_hide_on_blur` 取值）。

### 图标（分平台，各自符合本平台审美）

应用图标与托盘图标由 `test/gen-icons.mjs` 生成，**macOS 与 Windows 用两套不同的网格**：

- **macOS / Linux**：1024×1024 画布，图标主体 **824×824** 居中（四周 100px 透明留白），这是 Big Sur 起的 Apple 官方图标网格
- **Windows**：图标主体 **1000×1000**（几乎铺满画布）。Windows 没有 Apple 那套「留白安全区」约定，原生图标实测外轮廓在 **97%~100%**（calc / explorer / notepad / powershell）。若把 macOS 网格直接拿去 Windows 用，图标只有 80%，在任务栏里就比旁边的程序**小一圈**——这就是「任务栏图标显得小」的根因
- **圆角是连续曲率（squircle）**：圆角半径取主体宽度的 22.5%、平滑度 0.6。普通圆弧圆角在 macOS 上会显得「不对」，连续曲率才是原生观感
- **白底 + 投影**：主体白色并烘一层柔和投影，否则纯白底在浅色任务栏/桌面上会「消失」，看不出圆的边界
- **托盘图标无白底方块**：
  - macOS 用**单色模板图标**（`tray-mono.png`，纯黑 + 透明，`icon_as_template(true)`），系统按浅色/深色菜单栏自动反色
  - Windows / Linux 用彩色叶子 + **透明背景**，并按宽度顶到接近满幅（小尺寸下才不糊）
- **平台分发**：Windows 的图标由 `src-tauri/tauri.windows.conf.json` 覆盖 `bundle.icon` 指向 `icons/windows/`（Tauri 会用 JSON Merge Patch 合并平台配置，**数组是整体替换**，所以平台文件里要写完整清单）。`tauri-build` 嵌入 exe 资源图标时会从 `bundle.icon` 里找第一个 `.ico`
- **可复现**：`npm run icons` 从 `src/lib/assets.js` 里的原脚本叶子 SVG 重新生成两套母版，再交给 `tauri icon` 产出全套（`.icns` / `.ico` / 各尺寸 png）

### 托盘菜单后鼠标光标消失（Windows 已修复）

**现象**：在托盘图标上左键/右击弹出菜单，把鼠标移进菜单时指针不见了——菜单项其实仍在响应，只是光标不可见；点击别处后移动才恢复。

**成因（两个因素叠加）**：

1. `tray-icon`（Tauri 托盘依赖）在 Windows 上为接收托盘消息创建的隐藏窗口，其窗口类用 `zeroed()` 注册——`hCursor = NULL` 且窗口过程不处理 `WM_SETCURSOR`。`TrackPopupMenu` 弹出/收起时，系统把光标状态的维护权交给这个窗口后就无法恢复。
2. WebView2 Runtime 152.0.4191.x 存在已知的光标消失缺陷（[MicrosoftEdge/WebView2Feedback #5708](https://github.com/MicrosoftEdge/WebView2Feedback/issues/5708)）：运行时内部用 `ShowCursor` 隐藏光标（如「输入时隐藏指针」），异常路径下计数不归零，光标在整个会话保持隐藏。微软给的临时办法是关闭系统设置里的「隐藏指针时键入」。

**修法**（`src-tauri/src/lib.rs` 的 `force_cursor_visible()`）：托盘菜单事件/左键点击到达时（此时菜单已收起），用 `GetCursorInfo` 检查光标可见性，处于隐藏状态就调 `ShowCursor(true)` 把可见计数恢复到 ≥ 0。它把官方 workaround 的影响范围缩小到「仅本应用交互节点」，不改动系统设置。

### 数据缓存（对齐油猴版的 `SEARCH_DATA_KEY`）

油猴版对加载结果有一层缓存（`cache.get(SEARCH_DATA_KEY)` + `effectiveDuration`），**未过期就直接用缓存、不再联网**。桌面版把这一层迁漏了，导致每次启动都全量拉取全部订阅（实测约 6 秒、15 个内容源）。现已按原脚本补回：

- **加载即缓存**：`loadAll()` 完成后把数据与 `expire`（当前时间 + `effectiveDuration`，默认 12 小时）写入 `SEARCH_DATA_KEY`。
- **启动先用缓存**：`initData()` 未过期 → 直接挂载缓存数据（`_buildIndex()` 重建检索索引，搜索结果与重新加载完全一致）；过期才联网重新加载。
- **缓存内容更小**：`index` / `_titleUpper` / `_titlePinyin` 等派生索引字段不入缓存（挂载时重建），417 条数据约 300 KB。
- **订阅变化立即失效**：缓存记录订阅列表指纹，订阅增删改（配置窗口「保存并应用」）后指纹不一致 → 缓存作废并重新加载；「关注标签」变化同样会重新加载。
- **清理缓存**：配置窗口「清理缓存」按钮对应原版 `GM_registerMenuCommand("清理缓存", clearCache)`；主窗口下次聚焦或呼出时检测到缓存被清理会重新加载。
- **设置窗口显示剩余有效期**：「数据缓存」面板里的「订阅数据缓存」一条会直接标出还剩多久过期（原版仅在 console 里 `console.logout` 了剩余分钟数，GUI 上看不到）：

  | 状态 | 文案 | 说明 |
  |------|------|------|
  | 未过期 | `417 条内容 · 剩 11 小时 59 分（约 18:00 过期）` | 剩余时长 + 具体过期时刻 |
  | 已过期 | `417 条内容 · 已过期（15:20 失效）` | 标红（`.expired`），并给出失效时刻 |
  | 无 `expire` 字段 | `417 条内容` | 旧版缓存不虚构有效期 |

  - **精度随剩余量收敛**：≥1 天显示 `1 天 3 小时`、≥1 小时 `11 小时 59 分`、≥1 分钟 `59 分 30 秒`、<1 分钟 `30 秒`——避免「11 小时 59 分 30 秒」这种让人以为在跳秒的噪声。
  - **“活”的倒计时**：面板停留期间每秒刷新（只改这一条的文案，不动其余 DOM），所以能看着剩余时间往下走；离开面板 / 窗口失去焦点 / 已过期都会自动停掉定时器，不在后台空转。
  - **后续动作**：过期后主窗口下一次启动或聚焦即会重新加载（`isCacheValid()` 过期即失效），面板上的「清理可重建缓存」也可手动触发。
- **加载状态与进度（对齐原版 `searchPlaceholder`）**：清理缓存后立即呼出搜索框，能立刻看到加载状态，且会随加载推进显示进度，加载完自动恢复默认提示：

  | 阶段 | 文案 | 自动恢复 | 对应原版 |
  |------|------|----------|----------|
  | 准备更新（尚未收到数据块） | `🔁 数据准备更新中...` | 5000ms | `dataInitFun` 里的 `searchPlaceholder("UPDATE", …, 5000)` |
  | 加载进度（每个内容源解析完） | `🔁 数据库更新到 N条`（N=当前条数） | 1200ms | `refreshNewData` 里的 `searchPlaceholder("UPDATE")` |
  | 数据为空 | `⚠️ 数据为空：…` | 常驻 | 桌面版补充（便于排查） |

  - **修复“静默加载”**：呼出时的视图复位不再无条件把占位提示刷回「我的搜索」，加载中会重新显示加载提示。
  - **修复“一直显示加载中”**：加载/进度提示都带自动恢复计时（对应原版 `clearTimeout(this.tmpVar)` + `setTimeout`），数据到位后 1.2s 自动变回默认提示，**不会卡在加载中**。
  - **进度可见**：引擎每解析完一个内容源上报一次进度（数据块粒度，对应原版 `refreshNewData`）；进度条数与最终可搜索条数一致（过滤在块内完成，与原版 `USDRC` 责任链中 `filterSearchData` 的时机一致）。
  - **边加载边可搜**：每个数据块到位后会重跑当前关键词（对应原版 `triggerSearchHandle()`），不必等全部加载完。

- **离线容错**：缓存过期但重新加载全部失败（离线）时，回退到旧缓存，且加载失败不会用空数据覆盖已有缓存。

相关测试：`node test/blur-hide.test.mjs`（验证失焦隐藏的判定：等待搜索、结果列表展示中隐藏；简述/附加内容/脚本应用、搜索进行中、`:debug` 模式不隐藏，含真值表与 `:debug` 边界、`resolveViewMode` 优先级、DOM 链路组合）；`node test/blur-hide-ui.test.mjs`（真实浏览器走交互路径，验证同步给 Rust 的 `set_hide_on_blur` 取值；需本机装有 Chrome / Edge，否则跳过）；`node test/cache-test.mjs`（验证「未过期复用缓存且零网络请求」「过期重新加载」「订阅变化失效」「离线回退」等）；`node test/new-items.test.mjs`（验证 `<new>` 新数据：首次加载不把全部数据当「新」、下次加载仅标记真正新增项并带 `[最新一条]`、有效期内保留不重复累积、过期记录不再展示）；`node test/raw-url.test.mjs`（验证 raw.githubusercontent URL 解析：`refs/heads` / `refs/tags` / 标准分支三种形式、根目录文件与多级路径、中文路径、缺文件名时拒绝转换；与 Rust 侧 `cargo test` 用例一一对应）；`node test/placeholder.test.mjs`（验证占位提示的文案、时长与「加载中提示会自动消失」）；`node test/progress.test.mjs`（验证进度上报、命中缓存不上报、回调异常不阻断加载）；`node test/cache-remain.test.mjs`（验证剩余时长/过期时刻文案的分档、边界与递减性质）；`node test/cache-remain-ui.test.mjs`（真实浏览器验证设置窗口「数据缓存」面板的剩余时间显示、秒级倒计时是否会走动、过期切文案与清理后不再残留；需本机装有 Chrome / Edge，否则跳过）；`node test/sub-cards-ui.test.mjs`（真实浏览器验证设置窗口「订阅管理」条块管理的默认渲染、添加/行内编辑/删除、键盘 Enter/Esc、拖拽排序、条块↔源码切换与亮暗主题截图；需本机装有 Chrome / Edge，否则跳过）；`node test/_e2e-drag.test.mjs`（真实 Tauri+WebView2 验证「订阅总览」条块拖拽排序在 Windows 原生 OLE drop handler 不拦截的情况下正确触发，需先 `npm run build && cd src-tauri && cargo build` 构建 debug exe）。Rust 侧单测：`cd src-tauri && cargo test --lib`（raw.githubusercontent URL 解析边界）。

- **设置窗口的确认框（跨平台修复）**：原实现用 window.confirm / window.alert，但在 macOS 的 WKWebView 里 wry 没有实现 unJavaScriptAlertPanel / unJavaScriptConfirmPanel——confirm() 会**静默返回 false**、lert() **完全无效果**，导致「清理缓存」「删除订阅」「提交到 TisHub」点了没反应。现已改为**应用内确认/提示弹窗**（#msgOverlay，样式复用设置窗口的 dialog），三个平台表现一致，并支持 Esc=取消 / Enter=确定。
### 相比早期桌面版的修复

早期桌面版虽然接入了官方订阅，但「搜索不出结果」的根因在搜索核心（已通过新旧实现对比实测确认）：

1. **完全没有「内容」匹配**：原 `accurateSearch` 只匹配标题与描述，**不匹配 `resource` / `vassal` / `links`**。而大量信息（网址、附加说明、教程正文）只存在于这些字段中，因此搜索这类关键词永远无结果；精确无结果时又只回退到最多 50 条、几乎没有排序的模糊结果，观感就是「搜不到」。
   新版补齐三级匹配：**标题 → 描述 → 内容（links + resource + vassal）**。

2. **拼音搜索基本失效**：原实现调用 `toPinyin(title, 仅查缓存)`，但从不预热缓存，首次搜索时缓存为空 → 拼音查询几乎无结果（实测 `weixin` 仅 1 条）。
   新版在数据加载后**一次性构建拼音索引**（实测 `weixin` 由 1 条提升到 13 条）。

3. **特殊关键词**：`<highFrequency>` 因大小写匹配错误而失效，`<new>` / `<history>` 缺失；已按原脚本补齐（并实现新数据追踪）。

4. **脚本项**：补齐 `[脚本]` 项的解析（`resourceObj`）与受限视图运行时（`view:html/css/js`、外部打开），以及「新数据 / 历史 / HOT」快捷脚本。

5. **设置不持久**：显式保证 WebView 数据目录持久且主窗口与配置窗口共享，订阅/历史/权重在重启后仍然保留。

6. **界面与性能**：每屏 15 条（`showSize`）、结果区最大 420px、搜索框 47px、无边框阴影、呼出定位在屏幕偏上居中；拼音索引一次性构建，避免每次按键对全部数据实时转拼音造成的卡顿。

---

## 📄 License

MIT © zhuangjie
