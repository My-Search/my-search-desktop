#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 提取指定版本的更新日志章节，输出到 stdout。
 *
 * 用途：发版 CI（.github/workflows/build.yml）用它生成 GitHub Release 说明，
 * 使 Releases 页面展示真实的更新内容，而不是固定标语。
 *
 * 用法：
 *   node scripts/extract-release-notes.mjs v7.9.21
 *   node scripts/extract-release-notes.mjs 7.9.21 --changelog path/to/CHANGELOG.md
 *
 * 输出契约：
 *   - 找到章节   → stdout 输出「标语 + 空行 + 章节原文」，退出码 0；
 *   - 未找到     → stderr 输出原因，stdout 无内容，退出码 1（CI 据此回退默认文案）。
 *
 * 章节定位规则：以二级标题（`## `）的第一个词为版本号，忽略前导 v / 方括号，
 * 与目标版本精确相等（7.9.1 不会匹配 7.9.15）；章节内容到下一个二级标题为止。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

/** Release 说明首行标语（沿用历史 Release 的固定文案） */
const TAGLINE = "我的搜索桌面版 - 订阅式搜索";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 把标题里的版本词归一化为纯版本号：去前导 v、去包裹方括号 */
function normalizeVersion(token) {
  return token
    .trim()
    .replace(/^v/i, "")
    .replace(/^[[\]()]+/, "")
    .replace(/[\]\)]+$/, "");
}

/**
 * 从 CHANGELOG 全文中提取某版本章节。
 * @returns {string|null} 章节原文（含 `##` 标题行），未找到返回 null
 */
export function extractSection(changelogText, version) {
  const want = normalizeVersion(version);
  const lines = changelogText.split(/\r?\n/);
  const collected = [];
  let collecting = false;

  for (const line of lines) {
    // 只认二级标题（`## `）；`###` 不匹配（## 后必须是空白）。
    const m = /^##[ \t]+(\S+)/.exec(line);
    if (m) {
      if (collecting) break; // 章节结束（撞到下一个二级标题）
      if (normalizeVersion(m[1]) === want) collecting = true;
    }
    if (collecting) collected.push(line);
  }

  if (!collecting) return null;
  const body = collected.join("\n").replace(/\n+$/, "");
  return body.length > 0 ? body : null;
}

/** 组装最终 Release 说明：标语 + 章节 */
export function buildNotes(section) {
  return `${TAGLINE}\n\n${section}\n`;
}

function main(argv) {
  const args = argv.filter((a) => a !== "--changelog");
  const idx = argv.indexOf("--changelog");
  const changelogPath =
    idx >= 0 && argv[idx + 1]
      ? resolve(process.cwd(), argv[idx + 1])
      : resolve(REPO_ROOT, "CHANGELOG.md");
  const version = args[0];
  if (!version) {
    console.error("用法: node scripts/extract-release-notes.mjs <版本如 v7.9.21>");
    return 1;
  }

  let text;
  try {
    text = readFileSync(changelogPath, "utf8");
  } catch (e) {
    console.error(`读取 ${changelogPath} 失败: ${e.message}`);
    return 1;
  }

  const section = extractSection(text, version);
  if (section === null) {
    console.error(`${changelogPath} 中没有 ${version} 的章节`);
    return 1;
  }
  process.stdout.write(buildNotes(section));
  return 0;
}

// 直接执行时走 main（被 import 时不执行）
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
