/**
 * 插件「关闭界面时」保活判定的纯逻辑测试。
 *
 * 要钉死的契约（这些判定写错了在浏览器里很难复现，因此全部抽成纯函数）：
 *   1. 清单侧：`contributes.detailView.closeBehavior` 的取值/校验/默认值/错误文案，
 *      以及它与 `backend.closeBehavior` 不一致时的告警；
 *   2. 建议值口径：`detailViewCloseBehaviorOf`（detailView → backend → minimize）；
 *   3. 记录侧：`shouldKeepFrontendOnClose`（有界面 + 非 exit）；
 *   4. `decideViewClose`：minimize → 停靠 / exit → 卸载 / force → 无条件卸载；
 *   5. `decideViewRestore`：会话在且入口未变 → 恢复；入口变化 / 记录失效 → 重新挂载；
 *   6. `decideViewReload` 覆盖**保活中的会话**（改了开发目录也要重挂，否则跑的还是旧代码）。
 *
 * 用法: node test/plugin-keepalive.test.mjs
 */
import {
  DEFAULT_CLOSE_BEHAVIOR,
  describeManifestErrors,
  detailViewCloseBehaviorOf,
  parsePluginManifest,
} from "../src/lib/plugins/manifest.ts";
import {
  behaviorSuggestionOf,
  createPluginRecord,
  shouldKeepFrontendOnClose,
  shouldStopBackendOnClose,
} from "../src/lib/plugins/registry.ts";
import { decideViewClose, decideViewReload, decideViewRestore } from "../src/lib/plugins/dev-reload.ts";

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

const parse = (raw) => parsePluginManifest(raw, () => true);

/** 带界面的最小清单（无 backend） */
const withView = (closeBehavior, extra = {}) => ({
  id: "com.example.keep",
  name: "保活测试插件",
  version: "1.0.0",
  apiVersion: 1,
  permissions: ["ui.inlay"],
  contributes: {
    searchItem: { title: "保活测试", keyword: "保活测试" },
    detailView: { entry: "ui/view.html", script: "ui/view.js", ...(closeBehavior ? { closeBehavior } : {}) },
  },
  ...extra,
});

/** 带界面 + 后台进程的清单 */
const withBackend = (backend = {}, view = {}) => ({
  id: "com.example.keep-backend",
  name: "保活+后台",
  version: "1.0.0",
  apiVersion: 1,
  permissions: ["ui.inlay", "backend.spawn"],
  contributes: {
    searchItem: { title: "保活+后台", keyword: "保活后台" },
    detailView: { entry: "ui/view.html", script: "ui/view.js", ...view },
  },
  backend: { entry: "backend/app.exe", ...backend },
});

/* ============ 1. 清单：detailView.closeBehavior 的校验与默认 ============ */
{
  const r = parse(withView());
  ok(r.ok === true, "不写 detailView.closeBehavior 的清单合法");
  ok(
    r.ok && r.manifest.contributes.detailView.closeBehavior === undefined,
    "缺省时不塞默认值（由建议值口径兜底）"
  );
}
{
  const r = parse(withView("minimize"));
  ok(r.ok && r.manifest.contributes.detailView.closeBehavior === "minimize", "显式 minimize 被保留");
}
{
  const r = parse(withView("exit"));
  ok(r.ok && r.manifest.contributes.detailView.closeBehavior === "exit", "显式 exit 被保留（纯前端插件也能声明）");
}
{
  const r = parse(withView("close"));
  ok(r.ok === false, "非法取值被拒绝");
  ok(
    r.ok === false && r.errors.includes("contributes.detailView.closeBehavior.invalid"),
    "错误码为 contributes.detailView.closeBehavior.invalid",
    JSON.stringify(r.ok ? [] : r.errors)
  );
  const text = describeManifestErrors(r.ok ? [] : r.errors).join("；");
  ok(text.includes("minimize") && text.includes("exit"), "错误文案点明两个合法值", text);
}
{
  // 大小写敏感：与 backend.closeBehavior / autostart 同一套严格取值
  ok(parse(withView("EXIT")).ok === false, "大写 EXIT 不被接受");
}

/* ============ 2. 两处声明不一致 → 告警（不拦，detailView 优先） ============ */
{
  const r = parse(withBackend({ closeBehavior: "exit" }, { closeBehavior: "minimize" }));
  ok(r.ok === true, "两处不一致不拦（用户的选择才是最终值）");
  ok(
    r.ok === true && r.warnings.includes("contributes.detailView.closeBehavior.conflictsWithBackend"),
    "给出冲突告警码",
    JSON.stringify(r.ok ? r.warnings : [])
  );
  const text = describeManifestErrors(r.ok ? r.warnings : []).join("；");
  ok(text.includes("detailView") && text.includes("backend"), "告警文案点明是两处声明的冲突", text);
  // 冲突时建议值取 detailView 的声明
  ok(
    r.ok && detailViewCloseBehaviorOf(r.manifest) === "minimize",
    "冲突时以 detailView 的声明为准"
  );
}
{
  const r = parse(withBackend({ closeBehavior: "exit" }, { closeBehavior: "exit" }));
  ok(
    r.ok === true && !r.warnings.includes("contributes.detailView.closeBehavior.conflictsWithBackend"),
    "两处一致不告警"
  );
  const r2 = parse(withBackend({ closeBehavior: "exit" }));
  ok(
    r2.ok === true && !r2.warnings.includes("contributes.detailView.closeBehavior.conflictsWithBackend"),
    "只写了一处不告警"
  );
}

/* ============ 3. 建议值口径：detailView → backend → 默认 ============ */
{
  ok(detailViewCloseBehaviorOf(null) === DEFAULT_CLOSE_BEHAVIOR, "空清单 → 默认 minimize");
  ok(detailViewCloseBehaviorOf(undefined) === DEFAULT_CLOSE_BEHAVIOR, "undefined → 默认 minimize");

  const onlyView = parse(withView("exit")).manifest;
  ok(detailViewCloseBehaviorOf(onlyView) === "exit", "只有 detailView 时取它");

  const onlyBackend = parse(withBackend({ closeBehavior: "exit" })).manifest;
  ok(detailViewCloseBehaviorOf(onlyBackend) === "exit", "只有 backend 时取它（老插件不受影响）");

  const both = parse(withBackend({ closeBehavior: "exit" }, { closeBehavior: "minimize" })).manifest;
  ok(detailViewCloseBehaviorOf(both) === "minimize", "两处都有时 detailView 优先");

  // 面板建议值与之一致（否则面板显示「插件建议」会与首次安装落的值不同）
  ok(behaviorSuggestionOf(both).closeBehavior === "minimize", "behaviorSuggestionOf 同一口径");
}

/* ============ 4. shouldKeepFrontendOnClose：有界面 + 非 exit ============ */
{
  const mk = (manifest, over = {}) => {
    const rec = createPluginRecord({ manifest, dir: "plugins/x", source: { kind: "file", ref: "x.msplugin" } });
    return { ...rec, ...over };
  };
  const view = parse(withView()).manifest;
  const viewExit = parse(withView("exit")).manifest;
  const backendOnly = parse({
    id: "com.example.no-view",
    name: "无界面插件",
    version: "1.0.0",
    apiVersion: 1,
    permissions: ["backend.spawn"],
    backend: { entry: "backend/app.exe", closeBehavior: "minimize" },
  }).manifest;

  ok(shouldKeepFrontendOnClose(mk(view)) === true, "默认（minimize）的界面插件 → 保活");
  ok(shouldKeepFrontendOnClose(mk(viewExit)) === false, "声明 exit 的界面插件 → 不保活");
  ok(shouldKeepFrontendOnClose(mk(backendOnly)) === false, "没有 detailView 的插件 → 无前端可保活");
  ok(shouldKeepFrontendOnClose(null) === false, "null → false");
  ok(shouldKeepFrontendOnClose(undefined) === false, "undefined → false");
  // 用户改成 exit 覆盖插件建议
  ok(shouldKeepFrontendOnClose(mk(view, { closeBehavior: "exit" })) === false, "用户改成 exit → 不保活");
  // 开机自启只影响进程，不影响界面保活
  ok(
    shouldKeepFrontendOnClose(mk(parse(withBackend({ autostart: "always", closeBehavior: "exit" })).manifest)) ===
      false,
    "开机自启不改变「界面卸载」这个承诺"
  );
  // 与进程判定互补（同一开关的两种取值）
  const exitRec = mk(parse(withBackend({ closeBehavior: "exit" })).manifest);
  ok(
    shouldStopBackendOnClose(exitRec) === true && shouldKeepFrontendOnClose(exitRec) === false,
    "exit：停进程 + 卸载界面（互补）"
  );
  const minRec = mk(parse(withBackend({ closeBehavior: "minimize" })).manifest);
  ok(
    shouldStopBackendOnClose(minRec) === false && shouldKeepFrontendOnClose(minRec) === true,
    "minimize：不停进程 + 保活界面（互补）"
  );
  // 开机自启 + exit：进程常驻但界面仍卸载（两个维度各判各的）
  const alwaysExit = mk(parse(withBackend({ autostart: "always", closeBehavior: "exit" })).manifest, {
    autoStart: "always",
  });
  ok(
    shouldStopBackendOnClose(alwaysExit) === false && shouldKeepFrontendOnClose(alwaysExit) === false,
    "always + exit：进程常驻、界面仍卸载"
  );
}

/* ============ 5. decideViewClose：停靠 / 卸载 / 强制 ============ */
{
  const rec = { closeBehavior: "minimize", manifest: parse(withView()).manifest };
  const r1 = decideViewClose({ record: rec, hasSession: true });
  ok(r1.action === "park" && r1.keepAlive === true, "minimize + 有会话 → 停靠");

  const recExit = { closeBehavior: "exit", manifest: parse(withView("exit")).manifest };
  const r2 = decideViewClose({ record: recExit, hasSession: true });
  ok(r2.action === "unmount" && r2.keepAlive === false, "exit + 有会话 → 卸载");

  // 没有会话：幂等（unmount，但没什么可做）
  ok(decideViewClose({ record: rec, hasSession: false }).action === "unmount", "没有会话 → unmount（幂等）");

  // 强制卸载：不看插件设置（插件被禁用/卸载、热重载、退出应用）
  const r3 = decideViewClose({ record: rec, hasSession: true, force: true, forceReason: "插件已卸载" });
  ok(r3.action === "unmount" && r3.reason === "插件已卸载", "force → 无条件卸载，且带上原因");

  // 记录拿不到（插件已被删除）：按不保活处理，避免凭空复活
  ok(decideViewClose({ record: null, hasSession: true }).action === "unmount", "记录不存在 → 卸载");
}

/* ============ 6. decideViewRestore：恢复 / 重挂 ============ */
{
  const same = decideViewRestore({
    hasSession: true,
    recordUsable: true,
    entry: "ui/view.html",
    script: "ui/view.js",
    sessionEntry: "ui/view.html",
    sessionScript: "ui/view.js",
  });
  ok(same.action === "restore", "会话在 + 入口未变 → 恢复（不重读文件、不重跑脚本）");

  const noSession = decideViewRestore({
    hasSession: false,
    recordUsable: true,
    entry: "ui/view.html",
    script: "ui/view.js",
  });
  ok(noSession.action === "remount", "没有会话 → 重新挂载");

  const entryChanged = decideViewRestore({
    hasSession: true,
    recordUsable: true,
    entry: "ui/view2.html",
    script: "ui/view.js",
    sessionEntry: "ui/view.html",
    sessionScript: "ui/view.js",
  });
  ok(entryChanged.action === "remount", "入口 HTML 换了 → 重新挂载（不能按旧 DOM 恢复）");

  const scriptChanged = decideViewRestore({
    hasSession: true,
    recordUsable: true,
    entry: "ui/view.html",
    script: "ui/view2.js",
    sessionEntry: "ui/view.html",
    sessionScript: "ui/view.js",
  });
  ok(scriptChanged.action === "remount", "入口脚本换了 → 重新挂载");

  const gone = decideViewRestore({
    hasSession: true,
    recordUsable: false,
    entry: "ui/view.html",
    script: "ui/view.js",
    sessionEntry: "ui/view.html",
    sessionScript: "ui/view.js",
  });
  ok(gone.action === "remount", "记录不可用（禁用/卸载）→ 不恢复");

  // script 两边都是 null（插件没有入口脚本）：仍可恢复
  const noScript = decideViewRestore({
    hasSession: true,
    recordUsable: true,
    entry: "ui/view.html",
    script: null,
    sessionEntry: "ui/view.html",
    sessionScript: null,
  });
  ok(noScript.action === "restore", "没有入口脚本的插件也能恢复");
  // 一边有、一边没有（清单新加了 script）→ 必须重挂
  ok(
    decideViewRestore({
      hasSession: true,
      recordUsable: true,
      entry: "ui/view.html",
      script: "ui/view.js",
      sessionEntry: "ui/view.html",
      sessionScript: null,
    }).action === "remount",
    "清单新增 entry 脚本 → 重挂"
  );
}

/* ============ 7. decideViewReload：保活中的会话也要重挂 ============ */
{
  const base = {
    pluginId: "com.example.keep",
    paths: ["ui/view.html"],
    entry: "ui/view.html",
    script: "ui/view.js",
    versionChanged: false,
    name: "保活测试插件",
  };
  // 前台会话：重挂
  ok(
    decideViewReload({ ...base, activePluginId: "com.example.keep" }).remount === true,
    "前台会话：界面文件变化 → 重挂"
  );
  // 保活（停靠）中的会话：同样必须重挂（否则内存里跑的还是旧代码）
  const parked = decideViewReload({
    ...base,
    activePluginId: null,
    parkedPluginIds: ["com.example.keep"],
  });
  ok(parked.remount === true, "保活中的会话：界面文件变化 → 也要重挂");
  ok(typeof parked.notice === "string" && parked.notice.includes("保活测试插件"), "给出含插件名的提示");
  // 版本变化同样覆盖保活会话
  ok(
    decideViewReload({
      ...base,
      paths: ["plugin.json"],
      versionChanged: true,
      activePluginId: null,
      parkedPluginIds: ["com.example.keep"],
    }).remount === true,
    "保活中的会话：清单版本变化 → 重挂"
  );
  // 只改后端：保活会话不动（界面代码没变）
  ok(
    decideViewReload({
      ...base,
      paths: ["backend/index.js"],
      activePluginId: null,
      parkedPluginIds: ["com.example.keep"],
    }).remount === false,
    "保活中的会话：只改后端 → 不重挂"
  );
  // 没有会话：不做任何事
  ok(
    decideViewReload({ ...base, activePluginId: null, parkedPluginIds: [] }).remount === false,
    "没有会话（前台与保活都没有）→ 不重挂"
  );
  // 保活的是别的插件：不动
  ok(
    decideViewReload({ ...base, activePluginId: null, parkedPluginIds: ["com.example.other"] }).remount === false,
    "保活的是别的插件 → 不重挂"
  );
  // 向后兼容：不传 parkedPluginIds 时按原行为（只看前台）
  ok(
    decideViewReload({ ...base, activePluginId: "com.example.keep" }).remount === true &&
      decideViewReload({ ...base, activePluginId: "com.example.other" }).remount === false,
    "不传保活列表时行为不变（只看前台会话）"
  );
}

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
