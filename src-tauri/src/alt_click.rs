//! 资源管理器「Alt+点击文件/文件夹」→ 呼出搜索框并附加该文件。
//!
//! 事件链与「打开插件快捷键」（`open_plugin_by_shortcut`）同构：
//! `show_main_window` 先广播窗口已显示（前端据此复位视图、清掉旧附件），
//! 再广播带 `paths` 载荷的事件——同一投递通道顺序保证「先复位、后注入」。
//!
//! 设计约束：
//! - 全局低级鼠标钩子**只观察不吞事件**：资源管理器原有点击行为零改动
//!   （点击照常选中文件，反而让「读唯一选中项 = 点击项」这条推理成立）。
//! - 钩子回调必须极轻：低级钩子处理超时会被系统静默卸载，
//!   所以回调里只判断 + 记录坐标，UIA/COM 解析全部放异步任务。
//! - 解析逐级降级，任何一步失败都静默放弃（不弹错、绝不误带其它文件）。
//! - **呼出窗口必须在主线程执行**（见 `handle_click`）：低级钩子回调由
//!   `tauri::async_runtime::spawn` 派发到 tokio 工作线程，而
//!   `force_foreground` 的 `AttachThreadInput` 依赖「当前线程 == 窗口所属
//!   线程」，在 tokio 线程上附着会失效、窗口置不了前，表现为「呼出后输入框
//!   不聚焦」。故解析留在 tokio，`show_main_window`/广播切回主线程。
//!
//! 两个曾导致「按了完全没反应」的坑（都有回归日志可查）：
//! 1. **UIA 命中元素不是 ListItem**：Explorer 的文件名是叠在条目上的内联
//!    编辑框，`ElementFromPoint` 返回 `ControlType.Edit`。若直接比对命中元素
//!    的控制类型，每次正常点击都会被判成「非条目」而放弃。改为沿 UIA 父链
//!    向上找 ListItem/DataItem 祖先（见 `find_item_ancestor`）。
//! 2. **呼出即被失焦规则隐藏**：Alt+点击让资源管理器取得前台，随后我们
//!    `show()` 时 Windows 前台锁定会拒绝夺焦，窗口刚显示就收到失焦事件而被
//!    「失焦即隐藏」收掉。需要在 lib.rs 侧配合：`force_foreground`（attach
//!    输入队列后 SetForegroundWindow）＋ `SUPPRESS_BLUR_UNTIL_MS` 短暂抑制失焦隐藏。

use std::sync::atomic::{AtomicBool, AtomicI32, AtomicIsize, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use tauri::Emitter;
use windows::core::{GUID, Interface};
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows::Win32::System::Variant::{VARIANT, VT_I4};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, UIA_DataItemControlTypeId,
    UIA_ListItemControlTypeId, UIA_PaneControlTypeId,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL, VK_MENU, VK_SHIFT};
use windows::Win32::UI::Shell::{
    FOLDERID_Desktop, IShellFolderViewDual, IShellWindows, IWebBrowser2, KF_FLAG_DEFAULT,
    SHGetKnownFolderPath,
};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, CallNextHookEx, GetAncestor, GetClassNameW, GetForegroundWindow,
    GetWindowThreadProcessId, IsIconic, SetForegroundWindow, SetWindowsHookExW, ShowWindow,
    WindowFromPoint, GA_ROOT, MSLLHOOKSTRUCT, SW_RESTORE, WM_LBUTTONDOWN, WM_LBUTTONUP, WH_MOUSE_LL,
};

/// CLSID_ShellWindows（IShellWindows 集合的实现类）。
/// windows crate 未导出该常量，按 Windows SDK（ExDisp.Idl）手工登记。
const CLSID_SHELL_WINDOWS: GUID =
    GUID::from_u128(0x9ba05972_f6a8_11cf_a442_00a0c90a8f39);

/// 功能开关：settings.json 的 `alt_click_attach`（lib.rs 启动时写入）。
/// 钩子回调首行检查——关闭时近零开销直接放行，钩子本体常驻不卸载。
static ENABLED: AtomicBool = AtomicBool::new(true);
/// 应用句柄（install 时写入，钩子回调用它把解析任务投递到异步运行时）
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
/// 钩子句柄（进程期保活；卸载只在进程退出时由系统回收）
#[allow(dead_code)]
static HOOK: AtomicIsize = AtomicIsize::new(0);
/// 「按下时按住了 Alt（且仅 Alt）」→ 抬起时触发解析
static PENDING: AtomicBool = AtomicBool::new(false);
static PENDING_X: AtomicI32 = AtomicI32::new(0);
static PENDING_Y: AtomicI32 = AtomicI32::new(0);

/// 读取当前开关（供设置命令）
pub fn is_enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// 写入开关（供设置命令；置位即生效，钩子无需重装）
pub fn set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
}

/// 安装全局低级鼠标钩子（幂等；失败只打日志——功能缺失不阻断应用启动）。
/// 必须在带消息循环的主线程调用（lib.rs 的 `.setup()` 满足），
/// 回调经安装线程的消息队列派发。
pub fn install(app: tauri::AppHandle) {
    let _ = APP.set(app);
    unsafe {
        let hmod = match GetModuleHandleW(None) {
            Ok(h) => h,
            Err(e) => {
                eprintln!("获取模块句柄失败，Alt+点击带入不可用: {e}");
                return;
            }
        };
        match SetWindowsHookExW(WH_MOUSE_LL, Some(hook_proc), Some(HINSTANCE(hmod.0)), 0) {
            Ok(hook) => HOOK.store(hook.0 as isize, Ordering::Release),
            Err(e) => eprintln!("安装 Alt+点击鼠标钩子失败: {e}"),
        }
    }
}

/// 低级鼠标钩子回调。保持极轻：只判断按键与记录坐标，
/// 任何 COM/UIA 调用都禁止放在这里（超时会被系统卸载钩子）。
///
/// 手势判定（按下瞬间）：按住 Alt，且**未**同时按 Ctrl/Shift——
/// 只有纯 Alt+单击才是「普通单击」语义：选中项 == 点击项，
/// 后续按「唯一选中项」读取路径才可靠；混按 Ctrl/Shift 属于
/// 多选手势，选中集不等于点击项，直接放弃。
unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 && ENABLED.load(Ordering::Relaxed) {
        match wparam.0 as u32 {
            WM_LBUTTONDOWN => {
                let alt = GetAsyncKeyState(VK_MENU.0 as i32);
                diag(&format!("DOWN alt={alt} x={:?}", &(*(lparam.0 as *const MSLLHOOKSTRUCT)).pt.x));
                if alt < 0
                    && GetAsyncKeyState(VK_CONTROL.0 as i32) >= 0
                    && GetAsyncKeyState(VK_SHIFT.0 as i32) >= 0
                {
                    let msg = &*(lparam.0 as *const MSLLHOOKSTRUCT);
                    PENDING_X.store(msg.pt.x, Ordering::Relaxed);
                    PENDING_Y.store(msg.pt.y, Ordering::Relaxed);
                    PENDING.store(true, Ordering::Relaxed);
                }
            }
            WM_LBUTTONUP => {
                if PENDING.swap(false, Ordering::Relaxed) {
                    let (x, y) = (
                        PENDING_X.load(Ordering::Relaxed),
                        PENDING_Y.load(Ordering::Relaxed),
                    );
                    if let Some(app) = APP.get().cloned() {
                        tauri::async_runtime::spawn(async move {
                            // 回调跑在资源管理器处理 UP 消息**之前**，稍等让它先把
                            // 点击处理完（选中/聚焦落定），UIA/COM 读取才拿得到新状态。
                            tokio::time::sleep(Duration::from_millis(30)).await;
                            handle_click(app, x, y);
                        });
                    }
                }
            }
            _ => {}
        }
    }
    // 只观察不吞：永远继续传递，资源管理器行为原样保留
    CallNextHookEx(None, code, wparam, lparam)
}

/// 把窗口强行带到前台。
///
/// 背景：Alt+点击发生在资源管理器里，点击后资源管理器是前台窗口。此后我们
/// `show()` 自己的窗口时，Windows 的前台锁定（foreground lock）会拒绝后台
/// 进程直接 `SetForegroundWindow`——窗口能显示但**不在最前、不聚焦**，
/// 于是立刻被「失焦即隐藏」规则收掉，表现为点了没反应。
///
/// 绕过办法：先把本线程输入队列 attach 到当前前台窗口的线程，使两者共享
/// 输入状态，此时 `SetForegroundWindow` 不再被拒；随后 `BringWindowToTop`
/// 保证 z 序。失败也不致命（窗口至少已 show）。
pub fn force_foreground(hwnd: HWND) {
    unsafe {
        if hwnd.0.is_null() {
            return;
        }
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        let fg = GetForegroundWindow();
        let fg_thread = if fg.0.is_null() {
            0
        } else {
            GetWindowThreadProcessId(fg, None)
        };
        let my_thread = GetCurrentThreadId();
        let attached = fg_thread != 0 && fg_thread != my_thread;
        if attached {
            let _ = AttachThreadInput(my_thread, fg_thread, true);
        }
        let ok = SetForegroundWindow(hwnd).as_bool();
        let _ = BringWindowToTop(hwnd);
        if attached {
            let _ = AttachThreadInput(my_thread, fg_thread, false);
        }
        if !ok {
            // 不致命：窗口至少已 show；仅记录以便排查「窗口在后台」类问题
            diag("force_foreground: SetForegroundWindow 被拒（前台锁定）");
        }
    }
}

/// 诊断日志：解析失败 / 关键异常时输出一行到 stderr。
///
/// 刻意只在「有信息量」的失败点调用（而非每次点击都打）：Alt+点击是高频手势，
/// 逐事件打日志会污染 stderr；但解析链路任一环节失败都静默放弃，没有日志就
/// 完全无法排查「按了没反应」，因此保留失败点。
fn diag(msg: &str) {
    eprintln!("[Alt点击] {msg}");
}

/// 异步任务：解析点击点 → 命中文件则呼出主窗口并广播附件路径。
///
/// 解析（UIA/COM）留在 tokio 工作线程（避免阻塞事件循环）；但**呼出窗口
/// 必须切回主线程**：`show_main_window` 内部的 `force_foreground` 用
/// `GetCurrentThreadId()` 做 `AttachThreadInput` 来绕过 Windows 前台锁定，
/// 只有当前线程是**窗口所属线程（主线程）**时附加才有效。若直接在 tokio
/// 线程上呼出，附着的是无窗口的工作线程，`SetForegroundWindow` 常被拒，
/// 窗口只 show 不置前/不聚焦——这正是「Alt+点击带入后输入框不聚焦」的根因。
fn handle_click(app: tauri::AppHandle, x: i32, y: i32) {
    // tokio 工作线程首次用到 COM 时初始化为 STA；已初始化返回 S_FALSE 也接受。
    // 不配对 CoUninitialize：线程会被运行时复用，保持初始化态最安全。
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }
    let Some(path) = resolve_clicked_path(x, y) else {
        diag(&format!("解析失败 x={x} y={y}"));
        return;
    };
    diag(&format!("命中 {path}"));
    // 与 open_plugin_by_shortcut 同构：先 show（内部广播窗口已显示 → 前端复位），
    // 再广播带载荷的事件（前端把路径并入附件）。必须用 show 而非 toggle——
    // toggle 在窗口可见时语义是「隐藏」。
    //
    // 切主线程执行：见本函数文档对 force_foreground 线程约束的说明。
    // 闭包会 move 走句柄，而 run_on_main_thread 借用调用者，故先克隆一份。
    let main_thread_app = app.clone();
    if let Err(e) = app.run_on_main_thread(move || {
        crate::show_main_window(&main_thread_app);
        if let Err(e) = main_thread_app.emit(
            crate::EVENT_ATTACH_PATHS,
            serde_json::json!({ "paths": [path] }),
        ) {
            diag(&format!("广播附件路径事件失败: {e}"));
        }
    }) {
        diag(&format!("切主线程呼出窗口失败: {e}"));
    }
}

/// 解析点击点下的文件/文件夹绝对路径；任何一步不满足即 None（静默放弃）。
fn resolve_clicked_path(x: i32, y: i32) -> Option<String> {
    unsafe {
        // 1) 根窗口类名门禁：只认资源管理器与桌面，其它应用一律不参与
        let hwnd = WindowFromPoint(POINT { x, y });
        if hwnd.0.is_null() {
            return None;
        }
        let root = GetAncestor(hwnd, GA_ROOT);
        let class = window_class(root);
        let is_explorer = matches!(class.as_str(), "CabinetWClass" | "ExploreWClass");
        let is_desktop = matches!(class.as_str(), "Progman" | "WorkerW");
        if !is_explorer && !is_desktop {
            return None;
        }

        // 2) UIA 命中校验：点击点必须落在文件/文件夹条目上（或其内部子元素上）。
        //    挡掉地址栏、工具栏、导航树、分组标题、空白处等误触发。
        //
        //    注意**不能**只判断命中元素本身：Explorer 的文件名是叠在 ListItem
        //    之上的内联编辑框（UIA 命中返回 ControlType.Edit），直接比对
        //    ListItem/DataItem 会把每一次正常点击都误判为「非条目」而全部放弃。
        //    正确做法是沿 UIA 父链向上找若干层，任一祖先为 ListItem/DataItem
        //    即通过；父链同时能挡掉工具栏/空白处（它们的祖先里没有条目）。
        let uia: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
        let el = uia.ElementFromPoint(POINT { x, y }).ok()?;
        // 桌面走另一条路径（按名称解析），不需要条目祖先校验
        let hit_item = if is_explorer {
            find_item_ancestor(&uia, &el)?
        } else {
            el.clone()
        };

        // 3) 按窗口类型取路径
        if is_explorer {
            explorer_selected_path(root, &hit_item)
        } else {
            desktop_item_path(&hit_item.CurrentName().ok()?.to_string())
        }
    }
}

/// 沿 UIA 父链向上查找「文件/文件夹条目」元素（ListItem / DataItem）。
///
/// 命中元素本身往往不是条目：Explorer 的文件名是叠在条目上的内联编辑框
/// （ControlType.Edit），看图/列表视图也可能命中图标等子元素。因此必须向上
/// 找祖先。限定搜索层数（条目通常就在 2~3 层内）并在 `ControlType.Pane`
/// （文件夹视图容器）处停止，避免一路爬到窗口根——那会让「点在空白处」
/// 也误配到某个条目。
fn find_item_ancestor(
    uia: &IUIAutomation,
    start: &IUIAutomationElement,
) -> Option<IUIAutomationElement> {
    unsafe {
        let walker = uia.ControlViewWalker().ok()?;
        let mut cur = Some(start.clone());
        let mut depth = 0;
        while let Some(el) = cur {
            match el.CurrentControlType() {
                Ok(ct) if ct == UIA_ListItemControlTypeId || ct == UIA_DataItemControlTypeId => {
                    return Some(el);
                }
                Ok(ct) if depth > 0 && ct == UIA_PaneControlTypeId => {
                    // 已到文件夹视图容器层，再往上就不是这一条目的范围了
                    return None;
                }
                _ => {}
            }
            depth += 1;
            // 最多向上 6 层（条目 → 列表 → 视图 → 宿主 → 标签页 → 窗口）
            if depth > 6 {
                return None;
            }
            cur = walker.GetParentElement(&el).ok();
        }
    }
    None
}

/// 资源管理器窗口：取「本次点击刚选中的唯一项」的绝对路径。
///
/// 手势限定纯 Alt 单击（钩子侧已排除 Ctrl/Shift），普通单击必然是单选
/// 且选中项 == 点击项，因此「选中集恰好 1 项」即可信。
/// 链路：IShellWindows 枚举匹配 hwnd → IWebBrowser2 → Document →
/// IShellFolderViewDual → SelectedItems → FolderItem.Path（绝对路径，
/// 非文件系统项返回空串，由 validate_fs_path 挡下）。
///
/// `hit` 是 UIA 命中校验定位到的条目元素（其 Name 即文件名，可能与显示名
/// 一致）。选中集恰好 1 项时用它做**交叉校验**：UIA 条目名与选中项显示名
/// 不一致说明「选中项 ≠ 点击项」（极端混选手势），放弃——宁可不动，也不
/// 误带另一个文件。选中集为多项时同样放弃。
fn explorer_selected_path(hwnd: HWND, hit: &IUIAutomationElement) -> Option<String> {
    unsafe {
        let wins: IShellWindows =
            CoCreateInstance(&CLSID_SHELL_WINDOWS, None, CLSCTX_ALL).ok()?;
        let count = wins.Count().ok()?;
        for i in 0..count {
            let Ok(disp) = wins.Item(&variant_i4(i)) else {
                continue;
            };
            let Ok(wb2) = disp.cast::<IWebBrowser2>() else {
                continue;
            };
            let Ok(found) = wb2.HWND() else {
                continue;
            };
            // wb2.HWND 有可能是窗口内子句柄，统一归到根窗口再比对
            let found_hwnd = HWND(found.0 as *mut core::ffi::c_void);
            let found_root = GetAncestor(found_hwnd, GA_ROOT);
            if found_root.0 != hwnd.0 {
                continue;
            }
            let doc = wb2.Document().ok()?;
            let view = doc.cast::<IShellFolderViewDual>().ok()?;
            let items = view.SelectedItems().ok()?;
            let n = items.Count().ok()?;
            // 多选 = 点击项不可从选中集推断（极端混按场景），放弃
            if n != 1 {
                return None;
            }
            let item = items.Item(&variant_i4(0)).ok()?;
            // 交叉校验：选中项显示名 == UIA 命中的条目名。不等说明选中的不是
            // 点击的那一个（例如选中态尚未落定就读取），放弃而不是误带。
            if let (Ok(hit_name), Ok(sel_name)) = (hit.CurrentName(), item.Name()) {
                let hit_name = hit_name.to_string();
                let sel_name = sel_name.to_string();
                if !hit_name.is_empty() && !sel_name.is_empty() && hit_name != sel_name {
                    diag(&format!(
                        "选中项与点击项不一致，放弃: hit='{hit_name}' selected='{sel_name}'"
                    ));
                    return None;
                }
            }
            let path = match item.Path() {
                Ok(p) => p.to_string(),
                Err(e) => {
                    diag(&format!("读取选中项路径失败: {e}"));
                    return None;
                }
            };
            return validate_fs_path(&path);
        }
    }
    None
}

/// 桌面：图标显示名 → 已知桌面目录解析（用户桌面优先，其次公共桌面）。
/// 快捷方式显示名通常不带 .lnk，补一次 `.lnk` 试探；解析不出真实文件则放弃。
fn desktop_item_path(name: &str) -> Option<String> {
    if name.is_empty() || name.contains(['\\', '/', '\0']) {
        return None;
    }
    let mut dirs: Vec<String> = Vec::new();
    unsafe {
        if let Ok(raw) = SHGetKnownFolderPath(&FOLDERID_Desktop, KF_FLAG_DEFAULT, None) {
            if !raw.0.is_null() {
                if let Ok(s) = raw.to_string() {
                    dirs.push(s);
                }
                CoTaskMemFree(Some(raw.0 as *const core::ffi::c_void));
            }
        }
    }
    if let Ok(public) = std::env::var("PUBLIC") {
        dirs.push(format!("{public}\\Desktop"));
    }
    for dir in dirs {
        // 先按原名（所见即所得），再补 .lnk（显示名隐藏了扩展名的快捷方式）
        for candidate in [format!("{dir}\\{name}"), format!("{dir}\\{name}.lnk")] {
            if let Some(p) = validate_fs_path(&candidate) {
                return Some(p);
            }
        }
    }
    None
}

/// 绝对文件系统路径（`X:\` 或 `\\UNC`）且真实存在才接受。
/// 此电脑 / 快速访问 / 压缩包命名空间等给出的非文件系统值在此被挡下。
fn validate_fs_path(path: &str) -> Option<String> {
    let p = path.trim();
    let b = p.as_bytes();
    let absolute = (b.len() >= 4
        && b[0].is_ascii_alphabetic()
        && b[1] == b':'
        && (b[2] == b'\\' || b[2] == b'/'))
        || (p.starts_with("\\\\") && p.len() > 2);
    if !absolute {
        return None;
    }
    match std::fs::metadata(p) {
        Ok(_) => Some(p.to_string()),
        Err(_) => None,
    }
}

/// 读取窗口类名（取不到返回空串）
fn window_class(hwnd: HWND) -> String {
    let mut buf = [0u16; 256];
    let len = unsafe { GetClassNameW(hwnd, &mut buf) };
    if len <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buf[..len as usize])
}

/// 构造 VT_I4 的 VARIANT（windows crate 未提供 From<i32>）。
/// 零初始化即 VT_EMPTY，随后在联合体里写 vt/lVal（均为 inline 字段，无分配、无需 VariantClear）。
fn variant_i4(v: i32) -> VARIANT {
    unsafe {
        let mut var: VARIANT = core::mem::zeroed();
        // ManuallyDrop 字段不做自动 DerefMut（避免意外触发析构），显式解引用写入
        (*var.Anonymous.Anonymous).vt = VT_I4;
        (*var.Anonymous.Anonymous).Anonymous.lVal = v;
        var
    }
}
