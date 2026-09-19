/**
 * 目录挂载插件的**自动热重载** —— 纯逻辑测试（`src/lib/plugins/dev-reload.ts`）。
 *
 * 要钉死的契约（都是「写错了在浏览器里极难复现」的判定）：
 *   1. 清单解析失败（保存到一半的中间态）→ 什么都不做，绝不改坏记录；
 *   2. 清单 id 与已挂载插件不符 → 拒绝（不能靠改文件悄悄换身份）；
 *   3. 合并记录时**用户态一律保留**：启用态 / 自启策略 / 关闭行为 / 已授权 /
 *      拒绝记录 / 安装时间；清单派生的展示字段跟着新清单走；
 *   4. 新增的必需权限**不静默授予**，只登记为待授权；
 *   5. 视图重挂：只在「当前正打开这个插件」且变化触达界面文件（或版本变化）时；
 *   6. 后台进程重启：只在**进程当前运行中**、且变化触达 backend/ 或清单时；
 *   7. 事件新鲜度：过期事件丢弃、无时间戳按新鲜处理。
 *
 * 用法: node test/plugin-dev-reload.test.mjs
 */
import {
  approveNewPermissions,
  decideBackendReload,
  decideViewReload,
  EVENT_MAX_AGE_MS,
  isFreshEvent,
  isFrontendPath,
  planReload,
  touchesBackend,
  touchesView,
} from "../src/lib/plugins/dev-reload.ts";

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

/** 最小合法清单（有 detailView 的插件） */
const manifestText = (over = {}) =>
  JSON.stringify({
    id: "com.example.dev",
    name: "开发插件",
    version: "1.0.0",
    apiVersion: 1,
    permissions: ["ui.inlay"],
    contributes: {
      searchItem: { title: "[推荐][脚本]开发插件", keyword: "开发", desc: "开发用" },
      detailView: { entry: "ui/detail.html", script: "ui/index.js" },
    },
    ...over,
  });

/** 一条已挂载的开发插件记录（用户改过若干设置，用于验证不被覆盖） */
const recordOf = (over = {}) => ({
  id: "com.example.dev",
  name: "开发插件",
  version: "1.0.0",
  apiVersion: 1,
  manifest: JSON.parse(manifestText()),
  dir: "D:/code/plugins/dev",
  source: { kind: "folder", ref: "D:/code/plugins/dev", dev: true },
  installedAt: 1000,
  updatedAt: 1000,
  enabled: false,               // 用户关掉了：热重载不该打开
  autoStart: "never",           // 用户改成从不自启
  requestedAutoStart: "on-demand",
  closeBehavior: "exit",
  grants: [{ permission: "ui.inlay", at: 1000, source: "install" }],
  denied: ["clipboard.read"],
  runtime: { status: "stopped", pid: null, memoryBytes: null, startedAt: null, restarts: 2, lastError: "旧错误", keepAliveReasons: [] },
  integrity: { sha256: null, signed: false },
  ...over,
});

/* ============ 1. 路径判定 ============ */
{
  ok(isFrontendPath("ui/detail.html"), "ui/detail.html 是前端文件");
  ok(isFrontendPath("icon.svg"), "根目录图标是前端文件");
  ok(!isFrontendPath("backend/index.js"), "backend/ 下是后端文件");
  ok(!isFrontendPath("backend\\index.js"), "反斜杠路径同样识别为后端", "Windows 事件路径");
  ok(!isFrontendPath("plugin.json"), "清单不算前端（可能改了后端入口/搜索项）");
  ok(!isFrontendPath("backend/app.exe"), "可执行产物按后端处理");
}
{
  const entry = "ui/detail.html";
  const script = "ui/index.js";
  ok(touchesView(["ui/detail.html"], entry, script), "入口 HTML 变化触达视图");
  ok(touchesView(["ui/index.js"], entry, script), "入口脚本变化触达视图");
  ok(touchesView(["ui/detail.css"], entry, script), "同目录样式变化触达视图", "入口同名 css");
  ok(!touchesView(["backend/index.js"], entry, script), "后端文件变化不触达视图");
  ok(touchesView([], entry, script), "目录级事件（无路径）按触达处理", "宁可多挂一次");
  ok(touchesView(["ui/other.js"], null, null), "没声明 detailView 时任何前端变化都算触达");
}
{
  ok(touchesBackend(["backend/index.js"]), "backend/ 变化需要处理后端");
  ok(touchesBackend(["plugin.json"]), "清单变化需要处理后端", "可能改了 backend.entry");
  ok(!touchesBackend(["ui/index.js"]), "纯前端变化不需要动后端");
  ok(touchesBackend([]), "目录级事件保守按触达处理后端");
}

/* ============ 2. 清单读不出来 / id 不符 → 不动记录 ============ */
{
  const rec = recordOf();
  const half = planReload(rec, "{ \"id\": \"com.example.dev\", \"name\":");
  ok(half.proceed === false, "半截 JSON（保存中间态）不重载", half.reason);
  ok(half.record === rec, "不重载时原记录对象原样返回");
  ok(typeof half.reason === "string" && half.reason.length > 0, "给出可读原因");
}
{
  const rec = recordOf();
  const other = planReload(rec, manifestText({ id: "com.example.other" }));
  ok(other.proceed === false, "id 不符时拒绝", other.reason);
  ok(other.record.version === "1.0.0", "拒绝时版本不变");
}
{
  const rec = recordOf();
  const bad = planReload(rec, manifestText({ version: "not-a-version" }));
  ok(bad.proceed === false, "非法版本号被清单校验拦下");
}

/* ============ 3. 正常重载：派生字段更新、用户态保留 ============ */
{
  const rec = recordOf();
  const next = planReload(
    rec,
    manifestText({
      name: "开发插件（改名）",
      version: "1.2.0",
      description: "新的描述",
    })
  );
  ok(next.proceed === true, "合法新清单顺利重载");
  const merged = next.record;
  ok(merged.name === "开发插件（改名）", "名称跟随新清单", merged.name);
  ok(merged.version === "1.2.0", "版本跟随新清单", merged.version);
  ok(merged.description === "新的描述", "描述跟随新清单");
  ok(next.versionChanged === true, "版本变化被标记");
  ok(next.fromVersion === "1.0.0", "带回旧版本（提示文案用）", next.fromVersion);
  // 用户态
  ok(merged.enabled === false, "用户关掉的插件保持关闭（热重载不偷偷打开）");
  ok(merged.autoStart === "never", "自启策略保持用户选择");
  ok(merged.closeBehavior === "exit", "关闭行为保持用户选择");
  ok(merged.grants.length === 1 && merged.grants[0].permission === "ui.inlay", "已有授权原样保留");
  ok(merged.denied.includes("clipboard.read"), "拒绝记录保留（不反复打扰）");
  ok(merged.installedAt === 1000, "安装时间保留");
  ok(merged.runtime.restarts === 2 && merged.runtime.lastError === "旧错误", "运行态不被清理");
  ok(merged.source.dev === true, "来源标记（开发模式）保留");
}
{
  // 版本没变：versionChanged 为 false（仍然会应用清单里的其它改动）
  const rec = recordOf();
  const same = planReload(rec, manifestText({ description: "改了描述但没改版本" }));
  ok(same.proceed === true && same.versionChanged === false, "同版本也应用改动但不报版本变化");
  ok(same.record.description === "改了描述但没改版本", "描述照常更新");
}

/* ============ 4. 新权限不静默授予 ============ */
{
  const rec = recordOf();
  const withNew = planReload(
    rec,
    manifestText({ permissions: ["ui.inlay", "clipboard.read", "net.fetch:https://api.x.com/*"] })
  );
  ok(withNew.proceed === true, "带新权限的清单合法");
  ok(withNew.newPermissions.length === 2, "两个新权限被识别", withNew.newPermissions.join(", "));
  ok(
    withNew.record.grants.every((g) => g.permission === "ui.inlay"),
    "新权限没有被静默写进已授权"
  );
  ok(
    withNew.record.pendingPermission === "clipboard.read",
    "第一个新权限登记为待授权（面板可一键授予）",
    String(withNew.record.pendingPermission)
  );
  // 用户确认后写入
  const changed = approveNewPermissions(withNew.record, withNew.newPermissions);
  ok(changed === true, "用户确认后写入授权");
  ok(
    withNew.record.grants.some((g) => g.permission === "clipboard.read"),
    "确认后的权限进入已授权列表"
  );
}
{
  // 已授予的 scope 能覆盖新请求时不重复要求
  const rec = recordOf({ grants: [{ permission: "net.fetch:*", at: 1, source: "install" }] });
  const covered = planReload(
    rec,
    manifestText({ permissions: ["net.fetch:https://api.x.com/*"] })
  );
  ok(covered.newPermissions.length === 0, "宽 scope 覆盖窄请求，不重复弹确认");
  ok(covered.record.pendingPermission == null, "没有新权限时不登记待授权");
}

/* ============ 5. 视图重挂判定 ============ */
{
  // 没打开这个插件：不重挂
  const idle = decideViewReload({
    activePluginId: null,
    pluginId: "com.example.dev",
    paths: ["ui/detail.html"],
    entry: "ui/detail.html",
    script: "ui/index.js",
    versionChanged: true,
  });
  ok(idle.remount === false && idle.notice === null, "没有打开的视图时不做任何事");

  // 打开的是别的插件：不重挂
  const other = decideViewReload({
    activePluginId: "com.example.other",
    pluginId: "com.example.dev",
    paths: ["ui/detail.html"],
    entry: "ui/detail.html",
    script: "ui/index.js",
    versionChanged: false,
  });
  ok(other.remount === false, "改的是别的插件，当前视图不动");

  // 正打开着，且改了界面：重挂 + 提示
  const hit = decideViewReload({
    activePluginId: "com.example.dev",
    pluginId: "com.example.dev",
    paths: ["ui/detail.html"],
    entry: "ui/detail.html",
    script: "ui/index.js",
    versionChanged: false,
    name: "开发插件",
  });
  ok(hit.remount === true, "界面文件变化 → 重挂");
  ok(typeof hit.notice === "string" && hit.notice.includes("开发插件"), "给出一条含插件名的提示", hit.notice);

  // 正打开着，但只改了后端：不重挂（避免无谓地丢掉界面里的输入）
  const backendOnly = decideViewReload({
    activePluginId: "com.example.dev",
    pluginId: "com.example.dev",
    paths: ["backend/index.js"],
    entry: "ui/detail.html",
    script: "ui/index.js",
    versionChanged: false,
  });
  ok(backendOnly.remount === false, "只改后端时不重挂界面");

  // 版本变化即使没碰到界面文件也要重挂（作者可能同时改了搜索项）
  const versionOnly = decideViewReload({
    activePluginId: "com.example.dev",
    pluginId: "com.example.dev",
    paths: ["README.md"],
    entry: "ui/detail.html",
    script: "ui/index.js",
    versionChanged: true,
    name: "开发插件",
  });
  ok(versionOnly.remount === true, "版本变化 → 重挂", "清单里的搜索项可能也变了");
}

/* ============ 6. 后台进程重启判定（只在运行时重启） ============ */
{
  // 没在跑：不重启
  const stopped = decideBackendReload({
    hasBackend: true,
    paths: ["backend/index.js"],
    status: "stopped",
    frontendOnly: false,
  });
  ok(stopped.restart === false, "进程没在跑就不重启（不凭空拉进程）");

  // 启动中：不重启（避免与用户刚点的「启动」打架）
  const starting = decideBackendReload({
    hasBackend: true,
    paths: ["backend/index.js"],
    status: "starting",
    frontendOnly: false,
  });
  ok(starting.restart === false && starting.reason !== null, "启动中的进程不打断", String(starting.reason));

  // 运行中 + 改了后端：重启
  const running = decideBackendReload({
    hasBackend: true,
    paths: ["backend/index.js"],
    status: "running",
    frontendOnly: false,
  });
  ok(running.restart === true, "运行中且改了后端 → 重启");
  ok(typeof running.reason === "string", "重启给出原因（日志用）", running.reason);

  // 运行中 + 只有前端变化：不重启
  const frontOnly = decideBackendReload({
    hasBackend: true,
    paths: ["ui/index.js"],
    status: "running",
    frontendOnly: true,
  });
  ok(frontOnly.restart === false, "纯前端变化不重启进程（保住插件内存态）", String(frontOnly.reason));

  // 运行中 + 清单变化：重启（可能改了 backend.entry）
  const manifest = decideBackendReload({
    hasBackend: true,
    paths: ["plugin.json"],
    status: "running",
    frontendOnly: false,
  });
  ok(manifest.restart === true, "清单变化 → 重启（backend.entry 可能变了）");

  // 没有后台进程的插件：永远不重启
  const noBackend = decideBackendReload({
    hasBackend: false,
    paths: ["backend/index.js"],
    status: "running",
    frontendOnly: false,
  });
  ok(noBackend.restart === false && noBackend.reason === null, "无后台进程的插件不做处理");

  // 运行中 + 目录级事件（无路径）：保守重启
  const dirLevel = decideBackendReload({
    hasBackend: true,
    paths: [],
    status: "running",
    frontendOnly: false,
  });
  ok(dirLevel.restart === true, "目录级事件保守重启（无法判断改了什么）");
}

/* ============ 7. 事件新鲜度 ============ */
{
  const now = 10_000_000;
  ok(isFreshEvent({ at: now - 1000 }, now), "刚发生的事件是新鲜的");
  ok(isFreshEvent({ at: now - EVENT_MAX_AGE_MS }, now), "恰好到达窗口边界仍算新鲜");
  ok(!isFreshEvent({ at: now - EVENT_MAX_AGE_MS - 1 }, now), "超过窗口的事件被丢弃");
  ok(isFreshEvent({ at: 0 }, now), "没有时间戳的载荷按新鲜处理（老版本兼容）");
  ok(isFreshEvent({ at: Number.NaN }, now), "时间戳非法时按新鲜处理");
}

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
