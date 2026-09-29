# 截图插件（`com.zhuangjie.screenshot`）

「我的搜索」的**三方插件示例**，演示一个完整可用的截图工具：

| 能力 | 实现位置 |
| --- | --- |
| 全局快捷键截图（可在前台改绑） | 宿主 Rust（`screenshot` 动作）+ 本插件前台设置项 |
| 框选区域 + 标注（矩形/椭圆/箭头/画笔/文字/马赛克） | 宿主遮罩窗口 `overlay.html` |
| 截完自动写入剪贴板 | 宿主 `screenshot_copy_image`（原生写图） |
| 查看最近 7 天截图（分页） | 本插件前台 `ui/index.js` |

> 本目录同时是一份**教学样例**：注释写明了每处设计决策与踩过的坑，
> 想照着写自己的插件时可以直接参考。

---

## 一、目录结构

```
plugins/screenshot/
├── plugin.json          # 清单（id / 权限 / 贡献点 / 后端）
├── meta.json            # 市场展示元数据（打包时自动排除）
├── icon.svg
├── README.md            # 本文件
├── ui/
│   ├── detail.html      # 前台界面：快捷键 + 画廊 + 分页 + 大图
│   ├── detail.css       # 只用宿主主题变量 var(--token, 兜底)
│   └── index.js         # 前台逻辑（宿主注入 ms API）
└── backend/             # 可选的后台进程示例（见第五节）
    ├── index.mjs        # jsonrpc-stdio 协议
    ├── capture.ps1      # PowerShell 兜底抓屏
    ├── run.cmd / run.sh # 启动器（Windows 上必须纯 ASCII）
    └── package.json
```

`meta.json` 不会进入分发的 `.mspp` 包（打包器排除），只用于市场展示。

---

## 二、三条需求的实现方式

### 1. 后台运行后监听快捷键

**关键点：全局热键不是插件注册的，是宿主注册的。**

插件前台的「快捷键」按钮只是**读改写宿主的绑定列表**：

```js
// 读当前绑定（权威存储在宿主的 settings.json 里，插件不自己存一份）
const key = await ms.screenshot.getShortcut();   // "ctrl+alt+x"

// 改绑（冲突会抛错，文案可直接给用户看）
await ms.screenshot.setShortcut("ctrl+alt+shift+a");

// 解绑（等于关掉截图热键）
await ms.screenshot.setShortcut("");
```

为什么不在插件里自己注册热键？因为插件详情视图跑在搜索窗的 WebView 里
（`detailView.mode` 只允许 `inlay`），拿不到操作系统的全局热键；而且插件
可能被卸载/禁用，热键注册必须跟着宿主生命周期走。宿主的
「设置 → 快捷键」面板和本插件的按钮读写的是同一份数据，所以两边永远一致。

默认键是 `Ctrl+Alt+X`（避开微信 `Alt+A`、QQ `Ctrl+Alt+A`、Snipaste `F1`
以及宿主自己的 `Ctrl+Alt+S`）。

**热键为什么可能「前台显示了、按下去却没反应」——一个容易踩的坑。**
截图热键只存在于宿主的绑定列表里是不够的：**只有列表里的条目才真的被注册到系统**。
本插件通过清单里的 `contributes.shortcut` 声明「提供截图这个宿主动作」
（见 `plugin.json`）：

```jsonc
"shortcut": { "action": "screenshot", "title": "截图（框选 + 标注）", "defaultShortcut": "ctrl+alt+x" }
```

- **装了本插件**（清单带这段声明）后，宿主会把 `Ctrl+Alt+X` 自动加进绑定列表并注册到系统；
- 未安装时列表里没有这一条，设置面板里也不会出现「截图」这个作用类型；
- `screenshot_unbound` 标记：区分「从没配过」（要自动加）与「用户主动解绑了」
  （不能加，否则解绑后一重启它又回来了）。

插件侧对应的约定：**`getShortcut()` 返回空串就表示没绑**（前台显示「未设置」），
不要用默认值兜底——兜底出来的键可能根本没注册到系统。

### 2. 截取后自动写入剪贴板

宿主 `screenshot_copy_image` 命令把 PNG 转成 Windows 剪贴板的 `CF_DIB`
写进去——这是**原生写图**，不是 `navigator.clipboard.writeText`，
所以能粘进任何支持图片的程序（Word、微信、画图…）。

流程：按热键 → 遮罩框选 → 点「复制」→ 已在剪贴板。
前台画廊里点开大图也有「复制」按钮，走同一个 API。

### 3. 查看最近 7 天截图（分页）

```js
// 拿到插件私有目录里的全部截图（宿主已按时间从新到旧排好）
const all = await ms.screenshot.list();

// 只保留最近 7 天
const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
const recent = all.filter((it) => it.mtimeMs >= cutoff);

// 分页：每页 24 张
const pageItems = recent.slice(page * 24, (page + 1) * 24);

// 缩略图按需读取（每张都是完整 PNG 的 base64，所以要限流）
const dataUrl = await ms.screenshot.readShot(item.relPath);
```

- 统计行同时显示「最近 7 天 N 张」和「共 M 张」——后者含 7 天外的，
  让用户知道文件还在（不是被删了，只是不在窗口内）。
- 缩略图**只读当前页**（≤24 张），翻页才读下一页——天然就是懒加载，
  也不会因为一次读几百张把界面卡住。
- 后台截图保存后会广播事件，打开中的画廊自动刷新：

  ```js
  ms.screenshot.onSaved(() => reload());
  ```

  视图没打开时事件丢弃，下次打开 `list()` 兜底，所以**不需要常驻轮询**。

---

## 三、权限说明

| 权限 | 为什么需要 |
| --- | --- |
| `ui.inlay` | 在搜索窗里显示插件界面（插件视图的准入权限） |
| `ui.notify` | 操作反馈（删除确认等） |
| `store` | 记住「上次看到第几页」 |
| `clipboard.write` | 把截图写进剪贴板 |
| `screenshot.capture` | 抓取屏幕图像 |
| `screenshot.overlay` | 调起全屏框选遮罩 |
| `screenshot.write` | 把截图存进插件私有目录 |
| `screenshot.read` | 读回自己目录里的截图 |

**刻意没有申请 `backend.spawn`**（放在 `optionalPermissions` 里）：
上面三条能力全部由宿主完成，不需要后台进程。`backend.spawn` 是「等同运行
本机程序」的极高风险权限，能不给就不给——这也是给三方插件的建议。

---

## 四、数据放在哪

```
<应用数据目录>/plugin-data/com.zhuangjie.screenshot/shots/*.png
```

- **写（画廊收录）**：`ms.screenshot.save()` → 宿主
  `screenshot_save_shot`。文件名由宿主生成，插件只能给图片数据，
  **没法指定路径**（从根上杜绝目录穿越）。
- **另存为（用户选位置）**：`ms.screenshot.saveAs(dataUrl, parentDir?)`
  → 宿主弹系统保存对话框，用户自己挑目录和文件名。用户取消时
  resolve(null)（**不是错误，调用方应静默返回**）；落盘成功返回绝对路径。
  遮罩页的「保存」按钮和画廊大图预览的「另存为…」按钮都走这条路径——
  落盘到插件截图目录内时，宿主会自动收进画廊并广播刷新。
- **读**：`ms.screenshot.readShot("shots/xxx.png")` → 宿主校验
  「必须以 `shots/` 开头 + 平铺文件名 + 图片扩展名」后才读。
- **删**：`ms.screenshot.remove(relPath)`。
- **清理**：`ms.screenshot.prune(7)` 删除早于 7 天的。

其它插件读不到这个目录：宿主的文件读取默认只允许「用户粘贴/拖入搜索框的
附件」，插件私有目录走的是另一条**按插件 id 隔离**的通道。

---

## 五、可选的后台进程（示例）

`backend/` 下的进程是**可选**的：上面三条能力全部由宿主 Rust 侧完成，
它不参与。声明它是为了演示两件事：

1. **jsonrpc-stdio 协议怎么写**：NDJSON（一行一个 JSON）、`init` 握手、
   `deactivate` 优雅退出、`log` 通知、自定义通知转 `plugin://notification`。
2. **不依赖宿主截图能力的兜底抓屏**：用 PowerShell 的
   `System.Drawing.CopyFromScreen` 抓整屏并落盘（零 npm 依赖）。

想学「插件自带后台进程」可以直接看 `backend/index.mjs` 的注释，
它逐条说明了协议约定与常见坑（尤其是「别用 `console.log` 打日志，
stdout 是协议通道」）。

### 「按需启动 + 关闭即退出」是怎么生效的（清单里的策略只是请求）

截图能力（热键注册、抓屏、落盘）**全部由宿主 Rust 侧完成**，本插件的后台进程
只是可选示例，**不需要常驻**。因此这里把它配成「按需启动、关闭界面即退出」：

```jsonc
"backend": {
  "autostart": "on-demand",   // 不要开机自启：只有真正用到后台进程时才拉起
  "closeBehavior": "exit"      // 关闭插件界面即停止后台进程
},
"contributes": {
  "detailView": { "closeBehavior": "exit" }  // 与上面同义（同一个开关的两处声明）
}
```

清单里写的是**作者的建议**，真正执行的是记录里的 `autoStart` / `closeBehavior`
字段（用户可在「设置 → 插件」改，用户的选择永远优先）。

有一个容易踩的坑值得说明，因为它表现为「改了清单却毫无反应」：

- **升级/内容刷新时**，作者改了自己的建议值只在**用户没动过这个开关时**才生效
  （见 `resolveAutoStartOnUpgrade`）。少了这条跟随，`requestedAutoStart`
  会被写进记录却无人读取，作者永远改不动自己的默认值。
- **目录挂载的插件**靠文件监听热重载，而监听只在应用**运行期间**有效。
  作者在应用关闭时改了 `plugin.json`，重启后没有事件来触发重载，
  记录里还是旧清单——所以宿主在启动时会主动重读一遍
  （`refreshDevManifests`，见 `src/lib/plugins/install-builtin.ts`）。

> 说明：`autostart` 与 `closeBehavior` 影响的是**后台进程**的生命周期。
> 截图热键由宿主注册，与后台进程无关——即使进程没在跑，按 `Ctrl+Alt+X`
> 也照样能框选截图（宿主直接完成）。

另外注意 `backend.spawn` 在本插件里是 `optionalPermissions`。宿主只启动
**已授权**的后台进程：没授予时进程不会被拉起，上面的三条能力也照常可用。

---

## 六、本地调试与打包

**目录挂载调试**（改完即生效，不需要打包）：

1. 「设置 → 插件」里选择「从目录挂载」，指向本目录；
2. 改 `ui/**` 会自动重载；改 `plugin.json` 会在下次启动时重读
   （运行期间改动也会由文件监听热重载）。

**打包**：

```bash
node test/pack-plugin.mjs plugins/screenshot -o dist/com.zhuangjie.screenshot.mspp
```

打包器会先跑与宿主**同一份**清单校验，并确认清单声明的入口文件确实存在
（`detailView.entry` / `backend.entry`），校验不过直接失败。

**回归测试**（本插件自带）：

```bash
node test/screenshot-plugin-ui.test.mjs   # 最近 7 天 + 分页 + 交互（真实浏览器）
```

---

## 七、已知边界

- **平台**：宿主原生抓屏目前只在 Windows 实现（GDI `BitBlt`）。
  其它平台可走本插件 backend 的 PowerShell 路径（Windows）/ 自行扩展。
- **混合 DPI 多屏**：宿主按「每屏一个遮罩窗口」处理，避免跨屏缩放拉伸；
  遮罩上标注的坐标按各屏自己的缩放换算。
- **系统级安全软件**：某些录屏保护窗口（如部分银行/DRM 界面）会抓成黑块，
  这是操作系统的保护机制，任何截图工具都绕不过。
