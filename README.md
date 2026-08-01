# 我的搜索（桌面版）

> 打造订阅式搜索，让我的搜索，只搜精品！

「我的搜索」是 [zhuangjie](https://github.com/My-Search/my-search) 开发的订阅式搜索脚本（油猴版 v7.9.5）的**桌面版**迁移。本桌面版使用 **Tauri 2.0**（Rust 后端 + WebView 前端）实现，支持 **Windows / macOS / Linux** 三大平台。

## ✨ 功能特性

- **全局悬浮窗**：按 `Ctrl+Alt+S` 随时呼出/隐藏搜索窗（全局快捷键，任意应用下可用）
- **订阅式搜索**：订阅自定义内容源（网站/软件/教程/应用），只搜精品
- **三级搜索**：精确搜索 → 拼音搜索 → 重叠模糊匹配
- **内置官方订阅**：「小庄的收藏室」（作者 zhuangjie 的收藏）、「系统项」
- **订阅管理**：可视化添加/移除/刷新订阅，支持 `tis::` 格式与直接 URL
- **键盘流操作**：`↑↓` 选择、`Enter` 打开、`Esc` 隐藏
- **悬浮窗体验**：无边框、置顶、失焦自动隐藏、可拖拽

## 🚀 快速开始

### 环境要求

| 平台 | 要求 |
|------|------|
| Windows | Windows 10/11，WebView2 |
| macOS | macOS 10.15+ |
| Linux | WebKitGTK 4.1（见下方） |

### 开发环境

```bash
# Node.js 18+ / Rust 1.70+
npm install

# Linux 系统依赖（Ubuntu/Debian）
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

### 开发运行

```bash
npm run tauri dev
```

### 构建发布

```bash
# 构建当前平台安装包
npm run tauri build

# 跨平台构建（需要对应平台环境/CI）
# Windows: npm run tauri build -- --target x86_64-pc-windows-msvc
# macOS:   npm run tauri build -- --target aarch64-apple-darwin
# Linux:   npm run tauri build -- --target x86_64-unknown-linux-gnu
```

## 📁 项目结构

```
my-search-desktop/
├── src/                    # 前端（Vite + 原生 JS）
│   ├── main.js             # 主应用：视图渲染、交互、订阅管理
│   ├── css/style.css       # 全局样式
│   └── lib/
│       ├── search-engine.js    # 搜索核心：拼音、多级匹配、数据索引
│       ├── subscribe-parser.js # 订阅解析：tis 标签、mLineFetchFun
│       ├── overlap.js          # 重叠匹配度算法（移植）
│       └── tauri-bridge.js     # Tauri 桥接：HTTP 代理、窗口控制
├── src-tauri/              # Rust 后端（Tauri 2.0）
│   ├── src/
│   │   ├── lib.rs          # 主逻辑：全局快捷键、悬浮窗、HTTP 代理
│   │   └── main.rs         # 入口
│   ├── capabilities/       # 权限配置
│   └── tauri.conf.json     # Tauri 配置
└── package.json
```

## 🔧 技术说明

- **全局快捷键**：`tauri-plugin-global-shortcut` 注册 `Ctrl+Alt+S`
- **悬浮窗**：无边框（`decorations: false`）+ 透明 + 置顶 + 跳过任务栏 + 失焦自动隐藏
- **HTTP 代理**：Rust 端 `reqwest` 提供 `http_get` 命令，前端拉取订阅绕开 CORS
- **拼音搜索**：`pinyin-pro` 库（本地化，无外部 CDN）
- **订阅协议**：兼容油猴版 `tis::` 标签格式与 `mLineFetchFun` 提取函数

## 📄 License

MIT © zhuangjie
