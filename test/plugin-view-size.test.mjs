/**
 * 插件视图窗口尺寸（拖拽改大小 + 按插件记忆）纯逻辑测试。
 *
 * 要钉死的契约（这些判定写错了在 GUI 里要靠拖拽才发现，因此全部抽成纯函数）：
 *   1. `clampSize`：逐轴夹取；min 取「默认尺寸」（只能放大）；min 优先于 max
 *      （极小屏上默认尺寸超过上限时，宁可略超上限也不能被夹得比默认还小）；
 *   2. `centeredPosition`：水平严格居中；垂直顶部 = 剩余空间 × 22%，
 *      窗口越高越居中，窗口高于屏幕时顶部贴边（不推到屏幕外）；
 *   3. `limitsForScreen`：最大 = 宽 90% / 高 100%；屏尺寸取不到时回退默认；
 *   4. 记忆读写：按插件隔离（key 含 pluginId）、结构不合法一律当无记忆、
 *      清除后回到 null；
 *   5. `resolveViewSize`：有记忆用记忆（并 clamp），无记忆用默认（也 clamp）。
 *
 * 用法: node test/plugin-view-size.test.mjs
 */
import {
  clampSize,
  centeredPosition,
  limitsForScreen,
  resolveViewSize,
  readPluginViewSize,
  writePluginViewSize,
  clearPluginViewSize,
  TOP_RATIO,
  FULL_CENTER_RATIO,
} from "../src/lib/plugins/view-size.ts";

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

const store = installMemoryStorage();

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

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---------- 1. clampSize ---------- */
{
  const limits = { minW: 400, minH: 140, maxW: 1600, maxH: 900 };

  ok(
    eq(clampSize({ width: 800, height: 500 }, limits), { width: 800, height: 500 }),
    "区间内原样返回"
  );
  ok(
    eq(clampSize({ width: 200, height: 100 }, limits), { width: 400, height: 140 }),
    "小于 min 抬到默认尺寸（只能放大）"
  );
  ok(
    eq(clampSize({ width: 5000, height: 5000 }, limits), { width: 1600, height: 900 }),
    "超过 max 压到上限"
  );
  ok(
    eq(clampSize({ width: 500, height: 900 }, limits), { width: 500, height: 900 }),
    "单轴超限只夹该轴"
  );
  // min 优先于 max：默认尺寸本身超过上限（极小屏 + 高内容）时不被夹得更小
  const tight = { minW: 1200, minH: 700, maxW: 800, maxH: 400 };
  ok(
    eq(clampSize({ width: 2000, height: 2000 }, tight), { width: 1200, height: 700 }),
    "min 优先于 max（默认尺寸超上限时保底）"
  );
  ok(
    eq(clampSize({ width: 100, height: 100 }, tight), { width: 1200, height: 700 }),
    "min 优先时小于默认也抬到默认"
  );
}

/* ---------- 2. centeredPosition ---------- */
{
  const rect = { x: 0, y: 0, width: 1920, height: 1080 };

  // 水平严格居中：x = (1920 - w) / 2
  ok(
    eq(centeredPosition(rect, { width: 800, height: 40 }).x, Math.round((1920 - 800) / 2)),
    "水平居中（宽 800）"
  );
  // 垂直：顶部 = 剩余 × 0.22
  const small = centeredPosition(rect, { width: 800, height: 40 });
  ok(
    eq(small.y, Math.round((1080 - 40) * TOP_RATIO)),
    "垂直 = 剩余空间 × 0.22"
  );
  // 窗口越高 → 顶部越靠上（剩余越小），但仍大于等于顶边
  const mid = centeredPosition(rect, { width: 800, height: 500 });
  const big = centeredPosition(rect, { width: 800, height: 1000 });
  ok(mid.y < small.y && big.y < mid.y, "窗口越高顶部越靠上（越接近居中）");
  ok(big.y > 0, "窗口变高仍不贴顶（比例保留）");

  // 窗口高于屏幕：剩余为负 → 顶部贴边（不推到屏幕上方之外）
  const over = centeredPosition(rect, { width: 800, height: 2000 });
  ok(over.y === 0, "窗口高于屏幕时顶部贴边（y=0）");

  // 多显示器：含 origin 偏移时，居中相对该屏，不丢偏移
  const second = { x: 1920, y: 0, width: 1920, height: 1080 };
  const p = centeredPosition(second, { width: 800, height: 40 });
  ok(p.x === 1920 + Math.round((1920 - 800) / 2), "副屏：x 含屏幕 origin 偏移");

  // 完全居中（FULL_CENTER_RATIO = 0.5）：上下边距相等（插件页调整过大小后用）
  const full = centeredPosition(rect, { width: 800, height: 400 }, FULL_CENTER_RATIO);
  ok(
    eq(full.y, Math.round((1080 - 400) / 2)),
    "完全居中：y = 剩余空间 / 2（上下边距相等）"
  );
  ok(full.y === Math.round(1080 / 2 - 200), "完全居中：y = (屏高 - 窗高) / 2");
  // 完全居中时高于屏幕仍贴顶
  ok(
    centeredPosition(rect, { width: 800, height: 2000 }, FULL_CENTER_RATIO).y === 0,
    "完全居中：窗口高于屏幕时贴顶（y=0）"
  );
  // 与默认 TOP_RATIO 结果不同（证明插件态与常态是两条口径）
  ok(
    centeredPosition(rect, { width: 800, height: 400 }).y !== full.y,
    "完全居中 ≠ 常态顶部 22%（两条口径确实不同）"
  );
}

/* ---------- 3. limitsForScreen ---------- */
{
  const fallback = { width: 800, height: 500 };
  const l = limitsForScreen({ width: 1920, height: 1080 }, fallback);
  ok(l.minW === 800 && l.minH === 500, "min = 默认尺寸");
  ok(l.maxW === 1920 * 0.9 && l.maxH === 1080, "max = 宽 90% / 高 100%");

  const noScreen = limitsForScreen({ width: 0, height: 0 }, fallback);
  ok(noScreen.maxW === fallback.width && noScreen.maxH === fallback.height, "屏幕尺寸取不到时回退默认");
}

/* ---------- 4. 记忆读写（按插件隔离） ---------- */
{
  store.clear();
  ok(readPluginViewSize("com.a") === null, "无记忆时返回 null");

  writePluginViewSize("com.a", { width: 1000, height: 600 });
  ok(eq(readPluginViewSize("com.a"), { width: 1000, height: 600 }), "写入后可读回");
  ok(readPluginViewSize("com.b") === null, "另一插件互不影响（隔离）");

  // 存储键确实带 pluginId
  const keys = [...store.keys()];
  ok(
    keys.some((k) => k.includes("com.a") && k.includes("viewSize")),
    "存储键含 pluginId 与 viewSize"
  );

  // 结构不合法 → 当无记忆
  store.set("my-search-desktop:PLUGIN_DATA:com.bad:viewSize", JSON.stringify({ width: "x" }));
  ok(readPluginViewSize("com.bad") === null, "宽度非数字 → 视为无记忆");
  store.set("my-search-desktop:PLUGIN_DATA:com.bad2:viewSize", JSON.stringify({ width: -5, height: 10 }));
  ok(readPluginViewSize("com.bad2") === null, "非正尺寸 → 视为无记忆");
  store.set("my-search-desktop:PLUGIN_DATA:com.bad3:viewSize", "not-json");
  ok(readPluginViewSize("com.bad3") === null, "坏 JSON → 视为无记忆");

  clearPluginViewSize("com.a");
  ok(readPluginViewSize("com.a") === null, "清除后回到 null");
}

/* ---------- 5. resolveViewSize ---------- */
{
  const limits = { minW: 400, minH: 140, maxW: 1600, maxH: 900 };
  const def = { width: 800, height: 500 };

  const withMem = resolveViewSize({ width: 1200, height: 700 }, def, limits);
  ok(eq(withMem, { width: 1200, height: 700 }), "有记忆用记忆");

  const clampedMem = resolveViewSize({ width: 5000, height: 5000 }, def, limits);
  ok(eq(clampedMem, { width: 1600, height: 900 }), "记忆值也 clamp");

  const noMem = resolveViewSize(null, def, limits);
  ok(eq(noMem, def), "无记忆用默认");

  const noMemSmall = resolveViewSize(null, { width: 100, height: 50 }, limits);
  ok(eq(noMemSmall, { width: 400, height: 140 }), "默认值过小也 clamp 到 min");
}

console.log(`\n共 ${pass + fail} 项：PASS ${pass}，FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
