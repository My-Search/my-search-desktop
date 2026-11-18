/**
 * 插件网络代理能力模块（`ms.net.*`）。
 *
 * 支持按 `net.fetch:<scope>` 逐域名精细鉴权，并支持二进制请求体（`bodyBase64`）
 * 与二进制响应（`responseType: "base64"`）。
 */

import { permissionBaseId } from "../permissions.ts";
import { base64ToBytes, bytesToBase64 } from "../package.ts";
import { PluginPermissionError, type CallRunner } from "./core.ts";

/** `ms.net.fetch` 的可选参数 */
export interface PluginNetFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** 二进制请求体（base64）；与 body 二选一，PUT 上传二进制文件时用 */
  bodyBase64?: string;
  /** 响应读取方式：text（默认）/ base64（图片、PDF、音视频、GBK 文本等） */
  responseType?: "text" | "base64";
  /** 响应体上限（字节）；文本默认 32MB、二进制默认 64MB，硬上限 256MB */
  maxBytes?: number;
  /** 超时（秒）；默认 30，上限 300 */
  timeoutSecs?: number;
  /** 非 2xx 是否抛错；默认 true。WebDAV 需要自行处理 401/404/409 时传 false */
  throwOnHttpError?: boolean;
}

/** `ms.net.fetch` 的返回契约 */
export interface PluginNetFetchResult {
  status: number;
  ok: boolean;
  text: string;
  headers: Record<string, string>;
  /** 仅 responseType="base64" 时存在 */
  base64?: string;
  /** 服务端 Content-Type（若返回） */
  contentType?: string;
}

/** 取 URL 的 origin（权限提示文案用） */
export function originOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return url;
  }
}

/**
 * 判断已授予的 `net.fetch` scope 是否允许该 URL。
 * 支持 `*`、`https://api.x.com/*`、`https://*.x.com/*`。
 */
export function scopeAllows(grantedPermission: string, url: string): boolean {
  const scope = grantedPermission.slice(grantedPermission.indexOf(":") + 1);
  if (!scope) return false;
  if (scope === "*") return true;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  const origin = `${target.protocol}//${target.host}${target.pathname}`;
  if (!scope.startsWith("http")) return false;
  const s = scope.slice(scope.indexOf("://") + 3);
  const slash = s.indexOf("/");
  const hostPattern = slash < 0 ? s : s.slice(0, slash);
  const pathPattern = slash < 0 ? "/*" : s.slice(slash);
  const hostOk =
    hostPattern === target.host ||
    (hostPattern.startsWith("*.") && target.host.endsWith(hostPattern.slice(1)));
  if (!hostOk) return false;
  if (pathPattern === "/*" || pathPattern === "*") return true;
  const prefix = pathPattern.endsWith("*") ? pathPattern.slice(0, -1) : pathPattern;
  return origin.endsWith(prefix) || target.pathname.startsWith(prefix);
}

/**
 * 经宿主发起的网络请求（Rust 代理，绕 CORS，且 Rust 侧做第二道 scope 复核）。
 */
export async function pluginFetch(
  pluginId: string,
  url: string,
  options: PluginNetFetchOptions = {}
): Promise<PluginNetFetchResult> {
  const responseType = options.responseType === "base64" ? "base64" : "text";
  const throwOnHttpError = options.throwOnHttpError !== false;
  let result: PluginNetFetchResult;

  const { isTauri } = await import("../../tauri-bridge.ts");
  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    result = await invoke<PluginNetFetchResult>("plugin_net_fetch", {
      pluginId,
      url,
      method: options.method ?? "GET",
      headers: options.headers ?? {},
      body: options.body ?? null,
      bodyBase64: options.bodyBase64 ?? null,
      responseType,
      maxBytes: options.maxBytes ?? null,
      timeoutSecs: options.timeoutSecs ?? null,
    });
  } else {
    const init: RequestInit = {
      method: options.method ?? "GET",
      headers: options.headers,
    };
    if (options.bodyBase64 != null) init.body = base64ToBytes(options.bodyBase64) as BodyInit;
    else if (options.body != null) init.body = options.body;
    const resp = await fetch(url, init);
    const headers: Record<string, string> = {};
    resp.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const contentType = resp.headers.get("content-type") ?? undefined;
    if (responseType === "base64") {
      const buf = new Uint8Array(await resp.arrayBuffer());
      const max = options.maxBytes ?? 64 * 1024 * 1024;
      if (buf.byteLength > max) {
        throw new Error(`响应过大（上限 ${Math.max(1, Math.round(max / 1024 / 1024))} MB）`);
      }
      result = {
        status: resp.status,
        ok: resp.ok,
        text: "",
        headers,
        base64: bytesToBase64(buf),
        contentType,
      };
    } else {
      const text = await resp.text();
      const max = options.maxBytes ?? 32 * 1024 * 1024;
      if (text.length > max) {
        throw new Error(`响应过大（上限 ${Math.max(1, Math.round(max / 1024 / 1024))} MB）`);
      }
      result = { status: resp.status, ok: resp.ok, text, headers, contentType };
    }
  }

  if (!result.ok && throwOnHttpError) {
    throw new Error(`HTTP ${result.status}: ${String(result.text ?? "").slice(0, 400)}`);
  }
  return result;
}

export function createNetApi(
  pluginId: string,
  call: CallRunner
): Record<string, unknown> {
  return {
    fetch: (url: string, options: PluginNetFetchOptions = {}) =>
      call({
        api: "net.fetch",
        detail: String(url).slice(0, 200),
        run: async (rec) => {
          const target = String(url ?? "");
          const scopes = rec.grants
            .filter((g) => permissionBaseId(g.permission) === "net.fetch")
            .map((g) => g.permission);
          const allowed = scopes.find((s) => scopeAllows(s, target));
          if (!allowed) {
            throw new PluginPermissionError(pluginId, `net.fetch:${originOf(target)}/*`);
          }
          return await pluginFetch(pluginId, target, options);
        },
      }),
  };
}
