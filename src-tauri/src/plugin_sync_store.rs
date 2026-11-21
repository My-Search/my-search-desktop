//! 插件「云数据 store」——`chrome.storage.sync` 的等价物。
//!
//! ## 为什么需要它
//!
//! 宿主原有的三套插件存储各有定位：
//!
//! | 存储 | 落点 | 进云备份 | 配额 |
//! |------|------|----------|------|
//! | `ms.store.get/set` | localStorage `PLUGIN_DATA:*` | 是（随 localStorage 快照） | 随 localStorage 总配额 |
//! | `ms.store.readJson/writeJson` | `plugin-data/<id>/kv/*.json` | 是 | 单文件 64MB，无总量约束 |
//! | **`ms.store.sync.*`（本模块）** | `sync-store/<id>.json` | 是（独立分区，带配额） | 见下方常量 |
//!
//! 旧实现把 `plugin-data/<id>/` **整个目录**打进 `.msbackup`：插件随手写进来的
//! 剪贴板图片、历史索引、录屏 mp4、索引缓存全都会上传到云端，并且
//! `KEEP_BACKUPS = 12` 份本地留底下最坏能攒到几个 GB。用户要的是「像 Chrome
//! 登录后同步扩展那样」：**插件主体 + 一小份声明式的小数据**上云，其余留在本机。
//!
//! ## 设计取舍
//!
//! - **配额是硬的**：写入超过配额直接报错（带当前用量与上限），不做「静默截断」，
//!   因为截断会让插件读到半份数据，比报错更难排查。
//! - **按插件隔离的文件**（`sync-store/<插件id>.json`）：一个插件写坏自己的文件
//!   不影响别人；还原时也可以按插件粒度判断版本守卫。
//! - **键值都是纯 JSON**：与归档「人可读明文」的约定一致，用户解压就能看。
//! - **写入即广播** `plugin-sync://changed`：常驻主窗口的 `SyncHost` 据此安排一轮
//!   自动同步，否则插件写完要等 30 分钟兜底轮询才上云。
//!
//! ## 权限
//!
//! 沿用 `store` 权限（与 `ms.store` 同一套「读写插件私有数据」的语义），不新增权限串，
//! 避免已安装插件因为多了个权限而全部需要重新授权。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

/// 插件云数据目录名（应用数据目录下，与 `plugin-data` / `plugins` 平级）
pub(crate) const SYNC_STORE_DIR: &str = "sync-store";
/// 云数据变化事件（`SyncHost` 订阅它安排自动同步）
pub(crate) const EVENT_PLUGIN_SYNC_CHANGED: &str = "plugin-sync://changed";
/// 插件私有数据目录名（统计「本机数据占用」用，与 plugin_host.rs 保持一致）
const PLUGIN_DATA_DIR: &str = "plugin-data";

/// 单个键上限（序列化后的字节数）。Chrome 是 8KB/项，这里给到 64KB：
/// 本应用的插件常把「用户配置 + 一份小索引」整体存成一项。
pub const MAX_ITEM_BYTES: usize = 64 * 1024;
/// 单个插件的云数据总量上限
pub const MAX_PLUGIN_BYTES: usize = 512 * 1024;
/// 所有插件合计的云数据上限（超出时写入失败，提示用户清理）
pub const MAX_TOTAL_BYTES: usize = 8 * 1024 * 1024;
/// 单个插件的键数上限（防「用一万个小键绕过体积统计」）
pub const MAX_KEYS: usize = 500;
/// 文件结构版本（未来若改结构，读到低版本时迁移）
const STORE_VERSION: u32 = 1;

fn err(msg: impl Into<String>) -> String {
    msg.into()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 一份插件的云数据文档（`sync-store/<插件id>.json` 的落盘结构）
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStoreDoc {
    /// 结构版本
    #[serde(default)]
    pub version: u32,
    /// 最后一次写入时间（毫秒）
    #[serde(default)]
    pub updated_at: u64,
    /// 键 → 值（键排序保证同一份数据序列化结果稳定，摘要/差异比较不会抖动）
    #[serde(default)]
    pub items: BTreeMap<String, Value>,
}

impl SyncStoreDoc {
    fn normalized(mut self) -> Self {
        if self.version == 0 {
            self.version = STORE_VERSION;
        }
        self
    }
}

/// 云数据根目录（不存在则创建）
pub fn store_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| err(format!("取应用数据目录失败: {e}")))?
        .join(SYNC_STORE_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| err(format!("创建插件云数据目录失败: {e}")))?;
    Ok(dir)
}

/// 某个插件的云数据文件路径
fn doc_path(app: &AppHandle, plugin_id: &str) -> Result<PathBuf, String> {
    Ok(store_root(app)?.join(format!("{plugin_id}.json")))
}

/// 校验存储键：拒绝路径分隔符、控制字符、上跳与点开头的键（键只是 JSON 字段名，
/// 但仍按「可能被拼进日志/文件名」的严格口径校验，避免日志注入与路径歧义）。
fn validate_key(key: &str) -> Result<String, String> {
    let k = key.trim();
    if k.is_empty() {
        return Err(err("缺少存储键"));
    }
    if k.chars().count() > 128 {
        return Err(err("存储键过长（上限 128 个字符）"));
    }
    if k.starts_with('.') || k.contains("..") {
        return Err(err(format!("非法存储键: {key}")));
    }
    if k.contains('/') || k.contains('\\') || k.chars().any(|c| c.is_control()) {
        return Err(err(format!("非法存储键: {key}")));
    }
    Ok(k.to_string())
}

/// 读取文档；文件不存在返回空文档，内容损坏时也退化为空（不让一次写坏阻断插件启动）。
fn read_doc(app: &AppHandle, plugin_id: &str) -> Result<SyncStoreDoc, String> {
    let path = doc_path(app, plugin_id)?;
    if !path.exists() {
        return Ok(SyncStoreDoc::normalized(SyncStoreDoc::default()));
    }
    let text = std::fs::read_to_string(&path)
        .map_err(|e| err(format!("读取插件云数据失败: {e}")))?;
    match serde_json::from_str::<SyncStoreDoc>(&text) {
        Ok(doc) => Ok(doc.normalized()),
        Err(e) => {
            eprintln!("插件云数据文件损坏（按空数据处理）: {}: {e}", path.display());
            Ok(SyncStoreDoc::normalized(SyncStoreDoc::default()))
        }
    }
}

/// 序列化后的字节数
fn doc_bytes(doc: &SyncStoreDoc) -> usize {
    serde_json::to_vec(doc).map(|b| b.len()).unwrap_or(usize::MAX)
}

/// 原子写入：先写 `.tmp` 再替换（断电不会留半截 JSON；Windows 上替换失败时退回覆盖写）。
fn write_doc(app: &AppHandle, plugin_id: &str, doc: &SyncStoreDoc) -> Result<(), String> {
    let path = doc_path(app, plugin_id)?;
    let bytes = serde_json::to_vec_pretty(doc).map_err(|e| err(format!("序列化云数据失败: {e}")))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &bytes).map_err(|e| err(format!("写入临时文件失败: {e}")))?;
    if std::fs::rename(&tmp, &path).is_err() {
        std::fs::write(&path, &bytes).map_err(|e| err(format!("写入插件云数据失败: {e}")))?;
        let _ = std::fs::remove_file(&tmp);
    }
    Ok(())
}

/// 目录内所有文件字节数（取不到按 0）
fn dir_bytes(dir: &Path) -> u64 {
    let mut total = 0u64;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            total += dir_bytes(&path);
        } else if let Ok(meta) = entry.metadata() {
            total += meta.len();
        }
    }
    total
}

/// 其它插件已占用的云数据字节数（总量配额用）
fn total_bytes_except(app: &AppHandle, plugin_id: &str) -> u64 {
    let Ok(root) = store_root(app) else {
        return 0;
    };
    let Ok(entries) = std::fs::read_dir(&root) else {
        return 0;
    };
    let mut total = 0u64;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with(".tmp") {
            continue;
        }
        if name == format!("{plugin_id}.json") {
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            total += meta.len();
        }
    }
    total
}

/// 组装一份「用量」报告（命令返回值 / 面板展示共用）
fn usage_json(app: &AppHandle, plugin_id: &str, doc: &SyncStoreDoc) -> Value {
    let used = doc_bytes(doc) as u64;
    let others = total_bytes_except(app, plugin_id);
    json!({
        "pluginId": plugin_id,
        "bytes": used,
        "keys": doc.items.len(),
        "itemQuotaBytes": MAX_ITEM_BYTES,
        "pluginQuotaBytes": MAX_PLUGIN_BYTES,
        "keysQuota": MAX_KEYS,
        "totalBytes": used + others,
        "totalQuotaBytes": MAX_TOTAL_BYTES,
    })
}

fn check_quota(app: &AppHandle, plugin_id: &str, doc: &SyncStoreDoc, key: &str) -> Result<(), String> {
    if let Some(item) = doc.items.get(key) {
        let item_bytes = serde_json::to_vec(item).map(|b| b.len()).unwrap_or(usize::MAX);
        if item_bytes > MAX_ITEM_BYTES {
            return Err(err(format!(
                "「{key}」超出单键上限（{}KB），请拆分成多个小键或改存插件本地",
                MAX_ITEM_BYTES / 1024
            )));
        }
    }
    if doc.items.len() > MAX_KEYS {
        return Err(err(format!(
            "云数据键数超出上限（{MAX_KEYS} 个），请合并或清理旧键"
        )));
    }
    let used = doc_bytes(doc);
    if used > MAX_PLUGIN_BYTES {
        return Err(err(format!(
            "插件云数据超出上限（{}KB，当前 {}KB）",
            MAX_PLUGIN_BYTES / 1024,
            used / 1024
        )));
    }
    let others = total_bytes_except(app, plugin_id);
    if (used as u64).saturating_add(others) > MAX_TOTAL_BYTES as u64 {
        return Err(err(format!(
            "所有插件的云数据合计超出上限（{}MB），请清理不常用的插件云数据",
            MAX_TOTAL_BYTES / (1024 * 1024)
        )));
    }
    Ok(())
}

fn emit_changed(app: &AppHandle, plugin_id: &str, key: Option<&str>, removed: bool) {
    let _ = app.emit(
        EVENT_PLUGIN_SYNC_CHANGED,
        json!({ "pluginId": plugin_id, "key": key, "removed": removed }),
    );
}

// ===================== 对插件暴露的命令 =====================

/// 读取某插件全部云数据（键值对象）
#[tauri::command]
pub fn plugin_sync_store_get_all(
    app: AppHandle,
    plugin_id: String,
) -> Result<Value, String> {
    crate::plugin_host::require_grant(&plugin_id, "store")?;
    let doc = read_doc(&app, &plugin_id)?;
    Ok(Value::Object(doc.items.into_iter().collect()))
}

/// 读取某插件的一个云数据键（不存在返回 null）
#[tauri::command]
pub fn plugin_sync_store_get(
    app: AppHandle,
    plugin_id: String,
    key: String,
) -> Result<Option<Value>, String> {
    crate::plugin_host::require_grant(&plugin_id, "store")?;
    let key = validate_key(&key)?;
    let doc = read_doc(&app, &plugin_id)?;
    Ok(doc.items.get(&key).cloned())
}

/// 写入一个云数据键（受单键 / 单插件 / 全局三道配额约束），返回最新用量
#[tauri::command]
pub fn plugin_sync_store_set(
    app: AppHandle,
    plugin_id: String,
    key: String,
    value: Value,
) -> Result<Value, String> {
    crate::plugin_host::require_grant(&plugin_id, "store")?;
    let key = validate_key(&key)?;
    let mut doc = read_doc(&app, &plugin_id)?;
    doc.items.insert(key.clone(), value);
    doc.updated_at = now_ms();
    doc.version = STORE_VERSION;
    check_quota(&app, &plugin_id, &doc, &key)?;
    write_doc(&app, &plugin_id, &doc)?;
    emit_changed(&app, &plugin_id, Some(&key), false);
    Ok(usage_json(&app, &plugin_id, &doc))
}

/// 删除一个云数据键；返回它原本是否存在
#[tauri::command]
pub fn plugin_sync_store_remove(
    app: AppHandle,
    plugin_id: String,
    key: String,
) -> Result<bool, String> {
    crate::plugin_host::require_grant(&plugin_id, "store")?;
    let key = validate_key(&key)?;
    let mut doc = read_doc(&app, &plugin_id)?;
    let existed = doc.items.remove(&key).is_some();
    if existed {
        doc.updated_at = now_ms();
        doc.version = STORE_VERSION;
        write_doc(&app, &plugin_id, &doc)?;
        emit_changed(&app, &plugin_id, Some(&key), true);
    }
    Ok(existed)
}

/// 清空某插件的全部云数据
#[tauri::command]
pub fn plugin_sync_store_clear(app: AppHandle, plugin_id: String) -> Result<(), String> {
    crate::plugin_host::require_grant(&plugin_id, "store")?;
    let doc = SyncStoreDoc {
        version: STORE_VERSION,
        updated_at: now_ms(),
        items: BTreeMap::new(),
    };
    write_doc(&app, &plugin_id, &doc)?;
    emit_changed(&app, &plugin_id, None, true);
    Ok(())
}

/// 查询某插件的云数据用量（键数 / 字节数 / 配额）
#[tauri::command]
pub fn plugin_sync_store_usage(app: AppHandle, plugin_id: String) -> Result<Value, String> {
    crate::plugin_host::require_grant(&plugin_id, "store")?;
    let doc = read_doc(&app, &plugin_id)?;
    Ok(usage_json(&app, &plugin_id, &doc))
}

/// 所有插件的云数据占用总览（设置面板展示用；不需要插件权限，只有 id 与体积，
/// 不含任何键值内容）。
///
/// 同时列出**只有本机数据、没有云数据**的插件：用户在面板里能直接看到
/// 「剪贴板 10MB 留在本机 / 云端 0B」，而不是疑惑「为什么它没上云」。
#[tauri::command]
pub fn plugin_sync_store_stats(app: AppHandle) -> Result<Value, String> {
    let root = store_root(&app)?;
    let data_dir = app.path().app_data_dir().map_err(|e| err(format!("取应用数据目录失败: {e}")))?;

    // 1) 云数据文件（`sync-store/<id>.json`）
    let mut cloud: BTreeMap<String, u64> = BTreeMap::new();
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".json") || name.ends_with(".tmp") {
                continue;
            }
            let Some(id) = name.strip_suffix(".json") else {
                continue;
            };
            let bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
            cloud.insert(id.to_string(), bytes);
        }
    }

    // 2) 本机 plugin-data 目录（不进云的那部分）
    let mut local: BTreeMap<String, u64> = BTreeMap::new();
    let plugin_data = data_dir.join(PLUGIN_DATA_DIR);
    if let Ok(entries) = std::fs::read_dir(&plugin_data) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || !entry.path().is_dir() {
                continue;
            }
            local.insert(name, dir_bytes(&entry.path()));
        }
    }

    let mut ids: Vec<String> = cloud.keys().chain(local.keys()).cloned().collect();
    ids.sort();
    ids.dedup();

    let mut plugins: Vec<Value> = Vec::new();
    let mut total: u64 = 0;
    for id in &ids {
        let cloud_bytes = cloud.get(id).copied().unwrap_or(0);
        total += cloud_bytes;
        let keys = if cloud_bytes > 0 {
            read_doc(&app, id).map(|d| d.items.len()).unwrap_or(0)
        } else {
            0
        };
        plugins.push(json!({
            "pluginId": id,
            "cloudBytes": cloud_bytes,
            "keys": keys,
            "localBytes": local.get(id).copied().unwrap_or(0),
        }));
    }

    Ok(json!({
        "plugins": plugins,
        "totalBytes": total,
        "totalQuotaBytes": MAX_TOTAL_BYTES,
        "pluginQuotaBytes": MAX_PLUGIN_BYTES,
        "itemQuotaBytes": MAX_ITEM_BYTES,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsafe_keys() {
        assert!(validate_key("theme").is_ok());
        assert!(validate_key("  theme  ").unwrap() == "theme");
        assert!(validate_key("").is_err());
        assert!(validate_key("a/b").is_err());
        assert!(validate_key("a\\b").is_err());
        assert!(validate_key("..x").is_err());
        assert!(validate_key(".hidden").is_err());
        assert!(validate_key("ok.key-1_ish").is_ok());
    }

    #[test]
    fn doc_serialization_is_stable_and_counts_bytes() {
        let mut doc = SyncStoreDoc::default();
        doc.items.insert("b".into(), json!(1));
        doc.items.insert("a".into(), json!({"x": true}));
        let bytes = doc_bytes(&doc);
        assert!(bytes > 0);
        // BTreeMap 排序：a 在 b 前
        let text = serde_json::to_string(&doc).unwrap();
        let a = text.find("\"a\"").unwrap();
        let b = text.find("\"b\"").unwrap();
        assert!(a < b);
    }

    #[test]
    fn quota_constants_are_sane() {
        assert!(MAX_ITEM_BYTES <= MAX_PLUGIN_BYTES);
        assert!(MAX_PLUGIN_BYTES <= MAX_TOTAL_BYTES);
        assert!(MAX_KEYS > 0);
    }
}
