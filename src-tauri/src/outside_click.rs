//! 「点窗口外就收起」的兜底（Windows）。
//!
//! ## 为什么需要这一层
//!
//! 主窗口唯一的自动收起入口是 `WindowEvent::Focused(false)`（见 lib.rs 的
//! `on_window_event`）。但**焦点事件并不总能到达**，而窗口是置顶且跳任务栏的，
//! 收不起来就会一直浮在别的应用上面：
//!
//!   1. 呼出时被 Windows 前台锁定（foreground lock）拒绝——`show()` 了但从未
//!      拿到前台焦点，此后点窗口外不会产生「失焦」（因为窗口压根没获得过焦点）；
//!   2. WebView2 里插件界面的焦点元素被移除（关闭 / 停靠插件前端）后，窗口
//!      偶发不再上报失焦。
//!
//! 两种都表现为用户说的「点窗口外也收不起呼出框」。
//!
//! ## 做法（事件驱动，不轮询焦点）
//!
//! 全局低级鼠标钩子（`alt_click::hook_proc`，进程启动即常驻）在**按下**时只
//! 记一个坐标（纯原子写，不做任何窗口查询——低级钩子回调超时会被系统静默
//! 卸载），由本模块的后台线程消费：
//!
//!   点击落在主窗口矩形**外面**，且落点窗口不属于本进程 ⇒ 收起主窗口。
//!
//! 两个限定条件缺一不可：
//!   - 「矩形外面」：点在窗口内部（含 WebView 自己的右键菜单）不算点外面；
//!   - 「不是本进程」：原生「选择文件夹」对话框、设置窗口、托盘菜单都属于本
//!     进程，点它们时不该把呼出框收掉（它们在前台时用户并不是「点了外面」）。
//!
//! 这条兜底与失焦隐藏是**同一条用户规则**（点了窗口外面就无条件先隐藏），
//! 不按任何界面状态豁免；它只是把「焦点事件没来」这种情况补上，不是新的门控。
//! 呼出后的短暂抑制期（`SUPPRESS_BLUR_UNTIL_MS`，Alt+点击场景）同样照办。

use std::sync::atomic::{AtomicI32, AtomicU32, Ordering};
use std::time::Duration;

use tauri::Manager;
use windows::Win32::Foundation::POINT;
use windows::Win32::UI::WindowsAndMessaging::{GetWindowThreadProcessId, WindowFromPoint};

/// 最近一次鼠标**按下**的屏幕坐标（物理像素）与序号。
///
/// 写入方是全局低级鼠标钩子的回调，因此这里只有原子操作：序号自增保证后台
/// 线程能看出「又来了一次点击」，坐标本身只用于矩形比对（偶发的竞态无害）。
static CLICK_SEQ: AtomicU32 = AtomicU32::new(0);
static CLICK_X: AtomicI32 = AtomicI32::new(0);
static CLICK_Y: AtomicI32 = AtomicI32::new(0);

/// 进程退出时置位：让兜底线程收手，别在窗口/事件循环已经拆掉后再去动窗口。
static STOPPED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 通知兜底线程退出（由 `RunEvent::Exit` 调用）。
pub fn stop_watchdog() {
    STOPPED.store(true, Ordering::Relaxed);
}

/// 记录一次鼠标左键按下（由低级钩子调用，必须极轻）。
pub fn record_click(x: i32, y: i32) {
    CLICK_X.store(x, Ordering::Relaxed);
    CLICK_Y.store(y, Ordering::Relaxed);
    CLICK_SEQ.fetch_add(1, Ordering::AcqRel);
}

/// 启动兜底线程：消费 `record_click` 记下的点击，判定「点到了窗口外面」就收起主窗口。
///
/// 线程 60ms 轮询一次**序号**（不是轮询焦点）：没有新点击时只有一次原子读，
/// 几乎不占 CPU；有点击才做几次 Win32 查询。
pub fn spawn_watchdog(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut seen = CLICK_SEQ.load(Ordering::Acquire);
        loop {
            std::thread::sleep(Duration::from_millis(60));
            if STOPPED.load(Ordering::Relaxed) {
                return;
            }
            let seq = CLICK_SEQ.load(Ordering::Acquire);
            if seq == seen {
                continue;
            }
            seen = seq;
            let x = CLICK_X.load(Ordering::Relaxed);
            let y = CLICK_Y.load(Ordering::Relaxed);

            let Some(window) = app.get_webview_window("main") else {
                continue;
            };
            // 窗口没显示（绝大多数点击都走到这里）：没有收起的必要
            if !window.is_visible().unwrap_or(false) {
                continue;
            }
            // 呼出后的短暂抑制期（Alt+点击等程序化呼出的夺焦抖动），见 lib.rs
            if crate::blur_hide_suppressed() {
                continue;
            }
            // 点在窗口里面：维持原行为（窗口内部点击不收起）
            if inside_window(&window, x, y) {
                continue;
            }
            // 落点仍是本进程的窗口（原生对话框 / 设置窗 / 托盘菜单）：不算点了外面
            if point_is_self(x, y) {
                continue;
            }
            // 收起动作回到主线程做（与失焦分支走同一个「收回到搜索框高度 + hide」）
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Some(win) = handle.get_webview_window("main") {
                    crate::collapse_and_hide(&win);
                }
            });
        }
    });
}

/// 点击点是否落在主窗口矩形内（物理像素；无边框窗口，外框即内容区）。
///
/// 取不到窗口矩形时返回 `true`（按「在里面」处理）：宁可少收一次，
/// 也不要因为一次查询失败把正在用的窗口关掉。
fn inside_window(window: &tauri::WebviewWindow, x: i32, y: i32) -> bool {
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return true;
    };
    point_in_rect(x, y, pos.x, pos.y, size.width, size.height)
}

/// 点 `(x, y)` 是否落在 `(px, py, w, h)` 内（半开区间：右下边界算外面）。
///
/// 抽成纯函数是为了能单测边界：窗口右/下边缘外 1px 必须算「点外面」，
/// 否则贴着窗口边点一下会把「点外面」误判成「点里面」，窗口收不起来。
fn point_in_rect(x: i32, y: i32, px: i32, py: i32, w: u32, h: u32) -> bool {
    let (w, h) = (w as i32, h as i32);
    x >= px && x < px + w && y >= py && y < py + h
}

/// 点击落点窗口是否属于本进程（原生对话框、设置窗口、托盘菜单都算「自己人」）。
///
/// WebView2 渲染的页面本身是主窗口的子窗口（点击早已被矩形判定拦下），
/// 这里只关心「窗口外」的落点；取不到窗口时按「不是自己」处理（桌面 = 点了外面）。
fn point_is_self(x: i32, y: i32) -> bool {
    unsafe {
        let hwnd = WindowFromPoint(POINT { x, y });
        if hwnd.0.is_null() {
            return false;
        }
        let mut pid = 0u32;
        let _ = GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32));
        pid != 0 && pid == std::process::id()
    }
}

#[cfg(test)]
mod tests {
    use super::point_in_rect;

    #[test]
    fn point_in_rect_edges_are_half_open() {
        // 窗口矩形 (100, 200) 起、宽 300 高 400：右边界 400、下边界 600 都算外面
        assert!(point_in_rect(100, 200, 100, 200, 300, 400), "左上角在里面");
        assert!(point_in_rect(399, 599, 100, 200, 300, 400), "右下角内侧 1px 在里面");
        assert!(!point_in_rect(400, 599, 100, 200, 300, 400), "右边界外 1px 算外面");
        assert!(!point_in_rect(399, 600, 100, 200, 300, 400), "下边界外 1px 算外面");
        assert!(!point_in_rect(99, 200, 100, 200, 300, 400), "左边界外 1px 算外面");
        assert!(!point_in_rect(100, 199, 100, 200, 300, 400), "上边界外 1px 算外面");
    }

    #[test]
    fn point_in_rect_supports_negative_origins() {
        // 多显示器：左侧副屏的原点是负数
        assert!(point_in_rect(-1750, 300, -1920, 200, 1920, 1080));
        assert!(!point_in_rect(-1950, 300, -1920, 200, 1920, 1080));
    }
}
