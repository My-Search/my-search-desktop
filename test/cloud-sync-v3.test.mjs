/**
 * 云同步 v3 测试。
 *
 * 钉死的语义：
 *   1. 三方决策表（本机/远端/基线，缺失/单边/双边）；
 *   2. 首次建立 manifest-v3 → 全量对象上传；
 *   3. 无变化轮次 → 不写 manifest（别每 30 分钟无脑覆盖提交点）；
 *   4. 剪贴板加一条 → 只上传该条（或只写内联），不重传整片；
 *   5. 图片 → blob 内容寻址上传/下载；
 *   6. 双边改同一文件 → 挂起为冲突，不静默覆盖。
 *
 * 用法: node test/cloud-sync-v3.test.mjs
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
register(pathToFileURL(path.join(root, "test/_cloud-stub-loader.mjs")).href, pathToFileURL(root));

const cloud = await import(pathToFileURL(path.join(root, "src/lib/sync/cloud.ts")).href);
const v3 = await import(pathToFileURL(path.join(root, "src/lib/sync/cloud-v3.ts")).href);
const stub = await import(pathToFileURL(path.join(root, "test/_cloud-stub.mjs")).href);
const { __cloud } = stub;

let passed = 0;
const failures = [];
function ok(name, cond, extra = "") {
  if (cond) passed += 1;
  else failures.push(`${name}${extra ? ` — ${extra}` : ""}`);
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/* ===================== 1) 决策表 ===================== */
const d = (o) => v3.decideV3({ localExists: true, remoteExists: true, baseExists: true, ...o });
eq("两边都没 → 跳过", d({ local: "", remote: "", base: "", localExists: false, remoteExists: false, baseExists: false }), "skip");
eq("远端新出现、本机没有 → 下载", d({ local: "", remote: "R", base: "", localExists: false, remoteExists: true, baseExists: false }), "download");
eq("本机新出现、远端没有 → 上传", d({ local: "L", remote: "", base: "", remoteExists: false, baseExists: false }), "upload");
eq("本机/远端相同 → 跳过", d({ local: "A", remote: "A", base: "" }), "skip");
eq("仅远端变 → 下载", d({ local: "A", remote: "B", base: "A" }), "download");
eq("仅本机变 → 上传", d({ local: "B", remote: "A", base: "A" }), "upload");
eq("两边都变 → 冲突", d({ local: "B", remote: "C", base: "A" }), "conflict");
eq("本机删、远端没改 → 删远端", d({ local: "", remote: "A", base: "A", localExists: false, remoteExists: true }), "delete-remote");
eq("远端删、本机也改 → 冲突", d({ local: "B", remote: "", base: "A", remoteExists: false }), "conflict");
eq("远端删、本机没改 → 删本机", d({ local: "A", remote: "", base: "A", localExists: true, remoteExists: false }), "delete-local");
eq("用户选本机 → 上传", d({ local: "B", remote: "C", base: "A", choice: "local" }), "upload");
eq("用户选远端 → 下载", d({ local: "B", remote: "C", base: "A", choice: "remote" }), "download");

/* ===================== 2) 首次建立 ===================== */
function reset() {
  __cloud.config.cloudFormat = 3;
  __cloud.state = {
    deviceId: "dev-a",
    deviceName: "测试机",
    target: "",
    initialized: false,
    remoteRev: "",
    remoteEtag: "",
    lastLocalDigest: "",
    lastSyncAt: 0,
    appliedRev: "",
    epoch: 1,
    cloudFormat: 0,
    manifestEtag: "",
    shards: null,
    pending: null,
    conflicts: null,
    v3: null,
  };
  __cloud.local = {
    core: { theme: "dark" },
    pluginLs: { "com.mysearch.clipboard": { "PLUGIN_DATA:com.mysearch.clipboard:foo": "bar" } },
    bodyFiles: { "com.mysearch.clipboard": 3 },
    dataFiles: {},
    settings: { a: 1 },
  };
  __cloud.v3 = {
    manifest: null,
    etagSeq: 0,
    foreignCommit: null,
    local: {
      core: {},
      plugins: {
        "com.mysearch.clipboard": {
          files: {
            "clipboard/items/a.json": JSON.stringify({ id: "a", text: "one", createdAt: 1 }),
            "kv/annotations.json": JSON.stringify({ favorites: [] }),
          },
          blobs: { "clipboard/a.png": "png-a" },
          state: {},
        },
      },
    },
    objects: new Map(),
    puts: [],
    gets: [],
    applied: [],
    deleted: [],
  };
  __cloud.puts = [];
  __cloud.gets = [];
  __cloud.etagSeq = 0;
  __cloud.manifest = null;
}
function opts(extra = {}) {
  return {
    getConfig: async () => ({ ...__cloud.config, cloudFormat: 3 }),
    getState: async () => stub.syncStateGet(),
    patchState: async (p) => stub.syncStatePatch(p),
    ...extra,
  };
}

reset();
let s = await cloud.runCloudRound(opts(), "test-bootstrap");
eq("首次同步进入 idle", s.status, "idle");
ok("已写 manifest-v3", !!__cloud.v3.manifest, "manifest 为空");
eq("manifest schema", __cloud.v3.manifest?.schema, "ms.cloud/3");
ok("core 对象已上传", __cloud.puts.some((p) => p.scope === "core"));
ok("body 对象已上传", __cloud.puts.some((p) => p.scope === "body:com.mysearch.clipboard"));
ok("图片 blob 已上传", __cloud.v3.puts.some((p) => p.blob && p.rel === "clipboard/a.png"));
eq(
  "基线已持久化",
  __cloud.state.v3?.plugins?.["com.mysearch.clipboard"]?.files?.["clipboard/items/a.json"]?.startsWith("v3-"),
  true
);
eq("cloudFormat=3", __cloud.state.cloudFormat, 3);

/* ===================== 3) 无变化不提交 ===================== */
const etagBefore = __cloud.v3.etagSeq;
const putsBefore = __cloud.v3.puts.length;
s = await cloud.runCloudRound(opts(), "test-noop");
eq("无变化仍 idle", s.status, "idle");
eq("无变化不新增对象", __cloud.v3.puts.length, putsBefore);
eq("无变化不写 manifest", __cloud.v3.etagSeq, etagBefore);

/* ===================== 4) 加一条剪贴板 ===================== */
const longText = "长文本-" + "x".repeat(3000);
__cloud.v3.local.plugins["com.mysearch.clipboard"].files["clipboard/items/b.json"] = JSON.stringify({
  id: "b",
  text: longText,
  createdAt: 2,
});
s = await cloud.runCloudRound(opts(), "test-add-item");
eq("加条目后 idle", s.status, "idle");
const putsAfter = __cloud.v3.puts.length;
eq("只上传新增条目", putsAfter - putsBefore, 1);
eq("上传的是 b", __cloud.v3.puts.at(-1)?.rel, "clipboard/items/b.json");
ok(
  "旧条目没有被重传",
  !__cloud.v3.puts.slice(putsBefore).some((p) => p.rel === "clipboard/items/a.json")
);
ok(
  "manifest 已包含 b",
  !!__cloud.v3.manifest?.plugins?.["com.mysearch.clipboard"]?.files?.["clipboard/items/b.json"]
);

/* ===================== 5) 图片 blob 下载 ===================== */
__cloud.v3.manifest.plugins["com.mysearch.clipboard"].blobs["clipboard/c.png"] = {
  digest: "v3-png-c",
  bytes: 5,
  updatedAt: 2,
};
delete __cloud.v3.local.plugins["com.mysearch.clipboard"].blobs["clipboard/c.png"];
__cloud.v3.objects.set("v3-png-c", "png-c");
s = await cloud.runCloudRound(opts(), "test-blob-download");
eq("远端新图片 → 下载", s.status, "idle");
ok(
  "图片已落地",
  __cloud.v3.local.plugins["com.mysearch.clipboard"].blobs["clipboard/c.png"] === "png-c"
);

/* ===================== 6) 双边改同一文件 → 冲突 ===================== */
const oldAnnotations = __cloud.v3.local.plugins["com.mysearch.clipboard"].files["kv/annotations.json"];
__cloud.v3.local.plugins["com.mysearch.clipboard"].files["kv/annotations.json"] = JSON.stringify({
  favorites: ["local"],
});
__cloud.v3.manifest.plugins["com.mysearch.clipboard"].files["kv/annotations.json"] = {
  digest: "v3-remote-fav",
  bytes: 10,
  updatedAt: 3,
};
s = await cloud.runCloudRound(opts(), "test-conflict");
eq("双边改 → needs-choice", s.status, "needs-choice");
ok("冲突按插件列出", s.conflicts.some((c) => c.pluginId === "com.mysearch.clipboard" && c.path === "kv/annotations.json"));
ok("冲突不静默上传", !__cloud.v3.puts.some((p) => p.rel === "kv/annotations.json"));
// 复原，避免影响后续
__cloud.v3.local.plugins["com.mysearch.clipboard"].files["kv/annotations.json"] = oldAnnotations;

/* ===================== 7) v2 → v3 迁移：先对齐 v2，再建 v3 ===================== */
reset();
__cloud.config.cloudFormat = 3;
__cloud.state.initialized = true;
__cloud.state.cloudFormat = 2;
__cloud.state.remoteRev = "1";
const migLs = await stub.splitStateByShard();
const migCore = await stub.cloudShardPut("core", migLs.core);
const migBody = await stub.cloudShardPut("body:com.mysearch.clipboard", {});
const migData = await stub.cloudShardPut(
  "data:com.mysearch.clipboard",
  __cloud.local.pluginLs["com.mysearch.clipboard"]
);
__cloud.manifest = {
  schema: "ms.cloud/2",
  rev: 1,
  updatedAt: 1,
  updatedBy: "dev-a",
  appVersion: "9.9.9-test",
  devices: {},
  core: { digest: migCore.digest, bytes: migCore.bytes, updatedAt: 1 },
  plugins: {
    "com.mysearch.clipboard": {
      body: { digest: migBody.digest, bytes: migBody.bytes, updatedAt: 1 },
      data: { digest: migData.digest, bytes: migData.bytes, updatedAt: 1 },
    },
  },
};
__cloud.state.shards = {
  core: migCore.digest,
  plugins: { "com.mysearch.clipboard": { body: migBody.digest, data: migData.digest } },
};
s = await cloud.runCloudRound(opts(), "test-migrate");
eq("迁移后进入 idle", s.status, "idle");
ok("迁移后生成 manifest-v3", !!__cloud.v3.manifest);
eq("迁移后 cloudFormat=3", __cloud.state.cloudFormat, 3);
ok("迁移后 v2 manifest 仍保留", !!__cloud.manifest);
ok("迁移后 v3 有剪贴板条目", !!__cloud.v3.manifest?.plugins?.["com.mysearch.clipboard"]?.files?.["clipboard/items/a.json"]);

// 旧客户端在 v3 之后又提交 v2：即使本机随后也提交了 v3，警告不能消失。
// 比较基线必须是迁移时的 v2 版本，否则 v3 的 updatedAt 一更新就把警告压掉。
__cloud.manifest.rev = 3;
__cloud.manifest.updatedAt = Date.now() - 1;
__cloud.v3.local.plugins["com.mysearch.clipboard"].files["clipboard/items/b.json"] = {
  id: "b",
  text: "迁移后新条目",
  createdAt: Date.now(),
};
s = await cloud.runCloudRound(opts(), "test-legacy-after-v3");
eq("v3 在本机变化后仍正常提交", s.status, "idle");
s = await cloud.runCloudRound(opts(), "test-legacy-warning");
ok("旧客户端写过 v2 时持续给警告", String(s.lastError || "").includes("旧客户端"));
eq("警告不影响同步状态", s.status, "idle");

/* ===================== 8) 新设备首次连接选「用云端」→ 插件必须装回来 ===================== */
// 先在一台「旧设备」上把云端建立起来（含剪贴板主体/文件/图片）
reset();
await cloud.runCloudRound(opts(), "seed-cloud-for-new-device");
const seededManifest = __cloud.v3.manifest;
const seededObjects = new Map(__cloud.v3.objects);
ok("云端已有剪贴板主体", !!seededManifest?.plugins?.["com.mysearch.clipboard"]?.body?.digest);

// 换成全新设备：只有本机设置，一个插件都没装（这正是「装了主体软件、还没同步过」）
__cloud.state = {
  deviceId: "dev-new",
  deviceName: "新设备",
  target: "",
  initialized: false,
  remoteRev: "",
  remoteEtag: "",
  lastLocalDigest: "",
  lastSyncAt: 0,
  appliedRev: "",
  epoch: 1,
  cloudFormat: 3,
  manifestEtag: "",
  shards: null,
  pending: null,
  conflicts: null,
  v3: null,
};
__cloud.local = { core: { theme: "light" }, pluginLs: {}, bodyFiles: {}, dataFiles: {}, settings: { a: 1 } };
__cloud.v3.local = { core: {}, plugins: {} };
__cloud.v3.manifest = seededManifest;
__cloud.v3.objects = seededObjects;
__cloud.v3.puts = [];
__cloud.v3.gets = [];
__cloud.v3.applied = [];
__cloud.puts = [];
__cloud.gets = [];

s = await cloud.runCloudRound(opts({ choice: "remote" }), "new-device-first-connect");
eq("新设备选「用云端」后 idle", s.status, "idle");
eq("插件主体已装回本机", __cloud.local.bodyFiles["com.mysearch.clipboard"], 3);
ok(
  "插件文件已下回本机",
  __cloud.v3.local.plugins["com.mysearch.clipboard"]?.files?.["clipboard/items/a.json"] !== undefined
);
ok(
  "插件图片已下回本机",
  __cloud.v3.local.plugins["com.mysearch.clipboard"]?.blobs?.["clipboard/a.png"] === "png-a"
);
eq("新设备已建立同步基线", __cloud.state.initialized, true);
eq(
  "基线指向云端摘要",
  __cloud.state.v3?.plugins?.["com.mysearch.clipboard"]?.body,
  seededManifest.plugins["com.mysearch.clipboard"].body.digest
);

/* ===================== 9) 稳态缺插件不自动装回（尊重主动卸载），可手动恢复 ===================== */
delete __cloud.local.bodyFiles["com.mysearch.clipboard"];
delete __cloud.v3.local.plugins["com.mysearch.clipboard"];
__cloud.v3.gets = [];
s = await cloud.runCloudRound(opts(), "steady-absent-plugin");
eq("稳态下缺插件不自动装回", __cloud.v3.gets.length, 0);
eq("稳态缺插件仍是 idle", s.status, "idle");

const restored = await v3.restorePluginFromCloud("com.mysearch.clipboard");
eq("「恢复到本机」返回 applied", restored.status, "applied");
eq("恢复后主体已装回", __cloud.local.bodyFiles["com.mysearch.clipboard"], 3);
ok(
  "恢复后文件已落地",
  __cloud.v3.local.plugins["com.mysearch.clipboard"]?.files?.["kv/annotations.json"] !== undefined
);
ok(
  "恢复后图片已落地",
  __cloud.v3.local.plugins["com.mysearch.clipboard"]?.blobs?.["clipboard/a.png"] === "png-a"
);
const restoredAgain = await v3.restorePluginFromCloud("com.mysearch.clipboard");
eq("本机已完整时返回 ready（不重复下载）", restoredAgain.status, "ready");

/* ===================== 10) 面板统计：云端有、本机没装 → 「本机未安装」 ===================== */
// 复用第 8 节的云端种子：清空本机插件，模拟「已经同步过、但插件被漏装」的设备
__cloud.config.cloudFormat = 3;
__cloud.local.bodyFiles = {};
__cloud.v3.local.plugins = {};
const overview = await cloud.cloudOverview();
const row = overview.plugins.find((p) => p.id === "com.mysearch.clipboard");
ok("面板仍能看到云端插件", !!row);
eq("面板标出本机未安装", row?.absent, true);
eq("面板据此统计待恢复数量", overview.pendingCount, 1);

/* ===================== 11) 卸载 → 云端删除 + 墓碑，别的设备不能复活 ===================== */
/** 给本模块装一个最小 localStorage（只有注册表），用于 installedAt 判重装 */
function setRegistry(plugins) {
  const key = "my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY";
  const data = JSON.stringify({ version: 1, plugins });
  globalThis.localStorage = {
    getItem: (k) => (k === key ? data : null),
    setItem: () => undefined,
    removeItem: () => undefined,
  };
}

reset();
await cloud.runCloudRound(opts(), "seed-before-uninstall");
eq("卸载前云端有剪贴板", !!__cloud.v3.manifest.plugins["com.mysearch.clipboard"], true);

const removed = await v3.removePluginFromCloud("com.mysearch.clipboard");
eq("卸载清理云端返回 deleted", removed.status, "deleted");
eq("云端条目已删除", __cloud.v3.manifest.plugins["com.mysearch.clipboard"], undefined);
ok("云端留下墓碑", (__cloud.v3.manifest.deleted?.["com.mysearch.clipboard"]?.at ?? 0) > 0);
eq("本机基线已摘掉", __cloud.state.v3?.plugins?.["com.mysearch.clipboard"], undefined);
eq("删除成功不留下待办", __cloud.state.pendingPluginDeletes ?? null, null);

// 另一台设备还装着「卸载前的老副本」：下一轮绝不能把它重新推回云端
const tombAt = __cloud.v3.manifest.deleted["com.mysearch.clipboard"].at;
setRegistry([
  { id: "com.mysearch.clipboard", name: "剪贴板", installedAt: tombAt - 1000, dir: "C:\\plugins\\clipboard" },
]);
const putsBeforeTombstone = __cloud.v3.puts.length;
s = await cloud.runCloudRound(opts(), "old-copy-must-not-revive");
eq("老副本同步仍 idle", s.status, "idle");
eq("老副本没有被重新上云", __cloud.v3.manifest.plugins["com.mysearch.clipboard"], undefined);
eq("老副本没有产生上传", __cloud.v3.puts.length, putsBeforeTombstone);
ok("墓碑仍在", !!__cloud.v3.manifest.deleted?.["com.mysearch.clipboard"]);

// 卸载之后重新安装（installedAt 晚于墓碑）→ 解除墓碑，按新插件重新上传
setRegistry([
  { id: "com.mysearch.clipboard", name: "剪贴板", installedAt: tombAt + 1000, dir: "C:\\plugins\\clipboard" },
]);
s = await cloud.runCloudRound(opts(), "reinstall-after-uninstall");
eq("重装后同步 idle", s.status, "idle");
ok("重装后重新上云", !!__cloud.v3.manifest.plugins["com.mysearch.clipboard"]);
eq("重装后墓碑解除", __cloud.v3.manifest.deleted?.["com.mysearch.clipboard"], undefined);

/* ===================== 12) 离线卸载 → 待办，下一轮补删 ===================== */
reset();
await cloud.runCloudRound(opts(), "seed-before-offline-uninstall");
// 本机这份是「很久以前装的」，删除待办的时间晚于它 → 应当执行删除
setRegistry([
  { id: "com.mysearch.clipboard", name: "剪贴板", installedAt: 1, dir: "C:\\plugins\\clipboard" },
]);
__cloud.enabled = false;
__cloud.state.target = "dav-target-a";
const queued = await v3.removePluginFromCloud("com.mysearch.clipboard");
eq("云同步关闭时删除记为待办", queued.status, "queued");
eq(
  "待办记下了插件",
  __cloud.state.pendingPluginDeletes?.["com.mysearch.clipboard"]?.at > 0,
  true
);
eq(
  "待办带上同步目标指纹",
  __cloud.state.pendingPluginDeletes?.["com.mysearch.clipboard"]?.target,
  "dav-target-a"
);
__cloud.enabled = true;
s = await cloud.runCloudRound(opts(), "apply-queued-delete");
eq("补删后 idle", s.status, "idle");
eq("补删后云端条目已删除", __cloud.v3.manifest.plugins["com.mysearch.clipboard"], undefined);
ok("补删后留下墓碑", !!__cloud.v3.manifest.deleted?.["com.mysearch.clipboard"]);
eq("补删成功清空待办", __cloud.state.pendingPluginDeletes ?? null, null);

/* ===================== 12b) 删除待办还没执行，用户又重装 → 取消删除、按新插件上传 ===================== */
reset();
await cloud.runCloudRound(opts(), "seed-before-requeue");
setRegistry([
  { id: "com.mysearch.clipboard", name: "剪贴板", installedAt: 1, dir: "C:\\plugins\\clipboard" },
]);
__cloud.enabled = false;
await v3.removePluginFromCloud("com.mysearch.clipboard");
const requeueAt = __cloud.state.pendingPluginDeletes["com.mysearch.clipboard"].at;
setRegistry([
  {
    id: "com.mysearch.clipboard",
    name: "剪贴板",
    installedAt: requeueAt + 1000,
    dir: "C:\\plugins\\clipboard",
  },
]);
__cloud.enabled = true;
s = await cloud.runCloudRound(opts(), "reinstall-cancels-queued-delete");
eq("重装取消待办后 idle", s.status, "idle");
eq("重装取消待办不产生冲突", s.conflicts.length, 0);
ok("重装后插件按新插件重新上传", !!__cloud.v3.manifest.plugins["com.mysearch.clipboard"]);
eq("取消后待办已清空", __cloud.state.pendingPluginDeletes ?? null, null);

/* ===================== 13) 墓碑插件不能「恢复到本机」 ===================== */
// 12b 又把插件传回去了，这里再删一次，验证墓碑会拦住「恢复到本机」
await v3.removePluginFromCloud("com.mysearch.clipboard");
const restoreDeleted = await v3.restorePluginFromCloud("com.mysearch.clipboard");
eq("已删除插件恢复返回 missing", restoreDeleted.status, "missing");
ok("提示重新安装", String(restoreDeleted.message || "").includes("重新安装"));

if (failures.length) {
  console.error(`\n✗ cloud-sync-v3: ${failures.length} 条失败`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`✓ cloud-sync-v3: ${passed} 条断言全部通过`);
