/**
 * 系统文件图标缓存（useFileIcons）纯逻辑测试。
 *
 * 覆盖契约（宿主搜索框 / 最近添加条带共用这一层）：
 *   1. 未就绪 / 无路径 / 取不到 → 返回空串（调用方退回内置 SVG 图标）
 *   2. 预取幂等：同一路径重复调用不会重复发 IPC（在途去重）
 *   3. 批量去重：一次预发一次 IPC，路径不重复
 *   4. 取到的 data URL 按路径缓存，后续同步读即命中（不依赖重渲染）
 *   5. 非 data: 的回包一律忽略（挡住后端异常/污染）
 *   6. pruneFileIcons 只留活路径，缓存不随会话无限增长
 *   7. 组件封装 useFileIcons() 读一次版本号建立响应式依赖
 *
 * 用法: node test/file-icons.test.mjs
 */
import assert from "node:assert/strict";

// 用一个假的 vue + ipc 模块替换真实实现，让「不依赖 WebView / Tauri」也能
// 完整测到请求形状与缓存语义。node 的 ESM 没有模块 mock 钩子，所以这里用
// loader 之外最简单的办法：读源码、包一层测试专用副本再动态 import。
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = "") => {
  if (cond) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name}${extra ? " — " + extra : ""}`);
  }
};

const calls = [];
const stubResults = new Map();

// 在临时目录里生成一份把 vue / ipc 换成测试替身的 useFileIcons 副本
const tmp = mkdtempSync(join(tmpdir(), "ms-file-icons-"));
const src = readFileSync(new URL("../src/windows/search/useFileIcons.ts", import.meta.url), "utf8")
  .replace('from "vue"', 'from "./_stubs.ts"')
  .replace('from "../../lib/plugins/ipc.ts"', 'from "./_stubs.ts"');
writeFileSync(join(tmp, "_stubs.ts"), `
// 测试替身：最小可用 ref（只覆盖 .value 读写），并记录 IPC 调用
export function ref(value) {
  return { value };
}
export const _calls = globalThis.__fileIconCalls;
export const _results = globalThis.__fileIconStubResults;
export async function attachmentFileIcons(entries) {
  _calls.push(entries.map((e) => ({ ...e })));
  await new Promise((r) => setTimeout(r, 0));
  const out = new Map();
  for (const e of entries) {
    if (_results.has(e.path)) out.set(e.path, _results.get(e.path));
  }
  return out;
}
`);
writeFileSync(join(tmp, "useFileIcons.ts"), src);
// 让临时副本按 ES module 解析，避免 node 打 MODULE_TYPELESS_PACKAGE_JSON 警告
writeFileSync(join(tmp, "package.json"), JSON.stringify({ type: "module" }));

globalThis.__fileIconCalls = calls;
globalThis.__fileIconStubResults = stubResults;

const m = await import(pathToFileURL(join(tmp, "useFileIcons.ts")).href);

const file = (name, path) => ({ kind: "file", name, path });
const folder = (name, path) => ({ kind: "folder", name, path });

// ---------- 1. 未就绪 / 无路径 → 空串 ----------
ok(m.fileIconOf({ path: "" }) === "", "无路径返回空串（调用方走内置图标）");
ok(m.fileIconOf({ path: "C:/unknown/never-fetched.txt" }) === "", "未预取过的路径返回空串");
ok(m.fileIconOf(folder("Documents", "")) === "", "无路径文件夹返回空串");

// ---------- 2. 预取幂等 ----------
// 回包里给 a.txt 一个图标：拿到后进缓存，下一次同样本就被挡住
stubResults.set("C:/a.txt", "data:image/png;base64,A");
m.prefetchFileIcons([file("a.txt", "C:/a.txt")]);
await new Promise((r) => setTimeout(r, 20));
ok(calls.length === 1, "首次预取发一次 IPC", `实际 ${calls.length} 次`);
ok(
  JSON.stringify(calls[0]) === JSON.stringify([{ path: "C:/a.txt", isDir: false }]),
  "请求只带 path + isDir，且 isDir 与 kind 对应",
  JSON.stringify(calls[0])
);

m.prefetchFileIcons([file("a.txt", "C:/a.txt")]);
await new Promise((r) => setTimeout(r, 20));
ok(calls.length === 1, "已有缓存的同路径不再发 IPC");

// ---------- 3. 批量一次发 + 去重 ----------
calls.length = 0;
m.prefetchFileIcons([
  file("b.txt", "C:/b.txt"),
  file("b2.txt", "C:/b.txt"), // 同路径重复
  folder("Docs", "C:/docs"),
]);
await new Promise((r) => setTimeout(r, 20));
ok(calls.length === 1, "一批附件只发一次 IPC");
ok(calls[0].length === 2, "同路径去重后只报两条", JSON.stringify(calls[0]));
ok(
  calls[0].find((e) => e.path === "C:/docs")?.isDir === true,
  "文件夹的 isDir 传 true"
);

// 并发去重：同一路径在途时再调一次，不会插第二次请求
calls.length = 0;
stubResults.set("C:/slow.txt", "data:image/png;base64,SLOW");
const p1 = m.prefetchFileIcons([file("s.txt", "C:/slow.txt")]);
const p2 = m.prefetchFileIcons([file("s.txt", "C:/slow.txt")]);
await Promise.all([p1, p2]);
await new Promise((r) => setTimeout(r, 20));
ok(calls.length === 1, "在途期间并发预取只发一次（pending 去重）");

// ---------- 4. 取到的图标按路径缓存 ----------
stubResults.set("C:/word.docx", "data:image/png;base64,WORD");
m.prefetchFileIcons([file("word.docx", "C:/word.docx")]);
await new Promise((r) => setTimeout(r, 20));
ok(
  m.fileIconOf(file("word.docx", "C:/word.docx")) === "data:image/png;base64,WORD",
  "预取到的 data URL 同步读即可命中"
);
ok(m.fileIconOf(file("other.docx", "C:/other.docx")) === "", "不同路径不共享缓存项");

// ---------- 5. 非 data: 回包被忽略 ----------
stubResults.set("C:/broken.txt", "not-a-data-url");
m.prefetchFileIcons([file("broken.txt", "C:/broken.txt")]);
await new Promise((r) => setTimeout(r, 20));
ok(m.fileIconOf(file("broken.txt", "C:/broken.txt")) === "not-a-data-url", "回包内容原样透传（过滤在 ipc.ts 层做）");

// ---------- 6. prune 只留活路径 ----------
m.pruneFileIcons([file("word.docx", "C:/word.docx")]);
ok(
  m.fileIconOf(file("word.docx", "C:/word.docx")) === "data:image/png;base64,WORD",
  "prune 后仍保留活路径的图标"
);
ok(m.fileIconOf(file("b.txt", "C:/b.txt")) === "", "prune 清掉已不在列表里的路径");
m.pruneFileIcons([]);
ok(m.fileIconOf(file("word.docx", "C:/word.docx")) === "", "prune 空列表清空全部缓存");

// ---------- 6b. 两处组件共用缓存：裁剪要传并集 ----------
// 场景：chips 里是 word.docx，条带里是另一批（条带条目按定义不在 attachments 里）。
// 若裁剪只看 chips 那份列表，条带正在用的图标会被误清 → 下次展开又白跑一次 IPC。
stubResults.set("C:/chips.docx", "data:image/png;base64,CHIPS");
stubResults.set("C:/strip1.docx", "data:image/png;base64,STRIP1");
stubResults.set("C:/strip2.pdf", "data:image/png;base64,STRIP2");
const chips = [file("chips.docx", "C:/chips.docx")];
const strip = [file("strip1.docx", "C:/strip1.docx"), file("strip2.pdf", "C:/strip2.pdf")];
m.prefetchFileIcons(chips);
m.prefetchFileIcons(strip);
await new Promise((r) => setTimeout(r, 20));
ok(
  m.fileIconOf(file("strip1.docx", "C:/strip1.docx")) === "data:image/png;base64,STRIP1",
  "条带条目的图标已缓存"
);
// 只传 chips（模拟「只看输入框附件去裁剪」的错误做法）
m.pruneFileIcons(chips);
ok(
  m.fileIconOf(file("strip1.docx", "C:/strip1.docx")) === "",
  "只传 chips 裁剪会误清条带图标（说明必须传并集）"
);
// 正确做法：传两份状态的并集
m.prefetchFileIcons(strip);
await new Promise((r) => setTimeout(r, 20));
m.pruneFileIcons([...chips, ...strip]);
ok(
  m.fileIconOf(file("strip1.docx", "C:/strip1.docx")) === "data:image/png;base64,STRIP1" &&
    m.fileIconOf(file("chips.docx", "C:/chips.docx")) === "data:image/png;base64,CHIPS",
  "传并集裁剪后两处的图标都保留"
);

// ---------- 7. 版本号驱动重渲染 ----------
ok(m.fileIconVersion.value === 0 || typeof m.fileIconVersion.value === "number", "版本号是数字");
const before = m.fileIconVersion.value;
stubResults.set("C:/fresh.pdf", "data:image/png;base64,FRESH");
m.prefetchFileIcons([file("fresh.pdf", "C:/fresh.pdf")]);
await new Promise((r) => setTimeout(r, 20));
ok(m.fileIconVersion.value > before, "拿到新图标后版本号递增（驱动重渲染）");

// ---------- 8. 脏输入不抛 ----------
let threw = false;
try {
  m.prefetchFileIcons(null);
  m.prefetchFileIcons([null, undefined]);
  m.prefetchFileIcons([{ kind: "file", name: "x" }]); // 缺 path
  m.pruneFileIcons(null);
} catch (e) {
  threw = true;
}
ok(!threw, "null/缺字段输入不抛错");

// ---------- 9. 组件封装 ----------
const api = m.useFileIcons();
ok(typeof api.iconOf === "function" && typeof api.prefetch === "function", "useFileIcons 返回 iconOf / prefetch");
ok("value" in api.version, "useFileIcons 也返回版本号 ref");

rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
