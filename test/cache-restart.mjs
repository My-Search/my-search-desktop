/**
 * 跨进程缓存验证：用磁盘文件模拟 localStorage（真实模拟「关掉 App 再打开」）
 * 用法：node test/cache-restart.mjs <round>
 *   round=1：联网加载并写缓存
 *   round=2：应命中缓存，零网络请求
 */
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_FILE = join(__dirname, ".cache-restart-store.json");
const round = process.argv[2] || "1";

// 磁盘版 localStorage：每次写都落盘，模拟真实持久化
const mem = existsSync(STORE_FILE) ? JSON.parse(readFileSync(STORE_FILE, "utf8")) : {};
globalThis.localStorage = {
  getItem: (k) => (k in mem ? mem[k] : null),
  setItem: (k, v) => {
    mem[k] = String(v);
    writeFileSync(STORE_FILE, JSON.stringify(mem));
  },
  removeItem: (k) => {
    delete mem[k];
    writeFileSync(STORE_FILE, JSON.stringify(mem));
  },
  clear: () => {
    for (const k of Object.keys(mem)) delete mem[k];
    writeFileSync(STORE_FILE, JSON.stringify(mem));
  },
};

const { SearchEngine } = await import("../src/lib/search-engine.ts");

const SUBS = [
  {
    url: "https://cdn.jsdelivr.net/gh/My-Search/official-subscribe@dev/only-system-index.ms",
    title: "系统项",
  },
  {
    url: "https://cdn.jsdelivr.net/gh/My-Search/official-subscribe@dev/index.ms",
    title: "收藏室",
  },
];

let netCount = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => {
  netCount++;
  return realFetch(...args);
};

const t = Date.now();
const engine = new SearchEngine();
await engine.initData(SUBS);
const ms = Date.now() - t;

console.log(
  `[round ${round}] 数据 ${engine.searchData.length} 条 | 网络请求 ${netCount} 次 | 耗时 ${ms}ms`
);
if (round === "1") {
  if (netCount === 0) throw new Error("round1 应发起网络请求");
  if (!existsSync(STORE_FILE)) throw new Error("round1 未写入缓存文件");
  console.log("[round 1] ✅ 已联网加载并写入缓存文件");
} else {
  if (netCount !== 0) throw new Error(`round2 不应发起网络请求，实际 ${netCount} 次`);
  if (engine.searchData.length === 0) throw new Error("round2 缓存挂载为空");
  const r = await engine.search("微信");
  if (r.length === 0) throw new Error("round2 缓存数据无法搜索");
  console.log(`[round 2] ✅ 命中缓存零网络请求，且搜索可用（微信 -> ${r.length} 条）`);
  rmSync(STORE_FILE, { force: true });
}
