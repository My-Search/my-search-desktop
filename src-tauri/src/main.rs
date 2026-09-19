// 我的搜索桌面版 - 入口
//
// 【为什么只在 Windows 上声明，且 debug 也用 windows 子系统】
// 本项目是「开机自启动 + 常驻托盘」的工具：登录时由 explorer.exe 拉起进程，
// 此时**没有任何父控制台**。若 exe 是 console 子系统，Windows 会为它新建一个
// 控制台窗口并一直显示（进程常驻托盘不退出，黑窗口也一直在）——用户看到的
// 「开机自启动弹出一个窗口」就是这个控制台，而不是主窗口（主窗口初始
// visible:false，不会显示）。
// 早期写法 `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`
// 只让 release 静默，debug 仍会在登录时弹控制台；而自启动项指向的正是
// 首次写入时运行的 exe（开发期即 target/debug/...），所以「装完看着没事、
// 登录时黑窗口弹出来」的根因就在这里。改成「Windows 上无条件 GUI 子系统」后，
// 任何构建、任何启动方式（登录自启 / 开始菜单 / 双击 / 终端）都不会再创建
// 控制台窗口。
//
// 【dev 日志为什么不会丢】
// GUI 子系统进程从终端（cargo run / npm run tauri dev / start.bat）启动时，
// stdout/stderr 句柄仍由父进程继承，eprintln! 照常输出到终端；只有在
// 「无控制台且无重定向」的登录自启场景下才安静地丢弃（Rust std 对无效句柄
// 不 panic）。注意以后**不要**改成 debug 保留控制台：那会让自启又弹黑窗。
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    my_search_desktop_lib::run()
}
