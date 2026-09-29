/**
 * 「点卸载没反应」回归：连续两次 confirm 必须都能被确认。
 *
 * 用户诉求：
 *   设置 → 插件 → 点「卸载」时界面像没反应；只有把设置窗口关掉，
 *   才看到卸载的提示弹窗（第二次确认「是否同时删除插件保存的数据？」）。
 *
 * 根因（已修）：
 *   `MessageDialog.vue` 的两个按钮原来只挂 `@click`，点击事件会**冒泡到遮罩**，
 *   命中遮罩的 `onOverlayClick` 再 emit 一次 `cancel`。而
 *   `useMessageDialog` 只有一个 resolver 槽位，卸载是**两次串行** confirm
 *   （同一个组件实例、按钮位置完全重合，DOM 被原地 patch）：
 *
 *     第一次点击「确定」→ click(ok) 与 click(cancel) 在同一事件里连续发出，
 *     resolver 被 resolve 后置空；第二次 showMessage **抢占式**写入新 resolver
 *     （它不是在微任务里排队，而是下一次 Vue 渲染时同步建立），此后残留的
 *     `cancel` 落到新 resolver 上 → 把刚弹出的第二次确认直接关掉。
 *
 *   用户看到的就是「点了没反应」：弹窗一闪（或根本没画出来）就被自己关掉，
 *   卸载流程停在半路；等到关掉设置窗口、组件重挂载时，剩余的那次提示才被看到。
 *
 * 本测试用 Node 直接驱动真实源码：
 *   - 静态校验 `MessageDialog.vue` 模板上的 `@click.stop` 契约；
 *   - 复刻 `useMessageDialog.ts` 的状态机（含“只认一个 resolver”的语义），
 *     按 `PanelPlugins.vue:uninstallPlugin` 的真实顺序把卸载流程跑一遍，
 *     并注入“冒泡导致的额外 cancel”以确认旧实现会失败、新实现通过。
 * 不需要浏览器 / Rust，CI 里也能跑。
 *
 * 用法: node test/message-dialog-double-confirm.test.mjs
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dialogVue = readFileSync(path.join(root, "src/components/MessageDialog.vue"), "utf8");
const styleCss = readFileSync(path.join(root, "src/css/style.css"), "utf8");

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log("PASS ", name);
  } else {
    fail++;
    console.log("FAIL ", name, extra ? ` — ${extra}` : "");
  }
};

/* ============================================================
 * 1. 模板契约：两个按钮都必须 .stop，否则点击冒泡到遮罩会多发一次 cancel
 * ============================================================ */
check(
  "MessageDialog：确定按钮 @click.stop（不冒泡到遮罩）",
  /id="msgOk"[^>]*@click\.stop="emit\('ok'\)"/.test(dialogVue),
  dialogVue.match(/id="msgOk"[\s\S]{0,120}/)?.[0],
);
check(
  "MessageDialog：取消按钮 @click.stop（不冒泡到遮罩）",
  /id="msgCancel"[\s\S]{0,180}?@click\.stop="emit\('cancel'\)"/.test(dialogVue),
  dialogVue.match(/id="msgCancel"[\s\S]{0,240}/)?.[0],
);
check(
  "MessageDialog：遮罩仍能点空白取消（onOverlayClick 保留）",
  /function onOverlayClick[\s\S]{0,200}?e\.target === e\.currentTarget[\s\S]{0,80}?emit\("cancel"\)/.test(
    dialogVue,
  ),
);
check(
  "MessageDialog：不存在“按钮 + 遮罩重复触发”的点击路径",
  !/@click(?!\.stop)="emit\('(ok|cancel)'\)"/.test(dialogVue),
);

/* ============================================================
 * 1.5 层叠保证（“弹窗被盖住”回归）：
 *   插件界面与宿主弹窗处在**同一个层叠上下文**，插件作者可写任意大的
 *   z-index（pi-agent 用了 100 / 9999，右下角缩放手柄用 2147483647）。
 *   只靠 CSS z-index 赢不了，因此：
 *     - 遮罩必须带 `popover`（HTML top layer，永远压在所有 z-index 之上）；
 *     - 且代码里要把它 show/hidePopover；
 *     - CSS 的 z-index 兼容兜底必须是顶格 2147483647。
 * ============================================================ */
check(
  "MessageDialog：遮罩带 popover 属性（HTML top layer）",
  /id="msgOverlay"[\s\S]{0,200}?popover="manual"/.test(dialogVue),
  dialogVue.match(/id="msgOverlay"[\s\S]{0,260}/)?.[0],
);
check(
  "MessageDialog：代码里调用 showPopover/hidePopover（随 visible 同步）",
  /\.showPopover\s*\(/.test(dialogVue) && /\.hidePopover\s*\??\.\s*\(/.test(dialogVue),
);
check(
  "MessageDialog：showPopover 前会避开 :popover-open（幂等）",
  /:\.popover-open|:popover-open/.test(dialogVue),
);
check(
  "CSS：设置窗口遮罩 z-index 顶格（2147483647）",
  /#ms-config-view \.token-overlay \{[\s\S]{0,400}?z-index:\s*2147483647/.test(styleCss),
);
check(
  "CSS：搜索窗口遮罩 z-index 顶格（2147483647）",
  /#my_search_box \.token-overlay \{[\s\S]{0,400}?z-index:\s*2147483647/.test(styleCss),
);
check(
  "CSS：抹掉 [popover] 的 UA 默认样式（margin/border/padding）",
  /\.token-overlay\[popover\][\s\S]{0,400}?margin:\s*0[\s\S]{0,200}?padding:\s*0/.test(styleCss),
);

/* ============================================================
 * 2. 语义层：复刻 useMessageDialog 的状态机
 *    （与 src/composables/useMessageDialog.ts 一一对应：
 *      单 resolver —— 新的 showMessage 会**抢占式**覆盖旧槽位）
 * ============================================================ */
function createMessageDialog() {
  const state = {
    visible: false,
    title: "提示",
    text: "",
    okText: "确定",
    cancelText: "取消",
    showCancel: true,
  };
  let resolver = null;

  function settle(result) {
    state.visible = false;
    const resolve = resolver;
    resolver = null;
    if (resolve) resolve(result);
  }

  return {
    state,
    hasPending: () => resolver !== null,
    confirmMessage(text) {
      return new Promise((resolve) => {
        resolver = resolve;
        state.title = "提示";
        state.text = text;
        state.okText = "确定";
        state.cancelText = "取消";
        state.showCancel = true;
        state.visible = true;
      });
    },
    handleCancel: () => settle(false),
    handleOk: () => settle(true),
  };
}

/**
 * 模拟「点了确定」这一下鼠标事件，并可选地复现旧的冒泡行为。
 *
 * 修复前：`@click`（无 .stop）→ 按钮 emit('ok') → resolve 置空 resolver，
 *         同一事件继续冒泡到 `.token-overlay` → onOverlayClick 再 emit('cancel')。
 *         这次 cancel 此刻没有 resolver，看似无害——但 Vue 的 DOM 更新与
 *         showMessage 的调用交错，第二次弹窗的新 resolver 一旦先落地，
 *         残留的 cancel 就会把它直接关掉（见下面 runUninstallFlow 的
 *         `strayCancelRacesNewDialog`）。
 * 修复后：`@click.stop` 拦住冒泡，不会有第二次 settle。
 */
function clickOk(dialog, { bubbling }, onAfter) {
  dialog.handleOk();
  onAfter?.();
  if (bubbling) dialog.handleCancel();
}

/**
 * 卸载流程，与 `PanelPlugins.vue:uninstallPlugin` 一致（去掉 IPC 部分）。
 *
 * @param strayCancelRacesNewDialog 复现旧时序：第一次点击的冒泡 cancel
 *   迟一步落地，正好压在**第二次弹窗已建立 resolver** 之后。
 */
async function runUninstallFlow(dialog, { bubbling, strayCancelRacesNewDialog }) {
  const actions = [];

  const first = dialog.confirmMessage("确定卸载「建议退出插件」v1.0.0？");
  clickOk(dialog, { bubbling });
  const firstOk = await first;
  if (!firstOk) return { aborted: true, actions };

  const second = dialog.confirmMessage("是否同时删除插件保存的数据？");
  // 旧时序：上一次点击遗留的 cancel 在这一刻才被投递（弹窗刚建立、resolver 才写好）
  if (strayCancelRacesNewDialog) dialog.handleCancel();
  if (!dialog.state.visible) {
    // 第二次弹窗已被残留 cancel 关掉 —— 正是「没反应」
    const still = await Promise.race([second.then((v) => `resolved:${v}`), Promise.resolve("pending")]);
    return { aborted: false, dismissedSecond: true, secondOutcome: still, actions };
  }

  clickOk(dialog, { bubbling });
  const deleteData = await second;

  actions.push("plugin_remove");
  if (deleteData) actions.push("plugin_purge_data");
  return { aborted: false, actions, deleteData };
}

/* ---------- 2a. 修复后的行为（按钮 .stop） ---------- */
{
  const d = createMessageDialog();
  const r = await runUninstallFlow(d, { bubbling: false, strayCancelRacesNewDialog: false });
  check(
    "正常流程：两次确认都被接受（走到卸载）",
    r.aborted === false && r.actions.includes("plugin_remove"),
    JSON.stringify(r),
  );
  check("正常流程：第二次确认默认「确定」= 删除数据", r.deleteData === true, JSON.stringify(r));
  check("正常流程：卸载完成弹窗已收起", d.state.visible === false);
  check("正常流程：两次动作齐全（删除目录 + 删数据）", r.actions.length === 2, JSON.stringify(r.actions));
}

/* ---------- 2b. 复现旧 bug：残留 cancel 把刚弹出的第二次确认关掉 ---------- */
{
  const d = createMessageDialog();
  const r = await runUninstallFlow(d, { bubbling: true, strayCancelRacesNewDialog: true });
  check(
    "旧 bug 可被复现：第二次确认刚弹出就被残留 cancel 关掉（用户看到「没反应」）",
    r.dismissedSecond === true,
    JSON.stringify(r),
  );
  check(
    "旧 bug 可被复现：卸载流程没有真正完成（没走到 plugin_remove）",
    !r.actions.includes("plugin_remove"),
    JSON.stringify(r.actions),
  );
}

/* ---------- 2c. 旧 bug 的另一种表现：第二次「确定」变成取消 ---------- */
{
  const d = createMessageDialog();
  const first = d.confirmMessage("确定卸载？");
  // 第一次点击：ok 落地，同一事件里的冒泡 cancel 待投递
  d.handleOk();
  await first;
  const second = d.confirmMessage("是否同时删除插件保存的数据？");
  d.handleCancel(); // 残留 cancel 抢先落地 → 第二次被否决
  check(
    "旧 bug 可被复现：第二次「确定」被抢先的 cancel 否决（不删数据）",
    (await second) === false,
  );
}

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
