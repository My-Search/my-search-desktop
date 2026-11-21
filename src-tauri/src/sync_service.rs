//! 同步协调服务：**全局传输门** + 跨窗口唤醒 + 还原广播。
//!
//! 三个职责，刻意放在 Rust 侧：
//! 1. **全局传输门**：`with_sync_gate` 保证任何时刻只有一个上传/下载在跑。
//!    前端各窗口的引擎锁只作用于自己进程内；没有这道门，设置窗口与主窗口
//!    同时点「立即同步」会并发 PUT 同一个远端文件。
//! 2. **跨窗口唤醒**：设置窗口只是 UI，没有执行同步的上下文（窗口随时销毁）。
//!    它调 `sync_request` → Rust 向所有窗口广播 `sync://request`，常驻主窗口的
//!    SyncHost 收到后执行；执行结果通过 `sync://status` 广播回面板。
//!    另外 Rust 每 60 秒广播一次 `sync://tick`，用于睡眠唤醒后的兜底检查。
//! 3. **还原提交广播**：还原（云下载 / 本地导入）写回 localStorage 后调
//!    `sync_commit_applied`：递增 epoch 并广播 `sync://applied`，让所有窗口
//!    按新数据重载插件视图、独立插件窗口、后台进程，同时丢弃旧回调。
//!    广播带 `scope`（`all` / `plugins` / `config`）：只还原配置时不打断插件。

use std::future::Future;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex as AsyncMutex;

use crate::sync_state;

/// 唤醒常驻主窗口执行一轮同步（trigger: manual / onChange / background / initial…）
pub const EVENT_SYNC_REQUEST: &str = "sync://request";
/// 同步状态广播（由主窗口 SyncHost 发出，设置窗口订阅）
#[allow(dead_code)]
pub const EVENT_SYNC_STATUS: &str = "sync://status";
/// 用户对「首次连接/冲突」的选择（设置窗口 → 常驻主窗口）
pub const EVENT_SYNC_CHOICE: &str = "sync://choice";
/// Rust 定时心跳（每 60 秒）
pub const EVENT_SYNC_TICK: &str = "sync://tick";
/// 一次还原已经完整应用（localStorage 已写回、文件已落盘）
pub const EVENT_SYNC_APPLIED: &str = "sync://applied";
/// 本机「可同步数据」发生变化（设置项落盘 / 插件数据写入等）
pub const EVENT_SYNC_DATA_CHANGED: &str = "sync://data-changed";

/// 广播「本机可同步数据已改变」。
///
/// 由 Rust 侧的数据写入方调用（设置项落盘、剪贴板索引写入等）：常驻主窗口的
/// SyncHost 收到后按用户的 `autoOnChange` 安排一轮同步（5 秒节流合并连续写入）。
///
/// 为什么需要它：localStorage 的变化能通过前端 `storageSet` 钩子捕获，但
/// **settings.json 与 plugin-data/ 下的文件**不经过前端，没有这条广播时
/// 这些改动要等 30 分钟兜底轮询才会上传。
pub fn notify_data_changed(app: &AppHandle) {
    let _ = app.emit(EVENT_SYNC_DATA_CHANGED, json!({ "at": now_ms() }));
}

static SYNC_GATE: OnceLock<AsyncMutex<()>> = OnceLock::new();

fn gate() -> &'static AsyncMutex<()> {
    SYNC_GATE.get_or_init(|| AsyncMutex::new(()))
}

/// 在全局传输门内执行一次远端操作。
///
/// 用「传入 future」而不是返回 guard：guard 的生命周期无法跨命令边界，
/// 而 future 在门内被 await 到结束，语义最清晰。
pub async fn with_sync_gate<T, F>(fut: F) -> Result<T, String>
where
    F: Future<Output = Result<T, String>>,
{
    let _guard = gate().lock().await;
    fut.await
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 请求执行一轮同步（设置窗口 / 托盘 / 插件均可调用）。
///
/// 不等待执行结果：主窗口收到广播后自行执行，并把状态通过 `sync://status`
/// 广播给所有窗口。这样设置窗口关掉也不会留下悬挂的 IPC 调用。
#[tauri::command]
pub fn sync_request(app: AppHandle, trigger: Option<String>) -> Value {
    let trigger = trigger
        .unwrap_or_else(|| "manual".into())
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect::<String>();
    let trigger = if trigger.is_empty() { "manual".into() } else { trigger };
    let at = now_ms();
    let _ = app.emit(EVENT_SYNC_REQUEST, json!({ "trigger": trigger, "at": at }));
    json!({ "accepted": true, "trigger": trigger, "at": at })
}

/// 用户对「首次连接 / 冲突」做出选择：`local`（本机覆盖远端）或 `remote`（远端覆盖本机）。
///
/// 设置窗口不执行同步，只把选择广播给常驻主窗口；主窗口的 SyncHost 收到后
/// 继续本轮同步。
///
/// `plugin_ids`：省略 = 全局选择（首次连接 / 「全部按这边来」）；给定则只对这几个
/// 插件生效（`""` 表示 core / 软件主体配置）。冲突按插件隔离，其它插件的冲突
/// 继续挂起，本轮照常同步其余分片。
#[tauri::command]
pub fn sync_resolve_choice(
    app: AppHandle,
    choice: String,
    plugin_ids: Option<Vec<String>>,
) -> Result<Value, String> {
    let choice = match choice.as_str() {
        "remote" => "remote",
        "local" => "local",
        other => return Err(format!("未知的同步选择: {other}")),
    };
    app.emit(
        EVENT_SYNC_CHOICE,
        json!({ "choice": choice, "pluginIds": plugin_ids, "at": now_ms() }),
    )
    .map_err(|e| format!("广播同步选择失败: {e}"))?;
    Ok(json!({ "choice": choice }))
}

/// 提交一次「还原已应用」：递增 epoch 并广播。
///
/// `source`：`"cloud"` / `"import"` / `"first-connect"`，只用于提示与日志。
/// `scope`：`"all"` / `"plugins"` / `"config"`，告诉各窗口需要刷新到什么程度——
/// 只还原了用户配置时不必释放/重载插件视图。未知值按 `all` 处理（宁可多刷新）。
/// 返回新 epoch，调用方应把它记进本轮状态，用来丢弃更早的回调。
#[tauri::command]
pub fn sync_commit_applied(
    app: AppHandle,
    source: Option<String>,
    scope: Option<String>,
) -> Result<Value, String> {
    let epoch = sync_state::bump_epoch(&app)?;
    let source = source.unwrap_or_else(|| "import".into());
    let scope = match scope.as_deref() {
        Some("plugins") => "plugins",
        Some("config") => "config",
        _ => "all",
    };
    let _ = app.emit(
        EVENT_SYNC_APPLIED,
        json!({ "epoch": epoch, "source": source, "scope": scope, "at": now_ms() }),
    );
    Ok(json!({ "epoch": epoch, "source": source, "scope": scope }))
}

/// 启动 Rust 侧同步心跳：每 60 秒广播一次 `sync://tick`。
///
/// 为什么需要它：前端 `setInterval` 在系统睡眠期间不推进，唤醒后可能错过
/// 用户设置的兜底间隔；Rust 侧用一个粗粒度心跳把「该检查了」的判定交给
/// 常驻主窗口（它自己按 `intervalMinutes` 决定是否真的执行）。
pub fn start_tick(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // 启动瞬间先来一次：覆盖「应用刚启动，前端监听尚未就绪」的竞态——
        // 前端绑定监听后会主动跑一次 initial，tick 只是兜底，丢了也无妨。
        loop {
            let _ = app.emit(EVENT_SYNC_TICK, json!({ "at": now_ms() }));
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        }
    });
}
