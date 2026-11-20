//! 剪贴板捕获原语：按需原生监听 + 只读抓取 + 环形缓冲落盘。
//!
//! ## 架构定位（微内核系统原语，零插件业务耦合）
//!
//! 本模块只提供**与具体插件无关的系统原语**：
//!   1. **按需监听**：仅当网关中存在「已启用、声明 `clipboardCapture` 且获授 `clipboard.read`」
//!      的插件时，才在主线程创建 message-only 隐藏窗口并挂载 `AddClipboardFormatListener`；
//!      插件被禁用、撤销权限或卸载后立即 `RemoveClipboardFormatListener` + `DestroyWindow`，
//!      系统层零残留监听、磁盘零写入。
//!   2. **纯原始捕获与保留集（Retention Set）**：Rust 只记录原始文本/位图帧及布尔 `retained`
//!      防淘汰位（保护插件引用的 `.png` 不被环形缓冲淘汰），**完全不感知**「收藏」「分类」
//!      「文本二次编辑」「标签分页」等上层插件业务概念——这些领域逻辑全部归还插件自身
//!      （通过通用 `ms.store.readJson/writeJson` 维护）。
//!   3. **无硬编码插件 ID**：每个订阅插件的数据独立存放在 `plugin-data/<plugin_id>/clipboard/`，
//!      天然接入 `.msbackup` 备份与卸载清理管线。
//!   4. **平滑兼容旧索引**：首次读到含历史 `favorite` / `category` 字段的旧版 `index.json` 时，
//!      自动提取到该插件的 `kv/annotations.legacy.json` 供插件侧无损接管，并将对应条目置为
//!      `retained = true`。
//!
//! ## 只读铁律
//!
//! 监听路径**只**做 `OpenClipboard` / `GetClipboardData` / `CloseClipboard`，
//! **绝不**调用 `EmptyClipboard` / `SetClipboardData`；唯一写剪贴板路径是用户显式触发的
//! `clipboard_history_copy`。

use std::collections::{BTreeMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, Ordering};
use std::sync::{LazyLock, Mutex, OnceLock};

use tauri::{AppHandle, Emitter};

use crate::plugin_host;

/// 抓取内容变更后广播给前端的事件名（payloadless：「事件唤醒、命令拉取」）。
pub const EVENT_CLIPBOARD_UPDATED: &str = "my-search://clipboard-updated";

/// 私有子目录名（位于 `plugin-data/<plugin_id>/clipboard`）
const CLIPBOARD_DIR: &str = "clipboard";

/// 图片文件后缀（落盘用）
const IMAGE_EXT: &str = "png";

/// 环形缓冲上限：非保留（`!retained`）文本条数
const MAX_TEXT_ITEMS: usize = 500;
/// 环形缓冲上限：非保留（`!retained`）图片张数
const MAX_IMAGE_ITEMS: usize = 100;
/// 单条文本最大长度（字符数）：超长文本按字符截断后入库，防止单条撑爆索引
const MAX_TEXT_CHARS: usize = 100_000;
/// 单张图片最大字节数（100 MB）：超过则跳过不记录
const MAX_IMAGE_BYTES: u32 = 100 * 1024 * 1024;
/// 同一剪贴板序列号重复触发时的忽略窗口（毫秒）
const DEDUP_MS: u64 = 120;

// ===================== 全局运行态 =====================

static APP: OnceLock<AppHandle> = OnceLock::new();
static ENABLED: AtomicBool = AtomicBool::new(false);
static WATCHER_HWND: AtomicIsize = AtomicIsize::new(0);
static LAST_SEQ: AtomicU32 = AtomicU32::new(0);
static LAST_AT_MS: LazyLock<Mutex<u64>> = LazyLock::new(|| Mutex::new(0));
static SEQ: AtomicU32 = AtomicU32::new(0);

// ===================== 原始捕获数据模型 =====================

/// 一条原始剪贴板捕获记录（不含插件层的收藏/分类等业务字段）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipItem {
    /// 稳定唯一 id（`t-<ms>-<seq>` / `f-<ms>-<seq>` / `i-<ms>-<seq>`）
    pub id: String,
    /// `"text"` | `"image"`
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rel_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    pub size: u64,
    pub created_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// 保留位：由插件通过 `setRetained` 声明，为真时豁免环形缓冲上限淘汰与默认清理
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub retained: bool,

    // ---- 仅用于反序列化旧版 index.json 做一次性无损迁移，永不写回 ----
    #[serde(default, rename = "favorite", skip_serializing)]
    legacy_favorite: bool,
    #[serde(default, rename = "category", skip_serializing)]
    legacy_category: Option<String>,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClipIndex {
    items: Vec<ClipItem>,
}

/// 旧版字段迁移载荷（供插件首次加载时导入自身 store）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct LegacyAnnotation {
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    favorite: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    category: Option<String>,
}

// ===================== 目录与路径校验 =====================

fn clipboard_dir(app: &AppHandle, plugin_id: &str) -> Result<std::path::PathBuf, String> {
    let dir = plugin_host::plugin_data_dir(app, plugin_id)?.join(CLIPBOARD_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建剪贴板历史目录失败: {e}"))?;
    Ok(dir)
}

fn index_path(app: &AppHandle, plugin_id: &str) -> Result<std::path::PathBuf, String> {
    Ok(clipboard_dir(app, plugin_id)?.join("index.json"))
}

fn legacy_annotations_path(app: &AppHandle, plugin_id: &str) -> Result<std::path::PathBuf, String> {
    let kv = plugin_host::plugin_data_dir(app, plugin_id)?.join("kv");
    std::fs::create_dir_all(&kv).map_err(|e| format!("创建插件存储目录失败: {e}"))?;
    Ok(kv.join("annotations.legacy.json"))
}

fn safe_image_path(app: &AppHandle, plugin_id: &str, rel: &str) -> Result<std::path::PathBuf, String> {
    if !plugin_host::is_safe_relative(rel) {
        return Err(format!("非法图片路径: {rel}"));
    }
    let normalized = rel.replace('\\', "/");
    let rest = normalized
        .strip_prefix(&format!("{CLIPBOARD_DIR}/"))
        .ok_or_else(|| format!("图片路径必须以 {CLIPBOARD_DIR}/ 开头"))?;
    if rest.is_empty() || rest.contains('/') {
        return Err("图片路径非法".to_string());
    }
    let ext_ok = rest
        .rsplit_once('.')
        .map(|(_, e)| e.eq_ignore_ascii_case(IMAGE_EXT))
        .unwrap_or(false);
    if !ext_ok {
        return Err("只允许读取 png 图片".to_string());
    }
    Ok(clipboard_dir(app, plugin_id)?.join(rest))
}

// ===================== 索引读写与旧数据一次性提取 =====================

/// 纯函数：从反序列化后的条目中提取旧版 `favorite` / `category` 字段并折算为 `retained`。
fn upgrade_legacy_items(items: &mut [ClipItem]) -> BTreeMap<String, LegacyAnnotation> {
    let mut migrated = BTreeMap::new();
    for it in items.iter_mut() {
        let cat = it
            .legacy_category
            .take()
            .map(|c| c.trim().to_string())
            .filter(|c| !c.is_empty());
        let fav = std::mem::replace(&mut it.legacy_favorite, false);
        if fav || cat.is_some() {
            it.retained = true;
            migrated.insert(
                it.id.clone(),
                LegacyAnnotation {
                    favorite: fav,
                    category: cat,
                },
            );
        }
    }
    migrated
}

fn load_index(app: &AppHandle, plugin_id: &str) -> ClipIndex {
    let Ok(path) = index_path(app, plugin_id) else {
        return ClipIndex::default();
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return ClipIndex::default();
    };
    let mut idx = serde_json::from_str::<ClipIndex>(&text).unwrap_or_default();
    let migrated = upgrade_legacy_items(&mut idx.items);
    if !migrated.is_empty() {
        // 先把提取出的旧版收藏/分类写入插件私有 kv/annotations.legacy.json（若已存在则合并），
        // 再把升级后的纯净索引（含 retained=true）原子写回，确保升级零丢失。
        if let Ok(legacy_path) = legacy_annotations_path(app, plugin_id) {
            let mut merged: BTreeMap<String, LegacyAnnotation> = std::fs::read_to_string(&legacy_path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();
            for (k, v) in migrated {
                merged.entry(k).or_insert(v);
            }
            if let Ok(json) = serde_json::to_string(&merged) {
                let _ = std::fs::write(&legacy_path, json);
            }
        }
        let _ = save_index(app, plugin_id, &idx);
    }
    idx
}

fn save_index(app: &AppHandle, plugin_id: &str, index: &ClipIndex) -> Result<(), String> {
    let path = index_path(app, plugin_id)?;
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string(index).map_err(|e| format!("序列化剪贴板索引失败: {e}"))?;
    std::fs::write(&tmp, text).map_err(|e| format!("写入剪贴板索引失败: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("替换剪贴板索引失败: {e}"))?;
    // 索引属于「可同步数据」（备份归档里的 plugin-data/<id>/clipboard/）：
    // 广播出去，常驻主窗口据此安排一轮云同步（5 秒节流合并连续复制）。
    let _ = app.emit(
        plugin_host::EVENT_PLUGIN_DATA_CHANGED,
        serde_json::json!({ "pluginId": plugin_id, "key": "clipboard/index", "removed": false }),
    );
    Ok(())
}

fn next_stamp() -> (u64, u32) {
    let ms = now_ms();
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    (ms, n)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn new_image_name(ms: u64, n: u32) -> String {
    format!("{ms}-{n}.{IMAGE_EXT}")
}

/// 文本归一化（剥除尾部 `\r\n`、空串返回 None、超长按字符截断）
fn normalize_captured_text(raw: &str) -> Option<String> {
    let trimmed = raw.trim_end_matches(['\r', '\n']);
    if trimmed.trim().is_empty() {
        return None;
    }
    let mut content = trimmed.to_string();
    if content.chars().count() > MAX_TEXT_CHARS {
        content = content.chars().take(MAX_TEXT_CHARS).collect();
    }
    Some(content)
}

// ===================== 原始捕获写入（分发给活跃订阅插件） =====================

fn push_text(app: &AppHandle, text: String) {
    let Some(content) = normalize_captured_text(&text) else {
        return;
    };
    let subscribers = plugin_host::clipboard_capture_plugin_ids();
    if subscribers.is_empty() {
        return;
    }
    let mut wrote_any = false;
    for pid in subscribers {
        let mut idx = load_index(app, &pid);
        if let Some(latest) = idx.items.iter().find(|it| it.kind == "text") {
            if latest.text.as_deref() == Some(content.as_str()) {
                continue;
            }
        }
        let (ms, n) = next_stamp();
        let item = ClipItem {
            id: format!("t-{ms}-{n}"),
            kind: "text".to_string(),
            text: Some(content.clone()),
            rel_path: None,
            width: None,
            height: None,
            size: content.len() as u64,
            created_at: ms,
            source: None,
            retained: false,
            legacy_favorite: false,
            legacy_category: None,
        };
        idx.items.insert(0, item);
        prune_index(app, &pid, &mut idx);
        if let Err(e) = save_index(app, &pid, &idx) {
            eprintln!("保存剪贴板文本历史失败（{pid}）: {e}");
        } else {
            wrote_any = true;
        }
    }
    if wrote_any {
        bump_seq_and_notify(app);
    }
}

fn push_files(app: &AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    let subscribers = plugin_host::clipboard_capture_plugin_ids();
    if subscribers.is_empty() {
        return;
    }
    let display = if paths.len() == 1 {
        paths[0].clone()
    } else {
        format!("{} 等 {} 个文件", paths[0], paths.len())
    };
    let Some(content) = normalize_captured_text(&paths.join("\n")) else {
        return;
    };
    let mut wrote_any = false;
    for pid in subscribers {
        let mut idx = load_index(app, &pid);
        if let Some(latest) = idx.items.iter().find(|it| it.kind == "text") {
            if latest.text.as_deref() == Some(content.as_str()) {
                continue;
            }
        }
        let (ms, n) = next_stamp();
        let item = ClipItem {
            id: format!("f-{ms}-{n}"),
            kind: "text".to_string(),
            text: Some(content.clone()),
            rel_path: None,
            width: None,
            height: None,
            size: content.len() as u64,
            created_at: ms,
            source: Some(format!("文件：{display}")),
            retained: false,
            legacy_favorite: false,
            legacy_category: None,
        };
        idx.items.insert(0, item);
        prune_index(app, &pid, &mut idx);
        if let Err(e) = save_index(app, &pid, &idx) {
            eprintln!("保存剪贴板文件历史失败（{pid}）: {e}");
        } else {
            wrote_any = true;
        }
    }
    if wrote_any {
        bump_seq_and_notify(app);
    }
}

fn push_image(app: &AppHandle, width: u32, height: u32, rgba: Vec<u8>) {
    if width == 0 || height == 0 {
        return;
    }
    let subscribers = plugin_host::clipboard_capture_plugin_ids();
    if subscribers.is_empty() {
        return;
    }
    let png = match crate::screenshot::encode_png(width, height, &rgba) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("剪贴板图片编码失败: {e}");
            return;
        }
    };
    if png.len() as u32 > MAX_IMAGE_BYTES {
        eprintln!("剪贴板图片过大（{} 字节），跳过记录", png.len());
        return;
    }
    let size = png.len() as u64;
    let mut wrote_any = false;
    for pid in subscribers {
        let dir = match clipboard_dir(app, &pid) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("{e}");
                continue;
            }
        };
        let (ms, n) = next_stamp();
        let name = new_image_name(ms, n);
        let full = dir.join(&name);
        if let Err(e) = std::fs::write(&full, &png) {
            eprintln!("写入剪贴板图片失败（{pid}）: {e}");
            continue;
        }
        let mut idx = load_index(app, &pid);
        let item = ClipItem {
            id: format!("i-{ms}-{n}"),
            kind: "image".to_string(),
            text: None,
            rel_path: Some(format!("{CLIPBOARD_DIR}/{name}")),
            width: Some(width),
            height: Some(height),
            size,
            created_at: ms,
            source: None,
            retained: false,
            legacy_favorite: false,
            legacy_category: None,
        };
        idx.items.insert(0, item);
        prune_index(app, &pid, &mut idx);
        if let Err(e) = save_index(app, &pid, &idx) {
            eprintln!("保存剪贴板图片历史失败（{pid}）: {e}");
        } else {
            wrote_any = true;
        }
    }
    if wrote_any {
        bump_seq_and_notify(app);
    }
}

/// 纯函数裁剪：保留 `retained == true` 的全部条目（不占配额），其余按上限保留最新。
/// 返回被淘汰的图片相对路径列表供磁盘清理。
fn prune_items(items: Vec<ClipItem>, max_text: usize, max_image: usize) -> (Vec<ClipItem>, Vec<String>) {
    let mut text_seen = 0usize;
    let mut image_seen = 0usize;
    let mut keep: Vec<ClipItem> = Vec::with_capacity(items.len());
    let mut evicted_images: Vec<String> = Vec::new();

    for item in items {
        if item.retained {
            keep.push(item);
            continue;
        }
        match item.kind.as_str() {
            "image" => {
                if image_seen < max_image {
                    image_seen += 1;
                    keep.push(item);
                } else if let Some(rel) = item.rel_path {
                    evicted_images.push(rel);
                }
            }
            _ => {
                if text_seen < max_text {
                    text_seen += 1;
                    keep.push(item);
                }
            }
        }
    }
    (keep, evicted_images)
}

fn prune_index(app: &AppHandle, plugin_id: &str, idx: &mut ClipIndex) {
    let drained = std::mem::take(&mut idx.items);
    let (keep, to_delete) = prune_items(drained, MAX_TEXT_ITEMS, MAX_IMAGE_ITEMS);
    idx.items = keep;

    if let Ok(dir) = clipboard_dir(app, plugin_id) {
        for rel in to_delete {
            if let Some(name) = rel.rsplit_once('/').map(|(_, n)| n.to_string()) {
                let _ = std::fs::remove_file(dir.join(name));
            }
        }
    }
}

fn bump_seq_and_notify(app: &AppHandle) {
    let _ = app.emit(EVENT_CLIPBOARD_UPDATED, ());
}

// ===================== 原生监听（Windows） =====================

#[cfg(windows)]
mod platform {
    use super::*;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::DataExchange::{
        AddClipboardFormatListener, CloseClipboard, GetClipboardData, GetClipboardSequenceNumber,
        OpenClipboard, RemoveClipboardFormatListener,
    };
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, HWND_MESSAGE, WM_CLIPBOARDUPDATE, WNDCLASSW,
        RegisterClassW,
    };

    const CF_TEXT: u32 = 1;
    const CF_UNICODETEXT: u32 = 13;
    const CF_DIB: u32 = 8;
    const CF_HDROP: u32 = 15;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe extern "system" fn wndproc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if msg == WM_CLIPBOARDUPDATE {
            if ENABLED.load(Ordering::Relaxed) {
                dispatch_read();
            }
            return 0;
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    pub(super) fn dispatch_read() {
        let Some(app) = APP.get() else {
            return;
        };
        if plugin_host::clipboard_capture_plugin_ids().is_empty() {
            return;
        }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
            read_and_store(&app);
        });
    }

    fn read_and_store(app: &AppHandle) {
        if plugin_host::clipboard_capture_plugin_ids().is_empty() {
            return;
        }
        let seq = unsafe { GetClipboardSequenceNumber() };
        {
            let mut last_at = LAST_AT_MS.lock().unwrap_or_else(|p| p.into_inner());
            let now = now_ms();
            if seq != 0
                && seq == LAST_SEQ.load(Ordering::Relaxed)
                && now.saturating_sub(*last_at) < DEDUP_MS
            {
                return;
            }
            *last_at = now;
        }
        if seq != 0 {
            LAST_SEQ.store(seq, Ordering::Relaxed);
        }

        let mut opened = false;
        for _ in 0..8 {
            if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
                opened = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        if !opened {
            return;
        }

        let result = unsafe { read_locked(app) };
        unsafe { CloseClipboard() };
        if let Err(e) = result {
            eprintln!("读取剪贴板失败: {e}");
        }
    }

    unsafe fn read_locked(app: &AppHandle) -> Result<(), String> {
        if let Some(paths) = read_hdrop() {
            if !paths.is_empty() {
                push_files(app, paths);
                return Ok(());
            }
        }
        if let Some(text) = read_unicode_text() {
            if !text.trim().is_empty() {
                push_text(app, text);
                return Ok(());
            }
        }
        if let Some((w, h, rgba)) = read_dib()? {
            push_image(app, w, h, rgba);
            return Ok(());
        }
        Ok(())
    }

    /// 读取**当前**剪贴板位图（供贴图功能用；独立于监听入库链路）。
    pub(super) unsafe fn read_image_now() -> Result<Option<(u32, u32, Vec<u8>)>, String> {
        let mut opened = false;
        for _ in 0..8 {
            if OpenClipboard(std::ptr::null_mut()) != 0 {
                opened = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        if !opened {
            return Err("剪贴板被其它程序占用".to_string());
        }
        let result = read_dib();
        CloseClipboard();
        result
    }

    unsafe fn copy_format(format: u32) -> Option<Vec<u8>> {
        let handle = GetClipboardData(format);
        if handle.is_null() {
            return None;
        }
        let ptr = GlobalLock(handle as *mut core::ffi::c_void) as *const u8;
        if ptr.is_null() {
            return None;
        }
        let size = GlobalSize(handle as *mut core::ffi::c_void);
        let out = if size == 0 {
            None
        } else {
            Some(std::slice::from_raw_parts(ptr, size).to_vec())
        };
        GlobalUnlock(handle as *mut core::ffi::c_void);
        out
    }

    unsafe fn read_unicode_text() -> Option<String> {
        if let Some(bytes) = copy_format(CF_UNICODETEXT) {
            let u16s: Vec<u16> = bytes
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .take_while(|&c| c != 0)
                .collect();
            return Some(String::from_utf16_lossy(&u16s));
        }
        if let Some(bytes) = copy_format(CF_TEXT) {
            let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
            return Some(String::from_utf8_lossy(&bytes[..end]).to_string());
        }
        None
    }

    unsafe fn read_hdrop() -> Option<Vec<String>> {
        use windows_sys::Win32::UI::Shell::{DragQueryFileW, HDROP};
        let handle = GetClipboardData(CF_HDROP);
        if handle.is_null() {
            return None;
        }
        let hdrop = handle as HDROP;
        let count = DragQueryFileW(hdrop, 0xFFFFFFFF, std::ptr::null_mut(), 0);
        if count == 0 {
            return None;
        }
        let mut paths = Vec::with_capacity(count as usize);
        for i in 0..count {
            let len = DragQueryFileW(hdrop, i, std::ptr::null_mut(), 0);
            if len == 0 {
                continue;
            }
            let mut buf = vec![0u16; len as usize + 1];
            let got = DragQueryFileW(hdrop, i, buf.as_mut_ptr(), buf.len() as u32);
            if got == 0 {
                continue;
            }
            buf.truncate(got as usize);
            paths.push(String::from_utf16_lossy(&buf));
        }
        if paths.is_empty() {
            None
        } else {
            Some(paths)
        }
    }

    unsafe fn read_dib() -> Result<Option<(u32, u32, Vec<u8>)>, String> {
        let Some(bytes) = copy_format(CF_DIB) else {
            return Ok(None);
        };
        if bytes.len() < 40 {
            return Ok(None);
        }
        let u32_at = |o: usize| -> u32 {
            u32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]])
        };
        let i32_at = |o: usize| -> i32 {
            i32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]])
        };
        let u16_at = |o: usize| -> u16 { u16::from_le_bytes([bytes[o], bytes[o + 1]]) };

        let header_size = u32_at(0) as usize;
        let width = i32_at(4);
        let height_raw = i32_at(8);
        let bit_count = u16_at(14) as u32;
        let compression = u32_at(16);
        let clr_used = u32_at(32) as usize;

        if width <= 0 || height_raw == 0 {
            return Ok(None);
        }
        if compression != 0 && compression != 3 {
            return Ok(None);
        }
        let w = width as usize;
        let h = height_raw.unsigned_abs() as usize;
        let top_down = height_raw < 0;

        let palette_entries = if bit_count <= 8 {
            if clr_used > 0 {
                clr_used
            } else {
                1usize << bit_count
            }
        } else {
            0
        };
        let palette_off = header_size;
        let palette_bytes = palette_entries * 4;
        let extra_masks = if compression == 3 && header_size == 40 { 12 } else { 0 };
        let pixel_off = palette_off + palette_bytes + extra_masks;
        if bytes.len() <= pixel_off {
            return Ok(None);
        }
        let pixels = &bytes[pixel_off..];
        let stride = ((w * bit_count as usize + 31) / 32) * 4;
        if pixels.len() < stride * h {
            return Ok(None);
        }

        let mut rgba = vec![0u8; w * h * 4];
        for y in 0..h {
            let src_y = if top_down { y } else { h - 1 - y };
            let row = &pixels[src_y * stride..src_y * stride + stride];
            let dst = &mut rgba[y * w * 4..(y + 1) * w * 4];
            match bit_count {
                32 => {
                    for x in 0..w {
                        let p = &row[x * 4..x * 4 + 4];
                        let (b, g, r, a) = (p[0], p[1], p[2], p[3]);
                        let a = if a == 0 { 255 } else { a };
                        dst[x * 4] = r;
                        dst[x * 4 + 1] = g;
                        dst[x * 4 + 2] = b;
                        dst[x * 4 + 3] = a;
                    }
                }
                24 => {
                    for x in 0..w {
                        let p = &row[x * 3..x * 3 + 3];
                        dst[x * 4] = p[2];
                        dst[x * 4 + 1] = p[1];
                        dst[x * 4 + 2] = p[0];
                        dst[x * 4 + 3] = 255;
                    }
                }
                16 => {
                    for x in 0..w {
                        let v = u16::from_le_bytes([row[x * 2], row[x * 2 + 1]]);
                        let r = ((v >> 10) & 0x1f) as u8;
                        let g = ((v >> 5) & 0x1f) as u8;
                        let b = (v & 0x1f) as u8;
                        dst[x * 4] = (r << 3) | (r >> 2);
                        dst[x * 4 + 1] = (g << 3) | (g >> 2);
                        dst[x * 4 + 2] = (b << 3) | (b >> 2);
                        dst[x * 4 + 3] = 255;
                    }
                }
                8 => {
                    let pal = &bytes[palette_off..palette_off + palette_bytes];
                    for x in 0..w {
                        let i = row[x] as usize;
                        let p = &pal[i * 4..i * 4 + 4];
                        dst[x * 4] = p[2];
                        dst[x * 4 + 1] = p[1];
                        dst[x * 4 + 2] = p[0];
                        dst[x * 4 + 3] = 255;
                    }
                }
                _ => return Ok(None),
            }
        }
        Ok(Some((w as u32, h as u32, rgba)))
    }

    pub(super) fn install_impl(app: AppHandle) -> bool {
        if WATCHER_HWND.load(Ordering::Acquire) != 0 {
            return true;
        }
        let _ = APP.set(app);
        unsafe {
            let class_name = wide("MySearchClipboardWatcher");
            let hinstance = std::ptr::null_mut();
            let mut wc: WNDCLASSW = std::mem::zeroed();
            wc.lpfnWndProc = Some(wndproc);
            wc.hInstance = hinstance;
            wc.lpszClassName = class_name.as_ptr();
            let atom = RegisterClassW(&wc);
            if atom == 0 {
                let err = std::io::Error::last_os_error();
                if err.raw_os_error() != Some(1410) {
                    eprintln!("注册剪贴板监听窗口类失败: {err}");
                    return false;
                }
            }
            let hwnd = CreateWindowExW(
                0,
                class_name.as_ptr(),
                class_name.as_ptr(),
                0,
                0,
                0,
                0,
                0,
                HWND_MESSAGE,
                std::ptr::null_mut(),
                hinstance,
                std::ptr::null_mut(),
            );
            if hwnd.is_null() {
                eprintln!(
                    "创建剪贴板监听窗口失败: {}",
                    std::io::Error::last_os_error()
                );
                return false;
            }
            if AddClipboardFormatListener(hwnd) == 0 {
                eprintln!(
                    "挂载剪贴板监听失败: {}",
                    std::io::Error::last_os_error()
                );
                DestroyWindow(hwnd);
                return false;
            }
            WATCHER_HWND.store(hwnd as isize, Ordering::Release);
            true
        }
    }

    pub(super) fn uninstall_impl() {
        let raw = WATCHER_HWND.swap(0, Ordering::AcqRel);
        if raw == 0 {
            return;
        }
        let hwnd = raw as HWND;
        unsafe {
            RemoveClipboardFormatListener(hwnd);
            DestroyWindow(hwnd);
        }
        eprintln!("[剪贴板] 已卸载系统剪贴板监听（无启用中的捕获插件）");
    }
}

// ===================== 生命周期调和与实时位图原语 =====================

/// 按当前是否存在「启用且订阅 `clipboard_capture` 并获授 `clipboard.read`」的插件按需启停监听（幂等）。
#[cfg(windows)]
pub fn sync_active(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let should_run = !plugin_host::clipboard_capture_plugin_ids().is_empty();
    ENABLED.store(should_run, Ordering::Release);
    if should_run {
        if WATCHER_HWND.load(Ordering::Acquire) == 0 {
            let main_app = app.clone();
            let _ = app.run_on_main_thread(move || {
                if !plugin_host::clipboard_capture_plugin_ids().is_empty()
                    && platform::install_impl(main_app)
                {
                    eprintln!("[剪贴板] 剪贴板捕获监听已按需激活");
                }
            });
        }
    } else if WATCHER_HWND.load(Ordering::Acquire) != 0 {
        let _ = app.run_on_main_thread(|| {
            platform::uninstall_impl();
        });
    }
}

#[cfg(not(windows))]
pub fn sync_active(_app: &AppHandle) {}

#[cfg(windows)]
pub fn uninstall() {
    ENABLED.store(false, Ordering::Release);
    platform::uninstall_impl();
}

#[cfg(not(windows))]
pub fn uninstall() {}

/// 读取**当前**系统剪贴板位图（供贴图原语使用；独立于历史入库链路）。
#[cfg(windows)]
pub fn current_clipboard_image() -> Result<Option<(u32, u32, Vec<u8>)>, String> {
    unsafe { platform::read_image_now() }
}

#[cfg(not(windows))]
pub fn current_clipboard_image() -> Result<Option<(u32, u32, Vec<u8>)>, String> {
    Ok(None)
}

// ===================== 插件侧纯捕获原语命令（双重网关校验） =====================

/// 列出调用方插件捕获到的原始剪贴板记录（从新到旧；可选 `query` 文本粗筛）。
#[tauri::command]
pub fn clipboard_history_list(
    app: tauri::AppHandle,
    plugin_id: String,
    query: Option<String>,
) -> Result<Vec<ClipItem>, String> {
    plugin_host::require_grant(&plugin_id, "clipboard.read")?;
    let idx = load_index(&app, &plugin_id);
    let q = query.unwrap_or_default().trim().to_lowercase();
    if q.is_empty() {
        return Ok(idx.items);
    }
    Ok(idx
        .items
        .into_iter()
        .filter(|it| match &it.text {
            Some(t) => t.to_lowercase().contains(&q),
            None => it
                .source
                .as_deref()
                .map(|s| s.to_lowercase().contains(&q))
                .unwrap_or(false),
        })
        .collect())
}

/// 读回一张剪贴板图片 → data URL（按文件魔数识别 MIME）。
#[tauri::command]
pub fn clipboard_history_read_image(
    app: tauri::AppHandle,
    plugin_id: String,
    rel_path: String,
) -> Result<String, String> {
    plugin_host::require_grant(&plugin_id, "clipboard.read")?;
    let path = safe_image_path(&app, &plugin_id, &rel_path)?;
    let md = std::fs::metadata(&path).map_err(|e| format!("图片不存在: {e}"))?;
    if !md.is_file() {
        return Err("图片路径不是文件".to_string());
    }
    if md.len() > MAX_IMAGE_BYTES as u64 {
        return Err("图片过大，拒绝读取".to_string());
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("读取图片失败: {e}"))?;
    let mime = image_mime_of(&bytes);
    let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

fn image_mime_of(bytes: &[u8]) -> &'static str {
    match bytes {
        b if b.starts_with(b"\x89PNG\r\n\x1a\n") => "image/png",
        b if b.len() >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF => "image/jpeg",
        b if b.len() >= 6 && &b[0..3] == b"GIF" && (&b[3..6] == b"87a" || &b[3..6] == b"89a") => {
            "image/gif"
        }
        b if b.len() >= 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" => "image/webp",
        b if b.len() >= 2 && b[0] == 0x42 && b[1] == 0x4D => "image/bmp",
        _ => "image/png",
    }
}

/// 删除一条原始捕获记录（图片同步清理磁盘文件）。
#[tauri::command]
pub fn clipboard_history_delete(
    app: tauri::AppHandle,
    plugin_id: String,
    id: String,
) -> Result<(), String> {
    plugin_host::require_grant(&plugin_id, "clipboard.read")?;
    let mut idx = load_index(&app, &plugin_id);
    let mut removed_rel: Option<String> = None;
    idx.items.retain(|it| {
        if it.id == id {
            removed_rel = it.rel_path.clone();
            false
        } else {
            true
        }
    });
    if let Some(rel) = removed_rel {
        if let Some(name) = rel.rsplit_once('/').map(|(_, n)| n.to_string()) {
            if let Ok(dir) = clipboard_dir(&app, &plugin_id) {
                let _ = std::fs::remove_file(dir.join(name));
            }
        }
    }
    save_index(&app, &plugin_id, &idx)?;
    let _ = app.emit(EVENT_CLIPBOARD_UPDATED, ());
    Ok(())
}

/// 清空捕获缓冲，仅保留调用方显式指定（或已标 `retained`）的条目集合。
///
/// 宿主不知道什么是「收藏」或「分类」：
/// - `keep_retained == Some(false)` 且未传 `retain_ids` → 彻底清空全部记录；
/// - 传了 `retain_ids` → 仅保留集合内的条目；
/// - 缺省 → 保留当前 `item.retained == true` 的条目。
#[tauri::command]
pub fn clipboard_history_clear(
    app: tauri::AppHandle,
    plugin_id: String,
    keep_retained: Option<bool>,
    retain_ids: Option<Vec<String>>,
) -> Result<(), String> {
    plugin_host::require_grant(&plugin_id, "clipboard.read")?;
    let mut idx = load_index(&app, &plugin_id);
    let explicit_set: Option<HashSet<String>> = retain_ids.map(|v| v.into_iter().collect());
    let keep_flag = keep_retained.unwrap_or(true);

    let mut to_delete: Vec<String> = Vec::new();
    idx.items.retain(|it| {
        let keep = if !keep_flag && explicit_set.is_none() {
            false
        } else {
            match &explicit_set {
                Some(set) => set.contains(&it.id),
                None => it.retained,
            }
        };
        if !keep {
            if let Some(rel) = it.rel_path.clone() {
                to_delete.push(rel);
            }
        }
        keep
    });
    save_index(&app, &plugin_id, &idx)?;
    if let Ok(dir) = clipboard_dir(&app, &plugin_id) {
        for rel in to_delete {
            if let Some(name) = rel.rsplit_once('/').map(|(_, n)| n.to_string()) {
                let _ = std::fs::remove_file(dir.join(name));
            }
        }
    }
    let _ = app.emit(EVENT_CLIPBOARD_UPDATED, ());
    Ok(())
}

/// 同步该插件需要豁免环形缓冲淘汰的条目 ID 集合（保护引用的 `.png` 文件不被 GC）。
#[tauri::command]
pub fn clipboard_history_set_retained(
    app: tauri::AppHandle,
    plugin_id: String,
    ids: Vec<String>,
) -> Result<(), String> {
    plugin_host::require_grant(&plugin_id, "clipboard.read")?;
    let keep: HashSet<String> = ids.into_iter().collect();
    let mut idx = load_index(&app, &plugin_id);
    let mut changed = false;
    for it in &mut idx.items {
        let next = keep.contains(&it.id);
        if it.retained != next {
            it.retained = next;
            changed = true;
        }
    }
    if changed {
        save_index(&app, &plugin_id, &idx)?;
    }
    Ok(())
}

/// 把某条捕获记录（或插件编辑后的覆盖文本）写回系统剪贴板。
#[tauri::command]
pub fn clipboard_history_copy(
    app: tauri::AppHandle,
    plugin_id: String,
    id: String,
    text_override: Option<String>,
) -> Result<(), String> {
    plugin_host::require_grant(&plugin_id, "clipboard.write")?;
    if let Some(custom_text) = text_override {
        return crate::screenshot::write_text_to_clipboard(&custom_text);
    }
    let idx = load_index(&app, &plugin_id);
    let item = idx
        .items
        .iter()
        .find(|it| it.id == id)
        .ok_or_else(|| "该历史已不存在".to_string())?;
    match item.kind.as_str() {
        "image" => {
            let rel = item.rel_path.clone().ok_or_else(|| "图片路径缺失".to_string())?;
            let path = safe_image_path(&app, &plugin_id, &rel)?;
            let bytes = std::fs::read(&path).map_err(|e| format!("读取图片失败: {e}"))?;
            let (w, h, rgba) = crate::screenshot::decode_png(&bytes)?;
            crate::screenshot::write_png_to_clipboard(w, h, &rgba)
        }
        _ => {
            let text = item.text.clone().unwrap_or_default();
            crate::screenshot::write_text_to_clipboard(&text)
        }
    }
}

// ===================== 单测 =====================

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_item(id: usize, kind: &str, retained: bool) -> ClipItem {
        ClipItem {
            id: format!("t-{id}"),
            kind: kind.into(),
            text: if kind == "text" { Some(format!("v{id}")) } else { None },
            rel_path: if kind == "image" {
                Some(format!("clipboard/{id}.png"))
            } else {
                None
            },
            width: None,
            height: None,
            size: 1,
            created_at: (1000 - id) as u64,
            source: None,
            retained,
            legacy_favorite: false,
            legacy_category: None,
        }
    }

    #[test]
    fn image_name_is_flat_and_safe() {
        let name = new_image_name(1700000000000, 7);
        assert_eq!(name, "1700000000000-7.png");
        assert!(!name.contains('/'));
        assert!(!name.contains('\\'));
        assert!(!name.contains(".."));
    }

    #[test]
    fn retained_items_survive_prune_and_do_not_consume_quota() {
        let items = vec![
            mk_item(0, "image", true),
            mk_item(1, "image", false),
            mk_item(2, "image", false),
            mk_item(3, "image", true),
            mk_item(4, "image", false),
        ];
        let (kept, evicted) = prune_items(items, 10, 2);
        let ids: Vec<&str> = kept.iter().map(|it| it.id.as_str()).collect();
        assert_eq!(ids, vec!["t-0", "t-1", "t-2", "t-3"]);
        assert_eq!(evicted, vec!["clipboard/4.png"]);
    }

    #[test]
    fn legacy_favorite_and_category_migrate_into_retained_and_annotation_map() {
        let legacy_json = r#"{
            "items": [
                {"id":"t-1","kind":"text","text":"fav","size":3,"createdAt":10,"favorite":true},
                {"id":"i-2","kind":"image","relPath":"clipboard/2.png","size":9,"createdAt":9,"category":"工作"},
                {"id":"t-3","kind":"text","text":"plain","size":5,"createdAt":8}
            ]
        }"#;
        let mut idx: ClipIndex = serde_json::from_str(legacy_json).expect("旧索引应可解析");
        let migrated = upgrade_legacy_items(&mut idx.items);

        assert!(idx.items[0].retained);
        assert!(idx.items[1].retained);
        assert!(!idx.items[2].retained);

        assert_eq!(
            migrated.get("t-1"),
            Some(&LegacyAnnotation {
                favorite: true,
                category: None
            })
        );
        assert_eq!(
            migrated.get("i-2"),
            Some(&LegacyAnnotation {
                favorite: false,
                category: Some("工作".into())
            })
        );
        assert!(!migrated.contains_key("t-3"));

        // 升级后序列化不再含 favorite / category 业务字段
        let serialized = serde_json::to_string(&idx).unwrap();
        assert!(!serialized.contains("favorite"));
        assert!(!serialized.contains("category"));
        assert!(serialized.contains("\"retained\":true"));
    }

    #[test]
    fn normalize_captured_text_trims_trailing_crlf_and_truncates_by_chars() {
        assert!(normalize_captured_text("").is_none());
        assert!(normalize_captured_text("  \r\n\t ").is_none());
        assert_eq!(
            normalize_captured_text("第一行\r\n第二行\r\n").as_deref(),
            Some("第一行\r\n第二行")
        );
        let long = "中".repeat(MAX_TEXT_CHARS + 12);
        let out = normalize_captured_text(&long).unwrap();
        assert_eq!(out.chars().count(), MAX_TEXT_CHARS);
    }

    #[test]
    fn image_mime_magic_detection() {
        assert_eq!(image_mime_of(b"\x89PNG\r\n\x1a\nxxxx"), "image/png");
        assert_eq!(image_mime_of(b"\xFF\xD8\xFF\xE0"), "image/jpeg");
        assert_eq!(image_mime_of(b"GIF89a..."), "image/gif");
        assert_eq!(image_mime_of(b"RIFF\x00\x00\x00\x00WEBP"), "image/webp");
    }
}
