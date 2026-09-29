/**
 * 「浅色 → 跟随系统」往返回归测试（纯逻辑，无浏览器）。
 *
 * 钉死的契约（对应「系统深色时切浅色再切回跟随系统仍停在浅色」的修复）：
 *   1. 偏好 system 下 setTheme("system") 必须按 matchMedia 重新落类
 *      （切回后恢复 theme-dark，不能停在强制浅色）；
 *   2. 上报原生层的回调必须收到**偏好**（"system" 不得被压成解析值）——
 *      Rust 据偏好决定钉不钉主题，压成 resolved 会让原生层重新钉死、
 *      matchMedia 失灵，形成自锁闭环；
 *   3. 系统偏好变化（systemListener）只在 pref=system 时生效，且同样
 *      上报 (system, 新解析值)；
 *   4. 插件视图的临时覆盖期间系统变化让路；清除覆盖时上报**软件偏好**
 *      （可能是 system），不把当时的解析值当强制主题钉回去。
 *
 * 用法: node test/theme-system-roundtrip.test.mjs
 */

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = "") => {
  if (cond) {
    pass++;
    console.log("PASS ", name, extra ? ` — ${extra}` : "");
  } else {
    fail++;
    console.log("FAIL ", name, extra ? ` — ${extra}` : "");
  }
};

/* ============ 环境 stub（须先于 theme.ts 模块加载） ============ */

/** 模拟系统深浅色（matchMedia 的数据源）与 change 监听器集合 */
const os = { dark: true, listeners: new Set() };

/** <html> 的 classList */
const classes = new Set();

globalThis.window = {
  matchMedia(query) {
    const isDarkQuery = String(query).includes("prefers-color-scheme: dark");
    return {
      get matches() {
        return isDarkQuery ? os.dark : false;
      },
      media: query,
      onchange: null,
      addEventListener(type, cb) {
        if (type === "change") os.listeners.add(cb);
      },
      removeEventListener(type, cb) {
        if (type === "change") os.listeners.delete(cb);
      },
      dispatchEvent() {
        return true;
      },
    };
  },
  // Tauri 内部桩（initTheme 里的动态 import @tauri-apps/api/event 会用到）
  __TAURI_INTERNALS__: {
    invoke(cmd) {
      return Promise.resolve(cmd === "plugin:event|listen" ? 1 : null);
    },
    transformCallback(cb) {
      return cb;
    },
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    plugins: {},
  },
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
};

globalThis.document = {
  documentElement: {
    classList: {
      add: (c) => void classes.add(c),
      remove: (c) => void classes.delete(c),
      contains: (c) => classes.has(c),
    },
  },
  dispatchEvent() {
    return true;
  },
  addEventListener() {},
  removeEventListener() {},
};

const htmlClass = () =>
  classes.has("theme-dark") ? "theme-dark" : classes.has("theme-light") ? "theme-light" : "(none)";

/** 触发系统主题变化（等价于 WebView2 派发 matchMedia change） */
function flipSystem(dark) {
  os.dark = dark;
  for (const cb of [...os.listeners]) cb({ matches: dark });
}

/* ============ 导入被测模块（须在 stub 之后） ============ */
const theme = await import("../src/lib/theme.ts");
const ov = await import("../src/lib/theme-override.ts");

/** 上报记录：[{ theme, resolved }] */
const reports = [];
const capture = (t, r) => void reports.push({ theme: t, resolved: r });
theme.setThemeReporter(capture);
// 覆盖层的上报通道：真实应用由窗口入口（main.ts / config.ts）注册
ov.setThemeOverrideReporter(capture);
const lastReport = () => reports[reports.length - 1];

/* ============ 1. 初始：pref=system + 系统深色 → theme-dark ============ */
{
  ok(theme.getTheme() === "system", "默认偏好是 system");
  theme.initTheme();
  ok(htmlClass() === "theme-dark", "initTheme 在系统深色下落 theme-dark", htmlClass());
  ok(
    lastReport()?.theme === "system" && lastReport()?.resolved === "dark",
    "注册即上报 (system, dark)",
    JSON.stringify(lastReport()),
  );
}

/* ============ 2. system → light → system 往返（核心回归） ============ */
{
  theme.setTheme("light");
  ok(htmlClass() === "theme-light", "切浅色后类为 theme-light", htmlClass());
  ok(
    lastReport()?.theme === "light" && lastReport()?.resolved === "light",
    "切浅色上报 (light, light)",
    JSON.stringify(lastReport()),
  );

  theme.setTheme("system");
  ok(
    htmlClass() === "theme-dark",
    "切回跟随系统后按系统偏好恢复 theme-dark（核心断言）",
    htmlClass(),
  );
  ok(
    lastReport()?.theme === "system" && lastReport()?.resolved === "dark",
    "上报 (system, dark)——偏好透传，不被压成解析值（核心断言）",
    JSON.stringify(lastReport()),
  );
}

/* ============ 3. 系统偏好变化：pref=system 时生效 ============ */
{
  const before = reports.length;
  flipSystem(false);
  ok(htmlClass() === "theme-light", "系统变浅色后类翻转为 theme-light", htmlClass());
  ok(
    reports.length === before + 1 && lastReport()?.theme === "system",
    "系统变化上报 (system, light)",
    JSON.stringify(lastReport()),
  );
  ok(lastReport()?.resolved === "light", "解析值随系统翻转", JSON.stringify(lastReport()));

  flipSystem(true);
  ok(htmlClass() === "theme-dark", "系统变深色后类翻转回 theme-dark", htmlClass());
  ok(
    lastReport()?.theme === "system" && lastReport()?.resolved === "dark",
    "系统变深色上报 (system, dark)",
    JSON.stringify(lastReport()),
  );
}

/* ============ 4. 强制档下系统变化不生效 ============ */
{
  theme.setTheme("light");
  const before = reports.length;
  flipSystem(false);
  ok(htmlClass() === "theme-light", "强制浅色下系统变化不改类", htmlClass());
  ok(reports.length === before, "强制浅色下系统变化不上报");
  flipSystem(true);
}

/* ============ 5. 插件视图临时覆盖：期间让路、清除时恢复偏好 ============ */
{
  theme.setTheme("system"); // 回到 pref=system + 系统深色
  ok(htmlClass() === "theme-dark", "覆盖前为 theme-dark", htmlClass());

  ov.applyThemeOverride("light");
  ok(htmlClass() === "theme-light", "覆盖期间类切为插件主题", htmlClass());
  ok(
    lastReport()?.theme === "light" && lastReport()?.resolved === "light",
    "覆盖上报 (light, light)（强制档，原生层钉住符合预期）",
    JSON.stringify(lastReport()),
  );

  const before = reports.length;
  flipSystem(false);
  ok(htmlClass() === "theme-light", "覆盖期间系统变化让路（类不变）", htmlClass());
  flipSystem(true);
  ok(htmlClass() === "theme-light", "覆盖期间系统变化让路（再次确认）", htmlClass());
  ok(reports.length === before, "覆盖期间系统变化不触发上报");

  ov.clearThemeOverride();
  ok(htmlClass() === "theme-dark", "清除覆盖后按系统偏好恢复 theme-dark", htmlClass());
  ok(
    lastReport()?.theme === "system" && lastReport()?.resolved === "dark",
    "清除覆盖上报 (system, dark)——软件偏好透传，不重新钉住原生层（核心断言）",
    JSON.stringify(lastReport()),
  );
}

theme.disposeTheme();

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
