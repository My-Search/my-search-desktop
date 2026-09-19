/**
 * 插件「行为默认值」纯逻辑测试 —— 关闭界面时（最小化/退出）与开机自启。
 *
 * 要钉死的契约：
 *   1. 清单侧：`backend.closeBehavior` 的取值/校验/默认值/错误文案；
 *      `autostart=always` + `closeBehavior=exit` 的组合告警。
 *   2. 记录侧：首次安装落在**插件建议值**上；升级只更新建议、绝不覆盖用户选择。
 *   3. 老记录迁移：结构里缺 `closeBehavior` 时按插件建议补齐（已有值不动）。
 *   4. 判定：`shouldStopBackendOnClose` 的三条件（有后端 / exit / 非开机自启）。
 *
 * 用法: node test/plugin-behavior.test.mjs
 */
import {
  DEFAULT_CLOSE_BEHAVIOR,
  parsePluginManifest,
  describeManifestErrors,
} from "../src/lib/plugins/manifest.ts";
import {
  behaviorSuggestionOf,
  createPluginRecord,
  defaultCloseBehaviorFrom,
  loadRegistry,
  shouldStopBackendOnClose,
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

/** 造一份最小合法清单（backend 与 permissions 必须成对出现） */
const manifestOf = (backend = {}, extra = {}) => ({
  id: "com.example.behavior",
  name: "行为测试插件",
  version: "1.0.0",
  apiVersion: 1,
  permissions: ["ui.inlay", "backend.spawn"],
  backend: { entry: "backend/app.exe", ...backend },
  ...extra,
});

const parse = (raw) => parsePluginManifest(raw, () => true);

/* ============ 1. 清单校验与默认值 ============ */
{
  const r = parse(manifestOf());
  ok(r.ok === true, "不写 closeBehavior 的清单合法");
  ok(r.ok && r.manifest.backend.closeBehavior === "minimize", "缺省落默认值 minimize", r.ok ? r.manifest.backend.closeBehavior : "-");
  ok(DEFAULT_CLOSE_BEHAVIOR === "minimize", "默认常量就是 minimize（老插件行为不变）");
}
{
  const r = parse(manifestOf({ closeBehavior: "exit" }));
  ok(r.ok && r.manifest.backend.closeBehavior === "exit", "显式声明 exit 被保留");
}
{
  const r = parse(manifestOf({ closeBehavior: "minimize" }));
  ok(r.ok && r.manifest.backend.closeBehavior === "minimize", "显式声明 minimize 被保留");
}
{
  const r = parse(manifestOf({ closeBehavior: "close" }));
  ok(r.ok === false, "非法取值被拒绝", JSON.stringify(r.ok ? r.manifest.backend.closeBehavior : r.errors));
  ok(r.ok === false && r.errors.includes("backend.closeBehavior.invalid"), "错误码为 backend.closeBehavior.invalid");
  const text = describeManifestErrors(r.errors).join("；");
  ok(text.includes("minimize") && text.includes("exit"), "错误文案点明两个合法值", text);
}
{
  // 大小写敏感：只认小写（与 autostart 一致）
  const r = parse(manifestOf({ closeBehavior: "EXIT" }));
  ok(r.ok === false, "大写 EXIT 不被接受（与 autostart 同一套严格取值）");
}

/* ============ 2. 组合告警：开机自启 + 关闭即退出 ============ */
{
  const r = parse(manifestOf({ autostart: "always", closeBehavior: "exit" }));
  ok(r.ok === true, "冲突组合不拦（用户的选择才是最终值）");
  ok(
    r.ok === true && r.warnings.includes("backend.closeBehavior.conflictsWithAlways"),
    "冲突组合给出警告码",
    JSON.stringify(r.ok ? r.warnings : [])
  );
  const text = describeManifestErrors(r.warnings).join("；");
  ok(text.includes("开机自启") && text.includes("冲突"), "告警文案说明冲突与以谁为准", text);
}
{
  const r = parse(manifestOf({ autostart: "always", closeBehavior: "minimize" }));
  ok(r.ok === true && !r.warnings.includes("backend.closeBehavior.conflictsWithAlways"), "always + minimize 不算冲突");
  const r2 = parse(manifestOf({ autostart: "on-demand", closeBehavior: "exit" }));
  ok(r2.ok === true && !r2.warnings.includes("backend.closeBehavior.conflictsWithAlways"), "on-demand + exit 不算冲突");
}
{
  // 无 backend 时字段无意义：不该凭空造出 backend（也不该报错）
  const bare = { id: "com.example.plain", name: "纯前端", version: "1.0.0", apiVersion: 1 };
  const r = parse(bare);
  ok(r.ok === true && r.manifest.backend === undefined, "无 backend 的插件不产生 backend 规格");
}

/* ============ 3. 默认解析纯函数 ============ */
ok(defaultCloseBehaviorFrom(undefined) === "minimize", "undefined → minimize");
ok(defaultCloseBehaviorFrom(null) === "minimize", "null → minimize");
ok(defaultCloseBehaviorFrom("exit") === "exit", "exit → exit");
ok(defaultCloseBehaviorFrom("minimize") === "minimize", "minimize → minimize");
ok(defaultCloseBehaviorFrom("bogus") === "minimize", "非法值兜底 minimize（防御手改注册表）");

/* ============ 4. 插件建议 ============ */
{
  const m = parse(manifestOf({ autostart: "always", closeBehavior: "exit" })).manifest;
  const s = behaviorSuggestionOf(m);
  ok(s.autoStart === "always" && s.closeBehavior === "exit", "建议值来自清单", JSON.stringify(s));
  ok(s.fromPrompt === false, "非 prompt 时 fromPrompt=false");
}
{
  const m = parse(manifestOf({ autostart: "prompt", closeBehavior: "minimize" })).manifest;
  const s = behaviorSuggestionOf(m);
  ok(s.autoStart === "on-demand" && s.fromPrompt === true, "prompt 折叠为 on-demand 且标记 fromPrompt（面板显示「由你决定」）", JSON.stringify(s));
}
{
  const bare = parse({ id: "com.example.plain", name: "纯前端", version: "1.0.0", apiVersion: 1 }).manifest;
  const s = behaviorSuggestionOf(bare);
  ok(s.autoStart === "on-demand" && s.closeBehavior === "minimize" && s.fromPrompt === false, "无 backend 也有建议（全部默认值）", JSON.stringify(s));
}
ok(behaviorSuggestionOf(null).closeBehavior === "minimize", "manifest 为空 → 建议 minimize");

/* ============ 5. 创建记录：落在建议值上 ============ */
const recOf = (backend = {}, now = 1000) =>
  createPluginRecord({
    manifest: parse(manifestOf(backend)).manifest,
    dir: "plugins/com.example.behavior",
    source: { kind: "file", ref: "x.msplugin" },
    grants: ["ui.inlay", "backend.spawn"],
    now,
  });

{
  const rec = recOf();
  ok(rec.closeBehavior === "minimize", "安装时按建议落 minimize");
  ok(rec.autoStart === "on-demand", "开机自启按建议落 on-demand");
}
{
  const rec = recOf({ closeBehavior: "exit" });
  ok(rec.closeBehavior === "exit", "插件建议 exit → 记录初始值 exit");
}
{
  const rec = recOf({ autostart: "always", closeBehavior: "exit" });
  ok(rec.closeBehavior === "exit" && rec.autoStart === "always", "冲突组合在记录层也照建议落值（执行时以开机自启为准）");
}

/* ============ 6. 升级：保留用户选择（核心契约） ============ */
{
  const reg = { version: 1, plugins: [] };
  const v1 = recOf({ closeBehavior: "minimize" });
  upsertPlugin(reg, v1);

  // 用户把两项都改掉
  reg.plugins[0].closeBehavior = "exit";
  reg.plugins[0].autoStart = "never";

  // 插件发新版，仍然建议 minimize / always
  const v2 = createPluginRecord({
    manifest: { ...parse(manifestOf({ closeBehavior: "minimize", autostart: "always" })).manifest, version: "2.0.0" },
    dir: "plugins/com.example.behavior",
    source: { kind: "file", ref: "x.msplugin" },
    grants: ["ui.inlay", "backend.spawn"],
    now: 2000,
  });
  const merged = upsertPlugin(reg, v2);

  ok(merged.closeBehavior === "exit", "升级不覆盖用户的「关闭界面时」选择", merged.closeBehavior);
  ok(merged.autoStart === "never", "升级不覆盖用户的开机自启选择", merged.autoStart);
  ok(merged.version === "2.0.0", "升级仍更新版本 / 清单", merged.version);
}
{
  // preserveUserChoices=false（重装语义）时才允许落回建议值
  const reg = { version: 1, plugins: [] };
  upsertPlugin(reg, recOf({ closeBehavior: "minimize" }));
  reg.plugins[0].closeBehavior = "exit";
  const merged = upsertPlugin(reg, recOf({ closeBehavior: "minimize" }), { preserveUserChoices: false });
  ok(merged.closeBehavior === "minimize", "preserveUserChoices=false 时采用新清单的建议值", merged.closeBehavior);
}
{
  // 老记录（没有 closeBehavior 字段）升级一次：应被补上，而不是留 undefined
  const reg = { version: 1, plugins: [] };
  const legacyRec = recOf({ closeBehavior: "exit" });
  delete legacyRec.closeBehavior;
  upsertPlugin(reg, legacyRec);
  const merged = upsertPlugin(reg, recOf({ closeBehavior: "exit" }));
  ok(merged.closeBehavior === "exit", "缺字段的老记录经 upsert 后补齐（取新清单建议）", String(merged.closeBehavior));
}

/* ============ 7. 老注册表的读时迁移（loadRegistry 的 hydrate） ============ */
{
  /** 极简 localStorage 桩（registry.ts 只用 getItem/setItem/removeItem/length/key） */
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    key: (i) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
  };

  const KEY = "my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY";
  const oldRec = recOf({ closeBehavior: "exit" });
  delete oldRec.closeBehavior; // 模拟「升级前装的记录」：结构里没有这个字段

  const keptRec = recOf({ closeBehavior: "minimize" });
  keptRec.id = "com.example.kept";
  keptRec.closeBehavior = "exit"; // 用户已改过：迁移必须原样保留

  store.set(
    KEY,
    JSON.stringify({
      version: 1,
      plugins: [
        { ...oldRec, id: "com.example.old" },
        keptRec,
      ],
    })
  );

  const loaded = loadRegistry();
  const old0 = loaded.plugins.find((p) => p.id === "com.example.old");
  const kept = loaded.plugins.find((p) => p.id === "com.example.kept");
  ok(old0?.closeBehavior === "exit", "缺字段的老记录按插件建议补齐（exit）", String(old0?.closeBehavior));
  ok(kept?.closeBehavior === "exit", "已有值原样保留（不因迁移被改写）", String(kept?.closeBehavior));

  // 无 backend 的老记录：补成默认 minimize
  store.set(
    KEY,
    JSON.stringify({ version: 1, plugins: [{ ...kept, id: "com.example.plain", manifest: {}, closeBehavior: undefined }] })
  );
  const loaded2 = loadRegistry();
  ok(loaded2.plugins[0]?.closeBehavior === "minimize", "无 backend 的老记录补成 minimize", String(loaded2.plugins[0]?.closeBehavior));

  // 结构损坏时不抛异常
  store.set(KEY, "{ not json");
  const loaded3 = loadRegistry();
  ok(Array.isArray(loaded3.plugins) && loaded3.plugins.length === 0, "损坏的注册表按空表处理（不抛异常）");

  delete globalThis.localStorage;
}

/* ============ 8. 关闭界面时是否停进程（判定矩阵） ============ */
const judge = (backend, closeBehavior, autoStart) => {
  const rec = recOf(backend);
  if (closeBehavior !== undefined) rec.closeBehavior = closeBehavior;
  if (autoStart !== undefined) rec.autoStart = autoStart;
  return shouldStopBackendOnClose(rec);
};

ok(judge({}, "exit", "on-demand") === true, "有后端 + exit + 非自启 → 关闭即停");
ok(judge({}, "exit", "never") === true, "never 也算「非自启」→ 关闭即停");
ok(judge({}, "minimize", "on-demand") === false, "minimize → 不停（交给空闲回收）");
ok(judge({}, "exit", "always") === false, "开机自启优先：exit 也不停（进程常驻）");
ok(judge({}, "minimize", "always") === false, "开机自启 + minimize → 不停");
ok(shouldStopBackendOnClose(null) === false, "记录不存在 → 不停");
ok(shouldStopBackendOnClose(undefined) === false, "记录 undefined → 不停");
{
  // 纯前端插件（无 backend）：即使字段是 exit 也不产生停止动作
  const rec = createPluginRecord({
    manifest: parse({ id: "com.example.plain", name: "纯前端", version: "1.0.0", apiVersion: 1 }).manifest,
    dir: "",
    source: { kind: "file", ref: "x" },
  });
  rec.closeBehavior = "exit";
  ok(shouldStopBackendOnClose(rec) === false, "无 backend 的插件 → 永不停进程（没东西可停）");
}
{
  // 防御：手上被手改成非法值时不动作
  const rec = recOf({ closeBehavior: "exit" });
  rec.closeBehavior = "whatever";
  ok(shouldStopBackendOnClose(rec) === false, "非法 closeBehavior → 不停（宁可留着也不误杀）");
}

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
