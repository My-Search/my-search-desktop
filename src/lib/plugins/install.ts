/**
 * 安装包预处理 —— 从 `.msplugin`（ZIP）到「可直接落盘的文件表 + 已校验清单」。
 *
 * 为什么单独成模块（而不是写在面板的 click 处理里）：
 *   - 这一段是**纯逻辑**（解压 → 剥离包裹目录 → 定位清单 → 校验），可以脱离
 *     浏览器/Tauri 直接用 Node 跑单测；面板只管选文件、弹确认、调运行时。
 *   - 安装链路历史上出过「解压越界」「清单被当成普通文件过滤掉导致 Rust 侧
 *     校验必然失败」等问题，集中在可测的地方才守得住。
 *
 * 安全：不信任包内任何内容。路径安全在 `readZip` 已挡一层（zip-slip / 符号
 * 链接 / 加密包），这里再挡「清单不在根」「清单与目录不符」，Rust 落盘时还有
 * 第三层（`is_safe_relative` + id 一致性）。
 */

import {
  checkMinAppVersion,
  parsePluginManifest,
  PLUGIN_MANIFEST_FILE,
  type PluginManifest,
} from "./manifest.ts";
import { base64ToBytes, bytesToBase64, readZip, stripWrappingDirectory, ZipError, type ZipEntry } from "./package.ts";

/** 落盘用的一个文件（base64 与 Rust `InstallFile.data` / 前端 IPC 对齐） */
export interface InstallFilePayload {
  path: string;
  data: string;
  executable?: boolean;
}

/** 预处理结果 */
export interface PreparedInstall {
  manifest: PluginManifest;
  /** 清单原文（直接作为 `plugin.json` 落盘，避免二次序列化丢字段） */
  manifestText: string;
  /** 除清单外的所有文件（相对插件根目录的路径） */
  files: InstallFilePayload[];
  /** 整个安装包的 SHA-256（十六进制；完整性校验与「同包重装」判定用） */
  sha256: string;
  /** 清单校验产生的警告（非致命，安装确认框展示） */
  warnings: string[];
}

/** 预处理失败（文案面向用户，可直接弹窗） */
export class InstallPrepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallPrepError";
  }
}

/** 允许被标记为可执行的文件（仅 backend/ 目录下） */
const EXECUTABLE_EXT = /\.(exe|cmd|bat|sh|command|bin|py|js)$/i;

/** 该路径是否应被标记为可执行（Rust 侧只对 backend/ 下的文件设权限位） */
export function isExecutablePath(path: string): boolean {
  return /^backend\//.test(path) && EXECUTABLE_EXT.test(path);
}

/** 计算 SHA-256（十六进制）。crypto.subtle 在 WebView2 与 Node 22 均可用。 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const view = new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
  const digest = await crypto.subtle.digest("SHA-256", view as unknown as ArrayBufferView<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 取清单条目（先剥离包裹目录，再要求位于包根） */
export function findManifestEntry(entries: readonly ZipEntry[]): ZipEntry | null {
  return entries.find((e) => e.name === PLUGIN_MANIFEST_FILE) ?? null;
}

/**
 * 预处理一个插件安装包。
 *
 * @param zipBytes 安装包原始字节（`base64ToBytes` 之后）
 * @param opts.hostVersion 当前应用版本（校验 `minAppVersion`；取不到时跳过）
 * @param opts.checkPermissions 权限词表校验（注入以避免循环依赖）
 */
export async function preparePackage(
  zipBytes: Uint8Array,
  opts: {
    hostVersion?: string | null;
    checkPermissions?: (id: string) => boolean;
  } = {}
): Promise<PreparedInstall> {
  let entries: ZipEntry[];
  try {
    const buffer = zipBytes.buffer.slice(
      zipBytes.byteOffset,
      zipBytes.byteOffset + zipBytes.byteLength
    ) as ArrayBuffer;
    const result = await readZip(buffer);
    entries = stripWrappingDirectory(result.entries);
  } catch (e) {
    if (e instanceof ZipError) throw new InstallPrepError(e.message);
    throw new InstallPrepError(`读取安装包失败：${String((e as Error)?.message ?? e)}`);
  }

  const manifestEntry = findManifestEntry(entries);
  if (!manifestEntry) {
    // 给用户可操作的提示：包内路径长什么样一目了然
    const sample = entries
      .slice(0, 3)
      .map((e) => e.name)
      .join("、");
    throw new InstallPrepError(
      `安装包根目录下没有 ${PLUGIN_MANIFEST_FILE}。` + (sample ? `包内文件示例：${sample}` : "")
    );
  }

  const decoder = new TextDecoder("utf-8");
  const manifestText = decoder.decode(manifestEntry.data);
  const parsed = parsePluginManifest(manifestText, opts.checkPermissions);
  if (!parsed.ok) {
    const { describeManifestErrors } = await import("./manifest.ts");
    const readable = describeManifestErrors(parsed.errors);
    throw new InstallPrepError(`插件清单校验失败：\n· ${readable.join("\n· ")}`);
  }

  const minVersion = checkMinAppVersion(parsed.manifest, opts.hostVersion);
  if (!minVersion.ok) throw new InstallPrepError(minVersion.error);

  // 警告码同样要翻译：它们会被拼进安装确认弹窗，直接透传就成了
  // 「注意：· id.reservedPrefix:com.mysearch」这种给用户看的天书。
  const { describeManifestErrors: describeWarnings } = await import("./manifest.ts");
  const warnings = describeWarnings(parsed.warnings);

  // 清单以外的文件（清单本身也要落盘：运行时读清单、Rust 侧校验 id 一致性都依赖它）
  const files: InstallFilePayload[] = entries.map((e) => ({
    path: e.name,
    data: bytesToBase64(e.data),
    executable: isExecutablePath(e.name),
  }));
  // 清单放最后：Rust 侧先写其它文件、再读清单校验，顺序无所谓，但保持稳定便于断言
  files.sort((a, b) => (a.path === PLUGIN_MANIFEST_FILE ? 1 : b.path === PLUGIN_MANIFEST_FILE ? -1 : 0));

  const sha256 = await sha256Hex(zipBytes);
  return { manifest: parsed.manifest, manifestText, files, sha256, warnings };
}

/** 从 base64 文本预处理安装包（面板拿到本地文件 base64 后直接调用） */
export async function preparePackageFromBase64(
  base64: string,
  opts: { hostVersion?: string | null; checkPermissions?: (id: string) => boolean } = {}
): Promise<PreparedInstall> {
  return await preparePackage(base64ToBytes(base64), opts);
}
