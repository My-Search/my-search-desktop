//! 目录挂载插件（开发模式）的**文件监听与自动重载**。
//!
//! ## 为什么单独成模块
//!
//! 「从目录挂载」的插件（`plugins/<id>/.dev-source` 指向源目录）在开发时
//! 会被反复编辑——每次改完都要回设置面板手动重挂、或重启应用，才能看到效果。
//! 本模块负责：**盯着这些源目录，变了就广播一条带防抖的事件**，由前端决定
//! 重挂界面 / 重新合成搜索项 / 重启后台进程。
//!
//! ## 职责边界（刻意的）
//!
//! - Rust 侧**只做检测与广播**，不做重载动作：重载要动注册表、插件项、视图、
//!   后台进程——这些都是前端的职责（注册表是前端的唯一真相源）。
//! - 检测是**纯文件系统**行为，不读注册表：因此「目录已在变化、但应用还没被
//!   告知挂载」也能工作，且设置窗口与搜索窗口各自按需消费事件。
//! - 只监听**目录挂载**的插件（`source.dev`），从文件安装的插件没有源目录可盯，
//!   也不会被这个模块看见。
//!
//! ## 工程约束
//!
//! - 依赖 `notify`（跨平台文件监听）。事件在通知线程上产生，回调里**只做
//!   过滤与入队**，绝不阻塞通知线程。
//! - 一次保存往往产生多个事件（编辑器「先写临时文件再 rename」、IDE 成批
//!   写入），因此按「插件 id」合并：静默期 `DEBOUNCE_MS` 之后才广播一次。
//! - 监听失败（目录被删、权限不足）只记日志：自动重载是**增强**，
//!   坏了不该影响插件本身可用。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// 开发插件变化事件名（两个窗口都监听；载荷见 `PluginChangedPayload`）
pub const EVENT_PLUGIN_CHANGED: &str = "plugin://dev-changed";

/// 静默期：最后一次文件事件后再等这么久才广播（合并保存时的连环事件）
pub const DEBOUNCE_MS: u64 = 350;
/// 派发线程扫描间隔（决定防抖精度；扫描本身很轻，不构成 CPU 压力）
const SCAN_INTERVAL_MS: u64 = 100;
/// 单次广播里携带的路径上限（防「整个 node_modules 被重装」刷爆事件）
const MAX_PATHS: usize = 32;

/// 一次「开发插件发生变化」的广播载荷
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginChangedPayload {
    /// 变化的插件 id
    pub plugin_id: String,
    /// 源目录（绝对路径）
    pub dir: String,
    /// 本次变化影响到的相对路径（去重、最多 `MAX_PATHS` 条；可能为空 = 只看目录）
    pub paths: Vec<String>,
    /// 是否只涉及前端文件（html/js/css/图标…）——前端据此决定要不要重启后台进程
    pub frontend_only: bool,
    /// 广播时间（毫秒时间戳；前端可据此丢弃过期事件）
    pub at: u64,
}

/// 一次待广播的变化（防抖窗口内不断合并）
#[derive(Debug, Clone)]
struct Pending {
    dir: String,
    paths: Vec<String>,
    frontend_only: bool,
    last_seen: Instant,
}

/// 全局监听表（watcher 必须持有，drop 即停止监听）
static WATCHED: Mutex<Option<HashMap<String, (PathBuf, RecommendedWatcher)>>> = Mutex::new(None);

/// 待广播队列（防抖合并结果），由派发线程消费
static PENDING: Mutex<Option<HashMap<String, Pending>>> = Mutex::new(None);

/// 派发线程的停止信号（持有 Sender；置空即关闭通道 → 线程退出）
static DISPATCH_STOP: Mutex<Option<Sender<()>>> = Mutex::new(None);

/// 是否只涉及「前端可热重载」的文件（不触发后台进程重启）
///
/// 判定规则（保守优先）：`backend/` 下的一切、以及清单 `plugin.json` 之外的
/// 可执行文件都算**非前端**。清单之所以不算前端：它可能改了
/// `backend.entry` / `autostart` / 搜索项，前端需要重读清单做完整调和。
fn is_frontend_path(rel: &str) -> bool {
    let normalized = rel.replace('\\', "/");
    if normalized == "plugin.json" {
        return false;
    }
    if normalized.starts_with("backend/") {
        return false;
    }
    // 归档 / 可执行产物出现在源目录里时，宁可做完整调和
    !(normalized.ends_with(".exe") || normalized.ends_with(".dll"))
}

/// 把变化路径合并进待广播队列（由通知线程调用，只做内存操作）
fn enqueue(plugin_id: &str, dir: &Path, rel: Option<String>) {
    let Ok(mut guard) = PENDING.lock() else {
        return;
    };
    let map = guard.get_or_insert_with(HashMap::new);
    let now = Instant::now();
    let entry = map.entry(plugin_id.to_string()).or_insert_with(|| Pending {
        dir: dir.to_string_lossy().to_string(),
        paths: Vec::new(),
        frontend_only: true,
        last_seen: now,
    });
    entry.last_seen = now;
    match rel {
        Some(rel) => {
            // frontend_only 是「与」关系：只要有一条后端路径，就要做完整调和
            entry.frontend_only = entry.frontend_only && is_frontend_path(&rel);
            if entry.paths.len() < MAX_PATHS && !entry.paths.iter().any(|p| p == &rel) {
                entry.paths.push(rel);
            }
        }
        // 目录级事件（拿不到相对路径）：按「可能影响一切」处理
        None => entry.frontend_only = false,
    }
}

/// 从事件路径里算出相对源目录的路径（拿不到时返回 None）
fn relative_of(dir: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(dir).ok()?;
    let s = rel.to_string_lossy().replace('\\', "/");
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// 为某个源目录建立一个递归监听
fn watch_dir(dir: &Path, plugin_id: &str) -> notify::Result<RecommendedWatcher> {
    let id = plugin_id.to_string();
    let base = dir.to_path_buf();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else {
            return;
        };
        // 忽略纯「访问」事件：读文件不该触发重载
        if matches!(event.kind, notify::EventKind::Access(_)) {
            return;
        }
        let rel = event.paths.iter().find_map(|p| relative_of(&base, p));
        enqueue(&id, &base, rel);
    })?;
    watcher.watch(dir, RecursiveMode::Recursive)?;
    Ok(watcher)
}

/// 按 id 注册（或替换）一个开发插件的监听。
///
/// **幂等**：已经在盯着同一个目录时直接返回——前端在启动阶段会对每个
/// 开发插件登记一次，重复登记不该重建 watcher（会丢事件窗口）。
///
/// 目录不存在 / 不可读时返回错误（调用方只记日志）。
pub fn watch_plugin(plugin_id: &str, dir: &Path) -> Result<(), String> {
    if !dir.is_dir() {
        return Err(format!("目录不存在: {}", dir.display()));
    }
    // 已监听同一目录 → 幂等返回
    if let Ok(guard) = WATCHED.lock() {
        if let Some(table) = guard.as_ref() {
            if let Some((existing, _)) = table.get(plugin_id) {
                if existing == dir {
                    return Ok(());
                }
            }
        }
    }
    let watcher = watch_dir(dir, plugin_id).map_err(|e| format!("监听目录失败: {e}"))?;
    let mut guard = WATCHED.lock().map_err(|_| "监听表不可用".to_string())?;
    let table = guard.get_or_insert_with(HashMap::new);
    // 重复注册即替换（旧 watcher drop 后自动停止监听）
    table.insert(plugin_id.to_string(), (dir.to_path_buf(), watcher));
    Ok(())
}

/// 取消某个插件的监听（卸载 / 改为从文件安装 / 应用退出时调用）
pub fn unwatch_plugin(plugin_id: &str) {
    if let Ok(mut guard) = WATCHED.lock() {
        if let Some(table) = guard.as_mut() {
            table.remove(plugin_id);
        }
    }
    if let Ok(mut guard) = PENDING.lock() {
        if let Some(map) = guard.as_mut() {
            map.remove(plugin_id);
        }
    }
}

/// 清空全部监听（应用退出时调用，保证文件句柄释放）
pub fn unwatch_all() {
    if let Ok(mut guard) = WATCHED.lock() {
        if let Some(table) = guard.as_mut() {
            table.clear();
        }
    }
    if let Ok(mut guard) = PENDING.lock() {
        if let Some(map) = guard.as_mut() {
            map.clear();
        }
    }
}

/// 当前正在监听的插件数（面板展示 / 调试用）
#[allow(dead_code)]
pub fn watched_count() -> usize {
    WATCHED
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|t| t.len()))
        .unwrap_or(0)
}

/// 取正在被监听的插件 id（面板展示 / 调试用）
#[allow(dead_code)]
pub fn watched_plugin_ids() -> Vec<String> {
    WATCHED
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|t| t.keys().cloned().collect()))
        .unwrap_or_default()
}

/// 判断某个 id 是否正在被监听（前端「从目录挂载」后确认监听是否生效）
#[allow(dead_code)]
pub fn is_watched(plugin_id: &str) -> bool {
    WATCHED
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|t| t.contains_key(plugin_id)))
        .unwrap_or(false)
}

/// 现在时刻（毫秒时间戳）
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 取出「静默期已过」的待广播项（同时从队列里摘掉）
fn take_ready() -> Vec<PluginChangedPayload> {
    let now = Instant::now();
    let mut out = Vec::new();
    let Ok(mut guard) = PENDING.lock() else {
        return out;
    };
    let Some(map) = guard.as_mut() else {
        return out;
    };
    let expired: Vec<String> = map
        .iter()
        .filter(|(_, p)| now.duration_since(p.last_seen) >= Duration::from_millis(DEBOUNCE_MS))
        .map(|(id, _)| id.clone())
        .collect();
    for id in expired {
        if let Some(pending) = map.remove(&id) {
            out.push(PluginChangedPayload {
                plugin_id: id,
                dir: pending.dir,
                paths: pending.paths,
                frontend_only: pending.frontend_only,
                at: now_ms(),
            });
        }
    }
    out
}

/// 启动派发线程：周期扫描防抖队列，静默期到达即广播事件。
///
/// 只启动一次（重复调用直接返回）。线程随 `stop_dispatch()` 关闭通道而退出。
pub fn start_dispatch(app: AppHandle) {
    let mut guard = match DISPATCH_STOP.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if guard.is_some() {
        return;
    }
    let (tx, rx) = channel::<()>();
    *guard = Some(tx);
    drop(guard);

    let spawned = std::thread::Builder::new()
        .name("plugin-watch-dispatch".into())
        .spawn(move || loop {
            match rx.recv_timeout(Duration::from_millis(SCAN_INTERVAL_MS)) {
                // 停止信号或超时都走同一条路：超时时扫一遍队列
                Ok(()) => {}
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            for payload in take_ready() {
                let _ = app.emit(EVENT_PLUGIN_CHANGED, payload);
            }
        });
    if let Err(e) = spawned {
        eprintln!("[插件] 启动变更派发线程失败: {e}");
        if let Ok(mut guard) = DISPATCH_STOP.lock() {
            *guard = None;
        }
    }
}

/// 关掉派发通道（应用退出时调用）
pub fn stop_dispatch() {
    if let Ok(mut guard) = DISPATCH_STOP.lock() {
        *guard = None;
    }
}

#[cfg(test)]
mod tests {
    use super::{is_frontend_path, relative_of, DEBOUNCE_MS, MAX_PATHS};
    use std::path::Path;

    #[test]
    fn frontend_vs_backend_paths() {
        assert!(is_frontend_path("ui/detail.html"));
        assert!(is_frontend_path("ui/index.js"));
        assert!(is_frontend_path("ui/detail.css"));
        assert!(is_frontend_path("icon.svg"));
        assert!(!is_frontend_path("backend/index.js"));
        assert!(!is_frontend_path("backend/app.exe"));
        assert!(!is_frontend_path("plugin.json"));
        // 反斜杠形态（Windows 事件路径）
        assert!(!is_frontend_path("backend\\index.js"));
    }

    #[test]
    fn relative_path_of_events() {
        let base = Path::new("/tmp/p");
        assert_eq!(
            relative_of(base, Path::new("/tmp/p/ui/a.js")).as_deref(),
            Some("ui/a.js")
        );
        assert_eq!(relative_of(base, Path::new("/tmp/other/x")).as_deref(), None);
        assert_eq!(relative_of(base, base), None);
    }

    #[test]
    fn debounce_and_caps_are_reasonable() {
        // 防抖窗口要能合并「编辑器先写临时文件再 rename」的连环事件，
        // 又不能长到让开发者觉得「改了没反应」
        assert!((200..=1500).contains(&DEBOUNCE_MS));
        // 路径上限要够表达一次真实保存（HTML+CSS+JS），又不能无界
        assert!((8..=256).contains(&MAX_PATHS));
    }
}
