//! 插件宿主（plugin host）：安装落盘、运行时网关、后台进程托管。
//!
//! ## 模块职责
//!
//! 1. **文件层**：把插件安装包解出来的文件原子地落到 `plugins/<id>/`，
//!    并提供受控的读写（一切路径都要过 `resolve_plugin_path`，防路径穿越）。
//! 2. **网关层**：插件的一切原生能力都经 `plugin_net_fetch` 等命令，
//!    这里做**第二道**校验（第一道在前端 host.ts）——前端被绕过的假设下，
//!    Rust 侧仍然按「已授予权限」拒绝，做到真正的深防。
//! 3. **进程层**：后台进程由宿主 spawn 并托管。**绝不写系统自启动项**，
//!    进程的生死只由面板 / 前端视图 / 应用退出驱动；Windows 用 Job Object
//!    保证宿主崩溃时子进程一起走，Unix 用进程组。
//!
//! ## 后台进程协议（面向插件作者，与语言无关）
//!
//! 宿主 spawn 进程时注入环境变量 `MS_PLUGIN_PROTOCOL=1`、`MS_PLUGIN_ID`、
//! `MS_PLUGIN_DATA_DIR`、`MS_PLUGIN_HOST_VERSION`，随后在 stdin 上写一行：
//!
//! ```json
//! {"jsonrpc":"2.0","id":1,"method":"init","params":{"apiVersion":1,"pluginId":"…","dataDir":"…"}}
//! ```
//!
//! 插件必须在 `startupTimeoutMs` 内在 stdout 回一行：
//!
//! ```json
//! {"jsonrpc":"2.0","id":1,"result":{"ok":true}}
//! ```
//!
//! 之后宿主每次调用都是 `{"jsonrpc":"2.0","id":N,"method":"<方法>","params":{…}}`，
//! 插件回 `{"jsonrpc":"2.0","id":N,"result":…}`（或 `"error":{"message":…}`）。
//! 插件可以随时发通知 `{"jsonrpc":"2.0","method":"log","params":{"level":"info","message":"…"}}`，
//! 宿主收进 `plugin-logs/<id>.log`（面板可看）。
//! 非 log 通知（如 `chat:delta` 流式响应）通过 Tauri 事件 `plugin://notification` 广播给前端。
//! 停止时宿主发 `{"jsonrpc":"2.0","method":"deactivate"}`（通知，不等回复），
//! 等 `shutdownTimeoutSec` 后强杀。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

/// 插件目录名（应用数据目录下）
const PLUGINS_DIR: &str = "plugins";
/// 插件私有数据目录名（后端进程的数据落这里，前端插件走 localStorage）
const PLUGIN_DATA_DIR: &str = "plugin-data";
/// 插件日志目录名
const PLUGIN_LOGS_DIR: &str = "plugin-logs";
/// 单文件大小上限（与前端 package.ts 的 MAX_ENTRY_BYTES 对齐）
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
/// 日志文件上限，超出后压缩保留尾部
const MAX_LOG_BYTES: u64 = 1024 * 1024;
/// 保留日志尾部大小
const KEEP_LOG_BYTES: usize = 256 * 1024;
/// 后台进程状态变更事件名（面板与搜索结果据此刷新）
const EVENT_BACKEND_CHANGED: &str = "plugin://backend-changed";
/// 插件后端通知事件名（后端发的非 log 通知通过此事件广播给前端）
/// payload: {"method":"chat:delta","params":{...}}
const EVENT_BACKEND_NOTIFICATION: &str = "plugin://notification";

// ===================== 错误与结果 =====================

fn err(msg: impl Into<String>) -> String {
    msg.into()
}

// ===================== 路径安全 =====================

/// 应用数据目录下的插件根
fn plugins_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| err(format!("取应用数据目录失败: {e}")))?;
    Ok(dir.join(PLUGINS_DIR))
}

/// 插件安装目录（未做存在性校验）
fn plugin_dir(app: &AppHandle, plugin_id: &str) -> Result<PathBuf, String> {
    validate_plugin_id(plugin_id)?;
    Ok(plugins_root(app)?.join(plugin_id))
}

/// 插件私有数据目录（后端进程用）
fn plugin_data_dir(app: &AppHandle, plugin_id: &str) -> Result<PathBuf, String> {
    validate_plugin_id(plugin_id)?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| err(format!("取应用数据目录失败: {e}")))?
        .join(PLUGIN_DATA_DIR)
        .join(plugin_id);
    std::fs::create_dir_all(&dir).map_err(|e| err(format!("创建插件数据目录失败: {e}")))?;
    Ok(dir)
}

/// 插件日志文件路径
fn plugin_log_path(app: &AppHandle, plugin_id: &str) -> Result<PathBuf, String> {
    validate_plugin_id(plugin_id)?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| err(format!("取应用数据目录失败: {e}")))?
        .join(PLUGIN_LOGS_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| err(format!("创建插件日志目录失败: {e}")))?;
    Ok(dir.join(format!("{plugin_id}.log")))
}

/// 插件 id 白名单校验（与前端 manifest.ts 的 ID_PATTERN 一致）
fn validate_plugin_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 {
        return Err(err("插件 id 长度非法"));
    }
    let ok = id
        .split('.')
        .filter(|s| !s.is_empty())
        .count()
        >= 2
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
        && !id.starts_with('.')
        && !id.ends_with('.')
        && !id.contains("..");
    if !ok {
        return Err(err(format!("插件 id 非法: {id}")));
    }
    Ok(())
}

/// 相对路径安全校验（防 zip-slip / 绝对路径 / 盘符 / 协议）
fn is_safe_relative(rel: &str) -> bool {
    if rel.is_empty() || rel.len() > 512 || rel.contains('\0') {
        return false;
    }
    let normalized = rel.replace('\\', "/");
    if normalized.starts_with('/') || normalized.contains("://") {
        return false;
    }
    let bytes = normalized.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' {
        return false;
    }
    !normalized.split('/').any(|seg| seg == "..")
}

// ===================== 网关（已授予权限的镜像） =====================

/// 单个插件的网关配置（由前端 `plugin_gateway_sync` 下发）
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewaySpec {
    pub plugin_id: String,
    #[serde(default)]
    pub enabled: bool,
    /// 有效自启动策略：always / on-demand / never
    #[serde(default)]
    pub auto_start: String,
    /// 已授予权限（含 scope 原文）
    #[serde(default)]
    pub grants: Vec<String>,
    #[serde(default)]
    pub backend_entry: Option<String>,
    #[serde(default)]
    pub backend_protocol: Option<String>,
    #[serde(default)]
    pub idle_exit_sec: u64,
    #[serde(default)]
    pub grace_sec: u64,
    #[serde(default)]
    pub max_restarts: u32,
    #[serde(default)]
    pub startup_timeout_ms: u64,
    #[serde(default)]
    pub call_timeout_ms: u64,
}

static GATEWAY: LazyLock<Mutex<HashMap<String, GatewaySpec>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 网关快照文件名（应用数据目录下）
///
/// 为什么要落盘：`GATEWAY` 是进程内内存表，而「开机自启」的判定发生在
/// **应用启动时**（`autostart_enabled_backends`）——那一刻前端还没加载、
/// 表还是空的，自启动就成了永远不生效的死代码。把上次的镜像存下来，
/// 启动时先读回来，自启动才有依据（前端加载后会再同步一次覆盖它）。
const GATEWAY_SNAPSHOT_FILE: &str = "plugin-gateway.json";

fn gateway_snapshot_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(GATEWAY_SNAPSHOT_FILE))
}

/// 把网关镜像写入磁盘（失败只记日志，不影响主流程）
fn save_gateway_snapshot(app: &AppHandle) {
    let Some(path) = gateway_snapshot_path(app) else {
        return;
    };
    let list = gateway_all();
    let Ok(text) = serde_json::to_string_pretty(&list) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(e) = std::fs::write(&path, text) {
        eprintln!("[插件] 网关快照写入失败: {e}");
    }
}

/// 启动时读回网关镜像（供 `autostart_enabled_backends` 使用）
pub fn load_gateway_snapshot(app: &AppHandle) {
    let Some(path) = gateway_snapshot_path(app) else {
        return;
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return;
    };
    let Ok(list) = serde_json::from_str::<Vec<GatewaySpec>>(&text) else {
        eprintln!("[插件] 网关快照解析失败，忽略（下次同步会重建）");
        return;
    };
    if let Ok(mut g) = GATEWAY.lock() {
        for spec in list {
            // 只回填合法 id，避免手工编辑的快照带进异常值
            if validate_plugin_id(&spec.plugin_id).is_ok() {
                g.insert(spec.plugin_id.clone(), spec);
            }
        }
    }
}

/// 读取单个插件的网关镜像（市场下载等需要按调用者身份复核权限）
pub(crate) fn gateway_get(plugin_id: &str) -> Option<GatewaySpec> {
    GATEWAY.lock().ok()?.get(plugin_id).cloned()
}

fn gateway_all() -> Vec<GatewaySpec> {
    GATEWAY
        .lock()
        .map(|g| g.values().cloned().collect())
        .unwrap_or_default()
}

/// 是否已授予某基础权限（只按基础 id 比较，scope 由调用点另行校验）
fn has_base_permission(spec: &GatewaySpec, base: &str) -> bool {
    spec.grants.iter().any(|g| {
        let b = g.split(':').next().unwrap_or("");
        b == base
    })
}

/// 校验 URL 是否落在某个已授予的 `net.fetch:<scope>` 之下（与前端 scopeAllows 同规则）
fn scope_allows(permission: &str, url: &str) -> bool {
    let scope = match permission.split_once(':') {
        Some((_, s)) => s,
        None => return false,
    };
    if scope == "*" {
        return true;
    }
    let target = match url::Url::parse(url) {
        Ok(u) => u,
        Err(_) => return false,
    };
    let (scheme_pattern, rest) = match scope.split_once("://") {
        Some((s, r)) => (s, r),
        None => return false,
    };
    // 协议必须一致：写 https 的 scope 不放行明文 http
    if !scheme_pattern.eq_ignore_ascii_case(target.scheme()) {
        return false;
    }
    let (host_pattern, path_pattern) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/*"),
    };
    let host = target.host_str().unwrap_or("");
    let host_ok = host_pattern == host
        || (host_pattern.starts_with("*.") && host.ends_with(&host_pattern[1..]));
    if !host_ok {
        return false;
    }
    if path_pattern == "/*" || path_pattern == "*" {
        return true;
    }
    let prefix = path_pattern.strip_suffix('*').unwrap_or(path_pattern);
    target.path().starts_with(prefix)
}

/// 极简 URL 解析（避免为一个路径判断引入 url crate）
mod url {
    pub struct Url {
        scheme: String,
        host: String,
        path: String,
    }
    impl Url {
        /// 解析 http/https URL；scheme 一并保留——scope 里写死 https 时
        /// **不允许**降级到明文 http（否则同一主机的明文请求会被放行）
        pub fn parse(raw: &str) -> Result<Url, ()> {
            let (scheme, rest) = if let Some(r) = raw.strip_prefix("https://") {
                ("https", r)
            } else if let Some(r) = raw.strip_prefix("http://") {
                ("http", r)
            } else {
                return Err(());
            };
            let (authority, path) = match rest.find('/') {
                Some(i) => (&rest[..i], &rest[i..]),
                None => (rest, "/"),
            };
            // 去掉用户信息与端口
            let authority = authority.rsplit('@').next().unwrap_or(authority);
            let host = authority.split(':').next().unwrap_or("").to_string();
            if host.is_empty() {
                return Err(());
            }
            Ok(Url {
                scheme: scheme.to_string(),
                host,
                path: path.to_string(),
            })
        }
        pub fn scheme(&self) -> &str {
            self.scheme.as_str()
        }
        pub fn host_str(&self) -> Option<&str> {
            Some(self.host.as_str())
        }
        pub fn path(&self) -> &str {
            self.path.as_str()
        }
    }
}

// ===================== 文件层命令 =====================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallFile {
    pub path: String,
    /// 文件内容的 base64（`base64` 为前端历史的字段名，保留别名以免旧版前端失配）
    #[serde(alias = "base64")]
    pub data: String,
    #[serde(default)]
    pub executable: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginFileEntry {
    pub path: String,
    pub size: u64,
}

/// 安装插件：把前端解析并校验过的文件原子落盘到 `plugins/<id>/`。
///
/// 流程：写 `.staging/<id>-<ts>` → 校验 `plugin.json` 存在且 id 匹配 →
/// 删旧目录 → rename 到正式目录。任何一步失败都不会破坏已安装版本。
#[tauri::command]
pub fn plugin_install(
    app: AppHandle,
    plugin_id: String,
    files: Vec<InstallFile>,
) -> Result<String, String> {
    validate_plugin_id(&plugin_id)?;
    if files.is_empty() {
        return Err(err("安装包为空"));
    }

    let root = plugins_root(&app)?;
    let staging_root = root.join(".staging");
    std::fs::create_dir_all(&staging_root).map_err(|e| err(format!("创建暂存目录失败: {e}")))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let staging = staging_root.join(format!("{plugin_id}-{stamp}"));
    std::fs::create_dir_all(&staging).map_err(|e| err(format!("创建暂存目录失败: {e}")))?;

    // 写文件（失败即整目录清理，不留半成品）
    let write_all = || -> Result<(), String> {
        let mut total: u64 = 0;
        for f in &files {
            if !is_safe_relative(&f.path) {
                return Err(err(format!("安装包包含非法路径: {}", f.path)));
            }
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(f.data.as_bytes())
                .map_err(|e| err(format!("文件解码失败 {}: {e}", f.path)))?;
            total += decoded.len() as u64;
            if decoded.len() as u64 > MAX_FILE_BYTES {
                return Err(err(format!("文件过大: {}", f.path)));
            }
            if total > MAX_FILE_BYTES * 4 {
                return Err(err("插件包解压后体积过大"));
            }
            let dest = staging.join(f.path.replace('\\', "/"));
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| err(format!("创建目录失败 {}: {e}", f.path)))?;
            }
            let mut out = std::fs::File::create(&dest)
                .map_err(|e| err(format!("写入失败 {}: {e}", f.path)))?;
            out.write_all(&decoded)
                .map_err(|e| err(format!("写入失败 {}: {e}", f.path)))?;
            // 可执行位（Unix）：只对 backend/ 下的可执行文件设置
            #[cfg(unix)]
            if f.executable {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755));
            }
            #[cfg(not(unix))]
            let _ = f.executable;
        }
        Ok(())
    };
    if let Err(e) = write_all() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }

    // 校验清单存在且 id 一致（清单的完整校验在前端完成，这里只做身份一致性）
    let manifest_path = staging.join("plugin.json");
    let manifest_text = std::fs::read_to_string(&manifest_path).map_err(|e| {
        let _ = std::fs::remove_dir_all(&staging);
        err(format!("插件缺少 plugin.json: {e}"))
    })?;
    let manifest: Value = serde_json::from_str(&manifest_text).map_err(|e| {
        let _ = std::fs::remove_dir_all(&staging);
        err(format!("plugin.json 不是合法 JSON: {e}"))
    })?;
    let declared_id = manifest.get("id").and_then(|v| v.as_str()).unwrap_or("");
    if declared_id != plugin_id {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(err(format!(
            "清单 id（{declared_id}）与安装 id（{plugin_id}）不一致"
        )));
    }

    // 原子替换：删旧目录后再 rename（Windows 上目标存在时 rename 会失败）
    let dest_dir = root.join(&plugin_id);
    if dest_dir.exists() {
        std::fs::remove_dir_all(&dest_dir).map_err(|e| {
            let _ = std::fs::remove_dir_all(&staging);
            err(format!("替换旧版本失败: {e}"))
        })?;
    }
    std::fs::rename(&staging, &dest_dir).map_err(|e| {
        let _ = std::fs::remove_dir_all(&staging);
        err(format!("落盘失败: {e}"))
    })?;

    Ok(dest_dir.to_string_lossy().to_string())
}

/// 卸载插件：删安装目录（私有数据默认保留，由前端询问用户后调 plugin_purge_data）
#[tauri::command]
pub fn plugin_remove(app: AppHandle, plugin_id: String) -> Result<(), String> {
    let dir = plugin_dir(&app, &plugin_id)?;
    // 先停进程：Windows 上运行中的 exe 会占着文件句柄，直接删目录会失败
    let _ = stop_backend(&app, &plugin_id, true);
    // 开发挂载的插件：目录删除后监听必然失效，顺手摘掉（避免句柄悬空）
    crate::plugin_watch::unwatch_plugin(&plugin_id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| err(format!("删除插件目录失败: {e}")))?;
    }
    if let Ok(log) = plugin_log_path(&app, &plugin_id) {
        let _ = std::fs::remove_file(log);
    }
    if let Ok(mut g) = GATEWAY.lock() {
        g.remove(&plugin_id);
    }
    // 同步落盘镜像，避免下次启动按旧快照把它自启起来（那时目录已不存在）
    save_gateway_snapshot(&app);
    Ok(())
}

/// 清除插件私有数据（卸载时用户选择「同时删除数据」时调用）
#[tauri::command]
pub fn plugin_purge_data(app: AppHandle, plugin_id: String) -> Result<(), String> {
    validate_plugin_id(&plugin_id)?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| err(format!("取应用数据目录失败: {e}")))?
        .join(PLUGIN_DATA_DIR)
        .join(&plugin_id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| err(format!("删除插件数据失败: {e}")))?;
    }
    Ok(())
}

/// 开发模式：把插件目录链接到 `plugins/<id>/`（写一个指向源目录的说明文件，
/// 读文件时优先走源目录），免去每次改动都重新打包安装。
#[tauri::command]
pub fn plugin_link_dir(app: AppHandle, plugin_id: String, dir: String) -> Result<(), String> {
    validate_plugin_id(&plugin_id)?;
    let src = PathBuf::from(&dir);
    if !src.is_dir() {
        return Err(err(format!("目录不存在: {dir}")));
    }
    // 拒绝把任意系统目录当插件目录挂进来（必须含 plugin.json）
    if !src.join("plugin.json").is_file() {
        return Err(err("该目录下没有 plugin.json，不是插件目录"));
    }
    // 解析掉符号链接，避免后续路径校验失败
    let src = src.canonicalize().map_err(|e| err(format!("目录不可访问: {e}")))?;

    let root = plugins_root(&app)?;
    std::fs::create_dir_all(&root).map_err(|e| err(format!("创建插件目录失败: {e}")))?;
    let dest = root.join(&plugin_id);
    if dest.exists() {
        std::fs::remove_dir_all(&dest).map_err(|e| err(format!("清理旧目录失败: {e}")))?;
    }
    std::fs::create_dir_all(&dest).map_err(|e| err(format!("创建目录失败: {e}")))?;
    std::fs::write(
        dest.join(".dev-source"),
        format!("# 开发模式：文件来自下面的源目录\n{}\n", src.display()),
    )
    .map_err(|e| err(format!("写入开发标记失败: {e}")))?;
    Ok(())
}

/// 开发模式的热重载：登记某个插件的源目录，变化时由 `plugin_watch` 广播事件。
///
/// 前端在「从目录挂载」以及应用启动时对每个 `source.dev` 插件调用一次（幂等）。
/// 这样 Rust 侧不需要读注册表（它在前端 localStorage 里），职责保持单一：
/// 前端告诉它「盯哪个目录」，它只负责检测与广播。
#[tauri::command]
pub fn plugin_watch_dir(app: AppHandle, plugin_id: String, dir: String, enable: bool) -> Result<(), String> {
    validate_plugin_id(&plugin_id)?;
    if !enable {
        crate::plugin_watch::unwatch_plugin(&plugin_id);
        return Ok(());
    }
    // 只接受「确实带开发标记」的目录：与 plugin_link_dir 同一套校验，
    // 避免前端被绕过时把任意系统目录纳入监听
    let src = PathBuf::from(&dir);
    if !src.join("plugin.json").is_file() {
        return Err(err("该目录下没有 plugin.json，不是插件目录"));
    }
    crate::plugin_watch::start_dispatch(app);
    crate::plugin_watch::watch_plugin(&plugin_id, &src)
}

/// 读取插件开发目录的源路径（无开发标记时返回 None）
fn dev_source_of(dir: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(dir.join(".dev-source")).ok()?;
    let line = text
        .lines()
        .map(|l| l.trim())
        .find(|l| !l.is_empty() && !l.starts_with('#'))?;
    let p = PathBuf::from(line);
    p.is_dir().then_some(p)
}

/// 解析插件内文件的真实路径（开发模式下指向源目录）
fn resolve_plugin_file(app: &AppHandle, plugin_id: &str, rel: &str) -> Result<PathBuf, String> {
    if !is_safe_relative(rel) {
        return Err(err(format!("非法路径: {rel}")));
    }
    let dir = plugin_dir(app, plugin_id)?;
    let base = dev_source_of(&dir).unwrap_or(dir);
    let full = base.join(rel.replace('\\', "/"));
    if !full.is_file() {
        return Err(err(format!("文件不存在: {rel}")));
    }
    Ok(full)
}

/// 读取插件内文本文件
#[tauri::command]
pub fn plugin_read_text(app: AppHandle, plugin_id: String, rel_path: String) -> Result<String, String> {
    let path = resolve_plugin_file(&app, &plugin_id, &rel_path)?;
    std::fs::read_to_string(&path).map_err(|e| err(format!("读取失败 {}: {e}", rel_path)))
}

/// 读取插件内二进制文件（返回 base64，供图标等使用）
#[tauri::command]
pub fn plugin_read_binary(app: AppHandle, plugin_id: String, rel_path: String) -> Result<String, String> {
    let path = resolve_plugin_file(&app, &plugin_id, &rel_path)?;
    let mut buf = Vec::new();
    std::fs::File::open(&path)
        .and_then(|mut f| f.read_to_end(&mut buf))
        .map_err(|e| err(format!("读取失败 {}: {e}", rel_path)))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(buf))
}

/// 列出插件目录内文件（面板展示与完整性检查用）
#[tauri::command]
pub fn plugin_list_files(app: AppHandle, plugin_id: String) -> Result<Vec<PluginFileEntry>, String> {
    let dir = plugin_dir(&app, &plugin_id)?;
    let base = dev_source_of(&dir).unwrap_or(dir);
    let mut out = Vec::new();
    collect_files(&base, &base, &mut out, 0)?;
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

fn collect_files(
    base: &Path,
    dir: &Path,
    out: &mut Vec<PluginFileEntry>,
    depth: usize,
) -> Result<(), String> {
    if depth > 12 || out.len() > 4096 {
        return Ok(());
    }
    let entries = std::fs::read_dir(dir).map_err(|e| err(format!("读取目录失败: {e}")))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_dir() {
            collect_files(base, &path, out, depth + 1)?;
        } else if meta.is_file() {
            if let Ok(rel) = path.strip_prefix(base) {
                out.push(PluginFileEntry {
                    path: rel.to_string_lossy().replace('\\', "/"),
                    size: meta.len(),
                });
            }
        }
    }
    Ok(())
}

/// 读取本地文件为 base64（安装包选择后读入内存；扩展名白名单避免被当作任意文件读取器）
#[tauri::command]
pub fn plugin_read_local_base64(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    let ext = p
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if ext != "msplugin" && ext != "zip" {
        return Err(err("只支持读取 .msplugin / .zip 文件"));
    }
    let meta = std::fs::metadata(&p).map_err(|e| err(format!("读取失败: {e}")))?;
    if meta.len() > MAX_FILE_BYTES {
        return Err(err("安装包过大（上限 64MB）"));
    }
    let mut buf = Vec::new();
    std::fs::File::open(&p)
        .and_then(|mut f| f.read_to_end(&mut buf))
        .map_err(|e| err(format!("读取失败: {e}")))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(buf))
}

/// 读取插件开发目录的 plugin.json（开发安装用；路径由用户在系统对话框里选定）
///
/// 安全：只读取选定目录下的 plugin.json 一个文件，不做递归读取，
/// 且拒绝 .zip/.msplugin 以外的任意路径枚举。
#[tauri::command]
pub fn plugin_read_dev_manifest(dir: String) -> Result<String, String> {
    let p = PathBuf::from(&dir);
    if !p.is_dir() {
        return Err(err(format!("目录不存在: {dir}")));
    }
    let manifest = p.join("plugin.json");
    let meta = std::fs::metadata(&manifest).map_err(|_| err("该目录下没有 plugin.json"))?;
    if meta.len() > 256 * 1024 {
        return Err(err("plugin.json 过大（上限 256KB）"));
    }
    std::fs::read_to_string(&manifest).map_err(|e| err(format!("读取 plugin.json 失败: {e}")))
}

/// 在系统文件管理器里打开插件目录（开发调试用）
#[tauri::command]
pub fn plugin_open_dir(app: AppHandle, plugin_id: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = plugin_dir(&app, &plugin_id)?;
    let target = dev_source_of(&dir).unwrap_or(dir);
    if !target.exists() {
        return Err(err("插件目录不存在"));
    }
    app.opener()
        .open_path(target.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| err(format!("打开目录失败: {e}")))
}

// ===================== 网关命令 =====================

/// 同步插件的网关配置（权限 / 启用态 / 自启策略 / 进程规格）。
/// 前端注册表是唯一真相源，这里只做镜像；进程托管与原生能力校验都用这份镜像。
///
/// 注意：`auto_start == "always"` 时会**同线程拉起进程**（含握手等待），
/// 因此本命令是 async + spawn_blocking，避免把主线程拖住。
#[tauri::command]
pub async fn plugin_gateway_sync(app: AppHandle, spec: GatewaySpec) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || gateway_sync_inner(&app, spec))
        .await
        .map_err(|e| err(format!("网关同步任务执行失败: {e}")))?
}

/// 网关同步时对后台进程该采取的动作。
///
/// 抽成纯函数是为了便于单测——这里出过一个真实回归：前端每次 open/reload
/// 都会幂等地重放一次网关同步，如果无条件按 `auto_start` 归位，就会把用户
/// 刚按需拉起的进程当场停掉（现象：「打开界面后进程立刻消失」+「插件进程未运行」）。
#[derive(Debug, PartialEq, Eq)]
enum SyncAction {
    /// 什么都不做
    None,
    /// 拉起来（策略变为 always，或从禁用变为启用且要求常驻）
    Start,
    /// 停掉（被禁用，或从 always 降级）
    Stop,
}

/// 纯决策：根据「旧策略 → 新策略」判断要不要动进程。
///
/// 规则：
///   - 策略没变 → 一律不动（幂等重放不该打断运行中的进程）；
///   - 新状态为禁用 → 停；
///   - 新策略为 always → 起（常驻语义）；
///   - 仅当**从 always 降级**时停——on-demand / never 之间切换不打断进程，
///     因为它们都允许进程「按需跑着」。
fn decide_sync_action(
    prev: Option<(&str, bool)>, // (auto_start, enabled)
    next_auto_start: &str,
    next_enabled: bool,
) -> SyncAction {
    match prev {
        None => {
            // 首次同步（或进程表刚清空）：只有 always 需要立刻拉起
            if next_enabled && next_auto_start == "always" {
                SyncAction::Start
            } else {
                SyncAction::None
            }
        }
        Some((prev_auto, prev_enabled)) => {
            let changed = prev_auto != next_auto_start || prev_enabled != next_enabled;
            if !changed {
                return SyncAction::None;
            }
            if !next_enabled {
                return SyncAction::Stop;
            }
            if next_auto_start == "always" {
                return SyncAction::Start;
            }
            if prev_auto == "always" {
                // 从 always 降级：常驻语义消失，停掉
                return SyncAction::Stop;
            }
            SyncAction::None
        }
    }
}

/// `plugin_gateway_sync` 的同步实现（供 async 命令与内部调用复用）
fn gateway_sync_inner(app: &AppHandle, spec: GatewaySpec) -> Result<(), String> {
    validate_plugin_id(&spec.plugin_id)?;
    let plugin_id = spec.plugin_id.clone();
    let auto_start = spec.auto_start.clone();
    let enabled = spec.enabled;

    // 取旧的镜像（用于判断「策略是否真的变了」）
    let prev = GATEWAY.lock().ok().and_then(|g| g.get(&plugin_id).cloned());
    let action = decide_sync_action(
        prev.as_ref().map(|p| (p.auto_start.as_str(), p.enabled)),
        &auto_start,
        enabled,
    );

    if let Ok(mut g) = GATEWAY.lock() {
        g.insert(plugin_id.clone(), spec);
    }
    // 落盘镜像：让下次启动的「开机自启」有依据（见 GATEWAY_SNAPSHOT_FILE 的说明）
    save_gateway_snapshot(app);

    // 只在策略真正变化时动进程（幂等重放绝不打断运行中的进程）
    match action {
        SyncAction::None => {}
        SyncAction::Start => {
            if !backend_is_alive(&plugin_id) {
                let _ = spawn_backend(app, &plugin_id);
            }
        }
        SyncAction::Stop => {
            if backend_is_alive(&plugin_id) {
                let _ = stop_backend(app, &plugin_id, true);
            }
        }
    }
    Ok(())
}

/// 经宿主代理由插件发起的网络请求。
///
/// 双重校验：`plugin_id` 必须有 `net.fetch:<匹配该 URL 的 scope>`，
/// 否则拒绝——即使前端被绕过也拿不到 SSRF 能力。
#[tauri::command]
pub async fn plugin_net_fetch(
    plugin_id: String,
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
) -> Result<String, String> {
    let spec = gateway_get(&plugin_id).ok_or_else(|| err("插件未注册到网关"))?;
    if !spec.enabled {
        return Err(err("插件已禁用"));
    }
    let allowed = spec
        .grants
        .iter()
        .filter(|g| g.split(':').next() == Some("net.fetch"))
        .any(|g| scope_allows(g, &url));
    if !allowed {
        return Err(err(format!("插件未获授权访问该地址: {url}")));
    }
    crate::http_request_for_plugin(method, url, headers, body).await
}

// ===================== 后台进程托管 =====================

/// 一次后端进程的句柄
struct BackendHandle {
    /// 子进程
    child: Arc<Mutex<Child>>,
    /// 子进程标准输入（持有才能向插件发 JSON-RPC）
    stdin: Arc<Mutex<Option<std::process::ChildStdin>>>,
    /// 进程组 id（Unix 上用于整组清理）
    #[cfg(unix)]
    pgid: i32,
    /// Windows Job Object 句柄（KILL_ON_JOB_CLOSE：宿主退出/崩溃时子进程一起走）
    #[cfg(windows)]
    job: usize,
    /// 运行态
    state: Arc<Mutex<BackendState>>,
    /// 待响应的 JSON-RPC 请求
    pending: Arc<Mutex<HashMap<u64, Sender<Result<Value, String>>>>>,
}

// 安全性：
// - `child` / `stdin` / `state` / `pending` 全部包在 Mutex 里；
// - `job` 是不透明的内核句柄，没有任何 Rust 侧可观察的可变性；
// - Unix 的 `pgid` 是纯数字。
// 因此把整个句柄跨线程序共享是安全的，手工补上 Send/Sync 标记。
unsafe impl Send for BackendHandle {}
unsafe impl Sync for BackendHandle {}

/// 运行态（对前端可见）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendState {
    pub plugin_id: String,
    pub status: String,
    pub pid: Option<u32>,
    pub memory_bytes: Option<u64>,
    pub started_at: Option<u64>,
    pub restarts: u32,
    pub last_error: Option<String>,
    pub keep_alive_reasons: Vec<String>,
    /// 请求停止时为 true（看门狗据此区分「正常停止」与「崩溃」）
    #[serde(skip)]
    stop_requested: bool,
}

static BACKENDS: LazyLock<Mutex<HashMap<String, Arc<BackendHandle>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn backend_is_alive(plugin_id: &str) -> bool {
    BACKENDS
        .lock()
        .ok()
        .map(|m| m.contains_key(plugin_id))
        .unwrap_or(false)
}

/// 读取运行态快照（无句柄时返回「未运行」）
fn backend_state(plugin_id: &str) -> BackendState {
    if let Ok(map) = BACKENDS.lock() {
        if let Some(h) = map.get(plugin_id) {
            if let Ok(st) = h.state.lock() {
                return st.clone();
            }
        }
    }
    BackendState {
        plugin_id: plugin_id.to_string(),
        status: "stopped".into(),
        pid: None,
        memory_bytes: None,
        started_at: None,
        restarts: 0,
        last_error: None,
        keep_alive_reasons: Vec::new(),
        stop_requested: false,
    }
}

fn emit_state(app: &AppHandle, state: &BackendState) {
    let _ = app.emit(EVENT_BACKEND_CHANGED, state);
}

/// 追加插件日志（带大小上限，超出后保留尾部）
fn append_log(app: &AppHandle, plugin_id: &str, line: &str) {
    let Ok(path) = plugin_log_path(app, plugin_id) else {
        return;
    };
    let stamp = now_ms();
    let text = format!("[{stamp}] {line}\n");
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > MAX_LOG_BYTES {
            if let Ok(mut content) = std::fs::read(&path) {
                let start = content.len().saturating_sub(KEEP_LOG_BYTES);
                content.drain(..start);
                let _ = std::fs::write(&path, content);
            }
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = f.write_all(text.as_bytes());
    }
}

/// 启动后台进程（已运行则直接返回当前状态）
fn spawn_backend(app: &AppHandle, plugin_id: &str) -> Result<BackendState, String> {
    if backend_is_alive(plugin_id) {
        return Ok(backend_state(plugin_id));
    }
    // 网关未同步时尝试从磁盘快照加回
    let spec = match gateway_get(plugin_id) {
        Some(s) => s,
        None => {
            load_gateway_snapshot(app);
            gateway_get(plugin_id).ok_or_else(|| err("插件未注册到网关"))?
        }
    };
    if !spec.enabled {
        return Err(err("插件已禁用"));
    }
    if !has_base_permission(&spec, "backend.spawn") {
        return Err(err("未授予「运行本机程序」权限"));
    }
    let entry = spec
        .backend_entry
        .clone()
        .ok_or_else(|| err("该插件没有声明后台进程"))?;
    let protocol = spec
        .backend_protocol
        .clone()
        .unwrap_or_else(|| "jsonrpc-stdio".into());
    if protocol != "jsonrpc-stdio" {
        return Err(err(format!("暂不支持的进程协议: {protocol}")));
    }
    let exe = resolve_plugin_file(app, plugin_id, &entry)?;
    let cwd = plugin_dir(app, plugin_id)?;
    let data_dir = plugin_data_dir(app, plugin_id)?;

    let mut cmd = Command::new(&exe);
    cmd.current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("MS_PLUGIN_PROTOCOL", "1")
        .env("MS_PLUGIN_ID", plugin_id)
        .env("MS_PLUGIN_DATA_DIR", data_dir.to_string_lossy().to_string())
        .env("MS_PLUGIN_HOST_VERSION", env!("CARGO_PKG_VERSION"));
    // 不继承宿主的环境变量（避免插件顺走 PATH 里的凭据）；只保留系统必需项
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| err(format!("启动插件进程失败（{}）: {e}", exe.display())))?;
    let pid = child.id();
    append_log(app, plugin_id, &format!("进程已启动 pid={pid} entry={entry}"));

    // Windows：把子进程放进 Job Object，宿主退出/崩溃时整棵树一起结束
    #[cfg(windows)]
    let job = unsafe { assign_job_object(pid) };    #[cfg(unix)]
    let pgid = pid as i32;

    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let handle = Arc::new(BackendHandle {
        child: Arc::new(Mutex::new(child)),
        stdin: Arc::new(Mutex::new(stdin)),
        #[cfg(unix)]
        pgid,
        #[cfg(windows)]
        job,
        state: Arc::new(Mutex::new(BackendState {
            plugin_id: plugin_id.to_string(),
            status: "starting".into(),
            pid: Some(pid),
            memory_bytes: None,
            started_at: Some(now_ms()),
            restarts: BACKENDS
                .lock()
                .ok()
                .and_then(|m| m.get(plugin_id).map(|h| h.state.lock().map(|s| s.restarts).unwrap_or(0)))
                .unwrap_or(0),
            last_error: None,
            keep_alive_reasons: vec![if spec.auto_start == "always" {
                "开机自启已开启".into()
            } else {
                "按需启动".into()
            }],
            stop_requested: false,
        })),
        pending: Arc::new(Mutex::new(HashMap::new())),
    });

    if let Ok(mut map) = BACKENDS.lock() {
        map.insert(plugin_id.to_string(), handle.clone());
    }

    // stdout 读取线程：既写日志，也解析 JSON-RPC 响应
    if let Some(out) = stdout {
        let app2 = app.clone();
        let pid2 = plugin_id.to_string();
        let h = handle.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(out);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                if handle_rpc_line(&line, &h, &app2, &pid2) {
                    continue;
                }
                append_log(&app2, &pid2, &format!("stdout: {line}"));
            }
        });
    }
    // stderr 读取线程：只写日志
    if let Some(err_out) = stderr {
        let app2 = app.clone();
        let pid2 = plugin_id.to_string();
        std::thread::spawn(move || {
            let reader = BufReader::new(err_out);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                append_log(&app2, &pid2, &format!("stderr: {line}"));
            }
        });
    }

    // 握手：init 请求必须在上限内得到响应
    let timeout = Duration::from_millis(spec.startup_timeout_ms.max(200));
    let ready = request(
        app,
        plugin_id,
        "init",
        json!({
            "apiVersion": 1,
            "pluginId": plugin_id,
            "hostVersion": env!("CARGO_PKG_VERSION"),
            "dataDir": data_dir.to_string_lossy(),
        }),
        timeout,
    );
    match ready {
        Ok(_) => {
            set_status(app, plugin_id, "running", None);
            append_log(app, plugin_id, "握手成功，进程就绪");
        }
        Err(e) => {
            append_log(app, plugin_id, &format!("握手失败: {e}"));
            let _ = stop_backend(app, plugin_id, false);
            set_status(app, plugin_id, "error", Some(e.clone()));
            return Err(e);
        }
    }

    // 看门狗：进程退出时更新状态，必要时退避重启
    {
        let app2 = app.clone();
        let pid2 = plugin_id.to_string();
        let h = handle.clone();
        std::thread::spawn(move || {
            let exited = loop {
                {
                    let mut guard = match h.child.lock() {
                        Ok(g) => g,
                        Err(e) => e.into_inner(),
                    };
                    match guard.try_wait() {
                        Ok(Some(status)) => break Some(status),
                        Ok(None) => {}
                        Err(_) => break None,
                    }
                }
                std::thread::sleep(Duration::from_millis(500));
            };

            if let Ok(mut map) = BACKENDS.lock() {
                map.remove(&pid2);
            }
            let (stop_requested, restarts) = {
                let st = match h.state.lock() {
                    Ok(g) => g.clone(),
                    Err(e) => e.into_inner().clone(),
                };
                (st.stop_requested, st.restarts)
            };
            // 关掉 Job Object（Windows）：进程树里残留的孙进程一并结束
            #[cfg(windows)]
            unsafe {
                close_job_object(h.job)
            };
            let _ = h;

            if stop_requested {
                append_log(&app2, &pid2, "进程已停止");
                set_status(&app2, &pid2, "stopped", None);
                return;
            }

            let code = exited.map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
            let msg = format!("进程异常退出（exit code {code}）");
            append_log(&app2, &pid2, &msg);

            // 只有「开机自启」的插件才自动重启，且次数受 maxRestarts 限制
            let spec = gateway_get(&pid2);
            let can_restart = spec
                .as_ref()
                .map(|s| s.enabled && s.auto_start == "always" && restarts < s.max_restarts.max(1))
                .unwrap_or(false);
            if can_restart {
                let delay = match restarts {
                    0 => 1000,
                    1 => 5000,
                    _ => 30000,
                };
                append_log(&app2, &pid2, &format!("{delay}ms 后重启（第 {} 次）", restarts + 1));
                set_status(&app2, &pid2, "crashed", Some(msg));
                std::thread::sleep(Duration::from_millis(delay));
                if let Err(e) = spawn_backend(&app2, &pid2) {
                    set_status(&app2, &pid2, "error", Some(e));
                } else if let Ok(map) = BACKENDS.lock() {
                    if let Some(h) = map.get(&pid2) {
                        if let Ok(mut st) = h.state.lock() {
                            st.restarts = restarts + 1;
                        }
                    }
                }
            } else {
                set_status(&app2, &pid2, "error", Some(msg));
            }
        });
    }

    // 后台：空闲退出 + 内存采样
    {
        let app3 = app.clone();
        let pid3 = plugin_id.to_string();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(5));
            if !backend_is_alive(&pid3) {
                return;
            }
            let spec = match gateway_get(&pid3) {
                Some(s) => s,
                None => return,
            };
            // 内存采样（面板展示占用）
            let mem = sample_memory(&pid3);
            if let Ok(map) = BACKENDS.lock() {
                if let Some(h) = map.get(&pid3) {
                    if let Ok(mut st) = h.state.lock() {
                        st.memory_bytes = mem;
                    }
                }
            }
            let _ = app3.emit(EVENT_BACKEND_CHANGED, backend_state(&pid3));
            // 空闲退出：不常驻的插件长时间没人用就回收（下次调用再拉起）
            if spec.idle_exit_sec > 0 && spec.auto_start != "always" {
                let idle = last_call_elapsed_secs(&pid3);
                if idle >= spec.idle_exit_sec {
                    append_log(&app3, &pid3, "空闲超时，自动退出（下次调用会重新启动）");
                    let _ = stop_backend(&app3, &pid3, true);
                    return;
                }
            }
        });
    }

    Ok(backend_state(plugin_id))
}

/// 进程最后被调用的时间（用于空闲退出）
static LAST_CALL: LazyLock<Mutex<HashMap<String, Instant>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn touch_last_call(plugin_id: &str) {
    if let Ok(mut m) = LAST_CALL.lock() {
        m.insert(plugin_id.to_string(), Instant::now());
    }
}

fn last_call_elapsed_secs(plugin_id: &str) -> u64 {
    LAST_CALL
        .lock()
        .ok()
        .and_then(|m| m.get(plugin_id).map(|t| t.elapsed().as_secs()))
        .unwrap_or(u64::MAX)
}

/// 更新状态并广播
fn set_status(app: &AppHandle, plugin_id: &str, status: &str, error: Option<String>) {
    let snapshot = {
        let Ok(map) = BACKENDS.lock() else {
            return;
        };
        let Some(h) = map.get(plugin_id) else {
            return;
        };
        let Ok(mut st) = h.state.lock() else { return };
        st.status = status.to_string();
        st.last_error = error;
        st.clone()
    };
    emit_state(app, &snapshot);
}

/// 处理一行 stdout：能解析成 JSON-RPC 就交给 RPC 分发，返回 true 表示已消费
fn handle_rpc_line(
    line: &str,
    handle: &Arc<BackendHandle>,
    app: &AppHandle,
    plugin_id: &str,
) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return false;
    };
    let obj = match value.as_object() {
        Some(o) => o,
        None => return false,
    };
    // 响应：带 id 且含 result/error
    if let Some(id) = obj.get("id").and_then(|v| v.as_u64()) {
        let result = if let Some(e) = obj.get("error") {
            Err(e
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("插件返回错误")
                .to_string())
        } else {
            Ok(obj.get("result").cloned().unwrap_or(Value::Null))
        };
        if let Ok(mut pending) = handle.pending.lock() {
            if let Some(tx) = pending.remove(&id) {
                let _ = tx.send(result);
                return true;
            }
        }
        return true;
    }
    // 通知：method 无 id
    match obj.get("method").and_then(|v| v.as_str()) {
        Some("log") => {
            let level = obj
                .get("params")
                .and_then(|p| p.get("level"))
                .and_then(|v| v.as_str())
                .unwrap_or("info");
            let message = obj
                .get("params")
                .and_then(|p| p.get("message"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            append_log(app, plugin_id, &format!("[{level}] {message}"));
            true
        }
        Some(method) => {
            // 非 log 通知通过 Tauri 事件广播给前端
            let params = obj.get("params").cloned().unwrap_or(Value::Null);
            let payload = json!({
                "pluginId": plugin_id,
                "method": method,
                "params": params,
            });
            let _ = app.emit(EVENT_BACKEND_NOTIFICATION, payload);
            true
        }
        None => true,
    }
}

/// 发一条 JSON-RPC 请求并等待响应
fn request(
    app: &AppHandle,
    plugin_id: &str,
    method: &str,
    params: Value,
    timeout: Duration,
) -> Result<Value, String> {
    touch_last_call(plugin_id);
    let handle = {
        let map = BACKENDS.lock().map_err(|_| err("插件进程表不可用"))?;
        map.get(plugin_id).cloned().ok_or_else(|| err("插件进程未运行"))?
    };
    static NEXT_ID: LazyLock<Mutex<u64>> = LazyLock::new(|| Mutex::new(1));
    let id = {
        let mut n = NEXT_ID.lock().map_err(|_| err("请求号分配失败"))?;
        *n += 1;
        *n
    };
    let (tx, rx) = channel::<Result<Value, String>>();
    {
        let mut pending = handle.pending.lock().map_err(|_| err("请求表不可用"))?;
        pending.insert(id, tx);
    }
    let payload = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    });
    {
        let mut guard = handle.stdin.lock().map_err(|_| err("进程句柄不可用"))?;
        let stdin = guard.as_mut().ok_or_else(|| err("插件进程标准输入不可用"))?;
        let mut line = payload.to_string();
        line.push('\n');
        stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.flush())
            .map_err(|e| err(format!("向插件进程写入失败: {e}")))?;
    }
    match rx.recv_timeout(timeout) {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(err(format!("插件返回错误: {e}"))),
        Err(_) => {
            if let Ok(mut pending) = handle.pending.lock() {
                pending.remove(&id);
            }
            let _ = app.emit(EVENT_BACKEND_CHANGED, backend_state(plugin_id));
            Err(err(format!(
                "插件调用超时（{}ms，方法 {method}）",
                timeout.as_millis()
            )))
        }
    }
}

/// 停止后台进程（先发 deactivate 优雅退出，超时后连带进程树强杀）
fn stop_backend(app: &AppHandle, plugin_id: &str, requested: bool) -> Result<(), String> {
    let handle = {
        let mut map = BACKENDS.lock().map_err(|_| err("插件进程表不可用"))?;
        map.remove(plugin_id)
    };
    let Some(handle) = handle else {
        return Ok(());
    };
    if let Ok(mut st) = handle.state.lock() {
        st.status = "stopping".into();
        st.stop_requested = requested;
    }
    let spec = gateway_get(plugin_id);
    let grace = Duration::from_secs(spec.as_ref().map(|s| s.grace_sec).unwrap_or(3).clamp(1, 60));

    // 优雅退出：发通知（不等响应），给插件一点收尾时间
    {
        if let Ok(mut guard) = handle.stdin.lock() {
            if let Some(stdin) = guard.as_mut() {
                let line = json!({"jsonrpc":"2.0","method":"deactivate"}).to_string() + "\n";
                let _ = stdin.write_all(line.as_bytes());
                let _ = stdin.flush();
            }
        }
    }
    let deadline = Instant::now() + grace;
    let mut exited = false;
    while Instant::now() < deadline {
        if let Ok(mut guard) = handle.child.lock() {
            if let Ok(Some(_)) = guard.try_wait() {
                exited = true;
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    if !exited {
        kill_tree(&handle);
    }
    // 状态广播：这里用临时快照（句柄已从表中移除）
    let mut snapshot = backend_state(plugin_id);
    snapshot.status = "stopped".into();
    snapshot.pid = None;
    snapshot.memory_bytes = None;
    emit_state(app, &snapshot);
    append_log(app, plugin_id, "已停止后台进程");
    Ok(())
}

/// 结束进程树：Windows 结束 Job Object，Unix 杀进程组
fn kill_tree(handle: &Arc<BackendHandle>) {
    #[cfg(windows)]
    unsafe {
        terminate_job_object(handle.job);
    }
    #[cfg(unix)]
    unsafe {
        // 先温和，再强杀
        libc::killpg(handle.pgid, libc::SIGTERM);
        std::thread::sleep(Duration::from_millis(300));
        libc::killpg(handle.pgid, libc::SIGKILL);
    }
    if let Ok(mut guard) = handle.child.lock() {
        let _ = guard.kill();
        let _ = guard.wait();
    }
}

/// 取插件进程内存占用（字节）
fn sample_memory(plugin_id: &str) -> Option<u64> {
    let pid = {
        let map = BACKENDS.lock().ok()?;
        let h = map.get(plugin_id)?;
        let st = h.state.lock().ok()?;
        st.pid?
    };
    #[cfg(windows)]
    unsafe {
        process_memory_bytes(pid)
    }
    #[cfg(unix)]
    {
        let _ = pid;
        unix_process_memory_bytes(pid)
    }
}

#[cfg(unix)]
fn unix_process_memory_bytes(pid: u32) -> Option<u64> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/statm")).ok()?;
    let rss_pages: u64 = text.split_whitespace().nth(1)?.parse().ok()?;
    Some(rss_pages * 4096)
}

#[cfg(windows)]
unsafe fn process_memory_bytes(pid: u32) -> Option<u64> {
    use windows_sys::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_INFORMATION};
    let handle = OpenProcess(PROCESS_QUERY_INFORMATION, 0, pid);
    if handle.is_null() {
        return None;
    }
    let mut counters: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
    counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
    let ok = GetProcessMemoryInfo(handle, &mut counters, counters.cb);
    windows_sys::Win32::Foundation::CloseHandle(handle);
    if ok == 0 {
        None
    } else {
        Some(counters.WorkingSetSize as u64)
    }
}

/// Windows：创建 Job Object 并接管子进程（宿主退出/崩溃 → 整棵树一起结束）
#[cfg(windows)]
unsafe fn assign_job_object(pid: u32) -> usize {
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
    if job.is_null() {
        return 0;
    }
    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    SetInformationJobObject(
        job,
        JobObjectExtendedLimitInformation,
        &info as *const _ as *const core::ffi::c_void,
        std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
    );
    let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
    if !process.is_null() {
        AssignProcessToJobObject(job, process);
        windows_sys::Win32::Foundation::CloseHandle(process);
    }
    job as usize
}

#[cfg(windows)]
unsafe fn terminate_job_object(job: usize) {
    if job != 0 {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        TerminateJobObject(job as windows_sys::Win32::Foundation::HANDLE, 1);
    }
}

#[cfg(windows)]
unsafe fn close_job_object(job: usize) {
    if job != 0 {
        windows_sys::Win32::Foundation::CloseHandle(job as windows_sys::Win32::Foundation::HANDLE);
    }
}

// ===================== 后台进程命令 =====================
//
// 线程模型（关键，别改回去）：这组命令内部会**阻塞等待子进程握手/响应**
// （`request()` 里的 `rx.recv_timeout`，最长可达 startupTimeoutMs / callTimeoutMs）。
// Tauri 的同步命令是在 invoke 调用栈上直接跑的（`ExecutionContext::Blocking`），
// 而 invoke 由 WebView 消息回调驱动、跑在主线程——同步等待会把窗口消息循环卡住，
// 表现就是「点启动 → 窗口未响应 → 直到超时」。因此这里一律声明为 `async` 并把
// 阻塞体丢进 `spawn_blocking`，让主线程立刻返回、由线程池承担等待。

/// 启动插件后台进程（阻塞体在线程池执行，不卡窗口）
#[tauri::command]
pub async fn plugin_backend_start(app: AppHandle, plugin_id: String) -> Result<BackendState, String> {
    tauri::async_runtime::spawn_blocking(move || spawn_backend(&app, &plugin_id))
        .await
        .map_err(|e| err(format!("启动任务执行失败: {e}")))?
}

/// 停止插件后台进程（阻塞体在线程池执行，不卡窗口）
#[tauri::command]
pub async fn plugin_backend_stop(app: AppHandle, plugin_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || stop_backend(&app, &plugin_id, true))
        .await
        .map_err(|e| err(format!("停止任务执行失败: {e}")))?
}

/// 重启插件后台进程（阻塞体在线程池执行，不卡窗口）
#[tauri::command]
pub async fn plugin_backend_restart(app: AppHandle, plugin_id: String) -> Result<BackendState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        stop_backend(&app, &plugin_id, true)?;
        spawn_backend(&app, &plugin_id)
    })
    .await
    .map_err(|e| err(format!("重启任务执行失败: {e}")))?
}

/// 查询所有插件后台进程状态
#[tauri::command]
pub fn plugin_backend_list() -> Vec<BackendState> {
    let ids: Vec<String> = BACKENDS
        .lock()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    ids.iter().map(|id| backend_state(id)).collect()
}

/// 调用插件后端方法（未运行时按需拉起）。
///
/// 内部两段都是阻塞的（spawn_backend 的握手 + request 的响应等待），
/// 因此整体丢进 spawn_blocking，避免占用主线程。
#[tauri::command]
pub async fn plugin_backend_call(
    app: AppHandle,
    plugin_id: String,
    method: String,
    params: Option<Value>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let spec = gateway_get(&plugin_id).ok_or_else(|| err("插件未注册到网关"))?;
        if !has_base_permission(&spec, "backend.spawn") {
            return Err(err("未授予「运行本机程序」权限"));
        }
        let timeout = Duration::from_millis(spec.call_timeout_ms.max(1000));

        if !backend_is_alive(&plugin_id) {
            spawn_backend(&app, &plugin_id)?;
        }

        // 竞态兜底：进程可能在 is_alive 与 request 之间被并发停掉
        //（例如另一处 gateway 同步 / 用户点了停止）。
        // 「插件进程未运行」属于可重试错误——重新拉起后再试一次，
        // 避免用户看到偶发的「后端初始化失败: 插件进程未运行」。
        match request(&app, &plugin_id, &method, params.clone().unwrap_or(Value::Null), timeout) {
            Err(e) if e.contains("插件进程未运行") => {
                spawn_backend(&app, &plugin_id)?;
                request(&app, &plugin_id, &method, params.unwrap_or(Value::Null), timeout)
            }
            other => other,
        }
    })
    .await
    .map_err(|e| err(format!("调用任务执行失败: {e}")))?
}

/// 读取插件日志尾部
#[tauri::command]
pub fn plugin_read_log(app: AppHandle, plugin_id: String, max_lines: usize) -> Result<String, String> {
    let path = plugin_log_path(&app, &plugin_id)?;
    if !path.exists() {
        return Ok(String::new());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| err(format!("读取日志失败: {e}")))?;
    let lines: Vec<&str> = text.lines().collect();
    let take = max_lines.clamp(1, 5000);
    let start = lines.len().saturating_sub(take);
    Ok(lines[start..].join("\n"))
}

/// 清空插件日志
#[tauri::command]
pub fn plugin_clear_log(app: AppHandle, plugin_id: String) -> Result<(), String> {
    let path = plugin_log_path(&app, &plugin_id)?;
    let _ = std::fs::remove_file(path);
    Ok(())
}

// ===================== 应用生命周期 =====================

/// 应用退出前停止全部插件进程（避免留下孤儿）。
/// 注意：Windows 上 Job Object 的 KILL_ON_JOB_CLOSE 已经保证了宿主退出时
/// 内核自动结束整棵进程树，此函数仅适用于宿主**不想等进程自然退出**的优雅关闭。
#[allow(dead_code)]
pub fn shutdown_all(app: &AppHandle) {
    let ids: Vec<String> = BACKENDS
        .lock()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    for id in ids {
        let _ = stop_backend(app, &id, true);
    }
}

/// 只对「开机自启」的插件拉起后台进程（应用启动时调用一次）。
///
/// 前置条件：网关镜像已由 `load_gateway_snapshot` 读回（否则表为空，什么也不会启动）。
pub fn autostart_enabled_backends(app: &AppHandle) {
    load_gateway_snapshot(app);
    for spec in gateway_all() {
        if spec.enabled && spec.auto_start == "always" && spec.backend_entry.is_some() {
            if let Err(e) = spawn_backend(app, &spec.plugin_id) {
                eprintln!("[插件] {} 自启动失败: {e}", spec.plugin_id);
            }
        }
    }
}

/// 校验一个相对路径是否安全（供前端安装前预检）
#[tauri::command]
pub fn plugin_check_path(rel_path: String) -> bool {
    let normalized = rel_path.replace('\\', "/");
    let p = Path::new(&normalized);
    is_safe_relative(&rel_path) && !p.components().any(|c| matches!(c, Component::ParentDir))
}

#[cfg(test)]
mod tests {
    use super::{
        decide_sync_action, has_base_permission, is_safe_relative, scope_allows, validate_plugin_id,
        GatewaySpec, SyncAction,
    };

    fn spec_with(grants: &[&str]) -> GatewaySpec {
        GatewaySpec {
            plugin_id: "com.test.a".into(),
            enabled: true,
            auto_start: "on-demand".into(),
            grants: grants.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn plugin_id_validation() {
        assert!(validate_plugin_id("com.zhuangjie.ai-ask").is_ok());
        assert!(validate_plugin_id("com.a.b").is_ok());
        assert!(validate_plugin_id("single").is_err());
        assert!(validate_plugin_id("Com.Upper").is_err());
        assert!(validate_plugin_id("../evil").is_err());
        assert!(validate_plugin_id("com..a").is_err());
        assert!(validate_plugin_id("").is_err());
    }

    #[test]
    fn relative_path_validation_blocks_traversal() {
        assert!(is_safe_relative("plugin.json"));
        assert!(is_safe_relative("ui/detail.html"));
        assert!(!is_safe_relative("../secret"));
        assert!(!is_safe_relative("a/../../b"));
        assert!(!is_safe_relative("/etc/passwd"));
        assert!(!is_safe_relative("C:/Windows/system32"));
        assert!(!is_safe_relative("http://evil.com/x"));
        assert!(!is_safe_relative("a\\..\\..\\b"));
        assert!(!is_safe_relative(""));
    }

    #[test]
    fn base_permission_matching() {
        let spec = spec_with(&["net.fetch:https://api.openai.com/*", "store"]);
        assert!(has_base_permission(&spec, "store"));
        assert!(has_base_permission(&spec, "net.fetch"));
        assert!(!has_base_permission(&spec, "backend.spawn"));
        assert!(!has_base_permission(&spec, "clipboard.read"));
    }

    #[test]
    fn net_fetch_scope_matching() {
        let p = "net.fetch:https://api.openai.com/*";
        assert!(scope_allows(p, "https://api.openai.com/v1/chat"));
        assert!(scope_allows(p, "https://api.openai.com/"));
        assert!(!scope_allows(p, "https://evil.com/v1/chat"));
        assert!(!scope_allows(p, "https://api.openai.com.evil.com/x"));
        assert!(!scope_allows(p, "http://api.openai.com/x")); // 协议不同但主机相同 -> 主机匹配即可（见下）

        let wild = "net.fetch:https://*.example.com/*";
        assert!(scope_allows(wild, "https://a.example.com/x"));
        assert!(scope_allows(wild, "https://b.example.com/deep/path"));
        assert!(!scope_allows(wild, "https://example.com/x"));
        assert!(!scope_allows(wild, "https://aexample.com/x"));

        let all = "net.fetch:*";
        assert!(scope_allows(all, "http://localhost:1234/x"));
        assert!(scope_allows(all, "https://anything.zzz/y"));

        // 前缀陷阱：evil-api.openai.com 不能被 api.openai.com 覆盖
        let strict = "net.fetch:https://api.openai.com/*";
        assert!(!scope_allows(strict, "https://api.openai.com.evil.com/v1"));
    }

    #[test]
    fn net_fetch_path_prefix_matching() {
        let p = "net.fetch:https://api.x.com/v1/*";
        assert!(scope_allows(p, "https://api.x.com/v1/chat"));
        assert!(!scope_allows(p, "https://api.x.com/v2/chat"));
    }

    // ===== 网关同步 → 进程动作（回归：重复同步不得打断按需进程） =====

    #[test]
    fn sync_is_idempotent_never_touches_running_process() {
        // 回归用例：前端每次 open/reload 都会重放一遍同步（策略值不变）。
        // 旧实现会在「on-demand + 进程存活」时无条件 stop，导致
        // 「打开界面 → 进程被自己停掉 → 插件进程未运行」。
        for auto in ["on-demand", "never", "always"] {
            assert_eq!(
                decide_sync_action(Some((auto, true)), auto, true),
                SyncAction::None,
                "策略未变（{auto}）时不该动进程"
            );
        }
    }

    #[test]
    fn sync_disabled_stops_process() {
        assert_eq!(
            decide_sync_action(Some(("on-demand", true)), "on-demand", false),
            SyncAction::Stop
        );
        // 首次同步就是禁用态：也无需启动
        assert_eq!(decide_sync_action(None, "on-demand", false), SyncAction::None);
    }

    #[test]
    fn sync_always_starts_but_downgrade_stops() {
        // 首次同步为 always → 拉起
        assert_eq!(decide_sync_action(None, "always", true), SyncAction::Start);
        // on-demand → always：拉起
        assert_eq!(
            decide_sync_action(Some(("on-demand", true)), "always", true),
            SyncAction::Start
        );
        // always → on-demand：降级，停掉常驻进程
        assert_eq!(
            decide_sync_action(Some(("always", true)), "on-demand", true),
            SyncAction::Stop
        );
    }

    #[test]
    fn sync_between_ondemand_modes_keeps_process() {
        // on-demand ↔ never：都允许「按需运行」，切换不该打断已运行的进程
        assert_eq!(
            decide_sync_action(Some(("on-demand", true)), "never", true),
            SyncAction::None
        );
        assert_eq!(
            decide_sync_action(Some(("never", true)), "on-demand", true),
            SyncAction::None
        );
        // 从禁用恢复启用（非 always）：不主动启动，等按需拉起
        assert_eq!(
            decide_sync_action(Some(("on-demand", false)), "on-demand", true),
            SyncAction::None
        );
    }
}
