//! 插件文件选择 / 保存（只处理用户通过系统对话框**显式选择**的文件）。
//!
//! 为什么单独一个模块：`file.read` 的既有语义是「只能读搜索框里附加的路径」，
//! 而上传功能需要读用户刚在「选择文件」对话框里挑中的文件。这里用一个
//! 带 TTL 的 `PICKED` 集合把「用户显式选择」这件事登记下来，`attachment_read`
//! 在原有附件集合之外额外放行这些路径——插件仍然拿不到任意本地文件。
//!
//! 保存走 `file.write` 权限 + 系统「另存为」对话框：插件只能提供建议文件名
//! 与内容，最终落盘路径由用户决定，宿主不接受调用方传路径。

use std::path::Path;
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use serde::Serialize;
use tauri_plugin_dialog::DialogExt;

use crate::plugin_host::require_grant;

/// 用户显式选择的文件在多长时间内可被插件读取（1 小时）。
const PICKED_TTL_MS: u64 = 60 * 60 * 1000;
/// 最多记住多少个已选文件（防止长期运行攒满）。
const MAX_PICKED: usize = 200;
/// 单次保存的内容上限（与 `attachment_read` 的 100MB 读上限区分开）。
const MAX_SAVE_BYTES: u64 = 256 * 1024 * 1024;

/// `plugin_pick_files` 的返回条目（只给元信息，内容仍由 `ms.input.readFile` 读）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedFile {
    pub path: String,
    pub name: String,
    pub size: u64,
}

/// 已选文件：路径 + 登记时刻（毫秒）。
static PICKED: LazyLock<Mutex<Vec<(String, u64)>>> = LazyLock::new(|| Mutex::new(Vec::new()));

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 路径归一化：统一正斜杠、去尾部斜杠；Windows 下忽略大小写。
fn norm_path(p: &str) -> String {
    let s = p.replace('\\', "/");
    let s = s.trim_end_matches('/');
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s.to_string()
    }
}

/// 该路径是否在 TTL 内被用户通过系统对话框显式选择过。
pub(crate) fn is_picked_file(path: &str) -> bool {
    let now = now_ms();
    let target = norm_path(path);
    let Ok(mut guard) = PICKED.lock() else {
        return false;
    };
    guard.retain(|(_, at)| now.saturating_sub(*at) <= PICKED_TTL_MS);
    guard.iter().any(|(p, _)| norm_path(p) == target)
}

fn remember_picked(path: &str) {
    let now = now_ms();
    let normalized = norm_path(path);
    if let Ok(mut guard) = PICKED.lock() {
        guard.retain(|(p, _)| norm_path(p) != normalized);
        guard.push((path.to_string(), now));
        while guard.len() > MAX_PICKED {
            guard.remove(0);
        }
    }
}

fn check_permission(plugin_id: &str, base: &str) -> Result<(), String> {
    require_grant(plugin_id, base).map(|_| ())
}

/// 文件名安全校验：只允许一个文件名，不允许路径分隔符 / 控制字符。
fn sanitize_file_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err("文件名不能为空".into());
    }
    if name.len() > 255 {
        return Err("文件名过长".into());
    }
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err("文件名不能包含路径分隔符".into());
    }
    if name == "." || name == ".." {
        return Err("非法文件名".into());
    }
    Ok(name.to_string())
}

/// 打开系统多选文件对话框，返回用户选中的文件元信息。
///
/// 权限：`file.read`。选中的路径会登记到 `PICKED`，之后插件可用
/// `ms.input.readFile(path)` 读取内容（仍受 100MB 单文件上限约束）。
#[tauri::command]
pub async fn plugin_pick_files(
    app: tauri::AppHandle,
    plugin_id: String,
) -> Result<Vec<PickedFile>, String> {
    check_permission(&plugin_id, "file.read")?;
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("选择要上传的文件")
            .blocking_pick_files()
    })
    .await
    .map_err(|e| format!("打开文件对话框失败: {e}"))?;

    let Some(paths) = picked else {
        return Ok(Vec::new()); // 用户取消
    };

    let mut out = Vec::new();
    for fp in paths {
        let path = fp
            .into_path()
            .map_err(|e| format!("选择路径不可用: {e}"))?;
        let meta = match std::fs::metadata(&path) {
            Ok(m) if m.is_file() => m,
            _ => continue,
        };
        let s = path.to_string_lossy().to_string();
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| s.clone());
        remember_picked(&s);
        out.push(PickedFile {
            path: s,
            name,
            size: meta.len(),
        });
    }
    Ok(out)
}

/// 打开系统「另存为」对话框并把 base64 内容写入用户选择的位置。
///
/// 权限：`file.write`。`file_name` 只是对话框里的建议名，最终路径由用户选择；
/// 宿主不接受插件直接传目标路径，避免被当成任意文件写入器。
#[tauri::command]
pub async fn plugin_save_file(
    app: tauri::AppHandle,
    plugin_id: String,
    file_name: String,
    data_base64: String,
) -> Result<Option<String>, String> {
    check_permission(&plugin_id, "file.write")?;
    let name = sanitize_file_name(&file_name)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("内容 base64 解码失败: {e}"))?;
    if bytes.len() as u64 > MAX_SAVE_BYTES {
        return Err(format!(
            "内容过大（上限 {} MB）",
            MAX_SAVE_BYTES / (1024 * 1024)
        ));
    }

    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("保存文件")
            .set_file_name(&name)
            .blocking_save_file()
    })
    .await
    .map_err(|e| format!("打开保存对话框失败: {e}"))?;

    let Some(fp) = picked else {
        return Ok(None); // 用户取消
    };
    let path = fp
        .into_path()
        .map_err(|e| format!("保存路径不可用: {e}"))?;
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !Path::new(parent).is_dir() {
            return Err(format!("目标目录不存在: {}", parent.display()));
        }
    }
    std::fs::write(&path, &bytes).map_err(|e| format!("写入文件失败: {e}"))?;
    Ok(Some(path.to_string_lossy().to_string()))
}
