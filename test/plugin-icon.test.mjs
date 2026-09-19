/**
 * 插件图标解析（`src/lib/plugins/icon.ts`）—— 纯逻辑测试。
 *
 * 覆盖设置面板「插件列表左侧 logo」与搜索窗口「结果条目图标」共用的那部分：
 *   1. MIME 映射（扩展名、查询串、未知扩展名的兜底）
 *   2. 相对路径 / data: / http(s): 三种形态的判定
 *   3. 「需要读文件的图标引用」的收集（顶层 icon + 各搜索项，去重保序）
 *   4. 面板列表用的「代表图标」取值顺序（顶层优先，退回首个搜索项）
 *
 * 用法: node test/plugin-icon.test.mjs
 */
import {
  iconDataUrl,
  iconMimeOf,
  iconRefsOf,
  isInlineIconRef,
  primaryIconRef,
} from "../src/lib/plugins/icon.ts";
import { buildPluginItems } from "../src/lib/plugins/plugin-items.ts";

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

/* ============ 1. MIME 映射 ============ */
ok(iconMimeOf("icon.png") === "image/png", "png → image/png", iconMimeOf("icon.png"));
ok(iconMimeOf("assets/logo.svg") === "image/svg+xml", "svg → image/svg+xml");
ok(iconMimeOf("a/b/LOGO.SVG") === "image/svg+xml", "扩展名大小写不敏感");
ok(iconMimeOf("icon.ico") === "image/x-icon", "ico → image/x-icon");
ok(iconMimeOf("logo.webp") === "image/webp", "webp → image/webp");
ok(iconMimeOf("icon.svg?v=2") === "image/svg+xml", "带查询串也能取到扩展名", iconMimeOf("icon.svg?v=2"));
ok(iconMimeOf("icon.png#frag") === "image/png", "带锚点也能取到扩展名");
ok(iconMimeOf("icon") === "image/png", "无扩展名退回 png", iconMimeOf("icon"));
ok(iconMimeOf("") === "image/png", "空串退回 png");

/* ============ 2. 引用形态判定 ============ */
ok(isInlineIconRef("data:image/png;base64,AAAA"), "data: 视为自带地址");
ok(isInlineIconRef("https://api.xinac.net/icon/?url=https://fanyi.baidu.com"), "https 视为自带地址");
ok(isInlineIconRef("HTTP://example.com/i.png"), "协议大小写不敏感");
ok(!isInlineIconRef("icon.svg"), "相对路径需要读文件");
ok(!isInlineIconRef("assets/logo.png"), "带目录的相对路径需要读文件");
ok(!isInlineIconRef("javascript:alert(1)"), "javascript: 不算自带地址");

/* ============ 3. data URL 拼装 ============ */
ok(
  iconDataUrl("icon.svg", "PHN2Zz48L3N2Zz4=") === "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
  "相对路径 + base64 → data URL",
  iconDataUrl("icon.svg", "PHN2Zz48L3N2Zz4=")
);

/* ============ 4. 收集「需要读文件」的引用 ============ */
const manifest = {
  id: "com.example.icons",
  name: "图标测试",
  version: "1.0.0",
  apiVersion: 1,
  icon: "assets/logo.svg",
  contributes: {
    searchItem: [
      { title: "A", keyword: "a", icon: "item-a.png" },
      { title: "B", keyword: "b", icon: "https://example.com/b.png" },
      { title: "C", keyword: "c" }, // 无条目图标 → 结果列表会退回顶层 icon
      { title: "D", keyword: "d", icon: "assets/logo.svg" }, // 与顶层重复
      { title: "E", keyword: "e", icon: "data:image/png;base64,AA" },
    ],
  },
};

ok(
  JSON.stringify(iconRefsOf(manifest)) === JSON.stringify(["assets/logo.svg", "item-a.png"]),
  "收集层：顶层 icon + 搜索项相对路径，去重且不含 data:/http(s):",
  JSON.stringify(iconRefsOf(manifest))
);
ok(
  iconRefsOf({ ...manifest, icon: undefined }).join(",") === "item-a.png,assets/logo.svg",
  "顶层无 icon 时只收搜索项的（条目 D 仍引用 assets/logo.svg）",
  iconRefsOf({ ...manifest, icon: undefined }).join(",")
);
ok(iconRefsOf({ ...manifest, icon: undefined, contributes: undefined }).length === 0, "无任何图标 → 空数组");
ok(iconRefsOf(null).length === 0, "manifest 为空 → 空数组");
ok(iconRefsOf(undefined).length === 0, "manifest undefined → 空数组");

/* ============ 5. 面板列表的「代表图标」 ============ */
ok(primaryIconRef(manifest) === "assets/logo.svg", "顶层 icon 优先");
ok(
  primaryIconRef({ ...manifest, icon: undefined }) === "item-a.png",
  "顶层无 icon → 退回首个搜索项的 icon"
);
ok(
  primaryIconRef({ ...manifest, icon: undefined, contributes: { searchItem: { title: "X", keyword: "x" } } }) === undefined,
  "都没有 → undefined（面板退回默认图标）"
);
ok(primaryIconRef(null) === undefined, "manifest 为空 → undefined");

/* ============ 6. 与搜索窗口的取值顺序互不干扰 ============ */
// buildPluginItems 是「条目 icon 优先、退回顶层 icon」；面板的 primaryIconRef 是
// 「顶层优先」——两者刻意相反，但都必须能解析到同一批引用（否则预读的缓存会漏）。
const records = [
  {
    id: manifest.id,
    name: manifest.name,
    description: "",
    enabled: true,
    manifest,
  },
];
const items = buildPluginItems(records[0], (ref) => `resolved:${ref}`);
ok(items.length === 5, "5 条搜索项都合成了", String(items.length));
ok(items[0].icon === "resolved:item-a.png", "条目自带 icon 优先", String(items[0].icon));
ok(items[2].icon === "resolved:assets/logo.svg", "条目无 icon → 退回顶层 icon", String(items[2].icon));
ok(items[1].icon === "https://example.com/b.png", "http(s): 原样直出", String(items[1].icon));
ok(items[4].icon === "data:image/png;base64,AA", "data: 原样直出", String(items[4].icon));

// 预读集合必须覆盖「搜索项会用到、且需要读文件」的全部引用（否则条目会没图标）
const preload = iconRefsOf(manifest);
for (const ref of new Set(items.map((i) => i.icon).filter((v) => typeof v === "string"))) {
  const isResolved = preload.some((p) => ref === `resolved:${p}`);
  const isInline = isInlineIconRef(ref);
  ok(isResolved || isInline, `条目图标可解析或自带地址: ${ref}`);
}

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
