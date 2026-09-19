/**
 * 搜索窗口的插件运行时 —— 把插件系统接到前台。
 *
 * 设置窗口（`usePluginRuntime`）负责管：安装 / 卸载 / 权限 / 后台进程。
 * 搜索窗口负责用：把启用插件的搜索项喂给检索、把详情视图交给插件渲染。
 * 两者共享同一份注册表（localStorage），但**不共享 Vue 响应式实例**——
 * 搜索窗口是独立 WebView，必须自己 load + 自己同步网关。
 *
 * 加载时机（与订阅数据的节奏对齐）：
 *   - 应用启动时读一次注册表；
 *   - 每次搜索窗口重新获得焦点 / 呼出时，比对注册表指纹，变了才重载
 *     （用户在设置窗口装完插件，切回搜索窗口即可用，无需重启应用）。
 *
 * 为什么不把插件项写进 `SEARCH_DATA_KEY` 缓存：缓存带订阅指纹、且是「网络数据」
 * 的落盘副本；插件项来自本地注册表、生命周期完全不同（装/卸/禁用即时生效），
 * 掺进去会破坏既有的「订阅变化即失效」判定。因此每次挂载时**重新合成**。
 */

import { ref } from "vue";
import { auditDenied, createHostApi, type PluginHostContext } from "../../lib/plugins/host.ts";
import { syncRecordGateway } from "../../lib/plugins/gateway.ts";
import {
  callPluginBackend,
  listPluginBackends,
  onPluginDevChanged,
  readPluginText,
  readPluginBinary,
  restartPluginBackend,
  stopPluginBackend,
  watchPluginDir,
} from "../../lib/plugins/ipc.ts";
import {
  buildAllPluginItems,
  buildPluginItems,
  pluginIdOf,
  PLUGIN_ITEM_FLAG,
  PLUGIN_SUBSCRIBE_PREFIX,
} from "../../lib/plugins/plugin-items.ts";
import { iconDataUrl, iconRefsOf } from "../../lib/plugins/icon.ts";
import {
  approveNewPermissions,
  decideBackendReload,
  decideViewReload,
  isFreshEvent,
  planReload,
} from "../../lib/plugins/dev-reload.ts";
import { loadRegistry, saveRegistry, type PluginRecord, type PluginRegistryFile } from "../../lib/plugins/registry.ts";
import type { SearchItem } from "../../types/index.ts";

/** 注册表在 localStorage 里的键（与 registry.ts 保持一致） */
const REGISTRY_STORAGE_KEY = "my-search-desktop:PLUGIN_REGISTRY_CACHE_KEY";

/** 读取注册表原文（用于指纹比对：内容没变就不重复做网关同步） */
function registryFingerprint(): string {
  try {
    return localStorage.getItem(REGISTRY_STORAGE_KEY) ?? "";
  } catch (e) {
    return "";
  }
}

export interface PluginHostRuntimeOptions {
  /** 搜索库只读副本（宿主 API 的 search.read） */
  getSearchData: () => readonly SearchItem[];
  /** 触发一次搜索（插件 search.trigger 用） */
  triggerSearch: (keyword: string) => void;
  /** 改写输入框（插件 search.setInput 用） */
  setInput: (text: string) => void;
  /** 收起详情视图 */
  hideDetail: () => void;
  /** 应用内提示 */
  toast: (text: string, type?: "ok" | "error") => void;
  /** 应用内确认 */
  confirm: (text: string) => Promise<boolean>;
  /** 读取系统选中文本 */
  getSelectedText: (hint?: string) => Promise<string>;
  /** 插件视图挂载完成后通知宿主（重算窗口高度） */
  onItemsChanged?: () => void;
  /**
   * 开发插件（目录挂载）在磁盘上发生变化、且注册表已被更新后回调。
   *
   * 由 App.vue 注入：视图重挂要走视图宿主（本模块不该知道 DetailView 的
   * 存在），而「要不要重挂」由纯函数 `decideViewReload` 决定。
   * 不注入则只更新注册表与搜索项。
   */
  onDevPluginReloaded?: (info: DevReloadInfo) => void;
}

/** 一次开发插件重载的结果（供宿主决定重挂视图 / 提示用户） */
export interface DevReloadInfo {
  /** 更新后的记录（已合并新清单，用户态未动） */
  record: PluginRecord;
  /** 版本是否变化 */
  versionChanged: boolean;
  /** 变化前的版本 */
  fromVersion: string;
  /** 新增的必需权限（未静默授予，仅登记为待授权） */
  newPermissions: string[];
  /** 本次变化涉及的文件（相对路径；空 = 目录级事件） */
  paths: string[];
}

export function usePluginHost(opts: PluginHostRuntimeOptions) {
  /** 当前注册表快照（搜索窗口自己的副本） */
  let registry: PluginRegistryFile = { version: 1, plugins: [] };
  /** 上次同步网关时的注册表指纹 */
  let syncedFingerprint = "";
  /** 是否已加载（首次加载完成前不合成插件项） */
  const loaded = ref(false);

  /**
   * 插件图标缓存：`<插件id>/<图标引用>` → 可直接用于 `<img src>` 的 data URL。
   *
   * 为什么需要缓存：插件清单里的图标可以是**插件目录内的相对路径**，
   * 读它要走异步 IPC；而 `pluginItems()` 是同步的（检索库合成、以及每次
   * 呼出时的重挂载都要求同步取到）。因此在 `reload()` 里预先把用到的图标
   * 读出来转成 data URL 存进这里，`pluginItems()` 只做同步查表。
   */
  const iconCache = new Map<string, string>();

  /**
   * 预读某插件用到的**相对路径**图标（`data:` / `http(s):` 无需处理）。
   * 读取失败只记日志：图标缺失不该影响插件本身可用。
   */
  async function preloadIcons(rec: PluginRecord): Promise<void> {
    for (const ref of iconRefsOf(rec.manifest)) {
      const key = `${rec.id}/${ref}`;
      if (iconCache.has(key)) continue;
      try {
        const b64 = await readPluginBinary(rec.id, ref);
        iconCache.set(key, iconDataUrl(ref, b64));
      } catch (e) {
        console.warn(`[插件] 读取图标失败（${rec.id} / ${ref}）:`, e);
      }
    }
  }

  /** 同步取已缓存的图标 data URL（未预读到 → undefined，条目退回默认图标） */
  function resolveIcon(pluginId: string, ref: string): string | undefined {
    return iconCache.get(`${pluginId}/${ref}`);
  }

  /** 从 localStorage 读注册表并同步网关（幂等；内容未变则跳过） */
  async function reload(force = false): Promise<void> {
    const fp = registryFingerprint();
    if (!force && fp === syncedFingerprint && loaded.value) return;
    registry = loadRegistry();
    syncedFingerprint = fp;
    loaded.value = true;
    // 网关同步：Rust 侧按「已授予权限」做第二道拦截，必须先把权限镜像过去
    for (const rec of registry.plugins) {
      if (rec.source.kind === "legacy") continue;
      try {
        await syncRecordGateway(rec);
      } catch (e) {
        console.warn(`[插件] 网关同步失败（${rec.id}）:`, e);
      }
      // 预读图标（相对路径形态）——必须在合成插件项之前完成
      if (rec.enabled) await preloadIcons(rec);
      // 目录挂载的插件：登记源目录监听（幂等；由 Rust 侧广播变化事件）
      if (rec.source.dev && rec.source.ref) {
        try {
          await watchPluginDir(rec.id, rec.source.ref, true);
        } catch (e) {
          console.warn(`[插件] 登记目录监听失败（${rec.id}）:`, e);
        }
      }
    }
    opts.onItemsChanged?.();
  }

  /** 取插件记录 */
  function get(pluginId: string): PluginRecord | undefined {
    return registry.plugins.find((p) => p.id === pluginId);
  }

  /** 启用中的插件（legacy 不参与） */
  function activePlugins(): PluginRecord[] {
    return registry.plugins.filter((p) => p.enabled && p.source.kind !== "legacy");
  }

  /* ============================================================
   * 开发插件（目录挂载）的自动重载
   * ============================================================ */

  /**
   * 把一次「源目录变化」应用到注册表。
   *
   * 步骤（判定都在 dev-reload.ts 的纯函数里，这里只执行）：
   *   1. 重新读源目录里的 `plugin.json`；
   *   2. 合并记录（用户态保留、新权限只登记待授权）；
   *   3. 落盘注册表并同步网关；
   *   4. 重新合成插件项、预读新图标；
   *   5. 回调宿主（重挂视图 / 提示），并按需重启后台进程。
   *
   * 失败一律只记日志：热重载是增强，坏一次不该影响插件继续可用。
   */
  async function applyDevChange(payload: {
    pluginId: string;
    paths: string[];
    frontendOnly: boolean;
  }): Promise<DevReloadInfo | null> {
    // 0) 以**落盘的最新记录**为基准：设置窗口可能刚改过权限/开关，
    //    而本窗口的 registry 还是旧快照——直接改旧快照再整表写回会把那些改动抹掉。
    const persisted = (() => {
      try {
        return loadRegistry().plugins.find((p) => p.id === payload.pluginId);
      } catch (e) {
        return undefined;
      }
    })();
    const rec = persisted ?? get(payload.pluginId);
    if (!rec) return null;
    if (!rec.source.dev) return null; // 不是目录挂载：不参与热重载

    // 1) 读新清单（读不到 = 目录被删/改名：不动记录，等下一次或用户处理）
    let manifestText: string;
    try {
      manifestText = await readPluginText(rec.id, "plugin.json");
    } catch (e) {
      console.warn(`[插件] 重新读取清单失败（${rec.id}）:`, e);
      return null;
    }

    // 2) 计算并合并（新权限不静默授予）
    const plan = planReload(rec, manifestText);
    if (!plan.proceed) {
      console.warn(`[插件] 跳过本次热重载（${rec.id}）: ${plan.reason}`);
      return null;
    }
    // 就地替换（保持列表顺序：插件在面板与搜索结果里的次序不该因改了个文件而变）
    registry.plugins = registry.plugins.map((p) => (p.id === rec.id ? plan.record : p));
    registry = { version: registry.version, plugins: [...registry.plugins] };
    if (plan.newPermissions.length > 0) {
      console.warn(
        `[插件] 「${plan.record.name}」新增权限待确认：${plan.newPermissions.join(", ")}`
      );
      opts.toast(
        `「${plan.record.name}」新增了权限 ${plan.newPermissions.join("、")}，请到「设置 → 插件」确认`,
        "error"
      );
    }

    // 3) 落盘 + 网关同步（清单可能改了权限/自启策略/后台入口）。
    // 不更新 syncedFingerprint：下次 reload() 会因指纹变化重读一遍，
    // 读到的正是刚写回注册表的合并结果（幂等），顺带把网关再校准一次。
    persist();
    try {
      await syncRecordGateway(plan.record);
    } catch (e) {
      console.warn(`[插件] 热重载后网关同步失败（${rec.id}）:`, e);
    }

    // 4) 图标与插件项：图标可能换了内容/换了路径，缓存要先失效再重读
    if (plan.record.enabled) {
      for (const ref of iconRefsOf(plan.record.manifest)) {
        iconCache.delete(`${rec.id}/${ref}`);
      }
      await preloadIcons(plan.record);
    }
    opts.onItemsChanged?.();

    // 5) 后台进程：**只在它当前运行时**才重启（用户拍板的策略）。
    //    必须在重挂视图**之前**采样进程状态并完成重启：重挂会先 clear() 旧会话，
    //    而 closeBehavior=exit 的插件会因此把进程停掉——那样就再也判定不出
    //    「它本来在运行」，后端起不来。同理，先重启再重挂，重挂后的界面调用
    //    后端时拿到的就是新进程。
    await maybeRestartBackendForDevChange(plan.record, payload);

    // 6) 宿主副作用：重挂视图（判定是纯函数，执行在 App.vue）
    const info: DevReloadInfo = {
      record: plan.record,
      versionChanged: plan.versionChanged,
      fromVersion: plan.fromVersion,
      newPermissions: plan.newPermissions,
      paths: payload.paths,
    };
    opts.onDevPluginReloaded?.(info);
    return info;
  }

  /**
   * 按「只在进程运行时才重启」的策略重启后台进程。
   *
   * 判定用纯函数 `decideBackendReload`；重启失败只记日志——开发中的后端
   * 可能正在半截状态，把错误抛到界面上反而干扰。
   */
  async function maybeRestartBackendForDevChange(
    rec: PluginRecord,
    payload: { paths: string[]; frontendOnly: boolean }
  ): Promise<void> {
    const hasBackend = rec.manifest.backend != null;
    let status: string | null = null;
    if (hasBackend) {
      try {
        const list = await listPluginBackends();
        status = list.find((s) => s.pluginId === rec.id)?.status ?? "stopped";
      } catch (e) {
        status = null; // 查询不到就不动进程（保守）
      }
    }
    const decision = decideBackendReload({
      hasBackend,
      paths: payload.paths,
      status,
      frontendOnly: payload.frontendOnly,
    });
    if (!decision.restart) return;
    try {
      await restartPluginBackend(rec.id);
      opts.toast(`「${rec.name}」后台进程已按开发目录的改动重启`, "ok");
    } catch (e) {
      console.warn(`[插件] 热重载重启后台进程失败（${rec.id}）:`, e);
    }
  }

  /** 事件监听取消函数（应用退出时调用） */
  let unlistenDevChanged: (() => void) | null = null;

  /**
   * 开始监听「开发插件变化」事件（应用启动时调用一次）。
   *
   * 事件是 Rust 侧的文件监听线程广播的，**携带路径与防抖结果**；
   * 这里只做「新鲜度过滤 + 串行消费」——同一插件的多次事件必须按序应用，
   * 否则并发读清单会互相覆盖（后读到的旧内容可能盖掉新内容）。
   */
  async function startDevWatcher(): Promise<void> {
    if (unlistenDevChanged) return;
    // 串行队列：一个插件的重载没做完之前，后续事件排队（而不是并发跑）
    let chain: Promise<void> = Promise.resolve();
    const unlisten = await onPluginDevChanged((payload) => {
      if (!payload?.pluginId) return;
      if (!isFreshEvent(payload)) return; // 过期事件：等下一次改动
      chain = chain
        .then(() => applyDevChange(payload))
        .then(() => undefined)
        .catch((e) => {
          console.warn(`[插件] 处理开发目录变化失败（${payload.pluginId}）:`, e);
        });
    });
    unlistenDevChanged = unlisten;
  }

  /** 停止监听（应用退出） */
  function stopDevWatcher(): void {
    unlistenDevChanged?.();
    unlistenDevChanged = null;
  }
  /** 插件贡献的搜索项（每次调用重新合成，保证装/卸/禁用即时生效） */
  function pluginItems(): SearchItem[] {
    if (!loaded.value) return [];
    return buildAllPluginItems(activePlugins(), resolveIcon);
  }

  /**
   * 取某插件用于「打开视图」的数据项（全局快捷键 open-plugin 用）。
   *
   * 插件视图的打开路径要求一个带 `_pluginId` 的 SearchItem（视图宿主据此找记录、
   * 渲染 detailView、转发子关键词），而快捷键触发时用户并没有在结果列表里选任何一项，
   * 因此取该插件的**第一个可见搜索项**作载体；没声明搜索项的插件合成一个最小项，
   * 保证「快捷键 → 直接打开插件界面」这条路径对两类插件都成立。
   */
  function itemForPlugin(pluginId: string): SearchItem | null {
    const rec = get(pluginId);
    if (!rec || !rec.enabled) return null;
    const list = buildPluginItems(rec, resolveIcon ? (ref) => resolveIcon(rec.id, ref) : undefined);
    if (list.length > 0) return list[0];
    // 插件没声明 searchItem：合成一个最小项，仅用于打开 detailView
    const item: SearchItem = {
      title: rec.name,
      desc: rec.description ?? "",
      resource: "",
      type: "script",
      subscribe: PLUGIN_SUBSCRIBE_PREFIX + rec.name,
    };
    item[PLUGIN_ITEM_FLAG] = rec.id;
    return item;
  }

  /** 当前是否有插件项参与检索（合成结果是非响应式的，用函数就地判断） */
  function hasPluginItems(): boolean {
    return pluginItems().length > 0;
  }

  /**
   * 授予权限并落盘 + 同步网关。
   * 搜索窗口里的「运行时授权弹窗」走这里——用户同意后立即生效，
   * 不必回到设置窗口。
   */
  async function grantPermission(pluginId: string, permission: string): Promise<boolean> {
    const rec = get(pluginId);
    if (!rec) return false;
    const base = permission.split(":")[0];
    // 已有同基础权限的授予里能否覆盖？不能则新增一条
    const exists = rec.grants.some((g) => g.permission === permission);
    if (!exists) {
      // 同基础 id 且已授予的 scope 覆盖不了时，追加具体 scope
      rec.grants.push({ permission, at: Date.now(), source: "prompt" });
    }
    rec.denied = rec.denied.filter((p) => p !== permission);
    if (rec.pendingPermission && rec.pendingPermission.split(":")[0] === base) rec.pendingPermission = null;
    persist();
    try {
      await syncRecordGateway(rec);
    } catch (e) {
      /* 无 Rust 侧时忽略 */
    }
    return true;
  }

  /** 记录一次拒绝（不再反复打扰） */
  function denyPermission(pluginId: string, permission: string): void {
    const rec = get(pluginId);
    if (!rec) return;
    if (!rec.denied.includes(permission)) rec.denied.push(permission);
    rec.pendingPermission = null;
    persist();
  }

  /** 持久化注册表（搜索窗口改动的部分：grants / denied） */
  function persist(): void {
    saveRegistry({ version: registry.version, plugins: [...registry.plugins] });
  }

  /** 宿主 API 上下文（权限网关的依赖注入） */
  function hostContext(): PluginHostContext {
    return {
      registry: () => registry,
      persistRegistry: () => persist(),
      searchData: () => opts.getSearchData(),
      triggerSearch: (kw) => opts.triggerSearch(kw),
      setInput: (text) => opts.setInput(text),
      hideDetail: () => opts.hideDetail(),
      toast: (text, type) => opts.toast(text, type),
      confirm: (text) => opts.confirm(text),
      getSelectedText: (hint) => opts.getSelectedText(hint),
      // 详情视图里的运行期授权：直接改注册表并同步网关
      requestPermission: async (id, permission) => {
        const rec = get(id);
        if (!rec) return false;
        const allowed = await opts.confirm(
          `插件「${rec.name}」请求权限：\n${permission}\n\n是否允许？`
        );
        if (allowed) {
          await grantPermission(id, permission);
          opts.toast(`已允许「${rec.name}」使用该权限`, "ok");
          return true;
        }
        denyPermission(id, permission);
        auditDenied(id, "permission.request", permission, "用户拒绝");
        return false;
      },
      callBackend: async (id, method, params) => {
        // 同步网关，确保 Rust 侧有此插件的注册记录
        const rec = get(id);
        if (rec) {
          try { await syncRecordGateway(rec); } catch { /* 浏览器调试 */ }
        }
        return callPluginBackend(id, method, params);
      },
      log: (id, level, text) => {
        const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
        fn(`[插件 ${id}] ${text}`);
      },
    };
  }

  /** 为某个插件创建已绑定身份的宿主 API（`ms.*`） */
  function apiFor(pluginId: string): Record<string, unknown> {
    const ctx = hostContext();
    return createHostApi(pluginId, {
      ...ctx,
      setViewHeight: () => opts.onItemsChanged?.(),
    });
  }

  /** 读取插件内文本（视图宿主用） */
  async function readText(pluginId: string, relPath: string): Promise<string> {
    return await readPluginText(pluginId, relPath);
  }

  /**
   * 停止某插件的后台进程（关闭插件界面时按 `closeBehavior=exit` 调用）。
   *
   * 只包一层 IPC：**是否该停**由调用方按注册表记录判定（`shouldStopBackendOnClose`），
   * 这里不做策略判断——策略是纯函数、可单测，而这里只负责把动作发出去。
   * 浏览器调试环境没有 Rust 侧，直接吞掉（与 stopPluginBackend 的降级一致）。
   */
  async function stopBackend(pluginId: string): Promise<void> {
    try {
      await stopPluginBackend(pluginId);
    } catch (e) {
      /* 未运行 / 无 Rust 侧：关闭界面不该因此报错 */
    }
  }

  return {
    loaded,
    reload,
    get,
    activePlugins,
    pluginItems,
    hasPluginItems,
    itemForPlugin,
    grantPermission,
    denyPermission,
    hostContext,
    apiFor,
    readText,
    stopBackend,
    pluginIdOf,
    // 开发插件（目录挂载）的自动重载
    startDevWatcher,
    stopDevWatcher,
  };
}

export type PluginHostApi = ReturnType<typeof usePluginHost>;
