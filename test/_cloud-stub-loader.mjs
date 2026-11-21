/**
 * 测试用模块解析钩子：把 `lib/sync/cloud.ts` 里的 `./bridge` 与 `./snapshot`
 * 解析到内存桩（`_cloud-stub.mjs`），从而完全离线地驱动云同步 v2 内核。
 *
 * 只拦 cloud.ts 的两个 import，其余放行；源码里省略扩展名的相对 import 补 `.ts`。
 */
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const STUB = pathToFileURL(path.join(HERE, "_cloud-stub.mjs")).href;

const STUBBED = new Set(["./bridge", "./bridge.ts", "./snapshot", "./snapshot.ts"]);

export async function resolve(specifier, context, nextResolve) {
  if (STUBBED.has(specifier) && /sync[\\/](cloud|cloud-v3)\.ts$/.test(context.parentURL ?? "")) {
    return { url: STUB, shortCircuit: true, format: "module" };
  }
  if (specifier.startsWith(".") && context.parentURL?.startsWith("file:") && !/\.[a-z]+$/i.test(specifier)) {
    const candidate = new URL(specifier + ".ts", context.parentURL);
    if (existsSync(candidate)) {
      return { url: candidate.href, shortCircuit: true, format: "module-typescript" };
    }
  }
  return nextResolve(specifier, context);
}
