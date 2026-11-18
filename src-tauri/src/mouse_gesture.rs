//! 鼠标手势：全局低级鼠标钩子捕获**右键拖拽**轨迹 → 识别方向串 → 执行映射动作。
//!
//! 与 `alt_click.rs` 同一条「全局钩子 + OnceLock<AppHandle>」模式：
//!
//!   1. 常驻 `WH_MOUSE_LL` 钩子观察右键 DOWN/MOVE/UP：按下时若同时按住 Ctrl
//!      （默认触发键），就进入「待激活」状态——只记录起点；
//!   2. 拖拽超过阈值 = 手势激活：从此刻起**吞掉 RBUTTONUP**（不吞的话松手会
//!      弹出系统右键菜单），随后补发一个合成 UP 复位右键状态（否则目标窗口
//!      只收到 DOWN 收不到 UP、右键悬挂，命令行窗口关不掉须再右击）；
//!      DOWN/MOVE 一律透传（前台应用完全无感）；
//!   3. 松手 → 识别方向串（移植 FlowMouse 的锚点推进 + 自适应阈值算法，
//!      参考 FlowMouse-main/js/gesture-recognizer.js）→ 查映射表 → 命中执行；
//!      未命中（或没按住触发键）则把 UP 原样放行，右键菜单照常弹出；
//!   4. 轨迹 HUD 是宿主常驻隐藏窗口（`gesture.html`，独立 WebView、置顶透明、
//!      鼠标穿透），手势期间由本模块广播 `my-search://gesture-trail` 显示轨迹——
//!      主窗口 WebView 失焦即隐藏，不能承担这个职责。
//!
//! 设计约束（低级钩子的铁律，与 alt_click.rs 一致）：
//! - 钩子回调必须极轻：只判断按键 + channel 投递，任何识别/执行都在识别线程；
//!   回调超时会被系统**静默卸载**钩子，表现为「用着用着失灵」；
//! - 是否吞掉 RBUTTONUP 必须在回调里同步决定（返回 1 才有效），因此激活
//!   状态用 AtomicBool 镜像（识别线程写、回调读），回调绝不碰锁；
//! - 动作执行前校验插件网关 `gesture.exec` 权限（前端是唯一真相源，Rust 镜像），
//!   未授予一律拒绝——即使前端被绕过，Rust 侧也拿不到执行能力。
//!
//! 坐标全部是**物理屏幕像素**（`MSLLHOOKSTRUCT.pt` 口径），与贴图/遮罩一致。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::{LazyLock, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::plugin_host;

/// 手势轨迹 HUD 窗口 label（常驻隐藏；capabilities/gesture.json 按 `gesture-*` 授权）
pub const GESTURE_HUD_LABEL: &str = "gesture-hud";

/// 手势轨迹事件名（Rust → HUD 页面：点坐标序列）
pub const EVENT_GESTURE_TRAIL: &str = "my-search://gesture-trail";

/// 手势结果反馈事件名（Rust → HUD 页面：识别出的手势 + 将执行的动作）
pub const EVENT_GESTURE_RESULT: &str = "my-search://gesture-result";

/// 用户启用开关（settings 键 `gesture_enabled`）
static ENABLED: AtomicBool = AtomicBool::new(true);
/// 钩子句柄（仅在有启用插件具备 `gesture.exec` 且用户开关开启时挂载；否则为 0）
static HOOK: AtomicIsize = AtomicIsize::new(0);
/// 应用句柄（sync_active / install 时写入；识别线程用它广播事件）
static APP: OnceLock<AppHandle> = OnceLock::new();
/// 识别线程是否已启动（进程内最多起一个常驻识别循环，钩子未挂时阻塞在 recv 零开销）
#[cfg(windows)]
static WORKER_STARTED: AtomicBool = AtomicBool::new(false);
/// 识别线程的命令通道（钩子回调 → 识别线程；回调只 send，绝不做重活）
#[cfg(windows)]
static MSG_TX: OnceLock<std::sync::mpsc::Sender<GestureEv>> = OnceLock::new();
/// 手势激活镜像：识别线程写、钩子回调读（决定是否吞 RBUTTONUP）。
/// 单独的 AtomicBool 而不是锁——低级钩子回调里绝不碰锁。
#[cfg(windows)]
static ACTIVE: AtomicBool = AtomicBool::new(false);

/// 「右键按下中」镜像：钩子回调在 RBUTTONDOWN 置位、RBUTTONUP 复位，
/// WM_MOUSEMOVE 用它判断是否要投递移动（无锁负载检查，回调极轻）。
#[cfg(windows)]
static HELD: AtomicBool = AtomicBool::new(false);

/// 「画手势录制」模式：面板请求后置位——识别线程把手势结果广播给
/// 面板（my-search://gesture-record）而**不执行动作**；HUD 显示「录制中」。
static RECORDING: AtomicBool = AtomicBool::new(false);
/// 发起录制的插件 id（只向发起方定向回传录制结果）
static RECORDING_PLUGIN: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));

// ===================== 识别算法（移植 FlowMouse GestureRecognizer） =====================

/// 激活阈值（物理像素）：拖拽超过它才算手势开始
const ACTIVATE_THRESHOLD: f64 = 24.0;
/// 方向段基础阈值
const DISTANCE_THRESHOLD: f64 = 24.0;
/// 方向切换的自适应阈值系数（FlowMouse longGestureMultiplier）
const LONG_GESTURE_MULTIPLIER: f64 = 0.10;
/// 方向切换阈值上限
const MAX_THRESHOLD: f64 = 120.0;

/// 方向识别器（每次手势新建；锚点推进 + 自适应阈值，纯函数可单测）
#[derive(Debug, Default)]
struct PatternRecognizer {
    active: bool,
    start_x: f64,
    start_y: f64,
    anchor_x: f64,
    anchor_y: f64,
    segment_length: f64,
    pattern: Vec<char>,
}

impl PatternRecognizer {
    fn new() -> Self {
        Self::default()
    }

    /// 喂一个轨迹点，返回方向串快照（空串 = 尚未激活）
    fn feed(&mut self, x: f64, y: f64) -> String {
        let dx = x - self.start_x;
        let dy = y - self.start_y;
        if !self.active {
            if (dx * dx + dy * dy).sqrt() <= ACTIVATE_THRESHOLD {
                return String::new();
            }
            self.active = true;
            self.anchor_x = self.start_x;
            self.anchor_y = self.start_y;
            self.segment_length = 0.0;
        }
        // 锚点推进：距离超过基础阈值 → 判向；与上一段同向则延长锚距，
        // 异向且超过自适应阈值（基础 + 段长×系数，封顶）才切新方向。
        let adx = x - self.anchor_x;
        let ady = y - self.anchor_y;
        let dist = (adx * adx + ady * ady).sqrt();
        if dist > DISTANCE_THRESHOLD {
            let dir = direction_of(adx, ady);
            match self.pattern.last() {
                Some(&last) if last == dir => {
                    self.segment_length += dist;
                    self.anchor_x = x;
                    self.anchor_y = y;
                }
                _ => {
                    let adaptive = (DISTANCE_THRESHOLD
                        + self.segment_length * LONG_GESTURE_MULTIPLIER)
                    .min(MAX_THRESHOLD);
                    if dist > adaptive || self.pattern.is_empty() {
                        self.pattern.push(dir);
                        self.segment_length = dist;
                        self.anchor_x = x;
                        self.anchor_y = y;
                    }
                }
            }
        }
        self.pattern.iter().collect()
    }
}

/// 位移 → 方向字符（U/D/L/R；按长轴判向，FlowMouse 同款）
fn direction_of(dx: f64, dy: f64) -> char {
    if dx.abs() > dy.abs() {
        if dx > 0.0 { 'R' } else { 'L' }
    } else if dy > 0.0 {
        'D'
    } else {
        'U'
    }
}
// ===================== 映射表与动作 =====================

/// 动作类型（与前端插件面板共用同一套语义；serde tag = "type"）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum GestureAction {
    /// 休眠（不弹 UAC；可配延迟秒数）
    #[serde(rename = "sleep")]
    Sleep { seconds: Option<u32> },
    /// 关机（shutdown /s，可用 shutdown /a 取消）
    #[serde(rename = "shutdown")]
    Shutdown,
    /// 重启（shutdown /r）
    #[serde(rename = "reboot")]
    Reboot,
    /// 打开命令行窗口（Windows Terminal 优先，回落 cmd）
    #[serde(rename = "terminal")]
    Terminal,
    /// 打开资源管理器（可选目录，缺省「此电脑」）
    #[serde(rename = "explorer")]
    Explorer { path: Option<String> },
    /// 强制结束当前前台窗口的进程（先 WM_CLOSE，未退出则强杀）
    #[serde(rename = "kill-foreground")]
    KillForeground,
    /// 打开任意目标：程序（.exe/.lnk）/ 文件夹 / 文件 / URL
    #[serde(rename = "open")]
    Open { target: String },
    /// 呼出程序到前台：已运行则切到其最顶窗口，未运行则按 exe 路径启动。
    /// 只持久化 exe 绝对路径（pid / 窗口句柄会变，不可持久化）。
    #[serde(rename = "focus-process")]
    FocusProcess {
        /// 程序 exe 绝对路径（权威标识）
        #[serde(rename = "exePath")]
        exe_path: String,
        /// 配置时记录的窗口标题（仅展示，可空）
        #[serde(default)]
        title: Option<String>,
    },
}

/// 面板下拉「运行中的进程」条目（窗口进程去重后）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunningProcessDto {
    pub pid: u32,
    /// exe 文件名（如 chrome.exe）
    pub name: String,
    /// exe 绝对路径（持久化的权威标识）
    pub exe_path: String,
    /// 窗口标题（下拉展示用）
    pub title: String,
}

/// 手势映射条目：方向串 → 动作（+ 可选备注名）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GestureBinding {
    /// 方向串（U/D/L/R 组合，如 "UD"）
    pub pattern: String,
    /// 动作
    pub action: GestureAction,
    /// 展示名（面板备注；HUD 反馈用）
    #[serde(default)]
    pub label: Option<String>,
}

/// 按插件隔离的手势映射表：plugin_id → Vec<GestureBinding>。
/// 宿主不硬编码任何具体插件 id，任何获授 `gesture.exec` 的启用插件均可注册自己的映射。
static BINDINGS: LazyLock<Mutex<HashMap<String, Vec<GestureBinding>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 供面板「导入默认映射」按钮使用的一组推荐映射（**不再自动注入**）。
/// 方向语义：U=上 D=下 L=左 R=右，方向串按轨迹先后拼接（"UD" = 先上后下）。
#[allow(dead_code)]
pub fn default_bindings() -> Vec<GestureBinding> {
    vec![
        GestureBinding {
            pattern: "D".into(),
            action: GestureAction::Terminal,
            label: Some("命令行窗口".into()),
        },
        GestureBinding {
            pattern: "R".into(),
            action: GestureAction::Explorer { path: None },
            label: Some("资源管理器".into()),
        },
        GestureBinding {
            pattern: "L".into(),
            action: GestureAction::KillForeground,
            label: Some("强制关闭前台程序".into()),
        },
        GestureBinding {
            pattern: "DU".into(),
            action: GestureAction::Reboot,
            label: Some("重启".into()),
        },
        GestureBinding {
            pattern: "UD".into(),
            action: GestureAction::Shutdown,
            label: Some("关机".into()),
        },
    ]
}

/// 读指定插件的映射表快照
pub fn bindings_snapshot_of(plugin_id: &str) -> Vec<GestureBinding> {
    BINDINGS
        .lock()
        .ok()
        .and_then(|g| g.get(plugin_id).cloned())
        .unwrap_or_default()
}

/// 清理某插件在内存中的映射（插件卸载时调用）
pub(crate) fn remove_plugin_bindings(plugin_id: &str) {
    if let Ok(mut g) = BINDINGS.lock() {
        g.remove(plugin_id);
    }
}

/// 按方向串在当前所有已启用且具备 `gesture.exec` 权限的插件里查找映射（返回所属 plugin_id 与条目）
#[cfg(windows)]
fn find_binding(pattern: &str) -> Option<(String, GestureBinding)> {
    let active_owners = plugin_host::active_plugin_ids_with_grant("gesture.exec");
    let guard = BINDINGS.lock().ok()?;
    for pid in active_owners {
        if let Some(list) = guard.get(&pid) {
            if let Some(b) = list.iter().find(|b| b.pattern == pattern) {
                return Some((pid, b.clone()));
            }
        }
    }
    None
}

/// 动作展示名（无备注时兜底）
fn action_label(action: &GestureAction) -> String {
    match action {
        GestureAction::Sleep { .. } => "休眠".into(),
        GestureAction::Shutdown => "关机".into(),
        GestureAction::Reboot => "重启".into(),
        GestureAction::Terminal => "命令行窗口".into(),
        GestureAction::Explorer { .. } => "资源管理器".into(),
        GestureAction::KillForeground => "强制关闭前台程序".into(),
        GestureAction::Open { target } => format!("打开 {target}"),
        GestureAction::FocusProcess { title, exe_path } => {
            let name = title
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| {
                    std::path::Path::new(exe_path)
                        .file_name()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_else(|| exe_path.clone())
                });
            format!("呼出 {name}")
        }
    }
}

// ===================== 进程枚举与呼出（Windows） =====================

/// 一个「有可见窗口」的顶层进程快照（供下拉列举与呼出匹配）。
#[cfg(windows)]
struct WindowProc {
    hwnd: windows_sys::Win32::Foundation::HWND,
    pid: u32,
    exe_path: String,
    title: String,
}

/// 取进程的 exe 绝对路径；受保护 / 已退出进程取不到则返回 None。
#[cfg(windows)]
fn process_exe_path(pid: u32) -> Option<String> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut buf = [0u16; 32768];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut size);
        CloseHandle(handle);
        if ok == 0 || size == 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buf[..size as usize]))
    }
}

/// EnumWindows 回调：收集有标题、可见、非本应用、能取到 exe 路径的顶层窗口。
/// 无捕获 extern 回调，通过 lparam 传裸指针收集（EnumWindows 保证回调串行）。
#[cfg(windows)]
unsafe extern "system" fn enum_windows_cb(
    hwnd: windows_sys::Win32::Foundation::HWND,
    lparam: windows_sys::Win32::Foundation::LPARAM,
) -> windows_sys::core::BOOL {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
    };
    let out = &mut *(lparam as *mut Vec<WindowProc>);
    // 隐藏窗口 / 系统壳层（无标题）不参与；Shell_TrayWnd、桌面等无标题已被过滤
    if IsWindowVisible(hwnd) == 0 || GetWindowTextLengthW(hwnd) <= 0 {
        return 1;
    }
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, &mut pid);
    if pid == 0 || pid == std::process::id() {
        return 1;
    }
    let Some(exe_path) = process_exe_path(pid) else {
        return 1;
    };
    let len = GetWindowTextLengthW(hwnd) as usize;
    let mut buf = vec![0u16; len + 1];
    let n = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
    if n <= 0 {
        return 1;
    }
    out.push(WindowProc {
        hwnd,
        pid,
        exe_path,
        title: String::from_utf16_lossy(&buf[..n as usize]),
    });
    1 // 继续枚举（返回 0 会中断）
}

/// 枚举当前所有「有可见窗口」的顶层进程；顺序 = Z 序（最顶在前）。
#[cfg(windows)]
fn enumerate_window_processes() -> Vec<WindowProc> {
    use windows_sys::Win32::UI::WindowsAndMessaging::EnumWindows;
    let mut out: Vec<WindowProc> = Vec::new();
    unsafe {
        let _ = EnumWindows(
            Some(enum_windows_cb),
            &mut out as *mut Vec<WindowProc> as windows_sys::Win32::Foundation::LPARAM,
        );
    }
    out
}

/// 呼出程序：按 exe 路径重新枚举窗口，命中 Z 序最顶者（= 最近使用）切到前台；
/// 未命中（未运行）则按路径启动。置前必须走主线程以绕过 Windows 前台锁定。
#[cfg(windows)]
fn focus_process(app: &AppHandle, exe_path: &str) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let target = exe_path.trim();
    if target.is_empty() {
        return Err("未指定程序路径".into());
    }
    let key = target.to_lowercase();
    if let Some(hwnd) = enumerate_window_processes()
        .into_iter()
        .find(|w| w.exe_path.to_lowercase() == key)
        .map(|w| w.hwnd)
    {
        // HWND（裸指针）非 Send，跨线程只传 isize，到主线程再还原
        let hwnd_val = hwnd as isize;
        app.run_on_main_thread(move || {
            crate::alt_click::force_foreground(windows::Win32::Foundation::HWND(
                hwnd_val as *mut _,
            ));
        })
        .map_err(|e| format!("切到前台失败: {e}"))?;
        return Ok(());
    }
    // 未在运行：按保存的 exe 路径启动
    if std::fs::metadata(target).is_err() {
        return Err(format!("程序路径不存在: {target}"));
    }
    app.opener()
        .open_path(target, None::<&str>)
        .map_err(|e| format!("启动程序失败: {e}"))
}

// ===================== 动作执行（Windows） =====================

/// CREATE_NO_WINDOW：后台命令不闪黑框
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// shutdown.exe 静默执行（关机/重启走系统标准路径，取消可用 shutdown /a）
#[cfg(windows)]
fn run_shutdown(args: &[&str]) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    Command::new("shutdown")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("执行 shutdown 失败: {e}"))
}

/// 直接休眠（不弹 UAC；同 Win+X → 睡眠）。**同步阻塞**直到系统唤醒才返回
/// （SetSuspendState 的语义），因此调用点必须放在独立线程。
#[cfg(windows)]
fn suspend_now() -> Result<(), String> {
    #[link(name = "powrprof")]
    unsafe extern "system" {
        fn SetSuspendState(hibernate: u8, force_critical: u8, disable_wake_event: u8) -> u8;
    }
    let ok = unsafe { SetSuspendState(0, 0, 0) };
    if ok == 0 {
        Err("休眠失败（系统拒绝）".into())
    } else {
        Ok(())
    }
}

/// 打开命令行：装了 Windows Terminal（wt.exe 在 PATH）就用 wt，否则 cmd。
#[cfg(windows)]
fn open_terminal() -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    let wt_ok = Command::new("where")
        .arg("wt.exe")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    // start 让控制台程序独立成窗，本进程不被挂住；第一个 "" 是窗口标题占位
    let target = if wt_ok { "wt.exe" } else { "cmd.exe" };
    Command::new("cmd")
        .args(["/C", "start", "", target])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("打开命令行失败: {e}"))
}

/// 打开「此电脑」（CLSID 前缀保证落在「此电脑」页而不是库视图）
#[cfg(windows)]
fn open_computer() -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    Command::new("explorer.exe")
        .arg("::{20D04FE0-3AEA-1069-A2D8-08002B30309D}")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("打开资源管理器失败: {e}"))
}

/// 打开任意目标：URL → opener（默认浏览器）；存在的路径 → opener
/// （目录/文件/程序都能拉起）；两者都不是 → 报错（HUD 会显示）。
#[cfg(windows)]
fn open_any_target(target: &str) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let t = target.trim();
    if t.is_empty() {
        return Err("目标为空".into());
    }
    let app = APP.get().ok_or_else(|| "应用未初始化".to_string())?;
    if t.starts_with("http://") || t.starts_with("https://") {
        return app
            .opener()
            .open_url(t, None::<&str>)
            .map_err(|e| format!("打开链接失败: {e}"));
    }
    if std::fs::metadata(t).is_err() {
        return Err(format!("目标不存在: {t}"));
    }
    app.opener()
        .open_path(t, None::<&str>)
        .map_err(|e| format!("打开目标失败: {e}"))
}

/// 强制结束前台窗口的进程：取前台窗口 PID → WM_CLOSE（未保存文档会弹确认，
/// 符合预期）→ 进程还在 → TerminateProcess 立即结束；打不开进程句柄
/// （已退出 / 权限不足）视为成功——WM_CLOSE 已生效或目标本来就在退出。
#[cfg(windows)]
fn kill_foreground() -> Result<(), String> {
    use windows_sys::Win32::Foundation::{CloseHandle, LPARAM, WPARAM};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, TerminateProcess, PROCESS_TERMINATE,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowThreadProcessId, SendMessageTimeoutW,
    };
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_null() {
            return Err("没有前台窗口".into());
        }
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == 0 {
            return Err("取不到前台窗口的进程".into());
        }
        // 宿主自己的窗口（含 HUD/贴图）不许自杀
        if pid == std::process::id() {
            return Err("目标是本应用，已跳过".into());
        }
        // 先礼貌：WM_CLOSE，最多等 800ms；挂死窗口直接跳过等待
        SendMessageTimeoutW(
            hwnd,
            0x0010, // WM_CLOSE
            WPARAM::default(),
            LPARAM::default(),
            0x0002, // SMTO_ABORTIFHUNG
            800,
            std::ptr::null_mut(),
        );
        // 再强制：进程还在就 TerminateProcess（退出码 1）
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if handle.is_null() {
            return Ok(());
        }
        TerminateProcess(handle, 1);
        CloseHandle(handle);
        Ok(())
    }
}

/// 执行动作（调用点必须已校验 `gesture.exec` 权限）。
/// 休眠是「重」动作：SetSuspendState 会阻塞到系统唤醒，独立线程执行；
/// 其余动作毫秒级返回，就地执行。
pub fn execute_action(app: &AppHandle, action: &GestureAction) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    match action {
        GestureAction::Sleep { seconds } => {
            let secs = seconds.unwrap_or(0);
            #[cfg(windows)]
            {
                let _ = app;
                std::thread::spawn(move || {
                    if secs > 0 {
                        std::thread::sleep(std::time::Duration::from_secs(u64::from(secs)));
                    }
                    if let Err(e) = suspend_now() {
                        eprintln!("[手势] 休眠失败: {e}");
                    }
                });
            }
            #[cfg(not(windows))]
            {
                let _ = (app, secs);
            }
            Ok(())
        }
        GestureAction::Shutdown => {
            #[cfg(windows)]
            return run_shutdown(&["/s", "/t", "0"]);
            #[cfg(not(windows))]
            Err("该动作仅支持 Windows".into())
        }
        GestureAction::Reboot => {
            #[cfg(windows)]
            return run_shutdown(&["/r", "/t", "0"]);
            #[cfg(not(windows))]
            Err("该动作仅支持 Windows".into())
        }
        GestureAction::Terminal => {
            #[cfg(windows)]
            return open_terminal();
            #[cfg(not(windows))]
            Err("该动作仅支持 Windows".into())
        }
        GestureAction::Explorer { path } => match path.as_deref() {
            Some(p) if !p.trim().is_empty() => app
                .opener()
                .open_path(p.trim(), None::<&str>)
                .map_err(|e| format!("打开目录失败: {e}")),
            _ => {
                #[cfg(windows)]
                return open_computer();
                #[cfg(not(windows))]
                Err("该动作仅支持 Windows".into())
            }
        },
        GestureAction::Open { target } => {
            #[cfg(windows)]
            return open_any_target(target);
            #[cfg(not(windows))]
            Err("该动作仅支持 Windows".into())
        }
        GestureAction::KillForeground => {
            #[cfg(windows)]
            return kill_foreground();
            #[cfg(not(windows))]
            Err("该动作仅支持 Windows".into())
        }
        GestureAction::FocusProcess { exe_path, .. } => {
            #[cfg(windows)]
            return focus_process(app, exe_path);
            #[cfg(not(windows))]
            Err("该动作仅支持 Windows".into())
        }
    }
}

// ===================== 识别线程 =====================

/// 识别线程消息（钩子回调 → 识别线程；回调里只 send）
#[cfg(windows)]
enum GestureEv {
    Down { x: i32, y: i32 },
    Move { x: i32, y: i32 },
    Up { x: i32, y: i32 },
}

/// 轨迹点序列化（i32 元组 → JSON 数组）
fn trail_json(points: &[(i32, i32)]) -> Vec<Vec<i32>> {
    points.iter().map(|(x, y)| vec![*x, *y]).collect()
}

/// 识别线程主循环：常驻消费钩子回调投递的鼠标事件。
///
/// 会话状态在这里维护（回调只 send），识别、广播、执行都在本线程/异步任务里。
/// `set_active` 是激活镜像写入器（生产传 `|v| ACTIVE.store(v, Ordering::Release)`，
/// 拆参数是为了可测性）。
#[cfg(windows)]
fn recognizer_loop(rx: std::sync::mpsc::Receiver<GestureEv>, set_active: impl Fn(bool)) {
    let mut rec = PatternRecognizer::new();
    let mut trail: Vec<(i32, i32)> = Vec::new();
    let mut start = (0i32, 0i32);
    let mut last_sent = (0i32, 0i32);
    let mut active = false;
    // 本次手势会话的虚拟屏包围盒（激活时算一次；Down 时失效）
    let mut hud_bounds: Option<(i32, i32, u32, u32)> = None;
    for ev in rx {
        match ev {
            GestureEv::Down { x, y } => {
                rec = PatternRecognizer::new();
                trail = vec![(x, y)];
                start = (x, y);
                last_sent = (x, y);
                active = false;
                set_active(false);
                hud_bounds = None;
            }
            GestureEv::Move { x, y } => {
                if !active {
                    let dx = (x - start.0) as f64;
                    let dy = (y - start.1) as f64;
                    if (dx * dx + dy * dy).sqrt() < ACTIVATE_THRESHOLD {
                        continue;
                    }
                    // 激活：镜像置位（钩子回调从此会吞掉 RBUTTONUP）+ 唤起 HUD 画轨迹
                    active = true;
                    set_active(true);
                    if let Some(app) = APP.get() {
                        let b = virtual_screen_bounds(&app);
                        hud_bounds = Some(b);
                        show_hud(&app, Some(b));
                    }
                    trail.clear();
                    trail.push(start);
                }
                trail.push((x, y));
                // 识别器必须**逐点喂入相对起点的坐标**（识别器语义：起点=原点）。
                // 之前只在松手时喂一次绝对坐标 → 方向变成「屏幕(0,0)→松手点」
                // 的象限方向，多段手势永远只识别出一个字母（真机踩过的坑）。
                rec.feed((x - start.0) as f64, (y - start.1) as f64);
                // 节流广播：距上次广播点超过 16 物理像素才发（高频 emit 拖垮事件循环）
                let ddx = (x - last_sent.0) as f64;
                let ddy = (y - last_sent.1) as f64;
                if (ddx * ddx + ddy * ddy).sqrt() >= 16.0 {
                    last_sent = (x, y);
                    if let Some(app) = APP.get() {
                        // 附带虚拟屏包围盒：HUD 页面据此把钩子坐标平移到画布坐标
                        let (vx, vy, vw, vh) = hud_bounds.unwrap_or((0, 0, 3840, 2160));
                        let _ = app.emit(
                            EVENT_GESTURE_TRAIL,
                            serde_json::json!({ "points": trail_json(&trail), "active": true, "vx": vx, "vy": vy, "vw": vw, "vh": vh }),
                        );
                    }
                }
            }
            GestureEv::Up { x, y } => {
                if !active {
                    continue;
                }
                active = false;
                set_active(false);
                trail.push((x, y));
                // 松手点也按相对坐标补喂一次（最后半段方向可能差这一步）
                rec.feed((x - start.0) as f64, (y - start.1) as f64);
                let pattern: String = rec.pattern.iter().collect();
                trail.clear();
                // 手势激活时钩子吞掉了真实 RBUTTONUP：补发合成 UP 复位右键状态，
                // 否则目标窗口右键悬挂（命令行窗口关不掉、须再右击）。
                release_right_button_state(x, y);
                if let Some(app) = APP.get() {
                    finish_gesture(app, &pattern);
                }
            }
        }
    }
}

/// 松手收尾：查映射 → 广播结果 → 校验权限 → 执行。
/// `pattern` 为空 = 拖拽距离不够或没画出有效方向（静默结束）。
#[cfg(windows)]
fn finish_gesture(app: &AppHandle, pattern: &str) {
    // 画手势录制模式：只把识别结果广播给面板（不执行动作），HUD 同步收场。
    // 空手势同样广播（面板提示「未识别」），HUD 不会残留。
    if RECORDING.load(Ordering::Acquire) {
        RECORDING.store(false, Ordering::Release);
        let owner = RECORDING_PLUGIN.lock().ok().and_then(|mut g| g.take());
        let _ = app.emit(
            "my-search://gesture-record",
            serde_json::json!({ "pluginId": owner, "pattern": pattern }),
        );
        // recording:true → HUD 显示「已录制 xx」而非「未映射」（录制场景显示
        // 未映射是误导）；空手势仍 silent（HUD 立即收场，面板提示未识别）。
        let _ = app.emit(
            EVENT_GESTURE_RESULT,
            serde_json::json!({ "pattern": pattern, "matched": false, "recording": true, "silent": pattern.is_empty() }),
        );
        return;
    }
    if pattern.is_empty() {
        // 静默结束也要发 result：HUD 页面靠它自隐藏（漏发 = 全屏透明窗残留挡左键）
        let _ = app.emit(
            EVENT_GESTURE_RESULT,
            serde_json::json!({ "pattern": "", "matched": false, "silent": true }),
        );
        return;
    }
    let Some((owner_id, binding)) = find_binding(pattern) else {
        // 未映射的手势：HUD 显示识别结果但不执行
        let _ = app.emit(
            EVENT_GESTURE_RESULT,
            serde_json::json!({ "pattern": pattern, "matched": false }),
        );
        return;
    };
    let label = binding
        .label
        .clone()
        .unwrap_or_else(|| action_label(&binding.action));
    let _ = app.emit(
        EVENT_GESTURE_RESULT,
        serde_json::json!({ "pattern": pattern, "matched": true, "label": label }),
    );
    // 权限二次校验（按映射归属插件动态校验 `gesture.exec`，宿主不硬编码插件 id）：
    let granted = plugin_host::gateway_get(&owner_id)
        .map(|s| s.enabled && plugin_host::has_base_permission(&s, "gesture.exec"))
        .unwrap_or(false);
    if !granted {
        let _ = app.emit(
            EVENT_GESTURE_RESULT,
            serde_json::json!({ "pattern": pattern, "matched": true, "label": label, "denied": true }),
        );
        eprintln!("[手势] 插件 {owner_id} 未授予 gesture.exec，拒绝执行「{label}」");
        return;
    }
    let action = binding.action;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = execute_action(&app, &action) {
            eprintln!("[手势] 动作执行失败: {e}");
        }
    });
}

// ===================== 钩子与安装（Windows） =====================

/// 触发键：Ctrl（按住右键拖拽才触发；GetAsyncKeyState 最高位 = 按下）
#[cfg(windows)]
fn trigger_held() -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL};
    unsafe { GetAsyncKeyState(VK_CONTROL as i32) < 0 }
}

#[cfg(windows)]
fn install_hook() -> Result<(), String> {
    if HOOK.load(Ordering::Acquire) != 0 {
        return Ok(());
    }
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{SetWindowsHookExW, WH_MOUSE_LL};
    unsafe {
        let hmod = GetModuleHandleW(std::ptr::null());
        if hmod.is_null() {
            return Err("获取模块句柄失败".into());
        }
        let hook = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook_proc), hmod, 0);
        if hook.is_null() {
            return Err("安装鼠标钩子失败".into());
        }
        HOOK.store(hook as isize, Ordering::Release);
        Ok(())
    }
}

#[cfg(windows)]
fn uninstall_hook() {
    let prev = HOOK.swap(0, Ordering::AcqRel);
    if prev != 0 {
        use windows_sys::Win32::UI::WindowsAndMessaging::{UnhookWindowsHookEx, HHOOK};
        unsafe {
            let _ = UnhookWindowsHookEx(prev as HHOOK);
        }
        HELD.store(false, Ordering::Release);
        ACTIVE.store(false, Ordering::Release);
        RECORDING.store(false, Ordering::Release);
        eprintln!("[手势] 已卸载低级鼠标钩子（插件未启用或总开关已关）");
    }
}

/// 手势吞掉真实 RBUTTONUP 后补发合成 UP，复位「右键按下」状态。
///
/// 低级钩子返回 1 只阻止消息投递，目标窗口因此只收到 RBUTTONDOWN、收不到
/// RBUTTONUP，右键状态悬挂：表现为命令行窗口的关闭按钮点了没反应，必须
/// 再右击一次（产生一对完整 DOWN/UP）才恢复正常。补发前先给鼠标下的顶层
/// 窗口发 WM_CANCELMODE 取消右键菜单跟踪，避免合成 UP 弹出上下文菜单；
/// 合成事件带 LLMHF_INJECTED 标志，钩子识别后直接放行。
#[cfg(windows)]
fn release_right_button_state(x: i32, y: i32) {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_RIGHTUP, MOUSEINPUT,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetAncestor, PostMessageW, WindowFromPoint, GA_ROOT, WM_CANCELMODE,
    };
    unsafe {
        // 1) 取消鼠标下窗口的右键菜单跟踪（否则合成 UP 会弹右键菜单）
        let hwnd = WindowFromPoint(POINT { x, y });
        if !hwnd.is_null() {
            let root = GetAncestor(hwnd, GA_ROOT);
            if !root.is_null() {
                let _ = PostMessageW(root, WM_CANCELMODE, 0, 0);
            }
        }
        // 2) 合成一个 RBUTTONUP（dx/dy=0），让系统/应用复位右键按下状态
        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: 0,
                    dy: 0,
                    mouseData: 0,
                    dwFlags: MOUSEEVENTF_RIGHTUP,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        SendInput(1, &input, core::mem::size_of::<INPUT>() as i32);
    }
}

/// 低级鼠标钩子回调：只做按键判断 + channel 投递（极轻，同 alt_click 铁律）。
///
/// - RBUTTONDOWN：按住触发键（Ctrl）才投递 Down，否则不碰会话（右键行为原样）；
/// - RBUTTONUP：**手势已激活才吞掉**（返回 1，右键菜单不弹）；未激活原样放行——
///   普通 Ctrl+右键 / 纯右键的菜单照常弹出；
/// - 其余消息一律透传。
#[cfg(windows)]
unsafe extern "system" fn mouse_hook_proc(
    code: i32,
    wparam: windows_sys::Win32::Foundation::WPARAM,
    lparam: windows_sys::Win32::Foundation::LPARAM,
) -> windows_sys::Win32::Foundation::LRESULT {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, LLMHF_INJECTED, MSLLHOOKSTRUCT, WM_MOUSEMOVE, WM_RBUTTONDOWN, WM_RBUTTONUP,
    };
    if code < 0 {
        return CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam);
    }
    if ENABLED.load(Ordering::Relaxed) {
        let msg = &*(lparam as *const MSLLHOOKSTRUCT);
        let (x, y) = (msg.pt.x, msg.pt.y);
        let msg_id = wparam as u32;
        // 本模块补发的合成 RBUTTONUP（带 LLMHF_INJECTED）必须放行：
        // 让系统/目标窗口收到 UP —— 否则又回到「只 DOWN 不 UP」的悬挂态。
        // 右键菜单已在补发前用 WM_CANCELMODE 取消，不会弹出。
        if msg_id == WM_RBUTTONUP && (msg.flags & LLMHF_INJECTED) != 0 {
            return CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam);
        }
        match msg_id {
            WM_RBUTTONDOWN => {
                if trigger_held() {
                    HELD.store(true, Ordering::Release);
                    if let Some(tx) = MSG_TX.get() {
                        let _ = tx.send(GestureEv::Down { x, y });
                    }
                }
            }
            WM_MOUSEMOVE => {
                // 会话进行中才投递移动——判断是一个 AtomicBool 负载检查（无锁无分配），
                // 满足低级钩子「回调必须极快」铁律；每条 move 都发，由识别线程节流。
                if HELD.load(Ordering::Relaxed) {
                    if let Some(tx) = MSG_TX.get() {
                        let _ = tx.send(GestureEv::Move { x, y });
                    }
                }
            }
            WM_RBUTTONUP => {
                // 吞不吞必须在**回调里**同步决定（返回 1 才有效），
                // 读激活镜像（识别线程维护）而非锁。
                HELD.store(false, Ordering::Release);
                if ACTIVE.load(Ordering::Acquire) {
                    if let Some(tx) = MSG_TX.get() {
                        let _ = tx.send(GestureEv::Up { x, y });
                    }
                    return 1; // 吞掉：右键菜单不弹
                }
            }
            _ => {}
        }
    }
    CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
}

// ===================== 生命周期与按需启停 =====================

/// 按「是否有启用插件获授 `gesture.exec` + 用户总开关」动态装卸低级鼠标钩子（幂等）。
///
/// 关键解耦：不再在宿主启动时无条件挂 `WH_MOUSE_LL` 钩子——未安装或禁用手势插件时
/// 系统层零鼠标钩子、零 HUD 窗口；启用或新安装手势插件后经主线程消息循环即时挂载。
#[cfg(windows)]
pub fn sync_active(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let active_ids = plugin_host::active_plugin_ids_with_grant("gesture.exec");
    for pid in &active_ids {
        ensure_plugin_bindings_loaded(app, pid);
    }

    let should_run = ENABLED.load(Ordering::Relaxed) && !active_ids.is_empty();
    if should_run {
        if !WORKER_STARTED.swap(true, Ordering::AcqRel) {
            let (tx, rx) = std::sync::mpsc::channel::<GestureEv>();
            let _ = MSG_TX.set(tx);
            if std::thread::Builder::new()
                .name("mouse-gesture".into())
                .spawn(move || {
                    recognizer_loop(rx, |v| ACTIVE.store(v, Ordering::Release));
                })
                .is_err()
            {
                WORKER_STARTED.store(false, Ordering::Release);
                eprintln!("[手势] 识别线程启动失败，鼠标手势不可用");
                return;
            }
        }
        if HOOK.load(Ordering::Acquire) == 0 {
            let main_app = app.clone();
            let _ = app.run_on_main_thread(move || {
                if ENABLED.load(Ordering::Relaxed)
                    && plugin_host::any_plugin_granted("gesture.exec")
                {
                    if let Err(e) = install_hook() {
                        eprintln!("[手势] {e}");
                    } else {
                        eprintln!("[手势] 鼠标手势监听已按需激活（Ctrl + 右键拖拽）");
                    }
                }
            });
            let hud_app = main_app;
            tauri::async_runtime::spawn(async move {
                if let Err(e) = ensure_hud_window(&hud_app).await {
                    eprintln!("[手势] {e}");
                }
            });
        }
    } else {
        if HOOK.load(Ordering::Acquire) != 0 {
            let _ = app.run_on_main_thread(|| {
                uninstall_hook();
            });
        }
        if let Some(w) = app.get_webview_window(GESTURE_HUD_LABEL) {
            let _ = w.hide();
        }
    }
}

#[cfg(not(windows))]
pub fn sync_active(_app: &AppHandle) {}

/// 退出应用时卸掉低级鼠标钩子（幂等）。
#[cfg(windows)]
pub fn uninstall() {
    uninstall_hook();
}

#[cfg(not(windows))]
pub fn uninstall() {}

/// 写开关（启动时按落盘偏好调用）
pub fn set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
}

/// 读取启用开关（需调用方插件处于启用态）
#[tauri::command]
pub fn gesture_get_enabled(plugin_id: String) -> Result<bool, String> {
    plugin_host::require_enabled(&plugin_id)?;
    Ok(ENABLED.load(Ordering::Relaxed))
}

/// 写入启用开关（需 `gesture.exec` 权限；置位即触发钩子按需装卸并落盘偏好）
#[tauri::command]
pub fn gesture_set_enabled(
    app: tauri::AppHandle,
    plugin_id: String,
    enabled: bool,
) -> Result<(), String> {
    plugin_host::require_grant(&plugin_id, "gesture.exec")?;
    ENABLED.store(enabled, Ordering::Relaxed);
    if let Some(store) = crate::settings_store(&app) {
        store.set("gesture_enabled", serde_json::Value::Bool(enabled));
        if let Err(e) = store.save() {
            eprintln!("保存鼠标手势设置失败: {e}");
        }
    }
    sync_active(&app);
    Ok(())
}

/// 进入「画手势录制」模式：下一次 Ctrl+右键手势只识别不执行，
/// 松手时广播 my-search://gesture-record 携带归属 pluginId 与方向串。
#[tauri::command]
pub fn gesture_record_start(app: AppHandle, plugin_id: String) -> Result<(), String> {
    plugin_host::require_grant(&plugin_id, "gesture.exec")?;
    sync_active(&app);
    if let Ok(mut g) = RECORDING_PLUGIN.lock() {
        *g = Some(plugin_id);
    }
    RECORDING.store(true, Ordering::Release);
    // HUD 同步进入「录制中」：show + 提示（轨迹照画，动作不执行）。
    show_hud(&app, None);
    let _ = app.emit(
        EVENT_GESTURE_RESULT,
        serde_json::json!({ "pattern": "", "matched": false, "recording": true }),
    );
    Ok(())
}

/// 退出「画手势录制」模式（面板取消 / 面板销毁时调用）。
#[tauri::command]
pub fn gesture_record_cancel(app: AppHandle, plugin_id: String) -> Result<(), String> {
    plugin_host::require_grant(&plugin_id, "gesture.exec")?;
    RECORDING.store(false, Ordering::Release);
    if let Ok(mut g) = RECORDING_PLUGIN.lock() {
        if g.as_deref() == Some(plugin_id.as_str()) {
            *g = None;
        }
    }
    // HUD 可能停在「录制中」提示上：发 silent result 让它立即收场
    let _ = app.emit(
        EVENT_GESTURE_RESULT,
        serde_json::json!({ "pattern": "", "matched": false, "silent": true }),
    );
    Ok(())
}

/// 从 settings.json 读偏好（None = 从未配置，按默认开）
pub fn read_gesture_pref(app: &tauri::AppHandle) -> Option<bool> {
    crate::settings_store(app)
        .and_then(|store| store.get("gesture_enabled"))
        .and_then(|v| v.as_bool())
}

/// 读取调用方插件自己的手势映射表（懒加载快照）
#[tauri::command]
pub fn gesture_bindings_list(
    app: tauri::AppHandle,
    plugin_id: String,
) -> Result<Vec<GestureBinding>, String> {
    plugin_host::require_enabled(&plugin_id)?;
    ensure_plugin_bindings_loaded(&app, &plugin_id);
    Ok(bindings_snapshot_of(&plugin_id))
}

/// 列出当前有可见窗口的运行中进程（需 `gesture.exec` 权限）。
/// 按 exe 路径去重（同程序多窗口只保留 Z 序最顶者），排除本应用自身，上限 200 条。
#[tauri::command]
pub fn gesture_list_processes(plugin_id: String) -> Result<Vec<RunningProcessDto>, String> {
    plugin_host::require_grant(&plugin_id, "gesture.exec")?;
    #[cfg(windows)]
    {
        let mut seen = std::collections::HashSet::new();
        let mut out = Vec::new();
        for w in enumerate_window_processes() {
            if !seen.insert(w.exe_path.to_lowercase()) {
                continue;
            }
            let name = std::path::Path::new(&w.exe_path)
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| w.exe_path.clone());
            out.push(RunningProcessDto {
                pid: w.pid,
                name,
                exe_path: w.exe_path,
                title: w.title,
            });
            if out.len() >= 200 {
                break;
            }
        }
        Ok(out)
    }
    #[cfg(not(windows))]
    Ok(Vec::new())
}

/// 清洗手势绑定列表（纯函数：只留 UDLR、去重、上限 64 条）
fn clean_gesture_bindings(bindings: Vec<GestureBinding>) -> Vec<GestureBinding> {
    let mut cleaned: Vec<GestureBinding> = Vec::new();
    for mut b in bindings {
        b.pattern = b
            .pattern
            .chars()
            .filter(|c| matches!(c, 'U' | 'D' | 'L' | 'R'))
            .collect();
        if b.pattern.is_empty() || cleaned.iter().any(|c| c.pattern == b.pattern) {
            continue;
        }
        cleaned.push(b);
        if cleaned.len() >= 64 {
            break;
        }
    }
    cleaned
}

/// 写入调用方插件自己的映射表（需 `gesture.exec` 权限；全量覆盖式，含清洗与落盘）
#[tauri::command]
pub fn gesture_bindings_sync(
    app: tauri::AppHandle,
    plugin_id: String,
    bindings: Vec<GestureBinding>,
) -> Result<(), String> {
    plugin_host::require_grant(&plugin_id, "gesture.exec")?;
    let cleaned = clean_gesture_bindings(bindings);
    if let Ok(mut g) = BINDINGS.lock() {
        g.insert(plugin_id.clone(), cleaned);
    }
    save_bindings_snapshot(&app, &plugin_id);
    sync_active(&app);
    Ok(())
}

/// 某插件映射快照落盘路径（`plugin-data/<plugin_id>/gesture-bindings.json`）
fn bindings_snapshot_path(app: &tauri::AppHandle, plugin_id: &str) -> Option<std::path::PathBuf> {
    crate::plugin_host::plugin_data_dir(app, plugin_id)
        .ok()
        .map(|d| d.join("gesture-bindings.json"))
}

/// 快照写入（按插件隔离落盘）
fn save_bindings_snapshot(app: &tauri::AppHandle, plugin_id: &str) {
    let Some(path) = bindings_snapshot_path(app, plugin_id) else {
        return;
    };
    let list = bindings_snapshot_of(plugin_id);
    let Ok(json) = serde_json::to_string(&list) else {
        return;
    };
    if std::fs::write(&path, json).is_err() {
        eprintln!("[手势] 写映射快照失败（{plugin_id}）");
    }
}

/// 按插件懒加载映射快照（仅当内存表中尚未记录该插件条目时从磁盘恢复；
/// 用户主动保存为空数组后内存已有 `Some([])`，不会回填旧文件）。
fn ensure_plugin_bindings_loaded(app: &tauri::AppHandle, plugin_id: &str) {
    let already_loaded = BINDINGS
        .lock()
        .ok()
        .map(|g| g.contains_key(plugin_id))
        .unwrap_or(true);
    if already_loaded {
        return;
    }
    let list = bindings_snapshot_path(app, plugin_id)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|json| serde_json::from_str::<Vec<GestureBinding>>(&json).ok())
        .unwrap_or_default();
    if let Ok(mut g) = BINDINGS.lock() {
        g.entry(plugin_id.to_string()).or_insert(list);
    }
}

/// 创建手势轨迹 HUD（常驻隐藏；首次手势前由 install 调用一次）。
/// **必须 async**：Windows 同步命令里建 WebView2 窗口会死锁（wry#583，同贴图）。
pub async fn ensure_hud_window(app: &AppHandle) -> Result<(), String> {
    use tauri::{PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};
    if let Some(w) = app.get_webview_window(GESTURE_HUD_LABEL) {
        // 已存在：确保隐藏（手势结束后页面自己 hide，这里兜底）
        let _ = w.hide();
        return Ok(());
    }
    let win = WebviewWindowBuilder::new(
        app,
        GESTURE_HUD_LABEL,
        WebviewUrl::App("gesture.html".into()),
    )
    .title("手势")
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .focused(false)
    .resizable(false)
    .visible(false)
    .build()
    .map_err(|e| format!("创建手势 HUD 失败: {e}"))?;
    let _ = win.set_position(PhysicalPosition::new(0, 0));
    let _ = win.set_size(PhysicalSize::new(3840, 2160));
    let _ = win.set_ignore_cursor_events(true); // 鼠标穿透：HUD 绝不挡操作
    Ok(())
}

// ===================== HUD 显示/隐藏（手势开始时 show，结束时 hide） =====================

/// 虚拟屏幕包围盒（所有显示器的联合；钩子坐标即虚拟屏幕坐标系）。
/// 取不到显示器信息时退回 (0,0) 起 4K 估界（旧行为兜底）。
fn virtual_screen_bounds(app: &AppHandle) -> (i32, i32, u32, u32) {
    let mut min_x = 0i32;
    let mut min_y = 0i32;
    let mut max_x = 0i32;
    let mut max_y = 0i32;
    if let Ok(monitors) = app.available_monitors() {
        for m in monitors {
            let p = m.position();
            let s = m.size();
            min_x = min_x.min(p.x);
            min_y = min_y.min(p.y);
            max_x = max_x.max(p.x + s.width as i32);
            max_y = max_y.max(p.y + s.height as i32);
        }
    }
    if max_x <= min_x || max_y <= min_y {
        return (0, 0, 3840, 2160);
    }
    (min_x, min_y, (max_x - min_x) as u32, (max_y - min_y) as u32)
}

/// HUD 显示（手势激活时由识别线程调用；事件驱动页面画线）。
/// 窗口未就绪时静默放弃（轨迹反馈是锦上添花，不该影响手势本身）。
fn show_hud(app: &AppHandle, bounds: Option<(i32, i32, u32, u32)>) {
    if let Some(w) = app.get_webview_window(GESTURE_HUD_LABEL) {
        // 每次显示前先对齐虚拟屏幕包围盒——钩子坐标即虚拟屏坐标系，多屏或主屏
        // 不在 (0,0) 时写死 (0,0) 起 4K 会整体错位；再**重新断言 TOPMOST**：
        // 置顶只是建窗那一刻的快照，之后新建的置顶窗（如贴图窗）会压在 HUD 上。
        // bounds 由调用方在激活时算好传入（available_monitors 是同步跨线程调用，
        // 不能每条轨迹事件都跑一遍）；None = 调用方没算过，这里现算。
        let (vx, vy, vw, vh) = bounds.unwrap_or_else(|| virtual_screen_bounds(app));
        let _ = w.set_position(tauri::PhysicalPosition::new(vx, vy));
        let _ = w.set_size(tauri::PhysicalSize::new(vw, vh));
        let _ = w.set_always_on_top(true);
        let _ = w.show();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direction_of_prefers_longer_axis() {
        assert_eq!(direction_of(30.0, 5.0), 'R');
        assert_eq!(direction_of(-30.0, 5.0), 'L');
        assert_eq!(direction_of(5.0, 30.0), 'D');
        assert_eq!(direction_of(5.0, -30.0), 'U');
    }

    #[test]
    fn recognizer_activates_after_threshold() {
        let mut rec = PatternRecognizer::new();
        // 10px 拖拽：未激活
        assert_eq!(rec.feed(10.0, 0.0), "");
        // 40px：激活 + 识别出 R
        assert_eq!(rec.feed(40.0, 0.0), "R");
    }

    #[test]
    fn recognizer_corner_turns_two_dirs() {
        // 右→下直角轨迹（FlowMouse 同款锚点推进）
        let mut rec = PatternRecognizer::new();
        let mut p = String::new();
        for pt in [
            [10.0, 0.0],
            [40.0, 0.0],
            [80.0, 5.0],
            [80.0, 45.0],
            [78.0, 90.0],
        ] {
            let s = rec.feed(pt[0], pt[1]);
            if !s.is_empty() {
                p = s;
            }
        }
        assert_eq!(p, "RD");
    }

    #[test]
    fn tiny_jitter_does_not_split_direction() {
        // 同向带轻微抖动的长轨迹：仍是单方向 R
        let mut rec = PatternRecognizer::new();
        let mut p = String::new();
        for i in 0..12 {
            let s = rec.feed(f64::from(i) * 10.0, f64::from(i % 2) * 2.0);
            if !s.is_empty() {
                p = s;
            }
        }
        assert_eq!(p, "R");
    }

    #[test]
    fn default_bindings_cover_required_actions() {
        // 推荐映射（面板「导入默认映射」的数据源，不再自动注入）
        let list = default_bindings();
        let patterns: Vec<&str> = list.iter().map(|b| b.pattern.as_str()).collect();
        for p in ["D", "L", "R", "UD", "DU"] {
            assert!(patterns.contains(&p), "推荐映射缺 {p}");
        }
        assert!(list.iter().any(|b| matches!(b.action, GestureAction::Shutdown)));
        assert!(list.iter().any(|b| matches!(b.action, GestureAction::Reboot)));
        assert!(list.iter().any(|b| matches!(b.action, GestureAction::Terminal)));
        assert!(list.iter().any(|b| matches!(b.action, GestureAction::Explorer { .. })));
        assert!(list.iter().any(|b| matches!(b.action, GestureAction::KillForeground)));
    }

    #[test]
    fn action_serde_roundtrip() {
        // 前端下发 JSON ↔ Rust 枚举（tag = "type"）
        let json = r#"{"pattern":"UR","action":{"type":"open","target":"D:/tools/a.exe"},"label":null}"#;
        let b: GestureBinding = serde_json::from_str(json).expect("解析失败");
        assert_eq!(b.pattern, "UR");
        assert_eq!(b.action, GestureAction::Open { target: "D:/tools/a.exe".into() });
        let back = serde_json::to_string(&b).expect("序列化失败");
        assert!(back.contains(r#""type":"open""#));
    }

    #[test]
    fn focus_process_serde_roundtrip() {
        let json = r#"{"pattern":"U","action":{"type":"focus-process","exePath":"C:/Program Files/App/app.exe","title":"文档"},"label":null}"#;
        let b: GestureBinding = serde_json::from_str(json).expect("解析失败");
        assert_eq!(
            b.action,
            GestureAction::FocusProcess {
                exe_path: "C:/Program Files/App/app.exe".into(),
                title: Some("文档".into()),
            }
        );
        let back = serde_json::to_string(&b).expect("序列化失败");
        assert!(back.contains(r#""type":"focus-process""#));
        assert!(back.contains(r#""exePath""#));
        // title / label 缺省（旧快照兼容）
        let json2 = r#"{"pattern":"D","action":{"type":"focus-process","exePath":"C:/a.exe"}}"#;
        let b2: GestureBinding = serde_json::from_str(json2).expect("解析失败");
        assert_eq!(b2.label, None);
    }

    #[test]
    fn trail_json_shape() {
        let v = trail_json(&[(1, 2), (3, 4)]);
        assert_eq!(v, vec![vec![1, 2], vec![3, 4]]);
    }
}
