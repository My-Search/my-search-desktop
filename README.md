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
- **设置窗口**：左侧分类菜单 + 右侧内容的常规设置布局——**订阅管理**（订阅总览条块管理：逐条查看/添加/编辑/删除，可切换到源码视图直接编辑 `tis::` 原文）、**关注标签**（勾选过滤）、**公共仓库**（提交订阅到 TisHub、TisHub 订阅市场 搜索/安装/移除、清理 Token）、**数据缓存**（统计本地缓存占用与条数，一键清理可重建缓存）、**快捷键**、**常规**（开机自启动开关）、**关于软件**；支持保存并应用
- **开机自启动（默认开启）**：安装后随系统登录自动启动并常驻托盘，呼出快捷键随时可用；可在**「设置 → 常规」**或**托盘菜单**里一键关闭（两处状态实时同步）。关闭后仍可从开始菜单手动启动
- **系统托盘**：左键点击呼出/隐藏搜索窗；右键菜单提供「显示/隐藏」「设置」「开机自启动」「清理缓存」「退出」（清理缓存等价于设置窗口的「清理可重建缓存」，主窗口下次唤出时自动重新加载订阅数据）
- **数据缓存**：加载结果带有效期（12 小时）写入本地，未过期时启动直接复用、不再联网；过期或订阅变化才重新加载
- **网络容错**：`raw.githubusercontent.com` 优先走 jsDelivr CDN（国内可达、加载快），失败时回退直连（2.5s 短超时快速失败）→ GitHub API
- **并发加载**：订阅按队列 20 路并发拉取（纯 I/O 请求），配置文件解析出的子订阅直接回队继续并发，整库加载压到 1~2 轮完成，不再出现「数据几十条几十条地蹦」的阶梯式加载
- **插件系统**：像装软件一样装插件——`设置 → 插件` 里「从文件安装」（`.msplugin` / `.zip`，自动剥离「右键压缩整个文件夹」包出来的外层目录）或「从目录挂载」（开发模式，免打包）。插件可贡献搜索项、内嵌界面与后台进程；所有原生能力都要过**运行时权限网关**（Android 式：安装时声明、首次使用弹窗、设置里随时撤销）；插件可声明**关闭界面时的行为**（最小化保活 / 退出卸载）与**是否开机自启**作为默认值，用户在面板上随时可改且不被升级覆盖（详见下方「插件系统」）

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
| 自定义（设置 → 快捷键 → 作用类型「打开插件」） | 全局直接打开指定插件（无需先搜关键词） |
| `↑` / `↓` | 在结果中上下移动 |
| `Enter` | 打开当前选中项（URL 跳转 / 查看简述内容） |
| `Ctrl+Enter` | 查看当前项的「附加内容」并定位关键词 |
| `Esc` | 从详情视图返回 / 隐藏窗口（**输入框失焦时同样生效**，不依赖输入框焦点） |
| `Tab` / `Shift+Tab` | 进入 / 退出子搜索模式 |
| 鼠标右键点击 logo | 打开设置（也可 `Ctrl+,` 或托盘菜单） |

> logo 按钮左键点击 = 搜索 `[系统项]`（与原版一致，系统项内含使用说明）。

### 快捷键配置（快捷键 / 作用类型 / 作用对象）

「设置 → 快捷键」里每条配置由三部分组成：

| 组成 | 说明 |
|------|------|
| **快捷键** | 点「点击修改快捷键」后按下组合键（必须含 Ctrl / Alt / Shift / Win 至少一个修饰键；Esc 取消、Backspace 清空） |
| **作用类型** | `呼出 / 隐藏搜索框`（默认，必需且全局只有一条，只能改键）或 `打开插件` |
| **作用对象** | 作用类型为「打开插件」时，下拉选择某个**已安装且已启用**的插件 |

- 「+ 添加快捷键」默认新增一条「打开插件」，自动挑一个未被占用的组合键（`Ctrl+Alt+1~9`，用满后 `Ctrl+Alt+F1~12`）
- 「打开插件」的键在**任意位置**按下即直接打开该插件的界面（窗口隐藏时会先按呼出逻辑显示窗口）；插件未启用或未授予「内嵌界面」权限时，行为与点搜索结果项完全一致（该弹授权弹授权）
- 插件被卸载/禁用时，对应条目在下拉里标注 `已卸载` / `已禁用`，删掉即可
- 所有改动立即生效并写入应用数据目录的 `settings.json`（键 `shortcut_bindings`）；旧版本的单键 `toggle_shortcut` 会自动迁移为一条「呼出 / 隐藏搜索框」绑定

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
│   │   │                       #   usePluginHost（注册表+网关）/ usePluginViewHost（插件视图挂载
│   │   │                       #   与会话保活）/ plugin-channels（会话通道 + DOM 载体）
│   │   └── config/             # 设置窗口：App.vue + panels/（订阅/标签/仓库/缓存/快捷键/常规/插件/关于/TisHub）
│   └── lib/                    # 纯逻辑层（无框架依赖，可直接单测）
│       ├── search-engine.ts    # 搜索核心：递归订阅加载、索引、三级搜索、权重/历史/新数据
│       ├── subscribe-parser.ts # 订阅解析：tis / fetchFun 双标签 / mLine·sLineFetchFun / 脚本项解析
│       ├── tags.ts             # 标签解析与彩色渲染
│       ├── overlap.ts          # 重叠匹配度算法（移植自原版）
│       ├── script-runtime.ts   # 脚本项运行时（new Function 沙箱）
│       ├── shortcut.ts         # 快捷键录入：keydown → 组合键字符串
│       ├── shortcut-bindings.ts # 快捷键绑定：快捷键 / 作用类型 / 作用对象（解析·校验·文案）
│       ├── util.ts             # 工具：转义、URL、Markdown、本地存储、防抖
│       ├── assets.ts           # 内嵌图标资源（由 test/gen-assets.mjs 生成）
│       ├── tauri-bridge.ts     # Tauri 桥接：HTTP 代理、窗口控制、外链打开
│       └── plugins/            # 插件系统（纯逻辑，可单测）
│           ├── manifest.ts     # 清单类型 + 校验 + 错误码中文文案
│           ├── package.ts      # .msplugin（ZIP）读写：手写 EOCD/中央目录解析、包裹目录剥离
│           ├── install.ts      # 安装包预处理：解包 → 校验 → 落盘文件表（含摘要）
│           ├── registry.ts     # 插件注册表：安装/升级/启停/授权/私有数据
│           ├── permissions.ts  # 权限目录：分组、风险、scope 覆盖规则
│           ├── host.ts         # 宿主 API 网关（前端侧 `ms.*` + 审计）
│           ├── ipc.ts          # 插件命令桥（Tauri / 浏览器调试降级）
│           ├── gateway.ts      # 注册表 → Rust 网关配置的唯一映射
│           ├── icon.ts         # 插件图标解析（相对路径 → data URL、MIME、取值顺序）
│           └── plugin-items.ts # 插件贡献的搜索项合成
├── src-tauri/                  # Rust 后端（Tauri 2.0）
│   ├── src/lib.rs              # 全局快捷键、悬浮窗定位、HTTP 代理回退、托盘、开机自启、命令
│   ├── src/plugin_host.rs      # 插件宿主：落盘、运行时网关、后台进程托管（Job Object / 进程组）
│   ├── capabilities/           # 权限配置
│   └── tauri.conf.json         # Tauri 配置
├── plugins/                    # 官方示例插件（含可直接安装的 .zip）
├── public/test-data/index.ms   # 示例订阅
└── test/                       # 开发期验证脚本（Node 运行）
```

---

## 🔧 技术说明

- **全局快捷键**：`tauri-plugin-global-shortcut` 注册。支持多条绑定，每条 = **快捷键 / 作用类型 / 作用对象**（`settings.json` 的 `shortcut_bindings` 数组）：`toggle-window` = 呼出 / 隐藏搜索窗（默认 `Ctrl+Alt+S`，只能一条）；`open-plugin` = 直接打开指定插件（Rust 端广播 `my-search://shortcut-open-plugin` 事件 + 插件 id，前端把窗口带到前台后由插件视图宿主打开，因此「插件是否存在 / 已启用 / 权限是否足够」的判断仍在前端注册表侧）。设置时**整体重新注册**，任一条被占用则回滚到改动前的整套绑定（不会出现「改了一半」）；旧版单键 `toggle_shortcut` 自动迁移为一条 toggle-window 绑定
- **开机自启动**：`tauri-plugin-autostart` 注册（**默认开启**，首次运行即写入系统启动项；用户偏好存于同一份 `settings.json` 的 `autostart_enabled`）。Windows 上写 `HKCU\...\CurrentVersion\Run`，读取时同时识别「任务管理器 → 启动」的启用/禁用覆盖，因此开关始终反映系统真实状态
- **自启动静默（不弹任何窗口）**：exe 在 Windows 上**无条件**使用 GUI 子系统（`main.rs` 的 `#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]`，debug 构建也一样）。登录时进程由 explorer.exe 拉起、没有父控制台，若 exe 是 console 子系统，Windows 会为它新建一个控制台黑窗口并一直挂着（本应用常驻托盘不退出）；主窗口本身是 `visible: false`，启动阶段不会 `show()`，所以修掉控制台后登录完全静默。dev 日志不受影响：从终端/`npm run tauri dev` 启动时 stdout/stderr 句柄被继承，`eprintln!` 照常显示（已实测）
- **自启动路径自愈**：登录拉起的是「注册表里记的那个 exe」而非「正在运行的 exe」，所以启动时会比对 Run 值里记录的路径与当前 exe，不一致就重写（仅在**正式构建**且自启动已开启时执行，dev 调试绝不改注册表，避免顶掉已安装版本的启动项）。Windows-only：Linux AppImage 的 `current_exe()` 是临时挂载路径，不能照搬这套比较
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

### 开机自启动弹出一个窗口（Windows 已修复）

**现象**：登录系统后，除了托盘的叶子图标，还会多出一个（黑）窗口——搜索窗本身没有自己跳出来。

**成因**：弹出来的不是主窗口，而是 **Windows 为 exe 新建的控制台窗口**。`main.rs` 早期写法是：

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
```

它只在 release 关闭控制台，**debug 构建仍是 console 子系统**（PE `OptionalHeader.Subsystem == 3`）。登录时进程由 explorer.exe 拉起、没有任何父控制台，Windows 就为它新建一个控制台窗口；而本应用常驻托盘不退出，黑窗口也就一直挂着。偏偏自启动项记录的是「首次写入时运行的那个 exe」——开发调试阶段跑的就是 `target\debug\...`，于是注册表里存下 debug 路径，重启登录就弹黑窗。（主窗口在 `tauri.conf.json` 里是 `visible: false`，启动阶段也不调 `show()`，与这个现象无关。）

**修法**（`src-tauri/src/main.rs`）：改成 Windows 上**无条件**使用 GUI 子系统——

```rust
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]
```

任何构建、任何启动方式都不再创建控制台窗口。dev 日志不受影响：从终端（`npm run tauri dev` / `start.bat` / `cargo run`）启动时 stdout/stderr 句柄仍被父进程继承，`eprintln!` 照常打印；只有登录自启这种「无控制台且无重定向」的场景才安静丢弃（Rust std 对无效句柄不 panic）。

**配套：自启动路径自愈**（`src-tauri/src/lib.rs` 的 `refresh_autostart_exe_path`）。`tauri-plugin-autostart` 的 `is_enabled()` 只看 Run 值在不在，不校验路径是否还有效，所以换安装位置后老路径会一直留着（旧文件删掉后自启动静默失效；若旧路径恰是 debug 构建，则继续弹黑窗）。启动时会比对 Run 值里记录的 exe 与当前 exe，不一致就重写为当前路径。两道闸门保证不误伤：**仅正式构建**（`!tauri::is_dev()`，避免本地调试顶掉已安装版本的启动项）+ **仅自启动已开启时**；且**仅 Windows**（Linux AppImage 的 `current_exe()` 返回临时挂载路径，照搬比较会把启动项写坏）。

相关测试：`node test/silent-autostart.test.mjs`（源码契约：main.rs 无条件 GUI 子系统、路径自愈与两道闸门都在启动流程里；产物验收：已构建的 debug / release exe 的 PE 子系统必须为 2=GUI，console(3) 即判失败）；`node test/_e2e-autostart.mjs`（真实注册表端到端：默认写入 Run 项、设置面板开关增删启动项、用户关闭后重启不被重新打开）。

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

## 🧩 插件系统

`设置 → 插件` 是插件的管理中心：安装、卸载、启用/禁用、权限撤销、后台进程启停、**关闭界面时 / 开机自启的默认值与覆盖**、日志查看。列表里**只有插件**——每条左侧显示插件自己的 logo（清单 `icon`：相对路径由宿主读成 data URL，`data:` / `http(s):` 原样直出，读不到时退回默认图标）。

> 订阅数据里的 `[脚本]` 项**不在这里露面**：它们没有清单、没有权限模型，生命周期跟着订阅走（装/卸插件的那套开关对它们没有意义）。这类条目照常在搜索结果里渲染与打开；早期版本把它们投影成「伪插件」列在面板里，现在打开面板会自动清掉这些历史遗留记录。

### 安装

| 方式 | 说明 |
|---|---|
| **从文件安装** | 选择 `.msplugin`（本质是 ZIP，也可直接用 `.zip`）。解包 → 剥离外层包裹目录 → 校验清单 → **展示权限清单让用户确认** → 原子落盘到 `plugins/<id>/`（写暂存目录再 rename，失败不破坏已装版本） |
| **从目录挂载** | 选择含 `plugin.json` 的开发目录，宿主只写一个 `.dev-source` 标记，读取时直接走源目录——**改完即自动重载**（见下），免打包 |

#### 目录挂载的热重载

挂载后的源目录由 Rust 侧（`notify`）递归监听，静默期 350ms 合并一次保存产生的连环事件，再向两个窗口广播 `plugin://dev-changed`。前端按事件里的**路径**决定动作：

| 改了什么 | 自动发生什么 |
|---|---|
| `ui/**`、图标等前端文件 | **已打开的插件界面自动重挂**（重新读 HTML/CSS/JS 并执行），结果列表里的图标与搜索项同步刷新 |
| `plugin.json` | 重读清单：名称 / 版本 / 描述 / 搜索项 / 后台入口都在注册表里就地更新；**用户态一律不动**（启用态、自启策略、关闭行为、已授权、拒绝记录） |
| `backend/**` 或清单 | 后台进程**当前在运行时**才自动重启；没在跑就不动它（避免改一行代码就平白拉起进程） |

两条安全底线：

- **新权限不静默授予**：改动清单新增权限时，只把第一条登记为「待授权」并提示用户到 `设置 → 插件` 确认，绝不因为改了个文件就悄悄扩权。
- **半截清单不乱动**：编辑器保存的中间态写出非法 JSON 时**跳过本次重载**（只记日志），等下一次事件——不会让插件凭空消失或记录被写坏。

打包发布用同一套 zip 实现，避免「打包器与解包器互相不认」：

```bash
node test/pack-plugin.mjs plugins/baidu-translate              # → dist/baidu-translate.msplugin
node test/pack-plugin.mjs plugins/baidu-translate -o out/x.msplugin
```

打包前会先跑清单校验，并检查 `detailView.entry` / `backend.entry` 等声明文件确实存在于包内（否则用户装上会打不开界面）。

### 清单（`plugin.json`）

```jsonc
{
  "id": "com.example.my-plugin",     // 反向域名，全局唯一
  "name": "我的插件",
  "version": "1.0.0",
  "apiVersion": 1,                   // 按哪一版插件 API 编写
  "minAppVersion": "7.9.15",         // 可选：最低宿主版本
  "permissions": ["ui.inlay", "net.fetch:https://api.example.com/*"],
  "contributes": {
    "searchItem": { "title": "[推荐][脚本]我的插件", "desc": "…", "keyword": "我的插件" },
    "detailView": {
      "entry": "ui/detail.html",     // 界面入口（相对插件根目录）
      "script": "ui/index.js",       // 可选：不写则按 detail.js → index.js 探测
      "compat": "ms-script-env",     // 可选：注入局部老脚本环境（老 view:js 可零改动迁移）
      "closeBehavior": "minimize"    // 可选：minimize | exit（纯前端插件的建议值来源）
    }
  },
  "backend": {                       // 可选：后台进程
    "entry": "backend/serve.exe",
    "protocol": "jsonrpc-stdio",
    "autostart": "on-demand",        // always | on-demand | prompt | never（只是「请求」）
    "closeBehavior": "minimize",     // minimize | exit（只是「请求」；与 detailView 同名项是一个开关）
    "idleExitSec": 30
  }
}
```

清单校验是纯函数（`src/lib/plugins/manifest.ts`），**永不抛异常**，返回可读中文文案（`describeManifestErrors`）——用户看到的是「缺少插件 id」，而不是 `id.missing`。

### 插件默认配置与用户覆盖

插件可以声明两个行为默认值，**用户在插件面板上随时可改**，且改动不会被插件升级覆盖：

| 配置 | 清单字段 | 取值 | 含义 |
|---|---|---|---|
| **关闭界面时** | `backend.closeBehavior` 或 `contributes.detailView.closeBehavior` | `minimize`（默认）/ `exit` | `minimize`＝**界面保留在后台**（DOM / 输入草稿 / 滚动位置 / 脚本内存态全部保留，再打开是「恢复」而不是重新加载），且后台进程继续跑（交给 `idleExitSec` 空闲回收）；`exit`＝**界面卸载**（下次打开重新读入口文件并重新执行脚本），且后台进程立即停止（`deactivate` 优雅退出 → `graceSec` 超时强杀） |
| **开机自启** | `backend.autostart` | `always` / `on-demand`（默认）/ `prompt` / `never` | `always`＝随应用启动即拉起后台进程并常驻（不做空闲回收）；`prompt`＝作者不表态，由用户决定 |

> 「关闭界面时」是**一个开关、两处生效**（界面 + 后台进程），用户只需理解一个概念：**最小化 = 一切留在后台，退出 = 全部收掉**。纯前端插件（没有 `backend`）同样显示这一行，它只体现界面那一半。两处清单字段的关系：**有效值只有一个**（注册表里的 `PluginRecord.closeBehavior`），带后台进程的插件写 `backend.closeBehavior` 即可，纯前端插件用 `contributes.detailView.closeBehavior` 表达诉求；两处都写且不一致时安装会给告警（`contributes.detailView.closeBehavior.conflictsWithBackend`），**生效时以 detailView 的声明为准**（「关闭界面时保留/卸载界面」首先说的是界面）。

三条规则（与权限模型同源：**声明 ≠ 生效**）：

1. **首次安装**落在插件建议值上（`prompt` 按 `on-demand` 处理）；
2. **升级只更新建议**——`upsertPlugin` 保留 `autoStart` / `closeBehavior` 的用户选择，否则插件能靠发版把自己设回「开机自启」或「常驻」，用户会失去控制感；
3. 面板上每项都显示「插件建议：…」，与当前值不同时出现**「恢复」**按钮，一键把该项写回插件建议值。

**开机自启与「关闭界面时」的关系**：`autostart=always` 意味着**进程**常驻，与「关闭界面即停进程」互相矛盾，此时**进程侧以开机自启为准**（清单同时声明会得到安装警告 `backend.closeBehavior.conflictsWithAlways`，面板上显示一行说明）。但**界面侧不受影响**：「退出」的插件即使进程常驻，界面照样卸载——界面要不要保留与进程是否常驻是两件事。进程判定集中在纯函数 `shouldStopBackendOnClose()`，界面保活判定集中在 `shouldKeepFrontendOnClose()`，关闭动作由搜索窗在 `usePluginViewHost.clear()` 这个唯一收口发出。

> 「关闭」指**关掉插件界面**（Esc / 开始新搜索 / 点开别的结果 / 打开别的插件）。插件界面是内嵌在搜索窗里的（独立窗口 `ui.window` 尚未实现）。

### 插件界面的保活（最小化）

`closeBehavior: minimize`（默认）的插件，关闭界面时**不会重新加载前端**：

- 插件会话（自己的 DOM 载体 + 脚本上下文 + `ms.*` + 通知监听）被整体**停靠**到隐身的停车场（`#ms-plugin-parking`），再次打开是**恢复**：脚本不再执行、状态原样（输入草稿、滚动位置、未落盘的会话状态都在）；
- 多个插件可以同时保活（不设上限）；打开另一个插件时，前一个按自己的 `closeBehavior` 处置；
- 会话载体是**每个插件一份的独立 DOM 树**（`.ms-plugin-session`），因此多个插件同时保活时 id / 样式不会互相撞车（插件用自己的 `document.getElementById` 照常取到节点）；
- 只有插件被**禁用 / 卸载**、**开发热重载**、**应用退出**时，保活会话才被真正销毁（这几种场景保活是错的）；
- 对插件作者的契约：**关闭界面 ≠ 卸载**，不要假设「再次打开会重新执行脚本」；需要跨会话持久化的状态仍应写 `ms.store` / `ms.backend`。

相关测试：`node test/plugin-keepalive.test.mjs`（纯逻辑：`decideViewClose` / `decideViewRestore` / `shouldKeepFrontendOnClose` / 清单校验与冲突告警）；`node test/plugin-keepalive-ui.test.mjs`（真实浏览器端到端：最小化插件关闭再打开不重跑脚本、草稿与滚动保留、exit 插件重新执行、多插件并存、禁用后清理、开发热重载重挂保活会话；需本机装有 Chrome / Edge，否则跳过）。

### 插件 API（`ms.*`）

插件的入口脚本拿到注入了宿主能力的 `ms` 对象（以及 `plugin` / `host` / `keyword` / `inputValue` / `onSubKeyword` / `env`）：

```js
ms.log("info", "视图已打开");
ms.search.query("关键词").then(rows => { /* … */ });
ms.store.set("key", value);               // 插件私有命名空间
ms.net.fetch("https://api.example.com/x"); // 经宿主 Rust 代理（绕 CORS，但受 scope 约束）
ms.system.writeClipboard("已复制");

onSubKeyword(msg => { /* 搜索框输入「我的插件 : 内容」时收到 */ });
```

### 权限（Android 式）

权限目录见 `src/lib/plugins/permissions.ts`（`search.read` / `search.write` / `ui.inlay` / `ui.window` / `ui.command` / `ui.notify` / `store` / `clipboard.read|write` / `selection.read` / `net.fetch:<scope>` / `system.openExternal` / `backend.spawn` / `secret.read:<name>`）。

- 清单里写的只是**请求**，只有用户确认后的 `grants` 才生效；
- 极高风险权限（`backend.spawn`、`secret.read`、`scope: "*"`）在安装时**逐条强提示**「该插件可在你的电脑上运行程序」；
- 未授予时插件调用会抛 `PluginPermissionError`，用户同意后重试即可（拒绝不崩）；
- Tauri 的 capabilities 是编译期静态、粒度到窗口，做不到「每个插件一套权限」，所以插件权限全部走运行时的宿主网关；Rust 侧按已授予的权限**再拦一道**（前端被绕过的假设下依然拒绝）。

### 后台进程

- 宿主 spawn 并托管（**绝不写系统自启动项**，进程生死只由面板 / 前台视图 / 应用退出驱动）；协议为 stdio JSON-RPC 2.0；
- 「开机自启」的判定发生在应用启动时，因此网关镜像会落盘到 `plugin-gateway.json`，启动时先读回再按 `autoStart === "always"` 拉起（否则那一刻前端还没加载，自启动形同死代码）；
- 进程树清理：Windows 用 Job Object（`KILL_ON_JOB_CLOSE`，宿主崩溃时子进程一起走），Unix 用进程组——`Child::kill()` 只杀直接子进程，会留孤儿；
- 空闲自动退出（`idleExitSec`，`always` 的插件不回收）、崩溃退避重启（1s/5s/30s，上限 `maxRestarts`）、日志落 `plugin-logs/<id>.log`（面板可看，超过 1MB 保留尾部）。
- 前台视图的关闭联动：`closeBehavior=exit` 的插件在界面关闭时立即停止进程（判定见 `shouldStopBackendOnClose`），其余交给空闲回收——两条路径都复用同一个 `stop_backend`（`deactivate` → `graceSec` → 强杀）。**注意 `graceSec` 的实现语义**：清单文档写的是「前台关闭后保留窗口期」，实际是停止时的优雅等待上限；真正承担「保留窗口」职责的是 `idleExitSec`。界面侧的保活（`minimize` 时 DOM 与脚本上下文不销毁）走另一条判定 `shouldKeepFrontendOnClose`，见上文「插件界面的保活（最小化）」。

### 已知边界（诚实说明）

- **inlay 不是沙箱**：插件界面与宿主运行在同一个 `window` / 同一份 `localStorage` 里，和现有 `[脚本]` 项是同一信任级别。CSS 会被限到 `#text_show .plugin-view` 作用域内，但脚本本身能碰宿主 DOM——真正的边界在 `ms.*`（插件拿不到裸 Tauri IPC）。需要强隔离请等独立窗口形态（`ui.window`，v1 未实现）。
- 宿主挂载点刻意用 `#ms-app` 而不是最通用的 `#app`：同文档下插件脚本一个 `getElementById("app")` 就会命中宿主根节点并覆盖整个界面（这个坑在开发中真实踩到过）。
- 插件贡献的搜索项**不写入 `SEARCH_DATA_KEY` 缓存**（缓存带订阅指纹、且是网络数据的落盘副本），改由挂载时重新合成；加载完成→挂载→索引在引擎里是一条链（`_attachExtraItems`）。
- 插件声明了 `keyword` 的条目会被自动补上 `[可搜索]` 标记，否则按 `Tab` 进入子搜索模式后插件项会从结果里消失、`onSubKeyword` 永远收不到消息。
- **保活会话不是「后台运行」**：`minimize` 只是让插件的 DOM 与脚本上下文留在内存里（定时器、未完成的请求会继续跑，因为 JS 语义如此）。要真正停下来，请把插件设为「退出」，或让插件自己提供停止入口。保活数量不设上限——插件很多时内存会随打开过的插件数增长。
- **宿主的插件节点是「会话载体」而不是容器内容**：`.plugin-view` 里由宿主 append/remove 一个 `.ms-plugin-session` 子节点（每个插件一个，形如 `<div class="ms-plugin-session" data-ms-plugin-session="<id>">`），它是停靠/恢复的最小搬运单位。宿主的 CSS 作用域前缀按 `#text_show .plugin-view` 生成（与老行为一致），因此插件样式在停靠期间不生效、恢复后立即生效。
- **设置窗口的加载预算**：`config.html` 带一个「页面加载失败，请重启应用」的兜底提示。它原本是固定 8 秒触发，而设置窗口同时被要求「不加载搜索引擎等重型依赖」——插件面板早期**静态**引入了 `search-engine` 的键常量，把 `pinyin-pro` 一起拖进首屏模块图，冷启动挂载从 ~1.7s 涨到 ~6.9s，慢机器上直接撞上兜底变成误报。
  两条修复：① 存储键拆到零依赖的 `src/lib/search-keys.ts`，插件面板改为 `defineAsyncComponent` 延迟加载（只在点「插件」时才取）；② 兜底改为「页面仍在加载就续期、连续静默才放弃」，不再把「加载慢」误判成「加载失败」。
  **改动设置窗口的 import 时请留意首屏模块图**：`npm run build` 后看 `config-*.js` 的静态 `import` 是否引入了大 chunk，是则说明又漏了东西进首屏。

相关测试：`node test/plugin-package.test.mjs`（ZIP 读写与安全边界：EOCD 越界回归、包裹目录剥离、写读往返、路径穿越 / 加密包 / 截断包拒绝）；`node test/plugin-install.test.mjs`（安装链路：真实包端到端、清单校验与可读文案、权限与 backend 一致性、数值夹紧）；`node test/plugin-icon.test.mjs`（插件图标解析：MIME 映射、三种引用形态判定、预读集合与列表取用顺序）；`node test/plugin-behavior.test.mjs`（行为默认值：`closeBehavior` 校验与默认值、冲突告警、安装落建议值、**升级不覆盖用户选择**、老注册表读时迁移、`shouldStopBackendOnClose` 判定矩阵）；`node test/plugin-keepalive.test.mjs`（界面保活纯逻辑：`contributes.detailView.closeBehavior` 校验与「与 backend 声明冲突」告警、建议值口径、`shouldKeepFrontendOnClose` 判定矩阵、`decideViewClose` / `decideViewRestore`、保活会话也参与开发热重载重挂）；`node test/plugin-keepalive-ui.test.mjs`（真实浏览器端到端保活：最小化关闭再打开**不重跑脚本**且草稿/滚动保留、exit 关闭即卸载且重开重跑、多插件并存保活、禁用后清理、热重载重挂）；`node test/plugin-ui.test.mjs`（真实浏览器：从文件安装 → 面板出现插件 → 插件项参与检索 → 打开插件视图 → `ms.store` 生效 → 子关键词转发 → 最小化后的会话停靠与快捷键恢复）；`node test/plugin-panel-ui.test.mjs`（真实浏览器：插件面板**只列插件**（订阅里的 `[脚本]` 项不出现、历史遗留记录被清理）、左侧 logo 的三种形态（相对路径读成 data URL / 网络地址直出 / 无图标与读失败退回默认图标）、行为设置三行与「插件建议 / 恢复 / 开机自启时的说明」）；`node test/plugin-close-behavior-ui.test.mjs`（真实浏览器端到端：`exit` 关界面即发 `plugin_backend_stop`、`minimize` 不发、`always` 优先不停、用户改值后立刻按新值执行、无后端插件不误停；均需本机装有 Chrome / Edge，否则跳过）。Rust 侧：`cd src-tauri && cargo test --lib`。

---

## 💾 备份与同步

桌面版新增了完整的**备份与同步**功能。支持本地导出 `.msbackup` 归档（普通 ZIP，任何解压工具都能打开查看），以及 **WebDAV 云端同步**。

### 备份内容

一份完整的备份包含：

| 类型 | 内容 |
|------|------|
| **localStorage** | 订阅原文、标签偏好、搜索权重、历史记录、已安装 TisHub 列表、插件注册表（所有插件的启用/禁用/权限开关） |
| **插件文件** | `plugins/<id>/` 下安装的全部文件（manifest、UI 视图、后端可执行程序） |
| **插件数据** | `plugin-data/<id>/` 下后端进程产生的数据 |
| **Rust 侧设置** | 快捷键绑定、开机自启动偏好 |

**不备份**的内容：GitHub Token、WebDAV 密码、本地数据缓存（`SEARCH_DATA_KEY`）与订阅指纹（均可由主窗口自动重建）、插件日志（运行时诊断数据）。

### 导出 / 导入

面板以 **tab 方式**组织在最上方：

**导出** — 将当前全部配置与插件打包为一个 `.msbackup` 文件：
- **保存到…**：通过系统对话框选择位置（用户可自行管理到自己的云盘）
- **导出到下载目录**：一键导出到系统「下载」文件夹，同时也保留一份到备份目录
- **打开备份目录**：保存的本地历史均在 `backups/` 下

**导入** — 两段式流程：先「选择备份文件」预览内容，确认后再选择性还原：

| 还原模式 | 内容 |
|---------|------|
| **全量还原** | 配置 + 插件 + 设置全部覆盖 |
| **仅插件与设置** | 只恢复插件文件、插件数据和快捷键/自启设置 |
| **仅配置** | 只恢复订阅、标签、权重等 localStorage 数据 |

还原前**自动留底**（`backups/pre-restore-<时间戳>.msbackup`），误操作可手动恢复。

### WebDAV 云端同步

在「设置 → 备份与同步」面板中开启后：

1. **数据变更触发**：localStorage 有任何写入时，5 秒后自动创建快照并同步到 WebDAV（连续编辑会被合并）
2. **定时兜底**：每 30 分钟（可配置 5~60 分钟）后台检查一次指纹，发现本机或远端有变化时自动同步
3. **冲突策略**：
   - **按修改时间**（默认）：谁最后修改就用谁的
   - **本机优先**：始终用本机覆盖远端
   - **远端优先**：始终用远端覆盖本机
   - **每次询问**：冲突时弹出对话框让用户决定

支持任何标准 WebDAV 服务：坚果云、Nextcloud、InfiniCloud、自建等。凭据（密码）仅保存在本机，不进备份、不上传。

### 测试

Rust 侧单测覆盖路径安全、时间解析、归档往返、拒绝非备份包：

```bash
cd src-tauri && cargo test --lib
```

前端：`node test/sync-panel-ui.test.mjs`（真实浏览器验证设置窗口「备份与同步」面板的布局：
导出/导入按钮必须并排一行（600px 最小窗口宽度下也不换行）、「保存到…」按钮不带多余图标、
WebDAV 的 4 个输入框与 2 个下拉框走主题样式（圆角 / 主题底色描边 / 非原生控件 appearance）、
输入框左边缘对齐且右边缘与卡片内容区重合、无横向溢出，并留亮暗两套截图；需本机装有 Chrome / Edge，否则跳过）。

---

## 📄 License

MIT © zhuangjie
