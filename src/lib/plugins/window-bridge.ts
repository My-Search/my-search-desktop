/**
 * 插件独立窗口的隔离桥（P2-4）。
 *
 * 形态：
 * - 插件 HTML 跑在 `<iframe sandbox="allow-scripts allow-modals allow-downloads">` 里
 *   （**不带 `allow-same-origin`**），与宿主是两个 JS 世界；
 * - 插件只拿到 `ms` 的一个受限代理，每个调用经 `postMessage` 回宿主，
 *   宿主按 **白名单** 转发到 `createHostApi`；未列出的能力一律拒绝；
 * - 回调类 API（`onThemeChanged` / `onSubKeyword` / `results.provide`）不在
 *   白名单里：结构化克隆不能带函数，隔离窗口只支持「请求-响应」型能力。
 *
 * 这不是 iframe 沙箱的替代品，而是「插件页面即使被 XSS 也只能摸到 ms 子集」的
 * 第二道收敛：它拿不到宿主的 DOM / localStorage / Tauri internals。
 */

/** 桥的消息标记（父子两侧共用） */
export const WINDOW_BRIDGE_FLAG = "__msPluginBridge";

/**
 * 隔离窗口允许的 `ms.*` 路径白名单。
 *
 * 刻意排除：
 * - `ui.openWindow`（避免窗口套窗口）；
 * - `ui.subInput` / `ui.onThemeChanged` / `shortcuts.onAction` / `lifecycle.*`
 *   等回调型 API（由桥自己在 iframe 内实现生命周期）；
 * - `store.collection`（需要闭包持有集合名，隔离模式用 `store.*` 平铺 API）。
 */
export const WINDOW_BRIDGE_APIS: readonly string[] = [
  "search.data",
  "search.getSearchDB",
  "search.query",
  "search.trigger",
  "search.setInput",
  "search.focusInput",
  "search.closeView",
  "search.score",
  "ui.toast",
  "ui.confirm",
  "ui.setHeight",
  "ui.pickFolder",
  "input.attachments",
  "input.pickFolders",
  "input.pickFiles",
  "input.saveFile",
  "input.readFile",
  "input.listFolder",
  "input.listFolderStream",
  "input.cancelListFolder",
  "input.open",
  "input.reveal",
  "input.fileIcons",
  "input.detach",
  "store.get",
  "store.set",
  "store.remove",
  "store.keys",
  "store.readJson",
  "store.writeJson",
  "store.removeJson",
  "env.list",
  "env.pick",
  "sync.status",
  "sync.trigger",
  "system.openExternal",
  "system.readClipboard",
  "system.writeClipboard",
  "system.getSelectedText",
  "system.getSecret",
  "system.setSecret",
  "system.deleteSecret",
  "system.listSecrets",
  "commands.register",
  "commands.unregister",
  "commands.list",
  "commands.limits",
  "permissions.request",
  "permissions.history",
  "permissions.limits",
  "net.fetch",
  "net.credentials.set",
  "net.credentials.list",
  "net.credentials.remove",
  "backend.call",
  "backend.notify",
  "backend.status",
  "backend.start",
  "backend.stop",
  "clipboard.read",
  "clipboard.write",
  "clipboard.history",
  "screenshot.capture",
  "log",
];

/** 桥接协议版本（消息里带上，便于未来演进时拒绝旧客户端） */
export const WINDOW_BRIDGE_VERSION = 1;

/**
 * 生成 iframe 内的 bootstrap 脚本。
 *
 * 必须在插件自己的脚本之前执行：定义 `window.ms` 代理与 `onSubKeyword`。
 * 只使用 `postMessage`，不引用宿主对象。
 */
function bridgeBootstrap(plugin: { id: string; name: string; version: string }): string {
  const info = JSON.stringify(plugin).replace(/</g, "\\u003c");
  return `(() => {
  "use strict";
  var FLAG = ${JSON.stringify(WINDOW_BRIDGE_FLAG)};
  var VERSION = ${WINDOW_BRIDGE_VERSION};
  var parentWin = window.parent;
  var pending = new Map();
  var seq = 0;
  var handlers = { show: [], hide: [], enter: [], dispose: [] };
  var currentAction = null;
  var shown = false;
  var subKeyword = null;

  function call(path, args) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending.set(id, { resolve: resolve, reject: reject });
      try {
        parentWin.postMessage(
          { __msPluginBridge: 1, v: VERSION, id: id, api: path, args: Array.isArray(args) ? args : [] },
          "*"
        );
      } catch (e) {
        pending.delete(id);
        reject(e);
      }
    });
  }

  function make(path) {
    var fn = function () {};
    return new Proxy(fn, {
      get: function (_t, key) {
        if (typeof key !== "string") return undefined;
        if (key === "then") return undefined;
        return make(path ? path + "." + key : key);
      },
      apply: function (_t, _thisArg, args) {
        return call(path, args);
      },
    });
  }

  var lifecycle = {
    onShow: function (fn) {
      handlers.show.push(fn);
      if (shown) defer(function () { fn(); });
      return function () { var i = handlers.show.indexOf(fn); if (i >= 0) handlers.show.splice(i, 1); };
    },
    onHide: function (fn) { handlers.hide.push(fn); return function () { var i = handlers.hide.indexOf(fn); if (i >= 0) handlers.hide.splice(i, 1); }; },
    onEnter: function (fn) {
      handlers.enter.push(fn);
      if (currentAction) defer(function () { fn(currentAction); });
      return function () { var i = handlers.enter.indexOf(fn); if (i >= 0) handlers.enter.splice(i, 1); };
    },
    onDispose: function (fn) { handlers.dispose.push(fn); return function () { var i = handlers.dispose.indexOf(fn); if (i >= 0) handlers.dispose.splice(i, 1); }; },
    current: function () { return currentAction; },
  };

  function defer(fn) {
    try { queueMicrotask(fn); } catch (e) { setTimeout(fn, 0); }
  }

  var proxy = make("");
  proxy.plugin = Object.freeze(${info});
  proxy.lifecycle = lifecycle;
  proxy.log = function () { return call("log", Array.prototype.slice.call(arguments)); };
  Object.freeze(proxy);
  window.ms = proxy;

  window.onSubKeyword = function (fn) {
    if (typeof fn !== "function") {
      subKeyword = null;
      return function () {};
    }
    subKeyword = fn;
    return function () {
      if (subKeyword === fn) subKeyword = null;
    };
  };

  function fire(list, arg) {
    list.slice().forEach(function (fn) {
      try { fn(arg); } catch (e) { console.error("[插件] 生命周期回调异常:", e); }
    });
  }

  window.addEventListener("message", function (e) {
    if (e.source !== parentWin) return;
    var d = e.data;
    if (!d || d[FLAG] !== 1) return;

    if (d.id != null) {
      var p = pending.get(d.id);
      if (!p) return;
      pending.delete(d.id);
      if (d.ok) p.resolve(d.result);
      else p.reject(new Error(String(d.error || "宿主调用失败")));
      return;
    }

    if (d.event === "theme") {
      document.documentElement.className = d.dark ? "theme-dark" : "theme-light";
      var themeStyle = document.getElementById("ms-host-theme");
      if (themeStyle && d.vars) {
        var parts = [];
        for (var name in d.vars) {
          if (Object.prototype.hasOwnProperty.call(d.vars, name)) {
            parts.push(name + ": " + String(d.vars[name]).replace(/[{}<>]/g, "") + ";");
          }
        }
        themeStyle.textContent = ":root {" + parts.join("") + "}";
      }
      return;
    }

    if (d.event === "lifecycle") {
      if (d.kind === "show") shown = true;
      if (d.kind === "hide") shown = false;
      if (d.kind === "enter") currentAction = d.action || null;
      var list = handlers[d.kind];
      if (list) fire(list, d.kind === "enter" ? d.action : undefined);
      return;
    }

    if (d.event === "subKeyword" && subKeyword) {
      try { subKeyword(d.keyword, d.payload); } catch (err) { console.error("[插件] onSubKeyword 异常:", err); }
    }
  });
})();`;
}

/** 把可能含 `</script>` 的脚本内容安全内联 */
function safeInlineScript(js: string): string {
  return js.replace(/<\/script/gi, "<\\/script");
}

export interface IsolatedFrameInput {
  /** 插件 HTML（已剔除 `<script>`；宿主会按原顺序重新注入） */
  html: string;
  /** 要按顺序执行的脚本：inline 源码或外链 URL */
  scripts: Array<{ kind: "inline"; code: string } | { kind: "src"; url: string }>;
  /** 已读取的插件样式（同名 CSS / `<link>` 本地样式） */
  css: string[];
  plugin: { id: string; name: string; version: string };
  /** 宿主主题（iframe 是独立文档，CSS 变量不会自动继承，需要显式注入） */
  theme?: { dark: boolean; vars: Record<string, string> };
}

/** 过滤 CSS 变量值里的花括号/尖括号，避免破坏注入的 `:root{}` */
function cssVarValue(v: string): string {
  return String(v).replace(/[{}<>]/g, "").trim();
}

/**
 * 组装 iframe 的 `srcdoc`。
 *
 * 注意：HTML 是**不可信输入**，这里只做字符串拼装；真正的边界是 iframe sandbox
 * 与父窗口的消息白名单，不依赖任何 HTML 清洗。
 */
export function buildIsolatedFrameHtml(input: IsolatedFrameInput): string {
  const themeVars = input.theme
    ? Object.entries(input.theme.vars)
        .map(([k, v]) => `${k}: ${cssVarValue(v)};`)
        .join("")
    : "";
  const themeClass = input.theme ? (input.theme.dark ? "theme-dark" : "theme-light") : "";
  // CSS `@import` 必须出现在所有规则之前，否则会被浏览器忽略
  const imports = input.css.filter((c) => c.trim().startsWith("@import"));
  const rules = input.css.filter((c) => !c.trim().startsWith("@import") && c.trim() !== "");
  const styles = imports
    .concat(rules)
    .map((c) => `<style>${c.replace(/<\/style/gi, "<\\/style")}</style>`)
    .join("\n");
  const scripts = input.scripts
    .map((s) =>
      s.kind === "inline"
        ? `<script>${safeInlineScript(s.code)}</script>`
        : `<script src="${escapeAttr(s.url)}"></script>`
    )
    .join("\n");

  return `<!doctype html>
<html${themeClass ? ` class="${themeClass}"` : ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style id="ms-host-theme">:root {${themeVars}}</style>
<style>
  :root { color-scheme: light dark; }
  html, body { margin: 0; min-height: 100%; }
  body {
    font: 14px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
    color: var(--text, #222);
    background: transparent;
  }
</style>
${styles}
<script>${safeInlineScript(bridgeBootstrap(input.plugin))}</script>
</head>
<body>
${input.html}
${scripts}
</body>
</html>`;
}

function escapeAttr(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export interface WindowBridge {
  /** 向 iframe 推送生命周期事件 */
  lifecycle: (kind: "show" | "hide" | "enter" | "dispose", action?: unknown) => void;
  /** 向 iframe 推送宿主主题（独立文档不会自动继承 CSS 变量） */
  theme: (dark: boolean, vars: Record<string, string>) => void;
  /** 卸载监听 */
  dispose: () => void;
}

/**
 * 父窗口侧：接收 iframe 调用，按白名单转发到 `api`。
 *
 * `api` 传 `createHostApi` 的产物；本函数不额外增加权限，所有门禁仍在 API 内。
 */
export function createWindowBridge(
  frame: HTMLIFrameElement,
  api: Record<string, unknown>,
  options: { onUnknownApi?: (path: string) => void } = {}
): WindowBridge {
  const allowed = new Set(WINDOW_BRIDGE_APIS);

  function resolve(path: string): ((...args: unknown[]) => unknown) | null {
    if (!allowed.has(path)) return null;
    let cur: unknown = api;
    for (const seg of path.split(".")) {
      if (cur == null || typeof cur !== "object") return null;
      cur = (cur as Record<string, unknown>)[seg];
    }
    return typeof cur === "function" ? (cur as (...args: unknown[]) => unknown) : null;
  }

  const listener = (e: MessageEvent): void => {
    if (e.source !== frame.contentWindow) return;
    const d = e.data as
      | { __msPluginBridge?: unknown; v?: number; id?: number; api?: string; args?: unknown[] }
      | null;
    if (!d || d.__msPluginBridge !== 1) return;
    if (d.v !== WINDOW_BRIDGE_VERSION) return;
    const id = d.id;
    if (typeof id !== "number") return;
    const path = String(d.api ?? "");
    const target = frame.contentWindow;
    if (!target) return;

    const reply = (payload: Record<string, unknown>): void => {
      try {
        target.postMessage({ __msPluginBridge: 1, v: WINDOW_BRIDGE_VERSION, id, ...payload }, "*");
      } catch (err) {
        // 结果不可结构化克隆（含函数等）：退化成错误，不让插件悬挂
        target.postMessage(
          {
            __msPluginBridge: 1,
            v: WINDOW_BRIDGE_VERSION,
            id,
            ok: false,
            error: `返回值无法跨窗口传递: ${String((err as Error)?.message ?? err)}`,
          },
          "*"
        );
      }
    };

    const fn = resolve(path);
    if (!fn) {
      options.onUnknownApi?.(path);
      reply({ ok: false, error: `隔离窗口不允许调用 ${path || "(空)"}` });
      return;
    }

    const args = Array.isArray(d.args) ? d.args : [];
    // 防止一次消息把宿主拖死：限制参数个数（大体积仍由各 API 自己限流）
    if (args.length > 16) {
      reply({ ok: false, error: "参数过多" });
      return;
    }

    Promise.resolve()
      .then(() => fn(...args))
      .then(
        (result) => reply({ ok: true, result }),
        (err) => reply({ ok: false, error: String((err as Error)?.message ?? err) })
      );
  };

  window.addEventListener("message", listener);

  return {
    lifecycle: (kind, action) => {
      const target = frame.contentWindow;
      if (!target) return;
      target.postMessage(
        { __msPluginBridge: 1, v: WINDOW_BRIDGE_VERSION, event: "lifecycle", kind, action },
        "*"
      );
    },
    theme: (dark, vars) => {
      const target = frame.contentWindow;
      if (!target) return;
      target.postMessage(
        { __msPluginBridge: 1, v: WINDOW_BRIDGE_VERSION, event: "theme", dark, vars },
        "*"
      );
    },
    dispose: () => window.removeEventListener("message", listener),
  };
}
