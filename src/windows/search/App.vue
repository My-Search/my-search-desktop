<script setup lang="ts">
/**
 * 搜索主窗口根组件（原 main.js 的 renderApp + bindEvents + 各流程）。
 *
 * 结构（DOM 与原版 HTML 完全一致，供既有测试与 CSS 复用）：
 *   #my_search_box
 *     > #tis
 *     > #my_search_view
 *         > SearchBox (#searchBox)
 *         > #recentStrip     ← Alt 最近条带：搜索框正下方的流内一行
 *         > #matchResult > ResultList (#matchItems)
 *         > DetailView (#text_show)
 *
 * 职责：
 * - 键盘交互（↑↓ / Enter / Ctrl+Enter / Esc / Tab / Backspace / ::(PRO 模式)）
 * - 打开数据项（脚本项 / 简述文本 / URL 模板填充）
 * - 窗口高度（结果区实测高度、详情视图自适应、复位）
 * - 呼出分支（详情视图原样还原 / 其它复位）
 * - 缓存清理与订阅变化重载
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import SearchBox from "./SearchBox.vue";
import ResultList from "./ResultList.vue";
import DetailView, { type DetailContent } from "./DetailView.vue";
import PluginResizeHandle from "./PluginResizeHandle.vue";
import { useSearchState, MODE, BOX_HEIGHT } from "./useSearchState";
import { setDetailManualHeightLock } from "./useDetailHeight";
import { useUpdateChecker } from "./useUpdateChecker";
import { useScriptHost } from "./useScriptHost";
import { usePluginHost } from "./usePluginHost";
import { usePluginViewHost } from "./usePluginViewHost";
import { useSyncBridge } from "./useSyncBridge";
import { resolveDropTarget, toCssPoint } from "./drop-target";
import { prefetchFileIcons, pruneFileIcons, useFileIcons } from "./useFileIcons";
import { pluginIdOf } from "../../lib/plugins/plugin-items";
import { decideViewReload } from "../../lib/plugins/dev-reload";
import { takePluginFrontendRestartMarks } from "../../lib/plugins/restart";
import { bindPluginHostRuntime, dispatchShortcutAction } from "../../lib/plugins/host";
import type { PluginInstallConfirmRequest } from "../../lib/plugins/host";
import { useMessageDialog } from "../../composables/useMessageDialog";
import { useToast } from "../../composables/useToast";
import { useEnvPicker } from "../../composables/useEnvPicker";
import { setupBuiltinAutoInstall } from "../../lib/plugins/install-builtin";
import MessageDialog from "../../components/MessageDialog.vue";
import PluginInstallDialog from "../../components/PluginInstallDialog.vue";
import ToastHost from "../../components/ToastHost.vue";
import EnvPicker from "../../components/EnvPicker.vue";
import { isUrl, clearUrlSearchTemplate, storageGet, storageSet } from "../../lib/util";
import { debug, warn } from "../../lib/logger";
import {
  openExternal,
  openConfigWindow,
  hideWindow,
  setWindowHeight,
  setWindowWidthOverride,
  getWindowWidthOverride,
  cancelPendingHeight,
  applyWindowSize,
  animateWindowSize,
  cancelWindowResizeAnimation,
  getDefaultWindowWidth,
  setWindowPosition,
  resetMainWindowPosition,
  getMainMonitorRect,
  onMainWindowShown,
  onClearCache,
  onShortcutOpenPlugin,
  onShortcutQuickFilter,
  onShortcutQuickOpen,
  onShortcutClipboard,
  onShortcutPluginAction,
  onAttachPaths,
  onWindowFocusChanged,
  isWindowVisible,
  isTauri,
} from "../../lib/tauri-bridge";
import { SEARCH_BOUNDARY, SPECIAL_KEYWORD, scoreSelect, historySelect } from "../../lib/search-engine";
import { normalizeQuickFilterHeader, pluginDefinedActionName } from "../../lib/shortcut-bindings";
import {
  attachmentKey,
  buildAttachmentFilter,
  mergeAttachments,
  mergeRecentAttachments,
  toggleRecentPin,
  RECENT_ATTACH_CAP,
  RECENT_ATTACH_KEY,
  type AttachedEntry,
} from "../../lib/plugins/attachments";
import { attachmentsSync, describePaths, readLocalFileBase64 } from "../../lib/plugins/ipc";
import { preparePackageFromBase64, InstallPrepError } from "../../lib/plugins/install.ts";
import {
  isKnownPermission,
  groupPermissions,
  type PermissionGroupBlock,
} from "../../lib/plugins/permissions.ts";
import { isInlineIconRef, iconDataUrl, iconMimeOf } from "../../lib/plugins/icon.ts";
import {
  readPluginViewSize,
  writePluginViewSize,
  clearPluginViewSize,
  limitsForScreen,
  resolveViewSize,
  centeredPosition,
  FULL_CENTER_RATIO,
  type SizeLimits,
  type ViewSize,
} from "../../lib/plugins/view-size.ts";
import { useSharedPluginRuntime } from "../config/usePluginRuntime.ts";
import type { PluginManifest } from "../../lib/plugins/manifest.ts";
import { compareVersion } from "../../lib/plugins/manifest.ts";
import { findPlugin, loadRegistry } from "../../lib/plugins/registry.ts";
import type { SearchItem } from "../../types/index";

const search = useSearchState();
const update = useUpdateChecker();
const { state, engine, placeholder, visibleResults } = search;

/** 应用内提示 / 确认（替代原生 alert/confirm：macOS WKWebView 不支持） */
const toast = useToast();
const message = useMessageDialog();

/**
 * 环境变量授权选择器（宿主 UI）。
 * 插件通过 `ms.env.pick` 调它；界面在模板末尾的 <EnvPicker> 上。
 * 注册表改动（写授权 / 重启进程）由 usePluginHost 负责，这里只管画界面。
 */
const envPicker = useEnvPicker();

// ============== 插件安装弹窗（搜索框 .mspp chip 点击 / 市场安装共用） ==============
const installDialogVisible = ref(false);
const installDialogManifest = ref<PluginManifest | null>(null);
const installDialogIcon = ref<string | null>(null);
const installDialogPerms = ref<PermissionGroupBlock[]>([]);
const installDialogWarnings = ref<string[]>([]);
/** 已安装版本（弹窗按钮据此显示 安装/重新安装/升级；null = 未安装） */
const installDialogInstalledVersion = ref<string | null>(null);
/** 该插件当前是否在后台运行（覆盖安装时弹窗提示「会先停止再安装」） */
const installDialogRunning = ref(false);
/**
 * 弹窗本次的来源：`file` = 从 .mspp 文件安装（chip 点击 / 文件选择器），
 * `market` = 市场安装（`ms.market.install` / `update`）。两者共用同一个弹窗组件，
 * 但落盘归属不同：文件安装由本组件负责（`pendingPrepared`），市场安装由
 * `host.ts` 负责——本组件只负责「问用户」，确认后把结果回传给市场调用方。
 */
let installDialogMode: "file" | "market" = "file";
/** 市场安装的确认 resolver（用户点「安装」→ true，「取消」→ false） */
let marketInstallResolver: ((ok: boolean) => void) | null = null;
/** 待安装的 .mspp 附件索引（确认后从 attachments 中移除；-1 = 不在附件里） */
let pendingInstallIndex = -1;
/** 待安装的 .mspp 文件路径（写入插件来源 source.ref，便于面板显示「来自哪个文件」） */
let pendingInstallPath = "";
/** 待安装的预处理结果（确认后直接落盘） */
let pendingPrepared: Awaited<ReturnType<typeof preparePackageFromBase64>> | null = null;

/**
 * 安装确认弹窗打开时的窗口高度（逻辑像素）。
 *
 * 弹窗是 fixed 遮罩（inset:0），不占文档流，`measuredBoxHeight` 永远量不到
 * 它——不主动撑高的话，它会居中在 48px 的折叠窗口里被裁掉（双击 .mspp 只
 * 看到 chip、看不到弹窗的观感就来自这里）。取 440 而不是更大值：窗口顶边
 * 固定在监视器约 22% 处，高 DPI 缩放下 520 逻辑像素会让底边越出屏幕
 * （按钮被裁）；卡片自身 max-height:80vh + 内部滚动兜底超长权限列表。
 *
 * 市场安装**不走这条高度逻辑**：触发时插件详情视图已经开着、窗口本就够高，
 * 再按 440 下发会与详情视图的高度管理（useDetailHeight / 插件自定义尺寸）打架。
 */
const INSTALL_DIALOG_HEIGHT = 440;

/** 打开安装确认弹窗（文件安装）：把窗口撑到弹窗高度，否则弹窗会被折叠窗口裁掉 */
function openFileInstallDialog(): void {
  installDialogMode = "file";
  installDialogVisible.value = true;
  void setWindowHeight(INSTALL_DIALOG_HEIGHT);
}

/** 关闭安装确认弹窗并清空展示状态（文件安装要恢复内容高度） */
function closeFileInstallDialog(): void {
  installDialogVisible.value = false;
  installDialogManifest.value = null;
  installDialogIcon.value = null;
  installDialogInstalledVersion.value = null;
  installDialogRunning.value = false;
  // 关闭后回到内容实测高度（取消时 chip 仍在搜索框、确认时已被摘掉，实测都正确）
  void syncWindowHeightToContent();
}

/**
 * 市场安装/更新的确认闸门（注入给 `ms.market.install` / `update`）。
 *
 * 由 `usePluginHost` 在插件调用市场安装时回调：把待装插件的清单/权限/警告摆给
 * 用户看，用户点「安装」返回 true，点「取消」（或按 Esc）返回 false。**真正的
 * 下载与落盘在 host.ts**——本组件只画界面、拿答复，插件拿不到也改不了待写入的
 * 内容。已有弹窗开着时直接返回 false：不叠弹窗，也不让第二次安装偷偷绕过确认。
 */
function confirmMarketInstall(req: PluginInstallConfirmRequest): Promise<boolean> {
  if (installDialogVisible.value) return Promise.resolve(false);
  installDialogMode = "market";
  installDialogManifest.value = req.manifest;
  installDialogIcon.value = req.iconUrl;
  installDialogPerms.value = req.permBlocks;
  installDialogWarnings.value = req.warnings;
  installDialogInstalledVersion.value = req.installedVersion;
  installDialogRunning.value = req.running === true;
  installDialogVisible.value = true;
  // 窗口高度不动：插件详情视图已把窗口撑到合适高度（见 INSTALL_DIALOG_HEIGHT 注释）
  return new Promise<boolean>((resolve) => {
    marketInstallResolver = resolve;
  });
}

/** 关闭市场安装弹窗并回传用户选择（先回传再复位，避免调用方卡在未决 Promise 上） */
function closeMarketInstallDialog(ok: boolean): void {
  installDialogVisible.value = false;
  installDialogManifest.value = null;
  installDialogIcon.value = null;
  installDialogInstalledVersion.value = null;
  installDialogRunning.value = false;
  installDialogMode = "file";
  const resolve = marketInstallResolver;
  marketInstallResolver = null;
  resolve?.(ok);
}

/** 详情视图内容（null = 未打开） */
const detail = ref<DetailContent | null>(null);
/** 详情视图是否显示 */
const detailVisible = ref(false);

const searchBoxRef = ref<InstanceType<typeof SearchBox> | null>(null);
const detailRef = ref<InstanceType<typeof DetailView> | null>(null);

/** 输入框值（v-model） */
const inputValue = ref("");

/** 附加在搜索框里的文件/文件夹（粘贴/拖入产生；过滤谓词与插件 ms.input 的数据源） */
const attachments = ref<AttachedEntry[]>([]);
/** 系统正向窗口拖入文件（Tauri 拖拽事件 → 搜索框高亮） */
const draggingFiles = ref(false);

/**
 * 「最近添加」历史（Alt 条带的数据源）。与 attachments 分开存：复位会清
 * 附件（下次呼出干净搜索框），但历史必须留下——它就是条带存在的意义。
 */
const recentFiles = ref<AttachedEntry[]>([]);
/** Alt 条带是否展开（显示在搜索框下方；用普通流内布局，窗口随之长高） */
const recentVisible = ref(false);

/**
 * 最近一次「窗口被呼出」的时刻（performance.now()，0=本次会话尚未呼出过）。
 *
 * 用途：Alt+点击带入时 Alt 是**按住的**（在资源管理器里按下，keydown 发生
 * 在资源管理器、不在本窗口）。窗口获得焦点后若用户仍按着 Alt 再补一次
 * 按下，理论上会在本窗口产生 keydown 而弹出条带——这不是我们要的。
 * 呼出后的极短时间内屏蔽条带展开，把「点击带入」与「输入框里按 Alt」彻底分开。
 */
let summonedAt = 0;
/** 呼出后屏蔽条带展开的时长（覆盖焦点落定 + 按键抖动） */
const SUMMON_STRIP_GUARD_MS = 400;

/** 标记刚被呼出（在 onMainWindowShown 里调用） */
function markSummoned(): void {
  summonedAt = performance.now();
}

/**
 * 附件变更统一入口：改状态 → 登记到 Rust（读取/列举的第二道校验依据）
 * → 重算过滤谓词 → 立即刷新结果列表。
 *
 * 详情视图打开时不重搜（与 attachPluginItems 的守卫同理：不能把用户
 * 正在看的插件界面踢回结果列表）；谓词是惰性的，退出视图后下一次搜索
 * 自然会带上最新附件状态。
 */
function applyAttachments(next: AttachedEntry[]): void {
  // 先 diff 出「本次新增」（粘贴 / 拖入 / Explorer Alt+点击带入的统一尾部，
  // 在这里记录一次即覆盖全部来源），再落附件状态。
  const prevKeys = new Set(attachments.value.map(attachmentKey));
  const added = next.filter((e) => !prevKeys.has(attachmentKey(e)));
  const removed = prevKeys.size !== next.length;
  attachments.value = next;
  if (added.length > 0) {
    // 传入「已固定的 key 集合」：新增条目本身不带 pinned，其固定态继承历史，
    // 且固定条目不参与 30 条上限淘汰。
    recentFiles.value = mergeRecentAttachments(
      recentFiles.value,
      added,
      RECENT_ATTACH_CAP,
      pinnedKeys.value
    );
    storageSet(RECENT_ATTACH_KEY, recentFiles.value);
  }
  // 条带正开着时，附件增减会让条带列表跟着增减（stripFiles 与附件互斥），
  // 行高可能变化：等 DOM 更新后按新高度重下发窗口尺寸。
  if (recentVisible.value && (added.length > 0 || removed)) {
    void nextTick(syncWindowHeightToContent);
  }
  void attachmentsSync(next.map((e) => ({ path: e.path, isDir: e.kind === "folder" }))).catch(
    (e) => {
      debug("[附件] 同步附件路径到 Rust 失败:", e);
    }
  );
  engine.resultFilter = buildAttachmentFilter(next, () => pluginHost.activePlugins());
  // 打开着的插件视图不知道附件变了：广播一次，由各会话自行响应
  //（文件搜索据此自动重扫）。必须放在下面的守卫之前——那个守卫只挡
  // 结果列表重搜，不能把通知也挡住。
  pluginViewHost.notifyAttachmentsChanged();
  if (state.mode === MODE.SHOW_ITEM_DETAIL) return;
  void search.doSearch(inputValue.value);
}

/** 粘贴 / 拖入新附件（合并去重后应用） */
function onAttachEntries(entries: AttachedEntry[]): void {
  if (!entries?.length) return;
  applyAttachments(mergeAttachments(attachments.value, entries));
}

/** 移除第 index 个附件 */
function onDetachEntry(index: number): void {
  const next = attachments.value.slice();
  if (index < 0 || index >= next.length) return;
  next.splice(index, 1);
  applyAttachments(next);
}

/** 点击 .mspp 插件包 chip：读取 → 预处理 → 弹出安装确认 */
async function onChipClick(index: number): Promise<void> {
  const entry = attachments.value[index];
  if (!entry || !entry.path || !entry.name.toLowerCase().endsWith(".mspp")) return;
  await openInstallDialogForPath(entry.path, index);
}

/**
 * 打开某个 `.mspp` 文件的安装确认弹窗（读取 → 预处理 → 填弹窗数据）。
 *
 * 两个调用方共用：搜索框里点 chip（`onChipClick`）、外部打开的兜底路径。
 * `attachIndex` 是该文件在附件里的下标
 * （不在附件里时传 -1）——只用于安装成功后把它从附件里摘掉。
 */
async function openInstallDialogForPath(path: string, attachIndex: number): Promise<void> {
  let b64: string;
  try {
    b64 = await readLocalFileBase64(path);
  } catch (e) {
    toast.showToast(`读取文件失败：${String((e as Error)?.message ?? e)}`, "error");
    return;
  }

  let prepared: Awaited<ReturnType<typeof preparePackageFromBase64>>;
  try {
    prepared = await preparePackageFromBase64(b64, {
      hostVersion: typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : null,
      checkPermissions: isKnownPermission,
    });
  } catch (e) {
    const msg = e instanceof InstallPrepError ? e.message : `安装包解析失败：${String((e as Error)?.message ?? e)}`;
    toast.showToast(msg, "error");
    return;
  }

  const mf = prepared.manifest;
  const allPerms = [...(mf.permissions ?? []), ...(mf.optionalPermissions ?? [])];

  // 构造 logo data URL（从 prepared.files 中按 manifest.icon 路径查找 base64）
  let iconUrl: string | null = null;
  const iconRef = mf.icon;
  if (iconRef) {
    if (isInlineIconRef(iconRef)) {
      iconUrl = iconRef;
    } else {
      const iconFile = prepared.files.find((f) => f.path === iconRef);
      if (iconFile) {
        iconUrl = iconDataUrl(iconRef, iconFile.data);
      }
    }
  }

  pendingInstallIndex = attachIndex;
  pendingInstallPath = path;
  pendingPrepared = prepared;
  installDialogManifest.value = mf;
  installDialogIcon.value = iconUrl;
  installDialogPerms.value = groupPermissions(allPerms);
  installDialogWarnings.value = prepared.warnings;
  // 直读注册表取已安装版本（另一窗口可能刚装过，比共享运行时的内存态更新）
  installDialogInstalledVersion.value = findPlugin(loadRegistry(), mf.id)?.version ?? null;
  // 覆盖安装且后台在跑：弹窗提示「会先停止再安装」（真停由 Rust 侧 plugin_install 做）
  installDialogRunning.value = false;
  if (installDialogInstalledVersion.value) {
    const { listPluginBackends } = await import("../../lib/plugins/ipc");
    try {
      const st = (await listPluginBackends()).find((s) => s.pluginId === mf.id)?.status;
      installDialogRunning.value = st === "running" || st === "starting";
    } catch (e) {
      /* 无 Rust 侧（浏览器调试）：按未运行处理 */
    }
  }
  openFileInstallDialog();
}

/**
 * 「从外部打开插件包」（双击 .mspp / 命令行传入）现由**设置窗口**处理：
 * Rust 端打开配置窗口并广播事件，配置窗口切到插件面板弹安装确认。
 * 搜索窗口不再监听该事件，避免两边抢同一个幂等待处理槽。
 * 这里保留 chip 点击安装（onChipClick → openInstallDialogForPath）不变。
 */

/** 安装确认弹窗：用户点击「安装」（市场安装只回传答复，落盘在 host.ts） */
async function onInstallConfirm(): Promise<void> {
  if (installDialogMode === "market") {
    closeMarketInstallDialog(true);
    return;
  }
  const prepared = pendingPrepared;
  // 先关弹窗并恢复内容高度：落盘要走 IPC，期间不该继续占着弹窗高度
  closeFileInstallDialog();
  if (!prepared) return;

  const mf = prepared.manifest;
  const allPerms = [...(mf.permissions ?? []), ...(mf.optionalPermissions ?? [])];
  const sourcePath = pendingInstallPath;
  // 落盘前取原版本：成功后按 安装/重装/升级 给出对应文案
  const prevRec = findPlugin(loadRegistry(), mf.id);

  try {
    const rt = useSharedPluginRuntime();
    await rt.installFromFiles({
      manifest: mf,
      dir: `plugins/${mf.id}`,
      files: prepared.files,
      source: { kind: "file", ref: sourcePath },
      sha256: prepared.sha256,
      grants: allPerms,
    });

    // 安装成功：从附件中移除该 .mspp（-1 = 该文件不在附件里，无需摘除）
    if (pendingInstallIndex >= 0) onDetachEntry(pendingInstallIndex);
    const cmp = prevRec ? compareVersion(mf.version, prevRec.version) : null;
    const verb = cmp === null ? "已安装" : cmp === 0 ? "已重新安装" : "已升级";
    toast.showToast(`${verb}「${mf.name}」v${mf.version}`, "ok");
  } catch (e) {
    toast.showToast(`安装失败：${String((e as Error)?.message ?? e)}`, "error");
  } finally {
    pendingInstallIndex = -1;
    pendingInstallPath = "";
    pendingPrepared = null;
  }
}

/** 安装确认弹窗：用户点击「取消」（市场安装只回传答复，host.ts 不落盘） */
function onInstallCancel(): void {
  if (installDialogMode === "market") {
    closeMarketInstallDialog(false);
    return;
  }
  pendingInstallIndex = -1;
  pendingInstallPath = "";
  pendingPrepared = null;
  closeFileInstallDialog();
}

/** 移除最后一个附件（Backspace 在空输入时的逐级退格） */
function popAttachment(): void {
  onDetachEntry(attachments.value.length - 1);
}

/** 清空附件并撤下过滤谓词（复位视图时；不触发重搜——调用方随后会清结果） */
function clearAttachments(): void {
  if (attachments.value.length === 0 && engine.resultFilter == null) return;
  attachments.value = [];
  engine.resultFilter = null;
  pluginViewHost.notifyAttachmentsChanged();
  void attachmentsSync([]).catch(() => {});
}

/** 拖放落地：路径 → 名称/类型描述 → 并入附件 */
async function attachByPaths(paths: string[]): Promise<void> {
  try {
    const described = await describePaths(paths);
    onAttachEntries(
      described.map((d) => ({
        kind: d.isDir ? ("folder" as const) : ("file" as const),
        name: d.name,
        path: d.path,
      }))
    );
  } catch (e) {
    warn("[附件] 解析拖入路径失败:", e);
  }
}

/** 结果列表是否显示（在非详情视图且有结果时展示） */
const resultVisible = computed(
  () => !detailVisible.value && state.results.length > 0 && state.mode === MODE.SHOW_RESULT
);

// ============== 脚本宿主 ==============
const scriptHost = useScriptHost({
  engine,
  fitHeight: () => detailRef.value?.fitHeight(),
  flushHeight: () => detailRef.value?.flushHeight(),
  hideTextView: () => hideTextView(),
  doSearch: (kw) => void search.doSearch(kw),
  // 脚本视图挂载完成后自动转发子关键词（读/写搜索框）
  getInputValue: () => inputValue.value,
  setInputValue: (kw) => {
    inputValue.value = kw;
  },
});

// ============== 插件宿主 ==============
/**
 * 数据同步桥（插件的 `ms.sync.*`）。
 *
 * 提前创建：`usePluginHost` 的选项里直接引用它（`syncNow` / `syncStatus`），
 * 而它本身只是几个闭包，真正建同步引擎要等 `ensure()` 判定确有插件申请后才做。
 */
const syncBridge = useSyncBridge();
/** 插件注册表 + 宿主 API 网关（授权弹窗 / 搜索数据 / 存储 / 网络…） */
const pluginHost = usePluginHost({
  getSearchData: () => engine.searchData,
  getAttachments: () => attachments.value,
  triggerSearch: (kw) => {
    inputValue.value = kw;
    void search.doSearch(kw);
  },
  setInput: (text) => {
    inputValue.value = text;
  },
  hideDetail: () => hideTextView(),
  toast: (text, type) => toast.showToast(text, type ?? "ok"),
  confirm: (text) => message.showMessage(text, { title: "插件请求" }),
  getSelectedText: (hint) => scriptHost.getSelectedText(hint),
  // 插件 ms.env.pick：打开宿主的授权选择器（界面在模板末尾的 <EnvPicker> 上）
  openEnvPicker: (req) => envPicker.openEnvPicker(req),
  // 插件 ms.market.install / update：打开宿主的安装确认弹窗（界面在模板末尾的
  // <PluginInstallDialog> 上）。用户确认后 host.ts 才下载落盘，取消则不装。
  confirmPluginInstall: (req) => confirmMarketInstall(req),
  onItemsChanged: () => {
    // 装/卸/禁用插件后：重新合成插件项，已有输入时立即重搜
    search.attachPluginItems();
  },
  // 插件界面内改主题（ms.ui.applyTheme）：转发给视图宿主，由它切整个呼出窗口的主题。
  // pluginViewHost 在本行之后才创建，但这里只在**调用时**求值，晚绑定即可。
  refreshPluginTheme: () => pluginViewHost.refreshActiveTheme(),
  // 数据同步（ms.sync.*）：由 App.vue 的 syncBridge 注入，engine 的创建/销毁在那边。
  syncNow: () => syncBridge.now(),
  syncStatus: () => syncBridge.status(),
  // 开发目录里的插件改了：按需重挂已打开的界面（判定在 usePluginHost 里，
  // 用的是纯函数 decideViewReload；这里只执行 DOM 侧的动作）。
  // 「已打开」包括**保活中的会话**——它内存里跑的是旧代码，不重挂就等于改了没反应。
  onDevPluginReloaded: (info) => {
    const decision = decideViewReload({
      activePluginId: pluginViewHost.activePluginId.value,
      pluginId: info.record.id,
      paths: info.paths,
      entry: info.record.manifest.contributes?.detailView?.entry,
      script: info.record.manifest.contributes?.detailView?.script,
      versionChanged: info.versionChanged,
      name: info.record.name,
      parkedPluginIds: pluginViewHost.keepAliveIds(),
    });
    if (!decision.remount) return;
    void remountPluginView(info.record.id, decision.notice);
  },
});

/**
 * 重挂已打开的插件视图（开发热重载用）。
 *
 * 为什么走「合成一个数据项 → open()」而不是原地刷新：插件的入口 HTML/CSS/JS
 * 是挂载时一次性读入并执行的（见 usePluginViewHost.mountSession），原地刷新没有
 * 对应的接口；而 `open()` 本就是「收掉旧的 + 挂新的」，且它需要的载体数据项
 * 由 `itemForPlugin` 现成合成（快捷键打开插件走的就是这条路）。
 *
 * 重挂前必须**强制卸载**旧会话：保活（最小化）的会话同理——它内存里跑的是旧代码，
 * 而且 `decideViewRestore` 会因为入口没变而选择「恢复」，那就等于改了没反应。
 *
 * 重挂会丢掉插件视图内的内存态（正在输入的内容等），因此给一条提示。
 */
async function remountPluginView(pluginId: string, notice: string | null): Promise<void> {
  const item = pluginHost.itemForPlugin(pluginId);
  const wasForeground = detailVisible.value && state.mode === MODE.SHOW_ITEM_DETAIL && pluginViewHost.isActive();
  // 无条件卸载旧会话（不按 closeBehavior：这里的旧代码必须消失）
  pluginViewHost.release(pluginId, "开发热重载：按新文件重新挂载");
  if (!item) return; // 插件被禁用 / 卸载：视图会在下次交互时自然收起
  if (!wasForeground) {
    // 保活中的后台会话：已卸载，等用户下次打开自然读到新文件（此时不必打断用户）
    if (notice) toast.showToast(notice, "ok");
    return;
  }
  try {
    await pluginViewHost.open(item);
    // 重挂后按内容重新下发窗口高度（否则会沿用旧内容的测量结果）
    detailRef.value?.onScriptMounted();
    if (notice) toast.showToast(notice, "ok");
  } catch (e) {
    warn(`[插件] 开发热重载重挂失败 (${pluginId}):`, e);
    
    // 重挂失败后的降级处理：提示用户手动刷新
    toast.showToast(
      // 名字取注册表记录：itemForPlugin 合成的载体项并不带 `plugin` 字段，
      // 原来读 `item.plugin.name` 会在 catch 里再抛一次 TypeError，toast 反而弹不出来
      `「${pluginHost.get(pluginId)?.name ?? pluginId}」自动热重载失败，请尝试刷新或重启插件`,
      "error"
    );
  }
}

/** 插件详情视图宿主（渲染 detailView.entry + 入口脚本） */
const pluginViewHost = usePluginViewHost({
  getRecord: (id) => pluginHost.get(id),
  createApi: (id) => pluginHost.apiFor(id),
  hostContext: pluginHost.hostContext(),
  readText: (id, rel) => pluginHost.readText(id, rel),
  matchSearch: (kw) => scriptHost.matchSearchByOverlap?.(kw) ?? Promise.resolve([]),
  getInputValue: () => inputValue.value,
  setInputValue: (kw) => {
    inputValue.value = kw;
  },
  fitHeight: () => detailRef.value?.fitHeight(),
  flushHeight: () => detailRef.value?.flushHeight(),
  container: computed(() => detailRef.value?.pluginContainer ?? null),  
  onError: (id, msg) => warn(`[插件 ${id}]`, msg),
  // 关闭界面时是否停后台进程由插件的 closeBehavior 决定（判定在 usePluginViewHost.clear）
  stopBackend: (id) => pluginHost.stopBackend(id),
});

// 宿主检索 / 加权实现注入（插件 ms.search.query / ms.search.score 用）
bindPluginHostRuntime({
  search: (kw) => engine.search(kw),
  score: (item) => scoreSelect(item),
});

// ============== 数据同步（插件 ms.sync.*） ==============
/**
 * 有「已启用且已授予 sync」的插件时才建同步引擎。
 *
 * 计数由插件宿主维护（它在注册表每次变化后重算），是一个响应式 ref——
 * 插件被装上、被启用、被授权、被撤销都会让它变化，引擎随之启停。
 * 没有插件申请该权限时**完全不建引擎**：不给用户平白多一个后台定时器。
 */
watch(
  () => pluginHost.syncConsumerCount.value,
  (n) => {
    void syncBridge.ensure(n > 0);
  },
  { immediate: true }
);

onBeforeUnmount(() => syncBridge.dispose());

// ============== 视图高度 ==============
/**
 * 由内容决定高度：渲染完成后实测 #my_search_box 的 offsetHeight 并下发。
 *
 * 为什么只量 #searchBox / #matchResult / #text_show 三个视图子节点、而不是
 * 直接读盒子的 offsetHeight：盒子里还住着**弹层节点**（toast、确认弹窗）。
 * 它们本该是 fixed/absolute 的（不参与布局），但只要有一条样式漏了（历史上
 * 真的漏过一次：搜索窗的 #cfgToast 没有 fixed 规则），它们就会被当成普通块
 * 撑高盒子——而下发的高度是白名单值（48 / 内容高度），多出来的部分只会溢出
 * 窗口，表现为**搜索框下边框消失**。按视图子节点求和可以让这层错误无法生效。
 * #recentStrip（Alt 最近条带）是盒子内的正经流内视图节点（搜索框下方），
 * 一并入列参与实测；收起时 display:none → offsetHeight 0 天然不计入。
 */
const VIEW_PART_IDS = ["searchBox", "recentStrip", "matchResult", "text_show"] as const;

function measuredBoxHeight(): number {
  const box = document.getElementById("my_search_box");
  if (!box) return BOX_HEIGHT;
  let sum = 0;
  for (const id of VIEW_PART_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    // display:none 的节点 offsetHeight 为 0，天然不参与
    sum += el.offsetHeight;
  }
  // 上下各 2px 灰边框（盒子是 border-box，视图子节点只覆盖内容区）
  const borders = box.offsetHeight - (box.clientHeight || box.offsetHeight);
  const total = sum > 0 ? sum + Math.max(0, borders) : box.offsetHeight;
  // 与盒子实测取小者：求和路径只用于「兜住异常撑高」，正常情况下两者一致。
  return Math.min(total, box.offsetHeight);
}

async function syncWindowHeightToContent(): Promise<void> {
  await nextTick();
  void setWindowHeight(measuredBoxHeight());
}

/** 收起窗口到「搜索框」高度 */
function collapseToBoxHeight(): void {
  void setWindowHeight(BOX_HEIGHT);
}

// ============== 视图切换 ==============
/** 结束脚本 / 插件视图会话 + 关闭详情视图 */
function hideTextView(): void {
  scriptHost.clearScriptSession();
  // 插件视图：按插件设置「最小化」（停靠保活）或「退出」（卸载），
  // 由视图宿主内部判定；这里只负责收掉详情视图本身。
  pluginViewHost.clear();
  // 清掉插件自定义窗口尺寸（宽度覆盖置回 null），若确实离开插件态则复位窗口位置
  // （插件页把窗口移过位，退出后必须回到常态居中的位置）。
  restoreWindowPositionIfPluginExited();
  detailVisible.value = false;
  state.mode = state.results.length > 0 ? MODE.SHOW_RESULT : MODE.WAIT_SEARCH;
  void nextTick(() => {
    if (state.results.length > 0) {
      void syncWindowHeightToContent();
    } else {
      collapseToBoxHeight();
    }
  });
}

/** 显示文本详情（简述内容 / 附加内容） */
function showTextView(title: string, desc: string, body: string): void {
  scriptHost.clearScriptSession();
  pluginViewHost.clear();
  // 从插件视图切到文本详情：同样要复位窗口位置（否则文本详情停在插件的位置）
  restoreWindowPositionIfPluginExited();
  detail.value = { kind: "text", title, desc, body };
  detailVisible.value = true;
  state.mode = MODE.SHOW_ITEM_DETAIL;
}

/** 显示脚本视图 */
function showScriptView(item: SearchItem): void {
  // 从插件视图切到脚本视图：同样复位位置
  restoreWindowPositionIfPluginExited();
  detail.value = { kind: "script", title: item.title ?? "", desc: "脚本项", body: "", item };
  detailVisible.value = true;
  state.mode = MODE.SHOW_ITEM_DETAIL;
}

/**
 * 复位到初始视图：清空输入/结果/详情，并把窗口收回到搜索框高度。
 *
 * 呼出（隐藏前非详情视图）与点击 URL 结果时调用。
 */
function resetToInitialView(): void {
  detailVisible.value = false;
  detail.value = null;
  inputValue.value = "";
  state.results = [];
  state.activeIndex = -1;
  state.rawKeyword = "";
  state.mode = MODE.WAIT_SEARCH;
  search.debouncedSearch.cancel();
  scriptHost.clearScriptSession();
  pluginViewHost.clear();
  restoreWindowPositionIfPluginExited();
  // 附件随「复位」一并清掉（与老油猴版 viewHide 后 clear 一致）：
  // 下次呼出是干净的搜索框，不会带着上次的文件继续过滤结果。
  clearAttachments();
  // 条带随复位收起。呼出路径已在 onMainWindowShown 里静默清过标记
  //（Rust 刚绝对复位过窗口，这里再移反而会推错）；点击 URL 等**未经
  // 重新定位**的复位走完整收起，把窗口等量移回。
  hideRecentStrip();
  // 复位时不要无条件刷回默认提示：若订阅数据仍在加载中，
  // 必须继续显示「正在加载订阅数据...」，否则会表现为静默加载。
  search.restoreLoadingPlaceholderIfNeeded();
  collapseToBoxHeight();
}

/**
 * 呼出时的视图分支（用户规则）：
 * - 隐藏前是详情视图 → 失焦只是「先隐藏」，再次呼出**原样还原**（DOM 未销毁、输入框未动）
 * - 其它状态（等待搜索 / 结果列表）→ 交给 resetToInitialView() 复位
 * @returns true=详情视图已原样还原（调用方跳过复位）
 */
function resumeDetailViewIfAny(): boolean {
  if (state.mode !== MODE.SHOW_ITEM_DETAIL || !detailVisible.value) return false;
  // 原样还原：窗口高度贴回内容。
  // 隐藏时 Rust 侧已把窗口物理收回到 48px，因此必须强制重新下发高度：
  // 先清掉 fitTextViewHeight 的去重缓存，再重新测量。
  detailRef.value?.resetHeightCache();
  void nextTick(() => {
    detailRef.value?.reapply();
    detailRef.value?.flushHeight();
    // 插件详情：呼出时 Rust 已把窗口复位成屏幕分档宽，必须重新套用该插件的
    // 记忆尺寸（否则会退回默认尺寸，用户拖出来的大小「白记了」）。
    // 只在**确实有自定义尺寸**时套用（宽度覆盖非空）：没有记忆的插件应继续
    // 走内容自适应，不能被误锁成打开那一刻的默认高度。
    if (getWindowWidthOverride() != null) {
      const size = pluginWindowSize.value;
      if (size) void applyPluginWindowSize(size, true, true);
    }
  });
  return true;
}
// ============== 插件视图窗口尺寸（拖拽改大小 + 按插件记忆） ==============
/**
 * 插件页允许用户拖右下角改变**整个主窗口**的宽高，尺寸按插件隔离记忆。
 *
 * 三处状态：
 *   - `pluginWindowSize`：当前生效的窗口尺寸（逻辑像素），供 DetailView 的
 *     拖拽手柄当起点；非插件视图时为 null。
 *   - `pluginSizeLimits`：上下限。min = 打开插件那一刻的「默认尺寸」（屏幕分档宽
 *     + 内容自适应高），用户只能放大不能缩小；max = 屏幕 90% 宽 / 屏高。
 *   - `pluginSizeBase`：该插件的默认尺寸，供「恢复默认大小」回到原状。
 *
 * 生命周期：openPluginView 成功后 applyPluginViewSize 设置 → 拖拽实时更新 →
 * 「关闭/切走/复位」时 clearPluginViewSizeState 清除（并把宽度覆盖置回 null，
 * 让普通搜索恢复屏幕分档宽度）。
 */
const pluginWindowSize = ref<ViewSize | null>(null);
const pluginSizeLimits = ref<SizeLimits | null>(null);
const pluginSizeBase = ref<ViewSize | null>(null);
const pluginSizeId = ref<string | null>(null);
/**
 * 打开插件时缓存的目标显示器矩形（逻辑像素）。
 *
 * 拖动中**不**重新查询显示器（每次 setPosition 前都 IPC 一次会让拖拽掉帧）：
 * 一次拖拽不会跨屏，用打开时缓存的值算居中即可。拿不到时保持 null，松手后
 * 跳过定位（尺寸仍然正确）。
 */
let pluginMonitorRect: { x: number; y: number; width: number; height: number } | null = null;

/** 给 #my_search_box 加/去「插件拉伸」作用域类（内容随窗口铺满，见 style.css） */
function setPluginSizedClass(on: boolean): void {
  const box = document.getElementById("my_search_box");
  if (!box) return;
  const changed = box.classList.contains("plugin-sized") !== on;
  box.classList.toggle("plugin-sized", on);
  // 布局形态翻转（进出拉伸态）会让 #text_show 在「可滚动 ↔ overflow:hidden」之间
  // 切换：切到 hidden 后它原有的 scrollTop 会残留且用户滚不回去（见
  // resetTextViewScroll 的说明）。故一切换就清零。
  if (changed) resetTextViewScroll();
}

/**
 * 把 `#text_show` 的滚动位置复位到左上角（scrollTop/scrollLeft = 0）。
 *
 * ## 为什么必须复位（窗口改大小后「滚不回前面」的根因）
 *
 * `#text_show` 有两种形态（见 style.css）：
 *   - **常态**（文本详情/普通结果）：`overflow-y:auto` + `max-height:510px`——
 *     它是滚动容器，用户可在此滚动；
 *   - **插件拉伸态**（`.plugin-sized`）：`overflow:hidden` + `height:100%`——
 *     滚动交给**插件自己的内部容器**，`#text_show` 不应再有滚动。
 *
 * 问题是：浏览器在 `overflow:hidden` 下**仍保留并可编程设置** `scrollTop`——
 * 元素切到 hidden 前若已有滚动偏移（先前文本详情滚过、或改窗口大小时浏览器
 * 的**滚动锚定**在反复重排中把 `scrollTop` 顶上去），这个偏移会一直留着；而
 * hidden 没有滚动条、插件内部滚动也与它无关，于是**顶部内容被裁掉且用户无法
 * 滚回去**——正是「前面还有内容但滚不到前面」。
 *
 * 因此在「进出插件拉伸态」这类布局翻转点、以及尺寸过渡结束后，显式把它清零。
 */
function resetTextViewScroll(): void {
  const textView = document.getElementById("text_show");
  if (!textView) return;
  textView.scrollTop = 0;
  textView.scrollLeft = 0;
}

/**
 * 尺寸过渡（窗口与内容严格同步）。
 *
 * 由 Rust 原生线程按帧改**窗口**尺寸驱动（见 tauri-bridge.animateWindowSize 的
 * 说明）：每帧窗口变化，内容靠 CSS `height:100%` 解析视口自然铺满——窗口与内容
 * 同帧变化，不会出现「窗口先放大、内容再放大」的二次观感。
 *
 * 因此这里**不需要**任何前端内容补偿（早期曾用 transform 缩内容或逐帧钉像素，
 * 都会与窗口形成两条时间线而穿帮）。
 */
async function animateWindowSizeWithContent(w: number, h: number): Promise<void> {
  await animateWindowSize(w, h);
  // 过渡期间浏览器可能因滚动锚定改动 #text_show.scrollTop；结束后复位一次，
  // 保证插件内容回到左上（否则顶部被裁且 hidden 态下滚不回去）。
  resetTextViewScroll();
}

/**
 * 取「默认尺寸」：宽度用当前窗口逻辑宽（即屏幕分档宽），高度用当前实测的
 * 盒子高度（内容自适应高）。二者与打开插件那一刻的窗口一致，故作为最小值。
 *
 * 读不到实测值时回退：宽 800、高 BOX_HEIGHT，保证不崩。
 */
function currentDefaultPluginSize(): ViewSize {
  const box = document.getElementById("my_search_box");
  const width = window.innerWidth > 0 ? window.innerWidth : 800;
  const height = box?.offsetHeight && box.offsetHeight > 0 ? box.offsetHeight : BOX_HEIGHT;
  return { width, height };
}

/** 打开插件后应用其记忆尺寸（无记忆则维持默认内容自适应尺寸，只记上下限） */
async function applyPluginViewSize(pluginId: string): Promise<void> {
  pluginSizeId.value = pluginId;
  const base = currentDefaultPluginSize();
  pluginSizeBase.value = base;
  const rect = await getMainMonitorRect();
  // 拿不到显示器信息时不要用 {0,0}：那会让 max 塌成「默认尺寸」，用户完全拖不大。
  // 退回 webview 的 window.screen（一定可用），保证至少有一个合理的放大上限。
  const screenRect = rect ?? {
    width: window.screen?.availWidth || window.innerWidth || base.width,
    height: window.screen?.availHeight || window.innerHeight || base.height,
  };
  pluginMonitorRect = rect ?? null;
  const limits = limitsForScreen(screenRect, base);
  pluginSizeLimits.value = limits;

  const remembered = readPluginViewSize(pluginId);
  if (!remembered) {
    // 首次打开：不改窗口（保持内容自适应），并解除手动高度锁 + 拉伸类——
    // 这次的高度仍由内容决定，用户一旦拖拽，onPluginResize 会重新上锁/加类。
    pluginWindowSize.value = base;
    setWindowWidthOverride(null);
    setDetailManualHeightLock(false);
    setPluginSizedClass(false);
    return;
  }
  const size = resolveViewSize(remembered, base, limits);
  pluginWindowSize.value = size;
  // 有记忆尺寸：上锁 + 启用拉伸（内容铺满窗口），否则插件内容一变就会把记忆的
  // 高度打回内容高度、且窗口变高时内容不跟着长（下方留白）。
  setDetailManualHeightLock(true);
  setPluginSizedClass(true);
  // 打开插件（尤其从「记忆尺寸」恢复）用平滑过渡，避免瞬间跳变
  await applyPluginWindowSize(size, true, true);
}

/**
 * 下发插件窗口尺寸。
 *
 * @param reposition true = 同时按「上下左右完全居中」重新定位（插件页调整过
 *   大小后按用户要求改为完全居中，而非常态搜索窗的顶部 22%）；
 *   false = 只改宽高，left/top 保持不动（拖动中用它，窗口才不会上下滑动）。
 */
async function applyPluginWindowSize(size: ViewSize, reposition: boolean, animate = false): Promise<void> {
  setWindowWidthOverride(size.width);
  // 把拉伸态盒子的高度钉进 CSS 变量（详见 pinPluginBoxHeight / syncPluginBoxHeight 注释）：
  //   - 即时路径（拖拽 / 松手，animate=false）：按**本次目标高度**预钉，再下发 setSize。
  //     视口更新永远滞后于窗口尺寸，此刻读 innerHeight 只会拿到旧的（更小的）值，
  //     盒子比窗口矮就下方留白 = 用户报的「下面的高度被压缩」。用已知目标预钉，
  //     盒子与窗口同帧对齐，不再依赖 resize 事件何时到达。
  //   - 过渡路径（打开记忆尺寸，animate=true）：清除变量，让 height:100% 逐帧解析
  //     视口，窗口与内容同帧生长（animateWindowSizeWithContent）；动画落定后由
  //     resize 监听把实测值重新钉回。
  if (animate) unpinPluginBoxHeight();
  else pinPluginBoxHeight(size.height);
  // 位置**先**一次到位（瞬时），随后尺寸才在原地过渡——动画期间窗口不滑动，
  // 视觉更稳，且位置变更不被动画时长拖延。
  if (reposition && pluginMonitorRect) {
    const pos = centeredPosition(pluginMonitorRect, size, FULL_CENTER_RATIO);
    await setWindowPosition(pos.x, pos.y);
  }
  if (animate) {
    await animateWindowSizeWithContent(size.width, size.height);
  } else {
    await applyWindowSize(size.width, size.height);
  }
}

/**
 * 拉伸态盒子的高度控制（CSS 变量 `--plugin-view-height`）。
 *
 * 背景：`#my_search_box` 在拉伸态用 `height: var(--plugin-view-height, 100%)`，
 * 而不是直接 `height:100%`——因为窗口的 `setSize` 是异步的，**视口更新永远
 * 滞后于窗口尺寸**。滞后的一帧里 `100%` 解析到旧的（更小的）视口，搜索框 +
 * 插件被一起压在顶部、下方留白，即用户看到的「下面被压缩」。
 *
 * 变量有两个来源，分工明确：
 *   - `pinPluginBoxHeight(target)`：**主动预钉**。下发尺寸前就知道目标高度，
 *     直接写进去，盒子与窗口同帧对齐——不依赖任何事件，也没有滞后窗口期。
 *     即时路径（拖拽 / 松手）用它，这是「首次拖拽也会压缩」的根治点。
 *   - `syncPluginBoxHeight()`：**按实测视口纠正**。窗口 resize 后把实测
 *     `innerHeight`（CSS 像素，与布局同单位）写回变量，覆盖 DPI 取整等偏差，
 *     也是 OS 直接拉伸窗口（拖窗口边框 / 贴边）时唯一的纠正通道。
 */

/**
 * 按目标高度主动预钉变量（下发 setSize 之前调用，保证盒子不落在窗口之后）。
 *
 * 只写变量，不动 `.plugin-sized` 类——类由 setPluginSizedClass 统一管理（它还负责
 * 布局翻转时复位 #text_show 滚动）。变量在类缺席时不生效，提前写入无害；
 * 一旦类生效即立刻拿到正确高度，不会经过「100% 解析旧视口」的那一帧。
 */
function pinPluginBoxHeight(height: number): void {
  if (!Number.isFinite(height) || height <= 0) return;
  document.getElementById("my_search_box")?.style.setProperty("--plugin-view-height", `${Math.round(height)}px`);
}

/** 解除主动预钉（清空变量，退回 `height:100%` 逐帧跟随视口；过渡动画用） */
function unpinPluginBoxHeight(): void {
  document.getElementById("my_search_box")?.style.removeProperty("--plugin-view-height");
}

/**
 * 把拉伸态 `#my_search_box` 的高度纠正到**当前实测视口高度**。
 *
 * 由 `window` 的 resize 事件调用：视口更新到位的下一帧把变量纠正回真实值，
 * 对预钉值形成一次实测校验（DPI / 取整差异），也是 OS 直接拉伸窗口时的唯一通道。
 * 未拉伸时不写（变量规则只在 .plugin-sized 命中，但清零更干净）。
 */
function syncPluginBoxHeight(): void {
  const box = document.getElementById("my_search_box");
  if (!box) return;
  if (!box.classList.contains("plugin-sized")) {
    box.style.removeProperty("--plugin-view-height");
    return;
  }
  const h = window.innerHeight;
  if (h > 0) box.style.setProperty("--plugin-view-height", `${h}px`);
}

/** 拖拽中：更新尺寸并实时下发（不 reposition，left/top 固定，纯跟手不跳） */
function onPluginResize(size: ViewSize): void {
  // 打断可能仍在进行的过渡动画，确保拖拽完全跟手
  cancelWindowResizeAnimation();
  pluginWindowSize.value = size;
  // 用户一动尺寸，就锁定自动高度 + 启用拉伸，避免插件内容异步变化时把
  // 用户拖出来的尺寸打回去、或窗口变高而内容不长。
  setDetailManualHeightLock(true);
  setPluginSizedClass(true);
  void applyPluginWindowSize(size, false);
  // 这里**不再**读 innerHeight 回写变量：下发 setSize 的这一刻视口还停在旧尺寸，
  // 读到的必然是小值，会把 applyPluginWindowSize 刚按目标预钉的高度覆盖回去
  // （「首次拖拽就压缩」的成因）。预钉值已与目标同帧，后续由 window resize 监听
  // 在视口到位后按实测纠正（DPI/取整偏差、以及 OS 直接拉伸窗口）。
}

/** 拖拽结束：写入该插件的记忆，并按最终尺寸做一次「完全居中」定位 */
function onPluginResizeEnd(size: ViewSize): void {
  pluginWindowSize.value = size;
  const id = pluginSizeId.value;
  if (id) writePluginViewSize(id, size);
  // 松手后才定位（上下左右完全居中）：拖动过程不做位移，避免上下滑动。
  // 尺寸下发时已按目标预钉高度；落定后的实测纠正交给 window resize 监听
  // （见 pinPluginBoxHeight 注释）——不再用 rAF 读 innerHeight 回写：
  // 那一帧视口往往还没到位，会把刚预钉的准确值覆盖成旧的小值。
  void applyPluginWindowSize(size, true);
}

/**
 * 「恢复默认大小」（双击手柄）：清记忆 + 回到默认尺寸 + **回到常态位置**。
 *
 * 用户明确要求双击还原时位置也要还原：把窗口从「插件调整态」（完全居中）退回
 * 「常态搜索窗位置」（水平居中 + 顶部 22%）。同时解除拉伸/高度锁，让内容恢复
 * 自适应布局。手柄仍保留（用户可再次拖拽）。
 *
 * ## 为什么顺序要这么绕（曾经的概率性「还原后很矮」）
 *
 * 摘掉 `.plugin-sized` 会让 `.plugin-view` 从 `flex:1/height:100%` 瞬间塌回内容
 * 高度——这是一次**布局翻转**。而 `onScriptMounted` 装的 ResizeObserver 正盯着
 * `.plugin-view`，翻转会让它立刻排一个 rAF 回调去调 `fit()`。
 *
 * 旧实现一上来就 `setDetailManualHeightLock(false)`，等 rAF 里 `fit()` 跑起来时
 * 锁已经开了 → 它在**布局半变**（类已关、重排未完成）的时刻量 `box.offsetHeight`
 * → 量到很小的值 → 写进 `setWindowHeight` 的**同一个防抖 pendingHeight**。这个
 * 小值和本函数随后要下发的「默认高度」谁最后执行谁生效（`setWindowHeight` 是
 * trailing 防抖、无顺序保证），于是**概率性**还原成很矮。
 *
 * 修法（让顺序确定化）：
 *   1. 过渡期间**保持高度锁**——`fit()` 的锁守卫把这一整段挡住，不会量到半变布局；
 *   2. 先取消可能已排队的旧高度（`cancelPendingHeight`），丢掉过渡期的小值；
 *   3. 摘类 + 复位宽度/位置（Rust）；
 *   4. 等布局稳定（nextTick + 一帧 rAF）后**才解锁**，随后做**唯一一次**显式
 *      `fit()`——此刻量到的是稳定的「内容自适应」高度（即默认尺寸）。
 *   5. `fit()` 与后续 ResizeObserver 触发的 fit 会算出同一个值，靠 `lastHeight`
 *      去重天然收敛；不再有人硬写第二个值，竞态消失。
 */
function onPluginResizeReset(): void {
  const id = pluginSizeId.value;
  const base = pluginSizeBase.value;
  if (id) clearPluginViewSize(id);
  if (!base) return;
  pluginWindowSize.value = base;

  // 1) 丢弃过渡期可能已排队的旧高度（如翻转瞬间 fit() 写进来的小值）
  cancelPendingHeight();
  // 2) 退出「调整态」的宽度覆盖与拉伸类；**高度锁保持 true**，挡住过渡期的 fit()
  setWindowWidthOverride(null);
  setPluginSizedClass(false);
  // （此处刻意不解锁 setDetailManualHeightLock，见上方注释）

  // 3) 先量目标尺寸，再「先定位、后过渡尺寸」。
  //
  //    顺序：位置先一次到位（水平居中 + 顶部 22%），随后尺寸在固定位置上平滑
  //    过渡——这样窗口不会「边变大小边滑动」，视觉更稳。位置复位必须早于动画，
  //    否则动画期间窗口还停在插件态位置上，结束后再跳一下会显得顿。
  //
  //    目标高度：此刻高度锁仍为 true，`measure()` 只量不下发（不会被半变布局
  //    污染），拿不到时退回默认尺寸高度。
  void (async () => {
    // 需要目标宽度（屏幕分档）——Rust 侧计算口径，前端只取数
    const targetWidth = await getDefaultWindowWidth();
    const contentHeight = detailRef.value?.measureHeight() ?? null;
    const targetHeight = contentHeight != null && contentHeight > 0 ? contentHeight : base.height;
    // 3a) 位置复位到常态（Rust 同时会把宽度设为屏幕分档——与 targetWidth 一致）
    await resetMainWindowPosition();
    // 3b) 再在固定位置上把尺寸平滑过渡到目标（宽高一起，避免中途形变）；
    //     过渡期间内容按像素实时跟随，避免右侧/底部留白到动画结束才补齐
    await animateWindowSizeWithContent(targetWidth, targetHeight);
    // 4) 等 Vue 更新 + 浏览器完成重排（一帧），确保布局已稳定再解锁
    await nextTick();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    setDetailManualHeightLock(false);
    // 5) 唯一一次权威下发：清去重缓存 → 量稳定布局 → 立即下发
    detailRef.value?.resetHeightCache();
    detailRef.value?.fitHeight();
    detailRef.value?.flushHeight();

    // 6) 把拖拽手柄的起点（pluginWindowSize）同步到**实际落定尺寸**。
    //
    //    为什么（还原后第一次拖拽「不自然/跳一下」的根因）：
    //    上面第 918 行把 `pluginWindowSize` 设为 `base`——但 `base` 是**打开插件
    //    那一刻**缓存的默认尺寸；而还原后窗口实际落定在「这次重新量出的内容自适应
    //    高度」（`fitHeight()` 的实测值），两者在插件内容已变化时不相等。
    //    拖拽手柄的 `current` 用的是 `pluginWindowSize`，起点与真实窗口不一致 →
    //    第一次 mousemove 下发 `base + delta`，窗口从「实际尺寸」瞬间跳到
    //    「base+delta」，观感上就是「不自然/顿一下」。
    //    修复：在落定后把起点对齐到实际尺寸，后续拖拽即无跳变。
    const settledWidth = window.innerWidth > 0 ? window.innerWidth : targetWidth;
    const settledHeight = detailRef.value?.measureHeight() ?? null;
    pluginWindowSize.value = {
      width: settledWidth,
      height: settledHeight != null && settledHeight > 0 ? settledHeight : targetHeight,
    };
  })();
}

/**
 * 清除插件尺寸状态：把宽度覆盖置回 null（关键——否则普通搜索会被锁成插件宽度），
 * 并清空本地状态。高度让调用方的常规路径重新下发即可。
 *
 * @returns 进入时**确实处于插件尺寸状态**时为 true（调用方据此决定是否要复位
 *   窗口位置——普通路径（从未开插件）不该多发一次 IPC）。
 *
 * 注意：宽度覆盖清掉后，窗口宽度要等下一次 setWindowHeight 才恢复屏幕分档；
 * 而**位置**插件页可能被移过，必须靠调用方显式 `resetMainWindowPosition()` 复位，
 * 本函数不代劳（宽度/位置的复位时机在调用方，见 hideTextView / resetToInitialView）。
 */
function clearPluginViewSizeState(): boolean {
  const wasPluginSized = pluginSizeId.value != null;
  // 打断可能仍在进行的尺寸过渡动画（如刚打开插件就立刻退出）：否则动画会继续
  // 往插件尺寸跑，与随后的常态尺寸下发/定位互相打架。
  cancelWindowResizeAnimation();
  pluginSizeId.value = null;
  pluginWindowSize.value = null;
  pluginSizeLimits.value = null;
  pluginSizeBase.value = null;
  pluginMonitorRect = null;
  setWindowWidthOverride(null);
  // 解除手动高度锁：离开插件视图后，详情区高度重新交回内容自适应
  // （否则普通结果/文本视图的窗口高度也会被冻住）。
  setDetailManualHeightLock(false);
  // 去掉「插件拉伸」类：普通搜索/文本详情恢复原本「内容撑窗口」的布局
  // （规避 #my_search_box 设 height:100% 时的 WebView2 冷启动视口滞后问题）。
  setPluginSizedClass(false);
  // 同时清掉钉高的 CSS 变量：留在原地会让「下一个不带变量的布局」仍按旧插件
  // 尺寸撑高，出现一帧大空白。
  document.getElementById("my_search_box")?.style.removeProperty("--plugin-view-height");
  return wasPluginSized;
}

/**
 * 退出插件视图时复位窗口位置到常态（水平居中 + 顶部 22%）。
 *
 * 为什么需要：插件页会按自己的规则移动窗口，退出时只改尺寸（setWindowHeight）
 * 不会把位置挪回去，窗口会停在插件页那次定位的位置。仅当确实离开插件尺寸状态
 * 时才调用，避免普通路径多余 IPC。
 */
function restoreWindowPositionIfPluginExited(): void {
  const wasPluginSized = clearPluginViewSizeState();
  if (wasPluginSized) void resetMainWindowPosition();
}



/** 载入「最近添加」历史（localStorage；容错脏数据，坏条目静默丢弃）。
    显式重建条目对象（只保留 kind/name/path/pinned），既挡住历史遗留字段，
    也保证固定条目在渲染顺序上排最前——旧版本数据可能没有 pinned 字段。 */
function loadRecentAttachments(): void {
  const raw = storageGet<unknown>(RECENT_ATTACH_KEY, null);
  if (!Array.isArray(raw)) return;
  const clean: AttachedEntry[] = [];
  for (const e of raw) {
    const rec = e as Partial<AttachedEntry> | null;
    if (!rec || (rec.kind !== "file" && rec.kind !== "folder")) continue;
    if (typeof rec.name !== "string" || typeof rec.path !== "string") continue;
    const item: AttachedEntry = { kind: rec.kind, name: rec.name, path: rec.path };
    if (rec.pinned) item.pinned = true;
    clean.push(item);
  }
  // 固定在前（固定/未固定各自保持原有相对顺序）；未固定部分同样按上限截断，
  // 免得旧数据/手工改过的存储让总数无限增长（固定条目不参与截断）。
  const pinned = clean.filter((e) => e.pinned);
  const unpinned = clean.filter((e) => !e.pinned).slice(0, RECENT_ATTACH_CAP);
  recentFiles.value = [...pinned, ...unpinned];
}

/** 已固定条目的 key 集合（供 merge 与渲染判定复用） */
const pinnedKeys = computed(
  () => new Set(recentFiles.value.filter((e) => e.pinned).map(attachmentKey))
);

/** 条带只列「当前还没进输入框」的历史条目：点过的已经变成输入框里的附件 chip，
    不再在下面重复；把 chip 删掉后它自然又回到条带（附件状态是唯一真相）。
    固定条目始终排在最前（mergeRecently 已保证存储顺序，这里再兜一次，
    防止历史从旧版本数据载入时顺序不规范）。 */
const stripFiles = computed(() => {
  const attached = new Set(attachments.value.map(attachmentKey));
  const visible = recentFiles.value.filter((e) => !attached.has(attachmentKey(e)));
  const pinned = visible.filter((e) => e.pinned);
  if (pinned.length === 0) return visible;
  const unpinned = visible.filter((e) => !e.pinned);
  return [...pinned, ...unpinned];
});

/** 条带条目的系统图标（与输入框 chips 共用模块级缓存；空串 = 未就绪/取不到） */
const { iconOf: sysIconOf } = useFileIcons();

// 系统图标缓存的回收点。**只在这里裁**：App.vue 同时持有 attachments（输入框
// chips）与 recentFiles（条带历史）两份状态，传并集才不会误清另一处正在用的
// 图标。SearchBox 只管预取、不裁剪（它看不到条带那批条目）。
watch(
  [() => attachments.value.map((e) => e.path).join("|"),
   () => recentFiles.value.map((e) => e.path).join("|")],
  () => {
    pruneFileIcons([...attachments.value, ...recentFiles.value]);
  }
);

// 条带出现 / 内容变化时预取系统图标（SearchBox 也会为输入框里的 chips 调一次，
// 两处共用同一份缓存与在途去重，不会重复走 IPC）。
watch(
  () => stripFiles.value.map((e) => e.path).join("|"),
  () => {
    if (recentVisible.value) prefetchFileIcons(stripFiles.value);
  }
);

// 条带开着时如果条目被清空（点掉了最后一个块 / 移除历史 / 全被附加进输入框），
// 没有可选项了就把这一行收起来——空行没有意义，还占着窗口高度。
watch(stripFiles, (list) => {
  if (recentVisible.value && list.length === 0) hideRecentStrip();
});

/** 条带开关后按最新内容重下发高度（详情视图除外）。
    条带现在是**盒子内的普通流内节点**（搜索框下方），盒子实测高度天然含它，
    所以这里只需重新测量盒子即可——没有任何窗口位移/区域要维护。 */
function refreshHeightAfterStripToggle(): void {
  // 详情视图高度由 useDetailHeight 的 min/max clamp 管：那里已把条带高度计入
  // clamp，动它会用未 clamp 的实测值顶掉上限，故不干预。
  if (state.mode === MODE.SHOW_ITEM_DETAIL) return;
  void syncWindowHeightToContent();
}

/** 展开条带：渲染 → 按内容重下发窗口高度（条带在盒子内，向下生长）。
    **没有可选项就不展开**（历史为空、或历史里的条目全都已经在输入框里了）：
   与其显示一条「暂无…」的空行，不如不占位——所以这里直接返回，保持收起态。 */
async function showRecentStrip(): Promise<void> {
  if (stripFiles.value.length === 0) {
    hideRecentStrip();
    return;
  }
  recentVisible.value = true;
  // 首帧先按已有缓存渲染（多数条目上一轮已取过图标），未就绪的走异步补图
  prefetchFileIcons(stripFiles.value);
  refreshHeightAfterStripToggle();
}

/** 收起条带：重下发高度。已收起时是 no-op（复位/呼出路径可安全直调） */
function hideRecentStrip(): void {
  if (!recentVisible.value) return;
  recentVisible.value = false;
  refreshHeightAfterStripToggle();
}

/** 点击条带条目 = 附加到**输入框**（成为附件 chip，走现成管线重新 describePaths，
    路径失效自然被拒）。附件状态一变，上面的 stripFiles 计算属性即把它从条带里
    剔除——所以视觉上就是「从条带移进输入框」，不再重复出现。
    附加完成后回焦输入框：点击条目本身会把 DOM 焦点从输入框挪走（点到条带
    容器/按钮上），若不还焦点，用户选完文件还得再点一次搜索框才能打字。 */
async function onRecentPick(f: AttachedEntry): Promise<void> {
  if (!f?.path) return;
  await attachByPaths([f.path]);
  // 附加会让该条从条带消失、DOM 重排：等一帧再回焦，避免被重排抖动带走。
  await nextTick();
  if (!installDialogVisible.value) searchBoxRef.value?.focus();
}

/** 从历史移除某条（按路径匹配；文件已删 / 不想再看到）。
    用路径而不是索引：条带列表是 stripFiles 过滤出来的，索引与 recentFiles
    不一一对应，按下标删会删错条目。移除后回焦输入框（点按钮会夺走焦点）。 */
function onRecentRemove(path: string): void {
  const key = attachmentKey({ kind: "file", name: "", path });
  const before = recentFiles.value.length;
  recentFiles.value = recentFiles.value.filter((e) => attachmentKey(e) !== key);
  if (recentFiles.value.length === before) return;
  storageSet(RECENT_ATTACH_KEY, recentFiles.value);
  // 条目减少后条带可能换行/变矮：等 DOM 更新后按新高度重下发窗口尺寸。
  if (recentVisible.value) void nextTick(syncWindowHeightToContent);
  if (!installDialogVisible.value) searchBoxRef.value?.focus();
}

/** 切换某条历史的「固定」状态（图钉按钮）。
    固定后条目会**移到最前**并永不被 30 条上限淘汰；取消固定则回到普通序列。
    用键匹配（路径优先）而不是索引：条带列表是过滤/重排后的，索引不可靠。
    重排后需要按新内容重下发高度（条目数量不变，但可能换行/变矮）。
    切换后回焦输入框（点按钮会夺走焦点）。 */
function onRecentTogglePin(path: string): void {
  const key = attachmentKey({ kind: "file", name: "", path });
  const next = toggleRecentPin(recentFiles.value, key);
  if (next === recentFiles.value) return;
  recentFiles.value = next;
  storageSet(RECENT_ATTACH_KEY, recentFiles.value);
  if (recentVisible.value) void nextTick(syncWindowHeightToContent);
  if (!installDialogVisible.value) searchBoxRef.value?.focus();
}

/** 条带横向滚轮：把纵向滚轮 / 触摸板滑动**映射为水平滚动**，方便翻出更早的记录。
    只在真的能横向滚动时拦截（否则让滚轮冒泡，避免吃掉外层行为）；
    deltaX 优先（触摸板横向滑动 / Shift+滚轮由浏览器转成 deltaX），
    其次把 deltaY 当水平位移（普通鼠标滚轮）。 */
function onRecentStripWheel(e: WheelEvent): void {
  const el = e.currentTarget as HTMLElement | null;
  if (!el) return;
  if (el.scrollWidth <= el.clientWidth) return; // 没溢出，不拦截
  const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  if (delta === 0) return;
  const before = el.scrollLeft;
  el.scrollLeft = before + delta;
  // 已到边界（滚不动了）就不拦截，让页面/其它处理器接管
  if (el.scrollLeft !== before) e.preventDefault();
}
// ============== 打开数据项 ==============
/**
 * 将展示项解析回规范化数据项。
 *
 * 历史实现用 `engine.searchData[item.index]`（数组下标）反查原项，一旦数组
 * 变动（摘除插件项、过滤不关注标签）下标即失效，会指向**别的数据项**，从而
 * 出现「favicon/url 与实际 title 对不上」的错位。
 *
 * 现在结果集里的 `item` 本身就是 `searchData` 中同一个对象引用，展示与打开
 * 共用它即可，无需也不应再做下标反查——这就是「稳定解析数据项」的关键：
 * 身份由对象承载，而非位置。
 */
function resolveItem(item: SearchItem | null | undefined): SearchItem | null {
  return item ?? null;
}

/**
 * 处理 [[...]] 搜索模板（完全还原原版 li>a 点击中的 URL 构造）：
 * - 关键词按 `" : "` 分隔后取「子搜索」部分（即分隔符之后的内容），填入 `{keyword}`
 * - 原版是按 `":"` 切分并丢弃最后一段，再 join(":")，以兼容关键词里本身带冒号
 * - 带 {-keyword-} 且子搜索为空时，去掉整个模板直接跳基础地址
 */
function buildRealUrl(initUrl: string): string {
  let url = String(initUrl || "");
  // 与油猴版一致：按 ":" 切分，丢掉最后一段（分隔符之后的部分），剩余 join 回去
  const keyword = String(state.rawKeyword).split(":").reverse();
  keyword.pop();
  const realKeyword = keyword.reverse().join(":").trim();
  url = url.replace(/\[\[([^\[\]]*)\]\]/g, (m, inner: string) =>
    inner.replace(/{keyword}/g, realKeyword).replace(/\[\[+|\]\]+/g, "")
  );
  // 子搜索为空 → 去掉搜索模板
  const parts = String(state.rawKeyword).split(SEARCH_BOUNDARY);
  if (parts.length < 2 || (parts[1] || "").trim() === "") {
    url = clearUrlSearchTemplate(initUrl);
  }
  // 订阅数据里的 resource 常带结尾换行/空白，直接传给系统打开会失败
  return url.trim();
}

/**
 * 打开数据项（还原原版点击 `a.enter_main_link` 的行为）：
 * - 脚本项 → 执行脚本
 * - 非 URL（简述文本）→ 显示简述内容
 * - URL → 构造真实跳转地址并打开（[[...{keyword}...]] 用子搜索关键词填充）
 *
 * 注意：**附加内容（vassal）不在此处理**，由 openVassal 单独处理。
 */
function openItem(rawItem: SearchItem | null | undefined): void {
  const item = resolveItem(rawItem);
  if (item == null) return;
  // 点击加分 + 记录历史（使用原数据项的标题/描述作为 key）
  scoreSelect(item);
  historySelect(item);

  // 插件贡献的项：走插件视图（与老脚本项分流；老路径一字不动）
  if (pluginIdOf(item) != null) {
    void openPluginView(item);
    return;
  }
  // 脚本项（包含快捷搜索脚本）
  if (item.type === "script") {
    handleScriptItem(item);
    return;
  }
  // 非 URL（简述文本）→ 显示简述内容
  if (!isUrl(item.resource)) {
    showTextView(item.title ?? "", item.desc ?? "", item.resource ?? "");
    return;
  }
  // URL → 构造真实跳转地址并打开
  const realUrl = buildRealUrl(item.resource ?? "");
  if (realUrl) {
    // 还原原版：点击 URL 项时先 viewVisibilityController(false) 收起视图，
    // 再 window.open(url) 打开链接。因此“点结果 → 搜索框消失”是显式行为。
    resetToInitialView();
    void hideWindow();
    void openExternal(realUrl);
  }
}

/** 展示附加内容（还原原版点击 a.vassal / Ctrl+回车 的行为） */
function openVassal(rawItem: SearchItem | null | undefined): void {
  const item = resolveItem(rawItem);
  if (item == null || item.vassal == null) return;
  scoreSelect(item);
  historySelect(item);
  showTextView(item.title ?? "", "主项的相关/附加内容", item.vassal);
}

// ============== 插件视图 ==============
/**
 * 打开插件视图。
 *
 * 与脚本视图的分流点：插件项自带 `_pluginId`，渲染容器是 `.plugin-view`
 * （脚本项是 `.script-view`），两者互斥——先关掉脚本会话再挂插件视图。
 */
async function openPluginView(item: SearchItem): Promise<void> {
  scriptHost.clearScriptSession();
  // 换插件前先清掉上一个插件的尺寸状态（宽高覆盖 / 本地记忆态）
  clearPluginViewSizeState();
  detail.value = { kind: "plugin", title: item.title ?? "", desc: "插件项", body: "", item };
  detailVisible.value = true;
  state.mode = MODE.SHOW_ITEM_DETAIL;
  // 等容器渲染出来（.plugin-view 由 DetailView 的 v-else-if 分支产出）
  await nextTick();
  const result = await pluginViewHost.open(item);
  if (!result.ok) {
    toast.showToast(result.error ?? "插件视图打开失败", "error");
    return;
  }
  detailRef.value?.onScriptMounted();
  // 应用该插件的记忆尺寸（首次打开则维持内容自适应尺寸，只记下上下限）。
  // 必须在 onScriptMounted 之后：先让内容长出来，默认尺寸才是「内容自适应高」。
  const pluginId = pluginIdOf(item);
  if (pluginId) await applyPluginViewSize(pluginId);
}

/**
 * 全局快捷键触发的「打开插件」（快捷键作用于 open-plugin 时由 Rust 端广播事件）。
 *
 * 与点结果项打开插件的差别只有一步：快捷键没有「被点击的数据项」，
 * 因此由插件宿主合成一个载体项（该插件的第一个搜索项 / 最小占位项），
 * 其余路径完全一致（关脚本会话 → 挂插件视图 → 高度自适应）。
 */
async function openPluginByShortcut(pluginId: string): Promise<void> {
  // 插件可能刚在设置窗口里被装/卸/启停：先对一次注册表指纹，避免用到旧记录
  await pluginHost.reload();
  const record = pluginHost.get(pluginId);
  if (!record) {
    toast.showToast(`插件不存在（可能已卸载）：${pluginId}`, "error");
    return;
  }
  if (!record.enabled) {
    toast.showToast(`插件「${record.name}」已禁用，请先在设置 → 插件中启用`, "error");
    return;
  }
  const item = pluginHost.itemForPlugin(pluginId);
  if (!item) {
    toast.showToast(`插件「${record.name}」不可用`, "error");
    return;
  }
  await openPluginView(item);
}

/**
 * 全局快捷键触发的「插件自定义动作」（如录屏的开始 / 停止）。
 *
 * 与 `openPluginByShortcut` 同一条打开路径，区别是打开后再把动作派发给插件脚本
 * （插件用 `ms.shortcuts.onAction(本地名, fn)` 注册了处理器）。执行逻辑在插件
 * 自己（后台进程 + 界面），宿主只负责把窗口带到前台、打开视图、投递动作。
 *
 * 派发时机：`openPluginView` 完成后（视图已挂载/恢复、脚本已跑），再
 * `dispatchShortcutAction`。两种情况都覆盖：
 *   - 全新挂载 → 脚本刚执行，处理器已注册；
 *   - 保活恢复（minimize）→ 脚本没重跑，但处理器仍在（会话未销毁）。
 * 插件没注册该动作时提示一句（避免「按了没反应」）。
 */
async function runPluginActionByShortcut(pluginId: string, action: string): Promise<void> {
  await pluginHost.reload();
  const record = pluginHost.get(pluginId);
  if (!record) {
    toast.showToast(`插件不存在（可能已卸载）：${pluginId}`, "error");
    return;
  }
  if (!record.enabled) {
    toast.showToast(`插件「${record.name}」已禁用，请先在设置 → 插件中启用`, "error");
    return;
  }
  const item = pluginHost.itemForPlugin(pluginId);
  if (!item) {
    toast.showToast(`插件「${record.name}」不可用`, "error");
    return;
  }
  await openPluginView(item);
  // action 形如 `plugin:<插件id>:<本地名>`：取本地名派发给插件脚本。
  const name = pluginDefinedActionName(action) ?? action;
  // 等一帧：全新挂载时脚本刚执行完，给处理器注册留出时机
  await nextTick();
  const handled = dispatchShortcutAction(pluginId, name);
  if (!handled) {
    toast.showToast(`插件「${record.name}」未响应动作「${name}」（可能版本过旧或未注册）`, "error");
  }
}

/**
 * 全局快捷键触发的「快速过滤」（快捷键作用于 quick-filter 时由 Rust 端广播常用头）。
 *
 * 行为：把「常用头 + 二次搜索分隔符」填入输入框 → **立即搜索**（不走 300ms 防抖，
 * 也不走 onInput 的子关键词编辑守卫，避免详情视图里被静默吞掉）→ 光标移到末尾，
 * 用户直接接着输入子关键词即可。
 */
async function applyQuickFilter(filter: string): Promise<void> {
  const header = normalizeQuickFilterHeader(filter);
  if (!header) return;
  // 详情视图下先退出，让结果区/窗口高度按普通搜索恢复（与 handleScriptItem 一致）
  if (state.mode === MODE.SHOW_ITEM_DETAIL) hideTextView();
  const next = header + SEARCH_BOUNDARY;
  inputValue.value = next;
  await search.doSearch(next);
  // 搜索完成（结果已渲染）后再聚焦并把光标放到末尾：
  // 若提前聚焦，afterResultsRendered 里的高度同步/重渲染可能让光标位置落空。
  await nextTick();
  searchBoxRef.value?.focusEnd();
}

/**
 * 全局快捷键触发的「快捷打开项」（快捷键作用于 quick-open 时由 Rust 端广播匹配文本）。
 *
 * 用**精确搜索**（标题/描述/内容三级，多词按空格 AND，含拼音）匹配数据项，
 * **不走模糊/重叠度兜底**（用户约定：匹配不到就明说，别拿相近的项糊弄）。
 * - 唯一匹配 → 与点击该项完全一致（openItem）；
 * - 多项匹配 → 把文本填入搜索框并展示结果列表，由用户自己选；
 * - 无匹配 → 只提示「未找到匹配项」，不动输入框/窗口。
 *
 * 附件过滤（粘贴/拖入的 resultFilter）在这里同样生效，避免打开一个
 * 当前被附件过滤掉的项。
 */
async function applyQuickOpen(text: string): Promise<void> {
  const keyword = String(text ?? "").trim();
  if (!keyword) return;
  const results = engine._applyResultFilter(engine.accurateSearch(keyword));
  if (results.length === 0) {
    toast.showToast(`未找到匹配项：${keyword}`, "error");
    return;
  }
  if (state.mode === MODE.SHOW_ITEM_DETAIL) hideTextView();
  inputValue.value = keyword;
  if (results.length === 1) {
    // 唯一匹配：直接打开（等价于点击）；openItem 内部会处理 URL/简述/脚本/插件分流
    openItem(results[0].item);
    return;
  }
  // 多项匹配：展示结果列表让用户自己选（用 doSearch 让结果/高度/模式都走常规路径）
  await search.doSearch(keyword);
  await nextTick();
  searchBoxRef.value?.focusEnd();
}

/** 脚本项处理（还原 showView 分支） */
function handleScriptItem(item: SearchItem): void {
  const ro = item.resourceObj || {};
  const script = ro.script || "";
  // 特殊：快捷搜索脚本（触发 <new>/<history>/<highFrequency>）
  const specialMatch = script.match(/specialKeyword\.(\w+)/);
  if (specialMatch) {
    const key = SPECIAL_KEYWORD[specialMatch[1] as keyof typeof SPECIAL_KEYWORD];
    if (key) {
      inputValue.value = key;
      void search.doSearch(key);
      return;
    }
  }
  // 需挂载视图的脚本项
  if (scriptHost.hasScriptView(ro)) {
    runScriptItem(item);
    return;
  }
  // 其它脚本项：显示其脚本说明与附加内容
  showTextView(item.title ?? "", "脚本项", item.vassal || ro.script || "（脚本项）");
}

/** 运行脚本项（还原 Function('obj', `(${jscript})(obj)`)({...})） */
function runScriptItem(item: SearchItem): void {
  // 先切到脚本视图（渲染 .script-view 容器），再执行 script 段
  showScriptView(item);
  void nextTick(() => {
    const verdict = scriptHost.runScriptItem(item, (afterCallback) => {
      const host = document.querySelector<HTMLElement>("#text_show .script-view");
      const owner = document.getElementById("text_show");
      if (host && owner) {
        scriptHost.mountScriptView(item, host, owner, afterCallback);
        detailRef.value?.onScriptMounted();
      }
    });
    if (!verdict.ok) {
      const host = document.getElementById("text_show");
      if (host) {
        const tip = document.createElement("div");
        tip.className = "script-view-tip";
        tip.textContent = "脚本视图运行出错，已显示其 HTML 内容。";
        host.prepend(tip);
      }
    }
  });
}

/**
 * 对齐注册表变化后的插件会话（呼出 / 获得焦点 / 页面可见性变化时调用）。
 *
 * 设置窗口是**另一个 WebView**，用户可以在那里禁用/卸载插件；搜索窗只能
 * 在这些时间点发现。被禁用/卸载的插件不该还能被恢复出来，因此：
 *   1. 清掉失效的保活会话（`reapSessions`）；
 *   2. 若被清掉的恰好是**前台的**那个插件，详情视图会剩下一个空容器——
 *      把它一并收掉，回到结果列表/等待搜索，而不是给用户看一片空白。
 */
function syncPluginSessions(): void {
  const before = pluginViewHost.sessionCount();
  const activeBefore = pluginViewHost.activePluginId.value;
  pluginViewHost.reapSessions();
  // 设置里点了「重启」的插件：释放其（保活中的）前端会话，下次打开 = 全新挂载。
  // 后端已在设置窗口重启过，这里只丢前端会话、不联动停后端。
  for (const pluginId of takePluginFrontendRestartMarks()) {
    pluginViewHost.release(pluginId, "设置中重启了插件：前端会话已释放（下次打开重新挂载）", { stopBackend: false });
  }
  const reapedForeground = !!activeBefore && pluginViewHost.sessionCount() < before && !pluginViewHost.hasSession(activeBefore);
  if (reapedForeground && detailVisible.value && detail.value?.kind === "plugin") {
    detailVisible.value = false;
    detail.value = null;
    state.mode = state.results.length > 0 ? MODE.SHOW_RESULT : MODE.WAIT_SEARCH;
    void nextTick(() => {
      if (state.results.length > 0) void syncWindowHeightToContent();
      else collapseToBoxHeight();
    });
  }
}

// ============== 键盘交互 ==============
function onInput(v: string): void {
  if (state.mode === MODE.SHOW_ITEM_DETAIL) {
    // 脚本视图展示中，且用户只是在「父关键词 : 子关键词」里改后半段
    // （还原油猴版 handler 开头的守卫）：不退出详情视图、不重搜，
    // 否则脚本会话会被销毁，「问AI : 你好」的「你好」就传不进应用。
    if (search.isSubKeywordEditing(v)) {
      search.onInput(v); // 只记录输入、不重搜（保住脚本视图）
      return;
    }
    // 进入普通搜索前先退出详情视图（恢复结果区与窗口高度）
    hideTextView();
  }
  search.onInput(v);
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    search.moveActive(1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    search.moveActive(-1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    // 视图展示中：回车 = 把子搜索关键词推送给脚本应用 / 插件
    // （还原 registry.script.tryRunTextViewHandler；推成功就不执行结果项点击）
    const pushed = pluginViewHost.isActive()
      ? pluginViewHost.tryRunTextViewHandler(inputValue.value)
      : scriptHost.tryRunScriptTextViewHandler(inputValue.value);
    if (pushed.handled) {
      // 清掉子搜索部分，只留「父关键词 : 」（原版 input.val(rawKeyword.replace(msg,""))）
      inputValue.value = pushed.nextKeyword;
      return;
    }
    // 无上下选择（activeIndex === -1）时，回车默认作用于第一项；
    // 防抖搜索尚未触发（“输入就回车”）时先立即搜索再取第一项。
    // （还原原版：`pos == 0` 时置 `pos = 1`，即“搜索后回车相当于点击第一个”）
    void search.resolveEnterTarget(inputValue.value).then((result) => {
      if (!result) return;
      if (e.ctrlKey) {
        // Ctrl+回车 = 点击“附加内容”（还原原版 activeItem.find(".vassal")[0]?.click()）
        openVassal(result.item);
      } else {
        // 回车 = 点击主链接（URL 会按子搜索关键词填充 [[...]] 模板后打开）
        openItem(result.item);
      }
    });
  } else if (e.key === "Escape") {
    e.preventDefault();
    // 安装确认弹窗开着时 Esc = 取消安装（不关详情视图、不藏窗口）
    if (installDialogVisible.value) {
      onInstallCancel();
      return;
    }
    if (state.mode === MODE.SHOW_ITEM_DETAIL) {
      hideTextView();
    } else {
      void hideWindow();
    }
  } else if (e.key === "Tab") {
    e.preventDefault();
    if (!e.shiftKey) {
      if (!inputValue.value.includes(SEARCH_BOUNDARY)) {
        inputValue.value = inputValue.value.toUpperCase() + SEARCH_BOUNDARY;
        onInput(inputValue.value);
      }
    } else {
      if (inputValue.value.includes(SEARCH_BOUNDARY)) {
        inputValue.value = inputValue.value.split(SEARCH_BOUNDARY)[0].toLowerCase();
        onInput(inputValue.value);
      }
    }
  } else if (e.key === "Backspace") {
    // 输入框已空 + 有附件 → 先摘掉最后一个附件（与清标签同为「逐级退格」）
    if (inputValue.value === "" && attachments.value.length > 0) {
      e.preventDefault();
      popAttachment();
      return;
    }
    if (inputValue.value.endsWith(SEARCH_BOUNDARY)) {
      e.preventDefault();
      return;
    }
    if (/^\s*[\[<][^\[\]<>]*[\]>]\s*$/.test(inputValue.value)) {
      inputValue.value = "";
      onInput("");
      e.preventDefault();
    }
  }
}

/** logo 左键：已有「下载完成、可安装」的更新时走安装，否则搜索 [系统项] */
function onLogoClick(): void {
  if (update.isDownloaded()) {
    void update.handleBadgeClick();
    return;
  }
  // 无就绪更新：保持原有行为，搜索 [系统项]
  const keyword = "[系统项]";
  const next = inputValue.value === keyword ? "" : keyword;
  inputValue.value = next;
  onInput(next);
  searchBoxRef.value?.focus();
}

/** 右击 logo：触发 [系统项] 切换 */
function onSystemItemClick(): void {
  const keyword = "[系统项]";
  const next = inputValue.value === keyword ? "" : keyword;
  inputValue.value = next;
  onInput(next);
  searchBoxRef.value?.focus();
}

/** 结果项点击（由 ResultList 冒泡） */
function onResultOpen(index: number): void {
  const result = state.results[index];
  if (result) openItem(result.item);
}
function onResultVassal(index: number): void {
  const result = state.results[index];
  if (result) openVassal(result.item);
}
function onResultLink(url: string): void {
  void openExternal(url);
}

// 输入值读取器（占位提示/子搜索都用它）
search.bindInputValueGetter(() => inputValue.value);
search.bindAfterResultsRendered(() => {
  if (state.mode === MODE.SHOW_RESULT) {
    void syncWindowHeightToContent();
  } else {
    collapseToBoxHeight();
  }
});

// ============== 生命周期 ==============
let unlistenShown: (() => void) | null = null;
/** 「打开插件」快捷键事件监听器 */
let unlistenPluginShortcut: (() => void) | null = null;
/** 「快速过滤」快捷键事件监听器 */
let unlistenQuickFilter: (() => void) | null = null;
/** 「快捷打开项」快捷键事件监听器 */
let unlistenQuickOpen: (() => void) | null = null;
/** 「剪贴板历史」快捷键事件监听器 */
let unlistenClipboardShortcut: (() => void) | null = null;
/** 「插件自定义动作」快捷键事件监听器 */
let unlistenPluginActionShortcut: (() => void) | null = null;
/** 资源管理器「Alt+点击文件带入」事件监听器 */
let unlistenAttachPaths: (() => void) | null = null;
/** 内置插件自动安装监听器 */
let unlistenBuiltin: (() => void) | null = null;
/** 系统文件拖放（Tauri 原生拖拽事件）监听器 */
let unlistenDragDrop: (() => void) | null = null;

/** 输入框当前是否持有焦点（条带只在「聚焦输入框」时才响应 Alt）。 */
function isSearchInputFocused(): boolean {
  const el = searchBoxRef.value?.element ?? null;
  return !!el && document.activeElement === el;
}

/** 纯 Alt 按下 → 展开「最近添加」条带（**仅在输入框聚焦时**）。
    - Alt+组合键（Alt+Tab/F4…）的主键 keydown 拿到的是主键名而非 "Alt"，天然不触发；
    - e.repeat 挡住按住 Alt 的自动重复；
    - 「无 Ctrl/Shift/Win」与 Rust 侧 Alt+点击钩子的纯 Alt 判定保持一致；
    - **只在输入框聚焦时响应**：资源管理器「Alt+点击带入」会让窗口获得焦点并
      弹入文件，但那是鼠标手势（Alt 早已按下、不会在窗口内产生 keydown），
      且此刻输入框未必聚焦；此门禁确保两条路径互不干扰——点击带入永远不展开
      条带，只有用户**在输入框里**主动按 Alt 才展开。
    - 是「展开」而非「切换」：Alt 松开不收回（开关语义），再按一次才收起。 */
function onGlobalAltKeydown(e: KeyboardEvent): void {
  if (e.key !== "Alt" || e.ctrlKey || e.shiftKey || e.metaKey || e.repeat) return;
  if (!isSearchInputFocused()) return;
  // 呼出后的极短保护期内不展开：挡住 Alt+点击带入时「Alt 还按着」的抖动
  if (performance.now() - summonedAt < SUMMON_STRIP_GUARD_MS) return;
  // 压制 WebView2 的 Alt 菜单激活 / 焦点环（keyup 侧同样压制）
  e.preventDefault();
  if (recentVisible.value) {
    hideRecentStrip();
  } else {
    void showRecentStrip();
  }
}

/** Alt 松开：只压制默认行为（输入框聚焦时），显示状态由 keydown 切换、
    不在此收回（开关语义）。未聚焦时不干预，避免影响其它 Alt 交互。 */
function onGlobalAltKeyup(e: KeyboardEvent): void {
  if (e.key !== "Alt") return;
  if (!isSearchInputFocused()) return;
  e.preventDefault();
}

/** 全局 ESC：输入框无焦点时，与输入框按 ESC 行为完全等价 */
function onGlobalEsc(e: KeyboardEvent): void {
  if (e.key !== "Escape") return;
  e.preventDefault();
  // 捕获阶段拦截并阻止冒泡，避免输入框聚焦时重复触发
  e.stopPropagation();
  // 安装确认弹窗开着时 Esc = 取消安装（优先于条带 / 详情 / 藏窗口）
  if (installDialogVisible.value) {
    onInstallCancel();
    return;
  }
  // 分层：条带开着时 Esc 先收条带（否则一并把窗口也藏了）
  if (recentVisible.value) {
    hideRecentStrip();
    return;
  }
  if (state.mode === MODE.SHOW_ITEM_DETAIL) {
    hideTextView();
  } else {
    void hideWindow();
  }
}

onMounted(async () => {
  // 启动时把窗口收起到搜索框高度（WebView 重载后窗口可能保持上次展开的高度）
  collapseToBoxHeight();

  // 「最近添加」历史：localStorage 同步读，赶在任何 Alt 按键之前
  loadRecentAttachments();

  // 键盘监听必须在任何 await 之前注册：
  // 否则订阅/数据加载较慢时，加载期间按 Esc / Ctrl+, 会完全没有响应。
  // Ctrl+, 打开订阅管理（配置窗口）
  document.addEventListener("keydown", onGlobalKeydown);
  // 全局 ESC：详情视图 / 结果列表显示时，输入框无焦点也与输入框 ESC 行为一致
  document.addEventListener("keydown", onGlobalEsc, true);
  // 纯 Alt 切换「最近添加」条带（capture：先于输入框链路；keyup 同步压制焦点环）
  document.addEventListener("keydown", onGlobalAltKeydown, true);
  document.addEventListener("keyup", onGlobalAltKeyup, true);
  // 视口变化后把拉伸态容器高度同步到真实视口：窗口 setSize 是异步的，拖拽
  // 期间视口会滞后于窗口，靠 height:100% 会解析到旧值、把内容压在顶部。
  // resize 事件在视口真正更新后才触发，这里读到的 innerHeight 已是最新值。
  window.addEventListener("resize", syncPluginBoxHeight);

  // ── 关键：以下数据加载不阻塞首帧渲染 ──
  // Vue mount() 已完成，骨架屏已移除，搜索框已可交互。
  // 把网络/文件 IO 放到 nextTick 之后，让 WebView 先完成首帧合成，
  // 避免冷启动首次呼出时因数据加载阻塞而显示空白窗口。
  await nextTick();

  // 呼出监听必须先于重型初始化注册（理由同上方键盘监听）：Rust 端按快捷键
  // 随时会 show 窗口并发 my-search://main-window-shown，事件在 listen 之前
  // 发出即丢失——表现为「启动初期第一次呼出不复位视图、输入框不聚焦」。
  // 复位/聚焦不依赖已加载的数据，可安全早跑；但**订阅变化检测要等首次加载
  // 完成**：否则此刻 state.subscribeText 还是空串，会与落盘值/不关注快照比较
  // 出错，误判「订阅变了」并带着空订阅发起一次加载。
  let initialLoadDone = false;
  unlistenShown = await onMainWindowShown(() => {
    // 「最近添加」条带随呼出**静默**收起：Rust 侧 show_main_window 已把窗口绝对
    // 复位到 48 高。直清标记即可——下面的复位/恢复路径都经 nextTick 或 50ms
    // 防抖测量，Vue 会先完成本次 DOM 收起再轮到它们。
    recentVisible.value = false;
    // 记录呼出时刻：保护期内不响应 Alt 展开（把 Alt+点击带入与「输入框里按 Alt」分开）
    markSummoned();
    // 插件可能在设置窗口里被装/卸/启停：呼出时对一次注册表指纹，变了才重载。
    // 重载后顺手清掉「注册表里已经不该存在」的保活会话（禁用/卸载的插件不该
    // 还能被恢复出来）——设置窗口与搜索窗是两个 WebView，只能在这一刻对齐。
    void pluginHost
      .reload()
      .then(() => {
        syncPluginSessions();
        search.attachPluginItems();
      });
    if (!resumeDetailViewIfAny()) {
      if (installDialogVisible.value) {
        // 安装确认弹窗开着时呼出（失焦隐藏后再唤回 / 冷启动时 Rust 的 show 晚于
        // 弹窗打开）：**不做复位**——复位会清掉刚附加的 .mspp chip / 关掉插件
        // 详情视图，让弹窗悬空在空视图上。
        //
        // 文件安装还要主动把窗口撑到弹窗高度（Rust 每次呼出都把窗口绝对复位到
        // 48，不撑高弹窗会被裁掉）；市场安装开在插件详情视图之上，高度由详情
        // 视图管理，强行按 440 下发会把插件页压扁，故只对 file 撑高。
        if (installDialogMode === "file") void setWindowHeight(INSTALL_DIALOG_HEIGHT);
      } else {
        resetToInitialView();
      }
    }
    // 复位后再检查一次：若缓存已被清理，立即进入加载状态
    if (initialLoadDone) search.reloadIfSubscribesChanged(true);
    // 「自动下载更新」开关可能刚在设置窗口被改动：呼出时按新设置求值
    // （开启则检查、关闭则立即清空并隐藏叶子上的红箭头）。此处走节流版本——
    // 呼出可能很频繁，每次都真查会迅速打爆 GitHub API 未认证限额并掩盖新版本。
    update.recheckOnSummon();
    // 弹窗开着时焦点留在弹窗按钮上（PluginInstallDialog 可见时会自动聚焦「安装」）
    if (!installDialogVisible.value) searchBoxRef.value?.focus();
  });

    // ── 并行初始化：插件链与订阅链无依赖，同时启动 ──
  // 插件链：内置安装 → 注册表重载 → 绑定插件项 → 开发监听
  // 订阅链：解析订阅文本（纯 localStorage，极快）
  // 两者汇合后再调 loadAllData（它既需要订阅列表，也需要插件项提供者）。
  const pluginChain = (async () => {
    try {
      unlistenBuiltin = await setupBuiltinAutoInstall();
      await pluginHost.reload(true);
      search.bindPluginItems(() => pluginHost.pluginItems());
      await pluginHost.startDevWatcher();
    } catch (e) {
      warn("[我的搜索] 插件加载失败:", e);
    }
  })();

  const subscribeChain = (async () => {
    try {
      await search.loadSubscribes();
    } catch (e) {
      warn("[我的搜索] 订阅加载失败:", e);
    }
  })();

  await Promise.all([pluginChain, subscribeChain]);

  try {
    await search.loadAllData();
  } catch (e) {
    warn("[我的搜索] 数据加载失败:", e);
  } finally {
    // 无论成败都要放行：失败时后续呼出至少能重试一次加载（见呼出回调）
    initialLoadDone = true;
  }
  update.scheduleUpdateCheck();

  // 托盘菜单「清理缓存」
  await onClearCache(() => {
    search.clearRebuildableCache();
  });

  // 全局快捷键「打开插件」（设置 → 快捷键里作用的插件键按下时 Rust 端广播）：
  // 无论窗口此前是隐藏还是显示，Rust 已保证窗口可见并聚焦，这里直接开插件视图。
  unlistenPluginShortcut = await onShortcutOpenPlugin((pluginId) => {
    void openPluginByShortcut(pluginId);
  });

  // 全局快捷键「快速过滤」（设置 → 快捷键里作用类型为「快速过滤」的键按下时
  // Rust 端广播常用头）：窗口已由 Rust 保证可见并聚焦，这里填入并立即搜索。
  unlistenQuickFilter = await onShortcutQuickFilter((filter) => {
    void applyQuickFilter(filter);
  });

  // 全局快捷键「快捷打开项」（设置 → 快捷键里作用类型为「快捷打开项」的键按下时
  // Rust 端广播匹配文本）：精确匹配数据项，唯一则直接打开、多项则列出结果。
  unlistenQuickOpen = await onShortcutQuickOpen((text) => {
    void applyQuickOpen(text);
  });

  // 全局快捷键「剪贴板历史」（设置 → 快捷键里作用类型为「剪贴板历史」的键按下时
  // Rust 端广播插件 id）：与「打开插件」同一条打开路径，只是由宿主热键触发。
  unlistenClipboardShortcut = await onShortcutClipboard((pluginId) => {
    void openPluginByShortcut(pluginId);
  });

  // 全局快捷键「插件自定义动作」（如录屏的开始 / 停止，作用类型为 `plugin:<id>:<name>`）：
  // Rust 端广播 { pluginId, action }。打开该插件视图后把动作派发给插件脚本
  // （插件用 ms.shortcuts.onAction 注册）。执行逻辑在插件自己里。
  unlistenPluginActionShortcut = await onShortcutPluginAction((pluginId, action) => {
    void runPluginActionByShortcut(pluginId, action);
  });

  // 资源管理器「Alt+点击文件」（Rust 端已先 show 窗口并广播复位事件，
  // 本事件按发送顺序晚于复位到达）：把路径并入附件，与粘贴/拖入同管线。
  // 同时**显式收起「最近添加」条带**：点击带入不该顺带展示历史（用户明确规则：
  // 条带只在输入框聚焦时按 Alt 才出现）。onMainWindowShown 已清过一次，这里
  // 再兜一次，防止复位与附件注入之间的时序抖动让它冒出来。
  //
  // **附加完成后再兜底聚焦输入框**：呼出时 onMainWindowShown 已聚焦过一次，但
  // attachByPaths 是异步的（要先经 Rust 解析路径），落定后 DOM/焦点可能已被
  // 重排抖动带走；这里在其后补一次 nextTick 聚焦，确保「Alt+点击带入 → 光标
  // 就在输入框里、可直接接着打字」。.mspp 走安装确认弹窗时焦点归弹窗（弹窗自身
  // 会聚焦「安装」按钮），与 onMainWindowShown 同款守卫，不抢弹窗焦点。
  unlistenAttachPaths = await onAttachPaths(async (paths) => {
    hideRecentStrip();
    await attachByPaths(paths);
    await nextTick();
    if (!installDialogVisible.value) searchBoxRef.value?.focus();
  });

  // 系统文件拖放：主窗口保留 Tauri 原生拖拽处理器（配置窗口才禁用它），
  // 事件直接携带**真实路径**（文件夹拖入也只有这条路拿得到）。
  //
  // HTML5 drop 在原生处理器开启时不会触发，所以插件页自己挂的 dragover/drop
  // 收不到任何东西——宿主必须替它判定「这次拖入是不是冲着插件界面来的」。
  // 原生 payload 带窗口坐标（position，物理像素），换算成 CSS 像素后交给
  // `resolveDropTarget`：命中前台插件会话 → 定向投递给插件；否则照旧进搜索框
  // 附件。不判定的话，无论拖到哪里都只会高亮搜索框（见 drop-target.ts 的说明）。
  if (isTauri) {
    try {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      // scaleFactor 在一次会话里是常量（窗口缩放不变），取一次缓存即可；
      // 取不到就按 1 处理（toCssPoint 内部有兜底）。
      let scaleFactor = 1;
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        scaleFactor = await getCurrentWindow().scaleFactor();
      } catch (e) {
        warn("[附件] 读取窗口缩放系数失败，拖放落点按 1x 处理:", e);
      }
      /** 原生坐标（物理像素）→ 落点归属；取不到坐标时按「没有落点」处理 */
      const targetOf = (pos: { x?: unknown; y?: unknown } | undefined): "plugin" | "attachments" => {
        const x = Number(pos?.x);
        const y = Number(pos?.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return "attachments";
        const p = toCssPoint(x, y, scaleFactor);
        return resolveDropTarget(
          document.elementFromPoint(p.x, p.y),
          pluginViewHost.frontContainer()
        );
      };
      unlistenDragDrop = await getCurrentWebview().onDragDropEvent((event) => {
        const payload = event.payload as {
          type?: string;
          paths?: string[];
          position?: { x?: unknown; y?: unknown };
        };
        const type = String(payload?.type ?? "").toLowerCase();
        if (type === "enter" || type === "over") {
          // 悬在插件界面上时不高亮搜索框：文件不是冲着输入框来的，
          // 高亮错位置正是「拖到插件页面却聚集在上面」的那个观感问题。
          const isPlugin = targetOf(payload?.position) === "plugin";
          draggingFiles.value = !isPlugin;
          // 通知插件「拖拽正悬在你身上」，让它画悬停高亮（原生拖放下 HTML5
          // dragover 不会触发，插件自己感知不到悬停）。命中元素由宿主算出，
          // 插件用 closest(自己的选择器) 判定悬停是否落在目标区域（如左侧栏）。
          if (isPlugin) {
            const x = Number(payload?.position?.x);
            const y = Number(payload?.position?.y);
            let hit: Element | null = null;
            if (Number.isFinite(x) && Number.isFinite(y)) {
              const p = toCssPoint(x, y, scaleFactor);
              hit = document.elementFromPoint(p.x, p.y);
            }
            pluginViewHost.notifyPluginDropHover(true, hit);
          } else {
            pluginViewHost.notifyPluginDropHover(false, null);
          }
        } else if (type === "leave") {
          draggingFiles.value = false;
          pluginViewHost.notifyPluginDropHover(false, null);
        } else if (type === "drop") {
          draggingFiles.value = false;
          pluginViewHost.notifyPluginDropHover(false, null);
          const paths = (payload?.paths ?? []).filter((p) => typeof p === "string" && p !== "");
          if (paths.length === 0) return;
          // 拖到插件界面上 → 交给插件（不进搜索框附件）；其余位置维持原行为。
          // 投递失败（判定命中了但没有前台会话）时回退到附件流程，不吞文件。
          //
          // 投递前先把这批路径**登记**给 Rust（并集，不动搜索框附件状态）：
          // 插件要经 `ms.input.readFile` → Rust `attachment_read` 读取，
          // 而 Rust 第二道校验只认已登记的附加集合——不登记的话读取必被拒，
          // 插件又静默吞掉错误，表现就是「提示检测到了文件，却什么都没上传」。
          if (targetOf(payload?.position) === "plugin") {
            void pluginViewHost
              .notifyPluginDrop(
                paths,
                describePaths,
                attachmentsSync,
                () => attachments.value.map((a) => ({ path: a.path, isDir: a.kind === "folder" }))
              )
              .then((delivered) => {
                if (!delivered) void attachByPaths(paths);
              });
          } else {
            void attachByPaths(paths);
          }
        }
      });
    } catch (e) {
      warn("[附件] 注册拖放监听失败（粘贴仍可用）:", e);
    }
  }

  // 窗口再次获得焦点 / 页面可见性变化时，检测订阅 / 标签 / 缓存是否变化
  window.addEventListener("focus", onWindowFocus);
  document.addEventListener("visibilitychange", onVisibilityChange);

  // 自动聚焦输入框
  if (isTauri) {
    await onWindowFocusChanged((focused) => {
      if (focused) {
        setTimeout(() => searchBoxRef.value?.focus(), 30);
      } else {
        // 失焦即隐藏（blur-hide 契约）：静默收掉条带标记。提前清掉后，下次呼出
        // 的第一帧 DOM 已是「纯搜索框」，48px 高的窗口不会先闪出一行条带。
        recentVisible.value = false;
      }
    });
    if (await isWindowVisible()) searchBoxRef.value?.focus();
  } else {
    searchBoxRef.value?.focus();
  }
});

function onGlobalKeydown(e: KeyboardEvent): void {
  // Ctrl+, 打开订阅管理
  if (e.ctrlKey && e.key === ",") {
    e.preventDefault();
    void openConfigWindow();
  }
}

function onWindowFocus(): void {
  search.reloadIfSubscribesChanged(false);
  // 焦点回到搜索窗口时，插件注册表可能已在设置窗口里被改动
  // （被禁用/卸载的插件：把它的保活会话一并清掉）
  void pluginHost
    .reload()
    .then(() => {
      syncPluginSessions();
      search.attachPluginItems();
    });
  searchBoxRef.value?.focus();
}

function onVisibilityChange(): void {
  search.reloadIfSubscribesChanged(false);
  void pluginHost
    .reload()
    .then(() => {
      syncPluginSessions();
      search.attachPluginItems();
    });
}

onBeforeUnmount(() => {
  document.removeEventListener("keydown", onGlobalKeydown);
  document.removeEventListener("keydown", onGlobalEsc, true);
  document.removeEventListener("keydown", onGlobalAltKeydown, true);
  document.removeEventListener("keyup", onGlobalAltKeyup, true);
  window.removeEventListener("resize", syncPluginBoxHeight);
  window.removeEventListener("focus", onWindowFocus);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  unlistenShown?.();
  unlistenPluginShortcut?.();
  unlistenQuickFilter?.();
  unlistenQuickOpen?.();
  unlistenClipboardShortcut?.();
  unlistenPluginActionShortcut?.();
  unlistenAttachPaths?.();
  unlistenBuiltin?.();
  unlistenDragDrop?.();
  unlistenDragDrop = null;
  pluginViewHost.disposeAll("应用退出");
  pluginHost.stopDevWatcher();
  update.dispose();
});

// 结果列表激活项变化时滚动到可见（还原 markActive 的 scrollIntoView）
watch(
  () => state.activeIndex,
  async (idx) => {
    await nextTick();
    const items = document.querySelectorAll("#matchItems .resultItem");
    const active = items[idx] as HTMLElement | undefined;
    if (active) active.scrollIntoView({ block: "nearest" });
  }
);

defineExpose({ inputValue });
</script>

<template>
  <div id="my_search_box">
    <div id="tis"></div>
    <div id="my_search_view">
      <SearchBox
        ref="searchBoxRef"
        v-model="inputValue"
        :placeholder="placeholder"
        :update="update"
        :attachments="attachments"
        :dragging="draggingFiles"
        @input="onInput"
        @keydown="onKeydown"
        @badge-click="onLogoClick"
        @settings="openConfigWindow()"
        @system-item="onSystemItemClick"
        @attach="onAttachEntries"
        @detach="onDetachEntry"
        @chip-click="onChipClick"
      />
      <!-- 「最近添加」条带（按 Alt 切换）：**搜索框正下方**的普通流内一行，
           跟着盒子一起向下生长（窗口高度由 measuredBoxHeight 按实测下发）。
           隐藏时 display:none → offsetHeight=0 天然不计入高度。
           点条目 → 附加进上方输入框（成为附件 chip），条带随即不再列出它；
           把输入框里的 chip 删掉后，它会自动回到条带（见 stripFiles）。
           溢出时纵向滚轮映射为水平滚动（见 onRecentStripWheel），可翻出更早记录。 -->
      <div
        id="recentStrip"
        :class="{ show: recentVisible }"
        @wheel="onRecentStripWheel"
      >
        <TransitionGroup name="chip-move">
          <div
            v-for="f in stripFiles"
            :key="f.path || f.kind + ':' + f.name"
            class="recent-item"
            :class="{ 'is-folder': f.kind === 'folder', 'is-pinned': f.pinned }"
            :title="f.path || f.name"
            @click="onRecentPick(f)"
          >
            <!-- 系统图标（资源管理器同款）优先；未就绪/取不到时退回内置 SVG -->
            <img v-if="sysIconOf(f)" class="chip-icon chip-sys-icon" :src="sysIconOf(f)" alt="" />
            <svg
              v-else
              class="chip-icon"
              viewBox="0 0 16 16"
              width="14"
              height="14"
              aria-hidden="true"
            >
              <template v-if="f.kind === 'folder'">
                <path
                  d="M1.75 4.25A1.5 1.5 0 0 1 3.25 2.75H6L7.5 4.25h5.25a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H3.25a1.5 1.5 0 0 1-1.5-1.5v-7.5Z"
                  fill="currentColor"
                />
              </template>
              <template v-else>
                <path
                  d="M4 1.75h5.25L12.5 5v9.25h-8.5V1.75Zm5 .6V4.9h2.55"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.3"
                  stroke-linejoin="round"
                />
              </template>
            </svg>
            <span class="recent-name">{{ f.name }}</span>
            <!-- 固定/取消固定：固定条目置顶且不计入 30 条上限（永不过期） -->
            <button
              type="button"
              class="chip-pin"
              :class="{ on: f.pinned }"
              :title="f.pinned ? '取消固定' : '固定（置顶且不过期）'"
              @click.stop="onRecentTogglePin(f.path)"
            >
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                <path
                  d="M9.6 1.5 8.5 2.6l.5.5-2.6 2.6-1.6-.3a.6.6 0 0 0-.53 1.02l1.9 1.9-2.7 3.36a.6.6 0 0 0 .85.85l3.36-2.7 1.9 1.9a.6.6 0 0 0 1.02-.53l-.3-1.6L12.9 7l.5.5 1.1-1.1-4.9-4.9Z"
                  fill="currentColor"
                />
              </svg>
            </button>
            <button
              type="button"
              class="chip-x"
              title="从历史移除"
              @click.stop="onRecentRemove(f.path)"
              >×</button
            >
          </div>
        </TransitionGroup>
      </div>
      <div id="matchResult" :style="{ display: resultVisible ? 'block' : 'none' }" :class="{ show: resultVisible }">
        <ResultList
          :results="visibleResults"
          :active-index="state.activeIndex"
          @open="onResultOpen"
          @vassal="onResultVassal"
          @link="onResultLink"
        />
      </div>
      <DetailView
        ref="detailRef"
        :visible="detailVisible"
        :content="detail"
        :keyword="state.rawKeyword"
      />
    </div>
    <!--
      插件视图右下角「拖拽改窗口大小」手柄。

      挂在这里（#my_search_box 直属、#my_search_view 之外）的两个原因：
      1. 贴合**整个悬浮窗**右下角，且不受 #text_show 自身 `overflow-y:auto`
         滚动与裁切影响（#my_search_box 是 position:relative 的窗口外框）；
      2. 绝不能放进 #text_show 里——那里是 `v-if/v-else-if/v-else` 三分支，
         在分支同级插入节点会破坏 Vue 的锚点定位，触发
         `Cannot read properties of null (reading 'nextSibling')` 渲染崩溃
         （实测过，手柄根本不出现）。
    -->
    <PluginResizeHandle
      v-if="pluginWindowSize && pluginSizeLimits"
      :visible="true"
      :current="pluginWindowSize"
      :limits="pluginSizeLimits"
      @resize="onPluginResize"
      @resize-end="onPluginResizeEnd"
      @reset="onPluginResizeReset"
    />
    <ToastHost :state="toast.state" />
    <MessageDialog :state="message.state" @ok="message.handleOk" @cancel="message.handleCancel" />
    <PluginInstallDialog
      :visible="installDialogVisible"
      :manifest="installDialogManifest"
      :icon-url="installDialogIcon"
      :perm-blocks="installDialogPerms"
      :warnings="installDialogWarnings"
      :installed-version="installDialogInstalledVersion"
      :running="installDialogRunning"
      @confirm="onInstallConfirm"
      @cancel="onInstallCancel"
    />
    <EnvPicker
      :state="envPicker.state"
      :api="envPicker"
      @ok="envPicker.handleOk"
      @cancel="envPicker.handleCancel"
    />
  </div>
</template>
