/**
 * 同步内核（`runSyncRound` / `decideAction`）纯逻辑测试。
 *
 * 为什么单独测这一层：它被**两个东西**共用——设置窗口的常驻同步引擎，
 * 以及搜索窗口里插件调用的 `ms.sync.trigger()`。一旦这条内核的行为漂移
 * （比如冲突策略判反、下载后没走还原），受害的不只是面板上的按钮，还包括
 * 第三方插件发起的同步，而且都是「静默地传错数据」这类难排查的问题。
 *
 * 做法：把 `./bridge` 与 `./snapshot` 用 esbuild 风格的模块替换桩注入
 * （Node 的 `module.register` / 预置 import 映射），完全离线地跑内核。
 *
 * 用法: node test/sync-round.test.mjs
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 记录内核调了哪些外部命令，供断言
const calls = { remoteMeta: 0, upload: 0, download: 0, snapshot: 0, restore: [] };
const state = {
  remoteExists: false,
  remoteModified: 0,
  uploadThrows: null,
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
  calls.restore.length = 0;
  state.remoteExists = false;
  state.remoteModified = 0;
  state.uploadThrows = null;
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

/* ============ 1. 决策：纯函数边界 ============ */
{
  ok(decideAction(cfg(), null, 0) === "upload", "无远端 → 上传（首次）");
  ok(decideAction(cfg(), { exists: false, rev: "", modified: 0, size: 0 }, 0) === "upload", "exists=false 也算首次");
  ok(decideAction(cfg({ conflict: "local" }), { exists: true, rev: "x", modified: 999, size: 1 }, 1) === "upload", "local 策略永远上传");
  ok(decideAction(cfg({ conflict: "remote" }), { exists: true, rev: "x", modified: 0, size: 1 }, 999) === "download", "remote 策略永远下载");
  ok(decideAction(cfg({ conflict: "ask" }), { exists: true, rev: "x", modified: 0, size: 1 }, 0) === "ask", "ask 策略交给用户");
  // newer：远端比上次同步新 → 下载；否则上传
  ok(decideAction(cfg(), { exists: true, rev: "x", modified: 5000, size: 1 }, 1000) === "download", "newer 且远端更新 → 下载");
  ok(decideAction(cfg(), { exists: true, rev: "x", modified: 500, size: 1 }, 1000) === "upload", "newer 但本机更新 → 上传");
}

/* ============ 2. 内核：无远端 → 上传，且上传的是「快照」 ============ */
{
  reset();
  const final = await runSyncRound(
    { getConfig: () => cfg(), onAskConflict: async () => "local" },
    "manual"
  );
  ok(calls.remoteMeta === 1, "先查一次远端");
  ok(calls.snapshot === 1, "上传前创建了快照");
  ok(calls.upload === 1, "发起了上传");
  ok(calls.download === 0, "没有多余下载");
  ok(final.status === "idle", "结束后回到 idle", final.status);
  ok(final.lastSyncAt > 0, "记录了同步时间");
  ok(final.lastError === "", "无错误");
}

/* ============ 3. 内核：远端更新 → 下载并还原 ============ */
{
  reset();
  state.remoteExists = true;
  state.remoteModified = 9_000_000;
  const final = await runSyncRound(
    {
      getConfig: () => cfg(),
      onAskConflict: async () => "local",
    },
    "manual",
    { lastSyncAt: 1000 } // 上次同步远早于远端修改时间
  );
  ok(calls.download === 1, "下载了一次");
  ok(calls.upload === 0, "没有上传");
  ok(calls.restore.length === 1, "下载后执行了还原");
  ok(calls.restore[0].categories?.length === 0, "还原覆盖全部分区（空数组 = 全部）");
  ok(final.status === "idle", "结束时 idle", final.status);
}

/* ============ 4. 内核：ask 策略把选择权交给调用方 ============ */
{
  reset();
  state.remoteExists = true;
  state.remoteModified = 9_000_000;
  let asked = 0;
  const final = await runSyncRound(
    {
      getConfig: () => cfg({ conflict: "ask" }),
      onAskConflict: async (meta) => {
        asked++;
        ok(meta.remoteModified === 9_000_000, "把远端修改时间交给询问方", String(meta.remoteModified));
        return "remote"; // 用户选择「远端覆盖本机」
      },
    },
    "manual"
  );
  ok(asked === 1, "ask 策略下询问了一次");
  ok(calls.download === 1, "用户选远端 → 下载");
  ok(calls.upload === 0, "没有上传");
  ok(final.status === "idle", "结束时 idle", final.status);
}

/* ============ 5. 内核：失败以状态表达，不把异常抛给调用方 ============
 * 这一条对插件尤其重要：`ms.sync.trigger()` 内部就走这条内核，
 * 失败必须以 `{ status: "error", lastError }` 返回，而不是 reject——否则
 * 插件端只能拿到一个笼统的异常，也没法做「同步失败了」的界面提示。 */
{
  reset();
  state.uploadThrows = "WebDAV 认证失败";
  const final = await runSyncRound(
    { getConfig: () => cfg(), onAskConflict: async () => "local" },
    "plugin"
  );
  ok(final.status === "error", "失败落到 status=error", final.status);
  ok(final.lastError.includes("WebDAV 认证失败"), "错误原因原样带回", final.lastError);
  ok(calls.upload === 1, "确实尝试过上传");
}

/* ============ 6. 内核：状态回调实时反映阶段（插件做进度展示用） ============ */
{
  reset();
  const seen = [];
  await runSyncRound(
    {
      getConfig: () => cfg(),
      onAskConflict: async () => "local",
      onState: (st) => seen.push(st.status),
    },
    "plugin"
  );
  ok(seen.includes("syncing"), "出现过 syncing 阶段");
  ok(seen.includes("uploading"), "出现过 uploading 阶段");
  ok(seen[seen.length - 1] === "idle", "最后是 idle", seen.join(" → "));
}

/* ============ 7. 内核：把 lastSyncAt 交给询问方（搜索窗口据此拒绝覆盖远端）
 * 背景：`cloud.rs sync_upload` 是无条件 PUT，远端一旦在上次同步之后被改过，
 * 本机覆盖就不可逆。没有确认框的调用方（搜索窗口的 ms.sync.trigger）必须
 * 能判断这一点，否则会静默丢掉远端那份。 */
{
  reset();
  state.remoteExists = true;
  state.remoteModified = 9_000_000;
  let metaSeen = null;
  const final = await runSyncRound(
    {
      getConfig: () => cfg({ conflict: "ask" }),
      onAskConflict: async (meta) => {
        metaSeen = meta;
        if (meta.remoteModified > meta.lastSyncAt) {
          throw new Error("远端在上次同步后有新改动");
        }
        return "local";
      },
    },
    "plugin",
    { lastSyncAt: 1000 }
  );
  ok(metaSeen?.lastSyncAt === 1000, "把本机上次同步时间交给询问方", String(metaSeen?.lastSyncAt));
  ok(metaSeen?.remoteModified === 9_000_000, "远端修改时间照常透传", String(metaSeen?.remoteModified));
  ok(final.status === "error", "真冲突 → 以 status=error 返回（不 reject）", final.status);
  ok(final.lastError.includes("远端在上次同步后有新改动"), "冲突原因原样带回", final.lastError);
  ok(calls.upload === 0, "没有覆盖远端");
  ok(final.lastSyncAt === 1000, "失败不推进上次同步时间", String(final.lastSyncAt));
}

/* ============ 8. 远端自上次同步后没变过 → 照常本机覆盖（与改造前行为一致） ==== */
{
  reset();
  state.remoteExists = true;
  state.remoteModified = 500; // 早于 lastSyncAt
  const final = await runSyncRound(
    { getConfig: () => cfg({ conflict: "ask" }), onAskConflict: async () => "local" },
    "plugin",
    { lastSyncAt: 1000 }
  );
  ok(calls.upload === 1, "远端未变 → 正常上传");
  ok(final.status === "idle", "结束时 idle", final.status);
  ok(final.lastError === "", "无错误");
}

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
