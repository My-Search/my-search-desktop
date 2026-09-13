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
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_store::StoreExt;

/// 全局快捷键组合：呼出/隐藏主窗口的**默认值**（用户可在「设置 → 快捷键设置」自定义，
/// 自定义值持久化在 settings.json，见 get_toggle_shortcut / set_toggle_shortcut）
const DEFAULT_TOGGLE_SHORTCUT: &str = "ctrl+alt+s";

/// 设置存储文件（tauri-plugin-store，位于应用数据目录）
const SETTINGS_STORE_FILE: &str = "settings.json";
/// 设置存储里「呼出/隐藏快捷键」的键名
const SETTINGS_KEY_TOGGLE_SHORTCUT: &str = "toggle_shortcut";

/// 主窗口每次显示时向前端广播的事件名（前端据此清理残留状态）
const EVENT_MAIN_WINDOW_SHOWN: &str = "my-search://main-window-shown";

/// 搜索框（含边框）高度，与前端 BOX_HEIGHT 保持一致。
/// 隐藏窗口时把窗口收回到这个高度，避免下次呼出时残留上一次的高窗口（下面空一大块）。
/// 48 = 2(上边框)+44(#searchBox)+2(下边框)，缩放下取整对称、上下灰边等厚。
const COLLAPSED_WINDOW_HEIGHT: f64 = 48.0;

/// 主窗口失焦时是否自动隐藏（前端通过 `set_hide_on_blur` 同步）。
///
/// 取值对应油猴版 `showView()` 里输入框 blur 的判定：
/// 等待搜索，以及**结果列表展示中**都隐藏（结果列表失焦收起是桌面版相对原版的调整）；
/// 显示简述内容、附加内容、脚本应用（脚本视图）等详情视图，
/// 以及搜索进行中、`:debug` 模式都不隐藏。
/// 详见 README「失焦隐藏」与 `src/lib/util.js` 的 `shouldHideOnBlur()`。
/// 初值 true：前端尚未同步时保持旧版行为（失焦即隐藏），
/// 避免出现「窗口置顶且怎么点都不消失」的最坏情况。
#[derive(Debug)]
struct BlurHideState(AtomicBool);

impl Default for BlurHideState {
    fn default() -> Self {
        Self(AtomicBool::new(true))
    }
}

/// 写入「失焦是否自动隐藏」标志（命令与窗口显示复位共用）
fn set_hide_on_blur_flag(app: &tauri::AppHandle, hide: bool) {
    app.state::<BlurHideState>()
        .0
        .store(hide, Ordering::Relaxed);
}

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
fn position_window_top_center(window: &tauri::WebviewWindow) {
    let Some(monitor) = target_monitor(window) else {
        let _ = window.center();
        return;
    };
    let screen = monitor.size();
    let origin = monitor.position();
    let Ok(size) = window.outer_size() else {
        return;
    };
    // 考虑显示器自身偏移，保证多显示器下也居中于所在屏幕
    let x = origin.x + ((screen.width.saturating_sub(size.width)) / 2) as i32;
    let y = origin.y
        + ((screen.height as f64 * 0.22) as u32).min(screen.height.saturating_sub(size.height))
            as i32;
    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
}

/// 悬浮窗呼出/隐藏切换
fn toggle_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            collapse_main_window(&window);
            let _ = window.hide();
        } else {
            // 每次显示都把「失焦隐藏」复位为允许：
            // 前端收到 EVENT_MAIN_WINDOW_SHOWN 后会复位视图并重新同步真实状态，
            // 这样即使前端因异常未能同步，也不会出现「置顶窗口怎么点都不消失」。
            set_hide_on_blur_flag(app, true);
            // 呼出：先定位到屏幕偏上的居中位置，再显示并聚焦
            position_window_top_center(&window);
            let _ = window.show();
            let _ = window.set_focus();
            // 通知前端：窗口重新显示（前端据此复位残留的详情/结果视图与高度，
            // 避免“上次搜过之后再次呼出，下面空着一大块”的问题；
            // 输入框内容属于用户会话，前端会保留并重新触发搜索）
            let _ = app.emit(EVENT_MAIN_WINDOW_SHOWN, ());
        }
    }
}

/// 持有当前已注册的快捷键字符串，便于切换时先 unregister。
struct ActiveShortcutState(Mutex<Option<String>>);

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

/// 从 settings store 中读取「切换窗口快捷键」字符串，无自定义或读取失败时返回默认值
fn read_toggle_shortcut(app: &tauri::AppHandle) -> String {
    settings_store(app)
        .and_then(|store| {
            store
                .get(SETTINGS_KEY_TOGGLE_SHORTCUT)
                .and_then(|v| v.as_str().map(|s| s.to_string()))
        })
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_TOGGLE_SHORTCUT.to_string())
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

/// 注册（或重新注册）呼出/隐藏快捷键。
///
/// - 先 unregister 旧键（如果有），再注册新键。
/// - 注册成功后更新 `ActiveShortcutState` 记录当前键值。
/// - 新键注册失败时**回滚**：优先恢复旧键（保证「改动失败 = 一切保持原样」），
///   旧键也恢复不了时兜底注册默认键，保证呼出功能始终可用。
fn register_toggle_shortcut<S: AsRef<str>>(
    app: &tauri::AppHandle,
    shortcut_str: S,
) -> Result<(), String> {
    let shortcut = shortcut_str.as_ref().trim().to_string();
    // 插件 API 只接受 &str（TryFrom<&str>），先在这里校验字符串可解析
    if let Err(e) = tauri_plugin_global_shortcut::Shortcut::try_from(shortcut.as_str()) {
        return Err(format!("无法识别的快捷键「{shortcut}」: {e}"));
    }

    let gs = app.global_shortcut();
    let state = app.state::<ActiveShortcutState>();

    // 先 unregister 旧键（记录下来，注册失败时用于回滚）
    let old = match state.0.lock() {
        Ok(mut guard) => guard.take(),
        Err(_) => None,
    };
    if let Some(old) = &old {
        let _ = gs.unregister(old.as_str());
    }

    match gs.on_shortcut(shortcut.as_str(), |app, _s, event| {
        if event.state() == ShortcutState::Pressed {
            toggle_window(app);
        }
    }) {
        Ok(()) => {
            if let Ok(mut guard) = state.0.lock() {
                *guard = Some(shortcut);
            }
            Ok(())
        }
        Err(e) => {
            // 回滚：优先恢复旧键；旧键恢复失败再兜底默认键
            let restore = old.clone().unwrap_or_else(|| DEFAULT_TOGGLE_SHORTCUT.to_string());
            let mut restored = gs
                .on_shortcut(restore.as_str(), |app, _s, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_window(app);
                    }
                })
                .is_ok();
            if !restored && restore != DEFAULT_TOGGLE_SHORTCUT {
                // 旧键也被占用等异常情况：最后尝试默认键
                restored = gs
                    .on_shortcut(DEFAULT_TOGGLE_SHORTCUT, |app, _s, event| {
                        if event.state() == ShortcutState::Pressed {
                            toggle_window(app);
                        }
                    })
                    .is_ok();
            }
            if restored {
                if let Ok(mut guard) = state.0.lock() {
                    *guard = Some(restore);
                }
            }
            Err(format!("快捷键注册失败（可能已被其它程序占用）: {e}"))
        }
    }
}

// ===================== HTTP 代理（多级回退） =====================
fn build_client(timeout_secs: u64, ua: &str) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(ua)
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| e.to_string())
}

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 MySearchDesktop/7.9.12";

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

/// 同步「主窗口失焦时是否自动隐藏」。
///
/// 前端按当前视图状态计算后调用（见 src/main.js 的 syncBlurHide，
/// 规则见 README「失焦隐藏」）：等待搜索 / 结果列表展示中可隐藏；
/// 查看简述内容 / 附加内容 / 脚本应用、搜索进行中都不隐藏。
#[tauri::command]
fn set_hide_on_blur(app: tauri::AppHandle, hide: bool) {
    set_hide_on_blur_flag(&app, hide);
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
/// 窗口宽度约束：最小 320px，最大 720px，且不超过屏幕宽度的 90%
const MIN_WINDOW_WIDTH: f64 = 320.0;
const MAX_WINDOW_WIDTH: f64 = 720.0;
const MAX_SCREEN_WIDTH_RATIO: f64 = 0.9;

fn clamp_window_width(window: &tauri::WebviewWindow) -> f64 {
    let current = window.outer_size().unwrap_or_default().width as f64;
    let mut max = MAX_WINDOW_WIDTH;
    if let Some(monitor) = window.current_monitor().unwrap_or(None) {
        let screen_w = monitor.size().width as f64;
        max = max.min(screen_w * MAX_SCREEN_WIDTH_RATIO);
    }
    current.clamp(MIN_WINDOW_WIDTH, max)
}

/// 调整主窗口尺寸（前端根据结果数量动态展开/收起，高度可变、宽度受约束）
#[tauri::command]
fn set_window_height(app: tauri::AppHandle, height: f64) {
    if let Some(window) = app.get_webview_window("main") {
        let width = clamp_window_width(&window);
        let _ = window.set_size(tauri::LogicalSize::new(width, height));
    }
}

/// 把主窗口收回到搜索框高度（隐藏时调用，避免下次呼出残留上次的高窗口）
fn collapse_main_window(window: &tauri::WebviewWindow) {
    let width = clamp_window_width(window);
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
#[tauri::command]
fn open_config_window(app: tauri::AppHandle) {
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

/// 获取默认订阅（内置官方订阅原文本，与油猴版一致）
#[tauri::command]
fn get_default_subscribe_text() -> String {
    "<tis::https://raw.githubusercontent.com/My-Search/official-subscribe/refs/heads/dev/only-system-index.ms title=\"官方订阅-系统项\" describe=\"我的搜索官方内置订阅的系统项部分，含内置的应用与系统项\" />\n<tis::https://raw.githubusercontent.com/My-Search/official-subscribe/refs/heads/dev/index.ms title=\"官方作者zhuangjie订阅-小庄的收藏室\" describe=\"我的搜索官方内置订阅之作者zhuangjie订阅，收藏了一些实用的软件、网站、教程\" />"
        .to_string()
}

/// 获取当前「呼出/隐藏快捷键」字符串（从 settings store 读取，无自定义则返回默认值）
#[tauri::command]
fn get_toggle_shortcut(app: tauri::AppHandle) -> String {
    read_toggle_shortcut(&app)
}

/// 设置「呼出/隐藏快捷键」并立即生效。
///
/// - 解析 `shortcut` 字符串合法性（由 global-hotkey 校验，支持的格式如 "ctrl+alt+s"）。
/// - 解析成功 → unregister 旧键 → register 新键。
/// - 注册成功 → 持久化到 settings store → save()。
/// - 注册失败 → 恢复旧键（或默认键），返回错误信息。
#[tauri::command]
fn set_toggle_shortcut(app: tauri::AppHandle, shortcut: String) -> Result<(), String> {
    let trimmed = shortcut.trim().to_string();
    if trimmed.is_empty() {
        return Err("快捷键不能为空".into());
    }

    // 检查是否和当前已注册的一致
    let current = read_toggle_shortcut(&app);
    if current == trimmed {
        return Ok(());
    }

    // 校验字符串可被 global-hotkey 解析（试注册再撤销，以实际注册结果为准）
    // 直接用 register_toggle_shortcut — 它会先 unregister 再注册新键
    register_toggle_shortcut(&app, &trimmed)?;

    // 持久化（注册成功后才写 store；store 不可用时本次生效但不记忆，重启后回默认值）
    if let Some(store) = settings_store(&app) {
        store.set(SETTINGS_KEY_TOGGLE_SHORTCUT, serde_json::Value::String(trimmed));
        store.save().map_err(|e| format!("保存设置失败: {e}"))?;
    }

    Ok(())
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
                open_config_window(app.clone());
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
        .manage(BlurHideState::default())
        .manage(ActiveShortcutState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            http_get,
            http_request,
            set_window_height,
            set_hide_on_blur,
            open_url,
            quit_app,
            open_config_window,
            get_default_subscribe_text,
            get_toggle_shortcut,
            set_toggle_shortcut,
        ])
        .setup(|app| {
            // 主窗口使用固定 WebView 数据目录（localStorage 持久化）
            if let Some(main) = app.get_webview_window("main") {
                // 初始定位（尚未显示，位置会在呼出时再次更新）
                position_window_top_center(&main);
            }
            // 读取自定义快捷键（无自定义则用默认值），注册
            let shortcut = read_toggle_shortcut(app.handle());
            if let Err(e) = register_toggle_shortcut(app.handle(), &shortcut) {
                eprintln!("注册全局快捷键失败: {e}");
            }
            setup_tray(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // 主窗口失焦时是否自动隐藏由前端决定（失焦事件在 Rust 侧才会收到）——
            // 「等待搜索」与「结果列表展示中」（含无结果提示）会隐藏，
            // 查看简述内容 / 附加内容 / 脚本应用等详情视图不会隐藏，
            // 窗口需要用户自己按 Esc 或全局快捷键（默认 Ctrl+Alt+S，可自定义）收起。
            if window.label() != "main" {
                return;
            }
            let tauri::WindowEvent::Focused(false) = event else {
                return;
            };
            let app = window.app_handle();
            if !app.state::<BlurHideState>().0.load(Ordering::Relaxed) {
                return;
            }
            // 隐藏时把窗口收回到搜索框高度，
            // 这样下次呼出不会残留上一次搜索时的高窗口（下方空一大块）
            if let Some(main) = app.get_webview_window("main") {
                collapse_main_window(&main);
            }
            let _ = window.hide();
        })
        .run(tauri::generate_context!())
        .expect("运行我的搜索桌面版失败");
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
