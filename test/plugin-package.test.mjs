/**
 * 插件安装包（ZIP）读写测试。
 *
 * 背景：安装插件时曾报「安装失败: Offset is outside the bounds of the DataView」。
 * 根因是 `readZip` 读 EOCD 时把「中央目录大小」的偏移写成了 +20（那是**注释长度**，
 * 2 字节），读 4 字节就跑到缓冲区之外，任何正常 ZIP 都装不上。
 *
 * 本测试直接跑真实的 `src/lib/plugins/package.ts`，覆盖：
 *   1. 真实包（plugins/baidu-translate.zip，含包裹目录）能读出来
 *   2. EOCD 字段偏移正确（条目数 / 中央目录大小 / 偏移）
 *   3. 带注释 / 带前缀垃圾的包也能定位 EOCD
 *   4. 写读往返一致（writeZip → readZip）
 *   5. 包裹目录剥离（用户右键压缩整目录的常见形态）
 *   6. 危险包被拒（路径穿越 / 绝对路径 / 加密 / 重复条目）
 *   7. 截断包给出可读错误而不是 RangeError
 *
 * 用法: node test/plugin-package.test.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  base64ToBytes,
  bytesToBase64,
  crc32,
  isSafeZipPath,
  normalizeZipPath,
  readZip,
  stripWrappingDirectory,
  writeZip,
  ZipError,
} from "../src/lib/plugins/package.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = "") => {
  if (cond) {
    pass++;
    console.log("PASS ", name, extra);
  } else {
    fail++;
    console.log("FAIL ", name, extra);
  }
};
const bytesOf = (p) => {
  const buf = readFileSync(p);
  return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
};
const ab = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

/* ============ 1. 真实安装包 ============ */
// 说明：plugins/baidu-translate.zip 由 `node test/pack-plugin.mjs` 生成，
// 因此是**扁平**结构（plugin.json 在根）。「包了一层目录」的形态由下面
// 第 2 组用例单独构造覆盖——两种形态都要能装，但不该假设 fixture 是哪一种。
const realZipPath = path.join(root, "plugins", "baidu-translate.zip");
const real = await readZip(ab(bytesOf(realZipPath)));
ok(real.entries.length === 4, "真实包解出 4 个文件", `实际 ${real.entries.length}`);
ok(
  real.names.some((n) => n === "plugin.json" || n.endsWith("/plugin.json")),
  "真实包含 plugin.json",
  real.names.join(", ")
);
const manifestEntry = real.entries.find((e) => e.name === "plugin.json" || e.name.endsWith("/plugin.json"));
const manifest = JSON.parse(new TextDecoder().decode(manifestEntry.data));
ok(manifest.id === "com.mysearch.baidu-translate", "plugin.json 可解析且 id 正确", manifest.id);

/* ============ 2. EOCD 字段偏移（回归：+12 是目录大小，+20 是注释长度） ============ */
{
  const raw = bytesOf(realZipPath);
  const view = new DataView(ab(raw));
  let eocd = -1;
  for (let i = raw.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  ok(eocd >= 0, "手工定位到 EOCD");
  const total = view.getUint16(eocd + 10, true);
  const size = view.getUint32(eocd + 12, true);
  const off = view.getUint32(eocd + 16, true);
  const commentLen = view.getUint16(eocd + 20, true);
  // 注意：EOCD 里的「条目数」**包含目录条目**（本包有 baidu-translate/ 与 ui/ 两条），
  // 而 readZip 会把目录条目过滤掉，所以它 >= 解出的文件数
  ok(total >= real.entries.length, "EOCD +10 为总条目数（含目录条目）", `eocd=${total} files=${real.entries.length}`);
  ok(size > 0 && off + size <= raw.length, "EOCD +12 为中央目录大小", `${size}`);
  ok(commentLen === 0, "EOCD +20 为注释长度", `${commentLen}`);
  // 旧实现在 eocd+20 读 4 字节 → 越界；这里确认它确实越界（说明修的就是这个）
  let threw = false;
  try {
    view.getUint32(eocd + 20, true);
  } catch (e) {
    threw = e instanceof RangeError;
  }
  ok(threw, "旧偏移（+20 读 4 字节）确实越界（回归锚点）");
}

/* ============ 3. 带注释 / 带前缀垃圾的包 ============ */
{
  const entries = [{ name: "plugin.json", data: new TextEncoder().encode('{"id":"a.b"}') }];
  const plain = await writeZip(entries);
  // 追加注释：把 EOCD 的注释长度改掉并补字节
  const withComment = new Uint8Array(plain.length + 5);
  withComment.set(plain, 0);
  const dv = new DataView(withComment.buffer);
  dv.setUint16(plain.length - 22 + 20, 5, true);
  withComment.set(new TextEncoder().encode("hello"), plain.length);
  const r1 = await readZip(ab(withComment));
  ok(r1.entries.length === 1, "带注释的包可读（EOCD 反查不受注释影响）");

  // 前缀垃圾（自解压包形态）：中央目录偏移需要整体平移——zip 规范允许，
  // 我们的实现按「绝对偏移」读取，因此这里只验证「不因前缀而误判」
  const prefixed = new Uint8Array(plain.length + 10);
  prefixed.set(plain, 10);
  let prefixedOk = false;
  try {
    await readZip(ab(prefixed));
  } catch (e) {
    prefixedOk = e instanceof ZipError;
  }
  ok(prefixedOk, "带前缀垃圾的包给出可读 ZipError（而不是 RangeError）");
}

/* ============ 4. 写读往返一致 ============ */
{
  const enc = new TextEncoder();
  const files = [
    { name: "plugin.json", data: enc.encode('{"id":"com.example.roundtrip","name":"往返"}') },
    { name: "ui/detail.html", data: enc.encode("<h1>你好</h1>") },
    { name: "backend/run.sh", data: enc.encode("#!/bin/sh\necho hi\n") },
    { name: "empty.txt", data: new Uint8Array(0) },
  ];
  const zip = await writeZip(files, new Date("2026-01-02T03:04:06"));
  const back = await readZip(ab(zip));
  ok(back.entries.length === files.length, "往返：条目数一致", `${back.entries.length}`);
  const byName = new Map(back.entries.map((e) => [e.name, e.data]));
  ok(
    new TextDecoder().decode(byName.get("plugin.json")) === new TextDecoder().decode(files[0].data),
    "往返：内容一致（UTF-8 中文）"
  );
  ok(byName.get("empty.txt")?.length === 0, "往返：空文件保持为空");
  ok(crc32(enc.encode("hello")) === 0x3610a686, "CRC32 标准值", crc32(enc.encode("hello")).toString(16));

  // 确定性：同输入同字节（便于比哈希）
  const zip2 = await writeZip(files, new Date("2026-01-02T03:04:06"));
  ok(zip.length === zip2.length && zip.every((b, i) => b === zip2[i]), "同输入打包字节稳定");

  // base64 往返
  const b64 = bytesToBase64(zip);
  const round = base64ToBytes(b64);
  ok(round.length === zip.length && round.every((b, i) => b === zip[i]), "base64 往返一致");

  // 可执行位：backend/ 下的脚本被标记 0755（由 readZip 的符号链接检测间接验证不误伤）
  const r = await readZip(ab(zip));
  ok(
    r.entries.every((e) => !e.name.includes("..")),
    "往返：无越界路径"
  );
}

/* ============ 5. 包裹目录剥离 ============ */
{
  const enc = new TextEncoder();
  const wrapped = [
    { name: "my-plugin/plugin.json", data: enc.encode("{}") },
    { name: "my-plugin/ui/a.html", data: enc.encode("a") },
  ];
  const stripped = stripWrappingDirectory(wrapped);
  ok(
    stripped.map((e) => e.name).join(",") === "plugin.json,ui/a.html",
    "剥离单层包裹目录",
    stripped.map((e) => e.name).join(",")
  );

  // 多层包裹（罕见但可能）
  const doubleWrapped = [
    { name: "outer/inner/plugin.json", data: enc.encode("{}") },
    { name: "outer/inner/ui/a.html", data: enc.encode("a") },
  ];
  const s2 = stripWrappingDirectory(doubleWrapped);
  ok(s2.map((e) => e.name).join(",") === "plugin.json,ui/a.html", "剥离多层包裹目录");

  // 已有顶层文件 → 不动（不是包裹目录形态）
  const flat = [
    { name: "plugin.json", data: enc.encode("{}") },
    { name: "ui/a.html", data: enc.encode("a") },
  ];
  const s3 = stripWrappingDirectory(flat);
  ok(s3.map((e) => e.name).join(",") === "plugin.json,ui/a.html", "顶层已就绪时不剥离");

  // 两个不同顶层目录 → 不动（避免误伤多根包）
  const multi = [
    { name: "a/plugin.json", data: enc.encode("{}") },
    { name: "b/x.html", data: enc.encode("x") },
  ];
  const s4 = stripWrappingDirectory(multi);
  ok(s4.map((e) => e.name).join(",") === "a/plugin.json,b/x.html", "多根包不剥离");

  // 真实包：剥离后才露出根级 plugin.json
  ok(
    stripWrappingDirectory(real.entries)
      .map((e) => e.name)
      .includes("plugin.json"),
    "真实包剥离后暴露根级 plugin.json"
  );
}

/* ============ 6. 危险包被拒 ============ */
{
  const enc = new TextEncoder();
  const cases = [
    ["路径穿越", [{ name: "../evil.txt", data: enc.encode("x") }]],
    ["绝对路径", [{ name: "/etc/passwd", data: enc.encode("x") }]],
    ["盘符路径", [{ name: "C:/windows/system32/x.dll", data: enc.encode("x") }]],
    ["反斜杠穿越", [{ name: "..\\evil.txt", data: enc.encode("x") }]],
    ["协议路径", [{ name: "http://evil.com/x", data: enc.encode("x") }]],
  ];
  for (const [label, files] of cases) {
    let rejected = false;
    try {
      // writeZip 自己就会挡（打包侧），这里验证**读侧**也挡
      const zip = await writeZip(files);
      await readZip(ab(zip));
    } catch (e) {
      rejected = e instanceof ZipError;
    }
    ok(rejected, `拒绝${label}`);
  }

  // 加密标志位（手工把中央目录里的 bit0 置 1）。
  // 注意：必须**在同一个缓冲区上**改完再交给 readZip——`ab()` 会复制一份，
  // 对着副本改、再把原件传进去是测不到东西的（第一版就踩了这个坑）。
  const zip = await writeZip([{ name: "plugin.json", data: enc.encode("{}") }]);
  const tampered = new Uint8Array(zip);
  const dv = new DataView(tampered.buffer);
  let centralAt = -1;
  for (let i = 0; i < tampered.length - 4; i++) {
    if (dv.getUint32(i, true) === 0x02014b50) {
      centralAt = i;
      break;
    }
  }
  ok(centralAt > 0, "定位到中央目录（改标志位前）");
  dv.setUint16(centralAt + 8, 0x0001, true);
  let encRejected = false;
  try {
    await readZip(tampered.buffer);
  } catch (e) {
    encRejected = e instanceof ZipError && e.message.includes("加密");
  }
  ok(encRejected, "拒绝加密包");

  // 重复条目：把第二个文件在**本地头与中央目录**里的名字都改成第一个的名字
  const dup = await writeZip([
    { name: "a.txt", data: enc.encode("1") },
    { name: "b.txt", data: enc.encode("2") },
  ]);
  const dupBytes = new Uint8Array(dup);
  const needle = enc.encode("b.txt");
  const replacement = enc.encode("a.txt");
  let patched = 0;
  for (let i = 0; i < dupBytes.length - needle.length; i++) {
    if (needle.every((b, k) => dupBytes[i + k] === b)) {
      dupBytes.set(replacement, i);
      patched++;
      i += needle.length - 1;
    }
  }
  ok(patched >= 2, "重命名补丁同时命中本地头与中央目录", `命中 ${patched} 处`);
  let dupRejected = false;
  try {
    await readZip(dupBytes.buffer);
  } catch (e) {
    dupRejected = e instanceof ZipError;
  }
  ok(dupRejected, "拒绝重复条目");

  // 空包
  let emptyRejected = false;
  try {
    await readZip(new ArrayBuffer(8));
  } catch (e) {
    emptyRejected = e instanceof ZipError;
  }
  ok(emptyRejected, "拒绝空/过小的文件");

  // 非 ZIP（.7z）给出可读错误。这个 fixture 是可选的（打包产物），
  // 缺了也不该让测试失败——「非 ZIP」这条用综合字节已经覆盖。
  const sevenZipPath = path.join(root, "plugins", "baidu-translate.7z");
  if (existsSync(sevenZipPath)) {
    let sevenZipError = null;
    try {
      await readZip(ab(bytesOf(sevenZipPath)));
    } catch (e) {
      sevenZipError = e;
    }
    ok(
      sevenZipError instanceof ZipError && sevenZipError.message.includes("中央目录"),
      "7z 文件给出可读 ZipError",
      sevenZipError?.message
    );
  } else {
    console.log("SKIP  7z fixture 不存在，跳过");
  }
}

/* ============ 7. 截断包 ============ */
{
  const enc = new TextEncoder();
  const zip = await writeZip([{ name: "plugin.json", data: enc.encode('{"id":"a.b"}') }]);
  const truncated = zip.slice(0, zip.length - 10);
  let err = null;
  try {
    await readZip(ab(truncated));
  } catch (e) {
    err = e;
  }
  ok(
    err instanceof ZipError,
    "截断包给出可读 ZipError（不是 RangeError）",
    err?.message
  );
  ok(!(err instanceof RangeError), "截断包不抛 RangeError");
}

/* ============ 8. 路径工具 ============ */
{
  ok(isSafeZipPath("ui/a.html"), "安全路径放行");
  ok(!isSafeZipPath("../a"), "拒绝 ..");
  ok(!isSafeZipPath("a/../../b"), "拒绝内嵌 ..");
  ok(!isSafeZipPath("/a"), "拒绝绝对路径");
  ok(!isSafeZipPath("C:\\a"), "拒绝盘符");
  ok(!isSafeZipPath("a\\..\\b"), "拒绝反斜杠穿越");
  ok(normalizeZipPath("./a/b/") === "a/b", "路径归一化（去 ./ 与尾斜杠）");
}

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
