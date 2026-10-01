/**
 * Release 更新日志提取脚本（scripts/extract-release-notes.mjs）测试。
 *
 * 覆盖契约：
 *   1. 能按 `## v7.9.21 - 日期` 形式精确命中章节，输出 = 标语 + 空行 + 章节
 *   2. 版本号前导 v 可省略（7.9.21 与 v7.9.21 等价）
 *   3. 精确匹配：7.9.1 不命中 7.9.15（前缀不相等）
 *   4. 章节在下一个二级标题处截止，不吞掉后续版本
 *   5. 支持 `## [7.9.21] - 日期` 方括号变体
 *   6. 不存在的版本 → 返回 null（CI 据此回退默认文案）
 *   7. 三级标题 `###` 不会被当成章节边界
 *   8. 真实 CHANGELOG.md：每个已知版本都能提取到内容，且以标语开头
 *
 * 用法: node test/extract-release-notes.test.mjs
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractSection, buildNotes } from "../scripts/extract-release-notes.mjs";

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = "") => {
  if (cond) {
    pass++;
    console.log("PASS ", name);
  } else {
    fail++;
    console.log("FAIL ", name, extra ? ` — ${extra}` : "");
  }
};

const SAMPLE = [
  "# 更新日志",
  "",
  "## v7.9.21 - 2026-09-30",
  "- 更新提示改为叶子右下角小红箭头",
  "",
  "## v7.9.20 - 2026-09-30",
  "- 截图/剪贴板/录屏插件 1.3.0",
  "",
  "## [7.9.15] - 2026-09-15",
  "- 修复设置窗口空白卡死",
  "",
  "## v7.9.1 - 2026-01-01",
  "- 假的旧版本（用于前缀误匹配检测）",
  "",
].join("\n");

/* ---------- 1. 基本命中 ---------- */
{
  const s = extractSection(SAMPLE, "v7.9.21");
  ok(
    s !== null &&
      s.startsWith("## v7.9.21") &&
      s.includes("叶子右下角小红箭头") &&
      !s.includes("1.3.0"),
    "命中章节且不含后续版本内容",
    JSON.stringify(s)
  );
}

/* ---------- 2. 前导 v 可省略 ---------- */
{
  const s = extractSection(SAMPLE, "7.9.21");
  ok(s !== null && s.startsWith("## v7.9.21"), "7.9.21 与 v7.9.21 等价");
}

/* ---------- 3. 精确匹配（前缀不算命中） ---------- */
{
  const s = extractSection(SAMPLE, "7.9.1");
  ok(
    s !== null && s.includes("假的旧版本") && !s.includes("小红箭头"),
    "7.9.1 只命中自身章节，不误匹配 7.9.15/7.9.21",
    JSON.stringify(s)
  );
}

/* ---------- 4. 章节边界：到下一个二级标题截止 ---------- */
{
  const s = extractSection(SAMPLE, "v7.9.20");
  ok(
    s !== null && s.includes("1.3.0") && !s.includes("空白卡死"),
    "章节在下一个 ## 处截止"
  );
}

/* ---------- 5. 方括号变体 ---------- */
{
  const s = extractSection(SAMPLE, "v7.9.15");
  ok(s !== null && s.includes("空白卡死"), "## [7.9.15] 方括号形式可命中");
}

/* ---------- 6. 不存在的版本 ---------- */
{
  const s = extractSection(SAMPLE, "v9.9.9");
  ok(s === null, "不存在的版本返回 null");
}

/* ---------- 7. ### 不是章节边界 ---------- */
{
  const multi = [
    "## v1.0.0 - 2026-01-01",
    "### 新增",
    "- 功能 A",
    "## v0.9.0 - 2025-12-01",
    "- 旧版",
    "",
  ].join("\n");
  const s = extractSection(multi, "v1.0.0");
  ok(
    s !== null && s.includes("### 新增") && s.includes("功能 A") && !s.includes("旧版"),
    "### 子标题不截断章节"
  );
}

/* ---------- 8. 真实 CHANGELOG.md ---------- */
{
  const path = resolve(dirname(fileURLToPath(import.meta.url)), "../CHANGELOG.md");
  const text = readFileSync(path, "utf8");
  const versions = [
    "v7.9.22", "v7.9.21", "v7.9.20", "v7.9.19", "v7.9.18",
    "v7.9.17", "v7.9.16", "v7.9.15", "v7.9.14", "v7.9.13",
    "v7.9.10", "v7.9.9", "v7.9.8", "v7.9.7", "v7.9.6", "v7.9.5",
  ];
  let allOk = true;
  for (const v of versions) {
    const s = extractSection(text, v);
    if (s === null) {
      allOk = false;
      console.log("      CHANGELOG.md 缺少章节:", v);
      continue;
    }
    const notes = buildNotes(s);
    if (!notes.startsWith("我的搜索桌面版 - 订阅式搜索\n\n## ")) {
      allOk = false;
      console.log("      输出未以标语 + 章节开头:", v);
    }
  }
  ok(allOk, `CHANGELOG.md 全部 ${versions.length} 个版本可提取且格式正确`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
