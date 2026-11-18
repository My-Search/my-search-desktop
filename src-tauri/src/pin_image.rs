//! 贴图（Pin Image）：把**当前剪贴板里的图片**钉在屏幕上。
//!
//! 交互（与截图同源的一条宿主原生链路）：
//!   1. 用户按全局热键 `Ctrl+Alt+P`（由「截图」插件清单 `contributes.shortcut`
//!      声明动作 `pin`，Rust 端 `SHORTCUT_ACTION_PIN` 分发到本模块）；
//!   2. 只读一次系统剪贴板（`clipboard_history::current_clipboard_image`，
//!      CF_DIB → RGBA，不写不 Empty——只读铁律见 clipboard_history.rs 模块注释）；
//!   3. 有图 → 在**光标处**开一个无边框 / 置顶 / 跳过任务栏 / 透明的小窗口，
//!      图片按窗口物理尺寸 1:1 铺满（混合 DPI 下不做逻辑换算最稳）；
//!      没图 → 广播 `my-search://pin-no-image`，前端把主窗带出来提示
//!      「剪贴板里没有图片」（贴图失败不该让用户面对毫无反应的热键）。
//!   4. 再按一次热键 = 再贴一张（多实例），超过上限时关掉最旧的一张（FIFO）。
//!
//! 典型链路：截图 → 标注 → 复制 → Ctrl+Alt+P → 贴图钉在屏幕上对照参考。
//! 窗口行为由 `src/windows/pin/PinApp.vue` 实现：双击关闭、右键菜单
//! （显示编辑工具 / 关闭 / 复制）、编辑工具（画笔 / 矩形 / 椭圆 / 箭头 /
//! 文字 / 橡皮）。窗口透明：橡皮「擦掉」贴图时露出底下的真实桌面。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use base64::Engine as _;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// 贴图窗口 label 前缀（`pin-<毫秒>-<序号>`，关闭/复制都按 label 找）
pub const PIN_LABEL_PREFIX: &str = "pin-";

/// 剪贴板里没有图片时广播给前端的事件（主窗唤起 + toast 提示）
pub const EVENT_PIN_NO_IMAGE: &str = "my-search://pin-no-image";

/// 同时存在的贴图上限：再多按热键时关掉**最旧**的一张（FIFO），
/// 保证「按热键必出新贴图」这一不变式，同时防止窗口无限堆积。
const MAX_PIN_WINDOWS: usize = 8;

/// 贴图窗口四边至少留出的物理像素（防止铺满整屏后连屏都看不到别处）
const SCREEN_MARGIN: u32 = 24;

/// 一张已存在的贴图（进程内注册表条目）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinImageData {
    pub label: String,
    pub data_url: String,
    pub width: u32,
    pub height: u32,
}

/// 进程内贴图注册表：label → 图片。**按插入顺序**保存（最旧在前），
/// FIFO 裁剪与 `pin_image_data` 查找都用它。窗口正常关闭走 `pin_close`
/// 命令移除；异常路径（Alt+F4）由页面 `pagehide` 调 `pin_cleanup` 兜底，
/// 双保险之外还有 FIFO 上限兜底，不会无界增长。
static PIN_IMAGES: Mutex<Vec<PinImageData>> = Mutex::new(Vec::new());

/// label 序号（毫秒 + 自增，进程内唯一即可）
static PIN_SEQ: AtomicU64 = AtomicU64::new(0);

fn err(msg: &str) -> String {
    format!("[贴图] {msg}")
}

fn next_label() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let seq = PIN_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{PIN_LABEL_PREFIX}{ms}-{seq}")
}

/// 注册一张贴图（供 `pin_image_data` 查询）。
fn register_pin(entry: PinImageData) {
    if let Ok(mut guard) = PIN_IMAGES.lock() {
        guard.push(entry);
    }
}

/// 移除一张贴图的注册（窗口已关 / 即将关）。
fn remove_pin(label: &str) {
    if let Ok(mut guard) = PIN_IMAGES.lock() {
        guard.retain(|e| e.label != label);
    }
}

/// FIFO 裁剪：超过上限时返回**应关闭的最旧 label 列表**并从注册表移除
/// （窗口本身由调用方关闭——锁内不做 IPC）。纯函数，便于单测。
fn trim_pins_to(list: &mut Vec<PinImageData>, max: usize) -> Vec<String> {
    let mut to_close = Vec::new();
    while list.len() >= max {
        let Some(oldest) = list.first() else { break };
        to_close.push(oldest.label.clone());
        list.remove(0);
    }
    to_close
}

/// 把当前贴图数裁到上限内，并关闭被挤掉的旧窗口。
fn trim_pins(app: &AppHandle) {
    let to_close = match PIN_IMAGES.lock() {
        Ok(mut guard) => trim_pins_to(&mut guard, MAX_PIN_WINDOWS),
        Err(_) => return,
    };
    for label in to_close {
        eprintln!("[贴图] 超过 {MAX_PIN_WINDOWS} 张上限，关闭最旧的 {label}");
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.close();
        }
    }
}

/// 等比缩小到 `max_w × max_h` 内（**只缩不放**，最小 1px）。纯函数。
///
/// 贴图希望 1:1 展示，但比屏幕还大的图（比如整屏截图复制下来）直接开窗
/// 会出屏；这里按比例缩到显示器可用区内，页面用 CSS 拉伸显示。
fn fit_size(w: u32, h: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    let (max_w, max_h) = (max_w.max(1), max_h.max(1));
    if w == 0 || h == 0 {
        return (1, 1);
    }
    if w <= max_w && h <= max_h {
        return (w, h);
    }
    let scale = (max_w as f64 / w as f64).min(max_h as f64 / h as f64);
    (
        ((w as f64 * scale).round() as u32).clamp(1, max_w),
        ((h as f64 * scale).round() as u32).clamp(1, max_h),
    )
}

/// 把「左上角 + 尺寸」的窗口位置夹进显示器范围内（整体可见，贴边优先）。
/// 纯函数；坐标全部是**物理像素**。
fn clamp_pos(x: i32, y: i32, w: i32, h: i32, mx: i32, my: i32, mw: i32, mh: i32) -> (i32, i32) {
    let clamp_axis = |pos: i32, size: i32, lo: i32, span: i32| -> i32 {
        if size >= span {
            // 窗口比屏还大（极端小屏）：贴左上
            lo
        } else {
            pos.max(lo).min(lo + span - size)
        }
    };
    (clamp_axis(x, w, mx, mw), clamp_axis(y, h, my, mh))
}

/// 当前光标的**物理屏幕**坐标（拿不到时 None，上层回退主屏中心）。
#[cfg(windows)]
fn cursor_pos() -> Option<(i32, i32)> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut pt = POINT { x: 0, y: 0 };
    // 返回 0 = 失败（极罕见）
    (unsafe { GetCursorPos(&mut pt) } != 0).then_some((pt.x, pt.y))
}

#[cfg(not(windows))]
fn cursor_pos() -> Option<(i32, i32)> {
    None
}

/// 找到包含该物理坐标的显示器矩形；光标位置拿不到时回退主屏 / 第一块屏。
fn monitor_at(app: &AppHandle, x: i32, y: i32) -> Option<(i32, i32, u32, u32)> {
    let monitors = crate::screenshot::list_monitors(app);
    monitors
        .iter()
        .find(|m| x >= m.x && x < m.x + m.width as i32 && y >= m.y && y < m.y + m.height as i32)
        .or_else(|| monitors.iter().find(|m| m.is_primary))
        .or_else(|| monitors.first())
        .map(|m| (m.x, m.y, m.width, m.height))
}

/// 热键动作入口：读剪贴板 → 开贴图窗口。**同步**（供 global-shortcut 回调
/// 调用），内部把窗口创建丢进异步运行时，绝不阻塞事件循环（同截图入口）。
pub fn start_pin_from_shortcut(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run_pin_capture(&handle).await {
            eprintln!("{e}");
        }
    });
}

/// 读剪贴板图片 → 注册 → 开窗。失败只记日志（贴图不是关键路径）；
/// 「剪贴板里没有图片」额外广播事件让前端提示。
async fn run_pin_capture(app: &AppHandle) -> Result<(), String> {
    let Some((w, h, rgba)) = crate::clipboard_history::current_clipboard_image()
        .map_err(|e| err(&format!("读取剪贴板失败: {e}")))?
    else {
        // 剪贴板里没有位图：让前端把主窗带出来给一句提示，别让热键「没反应」
        let _ = app.emit(EVENT_PIN_NO_IMAGE, ());
        return Err(err("剪贴板里没有图片"));
    };

    // 剪贴板内容若与上次「截图复制」的像素指纹一致，就贴回截图选区原位
    //（用户需求：截图后贴图的位置与截图时一致）；否则维持光标居中。
    let anchored = crate::screenshot::take_capture_anchor()
        .filter(|(_, _, fp)| *fp == crate::screenshot::pixel_fingerprint(w, h, &rgba));

    // 超上限先关最旧的，再注册新的（保证「按热键必出新贴图」）
    trim_pins(app);

    let (ww, wh, px, py) = if let Some((ax, ay, _)) = anchored {
        // 选区本身就在屏幕内：原坐标 + 原尺寸，1:1 贴回原位置，不再 fit/clamp。
        (w, h, ax, ay)
    } else {
        // 光标所在屏（定位用；拿不到就退主屏中心）
        let (cx, cy) = cursor_pos().unwrap_or((0, 0));
        let monitor = monitor_at(app, cx, cy);
        // 窗口 = 图片尺寸（物理像素 1:1），比屏大则等比缩进屏内；
        // 位置以光标为中心，整体夹进显示器内。
        let (mx, my, mw, mh) = monitor.unwrap_or((0, 0, 1920, 1080));
        let avail_w = mw.saturating_sub(SCREEN_MARGIN * 2).max(160);
        let avail_h = mh.saturating_sub(SCREEN_MARGIN * 2).max(160);
        let (ww, wh) = fit_size(w, h, avail_w, avail_h);
        let (px, py) = clamp_pos(
            cx - ww as i32 / 2,
            cy - wh as i32 / 2,
            ww as i32,
            wh as i32,
            mx,
            my,
            mw as i32,
            mh as i32,
        );
        (ww, wh, px, py)
    };

    let png = crate::screenshot::encode_png(w, h, &rgba)?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
    let data_url = format!("data:image/png;base64,{b64}");

    let label = next_label();
    register_pin(PinImageData {
        label: label.clone(),
        data_url,
        width: w,
        height: h,
    });
    build_pin_window(app, &label, px, py, ww, wh).await
}

/// 建一个贴图窗口。**必须 async**：Windows 上同步命令里建 WebView2 窗口会
/// 死锁（wry#583，与 build_overlay_window 同一个坑），调用方已在异步任务里。
/// 尺寸/位置用 **Physical** 值兜底设置：混合 DPI 下不做逻辑换算最稳（同遮罩）。
async fn build_pin_window(
    app: &AppHandle,
    label: &str,
    x: i32,
    y: i32,
    w: u32,
    h: u32,
) -> Result<(), String> {
    use tauri::{PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

    let url = WebviewUrl::App("pin.html".into());
    let win = WebviewWindowBuilder::new(app, label, url)
        .title("贴图")
        .position(x as f64, y as f64)
        .inner_size(w as f64, h as f64)
        .resizable(false)
        .decorations(false)
        // 透明窗口：橡皮「擦掉」贴图时露出底下的真实桌面（窗口就贴在原位）
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .focused(true)
        .visible(false)
        .build()
        .map_err(|e| err(&format!("创建贴图窗口失败: {e}")))?;

    // 物理尺寸兜底：某些缩放下 builder 的逻辑尺寸会取整偏差（同遮罩窗口）
    let _ = win.set_position(PhysicalPosition::new(x, y));
    let _ = win.set_size(PhysicalSize::new(w, h));
    let _ = win.show();
    let _ = win.set_focus();
    Ok(())
}

// ===================== 命令（pin.html 页面调用） =====================

/// 编辑态窗口边界：位置 + 尺寸**一次**生效。
///
/// 前端进入/退出编辑时要同时改窗口高度与坐标（贴近屏幕底部时向上扩、窗口上移，
/// 图片在屏幕上原地不动）。若分两次调 `set_position` / `set_size`，WebView 会先
/// 按其中一个值渲染一帧，表现为图片或工具条抖一下；Windows 侧用一次
/// `SetWindowPos` 原子完成，其它平台退化为顺序调用。
#[tauri::command]
pub fn pin_set_bounds(
    app: AppHandle,
    label: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let win = app
        .get_webview_window(&label)
        .ok_or_else(|| err("贴图窗口不存在"))?;

    #[cfg(windows)]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER,
        };
        let hwnd = win
            .hwnd()
            .map_err(|e| err(&format!("取贴图窗口句柄失败: {e}")))?;
        unsafe {
            SetWindowPos(
                HWND(hwnd.0 as *mut _),
                None,
                x,
                y,
                width as i32,
                height as i32,
                SWP_NOACTIVATE | SWP_NOZORDER,
            )
            .map_err(|e| err(&format!("设置贴图窗口边界失败: {e}")))?;
        }
    }

    #[cfg(not(windows))]
    {
        use tauri::{PhysicalPosition, PhysicalSize};
        win.set_position(PhysicalPosition::new(x, y))
            .map_err(|e| err(&format!("移动贴图窗口失败: {e}")))?;
        win.set_size(PhysicalSize::new(width, height))
            .map_err(|e| err(&format!("调整贴图窗口大小失败: {e}")))?;
    }

    Ok(())
}

/// 页面取自己这张贴图（label 由页面从窗口元数据读出后传入）。
#[tauri::command]
pub fn pin_image_data(label: String) -> Result<PinImageData, String> {
    PIN_IMAGES
        .lock()
        .map_err(|_| err("贴图注册表被占用"))?
        .iter()
        .find(|e| e.label == label)
        .cloned()
        .ok_or_else(|| err("贴图不存在或已关闭"))
}

/// 关闭一张贴图（页面双击 / 右键菜单「关闭」调用）：移除注册 + 关窗口。
#[tauri::command]
pub fn pin_close(app: tauri::AppHandle, label: String) -> Result<(), String> {
    remove_pin(&label);
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.close();
    }
    Ok(())
}

/// 异常关闭的兜底清理（页面 `pagehide` 时尽力调用；Alt+F4 走这里）。
#[tauri::command]
pub fn pin_cleanup(label: String) -> Result<(), String> {
    remove_pin(&label);
    Ok(())
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_size_never_upscales_and_keeps_ratio() {
        // 不需要缩
        assert_eq!(fit_size(800, 600, 1920, 1080), (800, 600));
        // 等比缩小（整屏 4K 图贴到 1080p 屏）
        assert_eq!(fit_size(3840, 2160, 1920, 1080), (1920, 1080));
        // 两个方向都超时按更紧的一边
        assert_eq!(fit_size(4000, 1000, 1000, 1000), (1000, 250));
        // 不放大
        assert_eq!(fit_size(10, 8, 1000, 1000), (10, 8));
        // 0 尺寸兜底
        assert_eq!(fit_size(0, 0, 100, 100), (1, 1));
    }

    #[test]
    fn clamp_pos_keeps_window_inside_monitor() {
        // 光标在屏中央 → 原样
        assert_eq!(clamp_pos(100, 100, 200, 100, 0, 0, 1920, 1080), (100, 100));
        // 越左/上 → 贴边
        assert_eq!(clamp_pos(-50, -50, 200, 100, 0, 0, 1920, 1080), (0, 0));
        // 越右/下 → 夹回右边界内
        assert_eq!(
            clamp_pos(1900, 1100, 200, 100, 0, 0, 1920, 1080),
            (1720, 980)
        );
        // 带负坐标的多屏（主屏在右）：夹进该屏范围
        assert_eq!(
            clamp_pos(-2100, 500, 200, 100, -1920, 0, 1920, 1080),
            (-1920, 500)
        );
        // 窗口比屏还大 → 贴左上
        assert_eq!(clamp_pos(10, 10, 3000, 2000, 0, 0, 1920, 1080), (0, 0));
    }

    #[test]
    fn trim_pins_drops_oldest_first() {
        let mk = |n: &str| PinImageData {
            label: n.to_string(),
            data_url: String::new(),
            width: 1,
            height: 1,
        };
        // trim 发生在「加入新贴图之前」：关到 len < max 为止，给新贴图腾位。
        // 3 张、上限 2 → 关掉最旧两张，剩 1（加入新贴图后正好 2 = 上限）
        let mut list = vec![mk("a"), mk("b"), mk("c")];
        let closed = trim_pins_to(&mut list, 2);
        assert_eq!(closed, vec!["a", "b"]);
        assert_eq!(
            list.iter().map(|e| e.label.as_str()).collect::<Vec<_>>(),
            ["c"]
        );
        // 已在上限内（len < max）→ 不裁
        let mut list = vec![mk("a")];
        assert!(trim_pins_to(&mut list, 2).is_empty());
        // 恰好等于上限 → 也要关一张腾位
        let mut list = vec![mk("a"), mk("b")];
        let closed = trim_pins_to(&mut list, 2);
        assert_eq!(closed, vec!["a"]);
        assert_eq!(list.len(), 1);
        // 4 张、上限 2 → 连关 3 张
        let mut list = vec![mk("a"), mk("b"), mk("c"), mk("d")];
        let closed = trim_pins_to(&mut list, 2);
        assert_eq!(closed, vec!["a", "b", "c"]);
    }

    #[test]
    fn label_is_unique_and_prefixed() {
        let a = next_label();
        let b = next_label();
        assert_ne!(a, b);
        assert!(a.starts_with(PIN_LABEL_PREFIX) && b.starts_with(PIN_LABEL_PREFIX));
    }
}

