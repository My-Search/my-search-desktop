# 我的搜索（桌面版）

> 打造订阅式搜索，让我的搜索，只搜精品！

「我的搜索」是 [zhuangjie](https://github.com/My-Search/my-search) 开发的订阅式搜索脚本（油猴版 v7.9.5）的**桌面版**。
本桌面版使用 **Tauri 2.0**（Rust 后端 + WebView 前端）实现，支持 **Windows / macOS / Linux**。

界面与交互一比一还原油猴版：呼出即显示搜索框，输入即搜，`↑↓` 选择、`Enter` 打开、`Esc` 隐藏。

---

## ✨ 功能特性

- **全局悬浮框**：按全局快捷键（默认 `Ctrl+Alt+S`，可在设置中自定义）在任意应用下呼出/隐藏搜索窗（显示在屏幕偏上的居中位置）；**点窗口外面即收起**（不管正在干什么都先隐藏，唤醒后再原样显示，见下方「失焦隐藏」）
- **订阅式搜索**：订阅自定义内容源，脚本自动递归解析 `tis::` 子订阅
- **三级搜索**：精确搜索（标题/描述/内容）→ 拼音搜索 → 重叠模糊匹配（AI 模糊模式）
- **简述内容 / 附加内容 / 快捷链接**：简述类数据项可直接阅读；附加内容（vassal）与快捷链接（links）可点击（**查看期间点到窗口外面会先隐藏，再用快捷键唤醒即可回到原样**，见下方「失焦隐藏」）
- **标签系统**：`[系统项]`、`[推荐]`… 彩色标签渲染，隐藏标签 `[h'xx']` 不显示但参与分类
- **特殊关键词直达**：`<new>`（新数据）、`<history>`（历史记录）、`<highFrequency>`（我的 HOT）
- **子搜索模式**：输入 `Tab` 进入（`Shift+Tab` 退出），`::` 自动转为分隔符；呼出后直接按 `Tab`（空内容）会转发为「问AI : 」，回车即可打开「问AI」脚本应用（见下）
- **点击加权 + 历史记录**：点击过的条目会提升排序权重
- **脚本项**：`[脚本]` 数据项渲染其自定义视图（`view:html/css/js`）、外部打开能力（**脚本应用点到窗口外面会先隐藏，再用快捷键唤醒即可回到原样**）
- **脚本应用的子关键词转发**：像「问AI」这类脚本应用，进入后可在搜索框用「父关键词 : 问题」提问——**挂载完成时与每次回车**都会把分隔符后的文字推给应用的 `MS_SCRIPT_ENV.event.sendListener`，输入框保留「父关键词 : 」以便连续追问（完全还原油猴版 `tryRunTextViewHandler`）
- **设置窗口**：左侧分类菜单 + 右侧内容的常规设置布局——**订阅管理**（订阅总览条块管理：逐条查看/添加/编辑/删除，可切换到源码视图直接编辑 `tis::` 原文）、**关注标签**（勾选过滤）、**公共仓库**（提交订阅到 TisHub、TisHub 订阅市场 搜索/安装/移除、清理 Token）、**数据缓存**（统计本地缓存占用与条数，一键清理可重建缓存）；支持保存并应用
- **系统托盘**：左键点击呼出/隐藏搜索窗；右键菜单提供「显示/隐藏」「设置」「清理缓存」「退出」（清理缓存等价于设置窗口的「清理可重建缓存」，主窗口下次唤出时自动重新加载订阅数据）
- **数据缓存**：加载结果带有效期（12 小时）写入本地，未过期时启动直接复用、不再联网；过期或订阅变化才重新加载
- **网络容错**：`raw.githubusercontent.com` 优先走 jsDelivr CDN（国内可达、加载快），失败时回退直连（2.5s 短超时快速失败）→ GitHub API
- **并发加载**：订阅按队列 20 路并发拉取（纯 I/O 请求），配置文件解析出的子订阅直接回队继续并发，整库加载压到 1~2 轮完成，不再出现「数据几十条几十条地蹦」的阶梯式加载

---

## 🚀 快速开始（Windows）

### 方式一：一键启动脚本（推荐）

双击根目录下的 **`start.bat`**：

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
| `Esc` | 从详情视图返回 / 隐藏窗口（**输入框失焦时同样生效**，不依赖输入框焦点） |
| `Tab` / `Shift+Tab` | 进入 / 退出子搜索模式 |
| 鼠标右键点击 logo | 打开设置（也可 `Ctrl+,` 或托盘菜单） |

> logo 按钮左键点击 = 搜索 `[系统项]`（与原版一致，系统项内含使用说明）。

---

## 📁 项目结构

```
my-search-desktop/
├── start.bat                   # 一键启动脚本（关闭窗口即停止）
├── index.html / config.html    # 双入口（搜索主窗 / 独立设置窗）
├── vite.config.ts              # Vite 构建（双入口 + vue 插件 + __APP_VERSION__）
├── tsconfig.json               # TypeScript 配置（strict）
├── src/                        # 前端（Vue 3 + TypeScript）
│   ├── main.ts                 # 主窗口入口 → createApp(SearchApp)
│   ├── config.ts               # 设置窗口入口 → createApp(ConfigApp)
│   ├── env.d.ts                # Vite / __APP_VERSION__ 类型声明
│   ├── types/index.ts          # 共享类型（订阅/数据项/更新信息…）
│   ├── css/style.css           # 全局样式（还原原版视觉）
│   ├── components/             # 两窗口共享组件（MessageDialog / ToastHost）
│   ├── composables/            # 两窗口共享逻辑（useMessageDialog / useToast）
│   ├── windows/
│   │   ├── search/             # 搜索主窗口：App.vue + SearchBox / ResultList /
│   │   │                       #   ResultItem / DetailView / UpdateBadge + composables
│   │   └── config/             # 设置窗口：App.vue + panels/（订阅/标签/仓库/缓存/快捷键/关于/TisHub）
│   └── lib/                    # 纯逻辑层（无框架依赖，可直接单测）
│       ├── search-engine.ts    # 搜索核心：递归订阅加载、索引、三级搜索、权重/历史/新数据
│       ├── subscribe-parser.ts # 订阅解析：tis / fetchFun 双标签 / mLine·sLineFetchFun / 脚本项解析
│       ├── tags.ts             # 标签解析与彩色渲染
│       ├── overlap.ts          # 重叠匹配度算法（移植自原版）
│       ├── script-runtime.ts   # 脚本项运行时（new Function 沙箱）
│       ├── shortcut.ts         # 快捷键录入：keydown → 组合键字符串
│       ├── util.ts             # 工具：转义、URL、Markdown、本地存储、防抖
│       ├── assets.ts           # 内嵌图标资源（由 test/gen-assets.mjs 生成）
│       └── tauri-bridge.ts     # Tauri 桥接：HTTP 代理、窗口控制、外链打开
├── src-tauri/                  # Rust 后端（Tauri 2.0）
│   ├── src/lib.rs              # 全局快捷键、悬浮窗定位、HTTP 代理回退、托盘、命令
│   ├── capabilities/           # 权限配置
│   └── tauri.conf.json         # Tauri 配置
├── public/test-data/index.ms   # 示例订阅
└── test/                       # 开发期验证脚本（Node 运行）
```

---

## 🔧 技术说明

- **全局快捷键**：`tauri-plugin-global-shortcut` 注册（默认 `Ctrl+Alt+S`，可在「设置 → 快捷键」自定义，持久化于应用数据目录 `settings.json`）
- **悬浮框**：无边框（`decorations: false`）+ 置顶 + 跳过任务栏 + 失焦无条件自动隐藏（**点了窗口外面就收起，不管在干什么；唤醒后再原样显示**，见下方「失焦隐藏」）；呼出时定位到屏幕偏上的居中位置（`y ≈ 屏幕高 22%`）
- **窗口高度**：前端按「最多 15 条（`showSize`）」动态计算，结果多时可滚动查看全部（上限 420px）
- **HTTP 代理**：Rust 端 `reqwest` 提供 `http_get`，三级回退（jsDelivr CDN → 直连兜底 → GitHub API）绕开 CORS 与网络封锁
- **拼音搜索**：`pinyin-pro`（本地化，无外部 CDN 依赖），索引一次性预热
- **订阅协议**：兼容 `tis::` 单标签、`<fetchFun>` 自定义提取函数、`default-tag`、转义/恢复

### 失焦隐藏（用户规则：点了窗口外面就无条件先隐藏）

**只要窗口失去焦点（点了应用外面），不管当前在干什么，都先隐藏**；之后再按全局快捷键（默认 `Ctrl+Alt+S`）或托盘唤出即可。唤醒后前端会按隐藏前的视图状态分两种处理：

| 隐藏前状态 | 唤醒后 |
|------------|--------|
| **详情视图**（简述内容 / 附加内容 / 脚本应用） | **原样还原**：正文仍在、输入框内容不动（DOM 未销毁） |
| 其它（等待搜索 / 结果列表） | 复位到初始视图：输入框清空、窗口收回搜索框高度 |

| 当前状态 | 失焦是否隐藏 | 说明 |
|----------|--------------|------|
| 等待搜索（搜索框空着 / 搜了但没有结果） | ✅ 自动隐藏 | |
| 结果列表展示中 | ✅ 自动隐藏 | 「呼出→搜索→看完就收起」 |
| 查看**简述内容** / **附加内容**（vassal） | ✅ 自动隐藏 | **本次用户规则调整**：先隐藏，唤醒后原样还原，不会丢 |
| 打开**脚本应用**（`view:html/css/js` 脚本视图） | ✅ 自动隐藏 | 同上，先隐藏 + 唤醒还原 |
| 搜索进行中（防抖 + 异步检索尚未返回） | ✅ 自动隐藏 | 不再按「搜索中」豁免 |
| 输入 `:debug` 指令模式 | ✅ 自动隐藏 | 不再按 `:debug` 豁免 |

- **为什么统一为无条件隐藏**：悬浮窗置顶，若详情视图「点了外面也不消失」就会一直浮在最上面挡住其它应用；用户规则是「不管在干嘛都先隐藏，后面唤醒再显示就行」。而「正在看的东西」不会丢——详情视图的状态（`#text_show` 内容 + 输入框）没有被销毁，唤醒时按 `resumeDetailViewIfAny()` **原样还原**（正文还在、关键词还在）。这条还原规则对应「查看文档/附加内容/应用项时，按快捷键只单独隐藏，再显示时仍与隐藏前一致」。
- **怎么实现**：失焦事件在 Rust 侧（`on_window_event`）才会收到，前端无法阻止；判定直接放在 Rust——收到 `Focused(false)` 就无条件 `hide()`，并顺手把窗口收回到搜索框高度（避免下次呼出残留高窗口）。前端**不再**按状态同步任何「是否允许隐藏」标志（旧的 `set_hide_on_blur` 命令 + `BlurHideState` 已移除）。
  - 前端已彻底移除分状态判定：没有 `syncBlurHide` / `resolveViewMode` / `shouldHideOnBlur`，也不再读取 DOM 可见性来同步隐藏标志。
  - 唤醒还原由 `App.vue` 的 `resumeDetailViewIfAny()` 完成：`state.mode === SHOW_ITEM_DETAIL && detailVisible` 时不清视图，只重贴窗口高度。
- **与油猴版的差别**：原版 `showView()` 的 input.blur 判定里，`isDebuging` / `isSearching` / 非等待搜索状态都会 `return` 而不隐藏；桌面版浮窗按用户规则统一为「失焦即隐藏」，是对原版的明确调整。
- **怎么主动收起**：按 `Esc`（详情视图下按一次先返回结果列表，再按一次收起窗口）、全局呼出快捷键、托盘菜单/左键点击。
  - Esc 由页面上的**全局 keydown 监听**处理（捕获阶段），因此**不依赖输入框焦点**：点过详情正文让输入框失焦后，Esc 依然能返回。
  - 前提是**窗口本身仍是前台窗口**。如果先点了其它应用/桌面，窗口会按上面的规则直接隐藏；要用全局快捷键重新唤出。
- **点结果打开链接仍然会收起**：原版点击 URL 项是显式 `viewVisibilityController(false)` 后再 `window.open(url)`（简述/附加内容/脚本项在那边都是 `return`，不收起），桌面版同步移植了这个行为（`openItem()` 里先 `resetToInitialView()` + `hideWindow()` 再打开外链）。
- **与旧行为的差别**：点 logo 右键 / 托盘打开设置时，桌面版的设置是独立窗口（主窗口置顶会盖住它），所以 `open_config_window` 会先把主窗口收起——观感与原版一致。
- 相关测试：`node test/blur-hide.test.mjs`（源码契约：Rust 失焦即隐藏、无任何门控，前端已移除分状态判定与同步机制）；`node test/blur-hide-ui.test.mjs`（真实浏览器走交互路径，验证详情视图/脚本应用下前端不再发送旧的 `set_hide_on_blur` 门控）；`node test/summon-keep-input.test.mjs`（真实浏览器验证唤醒还原：详情视图原样保留、其它状态复位）；`node test/esc-return-ui.test.mjs`（真实浏览器验证详情视图下 Esc 返回：输入框聚焦 / 失焦都生效，且只返回、不隐藏窗口）。

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
- **可复现**：`npm run icons` 从 `src/lib/assets.ts` 里的原脚本叶子 SVG 重新生成两套母版，再交给 `tauri icon` 产出全套（`.icns` / `.ico` / 各尺寸 png）

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

相关测试：`node test/blur-hide.test.mjs`（源码契约：Rust 失焦即隐藏、无任何门控，前端已移除分状态判定与同步机制）；`node test/blur-hide-ui.test.mjs`（真实浏览器走交互路径，验证详情视图/脚本应用下前端不再发送旧的 `set_hide_on_blur` 门控；需本机装有 Chrome / Edge，否则跳过）；`node test/ai-ask.test.mjs`（源码契约：「问AI」子关键词转发：挂载后自动转发、编辑子关键词不重搜、保留「父关键词 : 」）；`node test/ai-ask-ui.test.mjs`（真实浏览器端到端：空内容按 Tab → 转发「问AI : 」→ 输入「你好」→ 回车打开「问AI」应用并自动收到「你好」、会话存活可连续追问；需本机装有 Chrome / Edge，否则跳过）；`node test/cache-test.mjs`（验证「未过期复用缓存且零网络请求」「过期重新加载」「订阅变化失效」「离线回退」等）；`node test/new-items.test.mjs`（验证 `<new>` 新数据：首次加载不把全部数据当「新」、下次加载仅标记真正新增项并带 `[最新一条]`、有效期内保留不重复累积、过期记录不再展示）；`node test/raw-url.test.mjs`（验证 raw.githubusercontent URL 解析：`refs/heads` / `refs/tags` / 标准分支三种形式、根目录文件与多级路径、中文路径、缺文件名时拒绝转换；与 Rust 侧 `cargo test` 用例一一对应）；`node test/placeholder.test.mjs`（验证占位提示的文案、时长与「加载中提示会自动消失」）；`node test/progress.test.mjs`（验证进度上报、命中缓存不上报、回调异常不阻断加载）；`node test/cache-remain.test.mjs`（验证剩余时长/过期时刻文案的分档、边界与递减性质）；`node test/cache-remain-ui.test.mjs`（真实浏览器验证设置窗口「数据缓存」面板的剩余时间显示、秒级倒计时是否会走动、过期切文案与清理后不再残留；需本机装有 Chrome / Edge，否则跳过）；`node test/sub-cards-ui.test.mjs`（真实浏览器验证设置窗口「订阅管理」条块管理的默认渲染、添加/行内编辑/删除、键盘 Enter/Esc、拖拽排序、条块↔源码切换与亮暗主题截图；需本机装有 Chrome / Edge，否则跳过）；`node test/_e2e-drag.test.mjs`（真实 Tauri+WebView2 验证「订阅总览」条块拖拽排序在 Windows 原生 OLE drop handler 不拦截的情况下正确触发，需先 `npm run build && cd src-tauri && cargo build` 构建 debug exe）。Rust 侧单测：`cd src-tauri && cargo test --lib`（raw.githubusercontent URL 解析边界）。

- **设置窗口的确认框（跨平台修复）**：原实现用 window.confirm / window.alert，但在 macOS 的 WKWebView 里 wry 没有实现 unJavaScriptAlertPanel / unJavaScriptConfirmPanel——confirm() 会**静默返回 false**、lert() **完全无效果**，导致「清理缓存」「删除订阅」「提交到 TisHub」点了没反应。现已改为**应用内确认/提示弹窗**（#msgOverlay，样式复用设置窗口的 dialog），三个平台表现一致，并支持 Esc=取消 / Enter=确定。
### 相比早期桌面版的修复

早期桌面版虽然接入了官方订阅，但「搜索不出结果」的根因在搜索核心（已通过新旧实现对比实测确认）：

1. **完全没有「内容」匹配**：原 `accurateSearch` 只匹配标题与描述，**不匹配 `resource` / `vassal` / `links`**。而大量信息（网址、附加说明、教程正文）只存在于这些字段中，因此搜索这类关键词永远无结果；精确无结果时又只回退到最多 50 条、几乎没有排序的模糊结果，观感就是「搜不到」。
   新版补齐三级匹配：**标题 → 描述 → 内容（links + resource + vassal）**。

2. **拼音搜索基本失效**：原实现调用 `toPinyin(title, 仅查缓存)`，但从不预热缓存，首次搜索时缓存为空 → 拼音查询几乎无结果（实测 `weixin` 仅 1 条）。
   新版在数据加载后**一次性构建拼音索引**（实测 `weixin` 由 1 条提升到 13 条）。

3. **特殊关键词**：`<highFrequency>` 因大小写匹配错误而失效，`<new>` / `<history>` 缺失；已按原脚本补齐（并实现新数据追踪）。

4. **脚本项**：补齐 `[脚本]` 项的解析（`resourceObj`）与受限视图运行时（`view:html/css/js`、外部打开），以及「新数据 / 历史 / HOT」快捷脚本。

5. **脚本应用的子关键词转发**：早期漏掉了原版 `tryRunTextViewHandler` 的自动调用与「编辑子关键词不重搜」守卫，导致「问AI」应用在整个链路上永远收不到问题。现已完整还原三处原版行为：脚本视图挂载完成后自动转发一次子关键词、输入「父关键词 : 问题」时保住脚本会话不重搜、回车把问题推给 `sendListener` 并保留「父关键词 : 」。
   相关测试：`node test/ai-ask.test.mjs`（源码契约）；`node test/ai-ask-ui.test.mjs`（真实浏览器端到端：空内容按 Tab → 转发「问AI : 」→ 输入「你好」→ 回车打开应用并自动收到「你好」，且会话存活可连续追问；需本机装有 Chrome / Edge，否则跳过）。

6. **设置不持久**：显式保证 WebView 数据目录持久且主窗口与配置窗口共享，订阅/历史/权重在重启后仍然保留。

7. **界面与性能**：每屏 15 条（`showSize`）、结果区最大 420px、搜索框 47px、无边框阴影、呼出定位在屏幕偏上居中；拼音索引一次性构建，避免每次按键对全部数据实时转拼音造成的卡顿。

---

## 📄 License

MIT © zhuangjie
