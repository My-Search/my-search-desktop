/**
 * 生成插件清单 JSON Schema（`packages/plugin-types/plugin.schema.json`）。
 *
 * 单一事实来源：
 *   - 版本 / id / 路径 / 数值区间等约束来自 `src/lib/plugins/manifest.ts`
 *     （与 `parsePluginManifest` 使用的是同一批常量）；
 *   - 权限枚举来自 `src/lib/plugins/permissions.ts` 的 `PERMISSION_CATALOG`
 *     （与宿主鉴权、安装校验使用的是同一张表）。
 *
 * 用法：
 *   node scripts/gen-plugin-schema.mjs           # 写入
 *   node scripts/gen-plugin-schema.mjs --check   # 只校验是否与文件一致（CI / 测试用）
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PLUGIN_API_VERSION,
  PLUGIN_MANIFEST_FILE,
  COMMAND_BOUNDARY,
  NUMBER_LIMITS,
} from "../src/lib/plugins/manifest.ts";
import { PERMISSION_CATALOG } from "../src/lib/plugins/permissions.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outFile = path.join(root, "packages/plugin-types/plugin.schema.json");

const stringArray = { type: "array", items: { type: "string" }, uniqueItems: true };
const unsafePath = { not: { pattern: "..|\\\\|^/|^[A-Za-z]:|://" } };
const safeRelativePath = { type: "string", minLength: 1, maxLength: 512, ...unsafePath };
const iconRef = {
  anyOf: [
    safeRelativePath,
    { type: "string", pattern: "^data:image/" },
    { type: "string", pattern: "^https://" },
  ],
};

const permissionBaseIds = PERMISSION_CATALOG.map((p) => p.id);
const scopedIds = PERMISSION_CATALOG.filter((p) => p.scoped).map((p) => p.id.replace(/\./g, "\\."));
const permission = {
  anyOf: [
    { type: "string", enum: permissionBaseIds },
    ...(scopedIds.length
      ? [{ type: "string", pattern: `^(${scopedIds.join("|")}):[^\\s]+$` }]
      : []),
  ],
};

const numberRange = (key) => ({
  type: "integer",
  minimum: NUMBER_LIMITS[key].min,
  maximum: NUMBER_LIMITS[key].max,
  default: NUMBER_LIMITS[key].def,
});

const closeBehavior = { type: "string", enum: ["minimize", "exit"] };
const autostart = { type: "string", enum: ["always", "on-demand", "prompt", "never"] };

const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://my-search.local/plugin.schema.json",
  title: "my-search-desktop 插件清单",
  description:
    "plugin.json 的结构约束。运行时校验以宿主 parsePluginManifest 为准，本文件面向编辑器补全与作者自检。",
  type: "object",
  required: ["id", "name", "version", "apiVersion"],
  additionalProperties: true,
  properties: {
    $schema: { type: "string" },
    id: {
      type: "string",
      minLength: 3,
      maxLength: 128,
      pattern:
        "^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$",
      description: "反向域名式唯一 id；不得使用官方保留前缀 com.mysearch. / mysearch.",
    },
    name: { type: "string", minLength: 1, maxLength: 48 },
    version: {
      type: "string",
      pattern: "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$",
    },
    apiVersion: { type: "integer", minimum: 1, maximum: PLUGIN_API_VERSION },
    minAppVersion: { type: "string", pattern: "^\\d+(\\.[0-9]+)*$" },
    autoUpdate: { type: "boolean", default: false },
    author: { type: "string" },
    description: { type: "string" },
    homepage: { type: "string" },
    repository: { type: "string" },
    changelog: { type: "string" },
    icon: iconRef,
    license: { type: "string" },
    permissions: { ...stringArray, items: permission },
    optionalPermissions: { ...stringArray, items: permission },
    contributes: { $ref: "#/$defs/contributes" },
    backend: { $ref: "#/$defs/backend" },
  },
  $defs: {
    permission,
    closeBehavior,
    searchItem: {
      type: "object",
      required: ["title", "keyword"],
      additionalProperties: true,
      properties: {
        title: { type: "string", minLength: 1 },
        desc: { type: "string" },
        keyword: { type: "string", minLength: 1 },
        icon: iconRef,
        resource: { type: "string" },
        visible: { type: "boolean", default: true },
        subSearch: { type: "boolean", default: false },
      },
    },
    command: {
      type: "object",
      required: ["id", "prefix", "title"],
      additionalProperties: true,
      properties: {
        id: { type: "string", minLength: 1 },
        prefix: {
          type: "string",
          minLength: 1,
          description: `搜索框关键词前缀，约定包含分隔符「${COMMAND_BOUNDARY.trim()}」`,
        },
        title: { type: "string", minLength: 1 },
        desc: { type: "string" },
      },
    },
    detailView: {
      type: "object",
      required: ["entry"],
      additionalProperties: true,
      properties: {
        entry: safeRelativePath,
        script: safeRelativePath,
        mode: { const: "inlay" },
        compat: { const: "ms-script-env" },
        closeBehavior,
        theme: { type: "string", enum: ["dark", "light", "inherit"] },
      },
    },
    resultProvider: {
      type: "object",
      additionalProperties: true,
      properties: {
        trigger: { type: "string", enum: ["always", "prefix", "regex"], default: "always" },
        match: {
          type: "string",
          description: "trigger=prefix 为关键词前缀；trigger=regex 为正则源码（不含首尾斜杠）",
        },
        maxItems: { type: "integer", minimum: 1, maximum: 10, default: 5 },
        timeoutMs: { type: "integer", minimum: 1, maximum: 250, default: 120 },
      },
      allOf: [
        {
          if: { properties: { trigger: { const: "prefix" } }, required: ["trigger"] },
          then: { required: ["match"] },
        },
        {
          if: { properties: { trigger: { const: "regex" } }, required: ["trigger"] },
          then: { required: ["match"] },
        },
      ],
    },
    shortcut: {
      type: "object",
      required: ["action", "title"],
      additionalProperties: true,
      properties: {
        action: { type: "string", pattern: "^[a-z][a-z0-9_-]*$" },
        title: { type: "string", minLength: 1 },
        defaultShortcut: { type: "string" },
      },
    },
    contributes: {
      type: "object",
      additionalProperties: true,
      properties: {
        searchItem: {
          oneOf: [
            { $ref: "#/$defs/searchItem" },
            { type: "array", items: { $ref: "#/$defs/searchItem" } },
          ],
        },
        command: { type: "array", items: { $ref: "#/$defs/command" } },
        resultProvider: { $ref: "#/$defs/resultProvider" },
        detailView: { $ref: "#/$defs/detailView" },
        settingsPanel: {
          type: "object",
          required: ["entry"],
          additionalProperties: true,
          properties: { entry: safeRelativePath, title: { type: "string" } },
        },
        handlers: {
          type: "object",
          additionalProperties: true,
          properties: { files: { type: "boolean" }, folders: { type: "boolean" } },
        },
        shortcut: {
          oneOf: [
            { $ref: "#/$defs/shortcut" },
            { type: "array", items: { $ref: "#/$defs/shortcut" } },
          ],
        },
        clipboardCapture: { type: "boolean" },
      },
    },
    backend: {
      type: "object",
      additionalProperties: true,
      properties: {
        entry: safeRelativePath,
        command: { type: "array", minItems: 1, items: { type: "string" } },
        protocol: { type: "string", enum: ["jsonrpc-stdio", "localhost-http"] },
        autostart: { ...autostart, default: "always" },
        closeBehavior: { ...closeBehavior, default: "minimize" },
        startupTimeoutMs: numberRange("startupTimeoutMs"),
        callTimeoutMs: numberRange("callTimeoutMs"),
        idleExitSec: numberRange("idleExitSec"),
        graceSec: numberRange("graceSec"),
        shutdownTimeoutSec: numberRange("shutdownTimeoutSec"),
        maxRestarts: numberRange("maxRestarts"),
        env: {
          type: "object",
          additionalProperties: {
            type: "string",
            description: "字面量，或 $NAME / ${NAME} / $env:NAME / $secret:NAME 引用（引用需用户逐项授权）",
          },
        },
      },
      anyOf: [{ required: ["entry"] }, { required: ["command"] }],
    },
  },
  $comment: `生成文件，请勿手改；源：${PLUGIN_MANIFEST_FILE} 的宿主校验常量。`,
};

const text = `${JSON.stringify(schema, null, 2)}\n`;

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = await readFile(outFile, "utf8");
  } catch {
    /* 文件缺失按不一致处理 */
  }
  if (current !== text) {
    console.error("plugin.schema.json 与宿主校验常量不一致，请运行 node scripts/gen-plugin-schema.mjs");
    process.exit(1);
  }
  console.log("plugin.schema.json 已与宿主常量保持一致");
} else {
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, text, "utf8");
  console.log(`已写入 ${path.relative(root, outFile)}`);
}
