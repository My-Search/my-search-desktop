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

use std::path::PathBuf;

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
}
