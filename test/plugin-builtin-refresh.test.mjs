/**
 * 内置插件「内容变更即刷新」纯逻辑测试。
 *
 * 背景（真实踩到）：内置插件的启动引导只判「是否已安装」，装过就永远跳过。
 * 于是随应用升级更新的内置插件（改了界面 CSS/JS）在**已装用户**身上永远
 * 不生效——`plugins/<id>/` 落盘副本还是旧的，用户看到的界面纹丝不动
 * （本次「插件市场 / pi-agent 主题适配不生效」就是这个原因）。
 *
 * 修法：安装时记录**内容指纹**（`packageContentFingerprint`，与 zip 时间戳无关），
 * 启动时对比「随版本分发的内容」与「上次装的内容」，不一致就重装，且重装
 * 只覆盖文件与清单派生字段，用户态（enabled / autoStart / closeBehavior / 授权）保留。
 *
 * 本测试钉死三件事：
 *   1. 指纹只随**内容**变化：同内容不同顺序 / 不同时间戳 → 指纹相同；
 *      任一文件内容变化 → 指纹不同。
 *   2. `upsertPlugin` 对内置指纹的保留语义：安装方显式给出则以它为准；
 *      未给出则保留旧值（普通升级不擦指纹，避免多余重装）。
 *   3. 用户态在重装时不被覆盖（enabled / autoStart / closeBehavior / 权限）。
 *
 * 用法: node test/plugin-builtin-refresh.test.mjs
 */
import { packageContentFingerprint } from "../src/lib/plugins/install.ts";
import { createPluginRecord, upsertPlugin } from "../src/lib/plugins/registry.ts";
import { parsePluginManifest } from "../src/lib/plugins/manifest.ts";

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

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

/* ---------------- 1. 内容指纹：只随内容变化 ---------------- */
const fileA = { path: "ui/detail.css", data: b64("背景: var(--card, #121212);") };
const fileB = { path: "plugin.json", data: b64('{"id":"com.demo.x","version":"1.0.0"}') };

const fp1 = await packageContentFingerprint([fileA, fileB]);
const fp2 = await packageContentFingerprint([fileB, fileA]); // 顺序不同
ok(fp1 === fp2, "指纹与文件顺序无关（同内容 → 同指纹）", `${fp1.slice(0, 12)} vs ${fp2.slice(0, 12)}`);

const fileA2 = { path: "ui/detail.css", data: b64("背景: var(--card, #252526);") }; // 内容变了
const fp3 = await packageContentFingerprint([fileA2, fileB]);
ok(fp1 !== fp3, "任一文件内容变化 → 指纹变化（能被识别为「需要刷新」）", `${fp1.slice(0, 12)} vs ${fp3.slice(0, 12)}`);

const fp4 = await packageContentFingerprint([fileA, fileB]); // 同内容再算一次
ok(fp1 === fp4, "同内容重复计算 → 指纹稳定（幂等，启动不会误刷新）");

// 路径改名也算变化（否则「文件搬了位置」检测不到）
const fileARenamed = { path: "ui/theme.css", data: fileA.data };
const fp5 = await packageContentFingerprint([fileARenamed, fileB]);
ok(fp1 !== fp5, "文件路径变化 → 指纹变化");

// 可执行位变化也算（backend 脚本的可执行标记影响运行）
const fileExec = { path: "backend/run.sh", data: b64("#!/bin/sh\n"), executable: true };
const fileNoExec = { path: "backend/run.sh", data: b64("#!/bin/sh\n"), executable: false };
ok(
  (await packageContentFingerprint([fileExec])) !== (await packageContentFingerprint([fileNoExec])),
  "可执行位变化 → 指纹变化"
);

/* ---------------- 2/3. 记录层：指纹保留 + 用户态不被重装覆盖 ---------------- */
const manifest = /** @type {any} */ (
  parsePluginManifest(
    JSON.stringify({
      id: "com.demo.x",
      name: "演示插件",
      version: "1.0.0",
      apiVersion: 1,
      permissions: ["store"],
      contributes: { detailView: { entry: "ui/a.html", closeBehavior: "minimize" } },
    })
  ).manifest
);

// 首次安装
const rec1 = createPluginRecord({
  manifest,
  dir: "",
  source: { kind: "builtin" },
  grants: ["store"],
});
rec1.builtinFingerprint = fp1;
const reg = { version: 1, plugins: [rec1] };

// 用户改了设置
rec1.enabled = false;
rec1.autoStart = "always";
rec1.closeBehavior = "exit";

// 模拟「内容变了 → 重装」：新指纹 fp3，走默认保留路径
const rec2 = createPluginRecord({
  manifest,
  dir: "",
  source: { kind: "builtin" },
  grants: ["store"],
});
rec2.builtinFingerprint = fp3;
const merged = upsertPlugin(reg, rec2, { preserveUserChoices: true });
ok(merged.builtinFingerprint === fp3, "重装写入新指纹（下次启动不再重复刷新）", String(merged.builtinFingerprint).slice(0, 12));
ok(merged.enabled === false, "重装保留用户「禁用」选择（不被插件发版改回）");
ok(merged.autoStart === "always", "重装保留用户「开机自启」选择");
ok(merged.closeBehavior === "exit", "重装保留用户「关闭界面时」选择");
ok(merged.grants.some((g) => g.permission === "store"), "重装后原有授权仍在");

// 普通升级（不带指纹字段）不应擦掉旧指纹
const rec3 = createPluginRecord({ manifest, dir: "", source: { kind: "builtin" } });
const merged2 = upsertPlugin(reg, rec3, { preserveUserChoices: true });
ok(
  merged2.builtinFingerprint === fp3,
  "升级未显式给指纹时保留旧值（不触发多余重装）",
  String(merged2.builtinFingerprint).slice(0, 12)
);

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
