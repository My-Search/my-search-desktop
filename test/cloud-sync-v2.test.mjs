/**
 * 云同步 v2（`src/lib/sync/cloud.ts`）测试。
 *
 * 钉死的语义：
 *   1. 分片决策表（远端缺失 / 首次出现 / 单边变化 / 双边变化四策略）；
 *   2. 首次建立 → 推全量并写 manifest；
 *   3. 无变化轮次 → **不上传**（只传脏片）；
 *   4. 远端数据分片变化 → 本机没改过时**不立刻下载**，只记 pending（懒加载）；
 *   5. `ensurePluginData` 才真正拉取并清 pending；
 *   6. 分片对象路径按摘要命名（内容寻址）；
 *   7. 面板「查看内容」：内容清单按 manifest 摘要拼路径、两片条目合并。
 *
 * 用法: node test/cloud-sync-v2.test.mjs
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
register(pathToFileURL(path.join(root, "test/_cloud-stub-loader.mjs")).href, pathToFileURL(root));

const cloud = await import(pathToFileURL(path.join(root, "src/lib/sync/cloud.ts")).href);
const stub = await import(pathToFileURL(path.join(root, "test/_cloud-stub.mjs")).href);
const { __cloud } = stub;

let passed = 0;
const failures = [];
function ok(name, cond, extra = "") {
  if (cond) {
    passed += 1;
  } else {
    failures.push(`${name}${extra ? ` — ${extra}` : ""}`);
  }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/* ===================== 1) 决策表 ===================== */
const base = { conflict: "newer", lastSyncAt: 1000 };

eq("远端缺片 + 本机有内容 → 上传", cloud.decideShardAction({ ...base, local: "L", localFiles: 3 }), "upload");
eq("远端缺片 + 本机空 → 跳过", cloud.decideShardAction({ ...base, local: "E", localFiles: 0 }), "skip");
eq("首次出现 + 内容相同 → 跳过", cloud.decideShardAction({ ...base, local: "X", remote: "X", localFiles: 2 }), "skip");
eq("首次出现 + 本机空 → 下载", cloud.decideShardAction({ ...base, local: "E", remote: "R", localFiles: 0 }), "download");
eq("首次出现 + 都有内容 → 冲突", cloud.decideShardAction({ ...base, local: "L", remote: "R", localFiles: 1 }), "conflict");
eq(
  "基线一致 → 跳过",
  cloud.decideShardAction({ ...base, local: "A", base: "A", remote: "A", localFiles: 1 }),
  "skip"
);
eq(
  "仅本机变 → 上传",
  cloud.decideShardAction({ ...base, local: "B", base: "A", remote: "A", localFiles: 1 }),
  "upload"
);
eq(
  "仅远端变 → 下载",
  cloud.decideShardAction({ ...base, local: "A", base: "A", remote: "B", localFiles: 1 }),
  "download"
);
eq(
  "两边都变 + local 策略 → 上传",
  cloud.decideShardAction({ conflict: "local", lastSyncAt: 1000, local: "B", base: "A", remote: "C", localFiles: 1 }),
  "upload"
);
eq(
  "两边都变 + remote 策略 → 下载",
  cloud.decideShardAction({ conflict: "remote", lastSyncAt: 1000, local: "B", base: "A", remote: "C", localFiles: 1 }),
  "download"
);
eq(
  "两边都变 + newer 远端更新 → 下载",
  cloud.decideShardAction({
    conflict: "newer",
    lastSyncAt: 1000,
    local: "B",
    base: "A",
    remote: "C",
    localFiles: 1,
    remoteUpdatedAt: 2000,
  }),
  "download"
);
eq(
  "两边都变 + newer 本机更新 → 上传",
  cloud.decideShardAction({
    conflict: "newer",
    lastSyncAt: 1000,
    local: "B",
    base: "A",
    remote: "C",
    localFiles: 1,
    remoteUpdatedAt: 500,
  }),
  "upload"
);
eq(
  "两边都变 + ask → 冲突",
  cloud.decideShardAction({ conflict: "ask", lastSyncAt: 1000, local: "B", base: "A", remote: "C", localFiles: 1 }),
  "conflict"
);

/* ===================== 2) 对象路径 ===================== */
eq("core 片路径", cloud.shardRel("core", "abc"), "core-abc.msbackup");
eq("body 片路径", cloud.shardRel("body", "abc", "demo"), "plugins/demo/body-abc.msbackup");
eq("data 片路径", cloud.shardRel("data", "abc", "demo"), "plugins/demo/data-abc.msbackup");

/* ===================== 3) 完整轮次（内存云） ===================== */
__cloud.local.bodyFiles = { demo: 2 };
__cloud.local.dataFiles = { demo: 1 };
__cloud.local.pluginLs = { demo: { "PLUGIN_DATA:demo:k": 1 } };
__cloud.local.core = { keyA: 1 };

const opts = {
  getConfig: () => ({ ...__cloud.config, enabled: __cloud.enabled }),
  getState: async () => JSON.parse(JSON.stringify(__cloud.state)),
  patchState: async (p) => {
    Object.assign(__cloud.state, p);
    return JSON.parse(JSON.stringify(__cloud.state));
  },
  onState: () => {},
};

const round1 = await cloud.runCloudRound(opts, "r1", {});
eq("首轮状态 idle", round1.status, "idle");
eq("首轮写入 manifest schema", __cloud.manifest?.schema, "ms.cloud/2");
ok("manifest 含插件 body 片", !!__cloud.manifest?.plugins?.demo?.body?.digest);
ok("manifest 含插件 data 片", !!__cloud.manifest?.plugins?.demo?.data?.digest);
eq("首轮已初始化", __cloud.state.initialized, true);
eq("首轮 cloudFormat=2", __cloud.state.cloudFormat, 2);
ok("首轮上传了 core + body + data", __cloud.puts.length === 3, `实际 ${__cloud.puts.length}`);
ok(
  "上传对象按摘要命名",
  __cloud.puts.every((p) => p.rel.includes(p.digest)),
  __cloud.puts.map((p) => p.rel).join(", ")
);
eq("首轮建立基线", typeof __cloud.state.shards?.core, "string");

/* 面板「查看内容」：按 manifest 的摘要拼出分片路径，再解析条目 */
const content = await cloud.cloudPluginContents("demo");
ok(
  "内容清单走 body/data 分片路径",
  content.entries.some((e) => e.shard === "body") && content.entries.some((e) => e.shard === "data"),
  JSON.stringify(content.entries)
);
eq("内容清单条目数 = 两片文件数之和", content.entries.length, 3);

/* 第 2 轮：本机与远端都没变 → 只提交指针，不上传任何片 */
const putsBefore = __cloud.puts.length;
const round2 = await cloud.runCloudRound(opts, "r2", {});
eq("无变化轮次 idle", round2.status, "idle");
eq("无变化轮次不上传", __cloud.puts.length, putsBefore);
ok("无变化轮次不下载", __cloud.gets.length === 0);

/* 第 3 轮：远端数据片变了 → 懒加载，只记 pending，不下载 */
const newDataDigest = "data-demo-remote-2";
__cloud.manifest.plugins.demo.data = { digest: newDataDigest, bytes: 40, updatedAt: Date.now() + 5000 };
__cloud.manifest.rev += 1;
__cloud.objects.set(`plugins/demo/data-${newDataDigest}.msbackup`, {
  kind: "data",
  pluginId: "demo",
  ls: { "PLUGIN_DATA:demo:k": 2 },
  files: 1,
});
const round3 = await cloud.runCloudRound(opts, "r3", {});
eq("远端数据变化轮次 idle", round3.status, "idle");
eq("数据片记入 pending", __cloud.state.pending?.demo, newDataDigest);
eq("懒加载：本轮没有下载", __cloud.gets.length, 0);

/* 第 4 轮：ensurePluginData 才真正拉取 */
const ensured = await cloud.ensurePluginData("demo");
eq("按需下载成功", ensured.status, "applied");
eq("pending 清空", __cloud.state.pending?.demo, undefined);
ok("下载后本机数据已更新", __cloud.local.pluginLs.demo["PLUGIN_DATA:demo:k"] === 2);
eq(
  "基线跟上远端数据摘要",
  __cloud.state.shards?.plugins?.demo?.data,
  newDataDigest
);

/* 第 5 轮：数据已对齐 → 不再有 pending，也不上传 */
const round4 = await cloud.runCloudRound(opts, "r4", {});
eq("对齐后轮次 idle", round4.status, "idle");
eq("对齐后无 pending", __cloud.state.pending?.demo, undefined);

/* 第 6 轮：本机数据再改 → 上传该插件的 data 片（只传脏片） */
__cloud.local.pluginLs.demo = { "PLUGIN_DATA:demo:k": 3 };
const putsBefore5 = __cloud.puts.length;
const round5 = await cloud.runCloudRound(opts, "r5", {});
eq("本机改动轮次 idle", round5.status, "idle");
ok(
  "只上传 data 片（core/body 未变）",
  __cloud.puts.length === putsBefore5 + 1 && __cloud.puts.at(-1).scope === "data:demo",
  __cloud.puts.slice(putsBefore5).map((p) => p.scope).join(", ")
);

/* 第 7 轮：本机卸载该插件 → 只摘 manifest 引用，不上传「空片」 */
delete __cloud.local.bodyFiles.demo;
delete __cloud.local.dataFiles.demo;
delete __cloud.local.pluginLs.demo;
const putsBefore6 = __cloud.puts.length;
const round6 = await cloud.runCloudRound(opts, "r6", {});
eq("卸载轮次 idle", round6.status, "idle");
eq("卸载后 manifest 不再列出该插件", __cloud.manifest?.plugins?.demo, undefined);
eq("卸载不产生上传", __cloud.puts.length, putsBefore6);

/* ===================== 第 8 轮：412 并发提交的合并语义 ===================== */
// 远端多出一个「别设备的插件」引用；本轮本机上传 demo，提交时别的设备抢先提交。
// 合并必须只覆盖本机**真正上传过**的片，绝不能把别人刚提交的分片指针回滚成旧值。
__cloud.local.bodyFiles = { demo: 5 };
__cloud.local.dataFiles = { demo: 1 };
__cloud.local.pluginLs = { demo: { "PLUGIN_DATA:demo:k": 5 } };
__cloud.manifest.plugins.other = { data: { digest: "other-data-old", bytes: 9, updatedAt: 1 } };
__cloud.manifest.rev += 1;
__cloud.etagSeq += 1; // 让本轮读到的是最新 etag
__cloud.foreignCommit = (c) => {
  c.manifest.plugins.other.data = { digest: "other-data-new", bytes: 9, updatedAt: Date.now() + 1 };
  c.manifest.rev += 1;
  c.etagSeq += 1;
};
const round7 = await cloud.runCloudRound(opts, "r7", {});
eq("并发提交轮次仍成功（412 已重试）", round7.status, "idle");
eq("别设备刚提交的分片未被回滚", __cloud.manifest?.plugins?.other?.data?.digest, "other-data-new");
ok(
  "本机本轮上传的片已写入 manifest",
  !!__cloud.manifest?.plugins?.demo?.body?.digest && __cloud.manifest.plugins.demo.body.digest === __cloud.puts.findLast((p) => p.scope === "body:demo")?.digest,
  `manifest=${JSON.stringify(__cloud.manifest?.plugins?.demo)}`
);
eq("合并后 rev 仍单调递增", __cloud.manifest.rev >= 2, true);

/* ===================== 第 9 轮：冲突按插件隔离 ===================== */
// 规则：某个插件冲突时**只挂起那一片**，其它插件、其它片照常同步完；
// 裁决也只对该插件生效，不会「一刀切」把别的插件一起覆盖。
__cloud.config.conflict = "ask";
__cloud.state = {
  deviceId: "dev-a", target: "", initialized: false, remoteRev: "", remoteEtag: "",
  lastLocalDigest: "", lastSyncAt: 0, appliedRev: "", epoch: 1, cloudFormat: 0,
  manifestEtag: "", shards: null, pending: null, conflicts: [],
};
__cloud.manifest = null;
__cloud.objects.clear();
__cloud.puts.length = 0;
__cloud.gets.length = 0;
__cloud.pendingApply = null;
__cloud.etagSeq += 1;
__cloud.local.core = { keyA: 1 };
__cloud.local.bodyFiles = { demo: 2, alpha: 3 };
__cloud.local.dataFiles = { demo: 1, alpha: 1 };
__cloud.local.pluginLs = { demo: { "PLUGIN_DATA:demo:k": 1 }, alpha: { "PLUGIN_DATA:alpha:k": 1 } };

// 9a：先对齐一轮，建立干净的基线
const iso0 = await cloud.runCloudRound(opts, "iso0", {});
eq("隔离场景：对齐全绿", iso0.status, "idle");

// 9b：demo 数据两侧都改（该冲突），alpha 程序只有本机改（该上传）
const demoDataBase = __cloud.state.shards.plugins.demo.data;
const alphaBodyBase = __cloud.state.shards.plugins.alpha.body;
__cloud.local.pluginLs.demo = { "PLUGIN_DATA:demo:k": 2 };      // 本机改了 demo 数据
__cloud.local.bodyFiles.alpha = 5;                              // 本机改了 alpha 程序
const demoRemoteData = "data-demo-remote-ask";
__cloud.objects.set(`plugins/demo/data-${demoRemoteData}.msbackup`, {
  kind: "data", pluginId: "demo", ls: { "PLUGIN_DATA:demo:k": 9 }, files: 1,
});
__cloud.manifest.plugins.demo.data = { digest: demoRemoteData, bytes: 40, updatedAt: Date.now() + 60000 };
__cloud.manifest.rev += 1;
__cloud.etagSeq += 1;

const isoPuts = __cloud.puts.length;
const isoGets = __cloud.gets.length;
const iso1 = await cloud.runCloudRound(opts, "iso1", {});
eq("有冲突时状态 needs-choice", iso1.status, "needs-choice");
eq("冲突只列出 demo 数据片", iso1.conflicts.length, 1);
eq("冲突归属插件 demo", iso1.conflicts[0]?.pluginId, "demo");
eq("冲突类型数据片", iso1.conflicts[0]?.kind, "data");
ok("冲突带两侧体积", iso1.conflicts[0]?.localBytes > 0 && iso1.conflicts[0]?.remoteBytes === 40,
  JSON.stringify(iso1.conflicts[0]));
ok("其它插件的片照常上传（alpha 程序）",
  __cloud.puts.slice(isoPuts).some((p) => p.scope === "body:alpha"),
  __cloud.puts.slice(isoPuts).map((p) => p.scope).join(","));
ok("冲突片的本地内容没有被上传覆盖云端",
  !__cloud.puts.slice(isoPuts).some((p) => p.scope === "data:demo"),
  __cloud.puts.slice(isoPuts).map((p) => p.scope).join(","));
eq("冲突片也没有被强行下载", __cloud.gets.length, isoGets);
eq("云端 demo 数据指针保持远端版本", __cloud.manifest.plugins.demo.data.digest, demoRemoteData);
eq("alpha 程序指针已更新", __cloud.manifest.plugins.alpha.body.digest,
  __cloud.puts.findLast((p) => p.scope === "body:alpha")?.digest);
eq("alpha 程序基线已推进", __cloud.state.shards.plugins.alpha.body,
  __cloud.puts.findLast((p) => p.scope === "body:alpha")?.digest);
eq("alpha 程序基线确实变了", __cloud.state.shards.plugins.alpha.body !== alphaBodyBase, true);
eq("冲突片基线保持不动（下次还会提示）", __cloud.state.shards.plugins.demo.data, demoDataBase);
ok("冲突明细已持久化", __cloud.state.conflicts.length === 1 && __cloud.state.conflicts[0].pluginId === "demo");

// 9c：只裁决 demo → 该插件按选择走，其它插件保持已同步
const iso2Puts = __cloud.puts.length;
const iso2 = await cloud.runCloudRound({ ...opts, choices: { demo: "local" } }, "iso2", {});
eq("裁决后恢复 idle", iso2.status, "idle");
eq("裁决后冲突清空", iso2.conflicts.length, 0);
ok("只上传被裁决的 demo 数据片",
  __cloud.puts.slice(iso2Puts).length === 1 && __cloud.puts.at(-1).scope === "data:demo",
  __cloud.puts.slice(iso2Puts).map((p) => p.scope).join(","));
eq("demo 数据指针改为本机版本", __cloud.manifest.plugins.demo.data.digest,
  __cloud.puts.at(-1)?.digest);
eq("alpha 程序未被动过", __cloud.manifest.plugins.alpha.body.digest,
  __cloud.puts.findLast((p) => p.scope === "body:alpha")?.digest);


if (failures.length > 0) {
  console.error(`\n✗ cloud-sync-v2: ${failures.length} 条失败 / ${passed + failures.length} 条`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`✓ cloud-sync-v2: ${passed} 条断言全部通过`);
