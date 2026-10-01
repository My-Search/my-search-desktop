//! 搜索框附件 —— 粘贴 / 拖入的文件与文件夹的原生侧支持。
//!
//! 前端负责「产生附件」（剪贴板粘贴、系统拖放）与结果过滤；Rust 负责三件事：
//!
//! 1. **拿真实路径**：Windows 剪贴板 CF_HDROP（文件夹粘贴只有这条路可靠）、
//!    路径 → {名称, 是否文件夹} 描述（拖放事件只给路径）；
//! 2. **登记附加集合**（`attachments_sync`）：前端增删附件时下发路径集合；
//! 3. **受控访问**（`attachment_read/list/open`）：读内容、递归列举、系统打开。
//!
//! 递归列举（`attachment_list`）默认**不限条数**：一直枚举到遍历结束，
//! 或用户经 `attachment_list_cancel(gen)` 主动中止（walk 立即带着已收集的
//! 部分返回，走 `Ok` 出口）。另有可选**流式**通道（`on_batch`）：每攒够
//! 一批就推给前端，供插件「边扫边显示」；不传通道的调用方（旧插件）行为不变。
//!
//! 与 `plugin_net_fetch` 同构的纵深防御：每个受控命令都先查**网关 grants**
//! 是否含 `file.read`（第一道在前端 host.ts），再校验目标路径落在已登记的
//! 附加集合内——插件因此拿不到集合之外的本地文件。
//!
//! 注意：`attachments_sync` 本身不做鉴权（它只是登记），信任边界与现有
//! 网关一致：命令调用方 = 搜索窗口页面（含其中运行的插件脚本），而真正
//! 泄露数据的读取类命令都有 grants + 集合双重校验。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::UNIX_EPOCH;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use crate::plugin_host::{gateway_get, has_base_permission};

/// 单个读取的最大字节数（超出直接拒绝，避免 IPC 被超大文件拖死）
const MAX_READ_BYTES: u64 = 100 * 1024 * 1024;
/// 递归列举的深度上限（防符号链接/超深树）
const MAX_WALK_DEPTH: usize = 16;
/// 流式列举的批量阈值：攒够这么多条就推一批给前端（配合「边扫边显示」）。
/// 太小会放大 IPC 次数，太大又削弱「边扫边看」的即时感。
const WALK_BATCH: usize = 256;

/// 已登记的附加根（由前端 `attachments_sync` 下发）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentRoot {
    pub path: String,
    /// true = 文件夹（可列举），false = 单文件
    pub is_dir: bool,
}

/// 附加集合（路径比对前统一归一化，见 `norm_path`）
static ATTACHMENTS: LazyLock<Mutex<Vec<AttachmentRoot>>> = LazyLock::new(|| Mutex::new(Vec::new()));

/// 已取消的列举代次（gen）：`attachment_list_cancel` 写入，walk 轮询。
/// `u64::MAX` 是「无取消」哨兵（前端 gen 从 1 自增，永远不会是 MAX）。
static CANCELLED_GEN: AtomicU64 = AtomicU64::new(u64::MAX);

/// `fs_describe_paths` 的返回条目
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentPathEntry {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
}

/// `attachment_list` 的返回条目
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentDirEntry {
    pub path: String,
    pub name: String,
    /// 相对所列文件夹的路径（正斜杠）
    pub rel_path: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime_ms: u64,
}

/// 路径归一化：统一正斜杠、去尾部斜杠；Windows 下忽略大小写
fn norm_path(p: &str) -> String {
    let s = p.replace('\\', "/");
    let s = s.trim_end_matches('/');
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s.to_string()
    }
}

/// `path` 是否等于 `root` 或位于其**下方**（按归一化后的路径段比较）
fn is_under(root: &str, path: &str) -> bool {
    let nr = norm_path(root);
    let np = norm_path(path);
    if nr.is_empty() {
        return false;
    }
    np == nr || np.starts_with(&(nr.clone() + "/"))
}

/// 受控访问校验：网关有 `file.read` + 路径在附加集合内。
/// `require_folder` = 只接受落在**文件夹附件**下方的路径（列举/进入用）。
fn check_access(plugin_id: &str, path: &str, require_folder: bool) -> Result<(), String> {
    let spec = gateway_get(plugin_id).ok_or_else(|| err("插件未在网关登记（请先同步注册表）"))?;
    if !spec.enabled {
        return Err(err("插件未启用"));
    }
    if !has_base_permission(&spec, "file.read") {
        return Err(err("缺少 file.read 权限"));
    }
    let roots = ATTACHMENTS
        .lock()
        .map_err(|_| err("附件登记表被占用"))?
        .clone();
    if roots.is_empty() {
        return Err(err("当前没有附加任何文件/文件夹"));
    }
    let hit = roots.iter().any(|r| {
        if require_folder && !r.is_dir {
            return false;
        }
        is_under(&r.path, path)
    });
    if !hit {
        return Err(err("路径不在已附加的内容范围内"));
    }
    Ok(())
}

fn err(msg: &str) -> String {
    msg.to_string()
}

/// 扩展名 → MIME（data URL 用；未识别按二进制流处理）
fn guess_mime(name: &str) -> &'static str {
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase());
    match ext.as_deref() {
        Some("txt") | Some("log") | Some("md") | Some("markdown") => "text/plain",
        Some("json") => "application/json",
        Some("csv") => "text/csv",
        Some("tsv") => "text/tab-separated-values",
        Some("html") | Some("htm") => "text/html",
        Some("css") => "text/css",
        Some("js") | Some("mjs") | Some("cjs") => "text/javascript",
        Some("ts") => "text/typescript",
        Some("xml") => "application/xml",
        Some("pdf") => "application/pdf",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("ico") => "image/x-icon",
        Some("bmp") => "image/bmp",
        Some("avif") => "image/avif",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("ogg") => "audio/ogg",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("zip") => "application/zip",
        Some("gz") => "application/gzip",
        Some("7z") => "application/x-7z-compressed",
        Some("rar") => "application/vnd.rar",
        Some("tar") => "application/x-tar",
        Some("yaml") | Some("yml") => "text/yaml",
        _ => "application/octet-stream",
    }
}

/// 文件系统路径 → 展示名（无路径时退化为原串）
fn path_name(p: &str) -> String {
    Path::new(p)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| p.to_string())
}

/// mtime → 毫秒时间戳（取不到返回 0）
fn mtime_ms(md: &std::fs::Metadata) -> u64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ===================== 命令：剪贴板 / 路径描述 / 登记 =====================

/// 读取系统剪贴板里的文件/文件夹路径（Windows CF_HDROP）。
///
/// 资源管理器里复制文件**或文件夹**后，Windows 剪贴板以 CF_HDROP（格式 15）
/// 存放完整路径列表；WebView 的 ClipboardEvent 拿不到文件夹的可靠信息，
/// 所以粘贴路径必须经这里。无文件时返回空数组（调用方据此决定走文本粘贴）。
#[tauri::command]
pub fn clipboard_file_paths() -> Result<Vec<String>, String> {
    clipboard_file_paths_impl()
}

#[cfg(windows)]
fn clipboard_file_paths_impl() -> Result<Vec<String>, String> {
    use windows_sys::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
    use windows_sys::Win32::UI::Shell::DragQueryFileW;

    /// CF_HDROP：文件列表剪贴板格式（winuser.h 定义为 15）
    const CF_HDROP: u32 = 15;
    /// DragQueryFileW 查长度的哨兵值
    const QUERY_COUNT: u32 = 0xFFFF_FFFF;

    unsafe fn read_hdrop(handle: *mut core::ffi::c_void) -> Vec<String> {
        let count = DragQueryFileW(handle, QUERY_COUNT, std::ptr::null_mut(), 0);
        let mut out = Vec::with_capacity(count as usize);
        for i in 0..count {
            let len = DragQueryFileW(handle, i, std::ptr::null_mut(), 0);
            if len == 0 {
                continue;
            }
            let mut buf = vec![0u16; len as usize + 1];
            let got = DragQueryFileW(handle, i, buf.as_mut_ptr(), buf.len() as u32);
            if got == 0 {
                continue;
            }
            if let Ok(s) = String::from_utf16(&buf[..got as usize]) {
                if !s.is_empty() {
                    out.push(s);
                }
            }
        }
        out
    }

    unsafe {
        // HWND = null：与当前任务关联（本进程即搜索窗，无窗口句柄依赖）
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return Err(err("打开剪贴板失败（可能被其它程序占用），请稍后重试"));
        }
        let result = (|| {
            let handle = GetClipboardData(CF_HDROP);
            if handle.is_null() {
                return Ok(Vec::new());
            }
            Ok(read_hdrop(handle))
        })();
        CloseClipboard();
        result
    }
}

#[cfg(not(windows))]
fn clipboard_file_paths_impl() -> Result<Vec<String>, String> {
    // macOS/Linux 的文件剪贴板格式与 Windows 不同；当前仅实现 Windows，
    // 其它平台返回空数组 → 前端退回 web 层 File 兜底。
    Ok(Vec::new())
}

/// 按绝对路径描述条目（名称 + 是否文件夹）。粘贴与拖放共用。
#[tauri::command]
pub fn fs_describe_paths(paths: Vec<String>) -> Vec<AttachmentPathEntry> {
    paths
        .into_iter()
        .filter(|p| !p.trim().is_empty())
        .map(|p| {
            let is_dir = std::fs::metadata(&p).map(|m| m.is_dir()).unwrap_or(false);
            let name = path_name(&p);
            AttachmentPathEntry { path: p, name, is_dir }
        })
        .collect()
}

/// 登记当前附加的路径集合（覆盖式）。前端在附件增删时调用。
#[tauri::command]
pub fn attachments_sync(roots: Vec<AttachmentRoot>) -> Result<(), String> {
    let mut list = roots
        .into_iter()
        .filter(|r| !r.path.trim().is_empty())
        .collect::<Vec<_>>();
    // 稳定顺序 + 按路径去重（防止反复同步堆积）
    list.sort_by(|a, b| a.path.cmp(&b.path));
    list.dedup_by(|a, b| a.path == b.path);
    let mut guard = ATTACHMENTS.lock().map_err(|_| err("附件登记表被占用"))?;
    *guard = list;
    Ok(())
}

// ===================== 命令：受控读取 / 列举 / 打开 =====================

/// 读一个附加文件 → data URL（`data:<mime>;base64,...`）。
#[tauri::command]
pub fn attachment_read(plugin_id: String, path: String) -> Result<String, String> {
    check_access(&plugin_id, &path, false)?;
    let p = PathBuf::from(&path);
    let md = std::fs::metadata(&p).map_err(|e| err(&format!("读取文件信息失败: {e}")))?;
    if md.is_dir() {
        return Err(err("目标是文件夹，请改用 listFolder"));
    }
    if md.len() > MAX_READ_BYTES {
        return Err(err(&format!(
            "文件过大（{} MB，上限 {} MB）",
            md.len() / (1024 * 1024),
            MAX_READ_BYTES / (1024 * 1024)
        )));
    }
    let bytes = std::fs::read(&p).map_err(|e| err(&format!("读取文件失败: {e}")))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let name = path_name(&path);
    Ok(format!("data:{};base64,{}", guess_mime(&name), b64))
}

/// 图片缩略图可用的扩展名（与前端 attachments.ts 的 PREVIEW_IMAGE_EXTS 一致）
const PREVIEW_IMAGE_EXTS: [&str; 9] = [
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "svg",
];

/// 搜索框缩略图读取的默认上限（图片缩略图不需要整个大图）
const PREVIEW_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// 附加图片 → data URL，供**宿主搜索框**渲染缩略图（不显示文件名）。
///
/// 与 `attachment_read` 的区别（刻意收窄，因为宿主 UI 不需要插件权限）：
///   - 免 `file.read` 权限，但仍要求路径落在已登记的附加集合内
///     （= 用户主动放进搜索框的那些路径）；
///   - 只接受图片扩展名，避免被当成「任意文件读取器」；
///   - 只读前 `max_bytes`（默认 8MB），超大图直接拒绝（不截断成坏图）。
#[tauri::command]
pub fn attachment_preview(path: String, max_bytes: Option<u64>) -> Result<String, String> {
    let name = path_name(&path);
    let ext = name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !PREVIEW_IMAGE_EXTS.contains(&ext.as_str()) {
        return Err(err("不是可预览的图片格式"));
    }
    let roots = ATTACHMENTS
        .lock()
        .map_err(|_| err("附件登记表被占用"))?
        .clone();
    if roots.is_empty() {
        return Err(err("当前没有附加任何文件/文件夹"));
    }
    if !roots.iter().any(|r| is_under(&r.path, &path)) {
        return Err(err("路径不在已附加的内容范围内"));
    }
    let p = PathBuf::from(&path);
    let md = std::fs::metadata(&p).map_err(|e| err(&format!("读取文件信息失败: {e}")))?;
    if md.is_dir() {
        return Err(err("目标是文件夹"));
    }
    let limit = max_bytes.unwrap_or(PREVIEW_MAX_BYTES).clamp(1, MAX_READ_BYTES);
    if md.len() > limit {
        return Err(err("图片过大，无法预览"));
    }
    let bytes = std::fs::read(&p).map_err(|e| err(&format!("读取文件失败: {e}")))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", guess_mime(&name), b64))
}

/// 递归列举一个附加文件夹（返回文件+子目录，按相对路径排序）。
///
/// **无固定条数上限**：`limit` 传 `None`/`0` = 不限，一直枚举到结束或用户中止。
/// `gen` = 本轮列举的代次：只有与 `attachment_list_cancel` 传入值相同的轮次
/// 才会受取消影响；不传 `gen` 的调用方（旧宿主）永不被取消。
///
/// **可选流式**：`on_batch` 是前端 Channel（`new Channel()` 序列化为
/// `__CHANNEL__:<id>`）。传了它 → 每攒够 `WALK_BATCH` 条就推一批，前端可
/// 「边扫边显示」；不传（旧插件/旧宿主）→ 完全保持旧行为，走完一次性返回。
///
/// 声明为 async 并把实际遍历丢进 `spawn_blocking`：列举是密集 I/O，
/// 占住主线程会让整个应用在长列举期间卡死——「停止」按钮也就点不动了。
#[tauri::command]
pub async fn attachment_list(
    plugin_id: String,
    path: String,
    limit: Option<usize>,
    gen: Option<u64>,
    on_batch: Option<tauri::ipc::JavaScriptChannelId>,
    webview: tauri::Webview,
) -> Result<Vec<AttachmentDirEntry>, String> {
    // JavaScriptChannelId → 真正的发送通道（需要 webview 才能 eval 回去）。
    // `Option<Channel<T>>` 不被命令宏支持（Channel 不是 Deserialize），
    // 所以参数收 JavaScriptChannelId、在命令体内再 `channel_on`。
    let channel: Option<Channel<Vec<AttachmentDirEntry>>> =
        on_batch.map(|id| id.channel_on(webview));
    tauri::async_runtime::spawn_blocking(move || {
        list_blocking(&plugin_id, &path, limit, gen, channel)
    })
    .await
    .map_err(|e| err(&format!("列举任务执行失败: {e}")))?
}

/// `attachment_list` 的本体（在线程池上执行）
fn list_blocking(
    plugin_id: &str,
    path: &str,
    limit: Option<usize>,
    gen: Option<u64>,
    channel: Option<Channel<Vec<AttachmentDirEntry>>>,
) -> Result<Vec<AttachmentDirEntry>, String> {
    check_access(plugin_id, path, true)?;
    // None/0 = 不限条数（用户点「停止」或走完为止）；正数才作为上限。
    let limit = limit.filter(|n| *n > 0).unwrap_or(usize::MAX);
    let root = PathBuf::from(path);
    if !root.is_dir() {
        return Err(err("目标不是文件夹"));
    }
    let mut ctx = WalkCtx {
        out: Vec::new(),
        limit,
        gen,
        channel: channel.as_ref(),
        sent: 0,
        batch: WALK_BATCH,
    };
    walk(&root, "", 0, &mut ctx)?;
    ctx.flush(); // 把最后不足一批的尾巴也推出去（若还在流式）
    let mut out = ctx.out;
    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(out)
}

/// 取消一代列举：携带该 `gen` 的在途与后续 walk 尽快带着**已收集的部分**
/// 返回（取消检查与深度/上限同级，走 `Ok` 出口，不出错误）。新一轮列举用
/// 新 gen，天然不受上一轮取消影响——无需任何「复位」握手。
#[tauri::command]
pub fn attachment_list_cancel(gen: u64) {
    if gen != u64::MAX {
        CANCELLED_GEN.store(gen, Ordering::Relaxed);
    }
}

/// walk 轮询：本轮 gen 是否已被取消（未传 gen 的调用方永不取消）
#[inline]
fn walk_cancelled(gen: Option<u64>) -> bool {
    match gen {
        Some(g) => CANCELLED_GEN.load(Ordering::Relaxed) == g,
        None => false,
    }
}

/// 一次列举的可变上下文：累积结果、条数上限、取消代次与（可选）流式通道。
/// 打包成一个结构体而不是给 walk 堆 6 个参数，递归调用处也清爽。
struct WalkCtx<'a> {
    /// 全部条目（返回时排序；流式只用作「取尚未推送的那一段」的源）
    out: Vec<AttachmentDirEntry>,
    /// 条数上限（`usize::MAX` = 不限）
    limit: usize,
    /// 取消代次（`None` = 永不取消）
    gen: Option<u64>,
    /// 流式通道（`None` = 不推，走完一次性返回）
    channel: Option<&'a Channel<Vec<AttachmentDirEntry>>>,
    /// 已推送条数（`out[sent..]` = 尚未推送的部分）
    sent: usize,
    /// 批量阈值
    batch: usize,
}

impl WalkCtx<'_> {
    /// 是否该停：到达上限或用户取消。
    #[inline]
    fn stop(&self) -> bool {
        self.out.len() >= self.limit || walk_cancelled(self.gen)
    }

    /// 把尚未推送的条目按批推给前端（不足一批时 `force` 才推）。
    /// send 失败**吞掉**：流是 best-effort，通道那头（视图已卸载）断了
    /// 不该让整次列举失败——最终返回值仍会带上完整结果。
    fn flush_ready(&mut self, force: bool) {
        let Some(ch) = self.channel else { return };
        loop {
            let pending = self.out.len() - self.sent;
            if pending == 0 || (!force && pending < self.batch) {
                return;
            }
            let n = if force { pending } else { self.batch };
            if ch.send(self.out[self.sent..self.sent + n].to_vec()).is_err() {
                return;
            }
            self.sent += n;
            // 非 force 时推满一批就停，等下一批攒够再推（保持批量语义）
            if !force {
                return;
            }
        }
    }

    /// 收尾：把尾巴（不足一批的）也推出去。
    fn flush(&mut self) {
        self.flush_ready(true);
    }
}

/// 深度优先列举：目录本身也入列（用户也能按文件夹名搜），符号链接不跟随（防环）。
/// `gen` 用于取消：命中时与「到深/到量」一样立即 Ok 返回，已收集的部分保留。
fn walk(
    dir: &Path,
    rel_base: &str,
    depth: usize,
    ctx: &mut WalkCtx,
) -> Result<(), String> {
    if depth > MAX_WALK_DEPTH || ctx.stop() {
        return Ok(());
    }
    let rd = std::fs::read_dir(dir).map_err(|e| err(&format!("读取目录失败: {e}")))?;
    let mut children: Vec<_> = rd.filter_map(|e| e.ok()).collect();
    children.sort_by_key(|e| e.file_name());
    for child in children {
        if ctx.stop() {
            break;
        }
        let name = child.file_name().to_string_lossy().to_string();
        let child_path = child.path();
        let rel = if rel_base.is_empty() {
            name.clone()
        } else {
            format!("{rel_base}/{name}")
        };
        // DirEntry::metadata 不跟随符号链接（等价 lstat）；失败按普通文件处理
        let md = child.metadata().ok();
        let file_type = child.file_type().ok();
        let is_symlink = file_type.as_ref().map(|t| t.is_symlink()).unwrap_or(false);
        let is_dir = md.as_ref().map(|m| m.is_dir()).unwrap_or(false) && !is_symlink;
        let size = md.as_ref().map(|m| m.len()).unwrap_or(0);
        let mtime = md.as_ref().map(mtime_ms).unwrap_or(0);
        let path_str = child_path.to_string_lossy().to_string();
        ctx.out.push(AttachmentDirEntry {
            path: path_str,
            name,
            rel_path: rel.clone(),
            is_dir,
            size,
            mtime_ms: mtime,
        });
        ctx.flush_ready(false); // 攒够一批就推，配合「边扫边显示」
        if is_dir && depth < MAX_WALK_DEPTH && !ctx.stop() {
            walk(&child_path, &rel, depth + 1, ctx)?;
        }
    }
    Ok(())
}

/// 用系统默认程序打开一个附加路径（文件或文件夹）。
#[tauri::command]
pub fn attachment_open(app: tauri::AppHandle, plugin_id: String, path: String) -> Result<(), String> {
    check_access(&plugin_id, &path, false)?;
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| err(&format!("打开失败: {e}")))
}

/// 在系统文件管理器（Windows 资源管理器）中定位一个附加路径：
/// 打开所在目录并选中该文件 / 文件夹。与 `attachment_open` 同样的
/// 「网关 grants + 附加集合」双重校验，插件定位不到集合之外的路径。
#[tauri::command]
pub fn attachment_reveal(app: tauri::AppHandle, plugin_id: String, path: String) -> Result<(), String> {
    check_access(&plugin_id, &path, false)?;
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|e| err(&format!("定位失败: {e}")))
}

// ===================== 命令：系统文件图标 =====================

/// 图标请求条目（前端批量查询，减少 IPC 往返）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentIconRequest {
    pub path: String,
    /// 前端已知的类型：路径已失效（历史里被删的文件）时靠它取该类型的默认图标
    #[serde(default)]
    pub is_dir: bool,
}

/// 图标查询结果：`icon` 为 PNG data URL；取不到时 None（前端退回内置图标）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentIconResult {
    pub path: String,
    pub icon: Option<String>,
}

/// 图标缓存上限（chip 与历史条带的条目量级远小于此；超了整体清空即可）
const ICON_CACHE_MAX: usize = 1024;

/// 图标内嵌在文件里、必须按**文件**而非类型区分的扩展名
/// （按扩展名缓存会让所有 .exe 共用第一个 exe 的图标）
const PER_FILE_ICON_EXTS: [&str; 3] = ["exe", "lnk", "ico"];

/// 系统图标缓存：缓存键 → PNG data URL。
///
/// 按**类型**（是否文件夹 + 小写扩展名）而非路径缓存：同一批 .docx 只走一次
/// Shell 查询，几百个文件也不重复提取。`.exe`/`.lnk`/`.ico` 的图标内嵌在文件
/// 本身，那几个扩展名退回按完整路径缓存。
static ICON_CACHE: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 缓存键：文件夹统一一个键；文件按小写扩展名（无扩展名用空串），
/// 内嵌图标的类型按完整路径。
fn icon_cache_key(is_dir: bool, path: &str) -> String {
    if is_dir {
        return "dir".to_string();
    }
    let ext = Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if PER_FILE_ICON_EXTS.contains(&ext.as_str()) {
        return format!("path:{}", norm_path(path));
    }
    format!("ext:{ext}")
}

/// 批量取系统文件图标（资源管理器同款），返回 PNG data URL。
///
/// **两种调用方，两种校验口径**：
///   - 不传 `plugin_id`：宿主搜索框自己的 UI 装饰（chips / 最近添加条带），
///     与 `attachment_preview` 同款定位——只回图标、不碰文件内容，免网关校验。
///     条带里的历史条目**未必**还在当前附加集合内，因此这里不能强制集合校验。
///   - 传 `plugin_id`：插件调用（`ms.input.fileIcons`）。按插件身份做
///     「网关 grants 含 `file.read` + 路径落在附加集合内」双重校验（与
///     `attachment_open` / `attachment_reveal` 同口径），越界请求整批拒绝，
///     避免插件拿它当「集合之外的文件探测/图标读取器」。
///
/// 取不到的条目 `icon` 为 None，前端退回内置图标。
///
/// 声明为 async + spawn_blocking：Shell 图标查询可能因第三方图标处理器
/// 卡住（网络路径、损坏的扩展），占住主线程会让整个应用僵住。
#[tauri::command]
pub async fn attachment_file_icons(
    entries: Vec<AttachmentIconRequest>,
    plugin_id: Option<String>,
) -> Result<Vec<AttachmentIconResult>, String> {
    if entries.is_empty() {
        return Ok(Vec::new());
    }
    // 插件调用：先按身份校验（任一路径越界即整批拒绝，不做「部分放行」，
    // 免得调用方把拒绝当「该文件没有图标」而悄悄探测集合外的存在性）
    if let Some(pid) = plugin_id {
        for e in &entries {
            check_access(&pid, &e.path, false)?;
        }
    }
    // 宿主调用（无 plugin_id）：与历史行为一致，只回图标
    Ok(tauri::async_runtime::spawn_blocking(move || {
        entries
            .into_iter()
            .map(|e| {
                let icon = file_icon_data_url(&e.path, e.is_dir);
                AttachmentIconResult { path: e.path, icon }
            })
            .collect()
    })
    .await
    .unwrap_or_default())
}

/// 取一个路径的系统图标（data URL）；命中缓存直接返回。
fn file_icon_data_url(path: &str, is_dir: bool) -> Option<String> {
    if path.trim().is_empty() {
        return None;
    }
    let key = icon_cache_key(is_dir, path);
    if let Ok(cache) = ICON_CACHE.lock() {
        if let Some(hit) = cache.get(&key) {
            return Some(hit.clone());
        }
    }
    let png = file_icon_png(path, is_dir).ok()?;
    let url = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&png)
    );
    if let Ok(mut cache) = ICON_CACHE.lock() {
        if cache.len() >= ICON_CACHE_MAX {
            cache.clear();
        }
        cache.insert(key, url.clone());
    }
    Some(url)
}

/// 路径 → 系统图标 PNG 字节（Windows：SHGetFileInfoW + HICON → RGBA）
#[cfg(windows)]
fn file_icon_png(path: &str, is_dir: bool) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL,
    };
    use windows_sys::Win32::UI::Shell::{
        SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON, SHGFI_USEFILEATTRIBUTES,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::DestroyIcon;

    // Shell 图标查询走 COM：线程未初始化套间时部分图标处理器会直接失败。
    // 不配对 CoUninitialize——线程由运行时复用，保持初始化态最安全
    //（与 alt_click.rs 的钩子线程同款约定）。
    unsafe {
        let _ = windows_sys::Win32::System::Com::CoInitializeEx(
            std::ptr::null(),
            windows_sys::Win32::System::Com::COINIT_APARTMENTTHREADED as u32,
        );
    }

    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let cb = std::mem::size_of::<SHFILEINFOW>() as u32;
    let flags = SHGFI_ICON | SHGFI_LARGEICON;

    unsafe {
        // 1. 按真实路径查询：能拿到 exe 内嵌图标、文件自定义图标等真实结果
        let mut info: SHFILEINFOW = std::mem::zeroed();
        let mut hicon = if SHGetFileInfoW(wide.as_ptr(), 0, &mut info, cb, flags) != 0 {
            info.hIcon
        } else {
            std::ptr::null_mut()
        };
        // 2. 路径已失效（历史里被删的文件）：按扩展名 + 属性取该类型的默认图标
        if hicon.is_null() {
            let attr = if is_dir {
                FILE_ATTRIBUTE_DIRECTORY
            } else {
                FILE_ATTRIBUTE_NORMAL
            };
            let mut info2: SHFILEINFOW = std::mem::zeroed();
            if SHGetFileInfoW(
                wide.as_ptr(),
                attr,
                &mut info2,
                cb,
                flags | SHGFI_USEFILEATTRIBUTES,
            ) != 0
            {
                hicon = info2.hIcon;
            }
        }
        if hicon.is_null() {
            return Err(err("系统未返回该类型的图标"));
        }
        // DestroyIcon 是必需的：SHGetFileInfoW 交出的 HICON 归调用方释放
        let png = hicon_to_png(hicon);
        DestroyIcon(hicon);
        png
    }
}

/// 非 Windows：图标来源完全不同（macOS 走 NSWorkspace、Linux 走 gio），
/// 当前未实现——返回错误让前端退回内置 SVG 图标。
#[cfg(not(windows))]
fn file_icon_png(_path: &str, _is_dir: bool) -> Result<Vec<u8>, String> {
    Err(err("当前平台暂不支持系统文件图标"))
}

/// HICON → PNG 字节（32bpp RGBA）
#[cfg(windows)]
unsafe fn hicon_to_png(
    hicon: windows_sys::Win32::UI::WindowsAndMessaging::HICON,
) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetObjectW, BITMAP,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetIconInfo, ICONINFO};

    let mut ii: ICONINFO = std::mem::zeroed();
    if GetIconInfo(hicon, &mut ii) == 0 {
        return Err(err("读取图标信息失败"));
    }
    // GetIconInfo 把两个位图的所有权交给调用方：无论成败都要释放
    let result = (|| {
        if ii.hbmColor.is_null() {
            // 单色图标（极老的应用）：没有彩色位图，交给前端退回内置图标
            return Err(err("图标为单色位图，暂不支持"));
        }
        let mut bmp: BITMAP = std::mem::zeroed();
        if GetObjectW(
            ii.hbmColor as *mut core::ffi::c_void,
            std::mem::size_of::<BITMAP>() as i32,
            &mut bmp as *mut BITMAP as *mut core::ffi::c_void,
        ) == 0
        {
            return Err(err("读取图标尺寸失败"));
        }
        let (w, h) = (bmp.bmWidth, bmp.bmHeight);
        if w <= 0 || h <= 0 || w > 1024 || h > 1024 {
            return Err(err("图标尺寸异常"));
        }

        let hdc = CreateCompatibleDC(std::ptr::null_mut());
        if hdc.is_null() {
            return Err(err("创建绘图上下文失败"));
        }
        let mut rgba = match read_bgra(hdc, ii.hbmColor, w, h) {
            Some(px) => px,
            None => {
                DeleteDC(hdc);
                return Err(err("读取图标像素失败"));
            }
        };
        // alpha 全 0 = 图标没带 alpha 通道，透明信息在 AND 掩码里
        if rgba.chunks_exact(4).all(|p| p[3] == 0) {
            match read_mask(hdc, ii.hbmMask, w, h) {
                Some(mask) => {
                    for (p, a) in rgba.chunks_exact_mut(4).zip(mask) {
                        p[3] = a;
                    }
                }
                None => {
                    for p in rgba.chunks_exact_mut(4) {
                        p[3] = 255;
                    }
                }
            }
        }
        DeleteDC(hdc);

        // GDI 给的是 BGRA，PNG 要 RGBA
        for p in rgba.chunks_exact_mut(4) {
            p.swap(0, 2);
        }
        encode_png(&rgba, w as u32, h as u32)
    })();
    // 空句柄 DeleteObject 是安全的 no-op，不需要额外的非空判断
    DeleteObject(ii.hbmColor as *mut core::ffi::c_void);
    DeleteObject(ii.hbmMask as *mut core::ffi::c_void);
    result
}

/// 读 32bpp 彩色位图像素（BGRA，自上而下）
#[cfg(windows)]
unsafe fn read_bgra(
    hdc: windows_sys::Win32::Graphics::Gdi::HDC,
    hbm: windows_sys::Win32::Graphics::Gdi::HBITMAP,
    w: i32,
    h: i32,
) -> Option<Vec<u8>> {
    use windows_sys::Win32::Graphics::Gdi::{
        GetDIBits, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };

    let mut bi: BITMAPINFO = std::mem::zeroed();
    bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    bi.bmiHeader.biWidth = w;
    bi.bmiHeader.biHeight = -h; // 负数 = 自上而下，省去后面逐行翻转
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 32;
    bi.bmiHeader.biCompression = BI_RGB;

    let mut buf = vec![0u8; (w as usize) * (h as usize) * 4];
    let got = GetDIBits(
        hdc,
        hbm,
        0,
        h as u32,
        buf.as_mut_ptr() as *mut core::ffi::c_void,
        &mut bi,
        DIB_RGB_COLORS,
    );
    if got == 0 {
        None
    } else {
        Some(buf)
    }
}

/// 读 1bpp AND 掩码 → 每像素 alpha（掩码位为 1 表示透明）
#[cfg(windows)]
unsafe fn read_mask(
    hdc: windows_sys::Win32::Graphics::Gdi::HDC,
    hbm_mask: windows_sys::Win32::Graphics::Gdi::HBITMAP,
    w: i32,
    h: i32,
) -> Option<Vec<u8>> {
    use windows_sys::Win32::Graphics::Gdi::{
        GetDIBits, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };

    if hbm_mask.is_null() {
        return None;
    }
    // 1bpp 位图的行按 4 字节对齐
    let stride = ((w + 31) / 32 * 4) as usize;

    let mut bi: BITMAPINFO = std::mem::zeroed();
    bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    bi.bmiHeader.biWidth = w;
    bi.bmiHeader.biHeight = -h;
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 1;
    bi.bmiHeader.biCompression = BI_RGB;

    let mut buf = vec![0u8; stride * h as usize];
    if GetDIBits(
        hdc,
        hbm_mask,
        0,
        h as u32,
        buf.as_mut_ptr() as *mut core::ffi::c_void,
        &mut bi,
        DIB_RGB_COLORS,
    ) == 0
    {
        return None;
    }

    let (wu, hu) = (w as usize, h as usize);
    let mut out = vec![255u8; wu * hu];
    for y in 0..hu {
        for x in 0..wu {
            if (buf[y * stride + x / 8] >> (7 - (x % 8))) & 1 == 1 {
                out[y * wu + x] = 0;
            }
        }
    }
    Some(out)
}

/// RGBA 像素 → PNG 字节
#[cfg(windows)]
fn encode_png(rgba: &[u8], w: u32, h: u32) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc
            .write_header()
            .map_err(|e| err(&format!("图标编码失败: {e}")))?;
        writer
            .write_image_data(rgba)
            .map_err(|e| err(&format!("图标编码失败: {e}")))?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn norm_and_under_matching() {
        assert!(is_under("C:/a/b", "C:\\a\\b\\c.txt"));
        assert!(is_under("C:/a/b", "C:\\a\\b"));
        assert!(!is_under("C:/a/b", "C:\\a\\bc"));
        assert!(!is_under("", "/any"));
        assert!(is_under("/home/u/docs", "/home/u/docs/sub/deep.md"));
        assert!(!is_under("/home/u/docs", "/home/u/secret.md"));
    }

    #[test]
    fn mime_guessing() {
        assert_eq!(guess_mime("a.PNG"), "image/png");
        assert_eq!(guess_mime("b.tar.gz"), "application/gzip");
        assert_eq!(guess_mime("noext"), "application/octet-stream");
        assert_eq!(guess_mime("x.md"), "text/plain");
    }

    #[test]
    fn path_name_extraction() {
        assert_eq!(path_name("C:\\tmp\\报告.pdf"), "报告.pdf");
        assert_eq!(path_name("/home/u/dir/"), "dir");
    }

    #[test]
    fn reveal_target_must_be_under_attachment_root() {
        // 定位（attachment_reveal）复用 check_access 的集合内判定：
        // 只放行落在附加根之下/相等的路径（文件或文件夹），同名前缀的近邻不放行。
        let root = "C:\\Users\\me\\Docs";
        // 根下的文件与文件夹（含更深层）→ 允许定位
        assert!(is_under(root, "C:\\Users\\me\\Docs\\报告.pdf"));
        assert!(is_under(root, "C:\\Users\\me\\Docs\\子目录"));
        assert!(is_under(root, "C:\\Users\\me\\Docs\\a\\b\\c.txt"));
        // 根本身（文件夹条目定位到自身）→ 允许
        assert!(is_under(root, "C:/Users/me/Docs/"));
        // 前缀相同的近邻（Docs2）与集合之外 → 拒绝
        assert!(!is_under(root, "C:\\Users\\me\\Docs2\\泄漏.txt"));
        assert!(!is_under(root, "C:\\Users\\me\\Other\\x.txt"));
        // 空根（未登记附件）→ 一律拒绝
        assert!(!is_under("", "C:/anything"));
    }

    /// 插件调用 `attachment_file_icons`（带 plugin_id）必须走 `check_access`：
    /// 未登记的插件 / 缺少 file.read / 路径越界都要被拒，避免把图标命令
    /// 当成「集合之外的文件探测/读取器」。宿主调用（无 plugin_id）不受影响。
    #[test]
    fn plugin_icon_requests_are_checked_against_gateway_and_attachment_set() {
        // 未在网关登记（GATEWAY 无该 id）→ 拒绝
        let e = AttachmentIconRequest {
            path: "C:/Users/me/Docs/a.docx".into(),
            is_dir: false,
        };
        assert!(check_access("com.example.not-registered", &e.path, false).is_err());
        // 空路径：同样先过 check_access，未登记插件一律拒绝（不会退化成放行）
        assert!(check_access("com.example.not-registered", "", false).is_err());
    }

    #[test]
    fn icon_cache_key_groups_by_type_but_not_for_embedded_icons() {        // 文件夹：所有路径共用一个键（图标与具体文件夹无关）
        assert_eq!(icon_cache_key(true, "C:/a"), "dir");
        assert_eq!(icon_cache_key(true, "C:/b"), "dir");
        // 普通文件：按小写扩展名分组，路径与大小写都不参与
        assert_eq!(icon_cache_key(false, "C:/a/报告.DOCX"), "ext:docx");
        assert_eq!(icon_cache_key(false, "C:/b/other.docx"), "ext:docx");
        assert_eq!(icon_cache_key(false, "C:/a/noext"), "ext:");
        // 图标内嵌在文件里的类型：必须按完整路径（否则所有 exe 共用第一个的图标）
        assert_ne!(
            icon_cache_key(false, "C:/a/one.exe"),
            icon_cache_key(false, "C:/b/two.exe")
        );
        // Windows 路径大小写不敏感：同一文件的不同写法要命中同一键
        assert_eq!(
            icon_cache_key(false, "C:/A/App.EXE"),
            icon_cache_key(false, "c:\\a\\app.exe")
        );
    }

    /// 端到端验证 HICON → RGBA → PNG 这条链路真的能出图。
    ///
    /// 先试**真实存在的临时文件**（走主查询路径，拿的是该文件自己的图标）；
    /// 不存在的路径走 SHGFI_USEFILEATTRIBUTES 兜底，只验证「类型默认图标」
    /// 也能拿到——这正是 Word 文档显示 Word 图标这条需求的核心路径，
    /// 且不依赖机器上真的装了 Office。
    #[cfg(windows)]
    #[test]
    fn file_icon_png_renders_for_known_extension() {
        const MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";

        // 1. 真实文件：主查询路径
        let dir = std::env::temp_dir().join(format!("ms-icon-probe-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let real = dir.join("probe.docx");
        std::fs::write(&real, b"x").unwrap();

        match file_icon_png(real.to_string_lossy().as_ref(), false) {
            Ok(png) => assert_eq!(&png[..8], MAGIC, "真实文件应拿到真 PNG"),
            // 个别环境对 .docx 没有关联程序：主查询失败时也允许兜底路径顶上
            Err(_) => assert!(
                file_icon_png("C:/__my_search_no_such_file__.docx", false).is_ok(),
                "真实文件与类型兜底两条路径都失败才算失败"
            ),
        }

        // 2. 文件夹图标：另一条独立分支
        let dir_png = file_icon_png("C:/__my_search_no_such_dir__", true)
            .expect("文件夹应能取到图标");
        assert_eq!(&dir_png[..8], MAGIC);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// 缓存：同一扩展名的第二个文件不应再走一次 Shell 查询（直接命中缓存）。
    ///
    /// 用**真实存在的临时文件**而不是假路径：假路径要靠
    /// SHGFI_USEFILEATTRIBUTES 兜底，而兜底能否在并发测试里稳定返回图标
    /// 取决于当次 shell 查询的成败——那是被测代码之外的变量。真实文件
    /// 走主查询路径，稳定且仍能验证「按扩展名共享缓存」这一语义。
    #[cfg(windows)]
    #[test]
    fn icon_cache_serves_repeat_requests() {
        use std::io::Write;

        let dir = std::env::temp_dir().join(format!("ms-icon-cache-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut f = std::fs::File::create(dir.join("a.docx")).unwrap();
        f.write_all(b"x").unwrap();
        drop(f);

        let first = dir.join("a.docx");
        let second = dir.join("sub").join("b.docx");
        std::fs::create_dir_all(second.parent().unwrap()).unwrap();
        std::fs::write(&second, b"y").unwrap();

        let a = file_icon_data_url(first.to_string_lossy().as_ref(), false);
        let b = file_icon_data_url(second.to_string_lossy().as_ref(), false);
        assert!(a.is_some(), "首个 .docx 应能取到图标");
        assert_eq!(a, b, "同扩展名应命中同一缓存条目");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn preview_ext_whitelist_covers_frontend_list() {
        // 与前端 attachments.ts 的 PREVIEW_IMAGE_EXTS 保持一致
        for ext in PREVIEW_IMAGE_EXTS {
            assert!(guess_mime(&format!("x.{ext}")).starts_with("image/") || ext == "svg");
        }
        assert!(!PREVIEW_IMAGE_EXTS.contains(&"txt"));
    }

    /// 便捷构造「不流式」的 walk 上下文（测试用；channel=None → 不推批）。
    fn ctx(limit: usize, gen: Option<u64>) -> WalkCtx<'static> {
        WalkCtx {
            out: Vec::new(),
            limit,
            gen,
            channel: None,
            sent: 0,
            batch: WALK_BATCH,
        }
    }

    #[test]
    fn walk_cancel_by_gen_returns_partial_ok() {
        let dir = std::env::temp_dir().join(format!("ms-att-cancel-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), b"x").unwrap();

        // 本轮 gen 已取消：入口即停，Ok 返回且一个都没收集
        CANCELLED_GEN.store(424_242, Ordering::Relaxed);
        let mut c = ctx(1000, Some(424_242));
        walk(&dir, "", 0, &mut c).unwrap();
        assert!(c.out.is_empty());

        // 新一轮 gen 不受影响：正常列举
        let mut c2 = ctx(1000, Some(424_243));
        walk(&dir, "", 0, &mut c2).unwrap();
        assert_eq!(c2.out.len(), 1);

        // 不带 gen 的调用方永不被取消
        let mut c3 = ctx(1000, None);
        walk(&dir, "", 0, &mut c3).unwrap();
        assert_eq!(c3.out.len(), 1);

        CANCELLED_GEN.store(u64::MAX, Ordering::Relaxed);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// `limit = usize::MAX`（前端「一直搜索」）不应截断：目录里有 5 个文件
    /// 就收集 5 个，而不是被某个默认上限卡住。
    #[test]
    fn walk_without_limit_collects_everything() {
        let dir = std::env::temp_dir().join(format!("ms-att-nolimit-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        for i in 0..5 {
            std::fs::write(dir.join(format!("f{i}.txt")), b"x").unwrap();
        }
        std::fs::write(dir.join("sub").join("nested.txt"), b"y").unwrap();

        let mut c = ctx(usize::MAX, None);
        walk(&dir, "", 0, &mut c).unwrap();
        // 根下 5 个文件 + 1 个 sub 目录 + sub 内 1 个文件 = 7
        assert_eq!(c.out.len(), 7, "不限条数应收集全部（含子目录与其中文件）");

        // 显式上限仍然生效（旧调用方传 limit）
        let mut c2 = ctx(2, None);
        walk(&dir, "", 0, &mut c2).unwrap();
        assert_eq!(c2.out.len(), 2, "有上限时应在上限处停止");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// 批量流式：批次阈值调小，验证 flush 把 `out` 按批推送、`sent` 游标推进，
    /// 且**不重复**推送（合并所有批次 == 完整结果）。
    #[test]
    fn walk_streams_batches_without_duplication() {
        use std::sync::Mutex as StdMutex;
        // 用 Channel::new 造一个「本地」通道，回调把收到的批存进共享 Vec。
        let seen: std::sync::Arc<StdMutex<Vec<AttachmentDirEntry>>> =
            std::sync::Arc::new(StdMutex::new(Vec::new()));
        let sink = seen.clone();
        let ch: Channel<Vec<AttachmentDirEntry>> = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(js) = body {
                let batch: Vec<AttachmentDirEntry> = serde_json::from_str(&js).unwrap();
                sink.lock().unwrap().extend(batch);
            }
            Ok(())
        });

        let dir = std::env::temp_dir().join(format!("ms-att-stream-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..5 {
            std::fs::write(dir.join(format!("f{i}.txt")), b"x").unwrap();
        }

        let mut c = WalkCtx {
            out: Vec::new(),
            limit: usize::MAX,
            gen: None,
            channel: Some(&ch),
            sent: 0,
            batch: 2, // 每 2 条推一批：5 条 → 批 2/2/…，收尾 flush 推尾巴 1 条
        };
        walk(&dir, "", 0, &mut c).unwrap();
        c.flush();
        assert_eq!(c.sent, c.out.len(), "收尾后应全部推完");
        let got = seen.lock().unwrap().clone();
        assert_eq!(got.len(), c.out.len(), "推送总数应等于完整结果数（无重复无遗漏）");

        std::fs::remove_dir_all(&dir).ok();
    }
}
