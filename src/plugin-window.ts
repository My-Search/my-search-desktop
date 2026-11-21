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
import { dispatchLifecycle } from "./lib/plugins/host/event-hub.ts";
import { onRegistryChanged, syncRegistryGateway } from "./lib/plugins/gateway.ts";
import { readPluginText } from "./lib/plugins/ipc.ts";
import {
  pluginSecretDelete,
  pluginSecretGet,
  pluginSecretList,
  pluginSecretSet,
} from "./lib/plugins/ipc.ts";
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
import {
  buildIsolatedFrameHtml,
  createWindowBridge,
  type WindowBridge,
} from "./lib/plugins/window-bridge.ts";

initTheme();

const params = new URLSearchParams(window.location.search);
const pluginId = params.get("pluginId")?.trim() || "";
const entry = params.get("entry")?.trim() || "";
// P2-4：默认隔离形态；`mode=legacy` 只供排障/兼容旧插件显式退回。
const isolated = params.get("mode") !== "legacy";

const root = document.getElementById("plugin-window-root") as HTMLElement | null;

let toastTimer = 0;
let windowBridge: WindowBridge | null = null;
let themeObserver: MutationObserver | null = null;

/** 宿主的共享主题变量（与 `src/css/style.css` 的「插件共享主题变量」节保持同步） */
const HOST_THEME_TOKENS = [
  "--text",
  "--muted",
  "--surface",
  "--card",
  "--field",
  "--line",
  "--hover-bg",
  "--hover-border",
  "--code-bg",
  "--seg-bg",
  "--accent",
  "--accent-soft",
  "--accent-soft-2",
  "--accent-soft-3",
  "--ok",
  "--err",
  "--danger",
  "--warning",
  "--btn-shadow",
  "--dialog-shadow",
];

/** 独立 iframe 是另一个文档，宿主 CSS 变量不会自动继承，需要显式收集后注入 */
function hostTheme(): { dark: boolean; vars: Record<string, string> } {
  const computed = getComputedStyle(document.documentElement);
  const vars: Record<string, string> = {};
  const names = new Set(HOST_THEME_TOKENS);
  // 有些浏览器不会把自定义属性列进 computed.length；固定清单兜底，
  // 再补上运行时实际存在的其它 `--*`（插件自定义 token 也能拿到）。
  for (let i = 0; i < computed.length; i++) {
    const name = computed.item(i);
    if (name.startsWith("--")) names.add(name);
  }
  for (const name of names) {
    const value = computed.getPropertyValue(name).trim();
    if (value !== "") vars[name] = value;
  }
  return { dark: document.documentElement.classList.contains("theme-dark"), vars };
}
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

/** 把插件 HTML 里的相对引用解析成插件目录内的路径 */
function resolvePluginRelative(htmlEntry: string, ref: string): string {
  const clean = ref.split(/[?#]/)[0].replace(/\\/g, "/");
  if (clean.startsWith("/")) return clean.slice(1);
  const dir = htmlEntry.includes("/") ? htmlEntry.slice(0, htmlEntry.lastIndexOf("/") + 1) : "";
  const segs = (dir + clean).split("/");
  const out: string[] = [];
  for (const seg of segs) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

/**
 * 读取隔离窗口所需的全部素材。
 *
 * 脚本必须由宿主内联后按原顺序重放（sandbox iframe 没有 allow-same-origin，
 * HTML 里的相对 `src` 会相对应用地址解析，必然 404）。外链脚本保留 `src`。
 */
async function collectIsolatedAssets(
  rec: PluginRecord,
  htmlEntry: string
): Promise<{
  html: string;
  scripts: Array<{ kind: "inline"; code: string } | { kind: "src"; url: string }>;
  css: string[];
}> {
  const raw = await readPluginText(rec.id, htmlEntry);
  const doc = new DOMParser().parseFromString(raw, "text/html");
  const scripts: Array<{ kind: "inline"; code: string } | { kind: "src"; url: string }> = [];
  const css: string[] = [];
  const includedScripts = new Set<string>();

  for (const style of Array.from(doc.querySelectorAll("head style"))) {
    css.push(style.textContent ?? "");
    style.remove();
  }

  for (const link of Array.from(doc.querySelectorAll('link[rel="stylesheet"]'))) {
    const href = link.getAttribute("href") ?? "";
    if (/^(https?:)?\/\//i.test(href)) {
      // head 不会进入 body，外链样式要转成 @import 才能带进 iframe
      css.push(`@import url("${href.replace(/["\\]/g, "")}");`);
      link.remove();
      continue;
    }
    try {
      css.push(await readPluginText(rec.id, resolvePluginRelative(htmlEntry, href)));
    } catch {
      /* 样式缺失不阻塞窗口 */
    }
    link.remove();
  }

  for (const old of Array.from(doc.querySelectorAll("script"))) {
    const src = old.getAttribute("src");
    if (src && /^(https?:)?\/\//i.test(src)) {
      scripts.push({ kind: "src", url: src });
    } else if (src) {
      try {
        const path = resolvePluginRelative(htmlEntry, src);
        const code = await readPluginText(rec.id, path);
        includedScripts.add(path);
        if (code.trim() !== "") scripts.push({ kind: "inline", code });
      } catch {
        throw new Error(`插件窗口脚本缺失：${src}`);
      }
    } else {
      const code = old.textContent ?? "";
      if (code.trim() !== "") scripts.push({ kind: "inline", code });
    }
    old.remove();
  }

  // 同名 CSS（与内嵌视图保持一致的习惯：`ui/index.html` → `ui/index.css`）
  try {
    const sideCss = await readPluginText(rec.id, htmlEntry.replace(/\.html?$/i, ".css"));
    if (sideCss.trim() !== "") css.push(sideCss);
  } catch {
    /* 无同名样式属正常 */
  }

  const jsPath = await resolveScriptPath(rec, htmlEntry);
  if (jsPath && !includedScripts.has(jsPath)) {
    const code = await readPluginText(rec.id, jsPath);
    if (code.trim() !== "") scripts.push({ kind: "inline", code });
  }

  return { html: doc.body.innerHTML, scripts, css };
}

/** 隔离窗口：插件页面跑在 sandbox iframe 里，只通过白名单桥访问 ms */
async function bootIsolated(rec: PluginRecord, ctx: PluginHostContext): Promise<void> {
  if (!root) return;
  const api = createHostApi(pluginId, ctx);
  const assets = await collectIsolatedAssets(rec, entry);

  const frame = document.createElement("iframe");
  frame.className = "ms-pw-frame";
  frame.title = rec.name || pluginId;
  frame.setAttribute("sandbox", "allow-scripts allow-modals allow-downloads");
  frame.setAttribute("referrerpolicy", "no-referrer");
  root.replaceChildren(frame);

  windowBridge = createWindowBridge(frame as unknown as HTMLIFrameElement, api as any, {
    onUnknownApi: (path) => console.warn(`[插件窗口 ${pluginId}] 拒绝隔离窗口调用: ${path}`),
  });

  const pushTheme = (): void => {
    const theme = hostTheme();
    windowBridge?.theme(theme.dark, theme.vars);
  };

  frame.addEventListener("load", () => {
    const action = {
      type: "text" as const,
      code: "",
      keyword: "",
      from: "search" as const,
      at: Date.now(),
    };
    pushTheme();
    windowBridge?.lifecycle("show");
    windowBridge?.lifecycle("enter", action);
  });

  themeObserver = new MutationObserver(pushTheme);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

  frame.srcdoc = buildIsolatedFrameHtml({
    html: assets.html,
    scripts: assets.scripts,
    css: assets.css,
    plugin: { id: rec.id, name: rec.name, version: rec.manifest.version },
    theme: hostTheme(),
  });
}

async function boot(): Promise<void> {
  if (!root || !pluginId || !entry) {
    renderFatal("插件独立窗口参数缺失（需要 pluginId 与 entry）");
    return;
  }

  let registry: PluginRegistryFile = loadRegistry();
  // 后台进程的环境变量可能来自 Rust 凭据库；网关同步前先灌入内存
  try {
    const { initEnvStore } = await import("./lib/plugins/env-store.ts");
    await initEnvStore();
  } catch (e) {
    console.warn("[插件窗口] 环境变量初始化失败：", e);
  }
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

  // 云同步/导入还原完成：插件文件、插件数据、注册表都可能已变。
  // 独立窗口没有「热替换」通道，直接整页重载最可靠（脚本与样式全部按新文件重跑）；
  // 插件被禁用/卸载则关闭窗口。只还原了用户配置（scope=config）时插件本身没变，
  // 保持窗口不动，避免无谓闪烁。
  let stopSyncApplied: (() => void) | null = null;
  if (isTauri) {
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        stopSyncApplied = await listen<{ scope?: string }>("sync://applied", (e) => {
          if (e.payload?.scope === "config") return;
          registry = loadRegistry();
          const latest = findPlugin(registry, pluginId);
          if (!latest || !latest.enabled) {
            void closeSelf();
            return;
          }
          window.location.reload();
        });
      } catch {
        /* 事件总线不可用：保持旧行为 */
      }
    })();
  }

  window.addEventListener("pagehide", () => {
    stopRegWatch();
    stopSyncApplied?.();
    windowBridge?.dispose();
    windowBridge = null;
    themeObserver?.disconnect();
    themeObserver = null;
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
    getSecret: (id, name) => pluginSecretGet(id, name),
    setSecret: (id, name, value) => pluginSecretSet(id, name, value),
    deleteSecret: (id, name) => pluginSecretDelete(id, name),
    listSecrets: (id) => pluginSecretList(id),
    log: (id, level, text) => {
      const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
      fn(`[插件窗口 ${id}] ${text}`);
    },
  };

  try {
    if (isolated) {
      await bootIsolated(rec, ctx);
      return;
    }

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
        const action = {
          type: "text" as const,
          code: "",
          keyword: "",
          from: "search" as const,
          at: Date.now(),
        };
        const res = runPluginEntry(js, {
          ms: api,
          env: buildCompatEnv(rec, api),
          record: rec,
          host: root,
          keyword: "",
          inputValue: "",
          action,
          onSubKeyword: () => {},
        });
        if (!res.ok) {
          renderFatal(`插件窗口脚本执行失败：${res.error ?? "未知错误"}`);
        } else {
          // 独立窗口同样有生命周期：打开即 show + enter；关窗（pagehide）时 dispose。
          dispatchLifecycle(pluginId, "show");
          dispatchLifecycle(pluginId, "enter", action);
        }
      }
    }
  } catch (e) {
    renderFatal(`加载插件窗口失败：${String((e as Error)?.message ?? e)}`);
  }
}

void boot();
