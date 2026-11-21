//! 备份归档（`.msbackup` = ZIP）—— 导出 / 导入 / 云同步共用。
//!
//! 设计要点
//! --------
//! 1. **一份归档 = 整个用户态**：前端 localStorage（订阅、标签、历史、权重、
//!    插件注册表、插件私有数据…）+ Rust 侧落盘数据（`settings.json` 的用户项、
//!    `plugins/<id>/` 安装文件、`plugin-data/<id>/` 中**声明为云数据**的小文件、
//!    `sync-store/<id>.json` 插件云数据 store）。
//!    日志（`plugin-logs/`）、安装目录的派生文件（`.dev-source`）与插件的大体积
//!    本机数据（剪贴板图片、历史索引、录屏、运行时下载的工具）不进备份——见
//!    `cloud_data_allowlist` 与 `is_reconstructible_plugin_data`。
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
//! plugin-data/<id>/kv/...       插件结构化小数据（`ms.store.readJson/writeJson`）
//! sync-store/<id>.json          插件云数据 store（`ms.store.sync.*`，带配额）
//! ```

use std::collections::BTreeMap;
use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
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
/// 插件云数据目录名（与 plugin_sync_store.rs 保持一致）
const SYNC_STORE_DIR: &str = crate::plugin_sync_store::SYNC_STORE_DIR;
/// 内置插件状态等内部数据目录名（与 builtin.rs INTERNAL_DIR 一致）
const INTERNAL_DIR: &str = "internal";

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

/// 还原事务用的唯一时间戳（`file_stamp` 只精确到秒）。
///
/// 同一秒内连续两次还原会复用 staging / old / 留底目录名：上一次的残留
/// 可能混进下一次交换。加一个进程内自增序号即可，且不影响用户看到的文件名
/// （普通导出仍用 `file_stamp`）。
static RESTORE_SEQ: AtomicU64 = AtomicU64::new(0);

fn restore_stamp() -> String {
    format!("{}-{}", file_stamp(), RESTORE_SEQ.fetch_add(1, Ordering::Relaxed))
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

/// 这条 `plugin-data` 相对路径是否属于**可再生成的派生缓存**（不进备份）。
///
/// ## 为什么要有这条规则
///
/// 备份归档的设计目标是「一份归档 = 整个用户态」，但**用户态 ≠ 插件目录下的
/// 每个字节**。有些文件是插件在运行时下载/生成的工具与缓存，删掉不会丢任何
/// 用户数据——下次用到时会重新拿到：
///
///   - `*/ffmpeg/`：录屏插件首次使用时从 GitHub Release 下载的 ffmpeg/ffprobe
///     静态构建（Windows 上单个 ~160MB，两个共 ~320MB）。见
///     `plugins/recorder/backend/downloader.mjs`——它明写「首次使用时下载到
///     插件私有目录」，因为宿主单文件 64MB 上限装不进 `.mspp`。
///     备份它是纯浪费：一份归档就多 300MB，`KEEP_BACKUPS = 12` 份上限下
///     最坏可攒到 ~1.6GB。
///   - `*.exe` / `*.dll` / `*.dylib` / `*.so` / `*.node`：同类下载/编译产物。
///
/// ## 为什么只对 `plugin-data/` 生效
///
/// `plugins/` 装的是**插件安装包**，里面可能合法地带着小体积辅助可执行文件
/// （宿主 `MAX_FILE_BYTES = 64MB` 允许），排除掉会让还原后的插件缺文件。
/// 而 `plugin-data/` 是插件私有运行数据，工具二进制只可能来自运行时下载。
///
/// ## 这条规则**故意不动**的东西
///
/// `recordings/`（录屏产出的 mp4）是用户亲手录的、不可再生成的媒体，属于
/// 真正的用户态——留在备份里是对的。它们体积大是另一个话题（保留策略），
/// 不该用「静默丢数据」的方式解决。
fn is_reconstructible_plugin_data(rel: &str) -> bool {
    let normalized = rel.replace('\\', "/");
    // 任意一级目录名为 ffmpeg（不区分大小写）→ 工具缓存，可重新下载
    if normalized
        .split('/')
        .any(|seg| seg.eq_ignore_ascii_case("ffmpeg"))
    {
        return true;
    }
    // 可执行/原生扩展名 → 下载或编译产物
    if let Some((_, ext)) = normalized.rsplit_once('.') {
        let ext = ext.to_ascii_lowercase();
        return matches!(ext.as_str(), "exe" | "dll" | "dylib" | "so" | "node");
    }
    false
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

/// 收集**插件主体**文件。
///
/// `skip_build` 只对**开发挂载**目录生效：那是源码仓库，里面可能有
/// `node_modules/`、`target/`、`dist/` 这类构建产物（几百 MB ~ 几 GB），
/// 不是插件运行必需，也不该进云备份。**普通安装**的包里如果作者真的把
/// `dist/` 当运行时目录用，必须原样带上——所以此时不过滤。
fn collect_dev_files(
    root: &Path,
    rel_prefix: &str,
    skip_build: bool,
    out: &mut Vec<(String, PathBuf)>,
) -> Result<(), String> {
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(e) => return Err(err(format!("读取目录失败 {}: {e}", root.display()))),
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || (skip_build && is_dev_only_dir(&name)) {
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
            collect_dev_files(&path, &rel, skip_build, out)?;
        } else if meta.is_file() && is_safe_relative(&rel) {
            out.push((rel, path));
        }
    }
    Ok(())
}

/// 源码仓库里的派生/依赖目录：不进云备份
fn is_dev_only_dir(name: &str) -> bool {
    matches!(
        name,
        "node_modules" | "target" | "dist" | "build" | ".venv" | "venv" | "__pycache__"
    )
}

/// 开发挂载插件的源目录（从 `plugins/<id>/.dev-source` 的第一行非注释路径读取）。
fn dev_source_of(plugin_dir: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(plugin_dir.join(".dev-source")).ok()?;
    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let p = PathBuf::from(t);
        if p.is_dir() {
            return Some(p);
        }
    }
    None
}

/// 某个插件的 `plugin-data/` 里**该进云备份**的路径前缀。
///
/// 默认只有 `kv`（`ms.store.readJson/writeJson` 的结构化小数据，本来就在备份里）。
/// 插件可以在 `plugin.json` 里显式声明：
///
/// ```json
/// "backup": { "pluginData": true }                                  // 该插件全部数据上云
/// "backup": { "pluginData": ["kv", "sync/state.json"] }             // 只上云这些前缀
/// "backup": { "pluginData": false }                                 // 一个都不上云
/// ```
///
/// 为什么默认收紧：`plugin-data/` 是插件的**本机**运行数据，剪贴板图片、
/// 历史索引、录屏 mp4 动辄几 MB ~ 几百 MB，全量上云会把一份归档撑到 GB 级，
/// 且这些数据通常「换设备后本来就该重新积累」。需要跨设备同步的小状态请用
/// `ms.store.sync`（有配额、有明确的语义）。
fn cloud_data_allowlist(app: &AppHandle, plugin_id: &str) -> Vec<String> {
    let allow: Vec<String> = vec!["kv".to_string()];
    let Ok(root) = data_dir(app) else {
        return allow;
    };
    let manifest = root.join(PLUGINS_DIR).join(plugin_id).join("plugin.json");
    let Ok(text) = std::fs::read_to_string(&manifest) else {
        return allow;
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return allow;
    };
    data_allowlist_from_manifest(&value)
}

/// 纯函数版白名单解析（便于单测；`cloud_data_allowlist` 只负责读文件）。
fn data_allowlist_from_manifest(value: &Value) -> Vec<String> {
    let allow: Vec<String> = vec!["kv".to_string()];
    let Some(policy) = value.get("backup").and_then(|b| b.get("pluginData")) else {
        return allow;
    };
    match policy {
        serde_json::Value::Bool(true) => vec!["*".to_string()],
        serde_json::Value::Bool(false) => Vec::new(),
        serde_json::Value::Array(items) => {
            let mut list: Vec<String> = Vec::new();
            for item in items {
                if let Some(s) = item.as_str() {
                    let s = s.trim().trim_matches('/');
                    if !s.is_empty() && !s.split('/').any(|seg| seg == "..") {
                        list.push(s.to_string());
                    }
                }
            }
            // 显式声明了数组：以声明为准（不再隐式带上 kv），避免「声明了却还多传东西」
            list
        }
        _ => allow,
    }
}

/// `plugin-data/<id>/` 内的相对路径 `rel` 是否命中允许前缀
fn path_covered(rel: &str, prefix: &str) -> bool {
    if prefix == "*" {
        return true;
    }
    let p = prefix.trim_end_matches('/');
    rel == p || rel.starts_with(&format!("{p}/"))
}

/// 收集插件云数据 store（`sync-store/<id>.json`）
fn collect_sync_store_files(app: &AppHandle, out: &mut Vec<(String, PathBuf)>) -> Result<(), String> {
    let root = data_dir(app)?.join(SYNC_STORE_DIR);
    if !root.is_dir() {
        return Ok(());
    }
    let entries = std::fs::read_dir(&root)
        .map_err(|e| err(format!("读取插件云数据目录失败 {}: {e}", root.display())))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // 只收成品的 `<id>.json`（跳过点文件与写入中的 .tmp）
        if name.starts_with('.') || !name.ends_with(".json") {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !meta.is_file() {
            continue;
        }
        out.push((format!("{SYNC_STORE_DIR}/{name}"), entry.path()));
    }
    Ok(())
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

/// 收集插件的安装文件（`plugins/<id>/...`）、可上云的插件数据与云数据 store。
///
/// ## 插件主体：不管怎么装的都收
/// 普通安装（市场 / 文件 / 文件夹）目录里就是插件文件，直接收。
/// **开发挂载**（`plugins/<id>/` 只有一个 `.dev-source` 指针）也收：读指针指向的
/// 源码目录，把文件按 `plugins/<id>/...` 的相对路径打进去。这样「不管插件是怎么
/// 装的」，同步到新设备后都能拿到一份可运行的副本（新设备上是普通安装，
/// 不再依赖那台机器的源码路径）。
///
/// ## 插件数据：只带「该上云」的那部分
/// 见 `cloud_data_allowlist`：默认只有 `kv/`（`ms.store.readJson/writeJson` 的结构化
/// 小数据）跟着上云，其余（剪贴板图片、历史索引、录屏、运行时下载的工具）留在本机。
fn collect_plugin_files(app: &AppHandle, out: &mut Vec<(String, PathBuf)>) -> Result<(), String> {
    let root = data_dir(app)?.join(PLUGINS_DIR);
    if root.is_dir() {
        let entries = std::fs::read_dir(&root)
            .map_err(|e| err(format!("读取插件目录失败 {}: {e}", root.display())))?;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            // `.staging` 是安装中转目录（点开头统一跳过）
            if name.starts_with('.') || !entry.path().is_dir() {
                continue;
            }
            let dir = entry.path();
            // 开发挂载：文件其实在源码目录里，仍按 `<id>/...` 的相对路径收
            let (source_dir, skip_build) = match dev_source_of(&dir) {
                Some(src) => (src, true),
                None => (dir, false),
            };
            let mut files = Vec::new();
            collect_dev_files(&source_dir, "", skip_build, &mut files)?;
            for (rel, path) in files {
                out.push((format!("{PLUGINS_DIR}/{name}/{rel}"), path));
            }
        }
    }

    let data = data_dir(app)?.join(PLUGIN_DATA_DIR);
    if data.is_dir() {
        let mut files = Vec::new();
        collect_files(&data, "", &mut files)?;
        // 按插件分组后再判「该不该上云」：每个插件的清单只读一次
        let mut by_plugin: BTreeMap<String, Vec<(String, PathBuf)>> = BTreeMap::new();
        for (rel, path) in files {
            // 派生缓存不进备份：ffmpeg 这类运行时下载的工具二进制删了不丢数据，
            // 备份它只会把归档撑大几百 MB（见 is_reconstructible_plugin_data）。
            if is_reconstructible_plugin_data(&rel) {
                continue;
            }
            let id = rel.split('/').next().unwrap_or("").to_string();
            if id.is_empty() {
                continue;
            }
            by_plugin.entry(id).or_default().push((rel, path));
        }
        for (id, list) in by_plugin {
            let allow = cloud_data_allowlist(app, &id);
            for (rel, path) in list {
                let rest = rel.split_once('/').map(|(_, r)| r).unwrap_or("");
                if rest.is_empty() || !allow.iter().any(|p| path_covered(rest, p)) {
                    continue;
                }
                out.push((format!("{PLUGIN_DATA_DIR}/{rel}"), path));
            }
        }
    }

    // 插件云数据 store：体积小、有配额，专为跨设备同步而存在，必须带上
    collect_sync_store_files(app, out)?;
    Ok(())
}

/// 收集内部状态文件（`internal/...`，如内置插件卸载标记）
fn collect_internal_files(app: &AppHandle, out: &mut Vec<(String, PathBuf)>) -> Result<(), String> {
    let root = data_dir(app)?.join(INTERNAL_DIR);
    if root.is_dir() {
        let mut files = Vec::new();
        collect_files(&root, "", &mut files)?;
        for (rel, path) in files {
            out.push((format!("{INTERNAL_DIR}/{rel}"), path));
        }
    }
    Ok(())
}

/* ============================================================
 * 分片构建（云同步 v2）：core / 插件主体 / 插件数据
 *
 * 为什么要拆
 * ----------
 * v1 云端只有**一个** `.msbackup`：改一条笔记也要整包 PUT 一次。v2 把用户态
 * 分成三块可独立传输的分片，云端按分片对象存放，引擎只传「摘要变了」的那些。
 * 这里只负责「某一分片里有哪些文件」，打包与上传在 `cloud_sync.rs`。
 * ============================================================ */

/// 插件主体（`plugins/<id>/...`）——普通安装直接收；开发挂载收源码目录
/// （跳过 `.dev-source` 与 node_modules/target/dist 这类构建产物）。
pub(crate) fn collect_plugin_body_files(
    app: &AppHandle,
    plugin_id: &str,
) -> Result<Vec<(String, PathBuf)>, String> {
    let dir = data_dir(app)?.join(PLUGINS_DIR).join(plugin_id);
    let mut out = Vec::new();
    if !dir.is_dir() {
        return Ok(out);
    }
    let (source_dir, skip_build) = match dev_source_of(&dir) {
        Some(src) => (src, true),
        None => (dir, false),
    };
    let mut files = Vec::new();
    collect_dev_files(&source_dir, "", skip_build, &mut files)?;
    for (rel, path) in files {
        out.push((format!("{PLUGINS_DIR}/{plugin_id}/{rel}"), path));
    }
    Ok(out)
}

/// 读插件安装目录里 `plugin.json` 的 `backup` 段（读不到返回空对象）。
///
/// v3 的 blob / 按条拆分策略完全以插件声明为准：`plugin.json` 是插件自己的声明，
/// 同步内核不硬编码插件 id。旧插件没有这些字段时按空策略处理，行为不变——
/// 需要参与 v3 的插件随自身更新把声明带到用户机上。
pub(crate) fn plugin_backup_policy(app: &AppHandle, plugin_id: &str) -> Value {
    let path = data_dir(app)
        .ok()
        .map(|root| root.join(PLUGINS_DIR).join(plugin_id).join("plugin.json"));
    let Some(path) = path else { return json!({}) };
    let value: Value = std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null);
    value
        .get("backup")
        .cloned()
        .filter(|b| b.is_object())
        .unwrap_or_else(|| json!({}))
}

/// 插件数据（`plugin-data/<id>/` 里**该上云**的部分 + `sync-store/<id>.json`）。
pub(crate) fn collect_plugin_data_files(
    app: &AppHandle,
    plugin_id: &str,
) -> Result<Vec<(String, PathBuf)>, String> {
    let root = data_dir(app)?;
    let mut out = Vec::new();
    let data = root.join(PLUGIN_DATA_DIR).join(plugin_id);
    if data.is_dir() {
        let allow = cloud_data_allowlist(app, plugin_id);
        let mut files = Vec::new();
        collect_files(&data, "", &mut files)?;
        for (rel, path) in files {
            if is_reconstructible_plugin_data(&format!("{plugin_id}/{rel}")) {
                continue;
            }
            if !allow.iter().any(|p| path_covered(&rel, p)) {
                continue;
            }
            out.push((format!("{PLUGIN_DATA_DIR}/{plugin_id}/{rel}"), path));
        }
    }
    let store = root.join(SYNC_STORE_DIR).join(format!("{plugin_id}.json"));
    if store.is_file() {
        out.push((format!("{SYNC_STORE_DIR}/{plugin_id}.json"), store));
    }
    Ok(out)
}

/// v3 blobs：`plugin.json` 的 `backup.blobs` 前缀下、**不在** `pluginData`
/// 白名单里的文件（例如剪贴板 PNG）。
///
/// 为什么单独声明：图片可能很大，不能混进常规 data 片；但它们又必须跨设备同步。
/// 只按显式前缀收集，避免把插件的录屏/工具缓存等本机大文件误上云。
pub(crate) fn collect_plugin_blob_files(
    app: &AppHandle,
    plugin_id: &str,
    only: Option<&std::collections::HashSet<String>>,
) -> Result<Vec<(String, PathBuf)>, String> {
    let root = data_dir(app)?;
    let data = root.join(PLUGIN_DATA_DIR).join(plugin_id);
    if !data.is_dir() {
        return Ok(Vec::new());
    }
    let policy = plugin_backup_policy(app, plugin_id);
    let prefixes: Vec<String> = policy
        .get("blobs")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty() && !s.contains("..") && !s.starts_with('/'))
                .map(|s| s.trim_matches('/').to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();
    if prefixes.is_empty() {
        return Ok(Vec::new());
    }
    let allow = cloud_data_allowlist(app, plugin_id);
    let mut files = Vec::new();
    collect_files(&data, "", &mut files)?;
    let mut out = Vec::new();
    for (rel, path) in files {
        if is_reconstructible_plugin_data(&format!("{plugin_id}/{rel}")) {
            continue;
        }
        if let Some(only) = only {
            if !only.contains(&rel) {
                continue;
            }
        }
        if !prefixes.iter().any(|p| path_covered(&rel, p)) {
            continue;
        }
        // 已由 `pluginData` 显式覆盖的文件不重复进 blob（例如 index.json）
        if allow.iter().any(|p| path_covered(&rel, p)) {
            continue;
        }
        out.push((format!("{PLUGIN_DATA_DIR}/{plugin_id}/{rel}"), path));
    }
    Ok(out)
}

/// 内核分片：内部状态 + 用户配置（localStorage 由前端按「非插件键」切好传入）。
pub(crate) fn collect_core_files(app: &AppHandle) -> Result<Vec<(String, PathBuf)>, String> {
    let mut out = Vec::new();
    collect_internal_files(app, &mut out)?;
    Ok(out)
}

/// 本机存在可同步数据的所有插件 id（已安装目录 ∪ plugin-data 目录 ∪ sync-store 文件）
pub(crate) fn syncable_plugin_ids(app: &AppHandle) -> Result<Vec<String>, String> {
    let root = data_dir(app)?;
    let mut ids: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for (dir, kind) in [
        (root.join(PLUGINS_DIR), 0u8),
        (root.join(PLUGIN_DATA_DIR), 1u8),
        (root.join(SYNC_STORE_DIR), 2u8),
    ] {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            match kind {
                0 | 1 => {
                    if entry.path().is_dir() {
                        ids.insert(name);
                    }
                }
                _ => {
                    if let Some(id) = name.strip_suffix(".json") {
                        ids.insert(id.to_string());
                    }
                }
            }
        }
    }
    Ok(ids.into_iter().collect())
}

/// 一个分片的内容摘要：文件内容 + 分片自带的 localStorage 子集（+ core 的 Rust 设置）。
///
/// 为什么按**文件内容**而不是 mtime：还原会重写文件、改 mtime，按时间做摘要会让
/// 「刚还原完」立刻被判成「本机有改动」→ 每轮都白传一次。
pub(crate) fn shard_digest(
    files: &[(String, PathBuf)],
    local_storage: Option<&Value>,
    settings: Option<&Value>,
) -> Result<(String, u64), String> {
    use sha2::{Digest, Sha256};

    let mut list: Vec<(String, String, u64)> = Vec::with_capacity(files.len());
    for (rel, path) in files {
        let bytes = std::fs::read(path)
            .map_err(|e| err(format!("读取分片文件失败 {}: {e}", path.display())))?;
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let file_hash: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
        list.push((rel.clone(), file_hash, bytes.len() as u64));
    }
    list.sort_by(|a, b| a.0.cmp(&b.0));

    let mut hasher = Sha256::new();
    for (rel, hash, size) in &list {
        hasher.update(rel.as_bytes());
        hasher.update([0u8]);
        hasher.update(hash.as_bytes());
        hasher.update([0u8]);
        hasher.update(size.to_string().as_bytes());
        hasher.update([0u8]);
    }
    if let Some(ls) = local_storage {
        hasher.update(canonical_json(ls).as_bytes());
    }
    if let Some(st) = settings {
        hasher.update(canonical_json(st).as_bytes());
    }
    let digest = hasher.finalize();
    let total = list.iter().map(|(_, _, size)| *size).sum::<u64>();
    Ok((digest.iter().map(|b| format!("{b:02x}")).collect(), total))
}

/// 稳定序列化（对象键排序），保证同一份数据在不同设备/不同轮次摘要一致。
pub(crate) fn canonical_json(value: &Value) -> String {
    fn write(value: &Value, out: &mut String) {
        match value {
            Value::Object(map) => {
                let mut entries: Vec<(&String, &Value)> = map.iter().collect();
                entries.sort_by(|a, b| a.0.cmp(b.0));
                out.push('{');
                for (i, (k, v)) in entries.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&serde_json::to_string(k).unwrap_or_default());
                    out.push(':');
                    write(v, out);
                }
                out.push('}');
            }
            Value::Array(items) => {
                out.push('[');
                for (i, v) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write(v, out);
                }
                out.push(']');
            }
            other => out.push_str(&serde_json::to_string(other).unwrap_or_default()),
        }
    }
    let mut out = String::new();
    write(value, &mut out);
    out
}

#[cfg(test)]
mod shard_tests {
    use super::{canonical_json, shard_digest};
    use serde_json::json;

    #[test]
    fn canonical_json_is_key_order_independent() {
        let a = json!({"b": 1, "a": {"y": 2, "x": 3}});
        let b = json!({"a": {"x": 3, "y": 2}, "b": 1});
        assert_eq!(canonical_json(&a), canonical_json(&b));
    }

    #[test]
    fn shard_digest_ignores_mtime_but_tracks_content() {
        let dir = std::env::temp_dir().join(format!("ms-shard-digest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("a.txt");
        std::fs::write(&f, b"one").unwrap();
        let files = vec![("plugins/demo/a.txt".to_string(), f.clone())];
        let ls = json!({"PLUGIN_DATA:demo:k": 1});
        let (d1, size1) = shard_digest(&files, Some(&ls), None).unwrap();

        // 内容不变 → 摘要不变（写一次文件会改 mtime，这里验证不依赖 mtime）
        std::fs::write(&f, b"one").unwrap();
        let (d2, _) = shard_digest(&files, Some(&ls), None).unwrap();
        assert_eq!(d1, d2);
        assert_eq!(size1, 3);

        // 内容变了 → 摘要变
        std::fs::write(&f, b"two").unwrap();
        let (d3, _) = shard_digest(&files, Some(&ls), None).unwrap();
        assert_ne!(d1, d3);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 云数据白名单：默认只有 `kv`，声明数组则以声明为准（剪贴板就是这么声明的）。
    #[test]
    fn data_allowlist_follows_manifest_declaration() {
        // 没声明 → 只同步 kv
        let plain = json!({"id": "demo"});
        assert_eq!(super::data_allowlist_from_manifest(&plain), vec!["kv"]);

        // 剪贴板式：kv + 历史索引（分类/收藏的注解在 kv 里，条目本体在 index.json）
        let clipboard = json!({"backup": {"pluginData": ["kv", "clipboard/index.json"]}});
        assert_eq!(
            super::data_allowlist_from_manifest(&clipboard),
            vec!["kv", "clipboard/index.json"],
            "显式声明必须原样生效"
        );

        // 全量 / 全禁 / 越权路径
        assert_eq!(
            super::data_allowlist_from_manifest(&json!({"backup": {"pluginData": true}})),
            vec!["*"]
        );
        assert!(super::data_allowlist_from_manifest(&json!({"backup": {"pluginData": false}}))
            .is_empty());
        assert_eq!(
            super::data_allowlist_from_manifest(&json!({"backup": {"pluginData": ["../etc", "", "/kv/"]}})),
            vec!["kv"],
            "丢弃逃逸路径与空项，允许项去掉首尾斜杠"
        );

        // 前缀匹配：精确文件、目录前缀都命中，形近名不命中
        assert!(super::path_covered("clipboard/index.json", "clipboard/index.json"));
        assert!(!super::path_covered("clipboard/index.json.bak", "clipboard/index.json"));
        assert!(super::path_covered("clipboard/index.json", "clipboard"));
        assert!(super::path_covered("kv/annotations.json", "kv"));
        assert!(!super::path_covered("kvx/a.json", "kv"));
    }
}

/// 导出归档的字节流（**内存版**）。
///
/// `settings` 是前端从 Rust 侧「可备份的设置键」里读出来的（前端才是这些键的
/// 使用方，Rust 只负责落盘），`local_storage` 是前端整个 localStorage 快照。
///
/// 注意：所有**写盘/上传**路径都已改用 `write_archive_to_path`（流式，内存占用与
/// 归档大小无关）。本函数保留为「需要拿到完整字节」的通用实现（例如未来的
/// 内存内校验/测试场景）。
#[allow(dead_code)]
pub fn build_archive(
    app: &AppHandle,
    local_storage: Value,
    settings: Value,
    app_version: &str,
) -> Result<Vec<u8>, String> {
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    collect_plugin_files(app, &mut files)?;
    collect_internal_files(app, &mut files)?;
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
    let sync_store_count = files
        .iter()
        .filter(|(rel, _)| rel.starts_with(&format!("{SYNC_STORE_DIR}/")))
        .count();
    let internal_count = files
        .iter()
        .filter(|(rel, _)| rel.starts_with(&format!("{INTERNAL_DIR}/")))
        .count();
    let plugin_data_count = files.len() - plugin_count - sync_store_count - internal_count;
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
            "syncStoreFiles": sync_store_count,
            "internalFiles": internal_count,
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

/// 流式打包：把归档**直接写进 sink**（文件），逐条目 `io::copy` 流式拷贝，
/// 任何单个插件文件都不会被整块读进内存。
///
/// 为什么需要：`build_archive` 会把 `plugins/` + `plugin-data/` 下每个文件都读成
/// `Vec<u8>`，再在内存里 zip 一遍。对「录屏」这类把 mp4 写进
/// `plugin-data/recordings/` 的用户，一次云同步上传会让 RSS 峰值达到归档大小的
/// 2~3 倍——几个 GB 就会 OOM。写盘路径不需要内存副本，改为流式后内存占用只与
/// `io::copy` 的分块缓冲有关。
///
/// 归档内容（清单字段、条目顺序、超大条目跳过规则）与 `build_archive` 完全一致；
/// 读不出来的文件仍按错误返回（与旧行为一致）。
fn write_archive_stream<W: Write + Seek>(
    sink: W,
    local_storage: &Value,
    settings: &Value,
    files: &[(String, PathBuf)],
    app_version: &str,
) -> Result<W, String> {
    let mut writer = zip::ZipWriter::new(sink);
    let options: zip::write::FileOptions<'_, ()> =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let plugin_count = files
        .iter()
        .filter(|(rel, _)| rel.starts_with(&format!("{PLUGINS_DIR}/")))
        .count();
    let sync_store_count = files
        .iter()
        .filter(|(rel, _)| rel.starts_with(&format!("{SYNC_STORE_DIR}/")))
        .count();
    let internal_count = files
        .iter()
        .filter(|(rel, _)| rel.starts_with(&format!("{INTERNAL_DIR}/")))
        .count();
    let plugin_data_count = files.len() - plugin_count - sync_store_count - internal_count;
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
            "syncStoreFiles": sync_store_count,
            "internalFiles": internal_count,
        },
        "platform": std::env::consts::OS,
    });

    // 1) 清单 / 2) localStorage / 3) Rust 侧设置（与内存版逐字节同样的 pretty JSON）
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
    writer
        .start_file(ENTRY_LOCAL_STORAGE, options)
        .map_err(|e| err(format!("写入归档失败: {e}")))?;
    writer
        .write_all(
            serde_json::to_string_pretty(local_storage)
                .map_err(|e| err(format!("序列化失败: {e}")))?
                .as_bytes(),
        )
        .map_err(|e| err(format!("写入归档失败: {e}")))?;
    writer
        .start_file(ENTRY_SETTINGS, options)
        .map_err(|e| err(format!("写入归档失败: {e}")))?;
    writer
        .write_all(
            serde_json::to_string_pretty(settings)
                .map_err(|e| err(format!("序列化失败: {e}")))?
                .as_bytes(),
        )
        .map_err(|e| err(format!("写入归档失败: {e}")))?;

    // 4) 插件文件与插件数据（流式拷贝，绝不整块读入）
    for (rel, path) in files {
        let meta = std::fs::metadata(path)
            .map_err(|e| err(format!("读取失败 {}: {e}", path.display())))?;
        if meta.len() > MAX_ENTRY_BYTES {
            continue;
        }
        let mut src =
            std::fs::File::open(path).map_err(|e| err(format!("读取失败 {}: {e}", path.display())))?;
        writer
            .start_file(rel.as_str(), options)
            .map_err(|e| err(format!("写入归档失败 {rel}: {e}")))?;
        std::io::copy(&mut src, &mut writer)
            .map_err(|e| err(format!("写入归档失败 {rel}: {e}")))?;
    }

    writer
        .finish()
        .map_err(|e| err(format!("归档收尾失败: {e}")))
}

/// 计算「本机可同步数据」的指纹（插件安装文件 / 插件私有数据 / 内部状态）。
///
/// 云同步判断「本机到底变没变」时，**必须**把落盘数据也算进去：插件私有数据
/// （剪贴板历史索引、待办、AI 会话…）与插件安装文件都进备份归档，但它们不在
/// localStorage 里。只看 localStorage 摘要会出现「插件数据变了，但判定本机没变
/// → 跳过上传」，这正是「本地要同步的数据变了却不触发同步」的根因之一。
///
/// 指纹只取 `(相对路径, 字节数, 修改时间)`，不读文件内容：
/// - 目录里有 GB 级录屏也能秒级完成；
/// - 可重建缓存（ffmpeg / exe 等）与备份规则**同一套排除**，避免
///   「插件下载工具」被误判成「用户数据变化」而触发上传。
pub fn data_digest(app: &AppHandle) -> Result<String, String> {
    use sha2::{Digest, Sha256};

    let mut files: Vec<(String, PathBuf)> = Vec::new();
    collect_plugin_files(app, &mut files)?;
    collect_internal_files(app, &mut files)?;
    // 排序保证同一份目录内容得到同一个指纹（与遍历顺序无关）
    files.sort_by(|a, b| a.0.cmp(&b.0));

    let mut hasher = Sha256::new();
    for (rel, path) in &files {
        let Ok(meta) = std::fs::metadata(path) else {
            // 遍历与读取之间文件消失：跳过（下次会重新算），不让同步因此失败
            continue;
        };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis())
            .unwrap_or(0);
        hasher.update(rel.as_bytes());
        hasher.update([0u8]);
        hasher.update(meta.len().to_le_bytes());
        hasher.update(mtime.to_le_bytes());
    }

    let digest = hasher.finalize();
    Ok(digest.iter().map(|b| format!("{b:02x}")).collect())
}

/// 把当前状态**流式**导出为归档文件，返回文件字节数。
///
/// 与 `build_archive` 产出的归档内容一致，但内存占用从「归档大小 × 2~3」
/// 降到常数级（见 `write_archive_stream` 的说明）。
pub fn write_archive_to_path(
    app: &AppHandle,
    path: &Path,
    local_storage: Value,
    settings: Value,
    app_version: &str,
) -> Result<u64, String> {
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    collect_plugin_files(app, &mut files)?;
    collect_internal_files(app, &mut files)?;
    let file = std::fs::File::create(path).map_err(|e| err(format!("写入失败: {e}")))?;
    let file = write_archive_stream(file, &local_storage, &settings, &files, app_version)?;
    Ok(file.metadata().map(|m| m.len()).unwrap_or(0))
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
    let mut sync_store_files = 0usize;
    let mut internal_files = 0usize;
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
        } else if name.starts_with(&format!("{SYNC_STORE_DIR}/")) {
            sync_store_files += 1;
        } else if name.starts_with(&format!("{INTERNAL_DIR}/")) {
            internal_files += 1;
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
        "syncStoreFiles": sync_store_files,
        "hasSettings": !settings.is_null(),
        "hasPlugins": plugin_files > 0,
        "hasPluginData": plugin_data_files > 0,
        "hasSyncStore": sync_store_files > 0,
        "hasInternal": internal_files > 0,
        "internalFiles": internal_files,
        "totalBytes": entries.values().map(|v| v.len() as u64).sum::<u64>(),
    }))
}

/// 还原结果（给前端决定「要不要提示重启」）
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    /// 还原前自动留底的归档路径
    pub snapshot_path: Option<String>,
    /// 实际写回的 localStorage 键数（Rust 按范围过滤后交给前端写回）
    pub local_storage_keys: usize,
    /// 写回的插件数
    pub plugins: usize,
    /// 写回的插件数据目录数
    pub plugin_data: usize,
    /// 是否写回了 Rust 侧设置
    pub settings: bool,
    /// 是否写回了内部状态
    pub internal: bool,
    /// 面向 `sync://applied` 广播的作用域：`all` / `plugins` / `config`
    pub scope: String,
    /// 被「版本守卫」跳过的插件（本机版本高于归档版本，拒绝降级）
    pub downgrade_skipped: Vec<String>,
}

/// 还原范围（把面板的粗粒度选项翻译成各分区的布尔开关）。
#[derive(Debug, Clone, Copy, Default)]
struct RestoreScope {
    /// localStorage 全量（仅 legacy 的 `localStorage` 选项）
    local_all: bool,
    /// localStorage 中的插件部分（注册表键 + `PLUGIN_DATA:*`）
    local_plugins: bool,
    /// localStorage 中的用户配置部分
    local_config: bool,
    settings: bool,
    plugins: bool,
    plugin_data: bool,
    internal: bool,
}

impl RestoreScope {
    fn all() -> Self {
        Self {
            local_all: true,
            local_plugins: true,
            local_config: true,
            settings: true,
            plugins: true,
            plugin_data: true,
            internal: true,
        }
    }

    /// 还原会影响哪些运行时资源。
    ///
    /// - 插件文件 / 插件数据 / 注册表 / 内部状态 → 插件视图与后台必须重载；
    /// - 用户配置 / Rust 设置 → 只需重应用主题等前端状态，不打断插件。
    ///
    /// 两者都有时返回 `all`。返回给前端用于决定 `sync://applied` 后的动作，
    /// 避免「只导入了订阅配置却把所有插件重载一遍」这种无谓抖动。
    fn broadcast_scope(&self) -> &'static str {
        let touches_plugins = self.plugins
            || self.plugin_data
            || self.internal
            || self.local_plugins
            || self.local_all;
        let touches_config = self.settings || self.local_config || self.local_all;
        match (touches_plugins, touches_config) {
            (true, true) => "all",
            (true, false) => "plugins",
            (false, true) => "config",
            // 空范围（调用方传了无法识别的分类）：按全量处理，宁可多刷新一次
            (false, false) => "all",
        }
    }
}

/// 解析还原范围。
///
/// 新语义（面向用户的两个选项）：
/// - `all`：全量
/// - `plugins`：插件安装文件 + 插件数据 + 插件注册表（localStorage 里的
///   `PLUGIN_REGISTRY_CACHE_KEY` 与 `PLUGIN_DATA:*`）
/// - `config`：用户配置（localStorage 用户键）+ Rust 侧设置
///
/// 旧调用方传的 `localStorage / settings / plugins / pluginData / internal`
/// 仍然兼容，避免历史代码或用户脚本突然失效。
fn parse_restore_scope(only: &[String]) -> RestoreScope {
    let has = |part: &str| only.iter().any(|x| x.eq_ignore_ascii_case(part));
    if only.is_empty() || has("all") {
        return RestoreScope::all();
    }
    let mut scope = RestoreScope::default();
    if has("plugins") {
        scope.plugins = true;
        scope.plugin_data = true;
        scope.internal = true;
        scope.local_plugins = true;
    }
    if has("pluginData") {
        scope.plugin_data = true;
        scope.local_plugins = true;
    }
    if has("internal") {
        scope.internal = true;
    }
    if has("settings") {
        scope.settings = true;
    }
    if has("config") {
        scope.settings = true;
        scope.local_config = true;
    }
    if has("localStorage") {
        scope.local_all = true;
    }
    scope
}

/// 该还原范围是否会写插件目录（需要先停后台进程、解除文件占用）。
pub fn scope_needs_plugin_stop(only: &[String]) -> bool {
    let scope = parse_restore_scope(only);
    scope.plugins || scope.plugin_data
}

/// 当前已安装的插件 id（还原前需要逐个停后台进程）。
pub fn installed_plugin_ids(app: &AppHandle) -> Vec<String> {
    data_dir(app)
        .map(|root| installed_plugin_dirs(&root.join(PLUGINS_DIR)))
        .unwrap_or_default()
}

/// 跨机还原时不能写回的键：凭据与可重建缓存。
fn is_protected_local_key(key: &str) -> bool {
    matches!(
        key,
        "USER_GITHUB_TOKEN_CACHE_KEY"
            | "SYNC_CONFIG_CACHE_KEY"
            | "SYNC_STATE_CACHE_KEY"
            | "SEARCH_DATA_KEY"
            | "OLD_SEARCH_DATAS_KEY"
            | "SUBSCRIBE_FINGERPRINT_CACHE_KEY"
            | "PLUGIN_RESTART_MARKS_CACHE_KEY"
    )
}

/// 属于「插件」范畴的 localStorage 键（注册表 + 插件私有数据）。
fn is_plugin_local_key(key: &str) -> bool {
    key == "PLUGIN_REGISTRY_CACHE_KEY" || key.starts_with("PLUGIN_DATA:")
}

/// 按范围过滤归档里的 localStorage 快照。
///
/// 关键修复：旧实现无条件把整份 localStorage 返回给前端，导致「仅插件与设置」
/// 也会把订阅/历史/标签等配置一起覆盖。现在过滤在 Rust 侧完成——前端只负责
/// 写回，避免「前端忘了判断范围」这类重复实现。
fn filter_local_storage(value: Value, scope: RestoreScope) -> Value {
    let Some(map) = value.as_object() else {
        return json!({});
    };
    let mut out = serde_json::Map::new();
    for (key, value) in map {
        if is_protected_local_key(key) {
            continue;
        }
        let plugin_key = is_plugin_local_key(key);
        let keep = scope.local_all
            || (plugin_key && scope.local_plugins)
            || (!plugin_key && scope.local_config);
        if keep {
            out.insert(key.clone(), value.clone());
        }
    }
    Value::Object(out)
}

// ===================== 插件目录事务 =====================

/// 还原日志：跨进程崩溃后据此回滚/清理
const RESTORE_JOURNAL: &str = ".restore-journal.json";
/// 还原中转目录前缀（与 `plugins/` 同卷，保证 rename 原子）
const RESTORE_STAGING_PREFIX: &str = ".restore-staging-";
/// 旧插件目录备份前缀（交换后异步删除；崩溃时由启动恢复清理）
const RESTORE_OLD_PREFIX: &str = ".restore-old-";

#[derive(Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoreJournal {
    target: String,
    staging: String,
    old: Option<String>,
}

fn journal_path(root: &Path) -> PathBuf {
    root.join(RESTORE_JOURNAL)
}

fn write_journal(root: &Path, journal: &RestoreJournal) -> Result<(), String> {
    let text = serde_json::to_string_pretty(journal).map_err(|e| err(format!("写还原日志失败: {e}")))?;
    std::fs::write(journal_path(root), text).map_err(|e| err(format!("写还原日志失败: {e}")))
}

/// 读某个插件目录里 `plugin.json` 的 version（读不到返回 None）。
fn local_dir_plugin_version(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join("plugin.json")).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    value
        .get("version")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 读归档条目里某插件 `plugins/<id>/plugin.json` 的 version。
fn archive_plugin_version(entries: &BTreeMap<String, Vec<u8>>, id: &str) -> Option<String> {
    let bytes = entries.get(&format!("{PLUGINS_DIR}/{id}/plugin.json"))?;
    let value: Value = serde_json::from_slice(bytes).ok()?;
    value
        .get("version")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 递归复制目录（插件目录很小，几 KB ~ 几 MB）。
fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&entry.path(), &to)?;
        } else {
            std::fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
}

/// 计算「归档里比本机更旧」的插件 id 集合（版本守卫）。
///
/// 独立成函数的原因：不只「还原安装文件」需要它，「只还原插件数据」同样需要——
/// 否则旧版本的私有数据会覆盖新版本写的数据（格式可能读不回来）。
fn downgrade_skipped_of(
    entries: &BTreeMap<String, Vec<u8>>,
    data_root: &Path,
) -> std::collections::BTreeSet<String> {
    let prefix = format!("{PLUGINS_DIR}/");
    let mut archive_ids: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for name in entries.keys() {
        let Some(rest) = name.strip_prefix(&prefix) else {
            continue;
        };
        if rest.is_empty() || rest.starts_with(".staging/") {
            continue;
        }
        if let Some(id) = rest.split('/').next() {
            if !id.is_empty() {
                archive_ids.insert(id.to_string());
            }
        }
    }

    let local_root = data_root.join(PLUGINS_DIR);
    let mut skipped: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for id in &archive_ids {
        let (Some(arch_v), Some(local_v)) = (
            archive_plugin_version(entries, id),
            local_dir_plugin_version(&local_root.join(id)),
        ) else {
            continue;
        };
        if crate::compare_versions(&local_v, &arch_v) > 0 {
            skipped.insert(id.clone());
        }
    }
    skipped
}

/// 把归档里的插件文件写入同卷 staging 目录，然后「旧目录改名 → staging 改名」
/// 完成交换。
///
/// 为什么不用 `reset_dir`：先删后写意味着中途失败就只剩一半插件；而且运行中的
/// exe 会锁文件导致删除失败。交换式还原保证最终状态要么是旧目录、要么是新目录。
///
/// **版本守卫（防降级）**：归档可能来自更早的备份、或装的插件更旧的另一台设备。
/// 逐插件比较版本，**本机版本更高就保留本机目录**（拷进 staging），并把该 id 回传，
/// 供调用方跳过它的 `plugin-data/`、并让前端保留本机注册表记录（版本号与磁盘代码
/// 始终一致，避免「低版本代码 + 高版本号」）。
///
/// 返回 `(实际还原的插件数, 因降级被跳过的插件 id)`。
fn restore_plugins(
    entries: &BTreeMap<String, Vec<u8>>,
    data_root: &Path,
    downgrade_skipped: &std::collections::BTreeSet<String>,
) -> Result<(usize, Vec<String>), String> {
    // 归档里根本没有插件文件（早期备份 / 只备份配置）：不做目录交换。
    // 否则一次「仅插件」还原会把本机现有插件全部清空。
    let prefix = format!("{PLUGINS_DIR}/");
    if !entries.keys().any(|name| name.starts_with(&prefix)) {
        return Ok((0, Vec::new()));
    }

    let target_root = data_root.join(PLUGINS_DIR);

    let stamp = restore_stamp();
    let staging_root = data_root.join(format!("{RESTORE_STAGING_PREFIX}{stamp}"));
    let staged_plugins = staging_root.join(PLUGINS_DIR);
    std::fs::create_dir_all(&staged_plugins).map_err(|e| err(format!("创建还原暂存目录失败: {e}")))?;

    let mut written: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for (name, data) in entries {
        let Some(rest) = name.strip_prefix(&prefix) else {
            continue;
        };
        if rest.is_empty() || rest.starts_with(".staging/") {
            continue;
        }
        // 开发挂载标记指向本机目录，跨机还原后只会指向不存在的路径
        if rest.ends_with("/.dev-source") || rest == ".dev-source" {
            continue;
        }
        let id = rest.split('/').next().unwrap_or("");
        // 降级保护：归档里这个插件的文件全部跳过（本机目录随后拷进 staging）
        if !id.is_empty() && downgrade_skipped.contains(id) {
            continue;
        }
        if !id.is_empty() {
            written.insert(id.to_string());
        }
        // 写入失败时清掉本次 staging，别把半套插件留在应用数据目录里
        if let Err(e) = write_relative(&staged_plugins, rest, data) {
            let _ = std::fs::remove_dir_all(&staging_root);
            return Err(e);
        }
    }

    // 被跳过的插件：把本机目录原样拷进 staging —— 交换是**整目录替换**，
    // 不拷回来等于把本机更高版本的插件删掉。
    for id in downgrade_skipped {
        let src = target_root.join(id);
        if !src.is_dir() {
            continue;
        }
        if let Err(e) = copy_dir_all(&src, &staged_plugins.join(id)) {
            let _ = std::fs::remove_dir_all(&staging_root);
            return Err(err(format!("保留本机插件目录失败（{id}）: {e}")));
        }
    }

    // staging 里一个插件都没有（归档只含残留条目）：不要交换，否则会清空本机插件
    if written.is_empty() && downgrade_skipped.is_empty() {
        let _ = std::fs::remove_dir_all(&staging_root);
        return Ok((0, Vec::new()));
    }

    let target = target_root;
    let old = data_root.join(format!("{RESTORE_OLD_PREFIX}{stamp}"));
    let journal = RestoreJournal {
        target: target.to_string_lossy().to_string(),
        staging: staging_root.to_string_lossy().to_string(),
        old: if target.exists() { Some(old.to_string_lossy().to_string()) } else { None },
    };
    write_journal(data_root, &journal)?;

    if target.exists() {
        std::fs::rename(&target, &old).map_err(|e| {
            let _ = std::fs::remove_dir_all(&staging_root);
            let _ = std::fs::remove_file(journal_path(data_root));
            err(format!(
                "替换插件目录失败（可能有插件仍在运行，请先停用后再试）: {e}"
            ))
        })?;
    }

    if let Err(e) = std::fs::rename(&staged_plugins, &target) {
        // 回滚：把旧目录改回去，保证用户至少还有还原前的插件
        if old.exists() && !target.exists() {
            let _ = std::fs::rename(&old, &target);
        }
        let _ = std::fs::remove_dir_all(&staging_root);
        let _ = std::fs::remove_file(journal_path(data_root));
        return Err(err(format!("写入新插件目录失败: {e}")));
    }

    let _ = std::fs::remove_dir_all(&staging_root);
    // 旧目录删除失败（例如杀毒软件短暂占用）不是致命错误：日志留给下次启动清理
    if old.exists() {
        if std::fs::remove_dir_all(&old).is_ok() {
            let _ = std::fs::remove_file(journal_path(data_root));
        }
    } else {
        let _ = std::fs::remove_file(journal_path(data_root));
    }
    Ok((written.len(), downgrade_skipped.iter().cloned().collect()))
}

/// 还原**单个插件的主体分片**（`plugins/<id>/`），不动其它插件。
///
/// 为什么不能复用 `backup_restore(["plugins"])`：那条路是「整个 `plugins/`
/// 目录事务交换」，一份只含一个插件的分片会把本机其它插件全部换掉。云同步 v2
/// 按插件分片传输，必须逐插件落地。
pub fn restore_plugin_shard(app: &AppHandle, path: &str, plugin_id: &str) -> Result<Value, String> {
    if plugin_id.is_empty()
        || plugin_id.len() > 64
        || !plugin_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        || plugin_id.starts_with('.')
    {
        return Err(err("非法插件 id"));
    }
    let bytes = read_backup_file(app, path)?;
    let entries = read_archive(&bytes)?;
    let prefix = format!("{PLUGINS_DIR}/{plugin_id}/");
    let shard: BTreeMap<String, Vec<u8>> = entries
        .into_iter()
        .filter(|(k, _)| k.starts_with(&prefix))
        .collect();
    if shard.is_empty() {
        return Err(err(format!("分片里没有插件 {plugin_id} 的主体文件")));
    }

    // 版本守卫：本机已装的版本更高时拒绝降级（保留本机文件）
    let root = data_dir(app)?;
    let plugins_root = root.join(PLUGINS_DIR);
    let target = plugins_root.join(plugin_id);
    if let (Some(arch_v), Some(local_v)) = (
        archive_plugin_version(&shard, plugin_id),
        local_dir_plugin_version(&target),
    ) {
        if crate::compare_versions(&local_v, &arch_v) > 0 {
            return Ok(json!({ "pluginId": plugin_id, "files": 0, "skipped": true, "localVersion": local_v }));
        }
    }

    let stamp = restore_stamp();
    let staging_root = plugins_root.join(format!(".shard-staging-{stamp}"));
    let staged = staging_root.join(plugin_id);
    std::fs::create_dir_all(&staged).map_err(|e| err(format!("创建暂存目录失败: {e}")))?;

    let mut files = 0usize;
    for (name, data) in &shard {
        let rest = name.strip_prefix(&prefix).unwrap_or("");
        if rest.is_empty() {
            continue;
        }
        // 开发挂载标记指向本机路径，跨机还原后无意义
        if rest == ".dev-source" || rest.ends_with("/.dev-source") {
            continue;
        }
        if let Err(e) = write_relative(&staged, rest, data) {
            let _ = std::fs::remove_dir_all(&staging_root);
            return Err(e);
        }
        files += 1;
    }
    if files == 0 {
        let _ = std::fs::remove_dir_all(&staging_root);
        return Ok(json!({ "pluginId": plugin_id, "files": 0, "skipped": false }));
    }

    // 交换：旧目录改名 → 新目录就位 → 删旧目录（失败也不致命）
    let old = plugins_root.join(format!(".shard-old-{stamp}-{plugin_id}"));
    if target.exists() {
        let _ = std::fs::remove_dir_all(&old);
        if let Err(e) = std::fs::rename(&target, &old) {
            let _ = std::fs::remove_dir_all(&staging_root);
            return Err(err(format!(
                "替换插件目录失败（插件可能仍在运行，请先停用）: {e}"
            )));
        }
    }
    if let Err(e) = std::fs::rename(&staged, &target) {
        if old.exists() && !target.exists() {
            let _ = std::fs::rename(&old, &target);
        }
        let _ = std::fs::remove_dir_all(&staging_root);
        return Err(err(format!("写入插件目录失败: {e}")));
    }
    let _ = std::fs::remove_dir_all(&staging_root);
    if old.exists() {
        let _ = std::fs::remove_dir_all(&old);
    }
    Ok(json!({ "pluginId": plugin_id, "files": files, "skipped": false }))
}

/// 应用启动时恢复未完成的还原事务（崩溃/断电留下的中转目录与旧目录）。
pub fn recover_restore(app: &AppHandle) {    let Ok(root) = data_dir(app) else {
        return;
    };
    let journal = journal_path(&root);
    if let Ok(text) = std::fs::read_to_string(&journal) {
        if let Ok(j) = serde_json::from_str::<RestoreJournal>(&text) {
            let target = PathBuf::from(&j.target);
            let staging = PathBuf::from(&j.staging);
            let old = j.old.as_ref().map(PathBuf::from);
            // 新目录没落地而旧目录还在 → 回滚
            if !target.exists() {
                if let Some(old) = old.as_ref().filter(|p| p.exists()) {
                    let _ = std::fs::rename(old, &target);
                }
            }
            let _ = std::fs::remove_dir_all(&staging);
            // 只有新目录确认存在时才删旧目录（否则那是唯一的数据）
            if target.exists() {
                if let Some(old) = old.as_ref() {
                    let _ = std::fs::remove_dir_all(old);
                }
            }
        }
        let _ = std::fs::remove_file(&journal);
    }

    // 没有日志的遗留中转/旧目录：只清理本模块的固定前缀，绝不碰用户目录。
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(RESTORE_STAGING_PREFIX) {
                let _ = std::fs::remove_dir_all(entry.path());
            } else if name.starts_with(RESTORE_OLD_PREFIX) {
                if root.join(PLUGINS_DIR).exists() {
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
        }
    }
}

/// 执行还原。
///
/// `only`：见 `parse_restore_scope`。`current_local_storage`：本机当前状态，
/// 用于还原前留底（**必须包含前端数据**，否则留底只剩插件文件，用户想反悔
/// 也拿不回配置）。
///
/// 插件目录走「staging + rename 交换」；`plugin-data/` 走**合并**并跳过可重建
/// 缓存（ffmpeg / exe / dll 等），不再整目录 `reset_dir` 把缓存删掉。
pub fn restore_archive(
    app: &AppHandle,
    bytes: &[u8],
    only: &[String],
    app_version: &str,
    current_local_storage: Value,
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

    let scope = parse_restore_scope(only);
    let data_root = data_dir(app)?;
    let mut report = RestoreReport {
        scope: scope.broadcast_scope().to_string(),
        ..RestoreReport::default()
    };

    // 1) 还原前留底（失败不阻断还原，只提示）
    if let Ok(dir) = backups_dir(app) {
        let pre = dir.join(format!("{PRE_RESTORE_PREFIX}{}.msbackup", restore_stamp()));
        if !pre.exists() {
            // 用「当前状态」重新打包一份，而不是复制原始归档：用户点还原时，
            // 本机可能已经比归档新，留底要留的是**当前**状态。
            // 走流式写盘：留底同样可能包含录屏等大文件，不能整块读进内存。
            let current = write_archive_to_path(
                app,
                &pre,
                current_local_storage,
                crate::read_backup_settings(app),
                app_version,
            );
            match current {
                Ok(_) => {
                    report.snapshot_path = Some(pre.to_string_lossy().to_string());
                }
                Err(e) => {
                    let _ = std::fs::remove_file(&pre);
                    eprintln!("还原前留底失败（继续还原）: {e}");
                }
            }
        }
    }

    // 2) localStorage：Rust 按范围过滤，前端只写回
    let local_storage = filter_local_storage(json_entry(&entries, ENTRY_LOCAL_STORAGE), scope);
    report.local_storage_keys = local_storage.as_object().map(|m| m.len()).unwrap_or(0);

    // 3) Rust 侧设置（合并式：只覆盖备份里存在的键，其余保持本机现状）
    if scope.settings {
        let settings = json_entry(&entries, ENTRY_SETTINGS);
        if let Some(map) = settings.as_object() {
            if !map.is_empty() {
                crate::write_backup_settings(app, map)?;
                report.settings = true;
            }
        }
    }

    // 4) 插件安装文件：整目录事务交换（含版本守卫：本机更高则不降级）
    //    守卫先算出来：即使本次只还原「插件数据」（scope.plugins=false），
    //    也要跳过更旧的那份数据，避免旧格式覆盖新版本写的数据。
    let downgrade_skipped = downgrade_skipped_of(&entries, &data_root);
    report.downgrade_skipped = downgrade_skipped.iter().cloned().collect();
    if scope.plugins {
        let (count, _) = restore_plugins(&entries, &data_root, &downgrade_skipped)?;
        report.plugins = count;
    }

    // 5) 插件私有数据：**合并**（不删除本机已有数据），跳过可重建缓存。
    //    旧实现整体 reset，会把 `plugin-data/<id>/` 下的 ffmpeg / exe / dll 删掉，
    //    用户还原后插件还得重新下载几百 MB。
    if scope.plugin_data {
        let root = data_root.join(PLUGIN_DATA_DIR);
        if !root.exists() {
            std::fs::create_dir_all(&root).map_err(|e| err(format!("创建插件数据目录失败: {e}")))?;
        }
        let mut ids: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        for (name, data) in &entries {
            let Some(rest) = name.strip_prefix(&format!("{PLUGIN_DATA_DIR}/")) else {
                continue;
            };
            if rest.is_empty() {
                continue;
            }
            if is_reconstructible_plugin_data(rest) {
                continue;
            }
            if let Some(id) = rest.split('/').next() {
                // 该插件因「本机版本更高」被跳过：保留本机数据，不让旧数据覆盖新版本
                if downgrade_skipped.contains(id) {
                    continue;
                }
                ids.insert(id.to_string());
            }
            write_relative(&root, rest, data)?;
        }
        report.plugin_data = ids.len();

        // 5b) 插件云数据 store（`sync-store/<id>.json`）：**合并**写回，
        //     同样尊重版本守卫（本机版本更高时不拿旧数据覆盖新版本写的键）。
        //     与 plugin-data 同一个还原分类：「只还原插件数据」也包含云数据。
        let sync_root = data_root.join(SYNC_STORE_DIR);
        if !sync_root.exists() {
            std::fs::create_dir_all(&sync_root)
                .map_err(|e| err(format!("创建插件云数据目录失败: {e}")))?;
        }
        for (name, data) in &entries {
            let Some(rest) = name.strip_prefix(&format!("{SYNC_STORE_DIR}/")) else {
                continue;
            };
            if rest.is_empty() || !rest.ends_with(".json") {
                continue;
            }
            let id = rest.strip_suffix(".json").unwrap_or(rest);
            if downgrade_skipped.contains(id) {
                continue;
            }
            write_relative(&sync_root, rest, data)?;
        }
    }

    // 6) 内部状态（内置插件卸载标记等，增量合并——保留本机既有文件，
    //    备份里有的覆盖，两边互补）
    if scope.internal {
        let root = data_root.join(INTERNAL_DIR);
        if !root.exists() {
            std::fs::create_dir_all(&root).map_err(|e| err(format!("创建内部状态目录失败: {e}")))?;
        }
        for (name, data) in &entries {
            let Some(rest) = name.strip_prefix(&format!("{INTERNAL_DIR}/")) else {
                continue;
            };
            if rest.is_empty() {
                continue;
            }
            write_relative(&root, rest, data)?;
            report.internal = true;
        }
    }

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

/// 当前状态导出为归档（「导出到备份目录」/「自动备份」用）。
///
/// 走流式写盘（`write_archive_to_path`）：归档可能包含录屏等大文件，
/// 不能先整块读进内存再写。
pub fn export_to_backups(
    app: &AppHandle,
    local_storage: Value,
    settings: Value,
    app_version: &str,
    prefix: &str,
) -> Result<String, String> {
    let dir = backups_dir(app)?;
    let name = format!("{prefix}{}.msbackup", file_stamp());
    let path = dir.join(&name);
    write_archive_to_path(app, &path, local_storage, settings, app_version)?;
    prune_backups(&dir, KEEP_BACKUPS);
    Ok(path.to_string_lossy().to_string())
}

/// 把一个「指定文件集合」打包写成归档（云同步 v2 的分片构建用）。
///
/// 与 `write_archive_to_path` 的区别：文件集合由调用方给（core / 插件主体 /
/// 插件数据各是一片），并且 localStorage 也只传该分片的子集。
pub(crate) fn write_archive_file_from_files(
    path: &Path,
    local_storage: Value,
    settings: Value,
    files: &[(String, PathBuf)],
    app_version: &str,
) -> Result<u64, String> {
    let file = std::fs::File::create(path).map_err(|e| err(format!("写入失败: {e}")))?;
    let file = write_archive_stream(file, &local_storage, &settings, files, app_version)?;
    file.metadata()
        .map(|m| m.len())
        .map_err(|e| err(format!("读取归档大小失败: {e}")))
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

/// 派生缓存判定（测试用）——见 `is_reconstructible_plugin_data` 的规则说明
#[allow(dead_code)]
pub fn is_reconstructible_plugin_data_public(rel: &str) -> bool {
    is_reconstructible_plugin_data(rel)
}

/// 解压归档（测试用）
#[allow(dead_code)]
pub fn read_archive_public(bytes: &[u8]) -> Result<BTreeMap<String, Vec<u8>>, String> {
    read_archive(bytes)
}

#[cfg(test)]
mod tests {
    use super::parse_restore_scope;

    /// 还原插件目录时的「版本守卫」：本机更高不降级，本机更低正常升级。
    #[test]
    fn restore_plugins_refuses_downgrade() {
        use super::restore_plugins;
        use std::collections::BTreeMap;

        let base = std::env::temp_dir().join(format!("ms-restore-guard-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let plugins = base.join("plugins");
        std::fs::create_dir_all(plugins.join("a")).unwrap();
        std::fs::create_dir_all(plugins.join("b")).unwrap();
        std::fs::write(plugins.join("a/plugin.json"), br#"{"id":"a","version":"2.0.0"}"#).unwrap();
        std::fs::write(plugins.join("a/ui.js"), b"local-new").unwrap();
        std::fs::write(plugins.join("b/plugin.json"), br#"{"id":"b","version":"1.0.0"}"#).unwrap();
        std::fs::write(plugins.join("b/ui.js"), b"local-old").unwrap();

        // 归档：a 是旧版本（应被拒绝），b 是新版本（应正常升级）
        let mut entries: BTreeMap<String, Vec<u8>> = BTreeMap::new();
        entries.insert(
            "plugins/a/plugin.json".into(),
            br#"{"id":"a","version":"1.0.0"}"#.to_vec(),
        );
        entries.insert("plugins/a/ui.js".into(), b"archive-old".to_vec());
        entries.insert(
            "plugins/b/plugin.json".into(),
            br#"{"id":"b","version":"2.0.0"}"#.to_vec(),
        );
        entries.insert("plugins/b/ui.js".into(), b"archive-new".to_vec());

        let skipped = super::downgrade_skipped_of(&entries, &base);
        let (count, reported) = restore_plugins(&entries, &base, &skipped).unwrap();
        assert_eq!(count, 1, "只有 b 被真正还原");
        assert_eq!(reported, vec!["a".to_string()], "a 因本机版本更高被跳过");

        let a_ui = std::fs::read_to_string(plugins.join("a/ui.js")).unwrap();
        assert_eq!(a_ui, "local-new", "本机更高版本的插件文件必须保留");
        let a_manifest: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(plugins.join("a/plugin.json")).unwrap())
                .unwrap();
        assert_eq!(a_manifest["version"], "2.0.0", "本机版本号不能被归档回退");

        let b_ui = std::fs::read_to_string(plugins.join("b/ui.js")).unwrap();
        assert_eq!(b_ui, "archive-new", "本机更低的插件应被升级");

        let _ = std::fs::remove_dir_all(&base);
    }

    /// 流式打包（写盘路径）必须与内存版产出**同样的归档内容**。
    ///
    /// 背景：为保证大文件（如插件录屏 mp4）不再整块进内存，导出/留底全部改走
    /// `write_archive_stream`。这里用 `Cursor<Vec<u8>>` 当 sink，与
    /// `build_archive_from_parts` 逐条目比对；唯一允许不同的是 manifest 的
    /// `exportedAt`（时间戳）。
    #[test]
    fn stream_archive_matches_in_memory_archive() {
        use super::{build_archive_from_parts, read_archive, write_archive_stream};
        use serde_json::json;
        use std::io::Cursor;

        let base = std::env::temp_dir().join(format!("ms-backup-stream-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("plugins/demo")).unwrap();
        std::fs::create_dir_all(base.join("plugin-data/demo/sub")).unwrap();
        std::fs::write(base.join("plugins/demo/a.txt"), b"hello").unwrap();
        std::fs::write(base.join("plugin-data/demo/sub/b.bin"), [0u8, 1, 2, 3]).unwrap();

        let files = vec![
            (
                "plugins/demo/a.txt".to_string(),
                base.join("plugins/demo/a.txt"),
            ),
            (
                "plugin-data/demo/sub/b.bin".to_string(),
                base.join("plugin-data/demo/sub/b.bin"),
            ),
        ];
        let ls = json!({ "subscribes": [1, 2, 3] });
        let st = json!({ "shortcut_bindings": [] });

        let out =
            write_archive_stream(Cursor::new(Vec::new()), &ls, &st, &files, "9.9.9").unwrap();
        let streamed = read_archive(&out.into_inner()).unwrap();

        let inmem = read_archive(
            &build_archive_from_parts(
                ls,
                st,
                vec![
                    ("plugins/demo/a.txt".to_string(), b"hello".to_vec()),
                    (
                        "plugin-data/demo/sub/b.bin".to_string(),
                        vec![0u8, 1, 2, 3],
                    ),
                ],
                "9.9.9",
            )
            .unwrap(),
        )
        .unwrap();

        assert_eq!(
            streamed.keys().collect::<Vec<_>>(),
            inmem.keys().collect::<Vec<_>>(),
            "条目集合/顺序不一致"
        );
        for key in inmem.keys() {
            if key == "manifest.json" {
                continue; // exportedAt 天然不同
            }
            assert_eq!(streamed.get(key), inmem.get(key), "条目 {key} 内容不一致");
        }
        let a: serde_json::Value =
            serde_json::from_slice(streamed.get("manifest.json").unwrap()).unwrap();
        let b: serde_json::Value =
            serde_json::from_slice(inmem.get("manifest.json").unwrap()).unwrap();
        for key in [
            "format",
            "formatVersion",
            "app",
            "appVersion",
            "counts",
            "platform",
        ] {
            assert_eq!(a.get(key), b.get(key), "manifest.{key} 不一致");
        }

        let _ = std::fs::remove_dir_all(&base);
    }

    fn scope_of(parts: &[&str]) -> String {
        let only: Vec<String> = parts.iter().map(|s| s.to_string()).collect();
        parse_restore_scope(&only).broadcast_scope().to_string()
    }

    #[test]
    fn broadcast_scope_matches_runtime_impact() {
        // 空/全量：所有窗口都按全量刷新
        assert_eq!(scope_of(&[]), "all");
        assert_eq!(scope_of(&["all"]), "all");
        // 只有插件：重载插件，不碰配置刷新路径
        assert_eq!(scope_of(&["plugins"]), "plugins");
        assert_eq!(scope_of(&["pluginData"]), "plugins");
        // 只有配置：不打断插件
        assert_eq!(scope_of(&["config"]), "config");
        assert_eq!(scope_of(&["settings"]), "config");
        // 两类都碰：按全量
        assert_eq!(scope_of(&["plugins", "config"]), "all");
        assert_eq!(scope_of(&["localStorage"]), "all");
        // 未知分类：保守按全量（宁可多刷新一次）
        assert_eq!(scope_of(&["whatever"]), "all");
    }

    /// 插件数据「上云白名单」的路径匹配：前缀语义，不能把 `kv2/` 误当 `kv/`。
    #[test]
    fn plugin_data_path_coverage() {
        use super::path_covered;
        assert!(path_covered("kv/state.json", "kv"));
        assert!(path_covered("kv", "kv"));
        assert!(!path_covered("kv2/a.json", "kv"), "相邻同名前缀不算命中");
        assert!(!path_covered("clipboard/a.png", "kv"), "剪贴板图片不上云");
        assert!(path_covered("clipboard/a.png", "*"), "清单声明 true 时全部上云");
        assert!(path_covered("sync/state.json", "sync"), "清单声明的前缀生效");
        assert!(!path_covered("sync-old/state.json", "sync"));
    }

    /// 开发挂载插件：源码仓库里的派生目录不进备份；普通安装不做这层过滤。
    #[test]
    fn dev_mount_skips_build_outputs() {
        use super::{collect_dev_files, is_dev_only_dir};

        for name in ["node_modules", "target", "dist", "build", "__pycache__"] {
            assert!(is_dev_only_dir(name), "{name} 不该进备份");
        }
        for name in ["ui", "backend", "plugin.json"] {
            assert!(!is_dev_only_dir(name), "{name} 是插件文件");
        }

        let base = std::env::temp_dir().join(format!("ms-dev-mount-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("node_modules/pkg")).unwrap();
        std::fs::create_dir_all(base.join("ui")).unwrap();
        std::fs::write(base.join("plugin.json"), b"{}").unwrap();
        std::fs::write(base.join("ui/index.html"), b"<html/>").unwrap();
        std::fs::write(base.join("node_modules/pkg/index.js"), b"junk").unwrap();

        let mut files = Vec::new();
        collect_dev_files(&base, "", true, &mut files).unwrap();
        let names: Vec<String> = files.iter().map(|(rel, _)| rel.clone()).collect();
        assert!(names.contains(&"plugin.json".to_string()));
        assert!(names.contains(&"ui/index.html".to_string()));
        assert!(
            !names.iter().any(|n| n.starts_with("node_modules/")),
            "开发挂载时 node_modules 不进备份: {names:?}"
        );

        // 普通安装（skip_build=false）：作者把 dist 当运行时目录时不能丢
        std::fs::create_dir_all(base.join("dist")).unwrap();
        std::fs::write(base.join("dist/app.js"), b"run").unwrap();
        let mut files = Vec::new();
        collect_dev_files(&base, "", false, &mut files).unwrap();
        let names: Vec<String> = files.iter().map(|(rel, _)| rel.clone()).collect();
        assert!(names.contains(&"dist/app.js".to_string()), "普通安装保留 dist/");

        let _ = std::fs::remove_dir_all(&base);
    }
}
