/**
 * 目录挂载插件「自动重载」的**跨语言契约**测试（以源码为断言对象）。
 *
 * 为什么需要：这条链路上有两处「写错了不会报错、只会静默失效」的边界——
 *
 *   1. **事件名**：Rust 广播 `plugin://dev-changed`，前端监听同一个字符串。
 *      名字对不上时不会抛错，只是永远收不到事件（表现为「改了没反应」）。
 *   2. **载荷字段名**：Rust 的 `PluginChangedPayload` 用 `rename_all =
 *      "camelCase"` 序列化，前端 `PluginChangedPayload` 也必须按 camelCase
 *      读取（`pluginId` / `frontendOnly`）。对不上时读到 undefined，
 *      前端会当成「目录级事件」保守处理——不报错，但每次都重启后端进程。
 *
 * 另外钉死两条工程约定：
 *   - 监听只在 Tauri 环境发起（浏览器调试不得抛错）；
 *   - 事件监听必须在搜索窗口与设置面板各自注册/注销（否则会泄漏监听器）。
 *
 * 用法: node test/plugin-dev-reload-contract.test.mjs
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = "") => {
  if (cond) {
    pass++;
    console.log("PASS ", name, extra ? ` — ${extra}` : "");
  } else {
    fail++;
    console.log("FAIL ", name, extra ? ` — ${extra}` : "");
  }
};

const rustWatch = read("src-tauri/src/plugin_watch.rs");
const rustHost = read("src-tauri/src/plugin_host.rs");
const rustLib = read("src-tauri/src/lib.rs");
const ipc = read("src/lib/plugins/ipc.ts");
const searchApp = read("src/windows/search/App.vue");
const searchHost = read("src/windows/search/usePluginHost.ts");
const configRuntime = read("src/windows/config/usePluginRuntime.ts");
const panel = read("src/windows/config/panels/PanelPlugins.vue");

const EVENT = "plugin://dev-changed";

/* ============ 1. 事件名两侧一致 ============ */
{
  ok(rustWatch.includes(`"${EVENT}"`), `Rust 侧定义了事件名 ${EVENT}`);
  ok(ipc.includes(`"${EVENT}"`), "前端 ipc 监听同一事件名");
  ok(
    !/"plugin:\/\/dev-changed"/.test(searchHost) && !/"plugin:\/\/dev-changed"/.test(configRuntime),
    "业务代码不自己拼事件名字符串（统一走 ipc 封装）",
    "避免两处各写一份、改一处漏一处"
  );
}

/* ============ 2. 载荷字段名 camelCase 对齐 ============ */
{
  ok(
    /#\[serde\(rename_all = "camelCase"\)\]\s*\n\s*pub struct PluginChangedPayload/.test(rustWatch),
    "Rust 载荷声明了 camelCase 序列化"
  );
  for (const field of ["plugin_id", "frontend_only", "paths", "dir", "at"]) {
    ok(rustWatch.includes(`pub ${field}:`), `Rust 载荷字段 ${field} 存在`);
  }
  // 前端按 camelCase 读取
  ok(ipc.includes("pluginId: string;"), "前端载荷声明 pluginId（camelCase）");
  ok(ipc.includes("frontendOnly: boolean;"), "前端载荷声明 frontendOnly（camelCase）");
  // 前端消费处只读 camelCase（读 snake_case 会得到 undefined → 保守分支）
  ok(
    searchHost.includes("payload.pluginId") || searchHost.includes("payload?.pluginId"),
    "搜索窗口按 payload.pluginId 取插件 id"
  );
  ok(
    searchHost.includes("frontendOnly: payload.frontendOnly"),
    "搜索窗口把 frontendOnly 传给后台重启判定",
    "字段名错了会被当成「可能影响后端」→ 每次改动都重启进程"
  );
}

/* ============ 3. 命令注册与调用对齐 ============ */
{
  ok(/#\[tauri::command\]\s*\n\s*pub fn plugin_watch_dir/.test(rustHost), "Rust 定义了 plugin_watch_dir 命令");
  ok(rustLib.includes("plugin_host::plugin_watch_dir,"), "命令已注册到 invoke_handler");
  ok(ipc.includes('invoke("plugin_watch_dir"'), "前端调用 plugin_watch_dir");
  ok(
    ipc.includes("{ pluginId, dir, enable }") || /pluginId,\s*dir,\s*enable/.test(ipc),
    "参数名与 Rust 命令签名对齐（pluginId / dir / enable）"
  );
  // Rust 命令参数是 snake_case 的 dir/plugin_id；Tauri v2 会自动做大小写映射，
  // 因此前端传 camelCase 的 pluginId 即可（与既有命令一致，勿改）
  ok(
    /pub fn plugin_watch_dir\(\s*app: AppHandle,\s*plugin_id: String,\s*dir: String,\s*enable: bool,?\s*\)/.test(
      rustHost
    ),
    "Rust 命令签名保持 (app, plugin_id, dir, enable)"
  );
}

/* ============ 4. 浏览器环境降级 ============ */
{
  const watchFn = ipc.slice(ipc.indexOf("export async function watchPluginDir"));
  ok(
    /if \(!isTauri\) return;/.test(watchFn.slice(0, 300)),
    "watchPluginDir 在非 Tauri 环境静默返回（浏览器调试不抛错）"
  );
  const listenFn = ipc.slice(ipc.indexOf("export async function onPluginDevChanged"));
  ok(
    /if \(!isTauri\) return \(\) => \{\};/.test(listenFn.slice(0, 300)),
    "onPluginDevChanged 在非 Tauri 环境返回 no-op 取消函数"
  );
}

/* ============ 5. 两个窗口各自注册/注销监听 ============ */
{
  ok(searchApp.includes("pluginHost.startDevWatcher()"), "搜索窗口启动时注册监听");
  ok(searchApp.includes("pluginHost.stopDevWatcher()"), "搜索窗口卸载时注销监听");
  ok(panel.includes("rt.startDevWatcher()"), "插件面板挂载时注册监听");
  ok(panel.includes("rt.stopDevWatcher()"), "插件面板卸载时注销监听");
  ok(
    searchHost.includes("if (unlistenDevChanged) return;"),
    "重复调用 startDevWatcher 不会重复注册（幂等）"
  );
  ok(
    configRuntime.includes("if (unlistenDevChanged) return;"),
    "设置窗口的 startDevWatcher 同样幂等"
  );
}

/* ============ 6. 挂载/卸载时登记与摘除监听 ============ */
{
  ok(
    /watchPluginDir\(merged\.id, dir, true\)/.test(configRuntime),
    "「从目录挂载」成功后立刻登记监听"
  );
  ok(
    /watchPluginDir\(pluginId, rec\.source\.ref \?\? rec\.dir, false\)/.test(configRuntime),
    "卸载时摘掉监听（目录还在但已不该再盯）"
  );
  ok(
    /unwatch_plugin\(&plugin_id\)/.test(rustHost),
    "Rust 侧 plugin_remove 也清掉监听（双保险）"
  );
  ok(
    searchHost.includes("rec.source.dev && rec.source.ref"),
    "搜索窗口启动时对已有开发插件补齐监听（应用重启后仍然生效）"
  );
}

/* ============ 7. 退出时释放 ============ */
{
  ok(
    rustLib.includes("plugin_watch::unwatch_all()"),
    "应用退出时释放全部文件监听"
  );
  ok(
    rustLib.includes("plugin_watch::stop_dispatch()"),
    "应用退出时停止派发线程"
  );
  ok(
    /\.build\(tauri::generate_context!\(\)\)/.test(rustLib),
    "改为 build + run(事件回调) 形式以拿到 RunEvent::Exit"
  );
}

/* ============ 8. 不阻塞通知线程 ============ */
{
  // notify 回调里只做过滤与入队；广播在派发线程完成
  const callbackBody = rustWatch.slice(
    rustWatch.indexOf("let mut watcher = notify::recommended_watcher"),
    rustWatch.indexOf("watcher.watch(dir")
  );
  ok(!callbackBody.includes("app.emit"), "notify 回调里不发事件（不阻塞通知线程）");
  ok(!callbackBody.includes("std::thread::sleep"), "notify 回调里不睡眠");
  ok(callbackBody.includes("enqueue("), "notify 回调里只做过滤与入队");
  ok(
    rustWatch.includes("DEBOUNCE_MS") && rustWatch.includes("duration_since(p.last_seen)"),
    "广播前经过静默期（合并一次保存的连环事件）"
  );
}

/* ============ 9. 用户态保护（两个窗口共用同一套判定） ============ */
{
  ok(
    searchHost.includes("planReload(rec, manifestText)"),
    "搜索窗口用纯函数 planReload 合并清单"
  );
  ok(
    configRuntime.includes("planReload(rec, manifestText)"),
    "设置窗口用同一个纯函数（两个窗口不会跑出不同结果）"
  );
  ok(
    searchHost.includes("decideBackendReload({"),
    "后台进程重启走纯函数判定（「只在运行时重启」有单测）"
  );
  ok(
    searchApp.includes("decideViewReload({"),
    "视图重挂走纯函数判定"
  );
}

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
