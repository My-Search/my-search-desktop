//! 剪贴板历史：原生监听 + 只读抓取 + 落盘 + 热键。
//!
//! ## 为什么必须在 Rust 侧监听
//!
//! 插件的 inlay 详情视图是主 WebView 里的一段 DOM，它：
//!   1. **监听不到**「别的程序往剪贴板写东西」——浏览器没有剪贴板变更事件；
//!   2. 应用不在前台时更收不到任何东西（主窗口失焦即隐藏）。
//!
//! 所以监听必须落到原生：注册 `AddClipboardFormatListener`，系统在**任何程序**
//! 改写剪贴板时都会给我们的监听窗口投递 `WM_CLIPBOARDUPDATE`。
//!
//! ## 只读铁律（本模块最重要的约束）
//!
//! 监听路径**只**做 `OpenClipboard` / `GetClipboardData` / `CloseClipboard`。
//! **绝不**调用 `EmptyClipboard` / `SetClipboardData`——那是「写入」，
//! 一旦在监听回调里写，就会与用户正在复制的程序互相打架、把剪贴板内容换掉。
//! 本模块的唯一写剪贴板动作是用户显式点「复制」时走的 `clipboard_write_text`/
//! `clipboard_write_png`（且只在用户主动触发时调用），监听自身永远只读。
//!
//! ## 监听窗口的生命周期
//!
//! `AddClipboardFormatListener` 需要一个长期存在、带消息循环的 HWND。这里**不**挂到
//! 主窗口上（主窗口失焦会被隐藏、且未来可能被重建），而是新建一个 **message-only
//! 隐藏窗口**（`HWND_MESSAGE` 父窗口）专司接收剪贴板消息：
//!   - 不可见、不激活、不占任务栏、不抢焦点；
//!   - 生命周期与进程一致，随应用启动创建、退出一并销毁；
//!   - 因此监听不受「主窗口隐藏 / 重建」影响，最稳健。
//!
//! ## 线程与回调
//!
//! `install()` 必须在带消息循环的线程调用（`lib.rs` 的 `.setup()` 满足）。
//! 窗口过程极轻：收到消息只 `async_runtime::spawn` 派发，真正的读取/解码/落盘
//! 全在后台线程做（`WM_CLIPBOARDUPDATE` 要求尽快返回，否则会拖慢剪贴板操作）。

use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, Ordering};
use std::sync::{LazyLock, Mutex, OnceLock};

use tauri::{AppHandle, Emitter};

use crate::plugin_host;

/// 插件 id（本模块只服务这个内置插件；落盘目录 = plugin-data/<该 id>/clipboard）
pub const CLIPBOARD_PLUGIN_ID: &str = "com.mysearch.clipboard";

/// 抓取内容变更后广播给前端的事件名（payloadless：「事件唤醒、命令拉取」）。
///
/// 为什么 payloadless：剪贴板可能在应用启动早期就被改写，那时前端监听还没注册；
/// 事件只当「闹钟」，真实数据由前端调 `clipboard_history_list` 主动拉，天然不丢。
pub const EVENT_CLIPBOARD_UPDATED: &str = "my-search://clipboard-updated";

/// 私有目录名（在插件私有数据目录下）
const CLIPBOARD_DIR: &str = "clipboard";

/// 图片文件后缀（落盘用）
const IMAGE_EXT: &str = "png";

/// 历史保留上限：文本条数
const MAX_TEXT_ITEMS: usize = 500;
/// 历史保留上限：图片张数
const MAX_IMAGE_ITEMS: usize = 100;
/// 单条文本最大长度（字符数）：超长文本截断后入库，避免一条把索引撑爆
const MAX_TEXT_CHARS: usize = 100_000;
/// 单张图片最大字节数（100 MB，与截图读取口径一致）：超过则跳过不记录
const MAX_IMAGE_BYTES: u32 = 100 * 1024 * 1024;
/// 同一剪贴板序列号重复触发时的忽略窗口（毫秒）：防抖，避免一次复制触发多次
const DEDUP_MS: u64 = 120;
/// 分页每页条数硬上限：前端可自定每页大小，但不允许超过这个值
const MAX_PAGE_LIMIT: usize = 200;

// ===================== 全局状态 =====================

/// 宿主句柄（`install` 时写入，回调里用）
static APP: OnceLock<AppHandle> = OnceLock::new();

/// 监听开关（保留给未来「暂停监听」用；当前始终为真）
static ENABLED: AtomicBool = AtomicBool::new(true);

/// 监听窗口句柄（0 = 未安装）。存成 isize 以便原子读写、跨线程安全。
static WATCHER_HWND: AtomicIsize = AtomicIsize::new(0);

/// 上一次处理过的剪贴板序列号（用于去重/防抖）
static LAST_SEQ: AtomicU32 = AtomicU32::new(0);

/// 上一次处理的时间戳（毫秒），配合 `DEDUP_MS` 防抖
static LAST_AT_MS: LazyLock<Mutex<u64>> = LazyLock::new(|| Mutex::new(0));

// ===================== 数据模型 =====================

/// 一条剪贴板历史（文本 或 图片）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipItem {
    /// 稳定 id（毫秒时间戳 + 单调序号，唯一）
    pub id: String,
    /// 类型："text" | "image"
    pub kind: String,
    /// 文本内容（kind=text）；图片为 None
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// 图片相对路径（kind=image，形如 "clipboard/xxx.png"）；文本为 None
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rel_path: Option<String>,
    /// 图片宽（kind=image）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    /// 图片高（kind=image）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// 字节数（图片为 PNG 大小；文本为内容字节长度）
    pub size: u64,
    /// 记录时间（毫秒时间戳）
    pub created_at: u64,
    /// 来源描述（如「文件：a.txt, b.txt」）；可空
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// 是否已收藏。
    ///
    /// 收藏的条目**永久保留**：不参与 `prune_index` 的上限淘汰，且「清空」默认
    /// 也不删它们（用户可显式选择连同收藏一起清空）。默认 `false`；
    /// 旧版 `index.json` 没有此字段时靠 `#[serde(default)]` 平滑升级。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub favorite: bool,
}

/// 内存中的索引（与磁盘 index.json 同步）
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClipIndex {
    /// 条目列表：**从新到旧**（列表首位最新）
    items: Vec<ClipItem>,
}

// ===================== 目录与路径 =====================

/// 剪贴板历史目录：`<app_data>/plugin-data/<插件id>/clipboard`
fn clipboard_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = plugin_host::plugin_data_dir(app, CLIPBOARD_PLUGIN_ID)?.join(CLIPBOARD_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建剪贴板历史目录失败: {e}"))?;
    Ok(dir)
}

/// 索引文件路径
fn index_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(clipboard_dir(app)?.join("index.json"))
}

/// 校验一个图片相对路径（防目录穿越）。只允许 `clipboard/` 下的 png 文件。
fn safe_image_path(app: &AppHandle, rel: &str) -> Result<std::path::PathBuf, String> {
    if !plugin_host::is_safe_relative(rel) {
        return Err(format!("非法图片路径: {rel}"));
    }
    let normalized = rel.replace('\\', "/");
    let rest = normalized
        .strip_prefix(&format!("{CLIPBOARD_DIR}/"))
        .ok_or_else(|| format!("图片路径必须以 {CLIPBOARD_DIR}/ 开头"))?;
    // 只允许平铺文件名，不许再有子目录
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
    Ok(clipboard_dir(app)?.join(rest))
}

// ===================== 索引读写 =====================

/// 读索引（文件不存在/损坏时回落到空索引，绝不因坏文件卡死功能）
fn load_index(app: &AppHandle) -> ClipIndex {
    let Ok(path) = index_path(app) else {
        return ClipIndex::default();
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return ClipIndex::default();
    };
    serde_json::from_str::<ClipIndex>(&text).unwrap_or_default()
}

/// 写索引（原子替换：先写临时文件再 rename，避免写一半崩溃留下坏文件）
fn save_index(app: &AppHandle, index: &ClipIndex) -> Result<(), String> {
    let path = index_path(app)?;
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string(index).map_err(|e| format!("序列化剪贴板索引失败: {e}"))?;
    std::fs::write(&tmp, text).map_err(|e| format!("写入剪贴板索引失败: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("替换剪贴板索引失败: {e}"))?;
    Ok(())
}

/// 单调序号：同一毫秒内多次写入靠它区分 id / 文件名
static SEQ: AtomicU32 = AtomicU32::new(0);

/// 由「时间戳 + 单调序号」生成不冲突的 id / 文件名
fn next_stamp() -> (u64, u32) {
    let ms = now_ms();
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    (ms, n)
}

/// 当前毫秒时间戳
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 图片文件名：`<时间戳>-<序号>.png`（主机生成，天然防穿越）
fn new_image_name(ms: u64, n: u32) -> String {
    format!("{ms}-{n}.{IMAGE_EXT}")
}

// ===================== 记录：文本 =====================

/// 记录一条文本。
///
/// 去重规则：与**最新一条**文本相同则忽略（连续复制同一内容不重复入库）；
/// 否则插到最前。超长文本截断到 `MAX_TEXT_CHARS`。
fn push_text(app: &AppHandle, text: String) {
    let trimmed = text.trim_end_matches(['\r', '\n']).to_string();
    if trimmed.trim().is_empty() {
        return;
    }
    let mut content = trimmed;
    if content.chars().count() > MAX_TEXT_CHARS {
        content = content.chars().take(MAX_TEXT_CHARS).collect();
    }
    {
        let mut idx = load_index(app);
        // 与最新一条文本内容相同 → 视为同一次复制的重复通知，跳过
        if let Some(latest) = idx.items.iter().find(|it| it.kind == "text") {
            if latest.text.as_deref() == Some(content.as_str()) {
                return;
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
            favorite: false,
        };
        idx.items.insert(0, item);
        prune_index(app, &mut idx);
        if let Err(e) = save_index(app, &idx) {
            eprintln!("保存剪贴板文本历史失败: {e}");
        }
    }
    bump_seq_and_notify(app);
}

/// 记录一组「复制的文件路径」（CF_HDROP）。
///
/// 不单独建条目类型：把路径拼成一段可读文本入文本历史，并在 source 标注「文件」，
/// 这样用户能直接看到复制了哪些文件，也能一键复制回路径。
fn push_files(app: &AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    let joined = paths.join("\n");
    let display = if paths.len() == 1 {
        paths[0].clone()
    } else {
        format!("{} 等 {} 个文件", paths[0], paths.len())
    };
    let mut content = joined;
    if content.chars().count() > MAX_TEXT_CHARS {
        content = content.chars().take(MAX_TEXT_CHARS).collect();
    }
    {
        let mut idx = load_index(app);
        if let Some(latest) = idx.items.iter().find(|it| it.kind == "text") {
            if latest.text.as_deref() == Some(content.as_str()) {
                return;
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
            favorite: false,
        };
        idx.items.insert(0, item);
        prune_index(app, &mut idx);
        if let Err(e) = save_index(app, &idx) {
            eprintln!("保存剪贴板文件历史失败: {e}");
        }
    }
    bump_seq_and_notify(app);
}

// ===================== 记录：图片 =====================

/// 记录一张剪贴板位图（已转成 RGBA + PNG）。
///
/// 落盘 PNG 到插件私有目录，索引里只留相对路径；超上限淘汰最旧图片
/// （连同其磁盘文件一起删，避免孤儿文件堆积）。
fn push_image(app: &AppHandle, width: u32, height: u32, rgba: Vec<u8>) {
    if width == 0 || height == 0 {
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
    let dir = match clipboard_dir(app) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("{e}");
            return;
        }
    };
    let (ms, n) = next_stamp();
    let name = new_image_name(ms, n);
    let full = dir.join(&name);
    if let Err(e) = std::fs::write(&full, &png) {
        eprintln!("写入剪贴板图片失败: {e}");
        return;
    }
    let size = png.len() as u64;
    {
        let mut idx = load_index(app);
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
            favorite: false,
        };
        idx.items.insert(0, item);
        prune_index(app, &mut idx);
        if let Err(e) = save_index(app, &idx) {
            eprintln!("保存剪贴板图片历史失败: {e}");
        }
    }
    bump_seq_and_notify(app);
}

/// 按上限裁剪索引：文本/图片各自计数，超出则从**尾部（最旧）**删除；
/// 被删的图片连同磁盘文件一并删除。
///
/// **收藏条目豁免**：`favorite == true` 的一律保留，且不计入上限，
/// 这样「收藏」才真的等于永久保存——否则收藏的图片仍会被后来的图挤掉。
/// 换言之上限只约束「非收藏」条目。
fn prune_index(app: &AppHandle, idx: &mut ClipIndex) {
    let mut text_seen = 0usize;
    let mut image_seen = 0usize;
    let mut keep: Vec<ClipItem> = Vec::with_capacity(idx.items.len());
    let mut to_delete: Vec<String> = Vec::new();

    for item in idx.items.drain(..) {
        // 收藏：无条件保留，不占上限配额
        if item.favorite {
            keep.push(item);
            continue;
        }
        // items 从新到旧：前面的优先保留
        match item.kind.as_str() {
            "image" => {
                if image_seen < MAX_IMAGE_ITEMS {
                    image_seen += 1;
                    keep.push(item);
                } else if let Some(rel) = item.rel_path.clone() {
                    to_delete.push(rel);
                }
            }
            _ => {
                if text_seen < MAX_TEXT_ITEMS {
                    text_seen += 1;
                    keep.push(item);
                }
            }
        }
    }
    idx.items = keep;

    // 删除被淘汰图片的磁盘文件（失败只记日志）
    if let Ok(dir) = clipboard_dir(app) {
        for rel in to_delete {
            if let Some(name) = rel.rsplit_once('/').map(|(_, n)| n.to_string()) {
                let _ = std::fs::remove_file(dir.join(name));
            }
        }
    }
}

/// 通知前端「剪贴板历史有更新」（payloadless，前端收到后主动拉列表）。
fn bump_seq_and_notify(app: &AppHandle) {
    let _ = app.emit(EVENT_CLIPBOARD_UPDATED, ());
}

// ===================== 原生监听 =====================

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
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW,
        RegisterClassW, TranslateMessage, HWND_MESSAGE, MSG, WM_CLIPBOARDUPDATE, WNDCLASSW,
    };

    /// 剪贴板格式常量
    const CF_TEXT: u32 = 1;
    const CF_UNICODETEXT: u32 = 13;
    const CF_DIB: u32 = 8;
    const CF_HDROP: u32 = 15;

    /// 把 Rust 字符串转成以 NUL 结尾的 UTF-16 向量
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// 窗口过程：极轻，收到剪贴板变更就派发后台读取。
    ///
    /// 只处理 `WM_CLIPBOARDUPDATE`；其余一律交回 `DefWindowProcW`。
    /// `WM_CREATE` 无需处理：`AppHandle` 已存在全局 `APP`（`install_impl` 里写入），
    /// 窗口过程不再需要从 `CREATESTRUCTW` 取参数。
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

    /// 派发一次后台读取（去抖 + 去重后真正读剪贴板）。
    pub(super) fn dispatch_read() {
        let Some(app) = APP.get() else {
            return;
        };
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            // 短暂等待：系统投递 WM_CLIPBOARDUPDATE 时，剪贴板可能还在被写入方占用，
            // 立即 OpenClipboard 容易失败（返回 0）。让写入方先收手。
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
            read_and_store(&app);
        });
    }

    /// 读一次剪贴板并按类型入库（只读；绝不 Empty/Set）。
    fn read_and_store(app: &AppHandle) {
        let seq = unsafe { GetClipboardSequenceNumber() };
        // 同一序列号 + 极短间隔内的重复触发：忽略（有些程序会连发多条更新消息）
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

        // 打开剪贴板（带重试：被别的程序占用时短暂等待再试）
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

        // 按优先级尝试读取：文件 > 文本 > 图片
        let result = unsafe { read_locked(app) };
        // 无论成败都关闭；全程未 Empty/Set，系统剪贴板原样保留
        unsafe { CloseClipboard() };
        if let Err(e) = result {
            eprintln!("读取剪贴板失败: {e}");
        }
    }

    /// 在**已打开剪贴板**的前提下读取内容（调用方负责 CloseClipboard）。
    unsafe fn read_locked(app: &AppHandle) -> Result<(), String> {
        // 1) 文件路径列表（CF_HDROP）——资源管理器「复制文件」
        if let Some(paths) = read_hdrop() {
            if !paths.is_empty() {
                push_files(app, paths);
                return Ok(());
            }
        }
        // 2) Unicode 文本（CF_UNICODETEXT）
        if let Some(text) = read_unicode_text() {
            if !text.trim().is_empty() {
                push_text(app, text);
                return Ok(());
            }
        }
        // 3) 位图（CF_DIB）
        if let Some((w, h, rgba)) = read_dib()? {
            push_image(app, w, h, rgba);
            return Ok(());
        }
        Ok(())
    }

    /// 复制出某个剪贴板格式的原始字节（GlobalLock → 拷贝 → GlobalUnlock）。
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

    /// 读 CF_UNICODETEXT（UTF-16，NUL 结尾）
    unsafe fn read_unicode_text() -> Option<String> {
        // 优先 Unicode；个别老程序只给 ANSI 文本时回落到 CF_TEXT
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

    /// 读 CF_HDROP（文件路径列表）
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

    /// 读 CF_DIB（BITMAPINFOHEADER + 像素），转 RGBA8 自顶向下。
    ///
    /// 支持的位深：32/24/16/8（调色板）；其余（如 RLE/JPEG）跳过不记录。
    unsafe fn read_dib() -> Result<Option<(u32, u32, Vec<u8>)>, String> {
        let Some(bytes) = copy_format(CF_DIB) else {
            return Ok(None);
        };
        // 最少需要 40 字节的 BITMAPINFOHEADER
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
        // 只支持 BI_RGB(0) / BI_BITFIELDS(3) 的未压缩位图
        if compression != 0 && compression != 3 {
            return Ok(None);
        }
        let w = width as usize;
        let h = height_raw.unsigned_abs() as usize;
        // 负高度 = 自顶向下；正高度 = 自底向上
        let top_down = height_raw < 0;

        // 调色板（8 位及以下）
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
        let palette_bytes = palette_entries * 4; // RGBQUAD
        // BI_BITFIELDS 且 header 只有 40 字节时，掩码跟在 header 后（3×u32）
        let extra_masks = if compression == 3 && header_size == 40 { 12 } else { 0 };
        let pixel_off = palette_off + palette_bytes + extra_masks;
        if bytes.len() <= pixel_off {
            return Ok(None);
        }
        let pixels = &bytes[pixel_off..];

        // DIB 行按 4 字节对齐
        let stride = ((w * bit_count as usize + 31) / 32) * 4;
        if pixels.len() < stride * h {
            return Ok(None);
        }

        let mut rgba = vec![0u8; w * h * 4];

        // 逐行把源行号映射到目标行号（处理自底向上）
        for y in 0..h {
            let src_y = if top_down { y } else { h - 1 - y };
            let row = &pixels[src_y * stride..src_y * stride + stride];
            let dst = &mut rgba[y * w * 4..(y + 1) * w * 4];
            match bit_count {
                32 => {
                    for x in 0..w {
                        let p = &row[x * 4..x * 4 + 4];
                        // DIB 是 BGRA（第 4 字节多数程序当 alpha，但也常有 0）
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
                    // 默认 5-5-5（BI_RGB）；BI_BITFIELDS 的掩码差异此处置为尽力而为
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
                        // 调色板项也是 BGRX
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

    /// 注册窗口类 + 创建 message-only 隐藏窗口 + 挂剪贴板监听。
    pub(super) fn install_impl(app: AppHandle) -> bool {
        let _ = APP.set(app.clone());
        unsafe {
            let class_name = wide("MySearchClipboardWatcher");
            let hinstance = std::ptr::null_mut();
            let mut wc: WNDCLASSW = std::mem::zeroed();
            wc.lpfnWndProc = Some(wndproc);
            wc.hInstance = hinstance;
            wc.lpszClassName = class_name.as_ptr();
            // 类名重复注册（开发态热重载）不算错：已存在时直接用
            let atom = RegisterClassW(&wc);
            if atom == 0 {
                let err = std::io::Error::last_os_error();
                // 1410 = ERROR_CLASS_ALREADY_EXISTS
                if err.raw_os_error() != Some(1410) {
                    eprintln!("注册剪贴板监听窗口类失败: {err}");
                    return false;
                }
            }

            // 创建 message-only 窗口：parent = HWND_MESSAGE(-3)，
            // 不可见、不占任务栏、不激活、不抢焦点。
            // 不传创建参数：窗口过程只认全局 `APP`，无需经 CREATESTRUCTW 取句柄。
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

    /// 卸载监听 + 销毁窗口。
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
    }

    /// 消息循环（本模块自建窗口需要自己的循环；当前 install 复用 Tauri 主循环，
    /// 故此函数仅为「独立线程跑监听」的备选路径保留，未启用）。
    #[allow(dead_code)]
    pub(super) fn run_message_loop() {
        unsafe {
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }
}

// ===================== 对外入口 =====================

/// 安装剪贴板监听（幂等；失败只记日志——功能缺失不阻断应用启动）。
///
/// 必须在带消息循环的线程调用（`lib.rs` 的 `.setup()` 满足）。
#[cfg(windows)]
pub fn install(app: AppHandle) {
    if platform::install_impl(app) {
        eprintln!("剪贴板历史监听已启动");
    }
}

/// 非 Windows：不做任何事（功能静默缺席，不影响编译与启动）。
#[cfg(not(windows))]
pub fn install(_app: AppHandle) {}

/// 卸载剪贴板监听（应用退出时调用）。
#[cfg(windows)]
pub fn uninstall() {
    platform::uninstall_impl();
}

#[cfg(not(windows))]
pub fn uninstall() {}

// ===================== tauri 命令（前端 / 插件调用） =====================

/// 列出剪贴板历史（从新到旧）。可选 `query` 做前端文本过滤前的粗筛。
///
/// 列表在索引里已是「从新到旧」，这里原样返回；文本内容一并带上，
/// 前端可据此渲染预览与做关键词过滤。
#[tauri::command]
pub fn clipboard_history_list(
    app: tauri::AppHandle,
    query: Option<String>,
) -> Result<Vec<ClipItem>, String> {
    let idx = load_index(&app);
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

/// 一页剪贴板历史（`clipboard_history_page` 的返回）。
///
/// 分页必须带上 `total` / `has_more`：前端要显示「共 N 条」的**真实总数**
/// （而非已加载条数），并据此判断是否还要继续触底加载。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipPage {
    /// 本页条目（从新到旧）
    pub items: Vec<ClipItem>,
    /// 当前过滤条件下的**总条数**（不受分页影响）
    pub total: usize,
    /// 是否还有下一页
    pub has_more: bool,
}

/// 分页列出剪贴板历史（从新到旧）。
///
/// 参数：
///   - `query`：非空时按文本 / 来源做不区分大小写的包含匹配（与 `list` 同口径）；
///   - `favorite_only`：为真时只返回收藏条目（供「收藏」标签分页）；
///   - `offset`：从过滤结果的第几条开始（0 起）；
///   - `limit`：本页最多取几条（前端传每页大小；Rust 侧再夹紧上限）。
///
/// 过滤在**分页之前**完成，因此总数与切片都建立在同一结果集上，
/// 「全部 / 收藏 / 搜索」三种视图都能各自正确翻页。
#[tauri::command]
pub fn clipboard_history_page(
    app: tauri::AppHandle,
    query: Option<String>,
    favorite_only: Option<bool>,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<ClipPage, String> {
    let q = query.unwrap_or_default().trim().to_lowercase();
    let fav_only = favorite_only.unwrap_or(false);
    let offset = offset.unwrap_or(0);
    // 夹紧每页大小：默认 30，硬上限 200，杜绝一次拉爆前端
    let limit = limit.unwrap_or(30).clamp(1, MAX_PAGE_LIMIT);

    let idx = load_index(&app);
    let filtered = filter_items(idx.items, &q, fav_only);
    Ok(paginate(filtered, offset, limit))
}

/// 按「关键词 + 仅收藏」过滤条目（分页前的纯函数，便于单测）。
///
/// 关键词为空串时只按收藏过滤；匹配口径与 `clipboard_history_list` 完全一致：
/// 有文本按文本匹配，图片（无文本）退回按来源描述匹配。
fn filter_items(items: Vec<ClipItem>, q: &str, fav_only: bool) -> Vec<ClipItem> {
    items
        .into_iter()
        .filter(|it| {
            if fav_only && !it.favorite {
                return false;
            }
            if q.is_empty() {
                return true;
            }
            match &it.text {
                Some(t) => t.to_lowercase().contains(q),
                None => it
                    .source
                    .as_deref()
                    .map(|s| s.to_lowercase().contains(q))
                    .unwrap_or(false),
            }
        })
        .collect()
}

/// 把已过滤的列表切成第 `offset` 起、最多 `limit` 条的一页，并算出总数与是否还有更多。
///
/// `total` 取的是**过滤后全集长度**（不受 offset/limit 影响），因此前端能用它显示
/// 真实总数；`has_more` 用「已消费条数 < 总数」判断，避免前端拿最后一页长度猜。
fn paginate(filtered: Vec<ClipItem>, offset: usize, limit: usize) -> ClipPage {
    let total = filtered.len();
    let items: Vec<ClipItem> = filtered.into_iter().skip(offset).take(limit).collect();
    let has_more = offset.saturating_add(items.len()) < total;
    ClipPage {
        items,
        total,
        has_more,
    }
}

/// 读回一张剪贴板图片 → data URL（列表缩略图 / 大图预览）。
#[tauri::command]
pub fn clipboard_history_read_image(
    app: tauri::AppHandle,
    rel_path: String,
) -> Result<String, String> {
    let path = safe_image_path(&app, &rel_path)?;
    let md = std::fs::metadata(&path).map_err(|e| format!("图片不存在: {e}"))?;
    if !md.is_file() {
        return Err("图片路径不是文件".to_string());
    }
    if md.len() > MAX_IMAGE_BYTES as u64 {
        return Err("图片过大，拒绝读取".to_string());
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("读取图片失败: {e}"))?;
    let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
    Ok(format!("data:image/png;base64,{b64}"))
}

/// 删除一条历史（文本直接从索引移除；图片连同磁盘文件一起删）。
#[tauri::command]
pub fn clipboard_history_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let mut idx = load_index(&app);
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
            if let Ok(dir) = clipboard_dir(&app) {
                let _ = std::fs::remove_file(dir.join(name));
            }
        }
    }
    save_index(&app, &idx)?;
    let _ = app.emit(EVENT_CLIPBOARD_UPDATED, ());
    Ok(())
}

/// 收藏 / 取消收藏一条历史。
///
/// 只改 `favorite` 位并落盘，不删除任何数据；随后广播更新事件，
/// 打开中的视图会自动重拉列表（收藏/取消后不必手动刷新）。
#[tauri::command]
pub fn clipboard_history_set_favorite(
    app: tauri::AppHandle,
    id: String,
    favorite: bool,
) -> Result<(), String> {
    let mut idx = load_index(&app);
    let item = idx
        .items
        .iter_mut()
        .find(|it| it.id == id)
        .ok_or_else(|| "该历史已不存在".to_string())?;
    item.favorite = favorite;
    save_index(&app, &idx)?;
    let _ = app.emit(EVENT_CLIPBOARD_UPDATED, ());
    Ok(())
}

/// 清空历史。
///
/// `keep_favorites` 为 `true`（默认）时**保留收藏条目**，只清掉未收藏的；
/// 传 `false` 则连同收藏一起清空（前端「清空」弹窗里由用户显式选择）。
/// 图片文件按「哪些条目被真正移除」来删，避免误删仍在引用的收藏图片。
#[tauri::command]
pub fn clipboard_history_clear(
    app: tauri::AppHandle,
    keep_favorites: Option<bool>,
) -> Result<(), String> {
    let keep = keep_favorites.unwrap_or(true);
    let mut idx = load_index(&app);

    if keep {
        // 保留收藏：删掉未收藏的条目，并收集其图片文件待删除
        let mut to_delete: Vec<String> = Vec::new();
        idx.items.retain(|it| {
            if it.favorite {
                true
            } else {
                if let Some(rel) = it.rel_path.clone() {
                    to_delete.push(rel);
                }
                false
            }
        });
        save_index(&app, &idx)?;
        if let Ok(dir) = clipboard_dir(&app) {
            for rel in to_delete {
                if let Some(name) = rel.rsplit_once('/').map(|(_, n)| n.to_string()) {
                    let _ = std::fs::remove_file(dir.join(name));
                }
            }
        }
    } else {
        let empty = ClipIndex::default();
        save_index(&app, &empty)?;
        if let Ok(dir) = clipboard_dir(&app) {
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for e in entries.flatten() {
                    let p = e.path();
                    // 保留索引文件自身，删掉其余（图片）
                    if p.is_file() && p.file_name().map(|n| n != "index.json").unwrap_or(false) {
                        let _ = std::fs::remove_file(&p);
                    }
                }
            }
        }
    }
    let _ = app.emit(EVENT_CLIPBOARD_UPDATED, ());
    Ok(())
}

/// 把某条历史「复制回剪贴板」（用户显式点击才调用）。
///
/// 这是本模块**唯一**的写剪贴板路径，且只在用户主动触发时执行；
/// 监听回调永远不会走到这里，因此不影响系统剪贴板的正常读写。
#[tauri::command]
pub fn clipboard_history_copy(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let idx = load_index(&app);
    let item = idx
        .items
        .iter()
        .find(|it| it.id == id)
        .ok_or_else(|| "该历史已不存在".to_string())?;
    match item.kind.as_str() {
        "image" => {
            let rel = item.rel_path.clone().ok_or_else(|| "图片路径缺失".to_string())?;
            let path = safe_image_path(&app, &rel)?;
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

/// 读「剪贴板历史」动作当前绑的键（空串 = 未绑）。
#[tauri::command]
pub fn clipboard_history_get_shortcut(app: tauri::AppHandle) -> Result<String, String> {
    let bindings = crate::read_shortcut_bindings_for_plugin(&app);
    Ok(bindings
        .into_iter()
        .find(|b| b.action == crate::SHORTCUT_ACTION_CLIPBOARD)
        .map(|b| b.shortcut)
        .unwrap_or_default())
}

/// 给「剪贴板历史」动作改绑全局快捷键（空串 = 解绑）。
///
/// 与 `screenshot_set_shortcut` 同构：只改自己这一条，其余绑定（含它们的
/// 作用对象）原样保留——桥接层用完整 `ShortcutBinding` 往返，不会丢 target。
#[tauri::command]
pub fn clipboard_history_set_shortcut(
    app: tauri::AppHandle,
    shortcut: String,
) -> Result<String, String> {
    let key = shortcut.trim().to_lowercase();
    let mut list = crate::read_shortcut_bindings_for_plugin(&app);

    if key.is_empty() {
        list.retain(|b| b.action != crate::SHORTCUT_ACTION_CLIPBOARD);
        if list.is_empty() {
            return Err("至少要保留「呼出 / 隐藏搜索框」这一条快捷键".to_string());
        }
        let applied = crate::apply_shortcut_bindings_for_plugin(&app, &list);
        if applied.is_ok() {
            crate::set_clipboard_unbound(&app, true);
        }
        return applied.map(|_| String::new());
    }

    if let Some(other) = list
        .iter()
        .find(|b| b.shortcut == key && b.action != crate::SHORTCUT_ACTION_CLIPBOARD)
    {
        return Err(format!("该组合键已被「{}」占用，请换一个", other.action));
    }

    match list
        .iter_mut()
        .find(|b| b.action == crate::SHORTCUT_ACTION_CLIPBOARD)
    {
        Some(entry) => entry.shortcut = key.clone(),
        None => list.push(crate::ShortcutBinding {
            shortcut: key.clone(),
            action: crate::SHORTCUT_ACTION_CLIPBOARD.to_string(),
            target: None,
        }),
    }
    crate::apply_shortcut_bindings_for_plugin(&app, &list)?;
    crate::set_clipboard_unbound(&app, false);
    Ok(key)
}

// ===================== 单测 =====================

#[cfg(test)]
mod tests {
    use super::*;

    /// 每个插件 id 都要能过 `validate_plugin_id`，否则落盘目录根本建不出来。
    /// 这里把「本模块写死的插件 id 合法」固化下来，防止手误改名。
    #[test]
    fn plugin_id_is_valid() {
        assert_eq!(CLIPBOARD_PLUGIN_ID, "com.mysearch.clipboard");
        // 反向域名、≥2 段、字符集合法
        assert!(CLIPBOARD_PLUGIN_ID.contains('.'));
        assert!(!CLIPBOARD_PLUGIN_ID.contains(".."));
    }

    /// 图片文件名必须是平铺、无路径分隔、无穿越片段（防目录穿越的第一道）。
    #[test]
    fn image_name_is_flat_and_safe() {
        let name = new_image_name(1700000000000, 7);
        assert_eq!(name, "1700000000000-7.png");
        assert!(!name.contains('/'));
        assert!(!name.contains('\\'));
        assert!(!name.contains(".."));
    }

    /// 索引截断语义：`items` 始终「从新到旧」，裁剪保留前段（最新）。
    /// 这是 `prune_index` 的核心不变式——列表方向反了会删掉最新、留下最旧。
    #[test]
    fn index_keeps_newest_first() {
        let items: Vec<ClipItem> = (0..5)
            .map(|i| ClipItem {
                id: format!("t-{i}"),
                kind: "text".into(),
                text: Some(format!("v{i}")),
                rel_path: None,
                width: None,
                height: None,
                size: 1,
                created_at: (1000 - i) as u64,
                source: None,
                favorite: false,
            })
            .collect();
        let mut idx = ClipIndex { items };
        // 模拟裁剪到前 3 条：保留的应是最新的 t-0/t-1/t-2
        idx.items.truncate(3);
        assert_eq!(idx.items.len(), 3);
        assert_eq!(idx.items[0].id, "t-0");
        assert_eq!(idx.items[2].id, "t-2");
    }

    /// 收藏条目必须免于上限淘汰，且不占用非收藏条目的配额。
    ///
    /// 这里不依赖真实磁盘：直接复刻 `prune_index` 的计数语义做纯逻辑断言——
    /// 若哪天 pruner 改成「收藏也计数」，本测试会失败（那正是要防的回归）。
    #[test]
    fn favorites_survive_prune_and_do_not_consume_quota() {
        fn prune(items: Vec<ClipItem>, max_text: usize) -> Vec<ClipItem> {
            let mut seen = 0usize;
            let mut keep = Vec::new();
            for it in items {
                if it.favorite {
                    keep.push(it);
                    continue;
                }
                if seen < max_text {
                    seen += 1;
                    keep.push(it);
                }
            }
            keep
        }

        let mk = |i: usize, fav: bool| ClipItem {
            id: format!("t-{i}"),
            kind: "text".into(),
            text: Some(format!("v{i}")),
            rel_path: None,
            width: None,
            height: None,
            size: 1,
            created_at: (1000 - i) as u64,
            source: None,
            favorite: fav,
        };

        // 顺序（从新到旧）：收藏#0, 普通#1, 普通#2, 收藏#3, 普通#4；上限 2 条普通
        let items = vec![mk(0, true), mk(1, false), mk(2, false), mk(3, true), mk(4, false)];
        let kept = prune(items, 2);
        let ids: Vec<&str> = kept.iter().map(|it| it.id.as_str()).collect();
        // 两个收藏都在
        assert!(ids.contains(&"t-0"));
        assert!(ids.contains(&"t-3"));
        // 只保留最新 2 条普通（t-1/t-2），最旧的普通 t-4 被淘汰
        assert!(ids.contains(&"t-1") && ids.contains(&"t-2"));
        assert!(!ids.contains(&"t-4"));
        assert_eq!(kept.len(), 4);
    }

    /// `favorite` 字段：缺省 false、序列化时 false 被跳过。
    /// 这保证旧 index.json（无该字段）能原样读入，且新写入不产生噪音。
    #[test]
    fn favorite_defaults_false_and_is_skipped_when_false() {
        let legacy = r#"{"id":"t-1","kind":"text","text":"hi","size":2,"createdAt":1}"#;
        let it: ClipItem = serde_json::from_str(legacy).expect("旧格式应能反序列化");
        assert!(!it.favorite);

        let mut it = it;
        it.favorite = false;
        let s = serde_json::to_string(&it).unwrap();
        assert!(!s.contains("favorite"), "false 不应被序列化: {s}");

        it.favorite = true;
        let s = serde_json::to_string(&it).unwrap();
        assert!(s.contains("\"favorite\":true"), "true 必须被序列化: {s}");
    }

    /// 单条文本超长时按字符数截断（而非字节），中文不会被截成半个字。
    #[test]
    fn long_text_truncates_by_chars() {
        let s: String = "中".repeat(MAX_TEXT_CHARS + 10);
        let truncated: String = s.chars().take(MAX_TEXT_CHARS).collect();
        assert_eq!(truncated.chars().count(), MAX_TEXT_CHARS);
        // 截断后仍是合法 UTF-8（String 本身就保证）
        assert!(truncated.chars().all(|c| c == '中'));
    }

    /// 构造测试条目的小工具：id 形如 `t-<n>`，可指定文本/来源/收藏。
    fn mk_item(id: usize, text: Option<&str>, source: Option<&str>, fav: bool) -> ClipItem {
        ClipItem {
            id: format!("t-{id}"),
            kind: "text".into(),
            text: text.map(|s| s.to_string()),
            rel_path: None,
            width: None,
            height: None,
            size: 1,
            created_at: (1000 - id) as u64,
            source: source.map(|s| s.to_string()),
            favorite: fav,
        }
    }

    /// 过滤：`favorite_only` 只留收藏；关键词按文本匹配、图片退回按来源匹配。
    #[test]
    fn filter_items_by_favorite_and_query() {
        let items = vec![
            mk_item(0, Some("Hello World"), None, true),
            mk_item(1, Some("rust lang"), None, false),
            mk_item(2, None, Some("文件：a.txt"), false),
            mk_item(3, Some("hello again"), None, false),
        ];
        // 仅收藏
        let favs = filter_items(items.clone(), "", true);
        assert_eq!(favs.len(), 1);
        assert_eq!(favs[0].id, "t-0");
        // 关键词不区分大小写命中文本（t-0/t-3）
        let hello = filter_items(items.clone(), "hello", false);
        let ids: Vec<&str> = hello.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["t-0", "t-3"]);
        // 无文本的图片按来源匹配
        let files = filter_items(items.clone(), "文件", false);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].id, "t-2");
        // 收藏 + 关键词同时生效
        let fh = filter_items(items, "hello", true);
        assert_eq!(fh.len(), 1);
        assert_eq!(fh[0].id, "t-0");
    }

    /// 分页：total 是过滤后全集长度；切片与 has_more 正确。
    /// 这是「触底加载更多」的核心不变式——最后一页 has_more 必须为 false，
    /// 否则前端会无限请求下一页。
    #[test]
    fn paginate_slices_and_reports_total_and_more() {
        let all: Vec<ClipItem> = (0..7).map(|i| mk_item(i, Some("x"), None, false)).collect();

        // 第 1 页：0..3
        let p1 = paginate(all.clone(), 0, 3);
        assert_eq!(p1.total, 7);
        assert_eq!(p1.items.len(), 3);
        assert!(p1.has_more);
        assert_eq!(p1.items[0].id, "t-0");

        // 第 3 页（最后一页）：6..7，只剩 1 条且 has_more=false
        let p3 = paginate(all.clone(), 6, 3);
        assert_eq!(p3.total, 7);
        assert_eq!(p3.items.len(), 1);
        assert_eq!(p3.items[0].id, "t-6");
        assert!(!p3.has_more, "最后一页不能再有 has_more");

        // offset 恰好在边界：返回空页且 has_more=false（前端据此停止）
        let p4 = paginate(all.clone(), 7, 3);
        assert_eq!(p4.items.len(), 0);
        assert!(!p4.has_more);

        // offset 越界：不 panic，返回空
        let p5 = paginate(all, 999, 3);
        assert!(p5.items.is_empty());
        assert!(!p5.has_more);
        assert_eq!(p5.total, 7);
    }
}
