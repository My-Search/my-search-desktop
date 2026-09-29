//! 我的搜索桌面版 - Tauri 后端
//!
//! 功能：
//! - 全局快捷键（默认 Ctrl+Alt+S，可在设置中自定义）呼出/隐藏悬浮搜索窗
//! - 悬浮窗：无边框、置顶、随鼠标位置弹出、跳过任务栏、失焦自动隐藏
//! - 系统托盘：显示/隐藏、设置、清理缓存、退出
//! - HTTP 代理（http_get）：订阅拉取绕开 CORS，内置多级回退
//!   jsDelivr CDN(优先，国内可达) → raw.githubusercontent.com(直连兜底) → GitHub API
//! - 通用 HTTP 代理（http_request）：供订阅管理窗口的 TisHub 市场使用
//!   （GET 搜索/列表，POST 提交 issues，可携带 GitHub Token）
//! - WebView 数据目录固定化：保证 localStorage（订阅/历史/权重）持久化
//! - 订阅/配置存储（JSON 文件，基于 tauri-plugin-store）

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};
use tauri_plugin_autostart::{AutoLaunchManager, ManagerExt as AutostartManagerExt};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_store::StoreExt;

// Alt+点击带入是 Windows 资源管理器专属功能（低级鼠标钩子 + UIA/COM 解析），
// 整个模块只依赖 Windows API，故按平台整体编入/剔除。
#[cfg(windows)]
mod alt_click;
/// 非 Windows：同名的空实现，让 lib.rs 的调用点保持平台无关。
/// 功能在 Windows 之外不存在，故 `is_enabled` 恒为 false。
#[cfg(not(windows))]
mod alt_click {
    /// Windows 之外没有该功能，恒为关闭。
    pub fn is_enabled() -> bool {
        false
    }
    /// 空实现（无可启用的钩子）。
    pub fn set_enabled(_enabled: bool) {}
    /// 空实现（无钩子可装）。
    pub fn install(_app: tauri::AppHandle) {}
}
mod attachments;
mod backup;
mod builtin;
mod clipboard_history;
mod cloud;
mod file_assoc;
mod market;
mod plugin_host;
mod plugin_watch;
mod screenshot;
mod system_proxy;

/// 存储已下载的安装文件路径，供 open_installer 使用
struct DownloadedInstallerPath(Mutex<Option<String>>);

/// 全局快捷键组合：呼出/隐藏主窗口的**默认值**（用户可在「设置 → 快捷键设置」自定义，
/// 自定义值持久化在 settings.json，见 get_shortcut_bindings / set_shortcut_bindings）
const DEFAULT_TOGGLE_SHORTCUT: &str = "ctrl+alt+s";

/// 设置存储文件（tauri-plugin-store，位于应用数据目录）
const SETTINGS_STORE_FILE: &str = "settings.json";
/// 设置存储里「呼出/隐藏快捷键」的键名（**旧版单键格式**，仅用于迁移读取）
const SETTINGS_KEY_TOGGLE_SHORTCUT: &str = "toggle_shortcut";

/// 设置存储里「快捷键绑定列表」的键名（新版：每条 = 快捷键 + 作用类型 + 作用对象）
const SETTINGS_KEY_SHORTCUT_BINDINGS: &str = "shortcut_bindings";

/// 设置存储里「截图热键已被用户主动解绑」的键名。
///
/// 为什么要单独记一个标记：`read_shortcut_bindings` 会**自愈补齐**缺失的截图
/// 绑定（老用户的列表里本来就没有它，而热键只有真的注册到系统才生效）。
/// 但「列表里没有截图绑定」有两种含义——「从没配过」与「用户主动解绑了」。
/// 前者要补齐，后者必须尊重，否则用户解绑后一重启它又回来，像个关不掉的开关。
const SETTINGS_KEY_SCREENSHOT_UNBOUND: &str = "screenshot_unbound";

/// 设置存储里「剪贴板历史热键已被用户主动解绑」的键名。
///
/// 与 `SETTINGS_KEY_SCREENSHOT_UNBOUND` 同理：`read_shortcut_bindings` 会自愈补齐
/// 缺失的剪贴板历史绑定，必须能区分「从没配过」（要补）与「用户主动解绑」（要尊重）。
const SETTINGS_KEY_CLIPBOARD_UNBOUND: &str = "clipboard_unbound";

/// 快捷键作用类型：呼出/隐藏搜索窗（默认，仅允许一条）
const SHORTCUT_ACTION_TOGGLE_WINDOW: &str = "toggle-window";
/// 快捷键作用类型：直接打开某个插件（作用对象 = 插件 id）
const SHORTCUT_ACTION_OPEN_PLUGIN: &str = "open-plugin";
/// 快捷键作用类型：快速过滤（作用对象 = 常用头文本，如「百度翻译」；
/// 前端呼出后填入「常用头 + 二次搜索分隔符」并立即进入子搜索）
const SHORTCUT_ACTION_QUICK_FILTER: &str = "quick-filter";
/// 快捷键作用类型：快捷打开项（作用对象 = 匹配文本，如「百度翻译」；
/// 前端按文本精确匹配数据项并直接打开，等价于点击结果项）
const SHORTCUT_ACTION_QUICK_OPEN: &str = "quick-open";
/// 快捷键作用类型：截图（抓屏 + 全屏框选，无需作用对象。
/// 实现见 screenshot.rs；这是唯一「不经过前端」的动作——直接在 Rust 里开遮罩窗口，
/// 因为遮罩必须是独立窗口，插件详情视图办不到）
const SHORTCUT_ACTION_SCREENSHOT: &str = "screenshot";

/// 「截图」动作的默认快捷键（首次安装 / 尚未绑定时使用）。
/// 选 ctrl+alt+x：与微信 Alt+A、QQ Ctrl+Alt+A、Snipaste F1 都不冲突，
/// 也不占用宿主自己的 ctrl+alt+s。
const DEFAULT_SCREENSHOT_SHORTCUT: &str = "ctrl+alt+x";

/// 快捷键作用类型：剪贴板历史（无需作用对象）。
///
/// 与截图不同，它**走前端**：Rust 只负责把主窗口带到前台 + 广播事件
/// （`EVENT_CLIPBOARD_UPDATED`），由前端打开内置插件 `com.mysearch.clipboard`
/// 的详情视图（inlay 能在主 WebView 里开，无需独立窗口）。
const SHORTCUT_ACTION_CLIPBOARD: &str = "clipboard";

/// 「剪贴板历史」动作的默认快捷键。
/// 选 ctrl+alt+v：贴近「粘贴」的直觉，且不与宿主 ctrl+alt+s（呼出）、
/// ctrl+alt+x（截图）冲突。
const DEFAULT_CLIPBOARD_SHORTCUT: &str = "ctrl+alt+v";

/// 快捷键（open-plugin）触发时向主窗口广播的事件名，payload = { pluginId }
const EVENT_SHORTCUT_OPEN_PLUGIN: &str = "my-search://shortcut-open-plugin";
/// 快捷键（quick-filter）触发时向主窗口广播的事件名，payload = { filter }
const EVENT_SHORTCUT_QUICK_FILTER: &str = "my-search://shortcut-quick-filter";
/// 快捷键（quick-open）触发时向主窗口广播的事件名，payload = { text }
const EVENT_SHORTCUT_QUICK_OPEN: &str = "my-search://shortcut-quick-open";
/// 快捷键（clipboard）触发时向主窗口广播的事件名，payload = { pluginId }
/// （前端据此打开剪贴板历史插件的详情视图）
const EVENT_SHORTCUT_CLIPBOARD: &str = "my-search://shortcut-clipboard";

/// 资源管理器「Alt+点击文件」触发时向主窗口广播的事件名，
/// payload = { paths: string[] }（前端并入附件，与粘贴/拖入同管线）。
/// 必须在 show_main_window 的「窗口已显示」事件**之后**发出（见 alt_click.rs）。
///
/// 仅 Windows 有产生方（alt_click 整体按平台裁剪），故非 Windows 下一并省去，
/// 否则会是一条「常量未使用」告警。前端监听端不受影响：事件名是两边约定的字符串。
#[cfg(windows)]
const EVENT_ATTACH_PATHS: &str = "my-search://attach-paths";

/// 双击 `.mspp` 插件包（或把路径作为参数传给本程序）时广播的事件名，无 payload。
///
/// 前端（设置窗口）收到后调 `take_pending_plugin_open` **拉取**路径——事件只负责「叫醒」，
/// 真正的数据在幂等的拉取命令里。这样 setup 阶段的广播即使早于前端挂监听
/// 也不会丢（前端挂载时会主动拉一次，见 config/App.vue 的 handleExternalPluginOpen）。
const EVENT_OPEN_PLUGIN_PACKAGE: &str = "my-search://open-plugin-package";

/// 待处理的「打开插件包」路径（双击 .mspp 或命令行传入）。
///
/// 为什么用全局槽而不是直接随事件带 payload：双击可能发生在**进程启动阶段**
/// （WebView 还没加载完，监听尚未注册），也可能发生在**已有实例**上（单实例
/// 插件回调里）。两条路径都往这里放，前端通过幂等的 `take_pending_plugin_open`
/// 取走（取出即清空），因此不会重复弹窗，也不会丢事件。
static PENDING_PLUGIN_OPEN: Mutex<Option<String>> = Mutex::new(None);

/// 放入一个待打开的插件包路径（覆盖旧的：连续双击多个包时只处理最后一个，
/// 与资源管理器「打开」的实际语义一致——用户最后一次操作才是意图）。
fn set_pending_plugin_open(path: String) {
    if let Ok(mut guard) = PENDING_PLUGIN_OPEN.lock() {
        *guard = Some(path);
    }
}

/// 取出并清空待处理路径（幂等：重复调用第二次返回 None）
fn take_pending_plugin_open_inner() -> Option<String> {
    PENDING_PLUGIN_OPEN
        .lock()
        .ok()
        .and_then(|mut guard| guard.take())
}

/// 处理「用插件包启动/呼出」：置入待处理槽 → 打开配置窗口（插件面板）→ 广播叫醒事件。
///
/// 顺序要紧：先放数据再广播，否则前端可能在事件到达后立刻拉取而拉空。
fn open_plugin_package(app: &tauri::AppHandle, path: String) {
    set_pending_plugin_open(path);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        open_config_window(handle).await;
    });
    if let Err(e) = app.emit(EVENT_OPEN_PLUGIN_PACKAGE, ()) {
        eprintln!("广播插件包打开事件失败: {e}");
    }
}

/// 设置存储里「开机自启动」用户偏好的键名
const SETTINGS_KEY_AUTOSTART_ENABLED: &str = "autostart_enabled";
/// 「开机自启动」默认值：安装后随系统登录自动启动，常驻托盘随叫随到，
/// 用户可在「设置 → 常规设置」里关闭。
const DEFAULT_AUTOSTART_ENABLED: bool = true;

/// 设置存储里「Alt+点击文件快速带入」的键名（资源管理器/桌面中
/// 按住 Alt 点击文件 → 呼出搜索框并自动附加该文件）
const SETTINGS_KEY_ALT_CLICK: &str = "alt_click_attach";
/// 「Alt+点击文件快速带入」默认值（可在「设置 → 常规设置」关闭）
const DEFAULT_ALT_CLICK_ENABLED: bool = true;

/// 设置存储里「关联 .mspp 插件包」的键名（写 HKCU 文件关联，双击即安装）
const SETTINGS_KEY_FILE_ASSOC: &str = "file_assoc_mspp";
/// 「关联 .mspp 插件包」默认值（可在「设置 → 常规设置」关闭）
const DEFAULT_FILE_ASSOC_ENABLED: bool = true;

/// 程序化呼出后的「失焦抑制」截止时刻（毫秒级 UNix 时间戳，0 = 不抑制）。
///
/// 为什么需要：主窗口规则是**失焦即隐藏**。但 Alt+点击发生在资源管理器里——
/// 点击本身让资源管理器成为前台窗口，而我们随后 `show()`+`set_focus()` 时，
/// Windows 的前台锁定（foreground lock）常常不允许后台进程夺焦，于是窗口刚
/// 显示就收到 `Focused(false)`，被失焦规则立刻隐藏 => 表现为「点了没反应」。
///
/// 处理：程序化呼出（show_main_window）时登记一个短暂抑制窗口，期间的失焦
/// 事件一律忽略——把「呼出后立即被点击残留的失焦吃掉」与「用户主动点到别的
/// 窗口」区分开。抑制窗口过后，正常的失焦隐藏规则照旧。
static SUPPRESS_BLUR_UNTIL_MS: AtomicU64 = AtomicU64::new(0);

/// 失焦抑制时长：足够覆盖 show → 前台锁定抖动 → 用户看到窗口这一小段时间，
/// 又短到不会误挡用户真正的切换动作。
const BLUR_SUPPRESS_MS: u64 = 600;

/// 当前 UNIX 毫秒时间戳（取不到则 0）
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 本次会话是否已经应用过「开机自启动」偏好。
/// 注册表等系统级写操作只在首次运行时做一次，之后启动不再重复写。
static AUTOSTART_APPLIED: AtomicBool = AtomicBool::new(false);

/// 主题变更事件名（通知所有 WebView 窗口同步主题样式）
const EVENT_THEME_CHANGED: &str = "my-search://theme-changed";

/// 设置存储里「主题」的键名（存主题**偏好**："light" / "dark" / "system"。
/// 老版本写的是已解析的 light/dark，值域兼容，按偏好解析即可）。
const SETTINGS_KEY_THEME: &str = "theme";

/// 主题偏好：用户在设置里的三档选择。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ThemePref {
    Light,
    Dark,
    /// 跟随系统：原生层**不钉主题**（`set_theme(None)`），实时随系统变化
    System,
}

/// 当前主题状态（单锁原子读写，避免「偏好」与「解析值」分别更新产生竞态）。
///
/// 主题偏好存于 WebView 的 localStorage，Rust 进程读不到，由前端
/// `apply_app_theme` 上报**（偏好, 已解析深浅色）**两值：
/// - **偏好**决定原生层钉不钉主题：强制 light/dark → `set_theme(Some(..))` 钉住；
///   system → `set_theme(None)` 恢复实时跟随。钉住会经 tao → ThemeChanged → wry
///   把 WebView2 的 `PreferredColorScheme` 一并锁死（钉住期间 tao 还会忽略系统
///   主题变化）——system 模式若也钉，前端 `matchMedia` 读回的永远是钉住值，
///   形成「切回跟随系统后停留在旧颜色」的自锁闭环。
/// - **已解析值**仅供窗口底色铺底（防首帧闪白）：来自前端 `matchMedia`，与
///   WebView2 渲染同源；system 模式下 Rust 只能读注册表（非 Windows 读不到），
///   以上报值更准。两者为 None = 尚未上报。
struct ThemeState {
    pref: Option<ThemePref>,
    resolved_dark: Option<bool>,
}

static APP_THEME: Mutex<ThemeState> = Mutex::new(ThemeState {
    pref: None,
    resolved_dark: None,
});

/// 把主题字符串解析为**偏好**（仅接受 light / dark / system）
fn parse_theme_pref(theme: &str) -> Option<ThemePref> {
    match theme {
        "light" => Some(ThemePref::Light),
        "dark" => Some(ThemePref::Dark),
        "system" => Some(ThemePref::System),
        _ => None,
    }
}

/// 把**已解析**的深浅色字符串解析为 bool（仅接受 light / dark，拒绝 system——
/// 解析值必须是二选一，不能把 system 透到这里当颜色用）
fn parse_resolved(resolved: &str) -> Option<bool> {
    match resolved {
        "dark" => Some(true),
        "light" => Some(false),
        _ => None,
    }
}

/// 读取已落盘的主题偏好（冷启动 / 创建设置窗口时用于铺底）
fn read_theme_pref(app: &tauri::AppHandle) -> Option<ThemePref> {
    settings_store(app)
        .and_then(|store| store.get(SETTINGS_KEY_THEME))
        .and_then(|v| v.as_str().and_then(parse_theme_pref))
}

/// 把主题**偏好**写入 settings store（store 不可用时静默跳过，与自启动设置同款降级）
fn write_theme_pref(app: &tauri::AppHandle, pref: ThemePref) {
    let value = match pref {
        ThemePref::Light => "light",
        ThemePref::Dark => "dark",
        ThemePref::System => "system",
    };
    if let Some(store) = settings_store(app) {
        store.set(SETTINGS_KEY_THEME, serde_json::Value::String(value.to_string()));
        if let Err(e) = store.save() {
            eprintln!("保存主题设置失败: {e}");
        }
    }
}

/// 系统当前是否为深色（读注册表 AppsUseLightTheme，与 WebView2 的
/// `prefers-color-scheme` 同源）。仅在尚未收到前端上报时用作兜底。
#[cfg(windows)]
fn system_is_dark() -> bool {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;

    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(
            r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
            KEY_READ,
        )
        .ok()
        .and_then(|key| key.get_value::<u32, _>("AppsUseLightTheme").ok())
        .map(|light| light == 0)
        .unwrap_or(false)
}

/// 非 Windows 平台没有该注册表项：默认浅色（前端上报后即以上报值为准）
#[cfg(not(windows))]
fn system_is_dark() -> bool {
    false
}

/// 当前主题状态：偏好优先内存中前端上报值，其次落盘偏好，最后 system；
/// 解析值优先上报值（与 WebView2 渲染同源），否则按偏好现算。
fn current_theme(app: &tauri::AppHandle) -> (ThemePref, bool) {
    let state = APP_THEME
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let pref = state
        .pref
        .or_else(|| read_theme_pref(app))
        .unwrap_or(ThemePref::System);
    let resolved_dark = state.resolved_dark.unwrap_or_else(|| resolve_is_dark(pref));
    (pref, resolved_dark)
}

/// 偏好 → 深浅色：强制档直接取值；system 读注册表 AppsUseLightTheme
/// （与 WebView2 的 `prefers-color-scheme` 默认值同源）。用于铺底背景色
/// 与尚未收到前端上报时的兜底。
fn resolve_is_dark(pref: ThemePref) -> bool {
    match pref {
        ThemePref::Dark => true,
        ThemePref::Light => false,
        ThemePref::System => system_is_dark(),
    }
}

/// 偏好 → 原生窗口主题：None = 清掉钉住、实时跟随系统（**system 档专用**）
fn native_theme(pref: ThemePref) -> Option<tauri::Theme> {
    match pref {
        ThemePref::System => None,
        ThemePref::Dark => Some(tauri::Theme::Dark),
        ThemePref::Light => Some(tauri::Theme::Light),
    }
}

/// 把主题应用到**所有窗口**的原生层：原生框架主题（Windows 标题栏 DWM 深/浅色、
/// macOS 外观）+ WebView 底色。
/// - 强制 light/dark：`set_theme(Some(..))` 显式钉住（不依赖 OS 自动跟踪），
///   保证标题栏与页面内容始终同色。
/// - system：`set_theme(None)` **恢复实时跟随系统**。钉住期间 tao 会忽略系统
///   主题变化、并经 ThemeChanged → wry 把 WebView2 的 PreferredColorScheme 一并
///   锁死（前端 matchMedia 失灵，无法感知系统变化），因此 system 档绝不能钉。
fn apply_theme_to_windows(app: &tauri::AppHandle, pref: ThemePref, resolved_dark: bool) {
    use tauri::window::Color;

    let native = native_theme(pref);
    for (label, win) in app.webview_windows() {
        let _ = win.set_theme(native);
        // 浅色下各窗口底色不同：主窗口 html/body 是纯白，设置窗口是 --surface #f5f6f8
        let background = if resolved_dark {
            Color(23, 25, 29, 255) // #17191d —— 与深色主题一致
        } else if label == "main" {
            Color(255, 255, 255, 255)
        } else {
            Color(245, 246, 248, 255) // #f5f6f8 —— 与浅色主题 --surface 一致
        };
        let _ = win.set_background_color(Some(background));
    }
}

/// 应用主题（前端上报**（偏好, 已解析深浅色）**）到原生层，并广播 CSS 同步事件。
///
/// - `theme`：主题**偏好** "light" / "dark" / "system" —— 决定原生层钉不钉主题
///   （system → `set_theme(None)` 实时跟随，详见 `apply_theme_to_windows`）
/// - `resolved`：仅 "light" / "dark"（前端已按系统偏好解析）—— 只用于窗口底色铺底
/// - 记录到内存 + settings.json（供冷启动与创建设置窗口时铺底）
/// - 同步所有窗口的原生标题栏主题与 WebView 底色
/// - 广播 theme-changed 事件，让各窗口前端重新应用 CSS 类
///
/// 幂等保护：（偏好, 解析值）均未变时跳过 apply_theme_to_windows + emit
///（避免设置窗口初始化时 setThemeReporter → applyAppTheme 触发冗余的
/// set_background_color / set_theme / 事件广播，导致 WebView2 重绘闪烁）。
/// 仅偏好变化（如 light → system 而两档解析值相同）也必须执行——那正是
/// 「解钉」的时刻，漏掉便会停留在强制主题上。
#[tauri::command]
fn apply_app_theme(app: tauri::AppHandle, theme: String, resolved: String) -> Result<(), String> {
    let Some(pref) = parse_theme_pref(&theme) else {
        return Err(format!("无效主题: {theme}（仅接受 light / dark / system）"));
    };
    let Some(resolved_dark) = parse_resolved(&resolved) else {
        return Err(format!("无效解析主题: {resolved}（仅接受已解析的 light / dark）"));
    };
    // 在同一锁作用域下完成读旧值与写新值，避免并发竞态
    let unchanged = {
        let mut guard = APP_THEME
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let unchanged =
            guard.pref == Some(pref) && guard.resolved_dark == Some(resolved_dark);
        guard.pref = Some(pref);
        guard.resolved_dark = Some(resolved_dark);
        unchanged
    };
    write_theme_pref(&app, pref);
    // 主题未变：只更新持久化值，跳过重绘与广播（避免首帧闪烁/重绘循环）
    if unchanged {
        return Ok(());
    }
    apply_theme_to_windows(&app, pref, resolved_dark);
    app.emit(EVENT_THEME_CHANGED, ()).map_err(|e| e.to_string())?;
    Ok(())
}

/// 主窗口每次显示时向前端广播的事件名（前端据此清理残留状态）
const EVENT_MAIN_WINDOW_SHOWN: &str = "my-search://main-window-shown";

/// 搜索框（含边框）高度，与前端 BOX_HEIGHT 保持一致。
/// 隐藏窗口时把窗口收回到这个高度，避免下次呼出时残留上一次的高窗口（下面空一大块）。
/// 48 = 2(上边框)+44(#searchBox)+2(下边框)，缩放下取整对称、上下灰边等厚。
const COLLAPSED_WINDOW_HEIGHT: f64 = 48.0;

// ===================== 窗口定位 =====================
/// 选择目标显示器：优先取鼠标所在屏幕（多显示器下更符合直觉），
/// 取不到时回退到窗口当前所在屏幕。
fn target_monitor(window: &tauri::WebviewWindow) -> Option<tauri::Monitor> {
    if let Ok(cursor) = window.cursor_position() {
        if let Ok(Some(monitor)) = window.monitor_from_point(cursor.x, cursor.y) {
            return Some(monitor);
        }
    }
    window.current_monitor().ok().flatten()
}

/// 将窗口移动到目标显示器的顶部居中位置（y 约为屏幕高度的 22%），
/// 与原版一致：呼出时显示在屏幕偏上的居中位置，而不是跟随鼠标。
///
/// `monitor`：由调用方选定并显式传入，避免此处再次查询（多显示器下鼠标可能
/// 已移动）导致「按 A 屏定宽、却按 B 屏居中」。
/// `logical_width`：即将设置的窗口逻辑宽度。显式传入而不用 `outer_size()` 回读，
/// 因为 Windows 上刚 `set_size` 后回读可能仍是旧尺寸（本项目曾因此出现首帧错位），
/// 会导致居中偏左/偏右。传入目标宽度后按显示器缩放换算成物理像素参与居中。
fn position_window_top_center(
    window: &tauri::WebviewWindow,
    monitor: &tauri::Monitor,
    logical_width: f64,
) {
    let screen = monitor.size();
    let origin = monitor.position();
    let scale = monitor.scale_factor();
    let scale = if scale > 0.0 { scale } else { 1.0 };
    let win_w = (logical_width * scale).round().max(0.0) as u32;
    // 宽度未知时退回回读值，保证仍能居中
    let win_w = if win_w == 0 {
        window.outer_size().map(|s| s.width).unwrap_or(screen.width)
    } else {
        win_w
    };
    let win_h = window.outer_size().map(|s| s.height).unwrap_or(0);
    // 考虑显示器自身偏移，保证多显示器下也居中于所在屏幕
    let x = origin.x + ((screen.width.saturating_sub(win_w)) / 2) as i32;
    let y = origin.y
        + ((screen.height as f64 * 0.22) as u32).min(screen.height.saturating_sub(win_h)) as i32;
    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
}

/// 显示主窗口（呼出）：先选定目标屏幕（鼠标所在屏，回退窗口当前屏），
/// 按该屏宽度比例定宽，再居中定位，最后显示并聚焦，最后广播「窗口已显示」事件。
///
/// 宽度与居中必须用同一块屏幕、且先定宽再定位，否则会按旧宽度居中而偏左/偏右
/// （多显示器下更明显）。
fn show_main_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if let Some(monitor) = target_monitor(&window) {
        let width = target_window_width(&monitor);
        let _ = window.set_size(tauri::LogicalSize::new(width, COLLAPSED_WINDOW_HEIGHT));
        position_window_top_center(&window, &monitor, width);
    } else {
        collapse_main_window(&window);
        let _ = window.center();
    }
    let _ = window.show();
    let _ = window.set_focus();
    // 呼出后短时间内抑制「失焦即隐藏」：见 SUPPRESS_BLUR_UNTIL_MS 的说明。
    SUPPRESS_BLUR_UNTIL_MS.store(now_ms() + BLUR_SUPPRESS_MS, Ordering::Relaxed);
    // 强行带到前台：Alt+点击场景下点击已让资源管理器取得前台，单纯的
    // show()+set_focus() 会被 Windows 前台锁定拒绝（见 force_foreground 注释）。
    // 该绕过依赖 Win32（AttachThreadInput/SetForegroundWindow），仅 Windows 需要：
    // 其它平台没有前台锁定这套机制，show()+set_focus() 已经足够。
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        alt_click::force_foreground(windows::Win32::Foundation::HWND(hwnd.0 as *mut _));
    }
    // 通知前端：窗口重新显示（前端据此复位残留的详情/结果视图与高度，
    // 避免“上次搜过之后再次呼出，下面空着一大块”的问题；
    // 输入框内容属于用户会话，前端会保留并重新触发搜索）
    let _ = app.emit(EVENT_MAIN_WINDOW_SHOWN, ());
}

/// 悬浮窗呼出/隐藏切换
fn toggle_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            collapse_main_window(&window);
            let _ = window.hide();
        } else {
            show_main_window(app);
        }
    }
}

/// 「打开插件」快捷键的落地：确保主窗口可见，然后广播插件 id 由前端打开插件视图。
///
/// 为什么由前端开：插件视图是 WebView 里的 DOM（详情视图容器），
/// Rust 侧只负责把窗口带到前台与投递事件；插件是否存在、是否启用、
/// 权限是否足够这些判断都在前端注册表侧完成（Rust 不持有注册表）。
fn open_plugin_by_shortcut(app: &tauri::AppHandle, plugin_id: &str) {
    if plugin_id.trim().is_empty() {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        if !window.is_visible().unwrap_or(false) {
            // 隐藏状态下按插件快捷键：先按呼出逻辑显示窗口（含窗口已显示事件的复位）
            show_main_window(app);
        } else {
            let _ = window.set_focus();
        }
    }
    let _ = app.emit(
        EVENT_SHORTCUT_OPEN_PLUGIN,
        serde_json::json!({ "pluginId": plugin_id }),
    );
}

/// 从设置窗口打开某插件的界面（插件面板的「从插件市场安装」按钮）。
///
/// 插件详情视图只存在于主搜索窗口的 WebView 里，因此这里：收起设置窗口 →
/// 走与全局快捷键**完全相同**的 `open_plugin_by_shortcut`（呼出主窗口 + 广播
/// open-plugin 事件）。插件是否存在 / 是否启用 / 有没有界面这些判断都在前端
/// 注册表侧完成（Rust 不持有注册表），这里只负责窗口编排。
///
/// 复用 `open_plugin_by_shortcut` 而不是自己 show+emit：它内部的 `show_main_window`
/// 会先广播「窗口已显示」（前端据此复位残留视图），之后才发 open-plugin 事件，
/// 顺序反了会被复位清掉。
#[tauri::command]
fn open_plugin_view(app: tauri::AppHandle, plugin_id: String) {
    if let Some(cfg) = app.get_webview_window("config") {
        if cfg.is_visible().unwrap_or(false) {
            let _ = cfg.hide();
        }
    }
    open_plugin_by_shortcut(&app, &plugin_id);
}

/// 「剪贴板历史」快捷键的落地：确保主窗口可见，然后广播事件由前端打开插件详情视图。
///
/// 与 `open_plugin_by_shortcut` 同构，只是固定作用于内置剪贴板插件：
/// Rust 侧负责把窗口带到前台 + 投递事件；插件是否存在/启用/有权限都在前端判定。
/// 单独用一个事件名（而非复用 open-plugin）：前端可据此把「热键呼出」与
/// 「用户在设置里绑了 open-plugin」区分开，做不同的展示处理。
fn clipboard_by_shortcut(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if !window.is_visible().unwrap_or(false) {
            show_main_window(app);
        } else {
            let _ = window.set_focus();
        }
    }
    let _ = app.emit(
        EVENT_SHORTCUT_CLIPBOARD,
        serde_json::json!({ "pluginId": clipboard_history::CLIPBOARD_PLUGIN_ID }),
    );
}

/// 「快速过滤」快捷键的落地：确保主窗口可见，然后广播常用头由前端填入搜索框并立即搜索。
///
/// 与 `open_plugin_by_shortcut` 同构：Rust 侧只负责把窗口带到前台与投递事件；
/// 拼接二次搜索分隔符、光标定位、触发搜索都在前端（那里才持有输入框与搜索状态）。
/// 事件必须在 `show_main_window` 的内部广播（窗口已显示）**之后**发出：前端收到后
/// 复位视图再填入内容，顺序反了会被复位清掉。
fn quick_filter_by_shortcut(app: &tauri::AppHandle, filter: &str) {
    let filter = filter.trim();
    if filter.is_empty() {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        if !window.is_visible().unwrap_or(false) {
            // 隐藏状态下按快速过滤快捷键：先按呼出逻辑显示窗口（含窗口已显示事件的复位）
            show_main_window(app);
        } else {
            let _ = window.set_focus();
        }
    }
    let _ = app.emit(
        EVENT_SHORTCUT_QUICK_FILTER,
        serde_json::json!({ "filter": filter }),
    );
}

/// 「快捷打开项」快捷键的落地：确保主窗口可见，然后广播匹配文本由前端精确匹配并打开。
///
/// 与 `quick_filter_by_shortcut` 同构：Rust 侧只负责把窗口带到前台与投递事件；
/// 匹配、打开、多项时列结果都在前端（那里才持有引擎与结果视图）。
fn quick_open_by_shortcut(app: &tauri::AppHandle, text: &str) {
    let text = text.trim();
    if text.is_empty() {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        if !window.is_visible().unwrap_or(false) {
            // 隐藏状态下按快捷打开快捷键：先按呼出逻辑显示窗口（含窗口已显示事件的复位）
            show_main_window(app);
        } else {
            let _ = window.set_focus();
        }
    }
    let _ = app.emit(
        EVENT_SHORTCUT_QUICK_OPEN,
        serde_json::json!({ "text": text }),
    );
}

/// 持有当前已注册的全部快捷键绑定，便于重新设置时先 unregister。
struct ActiveShortcutState(Mutex<Vec<ShortcutBinding>>);

/// 获取 settings store（tauri-plugin-store），已加载则复用。
/// 失败（文件锁 / 路径问题）时降级为禁用自定义快捷键——不会让应用启动失败。
fn settings_store(app: &tauri::AppHandle) -> Option<std::sync::Arc<tauri_plugin_store::Store<tauri::Wry>>> {
    match app.store(SETTINGS_STORE_FILE) {
        Ok(store) => Some(store),
        Err(e) => {
            eprintln!("打开设置存储失败（settings.json），自定义快捷键不可用: {e}");
            None
        }
    }
}

/// 从 settings store 中读取「开机自启动」用户偏好。
/// 返回 None 表示从未写入过（首次运行，此时按默认值处理，见 `DEFAULT_AUTOSTART_ENABLED`）。
fn read_autostart_pref(app: &tauri::AppHandle) -> Option<bool> {
    settings_store(app)
        .and_then(|store| store.get(SETTINGS_KEY_AUTOSTART_ENABLED))
        .and_then(|v| v.as_bool())
}

/// 把「开机自启动」偏好写入 settings store（store 不可用时静默跳过：
/// 本次已生效，只是重启后回落到默认值，与快捷键设置的降级策略一致）。
fn write_autostart_pref(app: &tauri::AppHandle, enabled: bool) {
    if let Some(store) = settings_store(app) {
        store.set(
            SETTINGS_KEY_AUTOSTART_ENABLED,
            serde_json::Value::Bool(enabled),
        );
        if let Err(e) = store.save() {
            eprintln!("保存自启动设置失败: {e}");
        }
    }
}

/// 从 settings store 中读取「Alt+点击文件快速带入」偏好。
/// 返回 None 表示从未写入过（首次运行，按 `DEFAULT_ALT_CLICK_ENABLED` 处理）。
fn read_alt_click_pref(app: &tauri::AppHandle) -> Option<bool> {
    settings_store(app)
        .and_then(|store| store.get(SETTINGS_KEY_ALT_CLICK))
        .and_then(|v| v.as_bool())
}

/// 把「Alt+点击文件快速带入」偏好写入 settings store（store 不可用时静默跳过：
/// 本次已生效，重启后回落到默认值，与其它设置项的降级策略一致）。
fn write_alt_click_pref(app: &tauri::AppHandle, enabled: bool) {
    if let Some(store) = settings_store(app) {
        store.set(SETTINGS_KEY_ALT_CLICK, serde_json::Value::Bool(enabled));
        if let Err(e) = store.save() {
            eprintln!("保存 Alt+点击设置失败: {e}");
        }
    }
}

/// 读取「关联 .mspp 插件包」偏好（None = 从未写过，按默认值处理）。
fn read_file_assoc_pref(app: &tauri::AppHandle) -> Option<bool> {
    settings_store(app)
        .and_then(|store| store.get(SETTINGS_KEY_FILE_ASSOC))
        .and_then(|v| v.as_bool())
}

/// 写入「关联 .mspp 插件包」偏好。
fn write_file_assoc_pref(app: &tauri::AppHandle, enabled: bool) {
    if let Some(store) = settings_store(app) {
        store.set(SETTINGS_KEY_FILE_ASSOC, serde_json::Value::Bool(enabled));
        if let Err(e) = store.save() {
            eprintln!("保存文件关联设置失败: {e}");
        }
    }
}

/// 按偏好把 `.mspp` 文件关联登记/注销到系统（幂等）。
///
/// dev 与正式构建**同样**登记：开发期也需要「双击 .mspp → 安装确认」的完整体验，
/// 因此不再对 dev 构建设限（早期版本曾默认禁止 dev 写注册表以免把关联指向
/// `target/debug/...exe`、顶掉已安装正式版，但那会逼着开发时只能手动配环境变量，
/// 与「开发环境也要能关联」的需求相悖）。
/// 注销不受限制：任何构建下关掉开关都应能清干净（dev 下若之前注册过，关开关即清除）。
///
/// **注意方向不对称**：开启可能失败，关闭不会。失败必须**如实向上报错**，
/// 不能静默吞掉——否则前端会误以为生效并把偏好写成 `true`，与注册表实际状态
/// 长期矛盾（见 `set_file_assoc_enabled_cmd` 的写入时机）。
fn apply_file_assoc_preference(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    if enabled {
        file_assoc::register(app)
    } else {
        file_assoc::unregister()
    }
}

/// 取出自启动插件提供的管理器（需要 `ManagerExt` 在作用域内）。
fn autolaunch_manager(app: &tauri::AppHandle) -> tauri::State<'_, AutoLaunchManager> {
    AutostartManagerExt::autolaunch(app)
}

/// 注册表里「开机自启动」所在的键（Windows）
#[cfg(windows)]
const AUTOSTART_RUN_KEY: &str = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run";

/// 从自启动项的值里解析出 exe 路径。
///
/// 值由 `auto-launch` 写成 `"{exe} {args...}"`（本应用无参数，故通常就是裸路径，
/// 可能带结尾空格）。两种形态都要认：
///   - 带引号：`"C:\Program Files\MySearch\MySearch.exe" --flag`
///   - 不带引号：`C:\MySearch\MySearch.exe ` / `C:\MySearch\MySearch.exe --flag`
///
/// 解析策略：先按引号切（有引号时取引号内）；否则截到最后一个 `.exe` 为止
/// （参数只会出现在 exe 之后，而路径里的目录名极少含 `.exe`）。
#[cfg(any(windows, test))]
fn parse_autostart_exe(value: &str) -> String {
    let v = value.trim();
    if let Some(rest) = v.strip_prefix('"') {
        // 带引号：取到配对引号为止
        return rest.split('"').next().unwrap_or(rest).trim().to_string();
    }
    // 不带引号：截到 `.exe`（大小写不敏感）
    let lower = v.to_ascii_lowercase();
    match lower.rfind(".exe") {
        Some(i) => v[..i + 4].trim().to_string(),
        None => v.to_string(),
    }
}

/// 判断自启动项记录的路径与当前 exe 是否指向同一个文件。
/// Windows 路径大小写不敏感，`/` 与 `\` 等价，比较前统一归一化。
#[cfg(any(windows, test))]
fn autostart_path_matches(registered: &str, current: &str) -> bool {
    let norm = |s: &str| {
        parse_autostart_exe(s)
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_ascii_lowercase()
    };
    !registered.trim().is_empty() && !current.trim().is_empty() && norm(registered) == norm(current)
}

/// 读出自启动项里当前记录的 exe 路径（Windows；读不到返回 None）。
#[cfg(windows)]
fn registered_autostart_path(app: &tauri::AppHandle) -> Option<String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;

    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(AUTOSTART_RUN_KEY, KEY_READ)
        .ok()?;
    key.get_value::<String, _>(app.package_info().name.as_str())
        .ok()
}

/// 自启动项路径自愈：登录时拉起的是「注册表里记的那个 exe」，而不是「正在
/// 运行的这个 exe」。开发期先跑过 debug 版、之后再安装到别处的 release 版时，
/// 老路径会一直留着（`is_enabled()` 只看值在不在，不看路径对不对）——表现为
/// 「开机自启拉起来的是旧位置/开发目录的版本」，旧文件删掉后更是静默失效，
/// 老版本还可能正是会弹控制台窗口的那种构建。这里在启动时发现不一致就把
/// 启动项重写为当前 exe（`enable()` 即重写 Run 值）。
///
/// 两道闸门：
/// - **只在正式构建里生效**（`!tauri::is_dev()`，即带 `custom-protocol` 的
///   `tauri build` 产物）。`npm run tauri dev` / 裸 `cargo build` 绝不改注册表，
///   否则本地调试会把「已安装版本」的启动项顶掉，登录改成拉起开发目录里的构建。
/// - 只在 Run 值已存在（即自启动开着）时执行，不会凭空创建启动项。
///
/// **仅 Windows**：Linux 上 AppImage 的 `current_exe()` 返回的是挂载点内的
/// 临时路径，而插件写入的是 `.AppImage` 文件路径，两者天然不同——照搬这套
/// 比较会把启动项改写成一次性的挂载路径（崩溃式误伤）。macOS 的 LaunchAgent
/// 同理不适用（.app 包路径由插件自己处理）。
#[cfg(windows)]
fn refresh_autostart_exe_path(app: &tauri::AppHandle) {
    if tauri::is_dev() {
        return;
    }
    let Some(registered) = registered_autostart_path(app) else {
        return;
    };
    let Ok(current) = std::env::current_exe() else {
        return;
    };
    let current = current.display().to_string();
    if !autostart_path_matches(&registered, &current) {
        if let Err(e) = autolaunch_manager(app).enable() {
            eprintln!("更新开机自启动路径失败（不影响启动）: {e}");
        }
    }
}

#[cfg(not(windows))]
fn refresh_autostart_exe_path(_app: &tauri::AppHandle) {}

/// 查询系统里「开机自启动」当前是否真的生效。
/// 直接以系统状态为准：用户在「任务管理器 → 启动」里手动禁用后，这里立刻反映真实结果。
fn is_autostart_enabled(app: &tauri::AppHandle) -> Result<bool, String> {
    autolaunch_manager(app)
        .is_enabled()
        .map_err(|e| format!("读取开机自启动状态失败: {e}"))
}

/// 写入/清除系统自启动项（Windows 上是 HKCU Run 注册表值）。
/// 幂等：状态已经正确时不重复写系统注册表。
fn set_autostart_enabled(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let manager = autolaunch_manager(app);
    if let Ok(current) = manager.is_enabled() {
        if current == enabled {
            return Ok(());
        }
    }
    if enabled {
        manager
            .enable()
            .map_err(|e| format!("开启开机自启动失败: {e}"))?;
    } else {
        manager
            .disable()
            .map_err(|e| format!("关闭开机自启动失败: {e}"))?;
    }
    Ok(())
}

/// 首次运行时应用「开机自启动」偏好（启动阶段调用，绝不让应用启动失败）。
///
/// - 首次运行（settings.json 里没有该键）：按默认值开启（`DEFAULT_AUTOSTART_ENABLED`）
///   并把偏好落盘，此后不再重复写系统启动项。
/// - 之后每次启动：只在系统状态与用户偏好不一致时纠正一次。
/// - 偏好为「开启」时，额外纠正启动项里记录的 exe 路径（见
///   `refresh_autostart_exe_path`）：换了安装位置 / 开发期的 debug 路径
///   残留在注册表里时，登录会拉起错误的那份。
fn apply_autostart_preference(app: &tauri::AppHandle) {
    if AUTOSTART_APPLIED.swap(true, Ordering::SeqCst) {
        return;
    }
    let saved = read_autostart_pref(app);
    let want = saved.unwrap_or(DEFAULT_AUTOSTART_ENABLED);
    if saved.is_none() {
        write_autostart_pref(app, want);
    }
    if let Err(e) = set_autostart_enabled(app, want) {
        eprintln!("应用开机自启动设置失败（不影响启动）: {e}");
    }
    // 仅在「用户开着自启动」时校正路径：关着的时候不该动注册表
    if want {
        refresh_autostart_exe_path(app);
    }
}

/// 设置存储里「快捷键绑定」的一条记录：**快捷键 / 作用类型 / 作用对象**。
///
/// 序列化形态与前端 `src/lib/shortcut-bindings.ts` 的 ShortcutBinding 一致，
/// 落在 settings.json 的 `shortcut_bindings` 键下：
/// ```json
/// { "shortcut": "ctrl+alt+s", "action": "toggle-window", "target": null }
/// { "shortcut": "ctrl+alt+1", "action": "open-plugin",   "target": "com.x.y" }
/// { "shortcut": "alt+f",      "action": "quick-filter",  "target": "百度翻译" }
/// { "shortcut": "alt+o",      "action": "quick-open",    "target": "百度翻译" }
/// ```
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ShortcutBinding {
    /// 组合键字符串（小写、+ 连接、修饰键在前，如 "ctrl+alt+s"）
    pub(crate) shortcut: String,
    /// 作用类型：toggle-window / open-plugin / quick-filter / quick-open
    pub(crate) action: String,
    /// 作用对象：open-plugin 时为插件 id，quick-filter 时为常用头文本，
    /// quick-open 时为匹配文本，toggle-window 时为 None
    pub(crate) target: Option<String>,
}

/// 该作用类型是否**需要**作用对象（缺了就不可执行）。
fn action_requires_target(action: &str) -> bool {
    action == SHORTCUT_ACTION_OPEN_PLUGIN
        || action == SHORTCUT_ACTION_QUICK_FILTER
        || action == SHORTCUT_ACTION_QUICK_OPEN
}
impl ShortcutBinding {
    /// 反序列化一条记录；字段缺失 / 作用类型未知时返回 None（跳过该条）。
    fn from_value(v: &serde_json::Value) -> Option<Self> {
        let shortcut = v.get("shortcut")?.as_str()?.trim().to_string();
        if shortcut.is_empty() {
            return None;
        }
        let action = v.get("action")?.as_str()?.trim().to_string();
        if !is_known_shortcut_action(&action) {
            return None;
        }
        let target = v
            .get("target")
            .and_then(|t| t.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        if action_requires_target(&action) && target.is_none() {
            // 缺少作用对象（插件 id / 常用头）的绑定无法执行，直接丢弃
            return None;
        }
        Some(Self {
            shortcut,
            action,
            target,
        })
    }

    /// 序列化为 JSON（写 settings.json 用）
    pub(crate) fn to_value(&self) -> serde_json::Value {
        serde_json::json!({
            "shortcut": self.shortcut,
            "action": self.action,
            "target": self.target,
        })
    }
}

/// 是否是已知的快捷键作用类型
fn is_known_shortcut_action(action: &str) -> bool {
    action == SHORTCUT_ACTION_TOGGLE_WINDOW
        || action == SHORTCUT_ACTION_OPEN_PLUGIN
        || action == SHORTCUT_ACTION_QUICK_FILTER
        || action == SHORTCUT_ACTION_QUICK_OPEN
        || action == SHORTCUT_ACTION_SCREENSHOT
        || action == SHORTCUT_ACTION_CLIPBOARD
}

/// 绑定列表长度上限（防止设置文件被写爆 / 注册过多全局热键）
const MAX_SHORTCUT_BINDINGS: usize = 50;

/// 严格解析前端提交的绑定列表：任何一条不合法都返回错误（**不静默丢条目**）。
///
/// 与宽容版 `parse_shortcut_bindings` 的区别：那个用于读历史文件（脏数据跳过），
/// 这个用于写入前校验（用户当前的设置不能被悄悄改掉）。
fn parse_shortcut_bindings_strict(value: &serde_json::Value) -> Result<Vec<ShortcutBinding>, String> {
    let arr = value
        .as_array()
        .ok_or_else(|| "快捷键设置格式错误（应为数组）".to_string())?;
    if arr.is_empty() {
        return Err("快捷键设置不能为空（至少保留一条「呼出 / 隐藏搜索框」）".into());
    }
    if arr.len() > MAX_SHORTCUT_BINDINGS {
        return Err(format!("快捷键数量不能超过 {MAX_SHORTCUT_BINDINGS} 条"));
    }

    let mut out: Vec<ShortcutBinding> = Vec::new();
    for (i, item) in arr.iter().enumerate() {
        let no = i + 1;
        let binding = ShortcutBinding::from_value(item).ok_or_else(|| {
            format!("第 {no} 条快捷键不完整（需要「快捷键 + 作用类型」，打开插件需选择插件，快速过滤 / 快捷打开项需填写文本）")
        })?;
        if out.iter().any(|b| b.shortcut == binding.shortcut) {
            return Err(format!("快捷键「{}」重复了，请换一个", binding.shortcut));
        }
        if binding.action == SHORTCUT_ACTION_TOGGLE_WINDOW
            && out.iter().any(|b| b.action == binding.action)
        {
            return Err("「呼出 / 隐藏搜索框」只能设置一条快捷键".into());
        }
        out.push(binding);
    }
    Ok(out)
}

/// 解析设置里存的「快捷键绑定数组」原文 → 绑定列表（未知项跳过，不报错）。
fn parse_shortcut_bindings(value: &serde_json::Value) -> Vec<ShortcutBinding> {
    let arr = match value.as_array() {
        Some(a) => a,
        None => return Vec::new(),
    };
    let mut out: Vec<ShortcutBinding> = Vec::new();
    for item in arr {
        let Some(binding) = ShortcutBinding::from_value(item) else {
            continue;
        };
        // 同一个组合键只保留第一条（后面重复的丢弃，避免注册时互相顶掉）
        if out.iter().any(|b| b.shortcut == binding.shortcut) {
            continue;
        }
        // 呼出/隐藏是必需能力：只允许一条，重复的丢弃
        if binding.action == SHORTCUT_ACTION_TOGGLE_WINDOW
            && out
                .iter()
                .any(|b| b.action == SHORTCUT_ACTION_TOGGLE_WINDOW)
        {
            continue;
        }
        out.push(binding);
    }
    out
}

/// 记录/清除「用户主动解绑截图热键」标记（见 `SETTINGS_KEY_SCREENSHOT_UNBOUND`）。
///
/// 由插件前台的「解绑」按钮与重新绑定走（`screenshot_set_shortcut`）。
/// 写失败只记日志：本次绑定已生效，重启后最坏是默认热键被补回来。
pub(crate) fn set_screenshot_unbound(app: &tauri::AppHandle, unbound: bool) {
    if let Some(store) = settings_store(app) {
        store.set(SETTINGS_KEY_SCREENSHOT_UNBOUND, serde_json::Value::Bool(unbound));
        if let Err(e) = store.save() {
            eprintln!("保存截图快捷键解绑标记失败: {e}");
        }
    }
}


///
/// **为什么需要这一步**：截图热键由宿主注册，而宿主只注册 settings.json 里
/// `shortcut_bindings` 列出的条目。老用户的列表里只有呼出/打开插件那几条，
/// 若只把默认键当「没绑定时返回的展示值」，插件前台会显示 Ctrl+Alt+X 而系统里
/// 根本没注册这个热键——按下去毫无反应（真实踩到过的故障）。
///
/// 自愈补齐后「显示的热键」与「已注册的热键」必然一致。三种情况不补：
///   - 已经有了（用户自己绑的，或上次已补过）；
///   - 用户**主动解绑**过（`screenshot_unbound` 标记，见插件前台「解绑」按钮）；
///   - 默认键已被列表里别的动作占用（改动过设置的极小概率）——宁可暂时没有
///     截图热键（插件前台显示「未设置」，用户可自行绑一个），也不能悄悄抢键。
fn ensure_screenshot_binding(bindings: &mut Vec<ShortcutBinding>, unbound: bool) {
    if unbound {
        return;
    }
    if bindings.iter().any(|b| b.action == SHORTCUT_ACTION_SCREENSHOT) {
        return;
    }
    if bindings
        .iter()
        .any(|b| b.shortcut == DEFAULT_SCREENSHOT_SHORTCUT)
    {
        return;
    }
    bindings.push(ShortcutBinding {
        shortcut: DEFAULT_SCREENSHOT_SHORTCUT.to_string(),
        action: SHORTCUT_ACTION_SCREENSHOT.to_string(),
        target: None,
    });
}

/// 记录/清除「用户主动解绑剪贴板历史热键」标记（与截图版同构）。
pub(crate) fn set_clipboard_unbound(app: &tauri::AppHandle, unbound: bool) {
    if let Some(store) = settings_store(app) {
        store.set(SETTINGS_KEY_CLIPBOARD_UNBOUND, serde_json::Value::Bool(unbound));
        if let Err(e) = store.save() {
            eprintln!("保存剪贴板历史快捷键解绑标记失败: {e}");
        }
    }
}

/// 自愈补齐缺失的「剪贴板历史」绑定（与 `ensure_screenshot_binding` 同构）。
///
/// 理由完全一致：剪贴板历史热键由宿主注册，只把默认键当「展示值」是不够的——
/// 老用户的 settings.json 里没有这一条，插件前台却会显示 Ctrl+Alt+V，按下去没反应。
/// 三种情况不补：已有、用户主动解绑过、默认键已被别的动作占用。
fn ensure_clipboard_binding(bindings: &mut Vec<ShortcutBinding>, unbound: bool) {
    if unbound {
        return;
    }
    if bindings.iter().any(|b| b.action == SHORTCUT_ACTION_CLIPBOARD) {
        return;
    }
    if bindings
        .iter()
        .any(|b| b.shortcut == DEFAULT_CLIPBOARD_SHORTCUT)
    {
        return;
    }
    bindings.push(ShortcutBinding {
        shortcut: DEFAULT_CLIPBOARD_SHORTCUT.to_string(),
        action: SHORTCUT_ACTION_CLIPBOARD.to_string(),
        target: None,
    });
}

/// 读「呼出/隐藏」快捷键（从绑定列表里找；列表里没有时回落到默认值）。
///
/// 兼容旧版：列表键不存在时读旧的单键 `toggle_shortcut`（用户升级后不丢配置）。
fn read_toggle_shortcut(app: &tauri::AppHandle) -> String {
    for b in read_shortcut_bindings(app) {
        if b.action == SHORTCUT_ACTION_TOGGLE_WINDOW {
            return b.shortcut;
        }
    }
    DEFAULT_TOGGLE_SHORTCUT.to_string()
}

/// 从 settings store 读取全部快捷键绑定。
///
/// 四种情况：
///   1. 存了绑定列表 → 原样解析，再补上缺失的截图绑定（见 `ensure_screenshot_binding`）；
///   2. 没存过绑定列表、但存过旧版单键 → 迁移成一条 toggle-window（只读，不写回）；
///   3. 什么都没存（首次运行）→ 一条默认的 toggle-window，再补截图绑定；
///   4. 存了列表但**少了截图绑定** → 补一条默认截图热键（用户主动解绑过则不补）。
///
/// 第 4 条为什么必需：截图热键是宿主的 `screenshot` 动作，动作要生效必须**真的
/// 注册到系统**。只把 `DEFAULT_SCREENSHOT_SHORTCUT` 当作「没绑定时返回的展示值」
/// 是不够的——老用户的 settings.json 里没有这一条，插件前台却会显示 Ctrl+Alt+X，
/// 用户按下去毫无反应（真实踩到过的故障）。
///
/// 补齐只作用于**返回值**（本函数是纯读）；下次任何一次 `apply_shortcut_bindings`
/// 落盘时自然写回，无需在此处额外写文件。
fn read_shortcut_bindings(app: &tauri::AppHandle) -> Vec<ShortcutBinding> {
    let Some(store) = settings_store(app) else {
        let mut bindings = vec![ShortcutBinding {
            shortcut: DEFAULT_TOGGLE_SHORTCUT.to_string(),
            action: SHORTCUT_ACTION_TOGGLE_WINDOW.to_string(),
            target: None,
        }];
        ensure_screenshot_binding(&mut bindings, false);
        ensure_clipboard_binding(&mut bindings, false);
        return bindings;
    };
    let unbound = store
        .get(SETTINGS_KEY_SCREENSHOT_UNBOUND)
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let clipboard_unbound = store
        .get(SETTINGS_KEY_CLIPBOARD_UNBOUND)
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if let Some(value) = store.get(SETTINGS_KEY_SHORTCUT_BINDINGS) {
        let mut bindings = parse_shortcut_bindings(&value);
        ensure_screenshot_binding(&mut bindings, unbound);
        ensure_clipboard_binding(&mut bindings, clipboard_unbound);
        return bindings;
    }
    // 旧版单键迁移：把「呼出/隐藏」变成一条绑定（同样补上截图/剪贴板绑定：
    // 迁移期的用户也该拿到可用的热键）
    let legacy = store
        .get(SETTINGS_KEY_TOGGLE_SHORTCUT)
        .and_then(|v| v.as_str().map(|s| s.trim().to_string()))
        .filter(|s| !s.is_empty());
    let mut bindings = vec![ShortcutBinding {
        shortcut: legacy.unwrap_or_else(|| DEFAULT_TOGGLE_SHORTCUT.to_string()),
        action: SHORTCUT_ACTION_TOGGLE_WINDOW.to_string(),
        target: None,
    }];
    ensure_screenshot_binding(&mut bindings, unbound);
    ensure_clipboard_binding(&mut bindings, clipboard_unbound);
    bindings
}

/// 写入绑定列表到 settings store（写失败只记日志：本次已生效，重启后回落旧值）。
fn write_shortcut_bindings(app: &tauri::AppHandle, bindings: &[ShortcutBinding]) {
    if let Some(store) = settings_store(app) {
        let arr: Vec<serde_json::Value> = bindings.iter().map(|b| b.to_value()).collect();
        store.set(SETTINGS_KEY_SHORTCUT_BINDINGS, serde_json::Value::Array(arr));
        if let Err(e) = store.save() {
            eprintln!("保存快捷键设置失败: {e}");
        }
    }
}

/// 把快捷键字符串（"ctrl+alt+s"）转为展示形式（"Ctrl+Alt+S"）。
/// 仅用于托盘 tooltip 等只读展示，逐段首字母大写即可。
fn shortcut_to_caps(shortcut: &str) -> String {
    shortcut
        .split('+')
        .filter(|s| !s.is_empty())
        .map(|token| {
            let mut chars = token.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join("+")
}

/// 尝试把一组绑定注册到系统（全部成功才算成功，否则回滚已注册的部分）。
///
/// 每个键的 handler 按「作用类型」分发：呼出/隐藏窗口、直接打开某个插件、
/// 呼出并填入常用头进入快速过滤，或按文本精确匹配并打开某项（快捷打开项）。
fn register_binding_handlers(app: &tauri::AppHandle, bindings: &[ShortcutBinding]) -> Result<(), String> {
    let gs = app.global_shortcut();
    let mut registered: Vec<ShortcutBinding> = Vec::new();

    for binding in bindings {
        let shortcut = binding.shortcut.as_str();
        // 插件 API 只接受 &str（TryFrom<&str>），先在这里校验字符串可解析
        if let Err(e) = tauri_plugin_global_shortcut::Shortcut::try_from(shortcut) {
            rollback_registered(app, &registered);
            return Err(format!("无法识别的快捷键「{shortcut}」: {e}"));
        }
        // 同一条快捷键重复出现（理论上调用方已去重）：跳过，避免注册冲突
        if registered.iter().any(|b| b.shortcut == binding.shortcut) {
            continue;
        }

        let action = binding.action.clone();
        let target = binding.target.clone();
        let result = gs.on_shortcut(shortcut, move |app, _s, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            if action == SHORTCUT_ACTION_OPEN_PLUGIN {
                if let Some(plugin_id) = target.as_deref() {
                    open_plugin_by_shortcut(app, plugin_id);
                }
            } else if action == SHORTCUT_ACTION_QUICK_FILTER {
                if let Some(filter) = target.as_deref() {
                    quick_filter_by_shortcut(app, filter);
                }
            } else if action == SHORTCUT_ACTION_QUICK_OPEN {
                if let Some(text) = target.as_deref() {
                    quick_open_by_shortcut(app, text);
                }
            } else if action == SHORTCUT_ACTION_SCREENSHOT {
                // 截图是唯一在 Rust 里就地完成的动作：遮罩必须是独立全屏窗口，
                // 而插件详情视图（inlay）开不了窗口。内部自己 spawn，不阻塞事件循环。
                screenshot::start_overlay_from_shortcut(app);
            } else if action == SHORTCUT_ACTION_CLIPBOARD {
                // 剪贴板历史**走前端**（inlay 详情视图能开在主 WebView 里）：
                // 这里只把主窗口带到前台并广播事件，由前端打开内置插件详情视图。
                clipboard_by_shortcut(app);
            } else {
                toggle_window(app);
            }
        });
        match result {
            Ok(()) => registered.push(binding.clone()),
            Err(e) => {
                rollback_registered(app, &registered);
                return Err(format!(
                    "快捷键「{}」注册失败（可能已被其它程序占用）: {e}",
                    binding.shortcut
                ));
            }
        }
    }
    Ok(())
}

/// 撤销一组已注册的快捷键（注册失败回滚用；失败只记日志，不中断后续清理）。
fn rollback_registered(app: &tauri::AppHandle, bindings: &[ShortcutBinding]) {
    let gs = app.global_shortcut();
    for b in bindings {
        if let Err(e) = gs.unregister(b.shortcut.as_str()) {
            eprintln!("回滚快捷键「{}」失败: {e}", b.shortcut);
        }
    }
}

/// 注册（或重新注册）整套快捷键绑定。
///
/// - 先 unregister 当前已注册的全部键；
/// - 再逐条注册新键（呼出/隐藏、打开插件……）；
/// - 任一条注册失败时**回滚**：优先整体恢复旧绑定
///   （保证「改动失败 = 一切保持原样」），旧绑定也恢复不了时兜底只注册默认呼出键，
///   保证呼出功能始终可用。
fn register_shortcut_bindings(app: &tauri::AppHandle, bindings: &[ShortcutBinding]) -> Result<(), String> {
    let state = app.state::<ActiveShortcutState>();

    // 先 unregister 旧键（记录下来，注册失败时用于回滚）
    let old = match state.0.lock() {
        Ok(mut guard) => std::mem::take(&mut *guard),
        Err(_) => Vec::new(),
    };
    rollback_registered(app, &old);

    match register_binding_handlers(app, bindings) {
        Ok(()) => {
            if let Ok(mut guard) = state.0.lock() {
                *guard = bindings.to_vec();
            }
            Ok(())
        }
        Err(e) => {
            // 回滚：优先恢复旧绑定；旧绑定恢复不了再兜底只注册默认呼出键
            let mut restored = register_binding_handlers(app, &old).is_ok();
            let mut applied = old.clone();
            if !restored {
                let fallback = vec![ShortcutBinding {
                    shortcut: DEFAULT_TOGGLE_SHORTCUT.to_string(),
                    action: SHORTCUT_ACTION_TOGGLE_WINDOW.to_string(),
                    target: None,
                }];
                restored = register_binding_handlers(app, &fallback).is_ok();
                applied = if restored { fallback } else { Vec::new() };
            }
            if let Ok(mut guard) = state.0.lock() {
                *guard = applied;
            }
            Err(e)
        }
    }
}

// ===================== HTTP 代理（多级回退） =====================
/// 构建 HTTP 客户端。**跟随系统代理**（见 `system_proxy` 模块）：每次构建时
/// 现场读系统代理，系统开代理则走代理、关代理则直连，无需重启应用。
pub(crate) fn build_client(timeout_secs: u64, ua: &str) -> Result<reqwest::Client, String> {
    let builder = reqwest::Client::builder()
        .user_agent(ua)
        .timeout(std::time::Duration::from_secs(timeout_secs));
    crate::system_proxy::apply_system_proxy(builder)
        .build()
        .map_err(|e| e.to_string())
}

pub(crate) const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 MySearchDesktop/7.9.12";

/// 供插件网关复用的通用请求实现（插件已在前端与网关双重校验过目标地址）。
/// 与 `http_request` 的差别：不默认塞 GitHub 的 Accept 头，其余行为一致。
pub(crate) async fn http_request_for_plugin(
    method: String,
    url: String,
    headers: std::collections::HashMap<String, String>,
    body: Option<String>,
) -> Result<String, String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("仅支持 http/https 地址".into());
    }
    let client = build_client(30, UA)?;
    let parsed_method = reqwest::Method::from_bytes(method.to_uppercase().as_bytes())
        .map_err(|e| format!("非法请求方法: {e}"))?;
    let mut req = client.request(parsed_method, &url);
    for (k, v) in headers {
        req = req.header(k, v);
    }
    if let Some(b) = body {
        req = req.body(b);
    }
    let resp = req.send().await.map_err(|e| format!("请求失败: {e}"))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {e}"))?;
    if status.is_success() {
        Ok(text)
    } else {
        let snippet: String = text.chars().take(400).collect();
        Err(format!("HTTP {}: {}", status.as_u16(), snippet))
    }
}

/// HTTP GET 代理：供前端拉取订阅内容（绕开 CORS）
///
/// 回退顺序（CDN 优先）：
///   1. raw.githubusercontent.com → jsDelivr CDN（国内可访问，8s 超时）
///   2. 原始地址直连（2.5s 短超时，快速失败兜底）
///   3. raw.githubusercontent.com → GitHub API（前两级都失败时）
///
/// 为什么 jsDelivr 在前：raw.githubusercontent.com 在国内经常被墙/丢包，
/// 「先直连再回退」会让每个订阅都要先吃一次超时（或 TCP 重传）才开始真正加载，
/// 数十个内容源叠加后表现为整体加载缓慢。jsDelivr 是全球 CDN、国内可达且快，
/// 直连仅作为 jsDelivr 未覆盖或 CDN 故障时的兜底。
#[tauri::command]
async fn http_get(url: String) -> Result<String, String> {
    let mut errors: Vec<String> = Vec::new();
    let is_raw_github = url.contains("raw.githubusercontent.com/");

    // 1. jsDelivr CDN（8s 超时）——仅对 raw.githubusercontent.com 地址可用
    if is_raw_github {
        if let Some(cdn_url) = convert_raw_to_jsdelivr(&url) {
            if let Ok(client) = build_client(8, UA) {
                match client.get(&cdn_url).send().await {
                    Ok(resp) if resp.status().is_success() => {
                        if let Ok(text) = resp.text().await {
                            if !text.is_empty() {
                                return Ok(text);
                            }
                        }
                    }
                    Ok(resp) => errors.push(format!("jsDelivr HTTP {}", resp.status())),
                    Err(e) => errors.push(format!("jsDelivr 失败: {e}")),
                }
            }
        }
    }

    // 2. 原始地址直连（2.5s 短超时，快速失败）
    match build_client(3, UA) {
        Ok(client) => match client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(text) = resp.text().await {
                    if !text.is_empty() {
                        return Ok(text);
                    }
                }
            }
            Ok(resp) => errors.push(format!("直连 HTTP {}", resp.status())),
            Err(e) => errors.push(format!("直连失败: {e}")),
        },
        Err(e) => errors.push(e),
    }

    // 3. GitHub API（base64 解码）
    if is_raw_github {
        if let Some(api_url) = convert_raw_to_api(&url) {
            if let Ok(client) = build_client(15, UA) {
                match client
                    .get(&api_url)
                    .header("Accept", "application/vnd.github+json")
                    .send()
                    .await
                {
                    Ok(resp) if resp.status().is_success() => match resp.json::<serde_json::Value>().await {
                        Ok(json) => {
                            if let Some(content) = json["content"].as_str() {
                                let cleaned: String =
                                    content.chars().filter(|c| !c.is_whitespace()).collect();
                                use base64::Engine;
                                match base64::engine::general_purpose::STANDARD.decode(cleaned) {
                                    Ok(bytes) => match String::from_utf8(bytes) {
                                        Ok(text) if !text.is_empty() => return Ok(text),
                                        Ok(_) => errors.push("GitHub API 内容为空".into()),
                                        Err(e) => errors.push(format!("UTF-8 解码失败: {e}")),
                                    },
                                    Err(e) => errors.push(format!("base64 解码失败: {e}")),
                                }
                            } else {
                                errors.push("GitHub API 无 content 字段".into());
                            }
                        }
                        Err(e) => errors.push(format!("GitHub API 解析失败: {e}")),
                    },
                    Ok(resp) => errors.push(format!("GitHub API HTTP {}", resp.status())),
                    Err(e) => errors.push(format!("GitHub API 失败: {e}")),
                }
            }
        }
    }

    Err(format!("请求失败（{}）", errors.join("；")))
}

/// 通用 HTTP 请求代理：供前端访问 GitHub API（TisHub 订阅市场）
///
/// - 绕开 WebView 的 CORS 限制
/// - 支持自定义请求头（如 `Authorization: Bearer <token>`）
/// - 支持请求体（JSON 字符串）
/// - 非 2xx 时返回带状态码与响应片段的可读错误
#[tauri::command]
async fn http_request(
    method: String,
    url: String,
    headers: Option<std::collections::HashMap<String, String>>,
    body: Option<String>,
) -> Result<String, String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("仅支持 http/https 地址".into());
    }

    let client = build_client(20, UA)?;
    let parsed_method = reqwest::Method::from_bytes(method.to_uppercase().as_bytes())
        .map_err(|e| format!("非法请求方法: {e}"))?;

    let mut req = client
        .request(parsed_method, &url)
        .header("Accept", "application/vnd.github+json");

    if let Some(h) = headers {
        for (k, v) in h {
            if k.eq_ignore_ascii_case("accept") {
                continue;
            }
            req = req.header(k, v);
        }
    }

    if let Some(b) = body {
        req = req
            .header("Content-Type", "application/json")
            .body(b);
    }

    let resp = req.send().await.map_err(|e| format!("请求失败: {e}"))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {e}"))?;

    if status.is_success() {
        Ok(text)
    } else {
        let snippet: String = text.chars().take(400).collect();
        Err(format!("HTTP {}: {}", status.as_u16(), snippet))
    }
}

/// 解析 raw.githubusercontent.com URL 为 (owner, repo, ref, path)。
///
/// 支持两种常见写法：
///   - `https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path...}`
///   - `https://raw.githubusercontent.com/{owner}/{repo}/refs/{heads|tags}/{ref}/{path...}`
///
/// `{path...}` 至少要有一段（URL 指向仓库里的文件）。缺少文件名
/// （如 `owner/repo/branch`、`owner/repo/refs/heads/branch`）时返回 None，
/// 让上层明确地「回退失败」，而不是拼出 `@refs/heads/branch` 这类非法 URL。
fn parse_raw_github_url(url: &str) -> Option<(&str, &str, &str, String)> {
    let rest = url.strip_prefix("https://raw.githubusercontent.com/")?;
    let parts: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() < 4 {
        return None;
    }
    let (owner, repo) = (parts[0], parts[1]);
    let (branch, path_start) = if parts[2] == "refs" {
        // refs/{heads|tags}/{ref}/{path} 至少 6 段
        if parts.len() < 6 || !matches!(parts[3], "heads" | "tags") {
            return None;
        }
        (parts[4], 5)
    } else {
        // {branch}/{path} 至少 4 段
        (parts[2], 3)
    };
    Some((owner, repo, branch, parts[path_start..].join("/")))
}

/// 将 raw.githubusercontent.com URL 转换为 jsDelivr CDN URL
fn convert_raw_to_jsdelivr(url: &str) -> Option<String> {
    let (owner, repo, branch, path) = parse_raw_github_url(url)?;
    Some(format!("https://cdn.jsdelivr.net/gh/{owner}/{repo}@{branch}/{path}"))
}

/// 将 raw.githubusercontent.com URL 转换为 GitHub API URL
fn convert_raw_to_api(url: &str) -> Option<String> {
    let (owner, repo, branch, path) = parse_raw_github_url(url)?;
    Some(format!(
        "https://api.github.com/repos/{owner}/{repo}/contents/{path}?ref={branch}"
    ))
}

// ===================== 窗口尺寸 =====================
/// 窗口宽度（还原油猴版 `#my_search_box` 的媒体查询分档，见 `我的搜索-7.9.5.js`）：
/// 原脚本用 `position: fixed` + `left/right` 等值百分比让搜索框居中，
/// 并按视口宽度分档取屏幕占比——`>1400px` 取 52%、`>1200px` 取 60%、
/// `>800px` 取 70%、更窄取 80%。桌面版窗口即视口，故以所在显示器宽度作为
/// 分档依据，直接算出目标宽度（不再是固定像素）。
/// 额外用屏幕宽度的 90% 兜底（原脚本无此限制，桌面版避免超宽屏/多显示器下过宽）。
const MIN_WINDOW_WIDTH: f64 = 320.0;
const MAX_SCREEN_WIDTH_RATIO: f64 = 0.9;

/// 原脚本媒体查询分档：屏幕宽度 → 搜索框占屏幕宽度的比例
fn box_width_ratio(screen_w: f64) -> f64 {
    if screen_w > 1400.0 {
        0.52
    } else if screen_w > 1200.0 {
        0.60
    } else if screen_w > 800.0 {
        0.70
    } else {
        0.80
    }
}

/// 计算主窗口目标宽度（逻辑像素）：按原脚本分档取屏幕占比，
/// 并限制在 [320px, 屏幕宽度 90%] 内。
///
/// `monitor`：由调用方选定并显式传入，与本函数配套的居中定位共用同一块屏幕，
/// 避免多显示器下「按 A 屏定宽、却按 B 屏居中」。
/// 注意 `monitor.size()` 是物理像素，而窗口用 `LogicalSize` 设置，
/// 高 DPI（如 150% 缩放）下必须换算成逻辑宽度，否则分档与 90% 限制都会失真。
fn target_window_width(monitor: &tauri::Monitor) -> f64 {
    let scale = monitor.scale_factor();
    let screen_w = monitor.size().width as f64 / if scale > 0.0 { scale } else { 1.0 };
    let target = screen_w * box_width_ratio(screen_w);
    let max = (screen_w * MAX_SCREEN_WIDTH_RATIO).max(MIN_WINDOW_WIDTH);
    target.clamp(MIN_WINDOW_WIDTH, max)
}

/// 按窗口当前所在屏幕计算目标宽度（不重新定位时使用）
fn window_width_for(window: &tauri::WebviewWindow) -> f64 {
    window
        .current_monitor()
        .unwrap_or(None)
        .map(|m| target_window_width(&m))
        .unwrap_or(MIN_WINDOW_WIDTH)
}

/// 调整主窗口尺寸（前端根据结果数量动态展开/收起，高度可变、宽度按屏幕分档）
#[tauri::command]
fn set_window_height(app: tauri::AppHandle, height: f64) {
    if let Some(window) = app.get_webview_window("main") {
        let width = window_width_for(&window);
        let _ = window.set_size(tauri::LogicalSize::new(width, height));
    }
}

/// 获取当前显示器下的屏幕分档宽度（逻辑像素），供前端过渡动画计算目标宽度。
#[tauri::command]
fn get_default_window_width(app: tauri::AppHandle) -> f64 {
    if let Some(window) = app.get_webview_window("main") {
        window_width_for(&window)
    } else {
        MIN_WINDOW_WIDTH
    }
}

/// 当前生效的窗口尺寸动画令牌（0 = 无动画）。
///
/// 每次 `animate_window_size` 递增它并把新值交给自己的线程；线程每帧比对
/// 「自己的令牌 == 全局当前令牌」，不等则说明已有更新的动画抢占了它，线程立即
/// 退出（不碰窗口），从而避免多个动画同时改尺寸互相打架。语义与前端
/// `cancelWindowResizeAnimation` 对齐：新动画天然取消旧动画。
static WINDOW_ANIM_TOKEN: AtomicU64 = AtomicU64::new(0);
/// 递增该令牌即可取消当前动画（前端 cancelWindowResizeAnimation 调用）。
#[tauri::command]
fn cancel_window_resize_animation() {
    WINDOW_ANIM_TOKEN.fetch_add(1, Ordering::SeqCst);
}

/// 以动画方式把主窗口从 (w0,h0) 过渡到 (w1,h1)，时长 duration_ms。
///
/// ## 为什么放在 Rust 而不是前端 rAF
///
/// 早期前端实现每帧 fire-and-forget 调 `getCurrentWindow().setSize()`：60fps 的
/// 跨进程 IPC（JS→wry→tao→Win32）不等返回就连发，原生端缩放指令堆积，表现为
/// 明显卡顿。这里把逐帧循环搬到**原生线程**：前端只发一次 IPC，此后由 Rust 按帧
/// 直接 `set_size`，无往返、无堆积。
///
/// ## 为什么能「严格内容跟随」
///
/// 每帧改的是**窗口**尺寸，内容（`#my_search_box` 等）靠 CSS `height:100%` 解析
/// WebView 视口自然铺满——窗口与内容同帧变化，不会出现「窗口先放大、内容再放大」
/// 的二次观感（那正是「窗口一次性到位 + 内容 transform 补间」方案的问题）。
///
/// 令牌机制见 `WINDOW_ANIM_TOKEN`：新动画抢占旧动画。
#[tauri::command]
fn animate_window_size(
    app: tauri::AppHandle,
    from_width: f64,
    from_height: f64,
    to_width: f64,
    to_height: f64,
    duration_ms: f64,
) {
    // 目标非法直接忽略（与前端守卫一致）
    if !to_width.is_finite() || !to_height.is_finite() || to_width <= 0.0 || to_height <= 0.0 {
        return;
    }
    // 领取新令牌：旧动画线程会在下一帧发现令牌不匹配而自行退出
    let token = WINDOW_ANIM_TOKEN.fetch_add(1, Ordering::SeqCst) + 1;
    let start_w = if from_width.is_finite() && from_width > 0.0 {
        from_width
    } else {
        to_width
    };
    let start_h = if from_height.is_finite() && from_height > 0.0 {
        from_height
    } else {
        to_height
    };
    let duration = duration_ms.max(1.0);
    std::thread::spawn(move || {
        let step = std::time::Duration::from_millis(16);
        let begin = std::time::Instant::now();
        loop {
            // 被更新的动画抢占 → 立即退出，不再碰窗口
            if WINDOW_ANIM_TOKEN.load(Ordering::SeqCst) != token {
                return;
            }
            let Some(window) = app.get_webview_window("main") else {
                return;
            };
            let elapsed = begin.elapsed().as_secs_f64() * 1000.0;
            let t = (elapsed / duration).min(1.0);
            // ease-out cubic：快起慢收，与前端既有体感一致
            let ease = 1.0 - (1.0 - t).powi(3);
            let w = start_w + (to_width - start_w) * ease;
            let h = start_h + (to_height - start_h) * ease;
            let _ = window.set_size(tauri::LogicalSize::new(w, h));
            if t >= 1.0 {
                return;
            }
            std::thread::sleep(step);
        }
    });
}

/// 把主窗口收回到搜索框高度（隐藏时调用，避免下次呼出残留上次的高窗口）
fn collapse_main_window(window: &tauri::WebviewWindow) {
    let width = window_width_for(window);
    let _ = window.set_size(tauri::LogicalSize::new(width, COLLAPSED_WINDOW_HEIGHT));
}

/// 把主窗口位置复位到常态（水平居中 + 顶部约屏高 22%），并把宽度复位成屏幕分档。
///
/// 用途：退出**插件视图**时调用。插件页允许用户拖拽改窗口大小并会按自己的
/// 规则把窗口移到自定义位置（见前端 App.vue 的 applyPluginWindowSize），退出后
/// 必须回到普通搜索窗的位置——否则窗口会停在插件页那次居中/拖拽留下的位置。
///
/// 为什么放在 Rust 而不是前端复刻公式：常态定位口径（含多显示器 origin 偏移、
/// 高 DPI 缩放换算、y = min(屏高×0.22, 屏高−窗高)）已经在 `position_window_top_center`
/// 里实现且被 `show_main_window` 使用；复用它能保证「退出插件」与「呼出窗口」
/// 落点完全一致。前端 centeredPosition 的 y 用的是「剩余空间×0.22」，两者不同，
/// 不能互相替代。
///
/// 只改宽度与位置，**不改高度**——高度仍由前端随后按内容下发（保持既有节奏）。
/// y 的计算需要当前窗口高度参与（min 的那一项），这里先用当前实际高度参与定位，
/// 前端紧接着的 set_window_height 只改尺寸不改位置，最终落点即为常态位置。
#[tauri::command]
fn reset_main_window_position(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let logical_width = window_width_for(&window);
        // 用当前实际高度参与居中（只影响 y 的 min 分支，退出瞬间高度通常已由前端
        // 定好；即便略有偏差也只是几像素，下一次 set_window_height 不再动位置）。
        let scale = window.scale_factor().unwrap_or(1.0);
        let scale = if scale > 0.0 { scale } else { 1.0 };
        let logical_height = window
            .outer_size()
            .map(|s| s.height as f64 / scale)
            .unwrap_or(COLLAPSED_WINDOW_HEIGHT);
        let _ = window.set_size(tauri::LogicalSize::new(logical_width, logical_height));
        if let Some(monitor) = target_monitor(&window) {
            position_window_top_center(&window, &monitor, logical_width);
        } else {
            // 取不到显示器时退回系统居中（与 show_main_window 的兜底一致）
            let _ = window.center();
        }
    }
}


// ===================== 命令 =====================
/// 打开外部链接（默认浏览器）
#[tauri::command]
async fn open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 应用退出
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// 打开独立设置窗口
///
/// 桌面版的设置是独立窗口，而主窗口是置顶悬浮窗（alwaysOnTop），
/// 若不先收起，主窗口会盖在设置窗口上（油猴版是同一页面内的面板，不存在此问题）。
/// 所以打开设置前先把主窗口收起，观感与旧版「失焦即隐藏」一致。
///
/// **必须是 async 命令**：Tauri 官方文档（WebviewWindowBuilder 的 Known issues）明确说明：
/// 在 Windows 上，同步命令中创建 webview 窗口会发生**死锁**（WebView2 已知问题，wry#583）。
/// 同步命令运行在事件循环线程上，而 `builder.build()` 创建 WebView2 需要事件循环
/// 继续运转来派发窗口创建/导航消息，两者互相等待 → 窗口停留在 about:blank、
/// 永不导航、页面永久空白且 Esc 无法关闭（用户反馈的「设置页空白卡死」）。
/// 改成 async 后命令体在异步运行时线程执行，事件循环保持自由，窗口正常创建。
#[tauri::command]
async fn open_config_window(app: tauri::AppHandle) {
    use tauri::window::Color;
    use tauri::WebviewWindowBuilder;

    if let Some(main) = app.get_webview_window("main") {
        if main.is_visible().unwrap_or(false) {
            collapse_main_window(&main);
            let _ = main.hide();
        }
    }

    let (pref, is_dark) = current_theme(&app);
    let native = native_theme(pref);

    if let Some(win) = app.get_webview_window("config") {
        // 先设置原生主题与底色再 show：WebView2 的 prefers-color-scheme 跟随窗口主题，
        // 如果 show 后再 set_theme，页面内联脚本读到的 matchMedia 值与实际不匹配，
        // 导致 initTheme 时发生 class 切换 + 事件派发 = 频闪。
        // （system 档 native=None：跟随系统，与页面内联脚本读到的 matchMedia 同源）
        let _ = win.set_theme(native);
        let _ = win.set_background_color(Some(if is_dark {
            Color(23, 25, 29, 255) // #17191d —— 与深色主题 --surface 一致
        } else {
            Color(245, 246, 248, 255) // #f5f6f8 —— 与浅色主题 --surface 一致
        }));
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }

    // 按当前主题给 WebView 铺一层同色底：页面首帧渲染前（HTML/JS 尚未执行）
    // 露出的是 WebView 自身的背景色，默认是白色，会在深色下造成「先白一下
    // 再变深色」的闪白。取自前端上报值 / 落盘偏好 / 系统兜底（见 current_theme）。
    let background = if is_dark {
        Color(23, 25, 29, 255) // #17191d —— 与深色主题 --surface 一致
    } else {
        Color(245, 246, 248, 255) // #f5f6f8 —— 与浅色主题 --surface 一致
    };

    let config_url = tauri::WebviewUrl::App("config.html".into());
    // 注意：不要为配置窗口设置自定义 data_directory。
    // Tauri 默认以 app identifier 作为 WebView 数据目录，两个窗口共享同一份
    // localStorage（Windows/macOS 会自动同步），订阅列表才能互通。
    //
    // .disable_drag_drop_handler()：在 Windows 上必须禁用 Tauri 的原生文件拖放
    // 处理器，否则它会拦截「订阅总览」条块的 HTML5 拖拽（dragstart/drop 等），
    // 导致用户无法通过鼠标拖拽调整订阅顺序。
    // 详见 Tauri 文档 dragDropEnabled：Disabling it is required to use
    // HTML5 drag and drop on the frontend on Windows.
    //
    // 不设 .visible(true)：先 build 并在 show 前设好 set_theme，确保页面内联脚本
    // 读到与 background_color 一致的 prefers-color-scheme，避免首帧类不匹配。
    let win = WebviewWindowBuilder::new(&app, "config", config_url)
        .disable_drag_drop_handler()
        .title("我的搜索 - 设置")
        // 设置窗口：横向布局（左菜单 + 右内容），宽度明显大于高度
        .inner_size(880.0, 600.0)
        .min_inner_size(600.0, 420.0)
        .resizable(true)
        .center()
        .decorations(true)
        .background_color(background)
        .build();
    let win = match win {
        Ok(win) => win,
        Err(e) => {
            eprintln!("创建配置窗口失败: {e}");
            return;
        }
    };
    // 在显示窗口前设置原生主题：使 WebView2 的 prefers-color-scheme 与 background
    // 从一开始就一致，页面内联脚本不会读到错误的值。
    let _ = win.set_theme(native);
    let _ = win.show();
    let _ = win.set_focus();
}

// ===================== 版本更新 =====================

/// 版本更新信息
#[derive(serde::Serialize, serde::Deserialize)]
struct UpdateInfo {
    /// 是否有新版本
    has_update: bool,
    /// 最新版本号（无更新时为空）
    latest_version: String,
    /// 当前版本号
    current_version: String,
    /// 下载地址（无更新时为空）
    download_url: String,
    /// 发布页地址
    release_url: String,
}

/// 下载进度（实时推送到前端）
#[derive(serde::Serialize, Clone)]
struct DownloadProgress {
    /// 已下载字节
    downloaded: u64,
    /// 总字节（0 表示未知）
    total: u64,
    /// 百分比（0-100，总字节未知时为 0）
    percent: u8,
    /// 状态：downloading / done / error
    status: String,
    /// 错误信息（status=error 时）
    error: Option<String>,
}

/// 检查 GitHub Releases 是否有新版本。
///
/// 调用 GitHub API `GET /repos/{owner}/{repo}/releases/latest`，
/// 解析最新 tag 与当前版本比较，并匹配当前平台的下载资产。
#[tauri::command]
async fn check_update() -> Result<UpdateInfo, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let owner = "My-Search";
    let repo = "my-search-desktop";
    let api_url = format!("https://api.github.com/repos/{owner}/{repo}/releases/latest");

    let client = build_client(10, UA)?;
    let resp = client
        .get(&api_url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("请求 GitHub API 失败: {e}"))?;

    if !resp.status().is_success() {
        // API 限流 / 无 Release 时静默返回无更新
        return Ok(UpdateInfo {
            has_update: false,
            latest_version: String::new(),
            current_version: current.clone(),
            download_url: String::new(),
            release_url: String::new(),
        });
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析响应 JSON 失败: {e}"))?;

    let tag_name = json["tag_name"].as_str().unwrap_or("").trim_start_matches('v');
    let release_url = json["html_url"].as_str().unwrap_or("").to_string();

    // 比较版本号（去掉前置 v）
    let latest = tag_name.to_string();
    let has_update = compare_versions(&latest, &current) > 0;

    if !has_update {
        return Ok(UpdateInfo {
            has_update: false,
            latest_version: latest,
            current_version: current,
            download_url: String::new(),
            release_url,
        });
    }

    // 匹配当前平台的下载资产
    let target_ext = if cfg!(target_os = "windows") {
        ".msi"
    } else if cfg!(target_os = "macos") {
        ".dmg"
    } else {
        ".AppImage"
    };

    let download_url = json["assets"]
        .as_array()
        .and_then(|assets| {
            assets.iter().find_map(|asset| {
                let name = asset["name"].as_str()?;
                if name.ends_with(target_ext) {
                    asset["browser_download_url"].as_str().map(|s| s.to_string())
                } else {
                    None
                }
            })
        })
        .unwrap_or_default();

    Ok(UpdateInfo {
        has_update: true,
        latest_version: latest,
        current_version: current,
        download_url,
        release_url,
    })
}

/// 语义化版本比较：a > b 返回正数，a == b 返回 0，a < b 返回负数。
/// 支持 `x.y.z` / `vx.y.z` / `x.y.z-beta` 等常见格式。
fn compare_versions(a: &str, b: &str) -> i32 {
    fn parse_segments(v: &str) -> Vec<i32> {
        v.trim_start_matches('v')
            .split(&['.', '-', '+', '_'][..])
            .filter_map(|s| s.parse::<i32>().ok())
            .collect()
    }
    let sa = parse_segments(a);
    let sb = parse_segments(b);
    for i in 0..sa.len().max(sb.len()) {
        let va = sa.get(i).copied().unwrap_or(0);
        let vb = sb.get(i).copied().unwrap_or(0);
        if va != vb {
            return va - vb;
        }
    }
    0
}

/// 下载更新文件到系统临时目录，并通过事件实时推送进度。
///
/// 下载完成后自动用系统默认程序打开安装文件（由用户确认安装）。
#[tauri::command]
async fn start_update_download(
    app: tauri::AppHandle,
    download_url: String,
) -> Result<(), String> {
    if download_url.is_empty() {
        return Err("下载地址为空".into());
    }

    // 从 URL 中提取文件名，并做安全处理：
    // - 过滤掉路径穿越段（..）
    // - 仅保留安全的 basename，丢弃路径前缀
    let raw_name = download_url.split('/').last().unwrap_or("update.msi");
    let safe_name = raw_name
        .split(['/', '\\'])
        .filter(|s| *s != ".." && *s != ".")
        .last()
        .unwrap_or("update.msi");
    let file_name = if safe_name.is_empty() { "update.msi" } else { safe_name };
    let temp_dir = std::env::temp_dir();
    let dest_path = temp_dir.join(file_name);

    let client = build_client(300, UA)?;
    let resp = client
        .get(&download_url)
        .send()
        .await
        .map_err(|e| format!("下载请求失败: {e}"))?;

    // 必须检查 HTTP 状态码：404/5xx 时 body 是错误页面 HTML，
    // 不能把它当作安装文件保存（否则 open_installer 会打开一个 HTML）。
    if !resp.status().is_success() {
        return Err(format!("下载失败（HTTP {}）", resp.status().as_u16()));
    }

    // 文件大小上限：500 MB（防止无 Content-Length 的分块传输耗尽磁盘）
    const MAX_DOWNLOAD_BYTES: u64 = 500 * 1024 * 1024;
    if let Some(cl) = resp.content_length() {
        if cl > MAX_DOWNLOAD_BYTES {
            return Err(format!("安装文件过大（{} 字节），超过 500 MB 上限", cl));
        }
    }

    let total = resp.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;

    // 使用 futures-util 做流式下载
    use futures_util::StreamExt;

    let stream = resp.bytes_stream();
    let mut file = tokio::fs::File::create(&dest_path)
        .await
        .map_err(|e| format!("创建临时文件失败: {e}"))?;

    // 推送进度更新
    fn emit_progress(
        app: &tauri::AppHandle,
        downloaded: u64,
        total: u64,
        status: &str,
        error: Option<String>,
    ) {
        let percent = if total > 0 {
            ((downloaded as f64 / total as f64) * 100.0) as u8
        } else {
            0
        };
        let _ = app.emit(
            "update://progress",
            DownloadProgress {
                downloaded,
                total,
                percent,
                status: status.to_string(),
                error,
            },
        );
    }

    tokio::pin!(stream);
    while let Some(chunk) = stream.next().await {
        let data = chunk.map_err(|e| format!("下载数据流错误: {e}"))?;
        downloaded += data.len() as u64;
        // 流式下载期间也检查文件大小上限（无 Content-Length 时尤其重要）
        if downloaded > MAX_DOWNLOAD_BYTES {
            return Err("下载文件超过 500 MB 上限，已中止".into());
        }
        use tokio::io::AsyncWriteExt;
        file.write_all(&data)
            .await
            .map_err(|e| format!("写入文件失败: {e}"))?;
        emit_progress(&app, downloaded, total, "downloading", None);
    }

    // 下载完成
    emit_progress(&app, downloaded, total, "done", None);

    // 通知前端下载完成并携带本地文件路径（由前端控制何时打开安装程序）
    let dest_str = dest_path.to_string_lossy().to_string();

    // 保存安装文件路径供 open_installer 使用
    // 中毒时取内部值（Mutex 只存 Option<String>，无复杂不变式）
    let state = app.state::<DownloadedInstallerPath>();
    let mut guard = match state.0.lock() {
        Ok(g) => g,
        Err(e) => e.into_inner(),
    };
    guard.replace(dest_str.clone());

    let _ = app.emit(
        "update://complete",
        serde_json::json!({ "path": dest_str }),
    );

    Ok(())
}

/// 打开已下载好的安装文件（由用户在界面点击「安装更新」时调用）。
/// 会先校验文件是否存在，若不存在则返回错误信息。
#[tauri::command]
fn open_installer(app: tauri::AppHandle) -> Result<(), String> {
    let path = {
        let state = app.state::<DownloadedInstallerPath>();
        let guard = match state.0.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        guard.clone()
    }
    .ok_or_else(|| "尚未下载安装文件".to_string())?;

    if !std::path::Path::new(&path).exists() {
        return Err("安装文件已丢失，请重新下载".to_string());
    }

    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| format!("打开安装文件失败: {e}"))?;

    Ok(())
}

/// 获取「开机自启动」当前状态（供「设置 → 常规设置」展示）
#[tauri::command]
fn get_autostart_enabled(app: tauri::AppHandle) -> Result<bool, String> {
    is_autostart_enabled(&app)
}

/// 设置「开机自启动」并立即生效（Windows 上写 HKCU Run 启动项）
#[tauri::command]
fn set_autostart_enabled_cmd(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    set_autostart_enabled(&app, enabled)?;
    write_autostart_pref(&app, enabled);
    Ok(())
}

/// 获取「Alt+点击文件快速带入」开关（供「设置 → 常规设置」展示）
#[tauri::command]
fn get_alt_click_enabled() -> bool {
    alt_click::is_enabled()
}

/// 设置「Alt+点击文件快速带入」并立即生效（钩子常驻，内存置位即切换，
/// 无需重装钩子；偏好落盘供下次启动读取）
#[tauri::command]
fn set_alt_click_enabled_cmd(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    alt_click::set_enabled(enabled);
    write_alt_click_pref(&app, enabled);
    Ok(())
}

/// 获取「关联 .mspp 插件包」开关（供「设置 → 常规设置」展示）。
///
/// 以**系统注册表的真实状态**为准（而非内存偏好）：用户可能在 Windows
/// 「默认应用」里改过，或另一个版本的程序写过——与 `is_autostart_enabled`
/// 同一口径，面板显示的必须是真正生效的状态。
#[tauri::command]
fn get_file_assoc_enabled() -> bool {
    file_assoc::is_registered()
}

/// 设置「关联 .mspp 插件包」并立即写/清注册表（偏好落盘供下次启动自愈）。
///
/// 返回值是**写完后的注册表真实状态**（而非请求的 `enabled`）：前端拿它回填开关，
/// 于是面板显示的永远是真正生效的状态。
///
/// 写入顺序刻意是「先动注册表、成功后再落偏好」：
///   - 若先写偏好再写注册表，注册表失败（权限/被策略拦）会留下 `true` 偏好 +
///     空注册表的矛盾组合，下次启动还会拿这个脏值去自愈（本项目实际踩过）；
///   - 失败时**偏好保持原样**，注册表与偏好都仍是旧状态，两者一致。
fn set_file_assoc_enabled_inner(app: &tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    apply_file_assoc_preference(app, enabled)?;
    write_file_assoc_pref(app, enabled);
    Ok(file_assoc::is_registered())
}

/// 设置「关联 .mspp 插件包」命令（见 `set_file_assoc_enabled_inner`）
#[tauri::command]
fn set_file_assoc_enabled_cmd(app: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    set_file_assoc_enabled_inner(&app, enabled)
}

/// 取出并清空「待打开的插件包路径」（双击 .mspp / 命令行传入）。
///
/// 幂等：取出即清空，重复调用返回 None。前端在**收到叫醒事件**与**自身挂载时**
/// 各调一次，两条路径共用这一个消费点，因此不会重复弹窗也不会漏。
#[tauri::command]
fn take_pending_plugin_open() -> Option<String> {
    take_pending_plugin_open_inner()
}

/// 获取默认订阅（内置官方订阅原文本，与油猴版一致）
#[tauri::command]
fn get_default_subscribe_text() -> String {
    "<tis::https://raw.githubusercontent.com/My-Search/official-subscribe/refs/heads/dev/only-system-index.ms title=\"官方订阅-系统项\" describe=\"我的搜索官方内置订阅的系统项部分，含内置的应用与系统项\" />\n<tis::https://raw.githubusercontent.com/My-Search/official-subscribe/refs/heads/dev/index.ms title=\"官方作者zhuangjie订阅-小庄的收藏室\" describe=\"我的搜索官方内置订阅之作者zhuangjie订阅，收藏了一些实用的软件、网站、教程\" />"
        .to_string()
}

/// 获取当前「呼出/隐藏快捷键」字符串（兼容旧接口；等价于绑定列表里
/// action = toggle-window 的那条，无自定义则返回默认值）
#[tauri::command]
fn get_toggle_shortcut(app: tauri::AppHandle) -> String {
    read_toggle_shortcut(&app)
}

/// 获取全部快捷键绑定（快捷键 / 作用类型 / 作用对象）。
///
/// 返回形态与前端 `src/lib/shortcut-bindings.ts` 的 ShortcutBinding 对齐；
/// 首次运行返回一条默认的「呼出/隐藏搜索框」绑定。
#[tauri::command]
fn get_shortcut_bindings(app: tauri::AppHandle) -> Vec<serde_json::Value> {
    read_shortcut_bindings(&app)
        .iter()
        .map(|b| b.to_value())
        .collect()
}

/// 设置「呼出/隐藏快捷键」并立即生效（兼容旧接口：只改这一条绑定，
/// 其它绑定原样保留；前端新面板走 set_shortcut_bindings）。
#[tauri::command]
fn set_toggle_shortcut(app: tauri::AppHandle, shortcut: String) -> Result<(), String> {
    let trimmed = shortcut.trim().to_string();
    if trimmed.is_empty() {
        return Err("快捷键不能为空".into());
    }
    let mut bindings = read_shortcut_bindings(&app);
    match bindings
        .iter_mut()
        .find(|b| b.action == SHORTCUT_ACTION_TOGGLE_WINDOW)
    {
        Some(slot) => slot.shortcut = trimmed,
        None => bindings.push(ShortcutBinding {
            shortcut: trimmed,
            action: SHORTCUT_ACTION_TOGGLE_WINDOW.to_string(),
            target: None,
        }),
    }
    // 走同一套严格校验：新键可能与某条 open-plugin 绑定撞车（旧接口也不该破坏这条不变式）
    let parsed = parse_shortcut_bindings_strict(&serde_json::Value::Array(
        bindings.iter().map(|b| b.to_value()).collect(),
    ))?;
    if parsed == read_shortcut_bindings(&app) {
        return Ok(());
    }
    apply_shortcut_bindings(&app, &parsed)
}

/// 设置整套快捷键绑定并立即生效（**设置 → 快捷键** 面板的主入口）。
///
/// 校验规则（与前端 `validateBindings` 一致，Rust 侧是最后一道闸门）：
/// - 每条都必须能解析成组合键（"ctrl+alt+s"）；
/// - 呼出/隐藏最多一条；
/// - 组合键不允许重复。
///
/// 校验通过后整体重新注册；任一条注册失败（被其它程序占用等）会回滚到
/// 改动前的状态且**不落盘**，并返回错误信息。
///
/// 与插件前台的解绑保持同一口径：面板里删掉截图绑定时也要记「用户主动解绑」，
/// 否则读绑定时的自愈补齐会在下次启动把它加回来（**两个入口的行为必须一致**，
/// 否则用户会发现「面板里删了、插件里还在」）。
#[tauri::command]
fn set_shortcut_bindings(
    app: tauri::AppHandle,
    bindings: Vec<serde_json::Value>,
) -> Result<(), String> {
    let parsed = parse_shortcut_bindings_strict(&serde_json::Value::Array(bindings))?;
    // 与当前生效值完全一致：无需重注册，直接成功（避免平白打断）
    if parsed == read_shortcut_bindings(&app) {
        return Ok(());
    }
    let has_screenshot = parsed
        .iter()
        .any(|b| b.action == SHORTCUT_ACTION_SCREENSHOT);
    let has_clipboard = parsed
        .iter()
        .any(|b| b.action == SHORTCUT_ACTION_CLIPBOARD);
    apply_shortcut_bindings(&app, &parsed)?;
    // 只有注册+落盘都成功后，才把「解绑」意图记下来
    set_screenshot_unbound(&app, !has_screenshot);
    set_clipboard_unbound(&app, !has_clipboard);
    Ok(())
}

/// 注册整套绑定并持久化（注册失败时回滚且不落盘）。
fn apply_shortcut_bindings(app: &tauri::AppHandle, bindings: &[ShortcutBinding]) -> Result<(), String> {
    register_shortcut_bindings(app, bindings)?;
    write_shortcut_bindings(app, bindings);
    Ok(())
}

// ===================== 插件侧快捷键桥接（screenshot / clipboard 用） =====================
//
// 插件的「设置自己的热键」不该自己存一份键值：权威存储是宿主
// settings.json 的 shortcut_bindings。于是插件 API 走这里读改写，
// 复用宿主既有的严格校验 / 注册回滚 / 落盘链路，两边永远一致。
//
// **必须原样携带 target**：绑定列表里可能同时存在 open-plugin / quick-filter /
// quick-open 这些「需要作用对象」的条目。桥接若把它们的作用对象丢掉（统一写成
// null），严格解析会因为「缺作用对象」整体报错——用户只是改一个自己的键，
// 却因为列表里别的绑定而失败（真实踩到过的故障）。因此这里用完整的
// `ShortcutBinding` 往返，不降级成 (action, shortcut) 二元组。

/// 读当前绑定列表（完整结构，供插件侧读改写；不丢 target）。
pub(crate) fn read_shortcut_bindings_for_plugin(app: &tauri::AppHandle) -> Vec<ShortcutBinding> {
    read_shortcut_bindings(app)
}

/// 写回绑定列表：严格校验 + 注册 + 落盘。
///
/// 与 `apply_shortcut_bindings` 同一条链路，但入口处先做一次「原样序列化」，
/// 把插件给出的完整绑定（含 target）交给严格解析——不再硬编码 null。
pub(crate) fn apply_shortcut_bindings_for_plugin(
    app: &tauri::AppHandle,
    bindings: &[ShortcutBinding],
) -> Result<(), String> {
    let value = serde_json::Value::Array(bindings.iter().map(|b| b.to_value()).collect());
    let parsed = parse_shortcut_bindings_strict(&value)?;
    if parsed == read_shortcut_bindings(app) {
        return Ok(());
    }
    apply_shortcut_bindings(app, &parsed)
}

// ===================== 备份 / 导入 / 还原 =====================
//
// 前端负责「把 localStorage 里的用户态收集成一个 JSON」，Rust 负责
// 「连同插件文件一起打包成 .msbackup」「还原前留底」「把归档里的设置与插件写回」。
// 之所以不把插件文件也丢给前端走 IPC：插件目录可能有几百 MB（含后端可执行文件），
// 过一遍 JSON + base64 会白白撑爆内存。

/// 可备份的 Rust 侧设置键（前端导出时读、导入时写）。
///
/// 白名单而非黑名单：settings.json 里出现新键时，「要不要跨设备同步」
/// 应当由写这个键的人显式决定。
const BACKUP_SETTINGS_KEYS: &[&str] = &[
    SETTINGS_KEY_SHORTCUT_BINDINGS,
    SETTINGS_KEY_AUTOSTART_ENABLED,
    SETTINGS_KEY_ALT_CLICK,
];

/// 读取可备份的设置项（返回一个 JSON 对象）
fn read_backup_settings(app: &tauri::AppHandle) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    if let Some(store) = settings_store(app) {
        for key in BACKUP_SETTINGS_KEYS {
            if let Some(v) = store.get(*key) {
                map.insert((*key).to_string(), v);
            }
        }
    }
    serde_json::Value::Object(map)
}

/// 写回可备份的设置项（**合并式**：只覆盖传入对象里出现的键）。
///
/// 快捷键与自启动都需要「立即生效」：写完 store 后立刻重新注册快捷键、
/// 应用自启动偏好，否则用户会看到「设置里已经是备份里的键，但按下去没反应」。
pub(crate) fn write_backup_settings(
    app: &tauri::AppHandle,
    values: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    let Some(store) = settings_store(app) else {
        return Err("设置存储不可用，无法写回设置".into());
    };
    for (key, value) in values {
        if !BACKUP_SETTINGS_KEYS.contains(&key.as_str()) {
            continue;
        }
        store.set(key.to_string(), value.clone());
    }
    store.save().map_err(|e| format!("保存设置失败: {e}"))?;

    // 快捷键：重新注册（失败不阻断——设置已落盘，重启后仍会生效）
    if values.contains_key(SETTINGS_KEY_SHORTCUT_BINDINGS) {
        let bindings = read_shortcut_bindings(app);
        if let Err(e) = register_shortcut_bindings(app, &bindings) {
            eprintln!("还原后重新注册快捷键失败（重启应用生效）: {e}");
        }
    }
    // 开机自启动：把系统启动项对齐到还原后的偏好
    if let Some(enabled) = values
        .get(SETTINGS_KEY_AUTOSTART_ENABLED)
        .and_then(|v| v.as_bool())
    {
        if let Err(e) = set_autostart_enabled(app, enabled) {
            eprintln!("还原后应用开机自启动失败: {e}");
        }
    }
    // Alt+点击带入：同步内存开关（落盘已在上面的循环里完成）
    if let Some(enabled) = values
        .get(SETTINGS_KEY_ALT_CLICK)
        .and_then(|v| v.as_bool())
    {
        alt_click::set_enabled(enabled);
    }
    Ok(())
}

/// 停掉某个插件的后台进程（还原插件目录前释放文件占用）。
/// 还原会整体替换 `plugins/`，运行中的插件可执行文件在 Windows 上是锁死的。
pub(crate) fn plugin_host_stop_backend(app: &tauri::AppHandle, plugin_id: &str) {
    let _ = plugin_host::plugin_backend_stop(app.clone(), plugin_id.to_string());
}

/// 导出备份：把「前端快照 + Rust 侧设置 + 插件文件」打成 .msbackup 写进备份目录。
///
/// 返回归档路径；`to_downloads` 为 true 时额外复制一份到系统「下载」目录，
/// 方便用户直接拖走（这是「导出文件」最常见的诉求）。
#[tauri::command]
fn backup_export(
    app: tauri::AppHandle,
    local_storage: serde_json::Value,
    to_downloads: Option<bool>,
) -> Result<serde_json::Value, String> {
    let settings = read_backup_settings(&app);
    let version = app.package_info().version.to_string();
    let path = backup::export_to_backups(&app, local_storage, settings, &version, "my-search-")?;
    let mut exported = path.clone();
    if to_downloads.unwrap_or(false) {
        if let Ok(dir) = app.path().download_dir() {
            let name = std::path::Path::new(&path)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "my-search.msbackup".to_string());
            let dest = dir.join(name);
            if std::fs::copy(&path, &dest).is_ok() {
                exported = dest.to_string_lossy().to_string();
            }
        }
    }
    let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    Ok(serde_json::json!({ "path": path, "exported": exported, "size": bytes }))
}

/// 把当前状态打包写进备份目录（云同步上传前的「本机快照」，
/// 也是「自动备份」的落点；与 backup_export 的差别只是名字前缀与不复制到下载目录）
#[tauri::command]
fn backup_snapshot(
    app: tauri::AppHandle,
    local_storage: serde_json::Value,
    prefix: Option<String>,
) -> Result<String, String> {
    let settings = read_backup_settings(&app);
    let version = app.package_info().version.to_string();
    let prefix = prefix.unwrap_or_else(|| "snapshot-".to_string());
    // 前缀来自面板固定选项，这里仍做一次白名单化，避免被拼出路径
    let prefix: String = prefix
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    let prefix = if prefix.is_empty() {
        "snapshot-".to_string()
    } else {
        prefix
    };
    let prefix = if prefix.ends_with('-') {
        prefix
    } else {
        format!("{prefix}-")
    };
    backup::export_to_backups(&app, local_storage, settings, &version, &prefix)
}

/// 预览归档内容（导入前的「看清再决定」）
#[tauri::command]
fn backup_inspect(app: tauri::AppHandle, path: String) -> Result<serde_json::Value, String> {
    let bytes = backup::read_backup_file(&app, &path)?;
    backup::inspect_archive(&bytes)
}

/// 备份目录路径（面板「打开目录」）
#[tauri::command]
fn backup_dir(app: tauri::AppHandle) -> Result<String, String> {
    backup::backups_dir_path(&app)
}

/// 打开备份目录（系统文件管理器）
#[tauri::command]
fn backup_open_dir(app: tauri::AppHandle) -> Result<(), String> {
    let dir = backup::backups_dir_path(&app)?;
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(dir, None::<&str>)
        .map_err(|e| format!("打开备份目录失败: {e}"))
}

/// 用系统对话框导出：把当前状态导出到用户选定路径（覆盖确认由系统弹窗负责）
#[tauri::command]
fn backup_export_as(
    app: tauri::AppHandle,
    local_storage: serde_json::Value,
    path: String,
) -> Result<serde_json::Value, String> {
    let settings = read_backup_settings(&app);
    let version = app.package_info().version.to_string();
    let bytes = backup::build_archive(&app, local_storage, settings, &version)?;
    let size = bytes.len() as u64;
    std::fs::write(&path, &bytes).map_err(|e| format!("写入失败: {e}"))?;
    Ok(serde_json::json!({ "path": path, "size": size }))
}

/// 还原备份。
///
/// `categories`：要还原的分区（localStorage / settings / plugins / pluginData），
/// 空数组 = 全部。Rust 负责 settings 与插件部分，localStorage 交回前端写。
/// 返回里带上「还原前留底路径」，前端据此给用户一条后悔药。
#[tauri::command]
fn backup_restore(
    app: tauri::AppHandle,
    path: String,
    categories: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    let bytes = backup::read_backup_file(&app, &path)?;
    let version = app.package_info().version.to_string();
    let only = categories.unwrap_or_default();
    let (report, local_storage, manifest) = backup::restore_archive(&app, &bytes, &only, &version)?;
    let mut value = serde_json::to_value(&report).map_err(|e| e.to_string())?;
    if let Some(obj) = value.as_object_mut() {
        obj.insert("localStorage".into(), local_storage);
        obj.insert("manifest".into(), manifest);
    }
    Ok(value)
}

// ===================== 托盘 =====================
/// 修复：托盘菜单交互后鼠标光标可能消失。
///
/// 现象：在托盘图标上左键/右击弹出菜单，把鼠标移过去时指针不见了
/// （菜单项其实仍在响应，只是光标不可见），点击别处后移动才恢复。
///
/// 成因（两个因素叠加）：
/// 1. `tray-icon` 在 Windows 上为接收托盘消息创建的隐藏窗口，其 WNDCLASSW
///    用 `zeroed()` 注册 —— `hCursor = NULL`，且窗口过程不处理 `WM_SETCURSOR`；
///    `TrackPopupMenu` 弹出/收起时，系统把光标状态的维护权交给这个窗口后无法恢复。
/// 2. 本机 WebView2 Runtime 152.0.4191.x 存在已知的光标消失缺陷
///    （MicrosoftEdge/WebView2Feedback #5708）：运行时内部会用 ShowCursor 隐藏
///    光标（如「输入时隐藏指针」），异常路径下计数不归零，导致整个会话内
///    光标保持隐藏。
///
/// 修法：在托盘菜单事件（Windows 上菜单已收起，回到主线程）时把光标可见
/// 计数恢复到 >= 0。等价于系统设置「输入时隐藏指针」的官方 workaround，
/// 但只在本应用交互节点触发，不影响系统其它行为。
#[cfg(windows)]
fn force_cursor_visible() {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetCursorInfo, ShowCursor, CURSORINFO,
    };

    // CURSOR_VISIBLE = 1（SYSTEM_CURSOR_VISIBLE）：光标当前在显示
    const CURSOR_VISIBLE: u32 = 1;

    unsafe {
        let mut info = CURSORINFO {
            cbSize: std::mem::size_of::<CURSORINFO>() as u32,
            flags: 0,
            hCursor: std::ptr::null_mut(),
            ptScreenPos: windows_sys::Win32::Foundation::POINT { x: 0, y: 0 },
        };
        if GetCursorInfo(&mut info) != 0 && (info.flags & CURSOR_VISIBLE) == 0 {
            // 光标处于隐藏状态：逐次 +1 直到恢复显示（每次 ShowCursor 返回新计数）
            let mut n = ShowCursor(1); // BOOL = 1（true）
            while n < 0 {
                n = ShowCursor(1);
            }
        }
    }
}

#[cfg(not(windows))]
fn force_cursor_visible() {}

/// 创建系统托盘：左键单击切换显示/隐藏，菜单提供显示/隐藏、设置、清理缓存与退出
///
/// 图标策略（macOS 审美优先）：
/// - macOS：使用单色模板图标（`tray-mono.png`，纯黑 + 透明背景）。
///   `icon_as_template(true)` 让系统按浅色/深色菜单栏自动反色，
///   且不会出现圆角白底方块。
/// - Windows / Linux：使用彩色叶子图标（`tray.png`，透明背景）。
fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;

    // tooltip 带上当前生效的快捷键（默认 Ctrl+Alt+S，自定义后随之更新）
    let shortcut_caps = shortcut_to_caps(&read_toggle_shortcut(app));
    let tooltip = format!("我的搜索（{shortcut_caps} 呼出）");

    let toggle = MenuItem::with_id(app, "toggle", "显示/隐藏", true, None::<&str>)?;
    let config = MenuItem::with_id(app, "config", "设置", true, None::<&str>)?;
    let clear_cache = MenuItem::with_id(app, "clear-cache", "清理缓存", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &config, &clear_cache, &quit])?;

    // macOS 用单色模板图标，其它平台用彩色图标
    #[cfg(target_os = "macos")]
    let (icon, as_template) = (
        tauri::image::Image::from_bytes(include_bytes!("../icons/tray-mono.png"))?,
        true,
    );
    #[cfg(not(target_os = "macos"))]
    let (icon, as_template) = (
        tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?,
        false,
    );

    let _tray = TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .icon_as_template(as_template)
        .tooltip(&tooltip)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            // 菜单事件到达时菜单已收起：借此机会修复可能被 TrackPopupMenu /
            // WebView2 置为隐藏的鼠标光标（见 force_cursor_visible 文档）
            "toggle" => {
                force_cursor_visible();
                toggle_window(app);
            }
            "config" => {
                force_cursor_visible();
                // 托盘菜单事件在事件循环（主线程）上派发：这里**不能**同步创建
                // 配置窗口（Windows 上会死锁，见 open_config_window 文档），
                // 必须把窗口创建任务丢到异步运行时线程上执行。
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    open_config_window(handle).await;
                });
            }
            "clear-cache" => {
                force_cursor_visible();
                // 向前端主窗口发送清理缓存事件，由前端操作 localStorage（Rust 侧
                // 无法直接访问 WebView 的 localStorage）。窗口隐藏时 WebView 仍
                // 在运行、事件照常送达；数据重载由前端在下次呼出时自动触发。
                let _ = app.emit("my-search://clear-cache", ());
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Linux 上部分桌面环境点击托盘图标不触发菜单，左键单击直接切换
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                force_cursor_visible();
                toggle_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 单实例必须注册为**第一个**插件（官方要求：它要在其它插件初始化之前
        // 抢到命名互斥体，否则第二个实例已经把快捷键/托盘建好了才发现该退出）。
        //
        // 回调在**第二个实例启动**时于**第一个实例**里执行，argv 是第二个实例的
        // 命令行。两种情况：
        //   - 带 .mspp 路径（双击插件包）→ 走「打开插件包」：置入待处理槽 + 打开配置窗口 + 广播；
        //   - 其它（用户又点了一次图标 / 开机自启与手工启动撞车）→ 只呼出窗口，
        //     与点托盘图标同效，不重复起进程。
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            match file_assoc::plugin_path_from_args(&argv) {
                Some(path) => open_plugin_package(app, path),
                None => show_main_window(app),
            }
        }))
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_dialog::init())
        .manage(ActiveShortcutState(Mutex::new(Vec::new())))
        .manage(DownloadedInstallerPath(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            http_get,
            http_request,
            set_window_height,
            get_default_window_width,
            animate_window_size,
            cancel_window_resize_animation,
            reset_main_window_position,
            open_url,
            quit_app,
            apply_app_theme,
            open_config_window,
            get_default_subscribe_text,
            get_toggle_shortcut,
            set_toggle_shortcut,
            get_shortcut_bindings,
            set_shortcut_bindings,
            get_autostart_enabled,
            set_autostart_enabled_cmd,
            get_alt_click_enabled,
            set_alt_click_enabled_cmd,
            get_file_assoc_enabled,
            set_file_assoc_enabled_cmd,
            take_pending_plugin_open,
            // 设置窗口「从插件市场安装」：收起设置窗 + 呼出主窗 + 打开插件界面
            open_plugin_view,
            check_update,
            start_update_download,
            open_installer,
            // ---------- 插件宿主 ----------
            plugin_host::plugin_install,
            plugin_host::plugin_remove,
            plugin_host::plugin_purge_data,
            plugin_host::plugin_link_dir,
            plugin_host::plugin_read_text,
            plugin_host::plugin_read_binary,
            plugin_host::plugin_list_files,
            plugin_host::plugin_read_local_base64,
            plugin_host::plugin_open_dir,
            plugin_host::plugin_check_path,
            plugin_host::plugin_gateway_sync,
            plugin_host::plugin_net_fetch,
            plugin_host::plugin_backend_start,
            plugin_host::plugin_backend_stop,
            plugin_host::plugin_backend_restart,
            plugin_host::plugin_backend_list,
            plugin_host::plugin_backend_call,
            plugin_host::plugin_read_log,
            plugin_host::plugin_clear_log,
            plugin_host::plugin_read_dev_manifest,
            // 目录挂载插件（开发模式）的自动重载：登记/取消源目录监听
            plugin_host::plugin_watch_dir,
            // ---------- 搜索框附件（粘贴/拖入的文件与文件夹） ----------
            attachments::clipboard_file_paths,
            attachments::fs_describe_paths,
            attachments::attachments_sync,
            attachments::attachment_read,
            attachments::attachment_preview,
            attachments::attachment_list,
            attachments::attachment_list_cancel,
            attachments::attachment_open,
            attachments::attachment_reveal,
            // 系统文件图标（资源管理器同款）：输入框附件 chip 用
            attachments::attachment_file_icons,
            // ---------- 插件市场 ----------
            market::market_fetch_raw,
            // ---------- 截图（热键框选 + 标注 + 剪贴板 + 插件画廊） ----------
            // 抓屏与遮罩：遮罩页 / 快捷键动作调用
            screenshot::screenshot_capture,
            screenshot::screenshot_open_overlay,
            screenshot::screenshot_close_overlay,
            screenshot::screenshot_overlay_image,
            screenshot::screenshot_crop,
            screenshot::screenshot_selection_image,
            // 插件：一次调用完成「开遮罩 → 拖选 → 关遮罩」，回物理像素矩形
            screenshot::screenshot_pick_region,
            // 产出：写剪贴板 / 落盘 / 广播
            screenshot::screenshot_copy_image,
            screenshot::screenshot_copy_text,
            screenshot::screenshot_save_shot,
            // 产出的「另存为」：弹系统保存框让用户选目录/文件名
            screenshot::screenshot_save_shot_as,
            screenshot::screenshot_notify_saved,
            // 画廊：列/读/删/清理（都在插件私有目录内，路径已做穿越校验）
            screenshot::screenshot_list_shots,
            screenshot::screenshot_shots_dir,
            screenshot::screenshot_read_shot,
            screenshot::screenshot_delete_shot,
            screenshot::screenshot_prune_shots,
            // 插件侧：读/改「截图」快捷键（权威存储是宿主的 shortcut_bindings）
            screenshot::screenshot_get_shortcut,
            screenshot::screenshot_set_shortcut,
            // ---------- 剪贴板历史（原生监听 + 只读抓取 + 插件私有目录落盘） ----------
            // 列表/读图/删除/清空/复制回剪贴板（复制是唯一的写剪贴板路径，用户显式触发）
            clipboard_history::clipboard_history_list,
            // 分页列表（每页 30 条、触底加载更多；支持「仅收藏」与关键词过滤后再分页）
            clipboard_history::clipboard_history_page,
            clipboard_history::clipboard_history_read_image,
            clipboard_history::clipboard_history_delete,
            clipboard_history::clipboard_history_clear,
            clipboard_history::clipboard_history_copy,
            // 收藏 / 取消收藏（收藏条目永久保留，不参与上限淘汰与默认清空）
            clipboard_history::clipboard_history_set_favorite,
            // 插件侧：读/改「剪贴板历史」快捷键
            clipboard_history::clipboard_history_get_shortcut,
            clipboard_history::clipboard_history_set_shortcut,
            // ---------- 内置插件 ----------
            builtin::builtin_list,            builtin::builtin_mark_removed,
            builtin::builtin_clear_removed,
            builtin::builtin_resource_path,
            // ---------- 备份 / 导入 / 还原 ----------
            backup_export,
            backup_export_as,
            backup_snapshot,
            backup_inspect,
            backup_restore,
            backup_dir,
            backup_open_dir,
            // ---------- 云同步（WebDAV / Google Drive / OneDrive） ----------
            cloud::sync_get_config,
            cloud::sync_set_config,
            cloud::sync_test,
            cloud::sync_remote_meta,
            cloud::sync_upload,
            cloud::sync_download,
            cloud::sync_clear_credentials,
        ])
        .setup(|app| {
            // 冷启动：先把落盘/系统兜底的主题状态记入内存，使后续前端上报时的幂等
            // 校验（偏好 + 解析值均未变即跳过）能正确命中——否则首次上报时 APP_THEME
            // 全为 None，即使主题没变也会走完 apply_theme_to_windows + emit，
            // 对刚创建的设置窗口造成冗余的 set_background_color / set_theme 而频闪。
            let boot_pref = read_theme_pref(app.handle()).unwrap_or(ThemePref::System);
            let boot_dark = resolve_is_dark(boot_pref);
            {
                let mut guard = APP_THEME
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                guard.pref = Some(boot_pref);
                guard.resolved_dark = Some(boot_dark);
            }
            // 主窗口使用固定 WebView 数据目录（localStorage 持久化）
            if let Some(main) = app.get_webview_window("main") {
                // 初始定宽与定位（尚未显示，真正呼出时会按当时所在屏幕再算一次）
                if let Some(monitor) = target_monitor(&main) {
                    let width = target_window_width(&monitor);
                    let _ = main.set_size(tauri::LogicalSize::new(width, COLLAPSED_WINDOW_HEIGHT));
                    position_window_top_center(&main, &monitor, width);
                }
            }
            // 冷启动先把上次的主题铺到原生层：窗口首次显示时若 WebView 尚未绘制，
            // 露出的是窗口底色（tauri.conf.json 里配的是白色），深色下会闪白。
            // 此刻前端还没上报，取落盘偏好 / 系统兜底；前端挂载后会立即以
            // 真实偏好 + `prefers-color-scheme` 解析值覆盖（两者同源，通常一致）。
            apply_theme_to_windows(app.handle(), boot_pref, boot_dark);
            // 读取自定义快捷键绑定（无自定义则用默认呼出键），逐条注册
            let bindings = read_shortcut_bindings(app.handle());
            if let Err(e) = register_shortcut_bindings(app.handle(), &bindings) {
                eprintln!("注册全局快捷键失败: {e}");
            }
            // Alt+点击资源管理器文件快速带入：先读偏好再装全局鼠标钩子
            // （钩子只观察不吞点击；回调极轻，解析在异步任务里做，见 alt_click.rs）
            alt_click::set_enabled(
                read_alt_click_pref(app.handle()).unwrap_or(DEFAULT_ALT_CLICK_ENABLED),
            );
            alt_click::install(app.handle().clone());
            // 剪贴板历史监听：建隐藏 message-only 窗口挂 AddClipboardFormatListener。
            // 必须在带消息循环的主线程装（本处满足）；失败只记日志，不阻断启动。
            clipboard_history::install(app.handle().clone());
            apply_autostart_preference(app.handle());
            // `.mspp` 文件关联：按偏好登记（正式构建 / dev 逃生门）或清除。
            // 登记是幂等的自愈写入——exe 换位置、图标资源更新都会在这里被纠正。
            // 失败只记日志，不阻断启动（文件关联不是核心功能）。
            //
            // 失败只记日志，不阻断启动（文件关联不是核心功能）。
            if let Err(e) = apply_file_assoc_preference(
                app.handle(),
                read_file_assoc_pref(app.handle()).unwrap_or(DEFAULT_FILE_ASSOC_ENABLED),
            ) {
                eprintln!("应用 .mspp 文件关联设置失败（不影响启动）: {e}");
            }
            // 本次启动是否由「双击插件包」触发：把路径放进待处理槽，并延迟打开配置窗口。
            //
            // 为什么要延迟：setup 阶段 WebView 还没加载完，前端监听尚未注册，
            // 此刻广播会被丢掉。等约 400ms（覆盖 WebView 首帧 + 前端挂载）再打开
            // 并广播——前端挂载时也会主动拉一次，两条路径都指向同一个幂等命令，
            // 因此这个延时只是「让界面更早出现」，不是正确性的依赖。
            if let Some(path) = file_assoc::plugin_path_from_args(&std::env::args().collect::<Vec<_>>())
            {
                set_pending_plugin_open(path);
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(400));
                    let cfg_handle = handle.clone();
                    tauri::async_runtime::spawn(async move {
                        open_config_window(cfg_handle).await;
                    });
                    let _ = handle.emit(EVENT_OPEN_PLUGIN_PACKAGE, ());
                });
            }
            // 托盘先建好：它与全局快捷键是「呼出」的两条入口，必须赶在任何可能
            // 阻塞的初始化之前就绪（否则事件循环被拖住时，用户连托盘都看不到）。
            setup_tray(app.handle())?;
            // 内置插件引导（广播应装未装的插件 id，前端接收后走既有安装管线）
            let boot = builtin::bootstrap(app.handle());
            if !boot.installable.is_empty() || !boot.skipped_removed.is_empty() {
                let _ = app.emit("builtin://available", &boot);
            }
            // 插件后台进程放最后且**不阻塞**：只拉起「开机自启」已开启的插件
            // （其它按需启动）。spawn + 握手在后台线程完成，setup 立即返回，
            // 应用能马上被全局快捷键呼出——否则一个握手失败的插件会把用户
            // 挡在 startupTimeoutMs（最长 30s）之外。
            plugin_host::autostart_enabled_backends(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            // 主窗口一旦失去焦点就无条件隐藏（用户规则）：
            // 不看当前在干什么——正在查看简述内容 / 附加内容 / 脚本应用、搜索进行中
            // 都先隐藏；之后再用全局快捷键（默认 Ctrl+Alt+S，可自定义）或托盘唤出，
            // 前端会按隐藏前的视图状态把内容「原样还原」回来（见 App.vue 的
            // resumeDetailViewIfAny），所以正在看的东西不会丢。
            if window.label() != "main" {
                return;
            }
            let tauri::WindowEvent::Focused(false) = event else {
                return;
            };
            // 呼出后短暂抑制：Alt+点击发生的呼出常常刚 show 就被前台锁定
            // 的抖动夺焦，此刻隐藏等于「点了没反应」。抑制期内的失焦忽略。
            let until = SUPPRESS_BLUR_UNTIL_MS.load(Ordering::Relaxed);
            if until != 0 && now_ms() < until {
                return;
            }
            // 隐藏时把窗口收回到搜索框高度，
            // 这样下次呼出不会残留上一次搜索时的高窗口（下方空一大块）
            if let Some(main) = window.app_handle().get_webview_window("main") {
                collapse_main_window(&main);
            }
            let _ = window.hide();
        })
        .build(tauri::generate_context!())
        .expect("构建我的搜索桌面版失败")
        .run(|_app, event| {
            // 退出前释放目录挂载插件的文件监听句柄（进程即将结束，收干净更稳妥）
            if let tauri::RunEvent::Exit = event {
                plugin_watch::stop_dispatch();
                plugin_watch::unwatch_all();
                // 卸掉剪贴板监听并销毁监听窗口
                clipboard_history::uninstall();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{convert_raw_to_api, convert_raw_to_jsdelivr, parse_raw_github_url};
    use tauri_plugin_global_shortcut::Shortcut;

    #[test]
    fn shortcut_strings_parse_like_global_hotkey() {
        // 前端「快捷键设置」约定发送这些形式的小写加号串，必须都能被解析
        for s in ["ctrl+alt+s", "ctrl+shift+p", "alt+x", "f9", "ctrl+alt+0"] {
            assert!(Shortcut::try_from(s).is_ok(), "应可解析: {s}");
        }
        // 非法输入必须被拒绝（前端录入 UI 的兜底依赖 Rust 侧校验）
        assert!(Shortcut::try_from("ctrl").is_err());
        assert!(Shortcut::try_from("ctrl+alt").is_err());
        assert!(Shortcut::try_from("ctrl+q+alt").is_err());
        assert!(Shortcut::try_from("ctrl+不存在的键").is_err());
        assert!(Shortcut::try_from("").is_err());
    }

    #[test]
    fn default_toggle_shortcut_is_valid() {
        assert!(Shortcut::try_from(super::DEFAULT_TOGGLE_SHORTCUT).is_ok());
    }

    #[test]
    fn theme_strings_parse_into_pref_and_resolved() {
        use super::{parse_resolved, parse_theme_pref, ThemePref};

        // 偏好接受三档；老 settings.json 里的 light/dark（旧契约写的是已解析值）
        // 值域兼容，按强制档读取，前端首个上报帧会改写为真实偏好
        assert_eq!(parse_theme_pref("light"), Some(ThemePref::Light));
        assert_eq!(parse_theme_pref("dark"), Some(ThemePref::Dark));
        assert_eq!(parse_theme_pref("system"), Some(ThemePref::System));
        assert_eq!(parse_theme_pref("System"), None);
        assert_eq!(parse_theme_pref(""), None);

        // 解析值只接受二色，system 不得当颜色透传
        assert_eq!(parse_resolved("dark"), Some(true));
        assert_eq!(parse_resolved("light"), Some(false));
        assert_eq!(parse_resolved("system"), None);
        assert_eq!(parse_resolved("auto"), None);
    }

    #[test]
    fn parse_bindings_round_trips() {
        use super::{
            parse_shortcut_bindings, parse_shortcut_bindings_strict, ShortcutBinding,
            SHORTCUT_ACTION_OPEN_PLUGIN, SHORTCUT_ACTION_TOGGLE_WINDOW,
        };
        let raw = serde_json::json!([
            { "shortcut": "ctrl+alt+s", "action": SHORTCUT_ACTION_TOGGLE_WINDOW },
            { "shortcut": "ctrl+alt+1", "action": SHORTCUT_ACTION_OPEN_PLUGIN, "target": "com.a.b" },
        ]);
        let parsed = parse_shortcut_bindings(&raw);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].target, None);
        assert_eq!(parsed[1].target.as_deref(), Some("com.a.b"));
        // 序列化后再反序列化应完全一致（settings.json 的读写往返）
        let values: Vec<serde_json::Value> = parsed.iter().map(|b| b.to_value()).collect();
        assert_eq!(parse_shortcut_bindings(&serde_json::Value::Array(values)), parsed);
        // 严格版同样接受
        assert_eq!(parse_shortcut_bindings_strict(&raw).unwrap(), parsed);

        // 宽容版：脏数据跳过而不是整体失败
        let dirty = serde_json::json!([
            { "shortcut": "", "action": SHORTCUT_ACTION_TOGGLE_WINDOW },
            { "shortcut": "ctrl+alt+2", "action": "unknown-action" },
            { "shortcut": "ctrl+alt+3", "action": SHORTCUT_ACTION_OPEN_PLUGIN },
            { "shortcut": "ctrl+alt+4", "action": SHORTCUT_ACTION_OPEN_PLUGIN, "target": " com.x.y " },
        ]);
        let cleaned = parse_shortcut_bindings(&dirty);
        assert_eq!(cleaned.len(), 1);
        assert_eq!(cleaned[0].target.as_deref(), Some("com.x.y"));

        // 宽容版对同一组合键去重、对 toggle-window 只保留第一条
        let dup = serde_json::json!([
            { "shortcut": "ctrl+alt+s", "action": SHORTCUT_ACTION_TOGGLE_WINDOW },
            { "shortcut": "ctrl+alt+s", "action": SHORTCUT_ACTION_OPEN_PLUGIN, "target": "com.a.b" },
            { "shortcut": "ctrl+alt+9", "action": SHORTCUT_ACTION_TOGGLE_WINDOW },
        ]);
        let deduped = parse_shortcut_bindings(&dup);
        assert_eq!(deduped.len(), 1);
        assert_eq!(deduped[0].shortcut, "ctrl+alt+s");

        // 严格版：重复组合键 / 非法 action / 空列表都报错
        assert!(parse_shortcut_bindings_strict(&dup).is_err());
        assert!(parse_shortcut_bindings_strict(&serde_json::json!([])).is_err());
        assert!(parse_shortcut_bindings_strict(&serde_json::json!([{ "action": "x" }])).is_err());
        assert!(parse_shortcut_bindings_strict(
            &serde_json::json!([
                { "shortcut": "ctrl+alt+s", "action": SHORTCUT_ACTION_TOGGLE_WINDOW },
                { "shortcut": "ctrl+shift+s", "action": SHORTCUT_ACTION_TOGGLE_WINDOW },
            ])
        )
        .is_err());
    }

    #[test]
    fn binding_serializes_with_target_field() {
        use super::{ShortcutBinding, SHORTCUT_ACTION_OPEN_PLUGIN};
        let b = ShortcutBinding {
            shortcut: "ctrl+alt+1".into(),
            action: SHORTCUT_ACTION_OPEN_PLUGIN.into(),
            target: Some("com.zhuangjie.ai-ask".into()),
        };
        assert_eq!(
            b.to_value(),
            serde_json::json!({
                "shortcut": "ctrl+alt+1",
                "action": "open-plugin",
                "target": "com.zhuangjie.ai-ask",
            })
        );
    }

    /// 「打开插件」绑定必须带作用对象；「呼出/隐藏」必须唯一。
    ///
    /// 注：注册失败时的回滚（被其它程序占用 → 恢复旧绑定）依赖真实 AppHandle 与
    /// 桌面窗口环境，纯单测无法构造，由 test/_e2e-plugin-shortcut.mjs 在真机上覆盖
    /// （真实热键注册 + 真实按键触发）。
    #[test]
    fn open_plugin_binding_requires_target() {
        use super::{parse_shortcut_bindings_strict, SHORTCUT_ACTION_OPEN_PLUGIN, SHORTCUT_ACTION_TOGGLE_WINDOW};

        // 缺作用对象 → 拒绝（否则注册出来的键不知道该打开谁）
        assert!(parse_shortcut_bindings_strict(&serde_json::json!([
            { "shortcut": "ctrl+alt+1", "action": SHORTCUT_ACTION_OPEN_PLUGIN }
        ]))
        .is_err());
        // 只有 target 缺省、action 合法时才通过
        assert!(parse_shortcut_bindings_strict(&serde_json::json!([
            { "shortcut": "ctrl+alt+1", "action": SHORTCUT_ACTION_OPEN_PLUGIN, "target": "com.a.b" }
        ]))
        .is_ok());
        // 呼出/隐藏必须恰好一条（注册逻辑依赖这个不变式：它给 toggle 保留 handler）
        assert!(parse_shortcut_bindings_strict(&serde_json::json!([
            { "shortcut": "ctrl+alt+s", "action": SHORTCUT_ACTION_TOGGLE_WINDOW },
            { "shortcut": "ctrl+alt+9", "action": SHORTCUT_ACTION_TOGGLE_WINDOW }
        ]))
        .is_err());
    }

    /// 截图动作：无作用对象，且默认键不能与宿主默认的呼出键冲突。
    ///
    /// 这两条都是「注册得上去但用户按了没反应」类故障的防线：
    /// 缺作用对象本应被判非法（但它不需要），默认键撞车则会让 toggle 注册失败。
    #[test]
    fn screenshot_action_needs_no_target() {
        use super::{
            is_known_shortcut_action, parse_shortcut_bindings_strict, DEFAULT_SCREENSHOT_SHORTCUT,
            DEFAULT_TOGGLE_SHORTCUT, SHORTCUT_ACTION_SCREENSHOT, SHORTCUT_ACTION_TOGGLE_WINDOW,
        };

        assert!(is_known_shortcut_action(SHORTCUT_ACTION_SCREENSHOT));

        // 没有 target 也合法（与 open-plugin / quick-* 相反）
        let parsed = parse_shortcut_bindings_strict(&serde_json::json!([
            { "shortcut": DEFAULT_TOGGLE_SHORTCUT, "action": SHORTCUT_ACTION_TOGGLE_WINDOW },
            { "shortcut": DEFAULT_SCREENSHOT_SHORTCUT, "action": SHORTCUT_ACTION_SCREENSHOT }
        ]))
        .unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[1].action, SHORTCUT_ACTION_SCREENSHOT);
        assert_eq!(parsed[1].target, None);

        // 默认截图键必须与默认呼出键不同，否则开箱即用就会注册冲突
        assert_ne!(DEFAULT_SCREENSHOT_SHORTCUT, DEFAULT_TOGGLE_SHORTCUT);
    }

    /// 截图绑定自愈补齐：老用户的列表里没有它，必须被补上才能真正注册。
    ///
    /// 这是「插件前台显示 Ctrl+Alt+X，按下去没反应」那个故障的根因防线：
    /// 热键只有进了绑定列表才会被 `register_binding_handlers` 注册到系统。
    #[test]
    fn ensure_screenshot_binding_self_heals() {
        use super::{
            ensure_screenshot_binding, parse_shortcut_bindings, DEFAULT_SCREENSHOT_SHORTCUT,
            SHORTCUT_ACTION_SCREENSHOT, SHORTCUT_ACTION_TOGGLE_WINDOW,
        };

        // 老用户的列表（只有呼出键、没有截图）→ 补上
        let mut old = parse_shortcut_bindings(&serde_json::json!([
            { "shortcut": "ctrl+alt+s", "action": SHORTCUT_ACTION_TOGGLE_WINDOW }
        ]));
        assert_eq!(old.len(), 1);
        ensure_screenshot_binding(&mut old, false);
        assert_eq!(old.len(), 2);
        assert_eq!(old[1].action, SHORTCUT_ACTION_SCREENSHOT);
        assert_eq!(old[1].shortcut, DEFAULT_SCREENSHOT_SHORTCUT);
        assert_eq!(old[1].target, None);

        // 幂等：已经有就不再补（重复补会因「组合键重复」导致整体注册失败）
        ensure_screenshot_binding(&mut old, false);
        assert_eq!(old.len(), 2);

        // 用户主动解绑过 → 尊重，不补
        let mut unbound = parse_shortcut_bindings(&serde_json::json!([
            { "shortcut": "ctrl+alt+s", "action": SHORTCUT_ACTION_TOGGLE_WINDOW }
        ]));
        ensure_screenshot_binding(&mut unbound, true);
        assert_eq!(unbound.len(), 1);

        // 默认截图键已被别的动作占用 → 跳过（宁可没有，也不静默抢键）
        let mut taken = parse_shortcut_bindings(&serde_json::json!([
            { "shortcut": "ctrl+alt+s", "action": SHORTCUT_ACTION_TOGGLE_WINDOW },
            { "shortcut": DEFAULT_SCREENSHOT_SHORTCUT, "action": "quick-open", "target": "某常用头" }
        ]));
        ensure_screenshot_binding(&mut taken, false);
        assert_eq!(taken.len(), 2, "不抢已被占用的键");
        assert!(!taken
            .iter()
            .any(|b| b.action == SHORTCUT_ACTION_SCREENSHOT));
    }

    /// 剪贴板历史动作：无作用对象，默认键与宿主其它默认键都不冲突。
    #[test]
    fn clipboard_action_needs_no_target() {
        use super::{
            is_known_shortcut_action, parse_shortcut_bindings_strict,
            DEFAULT_CLIPBOARD_SHORTCUT, DEFAULT_SCREENSHOT_SHORTCUT, DEFAULT_TOGGLE_SHORTCUT,
            SHORTCUT_ACTION_CLIPBOARD, SHORTCUT_ACTION_TOGGLE_WINDOW,
        };

        assert!(is_known_shortcut_action(SHORTCUT_ACTION_CLIPBOARD));

        // 没有 target 也合法
        let parsed = parse_shortcut_bindings_strict(&serde_json::json!([
            { "shortcut": DEFAULT_TOGGLE_SHORTCUT, "action": SHORTCUT_ACTION_TOGGLE_WINDOW },
            { "shortcut": DEFAULT_CLIPBOARD_SHORTCUT, "action": SHORTCUT_ACTION_CLIPBOARD }
        ]))
        .unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[1].action, SHORTCUT_ACTION_CLIPBOARD);
        assert_eq!(parsed[1].target, None);

        // 三个默认键两两不同，否则开箱即用就会注册冲突
        assert_ne!(DEFAULT_CLIPBOARD_SHORTCUT, DEFAULT_TOGGLE_SHORTCUT);
        assert_ne!(DEFAULT_CLIPBOARD_SHORTCUT, DEFAULT_SCREENSHOT_SHORTCUT);
        assert_ne!(DEFAULT_SCREENSHOT_SHORTCUT, DEFAULT_TOGGLE_SHORTCUT);
    }

    /// 剪贴板历史绑定自愈补齐（与截图版同构，故障场景也一样）。
    #[test]
    fn ensure_clipboard_binding_self_heals() {
        use super::{
            ensure_clipboard_binding, parse_shortcut_bindings, DEFAULT_CLIPBOARD_SHORTCUT,
            SHORTCUT_ACTION_CLIPBOARD, SHORTCUT_ACTION_TOGGLE_WINDOW,
        };

        // 老用户的列表（只有呼出键）→ 补上
        let mut old = parse_shortcut_bindings(&serde_json::json!([
            { "shortcut": "ctrl+alt+s", "action": SHORTCUT_ACTION_TOGGLE_WINDOW }
        ]));
        assert_eq!(old.len(), 1);
        ensure_clipboard_binding(&mut old, false);
        assert_eq!(old.len(), 2);
        assert_eq!(old[1].action, SHORTCUT_ACTION_CLIPBOARD);
        assert_eq!(old[1].shortcut, DEFAULT_CLIPBOARD_SHORTCUT);
        assert_eq!(old[1].target, None);

        // 幂等
        ensure_clipboard_binding(&mut old, false);
        assert_eq!(old.len(), 2);

        // 用户主动解绑过 → 尊重，不补
        let mut unbound = parse_shortcut_bindings(&serde_json::json!([
            { "shortcut": "ctrl+alt+s", "action": SHORTCUT_ACTION_TOGGLE_WINDOW }
        ]));
        ensure_clipboard_binding(&mut unbound, true);
        assert_eq!(unbound.len(), 1);

        // 默认键已被别的动作占用 → 跳过，不静默抢键
        let mut taken = parse_shortcut_bindings(&serde_json::json!([
            { "shortcut": "ctrl+alt+s", "action": SHORTCUT_ACTION_TOGGLE_WINDOW },
            { "shortcut": DEFAULT_CLIPBOARD_SHORTCUT, "action": "quick-open", "target": "某常用头" }
        ]));
        ensure_clipboard_binding(&mut taken, false);
        assert_eq!(taken.len(), 2, "不抢已被占用的键");
        assert!(!taken.iter().any(|b| b.action == SHORTCUT_ACTION_CLIPBOARD));
    }

    /// 桥接读写**必须保留每条绑定的作用对象**。
    ///
    /// 回归防线：曾经的实现把绑定降级成 (action, shortcut) 二元组、写回时统一
    /// `target: null`。于是列表里只要有 open-plugin / quick-filter / quick-open 的
    /// 条目，严格解析就会因「缺作用对象」整体报错——用户只是改一个自己的热键，
    /// 却因为别的绑定而失败（「组合键修改时重新录入不了」的根因）。
    #[test]
    fn plugin_shortcut_bridge_preserves_targets() {
        use super::{
            parse_shortcut_bindings, parse_shortcut_bindings_strict, ShortcutBinding,
            SHORTCUT_ACTION_CLIPBOARD, SHORTCUT_ACTION_OPEN_PLUGIN, SHORTCUT_ACTION_TOGGLE_WINDOW,
        };

        // 一个「真实世界」的列表：呼出 + 打开插件（带 target）+ 剪贴板历史
        let list: Vec<ShortcutBinding> = parse_shortcut_bindings(&serde_json::json!([
            { "shortcut": "ctrl+alt+s", "action": SHORTCUT_ACTION_TOGGLE_WINDOW },
            { "shortcut": "ctrl+alt+1", "action": SHORTCUT_ACTION_OPEN_PLUGIN, "target": "com.a.b" },
            { "shortcut": "ctrl+alt+v", "action": SHORTCUT_ACTION_CLIPBOARD }
        ]));
        assert_eq!(list.len(), 3);

        // 模拟「把剪贴板历史改绑成 ctrl+alt+j」后经桥接写回：
        // 用完整 ShortcutBinding 序列化（即 apply_shortcut_bindings_for_plugin 的做法）
        let mut edited = list.clone();
        for b in edited.iter_mut() {
            if b.action == SHORTCUT_ACTION_CLIPBOARD {
                b.shortcut = "ctrl+alt+j".into();
            }
        }
        let value = serde_json::Value::Array(edited.iter().map(|b| b.to_value()).collect());

        // 关键断言：带 target 的 open-plugin 条目能通过严格解析（不会因它整单失败）
        let parsed = parse_shortcut_bindings_strict(&value)
            .expect("含作用对象的完整绑定必须能通过严格解析");
        assert_eq!(parsed.len(), 3);
        let plugin = parsed
            .iter()
            .find(|b| b.action == SHORTCUT_ACTION_OPEN_PLUGIN)
            .expect("open-plugin 条目应保留");
        assert_eq!(plugin.target.as_deref(), Some("com.a.b"), "作用对象不能丢");
        let clip = parsed
            .iter()
            .find(|b| b.action == SHORTCUT_ACTION_CLIPBOARD)
            .expect("剪贴板条目应保留");
        assert_eq!(clip.shortcut, "ctrl+alt+j", "目标键应已改绑");

        // 反证：旧的「统一 target=null」写法会让整单解析失败（正是当初的故障）
        let degraded: Vec<serde_json::Value> = list
            .iter()
            .map(|b| serde_json::json!({ "shortcut": b.shortcut, "action": b.action, "target": null }))
            .collect();
        assert!(
            parse_shortcut_bindings_strict(&serde_json::Value::Array(degraded)).is_err(),
            "丢掉作用对象后必须被严格解析拒绝（证明修复确有必要）"
        );
    }

    /// 「快速过滤」绑定必须带作用对象（常用头），并原样保留中文文本。
    #[test]
    fn quick_filter_binding_requires_target() {
        use super::{
            parse_shortcut_bindings, parse_shortcut_bindings_strict, ShortcutBinding,
            SHORTCUT_ACTION_QUICK_FILTER, SHORTCUT_ACTION_TOGGLE_WINDOW,
        };

        // 缺常用头 → 拒绝（否则按下去不知道该填入什么）
        assert!(parse_shortcut_bindings_strict(&serde_json::json!([
            { "shortcut": "alt+f", "action": SHORTCUT_ACTION_QUICK_FILTER }
        ]))
        .is_err());

        // 带常用头 → 通过，且 target 保留原文（两侧空白被裁掉）
        let raw = serde_json::json!([
            { "shortcut": "ctrl+alt+s", "action": SHORTCUT_ACTION_TOGGLE_WINDOW },
            { "shortcut": "alt+f", "action": SHORTCUT_ACTION_QUICK_FILTER, "target": " 百度翻译 " }
        ]);
        let parsed = parse_shortcut_bindings_strict(&raw).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[1].target.as_deref(), Some("百度翻译"));

        // 序列化往返一致（settings.json 读写）
        let values: Vec<serde_json::Value> = parsed.iter().map(|b| b.to_value()).collect();
        assert_eq!(
            parse_shortcut_bindings(&serde_json::Value::Array(values)),
            parsed
        );

        // to_value 的字段形态（前端按这些字段名解析）
        let b = ShortcutBinding {
            shortcut: "alt+f".into(),
            action: SHORTCUT_ACTION_QUICK_FILTER.into(),
            target: Some("百度翻译".into()),
        };
        assert_eq!(
            b.to_value(),
            serde_json::json!({
                "shortcut": "alt+f",
                "action": "quick-filter",
                "target": "百度翻译",
            })
        );
    }

    /// 「快捷打开项」绑定必须带匹配文本，并原样保留（含空格 AND 的多个词）。
    #[test]
    fn quick_open_binding_requires_target() {
        use super::{
            parse_shortcut_bindings, parse_shortcut_bindings_strict, ShortcutBinding,
            SHORTCUT_ACTION_QUICK_OPEN, SHORTCUT_ACTION_TOGGLE_WINDOW,
        };

        // 缺匹配文本 → 拒绝（否则按下去不知道该找哪一项）
        assert!(parse_shortcut_bindings_strict(&serde_json::json!([
            { "shortcut": "alt+o", "action": SHORTCUT_ACTION_QUICK_OPEN }
        ]))
        .is_err());

        // 带匹配文本 → 通过；两侧空白裁掉，内部空格（AND 语义）保留
        let raw = serde_json::json!([
            { "shortcut": "ctrl+alt+s", "action": SHORTCUT_ACTION_TOGGLE_WINDOW },
            { "shortcut": "alt+o", "action": SHORTCUT_ACTION_QUICK_OPEN, "target": "  百度 翻译 " }
        ]);
        let parsed = parse_shortcut_bindings_strict(&raw).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[1].target.as_deref(), Some("百度 翻译"));

        // 序列化往返一致
        let values: Vec<serde_json::Value> = parsed.iter().map(|b| b.to_value()).collect();
        assert_eq!(
            parse_shortcut_bindings(&serde_json::Value::Array(values)),
            parsed
        );

        // to_value 的字段形态
        let b = ShortcutBinding {
            shortcut: "alt+o".into(),
            action: SHORTCUT_ACTION_QUICK_OPEN.into(),
            target: Some("百度翻译".into()),
        };
        assert_eq!(
            b.to_value(),
            serde_json::json!({
                "shortcut": "alt+o",
                "action": "quick-open",
                "target": "百度翻译",
            })
        );
    }

    #[test]
    fn autostart_defaults_to_enabled() {
        // 产品规则：默认开机自启（安装后即随系统登录启动），用户在设置里可关闭。
        assert!(super::DEFAULT_AUTOSTART_ENABLED);
    }

    /// 备份归档：路径安全校验（zip-slip 之外，Rust 侧还要挡住绝对路径与盘符）
    #[test]
    fn backup_rejects_unsafe_paths() {
        use super::backup::is_safe_relative_public;
        for bad in ["", "../x", "a/../../b", "/etc/passwd", "C:/x", "\\\\server\\share", "a\0b"] {
            assert!(!is_safe_relative_public(bad), "应拒绝: {bad}");
        }
        for good in ["a.txt", "plugins/com.a.b/plugin.json", "plugin-data/com.a.b/db.sqlite"] {
            assert!(is_safe_relative_public(good), "应接受: {good}");
        }
    }

    /// 归档往返：打包 → 预览 → 条目内容一致（不依赖 AppHandle 的部分）
    #[test]
    fn backup_archive_round_trips() {
        use super::backup::{build_archive_from_parts, inspect_archive};
        let local = serde_json::json!({
            "subscribes": "<tis::https://example.com/a.ms />",
            "ITEM_WEIGHT_CACHE_KEY": { "abc": 3 },
        });
        let settings = serde_json::json!({ "autostart_enabled": true });
        let files: Vec<(String, Vec<u8>)> = vec![
            ("plugins/com.demo/plugin.json".into(), br#"{"id":"com.demo"}"#.to_vec()),
            ("plugin-data/com.demo/db.bin".into(), vec![1, 2, 3, 4]),
        ];
        let bytes = build_archive_from_parts(local.clone(), settings.clone(), files, "9.9.9").unwrap();
        let info = inspect_archive(&bytes).unwrap();
        assert_eq!(info["formatVersion"], 1);
        assert_eq!(info["appVersion"], "9.9.9");
        assert_eq!(info["localStorageKeys"], 2);
        assert_eq!(info["pluginIds"][0], "com.demo");
        assert_eq!(info["hasPlugins"], true);
        assert_eq!(info["hasPluginData"], true);
        // 同一份数据再解出来必须一模一样（还原路径读取的正是这些条目）
        let entries = super::backup::read_archive_public(&bytes).unwrap();
        let restored: serde_json::Value =
            serde_json::from_slice(&entries["state/local-storage.json"]).unwrap();
        assert_eq!(restored, local);
        let restored_settings: serde_json::Value =
            serde_json::from_slice(&entries["state/settings.json"]).unwrap();
        assert_eq!(restored_settings, settings);
        assert_eq!(entries["plugin-data/com.demo/db.bin"], vec![1u8, 2, 3, 4]);
    }

    /// 拒绝「不是备份包」的文件，避免用户选错文件时给出莫名其妙的报错
    #[test]
    fn backup_inspect_rejects_foreign_zip() {
        use super::backup::inspect_archive;
        let mut buf = Vec::new();
        {
            let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            use std::io::Write;
            let opts: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
            w.start_file("random.txt", opts).unwrap();
            w.write_all(b"hello").unwrap();
            w.finish().unwrap();
        }
        let err = inspect_archive(&buf).unwrap_err();
        assert!(err.contains("不是「我的搜索」的备份归档"), "实际: {err}");
    }

/// HTTP 日期解析（WebDAV 的 Last-Modified）
    #[test]
    fn parses_remote_timestamps() {
        use super::cloud::parse_http_date_public;
        // RFC 1123（WebDAV 的 Last-Modified）
        assert_eq!(parse_http_date_public("Wed, 21 Oct 2015 07:28:00 GMT"), 1445412480000);
        // 解析不出来返回 0（上层退化成「按版本号判断」），而不是 panic
        assert_eq!(parse_http_date_public("garbage"), 0);
    }

    /// 远端路径安全（用户可自定义远端文件名，不能让它跑到父目录）
    #[test]
    fn sync_rejects_unsafe_remote_paths() {
        use super::cloud;
        assert!(!cloud::is_safe_remote_path_public("../x.msbackup"));
        assert!(!cloud::is_safe_remote_path_public("/abs.msbackup"));
        assert!(!cloud::is_safe_remote_path_public("https://evil/x"));
        assert!(cloud::is_safe_remote_path_public("my-search-backup.msbackup"));
        assert!(cloud::is_safe_remote_path_public("folder/backup.msbackup"));
    }

    #[test]
    fn autostart_pref_round_trips_through_json() {
        assert_eq!(serde_json::Value::Bool(false).as_bool(), Some(false));
        assert_eq!(serde_json::Value::Bool(true).as_bool(), Some(true));
        // 历史文件里缺键 / 类型不符时 as_bool() 返回 None，上层回落到默认值
        assert_eq!(serde_json::Value::String("true".into()).as_bool(), None);
    }

    #[test]
    fn parses_registered_exe_path_from_run_value() {
        use super::parse_autostart_exe;
        // auto-launch 在无参数时写成裸路径（可能带结尾空格）
        assert_eq!(
            parse_autostart_exe(r"C:\Users\a\AppData\Local\MySearch\my-search-desktop.exe "),
            r"C:\Users\a\AppData\Local\MySearch\my-search-desktop.exe"
        );
        // 带引号 + 参数
        assert_eq!(
            parse_autostart_exe(r#""C:\Program Files\MySearch\MySearch.exe" --from-autostart"#),
            r"C:\Program Files\MySearch\MySearch.exe"
        );
        // 带引号、无参数
        assert_eq!(
            parse_autostart_exe(r#""D:\a b\MySearch.exe""#),
            r"D:\a b\MySearch.exe"
        );
        // 不带引号 + 参数：截到 .exe 为止
        assert_eq!(
            parse_autostart_exe(r"D:\code\my-search-desktop\target\debug\my-search-desktop.exe --silent"),
            r"D:\code\my-search-desktop\target\debug\my-search-desktop.exe"
        );
        // 大小写不敏感（.EXE）
        assert_eq!(parse_autostart_exe(r"C:\X\App.EXE"), r"C:\X\App.EXE");
        // 完整路径里的 .exe 不会被误当参数起点，目录名含 .exe 的极端情况按最后一个切
        assert_eq!(
            parse_autostart_exe(r"C:\tools\foo.exe\packed.exe --x"),
            r"C:\tools\foo.exe\packed.exe"
        );
    }

    #[test]
    fn autostart_path_match_ignores_case_slash_and_args() {
        use super::autostart_path_matches;
        let current = r"D:\code\my-search-desktop\src-tauri\target\debug\my-search-desktop.exe";
        // 与注册表实际写入的形态一致（含结尾空格）
        assert!(autostart_path_matches(&format!("{current} "), current));
        // 大小写不同视为同一文件（Windows 路径大小写不敏感）
        assert!(autostart_path_matches(&current.to_uppercase(), current));
        // 正反斜杠等价
        assert!(autostart_path_matches(
            r"D:/code/my-search-desktop/src-tauri/target/debug/my-search-desktop.exe",
            current
        ));
        // 换了位置（旧 debug 路径 vs 新安装路径）必须判定为「不一致」→ 触发自愈
        assert!(!autostart_path_matches(
            r"C:\Program Files\MySearch\MySearch.exe",
            current
        ));
        // 同目录不同文件名不算一致
        assert!(!autostart_path_matches(
            r"D:\code\my-search-desktop\src-tauri\target\debug\other.exe",
            current
        ));
        // 空值不得误判为一致（否则自愈逻辑会跳过修复）
        assert!(!autostart_path_matches("", current));
        assert!(!autostart_path_matches(current, ""));
    }

    #[test]
    fn box_width_ratio_follows_original_media_queries() {
        // 还原油猴版 @media 分档：>1400 → 52%，>1200 → 60%，>800 → 70%，否则 80%
        use super::box_width_ratio;
        assert_eq!(box_width_ratio(2560.0), 0.52);
        assert_eq!(box_width_ratio(1920.0), 0.52);
        // 1400 落在下界（原脚本 min-width:1400.1 不命中）→ 60%
        assert_eq!(box_width_ratio(1400.0), 0.60);
        // 1400.1 命中 min-width:1400.1 → 52%
        assert_eq!(box_width_ratio(1400.1), 0.52);
        assert_eq!(box_width_ratio(1300.0), 0.60);
        // 1200 命中 max-width:1200 → 70%
        assert_eq!(box_width_ratio(1200.0), 0.70);
        assert_eq!(box_width_ratio(1000.0), 0.70);
        // 800 命中 max-width:800 → 80%
        assert_eq!(box_width_ratio(800.0), 0.80);
        assert_eq!(box_width_ratio(640.0), 0.80);
    }

    fn jsdelivr(url: &str) -> Option<String> {
        convert_raw_to_jsdelivr(url)
    }

    #[test]
    fn parses_refs_heads_form() {
        // 官方订阅使用的 refs/heads 形式
        assert_eq!(
            jsdelivr(
                "https://raw.githubusercontent.com/My-Search/official-subscribe/refs/heads/dev/only-system-index.ms"
            )
            .as_deref(),
            Some(
                "https://cdn.jsdelivr.net/gh/My-Search/official-subscribe@dev/only-system-index.ms"
            )
        );
    }

    #[test]
    fn parses_refs_tags_form() {
        assert_eq!(
            jsdelivr("https://raw.githubusercontent.com/o/r/refs/tags/v1.2.3/a/b.md").as_deref(),
            Some("https://cdn.jsdelivr.net/gh/o/r@v1.2.3/a/b.md")
        );
    }

    #[test]
    fn parses_root_level_file() {
        // 回归：owner/repo/branch/file（4 段，文件在仓库根目录）曾被误判为 None
        assert_eq!(
            jsdelivr("https://raw.githubusercontent.com/owner/repo/main/index.ms").as_deref(),
            Some("https://cdn.jsdelivr.net/gh/owner/repo@main/index.ms")
        );
    }

    #[test]
    fn parses_nested_path() {
        assert_eq!(
            jsdelivr("https://raw.githubusercontent.com/owner/repo/main/a/b/c.md").as_deref(),
            Some("https://cdn.jsdelivr.net/gh/owner/repo@main/a/b/c.md")
        );
    }

    #[test]
    fn keeps_non_ascii_path() {
        assert_eq!(
            jsdelivr("https://raw.githubusercontent.com/o/r/refs/heads/dev/系统数据项/ai-app.md")
                .as_deref(),
            Some("https://cdn.jsdelivr.net/gh/o/r@dev/系统数据项/ai-app.md")
        );
    }

    #[test]
    fn rejects_missing_file_path() {
        // 只有分支没有文件名：不能拼出 @refs/heads/dev 这类非法 CDN URL
        assert_eq!(jsdelivr("https://raw.githubusercontent.com/o/r/main"), None);
        assert_eq!(
            jsdelivr("https://raw.githubusercontent.com/o/r/refs/heads/dev"),
            None
        );
        assert_eq!(
            jsdelivr("https://raw.githubusercontent.com/o/r/refs/pull/1/head"),
            None
        );
    }

    #[test]
    fn rejects_foreign_host() {
        assert_eq!(jsdelivr("https://example.com/o/r/main/a.md"), None);
        assert_eq!(jsdelivr("https://api.github.com/repos/o/r"), None);
    }

    #[test]
    fn ignores_extra_slashes_and_trailing_whitespace_segments() {
        // 连续斜杠产生的空段不参与解析
        assert_eq!(
            jsdelivr("https://raw.githubusercontent.com/o/r//main/a.md").as_deref(),
            Some("https://cdn.jsdelivr.net/gh/o/r@main/a.md")
        );
    }

    #[test]
    fn api_url_matches_jsdelivr_parse() {
        assert_eq!(
            convert_raw_to_api("https://raw.githubusercontent.com/owner/repo/main/index.ms")
                .as_deref(),
            Some("https://api.github.com/repos/owner/repo/contents/index.ms?ref=main")
        );
        assert_eq!(
            convert_raw_to_api(
                "https://raw.githubusercontent.com/My-Search/official-subscribe/refs/heads/dev/系统数据项/ai-app.md"
            )
            .as_deref(),
            Some(
                "https://api.github.com/repos/My-Search/official-subscribe/contents/系统数据项/ai-app.md?ref=dev"
            )
        );
        assert_eq!(
            convert_raw_to_api("https://raw.githubusercontent.com/owner/repo/main"),
            None
        );
    }

    #[test]
    fn parse_tuple_is_consistent() {
        let (owner, repo, branch, path) = parse_raw_github_url(
            "https://raw.githubusercontent.com/o/r/refs/heads/main/a.md",
        )
        .unwrap();
        assert_eq!((owner, repo, branch, path.as_str()), ("o", "r", "main", "a.md"));
    }

}
