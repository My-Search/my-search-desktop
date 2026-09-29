/**
 * 环境变量集中配置 纯逻辑测试 —— 要钉死的契约：
 *
 *   1. 变量名校验（POSIX 风格）与增删改查往返；
 *   2. `maskValue` 固定长度掩码（**不泄漏真实值的长度**）；
 *   3. `parseEnvRef` 引用语法（$NAME / ${NAME} / $env:NAME / $secret:NAME，非法不认）；
 *   4. `envGrantsOf` 只认 `env.read:<NAME>`（scope 全等、忽略其它权限）；
 *   5. **`buildPluginEnv` 只含已授权项**（核心安全断言：未授权变量绝不出现）；
 *   6. `resolveEnvRef` 对未授权/不存在的引用返回 null（调用方丢弃整键，而不是注入空串）。
 *
 * 用法: node test/env-store.test.mjs
 */
import {
  ENV_VARS_KEY,
  MASKED_VALUE,
  buildPluginEnv,
  envGrantsOf,
  envPermissionOf,
  envRefOf,
  getEnvVar,
  isValidEnvName,
  loadEnvVars,
  maskValue,
  parseEnvRef,
  removeEnvVar,
  requestedEnvRefs,
  RESERVED_ENV_PREFIX,
  isReservedEnvName,
  resolveEnvRef,
  saveEnvVars,
  upsertEnvVar,
} from "../src/lib/plugins/env-store.ts";
import { describeManifestErrors, parsePluginManifest } from "../src/lib/plugins/manifest.ts";
import { isKnownPermission, permissionCovers } from "../src/lib/plugins/permissions.ts";

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

/** 内存版 localStorage（与其它纯逻辑测试同款兜底） */
function installMemoryStorage() {
  const map = new Map();
  globalThis.localStorage = {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
  return map;
}

// ===================== 1. 变量名校验 =====================
ok(isValidEnvName("MY_KEY"), "合法名 MY_KEY");
ok(isValidEnvName("_a1"), "合法名 _a1");
ok(!isValidEnvName("1ABC"), "非法名：数字开头");
ok(!isValidEnvName("MY-KEY"), "非法名：含连字符");
ok(!isValidEnvName("MY KEY"), "非法名：含空格");
ok(!isValidEnvName(""), "非法名：空串");
ok(!isValidEnvName(null), "非法名：null");

// 宿主保留名：spawn 时宿主自己会设 MS_PLUGIN_*，用户建同名变量永远不会生效，
// 因此「不合法」而不是「合法但不生效」——避免静默失效。
ok(isReservedEnvName("MS_PLUGIN_ID"), "保留名识别：MS_PLUGIN_ID");
ok(isReservedEnvName("MS_PLUGIN_PROTOCOL"), "保留名识别：MS_PLUGIN_PROTOCOL");
ok(!isReservedEnvName("MS_PLUGIN"), "无下划线的 MS_PLUGIN 不算保留名");
ok(!isReservedEnvName("MY_MS_PLUGIN_X"), "前缀不在开头不算保留名");
ok(!isValidEnvName("MS_PLUGIN_ID"), "★ 保留名不可创建（MS_PLUGIN_ID）");
ok(!isValidEnvName("MS_PLUGIN_DATA_DIR"), "★ 保留名不可创建（MS_PLUGIN_DATA_DIR）");
ok(RESERVED_ENV_PREFIX === "MS_PLUGIN_", "保留前缀常量");

// ===================== 2. 掩码不泄漏长度 =====================
ok(maskValue("x") === MASKED_VALUE, "掩码：短值");
ok(maskValue("a-much-longer-secret-value") === MASKED_VALUE, "掩码：长值与短值同形");
ok(maskValue("x") === maskValue("a-much-longer-secret-value"), "掩码：不同长度输出完全一致");
ok(maskValue("") === "（空）", "掩码：空值单独文案");

// ===================== 3. 引用语法 =====================
ok(parseEnvRef("$MY_KEY") === "MY_KEY", "引用 $NAME");
ok(parseEnvRef("${MY_KEY}") === "MY_KEY", "引用 ${NAME}");
ok(parseEnvRef("$env:MY_KEY") === "MY_KEY", "引用 $env:NAME");
ok(parseEnvRef("$secret:MY_KEY") === "MY_KEY", "引用 $secret:NAME（兼容旧注释）");
ok(parseEnvRef("  $MY_KEY  ") === "MY_KEY", "引用可含首尾空白");
ok(parseEnvRef("sk-literal-123") === null, "字面量不是引用");
ok(parseEnvRef("$9BAD") === null, "非法引用名不认");
ok(parseEnvRef("${A}${B}") === null, "多段拼接不认（值必须整体是一个引用）");
ok(parseEnvRef(null) === null, "null 不是引用");
ok(envRefOf("MY_KEY") === "$MY_KEY", "envRefOf 生成 $NAME");

// ===================== 4. 授权解析 =====================
const grants = [
  { permission: "env.read:MY_KEY" },
  { permission: "store" },
  { permission: "env.read:OTHER" },
  { permission: "net.fetch:https://a.com/*" },
];
const gset = envGrantsOf({ grants });
ok(gset.has("MY_KEY") && gset.has("OTHER"), "envGrantsOf 取到 env.read 的 scope");
ok(!gset.has("store"), "envGrantsOf 忽略非 env.read 权限");
ok(envGrantsOf({ grants: [] }).size === 0, "无授予时为空集");
ok(envGrantsOf(null).size === 0, "record 为 null 时为空集");
ok(envPermissionOf("MY_KEY") === "env.read:MY_KEY", "envPermissionOf 生成权限串");
ok(isKnownPermission("env.read:MY_KEY"), "env.read:<NAME> 是宿主认识的权限");
ok(!isKnownPermission("env.read"), "env.read 必填 scope，缺 scope 不合法");
ok(permissionCovers("env.read:MY_KEY", "env.read:MY_KEY"), "同 scope 权限自我覆盖");
ok(!permissionCovers("env.read:MY_KEY", "env.read:OTHER"), "非 URL scope 只认全等（不误覆盖）");
ok(!permissionCovers("env.read:MY_KEY", "env.read:my_key"), "变量名大小写敏感");

// ===================== 5/6. 存储往返 + 注入过滤（安全核心） =====================
installMemoryStorage();

ok(loadEnvVars().length === 0, "初始为空");

upsertEnvVar({ name: "MY_KEY", value: "sk-secret", description: "主密钥" });
upsertEnvVar({ name: "OTHER", value: "v2", secret: false });
upsertEnvVar({ name: "THIRD", value: "v3" });
ok(loadEnvVars().length === 3, "新增三项");
ok(getEnvVar("MY_KEY")?.value === "sk-secret", "读回值");
ok(getEnvVar("OTHER")?.secret === false, "secret 标记往返");

// 重名 = 更新而非新增
upsertEnvVar({ name: "MY_KEY", value: "sk-rotated" });
ok(loadEnvVars().length === 3, "同名是更新不是新增");
ok(getEnvVar("MY_KEY")?.value === "sk-rotated", "更新后的值");
ok((getEnvVar("MY_KEY")?.createdAt ?? 0) > 0, "createdAt 保留");

// 非法名不写入
const before = loadEnvVars().length;
upsertEnvVar({ name: "BAD NAME", value: "x" });
ok(loadEnvVars().length === before, "非法名不写入");

const recAll = { grants: [{ permission: "env.read:MY_KEY" }, { permission: "env.read:OTHER" }, { permission: "env.read:THIRD" }] };
const full = buildPluginEnv(recAll);
ok(full.MY_KEY === "sk-rotated" && full.OTHER === "v2" && full.THIRD === "v3", "全部授权 → 全部注入", JSON.stringify(full));

// ★ 核心安全断言：只授权 MY_KEY 时，其它变量一个都不许出现
const recOne = { grants: [{ permission: "env.read:MY_KEY" }] };
const one = buildPluginEnv(recOne);
ok(Object.keys(one).length === 1, "只授权 1 个 → 只注入 1 个", JSON.stringify(one));
ok(one.MY_KEY === "sk-rotated", "已授权的注入正确");
ok(!("OTHER" in one) && !("THIRD" in one), "★ 未授权变量不出现在注入结果里");

// 完全无授权
ok(Object.keys(buildPluginEnv({ grants: [] })).length === 0, "★ 无授权 → 空注入");
ok(Object.keys(buildPluginEnv(null)).length === 0, "★ record 为空 → 空注入");

// 授权的变量被用户删除后，不再注入
removeEnvVar("THIRD");
ok(!("THIRD" in buildPluginEnv(recAll)), "已删除的变量不再注入");
ok(loadEnvVars().length === 2, "删除生效");

// 清单 backend.env：字面量原样、引用受授权约束、未授权整键丢弃
const recManifest = {
  grants: [{ permission: "env.read:MY_KEY" }],
  manifest: { backend: { env: { LITERAL: "plain-value", REF_OK: "$MY_KEY", REF_DENIED: "$OTHER", REF_MISSING: "$NOPE" } } },
};
const withManifest = buildPluginEnv(recManifest);
ok(withManifest.LITERAL === "plain-value", "清单字面量原样注入");
ok(withManifest.REF_OK === "sk-rotated", "清单引用已授权 → 解析为值");
ok(!("REF_DENIED" in withManifest), "★ 清单引用未授权 → 整键丢弃（不注入空串）");
ok(!("REF_MISSING" in withManifest), "清单引用不存在的变量 → 整键丢弃");
ok(!("THIRD" in withManifest), "★ 未授权的存储变量不因清单存在而泄漏");

// 同名字面量与已授权变量：变量存储优先（授权后按变量名注入会覆盖）
const recShadow = {
  grants: [{ permission: "env.read:MY_KEY" }],
  manifest: { backend: { env: { MY_KEY: "$MY_KEY" } } },
};
ok(buildPluginEnv(recShadow).MY_KEY === "sk-rotated", "引用自身解析后与存储变量一致");

// requestedEnvRefs：面板显示「待授权」
ok(
  JSON.stringify(requestedEnvRefs(recManifest)) === JSON.stringify(["MY_KEY", "NOPE", "OTHER"]),
  "requestedEnvRefs 提取引用名（含未定义的）",
  JSON.stringify(requestedEnvRefs(recManifest))
);
ok(requestedEnvRefs({ manifest: { backend: {} } }).length === 0, "无 env 声明 → 空");
ok(requestedEnvRefs(null).length === 0, "null → 空");

// resolveEnvRef 直测
const lookup = (n) => (n === "MY_KEY" ? { name: "MY_KEY", value: "sk-rotated" } : undefined);
ok(resolveEnvRef("plain", new Set(), lookup) === "plain", "resolveEnvRef 非引用原样返回");
ok(resolveEnvRef("$MY_KEY", new Set(["MY_KEY"]), lookup) === "sk-rotated", "resolveEnvRef 已授权 → 值");
ok(resolveEnvRef("$MY_KEY", new Set(), lookup) === null, "resolveEnvRef 未授权 → null");
ok(resolveEnvRef("$NOPE", new Set(["NOPE"]), lookup) === null, "resolveEnvRef 引用不存在 → null");

// saveEnvVars 去重与清洗
const saved = saveEnvVars([
  { name: "A", value: "1" },
  { name: "A", value: "2" },
  { name: "bad name", value: "3" },
  { name: "B", value: "4" },
]);
ok(saved.length === 2, "saveEnvVars 去重 + 丢非法项", JSON.stringify(saved.map((v) => v.name)));
ok(ENV_VARS_KEY === "ENV_VARS_CACHE_KEY", "存储键常量未变");

// 保留名同样不能落盘（upsert / saveEnvVars 两道都拦住）
const beforeReserved = loadEnvVars().length;
upsertEnvVar({ name: "MS_PLUGIN_ID", value: "spoofed" });
ok(loadEnvVars().length === beforeReserved, "★ 保留名不写入存储");
saveEnvVars([{ name: "MS_PLUGIN_ID", value: "x" }, { name: "OK_NAME", value: "y" }]);
ok(!loadEnvVars().some((v) => v.name === "MS_PLUGIN_ID"), "★ 保留名不随 saveEnvVars 落盘");

// ===================== 7. 清单 backend.env 校验 =====================
/** 造一份最小合法清单 */
const manifestWithEnv = (env) => JSON.stringify({
  id: "com.test.env",
  name: "环境变量插件",
  version: "1.0.0",
  apiVersion: 1,
  permissions: ["backend.spawn", "env.read:MY_KEY"],
  backend: { entry: "backend/run.cmd", env },
});

const okManifest = parsePluginManifest(
  manifestWithEnv({ LOG_LEVEL: "debug", MY_KEY: "$MY_KEY" }),
  () => true
);
ok(okManifest.ok, "含 env 的清单可解析", JSON.stringify(okManifest.errors || []));
ok(okManifest.manifest?.backend?.env?.LOG_LEVEL === "debug", "字面量 env 原样保留");
ok(okManifest.manifest?.backend?.env?.MY_KEY === "$MY_KEY", "引用型 env 原样保留（不在清单期解析）");
ok(
  JSON.stringify(requestedEnvRefs({ manifest: okManifest.manifest })) === JSON.stringify(["MY_KEY"]),
  "requestedEnvRefs 从真实清单里提取引用名"
);

const reservedManifest = parsePluginManifest(
  manifestWithEnv({ MS_PLUGIN_ID: "spoofed" }),
  () => true
);
ok(!reservedManifest.ok, "★ 清单声明 MS_PLUGIN_* 被拒绝");
ok(
  (reservedManifest.errors || []).includes("backend.env.key.reserved:MS_PLUGIN_ID"),
  "错误码为 backend.env.key.reserved",
  JSON.stringify(reservedManifest.errors)
);
ok(
  describeManifestErrors(reservedManifest.errors || []).some((t) => t.includes("MS_PLUGIN_")),
  "错误文案点明保留前缀",
  JSON.stringify(describeManifestErrors(reservedManifest.errors || []))
);

const badKeyManifest = parsePluginManifest(manifestWithEnv({ "BAD KEY": "x" }), () => true);
ok(
  !badKeyManifest.ok && (badKeyManifest.errors || []).includes("backend.env.key.invalid:BAD KEY"),
  "非法变量名仍走 backend.env.key.invalid",
  JSON.stringify(badKeyManifest.errors)
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
