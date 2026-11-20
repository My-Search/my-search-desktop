/**
 * 同步内核（`runSyncRound` / `decideAction`）纯逻辑测试。
 *
 * 这一层是云同步的决策内核，主窗口常驻 SyncHost 与插件 `ms.sync.trigger()`
 * 都走它。这里钉死最容易回归的几条：
 *   - 首次连接远端已有备份 → 必须让用户选，绝不自动覆盖；
 *   - 只有一边变化 → 只做那一边的传输；
 *   - 两边都变 → 按策略决策，ask 时进入 needs-choice；
 *   - 上传带条件（If-Match / If-None-Match），412 → 重新决策；
 *   - 下载 304 → 不还原；下载成功 → 还原 + 静默写回 + commit 广播；
 *   - 失败以 status=error 返回，不 reject。
 *
 * 做法：`test/_sync-stub-loader.mjs` 把 `./bridge` 与 `./snapshot` 换成内存桩，
 * 完全离线地跑真实引擎代码。
 *
 * 用法: node test/sync-round.test.mjs
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 记录内核调了哪些外部命令，供断言
const calls = {
  remoteMeta: 0,
  upload: 0,
  uploadIfMatch: [],
  download: 0,
  downloadEtag: [],
  snapshot: 0,
  commit: 0,
  commitSources: [],
  commitScopes: [],
  restore: [],
  restoreState: [],
  prune: [],
  digest: 0,
  digestExtras: [],
};
const state = {
  remoteExists: false,
  remoteRev: "r1",
  remoteModified: 0,
  nextRev: "rev-uploaded",
  localDigest: "d1",
  uploadThrows: null,
  uploadConflict: 0,
  downloadNotModified: false,
};

/**
 * 一个极简 loader：把 `sync/engine.ts` 里 import 的 `./bridge` 与 `./snapshot`
 * 换成内存桩。用 `module.register` 而不是改源码，保证测的就是真实引擎代码。
 */
register(
  pathToFileURL(path.join(root, "test", "_sync-stub-loader.mjs")),
  pathToFileURL(path.join(root, "test", "_sync-stub-data.mjs"))
);

// 桩数据通过 globalThis 传给 loader（loader 在独立 realm，用 global 通信最省事）
globalThis.__SYNC_STUB__ = { calls, state };

const { runSyncRound, decideAction } = await import(
  pathToFileURL(path.join(root, "src", "lib", "sync", "engine.ts")).href
);

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
const reset = () => {
  calls.remoteMeta = calls.upload = calls.download = calls.snapshot = 0;
  calls.commit = 0;
  calls.uploadIfMatch.length = 0;
  calls.downloadEtag.length = 0;
  calls.commitSources.length = 0;
  calls.commitScopes.length = 0;
  calls.restore.length = 0;
  calls.restoreState.length = 0;
  calls.prune.length = 0;
  calls.digest = 0;
  calls.digestExtras.length = 0;
  state.remoteExists = false;
  state.remoteRev = "r1";
  state.remoteModified = 0;
  state.nextRev = "rev-uploaded";
  state.localDigest = "d1";
  state.uploadThrows = null;
  state.uploadConflict = 0;
  state.conflictRev = "";
  state.downloadNotModified = false;
};

const cfg = (over = {}) => ({
  enabled: true,
  webdavUrl: "https://dav.example.com/dav/",
  webdavUser: "u",
  remoteFile: "b.msbackup",
  conflict: "newer",
  autoOnChange: true,
  intervalMinutes: 30,
  hasPassword: true,
  ...over,
});

/** 持久化同步基线（Rust `sync-state.json` 的镜像） */
const persisted = (over = {}) => ({
  deviceId: "dev-test",
  target: "target-test",
  initialized: true,
  remoteRev: "r1",
  remoteEtag: '"r1"',
  lastLocalDigest: "d1",
  lastSyncAt: 1000,
  appliedRev: "",
  epoch: 1,
  ...over,
});

/** 造一套 runSyncRound 依赖 + 可断言的持久化状态 */
function harness({ conf = {}, base = persisted(), choice } = {}) {
  let current = { ...base };
  const patches = [];
  const options = {
    getConfig: () => cfg(conf),
    getState: async () => ({ ...current }),
    patchState: async (patch) => {
      patches.push(patch);
      current = { ...current, ...patch };
      return { ...current };
    },
    getShortcutBindings: () => [],
    getAutostartEnabled: () => true,
    // 可备份的 Rust 设置（代理 / Alt+点击）与落盘数据指纹：都必须参与摘要
    getProxySettings: () => ({ enabled: true, rules: ["github.com"], ruleSources: [], updateIntervalHours: 24 }),
    getAltClickEnabled: () => false,
    getDataDigest: () => "pd-1",
    choice,
  };
  return { options, patches, current: () => current };
}

const remote = (over = {}) => ({
  exists: true,
  rev: "r1",
  etag: '"r1"',
  modified: 1000,
  size: 1024,
  ...over,
});

/* ============ 1. 决策：纯函数边界 ============ */
{
  const base = persisted();
  const d = (input) => decideAction({ config: cfg(), remote: null, state: base, localDigest: "d1", ...input });

  ok(d({ remote: null }) === "upload", "无远端 → 上传（首次创建）");
  ok(d({ remote: remote({ exists: false }) }) === "upload", "exists=false 也算首次");
  ok(
    d({ remote: remote(), state: persisted({ initialized: false }) }) === "needs-choice",
    "远端已有备份但没建立基线 → 必须让用户选"
  );
  ok(d({ remote: remote() }) === "skip", "两边都没变 → 跳过");
  ok(d({ remote: remote(), localDigest: "d2" }) === "upload", "只有本机变 → 条件上传");
  ok(d({ remote: remote({ rev: "r2" }) }) === "download", "只有远端变 → 下载");
  ok(
    d({
      remote: remote({ rev: "r2" }),
      localDigest: "d2",
      config: cfg({ conflict: "ask" }),
    }) === "needs-choice",
    "两边都变 + ask → 交给用户"
  );
  ok(
    d({
      remote: remote({ rev: "r2" }),
      localDigest: "d2",
      config: cfg({ conflict: "local" }),
    }) === "force-upload",
    "两边都变 + 本机优先 → 无条件上传"
  );
  ok(
    d({
      remote: remote({ rev: "r2" }),
      localDigest: "d2",
      config: cfg({ conflict: "remote" }),
    }) === "download",
    "两边都变 + 远端优先 → 下载"
  );
  ok(
    d({
      remote: remote({ rev: "r2", modified: 5000 }),
      localDigest: "d2",
      config: cfg({ conflict: "newer" }),
    }) === "download",
    "newer：远端改得更晚 → 下载"
  );
  ok(
    d({
      remote: remote({ rev: "r2", modified: 500 }),
      localDigest: "d2",
      config: cfg({ conflict: "newer" }),
    }) === "force-upload",
    "newer：远端修改早于上次同步 → 本机覆盖"
  );
  ok(d({ remote: remote({ rev: "r2" }), choice: "remote" }) === "download", "用户选远端 → 下载");
  ok(d({ remote: remote(), localDigest: "d2", choice: "local" }) === "force-upload", "用户选本机 → 强制上传");
}

/* ============ 2. 关闭同步 → 本轮作废，不联网 ============ */
{
  reset();
  const h = harness({ conf: { enabled: false } });
  const final = await runSyncRound(h.options, "background");
  ok(calls.remoteMeta === 0, "没有联网查远端");
  ok(calls.upload === 0 && calls.download === 0, "没有上传/下载");
  ok(final.status === "idle", "以 idle 收尾", final.status);
}

/* ============ 3. 远端为空 → 上传，并以 If-None-Match:* 创建 ============ */
{
  reset();
  const h = harness();
  const final = await runSyncRound(h.options, "manual");
  ok(calls.remoteMeta === 1, "先查一次远端");
  ok(calls.snapshot === 1, "上传前创建了快照");
  ok(calls.upload === 1, "发起了上传");
  ok(calls.uploadIfMatch[0] === "", "首次创建带 If-None-Match:*", String(calls.uploadIfMatch[0]));
  ok(calls.download === 0, "没有多余下载");
  ok(h.current().initialized === true, "基线标记为已初始化");
  ok(h.current().remoteRev === "rev-uploaded", "记录上传后的远端版本", h.current().remoteRev);
  ok(h.current().lastLocalDigest === "d1", "记录本机摘要");
  ok(Array.isArray(calls.digestExtras[0]?.sb), "摘要包含 Rust 快捷键设置");
  ok(calls.digestExtras[0]?.ae === true, "摘要包含自启动状态");
  // 代理 / Alt+点击 / 落盘插件数据：都在备份范围内，必须同样参与「本机变没变」
  ok(calls.digestExtras[0]?.pr?.enabled === true, "摘要包含代理设置");
  ok(calls.digestExtras[0]?.ac === false, "摘要包含 Alt+点击开关");
  ok(calls.digestExtras[0]?.pd === "pd-1", "摘要包含落盘数据指纹（插件文件/插件数据）");
  ok(final.status === "idle", "结束后回到 idle", final.status);
}

/* ============ 4. 首次连接且远端已有 → needs-choice，不传输 ============ */
{
  reset();
  state.remoteExists = true;
  const h = harness({ base: persisted({ initialized: false, remoteRev: "", remoteEtag: "", lastLocalDigest: "" }) });
  const final = await runSyncRound(h.options, "manual");
  ok(final.status === "needs-choice", "进入 needs-choice", final.status);
  ok(final.needsChoice === true && final.choiceReason === "first-connect", "原因是首次连接");
  ok(calls.upload === 0 && calls.download === 0, "没有自动传输任何一边");
  ok(h.patches.length === 0, "基线未被改动");
}

/* ============ 5. 两边都没变 → skip，不产生网络写入 ============ */
{
  reset();
  state.remoteExists = true;
  const h = harness();
  const final = await runSyncRound(h.options, "background");
  ok(calls.upload === 0 && calls.download === 0, "没有上传/下载");
  ok(final.status === "idle", "idle", final.status);
  ok(h.current().lastSyncAt > 1000, "跳过也刷新检查时间");
}

/* ============ 6. 只有本机变 → 条件上传（If-Match 原 ETag） ============ */
{
  reset();
  state.remoteExists = true;
  state.localDigest = "d2";
  const h = harness();
  const final = await runSyncRound(h.options, "manual");
  ok(calls.upload === 1, "上传了一次");
  ok(calls.uploadIfMatch[0] === '"r1"', "带上次见到的原始 ETag", String(calls.uploadIfMatch[0]));
  ok(h.current().remoteRev === "rev-uploaded", "更新基线版本");
  ok(h.current().remoteEtag === '"rev-uploaded"', "更新基线 ETag");
  ok(h.current().lastLocalDigest === "d2", "更新本机摘要");
  ok(final.status === "idle", "idle", final.status);
}

/* ============ 7. 只有远端变 → 条件下载 + 事务还原 + 静默写回 + commit ============ */
{
  reset();
  state.remoteExists = true;
  state.remoteRev = "r2";
  state.remoteModified = 9000;
  const h = harness();
  const final = await runSyncRound(h.options, "manual");
  ok(calls.download === 1, "下载了一次");
  ok(calls.downloadEtag[0] === '"r1"', "带 If-None-Match 用上次 ETag", String(calls.downloadEtag[0]));
  ok(calls.upload === 0, "没有上传");
  ok(calls.restore.length === 1, "下载后执行还原");
  ok(calls.restore[0].categories?.length === 1 && calls.restore[0].categories[0] === "all", "全量还原");
  ok(calls.restore[0].localStorage?.subscribes?.[0] === "local", "还原前把当前状态交给 Rust 留底");
  ok(calls.restoreState.length === 1, "写回 localStorage");
  ok(calls.restoreState[0].options?.silent === true, "写回是静默的（不触发回声上传）");
  ok(calls.prune.length === 1, "全量还原后清理远端已删除的键");
  ok(calls.commit === 1 && calls.commitSources[0] === "cloud", "广播一次 applied");
  ok(calls.commitScopes[0] === "all", "云还原按全量范围广播", calls.commitScopes[0]);
  ok(h.current().remoteRev === "r2" && h.current().appliedRev === "r2", "记录已应用版本");
  ok(final.status === "idle", "idle", final.status);
}

/* ============ 8. 远端未变（304）→ 不还原、不 commit ============ */
{
  reset();
  state.remoteExists = true;
  state.remoteRev = "r2";
  state.downloadNotModified = true;
  const h = harness();
  const final = await runSyncRound(h.options, "manual");
  ok(calls.download === 1, "发起了条件下载");
  ok(calls.restore.length === 0, "304 不还原");
  ok(calls.commit === 0, "304 不广播 applied");
  ok(h.current().lastSyncAt > 1000, "刷新检查时间");
  ok(final.status === "idle", "idle", final.status);
}

/* ============ 9. 两边都变 + ask → needs-choice，不覆盖任何一边 ============ */
{
  reset();
  state.remoteExists = true;
  state.remoteRev = "r2";
  state.localDigest = "d2";
  const h = harness({ conf: { conflict: "ask" } });
  const final = await runSyncRound(h.options, "manual");
  ok(final.status === "needs-choice", "进入 needs-choice", final.status);
  ok(final.choiceReason === "conflict", "原因是冲突");
  ok(calls.upload === 0 && calls.download === 0, "没有传输");
}

/* ============ 10. 两边都变 + local → 无条件 PUT（唯一允许绕过 If-Match 的路径） ==== */
{
  reset();
  state.remoteExists = true;
  state.remoteRev = "r2";
  state.localDigest = "d2";
  const h = harness({ conf: { conflict: "local" } });
  await runSyncRound(h.options, "manual");
  ok(calls.upload === 1, "上传了一次");
  ok(calls.uploadIfMatch[0] === null, "无条件上传（ifMatch=null）", String(calls.uploadIfMatch[0]));
}

/* ============ 11. 条件上传 412 → 重新读远端并重新决策 ============ */
{
  reset();
  state.remoteExists = true;
  state.localDigest = "d2";
  state.uploadConflict = 1;
  // 412 后远端已被别的设备改成 r2，且修改时间早于上次同步：
  // newer 策略因此判定本机覆盖，第二次上传应放宽为无条件 PUT。
  state.conflictRev = "r2";
  state.remoteModified = 500;
  const h = harness({ conf: { conflict: "newer" } });
  const final = await runSyncRound(h.options, "manual");
  ok(calls.upload === 2, "412 后重试了一次上传", String(calls.upload));
  ok(calls.remoteMeta === 2, "重新读了远端", String(calls.remoteMeta));
  ok(calls.uploadIfMatch[0] === '"r1"', "首次是条件上传");
  ok(calls.uploadIfMatch[1] === null, "确认本机优先后才无条件上传", String(calls.uploadIfMatch[1]));
  ok(final.status === "idle", "最终成功", final.status);
}

/* ============ 12. 上传失败以状态表达，不把异常抛给调用方 ============ */
{
  reset();
  state.uploadThrows = "WebDAV 认证失败";
  const h = harness();
  const final = await runSyncRound(h.options, "plugin");
  ok(final.status === "error", "失败落到 status=error", final.status);
  ok(final.lastError.includes("WebDAV 认证失败"), "错误原因原样带回", final.lastError);
  ok(calls.upload === 1, "确实尝试过上传");
  ok(h.current().lastSyncAt === 1000, "失败不推进同步时间");
}

/* ============ 13. 状态回调实时反映阶段 ============ */
{
  reset();
  const seen = [];
  const h = harness();
  await runSyncRound({ ...h.options, onState: (st) => seen.push(st.status) }, "plugin");
  ok(seen.includes("syncing"), "出现过 syncing 阶段");
  ok(seen.includes("uploading"), "出现过 uploading 阶段");
  ok(seen[seen.length - 1] === "idle", "最后是 idle", seen.join(" → "));
}

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
