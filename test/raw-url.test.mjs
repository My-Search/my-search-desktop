/**
 * raw.githubusercontent URL 解析测试
 *
 * 背景：Rust 端 convert_raw_to_jsdelivr/convert_raw_to_api 原实现用
 * `parts.len() < 5` 判断，把 `owner/repo/branch/file`（4 段，文件在仓库根目录）
 * 误判为「无法转换」，导致这类订阅直连失败时无法回退 CDN。
 * JS 端（tauri-bridge.js）同款逻辑还存在 `refs/tags` 不识别、
 * 缺文件名时拼出 `@refs/heads/dev` 非法 URL 的问题。
 *
 * 本测试与 Rust 侧 `cargo test` 的 tests 模块一一对应，
 * 保证两端行为一致（同一组输入 → 同一组输出）。
 */
import { parseRawGithubUrl } from "../src/lib/tauri-bridge.js";

const failures = [];
const check = (name, actual, expected) => {
  const ok = actual === expected;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) {
    console.log(`      期望: ${expected}`);
    console.log(`      实际: ${actual}`);
    failures.push(name);
  }
};

const cdn = (url) => {
  const p = parseRawGithubUrl(url);
  return p ? `https://cdn.jsdelivr.net/gh/${p.owner}/${p.repo}@${p.branch}/${p.path}` : null;
};

// ---- refs/heads 形式（官方订阅实际使用的写法）----
check(
  "refs/heads 根目录文件",
  cdn(
    "https://raw.githubusercontent.com/My-Search/official-subscribe/refs/heads/dev/only-system-index.ms"
  ),
  "https://cdn.jsdelivr.net/gh/My-Search/official-subscribe@dev/only-system-index.ms"
);

// ---- refs/tags 形式（原 JS 实现会拼出 @refs/tags/... 非法 URL）----
check(
  "refs/tags 多级路径",
  cdn("https://raw.githubusercontent.com/o/r/refs/tags/v1.2.3/a/b.md"),
  "https://cdn.jsdelivr.net/gh/o/r@v1.2.3/a/b.md"
);

// ---- 标准分支形式：4 段（回归点：曾返回 null）----
check(
  "标准分支-根目录文件",
  cdn("https://raw.githubusercontent.com/owner/repo/main/index.ms"),
  "https://cdn.jsdelivr.net/gh/owner/repo@main/index.ms"
);

// ---- 标准分支形式：多级路径 ----
check(
  "标准分支-多级路径",
  cdn("https://raw.githubusercontent.com/owner/repo/main/a/b/c.md"),
  "https://cdn.jsdelivr.net/gh/owner/repo@main/a/b/c.md"
);

// ---- 中文路径 ----
check(
  "中文路径",
  cdn("https://raw.githubusercontent.com/o/r/refs/heads/dev/系统数据项/ai-app.md"),
  "https://cdn.jsdelivr.net/gh/o/r@dev/系统数据项/ai-app.md"
);

// ---- 缺文件名：不应转换（避免拼非法 URL）----
check("缺文件名-仅分支", cdn("https://raw.githubusercontent.com/o/r/main"), null);
check(
  "缺文件名-refs/heads",
  cdn("https://raw.githubusercontent.com/o/r/refs/heads/dev"),
  null
);
check(
  "非 heads/tags 的 refs",
  cdn("https://raw.githubusercontent.com/o/r/refs/pull/1/head"),
  null
);

// ---- 非 raw.githubusercontent 主机 ----
check("其他主机", cdn("https://example.com/o/r/main/a.md"), null);

// ---- 连续斜杠（空段应被忽略）----
check(
  "连续斜杠",
  cdn("https://raw.githubusercontent.com/o/r//main/a.md"),
  "https://cdn.jsdelivr.net/gh/o/r@main/a.md"
);

// ---- 返回结构完整性 ----
const parsed = parseRawGithubUrl(
  "https://raw.githubusercontent.com/o/r/refs/heads/main/a.md"
);
check(
  "解析元组一致",
  JSON.stringify(parsed),
  JSON.stringify({ owner: "o", repo: "r", branch: "main", path: "a.md" })
);

console.log("");
if (failures.length) {
  console.error(`结果: ${failures.length} 项失败`);
  process.exit(1);
}
console.log("结果: 全部通过");
