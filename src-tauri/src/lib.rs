//! 我的搜索桌面版 - Tauri 后端
//!
//! 功能：
//! - 全局快捷键 Ctrl+Alt+S 呼出/隐藏悬浮搜索窗
//! - 悬浮窗：无边框、置顶、白底、跳过任务栏
//! - 系统托盘：显示/隐藏、退出
//! - 通过 Tauri command 向 WebView 提供 HTTP 代理（订阅拉取，绕开 CORS）
//! - 订阅/配置存储（JSON 文件，基于 tauri-plugin-store）

use serde::{Deserialize, Serialize};
use tauri::Manager;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// 全局快捷键组合：Ctrl+Alt+S
const TOGGLE_SHORTCUT: &str = "ctrl+alt+s";

/// 订阅条目（tis 标签解析结果）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubscribeItem {
    pub url: String,
    pub title: Option<String>,
    pub describe: Option<String>,
    pub fetch_fun: Option<String>,
    pub default_tag: Option<String>,
}

/// 应用配置
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppConfig {
    /// 订阅列表
    pub subscribes: Vec<SubscribeItem>,
    /// 是否开机自启（预留）
    pub auto_start: Option<bool>,
}

/// 悬浮窗呼出/隐藏切换
fn toggle_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            // 呼出时显示并聚焦：左右居中、上下偏上（屏幕高度约 1/4 处）
            position_window_top_center(&window);
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

/// 将窗口定位到当前屏幕的顶部居中位置（y 约屏幕高度的 22%）
fn position_window_top_center(window: &tauri::WebviewWindow) {
    let Ok(Some(monitor)) = window.current_monitor() else {
        let _ = window.center();
        return;
    };
    let screen = monitor.size();
    let Ok(size) = window.outer_size() else {
        return;
    };
    let x = ((screen.width.saturating_sub(size.width)) / 2) as i32;
    let y = ((screen.height as f64 * 0.22) as u32).min(screen.height.saturating_sub(size.height)) as i32;
    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
}

/// 注册全局快捷键
fn register_global_shortcut(app: &tauri::AppHandle) {
    if let Err(e) = app.global_shortcut().on_shortcut(TOGGLE_SHORTCUT, |app, _shortcut, event| {
        if event.state() == ShortcutState::Pressed {
            toggle_window(app);
        }
    }) {
        eprintln!("注册全局快捷键失败: {e}");
    }
}

/// HTTP GET 代理：供前端拉取订阅内容（绕开 CORS）
/// 当 raw.githubusercontent.com 直连失败时，自动回退到 GitHub API（api.github.com）
#[tauri::command]
async fn http_get(url: String) -> Result<String, String> {
    // 直连客户端：短超时（3s），失败快速回退
    let direct_client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0 Safari/537.36 MySearchDesktop/7.9.7")
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;

    // 尝试直接请求（3 秒超时）
    match direct_client.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => {
            return resp.text().await.map_err(|e| e.to_string());
        }
        _ => {}
    }

    // raw.githubusercontent.com 失败时回退到 GitHub API（API 客户端超时放宽到 15s）
    if url.contains("raw.githubusercontent.com/") {
        if let Some(api_url) = convert_raw_to_api(&url) {
            let api_client = reqwest::Client::builder()
                .user_agent("Mozilla/5.0 MySearchDesktop/7.9.7")
                .timeout(std::time::Duration::from_secs(15))
                .build()
                .map_err(|e| e.to_string())?;
            let resp = api_client
                .get(&api_url)
                .send()
                .await
                .map_err(|e| format!("直连与API均失败: {e}"))?;
            if resp.status().is_success() {
                let json: serde_json::Value = resp
                    .json()
                    .await
                    .map_err(|e| format!("API响应解析失败: {e}"))?;
                if let Some(content) = json["content"].as_str() {
                    use base64::Engine;
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(content)
                        .map_err(|e| format!("base64解码失败: {e}"))?;
                    return String::from_utf8(bytes).map_err(|e| e.to_string());
                }
            }
        }
    }

    // raw.githubusercontent.com 再失败时回退到 jsDelivr CDN（国内可访问）
    if url.contains("raw.githubusercontent.com/") {
        if let Some(cdn_url) = convert_raw_to_jsdelivr(&url) {
            let cdn_client = reqwest::Client::builder()
                .user_agent("Mozilla/5.0 MySearchDesktop/7.9.10")
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .map_err(|e| e.to_string())?;
            if let Ok(resp) = cdn_client.get(&cdn_url).send().await {
                if resp.status().is_success() {
                    if let Ok(text) = resp.text().await {
                        return Ok(text);
                    }
                }
            }
        }
    }
    Err("请求失败".into())
}

/// 将 raw.githubusercontent.com URL 转换为 jsDelivr CDN URL
/// https://raw.githubusercontent.com/{owner}/{repo}/refs/heads/{branch}/{path}
/// https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}
/// -> https://cdn.jsdelivr.net/gh/{owner}/{repo}@{branch}/{path}
fn convert_raw_to_jsdelivr(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://raw.githubusercontent.com/")?;
    let parts: Vec<&str> = rest.split('/').collect();
    if parts.len() < 5 {
        return None;
    }
    let (owner, repo) = (parts[0], parts[1]);
    if parts[2] == "refs" && parts[3] == "heads" && parts.len() >= 6 {
        let branch = parts[4];
        let path = parts[5..].join("/");
        return Some(format!("https://cdn.jsdelivr.net/gh/{owner}/{repo}@{branch}/{path}"));
    }
    let branch = parts[2];
    let path = parts[3..].join("/");
    Some(format!("https://cdn.jsdelivr.net/gh/{owner}/{repo}@{branch}/{path}"))
}

/// 将 raw.githubusercontent.com URL 转换为 GitHub API URL
fn convert_raw_to_api(url: &str) -> Option<String> {
    // https://raw.githubusercontent.com/{owner}/{repo}/refs/heads/{branch}/{path}
    // 或 https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}
    // -> https://api.github.com/repos/{owner}/{repo}/contents/{path}?ref={branch}
    let rest = url.strip_prefix("https://raw.githubusercontent.com/")?;
    let parts: Vec<&str> = rest.split('/').collect();
    if parts.len() < 5 {
        return None;
    }
    let (owner, repo) = (parts[0], parts[1]);
    // refs/heads/{branch}/{path...} 形式
    if parts[2] == "refs" && parts[3] == "heads" && parts.len() >= 6 {
        let branch = parts[4];
        let path = parts[5..].join("/");
        return Some(format!(
            "https://api.github.com/repos/{owner}/{repo}/contents/{path}?ref={branch}"
        ));
    }
    // {branch}/{path...} 形式
    let branch = parts[2];
    let path = parts[3..].join("/");
    Some(format!(
        "https://api.github.com/repos/{owner}/{repo}/contents/{path}?ref={branch}"
    ))
}

/// 窗口宽度约束：最小 320px，最大 960px，且不超过屏幕宽度的 90%
const MIN_WINDOW_WIDTH: f64 = 320.0;
const MAX_WINDOW_WIDTH: f64 = 720.0;
const MAX_SCREEN_WIDTH_RATIO: f64 = 0.9;

/// 计算受约束后的窗口宽度
fn clamp_window_width(window: &tauri::WebviewWindow) -> f64 {
    let current = window.outer_size().unwrap_or_default().width as f64;
    let mut max = MAX_WINDOW_WIDTH;
    // 按当前所在显示器限制宽度占比（多显示器时取当前窗口所在屏）
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

/// 打开外部链接（默认浏览器）
#[tauri::command]
async fn open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())?;
    Ok(())
}

/// 应用退出
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// 打开独立配置窗口（订阅管理）
/// 已存在时聚焦，不存在时创建
#[tauri::command]
fn open_config_window(app: tauri::AppHandle) {
    use tauri::WebviewWindowBuilder;

    if let Some(win) = app.get_webview_window("config") {
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    let config_url = tauri::WebviewUrl::App("config.html".into());
    let result = WebviewWindowBuilder::new(&app, "config", config_url)
        .title("我的搜索 - 配置")
        .inner_size(560.0, 480.0)
        .min_inner_size(420.0, 320.0)
        .resizable(true)
        .center()
        .decorations(true)
        .visible(true)
        .build();
    if let Err(e) = result {
        eprintln!("创建配置窗口失败: {e}");
    }
}

/// 创建系统托盘：左键单击切换显示/隐藏，菜单提供显示/隐藏与退出
fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;

    let toggle = MenuItem::with_id(app, "toggle", "显示/隐藏", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &quit])?;

    let _tray = TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => toggle_window(app),
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
                toggle_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

/// 获取默认订阅（内置官方订阅）
#[tauri::command]
fn get_default_subscribes() -> Vec<SubscribeItem> {
    vec![
        SubscribeItem {
            url: "https://raw.githubusercontent.com/My-Search/official-subscribe/refs/heads/dev/only-system-index.ms".into(),
            title: Some("官方订阅-系统项".into()),
            describe: Some("我的搜索官方内置订阅的系统项部分，含内置的应用与系统项".into()),
            fetch_fun: None,
            default_tag: None,
        },
        SubscribeItem {
            url: "https://raw.githubusercontent.com/My-Search/official-subscribe/refs/heads/dev/index.ms".into(),
            title: Some("官方作者zhuangjie订阅-小庄的收藏室".into()),
            describe: Some("我的搜索官方内置订阅之作者zhuangjie订阅，收藏了一些实用的软件、网站、教程".into()),
            fetch_fun: None,
            default_tag: None,
        },
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            http_get,
            set_window_height,
            open_url,
            quit_app,
            open_config_window,
            get_default_subscribes,
        ])
        .setup(|app| {
            // 注册全局快捷键
            register_global_shortcut(app.handle());
            // 创建系统托盘（显示/隐藏、退出）
            setup_tray(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // 主窗口失焦时自动隐藏（悬浮窗行为）
            if window.label() == "main" {
                if let tauri::WindowEvent::Focused(false) = event {
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("运行我的搜索桌面版失败");
}
