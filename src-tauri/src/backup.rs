//! 备份归档（`.msbackup` = ZIP）—— 导出 / 导入 / 云同步共用。
//!
//! 设计要点
//! --------
//! 1. **一份归档 = 整个用户态**：前端 localStorage（订阅、标签、历史、权重、
//!    插件注册表、插件私有数据…）+ Rust 侧落盘数据（`settings.json` 的用户项、
//!    `plugins/<id>/` 安装文件、`plugin-data/<id>/` 插件数据）。
//!    日志（`plugin-logs/`）与安装目录的派生文件（`.dev-source`）不进备份。
//! 2. **归档内是「人可读」的明文 JSON**，不用自定义二进制格式：用户拿任何解压
//!    工具都能看到自己备份了什么，出问题也能手工救回来。
//! 3. **导入是两段式**：先 `backup_inspect`（只读、只报告），再 `backup_restore`
//!    （可带 `only` 白名单，按一级分区挑选要还原的内容）。这样面板可以先给用户
//!    看清楚「这个包里有什么、会不会覆盖掉我现在的插件」，而不是点一下就回不去了。
//! 4. **还原前先留底**：`backup_restore` 会先把当前状态导出成
//!    `backups/pre-restore-<时间戳>.msbackup`，误操作可一键回到还原前。
//!
//! 归档结构（全部为普通 ZIP 条目，UTF-8 文件名）
//! --------
//! ```text
//! manifest.json                 归档说明（版本 / 应用版本 / 导出时间 / 各分区文件数）
//! state/local-storage.json      前端 localStorage 快照 { "<逻辑键>": <任意 JSON> }
//! state/settings.json           Rust 侧 settings.json 快照（合并还原，不是整文件覆盖）
//! plugins/<id>/...              插件安装文件（含 plugin.json）
//! plugin-data/<id>/...          插件私有数据
//! ```

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

/// 归档格式版本（结构不兼容时递增；导入时高于本版本直接拒绝）
pub const BACKUP_FORMAT_VERSION: u32 = 1;

/// 备份目录名（应用数据目录下，存放自动导出与「还原前留底」）
const BACKUPS_DIR: &str = "backups";
/// 还原前自动留底的文件名前缀
const PRE_RESTORE_PREFIX: &str = "pre-restore-";
/// 插件目录名（与 plugin_host.rs 保持一致）
const PLUGINS_DIR: &str = "plugins";
/// 插件数据目录名（与 plugin_host.rs 保持一致）
const PLUGIN_DATA_DIR: &str = "plugin-data";

/// 单条目上限（256MB，插件本体远小于此）
const MAX_ENTRY_BYTES: u64 = 256 * 1024 * 1024;
/// 归档内条目总数上限
const MAX_ENTRIES: usize = 20000;
/// 解压后总体积上限（1GB）
const MAX_TOTAL_BYTES: u64 = 1024 * 1024 * 1024;
/// 备份目录里保留的自动备份份数（含留底；超出按时间淘汰最旧的）
const KEEP_BACKUPS: usize = 12;

/// `state/local-storage.json` 在归档内的路径
const ENTRY_LOCAL_STORAGE: &str = "state/local-storage.json";
/// `state/settings.json`（Rust 侧设置）在归档内的路径
const ENTRY_SETTINGS: &str = "state/settings.json";
/// `manifest.json` 在归档内的路径
const ENTRY_MANIFEST: &str = "manifest.json";

/// 归纳的操作错误（统一转成给用户看的中文文案）
fn err(msg: impl Into<String>) -> String {
    msg.into()
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// `YYYYMMDD-HHMMSS` 形式的时间戳（本地时间，仅用于文件名）。
///
/// 刻意不引 chrono：只为了文件名好看而多一个依赖不划算，这里用 UTC+8 近似
/// 北京时间（本应用的目标用户主要在国内），误差最多影响文件名的可读性。
fn file_stamp() -> String {
    let secs = (now_ms() / 1000) as i64 + 8 * 3600;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // 1970-01-01 起的天数 → 年月日（civil_from_days 算法，Hinnant）
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096).div_euclid(365);
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2).div_euclid(153);
    let d = doy - (153 * mp + 2).div_euclid(5) + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}{m:02}{d:02}-{:02}{:02}{:02}",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

// ===================== 通用路径 / 文件工具 =====================

/// 应用数据目录
fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| err(format!("取应用数据目录失败: {e}")))
}

/// 备份目录（不存在则创建）
fn backups_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = data_dir(app)?.join(BACKUPS_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| err(format!("创建备份目录失败: {e}")))?;
    Ok(dir)
}

/// 相对路径安全校验（与 plugin_host.rs 的 is_safe_relative 同规则）
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

/// 递归收集目录下的文件（相对路径用正斜杠），跳过点开头的条目。
///
/// 为什么要跳过 `.dev-source` 这类点文件：它们是本机开发挂载标记，
/// 带到另一台机器上只会在读取插件文件时指向不存在的目录。
fn collect_files(root: &Path, rel_prefix: &str, out: &mut Vec<(String, PathBuf)>) -> Result<(), String> {
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(e) => return Err(err(format!("读取目录失败 {}: {e}", root.display()))),
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let rel = if rel_prefix.is_empty() {
            name.clone()
        } else {
            format!("{rel_prefix}/{name}")
        };
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_dir() {
            collect_files(&path, &rel, out)?;
        } else if meta.is_file() {
            if !is_safe_relative(&rel) {
                continue;
            }
            out.push((rel, path));
        }
    }
    Ok(())
}

/// 清空目录（不存在则创建），用于还原时先移除旧内容
fn reset_dir(dir: &Path) -> Result<(), String> {
    if dir.exists() {
        std::fs::remove_dir_all(dir).map_err(|e| err(format!("清理旧目录失败: {e}")))?;
    }
    std::fs::create_dir_all(dir).map_err(|e| err(format!("创建目录失败: {e}")))
}

/// 淘汰备份目录里的旧文件，只保留最近 `keep` 份（按修改时间）
fn prune_backups(dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(SystemTime, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            let is_backup = p
                .extension()
                .map(|x| x.eq_ignore_ascii_case("msbackup"))
                .unwrap_or(false);
            if !is_backup {
                return None;
            }
            let mtime = e.metadata().ok()?.modified().ok()?;
            Some((mtime, p))
        })
        .collect();
    if files.len() <= keep {
        return;
    }
    files.sort_by(|a, b| b.0.cmp(&a.0)); // 新的在前
    for (_, path) in files.into_iter().skip(keep) {
        let _ = std::fs::remove_file(path);
    }
}

// ===================== 各分区数据 =====================

/// 收集插件的安装文件（`plugins/<id>/...`）与私有数据（`plugin-data/<id>/...`）
fn collect_plugin_files(app: &AppHandle, out: &mut Vec<(String, PathBuf)>) -> Result<(), String> {
    let root = data_dir(app)?.join(PLUGINS_DIR);
    if root.is_dir() {
        let mut files = Vec::new();
        collect_files(&root, "", &mut files)?;
        for (rel, path) in files {
            // `.staging` 是安装中转目录，不备份
            if rel.starts_with(".staging/") || rel == ".staging" {
                continue;
            }
            out.push((format!("{PLUGINS_DIR}/{rel}"), path));
        }
    }
    let data = data_dir(app)?.join(PLUGIN_DATA_DIR);
    if data.is_dir() {
        let mut files = Vec::new();
        collect_files(&data, "", &mut files)?;
        for (rel, path) in files {
            out.push((format!("{PLUGIN_DATA_DIR}/{rel}"), path));
        }
    }
    Ok(())
}

/// 导出归档的字节流。
///
/// `settings` 是前端从 Rust 侧「可备份的设置键」里读出来的（前端才是这些键的
/// 使用方，Rust 只负责落盘），`local_storage` 是前端整个 localStorage 快照。
pub fn build_archive(
    app: &AppHandle,
    local_storage: Value,
    settings: Value,
    app_version: &str,
) -> Result<Vec<u8>, String> {
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    collect_plugin_files(app, &mut files)?;
    let owned: Vec<(String, Vec<u8>)> = files
        .into_iter()
        .map(|(rel, path)| {
            let data = std::fs::read(&path)
                .map_err(|e| err(format!("读取失败 {}: {e}", path.display())))?;
            Ok((rel, data))
        })
        .collect::<Result<_, String>>()?;
    build_archive_from_parts(local_storage, settings, owned, app_version)
}

/// 不带 `AppHandle` 的打包实现（装配好的条目 → 归档字节）。
///
/// 单独拆出来是为了能纯单测（归档结构、路径安全、清单字段都不依赖 Tauri 运行时）。
pub fn build_archive_from_parts(
    local_storage: Value,
    settings: Value,
    files: Vec<(String, Vec<u8>)>,
    app_version: &str,
) -> Result<Vec<u8>, String> {
    let cursor = std::io::Cursor::new(Vec::new());
    let mut writer = zip::ZipWriter::new(cursor);
    let options: zip::write::FileOptions<'_, ()> =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let plugin_count = files
        .iter()
        .filter(|(rel, _)| rel.starts_with(&format!("{PLUGINS_DIR}/")))
        .count();
    let plugin_data_count = files.len() - plugin_count;
    let ls_count = local_storage
        .as_object()
        .map(|m| m.len())
        .unwrap_or_default();

    let manifest = json!({
        "format": "my-search-backup",
        "formatVersion": BACKUP_FORMAT_VERSION,
        "app": "my-search-desktop",
        "appVersion": app_version,
        "exportedAt": now_ms() as u64,
        "counts": {
            "localStorageKeys": ls_count,
            "pluginFiles": plugin_count,
            "pluginDataFiles": plugin_data_count,
        },
        "platform": std::env::consts::OS,
    });

    // 1) 清单
    writer
        .start_file(ENTRY_MANIFEST, options)
        .map_err(|e| err(format!("写入归档失败: {e}")))?;
    writer
        .write_all(
            serde_json::to_string_pretty(&manifest)
                .map_err(|e| err(format!("序列化失败: {e}")))?
                .as_bytes(),
        )
        .map_err(|e| err(format!("写入归档失败: {e}")))?;

    // 2) localStorage 快照
    writer
        .start_file(ENTRY_LOCAL_STORAGE, options)
        .map_err(|e| err(format!("写入归档失败: {e}")))?;
    writer
        .write_all(
            serde_json::to_string_pretty(&local_storage)
                .map_err(|e| err(format!("序列化失败: {e}")))?
                .as_bytes(),
        )
        .map_err(|e| err(format!("写入归档失败: {e}")))?;

    // 3) Rust 侧设置快照
    writer
        .start_file(ENTRY_SETTINGS, options)
        .map_err(|e| err(format!("写入归档失败: {e}")))?;
    writer
        .write_all(
            serde_json::to_string_pretty(&settings)
                .map_err(|e| err(format!("序列化失败: {e}")))?
                .as_bytes(),
        )
        .map_err(|e| err(format!("写入归档失败: {e}")))?;

    // 4) 插件文件与插件数据
    for (rel, data) in &files {
        if data.len() as u64 > MAX_ENTRY_BYTES {
            continue;
        }
        writer
            .start_file(rel.as_str(), options)
            .map_err(|e| err(format!("写入归档失败 {rel}: {e}")))?;
        writer
            .write_all(data)
            .map_err(|e| err(format!("写入归档失败 {rel}: {e}")))?;
    }

    let cursor = writer
        .finish()
        .map_err(|e| err(format!("归档收尾失败: {e}")))?;
    Ok(cursor.into_inner())
}

/// 解压归档到内存（条目名 → 字节）。
///
/// 一路做安全校验：路径穿越、符号链接、体积上限。调用方拿到的是干净的条目表。
fn read_archive(bytes: &[u8]) -> Result<BTreeMap<String, Vec<u8>>, String> {
    let reader = std::io::Cursor::new(bytes);
    let mut archive =
        zip::ZipArchive::new(reader).map_err(|e| err(format!("不是有效的备份归档: {e}")))?;
    if archive.len() > MAX_ENTRIES {
        return Err(err(format!("归档条目过多（{}）", archive.len())));
    }
    let mut out = BTreeMap::new();
    let mut total: u64 = 0;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| err(format!("读取归档条目失败: {e}")))?;
        let name = entry.name().to_string();
        if entry.is_dir() {
            continue;
        }
        let norm = name.replace('\\', "/").trim_start_matches("./").to_string();
        if norm.is_empty() {
            continue;
        }
        if !is_safe_relative(&norm) {
            return Err(err(format!("归档包含不安全路径: {norm}")));
        }
        // 符号链接（unix 模式 0xA000）直接拒绝，避免解出软链接后越权写入
        if let Some(mode) = entry.unix_mode() {
            if mode & 0o170000 == 0o120000 {
                return Err(err(format!("归档包含符号链接: {norm}")));
            }
        }
        let size = entry.size();
        if size > MAX_ENTRY_BYTES {
            return Err(err(format!("归档内文件过大: {norm}")));
        }
        let mut buf = Vec::with_capacity(size.min(8 * 1024 * 1024) as usize);
        entry
            .read_to_end(&mut buf)
            .map_err(|e| err(format!("解压失败 {norm}: {e}")))?;
        total += buf.len() as u64;
        if total > MAX_TOTAL_BYTES {
            return Err(err("归档解压后体积过大，已中止"));
        }
        out.insert(norm, buf);
    }
    Ok(out)
}

/// 从归档条目里读一个 JSON 文件（缺失时返回 `default`）
fn json_entry(entries: &BTreeMap<String, Vec<u8>>, name: &str) -> Value {
    entries
        .get(name)
        .and_then(|b| serde_json::from_slice::<Value>(b).ok())
        .unwrap_or(Value::Null)
}

/// 归档预览（导入前给用户看清楚要还原什么）
pub fn inspect_archive(bytes: &[u8]) -> Result<Value, String> {
    let entries = read_archive(bytes)?;
    let manifest = json_entry(&entries, ENTRY_MANIFEST);
    let format_version = manifest
        .get("formatVersion")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    if format_version == 0 {
        return Err(err("这不是「我的搜索」的备份归档（缺少 manifest）"));
    }
    if format_version > BACKUP_FORMAT_VERSION as u64 {
        return Err(err(format!(
            "备份来自更新版本的应用（归档格式 v{format_version}，本机支持到 v{BACKUP_FORMAT_VERSION}），请先升级应用"
        )));
    }

    let local_storage = json_entry(&entries, ENTRY_LOCAL_STORAGE);
    let settings = json_entry(&entries, ENTRY_SETTINGS);
    let ls_count = local_storage.as_object().map(|m| m.len()).unwrap_or(0);

    let mut plugin_ids: Vec<String> = Vec::new();
    let mut plugin_files = 0usize;
    let mut plugin_data_files = 0usize;
    for name in entries.keys() {
        if let Some(rest) = name.strip_prefix(&format!("{PLUGINS_DIR}/")) {
            plugin_files += 1;
            if let Some(id) = rest.split('/').next() {
                if !plugin_ids.iter().any(|x| x == id) {
                    plugin_ids.push(id.to_string());
                }
            }
        } else if name.starts_with(&format!("{PLUGIN_DATA_DIR}/")) {
            plugin_data_files += 1;
        }
    }
    let mut plugin_ids_sorted = plugin_ids;
    plugin_ids_sorted.sort();

    Ok(json!({
        "ok": true,
        "manifest": manifest,
        "formatVersion": format_version,
        "exportedAt": manifest.get("exportedAt").and_then(|v| v.as_u64()).unwrap_or(0),
        "appVersion": manifest.get("appVersion").and_then(|v| v.as_str()).unwrap_or(""),
        "localStorageKeys": ls_count,
        "pluginIds": plugin_ids_sorted,
        "pluginFiles": plugin_files,
        "pluginDataFiles": plugin_data_files,
        "hasSettings": !settings.is_null(),
        "hasPlugins": plugin_files > 0,
        "hasPluginData": plugin_data_files > 0,
        "totalBytes": entries.values().map(|v| v.len() as u64).sum::<u64>(),
    }))
}

/// 还原结果（给前端决定「要不要提示重启」）
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    /// 还原前自动留底的归档路径
    pub snapshot_path: Option<String>,
    /// 实际写回的 localStorage 键数（由前端回填，Rust 只占位）
    pub local_storage_keys: usize,
    /// 写回的插件数
    pub plugins: usize,
    /// 写回的插件数据目录数
    pub plugin_data: usize,
    /// 是否写回了 Rust 侧设置
    pub settings: bool,
}

/// 执行还原。
///
/// `only`：为空表示全量还原；否则只还原列出的分区（`"localStorage"` /
/// `"settings"` / `"plugins"` / `"pluginData"`），用于「只把订阅拿回来」这类操作。
///
/// 注意：**插件目录是按分区整体替换的**（先清空 `plugins/` 再写入），
/// 因为备份里的插件清单就是那一刻的全部真相——半合并会出现
/// 「注册表指向的目录不存在」的悬空记录。
pub fn restore_archive(
    app: &AppHandle,
    bytes: &[u8],
    only: &[String],
    app_version: &str,
) -> Result<(RestoreReport, Value, Value), String> {
    let entries = read_archive(bytes)?;
    let manifest = json_entry(&entries, ENTRY_MANIFEST);
    let format_version = manifest
        .get("formatVersion")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    if format_version == 0 {
        return Err(err("这不是「我的搜索」的备份归档（缺少 manifest）"));
    }
    if format_version > BACKUP_FORMAT_VERSION as u64 {
        return Err(err(format!(
            "备份来自更新版本的应用（归档格式 v{format_version}），请先升级应用"
        )));
    }

    let wants = |part: &str| only.is_empty() || only.iter().any(|x| x == part);

    // 1) 还原前留底（失败不阻断还原，只提示）
    let mut report = RestoreReport::default();
    if let Ok(dir) = backups_dir(app) {
        let pre = dir.join(format!("{PRE_RESTORE_PREFIX}{}.msbackup", file_stamp()));
        if !pre.exists() {
            // 用「当前状态」重新打包一份，而不是把原始归档复制一份：
            // 用户点「还原」时，本机可能已经比归档新，留底要留的是**当前**状态。
            let current = build_archive(
                app,
                json!({}),
                json!({}),
                app_version,
            );
            match current {
                Ok(data) => {
                    let _ = std::fs::write(&pre, data);
                    report.snapshot_path = Some(pre.to_string_lossy().to_string());
                }
                Err(e) => eprintln!("还原前留底失败（继续还原）: {e}"),
            }
        }
    }

    // 2) localStorage（交给前端写回，Rust 拿不到 WebView 的存储）
    let local_storage = json_entry(&entries, ENTRY_LOCAL_STORAGE);

    // 3) Rust 侧设置（合并式：只覆盖备份里存在的键，其余保持本机现状）
    let mut settings_written = false;
    if wants("settings") {
        let settings = json_entry(&entries, ENTRY_SETTINGS);
        if let Some(map) = settings.as_object() {
            if !map.is_empty() {
                crate::write_backup_settings(app, map)?;
                settings_written = true;
            }
        }
    }

    // 4) 插件安装文件与私有数据
    let data_root = data_dir(app)?;
    if wants("plugins") {
        let root = data_root.join(PLUGINS_DIR);
        // 先把当前插件目录整体挪走再重建：直接 reset 时若插件进程正占用文件
        // （Windows 上运行中的 exe 会锁文件），删除会失败——此时明确报错，
        // 让用户先在「插件」面板里停掉对应插件，而不是静默留下一堆旧文件。
        if root.exists() {
            for id in installed_plugin_dirs(&root) {
                let _ = crate::plugin_host_stop_backend(app, &id);
            }
            reset_dir(&root).map_err(|e| {
                err(format!(
                    "清理旧插件目录失败（可能有插件正在运行，请先在「插件」面板停用后再试）: {e}"
                ))
            })?;
        } else {
            std::fs::create_dir_all(&root).map_err(|e| err(format!("创建插件目录失败: {e}")))?;
        }
        let mut count: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        for (name, data) in &entries {
            let Some(rest) = name.strip_prefix(&format!("{PLUGINS_DIR}/")) else {
                continue;
            };
            if rest.is_empty() || rest.starts_with(".staging/") {
                continue;
            }
            // 开发挂载标记指向本机目录，跨机还原后只会指向不存在的路径
            if rest.ends_with("/.dev-source") || rest == ".dev-source" {
                continue;
            }
            if let Some(id) = rest.split('/').next() {
                count.insert(id.to_string());
            }
            write_relative(&root, rest, data)?;
        }
        report.plugins = count.len();
    }

    if wants("pluginData") {
        let root = data_root.join(PLUGIN_DATA_DIR);
        if root.exists() {
            reset_dir(&root).map_err(|e| err(format!("清理旧插件数据目录失败: {e}")))?;
        } else {
            std::fs::create_dir_all(&root).map_err(|e| err(format!("创建插件数据目录失败: {e}")))?;
        }
        let mut count: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        for (name, data) in &entries {
            let Some(rest) = name.strip_prefix(&format!("{PLUGIN_DATA_DIR}/")) else {
                continue;
            };
            if rest.is_empty() {
                continue;
            }
            if let Some(id) = rest.split('/').next() {
                count.insert(id.to_string());
            }
            write_relative(&root, rest, data)?;
        }
        report.plugin_data = count.len();
    }

    report.settings = settings_written;
    Ok((report, local_storage, manifest))
}

/// 列出 `plugins/` 下的插件 id（跳过 `.staging`）
fn installed_plugin_dirs(root: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().to_str().map(|s| s.to_string()))
        .filter(|name| !name.starts_with('.'))
        .collect()
}

/// 把字节写到 `root/<rel>`（自动建父目录）
fn write_relative(root: &Path, rel: &str, data: &[u8]) -> Result<(), String> {
    if !is_safe_relative(rel) {
        return Err(err(format!("归档包含不安全路径: {rel}")));
    }
    let dest = root.join(rel.replace('\\', "/"));
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| err(format!("创建目录失败 {rel}: {e}")))?;
    }
    std::fs::write(&dest, data).map_err(|e| err(format!("写入失败 {rel}: {e}")))
}

/// 把归档写到备份目录，返回文件路径（导出与自动备份共用）
pub fn write_archive_file(app: &AppHandle, name: &str, bytes: &[u8]) -> Result<String, String> {
    let dir = backups_dir(app)?;
    let path = dir.join(name);
    std::fs::write(&path, bytes).map_err(|e| err(format!("写入备份文件失败: {e}")))?;
    prune_backups(&dir, KEEP_BACKUPS);
    Ok(path.to_string_lossy().to_string())
}

/// 取备份目录路径（面板展示用）
pub fn backups_dir_path(app: &AppHandle) -> Result<String, String> {
    Ok(backups_dir(app)?.to_string_lossy().to_string())
}

/// 当前状态导出为归档（「导出到备份目录」/「自动备份」用）
pub fn export_to_backups(
    app: &AppHandle,
    local_storage: Value,
    settings: Value,
    app_version: &str,
    prefix: &str,
) -> Result<String, String> {
    let bytes = build_archive(app, local_storage, settings, app_version)?;
    let name = format!("{prefix}{}.msbackup", file_stamp());
    write_archive_file(app, &name, &bytes)
}

/// 读一个归档文件的字节（路径必须位于备份目录内，避免前端传入任意路径）
pub fn read_backup_file(app: &AppHandle, path: &str) -> Result<Vec<u8>, String> {
    let dir = backups_dir(app)?;
    let requested = PathBuf::from(path);
    let canonical_dir = dir.canonicalize().unwrap_or(dir.clone());
    let canonical = requested
        .canonicalize()
        .map_err(|e| err(format!("备份文件不存在: {e}")))?;
    if !canonical.starts_with(&canonical_dir) {
        return Err(err("只允许读取备份目录内的文件"));
    }
    std::fs::read(&canonical).map_err(|e| err(format!("读取备份失败: {e}")))
}

/// 本地快照文件的默认名（手动导出用）
#[allow(dead_code)]
pub fn default_backup_name() -> String {
    format!("my-search-{}.msbackup", file_stamp())
}

/// 文件时间戳（供 cloud.rs 命名远端下载文件；与导出文件同一个格式）
pub fn file_stamp_public() -> String {
    file_stamp()
}

/* ============================================================
 * 单测入口（lib.rs 的 #[cfg(test)] 用；不进生产路径）
 * ============================================================ */

/// 路径安全校验（测试用）
#[allow(dead_code)]
pub fn is_safe_relative_public(rel: &str) -> bool {
    is_safe_relative(rel)
}

/// 解压归档（测试用）
#[allow(dead_code)]
pub fn read_archive_public(bytes: &[u8]) -> Result<BTreeMap<String, Vec<u8>>, String> {
    read_archive(bytes)
}
