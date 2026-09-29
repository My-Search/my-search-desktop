/**
 * 测试用模块解析钩子：把 `lib/sync/engine.ts` 里的 `./bridge` 与 `./snapshot`
 * 解析到内存桩模块，从而完全离线地驱动同步内核。
 *
 * 只拦这两个具体 specifier，其余一律放行——避免误伤被测代码的其它依赖
 * （比如 `logger` 必须是真的，否则 `debug/warn` 的调用路径就测不到了）。
 */
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const STUB = pathToFileURL(path.join(HERE, "_sync-stub.mjs")).href;

const STUBBED = new Set(["./bridge", "./bridge.ts", "./snapshot", "./snapshot.ts"]);

export async function resolve(specifier, context, nextResolve) {
  if (STUBBED.has(specifier) && /sync[\\/]engine\.ts$/.test(context.parentURL ?? "")) {
    return { url: STUB, shortCircuit: true, format: "module" };
  }
  // 源码里有无扩展名的相对 import（如 "../../lib/logger"），Node 原生 ESM 不认。
  // 这里补上 .ts 再解析，让被测文件能按项目里的写法直接跑。
  if (specifier.startsWith(".") && context.parentURL?.startsWith("file:") && !/\.[a-z]+$/i.test(specifier)) {
    const candidate = new URL(specifier + ".ts", context.parentURL);
    // 关键：必须带上 format "module-typescript"，否则 Node 会按普通 JS 解析
    // 而把 `export type` 当成语法错误。
    if (existsSync(candidate)) {
      return { url: candidate.href, shortCircuit: true, format: "module-typescript" };
    }
  }
  return nextResolve(specifier, context);
}
