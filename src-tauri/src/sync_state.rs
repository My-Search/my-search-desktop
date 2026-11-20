//! 云同步的**持久化状态**（`sync-state.json`）。
//!
//! 为什么必须落盘
//! --------------
//! 旧实现把「上次同步时间」放在前端引擎的内存里：设置窗口一关就归零，
//! 主窗口另起一份引擎又从 0 开始比较远端时间——首次自动下载失效、重复上传、
//! 冲突判断失真的根因都在这里。同步是跨窗口、跨重启的长期状态，必须由 Rust
//! 侧持有唯一权威副本：
//!
//! - `deviceId`：本机身份（诊断与「谁改的」留痕）
//! - `target`：远端目标指纹（地址/用户名/文件名），换目标即重置同步基线
//! - `initialized`：是否已经和这个远端建立过同步关系。首次连接且远端已有备份时
//!   不能自动传输，必须让用户选择「使用云端 / 保留本机」
//! - `remoteRev` / `remoteEtag`：上次见到的远端版本；`remoteEtag` 原样保留（含引号），
//!   上传时作为 `If-Match`，下载时作为 `If-None-Match`
//! - `lastLocalDigest`：上次成功同步时本机快照的摘要，用来判断「本机到底变没变」
//! - `lastSyncAt`：上次成功同步时间
//! - `epoch`：还原代次，每次应用还原后自增，旧回调据此丢弃过期写回
//!
//! 文件写入使用「临时文件 + 同目录 rename」，避免断电留下半截 JSON。
//! 所有读写都走进程内互斥锁：设置窗口与主窗口可能同时读写。

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

const STATE_FILE: &str = "sync-state.json";

/// 进程内串行化 `sync-state.json` 的读改写。
static STATE_LOCK: Mutex<()> = Mutex::new(());
/// 设备 id 生成用的去重计数器（同一毫秒内多次生成也不会撞）。
static DEVICE_COUNTER: AtomicU64 = AtomicU64::new(0);

fn err(msg: impl Into<String>) -> String {
    msg.into()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 同步状态（落盘结构；字段名与前端 camelCase 对齐）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncState {
    /// 本机唯一 id（16 位十六进制）
    pub device_id: String,
    /// 远端目标指纹（URL + 用户名 + 远端文件名）
    pub target: String,
    /// 是否已与该远端建立同步基线
    pub initialized: bool,
    /// 上次见到的远端版本（无 ETag 时是 `size-modified` 兜底令牌）
    pub remote_rev: String,
    /// 上次见到的远端原始 ETag（含引号；无 ETag 时为空）
    pub remote_etag: String,
    /// 上次成功同步时本机快照摘要
    pub last_local_digest: String,
    /// 上次成功同步时间（毫秒）
    pub last_sync_at: i64,
    /// 最近一次「已应用」的远端版本（用于诊断与跳过重复还原）
    pub applied_rev: String,
    /// 还原代次（每次应用还原后自增）
    pub epoch: u64,
}

impl Default for SyncState {
    fn default() -> Self {
        Self {
            device_id: String::new(),
            target: String::new(),
            initialized: false,
            remote_rev: String::new(),
            remote_etag: String::new(),
            last_local_digest: String::new(),
            last_sync_at: 0,
            applied_rev: String::new(),
            epoch: 1,
        }
    }
}

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| err(format!("取应用数据目录失败: {e}")))?;
    std::fs::create_dir_all(&dir).map_err(|e| err(format!("创建目录失败: {e}")))?;
    Ok(dir.join(STATE_FILE))
}

/// 生成设备 id：时间戳 + 进程 id + 计数器 + 随机源的 sha256 前 16 位。
///
/// 不引入 uuid 依赖：设备 id 只用于诊断与日志区分，不需要密码学唯一性。
fn new_device_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = DEVICE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut hasher = Sha256::new();
    hasher.update(nanos.to_le_bytes());
    hasher.update(std::process::id().to_le_bytes());
    hasher.update(seq.to_le_bytes());
    hasher.update(now_ms().to_le_bytes());
    let digest = hasher.finalize();
    digest[..8].iter().map(|b| format!("{b:02x}")).collect()
}

/// 读状态（不加锁；调用方必须已持有 `STATE_LOCK`）。
fn load_unlocked(app: &AppHandle) -> SyncState {
    let mut state = state_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<SyncState>(&t).ok())
        .unwrap_or_default();
    if state.device_id.trim().is_empty() {
        state.device_id = new_device_id();
        let _ = save_unlocked(app, &state);
    }
    if state.epoch == 0 {
        state.epoch = 1;
    }
    state
}

/// 原子写状态（不加锁；调用方必须已持有 `STATE_LOCK`）。
fn save_unlocked(app: &AppHandle, state: &SyncState) -> Result<(), String> {
    let path = state_path(app)?;
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(state).map_err(|e| err(format!("序列化同步状态失败: {e}")))?;
    std::fs::write(&tmp, text).map_err(|e| err(format!("写入同步状态失败: {e}")))?;
    if let Err(e) = std::fs::rename(&tmp, &path) {
        // Windows 上目标存在时 rename 可能失败：退回直接覆盖（内容已完整序列化）
        std::fs::write(&path, serde_json::to_string_pretty(state).unwrap_or_default())
            .map_err(|_| err(format!("保存同步状态失败: {e}")))?;
        let _ = std::fs::remove_file(&tmp);
    }
    Ok(())
}

/// 读同步状态（会补齐设备 id 并落盘）。
pub fn load(app: &AppHandle) -> SyncState {
    let _guard = STATE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    load_unlocked(app)
}

/// 原子更新同步状态，返回更新后的副本。
pub fn update<R>(app: &AppHandle, f: impl FnOnce(&mut SyncState) -> R) -> Result<(SyncState, R), String> {
    let _guard = STATE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut state = load_unlocked(app);
    let extra = f(&mut state);
    save_unlocked(app, &state)?;
    Ok((state, extra))
}

/// 远端目标指纹：地址/用户名/文件名任一变化，都必须重置同步基线，
/// 否则会把「新远端」误当成「同一个远端的旧版本」而跳过下载或覆盖写入。
pub fn target_signature(url: &str, user: &str, remote_file: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(url.trim().trim_end_matches('/').as_bytes());
    hasher.update([0u8]);
    hasher.update(user.trim().as_bytes());
    hasher.update([0u8]);
    hasher.update(remote_file.trim().as_bytes());
    let digest = hasher.finalize();
    digest[..12].iter().map(|b| format!("{b:02x}")).collect()
}

/// 绑定远端目标：目标变了就清空同步基线（保留设备 id 与 epoch）。
pub fn bind_target(app: &AppHandle, target: &str) -> Result<SyncState, String> {
    if target.trim().is_empty() {
        return Ok(load(app));
    }
    let (state, _) = update(app, |s| {
        if s.target != target {
            s.target = target.to_string();
            s.initialized = false;
            s.remote_rev.clear();
            s.remote_etag.clear();
            s.last_local_digest.clear();
            s.last_sync_at = 0;
            s.applied_rev.clear();
        }
    })?;
    Ok(state)
}

/// 清零远端基线（保留设备 id）。用户在面板点「重新建立同步」时用。
pub fn reset_remote(app: &AppHandle) -> Result<SyncState, String> {
    let (state, _) = update(app, |s| {
        s.initialized = false;
        s.remote_rev.clear();
        s.remote_etag.clear();
        s.last_local_digest.clear();
        s.last_sync_at = 0;
        s.applied_rev.clear();
    })?;
    Ok(state)
}

/// 递增还原代次（提交一次「已应用」时调用），返回新代次。
pub fn bump_epoch(app: &AppHandle) -> Result<u64, String> {
    let (state, _) = update(app, |s| {
        s.epoch = s.epoch.wrapping_add(1).max(1);
    })?;
    Ok(state.epoch)
}

// ===================== Tauri 命令 =====================

/// 读同步持久化状态
#[tauri::command]
pub fn sync_state_get(app: AppHandle) -> SyncState {
    load(&app)
}

/// 局部更新同步持久化状态。
///
/// 只接受白名单字段：设备 id / 目标指纹 / epoch 由 Rust 自己维护，
/// 前端改不了，避免把同步基线写坏。
#[tauri::command]
pub fn sync_state_patch(app: AppHandle, patch: Value) -> Result<SyncState, String> {
    let (state, _) = update(&app, |s| {
        let Some(obj) = patch.as_object() else { return };
        for (key, value) in obj {
            match key.as_str() {
                "initialized" => {
                    if let Some(v) = value.as_bool() {
                        s.initialized = v;
                    }
                }
                "remoteRev" => {
                    if let Some(v) = value.as_str() {
                        s.remote_rev = v.to_string();
                    }
                }
                "remoteEtag" => {
                    if let Some(v) = value.as_str() {
                        s.remote_etag = v.to_string();
                    }
                }
                "lastLocalDigest" => {
                    if let Some(v) = value.as_str() {
                        s.last_local_digest = v.to_string();
                    }
                }
                "lastSyncAt" => {
                    if let Some(v) = value.as_i64() {
                        s.last_sync_at = v.max(0);
                    }
                }
                "appliedRev" => {
                    if let Some(v) = value.as_str() {
                        s.applied_rev = v.to_string();
                    }
                }
                _ => {}
            }
        }
    })?;
    Ok(state)
}

/// 重置远端同步基线（保留设备 id）：用户在面板选择「重新建立同步」时调用。
#[tauri::command]
pub fn sync_state_reset(app: AppHandle) -> Result<SyncState, String> {
    reset_remote(&app)
}
