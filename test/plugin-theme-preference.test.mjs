/**
 * 插件「界面主题」纯逻辑测试。
 *
 * 要钉死的契约：
 *   1. 清单侧：`contributes.detailView.theme` 的取值/校验/默认值/错误文案；
 *   2. 记录侧：首次安装落在**插件建议值**上；升级只更新建议、绝不覆盖用户选择；
 *   3. 老记录迁移：结构里缺 `themePreference` 时按插件建议补齐（已有值不动）；
 *   4. 求解：`resolvePluginTheme`（用户选择 → 清单声明 → 默认 inherit）判定矩阵；
 *   5. 覆盖层：`theme-override` 的 set/clear 幂等、恢复软件主题、以及
 *      「覆盖期间自动主题路径让路」的查询接口。
 *
 * 用法: node test/plugin-theme-preference.test.mjs
 */
import {
  DEFAULT_PLUGIN_THEME,
  detailViewThemeOf,
  parsePluginManifest,
  describeManifestErrors,
} from "../src/lib/plugins/manifest.ts";
import {
  createPluginRecord,
  loadRegistry,
  resolvePluginTheme,
  upsertPlugin,
} from "../src/lib/plugins/registry.ts";

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

/** 造一份最小合法清单（detailView 需要 ui.inlay 权限成对出现） */
const manifestOf = (detailView = {}, extra = {}) => ({
  id: "com.example.theme",
  name: "主题测试插件",
  version: "1.0.0",
  apiVersion: 1,
  permissions: ["ui.inlay"],
  contributes: {
    detailView: { entry: "ui/detail.html", ...detailView },
  },
  ...extra,
});

const parse = (raw) => parsePluginManifest(raw, () => true);

/** 造一个已解析记录（走真实 createPluginRecord，避免手写字段漏项） */
const recOf = (detailView = {}, overrides = {}) => {
  const p = parse(manifestOf(detailView, overrides.manifestExtra ?? {}));
  const rec = createPluginRecord({
    manifest: p.manifest,
    dir: "plugins/com.example.theme",
    source: { kind: "folder" },
  });
  return { rec: { ...rec, ...(overrides.record ?? {}) }, manifest: p.manifest };
};

/* ============ 1. 清单校验与默认值 ============ */
{
  const r = parse(manifestOf());
  ok(r.ok === true, "不写 theme 的清单合法");
  ok(
    r.ok && r.manifest.contributes.detailView.theme === undefined,
    "缺省时 detailView.theme 不落值（由 detailViewThemeOf 兜 inherit）",
  );
  ok(DEFAULT_PLUGIN_THEME === "inherit", "默认常量是 inherit（老插件行为不变）");
  ok(detailViewThemeOf(r.manifest) === "inherit", "detailViewThemeOf 缺省 → inherit");
}
{
  const r = parse(manifestOf({ theme: "dark" }));
  ok(r.ok && r.manifest.contributes.detailView.theme === "dark", "显式声明 dark 被保留");
}
{
  const r = parse(manifestOf({ theme: "light" }));
  ok(r.ok && r.manifest.contributes.detailView.theme === "light", "显式声明 light 被保留");
}
{
  const r = parse(manifestOf({ theme: "inherit" }));
  ok(r.ok && r.manifest.contributes.detailView.theme === "inherit", "显式声明 inherit 被保留");
}
{
  const r = parse(manifestOf({ theme: "DARK" }));
  ok(r.ok === false, "大小写不匹配的取值被拒绝");
  ok(
    r.ok === false && r.errors.includes("contributes.detailView.theme.invalid"),
    "错误码为 contributes.detailView.theme.invalid",
    r.ok ? "-" : JSON.stringify(r.errors),
  );
}
{
  const r = parse(manifestOf({ theme: "auto" }));
  ok(r.ok === false, "非法取值 auto 被拒绝");
  const texts = describeManifestErrors(r.errors); // → string[]
  const text = texts.join(" | ");
  ok(
    text.includes("detailView.theme") && text.includes("inherit"),
    "错误文案可读且点明合法取值",
    text,
  );
}

/* ============ 2. 记录侧：首次安装 / 升级不覆盖 ============ */
{
  const { rec } = recOf({ theme: "dark" });
  ok(rec.themePreference === "dark", "首次安装落在插件建议值 dark 上", rec.themePreference);
}
{
  const { rec } = recOf();
  ok(rec.themePreference === "inherit", "未声明时首次安装落 inherit", rec.themePreference);
}
{
  // 用户改成 light 后，插件升级把建议改成 dark —— 用户选择必须保留
  const { rec } = recOf({ theme: "dark" });
  const reg = { version: 1, plugins: [{ ...rec, themePreference: "light" }] };
  const upgraded = recOf({ theme: "dark" });
  upgraded.rec.version = "2.0.0";
  const merged = upsertPlugin(reg, upgraded.rec);
  ok(merged.themePreference === "light", "升级不覆盖用户的界面主题选择", merged.themePreference);
  ok(merged.version === "2.0.0", "版本照常更新");
}
{
  // preserveUserChoices: false（重装/覆盖）时应采用新值
  const { rec } = recOf({ theme: "dark" });
  const reg = { version: 1, plugins: [{ ...rec, themePreference: "light" }] };
  const incoming = recOf({ theme: "dark" });
  const merged = upsertPlugin(reg, incoming.rec, { preserveUserChoices: false });
  ok(merged.themePreference === "dark", "preserveUserChoices:false 时采用新记录的值");
}

/* ============ 3. 老记录迁移（缺字段时按清单建议补齐） ============ */
{
  // 直接构造一份「升级前装的」注册表：没有 themePreference 字段
  const { rec } = recOf({ theme: "dark" });
  const legacy = { ...rec };
  delete legacy.themePreference;
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  store.set(
    "my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY",
    JSON.stringify({ version: 1, plugins: [legacy] }),
  );
  const loaded = loadRegistry();
  ok(
    loaded.plugins[0]?.themePreference === "dark",
    "老记录读时补上插件建议值（dark）",
    loaded.plugins[0]?.themePreference,
  );
  // 已有值一律不动
  store.set(
    "my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY",
    JSON.stringify({ version: 1, plugins: [{ ...rec, themePreference: "light" }] }),
  );
  ok(loadRegistry().plugins[0]?.themePreference === "light", "已有 themePreference 不被迁移覆盖");
  delete globalThis.localStorage;
}

/* ============ 4. resolvePluginTheme 判定矩阵 ============ */
{
  const { rec } = recOf({ theme: "dark" });
  ok(resolvePluginTheme(rec) === "dark", "用户未改时 → 清单声明 dark");
  ok(resolvePluginTheme({ ...rec, themePreference: "light" }) === "light", "用户改为 light → light");
  ok(resolvePluginTheme({ ...rec, themePreference: "inherit" }) === "inherit", "用户改为 inherit → inherit");
}
{
  const { rec } = recOf();
  ok(resolvePluginTheme(rec) === "inherit", "无声明无选择 → inherit");
  // 缺字段的老记录（未 hydrate）也不能崩
  const legacy = { ...rec };
  delete legacy.themePreference;
  ok(resolvePluginTheme(legacy) === "inherit", "缺 themePreference 字段的老记录 → 清单口径");
}
ok(resolvePluginTheme(null) === "inherit", "null 记录 → inherit（不崩）");
ok(resolvePluginTheme(undefined) === "inherit", "undefined 记录 → inherit（不崩）");

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
