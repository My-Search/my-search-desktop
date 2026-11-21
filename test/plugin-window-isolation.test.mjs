/**
 * P2-4 隔离窗口形态契约测试（纯 Node 运行）。
 *
 * 覆盖：
 *   1. `buildIsolatedFrameHtml` 把插件 HTML / 样式 / 脚本按序装进 iframe，且转义 `</script>`；
 *   2. bootstrap 只暴露 `ms` 代理 + 生命周期，不暴露父子共享对象；
 *   3. `createWindowBridge`：白名单内转发、白名单外拒绝、只接受目标 iframe 的消息；
 *   4. `ui.window` → IPC → Rust 的 isolated 参数全链路，以及默认隔离 / `mode=legacy` 回退；
 *   5. iframe sandbox 不含 `allow-same-origin`（否则隔离形同虚设）。
 *
 * 用法: node test/plugin-window-isolation.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

const {
  WINDOW_BRIDGE_APIS,
  WINDOW_BRIDGE_FLAG,
  WINDOW_BRIDGE_VERSION,
  buildIsolatedFrameHtml,
  createWindowBridge,
} = await import("../src/lib/plugins/window-bridge.ts");

const cases = [];
function test(name, fn) {
  cases.push([name, fn]);
}

/* ------------------------------------------------------------------ */
/* 1. srcdoc 组装                                                      */
/* ------------------------------------------------------------------ */

test("iframe srcdoc：插件 HTML/样式/脚本按序、脚本闭合转义", () => {
  const html = buildIsolatedFrameHtml({
    html: `<div id="app">你好</div>`,
    css: ["body{color:red}", "h1{font-size:20px}</style><script>x</script>"],
    scripts: [
      { kind: "inline", code: `console.log("a"); const evil = "</script><img onerror=alert(1)>";` },
      { kind: "src", url: "https://example.com/x.js?a=1&b=2" },
      { kind: "inline", code: `console.log("c");` },
    ],
    plugin: { id: "com.example.demo", name: "演示", version: "1.0.0" },
  });

  assert.match(html, /<div id="app">你好<\/div>/);
  assert.match(html, /body\{color:red\}/);
  // 插件内容里的 `</script>` 被转义，不会提前闭合脚本
  assert.ok(!html.includes(`"</script><img`), "插件脚本里的 </script> 必须被转义");
  assert.match(html, /<\/script/); // 宿主自己的闭合标签仍在
  // 顺序：a → 外链 → c
  const ia = html.indexOf(`console.log("a")`);
  const isrc = html.indexOf("https://example.com/x.js");
  const ic = html.indexOf(`console.log("c")`);
  assert.ok(ia > 0 && ia < isrc && isrc < ic, "脚本顺序必须保持");
  // 外链 URL 属性转义
  assert.ok(html.includes(`src="https://example.com/x.js?a=1&amp;b=2"`));
  // bootstrap 在插件脚本之前
  assert.ok(html.indexOf(WINDOW_BRIDGE_FLAG) < ia, "桥 bootstrap 必须先于插件脚本");
});

test("bootstrap 只暴露 ms 代理与生命周期，不引用宿主对象", () => {
  const html = buildIsolatedFrameHtml({
    html: "",
    css: [],
    scripts: [{ kind: "inline", code: "void 0;" }],
    plugin: { id: "com.example.demo", name: "演示", version: "1.0.0" },
  });
  assert.match(html, /window\.ms = proxy/);
  assert.match(html, /window\.onSubKeyword/);
  assert.match(html, /parentWin\.postMessage/);
  assert.match(html, /handlers\.show/);
  assert.match(html, /d\.kind === "enter"/);
  // 不得把宿主 API 对象直接挂到 window
  assert.ok(!html.includes("window.__MS_HOST_API"));
  assert.ok(!html.includes("createHostApi"));
  // 消息必须带版本
  assert.ok(html.includes(`var VERSION = ${WINDOW_BRIDGE_VERSION}`));
});

/* ------------------------------------------------------------------ */
/* 2. 父窗口桥                                                         */
/* ------------------------------------------------------------------ */

function makeBridgeEnv(api) {
  const listeners = [];
  const posted = [];
  const source = { postMessage: (m) => posted.push(m) };
  const fakeWindow = {
    addEventListener: (type, fn) => {
      if (type === "message") listeners.push(fn);
    },
    removeEventListener: (type, fn) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  const prevWindow = globalThis.window;
  globalThis.window = fakeWindow;
  const frame = { contentWindow: source };
  const bridge = createWindowBridge(frame, api);
  const send = (data, src = source) => listeners.forEach((fn) => fn({ source: src, data }));
  return {
    bridge,
    posted,
    send,
    restore: () => {
      globalThis.window = prevWindow;
    },
  };
}

const nextTick = () => new Promise((r) => setTimeout(r, 0));

test("桥：白名单内调用转发并回传结果；未知 API 拒绝", async () => {
  const calls = [];
  const env = makeBridgeEnv({
    ui: { toast: (msg) => void calls.push(["toast", msg]) },
    store: { get: async (key, fallback) => (key === "k" ? "v" : fallback) },
    search: { data: () => [{ title: "a" }] },
  });
  try {
    env.send({ __msPluginBridge: 1, v: WINDOW_BRIDGE_VERSION, id: 1, api: "ui.toast", args: ["hi"] });
    env.send({ __msPluginBridge: 1, v: WINDOW_BRIDGE_VERSION, id: 2, api: "store.get", args: ["k", "d"] });
    env.send({ __msPluginBridge: 1, v: WINDOW_BRIDGE_VERSION, id: 3, api: "ui.openWindow", args: [] });
    await nextTick();

    const replies = env.posted.filter((m) => m.id != null);
    assert.equal(replies.length, 3);
    const byId = (id) => replies.find((m) => m.id === id);
    assert.deepEqual(byId(1), {
      __msPluginBridge: 1,
      v: WINDOW_BRIDGE_VERSION,
      id: 1,
      ok: true,
      result: undefined,
    });
    assert.equal(byId(2).ok, true);
    assert.equal(byId(2).result, "v");
    assert.equal(byId(3).ok, false);
    assert.match(byId(3).error, /不允许调用 ui\.openWindow/);
    assert.deepEqual(calls, [["toast", "hi"]]);
  } finally {
    env.bridge.dispose();
    env.restore();
  }
});

test("桥：只接受目标 iframe 的消息，且拒绝超量参数", async () => {
  const env = makeBridgeEnv({ ui: { toast: () => {} } });
  try {
    // 其他窗口伪造同结构消息：必须忽略（不回复、不调用）
    env.send(
      { __msPluginBridge: 1, v: WINDOW_BRIDGE_VERSION, id: 9, api: "ui.toast", args: ["evil"] },
      { postMessage: () => {} }
    );
    env.send({
      __msPluginBridge: 1,
      v: WINDOW_BRIDGE_VERSION,
      id: 10,
      api: "ui.toast",
      args: Array.from({ length: 17 }, () => "x"),
    });
    await nextTick();
    const replies = env.posted.filter((m) => m.id != null);
    assert.equal(replies.length, 1, "伪造来源的消息不应被回复");
    assert.equal(replies[0].id, 10);
    assert.equal(replies[0].ok, false);
    assert.match(replies[0].error, /参数过多/);
  } finally {
    env.bridge.dispose();
    env.restore();
  }
});

test("白名单：不含回调型 API、窗口套窗口与集合闭包 API", () => {
  const banned = [
    "ui.openWindow",
    "ui.subInput",
    "ui.onThemeChanged",
    "shortcuts.onAction",
    "results.provide",
    "lifecycle.onShow",
    "store.collection",
  ];
  for (const p of banned) assert.ok(!WINDOW_BRIDGE_APIS.includes(p), `${p} 不应在隔离白名单`);
  for (const p of ["ui.toast", "net.fetch", "net.credentials.set", "store.get", "backend.call"]) {
    assert.ok(WINDOW_BRIDGE_APIS.includes(p), `${p} 应在隔离白名单`);
  }
});

test("宿主主题显式注入：iframe 独立文档不继承 CSS 变量", async () => {
  const html = buildIsolatedFrameHtml({
    html: `<div class="theme-dark">深色</div>`,
    css: [],
    scripts: [],
    plugin: { id: "com.example.demo", name: "演示", version: "1.0.0" },
    theme: { dark: true, vars: { "--text": "#e4e6ea", "--card": "#22252a" } },
  });
  assert.match(html, /<html class="theme-dark">/);
  assert.match(html, /:root \{--text: #e4e6ea;--card: #22252a;\}/);

  const env = makeBridgeEnv({});
  try {
    env.bridge.theme(false, { "--text": "#1f2329" });
    const msg = env.posted.find((m) => m.event === "theme");
    assert.ok(msg, "应发送 theme 事件");
    assert.equal(msg.dark, false);
    assert.deepEqual(msg.vars, { "--text": "#1f2329" });
    // bootstrap 必须能处理 theme 事件（否则运行时切换主题不生效）
    assert.match(html, /d\.event === "theme"/);
    assert.match(html, /themeStyle\.textContent = ":root \{"/);
  } finally {
    env.bridge.dispose();
    env.restore();
  }
});

/* ------------------------------------------------------------------ */
/* 3. 全链路接线                                                       */
/* ------------------------------------------------------------------ */

test("ui.window → IPC → Rust 的 isolated 全链路与 legacy 回退", () => {
  const ui = read("src/lib/plugins/host/ui-data-api.ts");
  assert.match(ui, /isolated\?: boolean/);
  assert.match(ui, /const isolated = opts\.isolated !== false/);
  assert.match(ui, /ctx\.openPluginWindow\(pid, resolvedEntry, resolvedTitle, \{[\s\S]*?isolated,[\s\S]*?\}\)/);
  assert.match(ui, /pluginOpenWindow\(pid, \{[\s\S]*?isolated,[\s\S]*?\}\)/);

  const ipc = read("src/lib/plugins/ipc.ts");
  assert.match(ipc, /isolated\?: boolean/);
  assert.match(ipc, /invoke<string>\("plugin_open_window", \{[\s\S]*?isolated: options\.isolated !== false/);

  const rust = read("src-tauri/src/plugin_host.rs");
  assert.match(rust, /isolated: Option<bool>/);
  assert.match(rust, /let isolated = isolated\.unwrap_or\(true\)/);
  assert.match(rust, /if isolated \{[\s\S]*?\} else \{[\s\S]*?-legacy/);
  assert.match(rust, /if isolated \{ "" \} else \{ "&mode=legacy" \}/);

  const win = read("src/plugin-window.ts");
  assert.match(win, /params\.get\("mode"\) !== "legacy"/);
  assert.match(win, /await bootIsolated\(rec, ctx\)/);
  assert.match(win, /buildIsolatedFrameHtml/);
  assert.match(win, /createWindowBridge/);
  assert.match(win, /allow-scripts allow-modals allow-downloads/);
  const sandboxLine = win.split("\n").find((l) => l.includes('setAttribute("sandbox"')) ?? "";
  assert.ok(sandboxLine.includes("allow-scripts"), "sandbox 必须允许插件脚本");
  assert.ok(
    !sandboxLine.includes("allow-same-origin"),
    "隔离 iframe 不能带 allow-same-origin（会与父窗口同源）"
  );
  assert.ok(
    !sandboxLine.includes("allow-forms"),
    "不允许表单提交：否则可绕过 net.fetch scope 直接向任意站点 POST"
  );
  // 默认分支必须在插件脚本执行前 return，避免旧路径又跑一遍
  assert.match(win, /if \(isolated\) \{[\s\S]*?return;[\s\S]*?\}/);
  // pagehide 释放桥监听
  assert.match(win, /windowBridge\?\.dispose\(\)/);
});

/* ------------------------------------------------------------------ */

let passed = 0;
for (const [name, fn] of cases) {
  try {
    await fn();
    passed += 1;
    console.log(`ok ${passed} - ${name}`);
  } catch (err) {
    console.error(`not ok - ${name}`);
    console.error(err);
    process.exitCode = 1;
    break;
  }
}
if (process.exitCode !== 1) console.log(`\n${passed}/${cases.length} 项通过`);
