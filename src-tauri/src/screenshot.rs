//! 截图能力：抓屏、全屏框选遮罩窗口、剪贴板写图、插件截图落盘与读回。
//!
//! ## 为什么这部分必须在宿主里做
//!
//! 插件详情视图跑在搜索窗的 WebView 里（`contributes.detailView.mode` 只允许
//! `inlay`），它既拿不到**整屏像素**（WebView 没有 `getDisplayMedia`，宿主也
//! 没开 `asset:` 协议），也无法创建**全屏遮罩窗口**（`ms.ui.openWindow` 至今
//! 未实现）。所以「框选 + 标注」这条链路只能由宿主提供：
//!
//! 1. 宿主抓一张**整屏（虚拟桌面）**位图，作为遮罩的冻结底图；
//! 2. 每个显示器开一个**透明全屏窗口**（`overlay-<i>`），页面上把冻结底图
//!    铺满、压一层半透明黑、再挖出选区高亮，并叠一个标注工具条；
//! 3. 用户确认后，遮罩页把「裁切 + 标注」后的 PNG data URL 交回来（`commit`），
//!    宿主据此写剪贴板 / 落盘。
//!
//! 抓屏本身不依赖 WebView，所以**即使遮罩窗口因平台原因不可用**，
//! `screenshot_capture` 仍能独立工作——插件后台进程也有一条等价的
//! PowerShell 兜底路径（见 `plugins/screenshot/backend/`）。
//!
//! ## 多屏与 DPI
//!
//! 混合 DPI 下**不能**用一个横跨所有显示器的大窗口（一个窗口只有一个
//! scale factor，非主屏会被拉伸）。因此这里**每屏一个窗口**，各自用
//! `PhysicalPosition/PhysicalSize` 摆放，并在抓屏时按显示器在虚拟桌面里的
//! 物理矩形裁出该屏那一块作为底图。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt as _;

use crate::plugin_host;

/// 遮罩窗口 label 前缀（对应 capabilities 里的 `overlay-*`）
pub const OVERLAY_LABEL_PREFIX: &str = "overlay-";

/// 遮罩确认「已保存」后广播给前端的事件名
pub const EVENT_SCREENSHOT_SAVED: &str = "my-search://screenshot-saved";

/// 一次抓屏的最大边长（防呆：超宽虚拟桌面时避免爆内存）。
/// 8K×2 已经远超任何真实桌面，正常不会触发。
const MAX_CAPTURE_EDGE: i32 = 16384;

/// 抓屏结果的私有目录名（在插件私有数据目录下）
const SHOTS_DIR: &str = "shots";

/// 图片扩展名白名单（读回时校验，防止把目录里其它文件当图片读）
const IMAGE_EXTS: [&str; 4] = ["png", "jpg", "jpeg", "webp"];

/// 单张截图读回上限（100 MB，与附件读取保持一致口径）
const MAX_SHOT_BYTES: u64 = 100 * 1024 * 1024;

// ===================== 抓屏 =====================

/// 一张抓到的整屏位图（RGBA8，行优先，无 padding）
#[derive(Clone)]
pub struct CapturedFrame {
    /// 虚拟桌面物理坐标下的原点（可能为负，多屏主屏在右时）
    pub origin_x: i32,
    pub origin_y: i32,
    pub width: u32,
    pub height: u32,
    /// 每屏的物理矩形，供遮罩按屏裁底图
    pub monitors: Vec<MonitorRect>,
    /// RGBA 像素（宽度*高度*4）
    pub rgba: Vec<u8>,
}

/// 单个显示器在虚拟桌面里的物理矩形
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorRect {
    pub index: usize,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
    pub is_primary: bool,
}

/// 进程内「最近一次抓屏」的缓存：遮罩页按屏取底图时用。
///
/// 只保留最近一次：截图是「按一次热键 → 用一次」的短生命周期操作，
/// 多留会白占内存（一张 4K RGBA 就 ~33 MB）。
static PENDING_CAPTURE: Mutex<Option<CapturedFrame>> = Mutex::new(None);

/// 抓取**整个虚拟桌面**（所有显示器拼起来的包围盒）。
#[cfg(windows)]
fn capture_virtual_screen() -> Result<(i32, i32, u32, u32, Vec<u8>), String> {
    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        SRCCOPY,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN,
    };

    unsafe {
        let x = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let y = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let w = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let h = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        if w <= 0 || h <= 0 {
            return Err(err("取虚拟桌面尺寸失败（系统返回 0）"));
        }
        if w > MAX_CAPTURE_EDGE || h > MAX_CAPTURE_EDGE {
            return Err(err(&format!("虚拟桌面过大（{w}x{h}），超出抓屏上限")));
        }

        let screen_dc = GetDC(std::ptr::null_mut());
        if screen_dc.is_null() {
            return Err(err("获取屏幕 DC 失败"));
        }
        let mem_dc = CreateCompatibleDC(screen_dc);
        if mem_dc.is_null() {
            ReleaseDC(std::ptr::null_mut(), screen_dc);
            return Err(err("创建内存 DC 失败"));
        }
        let bmp = CreateCompatibleBitmap(screen_dc, w, h);
        if bmp.is_null() {
            DeleteDC(mem_dc);
            ReleaseDC(std::ptr::null_mut(), screen_dc);
            return Err(err("创建位图失败"));
        }
        let old = SelectObject(mem_dc, bmp);

        // 从虚拟桌面左上角整块拷（x/y 可能为负，正是虚拟桌面坐标）
        let blit_ok = BitBlt(mem_dc, 0, 0, w, h, screen_dc, x, y, SRCCOPY);
        if blit_ok == 0 {
            SelectObject(mem_dc, old);
            DeleteObject(bmp);
            DeleteDC(mem_dc);
            ReleaseDC(std::ptr::null_mut(), screen_dc);
            return Err(err("BitBlt 抓屏失败"));
        }

        // 取像素：请求 32 位、**自顶向下**（负高度），拿到的就是 RGBA 顺序
        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = w;
        info.bmiHeader.biHeight = -h; // 负 = top-down
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB as u32;

        let mut buf = vec![0u8; (w as usize) * (h as usize) * 4];
        let lines = GetDIBits(
            mem_dc,
            bmp,
            0,
            h as u32,
            buf.as_mut_ptr() as *mut _,
            &mut info,
            DIB_RGB_COLORS,
        );

        SelectObject(mem_dc, old);
        DeleteObject(bmp);
        DeleteDC(mem_dc);
        ReleaseDC(std::ptr::null_mut(), screen_dc);

        if lines == 0 {
            return Err(err("GetDIBits 取像素失败"));
        }

        // BITMAPINFO 给的是 BGRA，且 A 位通常为 0；统一转成 RGBA 并补 A=255。
        for px in buf.chunks_exact_mut(4) {
            let b = px[0];
            let g = px[1];
            let r = px[2];
            px[0] = r;
            px[1] = g;
            px[2] = b;
            px[3] = 255;
        }

        Ok((x, y, w as u32, h as u32, buf))
    }
}

/// 非 Windows：留一个明确的「未实现」而不是悄悄失败。
#[cfg(not(windows))]
fn capture_virtual_screen() -> Result<(i32, i32, u32, u32, Vec<u8>), String> {
    Err(err(
        "当前平台尚未内置抓屏实现（Windows 已支持；其它平台请用插件后台进程的兜底路径）",
    ))
}

/// 读显示器列表（含物理矩形与缩放），供遮罩选址与抓屏裁切。
fn list_monitors(app: &tauri::AppHandle) -> Vec<MonitorRect> {
    let primary = app.primary_monitor().ok().flatten();
    let primary_name = primary.as_ref().and_then(|m| m.name().map(|s| s.to_string()));
    let mut out: Vec<MonitorRect> = app
        .available_monitors()
        .unwrap_or_default()
        .into_iter()
        .enumerate()
        .map(|(i, m)| {
            let pos = m.position();
            let size = m.size();
            let name = m.name().map(|s| s.to_string());
            MonitorRect {
                index: i,
                x: pos.x,
                y: pos.y,
                width: size.width,
                height: size.height,
                scale_factor: m.scale_factor(),
                is_primary: match (&primary_name, &name) {
                    (Some(a), Some(b)) => a == b,
                    _ => i == 0,
                },
            }
        })
        .collect();
    out.sort_by_key(|m| m.x);
    for (i, m) in out.iter_mut().enumerate() {
        m.index = i;
    }
    out
}

/// 等桌面合成器把「刚发生的窗口变化」真正画到屏幕上。
///
/// **为什么必须等**：`window.hide()` 只是发出请求，Windows 的合成器（DWM）是异步
/// 生效的——`hide()` 返回时那扇窗还留在屏幕上，此刻立刻 `BitBlt` 就会把它的残影
/// 拍进冻结底图。真实踩到过：截图底图上叠着一块搜索框（用户描述为「位置偏移、
/// 看着不太自然」）。
///
/// `DwmFlush` 会阻塞到下一帧合成完成，正是我们要的「等它撤下去」。调用两次是
/// 为了跨过两帧：一次可能仍落在「hide 尚未被合成」的那一帧上。非 Windows 或
/// DWM 未启用（老系统 / 远程桌面）时它返回错误，忽略即可——此时本就没有合成
/// 延迟问题，或延迟由后续的 `std::thread::sleep` 兜底。
/// 分段计时日志：设 `MS_DEBUG_TIMING=1` 时把各阶段耗时打到 stderr。
/// 「按热键卡一下」这类问题只能靠真实分段耗时定位，拍脑袋优化过一次（整屏
/// PNG 编码 1.1s），这个 helper 就是防止下次再盲猜。
fn tlog(phase: &str, started: Instant) {
    if std::env::var_os("MS_DEBUG_TIMING").is_some() {
        eprintln!("[截图计时] {phase}: {}ms", started.elapsed().as_millis());
    }
}

fn settle_desktop() {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Graphics::Dwm::DwmFlush;
        // 每帧最多等这么多次；DwmFlush 在合成暂停时会立刻返回错误，不会死等
        for _ in 0..2 {
            unsafe {
                let _ = DwmFlush();
            }
        }
        // 兜底：合成器被禁用（DwmFlush 立刻失败）时，给窗口一点时间真正撤下去。
        // 30ms 远小于人能感知的「卡顿」，但足够覆盖无合成器时的异步窗口更新。
        std::thread::sleep(std::time::Duration::from_millis(30));
    }
}

/// BitBlt 屏幕上的一小块矩形（BGRA，未做通道交换——只用于同源前后对比，
/// 通道序无所谓）。整屏抓一次 ≈450ms，而条带级采样是微秒级，
/// 可以在 hide 之后高频轮询「窗口像素撤下去没有」。
#[cfg(windows)]
fn probe_region(x: i32, y: i32, w: i32, h: i32) -> Option<Vec<u8>> {
    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
        DIB_RGB_COLORS, SRCCOPY,
    };
    if w <= 0 || h <= 0 {
        return None;
    }
    unsafe {
        let screen_dc = GetDC(std::ptr::null_mut());
        if screen_dc.is_null() {
            return None;
        }
        let mem_dc = CreateCompatibleDC(screen_dc);
        if mem_dc.is_null() {
            ReleaseDC(std::ptr::null_mut(), screen_dc);
            return None;
        }
        let bmp = CreateCompatibleBitmap(screen_dc, w, h);
        if bmp.is_null() {
            DeleteDC(mem_dc);
            ReleaseDC(std::ptr::null_mut(), screen_dc);
            return None;
        }
        let old = SelectObject(mem_dc, bmp);
        let blit_ok = BitBlt(mem_dc, 0, 0, w, h, screen_dc, x, y, SRCCOPY);
        let mut out = None;
        if blit_ok != 0 {
            let mut info: BITMAPINFO = std::mem::zeroed();
            info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
            info.bmiHeader.biWidth = w;
            info.bmiHeader.biHeight = -h; // 负 = 自顶向下
            info.bmiHeader.biPlanes = 1;
            info.bmiHeader.biBitCount = 32;
            info.bmiHeader.biCompression = BI_RGB as u32;
            let mut buf = vec![0u8; (w as usize) * (h as usize) * 4];
            let lines = GetDIBits(
                mem_dc,
                bmp,
                0,
                h as u32,
                buf.as_mut_ptr() as *mut _,
                &mut info,
                DIB_RGB_COLORS,
            );
            if lines != 0 {
                out = Some(buf);
            }
        }
        SelectObject(mem_dc, old);
        DeleteObject(bmp);
        DeleteDC(mem_dc);
        ReleaseDC(std::ptr::null_mut(), screen_dc);
        out
    }
}

#[cfg(not(windows))]
fn probe_region(_x: i32, _y: i32, _w: i32, _h: i32) -> Option<Vec<u8>> {
    None
}

/// 主窗隐藏**前**的条带快照 + 其矩形（hide 后用来判断残影何时消失）。
#[cfg_attr(not(windows), allow(dead_code))]
struct HiddenStrip {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    before: Vec<u8>,
}

/// 两个同尺寸条带的差异是否超过 1% 像素。
///
/// 量过：窗口残影 ≈2.3 万像素（占条带 2.4%），而个别像素抖动/光标闪烁
/// 远低于 1% 阈值——既灵敏又不误触发。
fn strip_changed(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() || a.is_empty() {
        return false;
    }
    let pixels = a.len() / 4;
    let mut n = 0usize;
    for (pa, pb) in a.chunks_exact(4).zip(b.chunks_exact(4)) {
        if pa[0].abs_diff(pb[0]) > 4
            || pa[1].abs_diff(pb[1]) > 4
            || pa[2].abs_diff(pb[2]) > 4
        {
            n += 1;
            if n > pixels / 100 {
                return true;
            }
        }
    }
    false
}

/// 隐藏主窗后**按内容确认**合成器已落地，而不是赌固定时长。
///
/// 为什么固定等待不够：真机时间线（test/_diag-hide.mjs）显示 hide 本身 25ms 内
/// 生效，但 GDI 屏幕 DC 上要 ~72ms 才干净；而生产路径在 hide 前还有一次
/// 异步 resize（collapse），把残影窗口推得更靠后——固定 60–90ms 的 DwmFlush
/// 正好落在竞赛窗口里，抓屏会拍到「我的搜索」残影（全分辨率底图上肉眼可见）。
///
/// 做法：刷一帧 → 采样主窗条带 → 与隐藏前对比；**连续两轮**都变化超 1% 才认账
/// （单帧可能是过渡态）。通常 2–3 帧（≈30–60ms）返回，与旧的固定等待同量级，
/// 但结果确定。超时（~400ms）或探测不可用（无 DWM / 非 Windows）时退回
/// `settle_desktop` 的固定等待，最坏与旧行为一致。
fn settle_after_hide(strip: Option<&HiddenStrip>) {
    let Some(s) = strip else {
        settle_desktop();
        return;
    };
    #[cfg(windows)]
    {
        use windows_sys::Win32::Graphics::Dwm::DwmFlush;
        let deadline = Instant::now() + Duration::from_millis(400);
        let mut changed_rounds = 0u32;
        while Instant::now() < deadline {
            unsafe {
                let _ = DwmFlush();
            }
            let Some(cur) = probe_region(s.x, s.y, s.w, s.h) else {
                break; // 探测失败 → 下面退回固定等待
            };
            if strip_changed(&s.before, &cur) {
                changed_rounds += 1;
                if changed_rounds >= 2 {
                    return;
                }
            } else {
                changed_rounds = 0;
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = s;
    }
    settle_desktop();
}

/// 抓屏并缓存（不清空遮罩窗口）。
///
/// 调用方若刚隐藏过窗口，应先 `settle_desktop()` 再调本函数（见其说明）。
pub fn grab_screen(app: &tauri::AppHandle) -> Result<CapturedFrame, String> {
    let (x, y, w, h, rgba) = capture_virtual_screen()?;
    let expect = (w as usize) * (h as usize) * 4;
    if rgba.len() != expect {
        return Err(err("抓屏数据长度异常"));
    }
    let frame = CapturedFrame {
        origin_x: x,
        origin_y: y,
        width: w,
        height: h,
        monitors: list_monitors(app),
        rgba,
    };
    *PENDING_CAPTURE.lock().map_err(|_| err("抓屏缓存被占用"))? = Some(frame.clone());
    Ok(frame)
}

/// 复制一份当前缓存的抓屏（遮罩页取底图用）。
fn pending_capture() -> Result<CapturedFrame, String> {
    PENDING_CAPTURE
        .lock()
        .map_err(|_| err("抓屏缓存被占用"))?
        .clone()
        .ok_or_else(|| err("没有可用的抓屏（请先触发截图）"))
}

/// 从整屏 RGBA 里裁一块（逻辑像素坐标 → 物理像素，钳制在帧内）。
fn crop_rgba(frame: &CapturedFrame, rect: (f64, f64, f64, f64)) -> Result<(u32, u32, Vec<u8>), String> {
    let (x, y, w, h) = rect;
    let x0 = x.round().max(0.0) as u32;
    let y0 = y.round().max(0.0) as u32;
    let x1 = ((x + w).round().max(0.0) as u32).min(frame.width);
    let y1 = ((y + h).round().max(0.0) as u32).min(frame.height);
    if x1 <= x0 || y1 <= y0 {
        return Err(err("选区为空"));
    }
    let cw = x1 - x0;
    let ch = y1 - y0;
    let mut out = Vec::with_capacity((cw as usize) * (ch as usize) * 4);
    for row in 0..ch {
        let start = (((y0 + row) as usize) * (frame.width as usize) + (x0 as usize)) * 4;
        out.extend_from_slice(&frame.rgba[start..start + (cw as usize) * 4]);
    }
    Ok((cw, ch, out))
}

// ===================== PNG 编解码（复用仓库既有的 png 0.17） =====================

/// 编码 PNG。`compression` 只影响**速度与体积**，不影响画质（PNG 是无损的）。
///
/// 交互路径（遮罩底图 / 选区裁片）用 `Fast`：默认压缩级别在 2560×1440 上要
/// ~1 秒，是「按热键卡一下」的主因；`Fast` 约快一倍，代价只是文件大一些——
/// 而这些数据走的是本机 IPC，不进磁盘。
fn encode_png_with(
    width: u32,
    height: u32,
    rgba: &[u8],
    compression: png::Compression,
) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, width, height);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(compression);
        let mut writer = enc
            .write_header()
            .map_err(|e| err(&format!("PNG 头写入失败: {e}")))?;
        writer
            .write_image_data(rgba)
            .map_err(|e| err(&format!("PNG 数据写入失败: {e}")))?;
    }
    Ok(out)
}

/// 默认压缩（体积优先）：用于**会落盘**的图（用户保存的截图）。
///
/// `pub(crate)`：剪贴板历史模块把 CF_DIB 转成 RGBA 后落盘 PNG 也用它，
/// 避免两处各写一份 PNG 编码（见 `clipboard_history.rs`）。
pub(crate) fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    encode_png_with(width, height, rgba, png::Compression::Default)
}

/// 快速压缩（速度优先）：用于遮罩底图等只在本机 IPC 里传一次的交互数据。
fn encode_png_fast(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    encode_png_with(width, height, rgba, png::Compression::Fast)
}

/// 把任意 PNG 归一化成 RGBA8。
///
/// `pub(crate)`：剪贴板历史模块「复制图片」时先把落盘 PNG 解成 RGBA，
/// 再交给 `write_png_to_clipboard`。
pub(crate) fn decode_png(bytes: &[u8]) -> Result<(u32, u32, Vec<u8>), String> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    // 统一展开成 RGBA8，省得调用方自己判位深/调色板
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder
        .read_info()
        .map_err(|e| err(&format!("PNG 解析失败: {e}")))?;
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader
        .next_frame(&mut buf)
        .map_err(|e| err(&format!("PNG 解码失败: {e}")))?;
    let (w, h) = (info.width, info.height);
    buf.truncate(info.buffer_size());

    // normalize_to_color8 后可能是 RGB（3 通道），统一补成 RGBA
    let rgba = match info.color_type {
        png::ColorType::Rgba => buf,
        png::ColorType::Rgb => {
            let mut v = Vec::with_capacity((w as usize) * (h as usize) * 4);
            for px in buf.chunks_exact(3) {
                v.extend_from_slice(&[px[0], px[1], px[2], 255]);
            }
            v
        }
        png::ColorType::Grayscale => {
            let mut v = Vec::with_capacity((w as usize) * (h as usize) * 4);
            for g in buf.iter() {
                v.extend_from_slice(&[*g, *g, *g, 255]);
            }
            v
        }
        png::ColorType::GrayscaleAlpha => {
            let mut v = Vec::with_capacity((w as usize) * (h as usize) * 4);
            for px in buf.chunks_exact(2) {
                v.extend_from_slice(&[px[0], px[0], px[0], px[1]]);
            }
            v
        }
        other => return Err(err(&format!("不支持的 PNG 颜色类型: {other:?}"))),
    };
    Ok((w, h, rgba))
}

/// 解析 `data:image/png;base64,....`（也接受纯 base64）
fn parse_data_url(data: &str) -> Result<Vec<u8>, String> {
    let raw = data.trim();
    let b64 = match raw.split_once(",") {
        Some((head, tail)) if head.starts_with("data:") => tail,
        _ => raw,
    };
    base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| err(&format!("图片 base64 解析失败: {e}")))
}

// ===================== 剪贴板 =====================

/// 把 RGBA8 像素写进系统剪贴板（CF_DIB）。
///
/// 从 `set_clipboard_png` 抽出：剪贴板历史插件「复制这张图」时手里已有
/// RGBA（从落盘 PNG 解码而来），无需再编码成 PNG 再解回来，直接写更省。
/// 这是**用户显式触发**的写剪贴板路径（`EmptyClipboard` + `SetClipboardData`）。
#[cfg(windows)]
pub(crate) fn write_png_to_clipboard(w: u32, h: u32, rgba: &[u8]) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{HANDLE, HGLOBAL};
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows_sys::Win32::System::Ole::CF_DIB;

    if w == 0 || h == 0 {
        return Err(err("图片尺寸为空"));
    }

    // CF_DIB 要求 32 位、**自底向上**（正高度）的 BGRA，且每行 4 字节对齐，
    // 并在像素数据后可选地跟 3 个 DWORD 掩码（BI_BITFIELDS）。这里用
    // BI_RGB + 32bpp：Windows 会按 32 位读，alpha 通道被多数应用忽略，
    // 但像素颜色是准确的（截图不透明，够用）。
    let row_bytes = (w as usize) * 4;
    let pixel_bytes = row_bytes * (h as usize);
    let header = 40usize; // BITMAPINFOHEADER
    let total = header + pixel_bytes;

    unsafe {
        let handle = GlobalAlloc(GMEM_MOVEABLE, total);
        if handle.is_null() {
            return Err(err("分配剪贴板内存失败"));
        }
        let ptr = GlobalLock(handle);
        if ptr.is_null() {
            return Err(err("锁定剪贴板内存失败"));
        }
        let dst = ptr as *mut u8;

        // BITMAPINFOHEADER
        let put_u32 = |off: usize, v: u32| {
            std::ptr::copy_nonoverlapping(v.to_le_bytes().as_ptr(), dst.add(off), 4);
        };
        let put_i32 = |off: usize, v: i32| {
            std::ptr::copy_nonoverlapping(v.to_le_bytes().as_ptr(), dst.add(off), 4);
        };
        let put_u16 = |off: usize, v: u16| {
            std::ptr::copy_nonoverlapping(v.to_le_bytes().as_ptr(), dst.add(off), 2);
        };
        put_u32(0, header as u32); // biSize
        put_i32(4, w as i32); // biWidth（正）
        put_i32(8, h as i32); // biHeight（正 = 自底向上）
        put_u16(12, 1); // biPlanes
        put_u16(14, 32); // biBitCount
        put_u32(16, 0); // biCompression = BI_RGB
        put_u32(20, pixel_bytes as u32); // biSizeImage
        put_i32(24, 0); // biXPelsPerMeter
        put_i32(28, 0); // biYPelsPerMeter
        put_u32(32, 0); // biClrUsed
        put_u32(36, 0); // biClrImportant

        // 像素：RGBA（top-down）→ BGRA（bottom-up）
        for row in 0..(h as usize) {
            let src_row = row;
            let dst_row = (h as usize) - 1 - row;
            let src = &rgba[src_row * row_bytes..(src_row + 1) * row_bytes];
            let d = dst.add(header + dst_row * row_bytes);
            for col in 0..(w as usize) {
                let s = &src[col * 4..col * 4 + 4];
                *d.add(col * 4) = s[2]; // B
                *d.add(col * 4 + 1) = s[1]; // G
                *d.add(col * 4 + 2) = s[0]; // R
                *d.add(col * 4 + 3) = 255; // A
            }
        }
        GlobalUnlock(handle);

        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return Err(err("打开剪贴板失败（可能被其它程序占用）"));
        }
        if EmptyClipboard() == 0 {
            CloseClipboard();
            return Err(err("清空剪贴板失败"));
        }
        // 成功后所有权归系统，不能再 free
        let placed = SetClipboardData(CF_DIB as u32, HANDLE::from(handle as HGLOBAL as *mut _));
        CloseClipboard();
        if placed.is_null() {
            return Err(err("写入剪贴板失败"));
        }
        Ok(())
    }
}

#[cfg(not(windows))]
pub(crate) fn write_png_to_clipboard(_w: u32, _h: u32, _rgba: &[u8]) -> Result<(), String> {
    Err(err("当前平台尚未内置剪贴板写图实现"))
}

/// 把一段 UTF-16 文本写进系统剪贴板（CF_UNICODETEXT）。
///
/// 剪贴板历史插件「复制这条文本」用。同样是**用户显式触发**的写入，
/// 会 `EmptyClipboard` 后用 `SetClipboardData` 放上新内容。
#[cfg(windows)]
pub(crate) fn write_text_to_clipboard(text: &str) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{HANDLE, HGLOBAL};
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows_sys::Win32::System::Ole::CF_UNICODETEXT;

    // UTF-16 + 结尾 NUL
    let mut units: Vec<u16> = text.encode_utf16().collect();
    units.push(0);
    let bytes = units.len() * 2;

    unsafe {
        let handle = GlobalAlloc(GMEM_MOVEABLE, bytes);
        if handle.is_null() {
            return Err(err("分配剪贴板内存失败"));
        }
        let ptr = GlobalLock(handle);
        if ptr.is_null() {
            return Err(err("锁定剪贴板内存失败"));
        }
        std::ptr::copy_nonoverlapping(units.as_ptr() as *const u8, ptr as *mut u8, bytes);
        GlobalUnlock(handle);

        if OpenClipboard(std::ptr::null_mut()) == 0 {
            // 未成功放进剪贴板，自己分配的内存要释放
            return Err(err("打开剪贴板失败（可能被其它程序占用）"));
        }
        if EmptyClipboard() == 0 {
            CloseClipboard();
            return Err(err("清空剪贴板失败"));
        }
        // 成功后所有权归系统，不能再 free
        let placed = SetClipboardData(CF_UNICODETEXT as u32, HANDLE::from(handle as HGLOBAL as *mut _));
        CloseClipboard();
        if placed.is_null() {
            return Err(err("写入剪贴板失败"));
        }
        Ok(())
    }
}

#[cfg(not(windows))]
pub(crate) fn write_text_to_clipboard(_text: &str) -> Result<(), String> {
    Err(err("当前平台尚未内置剪贴板写文本实现"))
}

/// 把 PNG 字节写进系统剪贴板（解码 → `write_png_to_clipboard`）。
#[cfg(windows)]
fn set_clipboard_png(png_bytes: &[u8]) -> Result<(), String> {
    let (w, h, rgba) = decode_png(png_bytes)?;
    write_png_to_clipboard(w, h, &rgba)
}

#[cfg(not(windows))]
fn set_clipboard_png(_png_bytes: &[u8]) -> Result<(), String> {
    Err(err("当前平台尚未内置剪贴板写图实现"))
}

// ===================== 插件截图目录 =====================

/// 插件截图目录：`<app_data>/plugin-data/<id>/shots`
fn shots_dir(app: &tauri::AppHandle, plugin_id: &str) -> Result<std::path::PathBuf, String> {
    let dir = plugin_host::plugin_data_dir(app, plugin_id)?.join(SHOTS_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| err(&format!("创建截图目录失败: {e}")))?;
    Ok(dir)
}

/// 校验一个截图相对路径（防目录穿越）。只允许 `shots/` 下的图片文件。
fn safe_shot_path(app: &tauri::AppHandle, plugin_id: &str, rel: &str) -> Result<std::path::PathBuf, String> {
    if !plugin_host::is_safe_relative(rel) {
        return Err(err(&format!("非法截图路径: {rel}")));
    }
    let normalized = rel.replace('\\', "/");
    let rest = normalized
        .strip_prefix("shots/")
        .ok_or_else(|| err("截图路径必须以 shots/ 开头"))?;
    // 只允许平铺文件名，不许再有子目录
    if rest.is_empty() || rest.contains('/') {
        return Err(err("截图路径非法"));
    }
    let name = rest.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase());
    let ext_ok = name
        .as_deref()
        .map(|e| IMAGE_EXTS.contains(&e))
        .unwrap_or(false);
    if !ext_ok {
        return Err(err("只允许读取图片文件（png/jpg/jpeg/webp）"));
    }
    Ok(shots_dir(app, plugin_id)?.join(rest))
}

/// 单调递增序号：同一毫秒内的多次截图靠它区分。
/// （只用时间戳会撞名——连按热键/脚本连拍很容易落在同一毫秒。）
static SHOT_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 由「时间戳 + 单调序号」生成一个不冲突的截图文件名。
fn new_shot_name() -> String {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let seq = SHOT_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("shot-{ts}-{seq:04x}.png")
}

/// 一条截图索引记录（返回给前端画廊）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShotEntry {

    /// 相对插件数据目录的路径（读回时原样传回来）
    pub rel_path: String,
    /// 文件名
    pub name: String,
    /// 字节数
    pub size: u64,
    /// 修改时间（毫秒时间戳）
    pub mtime_ms: u64,
    /// 展示用时间（ISO8601，本地时区按 UTC 偏移换算）
    pub created_at: String,
}

/// 扫描插件截图目录，按修改时间**从新到旧**返回。
fn scan_shots(app: &tauri::AppHandle, plugin_id: &str) -> Result<Vec<ShotEntry>, String> {
    let dir = shots_dir(app, plugin_id)?;
    let mut out = Vec::new();
    let read = std::fs::read_dir(&dir).map_err(|e| err(&format!("读取截图目录失败: {e}")))?;
    for entry in read.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = match path.file_name().and_then(|s| s.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        let ext_ok = name
            .rsplit_once('.')
            .map(|(_, e)| IMAGE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
            .unwrap_or(false);
        if !ext_ok {
            continue;
        }
        let md = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let mtime_ms = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(ShotEntry {
            rel_path: format!("{SHOTS_DIR}/{name}"),
            name,
            size: md.len(),
            mtime_ms,
            created_at: iso_from_ms(mtime_ms),
        });
    }
    out.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    Ok(out)
}

/// 毫秒时间戳 → `YYYY-MM-DDTHH:MM:SSZ`（UTC，前端自己按本地时区显示）。
fn iso_from_ms(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    let (y, mo, d, h, mi, s) = civil_from_unix(secs);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

/// 民用历换算（Howard Hinnant 的 days_from_civil 逆运算）
fn civil_from_unix(secs: i64) -> (i64, u32, u32, u32, u32, u32) {
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = if m <= 2 { y + 1 } else { y };
    (
        year,
        m,
        d,
        (rem / 3600) as u32,
        ((rem % 3600) / 60) as u32,
        (rem % 60) as u32,
    )
}

// ===================== 命令 =====================

fn err(msg: &str) -> String {
    msg.to_string()
}

/// 全屏（虚拟桌面）抓屏 → PNG data URL。
///
/// 不依赖遮罩窗口，插件后台也能用同一条路径兜底。
#[tauri::command]
pub fn screenshot_capture() -> Result<CaptureResult, String> {
    let (x, y, w, h, rgba) = capture_virtual_screen()?;
    let png = encode_png(w, h, &rgba)?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
    Ok(CaptureResult {
        data_url: format!("data:image/png;base64,{b64}"),
        origin_x: x,
        origin_y: y,
        width: w,
        height: h,
        monitors: Vec::new(),
    })
}

/// 抓屏结果（前端摘要用）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResult {
    pub data_url: String,
    pub origin_x: i32,
    pub origin_y: i32,
    pub width: u32,
    pub height: u32,
    pub monitors: Vec<MonitorRect>,
}

/// 抓屏期间是否把搜索窗收起来了（用于遮罩关闭后**恢复**它）。
///
/// 只记「是本次截图收起来的」：用户本来就把窗口藏着（纯热键使用场景），
/// 截完不该凭空弹出来打扰他。从插件前台点「开始截图」时窗口是显示着的，
/// 截完要还回去，否则用户以为界面崩了。
static MAIN_HIDDEN_FOR_CAPTURE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// 打开全屏框选遮罩（每个显示器一个透明窗口），底图用刚抓的这一帧。
///
/// **先把搜索窗收起来再抓屏**：主窗口是 `alwaysOnTop` 的置顶条，不收起来就有两个
/// 后果——抓屏会把它自己拍进底图，而且它盖在遮罩之上（同样是置顶，但主窗后开），
/// 用户框选时被自己的搜索框挡住。收起的动作必须在这里做而不是只放在热键入口：
/// 插件前台的「开始截图」按钮也走这条命令，两条路径的行为必须一致。
/// （真实踩到过：热键触发正常，从插件前台触发却「画了没反应」——搜索窗挡住遮罩，
/// 鼠标事件全落在搜索窗上。）
async fn hide_main_window_for_capture(app: &tauri::AppHandle) -> Option<HiddenStrip> {
    let main = app.get_webview_window("main")?;
    if !main.is_visible().unwrap_or(false) {
        return None;
    }
    crate::collapse_main_window(&main);
    // 隐藏前先采样主窗条带（此刻窗口还在画面上），hide 后拿它判断残影何时消失
    let strip = match (main.outer_position(), main.outer_size()) {
        (Ok(pos), Ok(size)) => {
            let (x, y) = (pos.x, pos.y);
            let (w, h) = (size.width as i32, size.height as i32);
            probe_region(x, y, w, h).map(|before| HiddenStrip { x, y, w, h, before })
        }
        _ => None,
    };
    let _ = main.hide();
    MAIN_HIDDEN_FOR_CAPTURE.store(true, std::sync::atomic::Ordering::Relaxed);
    strip
}

/// 遮罩关闭后把搜索窗放回来（仅当它是本次截图收起来的）。
fn restore_main_window_after_capture(app: &tauri::AppHandle) {
    if !MAIN_HIDDEN_FOR_CAPTURE.swap(false, std::sync::atomic::Ordering::Relaxed) {
        return;
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
}

/// 诊断用：把「抓屏帧 / 显示器矩形 / 遮罩窗口实际几何」写成一个 JSON 文件。
///
/// 为什么需要它：截图偏移这类问题只在**真实高 DPI 桌面**上复现，而 `cargo test`
/// 跑在另一个进程里（DPI 感知设置不同，量到的屏幕尺寸都不一样），单测量不出真机
/// 行为。设 `MS_DEBUG_OVERLAY_GEOM=1` 后按一次热键，三方口径（抓屏帧、Tauri 报的
/// 显示器、窗口实际物理几何）就会落盘，一眼看出是哪一层换算错了。
///
/// 默认关闭（不设环境变量时只多一次 `var_os` 查询），不影响正常使用。
fn dump_overlay_geometry(app: &tauri::AppHandle, frame: &CapturedFrame) {
    if std::env::var_os("MS_DEBUG_OVERLAY_GEOM").is_none() {
        return;
    }
    let mut wins = Vec::new();
    for (label, win) in app.webview_windows() {
        if !label.starts_with(OVERLAY_LABEL_PREFIX) {
            continue;
        }
        wins.push(serde_json::json!({
            "label": label,
            "innerSize": win.inner_size().ok().map(|s| serde_json::json!([s.width, s.height])),
            "outerSize": win.outer_size().ok().map(|s| serde_json::json!([s.width, s.height])),
            "outerPosition": win.outer_position().ok().map(|p| serde_json::json!([p.x, p.y])),
            "scaleFactor": win.scale_factor().ok(),
        }));
    }
    let doc = serde_json::json!({
        "frame": {
            "originX": frame.origin_x, "originY": frame.origin_y,
            "width": frame.width, "height": frame.height,
        },
        "monitors": frame.monitors,
        "overlayWindows": wins,
    });
    let path = std::env::temp_dir().join("ms-overlay-geom.json");
    match std::fs::write(&path, serde_json::to_string_pretty(&doc).unwrap_or_default()) {
        Ok(()) => eprintln!("[截图] 几何诊断已写入 {}", path.display()),
        Err(e) => eprintln!("[截图] 几何诊断写入失败: {e}"),
    }
}

// ===================== 底图预编码缓存 =====================
//
// 「按热键卡一下」的主因之一：遮罩窗口建好后，页面才发起 `screenshot_overlay_image`，
// 现场编码整屏 PNG（全分辨率 Fast ≈ 数百毫秒）——这段时间遮罩是空的，用户看到
// 桌面停了半秒才「啪」地弹出框选层。改成：抓屏一结束就把**每屏底图**丢到后台
// 线程编码，与「创建遮罩窗口 + 页面加载」并行；页面来取时用 condvar 等缓存，
// 通常命中，最坏也只等编码线程收尾。

/// 预编码缓存：(代次, 显示器 index → (data URL, 物理宽, 物理高))。
/// 代次每次开遮罩 +1；上一次截图迟到的编码线程看到代次不匹配就丢弃结果。
static BASE_PNG_CACHE: Mutex<Option<(u64, HashMap<usize, Result<(String, u32, u32), String>>)>> =
    Mutex::new(None);
static BASE_PNG_CV: Condvar = Condvar::new();
static BASE_PNG_GEN: AtomicU64 = AtomicU64::new(0);

/// 编码「某显示器那一块」底图：物理分辨率原样编码，**不降采样**——
/// 底图按 150% 缩放铺到全屏窗口，降到逻辑尺寸再放大会让截图区外的文字发糊
/// （真实用户反馈「截图区外模糊」的根因）。最终截图仍取自原始帧，与这里无关。
fn encode_overlay_base(frame: &CapturedFrame, m: &MonitorRect) -> Result<(String, u32, u32), String> {
    let t = Instant::now();
    let local_x = (m.x - frame.origin_x).max(0) as f64;
    let local_y = (m.y - frame.origin_y).max(0) as f64;
    let (w, h, rgba) = crop_rgba(frame, (local_x, local_y, m.width as f64, m.height as f64))?;
    let png = encode_png_fast(w, h, &rgba)?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
    tlog(&format!("整屏底图编码（屏 {}，{w}x{h}）", m.index), t);
    Ok((format!("data:image/png;base64,{b64}"), w, h))
}

/// 抓屏后立刻分发每屏底图的编码线程。返回新代次。
fn dispatch_base_encode(frame: &CapturedFrame) -> u64 {
    let gen = BASE_PNG_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    if let Ok(mut guard) = BASE_PNG_CACHE.lock() {
        *guard = Some((gen, HashMap::new()));
    }
    for m in frame.monitors.clone() {
        let frame = frame.clone();
        std::thread::spawn(move || {
            let r = encode_overlay_base(&frame, &m);
            if let Ok(mut guard) = BASE_PNG_CACHE.lock() {
                if let Some((g, map)) = guard.as_mut() {
                    if *g == gen {
                        map.insert(m.index, r);
                    }
                }
            }
            BASE_PNG_CV.notify_all();
        });
    }
    gen
}

/// 等预编码缓存（最多 2s；超时/未开遮罩/编码失败返回 None，调用方现场编码兜底）。
fn take_cached_base(idx: usize) -> Option<(String, u32, u32)> {
    let deadline = Instant::now() + Duration::from_millis(2000);
    let mut guard = BASE_PNG_CACHE.lock().ok()?;
    loop {
        // 命中 / 失败都在这个只读块里出结果；「还没写入」只留到块外再等，
        // 免得 match 的借用横跨 wait_timeout 对 guard 的移动（借用检查不过）。
        {
            let (_gen, map) = guard.as_ref()?; // 缓存根本没初始化 → 现场编码
            match map.get(&idx) {
                Some(Ok(v)) => return Some(v.clone()),
                Some(Err(_)) => return None,
                None => { /* 编码线程还没写入：下面等 */ }
            }
        }
        let now = Instant::now();
        if now >= deadline {
            return None;
        }
        let (g, _) = BASE_PNG_CV.wait_timeout(guard, deadline - now).ok()?;
        guard = g;
    }
}

#[tauri::command]
pub async fn screenshot_open_overlay(app: tauri::AppHandle) -> Result<usize, String> {
    let t_all = Instant::now();
    let t = Instant::now();
    let strip = hide_main_window_for_capture(&app).await;
    tlog("隐藏搜索窗", t);
    // 按内容确认搜索窗真的从屏幕上撤下去了，否则残影会被拍进冻结底图
    let t = Instant::now();
    settle_after_hide(strip.as_ref());
    tlog("等待合成器（settle）", t);
    let t = Instant::now();
    let frame = match grab_screen(&app) {
        Ok(f) => f,
        Err(e) => {
            // 抓屏失败：立刻把窗口放回去，别让用户面对一个消失了的搜索框
            restore_main_window_after_capture(&app);
            return Err(e);
        }
    };
    tlog("抓屏", t);
    let monitors = frame.monitors.clone();
    if monitors.is_empty() {
        restore_main_window_after_capture(&app);
        return Err(err("未检测到显示器"));
    }
    let count = monitors.len();
    // 底图编码与下面的窗口创建 / 页面加载并行
    dispatch_base_encode(&frame);
    let t = Instant::now();
    for m in monitors.iter() {
        if let Err(e) = build_overlay_window(&app, m) {
            restore_main_window_after_capture(&app);
            return Err(e);
        }
    }
    tlog(&format!("创建遮罩窗口 ×{count}"), t);
    dump_overlay_geometry(&app, &frame);
    tlog("open_overlay 总计", t_all);
    Ok(count)
}

/// 关闭所有遮罩窗口，并清掉抓屏缓存。
///
/// 顺带把「因为要截图而收起来的搜索窗」放回来（用户确认/取消都走这里）。
#[tauri::command]
pub fn screenshot_close_overlay(app: tauri::AppHandle) -> Result<(), String> {
    for (label, win) in app.webview_windows() {
        if label.starts_with(OVERLAY_LABEL_PREFIX) {
            let _ = win.close();
        }
    }
    if let Ok(mut guard) = PENDING_CAPTURE.lock() {
        *guard = None;
    }
    // 底图预编码缓存与这一帧绑定，帧没了缓存也一起丢（下次开遮罩会重新分发）
    if let Ok(mut guard) = BASE_PNG_CACHE.lock() {
        *guard = None;
    }
    restore_main_window_after_capture(&app);
    Ok(())
}

/// 框选结果矩形（虚拟桌面**物理**像素——与 gdigrab/ddagrab 的采集坐标同口径）。
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// 是否还有开着的遮罩窗口（用户按 Esc 取消时窗口会先被关掉）。
fn overlay_open(app: &tauri::AppHandle) -> bool {
    app.webview_windows()
        .into_iter()
        .any(|(label, _)| label.starts_with(OVERLAY_LABEL_PREFIX))
}

/// 取走当前选区，顺带读出抓屏帧原点。
///
/// **不克隆整帧**：`pending_clone()` 会把十几 MB 的 RGBA 拷一份，这里只借读
/// origin_x/origin_y——选区 → 物理坐标的换算只用得到这两个数。
fn take_selection_with_origin() -> Option<(SelRect, i32, i32)> {
    let sel = PENDING_SELECTION.lock().ok()?.take()?;
    let origin = {
        let guard = PENDING_CAPTURE.lock().ok()?;
        let f = guard.as_ref()?;
        (f.origin_x, f.origin_y)
    };
    Some((sel, origin.0, origin.1))
}

/// 插件用的「直接在屏幕上框选一个矩形」：开遮罩 → 用户拖选 → 关遮罩 → 回矩形。
///
/// 一次调用走完整个流程，插件不需要自己轮询：遮罩页松手时 `screenshot_crop`
/// 会把选区写进 `PENDING_SELECTION`，这里 80ms 内收走并关窗返回。坐标换算与
/// `screenshot_selection_image` 同源（`sel × scale + 抓屏原点`），保证和截图
/// 标注页看到的是同一块。
///
/// 返回 `Ok(None)` 的两种情况：用户按 Esc 取消（窗口关了但没产生选区）、
/// 或 90 秒没有动作（兜底，免得这条命令一直悬着）。
#[tauri::command]
pub async fn screenshot_pick_region(app: tauri::AppHandle) -> Result<Option<PickRect>, String> {
    // 上一次残留的选区必须先清掉，否则遮罩刚打开就可能读到旧值
    if let Ok(mut guard) = PENDING_SELECTION.lock() {
        *guard = None;
    }
    screenshot_open_overlay(app.clone()).await?;
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        if let Some((sel, origin_x, origin_y)) = take_selection_with_origin() {
            let scale = if sel.scale_factor > 0.0 { sel.scale_factor } else { 1.0 };
            let rect = PickRect {
                x: (sel.x * scale).round() as i32 + origin_x,
                y: (sel.y * scale).round() as i32 + origin_y,
                width: (sel.w * scale).round().max(1.0) as u32,
                height: (sel.h * scale).round().max(1.0) as u32,
            };
            let _ = screenshot_close_overlay(app.clone());
            return Ok(Some(rect));
        }
        if !overlay_open(&app) {
            // 窗口没了但没有选区：用户 Esc 取消
            return Ok(None);
        }
        if Instant::now() >= deadline {
            let _ = screenshot_close_overlay(app.clone());
            return Ok(None);
        }
        tokio::time::sleep(Duration::from_millis(80)).await;
    }
}

/// 取「指定显示器那一块」的抓屏底图（data URL），遮罩页铺满窗口用。
///
/// **性能**：整屏 PNG 编码很贵，正常路径走 `dispatch_base_encode` 分发的预编码
/// 缓存（抓屏后立刻与窗口创建并行跑）；这里最多等 2s，未命中才现场编码兜底。
///
/// **分辨率**：物理像素原样编码，不降采样——底图铺满的是物理像素的窗口区域，
/// 降到逻辑尺寸会让截图区外整屏发糊（150% 缩放下必现）。快速压缩只影响体积。
#[tauri::command]
pub fn screenshot_overlay_image(monitor_index: usize) -> Result<OverlayImage, String> {
    let frame = pending_capture()?;
    let m = frame
        .monitors
        .iter()
        .find(|m| m.index == monitor_index)
        .cloned()
        .or_else(|| frame.monitors.first().cloned())
        .ok_or_else(|| err("没有显示器信息"))?;

    let t = Instant::now();
    let (data_url, w, h) = match take_cached_base(m.index) {
        Some(v) => v,
        None => encode_overlay_base(&frame, &m)?,
    };
    if std::env::var_os("MS_DEBUG_TIMING").is_some() {
        eprintln!("[截图计时] 底图就绪（含等待缓存）: {}ms", t.elapsed().as_millis());
    }
    Ok(OverlayImage {
        data_url,
        width: w,
        height: h,
        monitor: m,
        monitor_count: frame.monitors.len(),
        origin_x: frame.origin_x,
        origin_y: frame.origin_y,
    })
}

/// 遮罩页取底图的结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayImage {
    pub data_url: String,
    pub width: u32,
    pub height: u32,
    pub monitor: MonitorRect,
    pub monitor_count: usize,
    pub origin_x: i32,
    pub origin_y: i32,
}

/// 在遮罩页里「框选某个显示器内的一块」并直接得到 PNG（宿主侧裁切，少一次往返）。
#[tauri::command]
pub fn screenshot_crop(
    monitor_index: usize,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<CropResult, String> {
    let frame = pending_capture()?;
    let m = frame
        .monitors
        .iter()
        .find(|m| m.index == monitor_index)
        .cloned()
        .or_else(|| frame.monitors.first().cloned())
        .ok_or_else(|| err("没有显示器信息"))?;
    // 遮罩页给的是「该显示器窗口内的 CSS 像素」→ 转成帧内物理像素
    let scale = if m.scale_factor > 0.0 { m.scale_factor } else { 1.0 };
    let fx = (m.x - frame.origin_x) as f64 + x * scale;
    let fy = (m.y - frame.origin_y) as f64 + y * scale;
    let (w, h, rgba) = crop_rgba(&frame, (fx, fy, width * scale, height * scale))?;
    // 记录选区在**虚拟桌面里的 CSS 逻辑**位置：标注页要按 CSS 像素精确裁底图
    let sel = SelRect {
        x: (m.x as f64 - frame.origin_x as f64) / scale + x,
        y: (m.y as f64 - frame.origin_y as f64) / scale + y,
        w: width,
        h: height,
        scale_factor: scale,
    };
    *PENDING_SELECTION.lock().map_err(|_| err("选区缓存被占用"))? = Some(sel);
    // 快速压缩：这份裁片只是「松手瞬间先垫上」的过渡图（紧接着 selection_image 会
    // 取同一区域的精确版），PNG 无损，压缩级别只影响体积不影响画质。
    let png = encode_png_fast(w, h, &rgba)?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
    Ok(CropResult {
        data_url: format!("data:image/png;base64,{b64}"),
        width: w,
        height: h,
        // 选区在虚拟桌面里的物理位置（多屏拼图时有用）
        screen_x: (fx.round() as i32) + frame.origin_x,
        screen_y: (fy.round() as i32) + frame.origin_y,
    })
}

/// 最近一次「框选矩形」（CSS 逻辑像素 + 所属缩放 + 抓屏原点）。
/// 标注页 commit 后用 `screenshot_overlay_image_for_selection` 取精确底图。
#[derive(Debug, Clone, Copy)]
struct SelRect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    scale_factor: f64,
}

static PENDING_SELECTION: Mutex<Option<SelRect>> = Mutex::new(None);

/// 取「最近一次框选矩形」在**整屏抓屏帧**里的精确裁片（物理像素，供标注页铺满选区画布）。
///
/// 与 `screenshot_overlay_image`（整屏底图）不同，这里按 `PENDING_SELECTION`
/// 从帧里裁出选区那一块，标注页 `drawImage` 时就是 1:1 清晰底图。
#[tauri::command]
pub fn screenshot_selection_image() -> Result<SelectionImage, String> {
    let frame = pending_capture()?;
    let sel = PENDING_SELECTION
        .lock()
        .map_err(|_| err("选区缓存被占用"))?
        .ok_or_else(|| err("没有可用的选区（请先框选）"))?;
    // 选区 CSS 像素 → 帧内物理像素（直接用保存的 scale/origin，避免再算一遍）
    let fx = sel.x * sel.scale_factor;
    let fy = sel.y * sel.scale_factor;
    let (w, h, rgba) = crop_rgba(&frame, (fx, fy, sel.w * sel.scale_factor, sel.h * sel.scale_factor))?;
    // 快速压缩：这是标注画布的底图，松手后立刻要显示。PNG 无损，压缩级别只影响
    // 体积与耗时，不影响画质；数据只在本机 IPC 里传一次，不进磁盘。
    let png = encode_png_fast(w, h, &rgba)?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
    Ok(SelectionImage {
        data_url: format!("data:image/png;base64,{b64}"),
        width: w,
        height: h,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionImage {
    pub data_url: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CropResult {
    pub data_url: String,
    pub width: u32,
    pub height: u32,
    pub screen_x: i32,
    pub screen_y: i32,
}

/// 把一张 PNG（data URL）写进系统剪贴板。
#[tauri::command]
pub fn screenshot_copy_image(data_url: String) -> Result<(), String> {
    let bytes = parse_data_url(&data_url)?;
    if bytes.is_empty() {
        return Err(err("图片内容为空"));
    }
    set_clipboard_png(&bytes)
}

/// 把一段文本写进系统剪贴板（遮罩页「按 C 取色」把 HEX 交给用户）。
#[tauri::command]
pub fn screenshot_copy_text(text: String) -> Result<(), String> {
    write_text_to_clipboard(&text)
}

/// 解码 data URL 并做一次结构校验（空内容 / 坏图 / 伪装文件都挡在这里）。
fn decode_shot_payload(data_url: &str) -> Result<Vec<u8>, String> {
    let bytes = parse_data_url(data_url)?;
    if bytes.is_empty() {
        return Err(err("图片内容为空"));
    }
    // 先按 PNG 解一遍，确认不是坏图/伪装文件
    let (w, h, _) = decode_png(&bytes)?;
    if w == 0 || h == 0 {
        return Err(err("图片尺寸为空"));
    }
    Ok(bytes)
}

/// 把字节写成一张「索引记录」形状的结果（画廊用）。
fn shot_entry_for(path: &std::path::Path, rel_path: String) -> Result<ShotEntry, String> {
    let md = std::fs::metadata(path).map_err(|e| err(&format!("读取截图信息失败: {e}")))?;
    let mtime_ms = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    Ok(ShotEntry {
        rel_path,
        name,
        size: md.len(),
        mtime_ms,
        created_at: iso_from_ms(mtime_ms),
    })
}

/// 把一张 PNG 落盘到**插件私有目录**的 `shots/` 下，供插件画廊收录，返回索引记录。
///
/// 只允许写进 `<app_data>/plugin-data/<plugin_id>/shots/`，
/// 文件名由宿主生成（不接受调用方传路径），从根上杜绝目录穿越。
///
/// 注意：这是**插件 API** 的落盘（`ms.screenshot.save`）。宿主遮罩页的
/// 「保存」按钮走的是 `screenshot_save_shot_as`（系统另存为对话框），
/// 那条路径会落盘成功后**再调本命令**把同一张图收进画廊。
#[tauri::command]
pub fn screenshot_save_shot(app: tauri::AppHandle, plugin_id: String, data_url: String) -> Result<ShotEntry, String> {
    let bytes = decode_shot_payload(&data_url)?;
    let dir = shots_dir(&app, &plugin_id)?;
    let name = new_shot_name();
    let full = dir.join(&name);
    std::fs::write(&full, &bytes).map_err(|e| err(&format!("写入截图失败: {e}")))?;
    shot_entry_for(&full, format!("{SHOTS_DIR}/{name}"))
}

/// 把一张 PNG **另存到用户选定的位置**（系统文件保存对话框）。
///
/// 宿主遮罩页「保存」按的就是它：弹系统保存框让用户选目录与文件名，
/// 用户取消 → `Ok(None)`（既不写盘也不算失败）；确认为 `Ok(Some(落盘路径))`。
///
/// 用户可能在对话框里把扩展名改掉（或删掉），落盘前统一校正成 `.png`——
/// data URL 里的字节始终是 PNG，扩展名与内容必须一致，否则有些看图软件
/// 会按扩展名猜错解码器而打不开。
///
/// 打开中的插件画廊要不要收录，由调用方决定：遮罩页在落盘成功后，若目标
/// 正好在**本插件截图目录**内，会再调 `screenshot_save_shot` + 广播事件。
#[tauri::command]
pub async fn screenshot_save_shot_as(
    app: tauri::AppHandle,
    plugin_id: String,
    data_url: String,
    parent_dir: Option<String>,
) -> Result<Option<String>, String> {
    let bytes = decode_shot_payload(&data_url)?;
    let dir = shots_dir(&app, &plugin_id)?;

    // 起始目录：调用方给的（如插件画廊正打开的那张截图所在目录）优先；
    // 非法/不存在（被删了）就回落到截图目录，别让对话框打不开。
    let mut builder = app.dialog().file().set_title("保存截图").add_filter("PNG 图片", &["png"]);
    match parent_dir.as_deref().map(std::path::Path::new) {
        Some(p) if p.is_dir() => builder = builder.set_directory(p),
        _ => builder = builder.set_directory(&dir),
    }

    let picked = tauri::async_runtime::spawn_blocking(move || builder.blocking_save_file())
        .await
        .map_err(|e| err(&format!("保存对话框失败: {e}")))?;

    let Some(picked) = picked else {
        return Ok(None); // 用户取消
    };
    let path = picked
        .into_path()
        .map_err(|e| err(&format!("保存路径不可用: {e}")))?;

    // 扩展名校正：始终落成 .png（内容就是 PNG）
    let path = if path
        .extension()
        .map(|e| e.to_string_lossy().eq_ignore_ascii_case("png"))
        .unwrap_or(false)
    {
        path
    } else {
        let mut os = path.clone().into_os_string();
        os.push(".png");
        std::path::PathBuf::from(os)
    };

    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.is_dir() {
            return Err(err(&format!("目标目录不存在: {}", parent.display())));
        }
    }
    std::fs::write(&path, &bytes).map_err(|e| err(&format!("写入截图失败: {e}")))?;
    Ok(Some(path.to_string_lossy().to_string()))
}

/// 列出插件私有目录里的截图（按时间从新到旧）。
#[tauri::command]
pub fn screenshot_list_shots(app: tauri::AppHandle, plugin_id: String) -> Result<Vec<ShotEntry>, String> {
    scan_shots(&app, &plugin_id)
}

/// 返回插件截图目录的**绝对路径**（宿主自己拼，不接受调用方传路径）。
///
/// 用途只有一个：遮罩页要把系统「另存为」对话框的起始目录设到这里，
/// 并在落盘后判断「用户是不是存进了截图目录」以决定要不要同时收进画廊。
/// 目录不存在时会就地建出来（`shots_dir` 的语义），所以这条命令不会失败到
/// 让保存走不下去。
#[tauri::command]
pub fn screenshot_shots_dir(app: tauri::AppHandle, plugin_id: String) -> Result<String, String> {
    Ok(shots_dir(&app, &plugin_id)?.to_string_lossy().to_string())
}

/// 读回一张截图 → data URL（画廊缩略图/大图）。
#[tauri::command]
pub fn screenshot_read_shot(app: tauri::AppHandle, plugin_id: String, rel_path: String) -> Result<String, String> {
    let path = safe_shot_path(&app, &plugin_id, &rel_path)?;
    let md = std::fs::metadata(&path).map_err(|e| err(&format!("截图不存在: {e}")))?;
    if !md.is_file() {
        return Err(err("截图路径不是文件"));
    }
    if md.len() > MAX_SHOT_BYTES {
        return Err(err("截图过大，拒绝读取"));
    }
    let bytes = std::fs::read(&path).map_err(|e| err(&format!("读取截图失败: {e}")))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let mime = match rel_path
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        _ => "image/png",
    };
    Ok(format!("data:{mime};base64,{b64}"))
}

/// 删除一张截图。
#[tauri::command]
pub fn screenshot_delete_shot(app: tauri::AppHandle, plugin_id: String, rel_path: String) -> Result<(), String> {
    let path = safe_shot_path(&app, &plugin_id, &rel_path)?;
    std::fs::remove_file(&path).map_err(|e| err(&format!("删除截图失败: {e}")))
}

/// 删除早于 `days` 天的截图，返回删掉的张数（画廊「只留最近 N 天」用）。
#[tauri::command]
pub fn screenshot_prune_shots(app: tauri::AppHandle, plugin_id: String, days: u64) -> Result<usize, String> {
    let cutoff = std::time::SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(days.saturating_mul(86400)));
    let cutoff = match cutoff {
        Some(c) => c,
        None => return Ok(0),
    };
    let dir = shots_dir(&app, &plugin_id)?;
    let mut removed = 0usize;
    for entry in std::fs::read_dir(&dir).map_err(|e| err(&format!("读取截图目录失败: {e}")))?.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ok = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .map(|t| t < cutoff)
            .unwrap_or(false);
        if ok && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

/// 广播「新截图已保存」（遮罩页保存后调用，插件画廊据此刷新）。
#[tauri::command]
pub fn screenshot_notify_saved(app: tauri::AppHandle, plugin_id: Option<String>, rel_path: Option<String>) -> Result<(), String> {
    let _ = app.emit(
        EVENT_SCREENSHOT_SAVED,
        serde_json::json!({ "pluginId": plugin_id, "relPath": rel_path }),
    );
    Ok(())
}

// ===================== 插件侧：截图快捷键 =====================

/// 读「截图」动作当前绑的键（没有则返回空串 = 未设置）。
///
/// 插件前台要显示「当前快捷键」，而快捷键的权威存储是宿主的 settings.json
/// （`shortcut_bindings`），插件不该自己存一份、否则两边会不一致。
///
/// 返回空串的语义是「**没绑**」：宿主会把默认截图热键自愈补进绑定列表
/// （见 lib.rs `ensure_screenshot_binding`），因此正常情况这里总能读到键；
/// 读到空串只可能是用户主动解绑过——那种情况下如实返回，让前台显示「未设置」，
/// 而不是再报一个并不能按下去用的默认值。
#[tauri::command]
pub fn screenshot_get_shortcut(app: tauri::AppHandle) -> Result<String, String> {
    let bindings = crate::read_shortcut_bindings_for_plugin(&app);
    Ok(bindings
        .into_iter()
        .find(|b| b.action == crate::SHORTCUT_ACTION_SCREENSHOT)
        .map(|b| b.shortcut)
        .unwrap_or_default())
}

/// 给「截图」动作**登记/改绑**一个全局快捷键（插件前台的设置项）。
///
/// 语义是「认领」而不是「替换整套绑定」：
///   - 已有 screenshot 绑定 → 改这一条的键（其余绑定原样保留）；
///   - 没有 → 追加一条；
///   - 键为空串 → 删除该条（等于关掉截图热键），并记下「用户主动解绑」，
///     否则读绑定时的自愈补齐会在下次启动把它加回来。
///
/// 走宿主既有的严格校验 + 注册 + 落盘链路（`apply_shortcut_bindings`），
/// 因此「与其它热键冲突」这类错误会原样返回给插件展示。
#[tauri::command]
pub fn screenshot_set_shortcut(app: tauri::AppHandle, shortcut: String) -> Result<String, String> {
    let key = shortcut.trim().to_lowercase();
    let mut list = crate::read_shortcut_bindings_for_plugin(&app);

    // 空串 = 解绑（移除这一条）
    if key.is_empty() {
        list.retain(|b| b.action != crate::SHORTCUT_ACTION_SCREENSHOT);
        if list.is_empty() {
            return Err(err("至少要保留「呼出 / 隐藏搜索框」这一条快捷键"));
        }
        let applied = crate::apply_shortcut_bindings_for_plugin(&app, &list);
        // 标记只在解绑真正生效后写：注册失败（列表原样回滚）时不该记成已解绑
        if applied.is_ok() {
            crate::set_screenshot_unbound(&app, true);
        }
        return applied.map(|_| String::new());
    }

    // 同一按键已被别的动作占用 → 明确报错，避免静默抢键
    if let Some(other) = list
        .iter()
        .find(|b| b.shortcut == key && b.action != crate::SHORTCUT_ACTION_SCREENSHOT)
    {
        return Err(err(&format!("该组合键已被「{}」占用，请换一个", other.action)));
    }

    match list
        .iter_mut()
        .find(|b| b.action == crate::SHORTCUT_ACTION_SCREENSHOT)
    {
        Some(entry) => entry.shortcut = key.clone(),
        None => list.push(crate::ShortcutBinding {
            shortcut: key.clone(),
            action: crate::SHORTCUT_ACTION_SCREENSHOT.to_string(),
            target: None,
        }),
    }
    crate::apply_shortcut_bindings_for_plugin(&app, &list)?;
    // 用户重新绑定了 → 撤掉「主动解绑」标记，否则下次读绑定会被误判成不要它
    crate::set_screenshot_unbound(&app, false);
    Ok(key)
}

// ===================== 遮罩窗口 =====================

/// 给**单个显示器**建一个透明全屏遮罩窗口。
///
/// 关键点（都是踩过的坑）：
/// - **必须 async**：Windows 上同步命令里建 WebView2 窗口会死锁（wry#583），
///   窗口停在 about:blank 永不导航。调用方也要 `async_runtime::spawn`。
/// - `transparent(true)`：让遮罩层自己能画半透明暗角。
/// - `always_on_top + skip_taskbar + decorations(false)`：盖住一切、不抢任务栏。
/// - `set_position/set_size` 用 **Physical** 值：混合 DPI 下不做逻辑换算最稳。
fn build_overlay_window(app: &tauri::AppHandle, m: &MonitorRect) -> Result<(), String> {
    use tauri::{PhysicalPosition, PhysicalSize, WebviewWindowBuilder, WebviewUrl};

    let label = format!("{OVERLAY_LABEL_PREFIX}{}", m.index);

    // 已经开着就更新位置/尺寸再显示（避免重复 build 报 label 冲突）
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.set_position(PhysicalPosition::new(m.x, m.y));
        let _ = win.set_size(PhysicalSize::new(m.width, m.height));
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }

    let url = WebviewUrl::App(format!("overlay.html?monitor={}", m.index).into());
    let win = WebviewWindowBuilder::new(app, &label, url)
        .title("截图")
        .position(m.x as f64, m.y as f64)
        .inner_size(m.width as f64, m.height as f64)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .focused(true)
        .visible(false)
        .build()
        .map_err(|e| err(&format!("创建遮罩窗口失败: {e}")))?;

    // 物理尺寸兜底：某些缩放下 builder 的逻辑尺寸会取整偏差
    let _ = win.set_position(PhysicalPosition::new(m.x, m.y));
    let _ = win.set_size(PhysicalSize::new(m.width, m.height));
    let _ = win.show();
    let _ = win.set_focus();
    Ok(())
}

/// 热键动作入口：抓屏 + 开遮罩。**同步**（供 global-shortcut 回调调用），
/// 内部把窗口创建丢到异步运行时，绝不阻塞事件循环。
pub fn start_overlay_from_shortcut(app: &tauri::AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        // 收窗口的事在 screenshot_open_overlay 里统一做（插件前台也走那条命令，
        // 两条路径必须一致）；这里只管失败后的兜底。
        if let Err(e) = screenshot_open_overlay(handle.clone()).await {
            eprintln!("打开截图遮罩失败: {e}");
            // 失败也要让用户知道，否则「按了没反应」：把刚收起的搜索窗放回来
            if let Some(win) = handle.get_webview_window("main") {
                let _ = win.show();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_from_ms_formats_epoch() {
        assert_eq!(iso_from_ms(0), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn iso_from_ms_formats_known_time() {
        // 2021-01-01T00:00:00Z = 1609459200s
        assert_eq!(iso_from_ms(1_609_459_200_000), "2021-01-01T00:00:00Z");
    }

    #[test]
    fn iso_handles_leap_day() {
        // 2020-02-29T12:34:56Z = 1582979696s
        assert_eq!(iso_from_ms(1_582_979_696_000), "2020-02-29T12:34:56Z");
    }

    #[test]
    fn parse_data_url_accepts_prefixed_and_bare() {
        // "AAEC" = [0,1,2]
        let a = parse_data_url("data:image/png;base64,AAEC").unwrap();
        let b = parse_data_url("AAEC").unwrap();
        assert_eq!(a, vec![0, 1, 2]);
        assert_eq!(b, vec![0, 1, 2]);
    }

    #[test]
    fn parse_data_url_rejects_garbage() {
        assert!(parse_data_url("not base64!!!").is_err());
    }

    #[test]
    fn png_roundtrip_keeps_pixels() {
        let px = vec![
            255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
        ];
        let png = encode_png(2, 2, &px).unwrap();
        let (w, h, back) = decode_png(&png).unwrap();
        assert_eq!((w, h), (2, 2));
        assert_eq!(back, px);
    }

    #[test]
    fn crop_rgba_takes_subrect() {
        // 3x2 图，每像素用 R 通道标记序号
        let mut rgba = Vec::new();
        for i in 0..6u8 {
            rgba.extend_from_slice(&[i, 0, 0, 255]);
        }
        let frame = CapturedFrame {
            origin_x: 0,
            origin_y: 0,
            width: 3,
            height: 2,
            monitors: vec![],
            rgba,
        };
        // 取 (1,0) 起 1x2
        let (w, h, out) = crop_rgba(&frame, (1.0, 0.0, 1.0, 2.0)).unwrap();
        assert_eq!((w, h), (1, 2));
        assert_eq!(out, vec![1, 0, 0, 255, 4, 0, 0, 255]);
    }

    #[test]
    fn crop_rgba_clamps_out_of_bounds() {
        let frame = CapturedFrame {
            origin_x: 0,
            origin_y: 0,
            width: 2,
            height: 2,
            monitors: vec![],
            rgba: vec![0u8; 2 * 2 * 4],
        };
        // 超出右下角 → 钳到边界，不 panic
        let (w, h, _) = crop_rgba(&frame, (1.0, 1.0, 100.0, 100.0)).unwrap();
        assert_eq!((w, h), (1, 1));
    }

    #[test]
    fn crop_rgba_rejects_empty_selection() {
        let frame = CapturedFrame {
            origin_x: 0,
            origin_y: 0,
            width: 2,
            height: 2,
            monitors: vec![],
            rgba: vec![0u8; 2 * 2 * 4],
        };
        assert!(crop_rgba(&frame, (5.0, 5.0, 1.0, 1.0)).is_err());
    }

    #[test]
    fn new_shot_name_is_png_and_unique() {
        let a = new_shot_name();
        let b = new_shot_name();
        assert!(a.starts_with("shot-"));
        assert!(a.ends_with(".png"));
        // 同毫秒连拍也不能撞名（靠单调序号）
        assert_ne!(a, b);
    }
}

/// 端到端自测（`cargo test --lib screenshot -- --ignored --nocapture`）：
/// 真实抓屏 → 编码 PNG → 解码回像素 → 校验尺寸，并验证剪贴板 DIB 头拼装。
///
/// 临时性能诊断：量出「按热键 → 遮罩可见」这条链路上每一步的耗时。
/// 用法: cargo test --lib screenshot::perf -- --ignored --nocapture
#[cfg(test)]
mod perf {
    use super::*;
    use std::time::Instant;

    /// 量出 DPI 与几何口径：抓屏用的 `GetSystemMetrics` 与显示器真实物理尺寸是否一致。
    ///
    /// 这是「截图后位置偏移」的头号嫌疑：若抓屏拿到的是**逻辑像素**（DPI 不感知），
    /// 而遮罩窗口是**物理像素**，底图就会被拉伸，选区的坐标换算整体差一个缩放比。
    #[test]
    #[ignore]
    fn measure_dpi_geometry() {
        use windows_sys::Win32::Graphics::Gdi::{
            GetDC, GetDeviceCaps, ReleaseDC, DESKTOPHORZRES, DESKTOPVERTRES, HORZRES, LOGPIXELSX,
            VERTRES,
        };
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN,
        };

        unsafe {
            let dc = GetDC(std::ptr::null_mut());
            // LOGPIXELSX = 每逻辑英寸的像素数（96 = 100% 缩放）
            let dpi = GetDeviceCaps(dc, LOGPIXELSX as i32);
            let horz = GetDeviceCaps(dc, HORZRES as i32);
            let vert = GetDeviceCaps(dc, VERTRES as i32);
            // DESKTOPHORZRES = 真实物理像素（DPI 虚拟化下与 HORZRES 不同）
            let desk_w = GetDeviceCaps(dc, DESKTOPHORZRES as i32);
            let desk_h = GetDeviceCaps(dc, DESKTOPVERTRES as i32);
            ReleaseDC(std::ptr::null_mut(), dc);

            println!("LOGPIXELSX (DPI)         : {dpi}   (96 = 100%, 144 = 150%)");
            println!("HORZRES/VERTRES          : {horz}x{vert}   ← 逻辑尺寸（DPI 虚拟化后）");
            println!("DESKTOPHORZRES/VERTRES   : {desk_w}x{desk_h}   ← 真实物理尺寸");
            println!(
                "GetSystemMetrics(virtual): {}x{}   ← 抓屏实际用的值",
                GetSystemMetrics(SM_CXVIRTUALSCREEN),
                GetSystemMetrics(SM_CYVIRTUALSCREEN)
            );
        }

        let (_, _, w, h, _) = capture_virtual_screen().expect("抓屏失败");
        println!("capture_virtual_screen   : {w}x{h}");
    }

    #[test]
    #[ignore]
    fn measure_compression_levels() {
        let (_, _, w, h, rgba) = capture_virtual_screen().expect("抓屏失败");
        for (name, c) in [
            ("Fast", png::Compression::Fast),
            ("Default", png::Compression::Default),
            ("Best", png::Compression::Best),
        ] {
            let t = Instant::now();
            let mut out = Vec::new();
            {
                let mut enc = png::Encoder::new(&mut out, w, h);
                enc.set_color(png::ColorType::Rgba);
                enc.set_depth(png::BitDepth::Eight);
                enc.set_compression(c);
                let mut wr = enc.write_header().unwrap();
                wr.write_image_data(&rgba).unwrap();
            }
            println!(
                "{name:>8}: {:>7.1} ms   {:>6} KB",
                t.elapsed().as_secs_f64() * 1000.0,
                out.len() / 1024
            );
        }
    }

    /// 底图**降采样**到逻辑尺寸后再编码：值不值？
    ///
    /// 遮罩的底图只用来「垫在暗角下面」，不需要 1:1 物理像素；而它是整条链路上
    /// 最贵的一步（整屏 PNG）。这里量出「降采样 + 快速压缩」能省多少。
    #[test]
    #[ignore]
    fn measure_downscaled_backdrop() {
        let (_, _, w, h, rgba) = capture_virtual_screen().expect("抓屏失败");

        // 目标：逻辑尺寸（物理 / 1.5）。用最简单的盒式平均，够用且快。
        let scale = 1.5f64;
        let dw = (w as f64 / scale).round() as u32;
        let dh = (h as f64 / scale).round() as u32;

        let t = Instant::now();
        let mut small = vec![0u8; (dw as usize) * (dh as usize) * 4];
        for dy in 0..dh {
            for dx in 0..dw {
                // 取最近邻即可：底图在暗角下，且会被浏览器再缩放
                let sx = ((dx as f64) * scale).min((w - 1) as f64) as u32;
                let sy = ((dy as f64) * scale).min((h - 1) as f64) as u32;
                let si = ((sy as usize) * (w as usize) + sx as usize) * 4;
                let di = ((dy as usize) * (dw as usize) + dx as usize) * 4;
                small[di..di + 4].copy_from_slice(&rgba[si..si + 4]);
            }
        }
        let t_down = t.elapsed();

        for (name, c) in [("Fast", png::Compression::Fast), ("Default", png::Compression::Default)] {
            let t = Instant::now();
            let mut out = Vec::new();
            {
                let mut enc = png::Encoder::new(&mut out, dw, dh);
                enc.set_color(png::ColorType::Rgba);
                enc.set_depth(png::BitDepth::Eight);
                enc.set_compression(c);
                let mut wr = enc.write_header().unwrap();
                wr.write_image_data(&small).unwrap();
            }
            println!(
                "降采样 {dw}x{dh} + {name:>7}: {:>7.1} ms   {:>6} KB",
                t.elapsed().as_secs_f64() * 1000.0,
                out.len() / 1024
            );
        }
        println!("  （降采样本身 {:>6.1} ms）", t_down.as_secs_f64() * 1000.0);
        println!("  对比：整屏 {w}x{h} + Default ≈ 609 ms / 555 KB");
    }

    #[test]
    #[ignore]
    fn measure_capture_pipeline() {
        let t = Instant::now();
        let (x, y, w, h, rgba) = capture_virtual_screen().expect("抓屏失败");
        let t_capture = t.elapsed();

        let t = Instant::now();
        let png = encode_png(w, h, &rgba).expect("编码失败");
        let t_encode = t.elapsed();

        let t = Instant::now();
        let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
        let t_b64 = t.elapsed();

        let frame = CapturedFrame {
            origin_x: x,
            origin_y: y,
            width: w,
            height: h,
            monitors: vec![],
            rgba,
        };
        let t = Instant::now();
        let (cw, ch, crop) = crop_rgba(&frame, (0.0, 0.0, w as f64, h as f64)).expect("裁切失败");
        let t_crop = t.elapsed();

        let t = Instant::now();
        let crop_png = encode_png(cw, ch, &crop).expect("编码失败");
        let t_crop_encode = t.elapsed();

        println!("屏幕 {w}x{h}");
        println!("  抓屏 BitBlt+GetDIBits : {:>8.1} ms", t_capture.as_secs_f64() * 1000.0);
        println!(
            "  整屏 PNG 编码         : {:>8.1} ms  ({} KB)",
            t_encode.as_secs_f64() * 1000.0,
            png.len() / 1024
        );
        println!(
            "  base64 编码           : {:>8.1} ms  ({} KB)",
            t_b64.as_secs_f64() * 1000.0,
            b64.len() / 1024
        );
        println!("  裁一块 {cw}x{ch}       : {:>8.1} ms", t_crop.as_secs_f64() * 1000.0);
        println!(
            "  裁片 PNG 编码         : {:>8.1} ms  ({} KB)",
            t_crop_encode.as_secs_f64() * 1000.0,
            crop_png.len() / 1024
        );
        println!(
            "  ------------------------------\n  合计(热键→底图就绪)   : {:>8.1} ms",
            (t_capture + t_encode + t_b64 + t_crop + t_crop_encode).as_secs_f64() * 1000.0
        );
    }
}

/// 标 `#[ignore]`：它依赖真实桌面会话（无头 CI 上抓屏会失败或抓到黑屏），
/// 因此默认不跑，需要时手动执行。
#[cfg(test)]
mod e2e {
    use super::*;

    #[test]
    #[ignore]
    fn real_capture_produces_valid_png() {
        let (x, y, w, h, rgba) = capture_virtual_screen().expect("抓屏失败");
        println!("抓屏: origin=({x},{y}) size={w}x{h} bytes={}", rgba.len());
        assert!(w > 0 && h > 0);
        assert_eq!(rgba.len(), (w as usize) * (h as usize) * 4);

        let png = encode_png(w, h, &rgba).expect("编码 PNG 失败");
        println!("PNG: {} 字节", png.len());
        let (w2, h2, back) = decode_png(&png).expect("解码 PNG 失败");
        assert_eq!((w2, h2), (w, h));
        assert_eq!(back.len(), rgba.len());

        // 不该是纯黑（抓到黑屏说明 GDI 路径有问题）
        let nonblack = back.chunks_exact(4).filter(|p| p[0] > 8 || p[1] > 8 || p[2] > 8).count();
        println!("非黑像素: {nonblack} / {}", back.len() / 4);
        assert!(nonblack > 0, "整屏全黑，疑似抓屏失败");
    }

    #[test]
    #[ignore]
    fn real_clipboard_write_image() {
        let (_, _, w, h, rgba) = capture_virtual_screen().expect("抓屏失败");
        // 缩小到 64x64 再写剪贴板：避免测试污染用户剪贴板里一大张图
        let small_w = 64u32.min(w);
        let small_h = 64u32.min(h);
        let mut small = Vec::with_capacity((small_w * small_h * 4) as usize);
        for row in 0..small_h {
            let start = ((row as usize) * (w as usize)) * 4;
            small.extend_from_slice(&rgba[start..start + (small_w as usize) * 4]);
        }
        let png = encode_png(small_w, small_h, &small).expect("编码失败");
        set_clipboard_png(&png).expect("写剪贴板失败");
        println!("已把 {small_w}x{small_h} 截图写入剪贴板");
    }
}
