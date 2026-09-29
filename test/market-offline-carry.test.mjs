/**
 * 回归测试：离线构建索引时，三方插件不能被误判为「该仓库没有任何 Release」。
 *
 * 背景（2026-09-28 市场事故）：
 *   publish-market.mjs 用 `build-index.mjs --local <staging>` 重建索引，
 *   但 staging 只有官方包，离线分支从目录里扫三方 tag 必然为空 →
 *   在架的 MayeLite 被踢出索引并写进 index.error.json。
 *
 * 契约（钉死）：
 *   1. 离线且无 --carry：三方源**不产生错误项**（只告警），也不静默冒充成功；
 *   2. 离线 + --carry：三方条目按仓库地址原样沿用，且不污染其时间字段；
 *   3. carry 里沿不到的仓库：跳过（不算错误、不进索引）；
 *   4. 沿用条目的 downloadUrl 仍是「开发者自己仓库的 Release」形态（三方语义）。
 *
 * 用法: node test/market-offline-carry.test.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "build-index.mjs");

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = "") => {
  if (cond) { pass++; console.log("PASS ", name, extra ? ` — ${extra}` : ""); }
  else { fail++; console.log("FAIL ", name, extra ? ` — ${extra}` : ""); }
};

/* ---------- 造一个「只有官方包」的离线镜像 + 一份含三方条目的索引 ---------- */

const work = mkdtempSync(path.join(tmpdir(), "market-carry-"));
const staging = path.join(work, "staging");
const THIRD_REPO = "some-org/my-third-plugin";
const THIRD_ID = "com.someorg.third";

/** 造一个最小合法 .mspp（zip 内含 plugin.json），复用打包器保证格式一致 */
function makeMspp(dir, id, version) {
  const src = path.join(work, "src", dir);
  mkdirSync(src, { recursive: true });
  writeFileSync(
    path.join(src, "plugin.json"),
    JSON.stringify({ id, name: id, version, apiVersion: 1, permissions: [] }, null, 2)
  );
  const out = path.join(staging, "official-plugins", id, version, `${id}.mspp`);
  mkdirSync(path.dirname(out), { recursive: true });
  execFileSync("node", [path.join(root, "test", "pack-plugin.mjs"), src, "-o", out], { stdio: "ignore" });
  return out;
}

makeMspp("official-a", "com.example.official-a", "1.0.0");

const carryFile = path.join(work, "prev-index.json");
const carriedEntry = {
  id: THIRD_ID,
  name: "第三方插件",
  version: "2.3.0",
  apiVersion: 1,
  author: "someone",
  description: "托管在开发者自己仓库的插件",
  categories: ["tools"],
  downloadUrl: `https://github.com/${THIRD_REPO}/releases/download/${THIRD_ID}/${THIRD_ID}.mspp`,
  sha256: "b".repeat(64),
  size: 1234,
  permissions: [],
  official: false,
  publishedAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};
writeFileSync(
  carryFile,
  JSON.stringify({ schemaVersion: 1, generatedAt: "x", baseUrl: "https://github.com/x/y/releases/download", plugins: [carriedEntry] }, null, 2)
);

/** 让构建器用「临时源清单」跑一次（避免动到仓库里的 plugins/index.json） */
function runBuild(extraArgs) {
  const indexSrc = path.join(root, "plugins", "index.json");
  const bak = readFileSync(indexSrc, "utf8");
  const tmpIndex = {
    "$comment": "测试用",
    "official-repo": [{ plugin: "official-plugins/com.example.official-a" }],
    "three-parties": [{ plugin: THIRD_REPO }, { plugin: "some-org/not-in-carry" }],
  };
  writeFileSync(indexSrc, JSON.stringify(tmpIndex, null, 2) + "\n");
  try {
    const out = (() => {
      try {
        return { code: 0, text: execFileSync("node", [script, "--local", staging, ...extraArgs], {
          cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
        }) };
      } catch (e) {
        return { code: e.status ?? 1, text: `${e.stdout ?? ""}${e.stderr ?? ""}` };
      }
    })();
    const distPath = path.join(root, "dist", "market", "index.dist.json");
    const errPath = path.join(root, "dist", "market", "index.error.json");
    return {
      ...out,
      dist: existsSync(distPath) ? JSON.parse(readFileSync(distPath, "utf8")) : null,
      err: existsSync(errPath) ? JSON.parse(readFileSync(errPath, "utf8")) : null,
    };
  } finally {
    writeFileSync(indexSrc, bak);
  }
}

/* ---------- 1. 离线 + --carry：三方被沿用 ---------- */
{
  const r = runBuild(["--carry", carryFile]);
  const ids = r.dist?.plugins.map((p) => p.id) ?? [];
  const third = r.dist?.plugins.find((p) => p.id === THIRD_ID);

  ok(third !== undefined, "三方插件被沿用（未被误删）", `plugins=${ids.join(",")}`);
  ok(
    r.err?.["three-parties"].length === 0,
    "index.error.json 不把三方记为错误",
    JSON.stringify(r.err?.["three-parties"])
  );
  ok(third?.version === "2.3.0", "沿用条目保留原版本", third?.version);
  ok(
    third?.downloadUrl === carriedEntry.downloadUrl,
    "沿用条目保持「开发者自己仓库 Release」的下载地址（三方语义）",
    third?.downloadUrl
  );
  ok(third?.official === false, "沿用条目仍是非官方", String(third?.official));
  ok(
    third?.publishedAt === carriedEntry.publishedAt && third?.updatedAt === carriedEntry.updatedAt,
    "沿用不刷新上架/更新时间",
    `${third?.publishedAt} / ${third?.updatedAt}`
  );
  ok(!ids.includes("com.some-org.not-in-carry"), "carry 里沿不到的仓库不进索引");
}

/* ---------- 2. 离线且无 --carry：不得把三方写成错误 ---------- */
{
  const r = runBuild([]);
  ok(
    r.err?.["three-parties"].length === 0,
    "无 --carry 时也不把三方记为「该仓库没有任何 Release」错误",
    JSON.stringify(r.err?.["three-parties"])
  );
  ok(
    (r.dist?.plugins ?? []).every((p) => p.id !== THIRD_ID),
    "无 --carry 时三方不入索引（交由 CI 在线解析）"
  );
  ok(
    /离线构建未指定 --carry/.test(r.text),
    "无 --carry 时给出醒目告警，避免静默漏掉三方"
  );
}

/* ---------- 3. 正式发布脚本必须带上兜底（防回归到旧行为） ---------- */
{
  const src = readFileSync(path.join(root, "scripts", "publish-market.mjs"), "utf8");
  ok(/"--carry"/.test(src), "publish-market 会把兜底索引传给 --carry");
  ok(/index\.dist\.json/.test(src), "兜底来源是市场已发布索引 index.dist.json");
}

rmSync(work, { recursive: true, force: true });

process.exitCode = fail > 0 ? 1 : 0;
console.log(`\n结果: ${pass} passed, ${fail} failed`);
