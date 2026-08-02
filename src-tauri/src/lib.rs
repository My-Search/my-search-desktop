//! 我的搜索桌面版 - Tauri 后端
//!
//! 功能：
//! - 全局快捷键 Ctrl+Alt+S 呼出/隐藏悬浮搜索窗
//! - 悬浮窗：无边框、置顶、透明背景、跳过任务栏
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
            // 呼出时居中显示并聚焦
            let _ = window.center();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
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
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0 Safari/537.36 MySearchDesktop/7.9.5")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    // 尝试直接请求
    match client.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => {
            return resp.text().await.map_err(|e| e.to_string());
        }
        _ => {}
    }

    // raw.githubusercontent.com 失败时回退到 GitHub API
    if url.contains("raw.githubusercontent.com/") {
        let api_url = convert_raw_to_api(&url);
        if let Some(api_url) = api_url {
            let resp = client
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
    Err("请求失败".into())
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

/// 调整主窗口高度（前端根据结果数量动态展开/收起）
#[tauri::command]
fn set_window_height(app: tauri::AppHandle, height: f64) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_size(tauri::LogicalSize::new(window.outer_size().unwrap_or_default().width as f64, height));
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
            get_default_subscribes,
        ])
        .setup(|app| {
            // 注册全局快捷键
            register_global_shortcut(app.handle());
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
