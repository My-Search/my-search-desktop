//! WebDAV 凭据的落盘保护。
//!
//! 目标
//! ----
//! 密码不能以明文躺在用户目录里。Windows 用 DPAPI（`CryptProtectData`）做
//! 「当前用户 + 本机」绑定的加密；文件里只保存密文。DPAPI 由系统托管密钥，
//! 不需要应用自己生成/保管主密钥，也不会随备份或云同步外泄。
//!
//! 文件格式（`sync-credentials.json`）
//! ----------------------------------
//! ```json
//! { "v": 2, "cipher": "dpapi", "data": "<base64 密文>" }
//! ```
//! 旧版本是 `{ "password": "..." }` 明文。读取时兼容，并在下一次保存时
//! 自动升级为 v2；升级失败不会丢密码（旧文件仍在）。
//!
//! 非 Windows
//! ----------
//! 暂时保持「用户目录 + 0600」的回退（Unix 权限位），文件格式用
//! `{ "v": 2, "cipher": "plain", "password": "..." }`。这里不假装它是加密：
//! `cipher` 字段明确写出保护方式，后续接 macOS Keychain / Secret Service
//! 时只需增加一种 `cipher`，读取侧按 `cipher` 分派。

use std::path::{Path, PathBuf};

use base64::Engine;
use serde_json::json;
use tauri::{AppHandle, Manager};

const CREDENTIALS_FILE: &str = "sync-credentials.json";

/// DPAPI 的附加熵：把密文绑定到「这个应用的这份用途」。
///
/// 同一用户下的其它程序即使拿到密文，也无法直接解密；改动这个常量会让
/// 旧密文失效，因此它是**格式的一部分**，不能随手改。
#[cfg(windows)]
const DPAPI_ENTROPY: &[u8] = b"my-search-desktop:webdav-credentials:v2";

fn credentials_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("取应用数据目录失败: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {e}"))?;
    Ok(dir.join(CREDENTIALS_FILE))
}

/// 当前平台的静态保护方式。
fn platform_cipher() -> &'static str {
    if cfg!(windows) {
        "dpapi"
    } else {
        "plain"
    }
}

/// WebDAV 认证凭据（目前只有密码；用户名在 `sync-config.json` 里）。
#[derive(Debug, Clone, Default)]
pub(crate) struct Credentials {
    pub password: String,
}

pub(crate) fn load_credentials(app: &AppHandle) -> Credentials {
    Credentials {
        password: load_password(app),
    }
}

pub(crate) fn save_credentials(app: &AppHandle, creds: &Credentials) -> Result<(), String> {
    save_password(app, &creds.password)
}

/// 读取 WebDAV 密码。
///
/// 任何「读不到 / 解不开」都退化为空密码（面板显示「未设置」），不 panic：
/// 同步是后台能力，不能因为凭据文件损坏把应用启动打断。
pub(crate) fn load_password(app: &AppHandle) -> String {
    let Ok(path) = credentials_path(app) else {
        return String::new();
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return String::new();
    };
    let Ok(doc) = serde_json::from_str::<serde_json::Value>(&text) else {
        return String::new();
    };

    // 旧格式：`{ "password": "..." }`（没有 `v` 字段）。读出来后顺手升级，
    // 失败也不影响本次使用。
    let version = doc.get("v").and_then(|v| v.as_u64()).unwrap_or(0);
    if version == 0 {
        if let Some(password) = doc.get("password").and_then(|v| v.as_str()) {
            if !password.is_empty() {
                if let Err(e) = save_password(app, password) {
                    // 迁移失败至少留痕；旧明文文件还在，本次仍可用
                    eprintln!("[同步] WebDAV 凭据升级为 v2 失败（保留旧文件）: {e}");
                }
            }
            return password.to_string();
        }
    }

    let cipher = doc.get("cipher").and_then(|v| v.as_str()).unwrap_or("");
    let data = doc.get("data").and_then(|v| v.as_str()).unwrap_or("");
    if data.is_empty() {
        return String::new();
    }
    match cipher {
        "dpapi" => decrypt_dpapi(data).unwrap_or_else(|e| {
            eprintln!("[同步] 解密 WebDAV 凭据失败（将视为未设置）: {e}");
            String::new()
        }),
        "plain" => {
            // 非 Windows 的回退格式：密码直接放在 `password` 字段里，
            // `data` 为空。这里只是为了兼容未来可能出现的显式 plain 文件。
            doc.get("password")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        }
        other => {
            eprintln!("[同步] 未知的凭据保护方式 {other:?}（将视为未设置）");
            String::new()
        }
    }
}

/// 写入 WebDAV 密码。空密码表示「清除」。
pub(crate) fn save_password(app: &AppHandle, password: &str) -> Result<(), String> {
    let path = credentials_path(app)?;
    let cipher = platform_cipher();
    let doc = if cipher == "dpapi" {
        let blob = if password.is_empty() {
            String::new()
        } else {
            encrypt_dpapi(password)?
        };
        json!({ "v": 2, "cipher": "dpapi", "data": blob })
    } else {
        json!({ "v": 2, "cipher": "plain", "password": password })
    };
    std::fs::write(
        &path,
        serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("保存凭据失败: {e}"))?;
    restrict_permissions(&path);
    Ok(())
}

#[cfg(unix)]
fn restrict_permissions(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &std::path::Path) {
    // Windows 上真正的保护来自 DPAPI 密文；文件本身无需 ACL 调整。
}

// ===================== 插件密钥命名空间（P1-2） =====================
//
// 插件拿到的 API Key 不该落在 localStorage / 插件目录（都是明文，且会随
// 云同步/备份一起漂走）。这里按 `plugin-secrets/<pluginId>.json` 单独存放，
// 整份文件用与 WebDAV 同一套 DPAPI 保护，**密钥本身不出 Rust**：
// 前端只传名字，值由 `plugin_host` 的 command 读取后经 IPC 返回。

const PLUGIN_SECRETS_DIR: &str = "plugin-secrets";
/// 单个插件最多保存多少个密钥（防插件把文件当成无限数据库）
const MAX_PLUGIN_SECRETS: usize = 64;
/// 单个密钥名 / 值的长度上限
const MAX_SECRET_NAME: usize = 64;
const MAX_SECRET_VALUE: usize = 4096;

fn validate_secret_plugin_id(plugin_id: &str) -> Result<(), String> {
    if plugin_id.is_empty() || plugin_id.len() > 64 {
        return Err("插件 id 非法".into());
    }
    if !plugin_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
    {
        return Err("插件 id 含非法字符".into());
    }
    Ok(())
}

fn validate_secret_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > MAX_SECRET_NAME {
        return Err(format!("密钥名非法（1-{MAX_SECRET_NAME} 字）"));
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' || c == ':')
    {
        return Err("密钥名含非法字符（仅字母数字 . _ - :）".into());
    }
    Ok(())
}

fn plugin_secrets_path(app: &AppHandle, plugin_id: &str) -> Result<PathBuf, String> {
    validate_secret_plugin_id(plugin_id)?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("取应用数据目录失败: {e}"))?
        .join(PLUGIN_SECRETS_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {e}"))?;
    Ok(dir.join(format!("{plugin_id}.json")))
}

/// 读取某插件的全部密钥（解不开时返回空表，不让插件因凭据损坏崩掉）
pub(crate) fn load_plugin_secrets(
    app: &AppHandle,
    plugin_id: &str,
) -> std::collections::HashMap<String, String> {
    use std::collections::HashMap;
    let Ok(path) = plugin_secrets_path(app, plugin_id) else {
        return HashMap::new();
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return HashMap::new();
    };
    let Ok(doc) = serde_json::from_str::<serde_json::Value>(&text) else {
        return HashMap::new();
    };
    let cipher = doc.get("cipher").and_then(|v| v.as_str()).unwrap_or("");
    let entries_value = match cipher {
        "dpapi" => {
            let data = doc.get("data").and_then(|v| v.as_str()).unwrap_or("");
            if data.is_empty() {
                return HashMap::new();
            }
            match decrypt_dpapi(data) {
                Ok(json_text) => match serde_json::from_str::<serde_json::Value>(&json_text) {
                    Ok(v) => v,
                    Err(e) => {
                        eprintln!("[插件密钥] 解密后的内容不是 JSON（视为空）: {e}");
                        return HashMap::new();
                    }
                },
                Err(e) => {
                    eprintln!("[插件密钥] 解密失败（视为空）: {e}");
                    return HashMap::new();
                }
            }
        }
        "plain" => doc.get("entries").cloned().unwrap_or_else(|| json!({})),
        other => {
            eprintln!("[插件密钥] 未知的保护方式 {other:?}（视为空）");
            return HashMap::new();
        }
    };
    serde_json::from_value::<HashMap<String, String>>(entries_value).unwrap_or_default()
}

pub(crate) fn save_plugin_secrets(
    app: &AppHandle,
    plugin_id: &str,
    entries: &std::collections::HashMap<String, String>,
) -> Result<(), String> {
    if entries.len() > MAX_PLUGIN_SECRETS {
        return Err(format!("密钥数量超出上限（{MAX_PLUGIN_SECRETS} 个）"));
    }
    let path = plugin_secrets_path(app, plugin_id)?;
    let entries_json = serde_json::to_string(entries).map_err(|e| e.to_string())?;
    let cipher = platform_cipher();
    let doc = if cipher == "dpapi" {
        let blob = if entries.is_empty() {
            String::new()
        } else {
            encrypt_dpapi(&entries_json)?
        };
        json!({ "v": 2, "cipher": "dpapi", "data": blob })
    } else {
        json!({ "v": 2, "cipher": "plain", "entries": entries })
    };
    std::fs::write(
        &path,
        serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("保存插件密钥失败: {e}"))?;
    restrict_permissions(&path);
    Ok(())
}

pub(crate) fn read_plugin_secret(
    app: &AppHandle,
    plugin_id: &str,
    name: &str,
) -> Result<Option<String>, String> {
    validate_secret_name(name)?;
    Ok(load_plugin_secrets(app, plugin_id).get(name).cloned())
}

pub(crate) fn write_plugin_secret(
    app: &AppHandle,
    plugin_id: &str,
    name: &str,
    value: &str,
) -> Result<(), String> {
    validate_secret_name(name)?;
    if value.len() > MAX_SECRET_VALUE {
        return Err(format!("密钥内容过长（上限 {MAX_SECRET_VALUE} 字）"));
    }
    let mut entries = load_plugin_secrets(app, plugin_id);
    if !entries.contains_key(name) && entries.len() >= MAX_PLUGIN_SECRETS {
        return Err(format!("密钥数量超出上限（{MAX_PLUGIN_SECRETS} 个）"));
    }
    entries.insert(name.to_string(), value.to_string());
    save_plugin_secrets(app, plugin_id, &entries)
}

pub(crate) fn delete_plugin_secret(
    app: &AppHandle,
    plugin_id: &str,
    name: &str,
) -> Result<bool, String> {
    validate_secret_name(name)?;
    let mut entries = load_plugin_secrets(app, plugin_id);
    let removed = entries.remove(name).is_some();
    if removed {
        save_plugin_secrets(app, plugin_id, &entries)?;
    }
    Ok(removed)
}

// ===================== 宿主环境变量（P2-5） =====================
//
// 环境变量里常放 API Key（如 GITHUB_TOKEN），原先整份 JSON 落在 localStorage。
// 现在值只存这里（与插件密钥同一套 DPAPI），前端仅在内存里持有，用于向已授权
// 插件的后台进程注入；`ENV_VARS_CACHE_KEY` 不再含明文值。

const HOST_ENV_FILE: &str = "host-env.json";
const MAX_HOST_ENV: usize = 200;
const MAX_HOST_ENV_VALUE: usize = 8192;

fn validate_env_name(name: &str) -> Result<(), String> {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return Err("环境变量名非法（需以字母或下划线开头）".into()),
    }
    if name.len() > 128 || !chars.all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err("环境变量名非法（仅字母/数字/下划线）".into());
    }
    Ok(())
}

fn host_env_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("取应用数据目录失败: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {e}"))?;
    Ok(dir.join(HOST_ENV_FILE))
}

/// 读取宿主环境变量；文件不存在返回 `None`（用于区分「首次运行」与「空列表」）。
pub(crate) fn load_host_env(app: &AppHandle) -> Option<serde_json::Value> {
    let path = host_env_path(app).ok()?;
    let text = std::fs::read_to_string(path).ok()?;
    let doc = serde_json::from_str::<serde_json::Value>(&text).ok()?;
    let cipher = doc.get("cipher").and_then(|v| v.as_str()).unwrap_or("");
    match cipher {
        "dpapi" => {
            let data = doc.get("data").and_then(|v| v.as_str()).unwrap_or("");
            if data.is_empty() {
                return Some(json!([]));
            }
            match decrypt_dpapi(data) {
                Ok(text) => serde_json::from_str::<serde_json::Value>(&text).ok(),
                Err(e) => {
                    eprintln!("[环境变量] 解密失败（视为未设置）: {e}");
                    None
                }
            }
        }
        "plain" => doc.get("entries").cloned(),
        other => {
            eprintln!("[环境变量] 未知的保护方式 {other:?}（视为未设置）");
            None
        }
    }
}

pub(crate) fn save_host_env(
    app: &AppHandle,
    vars: &serde_json::Value,
    ) -> Result<(), String> {
    let arr = vars
        .as_array()
        .ok_or_else(|| "环境变量必须是数组".to_string())?;
    if arr.len() > MAX_HOST_ENV {
        return Err(format!("环境变量数量超出上限（{MAX_HOST_ENV} 个）"));
    }
    for item in arr {
        let obj = item
            .as_object()
            .ok_or_else(|| "环境变量项必须是对象".to_string())?;
        let name = obj.get("name").and_then(|v| v.as_str()).unwrap_or("");
        validate_env_name(name)?;
        let value = obj.get("value").and_then(|v| v.as_str()).unwrap_or("");
        if value.len() > MAX_HOST_ENV_VALUE {
            return Err(format!("环境变量 {name} 的值过长（上限 {MAX_HOST_ENV_VALUE} 字）"));
        }
    }
    let path = host_env_path(app)?;
    let json_text = serde_json::to_string(vars).map_err(|e| e.to_string())?;
    let cipher = platform_cipher();
    let doc = if cipher == "dpapi" {
        let blob = if arr.is_empty() {
            String::new()
        } else {
            encrypt_dpapi(&json_text)?
        };
        json!({ "v": 2, "cipher": "dpapi", "data": blob })
    } else {
        json!({ "v": 2, "cipher": "plain", "entries": vars })
    };
    std::fs::write(
        &path,
        serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("保存环境变量失败: {e}"))?;
    restrict_permissions(&path);
    Ok(())
}

// ===================== 插件网络凭据（P2-3，凭据不出 Rust） =====================
//
// 插件要访问带鉴权的 API 时，常见做法是把 token 存进 localStorage 再由前端
// 拼 `Authorization` 头——这等于把明文交给插件。这里改为：
//   1. 值只存本文件（DPAPI），插件只能拿到「名字」；
//   2. `plugin_net_fetch(credential: "name")` 由 Rust 在发请求前注入请求头，
//      插件既读不到值，也无法把凭据发到别的 origin（entry 绑定了 origin）。

const NET_CREDENTIALS_DIR: &str = "plugin-net-credentials";
const MAX_NET_CREDENTIALS: usize = 16;
const MAX_NET_CREDENTIAL_VALUE: usize = 8192;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub(crate) struct NetCredential {
    /// 绑定 origin（`https://host[:port]`，无尾斜杠）
    pub origin: String,
    /// bearer / basic / header
    pub scheme: String,
    /// scheme=header 时的头名
    #[serde(default)]
    pub header: Option<String>,
    /// scheme=basic 时的用户名
    #[serde(default)]
    pub username: Option<String>,
    /// 明文只在 Rust 内部可见
    pub value: String,
}

fn validate_net_credential_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 64 {
        return Err("凭据名非法（1-64 字）".into());
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' || c == ':')
    {
        return Err("凭据名含非法字符（仅字母数字 . _ - :）".into());
    }
    Ok(())
}

fn net_credentials_path(app: &AppHandle, plugin_id: &str) -> Result<PathBuf, String> {
    validate_secret_plugin_id(plugin_id)?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("取应用数据目录失败: {e}"))?
        .join(NET_CREDENTIALS_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {e}"))?;
    Ok(dir.join(format!("{plugin_id}.json")))
}

pub(crate) fn load_net_credentials(
    app: &AppHandle,
    plugin_id: &str,
) -> std::collections::HashMap<String, NetCredential> {
    use std::collections::HashMap;
    let Ok(path) = net_credentials_path(app, plugin_id) else {
        return HashMap::new();
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return HashMap::new();
    };
    let Ok(doc) = serde_json::from_str::<serde_json::Value>(&text) else {
        return HashMap::new();
    };
    let cipher = doc.get("cipher").and_then(|v| v.as_str()).unwrap_or("");
    let entries = match cipher {
        "dpapi" => {
            let data = doc.get("data").and_then(|v| v.as_str()).unwrap_or("");
            if data.is_empty() {
                return HashMap::new();
            }
            match decrypt_dpapi(data) {
                Ok(text) => serde_json::from_str::<serde_json::Value>(&text).unwrap_or_else(|_| json!({})),
                Err(e) => {
                    eprintln!("[网络凭据] 解密失败（视为空）: {e}");
                    return HashMap::new();
                }
            }
        }
        "plain" => doc.get("entries").cloned().unwrap_or_else(|| json!({})),
        _ => return HashMap::new(),
    };
    serde_json::from_value(entries).unwrap_or_default()
}

fn save_net_credentials(
    app: &AppHandle,
    plugin_id: &str,
    entries: &std::collections::HashMap<String, NetCredential>,
) -> Result<(), String> {
    let path = net_credentials_path(app, plugin_id)?;
    let entries_json = serde_json::to_string(entries).map_err(|e| e.to_string())?;
    let doc = if platform_cipher() == "dpapi" {
        let blob = if entries.is_empty() {
            String::new()
        } else {
            encrypt_dpapi(&entries_json)?
        };
        json!({ "v": 2, "cipher": "dpapi", "data": blob })
    } else {
        json!({ "v": 2, "cipher": "plain", "entries": entries })
    };
    std::fs::write(
        &path,
        serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("保存网络凭据失败: {e}"))?;
    restrict_permissions(&path);
    Ok(())
}

/// 写入 / 覆盖一条网络凭据（`value` 空串 = 删除）。
pub(crate) fn write_net_credential(
    app: &AppHandle,
    plugin_id: &str,
    name: &str,
    cred: NetCredential,
) -> Result<bool, String> {
    validate_net_credential_name(name)?;
    if cred.value.is_empty() {
        return delete_net_credential(app, plugin_id, name);
    }
    if cred.value.len() > MAX_NET_CREDENTIAL_VALUE {
        return Err(format!("凭据值过长（上限 {MAX_NET_CREDENTIAL_VALUE} 字）"));
    }
    let mut entries = load_net_credentials(app, plugin_id);
    if !entries.contains_key(name) && entries.len() >= MAX_NET_CREDENTIALS {
        return Err(format!("凭据数量超出上限（{MAX_NET_CREDENTIALS} 个）"));
    }
    entries.insert(name.to_string(), cred);
    save_net_credentials(app, plugin_id, &entries)?;
    Ok(true)
}

pub(crate) fn delete_net_credential(
    app: &AppHandle,
    plugin_id: &str,
    name: &str,
) -> Result<bool, String> {
    validate_net_credential_name(name)?;
    let mut entries = load_net_credentials(app, plugin_id);
    let removed = entries.remove(name).is_some();
    if removed {
        save_net_credentials(app, plugin_id, &entries)?;
    }
    Ok(removed)
}

/// 取一条凭据（仅供 `plugin_net_fetch` 在 Rust 内注入，**不暴露给前端**）。
pub(crate) fn resolve_net_credential(
    app: &AppHandle,
    plugin_id: &str,
    name: &str,
) -> Result<NetCredential, String> {
    validate_net_credential_name(name)?;
    load_net_credentials(app, plugin_id)
        .remove(name)
        .ok_or_else(|| format!("没有名为 {name} 的网络凭据"))
}

/// 生成要注入的请求头 `(name, value)`；basic 用 base64(user:value)。
pub(crate) fn credential_header(cred: &NetCredential) -> Result<(String, String), String> {
    match cred.scheme.as_str() {
        "bearer" => Ok(("authorization".into(), format!("Bearer {}", cred.value))),
        "basic" => {
            let user = cred.username.clone().unwrap_or_default();
            let raw = format!("{user}:{}", cred.value);
            Ok((
                "authorization".into(),
                format!(
                    "Basic {}",
                    base64::engine::general_purpose::STANDARD.encode(raw.as_bytes())
                ),
            ))
        }
        "header" => {
            let name = cred
                .header
                .clone()
                .ok_or_else(|| "header 型凭据缺少 header 名".to_string())?;
            if name.is_empty()
                || name.len() > 64
                || !name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-_.!#$%&'*+^`|~".contains(c))
            {
                return Err("凭据 header 名非法".into());
            }
            Ok((name.to_ascii_lowercase(), cred.value.clone()))
        }
        other => Err(format!("未知的凭据注入方式 {other:?}")),
    }
}

// ===================== 通用密封文件（网关快照等） =====================

/// 把一个 UTF-8 文件写成「平台保护」形态：
/// - Windows：整个内容 DPAPI 加密，文件里只有密文；
/// - 非 Windows：明确标注 `cipher: "plain"`（不假装加密，权限位 0600）。
///
/// 用于 `plugin-gateway.json` 这类**只由 Rust 读写、但可能含注入 env**的文件。
pub fn write_sealed_file(path: &Path, plain: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let cipher = platform_cipher();
    let doc = if cipher == "dpapi" {
        json!({ "v": 2, "cipher": "dpapi", "data": encrypt_dpapi(plain)? })
    } else {
        json!({ "v": 2, "cipher": "plain", "text": plain })
    };
    std::fs::write(path, serde_json::to_string(&doc).map_err(|e| e.to_string())?)
        .map_err(|e| format!("写入失败: {e}"))?;
    restrict_permissions(path);
    Ok(())
}

/// 读取 `write_sealed_file` 的产物；兼容历史上直接写 JSON 明文的旧文件。
///
/// 返回 `Ok(None)` 表示文件不存在；解析失败返回错误，由调用方决定降级。
pub fn read_sealed_file(path: &Path) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(path).map_err(|e| format!("读取失败: {e}"))?;
    let Ok(doc) = serde_json::from_str::<serde_json::Value>(&raw) else {
        // 不是 JSON：按旧明文文件原样返回
        return Ok(Some(raw));
    };
    let cipher = doc.get("cipher").and_then(|v| v.as_str()).unwrap_or("");
    if cipher.is_empty() {
        // 旧格式：整份就是业务 JSON，没有信封
        return Ok(Some(raw));
    }
    match cipher {
        "dpapi" => {
            let data = doc.get("data").and_then(|v| v.as_str()).unwrap_or("");
            Ok(Some(decrypt_dpapi(data)?))
        }
        "plain" => Ok(Some(
            doc.get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        )),
        other => Err(format!("未知的文件加密方式 {other:?}")),
    }
}

// ===================== Windows DPAPI =====================

#[cfg(windows)]
fn encrypt_dpapi(plain: &str) -> Result<String, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let bytes = plain.as_bytes();
    let entropy = DPAPI_ENTROPY;
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let entropy_blob = CRYPT_INTEGER_BLOB {
        cbData: entropy.len() as u32,
        pbData: entropy.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();

    // SAFETY: 输入缓冲区在调用期间有效；输出由 DPAPI 通过 LocalAlloc 分配，
    // 调用成功后立即拷贝并在下方 LocalFree 释放。
    let ok = unsafe {
        CryptProtectData(
            &input,
            std::ptr::null(),
            &entropy_blob,
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(format!("CryptProtectData 失败（错误码 {}）", last_error()));
    }
    let encrypted = unsafe {
        let slice = std::slice::from_raw_parts(output.pbData, output.cbData as usize);
        let copied = slice.to_vec();
        LocalFree(output.pbData as *mut core::ffi::c_void);
        copied
    };
    Ok(base64::engine::general_purpose::STANDARD.encode(encrypted))
}

#[cfg(windows)]
fn decrypt_dpapi(data: &str) -> Result<String, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let encrypted = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| format!("凭据密文不是合法 base64: {e}"))?;
    if encrypted.is_empty() {
        return Ok(String::new());
    }
    let entropy = DPAPI_ENTROPY;
    let input = CRYPT_INTEGER_BLOB {
        cbData: encrypted.len() as u32,
        pbData: encrypted.as_ptr() as *mut u8,
    };
    let entropy_blob = CRYPT_INTEGER_BLOB {
        cbData: entropy.len() as u32,
        pbData: entropy.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();

    // SAFETY: 同 encrypt_dpapi，输入在调用期间有效，输出由系统分配并在此释放。
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            &entropy_blob,
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(format!("CryptUnprotectData 失败（错误码 {}）", last_error()));
    }
    let plain = unsafe {
        let slice = std::slice::from_raw_parts(output.pbData, output.cbData as usize);
        let bytes = slice.to_vec();
        LocalFree(output.pbData as *mut core::ffi::c_void);
        bytes
    };
    String::from_utf8(plain).map_err(|e| format!("解密结果不是 UTF-8: {e}"))
}

#[cfg(windows)]
fn last_error() -> u32 {
    // SAFETY: GetLastError 只读线程局部状态。
    unsafe { windows_sys::Win32::Foundation::GetLastError() }
}

// ===================== 非 Windows 回退 =====================

#[cfg(not(windows))]
fn encrypt_dpapi(_plain: &str) -> Result<String, String> {
    Err("当前平台没有 DPAPI".into())
}

#[cfg(not(windows))]
fn decrypt_dpapi(_data: &str) -> Result<String, String> {
    Err("当前平台没有 DPAPI".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_cipher_is_explicit() {
        assert!(matches!(platform_cipher(), "dpapi" | "plain"));
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_roundtrip() {
        let original = "p@ss 中文 / 100%";
        let encrypted = encrypt_dpapi(original).expect("加密应成功");
        assert!(!encrypted.contains(original));
        let decrypted = decrypt_dpapi(&encrypted).expect("解密应成功");
        assert_eq!(decrypted, original);
    }

    #[test]
    fn sealed_file_roundtrip_and_legacy_plaintext() {
        let path = std::env::temp_dir().join(format!(
            "ms-sealed-test-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));

        let payload = r#"[{"pluginId":"com.example.x","env":{"TOKEN":"secret"}}]"#;
        write_sealed_file(&path, payload).expect("密封写入应成功");
        let raw = std::fs::read_to_string(&path).expect("应能读文件");
        if cfg!(windows) {
            assert!(!raw.contains("secret"), "Windows 下落盘内容不得含明文");
        }
        assert_eq!(read_sealed_file(&path).unwrap().as_deref(), Some(payload));

        // 兼容旧版直接写业务 JSON 的快照
        std::fs::write(&path, payload).unwrap();
        assert_eq!(read_sealed_file(&path).unwrap().as_deref(), Some(payload));

        let _ = std::fs::remove_file(&path);
    }
}
