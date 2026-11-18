/**
 * 插件独立窗口运行时（`plugin-window.html?pluginId=<id>&entry=<relPath>`）。
 *
 * 与主搜索窗内嵌视图（`usePluginViewHost`）共享完全一致的 `createHostApi` 网关与
 * `runPluginEntry` 脚本注入契约，提供真实的 WebView 级隔离窗口支持（`ms.ui.openWindow`）。
 */

import "./css/style.css";
import { initTheme } from "./lib/theme.ts";
import { md2html, scopeCss } from "./lib/util.ts";
import { isTauri } from "./lib/tauri-bridge.ts";
import {
  createHostApi,
  disposePluginHostSession,
  type PluginHostContext,
} from "./lib/plugins/host.ts";
import { onRegistryChanged, syncRegistryGateway } from "./lib/plugins/gateway.ts";
import { readPluginText } from "./lib/plugins/ipc.ts";
import {
  findPlugin,
  loadRegistry,
  pluginDataGet,
  pluginDataRemove,
  pluginDataSet,
  saveRegistry,
  type PluginRecord,
  type PluginRegistryFile,
} from "./lib/plugins/registry.ts";
import type { ScriptEnv } from "./lib/script-runtime.ts";
import { runPluginEntry } from "./windows/search/usePluginViewHost.ts";

initTheme();

const params = new URLSearchParams(window.location.search);
const pluginId = params.get("pluginId")?.trim() || "";
const entry = params.get("entry")?.trim() || "";

const root = document.getElementById("plugin-window-root") as HTMLElement | null;

let toastTimer = 0;
function showToast(text: string, type: "ok" | "error" = "ok"): void {
  let el = document.querySelector(".ms-pw-toast") as HTMLElement | null;
  if (!el) {
    el = document.createElement("div");
    el.className = "ms-pw-toast";
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.toggle("is-error", type === "error");
  el.style.opacity = "1";
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    if (el) el.style.opacity = "0";
  }, 2200);
}

function renderFatal(msg: string): void {
  if (!root) return;
  const box = document.createElement("div");
  box.className = "ms-pw-error";
  box.textContent = msg;
  root.replaceChildren(box);
}

async function closeSelf(): Promise<void> {
  if (!isTauri) {
    window.close();
    return;
  }
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close();
  } catch {
    window.close();
  }
}

async function resolveScriptPath(rec: PluginRecord, htmlEntry: string): Promise<string | null> {
  const detail = rec.manifest.contributes?.detailView;
  const candidates: string[] = [];
  if (detail?.entry === htmlEntry && detail.script) {
    candidates.push(detail.script);
  }
  candidates.push(htmlEntry.replace(/\.html?$/i, ".js"));
  const slash = htmlEntry.lastIndexOf("/");
  const dir = slash >= 0 ? htmlEntry.slice(0, slash + 1) : "";
  candidates.push(`${dir}index.js`);

  const seen = new Set<string>();
  for (const c of candidates) {
    if (!c || seen.has(c)) continue;
    seen.add(c);
    try {
      await readPluginText(rec.id, c);
      return c;
    } catch {
      /* try next */
    }
  }
  return null;
}

function buildCompatEnv(rec: PluginRecord, api: Record<string, unknown>): ScriptEnv {
  const netFetch = (api.net as { fetch?: (u: string, o?: unknown) => Promise<unknown> } | undefined)
    ?.fetch;
  return {
    event: { sendListener: [] },
    cache: {
      get: (k: string) => pluginDataGet(rec.id, String(k), null),
      set: (k: string, v: unknown) => pluginDataSet(rec.id, String(k), v),
      remove: (k: string) => pluginDataRemove(rec.id, String(k)),
    },
    getSearchDB: () => [],
    getSelectedText: async () => "",
    md2html: (raw: unknown) => md2html(raw),
    request: async (type?: string, url?: string, o?: Record<string, unknown>) => {
      if (!netFetch) throw new Error("网络能力不可用");
      let target = String(url ?? "");
      const query = (o?.query ?? null) as Record<string, string> | null;
      if (query && Object.keys(query).length > 0) {
        target += (target.includes("?") ? "&" : "?") + new URLSearchParams(query).toString();
      }
      const rawBody = o?.body;
      const resp = (await netFetch(target, {
        method: String(type ?? "GET").toUpperCase(),
        headers: {
          ...((o?.header as Record<string, string>) ?? {}),
          ...((o?.headers as Record<string, string>) ?? {}),
        },
        body:
          rawBody == null
            ? undefined
            : typeof rawBody === "string"
              ? rawBody
              : JSON.stringify(rawBody),
      })) as { text?: string } | string;
      return typeof resp === "string" ? resp : String(resp?.text ?? "");
    },
    matchSearch: async () => [],
    data: {
      get: () => [],
      matchSearch: () => [],
      distinct: (items) => items,
    },
  };
}

async function boot(): Promise<void> {
  if (!root || !pluginId || !entry) {
    renderFatal("插件独立窗口参数缺失（需要 pluginId 与 entry）");
    return;
  }

  let registry: PluginRegistryFile = loadRegistry();
  try {
    await syncRegistryGateway(registry);
  } catch {
    /* ignore */
  }

  const rec = findPlugin(registry, pluginId);
  if (!rec || !rec.enabled) {
    renderFatal(`插件「${pluginId}」未启用或不存在`);
    return;
  }
  document.title = rec.name || pluginId;

  const stopRegWatch = onRegistryChanged(() => {
    registry = loadRegistry();
    const latest = findPlugin(registry, pluginId);
    if (!latest || !latest.enabled) {
      void closeSelf();
    }
  });

  window.addEventListener("pagehide", () => {
    stopRegWatch();
    const cleanup = (root as unknown as { __msPluginCleanup?: () => void }).__msPluginCleanup;
    if (typeof cleanup === "function") {
      try {
        cleanup();
      } catch {
        /* ignore */
      }
    }
    disposePluginHostSession(pluginId);
  });

  const ctx: PluginHostContext = {
    registry: () => registry,
    persistRegistry: () => saveRegistry(registry),
    searchData: () => [],
    triggerSearch: () => {},
    setInput: () => {},
    hideDetail: () => {
      void closeSelf();
    },
    toast: (text, type) => showToast(text, type),
    confirm: async (text) => window.confirm(text),
    getSelectedText: async () => "",
    log: (id, level, text) => {
      const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
      fn(`[插件窗口 ${id}] ${text}`);
    },
  };

  try {
    const html = await readPluginText(pluginId, entry);
    root.innerHTML = html;

    root.querySelectorAll("script").forEach((old) => {
      const s = document.createElement("script");
      if (old.src) s.src = old.src;
      else s.textContent = old.textContent;
      old.replaceWith(s);
    });

    const cssPath = entry.replace(/\.html?$/i, ".css");
    try {
      const css = await readPluginText(pluginId, cssPath);
      if (css.trim() !== "") {
        const style = document.createElement("style");
        style.textContent = scopeCss(css, "#plugin-window-root");
        root.prepend(style);
      }
    } catch {
      /* 无同名样式属正常 */
    }

    const jsPath = await resolveScriptPath(rec, entry);
    if (jsPath) {
      const js = await readPluginText(pluginId, jsPath);
      if (js.trim() !== "") {
        const api = createHostApi(pluginId, ctx);
        const res = runPluginEntry(js, {
          ms: api,
          env: buildCompatEnv(rec, api),
          record: rec,
          host: root,
          keyword: "",
          inputValue: "",
          onSubKeyword: () => {},
        });
        if (!res.ok) {
          renderFatal(`插件窗口脚本执行失败：${res.error ?? "未知错误"}`);
        }
      }
    }
  } catch (e) {
    renderFatal(`加载插件窗口失败：${String((e as Error)?.message ?? e)}`);
  }
}

void boot();
