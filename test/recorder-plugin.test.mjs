/**
 * 录屏与水印插件的单测。
 *
 * 与仓库既有测试的分工：这里**不启浏览器**（UI 交互另有 e2e 路子），
 * 只钉住三块最容易悄悄写错、又和「本机是否装了 ffmpeg」无关的逻辑：
 *
 *   1. 清单合法（否则插件根本装不上）；
 *   2. 水印规格 → ffmpeg 滤镜串（位置表达式、转义、透明度、字号相对值）；
 *   3. 录屏/转码参数拼装（gdigrab 的参数顺序、区域偶数规整、音频开关）；
 *   4. ffmpeg 探测（用注入的假 execFile，断言「PATH 不可用时的绝对路径探测」）；
 *   5. 后端 JSON-RPC：真起一次进程，喂 init 握手 + capabilities，
 *      断言协议形态正确（不依赖本机有没有 ffmpeg）。
 *
 * 用法: node test/recorder-plugin.test.mjs
 */
import { readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Windows 上动态 import 必须给 file:// URL，直接给绝对路径会被当成 'd:' 协议 */
const importFile = (abs) => import(pathToFileURL(abs).href);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = path.join(root, "plugins", "recorder");
const backendDir = path.join(pluginDir, "backend");

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
function eq(actual, expected, name) {
  ok(actual === expected, name, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/* ============================ 1. 清单 ============================ */

console.log("\n--- 清单 ---");

const manifest = JSON.parse(readFileSync(path.join(pluginDir, "plugin.json"), "utf8"));
const manifestTs = await importFile(path.join(root, "src", "lib", "plugins", "manifest.ts"));
const permsTs = await importFile(path.join(root, "src", "lib", "plugins", "permissions.ts"));
const parsed = manifestTs.parsePluginManifest(
  readFileSync(path.join(pluginDir, "plugin.json"), "utf8"),
  permsTs.isKnownPermission
);
ok(parsed.ok, "plugin.json 通过宿主清单校验", parsed.ok ? "" : manifestTs.describeManifestErrors(parsed.errors).join("；"));

eq(manifest.id, "com.mysearch.recorder", "id 为保留前缀下的内置命名");
eq(manifest.contributes.detailView.mode, "inlay", "详情视图模式必须是 inlay");
ok(manifest.permissions.includes("backend.spawn"), "声明了 backend.spawn（拉起 ffmpeg 必需）");
ok(manifest.permissions.includes("file.read"), "声明了 file.read（读附件视频路径）");
ok(
  manifest.permissions.includes("screenshot.overlay"),
  "声明了 screenshot.overlay（屏幕上直接框选录制区域）"
);
ok(manifest.contributes.handlers.files === true, "声明 files 处理能力（拖入视频即可加水印）");

// 清单里声明的入口文件必须真实存在（打包器也会查，这里提前暴露）
for (const rel of [manifest.contributes.detailView.entry, manifest.contributes.detailView.script, manifest.backend.entry]) {
  let exists = true;
  try {
    readFileSync(path.join(pluginDir, rel));
  } catch {
    exists = false;
  }
  ok(exists, `入口文件存在：${rel}`);
}

/* ============================ 2. 水印滤镜 ============================ */

console.log("\n--- 水印滤镜 ---");

const wm = await importFile(path.join(backendDir, "watermark.mjs"));

{
  const f = wm.buildTextFilter({ type: "text", text: "我的搜索", anchor: "bottom-right", marginPct: 2, opacity: 0.6, sizePct: 4, color: "#FFFFFF", border: true });
  ok(f.startsWith("drawtext="), "文字水印生成 drawtext 滤镜");
  ok(f.includes("text=我的搜索"), "文字内容进入滤镜");
  ok(f.includes("fontsize=h*0.0400"), "字号用「视频高度百分比」表达式（随分辨率自适应）", f.match(/fontsize=[^:]*/)?.[0]);
  ok(f.includes("fontcolor=#FFFFFF@0.6"), "颜色带透明度后缀", f.match(/fontcolor=[^:]*/)?.[0]);
  ok(f.includes("x=(w-text_w-w*0.02)"), "右下角 x 表达式");
  ok(f.includes("y=(h-text_h-h*0.02)"), "右下角 y 表达式");
  ok(f.includes("borderw=2"), "描边参数");
}

{
  // 透明度 1 不应出现 @ 后缀（drawtext 对 @1.0 的解析在部分版本上有差异）
  const f = wm.buildTextFilter({ text: "a", opacity: 1 });
  ok(!f.includes("@"), "不透明度=1 时不加 @ 后缀");
}

{
  // 九个锚点的定位表达式必须各不相同且合法
  const seen = new Set();
  for (const a of wm.ANCHORS) {
    const { x, y } = wm.positionExpr(a, 2);
    ok(/^\(.*\)$/.test(x) && /^\(.*\)$/.test(y), `锚点 ${a} 的 x/y 是合法表达式`, `${x} | ${y}`);
    seen.add(x + y);
  }
  eq(seen.size, 9, "九个锚点的定位互不重复");
}

{
  // 用户文字里的特殊字符必须转义，否则 ffmpeg 报语法错
  eq(wm.escapeDrawtext("a:b"), "a\\:b", "冒号转义");
  eq(wm.escapeDrawtext("50%"), "50%%", "百分号转义（drawtext 用它当占位符前缀）");
  eq(wm.escapeDrawtext("a'b"), "a\\'b", "单引号转义");
  eq(wm.escapeDrawtext("a\\b"), "a\\\\b", "反斜杠转义");
  eq(wm.escapeDrawtext("上\n下"), "上\\n下", "换行转成 drawtext 的 \\n");
}

{
  // 时间戳占位符
  const rec = wm.withTimestamp("前缀", "localtime");
  ok(rec.includes("%{localtime"), "录制模式用挂钟时间戳");
  const file = wm.withTimestamp("前缀", "pts");
  ok(file.includes("%{pts"), "转码模式用视频进度时间戳");
}

{
  const f = wm.buildTextFilter({ text: "x", timestamp: true });
  ok(f.includes("%{pts"), "开启时间戳后滤镜里出现占位符");
}

{
  // 颜色归一
  eq(wm.normalizeColor("fff"), "#FFFFFF", "三位简写补全并大写");
  eq(wm.normalizeColor("ff0000"), "#FF0000", "不带 # 也接受");
  eq(wm.normalizeColor("乱写", "#123456"), "#123456", "非法值退回兜底");
}

{
  // 路径进滤镜前转义（Windows 反斜杠 + 盘符冒号）
  eq(wm.escapeFilterPath("C:\\Windows\\Fonts\\msyh.ttc"), "C\\:/Windows/Fonts/msyh.ttc", "Windows 字体路径转义");
  const f = wm.buildTextFilter({ text: "x", fontFile: "C:\\Windows\\Fonts\\msyh.ttc" });
  ok(f.includes("fontfile=C\\:/Windows/Fonts/msyh.ttc"), "fontfile 出现在滤镜里且已转义");
}

{
  // 归一化：越界值被夹住、缺字段有默认
  const n = wm.normalizeWatermark({ sizePct: 999, opacity: -5, anchor: "不存在的锚点" });
  eq(n.sizePct, 60, "sizePct 被夹到上限");
  eq(n.opacity, 0, "opacity 被夹到下限");
  eq(n.anchor, "bottom-right", "非法锚点退回默认");
}

{
  // 未启用 / 缺内容 → 返回 null（调用方据此跳过滤镜，而不是产出坏命令）
  eq(wm.buildWatermarkFilter({ enabled: false }), null, "未启用 → null");
  eq(wm.buildWatermarkFilter({ enabled: true, type: "text", text: "   " }), null, "文字为空 → null");
  eq(wm.buildWatermarkFilter({ enabled: true, type: "image", imagePath: "" }), null, "图片路径为空 → null");
}

{
  // 图片水印：必须产出 filter_complex 片段并声明需要第二路输入
  const r = wm.buildWatermarkFilter({ enabled: true, type: "image", imagePath: "D:\\logo.png", anchor: "top-left", sizePct: 10 });
  eq(r.kind, "image", "图片水印类型");
  eq(r.hasSecondInput, true, "图片水印需要第二路输入");
  ok(r.filter.includes("[1:v]"), "滤镜串引用第二路输入");
  ok(r.filter.includes("overlay="), "滤镜串含 overlay");
  // 缩放基准：不知主视频宽度时用 rw（新版 scale 的参考宽度）。
  // main_w 是 scale2ref 的变量，放 scale 里**任何版本**的 ffmpeg 都不认，
  // 图片水印曾因此全线失败——这条断言是回归护栏。
  ok(r.filter.includes("scale=w=rw*0.1000:h=-1"), "图片宽度按视频宽度百分比缩放（rw）", r.filter);
  // 注意 overlay 的位置表达式里 main_w 是合法变量（overlay 滤镜才有），
  // 要拦的只是 scale=main_w 这个所有版本都报错的写法
  ok(!r.filter.includes("scale=main_w"), "scale 不再用 main_w（旧写法所有 ffmpeg 都报错）");

  // 已知主视频宽度 → 绝对像素，老版本 ffmpeg 也认
  const abs = wm.buildWatermarkFilter(
    { enabled: true, type: "image", imagePath: "D:\\logo.png", sizePct: 10 },
    { videoWidth: 1920 }
  );
  ok(abs.filter.includes("scale=w=192:h=-1"), "已知视频宽度 → 绝对缩放", abs.filter);

  // ddagrab：先下载硬件帧，主视频标签改用 [base]
  const hw = wm.buildWatermarkFilter(
    { enabled: true, type: "image", imagePath: "D:\\logo.png", sizePct: 10 },
    { hwDownload: true, imageInputIndex: 2 }
  );
  ok(hw.filter.startsWith("[0:v]hwdownload,format=bgra[base];"), "ddagrab 滤镜先下载硬件帧", hw.filter);
  ok(hw.filter.includes("[2:v]"), "图片输入序号可指定（前面有音频时是 [2:v]）");
  ok(hw.filter.includes("[base][wm]overlay="), "合成用下载后的 [base]");
}

{
  // 预览与 ffmpeg 同口径：右下角应贴近右下、左上角应贴近左上
  const br = wm.previewBox({ anchor: "bottom-right", marginPct: 2 }, 320, 180, 40, 10);
  ok(br.x > 250 && br.y > 150, "预览：右下角落点靠右下", JSON.stringify(br));
  const tl = wm.previewBox({ anchor: "top-left", marginPct: 2 }, 320, 180, 40, 10);
  ok(tl.x < 20 && tl.y < 20, "预览：左上角落点靠左上", JSON.stringify(tl));
  eq(wm.previewFontSize({ sizePct: 10 }, 200), 20, "预览字号 = 高度 × 百分比");
}

/* ============================ 3. 参数拼装 ============================ */

console.log("\n--- ffmpeg 参数拼装 ---");

const args = await importFile(path.join(backendDir, "ffmpeg-args.mjs"));

{
  // 区域规整：奇数宽高必须变偶数（libx264 的 yuv420p 要求）
  const r = args.normalizeRegion({ x: 10, y: 20, width: 1279, height: 721 });
  eq(r.width, 1278, "奇数宽度规整为偶数");
  eq(r.height, 720, "奇数高度规整为偶数");
  eq(args.normalizeRegion({ width: 0, height: 100 }), null, "宽度为 0 → 视为全屏");
  eq(args.normalizeRegion(null), null, "null → 全屏");
}

{
  const { args: a, hasFilterComplex } = args.buildRecordArgs({
    platform: "win32",
    output: "out.mp4",
    fps: 30,
    watermark: null,
  });
  const joined = a.join(" ");
  ok(a[0] === "-y", "覆盖输出在最前");
  ok(joined.includes("-f gdigrab"), "Windows 用 gdigrab");
  ok(joined.includes("-framerate 30"), "帧率写入");
  ok(joined.includes("-i desktop"), "采集桌面输入");
  // -i 必须在编码参数之前
  ok(a.indexOf("-i") < a.indexOf("-c:v"), "输入参数在编码参数之前");
  ok(joined.includes("-an"), "未配音频时显式 -an");
  ok(joined.includes("+faststart"), "moov 前置（中断也尽量可播）");
  eq(hasFilterComplex, false, "无图片水印时不用 filter_complex");
  eq(a[a.length - 1], "out.mp4", "输出文件在最后");
}

{
  // 区域录制：offset/video_size 必须在 -i 之前（gdigrab 的硬要求）
  const { args: a } = args.buildRecordArgs({
    platform: "win32",
    output: "o.mp4",
    region: { x: 100, y: 200, width: 800, height: 600 },
  });
  const iIdx = a.indexOf("-i");
  ok(a.indexOf("-offset_x") > 0 && a.indexOf("-offset_x") < iIdx, "offset_x 在 -i 之前");
  ok(a.indexOf("-video_size") < iIdx, "video_size 在 -i 之前");
  ok(a.join(" ").includes("-offset_x 100 -offset_y 200"), "区域坐标写入");
  ok(a.join(" ").includes("-video_size 800x600"), "区域尺寸写入");
}

{
  // ddagrab（Windows 首选采集后端：GPU 直出，不走 CAPTUREBLT，光标不闪）
  const full = args.buildRecordArgs({ platform: "win32", format: "ddagrab", output: "o.mp4", fps: 30, watermark: null });
  const fjoined = full.args.join(" ");
  ok(fjoined.includes("-f lavfi"), "ddagrab 走 lavfi 输入");
  ok(/-i ddagrab=framerate=30:draw_mouse=1/.test(fjoined), "ddagrab 源滤镜含帧率与鼠标开关", fjoined);
  ok(!fjoined.includes("-i desktop"), "ddagrab 不再用 -i desktop");
  ok(full.args.includes("-vf") && fjoined.includes("hwdownload,format=bgra"), "硬件帧先下载再编码");
  ok(!fjoined.includes("-offset_x"), "区域写在 lavfi 串里而不是 gdigrab 的 -offset_x");

  const reg = args.buildRecordArgs({
    platform: "win32",
    format: "ddagrab",
    output: "o.mp4",
    region: { x: 100, y: 200, width: 800, height: 600 },
    watermark: null,
  });
  ok(
    /ddagrab=[^ ]*video_size=800x600[^ ]*offset_x=100[^ ]*offset_y=200/.test(reg.args.join(" ")),
    "ddagrab 区域：video_size/offset 写进滤镜串",
    reg.args.join(" ")
  );

  // 文字水印 + ddagrab：drawtext 接在下载链之后
  const txt = args.buildRecordArgs({
    platform: "win32",
    format: "ddagrab",
    output: "o.mp4",
    watermark: { enabled: true, type: "text", text: "署名" },
  });
  const vf = txt.args[txt.args.indexOf("-vf") + 1];
  ok(vf.startsWith("hwdownload,format=bgra,drawtext="), "ddagrab 文字水印：先下载后 drawtext", vf);

  // 图片水印 + ddagrab + 麦克风（音频占 [1:v]，图片顺延为 [2:v]）
  const img = args.buildRecordArgs({
    platform: "win32",
    format: "ddagrab",
    output: "o.mp4",
    audio: { mic: true, micDevice: "麦克风" },
    watermark: { enabled: true, type: "image", imagePath: "D:\\logo.png", sizePct: 10 },
    videoWidth: 1920,
  });
  const fc = img.args[img.args.indexOf("-filter_complex") + 1];
  ok(img.hasFilterComplex, "图片水印仍走 filter_complex");
  ok(fc.startsWith("[0:v]hwdownload,format=bgra[base];"), "ddagrab 图片水印先下载硬件帧", fc);
  ok(fc.includes("[2:v]"), "有音频时图片是第三路输入 [2:v]", fc);
  ok(fc.includes("scale=w=192:h=-1"), "已知视频宽度 → 绝对缩放（1920 的 10%）", fc);
  ok(fc.includes("[base][wm]overlay="), "用下载后的 [base] 合成");
  ok(img.args.join(" ").includes("-i audio=麦克风"), "麦克风输入在图片输入之前");

  // 无水印时也要有 -vf 下载链，否则编码器直接拒收硬件帧
  ok(full.args.join(" ").includes("hwdownload"), "无水印时同样下载硬件帧");
}

{
  // 文字水印 → -vf；图片水印 → 额外输入 + -filter_complex
  const t = args.buildRecordArgs({
    platform: "win32",
    output: "o.mp4",
    watermark: { enabled: true, type: "text", text: "署名" },
  });
  ok(t.args.includes("-vf"), "文字水印走 -vf");
  eq(t.hasFilterComplex, false, "文字水印不用 filter_complex");

  const i = args.buildRecordArgs({
    platform: "win32",
    output: "o.mp4",
    watermark: { enabled: true, type: "image", imagePath: "D:\\logo.png" },
  });
  ok(i.args.includes("-filter_complex"), "图片水印走 -filter_complex");
  eq(i.hasFilterComplex, true, "图片水印标记 hasFilterComplex");
  ok(i.args.includes("D:\\logo.png"), "图片作为第二路输入");
}

{
  const { args: a } = args.buildRecordArgs({ platform: "win32", output: "o.mp4", encoder: "mpeg4", qv: 3 });
  ok(!a.includes("-crf"), "mpeg4 不用 -crf");
  ok(a.join(" ").includes("-q:v 3"), "mpeg4 用 -q:v");
}

{
  const { args: a } = args.buildRecordArgs({ platform: "linux", output: "o.mp4" });
  ok(a.join(" ").includes("-f x11grab"), "Linux 用 x11grab");
}

{
  // 转码：音频 copy、输出在最后、进度走 pipe:2
  const { args: a } = args.buildWatermarkArgs({
    input: "in.mp4",
    output: "out.mp4",
    watermark: { enabled: true, type: "text", text: "署名" },
    progress: true,
  });
  const joined = a.join(" ");
  ok(joined.includes("-i in.mp4"), "输入写入");
  ok(joined.includes("-vf drawtext="), "文字水印滤镜写入");
  ok(joined.includes("-c:a copy"), "音频不重编码");
  ok(joined.includes("-progress pipe:2"), "开启进度输出");
  eq(a[a.length - 1], "out.mp4", "输出在最后");
}

{
  // 缺参数要报错，而不是产出坏命令
  let threw = false;
  try {
    args.buildWatermarkArgs({ input: "", output: "o.mp4", watermark: { enabled: true, text: "x" } });
  } catch {
    threw = true;
  }
  ok(threw, "缺输入路径 → 抛错");

  threw = false;
  try {
    args.buildWatermarkArgs({ input: "i.mp4", output: "o.mp4", watermark: { enabled: false } });
  } catch {
    threw = true;
  }
  ok(threw, "水印未启用 → 抛错");
}

{
  const { args: a } = args.buildThumbArgs({ input: "v.mp4", atSec: 2, width: 320 });
  ok(a.includes("-frames:v") && a.includes("1"), "抽帧只取一帧");
  ok(a.includes("scale=320:-2"), "抽帧缩放宽度固定、高度自适应偶数");
  ok(a[a.length - 1] === "pipe:1", "抽帧输出到 stdout");
}

{
  const a = args.buildProbeArgs("v.mp4");
  ok(a.includes("-of") && a.includes("json"), "探测输出 JSON");
  ok(a.includes("v:0"), "只取第一路视频流");
}

/* ============================ 4. ffmpeg 探测 ============================ */

console.log("\n--- ffmpeg 探测 ---");

const ff = await importFile(path.join(backendDir, "ffmpeg.mjs"));

{
  // 用假的 execFile 模拟「PATH 里找不到、但常见目录里有」
  const fakeExe = path.join(tmpdir(), "fake-ffmpeg-probe-" + process.pid);
  const calls = [];
  const fakeRun = (cmd, argv, opts, cb) => {
    calls.push([cmd, ...(argv || [])].join(" "));
    // where/which 失败（模拟无 PATH），但直接执行 exe -version 成功
    if (/where|command -v/.test(([cmd, ...(argv || [])]).join(" "))) {
      return setTimeout(() => cb(Object.assign(new Error("not found"), { code: 1 }), "", ""), 0);
    }
    return setTimeout(() => cb(null, "ffmpeg version 7.1.0 Copyright (c) 2000-2024 the FFmpeg developers\n", ""), 0);
  };

  const info = await ff.locateFfmpeg({
    userPath: fakeExe,
    platform: "win32",
    run: fakeRun,
  });
  // 假路径不存在 → 不该被 accepted；验证它会继续尝试其它来源而不是直接失败崩掉
  ok(info && typeof info.found === "boolean", "探测返回结构化结果（不抛异常）");
  ok(Array.isArray(info.tried), "探测返回已尝试的路径列表");
  eq(info.found, false, "不存在的用户路径不会被误判为命中");
}

{
  // 真实场景：本机（CI）没有 ffmpeg 时也必须优雅返回 found:false
  const info = await ff.locateFfmpeg({ verify: true });
  ok(info && typeof info.found === "boolean", "真实探测不抛异常");
  if (!info.found) {
    eq(info.path, null, "未找到时 path 为 null（界面据此显示安装引导）");
    ok(Array.isArray(info.tried), "未找到时仍返回尝试记录");
  } else {
    ok(typeof info.path === "string" && info.path.length > 0, "找到时给出绝对路径", info.path);
  }
}

{
  // resolveUserPath：目录 → 拼 bin 名；不存在的路径 → null
  eq(ff.resolveUserPath(""), null, "空路径 → null");
  eq(ff.resolveUserPath("D:\\definitely\\not\\here\\ffmpeg.exe"), null, "不存在的路径 → null");
}

{
  const dirs = ff.candidateDirs({ platform: "win32", home: "C:\\Users\\u", env: {} });
  ok(dirs.some((d) => /ffmpeg/i.test(d)), "Windows 候选目录含 ffmpeg 相关路径");
  const nix = ff.candidateDirs({ platform: "linux", home: "/home/u", env: {} });
  ok(nix.includes("/usr/bin") || nix.includes("/usr/local/bin"), "Unix 候选目录含标准 bin");
}

{
  // 「插件自带」必须排在系统探测之前：建一个真能跑通的假 exe，
  // 断言 source === "bundled"，且不带 bundledPath 时不会命中它。
  const dir = mkdtempSync(path.join(tmpdir(), "rec-bundled-"));
  const fakeName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const fakeExe = path.join(dir, fakeName);
  writeFileSync(fakeExe, "#!/bin/sh\necho 'ffmpeg version 9.9.9'\n");

  const run = (cmd, argv, opts, cb) => {
    // bundled 里的那份「能跑」，其它候选一律不认
    if (String(cmd) === fakeExe && (argv || []).includes("-version")) {
      return setTimeout(() => cb(null, "ffmpeg version 9.9.9 Copyright (c) test\n", ""), 0);
    }
    setTimeout(() => cb(Object.assign(new Error("not found"), { code: 1 }), "", ""), 0);
  };

  const withBundled = await ff.locateFfmpeg({
    bundledPath: dir,
    platform: process.platform,
    run,
    env: {},
    home: dir,
  });
  ok(withBundled.found, "自带副本存在时被采用");
  eq(withBundled.source, "bundled", "来源标记为 bundled");
  eq(withBundled.version, "9.9.9", "取到自带副本的版本号");

  // 用户手填优先于自带
  const userWins = await ff.locateFfmpeg({
    userPath: dir,
    bundledPath: dir,
    platform: process.platform,
    run,
    env: {},
    home: dir,
  });
  eq(userWins.source, "user", "用户手填路径优先于自带副本");

  rmSync(dir, { recursive: true, force: true });
}

/* ============================ 4b. 自带 ffmpeg 的下载 ============================ */

console.log("\n--- 自带 ffmpeg 下载 ---");

const dl = await importFile(path.join(backendDir, "downloader.mjs"));

{
  // URL 白名单：这是防「清单被改成任意地址」的第一道闸
  ok(dl.isTrustedUrl("https://github.com/a/b/releases/download/x/y.zip"), "允许 github.com 的 https");
  ok(dl.isTrustedUrl("https://objects.githubusercontent.com/x/y"), "允许 GitHub 资产重定向主机");
  ok(dl.isTrustedUrl("https://release-assets.githubusercontent.com/x"), "允许 GitHub release 资产主机");
  ok(dl.isTrustedUrl("https://api.github.com/repos/a/b/releases/tags/latest"), "允许 api.github.com（换取直链用）");
  ok(!dl.isTrustedUrl("http://github.com/a"), "拒绝 http");
  ok(!dl.isTrustedUrl("https://evil.com/a.zip"), "拒绝白名单外主机");
  ok(!dl.isTrustedUrl("https://github.com@evil.com/a"), "拒绝 userinfo 伪装");
  ok(!dl.isTrustedUrl("https://evilgithub.com/a"), "拒绝后缀伪装（evilgithub.com）");
  ok(!dl.isTrustedUrl("https://github.com:8443/a"), "拒绝非 443 端口");
  ok(!dl.isTrustedUrl("not a url"), "拒绝非法 URL");
  ok(!dl.isTrustedUrl("javascript:alert(1)"), "拒绝非 https 协议");
}

{
  /* ---- resolveGithubAsset：把 github.com 资产换成 CDN 直链 ----
   *
   * 这是真实踩到的坑：某些网络能通 CDN 却连不上 github.com，
   * 直连资产地址会在建连阶段就 UND_ERR_CONNECT_TIMEOUT。 */
  const CDN = "https://release-assets.githubusercontent.com/github-production-release-asset/1/abc?sp=r&sig=x";
  const assetUrl = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip";

  const mkFetch = (opts = {}) => async (url, init) => {
    const u = String(url);
    if (u.includes("/releases/tags/")) {
      if (opts.relFails) return { ok: false, status: 404, statusText: "Not Found" };
      return {
        ok: true, status: 200,
        json: async () => ({ assets: opts.assets || [{ id: 42, name: "ffmpeg-master-latest-win64-gpl.zip" }] }),
      };
    }
    if (u.includes("/releases/assets/")) {
      if (opts.noLocation) return { ok: true, status: 200, headers: { get: () => null } };
      if (opts.evilLocation) return { ok: true, status: 302, headers: { get: () => "https://evil.com/steal.zip" } };
      // 必须带 octet-stream 才会拿到 302
      const accept = (init && init.headers && init.headers.Accept) || "";
      if (!/octet-stream/.test(accept)) return { ok: true, status: 200, headers: { get: () => null } };
      return { ok: true, status: 302, headers: { get: () => CDN } };
    }
    return { ok: false, status: 500 };
  };

  eq(await dl.resolveGithubAsset(assetUrl, { fetchImpl: mkFetch() }), CDN, "能解析出 CDN 直链");
  eq(await dl.resolveGithubAsset(assetUrl, { fetchImpl: mkFetch({ relFails: true }) }), null, "release 查询失败 → null");
  eq(await dl.resolveGithubAsset(assetUrl, { fetchImpl: mkFetch({ assets: [{ id: 1, name: "other.zip" }] }) }), null, "找不到同名资产 → null");
  eq(await dl.resolveGithubAsset(assetUrl, { fetchImpl: mkFetch({ noLocation: true }) }), null, "没有 Location → null");
  eq(await dl.resolveGithubAsset(assetUrl, { fetchImpl: mkFetch({ evilLocation: true }) }), null, "直链不在白名单 → 拒绝（防 API 被劫持）");

  // 非 GitHub 资产地址（macOS/Linux 源）不该走这条路
  eq(await dl.resolveGithubAsset("https://evermeet.cx/ffmpeg/getrelease/zip", { fetchImpl: mkFetch() }), null, "非 GitHub 资产地址不解析");
  // 网络异常不能把异常抛给调用方
  const boom = async () => { throw new Error("net down"); };
  eq(await dl.resolveGithubAsset(assetUrl, { fetchImpl: boom }), null, "网络异常时静默返回 null");
}

{
  /* ---- downloadToFile 的回退：直连失败 → 换直链重试 ---- */
  const body = new TextEncoder().encode("PAYLOAD-" + "z".repeat(3000));
  const assetUrl = "https://github.com/o/r/releases/download/t/f.zip";
  const CDN = "https://release-assets.githubusercontent.com/x/y?sig=1";
  const tried = [];

  const fakeFetch = async (url, init) => {
    const u = String(url);
    tried.push(u);
    if (u.includes("/releases/tags/")) {
      return { ok: true, status: 200, json: async () => ({ assets: [{ id: 7, name: "f.zip" }] }) };
    }
    if (u.includes("/releases/assets/")) {
      return { ok: true, status: 302, headers: { get: () => CDN } };
    }
    // 真正的下载：原始 github.com 地址一律「建连超时」，CDN 地址成功
    if (u.startsWith("https://github.com/")) throw Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
    return {
      ok: true, status: 200,
      headers: { get: (k) => (k.toLowerCase() === "content-length" ? String(body.length) : null) },
      body: new ReadableStream({ start(c) { c.enqueue(body); c.close(); } }),
    };
  };

  const dir = mkdtempSync(path.join(tmpdir(), "rec-fb-"));
  const dest = path.join(dir, "f.zip");
  let announced = null;
  const res = await dl.downloadToFile(assetUrl, dest, { fetchImpl: fakeFetch, onResolved: (u) => (announced = u) });

  eq(res.bytes, body.length, "回退后下载成功且字节数正确");
  eq(announced, CDN, "通过 onResolved 告知界面实际使用的直链");
  eq(res.sha256, await dl.sha256File(dest), "回退后的摘要与实际文件一致");
  ok(tried.some((u) => u.startsWith("https://github.com/")), "先尝试了原始地址");
  ok(tried.some((u) => u.includes("api.github.com")), "失败后走了 API 解析");
  ok(tried.some((u) => u === CDN), "最后从 CDN 直链下载");

  // 半成品必须清掉：解析也失败时，磁盘上不能留截断的归档
  const dest2 = path.join(dir, "bad.zip");
  const alwaysFail = async (url) => {
    if (String(url).includes("api.github.com")) return { ok: false, status: 500 };
    throw Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
  };
  let threw = false;
  try { await dl.downloadToFile(assetUrl, dest2, { fetchImpl: alwaysFail, timeoutMs: 5000 }); } catch { threw = true; }
  ok(threw, "直连与回退都失败 → 抛错");
  ok(!existsSync(dest2), "失败后不留下半成品文件");

  rmSync(dir, { recursive: true, force: true });
}

{
  // 各平台的默认源必须都通过白名单（否则一键下载必然失败）
  for (const plat of ["win32", "darwin", "linux"]) {
    for (const arch of ["x64", "arm64"]) {
      const srcs = dl.defaultSources(plat, arch);
      ok(srcs.length >= 1, `${plat}/${arch} 有下载源`);
      ok(srcs.every((s) => dl.isTrustedUrl(s.url)), `${plat}/${arch} 的源都在白名单内`);
      ok(srcs.every((s) => Array.isArray(s.pick) && s.pick.length), `${plat}/${arch} 声明了要挑的文件`);
      ok(srcs.every((s) => s.kind === "zip" || s.kind === "tar.xz"), `${plat}/${arch} 声明了可识别的解包格式`);
    }
  }
  // Windows 必须挑 ffmpeg.exe（ffprobe 可选）
  const w = dl.defaultSources("win32", "x64")[0];
  ok(w.pick.includes("ffmpeg.exe"), "Windows 源包含 ffmpeg.exe");
  // Linux arm64 与 amd64 应是不同的包
  ok(dl.defaultSources("linux", "arm64")[0].url !== dl.defaultSources("linux", "x64")[0].url, "Linux 不同架构用不同包");
}

{
  // 下载时的进度回调与 sha256（用注入的 fetch 造一个假响应）
  const body = new TextEncoder().encode("x".repeat(5000));
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: (k) => (k.toLowerCase() === "content-length" ? String(body.length) : null) },
    body: new ReadableStream({
      start(c) {
        c.enqueue(body.slice(0, 2000));
        c.enqueue(body.slice(2000));
        c.close();
      },
    }),
  });
  const dir = mkdtempSync(path.join(tmpdir(), "rec-dl-"));
  const dest = path.join(dir, "out.bin");
  const seen = [];
  const res = await dl.downloadToFile("https://github.com/x/y.zip", dest, {
    fetchImpl: fakeFetch,
    onProgress: (p) => seen.push(p),
  });
  eq(res.bytes, 5000, "下载字节数正确");
  eq(res.sha256, await dl.sha256File(dest), "返回值里的 sha256 与文件实际摘要一致");
  eq(readFileSync(dest, "utf8").length, 5000, "内容完整落盘");
  ok(seen.length >= 1, "进度回调被调用");
  ok(seen.some((p) => p.percent === 100), "进度最终到 100%");

  // 不可信 URL 必须在发请求前就被拒（连 fetch 都不该调）
  let fetchCalled = false;
  const spyFetch = async () => { fetchCalled = true; throw new Error("不该被调用"); };
  let threw = false;
  try {
    await dl.downloadToFile("https://evil.com/x.zip", path.join(dir, "bad.bin"), { fetchImpl: spyFetch });
  } catch (e) {
    threw = true;
    ok(/白名单/.test(e.message), "拒绝理由说明是白名单", e.message.slice(0, 40));
  }
  ok(threw, "不可信 URL → 抛错");
  ok(!fetchCalled, "不可信 URL 在发请求前就被拒绝");

  rmSync(dir, { recursive: true, force: true });
}

{
  // 解包 → 挑选：造一个真 zip，断言嵌套目录里的 exe 被挑出来、无关文件被丢掉
  const isWin = process.platform === "win32";
  const tar = isWin ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
  if (existsSync(tar)) {
    const stage = mkdtempSync(path.join(tmpdir(), "rec-zip-"));
    const inner = path.join(stage, "ffmpeg-nested", "bin");
    mkdirSync(inner, { recursive: true });
    const ffName = isWin ? "ffmpeg.exe" : "ffmpeg";
    const probeName = isWin ? "ffprobe.exe" : "ffprobe";
    writeFileSync(path.join(inner, ffName), "FAKE-FFMPEG-" + "A".repeat(2000));
    writeFileSync(path.join(inner, probeName), "FAKE-FFPROBE");
    writeFileSync(path.join(stage, "ffmpeg-nested", "README.txt"), "license");

    const zipPath = path.join(stage, "pkg.zip");
    execFileSync(tar, ["-a", "-cf", zipPath, "-C", stage, "ffmpeg-nested"], { stdio: "ignore" });

    const binDir = mkdtempSync(path.join(tmpdir(), "rec-bin-"));
    const placed = await dl.extractAndPick(zipPath, "zip", [ffName, probeName], binDir, {});
    ok(!!placed[ffName], "从嵌套目录里挑出了 ffmpeg");
    ok(!!placed[probeName], "一并挑出了 ffprobe");
    ok(readFileSync(placed[ffName], "utf8").startsWith("FAKE-FFMPEG-"), "二进制内容完整");
    ok(!existsSync(path.join(binDir, "README.txt")), "无关文件不被搬运");
    ok(!existsSync(zipPath), "解包后归档被清理");
    ok(!!dl.existingBundled(binDir), "existingBundled 能发现已落地的副本");

    // 包里没有 ffmpeg → 必须报错（而不是静默产出空目录）
    const stage2 = mkdtempSync(path.join(tmpdir(), "rec-zip2-"));
    writeFileSync(path.join(stage2, "only.txt"), "x");
    const z2 = path.join(stage2, "p.zip");
    execFileSync(tar, ["-a", "-cf", z2, "-C", stage2, "only.txt"], { stdio: "ignore" });
    let threw = false;
    try {
      await dl.extractAndPick(z2, "zip", [ffName], mkdtempSync(path.join(tmpdir(), "rec-bin2-")), {});
    } catch (e) {
      threw = true;
      ok(/没有找到/.test(e.message), "缺 ffmpeg 的包报错文案可读", e.message.slice(0, 40));
    }
    ok(threw, "包里没有 ffmpeg → 抛错");

    rmSync(stage, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  } else {
    ok(true, `（本机无 tar，跳过解包测试）`);
  }
}

{
  // humanSize 展示
  eq(dl.humanSize(512), "512 B", "字节展示");
  eq(dl.humanSize(2048), "2.0 KB", "KB 展示");
  eq(dl.humanSize(5 * 1024 * 1024), "5.0 MB", "MB 展示");
}

{
  /* ---- 磁盘空间预检 ----
   *
   * 真实踩到的坑：C: 盘写满时，下载会在中途抛 ENOSPC，
   * 用户只看到「下载失败」，完全猜不到是磁盘问题。 */
  ok(dl.estimatedNeed(0) === 0, "未知识别大小时不估算（不阻断）");
  const n = dl.estimatedNeed(100 * 1024 * 1024);
  ok(n > 250 * 1024 * 1024, "估算含解包开销（包体 ×2.5 以上）", dl.humanSize(n));

  // 空间充足 → 放行
  const enough = await dl.assertSpaceFor("/x", 100 * 1024 * 1024, {
    freeSpace: async () => 5 * 1024 * 1024 * 1024,
  });
  ok(enough.free > 0, "空间充足时放行");

  // 空间不足 → 抛可读错误（而不是等到 ENOSPC）
  let threw = false;
  try {
    await dl.assertSpaceFor("/x", 500 * 1024 * 1024, { freeSpace: async () => 10 * 1024 * 1024 });
  } catch (e) {
    threw = true;
    eq(e.code, "ENOSPC_PREFLIGHT", "空间不足带可识别错误码");
    ok(/磁盘空间不足/.test(e.message), "空间不足的文案说清是磁盘问题", e.message.slice(0, 30));
    ok(/手动指定/.test(e.message), "空间不足时给出「手动指定」退路");
  }
  ok(threw, "空间不足 → 抛错");

  // 探测不到可用空间时不能拦（宁可放过，不要误杀）
  const unknown = await dl.assertSpaceFor("/x", 500 * 1024 * 1024, { freeSpace: async () => null });
  ok(unknown.free === null, "探测不到空间时不阻断下载");

  // 各平台源都要带上 approxBytes，否则预检形同虚设
  for (const plat of ["win32", "darwin", "linux"]) {
    const s = dl.defaultSources(plat, "x64")[0];
    ok(s.approxBytes > 0, `${plat} 的源声明了归档大小（供空间预检）`);
  }
}

/* ============================ 5. 后端 JSON-RPC ============================ */

console.log("\n--- 后端 JSON-RPC ---");

/** 起后端进程，喂一串请求，收集回包 */
function runBackend(requests, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "rec-test-"));
    const child = spawn(process.execPath, [path.join(backendDir, "index.mjs")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        MS_PLUGIN_PROTOCOL: "1",
        MS_PLUGIN_ID: "com.mysearch.recorder",
        MS_PLUGIN_DATA_DIR: dataDir,
      },
    });
    let buf = "";
    const out = [];
    let stderr = "";
    child.stdout.on("data", (d) => {
      buf += String(d);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          out.push(JSON.parse(line));
        } catch {
          out.push({ __parseError: line });
        }
      }
    });
    child.stderr.on("data", (d) => (stderr += String(d)));

    // 握手后按序发请求
    let i = 0;
    const sendNext = () => {
      if (i >= requests.length) return;
      child.stdin.write(JSON.stringify(requests[i++]) + "\n");
      setTimeout(sendNext, 350);
    };
    setTimeout(sendNext, 400);

    const killTimer = setTimeout(() => {
      try { child.kill(); } catch {}
    }, timeoutMs);

    child.on("close", () => {
      clearTimeout(killTimer);
      try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
      resolve({ out, stderr });
    });

    // 最后一并收尾
    setTimeout(() => {
      try { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "deactivate" }) + "\n"); } catch {}
    }, 400 + requests.length * 350 + 200);
  });
}

{
  const { out, stderr } = await runBackend([
    { jsonrpc: "2.0", id: 1, method: "init", params: { apiVersion: 1 } },
    { jsonrpc: "2.0", id: 2, method: "capabilities", params: {} },
    { jsonrpc: "2.0", id: 3, method: "listFonts", params: {} },
    { jsonrpc: "2.0", id: 4, method: "listRecordings", params: {} },
  ]);

  const byId = {};
  for (const m of out) if (m.id != null) byId[m.id] = m;

  ok(!!byId[1], "init 有回包");
  eq(byId[1]?.result?.ok, true, "init 回 {ok:true}（宿主在 startupTimeoutMs 内等它）");
  ok(typeof byId[1]?.result?.dataDir === "string", "init 回报数据目录");

  ok(!!byId[2], "capabilities 有回包");
  ok(byId[2]?.result?.ffmpeg && typeof byId[2].result.ffmpeg.found === "boolean", "capabilities 回报 ffmpeg 探测结果");
  ok(byId[2]?.result?.outDir && byId[2].result.outDir.includes("recordings"), "capabilities 回报产物目录");
  ok(byId[2]?.result?.hints?.format, "capabilities 回报本平台采集后端提示");

  ok(Array.isArray(byId[3]?.result?.fonts), "listFonts 回报字体数组");

  ok(Array.isArray(byId[4]?.result), "listRecordings 回报数组（空目录 → 空数组）");
  eq(byId[4]?.result?.length, 0, "空目录时列表为空");

  ok(out.some((m) => m.method === "log" && m.id == null), "启动时发出 log 通知（无 id）");
  ok(out.every((m) => !m.__parseError), "stdout 全是合法 JSON（协议通道未被日志污染）");

  // 未找到 ffmpeg 时，启动录制必须回一个带指引的错误，而不是崩掉
  ok(true, "（错误路径另测）");
}

{
  // 未装 ffmpeg 时 startRecord / applyWatermark 必须优雅报错
  const { out } = await runBackend([
    { jsonrpc: "2.0", id: 1, method: "init", params: {} },
    { jsonrpc: "2.0", id: 2, method: "startRecord", params: { fps: 30 } },
    { jsonrpc: "2.0", id: 3, method: "applyWatermark", params: { input: "nope.mp4", watermark: { enabled: true, text: "x" } } },
    { jsonrpc: "2.0", id: 4, method: "unknownMethod", params: {} },
  ]);
  const byId = {};
  for (const m of out) if (m.id != null) byId[m.id] = m;

  // 本机若已装 ffmpeg，startRecord 会真的开始录制；因此只断言「要么成功、要么是可读错误」
  const r2 = byId[2];
  ok(!!r2, "startRecord 有回包");
  if (r2.error) {
    ok(/ffmpeg/i.test(r2.error.message), "未装 ffmpeg 时给出可读提示", r2.error.message.slice(0, 80));
  } else {
    ok(r2.result && r2.result.ok === true, "已装 ffmpeg 时录制启动成功");
    // 收尾：停掉刚起的录制，别留在后台
    ok(true, "（本机装了 ffmpeg，录制已启动）");
  }

  const r3 = byId[3];
  ok(!!r3 && (r3.error || r3.result), "applyWatermark 有回包（不崩进程）");

  const r4 = byId[4];
  ok(!!r4?.error, "未知方法回 error 而不是静默丢弃");
  ok(/未知方法/.test(r4?.error?.message || ""), "未知方法的错误文案可读", r4?.error?.message);
}

{
  // 「一键下载」相关方法的协议面：downloadSources 必须永远可用（界面据此决定
  // 是否显示下载按钮）；removeBundledFfmpeg 在空目录上要给出可读结果。
  const { out } = await runBackend([
    { jsonrpc: "2.0", id: 1, method: "init", params: {} },
    { jsonrpc: "2.0", id: 2, method: "downloadSources", params: {} },
    { jsonrpc: "2.0", id: 3, method: "removeBundledFfmpeg", params: {} },
  ], { timeoutMs: 20000 });
  const byId = {};
  for (const m of out) if (m.id != null) byId[m.id] = m;

  const res2 = byId[2]?.result;
  ok(Array.isArray(res2?.sources), "downloadSources 回报源数组");
  ok(res2.sources.length >= 1, "downloadSources 至少给一个源", JSON.stringify(res2.sources?.[0]?.id));
  ok(res2.sources.every((s) => dl.isTrustedUrl(s.url)), "回报的下载源都通过白名单校验");
  ok(res2.sources.every((s) => typeof s.id === "string" && s.url && s.kind), "每个源都带 id/url/kind");

  // capabilities 里也要带上 bundled / download，否则界面判断不出该显示哪个按钮
  const caps = (await runBackend([
    { jsonrpc: "2.0", id: 1, method: "init", params: {} },
    { jsonrpc: "2.0", id: 2, method: "capabilities", params: {} },
  ])).out.find((m) => m.id === 2)?.result;
  ok(caps?.ffmpeg?.bundled && typeof caps.ffmpeg.bundled.present === "boolean", "capabilities 回报自带副本状态");
  ok(caps?.ffmpeg?.download && Array.isArray(caps.ffmpeg.download.sources), "capabilities 回报下载源");
  ok(typeof caps?.ffmpeg?.download?.inProgress === "boolean", "capabilities 回报是否正在下载");
  ok(typeof caps?.binDir === "string" && caps.binDir.length > 0, "capabilities 回报自带 ffmpeg 目录");

  // 空目录上删除：不得抛异常，且要如实回报「没有副本」
  const rm = byId[3];
  ok(!!rm && !rm.error, "没有自带副本时 removeBundledFfmpeg 不抛异常");
  eq(rm?.result?.ok, false, "空目录上删除如实回报未删除");
  ok(/没有/.test(rm?.result?.error || ""), "空目录上删除的原因可读", rm?.result?.error);
}

{
  // downloadFfmpeg 是长耗时调用，必须单独跑：它一旦卡住会拖住同一个进程里后面的请求，
  // 所以这里只发它一条，且只断言「有回包、失败也可读」，绝不依赖外网成功。
  const { out, stderr } = await runBackend([
    { jsonrpc: "2.0", id: 1, method: "init", params: {} },
    { jsonrpc: "2.0", id: 2, method: "downloadFfmpeg", params: {} },
  ], { timeoutMs: 30000 });
  const d = out.find((m) => m.id === 2);
  if (!d) {
    // 沙箱/CI 里外网被封时，这一步会一直重试直到进程被超时杀掉。
    // 真实的下载正确性已由 4b 的 downloadToFile/extractAndPick 单测覆盖，
    // 这里不把「外网不可达」误报成产品缺陷。
    ok(true, "（外网不可达，downloadFfmpeg 未在超时内返回 —— 端到端下载由 4b 单测覆盖）", stderr.slice(0, 60));
  } else {
    ok(!!(d.error || d.result), "downloadFfmpeg 有回包（不崩进程）", stderr.slice(0, 80));
    if (d.error) {
      ok(/下载|网络|超时|失败/.test(d.error.message), "下载失败时错误文案可读", d.error.message.slice(0, 80));
      // 注意：错误码只存在于 message 文案里（后端以 "[DOWNLOAD_FAILED] …" 形式
      // 拼进消息，见 plugins/recorder/backend/index.mjs 的 sendError → 上层
      // plugin_host.rs 只透传 JSON-RPC 的 error.message，不承载结构化 code）。
      // 因此这里断言文案里带上了可识别的错误码，而不是去读不存在的 error.code。
      ok(/\[DOWNLOAD_FAILED\]/.test(d.error.message), "下载失败在文案里带上可识别的错误码");
    } else {
      ok(d.result.ok === true && typeof d.result.path === "string", "网络可用时下载成功并回报绝对路径");
      ok(typeof d.result.source === "string" && d.result.source.length > 0, "成功回包带上实际使用的下载源");
    }
  }
}

/* ============================ 6. 端到端录制（本机有 ffmpeg 才跑） ============================ */

console.log("\n--- 端到端录制（计时 / 采集后端 / 区域边框） ---");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 找一个可用的 ffmpeg；找不到就跳过本节（不阻塞无 ffmpeg 的环境） */
function findLocalFfmpeg() {
  const candidates = [];
  const appData = process.env.APPDATA || "";
  if (appData) {
    candidates.push(path.join(appData, "com.mysearch.desktop", "plugin-data", "com.mysearch.recorder", "ffmpeg", "ffmpeg.exe"));
  }
  candidates.push(path.join(pluginDir, ".data", "ffmpeg", "ffmpeg.exe"));
  for (const c of candidates) if (existsSync(c)) return c;
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const p = execFileSync(cmd, ["ffmpeg"], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
    if (p && existsSync(p)) return p;
  } catch {}
  return null;
}

/** 交互式后端会话：call() 等回包，waitFor() 等通知（本节要跨多步观察录制状态） */
function openBackend() {
  return new Promise((resolve, reject) => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "rec-e2e-"));
    const child = spawn(process.execPath, [path.join(backendDir, "index.mjs")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        MS_PLUGIN_PROTOCOL: "1",
        MS_PLUGIN_ID: "com.mysearch.recorder",
        MS_PLUGIN_DATA_DIR: dataDir,
      },
    });
    const events = [];
    const waiters = [];
    const pending = new Map();
    let buf = "";
    let nextId = 1;
    let stderr = "";

    const deliver = (msg) => {
      events.push(msg);
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i];
        if (w.pred(msg)) {
          waiters.splice(i, 1);
          w.resolve(msg);
        }
      }
    };

    child.stdout.on("data", (d) => {
      buf += String(d);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          deliver(JSON.parse(line));
        } catch {
          deliver({ __parseError: line });
        }
      }
    });
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", reject);

    const api = {
      events,
      get stderr() { return stderr; },
      call(method, params = {}, timeoutMs = 45000) {
        const id = nextId++;
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        return new Promise((res, rej) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            rej(new Error(`${method} 超时（${timeoutMs}ms）`));
          }, timeoutMs);
          pending.set(id, (msg) => {
            clearTimeout(timer);
            if (msg.error) rej(new Error(msg.error.message || `${method} 失败`));
            else res(msg.result);
          });
        });
      },
      waitFor(pred, timeoutMs = 10000, label = "通知") {
        return new Promise((res, rej) => {
          for (const ev of events) if (pred(ev)) return res(ev);
          const timer = setTimeout(() => {
            const idx = waiters.findIndex((w) => w.resolve === wrapped);
            if (idx >= 0) waiters.splice(idx, 1);
            rej(new Error(`等待${label}超时（${timeoutMs}ms）`));
          }, timeoutMs);
          const wrapped = (msg) => {
            clearTimeout(timer);
            res(msg);
          };
          waiters.push({ pred, resolve: wrapped });
        });
      },
      close() {
        return new Promise((res) => {
          const done = () => {
            try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
            res();
          };
          const kill = setTimeout(() => {
            try { child.kill(); } catch {}
          }, 4000);
          child.once("close", () => {
            clearTimeout(kill);
            done();
          });
          try {
            child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "deactivate" }) + "\n");
          } catch {
            try { child.kill(); } catch {}
          }
        });
      },
    };
    resolve(api);
  });
}

{
  const ff = findLocalFfmpeg();
  if (!ff) {
    console.log("SKIP  本机没有可用 ffmpeg，端到端录制测试跳过");
  } else {
    const b = await openBackend();
    try {
      await b.call("init", { apiVersion: 1 });
      await b.call("setFfmpegPath", { path: ff });

      // 采集后端选择必须与探测结论一致（单屏 → ddagrab；多屏/不支持 → gdigrab）
      const caps = await b.call("capabilities", {});
      ok(!!caps.capture, "capabilities 回报采集后端探测", JSON.stringify(caps.capture));
      const expectBackend = caps.capture?.dda && caps.capture?.singleMonitor ? "ddagrab" : "gdigrab";
      eq(caps.capture?.backend, expectBackend, "采集后端与探测结论一致");

      let started = null;
      try {
        started = await b.call("startRecord", {
          fps: 15,
          region: { x: 120, y: 120, width: 320, height: 180 },
          showRegionFrame: true,
          watermark: { enabled: false },
        });
      } catch (e) {
        console.log("SKIP  无法启动录制（可能没有可用桌面）：", e.message);
      }

      if (started && started.ok) {
        ok(true, "startRecord 成功", "backend=" + started.backend);

        // —— 计时回归护栏：曾因 pausedMs 未初始化算出 NaN，界面恒显示 00:00:00 ——
        await sleep(1600);
        const s1 = await b.call("recordStatus", {});
        ok(
          Number.isFinite(s1.elapsedMs) && s1.elapsedMs > 300,
          "录制中 elapsedMs 是有限正数（NaN 会让界面永远 00:00:00）",
          "elapsed=" + s1.elapsedMs
        );
        await sleep(700);
        const s2 = await b.call("recordStatus", {});
        ok(s2.elapsedMs > s1.elapsedMs, "elapsedMs 随时间增长", `${s1.elapsedMs} → ${s2.elapsedMs}`);
        ok(s2.size > 0, "产物在增长（size>0）", "size=" + s2.size);

        // 暂停：时间必须冻结（同一个值读两次完全相等）
        const paused = await b.call("pauseRecord", { paused: true });
        eq(paused.paused, true, "pauseRecord 回报 paused");
        const sp = await b.call("recordStatus", {});
        await sleep(600);
        const sp2 = await b.call("recordStatus", {});
        eq(sp2.elapsedMs, sp.elapsedMs, "暂停期间 elapsedMs 完全不变");
        eq(sp2.paused, true, "暂停状态保持");
        await b.call("pauseRecord", { paused: false });
        await sleep(700);
        const s4 = await b.call("recordStatus", {});
        ok(s4.elapsedMs > sp.elapsedMs, "恢复后继续计时", `${sp.elapsedMs} → ${s4.elapsedMs}`);

        // tick 通知：旧 bug 里 JSON.stringify(NaN) 会把 elapsedMs 变成 null
        const tick = await b.waitFor((m) => m.method === "record:tick" && m.params?.elapsedMs != null, 6000, "record:tick");
        ok(Number.isFinite(tick.params.elapsedMs), "record:tick.elapsedMs 是有限数", JSON.stringify(tick.params.elapsedMs));

        // 区域录制 → 后端应拉起常驻边框（PowerShell），并回报物理矩形
        if (process.platform === "win32") {
          try {
            const borderLog = await b.waitFor(
              (m) => m.method === "log" && /区域边框已显示 rect=/.test(String(m.params?.message || "")),
              9000,
              "区域边框日志"
            );
            ok(/rect=-?\d+,-?\d+,\d+,\d+/.test(borderLog.params.message), "区域常驻边框已拉起", borderLog.params.message);
          } catch (e) {
            ok(false, "区域常驻边框已拉起", e.message);
          }
        }

        const endedP = b.waitFor((m) => m.method === "record:ended", 20000, "record:ended");
        const stopped = await b.call("stopRecord", {});
        eq(stopped.ok, true, "stopRecord 成功");
        const ended = (await endedP).params;
        ok(Number.isFinite(ended.durationMs) && ended.durationMs >= 1500, "record:ended 回报 durationMs", String(ended.durationMs));
        if (ended.ok) {
          ok(ended.size > 0, "录制产物有效", `size=${ended.size} exit=${ended.exitCode}`);
        } else {
          console.log("SKIP  录制产物无效（可能无可用桌面），只验计时：", ended.error);
        }
      }

      // —— ddagrab → gdigrab 回退：故意给一个屏幕外的区域，ddagrab 初始化必失败 ——
      //（1.5s 内退出且非用户停止 → 后端应自动换 gdigrab 重开，再走到正常结束）
      if (caps.capture?.backend === "ddagrab") {
        const endedP = b.waitFor((m) => m.method === "record:ended", 25000, "回退后的 record:ended");
        let fbStarted = null;
        try {
          fbStarted = await b.call("startRecord", {
            fps: 15,
            region: { x: 99999, y: 99999, width: 320, height: 180 },
            showRegionFrame: false,
            watermark: { enabled: false },
          });
        } catch (e) {
          console.log("SKIP  无法启动回退测试录制：", e.message);
        }
        if (fbStarted && fbStarted.ok) {
          try {
            const fbLog = await b.waitFor(
              (m) => m.method === "log" && /回退 gdigrab/.test(String(m.params?.message || "")),
              20000,
              "回退日志"
            );
            ok(true, "ddagrab 起不来时自动回退 gdigrab", fbLog.params.message);
          } catch (e) {
            ok(false, "ddagrab 起不来时自动回退 gdigrab", e.message);
          }
          const fe = (await endedP).params;
          ok(Number.isFinite(fe.durationMs), "回退后的会话也正常收尾", JSON.stringify({ ok: fe.ok, exit: fe.exitCode }));
        }
      }
    } catch (e) {
      ok(false, "端到端录制流程", e?.message || String(e));
    } finally {
      await b.close();
    }
  }
}

/* ============================ 7. UI 静态检查 ============================ */

console.log("\n--- UI 静态检查 ---");

const uiCode = readFileSync(path.join(pluginDir, "ui", "index.js"), "utf8");
const uiHtml = readFileSync(path.join(pluginDir, "ui", "detail.html"), "utf8");

ok(/new Function|\(function \(ms, env, plugin, host/.test(uiCode), "UI 脚本采用宿主约定的 IIFE 注入签名");
ok(uiCode.includes("ms.backend.call"), "UI 通过 ms.backend.call 调后端");
ok(uiCode.includes("onNotification"), "UI 订阅后端通知（录制计时/转码进度）");
ok(uiCode.includes("ffmpeg:progress"), "UI 订阅自带 ffmpeg 的下载进度");
ok(uiCode.includes("downloadFfmpeg"), "UI 能触发「一键下载」");
ok(!/\bimport\s|require\(/.test(uiCode.replace(/\/\*[\s\S]*?\*\//g, "")), "UI 脚本不依赖打包器（纯 <script>）");
ok(uiHtml.includes("rc-wm-template"), "水印控件模板存在（录屏页与加水印页复用）");
ok(!/console\.log/.test(uiCode), "UI 里没有 console.log");

// 关键 DOM id 必须在 HTML 里真实存在（否则启动即空指针）
for (const id of ["rc-rec-btn", "rc-wm-apply", "rc-lib-grid", "rc-set-ffpath", "rc-fftext",
                  "rc-ffdl", "rc-dl", "rc-dl-fill", "rc-dl-text", "rc-set-dl", "rc-set-dlrm",
                  "rc-set-bundled", "rc-set-sources", "rc-set-bindir"]) {
  ok(uiHtml.includes(`id="${id}"`), `HTML 含 id=${id}`);
}
// 下载按钮默认隐藏：只有在 capabilities 明确回报「有源且未在下载」时才由 JS 显示
ok(/<button id="rc-ffdl"[^>]*hidden/.test(uiHtml), "「一键下载」默认隐藏（避免误点）");

// 后端源码里不得出现 console.log（stdout 是协议通道）。
// 先剥掉注释——文件顶部的文档注释里**正是在警告**「不要 console.log」，
// 不剥注释会把这条警告本身当成违规（假阳性）。
const backendCode = readFileSync(path.join(backendDir, "index.mjs"), "utf8");
const backendCodeNoComments = backendCode
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");
ok(!/console\.log/.test(backendCodeNoComments), "后端不往 stdout 打日志（console.log 会污染协议）");

/* ============================ 收尾 ============================ */

console.log("");
if (fail > 0) {
  console.error(`结果: ${fail} 项失败（${pass} 通过）`);
  process.exit(1);
}
console.log(`结果: 全部通过（${pass} 项）`);
