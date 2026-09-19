/**
 * 插件通道（channel）注册表 —— 前台视图与宿主之间的**局部**环境。
 *
 * 为什么需要它：老脚本项的 `MS_SCRIPT_ENV` 是一个挂在 `window` 上的**全局**单例。
 * 这在「一次只开一个脚本项」时恰好能用，但一旦同时存在多个视图（插件视图 +
 * 脚本项视图），后挂载的会覆盖先挂载的，`event.sendListener` 也只增不减。
 * 插件系统必须有确定性的归属判断，因此：
 *
 * - 插件视图一律走**局部**环境（视图挂载时回调闭包逐层传入，退出即失效）；
 * - **全局 `window.MS_SCRIPT_ENV` 保持原样不动**，老脚本项的行为一字不改；
 * - 需要互斥的全局状态（如「当前激活的脚本会话」）集中在这里，由宿主显式
 *   取得/释放，而不是靠覆盖 window 来隐式实现——
 *   这样即使两个视图同时存在，转发也只落到正确的那一个。
 *
 * 纯逻辑（无 Vue 依赖），便于单测。
 */

import type { ScriptEnv } from "../../lib/script-runtime.ts";

/** 会话容器的类名（停车场与详情视图两处共用同一份样式钩子） */
export const PLUGIN_SESSION_CLASS = "ms-plugin-session";

/** 每个会话的容器元素上挂的 id 属性（调试与测试用：`document.querySelector('[data-ms-plugin-session="…"]')`） */
export const PLUGIN_SESSION_ATTR = "data-ms-plugin-session";

/** 一个前台视图（插件视图或老脚本项视图）的会话 */
export interface ViewChannel {
  /** 会话 id（自增，仅用于日志与调试） */
  readonly id: number;
  /** 归属：插件 id 或 legacy 项 id */
  readonly ownerId: string;
  /** 会话类型 */
  readonly kind: "plugin" | "legacy";
  /** 该会话的局部环境（等价 MS_SCRIPT_ENV，但只对本会话可见） */
  readonly env: ScriptEnv;
  /**
   * 会话的 DOM 载体（宿主创建，插件内容全部装在里面）。
   *
   * 为什么每个会话要有一个自己的元素：插件视图可以在关闭后**保活**
   * （停靠到隐藏的停车场），恢复时要原样搬回详情视图。载体元素让「挂载 /
   * 停靠 / 恢复 / 销毁」都是对同一个节点的操作，插件 DOM 与其上的状态
   * （滚动位置、输入草稿、定时器持有的引用）全程不重建。
   *
   * 同时它也是**会话隔离**的载体：不同插件的 DOM 各自独立成树，插件的
   * `document.getElementById("x")` 即使在别的插件视图里也能稳定取到自己的
   * 节点（避免保活多个插件后会出现的同 id 撞车问题）。
   */
  readonly container: HTMLElement;
  /**
   * 把子关键词推给本会话（插件用 backend/事件处理，脚本项用 sendListener）。
   * @returns 是否已消费（消费后宿主保留「父关键词 : 」以便连续追问）
   */
  pushSubKeyword: (message: string) => boolean;
  /** 会话结束（卸载视图、插件禁用、宿主退出详情视图） */
  dispose: () => void;
  /** 是否仍然有效（dispose 后为 false） */
  readonly alive: boolean;
  /** 是否在前台（false = 保活/停靠中） */
  readonly active: boolean;
  /** 置为前台 / 后台（保活时不销毁，只改状态与 DOM 位置） */
  setActive: (active: boolean) => void;
}

const channels = new Map<number, ViewChannel>();
let nextId = 1;

/**
 * 打开一个视图会话。
 *
 * @param ownerId 归属者（插件 id / legacy 项 id）
 * @param kind 会话类型
 * @param env 该会话的局部环境
 * @param pushSubKeyword 子关键词消费者
 */
export function openViewChannel(
  ownerId: string,
  kind: ViewChannel["kind"],
  env: ScriptEnv,
  pushSubKeyword: (message: string) => boolean
): ViewChannel {
  const id = nextId++;
  let alive = true;
  let active = true;
  // 会话载体：由宿主创建，插件内容写进它里面；停靠/恢复时搬动的是它本身
  // （因此插件的 DOM 与挂在 DOM 上的状态全程不重建）。
  const container = document.createElement("div");
  container.className = PLUGIN_SESSION_CLASS;
  container.setAttribute(PLUGIN_SESSION_ATTR, ownerId);
  const channel: ViewChannel = {
    id,
    ownerId,
    kind,
    env,
    container,
    pushSubKeyword,
    get alive() {
      return alive;
    },
    get active() {
      return active;
    },
    setActive: (next: boolean) => {
      if (!alive) return;
      active = next;
    },
    dispose: () => {
      if (!alive) return;
      alive = false;
      active = false;
      // 先摘掉载体再删记录：DOM 必须在 dispose 里一起走，
      // 否则保活过的插件节点会留在停车场里变成幽灵视图。
      try {
        container.remove();
      } catch (e) {
        /* ignore */
      }
      channels.delete(id);
    },
  };
  channels.set(id, channel);
  return channel;
}

/** 关闭某个归属者的全部会话（插件禁用 / 卸载 / legacy 项消失时调用） */
export function closeChannelsOf(ownerId: string): number {
  let n = 0;
  for (const ch of [...channels.values()]) {
    if (ch.ownerId === ownerId) {
      ch.dispose();
      n++;
    }
  }
  return n;
}

/** 关闭全部会话（宿主退出 / 重置视图） */
export function closeAllChannels(): void {
  for (const ch of [...channels.values()]) ch.dispose();
}

/** 当前存活的会话（调试与面板展示用） */
export function listChannels(): Array<Pick<ViewChannel, "id" | "ownerId" | "kind">> {
  return [...channels.values()].map((c) => ({ id: c.id, ownerId: c.ownerId, kind: c.kind }));
}

/** 取某个归属者当前的会话（同时只允许一个视图，取最新打开的那个） */
export function currentChannelOf(ownerId: string): ViewChannel | null {
  let latest: ViewChannel | null = null;
  for (const ch of channels.values()) {
    if (ch.ownerId === ownerId) latest = ch;
  }
  return latest;
}

/**
 * 子关键词转发。
 *
 * 语义与老脚本项保持一致（`SEARCH_BOUNDARY = " : "`）：
 * 只要会话存在且关键词含分隔符，就算「已消费」——**即使子关键词为空**，
 * 这样回车不会误触发结果列表的点击（这是老脚本项既有行为，必须保住）。
 */
export function pushSubKeyword(ownerId: string, rawKeyword: string, boundary: string): {
  handled: boolean;
  nextKeyword: string;
} {
  const channel = currentChannelOf(ownerId);
  if (!channel || !channel.alive) return { handled: false, nextKeyword: rawKeyword };
  const parts = String(rawKeyword ?? "").split(boundary);
  if (parts.length < 2) return { handled: false, nextKeyword: rawKeyword };
  const message = (parts[1] ?? "").trim();
  try {
    channel.pushSubKeyword(message);
  } catch (e) {
    console.warn("[插件] 子关键词转发失败:", e);
  }
  // 保留「父关键词 : 」，便于连续追问（对齐老脚本项行为）
  const nextKeyword = message === "" ? rawKeyword : String(rawKeyword).replace(message, "");
  return { handled: true, nextKeyword };
}
