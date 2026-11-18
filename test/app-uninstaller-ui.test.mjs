/**
 * 软件卸载器「图标 / 卸载三按钮 / 卸载后自动扫描残留」契约测试（纯 Node，无浏览器）。
 *
 * 本测试钉死静态契约（后端行为见 app-uninstaller-backend.test.mjs）：
 *   1. 清单通过 parsePluginManifest 校验，版本号 1.1.0；
 *   2. 后端 `list` 负责把 DisplayIcon 解析为 iconDataUrl（前端只渲染），
 *      脚本里必须包含批量提取关键调用（SHDefExtractIcon / FromHicon / PNG），
 *      且不再用会把命令行撑爆的「路径嵌 EncodedCommand」形态；
 *   3. 后端支持 uninstall（可带 force）/ uninstallForce / openLocation，
 *      openLocation 只接受 id、目录取自注册表条目（前端拿不到任意路径打开能力）；
 *   4. 卸载结束通知 `uninstall-finished`：后端在卸载进程退出后 sendNotification，
 *      前端 ms.backend.onNotification 收到后调 scan()（自动扫描残留）；
 *   5. 前端列表渲染三种真实按钮（卸载/强制卸载/打开位置），点击走对应后端方法；
 *      强制卸载必须先经 ms.ui.confirm 确认；
 *   6. 前端「卸载完成 → 自动扫描」用 installedSnapshot 找回软件条目（通知到达
 *      时列表可能已刷新），且快照在 loadList 里维护。
 *
 * 用法: node test/app-uninstaller-ui.test.mjs
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { parsePluginManifest } from "../src/lib/plugins/manifest.ts";
import { isKnownPermission } from "../src/lib/plugins/permissions.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = path.join(root, "plugins", "com.zhuangjie.app-uninstaller");

let pass = 0;
let fail = 0;
function ok(cond, name, extra = "") {
  if (cond) {
    pass++;
    console.log("PASS ", name, extra ? ` — ${extra}` : "");
  } else {
    fail++;
    console.log("FAIL ", name, extra ? ` — ${extra}` : "");
  }
}

const manifestRaw = readFileSync(path.join(pluginDir, "plugin.json"), "utf8");
const backendSrc = readFileSync(path.join(pluginDir, "backend", "index.mjs"), "utf8");
const uiSrc = readFileSync(path.join(pluginDir, "ui", "index.js"), "utf8");

/* 1. 清单 */
const parsed = parsePluginManifest(manifestRaw, isKnownPermission);
ok(parsed.ok, "清单通过 parsePluginManifest 校验", (parsed.errors || []).join(", ") || "no errors");
const manifest = parsed.ok ? parsed.manifest : JSON.parse(manifestRaw);
ok(manifest.version === "1.1.1", "版本号 1.1.1", manifest.version);
ok(
  Array.isArray(manifest.permissions) && manifest.permissions.includes("backend.spawn"),
  "保留 backend.spawn 权限（图标提取 / 卸载 / 扫描都走后端）",
);

/* 2. 后端图标提取 */
ok(backendSrc.includes("iconDataUrl"), "后端 list 产出 iconDataUrl 字段");
ok(backendSrc.includes("SHDefExtractIcon"), "图标用 SHDefExtractIcon 提取（尊重索引，非 ExecutableType 猜测）");
ok(backendSrc.includes("Bitmap]::FromHicon"), "FromHicon 挂在 System.Drawing.Bitmap 上（Image 上不存在，曾静默失败）");
ok(backendSrc.includes("ImageFormat]::Png"), "图标编码为 PNG");
ok(backendSrc.includes("@@PAYLOAD@@"), "批量提取的条目经临时文件交接（EncodedCommand 嵌 92 条路径会 ENAMETOOLONG）");
ok(backendSrc.includes("iconCache"), "图标带进程内缓存（刷新不重复跑 PS）");
ok(!/UninstallString'?\s*;\s*\$?_?\w*icon/i.test(backendSrc), "未从 UninstallString 猜图标（DisplayIcon 才是权威）");

/* 3. 后端新方法 */
ok(/case "uninstallForce"/.test(backendSrc), "后端支持 uninstallForce（强制卸载）");
ok(/params\?\.force === true/.test(backendSrc), "uninstall 也接受 force 参数（与独立方法等价）");
ok(/case "openLocation"/.test(backendSrc), "后端支持 openLocation");
ok(backendSrc.includes("guessProcessImage"), "强制卸载按映像名精确 taskkill（/IM，非全量 P）");
ok(/taskkill\.exe.*\[\"\/F\",\s*"\/IM"/.test(backendSrc.replace(/\s+/g, " ")) || backendSrc.includes('"/F", "/IM"'), "taskkill 只用 /F /IM（按映像名）");
// openLocation 的路径必须来自注册表条目缓存，而不是前端参数
const openFn = backendSrc.slice(backendSrc.indexOf("async function openSoftwareLocation"));
ok(
  /softwareCache\.get\(id\)/.test(openFn) && !/params\??\.(path|location|dir)/.test(openFn),
  "openLocation 目录取自本进程注册表条目（不信任前端路径）",
);

/* 4. 卸载结束通知 */
ok(backendSrc.includes('sendNotification("uninstall-finished"'), "后端在卸载进程退出后发 uninstall-finished");
ok(/child\.once\("exit"/.test(backendSrc), "通知挂在卸载进程的 exit 事件上（真实「卸载已结束」时机）");
ok(backendSrc.includes("finishedNotice"), "uninstall 返回 finishedNotice id（通知去重的锚点）");

/* 5. 前端按钮与调用 */
const uiUninstallFn = uiSrc.slice(uiSrc.indexOf("function uninstall("), uiSrc.indexOf("function openLocation"));
ok(uiSrc.includes('data-act="uninstallForce"'), "列表渲染「强制卸载」按钮");
ok(uiSrc.includes('data-act="open"'), "列表渲染「打开位置」按钮");
ok(uiSrc.includes('data-act="uninstall"'), "列表渲染「卸载」按钮");
ok(/call\(\s*force\s*\?\s*"uninstallForce"\s*:\s*"uninstall"/.test(uiUninstallFn), "强制卸载按钮走 uninstallForce 方法（普通卸载走 uninstall）");
ok(uiSrc.includes('call("openLocation"'), "打开位置按钮走 openLocation 方法");
// 强制卸载必须先经确认弹窗（会丢未保存数据）
ok(
  uiUninstallFn.includes("ms.ui.confirm") && uiUninstallFn.includes("force"),
  "卸载/强制卸载都经 ms.ui.confirm 确认（强制卸载文案含数据丢失警示）",
);
ok(uiSrc.includes("uninstall-finished"), "前端监听 uninstall-finished 通知");
ok(uiSrc.includes('onNotification("uninstall-finished"'), "监听走 ms.backend.onNotification（宿主销毁时统一清理）");
ok(
  /onNotification\("uninstall-finished",\s*function[\s\S]*?scan\(it\)/.test(uiSrc),
  "收到卸载结束通知 → 自动调 scan（与手动扫描同路径，含确认弹窗）",
);

/* 6. 快照 */
ok(uiSrc.includes("installedSnapshot"), "前端维护 installedSnapshot（通知到达时按 id 找回刚卸载的软件）");
ok(
  /installedSnapshot\[items\[i\]\.id\]\s*=\s*items\[i\]/.test(uiSrc) ||
    /installedSnapshot\[\w+\]\.id/.test(uiSrc),
  "快照在 loadList 成功后写入",
);

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
