//! `.mspp` 插件包在 Windows 上的文件类型关联。
//!
//! ## 为什么需要它
//!
//! 插件包是 `.mspp` 后缀的 ZIP，但**Windows 不认识这个后缀**：资源管理器里
//! 显示成白纸图标、双击弹「你要如何打开这个文件？」。用户装了插件系统却
//! 拿不到「像装软件一样双击安装」的体验。
//!
//! ## 写在哪里
//!
//! 全部写 **HKCU\Software\Classes**（当前用户），不碰 HKLM：
//!   - 不需要管理员权限（安装包不弹 UAC，便携版也能用）；
//!   - 卸载/关闭开关时能干净清除，不残留机器级垃圾。
//!
//! 布局（`.mspp` → ProgID `MySearch.PluginPackage`）：
//!
//! ```text
//! HKCU\Software\Classes\.mspp
//!     (Default) = "MySearch.PluginPackage"
//! HKCU\Software\Classes\MySearch.PluginPackage
//!     (Default)                  = "MySearch 插件包"
//!     FriendlyTypeName           = "MySearch 插件包"
//!     DefaultIcon\(Default)      = "<资源目录>\resources\mspp.ico"
//!     shell\open\command\(Default) = "\"<exe>\" --install-plugin \"%1\""
//! ```
//!
//! ## 与「用户默认程序」的关系
//!
//! 这里只声明「本应用**能**打开 .mspp」，并把自己登记为该 ProgID 的处理程序。
//! 现代 Windows（Win10 起）不允许程序**静默抢占**用户已有的默认程序选择——
//! 用户若已经用别的程序打开过 .mspp，系统会保留用户的选择。首次遇到该后缀
//! （没有 UserChoice）时，我们的登记才会自然生效。这是有意为之：不硬抢。
//!
//! ## 只在正式构建里自动注册
//!
//! 与 `refresh_autostart_exe_path` 同一纪律：`tauri dev` / 裸 `cargo build`
//! 绝不写注册表，否则会把「已安装版本」的关联顶到 `target/debug/...exe`，
//! 用户双击插件包时拉起的是开发目录里的构建。

/// 关联的文件扩展名（不带点，注册表项名带点）
pub(crate) const MSPP_EXT: &str = "mspp";
/// ProgID：文件类型的程序标识符（点分、不含空格，惯例用「厂商.类型」）
const PROGID: &str = "MySearch.PluginPackage";
/// 资源管理器「类型」列显示的名字
const TYPE_LABEL: &str = "MySearch 插件包";
/// 命令行开关：双击时由 shell 追加 `--install-plugin "<路径>"`
pub(crate) const CLI_FLAG: &str = "--install-plugin";

/// 资源目录下 `.mspp` 图标的相对路径（与 tauri.conf.json 的 bundle.resources 对应）
const ICON_REL_PATH: &str = "resources/mspp.ico";

/* ============================================================
 * 命令行参数解析（平台无关，可单测）
 * ============================================================ */

/// 从命令行参数里取出「要安装的插件包路径」。
///
/// 认两种形态：
///   1. `--install-plugin <path>`（我们注册的 `shell\open\command` 用的形式）；
///   2. **裸路径**——用户在「打开方式」里手工选中本 exe，或把 `.mspp` 拖到
///      exe 图标上，此时只有路径、没有开关。
///
/// 只接受扩展名为 `mspp` 的路径，避免把任意参数（比如 `--flag` 后面的值、
/// 或某次误传的别的文件）当成插件包。路径必须真实存在（防 shell 传进来
/// 已删除的临时路径，那会让前端弹一个读文件失败的错误）。
pub(crate) fn plugin_path_from_args<S: AsRef<str>>(args: &[S]) -> Option<String> {
    let list: Vec<&str> = args.iter().map(|a| a.as_ref()).collect();
    // 先找带开关的形式（更明确，优先）
    for (i, a) in list.iter().enumerate() {
        if *a == CLI_FLAG {
            if let Some(p) = list.get(i + 1) {
                if let Some(ok) = accept_mspp_path(p) {
                    return Some(ok);
                }
            }
        }
    }
    // 再找裸路径
    list.iter().find_map(|a| accept_mspp_path(a))
}

/// 路径是否为「可接受的 .mspp 文件」——是则返回规范化后的路径。
///
/// 单独成函数是为了让上面两种形态共用同一套校验（扩展名 + 真实存在）。
fn accept_mspp_path(raw: &str) -> Option<String> {
    let p = raw.trim().trim_matches('"');
    if p.is_empty() {
        return None;
    }
    let ext = std::path::Path::new(p)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if ext != MSPP_EXT {
        return None;
    }
    if !std::path::Path::new(p).is_file() {
        return None;
    }
    Some(p.to_string())
}

/* ============================================================
 * 注册表写入（仅 Windows）
 * ============================================================ */

/// 注册结果：是否实际写了注册表（用于日志/调试，不参与业务判断）
#[cfg(windows)]
pub(crate) fn register(app: &tauri::AppHandle) -> Result<(), String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let exe = std::env::current_exe()
        .map_err(|e| format!("取当前程序路径失败: {e}"))?
        .display()
        .to_string();
    let icon = icon_path(app);

    let classes = RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey(r"Software\Classes")
        .map_err(|e| format!("打开 Classes 键失败: {e}"))?
        .0;

    // 1) 扩展名 → ProgID
    let (ext_key, _) = classes
        .create_subkey(format!(".{MSPP_EXT}"))
        .map_err(|e| format!("创建扩展名键失败: {e}"))?;
    ext_key
        .set_value("", &PROGID)
        .map_err(|e| format!("写入扩展名默认值失败: {e}"))?;

    // 2) ProgID 本体
    let (prog_key, _) = classes
        .create_subkey(PROGID)
        .map_err(|e| format!("创建 ProgID 键失败: {e}"))?;
    prog_key
        .set_value("", &TYPE_LABEL)
        .map_err(|e| format!("写入 ProgID 默认值失败: {e}"))?;
    // 资源管理器「类型」列优先读 FriendlyTypeName（比默认值更现代）
    prog_key
        .set_value("FriendlyTypeName", &TYPE_LABEL)
        .map_err(|e| format!("写入 FriendlyTypeName 失败: {e}"))?;

    // 3) 图标
    let (icon_key, _) = prog_key
        .create_subkey("DefaultIcon")
        .map_err(|e| format!("创建 DefaultIcon 键失败: {e}"))?;
    icon_key
        .set_value("", &icon)
        .map_err(|e| format!("写入图标路径失败: {e}"))?;

    // 4) 打开命令
    let (cmd_key, _) = prog_key
        .create_subkey(r"shell\open\command")
        .map_err(|e| format!("创建 open 命令键失败: {e}"))?;
    // 引号包住 exe 与 %1：路径含空格时不被拆成多个参数
    cmd_key
        .set_value("", &format!("\"{exe}\" {CLI_FLAG} \"%1\""))
        .map_err(|e| format!("写入打开命令失败: {e}"))?;

    notify_shell_changed();
    Ok(())
}

#[cfg(not(windows))]
pub(crate) fn register(_app: &tauri::AppHandle) -> Result<(), String> {
    Ok(())
}

/// 注销关联（清除 HKCU\Software\Classes 下的扩展名键与 ProgID 键）。
///
/// 幂等：键不存在时 `delete_subkey_all` 返回错误，这里当作成功（目标状态已达成）。
///
/// 还要顺手摘掉 `FileExts\.mspp\OpenWithProgids` 里我们留下的 ProgID：
/// 那是资源管理器「打开方式」附带的记录，**不属于 Classes**，`delete_subkey_all`
/// 清不到。留着它会让「已取消关联」的系统里仍显示「MySearch 插件包」这一打开方式
/// 条目（关闭开关后还看得见本程序），与用户预期不符。
#[cfg(windows)]
pub(crate) fn unregister() -> Result<(), String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let classes = match RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(r"Software\Classes", winreg::enums::KEY_ALL_ACCESS)
    {
        Ok(k) => k,
        Err(_) => return Ok(()), // 没有 Classes 键 = 没登记过
    };
    let _ = classes.delete_subkey_all(format!(".{MSPP_EXT}"));
    let _ = classes.delete_subkey_all(PROGID);
    remove_open_with_progid();
    notify_shell_changed();
    Ok(())
}

/// 从 `FileExts\.<ext>\OpenWithProgids` 里删掉本程序的 ProgID（幂等）。
///
/// 只删这一个值，**不动**整个 OpenWithProgids 键：那里可能还有别的程序
/// （用户用「打开方式 → 选择其他应用」选过的），不能一并清掉。
#[cfg(windows)]
fn remove_open_with_progid() {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_ALL_ACCESS};
    use winreg::RegKey;

    let Ok(ext_key) = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(
        format!(
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.{MSPP_EXT}\OpenWithProgids"
        ),
        KEY_ALL_ACCESS,
    ) else {
        return; // 没有这一层 = 没留过痕迹
    };
    let _ = ext_key.delete_value(PROGID);
}

#[cfg(not(windows))]
pub(crate) fn unregister() -> Result<(), String> {
    Ok(())
}

/// 当前是否已登记（读注册表实际状态，而非内存偏好）。
///
/// 用户可能在「默认应用」里改过，因此以系统状态为准——与 `is_autostart_enabled`
/// 同一口径。
#[cfg(windows)]
pub(crate) fn is_registered() -> bool {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;

    let Ok(classes) = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(r"Software\Classes", KEY_READ)
    else {
        return false;
    };
    classes
        .open_subkey_with_flags(format!(".{MSPP_EXT}"), KEY_READ)
        .and_then(|k| k.get_value::<String, _>(""))
        .map(|v| v == PROGID)
        .unwrap_or(false)
}

#[cfg(not(windows))]
pub(crate) fn is_registered() -> bool {
    false
}

/// 资源目录下 `.mspp` 图标的绝对路径（取不到时退回 exe 内嵌图标）。
///
/// 为什么带兜底：`resource_dir()` 在极少数情况下会失败（打包方式异常），
/// 而 `DefaultIcon` 写一个不存在的路径会让资源管理器显示成「白纸」——
/// 退回 `<exe>,0`（exe 自身的内嵌图标）至少还是个能看的图标。
#[cfg(windows)]
fn icon_path(app: &tauri::AppHandle) -> String {
    use tauri::Manager;
    app.path()
        .resource_dir()
        .ok()
        .map(|d| {
            strip_verbatim_prefix(
                &d.join(ICON_REL_PATH.replace('/', std::path::MAIN_SEPARATOR_STR))
                    .display()
                    .to_string(),
            )
        })
        .filter(|p| std::path::Path::new(p).is_file())
        .unwrap_or_else(|| {
            std::env::current_exe()
                .map(|p| format!("{},0", strip_verbatim_prefix(&p.display().to_string())))
                .unwrap_or_default()
        })
}

/// 剥掉 Windows 的扩展长度路径前缀 `\\?\`。
///
/// `resource_dir()` / `canonicalize()` 在 Windows 上会返回 `\\?\D:\...` 形式的
/// verbatim 路径。写进注册表的 `DefaultIcon` 时 shell 的图标提取器不认识这个前缀，
/// 资源管理器会一直显示白纸图标（「注册了但图标不生效」）。命令行用的 exe 路径
/// 不受影响，但保持同一口径更稳妥。
#[cfg(windows)]
fn strip_verbatim_prefix(p: &str) -> String {
    p.strip_prefix(r"\\?\")
        .map(str::to_string)
        .unwrap_or_else(|| p.to_string())
}

/// 通知 shell「文件关联变了」：让资源管理器立刻刷新图标/类型缓存。
///
/// 不做这一步的话，Windows 会缓存「未知类型」的白纸图标，用户得重启
/// explorer.exe 或等很久才能看到新图标——表现为「改了代码但没效果」。
#[cfg(windows)]
fn notify_shell_changed() {
    use windows_sys::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};
    // 常量是 u32（0x08000000），而函数签名要 i32——同一组比特位，按位转换即可
    // 文档要求：SHCNE_ASSOCCHANGED 时两个 idlist 参数都传 null
    unsafe {
        SHChangeNotify(
            SHCNE_ASSOCCHANGED as i32,
            SHCNF_IDLIST,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
}

/* ============================================================
 * 测试
 * ============================================================ */

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一个真实存在的临时 .mspp 文件（路径校验要求文件存在）
    fn temp_mspp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("mysearch-file-assoc-test");
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        let p = dir.join(name);
        std::fs::write(&p, b"fake").expect("写入临时文件");
        p
    }

    #[test]
    fn parses_flag_form() {
        let f = temp_mspp("a.mspp");
        let path = f.display().to_string();
        let args = vec!["app.exe".to_string(), CLI_FLAG.to_string(), path.clone()];
        assert_eq!(plugin_path_from_args(&args), Some(path));
    }

    #[test]
    fn parses_bare_path_form() {
        // 「打开方式」手工选 exe / 拖到 exe 图标上：只有路径，没有开关
        let f = temp_mspp("b.mspp");
        let path = f.display().to_string();
        let args = vec!["app.exe".to_string(), path.clone()];
        assert_eq!(plugin_path_from_args(&args), Some(path));
    }

    #[test]
    fn rejects_non_mspp_extension() {
        // 别的文件即使存在也不能被当成插件包
        let f = temp_mspp("c.txt");
        let args = vec!["app.exe".to_string(), f.display().to_string()];
        assert_eq!(plugin_path_from_args(&args), None);
    }

    #[test]
    fn rejects_missing_file() {
        // 扩展名对但文件不存在（shell 传了已删除的临时路径）→ 拒绝
        let args = vec!["app.exe".to_string(), r"C:\nope\gone.mspp".to_string()];
        assert_eq!(plugin_path_from_args(&args), None);
    }

    #[test]
    fn ignores_unrelated_args() {
        // 正常启动（无插件包参数）→ None；开关后面跟的不是 .mspp 也 None
        assert_eq!(plugin_path_from_args(&["app.exe".to_string()]), None);
        let args = vec!["app.exe".to_string(), "--other".to_string(), "value".to_string()];
        assert_eq!(plugin_path_from_args(&args), None);
    }

    #[test]
    fn strips_surrounding_quotes() {
        // shell 展开 %1 时可能带引号（路径含空格），要能剥掉
        let f = temp_mspp("d.mspp");
        let quoted = format!("\"{}\"", f.display());
        let args = vec!["app.exe".to_string(), quoted];
        assert_eq!(
            plugin_path_from_args(&args),
            Some(f.display().to_string())
        );
    }

    #[test]
    fn flag_form_wins_over_bare_path() {
        // 两种形态同时出现时，明确带开关的那个优先
        let a = temp_mspp("e1.mspp");
        let b = temp_mspp("e2.mspp");
        let args = vec![
            "app.exe".to_string(),
            b.display().to_string(),
            CLI_FLAG.to_string(),
            a.display().to_string(),
        ];
        assert_eq!(plugin_path_from_args(&args), Some(a.display().to_string()));
    }

    /// 注销必须清掉 `FileExts\.mspp\OpenWithProgids` 里的 ProgID。
    ///
    /// 回归测试：该值在 Classes 之外，曾漏清，导致「已取消关联」的系统里
    /// 「打开方式」仍列着本程序。这里在真实 HKCU 上造一份最小痕迹，
    /// 走一遍 `unregister()` 后断言被摘掉，并确认**同键下别人的值不受影响**。
    ///
    /// 只碰自己造的测试键下的值，测完即清理；不触碰真实关联状态。
    #[cfg(windows)]
    #[test]
    fn unregister_clears_open_with_progid() {
        use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
        use winreg::RegKey;

        const OTHER: &str = "SomeOtherApp.TestOnly";
        let path = format!(
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.{MSPP_EXT}\OpenWithProgids"
        );
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
            .create_subkey(&path)
            .expect("创建测试用 OpenWithProgids 键");
        key.set_value(PROGID, &"".to_string()).expect("写入 ProgID");
        key.set_value(OTHER, &"".to_string()).expect("写入他人 ProgID");

        unregister().expect("注销应成功");

        let after = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(&path, KEY_READ | KEY_WRITE)
            .expect("键应仍存在（别人的值还在）");
        assert!(
            after.get_value::<String, _>(PROGID).is_err(),
            "本程序 ProgID 应被清除"
        );
        assert!(
            after.get_value::<String, _>(OTHER).is_ok(),
            "同键下其他程序的值必须保留"
        );

        // 清理测试痕迹
        let _ = after.delete_value(OTHER);
        let _ = after.delete_value(PROGID);
    }
}
