/**
 * 拖放落点判定的纯逻辑测试。
 *
 * 背景（要钉死的契约）：
 *   主窗口开着 Tauri 原生拖放处理器，插件页里的 HTML5 `drop` 永远不触发，
 *   宿主只能拿到「窗口坐标 + paths」。于是「这次拖入该归插件还是归搜索框
 *   附件」必须由宿主自己按落点判定——判定错了的两种表现都很显眼：
 *     - 一律归附件 → 拖到插件页面，高亮的却是上面的搜索框（本 bug）；
 *     - 一律归插件 → 拖到搜索结果列表也被插件吃掉，附件功能形同虚设。
 *
 * 同时钉住两处易错点：
 *   - 只有**前台**会话能收文件（停靠保活中的视图不该吃掉看不见的拖入）；
 *   - 物理坐标 → CSS 坐标的换算（HiDPI 不换算会整体偏移）。
 *
 * 用法: node test/drop-target.test.mjs
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import {
  SESSION_ATTR,
  resolveDropTarget,
  toCssPoint,
} from "../src/windows/search/drop-target.ts";
import { PLUGIN_SESSION_ATTR } from "../src/windows/search/plugin-channels.ts";

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

/* ---------------- 最小 DOM 桩：只要 contains() ---------------- */

/** 造一个节点；children 里的每个节点都视为它的后代 */
function node(children = []) {
  return {
    _children: children,
    contains(el) {
      if (el === this) return true;
      return this._children.some((c) => c.contains(el));
    },
  };
}

const sessionHost = node();
const pluginInner = node(); // 插件会话载体内部的某个元素
sessionHost._children.push(pluginInner);
const outside = node(); // 会话之外的落点（搜索框 / 结果列表 / 详情正文）

console.log("=== 落点归属 ===");

ok(
  resolveDropTarget(pluginInner, sessionHost) === "plugin",
  "落在前台插件会话内 → 归插件"
);
ok(
  resolveDropTarget(sessionHost, sessionHost) === "plugin",
  "落点就是会话载体本身 → 归插件（整块都算插件的）"
);
ok(
  resolveDropTarget(outside, sessionHost) === "attachments",
  "落在会话之外 → 归搜索框附件（维持原有行为）"
);

console.log("=== 没有前台会话 ===");

ok(
  resolveDropTarget(pluginInner, null) === "attachments",
  "没有前台插件会话（视图没开）→ 一律归附件"
);
ok(
  resolveDropTarget(null, sessionHost) === "attachments",
  "elementFromPoint 取不到元素（null）→ 归附件，不崩"
);
ok(
  resolveDropTarget(null, null) === "attachments",
  "两者都为 null → 归附件，不崩"
);

console.log("=== 停靠（保活）中的会话不该收文件 ===");

// 关键场景：插件 A 停靠在停车场（DOM 仍在 document 里），前台显示的是插件 B
// 或根本没有插件视图。此时传进来的 sessionEl 是**前台**会话（或 null），
// 停靠视图的载体不在其中 → 落在它上面的拖入必须归附件，否则文件会被
// 「看不见的视图」吃掉，用户看到文件凭空消失。
const parkedHost = node();
const parkedInner = node();
parkedHost._children.push(parkedInner);
ok(
  resolveDropTarget(parkedInner, sessionHost) === "attachments",
  "落在停靠会话的载体上（前台是别人）→ 归附件"
);
ok(
  resolveDropTarget(parkedInner, null) === "attachments",
  "落在停靠会话的载体上（前台无插件）→ 归附件"
);

console.log("=== 物理像素 → CSS 像素 ===");

const p1 = toCssPoint(200, 400, 1);
ok(p1.x === 200 && p1.y === 400, "scaleFactor=1 时坐标不变");

const p2 = toCssPoint(300, 600, 1.5);
ok(p2.x === 200 && p2.y === 400, "scaleFactor=1.5 时按比例缩小（HiDPI 不偏移）");

const p3 = toCssPoint(250, 500, 2);
ok(p3.x === 125 && p3.y === 250, "scaleFactor=2 时按比例缩小");

// 取不到 / 非法 scaleFactor：退化为不缩放，绝不产出 NaN 或负数
for (const bad of [0, -1, NaN, Infinity, undefined, null]) {
  const p = toCssPoint(100, 200, bad);
  ok(
    Number.isFinite(p.x) && p.x === 100 && Number.isFinite(p.y) && p.y === 200,
    `scaleFactor=${String(bad)} → 退化为不缩放（不产出 NaN/负数）`
  );
}
// 字符串数字（从 IPC 拿回来可能是字符串）也要能算
const p4 = toCssPoint(300, 600, "1.5");
ok(p4.x === 200 && p4.y === 400, "scaleFactor 为字符串 \"1.5\" 时同样正确换算");

console.log("=== 属性名与宿主保持一致 ===");

ok(
  SESSION_ATTR === PLUGIN_SESSION_ATTR,
  `SESSION_ATTR 必须等于 plugin-channels 的 PLUGIN_SESSION_ATTR（两处同步）`,
  `${SESSION_ATTR} vs ${PLUGIN_SESSION_ATTR}`
);

// 属性名是插件与宿主之间的字符串契约，写错了不会报错、只会静默失效，因此钉死字面量。
ok(
  SESSION_ATTR === "data-ms-plugin-session",
  "属性名字面量为 data-ms-plugin-session"
);

console.log("=== App.vue 已接线（防止判定函数写了却没人用）===");

const appSrc = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "windows", "search", "App.vue"),
  "utf8"
);
ok(
  /resolveDropTarget/.test(appSrc),
  "App.vue 的拖放处理里调用了 resolveDropTarget"
);
ok(
  /toCssPoint/.test(appSrc),
  "App.vue 的拖放处理里调用了 toCssPoint（做了物理→CSS 换算）"
);
ok(
  /payload[\s\S]{0,40}position|position[\s\S]{0,40}toLogical|\.position\b/.test(appSrc),
  "App.vue 读取了原生拖放 payload 的 position（落点判定才有输入）"
);

console.log("=== 定向投递必须能到达 document 上的监听器 ===");

// 插件入口脚本（github-upload 等）按契约统一在 **document** 上挂
// ms-dropped-paths 监听，与 ATTACHMENTS_CHANGED_EVENT 同样的写法。
// 但 CustomEvent 的 bubbles 默认是 false：宿主若只在会话载体上派发而不显式
// 置 bubbles: true，事件不会冒泡到 document，插件一个字节都收不到——
// 表现就是「把文件拖到插件界面上完全没反应」。这条链路此前是断的，
// 而基于桩的插件测试因为手动往 document 派发，恰好把这个 bug 掩盖掉了，
// 所以必须在这里对着宿主源码钉死。
const hostSrc = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "windows", "search", "usePluginViewHost.ts"),
  "utf8"
);
const dropFn = /function notifyPluginDrop[\s\S]*?\n  \}/.exec(hostSrc);
ok(!!dropFn, "usePluginViewHost.ts 里找得到 notifyPluginDrop");
const dropBody = dropFn ? dropFn[0] : "";
ok(
  /dispatchEvent\(\s*new CustomEvent\(DROPPED_PATHS_EVENT/.test(dropBody),
  "notifyPluginDrop 在会话载体上派发 DROPPED_PATHS_EVENT"
);
ok(
  /bubbles:\s*true/.test(dropBody),
  "派发带 bubbles: true（否则 document 上的监听器收不到）",
  dropBody.replace(/\s+/g, " ").slice(0, 120)
);

console.log("=== 投递前必须把路径登记给 Rust ===");

// 插件拿到路径后走 ms.input.readFile → Rust attachment_read，而 Rust 侧的
// 第二道校验是「路径必须落在 attachments_sync 登记的附加集合内」。拖到插件
// 界面的文件**不走**搜索框附件管线（正是 notifyPluginDrop 的设计意图：
// 不污染附件 chip），所以宿主必须在投递前补登记——否则读取被拒，插件又
// 静默吞掉错误，用户只看到「检测到 N 个拖入的文件」之后毫无动静。
ok(
  /async function notifyPluginDrop/.test(hostSrc),
  "notifyPluginDrop 是 async（登记要先于投递完成）"
);
ok(
  /syncRoots/.test(dropBody) && /await syncRoots\(/.test(dropBody),
  "投递前调用注入的 syncRoots 登记附加根"
);
// 登记必须取并集，不能覆盖：否则搜索框里已附加的内容会被这次拖入挤掉，
// 原本可读的附件突然不可读。
ok(
  /known[\s\S]{0,400}merged/.test(dropBody) && /merged\.push/.test(dropBody),
  "登记取并集（merged：保留已登记根，追加本次拖入）"
);
// 登记是异步的，期间视图可能已被关闭/顶掉，不能再投递给看不见的会话
ok(
  /frontContainer\(\) !== target/.test(dropBody),
  "登记后复核前台会话未变（视图被关掉就不再投递）"
);
// App.vue 必须真的把三个依赖接上，否则登记形同虚设
ok(
  /notifyPluginDrop\(\s*paths,\s*describePaths,\s*attachmentsSync/.test(appSrc),
  "App.vue 把 describePaths / attachmentsSync 接进了 notifyPluginDrop"
);
ok(
  /attachments\.value\.map/.test(appSrc),
  "App.vue 传入了「当前已登记根」以便取并集"
);
ok(
  /\.then\(\(delivered\)\s*=>\s*\{\s*if\s*\(!delivered\)\s*void attachByPaths\(paths\)/.test(
    appSrc.replace(/\s+/g, " ")
  ) || /if\s*\(!delivered\)\s*void attachByPaths\(paths\)/.test(appSrc),
  "投递失败时回退到附件流程（不吞文件）"
);

console.log("=== 事件 detail 必须携带 isDir（插件据此区分文件夹与文件） ===");

// 插件拿到的只有路径字符串，自己**没有能力**判定 isDir（它只能用 file.read
// 读已登记集合里的内容）。而「拖入文件夹 = 加项目 / 拖入图片 = 作附件」这类
// 分流必须靠宿主在事件里回传 isDir，否则文件夹会被当成文件静默忽略
// （pi-agent 早期实现正是如此：拖入文件夹毫无反应）。
ok(
  /entries/.test(dropBody),
  "notifyPluginDrop 计算并投递 entries（{path,isDir} 描述）"
);
ok(
  /detail:\s*\{[^}]*entries/.test(dropBody),
  "事件 detail 里带 entries（路径 + isDir）"
);
ok(
  /detail:\s*\{[^}]*paths/.test(dropBody),
  "事件 detail 仍带 paths（旧插件只读 paths，保持兼容）"
);
ok(
  /isDir:\s*false/.test(dropBody),
  "描述缺失时 entries 退化为「按文件」（不阻断投递）"
);

console.log("=== 拖拽悬停要能通知插件（原生拖放下 HTML5 dragover 不触发） ===");

// 主窗口开着 Tauri 原生拖放时，插件页的 HTML5 dragover/dragleave 永远不触发；
// 插件无法自己感知「拖拽正悬在我身上」，只能等 drop 那一刻。要画悬停高亮，
// 必须由唯一能看到原生坐标的宿主把悬停状态投递给插件（ms-drop-hover）。
ok(
  /DROP_HOVER_EVENT/.test(hostSrc) && /"ms-drop-hover"/.test(hostSrc),
  "usePluginViewHost.ts 定义了 ms-drop-hover 事件"
);
ok(
  /function notifyPluginDropHover/.test(hostSrc),
  "存在 notifyPluginDropHover（投递悬停状态）"
);
const hoverFn = /function notifyPluginDropHover[\s\S]*?\n  \}/.exec(hostSrc);
const hoverBody = hoverFn ? hoverFn[0] : "";
ok(
  /dispatchEvent\(\s*new CustomEvent\(DROP_HOVER_EVENT/.test(hoverBody),
  "notifyPluginDropHover 在会话载体上派发 DROP_HOVER_EVENT"
);
ok(
  /bubbles:\s*true/.test(hoverBody),
  "悬停事件带 bubbles: true（document 上的监听器才收得到）"
);
ok(
  /frontContainer\(\)/.test(hoverBody),
  "没前台会话时不投递（停靠中的视图不会错误高亮）"
);
// App.vue 必须在 enter/over 时把悬停元素算出来投递，在 leave/drop 时清除。
ok(
  /notifyPluginDropHover\(\s*true/.test(appSrc) && /notifyPluginDropHover\(\s*false/.test(appSrc),
  "App.vue 在拖拽进入/离开时分别投递 true / false"
);
ok(
  /elementFromPoint/.test(appSrc),
  "App.vue 用 elementFromPoint 算出悬停到的元素交给插件判定"
);

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
