/**
 * 插件视图宿主：把插件的 `detailView` 跑起来，并管理它的**生命周期**。
 *
 * 与老脚本项宿主（useScriptHost）的关系：
 *   - **老路径原样保留**：`[脚本]` 数据项怎么跑，仍由 useScriptHost 决定，本文件不接管；
 *   - 本文件只服务**插件**（`_pluginId` 标记的数据项），并把「插件」与
 *     「老脚本项」之间的互斥交给 `plugin-channels.ts`，而不是靠覆盖
 *     全局 `window.MS_SCRIPT_ENV`；
 *   - 兼容模式（清单 `compat: "ms-script-env"`）下，宿主注入一份**局部**的
 *     等价环境对象（cache / request / getSearchDB …），因此老 `view:js`
 *     代码可以零改动迁移到插件里——但拿不到全局单例，也就不会互相踩。
 *
 * ## 会话（session）与「最小化」
 *
 * 插件界面不再是「一次挂载用完就扔」：每个被打开过的插件都持有一个
 * **会话**（`PluginViewSession`），包含它自己的 DOM 载体（`ViewChannel.container`）、
 * `ms.*` API 实例、通知监听与入口信息。
 *
 * 关闭界面时按插件设置（`closeBehavior`，与面板上「关闭界面时」同一个开关）二选一：
 *   - `minimize` → **停靠**：把 DOM 载体搬进隐藏的停车场（`#ms-plugin-parking`），
 *     脚本会话、DOM 状态（滚动位置、输入草稿）、JS 内存态全部保留；
 *   - `exit`     → **卸载**：销毁 DOM、解除通知监听，并按需停止后台进程。
 *
 * 再次打开同一个插件时：会话还在且入口没变 → **恢复**（不重读文件、不重跑脚本、
 * 不重复转发子关键词）；否则按新入口重新挂载。
 *
 * 为什么必须保住 DOM 而不是「拍快照再还原」：插件里跑的是真实脚本（可能持有
 * 定时器、WebSocket、正在流式输出的请求），快照只还原得了外观，还原不了这些
 * 活着的状态；用户看到的会是「界面回来了但内容不再更新」。
 *
 * 沙箱边界（诚实说明）：
 *   - 插件视图运行在**同一个 window** 里（与老脚本项一致），Shadow DOM 与
 *     作用域 CSS 只是**约束**，不是安全边界；
 *   - 真正的边界在 `ms.*`：插件拿不到裸 Tauri IPC（宿主不给），
 *     一切能力都要过权限网关；
 *   - 需要强隔离的插件用独立窗口（`ui.window`），v1 未实现。
 */

import { ref, type Ref } from "vue";
import { md2html } from "../../lib/util.ts";
import { scopeCss } from "../../lib/util.ts";
import { openExternal } from "../../lib/tauri-bridge.ts";
import type { SearchItem } from "../../types/index.ts";
import type { PluginHostContext } from "../../lib/plugins/host.ts";
import { PluginPermissionError } from "../../lib/plugins/host.ts";
import { pluginIdOf, pluginKeywordOf } from "../../lib/plugins/plugin-items.ts";
import type { PluginRecord } from "../../lib/plugins/registry.ts";
import {
  pluginDataGet,
  pluginDataSet,
  pluginDataRemove,
  shouldStopBackendOnClose,
} from "../../lib/plugins/registry.ts";
import { decideViewClose, decideViewRestore } from "../../lib/plugins/dev-reload.ts";
import { consumePluginFrontendRestart } from "../../lib/plugins/restart.ts";
import type { ScriptEnv } from "../../lib/script-runtime.ts";
import { openViewChannel, type ViewChannel } from "./plugin-channels.ts";

/** 停车场元素 id（隐藏的容器，停靠中的插件会话都挂在这里） */
export const PLUGIN_PARKING_ID = "ms-plugin-parking";

/**
 * 插件样式的作用域前缀（与老行为一致：只作用于详情视图里的插件容器）。
 *
 * 会话载体虽然可以在停车场与详情视图之间来回搬，但样式一律按这个前缀
 * 生成：被停靠（不可见）时样式不生效不影响观感，恢复后又回到原来的
 * 作用域里，插件作者不需要知道「保活」这件事。
 */
export const PLUGIN_STYLE_PREFIX = "#text_show .plugin-view";

/** 插件视图的挂载结果 */
export interface PluginViewMount {
  ok: boolean;
  error?: string;
  /** 本次是「恢复保活会话」还是「重新挂载」（调用方与测试用来区分两条路径） */
  mode?: "restore" | "remount";
}

/** 插件视图宿主依赖的宿主能力（由 App.vue 注入） */
export interface PluginViewHostOptions {
  /** 取插件记录 */
  getRecord: (pluginId: string) => PluginRecord | undefined;
  /** 为插件创建已绑定身份的宿主 API（`ms.*`；权限网关在这里面） */
  createApi: (pluginId: string) => Record<string, unknown>;
  /** 宿主 API 上下文（权限预检与授权弹窗用） */
  hostContext: PluginHostContext;
  /** 读取插件内文本文件（入口 HTML / CSS / JS） */
  readText: (pluginId: string, relPath: string) => Promise<string>;
  /** 判断插件内某文件是否存在（可选入口的探测用） */
  fileExists?: (pluginId: string, relPath: string) => Promise<boolean>;
  /** 宿主侧类 AI 匹配搜索（兼容模式的 env.matchSearch 用） */
  matchSearch?: (keyword: string) => Promise<SearchItem[]>;
  /** 当前输入框内容（子关键词转发用） */
  getInputValue: () => string;
  /** 设置输入框内容 */
  setInputValue: (v: string) => void;
  /** 视图高度自适应 */
  fitHeight: () => void;
  /** 立即下发窗口高度（挂载完成后强制刷新，避免高度滞后） */
  flushHeight?: () => void;
  /** 视图内容区域（#text_show .plugin-view；会话载体由宿主塞进来） */
  container: Ref<HTMLElement | null>;
  /**
   * 停止某插件的后台进程（关闭界面时按插件的 `closeBehavior` 调用）。
   * 不传则视为「不支持停止」，关闭界面永不联动停进程。
   */
  stopBackend?: (pluginId: string) => void | Promise<void>;
  /** 插件入口脚本执行出错时回调（日志用） */
  onError?: (pluginId: string, message: string) => void;
}

/**
 * 一个插件的视图会话。
 *
 * 它的生命周期**不等于**「视图可见的时间」：`minimize` 的插件在界面关闭后
 * 仍然持有会话（停靠在停车场里），直到插件被禁用/卸载、被开发热重载重挂、
 * 用户把它设成「退出」后再关闭，或应用退出。
 */
interface PluginViewSession {
  pluginId: string;
  /** 挂载时的记录快照（恢复判定与进程联动用；注册表变了以注册表为准） */
  record: PluginRecord;
  /** 入口 HTML 相对路径（挂载时用的那个） */
  entry: string;
  /** 实际使用的入口脚本（null = 没有入口脚本） */
  script: string | null;
  /** 会话通道（含 DOM 载体与局部环境） */
  channel: ViewChannel;
  /** 给插件用的 `ms.*` API（恢复后继续用同一个实例） */
  api: Record<string, unknown>;
  /** 停靠前保存的滚动位置（display:none 会把滚动位置清零，必须自己记） */
  scrolls: Array<{ el: HTMLElement; top: number; left: number }>;
}

export function usePluginViewHost(opts: PluginViewHostOptions) {
  /** 当前插件 id（前台视图；停靠中的会话不算） */
  const activePluginId = ref<string | null>(null);
  /** 前台会话是否存活 */
  const sessionActive = ref(false);
  /** 最近一次错误（视图内提示） */
  const viewError = ref<string | null>(null);
  /** 待授权权限（视图内弹窗） */
  const pendingPermission = ref<string | null>(null);
  /**
   * 用户已点过「拒绝」的权限（不再弹）。
   *
   * 按插件 id 记，且**跨停靠/恢复保留**：拒绝的依据是「这个会话里用户已经表过态」，
   * 而保活（最小化）的会话还是同一个会话——关一次界面再打开就又弹一遍，是骚扰。
   * 会话被真正销毁（`release`）时随会话一起清掉。
   */
  const deniedBySession = new Map<string, Set<string>>();

  /** 全部会话：前台 + 停靠中的（键 = 插件 id） */
  const sessions = new Map<string, PluginViewSession>();

  /** 当前插件声明的关键词（子关键词转发判定用） */
  let activeKeyword: string | null = null;
  /** 用户拒绝后由外部注入的解析器（详情视图内的内联弹窗） */
  let permissionResolver: ((allowed: boolean) => void) | null = null;
  let permissionRequest: { pluginId: string; permission: string } | null = null;

  /** 子关键词处理器（插件在 view js 里通过 onSubKeyword 注册；返回值 false 表示不消费） */
  const subKeywordHandlers = new Map<string, (message: string) => unknown>();

  /* ==================== 停车场（停靠中的会话放这里） ==================== */

  /**
   * 取停车场元素；不存在则创建（挂在 #ms-app 下，display:none）。
   *
   * 为什么放在 #ms-app 而不是 #text_show 里：停靠的意义就是「脱离详情视图」，
   * 详情视图的 DOM 由 Vue 按 v-if 增删（切到简述内容时 `.plugin-view` 会被
   * 整个移除），会话载体必须待在 Vue 管不到的地方才不会被顺手删掉。
   */
  function parkingLot(): HTMLElement {
    let el = document.getElementById(PLUGIN_PARKING_ID);
    if (el) return el;
    el = document.createElement("div");
    el.id = PLUGIN_PARKING_ID;
    // display:none 而不是 visibility:hidden：停靠期间既不占位也不参与布局，
    // 但 DOM 与 JS 状态都活着（样式表也照旧生效，只是没有可见内容）。
    el.style.display = "none";
    (document.getElementById("ms-app") ?? document.body).appendChild(el);
    return el;
  }

  /** 把会话载体的 DOM 停靠到停车场（不销毁任何东西） */
  function detachToParking(session: PluginViewSession): void {
    parkingLot().appendChild(session.channel.container);
  }

  /* ==================== 滚动位置：保存 / 还原 ==================== */

  /**
   * 记录容器内所有「滚动过」的元素的位置。
   *
   * 必须在**可见状态下**读取：元素一旦落进 display:none 的子树，浏览器会
   * 把 scrollTop 归零（真实 Chrome 上已核实），因此这一步要抢在停靠之前。
   */
  function captureScrolls(container: HTMLElement): PluginViewSession["scrolls"] {
    const out: PluginViewSession["scrolls"] = [];
    const collect = (el: Element): void => {
      const node = el as HTMLElement;
      if (node.scrollTop > 0 || node.scrollLeft > 0) {
        out.push({ el: node, top: node.scrollTop, left: node.scrollLeft });
      }
    };
    collect(container);
    container.querySelectorAll("*").forEach(collect);
    return out;
  }

  /** 还原滚动位置（容器重新可见之后再调用） */
  function restoreScrolls(scrolls: PluginViewSession["scrolls"]): void {
    const apply = (): void => {
      for (const s of scrolls) {
        if (!s.el.isConnected) continue;
        try {
          s.el.scrollTop = s.top;
          s.el.scrollLeft = s.left;
        } catch (e) {
          /* ignore */
        }
      }
    };
    apply();
    // 再补一帧：容器刚插回文档时布局可能尚未完成，越晚设置越稳
    requestAnimationFrame(apply);
  }

  /* ==================== 会话的建立 / 停靠 / 恢复 / 卸载 ==================== */

  /** 把会话载体挂进详情视图容器（前台显示） */
  function attachToView(session: PluginViewSession): boolean {
    const host = opts.container.value;
    if (!host) return false;
    if (session.channel.container.parentElement !== host) host.appendChild(session.channel.container);
    session.channel.setActive(true);
    // 供宿主样式（如「只在显示插件视图时」的规则）区分有没有插件在前台
    host.classList.add("has-plugin-session");
    return true;
  }

  /** 恢复一个保活中的会话（不重读文件、不重跑脚本） */
  function restoreSession(session: PluginViewSession): PluginViewMount {
    sessionActive.value = true;
    activePluginId.value = session.pluginId;
    if (!attachToView(session)) {
      const error = "视图容器不存在";
      viewError.value = error;
      return { ok: false, error, mode: "restore" };
    }
    restoreScrolls(session.scrolls);
    session.scrolls = [];
    opts.fitHeight();
    opts.flushHeight?.();
    // 与「重新挂载」保持一致：输入框里若带着「父 : 子」，把子关键词交给插件
    // （用户常见路径：在结果列表里重新用「插件 : 问题」打开，期望这个问题被收到）。
    // 没有分隔符时不动作，因此不会凭空重复转发。
    pushCurrentSubKeyword();
    return { ok: true, mode: "restore" };
  }

  /** 停靠当前前台会话（最小化）：保留 DOM 与脚本状态，只搬走 */
  function parkSession(session: PluginViewSession): void {
    session.scrolls = captureScrolls(session.channel.container);
    session.channel.setActive(false);
    detachToParking(session);
    if (activePluginId.value === session.pluginId) {
      // 摘掉「有前台会话」的标记：容器已空（样式钩子不该还亮着）
      opts.container.value?.classList.remove("has-plugin-session");
      activePluginId.value = null;
      sessionActive.value = false;
      activeKeyword = null;
    }
  }

  /**
   * 彻底卸载一个会话（唯一出口）。
   *
   * 顺序有意为之：先解除通知监听（插件可能正流式输出，留着回调会往已经
   * 不属于任何人的 DOM 里写）→ 再 dispose 通道（连同 DOM 载体一起删除）
   * → 最后按插件的关闭行为联动后台进程。卸载是幂等的：没有会话时静默返回。
   */
  function release(
    pluginId: string,
    reason = "",
    choice: { stopBackend?: boolean } = {}
  ): boolean {
    const session = sessions.get(pluginId);
    if (!session) return false;
    sessions.delete(pluginId);
    // 0) 会话若还在详情视图里，先摘掉「有前台会话」的标记
    const viewHost = opts.container.value;
    if (viewHost && session.channel.container.parentElement === viewHost) {
      viewHost.classList.remove("has-plugin-session");
    }
    // 1) 通知监听（后端流式响应等）——必须在 DOM 消失前解除
    try {
      const backend = session.api?.backend as Record<string, unknown> | undefined;
      if (backend && typeof backend._clearNotifications === "function") {
        (backend._clearNotifications as () => void)();
      }
    } catch (e) {
      /* ignore */
    }
    // 2) 会话通道：连同 DOM 载体一起从文档里删除
    try {
      session.channel.dispose();
    } catch (e) {
      /* ignore */
    }
    // 3) 「关闭界面时」的后台进程联动（判定是纯函数；失败不影响卸载）
    //    重启语义下不联动：后端刚被设置窗口重启过，这里只丢前端会话。
    const rec = opts.getRecord(pluginId) ?? session.record;
    if (choice.stopBackend !== false && shouldStopBackendOnClose(rec)) {
      void opts.stopBackend?.(pluginId);
    }
    // 4) 若卸载的是前台会话，清掉前台状态
    if (activePluginId.value === pluginId) {
      activePluginId.value = null;
      sessionActive.value = false;
      activeKeyword = null;
      viewError.value = null;
      pendingPermission.value = null;
      resolvePermission(false);
    }
    // 会话被真正销毁：连同「本会话内已拒绝的权限」一起忘掉
    deniedBySession.delete(pluginId);
    console.info(`[插件] 会话已卸载（${pluginId}）${reason ? "：" + reason : ""}`);
    return true;
  }

  /**
   * 处置当前前台会话：按插件设置停靠（最小化）或卸载（退出）。
   *
   * 这是「关闭插件界面」的唯一入口——Esc / 开始新搜索 / 点开别的结果 /
   * 打开别的插件，最终都落到这里，因此「关闭行为」只有一份实现。
   *
   * @param force 强制卸载（不看插件设置）：插件被顶掉、被禁用/卸载、热重载、退出应用
   */
  function settleActive(force = false, reason = ""): "park" | "unmount" | null {
    const id = activePluginId.value;
    if (!id) return null;
    const session = sessions.get(id);
    if (!session) {
      activePluginId.value = null;
      sessionActive.value = false;
      activeKeyword = null;
      return null;
    }
    const decision = decideViewClose({
      record: opts.getRecord(id) ?? session.record,
      hasSession: true,
      force,
      forceReason: reason,
    });
    if (decision.action === "park") parkSession(session);
    else release(id, reason || decision.reason);
    return decision.action;
  }

  /**
   * 关闭当前插件视图（等价老脚本的 clearScriptSession）。
   *
   * 注意「关闭」不等于「销毁」：`minimize` 的插件由 `settleActive` 停靠到后台，
   * 会话（含它记下的「已拒绝权限」）原样保留；只有 `exit` 或强制卸载才会走 `release`。
   */
  function clear(): void {
    settleActive();
    sessionActive.value = false;
    activePluginId.value = null;
    activeKeyword = null;
    viewError.value = null;
    pendingPermission.value = null;
    resolvePermission(false);
  }

  /**
   * 打开插件视图。
   *
   * @param item 插件贡献的数据项（带 _pluginId）
   * @returns 是否成功打开（`mode` 区分「恢复保活会话」与「重新挂载」）
   */
  async function open(item: SearchItem): Promise<PluginViewMount> {
    const pluginId = pluginIdOf(item);
    if (!pluginId) return { ok: false, error: "不是插件数据项" };
    const record = opts.getRecord(pluginId);
    if (!record) return { ok: false, error: "插件不存在（可能已卸载）" };
    if (!record.enabled) return { ok: false, error: "插件已禁用" };

    const detail = record.manifest.contributes?.detailView;
    if (!detail) {
      return { ok: false, error: "该插件没有提供界面（detailView）" };
    }

    // 上一个插件视图先收掉：前台一次只显示一个插件。
    // 走 `settleActive`（而不是强制卸载）是有意的——被顶掉的那个插件同样受
    // 「关闭界面时」设置支配：最小化的照样停到后台保活，退出的按既有规则
    // 卸载并（可能）停掉后台进程。这与「点开别的结果」路径完全一致。
    settleActive(false, "被另一个插件视图顶掉（前台只显示一个插件）");

    activePluginId.value = pluginId;
    activeKeyword = pluginKeywordOf(item);
    viewError.value = null;
    pendingPermission.value = null;

    // ---- 权限预检：ui.inlay ----
    if (!hasPerm(record, "ui.inlay")) {
      const allowed = await requestPermission(pluginId, "ui.inlay");
      if (!allowed) {
        viewError.value = "未授予「内嵌界面」权限，无法打开插件界面";
        // 没打开成功就别留着「前台是它」的状态：否则之后 clear()/settleActive
        // 会把这个**不存在的**会话当成真的去处置（虽然后面有兜底，但状态不干净）。
        // 已经保活着的旧会话不受影响（它本来就不在前台）。
        if (!sessions.has(pluginId)) {
          activePluginId.value = null;
          sessionActive.value = false;
          activeKeyword = null;
        }
        return { ok: false, error: viewError.value };
      }
    }

    // ---- 设置里重启过这个插件？强制重新挂载 ----
    // 设置窗口点的「重启」会写前端重启标记：保活着的旧会话（内存里跑的是
    // 重启前的脚本/DOM）必须丢弃，下次打开 = 全新挂载，而不是恢复旧会话。
    // 只影响这一个插件，其它插件的标记不受影响。stopBackend: false —— 后端
    // 刚在设置窗口里重启过（stop + spawn），这里只丢前端，别再把它停了。
    if (consumePluginFrontendRestart(pluginId)) {
      if (sessions.has(pluginId)) {
        release(pluginId, "设置中重启了插件：前端会话已释放，本次重新挂载", { stopBackend: false });
      }
    }

    // ---- 恢复保活中的会话？（入口未变才恢复） ----
    const existing = sessions.get(pluginId);
    const decision = decideViewRestore({
      hasSession: !!existing && existing.channel.alive,
      recordUsable: true,
      entry: detail.entry,
      script: detail.script ?? null,
      sessionEntry: existing?.entry ?? null,
      sessionScript: existing?.script ?? null,
    });
    if (existing && decision.action === "restore") {
      return restoreSession(existing);
    }
    // 入口变了（或残留的半死会话）：先清掉再重新挂载
    if (existing) release(pluginId, decision.reason);

    sessionActive.value = true;
    try {
      await mountSession(record, detail.entry, detail.script);
      opts.fitHeight();
      opts.flushHeight?.();
      return { ok: true, mode: "remount" };
    } catch (e) {
      const message = String((e as Error)?.message ?? e);
      viewError.value = message;
      opts.onError?.(pluginId, message);
      console.warn("[插件] 视图挂载失败:", e);
      return { ok: false, error: message };
    }
  }

  /**
   * 真正把插件的 HTML/CSS/JS 挂进**新的会话载体**。
   *
   * 入口 JS 的确定顺序（前一个命中就不再往后找）：
   *   1. 清单显式声明的 `detailView.script`
   *   2. 与入口 HTML 同名的 `.js`（如 `ui/detail.html` → `ui/detail.js`）
   *   3. 同目录下的 `index.js`（把「一个文件夹一个插件界面」的常见约定兜住）
   *
   * HTML 内自带的 `<script>` 会被重建后执行（innerHTML 插入的脚本不会自动跑）。
   *
   * 内容写进 `channel.container`（会话载体）而不是 Vue 管理的 `.plugin-view`：
   * 载体可以被搬进停车场、再搬回来，插件的 DOM 与状态因此全程不重建。
   */
  async function mountSession(
    record: PluginRecord,
    entry: string,
    declaredScript?: string
  ): Promise<void> {
    const host = opts.container.value;
    if (!host) throw new Error("视图容器不存在");

    // 会话通道：局部环境，退出即失效（不碰全局 window.MS_SCRIPT_ENV）
    const channel = openViewChannel(record.id, "plugin", makeCompatEnv(record, {}), (message) => {
      const handler = subKeywordHandlers.get(record.id);
      if (!handler) return false;
      try {
        return handler(message) !== false;
      } catch (e) {
        console.warn("[插件] 子关键词处理失败:", e);
        return false;
      }
    });
    const sessionHost = channel.container;
    // 先挂进文档：插件的脚本执行时常常要读布局（offsetHeight / getBoundingClientRect），
    // 脱离文档的节点量出来全是 0。
    host.appendChild(sessionHost);

    try {
      // 1) 载入入口 HTML
      const html = await opts.readText(record.id, entry);
      sessionHost.innerHTML = html;

      // 2) 重建 HTML 内自带的 <script>（innerHTML 不会执行它们）
      sessionHost.querySelectorAll("script").forEach((old) => {
        const s = document.createElement("script");
        if (old.src) s.src = old.src;
        else s.textContent = old.textContent;
        old.replaceWith(s);
      });

      // 3) 载入同目录样式（可选）：与入口同名 .css
      const cssPath = entry.replace(/\.html?$/i, ".css");
      let css = "";
      try {
        css = await opts.readText(record.id, cssPath);
      } catch (e) {
        /* 没有同名 css 属正常 */
      }
      if (css.trim() !== "") {
        // 样式挂在会话载体内部，作用域前缀仍按「详情视图里的插件容器」生成：
        // 载体被停靠（不可见）时样式不生效不影响观感，恢复后即回到原位。
        // 多插件保活时各自一份 style，作用域互不牵连。
        const style = document.createElement("style");
        style.className = "ms-plugin-style";
        style.textContent = scopeCss(css, PLUGIN_STYLE_PREFIX);
        sessionHost.prepend(style);
      }

      // 4) 确定入口 JS
      const jsPath = await resolveEntryScript(record.id, entry, declaredScript);
      const session: PluginViewSession = {
        pluginId: record.id,
        record,
        entry,
        script: jsPath,
        channel,
        api: {},
        scrolls: [],
      };

      // 5) 注入宿主 API 并执行（30ms 等 HTML 渲染，与老脚本项一致）
      if (jsPath) {
        let js = "";
        try {
          js = await opts.readText(record.id, jsPath);
        } catch (e) {
          throw new Error(`插件入口脚本读取失败（${jsPath}）：${String((e as Error)?.message ?? e)}`);
        }
        if (js.trim() !== "") {
          await new Promise((r) => setTimeout(r, 30));
          const api = opts.createApi(record.id);
          session.api = api;
          const result = runPluginEntry(js, {
            ms: api,
            env: makeCompatEnv(record, api),
            record,
            host: sessionHost,
            keyword: activeKeyword ?? "",
            inputValue: opts.getInputValue(),
            onSubKeyword: (fn) => subKeywordHandlers.set(record.id, fn),
          });
          if (!result.ok) throw new Error(result.error ?? "插件脚本运行出错");
        }
      }

      sessions.set(record.id, session);
      channel.setActive(true);
      // 自动转发一次子关键词（对齐老脚本项的挂载后自动转发；恢复路径不重复转发）
      pushCurrentSubKeyword();
    } catch (e) {
      // 半途失败：把这次开出来的通道（含 DOM）收干净，不留幽灵节点
      try {
        channel.dispose();
      } catch (e2) {
        /* ignore */
      }
      throw e;
    }
  }

  /** 依次尝试三种入口 JS 位置，返回第一个存在的相对路径 */
  async function resolveEntryScript(
    pluginId: string,
    entry: string,
    declared?: string
  ): Promise<string | null> {
    if (declared) return declared;
    const sameName = entry.replace(/\.html?$/i, ".js");
    const dir = entry.includes("/") ? entry.slice(0, entry.lastIndexOf("/") + 1) : "";
    const candidates = [sameName, `${dir}index.js`];
    const exists =
      opts.fileExists ??
      (async (id: string, rel: string) => {
        try {
          await opts.readText(id, rel);
          return true;
        } catch (e) {
          return false;
        }
      });
    for (const rel of candidates) {
      if (await exists(pluginId, rel)) return rel;
    }
    return null;
  }

  /**
   * 构造插件的局部运行环境（等价老脚本的 `MS_SCRIPT_ENV`，但只对本会话可见）。
   *
   * - `cache`：落到插件自己的命名空间（`PLUGIN_DATA:<id>:*`），与老脚本项的
   *   `script:*` 键互不干扰；
   * - `request`：走 `ms.net.fetch`，因此**受 net.fetch 权限与 scope 约束**
   *   （老脚本项的 request 无限制，插件不能继承这个特权）；
   * - 其余（getSearchDB / getSelectedText / md2html / matchSearch / data）与老脚本等价。
   */
  function makeCompatEnv(record: PluginRecord, api: Record<string, unknown>): ScriptEnv {
    const netFetch = (api.net as { fetch?: (url: string, o?: unknown) => Promise<unknown> } | undefined)?.fetch;
    return {
      event: { sendListener: [] },
      cache: {
        get: (k: string) => pluginDataGet(record.id, String(k), null),
        set: (k: string, v: unknown) => pluginDataSet(record.id, String(k), v),
        remove: (k: string) => pluginDataRemove(record.id, String(k)),
      },
      getSearchDB: () => opts.hostContext.searchData().map((it) => ({ ...it })),
      getSelectedText: (msg?: string) => opts.hostContext.getSelectedText(msg),
      md2html: (raw: unknown) => md2html(raw),
      request: async (type?: string, url?: string, o?: Record<string, unknown>) => {
        if (!netFetch) throw new Error("网络能力不可用");
        // 老脚本的 request 支持 { query, body, headers }，这里拼成 ms.net.fetch 的形态
        let target = String(url ?? "");
        const query = (o?.query ?? null) as Record<string, string> | null;
        if (query && Object.keys(query).length > 0) {
          target += (target.includes("?") ? "&" : "?") + new URLSearchParams(query).toString();
        }
        const rawBody = o?.body;
        const resp = (await netFetch(target, {
          method: String(type ?? "GET").toUpperCase(),
          headers: { ...((o?.header as Record<string, string>) ?? {}), ...((o?.headers as Record<string, string>) ?? {}) },
          body: rawBody == null ? undefined : typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody),
        })) as { text?: string } | string;
        return typeof resp === "string" ? resp : String(resp?.text ?? "");
      },
      matchSearch: (kw: string) => opts.matchSearch?.(String(kw)) ?? Promise.resolve([]),
      data: {
        get: () => opts.hostContext.searchData().map((it) => ({ ...it })),
        matchSearch: () => [],
        distinct: (items: SearchItem[]) => {
          const seen = new Set<string>();
          return items.filter((it) => {
            const key = `${it?.title ?? ""}\u0001${it?.desc ?? ""}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        },
      },
    };
  }

  /** 把当前输入框里的「父 : 子」推给插件（挂载后自动 / 回车时） */
  function pushCurrentSubKeyword(): boolean {
    const id = activePluginId.value;
    if (!id || !sessionActive.value) return false;
    const raw = opts.getInputValue();
    const parts = String(raw ?? "").split(" : ");
    if (parts.length < 2) return false;
    const message = (parts[1] ?? "").trim();
    const handler = subKeywordHandlers.get(id);
    if (!handler) return false;
    try {
      handler(message);
    } catch (e) {
      console.warn("[插件] 子关键词转发失败:", e);
    }
    return true;
  }

  /** 回车时调用：把子关键词推给插件，并返回处理后的输入框内容 */
  function tryRunTextViewHandler(rawKeyword: string): { handled: boolean; nextKeyword: string } {
    const id = activePluginId.value;
    if (!id || !sessionActive.value) return { handled: false, nextKeyword: rawKeyword };
    const boundary = " : ";
    const parts = String(rawKeyword ?? "").split(boundary);
    if (parts.length < 2) return { handled: false, nextKeyword: rawKeyword };
    const message = (parts[1] ?? "").trim();
    const handler = subKeywordHandlers.get(id);
    if (!handler) return { handled: false, nextKeyword: rawKeyword };
    try {
      handler(message);
    } catch (e) {
      console.warn("[插件] 子关键词转发失败:", e);
    }
    // 保留「父关键词 : 」便于连续追问（与老脚本项行为一致）
    const nextKeyword = message === "" ? rawKeyword : String(rawKeyword).replace(message, "");
    return { handled: true, nextKeyword };
  }

  /** 注册/清理子关键词处理器 */
  function setSubKeywordHandler(pluginId: string, fn: ((m: string) => unknown) | null): void {
    if (fn) subKeywordHandlers.set(pluginId, fn);
    else subKeywordHandlers.delete(pluginId);
  }

  /* ---------------- 权限内联弹窗 ---------------- */

  /** 是否已授予权限（按基础 id 比较：ui.inlay 这类无 scope 权限足够） */
  function hasPerm(record: PluginRecord, permission: string): boolean {
    const base = permission.split(":")[0];
    return record.grants.some((g) => g.permission.split(":")[0] === base);
  }

  /** 该插件在当前会话里被拒绝过的权限集合（没有则现建一个） */
  function deniedSetOf(pluginId: string): Set<string> {
    let set = deniedBySession.get(pluginId);
    if (!set) {
      set = new Set<string>();
      deniedBySession.set(pluginId, set);
    }
    return set;
  }

  /** 请求权限：优先交给宿主注入的处理器，否则走视图内弹窗 */
  async function requestPermission(pluginId: string, permission: string): Promise<boolean> {
    const denied = deniedBySession.get(pluginId);
    if (denied?.has(permission)) return false;
    const record = opts.getRecord(pluginId);
    if (!record) return false;
    if (hasPerm(record, permission)) return true;
    if (opts.hostContext.requestPermission) {
      const allowed = await opts.hostContext.requestPermission(pluginId, permission);
      if (!allowed) deniedSetOf(pluginId).add(permission);
      return allowed;
    }
    pendingPermission.value = permission;
    permissionRequest = { pluginId, permission };
    return await new Promise<boolean>((resolve) => {
      permissionResolver = (allowed) => {
        if (!allowed) deniedSetOf(pluginId).add(permission);
        resolve(allowed);
      };
    });
  }

  /** 视图内弹窗的按钮回调 */
  function resolvePermission(allowed: boolean): void {
    const resolver = permissionResolver;
    permissionResolver = null;
    permissionRequest = null;
    if (resolver) resolver(allowed);
  }

  /** 供模板展示：当前待授权权限的可读信息 */
  function pendingPermissionInfo(): { pluginId: string; permission: string } | null {
    return permissionRequest;
  }

  /** 是否有活跃的前台会话 */
  function isActive(): boolean {
    return sessionActive.value && activePluginId.value != null;
  }

  /* ---------------- 会话管理（供宿主清理用） ---------------- */

  /** 当前保活（停靠中）的插件 id 列表 */
  function keepAliveIds(): string[] {
    const ids: string[] = [];
    for (const [id, session] of sessions) {
      if (id !== activePluginId.value && session.channel.alive) ids.push(id);
    }
    return ids;
  }

  /** 会话总数（前台 + 停靠；调试与测试用） */
  function sessionCount(): number {
    return sessions.size;
  }

  /** 某插件当前是否有会话（前台或停靠；调试与测试用） */
  function hasSession(pluginId: string): boolean {
    return sessions.has(pluginId);
  }

  /** 会话是否停靠在停车场（调试与测试用） */
  function isParked(pluginId: string): boolean {
    const session = sessions.get(pluginId);
    if (!session) return false;
    return session.channel.container.parentElement?.id === PLUGIN_PARKING_ID;
  }

  /**
   * 强制卸载全部会话（插件被禁用/卸载、开发热重载、应用退出时调用）。
   *
   * 与 `clear()` 的区别：`clear()` 是「用户关掉了插件界面」（按插件设置保活或卸载），
   * 这里是「会话不该再存在」（对象都失效了，保活就是错的）。
   */
  function disposeAll(reason = ""): number {
    let n = 0;
    for (const id of [...sessions.keys()]) {
      if (release(id, reason)) n++;
    }
    sessionActive.value = false;
    activePluginId.value = null;
    activeKeyword = null;
    return n;
  }

  /**
   * 清理「已经不该存在」的会话：注册表里被禁用/卸载的插件。
   *
   * 设置窗口可以在另一个 WebView 里禁用/卸载插件，搜索窗口在获得焦点时
   * 才发现注册表变了——此时若不做这一步，保活的会话会一直留在停车场，
   * 用户下次打开还会看到「已被卸载的插件界面」。
   */
  function reapSessions(): number {
    let n = 0;
    for (const id of [...sessions.keys()]) {
      const rec = opts.getRecord(id);
      if (!rec || !rec.enabled) {
        if (release(id, rec ? "插件已禁用" : "插件已卸载")) n++;
      }
    }
    return n;
  }

  return {
    activePluginId,
    sessionActive,
    viewError,
    pendingPermission,
    open,
    clear,
    isActive,
    pushCurrentSubKeyword,
    tryRunTextViewHandler,
    setSubKeywordHandler,
    resolvePermission,
    pendingPermissionInfo,
    hasPerm,
    // 会话管理（保活 / 卸载）
    release,
    disposeAll,
    reapSessions,
    keepAliveIds,
    sessionCount,
    hasSession,
    isParked,
  };
}

export type PluginViewHostApi = ReturnType<typeof usePluginViewHost>;

/* ============================================================
 * 插件入口脚本的执行
 * ============================================================ */

/**
 * 执行插件入口 JS。
 *
 * 执行模型（面向插件作者的最小契约）：
 * ```js
 * // index.js
 * ms.log("info", "视图已打开");
 * ms.search.query("关键词").then(rows => { … });
 * onSubKeyword(msg => { ms.ui.toast("收到：" + msg); });  // 可选：接收「父 : 子」
 * ```
 *
 * 与老脚本项的差别：**没有 `new Function` 的隐式全局**——插件拿到的是
 * 注入进来的具名参数（`ms` / `env` / `plugin` / `host` / `keyword` / `inputValue` /
 * `onSubKeyword` / `md2html` / `openExternal`），作用域里同时保留了
 * `window`（因为 inlay 形态不构成安全边界，假装隔离没有意义），
 * 但**没有任何裸 Tauri IPC 的封装**，要能力就得过 `ms.*`。
 *
 * 生命周期提醒（v7.9.16 起）：`closeBehavior: "minimize"`（默认）的插件在
 * 关闭界面时**不会**销毁脚本上下文，而是整体停靠到后台；再次打开时直接
 * 恢复同一个 DOM 与同一次脚本执行（本函数不会再被调用）。因此插件不应
 * 假设「关闭界面 = 重新加载」——需要持久化的状态仍应写 `ms.store` / `ms.backend`。
 */
function runPluginEntry(
  code: string,
  scope: {
    ms: Record<string, unknown>;
    env: ScriptEnv;
    record: PluginRecord;
    host: HTMLElement;
    keyword: string;
    inputValue: string;
    onSubKeyword: (fn: (msg: string) => unknown) => void;
  }
): { ok: boolean; error?: string } {
  try {
    const fn = new Function(
      "ms",
      "env",
      "plugin",
      "host",
      "keyword",
      "inputValue",
      "onSubKeyword",
      "md2html",
      "openExternal",
      "MS_SCRIPT_ENV",
      `"use strict";\n${code}\n`
    );
    fn(
      scope.ms,
      scope.env,
      {
        id: scope.record.id,
        name: scope.record.name,
        version: scope.record.version,
        dir: scope.record.dir,
        isDev: scope.record.source.dev === true,
      },
      scope.host,
      scope.keyword,
      scope.inputValue,
      scope.onSubKeyword,
      md2html,
      openExternal,
      // 兼容老脚本项：局部 env 也挂一个同名变量（不是全局单例）
      scope.env
    );
    return { ok: true };
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    // 权限不足不是「脚本错误」：交给上层走授权弹窗（这里仍返回失败，但消息可辨识）
    if (e instanceof PluginPermissionError) return { ok: false, error: `缺少权限: ${e.permission}` };
    return { ok: false, error: message };
  }
}
