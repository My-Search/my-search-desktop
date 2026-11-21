//! WebDAV 同步后端
//!
//! 定位：仅做「远端存储」——把 `.msbackup` 归档上传/下载/查元信息。
//! 同步时机与冲突策略在前端（`src/lib/sync/engine.ts`），Rust 侧无状态、可重入。
//!
//! 凭据
//! ----
//! 分两个文件存放，不进备份、不上传：
//!   - `sync-config.json`：地址 / 用户名 / 远端文件名 / 冲突策略等
//!   - `sync-credentials.json`：WebDAV 密码；Windows 为 DPAPI 密文，
//!     其它平台为 0600 权限的明文文件（详见 `credential_store.rs`）

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Manager};

use crate::credential_store::{load_credentials, save_credentials, Credentials};

const SYNC_CONFIG_FILE: &str = "sync-config.json";
const DEFAULT_REMOTE_FILE: &str = "my-search-backup.msbackup";
const ARCHIVE_MIME: &str = "application/zip";

fn err(msg: impl Into<String>) -> String {
    msg.into()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ===================== 配置与凭据 =====================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncConfig {
    pub enabled: bool,
    pub webdav_url: String,
    pub webdav_user: String,
    pub remote_file: String,
    pub conflict: String,
    pub auto_on_change: bool,
    pub interval_minutes: u32,
    pub has_password: bool,
    /// 云端同步格式：2 = v2 分片；3 = v3 每文件对象（默认 3，旧配置自动升级）
    pub cloud_format: u32,
}

impl Default for SyncConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            webdav_url: String::new(),
            webdav_user: String::new(),
            remote_file: DEFAULT_REMOTE_FILE.into(),
            conflict: "newer".into(),
            auto_on_change: true,
            interval_minutes: 30,
            has_password: false,
            cloud_format: 3,
        }
    }
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| err(format!("取应用数据目录失败: {e}")))?;
    std::fs::create_dir_all(&dir).map_err(|e| err(format!("创建目录失败: {e}")))?;
    Ok(dir.join(SYNC_CONFIG_FILE))
}

pub(crate) fn load_config(app: &AppHandle) -> SyncConfig {
    config_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<SyncConfig>(&t).ok())
        .unwrap_or_default()
}

fn save_config(app: &AppHandle, cfg: &SyncConfig) -> Result<(), String> {
    std::fs::write(config_path(app)?, serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?)
        .map_err(|e| err(format!("保存同步配置失败: {e}")))
}

/// 读配置（附带 has_password 标记）
#[tauri::command]
pub fn sync_get_config(app: AppHandle) -> SyncConfig {
    let mut cfg = load_config(&app);
    cfg.has_password = !load_credentials(&app).password.is_empty();
    cfg
}

/// 写配置。`password` 为 Some 时覆盖密码，None 不动。
#[tauri::command]
pub fn sync_set_config(
    app: AppHandle,
    config: serde_json::Value,
    password: Option<String>,
) -> Result<SyncConfig, String> {
    let mut cfg = load_config(&app);
    if let Some(obj) = config.as_object() {
        for (k, v) in obj {
            match k.as_str() {
                "enabled" => cfg.enabled = v.as_bool().unwrap_or(cfg.enabled),
                "webdavUrl" => cfg.webdav_url = v.as_str().unwrap_or("").trim().to_string(),
                "webdavUser" => cfg.webdav_user = v.as_str().unwrap_or("").trim().to_string(),
                "remoteFile" => cfg.remote_file = v.as_str().unwrap_or("").trim().to_string(),
                "conflict" => cfg.conflict = v.as_str().unwrap_or(&cfg.conflict).to_string(),
                "autoOnChange" => cfg.auto_on_change = v.as_bool().unwrap_or(cfg.auto_on_change),
                "intervalMinutes" => cfg.interval_minutes = v.as_u64().unwrap_or(cfg.interval_minutes as u64) as u32,
                "cloudFormat" => {
                    let n = v.as_u64().unwrap_or(cfg.cloud_format as u64);
                    cfg.cloud_format = if n == 2 { 2 } else { 3 };
                }
                _ => {}
            }
        }
    }
    if cfg.remote_file.is_empty() {
        cfg.remote_file = DEFAULT_REMOTE_FILE.into();
    }
    if !is_safe_remote_path(&cfg.remote_file) {
        return Err(err("远端文件名不合法（不允许 .. 或绝对路径）"));
    }
    if !matches!(cfg.conflict.as_str(), "newer" | "local" | "remote" | "ask") {
        cfg.conflict = "newer".into();
    }
    cfg.interval_minutes = cfg.interval_minutes.clamp(5, 24 * 60);

    if let Some(p) = password {
        let mut creds = load_credentials(&app);
        creds.password = p;
        save_credentials(&app, &creds)?;
    }
    save_config(&app, &cfg)?;
    // 远端目标变了（换地址 / 换用户名 / 换文件名）→ 同步基线必须清零，
    // 否则会把新远端当成「同一远端的旧版本」而错误跳过首次下载或强行覆盖。
    let target = crate::sync_state::target_signature(&cfg.webdav_url, &cfg.webdav_user, &cfg.remote_file);
    crate::sync_state::bind_target(&app, &target)?;
    Ok(sync_get_config(app))
}

/// 清空密码
#[tauri::command]
pub fn sync_clear_credentials(app: AppHandle) -> Result<SyncConfig, String> {
    save_credentials(&app, &Credentials::default())?;
    Ok(sync_get_config(app))
}

fn is_safe_remote_path(p: &str) -> bool {
    !p.starts_with('/') && !p.contains("..") && !p.contains('\0') && !p.contains("://")
}

// ===================== 远端元信息 =====================

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMeta {
    pub exists: bool,
    /// 稳定的远端版本令牌：有 ETag 时取 ETag 去引号，否则用 `size-modified` 兜底
    pub rev: String,
    /// 原始 ETag（**含引号**）：上传时原样放进 `If-Match`，下载时放进 `If-None-Match`
    pub etag: String,
    pub modified: i64,
    pub size: u64,
}

/// 下载结果（含版本信息，供同步状态落盘）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResult {
    pub path: String,
    pub size: u64,
    pub rev: String,
    pub etag: String,
    pub modified: i64,
    /// `true` = 远端版本与调用方持有的一致（HTTP 304），没有写任何文件
    pub not_modified: bool,
}

pub(crate) fn build_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    // 按规则走代理：每次构建现场读规则与系统代理（与 lib.rs 的 build_client 同源）。
    let builder = reqwest::Client::builder()
        .user_agent(crate::UA)
        .timeout(Duration::from_secs(timeout_secs));
    crate::proxy_rules::apply_proxy(builder)
        .build()
        .map_err(|e| e.to_string())
}

pub(crate) fn webdav_url(cfg: &SyncConfig) -> Result<String, String> {
    if cfg.webdav_url.trim().is_empty() {
        return Err(err("请先填写 WebDAV 地址"));
    }
    let base = cfg.webdav_url.trim().trim_end_matches('/');
    let rel = cfg.remote_file.trim_start_matches('/');
    Ok(format!("{base}/{rel}"))
}

pub(crate) fn webdav_auth(
    req: reqwest::RequestBuilder,
    cfg: &SyncConfig,
    creds: &Credentials,
) -> reqwest::RequestBuilder {
    if !creds.password.is_empty() {
        req.basic_auth(cfg.webdav_user.clone(), Some(creds.password.clone()))
    } else {
        req
    }
}

async fn ensure_webdav_dirs(
    client: &reqwest::Client,
    cfg: &SyncConfig,
    creds: &Credentials,
) -> Result<(), String> {
    let base = cfg.webdav_url.trim().trim_end_matches('/').to_string();
    let rel = cfg.remote_file.trim_start_matches('/');
    let mut segments: Vec<&str> = rel.split('/').collect();
    segments.pop();
    let mut url = base;
    for seg in segments {
        if seg.is_empty() {
            continue;
        }
        url = format!("{url}/{seg}");
        let resp = webdav_auth(
            client.request(reqwest::Method::from_bytes(b"MKCOL").unwrap(), &url),
            cfg,
            creds,
        )
        .send()
        .await
        .map_err(|e| err(format!("连接 WebDAV 失败: {e}")))?;
        let code = resp.status().as_u16();
        if !(200..300).contains(&code) && code != 405 && code != 301 && code != 403 {
            return Err(err(format!("创建远端目录失败: HTTP {code}")));
        }
    }
    Ok(())
}

/// 远端文件元信息（HEAD 请求）
async fn webdav_meta(cfg: &SyncConfig, creds: &Credentials) -> Result<RemoteMeta, String> {
    let client = build_client(30)?;
    let url = webdav_url(cfg)?;
    let resp = webdav_auth(client.head(&url), cfg, creds)
        .send()
        .await
        .map_err(|e| err(format!("连接 WebDAV 失败: {e}")))?;
    let status = resp.status();
    if status.as_u16() == 404 {
        return Ok(RemoteMeta::default());
    }
    if !status.is_success() {
        return Err(err(format!(
            "WebDAV 返回 HTTP {}（请检查地址、用户名与密码）",
            status.as_u16()
        )));
    }
    let headers = resp.headers();
    // 原样保留（含引号 / `W/` 前缀）：`If-Match` 必须发服务器给什么就回什么。
    let etag = headers
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .trim()
        .to_string();
    let rev = if etag.is_empty() {
        String::new()
    } else {
        etag.trim_matches('"').to_string()
    };
    let modified = headers
        .get("last-modified")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| parse_http_date(s))
        .unwrap_or(0);
    let size = headers
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    let rev = if rev.is_empty() {
        format!("{size}-{modified}")
    } else {
        rev
    };
    Ok(RemoteMeta { exists: true, rev, etag, modified, size })
}

/// 上传。
///
/// `if_match` 语义（与 WebDAV 条件请求对齐）：
/// - `Some(etag)` 且非空 → `If-Match: etag`：远端被别的设备改过时服务器返回 412；
/// - `Some("")` → `If-None-Match: *`：只在远端**不存在**时创建，防止覆盖他人备份；
/// - `None` → 无条件 PUT（只用于用户明确选择「本机覆盖远端」的场景）。
///
/// 412 / 409 统一返回 `SYNC_CONFLICT:` 前缀，前端据此重新决策而不是把
/// 冲突当成普通网络错误。
async fn webdav_upload(
    cfg: &SyncConfig,
    creds: &Credentials,
    bytes: Vec<u8>,
    if_match: Option<String>,
) -> Result<RemoteMeta, String> {
    let client = build_client(120)?;
    ensure_webdav_dirs(&client, cfg, creds).await?;
    let url = webdav_url(cfg)?;
    let size = bytes.len() as u64;
    let mut req = webdav_auth(
        client.put(&url).header("Content-Type", ARCHIVE_MIME).body(bytes),
        cfg,
        creds,
    );
    if let Some(expected) = if_match {
        if expected.is_empty() {
            req = req.header("If-None-Match", "*");
        } else {
            req = req.header("If-Match", expected);
        }
    }
    let resp = req.send().await.map_err(|e| err(format!("上传失败: {e}")))?;
    let status = resp.status();
    if status.as_u16() == 412 || status.as_u16() == 409 {
        return Err(err("SYNC_CONFLICT: 远端备份已被其他设备修改"));
    }
    if !status.is_success() {
        return Err(err(format!("上传失败: HTTP {}", status.as_u16())));
    }
    let etag = resp
        .headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .trim()
        .to_string();
    if etag.is_empty() {
        // 部分 WebDAV 服务器 PUT 响应不带 ETag：补一次 HEAD 拿到权威版本。
        return webdav_meta(cfg, creds).await;
    }
    Ok(RemoteMeta {
        exists: true,
        rev: etag.trim_matches('"').to_string(),
        etag,
        modified: now_ms(),
        size,
    })
}

/// 下载。
///
/// `known_etag` 非空时带 `If-None-Match`：服务器返回 304 说明远端没变，
/// 直接回报 `not_modified`，不落盘、不还原——这是「兜底轮询不产生无谓下载」
/// 的关键。否则读取响应头里的版本信息一并返回。
async fn webdav_download(
    cfg: &SyncConfig,
    creds: &Credentials,
    known_etag: Option<String>,
) -> Result<(Vec<u8>, RemoteMeta, bool), String> {
    let client = build_client(120)?;
    let url = webdav_url(cfg)?;
    let mut req = webdav_auth(client.get(&url), cfg, creds);
    if let Some(etag) = known_etag.filter(|v| !v.trim().is_empty()) {
        req = req.header("If-None-Match", etag);
    }
    let resp = req.send().await.map_err(|e| err(format!("下载失败: {e}")))?;
    let status = resp.status();
    if status.as_u16() == 304 {
        return Ok((Vec::new(), RemoteMeta::default(), true));
    }
    if !status.is_success() {
        return Err(err(format!("下载失败: HTTP {}", status.as_u16())));
    }
    let headers = resp.headers().clone();
    let etag = headers
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .trim()
        .to_string();
    let modified = headers
        .get("last-modified")
        .and_then(|v| v.to_str().ok())
        .and_then(parse_http_date)
        .unwrap_or_else(now_ms);
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| err(format!("读取响应失败: {e}")))?
        .to_vec();
    let size = bytes.len() as u64;
    let rev = if etag.is_empty() {
        format!("{size}-{modified}")
    } else {
        etag.trim_matches('"').to_string()
    };
    Ok((
        bytes,
        RemoteMeta { exists: true, rev, etag, modified, size },
        false,
    ))
}

// ===================== 统一入口 =====================

/// 检查远端文件是否存在
#[tauri::command]
pub async fn sync_remote_meta(app: AppHandle) -> Result<RemoteMeta, String> {
    crate::sync_service::with_sync_gate(async move {
        let cfg = load_config(&app);
        let creds = load_credentials(&app);
        webdav_meta(&cfg, &creds).await
    })
    .await
}

/// 测试连接
#[tauri::command]
pub async fn sync_test(app: AppHandle) -> Result<serde_json::Value, String> {
    crate::sync_service::with_sync_gate(async move {
        let cfg = load_config(&app);
        if cfg.webdav_url.trim().is_empty() {
            return Err(err("请先填写 WebDAV 地址"));
        }
        let creds = load_credentials(&app);
        let meta = webdav_meta(&cfg, &creds).await?;
        let message = if meta.exists {
            format!("连接成功，远端已有备份（{} 字节）", meta.size)
        } else {
            "连接成功，远端还没有备份".into()
        };
        Ok(json!({ "ok": true, "message": message }))
    })
    .await
}

/// 上传备份到 WebDAV。
///
/// `if_match`：见 `webdav_upload` 的三种语义；不传 = 无条件覆盖（仅供用户明确
/// 选择「本机覆盖远端」时使用，普通同步轮次必须传，否则可能覆盖别的设备的新数据）。
#[tauri::command]
pub async fn sync_upload(
    app: AppHandle,
    path: String,
    if_match: Option<String>,
) -> Result<RemoteMeta, String> {
    let bytes = crate::backup::read_backup_file(&app, &path)?;
    if bytes.is_empty() {
        return Err(err("归档文件为空"));
    }
    crate::sync_service::with_sync_gate(async move {
        let cfg = load_config(&app);
        let creds = load_credentials(&app);
        webdav_upload(&cfg, &creds, bytes, if_match).await
    })
    .await
}

/// 从 WebDAV 下载备份到本机备份目录。
///
/// `known_etag` 非空时走条件请求：304 直接返回 `notModified: true`。
#[tauri::command]
pub async fn sync_download(
    app: AppHandle,
    known_etag: Option<String>,
) -> Result<DownloadResult, String> {
    let name = format!("remote-{}.msbackup", crate::backup::file_stamp_public());
    crate::sync_service::with_sync_gate(async move {
        let cfg = load_config(&app);
        let creds = load_credentials(&app);
        let (bytes, meta, not_modified) = webdav_download(&cfg, &creds, known_etag).await?;
        if not_modified {
            return Ok(DownloadResult {
                path: String::new(),
                size: 0,
                rev: meta.rev,
                etag: meta.etag,
                modified: 0,
                not_modified: true,
            });
        }
        let path = crate::backup::write_archive_file(&app, &name, &bytes)?;
        Ok(DownloadResult {
            path,
            size: bytes.len() as u64,
            rev: meta.rev,
            etag: meta.etag,
            modified: meta.modified,
            not_modified: false,
        })
    })
    .await
}

// ===================== 时间解析（仅保留 WebDAV 用的） =====================

fn parse_http_date(s: &str) -> Option<i64> {
    let s = s.trim();
    let s = s.split(',').nth(1).unwrap_or(s).trim();
    let parts: Vec<&str> = s.split_whitespace().collect();
    if parts.len() < 4 {
        return None;
    }
    let day: i64 = parts[0].parse().ok()?;
    let mon = match parts[1] {
        "Jan" => 1, "Feb" => 2, "Mar" => 3, "Apr" => 4, "May" => 5, "Jun" => 6,
        "Jul" => 7, "Aug" => 8, "Sep" => 9, "Oct" => 10, "Nov" => 11, "Dec" => 12,
        _ => return None,
    };
    let year: i64 = parts[2].parse().ok()?;
    let hms: Vec<&str> = parts[3].split(':').collect();
    if hms.len() < 3 || year < 1970 {
        return None;
    }
    let (h, m, sec): (i64, i64, i64) = (hms[0].parse().ok()?, hms[1].parse().ok()?, hms[2].parse().ok()?);
    let y = if mon <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = if mon > 2 { mon - 3 } else { mon + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some((days * 86_400 + h * 3600 + m * 60 + sec) * 1000)
}

/* ============================================================
 * 单测入口
 * ============================================================ */
/// 远端路径安全校验
#[allow(dead_code)]
pub fn is_safe_remote_path_public(p: &str) -> bool {
    is_safe_remote_path(p)
}

#[allow(dead_code)]
pub fn parse_http_date_public(s: &str) -> i64 {
    parse_http_date(s).unwrap_or(0)
}