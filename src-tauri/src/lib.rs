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

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_autostart::{AutoLaunchManager, ManagerExt as AutostartManagerExt};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_store::StoreExt;

mod backup;
mod cloud;
mod plugin_host;
mod plugin_watch;

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

/// 快捷键作用类型：呼出/隐藏搜索窗（默认，仅允许一条）
const SHORTCUT_ACTION_TOGGLE_WINDOW: &str = "toggle-window";
/// 快捷键作用类型：直接打开某个插件（作用对象 = 插件 id）
const SHORTCUT_ACTION_OPEN_PLUGIN: &str = "open-plugin";

/// 快捷键（open-plugin）触发时向主窗口广播的事件名，payload = { pluginId }
const EVENT_SHORTCUT_OPEN_PLUGIN: &str = "my-search://shortcut-open-plugin";

/// 设置存储里「开机自启动」用户偏好的键名
const SETTINGS_KEY_AUTOSTART_ENABLED: &str = "autostart_enabled";
/// 「开机自启动」默认值：安装后随系统登录自动启动，常驻托盘随叫随到，
/// 用户可在「设置 → 常规设置」里关闭。
const DEFAULT_AUTOSTART_ENABLED: bool = true;

/// 本次会话是否已经应用过「开机自启动」偏好。
/// 注册表等系统级写操作只在首次运行时做一次，之后启动不再重复写。
static AUTOSTART_APPLIED: AtomicBool = AtomicBool::new(false);

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
/// ```
#[derive(Debug, Clone, PartialEq)]
struct ShortcutBinding {
    /// 组合键字符串（小写、+ 连接、修饰键在前，如 "ctrl+alt+s"）
    shortcut: String,
    /// 作用类型：toggle-window / open-plugin
    action: String,
    /// 作用对象：open-plugin 时为插件 id，toggle-window 时为 None
    target: Option<String>,
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
        if action == SHORTCUT_ACTION_OPEN_PLUGIN && target.is_none() {
            // 缺少作用对象（插件 id）的绑定无法执行，直接丢弃
            return None;
        }
        Some(Self {
            shortcut,
            action,
            target,
        })
    }

    /// 序列化为 JSON（写 settings.json 用）
    fn to_value(&self) -> serde_json::Value {
        serde_json::json!({
            "shortcut": self.shortcut,
            "action": self.action,
            "target": self.target,
        })
    }
}

/// 是否是已知的快捷键作用类型
fn is_known_shortcut_action(action: &str) -> bool {
    action == SHORTCUT_ACTION_TOGGLE_WINDOW || action == SHORTCUT_ACTION_OPEN_PLUGIN
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
            format!("第 {no} 条快捷键不完整（需要「快捷键 + 作用类型」，打开插件还需要选择插件）")
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
/// 三种情况：
///   1. 存了绑定列表 → 原样解析（列表里可以没有 toggle-window，此时呼出键回落到默认值）；
///   2. 没存过绑定列表、但存过旧版单键 → 迁移成一条 toggle-window（只读，不写回）；
///   3. 什么都没存（首次运行）→ 一条默认的 toggle-window。
fn read_shortcut_bindings(app: &tauri::AppHandle) -> Vec<ShortcutBinding> {
    let Some(store) = settings_store(app) else {
        return vec![ShortcutBinding {
            shortcut: DEFAULT_TOGGLE_SHORTCUT.to_string(),
            action: SHORTCUT_ACTION_TOGGLE_WINDOW.to_string(),
            target: None,
        }];
    };
    if let Some(value) = store.get(SETTINGS_KEY_SHORTCUT_BINDINGS) {
        return parse_shortcut_bindings(&value);
    }
    // 旧版单键迁移：把「呼出/隐藏」变成一条绑定
    let legacy = store
        .get(SETTINGS_KEY_TOGGLE_SHORTCUT)
        .and_then(|v| v.as_str().map(|s| s.trim().to_string()))
        .filter(|s| !s.is_empty());
    vec![ShortcutBinding {
        shortcut: legacy.unwrap_or_else(|| DEFAULT_TOGGLE_SHORTCUT.to_string()),
        action: SHORTCUT_ACTION_TOGGLE_WINDOW.to_string(),
        target: None,
    }]
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
/// 每个键的 handler 按「作用类型」分发：呼出/隐藏窗口，或直接打开某个插件。
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
pub(crate) fn build_client(timeout_secs: u64, ua: &str) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(ua)
        .timeout(std::time::Duration::from_secs(timeout_secs))
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

/// 把主窗口收回到搜索框高度（隐藏时调用，避免下次呼出残留上次的高窗口）
fn collapse_main_window(window: &tauri::WebviewWindow) {
    let width = window_width_for(window);
    let _ = window.set_size(tauri::LogicalSize::new(width, COLLAPSED_WINDOW_HEIGHT));
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

    if let Some(win) = app.get_webview_window("config") {
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }

    // 按系统当前深浅色给 WebView 铺一层同色底：
    // 页面首帧渲染前（HTML/JS 尚未执行）露出的是 WebView 自身的背景色，
    // 默认是白色，会在深色系统下造成「先白一下再变深色」的闪白。
    // 这里取主窗口的系统主题决定底色，与 config.html 内联脚本 / CSS 变量保持一致。
    let is_dark = app
        .get_webview_window("main")
        .and_then(|w| w.theme().ok())
        .map(|t| matches!(t, tauri::Theme::Dark))
        .unwrap_or(false);
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
    let builder = WebviewWindowBuilder::new(&app, "config", config_url)
        .disable_drag_drop_handler()
        .title("我的搜索 - 设置")
        // 设置窗口：横向布局（左菜单 + 右内容），宽度明显大于高度
        .inner_size(880.0, 600.0)
        .min_inner_size(600.0, 420.0)
        .resizable(true)
        .center()
        .decorations(true)
        .background_color(background)
        .visible(true);
    if let Err(e) = builder.build() {
        eprintln!("创建配置窗口失败: {e}");
    }
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
    apply_shortcut_bindings(&app, &parsed)
}

/// 注册整套绑定并持久化（注册失败时回滚且不落盘）。
fn apply_shortcut_bindings(app: &tauri::AppHandle, bindings: &[ShortcutBinding]) -> Result<(), String> {
    register_shortcut_bindings(app, bindings)?;
    write_shortcut_bindings(app, bindings);
    Ok(())
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
            open_url,
            quit_app,
            open_config_window,
            get_default_subscribe_text,
            get_toggle_shortcut,
            set_toggle_shortcut,
            get_shortcut_bindings,
            set_shortcut_bindings,
            get_autostart_enabled,
            set_autostart_enabled_cmd,
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
            // 主窗口使用固定 WebView 数据目录（localStorage 持久化）
            if let Some(main) = app.get_webview_window("main") {
                // 初始定宽与定位（尚未显示，真正呼出时会按当时所在屏幕再算一次）
                if let Some(monitor) = target_monitor(&main) {
                    let width = target_window_width(&monitor);
                    let _ = main.set_size(tauri::LogicalSize::new(width, COLLAPSED_WINDOW_HEIGHT));
                    position_window_top_center(&main, &monitor, width);
                }
            }
            // 读取自定义快捷键绑定（无自定义则用默认呼出键），逐条注册
            let bindings = read_shortcut_bindings(app.handle());
            if let Err(e) = register_shortcut_bindings(app.handle(), &bindings) {
                eprintln!("注册全局快捷键失败: {e}");
            }
            apply_autostart_preference(app.handle());
            // 插件后台进程：只拉起「开机自启」已开启的插件（其它按需启动）
            plugin_host::autostart_enabled_backends(app.handle());
            setup_tray(app.handle())?;
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
