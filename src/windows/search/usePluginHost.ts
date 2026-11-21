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
import {
  auditDenied,
  createHostApi,
  type PluginHostContext,
  type PluginInstallConfirmRequest,
  type PluginSyncState,
} from "../../lib/plugins/host.ts";
import { permissionBaseId } from "../../lib/plugins/permissions.ts";
import type { PluginSubInputOptions } from "../../lib/plugins/host/core.ts";
import {
  permissionRequestText,
  planPermissionRequest,
  recordPermissionRequest,
} from "../../lib/plugins/permission-requests.ts";
import {
  onRegistryChanged,
  syncRecordGateway,
  syncRegistryGateway,
  syncShortcutActions,
} from "../../lib/plugins/gateway.ts";
import { envGrantsOf, envPermissionOf } from "../../lib/plugins/env-store.ts";
import type { EnvPickResult } from "../../composables/useEnvPicker.ts";
import {
  callPluginBackend,
  listPluginBackends,
  onPluginDevChanged,
  readPluginText,
  readPluginBinary,
  restartPluginBackend,
  stopPluginBackend,
  watchPluginDir,
  pluginSecretGet,
  pluginSecretSet,
  pluginSecretDelete,
  pluginSecretList,
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
  collectProviderResults as collectFromProviders,
  type CollectResultProvidersOptions,
} from "../../lib/plugins/result-provider.ts";
import {
  approveNewPermissions,
  decideBackendReload,
  decideViewReload,
  isFreshEvent,
  planReload,
} from "../../lib/plugins/dev-reload.ts";
import { loadRegistry, saveRegistry, createPluginRecord, upsertPlugin, manifestFromJson, type PluginRecord, type PluginRegistryFile } from "../../lib/plugins/registry.ts";
import { compareVersion } from "../../lib/plugins/manifest.ts";
import type { AttachedEntry } from "../../lib/plugins/attachments.ts";
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
  /**
   * 聚焦宿主搜索框（插件 search.focusInput 用；App.vue 注入）。
   * 不注入（如独立插件窗口）时插件调用会得到明确报错。
   */
  focusSearchInput?: () => void;
  /** 收起详情视图 */
  hideDetail: () => void;
  /** 应用内提示 */
  toast: (text: string, type?: "ok" | "error") => void;
  /** 应用内确认 */
  confirm: (text: string) => Promise<boolean>;
  /** 读取系统选中文本 */
  getSelectedText: (hint?: string) => Promise<string>;
  /**
   * 打开宿主的「选择环境变量」授权弹层（插件的 `ms.env.pick` 用）。
   *
   * 由 App.vue 注入：弹层是宿主 UI（EnvPicker.vue），插件运行时不该知道它的存在。
   * `grant` 由宿主在用户点「允许」时回调（本模块已把写授权 + 重启进程的逻辑
   * 包在 onEnvGrant 里，注入方只需负责画界面）。返回 null 表示用户取消。
   */
  openEnvPicker?: (req: {
    pluginId: string;
    pluginName: string;
    title?: string;
    purpose?: string;
    granted: string[];
    grant: (name: string) => Promise<boolean>;
  }) => Promise<EnvPickResult | null>;
  /**
   * 打开宿主的「插件安装确认」弹窗（插件的 `ms.market.install` / `update` 用）。
   *
   * 由 App.vue 注入：弹窗是宿主 UI（PluginInstallDialog.vue），插件运行时不该知道
   * 它的存在。返回 `true` = 用户点了「安装」；`false` = 取消（宿主不落盘）。
   * 不注入时市场安装会被拒绝（fail-closed，见 host.ts 的 createMarketApi）。
   */
  confirmPluginInstall?: (req: PluginInstallConfirmRequest) => Promise<boolean>;
  /** 插件视图挂载完成后通知宿主（重算窗口高度） */
  onItemsChanged?: () => void;
  /** 当前附加在搜索框里的文件/文件夹（由 App.vue 注入，ms.input.attachments 用） */
  getAttachments?: () => readonly AttachedEntry[];
  /**
   * 把用户刚在系统「选择文件夹」对话框里挑中的文件夹并入搜索框附件
   * （由 App.vue 注入 attachByPaths；ms.input.pickFolders 用）。
   * 不注入时插件调用会得到明确报错（不支持添加附件的窗口，如独立插件窗口）。
   */
  attachPaths?: (paths: string[]) => Promise<AttachedEntry[]>;
  /** 按路径从搜索框附件里移除一项（由 App.vue 注入；ms.input.detach 用） */
  detachPath?: (path: string) => Promise<boolean>;
  /**
   * 开发插件（目录挂载）在磁盘上发生变化、且注册表已被更新后回调。
   *
   * 由 App.vue 注入：视图重挂要走视图宿主（本模块不该知道 DetailView 的
   * 存在），而「要不要重挂」由纯函数 `decideViewReload` 决定。
   * 不注入则只更新注册表与搜索项。
   */
  onDevPluginReloaded?: (info: DevReloadInfo) => void;
  /**
   * 让视图宿主重新求解并应用一次前台插件的主题。
   *
   * 由 App.vue 注入（转发到 `pluginViewHost.refreshActiveTheme`）：插件在界面内
   * 改主题（`ms.ui.applyTheme`）时，需要由视图宿主去切整个呼出窗口的主题。
   * 本模块只负责把插件的调用转达出去，不碰视图 DOM。
   */
  refreshPluginTheme?: () => void;
  /**
   * 宿主子输入框（P1-5）：转发给视图宿主渲染在插件上方的输入框。
   * 不注入（如独立插件窗口）时 `ms.ui.subInput.*` 返回 false。
   */
  subInput?: (
    pluginId: string,
    action: "set" | "remove" | "focus",
    options?: PluginSubInputOptions
  ) => boolean;
  /**
   * 数据同步（插件的 `ms.sync.status` / `ms.sync.trigger`）。
   *
   * 由 App.vue 注入（`useSyncBridge`）：同步引擎的创建/销毁、以及「只在有插件
   * 申请该权限时才建」的判定都在那边，本模块只把调用转达出去。
   * 不注入时两个 API 退化为「未开启」与「抛错」。
   */
  syncNow?: () => Promise<PluginSyncState>;
  syncStatus?: () => PluginSyncState;
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
   * 「已启用且已授予 `sync`」的插件数（响应式）。
   *
   * 单独出一个计数而不是让调用方去遍历 `activePlugins()`：那是个普通函数，
   * 读它不会建立依赖，装了插件也不会重算。搜索窗口据此决定要不要为插件
   * 起一份同步引擎（没有插件申请就完全不建，省掉一个后台定时器）。
   */
  const syncConsumerCount = ref(0);

  /** 重算 `syncConsumerCount`（注册表任何变动后都要调） */
  function refreshSyncConsumers(): void {
    syncConsumerCount.value = registry.plugins.filter(
      (p) =>
        p.enabled &&
        p.source.kind !== "legacy" &&
        p.grants.some((g) => permissionBaseId(g.permission) === "sync")
    ).length;
  }

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

  /**
   * 以磁盘 `plugin.json` 为准，校正注册表记录的版本与清单。
   *
   * 为什么需要：注册表（localStorage）是宿主侧的权威镜像，但它可能与磁盘脱节——
   * 升级/还原中断、文件被外部替换，或历史上「还原后没重载注册表」留下的错配。
   * 错配的直接后果就是「低版本代码以高版本号工作」：权限、后台入口、快捷键动作
   * 都来自注册表清单，而界面/后端代码来自磁盘。
   *
   * 判定与处理：**版本不同就按磁盘重建记录**（用户态开关 / 自启 / 关闭行为 /
   * 授权 / 拒绝列表由 `upsertPlugin` 合并保留）。返回被修正的记录数。
   */
  async function repairRecordsFromDisk(reg: PluginRegistryFile): Promise<number> {
    let changed = 0;
    for (const rec of reg.plugins) {
      if (rec.source.kind === "legacy" || rec.source.dev) continue;
      let text: string;
      try {
        text = await readPluginText(rec.id, "plugin.json");
      } catch {
        continue; // 目录缺失 / 暂不可读：保留现有记录，不因读不到就判定
      }
      const manifest = manifestFromJson(text);
      if (!manifest || manifest.id !== rec.id) continue;
      if (compareVersion(manifest.version, rec.version) === 0) continue;
      console.warn(
        `[插件] 注册表与磁盘版本不一致（${rec.id}）：注册表 v${rec.version} / 磁盘 v${manifest.version}，按磁盘校正`
      );
      const merged = upsertPlugin(
        reg,
        createPluginRecord({
          manifest,
          dir: rec.dir,
          source: rec.source,
          runtime: rec.runtime,
          integrity: rec.integrity,
        }),
        { preserveUserChoices: true }
      );
      // 运行态是当前进程的实时镜像，不被清单重建覆盖
      merged.runtime = rec.runtime;
      changed++;
    }
    return changed;
  }

  /** 从 localStorage 读注册表并原子同步网关（幂等；内容未变则跳过） */
  async function reload(force = false): Promise<void> {
    const fp = registryFingerprint();
    if (!force && fp === syncedFingerprint && loaded.value) return;
    registry = loadRegistry();
    syncedFingerprint = fp;
    loaded.value = true;
    // 【注册表 ↔ 磁盘自愈】以磁盘 `plugin.json` 为准校正版本与清单。
    // 覆盖「更新中断 / 文件被外部替换 / 历史还原错配」等场景：否则会出现
    // 「磁盘跑的是低版本代码、注册表却写着高版本号」的错配（插件按错误版本工作）。
    // 只在真正重读注册表时执行（首次加载 / force），避免常态 IPC 开销。
    try {
      const repaired = await repairRecordsFromDisk(registry);
      if (repaired > 0) {
        saveRegistry(registry);
        syncedFingerprint = registryFingerprint();
      }
    } catch (e) {
      console.warn("[插件] 注册表与磁盘版本校对失败:", e);
    }
    refreshSyncConsumers();
    // 网关批量同步：一次 IPC 完成全部插件权限镜像、残留剔除、一次快照落盘与按需钩子调和
    try {
      await syncRegistryGateway(registry);
    } catch (e) {
      console.warn("[插件] 批量网关同步失败:", e);
    }
    // 并行预读启用插件的图标与登记开发目录监听
    await Promise.all(
      registry.plugins
        .filter((rec) => rec.source.kind !== "legacy")
        .map(async (rec) => {
          if (rec.enabled) await preloadIcons(rec);
          if (rec.source.dev && rec.source.ref) {
            try {
              await watchPluginDir(rec.id, rec.source.ref, true);
            } catch (e) {
              console.warn(`[插件] 登记目录监听失败（${rec.id}）:`, e);
            }
          }
        })
    );
    opts.onItemsChanged?.();
    try {
      await syncShortcutActions(registry);
    } catch (e) {
      console.warn("[插件] 快捷键动作同步失败:", e);
    }
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
    refreshSyncConsumers();
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
  let unlistenRegistryChanged: (() => void) | null = null;

  /**
   * 开始监听「开发插件变化」与「跨窗口注册表变更」事件（应用启动时调用一次）。
   */
  async function startDevWatcher(): Promise<void> {
    if (!unlistenRegistryChanged) {
      unlistenRegistryChanged = onRegistryChanged(() => {
        void reload();
      });
    }
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
    unlistenRegistryChanged?.();
    unlistenRegistryChanged = null;
  }
  /** 插件贡献的搜索项（每次调用重新合成，保证装/卸/禁用即时生效） */
  function pluginItems(): SearchItem[] {
    if (!loaded.value) return [];
    return buildAllPluginItems(activePlugins(), resolveIcon);
  }

  /**
   * 询问插件的搜索期结果提供者（P0-2）。
   *
   * 只问「已启用 + 清单声明了 resultProvider + 当前注册了回调」的插件；
   * 超时/异常在内层已隔离，这里不会再抛错。视图没开过的插件没有回调，
   * 因此搜索不会为插件冷启动付出代价。
   */
  async function providerResults(keyword: string): Promise<SearchItem[]> {
    if (!loaded.value) return [];
    const opts: CollectResultProvidersOptions = {
      keyword,
      records: activePlugins(),
      resolveIcon,
      onError: (pluginId, reason) =>
        console.warn(`[插件 ${pluginId}] 结果提供者跳过: ${reason}`),
    };
    return await collectFromProviders(opts);
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
    refreshSyncConsumers();
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
      // 插件 ms.search.focusInput：聚焦宿主搜索框（呼出类插件动作的配套能力）
      focusSearchInput: opts.focusSearchInput,
      hideDetail: () => opts.hideDetail(),
      toast: (text, type) => opts.toast(text, type),
      confirm: (text) => opts.confirm(text),
      getSelectedText: (hint) => opts.getSelectedText(hint),
      getAttachments: () => opts.getAttachments?.() ?? [],
      // 插件 ms.input.pickFolders：把用户在系统对话框里挑中的文件夹并入附件
      attachPaths: opts.attachPaths,
      // 插件 ms.input.detach：按路径从附件里移除（只减不加）
      detachPath: opts.detachPath,
      // 插件界面内改主题（ms.ui.applyTheme）→ 视图宿主重算呼出窗口主题
      refreshPluginTheme: () => opts.refreshPluginTheme?.(),
      subInput: opts.subInput,
      // 市场安装/更新的用户确认闸门（ms.market.install）：弹宿主安装确认框
      confirmPluginInstall: opts.confirmPluginInstall,
      // 详情视图里的运行期授权：直接改注册表并同步网关
      getSecret: (id, name) => pluginSecretGet(id, name),
      setSecret: (id, name, value) => pluginSecretSet(id, name, value),
      deleteSecret: (id, name) => pluginSecretDelete(id, name),
      listSecrets: (id) => pluginSecretList(id),
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
      /**
       * `ms.permissions.request`（P1-1）：批量申请清单里声明过的权限。
       * 校验顺序：合法/已声明 → 24h 频率 → 一次弹窗 → 逐项授予。
       */
      requestPermissions: async (id, apis, reason) => {
        const rec = get(id);
        if (!rec) throw new Error("插件未加载，无法申请权限");
        const now = Date.now();
        const plan = planPermissionRequest(rec, apis, now);
        const why = String(reason ?? "").slice(0, 200);
        if (!plan.ok) {
          recordPermissionRequest(rec, {
            apis: Array.isArray(apis) ? apis.map((p) => String(p ?? "")) : [],
            reason: why,
            at: now,
            result: plan.reason === "throttled" ? "throttled" : "invalid",
            message: plan.message,
          });
          persist();
          auditDenied(id, "permissions.request", why, plan.message);
          return {
            ok: false,
            granted: [],
            denied: [],
            throttled: plan.throttled ?? [],
            error: plan.message,
          };
        }
        // 全部已授予：不弹窗、不写历史
        if (plan.apis.length === 0) {
          return { ok: true, granted: plan.already, denied: [], throttled: [] };
        }
        const allowed = await opts.confirm(
          permissionRequestText(rec, plan.apis, reason)
        );
        recordPermissionRequest(rec, {
          apis: plan.apis,
          reason: why,
          at: now,
          result: allowed ? "granted" : "denied",
        });
        persist();
        if (!allowed) {
          return { ok: false, granted: plan.already, denied: plan.apis, throttled: [] };
        }
        for (const p of plan.apis) await grantPermission(id, p);
        opts.toast(`已允许「${rec.name}」使用 ${plan.apis.length} 项权限`, "ok");
        return {
          ok: true,
          granted: [...plan.already, ...plan.apis],
          denied: [],
          throttled: [],
        };
      },
      callBackend: async (id, method, params) => {
        // 同步网关，确保 Rust 侧有此插件的注册记录
        const rec = get(id);
        if (rec) {
          try { await syncRecordGateway(rec); } catch { /* 浏览器调试 */ }
        }
        return callPluginBackend(id, method, params);
      },
      /**
       * `ms.env.pick`：打开宿主的授权选择器。
       *
       * 授权动作由弹层的「允许」按钮触发（回调 `grant`），走权限网关同一条链路：
       * 改记录 → persist → 下发网关。env 只在 spawn 时进进程，所以授权后若该插件
       * 后台在跑，立即重启一次（否则用户会以为「授权了却没生效」）。
       */
      pickEnvVar: async (id, o) => {
        if (!opts.openEnvPicker) return null;
        const rec = get(id);
        return await opts.openEnvPicker({
          pluginId: id,
          pluginName: rec?.name ?? "",
          title: o.title,
          purpose: o.purpose,
          granted: rec ? [...envGrantsOf(rec)] : [],
          grant: async (name: string) => {
            const ok = await grantPermission(id, envPermissionOf(name));
            if (!ok) return false;
            try {
              const list = await listPluginBackends();
              const st = list.find((s) => s.pluginId === id)?.status ?? "stopped";
              if (st === "running" || st === "starting") await restartPluginBackend(id);
            } catch (e) {
              /* 浏览器调试 / 查询失败：不动进程 */
            }
            opts.onItemsChanged?.();
            return true;
          },
        });
      },
      log: (id, level, text) => {
        const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
        fn(`[插件 ${id}] ${text}`);
      },
      // 原生能力（screenshot / clipboard / gesture / shortcuts / store.readJson 等）
      // 已在 `lib/plugins/host/native-api.ts` 表驱动直连 IPC，此处不再保留透传样板。
      syncNow: opts.syncNow,
      syncStatus: opts.syncStatus,
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
    /** 「已启用且已授予 sync」的插件数（搜索窗口据此决定要不要起同步引擎） */
    syncConsumerCount,
    get,
    activePlugins,
    pluginItems,
    providerResults,
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
