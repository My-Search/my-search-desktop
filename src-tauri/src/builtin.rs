//! 内置插件：随应用资源分发、可卸载且升级不复活。
//!
//! 交付形态（P1）：三个官方插件打包为 `.msplugin` 放进 `resources/plugins/`，
//! 由本模块在启动时把「可用但未安装」的 id 广播给前端，前端复用既有
//! 「从文件安装」管线（`install.ts` 解包 → 校验清单 → 权限确认 → `plugin_install`
//! 原子落盘）完成安装。
//!
//! **为什么 Rust 不解包**：ZIP 安全校验（路径穿越 / 符号链接 / 体积上限）
//! 只在 `package.ts` 实现了一份；若在 Rust 再写一份解包器，两份实现必然漂移，
//! 这正是历史上出错最多的地方。因此 Rust 只负责白名单、`removed` 标记与
//! 资源路径，安装动作走前端既有管线（见计划 §7「P1 修正设计」）。
//!
//! 卸载不复活：用户卸载内置插件时写 `internal/builtins.json` 的 `removed`
//! 列表；bootstrap 对 `removed` 里的 id 一律跳过（Firefox「用户决定优先」）。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::Manager;

/// 允许随资源引导的内置插件 id（防资源被篡改成任意插件走免确认通道）。
pub(crate) const BUILTIN_ALLOWLIST: [&str; 2] = [
    "com.mysearch.pi-agent",
    "com.mysearch.market",
];

/// `internal/builtins.json` 的 schema 版本
const BUILTINS_SCHEMA_VERSION: u32 = 1;
/// 资源目录（相对 resource_dir）
const BUNDLE_PLUGINS_DIR: &str = "resources/plugins";
/// 数据目录下的内部状态目录（与备份的 internal/ 分区对应）
const INTERNAL_DIR: &str = "internal";
/// 内部状态文件名
const BUILTINS_FILE: &str = "builtins.json";

/// 一個内置插件资源条目
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BundledPlugin {
    /// 插件 id（= 资源文件名去掉 .msplugin）
    pub id: String,
    /// 资源文件的绝对路径（前端拿它走「从文件安装」管线）
    pub resource_path: String,
}

/// 卸载标记文件（`internal/builtins.json`）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuiltinsState {
    #[serde(default = "default_schema_version")]
    schema_version: u32,
    /// 用户卸载过的内置插件 id（升级不复活）
    #[serde(default)]
    removed: Vec<String>,
}

fn default_schema_version() -> u32 {
    BUILTINS_SCHEMA_VERSION
}

impl BuiltinsState {
    fn normalize(&mut self) {
        self.schema_version = BUILTINS_SCHEMA_VERSION;
        // 只保留白名单内的 id：手编文件写进来的未知 id 不参与语义
        self.removed.retain(|id| is_builtin(id));
        self.removed.sort();
        self.removed.dedup();
    }
}

fn internal_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("取应用数据目录失败: {e}"))?
        .join(INTERNAL_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建内部状态目录失败: {e}"))?;
    Ok(dir)
}

fn builtins_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(internal_dir(app)?.join(BUILTINS_FILE))
}

/// 读取卸载标记（缺失 / 损坏时视为空集：最坏情况是把卸载过的插件再装一遍，
/// 用户在面板里再卸一次即可，不阻断启动）
fn load_state(app: &tauri::AppHandle) -> BuiltinsState {
    let Ok(path) = builtins_path(app) else {
        return BuiltinsState::default();
    };
    let mut state = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str::<BuiltinsState>(&t).ok())
        .unwrap_or_default();
    state.normalize();
    state
}

fn save_state(app: &tauri::AppHandle, state: &BuiltinsState) -> Result<(), String> {
    let path = builtins_path(app)?;
    let text = serde_json::to_string_pretty(state).map_err(|e| format!("序列化失败: {e}"))?;
    std::fs::write(&path, text).map_err(|e| format!("写入 {} 失败: {e}", path.display()))
}

/// `id` 是否为受支持的内置插件
pub(crate) fn is_builtin(id: &str) -> bool {
    BUILTIN_ALLOWLIST.contains(&id)
}

/// 扫描资源目录，返回「资源实际存在」的内置插件清单。
///
/// 文件名即 id（`com.mysearch.pi-agent.msplugin` → `com.mysearch.pi-agent`）；
/// 不在白名单内的文件一律忽略（记录日志，不参与引导）。
pub(crate) fn bundle_manifest(app: &tauri::AppHandle) -> Vec<BundledPlugin> {
    let Ok(resource_dir) = app.path().resource_dir() else {
        return Vec::new();
    };
    let dir = resource_dir.join(BUNDLE_PLUGINS_DIR.replace('/', std::path::MAIN_SEPARATOR_STR));
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out: Vec<BundledPlugin> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(id) = name.strip_suffix(".msplugin") else {
            continue;
        };
        if !is_builtin(id) {
            eprintln!("[内置插件] 忽略白名单外的资源: {name}");
            continue;
        }
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        out.push(BundledPlugin {
            id: id.to_string(),
            resource_path: path.to_string_lossy().to_string(),
        });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// 某插件是否已安装（数据目录下 `plugins/<id>/plugin.json` 存在）
fn installed(app: &tauri::AppHandle, id: &str) -> bool {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("plugins").join(id).join("plugin.json").exists())
        .unwrap_or(false)
}

/// 内置插件对外可见的一项（`builtin_list` 命令的载荷）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BuiltinEntry {
    pub id: String,
    /// 资源是否存在（随版本分发）
    pub available: bool,
    /// 是否已安装
    pub installed: bool,
    /// 是否被用户卸载过（removed 标记）
    pub removed: bool,
    /// 已安装版本（installed=true 时从 `plugins/<id>/plugin.json` 读）
    pub version: Option<String>,
    /// 资源文件路径（available 为 true 时给出）
    pub resource_path: Option<String>,
}

/// 读取已安装插件的 version（从 plugin.json 的 version 字段）
fn read_installed_version(app: &tauri::AppHandle, id: &str) -> Option<String> {
    let path = app.path().app_data_dir().ok()?.join("plugins").join(id).join("plugin.json");
    let content = std::fs::read_to_string(&path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&content).ok()?;
    v.get("version").and_then(|v| v.as_str()).map(|s| s.to_string())
}

/// 列出所有内置插件的状态（前端面板与引导流程共用）。
pub(crate) fn builtin_list_inner(app: &tauri::AppHandle) -> Vec<BuiltinEntry> {
    let state = load_state(app);
    let bundles = bundle_manifest(app);
    let mut out: Vec<BuiltinEntry> = Vec::new();
    for id in BUILTIN_ALLOWLIST {
        let bundle = bundles.iter().find(|b| b.id == id);
        out.push(BuiltinEntry {
            id: id.to_string(),
            available: bundle.is_some(),
            installed: installed(app, id),
            removed: state.removed.iter().any(|r| r == id),
            version: if installed(app, id) { read_installed_version(app, id) } else { None },
            resource_path: bundle.map(|b| b.resource_path.clone()),
        });
    }
    out
}

/// 引导报告（启动时广播给前端）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BootstrapReport {
    /// 需要安装（资源存在、未 removed、未安装）
    pub installable: Vec<String>,
    /// 已跳过（用户卸载过）
    pub skipped_removed: Vec<String>,
}

/// 启动引导：算出「应装未装」的清单（**不自己安装**，由前端走既有管线）。
///
/// 规则（计划 §6.3）：
///   1. 资源里存在才参与；
///   2. `removed` 里的 id 跳过（升级不复活）；
///   3. 已有安装目录的跳过（含市场版覆盖内置版）。
pub(crate) fn bootstrap(app: &tauri::AppHandle) -> BootstrapReport {
    let state = load_state(app);
    let mut report = BootstrapReport {
        installable: Vec::new(),
        skipped_removed: Vec::new(),
    };
    for bundle in bundle_manifest(app) {
        if state.removed.iter().any(|r| r == &bundle.id) {
            report.skipped_removed.push(bundle.id);
            continue;
        }
        if installed(app, &bundle.id) {
            continue;
        }
        report.installable.push(bundle.id);
    }
    report
}

// ===================== 命令 =====================

/// 列出内置插件状态
#[tauri::command]
pub(crate) fn builtin_list(app: tauri::AppHandle) -> Vec<BuiltinEntry> {
    builtin_list_inner(&app)
}

/// 标记内置插件「已被用户卸载」（升级不复活）
#[tauri::command]
pub(crate) fn builtin_mark_removed(app: tauri::AppHandle, id: String) -> Result<(), String> {
    if !is_builtin(&id) {
        return Err(format!("不是内置插件: {id}"));
    }
    let mut state = load_state(&app);
    if !state.removed.iter().any(|r| r == &id) {
        state.removed.push(id);
        state.normalize();
        save_state(&app, &state)?;
    }
    Ok(())
}

/// 清除「已卸载」标记（恢复内置用；调用方随后走安装流程）
#[tauri::command]
pub(crate) fn builtin_clear_removed(app: tauri::AppHandle, id: String) -> Result<(), String> {
    if !is_builtin(&id) {
        return Err(format!("不是内置插件: {id}"));
    }
    let mut state = load_state(&app);
    let before = state.removed.len();
    state.removed.retain(|r| r != &id);
    if state.removed.len() != before {
        save_state(&app, &state)?;
    }
    Ok(())
}

/// 取内置插件资源路径（前端拿它走「从文件安装」管线）
#[tauri::command]
pub(crate) fn builtin_resource_path(app: tauri::AppHandle, id: String) -> Result<String, String> {
    if !is_builtin(&id) {
        return Err(format!("不是内置插件: {id}"));
    }
    bundle_manifest(&app)
        .into_iter()
        .find(|b| b.id == id)
        .map(|b| b.resource_path)
        .ok_or_else(|| format!("资源中不存在内置插件: {id}"))
}

// ===================== 测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_matches_official_ids() {
        assert!(is_builtin("com.mysearch.baidu-translate"));
        assert!(is_builtin("com.mysearch.pi-agent"));
        assert!(is_builtin("com.mysearch.market"));
        assert!(!is_builtin("com.example.evil"));
        assert!(!is_builtin("com.mysearch.other"));
    }

    #[test]
    fn state_normalize_filters_and_dedups() {
        let mut state = BuiltinsState {
            schema_version: 0,
            removed: vec![
                "com.mysearch.pi-agent".into(),
                "com.example.evil".into(), // 白名单外：应被清掉
                "com.mysearch.pi-agent".into(), // 重复：应去重
                "com.mysearch.market".into(),
            ],
        };
        state.normalize();
        assert_eq!(state.schema_version, BUILTINS_SCHEMA_VERSION);
        assert_eq!(
            state.removed,
            vec![
                "com.mysearch.market".to_string(),
                "com.mysearch.pi-agent".to_string()
            ]
        );
    }

    #[test]
    fn removed_semantics_are_stable_across_schema_evolution() {
        // 缺字段 / 旧版本文件解析：应得到空集而不是报错（不阻断启动）
        let legacy: BuiltinsState = serde_json::from_str("{\"removed\":[\"com.mysearch.pi-agent\"]}")
            .expect("缺 schemaVersion 也能解析");
        let mut legacy = legacy;
        legacy.normalize();
        assert_eq!(legacy.removed, vec!["com.mysearch.pi-agent".to_string()]);

        let empty: BuiltinsState = serde_json::from_str("{}").expect("空对象也能解析");
        assert_eq!(empty.schema_version, BUILTINS_SCHEMA_VERSION);
        assert!(empty.removed.is_empty());
    }
}